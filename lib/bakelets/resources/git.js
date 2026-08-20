const Bakelet  = require('../bakelet');
const chalk = require('chalk');
const _ = require('underscore');
const path = require('path');
const fs = require('fs-extra');
const child_process = require('child_process');
const os = require('os');
const crypto = require('crypto');
const slash = require('slash');
const GitUtil = require('../../modules/utils/git');

class Git extends Bakelet {
    constructor(name, ansibleSSHConfig, version) {
        super(ansibleSSHConfig);

        this.name = name;
        this.version = version;
    }

    async load(obj, variables) {
        this.variables = variables;

        if (obj.git) {
            let type = typeof(obj.git);
            if (type == 'string'){
                let git = obj.git.trim();
                // Normalize common typos: "https//" → "https://", "http//" → "http://"
                git = git.replace(/^([a-zA-Z]+)\/\//, '$1://');
                // Find the last colon that could be a repo:dest separator.
                // Heuristic: if the string contains ://, treat it as a protocol prefix.
                // After the protocol, the last colon is the dest separator.
                let protoIndex = git.indexOf('://');
                if (protoIndex >= 0) {
                    let afterProto = git.substring(protoIndex + 3);
                    let colonIndex = afterProto.lastIndexOf(':');
                    if (colonIndex >= 0) {
                        this.repo = git.substring(0, protoIndex + 3 + colonIndex);
                        this.dest = afterProto.substring(colonIndex + 1).trim();
                    } else {
                        this.repo = git;
                        this.dest = null;
                    }
                } else {
                    // No protocol. Use the last colon, but check if the part after
                    // it looks like a dest path or part of an SSH URL.
                    let colonIndex = git.lastIndexOf(':');
                    if (colonIndex >= 0) {
                        let maybeDest = git.substring(colonIndex + 1).trim();
                        if (maybeDest.startsWith('/') || maybeDest.startsWith('.')) {
                            this.repo = git.substring(0, colonIndex);
                            this.dest = maybeDest;
                        } else {
                            this.repo = git;
                            this.dest = null;
                        }
                    } else {
                        this.repo = git;
                        this.dest = null;
                    }
                }
                // "<url>@<ref>:<dest>" — done after the dest split so the last
                // colon still means what it always meant.
                // Added by Claude Code (claude-opus-5[1m])
                const split = Git.splitRef(this.repo);
                this.repo = split.repo;
                this.ref = split.ref;
            }
            else if(type == 'object'){
                this.repo = obj.git.repo;
                this.dest = obj.git.dest;
                // Content injection rather than a clone: no .git, no history,
                // and re-runnable. See installExtract().
                // Added by Claude Code (claude-opus-5[1m])
                this.extract = obj.git.extract === true;
                // Branch, tag or commit — for both forms. With extract: it
                // selects the content fetched; with a clone it is passed to
                // `git clone --branch`. Absent, both take the default branch,
                // which is what every config written before this key did.
                this.ref = obj.git.ref;
                if( obj.git.private )
                {
                    if( this.variables.filter( x => x.githubuser ).length == 0 || this.variables.filter( x => x.githubpass ).length == 0 )
                    {
                        console.log(chalk.red("You must define a githubuser and githubpass variable in order to clone a private repo"));
                        throw new Error("Cannot complete git operation.");
                    }
                    let user = encodeURIComponent(this.variables.filter( x => x.githubuser )[0].githubuser);
                    let pass = encodeURIComponent(this.variables.filter( x => x.githubpass )[0].githubpass);
                    // gitlab/bitbucket.
                    this.repo = this.repo.replace('github.com', `${user}:${pass}@github.com`);
                }
            }
        }
        if( this.verbose )
        {
            console.log('repo', this.repo);
            console.log('dest', this.dest);
        }
    }

    // Splits "<url>@<ref>" into its parts.
    //
    // The `@` has to be found in the PATH, not the whole string: `https://
    // user:pass@host/o/r` and the scp-style `git@github.com:o/r` both carry one
    // in the host portion, and treating either as a ref marker would mangle the
    // URL. Locating the host first also means a ref containing a slash
    // (release/1.2) parses correctly, which a naive "last @ after the last /"
    // rule would not.
    // Added by Claude Code (claude-opus-5[1m])
    static splitRef(repoString) {
        const str = String(repoString || '');
        const scheme = str.match(/^[a-z][a-z0-9+.-]*:\/\//i);

        let hostEnd;
        if (scheme) {
            hostEnd = str.indexOf('/', scheme[0].length);
        } else {
            // scp-style [user@]host:path
            hostEnd = str.indexOf(':');
        }
        if (hostEnd < 0) return { repo: str, ref: undefined };

        const at = str.lastIndexOf('@');
        if (at <= hostEnd) return { repo: str, ref: undefined };
        return { repo: str.slice(0, at), ref: str.slice(at + 1) || undefined };
    }

    // Where install() puts the clone, computed identically so cleanup targets
    // the same directory rather than a guess.
    cloneDestination() {
        const dest = this.dest || path.basename(this.repo || '', '.git');
        // Local resolves against the host filesystem. Docker and remote use the
        // path as-is, because that is what install() clones to *inside* the
        // target — resolving it here would have pointed cleanup at a host path
        // that never existed.
        // Modified by Claude Code (claude-opus-5[1m])
        return this.localLocation ? path.resolve(this.localLocation, dest) : dest;
    }

    // Defaults to No and is subject to the dirty-check, which overrides the
    // answer: a clone may hold the user's committed-but-unpushed work.
    async plan() {
        if (!this.repo) {
            return [{ kind: 'none', bakelet: 'git', reason: 'no repository URL in the config' }];
        }
        // Injected content is removable because install() recorded exactly what
        // it wrote. Without that manifest Baker could not tell its own files
        // from the person's, and this writes INTO a directory someone already
        // owns — which is where a wrong deletion costs the most.
        // Added by Claude Code (claude-opus-5[1m])
        if (this.extract) {
            return this.planExtractRemoval();
        }
        return [await this.planRepoRemoval(
            'resources git', this.cloneDestination(), this.repo, this.ref)];
    }

    async uninstall(operation) {
        // The extract path removes a recorded set; the clone path removes one
        // directory it created whole.
        if (operation.kind === 'paths') {
            const emptyOnly = new Set(operation.emptyOnly || []);
            for (const target of operation.paths) {
                if (emptyOnly.has(target)) await this.removeIfEmpty(target);
                else await this.removePath(target);
            }
            return;
        }
        await this.removePath(operation.path);
    }

    // Clone-if-absent as one shell command, for the modes whose target is not
    // the host. Skips rather than pulling: an existing checkout may hold work
    // that is not pushed, and this bakelet's job is to put the repo there once.
    //
    // No single quotes — docker-local wraps commands as `bash -c '<cmd>'`, the
    // same constraint test-command-tables.js enforces for command tables. Both
    // non-local targets are Linux (see resolve.js), so one POSIX guard covers
    // them and no PowerShell variant is needed.
    // Modified by Claude Code (claude-opus-5[1m])
    static cloneCommand(repo, dest, ref) {
        const branch = ref ? `--branch "${ref}" ` : '';
        return `if [ -e "${dest}" ]; then echo "${dest} already exists; skipping clone."; ` +
            `else git clone ${branch}"${repo}" "${dest}"; fi`;
    }

    // Injects a repository's CONTENT into a folder: resolve the ref to an exact
    // commit, fetch that commit's archive, unpack it in place. No clone, no
    // .git, nothing for the person to accidentally commit into.
    //
    // Unlike the clone path this is deliberately RE-RUNNABLE rather than
    // skip-if-present: injection is how a per-unit configuration is updated, so
    // a second bake at a new ref must actually change the files. tar overwrites
    // what the archive contains and leaves everything else alone, which is
    // overlay semantics — the person's own work in that folder survives.
    //
    // Pinning to a sha first is what makes it honest: a branch name resolved at
    // fetch time could serve two students different content on the same day.
    // Added by Claude Code (claude-opus-5[1m])
    async installExtract(destPath) {
        // Checked before resolveRef so an unsupported host costs no network call
        // and reports the actual problem, rather than surfacing as a confusing
        // authentication failure from ls-remote.
        if (!GitUtil.archiveHostSupported(this.repo)) {
            throw new Error(
                `extract: does not know how to fetch an archive from ${this.repo}.\n` +
                `It is supported for github.com repositories. For any other host, ` +
                `use the clone form (drop extract:).`
            );
        }

        const { sha, ref } = await GitUtil.resolveRef(this.repo, this.ref);
        const url = GitUtil.tarballUrl(this.repo, sha);

        const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'baker-extract-'));
        try {
            const archive = path.join(staging, 'repo.tar.gz');
            await GitUtil.downloadToFile(url, archive, { 'User-Agent': 'baker' });

            // Unpacked in staging first, not straight into destPath, so the
            // archive's file list is known exactly. Extracting in place would
            // leave Baker unable to tell its own files from ones already in that
            // folder — which is precisely what cleanup needs to know later.
            const unpacked = path.join(staging, 'unpacked');
            GitUtil.extractTarball(archive, unpacked);
            const placed = Git.walkFiles(unpacked);

            fs.ensureDirSync(destPath);
            fs.copySync(unpacked, destPath, { overwrite: true });

            this.writeExtractManifest(destPath, placed, sha, ref);
            console.log(chalk.green(
                `Injected ${this.repo} at ${sha.slice(0, 7)} (${ref}) into ${destPath} ` +
                `(${placed.length} file${placed.length === 1 ? '' : 's'})`));
        } finally {
            fs.removeSync(staging);
        }
    }

