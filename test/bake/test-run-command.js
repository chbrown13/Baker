const child_process = require('child_process');
const EventEmitter  = require('events');
const fs            = require('fs-extra');
const os            = require('os');
const path          = require('path');
const chai          = require('chai');
const expect        = chai.expect;

// Stub spawn/spawnSync behind a gate, the same way test-check-command.js does:
// mocha loads every test file before running any, so an unconditional fake
// would break anything else that shells out. run.js calls through the
// child_process module object rather than a destructured reference, so the
// stub can be installed per-test rather than before require.
// Added by Claude Code (claude-opus-5[1m])
let spawnCalls = [];
let spawnSyncCalls = [];
let stubActive = false;
let nextExitCode = 0;
let nextProbeStatus = 0;

const origSpawn = child_process.spawn;
const origSpawnSync = child_process.spawnSync;

child_process.spawn = function (file, args, opts) {
    if (!stubActive) return origSpawn.apply(child_process, arguments);
    spawnCalls.push({ file, args, opts });
    const fake = new EventEmitter();
    process.nextTick(() => fake.emit('close', nextExitCode));
    return fake;
};

child_process.spawnSync = function (file, args, opts) {
    if (!stubActive) return origSpawnSync.apply(child_process, arguments);
    spawnSyncCalls.push({ file, args, opts });
    return { status: nextProbeStatus };
};

const run = require('../../lib/commands/run');
const LocalProvider       = require('../../lib/modules/providers/local');
const DockerLocalProvider = require('../../lib/modules/providers/docker-local');
const RemoteProvider      = require('../../lib/modules/providers/remote');
const Utils               = require('../../lib/modules/utils/utils');

const REMOTE = () => new RemoteProvider('ubuntu', '/keys/id_ed25519', '10.0.0.9', 2222);

