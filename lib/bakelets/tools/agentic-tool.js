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

    async install() {
        // 1. Binary install — one idempotent shell line, routed to the target by
        //    this.exec. `command -v X || (install)` skips when already present and
        //    needs no exit-code introspection (which differs across mode executors).
        const method = this.config.install || this.defaultInstall;
        const installCmd = this.installCommands[method];
        if (!installCmd) {
            throw new Error(
                `Unknown install method '${method}' for ${this.toolKey}. ` +
                `Use one of: ${Object.keys(this.installCommands).join(', ')}`
            );
        }
        await this.exec(`command -v ${this.binName} >/dev/null 2>&1 || (${installCmd})`);

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
            await this.exec(
                `if [ -d "${dest}/.git" ]; then git -C "${dest}" pull --ff-only; ` +
                `elif [ ! -e "${dest}" ]; then git clone "${url}" "${dest}"; ` +
                `else echo "${dest} exists and is not a git repo; skipping"; fi`
            );
        }
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
