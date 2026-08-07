const child_process = require('child_process');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const chai = require('chai');
const expect = chai.expect;

const LocalProvider = require('../../lib/modules/providers/local');
const Baker = require('../../lib/modules/baker');
const Ansible = require('../../lib/modules/configuration/ansible');
const { boxes } = require('../../global-vars');

const tmpDir = path.join(os.tmpdir(), 'baker-test-' + Date.now());
const testBoxName = 'test-local-box';

describe('LocalProvider', function() {
    let provider;

    beforeEach(function() {
        provider = new LocalProvider();
    });

    afterEach(async function() {
        await fs.remove(path.join(boxes, testBoxName)).catch(() => {});
    });

    describe('start()', function() {
        it('should create a .running marker file when started', async function() {
            await provider.start(testBoxName);
            const markerPath = path.join(boxes, testBoxName, '.running');
            const exists = await fs.pathExists(markerPath);
            expect(exists).to.be.true;
        });
    });

    describe('getState()', function() {
        it('should return "running" after start', async function() {
            await provider.start(testBoxName);
            const state = await provider.getState(testBoxName);
            expect(state).to.equal('running');
        });

        it('should return "stopped" before start', async function() {
            const state = await provider.getState(testBoxName);
            expect(state).to.equal('stopped');
        });

        it('should return "stopped" after stop', async function() {
            await provider.start(testBoxName);
            await provider.stop(testBoxName);
            const state = await provider.getState(testBoxName);
            expect(state).to.equal('stopped');
        });
    });

    describe('stop()', function() {
        it('should remove the .running marker', async function() {
            await provider.start(testBoxName);
            await provider.stop(testBoxName);
            const markerPath = path.join(boxes, testBoxName, '.running');
            const exists = await fs.pathExists(markerPath);
            expect(exists).to.be.false;
        });

        it('should not throw when stopping a non-existent box', async function() {
            await provider.stop('nonexistent-box');
        });
    });

    describe('delete()', function() {
        it('should remove the box directory', async function() {
            await provider.start(testBoxName);
            await provider.delete(testBoxName);
            const dirExists = await fs.pathExists(path.join(boxes, testBoxName));
            expect(dirExists).to.be.false;
        });

        it('should not throw when deleting a non-existent box', async function() {
            await provider.delete('nonexistent-box');
        });

        it('should stop the box before deleting if running', async function() {
            await provider.start(testBoxName);
            await provider.delete(testBoxName);
            const markerPath = path.join(boxes, testBoxName, '.running');
            const exists = await fs.pathExists(markerPath);
            expect(exists).to.be.false;
        });
    });

    describe('getSSHConfig()', function() {
        it('should return localhost SSH config', async function() {
            const config = await provider.getSSHConfig(testBoxName);
            expect(config).to.have.property('host', '127.0.0.1');
            expect(config).to.have.property('port', 22);
            expect(config).to.have.property('user', os.userInfo().username);
            expect(config).to.have.property('hostname', '127.0.0.1');
            expect(config).to.have.property('private_key', null);
        });
    });

    describe('ssh()', function() {
        it('should run a command on the local machine', async function() {
            const flagFile = '/tmp/baker-ssh-flag-' + Date.now();
            await provider.start(testBoxName);
            await provider.ssh(testBoxName, 'touch "' + flagFile + '"', false, false);
            const exists = await fs.pathExists(flagFile);
            expect(exists).to.be.true;
            await fs.remove(flagFile).catch(() => {});
        });

        it('should run a command with verbose output', async function() {
            const flagFile = '/tmp/baker-ssh-verbose-' + Date.now();
            await provider.start(testBoxName);
            await provider.ssh(testBoxName, 'touch "' + flagFile + '"', false, true);
            const exists = await fs.pathExists(flagFile);
            expect(exists).to.be.true;
            await fs.remove(flagFile).catch(() => {});
        });

        it('should open interactive shell when no command is given', async function() {
            const origShell = process.env.SHELL;
            process.env.SHELL = '/bin/true';
            try {
                await provider.start(testBoxName);
                await provider.ssh(testBoxName, null);
            } finally {
                process.env.SHELL = origShell;
            }
        });

        it('should fall back to /bin/sh when SHELL is not set', async function() {
            const origShell = process.env.SHELL;
            delete process.env.SHELL;
            try {
                await provider.start(testBoxName);
                await provider.ssh(testBoxName, null);
            } finally {
                process.env.SHELL = origShell;
            }
        });
    });

    describe('bake()', function() {
        const testBakeDir = path.join(tmpDir, 'bake-test');

        beforeEach(async function() {
            await fs.ensureDir(testBakeDir);
        });

        afterEach(async function() {
            await fs.remove(testBakeDir).catch(() => {});
            await fs.remove(path.join(boxes, testBoxName)).catch(() => {});
        });

        it('should create the location directory when local is a string path', async function() {
            const locationPath = path.join(tmpDir, 'bake-location');
            const yml = `name: ${testBoxName}\nlocal: ${locationPath}\n`;
            await fs.writeFile(path.join(testBakeDir, 'baker.yml'), yml);
            await provider.bake(testBakeDir, null, false);
            const dirExists = await fs.pathExists(locationPath);
            expect(dirExists).to.be.true;
            await fs.remove(locationPath).catch(() => {});
        });

        it('should use cwd when local is empty object', async function() {
            const yml = `name: ${testBoxName}\nlocal: {}\n`;
            await fs.writeFile(path.join(testBakeDir, 'baker.yml'), yml);
            const origCwd = process.cwd;
            process.cwd = () => testBakeDir;
            await provider.bake(testBakeDir, null, false);
            process.cwd = origCwd;
        });
    });

    });

