# baker.yml Reference

See also: [CLI reference](baker-commands.md) · [Bakelets](bakelets.md) ·
[Providers](providers.md)

## Top-Level Environment Keys

Exactly one provider key selects the backend. They are tested in a **fixed priority order** — the
first one present wins, so a file with both `docker:` and `vm:` gets the Docker provider.

| Priority | Key | Type | Provider Selected | Description |
|----------|-----|------|-------------------|-------------|
| — | `name` | string (required) | — | Environment name used for VM/container/box naming |
| 1 | `docker` | string or object | docker-local | Container on your local Docker daemon |
| 2 | `local` | string or `{}` | Local | Run bakelets directly on the host machine |
| 3 | `container` / `persistent` | object | Runc | OCI container hosted on `baker-srv` |
| 4 | `vm` | object | VirtualBox | Direct VirtualBox provider |
| 4 | `vagrant` | object | VirtualBox | Vagrant-shaped config (currently dispatches to VirtualBox) |
| 5 | `remote` | object | Remote | Provision an existing server via SSH |

`name:` is used everywhere the environment is identified. For the `docker:` provider it may be
omitted, in which case the container is named after the current directory.

### Vagrant / VM / Container sub-fields

| Field | Type | Description |
|-------|------|-------------|
| `ip` | string | Private network IP (e.g. `192.168.33.10`) |
| `memory` | string/number | RAM in MB (e.g. `512` or `"512"`) |
| `ports` | string | Port mappings (e.g. `"8000, 9000, 1000:3000"`) |
| `network` | array | Network configs: `forwarded_port` (guest/host), `private_network` (ip) |
| `synced_folders` | array | Folder sync configs: `folder` with `src`/`dest` |
| `box` | string | Vagrant box name (e.g. `ubuntu/trusty64`) |

### Remote sub-fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `user` | string | yes | SSH username |
| `private_key` | string | yes | Path to SSH private key |
| `ip` | string | yes | Remote server IP/hostname |
| `port` | number | yes | SSH port (usually 22) |

### Local

- **String**: `local: /home/user/project` → resolved as the working directory
- **Empty object** `local: {}` → defaults to `process.cwd()`

### Docker

- **String**: `docker: node:18` → the image to run
- **Empty object** `docker: {}` → defaults to `ubuntu:latest`
- **Object**: `docker: {image: ubuntu:22.04}`

| Field | Type | Description |
|-------|------|-------------|
| `image` | string | Image to pull and run. Defaults to `ubuntu:latest`. |

Baker connects to `/var/run/docker.sock`, or `DOCKER_HOST` if set. The container is started with
`tail -f /dev/null` so it stays alive for provisioning; `ports:` is not currently configured for
this provider.

---

## Provisioning Sections

### `lang:` — Language Runtimes

Array of bakelet names. Version number appended directly:

The version suffix selects a playbook filename, so only versions with a playbook in
`remotes/bakelets-source/` work.

| Entry | Available versions | Description |
|-------|-------------------|-------------|
| `nodejs{version}` | `nodejs9`, `nodejs13` | Node.js |
| `java{version}` | `java8` | Java JDK |
| `python{version}` | `python2`, `python3`, `python3.6` | Python (defaults to 2 if no version) |
| `R` | *(unversioned)* | R with optional CRAN packages |

```yaml
lang:
  - nodejs9
  - python3
  - java8
  - R
```

**R** can specify packages as an object:
```yaml
lang:
  - R:
      packages: "dplyr, ggplot2"
```

### `tools:` — Development Tools

Array of bakelet names:

| Entry | Example | Description |
|-------|---------|-------------|
| `ansible{version}` | `ansible2` | Ansible |
| `claude-code` | `claude-code` | Claude Code agentic CLI — see below |
| `dazed{version}` | `dazed2` | Dazed tool |
| `defects4j{version}` | `defects4j2` | Defects4J bug database |
| `jekyll` | `jekyll` | Jekyll static site generator |
| `jupyter` | `jupyter` | Jupyter notebook |
| `latex` | `latex` | LaTeX typesetting |
| `maven` | `maven` | Maven build tool (no playbook; installed via an apt ad-hoc call) |
| `opencode` | `opencode` | OpenCode agentic CLI — see below |
| `jenkins-job-builder` | — | **Non-functional** — the bakelet file is empty and throws |

```yaml
tools:
  - jupyter
  - maven
  - latex
  - jekyll
```

**Agentic coding tools** (`claude-code`, `opencode`) install a CLI into whatever environment is
being provisioned, and optionally sync a config repository:

```yaml
tools:
  - claude-code                                # curl install (default)
  - opencode:
      install: npm                             # "curl" (default) or "npm"
      repo: https://github.com/org/oc-config   # optional config repo
```

