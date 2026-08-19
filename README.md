# Baker 🍞 

Meet Baker! Baker sets up development environments from one configuration file (`baker.yml`), so everyone in a group ends up with the same setup — and can verify and clean up their environment afterwards.

See a running demo below:
<p align="center">
  <img src="./docs/img/demo.gif">
</p>

## Install from source

``` bash
git clone https://github.com/chbrown13/Baker
cd Baker
npm install
npm link
```

## Using Baker

Baker uses a configuration file (`baker.yml`) in the root directory of you project. By running `baker bake`, Baker installs the toolchain, places prepared configuration into projects, verifies the result, and can revert your system after completing activities. It can be run against different _providers_ using the same config across Linux, macOS, and Windows environments.

### Baker.yml sources

`baker bake [source]` accepts a single positional argument that covers most of the ways you might point at a config:

``` bash
baker bake                              # ./baker.yml in the current directory
baker bake ./path/to/dir                # a directory containing baker.yml
baker bake owner/repo                   # a GitHub repo with a top-level baker.yml
baker bake https://.../tree/...         # tree URL, gist, snippet, or raw file URL
```

`bake` always resolves to a directory containing a literal `baker.yml`. Clones and fetches go to `~/.baker/cache/`, never your working directory.

Local paths always win over GitHub shorthand, so a real `./owner/repo` directory is used as-is. The explicit `--local`, `--repo`, `and --file` flags can work as overrides.

### Providers

* **`local:`** configures the machine you are sitting at. Use `local: {}` for the current directory, or give a path to place the environment somewhere else on your machine (e.g. `local: ~/my-project`) to set the working directory. Bakelets run directly on your host.

``` yaml
---
name: baker-test
local: ~/my-project # or local: {} defaults to the current working directory
tools:
  - maven
packages:
  - jq
commands:
  serve: npm install && node index.js
```

* **`docker:`**: If you already have Docker installed, the `docker:` provider provisions a container on your **local Docker daemon**. Baker connects to `/var/run/docker.sock` (or `DOCKER_HOST`), so the same bakelets run inside a plain container.

``` yaml
name: dev-container
docker: node:18       # or: docker: {}, ubuntu:latest is the default
lang:
  - python3
tools:
  - jupyter
start: jupyter notebook --no-browser
```

Run `baker bake`, then `baker ssh` opens a shell inside the container and `baker destroy` removes it. If `name:` is omitted, the container name is derived from the current directory. Ansible-backed bakelets (lang, tools, services,...) use `ansible_connection=docker` and require Ansible on the host.


* **`remote:`** configures a server you can already reach over SSH. Give it the address, the user to log in as, and a private key. Baker runs the same bakelets over that connection, so nothing is installed on your own machine.

``` yaml
name: dev-server
remote:
  ip: 10.0.0.5
  user: ubuntu
  private_key: ~/.ssh/id_rsa
  # port: 22           # optional, defaults to 22
tools:
  - maven
packages:
  - jq
```

All three of `ip`, `user`, and `private_key` are required. `baker ssh` opens a real SSH session on that machine, and `baker destroy` forgets the environment without touching the server.


### Verifying an Environment

`baker check` verifies that an environment ended up configured correctly by delegating to [opunit](https://github.com/ottomatica/opunit).

``` bash
baker check                              # runs test/opunit.yml on this machine
baker check owner/repo:profile.yml       # runs a profile from the repository's default branch
baker check owner/repo@unit-1:profile.yml  # runs a profile from the branch or tag unit-1
```

Baker pins the profile to a commit before fetching it, so a profile you just pushed takes effect immediately, and each run prints the commit it checked against.

Requires opunit 0.9.4 or newer, installed globally: `npm install -g ottomatica/opunit`.

### Reverting an Environment

`baker cleanup` is the inverse of `baker bake`. It reads the same `baker.yml`, works out what that bake put on your machine, and asks before removing anything.

``` bash
baker cleanup [source]     # asks about each item, then remove what you approve
baker cleanup --dry-run    # show the plan and exit, changing nothing
baker cleanup --yes        # accept the safe defaults without prompting
```

Files, config, and environment variables default to **yes**, because Baker keeps a record of what it placed. Installed tools default to **no**, because Baker cannot tell whether it installed one or simply found it already there. A few things are refused outright — removing Python would take your package manager with it.

`baker destroy` is a different thing: it tears down the *environment* rather than undoing the bake. On `docker:` it removes the container; on `local:` it only forgets the environment and leaves everything installed.

## Documentation

The full documentation lives in [`docs/`](docs/index.md). If you are new, start here:

- [Installation](docs/installation.md) — install Baker and anything your target needs
- [Getting started](docs/getting-started.md) — build your first environment end to end
- [`baker.yml` reference](docs/baker-yml-reference.md) — every key you can put in the config
- [CLI reference](docs/baker-commands.md) — every command and flag
- [Troubleshooting](docs/troubleshooting.md) — common failures and known limitations
