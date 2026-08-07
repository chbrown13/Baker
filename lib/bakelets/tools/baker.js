const PackageTool = require('./package-tool');

// Baker itself, for bringing a cohort to a known version.
//
// This bakelet takes a REQUIRED `source:` and has no default, because there is
// no safe one. `baker` on the public npm registry is an unrelated package, so
// defaulting to it would install someone else's software; and hardcoding a
// particular fork's address would put one person's account in shipped source.
// The author names where their Baker lives:
//
//   tools:
//     - baker:
//         source: your-org/Baker        # npm package, or a git shorthand
//
// Note this cannot bootstrap Baker — a machine running `baker bake` already has
// it. Its job is version alignment across a cohort. First-time installation is
// a documented one-liner, not a bakelet.
// Added by Claude Code (claude-opus-5[1m])
class Baker extends PackageTool {
    constructor(name, ansibleSSHConfig, version) {
        super(name, ansibleSSHConfig, version);
        this.binName = 'baker';
    }

    async load(obj, variables) {
        // Accepts { baker: { source: '...' } } or the shorthand { baker: '...' }.
        const entry = (typeof obj === 'string' || obj === null) ? undefined : obj.baker;
        if (typeof entry === 'string') {
            this.source = entry;
        } else if (entry && typeof entry === 'object') {
            this.source = entry.source;
        }
        this.variables = variables;
    }

    // Same reasoning as opunit: npm's global prefix is per-user in the common
    // case, and sudo npm leaves root-owned files behind.
    get requiresElevation() {
        return false;
    }

    // Must stay safe to read on a bare instance: the command-table invariants
    // are checked by constructing every bakelet and reading `commands`, so this
    // returns an empty table rather than throwing when no source is set. The
    // actionable error belongs in install(), which is where it can be acted on.
    get commands() {
        if (!this.source) return {};
        const npm = `npm install -g ${this.source}`;
        return {
            apt: npm, dnf: npm, pacman: npm, zypper: npm, apk: npm, brew: npm, choco: npm
        };
    }

    async install() {
        if (!this.source) {
            throw new Error(
                'tools: baker needs a source. There is no default: the name "baker" on the ' +
                'public npm registry is an unrelated package. Give the npm package or git ' +
                'shorthand your Baker is published at, e.g.\n' +
                '  tools:\n' +
                '    - baker:\n' +
                '        source: your-org/Baker'
            );
        }
        return super.install();
    }
}

module.exports = Baker;
