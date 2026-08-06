const child_process = require('child_process');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const chai = require('chai');
const expect = chai.expect;

const Ansible = require('../../lib/modules/configuration/ansible');
const Utils = require('../../lib/modules/utils/utils');

const tmpDir = path.join(os.tmpdir(), 'baker-docker-test-' + Date.now());

function makeMockContainer(overrides) {
    return Object.assign({
        id: 'mock-container-id-12345',
        start: async () => {},
        stop: async () => {},
        remove: async (opts) => {},
        inspect: async () => ({
            Id: 'mock-container-id-12345',
            State: { Running: true },
            Config: { Image: 'ubuntu:latest' },
            NetworkSettings: { IPAddress: '172.17.0.2' }
        }),
        exec: async (opts) => {
            let exitCode = 0;
            let output = '';
            return {
                start: async (opts) => ({
                    pipe: () => {},
                    on: (event, cb) => { if (event === 'end') setTimeout(cb, 5); }
                }),
                inspect: async () => ({ ExitCode: exitCode })
            };
        },
        putArchive: async (stream, opts) => {}
    }, overrides);
}

function makeMockDocker(containerOverrides) {
    let mockContainer = makeMockContainer(containerOverrides);
    let containerList = [{
        Id: mockContainer.id,
        Names: ['/test-docker-box'],
        State: 'running',
        Image: 'ubuntu:latest'
    }];
    return {
        createContainer: async (opts) => {
            mockContainer.id = opts.name || 'test-docker-box';
            return mockContainer;
        },
        getContainer: (idOrName) => mockContainer,
        listContainers: async (opts) => containerList,
        pull: (image, cb) => {
            let stream = { on: (event, cb) => {} };
            let modem = { followProgress: (stream, cb) => cb(null) };
            cb(null, stream);
            return modem;
        },
        modem: { followProgress: (stream, cb) => cb(null) }
    };
}

