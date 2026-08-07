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

        // `bake` takes a directory, never a file — a file argument used to be
        // accepted and silently renamed into the cache as baker.yml.
        it('rejects a path to baker.yml itself, naming its directory', async function() {
            const dir = path.join(tmpRoot, 'proj');
            fs.mkdirSync(dir);
            fs.writeFileSync(path.join(dir, 'baker.yml'), 'name: x\n');
            let err;
            try { await resolveSource(path.join(dir, 'baker.yml')); } catch (e) { err = e; }
            expect(err, 'a file argument should be rejected').to.not.be.undefined;
            expect(err.message).to.contain('takes the directory containing it');
            expect(err.message).to.contain(dir);
        });

        it('rejects a differently-named .yml rather than renaming it', async function() {
            const file = path.join(tmpRoot, 'python2.yml');
            fs.writeFileSync(file, 'name: python2\n');
            let err;
            try { await resolveSource(file); } catch (e) { err = e; }
            expect(err.message).to.contain('reads a directory whose top level holds a baker.yml');
        });

        it('tells the author how to fix a differently-named config', async function() {
            const file = path.join(tmpRoot, 'PM3.yml');
            fs.writeFileSync(file, 'name: pm3\n');
            let err;
            try { await resolveSource(file); } catch (e) { err = e; }
            expect(err.message).to.contain('mv PM3.yml baker.yml');
        });

        it('throws for an existing non-.yml file', async function() {
            const file = path.join(tmpRoot, 'notes.txt');
            fs.writeFileSync(file, 'hello');
            let err;
            try { await resolveSource(file); } catch (e) { err = e; }
            expect(err.message).to.match(/reads a directory whose top level holds a baker\.yml/);
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

        // Sub-directory addressing was removed 2026-08-07: a repository holds one
        // baker.yml, at its top level, and variants are selected by ref.
        it('rejects owner/repo:subdir instead of resolving it', async function() {
            process.chdir(tmpRoot);
            let err;
            try { await resolveSource('your-org/configs:assignments/unit-1'); } catch (e) { err = e; }
            expect(err, 'a sub-directory address should be rejected').to.not.be.undefined;
            expect(err.message).to.contain('no longer supports');
        });

        it('says a baker.yml must be at the top level', async function() {
            process.chdir(tmpRoot);
            let err;
            try { await resolveSource('your-org/configs:units/two'); } catch (e) { err = e; }
            expect(err.message).to.contain('top level');
        });

        it('suggests a ref in place of the sub-directory', async function() {
            process.chdir(tmpRoot);
            let err;
            try { await resolveSource('your-org/configs:assignments/PM3'); } catch (e) { err = e; }
            expect(err.message).to.contain('your-org/configs@PM3');
        });

        it('rejects before any network access', async function() {
            const orig = Git.clone;
            let cloned = false;
            Git.clone = async () => { cloned = true; return tmpRoot; };
            try {
                process.chdir(tmpRoot);
                try { await resolveSource('your-org/configs:units/one'); } catch (e) { /* expected */ }
                expect(cloned, 'a rejected address must not clone').to.be.false;
            } finally {
                Git.clone = orig;
            }
        });

        it('resolves owner/repo@ref to the repo root, cloned at that ref', async function() {
            const orig = Git.clone;
            const cloneDir = path.join(tmpRoot, 'clone-ref');
            fs.mkdirSync(cloneDir, { recursive: true });
            fs.writeFileSync(path.join(cloneDir, 'baker.yml'), 'name: pm3\n');
            let seen;
            Git.clone = async (url, ref) => { seen = { url, ref }; return cloneDir; };
            try {
                process.chdir(tmpRoot);
                const resolved = await resolveSource('your-org/configs@PM3');
                expect(seen.url).to.equal('https://github.com/your-org/configs.git');
                expect(seen.ref).to.equal('PM3');
                expect(resolved).to.equal(cloneDir);
            } finally {
                Git.clone = orig;
            }
        });

        it('passes no ref for a bare owner/repo', async function() {
            const orig = Git.clone;
            const cloneDir = path.join(tmpRoot, 'clone-noref');
            fs.mkdirSync(cloneDir, { recursive: true });
            fs.writeFileSync(path.join(cloneDir, 'baker.yml'), 'name: x\n');
            let seen;
            Git.clone = async (url, ref) => { seen = { url, ref }; return cloneDir; };
            try {
                process.chdir(tmpRoot);
                await resolveSource('your-org/configs');
                expect(seen.ref).to.be.undefined;
            } finally {
                Git.clone = orig;
            }
        });

        it('supports a ref containing a slash', function() {
            expect(classifyRemote('your-org/configs@release/1.2').ref).to.equal('release/1.2');
        });

        it('reports a missing top-level baker.yml naming the ref', async function() {
            const orig = Git.clone;
            const cloneDir = path.join(tmpRoot, 'clone-empty');
            fs.mkdirSync(cloneDir, { recursive: true });
            Git.clone = async () => cloneDir;
            try {
                process.chdir(tmpRoot);
                let err;
                try { await resolveSource('your-org/configs@PM9'); } catch (e) { err = e; }
                expect(err.message).to.contain('top level');
                expect(err.message).to.contain('PM9');
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

describe('bake and cleanup share one address grammar', function() {
    // cleanup.js and bake.js both call resolveSource, so the grammars cannot
    // drift — but that is an invariant worth asserting rather than assuming,
    // since a future edit could give either its own resolution path.
    const fsx = require('fs-extra');
    const root = path.join(__dirname, '..', '..');
    const src  = (rel) => fsx.readFileSync(path.join(root, rel), 'utf8');

    it('cleanup resolves its source with resolveSource', function() {
        expect(src('lib/commands/cleanup.js')).to.contain('resolveSource');
    });

    it('bake resolves its positional with resolveSource', function() {
        expect(src('lib/commands/bake.js')).to.contain('resolveSource');
    });

    it('neither command resolves an address any other way', function() {
        // Git.clone / Git.fetchBakerFile appear in bake.js only behind the
        // explicit --repo / --file flags, and not at all in cleanup.js.
        expect(src('lib/commands/cleanup.js')).to.not.contain('Git.clone');
        expect(src('lib/commands/cleanup.js')).to.not.contain('fetchBakerFile');
    });

    it('cleanup documents the same grammar as bake', function() {
        expect(src('lib/commands/cleanup.js')).to.contain('identical grammar to bake');
    });

    it('accepts and rejects identically across a matrix of addresses', async function() {
        // One resolver, so this is really a regression net: if resolveSource
        // ever grew a per-verb branch, these would diverge.
        const base = fs.mkdtempSync(path.join(os.tmpdir(), 'baker-parity-'));
        const dir = path.join(base, 'parity');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'baker.yml'), 'name: p\n');

        const addresses = [
            dir,                                  // a directory with baker.yml
            path.join(dir, 'baker.yml'),          // a file — rejected
            path.join(base, 'absent'),            // missing path — rejected
            'org/repo:units/one',                 // sub-directory — rejected
            'org/repo:env.yml'                    // opunit grammar — rejected
        ];

        const outcome = async (a) => {
            try { await resolveSource(a); return 'accept'; } catch (e) { return 'reject'; }
        };

        const results = [];
        for (const a of addresses) results.push(await outcome(a));
        fs.rmSync(base, { recursive: true, force: true });
        expect(results).to.deep.equal(['accept', 'reject', 'reject', 'reject', 'reject']);
    });
});
