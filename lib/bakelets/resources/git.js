const Bakelet  = require('../bakelet');
const chalk = require('chalk');
const _ = require('underscore');
const path = require('path');
const fs = require('fs-extra');
const child_process = require('child_process');

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
            }
            else if(type == 'object'){
                this.repo = obj.git.repo;
                this.dest = obj.git.dest;
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
        return [await this.planRepoRemoval('resources git', this.cloneDestination(), this.repo)];
    }

    async uninstall(operation) {
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
    static cloneCommand(repo, dest) {
        return `if [ -e "${dest}" ]; then echo "${dest} already exists; skipping clone."; ` +
            `else git clone "${repo}" "${dest}"; fi`;
    }

    async install() {
        if (!this.repo) {
            throw new Error("No repository URL specified in git resource.");
        }

        const dest = this.dest || path.basename(this.repo, '.git');

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
            child_process.execSync(`git clone "${this.repo}" "${destPath}"`, { stdio: 'inherit' });
            return;
        }

        // Docker and remote: the clone belongs in the TARGET, so it goes
        // through the transport. Previously this branch ran child_process on
        // the host (cloning onto the operator's machine instead of into the
        // container) for docker, and for remote called an unqualified
        // `runGitClone` that threw ReferenceError before reaching an
        // Ansible command aimed at the deleted baker-srv shared folder.
        await this.exec(Git.cloneCommand(this.repo, dest));
    }
}

module.exports = Git;