| Field | Type | Description |
|-------|------|-------------|
| `install` | string | `curl` (default) or `npm` |
| `repo` | string or object | Config repo to clone. `url:dest` string, or `{repo: <url>, dest: <path>}` |

Installs are idempotent. A config `repo:` is cloned on first bake and `git pull --ff-only`'d
afterward; if the destination exists but isn't a git repo, Baker skips it rather than overwriting.
`dest` defaults to the tool's own config directory (`~/.claude` for `claude-code`).

### `packages:` — OS Packages

A list of package names, installed with whatever package manager the target has
(`apt`, `dnf`, `pacman`, `zypper`, `apk`, `brew`, or `choco`).

```yaml
packages:
  - jq
  - tmux
```

Package names sometimes differ between systems. Where they do, give the name per
manager; Baker uses `name` on any manager you do not list:

```yaml
packages:
  - name: fd
    apt: fd-find
    dnf: fd-find
    brew: fd
    choco: fd
```

If you supply per-manager names but omit the one Baker detects, the bake fails
rather than guessing — installing the wrong package is worse than stopping.

> **Changed:** the old `packages: - apt:` form is removed. It named a package
> manager in the schema, so a configuration written with it could only ever work
> on Debian and Ubuntu. The `deb:` and `ppa:` sub-keys are removed with it; use
> `custom:` for a one-off `.deb` install.

### `services:` — Background Services

Array of bakelet names:

| Entry | Available versions | Description |
|-------|-------------------|-------------|
| `docker` | — | Docker CE, inside the environment |
| `mongodb{version}` | `mongodb3.6` | MongoDB |
| `mysql{version}` | `mysql5.7`, `mysql8` | MySQL — supports config file paths |
| `neo4j` | *(unversioned playbook)* | Neo4j graph database |
| `jenkins` | — | **Non-functional** — the bakelet file is empty and throws |

```yaml
services:
  - docker
  - mysql5.7
  - mongodb3.6
  - neo4j
```

A playbook for `lxd` exists at `services/lxd/lxd.yml`, but there is no bakelet class for it, so it
cannot be selected from `services:`.

**MySQL** supports sub-fields for custom config:
```yaml
services:
  - mysql:
      version: 5.7
      service_conf: ./my-custom-mysqld.cnf
      client_conf: ./my-custom-client.cnf
```

**MongoDB** also supports version as a sub-field:
```yaml
services:
  - mongodb:
      version: 4.0
```

### `config:` — Configuration Files

Array of config objects:

| Entry | Format | Description |
|-------|--------|-------------|
| `keys` | `{keys: ["client1", "client2"]}` | Copy SSH private keys into the environment |
| `template` | `{template: {src: "local/file", dest: "/remote/path"}}` | Copy and template a file via Ansible |
| `vault` | `{vault: [{file: "secret.yml", dest: "/remote/path"}]}` | Decrypt Ansible Vault files and deploy |

```yaml
config:
  - keys: ["deploy", "app"]
  - template:
      src: ./nginx.conf
      dest: /etc/nginx/nginx.conf
  - vault:
      - file: secrets/database.yml
        dest: /etc/myapp/database.yml
```

### `resources:` — External Resources

| Entry | Formats | Description |
|-------|---------|-------------|
| `git` | string or object | Clone a git repository |

**String format**: `"repo_url:dest_path"`
**Object format**:
```yaml
resources:
  - git: "https://github.com/user/repo.git:/home/vagrant/project"
  - git:
      repo: "https://github.com/user/private-repo.git"
      dest: "/home/vagrant/private"
      private: true    # requires githubuser + githubpass in vars
```

For private repos, include `vars:` with `githubuser` and `githubpass`.

### `env:` — Environment Variables

A **list of single-key maps** — not a plain mapping:

```yaml
env:
  - MY_VAR: hello
  - PATH_EXTRA: /opt/myapp/bin
  - DB_HOST: localhost
```

The bakelet iterates the value with `forEach`, so a bare mapping (indented `KEY: value` pairs with
no leading dashes) throws.

Variables are set for the **user**, not the system, and so need no `sudo`:

- **Linux and macOS** — written to `~/.baker/env.sh`, which is sourced from your shell profile.
  The file is rewritten on every bake, so a variable you remove from `baker.yml` stops being set.
- **Windows** — set with `[Environment]::SetEnvironmentVariable(..., "User")`, which persists for
  new shells. Removing a variable from `baker.yml` does not currently unset it there.

> **Changed:** this used to append to `/etc/environment`, which is a Debian convention that does
> not exist on macOS, has no Windows equivalent, and required root.

### `custom:` — Custom Playbooks

Array of your own Ansible playbooks, run with the same transport and variables as any built-in
bakelet:

