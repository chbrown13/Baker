const PackageTool = require('./package-tool');

// Jupyter, installed through pip rather than a system package.
//
// Deliberate: the notebook is packaged under a different name by nearly every
// distribution (jupyter-notebook, python3-notebook, py3-notebook, jupyterlab),
// while `pip install --user` is one spelling that works everywhere Python does.
// It also needs no elevation, which matters because this used to pull a dozen
// system packages through sudo.
// Added by Claude Code (claude-opus-5[1m])
class Jupyter extends PackageTool {
    constructor(name, ansibleSSHConfig, version) {
        super(name, ansibleSSHConfig, version);
        this.binName = 'jupyter';
    }

    // pip --user writes into the user's own site-packages.
    get requiresElevation() {
        return false;
    }

    get commands() {
        const pip3 = 'python3 -m pip install --user jupyter';
        return {
            apt: pip3, dnf: pip3, pacman: pip3, zypper: pip3, apk: pip3, brew: pip3,
            // The Windows launcher is `python`, not `python3`.
            choco: 'python -m pip install --user jupyter'
        };
    }

    // Installed with pip --user, so the inverse needs no elevation either.
    // Added by Claude Code (claude-opus-5[1m])
    get uninstallCommands() {
        const pip3 = 'python3 -m pip uninstall -y jupyter';
        return {
            apt: pip3, dnf: pip3, pacman: pip3, zypper: pip3, apk: pip3, brew: pip3,
            choco: 'python -m pip uninstall -y jupyter'
        };
    }
}

module.exports = Jupyter;
