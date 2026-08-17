const PackageTool = require('./package-tool');

// git, installed with the target's package manager.
//
// Distinct from `resources: - git:`, which CLONES a repository. This installs
// the program that does the cloning. Until now nothing did: every config with a
// `resources: git:` entry, and every agentic tool that syncs a config repo,
// assumed git was already on the machine.
//
// Packaged as plain `git` by all seven managers, so there is no name divergence
// to justify a bakelet over a `packages:` entry. What justifies it is the macOS
// presence check below.
// Added by Claude Code (claude-opus-5[1m])
class Git extends PackageTool {
    constructor(name, ansibleSSHConfig, version) {
        super(name, ansibleSSHConfig, version);
        this.binName = 'git';
    }

    get commands() {
        return {
            apt: `${this.sudo}apt-get install -y git`,
            dnf: `${this.sudo}dnf install -y git`,
            pacman: `${this.sudo}pacman -S --noconfirm git`,
            zypper: `${this.sudo}zypper --non-interactive install git`,
            apk: `${this.sudo}apk add --no-cache git`,
            brew: 'brew install git',
            choco: 'choco install -y git'
        };
    }

    // macOS ships /usr/bin/git as a SHIM for the Xcode Command Line Tools. It is
    // on PATH on a machine that has never installed them, so the ordinary
    // `command -v git` check passes, the install is skipped, and the student is
    // left with a `git` that opens a GUI installer dialog the first time they
    // run it — exactly the half-configured machine resolveCommand() refuses to
    // create.
    //
    // `xcode-select -p` answers whether the tools are actually there without
    // triggering that dialog, which `git --version` would. A git that is not
    // /usr/bin/git came from Homebrew, MacPorts or nix and is real either way,
    // so the shim test is what the check hinges on.
    //
    // Same blind spot as `cpp`: this proves git works, not that it is recent
    // enough. Assert a version with `baker check`.
    presenceCheck(bin) {
        if (!this.platform || this.platform.os !== 'macos') {
            return super.presenceCheck(bin);
        }
        // No single quotes: docker-local wraps commands as `bash -c '<cmd>'`.
        return `command -v ${bin} >/dev/null 2>&1 && ` +
            `{ [ "$(command -v ${bin})" != /usr/bin/${bin} ] || xcode-select -p >/dev/null 2>&1; }`;
    }

    // Added by Claude Code (claude-opus-5[1m])
    get uninstallCommands() {
        return {
            apt: `${this.sudo}apt-get remove -y git`,
            dnf: `${this.sudo}dnf remove -y git`,
            pacman: `${this.sudo}pacman -Rns --noconfirm git`,
            zypper: `${this.sudo}zypper --non-interactive remove git`,
            apk: `${this.sudo}apk del git`,
            brew: 'brew uninstall git',
            choco: 'choco uninstall -y git'
        };
    }

    // Not refused the way `python` is — nothing here takes the OS package
    // manager with it — but it is the one tool cleanup itself uses, so the
    // prompt says so. REMOVE_ORDER puts `resources` ahead of `tools`, so clones
    // are already gone by the time this runs; the risk is to what a person
    // cloned themselves.
    get removalPrompt() {
        return `Remove git? Any repository on this machine stays on disk but ` +
            `becomes unusable, and \`baker cleanup\` needs git to check a clone ` +
            `for unpushed work before removing it.`;
    }
}

module.exports = Git;
