const child_process = require('child_process');
const fs     = require('fs-extra');
const os     = require('os');
const path   = require('path');
const chai   = require('chai');
const expect = chai.expect;

const Platform = require('../../lib/modules/platform');
const resolve  = require('../../lib/bakelets/resolve');

const BAKELETS_PATH = path.join(__dirname, '../../lib/bakelets');
const REMOTES_PATH  = path.join(__dirname, '../../remotes');

// execCapture stub driven by a command -> response map. Anything not in the map
// rejects, mirroring a non-zero exit. Records every command so a test can assert
// that a branch never touched the transport at all (AC-5).
function stubExec(responses = {}) {
    const calls = [];
    const fn = async (cmd) => {
        calls.push(cmd);
        const value = responses[cmd];
        if (value === undefined) throw new Error(`command failed: ${cmd}`);
        if (value instanceof Error) throw value;
        return value;
    };
    fn.calls = calls;
    return fn;
}

// Shorthand for an os-release payload keyed by the command detect() issues.
function withOsRelease(text, extra = {}) {
    return stubExec(Object.assign({ 'cat /etc/os-release': text }, extra));
}

function found(bin) {
    return { [`command -v ${bin}`]: `/usr/bin/${bin}\n` };
}

describe('Platform detection', function() {

    describe('Platform.parseOsRelease (pure)', function() {

        it('reads an unquoted value', function() {
            expect(Platform.parseOsRelease('ID=fedora').ID).to.equal('fedora');
        });

        it('strips double quotes from a value', function() {
            expect(Platform.parseOsRelease('ID="fedora"').ID).to.equal('fedora');
        });

        it('strips single quotes from a value', function() {
            expect(Platform.parseOsRelease("ID='fedora'").ID).to.equal('fedora');
        });

        it('keeps interior spaces in a quoted multi-word value', function() {
            expect(Platform.parseOsRelease('ID_LIKE="ubuntu debian"').ID_LIKE).to.equal('ubuntu debian');
        });

        it('does not strip an unbalanced quote', function() {
            expect(Platform.parseOsRelease('PRETTY_NAME="unterminated').PRETTY_NAME).to.equal('"unterminated');
        });

        it('ignores comments and blank lines', function() {
            const fields = Platform.parseOsRelease('# a comment\n\nID=alpine\n');
            expect(fields).to.deep.equal({ ID: 'alpine' });
        });

        it('ignores malformed lines rather than throwing', function() {
            expect(Platform.parseOsRelease('this is not a field\nID=arch')).to.deep.equal({ ID: 'arch' });
        });

        it('returns an empty object for empty, null, or undefined input', function() {
            expect(Platform.parseOsRelease('')).to.deep.equal({});
            expect(Platform.parseOsRelease(null)).to.deep.equal({});
            expect(Platform.parseOsRelease(undefined)).to.deep.equal({});
        });

        it('keeps an = inside a value', function() {
            // os-release values legitimately contain '=' (HOME_URL, CPE_NAME).
            expect(Platform.parseOsRelease('CPE_NAME="cpe:/o:fedoraproject:fedora:43"').CPE_NAME)
                .to.equal('cpe:/o:fedoraproject:fedora:43');
        });

        it('reads every field, not only the ones detect uses', function() {
            const fields = Platform.parseOsRelease('ID=ubuntu\nVERSION_ID="24.04"\nNAME=Ubuntu');
            expect(fields).to.deep.equal({ ID: 'ubuntu', VERSION_ID: '24.04', NAME: 'Ubuntu' });
        });
    });

    describe('Platform.familyOf (pure)', function() {

        it('maps every supported manager to a family', function() {
            ['apt', 'dnf', 'pacman', 'zypper', 'apk', 'brew', 'choco'].forEach((manager) => {
                expect(Platform.familyOf(manager), manager).to.be.a('string');
            });
        });

        it('returns undefined for an unknown manager', function() {
            expect(Platform.familyOf('nix')).to.equal(undefined);
        });

        it('exposes the Linux managers as a defensive copy', function() {
            const first = Platform.linuxManagers;
            first.push('nix');
            expect(Platform.linuxManagers).to.deep.equal(['apt', 'dnf', 'pacman', 'zypper', 'apk']);
        });
    });

    describe('Platform.probe', function() {

        it('returns the manager whose binary is present', async function() {
            expect(await Platform.probe(stubExec(found('pacman')))).to.equal('pacman');
        });

        it('returns null when no manager binary is present', async function() {
            expect(await Platform.probe(stubExec({}))).to.equal(null);
        });

        it('treats empty output as absent, not present', async function() {
            expect(await Platform.probe(stubExec({ 'command -v apt-get': '   \n' }))).to.equal(null);
        });

        it('prefers the earlier probe when two managers are present', async function() {
            const exec = stubExec(Object.assign(found('apt-get'), found('dnf')));
            expect(await Platform.probe(exec)).to.equal('apt');
        });

        it('stops probing once a manager is found', async function() {
            const exec = stubExec(found('apt-get'));
            await Platform.probe(exec);
            expect(exec.calls).to.deep.equal(['command -v apt-get']);
        });

        it('probes every candidate before giving up', async function() {
            const exec = stubExec({});
            await Platform.probe(exec);
            expect(exec.calls).to.deep.equal([
                'command -v apt-get', 'command -v dnf', 'command -v pacman',
                'command -v zypper', 'command -v apk'
            ]);
        });
    });

    describe('Platform.detect', function() {

        it('resolves dnf from ID=fedora (AC-1)', async function() {
            const platform = await Platform.detect(withOsRelease('ID=fedora'), 'linux');
            expect(platform).to.deep.equal({ os: 'linux', manager: 'dnf', shell: 'sh', family: 'rhel' });
        });

        it('resolves apt from ID=ubuntu', async function() {
            const platform = await Platform.detect(withOsRelease('ID=ubuntu'), 'linux');
            expect(platform.manager).to.equal('apt');
            expect(platform.family).to.equal('debian');
        });

        it('falls back to ID_LIKE for an unknown derivative (AC-2)', async function() {
            const exec = withOsRelease('ID=pop\nID_LIKE="ubuntu debian"');
            const platform = await Platform.detect(exec, 'linux');
            expect(platform.manager).to.equal('apt');
        });

        it('does not probe binaries when ID_LIKE answers (AC-2)', async function() {
            const exec = withOsRelease('ID=rocky\nID_LIKE="rhel centos fedora"');
            await Platform.detect(exec, 'linux');
            expect(exec.calls).to.deep.equal(['cat /etc/os-release']);
        });

        it('prefers ID over ID_LIKE when both are known', async function() {
            // Manjaro reports ID_LIKE=arch; the ID is the more specific answer
            // and must win, or a distro whose ID_LIKE lies would be mis-detected.
            const platform = await Platform.detect(withOsRelease('ID=alpine\nID_LIKE=debian'), 'linux');
            expect(platform.manager).to.equal('apk');
        });

        it('matches IDs case-insensitively', async function() {
            const platform = await Platform.detect(withOsRelease('ID=Fedora'), 'linux');
            expect(platform.manager).to.equal('dnf');
        });

        it('probes binaries when /etc/os-release is missing (AC-3)', async function() {
            const platform = await Platform.detect(stubExec(found('apk')), 'linux');
            expect(platform.manager).to.equal('apk');
        });

        it('probes binaries when os-release has no usable ID (AC-3)', async function() {
            const exec = withOsRelease('PRETTY_NAME="Some Linux"', found('zypper'));
            expect((await Platform.detect(exec, 'linux')).manager).to.equal('zypper');
        });

        it('throws naming the detected ID when nothing resolves (AC-4)', async function() {
            let error = null;
            try {
                await Platform.detect(withOsRelease('ID=exotic'), 'linux');
            } catch (err) { error = err; }

            expect(error).to.be.an('error');
            expect(error.message).to.contain('exotic');
        });

        it('names every supported Linux manager in the error (AC-4)', async function() {
            let error = null;
            try {
                await Platform.detect(withOsRelease('ID=exotic'), 'linux');
            } catch (err) { error = err; }

            ['apt', 'dnf', 'pacman', 'zypper', 'apk'].forEach((manager) => {
                expect(error.message, manager).to.contain(manager);
            });
        });

        it('points at docker: and remote: as the alternative (AC-4)', async function() {
            let error = null;
            try {
                await Platform.detect(stubExec({}), 'linux');
            } catch (err) { error = err; }

            expect(error.message).to.contain('docker:');
            expect(error.message).to.contain('remote:');
        });

        it('reports ID=unknown when os-release is missing entirely (AC-4)', async function() {
            let error = null;
            try {
                await Platform.detect(stubExec({}), 'linux');
            } catch (err) { error = err; }

            expect(error.message).to.contain('ID=unknown');
        });

        it('resolves Windows to choco and powershell (AC-5)', async function() {
            const platform = await Platform.detect(stubExec({}), 'win32');
            expect(platform).to.deep.equal({ os: 'windows', manager: 'choco', shell: 'powershell', family: 'nt' });
        });

        it('resolves macOS to brew and sh (AC-5)', async function() {
            const platform = await Platform.detect(stubExec({}), 'darwin');
            expect(platform).to.deep.equal({ os: 'macos', manager: 'brew', shell: 'sh', family: 'darwin' });
        });

        it('issues no exec call at all on Windows or macOS (AC-5)', async function() {
            const win = stubExec({});
            const mac = stubExec({});
            await Platform.detect(win, 'win32');
            await Platform.detect(mac, 'darwin');
            expect(win.calls).to.deep.equal([]);
            expect(mac.calls).to.deep.equal([]);
        });

        it('treats an unrecognised platform string as Linux', async function() {
            // freebsd/sunos reach the Linux path rather than silently becoming
            // Windows; they then fail detection with the actionable message.
            const platform = await Platform.detect(withOsRelease('ID=debian'), 'freebsd');
            expect(platform.os).to.equal('linux');
        });

        it('detects the target, not the host, when told so (AC-6)', async function() {
            // A macOS laptop baking into an Ubuntu container: the caller passes
            // 'linux' because the container is what gets provisioned.
            const platform = await Platform.detect(withOsRelease('ID=ubuntu'), 'linux');
            expect(platform.manager).to.equal('apt');
        });

        it('defaults platformName to the running process platform', async function() {
            const expected = process.platform === 'win32' ? 'windows'
                : process.platform === 'darwin' ? 'macos' : 'linux';
            const platform = await Platform.detect(withOsRelease('ID=debian'));
            expect(platform.os).to.equal(expected);
        });
    });
});

