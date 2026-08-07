const child_process = require('child_process');
const EventEmitter = require('events');
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
let spawnCalls = [];
let stubActive = false;
const origSpawn = child_process.spawn;
child_process.spawn = function(cmd, args, opts) {
    if (!stubActive) return origSpawn.apply(child_process, arguments);
    spawnCalls.push({ cmd, args, opts });
    const fake = new EventEmitter();
    // Resolve the command's promise on the next tick, after runOpunit()
    // has attached its 'close'/'error' listeners.
    process.nextTick(() => fake.emit('close', 0));
    return fake;
};

const check = require('../../lib/commands/check');

after(function() {
    child_process.spawn = origSpawn;
});

describe('check command', function() {
    before(function() {
        stubActive = true;
    });

    after(function() {
        stubActive = false;
    });

    beforeEach(function() {
        spawnCalls = [];
    });

    it('should register as "check [target]"', function() {
        expect(check.command).to.equal('check [target]');
    });

    it('should delegate to `opunit verify local` when no target is given', async function() {
        await check.handler({});
        expect(spawnCalls).to.have.lengthOf(1);
        expect(spawnCalls[0].cmd).to.equal('opunit');
        expect(spawnCalls[0].args).to.deep.equal(['verify', 'local']);
    });

    it('should delegate to `opunit profile <address>` for a profile address', async function() {
        await check.handler({ target: 'your-org/profiles:env.yml' });
        expect(spawnCalls).to.have.lengthOf(1);
        expect(spawnCalls[0].args).to.deep.equal(['profile', 'your-org/profiles:env.yml']);
    });

    // These used to assert a silent fall-through to local mode. That reported a
    // DIFFERENT check's result as the requested one, so an unrunnable target is
    // now an error and opunit is never spawned.
    it('should refuse a bare name rather than running local checks', async function() {
        await check.handler({ target: 'my-vm' });
        expect(spawnCalls, 'opunit must not be spawned for a refused target').to.have.lengthOf(0);
    });

    it('should refuse an ssh-style address rather than running local checks', async function() {
        await check.handler({ target: 'user@192.168.1.10' });
        expect(spawnCalls).to.have.lengthOf(0);
    });

    it('should inherit stdio so opunit output streams through', async function() {
        await check.handler({ target: 'your-org/profiles:env.yml' });
        expect(spawnCalls[0].opts).to.have.property('stdio', 'inherit');
    });

    // AC-8: the source-addressing split must not move `check`. Its grammar is the
    // :file.yml form, which stays exactly as it was — only `bake` narrowed.
    describe('AC-8: unchanged by the source-addressing split', function() {
        it('still passes a :file.yml profile address through verbatim', async function() {
            await check.handler({ target: 'your-org/profiles:units/one.yml' });
            expect(spawnCalls[0].args).to.deep.equal(['profile', 'your-org/profiles:units/one.yml']);
        });

        it('still accepts a .yaml profile address', async function() {
            await check.handler({ target: 'your-org/profiles:env.yaml' });
            expect(spawnCalls[0].args).to.deep.equal(['profile', 'your-org/profiles:env.yaml']);
        });

        it('refuses a directory address — that form belongs to bake', async function() {
            await check.handler({ target: 'your-org/configs:units/one' });
            expect(spawnCalls, 'a bake-shaped address must not run local checks').to.have.lengthOf(0);
        });
    });
});

describe('check refuses a target it cannot run as a profile', function() {
    // An unrecognised target used to fall through to `opunit verify local`,
    // running a DIFFERENT check and reporting its result as the requested one.
    const { opunitArgs } = require('../../lib/commands/check');

    it('runs local checks only when no target is given', function() {
        expect(opunitArgs(undefined)).to.deep.equal(['verify', 'local']);
    });

    it('runs a profile for a root-level .yml address', function() {
        expect(opunitArgs('org/profiles:env.yml')).to.deep.equal(['profile', 'org/profiles:env.yml']);
    });

    it('runs a profile for a nested .yml address', function() {
        expect(opunitArgs('org/profiles:units/PM3.yml'))
            .to.deep.equal(['profile', 'org/profiles:units/PM3.yml']);
    });

    it('accepts a .yaml extension', function() {
        expect(opunitArgs('org/profiles:env.yaml')[0]).to.equal('profile');
    });

    it('refuses a repository with no file', function() {
        expect(() => opunitArgs('org/profiles')).to.throw(/not an opunit profile address/);
    });

    it('refuses a sub-directory address', function() {
        expect(() => opunitArgs('org/profiles:units/one')).to.throw(/not an opunit profile address/);
    });

    it('refuses an unparseable target instead of silently running local checks', function() {
        expect(() => opunitArgs('org/profiles:PM3.yml@PM3')).to.throw(/not an opunit profile address/);
    });

    it('refuses a local path', function() {
        expect(() => opunitArgs('./some/path')).to.throw(/not an opunit profile address/);
    });

    it('never substitutes local mode for a target that was given', function() {
        // The regression this guards: any of these returning ['verify','local']
        // would report a passing local check as though the profile had passed.
        ['org/profiles', 'org/profiles:units/one', 'garbage', './x'].forEach((t) => {
            let args = null;
            try { args = opunitArgs(t); } catch (e) { /* expected */ }
            expect(args, `${t} must not fall through to local mode`).to.be.null;
        });
    });

    describe('refs', function() {
        // opunit 0.9.4 builds raw.githubusercontent.com/<repo>/master/<file> —
        // the branch is hardcoded, so a ref cannot be honoured.
        it('refuses a ref on a profile address', function() {
            expect(() => opunitArgs('org/profiles@PM3:env.yml'))
                .to.throw(/opunit profiles do not support/);
        });

        it('explains that opunit reads from master', function() {
            expect(() => opunitArgs('org/profiles@PM3:env.yml')).to.throw(/master branch/);
        });

        it('suggests the address without the ref', function() {
            let msg = '';
            try { opunitArgs('org/profiles@PM3:env.yml'); } catch (e) { msg = e.message; }
            expect(msg).to.contain('baker check org/profiles:env.yml');
        });
    });
});
