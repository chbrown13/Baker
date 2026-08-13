const PackageTool = require('./package-tool');

// Python 3 and pip.
//
// The sudo-free counterpart to `lang: python`, which is playbook-backed and so
// needs Ansible, become: yes, and a Linux target.
//
// Two things diverge here, which is why this is a bakelet and not a bare
// `packages:` entry. The package is `python3` on Debian, Fedora, SUSE, and
// Alpine but `python` on Arch and Chocolatey; and pip ships separately
// everywhere except Homebrew and Chocolatey, under two different spellings
// (`python3-pip`, `py3-pip`).
// Added by Claude Code (claude-opus-5[1m])
class Python extends PackageTool {

    // Windows has no `python3` on PATH — the Chocolatey and python.org
    // installers both provide `python`. A getter rather than a constructor
    // assignment because the platform is not resolved until after construction.
    get binName() {
        return this.platform && this.platform.os === 'windows' ? 'python' : 'python3';
    }

    get commands() {
        return {
            apt: `${this.sudo}apt-get install -y python3 python3-pip`,
            dnf: `${this.sudo}dnf install -y python3 python3-pip`,
            pacman: `${this.sudo}pacman -S --noconfirm python python-pip`,
            zypper: `${this.sudo}zypper --non-interactive install python3 python3-pip`,
            apk: `${this.sudo}apk add --no-cache python3 py3-pip`,
            brew: 'brew install python3',
            choco: 'choco install -y python3'
        };
    }

    // NOT removable, deliberately, and this is the one exception to "every tool
    // has an inverse".
    //
    // On Debian and Ubuntu, apt itself is written in Python: `apt-get remove
    // python3` removes apt, leaving a machine with no package manager and no
    // way to put one back. dnf is the same on Fedora. There is no wording of a
    // confirmation prompt that makes that a recoverable mistake, so it is
    // refused rather than offered — and `cleanup --yes --all` cannot override a
    // refusal.
    //
    // If a future version needs this, the safe form is removing only
    // python3-pip, never the interpreter.
    // Added by Claude Code (claude-opus-5[1m])
    get refuseRemovalReason() {
        return 'removing the system Python would take the OS package manager ' +
            '(apt/dnf are written in Python) with it';
    }
}

module.exports = Python;
