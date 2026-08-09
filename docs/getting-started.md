# Getting started

This walks through building an environment end to end. It uses the **local provider**, which needs
no VM and no container — bakelets run directly on your machine. Once the shape is familiar,
switching to a container or a remote host is a one-key change.

> **Before you start:** this walkthrough sticks to the *portable* sections, which need neither
> Ansible nor sudo — just a package manager. Adding `lang:` or `services:` moves you into the
> playbook-backed tier, which needs both and a Linux target. See
> [Installation](installation.md#extra-setup--only-if-you-are-told-you-need-it).

## 1. Create a `baker.yml`

In an empty project directory:

```yaml
name: hello-baker
local: {}
packages:
  - curl
  - git
  - jq
tools:
  - maven
```

Write this by hand. (`baker init` exists, but it currently produces a config `baker bake` rejects —
see [Troubleshooting](troubleshooting.md#baker-init-writes-a-config-baker-bake-rejects).)

What each key does:

- **`name:`** identifies the environment. Baker uses it for the state directory, the container
  name, and the entry in the environment index.
- **`local: {}`** selects the local provider and uses the current directory as the working
  location. `local: ~/some/path` points it elsewhere.
- **`packages:`**, **`tools:`** are *bakelets* — units of provisioning. `packages:` is a bare list
  of names installed with whatever package manager the target has. See
  [Bakelets](bakelets.md) for the full catalog.

## 2. Bake it

```bash
baker bake
```

Baker reads `./baker.yml`, selects the local provider from the `local:` key, detects your package
manager, and runs each bakelet in order. You'll see a spinner per bakelet — `Preparing maven`, then
`Installing maven`.

Before any of that, a pre-flight gate checks the target can support every section the config asks
for. A refused bake changes nothing at all.

Pass `--verbose` to see the full command output:

```bash
baker bake --verbose
```

## 3. Use the environment

```bash
baker ssh              # open a shell in the environment
baker check            # verify the result with opunit
```

For the local provider, `baker ssh` opens your `$SHELL`. For containers it is a `docker exec`
session, and for remote a real SSH session.

`baker run <name>` runs a command from the `commands:` block, but **currently works only on
`docker:`** — see the [CLI reference](baker-commands.md#baker-run).

## 4. Undo it

```bash
baker cleanup          # remove what the bake placed — the inverse of bake
baker cleanup --dry-run  # see the plan without changing anything
```

`baker destroy` also exists, but it tears down the *environment* rather than undoing the bake: on
`local:` it just forgets the environment and leaves everything installed. `cleanup` is the one that
reverses a bake.

## Using a container instead

Change one key. Replace `local: {}` with `docker:`:

```yaml
name: hello-baker
docker: python:3.12
lang:
  - python3
packages:
  - curl
  - git
commands:
  serve: python3 -m http.server 8000
```

`baker bake` now pulls the image, starts a container named `hello-baker`, and runs the same
bakelets inside it. `baker ssh` becomes `docker exec -it`, and `baker destroy` removes the
container.

`docker: {}` uses `ubuntu:latest`. The object form takes an explicit image:

```yaml
docker:
  image: ubuntu:22.04
```

If you omit `name:`, the container is named after the current directory.

## Using a remote server instead

```yaml
name: hello-baker
remote:
  ip: 10.0.0.5
  user: ubuntu
  private_key: ~/.ssh/id_rsa
lang:
  - python3
```

Baker configures a machine you can already reach over SSH. This is the target where the
playbook-backed sections (`lang:`, `services:`, `custom:`) are most comfortable, since sudo is
normally available on a server you administer.

See [Providers](providers.md) for the trade-offs between the three targets.

## Pointing Baker at someone else's config

`baker bake` takes an optional source argument, so you don't need a local file at all:

```bash
baker bake ~/projects/thing            # a directory containing baker.yml
baker bake ottomatica/baker-test       # clone a GitHub repo, use its baker.yml
baker bake your-org/configs@PM3        # clone a repo at a branch or tag
baker bake https://gist.github.com/... # a gist, snippet, or raw file URL
```

Whatever you point at, the file Baker reads is named `baker.yml`. Clones and fetches land in
`~/.baker/cache/`, never in your working directory.

See [Configuration sources](configuration-sources.md) for the full resolution order.

## Verifying the result

`baker check` delegates to [opunit](https://github.com/ottomatica/opunit) to assert that an
environment came out correctly:

```bash
baker check                        # runs test/opunit.yml against this machine
baker check user/repo:profile.yml  # runs a GitHub-hosted opunit profile
```

Opunit's exit code propagates, so `baker bake && baker check` works in CI.

## Next steps

- [`baker.yml` reference](baker-yml-reference.md) — every available key
- [Bakelets](bakelets.md) — what you can install
- [Core concepts](concepts.md) — how the pieces fit together