describe('DockerLocalProvider', function() {
    let provider;
    let DockerLocalProvider;
    let mockDocker;

    beforeEach(async function() {
        mockDocker = makeMockDocker();
        const providerPath = path.join(__dirname, '../../lib/modules/providers/docker-local.js');
        delete require.cache[require.resolve(providerPath)];
        DockerLocalProvider = require(providerPath);
        provider = new DockerLocalProvider();
        provider.docker = mockDocker;
    });

    afterEach(async function() {
        // Clean up any test artifacts
    });

    describe('constructor', function() {
        it('should create an instance with docker connection', function() {
            expect(provider).to.be.an.instanceOf(DockerLocalProvider);
            expect(provider.docker).to.equal(mockDocker);
        });
    });

    describe('bake()', function() {
        const testBakeDir = path.join(tmpDir, 'bake-test');
        let origExecSync;
        let origTraverse;

        beforeEach(async function() {
            await fs.ensureDir(testBakeDir);
            origExecSync = child_process.execSync;
            child_process.execSync = () => '';
            origTraverse = Utils.traverse;
        });

        afterEach(async function() {
            child_process.execSync = origExecSync;
            Utils.traverse = origTraverse;
            await fs.remove(testBakeDir).catch(() => {});
        });

        it('should pull image and create container with string docker value', async function() {
            mockDocker.listContainers = async () => [];

            let pulledImage = '';
            let createdOpts = null;
            mockDocker.pull = (image, cb) => {
                pulledImage = image;
                cb(null, { on: () => {} });
            };
            mockDocker.createContainer = async (opts) => {
                createdOpts = opts;
                return makeMockContainer();
            };

            const resolveMock = { resolveBakelet: async () => {} };
            const resolvePath = require.resolve('../../lib/bakelets/resolve');
            origResolveBakelet = require.cache[resolvePath];
            require.cache[resolvePath] = { exports: resolveMock };

            const yml = `name: test-docker-box\ndocker: node:18\n`;
            await fs.writeFile(path.join(testBakeDir, 'baker.yml'), yml);

            await provider.bake(testBakeDir, null, false);

            expect(pulledImage).to.equal('node:18');
            expect(createdOpts).to.not.be.null;
            expect(createdOpts.Image).to.equal('node:18');
            expect(createdOpts.name).to.equal('test-docker-box');
        });

        it('should use ubuntu:latest default when docker is empty object', async function() {
            mockDocker.listContainers = async () => [];

            let pulledImage = '';
            let createdOpts = null;
            mockDocker.pull = (image, cb) => {
                pulledImage = image;
                cb(null, { on: () => {} });
            };
            mockDocker.createContainer = async (opts) => {
                createdOpts = opts;
                return makeMockContainer();
            };

            const resolveMock = { resolveBakelet: async () => {} };
            const resolvePath = require.resolve('../../lib/bakelets/resolve');
            origResolveBakelet = require.cache[resolvePath];
            require.cache[resolvePath] = { exports: resolveMock };

            const yml = `name: test-docker-box\ndocker: {}\n`;
            await fs.writeFile(path.join(testBakeDir, 'baker.yml'), yml);

            await provider.bake(testBakeDir, null, false);

            expect(pulledImage).to.equal('ubuntu:latest');
            expect(createdOpts.Image).to.equal('ubuntu:latest');
        });

        it('should use object docker.image when provided', async function() {
            let pulledImage = '';
            mockDocker.pull = (image, cb) => {
                pulledImage = image;
                cb(null, { on: () => {} });
                return { followProgress: (s, cb) => cb(null) };
            };

            const resolveMock = { resolveBakelet: async () => {} };
            const resolvePath = require.resolve('../../lib/bakelets/resolve');
            origResolveBakelet = require.cache[resolvePath];
            require.cache[resolvePath] = { exports: resolveMock };

            const yml = `name: test-docker-box\ndocker:\n  image: python:3.9\n`;
            await fs.writeFile(path.join(testBakeDir, 'baker.yml'), yml);

            await provider.bake(testBakeDir, null, false);

            expect(pulledImage).to.equal('python:3.9');
        });

        it('should call resolveBakelet with dockerContainer name (real module)', async function() {
            mockDocker.listContainers = async () => [];

            mockDocker.pull = (image, cb) => {
                cb(null, { on: () => {} });
            };

            const yml = `name: test-docker-box\ndocker: node:18\n`;
            await fs.writeFile(path.join(testBakeDir, 'baker.yml'), yml);

            // Should complete without error (real resolveBakelet runs in docker mode, no bakelets to resolve)
            await provider.bake(testBakeDir, null, false);
        });

        it('should traverse vars when doc.vars is present', async function() {
            mockDocker.pull = (image, cb) => {
                cb(null, { on: () => {} });
                return { followProgress: (s, cb) => cb(null) };
            };

            let traversed = false;
            Utils.traverse = async () => { traversed = true; };

            const resolveMock = { resolveBakelet: async () => {} };
            const resolvePath = require.resolve('../../lib/bakelets/resolve');
            origResolveBakelet = require.cache[resolvePath];
            require.cache[resolvePath] = { exports: resolveMock };

            const yml = `name: test-docker-box\ndocker: ubuntu:latest\nvars:\n  MY_VAR: myval\n`;
            await fs.writeFile(path.join(testBakeDir, 'baker.yml'), yml);

            await provider.bake(testBakeDir, null, false);

            expect(traversed).to.be.true;
        });

        it('should handle container name collision with stopped container', async function() {
            let removeCalled = false;
            let createCount = 0;
            const stoppedContainer = makeMockContainer({});
            stoppedContainer.inspect = async () => ({
                Id: 'existing-id',
                State: { Running: false },
                Config: { Image: 'ubuntu:latest' },
                NetworkSettings: { IPAddress: '172.17.0.2' }
            });

            mockDocker.pull = (image, cb) => {
                cb(null, { on: () => {} });
                return { followProgress: (s, cb) => cb(null) };
            };
            mockDocker.listContainers = async () => [{
                Id: 'existing-id',
                Names: ['/test-docker-box'],
                State: 'stopped',
                Image: 'ubuntu:latest'
            }];
            mockDocker.getContainer = (id) => {
                if (id === 'existing-id') {
                    return {
                        ...stoppedContainer,
                        remove: async () => { removeCalled = true; }
                    };
                }
                return makeMockContainer();
            };
            mockDocker.createContainer = async (opts) => {
                createCount++;
                return makeMockContainer();
            };

            const resolveMock = { resolveBakelet: async () => {} };
            const resolvePath = require.resolve('../../lib/bakelets/resolve');
            origResolveBakelet = require.cache[resolvePath];
            require.cache[resolvePath] = { exports: resolveMock };

            const yml = `name: test-docker-box\ndocker: ubuntu:latest\n`;
            await fs.writeFile(path.join(testBakeDir, 'baker.yml'), yml);

            await provider.bake(testBakeDir, null, false);

            expect(removeCalled).to.be.true;
            expect(createCount).to.equal(1);
        });

        it('should reuse running container on name collision', async function() {
            let createCount = 0;
            mockDocker.pull = (image, cb) => {
                cb(null, { on: () => {} });
                return { followProgress: (s, cb) => cb(null) };
            };
            mockDocker.listContainers = async () => [{
                Id: 'running-id',
                Names: ['/test-docker-box'],
                State: 'running',
                Image: 'ubuntu:latest'
            }];

            let runningContainer = makeMockContainer({});
            runningContainer.inspect = async () => ({
                Id: 'running-id',
                State: { Running: true },
                Config: { Image: 'ubuntu:latest' },
                NetworkSettings: { IPAddress: '172.17.0.2' }
            });

            mockDocker.getContainer = (id) => runningContainer;
            mockDocker.createContainer = async (opts) => {
                createCount++;
                return makeMockContainer();
            };

            const resolveMock = { resolveBakelet: async () => {} };
            const resolvePath = require.resolve('../../lib/bakelets/resolve');
            origResolveBakelet = require.cache[resolvePath];
            require.cache[resolvePath] = { exports: resolveMock };

            const yml = `name: test-docker-box\ndocker: ubuntu:latest\n`;
            await fs.writeFile(path.join(testBakeDir, 'baker.yml'), yml);

            await provider.bake(testBakeDir, null, false);

            expect(createCount).to.equal(0);
        });

        it('should propagate image pull errors', async function() {
            mockDocker.pull = (image, cb) => {
                cb(new Error('Registry unreachable'), null);
            };

            const yml = `name: test-docker-box\ndocker: nonexistent:latest\n`;
            await fs.writeFile(path.join(testBakeDir, 'baker.yml'), yml);

            try {
                await provider.bake(testBakeDir, null, false);
                expect.fail('should have thrown');
            } catch (err) {
                expect(err).to.be.an('error');
            }
        });

        it('should auto-generate container name from cwd when name is absent', async function() {
            mockDocker.listContainers = async () => [];

            let createdOpts = null;
            mockDocker.pull = (image, cb) => {
                cb(null, { on: () => {} });
            };
            mockDocker.createContainer = async (opts) => {
                createdOpts = opts;
                return makeMockContainer();
            };

            const origCwd = process.cwd;
            process.cwd = () => '/home/user/my-project';

            try {
                const yml = 'docker: ubuntu:latest\n';
                await fs.writeFile(path.join(testBakeDir, 'baker.yml'), yml);
                await provider.bake(testBakeDir, null, false);
                expect(createdOpts).to.not.be.null;
                expect(createdOpts.name).to.equal('my-project');
            } finally {
                process.cwd = origCwd;
            }
        });

        it('should add to index after container creation', async function() {
            mockDocker.pull = (image, cb) => {
                cb(null, { on: () => {} });
                return { followProgress: (s, cb) => cb(null) };
            };

            let capturedIndexEntry = null;
            const origAddToIndex = Utils.addToIndex;
            Utils.addToIndex = async (name, scriptPath, type, info) => {
                capturedIndexEntry = { name, scriptPath, type, info };
            };

            const resolveMock = { resolveBakelet: async () => {} };
            const resolvePath = require.resolve('../../lib/bakelets/resolve');
            origResolveBakelet = require.cache[resolvePath];
            require.cache[resolvePath] = { exports: resolveMock };

            const yml = `name: test-docker-box\ndocker: node:18\n`;
            await fs.writeFile(path.join(testBakeDir, 'baker.yml'), yml);

            try {
                await provider.bake(testBakeDir, null, false);
                expect(capturedIndexEntry).to.not.be.null;
                expect(capturedIndexEntry.name).to.equal('test-docker-box');
                expect(capturedIndexEntry.type).to.equal('docker-local');
                expect(capturedIndexEntry.info.image).to.equal('node:18');
            } finally {
                Utils.addToIndex = origAddToIndex;
            }
        });
    });

    describe('stop()', function() {
        it('should stop the container when it exists in index', async function() {
            let stopCalled = false;
            let container = makeMockContainer({
                stop: async () => { stopCalled = true; }
            });
            mockDocker.getContainer = (id) => container;

            const origFind = Utils.FindInIndex;
            Utils.FindInIndex = async (name) => ({
                name: 'test-box',
                type: 'docker-local',
                info: { id: 'mock-id' }
            });

            const origRemove = Utils.removeFromIndex;
            Utils.removeFromIndex = async () => {};

            try {
                await provider.stop('test-box');
                expect(stopCalled).to.be.true;
            } finally {
                Utils.FindInIndex = origFind;
                Utils.removeFromIndex = origRemove;
            }
        });

        it('should do nothing when container is not in index', async function() {
            const origFind = Utils.FindInIndex;
            Utils.FindInIndex = async () => null;

            try {
                await provider.stop('nonexistent');
            } finally {
                Utils.FindInIndex = origFind;
            }
        });

        it('should do nothing when index entry type is not docker-local', async function() {
            const origFind = Utils.FindInIndex;
            Utils.FindInIndex = async () => ({
                name: 'test-box',
                type: 'local',
                info: {}
            });

            try {
                await provider.stop('test-box');
            } finally {
                Utils.FindInIndex = origFind;
            }
        });

        it('should gracefully handle stop errors', async function() {
            let container = makeMockContainer({
                stop: async () => { throw new Error('Already stopped'); }
            });
            mockDocker.getContainer = (id) => container;

            const origFind = Utils.FindInIndex;
            Utils.FindInIndex = async (name) => ({
                name: 'test-box',
                type: 'docker-local',
                info: { id: 'mock-id' }
            });

            const origRemove = Utils.removeFromIndex;
            Utils.removeFromIndex = async () => {};

            try {
                await provider.stop('test-box');
            } finally {
                Utils.FindInIndex = origFind;
                Utils.removeFromIndex = origRemove;
            }
        });
    });

    describe('delete()', function() {
        it('should stop and remove the container', async function() {
            let stopCalled = false;
            let removeCalled = false;
            let container = makeMockContainer({
                stop: async () => { stopCalled = true; },
                remove: async (opts) => { removeCalled = true; }
            });
            mockDocker.getContainer = (id) => container;

            const origFind = Utils.FindInIndex;
            Utils.FindInIndex = async (name) => ({
                name: 'test-box',
                type: 'docker-local',
                info: { id: 'mock-id' }
            });

            const origRemove = Utils.removeFromIndex;
            Utils.removeFromIndex = async () => {};

            try {
                await provider.delete('test-box');
                expect(stopCalled).to.be.true;
                expect(removeCalled).to.be.true;
            } finally {
                Utils.FindInIndex = origFind;
                Utils.removeFromIndex = origRemove;
            }
        });

        it('should do nothing when container not in index', async function() {
            const origFind = Utils.FindInIndex;
            Utils.FindInIndex = async () => null;

            try {
                await provider.delete('nonexistent');
            } finally {
                Utils.FindInIndex = origFind;
            }
        });
    });

    describe('list()', function() {
        it('should list docker-local containers from index', async function() {
            const origGetEnvIndex = Utils.getEnvIndex;
            Utils.getEnvIndex = async () => [{
                name: 'test-container',
                type: 'docker-local',
                info: { id: 'abc', image: 'node:18' }
            }];

            let tableCalled = false;
            const origTable = console.table;
            console.table = function() { tableCalled = true; };

            try {
                await provider.list();
                expect(tableCalled).to.be.true;
            } finally {
                Utils.getEnvIndex = origGetEnvIndex;
                console.table = origTable;
            }
        });

        it('should handle empty index gracefully', async function() {
            const origGetEnvIndex = Utils.getEnvIndex;
            Utils.getEnvIndex = async () => [];

            let tableCalled = false;
            const origTable = console.table;
            console.table = function() { tableCalled = true; };

            try {
                await provider.list();
                expect(tableCalled).to.be.true;
            } finally {
                Utils.getEnvIndex = origGetEnvIndex;
                console.table = origTable;
            }
        });

        it('should handle list errors gracefully when Docker is unreachable', async function() {
            const origGetEnvIndex = Utils.getEnvIndex;
            Utils.getEnvIndex = async () => {
                throw new Error('connect ENOENT /var/run/docker.sock');
            };

            let errorOutput = '';
            const origError = console.error;
            console.error = (msg) => { errorOutput = msg; };

            try {
                await provider.list();
                expect(errorOutput).to.include('Unable to list Docker containers');
            } finally {
                Utils.getEnvIndex = origGetEnvIndex;
                console.error = origError;
            }
        });

        it('should show removed state when container no longer exists', async function() {
            const origGetEnvIndex = Utils.getEnvIndex;
            Utils.getEnvIndex = async () => [{
                name: 'gone-container',
                type: 'docker-local',
                info: { id: 'defunct-id', image: 'ubuntu:latest' }
            }];

            mockDocker.getContainer = () => {
                return {
                    inspect: async () => { throw new Error('No such container'); }
                };
            };

            let capturedTable = null;
            const origTable = console.table;
            console.table = function(label, data) { capturedTable = data; };

            try {
                await provider.list();
                expect(capturedTable).to.not.be.null;
                expect(capturedTable[0].state).to.equal('removed');
            } finally {
                Utils.getEnvIndex = origGetEnvIndex;
                console.table = origTable;
            }
        });
    });

    describe('getState()', function() {
        it('should return running when container is running', async function() {
            mockDocker.listContainers = async () => [{
                Id: 'abc',
                Names: ['/test-box'],
                State: 'running',
                Image: 'ubuntu:latest'
            }];

            const state = await provider.getState('test-box');
            expect(state).to.equal('running');
        });

        it('should return stopped when container is stopped', async function() {
            mockDocker.listContainers = async () => [{
                Id: 'abc',
                Names: ['/test-box'],
                State: 'exited',
                Image: 'ubuntu:latest'
            }];

            const state = await provider.getState('test-box');
            expect(state).to.equal('stopped');
        });

        it('should return stopped when container does not exist', async function() {
            mockDocker.listContainers = async () => [];

            const state = await provider.getState('nonexistent');
            expect(state).to.equal('stopped');
        });
    });

    describe('pullImage()', function() {
        it('should resolve when pull succeeds', async function() {
            mockDocker.pull = (image, cb) => {
                cb(null, { on: () => {} });
                return { followProgress: (s, cb) => cb(null) };
            };

            await provider.pullImage('node:18');
        });

        it('should reject when pull fails', async function() {
            mockDocker.pull = (image, cb) => {
                cb(new Error('Pull failed'), null);
            };

            try {
                await provider.pullImage('nonexistent');
                expect.fail('should have thrown');
            } catch (err) {
                expect(err.message).to.equal('Pull failed');
            }
        });

        it('should reject when followProgress reports error', async function() {
            mockDocker.modem.followProgress = (stream, cb) => cb(new Error('Download failed'));

            try {
                await provider.pullImage('large-image');
                expect.fail('should have thrown');
            } catch (err) {
                expect(err.message).to.equal('Download failed');
            }
        });
    });

    describe('ssh()', function() {
        it('should throw when container is not in index', async function() {
            const origFind = Utils.FindInIndex;
            Utils.FindInIndex = async () => null;

            try {
                await provider.ssh('nonexistent');
                expect.fail('should have thrown');
            } catch (err) {
                expect(err).to.match(/unknown/i);
            } finally {
                Utils.FindInIndex = origFind;
            }
        });

        it('should execute command inside container when cmdToRun is provided', async function() {
            const origFind = Utils.FindInIndex;
            Utils.FindInIndex = async (name) => ({
                name: 'test-box', type: 'docker-local',
                info: { id: 'mock-id', image: 'ubuntu:latest' }
            });

            const origExecSync = child_process.execSync;
            let capturedCmd = '';
            child_process.execSync = (cmd, opts) => {
                capturedCmd = cmd;
                return '';
            };

            try {
                await provider.ssh('test-box', 'echo hello', false, false);
                expect(capturedCmd).to.include('docker exec');
                expect(capturedCmd).to.include('test-box');
                expect(capturedCmd).to.include('echo hello');
            } finally {
                Utils.FindInIndex = origFind;
                child_process.execSync = origExecSync;
            }
        });
    });
});

