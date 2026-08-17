const child_process = require('child_process');
const EventEmitter = require('events');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const chai = require('chai');
const expect = chai.expect;

// Stub child_process.spawn BEFORE requiring the command, since check.js
// captures the `spawn` reference at module load via destructuring.
//
// Mocha loads every test file before running any of them, so this replacement is
// installed for the whole suite — it must therefore stay inert outside this
// file's own tests, or it breaks anything else that shells out (simple-git in
// test-git-cache.js, for one). Hence the delegating `stubActive` gate rather than
// an unconditional fake: check.js keeps the reference it captured at load, and
// every other spawn goes to the real implementation.
//
// This is the hazard that made the profile-fetch seams INJECTED rather than
// globally replaced: Git.raw and Git.fetchUrl are passed in as arguments below,
// so nothing in this file can leak the way this stub once did.
let spawnCalls = [];
let stubActive = false;
// What the fake child does once runOpunit has attached its listeners. Default is
// a clean exit; the ENOENT and non-zero cases set it for one test.
let spawnResult = { event: 'close', arg: 0 };
const origSpawn = child_process.spawn;
child_process.spawn = function(cmd, args, opts) {
    if (!stubActive) return origSpawn.apply(child_process, arguments);
    spawnCalls.push({ cmd, args, opts });
    const fake = new EventEmitter();
    // Emit on the next tick, after runOpunit() has attached its
    // 'close'/'error' listeners.
    process.nextTick(() => fake.emit(spawnResult.event, spawnResult.arg));
    return fake;
};

const check = require('../../lib/commands/check');
const { checkArgs, opunitArgs, profileAddress, profileCachePath, resolveProfile, runCheck } = check;
const Git = require('../../lib/modules/utils/git');

after(function() {
    child_process.spawn = origSpawn;
});

// The profile cache lives under Git.cacheRoot(), which reads os.homedir() on
// every call. Pointing HOME at a temp dir keeps these tests off the real
// ~/.baker. Same helper as test-git-cache.js.
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

const SHA = 'abcdef1234567890abcdef1234567890abcdef12';

// Fakes for the two injected network edges. Neither touches a shared object.
function fakeGit(lines, calls) {
    return async function(cwd, args, env) {
        if (calls) calls.push({ cwd, args, env });
        return lines;
    };
}

function fakeFetch(body, calls) {
    return async function(url, headers) {
        if (calls) calls.push({ url, headers });
        return body;
    };
}

const LS_REMOTE = [
    'ref: refs/heads/main\tHEAD',
    `${SHA}\tHEAD`,
    `${SHA}\trefs/heads/main`,
    '2222222222222222222222222222222222222222\trefs/heads/unit-1',
    ''
].join('\n');

// Silences the provenance line in tests that are not asserting it.
const quiet = () => {};

