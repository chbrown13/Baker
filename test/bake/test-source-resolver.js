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

        it('classifies owner/repo:file.yml as github-file with subpath', function() {
            expect(classifyRemote('your-org/profiles:sub/env.yml')).to.deep.equal({
                kind: 'github-file',
                cloneUrl: 'https://github.com/your-org/profiles.git',
                subpath: 'sub/env.yml'
            });
        });

        it('classifies owner/repo:subdir as github-dir, not github-file', function() {
            expect(classifyRemote('your-org/configs:assignments/unit-1')).to.deep.equal({
                kind: 'github-dir',
                cloneUrl: 'https://github.com/your-org/configs.git',
                subpath: 'assignments/unit-1'
            });
        });

        it('treats a .yaml suffix as a file address too', function() {
            expect(classifyRemote('your-org/profiles:env.yaml').kind).to.equal('github-file');
        });

        it('keeps the two verbs\' accepted kinds disjoint', function() {
            // bake takes directories, check takes files. Nothing classifies as both.
            const dir  = classifyRemote('your-org/configs:units/one');
            const file = classifyRemote('your-org/profiles:one.yml');
            expect(dir.kind).to.equal('github-dir');
            expect(file.kind).to.equal('github-file');
            expect(dir.kind).to.not.equal(file.kind);
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

        it('stages a differently-named .yml file into the cache as baker.yml, not cwd', async function() {
            const origHome = process.env.HOME;
            const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'baker-home-'));
            process.env.HOME = tmpHome;
            try {
                const file = path.join(tmpRoot, 'python2.yml');
                fs.writeFileSync(file, 'name: python2\n');
                process.chdir(tmpRoot);

                const before = fs.readdirSync(tmpRoot);
                const resolved = await resolveSource(file);
                const after = fs.readdirSync(tmpRoot);

                expect(after).to.deep.equal(before);        // nothing staged into cwd
                expect(resolved.startsWith(path.join(tmpHome, '.baker', 'cache'))).to.equal(true);
                expect(fs.readFileSync(path.join(resolved, 'baker.yml'), 'utf8')).to.equal('name: python2\n');
            } finally {
                if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
                fs.rmSync(tmpHome, { recursive: true, force: true });
            }
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
            const cloneDir = path.join(tmpRoot, 'fake-clone');
            fs.mkdirSync(cloneDir);
            fs.writeFileSync(path.join(cloneDir, 'baker.yml'), 'name: x\n');
            let cloned;
            Git.clone = async (url) => { cloned = url; return cloneDir; };
            try {
                process.chdir(tmpRoot); // ensure "ottomatica/baker-test" is not a real path
                const resolved = await resolveSource('ottomatica/baker-test');
                expect(cloned).to.equal('https://github.com/ottomatica/baker-test.git');
                expect(resolved).to.equal(cloneDir);
            } finally {
                Git.clone = orig;
            }
        });

        // AC-1 — the promote-a-named-file-to-baker.yml behaviour is gone. A
        // :file.yml address is opunit's grammar; bake rejects it by name.
        it('rejects owner/repo:file.yml, naming baker check (AC-1)', async function() {
            const orig = Git.clone;
            let cloneAttempted = false;
            Git.clone = async () => { cloneAttempted = true; return '/tmp/should-not-happen'; };
            try {
                process.chdir(tmpRoot);
                let err;
                try { await resolveSource('owner/repo:unit-1.yml'); } catch (e) { err = e; }
                expect(err).to.be.an('error');
                expect(err.message).to.contain('addresses a file');
                expect(err.message).to.contain('baker check owner/repo:unit-1.yml');
                // "before any network access"
                expect(cloneAttempted).to.equal(false);
            } finally {
                Git.clone = orig;
            }
        });

        it('rejects a top-level :baker.yml address too — it is still a file (AC-1)', async function() {
            process.chdir(tmpRoot);
            let err;
            try { await resolveSource('owner/repo:baker.yml'); } catch (e) { err = e; }
            expect(err.message).to.contain('addresses a file');
        });

        // AC-2 — subdirectory addressing, which used to be rejected outright.
        it('resolves owner/repo:subdir to that subdirectory (AC-2)', async function() {
            const orig = Git.clone;
            const cloneDir = path.join(tmpRoot, 'clone');
            const unitDir = path.join(cloneDir, 'assignments', 'unit-1');
            fs.mkdirSync(unitDir, { recursive: true });
            fs.writeFileSync(path.join(unitDir, 'baker.yml'), 'name: unit-1\n');
            let cloned;
            Git.clone = async (url) => { cloned = url; return cloneDir; };
            try {
                process.chdir(tmpRoot);
                const resolved = await resolveSource('your-org/configs:assignments/unit-1');
                expect(cloned).to.equal('https://github.com/your-org/configs.git');
                expect(resolved).to.equal(unitDir);
            } finally {
                Git.clone = orig;
            }
        });

        it('requires a literal baker.yml at the repo root for a bare owner/repo', async function() {
            const orig = Git.clone;
            const cloneDir = path.join(tmpRoot, 'clone-root');
            fs.mkdirSync(cloneDir);
            fs.writeFileSync(path.join(cloneDir, 'baker.yml'), 'name: root\n');
            Git.clone = async () => cloneDir;
            try {
                process.chdir(tmpRoot);
                expect(await resolveSource('your-org/configs')).to.equal(cloneDir);
            } finally {
                Git.clone = orig;
            }
        });

        // AC-3
        it('errors actionably when the subdirectory has no baker.yml (AC-3)', async function() {
            const orig = Git.clone;
            const cloneDir = path.join(tmpRoot, 'clone2');
            const unitDir = path.join(cloneDir, 'units', 'two');
            fs.mkdirSync(unitDir, { recursive: true });
            Git.clone = async () => cloneDir;
            try {
                process.chdir(tmpRoot);
                let err;
                try { await resolveSource('your-org/configs:units/two'); } catch (e) { err = e; }
                expect(err.message).to.contain('units/two');
                expect(err.message).to.contain('https://github.com/your-org/configs.git');
                expect(err.message).to.contain(unitDir);
            } finally {
                Git.clone = orig;
            }
        });

        it('errors naming the subdirectory when it does not exist at all (AC-3)', async function() {
            const orig = Git.clone;
            const cloneDir = path.join(tmpRoot, 'clone3');
            fs.mkdirSync(cloneDir);
            Git.clone = async () => cloneDir;
            try {
                process.chdir(tmpRoot);
                let err;
                try { await resolveSource('your-org/configs:units/absent'); } catch (e) { err = e; }
                expect(err.message).to.match(/Sub-directory "units\/absent" does not exist/);
            } finally {
                Git.clone = orig;
            }
        });

        it('refuses a subdirectory that escapes the clone', async function() {
            const orig = Git.clone;
            const cloneDir = path.join(tmpRoot, 'clone4');
            fs.mkdirSync(cloneDir);
            Git.clone = async () => cloneDir;
            try {
                process.chdir(tmpRoot);
                let err;
                try { await resolveSource('your-org/configs:../../etc'); } catch (e) { err = e; }
                expect(err.message).to.match(/resolves outside/);
            } finally {
                Git.clone = orig;
            }
        });

        it('throws for unresolvable free-text input', async function() {
            process.chdir(tmpRoot);
            let err;
            try { await resolveSource('this is not a source'); } catch (e) { err = e; }
            expect(err.message).to.match(/Could not resolve baker source/);
        });
    });

    // AC-4 is the important one: students run Baker from inside repos they care
    // about, so no remote form may leave anything behind in cwd. Git.clone and
    // Git.fetchBakerFile are stubbed to write into the cache path they would
    // really use, so this exercises the resolver's own path handling.
    describe('AC-4: no remote form writes to cwd', function() {
        let tmpRoot, tmpHome, origCwd, origHome, origClone, origFetch;

        beforeEach(function() {
            origCwd = process.cwd();
            origHome = process.env.HOME;
            tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'baker-cwd-'));
            tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'baker-home-'));
            process.env.HOME = tmpHome;
            process.chdir(tmpRoot);

            origClone = Git.clone;
            origFetch = Git.fetchBakerFile;

            // Stand-ins that behave like the real ones: write into the cache
            // directory the real implementation computes, and nowhere else.
            Git.clone = async (url) => {
                const dir = Git.cacheDir(url);
                fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(path.join(dir, 'baker.yml'), 'name: cloned\n');
                return dir;
            };
            Git.fetchBakerFile = async (url) => {
                const dir = Git.fetchCacheDir(url);
                fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(path.join(dir, 'baker.yml'), 'name: fetched\n');
                return dir;
            };
        });

        afterEach(function() {
            Git.clone = origClone;
            Git.fetchBakerFile = origFetch;
            process.chdir(origCwd);
            if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
            fs.rmSync(tmpRoot, { recursive: true, force: true });
            fs.rmSync(tmpHome, { recursive: true, force: true });
        });

        const forms = [
            ['owner/repo shorthand',   'your-org/configs'],
            ['owner/repo:subdir',      'your-org/configs:units/one'],
            ['a raw .yml URL',         'https://raw.githubusercontent.com/o/r/main/baker.yml'],
            ['a gist page URL',        'https://gist.github.com/username/1234567890abcdef'],
            ['a GitHub tree URL',      'https://github.com/o/r/tree/master/sub'],
            ['an scp-style remote',    'git@github.com:o/r.git'],
        ];

        forms.forEach(function([label, source]) {
            it(`leaves cwd untouched for ${label}`, async function() {
                const before = fs.readdirSync(tmpRoot);
                try {
                    await resolveSource(source);
                } catch (err) {
                    // A resolution failure is fine here; littering is not.
                }
                expect(fs.readdirSync(tmpRoot)).to.deep.equal(before);
                expect(fs.readdirSync(tmpRoot)).to.deep.equal([]);
            });
        });
    });
});