describe('Baker.chooseProvider', function() {
    const testBakeDir = path.join(tmpDir, 'choose-provider-test');

    beforeEach(async function() {
        await fs.ensureDir(testBakeDir);
    });

    afterEach(async function() {
        await fs.remove(testBakeDir).catch(() => {});
    });

    it('should return LocalProvider when doc.local is a string', async function() {
        const yml = 'name: test-local\nlocal: /tmp/test\nlang:\n  - nodejs9\n';
        await fs.writeFile(path.join(testBakeDir, 'baker.yml'), yml);
        const result = await Baker.chooseProvider(testBakeDir);
        expect(result.provider.constructor.name).to.equal('LocalProvider');
    });

    it('should return LocalProvider when doc.local is empty object', async function() {
        const yml = 'name: test-local\nlocal: {}\n';
        await fs.writeFile(path.join(testBakeDir, 'baker.yml'), yml);
        const result = await Baker.chooseProvider(testBakeDir);
        expect(result.provider.constructor.name).to.equal('LocalProvider');
    });

    // The scope reduction removed the providers behind these keys. A config
    // still carrying one must be told what to use instead, not crash on a null
    // provider — so each retired key gets a named test.
    const retiredKeys = {
        vm:         'name: test-vm\nvm:\n  ip: 192.168.1.1\n',
        vagrant:    'name: test-vagrant\nvagrant:\n  box: ubuntu\n',
        container:  'name: test-container\ncontainer:\n  ip: 192.168.1.1\n',
        persistent: 'name: test-persistent\npersistent:\n  ip: 192.168.1.1\n'
    };

    Object.keys(retiredKeys).forEach((key) => {
        it(`should reject a retired ${key}: config naming the key`, async function() {
            await fs.writeFile(path.join(testBakeDir, 'baker.yml'), retiredKeys[key]);
            let err = null;
            try {
                await Baker.chooseProvider(testBakeDir);
            } catch (e) {
                err = e;
            }
            expect(err, `${key}: should have been rejected`).to.not.be.null;
            expect(err.message).to.contain(`'${key}:' is no longer supported`);
        });

        it(`should name the three supported modes when rejecting ${key}:`, async function() {
            await fs.writeFile(path.join(testBakeDir, 'baker.yml'), retiredKeys[key]);
            let err = null;
            try {
                await Baker.chooseProvider(testBakeDir);
            } catch (e) {
                err = e;
            }
            expect(err.message).to.contain('local:');
            expect(err.message).to.contain('docker:');
            expect(err.message).to.contain('remote:');
        });
    });

    it('should reject a config with no recognised environment key', async function() {
        await fs.writeFile(path.join(testBakeDir, 'baker.yml'), 'name: nothing\ntools:\n  - maven\n');
        let err = null;
        try {
            await Baker.chooseProvider(testBakeDir);
        } catch (e) {
            err = e;
        }
        expect(err, 'a config with no environment key should be rejected').to.not.be.null;
        expect(err.message).to.contain('no supported environment found');
        expect(err.message).to.contain('local:');
    });

    it('should prefer the retired-key message over the generic one', async function() {
        // vm: is retired AND unrecognised; the specific message is more useful.
        await fs.writeFile(path.join(testBakeDir, 'baker.yml'), retiredKeys.vm);
        let err = null;
        try {
            await Baker.chooseProvider(testBakeDir);
        } catch (e) {
            err = e;
        }
        expect(err.message).to.not.contain('no supported environment found');
    });

    it('should reject a retired key even when a supported key is also present', async function() {
        // An old config being migrated may carry both; the retired key is the
        // one that will not work, so it is the one worth naming.
        await fs.writeFile(path.join(testBakeDir, 'baker.yml'),
            'name: mixed\nlocal: {}\nvm:\n  ip: 192.168.1.1\n');
        let err = null;
        try {
            await Baker.chooseProvider(testBakeDir);
        } catch (e) {
            err = e;
        }
        expect(err, 'a config carrying vm: should be rejected even with local:').to.not.be.null;
        expect(err.message).to.contain("'vm:' is no longer supported");
    });

    it('should reject an empty baker.yml with a real message', async function() {
        await fs.writeFile(path.join(testBakeDir, 'baker.yml'), '');
        let err = null;
        try {
            await Baker.chooseProvider(testBakeDir);
        } catch (e) {
            err = e;
        }
        expect(err).to.not.be.null;
        expect(err.message).to.contain('empty');
        expect(err.message).to.not.contain('Cannot read properties');
    });

    it('should reject a baker.yml that is not a mapping', async function() {
        await fs.writeFile(path.join(testBakeDir, 'baker.yml'), '- just\n- a\n- list\n');
        let err = null;
        try {
            await Baker.chooseProvider(testBakeDir);
        } catch (e) {
            err = e;
        }
        expect(err).to.not.be.null;
        expect(err.message).to.contain('YAML mapping');
    });

    it('should still choose a supported provider when both a retired and a live key are absent of conflict', async function() {
        // local: alone must be unaffected by the retired-key check.
        await fs.writeFile(path.join(testBakeDir, 'baker.yml'), 'name: t\nlocal: {}\n');
        const result = await Baker.chooseProvider(testBakeDir);
        expect(result.provider.constructor.name).to.equal('LocalProvider');
    });
});