    // Every file in a tree, as posix-separated paths relative to its root.
    static walkFiles(root, prefix = '') {
        const out = [];
        for (const entry of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory()) out.push(...Git.walkFiles(root, rel));
            else out.push(rel);
        }
        return out;
    }

    static hashFile(file) {
        return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    }

    // Bookkeeping travels with the content it describes, the same way files:
    // keeps .baker-manifest.json at its environment root.
    get extractManifestName() {
        return '.baker-extract.json';
    }

    // One record per file actually placed, each with the hash it had when Baker
    // wrote it. The hash is what makes removal safe: at cleanup time a file that
    // still matches is untouched and Baker's to remove, and one that does not
    // has been edited by the person and is theirs to keep.
    //
    // Paths are stored relative to the environment root, matching the files:
    // manifest convention, and joined back to absolute paths at plan time.
    // Added by Claude Code (claude-opus-5[1m])
    writeExtractManifest(destPath, placed, sha, ref) {
        const entries = placed.map((rel) => {
            const abs = path.join(destPath, rel);
            return {
                path: slash(path.relative(this.localLocation, abs)),
                sha256: Git.hashFile(abs)
            };
        });
        fs.outputFileSync(
            path.join(destPath, this.extractManifestName),
            JSON.stringify({
                version: 1, bakelet: 'resources git (extract)', name: this.name,
                repo: this.repo, commit: sha, ref, written: new Date().toISOString(), entries
            }, null, 2) + '\n'
        );
    }

    readExtractManifest(destPath) {
        const file = path.join(destPath, this.extractManifestName);
        try {
            if (!fs.existsSync(file)) return null;
            const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
            return Array.isArray(parsed.entries) ? parsed : null;
        } catch (err) {
            // Corrupt is treated as absent — remove nothing — but say so, since
            // silently removing nothing looks identical to working correctly.
            console.warn(`resources git: ${file} is not valid JSON; skipping its cleanup.`);
            return null;
        }
    }

    // Cleanup for injected content. Removes exactly the files the manifest says
    // Baker wrote and that are still byte-for-byte what it wrote — nothing else
    // in a folder the person owns is touched, and an edited file is reported and
    // kept rather than deleted.
    // Added by Claude Code (claude-opus-5[1m])
    async planExtractRemoval() {
        const destPath = this.cloneDestination();
        const manifest = this.readExtractManifest(destPath);
        if (!manifest) {
            return [{
                kind: 'none', bakelet: 'resources git (extract)',
                reason: `no injection manifest in ${destPath}; nothing recorded to remove`
            }];
        }

        const operations = [];
        const removable = [];
        const edited = [];

        for (const entry of manifest.entries) {
            const abs = path.resolve(this.localLocation, entry.path);
            if (!fs.existsSync(abs)) continue;             // already gone
            if (Git.hashFile(abs) === entry.sha256) removable.push(abs);
            else edited.push(abs);
        }

        const manifestPath = path.join(destPath, this.extractManifestName);
        if (removable.length) {
            // Directories the injected files lived in, deepest first. An archive
            // with prompts/build.txt creates prompts/, and removing only the file
            // would leave an empty directory behind that nobody put there.
            // Ordered so a child is always considered before its parent.
            const dirs = new Set();
            for (const abs of removable) {
                let dir = path.dirname(abs);
                while (dir !== destPath && dir.startsWith(destPath + path.sep)) {
                    dirs.add(dir);
                    dir = path.dirname(dir);
                }
            }
            const nested = [...dirs].sort(
                (a, b) => b.split(path.sep).length - a.split(path.sep).length);

            operations.push({
                kind: 'paths', bakelet: 'resources git (extract)', default: true,
                // The manifest goes with the files it describes; directories go
                // only if nothing of the person's is left in them.
                paths: [...removable, manifestPath, ...nested, destPath],
                emptyOnly: [...nested, destPath],
                envRoot: this.localLocation,
                alreadyGone: manifest.entries.length - removable.length - edited.length,
                restore: 'baker bake <same source>'
            });
        }

        // Reported rather than silently skipped: "removed 6 of 9" needs to say
        // where the other three went.
        if (edited.length) {
            operations.push({
                kind: 'refused', bakelet: 'resources git (extract)', path: destPath,
                reason: `${edited.length} injected file(s) have been edited since they were placed`
            });
        }

        if (!operations.length) {
            operations.push({
                kind: 'none', bakelet: 'resources git (extract)',
                reason: `nothing injected into ${destPath} is still present`
            });
        }
        return operations;
    }

    async install() {
        if (!this.repo) {
            throw new Error("No repository URL specified in git resource.");
        }

        const dest = this.dest || path.basename(this.repo, '.git');

        if (this.extract) {
            // Host-side work, so it needs a host-side destination. The other two
            // modes place content by running a command IN the target, which
            // would need curl and tar inside a container that is not guaranteed
            // either — refused by name rather than half-supported.
            if (!this.localLocation) {
                throw new Error(
                    `extract: is only supported for local: environments.\n` +
                    `For docker: or remote:, use the clone form (drop extract:).`
                );
            }
            return this.installExtract(path.resolve(this.localLocation, dest));
        }

        // Local is the one mode whose target IS the host, so it can use fs
        // directly — which also keeps the guard correct on Windows, where no
        // shell is involved.
        if (this.localLocation) {
            const destPath = path.resolve(this.localLocation, dest);

            // A bare `git clone` fails when the destination exists ("already
            // exists and is not an empty directory") and execSync throws, so
            // every re-bake died here rather than moving on to the rest of the
            // config. Skip instead: the checkout is left exactly as it is,
            // including anything uncommitted in it.
            if (fs.existsSync(destPath)) {
                console.log(chalk.yellow(`${destPath} already exists; skipping clone.`));
                return;
            }

            fs.ensureDirSync(path.dirname(destPath));
            // --branch takes a tag as happily as a branch; a tag simply leaves
            // the clone with a detached HEAD, which is what asking for a tag
            // means.
            const branch = this.ref ? `--branch "${this.ref}" ` : '';
            child_process.execSync(`git clone ${branch}"${this.repo}" "${destPath}"`, { stdio: 'inherit' });
            return;
        }

        // Docker and remote: the clone belongs in the TARGET, so it goes
        // through the transport. Previously this branch ran child_process on
        // the host (cloning onto the operator's machine instead of into the
        // container) for docker, and for remote called an unqualified
        // `runGitClone` that threw ReferenceError before reaching an
        // Ansible command aimed at the deleted baker-srv shared folder.
        await this.exec(Git.cloneCommand(this.repo, dest, this.ref));
    }
}

module.exports = Git;
