const Ssh  = require('../modules/ssh');
const fs   = require('fs-extra');
const os   = require('os');
const path = require('path');

class Bakelet
{
    constructor(ansibleSSHConfig)
    {
        this.ansibleSSHConfig = ansibleSSHConfig;
    }

    setRemotesPath(remotesPath)
    {
        this.remotesPath = remotesPath;
    }

    setBakePath(bakePath)
    {
        this.bakePath = bakePath;
    }

    setVerbose(verbose)
    {
        this.verbose = verbose;
    }

    setBakeletName(bakeletName)
    {
        this.bakeletName = bakeletName;
    }

    setBakeletPath(bakeletPath)
    {
        this.bakeletPath = bakeletPath;
    }

    setLocalLocation(localLocation)
    {
        this.localLocation = localLocation;
    }


    async copy(src,dest)
    {
        // Copy common ansible scripts files
        await Ssh.copyFromHostToVM(
            src,
            dest,
            this.ansibleSSHConfig,
            false
        );
    }

    async exec(cmd) {
        // Run cmd on remote server
        await Ssh.sshExec(cmd, this.ansibleSSHConfig, 20000, this.verbose);
    }

    // Like exec, but resolves with the command's stdout. resolve.js overrides
    // all three per transport; this default serves the control-VM path only.
    async execCapture(cmd) {
        return Ssh.sshExec(cmd, this.ansibleSSHConfig, 20000, this.verbose);
    }

    // ---- Cross-platform contract -------------------------------------------
    // Opt-in: a bakelet that overrides none of these behaves exactly as it did
    // before platform awareness existed, which is what lets the 12 conversions
    // land one at a time without touching the rest.
    // Added by Claude Code (claude-opus-5[1m])

    // Install command per package manager, e.g. {apt: '...', brew: '...'}.
    get commands() {
        return {};
    }

    // Whether this bakelet needs sudo (POSIX) or an elevated shell (Windows).
    // Read by the bake pre-flight gate before anything executes.
    get requiresElevation() {
        return false;
    }

    // Whether this bakelet provisions through an Ansible playbook, which pins it
    // to a Linux target: Ansible cannot act as a control node on Windows, and
    // every playbook in this repo uses the apt module.
    //
    // Declared explicitly rather than inferred, so `grep -rl requiresAnsible`
    // lists exactly what is left to convert. The pre-flight gate refuses these
    // on a non-Linux target before anything runs.
    get requiresAnsible() {
        return false;
    }

    // Whether resolve.js should detect the target platform for this bakelet.
    // Defaults to "yes if it declares commands"; bakelets that vary by platform
    // without using a package manager (env:) override this directly.
    get needsPlatform() {
        return Object.keys(this.commands).length > 0;
    }

    // The shell of the resolved platform, defaulting to POSIX. A directly
    // constructed bakelet (unit tests, or any caller that skips resolve.js) has
    // no platform, and POSIX is what every transport but native Windows uses.
    get shell() {
        return this.platform ? this.platform.shell : 'sh';
    }

    // Whether installing to a system path on this target needs elevation.
    // Windows always does (choco needs an admin shell); Homebrew never does;
    // Linux does unless we are already root, which is the container case.
    get systemInstallRequiresElevation() {
        if (!this.platform) return true;
        if (this.platform.os === 'windows') return true;
        if (this.platform.manager === 'brew') return false;
        return Boolean(this.platform.sudo);
    }

    // `sudo ` when the target needs it, empty otherwise. Root containers have
    // no sudo binary, and Homebrew refuses to run under it.
    get sudo() {
        return this.platform && this.platform.sudo ? 'sudo ' : '';
    }

    // The command for the detected manager. Throws rather than skipping: a
    // silent skip leaves a half-configured machine that only surfaces later,
    // when someone is trying to do their actual work.
    resolveCommand() {
        if (!this.platform) {
            throw new Error(
                `${this.bakeletName} needs the target platform to be detected before it can install. ` +
                `This is a bug in Baker: the bakelet declares commands but not needsPlatform.`
            );
        }
        const supported = Object.keys(this.commands);
        const cmd = this.commands[this.platform.manager];
        if (!cmd) {
            throw new Error(
                `${this.bakeletName} is not supported on ${this.platform.manager} ` +
                `(${this.platform.os}). Supported: ${supported.join(', ')}. ` +
                `Use docker: or remote: in your baker.yml to provision this on a supported target.`
            );
        }
        return cmd;
    }

    // Shell-appropriate test for whether a binary is already present. Kept out
    // of the command tables because presence varies by SHELL while installing
    // varies by MANAGER — two different axes, and folding them together would
    // make every table repeat the same check.
    presenceCheck(bin) {
        return this.shell === 'powershell'
            ? `Get-Command ${bin} -ErrorAction SilentlyContinue`
            : `command -v ${bin} >/dev/null 2>&1`;
    }

    // Idempotent install: run cmd only when bin is absent. PowerShell has no
    // `||`, so the two shells need genuinely different constructions rather
    // than a shared string with a substitution.
    async execIfAbsent(bin, cmd) {
        const guarded = this.shell === 'powershell'
            ? `if (-not (${this.presenceCheck(bin)})) { ${cmd} }`
            : `${this.presenceCheck(bin)} || (${cmd})`;
        return this.exec(guarded);
    }

