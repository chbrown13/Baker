# Bakelets

A bakelet is one installable unit of an environment. Each is a JavaScript class in
`lib/bakelets/<category>/` paired, in most cases, with an Ansible playbook in
`remotes/bakelets-source/<category>/`.

This page is the catalog. For how bakelets are dispatched and executed, see
[Architecture](architecture.md); for writing your own, see [Extending Baker](extending.md).

## Execution order

Categories always run in this order, regardless of how you order them in your file:

```
lang → config → services → tools → packages → resources → env → custom → start
```

Entries within a category run top to bottom.

## Version suffixes

Most names accept a version appended directly (`python3`, `neo4j3.3`). The suffix selects a
playbook filename, so **only versions with a matching playbook exist**. The tables below list what
actually ships. Requesting `python3.11` will fail at the copy step because
`lang/python/python3.11.yml` isn't there.

---

## `lang:` — language runtimes

```yaml
lang:
  - python3
  - nodejs9
  - java8
  - R
```

| Name | Available versions | Playbook |
|------|-------------------|----------|
| `python` | `python2`, `python3`, `python3.6` | `lang/python/python<v>.yml` |
| `nodejs` | `nodejs9`, `nodejs13` | `lang/nodejs/nodejs<v>.yml` |
| `java` | `java8` | `lang/java/java8.yml` |
| `R` | *(unversioned)* | `lang/R/r.yml.mustache` |

Bare `python` with no version defaults to **python2**.

**R** accepts a CRAN package list, and renders its playbook from a Mustache template:

```yaml
lang:
  - R:
      packages: "dplyr, ggplot2"     # or a YAML list
```

---

## `tools:` — developer tools

```yaml
tools:
  - jupyter
  - maven
  - claude-code
```

| Name | Versions | Notes |
|------|----------|-------|
| `jupyter` | — | Jupyter notebook |
| `latex` | — | LaTeX toolchain |
| `jekyll` | — | Jekyll static site generator |
| `maven` | — | Maven build tool |
| `ansible` | e.g. `ansible2` | Ansible itself, on the target |
| `cpp` | — | C++ toolchain — compiler, headers, make. See below |
| `node` | — | Node.js and npm, sudo-free counterpart to `lang: nodejs` |
| `python` | — | Python 3 and pip, sudo-free counterpart to `lang: python` |
| `pip` | — | Python packages from PyPI — requires a package list, see below |
| `opunit` | — | The verifier `baker check` shells out to |
| `baker` | — | Baker itself — requires `source:`, see below |
| `docker-extension` | — | A Docker Desktop extension — requires `address:`, see below |
| `dazed` | e.g. `dazed2` | |
| `defects4j` | e.g. `defects4j2` | Defects4J bug database |
| `claude-code` | — | Agentic coding CLI — see below |
| `opencode` | — | Agentic coding CLI — see below |

`jupyter`, `latex`, `maven`, `ansible`, `cpp`, `node`, `python`, `pip`, and `opunit` are
**exec-based**: one idempotent command per package manager, no Ansible and no playbook. `jekyll`,
`dazed`, and `defects4j` are still playbook-backed and need a Linux target.

### `cpp`, `python`, `pip`

```yaml
tools:
  - cpp
  - python
  - pip:
      packages:
        - jsonschema
        - pytest
  - pip: jsonschema        # shorthand for a single package
```

These are in `tools:` rather than `packages:` because their names genuinely differ per manager,
and a `packages:` entry would mean repeating the mapping in every config that needs a compiler:

| | apt | dnf | pacman | apk | brew | choco |
|---|---|---|---|---|---|---|
| `cpp` | `build-essential` | `gcc-c++ make` | `base-devel` | `build-base` | `gcc` | `mingw` |
| `python` | `python3 python3-pip` | `python3 python3-pip` | `python python-pip` | `python3 py3-pip` | `python3` | `python3` |

Entries within a category run **top to bottom**, so `python` before `pip:` is what guarantees the
interpreter exists first.

`pip` installs with `--user` and needs no elevation anywhere. Where PEP 668 marks the interpreter
externally managed — Debian 12+, Ubuntu 23.04+, recent Fedora, Homebrew Python — it retries with
`--break-system-packages`, still a per-user install. It has no presence check: pip is already
idempotent, and a package name is not an import name, so guessing one would be wrong as often as
right.

> **`cpp` cannot see a compiler's version.** It skips when `g++` is on PATH, even if that compiler
> is too old for your standard — Ubuntu 20.04's `build-essential` is GCC 9, which fails C++20.
> Assert the version with `baker check`.

On macOS, `g++` normally already exists as part of the Xcode Command Line Tools, which `git` pulls
in, so `cpp` is usually a no-op there. Where it is not, Homebrew's `gcc` is what gets installed —
`xcode-select --install` is interactive and not something a bake should drive.

### `node`, `opunit`, `baker`

```yaml
tools:
  - node          # nodejs + npm from the target's package manager
  - opunit        # npm install -g ottomatica/opunit
  - baker:
      source: your-org/Baker    # required — see below
```