describe('Ansible.runLocalPlaybook', function() {
    it('should construct and run a local ansible command', async function() {
        const testDir = path.join(tmpDir, 'ansible-local-test');
        await fs.ensureDir(testDir);

        try {
            await Ansible.runLocalPlaybook(
                {name: 'test'},
                'test.yml',
                testDir,
                false,
                []
            );
        } catch (err) {
            // Expected to fail because test.yml doesn't exist or ansible isn't installed
            expect(err).to.be.an('error');
        }

        await fs.remove(testDir).catch(() => {});
    });
});

describe('Ansible.runLocalPlaybook error handling', function() {
    it('should throw when ansible-playbook fails', async function() {
        try {
            await Ansible.runLocalPlaybook(
                {name: 'test'},
                'nonexistent.yml',
                '/tmp',
                false,
                [{test_var: 'value'}]
            );
            expect.fail('should have thrown');
        } catch (err) {
            expect(err).to.be.an('error');
            expect(err.message).to.include('Failed to run bakelet');
        }
    });
});

async function waitForFile(file, timeout = 3000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (await fs.pathExists(file)) return true;
        await new Promise(r => setTimeout(r, 25));
    }
    return false;
}

describe('resolve.js local mode start command', function() {
    const testBakeDir = path.join(tmpDir, 'resolve-start-test');

    beforeEach(async function() {
        await fs.ensureDir(testBakeDir);
    });

    afterEach(async function() {
        await fs.remove(testBakeDir).catch(() => {});
    });

    it('should handle doc.start as a string command in local mode', async function() {
        const resolve = require('../../lib/bakelets/resolve');
        const flagFile = path.join(tmpDir, 'baker-str-start-' + Date.now());
        const yml = {
            name: 'test-local-str-start',
            local: testBakeDir,
            start: 'echo "str" > "' + flagFile + '"'
        };

        await resolve.resolveBakelet(
            path.join(__dirname, '../../lib/bakelets'),
            path.join(__dirname, '../../remotes'),
            yml,
            testBakeDir,
            false,
            testBakeDir
        );

        const flagExists = await waitForFile(flagFile);
        expect(flagExists, 'backgrounded start: command should still run').to.be.true;
        await fs.remove(flagFile).catch(() => {});
    });

    it('should run start command locally when localMode is active', async function() {
        const resolve = require('../../lib/bakelets/resolve');
        const flagFile = path.join(tmpDir, 'baker-start-flag-' + Date.now());
        const yml = {
            name: 'test-local-start',
            local: testBakeDir,
            start: 'echo "ran" > "' + flagFile + '"'
        };

        await resolve.resolveBakelet(
            path.join(__dirname, '../../lib/bakelets'),
            path.join(__dirname, '../../remotes'),
            yml,
            testBakeDir,
            false,
            testBakeDir
        );

        const flagExists = await waitForFile(flagFile);
        expect(flagExists, 'backgrounded start: command should still run').to.be.true;
        await fs.remove(flagFile).catch(() => {});
    });
});

