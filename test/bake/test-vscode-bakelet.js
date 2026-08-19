const chai = require('chai');
const expect = chai.expect;

const VSCode = require('../../lib/bakelets/tools/vscode');

const LINUX   = { os: 'linux',   manager: 'apt',    shell: 'sh',         family: 'debian', sudo: true };
const FEDORA  = { os: 'linux',   manager: 'dnf',    shell: 'sh',         family: 'rhel',   sudo: true };
const SUSE    = { os: 'linux',   manager: 'zypper', shell: 'sh',         family: 'suse',   sudo: true };
const ARCH    = { os: 'linux',   manager: 'pacman', shell: 'sh',         family: 'arch',   sudo: true };
const ALPINE  = { os: 'linux',   manager: 'apk',    shell: 'sh',         family: 'alpine', sudo: false };
const MACOS   = { os: 'macos',   manager: 'brew',   shell: 'sh',         family: 'darwin', sudo: false };
const WINDOWS = { os: 'windows', manager: 'choco',  shell: 'powershell', family: 'nt',     sudo: false };

const SUPPORTED = [LINUX, FEDORA, SUSE, ARCH, MACOS, WINDOWS];

// Same recorder shape as test-toolchain-bakelets.js: load()+install() with
// this.exec captured, so every assertion is about the command that would run.
async function run(entry, platform) {
    const bakelet = new VSCode('env', null, '');
    bakelet.platform = platform;
    bakelet.setBakeletName('vscode');
    const calls = [];
    bakelet.exec = async (cmd) => { calls.push(cmd); };
    await bakelet.load(entry, []);
    await bakelet.install();
    return { bakelet, calls };
}

function built(entry, platform) {
    const bakelet = new VSCode('env', null, '');
    bakelet.platform = platform;
    bakelet.setBakeletName('vscode');
    return bakelet;
}

