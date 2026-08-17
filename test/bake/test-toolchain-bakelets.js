const chai = require('chai');
const expect = chai.expect;

const Cpp    = require('../../lib/bakelets/tools/cpp');
const Python = require('../../lib/bakelets/tools/python');
const Pip    = require('../../lib/bakelets/tools/pip');
const Npm    = require('../../lib/bakelets/tools/npm');
const Git    = require('../../lib/bakelets/tools/git');

const LINUX   = { os: 'linux',   manager: 'apt',    shell: 'sh',         family: 'debian', sudo: true };
const FEDORA  = { os: 'linux',   manager: 'dnf',    shell: 'sh',         family: 'rhel',   sudo: true };
const ARCH    = { os: 'linux',   manager: 'pacman', shell: 'sh',         family: 'arch',   sudo: true };
const ALPINE  = { os: 'linux',   manager: 'apk',    shell: 'sh',         family: 'alpine', sudo: false };
const MACOS   = { os: 'macos',   manager: 'brew',   shell: 'sh',         family: 'darwin', sudo: false };
const WINDOWS = { os: 'windows', manager: 'choco',  shell: 'powershell', family: 'nt',     sudo: false };

const ALL = [LINUX, FEDORA, ARCH, ALPINE, MACOS, WINDOWS];

// Runs load()+install() with a recorder in place of this.exec, the same shape
// test-agentic-tool-bakelets.js uses.
// Added by Claude Code (claude-opus-5[1m])
async function run(Klass, entry, platform) {
    const bakelet = new Klass('env', null, '');
    bakelet.platform = platform;
    const calls = [];
    bakelet.exec = async (cmd) => { calls.push(cmd); };
    await bakelet.load(entry, []);
    await bakelet.install();
    return { bakelet, calls };
}

