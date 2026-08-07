const { spawn } = require('child_process');
const Print     = require('../modules/print');
const { classifyRemote } = require('../modules/utils/source');

exports.command = 'check [target]';
exports.desc = 'Run opunit checks against a repository profile or a local test/opunit.yml file';

exports.builder = (yargs) => {
    yargs
        .example(`$0 check`, `Run test/opunit.yml against the local machine (opunit verify local)`)
        .example(`$0 check your-org/profiles:env.yml`, `Run a GitHub-hosted profile (opunit profile)`);

    yargs.positional('target', {
        describe: `A profile address <user>/<repo>:<file.yml>. Omit to run local test/opunit.yml.`,
        type: 'string'
    });
};

exports.handler = async function (argv) {
    const { target } = argv;

    try {
        await runOpunit(opunitArgs(target));
    } catch (err) {
        Print.error(err);
    }
};

// Profile mode:  baker check <user>/<repo>:<file.yml>  ==  opunit profile <same>
// Local mode:    baker check                            ==  opunit verify local
//
// An unrecognised target used to fall through to local mode, which ran a
// DIFFERENT check and reported its result as though it were the requested one.
// A target that cannot be run as a profile is now an error naming the expected
// form; only the absence of a target selects local mode.
// Modified by Claude Code (claude-opus-5[1m])
function opunitArgs(target) {
    if (!target) return ['verify', 'local'];

    const remote = classifyRemote(target);

    if (remote && remote.kind === 'github-file') {
        // opunit resolves a profile as
        // raw.githubusercontent.com/<owner>/<repo>/master/<file> — the branch is
        // hardcoded (opunit 0.9.4, lib/profile.js). Passing a ref through would
        // build an unresolvable URL and fail inside opunit, so it is refused here
        // where the reason can be stated.
        if (remote.ref) {
            throw new Error(
                `${target} names a ref, which opunit profiles do not support.\n` +
                `opunit reads a profile from the master branch of the repository.\n` +
                `Try: baker check ${target.replace('@' + remote.ref, '')}`
            );
        }
        return ['profile', target];
    }

    throw new Error(
        `${target} is not an opunit profile address.\n` +
        `\`check\` takes <owner>/<repo>:<file>.yml — a file on the repository's master branch, ` +
        `at any path.\n` +
        `Omit the argument to run ./test/opunit.yml against this machine.`
    );
}

module.exports.opunitArgs = opunitArgs;

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