// Detection reaching bakelets through the real resolver, driven end to end via
// resolveBakelet — the public entry — rather than by reaching into the module.
describe('resolve.js platform plumbing', function() {
    let bakeDir;
    let origExecSync;

    beforeEach(async function() {
        bakeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'baker-platform-'));
        origExecSync = child_process.execSync;
    });

    afterEach(async function() {
        child_process.execSync = origExecSync;
        await fs.remove(bakeDir).catch(() => {});
    });

    // Records every command and answers the os-release probe, so a docker-mode
    // bake runs to completion without a container.
    function stubExecSync(osReleaseText) {
        const calls = [];
        child_process.execSync = (cmd, opts) => {
            calls.push({ cmd, opts });
            if (cmd.includes('/etc/os-release')) return osReleaseText;
            return '';
        };
        return calls;
    }

    it('detects the container, not the macOS host, in docker mode (AC-6)', async function() {
        const calls = stubExecSync('ID=ubuntu\n');

        await resolve.resolveBakelet(
            BAKELETS_PATH, REMOTES_PATH,
            { name: 'plat-docker', env: [{ FOO: 'bar' }] },
            bakeDir, false, null, null, 'test-container'
        );

        // POSIX output proves apt/sh was resolved from the container's
        // os-release rather than from whatever the operator is running.
        const issued = calls.map((c) => c.cmd).join('\n');
        expect(issued).to.contain('export FOO="bar"');
        expect(issued).to.not.contain('SetEnvironmentVariable');
    });

    it('detects exactly once no matter how many bakelets ask (AC-7)', async function() {
        const calls = stubExecSync('ID=ubuntu\n');

        await resolve.resolveBakelet(
            BAKELETS_PATH, REMOTES_PATH,
            {
                name: 'plat-once',
                tools: ['opencode', 'claude-code'],
                env: [{ FOO: 'bar' }]
            },
            bakeDir, false, null, null, 'test-container'
        );

        const probes = calls.filter((c) => c.cmd.includes('/etc/os-release'));
        expect(probes).to.have.lengthOf(1);
    });

    it('does not detect at all when no bakelet needs a platform', async function() {
        const calls = stubExecSync('ID=ubuntu\n');

        await resolve.resolveBakelet(
            BAKELETS_PATH, REMOTES_PATH,
            { name: 'plat-none', start: 'true' },
            bakeDir, false, null, null, 'test-container'
        );

        expect(calls.filter((c) => c.cmd.includes('/etc/os-release'))).to.have.lengthOf(0);
    });

    it('runs local commands through PowerShell on Windows (AC-14)', async function() {
        const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        const calls = stubExecSync('');

        try {
            await resolve.resolveBakelet(
                BAKELETS_PATH, REMOTES_PATH,
                { name: 'plat-win', local: bakeDir, env: [{ FOO: 'bar' }] },
                bakeDir, false, bakeDir
            );
        } finally {
            Object.defineProperty(process, 'platform', descriptor);
        }

        expect(calls.length).to.be.greaterThan(0);
        calls.forEach((c) => expect(c.opts.shell).to.equal('powershell.exe'));
        // Windows detection needs no probe, and env: takes the PowerShell path.
        expect(calls.map((c) => c.cmd).join('\n')).to.contain('SetEnvironmentVariable');
    });

    it('runs local commands through the default shell off Windows (AC-14)', async function() {
        const calls = stubExecSync('ID=fedora\n');

        await resolve.resolveBakelet(
            BAKELETS_PATH, REMOTES_PATH,
            { name: 'plat-nix', local: bakeDir, env: [{ FOO: 'bar' }] },
            bakeDir, false, bakeDir
        );

        calls.forEach((c) => expect(c.opts.shell).to.equal(undefined));
    });

    // execCapture is the new transport member: the local shim used to discard
    // stdout entirely. These two prove it round-trips, by observing that
    // detection can and cannot read os-release back.
    it('reads os-release back through the local transport (execCapture)', async function() {
        stubExecSync('ID=fedora\n');

        // Resolves without throwing only if execCapture returned the stub's
        // output; an undefined return falls through to the probe, which fails.
        await resolve.resolveBakelet(
            BAKELETS_PATH, REMOTES_PATH,
            { name: 'plat-capture', local: bakeDir, env: [{ FOO: 'bar' }] },
            bakeDir, false, bakeDir
        );
    });

    it('surfaces the unsupported-distribution error through a bake', async function() {
        // Nothing readable: no os-release, no manager binary.
        child_process.execSync = () => '';

        let error = null;
        try {
            await resolve.resolveBakelet(
                BAKELETS_PATH, REMOTES_PATH,
                { name: 'plat-unknown', local: bakeDir, env: [{ FOO: 'bar' }] },
                bakeDir, false, bakeDir
            );
        } catch (err) { error = err; }

        expect(String(error)).to.contain('Unsupported Linux distribution');
        expect(String(error)).to.contain('docker:');
    });
});
