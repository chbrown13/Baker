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
}

module.exports = PackageTool;
