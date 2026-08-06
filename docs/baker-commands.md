# Baker CLI Reference

Run `baker <command> --help` for per-command flags and examples.

See also: [`baker.yml` reference](baker-yml-reference.md) ·
[Configuration sources](configuration-sources.md) · [Providers](providers.md)

---

## `bake`

Bake a VM/container/local environment from a `baker.yml`.

```
baker bake [source]
           [--local <path>] [--repo <url>] [--file <url>] [--box <path>]
           [--useContainer] [--useVM] [--verbose]
```

| Argument | Description |
|----------|-------------|
| `source` | Where the `baker.yml` comes from: a directory, `owner/repo`, `owner/repo:subdir`, or a URL. Always resolves to a directory containing a literal `baker.yml`. Omit to use `./baker.yml`. |

```bash
baker bake                                # ./baker.yml
baker bake ~/project                      # a directory containing baker.yml
baker bake ottomatica/baker-test          # clone a GitHub repo, use its baker.yml
baker bake your-org/configs:units/one     # clone, then use the baker.yml in units/one
baker bake https://gist.github.com/…      # a gist, snippet, or raw file URL
```

An address ending in `.yml` is rejected — that form belongs to `baker check`.

An existing local path always wins over the `owner/repo` shorthand. See
[Configuration sources](configuration-sources.md) for the full resolution order.

**Flags** — explicit overrides that bypass the positional resolver:

| Flag | Alias | Description |
|------|-------|-------------|
| `--local` | `-l` | Path to directory containing `baker.yml` |
| `--repo` | `-r` | Git repo URL to clone; `baker.yml` must be in its root |
| `--file` | `-f` | URL to a single `baker.yml` — gist, GitLab snippet, or raw file |
| `--box` | `-b` | Directory containing `baker.yml`; routes to `bakeBox` |
| `--useContainer` | | Force the runc container provider |
| `--useVM` | | Force the VirtualBox provider |
| `--verbose` | `-v` | Print Ansible variables and full playbook output |
| `--forceVirtualBox` | | macOS only: use VirtualBox instead of HyperKit for `baker-srv` (hidden, debug) |

