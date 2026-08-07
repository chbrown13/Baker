const child_process = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const chai = require('chai');
const expect = chai.expect;

const Ansible = require('../../lib/modules/configuration/ansible');
const RemoteProvider = require('../../lib/modules/providers/remote');
const Ssh = require('../../lib/modules/ssh');

const tmpDir = path.join(os.tmpdir(), 'baker-remote-test-' + Date.now());

function makeRemoteSSHConfig(overrides) {
    return Object.assign({
        user: 'testuser',
        private_key: '/tmp/test_rsa',
        hostname: '192.168.1.100',
        port: 22
    }, overrides);
}

function makeValidBakerYml(overrides) {
    return Object.assign({
        name: 'test-remote-box',
        remote: {
            ip: '192.168.1.100',
            user: 'testuser',
            private_key: '/tmp/test_rsa',
            port: 22
        }
    }, overrides);
}

describe('Ansible.buildRemoteInventory', function() {
    it('should build inventory string with hostname, user, and private key', function() {
        const config = makeRemoteSSHConfig();
        const result = Ansible.buildRemoteInventory(config);
        expect(result).to.include('192.168.1.100');
        expect(result).to.include('ansible_connection=ssh');
        expect(result).to.include('ansible_user=testuser');
        expect(result).to.include('ansible_ssh_private_key_file=/tmp/test_rsa');
    });

    it('should handle custom port gracefully', function() {
        const config = makeRemoteSSHConfig({ port: 2222 });
        const result = Ansible.buildRemoteInventory(config);
        expect(result).to.include('192.168.1.100');
        expect(result).to.include('ansible_ssh_private_key_file=/tmp/test_rsa');
    });
});

describe('Ansible.runRemotePlaybook', function() {
    let origExecSync;

    beforeEach(function() {
        origExecSync = child_process.execSync;
    });

    afterEach(function() {
        child_process.execSync = origExecSync;
    });

    it('should construct and run a remote ansible command from host', async function() {
        let capturedCmd = '';
        child_process.execSync = (cmd, opts) => {
            capturedCmd = cmd;
            return 'PLAY RECAP ********************* ok=2 failed=0';
        };

        const config = makeRemoteSSHConfig();
        await Ansible.runRemotePlaybook(
            { name: 'test-box' },
            'playbook.yml',
            config,
            false,
            [{ var1: 'val1' }]
        );

        expect(capturedCmd).to.include('ansible-playbook');
        expect(capturedCmd).to.include('playbook.yml');
        expect(capturedCmd).to.include('192.168.1.100');
        expect(capturedCmd).to.include('ansible_user=testuser');
    });

    it('should flatten multiple variables into extravars', async function() {
        let capturedCmd = '';
        child_process.execSync = (cmd, opts) => {
            capturedCmd = cmd;
            return 'PLAY RECAP ********************* ok=2 failed=0';
        };

        const config = makeRemoteSSHConfig();
        await Ansible.runRemotePlaybook(
            { name: 'test-box' },
            'playbook.yml',
            config,
            false,
            [{ var1: 'val1' }, { var2: 'val2' }]
        );

        expect(capturedCmd).to.include('var1');
        expect(capturedCmd).to.include('val1');
        expect(capturedCmd).to.include('var2');
        expect(capturedCmd).to.include('val2');
    });

    it('should throw when ansible-playbook reports failures', async function() {
        child_process.execSync = (cmd, opts) => {
            return 'PLAY RECAP ********************* ok=1 failed=1';
        };

        const config = makeRemoteSSHConfig();
        try {
            await Ansible.runRemotePlaybook(
                { name: 'test-box' },
                'playbook.yml',
                config,
                false,
                []
            );
            expect.fail('should have thrown');
        } catch (err) {
            expect(err).to.be.an('error');
            expect(err.message).to.include('A bakelet task failed');
        }
    });

    it('should throw when output has no recap line', async function() {
        child_process.execSync = (cmd, opts) => {
            return 'some unexpected output';
        };

        const config = makeRemoteSSHConfig();
        try {
            await Ansible.runRemotePlaybook(
                { name: 'test-box' },
                'playbook.yml',
                config,
                false,
                []
            );
            expect.fail('should have thrown');
        } catch (err) {
            expect(err).to.be.an('error');
            expect(err.message).to.include('Failed to run bakelet');
        }
    });

    it('should propagate execSync errors', async function() {
        child_process.execSync = (cmd, opts) => {
            throw new Error('ENOENT');
        };

        const config = makeRemoteSSHConfig();
        try {
            await Ansible.runRemotePlaybook(
                { name: 'test-box' },
                'playbook.yml',
                config,
                false,
                []
            );
            expect.fail('should have thrown');
        } catch (err) {
            expect(err).to.be.an('error');
        }
    });
});

