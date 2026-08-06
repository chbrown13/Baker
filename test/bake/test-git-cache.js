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
