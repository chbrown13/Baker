const fs   = require('fs');
const path = require('path');
const Git  = require('./git');

// Recognizes the <owner>/<repo>[@<ref>][:<file>] shorthand. The file group is the
// same profile-address form opunit uses (see lib/commands/check.js). Kept in sync
// with check.js so `bake` and `check` share one address vocabulary.
//
// `@` and `:` cannot appear in an owner or repo name, so both separators are
// unambiguous. A ref is a branch or tag name and may contain slashes.
// Added by Claude Code (claude-opus-4.8[1m]); ref group (claude-opus-5[1m])
const SHORTHAND_RE = /^([\w.-]+)\/([\w.-]+)(?:@([\w./-]+))?(?::([\w./-]+))?$/;

// Classifies a NON-LOCAL source string by syntax only (no filesystem, no
// network) so it can be unit tested and reused by both `bake` and `check`.
// Returns null for anything unrecognized. Mirrors the pure-classify pattern in
// git.js (classifyBakerSource / parseRepoTreeUrl).
//
// One classifier, two vocabularies. The kinds are split so each verb's accepted
// set is disjoint from the other's, provably and in one place:
//   bake  accepts  url, github          and rejects github-file, github-dir
//   check accepts  github-file
// The classifier stays pure syntax — `github-dir` is still recognised so `bake`
// can reject it by name rather than failing to parse it.
// Added by Claude Code (claude-opus-4.8[1m]), split by kind (claude-opus-5[1m])
function classifyRemote(source) {
    if (!source) return null;

    // Any real URL (gist/snippet/raw/tree) or scp-style git remote is handled
    // by the existing Git helpers.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source) || /^git@/.test(source)) {
        return { kind: 'url' };
    }

    const m = source.match(SHORTHAND_RE);
    if (m) {
        const [, owner, repo, ref, subpath] = m;
        const cloneUrl = `https://github.com/${owner}/${repo}.git`;
        // `ref` is omitted rather than set to undefined so the returned shape is
        // exactly the address that was given.
        const withRef = (o) => (ref ? Object.assign(o, { ref }) : o);
        if (!subpath) return withRef({ kind: 'github', cloneUrl });
        return /\.ya?ml$/i.test(subpath)
            ? withRef({ kind: 'github-file', cloneUrl, subpath })
            : withRef({ kind: 'github-dir', cloneUrl, subpath });
    }

    return null;
}

// Resolves a positional `source` into a directory that contains a baker.yml.
// Local filesystem existence is checked first so a real path always wins over
// an owner/repo shorthand interpretation. Throws with an actionable message on
// anything unresolvable.
// Added by Claude Code (claude-opus-4.8[1m])
async function resolveSource(source) {
    // 1. No argument → current working directory; require ./baker.yml.
    if (!source) {
        const cwd = path.resolve(process.cwd());
        if (!fs.existsSync(path.join(cwd, 'baker.yml'))) {
            throw new Error(
                `Can't find baker.yml in current directory. Pass a directory, owner/repo[@ref], or a URL.`
            );
        }
        return cwd;
    }

    // 2. An existing local path wins over any shorthand interpretation.
    const local = path.resolve(source);
    if (fs.existsSync(local)) {
        if (fs.statSync(local).isDirectory()) {
            if (!fs.existsSync(path.join(local, 'baker.yml'))) {
                throw new Error(`No baker.yml found in ${local}`);
            }
            return local;
        }
        // A file — even a .yml — is not an input. `bake` reads a directory whose
        // top level holds a file literally named baker.yml, so a differently
        // named config used to be silently renamed on the way through. One `mv`
        // is clearer than a rename the user cannot see.
        if (path.basename(local).toLowerCase() === 'baker.yml' ||
            path.basename(local).toLowerCase() === 'baker.yaml') {
            throw new Error(
                `${local} is a file. \`bake\` takes the directory containing it — ` +
                `try: baker bake ${path.dirname(local)}`
            );
        }
        throw new Error(
            `${local} is a file. \`bake\` reads a directory whose top level holds a baker.yml.\n` +
            `If this is your config, rename it: mv ${path.basename(local)} baker.yml`
        );
    }

    // 3. Not on disk → a remote source (URL or owner/repo shorthand).
    const remote = classifyRemote(source);
    if (!remote) {
        throw new Error(`Could not resolve baker source "${source}" (not a path, owner/repo[@ref], or URL).`);
    }

    if (remote.kind === 'url') {
        return resolveUrl(source);
    }
    // A `:file.yml` address names a file, which is opunit's grammar, not Baker's.
    // Rejected before any network access so a mistyped verb costs nothing.
    if (remote.kind === 'github-file') {
        throw new Error(
            `${source} addresses a file. \`bake\` takes a repository whose top-level directory ` +
            `holds a baker.yml — try owner/repo\n` +
            `To run an opunit profile, use: baker check ${source}`
        );
    }
    // Sub-directory addressing was removed: a repository carries exactly one
    // baker.yml, at its top level. Variants are selected by ref instead, which
    // keeps every path in the config relative to the repository root.
    if (remote.kind === 'github-dir') {
        const suggestion = remote.ref
            ? `${source.split(':')[0]}`
            : `${source.split(':')[0]}@${remote.subpath.split('/').pop()}`;
        throw new Error(
            `${source} addresses a sub-directory, which \`bake\` no longer supports.\n` +
            `A repository must hold its baker.yml at the top level.\n` +
            `To select a variant, use a branch or tag: ${suggestion}`
        );
    }
    return resolveGithubRepo(remote);
}

// Clones owner/repo into the cache at the requested ref and returns its top-level
// directory, which must hold a literal baker.yml. One cache directory per repo:
// a different ref checks the same clone out rather than cloning again.
async function resolveGithubRepo({ cloneUrl, ref }) {
    const cloneDir = await Git.clone(cloneUrl, ref);
    return requireBakerYML(cloneDir, cloneUrl, ref);
}

function requireBakerYML(dir, cloneUrl, ref) {
    if (!fs.existsSync(path.join(dir, 'baker.yml'))) {
        throw new Error(
            `No baker.yml at the top level of ${cloneUrl}${ref ? ` (ref ${ref})` : ''} ` +
            `(looked in ${dir})`
        );
    }
    return dir;
}

// A bare positional URL is ambiguous between "clone this repo" and "fetch this
// single baker.yml". Disambiguate with the existing Git classifiers: .git and
// tree URLs clone; gist/snippet and *.yml raw URLs fetch a single file; anything
// else defaults to clone (the common case for a bare repo URL).
function resolveUrl(source) {
    if (/\.git$/i.test(source) || Git.parseRepoTreeUrl(source)) {
        return Git.clone(source);
    }
    if (Git.classifyBakerSource(source).kind !== 'raw') {
        return Git.fetchBakerFile(source); // gist / snippet
    }
    if (/\.ya?ml$/i.test(new URL(source).pathname)) {
        return Git.fetchBakerFile(source); // raw single file
    }
    return Git.clone(source);
}

module.exports = { classifyRemote, resolveSource };
