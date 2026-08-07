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
| [`init`](#baker-init) | Write a starter `baker.yml` | **broken** |
| [`run`](#baker-run) | Run a named command from `commands:` | **broken outside `docker:`** |

The two marked broken are documented below with their exact failure, rather than omitted.

---

## `baker bake`

Configure a local machine, container, or remote host from a `baker.yml`.

```
baker bake [source] [--local <path>] [--repo <url>] [--file <url>] [--verbose]
```

| Argument | Description |
|----------|-------------|
| `source` | Where the `baker.yml` comes from: a directory, `owner/repo`, `owner/repo:subdir`, or a URL. Always resolves to a directory containing a literal `baker.yml`. Omit to use `./baker.yml`. |

```bash
baker bake                                # ./baker.yml
baker bake ~/project                      # a directory containing baker.yml
baker bake ottomatica/baker-test          # clone a GitHub repo, use its baker.yml
baker bake your-org/configs:units/one     # clone, then use the baker.yml in units/one
baker bake https://gist.github.com/…      # a gist, snippet, or raw file URL
```

An address ending in `.yml` is rejected — that form belongs to [`baker check`](#baker-check).

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
| `target` | A profile address `<user>/<repo>:<file.yml>`. Omit to run local checks. |

| Invocation | Delegates to | Runs against |
|------------|--------------|--------------|
| `baker check` | `opunit verify local` | the local machine, using `test/opunit.yml` |
| `baker check <user>/<repo>:<file.yml>` | `opunit profile <address>` | the local machine, using a checks file fetched from GitHub |

Opunit's output streams through directly and its exit code is propagated, so
`baker bake && baker check` works in CI.

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

`source` takes the same grammar as `bake`. Omit it to use `./baker.yml`.

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

It refuses to overwrite an existing `baker.yml`, then prompts for a name, memory, an IP, port
forwards, and checkbox lists of languages, services, and tools.

> **This command is currently broken.** The template it renders emits a `vm:` key, and `vm:` was
> retired with the VirtualBox provider — so `baker bake` rejects the file `baker init` just wrote:
>
> ```
> $ baker init
> $ baker bake
> ==> Error: 'vm:' is no longer supported.
> ```
>
> The memory and IP prompts are also meaningless for the three current providers. Write your
> `baker.yml` by hand from the [reference](baker-yml-reference.md) until this is rebuilt.

---

## `baker run`

Run a named command from the `commands:` block of `baker.yml`.

```
baker run [cmdlet]
```

```yaml
name: dev
docker: node:18
commands:
  test: npm test
  serve: npm start
```

```bash
baker run test
baker run          # with no argument, lists the available cmdlets
```

> **This command only works on `docker:`.** It wraps the script as
> `cd /<project-basename>; <script>` — the path where your project was mounted inside the old
> control VM. That directory does not exist on a local host, so `local:` fails with
> `spawnSync /bin/sh ENOENT`.
>
> On `remote:` it fails differently and more quietly: the remote provider's `ssh()` takes no
> arguments, so the command is discarded and an interactive shell opens instead.
