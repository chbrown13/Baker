const fs   = require('fs');
const os   = require('os');
const path = require('path');
const chai = require('chai');
const expect = chai.expect;

const Git = require('../../lib/modules/utils/git');
const { classifyRemote, resolveSource } = require('../../lib/modules/utils/source');

describe('source resolver', function() {

    describe('classifyRemote (pure)', function() {
        it('classifies owner/repo as github', function() {
            expect(classifyRemote('ottomatica/baker-test')).to.deep.equal({
                kind: 'github',
                cloneUrl: 'https://github.com/ottomatica/baker-test.git'
            });
        });

        it('classifies owner/repo:file as github-file with subpath', function() {
            expect(classifyRemote('chbrown13/profile:sub/5704.yml')).to.deep.equal({
                kind: 'github-file',
                cloneUrl: 'https://github.com/chbrown13/profile.git',
                subpath: 'sub/5704.yml'
            });
        });

        it('classifies http(s) URLs as url', function() {
            expect(classifyRemote('https://gist.github.com/u/abc123').kind).to.equal('url');
            expect(classifyRemote('https://github.com/o/r/tree/master/sub').kind).to.equal('url');
        });

        it('classifies scp-style git remotes as url', function() {
            expect(classifyRemote('git@github.com:ottomatica/baker-test.git').kind).to.equal('url');
        });

        it('returns null for unrecognized input', function() {
            expect(classifyRemote('just some text')).to.equal(null);
            expect(classifyRemote('')).to.equal(null);
            expect(classifyRemote(undefined)).to.equal(null);
        });
    });

    describe('resolveSource (filesystem)', function() {
        let tmpRoot, origCwd;

        beforeEach(function() {
            origCwd = process.cwd();
            tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'baker-src-'));
        });

        afterEach(function() {
            process.chdir(origCwd);
            fs.rmSync(tmpRoot, { recursive: true, force: true });
        });

        it('returns cwd when no source is given and ./baker.yml exists', async function() {
            fs.writeFileSync(path.join(tmpRoot, 'baker.yml'), 'name: x\n');
            process.chdir(tmpRoot);
            expect(await resolveSource(undefined)).to.equal(fs.realpathSync(tmpRoot));
        });

        it('throws an actionable error when no source and no ./baker.yml', async function() {
            process.chdir(tmpRoot);
            let err;
            try { await resolveSource(undefined); } catch (e) { err = e; }
            expect(err).to.be.an('error');
            expect(err.message).to.match(/Can't find baker\.yml/);
        });

        it('returns the directory for a dir containing baker.yml', async function() {
            const dir = path.join(tmpRoot, 'proj');
            fs.mkdirSync(dir);
            fs.writeFileSync(path.join(dir, 'baker.yml'), 'name: x\n');
            expect(await resolveSource(dir)).to.equal(dir);
        });

        it('throws for a directory without a baker.yml', async function() {
            const dir = path.join(tmpRoot, 'empty');
            fs.mkdirSync(dir);
            let err;
            try { await resolveSource(dir); } catch (e) { err = e; }
            expect(err.message).to.match(/No baker\.yml found/);
        });

        it('uses a baker.yml file arg directly (no copy)', async function() {
            const dir = path.join(tmpRoot, 'proj');
            fs.mkdirSync(dir);
            fs.writeFileSync(path.join(dir, 'baker.yml'), 'name: x\n');
            expect(await resolveSource(path.join(dir, 'baker.yml'))).to.equal(dir);
        });

        it('stages a differently-named .yml file into a temp dir as baker.yml', async function() {
            const file = path.join(tmpRoot, 'python2.yml');
            fs.writeFileSync(file, 'name: python2\n');
            process.chdir(tmpRoot); // temp dir is created under cwd
            const resolved = await resolveSource(file);
            expect(resolved).to.not.equal(path.dirname(file));
            const staged = fs.readFileSync(path.join(resolved, 'baker.yml'), 'utf8');
            expect(staged).to.equal('name: python2\n');
        });

        it('throws for an existing non-.yml file', async function() {
            const file = path.join(tmpRoot, 'notes.txt');
            fs.writeFileSync(file, 'hello');
            let err;
            try { await resolveSource(file); } catch (e) { err = e; }
            expect(err.message).to.match(/not a \.yml/);
        });

        it('clones owner/repo shorthand when it is not a local path', async function() {
            const orig = Git.clone;
            let cloned;
            Git.clone = async (url) => { cloned = url; return '/tmp/fake-clone'; };
            try {
                process.chdir(tmpRoot); // ensure "ottomatica/baker-test" is not a real path
                const resolved = await resolveSource('ottomatica/baker-test');
                expect(cloned).to.equal('https://github.com/ottomatica/baker-test.git');
                expect(resolved).to.equal('/tmp/fake-clone');
            } finally {
                Git.clone = orig;
            }
        });

        it('resolves owner/repo:file.yml by cloning and promoting the file to baker.yml', async function() {
            const orig = Git.clone;
            const cloneDir = path.join(tmpRoot, 'clone');
            fs.mkdirSync(cloneDir);
            fs.writeFileSync(path.join(cloneDir, 'python2.yml'), 'name: python2\n');
            let cloned;
            Git.clone = async (url) => { cloned = url; return cloneDir; };
            try {
                process.chdir(tmpRoot);
                const resolved = await resolveSource('ottomatica/repo:python2.yml');
                expect(cloned).to.equal('https://github.com/ottomatica/repo.git');
                expect(resolved).to.equal(cloneDir);
                expect(fs.readFileSync(path.join(cloneDir, 'baker.yml'), 'utf8')).to.equal('name: python2\n');
            } finally {
                Git.clone = orig;
            }
        });

        it('returns the clone dir as-is when owner/repo:baker.yml is top-level', async function() {
            const orig = Git.clone;
            const cloneDir = path.join(tmpRoot, 'clone2');
            fs.mkdirSync(cloneDir);
            fs.writeFileSync(path.join(cloneDir, 'baker.yml'), 'name: top\n');
            Git.clone = async () => cloneDir;
            try {
                process.chdir(tmpRoot);
                expect(await resolveSource('ottomatica/repo:baker.yml')).to.equal(cloneDir);
            } finally {
                Git.clone = orig;
            }
        });

        it('rejects sub-directory paths in owner/repo:sub/file.yml', async function() {
            process.chdir(tmpRoot);
            let err;
            try { await resolveSource('owner/repo:sub/profile.yml'); } catch (e) { err = e; }
            expect(err.message).to.match(/Sub-directory paths .* not supported/);
        });

        it('throws for unresolvable free-text input', async function() {
            process.chdir(tmpRoot);
            let err;
            try { await resolveSource('this is not a source'); } catch (e) { err = e; }
            expect(err.message).to.match(/Could not resolve baker source/);
        });
    });
});