describe('tools: vscode', function() {

    describe('install', function() {

        it('installs on every supported manager', async function() {
            for (const platform of SUPPORTED) {
                const { calls } = await run('vscode', platform);
                expect(calls, platform.manager).to.have.lengthOf(1);
                expect(calls[0], platform.manager).to.contain('code');
            }
        });

        it('downloads the official package on the managers that do not carry it', async function() {
            const expected = [
                [LINUX,  'linux-deb-$A', 'apt-get install -y /tmp/vscode-baker.deb'],
                [FEDORA, 'linux-rpm-$A', 'dnf install -y /tmp/vscode-baker.rpm'],
                [SUSE,   'linux-rpm-$A', 'zypper --non-interactive install /tmp/vscode-baker.rpm'],
            ];
            for (const [platform, url, install] of expected) {
                const { calls } = await run('vscode', platform);
                expect(calls[0], platform.manager).to.contain(url);
                expect(calls[0], platform.manager).to.contain(install);
            }
        });

        it('probes the architecture so an arm64 container gets an arm64 build', async function() {
            // docker: mode on an Apple Silicon laptop produces an arm64 Linux
            // container. A hardcoded x64 URL would break the default path for
            // every student on a recent Mac.
            for (const platform of [LINUX, FEDORA, SUSE]) {
                const { calls } = await run('vscode', platform);
                expect(calls[0], platform.manager).to.contain('uname -m');
                expect(calls[0], platform.manager).to.contain('A=arm64');
            }
        });

        it('imports the Microsoft key rather than disabling the signature check', async function() {
            for (const platform of [FEDORA, SUSE]) {
                const { calls } = await run('vscode', platform);
                expect(calls[0], platform.manager).to.contain('rpm --import');
                expect(calls[0], platform.manager).to.not.contain('nogpgcheck');
            }
        });

        it('refreshes apt lists, which a downloaded .deb needs to resolve its dependencies', async function() {
            const { calls } = await run('vscode', LINUX);
            expect(calls[0]).to.contain('apt-get update');
        });

        it('uses the distribution package on Arch, which has one', async function() {
            const { calls } = await run('vscode', ARCH);
            expect(calls[0]).to.contain('pacman -S --noconfirm code');
            expect(calls[0]).to.not.contain('curl');
        });

        it('refuses Alpine, where no build exists, instead of guessing a package', async function() {
            let error = null;
            try { await run('vscode', ALPINE); } catch (err) { error = err; }
            expect(error).to.not.equal(null);
            expect(error.message).to.contain('not supported on apk');
            expect(error.message).to.contain('docker:');
        });

        it('guards on the code binary so a second bake is a no-op', async function() {
            const { calls } = await run('vscode', LINUX);
            expect(calls[0]).to.match(/^command -v code >\/dev\/null 2>&1 \|\| \(/);
        });

        it('uses a PowerShell guard on Windows', async function() {
            const { calls } = await run('vscode', WINDOWS);
            expect(calls[0]).to.contain('Get-Command code');
            expect(calls[0]).to.not.contain('||');
        });

        it('never sudos under Homebrew', async function() {
            const { calls } = await run('vscode', MACOS);
            expect(calls[0]).to.not.contain('sudo');
        });

        it('accepts a drag-installed VS Code on macOS, which the cask would refuse to overwrite', function() {
            const check = built('vscode', MACOS).presenceCheck('code');
            expect(check).to.contain('Applications/Visual Studio Code.app');
        });

        it('keeps the plain presence check off macOS', function() {
            expect(built('vscode', LINUX).presenceCheck('code'))
                .to.equal('command -v code >/dev/null 2>&1');
        });

        it('needs elevation on a sudo Linux target but not on macOS', function() {
            expect(built('vscode', LINUX).requiresElevation).to.equal(true);
            expect(built('vscode', MACOS).requiresElevation).to.equal(false);
        });
    });

    describe('extensions', function() {

        it('installs nothing extra for a bare entry', async function() {
            const { calls } = await run('vscode', LINUX);
            expect(calls).to.have.lengthOf(1);
        });

        it('installs every extension in one invocation', async function() {
            const { calls } = await run(
                { vscode: { extensions: ['ms-python.python', 'dbaeumer.vscode-eslint'] } }, LINUX);
            expect(calls).to.have.lengthOf(2);
            expect(calls[1]).to.contain('--install-extension ms-python.python');
            expect(calls[1]).to.contain('--install-extension dbaeumer.vscode-eslint');
            expect(calls[1].match(/code /g)).to.have.lengthOf(1);
        });

        it('forces, so an already-installed extension is not a failed bake', async function() {
            const { calls } = await run({ vscode: { extensions: ['ms-python.python'] } }, LINUX);
            expect(calls[1]).to.contain('--force');
        });

        it('accepts a single extension as a string', async function() {
            const { calls } = await run({ vscode: 'ms-python.python' }, LINUX);
            expect(calls[1]).to.contain('--install-extension ms-python.python');
        });

        it('accepts a bare list of extensions', async function() {
            const { calls } = await run({ vscode: ['ms-python.python'] }, LINUX);
            expect(calls[1]).to.contain('--install-extension ms-python.python');
        });

        it('rejects an id that is not publisher.extension', async function() {
            let error = null;
            try {
                await run({ vscode: { extensions: ['not-an-id; rm -rf /'] } }, LINUX);
            } catch (err) { error = err; }
            expect(error).to.not.equal(null);
            expect(error.message).to.contain('publisher.extension');
        });

        it('accepts a pinned version', async function() {
            const { calls } = await run({ vscode: { extensions: ['ms-python.python@2024.1.0'] } }, LINUX);
            expect(calls[1]).to.contain('ms-python.python@2024.1.0');
        });

        it('locates the bundled CLI on macOS, where a drag install puts nothing on PATH', async function() {
            const { calls } = await run({ vscode: { extensions: ['ms-python.python'] } }, MACOS);
            expect(calls[1]).to.contain('Contents/Resources/app/bin/code');
        });
    });

    describe('settings', function() {
        const SETTINGS = { vscode: { settings: { 'editor.formatOnSave': true, 'editor.tabSize': 4 } } };

        it('writes User settings.json with the configured values', async function() {
            const { calls } = await run(SETTINGS, LINUX);
            expect(calls).to.have.lengthOf(2);
            expect(calls[1]).to.contain('editor.formatOnSave');
            expect(calls[1]).to.contain('$HOME/.config/Code/User/settings.json');
        });

        it('uses each OS its own settings location', async function() {
            const expected = [
                [LINUX,   '$HOME/.config/Code/User'],
                [MACOS,   '$HOME/Library/Application Support/Code/User'],
                [WINDOWS, '$env:APPDATA/Code/User'],
            ];
            for (const [platform, dir] of expected) {
                const { calls } = await run(SETTINGS, platform);
                expect(calls[1], platform.os).to.contain(dir);
            }
        });

        it('leaves an existing settings.json alone by default', async function() {
            const { calls } = await run(SETTINGS, LINUX);
            expect(calls[1]).to.contain('already exists; leaving it alone');
            expect(calls[1]).to.contain('overwrite: true');
        });

        it('backs the file up before replacing it when overwrite is set', async function() {
            const { calls } = await run(
                { vscode: { settings: { 'editor.tabSize': 4 }, overwrite: true } }, LINUX);
            expect(calls[1]).to.contain('.baker-backup');
            expect(calls[1]).to.not.contain('leaving it alone');
        });

        it('writes through a quoted heredoc so the JSON is not re-interpreted', async function() {
            const { calls } = await run(SETTINGS, LINUX);
            expect(calls[1]).to.contain('<<"BAKER_VSCODE_SETTINGS"');
        });

        it('writes through base64 on PowerShell, which has no usable heredoc', async function() {
            const { calls } = await run(SETTINGS, WINDOWS);
            expect(calls[1]).to.contain('FromBase64String');
            expect(calls[1]).to.not.contain('<<');

            const encoded = calls[1].match(/FromBase64String\("([^"]+)"\)/)[1];
            expect(JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')))
                .to.deep.equal({ 'editor.formatOnSave': true, 'editor.tabSize': 4 });
        });

        it('backs the file up on Windows too', async function() {
            const { calls } = await run(
                { vscode: { settings: { 'editor.tabSize': 4 }, overwrite: true } }, WINDOWS);
            expect(calls[1]).to.contain('.baker-backup');
        });
    });

    // docker-local wraps commands as `docker exec <c> /bin/bash -c '<cmd>'`, so
    // a single quote anywhere terminates the wrapper. The command tables are
    // covered by test-command-tables.js; these are the composed commands, which
    // that sweep cannot see because they are built at install time.
    describe('shell-safety invariant', function() {

        it('composes no single quote on any platform', async function() {
            const entry = {
                vscode: {
                    extensions: ['ms-python.python'],
                    settings: { 'editor.formatOnSave': true, 'workbench.colorTheme': 'Default Dark+' }
                }
            };
            for (const platform of SUPPORTED) {
                const { calls } = await run(entry, platform);
                calls.forEach((cmd, i) => {
                    expect(cmd, `${platform.manager} command ${i}`).to.not.contain("'");
                });
            }
        });

        it('composes no single quote when overwriting either', async function() {
            const entry = { vscode: { settings: { 'editor.tabSize': 4 }, overwrite: true } };
            for (const platform of SUPPORTED) {
                const { calls } = await run(entry, platform);
                calls.forEach((cmd) => expect(cmd, platform.manager).to.not.contain("'"));
            }
        });
    });

    describe('cleanup plan', function() {

        async function planFor(entry, platform, settingsPresent) {
            const bakelet = built(entry, platform);
            bakelet.execCapture = async () => '';
            bakelet.filterExisting = async (paths) => (settingsPresent ? paths : []);
            await bakelet.prepare(entry, []);
            return bakelet.plan();
        }

        it('offers to uninstall the binary', async function() {
            const plan = await planFor('vscode', LINUX, false);
            const exec = plan.find((e) => e.kind === 'exec');
            expect(exec.command).to.contain('apt-get remove -y code');
            expect(exec.default).to.equal(false);
        });

        it('adds no settings entry when the config configured none', async function() {
            const plan = await planFor('vscode', LINUX, true);
            expect(plan.filter((e) => e.bakelet === 'vscode settings')).to.have.lengthOf(0);
        });

        it('offers the settings file it wrote, defaulting to No', async function() {
            const entry = { vscode: { settings: { 'editor.tabSize': 4 } } };
            const plan = await planFor(entry, LINUX, true);
            const settings = plan.find((e) => e.bakelet === 'vscode settings');
            expect(settings.kind).to.equal('paths');
            expect(settings.default).to.equal(false);
            expect(settings.paths).to.deep.equal(['~/.config/Code/User/settings.json']);
        });

        it('reports the settings file as already gone rather than offering it', async function() {
            const entry = { vscode: { settings: { 'editor.tabSize': 4 } } };
            const plan = await planFor(entry, LINUX, false);
            const settings = plan.find((e) => e.bakelet === 'vscode settings');
            expect(settings.kind).to.equal('none');
        });

        it('never offers to uninstall extensions, which it cannot tell apart from ones the user chose', async function() {
            const entry = { vscode: { extensions: ['ms-python.python'] } };
            const plan = await planFor(entry, LINUX, true);
            plan.forEach((e) => expect(JSON.stringify(e)).to.not.contain('uninstall-extension'));
        });

        it('removes the settings path through the transport when selected', async function() {
            const bakelet = built({ vscode: { settings: { 'editor.tabSize': 4 } } }, LINUX);
            const removed = [];
            bakelet.removePath = async (p) => { removed.push(p); };
            await bakelet.uninstall({ kind: 'paths', paths: ['~/.config/Code/User/settings.json'] });
            expect(removed).to.deep.equal(['~/.config/Code/User/settings.json']);
        });

        it('still runs an exec entry through PackageTool', async function() {
            const bakelet = built('vscode', LINUX);
            const calls = [];
            bakelet.exec = async (cmd) => { calls.push(cmd); };
            await bakelet.uninstall({ kind: 'exec', command: 'sudo apt-get remove -y code' });
            expect(calls).to.deep.equal(['sudo apt-get remove -y code']);
        });
    });
});
