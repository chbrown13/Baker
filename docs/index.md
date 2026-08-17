# Baker 🍞

Baker configures development environments from a declarative `baker.yml` file. You describe what
an environment needs — languages, tools, services, packages, config files — and `baker bake`
builds it against one of three targets: your own machine, a Docker container, or a remote server
over SSH.

The same config works on Linux, macOS, and Windows. Baker installs packages with whatever package
manager the target has.

```yaml
name: dev-env
local: {}
tools:
  - jupyter
packages:
  - jq
start: jupyter notebook --no-browser
```

```bash
baker init      # write that file for you, interactively
baker bake      # configure it
baker check     # verify the result
baker cleanup   # undo what the bake placed
```

## Documentation

**Getting started**

- [Installation](installation.md) — install Baker and the per-target prerequisites
- [Getting started](getting-started.md) — build your first environment end to end
- [Core concepts](concepts.md) — environments, providers, bakelets, and execution modes

**Reference**

- [`baker.yml` reference](baker-yml-reference.md) — every key in the config file
- [CLI reference](baker-commands.md) — every command and flag
- [Providers](providers.md) — the three targets and how one gets selected
- [Bakelets](bakelets.md) — the catalog of installable units
- [Configuration sources](configuration-sources.md) — the ways `baker bake` can find a `baker.yml`

**Going deeper**

- [Architecture](architecture.md) — internals, for contributors
- [Extending Baker](extending.md) — writing custom bakelets and providers
- [Troubleshooting](troubleshooting.md) — known issues, limitations, and common failures

## Which target do I want?

Baker picks a provider from the top-level key in your `baker.yml`:

| You want | Use | Needs |
|----------|-----|-------|
| Set up the machine you are sitting at, or a CI runner | `local:` | A package manager |
| A throwaway container on your existing Docker | `docker:` | Docker |
| To configure a server you already have | `remote:` | SSH access |

Most sections — `files:`, `tools:`, `env:`, `config:`, `packages:`, `resources:`, `start:` — need
neither Ansible nor sudo. Only `lang:`, `services:`, and `custom:` do, and those require a Linux
target. See [Providers](providers.md).

## What Baker records

Baker writes only under `~/.baker/` — resolved sources in `cache/`, a `bake.log`, and
per-environment state. **Nothing is transmitted anywhere.** There is no telemetry and no
phone-home; everything Baker records stays on the machine it runs on.

## Project status

Baker was originally built by [Ottomatica](https://github.com/ottomatica/Baker) and is now
maintained here. There are no backward-compatibility obligations to upstream, but the `baker` name
and the `baker.yml` schema are kept intact.

Baker previously supported VirtualBox, Vagrant, runc, and DigitalOcean, and provisioned through a
control VM called `baker-srv`. **All of that was removed.** Configs using `vm:`, `vagrant:`,
`container:`, or `persistent:` are rejected with a message naming the three supported keys.

The upstream documentation site (`docs.getbaker.io`) is stale. **These pages are the current
source of truth.**
