const chai = require('chai');
const expect = chai.expect;

const fs   = require('fs-extra');
const os   = require('os');
const path = require('path');
const child_process = require('child_process');

const Git = require('../../lib/bakelets/resources/git');
const GitUtil = require('../../lib/modules/utils/git');

// The host-direct branch of resources/git shells out with child_process.execSync
// rather than this.exec, so these tests swap execSync for a recorder instead of
// injecting a transport. That is the seam the code actually has.
// Added by Claude Code (claude-opus-5[1m])
// Must await fn before restoring: returning the promise from a sync finally
// puts execSync back before the awaited body has run, and the real git runs.
async function withRecordedExec(fn) {
    const original = child_process.execSync;
    const calls = [];
    child_process.execSync = (cmd) => { calls.push(cmd); return ''; };
    try {
        return await fn(calls);
    } finally {
        child_process.execSync = original;
    }
}

async function runInstall(entry, cwd) {
    const bakelet = new Git('env', null, '');
    bakelet.setLocalLocation(cwd);
    await bakelet.load(entry, []);
    await bakelet.install();
    return bakelet;
}

describe('resources: git', function() {

    let tmp;

    beforeEach(function() {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'baker-git-'));
    });

    afterEach(function() {
        fs.removeSync(tmp);
    });

    it('clones when the destination does not exist', async function() {
        await withRecordedExec(async (calls) => {
            await runInstall({ git: 'https://github.com/example/repo.git:project' }, tmp);
            expect(calls).to.have.lengthOf(1);
            expect(calls[0]).to.contain('git clone');
            expect(calls[0]).to.contain('https://github.com/example/repo.git');
        });
    });

    // The regression this file exists for: a bare `git clone` fails when the
    // destination is there, execSync throws, and the whole bake dies before the
    // remaining bakelets run. A re-bake is the normal case in a per-unit
    // workflow, so it has to be a no-op rather than an error.
    it('skips the clone when the destination already exists', async function() {
        fs.ensureDirSync(path.join(tmp, 'project'));

        await withRecordedExec(async (calls) => {
            await runInstall({ git: 'https://github.com/example/repo.git:project' }, tmp);
            expect(calls).to.have.lengthOf(0);
        });
    });

    it('does not throw on a re-bake, so later bakelets still run', async function() {
        fs.ensureDirSync(path.join(tmp, 'project'));

        await withRecordedExec(async () => {
            // The assertion is that this resolves at all.
            await runInstall({ git: 'https://github.com/example/repo.git:project' }, tmp);
        });
    });

    it('leaves an existing checkout untouched, including uncommitted work', async function() {
        const dest = path.join(tmp, 'project');
        const work = path.join(dest, 'student-work.txt');
        fs.ensureDirSync(dest);
        fs.writeFileSync(work, 'uncommitted', 'utf8');

        await withRecordedExec(async () => {
            await runInstall({ git: 'https://github.com/example/repo.git:project' }, tmp);
        });

        expect(fs.readFileSync(work, 'utf8')).to.equal('uncommitted');
    });

    // Docker and remote both target Linux and both reach the target through
    // this.exec. Previously docker ran child_process on the HOST (cloning onto
    // the operator's machine) and remote threw ReferenceError.
    describe('docker and remote (no localLocation)', function() {

        async function runThroughTransport(entry) {
            const bakelet = new Git('env', null, '');
            const calls = [];
            bakelet.exec = async (cmd) => { calls.push(cmd); };
            await bakelet.load(entry, []);
            await bakelet.install();
            return { bakelet, calls };
        }

        it('clones through the transport, not on the host', async function() {
            await withRecordedExec(async (hostCalls) => {
                const { calls } = await runThroughTransport(
                    { git: 'https://github.com/example/repo.git:project' });

                expect(calls).to.have.lengthOf(1);
                expect(calls[0]).to.contain('git clone');
                expect(calls[0]).to.contain('project');
                // The regression: nothing may run on the host in these modes.
                expect(hostCalls).to.have.lengthOf(0);
            });
        });

        it('guards the clone so a re-bake is a no-op in the target', async function() {
            const { calls } = await runThroughTransport(
                { git: 'https://github.com/example/repo.git:project' });

            expect(calls[0]).to.match(/^if \[ -e "project" \]; then echo /);
            expect(calls[0]).to.contain('skipping clone');
            expect(calls[0]).to.contain('else git clone');
        });

        // docker-local wraps commands as `bash -c '<cmd>'`, so a single quote
        // anywhere truncates the command. Same invariant as command tables.
        it('contains no single quotes', async function() {
            const { calls } = await runThroughTransport(
                { git: 'https://github.com/example/repo.git:project' });
            expect(calls[0]).to.not.contain("'");
        });

        it('does not resolve the destination against the host filesystem', async function() {
            const { bakelet } = await runThroughTransport(
                { git: 'https://github.com/example/repo.git:project' });
            // cleanup must target the path inside the target, not a host path
            // that never existed.
            expect(bakelet.cloneDestination()).to.equal('project');
        });

        it('falls back to the repository basename when no dest is given', async function() {
            const { calls, bakelet } = await runThroughTransport(
                { git: 'https://github.com/example/repo.git' });
            expect(calls[0]).to.contain('"repo"');
            expect(bakelet.cloneDestination()).to.equal('repo');
        });
    });

    it('still refuses an entry with no repository URL', async function() {
        const bakelet = new Git('env', null, '');
        bakelet.setLocalLocation(tmp);
        await bakelet.load({ git: '' }, []);

        let threw = null;
        try {
            await bakelet.install();
        } catch (err) {
            threw = err;
        }
        expect(threw).to.be.an('error');
    });
});

