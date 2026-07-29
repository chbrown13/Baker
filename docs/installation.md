# Installation

## Install Baker

### From source

```bash
git clone https://github.com/ottomatica/Baker
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

Note that the `pkg` targets are pinned to Node 10. The binaries bundle `config/`, `remotes/`, and
`lib/`, so bakelet playbooks ship inside the executable.

## Runtime requirements

Baker itself needs **Node.js >= 7.10.0**. Everything else depends on which provider you use — you
only need the dependencies for the providers you actually run.

| Dependency | Required by |
|------------|-------------|
| **Ansible** (on the host) | `local:`, `docker:`, `remote:` |
| **Ansible** (on `baker-srv`) | `vm:`, `vagrant:`, `container:` — installed for you |
| **Docker** | `docker:`, `container:` |
| **VirtualBox** | `vm:`, `vagrant:`, and `baker-srv` on Linux/Windows |
| **Vagrant** | `vagrant:` |
| **git** | cloning `baker.yml` sources, the `resources: git` bakelet, agentic config repos |
| **opunit** | `baker check` only |

### Ansible

The host-direct providers (`local`, `docker`, `remote`) run `ansible-playbook` from your machine,
so Ansible must be installed and on your `PATH`:

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

The control-VM providers do **not** need Ansible on the host — it lives on `baker-srv` instead.

### opunit (optional)

Only needed for `baker check`:

```bash
npm install -g ottomatica/opunit
```

## Provider-specific setup

### Local provider

Bakelet playbooks run with `become: yes`, so the target account needs **passwordless sudo**:

```bash
sudo visudo
# add:
your-username ALL=(ALL) NOPASSWD: ALL
```

Without this, bakelets fail with `sudo: a password is required`. See
[Troubleshooting](troubleshooting.md#sudo-in-host-direct-modes) — this is a known limitation, not
a misconfiguration on your part.

### Docker provider (`docker:`)

Baker talks to your local Docker daemon over `/var/run/docker.sock`, or `DOCKER_HOST` if set. Your
user needs permission to reach the socket:

```bash
sudo usermod -aG docker $USER   # then log out and back in
```

Ansible reaches into the container with `ansible_connection=docker`, so Ansible must be on the
host, not in the image.

### Control-VM providers (`vm:`, `container:`, `vagrant:`)

These provision *through* a small Alpine control VM named `baker-srv`, which Baker installs the
first time you bake. On Linux and Windows that VM runs under VirtualBox. On macOS it runs under
HyperKit by default (pass `--forceVirtualBox` to override).

Install it explicitly with:

```bash
baker setup           # or: baker setupmac    on macOS
baker setup --force   # destroy and recreate
```

`baker setup` validates that VirtualBox and Vagrant are present before installing. See
[Providers](providers.md#the-baker-srv-control-vm) for what the VM actually does.

## Where Baker keeps state

| Path | Contents |
|------|----------|
| `~/.baker/` | Per-environment directories, boxes, SSH keys |
| `~/.baker/baker_rsa` | Private key used to reach `baker-srv` and provisioned VMs |
| `~/.baker/data/index.json` | Registry of known environments (name, path, type, connection info) |
| `~/.baker/ansible-srv/` | Vagrant working directory for the Ansible control VM |
| `~/Library/Baker/BakerForMac/` | macOS-only: HyperKit binaries, kernel, filesystem image |

Configuration such as cached vault passphrases lives in a
[configstore](https://github.com/yeoman/configstore) file under your platform's standard config
directory.

## Verify the install

```bash
baker --version
baker status        # checks hardware virtualization, lists environments
```

`baker status` reports whether VT-x/AMD-V is available and enumerates every environment Baker
knows about across VirtualBox, runc, local, and Docker.
