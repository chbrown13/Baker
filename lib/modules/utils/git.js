const git  = require('simple-git');
const crypto = require('crypto');
const fs   = require('fs');
const https = require('https');
const os   = require('os');
const path = require('path');

class Git {
    constructor() {}

    // Root of Baker's source cache. Computed per call rather than at module load
    // so it follows $HOME — which keeps it isolatable in tests and correct if HOME
    // changes. Same base as global-vars.js `boxes` (~/.baker), one level down.
    // Nothing here is precious: `rm -rf ~/.baker/cache` is always safe.
    // Added by Claude Code (claude-opus-5[1m])
    static cacheRoot() {
        return path.join(os.homedir(), '.baker', 'cache');
    }

    static hashKey(value) {
        return crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 12);
    }

    // Strips characters that are illegal in Windows path segments, so a cache
    // path built from a URL is usable on every platform Baker ships to.
    static safeSegment(segment) {
        return segment.replace(/[<>:"|?*\x00-\x1f]/g, '_');
    }

    // Maps a clone URL to its cache directory. Pure — no filesystem, no network —
    // so it unit tests without either, mirroring parseRepoTreeUrl and
    // classifyBakerSource. The host is part of the key because github.com/acme/x
    // and gitlab.com/acme/x are different repos, and a collision here would
    // silently bake the wrong config.
    // Added by Claude Code (claude-opus-5[1m])
    static cacheDir(cloneURL) {
        let host, repoPath;
        try {
            const url = new URL(cloneURL);
            host = url.host || 'local';
            repoPath = url.pathname;
        } catch (err) {
            // scp-style remote: [user@]host:owner/repo.git
            const scp = String(cloneURL).match(/^(?:[^@/]+@)?([^:/]+):(.+)$/);
            if (!scp) {
                return path.join(Git.cacheRoot(), 'other', Git.hashKey(cloneURL));
            }
            host = scp[1];
            repoPath = scp[2];
        }

        // '.' and '..' are dropped rather than escaped: a cache path must never
        // climb out of the cache root, whatever the input looks like.
        const segments = repoPath.replace(/\.git$/i, '')
            .split('/')
            .filter((s) => s && s !== '.' && s !== '..')
            .map(Git.safeSegment);

        if (!segments.length) {
            return path.join(Git.cacheRoot(), Git.safeSegment(host), Git.hashKey(cloneURL));
        }
        return path.join(Git.cacheRoot(), Git.safeSegment(host), ...segments);
    }

    // Cache directory for a single fetched baker.yml. Keyed by a hash of the URL
    // so repeat fetches of one address reuse a directory instead of accumulating
    // random ones — which is what `tmp/baker-file-<random>` used to do, in cwd.
    // Added by Claude Code (claude-opus-5[1m])
    static fetchCacheDir(fileURL) {
        return path.join(Git.cacheRoot(), 'fetch', Git.hashKey(fileURL));
    }

    // Runs a git subcommand and resolves with its output. Uses simple-git's raw()
    // so the call shape does not depend on the wrapper's per-verb signatures.
    // simple-git 1.x hands the callback a plain string on failure, so normalize to
    // an Error — callers (and Print.error) read `.message`.
    static raw(cwd, args) {
        return new Promise((resolve, reject) => {
            git(cwd).silent(true).raw(args, (err, data) => {
                if (!err) return resolve(data);
                reject(err instanceof Error ? err : new Error(String(err).trim()));
            });
        });
    }

    // Clone-or-update against a Baker-owned cache directory. Mirrors the policy in
    // lib/bakelets/tools/agentic-tool.js — update when it is already our clone,
    // refuse when the path exists but is not one, otherwise clone.
    //
    // `reset --hard` rather than `pull --ff-only` because the cache is Baker's
    // scratch space: nobody commits into it, and a student who somehow dirtied it
    // should recover silently rather than hit a merge conflict mid-assignment.
    // AgenticTool keeps --ff-only because *that* clone is a config repo users edit.
    // Added by Claude Code (claude-opus-5[1m])
    static async cloneOrUpdate(cloneURL, dest, ref) {
        if (fs.existsSync(path.join(dest, '.git'))) {
            await Git.raw(dest, ['fetch', '--all', '--prune']);
            if (ref) await Git.raw(dest, ['checkout', ref]);

            // `@{u}` only exists when HEAD tracks a branch; a --branch clone of a
            // tag or sha is detached. Fall back to discarding local changes only.
            let upstream = null;
            try {
                upstream = (await Git.raw(dest, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])).trim();
            } catch (err) {
                upstream = null;
            }
            await Git.raw(dest, ['reset', '--hard', upstream || 'HEAD']);
            return dest;
        }

        if (fs.existsSync(dest)) {
            throw new Error(
                `${dest} already exists and is not a Baker cache clone. Remove it and retry: rm -rf "${dest}"`
            );
        }

        await fs.promises.mkdir(path.dirname(dest), { recursive: true });
        const options = ref ? ['--branch', ref] : [];
        await Git.raw(path.dirname(dest), ['clone', ...options, cloneURL, dest]);
        return dest;
    }

    // Clones a git repository into ~/.baker/cache and returns the path to it.
    // If the URL is a GitHub/GitLab "tree" URL, clones the whole repo and returns
    // the subdirectory holding baker.yml and its references.
    // Never writes to process.cwd(): students run Baker from inside repos they
    // care about, and a stray clone there is both litter and a second-run failure.
    // Modified by Claude Code (claude-opus-5[1m])
    static async clone(repoURL) {
        // A browser "tree" URL points at a directory inside a repo (e.g. https://github.com/owner/repo/tree/master/subdir).
        const tree = Git.parseRepoTreeUrl(repoURL);
        const cloneURL = tree ? tree.cloneUrl : repoURL;

        const dest = Git.cacheDir(cloneURL);
        await Git.cloneOrUpdate(cloneURL, dest, tree ? tree.ref : undefined);

        return tree && tree.subpath ? path.join(dest, tree.subpath) : dest;
    }

    // Parses a GitHub/GitLab "tree" (directory) browser URL into the pieces
    // needed to clone the repo and locate the subdirectory. Returns null for
    // anything that isn't a tree URL (plain clone URLs fall through unchanged).
    // Caveat: a branch name containing '/' (e.g. feature/x) cannot be split
    // from the subpath without an API call; only single-segment refs work.
    // Added by Claude Code v2.1.154 in VS Code (claude-opus-4.8[1m])
    static parseRepoTreeUrl(repoURL) {
        let url;
        try {
            url = new URL(repoURL);
        } catch (err) {
            return null; // ssh-style (git@host:...) or otherwise non-URL
        }

        // GitLab uses a '/-/tree/' delimiter, which cleanly separates the
        // (possibly nested-group) repo path from the ref + subpath.
        const gitlab = url.pathname.match(/^\/(.+?)\/-\/tree\/([^/]+)\/?(.*)$/);
        // GitHub repos are always owner/repo, followed by '/tree/'.
        const github = url.pathname.match(/^\/([^/]+\/[^/]+)\/tree\/([^/]+)\/?(.*)$/);

        const match = gitlab || github;
        if (!match) return null;

        const repoPath = match[1];
        const ref = match[2];
        const subpath = match[3] || '';
        return {
            cloneUrl: `${url.protocol}//${url.host}/${repoPath}.git`,
            ref,
            subpath
        };
    }

    // Classifies a single-file baker.yml source URL (gist, snippet, or raw file)
    // into how it should be fetched. Pure (no network) so it can be unit tested.
    // Host-derived rather than hardcoded, so enterprise/self-hosted instances
    // (github.ncsu.edu, gitlab.cs.vt.edu, ...) work the same as the cloud ones.
    // Added by Claude Code v2.1.154 in VS Code (claude-opus-4.8[1m])
    static classifyBakerSource(fileURL) {
        const url = new URL(fileURL);
        const isRaw = /\/raw(\/|$)/.test(url.pathname);

        // GitHub gist "pretty" page. On cloud the API lives on api.github.com;
        // on GitHub Enterprise it's <host>/api/v3 and gists sit under /gist/.
        if (!isRaw) {
            const cloudGist = url.hostname === 'gist.github.com'
                ? url.pathname.match(/\/([0-9a-fA-F]+)\/?$/)
                : null;
            const gheGist = url.pathname.startsWith('/gist/')
                ? url.pathname.match(/\/([0-9a-fA-F]+)\/?$/)
                : null;
            if (cloudGist) {
                return { kind: 'github-gist', apiUrl: `https://api.github.com/gists/${cloudGist[1]}` };
            }
            if (gheGist) {
                return { kind: 'github-gist', apiUrl: `${url.protocol}//${url.host}/api/v3/gists/${gheGist[1]}` };
            }

            // GitLab snippet "pretty" page (personal or project, cloud or
            // self-hosted). Appending /raw yields the content with no API call.
            // Caveat: for a multi-file snippet, /raw returns the primary file.
            if (url.pathname.includes('/-/snippets/')) {
                const base = `${url.protocol}//${url.host}${url.pathname.replace(/\/$/, '')}`;
                return { kind: 'gitlab-snippet', rawUrl: `${base}/raw` };
            }
        }

        // Already-raw content: gist raw host, raw.githubusercontent.com, a
        // GitLab /-/raw/ file, or any other URL fetched as-is.
        return { kind: 'raw', rawUrl: fileURL };
    }

    // Fetches a single baker.yml from a gist/snippet/raw URL on any host and
    // writes it into a temp directory, returning that directory (so callers can
    // read path.join(dir, 'baker.yml') exactly as for a local/cloned path).
    // Added by Claude Code v2.1.154 in VS Code (claude-opus-4.8[1m])
    static async fetchBakerFile(fileURL) {
        const source = Git.classifyBakerSource(fileURL);

        let content;
        if (source.kind === 'github-gist') {
            const gistData = await Git.fetchJson(source.apiUrl, {
                'User-Agent': 'baker',
                Accept: 'application/vnd.github.v3+json'
            });
            const files = gistData.files || {};
            const fileNames = Object.keys(files);
            if (!fileNames.length) {
                throw new Error(`No files found in gist ${fileURL}`);
            }
            const bakerFile = files['baker.yml'] || files['baker.yaml'] || files[fileNames[0]];
            if (!bakerFile || !bakerFile.content) {
                throw new Error(`Could not find baker.yml content in gist ${fileURL}`);
            }
            content = bakerFile.content;
        } else {
            content = await Git.fetchUrl(source.rawUrl, { 'User-Agent': 'baker' });
        }

        // Into the cache, not cwd. Deterministic per URL, so re-fetching the same
        // address reuses one directory rather than leaving a trail of random ones.
        const destDir = Git.fetchCacheDir(fileURL);
        await fs.promises.mkdir(destDir, { recursive: true });
        await fs.promises.writeFile(path.join(destDir, 'baker.yml'), content, 'utf8');
        return destDir;
    }

    static fetchUrl(uri, headers = {}) {
        return new Promise((resolve, reject) => {
            const request = https.get(uri, { headers }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    return resolve(Git.fetchUrl(res.headers.location, headers));
                }
                if (res.statusCode !== 200) {
                    return reject(new Error(`Failed to fetch ${uri}: HTTP ${res.statusCode}`));
                }

                let body = '';
                res.setEncoding('utf8');
                res.on('data', (chunk) => { body += chunk; });
                res.on('end', () => resolve(body));
            });
            request.on('error', reject);
        });
    }

    static async fetchJson(uri, headers = {}) {
        const body = await Git.fetchUrl(uri, headers);
        try {
            return JSON.parse(body);
        } catch (err) {
            throw new Error(`Failed to parse JSON from ${uri}: ${err.message}`);
        }
    }
}

module.exports = Git;