// extract: — inject a repository's CONTENT into a folder, with no clone and no
// .git. The network edges (resolveRef, downloadToFile) are stubbed; a live
// fetch belongs in the smoke, not in a unit test that must stay green offline.
// Added by Claude Code (claude-opus-5[1m])
describe('resources: git — extract:', function() {

    let tmp, origResolveRef, origDownload;

    // Builds a real .tar.gz shaped like GitHub's: everything inside one
    // <repo>-<sha>/ wrapper directory, which --strip-components=1 removes.
    function makeArchive(dir, files) {
        const stage = path.join(dir, 'baker-test-abc1234');
        for (const [rel, body] of Object.entries(files)) {
            fs.ensureDirSync(path.dirname(path.join(stage, rel)));
            fs.writeFileSync(path.join(stage, rel), body);
        }
        const tarball = path.join(dir, 'archive.tar.gz');
        child_process.execFileSync('tar',
            ['-czf', tarball, '-C', dir, path.basename(stage)], { stdio: 'pipe' });
        fs.removeSync(stage);
        return tarball;
    }

    beforeEach(function() {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'baker-extract-test-'));
        origResolveRef = GitUtil.resolveRef;
        origDownload = GitUtil.downloadToFile;
    });

    afterEach(function() {
        GitUtil.resolveRef = origResolveRef;
        GitUtil.downloadToFile = origDownload;
        fs.removeSync(tmp);
    });

    function stubFetch(files, seen = {}) {
        GitUtil.resolveRef = async (url, ref) => {
            seen.url = url; seen.ref = ref;
            return { sha: 'abc1234def5678', ref: ref || 'main' };
        };
        GitUtil.downloadToFile = async (uri, dest) => {
            seen.uri = uri;
            const src = makeArchive(fs.mkdtempSync(path.join(os.tmpdir(), 'baker-arch-')), files);
            fs.copySync(src, dest);
            return dest;
        };
    }

    async function runExtract(entry, cwd) {
        const bakelet = new Git('env', null, '');
        bakelet.setLocalLocation(cwd);
        await bakelet.load(entry, []);
        await bakelet.install();
        return bakelet;
    }

    it('places the repository contents directly in dest, with no wrapper directory', async function() {
        stubFetch({ 'README.md': 'hello\n', 'prompts/build.txt': 'build\n' });
        const project = path.join(tmp, 'project');
        fs.ensureDirSync(project);

        await runExtract({ git: { repo: 'https://github.com/o/baker-test', dest: '.claude', extract: true } }, project);

        expect(fs.readFileSync(path.join(project, '.claude/README.md'), 'utf8')).to.equal('hello\n');
        expect(fs.readFileSync(path.join(project, '.claude/prompts/build.txt'), 'utf8')).to.equal('build\n');
    });

    it('leaves no .git behind — that is the whole point of extract over clone', async function() {
        stubFetch({ 'README.md': 'hello\n' });
        const project = path.join(tmp, 'project');
        fs.ensureDirSync(project);

        await runExtract({ git: { repo: 'https://github.com/o/baker-test', dest: '.claude', extract: true } }, project);

        expect(fs.existsSync(path.join(project, '.claude/.git'))).to.equal(false);
    });

    it('overlays onto a folder someone already owns without disturbing their files', async function() {
        stubFetch({ 'README.md': 'theirs\n' });
        const project = path.join(tmp, 'project');
        fs.ensureDirSync(path.join(project, '.claude'));
        fs.writeFileSync(path.join(project, '.claude/mine.txt'), 'mine\n');

        await runExtract({ git: { repo: 'https://github.com/o/baker-test', dest: '.claude', extract: true } }, project);

        expect(fs.readFileSync(path.join(project, '.claude/mine.txt'), 'utf8')).to.equal('mine\n');
        expect(fs.readFileSync(path.join(project, '.claude/README.md'), 'utf8')).to.equal('theirs\n');
    });

    // The clone path skips when the destination exists. Injection must not:
    // updating a per-unit configuration IS the use case.
    it('re-runs and updates rather than skipping an existing destination', async function() {
        const project = path.join(tmp, 'project');
        fs.ensureDirSync(project);
        const entry = { git: { repo: 'https://github.com/o/baker-test', dest: '.claude', extract: true } };

        stubFetch({ 'unit.txt': 'unit-1\n' });
        await runExtract(entry, project);
        expect(fs.readFileSync(path.join(project, '.claude/unit.txt'), 'utf8')).to.equal('unit-1\n');

        stubFetch({ 'unit.txt': 'unit-2\n' });
        await runExtract(entry, project);
        expect(fs.readFileSync(path.join(project, '.claude/unit.txt'), 'utf8')).to.equal('unit-2\n');
    });

    it('passes ref: through and fetches the archive at the resolved sha', async function() {
        const seen = {};
        stubFetch({ 'README.md': 'x\n' }, seen);
        const project = path.join(tmp, 'project');
        fs.ensureDirSync(project);

        await runExtract({ git: {
            repo: 'https://github.com/o/baker-test', dest: 'c', extract: true, ref: 'unit-1'
        } }, project);

        expect(seen.ref).to.equal('unit-1');
        // Pinned to the sha, never to the branch name: two students baking the
        // same day must get identical bytes.
        expect(seen.uri).to.equal('https://codeload.github.com/o/baker-test/tar.gz/abc1234def5678');
    });

    it('refuses a host whose archive layout it does not know, before any network call', async function() {
        let called = false;
        GitUtil.resolveRef = async () => { called = true; return { sha: 'x', ref: 'main' }; };
        const project = path.join(tmp, 'project');
        fs.ensureDirSync(project);

        let err;
        try {
            await runExtract({ git: { repo: 'https://gitlab.com/g/proj', dest: 'c', extract: true } }, project);
        } catch (e) { err = e; }

        expect(err).to.be.an('error');
        expect(err.message).to.contain('github.com');
        expect(err.message).to.contain('drop extract:');
        expect(called).to.equal(false);
    });

    it('refuses docker and remote by name rather than half-supporting them', async function() {
        stubFetch({ 'README.md': 'x\n' });
        const bakelet = new Git('env', null, '');   // no localLocation
        await bakelet.load({ git: { repo: 'https://github.com/o/r', dest: 'c', extract: true } }, []);

        let err;
        try { await bakelet.install(); } catch (e) { err = e; }

        expect(err).to.be.an('error');
        expect(err.message).to.contain('local:');
    });

    // Cleanup removes exactly what install() recorded — the manifest is what
    // makes that safe in a folder the person owns.
    describe('cleanup', function() {

        async function inject(project, files, entry) {
            stubFetch(files);
            return runExtract(entry || {
                git: { repo: 'https://github.com/o/baker-test', dest: '.claude', extract: true }
            }, project);
        }

        it('removes the files it injected, and its own manifest with them', async function() {
            const project = path.join(tmp, 'project');
            fs.ensureDirSync(project);
            const bakelet = await inject(project, { 'README.md': 'x\n', 'p/build.txt': 'y\n' });

            const plan = await bakelet.plan();
            const op = plan.find((o) => o.kind === 'paths');
            expect(op).to.be.an('object');
            expect(op.default).to.equal(true);

            await bakelet.uninstall(op);

            expect(fs.existsSync(path.join(project, '.claude/README.md'))).to.equal(false);
            expect(fs.existsSync(path.join(project, '.claude/p/build.txt'))).to.equal(false);
            expect(fs.existsSync(path.join(project, '.claude/.baker-extract.json'))).to.equal(false);
            // Nothing of the person's was in there, so the folder goes too.
            expect(fs.existsSync(path.join(project, '.claude'))).to.equal(false);
        });

        it('never touches a file the person put in that folder themselves', async function() {
            const project = path.join(tmp, 'project');
            fs.ensureDirSync(path.join(project, '.claude'));
            fs.writeFileSync(path.join(project, '.claude/mine.txt'), 'mine\n');
            const bakelet = await inject(project, { 'README.md': 'x\n' });

            const plan = await bakelet.plan();
            await bakelet.uninstall(plan.find((o) => o.kind === 'paths'));

            expect(fs.readFileSync(path.join(project, '.claude/mine.txt'), 'utf8')).to.equal('mine\n');
            // Their file is still in it, so the directory survives.
            expect(fs.existsSync(path.join(project, '.claude'))).to.equal(true);
        });

        // The hash is the whole guard: an injected file someone has since edited
        // is their work now, and is kept and reported rather than deleted.
        it('keeps an injected file that has been edited, and says how many', async function() {
            const project = path.join(tmp, 'project');
            fs.ensureDirSync(project);
            const bakelet = await inject(project, { 'README.md': 'x\n', 'notes.md': 'y\n' });
            fs.writeFileSync(path.join(project, '.claude/notes.md'), 'MY EDITS\n');

            const plan = await bakelet.plan();
            const refused = plan.find((o) => o.kind === 'refused');
            expect(refused).to.be.an('object');
            expect(refused.reason).to.contain('1 injected file(s) have been edited');

            await bakelet.uninstall(plan.find((o) => o.kind === 'paths'));

            expect(fs.readFileSync(path.join(project, '.claude/notes.md'), 'utf8')).to.equal('MY EDITS\n');
            expect(fs.existsSync(path.join(project, '.claude/README.md'))).to.equal(false);
        });

        it('reports nothing to do when no manifest was ever written', async function() {
            const project = path.join(tmp, 'project');
            fs.ensureDirSync(project);
            const bakelet = new Git('env', null, '');
            bakelet.setLocalLocation(project);
            await bakelet.load({ git: { repo: 'https://github.com/o/r', dest: '.claude', extract: true } }, []);

            const plan = await bakelet.plan();

            expect(plan).to.have.lengthOf(1);
            expect(plan[0].kind).to.equal('none');
            expect(plan[0].reason).to.contain('no injection manifest');
        });

        it('is idempotent — a second cleanup reports nothing rather than re-removing', async function() {
            const project = path.join(tmp, 'project');
            fs.ensureDirSync(project);
            const bakelet = await inject(project, { 'README.md': 'x\n' });

            await bakelet.uninstall((await bakelet.plan()).find((o) => o.kind === 'paths'));
            const second = await bakelet.plan();

            expect(second).to.have.lengthOf(1);
            expect(second[0].kind).to.equal('none');
        });

        it('records the commit it injected, so the manifest says what to restore', async function() {
            const project = path.join(tmp, 'project');
            fs.ensureDirSync(project);
            await inject(project, { 'README.md': 'x\n' });

            const manifest = JSON.parse(
                fs.readFileSync(path.join(project, '.claude/.baker-extract.json'), 'utf8'));

            expect(manifest.commit).to.equal('abc1234def5678');
            expect(manifest.repo).to.equal('https://github.com/o/baker-test');
            expect(manifest.entries.map((e) => e.path)).to.deep.equal(['.claude/README.md']);
        });
    });

    it('leaves the clone path untouched when extract: is absent', async function() {
        const bakelet = new Git('env', null, '');
        await bakelet.load({ git: { repo: 'https://github.com/o/r', dest: 'c' } }, []);
        expect(bakelet.extract).to.equal(false);
    });
});

