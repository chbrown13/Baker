const conf           = require('../modules/configstore');
const spinnerDot     = conf.get('spinnerDot');
const Baker          = require('../modules/baker');
const Git            = require('../modules/utils/git');
const path           = require('path');
const Print          = require('../modules/print');
const Servers        = require('../modules/servers');
const Spinner        = require('../modules/spinner');
const VaultLib       = require('../modules/vault');
const LocalProvider  = require('../modules/providers/local');

const inquirer = require('inquirer');
const _              = require('underscore');

const  { bakerSSHConfig } = require('../../global-vars');

// exports.aliases = ['$0'];
exports.command = 'bake'
exports.desc = 'Bake your VM given local path or repository URL containing the baker.yml';
exports.builder = (yargs) => {
    yargs
        .example(`$0 bake`, `Bake baker.yml of current directory`)
        .example(`$0 bake --local ~/project`, `Bake baker.yml of ~/project`)
        .example(`$0 bake --repo git@github.com:ottomatica/baker-test.git`, `Clone repository in current directory and Bake its baker.yml`)
        .example(`$0 bake --repo https://github.com/ottomatica/baker-examples/tree/master/jenkins`, `Clone repository and Bake the baker.yml in its jenkins subdirectory`)
        .example(`$0 bake --file https://gist.github.com/username/1234567890abcdef`, `Fetch a baker.yml from a GitHub gist, GitLab snippet, or raw file URL and Bake it`);

    yargs.options(
        {
            local: {
                alias: 'l',
                describe: `give a local path to where your baker.yml file is located`,
                demand: false,
                type: 'string'
            },
            repo: {
                alias: 'r',
                describe: `give a git repository URL which has a baker.yml in it's root directory`,
                demand: false,
                type: 'string'
            },
            file: {
                alias: 'f',
                describe: `give a URL to a baker.yml file — a GitHub gist, GitLab snippet, enterprise/self-hosted instance, or raw file URL`,
                demand: false,
                type: 'string'
            },
            box: {
                alias: 'b',
                describe: `give local path to where your baker.yml file is located`,
                demand: false,
                type: 'string'
            },
            remote: {
                describe: `give ip address of the remote server`,
                demand: false,
                type: 'string'
            },
            remote_key: {
                describe: `give path to the ssh key of the remote server`,
                demand: false,
                type: 'string'
            },
            remote_user: {
                describe: `give the ssh username of the remote server`,
                demand: false,
                type: 'string'
            },
            verbose: {
                alias: 'v',
                describe: `Provide extra output from baking process`,
                demand: false,
                type: 'boolean'
            },
            forceVirtualBox: {
                describe: `Force using virtualbox instead of xhyve VM on Mac (no effect on Windows/Linux)`,
                hidden: true, // just for debugging for now
                demand: false,
                type: 'boolean'
            },
            useContainer: {
                describe: `Override environment type to use container`,
                demand: false,
                type: 'boolean'
            },
            useVM: {
                describe: `Override environment type to use vm`,
                demand: false,
                type: 'boolean'
            }
        }
    );
};

exports.handler = async function(argv) {
    const { local, repo, file, box, remote, remote_key, remote_user, verbose, forceVirtualBox, useContainer, useVM  } = argv;

    try{
        let ansibleVM;
        let bakePath;

        if( box ){
            bakePath = path.resolve(box);
        }
        else if (local) {
            bakePath = path.resolve(local);
        } else if (repo) {
            bakePath = path.resolve(await Git.clone(repo));
        } else if (file) {
            bakePath = path.resolve(await Git.fetchBakerFile(file));
        }
        else if (remote) {
            bakePath = path.resolve(process.cwd());
        } else {
            let cwdVM = await Baker.getCWDBakerYML();
            if(cwdVM){
                bakePath = cwdVM.cwd;
            } else {
                Print.error(
                    `Can't find baker.yml in cwd. Use --local to give local path or --repo to give git repository with baker.yml`
                );
                process.exit(1);
            }
        }

        const {provider, BakerObj, doc} = await Baker.chooseProvider(bakePath, useContainer, useVM);

        if( doc.config )
        {
            if( doc.config.some(element => element.vault) )
            {
                let passphraseKey = `vault:${bakePath}`;
                if( !conf.has(passphraseKey) )
                {
                    let pass = await promptPass();
                    let vault = new VaultLib();
                                    
                    console.log(passphraseKey, pass);
                    conf.set(passphraseKey, pass);
                }
            }
        }

        
        if(box)
            await provider.bakeBox(bakerSSHConfig, ansibleVM, bakePath, verbose);
        else if(remote)
            await BakerObj.bakeRemote(bakerSSHConfig, remote, remote_key, remote_user, bakePath, verbose);
        else{
            if (!(provider instanceof LocalProvider)) {
                await Servers.installBakerServer(forceVirtualBox);
            }

            await BakerObj.bake(bakePath, bakerSSHConfig, verbose);

            if (!(provider instanceof LocalProvider)) {
                await BakerObj.exposePorts(path.join(bakePath, 'baker.yml'), verbose);
            }
        }

    } catch (err) {
        Print.error(err);
    }
}

async function promptPass() {
    const answers = await inquirer.prompt([{
        type: 'password',
        name: 'password',
        message: 'Enter password:'
    }]);
    return answers.password;
}
