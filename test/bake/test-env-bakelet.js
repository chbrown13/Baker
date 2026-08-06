const child_process = require('child_process');
const fs     = require('fs-extra');
const os     = require('os');
const path   = require('path');
const chai   = require('chai');
const expect = chai.expect;

const Env = require('../../lib/bakelets/env/env');

const LINUX = { os: 'linux', manager: 'apt', shell: 'sh', family: 'debian' };
const WINDOWS = { os: 'windows', manager: 'choco', shell: 'powershell', family: 'nt' };

// Runs load()+install() with a recorder in place of this.exec and returns the
// commands issued, mirroring the agentic-tool test harness.
async function run(entries, platform) {
    const bakelet = new Env('testenv', null, '');
    bakelet.platform = platform;
    const calls = [];
    bakelet.exec = async (cmd) => { calls.push(cmd); };
    await bakelet.load({ env: entries }, []);
    await bakelet.install();
    return calls;
}

describe('env: bakelet (user environment)', function() {

    describe('contract', function() {

        it('needs the platform resolved', function() {
            expect(new Env('testenv', null, '').needsPlatform).to.equal(true);
        });

        it('requires no elevation, so a per-unit bake never prompts (AC-25)', function() {
            expect(new Env('testenv', null, '').requiresElevation).to.equal(false);
        });

        it('issues nothing at all for an empty env list', async function() {
            expect(await run([], LINUX)).to.deep.equal([]);
        });

        it('issues nothing when the entry has no env key at all', async function() {
            const bakelet = new Env('testenv', null, '');
            bakelet.platform = LINUX;
            const calls = [];
            bakelet.exec = async (cmd) => { calls.push(cmd); };
            await bakelet.load({}, []);
            await bakelet.install();
            expect(calls).to.deep.equal([]);
        });

        it('stringifies a non-string YAML value', async function() {
            // `PORT: 8080` parses as a number, and `DEBUG: true` as a boolean.
            const calls = await run([{ PORT: 8080 }, { DEBUG: true }], LINUX);
            expect(calls.join('\n')).to.contain('export PORT="8080"');
            expect(calls.join('\n')).to.contain('export DEBUG="true"');
        });

        it('reads the list-of-single-key-maps shape the resolver passes', async function() {
            const calls = await run([{ FOO: 'bar' }, { BAZ: 'qux' }], LINUX);
            expect(calls.join('\n')).to.contain('export FOO="bar"');
            expect(calls.join('\n')).to.contain('export BAZ="qux"');
        });
    });

    describe('POSIX', function() {

        it('never writes /etc/environment (AC-25)', async function() {
            const calls = await run([{ FOO: 'bar' }], LINUX);
            expect(calls.join('\n')).to.not.contain('/etc/environment');
        });

        it('needs no sudo anywhere in its commands (AC-25)', async function() {
            const calls = await run([{ FOO: 'bar' }], LINUX);
            expect(calls.join('\n')).to.not.match(/\bsudo\b/);
        });

        it('writes the exports into a Baker-owned file', async function() {
            const calls = await run([{ FOO: 'bar' }], LINUX);
            expect(calls.join('\n')).to.contain('~/.baker/env.sh');
        });

        it('rewrites that file whole, so a removed key disappears', async function() {
            // `>` not `>>`: re-baking with a shorter list must shrink the file.
            const calls = await run([{ FOO: 'bar' }], LINUX);
            expect(calls.some((c) => c.includes('cat > ~/.baker/env.sh'))).to.equal(true);
            expect(calls.some((c) => c.includes('>> ~/.baker/env.sh'))).to.equal(false);
        });

        it('adds the profile source line only when it is absent', async function() {
            const calls = await run([{ FOO: 'bar' }], LINUX);
            const sourceLine = calls.find((c) => c.includes('.profile'));
            expect(sourceLine).to.contain('grep -q');
            expect(sourceLine).to.contain('||');
        });

        it('escapes a double quote in a value', async function() {
            const calls = await run([{ FOO: 'a"b' }], LINUX);
            expect(calls.join('\n')).to.contain('export FOO="a\\"b"');
        });

        it('escapes a backslash in a value', async function() {
            const calls = await run([{ FOO: 'a\\b' }], LINUX);
            expect(calls.join('\n')).to.contain('export FOO="a\\\\b"');
        });

        it('escapes a $ so it survives being sourced, not just written', async function() {
            // Quoting the heredoc delimiter only stops expansion on the way IN.
            // The assignment is double-quoted, so an unescaped $HOME would still
            // expand when the profile sources env.sh.
            const calls = await run([{ FOO: '$HOME' }], LINUX);
            const write = calls.find((c) => c.includes('cat >'));
            expect(write).to.contain('<<"BAKER_ENV"');
            expect(write).to.contain('export FOO="\\$HOME"');
        });

        it('escapes a backtick so it cannot run a command substitution', async function() {
            const calls = await run([{ FOO: '`id`' }], LINUX);
            expect(calls.join('\n')).to.contain('export FOO="\\`id\\`"');
        });

        it('uses no single quotes, so docker-local wrapping survives (AC-11)', async function() {
            const calls = await run([{ FOO: 'bar' }], LINUX);
            calls.forEach((cmd) => expect(cmd).to.not.contain("'"));
        });
    });

    describe('Windows', function() {

        it('sets the variable at User scope (AC-25)', async function() {
            const calls = await run([{ FOO: 'bar' }], WINDOWS);
            expect(calls).to.deep.equal([
                '[Environment]::SetEnvironmentVariable("FOO", "bar", "User")'
            ]);
        });

        it('emits one call per variable', async function() {
            const calls = await run([{ FOO: 'a' }, { BAR: 'b' }], WINDOWS);
            expect(calls).to.have.lengthOf(2);
        });

        it('uses no POSIX construct', async function() {
            const calls = await run([{ FOO: 'bar' }], WINDOWS);
            expect(calls.join('\n')).to.not.contain('export ');
            expect(calls.join('\n')).to.not.contain('.profile');
        });

        it('escapes a double quote with a backtick', async function() {
            const calls = await run([{ FOO: 'a"b' }], WINDOWS);
            expect(calls[0]).to.contain('a`"b');
        });

        it('escapes a literal backtick', async function() {
            const calls = await run([{ FOO: 'a`b' }], WINDOWS);
            expect(calls[0]).to.contain('a``b');
        });
    });

    // The POSIX commands are strings until something runs them. These execute
    // them against a real shell in a throwaway HOME, which is the only way to
    // know the heredoc quoting and the grep guard actually work.
    describe('POSIX commands really run (AC-25)', function() {
        let home;

        // Runs the bakelet's own commands through /bin/sh with HOME redirected.
        async function apply(entries) {
            const bakelet = new Env('testenv', null, '');
            bakelet.platform = LINUX;
            await bakelet.load({ env: entries }, []);
            bakelet.installCommands().forEach((cmd) => {
                child_process.execSync(cmd, { env: { HOME: home, PATH: process.env.PATH }, shell: '/bin/sh' });
            });
        }

        beforeEach(async function() {
            home = await fs.mkdtemp(path.join(os.tmpdir(), 'baker-env-'));
            await fs.writeFile(path.join(home, '.profile'), '# existing profile\n');
        });

        afterEach(async function() {
            await fs.remove(home).catch(() => {});
        });

        it('makes the variable visible to a new shell', async function() {
            await apply([{ FOO: 'bar' }]);

            const out = child_process.execSync('. ~/.profile; echo $FOO', {
                env: { HOME: home, PATH: process.env.PATH }, shell: '/bin/sh', encoding: 'utf8'
            });
            expect(out.trim()).to.equal('bar');
        });

        it('leaves the existing profile content intact', async function() {
            await apply([{ FOO: 'bar' }]);
            const profile = await fs.readFile(path.join(home, '.profile'), 'utf8');
            expect(profile).to.contain('# existing profile');
        });

        it('adds the source line exactly once across repeated bakes', async function() {
            await apply([{ FOO: 'bar' }]);
            await apply([{ FOO: 'bar' }]);
            await apply([{ FOO: 'bar' }]);

            const profile = await fs.readFile(path.join(home, '.profile'), 'utf8');
            const occurrences = profile.split('baker/env.sh').length - 1;
            expect(occurrences).to.equal(1);
        });

        it('converges: a key dropped from baker.yml stops being set', async function() {
            await apply([{ FOO: 'bar' }, { GONE: 'yes' }]);
            await apply([{ FOO: 'bar' }]);

            const out = child_process.execSync('. ~/.profile; echo [$GONE][$FOO]', {
                env: { HOME: home, PATH: process.env.PATH }, shell: '/bin/sh', encoding: 'utf8'
            });
            expect(out.trim()).to.equal('[][bar]');
        });

        it('round-trips a value containing quotes, backslashes, and a dollar sign', async function() {
            await apply([{ TRICKY: 'a"b\\c$HOME' }]);

            const out = child_process.execSync('. ~/.profile; printf %s "$TRICKY"', {
                env: { HOME: home, PATH: process.env.PATH }, shell: '/bin/sh', encoding: 'utf8'
            });
            expect(out).to.equal('a"b\\c$HOME');
        });

        it('round-trips a value with spaces', async function() {
            await apply([{ SPACED: 'one two  three' }]);

            const out = child_process.execSync('. ~/.profile; printf %s "$SPACED"', {
                env: { HOME: home, PATH: process.env.PATH }, shell: '/bin/sh', encoding: 'utf8'
            });
            expect(out).to.equal('one two  three');
        });

        it('never creates or touches /etc/environment', async function() {
            await apply([{ FOO: 'bar' }]);
            expect(await fs.pathExists(path.join(home, 'etc'))).to.equal(false);
        });
    });
});
