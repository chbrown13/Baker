const child_process = require('child_process');
const fs     = require('fs-extra');
const os     = require('os');
const path   = require('path');
const chai   = require('chai');
const expect = chai.expect;

const System  = require('../../lib/bakelets/packages/system');
const resolve = require('../../lib/bakelets/resolve');

const BAKELETS_PATH = path.join(__dirname, '../../lib/bakelets');
const REMOTES_PATH  = path.join(__dirname, '../../remotes');

const PLATFORMS = {
    apt:    { os: 'linux',   manager: 'apt',    shell: 'sh',         family: 'debian', sudo: true },
    dnf:    { os: 'linux',   manager: 'dnf',    shell: 'sh',         family: 'rhel',   sudo: true },
    pacman: { os: 'linux',   manager: 'pacman', shell: 'sh',         family: 'arch',   sudo: true },
    zypper: { os: 'linux',   manager: 'zypper', shell: 'sh',         family: 'suse',   sudo: true },
    apk:    { os: 'linux',   manager: 'apk',    shell: 'sh',         family: 'alpine', sudo: true },
    brew:   { os: 'macos',   manager: 'brew',   shell: 'sh',         family: 'darwin', sudo: false },
    choco:  { os: 'windows', manager: 'choco',  shell: 'powershell', family: 'nt',     sudo: false },
    // A container: root already, so no sudo prefix and no elevation gate.
    root:   { os: 'linux',   manager: 'apt',    shell: 'sh',         family: 'debian', sudo: false }
};

async function run(entries, manager) {
    const bakelet = new System('testenv', null, '');
    bakelet.platform = PLATFORMS[manager];
    bakelet.setBakeletName('system');
    const calls = [];
    bakelet.exec = async (cmd) => { calls.push(cmd); };
    await bakelet.load(entries, []);
    await bakelet.install();
    return calls;
}

async function loadOnly(entries, manager) {
    const bakelet = new System('testenv', null, '');
    bakelet.platform = PLATFORMS[manager];
    bakelet.setBakeletName('system');
    await bakelet.load(entries, []);
    return bakelet;
}