describe('check command', function() {
    before(function() {
        stubActive = true;
    });

    after(function() {
        stubActive = false;
    });

    beforeEach(function() {
        spawnCalls = [];
        spawnResult = { event: 'close', arg: 0 };
    });

    it('should register as "check [target]"', function() {
        expect(check.command).to.equal('check [target]');
    });

    describe('opunit not installed, and exit codes', function() {
        it('reports the install hint when opunit is not on PATH', async function() {
            const enoent = Object.assign(new Error('spawn opunit ENOENT'), { code: 'ENOENT' });
            spawnResult = { event: 'error', arg: enoent };
            let msg = '';
            try { await runCheck(undefined); } catch (e) { msg = e.message; }
            expect(msg).to.contain('opunit not found on PATH');
            expect(msg).to.contain('npm install -g ottomatica/opunit');
        });

        it('states the minimum opunit version in the install hint', async function() {
            // `verify local -c <path>` needs 0.9.4. An older opunit ignores -c and
            // silently runs the machine's own test/opunit.yml instead, reporting
            // it as the profile result — so the version has to be stated where
            // people read it.
            const enoent = Object.assign(new Error('spawn opunit ENOENT'), { code: 'ENOENT' });
            spawnResult = { event: 'error', arg: enoent };
            let msg = '';
            try { await runCheck(undefined); } catch (e) { msg = e.message; }
            expect(msg).to.contain('0.9.4');
        });

        it('propagates a spawn error that is not ENOENT unchanged', async function() {
            spawnResult = { event: 'error', arg: new Error('EACCES') };
            let msg = '';
            try { await runCheck(undefined); } catch (e) { msg = e.message; }
            expect(msg).to.equal('EACCES');
        });

        it('rejects with opunit\'s exit code when checks fail', async function() {
            spawnResult = { event: 'close', arg: 3 };
            let msg = '';
            try { await runCheck(undefined); } catch (e) { msg = e.message; }
            expect(msg).to.contain('exited with code 3');
        });
    });

    describe('CLI surface', function() {
        // The help text is user-facing, so it is held to the same neutral-
        // placeholder rule as the error strings.
        function fakeYargs() {
            const calls = { examples: [], positionals: [] };
            const y = {
                example: (cmd, desc) => { calls.examples.push([cmd, desc]); return y; },
                positional: (name, opts) => { calls.positionals.push([name, opts]); return y; }
            };
            check.builder(y);
            return calls;
        }

        it('documents the ref form in the positional description', function() {
            const { positionals } = fakeYargs();
            expect(positionals[0][0]).to.equal('target');
            expect(positionals[0][1].describe).to.contain('[@<ref>]');
        });

        it('shows an example of each of the three invocations', function() {
            expect(fakeYargs().examples).to.have.lengthOf(3);
        });

        it('uses neutral placeholders, never a real course, org, or handle', function() {
            const text = JSON.stringify(fakeYargs());
            expect(text.toLowerCase()).to.not.match(/cs\d{4}|chbrown/);
            expect(text).to.contain('your-org');
        });
    });

    it('should delegate to `opunit verify local` when no target is given', async function() {
        await check.handler({});
        expect(spawnCalls).to.have.lengthOf(1);
        expect(spawnCalls[0].cmd).to.equal('opunit');
        expect(spawnCalls[0].args).to.deep.equal(['verify', 'local']);
    });

    it('should inherit stdio so opunit output streams through', async function() {
        await check.handler({});
        expect(spawnCalls[0].opts).to.have.property('stdio', 'inherit');
    });

    // These used to assert a silent fall-through to local mode. That reported a
    // DIFFERENT check's result as the requested one, so an unrunnable target is
    // an error and opunit is never spawned.
    it('should refuse a bare name rather than running local checks', async function() {
        await check.handler({ target: 'my-vm' });
        expect(spawnCalls, 'opunit must not be spawned for a refused target').to.have.lengthOf(0);
    });

    it('should refuse an ssh-style address rather than running local checks', async function() {
        await check.handler({ target: 'user@192.168.1.10' });
        expect(spawnCalls).to.have.lengthOf(0);
    });

    it('should refuse a repository address rather than running local checks', async function() {
        await check.handler({ target: 'your-org/configs' });
        expect(spawnCalls).to.have.lengthOf(0);
    });

    // AC-6: opunit is invoked as `verify local -c <path>`; `profile` is gone.
    describe('AC-6: opunit invocation', function() {
        withTempHome();

        it('spawns `opunit verify local -c <resolved path>` for a profile address', async function() {
            await runCheck('your-org/profiles:env.yml', {
                raw: fakeGit(LS_REMOTE), fetchUrl: fakeFetch('- name: node\n'), print: quiet
            });
            expect(spawnCalls).to.have.lengthOf(1);
            expect(spawnCalls[0].cmd).to.equal('opunit');
            expect(spawnCalls[0].args.slice(0, 3)).to.deep.equal(['verify', 'local', '-c']);
            expect(spawnCalls[0].args).to.have.lengthOf(4);
        });

        it('never passes `profile` to opunit', async function() {
            await runCheck('your-org/profiles:env.yml', {
                raw: fakeGit(LS_REMOTE), fetchUrl: fakeFetch('- name: node\n'), print: quiet
            });
            expect(spawnCalls[0].args).to.not.contain('profile');
        });

        it('hands opunit a path that exists and holds the fetched content', async function() {
            await runCheck('your-org/profiles:env.yml', {
                raw: fakeGit(LS_REMOTE), fetchUrl: fakeFetch('- name: node\n'), print: quiet
            });
            const dest = spawnCalls[0].args[3];
            expect(fs.readFileSync(dest, 'utf8')).to.equal('- name: node\n');
        });
    });

    // AC-9: a resolution failure is a hard failure — no cached profile is run.
    describe('AC-9: resolution failure never falls back to a cached profile', function() {
        const home = withTempHome();

        it('does not spawn opunit when ls-remote fails, even with a cached profile present', async function() {
            const cached = path.join(home(), '.baker', 'cache', 'profiles',
                                     'your-org', 'profiles', SHA, 'env.yml');
            fs.mkdirSync(path.dirname(cached), { recursive: true });
            fs.writeFileSync(cached, '- name: stale\n');

            const failing = async () => { throw new Error('fatal: could not resolve host: github.com'); };
            let err;
            try {
                await runCheck('your-org/profiles:env.yml', { raw: failing, print: quiet });
            } catch (e) { err = e; }

            expect(err, 'resolution failure must reject').to.be.an('error');
            expect(spawnCalls, 'opunit must not run against a cached profile').to.have.lengthOf(0);
        });

        it('names the repository and git\'s own error without advertising the cache', async function() {
            const failing = async () => { throw new Error('fatal: repository not found'); };
            let msg = '';
            try {
                await runCheck('your-org/typo:env.yml', { raw: failing, print: quiet });
            } catch (e) { msg = e.message; }

            expect(msg, 'AC-9 requires the repository be named').to.contain('your-org/typo');
            expect(msg, 'and git\'s own error kept, so a typo reads differently from a dead network')
                .to.contain('repository not found');
            expect(msg.toLowerCase(), 'the cache is never offered as a workaround')
                .to.not.contain('cache');
        });
    });
});

