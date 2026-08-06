const child_process = require('child_process');
const crypto = require('crypto');
const fs     = require('fs-extra');
const os     = require('os');
const path   = require('path');
const chai   = require('chai');
const expect = chai.expect;

const Preflight = require('../../lib/modules/preflight');
const resolve   = require('../../lib/bakelets/resolve');

const BAKELETS_PATH = path.join(__dirname, '../../lib/bakelets');
const REMOTES_PATH  = path.join(__dirname, '../../remotes');

const WINDOWS = { os: 'windows', manager: 'choco', shell: 'powershell', family: 'nt' };
const LINUX   = { os: 'linux', manager: 'apt', shell: 'sh', family: 'debian' };
const MACOS   = { os: 'macos', manager: 'brew', shell: 'sh', family: 'darwin' };

function fake(name, props) {
    return Object.assign({ bakeletName: name, requiresElevation: false, requiresAnsible: false }, props);
}

// Recursive hash of a directory tree: relative paths plus contents. Used to
// prove a gated bake changed nothing at all (AC-18).
async function hashTree(root) {
    const hash = crypto.createHash('sha256');
    const walk = async (dir, prefix) => {
        const entries = (await fs.readdir(dir)).sort();
        for (const entry of entries) {
            const full = path.join(dir, entry);
            const rel = path.join(prefix, entry);
            const stat = await fs.stat(full);
            hash.update(rel);
            if (stat.isDirectory()) await walk(full, rel);
            else hash.update(await fs.readFile(full));
        }
    };
    await walk(root, '');
    return hash.digest('hex');
}

