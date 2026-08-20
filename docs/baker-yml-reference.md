# baker.yml Reference

See also: [CLI reference](baker-commands.md) · [Bakelets](bakelets.md) ·
[Providers](providers.md)

## Top-Level Environment Keys

Exactly one provider key selects the target. They are tested in a **fixed priority order** — the
first one present wins, so a file with both `docker:` and `local:` gets the Docker provider.

| Priority | Key | Type | Provider Selected | Description |
|----------|-----|------|-------------------|-------------|
| — | `name` | string (required) | — | Environment name used for container and directory naming |
| 1 | `docker` | string or object | docker-local | Container on your local Docker daemon |
| 2 | `local` | string or `{}` | Local | Run bakelets directly on the host machine |
| 3 | `remote` | object | Remote | Configure an existing server via SSH |

`name:` is used everywhere the environment is identified. For the `docker:` provider it may be
omitted, in which case the container is named after the current directory.

### Retired keys

`vm:`, `vagrant:`, `container:`, and `persistent:` selected the VirtualBox and runc providers,
which were removed along with the `baker-srv` control VM. A config carrying any of them is
**rejected before anything runs**, with a message naming the key and the three supported
alternatives. They are checked before the live keys, so a file with both `local:` and `vm:` still
gets the specific error rather than silently ignoring the dead half.

There is no compatibility shim. Sub-fields that only ever applied to a VM — `memory`, `network`,
`synced_folders`, `box` — have no equivalent.

### Remote sub-fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `user` | string | yes | SSH username |
| `private_key` | string | yes | Path to SSH private key |
| `ip` | string | yes | Remote server IP/hostname |
| `port` | number | no | SSH port; defaults to 22 |

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
| `cpp` | `cpp` | A C++ toolchain — compiler, headers, make |
| `dazed{version}` | `dazed2` | Dazed tool |
| `defects4j{version}` | `defects4j2` | Defects4J bug database |
| `git` | `git` | git itself — distinct from `resources: git:`, which clones |
| `jekyll` | `jekyll` | Jekyll static site generator |
| `jupyter` | `jupyter` | Jupyter notebook |
| `latex` | `latex` | LaTeX typesetting |
| `maven` | `maven` | Maven build tool |
| `node` | `node` | Node.js and npm — the sudo-free counterpart to `lang: nodejs` |
| `npm` | — | npm packages installed globally — takes a package or a `packages:` list |
| `opunit` | `opunit` | The verifier `baker check` shells out to |
| `pip` | — | Python packages from PyPI — takes a package or a `packages:` list |
| `python` | `python` | Python 3 and pip — the sudo-free counterpart to `lang: python` |
| `baker` | `baker` | Baker itself — takes a required `source:` |
| `docker-extension` | — | A Docker Desktop extension — takes a required `address:` |
| `opencode` | `opencode` | OpenCode agentic CLI — see below |
| `vscode` | `vscode` | Visual Studio Code, with optional extensions and settings — see below |

**Language toolchains** (`cpp`, `python`, `node`) exist because those package names
genuinely differ between managers — Debian's `build-essential` is `gcc-c++` on Fedora and
`base-devel` on Arch, and Python is `python3` everywhere except Arch and Chocolatey. A bare
`packages:` entry cannot express that without repeating the mapping in every config.

```yaml
tools:
  - cpp
  - python
  - pip:
      packages:
        - jsonschema
        - pytest
  - node
  - npm:
      packages:
        - typescript
        - eslint
```

Entries within a category run **top to bottom**, so listing `python` before `pip:` is what
guarantees the interpreter exists first — and `node` before `npm:` for the same reason.

`pip` installs with `--user`, so it needs no elevation on any platform. Where PEP 668 marks
the interpreter externally managed — Debian 12+, Ubuntu 23.04+, recent Fedora, Homebrew
Python — it retries with `--break-system-packages`, which is still a per-user install.

`npm` is the same idea for the Node ecosystem, accepting the same two forms. It installs with
`npm install -g` and never runs under `sudo`: npm's global prefix is per-user under nvm, fnm
and volta and on Windows. Where the prefix *is* root-owned the install fails with `EACCES`,
and the fix is a user-owned prefix rather than `sudo npm`, which leaves root-owned files in
`~/.npm`.

