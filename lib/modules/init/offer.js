const fs   = require('fs');
const path = require('path');

const bakeletsDir = path.join(__dirname, '..', '..', 'bakelets');

// Not tools. `agentic-tool.js` and `package-tool.js` are the two base classes
// the real bakelets extend, so they are excluded structurally rather than by
// being listed as "not offerable" — a base class is not a thing an instructor
// can select.
// Added by Claude Code (claude-opus-5[1m])
const BASE_CLASSES = ['agentic-tool', 'package-tool'];

// Bakelets that cannot install without a value from the instructor, and the
// field each one needs. Selecting one triggers a follow-up prompt.
//
// This is per-bakelet knowledge living in `init`, which is exactly the coupling
// the generated list exists to avoid — so it is guarded: every offered bakelet
// must appear either here or in NO_ARG, and the guard test fails on a new
// bakelet that appears in neither. That is what stops an unclassified bakelet
// from reaching an instructor and failing at bake time on a student's machine.
//
// Each entry is a bakelet that THROWS without its field, verified at:
//   baker            lib/bakelets/tools/baker.js  (install: no source)
//   docker-extension lib/bakelets/tools/docker-extension.js:49
//   pip              lib/bakelets/tools/pip.js:80
//   npm              lib/bakelets/tools/npm.js:65
// Added by Claude Code (claude-opus-5[1m])
const NEEDS_ARG = {
    'baker':            { field: 'source',   hint: 'npm package or git shorthand, e.g. your-org/Baker' },
    'docker-extension': { field: 'address',  hint: 'e.g. dockersamples/labspace-extension' },
    'npm':              { field: 'packages', hint: 'comma separated, e.g. typescript, eslint' },
    'pip':              { field: 'packages', hint: 'comma separated, e.g. pytest, jsonschema' }
};

// Bakelets that install with no extra configuration. Listed explicitly rather
// than inferred as "everything not in NEEDS_ARG", so that adding a bakelet is a
// decision someone makes rather than a default someone inherits.
const NO_ARG = [
    'ansible', 'claude-code', 'cpp', 'dazed', 'defects4j', 'git', 'jekyll',
    'jupyter', 'latex', 'maven', 'node', 'opencode', 'opunit', 'python'
];

// Every bakelet name under lib/bakelets/tools/, minus the base classes.
// Read from disk at runtime, so a new bakelet appears in `init` with no edit
// here — which is what kept the old hardcoded list from rotting into java8 /
// nodejs9 / python2.
// Added by Claude Code (claude-opus-5[1m])
function toolBakeletNames() {
    return fs.readdirSync(path.join(bakeletsDir, 'tools'))
        .filter((f) => f.endsWith('.js'))
        .map((f) => f.replace(/\.js$/, ''))
        .filter((name) => !BASE_CLASSES.includes(name))
        .sort();
}

// Reads requiresAnsible off the class prototype rather than an instance.
// Every implementation is a constant getter with no `this`, and constructing a
// bakelet just to ask a static question would run its constructor for no reason.
// This is the same flag the bake pre-flight gate keys on, so `init` and the gate
// cannot disagree about which bakelets are Linux-only.
function requiresAnsible(name) {
    const Klass = require(path.join(bakeletsDir, 'tools', name));
    return Boolean(Klass.prototype.requiresAnsible);
}

// The tools list `init` presents, annotated for the chosen target.
//
// Ansible-tier entries are ANNOTATED, NOT HIDDEN. An instructor targeting their
// own Linux box over `remote:` can legitimately use jekyll, and hiding it would
// make `init` unable to author that config at all. When the pick conflicts with
// the target, init.js confirms rather than blocking.
// Added by Claude Code (claude-opus-5[1m])
function offerable(target) {
    return toolBakeletNames().map((name) => {
        const needsLinux = requiresAnsible(name);
        const arg = NEEDS_ARG[name] || null;

        return {
            name,
            needsArg: arg ? arg.field : null,
            argHint: arg ? arg.hint : null,
            needsLinux,
            // `remote:` is the one target an instructor controls the OS of.
            // local: and docker: both mean "whatever the student has".
            warning: needsLinux && target !== 'remote'
                ? 'Linux only, needs sudo — will fail for students on Windows or macOS'
                : null
        };
    });
}

// System package names whose apt spelling does not work on other managers. This
// is the likeliest way `init` ships an assignment that breaks for part of a
// class: an instructor on Ubuntu types what works on their laptop.
//
// Kept short on purpose. Growing it indefinitely recreates the rot problem the
// generated tool list exists to avoid, so it covers the common cases and defers
// to `tools:` for the rest — cpp, python and node exist precisely because those
// names differ per manager.
// Added by Claude Code (claude-opus-5[1m])
const DIVERGENT = {
    'build-essential': { dnf: 'gcc-c++ make', pacman: 'base-devel', brew: '(Xcode CLT)', suggest: 'tools: - cpp' },
    'python3-dev':     { dnf: 'python3-devel', pacman: 'python', brew: 'python', suggest: 'tools: - python' },
    'python3-pip':     { dnf: 'python3-pip', pacman: 'python-pip', brew: '(bundled)', suggest: 'tools: - python' },
    'nodejs':          { brew: 'node', choco: 'nodejs', suggest: 'tools: - node' },
    'default-jdk':     { dnf: 'java-latest-openjdk-devel', pacman: 'jdk-openjdk', brew: 'openjdk' },
    'libssl-dev':      { dnf: 'openssl-devel', pacman: 'openssl', brew: 'openssl' }
};

// Advice for one package name, or null when Baker has nothing to say about it.
// A `-dev` suffix is flagged even when the name is not in the table: it is a
// Debian convention (`-devel` on RPM distributions, no split package at all on
// Homebrew), so the suffix generalises where a name list cannot.
// Added by Claude Code (claude-opus-5[1m])
function divergentPackage(name) {
    const known = DIVERGENT[name];
    if (known) {
        const managers = Object.keys(known)
            .filter((k) => k !== 'suggest')
            .map((k) => `${k}: ${known[k]}`)
            .join(', ');
        return {
            name,
            detail: `'${name}' is a Debian/Ubuntu spelling. Elsewhere: ${managers}.`,
            suggest: known.suggest || null
        };
    }

    if (/-dev$/.test(name)) {
        return {
            name,
            detail: `'${name}' looks like a Debian '-dev' package. RPM distributions spell these ` +
                    `'-devel', and Homebrew usually has no separate package at all.`,
            suggest: null
        };
    }

    return null;
}

module.exports = {
    offerable, toolBakeletNames, divergentPackage,
    BASE_CLASSES, NEEDS_ARG, NO_ARG, DIVERGENT
};
