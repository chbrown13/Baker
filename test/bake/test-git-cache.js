const fs   = require('fs');
const os   = require('os');
const path = require('path');
const chai = require('chai');
const expect = chai.expect;

const Git = require('../../lib/modules/utils/git');

// Git.cacheRoot() reads os.homedir() on every call, which on POSIX prefers $HOME.
// Pointing HOME at a temp dir keeps every test in this file off the real ~/.baker.
function withTempHome() {
    let tmpHome, origHome;
    beforeEach(function() {
        origHome = process.env.HOME;
        tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'baker-home-'));
        process.env.HOME = tmpHome;
    });
    afterEach(function() {
        if (origHome === undefined) delete process.env.HOME;
        else process.env.HOME = origHome;
        fs.rmSync(tmpHome, { recursive: true, force: true });
    });
    return () => tmpHome;
}

// Builds a real local git repo with one commit, usable as a clone source over a
// file:// URL. Real git rather than a stub, because cloneOrUpdate's whole job is
// getting the git invocations right.
function makeOriginRepo(root, name, fileName, contents) {
    const { execFileSync } = require('child_process');
    const repo = path.join(root, name);
    fs.mkdirSync(repo, { recursive: true });
    const run = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    run('init', '--quiet', '--initial-branch', 'main');
    run('config', 'user.email', 'test@example.com');
    run('config', 'user.name', 'Baker Test');
    fs.writeFileSync(path.join(repo, fileName), contents);
    run('add', '-A');
    run('commit', '--quiet', '-m', 'initial');
    return repo;
}

