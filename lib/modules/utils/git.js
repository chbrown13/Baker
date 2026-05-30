const git  = require('simple-git');
const fs   = require('fs');
const https = require('https');
const path = require('path');

class Git {
    constructor() {}

    static async clone(repoURL) {
        let name = path.basename(repoURL);
        name = name.slice(-4) === '.git' ? name.slice(0, -4) : name; // Removing .git from the end
        let dir = path.resolve(process.cwd());

        return new Promise((resolve, reject) => {
            git(dir).silent(true).clone(repoURL, (err, data) => {
                if (err)
                    reject(err);
                else
                    resolve(path.join(dir, name));
            });
        });
    }

    static async cloneGist(gistURL) {
        const rawGistUrlMatch = gistURL.match(/^https?:\/\/gist\.githubusercontent\.com\/(?:[^/]+\/)?[0-9a-fA-F]+\/raw\/(?:.+\/)?([^/]+)$/i);
        const rawGistGitHubMatch = gistURL.match(/^https?:\/\/gist\.github\.com\/(?:[^/]+\/)?([0-9a-fA-F]+)\/raw\/(.+)$/i);
        if (rawGistUrlMatch || rawGistGitHubMatch) {
            const fileName = rawGistUrlMatch ? rawGistUrlMatch[1] : path.basename(rawGistGitHubMatch[2]);
            const uri = gistURL;
            const tempDir = path.join(process.cwd(), `tmp/baker-gist-${Math.random().toString(36).slice(2,8)}`);
            await fs.promises.mkdir(tempDir, { recursive: true });
            const targetPath = path.join(tempDir, 'baker.yml');
            const content = await Git.fetchUrl(uri, {
                'User-Agent': 'baker',
                Accept: 'application/vnd.github.v3.raw'
            });
            await fs.promises.writeFile(targetPath, content, 'utf8');
            return tempDir;
        }

        const gistIdMatch = gistURL.match(/^https?:\/\/gist\.github\.com\/(?:[^/]+\/)?([0-9a-fA-F]+)(?:\.git)?(?:[/?#].*)?$/i);
        if (gistIdMatch) {
            const gistId = gistIdMatch[1];
            const apiUrl = `https://api.github.com/gists/${gistId}`;
            const gistData = await Git.fetchJson(apiUrl, {
                'User-Agent': 'baker',
                Accept: 'application/vnd.github.v3+json'
            });

            const files = gistData.files || {};
            const fileNames = Object.keys(files);
            if (!fileNames.length) {
                throw new Error(`No files found in gist ${gistId}`);
            }

            const bakerFile = files['baker.yml'] || files['baker.yaml'] || files[fileNames[0]];
            if (!bakerFile || !bakerFile.content) {
                throw new Error(`Could not find baker.yml content in gist ${gistId}`);
            }

            const tempDir = path.join(process.cwd(), `tmp/baker-gist-${gistId.substring(0, 6)}`);
            await fs.promises.mkdir(tempDir, { recursive: true });
            const targetPath = path.join(tempDir, 'baker.yml');
            await fs.promises.writeFile(targetPath, bakerFile.content, 'utf8');
            return tempDir;
        }

        throw new Error(`Unsupported Gist URL: ${gistURL}`);
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
