const PackageTool = require('./package-tool');

// opunit — the verifier `baker check` shells out to.
//
// No distribution packages it, so every manager gets the same npm line. The
// address is the GitHub shorthand npm accepts, matching what the docs tell
// people to run by hand.
//
// No sudo prefix, and requiresElevation stays false: npm's global prefix is
// per-user under nvm/fnm/volta and on Windows, which is the common case. Where
// the prefix IS root-owned the install fails with EACCES; the fix is a
// user-owned prefix rather than running npm under sudo, which leaves
// root-owned files in ~/.npm.
// Added by Claude Code (claude-opus-5[1m])
class Opunit extends PackageTool {
    constructor(name, ansibleSSHConfig, version) {
        super(name, ansibleSSHConfig, version);
        this.binName = 'opunit';
    }

    get requiresElevation() {
        return false;
    }

    get commands() {
        const npm = 'npm install -g ottomatica/opunit';
        return {
            apt: npm, dnf: npm, pacman: npm, zypper: npm, apk: npm, brew: npm, choco: npm
        };
    }

    // Installed from a GitHub shorthand, but the package it lands as is plain
    // `opunit`, which is what npm uninstall takes. Nothing but Baker depends on
    // it, so this is as safe an inverse as the tool tier has.
    // Added by Claude Code (claude-opus-5[1m])
    get uninstallCommands() {
        const npm = 'npm uninstall -g opunit';
        return {
            apt: npm, dnf: npm, pacman: npm, zypper: npm, apk: npm, brew: npm, choco: npm
        };
    }

    get removalPrompt() {
        return `Remove opunit? \`baker check\` shells out to it and will stop working.`;
    }
}

module.exports = Opunit;
