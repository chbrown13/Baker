const fs     = require('fs');
const path   = require('path');
const chai   = require('chai');
const expect = chai.expect;

const Bakelet     = require('../../lib/bakelets/bakelet');
const AgenticTool = require('../../lib/bakelets/tools/agentic-tool');

const BAKELETS_DIR = path.join(__dirname, '../../lib/bakelets');

// Sections whose bakelets stay playbook-backed and Linux-targeted. The
// cross-platform tier split keeps these on Ansible deliberately, so a command
// table appearing here would mean a bakelet drifted across the tier boundary.
const LINUX_TIER = ['lang', 'services'];
const PORTABLE_TIER = ['tools', 'config', 'packages', 'resources', 'env'];

const KNOWN_MANAGERS = ['apt', 'dnf', 'pacman', 'zypper', 'apk', 'brew', 'choco'];

// The three cross-cutting rules every command table must satisfy, as one
// function so they can be proven against fixtures rather than only looped over
// real bakelets — of which there are none with tables until the packages: and
// tools: conversions land.
function tableViolations(name, commands) {
    const problems = [];
    const managers = Object.keys(commands);

    if (!managers.length) problems.push(`${name}: command table is empty`);

    managers.forEach((manager) => {
        const cmd = commands[manager];
        if (KNOWN_MANAGERS.indexOf(manager) === -1) {
            problems.push(`${name}: unknown manager key "${manager}"`);
        }
        // Homebrew refuses to run under sudo and its own error is unactionable
        // for a student, so this has to be caught here rather than at run time.
        if (manager === 'brew' && /\bsudo\b/.test(cmd)) {
            problems.push(`${name}: brew command must not use sudo`);
        }
        // docker-local wraps commands as `bash -c '<cmd>'`, so a single quote
        // terminates the wrapper. Same invariant AgenticTool has always had.
        if (String(cmd).indexOf("'") !== -1) {
            problems.push(`${name}: ${manager} command contains a single quote`);
        }
    });

    return problems;
}

// Every bakelet class under the given section directories, instantiated. The
// 0-byte jenkins placeholders export {} rather than a class; they are reported
// by name instead of silently skipped, so deleting them closes this out.
function loadBakelets(sections) {
    const loaded = [];
    const empty = [];
    sections.forEach((section) => {
        const dir = path.join(BAKELETS_DIR, section);
        fs.readdirSync(dir).filter((f) => f.endsWith('.js')).forEach((file) => {
            const Klass = require(path.join(dir, file));
            const name = `${section}/${file}`;
            if (typeof Klass !== 'function') {
                empty.push(name);
                return;
            }
            loaded.push({ name, instance: new Klass('testenv', null, '') });
        });
    });
    return { loaded, empty };
}

// Minimal converted bakelet, standing in for the 12 real conversions until they
// land. Exercises the base-class contract without depending on any one of them.
class FixtureBakelet extends Bakelet {
    get commands() {
        return { apt: 'sudo apt-get install -y fixture', brew: 'brew install fixture' };
    }
    get requiresElevation() {
        return true;
    }
}

function withPlatform(bakelet, platform) {
    bakelet.platform = platform;
    return bakelet;
}

const LINUX = { os: 'linux', manager: 'apt', shell: 'sh', family: 'debian' };
const WINDOWS = { os: 'windows', manager: 'choco', shell: 'powershell', family: 'nt' };
const MACOS = { os: 'macos', manager: 'brew', shell: 'sh', family: 'darwin' };

