const child_process = require('child_process');
const fs            = require('fs');
const path          = require('path');
const yaml          = require('js-yaml');
const chalk         = require('chalk');

const Baker     = require('../modules/baker');
const Print     = require('../modules/print');
const Utils     = require('../modules/utils/utils');
const LocalProvider       = require('../modules/providers/local');
const DockerLocalProvider = require('../modules/providers/docker-local');
const RemoteProvider      = require('../modules/providers/remote');

exports.command = 'run [cmdlet]';
exports.desc = 'Run a named command from the commands: block of baker.yml';

exports.builder = (yargs) => {
    yargs
        .example(`$0 run test`, `Run the 'test' command in the baker environment`)
        .example(`$0 run`, `List the available commands`);

    yargs.positional('cmdlet', {
        describe: 'Command inside baker.yml under commands:',
        type: 'string'
    });

    yargs.options({
        force: {
            alias: 'f',
            describe: `Run even when the environment is not recorded as baked`,
            demand: false,
            type: 'boolean'
        }
    });
};

// Where a command runs. Mirrors files.envRoot deliberately: `run` and
// `config: files:` must agree on the environment root, or a command executes
// somewhere files: never wrote — silently, and only on the two providers that
// are hardest to test.
//
// Local resolves to the real project directory. The old implementation built
// `cd /<basename>; <script>` for every provider, which is the control-VM shared
// folder convention and does not exist on a host.
// Added by Claude Code (claude-opus-5[1m])
function runTarget(doc, bakePath, cmdlet) {
    const command = doc.commands[cmdlet];

    if (doc.local !== undefined) {
        const cwd = typeof doc.local === 'string'
            ? LocalProvider.resolveLocation(doc.local)
            : bakePath;
        return { cwd, command };
    }

    // BAKER_SHARE_DIR — the repo's existing answer to "where the project lives
    // inside the environment", injected by resolve.js for every non-local mode.
    return { cwd: `/${path.basename(bakePath)}`, command };
}

// The ssh flags Ssh._nativeSSH_Session uses, minus `-tt`. The TTY is the whole
// reason this is built here rather than reusing SSH_Session: `-tt` makes the
// remote command believe a human is present, so `git log` opens a pager and
// hangs, and npm emits progress bars into a non-terminal. `run` streams output
// but attaches no keyboard, which is a deliberate non-goal in the spec.
function sshArgs(sshConfig) {
    return [
        '-q',
        '-i', String(sshConfig.private_key),
        '-p', String(sshConfig.port),
        '-o', 'StrictHostKeyChecking=no',
        `${sshConfig.user}@${sshConfig.hostname}`
    ];
}

// What to spawn, as argv rather than a string, so the shape is assertable
// without running anything.
function invocation(provider, envName, cwd, command) {
    if (provider instanceof DockerLocalProvider) {
        // -w rather than a `cd &&` prefix: docker exec takes a working
        // directory natively and reports a missing one itself.
        return { file: 'docker', args: ['exec', '-w', cwd, envName, '/bin/bash', '-c', command] };
    }

    if (provider instanceof RemoteProvider) {
        return {
            file: 'ssh',
            args: [...sshArgs(provider.sshConfig), `cd "${cwd}" && ${command}`]
        };
    }

    // Windows cannot run what Baker generates through cmd.exe — the same reason
    // makeTransport selects powershell.exe in local mode.
    return process.platform === 'win32'
        ? { file: 'powershell.exe', args: ['-Command', command], options: { cwd } }
        : { file: '/bin/sh', args: ['-c', command], options: { cwd } };
}

// A shell probe for whether the working directory exists in the target. Local
// answers from the host filesystem; the other two need a round trip.
function cwdProbe(provider, envName, cwd) {
    if (provider instanceof DockerLocalProvider) {
        return { file: 'docker', args: ['exec', envName, 'test', '-d', cwd] };
    }
    if (provider instanceof RemoteProvider) {
        return { file: 'ssh', args: [...sshArgs(provider.sshConfig), `test -d "${cwd}"`] };
    }
    return null;   // local: answered without spawning
}

// Distinguishes three outcomes rather than two. A probe that could not run at
// all — `docker` or `ssh` missing from PATH — must not be reported as "the
// directory is absent", which would send someone to fix the wrong thing.
function cwdExists(provider, envName, cwd) {
    const probe = cwdProbe(provider, envName, cwd);
    if (!probe) return { ok: fs.existsSync(cwd) };

    const result = child_process.spawnSync(probe.file, probe.args, { stdio: 'ignore' });
    if (result.error || result.status === null) {
        return { ok: false, unreachable: `${probe.file} could not be run (${result.error ? result.error.code : 'no exit status'})` };
    }
    return { ok: result.status === 0 };
}

