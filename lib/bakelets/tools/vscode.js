const PackageTool = require('./package-tool');

// Visual Studio Code, plus the two things a cohort actually needs configured:
// a set of extensions and a User settings.json.
//
// Installation is the awkward part. VS Code is not in the default repositories
// for apt, dnf or zypper — Microsoft ships its own packages — so unlike every
// other PackageTool here the Linux commands DOWNLOAD the official package and
// install it locally rather than naming one for the manager to find. The .deb
// and .rpm both register Microsoft's repository in their post-install step, so
// the machine keeps getting updates afterwards; that is why this is preferred
// over unpacking a tarball.
//
// Alpine is deliberately absent from the table. Microsoft publishes no musl
// build, and there is no community package — so resolveCommand() refuses with
// the "use docker: or remote:" message rather than inventing a package name.
//
// Shell-safety invariant, as everywhere else in this directory: no composed
// command may contain a single quote, because docker-local wraps commands as
// `docker exec <c> /bin/bash -c '<cmd>'`.
// Added by Claude Code (claude-opus-5[1m])

// Where VS Code keeps User settings, per OS. The `plan` form is what cleanup
// hands to filterExisting/removePath (which expand ~ host-side); the `shell`
// form is what the target's own shell expands, and must not use ~ because it
// appears inside double quotes, where no shell expands it.
//
// Forward slashes on Windows too: PowerShell and .NET both accept them, and a
// backslash here would have to be doubled in every template literal below.
const SETTINGS_DIR = {
    linux:   { shell: '$HOME/.config/Code/User',                    plan: '~/.config/Code/User' },
    macos:   { shell: '$HOME/Library/Application Support/Code/User', plan: '~/Library/Application Support/Code/User' },
    windows: { shell: '$env:APPDATA/Code/User',                     plan: '~/AppData/Roaming/Code/User' }
};

// publisher.extension, optionally @version — the form `code --install-extension`
// accepts. Validated rather than interpolated blind: an extension id comes from
// a baker.yml an instructor wrote, and it is pasted into a shell command.
const EXTENSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*\.[A-Za-z0-9][A-Za-z0-9._-]*(@[A-Za-z0-9.-]+)?$/;

const MS_KEY = 'https://packages.microsoft.com/keys/microsoft.asc';
const DOWNLOAD = 'https://update.code.visualstudio.com/latest';

class VSCode extends PackageTool {
    constructor(name, ansibleSSHConfig, version) {
        super(name, ansibleSSHConfig, version);

        this.binName = 'code';
        this.extensions = [];
        this.settings = null;
        this.overwriteSettings = false;
    }

    // Downloads the official package and installs it. Shared by the three
    // managers that need it, so the architecture probe is written once.
    //
    // Microsoft publishes x64 and arm64 builds. The probe is not optional
    // politeness: `docker:` mode on an Apple Silicon laptop produces an arm64
    // Linux container, so hardcoding x64 would break the default path for every
    // student on a recent Mac.
    download(kind, install) {
        const file = `/tmp/vscode-baker.${kind}`;
        return `A=x64; [ "$(uname -m)" = aarch64 ] && A=arm64; ` +
            `curl -fsSL -o ${file} "${DOWNLOAD}/linux-${kind}-$A/stable" && ` +
            `${install(file)} && rm -f ${file}`;
    }

    get commands() {
        return {
            // The one command here that runs `update` first. A downloaded .deb
            // resolves its dependencies from the configured repositories, so
            // stale package lists fail it where a plain package name would have
            // been fine — which is the state a freshly pulled container is in.
            apt: this.download('deb', (f) =>
                `${this.sudo}apt-get update && ${this.sudo}apt-get install -y ${f}`),

            // Importing Microsoft's key first is what lets the signature check
            // pass; the alternative is --nogpgcheck, which turns a verified
            // install into an unverified one to save one command.
            dnf: this.download('rpm', (f) =>
                `${this.sudo}rpm --import ${MS_KEY} && ${this.sudo}dnf install -y ${f}`),
            zypper: this.download('rpm', (f) =>
                `${this.sudo}rpm --import ${MS_KEY} && ${this.sudo}zypper --non-interactive install ${f}`),

            // Arch's `code` is Code - OSS, the open-source build. It is a real
            // VS Code and the binary is `code`, but it ships with the Open VSX
            // registry rather than Microsoft's marketplace — so an extensions:
            // list of Microsoft-marketplace ids may not resolve. Documented in
            // docs/bakelets.md; kept in the table because refusing Arch outright
            // would be worse than installing the build Arch actually offers.
            pacman: `${this.sudo}pacman -S --noconfirm code`,

            brew: 'brew install --cask visual-studio-code',
            choco: 'choco install -y vscode'
        };
    }