describe('Git cache addressing', function() {

    describe('Git.cacheDir (pure)', function() {
        const home = withTempHome();

        it('maps an https clone URL to <cache>/<host>/<owner>/<repo>', function() {
            expect(Git.cacheDir('https://github.com/ottomatica/baker-test.git'))
                .to.equal(path.join(home(), '.baker', 'cache', 'github.com', 'ottomatica', 'baker-test'));
        });

        it('strips the .git suffix from the final segment', function() {
            expect(Git.cacheDir('https://github.com/o/r.git'))
                .to.equal(Git.cacheDir('https://github.com/o/r'));
        });

        it('maps an scp-style remote to the same shape as its https form', function() {
            expect(Git.cacheDir('git@github.com:ottomatica/baker-test.git'))
                .to.equal(Git.cacheDir('https://github.com/ottomatica/baker-test.git'));
        });

        it('preserves nested GitLab group paths', function() {
            expect(Git.cacheDir('https://gitlab.com/grp/sub/proj.git'))
                .to.equal(path.join(home(), '.baker', 'cache', 'gitlab.com', 'grp', 'sub', 'proj'));
        });

        it('keys on the host so same-named repos on different hosts do not collide', function() {
            expect(Git.cacheDir('https://github.com/acme/tools.git'))
                .to.not.equal(Git.cacheDir('https://gitlab.com/acme/tools.git'));
        });

        it('never escapes the cache root, even for a traversing path', function() {
            const dir = Git.cacheDir('https://evil.example/../../../../etc/passwd');
            const root = path.join(home(), '.baker', 'cache');
            expect(dir.startsWith(root + path.sep)).to.equal(true);
            expect(dir).to.not.match(/\.\./);
        });

        it('replaces characters that are illegal in Windows path segments', function() {
            // A host with a port would otherwise put ':' into a path segment.
            expect(Git.cacheDir('https://git.example.com:8443/o/r.git'))
                .to.equal(path.join(home(), '.baker', 'cache', 'git.example.com_8443', 'o', 'r'));
        });

        it('falls back to a hashed directory for an unparseable remote', function() {
            const dir = Git.cacheDir('not a url at all');
            expect(dir.startsWith(path.join(home(), '.baker', 'cache', 'other'))).to.equal(true);
        });

        it('falls back to a hashed directory when the URL carries no path', function() {
            const dir = Git.cacheDir('https://github.com');
            expect(dir).to.equal(path.join(home(), '.baker', 'cache', 'github.com', Git.hashKey('https://github.com')));
        });

        it('is deterministic across calls', function() {
            expect(Git.cacheDir('https://github.com/o/r.git'))
                .to.equal(Git.cacheDir('https://github.com/o/r.git'));
        });
    });

    describe('Git.fetchCacheDir (pure)', function() {
        const home = withTempHome();

        it('maps a file URL to a hashed directory under <cache>/fetch', function() {
            const url = 'https://raw.githubusercontent.com/o/r/main/baker.yml';
            expect(Git.fetchCacheDir(url))
                .to.equal(path.join(home(), '.baker', 'cache', 'fetch', Git.hashKey(url)));
        });

        it('is stable for the same URL, so refetching reuses one directory', function() {
            const url = 'https://example.com/baker.yml';
            expect(Git.fetchCacheDir(url)).to.equal(Git.fetchCacheDir(url));
        });

        it('differs for different URLs', function() {
            expect(Git.fetchCacheDir('https://example.com/a.yml'))
                .to.not.equal(Git.fetchCacheDir('https://example.com/b.yml'));
        });
    });

    describe('Git.cloneOrUpdate', function() {
        const home = withTempHome();
        let work;

        beforeEach(function() {
            work = fs.mkdtempSync(path.join(os.tmpdir(), 'baker-git-'));
        });

        afterEach(function() {
            fs.rmSync(work, { recursive: true, force: true });
        });

        it('clones into a destination that does not exist yet', async function() {
            const origin = makeOriginRepo(work, 'origin', 'baker.yml', 'name: one\n');
            const dest = path.join(work, 'cache', 'nested', 'repo');

            await Git.cloneOrUpdate(`file://${origin}`, dest);

            expect(fs.existsSync(path.join(dest, '.git'))).to.equal(true);
            expect(fs.readFileSync(path.join(dest, 'baker.yml'), 'utf8')).to.equal('name: one\n');
        });

        it('updates an existing clone instead of failing (AC-5: re-runnable)', async function() {
            const origin = makeOriginRepo(work, 'origin', 'baker.yml', 'name: one\n');
            const dest = path.join(work, 'cache', 'repo');

            await Git.cloneOrUpdate(`file://${origin}`, dest);

            // Advance origin, then run the same command again.
            const { execFileSync } = require('child_process');
            fs.writeFileSync(path.join(origin, 'baker.yml'), 'name: two\n');
            execFileSync('git', ['add', '-A'], { cwd: origin, stdio: 'pipe' });
            execFileSync('git', ['commit', '--quiet', '-m', 'second'], { cwd: origin, stdio: 'pipe' });

            const second = await Git.cloneOrUpdate(`file://${origin}`, dest);

            expect(second).to.equal(dest);
            expect(fs.readFileSync(path.join(dest, 'baker.yml'), 'utf8')).to.equal('name: two\n');
        });

        it('discards local modifications in the cache rather than conflicting (AC-6)', async function() {
            const origin = makeOriginRepo(work, 'origin', 'baker.yml', 'name: one\n');
            const dest = path.join(work, 'cache', 'repo');

            await Git.cloneOrUpdate(`file://${origin}`, dest);
            fs.writeFileSync(path.join(dest, 'baker.yml'), 'name: LOCALLY EDITED\n');

            await Git.cloneOrUpdate(`file://${origin}`, dest);

            expect(fs.readFileSync(path.join(dest, 'baker.yml'), 'utf8')).to.equal('name: one\n');
        });

        it('throws naming the path when the destination exists but is not a repo (AC-6)', async function() {
            const origin = makeOriginRepo(work, 'origin', 'baker.yml', 'name: one\n');
            const dest = path.join(work, 'cache', 'occupied');
            fs.mkdirSync(dest, { recursive: true });
            fs.writeFileSync(path.join(dest, 'something.txt'), 'not a clone');

            let err;
            try { await Git.cloneOrUpdate(`file://${origin}`, dest); } catch (e) { err = e; }

            expect(err).to.be.an('error');
            expect(err.message).to.contain(dest);
            expect(err.message).to.match(/not a Baker cache clone/);
            expect(fs.readFileSync(path.join(dest, 'something.txt'), 'utf8')).to.equal('not a clone');
        });

        it('checks out the requested ref when one is given', async function() {
            const origin = makeOriginRepo(work, 'origin', 'baker.yml', 'name: main\n');
            const { execFileSync } = require('child_process');
            execFileSync('git', ['checkout', '--quiet', '-b', 'other'], { cwd: origin, stdio: 'pipe' });
            fs.writeFileSync(path.join(origin, 'baker.yml'), 'name: other\n');
            execFileSync('git', ['add', '-A'], { cwd: origin, stdio: 'pipe' });
            execFileSync('git', ['commit', '--quiet', '-m', 'on other'], { cwd: origin, stdio: 'pipe' });
            execFileSync('git', ['checkout', '--quiet', 'main'], { cwd: origin, stdio: 'pipe' });

            const dest = path.join(work, 'cache', 'repo');
            await Git.cloneOrUpdate(`file://${origin}`, dest, 'other');

            expect(fs.readFileSync(path.join(dest, 'baker.yml'), 'utf8')).to.equal('name: other\n');
        });

        it('updates a clone whose HEAD is detached at a tag', async function() {
            // A --branch clone of a TAG leaves HEAD detached, so `@{u}` does not
            // exist and rev-parse fails. The update path has to fall back to
            // discarding local changes against HEAD rather than propagating that
            // failure — a re-bake of a tag-pinned config depends on it.
            const origin = makeOriginRepo(work, 'origin', 'baker.yml', 'name: tagged\n');
            const { execFileSync } = require('child_process');
            execFileSync('git', ['tag', 'v1'], { cwd: origin, stdio: 'pipe' });

            const dest = path.join(work, 'cache', 'repo');
            await Git.cloneOrUpdate(`file://${origin}`, dest, 'v1');
            // Second call takes the update branch against the detached clone.
            await Git.cloneOrUpdate(`file://${origin}`, dest, 'v1');

            expect(fs.readFileSync(path.join(dest, 'baker.yml'), 'utf8')).to.equal('name: tagged\n');
        });

        it('rejects when the clone itself fails', async function() {
            const dest = path.join(work, 'cache', 'nope');
            let err;
            try {
                await Git.cloneOrUpdate(`file://${path.join(work, 'does-not-exist')}`, dest);
            } catch (e) { err = e; }
            expect(err).to.be.an('error');
        });
    });

    describe('Git.clone (cache destination)', function() {
        const home = withTempHome();
        let work, origCwd, cwdSandbox;

        beforeEach(function() {
            work = fs.mkdtempSync(path.join(os.tmpdir(), 'baker-git-'));
            cwdSandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'baker-cwd-'));
            origCwd = process.cwd();
            process.chdir(cwdSandbox);
        });

        afterEach(function() {
            process.chdir(origCwd);
            fs.rmSync(work, { recursive: true, force: true });
            fs.rmSync(cwdSandbox, { recursive: true, force: true });
        });

        it('clones into the cache and writes nothing to cwd (AC-4)', async function() {
            const origin = makeOriginRepo(work, 'origin', 'baker.yml', 'name: cached\n');

            const before = fs.readdirSync(cwdSandbox);
            const resolved = await Git.clone(`file://${origin}`);
            const after = fs.readdirSync(cwdSandbox);

            expect(after).to.deep.equal(before);
            expect(resolved).to.equal(Git.cacheDir(`file://${origin}`));
            expect(resolved.startsWith(path.join(home(), '.baker', 'cache'))).to.equal(true);
            expect(fs.readFileSync(path.join(resolved, 'baker.yml'), 'utf8')).to.equal('name: cached\n');
        });

        it('is re-runnable and resolves to the same path twice (AC-5)', async function() {
            const origin = makeOriginRepo(work, 'origin', 'baker.yml', 'name: cached\n');

            const first = await Git.clone(`file://${origin}`);
            const second = await Git.clone(`file://${origin}`);

            expect(second).to.equal(first);
            expect(fs.readdirSync(cwdSandbox)).to.deep.equal([]);
        });
    });
});

