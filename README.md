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

Baker uses a configuration file (baker.yml) in the root directory of you project. Below is an example of a baker.yml file. By running `baker bake` Baker installs the toolchain, places prepared configuration into projects, verifies the result, and can revert your system after completing activities. It can be run against your own machine, a Docker container, or a remote host via SSH using the same config for Linux, macOS, and Windows.

``` yaml
---
name: baker-test
vm:
  ip: 192.168.22.22
  ports: 8000
lang:
  - nodejs9
commands:
  serve: cd /baker-test/deployment/express && npm install && node index.js
```

You can also point to a git repository with a baker.yml file, and and Baker will do the rest:

```
$ baker bake --repo https://github.com/ottomatica/baker-test.git
```

Baker also supports creating environments inside containers that do not require a VM.

``` yaml
name: baker-docs
container: 
  ports: 8000
lang:
  - python2
commands:
  build: mkdocs build
  serve: mkdocs serve -a 0.0.0.0:8000
  gh-deploy: mkdocs gh-deploy
```

If you already have Docker installed, the `docker:` key provisions a container on your **local Docker daemon** — no VM required. Baker connects to `/var/run/docker.sock` (or `DOCKER_HOST`), so the same bakelets you use for VMs run inside a plain container.

``` yaml
name: dev-box
docker: node:18       # or: docker: {} for ubuntu:latest, or an object with image/ports
lang:
  - python3
tools:
  - jupyter
start: jupyter notebook --no-browser
```

Run `baker bake`, then `baker ssh` opens a shell inside the container and `baker destroy` removes it. If `name:` is omitted, the container name is derived from the current directory. Ansible-backed bakelets (lang, tools, services, …) use `ansible_connection=docker` and require Ansible on the host.

Baker can also run bakelets directly on your host machine without a VM or container — ideal for workstation setup or CI environments.

``` yaml
name: dev-env
local: {}
lang:
  - nodejs9
  - python3
tools:
  - jupyter
start: jupyter notebook --no-browser
```

The `local` key accepts a path string (e.g. `local: ~/my-project`) to set the working directory, or `local: {}` to use the current directory. Bakelets run directly on your host — no VM, no container, no Ansible control VM needed.

Setting up a Java environment with MySQL can be done easily.
``` yaml
name: onboard
vm:
  ip: 192.168.8.8
  ports: 8080
vars:
  - mysql_password:
      prompt: Type your password for mysql server
tools:
  - maven
services:
  - mysql:
      version: 8
      service_conf: env/templates/mysql.cfg
      client_conf: env/templates/my.cnf
lang:
  - java8
config:
  - template: 
      src: env/templates/hibernate-template.cfg.xml 
      dest: /Onboarding/CoffeeMaker/src/main/resources/hibernate.cfg.xml
commands:
  serve: cd CoffeeMaker && mvn spring-boot:run
  debug: cd CoffeeMaker && mvnDebug spring-boot:run
  test: cd CoffeeMaker && mvn test
```

## Placing files into an existing project

`config: - files:` puts files and directories at chosen paths, composing a shared base with a
per-unit overlay. It works in every mode, needs no Ansible and no sudo, and converges: with
`prune: true` a re-bake removes what the previous bake placed and this one does not, while never
touching a file Baker did not place.

```yaml
name: unit-1
local: .
config:
  - files:
      - src: ../../base/        # shared layer
        dest: .
      - src: ./overlay/         # unit-specific; wins on any shared path
        dest: .
      - src: ./gitignore.block  # merged between markers, not overwritten
        dest: .gitignore
        append: true
    run:
      - npm --prefix .tooling install
    prune: true
```

Files Baker places are Baker-owned: a re-bake replaces edits to them, and removing an entry from
the config deletes the file. See [docs/bakelets.md](docs/bakelets.md#files--declarative-file-placement).

## Agentic coding tools

Baker can install agentic coding CLIs into whatever environment it provisions (host, container, or box) as `tools:` bakelets. Currently `claude-code` and `opencode` are supported.

``` yaml
name: dev-env
local: {}
tools:
  - claude-code                              # curl install (default)
  - opencode:
      install: npm                           # "curl" (default) or "npm"
      repo: https://github.com/org/oc-config # optional: clone agents/skills config into the config dir
```

Installs are idempotent — re-baking an environment that already has the tool is a no-op. When a config `repo:` is given, Baker clones it on the first bake and fast-forwards it (`git pull --ff-only`) on subsequent bakes. Use the `url:dest` string form or the object form (`repo: { repo: <url>, dest: <path> }`) to control where it lands.

## Flexible baker.yml sources

`baker bake [source]` accepts a single positional argument that covers most of the ways you might point at a config:

``` bash
baker bake                              # ./baker.yml in the current directory
baker bake ./path/to/dir                # a directory containing baker.yml
baker bake owner/repo                   # clone a GitHub repo with a top-level baker.yml
baker bake owner/repo:units/one         # clone a repo and use the baker.yml in units/one
baker bake https://.../tree/...         # tree URL, gist, snippet, or raw file URL
```

`bake` always resolves to a directory containing a literal `baker.yml`. An address ending in
`.yml` is rejected, because that form belongs to `baker check`. Clones and fetches go to
`~/.baker/cache/`, never your working directory.

Local paths always win over GitHub shorthand, so a real `./owner/repo` directory is used as-is. The explicit `--local`, `--repo`, `--file`, and `--box` flags still work as overrides.

## Verifying an environment

`baker check` verifies that an environment ended up configured correctly by delegating to [opunit](https://github.com/ottomatica/opunit).

``` bash
baker check                             # opunit verify local — runs test/opunit.yml on this machine
baker check user/repo:profile.yml       # opunit profile — runs a GitHub-hosted opunit profile
```

Requires opunit installed globally: `npm install -g ottomatica/opunit`.
