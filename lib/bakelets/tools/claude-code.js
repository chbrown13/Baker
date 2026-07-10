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
        this.defaultConfigDir = '~/.claude';
    }
}

module.exports = ClaudeCode;
