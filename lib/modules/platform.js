// Package-manager detection for the provisioning target.
//
// Keyed on package manager rather than on distribution name, because a manager
// is what a bakelet actually needs to know. Keying this way means a new Debian
// or RHEL derivative costs one table entry instead of a branch in every bakelet.
//
// Every function here is pure with respect to its inputs: detect() takes the
// exec function and the platform string rather than reaching for child_process
// or process.platform itself. That single seam is what makes all seven platform
// targets reachable from one machine in the test suite — mirroring the
// no-filesystem/no-network rule that keeps utils/git.js unit testable.
// Added by Claude Code (claude-opus-5[1m])

// os-release ID / ID_LIKE -> package manager. ID_LIKE is what rescues the
// derivatives: Pop!_OS, Mint, and Rocky all report unfamiliar IDs but correct
// ID_LIKE values, and there are far too many derivatives to enumerate by ID.
const MANAGERS = {
    debian: 'apt', ubuntu: 'apt', raspbian: 'apt', pop: 'apt', linuxmint: 'apt', devuan: 'apt',
    fedora: 'dnf', rhel: 'dnf', centos: 'dnf', rocky: 'dnf', almalinux: 'dnf', ol: 'dnf',
    arch: 'pacman', manjaro: 'pacman', endeavouros: 'pacman',
    opensuse: 'zypper', 'opensuse-leap': 'zypper', 'opensuse-tumbleweed': 'zypper', sles: 'zypper',
    alpine: 'apk'
};

// Probed in this order when os-release cannot answer. Order matters: a machine
// can carry more than one manager (apt installed on Fedora for other reasons),
// and the first entry wins, so this list runs most-common-family first.
const PROBES = [
    { bin: 'apt-get', manager: 'apt' },
    { bin: 'dnf', manager: 'dnf' },
    { bin: 'pacman', manager: 'pacman' },
    { bin: 'zypper', manager: 'zypper' },
    { bin: 'apk', manager: 'apk' }
];

const FAMILIES = {
    apt: 'debian', dnf: 'rhel', pacman: 'arch', zypper: 'suse', apk: 'alpine',
    brew: 'darwin', choco: 'nt'
};

const LINUX_MANAGERS = PROBES.map((p) => p.manager);

class Platform {

    // Parses /etc/os-release into its fields. Values are optionally quoted
    // (ID=fedora, ID="fedora", ID='fedora' are all legal per the spec), and
    // comment/blank lines are ignored rather than treated as malformed.
    static parseOsRelease(text) {
        const fields = {};
        String(text || '').split('\n').forEach((line) => {
            const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
            if (!match) return;
            fields[match[1]] = match[2].trim().replace(/^(["'])(.*)\1$/, '$2');
        });
        return fields;
    }

    static familyOf(manager) {
        return FAMILIES[manager];
    }

    static get linuxManagers() {
        return LINUX_MANAGERS.slice();
    }

    // First manager whose binary is present, or null. A rejection and empty
    // output both mean absent: `command -v` exits non-zero when it finds
    // nothing, and the three transports differ in whether a non-zero exit
    // surfaces as a throw or as empty stdout.
    static async probe(execCapture) {
        for (const candidate of PROBES) {
            let found = false;
            try {
                const out = await execCapture(`command -v ${candidate.bin}`);
                found = Boolean(out && String(out).trim());
            } catch (err) {
                found = false;
            }
            if (found) return candidate.manager;
        }
        return null;
    }

    // Resolves the platform descriptor for the target being provisioned.
    //
    // `platformName` is the TARGET's platform, not the operator's. Callers
    // provisioning a container or a remote host pass 'linux' explicitly rather
    // than process.platform, because a macOS laptop baking into an Ubuntu
    // container must resolve apt, not brew. Only the local provider passes
    // process.platform, which is also the default.
    static async detect(execCapture, platformName = process.platform) {
        // Windows and macOS have exactly one supported manager each, so they
        // resolve without touching the transport at all. Cheap, and it keeps a
        // bake on a laptop from paying for a subprocess it cannot learn from.
        if (platformName === 'win32') {
            return { os: 'windows', manager: 'choco', shell: 'powershell', family: 'nt' };
        }
        if (platformName === 'darwin') {
            return { os: 'macos', manager: 'brew', shell: 'sh', family: 'darwin' };
        }

        let release = {};
        try {
            release = Platform.parseOsRelease(await execCapture('cat /etc/os-release'));
        } catch (err) {
            // A missing os-release is not fatal: minimal images and older
            // distributions omit it, and the probe still identifies them.
            release = {};
        }

        const ids = [release.ID].concat(String(release.ID_LIKE || '').split(/\s+/)).filter(Boolean);
        const byId = ids.map((id) => MANAGERS[id.toLowerCase()]).find(Boolean);
        const manager = byId || await Platform.probe(execCapture);

        if (!manager) {
            throw new Error(
                `Unsupported Linux distribution (ID=${release.ID || 'unknown'}). ` +
                `Baker supports ${LINUX_MANAGERS.join(', ')}. ` +
                `Use docker: or remote: in your baker.yml to provision a supported target instead.`
            );
        }

        return { os: 'linux', manager, shell: 'sh', family: Platform.familyOf(manager) };
    }
}

module.exports = Platform;