// ref: and the "<url>@<ref>:<dest>" string form — cloning at a branch or tag.
// Added by Claude Code (claude-opus-5[1m])
describe('resources: git — ref:', function() {

    let tmp;

    beforeEach(function() {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'baker-ref-'));
    });

    afterEach(function() {
        fs.removeSync(tmp);
    });

    describe('Git.splitRef (pure)', function() {
        it('finds no ref when none is given', function() {
            expect(Git.splitRef('https://github.com/o/r').ref).to.equal(undefined);
        });

        it('splits a ref off the end of an https URL', function() {
            expect(Git.splitRef('https://github.com/o/r@unit-1'))
                .to.deep.equal({ repo: 'https://github.com/o/r', ref: 'unit-1' });
        });

        // A "last @ after the last /" rule would break on this one.
        it('keeps a ref that contains a slash', function() {
            expect(Git.splitRef('https://github.com/o/r@release/1.2'))
                .to.deep.equal({ repo: 'https://github.com/o/r', ref: 'release/1.2' });
        });

        // The @ in user:pass@host is part of the URL, not a ref marker. The
        // private: path builds exactly this shape.
        it('does not mistake credentials in the host for a ref', function() {
            expect(Git.splitRef('https://user:pass@github.com/o/r').ref).to.equal(undefined);
        });

        it('still finds a real ref on a URL that carries credentials', function() {
            expect(Git.splitRef('https://user:pass@github.com/o/r@unit-1'))
                .to.deep.equal({ repo: 'https://user:pass@github.com/o/r', ref: 'unit-1' });
        });

        it('does not mistake the user in an scp-style remote for a ref', function() {
            expect(Git.splitRef('git@github.com:o/r.git').ref).to.equal(undefined);
        });

        it('splits a ref off an scp-style remote', function() {
            expect(Git.splitRef('git@github.com:o/r.git@unit-1'))
                .to.deep.equal({ repo: 'git@github.com:o/r.git', ref: 'unit-1' });
        });
    });

    describe('string form', function() {
        it('parses "<url>@<ref>:<dest>" into all three parts', async function() {
            const bakelet = new Git('env', null, '');
            await bakelet.load({ git: 'https://github.com/o/r@unit-1:./work' }, []);

            expect(bakelet.repo).to.equal('https://github.com/o/r');
            expect(bakelet.ref).to.equal('unit-1');
            expect(bakelet.dest).to.equal('./work');
        });

        it('still parses a plain "<url>:<dest>" with no ref', async function() {
            const bakelet = new Git('env', null, '');
            await bakelet.load({ git: 'https://github.com/o/r:./work' }, []);

            expect(bakelet.repo).to.equal('https://github.com/o/r');
            expect(bakelet.ref).to.equal(undefined);
            expect(bakelet.dest).to.equal('./work');
        });
    });

    describe('clone honours the ref', function() {
        it('passes --branch to a local clone', async function() {
            await withRecordedExec(async (calls) => {
                await runInstall({ git: 'https://github.com/o/r@unit-1:work' }, tmp);
                expect(calls[0]).to.contain('--branch "unit-1"');
                expect(calls[0]).to.contain('https://github.com/o/r');
            });
        });

        it('omits --branch entirely when no ref is given', async function() {
            await withRecordedExec(async (calls) => {
                await runInstall({ git: 'https://github.com/o/r:work' }, tmp);
                expect(calls[0]).to.not.contain('--branch');
            });
        });

        it('takes ref: from the object form too', async function() {
            await withRecordedExec(async (calls) => {
                await runInstall(
                    { git: { repo: 'https://github.com/o/r', dest: 'work', ref: 'unit-2' } }, tmp);
                expect(calls[0]).to.contain('--branch "unit-2"');
            });
        });

        it('puts --branch in the docker and remote command too', function() {
            expect(Git.cloneCommand('https://github.com/o/r', 'work', 'unit-1'))
                .to.contain('--branch "unit-1"');
        });

        // Same invariant the clone command has always had: docker-local wraps
        // commands as `bash -c '<cmd>'`, so a single quote would break it.
        it('adds no single quote to the guarded command', function() {
            expect(Git.cloneCommand('https://github.com/o/r', 'work', 'unit-1'))
                .to.not.contain("'");
        });
    });

    it('names the ref in the cleanup restore hint, since a plain clone would not restore it', async function() {
        const project = path.join(tmp, 'p');
        const dest = path.join(project, 'work');
        fs.ensureDirSync(path.join(dest, '.git'));

        const bakelet = new Git('env', null, '');
        bakelet.setLocalLocation(project);
        await bakelet.load({ git: 'https://github.com/o/r@unit-1:work' }, []);

        // A real dirty-check needs a real repo; stub it to reach the restore hint.
        bakelet.execCapture = async () => '';

        const plan = await bakelet.plan();

        expect(plan[0].restore).to.contain('--branch unit-1');
    });
});
