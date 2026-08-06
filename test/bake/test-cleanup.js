const child_process = require('child_process');
const crypto = require('crypto');
const fs     = require('fs-extra');
const os     = require('os');
const path   = require('path');
const chai   = require('chai');
const expect = chai.expect;

const resolve    = require('../../lib/bakelets/resolve');
const CleanupLog = require('../../lib/modules/cleanup-log');

const BAKELETS_PATH = path.join(__dirname, '../../lib/bakelets');
const REMOTES_PATH  = path.join(__dirname, '../../remotes');

function withTempHome() {
    let tmpHome, origHome;
    beforeEach(function() {
        origHome = process.env.HOME;
        tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'baker-cleanup-home-'));
        process.env.HOME = tmpHome;
    });
    afterEach(function() {
        if (origHome === undefined) delete process.env.HOME;
        else process.env.HOME = origHome;
        fs.removeSync(tmpHome);
    });
    return () => tmpHome;
}

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

describe('cleanup apply', function() {
    let root, bakePath, envRoot;

    beforeEach(async function() {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'baker-cleanup-'));
        bakePath = path.join(root, 'config');
        envRoot = path.join(root, 'project');
        await fs.ensureDir(bakePath);
        await fs.ensureDir(envRoot);
    });

    afterEach(async function() {
        await fs.remove(root).catch(() => {});
    });

    // Bakes a doc, then plans its removal, both in local mode.
    async function bake(doc) {
        await resolve.resolveBakelet(BAKELETS_PATH, REMOTES_PATH, doc, bakePath, false, envRoot);
    }
    async function plan(doc) {
        return resolve.planBakeletRemoval(BAKELETS_PATH, REMOTES_PATH, doc, bakePath, false, envRoot);
    }
    function selectable(p) {
        return p.filter((e) => e.kind !== 'none' && e.kind !== 'refused');
    }
    function defaults(p) {
        return selectable(p).filter((e) => e.default);
    }

    // The single most important test in the feature.
    describe('AC-5: only the derived set is deleted', function() {

        it('removes Baker files and leaves user files, wherever they sit', async function() {
            await fs.outputFile(path.join(bakePath, 'base/agents/a.md'), 'agent');
            await fs.outputFile(path.join(bakePath, 'base/AGENTS.md'), 'doc');
            const doc = {
                name: 'ac5', local: envRoot,
                config: [{ files: [{ src: 'base/', dest: '.' }] }]
            };
            await bake(doc);

            // The user's own work, including inside a directory Baker manages.
            await fs.outputFile(path.join(envRoot, 'README.md'), 'mine');
            await fs.outputFile(path.join(envRoot, 'agents/notes.md'), 'my notes');

            await resolve.applyBakeletRemoval(defaults(await plan(doc)), false);

            expect(await fs.pathExists(path.join(envRoot, 'agents/a.md'))).to.equal(false);
            expect(await fs.pathExists(path.join(envRoot, 'AGENTS.md'))).to.equal(false);
            expect(await fs.readFile(path.join(envRoot, 'README.md'), 'utf8')).to.equal('mine');
            expect(await fs.readFile(path.join(envRoot, 'agents/notes.md'), 'utf8')).to.equal('my notes');
        });

        it('keeps a directory that still holds user files', async function() {
            await fs.outputFile(path.join(bakePath, 'base/agents/a.md'), 'agent');
            const doc = { name: 'keepdir', local: envRoot, config: [{ files: [{ src: 'base/', dest: '.' }] }] };
            await bake(doc);
            await fs.outputFile(path.join(envRoot, 'agents/mine.md'), 'mine');

            await resolve.applyBakeletRemoval(defaults(await plan(doc)), false);

            expect(await fs.pathExists(path.join(envRoot, 'agents'))).to.equal(true);
            expect(await fs.pathExists(path.join(envRoot, 'agents/mine.md'))).to.equal(true);
        });

        it('removes a directory left empty', async function() {
            await fs.outputFile(path.join(bakePath, 'base/agents/a.md'), 'agent');
            const doc = { name: 'emptydir', local: envRoot, config: [{ files: [{ src: 'base/', dest: '.' }] }] };
            await bake(doc);

            await resolve.applyBakeletRemoval(defaults(await plan(doc)), false);
            expect(await fs.pathExists(path.join(envRoot, 'agents'))).to.equal(false);
        });

        it('deletes a placed file the user edited — Baker placed it, Baker owns it', async function() {
            await fs.outputFile(path.join(bakePath, 'a.md'), 'original');
            const doc = { name: 'edited', local: envRoot, config: [{ files: [{ src: 'a.md', dest: 'a.md' }] }] };
            await bake(doc);
            await fs.outputFile(path.join(envRoot, 'a.md'), 'heavily edited by the student');

            await resolve.applyBakeletRemoval(defaults(await plan(doc)), false);
            expect(await fs.pathExists(path.join(envRoot, 'a.md'))).to.equal(false);
        });
    });

    describe('AC-3 / AC-4: nothing happens before apply', function() {

        it('planning alone modifies nothing', async function() {
            await fs.outputFile(path.join(bakePath, 'a.md'), 'a');
            const doc = { name: 'noop', local: envRoot, config: [{ files: [{ src: 'a.md', dest: 'a.md' }] }] };
            await bake(doc);

            const before = await hashTree(envRoot);
            await plan(doc);
            expect(await hashTree(envRoot)).to.equal(before);
        });

        it('applying an empty selection modifies nothing', async function() {
            await fs.outputFile(path.join(bakePath, 'a.md'), 'a');
            const doc = { name: 'abort', local: envRoot, config: [{ files: [{ src: 'a.md', dest: 'a.md' }] }] };
            await bake(doc);

            const before = await hashTree(envRoot);
            await resolve.applyBakeletRemoval([], false);
            expect(await hashTree(envRoot)).to.equal(before);
        });
    });

    describe('AC-13: --yes selects only safe defaults', function() {

        it('marks files, config, and env as default-yes and tools as default-no', async function() {
            await fs.outputFile(path.join(bakePath, 'a.md'), 'a');
            await fs.outputFile(path.join(bakePath, 'tpl.conf'), 'x\n');
            const doc = {
                name: 'defaults', local: envRoot,
                env: [{ TOKEN: 'abc12345' }],
                tools: [{ opencode: { install: 'npm' } }],
                config: [
                    { files: [{ src: 'a.md', dest: 'a.md' }] },
                    { template: { src: 'tpl.conf', dest: path.join(envRoot, 'out.conf') } }
                ]
            };
            // Bake first: the plan only lists what is actually there, so an
            // unbaked config correctly has nothing to remove.
            await bake(doc);

            const p = await plan(doc);
            const yes = defaults(p).map((e) => e.section);
            const no = selectable(p).filter((e) => !e.default).map((e) => e.section);

            expect(yes).to.contain('env');
            expect(yes).to.contain('config');
            expect(no).to.deep.equal(['tools']);
        });
    });

    describe('AC-14: env removal is surgical', function() {
        const home = withTempHome();

        it('removes Baker vars and leaves every other profile line byte-identical', async function() {
            await fs.outputFile(path.join(home(), '.profile'), '# mine\nexport MY_OWN=1\n');
            const doc = { name: 'envtest', local: envRoot, env: [{ TOKEN: 'abc12345' }] };
            await bake(doc);

            expect(await fs.pathExists(path.join(home(), '.baker/env.sh'))).to.equal(true);

            await resolve.applyBakeletRemoval(defaults(await plan(doc)), false);

            const profile = await fs.readFile(path.join(home(), '.profile'), 'utf8');
            expect(profile).to.equal('# mine\nexport MY_OWN=1\n');
            expect(await fs.pathExists(path.join(home(), '.baker/env.sh'))).to.equal(false);
        });

        it('leaves the profile in place, not deleted', async function() {
            await fs.outputFile(path.join(home(), '.profile'), '# mine\n');
            const doc = { name: 'envkeep', local: envRoot, env: [{ TOKEN: 'abc12345' }] };
            await bake(doc);
            await resolve.applyBakeletRemoval(defaults(await plan(doc)), false);

            expect(await fs.pathExists(path.join(home(), '.profile'))).to.equal(true);
        });
    });

    describe('AC-15 / AC-16: missing paths and convergence', function() {

        it('treats already-deleted paths as fine, not an error', async function() {
            await fs.outputFile(path.join(bakePath, 'a.md'), 'a');
            const doc = { name: 'gone', local: envRoot, config: [{ files: [{ src: 'a.md', dest: 'a.md' }] }] };
            await bake(doc);
            await fs.remove(path.join(envRoot, 'a.md'));

            const results = await resolve.applyBakeletRemoval(defaults(await plan(doc)), false);
            expect(results.every((r) => r.status === 'removed')).to.equal(true);
        });

        it('converges: a second cleanup has nothing left to do', async function() {
            await fs.outputFile(path.join(bakePath, 'a.md'), 'a');
            const doc = { name: 'converge', local: envRoot, config: [{ files: [{ src: 'a.md', dest: 'a.md' }] }] };
            await bake(doc);

            await resolve.applyBakeletRemoval(defaults(await plan(doc)), false);
            const before = await hashTree(envRoot);

            // The second plan must be EMPTY, not merely harmless — otherwise
            // cleanup reports "removed 4 items" having removed nothing.
            const second = await plan(doc);
            expect(selectable(second)).to.deep.equal([]);
            expect(second.every((e) => e.kind === 'none')).to.equal(true);

            await resolve.applyBakeletRemoval(defaults(second), false);
            expect(await hashTree(envRoot)).to.equal(before);
        });

        it('reports already-gone paths rather than claiming to remove them', async function() {
            await fs.outputFile(path.join(bakePath, 'a.md'), 'a');
            const doc = { name: 'gonecount', local: envRoot, config: [{ files: [{ src: 'a.md', dest: 'a.md' }] }] };
            await bake(doc);
            await fs.remove(path.join(envRoot, 'a.md'));

            const p = await plan(doc);
            const files = p.find((e) => e.bakelet === 'files');
            expect(files.kind).to.equal('none');
            expect(files.reason).to.contain('already gone');
        });
    });

    describe('AC-18: config drift is survivable and visible', function() {

        it('leaves a file the current config no longer describes', async function() {
            await fs.outputFile(path.join(bakePath, 'a.md'), 'a');
            await fs.outputFile(path.join(bakePath, 'legacy.md'), 'from v1');

            const v1 = {
                name: 'drift', local: envRoot,
                config: [{ files: [{ src: 'a.md', dest: 'a.md' }, { src: 'legacy.md', dest: 'legacy.md' }] }]
            };
            await bake(v1);

            // The config is corrected mid-term; legacy.md is dropped from it.
            const v2 = { name: 'drift', local: envRoot, config: [{ files: [{ src: 'a.md', dest: 'a.md' }] }] };
            await resolve.applyBakeletRemoval(defaults(await plan(v2)), false);

            expect(await fs.pathExists(path.join(envRoot, 'a.md'))).to.equal(false);
            // Orphaned, by design — cleanup inverts the config it is given.
            expect(await fs.pathExists(path.join(envRoot, 'legacy.md'))).to.equal(true);
        });
    });

    describe('AC-20: round trip restores the tree', function() {

        it('leaves the snapshot plus exactly the user-added files', async function() {
            await fs.outputFile(path.join(bakePath, 'base/a.md'), 'a');
            await fs.outputFile(path.join(bakePath, 'base/sub/b.md'), 'b');
            await fs.outputFile(path.join(bakePath, 'block.txt'), 'ignored\n');
            await fs.outputFile(path.join(envRoot, '.gitignore'), 'node_modules\n');
            await fs.outputFile(path.join(envRoot, 'README.md'), '# project\n');

            const snapshot = await hashTree(envRoot);

            const doc = {
                name: 'roundtrip', local: envRoot,
                config: [{
                    files: [
                        { src: 'base/', dest: '.' },
                        { src: 'block.txt', dest: '.gitignore', append: true }
                    ],
                    prune: true
                }]
            };
            await bake(doc);
            await fs.outputFile(path.join(envRoot, 'my-work.md'), 'user added');

            await resolve.applyBakeletRemoval(defaults(await plan(doc)), false);

            // Remove the one user-added file and the tree must equal the snapshot.
            await fs.remove(path.join(envRoot, 'my-work.md'));
            expect(await hashTree(envRoot)).to.equal(snapshot);
        });
    });

    describe('AC-19: the log', function() {
        const home = withTempHome();

        it('records one entry per disposition with a restore hint', async function() {
            await CleanupLog.append({
                source: './unit-3', provider: 'local', root: '/projects/app',
                items: [
                    { operation: { kind: 'paths', bakelet: 'files', paths: ['agents/a.md'] }, disposition: 'REMOVED' },
                    { operation: { kind: 'repo', bakelet: 'cfg', path: '~/.claude' }, disposition: 'REFUSED', detail: '3 uncommitted change(s)' },
                    { operation: { kind: 'exec', bakelet: 'opencode' }, disposition: 'KEPT', detail: 'declined at prompt' }
                ]
            });

            const log = await fs.readFile(CleanupLog.logPath(), 'utf8');
            expect(log).to.contain('cleanup ./unit-3');
            expect(log).to.contain('provider=local');
            expect(log).to.contain('REMOVED');
            expect(log).to.contain('restore: baker bake');
            expect(log).to.contain('REFUSED');
            expect(log).to.contain('3 uncommitted change(s)');
            expect(log).to.contain('KEPT');
        });

        it('gives a repo a git clone restore hint and a tool an unrecoverable one', function() {
            expect(CleanupLog.restoreHint({ kind: 'repo', path: '~/.config/opencode' }))
                .to.contain('git clone');
            expect(CleanupLog.restoreHint({ kind: 'exec', bakelet: 'opencode' }))
                .to.contain('not recoverable');
        });

        it('prefers an explicit restore hint from the plan', function() {
            expect(CleanupLog.restoreHint({ kind: 'repo', restore: 'git clone https://x/y.git /d' }))
                .to.equal('git clone https://x/y.git /d');
        });

        it('appends rather than overwriting', async function() {
            await CleanupLog.append({ source: 'a', provider: 'local', root: '/r', items: [] });
            await CleanupLog.append({ source: 'b', provider: 'local', root: '/r', items: [] });
            const log = await fs.readFile(CleanupLog.logPath(), 'utf8');
            expect(log).to.contain('cleanup a');
            expect(log).to.contain('cleanup b');
        });

        it('never throws when the log cannot be written', async function() {
            await fs.outputFile(path.join(home(), '.baker'), 'a file where the dir should be');
            expect(await CleanupLog.append({ source: 'x', provider: 'local', root: '/r', items: [] }))
                .to.equal(false);
        });
    });

    describe('the cleanup command surface', function() {
        const home = withTempHome();
        const cleanup = require('../../lib/commands/cleanup');
        const { describe: describeOp, render, recordRun, summarize, providerLabel } = cleanup._internal;

        // Renders and summaries write to stdout; capture rather than pollute.
        function captureLog(fn) {
            const lines = [];
            const original = console.log;
            console.log = (...args) => lines.push(args.join(' '));
            try { return { result: fn(), lines }; } finally { console.log = original; }
        }

        it('describes each plan kind readably', function() {
            expect(describeOp({ kind: 'paths', paths: ['a.md'] })).to.equal('a.md');
            expect(describeOp({ kind: 'paths', paths: ['a', 'b', 'c'] })).to.equal('3 paths');
            expect(describeOp({ kind: 'block', file: '/p/.gitignore' })).to.contain('.gitignore');
            expect(describeOp({ kind: 'repo', path: '/p/clone' })).to.contain('cloned repository');
            expect(describeOp({ kind: 'exec', summary: 'uninstall x' })).to.equal('uninstall x');
            expect(describeOp({ kind: 'exec', command: 'npm uninstall -g x' })).to.contain('npm uninstall');
            expect(describeOp({ kind: 'none', bakelet: 'lang' })).to.equal('lang');
            // Refused entries name their target, not the bakelet again.
            expect(describeOp({ kind: 'refused', bakelet: 'cfg', path: '/p/clone' })).to.equal('/p/clone');
        });

        it('groups the plan into will remove / will ask / refused / no inverse', function() {
            const { lines } = captureLog(() => render([
                { kind: 'paths', bakelet: 'files', paths: ['a'], default: true },
                { kind: 'exec', bakelet: 'opencode', command: 'x', default: false },
                { kind: 'refused', bakelet: 'cfg', path: '/p', reason: '2 uncommitted change(s)' },
                { kind: 'none', bakelet: 'lang', reason: 'deferred' }
            ], '/src', '/root'));
            const text = lines.join('\n');

            expect(text).to.contain('will remove');
            expect(text).to.contain('will ask');
            expect(text).to.contain('refused');
            expect(text).to.contain('no inverse available');
            expect(text).to.contain('2 uncommitted change(s)');
        });

        it('states the drift limitation whenever files: is in the plan (AC-18)', function() {
            const { lines } = captureLog(() => render(
                [{ kind: 'paths', bakelet: 'files', paths: ['a'], default: true }], '/src', '/the/root'
            ));
            const text = lines.join('\n');

            expect(text).to.contain('removes what this config describes now');
            expect(text).to.contain('/the/root');
        });

        it('omits the drift note when no files: entry is present', function() {
            const { lines } = captureLog(() => render(
                [{ kind: 'exec', bakelet: 'opencode', command: 'x', default: false }], '/src', '/root'
            ));
            expect(lines.join('\n')).to.not.contain('describes now');
        });

        it('labels the provider by transport, not by environment name', function() {
            const Local = require('../../lib/modules/providers/local');
            const Docker = require('../../lib/modules/providers/docker-local');
            expect(providerLabel(new Local())).to.equal('local');
            expect(providerLabel(new Docker())).to.equal('docker-local');
            expect(providerLabel(null)).to.equal('unknown');
        });

        it('records removed, refused, and kept dispositions in one entry', async function() {
            const removed = { kind: 'paths', bakelet: 'files', paths: ['a.md'], default: true };
            const kept = { kind: 'exec', bakelet: 'opencode', command: 'x', default: false };
            const refused = { kind: 'refused', bakelet: 'cfg', path: '/p', reason: 'dirty' };

            await recordRun({
                plan: [removed, kept, refused],
                approved: [removed],
                results: [{ operation: removed, status: 'removed' }],
                source: './unit', provider: 'local', root: '/root'
            });

            const log = await fs.readFile(CleanupLog.logPath(), 'utf8');
            expect(log).to.contain('REMOVED');
            expect(log).to.contain('KEPT');
            expect(log).to.contain('declined at prompt');
            expect(log).to.contain('REFUSED');
            expect(log).to.contain('dirty');
        });

        it('records a failed operation as FAILED with its message', async function() {
            const op = { kind: 'exec', bakelet: 'x', command: 'y' };
            await recordRun({
                plan: [op], approved: [op],
                results: [{ operation: op, status: 'failed', error: new Error('exploded') }],
                source: '.', provider: 'local', root: '/root'
            });
            expect(await fs.readFile(CleanupLog.logPath(), 'utf8')).to.contain('FAILED');
        });

        it('summarizes counts of removed, kept, and refused', function() {
            const removed = { kind: 'paths', bakelet: 'files', paths: ['a'], default: true };
            const kept = { kind: 'exec', bakelet: 't', command: 'x', default: false };
            const refused = { kind: 'refused', bakelet: 'c', reason: 'dirty' };

            const { lines } = captureLog(() => summarize(
                [{ operation: removed, status: 'removed' }],
                [removed, kept, refused],
                [removed]
            ));
            const text = lines.join('\n');
            expect(text).to.contain('Removed 1');
            expect(text).to.contain('Kept 1');
            expect(text).to.contain('Refused 1');
        });

        it('rejects --all without --yes rather than widening silently', async function() {
            const originalExitCode = process.exitCode;
            const errors = [];
            const Print = require('../../lib/modules/print');
            const originalError = Print.error;
            Print.error = (e) => errors.push(e.message || String(e));
            try {
                await cleanup.handler({ all: true, yes: false });
            } finally {
                Print.error = originalError;
                process.exitCode = originalExitCode;
            }
            expect(errors.join(' ')).to.contain('--all requires --yes');
        });
    });

    // The plan → render → confirm → apply flow, driven end to end with a
    // stubbed provider. This is where --dry-run, --yes, and abort-safety live.
    describe('the handler flow', function() {
        const home = withTempHome();
        const cleanup = require('../../lib/commands/cleanup');
        const Baker = require('../../lib/modules/baker');
        const inquirer = require('inquirer');

        let origChoose, origPrompt, origLog, applied;

        beforeEach(async function() {
            await fs.outputFile(path.join(bakePath, 'baker.yml'), `name: handler\nlocal: ${envRoot}\n`);
            origChoose = Baker.chooseProvider;
            origPrompt = inquirer.prompt;
            origLog = console.log;
            console.log = () => {};
            applied = null;
        });

        afterEach(function() {
            Baker.chooseProvider = origChoose;
            inquirer.prompt = origPrompt;
            console.log = origLog;
            process.exitCode = 0;
        });

        // A plan with one of each disposition.
        function stubProvider(plan) {
            Baker.chooseProvider = async () => ({
                provider: { constructor: { name: 'LocalProvider' } },
                envName: 'handler',
                BakerObj: {
                    planRemoval: async () => ({ plan, root: envRoot }),
                    applyRemoval: async (approved) => {
                        applied = approved;
                        return approved.map((operation) => ({ operation, status: 'removed' }));
                    }
                }
            });
        }

        function samplePlan() {
            return [
                { kind: 'paths', section: 'config', bakelet: 'files', paths: ['a.md'], default: true, _bakelet: {} },
                { kind: 'exec', section: 'tools', bakelet: 'opencode', command: 'npm uninstall -g opencode-ai', default: false, _bakelet: {} },
                { kind: 'refused', section: 'tools', bakelet: 'cfg repo', path: '/p', reason: '2 uncommitted change(s)' },
                { kind: 'none', section: 'lang', bakelet: 'lang', reason: 'deferred' }
            ];
        }

        it('--dry-run applies nothing and writes nothing to the log (AC-4, AC-19)', async function() {
            stubProvider(samplePlan());
            await cleanup.handler({ source: bakePath, dryRun: true });

            expect(applied).to.equal(null);
            expect(await fs.pathExists(CleanupLog.logPath())).to.equal(false);
        });

        it('--yes applies only the defaults (AC-13)', async function() {
            stubProvider(samplePlan());
            await cleanup.handler({ source: bakePath, yes: true });

            expect(applied.map((o) => o.bakelet)).to.deep.equal(['files']);
        });

        it('--yes --all adds the No-default entries but never the refused one (AC-9)', async function() {
            stubProvider(samplePlan());
            await cleanup.handler({ source: bakePath, yes: true, all: true });

            expect(applied.map((o) => o.bakelet)).to.deep.equal(['files', 'opencode']);
            expect(applied.some((o) => o.kind === 'refused')).to.equal(false);
        });

        it('applies exactly what the prompt returned', async function() {
            stubProvider(samplePlan());
            // Select the second selectable entry (the tool), not the first.
            inquirer.prompt = async () => ({ selected: [1] });
            await cleanup.handler({ source: bakePath });

            expect(applied.map((o) => o.bakelet)).to.deep.equal(['opencode']);
        });

        it('offers the refused entry to no one, not even the prompt', async function() {
            stubProvider(samplePlan());
            let offered = null;
            inquirer.prompt = async (questions) => {
                offered = questions[0].choices.map((c) => c.name);
                return { selected: [] };
            };
            await cleanup.handler({ source: bakePath });

            expect(offered.join(' ')).to.not.contain('cfg repo');
        });

        it('pre-checks the prompt to each entry default', async function() {
            stubProvider(samplePlan());
            let checked = null;
            inquirer.prompt = async (questions) => {
                checked = questions[0].choices.map((c) => c.checked);
                return { selected: [] };
            };
            await cleanup.handler({ source: bakePath });

            expect(checked).to.deep.equal([true, false]);
        });

        it('changes nothing when the user selects nothing (AC-3)', async function() {
            stubProvider(samplePlan());
            inquirer.prompt = async () => ({ selected: [] });
            const before = await hashTree(envRoot);
            await cleanup.handler({ source: bakePath });

            expect(applied).to.equal(null);
            expect(await hashTree(envRoot)).to.equal(before);
        });

        it('exits cleanly when the plan has nothing selectable', async function() {
            stubProvider([{ kind: 'none', section: 'lang', bakelet: 'lang', reason: 'deferred' }]);
            await cleanup.handler({ source: bakePath, yes: true });

            expect(applied).to.equal(null);
            expect(await fs.pathExists(CleanupLog.logPath())).to.equal(false);
        });

        it('writes the log once a run actually removes something', async function() {
            stubProvider(samplePlan());
            await cleanup.handler({ source: bakePath, yes: true });

            const log = await fs.readFile(CleanupLog.logPath(), 'utf8');
            expect(log).to.contain('provider=local');
            expect(log).to.contain('REMOVED');
            expect(log).to.contain('REFUSED');
        });

        it('errors clearly for a provider with no cleanup path', async function() {
            Baker.chooseProvider = async () => ({ provider: {}, envName: 'x', BakerObj: {} });
            const errors = [];
            const Print = require('../../lib/modules/print');
            const originalError = Print.error;
            Print.error = (e) => errors.push(e.message || String(e));
            try {
                await cleanup.handler({ source: bakePath, yes: true });
            } finally { Print.error = originalError; }

            expect(errors.join(' ')).to.contain('local:, docker:, and remote:');
        });
    });

    describe('failures are reported, not fatal', function() {

        it('records a failed operation and keeps going', async function() {
            const boom = {
                kind: 'exec', bakelet: 'bad', command: 'x',
                _bakelet: { uninstall: async () => { throw new Error('nope'); } }
            };
            const ok = { kind: 'exec', bakelet: 'good', command: 'y', _bakelet: { uninstall: async () => {} } };

            const results = await resolve.applyBakeletRemoval([boom, ok], false);
            expect(results[0].status).to.equal('failed');
            expect(results[0].error.message).to.equal('nope');
            expect(results[1].status).to.equal('removed');
        });
    });
});
