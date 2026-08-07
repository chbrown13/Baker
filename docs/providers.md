# Providers

A provider is the target an environment is built against. Baker ships three. You never name one
directly — Baker infers it from the top-level keys in your `baker.yml`.

All three run **directly from your machine**. Baker used to route provisioning through a control VM
called `baker-srv`; that path, and the five providers that depended on it, were removed.

## How a provider is selected

`Baker.chooseProvider()` reads the config and tests keys in a fixed order. The first match wins:

| Priority | Key present | Provider |
|----------|-------------|----------|
| 1 | `docker:` | docker-local |
| 2 | `local:` | local |
| 3 | `remote:` | remote |

If none match, the bake stops before anything runs:

```
==> Error: no supported environment found in baker.yml.
Baker supports: local:, docker:, remote:
  local:  configure this machine
  docker: configure a container
  remote: configure a host over SSH
```

An empty `baker.yml`, or one that is a list rather than a mapping, gets the same treatment.

### Retired keys

`vm:`, `vagrant:`, `container:`, and `persistent:` selected the VirtualBox and runc providers. Both
are gone. These keys are checked **before** the supported ones, so a config carrying both `local:`
and `vm:` still gets the specific explanation rather than silently ignoring the dead half:

```
==> Error: 'vm:' is no longer supported.
Baker supports: local:, docker:, remote:
```

There is no compatibility shim and no override flag. Rewrite the config against one of the three
keys above.

## `local:` — the machine you are sitting at

Runs bakelets directly on the host. No VM, no container, no isolation. Good for workstation setup,
CI runners, and injecting configuration into a repository you already have.

```yaml
name: dev-env
local: {}          # the current directory
# local: ~/project  # or an explicit working directory
tools:
  - jupyter
packages:
  - jq
```

| | |
|---|---|
| **Requires** | a package manager (apt, dnf, pacman, zypper, apk, brew, or choco) |
| **Also requires, but only for `lang:`, `services:`, `custom:`** | Ansible and passwordless sudo |
| **Environment root** | the path given to `local:`, or the current directory for `local: {}` |
| **`baker ssh`** | opens `$SHELL` (falling back to `/bin/sh`) |
| **`baker destroy`** | removes `~/.baker/<name>/` — it does **not** uninstall anything |

On Windows, local commands run through PowerShell rather than `cmd.exe`.

**`destroy` is not an undo.** It forgets the environment; packages, tools, and placed files stay.
Use [`baker cleanup`](baker-commands.md#baker-cleanup) to reverse a bake.

## `docker:` — a container on your Docker daemon

Provisions a container against your existing Docker daemon.

```yaml
name: dev-box
docker: node:18              # string form: just the image
# docker: {}                 # defaults to ubuntu:latest
# docker: {image: ubuntu:22.04}
tools:
  - maven
start: npm start
```

| | |
|---|---|
| **Requires** | Docker |
| **Socket** | `DOCKER_HOST` if set, otherwise `/var/run/docker.sock` |
| **Default image** | `ubuntu:latest` |
| **Container name** | `name:`, or the current directory's basename if omitted |
| **`baker ssh`** | `docker exec -it <name> /bin/bash` |
| **`baker destroy`** | stops and removes the container |

The container starts with `tail -f /dev/null` so it stays alive for provisioning. Commands are
wrapped as `docker exec … /bin/bash -c '…'`, which is why bakelet command tables must not contain
single quotes.

Re-baking reuses a running container. A **stopped** container is removed and recreated rather than
restarted.

The target platform is detected inside the container, not on your laptop — so a macOS host baking
into an Ubuntu image resolves `apt`, not `brew`.

**`ports:` is not implemented for this provider.** The key is accepted and ignored; no port
bindings are configured.

## `remote:` — a server you already have

Configures a machine you can already reach over SSH.

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

`ip`, `user`, and `private_key` are required and validated before the provider is constructed; an
incomplete block aborts with `invalid baker.yml for remote provider`. `port` defaults to 22.

| | |
|---|---|
| **Requires** | SSH access; Ansible on the host and passwordless sudo on the target for the playbook-backed sections |
| **Inventory** | built inline: `<ip> ansible_connection=ssh ansible_user=… ansible_ssh_private_key_file=…` |
| **Staging dir** | `/home/vagrant/baker/<name>/` on the remote |
| **`baker destroy`** | removes the staging directory only — it does not deprovision the server |

The staging path is `/home/vagrant/baker/<name>` regardless of your actual username. It is a
holdover from the Vagrant-era layout, created with `mkdir -p`.

This is the only provider where the playbook-backed sections are comfortable, since sudo is
normally available on a server you administer.

## What each section needs

Bakelets divide by **what they need**, not by which provider runs them, so no bakelet has two
implementations:

| Tier | Sections | Needs Ansible? | Runs on |
|---|---|---|---|
| **Portable** | `files:`, `tools:`, `env:`, `config:`, `packages:`, `resources:`, `start:` | no | Linux, macOS, Windows |
| **Linux-target** | `lang:`, `services:`, `custom:`, and `tools: jekyll`/`dazed`/`defects4j` | yes | Linux targets only |

A bake that asks for a Linux-target section on a macOS or Windows target is **refused before
anything runs**, by the pre-flight gate. Nothing is written and nothing is installed.

The portable tier needs no Ansible and no sudo beyond what an individual package manager asks for,
which is what makes native Windows possible.

## Capability comparison

| | `local` | `docker` | `remote` |
|---|---|---|---|
| Needs a hypervisor | no | no | no |
| Needs Ansible on host | only for the Linux-target tier | only for the Linux-target tier | only for the Linux-target tier |
| Isolation | none | container | n/a |
| Port forwarding | n/a | **not implemented** | n/a |
| Works on a Windows target | yes | n/a (Linux container) | n/a |
| `destroy` reverses the bake | **no** | yes | **no** |
| `cleanup` reverses the bake | yes | yes | yes, least exercised |

`baker cleanup` is the supported way to undo a bake on every provider. See
[CLI reference](baker-commands.md#baker-cleanup).
