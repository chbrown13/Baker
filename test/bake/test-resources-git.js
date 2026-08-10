const chai = require('chai');
const expect = chai.expect;

const fs   = require('fs-extra');
const os   = require('os');
const path = require('path');
const child_process = require('child_process');

const Git = require('../../lib/bakelets/resources/git');

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
