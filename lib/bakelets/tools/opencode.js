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
        // Verified against the real installer (opencode.ai/install, read
        // 2026-08-06), not written from assumption: INSTALL_DIR is hardcoded
        // to $HOME/.opencode/bin with no flag to override it, and exactly one
        // binary is placed there.
        //
        // The installer also appends a PATH line to shell rc files behind a
        // `# opencode` comment. That is deliberately NOT removed: a stale PATH
        // entry pointing at a gone directory is harmless, whereas editing a
        // file the user owns is not, and the marker is the vendor's rather
        // than Baker's, so matching on it could hit the user's own comment.
        this.uninstallCommands = {
            npm: 'npm uninstall -g opencode-ai',
            curl: 'rm -f ~/.opencode/bin/opencode; rmdir ~/.opencode/bin 2>/dev/null; rmdir ~/.opencode 2>/dev/null; true'
        };
        // Gates the curl inverse on the binary still being there, so a second
        // cleanup reports it already gone instead of claiming a removal.
        this.uninstallProbes = { curl: '~/.opencode/bin/opencode' };
        this.defaultConfigDir = '~/.config/opencode';
    }
}

module.exports = Opencode;