// The visible checkout: where a cloned repo lands and, more importantly, what
// happens to it on a re-bake. The cache may be force-updated; this must not be.
// Added by Claude Code (claude-opus-5[1m])
describe('Git working copy', function() {

    describe('Git.repoName (pure)', function() {
        it('takes the last segment of an https URL, minus .git', function() {
            expect(Git.repoName('https://github.com/ottomatica/baker-test.git')).to.equal('baker-test');
        });

        it('works without the .git suffix', function() {
            expect(Git.repoName('https://github.com/ottomatica/baker-test')).to.equal('baker-test');
        });

        it('does not mistake the scp-style colon for a path separator', function() {
            expect(Git.repoName('git@github.com:ottomatica/baker-test.git')).to.equal('baker-test');
        });

        it('takes the final segment of a nested GitLab group path', function() {
            expect(Git.repoName('https://gitlab.com/group/sub/proj.git')).to.equal('proj');
        });

        it('handles a file:// URL, which is what the tests clone from', function() {
            expect(Git.repoName('file:///tmp/whatever/origin')).to.equal('origin');
        });

        it('returns null rather than a guess for an unusable remote', function() {
            expect(Git.repoName('')).to.equal(null);
        });
    });

    describe('Git.pullIfClean', function() {
        let work, origin, checkout;

        const runIn = (dir, ...args) =>
            require('child_process').execFileSync('git', args, { cwd: dir, stdio: 'pipe' });

        beforeEach(function() {
            work = fs.mkdtempSync(path.join(os.tmpdir(), 'baker-wc-'));
            origin = makeOriginRepo(work, 'origin', 'baker.yml', 'name: one\n');
            checkout = path.join(work, 'checkout');
            runIn(work, 'clone', '--quiet', `file://${origin}`, checkout);
            runIn(checkout, 'config', 'user.email', 'test@example.com');
            runIn(checkout, 'config', 'user.name', 'Baker Test');
        });

        afterEach(function() {
            fs.rmSync(work, { recursive: true, force: true });
        });

        // Regression: simple-git 1.x resolves to null, not '', when a command
        // prints nothing — and String(null) is "null", which is truthy. Reading
        // `git status --porcelain` without guarding that made every clean
        // checkout report as dirty, so Baker silently stopped updating anything
        // and told people they had changes they did not have.
        it('sees a clean checkout as clean, and fast-forwards it', async function() {
            fs.writeFileSync(path.join(origin, 'NEW.md'), 'upstream\n');
            runIn(origin, 'add', '-A');
            runIn(origin, 'commit', '--quiet', '-m', 'second');

            const result = await Git.pullIfClean(checkout);

            expect(result.kind).to.equal('updated');
            expect(fs.existsSync(path.join(checkout, 'NEW.md'))).to.equal(true);
        });

        it('leaves a dirty checkout alone rather than forcing over it', async function() {
            fs.writeFileSync(path.join(origin, 'baker.yml'), 'name: two\n');
            runIn(origin, 'commit', '--quiet', '-am', 'second');
            fs.writeFileSync(path.join(checkout, 'baker.yml'), 'name: MY HOMEWORK\n');

            const result = await Git.pullIfClean(checkout);

            expect(result.kind).to.equal('dirty');
            expect(fs.readFileSync(path.join(checkout, 'baker.yml'), 'utf8')).to.equal('name: MY HOMEWORK\n');
        });

        it('counts an untracked file as dirty, since a pull could clobber it', async function() {
            fs.writeFileSync(path.join(checkout, 'notes.txt'), 'mine\n');
            expect((await Git.pullIfClean(checkout)).kind).to.equal('dirty');
        });

        it('refuses to force when the checkout has diverged', async function() {
            fs.writeFileSync(path.join(origin, 'baker.yml'), 'name: theirs\n');
            runIn(origin, 'commit', '--quiet', '-am', 'theirs');

            fs.writeFileSync(path.join(checkout, 'baker.yml'), 'name: mine\n');
            runIn(checkout, 'commit', '--quiet', '-am', 'mine');

            const result = await Git.pullIfClean(checkout);

            expect(result.kind).to.equal('diverged');
            expect(fs.readFileSync(path.join(checkout, 'baker.yml'), 'utf8')).to.equal('name: mine\n');
        });

        it('reports a detached checkout rather than pulling it', async function() {
            const sha = String(runIn(checkout, 'rev-parse', 'HEAD')).trim();
            runIn(checkout, 'checkout', '--quiet', sha);

            expect((await Git.pullIfClean(checkout)).kind).to.equal('detached');
        });
    });

    describe('Git.workingCopy', function() {
        const home = withTempHome();
        let work;

        beforeEach(function() {
            work = fs.mkdtempSync(path.join(os.tmpdir(), 'baker-wc2-'));
        });

        afterEach(function() {
            fs.rmSync(work, { recursive: true, force: true });
        });

        it('copies the cache into a destination that does not exist yet', async function() {
            const origin = makeOriginRepo(work, 'origin', 'baker.yml', 'name: cached\n');
            const url = `file://${origin}`;
            const cacheDir = await Git.clone(url);
            const dest = path.join(work, 'checkout');

            const result = await Git.workingCopy(cacheDir, url, dest);

            expect(result.kind).to.equal('cloned');
            expect(fs.readFileSync(path.join(dest, 'baker.yml'), 'utf8')).to.equal('name: cached\n');
            // A real repository, not a bare copy of the files: origin points at
            // the true remote, so the next re-bake can fast-forward it.
            expect(fs.existsSync(path.join(dest, '.git'))).to.equal(true);
            expect((await Git.pullIfClean(dest)).kind).to.equal('updated');
            expect(home()).to.be.a('string');
        });

        it('refuses when the destination exists but is not a repository', async function() {
            const origin = makeOriginRepo(work, 'origin', 'baker.yml', 'name: cached\n');
            const url = `file://${origin}`;
            const cacheDir = await Git.clone(url);
            const dest = path.join(work, 'occupied');
            fs.mkdirSync(dest);
            fs.writeFileSync(path.join(dest, 'homework.txt'), 'mine\n');

            let err;
            try { await Git.workingCopy(cacheDir, url, dest); } catch (e) { err = e; }

            expect(err).to.be.an('error');
            expect(err.message).to.contain(dest);
            expect(fs.readFileSync(path.join(dest, 'homework.txt'), 'utf8')).to.equal('mine\n');
        });
    });
});

