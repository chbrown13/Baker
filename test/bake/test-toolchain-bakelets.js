const chai = require('chai');
const expect = chai.expect;

const Cpp    = require('../../lib/bakelets/tools/cpp');
const Python = require('../../lib/bakelets/tools/python');
const Pip    = require('../../lib/bakelets/tools/pip');

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
});