describe('resolve.js local mode', function() {
    const testBakeDir = path.join(tmpDir, 'resolve-local-test');
    const bakeletsPath = path.join(__dirname, '../../lib/bakelets');
    const remotesPath = path.join(__dirname, '../../remotes');

    beforeEach(async function() {
        await fs.ensureDir(testBakeDir);
    });

    afterEach(async function() {
        await fs.remove(testBakeDir).catch(() => {});
    });

    it('should patch copy method to copy playbook to local location', async function() {
        const resolve = require('../../lib/bakelets/resolve');
        const origRunAnsiblePlaybook = Ansible.runAnsiblePlaybook;
        Ansible.runAnsiblePlaybook = async () => {};
        const yml = {
            name: 'test-local-resolve',
            local: testBakeDir,
            lang: ['nodejs9']
        };

        try {
            await resolve.resolveBakelet(bakeletsPath, remotesPath, yml, testBakeDir, false, testBakeDir);
        } catch (err) {
        } finally {
            Ansible.runAnsiblePlaybook = origRunAnsiblePlaybook;
        }

        var files = await fs.readdir(testBakeDir);
        var ymlFiles = files.filter(f => f.endsWith('.yml'));
        expect(ymlFiles.length).to.be.at.least(1);
        expect(ymlFiles[0]).to.match(/nodejs.*\.yml/);
    });

    // Renamed from 'should use fallback yml file when exact playbook does not
    // exist'. The vehicle is lang:, the only permanently playbook-backed
    // section — env: and packages: both became exec-based in the cross-platform
    // work. What this always actually asserted is that a playbook-backed
    // bakelet in local mode hands Ansible a rendered .yml.
    it('should pass a rendered .yml playbook to Ansible in local mode', async function() {
        const resolve = require('../../lib/bakelets/resolve');
        let usedPlaybook = '';
        const origRunAnsiblePlaybook = Ansible.runAnsiblePlaybook;
        Ansible.runAnsiblePlaybook = async (doc, cmd) => { usedPlaybook = cmd; };
        const yml = {
            name: 'test-fallback',
            local: testBakeDir,
            lang: ['python']
        };

        try {
            await resolve.resolveBakelet(bakeletsPath, remotesPath, yml, testBakeDir, false, testBakeDir);
        } catch (err) {
        } finally {
            Ansible.runAnsiblePlaybook = origRunAnsiblePlaybook;
        }

        expect(usedPlaybook).to.be.a('string');
        expect(usedPlaybook.endsWith('.yml')).to.be.true;
    });

    // packages: is exec-based since the cross-platform work — it runs the
    // detected manager's install command rather than an Ansible playbook.
    it('should support packages bakelet in local mode', async function() {
        const resolve = require('../../lib/bakelets/resolve');
        const origExecSync = child_process.execSync;
        const issued = [];
        child_process.execSync = (cmd) => {
            issued.push(cmd);
            return cmd.includes('/etc/os-release') ? 'ID=fedora\n' : '';
        };

        const yml = {
            name: 'test-packages',
            local: testBakeDir,
            packages: ['curl']
        };

        try {
            await resolve.resolveBakelet(bakeletsPath, remotesPath, yml, testBakeDir, false, testBakeDir);
        } finally {
            child_process.execSync = origExecSync;
        }

        const install = issued.find((c) => c.includes('curl') && !c.includes('os-release'));
        expect(install).to.equal('sudo dnf install -y curl');
    });
});