// `baker check` resolves a profile address to a commit sha before fetching it, so
// that a sha-pinned raw URL cannot serve a stale profile. These cover the two
// pieces that live on Git; the fetch-and-cache half is in test-check-command.js.
// Added by Claude Code (claude-opus-5[1m])
describe('Git.parseLsRemote (pure)', function() {
    // Shape of real `git ls-remote --symref <url>` output, tab-separated.
    const SYMREF = [
        'ref: refs/heads/main\tHEAD',
        '1111111111111111111111111111111111111111\tHEAD',
        '1111111111111111111111111111111111111111\trefs/heads/main',
        '2222222222222222222222222222222222222222\trefs/heads/PM3',
        '3333333333333333333333333333333333333333\trefs/tags/v1',
        ''
    ].join('\n');

    it('reads the default branch from the symref line, not from a sha', function() {
        expect(Git.parseLsRemote(SYMREF).head).to.equal('refs/heads/main');
    });

    it('maps every ref name to its sha', function() {
        const { refs } = Git.parseLsRemote(SYMREF);
        expect(refs.get('HEAD')).to.equal('1111111111111111111111111111111111111111');
        expect(refs.get('refs/heads/PM3')).to.equal('2222222222222222222222222222222222222222');
        expect(refs.get('refs/tags/v1')).to.equal('3333333333333333333333333333333333333333');
    });

    it('keeps a peeled annotated tag as its own entry', function() {
        const { refs } = Git.parseLsRemote(
            '4444444444444444444444444444444444444444\trefs/tags/PM3\n' +
            '5555555555555555555555555555555555555555\trefs/tags/PM3^{}\n'
        );
        expect(refs.get('refs/tags/PM3')).to.equal('4444444444444444444444444444444444444444');
        expect(refs.get('refs/tags/PM3^{}')).to.equal('5555555555555555555555555555555555555555');
    });

    it('returns an empty map and no head for empty output', function() {
        const { refs, head } = Git.parseLsRemote('');
        expect(refs.size).to.equal(0);
        expect(head).to.equal(null);
    });

    it('ignores lines that are not a sha/ref pair', function() {
        const { refs } = Git.parseLsRemote('warning: redirecting to https://example.com/\nnot a ref line\n');
        expect(refs.size).to.equal(0);
    });

    it('ignores a short or non-hex object id', function() {
        const { refs } = Git.parseLsRemote('abc123\trefs/heads/main\nzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz\trefs/heads/x\n');
        expect(refs.size).to.equal(0);
    });

    it('parses CRLF output, which is what a Windows pipe delivers', function() {
        // The regression this guards: a trailing \r stops `$` from matching, so
        // every ref parsed away and a healthy repo reported as empty — on
        // Windows only, where the cross-platform matrix runs.
        const { refs, head } = Git.parseLsRemote(SYMREF.replace(/\n/g, '\r\n'));
        expect(head).to.equal('refs/heads/main');
        expect(refs.get('refs/heads/PM3')).to.equal('2222222222222222222222222222222222222222');
    });

    it('accepts a non-string argument without throwing', function() {
        expect(Git.parseLsRemote(undefined).refs.size).to.equal(0);
        expect(Git.parseLsRemote(null).head).to.equal(null);
    });

    it('touches neither the network nor the filesystem', function() {
        // Guard against the parser growing an fs/https dependency later: it is
        // called here with HOME pointed nowhere and must still work.
        const origHome = process.env.HOME;
        process.env.HOME = path.join(os.tmpdir(), 'baker-does-not-exist');
        try {
            expect(Git.parseLsRemote(SYMREF).refs.size).to.equal(4);
        } finally {
            if (origHome === undefined) delete process.env.HOME;
            else process.env.HOME = origHome;
        }
    });
});