describe('bake pre-flight gate', function() {

    describe('Ansible support (AC-15)', function() {

        it('allows playbook-backed bakelets on a Linux target', function() {
            expect(() => Preflight.checkAnsible([fake('python', { requiresAnsible: true })], 'linux'))
                .to.not.throw();
        });

        it('refuses them on Windows', function() {
            expect(() => Preflight.checkAnsible([fake('python', { requiresAnsible: true })], 'windows'))
                .to.throw(/does not run on windows/);
        });

        it('refuses them on macOS', function() {
            expect(() => Preflight.checkAnsible([fake('mysql', { requiresAnsible: true })], 'macos'))
                .to.throw(/does not run on macos/);
        });

        it('names every offending bakelet', function() {
            let error = null;
            try {
                Preflight.checkAnsible([
                    fake('python', { requiresAnsible: true }),
                    fake('opencode'),
                    fake('mysql', { requiresAnsible: true })
                ], 'windows');
            } catch (err) { error = err; }

            expect(error.message).to.contain('python');
            expect(error.message).to.contain('mysql');
            expect(error.message).to.not.contain('opencode');
        });

        it('points at docker: and remote: and says nothing changed', function() {
            let error = null;
            try {
                Preflight.checkAnsible([fake('python', { requiresAnsible: true })], 'windows');
            } catch (err) { error = err; }

            expect(error.message).to.contain('docker:');
            expect(error.message).to.contain('remote:');
            expect(error.message).to.contain('Nothing on your machine has been changed');
        });

        it('allows an all-portable config anywhere', function() {
            ['linux', 'macos', 'windows'].forEach((targetOs) => {
                expect(() => Preflight.checkAnsible([fake('opencode'), fake('env')], targetOs), targetOs)
                    .to.not.throw();
            });
        });
    });

    describe('osOf', function() {
        it('maps Node platform strings to an OS', function() {
            expect(Preflight.osOf('win32')).to.equal('windows');
            expect(Preflight.osOf('darwin')).to.equal('macos');
            expect(Preflight.osOf('linux')).to.equal('linux');
            expect(Preflight.osOf('freebsd')).to.equal('linux');
        });
    });

    describe('elevation (AC-16, AC-17, AC-19)', function() {
        const needy = [fake('system', { requiresElevation: true })];

        it('blocks on Windows without Administrator (AC-16)', function() {
            const denied = () => { throw new Error('not admin'); };
            expect(() => Preflight.checkElevation(needy, WINDOWS, { exec: denied }))
                .to.throw(/Administrator/);
        });

        it('names the bakelets that triggered it (AC-16)', function() {
            const denied = () => { throw new Error('not admin'); };
            let error = null;
            try { Preflight.checkElevation(needy, WINDOWS, { exec: denied }); } catch (err) { error = err; }
            expect(error.message).to.contain('system');
        });

        it('gives three concrete steps and promises nothing changed (AC-16)', function() {
            const denied = () => { throw new Error('not admin'); };
            let error = null;
            try { Preflight.checkElevation(needy, WINDOWS, { exec: denied }); } catch (err) { error = err; }

            expect(error.message).to.contain('Run as Administrator');
            expect(error.message).to.contain('Nothing on your machine has been changed');
        });

        it('proceeds silently on Windows WITH Administrator', function() {
            const admin = () => 'True\n';
            expect(Preflight.checkElevation(needy, WINDOWS, { exec: admin })).to.deep.equal([]);
        });

        it('treats a non-True answer from Windows as not elevated', function() {
            const notAdmin = () => 'False\n';
            expect(() => Preflight.checkElevation(needy, WINDOWS, { exec: notAdmin }))
                .to.throw(/Administrator/);
        });

        it('warns but proceeds on Unix when sudo exists (AC-17)', function() {
            const hasSudo = () => '/usr/bin/sudo\n';
            const warnings = Preflight.checkElevation(needy, LINUX, { exec: hasSudo });
            expect(warnings).to.have.lengthOf(1);
            expect(warnings[0]).to.contain('sudo password');
            expect(warnings[0]).to.contain('system');
        });

        it('warns rather than blocking even when sudo is absent on Unix (AC-17)', function() {
            // The user can still answer a prompt; unlike choco, nothing here
            // requires restarting the shell.
            const noSudo = () => { throw new Error('no sudo'); };
            const warnings = Preflight.checkElevation(needy, LINUX, { exec: noSudo });
            expect(warnings).to.have.lengthOf(1);
        });

        it('does not gate a config needing no elevation (AC-19)', function() {
            const denied = () => { throw new Error('not admin'); };
            expect(Preflight.checkElevation([fake('opencode'), fake('env')], WINDOWS, { exec: denied }))
                .to.deep.equal([]);
        });

        it('does not gate brew, which needs no elevation (AC-19)', function() {
            expect(Preflight.checkElevation([fake('jq')], MACOS, { exec: () => '' })).to.deep.equal([]);
        });
    });

    describe('nothing is written when the gate fires (AC-18)', function() {
        let bakeDir;
        let origExecSync;
        let descriptor;

        beforeEach(async function() {
            bakeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'baker-preflight-'));
            await fs.outputFile(path.join(bakeDir, 'existing.txt'), 'untouched\n');
            await fs.outputFile(path.join(bakeDir, 'nested', 'deep.txt'), 'also untouched\n');
            origExecSync = child_process.execSync;
            descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
        });

        afterEach(async function() {
            child_process.execSync = origExecSync;
            Object.defineProperty(process, 'platform', descriptor);
            await fs.remove(bakeDir).catch(() => {});
        });

        it('leaves the target tree byte-identical after an elevation refusal', async function() {
            Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
            // Every exec fails: the admin probe reports not-elevated, and any
            // bakelet that slipped through would fail loudly rather than write.
            child_process.execSync = () => { throw new Error('denied'); };

            const before = await hashTree(bakeDir);

            let error = null;
            try {
                await resolve.resolveBakelet(
                    BAKELETS_PATH, REMOTES_PATH,
                    { name: 'gated', local: bakeDir, packages: ['jq'] },
                    bakeDir, false, bakeDir
                );
            } catch (err) { error = err; }

            expect(String(error)).to.contain('Administrator');
            expect(await hashTree(bakeDir)).to.equal(before);
        });

        it('leaves the target tree byte-identical after an Ansible refusal', async function() {
            Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
            child_process.execSync = () => '';

            const before = await hashTree(bakeDir);

            let error = null;
            try {
                await resolve.resolveBakelet(
                    BAKELETS_PATH, REMOTES_PATH,
                    { name: 'gated-ansible', local: bakeDir, lang: ['python'] },
                    bakeDir, false, bakeDir
                );
            } catch (err) { error = err; }

            expect(String(error)).to.contain('does not run on windows');
            expect(await hashTree(bakeDir)).to.equal(before);
        });

        it('runs the bake when the gate passes', async function() {
            const issued = [];
            child_process.execSync = (cmd) => {
                issued.push(cmd);
                if (cmd.includes('/etc/os-release')) return 'ID=ubuntu\n';
                return '/usr/bin/sudo\n';
            };

            await resolve.resolveBakelet(
                BAKELETS_PATH, REMOTES_PATH,
                { name: 'ungated', local: bakeDir, packages: ['jq'] },
                bakeDir, false, bakeDir
            );

            expect(issued.some((c) => c.includes('apt-get install -y jq'))).to.equal(true);
        });
    });

    describe('gate ordering', function() {

        it('refuses before any bakelet is loaded or installed', async function() {
            const bakeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'baker-order-'));
            const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
            Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
            const origExecSync = child_process.execSync;
            const issued = [];
            child_process.execSync = (cmd) => { issued.push(cmd); throw new Error('denied'); };

            try {
                await resolve.resolveBakelet(
                    BAKELETS_PATH, REMOTES_PATH,
                    { name: 'order', local: bakeDir, packages: ['jq'] },
                    bakeDir, false, bakeDir
                );
            } catch (err) { /* expected */ } finally {
                child_process.execSync = origExecSync;
                Object.defineProperty(process, 'platform', descriptor);
                await fs.remove(bakeDir).catch(() => {});
            }

            // The only command attempted is the Administrator probe. No install
            // command was ever constructed, let alone run.
            expect(issued.some((c) => c.includes('choco'))).to.equal(false);
            expect(issued.some((c) => c.includes('IsInRole'))).to.equal(true);
        });
    });
});
