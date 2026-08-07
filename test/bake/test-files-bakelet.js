const fs     = require('fs-extra');
const os     = require('os');
const path   = require('path');
const chai   = require('chai');
const expect = chai.expect;

const Files = require('../../lib/bakelets/config/files');

// A bakelet wired for local mode: placement is fs against a temp environment
// root, and the recorders exist so tests can assert they were NEVER used for
// placement (AC-2).
function localBakelet(envRoot, bakePath, name = 'testenv') {
    const bakelet = new Files(name, null, '');
    bakelet.setBakeletName('files');
    bakelet.setBakePath(bakePath);
    bakelet.setLocalLocation(envRoot);
    bakelet.execCalls = [];
    bakelet.copyCalls = [];
    bakelet.exec = async (cmd) => { bakelet.execCalls.push(cmd); };
    bakelet.copy = async (src, dest) => { bakelet.copyCalls.push({ src, dest }); };
    return bakelet;
}

// A bakelet wired for a non-local transport: everything is recorded, nothing
// runs. BAKER_SHARE_DIR is what the resolver pushes into extra_vars.
function remoteBakelet(bakePath, name = 'testenv', shareDir = '/project') {
    const bakelet = new Files(name, null, '');
    bakelet.setBakeletName('files');
    bakelet.setBakePath(bakePath);
    bakelet.execCalls = [];
    bakelet.copyCalls = [];
    bakelet.exec = async (cmd) => { bakelet.execCalls.push(cmd); };
    bakelet.copy = async (src, dest) => { bakelet.copyCalls.push({ src, dest }); };
    bakelet.execCapture = async () => '';
    bakelet.shareDir = shareDir;
    return bakelet;
}

const VARS = (shareDir = '/project') => [{ BAKER_SHARE_DIR: shareDir }];

async function bake(bakelet, block, variables) {
    await bakelet.load(block, variables || VARS());
    await bakelet.install();
    return bakelet;
}

