# Core concepts

Four ideas cover most of how Baker works: the **environment**, the **provider**, the **bakelet**,
and the **execution mode** that connects the last two.

## Environments

An environment is one `baker.yml` plus whatever Baker provisioned from it. It has a `name:`, which
Baker uses as the VM name, the container name, the directory under `~/.baker/`, and the key in the
environment index at `~/.baker/data/index.json`.

Most commands operate on the environment described by the `baker.yml` in your current directory.
Commands that take a name (`baker ssh <name>`, `baker destroy <name>`) look it up in the index
instead.

## Providers

A provider is the backend that hosts an environment. Baker ships eight, and selects one
automatically from the top-level keys in your `baker.yml` — there is no `provider:` key.

```yaml
local: {}        # → LocalProvider          — your machine
docker: node:18  # → DockerLocalProvider    — a container on your Docker daemon
remote: {...}    # → RemoteProvider         — a server you already have
```

Selection is first-match against a fixed priority order, so a file with both `docker:` and `local:`
gets the Docker provider. There is no provider flag — the config decides.

The retired keys `vm:`, `vagrant:`, `container:`, and `persistent:` are checked first and rejected
with a message naming the three above. See
[Providers](providers.md#how-a-provider-is-selected).

## Bakelets

A bakelet is one installable unit — a language runtime, a tool, a service, a set of packages. Each
one is a small JavaScript class that pairs with an Ansible playbook.

Bakelets are grouped into categories, and each category is a top-level list in `baker.yml`:

```yaml
lang:      [python3, nodejs9]     # language runtimes
tools:     [jupyter, maven]       # developer tools
services:  [mysql5.7, docker]     # background services
packages:  [curl, git]            # OS packages
config:    [...]                  # templated files, SSH keys, vault secrets
resources: [...]                  # git clones and other external material
env:       [...]                  # environment variables
custom:    [...]                  # your own Ansible playbooks
```

Every bakelet has the same two-phase lifecycle:

1. **`load()`** — stage what's needed on the target: copy or render the Ansible playbook, read
   options out of the YAML entry, collect variables.
2. **`install()`** — execute it, usually by calling `Ansible.runAnsiblePlaybook`.

Two base methods, `copy()` and `exec()`, move files and run commands *on the target*. Bakelets
call these rather than talking to SSH or Docker themselves, which is what lets the same bakelet
work across every provider.

### Execution order

Bakelets run in a **fixed category order**, not the order they appear in your file:

```
lang → config → services → tools → packages → resources → env → custom → start
```

Within a category, entries run top to bottom. If you need a tool installed before a service, that
ordering is not expressible today — see [Troubleshooting](troubleshooting.md).

### Version suffixes

Most bakelet names accept a version appended directly to the name. A regex splits the trailing
digits off the alphabetic prefix:

| Written | Bakelet | Version | Playbook used |
|---------|---------|---------|---------------|
| `python3` | python | `3` | `lang/python/python3.yml` |
| `nodejs9` | nodejs | `9` | `lang/nodejs/nodejs9.yml` |
| `neo4j3.3` | neo4j | `3.3` | `services/neo4j/neo4j3.3.yml` |
| `jupyter` | jupyter | *(none)* | `tools/jupyter/jupyter.yml` |

Because the version selects a playbook filename, only versions with a matching playbook in
`remotes/bakelets-source/` actually work. [Bakelets](bakelets.md) lists what exists.

## Execution modes

This is the piece that ties providers to bakelets, and the part worth understanding if anything
surprises you.

Bakelets are written once, against `this.copy()`, `this.exec()`, and `this.execCapture()`. The
resolver (`lib/bakelets/resolve.js`) builds **one transport per bake** and every bakelet in that
bake shares it. There are three modes:

| Mode | Used by | `exec()` becomes | Ansible runs |
|------|---------|------------------|--------------|
| **local** | `local:` | `child_process.execSync` on the host (PowerShell on Windows) | on the host, `-c local` |
| **remote** | `remote:` | SSH to the remote host | on the host, over SSH to the remote |
| **docker** | `docker:` | `docker exec <container>` | on the host, `ansible_connection=docker` |

All three run straight from your machine. Baker previously routed provisioning through a control VM
called `baker-srv`; that mode, and the providers that needed it, were removed.

In local mode the transport also rewrites the `/home/vagrant/baker/<name>/` prefix bakelets use to
address the target, pointing it at the real location — a holdover from the control-VM layout that
bakelets still write against.

For the playbook-backed sections the resolver temporarily swaps the static methods on the `Ansible`
module so playbook, template, and directory operations target the right transport. See
[Architecture](architecture.md#mode-patching).

## The two tiers

Bakelets divide by **what they need**, not by which transport runs them, so no bakelet has two
implementations and nothing can drift:

| Tier | Sections | Needs Ansible? | Runs on |
|---|---|---|---|
| **Portable** | `files:`, `tools:`, `env:`, `config:`, `packages:`, `resources:`, `start:` | no | Linux, macOS, Windows |
| **Linux-target** | `lang:`, `services:`, `custom:`, `tools: jekyll`/`dazed`/`defects4j` | yes | Linux targets only |

A playbook-backed bakelet declares `requiresAnsible`, and the pre-flight gate refuses the bake on a
non-Linux target **before anything runs**. The portable tier installs through per-manager command
tables, so a new distribution costs one table entry rather than a branch in every bakelet.

## Variables

`vars:` in `baker.yml` becomes Ansible extra-vars, passed to every playbook:

```yaml
vars:
  - app_env: production
  - mysql_password:
      prompt: Type your password for mysql server
```

An entry whose value is an object containing `prompt:` triggers an interactive prompt at bake time,
and the answer replaces the object. This is how secrets stay out of the file.

Baker injects one variable of its own: `BAKER_SHARE_DIR`, set to `/<basename-of-project-dir>` —
where your project is mounted on the target.

## Commands

`commands:` registers named commands that `baker run` executes inside the environment:

```yaml
commands:
  serve: npm start
  test: npm test
```

`baker run test` runs `cd /<project-dir>; npm test` on the target. `baker run` with no argument
lists what's available.

This is distinct from `start:`, which is a single command run automatically at the end of a bake,
in the background.