describe('toolchain bakelets', function() {

    describe('tools: cpp', function() {

        it('installs a compiler on every supported manager', async function() {
            for (const platform of ALL) {
                const { calls } = await run(Cpp, 'cpp', platform);
                expect(calls, platform.manager).to.have.lengthOf(1);
                expect(calls[0], platform.manager).to.contain('g++');   // presence guard
            }
        });

        it('uses each manager its own package name', async function() {
            const expected = [
                [LINUX,   'build-essential'],
                [FEDORA,  'gcc-c++'],
                [ARCH,    'base-devel'],
                [ALPINE,  'build-base'],
                [MACOS,   'brew install gcc'],
                [WINDOWS, 'mingw'],
            ];
            for (const [platform, needle] of expected) {
                const { calls } = await run(Cpp, 'cpp', platform);
                expect(calls[0], platform.manager).to.contain(needle);
            }
        });

        it('guards on g++ so a second bake is a no-op', async function() {
            const { calls } = await run(Cpp, 'cpp', LINUX);
            expect(calls[0]).to.match(/^command -v g\+\+ >\/dev\/null 2>&1 \|\| \(/);
        });

        it('uses a PowerShell guard on Windows', async function() {
            const { calls } = await run(Cpp, 'cpp', WINDOWS);
            expect(calls[0]).to.contain('Get-Command g++');
            expect(calls[0]).to.not.contain('||');
        });

        it('never sudos under Homebrew', async function() {
            const { calls } = await run(Cpp, 'cpp', MACOS);
            expect(calls[0]).to.not.contain('sudo');
        });

        it('needs elevation on a sudo Linux target but not on macOS', async function() {
            const linux = new Cpp('env', null, '');
            linux.platform = LINUX;
            expect(linux.requiresElevation).to.equal(true);

            const mac = new Cpp('env', null, '');
            mac.platform = MACOS;
            expect(mac.requiresElevation).to.equal(false);
        });
    });

    describe('tools: python', function() {

        it('checks python3 everywhere except Windows, which has only python', async function() {
            const posix = new Python('env', null, '');
            posix.platform = LINUX;
            expect(posix.binName).to.equal('python3');

            const win = new Python('env', null, '');
            win.platform = WINDOWS;
            expect(win.binName).to.equal('python');
        });

        it('installs pip alongside the interpreter on every manager', async function() {
            // brew and choco bundle pip; the rest package it separately.
            const separate = [[LINUX, 'python3-pip'], [FEDORA, 'python3-pip'],
                              [ARCH, 'python-pip'], [ALPINE, 'py3-pip']];
            for (const [platform, needle] of separate) {
                const { calls } = await run(Python, 'python', platform);
                expect(calls[0], platform.manager).to.contain(needle);
            }
        });

        it('uses the Arch spelling, which drops the 3', async function() {
            const { calls } = await run(Python, 'python', ARCH);
            expect(calls[0]).to.contain('pacman -S --noconfirm python python-pip');
        });

        it('installs on every supported manager', async function() {
            for (const platform of ALL) {
                const { calls } = await run(Python, 'python', platform);
                expect(calls, platform.manager).to.have.lengthOf(1);
            }
        });
    });

    describe('tools: pip', function() {

        it('accepts the string shorthand', async function() {
            const { calls } = await run(Pip, { pip: 'jsonschema' }, LINUX);
            expect(calls).to.have.lengthOf(1);
            expect(calls[0]).to.contain('jsonschema');
        });

        it('accepts a packages list', async function() {
            const { calls } = await run(Pip, { pip: { packages: ['jsonschema', 'pytest'] } }, LINUX);
            expect(calls[0]).to.contain('jsonschema pytest');
        });

        it('accepts a bare array', async function() {
            const { calls } = await run(Pip, { pip: ['jsonschema'] }, LINUX);
            expect(calls[0]).to.contain('jsonschema');
        });

        it('installs --user, so it needs no elevation anywhere', async function() {
            const { calls, bakelet } = await run(Pip, { pip: 'jsonschema' }, WINDOWS);
            expect(calls[0]).to.contain('--user');
            expect(calls[0]).to.not.contain('sudo');
            expect(bakelet.requiresElevation).to.equal(false);
        });

        // PEP 668 makes plain `pip install --user` fail outright on Debian 12+,
        // Ubuntu 23.04+, recent Fedora, and Homebrew Python.
        it('falls back to --break-system-packages when PEP 668 blocks the install', async function() {
            const { calls } = await run(Pip, { pip: 'jsonschema' }, LINUX);
            expect(calls[0]).to.contain('||');
            expect(calls[0]).to.contain('--break-system-packages');
        });

        it('expresses the same fallback without || on PowerShell', async function() {
            const { calls } = await run(Pip, { pip: 'jsonschema' }, WINDOWS);
            expect(calls[0]).to.not.contain('||');
            expect(calls[0]).to.contain('$LASTEXITCODE');
            expect(calls[0]).to.contain('--break-system-packages');
        });

        it('uses python on Windows and python3 elsewhere', async function() {
            const { calls: win } = await run(Pip, { pip: 'jsonschema' }, WINDOWS);
            expect(win[0].startsWith('python -m pip')).to.equal(true);

            const { calls: posix } = await run(Pip, { pip: 'jsonschema' }, LINUX);
            expect(posix[0].startsWith('python3 -m pip')).to.equal(true);
        });

        it('declares that it needs the platform despite having no command table', function() {
            const bakelet = new Pip('env', null, '');
            expect(bakelet.commands).to.deep.equal({});
            expect(bakelet.needsPlatform).to.equal(true);
        });

        it('refuses an entry with no packages, naming both accepted forms', async function() {
            const bakelet = new Pip('env', null, '');
            bakelet.platform = LINUX;
            await bakelet.load({ pip: null }, []);

            let error = null;
            try { await bakelet.install(); } catch (err) { error = err; }

            expect(error).to.be.an('error');
            expect(error.message).to.contain('pip: jsonschema');
            expect(error.message).to.contain('packages:');
        });

        // docker-local wraps commands as `bash -c '<cmd>'`.
        it('contains no single quotes on either shell', async function() {
            for (const platform of [LINUX, WINDOWS]) {
                const { calls } = await run(Pip, { pip: 'jsonschema' }, platform);
                expect(calls[0], platform.os).to.not.contain("'");
            }
        });
    });

    describe('tools: npm', function() {

        it('accepts the string shorthand', async function() {
            const { calls } = await run(Npm, { npm: 'typescript' }, LINUX);
            expect(calls).to.have.lengthOf(1);
            expect(calls[0]).to.equal('npm install -g typescript');
        });

        it('accepts a packages list', async function() {
            const { calls } = await run(Npm, { npm: { packages: ['typescript', 'eslint'] } }, LINUX);
            expect(calls[0]).to.contain('typescript eslint');
        });

        it('accepts a bare array', async function() {
            const { calls } = await run(Npm, { npm: ['typescript'] }, LINUX);
            expect(calls[0]).to.contain('typescript');
        });

        // The mirror of pip's --user answer: a different mechanism, same result.
        it('needs no elevation and never prefixes sudo', async function() {
            for (const platform of ALL) {
                const { calls, bakelet } = await run(Npm, { npm: 'typescript' }, platform);
                expect(bakelet.requiresElevation, platform.manager).to.equal(false);
                expect(calls[0], platform.manager).to.not.contain('sudo');
            }
        });

        // Where pip must know the OS to pick python vs python3, npm need not:
        // the binary is `npm` on all seven targets.
        it('issues one identical command on every platform', async function() {
            const commands = new Set();
            for (const platform of ALL) {
                const { calls } = await run(Npm, { npm: 'typescript' }, platform);
                commands.add(calls[0]);
            }
            expect(Array.from(commands)).to.deep.equal(['npm install -g typescript']);
        });

        it('asks for no platform, unlike pip', function() {
            const bakelet = new Npm('env', null, '');
            expect(bakelet.commands).to.deep.equal({});
            expect(bakelet.needsPlatform).to.equal(false);
        });

        it('refuses an entry with no packages, naming both accepted forms', async function() {
            const bakelet = new Npm('env', null, '');
            bakelet.platform = LINUX;
            await bakelet.load({ npm: null }, []);

            let error = null;
            try { await bakelet.install(); } catch (err) { error = err; }

            expect(error).to.be.an('error');
            expect(error.message).to.contain('npm: typescript');
            expect(error.message).to.contain('packages:');
        });

        it('contains no single quotes on either shell', async function() {
            for (const platform of [LINUX, WINDOWS]) {
                const { calls } = await run(Npm, { npm: 'typescript' }, platform);
                expect(calls[0], platform.os).to.not.contain("'");
            }
        });
    });

    describe('tools: git', function() {

        it('installs the git package on every supported manager', async function() {
            for (const platform of ALL) {
                const { calls } = await run(Git, 'git', platform);
                expect(calls, platform.manager).to.have.lengthOf(1);
                expect(calls[0], platform.manager).to.match(/\bgit\b/);
            }
        });

        it('guards the install with a presence check', async function() {
            const { calls } = await run(Git, 'git', LINUX);
            expect(calls[0]).to.contain('command -v git');
            expect(calls[0]).to.contain('sudo apt-get install -y git');
        });

        it('drops the sudo prefix when the target is root', async function() {
            const ROOT = { os: 'linux', manager: 'apt', shell: 'sh', family: 'debian', sudo: false };
            const { calls } = await run(Git, 'git', ROOT);
            expect(calls[0]).to.not.match(/\bsudo\b/);
        });

        it('uses PowerShell constructs on Windows', async function() {
            const { calls } = await run(Git, 'git', WINDOWS);
            expect(calls[0]).to.contain('Get-Command git');
            expect(calls[0]).to.contain('choco install -y git');
            expect(calls[0]).to.not.contain('||');
        });

        // /usr/bin/git exists on a Mac that has never installed the Command Line
        // Tools, and running it opens a GUI dialog. A bare `command -v` check
        // would pass there and skip the install.
        it('does not accept the Xcode Command Line Tools shim on macOS', async function() {
            const { calls } = await run(Git, 'git', MACOS);
            expect(calls[0]).to.contain('/usr/bin/git');
            expect(calls[0]).to.contain('xcode-select -p');
            expect(calls[0]).to.contain('brew install git');
        });

        it('applies the shim test on macOS only', async function() {
            for (const platform of [LINUX, FEDORA, ARCH, ALPINE, WINDOWS]) {
                const { calls } = await run(Git, 'git', platform);
                expect(calls[0], platform.manager).to.not.contain('xcode-select');
            }
        });

        it('keeps the macOS check free of single quotes', async function() {
            const { calls } = await run(Git, 'git', MACOS);
            expect(calls[0]).to.not.contain("'");
        });

        it('offers an inverse that defaults to No and says what breaks', async function() {
            const bakelet = new Git('env', null, '');
            bakelet.platform = LINUX;
            bakelet.setBakeletName('git');
            bakelet.execCapture = async () => 'present';

            const plan = await bakelet.plan();
            expect(plan).to.have.lengthOf(1);
            expect(plan[0].kind).to.equal('exec');
            expect(plan[0].default).to.equal(false);
            expect(plan[0].command).to.contain('apt-get remove -y git');
            expect(plan[0].prompt).to.contain('baker cleanup');
        });

        it('plans nothing when git is not installed', async function() {
            const bakelet = new Git('env', null, '');
            bakelet.platform = LINUX;
            bakelet.setBakeletName('git');
            bakelet.execCapture = async () => { throw new Error('not found'); };

            const plan = await bakelet.plan();
            expect(plan[0].kind).to.equal('none');
            expect(plan[0].reason).to.contain('not installed');
        });
    });
});