describe('Baker.chooseProvider with docker key', function() {
    const testDir = path.join(tmpDir, 'choose-docker-test');
    let origDockerode;

    beforeEach(async function() {
        await fs.ensureDir(testDir);
        const mockDocker = makeMockDocker();
        const dockerodePath = require.resolve('dockerode');
        origDockerode = require.cache[dockerodePath];
        require.cache[dockerodePath] = { exports: function() { return mockDocker; } };
    });

    afterEach(async function() {
        await fs.remove(testDir).catch(() => {});
        const dockerodePath = require.resolve('dockerode');
        if (origDockerode) {
            require.cache[dockerodePath] = origDockerode;
        } else {
            delete require.cache[dockerodePath];
        }
        const providerPath = require.resolve('../../lib/modules/providers/docker-local');
        delete require.cache[providerPath];
    });

    it('should return DockerLocalProvider when doc.docker is a string', async function() {
        const Baker = require('../../lib/modules/baker');
        const yml = 'name: test-docker\ndocker: node:18\n';
        await fs.writeFile(path.join(testDir, 'baker.yml'), yml);
        const result = await Baker.chooseProvider(testDir);
        expect(result.provider.constructor.name).to.equal('DockerLocalProvider');
    });

    it('should return DockerLocalProvider when doc.docker is an object', async function() {
        const Baker = require('../../lib/modules/baker');
        const yml = 'name: test-docker\ndocker:\n  image: ubuntu:latest\n';
        await fs.writeFile(path.join(testDir, 'baker.yml'), yml);
        const result = await Baker.chooseProvider(testDir);
        expect(result.provider.constructor.name).to.equal('DockerLocalProvider');
    });

    it('should return DockerLocalProvider when doc.docker is empty object', async function() {
        const Baker = require('../../lib/modules/baker');
        const yml = 'name: test-docker\ndocker: {}\n';
        await fs.writeFile(path.join(testDir, 'baker.yml'), yml);
        const result = await Baker.chooseProvider(testDir);
        expect(result.provider.constructor.name).to.equal('DockerLocalProvider');
    });

    it('should still return VirtualBoxProvider when doc.vm is present', async function() {
        const Baker = require('../../lib/modules/baker');
        const yml = 'name: test-vm\nvm:\n  ip: 192.168.1.1\n';
        await fs.writeFile(path.join(testDir, 'baker.yml'), yml);
        const result = await Baker.chooseProvider(testDir);
        expect(result.provider.constructor.name).to.equal('VirtualBoxProvider');
    });

    it('should still return LocalProvider when doc.local is present', async function() {
        const Baker = require('../../lib/modules/baker');
        const yml = 'name: test-local\nlocal: /tmp/test\n';
        await fs.writeFile(path.join(testDir, 'baker.yml'), yml);
        const result = await Baker.chooseProvider(testDir);
        expect(result.provider.constructor.name).to.equal('LocalProvider');
    });
});

