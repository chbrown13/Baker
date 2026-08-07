const fs     = require('fs-extra');
const os     = require('os');
const path   = require('path');
const chai   = require('chai');
const expect = chai.expect;

const Maven    = require('../../lib/bakelets/tools/maven');
const AnsibleT = require('../../lib/bakelets/tools/ansible');
const Jupyter  = require('../../lib/bakelets/tools/jupyter');
const Latex    = require('../../lib/bakelets/tools/latex');
const Template = require('../../lib/bakelets/config/template');

const LINUX   = { os: 'linux', manager: 'apt', shell: 'sh', family: 'debian', sudo: true };
const ROOT    = { os: 'linux', manager: 'apt', shell: 'sh', family: 'debian', sudo: false };
const FEDORA  = { os: 'linux', manager: 'dnf', shell: 'sh', family: 'rhel', sudo: true };
const MACOS   = { os: 'macos', manager: 'brew', shell: 'sh', family: 'darwin', sudo: false };
const WINDOWS = { os: 'windows', manager: 'choco', shell: 'powershell', family: 'nt', sudo: false };

async function run(Klass, platform, entry) {
    const bakelet = new Klass('testenv', null, '');
    bakelet.platform = platform;
    bakelet.setBakeletName(Klass.name.toLowerCase());
    const calls = [];
    bakelet.exec = async (cmd) => { calls.push(cmd); };
    await bakelet.load(entry, []);
    await bakelet.install();
    return calls;
}

describe('exec-based tools: bakelets', function() {

    describe('maven', function() {

        it('installs the maven package with an idempotency guard', async function() {
            const calls = await run(Maven, LINUX, 'maven');
            expect(calls).to.have.lengthOf(1);
            expect(calls[0]).to.contain('command -v mvn');
            expect(calls[0]).to.contain('sudo apt-get install -y maven');
        });

        it('uses the detected manager', async function() {
            expect((await run(Maven, FEDORA, 'maven'))[0]).to.contain('sudo dnf install -y maven');
        });

        it('drops the sudo prefix when the target is root', async function() {
            const calls = await run(Maven, ROOT, 'maven');
            expect(calls[0]).to.contain('apt-get install -y maven');
            expect(calls[0]).to.not.match(/\bsudo\b/);
        });

        it('never runs brew under sudo', async function() {
            expect((await run(Maven, MACOS, 'maven'))[0]).to.not.match(/\bsudo\b/);
        });

        it('uses PowerShell constructs on Windows', async function() {
            const calls = await run(Maven, WINDOWS, 'maven');
            expect(calls[0]).to.contain('Get-Command mvn');
            expect(calls[0]).to.contain('choco install -y maven');
            expect(calls[0]).to.not.contain('||');
        });

        it('requires elevation except on brew and root', function() {
            const cases = [[LINUX, true], [FEDORA, true], [WINDOWS, true], [MACOS, false], [ROOT, false]];
            cases.forEach(([platform, expected]) => {
                const bakelet = new Maven('testenv', null, '');
                bakelet.platform = platform;
                expect(bakelet.requiresElevation, JSON.stringify(platform)).to.equal(expected);
            });
        });
    });

    describe('ansible (as a tool)', function() {

        it('installs from the package manager on Linux', async function() {
            expect((await run(AnsibleT, LINUX, 'ansible'))[0]).to.contain('apt-get install -y ansible');
        });

        it('refuses on Windows, where Ansible cannot be a control node', async function() {
            const bakelet = new AnsibleT('testenv', null, '');
            bakelet.platform = WINDOWS;
            bakelet.setBakeletName('ansible');
            bakelet.exec = async () => {};
            await bakelet.load('ansible', []);

            let error = null;
            try { await bakelet.install(); } catch (err) { error = err; }
            expect(error.message).to.contain('not supported on choco');
            expect(error.message).to.contain('docker:');
        });

        it('issues no command when it refuses', async function() {
            const bakelet = new AnsibleT('testenv', null, '');
            bakelet.platform = WINDOWS;
            bakelet.setBakeletName('ansible');
            const calls = [];
            bakelet.exec = async (cmd) => { calls.push(cmd); };
            await bakelet.load('ansible', []);
            try { await bakelet.install(); } catch (err) { /* expected */ }
            expect(calls).to.deep.equal([]);
        });
    });

    describe('jupyter', function() {

        it('installs through pip rather than a system package', async function() {
            const calls = await run(Jupyter, LINUX, 'jupyter');
            expect(calls[0]).to.contain('pip install --user jupyter');
        });

        it('needs no elevation on any platform, because pip --user does not', function() {
            [LINUX, FEDORA, MACOS, WINDOWS, ROOT].forEach((platform) => {
                const bakelet = new Jupyter('testenv', null, '');
                bakelet.platform = platform;
                expect(bakelet.requiresElevation, platform.manager).to.equal(false);
            });
        });

        it('uses the python launcher name Windows actually ships', async function() {
            const calls = await run(Jupyter, WINDOWS, 'jupyter');
            expect(calls[0]).to.contain('python -m pip');
            expect(calls[0]).to.not.contain('python3 -m pip');
        });

        it('uses no sudo anywhere', async function() {
            const calls = await run(Jupyter, LINUX, 'jupyter');
            expect(calls[0]).to.not.match(/\bsudo\b/);
        });
    });

    describe('latex', function() {

        it('installs a TeX distribution per manager', async function() {
            expect((await run(Latex, LINUX, 'latex'))[0]).to.contain('texlive-latex-base');
            expect((await run(Latex, FEDORA, 'latex'))[0]).to.contain('texlive-scheme-basic');
            expect((await run(Latex, MACOS, 'latex'))[0]).to.contain('basictex');
            expect((await run(Latex, WINDOWS, 'latex'))[0]).to.contain('miktex');
        });

        it('checks for pdflatex rather than a package name', async function() {
            expect((await run(Latex, LINUX, 'latex'))[0]).to.contain('command -v pdflatex');
        });
    });
});