describe('Ansible.runRemoteAdhoc', function() {
    let origExecSync;

    beforeEach(function() {
        origExecSync = child_process.execSync;
    });

    afterEach(function() {
        child_process.execSync = origExecSync;
    });

    it('should construct and run a remote ad-hoc ansible command', async function() {
        let capturedCmd = '';
        child_process.execSync = (cmd, opts) => {
            capturedCmd = cmd;
            return '';
        };

        const config = makeRemoteSSHConfig();
        await Ansible.runRemoteAdhoc(
            { name: 'test-box' },
            'apt',
            'pkg=curl update_cache=yes',
            config,
            false
        );

        expect(capturedCmd).to.include('ansible all -m apt');
        expect(capturedCmd).to.include('pkg=curl');
        expect(capturedCmd).to.include('192.168.1.100');
        expect(capturedCmd).to.include('--become');
    });
});

describe('Ansible remote helper methods', function() {
    let origRunRemoteAdhoc;

    beforeEach(function() {
        origRunRemoteAdhoc = Ansible.runRemoteAdhoc;
    });

    afterEach(function() {
        Ansible.runRemoteAdhoc = origRunRemoteAdhoc;
    });


    it('runRemotePipInstall should delegate to runRemoteAdhoc with pip module', async function() {
        let capturedArgs = [];
        Ansible.runRemoteAdhoc = async (doc, module, moduleArgs, config) => {
            capturedArgs = [module, moduleArgs, config];
        };

        const config = makeRemoteSSHConfig();
        await Ansible.runRemotePipInstall({ name: 'test' }, '/tmp/requirements.txt', config, false);

        expect(capturedArgs[0]).to.equal('pip');
        expect(capturedArgs[1]).to.include('requirements=/tmp/requirements.txt');
    });

    it('runRemoteNpmInstall should delegate to runRemoteAdhoc with npm module', async function() {
        let capturedArgs = [];
        Ansible.runRemoteAdhoc = async (doc, module, moduleArgs, config) => {
            capturedArgs = [module, moduleArgs, config];
        };

        const config = makeRemoteSSHConfig();
        await Ansible.runRemoteNpmInstall({ name: 'test' }, '/tmp/app/package.json', config, false);

        expect(capturedArgs[0]).to.equal('npm');
        expect(capturedArgs[1]).to.include('path=/tmp/app/package.json');
    });

    it('runRemoteCreateDirectory should delegate to runRemoteAdhoc with file module', async function() {
        let capturedArgs = [];
        Ansible.runRemoteAdhoc = async (doc, module, moduleArgs, config) => {
            capturedArgs = [module, moduleArgs, config];
        };

        const config = makeRemoteSSHConfig();
        await Ansible.runRemoteCreateDirectory({ name: 'test' }, '/tmp/mydir', '0755', config, false);

        expect(capturedArgs[0]).to.equal('file');
        expect(capturedArgs[1]).to.include('path=/tmp/mydir');
        expect(capturedArgs[1]).to.include('mode=0755');
        expect(capturedArgs[1]).to.include('state=directory');
    });

    it('runRemoteTemplateCmd should delegate to runRemoteAdhoc with template module', async function() {
        let capturedCmd = '';
        const origExecSync = child_process.execSync;
        child_process.execSync = (cmd, opts) => {
            capturedCmd = cmd;
            return '';
        };

        try {
            const config = makeRemoteSSHConfig();
            await Ansible.runRemoteTemplateCmd(
                { name: 'test' },
                'templates/myfile.j2',
                '/etc/myfile',
                [{ var1: 'val1' }],
                config,
                false
            );

            expect(capturedCmd).to.include('ansible all -m template');
            expect(capturedCmd).to.include('src=templates/myfile.j2');
            expect(capturedCmd).to.include('dest=/etc/myfile');
            expect(capturedCmd).to.include('192.168.1.100');
        } finally {
            child_process.execSync = origExecSync;
        }
    });
});

