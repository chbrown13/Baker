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
    //
    // `env` adds variables for this one invocation. It is MERGED over process.env,
    // never passed alone: simple-git hands _env straight to child_process.spawn
    // (src/git.js), and spawn's `env` option replaces the whole environment — so a
    // bare {GIT_TERMINAL_PROMPT:'0'} would strip PATH and HOME and git would not
    // run at all. Optional, so cloneOrUpdate and clone are untouched.
    // Modified by Claude Code (claude-opus-5[1m])
    static raw(cwd, args, env) {
        return new Promise((resolve, reject) => {
            let client = git(cwd).silent(true);
            if (env) client = client.env(Object.assign({}, process.env, env));
            client.raw(args, (err, data) => {
                if (!err) return resolve(data);
                reject(err instanceof Error ? err : new Error(String(err).trim()));
            });
        });
    }

    // Parses `git ls-remote --symref <url>` output. Pure — no filesystem, no
    // network — split from the network call for the same reason parseRepoTreeUrl
    // and classifyBakerSource are: the interesting logic unit tests without either.
    //
    // `head` is the symref line's target (refs/heads/<default branch>), which is
    // what removes the need to assume `master`. It is a ref NAME, not a sha.
    // Added by Claude Code (claude-opus-5[1m])
    // Lines are trimmed rather than matched against the raw split: git's output
    // reaches us through a pipe, and on Windows a CRLF line leaves a trailing \r
    // that `$` will not match past — which parsed every ref away silently and
    // produced "is it an empty repository?" for a perfectly healthy repo.
    static parseLsRemote(output) {
        const refs = new Map();
        let head = null;
        for (const raw of String(output).split('\n')) {
            const line = raw.trim();
            const symref = line.match(/^ref:\s+(\S+)\s+HEAD$/);
            if (symref) {
                head = symref[1];
                continue;
            }
            const m = line.match(/^([0-9a-f]{40})\s+(\S+)$/);
            if (m) refs.set(m[2], m[1]);
        }
        return { refs, head };
    }

    // Resolves a clone URL + optional ref to the commit sha to fetch content at.
    // One network call, which is what proves freshness — a sha-pinned raw URL
    // cannot serve stale content, so no cache header negotiation is needed.
    //
    // `ls-remote` over the GitHub API deliberately: it has no rate limit and needs
    // no auth, where the unauthenticated Contents API allows 60 requests/hour per
    // IP — which one lab section behind a single NAT exhausts in a minute. It also
    // reports the repository's real default branch in the same response.
    //
    // `raw` is injected, defaulting to the real one — the same seam as
    // platform.detect() taking its exec function as an argument. A test passes a
    // fake and mutates nothing shared, so it cannot leak into another suite.
    // Added by Claude Code (claude-opus-5[1m])
    static async resolveRef(cloneUrl, ref, raw = Git.raw) {
        // GIT_TERMINAL_PROMPT=0: a private or mistyped repo must fail fast.
        // Without it git prompts for credentials, and because opunit runs with
        // inherited stdio a whole cohort hangs on a prompt that does not look
        // like one. os.tmpdir() rather than cacheRoot(): ls-remote needs a cwd
        // that exists, and the cache may not on a first run.
        let out;
        try {
            out = await raw(os.tmpdir(), ['ls-remote', '--symref', cloneUrl], { GIT_TERMINAL_PROMPT: '0' });
        } catch (err) {
            // git's own message is kept below the summary, because it is what
            // separates a typo ("repository not found") from a dead network
            // ("could not resolve host"). Its credential-prompt wording is
            // opaque on its own, so a private-or-mistyped repo gets said plainly.
            throw new Error(
                `Could not read ${cloneUrl} — check the address, and that the repository is public.\n` +
                `${err.message}`
            );
        }
        const { refs, head } = Git.parseLsRemote(out);

        if (!ref) {
            const sha = refs.get('HEAD');
            if (!sha) {
                throw new Error(`${cloneUrl} has no HEAD — is it an empty repository?`);
            }
            return { sha, ref: head ? head.replace(/^refs\/heads\//, '') : 'HEAD' };
        }

        // Peeled annotated tag first: the bare refs/tags/<ref> of an annotated tag
        // is the TAG OBJECT's sha, which raw.githubusercontent cannot serve, so
        // preferring it would 404 on a correctly tagged repository.
        const sha = refs.get(`refs/tags/${ref}^{}`)
                 || refs.get(`refs/heads/${ref}`)
                 || refs.get(`refs/tags/${ref}`)
                 || (/^[0-9a-f]{40}$/.test(ref) ? ref : null);
        if (!sha) {
            throw new Error(`${cloneUrl} has no branch or tag "${ref}".`);
        }
        return { sha, ref };
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
    // `ref` is a branch or tag from the owner/repo@ref shorthand. One cache
    // directory per repository regardless of ref: cloneOrUpdate checks the
    // existing clone out rather than cloning the same repo once per variant.
    static async clone(repoURL, ref) {
        // A browser "tree" URL points at a directory inside a repo (e.g. https://github.com/owner/repo/tree/master/subdir).
        const tree = Git.parseRepoTreeUrl(repoURL);
        const cloneURL = tree ? tree.cloneUrl : repoURL;

        const dest = Git.cacheDir(cloneURL);
        await Git.cloneOrUpdate(cloneURL, dest, ref || (tree ? tree.ref : undefined));

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
    // `bake` reads a file named baker.yml. A raw URL carries its filename, so a
    // mismatch is caught before the fetch rather than silently renamed on the
    // way into the cache.
    static requireBakerFileName(fileURL) {
        let name;
        try {
            name = path.posix.basename(new URL(fileURL).pathname);
        } catch (err) {
            return; // not a parseable URL; leave it to the fetch to fail
        }
        const lower = name.toLowerCase();
        if (lower === 'baker.yml' || lower === 'baker.yaml') return;
        throw new Error(
            `${fileURL} does not name a baker.yml (found "${name}").\n` +
            `\`bake\` reads a file named baker.yml. Point at the raw URL of a baker.yml, ` +
            `or pass the repository instead: baker bake owner/repo`
        );
    }

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
    // `get` is threaded through to fetchJson/fetchUrl for the same reason it was
    // added there: the response handling is testable without a TLS server.
    // Modified by Claude Code (claude-opus-5[1m])
    static async fetchBakerFile(fileURL, get = https.get) {
        const source = Git.classifyBakerSource(fileURL);

        let content;
        if (source.kind === 'github-gist') {
            const gistData = await Git.fetchJson(source.apiUrl, {
                'User-Agent': 'baker',
                Accept: 'application/vnd.github.v3+json'
            }, get);
            const files = gistData.files || {};
            const fileNames = Object.keys(files);
            if (!fileNames.length) {
                throw new Error(`No files found in gist ${fileURL}`);
            }
            // No first-file fallback: `bake` reads a file named baker.yml, and
            // silently taking whatever happened to be first in a multi-file gist
            // is exactly the kind of invisible substitution that rule exists to
            // prevent.
            const bakerFile = files['baker.yml'] || files['baker.yaml'];
            if (!bakerFile || !bakerFile.content) {
                throw new Error(
                    `No baker.yml in gist ${fileURL} (found: ${fileNames.join(', ')}). ` +
                    `\`bake\` reads a file named baker.yml.`
                );
            }
            content = bakerFile.content;
        } else {
            // A raw URL names its file, so the name is checkable. A GitLab
            // snippet does not — /raw returns the primary file with no name in
            // the URL — so it is fetched as-is and is the one input form where
            // the baker.yml rule cannot be enforced.
            if (source.kind === 'raw') Git.requireBakerFileName(fileURL);
            content = await Git.fetchUrl(source.rawUrl, { 'User-Agent': 'baker' }, get);
        }

        // Into the cache, not cwd. Deterministic per URL, so re-fetching the same
        // address reuses one directory rather than leaving a trail of random ones.
        const destDir = Git.fetchCacheDir(fileURL);
        await fs.promises.mkdir(destDir, { recursive: true });
        await fs.promises.writeFile(path.join(destDir, 'baker.yml'), content, 'utf8');
        return destDir;
    }

    // `get` is injected, defaulting to the real https.get — the same seam as
    // Git.resolveRef's `raw`, so the response handling is testable without a
    // network or a TLS server.
    // Modified by Claude Code (claude-opus-5[1m])
    static fetchUrl(uri, headers = {}, get = https.get) {
        return new Promise((resolve, reject) => {
            const request = get(uri, { headers }, (res) => {
                // Every path that does not read the body must destroy the
                // response. An unread body leaves the socket active, and the
                // process then never exits: `baker check owner/repo:typo.yml`
                // printed its 404 in ~130ms and hung the terminal indefinitely.
                // A wrong filename is an ordinary, expected error here, so this
                // path is walked routinely rather than never.
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    res.destroy();
                    return resolve(Git.fetchUrl(res.headers.location, headers, get));
                }
                if (res.statusCode !== 200) {
                    res.destroy();
                    return reject(new Error(`Failed to fetch ${uri}: HTTP ${res.statusCode}`));
                }

                let body = '';
                res.setEncoding('utf8');
                res.on('data', (chunk) => { body += chunk; });
                res.on('end', () => resolve(body));
                res.on('error', reject);
            });
            request.on('error', reject);
        });
    }

    static async fetchJson(uri, headers = {}, get = https.get) {
        const body = await Git.fetchUrl(uri, headers, get);
        try {
            return JSON.parse(body);
        } catch (err) {
            throw new Error(`Failed to parse JSON from ${uri}: ${err.message}`);
        }
    }
}

module.exports = Git;