> **A presence check cannot see a version.** `cpp` skips when `g++` is already on PATH, even
> if that compiler is too old for the standard your project needs — Ubuntu 20.04's
> `build-essential` is GCC 9, which fails C++20. `git` has the same blind spot. Assert
> versions with [`baker check`](baker-commands.md#baker-check) rather than assuming the
> bakelet caught it.

> **`tools: git` is not `resources: git:`.** The first installs the git program; the second
> clones a repository with it. A config that clones needs both, in that order.
> On macOS `tools: git` refuses to accept `/usr/bin/git` on a machine that has never
> installed the Xcode Command Line Tools — that path is a stub which opens a GUI installer
> dialog, and a plain `command -v git` check would pass on it.

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

**Visual Studio Code** (`vscode`) installs the editor and, optionally, the extensions and the
User `settings.json` an assignment expects everyone to have:

```yaml
tools:
  - vscode                                     # editor only
  - vscode: ms-python.python                   # shorthand, one extension
  - vscode:
      extensions:
        - ms-python.python
        - dbaeumer.vscode-eslint@2.4.4         # a version may be pinned
      settings:
        editor.formatOnSave: true
        editor.tabSize: 4
      overwrite: false                         # default
```

| Field | Type | Description |
|-------|------|-------------|
| `extensions` | string or list | Marketplace ids in `publisher.extension` form, optionally `@version` |
| `settings` | map | Written verbatim to User `settings.json` — use VS Code's own dotted keys |
| `overwrite` | boolean | Replace an existing `settings.json`. Default `false` |

Extensions install in a single `code --install-extension … --force` invocation, so re-baking
is a no-op rather than an error.

> **`settings:` does not overwrite by default.** Baker cannot merge into an existing
> `settings.json` — no target is guaranteed to have `jq`, `node` or `python3` — so it writes
> the file only when it is absent and reports that it left an existing one alone. Set
> `overwrite: true` to replace it; the previous file is copied to `settings.json.baker-backup`
> first. Settings land in the User profile, which is per-machine: for per-assignment settings
> that travel with a repository, use `config: files:` to write `.vscode/settings.json` instead.

> **Not available on Alpine.** Microsoft publishes no musl build and there is no community
> package, so `apk` targets are refused with a message rather than given a wrong package. On
> Arch the distribution package is **Code - OSS**, which uses the Open VSX registry rather than
> Microsoft's marketplace — extension ids that resolve everywhere else may not resolve there.

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

```yaml
services:
  - docker
  - mysql5.7
  - mongodb3.6
  - neo4j
```

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
| `files` | `{files: [...], prune: bool, run: [...]}` | Place files and directories at chosen paths |
| `template` | `{template: {src: "local/file", dest: "/remote/path"}}` | Render a file and write it to the target |

```yaml
config:
  - files:
      - src: ./base/          # directory sources merge; later entries win
        dest: .
      - src: ./scripts/run.sh
        dest: .scripts/run.sh
        mode: "0755"
    prune: true               # remove what the last bake placed and this one does not
  - template:
      src: ./nginx.conf
      dest: /etc/nginx/nginx.conf
```

`files:` and `template:` are both portable and run everywhere.

**`keys:` was removed.** It distributed a single SSH private key — one that was committed to the
Baker repository — under one filename per name in the list. Use `files:` to place a key you
control.

**`vault:` was removed.** The `baker vault` command and the `config: - vault:` section are both
gone; a config still using the section fails with `Cannot find vault in config Bakelets.` For a
per-person secret, have the participant place it themselves and assert it with
[`baker check`](baker-commands.md#baker-check) rather than shipping an encrypted file everyone
must be able to decrypt.

Full `files:` reference, including `append:`, `ensure: dir`, `overwrite:`, and the manifest that
makes pruning safe: [Bakelets](bakelets.md#files--declarative-file-placement).

### `resources:` — External Resources

| Entry | Formats | Description |
|-------|---------|-------------|
| `git` | string or object | Clone a git repository |

**String format**: `"repo_url[@ref]:dest_path"`
**Object format**:
```yaml
resources:
  - git: "https://github.com/user/repo.git:/home/vagrant/project"
  - git: "https://github.com/user/repo.git@unit-1:units/one"   # clone at a branch or tag
  - git:
      repo: "https://github.com/user/private-repo.git"
      dest: "/home/vagrant/private"
      private: true    # requires githubuser + githubpass in vars
```

For private repos, include `vars:` with `githubuser` and `githubpass`.

| Field | Type | Description |
|-------|------|-------------|
| `repo` | string | Repository URL |
| `dest` | string | Where it goes, relative to the environment root |
| `private` | bool | Use `githubuser`/`githubpass` from `vars:` |
| `extract` | bool | Inject the repo's **contents**, with no clone and no `.git` |
| `ref` | string | Branch or tag to clone at — or, with `extract:`, to take the contents from |

#### `ref:` — cloning at a branch or tag

Both forms take a ref; without one, both clone the default branch:

```yaml
resources:
  - git: "https://github.com/org/repo@unit-1:work"      # string form
  - git:
      repo: https://github.com/org/repo                  # object form
      dest: work
      ref: unit-1
```

It becomes `git clone --branch <ref>`, so a **tag** works too and leaves the clone with a detached
HEAD — which is what asking for a tag means. `baker cleanup` names the ref in the command it hands
back, because a plain `git clone` would not restore the same thing.

In the string form the `@` is located within the repository path, so credentials
(`https://user:pass@host/org/repo`), scp-style remotes (`git@github.com:org/repo.git@unit-1`), and
refs containing a slash (`@release/1.2`) all parse correctly.

The `baker bake` address grammar has its own equivalent — `baker bake owner/repo@unit-1` — which
selects the ref for the *config being baked* rather than for a repository the config clones. See
[Configuration sources](configuration-sources.md).

#### `extract:` — inject repository content into a folder

Clones put a *repository* somewhere. `extract:` puts its *contents* somewhere — into a directory
someone already owns, with no `.git` for them to accidentally commit into:

```yaml
resources:
  - git:
      repo: https://github.com/your-org/course-config
      dest: .claude          # a folder inside the person's own project
      extract: true
      ref: unit-1            # swap the unit, re-bake, the config changes
```

Nothing is cloned. Baker resolves `ref:` to an exact commit with `git ls-remote`, then downloads
that commit's archive in a single request — no API rate limit to exhaust, and no repository left
on disk.

Three behaviours differ from the clone form, all of them deliberate:

- **It is re-runnable.** A clone *skips* when the destination exists, because a checkout may hold
  unpushed work. Injection *updates*, because updating the per-unit configuration is the point.
- **It overlays.** Files in the archive are written; everything else in that folder is left alone,
  so the person's own work survives a re-bake.
- **It is pinned.** The ref resolves to a commit before the download, so two people baking on the
  same day get identical bytes even if the branch moves between them.

**Cleanup removes it.** Injection writes a `.baker-extract.json` manifest into `dest:` recording
every file it placed and the hash each had when it was written. `baker cleanup` removes exactly
those files, plus the manifest, plus any directory left empty afterwards. Anything else in that
folder is yours and is never touched.

A file that no longer matches its recorded hash has been edited since it was injected — it is
**kept and reported**, not deleted. Same principle as the dirty-clone guard: Baker removes what it
can prove it put there and nothing else.

**Limits.** `extract:` needs `github.com` and a `local:` environment; any other host or provider is
refused by name, and the fix is to drop `extract:` and use the clone form.

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

It is **backgrounded in all three modes**, so a long-running command does not block the bake:

| Mode | Mechanism |
|------|-----------|
| local | detached `spawn`, then `unref` |
| docker | `docker exec -d <c> /bin/bash -c '<cmd>'` |
| remote | Ansible `shell` with `nohup`, output to `~/start.out` / `~/start.err` |

The trade-off is that failures are invisible — output is discarded, so a `start:` command that
exits non-zero surfaces nothing. Run it by hand in the environment if it is not behaving.

A value containing a single quote breaks in docker mode, because of the `bash -c '…'` wrapper.

### `commands:` — Named Commands

A mapping of command names to shell commands, runnable later with `baker run <name>`:

```yaml
commands:
  serve: cd CoffeeMaker && mvn spring-boot:run
  test: mvn test
  lint: eslint .
```

`baker run` with no argument lists what's available. Output streams as it happens, and the
command's exit code becomes Baker's.

Each command runs in the **environment root** — the same directory `config: files:` writes into:
your project directory on `local:`, and `/<project-basename>` on `docker:` and `remote:`. That is a
starting point, not a constraint; a command may `cd` further, as `serve` does above.

Unlike `start:`, these are never run automatically. `run` also requires the environment to have
been baked; see [`baker run`](baker-commands.md#baker-run).

> **A command must not prompt for input.** `baker run` streams output but does not attach a
> keyboard, so a command that asks a question will print it and then appear to hang. Take values
> from `env:` or from the script's own arguments instead.

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

# Target selection (pick exactly one)
local: /home/user/project
# docker: node:18
# remote:
#   ip: 10.0.0.5
#   user: ubuntu
#   private_key: ~/.ssh/id_rsa

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
  - git: "https://github.com/user/repo.git:~/project"

env:
  - APP_ENV: development
  - LOG_LEVEL: debug

# Named commands. `baker run` currently works on docker: only —
# see the CLI reference.
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
