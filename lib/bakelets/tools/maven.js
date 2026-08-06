const PackageTool = require('./package-tool');

// Apache Maven. Packaged as "maven" by every manager Baker supports.
// Added by Claude Code (claude-opus-5[1m])
class Maven extends PackageTool {
    constructor(name, ansibleSSHConfig, version) {
        super(name, ansibleSSHConfig, version);
        this.binName = 'mvn';
    }

    get commands() {
        return {
            apt: `${this.sudo}apt-get install -y maven`,
            dnf: `${this.sudo}dnf install -y maven`,
            pacman: `${this.sudo}pacman -S --noconfirm maven`,
            zypper: `${this.sudo}zypper --non-interactive install maven`,
            apk: `${this.sudo}apk add --no-cache maven`,
            brew: 'brew install maven',
            choco: 'choco install -y maven'
        };
    }
}

module.exports = Maven;
