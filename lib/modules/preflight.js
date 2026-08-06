const child_process = require('child_process');

// Checks that a configuration CAN complete before any of it runs.
//
// The whole point is ordering. Chocolatey cannot elevate itself: if a bake
// discovers halfway through that it needed Administrator, the student is left
// with a half-configured machine and no clear way back. Ansible cannot run on
// Windows at all, so a playbook-backed bakelet on a laptop is equally doomed.
// Both are knowable up front, from constructed bakelets, before any exec.
// Added by Claude Code (claude-opus-5[1m])
class Preflight {

    // True when the current process can install to system paths.
    static hasElevation(platform, exec = child_process.execSync) {
        if (platform.os === 'windows') {
            // Chocolatey needs an already-elevated shell. The check has to ask
            // Windows itself; there is no getuid() to consult.
            try {
                const out = exec(
                    '[bool](([System.Security.Principal.WindowsPrincipal]' +
                    '[System.Security.Principal.WindowsIdentity]::GetCurrent())' +
                    '.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator))',
                    { encoding: 'utf8', shell: 'powershell.exe' }
                );
                return String(out).trim().toLowerCase() === 'true';
            } catch (err) {
                return false;
            }
        }

        // POSIX: only being root counts as already elevated. Having sudo
        // available is NOT the same thing — it means the user is about to be
        // asked for a password mid-bake, which is worth warning about even
        // though it is not a blocker.
        return typeof process.getuid === 'function' && process.getuid() === 0;
    }

    // OS from a Node platform string. Enough for the Ansible check, and knowable
    // without probing the target — which is what keeps a docker or remote bake
    // of playbook-backed bakelets from paying for a package-manager probe it
    // has no use for.
    static osOf(platformName) {
        if (platformName === 'win32') return 'windows';
        if (platformName === 'darwin') return 'macos';
        return 'linux';
    }

    // Bakelets that provision through Ansible cannot run against a non-Linux
    // target. Returns the offending names, empty when there are none.
    static ansibleBlockers(bakelets, targetOs) {
        if (targetOs === 'linux') return [];
        return bakelets.filter((b) => b.requiresAnsible).map((b) => b.bakeletName);
    }

    static elevationNeeded(bakelets) {
        return bakelets.filter((b) => b.requiresElevation).map((b) => b.bakeletName);
    }

    // Throws when a playbook-backed bakelet is aimed at a target Ansible cannot
    // provision, having changed nothing.
    static checkAnsible(bakelets, targetOs) {
        const blocked = Preflight.ansibleBlockers(bakelets, targetOs);
        if (!blocked.length) return;

        throw new Error(
            `${blocked.join(', ')} provision through Ansible, which does not run on ` +
            `${targetOs}.\n\n` +
            `  Add a docker: or remote: section to your baker.yml to provision a Linux target.\n\n` +
            `Nothing on your machine has been changed.`
        );
    }

    // Elevation, checked against the machine Baker is running on.
    //
    // Only meaningful in local mode. For docker and remote the privileges that
    // matter belong to the container or the remote host, not to this process,
    // and the "nothing has been changed" promise is about the user's own
    // machine — so those transports let the target's own sudo answer.
    static checkElevation(bakelets, platform, options = {}) {
        const exec = options.exec || child_process.execSync;
        const warnings = [];

        const needy = Preflight.elevationNeeded(bakelets);
        if (!needy.length) return warnings;
        if (Preflight.hasElevation(platform, exec)) return warnings;

        if (platform.os === 'windows') {
            throw new Error(
                `This configuration installs system packages (${needy.join(', ')}) and needs ` +
                `Administrator rights.\n\n` +
                `  1. Close this window\n` +
                `  2. Right-click PowerShell and choose "Run as Administrator"\n` +
                `  3. Re-run the same baker command\n\n` +
                `Nothing on your machine has been changed.`
            );
        }

        warnings.push(
            `This configuration installs system packages (${needy.join(', ')}) ` +
            `and will prompt for your sudo password.`
        );
        return warnings;
    }
}

module.exports = Preflight;