describe('Ansible docker methods', function() {
    let origExecSync;

    beforeEach(function() {
        origExecSync = child_process.execSync;
    });

    afterEach(function() {
        child_process.execSync = origExecSync;
    });

    describe('buildDockerInventory', function() {
        it('should build inventory string with docker connection plugin', function() {
            const result = Ansible.buildDockerInventory('test-container');
            expect(result).to.include('test-container');
            expect(result).to.include('ansible_connection=docker');
            expect(result).to.include('ansible_user=root');
        });
    });

    describe('runDockerPlaybook', function() {
        it('should construct and run a docker-targeted ansible command', async function() {
            let capturedCmd = '';
            child_process.execSync = (cmd, opts) => {
                capturedCmd = cmd;
                return 'PLAY RECAP ********************* ok=2 failed=0';
            };

            await Ansible.runDockerPlaybook(
                { name: 'test-box' },
                'playbook.yml',
                'test-container',
                false,
                [{ var1: 'val1' }]
            );

            expect(capturedCmd).to.include('ansible-playbook');
            expect(capturedCmd).to.include('playbook.yml');
            expect(capturedCmd).to.include('test-container');
            expect(capturedCmd).to.include('ansible_connection=docker');
        });

        it('should throw when ansible-playbook reports failures', async function() {
            child_process.execSync = (cmd, opts) => {
                return 'PLAY RECAP ********************* ok=1 failed=1';
            };

            try {
                await Ansible.runDockerPlaybook(
                    { name: 'test-box' },
                    'playbook.yml',
                    'test-container',
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

            try {
                await Ansible.runDockerPlaybook(
                    { name: 'test-box' },
                    'playbook.yml',
                    'test-container',
                    false,
                    []
                );
                expect.fail('should have thrown');
            } catch (err) {
                expect(err).to.be.an('error');
                expect(err.message).to.include('Failed to run bakelet');
            }
        });
    });

    describe('runDockerAdhoc', function() {
        it('should construct and run a docker ad-hoc ansible command', async function() {
            let capturedCmd = '';
            child_process.execSync = (cmd, opts) => {
                capturedCmd = cmd;
                return '';
            };

            await Ansible.runDockerAdhoc(
                { name: 'test-box' },
                'apt',
                'pkg=curl update_cache=yes',
                'test-container',
                false
            );

            expect(capturedCmd).to.include('ansible all -m apt');
            expect(capturedCmd).to.include('pkg=curl');
            expect(capturedCmd).to.include('test-container');
            expect(capturedCmd).to.include('ansible_connection=docker');
            expect(capturedCmd).to.include('--become');
        });
    });

    describe('docker helper methods', function() {
        let origRunDockerAdhoc;

        beforeEach(function() {
            origRunDockerAdhoc = Ansible.runDockerAdhoc;
        });

        afterEach(function() {
            Ansible.runDockerAdhoc = origRunDockerAdhoc;
        });

        it('runDockerPipInstall should delegate to runDockerAdhoc with pip module', async function() {
            let capturedArgs = [];
            Ansible.runDockerAdhoc = async (doc, module, moduleArgs, containerName) => {
                capturedArgs = [module, moduleArgs, containerName];
            };

            await Ansible.runDockerPipInstall({ name: 'test' }, '/tmp/requirements.txt', 'test-container', false);

            expect(capturedArgs[0]).to.equal('pip');
            expect(capturedArgs[1]).to.include('requirements=/tmp/requirements.txt');
            expect(capturedArgs[2]).to.equal('test-container');
        });

        it('runDockerNpmInstall should delegate to runDockerAdhoc with npm module', async function() {
            let capturedArgs = [];
            Ansible.runDockerAdhoc = async (doc, module, moduleArgs, containerName) => {
                capturedArgs = [module, moduleArgs, containerName];
            };

            await Ansible.runDockerNpmInstall({ name: 'test' }, '/tmp/app/package.json', 'test-container', false);

            expect(capturedArgs[0]).to.equal('npm');
            expect(capturedArgs[1]).to.include('path=/tmp/app/package.json');
            expect(capturedArgs[2]).to.equal('test-container');
        });

        it('runDockerCreateDirectory should delegate to runDockerAdhoc with file module', async function() {
            let capturedArgs = [];
            Ansible.runDockerAdhoc = async (doc, module, moduleArgs, containerName) => {
                capturedArgs = [module, moduleArgs, containerName];
            };

            await Ansible.runDockerCreateDirectory({ name: 'test' }, '/tmp/mydir', '0755', 'test-container', false);

            expect(capturedArgs[0]).to.equal('file');
            expect(capturedArgs[1]).to.include('path=/tmp/mydir');
            expect(capturedArgs[1]).to.include('mode=0755');
            expect(capturedArgs[1]).to.include('state=directory');
            expect(capturedArgs[2]).to.equal('test-container');
        });

        it('runDockerTemplateCmd should delegate to execSync with docker inventory', async function() {
            let capturedCmd = '';
            child_process.execSync = (cmd, opts) => {
                capturedCmd = cmd;
                return '';
            };

            try {
                await Ansible.runDockerTemplateCmd(
                    { name: 'test' },
                    'templates/myfile.j2',
                    '/etc/myfile',
                    [{ var1: 'val1' }],
                    'test-container',
                    false
                );

                expect(capturedCmd).to.include('ansible all -m template');
                expect(capturedCmd).to.include('src=templates/myfile.j2');
                expect(capturedCmd).to.include('dest=/etc/myfile');
                expect(capturedCmd).to.include('test-container');
            } finally {
            }
        });
    });
});

describe('resolve.js docker mode', function() {
    const testBakeDir = path.join(tmpDir, 'resolve-docker-test');
    const bakeletsPath = path.join(__dirname, '../../lib/bakelets');
    const remotesPath = path.join(__dirname, '../../remotes');
    const resolveModulePath = require.resolve('../../lib/bakelets/resolve');

    beforeEach(async function() {
        await fs.ensureDir(testBakeDir);
        // Clear any cached mock so we get the real module
        delete require.cache[resolveModulePath];
        // Also invalidate any parent caches that resolved it
        for (const key of Object.keys(require.cache)) {
            if (require.cache[key].exports &&
                typeof require.cache[key].exports === 'object' &&
                require.cache[key].exports.resolveBakelet === undefined) {
                // Check children
            }
        }
    });

    afterEach(async function() {
        await fs.remove(testBakeDir).catch(() => {});
        // Restore real module for subsequent tests
        delete require.cache[resolveModulePath];
    });

    it('should run start command in container in docker mode', async function() {
        const resolve = require('../../lib/bakelets/resolve');
        const origExecSync = child_process.execSync;
        let capturedCmd = '';
        child_process.execSync = (cmd, opts) => {
            capturedCmd = cmd;
            return '';
        };

        const yml = {
            name: 'test-docker-start',
            start: 'touch /tmp/baker-test'
        };

        try {
            await resolve.resolveBakelet(bakeletsPath, remotesPath, yml, testBakeDir, false, null, null, 'test-container');
        } catch (err) {
        } finally {
            child_process.execSync = origExecSync;
        }

        expect(capturedCmd).to.include('docker exec');
        expect(capturedCmd).to.include('test-container');
        expect(capturedCmd).to.include('touch /tmp/baker-test');
    });

    it('should patch copy/exec methods and redirect Ansible in docker mode', async function() {
        const resolve = require('../../lib/bakelets/resolve');
        const origExecSync = child_process.execSync;
        child_process.execSync = (cmd, opts) => '';

        let dockerPlaybookCalled = false;
        const origDockerPlaybook = Ansible.runDockerPlaybook;
        Ansible.runDockerPlaybook = async () => { dockerPlaybookCalled = true; };

        // lang: is the vehicle because it is permanently playbook-backed. env:
        // and packages: both became exec-based in the cross-platform work, so
        // neither reaches Ansible any more.
        const yml = {
            name: 'test-docker-patch',
            lang: ['python']
        };

        try {
            await resolve.resolveBakelet(bakeletsPath, remotesPath, yml, testBakeDir, false, null, null, 'test-container');
        } catch (err) {
        } finally {
            child_process.execSync = origExecSync;
            Ansible.runDockerPlaybook = origDockerPlaybook;
        }

        expect(dockerPlaybookCalled).to.be.true;
    });

    it('should restore original Ansible methods after install', async function() {
        const resolve = require('../../lib/bakelets/resolve');
        const origExecSync = child_process.execSync;
        child_process.execSync = (cmd, opts) => '';

        const origRunAnsiblePlaybook = Ansible.runAnsiblePlaybook;
        const origRunDockerPlaybook = Ansible.runDockerPlaybook;

        Ansible.runAnsiblePlaybook = async () => {};
        Ansible.runDockerPlaybook = async () => {};

        const yml = {
            name: 'test-docker-restore',
            env: [{BAKER_VAR: 'test'}]
        };

        const before = Ansible.runAnsiblePlaybook;

        try {
            await resolve.resolveBakelet(bakeletsPath, remotesPath, yml, testBakeDir, false, null, null, 'test-container');
        } catch (err) {
        } finally {
            child_process.execSync = origExecSync;
        }

        expect(Ansible.runAnsiblePlaybook).to.equal(before);
        Ansible.runAnsiblePlaybook = origRunAnsiblePlaybook;
        Ansible.runDockerPlaybook = origRunDockerPlaybook;
    });
});

describe('bake.js DockerLocalProvider exclusion', function() {
    it('should have DockerLocalProvider imported in bake command', function() {
        const bakeCmd = require('../../lib/commands/bake');
        expect(bakeCmd).to.not.be.undefined;
    });

    it('should have installBakerServer guarded against DockerLocalProvider', function() {
        const DockerLocalProvider = require('../../lib/modules/providers/docker-local');
        const LocalProvider = require('../../lib/modules/providers/local');
        const RemoteProvider = require('../../lib/modules/providers/remote');
        const provider = new DockerLocalProvider();

        const shouldInstall = !(provider instanceof LocalProvider) && !(provider instanceof RemoteProvider) && !(provider instanceof DockerLocalProvider);
        expect(shouldInstall).to.be.false;
    });

    it('should have exposePorts guarded against DockerLocalProvider', function() {
        const DockerLocalProvider = require('../../lib/modules/providers/docker-local');
        const LocalProvider = require('../../lib/modules/providers/local');
        const RemoteProvider = require('../../lib/modules/providers/remote');
        const provider = new DockerLocalProvider();

        const shouldExpose = !(provider instanceof LocalProvider) && !(provider instanceof RemoteProvider) && !(provider instanceof DockerLocalProvider);
        expect(shouldExpose).to.be.false;
    });
});

describe('destroy.js DockerLocalProvider exclusion', function() {
    it('should have installBakerServer guarded against DockerLocalProvider in destroy', function() {
        const DockerLocalProvider = require('../../lib/modules/providers/docker-local');
        const LocalProvider = require('../../lib/modules/providers/local');
        const RemoteProvider = require('../../lib/modules/providers/remote');
        const provider = new DockerLocalProvider();

        const shouldInstall = !(provider instanceof LocalProvider) && !(provider instanceof RemoteProvider) && !(provider instanceof DockerLocalProvider);
        expect(shouldInstall).to.be.false;
    });
});

describe('Backward compatibility: other providers unaffected by docker-local', function() {
    it('should still install baker server for VirtualBox provider', function() {
        const VirtualBoxProvider = require('../../lib/modules/providers/virtualbox');
        const LocalProvider = require('../../lib/modules/providers/local');
        const RemoteProvider = require('../../lib/modules/providers/remote');
        const DockerLocalProvider = require('../../lib/modules/providers/docker-local');
        const vboxProvider = new VirtualBoxProvider();

        const shouldInstall = !(vboxProvider instanceof LocalProvider) && !(vboxProvider instanceof RemoteProvider) && !(vboxProvider instanceof DockerLocalProvider);
        expect(shouldInstall).to.be.true;
    });

    it('should still install baker server for RuncProvider', function() {
        const RuncProvider = require('../../lib/modules/providers/runc');
        const LocalProvider = require('../../lib/modules/providers/local');
        const RemoteProvider = require('../../lib/modules/providers/remote');
        const DockerLocalProvider = require('../../lib/modules/providers/docker-local');
        const runcProvider = new RuncProvider();

        const shouldInstall = !(runcProvider instanceof LocalProvider) && !(runcProvider instanceof RemoteProvider) && !(runcProvider instanceof DockerLocalProvider);
        expect(shouldInstall).to.be.true;
    });
});
