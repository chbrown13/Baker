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
        // npm only, deliberately: the curl installers place files wherever
        // their scripts decide, and an uninstall written from assumption
        // would delete the wrong paths. A config on the curl default is
        // told so rather than guessed at.
        this.uninstallCommands = { npm: 'npm uninstall -g opencode-ai' };
        this.defaultConfigDir = '~/.config/opencode';
    }
}

module.exports = Opencode;
