const git  = require('simple-git');
const fs   = require('fs');
const https = require('https');
const path = require('path');

class Git {
    constructor() {}

    // Clones a git repository to a temporary directory and returns the path to that directory. 
    // If the URL is a GitHub/GitLab "tree" URL, clones the whole repo and returns the subdirectory with baker.yml and references.
    // Modified by Claude Code v2.1.154 in VS Code (claude-opus-4.8[1m])
    static async clone(repoURL) {
        // A browser "tree" URL points at a directory inside a repo (e.g. https://github.com/owner/repo/tree/master/subdir). 
        const tree = Git.parseRepoTreeUrl(repoURL);
        const cloneURL = tree ? tree.cloneUrl : repoURL;

        let name = path.basename(cloneURL);
        name = name.slice(-4) === '.git' ? name.slice(0, -4) : name; // Removing .git from the end
        let dir = path.resolve(process.cwd());

        const options = tree ? ['--branch', tree.ref] : [];

        return new Promise((resolve, reject) => {
            git(dir).silent(true).clone(cloneURL, name, options, (err, data) => {
                if (err)
                    reject(err);
                else
                    resolve(tree && tree.subpath ? path.join(dir, name, tree.subpath) : path.join(dir, name));
            });
        });
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

        const tempDir = path.join(process.cwd(), `tmp/baker-file-${Math.random().toString(36).slice(2, 8)}`);
        await fs.promises.mkdir(tempDir, { recursive: true });
        await fs.promises.writeFile(path.join(tempDir, 'baker.yml'), content, 'utf8');
        return tempDir;
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
