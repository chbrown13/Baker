const Bakelet  = require('../bakelet');
const chalk = require('chalk');
const _ = require('underscore');
const Ssh = require('../../modules/ssh');
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

    static async runGitClone (doc, repo, dest, ansibleSSHConfig,verbose) {
        return Ssh.sshExec(`export ANSIBLE_HOST_KEY_CHECKING=false && cd /home/vagrant/baker/${doc.name} && ansible all -m git -a "repo=${repo} dest=${dest} version=HEAD" -i baker_inventory`, ansibleSSHConfig, 20000, verbose);
    }

    async install() {
        if (!this.repo) {
            throw new Error("No repository URL specified in git resource.");
        }
        if (this.ansibleSSHConfig) {
            let dest = this.dest || this.name;
            await runGitClone({name: this.name}, this.repo, dest, this.ansibleSSHConfig, this.verbose);
        } else {
            let dest = this.dest || path.basename(this.repo, '.git');
            let destPath = this.localLocation ? path.resolve(this.localLocation, dest) : path.resolve(dest);
            fs.ensureDirSync(path.dirname(destPath));
            child_process.execSync(`git clone "${this.repo}" "${destPath}"`, { stdio: 'inherit' });
        }
    }
}

module.exports = Git;
