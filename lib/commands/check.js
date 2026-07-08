const { spawn } = require('child_process');
const Print     = require('../modules/print');

// Matches an opunit profile address: <user>/<repo>:<file>  (e.g. chbrown13/profile:5704.yml)
const PROFILE_RE = /^[\w.-]+\/[\w.-]+:[\w./-]+$/;

exports.command = 'check [target]';
exports.desc = 'Run opunit checks against a repository profile or a local test/opunit.yml file';

exports.builder = (yargs) => {
    yargs
        .example(`$0 check`, `Run test/opunit.yml against the local machine (opunit verify local)`)
        .example(`$0 check chbrown13/profile:5704.yml`, `Run a GitHub-hosted profile (opunit profile)`);

    yargs.positional('target', {
        describe: `A profile address <user>/<repo>:<file.yml>. Omit to run local test/opunit.yml.`,
        type: 'string'
    });
};

exports.handler = async function (argv) {
    const { target } = argv;

    try {
        // Profile mode:  baker check <user>/<repo>:<file.yml>  ==  opunit profile <same>
        // Local mode:    baker check                            ==  opunit verify local
        const args = target && PROFILE_RE.test(target)
            ? ['profile', target]
            : ['verify', 'local'];

        await runOpunit(args);
    } catch (err) {
        Print.error(err);
    }
};

function runOpunit(args) {
    return new Promise((resolve, reject) => {
        const child = spawn('opunit', args, { stdio: 'inherit', shell: false });
        child.on('error', (e) =>
            e.code === 'ENOENT'
                ? reject(new Error(`opunit not found on PATH. Install it: npm install -g ottomatica/opunit`))
                : reject(e));
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`opunit exited with code ${code}`))));
    });
}
