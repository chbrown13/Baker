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

describe('config: keys uses the injected transport', function() {
    const Keys = require('../../lib/bakelets/config/keys');
    const { privateKey } = require('../../global-vars');

    function make() {
        // ansibleSSHConfig null is exactly the local/docker case that used to
        // make the direct Ssh.copyFromHostToVM call a silent no-op.
        const bakelet = new Keys('testenv', null, '');
        bakelet.setRemotesPath('/remotes');
        const copies = [];
        bakelet.copy = async (src, dest) => { copies.push({ src, dest }); };
        return { bakelet, copies };
    }

    it('copies one key per client through this.copy', async function() {
        const { bakelet, copies } = make();
        await bakelet.load({ keys: ['alice', 'bob'] }, []);
        const keyCopies = copies.filter(c => c.src === privateKey);
        expect(keyCopies).to.have.lengthOf(2);
    });

    it('names each destination after the client', async function() {
        const { bakelet, copies } = make();
        await bakelet.load({ keys: ['alice'] }, []);
        expect(copies[0].dest).to.contain('alice_id_rsa');
    });

    it('copies the private key rather than an arbitrary source', async function() {
        const { bakelet, copies } = make();
        await bakelet.load({ keys: ['alice'] }, []);
        expect(copies[0].src).to.equal(privateKey);
    });

    it('still copies the playbook alongside the keys', async function() {
        const { bakelet, copies } = make();
        await bakelet.load({ keys: ['alice'] }, []);
        expect(copies.some(c => String(c.src).indexOf('keys') !== -1)).to.be.true;
    });

    it('pushes the client key names into the playbook variables', async function() {
        const { bakelet } = make();
        const variables = [];
        await bakelet.load({ keys: ['alice', 'bob'] }, variables);
        const entry = variables.find(v => v.baker_client_keys);
        expect(entry.baker_client_keys).to.deep.equal(['alice_id_rsa', 'bob_id_rsa']);
    });

    it('does nothing when keys is not a list', async function() {
        const { bakelet, copies } = make();
        await bakelet.load({ keys: 'alice' }, []);
        expect(copies).to.deep.equal([]);
    });

    it('does nothing for an empty key list beyond the playbook', async function() {
        const { bakelet, copies } = make();
        await bakelet.load({ keys: [] }, []);
        expect(copies.filter(c => c.src === privateKey)).to.deep.equal([]);
    });

    it('no longer requires the ssh module directly', function() {
        const source = fs.readFileSync(
            path.join(__dirname, '..', '..', 'lib', 'bakelets', 'config', 'keys.js'), 'utf8');
        expect(source).to.not.contain("require('../../modules/ssh')");
        expect(source).to.not.contain('await Ssh.');
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