describe('RemoteProvider', function() {
    let provider;

    beforeEach(function() {
        provider = new RemoteProvider('testuser', '/tmp/test_rsa', '192.168.1.100', 22);
    });

    describe('constructor', function() {
        it('should store sshConfig with provided values', function() {
            expect(provider.sshConfig).to.deep.equal({
                user: 'testuser',
                private_key: '/tmp/test_rsa',
                hostname: '192.168.1.100',
                port: 22
            });
        });

        it('should default port to 22 when not provided', function() {
            const p = new RemoteProvider('u', '/tmp/k', '10.0.0.1');
            expect(p.sshConfig.port).to.equal(22);
        });
    });

    describe('getSSHConfig', function() {
        it('should return the stored sshConfig', function() {
            const config = provider.getSSHConfig();
            expect(config).to.equal(provider.sshConfig);
        });
    });

    describe('validateBakerYML', function() {
        const testDir = path.join(tmpDir, 'validate-test');

        beforeEach(async function() {
            await fs.ensureDir(testDir);
        });

        afterEach(async function() {
            await fs.remove(testDir).catch(() => {});
        });

        it('should return true for valid remote baker.yml', async function() {
            const yml = 'name: test\nremote:\n  ip: 10.0.0.1\n  user: admin\n  private_key: /tmp/k\n';
            await fs.writeFile(path.join(testDir, 'baker.yml'), yml);
            const result = await RemoteProvider.validateBakerYML(testDir);
            expect(result).to.be.true;
        });

        it('should return false when remote key is missing ip', async function() {
            const yml = 'name: test\nremote:\n  user: admin\n  private_key: /tmp/k\n';
            await fs.writeFile(path.join(testDir, 'baker.yml'), yml);
            const result = await RemoteProvider.validateBakerYML(testDir);
            expect(result).to.be.false;
        });

        it('should return false when remote key is missing user', async function() {
            const yml = 'name: test\nremote:\n  ip: 10.0.0.1\n  private_key: /tmp/k\n';
            await fs.writeFile(path.join(testDir, 'baker.yml'), yml);
            const result = await RemoteProvider.validateBakerYML(testDir);
            expect(result).to.be.false;
        });

        it('should return false when remote key is missing private_key', async function() {
            const yml = 'name: test\nremote:\n  ip: 10.0.0.1\n  user: admin\n';
            await fs.writeFile(path.join(testDir, 'baker.yml'), yml);
            const result = await RemoteProvider.validateBakerYML(testDir);
            expect(result).to.be.false;
        });

        it('should return false when baker.yml has no remote key', async function() {
            const yml = 'name: test\nlocal: {}\n';
            await fs.writeFile(path.join(testDir, 'baker.yml'), yml);
            const result = await RemoteProvider.validateBakerYML(testDir);
            expect(result).to.be.false;
        });
    });

    describe('bake', function() {
        const testBakeDir = path.join(tmpDir, 'bake-test');
        let origSshExec;
        let origResolve;

        beforeEach(async function() {
            await fs.ensureDir(testBakeDir);
            origSshExec = Ssh.sshExec;
            origResolve = undefined;
        });

        afterEach(async function() {
            Ssh.sshExec = origSshExec;
            if (origResolve) {
                require.cache[require.resolve('../../lib/bakelets/resolve')] = origResolve;
            }
            await fs.remove(testBakeDir).catch(() => {});
        });

        it('should create remote directory and call resolveBakelet with remoteSSHConfig', async function() {
            let mkdirCmd = '';
            Ssh.sshExec = async (cmd, config, timeout, verbose) => {
                mkdirCmd = cmd;
            };

            let resolveCalledWith = null;
            const resolveMock = {
                resolveBakelet: async (...args) => {
                    resolveCalledWith = args;
                }
            };
            const resolvePath = require.resolve('../../lib/bakelets/resolve');
            origResolve = require.cache[resolvePath];
            require.cache[resolvePath] = { exports: resolveMock };

            const yml = makeValidBakerYml();
            delete yml.remote;
            const ymlContent = `name: test-remote-box\nremote:\n  ip: 192.168.1.100\n  user: testuser\n  private_key: /tmp/test_rsa\n  port: 22\n`;
            await fs.writeFile(path.join(testBakeDir, 'baker.yml'), ymlContent);

            await provider.bake(testBakeDir, null, false);

            expect(mkdirCmd).to.include('mkdir -p /home/vagrant/baker/test-remote-box/templates');

            expect(resolveCalledWith).to.not.be.null;
            const args = resolveCalledWith;
            expect(args[0]).to.be.a('string');
            expect(args[1]).to.be.a('string');
            expect(args[2]).to.have.property('name', 'test-remote-box');
            expect(args[3]).to.equal(testBakeDir);
            expect(args[4]).to.be.false;
            expect(args[5]).to.be.null;
            expect(args[6]).to.deep.include({
                user: 'testuser',
                hostname: '192.168.1.100',
                port: 22
            });
        });

        it('should default port to 22 when remote config omits port', async function() {
            Ssh.sshExec = async () => {};

            let resolveCalled = false;
            const resolveMock = {
                resolveBakelet: async (...args) => {
                    resolveCalled = true;
                    expect(args[6].port).to.equal(22);
                }
            };
            const resolvePath = require.resolve('../../lib/bakelets/resolve');
            origResolve = require.cache[resolvePath];
            require.cache[resolvePath] = { exports: resolveMock };

            const ymlContent = `name: test-remote-box\nremote:\n  ip: 192.168.1.100\n  user: testuser\n  private_key: /tmp/test_rsa\n`;
            await fs.writeFile(path.join(testBakeDir, 'baker.yml'), ymlContent);

            try {
                await provider.bake(testBakeDir, null, false);
                expect(resolveCalled).to.be.true;
            } finally {
                // cleanup
            }
        });

        it('should traverse vars when doc.vars is present', async function() {
            let traversed = false;
            const origTraverse = require('../../lib/modules/utils/utils').traverse;
            require('../../lib/modules/utils/utils').traverse = async () => { traversed = true; };

            Ssh.sshExec = async () => {};

            const resolveMock = { resolveBakelet: async () => {} };
            const resolvePath = require.resolve('../../lib/bakelets/resolve');
            origResolve = require.cache[resolvePath];
            require.cache[resolvePath] = { exports: resolveMock };

            const ymlContent = `name: test-remote-box\nremote:\n  ip: 192.168.1.100\n  user: testuser\n  private_key: /tmp/test_rsa\nvars:\n  MY_VAR: myval\n`;
            await fs.writeFile(path.join(testBakeDir, 'baker.yml'), ymlContent);

            try {
                await provider.bake(testBakeDir, null, false);
                expect(traversed).to.be.true;
            } finally {
                require('../../lib/modules/utils/utils').traverse = origTraverse;
            }
        });

        it('should re-throw errors from underlying operations', async function() {
            Ssh.sshExec = async () => { throw new Error('SSH connection failed'); };

            const ymlContent = `name: test-remote-box\nremote:\n  ip: 192.168.1.100\n  user: testuser\n  private_key: /tmp/test_rsa\n`;
            await fs.writeFile(path.join(testBakeDir, 'baker.yml'), ymlContent);

            try {
                await provider.bake(testBakeDir, null, false);
                expect.fail('should have thrown');
            } catch (err) {
                expect(err.message).to.equal('SSH connection failed');
            }
        });
    });

    describe('delete', function() {
        let origSshExec;

        beforeEach(function() {
            origSshExec = Ssh.sshExec;
        });

        afterEach(function() {
            Ssh.sshExec = origSshExec;
        });

        it('should remove the remote baker directory', async function() {
            let capturedCmd = '';
            Ssh.sshExec = async (cmd) => { capturedCmd = cmd; };

            await provider.delete('test-box');

            expect(capturedCmd).to.include('rm -rf /home/vagrant/baker/test-box');
        });

        it('should silently handle SSH errors during delete', async function() {
            Ssh.sshExec = async () => { throw new Error('Host unreachable'); };

            await provider.delete('test-box');
        });
    });

    describe('ssh', function() {
        let origSSHSession;

        beforeEach(function() {
            origSSHSession = Ssh.SSH_Session;
        });

        afterEach(function() {
            Ssh.SSH_Session = origSSHSession;
        });

        it('should open an SSH session via ssh2', async function() {
            let capturedConfig = null;
            Ssh.SSH_Session = async (config) => { capturedConfig = config; };

            await provider.ssh();

            expect(capturedConfig).to.equal(provider.sshConfig);
        });

        it('should throw when SSH session fails', async function() {
            Ssh.SSH_Session = async () => { throw new Error('Connection refused'); };

            try {
                await provider.ssh();
                expect.fail('should have thrown');
            } catch (err) {
                expect(err.message).to.equal('Connection refused');
            }
        });
    });
});

