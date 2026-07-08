const child_process = require('child_process');
const EventEmitter = require('events');
const chai = require('chai');
const expect = chai.expect;

// Stub child_process.spawn BEFORE requiring the command, since check.js
// captures the `spawn` reference at module load via destructuring.
let spawnCalls = [];
const origSpawn = child_process.spawn;
child_process.spawn = function(cmd, args, opts) {
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
        await check.handler({ target: 'chbrown13/profile:5704.yml' });
        expect(spawnCalls).to.have.lengthOf(1);
        expect(spawnCalls[0].args).to.deep.equal(['profile', 'chbrown13/profile:5704.yml']);
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
        await check.handler({ target: 'chbrown13/profile:5704.yml' });
        expect(spawnCalls[0].opts).to.have.property('stdio', 'inherit');
    });
});