`baker` has **no default source**, deliberately: the name `baker` on the public npm registry is an
unrelated package, so guessing would install someone else's software. Give the npm package or git
shorthand your Baker is published at. It cannot bootstrap Baker either — a machine running
`baker bake` already has it — so its job is aligning a cohort on one version.

`opunit` and `baker` install through npm without `sudo`. Where npm's global prefix is root-owned
the install fails with `EACCES`; the fix is a user-owned prefix (nvm, fnm, volta), not `sudo npm`,
which leaves root-owned files in `~/.npm`.

### `docker-extension`

```yaml
tools:
  - docker-extension:
      address: dockersamples/labspace-extension
  # or the shorthand:
  - docker-extension: dockersamples/labspace-extension
```

Installs a Docker **Desktop** extension. Desktop must already be running — Baker does not try to
install or start it, because Desktop cannot be installed non-interactively across the three
platforms and launching a GUI application from a bake is not a bakelet's job. When Desktop is not
reachable the bake stops with a message naming both fixes, and **no install is attempted**.

Docker Engine alone does not provide extensions.

### Agentic coding tools

`claude-code` and `opencode` install an agentic coding CLI into whatever environment is being
provisioned — host, container, or VM — and optionally sync a config repository.

```yaml
tools:
  - claude-code                                # curl install, defaults
  - opencode:
      install: npm                             # "curl" (default) or "npm"
      repo: https://github.com/org/oc-config   # optional config repo
```

Both share the `AgenticTool` base class. Behavior:

- **Idempotent install.** The command is `command -v <bin> >/dev/null 2>&1 || (<install>)`, so
  re-baking an environment that already has the tool is a no-op.
- **Install methods.** `curl` (default) or `npm`. An unrecognized method raises an error listing
  the valid ones.
- **Config repo.** Clone on first bake, `git pull --ff-only` on later bakes. If the destination
  exists but isn't a git repo, Baker prints a message and skips rather than clobbering it — which
  is the common case for a tool-owned `~/.claude`.

The `repo:` value takes a `url:dest` string or an object:

```yaml
tools:
  - claude-code:
      repo:
        repo: https://github.com/org/config
        dest: ~/.claude
```

Defaults for `dest` are the tool's own config directory (`~/.claude` for `claude-code`).

> **Authoring constraint:** install commands must contain no single quotes, because the
> docker-local mode wraps them as `docker exec <c> /bin/bash -c '<cmd>'`. A single quote breaks the
> wrapping.

---

## `services:` — background services

```yaml
services:
  - docker
  - mysql5.7
  - mongodb3.6
```

| Name | Available versions | Playbook |
|------|-------------------|----------|
| `mysql` | `mysql5.7`, `mysql8` | `services/mysql/mysql<v>.yml` |
| `mongodb` | `mongodb3.6` | `services/mongodb/mongodb<v>.yml` |
| `neo4j` | *(unversioned playbook)* | `services/neo4j/neo4j.yml` |
| `docker` | — | Docker CE, inside the environment |

**MySQL** takes config file paths, copied from your project into the environment:

```yaml
services:
  - mysql:
      version: 8
      service_conf: env/templates/mysql.cfg
      client_conf: env/templates/my.cnf
```

**MongoDB** accepts its version as a sub-field as an alternative to the name suffix:

```yaml
services:
  - mongodb:
      version: 3.6
```

---

## `packages:` — OS packages

A plain list of package names. Baker detects the target's package manager and installs with it,
so one configuration works on Debian, Fedora, Arch, openSUSE, Alpine, macOS, and Windows.

```yaml
packages:
  - curl
  - git
  - jq
```

Where a package is spelled differently by different managers, give the variants. Baker falls back
to `name` for any manager you do not list, and fails rather than guessing if you list some but not
the one it detected:

```yaml
packages:
  - name: fd
    apt: fd-find
    dnf: fd-find
    brew: fd
```

The whole list is installed in a single command. Baker adds `sudo` only when the target is not
already root, so this works unchanged inside a container.

---

## `config:` — configuration files and secrets

```yaml
config:
  - template:
      src: ./nginx.conf
      dest: /etc/nginx/nginx.conf
```

| Entry | Purpose |
|-------|---------|
| `files` | Places files and directories at chosen paths, with overlays, pruning, and append |
| `template` | Renders a file through Mustache and writes it to the target, with `vars:` available |

**`vault` was removed.** Both the `config: - vault:` section and the `baker vault` command are
gone. A config still using the section fails with `Cannot find vault in config Bakelets.`

**`keys` was removed.** It copied Baker's own SSH private key into the environment once per name
in the list — every "client key" was the same key, and that key was committed to this repository,
so anyone with the repo held it. It also wrote to `/keys` at the filesystem root under `become: yes`,
and nothing installed the key any more once the control-VM path went. `files:` covers the honest
use case: place a file you control at a path you choose, with a manifest, pruning, and a cleanup
inverse.

### `files` — declarative file placement

Places files and directories at chosen paths inside the environment. Works in every mode, needs no
Ansible and no sudo, and accepts local sources (relative to the `baker.yml`) or `http(s)` URLs.