describe('RemoteProvider in Baker.chooseProvider', function() {
    const testDir = path.join(tmpDir, 'choose-remote-test');

    beforeEach(async function() {
        await fs.ensureDir(testDir);
    });

    afterEach(async function() {
        await fs.remove(testDir).catch(() => {});
    });

    it('should return RemoteProvider when doc.remote is present', async function() {
        const Baker = require('../../lib/modules/baker');
        const yml = 'name: test-remote\nremote:\n  ip: 10.0.0.1\n  user: admin\n  private_key: /tmp/k\n';
        await fs.writeFile(path.join(testDir, 'baker.yml'), yml);
        const result = await Baker.chooseProvider(testDir);
        expect(result.provider.constructor.name).to.equal('RemoteProvider');
        expect(result.provider.sshConfig.hostname).to.equal('10.0.0.1');
    });
});

describe('ssh.js copyFromHostToVM hostname fix', function() {
    const srcDir = path.join(tmpDir, 'scp-test');
    let origSshExec;

    beforeEach(async function() {
        await fs.ensureDir(srcDir);
        await fs.writeFile(path.join(srcDir, 'testfile.txt'), 'hello');
        origSshExec = Ssh.sshExec;
        Ssh.sshExec = async () => {};
    });

    afterEach(async function() {
        Ssh.sshExec = origSshExec;
        await fs.remove(srcDir).catch(() => {});
    });

    it('should use destSSHConfig.hostname when present', function(done) {
        const scp2 = require('scp2');
        let capturedHost = null;
        const origScp = scp2.scp;
        scp2.scp = (src, opts, cb) => {
            capturedHost = opts.host;
            cb(null);
        };

        const keyPath = path.join(srcDir, 'key');
        fs.writeFileSync(keyPath, 'fake-key');

        Ssh.copyFromHostToVM(path.join(srcDir, 'testfile.txt'), '/tmp/dest', {
            hostname: '10.0.0.1',
            port: 22,
            user: 'testuser',
            private_key: keyPath
        }).then(() => {
            scp2.scp = origScp;
            expect(capturedHost).to.equal('10.0.0.1');
            done();
        }).catch(() => {
            scp2.scp = origScp;
            done(new Error('should not reject'));
        });
    });

    it('should fall back to 127.0.0.1 when hostname is not set', function(done) {
        const scp2 = require('scp2');
        let capturedHost = null;
        const origScp = scp2.scp;
        scp2.scp = (src, opts, cb) => {
            capturedHost = opts.host;
            cb(null);
        };

        const keyPath = path.join(srcDir, 'key');
        fs.writeFileSync(keyPath, 'fake-key');

        Ssh.copyFromHostToVM(path.join(srcDir, 'testfile.txt'), '/tmp/dest', {
            port: 22,
            user: 'testuser',
            private_key: keyPath
        }).then(() => {
            scp2.scp = origScp;
            expect(capturedHost).to.equal('127.0.0.1');
            done();
        }).catch(() => {
            scp2.scp = origScp;
            done(new Error('should not reject'));
        });
    });
});