    get uninstallCommands() {
        return {
            apt: `${this.sudo}apt-get remove -y code`,
            dnf: `${this.sudo}dnf remove -y code`,
            zypper: `${this.sudo}zypper --non-interactive remove code`,
            pacman: `${this.sudo}pacman -Rns --noconfirm code`,
            brew: 'brew uninstall --cask visual-studio-code',
            choco: 'choco uninstall -y vscode'
        };
    }

    get removalPrompt() {
        return `Remove Visual Studio Code? Installed extensions and your editor ` +
            `settings stay on disk unless you also select the entries below.`;
    }

    // A drag-to-Applications install leaves no `code` on PATH, so the inherited
    // check would report VS Code absent and run the cask install — which fails
    // outright ("It seems there is already an App at ..."), taking the bake down
    // over software that was already there. The .app is the thing Homebrew would
    // refuse to overwrite, so the .app is what the check has to look for.
    presenceCheck(bin) {
        if (!this.platform || this.platform.os !== 'macos') {
            return super.presenceCheck(bin);
        }
        return `command -v ${bin} >/dev/null 2>&1 || ` +
            `[ -d "/Applications/Visual Studio Code.app" ]`;
    }

    async load(obj, variables) {
        this.variables = variables;

        // YAML entry is either "vscode" (string) or { vscode: {...} }.
        const entry = (typeof obj === 'string' || obj === null) ? undefined : obj.vscode;
        const config = (entry && typeof entry === 'object' && !Array.isArray(entry)) ? entry : {};

        // `- vscode: ms-python.python` and a bare list are both accepted as
        // extension shorthands, mirroring how pip: and npm: take a single
        // package or a list without an enclosing key.
        if (typeof entry === 'string') {
            this.extensions = [entry];
        } else if (Array.isArray(entry)) {
            this.extensions = entry;
        } else if (Array.isArray(config.extensions)) {
            this.extensions = config.extensions;
        } else if (typeof config.extensions === 'string') {
            this.extensions = [config.extensions];
        }

        if (config.settings && typeof config.settings === 'object') {
            this.settings = config.settings;
        }
        this.overwriteSettings = Boolean(config.overwrite);
    }

    async install() {
        await super.install();

        if (this.extensions.length) {
            await this.exec(this.extensionCommand());
        }
        if (this.settings) {
            await this.exec(this.settingsCommand());
        }
    }

    // One invocation carrying every extension, rather than one per id: the CLI
    // accepts repeated --install-extension flags, and each separate invocation
    // pays VS Code's several-second startup again.
    //
    // --force makes it idempotent — without it, an already-installed extension
    // is a non-zero exit and the bake fails on the second run.
    extensionCommand() {
        const bad = this.extensions.filter((id) => !EXTENSION_ID.test(String(id)));
        if (bad.length) {
            throw new Error(
                `Invalid VS Code extension id(s): ${bad.join(', ')}. ` +
                `Use the marketplace id in publisher.extension form, e.g. ms-python.python.`
            );
        }

        const flags = this.extensions.map((id) => `--install-extension ${id}`).join(' ');

        // macOS again: the cask links `code` into Homebrew's bin, but a
        // drag-installed VS Code (which presenceCheck now accepts) does not, so
        // the CLI has to be located inside the bundle before it can be run.
        if (this.platform && this.platform.os === 'macos') {
            return `BAKER_CODE=code; command -v code >/dev/null 2>&1 || ` +
                `BAKER_CODE="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"; ` +
                `"$BAKER_CODE" ${flags} --force`;
        }
        return `code ${flags} --force`;
    }