describe('config: template', function() {
    let bakeDir;

    beforeEach(async function() {
        bakeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'baker-template-'));
    });

    afterEach(async function() {
        await fs.remove(bakeDir).catch(() => {});
    });

    async function renderWith(platform, source, variables, dest = './out.conf') {
        await fs.outputFile(path.join(bakeDir, 'in.tpl'), source);
        const bakelet = new Template('testenv', null, '');
        bakelet.platform = platform;
        bakelet.setBakePath(bakeDir);
        const calls = [];
        bakelet.exec = async (cmd) => { calls.push(cmd); };
        await bakelet.load({ template: { src: 'in.tpl', dest } }, variables);
        await bakelet.install();
        return calls;
    }

    it('interpolates variables into the rendered output', async function() {
        const calls = await renderWith(LINUX, 'greeting={{greeting}}\n', [{ greeting: 'hello' }]);
        expect(calls[0]).to.contain('greeting=hello');
    });

    it('flattens the list-of-single-key-maps the resolver passes', async function() {
        const calls = await renderWith(LINUX, '{{a}}-{{b}}', [{ a: 'one' }, { b: 'two' }]);
        expect(calls[0]).to.contain('one-two');
    });

    it('leaves an unknown placeholder empty rather than failing', async function() {
        const calls = await renderWith(LINUX, 'x={{missing}}y', []);
        expect(calls[0]).to.contain('x=y');
    });

    it('creates the destination directory on POSIX', async function() {
        const calls = await renderWith(LINUX, 'body', [], './nested/deep/out.conf');
        expect(calls[0]).to.contain('mkdir -p');
        expect(calls[0]).to.contain('nested/deep/out.conf');
    });

    it('writes with a quoted heredoc so content is never re-interpreted', async function() {
        const calls = await renderWith(LINUX, 'literal $HOME and `id`', []);
        expect(calls[0]).to.contain('<<"BAKER_TEMPLATE"');
        expect(calls[0]).to.contain('literal $HOME and `id`');
    });

    it('uses PowerShell on Windows', async function() {
        const calls = await renderWith(WINDOWS, 'body', [], './out.conf');
        expect(calls[0]).to.contain('Set-Content');
        expect(calls[0]).to.contain('New-Item -ItemType Directory');
        expect(calls[0]).to.not.contain('mkdir -p');
    });

    it('needs no elevation and no Ansible', function() {
        const bakelet = new Template('testenv', null, '');
        expect(bakelet.requiresElevation).to.equal(false);
        expect(bakelet.requiresAnsible).to.equal(false);
        expect(bakelet.needsPlatform).to.equal(true);
    });

    it('really writes the file when the commands are run (POSIX)', async function() {
        const dest = path.join(bakeDir, 'nested', 'out.conf');
        const calls = await renderWith(LINUX, 'greeting={{greeting}}\n', [{ greeting: 'hello' }], dest);
        require('child_process').execSync(calls[0], { shell: '/bin/sh' });
        expect(await fs.readFile(dest, 'utf8')).to.contain('greeting=hello');
    });
});