    // ---- Removal seam (baker cleanup) --------------------------------------
    // Optional, with defaults that keep every existing bakelet working: a
    // bakelet that overrides neither reports "no inverse" and is never acted on.
    // Added by Claude Code (claude-opus-5[1m])

    // The side-effect-free half of load(). Cleanup calls this instead of load()
    // so a bakelet whose load() writes files cannot mutate anything during
    // planning. Bakelets whose load() is already pure need not override it.
    async prepare(obj, variables) {
        return this.load(obj, variables);
    }

    // What removing this bakelet would do. MUST be side-effect free: it may
    // read the filesystem and run read-only probes, but must not modify
    // anything. That invariant is what makes --dry-run and abort-safety true by
    // construction rather than by discipline.
    async plan() {
        return [{
            kind: 'none',
            bakelet: this.bakeletName,
            reason: `no inverse available for ${this.bakeletName}`
        }];
    }

    // Executes one approved plan entry. No-op unless a subclass overrides.
    async uninstall(operation) { // eslint-disable-line no-unused-vars
    }

    // Expands ~ against the host home. Only meaningful locally; other
    // transports let their own shell expand it.
    resolveLocalPath(p) {
        return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
    }

    async pathExists(target) {
        if (this.localLocation) {
            return fs.pathExists(this.resolveLocalPath(target));
        }
        try {
            await this.exec(`test -e "${target}"`);
            return true;
        } catch (err) {
            return false;
        }
    }

    // Shared guard for every cloned repository cleanup might remove, used by
    // both `resources: git:` and a `tools:` `repo:` key.
    //
    // The dirty-check OVERRIDES the user's answer, including under --all.
    // Someone who customised their agent config should not lose it to a
    // confirmation they misread, and a clone holding unpushed commits holds the
    // only copy of that work. Only a clean clone is offered, because only a
    // clean clone is recoverable from its remote.
    async planRepoRemoval(label, dest, url) {
        if (!dest) {
            return { kind: 'none', bakelet: label, reason: 'no clone destination in the config' };
        }
        if (!await this.pathExists(dest)) {
            return { kind: 'none', bakelet: label, reason: `${dest} already gone` };
        }
        if (!await this.pathExists(`${dest}/.git`)) {
            // Mirrors AgenticTool's install-side branch: if Baker declined to
            // create it because it was not a repo, Baker does not delete it.
            return {
                kind: 'refused', bakelet: label, path: dest,
                reason: `${dest} exists but is not a git repository`
            };
        }

        let dirty = '';
        let unpushed = '';
        try {
            dirty = String(await this.execCapture(`git -C "${dest}" status --porcelain`) || '').trim();
            unpushed = String(await this.execCapture(
                `git -C "${dest}" log --branches --not --remotes --oneline`) || '').trim();
        } catch (err) {
            // Fail closed: if the state cannot be read, it cannot be shown to be
            // safe to delete.
            return {
                kind: 'refused', bakelet: label, path: dest,
                reason: `could not determine repository state: ${err.message}`
            };
        }

        if (dirty || unpushed) {
            const why = [
                dirty && `${dirty.split('\n').length} uncommitted change(s)`,
                unpushed && `${unpushed.split('\n').length} unpushed commit(s)`
            ].filter(Boolean).join(', ');
            return { kind: 'refused', bakelet: label, path: dest, reason: why };
        }

        return {
            kind: 'repo', bakelet: label, path: dest, default: false,
            restore: url ? `git clone ${url} ${dest}` : `git clone <url> ${dest}`
        };
    }

    // Narrows a list of paths to those that actually exist.
    //
    // Removal is idempotent either way, but a plan that lists already-gone
    // paths reports "removed 4 items" on a second cleanup when it removed
    // nothing — so convergence has to be visible in the plan, not just true of
    // the operations. Batched into one command off-local so a large file set
    // costs one round trip rather than hundreds.
    async filterExisting(paths) {
        if (!paths.length) return [];
        if (this.localLocation) {
            const present = [];
            for (const target of paths) {
                if (await fs.pathExists(this.resolveLocalPath(target))) present.push(target);
            }
            return present;
        }

        const tests = paths.map((p) => `[ -e "${p}" ] && echo "${p}"`).join('; ');
        let out;
        try {
            out = String(await this.execCapture(`{ ${tests}; } 2>/dev/null || true`) || '');
        } catch (err) {
            // If existence cannot be determined, keep the full set: removal is
            // idempotent, so over-listing is safe where under-listing is not.
            return paths;
        }
        const present = new Set(out.split('\n').map((l) => l.trim()).filter(Boolean));
        return paths.filter((p) => present.has(p));
    }

    // Deletes a path through the active transport. Missing is not an error.
    async removePath(target) {
        if (this.localLocation) {
            await fs.remove(this.resolveLocalPath(target));
            return;
        }
        await this.exec(`rm -rf "${target}"`);
    }
}

module.exports = Bakelet;
