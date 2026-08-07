const PackageTool = require('./package-tool');

// Node.js and npm, installed with the target's package manager.
//
// The sudo-free counterpart to `lang: nodejs`, which is playbook-backed and so
// needs Ansible, become: yes, and a Linux target. Both are kept: `lang: nodejs`
// still pins a major version through NodeSource, which a distro package cannot,
// and remote mode has the sudo to run it.
//
// Debian, RHEL, Arch, SUSE, and Alpine all package the runtime and npm
// separately; Homebrew and Chocolatey bundle them.
// Added by Claude Code (claude-opus-5[1m])
class Node extends PackageTool {
    constructor(name, ansibleSSHConfig, version) {
        super(name, ansibleSSHConfig, version);
        this.binName = 'node';
    }

    get commands() {
        return {
            apt: `${this.sudo}apt-get install -y nodejs npm`,
            dnf: `${this.sudo}dnf install -y nodejs npm`,
            pacman: `${this.sudo}pacman -S --noconfirm nodejs npm`,
            zypper: `${this.sudo}zypper --non-interactive install nodejs npm`,
            apk: `${this.sudo}apk add --no-cache nodejs npm`,
            brew: 'brew install node',
            choco: 'choco install -y nodejs'
        };
    }
}

module.exports = Node;
