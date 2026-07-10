const AgenticTool = require('./agentic-tool');

// opencode CLI bakelet. Install commands are the current recommended paths;
// verified end-to-end by the live smoke, not by unit tests (which assert shape).
// Added by Claude Code (claude-opus-4.8[1m])
class Opencode extends AgenticTool {
    constructor(name, ansibleSSHConfig, version) {
        super(name, ansibleSSHConfig, version);
        this.toolKey = 'opencode';
        this.binName = 'opencode';
        this.defaultInstall = 'curl';
        this.installCommands = {
            curl: 'curl -fsSL https://opencode.ai/install | bash',
            npm: 'npm install -g opencode-ai',
        };
        this.defaultConfigDir = '~/.config/opencode';
    }
}

module.exports = Opencode;
