const child_process = require('child_process');
const crypto = require('crypto');
const fs     = require('fs-extra');
const os     = require('os');
const path   = require('path');
const chai   = require('chai');
const expect = chai.expect;

const resolve     = require('../../lib/bakelets/resolve');
const Bakelet     = require('../../lib/bakelets/bakelet');
const AgenticTool = require('../../lib/bakelets/tools/agentic-tool');
const Opencode    = require('../../lib/bakelets/tools/opencode');
const GitResource = require('../../lib/bakelets/resources/git');

const BAKELETS_PATH = path.join(__dirname, '../../lib/bakelets');
const REMOTES_PATH  = path.join(__dirname, '../../remotes');

// Recursive hash of a tree — used to prove plan() modified nothing.
async function hashTree(root) {
    const hash = crypto.createHash('sha256');
    const walk = async (dir, prefix) => {
        for (const entry of (await fs.readdir(dir)).sort()) {
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

function git(repo, ...args) {
    child_process.execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
}

// A real git repo, because the dirty-check shells out to real git.
function makeRepo(dir, { dirty = false, untracked = false, unpushed = false } = {}) {
    fs.ensureDirSync(dir);
    git(dir, 'init', '--quiet', '--initial-branch', 'main');
    git(dir, 'config', 'user.email', 'test@example.com');
    git(dir, 'config', 'user.name', 'Baker Test');
    fs.writeFileSync(path.join(dir, 'tracked.md'), 'v1\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '--quiet', '-m', 'initial');

    // A bare origin so "unpushed" is meaningful; push unless we want unpushed.
    const origin = `${dir}-origin.git`;
    child_process.execFileSync('git', ['init', '--bare', '--quiet', origin], { stdio: 'pipe' });
    git(dir, 'remote', 'add', 'origin', origin);
    if (!unpushed) {
        git(dir, 'push', '--quiet', '-u', 'origin', 'main');
    } else {
        git(dir, 'push', '--quiet', '-u', 'origin', 'main');
        fs.writeFileSync(path.join(dir, 'tracked.md'), 'v2\n');
        git(dir, 'add', '-A');
        git(dir, 'commit', '--quiet', '-m', 'local only');
    }
    if (dirty) fs.writeFileSync(path.join(dir, 'tracked.md'), 'edited\n');
    if (untracked) fs.writeFileSync(path.join(dir, 'stray.md'), 'new\n');
    return dir;
}

// A bakelet wired for local mode with real exec/execCapture, so the git probes
// actually run.
function localTool(Klass, envRoot, name = 'testenv') {
    const bakelet = new Klass(name, null, '');
    bakelet.setBakeletName('tool');
    bakelet.setBakePath(envRoot);
    bakelet.setLocalLocation(envRoot);
    bakelet.exec = async (cmd) => child_process.execSync(cmd, { cwd: envRoot, encoding: 'utf8' });
    bakelet.execCapture = async (cmd) => child_process.execSync(cmd, { cwd: envRoot, encoding: 'utf8' });
    return bakelet;
}

describe('cleanup plan construction', function() {
    let root, bakePath, envRoot;

    beforeEach(async function() {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'baker-cleanplan-'));
        bakePath = path.join(root, 'config');
        envRoot = path.join(root, 'project');
        await fs.ensureDir(bakePath);
        await fs.ensureDir(envRoot);
    });

    afterEach(async function() {
        await fs.remove(root).catch(() => {});
    });

    // Every other safety property in the feature rests on this one.
    describe('plan() is side-effect free', function() {

        it('modifies nothing across a config touching every in-scope section', async function() {
            await fs.outputFile(path.join(bakePath, 'base/a.md'), 'a');
            await fs.outputFile(path.join(bakePath, 'block.txt'), 'rule\n');
            await fs.outputFile(path.join(bakePath, 'tpl.conf'), 'x={{v}}\n');
            await fs.outputFile(path.join(envRoot, 'mine.md'), 'user file');

            const doc = {
                name: 'plan-pure',
                local: envRoot,
                vars: [{ v: '1' }],
                env: [{ TOKEN: 'abc12345' }],
                tools: ['opencode'],
                config: [
                    { files: [{ src: 'base/', dest: '.' }, { src: 'block.txt', dest: '.gitignore', append: true }] },
                    { template: { src: 'tpl.conf', dest: './out.conf' } }
                ]
            };

            const before = await hashTree(root);
            await resolve.planBakeletRemoval(
                BAKELETS_PATH, REMOTES_PATH, doc, bakePath, false, envRoot
            );
            expect(await hashTree(root)).to.equal(before);
        });

        it('leaves the process environment untouched', async function() {
            const snapshot = JSON.stringify(process.env);
            const doc = { name: 'plan-env', local: envRoot, env: [{ TOKEN: 'abc12345' }] };
            await resolve.planBakeletRemoval(BAKELETS_PATH, REMOTES_PATH, doc, bakePath, false, envRoot);
            expect(JSON.stringify(process.env)).to.equal(snapshot);
        });
    });

    describe('AC-6: removal order is the reverse of install order', function() {

        it('emits env, then resources, then tools, then config', async function() {
            await fs.outputFile(path.join(bakePath, 'a.md'), 'a');
            const doc = {
                name: 'order',
                local: envRoot,
                env: [{ TOKEN: 'abc12345' }],
                resources: [{ git: 'https://example.com/x.git' }],
                tools: [{ opencode: { install: 'npm' } }],
                config: [{ files: [{ src: 'a.md', dest: 'a.md' }] }]
            };

            const plan = await resolve.planBakeletRemoval(
                BAKELETS_PATH, REMOTES_PATH, doc, bakePath, false, envRoot
            );
            const sections = [];
            plan.forEach((p) => { if (!sections.includes(p.section)) sections.push(p.section); });
            expect(sections).to.deep.equal(['env', 'resources', 'tools', 'config']);
        });
    });

    describe('AC-17: deferred sections are inert', function() {

        it('reports none for every deferred section and constructs nothing', async function() {
            const doc = {
                name: 'deferred',
                local: envRoot,
                lang: ['python'],
                services: ['docker'],
                packages: ['jq'],
                start: 'true'
            };

            const plan = await resolve.planBakeletRemoval(
                BAKELETS_PATH, REMOTES_PATH, doc, bakePath, false, envRoot
            );
            expect(plan.length).to.be.greaterThan(0);
            plan.forEach((p) => expect(p.kind, p.section).to.equal('none'));
            expect(plan.map((p) => p.section).sort())
                .to.deep.equal(['lang', 'packages', 'services', 'start']);
        });

        it('names the section in the reason', async function() {
            const doc = { name: 'd', local: envRoot, services: ['mysql'] };
            const plan = await resolve.planBakeletRemoval(BAKELETS_PATH, REMOTES_PATH, doc, bakePath, false, envRoot);
            expect(plan[0].reason).to.contain('services');
        });
    });

    describe('AC-9 / AC-10 / AC-11: the cloned-repo guard', function() {

        it('offers a clean clone, pre-selected off (AC-10)', async function() {
            const repo = makeRepo(path.join(root, 'clean'));
            const bakelet = localTool(Bakelet, envRoot);
            const entry = await bakelet.planRepoRemoval('cfg', repo, 'https://example.com/x.git');

            expect(entry.kind).to.equal('repo');
            expect(entry.default).to.equal(false);
            expect(entry.restore).to.contain('git clone https://example.com/x.git');
        });

        it('refuses a clone with uncommitted changes (AC-9)', async function() {
            const repo = makeRepo(path.join(root, 'dirty'), { dirty: true });
            const entry = await localTool(Bakelet, envRoot).planRepoRemoval('cfg', repo);

            expect(entry.kind).to.equal('refused');
            expect(entry.reason).to.contain('uncommitted');
        });

        it('refuses a clone with untracked files (AC-9)', async function() {
            const repo = makeRepo(path.join(root, 'untracked'), { untracked: true });
            const entry = await localTool(Bakelet, envRoot).planRepoRemoval('cfg', repo);
            expect(entry.kind).to.equal('refused');
        });

        it('refuses a clone with unpushed commits (AC-9)', async function() {
            const repo = makeRepo(path.join(root, 'unpushed'), { unpushed: true });
            const entry = await localTool(Bakelet, envRoot).planRepoRemoval('cfg', repo);

            expect(entry.kind).to.equal('refused');
            expect(entry.reason).to.contain('unpushed');
        });

        it('counts both kinds of change in the reason', async function() {
            const repo = makeRepo(path.join(root, 'both'), { dirty: true, unpushed: true });
            const entry = await localTool(Bakelet, envRoot).planRepoRemoval('cfg', repo);

            expect(entry.reason).to.contain('uncommitted');
            expect(entry.reason).to.contain('unpushed');
        });

        it('refuses a destination that is not a git repo (AC-11)', async function() {
            const notRepo = path.join(root, 'plain');
            await fs.outputFile(path.join(notRepo, 'file.md'), 'x');
            const entry = await localTool(Bakelet, envRoot).planRepoRemoval('cfg', notRepo);

            expect(entry.kind).to.equal('refused');
            expect(entry.reason).to.contain('not a git repository');
        });

        it('treats a missing destination as already gone, not an error', async function() {
            const entry = await localTool(Bakelet, envRoot).planRepoRemoval('cfg', path.join(root, 'nope'));
            expect(entry.kind).to.equal('none');
            expect(entry.reason).to.contain('already gone');
        });

        it('fails closed when the repository state cannot be read', async function() {
            const repo = makeRepo(path.join(root, 'unreadable'));
            const bakelet = localTool(Bakelet, envRoot);
            bakelet.execCapture = async () => { throw new Error('git exploded'); };

            const entry = await bakelet.planRepoRemoval('cfg', repo);
            expect(entry.kind).to.equal('refused');
            expect(entry.reason).to.contain('could not determine');
        });
    });

    describe('AC-7 / AC-8 / AC-12: tools', function() {

        it('makes the binary and the config repo separate entries (AC-12)', async function() {
            const repo = makeRepo(path.join(root, 'cfgrepo'));
            const bakelet = localTool(Opencode, envRoot);
            await bakelet.prepare({ opencode: { install: 'npm', repo: `https://example.com/c.git:${repo}` } }, []);

            const plan = await bakelet.plan();
            expect(plan).to.have.lengthOf(2);
            expect(plan[0].kind).to.equal('exec');
            expect(plan[1].kind).to.equal('repo');
        });

        it('defaults the tool uninstall to No and says why (AC-7)', async function() {
            const bakelet = localTool(Opencode, envRoot);
            await bakelet.prepare({ opencode: { install: 'npm' } }, []);
            const [tool] = await bakelet.plan();

            expect(tool.default).to.equal(false);
            expect(tool.prompt).to.contain('cannot tell whether it installed');
        });

        it('uses the npm uninstall command when npm was the install method', async function() {
            const bakelet = localTool(Opencode, envRoot);
            await bakelet.prepare({ opencode: { install: 'npm' } }, []);
            const [tool] = await bakelet.plan();
            expect(tool.command).to.equal('npm uninstall -g opencode-ai');
        });

        it('reports no inverse for a curl install it cannot derive (AC-8)', async function() {
            // claude-code's installer is a bootstrapper: it downloads a binary,
            // runs `<binary> install`, then deletes it, so the real footprint is
            // decided by the binary rather than the script and cannot be read
            // off it. That gap is reported, never guessed at.
            const ClaudeCode = require('../../lib/bakelets/tools/claude-code');
            const bakelet = localTool(ClaudeCode, envRoot);
            bakelet.platform = { os: 'linux', manager: 'apt', shell: 'sh', family: 'debian', sudo: true };
            await bakelet.prepare('claude-code', []);
            const [tool] = await bakelet.plan();

            expect(tool.kind).to.equal('none');
            expect(tool.reason).to.contain('install method "curl"');
            expect(tool.reason).to.contain('install: npm');
        });

        it('offers a curl inverse for opencode, whose install location is known', async function() {
            const bakelet = localTool(Opencode, envRoot);
            bakelet.platform = { os: 'linux', manager: 'apt', shell: 'sh', family: 'debian', sudo: true };
            // Presence is stubbed so the result does not depend on whether the
            // developer happens to have opencode installed.
            bakelet.filterExisting = async (paths) => paths;
            await bakelet.prepare('opencode', []);
            const [tool] = await bakelet.plan();

            expect(tool.kind).to.equal('exec');
            expect(tool.command).to.contain('rm -f ~/.opencode/bin/opencode');
            // The restore hint is the install command itself.
            expect(tool.restore).to.contain('opencode.ai/install');
        });

        it('leaves the shell rc files alone in the curl inverse', async function() {
            // A stale PATH entry to a gone directory is harmless; editing a file
            // the user owns, on a marker the vendor wrote, is not.
            const bakelet = localTool(Opencode, envRoot);
            bakelet.filterExisting = async (paths) => paths;
            await bakelet.prepare('opencode', []);
            const [tool] = await bakelet.plan();

            ['bashrc', 'zshrc', 'profile', 'fish', 'sed', 'PATH'].forEach((token) => {
                expect(tool.command, token).to.not.contain(token);
            });
        });

        it('reports the opencode binary as already gone when it is not there', async function() {
            const bakelet = localTool(Opencode, envRoot);
            bakelet.filterExisting = async () => [];
            await bakelet.prepare('opencode', []);
            const [tool] = await bakelet.plan();

            expect(tool.kind).to.equal('none');
            expect(tool.reason).to.contain('already gone');
        });

        it('uses no single quotes in the curl inverse', async function() {
            const bakelet = localTool(Opencode, envRoot);
            bakelet.filterExisting = async (paths) => paths;
            await bakelet.prepare('opencode', []);
            expect((await bakelet.plan())[0].command).to.not.contain("'");
        });

        it('offers no uninstall command at all for an unknown method', async function() {
            const bakelet = localTool(AgenticTool, envRoot);
            bakelet.toolKey = 'x'; bakelet.binName = 'x';
            bakelet.installCommands = {}; bakelet.uninstallCommands = {};
            bakelet.defaultInstall = 'curl';
            await bakelet.prepare('x', []);
            expect((await bakelet.plan())[0].kind).to.equal('none');
        });
    });

    describe('resources: git', function() {

        it('plans removal of the clone destination install() would use', async function() {
            const repo = makeRepo(path.join(envRoot, 'starter'));
            const bakelet = localTool(GitResource, envRoot);
            await bakelet.prepare({ git: 'https://example.com/starter.git' }, []);

            const [entry] = await bakelet.plan();
            expect(entry.kind).to.equal('repo');
            expect(entry.path).to.equal(repo);
        });

        it('reports none when the config names no repository', async function() {
            const bakelet = localTool(GitResource, envRoot);
            await bakelet.prepare({}, []);
            expect((await bakelet.plan())[0].kind).to.equal('none');
        });
    });

    describe('per-bakelet inverses in their other branches', function() {

        it('unsets Windows environment variables rather than editing a profile', async function() {
            const Env = require('../../lib/bakelets/env/env');
            const bakelet = new Env('winenv', null, '');
            bakelet.platform = { os: 'windows', manager: 'choco', shell: 'powershell', family: 'nt', sudo: false };
            await bakelet.prepare({ env: [{ TOKEN: 'abc12345' }, { OTHER: 'defg6789' }] }, []);

            const [op] = await bakelet.plan();
            expect(op.command).to.contain('SetEnvironmentVariable("TOKEN", $null, "User")');
            expect(op.command).to.contain('OTHER');
            expect(op.command).to.not.contain('.profile');
        });

        it('reports none for env: with no variables', async function() {
            const Env = require('../../lib/bakelets/env/env');
            const bakelet = new Env('e', null, '');
            bakelet.setLocalLocation(envRoot);
            await bakelet.prepare({ env: [] }, []);
            expect((await bakelet.plan())[0].kind).to.equal('none');
        });

        it('runs the composed command when env: is uninstalled', async function() {
            const Env = require('../../lib/bakelets/env/env');
            const bakelet = new Env('e', null, '');
            bakelet.setLocalLocation(envRoot);
            const issued = [];
            bakelet.exec = async (cmd) => { issued.push(cmd); };
            await bakelet.uninstall({ command: 'rm -f ~/.baker/env.sh' });
            expect(issued).to.deep.equal(['rm -f ~/.baker/env.sh']);
        });

        it('reports none for a template with no dest', async function() {
            const Template = require('../../lib/bakelets/config/template');
            const bakelet = new Template('t', null, '');
            bakelet.setLocalLocation(envRoot);
            bakelet.setBakePath(bakePath);
            await fs.outputFile(path.join(bakePath, 'x.conf'), 'x');
            await bakelet.prepare({ template: { src: 'x.conf' } }, []);
            expect((await bakelet.plan())[0].kind).to.equal('none');
        });

        it('deletes the rendered file when a template is uninstalled', async function() {
            const Template = require('../../lib/bakelets/config/template');
            const target = path.join(envRoot, 'out.conf');
            await fs.outputFile(target, 'rendered');

            const bakelet = new Template('t', null, '');
            bakelet.setLocalLocation(envRoot);
            await bakelet.uninstall({ kind: 'paths', paths: [target] });
            expect(await fs.pathExists(target)).to.equal(false);
        });

        it('removes the clone directory when a tools repo entry is uninstalled', async function() {
            const clone = path.join(envRoot, 'cfg');
            await fs.outputFile(path.join(clone, 'file.md'), 'x');

            const bakelet = localTool(Opencode, envRoot);
            await bakelet.uninstall({ kind: 'repo', path: clone });
            expect(await fs.pathExists(clone)).to.equal(false);
        });

        it('runs the uninstall command for a tools exec entry', async function() {
            const bakelet = localTool(Opencode, envRoot);
            const issued = [];
            bakelet.exec = async (cmd) => { issued.push(cmd); };
            await bakelet.uninstall({ kind: 'exec', command: 'npm uninstall -g opencode-ai' });
            expect(issued).to.deep.equal(['npm uninstall -g opencode-ai']);
        });

        it('removes the clone when a resources git entry is uninstalled', async function() {
            const clone = path.join(envRoot, 'starter');
            await fs.outputFile(path.join(clone, 'file.md'), 'x');

            const bakelet = localTool(GitResource, envRoot);
            await bakelet.uninstall({ kind: 'repo', path: clone });
            expect(await fs.pathExists(clone)).to.equal(false);
        });

        it('uses the target-relative destination in a non-local mode', async function() {
            // install() clones to `dest || basename(repo)` inside the target and
            // never resolves against a host path, so cleanup uses the same.
            //
            // Changed 2026-08-10: the fallback used to be the ENVIRONMENT NAME,
            // an artifact of the Ansible git module (which required a dest) on
            // the deleted control-VM path. `basename(repo)` is what `git clone`
            // itself does with no destination, and is what local mode already
            // used — so all three modes now agree.
            const bakelet = new GitResource('envname', { hostname: 'h' }, '');
            await bakelet.prepare({ git: 'https://example.com/x.git' }, []);
            expect(bakelet.cloneDestination()).to.equal('x');

            const withDest = new GitResource('envname', { hostname: 'h' }, '');
            await withDest.prepare({ git: { repo: 'https://example.com/x.git', dest: '/srv/app' } }, []);
            expect(withDest.cloneDestination()).to.equal('/srv/app');
        });

        it('uses the configured dest for a resources git clone', async function() {
            const dest = path.join(envRoot, 'custom-dir');
            makeRepo(dest);
            const bakelet = localTool(GitResource, envRoot);
            await bakelet.prepare({ git: { repo: 'https://example.com/x.git', dest } }, []);

            const [entry] = await bakelet.plan();
            expect(entry.path).to.equal(dest);
        });
    });

    // These run in docker-local and remote, which have no round-trip test here
    // (docker-local needs a daemon, remote needs a second machine). Command
    // construction is therefore the only coverage they get, and it matters
    // most: their failure mode is deleting the wrong thing on someone else's
    // machine.
    describe('non-local transport helpers', function() {

        function stubbed(responses = {}) {
            const bakelet = new Bakelet(null);
            bakelet.calls = [];
            bakelet.exec = async (cmd) => {
                bakelet.calls.push(cmd);
                if (responses[cmd] instanceof Error) throw responses[cmd];
            };
            bakelet.execCapture = async (cmd) => {
                bakelet.calls.push(cmd);
                const value = responses[cmd];
                if (value instanceof Error) throw value;
                return value === undefined ? '' : value;
            };
            return bakelet;
        }

        it('probes existence with test -e', async function() {
            const bakelet = stubbed();
            expect(await bakelet.pathExists('/srv/app')).to.equal(true);
            expect(bakelet.calls[0]).to.equal('test -e "/srv/app"');
        });

        it('treats a failing test -e as absent', async function() {
            const bakelet = stubbed({ 'test -e "/nope"': new Error('exit 1') });
            expect(await bakelet.pathExists('/nope')).to.equal(false);
        });

        it('batches an existence filter into a single command', async function() {
            const bakelet = stubbed();
            bakelet.execCapture = async (cmd) => {
                bakelet.calls.push(cmd);
                return '/a\n/c\n';
            };
            const present = await bakelet.filterExisting(['/a', '/b', '/c']);

            expect(present).to.deep.equal(['/a', '/c']);
            expect(bakelet.calls).to.have.lengthOf(1);
            expect(bakelet.calls[0]).to.contain('[ -e "/a" ]');
            expect(bakelet.calls[0]).to.contain('[ -e "/c" ]');
        });

        it('uses no single quotes in the existence filter', async function() {
            const bakelet = stubbed();
            await bakelet.filterExisting(['/a b', '/c']);
            bakelet.calls.forEach((cmd) => expect(cmd).to.not.contain("'"));
        });

        it('keeps every path when existence cannot be determined', async function() {
            // Over-listing is safe because removal is idempotent; under-listing
            // would silently skip real work.
            const bakelet = stubbed();
            bakelet.execCapture = async () => { throw new Error('transport down'); };
            expect(await bakelet.filterExisting(['/a', '/b'])).to.deep.equal(['/a', '/b']);
        });

        it('short-circuits an empty path list without touching the transport', async function() {
            const bakelet = stubbed();
            expect(await bakelet.filterExisting([])).to.deep.equal([]);
            expect(bakelet.calls).to.deep.equal([]);
        });

        it('removes with rm -rf and no single quotes', async function() {
            const bakelet = stubbed();
            await bakelet.removePath('/srv/app');
            expect(bakelet.calls[0]).to.equal('rm -rf "/srv/app"');
        });

        it('runs the git probes with double quotes only', async function() {
            const bakelet = stubbed({});
            bakelet.execCapture = async (cmd) => { bakelet.calls.push(cmd); return ''; };
            bakelet.exec = async (cmd) => { bakelet.calls.push(cmd); };
            await bakelet.planRepoRemoval('cfg', '/srv/clone', 'https://x/y.git');

            const probes = bakelet.calls.filter((c) => c.startsWith('git -C'));
            expect(probes.length).to.be.greaterThan(0);
            probes.forEach((cmd) => expect(cmd).to.not.contain("'"));
        });

        it('expands ~ against the host home only in local mode', function() {
            const local = new Bakelet(null);
            local.setLocalLocation('/tmp/env');
            expect(local.resolveLocalPath('~/x')).to.equal(path.join(os.homedir(), 'x'));
            expect(local.resolveLocalPath('/abs/x')).to.equal('/abs/x');
        });
    });

    describe('the default seam', function() {

        it('reports none for a bakelet that overrides nothing (AC-2)', async function() {
            const bakelet = new Bakelet(null);
            bakelet.setBakeletName('whatever');
            const plan = await bakelet.plan();

            expect(plan).to.have.lengthOf(1);
            expect(plan[0].kind).to.equal('none');
            expect(plan[0].reason).to.contain('whatever');
        });

        it('has an uninstall that does nothing', async function() {
            await new Bakelet(null).uninstall({ kind: 'paths', paths: ['/should/not/matter'] });
        });

        it('defaults prepare() to load()', async function() {
            const bakelet = new Bakelet(null);
            let loaded = null;
            bakelet.load = async (obj) => { loaded = obj; };
            await bakelet.prepare({ marker: true }, []);
            expect(loaded).to.deep.equal({ marker: true });
        });
    });
});