describe('Git.resolveRef', function() {
    // The injected `raw` is the same seam as platform.detect()'s exec argument:
    // the test passes a fake and mutates no shared object, so it cannot leak into
    // another suite the way a global replacement would.
    function fakeRaw(output, calls) {
        return async function(cwd, args, env) {
            if (calls) calls.push({ cwd, args, env });
            return output;
        };
    }

    const LINES = [
        'ref: refs/heads/main\tHEAD',
        '1111111111111111111111111111111111111111\tHEAD',
        '1111111111111111111111111111111111111111\trefs/heads/main',
        '2222222222222222222222222222222222222222\trefs/heads/PM3',
        '3333333333333333333333333333333333333333\trefs/tags/lightweight',
        '4444444444444444444444444444444444444444\trefs/tags/annotated',
        '5555555555555555555555555555555555555555\trefs/tags/annotated^{}',
        ''
    ].join('\n');

    it('resolves HEAD and reports the real default branch when no ref is given', async function() {
        const r = await Git.resolveRef('https://github.com/o/r.git', null, fakeRaw(LINES));
        expect(r.sha).to.equal('1111111111111111111111111111111111111111');
        expect(r.ref).to.equal('main');
    });

    it('never assumes master — a main-only repo resolves and master appears nowhere', async function() {
        const calls = [];
        const mainOnly = [
            'ref: refs/heads/main\tHEAD',
            '1111111111111111111111111111111111111111\tHEAD',
            '1111111111111111111111111111111111111111\trefs/heads/main',
            ''
        ].join('\n');
        const r = await Git.resolveRef('https://github.com/o/r.git', undefined, fakeRaw(mainOnly, calls));
        expect(r.ref).to.equal('main');
        expect(JSON.stringify(calls)).to.not.contain('master');
    });

    it('resolves a branch ref to refs/heads/<ref>', async function() {
        const r = await Git.resolveRef('https://github.com/o/r.git', 'PM3', fakeRaw(LINES));
        expect(r).to.deep.equal({ sha: '2222222222222222222222222222222222222222', ref: 'PM3' });
    });

    it('resolves a lightweight tag', async function() {
        const r = await Git.resolveRef('https://github.com/o/r.git', 'lightweight', fakeRaw(LINES));
        expect(r.sha).to.equal('3333333333333333333333333333333333333333');
    });

    it('prefers the peeled sha for an annotated tag, not the tag object', async function() {
        // The bare refs/tags/annotated entry is the tag object's sha, which
        // raw.githubusercontent cannot serve — preferring it would 404.
        const r = await Git.resolveRef('https://github.com/o/r.git', 'annotated', fakeRaw(LINES));
        expect(r.sha).to.equal('5555555555555555555555555555555555555555');
    });

    it('accepts a literal 40-hex sha that is not an advertised ref', async function() {
        const sha = '6666666666666666666666666666666666666666';
        const r = await Git.resolveRef('https://github.com/o/r.git', sha, fakeRaw(LINES));
        expect(r).to.deep.equal({ sha, ref: sha });
    });

    it('prefers a branch over a literal-looking sha when both could match', async function() {
        // A 40-hex branch name is legal. The advertised ref wins over the
        // "it looks like a sha" fallback, which is only reached when nothing
        // in the repository matches.
        const hex = 'a'.repeat(40);
        const out = `7777777777777777777777777777777777777777\trefs/heads/${hex}\n`;
        const r = await Git.resolveRef('https://github.com/o/r.git', hex, fakeRaw(out));
        expect(r.sha).to.equal('7777777777777777777777777777777777777777');
    });

    it('names the ref and the repository when the ref does not exist', async function() {
        let err;
        try {
            await Git.resolveRef('https://github.com/o/r.git', 'PM9', fakeRaw(LINES));
        } catch (e) { err = e; }
        expect(err.message).to.contain('PM9');
        expect(err.message).to.contain('https://github.com/o/r.git');
    });

    it('reports an empty repository rather than failing later on a 404', async function() {
        let err;
        try {
            await Git.resolveRef('https://github.com/o/r.git', null, fakeRaw(''));
        } catch (e) { err = e; }
        expect(err.message).to.contain('empty repository');
        expect(err.message).to.contain('https://github.com/o/r.git');
    });

    it('falls back to HEAD as the ref name when no symref line is present', async function() {
        // `--symref` is unsupported by very old servers; the sha line still is.
        const r = await Git.resolveRef('https://github.com/o/r.git', null,
            fakeRaw('1111111111111111111111111111111111111111\tHEAD\n'));
        expect(r.ref).to.equal('HEAD');
    });

    it('passes GIT_TERMINAL_PROMPT=0 so a private repo fails instead of prompting', async function() {
        const calls = [];
        await Git.resolveRef('https://github.com/o/r.git', null, fakeRaw(LINES, calls));
        expect(calls[0].env).to.have.property('GIT_TERMINAL_PROMPT', '0');
    });

    it('runs ls-remote --symref against the clone url from a cwd that exists', async function() {
        const calls = [];
        await Git.resolveRef('https://github.com/o/r.git', null, fakeRaw(LINES, calls));
        expect(calls).to.have.lengthOf(1);
        expect(calls[0].args).to.deep.equal(['ls-remote', '--symref', 'https://github.com/o/r.git']);
        expect(fs.existsSync(calls[0].cwd)).to.equal(true);
    });

    it('propagates git\'s own error so a typo reads differently from a dead network', async function() {
        const failing = async () => { throw new Error('fatal: repository not found'); };
        let err;
        try {
            await Git.resolveRef('https://github.com/o/typo.git', null, failing);
        } catch (e) { err = e; }
        expect(err.message).to.contain('repository not found');
    });

    it('names the repository when the lookup itself fails', async function() {
        const failing = async () => { throw new Error('fatal: could not resolve host: github.com'); };
        let err;
        try {
            await Git.resolveRef('https://github.com/o/r.git', null, failing);
        } catch (e) { err = e; }
        expect(err.message).to.contain('https://github.com/o/r.git');
        expect(err.message).to.contain('could not resolve host');
    });

    it('says plainly that a repo could not be read, since git\'s prompt wording does not', async function() {
        // Raw git says "could not read Username for 'https://github.com':
        // terminal prompts disabled", which reads like a Baker bug rather than
        // a private or mistyped repository.
        const failing = async () => {
            throw new Error(`fatal: could not read Username for 'https://github.com': terminal prompts disabled`);
        };
        let msg = '';
        try {
            await Git.resolveRef('https://github.com/o/private.git', null, failing);
        } catch (e) { msg = e.message; }
        expect(msg).to.contain('Could not read https://github.com/o/private.git');
        expect(msg).to.contain('public');
    });
});