    get settingsDir() {
        return SETTINGS_DIR[(this.platform && this.platform.os) || 'linux'];
    }

    settingsPath() {
        return `${this.settingsDir.plan}/settings.json`;
    }

    // Writes User settings.json.
    //
    // Does NOT overwrite by default. settings.json is where a person keeps their
    // theme, their keybindings-adjacent preferences and anything a previous
    // assignment configured, and Baker cannot merge into it — no target is
    // guaranteed to have jq, node or python3. So the safe direction is to write
    // the file when it is absent and say so when it is not, which matches how
    // `config: files:` treats a destination it did not create.
    //
    // `overwrite: true` is the escape hatch for an instructor who does need to
    // enforce settings, and it takes a backup first rather than discarding.
    settingsCommand() {
        const dir = this.settingsDir.shell;
        const file = `${dir}/settings.json`;
        const json = JSON.stringify(this.settings, null, 4);
        const skip = `${file} already exists; leaving it alone ` +
            `(set overwrite: true under tools: vscode: to replace it)`;

        if (this.shell === 'powershell') {
            // Base64 rather than a here-string: the payload is JSON, so it is
            // full of double quotes, and PowerShell here-strings have to start
            // and end on their own lines — which survives neither execSync nor
            // the docker exec wrapping reliably. Decoding is one expression.
            const b64 = Buffer.from(json, 'utf8').toString('base64');
            const write = `[IO.File]::WriteAllText("${file}", ` +
                `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${b64}")))`;
            const mkdir = `New-Item -ItemType Directory -Force -Path "${dir}" | Out-Null`;

            if (this.overwriteSettings) {
                return `${mkdir}; if (Test-Path "${file}") ` +
                    `{ Copy-Item -Force "${file}" "${file}.baker-backup" }; ${write}`;
            }
            return `${mkdir}; if (Test-Path "${file}") ` +
                `{ Write-Output "${skip}" } else { ${write} }`;
        }

        // Quoted heredoc delimiter, so nothing in the JSON is re-interpreted on
        // the way in — the same construction config/files.js uses for blocks.
        const write = `cat > "${file}" <<"BAKER_VSCODE_SETTINGS"\n${json}\nBAKER_VSCODE_SETTINGS`;

        if (this.overwriteSettings) {
            return `mkdir -p "${dir}"; [ -e "${file}" ] && cp -f "${file}" "${file}.baker-backup"; ` +
                write;
        }
        return `mkdir -p "${dir}"; if [ -e "${file}" ]; then echo "${skip}"; else ${write}\nfi`;
    }

    // The binary's inverse comes from PackageTool; the settings file is this
    // bakelet's own, so it gets its own entry a person can decline separately.
    //
    // default: false, and the prompt is explicit that Baker may not have been
    // what created the file — same posture AgenticTool takes toward ~/.claude.
    // Extensions are deliberately not offered: `code --uninstall-extension`
    // would remove ones the person installed themselves just as readily, and
    // nothing records which came from the bake.
    async plan() {
        const entries = await super.plan();
        if (!this.settings) return entries;

        const file = this.settingsPath();
        const label = 'vscode settings';

        if (!(await this.filterExisting([file])).length) {
            entries.push({ kind: 'none', bakelet: label, reason: `${file} not present` });
            return entries;
        }

        entries.push({
            kind: 'paths', bakelet: label, default: false, paths: [file],
            prompt: `Remove ${file}? This is your VS Code settings file — Baker writes ` +
                `it only when it is absent, so it may hold edits Baker never made.`,
            summary: `remove ${file}`,
            restore: `re-run baker bake to write the settings from baker.yml again`
        });
        return entries;
    }

    async uninstall(operation) {
        if (operation.kind === 'paths') {
            for (const target of operation.paths) {
                await this.removePath(target);
            }
            return;
        }
        await super.uninstall(operation);
    }
}

module.exports = VSCode;
