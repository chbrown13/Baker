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

    it('should treat a bare name as local verify, not a profile', async function() {
        await check.handler({ target: 'my-vm' });
        expect(spawnCalls[0].args).to.deep.equal(['verify', 'local']);
    });

    it('should treat an ssh-style address as local verify, not a profile', async function() {
        await check.handler({ target: 'user@192.168.1.10' });
        expect(spawnCalls[0].args).to.deep.equal(['verify', 'local']);
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

        it('treats a directory address as local verify — that form belongs to bake', async function() {
            await check.handler({ target: 'your-org/configs:units/one' });
            expect(spawnCalls[0].args).to.deep.equal(['verify', 'local']);
        });
    });
});
