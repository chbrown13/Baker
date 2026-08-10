const Bakelet = require('../bakelet');

// Python packages from PyPI.
//
//   tools:
//     - pip: jsonschema                      # shorthand, one package
//     - pip:
//         packages:
//           - jsonschema
//           - pytest
//
// Not a PackageTool: pip is the same program on every target, so there is no
// per-manager table. What varies is the OS — Windows has no `python3` on PATH —
// which is why needsPlatform is declared directly, the way env: does.
//
// Installs with --user, so no elevation is needed anywhere and nothing lands in
// a system site-packages directory that a later OS upgrade would fight over.
//
// Ordering note for config authors: entries inside a category run top to
// bottom, so `- python` before `- pip:` in the same tools: list is what
// guarantees the interpreter exists first.
// Added by Claude Code (claude-opus-5[1m])
class Pip extends Bakelet {
    constructor(name, ansibleSSHConfig, version) {
        super(ansibleSSHConfig);

        this.name = name;
        this.version = version;
        this.packages = [];
    }

    // No command table, but the command still differs by OS.
    get needsPlatform() {
        return true;
    }

    // --user never needs root, including on Windows.
    get requiresElevation() {
        return false;
    }

    async load(obj, variables) {
        this.variables = variables;

        const entry = (typeof obj === 'string' || obj === null) ? undefined : obj.pip;
        if (typeof entry === 'string') {
            this.packages = [entry];
        } else if (Array.isArray(entry)) {
            this.packages = entry;
        } else if (entry && typeof entry === 'object' && Array.isArray(entry.packages)) {
            this.packages = entry.packages;
        }
    }

    // `python` on Windows, `python3` everywhere else — the same split python.js
    // makes for its presence check.
    get interpreter() {
        return this.platform && this.platform.os === 'windows' ? 'python' : 'python3';
    }

    // PEP 668 marks the interpreter "externally managed" on Debian 12+,
    // Ubuntu 23.04+, recent Fedora, and Homebrew Python, and pip then refuses
    // --user outright. --break-system-packages is the documented escape, but it
    // only exists on pip 23+, so it cannot simply always be passed. Try the
    // clean form, fall back to the escape — and note this is still a --user
    // install, so "system packages" here means the user's own site-packages.
    installCommand() {
        const names = this.packages.join(' ');
        const base = `${this.interpreter} -m pip install --user --quiet`;

        // PowerShell has no `||`, the same reason execIfAbsent builds two
        // genuinely different strings rather than substituting into one.
        return this.shell === 'powershell'
            ? `${base} ${names}; if ($LASTEXITCODE -ne 0) { ${base} --break-system-packages ${names} }`
            : `${base} ${names} || ${base} --break-system-packages ${names}`;
    }

    async install() {
        if (!this.packages.length) {
            throw new Error(
                'tools: pip needs at least one package, e.g.\n' +
                '  tools:\n' +
                '    - pip: jsonschema\n' +
                '  or\n' +
                '  tools:\n' +
                '    - pip:\n' +
                '        packages:\n' +
                '          - jsonschema\n' +
                '          - pytest'
            );
        }

        // pip is idempotent — an already-satisfied requirement is a no-op — so
        // there is no presence check to make. A package name is not an import
        // name in general, so guessing one would be wrong as often as right.
        await this.exec(this.installCommand());
    }
}

module.exports = Pip;
