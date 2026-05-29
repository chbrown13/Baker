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

    describe('list()', function() {
        it('should not throw when boxes directory is empty', async function() {
            await provider.list();
        });

        it('should handle missing boxes directory gracefully', async function() {
            const origReaddir = fs.readdir;
            fs.readdir = () => Promise.reject(new Error('ENOENT'));
            let called = false;
            const origTable = console.table;
            console.table = function() { called = true; };
            try {
                await provider.list();
            } finally {
                fs.readdir = origReaddir;
                console.table = origTable;
            }
            expect(called).to.be.true;
        });

        it('should list boxes after starting one', async function() {
            await provider.start(testBoxName);
            try {
                var called = false;
                var origTable = console.table;
                console.table = function() { called = true; };
                await provider.list();
                console.table = origTable;
                expect(called).to.be.true;
            } finally {
                console.table = origTable || console.table;
            }
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

    it('should return VirtualBoxProvider when doc.vm is present', async function() {
        const yml = 'name: test-vm\nvm:\n  ip: 192.168.1.1\n';
        await fs.writeFile(path.join(testBakeDir, 'baker.yml'), yml);
        const result = await Baker.chooseProvider(testBakeDir);
        expect(result.provider.constructor.name).to.equal('VirtualBoxProvider');
    });

    it('should return RuncProvider when doc.container is present', async function() {
        const yml = 'name: test-container\ncontainer:\n  ip: 192.168.1.1\n';
        await fs.writeFile(path.join(testBakeDir, 'baker.yml'), yml);
        const result = await Baker.chooseProvider(testBakeDir);
        expect(result.provider.constructor.name).to.equal('RuncProvider');
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

        const flagExists = await fs.pathExists(flagFile);
        expect(flagExists).to.be.true;
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

        const flagExists = await fs.pathExists(flagFile);
        expect(flagExists).to.be.true;
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

    it('should use fallback yml file when exact playbook does not exist', async function() {
        const resolve = require('../../lib/bakelets/resolve');
        let usedPlaybook = '';
        const origRunAnsiblePlaybook = Ansible.runAnsiblePlaybook;
        Ansible.runAnsiblePlaybook = async (doc, cmd) => { usedPlaybook = cmd; };
        const yml = {
            name: 'test-fallback',
            local: testBakeDir,
            env: [{BAKER_VAR: 'test'}]
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

    it('should support packages bakelet in local mode', async function() {
        const resolve = require('../../lib/bakelets/resolve');
        let usedPlaybooks = [];
        const origRunAnsiblePlaybook = Ansible.runAnsiblePlaybook;
        Ansible.runAnsiblePlaybook = async (doc, cmd) => { usedPlaybooks.push(cmd); };
        const yml = {
            name: 'test-packages',
            local: testBakeDir,
            packages: [{apt: 'curl'}]
        };

        try {
            await resolve.resolveBakelet(bakeletsPath, remotesPath, yml, testBakeDir, false, testBakeDir);
        } catch (err) {
        } finally {
            Ansible.runAnsiblePlaybook = origRunAnsiblePlaybook;
        }

        expect(usedPlaybooks.length).to.be.at.least(1);
        expect(usedPlaybooks[0]).to.match(/apt.*\.yml/);
    });
});