describe('Git.fetchUrl response handling', function() {
    // A response whose body is never read keeps its socket active and the process
    // never exits. Driven through the injected getter so no TLS server is needed.
    function fakeResponse(statusCode, extra = {}) {
        const res = new (require('events').EventEmitter)();
        res.statusCode = statusCode;
        res.headers = extra.headers || {};
        res.destroyed = false;
        res.destroy = function() { res.destroyed = true; };
        res.setEncoding = function() {};
        return res;
    }

    function fakeGet(responses, urls) {
        return function(uri, opts, cb) {
            if (urls) urls.push(uri);
            const res = responses.shift();
            process.nextTick(() => {
                cb(res);
                if (res.statusCode === 200) {
                    process.nextTick(() => { res.emit('data', 'ok'); res.emit('end'); });
                }
            });
            return new (require('events').EventEmitter)();
        };
    }

    it('destroys the response on a non-200 so the process can exit', async function() {
        // The regression this guards: `baker check owner/repo:typo.yml` rejected
        // in ~130ms and then hung the terminal forever on an unread 404 body.
        const res = fakeResponse(404);
        let err;
        try {
            await Git.fetchUrl('https://example.com/x.yml', {}, fakeGet([res]));
        } catch (e) { err = e; }
        expect(err.message).to.contain('HTTP 404');
        expect(res.destroyed, 'an unread body keeps the socket alive').to.equal(true);
    });

    it('destroys the response before following a redirect', async function() {
        const first = fakeResponse(302, { headers: { location: 'https://example.com/moved.yml' } });
        const second = fakeResponse(200);
        const urls = [];
        const body = await Git.fetchUrl('https://example.com/x.yml', {}, fakeGet([first, second], urls));
        expect(body).to.equal('ok');
        expect(first.destroyed).to.equal(true);
        expect(urls).to.deep.equal(['https://example.com/x.yml', 'https://example.com/moved.yml']);
    });

    it('carries the injected getter through a redirect', async function() {
        // Without this the redirect would fall back to the real https.get and a
        // test would quietly reach the network.
        const first = fakeResponse(301, { headers: { location: 'https://example.com/moved.yml' } });
        const second = fakeResponse(200);
        const urls = [];
        await Git.fetchUrl('https://example.com/x.yml', {}, fakeGet([first, second], urls));
        expect(urls).to.have.lengthOf(2);
    });

    it('returns the body on a 200', async function() {
        expect(await Git.fetchUrl('https://example.com/x.yml', {}, fakeGet([fakeResponse(200)])))
            .to.equal('ok');
    });

    it('rejects when the response errors mid-body', async function() {
        const res = fakeResponse(200);
        const get = function(uri, opts, cb) {
            process.nextTick(() => {
                cb(res);
                process.nextTick(() => res.emit('error', new Error('socket hang up')));
            });
            return new (require('events').EventEmitter)();
        };
        let err;
        try {
            await Git.fetchUrl('https://example.com/x.yml', {}, get);
        } catch (e) { err = e; }
        expect(err.message).to.equal('socket hang up');
    });

    it('rejects when the request itself errors', async function() {
        const get = function() {
            const req = new (require('events').EventEmitter)();
            process.nextTick(() => req.emit('error', new Error('getaddrinfo ENOTFOUND')));
            return req;
        };
        let err;
        try {
            await Git.fetchUrl('https://example.com/x.yml', {}, get);
        } catch (e) { err = e; }
        expect(err.message).to.contain('ENOTFOUND');
    });

    it('defaults to https.get when no getter is injected', function() {
        expect(Git.fetchUrl.length).to.equal(1); // uri; headers and get are defaulted
    });

    it('parses JSON through fetchJson', async function() {
        const res = fakeResponse(200);
        const get = function(uri, opts, cb) {
            process.nextTick(() => {
                cb(res);
                process.nextTick(() => { res.emit('data', '{"files":{}}'); res.emit('end'); });
            });
            return new (require('events').EventEmitter)();
        };
        expect(await Git.fetchJson('https://example.com/g', {}, get)).to.deep.equal({ files: {} });
    });

    it('names the url when a JSON response does not parse', async function() {
        const res = fakeResponse(200);
        const get = function(uri, opts, cb) {
            process.nextTick(() => {
                cb(res);
                process.nextTick(() => { res.emit('data', '<html>rate limited</html>'); res.emit('end'); });
            });
            return new (require('events').EventEmitter)();
        };
        let msg = '';
        try { await Git.fetchJson('https://api.github.com/gists/abc', {}, get); }
        catch (e) { msg = e.message; }
        expect(msg).to.contain('Failed to parse JSON from https://api.github.com/gists/abc');
    });
});