function listCmdlets(envName, commands, requested) {
    if (!commands || !Object.keys(commands).length) {
        console.log(
            `${envName} defines no commands. Add a commands: block to baker.yml:\n\n` +
            `  commands:\n    test: npm test\n    setup: ./scripts/setup.sh`
        );
        return;
    }

    if (requested) console.log(`No command named '${requested}'.`);
    console.log(`The following cmdlets are available in ${envName} 🍞:`);
    for (const c in commands) {
        console.log(`${chalk.blueBright(c)}\t${commands[c]}`);
    }
}

function spawnStreaming(invoked) {
    const { file, args, options } = invoked;
    return new Promise((resolve) => {
        // stdio: 'inherit' — the student watches a slow step happen. bake's
        // capturing transport.exec is untouched, so bake.log keeps working.
        // stdin is inherited too, but no TTY is allocated: a command that
        // prompts will appear to hang, which is documented rather than
        // defended against.
        const child = child_process.spawn(file, args, Object.assign({ stdio: 'inherit' }, options));
        child.on('error', () => resolve(127));
        child.on('close', (code) => resolve(code === null ? 1 : code));
    });
}

// Returns an exit code and never calls process.exit, so tests can observe the
// result without killing the runner. Same seam as check.js's opunitArgs.
async function runCmdlet(argv) {
    const bakePath = process.cwd();
    const { envName, provider } = await Baker.chooseProvider(bakePath);

    // `hello` is a built-in smoke test, not a cmdlet: it answers "is Baker
    // wired up?", so it must not need an SSH key, a container, or a mounted
    // path — none of which exist when someone is asking that.
    if (argv.cmdlet === 'hello') {
        console.log(`Running hello in ${envName} 🍞`);
        console.log('hello');
        return 0;
    }

    const doc = yaml.safeLoad(fs.readFileSync(path.join(bakePath, 'baker.yml'), 'utf8'));

    if (!argv.cmdlet || !(doc.commands && Object.prototype.hasOwnProperty.call(doc.commands, argv.cmdlet))) {
        listCmdlets(envName, doc.commands, argv.cmdlet);
        return 1;
    }

    // --force covers a stale or wiped index — the record is keyed on the name:
    // in baker.yml, so two checkouts sharing a name overwrite each other.
    if (!argv.force && !(await Utils.FindInIndex(envName))) {
        throw new Error(
            `${envName} is not recorded as baked. Run \`baker bake\` first, ` +
            `or pass --force to run anyway.`
        );
    }

    const { cwd, command } = runTarget(doc, bakePath, argv.cmdlet);

    // The value comes from the user's YAML, where `test:` followed by an
    // indented block is a mapping rather than a string. Passing that to spawn
    // throws a bare TypeError naming neither the cmdlet nor the file.
    if (typeof command !== 'string') {
        throw new Error(
            `commands: ${argv.cmdlet}: must be a shell command string, not a ` +
            `${Array.isArray(command) ? 'list' : typeof command}.\n\n` +
            `  commands:\n    ${argv.cmdlet}: npm test`
        );
    }

    // Never skipped, --force notwithstanding: a missing directory means the
    // command has nowhere to run, and Baker's message is more use than the
    // shell's.
    const reachable = cwdExists(provider, envName, cwd);
    if (reachable.unreachable) {
        throw new Error(
            `Could not check ${envName} for ${cwd}: ${reachable.unreachable}.\n\n` +
            `  This is not a problem with your baker.yml. Confirm the tool is installed ` +
            `and on your PATH.`
        );
    }
    if (!reachable.ok) {
        throw new Error(
            `${cwd} does not exist in ${envName}.\n\n` +
            `  Nothing has been placed there yet. Add a config: files: entry to your ` +
            `baker.yml, or run this on local:.`
        );
    }

    console.log(`Running ${argv.cmdlet} in ${envName} 🍞`);
    return spawnStreaming(invocation(provider, envName, cwd, command));
}

exports.handler = async function (argv) {
    try {
        process.exit(await runCmdlet(argv));
    } catch (err) {
        Print.error(err);
        process.exit(1);
    }
};

module.exports.runCmdlet  = runCmdlet;
module.exports.runTarget  = runTarget;
module.exports.invocation = invocation;
module.exports.sshArgs    = sshArgs;
module.exports.cwdProbe   = cwdProbe;
