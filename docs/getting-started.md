# Getting started

This walks through building an environment end to end. It uses the **local provider**, which needs
no VM and no container — bakelets run directly on your machine. Once the shape is familiar,
switching to a container or VM is a one-key change.

> **Before you start:** the local provider needs Ansible and passwordless sudo. See
> [Installation](installation.md#local-provider). If you'd rather not grant that on your own
> machine, jump to [Using a container instead](#using-a-container-instead) and use the `docker:`
> provider — the sudo requirement applies inside the container, where it's already satisfied.

## 1. Create a `baker.yml`

In an empty project directory:

```yaml
name: hello-baker
local: {}
lang:
  - python3
packages:
  - curl
  - git
commands:
  serve: python3 -m http.server 8000
  test: python3 -m pytest
```

`baker init` generates a starter file interactively if you'd rather not write one by hand.

What each key does:

- **`name:`** identifies the environment. Baker uses it for the box directory, the container name,
  and the entry in the environment index.
- **`local: {}`** selects the local provider and uses the current directory as the working
  location. `local: ~/some/path` points it elsewhere.
- **`lang:`**, **`packages:`** are *bakelets* — units of provisioning. See
  [Bakelets](bakelets.md) for the full catalog.
- **`commands:`** registers named commands you can run later with `baker run <name>`.

## 2. Bake it

```bash
baker bake
```

Baker reads `./baker.yml`, selects the local provider from the `local:` key, and runs each bakelet
in order. You'll see a spinner per bakelet — `Preparing python`, then `Installing python`.

Under the hood each bakelet renders an Ansible playbook and executes it with
`ansible-playbook -i "localhost," -c local`. Pass `--verbose` to see the generated variables and
the full Ansible output:

```bash
baker bake --verbose
```

## 3. Use the environment

```bash
baker ssh              # open a shell in the environment
baker run serve        # run the "serve" command from baker.yml
baker run              # list available commands
baker status           # show all Baker environments and their state
```

For the local provider, `baker ssh` opens your `$SHELL` in the environment's box directory. For
containers and VMs it's a real SSH or `docker exec` session.

## 4. Tear it down

```bash
baker destroy          # or: baker delete
```

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
bakelets inside it via `ansible_connection=docker`. `baker ssh` becomes `docker exec -it`, and
`baker destroy` removes the container.

`docker: {}` uses `ubuntu:latest`. The object form takes an explicit image:

```yaml
docker:
  image: ubuntu:22.04
```

If you omit `name:`, the container is named after the current directory.

## Using a VM instead

```yaml
name: hello-baker
vm:
  ip: 192.168.22.22
  ports: 8000
  memory: 2048
lang:
  - python3
```

This is a bigger step: VM provisioning routes through the `baker-srv` control VM, which Baker
installs on first use. It requires VirtualBox and takes noticeably longer. Your project directory
is shared into the VM at `/<directory-name>`, and `ports:` sets up forwarding from host to guest.

See [Providers](providers.md) for the trade-offs between the backends.

## Pointing Baker at someone else's config

`baker bake` takes an optional source argument, so you don't need a local file at all:

```bash
baker bake ~/projects/thing            # a directory containing baker.yml
baker bake ottomatica/baker-test       # clone a GitHub repo, use its baker.yml
baker bake your-org/configs:units/one  # clone a repo, use the baker.yml in units/one
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