describe('resolve.js remote mode', function() {
    const testBakeDir = path.join(tmpDir, 'resolve-remote-test');
    const bakeletsPath = path.join(__dirname, '../../lib/bakelets');
    const remotesPath = path.join(__dirname, '../../remotes');

    beforeEach(async function() {
        await fs.ensureDir(testBakeDir);
    });

    afterEach(async function() {
        await fs.remove(testBakeDir).catch(() => {});
    });

    it('should run start command via host-based ansible in remote mode', async function() {
        const resolve = require('../../lib/bakelets/resolve');
        const origExecSync = child_process.execSync;
        let capturedCmd = '';
        child_process.execSync = (cmd, opts) => {
            capturedCmd = cmd;
            return '';
        };

        const remoteSSHConfig = makeRemoteSSHConfig();
        const yml = {
            name: 'test-remote-start',
            start: 'touch /tmp/baker-test'
        };

        try {
            await resolve.resolveBakelet(bakeletsPath, remotesPath, yml, testBakeDir, false, null, remoteSSHConfig);
        } catch (err) {
        } finally {
            child_process.execSync = origExecSync;
        }

        expect(capturedCmd).to.include('ansible all -m shell');
        expect(capturedCmd).to.include('touch /tmp/baker-test');
        expect(capturedCmd).to.include('192.168.1.100');
    });

    it('should use remoteSSHConfig as ansibleSSHConfig for bakelets', async function() {
        const resolve = require('../../lib/bakelets/resolve');
        const origSshExec = Ssh.sshExec;
        const origRunAnsiblePlaybook = Ansible.runAnsiblePlaybook;
        let sshExecCalled = false;
        Ssh.sshExec = async () => { sshExecCalled = true; };
        Ansible.runAnsiblePlaybook = async () => {};

        const remoteSSHConfig = makeRemoteSSHConfig();
        const yml = {
            name: 'test-remote-resolve',
            packages: [{apt: 'curl'}]
        };

        try {
            await resolve.resolveBakelet(bakeletsPath, remotesPath, yml, testBakeDir, false, null, remoteSSHConfig);
        } catch (err) {
        } finally {
            Ssh.sshExec = origSshExec;
            Ansible.runAnsiblePlaybook = origRunAnsiblePlaybook;
        }

        expect(sshExecCalled).to.be.true;
    });

    it('should patch Ansible methods for remote mode during install', async function() {
        const resolve = require('../../lib/bakelets/resolve');
        const origSshExec = Ssh.sshExec;
        const origRunAnsiblePlaybook = Ansible.runAnsiblePlaybook;
        let remotePlaybookCalled = false;

        Ssh.sshExec = async () => {};
        // lang: copies a playbook, so the SCP transport needs stubbing too.
        const origCopy = Ssh.copyFromHostToVM;
        Ssh.copyFromHostToVM = async () => {};
        const origRemotePlaybook = Ansible.runRemotePlaybook;
        Ansible.runRemotePlaybook = async () => { remotePlaybookCalled = true; };
        Ansible.runAnsiblePlaybook = async () => {};

        const remoteSSHConfig = makeRemoteSSHConfig();
        // lang: is the vehicle because it is permanently playbook-backed. env:
        // and packages: both became exec-based in the cross-platform work, so
        // neither reaches Ansible any more.
        const yml = {
            name: 'test-remote-patch',
            lang: ['python']
        };

        try {
            await resolve.resolveBakelet(bakeletsPath, remotesPath, yml, testBakeDir, false, null, remoteSSHConfig);
        } catch (err) {
        } finally {
            Ssh.sshExec = origSshExec;
            Ssh.copyFromHostToVM = origCopy;
            Ansible.runAnsiblePlaybook = origRunAnsiblePlaybook;
            Ansible.runRemotePlaybook = origRemotePlaybook;
        }

        expect(remotePlaybookCalled).to.be.true;
    });

    it('should restore original Ansible methods after install', async function() {
        const resolve = require('../../lib/bakelets/resolve');
        const origSshExec = Ssh.sshExec;
        const origRunAnsiblePlaybook = Ansible.runAnsiblePlaybook;
        const origRunRemotePlaybook = Ansible.runRemotePlaybook;

        Ssh.sshExec = async () => {};
        Ansible.runAnsiblePlaybook = async () => {};
        Ansible.runRemotePlaybook = async () => {};

        const remoteSSHConfig = makeRemoteSSHConfig();
        const yml = {
            name: 'test-remote-restore',
            env: [{BAKER_VAR: 'test'}]
        };

        const before = Ansible.runAnsiblePlaybook;

        try {
            await resolve.resolveBakelet(bakeletsPath, remotesPath, yml, testBakeDir, false, null, remoteSSHConfig);
        } catch (err) {
        } finally {
            Ssh.sshExec = origSshExec;
        }

        expect(Ansible.runAnsiblePlaybook).to.equal(before);
        Ansible.runAnsiblePlaybook = origRunAnsiblePlaybook;
        Ansible.runRemotePlaybook = origRunRemotePlaybook;
    });
});

