const PackageTool = require('./package-tool');

// A LaTeX toolchain sufficient to build a document with latexmk.
//
// This is the bakelet whose package names diverge most: every distribution
// splits TeX Live differently, and macOS and Windows use entirely different
// distributions (MacTeX and MikTeX). Names below are the documented ones for
// each manager; they are also the most likely entries in this repo to go stale.
// Added by Claude Code (claude-opus-5[1m])
class Latex extends PackageTool {
    constructor(name, ansibleSSHConfig, version) {
        super(name, ansibleSSHConfig, version);
        this.binName = 'pdflatex';
    }

    get commands() {
        return {
            apt: `${this.sudo}apt-get install -y texlive-latex-base texlive-latex-extra texlive-latex-recommended texlive-fonts-recommended latexmk`,
            dnf: `${this.sudo}dnf install -y texlive-scheme-basic texlive-latexmk`,
            pacman: `${this.sudo}pacman -S --noconfirm texlive-core texlive-latexextra`,
            zypper: `${this.sudo}zypper --non-interactive install texlive-latex texlive-latexmk`,
            apk: `${this.sudo}apk add --no-cache texlive texmf-dist-latexextra`,
            brew: 'brew install --cask basictex',
            choco: 'choco install -y miktex'
        };
    }
}

module.exports = Latex;
