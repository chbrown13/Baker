# Providers

A provider is the backend that hosts an environment. Baker ships eight. You never name one
directly — Baker infers it from the top-level keys in your `baker.yml`.

## How a provider is selected

`Baker.chooseProvider()` reads the config and tests keys in a **fixed priority order**. The first
match wins:

| Priority | Key present | Provider | Class |
|----------|-------------|----------|-------|
| 1 | `docker:` | docker-local | `DockerLocalProvider` |
| 2 | `local:` | local | `LocalProvider` |
| 3 | `container:` or `persistent:` | runc | `RuncProvider` |
| 4 | `vm:` or `vagrant:` | virtualbox | `VirtualBoxProvider` |
| 5 | `remote:` | remote | `RemoteProvider` |

If none match, Baker prints `This command only supports VM, container, docker, and local
environments` and does nothing.

Two flags override the inferred choice, mainly for debugging:

```bash
baker bake --useContainer   # force RuncProvider
baker bake --useVM          # force VirtualBoxProvider
```

Note that `vagrant:` currently resolves to **`VirtualBoxProvider`**, not `VagrantProvider` — the
Vagrant branch is commented out in the selection logic. `VagrantProvider` is still used internally
for `baker-srv` management and SSH config lookups.

## Host-direct providers

These three run Ansible from your machine and never touch `baker-srv`. They are the actively
developed path.

### `local:` — your own machine

Runs bakelets directly on the host. No VM, no container, no isolation. Good for workstation setup
and CI runners.

```yaml
name: dev-env
local: {}          # current directory
# local: ~/project  # or an explicit working directory
lang:
  - python3
tools:
  - jupyter
```

| | |
|---|---|
| **Requires** | Ansible on the host, passwordless sudo |
| **`baker ssh`** | opens `$SHELL` in `~/.baker/<name>/` |
| **`baker destroy`** | removes `~/.baker/<name>/` — it does **not** uninstall anything |
| **State** | a `.running` marker file under `~/.baker/<name>/` |

Ansible runs as `ansible-playbook -i "localhost," -c local` from the working directory.

Because there is nothing to tear down, `destroy` only forgets the environment. Packages, services,
and languages installed on your machine stay installed. Treat `local:` as additive.

### `docker:` — a container on your Docker daemon

Provisions a container against your existing Docker daemon. No VM, and no `baker-srv`.

```yaml
name: dev-box
docker: node:18              # string form: just the image
# docker: {}                 # defaults to ubuntu:latest
# docker: {image: ubuntu:22.04}
lang:
  - python3
tools:
  - jupyter
start: jupyter notebook --no-browser
```

| | |
|---|---|
| **Requires** | Docker, Ansible on the host |
| **Socket** | `DOCKER_HOST` if set, otherwise `/var/run/docker.sock` |
| **Container name** | `name:`, or the current directory's basename if omitted |
| **`baker ssh`** | `docker exec -it <name> /bin/bash` |
| **`baker destroy`** | stops and removes the container |

The container is started with `tail -f /dev/null` as its command so it stays alive for
provisioning. Ansible reaches in with `ansible_connection=docker` and `ansible_user=root`, which
is why Ansible must be on the host rather than in the image.

Re-baking an existing environment reuses a running container. A **stopped** container is removed
and recreated rather than restarted.

### `remote:` — a server you already have

Provisions a machine you can already reach over SSH. Ansible runs from your host against it.

```yaml
name: staging
remote:
  ip: 10.0.0.5
  user: ubuntu
  private_key: ~/.ssh/id_rsa
  port: 22
lang:
  - nodejs9
```

All four sub-keys except `port` are required and validated before the provider is constructed; an
incomplete `remote:` block aborts the bake with `invalid baker.yml for remote provider`.

| | |
|---|---|
| **Requires** | Ansible on the host, SSH access, passwordless sudo on the target |
| **Inventory** | built inline: `<ip> ansible_connection=ssh ansible_user=... ansible_ssh_private_key_file=...` |
| **Staging dir** | `/home/vagrant/baker/<name>/` on the remote |
| **`baker destroy`** | removes the staging directory only — it does not deprovision the server |