describe('control-VM coupling is gone from the retained commands', function() {
    const fs = require('fs-extra');
    const path = require('path');
    const root = path.join(__dirname, '..', '..');

    const source = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

    it('bake.js no longer requires the baker-srv servers module', function() {
        expect(source('lib/commands/bake.js')).to.not.contain('modules/servers');
    });

    it('destroy.js no longer requires the baker-srv servers module', function() {
        expect(source('lib/commands/destroy.js')).to.not.contain('modules/servers');
    });

    it('neither command installs a baker server', function() {
        expect(source('lib/commands/bake.js')).to.not.contain('installBakerServer');
        expect(source('lib/commands/destroy.js')).to.not.contain('installBakerServer');
    });

    it('bake.js no longer forwards ports through the control VM', function() {
        expect(source('lib/commands/bake.js')).to.not.contain('exposePorts');
    });

    it('bake.js no longer calls the never-implemented bakeRemote', function() {
        expect(source('lib/commands/bake.js')).to.not.contain('bakeRemote');
    });

    it('the --forceVirtualBox flag is gone from both commands', function() {
        expect(source('lib/commands/bake.js')).to.not.contain('forceVirtualBox');
        expect(source('lib/commands/destroy.js')).to.not.contain('forceVirtualBox');
    });

    it('the removed provider modules are no longer resolvable', function() {
        ['virtualbox', 'vagrant', 'runc', 'digitalocean', 'docker'].forEach((name) => {
            expect(
                fs.existsSync(path.join(root, 'lib', 'modules', 'providers', `${name}.js`)),
                `providers/${name}.js should have been deleted`
            ).to.be.false;
        });
    });

    it('keeps the three providers the scope reduction retained', function() {
        ['local', 'remote', 'docker-local'].forEach((name) => {
            expect(
                fs.existsSync(path.join(root, 'lib', 'modules', 'providers', `${name}.js`)),
                `providers/${name}.js should still exist`
            ).to.be.true;
        });
    });
});