describe('config: files bakelet', function() {
    let envRoot, bakePath;

    beforeEach(async function() {
        const base = await fs.mkdtemp(path.join(os.tmpdir(), 'baker-files-'));
        envRoot = path.join(base, 'env');
        bakePath = path.join(base, 'config');
        await fs.ensureDir(envRoot);
        await fs.ensureDir(bakePath);
    });

    afterEach(async function() {
        await fs.remove(path.dirname(envRoot)).catch(() => {});
    });

    describe('AC-1 / AC-2: nested destination in local mode', function() {

        it('writes to the full nested path, creating parents', async function() {
            await fs.outputFile(path.join(bakePath, 'a.md'), 'hello');
            const bakelet = localBakelet(envRoot, bakePath);
            await bake(bakelet, { files: [{ src: 'a.md', dest: 'x/y/a.md' }] });

            expect(await fs.readFile(path.join(envRoot, 'x/y/a.md'), 'utf8')).to.equal('hello');
        });

        it('does not flatten to the environment root', async function() {
            await fs.outputFile(path.join(bakePath, 'a.md'), 'hello');
            const bakelet = localBakelet(envRoot, bakePath);
            await bake(bakelet, { files: [{ src: 'a.md', dest: 'x/y/a.md' }] });

            expect(await fs.pathExists(path.join(envRoot, 'a.md'))).to.equal(false);
        });

        it('uses no transport for placement (AC-2)', async function() {
            await fs.outputFile(path.join(bakePath, 'a.md'), 'hello');
            const bakelet = localBakelet(envRoot, bakePath);
            await bake(bakelet, { files: [{ src: 'a.md', dest: 'x/y/a.md' }] });

            expect(bakelet.copyCalls).to.deep.equal([]);
            expect(bakelet.execCalls).to.deep.equal([]);
        });
    });

    describe('AC-3: non-local mode stages, then moves', function() {

        it('issues mkdir, copy, then mv in order', async function() {
            await fs.outputFile(path.join(bakePath, 'opencode.json'), '{}');
            const bakelet = remoteBakelet(bakePath);
            await bake(bakelet, { files: [{ src: 'opencode.json', dest: '.opencode/config.json' }] });

            expect(bakelet.execCalls[0]).to.contain('mkdir -p');
            expect(bakelet.execCalls[0]).to.contain('/project/.opencode');
            expect(bakelet.copyCalls).to.have.lengthOf(1);
            const move = bakelet.execCalls.find((c) => c.startsWith('mv -f'));
            expect(move).to.contain('/project/.opencode/config.json');
        });

        it('stages under the source basename, so a renamed dest still lands right', async function() {
            await fs.outputFile(path.join(bakePath, 'opencode.json'), '{}');
            const bakelet = remoteBakelet(bakePath);
            await bake(bakelet, { files: [{ src: 'opencode.json', dest: '.opencode/config.json' }] });

            expect(bakelet.copyCalls[0].dest).to.contain('files/opencode.json');
        });
    });

    describe('AC-4: overwrite controls re-bake behaviour', function() {

        it('replaces an existing file by default', async function() {
            await fs.outputFile(path.join(bakePath, 'a.md'), 'new');
            await fs.outputFile(path.join(envRoot, 'a.md'), 'old');
            const bakelet = localBakelet(envRoot, bakePath);
            await bake(bakelet, { files: [{ src: 'a.md', dest: 'a.md' }] });

            expect(await fs.readFile(path.join(envRoot, 'a.md'), 'utf8')).to.equal('new');
        });

        it('leaves an existing file alone with overwrite: false', async function() {
            await fs.outputFile(path.join(bakePath, 'a.md'), 'new');
            await fs.outputFile(path.join(envRoot, 'a.md'), 'old');
            const bakelet = localBakelet(envRoot, bakePath);
            await bake(bakelet, { files: [{ src: 'a.md', dest: 'a.md', overwrite: false }] });

            expect(await fs.readFile(path.join(envRoot, 'a.md'), 'utf8')).to.equal('old');
        });

        it('still places the file when it does not yet exist', async function() {
            await fs.outputFile(path.join(bakePath, 'a.md'), 'new');
            const bakelet = localBakelet(envRoot, bakePath);
            await bake(bakelet, { files: [{ src: 'a.md', dest: 'a.md', overwrite: false }] });

            expect(await fs.readFile(path.join(envRoot, 'a.md'), 'utf8')).to.equal('new');
        });

        it('guards with [ -e … ] in non-local mode', async function() {
            await fs.outputFile(path.join(bakePath, 'a.md'), 'new');
            const bakelet = remoteBakelet(bakePath);
            await bake(bakelet, { files: [{ src: 'a.md', dest: 'a.md', overwrite: false }] });

            const guarded = bakelet.execCalls.find((c) => c.includes('[ -e '));
            expect(guarded).to.contain('/project/a.md');
            expect(guarded).to.contain('mv -f');
        });
    });

    describe('AC-5: mode applies a chmod after placement', function() {

        it('chmods the destination locally', async function() {
            await fs.outputFile(path.join(bakePath, 'submit.sh'), '#!/bin/sh\n');
            const bakelet = localBakelet(envRoot, bakePath);
            await bake(bakelet, { files: [{ src: 'submit.sh', dest: 'submit.sh', mode: '0755' }] });

            const stat = await fs.stat(path.join(envRoot, 'submit.sh'));
            expect((stat.mode & 0o777).toString(8)).to.equal('755');
        });

        it('issues chmod after the move in non-local mode', async function() {
            await fs.outputFile(path.join(bakePath, 'submit.sh'), '#!/bin/sh\n');
            const bakelet = remoteBakelet(bakePath);
            await bake(bakelet, { files: [{ src: 'submit.sh', dest: 'submit.sh', mode: '0755' }] });

            const moveAt = bakelet.execCalls.findIndex((c) => c.includes('mv -f'));
            const chmodAt = bakelet.execCalls.findIndex((c) => c.startsWith('chmod 0755'));
            expect(chmodAt).to.be.greaterThan(moveAt);
        });
    });

    describe('AC-6: URL sources', function() {
        let original;

        beforeEach(function() { original = Files.download; });
        afterEach(function() { Files.download = original; });

        it('downloads and places a URL source', async function() {
            Files.download = async () => 'fetched body';
            const bakelet = localBakelet(envRoot, bakePath);
            await bake(bakelet, {
                files: [{ src: 'https://example.com/build.txt', dest: 'prompts/build.txt' }]
            });

            expect(await fs.readFile(path.join(envRoot, 'prompts/build.txt'), 'utf8'))
                .to.equal('fetched body');
        });

        it('propagates a fetch failure naming the URL and status', async function() {
            Files.download = async (url) => { throw new Error(`Failed to fetch ${url}: HTTP 404`); };
            const bakelet = localBakelet(envRoot, bakePath);

            let error = null;
            try {
                await bake(bakelet, { files: [{ src: 'https://example.com/x.txt', dest: 'x.txt' }] });
            } catch (err) { error = err; }

            expect(error.message).to.contain('https://example.com/x.txt');
            expect(error.message).to.contain('404');
        });

        it('does not treat a URL as a missing local source', async function() {
            Files.download = async () => 'body';
            const bakelet = localBakelet(envRoot, bakePath);
            await bake(bakelet, { files: [{ src: 'https://example.com/x.txt', dest: 'x.txt' }] });
            expect(await fs.pathExists(path.join(envRoot, 'x.txt'))).to.equal(true);
        });
    });

    describe('AC-7: bare-string shorthand', function() {

        it('uses the same relative path on both sides', async function() {
            await fs.outputFile(path.join(bakePath, '.opencode/topics/current.md'), 'topic');
            const bakelet = localBakelet(envRoot, bakePath);
            await bake(bakelet, { files: ['.opencode/topics/current.md'] });

            expect(await fs.readFile(path.join(envRoot, '.opencode/topics/current.md'), 'utf8'))
                .to.equal('topic');
        });

        it('defaults to overwrite', async function() {
            expect(Files.normalizeEntry('a.md', 0)).to.deep.equal({
                kind: 'file', src: 'a.md', dest: 'a.md', overwrite: true
            });
        });
    });

    describe('AC-8 / AC-16: directory sources and overlay merge', function() {

        it('copies a directory tree recursively', async function() {
            await fs.outputFile(path.join(bakePath, 'base/.opencode/agents/build.md'), 'build');
            await fs.outputFile(path.join(bakePath, 'base/AGENTS.md'), 'agents');
            const bakelet = localBakelet(envRoot, bakePath);
            await bake(bakelet, { files: [{ src: 'base/', dest: '.' }] });

            expect(await fs.readFile(path.join(envRoot, '.opencode/agents/build.md'), 'utf8')).to.equal('build');
            expect(await fs.readFile(path.join(envRoot, 'AGENTS.md'), 'utf8')).to.equal('agents');
        });

        it('merges overlays, later entry winning on a shared path (AC-16)', async function() {
            await fs.outputFile(path.join(bakePath, 'base/shared.md'), 'from base');
            await fs.outputFile(path.join(bakePath, 'base/only-base.md'), 'base only');
            await fs.outputFile(path.join(bakePath, 'overlay/shared.md'), 'from overlay');
            await fs.outputFile(path.join(bakePath, 'overlay/only-overlay.md'), 'overlay only');

            const bakelet = localBakelet(envRoot, bakePath);
            await bake(bakelet, {
                files: [{ src: 'base/', dest: '.' }, { src: 'overlay/', dest: '.' }]
            });

            expect(await fs.readFile(path.join(envRoot, 'shared.md'), 'utf8')).to.equal('from overlay');
            expect(await fs.pathExists(path.join(envRoot, 'only-base.md'))).to.equal(true);
            expect(await fs.pathExists(path.join(envRoot, 'only-overlay.md'))).to.equal(true);
        });

        it('uses cp -rf <staged>/. <dest>/ so a directory merges rather than nests (AC-16)', async function() {
            await fs.ensureDir(path.join(bakePath, 'base'));
            await fs.outputFile(path.join(bakePath, 'base/x.md'), 'x');
            const bakelet = remoteBakelet(bakePath);
            await bake(bakelet, { files: [{ src: 'base/', dest: '.' }] });

            const copyCmd = bakelet.execCalls.find((c) => c.includes('cp -rf'));
            // The trailing /. is the whole point: without it the copy nests.
            expect(copyCmd).to.contain('/." "');
            expect(copyCmd).to.match(/cp -rf "[^"]*\/\." "[^"]*\/"/);
        });
    });

    describe('AC-9: traversal guard', function() {

        it('throws for a relative dest escaping the environment root', async function() {
            await fs.outputFile(path.join(bakePath, 'a.md'), 'x');
            const bakelet = localBakelet(envRoot, bakePath);

            let error = null;
            try {
                await bake(bakelet, { files: [{ src: 'a.md', dest: '../escaped.md' }] });
            } catch (err) { error = err; }

            expect(error.message).to.contain('outside the environment root');
        });

        it('writes nothing when the guard fires', async function() {
            await fs.outputFile(path.join(bakePath, 'a.md'), 'x');
            const bakelet = localBakelet(envRoot, bakePath);
            try {
                await bake(bakelet, { files: [{ src: 'a.md', dest: '../escaped.md' }] });
            } catch (err) { /* expected */ }

            expect(await fs.pathExists(path.join(path.dirname(envRoot), 'escaped.md'))).to.equal(false);
        });

        it('allows a deliberate absolute dest', async function() {
            await fs.outputFile(path.join(bakePath, 'a.md'), 'x');
            const outside = path.join(path.dirname(envRoot), 'outside.md');
            const bakelet = localBakelet(envRoot, bakePath);
            await bake(bakelet, { files: [{ src: 'a.md', dest: outside }] });

            expect(await fs.pathExists(outside)).to.equal(true);
        });
    });

    describe('AC-10: shell-safety invariant', function() {

        it('composes no command containing a single quote', async function() {
            await fs.outputFile(path.join(bakePath, 'a b.md'), 'spaces in name');
            await fs.outputFile(path.join(bakePath, 'block.txt'), 'ignored');
            await fs.ensureDir(path.join(bakePath, 'dir'));
            await fs.outputFile(path.join(bakePath, 'dir/x.md'), 'x');

            const bakelet = remoteBakelet(bakePath);
            await bake(bakelet, {
                files: [
                    { src: 'a b.md', dest: 'a b.md', mode: '0755' },
                    { src: 'dir/', dest: 'nested/' },
                    { src: 'block.txt', dest: '.gitignore', append: true },
                    { ensure: 'dir', path: '~/.config/opencode/goals' }
                ],
                run: ['npm --prefix .opencode install'],
                prune: true
            });

            expect(bakelet.execCalls.length).to.be.greaterThan(0);
            bakelet.execCalls.forEach((cmd) => {
                expect(cmd, cmd).to.not.contain("'");
            });
        });
    });

    describe('AC-11: missing source errors actionably', function() {

        it('names the resolved path and the bakePath', async function() {
            const bakelet = localBakelet(envRoot, bakePath);

            let error = null;
            try {
                await bake(bakelet, { files: [{ src: 'nope.md', dest: 'nope.md' }] });
            } catch (err) { error = err; }

            expect(error.message).to.contain('nope.md');
            expect(error.message).to.contain(bakePath);
        });
    });

    describe('AC-12: mode-agnostic dispatch', function() {

        it('takes the same entry in both modes, differing only in placement', async function() {
            await fs.outputFile(path.join(bakePath, 'a.md'), 'x');
            const entry = { files: [{ src: 'a.md', dest: 'x/a.md' }] };

            const local = localBakelet(envRoot, bakePath);
            await bake(local, JSON.parse(JSON.stringify(entry)));
            const remote = remoteBakelet(bakePath);
            await bake(remote, JSON.parse(JSON.stringify(entry)));

            expect(await fs.pathExists(path.join(envRoot, 'x/a.md'))).to.equal(true);
            expect(remote.copyCalls).to.have.lengthOf(1);
            expect(local.copyCalls).to.have.lengthOf(0);
        });
    });

    describe('AC-13: manifest', function() {

        it('records exactly the paths placed, with their modes', async function() {
            await fs.outputFile(path.join(bakePath, 'a.md'), 'a');
            await fs.outputFile(path.join(bakePath, 'b.md'), 'b');
            const bakelet = localBakelet(envRoot, bakePath, 'cs-pm3');
            await bake(bakelet, {
                files: [
                    { src: 'a.md', dest: 'a.md' },
                    { src: 'b.md', dest: 'NOTES.md', overwrite: false }
                ]
            });

            const manifest = await fs.readJson(path.join(envRoot, '.baker-manifest.json'));
            expect(manifest.name).to.equal('cs-pm3');
            expect(manifest.bakelet).to.equal('files');
            expect(manifest.entries).to.deep.equal([
                { path: 'a.md', mode: 'overwrite' },
                { path: 'NOTES.md', mode: 'once' }
            ]);
        });

        it('writes the manifest at the environment root', async function() {
            await fs.outputFile(path.join(bakePath, 'a.md'), 'a');
            const bakelet = localBakelet(envRoot, bakePath);
            await bake(bakelet, { files: [{ src: 'a.md', dest: 'a.md' }] });

            expect(await fs.pathExists(path.join(envRoot, '.baker-manifest.json'))).to.equal(true);
        });
    });

    describe('AC-14: ~ expansion', function() {

        it('expands a ~ dest and treats it as absolute', async function() {
            const bakelet = localBakelet(envRoot, bakePath);
            const resolved = bakelet.resolveDest('~/x/y');
            expect(resolved.absolute).to.equal(true);
            expect(resolved.full).to.equal(path.join(os.homedir(), 'x/y'));
        });

        it('records it verbatim so it is never pruned', async function() {
            const goals = path.join(envRoot, 'fake-home', 'goals');
            const bakelet = localBakelet(envRoot, bakePath);
            await bake(bakelet, { files: [{ ensure: 'dir', path: goals }] });

            const manifest = await fs.readJson(path.join(envRoot, '.baker-manifest.json'));
            expect(manifest.entries[0]).to.deep.equal({ path: goals, mode: 'dir' });
        });

        it('leaves ~ for the shell to expand in non-local mode', async function() {
            const bakelet = remoteBakelet(bakePath);
            await bake(bakelet, { files: [{ ensure: 'dir', path: '~/.config/opencode/goals' }] });
            expect(bakelet.execCalls[0]).to.contain('~/.config/opencode/goals');
        });
    });

    describe('AC-15: ensure: dir', function() {

        it('creates the directory and copies nothing', async function() {
            const bakelet = localBakelet(envRoot, bakePath);
            await bake(bakelet, { files: [{ ensure: 'dir', path: 'made/up/dir' }] });

            expect((await fs.stat(path.join(envRoot, 'made/up/dir'))).isDirectory()).to.equal(true);
            expect(bakelet.copyCalls).to.deep.equal([]);
        });

        it('is idempotent', async function() {
            const bakelet = localBakelet(envRoot, bakePath);
            await bake(bakelet, { files: [{ ensure: 'dir', path: 'made/dir' }] });
            await bake(localBakelet(envRoot, bakePath), { files: [{ ensure: 'dir', path: 'made/dir' }] });

            expect(await fs.pathExists(path.join(envRoot, 'made/dir'))).to.equal(true);
        });

        it('throws when combined with src or dest', function() {
            expect(() => Files.normalizeEntry({ ensure: 'dir', path: 'x', src: 'y' }, 0))
                .to.throw(/cannot be combined/);
        });

        it('throws for an ensure value other than dir', function() {
            expect(() => Files.normalizeEntry({ ensure: 'file', path: 'x' }, 0))
                .to.throw(/only supports "dir"/);
        });

        it('throws when path is missing', function() {
            expect(() => Files.normalizeEntry({ ensure: 'dir' }, 0)).to.throw(/requires a path/);
        });
    });

    describe('AC-17: prune removes what the previous bake placed', function() {

        it('deletes a path dropped from the config, with prune: true', async function() {
            await fs.outputFile(path.join(bakePath, 'legacy.md'), 'old');
            await fs.outputFile(path.join(bakePath, 'keep.md'), 'keep');

            await bake(localBakelet(envRoot, bakePath), {
                files: [
                    { src: 'legacy.md', dest: '.opencode/agents/legacy.md' },
                    { src: 'keep.md', dest: 'keep.md' }
                ],
                prune: true
            });
            expect(await fs.pathExists(path.join(envRoot, '.opencode/agents/legacy.md'))).to.equal(true);

            await bake(localBakelet(envRoot, bakePath), {
                files: [{ src: 'keep.md', dest: 'keep.md' }],
                prune: true
            });

            expect(await fs.pathExists(path.join(envRoot, '.opencode/agents/legacy.md'))).to.equal(false);
            expect(await fs.pathExists(path.join(envRoot, 'keep.md'))).to.equal(true);
        });

        // The case the unit tests originally missed and the live smoke caught:
        // both configs have an entry with dest ".", so recording the ENTRY
        // rather than the files it placed makes nothing ever look stale, and a
        // PM2-only agent survives the switch to PM3.
        it('prunes a file dropped from a directory overlay (the assignment switch)', async function() {
            await fs.outputFile(path.join(bakePath, 'base/shared.md'), 'shared');
            await fs.outputFile(path.join(bakePath, 'pm2/agents/pm2-only.md'), 'pm2');
            await fs.outputFile(path.join(bakePath, 'pm3/agents/pm3-only.md'), 'pm3');

            await bake(localBakelet(envRoot, bakePath), {
                files: [{ src: 'base/', dest: '.' }, { src: 'pm2/', dest: '.' }], prune: true
            });
            expect(await fs.pathExists(path.join(envRoot, 'agents/pm2-only.md'))).to.equal(true);

            await bake(localBakelet(envRoot, bakePath), {
                files: [{ src: 'base/', dest: '.' }, { src: 'pm3/', dest: '.' }], prune: true
            });

            expect(await fs.pathExists(path.join(envRoot, 'agents/pm2-only.md'))).to.equal(false);
            expect(await fs.pathExists(path.join(envRoot, 'agents/pm3-only.md'))).to.equal(true);
            expect(await fs.pathExists(path.join(envRoot, 'shared.md'))).to.equal(true);
        });

        it('records every file a directory entry placed, not the entry itself', async function() {
            await fs.outputFile(path.join(bakePath, 'base/a.md'), 'a');
            await fs.outputFile(path.join(bakePath, 'base/nested/b.md'), 'b');
            await bake(localBakelet(envRoot, bakePath), { files: [{ src: 'base/', dest: '.' }] });

            const manifest = await fs.readJson(path.join(envRoot, '.baker-manifest.json'));
            const paths = manifest.entries.map((e) => e.path).sort();
            expect(paths).to.deep.equal(['a.md', 'nested/b.md']);
        });

        it('records a path once when two overlays both place it', async function() {
            await fs.outputFile(path.join(bakePath, 'base/shared.md'), 'base');
            await fs.outputFile(path.join(bakePath, 'over/shared.md'), 'overlay');
            await bake(localBakelet(envRoot, bakePath), {
                files: [{ src: 'base/', dest: '.' }, { src: 'over/', dest: '.' }]
            });

            const manifest = await fs.readJson(path.join(envRoot, '.baker-manifest.json'));
            expect(manifest.entries.filter((e) => e.path === 'shared.md')).to.have.lengthOf(1);
            expect(await fs.readFile(path.join(envRoot, 'shared.md'), 'utf8')).to.equal('overlay');
        });

        it('prefixes the dest when a directory entry targets a subdirectory', async function() {
            await fs.outputFile(path.join(bakePath, 'base/a.md'), 'a');
            await bake(localBakelet(envRoot, bakePath), { files: [{ src: 'base/', dest: '.opencode' }] });

            const manifest = await fs.readJson(path.join(envRoot, '.baker-manifest.json'));
            expect(manifest.entries.map((e) => e.path)).to.deep.equal(['.opencode/a.md']);
        });

        it('removes the parent directory once it is empty', async function() {
            await fs.outputFile(path.join(bakePath, 'legacy.md'), 'old');
            await bake(localBakelet(envRoot, bakePath), {
                files: [{ src: 'legacy.md', dest: '.opencode/agents/legacy.md' }], prune: true
            });
            await bake(localBakelet(envRoot, bakePath), { files: [], prune: true });

            expect(await fs.pathExists(path.join(envRoot, '.opencode/agents'))).to.equal(false);
        });

        it('keeps the path when prune is false (the default)', async function() {
            await fs.outputFile(path.join(bakePath, 'legacy.md'), 'old');
            await bake(localBakelet(envRoot, bakePath), {
                files: [{ src: 'legacy.md', dest: 'legacy.md' }]
            });
            await bake(localBakelet(envRoot, bakePath), { files: [] });

            expect(await fs.pathExists(path.join(envRoot, 'legacy.md'))).to.equal(true);
        });

        it('prunes a once-mode entry too, when it leaves the config', async function() {
            await fs.outputFile(path.join(bakePath, 'n.md'), 'notes');
            await bake(localBakelet(envRoot, bakePath), {
                files: [{ src: 'n.md', dest: 'NOTES.md', overwrite: false }], prune: true
            });
            await bake(localBakelet(envRoot, bakePath), { files: [], prune: true });

            expect(await fs.pathExists(path.join(envRoot, 'NOTES.md'))).to.equal(false);
        });
    });

    describe('AC-18: prune never touches unmanaged paths', function() {

        it('leaves a file Baker never placed, even inside a managed directory', async function() {
            await fs.outputFile(path.join(bakePath, 'a.md'), 'a');
            await bake(localBakelet(envRoot, bakePath), {
                files: [{ src: 'a.md', dest: '.opencode/a.md' }], prune: true
            });

            // Student-generated, inside the same directory Baker manages.
            await fs.outputFile(path.join(envRoot, '.opencode/teacher-log.jsonl'), '{}');

            await bake(localBakelet(envRoot, bakePath), { files: [], prune: true });

            expect(await fs.pathExists(path.join(envRoot, '.opencode/teacher-log.jsonl'))).to.equal(true);
            expect(await fs.pathExists(path.join(envRoot, '.opencode/a.md'))).to.equal(false);
        });

        it('prunes nothing when there is no manifest (adoptive first bake)', async function() {
            await fs.outputFile(path.join(envRoot, 'pre-existing.md'), 'from setup.sh');
            await fs.outputFile(path.join(bakePath, 'a.md'), 'a');

            await bake(localBakelet(envRoot, bakePath), {
                files: [{ src: 'a.md', dest: 'a.md' }], prune: true
            });

            expect(await fs.pathExists(path.join(envRoot, 'pre-existing.md'))).to.equal(true);
        });

        it('prunes nothing when the manifest is corrupt, and warns', async function() {
            await fs.outputFile(path.join(envRoot, '.baker-manifest.json'), 'not json{');
            await fs.outputFile(path.join(envRoot, 'orphan.md'), 'x');
            await fs.outputFile(path.join(bakePath, 'a.md'), 'a');

            const warnings = [];
            const original = console.warn;
            console.warn = (msg) => warnings.push(msg);
            try {
                await bake(localBakelet(envRoot, bakePath), {
                    files: [{ src: 'a.md', dest: 'a.md' }], prune: true
                });
            } finally { console.warn = original; }

            expect(await fs.pathExists(path.join(envRoot, 'orphan.md'))).to.equal(true);
            expect(warnings.join(' ')).to.contain('not valid JSON');
        });
    });

    describe('AC-19: prune is confined to the environment root', function() {

        it('never prunes an absolute manifest entry', async function() {
            const outside = path.join(path.dirname(envRoot), 'outside-dir');
            await bake(localBakelet(envRoot, bakePath), {
                files: [{ ensure: 'dir', path: outside }], prune: true
            });
            expect(await fs.pathExists(outside)).to.equal(true);

            await bake(localBakelet(envRoot, bakePath), { files: [], prune: true });

            expect(await fs.pathExists(outside)).to.equal(true);
        });

        it('skips a manifest path that resolves outside the root, with a warning', async function() {
            const victim = path.join(path.dirname(envRoot), 'victim.md');
            await fs.outputFile(victim, 'do not delete');
            await fs.outputFile(path.join(envRoot, '.baker-manifest.json'), JSON.stringify({
                version: 1, bakelet: 'files', name: 'testenv', entries: [{ path: '../victim.md', mode: 'overwrite' }]
            }));

            const warnings = [];
            const original = console.warn;
            console.warn = (msg) => warnings.push(msg);
            try {
                await bake(localBakelet(envRoot, bakePath), { files: [], prune: true });
            } finally { console.warn = original; }

            expect(await fs.pathExists(victim)).to.equal(true);
            expect(warnings.join(' ')).to.contain('skipping prune');
        });
    });

    describe('AC-20: append is idempotent', function() {

        it('inserts a marker-delimited block', async function() {
            await fs.outputFile(path.join(bakePath, 'block.txt'), 'session-*.json\n');
            await fs.outputFile(path.join(envRoot, '.gitignore'), 'node_modules\n');

            await bake(localBakelet(envRoot, bakePath, 'pm3'), {
                files: [{ src: 'block.txt', dest: '.gitignore', append: true }]
            });

            const result = await fs.readFile(path.join(envRoot, '.gitignore'), 'utf8');
            expect(result).to.contain('node_modules');
            expect(result).to.contain('# >>> baker:pm3 >>>');
            expect(result).to.contain('session-*.json');
        });

        it('replaces the block in place on a second bake, leaving one block', async function() {
            await fs.outputFile(path.join(envRoot, '.gitignore'), 'node_modules\n');
            await fs.outputFile(path.join(bakePath, 'block.txt'), 'first\n');
            await bake(localBakelet(envRoot, bakePath, 'pm3'), {
                files: [{ src: 'block.txt', dest: '.gitignore', append: true }]
            });

            await fs.outputFile(path.join(bakePath, 'block.txt'), 'second\n');
            await bake(localBakelet(envRoot, bakePath, 'pm3'), {
                files: [{ src: 'block.txt', dest: '.gitignore', append: true }]
            });

            const result = await fs.readFile(path.join(envRoot, '.gitignore'), 'utf8');
            expect(result.split('# >>> baker:pm3 >>>')).to.have.lengthOf(2);
            expect(result).to.contain('second');
            expect(result).to.not.contain('first');
            expect(result).to.contain('node_modules');
        });

        // A renamed environment — cs-PM2 becoming cs-PM3 — shares one envRoot
        // and therefore one manifest, so the new bake must clean up the block
        // its predecessor wrote. Without this an instructor who names
        // environments per assignment accumulates one orphaned block each time.
        it('replaces a predecessor block when the environment is renamed', async function() {
            await fs.outputFile(path.join(envRoot, '.gitignore'), 'node_modules\n');
            await fs.outputFile(path.join(bakePath, 'block.txt'), 'rules\n');
            const config = { files: [{ src: 'block.txt', dest: '.gitignore', append: true }] };

            await bake(localBakelet(envRoot, bakePath, 'cs-PM2'), JSON.parse(JSON.stringify(config)));
            await bake(localBakelet(envRoot, bakePath, 'cs-PM3'), JSON.parse(JSON.stringify(config)));

            const result = await fs.readFile(path.join(envRoot, '.gitignore'), 'utf8');
            expect(result.match(/>>> baker:/g)).to.have.lengthOf(1);
            expect(result).to.contain('baker:cs-PM3');
            expect(result).to.not.contain('baker:cs-PM2');
            expect(result).to.contain('node_modules');
        });

        // Genuine coexistence: two environments with their own roots, and so
        // their own manifests, both appending into one shared file.
        it('leaves a block written by a different environment alone', async function() {
            const shared = path.join(path.dirname(envRoot), 'shared.gitignore');
            const otherRoot = path.join(path.dirname(envRoot), 'other-env');
            await fs.ensureDir(otherRoot);
            await fs.outputFile(shared, 'base\n');
            await fs.outputFile(path.join(bakePath, 'block.txt'), 'x\n');
            const config = () => ({ files: [{ src: 'block.txt', dest: shared, append: true }] });

            await bake(localBakelet(envRoot, bakePath, 'one'), config());
            await bake(localBakelet(otherRoot, bakePath, 'two'), config());

            const result = await fs.readFile(shared, 'utf8');
            expect(result).to.contain('# >>> baker:one >>>');
            expect(result).to.contain('# >>> baker:two >>>');
        });

        it('removes only the block, not the file, when pruned', async function() {
            await fs.outputFile(path.join(envRoot, '.gitignore'), 'node_modules\n');
            await fs.outputFile(path.join(bakePath, 'block.txt'), 'x\n');
            await bake(localBakelet(envRoot, bakePath, 'pm3'), {
                files: [{ src: 'block.txt', dest: '.gitignore', append: true }], prune: true
            });
            await bake(localBakelet(envRoot, bakePath, 'pm3'), { files: [], prune: true });

            const result = await fs.readFile(path.join(envRoot, '.gitignore'), 'utf8');
            expect(result).to.contain('node_modules');
            expect(result).to.not.contain('baker:pm3');
        });

        it('creates the file when it does not exist', async function() {
            await fs.outputFile(path.join(bakePath, 'block.txt'), 'rules\n');
            await bake(localBakelet(envRoot, bakePath), {
                files: [{ src: 'block.txt', dest: '.gitignore', append: true }]
            });
            expect(await fs.readFile(path.join(envRoot, '.gitignore'), 'utf8')).to.contain('rules');
        });

        it('throws when combined with overwrite: false', function() {
            expect(() => Files.normalizeEntry({ src: 'a', dest: 'b', append: true, overwrite: false }, 0))
                .to.throw(/mutually exclusive/);
        });
    });

    describe('AC-21: run executes after placement and prune', function() {

        it('issues run commands through exec, in order', async function() {
            await fs.outputFile(path.join(bakePath, 'a.md'), 'a');
            const bakelet = localBakelet(envRoot, bakePath);
            await bake(bakelet, {
                files: [{ src: 'a.md', dest: 'a.md' }],
                run: ['npm --prefix .opencode install', 'echo done']
            });

            expect(bakelet.execCalls).to.deep.equal([
                'npm --prefix .opencode install',
                'echo done'
            ]);
        });

        it('runs after the manifest is written, so placement is complete first', async function() {
            await fs.outputFile(path.join(bakePath, 'a.md'), 'a');
            const bakelet = localBakelet(envRoot, bakePath);
            let manifestExistedAtRun = false;
            bakelet.exec = async () => {
                manifestExistedAtRun = await fs.pathExists(path.join(envRoot, '.baker-manifest.json'));
            };
            await bake(bakelet, { files: [{ src: 'a.md', dest: 'a.md' }], run: ['anything'] });

            expect(manifestExistedAtRun).to.equal(true);
        });

        it('propagates a non-zero exit', async function() {
            const bakelet = localBakelet(envRoot, bakePath);
            bakelet.exec = async () => { throw new Error('npm ERR! exited 1'); };

            let error = null;
            try {
                await bake(bakelet, { files: [], run: ['npm install'] });
            } catch (err) { error = err; }

            expect(error.message).to.contain('npm ERR!');
        });

        it('anchors the command in the environment root in non-local mode', async function() {
            const bakelet = remoteBakelet(bakePath);
            await bake(bakelet, { files: [], run: ['npm install'] });

            const runCmd = bakelet.execCalls.find((c) => c.includes('npm install'));
            expect(runCmd).to.contain('cd "/project"');
        });

        it('rejects a non-list run:', async function() {
            const bakelet = localBakelet(envRoot, bakePath);
            let error = null;
            try { await bakelet.load({ files: [], run: 'npm install' }, VARS()); } catch (err) { error = err; }
            expect(error.message).to.contain('run: must be a list');
        });
    });

    describe('bakelet contract', function() {

        it('needs no elevation, no Ansible, and no platform detection', function() {
            const bakelet = new Files('testenv', null, '');
            expect(bakelet.requiresElevation).to.equal(false);
            expect(bakelet.requiresAnsible).to.equal(false);
            // Placement is fs locally and POSIX against a Linux target
            // otherwise, so there is no package manager to resolve.
            expect(bakelet.needsPlatform).to.equal(false);
        });
    });

    describe('pruning a stale ensure: dir locally', function() {

        it('removes the directory when it is empty', async function() {
            await bake(localBakelet(envRoot, bakePath), {
                files: [{ ensure: 'dir', path: 'goals' }], prune: true
            });
            await bake(localBakelet(envRoot, bakePath), { files: [], prune: true });

            expect(await fs.pathExists(path.join(envRoot, 'goals'))).to.equal(false);
        });

        it('keeps the directory when the student put something in it', async function() {
            await bake(localBakelet(envRoot, bakePath), {
                files: [{ ensure: 'dir', path: 'goals' }], prune: true
            });
            await fs.outputFile(path.join(envRoot, 'goals', 'mine.md'), 'student work');

            await bake(localBakelet(envRoot, bakePath), { files: [], prune: true });

            expect(await fs.readFile(path.join(envRoot, 'goals/mine.md'), 'utf8')).to.equal('student work');
        });

        it('tolerates a stale directory that is already gone', async function() {
            await bake(localBakelet(envRoot, bakePath), {
                files: [{ ensure: 'dir', path: 'goals' }], prune: true
            });
            await fs.remove(path.join(envRoot, 'goals'));

            await bake(localBakelet(envRoot, bakePath), { files: [], prune: true });
            expect(await fs.pathExists(path.join(envRoot, 'goals'))).to.equal(false);
        });
    });

    describe('schema validation', function() {

        it('rejects a non-list files:', async function() {
            const bakelet = localBakelet(envRoot, bakePath);
            let error = null;
            try { await bakelet.load({ files: 'a.md' }, VARS()); } catch (err) { error = err; }
            expect(error.message).to.contain('files: must be a list');
        });

        it('rejects an entry that is neither string nor map', function() {
            expect(() => Files.normalizeEntry(42, 0)).to.throw(/must be a string or a map/);
        });

        it('rejects an entry with no src and no ensure', function() {
            expect(() => Files.normalizeEntry({ dest: 'x' }, 0)).to.throw(/needs a src/);
        });

        it('numbers the offending entry in the message', function() {
            expect(() => Files.normalizeEntry({ dest: 'x' }, 4)).to.throw(/entry 5/);
        });

        it('defaults dest to src when only src is given', function() {
            expect(Files.normalizeEntry({ src: 'a/b.md' }, 0).dest).to.equal('a/b.md');
        });
    });

    // The spec assumed prune would be local-only, because reading the previous
    // manifest off a container needed a capture-capable exec. execCapture now
    // exists on all three transports, so prune works everywhere.
    describe('prune and manifest in non-local mode', function() {

        function withManifest(bakelet, entries) {
            bakelet.execCapture = async () => JSON.stringify({
                version: 1, bakelet: 'files', name: 'testenv', entries
            });
            return bakelet;
        }

        it('reads the previous manifest through execCapture', async function() {
            const bakelet = withManifest(remoteBakelet(bakePath), [{ path: 'gone.md', mode: 'overwrite' }]);
            let asked = null;
            bakelet.execCapture = async (cmd) => {
                asked = cmd;
                return JSON.stringify({ version: 1, entries: [{ path: 'gone.md', mode: 'overwrite' }] });
            };
            await bake(bakelet, { files: [], prune: true });

            expect(asked).to.contain('/project/.baker-manifest.json');
        });

        it('removes a stale file with rm -rf', async function() {
            const bakelet = withManifest(remoteBakelet(bakePath), [{ path: 'gone.md', mode: 'overwrite' }]);
            await bake(bakelet, { files: [], prune: true });

            expect(bakelet.execCalls.some((c) => c === 'rm -rf "/project/gone.md"')).to.equal(true);
        });

        it('rmdirs the parent, tolerating a non-empty one', async function() {
            const bakelet = withManifest(remoteBakelet(bakePath), [{ path: 'a/b/gone.md', mode: 'overwrite' }]);
            await bake(bakelet, { files: [], prune: true });

            const rmdir = bakelet.execCalls.find((c) => c.startsWith('rmdir -p'));
            expect(rmdir).to.contain('/project/a/b');
            expect(rmdir).to.contain('|| true');
        });

        it('removes a stale ensure: dir only if empty', async function() {
            const bakelet = withManifest(remoteBakelet(bakePath), [{ path: 'made', mode: 'dir' }]);
            await bake(bakelet, { files: [], prune: true });

            expect(bakelet.execCalls.some((c) => c.startsWith('rmdir "/project/made"'))).to.equal(true);
        });

        it('strips a stale append block with sed rather than deleting the file', async function() {
            const bakelet = withManifest(remoteBakelet(bakePath), [{ path: '.gitignore', mode: 'append' }]);
            await bake(bakelet, { files: [], prune: true });

            const sed = bakelet.execCalls.find((c) => c.includes('sed -i'));
            expect(sed).to.contain('/project/.gitignore');
            expect(bakelet.execCalls.some((c) => c.includes('rm -rf'))).to.equal(false);
        });

        it('never prunes an absolute manifest entry', async function() {
            const bakelet = withManifest(remoteBakelet(bakePath), [
                { path: '~/.config/opencode/goals', mode: 'dir' },
                { path: '/etc/passwd', mode: 'overwrite' }
            ]);
            await bake(bakelet, { files: [], prune: true });

            expect(bakelet.execCalls.some((c) => c.includes('rm -rf'))).to.equal(false);
            expect(bakelet.execCalls.some((c) => c.includes('passwd'))).to.equal(false);
        });

        it('writes the manifest through a quoted heredoc', async function() {
            await fs.outputFile(path.join(bakePath, 'a.md'), 'a');
            const bakelet = remoteBakelet(bakePath);
            await bake(bakelet, { files: [{ src: 'a.md', dest: 'a.md' }] });

            const write = bakelet.execCalls.find((c) => c.includes('.baker-manifest.json') && c.includes('cat >'));
            expect(write).to.contain('<<"BAKER_MANIFEST"');
            expect(write).to.contain('"path": "a.md"');
        });

        it('treats an unreadable manifest as absent', async function() {
            const bakelet = remoteBakelet(bakePath);
            bakelet.execCapture = async () => { throw new Error('no such file'); };
            await bake(bakelet, { files: [], prune: true });

            expect(bakelet.execCalls.some((c) => c.includes('rm -rf'))).to.equal(false);
        });

        it('appends through a staged block and sed in non-local mode', async function() {
            await fs.outputFile(path.join(bakePath, 'block.txt'), 'rules\n');
            const bakelet = remoteBakelet(bakePath, 'pm3');
            await bake(bakelet, { files: [{ src: 'block.txt', dest: '.gitignore', append: true }] });

            const staged = bakelet.execCalls.find((c) => c.includes('BAKER_BLOCK'));
            expect(staged).to.contain('# >>> baker:pm3 >>>');
            const applied = bakelet.execCalls.find((c) => c.includes('sed -i') && c.includes('cat "'));
            expect(applied).to.contain('touch "/project/.gitignore"');
        });

        it('errors when BAKER_SHARE_DIR is unset', async function() {
            const bakelet = remoteBakelet(bakePath);
            let error = null;
            try { await bake(bakelet, { files: [] }, []); } catch (err) { error = err; }
            expect(error.message).to.contain('BAKER_SHARE_DIR');
        });
    });

    describe('convergence', function() {

        it('is a no-op on an unchanged re-bake, modulo the manifest timestamp', async function() {
            await fs.outputFile(path.join(bakePath, 'base/a.md'), 'a');
            await fs.outputFile(path.join(bakePath, 'base/nested/b.md'), 'b');
            const config = () => ({ files: [{ src: 'base/', dest: '.' }], prune: true });

            await bake(localBakelet(envRoot, bakePath), config());
            const first = await fs.readJson(path.join(envRoot, '.baker-manifest.json'));

            await bake(localBakelet(envRoot, bakePath), config());
            const second = await fs.readJson(path.join(envRoot, '.baker-manifest.json'));

            expect(second.entries).to.deep.equal(first.entries);
            expect(await fs.readFile(path.join(envRoot, 'nested/b.md'), 'utf8')).to.equal('b');
        });

        it('overwrites a student edit to a managed file', async function() {
            await fs.outputFile(path.join(bakePath, 'a.md'), 'instructor');
            await bake(localBakelet(envRoot, bakePath), { files: [{ src: 'a.md', dest: 'a.md' }] });
            await fs.outputFile(path.join(envRoot, 'a.md'), 'student edit');
            await bake(localBakelet(envRoot, bakePath), { files: [{ src: 'a.md', dest: 'a.md' }] });

            expect(await fs.readFile(path.join(envRoot, 'a.md'), 'utf8')).to.equal('instructor');
        });
    });
});

