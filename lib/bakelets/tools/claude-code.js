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
        // npm only, deliberately. The curl script is a bootstrapper: it
        // downloads a binary, runs `<binary> install` — which does the launcher
        // and shell integration — then deletes what it downloaded. The real
        // footprint is decided by that binary, not by the script, so it cannot
        // be derived by reading the installer (checked 2026-08-06). A config on
        // the curl path is told there is no inverse rather than guessed at.
        this.uninstallCommands = { npm: 'npm uninstall -g @anthropic-ai/claude-code' };
        this.defaultConfigDir = '~/.claude';
    }
}

module.exports = ClaudeCode;
