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
// Added by Claude Code (claude-opus-4.8[1m])
function classifyRemote(source) {
    if (!source) return null;

    // Any real URL (gist/snippet/raw/tree) or scp-style git remote is handled
    // by the existing Git helpers.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source) || /^git@/.test(source)) {
        return { kind: 'url' };
    }

    const m = source.match(SHORTHAND_RE);
    if (m) {
        const [, owner, repo, file] = m;
        const cloneUrl = `https://github.com/${owner}/${repo}.git`;
        return file
            ? { kind: 'github-file', cloneUrl, subpath: file }
            : { kind: 'github', cloneUrl };
    }

    return null;
}

// Copies a non-baker-named .yml into a temp dir as baker.yml, so the rest of
// the pipeline (which reads path.join(bakePath, 'baker.yml')) is unchanged.
// A file already named baker.yml/.yaml just resolves to its own directory.
// Mirrors Git.fetchBakerFile's staging approach.
async function stageFileAsBakerYML(filePath) {
    const base = path.basename(filePath).toLowerCase();
    if (base === 'baker.yml' || base === 'baker.yaml') {
        return path.dirname(filePath);
    }

    const tempDir = path.join(process.cwd(), `tmp/baker-file-${Math.random().toString(36).slice(2, 8)}`);
    await fs.promises.mkdir(tempDir, { recursive: true });
    await fs.promises.copyFile(filePath, path.join(tempDir, 'baker.yml'));
    return tempDir;
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
                `Can't find baker.yml in current directory. Pass a directory, a .yml file, owner/repo, or a URL.`
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
        throw new Error(`Could not resolve baker source "${source}" (not a path, .yml file, owner/repo, or URL).`);
    }

    if (remote.kind === 'url') {
        return resolveUrl(source);
    }
    if (remote.kind === 'github') {
        return Git.clone(remote.cloneUrl);
    }
    // github-file (owner/repo:file.yml): clone the repo and use the named
    // top-level file as its baker.yml. Sub-directory paths are not supported yet.
    return resolveGithubFile(remote);
}

// Clones owner/repo and promotes a named top-level .yml file to baker.yml so the
// rest of the repo (referenced playbooks/resources) still resolves alongside it.
async function resolveGithubFile({ cloneUrl, subpath }) {
    if (subpath.includes('/')) {
        throw new Error(
            `Sub-directory paths (owner/repo:sub/file.yml) are not supported yet — use a top-level file: owner/repo:file.yml.`
        );
    }
    if (!/\.ya?ml$/i.test(subpath)) {
        throw new Error(`owner/repo:${subpath} must reference a .yml/.yaml file.`);
    }

    const cloneDir = await Git.clone(cloneUrl);
    const filePath = path.join(cloneDir, subpath);
    if (!fs.existsSync(filePath)) {
        throw new Error(`${subpath} not found at the top level of ${cloneUrl}`);
    }

    if (path.basename(subpath).toLowerCase() !== 'baker.yml') {
        await fs.promises.copyFile(filePath, path.join(cloneDir, 'baker.yml'));
    }
    return cloneDir;
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
