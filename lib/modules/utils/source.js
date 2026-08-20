const fs    = require('fs');
const path  = require('path');
const yaml  = require('js-yaml');
const Git   = require('./git');
const Utils = require('./utils');
const Print = require('../print');

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

// Clones owner/repo into the cache at the requested ref, then materializes the
// working copy the bake actually runs against. The cache is still what the
// config is READ from, because where the checkout belongs is a question only
// the config can answer.
async function resolveGithubRepo({ cloneUrl, ref }) {
    const cloneDir = await Git.clone(cloneUrl, ref);
    requireBakerYML(cloneDir, cloneUrl, ref);
    return materialize(cloneDir, cloneUrl, '');
}

// Where a cloned repository belongs on this machine.
//
// `local: <path>` names the environment root, so the checkout goes INSIDE it —
// `local: ./work` with repo `agent-template` gives ./work/agent-template. Every
// other provider describes a container or a server and names no host directory
// at all, so the checkout lands next to wherever the person is standing.
//
// Always a named sub-directory, never the parent itself: that is what plain
// `git clone <url>` does, and it means Baker cannot unpack a repository on top
// of files that are already sitting there.
// Added by Claude Code (claude-opus-5[1m])
function checkoutParent(doc) {
    return typeof doc.local === 'string'
        ? path.resolve(Utils.expandTilde(doc.local))
        : path.resolve(process.cwd());
}

// Places the working copy and reports what happened to it. `cacheDir` is the
// repository root in the cache — the whole repo is what gets copied — and
// `subpath` is the offset within it that the caller actually addressed.
// Added by Claude Code (claude-opus-5[1m])
async function materialize(cacheDir, cloneUrl, subpath) {
    const docDir = subpath ? path.join(cacheDir, subpath) : cacheDir;
    const name = Git.repoName(cloneUrl);
    // An unparseable remote has no obvious directory name to use, and inventing
    // a hashed one would be worse than the cache path it already has.
    if (!name) return docDir;

    let doc;
    try {
        doc = yaml.safeLoad(fs.readFileSync(path.join(docDir, 'baker.yml'), 'utf8')) || {};
    } catch (err) {
        doc = {};
    }

    const parent = checkoutParent(doc);
    const dest = path.join(parent, name);

    fs.mkdirSync(parent, { recursive: true });
    const result = await Git.workingCopy(cacheDir, cloneUrl, dest);
    reportWorkingCopy(result, dest);

    // A tree URL addresses a sub-directory of the repo; the checkout is still
    // the whole repository, so re-apply the offset the caller asked for.
    return subpath ? path.join(dest, subpath) : dest;
}

// One line per outcome. The skips are warnings rather than errors on purpose:
// the bake continues, and the person is told why their repo did not move.
function reportWorkingCopy(result, dest) {
    switch (result.kind) {
        case 'cloned':
            Print.success(`Cloned into ${dest}`);
            break;
        case 'updated':
            Print.info(`Updated ${dest}`);
            break;
        case 'dirty':
            Print.warning(
                `${dest} has uncommitted changes — leaving it alone.\n` +
                `Commit or stash them and re-run to pick up the latest version.`
            );
            break;
        case 'diverged':
            Print.warning(
                `${dest} has commits the remote does not — leaving it alone.\n` +
                `Push or rebase them and re-run to pick up the latest version.`
            );
            break;
        case 'detached':
            Print.warning(
                `${dest} is not on a branch (checked out at a tag or commit) — ` +
                `leaving it alone.`
            );
            break;
    }
}

// Clone-shaped URL of any form: bare repo URL, .git URL, scp-style remote, or a
// browser tree URL pointing into a sub-directory. Exported as resolveRepoFlag
// for `--repo`, which names a repository directly rather than through the
// positional grammar, so both share one destination rule.
// Added by Claude Code (claude-opus-5[1m])
async function cloneAndMaterialize(source) {
    const tree = Git.parseRepoTreeUrl(source);
    const cloneUrl = tree ? tree.cloneUrl : source;
    const subpath = (tree && tree.subpath) || '';

    // Git.clone returns the addressed directory, which for a tree URL is
    // <cacheRoot>/<subpath>. Walk back up by as many segments as the subpath has
    // rather than recomputing cacheDir() from the URL: the returned path is the
    // one that actually exists, and the two must not be able to disagree.
    const docDir = await Git.clone(source);
    const cacheRoot = subpath
        ? path.resolve(docDir, ...subpath.split('/').filter(Boolean).map(() => '..'))
        : docDir;

    return materialize(cacheRoot, cloneUrl, subpath);
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
        return cloneAndMaterialize(source);
    }
    if (Git.classifyBakerSource(source).kind !== 'raw') {
        return Git.fetchBakerFile(source); // gist / snippet
    }
    if (/\.ya?ml$/i.test(new URL(source).pathname)) {
        return Git.fetchBakerFile(source); // raw single file
    }
    return cloneAndMaterialize(source);
}

module.exports = { classifyRemote, resolveSource, resolveRepoFlag: cloneAndMaterialize };
