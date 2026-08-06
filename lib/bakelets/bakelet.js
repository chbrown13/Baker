const Ssh = require('../modules/ssh');

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
}

module.exports = Bakelet;
