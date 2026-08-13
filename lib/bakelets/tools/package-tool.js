const Bakelet = require('../bakelet');

// Shared base for tools that are "install one thing, idempotently".
//
// Subclasses supply `binName` (what proves it is already installed) and a
// `commands` table. Everything else — the presence check, the shell-appropriate
// guard, the elevation answer — comes from Bakelet. Mirrors AgenticTool, which
// does the same job for tools that also sync a config repo.
//
// A manager missing from a subclass's table is a deliberate statement that the
// tool does not work there: resolveCommand() then fails naming docker: and
// remote:, rather than inventing a package name that may not exist.
// Added by Claude Code (claude-opus-5[1m])
class PackageTool extends Bakelet {
    constructor(name, ansibleSSHConfig, version) {
        super(ansibleSSHConfig);

        this.name = name;
        this.version = version;
    }

    // Every package manager here installs to a system path except Homebrew,
    // which refuses to run under sudo at all.
    get requiresElevation() {
        return this.systemInstallRequiresElevation;
    }

    async load(obj, variables) {
        this.variables = variables;
    }

    async install() {
        await this.execIfAbsent(this.binName, this.resolveCommand());
    }

    // ---- Removal seam (baker cleanup) --------------------------------------
    //
    // Declared the same way installs are: one entry per manager. A subclass
    // that supplies nothing keeps Bakelet's "no inverse available", so adding
    // this base method changes no existing behaviour on its own.
    //
    // AgenticTool has had this since cleanup shipped (2026-08-06); the
    // exec-based tools landed a day later and never got it, which is why
    // `tools: opunit` reported no inverse despite `cleanup-command.md:118`
    // listing tools: as in scope.
    // Added by Claude Code (claude-opus-5[1m])
    get uninstallCommands() {
        return {};
    }

    // A subclass sets this when removing the package would break the machine
    // rather than merely inconvenience it. Refused entries are reported with a
    // reason and cannot be selected — not even by `cleanup --yes --all`.
    get refuseRemovalReason() {
        return null;
    }

    // Read-only. plan() must not modify anything, and `command -v` does not.
    async binPresent() {
        try {
            await this.execCapture(this.presenceCheck(this.binName));
            return true;
        } catch (err) {
            return false;
        }
    }

    async plan() {
        const label = this.bakeletName;

        if (this.refuseRemovalReason) {
            return [{ kind: 'refused', bakelet: label, reason: this.refuseRemovalReason }];
        }

        const commands = this.uninstallCommands;
        if (!commands || !Object.keys(commands).length) {
            return super.plan();
        }

        // Without a detected platform there is no manager to look the command
        // up under. resolve.js sets it for anything declaring commands, so this
        // only guards direct construction in tests.
        const manager = this.platform && this.platform.manager;
        const command = manager ? commands[manager] : null;
        if (!command) {
            return [{
                kind: 'none', bakelet: label,
                reason: manager
                    ? `no uninstall command for ${label} on ${manager}`
                    : `platform not detected; cannot choose an uninstall command for ${label}`
            }];
        }

        if (!(await this.binPresent())) {
            return [{ kind: 'none', bakelet: label, reason: `${this.binName} is not installed` }];
        }

        // default: false everywhere. install() is `command -v X || (install)`,
        // so Baker never learns whether it installed the tool or found it — the
        // same reason AgenticTool defaults its uninstall to No.
        return [{
            kind: 'exec', bakelet: label, default: false, command,
            prompt: this.removalPrompt,
            summary: `uninstall ${this.binName}`,
            restore: this.resolveCommandOrNull() || 'reinstall manually'
        }];
    }

    // Overridable so a subclass can name a consequence specific to it.
    get removalPrompt() {
        return `Remove ${this.binName}? Baker cannot tell whether it installed ` +
            `this tool or it was already present.`;
    }

    // resolveCommand() throws when the manager is unsupported; the restore hint
    // is a nicety and must not take the plan down with it.
    resolveCommandOrNull() {
        try {
            return this.resolveCommand();
        } catch (err) {
            return null;
        }
    }

    async uninstall(operation) {
        await this.exec(operation.command);
    }
}

module.exports = PackageTool;