describe('Git.fetchBakerFile', function() {
    const home = withTempHome();

    function jsonGet(body) {
        return function(uri, opts, cb) {
            const res = new (require('events').EventEmitter)();
            res.statusCode = 200;
            res.headers = {};
            res.destroy = function() {};
            res.setEncoding = function() {};
            process.nextTick(() => {
                cb(res);
                process.nextTick(() => { res.emit('data', body); res.emit('end'); });
            });
            return new (require('events').EventEmitter)();
        };
    }

    it('writes a gist\'s baker.yml into the cache', async function() {
        const gist = JSON.stringify({ files: { 'baker.yml': { content: 'name: from-gist\n' } } });
        const dir = await Git.fetchBakerFile('https://gist.github.com/user/abc123', jsonGet(gist));
        expect(dir.startsWith(path.join(home(), '.baker', 'cache'))).to.equal(true);
        expect(fs.readFileSync(path.join(dir, 'baker.yml'), 'utf8')).to.equal('name: from-gist\n');
    });

    it('accepts a gist naming the file baker.yaml', async function() {
        const gist = JSON.stringify({ files: { 'baker.yaml': { content: 'name: yaml\n' } } });
        const dir = await Git.fetchBakerFile('https://gist.github.com/user/abc123', jsonGet(gist));
        expect(fs.readFileSync(path.join(dir, 'baker.yml'), 'utf8')).to.equal('name: yaml\n');
    });

    it('refuses an empty gist', async function() {
        let msg = '';
        try { await Git.fetchBakerFile('https://gist.github.com/user/abc123', jsonGet('{"files":{}}')); }
        catch (e) { msg = e.message; }
        expect(msg).to.contain('No files found in gist');
    });

    it('refuses a gist with no baker.yml, listing what it did find', async function() {
        // No first-file fallback: silently taking whatever came first is the
        // invisible substitution the baker.yml rule exists to prevent.
        const gist = JSON.stringify({ files: { 'other.yml': { content: 'x' } } });
        let msg = '';
        try { await Git.fetchBakerFile('https://gist.github.com/user/abc123', jsonGet(gist)); }
        catch (e) { msg = e.message; }
        expect(msg).to.contain('No baker.yml in gist');
        expect(msg).to.contain('other.yml');
    });

    it('fetches a raw baker.yml url as-is', async function() {
        const dir = await Git.fetchBakerFile(
            'https://raw.githubusercontent.com/o/r/main/baker.yml', jsonGet('name: raw\n'));
        expect(fs.readFileSync(path.join(dir, 'baker.yml'), 'utf8')).to.equal('name: raw\n');
    });
});