```yaml
config:
  - files:
      # a shared base layer, then an overlay that wins on any shared path
      - src: ../../base/
        dest: .
      - src: ./overlay/
        dest: .

      - src: ./scripts/submit.sh          # nested dest, made executable
        dest: .scripts/submit.sh
        mode: "0755"

      - src: ./gitignore.block            # merge into a file you do not own
        dest: .gitignore
        append: true

      - ensure: dir                       # a directory with no source
        path: ~/.config/myapp/state

      - src: ./templates/notes.md         # never replaced once it exists
        dest: NOTES.md
        overwrite: false

      - .config/topics/current.md         # shorthand: same path both sides
    run:
      - npm --prefix .tooling install
    prune: true
```

**Entry keys**

| Key | Default | Meaning |
|-----|---------|---------|
| `src` | required (unless `ensure`) | Path relative to the `baker.yml`, or an `http(s)` URL |
| `dest` | defaults to `src` | Relative → environment root; absolute or `~`-prefixed → used verbatim |
| `overwrite` | `true` | `false` skips the entry when the destination already exists |
| `mode` | — | Octal chmod applied after placement, e.g. `"0755"` |
| `append` | `false` | Write between markers instead of replacing the file |
| `ensure` | — | `dir` creates `path:` as a directory; cannot be combined with `src`/`dest` |

**Block keys**, siblings of `files:`:

| Key | Default | Meaning |
|-----|---------|---------|
| `prune` | `false` | Remove in-root paths the last bake placed and this one did not |
| `run` | `[]` | Commands run in the environment root after placement and pruning |

**Ordering is the composition mechanism.** Entries apply in declaration order and a later entry
wins at the same destination. Directory sources *merge* rather than replace, so a base layer plus a
per-unit overlay needs no duplication and no extra schema.

**Convergence.** Baker records what it placed in `.baker-manifest.json` at the environment root.
With `prune: true`, a re-bake removes files the previous bake placed and this one does not, and
removes directories that empty out as a result.

> **Baker-placed files are Baker-owned.** A re-bake replaces your edits to them, and dropping an
> entry from the config deletes the file. Anything you need to keep belongs on a path Baker does not
> write. Pruning is driven entirely by the manifest, so a file Baker never placed is never removed —
> including one sitting inside a directory Baker manages.

`append:` writes between `# >>> baker:<name> >>>` markers and replaces that block in place on each
re-bake, leaving the rest of the file untouched. It is a line-oriented block append, not a merge for
JSON or YAML.

---

## `resources:` — external material

Only `git` is implemented.

```yaml
resources:
  - git: "https://github.com/user/repo.git:/home/vagrant/project"
  - git:
      repo: "https://github.com/user/private.git"
      dest: "/home/vagrant/private"
      private: true
```

The string form is `<url>:<dest>`, split on the last colon after the scheme so that scp-style
remotes (`git@host:org/repo`) stay intact.

For `private: true`, supply credentials through `vars:`:

```yaml
vars:
  - githubuser: myuser
  - githubpass:
      prompt: GitHub token
```

---

## `env:` — environment variables

```yaml
env:
  - MY_VAR: hello
  - DB_HOST: localhost
```

**This must be a YAML list of single-key maps, not a plain map.** The bakelet iterates the value
with `forEach`, so a bare mapping (`env:` followed by indented `KEY: value` pairs without dashes)
throws.

Variables are set for the **user**, so `env:` never needs `sudo`. On Linux and macOS they go to
`~/.baker/env.sh`, sourced from the shell profile and rewritten whole on each bake so removals take
effect; on Windows they are set at `User` scope via `SetEnvironmentVariable`.

---

## `custom:` — your own playbooks

Run an Ansible playbook from your project with the same transport and variables as a built-in
bakelet:

```yaml
custom:
  - mytool:
      path: ./playbooks/mytool.yml
```

`path` points at a playbook **file**, resolved relative to the `baker.yml` — not at a JavaScript
module. Baker uses its own `Custom` bakelet class, which stages the playbook at
`/home/vagrant/baker/<env-name>/<key>.yml` and runs it. See
[Extending Baker](extending.md#custom-playbooks-custom).

---

## `start:` — startup command

A single command run at the end of a successful bake:

```yaml
start: jupyter notebook --no-browser
```

How it runs depends on the mode:

| Mode | Mechanism | Backgrounded |
|------|-----------|--------------|
| local | `child_process.execSync` in the working directory | **no** — blocks until it exits |
| docker | `docker exec <c> /bin/bash -c '<cmd>'` | **no** |
| remote | Ansible `shell` with `nohup`, output to `~/start.out` / `~/start.err` | yes |

In local and docker modes a long-running `start:` command will block the bake. Use `commands:` and
`baker run` instead if you want to launch it separately.

---

## Bakelets with no playbook

Three entries in the catalog do not have a working implementation:

The 0-byte `services: jenkins` and `tools: jenkins-job-builder` stubs, and the orphaned `lxd`
playbook that had no bakelet class, were all **deleted**. Nothing in the catalog is a placeholder
now: every entry listed above resolves to a real class.