describe('start: does not block the bake', function() {
    const { startDetached, dockerStartCommand } = require('../../lib/bakelets/resolve');

    it('backgrounds a docker start with -d', function() {
        expect(dockerStartCommand('c1', 'npm start')).to.contain('docker exec -d ');
    });

    it('names the container and the command', function() {
        const cmd = dockerStartCommand('c1', 'npm start');
        expect(cmd).to.contain('c1');
        expect(cmd).to.contain('npm start');
    });

    it('returns before a long-running local command finishes', function() {
        const started = Date.now();
        const child = startDetached('sleep 5', os.tmpdir());
        const elapsed = Date.now() - started;
        child.kill();
        expect(elapsed, 'startDetached should not wait for the command').to.be.below(2000);
    });

    it('really runs the local command', function(done) {
        const marker = path.join(os.tmpdir(), `baker-start-${Date.now()}`);
        startDetached(`touch ${marker}`, os.tmpdir());
        setTimeout(() => {
            const existed = fs.existsSync(marker);
            fs.remove(marker).catch(() => {});
            expect(existed, 'the backgrounded command should still execute').to.be.true;
            done();
        }, 700);
    });

    it('runs the local command in the environment directory', function(done) {
        const dir = path.join(os.tmpdir(), `baker-start-cwd-${Date.now()}`);
        fs.ensureDirSync(dir);
        startDetached('touch from-cwd', dir);
        setTimeout(() => {
            const existed = fs.existsSync(path.join(dir, 'from-cwd'));
            fs.remove(dir).catch(() => {});
            expect(existed).to.be.true;
            done();
        }, 700);
    });

    it('detaches the child so it outlives the bake', function() {
        const child = startDetached('sleep 5', os.tmpdir());
        expect(child.pid).to.be.a('number');
        child.kill();
    });
});

describe('cohort toolchain bakelets', function() {
    const Node    = require('../../lib/bakelets/tools/node');
    const Opunit  = require('../../lib/bakelets/tools/opunit');
    const BakerT  = require('../../lib/bakelets/tools/baker');
    const DockerX = require('../../lib/bakelets/tools/docker-extension');

    describe('node', function() {
        it('installs the runtime and npm together on apt', async function() {
            const calls = await run(Node, LINUX, 'node');
            expect(calls[0]).to.contain('command -v node');
            expect(calls[0]).to.contain('sudo apt-get install -y nodejs npm');
        });

        it('uses the detected manager', async function() {
            expect((await run(Node, FEDORA, 'node'))[0]).to.contain('dnf install -y nodejs npm');
        });

        it('drops sudo when the target is root', async function() {
            expect((await run(Node, ROOT, 'node'))[0]).to.not.match(/\bsudo\b/);
        });

        it('never runs brew under sudo, and brew bundles npm', async function() {
            const cmd = (await run(Node, MACOS, 'node'))[0];
            expect(cmd).to.not.match(/\bsudo\b/);
            expect(cmd).to.contain('brew install node');
        });

        it('uses PowerShell constructs on Windows', async function() {
            expect((await run(Node, WINDOWS, 'node'))[0]).to.contain('Get-Command node');
        });

        it('supports every manager Baker detects', function() {
            const n = new Node('e', null, '');
            expect(Object.keys(n.commands).sort()).to.deep.equal(
                ['apk', 'apt', 'brew', 'choco', 'dnf', 'pacman', 'zypper']);
        });
    });

    describe('opunit', function() {
        it('installs through npm with an idempotency guard', async function() {
            const calls = await run(Opunit, LINUX, 'opunit');
            expect(calls[0]).to.contain('command -v opunit');
            expect(calls[0]).to.contain('npm install -g ottomatica/opunit');
        });

        it('uses the same npm line on every manager', function() {
            const o = new Opunit('e', null, '');
            const values = Object.keys(o.commands).map(k => o.commands[k]);
            expect(new Set(values).size).to.equal(1);
        });

        it('never runs npm under sudo', async function() {
            expect((await run(Opunit, LINUX, 'opunit'))[0]).to.not.match(/\bsudo\b/);
        });

        it('declares no elevation requirement', function() {
            expect(new Opunit('e', null, '').requiresElevation).to.be.false;
        });
    });

    describe('baker', function() {
        async function runBaker(platform, entry) {
            const b = new BakerT('e', null, '');
            b.platform = platform;
            b.setBakeletName('baker');
            const calls = [];
            b.exec = async (cmd) => { calls.push(cmd); };
            await b.load(entry, []);
            await b.install();
            return calls;
        }

        it('installs from an explicit source', async function() {
            const calls = await runBaker(LINUX, { baker: { source: 'your-org/Baker' } });
            expect(calls[0]).to.contain('npm install -g your-org/Baker');
        });

        it('accepts the string shorthand', async function() {
            const calls = await runBaker(LINUX, { baker: 'your-org/Baker' });
            expect(calls[0]).to.contain('npm install -g your-org/Baker');
        });

        it('guards on the baker binary', async function() {
            const calls = await runBaker(LINUX, { baker: 'your-org/Baker' });
            expect(calls[0]).to.contain('command -v baker');
        });

        it('refuses to guess a source', async function() {
            let err = null;
            try {
                await runBaker(LINUX, 'baker');
            } catch (e) { err = e; }
            expect(err, 'a sourceless baker entry should be rejected').to.not.be.null;
            expect(err.message).to.contain('needs a source');
        });

        it('explains why there is no default', async function() {
            let err = null;
            try { await runBaker(LINUX, { baker: {} }); } catch (e) { err = e; }
            expect(err.message).to.contain('unrelated package');
        });
    });

    describe('docker-extension', function() {
        function make(entry, { listFails = false } = {}) {
            const x = new DockerX('e', null, '');
            x.platform = LINUX;
            x.setBakeletName('docker-extension');
            const calls = [];
            x.exec = async (cmd) => { calls.push(cmd); };
            x.execCapture = async (cmd) => {
                if (listFails) throw new Error('Cannot connect to the Docker daemon');
                return '';
            };
            return { x, calls, entry };
        }

        it('installs the named extension, guarded by a listing check', async function() {
            const { x, calls } = make();
            await x.load({ 'docker-extension': { address: 'org/ext' } }, []);
            await x.install();
            expect(calls[0]).to.contain('docker extension ls');
            expect(calls[0]).to.contain('docker extension install org/ext');
        });

        it('accepts the string shorthand', async function() {
            const { x, calls } = make();
            await x.load({ 'docker-extension': 'org/ext' }, []);
            await x.install();
            expect(calls[0]).to.contain('org/ext');
        });

        it('fails actionably when Docker Desktop is not running', async function() {
            const { x } = make(null, { listFails: true });
            await x.load({ 'docker-extension': 'org/ext' }, []);
            let err = null;
            try { await x.install(); } catch (e) { err = e; }
            expect(err, 'an unreachable Desktop should be reported').to.not.be.null;
            expect(err.message).to.contain('Docker Desktop is not available');
        });

        it('tells the user both how to start it and how to install it', async function() {
            const { x } = make(null, { listFails: true });
            await x.load({ 'docker-extension': 'org/ext' }, []);
            let err = null;
            try { await x.install(); } catch (e) { err = e; }
            expect(err.message).to.contain('start it and re-run');
            expect(err.message).to.contain('docs.docker.com/desktop');
        });

        it('does not attempt the install when Desktop is unavailable', async function() {
            const { x, calls } = make(null, { listFails: true });
            await x.load({ 'docker-extension': 'org/ext' }, []);
            try { await x.install(); } catch (e) { /* expected */ }
            expect(calls).to.deep.equal([]);
        });

        it('requires an address', async function() {
            const { x } = make();
            await x.load({ 'docker-extension': {} }, []);
            let err = null;
            try { await x.install(); } catch (e) { err = e; }
            expect(err.message).to.contain('needs an extension address');
        });

        it('uses PowerShell constructs on Windows', async function() {
            const x = new DockerX('e', null, '');
            x.platform = WINDOWS;
            x.setBakeletName('docker-extension');
            const calls = [];
            x.exec = async (cmd) => { calls.push(cmd); };
            x.execCapture = async () => '';
            await x.load({ 'docker-extension': 'org/ext' }, []);
            await x.install();
            expect(calls[0]).to.contain('Select-String');
        });

        it('needs no elevation', function() {
            expect(new DockerX('e', null, '').requiresElevation).to.be.false;
        });
    });
});