describe('Git.requireBakerFileName', function() {
    it('accepts baker.yml and baker.yaml', function() {
        expect(() => Git.requireBakerFileName('https://example.com/a/baker.yml')).to.not.throw();
        expect(() => Git.requireBakerFileName('https://example.com/a/BAKER.YAML')).to.not.throw();
    });

    it('names the file it found when the name is wrong', function() {
        expect(() => Git.requireBakerFileName('https://example.com/a/config.yml'))
            .to.throw(/found "config.yml"/);
    });

    it('lets an unparseable URL through, leaving the fetch to fail', function() {
        // Deliberate: the name cannot be checked, so the error should come from
        // the fetch rather than from a guess about the string.
        expect(() => Git.requireBakerFileName('not a url at all')).to.not.throw();
    });
});

describe('Git.raw env argument', function() {
    let work;

    beforeEach(function() {
        work = fs.mkdtempSync(path.join(os.tmpdir(), 'baker-git-env-'));
    });

    afterEach(function() {
        fs.rmSync(work, { recursive: true, force: true });
    });

    it('merges over process.env rather than replacing it', async function() {
        // The regression this guards: simple-git hands _env straight to spawn,
        // whose `env` option REPLACES the environment — so passing the one
        // variable alone drops everything else, including HOME (no ~/.gitconfig,
        // no credential helper) and SSH_AUTH_SOCK.
        //
        // Asserted through a variable git itself reports back, so the test fails
        // if the merge is removed. Checking that git merely *runs* would not:
        // execvp falls back to a default PATH, so `git` is still found with the
        // environment stripped and the bug would pass unnoticed.
        // Both name AND email: `git var GIT_AUTHOR_IDENT` refuses to guess an
        // address, and a CI runner has no global identity to fall back on — so
        // setting only the name passes locally and fails on every runner.
        const orig = { name: process.env.GIT_AUTHOR_NAME, email: process.env.GIT_AUTHOR_EMAIL };
        process.env.GIT_AUTHOR_NAME = 'Baker Env Probe';
        process.env.GIT_AUTHOR_EMAIL = 'probe@example.com';
        try {
            const out = await Git.raw(os.tmpdir(), ['var', 'GIT_AUTHOR_IDENT'],
                                      { GIT_TERMINAL_PROMPT: '0' });
            expect(out).to.contain('Baker Env Probe');
        } finally {
            ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL'].forEach((k) => {
                const was = k === 'GIT_AUTHOR_NAME' ? orig.name : orig.email;
                if (was === undefined) delete process.env[k];
                else process.env[k] = was;
            });
        }
    });

    it('still applies the variable it was given', async function() {
        const out = await Git.raw(os.tmpdir(), ['var', 'GIT_EDITOR'], { GIT_EDITOR: 'baker-probe-editor' });
        expect(out.trim()).to.equal('baker-probe-editor');
    });

    it('resolves a real repository end to end through resolveRef', async function() {
        const origin = makeOriginRepo(work, 'origin', 'baker.yml', 'name: env\n');
        const r = await Git.resolveRef(`file://${origin}`);
        expect(r.ref).to.equal('main');
        expect(r.sha).to.match(/^[0-9a-f]{40}$/);
    });

    it('leaves existing callers unchanged when no env is passed', async function() {
        const origin = makeOriginRepo(work, 'origin', 'baker.yml', 'name: env\n');
        const out = await Git.raw(os.tmpdir(), ['ls-remote', `file://${origin}`]);
        expect(out).to.contain('refs/heads/main');
    });
});
