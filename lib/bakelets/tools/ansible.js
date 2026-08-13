const PackageTool = require('./package-tool');

// Ansible installed as a TOOL on the target — unrelated to Baker's own use of
// Ansible to provision. No choco entry: Ansible cannot act as a control node on
// Windows at all, so resolveCommand() fails there naming docker: and remote:,
// which is the honest answer rather than installing something that cannot run.
// Added by Claude Code (claude-opus-5[1m])
class Ansible extends PackageTool {
    constructor(name, ansibleSSHConfig, version) {
        super(name, ansibleSSHConfig, version);
        this.binName = 'ansible';
    }

    get commands() {
        return {
            apt: `${this.sudo}apt-get install -y ansible`,
            dnf: `${this.sudo}dnf install -y ansible`,
            pacman: `${this.sudo}pacman -S --noconfirm ansible`,
            zypper: `${this.sudo}zypper --non-interactive install ansible`,
            apk: `${this.sudo}apk add --no-cache ansible`,
            brew: 'brew install ansible'
        };
    }

    // Added by Claude Code (claude-opus-5[1m])
    get uninstallCommands() {
        return {
            apt: `${this.sudo}apt-get remove -y ansible`,
            dnf: `${this.sudo}dnf remove -y ansible`,
            pacman: `${this.sudo}pacman -Rns --noconfirm ansible`,
            zypper: `${this.sudo}zypper --non-interactive remove ansible`,
            apk: `${this.sudo}apk del ansible`,
            brew: 'brew uninstall ansible'
        };
    }

    get removalPrompt() {
        return `Remove ansible? Baker's lang:, services: and custom: bakelets ` +
            `need it; the exec-based tools: tier does not.`;
    }
}

module.exports = Ansible;
