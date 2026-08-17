const fs   = require('fs-extra');
const path = require('path');

// What `init` looks for in the instructor's repo, and what it proposes when it
// finds it. Deliberately small and exact-path — no globs.
//
// Every entry maps to a `tools:` bakelet, never `lang:` or `services:`, and that
// is the whole point rather than a coincidence: EVERY bakelet in those two
// categories declares requiresAnsible, so proposing one would hand the
// instructor a config that fails on any student not running Linux with sudo.
// `tools: maven` is the portable counterpart to `lang: java`, and docs call
// `node` "the sudo-free counterpart to lang: nodejs".
//
// Consequence worth stating: detection NEVER proposes an Ansible-tier bakelet,
// so the warning and confirmation paths in init.js are reachable only by manual
// selection.
//
// Globs were considered and dropped 2026-08-10: *.ipynb, *.tex, test/opunit.yml
// and Gemfile are either obvious to the instructor or too ambiguous to infer —
// a .tex file under docs/ is not a LaTeX assignment. Gradle is left undetected
// because no Gradle bakelet exists, and mapping build.gradle to maven would be
// a guess dressed as a finding.
// Added by Claude Code (claude-opus-5[1m])
const SIGNALS = [
    { marker: 'pom.xml',      tools: ['maven'],       why: 'Maven project' },
    { marker: 'package.json', tools: ['node'],        why: 'Node project' },
    { marker: 'CLAUDE.md',    tools: ['claude-code'], why: 'Claude Code config' },
    { marker: '.claude',      tools: ['claude-code'], why: 'Claude Code config' }
];

// Pure: reads the repo, returns findings, decides nothing. The caller turns
// findings into pre-checked boxes, and the instructor is still the decision
// point — a wrong guess costs one keystroke and is visible before it ships.
//
// `fsAccess` is injected, defaulting to the real fs-extra, mirroring
// platform.detect() taking its exec function as an argument. That single seam is
// what makes every signal reachable in a unit test with no fixture repo on disk.
// Added by Claude Code (claude-opus-5[1m])
async function detect(dir, fsAccess = fs) {
    const hits = [];

    for (const signal of SIGNALS) {
        if (await fsAccess.pathExists(path.join(dir, signal.marker))) {
            hits.push(signal);
        }
    }

    return dedupeByTool(hits);
}

// CLAUDE.md and .claude both propose claude-code, and a repo commonly has both.
// Collapsing on the proposed tool rather than on the marker keeps "Detected:"
// from saying the same thing twice.
function dedupeByTool(hits) {
    const seen = new Set();
    const out = [];

    for (const hit of hits) {
        const key = hit.tools.join(',');
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(hit);
    }

    return out;
}

// Every tool proposed by a set of findings, flattened and de-duplicated — the
// pre-checked set for the tools prompt.
function proposedTools(findings) {
    return [...new Set(findings.reduce((all, f) => all.concat(f.tools), []))];
}

module.exports = { detect, proposedTools, SIGNALS };
