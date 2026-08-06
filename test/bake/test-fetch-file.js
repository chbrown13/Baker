const fs   = require('fs');
const os   = require('os');
const path = require('path');
const chai = require('chai');
const expect = chai.expect;

const Git = require('../../lib/modules/utils/git');

describe('Git.classifyBakerSource', function () {
    it('routes a cloud GitHub gist page to the cloud API', function () {
        const r = Git.classifyBakerSource('https://gist.github.com/username/1234567890abcdef');
        expect(r.kind).to.equal('github-gist');
        expect(r.apiUrl).to.equal('https://api.github.com/gists/1234567890abcdef');
    });

    it('routes a GitHub Enterprise gist page to the /api/v3 API on the same host', function () {
        const r = Git.classifyBakerSource('https://github.ncsu.edu/gist/username/1234567890abcdef');
        expect(r.kind).to.equal('github-gist');
        expect(r.apiUrl).to.equal('https://github.ncsu.edu/api/v3/gists/1234567890abcdef');
    });

    it('routes a cloud GitLab snippet page to its /raw URL', function () {
        const r = Git.classifyBakerSource('https://gitlab.com/-/snippets/42');
        expect(r.kind).to.equal('gitlab-snippet');
        expect(r.rawUrl).to.equal('https://gitlab.com/-/snippets/42/raw');
    });

    it('routes a self-hosted GitLab project snippet, preserving the host', function () {
        const r = Git.classifyBakerSource('https://gitlab.cs.vt.edu/grp/proj/-/snippets/7');
        expect(r.kind).to.equal('gitlab-snippet');
        expect(r.rawUrl).to.equal('https://gitlab.cs.vt.edu/grp/proj/-/snippets/7/raw');
    });

    it('treats a gist raw URL as already-raw', function () {
        const url = 'https://gist.githubusercontent.com/username/1234567890abcdef/raw/baker.yml';
        const r = Git.classifyBakerSource(url);
        expect(r.kind).to.equal('raw');
        expect(r.rawUrl).to.equal(url);
    });

    it('treats a GitLab /-/raw/ file URL as already-raw', function () {
        const url = 'https://gitlab.com/grp/proj/-/raw/main/baker.yml';
        const r = Git.classifyBakerSource(url);
        expect(r.kind).to.equal('raw');
        expect(r.rawUrl).to.equal(url);
    });

    it('treats a raw.githubusercontent.com URL as already-raw', function () {
        const url = 'https://raw.githubusercontent.com/o/r/main/baker.yml';
        const r = Git.classifyBakerSource(url);
        expect(r.kind).to.equal('raw');
        expect(r.rawUrl).to.equal(url);
    });
});

describe('Git.parseRepoTreeUrl', function () {
    it('parses a GitHub tree URL into clone URL, ref and subpath', function () {
        const r = Git.parseRepoTreeUrl('https://github.com/ottomatica/baker-examples/tree/master/jenkins');
        expect(r).to.deep.equal({
            cloneUrl: 'https://github.com/ottomatica/baker-examples.git',
            ref: 'master',
            subpath: 'jenkins'
        });
    });

    it('parses a GitLab tree URL with nested groups', function () {
        const r = Git.parseRepoTreeUrl('https://gitlab.com/grp/sub/proj/-/tree/main/deploy');
        expect(r).to.deep.equal({
            cloneUrl: 'https://gitlab.com/grp/sub/proj.git',
            ref: 'main',
            subpath: 'deploy'
        });
    });

    it('returns subpath "" for a tree URL pointing at the repo root', function () {
        const r = Git.parseRepoTreeUrl('https://github.com/o/r/tree/master');
        expect(r).to.deep.equal({
            cloneUrl: 'https://github.com/o/r.git',
            ref: 'master',
            subpath: ''
        });
    });

    it('returns null for a plain clone URL', function () {
        expect(Git.parseRepoTreeUrl('https://github.com/o/r.git')).to.equal(null);
    });

    it('returns null for an ssh-style clone URL', function () {
        expect(Git.parseRepoTreeUrl('git@github.com:o/r.git')).to.equal(null);
    });
});

// AC-7: the single-file URL form is retained, but stages into the cache rather
// than tmp/baker-file-<random> under cwd. Network is stubbed at Git.fetchUrl so
// this stays a unit test.
describe('Git.fetchBakerFile (cache staging)', function () {
    let tmpHome, origHome, cwdSandbox, origCwd, origFetchUrl;

    beforeEach(function () {
        origHome = process.env.HOME;
        origCwd = process.cwd();
        tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'baker-home-'));
        cwdSandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'baker-cwd-'));
        process.env.HOME = tmpHome;
        process.chdir(cwdSandbox);
        origFetchUrl = Git.fetchUrl;
        Git.fetchUrl = async () => 'name: fetched\n';
    });

    afterEach(function () {
        Git.fetchUrl = origFetchUrl;
        process.chdir(origCwd);
        if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
        fs.rmSync(tmpHome, { recursive: true, force: true });
        fs.rmSync(cwdSandbox, { recursive: true, force: true });
    });

    it('writes baker.yml into the cache and nothing into cwd (AC-4, AC-7)', async function () {
        const url = 'https://raw.githubusercontent.com/o/r/main/baker.yml';

        const dir = await Git.fetchBakerFile(url);

        expect(dir).to.equal(Git.fetchCacheDir(url));
        expect(fs.readFileSync(path.join(dir, 'baker.yml'), 'utf8')).to.equal('name: fetched\n');
        expect(fs.readdirSync(cwdSandbox)).to.deep.equal([]);
    });

    it('reuses one directory when the same URL is fetched twice (AC-5)', async function () {
        const url = 'https://example.com/baker.yml';

        const first = await Git.fetchBakerFile(url);
        const second = await Git.fetchBakerFile(url);

        expect(second).to.equal(first);
        expect(fs.readdirSync(path.join(tmpHome, '.baker', 'cache', 'fetch'))).to.have.lengthOf(1);
    });

    it('uses a distinct directory per URL', async function () {
        const a = await Git.fetchBakerFile('https://example.com/a.yml');
        const b = await Git.fetchBakerFile('https://example.com/b.yml');
        expect(a).to.not.equal(b);
    });

    it('surfaces an empty gist as an actionable error', async function () {
        const origFetchJson = Git.fetchJson;
        Git.fetchJson = async () => ({ files: {} });
        try {
            let err;
            try { await Git.fetchBakerFile('https://gist.github.com/u/1234abcd'); } catch (e) { err = e; }
            expect(err.message).to.match(/No files found in gist/);
        } finally {
            Git.fetchJson = origFetchJson;
        }
    });
});
