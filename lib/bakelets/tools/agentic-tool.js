const Bakelet = require('../bakelet');

// Shared base for agentic AI-tool bakelets (claude-code, opencode, ...).
// These are ordinary bakelets: they install via this.exec()/this.copy() and let
// resolve.js route the call to the right target (host for the local provider,
// container for docker-local, box for remote/VM). No provider special-casing.
//
// Subclasses set in their constructor:
//   this.toolKey         yaml key under tools: (e.g. 'claude-code')
//   this.binName         binary used for the idempotency check (e.g. 'claude')
//   this.defaultInstall  install method used when none is given (e.g. 'curl')
//   this.installCommands map of method -> shell command (NO single quotes; see below)
//   this.defaultConfigDir default clone dest for a config repo (e.g. '~/.claude')
//
// Shell-safety invariant: no value in installCommands (nor the clone/pull line)
// may contain a single quote, because docker-local wraps commands as
// `docker exec <c> /bin/bash -c '<cmd>'`. A single quote breaks that wrapping.
// Added by Claude Code (claude-opus-4.8[1m])
class AgenticTool extends Bakelet {
    constructor(name, ansibleSSHConfig, version) {
        super(ansibleSSHConfig);
        this.name = name;
        this.version = version;
    }

    async load(obj, variables) {
        // YAML entry is either "claude-code" (string) or { "claude-code": {...} }.
        const entry = (typeof obj === 'string' || obj === null) ? undefined : obj[this.toolKey];
        this.config = (entry && typeof entry === 'object') ? entry : {};
        this.variables = variables;
    }

    // These tools install on the host, so the host's shell decides what can run
    // — which means the platform must be resolved even though the install is
    // not package-manager-shaped.
    get needsPlatform() {
        return true;
    }

    // The curl installers are POSIX shell scripts piped into bash, which
    // PowerShell cannot run at all. On Windows the npm method is the only
    // workable default, so it is chosen rather than failing on `curl | bash`.
    // An explicit `install:` in baker.yml still wins, and still errors below if
    // the author picked something this tool does not offer.
    get resolvedInstallMethod() {
        if (this.config.install) return this.config.install;
        if (this.shell === 'powershell' && this.installCommands.npm) return 'npm';
        return this.defaultInstall;
    }

    async install() {
        // 1. Binary install — one idempotent line, routed to the target by
        //    this.exec. execIfAbsent skips when already present and needs no
        //    exit-code introspection (which differs across mode executors).
        const method = this.resolvedInstallMethod;
        const installCmd = this.installCommands[method];
        if (!installCmd) {
            throw new Error(
                `Unknown install method '${method}' for ${this.toolKey}. ` +
                `Use one of: ${Object.keys(this.installCommands).join(', ')}`
            );
        }
        await this.execIfAbsent(this.binName, installCmd);

        // 2. Optional config-repo clone-or-update: clone when absent, fast-forward
        //    pull when it is already our repo, skip (with a message) when the dir
        //    exists but is not a git repo (e.g. a tool-owned ~/.claude).
        if (this.config.repo) {
            const { url, dest } = this.parseRepo(this.config.repo);
            if (!url) {
                throw new Error(
                    `No repository URL in the repo config for ${this.toolKey}. ` +
                    `Use a "url" string or { repo: <url>, dest: <path> }.`
                );
            }
            await this.exec(this.repoSyncCommand(url, dest));
        }
    }

    // The binary and the config repo are separate plan entries, so a user can
    // drop the clone while keeping the tool, or the reverse.
    //
    // Both default to No. Baker genuinely cannot tell whether it installed a
    // tool — install() issues `command -v X || (install)`, which deliberately
    // avoids exit-code introspection — so the prompt says so rather than
    // pretending to knowledge it lacks.
    async plan() {
        const out = [];
        const method = this.resolvedInstallMethod;
        const command = (this.uninstallCommands || {})[method];

        // A probe, where the install location is known, gates the inverse on the
        // tool still being there — so a second cleanup reports it already gone
        // rather than claiming a removal it did not perform.
        const probe = (this.uninstallProbes || {})[method];
        const stillThere = command && probe
            ? (await this.filterExisting([probe])).length > 0
            : Boolean(command);

        if (command && stillThere) {
            out.push({
                kind: 'exec', bakelet: this.toolKey, default: false, command,
                prompt: `Remove ${this.binName}? Baker cannot tell whether it installed ` +
                    `this tool or it was already present.`,
                summary: `uninstall ${this.binName} (installed via ${method})`,
                // The install command IS the restore instruction, which beats a
                // generic "reinstall manually" in the cleanup log.
                restore: this.installCommands[method] || 'reinstall manually'
            });
        } else if (command) {
            out.push({
                kind: 'none', bakelet: this.toolKey,
                reason: `${probe} already gone`
            });
        } else {
            out.push({
                kind: 'none', bakelet: this.toolKey,
                reason: `no uninstall available for install method "${method}". ` +
                    `Authors: specify install: npm if you need cleanup to remove this tool.`
            });
        }

        if (this.config && this.config.repo) {
            const { url, dest } = this.parseRepo(this.config.repo);
            out.push(await this.planRepoRemoval(`${this.toolKey} config repo`, dest, url));
        }
        return out;
    }

    async uninstall(operation) {
        if (operation.kind === 'repo') {
            await this.removePath(operation.path);
            return;
        }
        await this.exec(operation.command);
    }

    // Clone-or-update, written for the target's shell. Still single-quote free
    // in both forms, so docker-local's `bash -c '<cmd>'` wrapping survives.
    repoSyncCommand(url, dest) {
        if (this.shell === 'powershell') {
            return `if (Test-Path "${dest}/.git") { git -C "${dest}" pull --ff-only } ` +
                `elseif (-not (Test-Path "${dest}")) { git clone "${url}" "${dest}" } ` +
                `else { Write-Output "${dest} exists and is not a git repo; skipping" }`;
        }
        return `if [ -d "${dest}/.git" ]; then git -C "${dest}" pull --ff-only; ` +
            `elif [ ! -e "${dest}" ]; then git clone "${url}" "${dest}"; ` +
            `else echo "${dest} exists and is not a git repo; skipping"; fi`;
    }

    // Parses the repo config into { url, dest }. Accepts a "url:dest" string
    // (splitting on the last ':' after any scheme, mirroring resources/git.js) or
    // an object { repo, dest }. Falls back to this.defaultConfigDir when no dest.
    parseRepo(repo) {
        if (typeof repo === 'string') {
            const proto = repo.indexOf('://');
            if (proto >= 0) {
                // Has a scheme: the last colon after it separates an optional dest.
                const afterProto = repo.slice(proto + 3);
                const colon = afterProto.lastIndexOf(':');
                if (colon >= 0) {
                    return { url: repo.slice(0, proto + 3 + colon), dest: afterProto.slice(colon + 1) };
                }
                return { url: repo, dest: this.defaultConfigDir };
            }
            // No scheme (e.g. scp-style git@host:org/repo): only split on the last
            // colon when the suffix looks like a path, so scp URLs stay intact.
            // Mirrors resources/git.js (plus '~' for our home-based config dirs).
            const colon = repo.lastIndexOf(':');
            if (colon >= 0) {
                const maybeDest = repo.slice(colon + 1);
                if (/^[/.~]/.test(maybeDest)) {
                    return { url: repo.slice(0, colon), dest: maybeDest };
                }
            }
            return { url: repo, dest: this.defaultConfigDir };
        }
        return { url: repo.repo, dest: repo.dest || this.defaultConfigDir };
    }
}

module.exports = AgenticTool;
