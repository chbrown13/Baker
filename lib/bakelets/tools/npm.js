const Bakelet = require('../bakelet');

// npm packages, installed globally.
//
//   tools:
//     - npm: typescript                      # shorthand, one package
//     - npm:
//         packages:
//           - typescript
//           - eslint
//
// The counterpart to `pip:`, and not a PackageTool for the same reason: npm is
// the same program on every target, so there is no per-manager table.
//
// It differs from pip in needing no per-OS branch either. pip declares
// needsPlatform because Windows has no `python3` on PATH; the npm binary is
// `npm` everywhere, Windows included, so this bakelet asks for no platform and
// builds one command for every target.
//
// No sudo prefix, and requiresElevation stays false — the same answer opunit
// and baker give, which install globally the same way. npm's global prefix is
// per-user under nvm, fnm and volta and on Windows, which is the common case.
// Where the prefix IS root-owned the install fails with EACCES; the fix is a
// user-owned prefix rather than running npm under sudo, which leaves root-owned
// files in ~/.npm.
//
// Ordering note for config authors: entries inside a category run top to
// bottom, so `- node` before `- npm:` in the same tools: list is what
// guarantees npm exists first.
// Added by Claude Code (claude-opus-5[1m])
class Npm extends Bakelet {
    constructor(name, ansibleSSHConfig, version) {
        super(ansibleSSHConfig);

        this.name = name;
        this.version = version;
        this.packages = [];
    }

    // A global install lands in npm's prefix, which is per-user in the common
    // case. Declared rather than inherited so the answer is stated where the
    // reasoning above is, not left to the base class default.
    get requiresElevation() {
        return false;
    }

    async load(obj, variables) {
        this.variables = variables;

        const entry = (typeof obj === 'string' || obj === null) ? undefined : obj.npm;
        if (typeof entry === 'string') {
            this.packages = [entry];
        } else if (Array.isArray(entry)) {
            this.packages = entry;
        } else if (entry && typeof entry === 'object' && Array.isArray(entry.packages)) {
            this.packages = entry.packages;
        }
    }

    installCommand() {
        return `npm install -g ${this.packages.join(' ')}`;
    }

    async install() {
        if (!this.packages.length) {
            throw new Error(
                'tools: npm needs at least one package, e.g.\n' +
                '  tools:\n' +
                '    - npm: typescript\n' +
                '  or\n' +
                '  tools:\n' +
                '    - npm:\n' +
                '        packages:\n' +
                '          - typescript\n' +
                '          - eslint'
            );
        }

        // No presence check, for pip's reason: npm install -g converges on an
        // already-installed package, and a package name is not a binary name in
        // general, so guessing one would be wrong as often as right.
        await this.exec(this.installCommand());
    }
}

module.exports = Npm;