```yaml
custom:
  - mytool:
      path: ./playbooks/mytool.yml
```

| Field | Type | Description |
|-------|------|-------------|
| `path` | string (required) | Path to a playbook **file**, relative to the `baker.yml` |

`path` points at a playbook, not at a JavaScript module — Baker always uses its own built-in
`Custom` bakelet class, which copies your playbook to the target and runs it. The YAML key
(`mytool` above) names the staged file: it lands at `/home/vagrant/baker/<env-name>/mytool.yml`.

Your playbook receives the flattened `vars:` list plus `BAKER_SHARE_DIR` as extra-vars. See
[Extending Baker](extending.md#custom-playbooks-custom).

### `start:` — Startup Command

A single string command run automatically at the end of a successful bake:

```yaml
start: jupyter notebook --no-browser
```

How it runs — and whether it is backgrounded — depends on the provider:

| Mode | Mechanism | Backgrounded |
|------|-----------|--------------|
| local | `child_process.execSync` in the working directory | **no** |
| docker | `docker exec <c> /bin/bash -c '<cmd>'` | **no** |
| remote | Ansible `shell` with `nohup`, output to `~/start.out` / `~/start.err` | yes |
| control-VM | the `start` helper over SSH | yes |

In local and docker modes a long-running `start:` blocks the bake from finishing. Use `commands:`
and `baker run` instead if you want to launch a server separately.

### `commands:` — Named Commands

A mapping of command names to shell commands, runnable later with `baker run <name>`:

```yaml
commands:
  serve: cd CoffeeMaker && mvn spring-boot:run
  test: mvn test
  lint: eslint .
```

`baker run test` executes `cd /<project-dir>; mvn test` on the target. `baker run` with no
argument lists what's available.

Unlike `start:`, these are never run automatically.

### `vars:` — Extra Ansible Variables

Array of variable objects passed to all Ansible playbooks:

```yaml
vars:
  - githubuser: myuser
  - app_env: production
```

An entry whose value is an object containing `prompt:` triggers an interactive prompt at bake
time, and the answer replaces the object. This keeps secrets out of the file:

```yaml
vars:
  - mysql_password:
      prompt: Type your password for mysql server
```

Additionally, `BAKER_SHARE_DIR` is automatically injected pointing to the baker.yml directory on the target.

---

## Legacy `bake:` Section

Older pattern for running custom Ansible playbooks directly:

```yaml
bake:
  ansible:
    source: env/
    run:
      - ansible-playbook bootstrap.yml -i inventory
      - ansible-playbook configure.yml -i inventory -s
  vault:
    source: src/env/vault.yml
    checkout:
      key: my-key
      dest: ~/.ssh/id_rsa
```

---

## Version Number Convention

Many bakelets accept a version number appended directly to the name string. The parse logic splits on the boundary between alpha characters and trailing digits:

| Input | Bakelet Name | Version |
|-------|-------------|---------|
| `nodejs9` | nodejs | 9 |
| `java8` | java | 8 |
| `python3` | python | 3 |
| `neo4j3.3` | neo4j | 3.3 |
| `mongodb4.0` | mongodb | 4.0 |
| `jupyter` | jupyter | (none) |

For `mysql` and `mongodb`, the version can alternatively be specified as a sub-field of the object form.

Because the version is interpolated into a playbook filename, **only versions that ship a playbook
work**. Requesting `python3.11` fails at the copy step because `lang/python/python3.11.yml` does
not exist. See [Bakelets](bakelets.md) for what is available per bakelet.

---

## Full Example

```yaml
name: dev-environment

# Provider selection (pick one)
local: /home/user/project
# vagrant:
#   box: ubuntu/trusty64
#   memory: 2048
#   network:
#     - private_network:
#         ip: 192.168.33.10

# Optional custom variables
vars:
  - githubuser: myuser

# Provisioning
lang:
  - nodejs9
  - python3
  - java8

tools:
  - jupyter
  - maven

packages:
  - curl
  - git

services:
  - docker
  - mysql5.7

config:
  - template:
      src: ./my.conf
      dest: /etc/myapp/my.conf

resources:
  - git: "https://github.com/user/repo.git:/home/vagrant/project"

env:
  - APP_ENV: development
  - LOG_LEVEL: debug

# Named commands, run with `baker run <name>`
commands:
  serve: npm start
  test: npm test

# Startup command, run automatically at the end of a bake
start: jupyter notebook --no-browser
```

---

## Provisioning Order

Categories always run in this order, regardless of how you order them in the file:

```
lang → config → services → tools → packages → resources → env → custom → start
```

Entries within a category run top to bottom. There is currently no way to express a dependency
across categories — see [Troubleshooting](troubleshooting.md#bakelet-ordering-isnt-configurable).
