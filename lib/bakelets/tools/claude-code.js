const AgenticTool = require('./agentic-tool');

// Claude Code CLI bakelet. Install commands are the current recommended paths;
// verified end-to-end by the live smoke, not by unit tests (which assert shape).
// Added by Claude Code (claude-opus-4.8[1m])
class ClaudeCode extends AgenticTool {
    constructor(name, ansibleSSHConfig, version) {
        super(name, ansibleSSHConfig, version);
        this.toolKey = 'claude-code';
        this.binName = 'claude';
        this.defaultInstall = 'curl';
        this.installCommands = {
            curl: 'curl -fsSL https://claude.ai/install.sh | bash',
            npm: 'npm install -g @anthropic-ai/claude-code',
        };
        // npm only, deliberately: the curl installers place files wherever
        // their scripts decide, and an uninstall written from assumption
        // would delete the wrong paths. A config on the curl default is
        // told so rather than guessed at.
        this.uninstallCommands = { npm: 'npm uninstall -g @anthropic-ai/claude-code' };
        this.defaultConfigDir = '~/.claude';
    }
}

module.exports = ClaudeCode;