describe('files: src cannot escape the repository', function() {
    // Sub-directory addressing was removed 2026-08-07, so bakePath is always the
    // repository root. Nothing legitimately climbs out with ../../base/ any more,
    // and reaching above the root would place content from outside the repo the
    // address named.
    const Files = require('../../lib/bakelets/config/files');

    function make(bakePath) {
        const f = new Files('env', null, '');
        f.setBakePath(bakePath);
        return f;
    }

    it('resolves a plain relative src inside the repo', function() {
        const f = make('/repo');
        expect(f.resolveSrc('./content/')).to.equal(path.resolve('/repo/content'));
    });

    it('resolves a nested relative src', function() {
        const f = make('/repo');
        expect(f.resolveSrc('content/agents/reviewer.md'))
            .to.equal(path.resolve('/repo/content/agents/reviewer.md'));
    });

    it('allows the repository root itself', function() {
        const f = make('/repo');
        expect(f.resolveSrc('.')).to.equal(path.resolve('/repo'));
    });

    it('rejects a src that climbs one level out', function() {
        const f = make('/repo');
        expect(() => f.resolveSrc('../outside')).to.throw(/resolves outside the repository/);
    });

    it('rejects the old overlay form ../../base/', function() {
        const f = make('/repo');
        expect(() => f.resolveSrc('../../base/')).to.throw(/resolves outside the repository/);
    });

    it('rejects an absolute src outside the repo', function() {
        const f = make('/repo');
        expect(() => f.resolveSrc('/etc/passwd')).to.throw(/resolves outside the repository/);
    });

    it('points the author at refs rather than paths', function() {
        const f = make('/repo');
        expect(() => f.resolveSrc('../../base/')).to.throw(/branch or tag/);
    });

    it('is not fooled by a sibling directory with a shared prefix', function() {
        const f = make('/repo');
        expect(() => f.resolveSrc('../repo-other/x')).to.throw(/resolves outside the repository/);
    });
});
