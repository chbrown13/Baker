const PackageTool = require('./package-tool');

// A C++ toolchain: a compiler new enough for C++20, plus the headers and make
// that building anything real needs.
//
// Every manager splits this differently — Debian bundles it as a metapackage,
// Fedora and SUSE name the compiler itself, Arch and Alpine have their own
// build groups — which is exactly the case `tools:` exists for rather than a
// bare `packages:` entry.
//
// The presence check is `g++`, which is also what a Homebrew or Chocolatey
// install leaves on PATH. Note what it CANNOT see: a compiler that is present
// but too old. Ubuntu 20.04's build-essential is GCC 9, which fails C++20 —
// the bakelet will skip as "already installed" and the build will then fail in
// CMake. Assert the version with `baker check` if the project needs one.
// Added by Claude Code (claude-opus-5[1m])
class Cpp extends PackageTool {
    constructor(name, ansibleSSHConfig, version) {
        super(name, ansibleSSHConfig, version);
        this.binName = 'g++';
    }

    get commands() {
        return {
            apt: `${this.sudo}apt-get install -y build-essential`,
            dnf: `${this.sudo}dnf install -y gcc-c++ make`,
            pacman: `${this.sudo}pacman -S --noconfirm base-devel`,
            zypper: `${this.sudo}zypper --non-interactive install gcc-c++ make`,
            apk: `${this.sudo}apk add --no-cache build-base`,
            // Apple's clang normally arrives with the Xcode Command Line Tools,
            // which git already pulls in, so g++ usually exists and this is a
            // no-op. Where it does not, GCC from Homebrew is the installable
            // option — `xcode-select --install` is interactive and not
            // something a bake should drive.
            brew: 'brew install gcc',
            choco: 'choco install -y mingw'
        };
    }
}

module.exports = Cpp;
