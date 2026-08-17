# Baker CLI Reference

Run `baker <command> --help` for per-command flags and examples.

See also: [`baker.yml` reference](baker-yml-reference.md) ·
[Configuration sources](configuration-sources.md) · [Providers](providers.md)

Baker ships seven commands:

| Command | What it does | State |
|---|---|---|
| [`bake`](#baker-bake) | Configure an environment from a `baker.yml` | |
| [`check`](#baker-check) | Verify the result with opunit | |
| [`cleanup`](#baker-cleanup) | Undo what a bake placed | |
| [`delete` / `destroy`](#baker-delete--baker-destroy) | Tear down the environment | |
| [`ssh`](#baker-ssh) | Get a shell in the environment | |
| [`init`](#baker-init) | Write a starter `baker.yml` | |
| [`run`](#baker-run) | Run a named command from `commands:` | **broken outside `docker:`** |

The one marked broken is documented below with its exact failure, rather than omitted.

---

## `baker bake`

Configure a local machine, container, or remote host from a `baker.yml`.

```
baker bake [source] [--local <path>] [--repo <url>] [--file <url>] [--verbose]
```

| Argument | Description |
|----------|-------------|
| `source` | Where the `baker.yml` comes from: a directory, `owner/repo`, `owner/repo@ref`, or a URL. Always resolves to a directory whose **top level** holds a literal `baker.yml`. Omit to use `./baker.yml`. |

```bash
baker bake                                # ./baker.yml
baker bake ~/project                      # a directory containing baker.yml
baker bake ottomatica/baker-test          # clone a GitHub repo, use its baker.yml
baker bake your-org/configs@PM3           # clone at a branch or tag
baker bake https://gist.github.com/…      # a gist, snippet, or raw file URL
```

Three forms are rejected, each naming the fix:

- `owner/repo:env.yml` — that grammar belongs to [`baker check`](#baker-check)
- `owner/repo:subdir` — a repository holds one `baker.yml`, at its top level; use `@ref`
- **any path to a file**, including `./project/baker.yml` — `bake` reads a *directory*

The file `bake` reads is always literally `baker.yml`. A differently-named local config is rejected
with the `mv` that fixes it, rather than being renamed behind your back.

An existing local path always wins over the `owner/repo` shorthand. Clones and fetches go to
`~/.baker/cache/`, never your working directory, and re-baking updates an existing clone rather
than failing. See [Configuration sources](configuration-sources.md).

**Flags** — explicit overrides that bypass the positional resolver:

| Flag | Alias | Description |
|------|-------|-------------|
| `--local` | `-l` | Path to a directory containing `baker.yml` |
| `--repo` | `-r` | Git repo URL to clone; `baker.yml` must be in its root |
| `--file` | `-f` | URL to a single `baker.yml` — gist, GitLab snippet, or raw file |
| `--verbose` | `-v` | Print full command and playbook output |

The provider is chosen from the top-level keys in `baker.yml` — there is no provider flag. See
[Providers](providers.md#how-a-provider-is-selected).

**Before anything runs**, a pre-flight gate checks that the target can support every section the
config asks for — Ansible availability for the Linux-target tier, and Administrator rights on
Windows where Chocolatey needs them. A refused bake changes nothing.

Failures are written to `~/.baker/bake.log` with the command, the package manager in use, and the
likely fix. `env:` values are redacted from both the terminal and the log.

---

## `baker check`

Run [opunit](https://github.com/ottomatica/opunit) checks to verify an environment is configured
correctly. Delegates to the `opunit` CLI, which must be installed and on your `PATH`
(`npm install -g ottomatica/opunit`).

```
baker check [target]
```

| Argument | Description |
|----------|-------------|
| `target` | A profile address `<owner>/<repo>[@<ref>]:<file>.yml`. Omit to run local checks. |

| Invocation | Runs against |
|------------|--------------|
| `baker check` | the local machine, using `./test/opunit.yml` |
| `baker check <owner>/<repo>:<file>.yml` | the local machine, using a profile from the repository's default branch |
| `baker check <owner>/<repo>@<ref>:<file>.yml` | the local machine, using a profile from the named branch or tag |

The file may sit at any path in the repository — `org/profiles:env.yml` and
`org/profiles:units/unit-1.yml` both work. Note this is the **opposite** of `bake`, which takes a
repository and requires `baker.yml` at the top level.

Opunit's output streams through directly and its exit code is propagated, so
`baker bake && baker check` works in CI.

Requires **opunit 0.9.4 or newer**, which is what `baker bake` installs for a `tools: opunit`
entry. Older versions do not accept the profile path Baker passes them.

### Baker fetches the profile, pinned to a commit

Baker resolves the address to a commit before fetching it: one `git ls-remote` finds the sha, and
the profile is downloaded from a URL naming that sha. Two things follow.

**A pushed profile takes effect immediately.** There is no CDN staleness window — a URL naming an
immutable commit cannot return the wrong content however it is cached. Push a corrected profile and
the next `baker check` anywhere in the cohort runs it.

**Every run says what it checked against**, so pasted terminal output identifies its own profile:

```
$ baker check org/profiles:env.yml
==> Using profile org/profiles:env.yml @ a1b2c3d (main)
```

The branch is **discovered, not assumed** — a repository whose only branch is `main` works exactly
like one with `master`. Fetched profiles are cached under `~/.baker/cache/profiles/` by commit, so
re-running while you fix your environment re-downloads nothing.

### Selecting a profile by branch or tag

An assignment's checks can be pinned the same way its config is:

```
baker bake  your-org/configs@unit-1
baker check your-org/profiles@unit-1:env.yml
```

An annotated tag resolves to the commit it points at. A ref that does not exist is named:

```
$ baker check org/profiles@unit-9:env.yml
==> https://github.com/org/profiles.git has no branch or tag "unit-9".
```

### A failed lookup is a failure, not a fallback

If the repository cannot be read — no network, a typo, a private repo — `baker check` stops and
opunit is never started. It does **not** fall back to a previously cached profile: a passing check
has to mean *the current* profile passed. Local mode (`baker check` with no argument) still works
offline.

A private or mistyped repository fails immediately rather than prompting for credentials, so a
terminal never hangs on an invisible password prompt.

### A target that cannot be run is an error

Only the **absence** of a target selects local mode. A target that is not a profile address is
refused, and opunit is not spawned:

```
$ baker check your-org/configs
==> your-org/configs is not an opunit profile address.
    `check` takes <owner>/<repo>[@<ref>]:<file>.yml — a .yml file at any path in a GitHub
    repository, on the default branch or on the named branch or tag.
    Omit the argument to run ./test/opunit.yml against this machine.
```

Previously an unrecognised target fell through to `opunit verify local`, which ran a *different*
check and reported its result as though it were the requested one.

**Baker installs, opunit asserts.** Some things cannot be installed non-interactively — Docker
Desktop, a personal git identity, an API key belonging to one person. Baker does not fake them;
it configures what it can and `check` gates the rest.

---

## `baker cleanup`

Remove what a bake put on this machine — the inverse of `bake`. Where `destroy` tears down the
*environment*, `cleanup` undoes an *injection*: the files, config, environment variables, cloned
repositories, and tools a bake placed on a machine you keep using.

```
baker cleanup [source] [--dry-run] [--yes] [--all] [--verbose]
```

`source` takes **exactly** the same grammar as `bake` — both call the same resolver, so an address that bakes will clean up. Omit it to use `./baker.yml`.

| Flag | Alias | Description |
|------|-------|-------------|
| `--dry-run` | | Print the full plan and exit. No prompts, no changes, nothing logged |
| `--yes` | `-y` | Non-interactive: accept the default answer for every prompt |
| `--all` | | With `--yes`, select everything not refused. Requires `--yes`; cannot override a guard |
| `--verbose` | `-v` | Extra output from the removal process |

### How it decides what to remove

Cleanup re-derives the file set from the same config `bake` used, rather than scanning your project
for anything that looks like Baker's. **A file Baker never placed can therefore never be removed** —
it is not in the set. Directories are deleted only once empty, so one holding your own work
survives.

Defaults follow a risk gradient, and every one is overridable at the prompt:

| Section | Default | Why |
|---|---|---|
| `files:`, `config:`, `env:` | **remove** | Baker placed them, in a scope Baker owns |
| `tools:` | **keep** | Baker cannot tell whether it installed a tool or found it already there |
| cloned repositories | **keep** | May hold work of yours |

### Guards you cannot override

A cloned repository with uncommitted changes, untracked files, or unpushed commits is **refused** —
not offered, not selectable, and unaffected by `--all`. So is a clone destination that exists but is
not a git repository. Only a clean clone is removable, because only a clean clone is recoverable
from its remote.

### Two limitations it states on every run

- **Files Baker placed are Baker's.** A file you edited is still deleted; anything you need to keep
  belongs on a path Baker does not write.
- **Cleanup inverts the config it is given.** If the config changed since you baked, files from the
  older version are not in the derived set and remain behind. The output names the directory where
  they would be.

Sections with no inverse — `lang:`, `services:`, `packages:`, `custom:`, `start:` — are reported and
left alone at every flag combination.

**Tools installed the default way on Linux and macOS usually cannot be removed.** The agentic tool
bakelets default to `curl`, whose installers place files wherever their own scripts decide, so
there is no derivable inverse. Cleanup reports "no uninstall available" rather than guessing. On
Windows both default to `npm`, which inverts cleanly.

Every run appends to `~/.baker/cleanup.log` with a restore hint per item. That file stays on your
machine and is never transmitted.

---

## `baker delete` / `baker destroy`

Tear down the environment described by `./baker.yml`.

```
baker delete [VMName]
baker destroy [VMName]
```

The two names are aliases. The environment is identified from `./baker.yml`, so the positional
argument is currently ignored.

What "tear down" means depends on the provider:

| Provider | Effect |
|---|---|
| `local:` | removes `~/.baker/<name>/` |
| `docker:` | stops and removes the container |
| `remote:` | removes the staging directory on the remote |

**On `local:` and `remote:` this is not an undo.** Packages, tools, and placed files stay. The
command says so and points at `cleanup`, which is the command that reverses a bake.

---

## `baker ssh`

Open a shell in the environment described by `./baker.yml`.

```
baker ssh [VMName]
```

| Provider | Effect |
|---|---|
| `local:` | opens `$SHELL`, falling back to `/bin/sh` |
| `docker:` | `docker exec -it <name> /bin/bash` |
| `remote:` | an interactive SSH session |

On `local:` this opens a shell on the machine you are already using, which is rarely what you want.

---

## `baker init`

Write a starter `baker.yml` in the current directory, interactively.

```
baker init
```

`init` is an **authoring tool**. You run it once in the repository you are preparing, commit the
result, and the people you hand the repository to run `baker bake`. That is why it warns about
choices that work on your machine but not on theirs.

It refuses to overwrite an existing `baker.yml`, then asks for:

| Prompt | Notes |
|--------|-------|
| Environment name | Defaults to the directory name |
| Where will this run? | `local:` (default), `docker:`, or `remote:` — each option states what it means for a group |
| Tools | Generated from the available bakelets, with anything already detected pre-checked |
| System packages | Comma separated, optional |
| Materials directory | Optional; becomes a `config: - files:` block |

### It reads the repository first

`init` looks for a few exact files and pre-checks the matching tool:

| Found | Proposes |
|-------|----------|
| `pom.xml` | `tools: maven` |
| `package.json` | `tools: node` |
| `CLAUDE.md` or `.claude/` | `tools: claude-code` |

It proposes `tools:` entries rather than `lang:` ones deliberately — every `lang:` and `services:`
bakelet needs Ansible and sudo on a Linux target, so proposing one would produce a config that
fails for anyone on Windows or macOS. Detection only pre-checks boxes; you still decide.

### It warns before you ship a config that cannot work

Two checks happen before anything is written, and declining either one writes nothing:

- **A tool that needs Ansible and sudo** (`jekyll`, `dazed`, `defects4j`) selected against a
  `local:` or `docker:` target — these fail for anyone not on Linux. Under `remote:` there is no
  warning, since you control that host's OS.
- **A Debian-only package spelling** such as `build-essential` or `python3-dev`. `init` shows what
  the name is on other managers and points at the portable `tools:` entry where one exists.

```
$ baker init
==> Detected: Maven project
==> 'build-essential' is a Debian/Ubuntu spelling. Elsewhere: dnf: gcc-c++ make, pacman: base-devel.
    Consider tools: - cpp instead — Baker maps it per manager.
? Keep 'build-essential' anyway? (y/N)
```

The generated file opens with a comment saying it came from `init`, and contains only the sections
you answered for — see the [`baker.yml` reference](baker-yml-reference.md) for everything else.

---

## `baker run`

Run a named command from the `commands:` block of `baker.yml`.

```
baker run [cmdlet] [--force]
```

```yaml
name: dev
local: .
commands:
  test: npm test
  setup: ./scripts/setup.sh
```

```bash
baker run test
baker run          # with no argument, lists the available cmdlets
```

Works on all three providers. Output **streams as it happens**, and the command's exit code
becomes Baker's, so `baker run test` can be used in a script.

### Where the command runs

Each provider has a working directory, and it is the same one `config: files:` writes into:

| Provider | Working directory |
|----------|-------------------|
| `local:` | your project directory — the resolved `local:` path |
| `docker:` | `/<project-basename>` inside the container, via `docker exec -w` |
| `remote:` | `/<project-basename>` on the host, via `cd` |

That directory is a **starting point, not a constraint** — a command may `cd` further:

```yaml
commands:
  setup: cd tools && ./install.sh
```

### Requirements

`run` acts on an environment that already exists, so **bake first**. If Baker has no record of the
environment it refuses and says so. That record is keyed on the `name:` in your `baker.yml`, so two
checkouts sharing a name overwrite each other's entry — pass `--force` to run anyway when the
record is wrong.

`--force` skips only that check. If the working directory itself is missing, `run` still refuses:
the command would have nowhere to run, and a missing directory is not something a flag can fix.

> **Commands must not prompt for input.** `run` streams output but attaches no keyboard, so a
> command that asks a question will print it and then appear to hang. Take values from `env:` or
> from the script's own arguments instead.

`run` writes no log. Re-run the command and copy what you see.

`baker run hello` is a built-in smoke test: it prints `hello` on your machine without contacting
any provider, which makes it a way to check Baker is wired up before a transport works. It shadows
a `hello` entry of your own if you define one.