describe('baker run', function () {

    let tmp, cwdBefore;

    beforeEach(function () {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'baker-run-'));
        cwdBefore = process.cwd();
        spawnCalls = [];
        spawnSyncCalls = [];
        nextExitCode = 0;
        nextProbeStatus = 0;
    });

    afterEach(function () {
        stubActive = false;
        process.chdir(cwdBefore);
        fs.removeSync(tmp);
    });

    // ---- runTarget: which directory, which command -----------------------

    describe('runTarget (AC-1, AC-2, AC-4)', function () {

        it('uses the real project directory for local: {} (AC-1)', function () {
            const t = run.runTarget({ local: {}, commands: { test: 'npm test' } }, '/proj', 'test');
            expect(t.cwd).to.equal('/proj');
            expect(t.command).to.equal('npm test');
        });

        it('resolves a local: string path (AC-1)', function () {
            const t = run.runTarget({ local: '/srv/app', commands: { test: 'x' } }, '/proj', 'test');
            expect(t.cwd).to.equal(path.resolve('/srv/app'));
        });

        it('expands a ~ in local: the way LocalProvider does (AC-1)', function () {
            const t = run.runTarget({ local: '~/work', commands: { test: 'x' } }, '/proj', 'test');
            expect(t.cwd).to.equal(path.join(os.homedir(), 'work'));
        });

        it('never emits a cd /<basename> prefix on local (AC-1)', function () {
            const t = run.runTarget({ local: {}, commands: { test: 'npm test' } }, '/proj', 'test');
            expect(t.command).to.not.contain('cd /');
        });

        it('uses BAKER_SHARE_DIR for docker (AC-2)', function () {
            const t = run.runTarget({ docker: 'ubuntu', commands: { test: 'x' } }, '/home/s/proj', 'test');
            expect(t.cwd).to.equal('/proj');
        });

        it('uses BAKER_SHARE_DIR for remote (AC-2)', function () {
            const t = run.runTarget({ remote: {}, commands: { test: 'x' } }, '/home/s/proj', 'test');
            expect(t.cwd).to.equal('/proj');
        });

        // AC-4: run and files: must resolve the same environment root.
        it('agrees with files.envRoot on the environment root (AC-4)', function () {
            const Files = require('../../lib/bakelets/config/files');

            const local = new Files('env', null, '');
            local.isLocal = true;
            local.localLocation = '/proj';
            expect(run.runTarget({ local: {}, commands: { c: 'x' } }, '/proj', 'c').cwd)
                .to.equal(local.envRoot);

            const remote = new Files('env', null, '');
            remote.isLocal = false;
            remote.variables = [{ BAKER_SHARE_DIR: '/proj' }];
            expect(run.runTarget({ remote: {}, commands: { c: 'x' } }, '/home/s/proj', 'c').cwd)
                .to.equal(remote.envRoot);
        });
    });

    // ---- invocation: which argv ------------------------------------------

    describe('invocation (AC-1, AC-2, AC-3)', function () {

        it('runs docker exec with -w and the container name (AC-2)', function () {
            const i = run.invocation(new DockerLocalProvider(), 'envname', '/proj', 'npm test');
            expect(i.file).to.equal('docker');
            expect(i.args).to.deep.equal(['exec', '-w', '/proj', 'envname', '/bin/bash', '-c', 'npm test']);
        });

        it('sends the command to a remote host prefixed with cd (AC-3)', function () {
            const i = run.invocation(REMOTE(), 'envname', '/proj', 'npm test');
            expect(i.file).to.equal('ssh');
            expect(i.args[i.args.length - 1]).to.equal('cd "/proj" && npm test');
        });

        it('carries the key, port, and user@host from the config (AC-3)', function () {
            const i = run.invocation(REMOTE(), 'envname', '/proj', 'x');
            expect(i.args).to.contain('/keys/id_ed25519');
            expect(i.args).to.contain('2222');
            expect(i.args).to.contain('ubuntu@10.0.0.9');
        });

        // The whole reason run builds its own ssh line rather than reusing
        // SSH_Session: -tt makes `git log` open a pager and hang.
        it('never allocates a TTY on remote', function () {
            const i = run.invocation(REMOTE(), 'envname', '/proj', 'git log');
            expect(i.args).to.not.contain('-tt');
        });

        it('passes a real cwd for local rather than a cd prefix (AC-1)', function () {
            const i = run.invocation(new LocalProvider(), 'envname', '/proj', 'npm test');
            expect(i.options.cwd).to.equal('/proj');
            expect(i.args).to.deep.equal(['-c', 'npm test']);
        });

        // cmd.exe cannot run what Baker generates — the same reason
        // makeTransport selects powershell.exe in local mode.
        it('uses PowerShell for local commands on Windows', function () {
            const real = Object.getOwnPropertyDescriptor(process, 'platform');
            Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
            try {
                const i = run.invocation(new LocalProvider(), 'envname', 'C:\\proj', 'npm test');
                expect(i.file).to.equal('powershell.exe');
                expect(i.args).to.deep.equal(['-Command', 'npm test']);
                expect(i.options.cwd).to.equal('C:\\proj');
            } finally {
                Object.defineProperty(process, 'platform', real);
            }
        });
    });

    describe('cwdProbe', function () {

        it('probes a container with test -d', function () {
            const p = run.cwdProbe(new DockerLocalProvider(), 'envname', '/proj');
            expect(p.args).to.deep.equal(['exec', 'envname', 'test', '-d', '/proj']);
        });

        it('probes a remote host with test -d', function () {
            const p = run.cwdProbe(REMOTE(), 'envname', '/proj');
            expect(p.args[p.args.length - 1]).to.equal('test -d "/proj"');
        });

        it('needs no probe for local, which reads the host filesystem', function () {
            expect(run.cwdProbe(new LocalProvider(), 'envname', '/proj')).to.equal(null);
        });
    });

    // ---- runCmdlet: orchestration ----------------------------------------

    function writeConfig(body) {
        fs.writeFileSync(path.join(tmp, 'baker.yml'), body, 'utf8');
        process.chdir(tmp);
    }

    async function indexed(name) {
        await Utils.addToIndex(name, tmp, 'local', {});
    }

    describe('runCmdlet (AC-6, AC-7, AC-8, AC-9, AC-10, AC-12)', function () {

        it('lists cmdlets and returns 1 when none is named (AC-9)', async function () {
            writeConfig('name: e1\nlocal: .\ncommands:\n  test: npm test\n');
            stubActive = true;
            expect(await run.runCmdlet({})).to.equal(1);
            expect(spawnCalls).to.have.lengthOf(0);
        });

        it('names the unknown cmdlet before listing (AC-9)', async function () {
            writeConfig('name: e2\nlocal: .\ncommands:\n  test: npm test\n');
            stubActive = true;
            const logged = captureLog(async () => {
                expect(await run.runCmdlet({ cmdlet: 'buld' })).to.equal(1);
            });
            expect(await logged).to.contain('buld');
        });

        it('states the absence of a commands: block (AC-9)', async function () {
            writeConfig('name: e3\nlocal: .\n');
            stubActive = true;
            const logged = captureLog(async () => {
                expect(await run.runCmdlet({ cmdlet: 'test' })).to.equal(1);
            });
            expect(await logged).to.contain('commands:');
        });

        it('refuses when the environment is not recorded as baked (AC-7)', async function () {
            writeConfig('name: not-baked-env\nlocal: .\ncommands:\n  test: npm test\n');
            stubActive = true;

            let error = null;
            try { await run.runCmdlet({ cmdlet: 'test' }); } catch (err) { error = err; }

            expect(error).to.be.an('error');
            expect(error.message).to.contain('baker bake');
            expect(error.message).to.contain('--force');
            expect(spawnCalls).to.have.lengthOf(0);
        });

        it('runs anyway with --force (AC-7)', async function () {
            writeConfig('name: also-not-baked\nlocal: .\ncommands:\n  test: npm test\n');
            stubActive = true;
            expect(await run.runCmdlet({ cmdlet: 'test', force: true })).to.equal(0);
            expect(spawnCalls).to.have.lengthOf(1);
        });

        it('refuses a missing working directory even with --force (AC-8)', async function () {
            writeConfig('name: dk\ndocker: ubuntu\ncommands:\n  test: npm test\n');
            stubActive = true;
            nextProbeStatus = 1;               // test -d fails

            let error = null;
            try { await run.runCmdlet({ cmdlet: 'test', force: true }); } catch (err) { error = err; }

            expect(error).to.be.an('error');
            expect(error.message).to.contain('dk');
            expect(error.message).to.contain(`/${path.basename(tmp)}`);
            expect(spawnCalls).to.have.lengthOf(0);
        });

        it('propagates a non-zero exit code (AC-6)', async function () {
            writeConfig('name: ec\nlocal: .\ncommands:\n  boom: exit 3\n');
            stubActive = true;
            nextExitCode = 3;
            expect(await run.runCmdlet({ cmdlet: 'boom', force: true })).to.equal(3);
        });

        it('streams rather than capturing (AC-5)', async function () {
            writeConfig('name: st\nlocal: .\ncommands:\n  test: npm test\n');
            stubActive = true;
            await run.runCmdlet({ cmdlet: 'test', force: true });
            expect(spawnCalls[0].opts.stdio).to.equal('inherit');
        });

        it('prints hello without touching a transport, on any provider (AC-12)', async function () {
            for (const provider of ['local: .', 'docker: ubuntu', 'remote:\n  user: u\n  ip: 1.2.3.4\n  private_key: /k']) {
                writeConfig(`name: h\n${provider}\n`);
                stubActive = true;
                expect(await run.runCmdlet({ cmdlet: 'hello' })).to.equal(0);
            }
            expect(spawnCalls).to.have.lengthOf(0);
            expect(spawnSyncCalls).to.have.lengthOf(0);
        });

        it('never calls process.exit (AC-10)', async function () {
            writeConfig('name: nx\nlocal: .\ncommands:\n  test: npm test\n');
            stubActive = true;

            const realExit = process.exit;
            let exited = false;
            process.exit = () => { exited = true; };
            try {
                await run.runCmdlet({ cmdlet: 'test', force: true });
            } finally {
                process.exit = realExit;
            }
            expect(exited).to.equal(false);
        });
    });

    // ---- gaps found in adversarial review --------------------------------

    describe('review gaps', function () {

        // The pure functions are asserted in isolation above; without this,
        // runCmdlet could compute the right invocation and then spawn
        // something else entirely and every test would still pass.
        it('spawns exactly what invocation() returns', async function () {
            writeConfig('name: wired\nlocal: .\ncommands:\n  test: npm test\n');
            stubActive = true;
            await run.runCmdlet({ cmdlet: 'test', force: true });

            const expected = run.invocation(new LocalProvider(), 'wired', tmp, 'npm test');
            expect(spawnCalls[0].file).to.equal(expected.file);
            expect(spawnCalls[0].args).to.deep.equal(expected.args);
            expect(spawnCalls[0].opts.cwd).to.equal(expected.options.cwd);
        });

        // A process killed by a signal reports a null code. Returning null
        // would make `baker run` exit 0, reporting success for a command that
        // was killed.
        it('returns 1 when the command is killed by a signal', async function () {
            writeConfig('name: sig\nlocal: .\ncommands:\n  killed: whatever\n');

            const realSpawn = child_process.spawn;
            child_process.spawn = function () {
                const fake = new EventEmitter();
                process.nextTick(() => fake.emit('close', null));
                return fake;
            };
            try {
                expect(await run.runCmdlet({ cmdlet: 'killed', force: true })).to.equal(1);
            } finally {
                child_process.spawn = realSpawn;
            }
        });

        it('returns 127 when the command cannot be spawned at all', async function () {
            writeConfig('name: nf\nlocal: .\ncommands:\n  missing: whatever\n');

            const realSpawn = child_process.spawn;
            child_process.spawn = function () {
                const fake = new EventEmitter();
                process.nextTick(() => fake.emit('error', new Error('ENOENT')));
                return fake;
            };
            try {
                expect(await run.runCmdlet({ cmdlet: 'missing', force: true })).to.equal(127);
            } finally {
                child_process.spawn = realSpawn;
            }
        });

        it('passes a multi-line command through whole', async function () {
            writeConfig('name: ml\nlocal: .\ncommands:\n  setup: |\n    echo one\n    echo two\n');
            stubActive = true;
            await run.runCmdlet({ cmdlet: 'setup', force: true });
            const script = spawnCalls[0].args[1];
            expect(script).to.contain('echo one');
            expect(script).to.contain('echo two');
        });

        it('refuses a local: path that does not exist', async function () {
            const missing = path.join(tmp, 'not-created');
            writeConfig(`name: lm\nlocal: ${missing}\ncommands:\n  test: npm test\n`);
            stubActive = true;

            let error = null;
            try { await run.runCmdlet({ cmdlet: 'test', force: true }); } catch (err) { error = err; }

            expect(error).to.be.an('error');
            expect(error.message).to.contain(missing);
            expect(spawnCalls).to.have.lengthOf(0);
        });

        // Gate 2 (health check): both of these are user-supplied input that
        // previously reached spawn unvalidated.
        it('refuses a command that is a YAML mapping, not a string', async function () {
            writeConfig('name: badcmd\nlocal: .\ncommands:\n  test:\n    script: npm test\n');
            stubActive = true;

            let error = null;
            try { await run.runCmdlet({ cmdlet: 'test', force: true }); } catch (err) { error = err; }

            expect(error).to.be.an('error');
            expect(error.message).to.contain('must be a shell command string');
            expect(error.message).to.contain('object');
            expect(spawnCalls).to.have.lengthOf(0);
        });

        it('refuses a command that is a YAML list', async function () {
            writeConfig('name: listcmd\nlocal: .\ncommands:\n  test:\n    - npm test\n');
            stubActive = true;

            let error = null;
            try { await run.runCmdlet({ cmdlet: 'test', force: true }); } catch (err) { error = err; }

            expect(error.message).to.contain('not a list');
        });

        // A missing `docker` or `ssh` binary must not be reported as "your
        // working directory is absent" — that sends people to fix the wrong
        // thing entirely.
        it('distinguishes an unrunnable probe from a missing directory', async function () {
            writeConfig('name: noprobe\ndocker: ubuntu\ncommands:\n  test: npm test\n');
            stubActive = true;

            const realSpawnSync = child_process.spawnSync;
            child_process.spawnSync = () => ({ error: { code: 'ENOENT' }, status: null });

            let error = null;
            try {
                await run.runCmdlet({ cmdlet: 'test', force: true });
            } catch (err) {
                error = err;
            } finally {
                child_process.spawnSync = realSpawnSync;
            }

            expect(error.message).to.contain('Could not check');
            expect(error.message).to.contain('ENOENT');
            expect(error.message).to.not.contain('does not exist in');
            expect(spawnCalls).to.have.lengthOf(0);
        });

        it('reports a probe killed by a signal as unreachable, not absent', async function () {
            writeConfig('name: sigprobe\ndocker: ubuntu\ncommands:\n  test: npm test\n');
            stubActive = true;

            const realSpawnSync = child_process.spawnSync;
            child_process.spawnSync = () => ({ status: null });   // signalled, no error object

            let error = null;
            try {
                await run.runCmdlet({ cmdlet: 'test', force: true });
            } catch (err) {
                error = err;
            } finally {
                child_process.spawnSync = realSpawnSync;
            }

            expect(error.message).to.contain('Could not check');
            expect(error.message).to.contain('no exit status');
        });

        it('runs an empty command string rather than silently skipping it', async function () {
            writeConfig('name: empty\nlocal: .\ncommands:\n  noop: ""\n');
            stubActive = true;
            expect(await run.runCmdlet({ cmdlet: 'noop', force: true })).to.equal(0);
            expect(spawnCalls).to.have.lengthOf(1);
        });
    });

    // ---- CLI wiring ------------------------------------------------------

    describe('builder', function () {

        function fakeYargs() {
            const calls = { examples: [], positionals: [], options: [] };
            const y = {
                example: (a, b) => { calls.examples.push([a, b]); return y; },
                positional: (name, cfg) => { calls.positionals.push([name, cfg]); return y; },
                options: (o) => { calls.options.push(o); return y; }
            };
            return { y, calls };
        }

        it('registers the cmdlet positional and the --force flag', function () {
            const { y, calls } = fakeYargs();
            run.builder(y);

            expect(calls.positionals.map((p) => p[0])).to.deep.equal(['cmdlet']);
            expect(calls.options[0]).to.have.property('force');
            expect(calls.options[0].force.alias).to.equal('f');
            expect(calls.options[0].force.type).to.equal('boolean');
        });

        it('documents both running and listing', function () {
            const { y, calls } = fakeYargs();
            run.builder(y);
            expect(calls.examples).to.have.lengthOf(2);
        });
    });

    describe('handler (AC-10 boundary)', function () {

        // The handler is the ONLY place process.exit is called; runCmdlet
        // returns. Stubbing exit is what makes that boundary assertable.
        it('exits with the code runCmdlet returns', async function () {
            writeConfig('name: hx\nlocal: .\ncommands:\n  boom: exit 3\n');
            stubActive = true;
            nextExitCode = 3;

            const realExit = process.exit;
            let code = null;
            process.exit = (c) => { code = c; };
            try {
                await run.handler({ cmdlet: 'boom', force: true });
            } finally {
                process.exit = realExit;
            }
            expect(code).to.equal(3);
        });

        it('reports the error and exits 1 when runCmdlet throws', async function () {
            // No baker.yml in cwd → chooseProvider throws.
            process.chdir(tmp);
            stubActive = true;

            const realExit = process.exit;
            let code = null;
            process.exit = (c) => { code = c; };
            const logged = captureLog(async () => {
                await run.handler({ cmdlet: 'anything' });
            });
            try { await logged; } finally { process.exit = realExit; }

            expect(code).to.equal(1);
            expect(spawnCalls).to.have.lengthOf(0);
        });
    });

    // ---- the one real execution ------------------------------------------

    describe('real execution (AC-6)', function () {

        // Deliberately NOT stubbed: asserts an exit code genuinely propagates
        // rather than being read back off a fake. No TTY and no inherited
        // stdin — it asserts a returned number, nothing more.
        it('really returns the command exit code, and the suite survives', async function () {
            writeConfig('name: real-exit\nlocal: .\ncommands:\n  boom: exit 3\n');
            const code = await run.runCmdlet({ cmdlet: 'boom', force: true });
            expect(code).to.equal(3);
        });

        it('really returns 0 for a command that succeeds', async function () {
            writeConfig('name: real-ok\nlocal: .\ncommands:\n  ok: exit 0\n');
            expect(await run.runCmdlet({ cmdlet: 'ok', force: true })).to.equal(0);
        });
    });
});

// Collects console.log output produced while fn runs.
function captureLog(fn) {
    const real = console.log;
    let out = '';
    console.log = (...args) => { out += args.join(' ') + '\n'; };
    return Promise.resolve(fn()).then(() => { console.log = real; return out; },
                                      (e) => { console.log = real; throw e; });
}
