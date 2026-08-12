const conf           = require('../modules/configstore');
const spinnerDot     = conf.get('spinnerDot');
const Baker          = require('../modules/baker');
const Git            = require('../modules/utils/git');
const path           = require('path');
const Print          = require('../modules/print');
const Spinner        = require('../modules/spinner');
const { resolveSource } = require('../modules/utils/source');

const _              = require('underscore');

// exports.aliases = ['$0'];
exports.command = 'bake [source]'
exports.desc = 'Bake your environment given a local path or repository URL containing a baker.yml file';
exports.builder = (yargs) => {
    yargs
        .example(`$0 bake`, `Bake baker.yml of current directory`)
        .example(`$0 bake ~/project`, `Bake baker.yml of ~/project`)
        .example(`$0 bake ottomatica/baker-test`, `Clone github.com/ottomatica/baker-test and Bake its top-level baker.yml`)
        .example(`$0 bake your-org/configs:units/one`, `Clone the repo and Bake the baker.yml in its units/one directory`)
        .example(`$0 bake --repo git@github.com:ottomatica/baker-test.git`, `Clone repository in current directory and Bake its baker.yml`)
        .example(`$0 bake --repo https://github.com/ottomatica/baker-examples/tree/master/jenkins`, `Clone repository and Bake the baker.yml in its jenkins subdirectory`)
        .example(`$0 bake --file https://gist.github.com/username/1234567890abcdef`, `Fetch a baker.yml from a GitHub gist, GitLab snippet, or raw file URL and Bake it`);

    yargs.positional('source', {
        describe: `where the baker.yml comes from: a directory, owner/repo[:subdir], or a URL. Always resolves to a directory containing a literal baker.yml. Omit to use ./baker.yml.`,
        type: 'string'
    });

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
            verbose: {
                alias: 'v',
                describe: `Provide extra output from baking process`,
                demand: false,
                type: 'boolean'
            }
        }
    );
};

exports.handler = async function(argv) {
    const { source, local, repo, file, verbose } = argv;

    try{
        let bakePath;

        if (local) {
            bakePath = path.resolve(local);
        } else if (repo) {
            bakePath = path.resolve(await Git.clone(repo));
        } else if (file) {
            bakePath = path.resolve(await Git.fetchBakerFile(file));
        } else {
            // Positional `source` (or no argument): a directory, a local .yml
            // file, owner/repo shorthand, or a URL — all resolved to a directory
            // containing a baker.yml. The explicit flags above remain as
            // unambiguous overrides.
            try {
                bakePath = await resolveSource(source);
            } catch (err) {
                Print.error(err.message);
                process.exit(1);
            }
        }

        const {BakerObj, doc} = await Baker.chooseProvider(bakePath);

        await BakerObj.bake(bakePath, null, verbose);

    } catch (err) {
        Print.error(err);
    }
}