describe('packages: schema', function() {

    describe('bare list on every manager (AC-20)', function() {
        const expected = {
            apt:    'sudo apt-get install -y jq tmux',
            dnf:    'sudo dnf install -y jq tmux',
            pacman: 'sudo pacman -S --noconfirm jq tmux',
            zypper: 'sudo zypper --non-interactive install jq tmux',
            apk:    'sudo apk add --no-cache jq tmux',
            brew:   'brew install jq tmux',
            choco:  'choco install -y jq tmux'
        };

        Object.keys(expected).forEach((manager) => {
            it(`installs on ${manager}`, async function() {
                expect(await run(['jq', 'tmux'], manager)).to.deep.equal([expected[manager]]);
            });
        });

        it('installs the whole list in a single command', async function() {
            expect(await run(['a', 'b', 'c', 'd'], 'apt')).to.have.lengthOf(1);
        });

        it('issues nothing for an empty list', async function() {
            expect(await run([], 'apt')).to.deep.equal([]);
        });

        it('never runs brew under sudo (AC-10)', async function() {
            const calls = await run(['jq'], 'brew');
            expect(calls[0]).to.not.match(/\bsudo\b/);
        });
    });

    describe('per-manager overrides (AC-21)', function() {
        const fd = { name: 'fd', apt: 'fd-find', dnf: 'fd-find', brew: 'fd', pacman: 'fd', zypper: 'fd', apk: 'fd', choco: 'fd' };

        it('uses the apt name on apt', async function() {
            expect((await run([fd], 'apt'))[0]).to.contain('fd-find');
        });

        it('uses the brew name on brew', async function() {
            expect((await run([fd], 'brew'))[0]).to.equal('brew install fd');
        });

        it('mixes bare names and overridden ones in one command', async function() {
            const calls = await run(['jq', fd, 'tmux'], 'apt');
            expect(calls[0]).to.equal('sudo apt-get install -y jq fd-find tmux');
        });

        it('uses the name when an entry declares no overrides at all', async function() {
            expect((await run([{ name: 'jq' }], 'dnf'))[0]).to.equal('sudo dnf install -y jq');
        });
    });

    describe('incomplete override map (AC-22)', function() {
        const partial = { name: 'fd', apt: 'fd-find', brew: 'fd' };

        it('throws rather than falling back to name', async function() {
            const bakelet = await loadOnly([partial], 'dnf');
            let error = null;
            try { await bakelet.install(); } catch (err) { error = err; }

            expect(error).to.be.an('error');
            expect(error.message).to.contain('dnf');
        });

        it('names which managers are covered', async function() {
            const bakelet = await loadOnly([partial], 'dnf');
            let error = null;
            try { await bakelet.install(); } catch (err) { error = err; }

            expect(error.message).to.contain('apt');
            expect(error.message).to.contain('brew');
        });

        it('issues no install command when it throws', async function() {
            const bakelet = await loadOnly([partial], 'dnf');
            const calls = [];
            bakelet.exec = async (cmd) => { calls.push(cmd); };
            try { await bakelet.install(); } catch (err) { /* expected */ }
            expect(calls).to.deep.equal([]);
        });
    });

    describe('removed apt: key (AC-23)', function() {

        it('rejects packages: - apt: with a list', async function() {
            let error = null;
            try { await loadOnly([{ apt: ['tmux', 'jq'] }], 'apt'); } catch (err) { error = err; }
            expect(error.message).to.contain('no longer supported');
        });

        it('rejects packages: - apt: with a string', async function() {
            let error = null;
            try { await loadOnly([{ apt: 'curl' }], 'apt'); } catch (err) { error = err; }
            expect(error.message).to.contain('no longer supported');
        });

        it('shows the bare-list replacement in the error', async function() {
            let error = null;
            try { await loadOnly([{ apt: ['tmux'] }], 'apt'); } catch (err) { error = err; }
            expect(error.message).to.contain('packages:');
            expect(error.message).to.contain('- jq');
        });

        it('shows the per-manager override syntax in the error', async function() {
            let error = null;
            try { await loadOnly([{ apt: ['tmux'] }], 'apt'); } catch (err) { error = err; }
            expect(error.message).to.contain('name: fd');
        });

        it('rejects the removed deb: sub-key too', async function() {
            let error = null;
            try { await loadOnly([{ deb: 'https://x/y.deb' }], 'apt'); } catch (err) { error = err; }
            expect(error.message).to.contain('no longer supported');
        });

        it('does not mistake a valid override map for the old form', async function() {
            // Has `name`, so it is the new shape even though it also has `apt`.
            const bakelet = await loadOnly([{ name: 'fd', apt: 'fd-find' }], 'apt');
            expect(bakelet.entries).to.have.lengthOf(1);
        });

        it('rejects the old form before issuing any command', async function() {
            const bakelet = new System('testenv', null, '');
            bakelet.platform = PLATFORMS.apt;
            const calls = [];
            bakelet.exec = async (cmd) => { calls.push(cmd); };
            try { await bakelet.load([{ apt: ['tmux'] }], []); } catch (err) { /* expected */ }
            expect(calls).to.deep.equal([]);
        });
    });

    describe('whole-list dispatch through the resolver (AC-24)', function() {
        let bakeDir;
        let origExecSync;

        beforeEach(async function() {
            bakeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'baker-packages-'));
            origExecSync = child_process.execSync;
        });

        afterEach(async function() {
            child_process.execSync = origExecSync;
            await fs.remove(bakeDir).catch(() => {});
        });

        it('instantiates the bakelet once with the whole list', async function() {
            const issued = [];
            child_process.execSync = (cmd) => {
                issued.push(cmd);
                return cmd.includes('/etc/os-release') ? 'ID=ubuntu\n' : '';
            };

            await resolve.resolveBakelet(
                BAKELETS_PATH, REMOTES_PATH,
                { name: 'pkg-dispatch', local: bakeDir, packages: ['jq', 'tmux', 'curl'] },
                bakeDir, false, bakeDir
            );

            const installs = issued.filter((c) => c.includes('apt-get install'));
            expect(installs).to.have.lengthOf(1);
            expect(installs[0]).to.equal('sudo apt-get install -y jq tmux curl');
        });

        it('surfaces the removed-apt-key error out of a real bake', async function() {
            child_process.execSync = (cmd) => (cmd.includes('/etc/os-release') ? 'ID=ubuntu\n' : '');

            let error = null;
            try {
                await resolve.resolveBakelet(
                    BAKELETS_PATH, REMOTES_PATH,
                    { name: 'pkg-legacy', local: bakeDir, packages: [{ apt: ['tmux'] }] },
                    bakeDir, false, bakeDir
                );
            } catch (err) { error = err; }

            expect(String(error)).to.contain('no longer supported');
        });
    });

    describe('elevation', function() {

        it('requires elevation on every manager except brew', function() {
            ['apt', 'dnf', 'pacman', 'zypper', 'apk', 'choco'].forEach((manager) => {
                const bakelet = new System('testenv', null, '');
                bakelet.platform = PLATFORMS[manager];
                expect(bakelet.requiresElevation, manager).to.equal(true);
            });
        });

        it('requires no elevation on brew', function() {
            const bakelet = new System('testenv', null, '');
            bakelet.platform = PLATFORMS.brew;
            expect(bakelet.requiresElevation).to.equal(false);
        });
    });
});
