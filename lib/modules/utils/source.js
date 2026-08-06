const fs   = require('fs');
const path = require('path');
const Git  = require('./git');

// Recognizes the <owner>/<repo>[:<file>] shorthand. The file group is the same
// profile-address form opunit uses (see lib/commands/check.js). Kept in sync
// with check.js so `bake` and `check` share one address vocabulary.
// Added by Claude Code (claude-opus-4.8[1m])
const SHORTHAND_RE = /^([\w.-]+)\/([\w.-]+)(?::([\w./-]+))?$/;

// Classifies a NON-LOCAL source string by syntax only (no filesystem, no
// network) so it can be unit tested and reused by both `bake` and `check`.
// Returns null for anything unrecognized. Mirrors the pure-classify pattern in
// git.js (classifyBakerSource / parseRepoTreeUrl).
//
// One classifier, two vocabularies. The kinds are split so each verb's accepted
// set is disjoint from the other's, provably and in one place:
//   bake  accepts  url, github, github-dir   and rejects github-file
//   check accepts  github-file
// The distinction is legible without knowing either tool: Baker's form ends in a
// directory, opunit's ends in .yml.
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
        const [, owner, repo, subpath] = m;
        const cloneUrl = `https://github.com/${owner}/${repo}.git`;
        if (!subpath) return { kind: 'github', cloneUrl };
        return /\.ya?ml$/i.test(subpath)
            ? { kind: 'github-file', cloneUrl, subpath }
            : { kind: 'github-dir', cloneUrl, subpath };
    }

    return null;
}

// Copies a non-baker-named .yml into the cache as baker.yml, so the rest of the
// pipeline (which reads path.join(bakePath, 'baker.yml')) is unchanged. A file
// already named baker.yml/.yaml just resolves to its own directory.
//
// No longer a documented input for `bake` — a local file is one `mv` away from
// being a baker.yml, and "whatever bake resolves, the file it reads is named
// baker.yml" is the rule that makes the address grammar predictable. Retained
// for internal callers. Stages into the cache, never cwd.
// Mirrors Git.fetchBakerFile's staging approach.
async function stageFileAsBakerYML(filePath) {
    const base = path.basename(filePath).toLowerCase();
    if (base === 'baker.yml' || base === 'baker.yaml') {
        return path.dirname(filePath);
    }

    const stageDir = Git.fetchCacheDir(path.resolve(filePath));
    await fs.promises.mkdir(stageDir, { recursive: true });
    await fs.promises.copyFile(filePath, path.join(stageDir, 'baker.yml'));
    return stageDir;
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
                `Can't find baker.yml in current directory. Pass a directory, owner/repo[:subdir], or a URL.`
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
        if (/\.ya?ml$/i.test(local)) {
            return stageFileAsBakerYML(local);
        }
        throw new Error(`${local} is not a .yml/.yaml baker file`);
    }

    // 3. Not on disk → a remote source (URL or owner/repo shorthand).
    const remote = classifyRemote(source);
    if (!remote) {
        throw new Error(`Could not resolve baker source "${source}" (not a path, owner/repo[:subdir], or URL).`);
    }

    if (remote.kind === 'url') {
        return resolveUrl(source);
    }
    // A `:file.yml` address names a file, which is opunit's grammar, not Baker's.
    // Rejected before any network access so a mistyped verb costs nothing.
    if (remote.kind === 'github-file') {
        throw new Error(
            `${source} addresses a file. \`bake\` takes a directory containing a baker.yml — ` +
            `try owner/repo:path/to/directory\n` +
            `To run an opunit profile, use: baker check ${source}`
        );
    }
    // github (repo root) and github-dir (owner/repo:subdir) both resolve to a
    // directory that must hold a literal baker.yml.
    return resolveGithubDir(remote);
}

// Clones owner/repo into the cache and returns the directory holding baker.yml —
// the repo root, or the named subdirectory. One repo can therefore carry many
// configs without either becoming clutter at its root.
async function resolveGithubDir({ cloneUrl, subpath }) {
    const cloneDir = await Git.clone(cloneUrl);
    if (!subpath) {
        return requireBakerYML(cloneDir, cloneUrl, subpath);
    }

    // The subpath comes from user input; keep it inside the clone.
    const dir = path.resolve(cloneDir, subpath);
    if (dir !== cloneDir && !dir.startsWith(cloneDir + path.sep)) {
        throw new Error(`Sub-directory "${subpath}" resolves outside ${cloneUrl}`);
    }
    if (!fs.existsSync(dir)) {
        throw new Error(`Sub-directory "${subpath}" does not exist in ${cloneUrl}`);
    }
    return requireBakerYML(dir, cloneUrl, subpath);
}

function requireBakerYML(dir, cloneUrl, subpath) {
    if (!fs.existsSync(path.join(dir, 'baker.yml'))) {
        throw new Error(
            `No baker.yml in ${subpath ? `"${subpath}" of ` : ''}${cloneUrl} (looked in ${dir})`
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
