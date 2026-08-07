# Installation

## Install Baker

### From source

```bash
git clone <this-repo>
cd Baker
npm install
npm link
```

`npm link` puts `baker` on your `PATH`. Verify with `baker --version`.

### Prebuilt binaries

The repo can build standalone binaries with [`pkg`](https://github.com/vercel/pkg):

```bash
npm run build-linux     # → installers/linux/executable/baker
npm run build-macos     # → installers/macos/bin/baker
npm run build-win       # → installers/win/bin/baker.exe
```

Packaging targets that produce installers:

```bash
npm run package-linux   # builds a .deb into installers/linux/deb/
npm run package-macos   # builds a macOS package
```

The `pkg` targets are pinned to Node 10. The binaries bundle `config/`, `remotes/`, and `lib/`, so
bakelet playbooks ship inside the executable.

## Runtime requirements

Baker itself needs **Node.js >= 7.10.0**. Everything else depends on what your `baker.yml` asks
for.

| Dependency | Required by |
|------------|-------------|
| **A package manager** | any bake — apt, dnf, pacman, zypper, apk, brew, or choco |
| **Ansible** (on the host) | only `lang:`, `services:`, `custom:`, and `tools: jekyll`/`dazed`/`defects4j` |
| **Docker** | the `docker:` provider |
| **SSH access** | the `remote:` provider |
| **git** | cloning `baker.yml` sources, the `resources: git` bakelet, agentic config repos |
| **opunit** | `baker check` only |

Most configs need **neither Ansible nor sudo**. The portable tier — `files:`, `tools:`, `env:`,
`config:`, `packages:`, `resources:`, `start:` — runs as plain commands through whichever
package manager the target has. That is what makes native Windows possible.

A bake that asks for a playbook-backed section on a non-Linux target is **refused before anything
runs**, rather than failing partway through.

### Ansible (only if you need it)

```bash
# Fedora / RHEL
sudo dnf install ansible

# Debian / Ubuntu
sudo apt install ansible

# macOS
brew install ansible

# any platform
pipx install ansible
```

### opunit (optional)

Only needed for `baker check`:

```bash
npm install -g ottomatica/opunit
```

## Per-provider setup

### `local:`

Nothing to install beyond a package manager. Individual package managers may prompt for `sudo`;
Baker computes whether to prefix commands with `sudo` from the target's user id, so running as
root — in a container, for instance — works without one.

**If your config uses the playbook-backed sections**, those still run with `become: yes`, so the
account needs passwordless sudo:

```bash
sudo visudo
# add:
your-username ALL=(ALL) NOPASSWD: ALL
```

Without it, those bakelets fail with `sudo: a password is required`. See
[Troubleshooting](troubleshooting.md#sudo-and-the-playbook-backed-tier) — a known limitation of
that tier, not a misconfiguration.

On **Windows**, Chocolatey cannot self-elevate, so a bake needing it is refused unless the shell is
already Administrator. Nothing is written when that check fails.

### `docker:`

Baker talks to your local Docker daemon over `/var/run/docker.sock`, or `DOCKER_HOST` if set. Your
user needs permission to reach the socket:

```bash
sudo usermod -aG docker $USER   # then log out and back in
```

The target platform is detected **inside the container**, so a macOS host baking into an Ubuntu
image resolves `apt`.

### `remote:`

You need SSH access with a key. For the playbook-backed sections, the remote account also needs
passwordless sudo — normally unremarkable on a server you administer.

## Where Baker keeps state

| Path | Contents |
|------|----------|
| `~/.baker/` | Per-environment state directories |
| `~/.baker/cache/` | Resolved `baker.yml` sources, keyed by host and repo path |
| `~/.baker/bake.log` | Failure output, with `env:` values redacted |
| `~/.baker/cleanup.log` | What `baker cleanup` removed, with a restore hint per item |
| `~/.baker/data/index.json` | Registry of known environments |

**Everything Baker records stays on the machine it runs on.** There is no telemetry and nothing is
transmitted anywhere.

## Verify the install

```bash
baker --version
baker bake --help
```
