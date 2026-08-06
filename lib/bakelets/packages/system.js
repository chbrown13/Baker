const Bakelet = require('../bakelet');

// System packages, installed with whatever package manager the target has.
//
// Replaces the old `packages: - apt:` key, which named a package manager in the
// schema and so could only ever work on Debian. The section now takes a bare
// list of names, with a per-manager map for the cases where a name genuinely
// differs (Debian's fd-find is fd on Fedora, Arch, and Homebrew).
//
// Unlike lang: or services:, the names here come from the CONFIG AUTHOR rather
// than from Baker, so Baker cannot translate them. Passing an unknown name
// through to the manager and reporting the failure clearly is the honest
// behaviour; guessing would install the wrong package.
// Added by Claude Code (claude-opus-5[1m])
class System extends Bakelet {
    constructor(name, ansibleSSHConfig, version) {
        super(ansibleSSHConfig);

        this.name = name;
        this.version = version;
        this.entries = [];
    }

    // The install verb per manager; package names are appended by install().
    get commands() {
        return {
            apt: `${this.sudo}apt-get install -y`,
            dnf: `${this.sudo}dnf install -y`,
            pacman: `${this.sudo}pacman -S --noconfirm`,
            zypper: `${this.sudo}zypper --non-interactive install`,
            apk: `${this.sudo}apk add --no-cache`,
            // Never sudo: Homebrew refuses to run as root and its own error is
            // not something a cohort member can act on.
            brew: 'brew install',
            // Needs an already-elevated shell; it cannot escalate itself, which
            // is why the bake pre-flight gate has to check before anything runs.
            choco: 'choco install -y'
        };
    }

    // Every manager here installs to a system path.
    get requiresElevation() {
        return this.systemInstallRequiresElevation;
    }

    async load(obj, variables) {
        this.variables = variables;
        // The resolver hands this bakelet the whole packages: list, because its
        // entries are data rather than bakelet names.
        this.entries = Array.isArray(obj) ? obj : [];
        this.entries.forEach((entry) => System.rejectLegacyKey(entry));
    }

    // `packages: - apt: [...]` named the package manager in the schema. It is
    // removed rather than aliased, so it fails loudly with the new form instead
    // of silently doing something different on a non-Debian machine.
    static rejectLegacyKey(entry) {
        if (typeof entry === 'string' || entry === null) return;
        if (entry && typeof entry === 'object' && !('name' in entry)) {
            const keys = Object.keys(entry).join(', ');
            throw new Error(
                `packages: - ${keys}: is no longer supported — the key named a package manager, ` +
                `so it could only work on one kind of machine.\n\n` +
                `  List names directly instead:\n` +
                `      packages:\n        - jq\n        - tmux\n\n` +
                `  and give per-manager names only where they differ:\n` +
                `      packages:\n        - name: fd\n          apt: fd-find\n          brew: fd`
            );
        }
    }

    // Resolves each entry to the package name for the detected manager.
    resolveNames() {
        return this.entries.map((entry) => {
            if (typeof entry === 'string') return entry;

            const managers = Object.keys(entry).filter((k) => k !== 'name');
            const override = entry[this.platform.manager];
            if (override) return override;
            // No overrides at all means the author is saying the name is the
            // same everywhere, which is the common case.
            if (!managers.length) return entry.name;

            // Overrides exist but not for this manager. Falling back to `name`
            // would install whatever that happens to match, which is how you
            // end up with the wrong package rather than an error.
            throw new Error(
                `packages: "${entry.name}" has per-manager names for ${managers.join(', ')} ` +
                `but not for ${this.platform.manager}. Add one, or remove the overrides to use ` +
                `"${entry.name}" on every manager.`
            );
        });
    }

    async install() {
        if (!this.entries.length) return;
        const names = this.resolveNames();
        await this.exec(`${this.resolveCommand()} ${names.join(' ')}`);
    }
}

module.exports = System;