describe('cross-platform bakelet contract', function() {

    describe('Bakelet defaults (AC-12)', function() {

        it('declares no commands by default', function() {
            expect(new Bakelet(null).commands).to.deep.equal({});
        });

        it('requires no elevation by default', function() {
            expect(new Bakelet(null).requiresElevation).to.equal(false);
        });

        it('needs no platform when it declares no commands', function() {
            expect(new Bakelet(null).needsPlatform).to.equal(false);
        });

        it('needs a platform once it declares commands', function() {
            expect(new FixtureBakelet(null).needsPlatform).to.equal(true);
        });

        it('defaults the shell to POSIX when no platform is resolved', function() {
            expect(new Bakelet(null).shell).to.equal('sh');
        });

        it('reports the resolved platform shell once one is set', function() {
            expect(withPlatform(new Bakelet(null), WINDOWS).shell).to.equal('powershell');
        });
    });

    describe('resolveCommand (AC-9)', function() {

        it('returns the command for the detected manager', function() {
            const bakelet = withPlatform(new FixtureBakelet(null), LINUX);
            expect(bakelet.resolveCommand()).to.equal('sudo apt-get install -y fixture');
        });

        it('selects a different command for a different manager', function() {
            const bakelet = withPlatform(new FixtureBakelet(null), MACOS);
            expect(bakelet.resolveCommand()).to.equal('brew install fixture');
        });

        it('throws rather than skipping when the manager has no entry', function() {
            const bakelet = withPlatform(new FixtureBakelet(null), WINDOWS);
            bakelet.setBakeletName('fixture');
            expect(() => bakelet.resolveCommand()).to.throw(/not supported on choco/);
        });

        it('names the bakelet, the OS, and the supported managers in the error', function() {
            const bakelet = withPlatform(new FixtureBakelet(null), WINDOWS);
            bakelet.setBakeletName('fixture');

            let error = null;
            try { bakelet.resolveCommand(); } catch (err) { error = err; }

            expect(error.message).to.contain('fixture');
            expect(error.message).to.contain('windows');
            expect(error.message).to.contain('apt');
            expect(error.message).to.contain('brew');
        });

        it('points at docker: and remote: as the alternative', function() {
            const bakelet = withPlatform(new FixtureBakelet(null), WINDOWS);
            bakelet.setBakeletName('fixture');

            let error = null;
            try { bakelet.resolveCommand(); } catch (err) { error = err; }

            expect(error.message).to.contain('docker:');
            expect(error.message).to.contain('remote:');
        });

        it('throws a distinct error when no platform was resolved at all', function() {
            const bakelet = new FixtureBakelet(null);
            bakelet.setBakeletName('fixture');
            expect(() => bakelet.resolveCommand()).to.throw(/needs the target platform/);
        });
    });

    describe('presenceCheck and execIfAbsent (AC-13)', function() {

        it('uses command -v on a POSIX shell', function() {
            expect(withPlatform(new Bakelet(null), LINUX).presenceCheck('git'))
                .to.equal('command -v git >/dev/null 2>&1');
        });

        it('uses Get-Command on PowerShell', function() {
            expect(withPlatform(new Bakelet(null), WINDOWS).presenceCheck('git'))
                .to.contain('Get-Command git');
        });

        it('never emits command -v on PowerShell', function() {
            expect(withPlatform(new Bakelet(null), WINDOWS).presenceCheck('git'))
                .to.not.contain('command -v');
        });

        it('guards a POSIX install with || so it is a no-op when present', async function() {
            const bakelet = withPlatform(new Bakelet(null), LINUX);
            let issued = null;
            bakelet.exec = async (cmd) => { issued = cmd; };
            await bakelet.execIfAbsent('git', 'apt-get install -y git');
            expect(issued).to.equal('command -v git >/dev/null 2>&1 || (apt-get install -y git)');
        });

        it('guards a PowerShell install with if/not rather than || (AC-13)', async function() {
            const bakelet = withPlatform(new Bakelet(null), WINDOWS);
            let issued = null;
            bakelet.exec = async (cmd) => { issued = cmd; };
            await bakelet.execIfAbsent('git', 'choco install -y git');

            expect(issued).to.contain('if (-not (');
            expect(issued).to.contain('choco install -y git');
            expect(issued).to.not.contain('||');
        });
    });

    describe('tier boundary (AC-12)', function() {
        const { loaded } = loadBakelets(LINUX_TIER);

        it('finds the Linux-tier bakelets to check', function() {
            expect(loaded.length).to.be.greaterThan(0);
        });

        loaded.forEach(({ name, instance }) => {
            it(`${name} stays playbook-backed and declares no command table`, function() {
                expect(instance.commands).to.deep.equal({});
                expect(instance.needsPlatform).to.equal(false);
            });
        });

        it('custom: stays playbook-backed', function() {
            const Custom = require('../../lib/bakelets/custom');
            const custom = new Custom('testenv', null, '');
            expect(custom.commands).to.deep.equal({});
            expect(custom.needsPlatform).to.equal(false);
        });
    });

    // The invariants themselves, proven against fixtures. Without this the
    // block below is vacuous until the first command table lands: it loops over
    // an empty list and reports success having checked nothing.
    describe('table invariant checks (AC-8, AC-10, AC-11)', function() {

        it('accepts a well-formed table', function() {
            expect(tableViolations('good', { apt: 'sudo apt-get install -y x', brew: 'brew install x' }))
                .to.deep.equal([]);
        });

        it('rejects an unknown manager key (AC-8)', function() {
            expect(tableViolations('bad', { nix: 'nix-env -i x' }).join(' '))
                .to.contain('unknown manager');
        });

        it('rejects sudo in a brew command (AC-10)', function() {
            expect(tableViolations('bad', { brew: 'sudo brew install x' }).join(' '))
                .to.contain('brew');
        });

        it('allows sudo everywhere except brew (AC-10)', function() {
            expect(tableViolations('good', { apt: 'sudo apt-get install -y x' })).to.deep.equal([]);
        });

        it('rejects a single quote in any command (AC-11)', function() {
            expect(tableViolations('bad', { apt: "sh -c 'apt-get install x'" }).join(' '))
                .to.contain('single quote');
        });

        it('rejects an empty table for a bakelet that declares one (AC-8)', function() {
            expect(tableViolations('bad', {}).join(' ')).to.contain('empty');
        });
    });

    describe('command table invariants applied (AC-8, AC-10, AC-11)', function() {
        const { loaded, empty } = loadBakelets(PORTABLE_TIER);
        const withTables = loaded.filter(({ instance }) => Object.keys(instance.commands).length > 0);

        it('reports bakelet modules that export nothing constructable', function() {
            // The 0-byte jenkins placeholders were deleted with the scope
            // reduction, so the known set is now empty and any NEW empty module
            // — which makes the resolver throw a bare TypeError — fails here.
            expect(empty).to.deep.equal([]);
        });

        withTables.forEach(({ name, instance }) => {
            it(`${name} satisfies every command table invariant`, function() {
                expect(tableViolations(name, instance.commands)).to.deep.equal([]);
            });
        });

        // Records how far the conversion has got, so the loop above can never
        // silently fall back to checking nothing. Raise this as bakelets are
        // converted; a drop means tables disappeared.
        it(`covers the ${withTables.length} portable-tier bakelets that declare tables`, function() {
            expect(withTables.length).to.equal(5,
                'Command table count changed — update this so the invariants above are known to run.');
        });
    });

    describe('agentic tool commands stay wrapping-safe (AC-11)', function() {
        const tools = ['claude-code', 'opencode'].map((name) => ({
            name,
            instance: new (require(`../../lib/bakelets/tools/${name}`))('testenv', null, '')
        }));

        tools.forEach(({ name, instance }) => {
            it(`${name} install commands contain no single quotes`, function() {
                Object.keys(instance.installCommands).forEach((method) => {
                    expect(instance.installCommands[method], `${name}: ${method}`).to.not.contain("'");
                });
            });

            it(`${name} repo sync contains no single quotes on either shell`, function() {
                withPlatform(instance, LINUX);
                expect(instance.repoSyncCommand('https://x/y.git', '~/.cfg')).to.not.contain("'");
                withPlatform(instance, WINDOWS);
                expect(instance.repoSyncCommand('https://x/y.git', '~/.cfg')).to.not.contain("'");
            });
        });

        it('AgenticTool declares that it needs the platform', function() {
            expect(new AgenticTool('testenv', null, '').needsPlatform).to.equal(true);
        });
    });

    describe('agentic tool install method by platform', function() {

        async function methodFor(platform, entry) {
            const Opencode = require('../../lib/bakelets/tools/opencode');
            const bakelet = new Opencode('testenv', null, '');
            bakelet.platform = platform;
            await bakelet.load(entry, []);
            return bakelet.resolvedInstallMethod;
        }

        it('uses the curl installer on POSIX', async function() {
            expect(await methodFor(LINUX, 'opencode')).to.equal('curl');
        });

        it('falls back to npm on Windows, where curl | bash cannot run', async function() {
            expect(await methodFor(WINDOWS, 'opencode')).to.equal('npm');
        });

        it('issues no curl pipe at all on Windows', async function() {
            const Opencode = require('../../lib/bakelets/tools/opencode');
            const bakelet = new Opencode('testenv', null, '');
            bakelet.platform = WINDOWS;
            const calls = [];
            bakelet.exec = async (cmd) => { calls.push(cmd); };
            await bakelet.load('opencode', []);
            await bakelet.install();

            expect(calls[0]).to.contain('npm install -g');
            expect(calls[0]).to.not.contain('curl');
            expect(calls[0]).to.not.contain('| bash');
        });

        it('lets an explicit install: override the Windows default', async function() {
            expect(await methodFor(WINDOWS, { opencode: { install: 'curl' } })).to.equal('curl');
        });

        it('keeps an explicit install: on POSIX too', async function() {
            expect(await methodFor(LINUX, { opencode: { install: 'npm' } })).to.equal('npm');
        });
    });

    describe('Bakelet.execCapture default (control-VM path)', function() {
        const Ssh = require('../../lib/modules/ssh');

        it('delegates to Ssh.sshExec and resolves with its output', async function() {
            const original = Ssh.sshExec;
            let received = null;
            Ssh.sshExec = async (cmd) => { received = cmd; return 'captured output'; };

            try {
                const bakelet = new Bakelet({ host: 'x' });
                expect(await bakelet.execCapture('uname -a')).to.equal('captured output');
                expect(received).to.equal('uname -a');
            } finally {
                Ssh.sshExec = original;
            }
        });
    });
});