describe('config: keys is gone', function() {
    const fsx  = require('fs-extra');
    const root = path.join(__dirname, '..', '..');

    it('the bakelet module no longer exists', function() {
        expect(fsx.existsSync(path.join(root, 'lib', 'bakelets', 'config', 'keys.js'))).to.be.false;
    });

    it('its playbook no longer exists', function() {
        expect(fsx.existsSync(
            path.join(root, 'remotes', 'bakelets-source', 'config', 'keys.yml'))).to.be.false;
    });

    it('the committed private key is gone from the repo', function() {
        // It was byte-identical to the key `config: keys` distributed, so anyone
        // with the repo held it. Removed with the bakelet that shipped it.
        expect(fsx.existsSync(path.join(root, 'config', 'baker_rsa'))).to.be.false;
        expect(fsx.existsSync(path.join(root, 'config', 'baker_rsa.pub'))).to.be.false;
    });

    it('global-vars no longer exports a key path', function() {
        const globals = require('../../global-vars');
        expect(globals).to.not.have.property('privateKey');
        expect(globals).to.not.have.property('bakerSSHConfig');
        expect(globals).to.not.have.property('bakerForMacPath');
    });

    it('the remaining config bakelets are files and template', function() {
        const dir = path.join(root, 'lib', 'bakelets', 'config');
        expect(fsx.readdirSync(dir).sort()).to.deep.equal(['files.js', 'template.js']);
    });
});
