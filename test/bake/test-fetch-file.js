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
