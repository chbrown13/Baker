const Bakelet = require('../bakelet');

// A Docker Desktop extension, e.g. dockersamples/labspace-extension.
//
//   tools:
//     - docker-extension:
//         address: dockersamples/labspace-extension
//     - docker-extension: dockersamples/labspace-extension   # shorthand
//
// Not a PackageTool: there is no package manager involved and nothing lands on
// PATH, so the presence check is `docker extension ls`, not a binary probe.
//
// Docker Desktop must already be RUNNING. Baker deliberately does not try to
// install or start it — Desktop cannot be installed non-interactively across
// the three platforms, and starting a GUI application from a bake is not
// something a bakelet should do. It detects and instructs instead, which is the
// same line `baker check` draws.
// Added by Claude Code (claude-opus-5[1m])
class DockerExtension extends Bakelet {
    constructor(name, ansibleSSHConfig, version) {
        super(ansibleSSHConfig);

        this.name = name;
        this.version = version;
    }

    // The host's shell decides how the guard is written, so the platform must be
    // resolved even though this is not a package-manager install.
    get needsPlatform() {
        return true;
    }

    // Extensions install into the user's Docker Desktop, never a system path.
    get requiresElevation() {
        return false;
    }

    async load(obj, variables) {
        const entry = (typeof obj === 'string' || obj === null) ? undefined : obj['docker-extension'];
        if (typeof entry === 'string') {
            this.address = entry;
        } else if (entry && typeof entry === 'object') {
            this.address = entry.address;
        }
        this.variables = variables;
    }

    async install() {
        if (!this.address) {
            throw new Error(
                'tools: docker-extension needs an extension address, e.g.\n' +
                '  tools:\n' +
                '    - docker-extension:\n' +
                '        address: dockersamples/labspace-extension'
            );
        }

        await this.assertDesktopRunning();

        // `docker extension install` errors on an already-installed extension,
        // so it is guarded by a listing check rather than run unconditionally.
        await this.exec(this.installCommand(this.address));
    }

    // Separated so the failure can carry its own message. `docker extension ls`
    // needs both the Desktop CLI plugin and a live daemon, so one probe covers
    // "Desktop is not installed" and "Desktop is not running" — which is why the
    // message names both.
    async assertDesktopRunning() {
        try {
            await this.execCapture('docker extension ls');
        } catch (err) {
            throw new Error(
                `Docker Desktop is not available, so the ${this.address} extension cannot be ` +
                `installed.\n` +
                `  - If Docker Desktop is installed, start it and re-run the bake.\n` +
                `  - If it is not installed, install it first: https://docs.docker.com/desktop/\n` +
                `Extensions are a Docker Desktop feature; Docker Engine alone does not provide them.`
            );
        }
    }

    // No single quotes anywhere: docker-local wraps commands as
    // `docker exec <c> /bin/bash -c '<cmd>'` and a single quote breaks it.
    installCommand(address) {
        const install = `docker extension install ${address} --force`;
        return this.shell === 'powershell'
            ? `if (-not (docker extension ls | Select-String -SimpleMatch ${address})) { ${install} }`
            : `docker extension ls | grep -q ${address} || (${install})`;
    }
}

module.exports = DockerExtension;