Note the staging path is `/home/vagrant/baker/<name>` regardless of your actual username. It's a
holdover from the Vagrant-era layout and is created with `mkdir -p`.

## Control-VM providers

These route provisioning through `baker-srv`. They are the original design and remain useful when
you want real VM isolation or an IP of your own.

### `vm:` — a VirtualBox VM

```yaml
name: onboard
vm:
  ip: 192.168.8.8
  ports: 8080
  memory: 2048
  cpus: 2
lang:
  - java8
services:
  - mysql8
```

Baker creates the VM, injects `baker_rsa.pub` as an authorized key, shares your project directory
into the guest at `/<project-basename>`, and configures NAT port forwarding from `ports:`.

`ports:` accepts a comma-separated string. `"8000, 9000, 1000:3000"` forwards 8000→8000,
9000→9000, and guest 1000→host 3000.

| | |
|---|---|
| **Requires** | VirtualBox; `baker-srv` (auto-installed) |
| **Defaults** | 1024 MB RAM, 2 CPUs |
| **`baker ssh`** | SSH into the guest via `baker_rsa` |

### `container:` / `persistent:` — an OCI container via runc

Runs an OCI container **on `baker-srv`**, not on your local Docker daemon. This predates the
`docker:` provider; unless you specifically want the runc path, prefer `docker:`.

```yaml
name: baker-docs
container:
  ports: 8000
lang:
  - python2
```

Port exposure goes through `vpnkit-expose-port` on `baker-srv` (or VirtualBox NAT rules on
Windows).

### `vagrant:` — Vagrantfile-driven VMs

Accepts Vagrant-shaped configuration (`box:`, `network:`, `synced_folders:`). As noted above, the
`vagrant:` key currently dispatches to `VirtualBoxProvider`.

## Cloud

### DigitalOcean

`DO_Provider` manages droplets and is reachable through `baker info <name> --provider digitalocean`.
It reads a token from the `DOTOKEN` environment variable and keeps per-environment state in
`~/.baker/<name>/`. There is no `digitalocean:` key in `baker.yml` — it is not wired into
`chooseProvider`, so it cannot currently be selected by a bake.

## The `baker-srv` control VM

`baker-srv` is a 1 GB Alpine VM whose only job is to run Ansible on behalf of the control-VM
providers. Baker installs it on first use.

| | |
|---|---|
| **Image** | `alpine.iso` from the `ottomatica/baker-release` GitHub release, MD5-verified |
| **Hypervisor** | VirtualBox on Linux/Windows; HyperKit on macOS unless `--forceVirtualBox` |
| **SSH** | `localhost:6022`, user `root`, key `~/.baker/baker_rsa` |
| **Shares** | your filesystem root bind-mounted at `/share` |
| **Swap** | 2 GB swapfile, `vm.swappiness=40` |
| **Staging** | per-environment playbooks under `/home/vagrant/baker/<name>/` |

Manage it directly:

```bash
baker setup              # install
baker setup --force      # destroy and reinstall
baker setupmac           # macOS-specific setup
baker server ssh         # shell into it
baker server reload      # stop and start
baker server stop
baker server repair <env>  # fix a wedged environment (e.g. locked dpkg)
```

On macOS, Baker downloads a kernel and filesystem image into `~/Library/Baker/BakerForMac/` and
runs HyperKit under `screen`, with `vpnkit` for networking and `u9fs` for the file share.

## Capability comparison

| | `local` | `docker` | `remote` | `vm` | `container` |
|---|---|---|---|---|---|
| Needs `baker-srv` | no | no | no | **yes** | **yes** |
| Needs Ansible on host | **yes** | **yes** | **yes** | no | no |
| Needs a hypervisor | no | no | no | **yes** | **yes** |
| Isolation | none | container | n/a | full VM | container |
| Port forwarding | n/a | not configured | n/a | yes | yes |
| Own IP address | no | container IP | existing | yes | no |
| `destroy` reverses the bake | **no** | yes | **no** | yes | yes |
| `config: keys` / `template` work | **no** | **no** | yes | yes | yes |

The last row is a known gap — those two bakelets call SSH directly instead of going through
`this.copy()`. See [Troubleshooting](troubleshooting.md#bakelets-that-bypass-the-transport).