The provider is chosen from the top-level keys in `baker.yml` — there is no provider flag. See
[Providers](providers.md#how-a-provider-is-selected).

> **`--remote` is broken.** The flags `--remote`, `--remote_key`, and `--remote_user` route to
> `BakerObj.bakeRemote()`, which does not exist, so they throw a `TypeError`. Use the `remote:`
> key in `baker.yml` instead — see [Providers](providers.md#remote--a-server-you-already-have).

---

## `boxes`

List existing Baker boxes (Vagrant boxes).

```
baker boxes
```

---

## `cluster`

Bake a cluster from a `baker.yml`.

```
baker cluster --local <path> [--repo <url>] [--verbose]
```

| Flag | Alias | Description |
|------|-------|-------------|
| `--local` | `-l` | Path to directory containing `baker.yml` |
| `--repo` | `-r` | Git repo URL to clone |
| `--verbose` | `-v` | Verbose output |

---

## `check`

Run [opunit](https://github.com/ottomatica/opunit) checks to verify an environment is
configured correctly. This command delegates to the `opunit` CLI, which must be installed
and on your `PATH` (`npm install -g ottomatica/opunit`).

```
baker check [target]
```

| Argument | Description |
|----------|-------------|
| `target` | A profile address `<user>/<repo>:<file.yml>`. Omit to run local checks. |

**Two modes:**

| Invocation | Delegates to | Runs against |
|------------|--------------|--------------|
| `baker check` | `opunit verify local` | the local machine, using `test/opunit.yml` |
| `baker check <user>/<repo>:<file.yml>` | `opunit profile <address>` | the local machine, using a checks file fetched from GitHub |

The profile address form (e.g. `your-org/profiles:env.yml`) fetches
`https://raw.githubusercontent.com/<user>/<repo>/master/<file>` and runs it — identical to
`opunit profile your-org/profiles:env.yml`.

Opunit's output streams through directly, and its exit code is propagated, so
`baker bake && baker check` works in CI.

---

## `cleanup`

Remove what a bake put on this machine — the inverse of `bake`. Where `destroy` tears down the
*environment*, `cleanup` undoes an *injection*: the files, config, environment variables, cloned
repositories, and tools a bake placed on a machine you keep using.

```
baker cleanup [source]
```

`source` takes the same grammar as `bake` — a directory, `owner/repo[:subdir]`, or a URL. Omit it to
use `./baker.yml`.

| Flag | Description |
|------|-------------|
| `--dry-run` | Print the full plan and exit. No prompts, no changes, nothing logged |
| `--yes`, `-y` | Non-interactive: accept the default answer for every prompt |
| `--all` | With `--yes`, select everything not refused. Requires `--yes`; cannot override a guard |
| `--verbose`, `-v` | Extra output from the removal process |

### How it decides what to remove

Cleanup re-derives the file set from the same config `bake` used, rather than scanning your project
for anything that looks like Baker's. **A file Baker never placed can therefore never be removed** —
it is not in the set. Directories are deleted only once empty, so one holding your own work survives.

Defaults follow a risk gradient, and every one is overridable at the prompt:

| Section | Default | Why |
|---|---|---|
| `files:`, `config:`, `env:` | **remove** | Baker placed them, in a scope Baker owns |
| `tools:` | **keep** | Baker cannot tell whether it installed a tool or found it already there |
| cloned repositories | **keep** | May hold work of yours |

### Guards you cannot override

A cloned repository with uncommitted changes, untracked files, or unpushed commits is **refused** —
not offered, not selectable, and unaffected by `--all`. So is a clone destination that exists but
is not a git repository. Only a clean clone is removable, because only a clean clone is recoverable
from its remote.

### Two limitations it states on every run

- **Files Baker placed are Baker's.** A file you edited is still deleted; anything you need to keep
  belongs on a path Baker does not write.
- **Cleanup inverts the config it is given.** If the config changed since you baked, files from the
  older version are not in the derived set and remain behind. The output names the directory where
  they would be.

Sections with no inverse yet — `lang:`, `services:`, `packages:`, `custom:`, `start:` — are reported
and left alone at every flag combination.

Every run appends to `~/.baker/cleanup.log` with a restore hint per item. That file stays on your
machine and is never transmitted.

---

## `delete` / `destroy`

Remove a VM/container and its associated files.

```
baker delete [VMName]
baker destroy [VMName]
```

| Flag | Description |
|------|-------------|
| `--useContainer` | Override environment type to container |
| `--useVM` | Override environment type to VM |

Reads `baker.yml` from current directory if no name given.

`destroy` removes the environment; it does **not** remove what the bakelets put on the machine.
Use [`cleanup`](#cleanup) for that.

---

## `docker`

Manage Docker-based environments.

```
baker docker <command> [--local <path>]
```

**Sub-commands:**

| Command | Description |
|---------|-------------|
| `bake` | Provision a container from `baker.yml` |
| `start` | Start a container (blank, no bakelets) |
| `stop` | Stop a container |
| `destroy` | Remove a container |
| `list` | List containers |
| `ssh` | SSH into a container |
| `images` | List Docker images |

| Flag | Alias | Description |
|------|-------|-------------|
| `--local` | `-l` | Path to directory containing `baker.yml` |

---

## `halt` / `stop`

Shut down a VM.

```
baker halt [VMName]
baker stop [VMName]
```

| Flag | Alias | Description |
|------|-------|-------------|
| `--force` | `-f` | Force shutdown |

Reads `baker.yml` from current directory if no name given.

---

## `import`

Import a packaged Baker environment (`.box` file).

```
baker import <boxPath> [--name <name>] [--verbose]
```

| Argument | Description |
|----------|-------------|
| `boxPath` | Path to the `.box` file |

| Flag | Alias | Description |
|------|-------|-------------|
| `--name` | `-n` | Name for the imported box |
| `--verbose` | `-v` | Verbose output |

---

## `info`

Show information about a Baker environment.

```
baker info <envName> [--verbose] [--provider <provider>]
```

| Argument | Description |
|----------|-------------|
| `envName` | Name of the environment |

| Flag | Alias | Description |
|------|-------|-------------|
| `--verbose` | `-v` | Extended information |
| `--provider` | `-p` | Provider-specific info (e.g. `digitalocean`) |

---

## `init`

Create a `baker.yml` in the current directory via interactive prompts.

```
baker init
```

---

## `package`

Package a Baker VM into a `.box` file.

```
baker package <VMName> [--verbose]
```

| Argument | Description |
|----------|-------------|
| `VMName` | Name of the VM to package |

| Flag | Alias | Description |
|------|-------|-------------|
| `--verbose` | `-v` | Verbose output |

---

## `run`

Run a registered cmdlet inside a Baker environment.

```
baker run [cmdlet] [--useContainer] [--useVM]
```

| Argument | Description |
|----------|-------------|
| `cmdlet` | Command key from `commands:` section in `baker.yml` |

Cmdlets are defined in `baker.yml`:
```yaml
commands:
  test: pytest tests/
  lint: eslint .
```

Running `baker run test` executes `pytest tests/` inside the environment.
Running `baker run` with no match lists available cmdlets.

---

## `server`

Manage the Baker server VM (used for provisioning).

```
baker server <cmdlet> [name]
```

**Sub-commands:**

| Command | Description |
|---------|-------------|
| `ssh` | SSH into the Baker server |
| `repair <name>` | Repair a broken environment (e.g. locked dpkg) |
| `reload` | Stop and start the Baker server |
| `stop` | Stop the Baker server |

| Flag | Description |
|------|-------------|
| `--forceVirtualBox` | Force VirtualBox on Mac (debug only) |

---

## `setup`

Install the Baker server VM (the control machine used for provisioning).

```
baker setup [--force]
```

| Flag | Alias | Description |
|------|-------|-------------|
| `--force` | `-f` | Destroy existing server first, then create new one |

Validates system dependencies (VirtualBox, Vagrant) before installing.

---

## `setupmac`

macOS-specific Baker server setup.

```
baker setupmac [--force] [--ssh]
```

| Flag | Alias | Description |
|------|-------|-------------|
| `--force` | `-f` | Reconfigure Baker for Mac |
| `--ssh` | | SSH into the Baker for Mac VM directly |

---

## `ssh`

SSH into a Baker environment.

```
baker ssh [VMName] [--useContainer] [--useVM]
```

Reads `baker.yml` from current directory if no name given.

---

## `start` / `up`

Start a VM or container.

```
baker start [VMName]
baker up [VMName]
```

Reads `baker.yml` from current directory if no name given.

---

## `status`

Show virtualization support status and list all Baker environments.

```
baker status
```

Checks for hardware virtualization (VT-x/AMD-V) and then lists all VMs,
containers, and local boxes.

---

## `vault`

Encrypt, decrypt, or view an Ansible Vault file.

```
baker vault [file] [--view] [--decrypt] [--clear]
```

| Argument | Description |
|----------|-------------|
| `file` | File to encrypt/decrypt |

| Flag | Alias | Description |
|------|-------|-------------|
| `--view` | `-v` | View decrypted content (prompts for passphrase) |
| `--decrypt` | `-u` | Decrypt and write to file |
| `--clear` | `-c` | Clear stored vault passphrase |

The passphrase is stored per-directory (prompted once, cached in configstore).
