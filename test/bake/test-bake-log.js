const child_process = require('child_process');
const fs     = require('fs-extra');
const os     = require('os');
const path   = require('path');
const chai   = require('chai');
const expect = chai.expect;

const BakeLog = require('../../lib/modules/bake-log');
const resolve = require('../../lib/bakelets/resolve');

const BAKELETS_PATH = path.join(__dirname, '../../lib/bakelets');
const REMOTES_PATH  = path.join(__dirname, '../../remotes');

// BakeLog.logPath() reads os.homedir() on every call, so pointing HOME at a
// temp dir keeps every test here off the real ~/.baker.
function withTempHome() {
    let tmpHome, origHome;
    beforeEach(function() {
        origHome = process.env.HOME;
        tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'baker-log-home-'));
        process.env.HOME = tmpHome;
    });
    afterEach(function() {
        if (origHome === undefined) delete process.env.HOME;
        else process.env.HOME = origHome;
        fs.removeSync(tmpHome);
    });
    return () => tmpHome;
}

describe('bake failure reporting', function() {

    describe('secret collection', function() {

        it('collects env: values', function() {
            const secrets = BakeLog.collectSecrets({ env: [{ TOKEN: 'sk-livekey123' }] });
            expect(secrets).to.deep.equal(['sk-livekey123']);
        });

        it('collects from several entries', function() {
            const secrets = BakeLog.collectSecrets({ env: [{ A: 'first-value' }, { B: 'second-value' }] });
            expect(secrets).to.have.lengthOf(2);
        });

        it('skips very short values, which identify nothing and would shred output', function() {
            const secrets = BakeLog.collectSecrets({ env: [{ PORT: '80' }, { DEBUG: 'on' }] });
            expect(secrets).to.deep.equal([]);
        });

        it('returns nothing for a doc with no env', function() {
            expect(BakeLog.collectSecrets({})).to.deep.equal([]);
            expect(BakeLog.collectSecrets(null)).to.deep.equal([]);
        });
    });

    describe('redaction (AC-31)', function() {

        it('replaces a secret with ***', function() {
            expect(BakeLog.redact('token=sk-abc12345 rest', ['sk-abc12345']))
                .to.equal('token=*** rest');
        });

        it('replaces every occurrence', function() {
            expect(BakeLog.redact('a sk-abc12345 b sk-abc12345', ['sk-abc12345']))
                .to.equal('a *** b ***');
        });

        it('redacts the longer secret first, so no fragment survives', function() {
            // 'sk-abc' is a prefix of 'sk-abcdef'. Shortest-first would leave
            // '***def' on the page, revealing part of the longer secret.
            expect(BakeLog.redact('value sk-abcdef here', ['sk-abc', 'sk-abcdef']))
                .to.equal('value *** here');
        });

        it('leaves text without secrets untouched', function() {
            expect(BakeLog.redact('nothing to hide', ['sk-abc12345'])).to.equal('nothing to hide');
        });

        it('handles empty, null, and undefined input', function() {
            expect(BakeLog.redact('', ['x'])).to.equal('');
            expect(BakeLog.redact(null, ['x'])).to.equal('');
            expect(BakeLog.redact(undefined, ['x'])).to.equal('');
        });
    });

    describe('failure message (AC-29)', function() {

        it('names the bakelet and the manager', function() {
            const msg = BakeLog.describeFailure({ bakeletName: 'system', manager: 'pacman' });
            expect(msg).to.contain('system');
            expect(msg).to.contain('pacman');
        });

        it('suggests per-manager names for a packages failure', function() {
            const msg = BakeLog.describeFailure({ bakeletName: 'system', manager: 'pacman' });
            expect(msg).to.contain('Package names differ between systems');
            expect(msg).to.contain('apt: fd-find');
        });

        it('does not offer package advice for an unrelated bakelet', function() {
            const msg = BakeLog.describeFailure({ bakeletName: 'opencode', manager: 'apt' });
            expect(msg).to.not.contain('Package names differ');
        });

        it('points at the log', function() {
            const msg = BakeLog.describeFailure({ bakeletName: 'system' });
            expect(msg).to.contain('bake.log');
        });

        it('keeps the raw output below the explanation', function() {
            const msg = BakeLog.describeFailure({
                bakeletName: 'system', manager: 'pacman',
                output: 'error: target not found: fd-find'
            });
            expect(msg).to.contain('target not found');
            expect(msg.indexOf('system')).to.be.lessThan(msg.indexOf('target not found'));
        });

        it('redacts secrets from the terminal message too (AC-31)', function() {
            const msg = BakeLog.describeFailure({
                bakeletName: 'env', command: 'export TOKEN="sk-livekey123"',
                output: 'failed with sk-livekey123', secrets: ['sk-livekey123']
            });
            expect(msg).to.not.contain('sk-livekey123');
            expect(msg).to.contain('***');
        });
    });

    describe('the log file (AC-30)', function() {
        const home = withTempHome();

        it('lives under ~/.baker', function() {
            expect(BakeLog.logPath()).to.equal(path.join(home(), '.baker', 'bake.log'));
        });

        it('records the bakelet, command, exit code, and output', async function() {
            await BakeLog.append({
                bakeletName: 'system', command: 'sudo pacman -S fd-find',
                exitCode: 1, output: 'error: target not found'
            });

            const log = await fs.readFile(BakeLog.logPath(), 'utf8');
            expect(log).to.contain('system');
            expect(log).to.contain('sudo pacman -S fd-find');
            expect(log).to.contain('exit: 1');
            expect(log).to.contain('target not found');
        });

        it('appends rather than overwriting', async function() {
            await BakeLog.append({ bakeletName: 'first', output: 'one' });
            await BakeLog.append({ bakeletName: 'second', output: 'two' });

            const log = await fs.readFile(BakeLog.logPath(), 'utf8');
            expect(log).to.contain('first');
            expect(log).to.contain('second');
        });

        it('redacts secrets on the way in (AC-31)', async function() {
            await BakeLog.append({
                bakeletName: 'env', command: 'export TOKEN="sk-livekey123"',
                output: 'boom sk-livekey123', secrets: ['sk-livekey123']
            });

            const log = await fs.readFile(BakeLog.logPath(), 'utf8');
            expect(log).to.not.contain('sk-livekey123');
            expect(log).to.contain('***');
        });

        it('creates ~/.baker when it does not exist', async function() {
            expect(await fs.pathExists(path.join(home(), '.baker'))).to.equal(false);
            await BakeLog.append({ bakeletName: 'x', output: 'y' });
            expect(await fs.pathExists(BakeLog.logPath())).to.equal(true);
        });

        it('never throws when the log cannot be written', async function() {
            // A file where the directory should be: appending is impossible.
            await fs.outputFile(path.join(home(), '.baker'), 'not a directory');
            expect(await BakeLog.append({ bakeletName: 'x', output: 'y' })).to.equal(false);
        });
    });

    describe('through a real bake', function() {
        const home = withTempHome();
        let bakeDir;
        let origExecSync;

        beforeEach(async function() {
            bakeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'baker-logbake-'));
            origExecSync = child_process.execSync;
        });

        afterEach(async function() {
            child_process.execSync = origExecSync;
            await fs.remove(bakeDir).catch(() => {});
        });

        it('wraps a failing install and writes the log (AC-29, AC-30)', async function() {
            child_process.execSync = (cmd) => {
                if (cmd.includes('/etc/os-release')) return 'ID=arch\n';
                if (cmd.includes('pacman')) {
                    const err = new Error('Command failed');
                    err.stderr = 'error: target not found: fd-find';
                    err.status = 1;
                    throw err;
                }
                return '';
            };

            let error = null;
            try {
                await resolve.resolveBakelet(
                    BAKELETS_PATH, REMOTES_PATH,
                    { name: 'logbake', local: bakeDir, packages: ['fd-find'] },
                    bakeDir, false, bakeDir
                );
            } catch (err) { error = err; }

            expect(String(error)).to.contain('pacman');
            expect(String(error)).to.contain('Package names differ');

            const log = await fs.readFile(BakeLog.logPath(), 'utf8');
            expect(log).to.contain('target not found');
        });

        it('keeps an env: secret out of both the error and the log (AC-31)', async function() {
            child_process.execSync = (cmd) => {
                if (cmd.includes('/etc/os-release')) return 'ID=ubuntu\n';
                const err = new Error('Command failed');
                err.stderr = `writing sk-livekey123 failed`;
                err.status = 2;
                throw err;
            };

            let error = null;
            try {
                await resolve.resolveBakelet(
                    BAKELETS_PATH, REMOTES_PATH,
                    { name: 'logsecret', local: bakeDir, env: [{ TOKEN: 'sk-livekey123' }] },
                    bakeDir, false, bakeDir
                );
            } catch (err) { error = err; }

            expect(String(error)).to.not.contain('sk-livekey123');
            const log = await fs.readFile(BakeLog.logPath(), 'utf8');
            expect(log).to.not.contain('sk-livekey123');
            expect(log).to.contain('***');
        });
    });
});