describe('check profile addressing', function() {
    describe('profileAddress (pure)', function() {
        it('splits a root-level address into owner, repo, and file', function() {
            expect(profileAddress('org/profiles:env.yml')).to.deep.equal({
                owner: 'org',
                repo: 'profiles',
                cloneUrl: 'https://github.com/org/profiles.git',
                file: 'env.yml',
                ref: null
            });
        });

        it('keeps a nested file path intact', function() {
            expect(profileAddress('org/profiles:units/unit-1.yml').file).to.equal('units/unit-1.yml');
        });

        it('accepts a .yaml extension', function() {
            expect(profileAddress('org/profiles:env.yaml').file).to.equal('env.yaml');
        });

        // AC-3: refs are supported now; the "opunit profiles do not support refs"
        // refusal these tests replaced is gone.
        it('carries a ref through', function() {
            const addr = profileAddress('org/profiles@unit-1:env.yml');
            expect(addr.ref).to.equal('unit-1');
            expect(addr.file).to.equal('env.yml');
        });

        it('carries a slash-bearing ref through', function() {
            expect(profileAddress('org/profiles@release/2026:env.yml').ref).to.equal('release/2026');
        });

        it('reports no ref as null rather than undefined', function() {
            expect(profileAddress('org/profiles:env.yml').ref).to.equal(null);
        });

        // AC-17: GitHub.com only.
        it('builds a github.com clone url and no other host', function() {
            expect(profileAddress('org/profiles:env.yml').cloneUrl)
                .to.equal('https://github.com/org/profiles.git');
        });

        it('refuses an address on another host', function() {
            expect(() => profileAddress('https://gitlab.com/org/profiles/-/raw/main/env.yml'))
                .to.throw(/not an opunit profile address/);
        });

        it('refuses a repository with no file', function() {
            expect(() => profileAddress('org/profiles')).to.throw(/not an opunit profile address/);
        });

        it('refuses a sub-directory address', function() {
            expect(() => profileAddress('org/profiles:units/one')).to.throw(/not an opunit profile address/);
        });

        it('refuses an unparseable target instead of silently running local checks', function() {
            expect(() => profileAddress('org/profiles:PM3.yml@PM3')).to.throw(/not an opunit profile address/);
        });

        it('refuses a local path', function() {
            expect(() => profileAddress('./some/path')).to.throw(/not an opunit profile address/);
        });

        it('refuses an ssh-style address', function() {
            expect(() => profileAddress('user@192.168.1.10')).to.throw(/not an opunit profile address/);
        });

        it('names the expected form and the local-mode escape in the refusal', function() {
            let msg = '';
            try { profileAddress('org/profiles'); } catch (e) { msg = e.message; }
            expect(msg).to.contain('<owner>/<repo>[@<ref>]:<file>.yml');
            expect(msg).to.contain('test/opunit.yml');
        });

        it('keeps every user-facing string free of a real course or handle', function() {
            let msg = '';
            try { profileAddress('org/profiles'); } catch (e) { msg = e.message; }
            expect(msg.toLowerCase()).to.not.match(/cs\d{4}|chbrown/);
        });
    });

    describe('opunitArgs', function() {
        it('runs local checks only when no target is given', function() {
            expect(opunitArgs(undefined)).to.deep.equal(['verify', 'local']);
        });

        it('passes a resolved profile path with -c', function() {
            expect(opunitArgs('org/profiles:env.yml', '/tmp/p.yml'))
                .to.deep.equal(['verify', 'local', '-c', '/tmp/p.yml']);
        });

        // The guard exists because dropping the resolved path would silently turn
        // a profile run into a local run — the substitution this command was
        // reworked to prevent.
        it('refuses to build local-mode argv for a target with no resolved profile', function() {
            expect(() => opunitArgs('org/profiles:env.yml')).to.throw(/was not resolved/);
        });
    });

    // AC-14: the guarantee that a refused target never becomes local mode, now
    // asserted through the whole pipeline rather than one function.
    describe('AC-14: never substitutes local mode for a target that was given', function() {
        const refused = ['org/profiles', 'org/profiles:units/one', 'garbage', './x', 'user@host',
                         'https://github.com/org/profiles'];

        refused.forEach((target) => {
            it(`refuses ${target} without falling through to local mode`, async function() {
                let args = null;
                try {
                    args = await checkArgs(target, { raw: fakeGit(LS_REMOTE), print: quiet });
                } catch (e) { /* expected */ }
                expect(args, `${target} must not fall through to local mode`).to.be.null;
            });
        });

        it('runs local checks for no target at all', async function() {
            expect(await checkArgs(undefined)).to.deep.equal(['verify', 'local']);
        });

        it('treats an empty target as no target', async function() {
            // `baker check ""` is the absence of a target, not an address that
            // failed to parse. Pinned because the two are one branch apart.
            expect(await checkArgs('')).to.deep.equal(['verify', 'local']);
        });

        // AC-13: local mode makes no network call and works offline.
        it('makes no git call in local mode', async function() {
            const calls = [];
            await checkArgs(undefined, { raw: fakeGit(LS_REMOTE, calls) });
            expect(calls).to.have.lengthOf(0);
        });
    });

    describe('profileCachePath (pure)', function() {
        const home = withTempHome();

        it('is content-addressed under <cache>/profiles/<owner>/<repo>/<sha>/<file>', function() {
            const addr = profileAddress('org/profiles:env.yml');
            expect(profileCachePath(addr, SHA)).to.equal(
                path.join(home(), '.baker', 'cache', 'profiles', 'org', 'profiles', SHA, 'env.yml'));
        });

        it('keeps a nested file path as nested directories', function() {
            const addr = profileAddress('org/profiles:units/unit-1.yml');
            expect(profileCachePath(addr, SHA)).to.equal(
                path.join(home(), '.baker', 'cache', 'profiles', 'org', 'profiles', SHA,
                          'units', 'unit-1.yml'));
        });

        it('gives two shas two different paths', function() {
            const addr = profileAddress('org/profiles:env.yml');
            expect(profileCachePath(addr, SHA)).to.not.equal(profileCachePath(addr, 'b'.repeat(40)));
        });

        it('never climbs out of the cache root', function() {
            // '..' is dropped rather than escaped, exactly as Git.cacheDir does.
            const addr = { owner: 'org', repo: 'profiles', file: '../../../etc/passwd.yml' };
            const resolved = path.resolve(profileCachePath(addr, SHA));
            expect(resolved.startsWith(path.join(home(), '.baker', 'cache', 'profiles'))).to.equal(true);
        });
    });
});