describe('retired providers through the CLI', function() {
    // chooseProvider throwing is only useful if the message survives bake.js's
    // catch and reaches the terminal. This exercises that boundary for real.
    this.timeout(20000);

    const cliDir = path.join(tmpDir, 'cli-retired');
    const bakerBin = path.join(__dirname, '..', '..', 'baker.js');

    function runBake(dir) {
        return child_process.execSync(
            `node "${bakerBin}" bake "${dir}" 2>&1 || true`,
            { encoding: 'utf8', maxBuffer: 2000 * 1024 }
        );
    }

    beforeEach(async function() {
        await fs.ensureDir(cliDir);
    });

    afterEach(async function() {
        await fs.remove(cliDir).catch(() => {});
    });

    it('prints the retired-key message for a vm: config', async function() {
        await fs.writeFile(path.join(cliDir, 'baker.yml'), 'name: legacy\nvm:\n  ip: 192.168.1.1\n');
        expect(runBake(cliDir)).to.contain("'vm:' is no longer supported");
    });

    it('names all three supported modes in the terminal output', async function() {
        await fs.writeFile(path.join(cliDir, 'baker.yml'), 'name: legacy\ncontainer:\n  ip: 192.168.1.1\n');
        const out = runBake(cliDir);
        expect(out).to.contain('local:');
        expect(out).to.contain('docker:');
        expect(out).to.contain('remote:');
    });

    it('does not leave a stack trace in front of the explanation', async function() {
        await fs.writeFile(path.join(cliDir, 'baker.yml'), 'name: legacy\nvagrant:\n  box: ubuntu\n');
        expect(runBake(cliDir)).to.not.contain('at Function.chooseProvider');
    });

    it('still lists only the retained commands in --help', function() {
        const help = child_process.execSync(`node "${bakerBin}" --help 2>&1 || true`, { encoding: 'utf8' });
        ['setup', 'setupmac', 'server', 'boxes', 'import', 'package', 'halt', 'cluster',
         'status', 'vault', 'command'].forEach((gone) => {
            expect(help, `${gone} should no longer be a command`).to.not.contain(` ${gone} `);
        });
    });

    it('still offers bake, check, cleanup, destroy, ssh, run', function() {
        const help = child_process.execSync(`node "${bakerBin}" --help 2>&1 || true`, { encoding: 'utf8' });
        ['bake', 'check', 'cleanup', 'destroy', 'ssh', 'run'].forEach((kept) => {
            expect(help, `${kept} should still be a command`).to.contain(kept);
        });
    });
});

describe('LocalProvider.resolveLocation', function() {
    // path.resolve does not expand a tilde, so `local: ~/project` used to create
    // a literal "~" directory under the cwd. files: dest already expanded it.
    it('expands a leading ~/ to the home directory', function() {
        expect(LocalProvider.resolveLocation('~/project'))
            .to.equal(path.join(os.homedir(), 'project'));
    });

    it('expands a bare ~', function() {
        expect(LocalProvider.resolveLocation('~')).to.equal(os.homedir());
    });

    it('expands a nested home-relative path', function() {
        expect(LocalProvider.resolveLocation('~/a/b/c'))
            .to.equal(path.join(os.homedir(), 'a', 'b', 'c'));
    });

    it('never yields a path segment that is literally ~', function() {
        expect(LocalProvider.resolveLocation('~/project').split(path.sep)).to.not.include('~');
    });

    it('leaves an absolute path alone', function() {
        expect(LocalProvider.resolveLocation('/tmp/x')).to.equal(path.resolve('/tmp/x'));
    });

    it('still resolves a relative path against the cwd', function() {
        expect(LocalProvider.resolveLocation('./sub')).to.equal(path.resolve('./sub'));
    });

    it('does not expand a tilde that is not leading', function() {
        // A directory legitimately named "a~b" must survive.
        expect(LocalProvider.resolveLocation('./a~b')).to.equal(path.resolve('./a~b'));
    });
});
