# Baker 🍞

Baker provisions development environments from a declarative `baker.yml` file. You describe what
an environment needs — languages, tools, services, packages, config files — and `baker bake`
builds it against whatever substrate you have available: your own machine, a Docker container, a
VM, or a remote server.

It combines the roles of Vagrant, Docker, Ansible, and a task runner into a single tool with one
config file.

```yaml
name: dev-env
local: {}
lang:
  - python3
tools:
  - jupyter
start: jupyter notebook --no-browser
```

```bash
baker bake      # provision it
baker ssh       # get a shell in it
baker run test  # run a command inside it
baker destroy   # tear it down
```

## Documentation

**Getting started**

- [Installation](installation.md) — install Baker and the per-provider prerequisites
- [Getting started](getting-started.md) — build your first environment end to end
- [Core concepts](concepts.md) — environments, providers, bakelets, and execution modes

**Reference**

- [`baker.yml` reference](baker-yml-reference.md) — every key in the config file
- [CLI reference](baker-commands.md) — every command and flag
- [Providers](providers.md) — the eight provisioning backends and how one gets selected
- [Bakelets](bakelets.md) — the catalog of installable units
- [Configuration sources](configuration-sources.md) — the ways `baker bake` can find a `baker.yml`

**Going deeper**

- [Architecture](architecture.md) — internals, for contributors
- [Extending Baker](extending.md) — writing custom bakelets and providers
- [Troubleshooting](troubleshooting.md) — known issues, limitations, and common failures

## Which provider do I want?

Baker picks a provider from the top-level key in your `baker.yml`. The short version:

| You want | Use | Needs |
|----------|-----|-------|
| Set up your own machine or a CI runner | `local:` | Ansible, passwordless sudo |
| A throwaway container on your existing Docker | `docker:` | Docker, Ansible |
| A full VM with its own IP and port forwarding | `vm:` | VirtualBox |
| To configure a server you already have | `remote:` | Ansible, SSH access |

See [Providers](providers.md) for the complete list, including the control-VM-based backends
(`container:`, `vagrant:`) and DigitalOcean.

## Project status

Baker was originally built by [Ottomatica](https://github.com/ottomatica/Baker) and is now
maintained here for personal and learning use. There are no backward-compatibility obligations to
upstream, but the `baker` name and the `baker.yml` schema are kept intact.

The upstream documentation site (`docs.getbaker.io`) is stale. **These pages are the current
source of truth.**