describe('check profile fetching', function() {
    const home = withTempHome();

    function addr(target) { return profileAddress(target); }

    it('fetches the sha-pinned raw url, never a branch name', async function() {
        const calls = [];
        await resolveProfile(addr('org/profiles:env.yml'), {
            raw: fakeGit(LS_REMOTE), fetchUrl: fakeFetch('- name: node\n', calls), print: quiet
        });
        expect(calls[0].url).to.equal(
            `https://raw.githubusercontent.com/org/profiles/${SHA}/env.yml`);
        expect(calls[0].url).to.not.contain('master');
        expect(calls[0].url).to.not.contain('main');
    });

    it('sends a User-Agent, which raw.githubusercontent requires', async function() {
        const calls = [];
        await resolveProfile(addr('org/profiles:env.yml'), {
            raw: fakeGit(LS_REMOTE), fetchUrl: fakeFetch('x', calls), print: quiet
        });
        expect(calls[0].headers).to.have.property('User-Agent', 'baker');
    });

    it('writes the profile to its content-addressed path and returns it', async function() {
        const dest = await resolveProfile(addr('org/profiles:env.yml'), {
            raw: fakeGit(LS_REMOTE), fetchUrl: fakeFetch('- name: node\n'), print: quiet
        });
        expect(dest).to.equal(profileCachePath(addr('org/profiles:env.yml'), SHA));
        expect(fs.readFileSync(dest, 'utf8')).to.equal('- name: node\n');
    });

    // AC-5: nested paths work. Broken in opunit, whose single String.replace
    // writer cannot create the intermediate directory.
    it('creates intermediate directories for a nested profile path', async function() {
        const dest = await resolveProfile(addr('org/profiles:units/unit-1.yml'), {
            raw: fakeGit(LS_REMOTE), fetchUrl: fakeFetch('- name: nested\n'), print: quiet
        });
        expect(dest.endsWith(path.join('units', 'unit-1.yml'))).to.equal(true);
        expect(fs.readFileSync(dest, 'utf8')).to.equal('- name: nested\n');
    });

    // AC-3: a ref resolves to that ref's sha.
    it('resolves a ref to its own sha', async function() {
        const calls = [];
        await resolveProfile(addr('org/profiles@unit-1:env.yml'), {
            raw: fakeGit(LS_REMOTE), fetchUrl: fakeFetch('x', calls), print: quiet
        });
        expect(calls[0].url).to.contain('2222222222222222222222222222222222222222');
    });

    // AC-8: content-addressed and reused.
    describe('AC-8: the cache is reused for the same commit', function() {
        it('fetches once and runs ls-remote twice across two runs', async function() {
            const gitCalls = [], fetchCalls = [];
            const deps = {
                raw: fakeGit(LS_REMOTE, gitCalls),
                fetchUrl: fakeFetch('- name: node\n', fetchCalls),
                print: quiet
            };
            const first = await resolveProfile(addr('org/profiles:env.yml'), deps);
            const second = await resolveProfile(addr('org/profiles:env.yml'), deps);

            expect(second).to.equal(first);
            expect(fetchCalls, 'a cache hit must not re-download').to.have.lengthOf(1);
            expect(gitCalls, 'ls-remote is what proves freshness and cannot be skipped')
                .to.have.lengthOf(2);
        });

        it('does not treat a directory at the cache path as a hit', async function() {
            // `repo:units.yml` and `repo:units.yml/one.yml` are both legal
            // addresses, and the second leaves a directory exactly where the
            // first expects its profile.
            const target = addr('org/profiles:units.yml');
            const dest = profileCachePath(target, SHA);
            fs.mkdirSync(dest, { recursive: true });

            let err;
            try {
                await resolveProfile(target, {
                    raw: fakeGit(LS_REMOTE), fetchUrl: fakeFetch('x'), print: quiet
                });
            } catch (e) { err = e; }
            expect(err, 'a directory must not be handed to opunit as a profile').to.be.an('error');
        });

        it('re-fetches when the sha changes', async function() {
            const fetchCalls = [];
            const moved = LS_REMOTE.replace(new RegExp(SHA, 'g'), 'c'.repeat(40));
            await resolveProfile(addr('org/profiles:env.yml'), {
                raw: fakeGit(LS_REMOTE), fetchUrl: fakeFetch('old', fetchCalls), print: quiet
            });
            await resolveProfile(addr('org/profiles:env.yml'), {
                raw: fakeGit(moved), fetchUrl: fakeFetch('new', fetchCalls), print: quiet
            });
            expect(fetchCalls).to.have.lengthOf(2);
        });
    });

    // AC-7: provenance.
    describe('AC-7: every run prints its provenance', function() {
        it('prints address, short sha, and the resolved default branch', async function() {
            const lines = [];
            await resolveProfile(addr('org/profiles:env.yml'), {
                raw: fakeGit(LS_REMOTE), fetchUrl: fakeFetch('x'), print: (m) => lines.push(m)
            });
            expect(lines).to.have.lengthOf(1);
            expect(lines[0]).to.equal(`Using profile org/profiles:env.yml @ ${SHA.slice(0, 7)} (main)`);
        });

        it('names the requested ref when one was given', async function() {
            const lines = [];
            await resolveProfile(addr('org/profiles@unit-1:env.yml'), {
                raw: fakeGit(LS_REMOTE), fetchUrl: fakeFetch('x'), print: (m) => lines.push(m)
            });
            expect(lines[0]).to.contain('(unit-1)');
        });

        it('prints on a cache hit too, so pasted output is always self-describing', async function() {
            const lines = [];
            const deps = { raw: fakeGit(LS_REMOTE), fetchUrl: fakeFetch('x'), print: (m) => lines.push(m) };
            await resolveProfile(addr('org/profiles:env.yml'), deps);
            await resolveProfile(addr('org/profiles:env.yml'), deps);
            expect(lines).to.have.lengthOf(2);
            expect(lines[1]).to.equal(lines[0]);
        });
    });

    // AC-12: a missing file distinguishes itself from a missing commit.
    it('names the file, the short sha, and the ref when the fetch 404s', async function() {
        const notFound = async (url) => { throw new Error(`Failed to fetch ${url}: HTTP 404`); };
        let msg = '';
        try {
            await resolveProfile(addr('org/profiles@unit-1:missing.yml'), {
                raw: fakeGit(LS_REMOTE), fetchUrl: notFound, print: quiet
            });
        } catch (e) { msg = e.message; }

        expect(msg).to.contain('missing.yml');
        expect(msg).to.contain('2222222');
        expect(msg).to.contain('unit-1');
        expect(msg).to.contain('404');
    });

    // AC-11: an unknown ref is named.
    it('names an unknown ref and the repository', async function() {
        let msg = '';
        try {
            await resolveProfile(addr('org/profiles@PM9:env.yml'), {
                raw: fakeGit(LS_REMOTE), fetchUrl: fakeFetch('x'), print: quiet
            });
        } catch (e) { msg = e.message; }
        expect(msg).to.contain('PM9');
        expect(msg).to.contain('org/profiles');
    });

    // AC-10: fails fast rather than prompting for credentials.
    it('passes GIT_TERMINAL_PROMPT=0 through to git', async function() {
        const calls = [];
        await resolveProfile(addr('org/profiles:env.yml'), {
            raw: fakeGit(LS_REMOTE, calls), fetchUrl: fakeFetch('x'), print: quiet
        });
        expect(calls[0].env).to.have.property('GIT_TERMINAL_PROMPT', '0');
    });

    // AC-19: a cache file is never partially written.
    describe('AC-19: writes are atomic', function() {
        it('leaves nothing at the content-addressed path when the fetch fails', async function() {
            const failing = async () => { throw new Error('socket hang up'); };
            const dest = profileCachePath(addr('org/profiles:env.yml'), SHA);
            try {
                await resolveProfile(addr('org/profiles:env.yml'), {
                    raw: fakeGit(LS_REMOTE), fetchUrl: failing, print: quiet
                });
            } catch (e) { /* expected */ }
            expect(fs.existsSync(dest), 'a failed fetch must leave no cache entry').to.equal(false);
        });

        it('re-fetches on the run after a failed one', async function() {
            const fetchCalls = [];
            const failing = async () => { throw new Error('socket hang up'); };
            try {
                await resolveProfile(addr('org/profiles:env.yml'), {
                    raw: fakeGit(LS_REMOTE), fetchUrl: failing, print: quiet
                });
            } catch (e) { /* expected */ }

            const dest = await resolveProfile(addr('org/profiles:env.yml'), {
                raw: fakeGit(LS_REMOTE), fetchUrl: fakeFetch('- name: retried\n', fetchCalls), print: quiet
            });
            expect(fetchCalls).to.have.lengthOf(1);
            expect(fs.readFileSync(dest, 'utf8')).to.equal('- name: retried\n');
        });

        it('leaves no temp file behind when the rename fails', async function() {
            // A write that cannot be renamed into place — the destination
            // directory is replaced by a file after mkdir would have run.
            const target = addr('org/profiles:env.yml');
            const dest = profileCachePath(target, SHA);
            fs.mkdirSync(path.dirname(path.dirname(dest)), { recursive: true });
            fs.writeFileSync(path.dirname(dest), 'not a directory');

            try {
                await resolveProfile(target, {
                    raw: fakeGit(LS_REMOTE), fetchUrl: fakeFetch('x'), print: quiet
                });
            } catch (e) { /* expected */ }

            expect(fs.existsSync(dest)).to.equal(false);
        });

        it('writes through a sibling temp file, not directly to the destination', async function() {
            // Blocks the temp path with a directory, so writeFile there fails.
            // A direct write to `dest` would sail past this and the test would
            // pass — which is the point: this is what fails if the temp+rename
            // is ever replaced by a plain write, and the crash-safety AC-19
            // describes cannot be simulated any other way.
            const target = addr('org/profiles:env.yml');
            const dest = profileCachePath(target, SHA);
            fs.mkdirSync(`${dest}.${process.pid}.tmp`, { recursive: true });

            let err;
            try {
                await resolveProfile(target, {
                    raw: fakeGit(LS_REMOTE), fetchUrl: fakeFetch('x'), print: quiet
                });
            } catch (e) { err = e; }

            expect(err, 'the write must go through the sibling temp path').to.be.an('error');
            expect(fs.existsSync(dest), 'and nothing lands at the destination').to.equal(false);
        });

        it('keeps the temp file beside the destination so the rename stays same-volume', async function() {
            const target = addr('org/profiles:env.yml');
            const dest = profileCachePath(target, SHA);
            await resolveProfile(target, {
                raw: fakeGit(LS_REMOTE), fetchUrl: fakeFetch('x'), print: quiet
            });
            // Nothing left over once the rename has happened.
            expect(fs.readdirSync(path.dirname(dest))).to.deep.equal(['env.yml']);
        });
    });

    // AC-1: a pushed profile takes effect on the very next run. Asserted on the
    // mechanism — the sha the fetch URL names — against a real repository, which
    // is deterministic. Asserting on content instead would have to prime a CDN
    // edge first, and would otherwise pass under the old code too.
    it('follows a new commit immediately, with no staleness window', async function() {
        const { execFileSync } = require('child_process');
        const work = fs.mkdtempSync(path.join(os.tmpdir(), 'baker-fresh-'));
        try {
            const repo = path.join(work, 'origin');
            fs.mkdirSync(repo);
            const run = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
            run('init', '--quiet', '--initial-branch', 'main');
            run('config', 'user.email', 'test@example.com');
            run('config', 'user.name', 'Baker Test');
            fs.writeFileSync(path.join(repo, 'env.yml'), '- name: before\n');
            run('add', '-A'); run('commit', '--quiet', '-m', 'first');

            const target = { owner: 'org', repo: 'profiles', cloneUrl: `file://${repo}`,
                             file: 'env.yml', ref: null };
            // Serves whatever the sha in the URL says, so the assertion is on
            // which commit was requested.
            const urls = [];
            const serve = async (url) => { urls.push(url); return `sha:${url.split('/')[5]}\n`; };

            const first = await resolveProfile(target, { fetchUrl: serve, print: quiet });

            fs.writeFileSync(path.join(repo, 'env.yml'), '- name: after\n');
            run('add', '-A'); run('commit', '--quiet', '-m', 'second');
            const secondSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim();

            const second = await resolveProfile(target, { fetchUrl: serve, print: quiet });

            expect(second, 'the new commit must not reuse the old cache entry').to.not.equal(first);
            expect(second).to.contain(secondSha);
            expect(urls[1], 'the fetch must name the just-committed sha').to.contain(secondSha);
        } finally {
            fs.rmSync(work, { recursive: true, force: true });
        }
    });

    // AC-18: the seams are injected, not globally replaced.
    it('leaves Git.raw and Git.fetchUrl untouched', function() {
        expect(Git.raw).to.be.a('function');
        expect(Git.fetchUrl).to.be.a('function');
        expect(Git.raw.name).to.equal('raw');
        expect(Git.fetchUrl.name).to.equal('fetchUrl');
    });

    it('defaults every seam to the real one when deps are omitted', async function() {
        // Exercises the production wiring — no `fetchUrl` and no `print` supplied
        // — against a cache hit, so the real fetch is never reached and the test
        // stays offline. Without this the defaults are the one part of
        // resolveProfile that only ever runs outside the suite.
        const target = addr('org/profiles:env.yml');
        const dest = profileCachePath(target, SHA);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, '- name: cached\n');

        expect(await resolveProfile(target, { raw: fakeGit(LS_REMOTE) })).to.equal(dest);
    });

    it('runs with no deps argument at all, using every real seam', async function() {
        // The production call shape: resolveProfile(addr). Kept offline by
        // pointing the clone url at a local repo and priming the cache for the
        // sha it resolves to, so the real fetch is never reached.
        const { execFileSync } = require('child_process');
        const work = fs.mkdtempSync(path.join(os.tmpdir(), 'baker-nodeps-'));
        try {
            const repo = path.join(work, 'origin');
            fs.mkdirSync(repo);
            const run = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
            run('init', '--quiet', '--initial-branch', 'main');
            run('config', 'user.email', 'test@example.com');
            run('config', 'user.name', 'Baker Test');
            fs.writeFileSync(path.join(repo, 'env.yml'), '- name: real\n');
            run('add', '-A'); run('commit', '--quiet', '-m', 'initial');
            const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim();

            const target = { owner: 'org', repo: 'profiles', cloneUrl: `file://${repo}`,
                             file: 'env.yml', ref: null };
            const dest = profileCachePath(target, sha);
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.writeFileSync(dest, '- name: primed\n');

            expect(await resolveProfile(target)).to.equal(dest);
        } finally {
            fs.rmSync(work, { recursive: true, force: true });
        }
    });

    it('uses the real Git.raw when none is injected', async function() {
        // Injection must be a test seam, not a second code path: with no `raw`
        // supplied the default has to be the real one. Pointed at a local repo
        // over file:// so this exercises real git without a network call.
        const { execFileSync } = require('child_process');
        const work = fs.mkdtempSync(path.join(os.tmpdir(), 'baker-profile-'));
        try {
            const repo = path.join(work, 'origin');
            fs.mkdirSync(repo);
            const run = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
            run('init', '--quiet', '--initial-branch', 'main');
            run('config', 'user.email', 'test@example.com');
            run('config', 'user.name', 'Baker Test');
            fs.writeFileSync(path.join(repo, 'env.yml'), '- name: real\n');
            run('add', '-A');
            run('commit', '--quiet', '-m', 'initial');

            const lines = [];
            await resolveProfile(
                { owner: 'org', repo: 'profiles', cloneUrl: `file://${repo}`, file: 'env.yml', ref: null },
                { fetchUrl: fakeFetch('- name: real\n'), print: (m) => lines.push(m) }
            );
            expect(lines[0]).to.contain('(main)');
            expect(lines[0]).to.match(/@ [0-9a-f]{7} /);
        } finally {
            fs.rmSync(work, { recursive: true, force: true });
        }
    });
});
