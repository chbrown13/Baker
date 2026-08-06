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
| `maven` | — | No playbook; installs via an Ansible `apt` ad-hoc call |
| `ansible` | e.g. `ansible2` | Ansible itself, on the target |
| `dazed` | e.g. `dazed2` | |
| `defects4j` | e.g. `defects4j2` | Defects4J bug database |
| `claude-code` | — | Agentic coding CLI — see below |
| `opencode` | — | Agentic coding CLI — see below |
| `jenkins-job-builder` | — | **Non-functional.** The file is empty; using it throws. |

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
| `lxd` | — | Playbook exists; no bakelet class, so not selectable from `services:` |
| `jenkins` | — | **Non-functional.** The file is empty; using it throws. |

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
  - keys: ["deploy", "app"]
  - template:
      src: ./nginx.conf
      dest: /etc/nginx/nginx.conf
  - vault:
      - file: secrets/database.yml
        dest: /etc/myapp/database.yml
```

| Entry | Purpose |
|-------|---------|
| `files` | Places files and directories at chosen paths, with overlays, pruning, and append |
| `keys` | Copies the Baker private key into the environment as `<name>_id_rsa` for each listed name |
| `template` | Renders a file through Mustache and writes it to the target, with `vars:` available |
| `vault` | Decrypts Ansible Vault files and places them on the target |

`vault` prompts for a passphrase on first use and caches it per-directory in configstore. Manage
it with `baker vault --clear`.

> **Limitation:** `keys` and `vault` call the SSH helpers directly instead of going through
> `this.copy()`. They work in control-VM and remote modes but **not** in local or docker mode. Use
> `files` instead where you only need to place a file. See
> [Troubleshooting](troubleshooting.md#bakelets-that-bypass-the-transport).

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
| control-VM | the `start` helper over SSH | yes |

In local and docker modes a long-running `start:` command will block the bake. Use `commands:` and
`baker run` instead if you want to launch it separately.

---

## Bakelets with no playbook

Three entries in the catalog do not have a working implementation:

| Entry | State |
|-------|-------|
| `services: jenkins` | `lib/bakelets/services/jenkins.js` is a 0-byte file |
| `tools: jenkins-job-builder` | `lib/bakelets/tools/jenkins-job-builder.js` is a 0-byte file |
| `services: lxd` | playbook exists at `services/lxd/lxd.yml`, but no bakelet class references it |

Requiring an empty module yields `{}`, so the resolver's `new classFoo(...)` throws a `TypeError`
rather than a helpful message. Avoid these three.
