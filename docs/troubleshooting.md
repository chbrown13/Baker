# Troubleshooting and known issues

## Known limitations

These are real gaps in Baker, not misconfiguration. Listed so you can recognize them quickly.

### Sudo and the playbook-backed tier

The playbook-backed bakelets — `lang:`, `services:`, `custom:`, and
`tools: jekyll`/`dazed`/`defects4j` — declare `become: yes`. Against a target with no cached sudo
credentials they fail:

```
sudo: a password is required
```

**Workaround:** grant passwordless sudo on the target.

```bash
sudo visudo
# your-username ALL=(ALL) NOPASSWD: ALL
```

For `docker:` this is already satisfied — the container runs as root, and Baker computes the `sudo`
prefix from the target's user id rather than hardcoding it.

**The portable tier needs none of this.** `files:`, `tools:`, `env:`, `config: template`,
`packages:`, `resources:`, and `start:` run as plain commands. If a config sticks to those, sudo
never enters the picture beyond whatever an individual package manager asks for.

### `baker run` says the environment is not baked

```
==> Error: my-project is not recorded as baked. Run `baker bake` first, or pass --force to run anyway.
```

`run` acts on an environment that already exists. If you have baked and still see this, the record
is keyed on the `name:` in `baker.yml` — two checkouts sharing a name overwrite each other's entry,
and clearing `~/.baker` removes it entirely. `baker run <cmdlet> --force` runs regardless.

### `baker run` hangs with no output

The command is waiting for input that cannot arrive. `run` streams output but attaches no keyboard,
so anything that prompts — a script calling `read`, an `npm login`, a `git` command that opens a
pager — will print its prompt and then sit there. Rewrite the command to take its values from
`env:` or from arguments.

### `baker run` says the working directory does not exist

```
==> Error: /my-project does not exist in my-project.
```

On `docker:` and `remote:` the command runs in `/<project-basename>`, the same place
`config: files:` writes to. Nothing creates that directory on its own — if your config has no
`files:` entry, there is nothing there to run in. Add one, or use `local:`, where the working
directory is your project folder and always exists. `--force` does not skip this check.
  port: 22
```

### Empty bakelet files

The 0-byte `services: jenkins` and `tools: jenkins-job-builder` stubs were deleted, along with the
orphaned `lxd` playbook. If you hit `TypeError: classFoo is not a constructor` from the resolver, a
bakelet module exists but exports nothing — `test/bake/test-command-tables.js` guards against a new
one appearing.

### Clearing the source cache

Clones and single-file fetches are cached under `~/.baker/cache/`. Nothing prunes it, but nothing
in it is precious either — deleting it costs one re-clone:

```bash
rm -rf ~/.baker/cache
```

If a cache directory exists but is not a Baker clone, `bake` refuses and names the path rather than
overwriting it. Removing that path and re-running is the fix.

*(Older versions staged into `tmp/baker-file-<random>` under your working directory. If you have
leftovers from one, `rm -rf tmp/baker-file-*` is safe.)*

### `destroy` doesn't reverse a local bake

For the `local:` provider, `baker destroy` removes `~/.baker/<name>/` and the index entry.
Everything the bake actually installed on your machine stays. Treat `local:` as additive.

The same applies to `remote:` — `destroy` removes the staging directory
`/home/vagrant/baker/<name>` on the server, nothing else.

### Bakelet ordering isn't configurable

Categories always run `lang → config → services → tools → packages → resources → env → custom →
start`. If a tool must be installed before a service, that ordering can't be expressed. Workaround:
use a `custom:` bakelet, or fold the dependency into a single bakelet.

### `start:` failures are invisible

`start:` is backgrounded in all three modes — local spawns detached, docker uses `docker exec -d`,
remote uses `nohup`. The trade-off is that a `start:` command which exits non-zero fails silently:
its output is discarded, so nothing surfaces in the terminal or in `bake.log`.

If a `start:` command is not doing what you expect, run it by hand in the environment first.

A `start:` value containing a single quote also breaks in docker mode, because the command is
wrapped as `bash -c '<cmd>'`.

### `ports:` is ignored on `docker:`

The key parses and is then discarded — no port bindings are configured for the container.

### Other pre-existing issues

- The `padLevels` warning at startup comes from a transitive dependency.
- macOS and Windows are covered by a CI matrix that has **not yet run**, so package names for the
  non-apt managers — `latex` especially, and every `choco` entry — are unconfirmed.
- The Windows elevation check's *detection* half is unverified on a real non-admin shell. The
  "nothing was written" half is proven by a filesystem-hash test.

---

## Common failures

### `Cannot find <name> in <category> Bakelets. Did you mean <category>:<name>?`

The bakelet name doesn't resolve to a module in that category. Either it's in a different category
than you listed it under (the message suggests the right one), or the version you asked for has no
playbook. Check the tables in [Bakelets](bakelets.md) for what actually ships.

### `A bakelet task failed, see output for details`

An Ansible playbook reported a non-zero `failed=` count. Re-run with `--verbose` for the full
Ansible output — the recap line alone rarely says enough.

```bash
baker bake --verbose
```

### `Failed to run bakelet, see output for details`

Ansible produced no recap line at all, which usually means it never started — `ansible-playbook`
missing from `PATH`, an inventory that resolved to nothing, or an immediate connection failure.

Verify Ansible is installed on the **host** for `local:`, `docker:`, and `remote:` modes:

```bash
ansible --version
```

### `no supported environment found in baker.yml.`

No recognized provider key in `baker.yml`. Add exactly one of `docker:`, `local:`, or `remote:`.
An empty file, or one that is a list rather than a mapping, produces the same error.

If the message instead names a key — `'vm:' is no longer supported` — the config was written
against a provider that has been removed. See
[Providers](providers.md#retired-keys); there is no compatibility shim.

### `invalid baker.yml for remote provider`

The `remote:` block is missing `ip`, `user`, or `private_key`. All three are required.

### `Can't find baker.yml in current directory`

`baker bake` with no argument requires `./baker.yml`. Pass a source explicitly, run
[`baker init`](baker-commands.md#baker-init) to write one, or write it by hand from the
[reference](baker-yml-reference.md).

### `opunit not found on PATH`

`baker check` shells out to opunit:

```bash
npm install -g ottomatica/opunit
```

### `<address> addresses a file. bake takes a directory containing a baker.yml`

`bake` resolves to a **directory**; an address ending in `.yml` is `baker check`'s grammar. Point
at the directory holding the `baker.yml` instead:

```bash
baker bake  owner/repo@PM3          # not owner/repo:one.yml
baker check owner/profiles:one.yml   # the .yml form belongs here
```

### `<address> addresses a sub-directory, which bake no longer supports`

A repository holds one `baker.yml`, at its top level. Select a variant with a branch or tag —
`owner/repo@PM3` — rather than a path. The error suggests the equivalent ref.

### `No baker.yml at the top level of <repo>`

The repo cloned, but has no `baker.yml` at its root. The error names the exact path Baker
looked in. Each config directory needs its own literal `baker.yml`.

### Docker: permission denied on `/var/run/docker.sock`

```bash
sudo usermod -aG docker $USER   # then log out and back in
```

Or point `DOCKER_HOST` at a daemon you can reach.

### Docker: container exists but re-baking recreates it

Expected. A **running** container is reused; a **stopped** one is removed and recreated. If you
want to keep state, don't let the container stop between bakes.

### `env:` throws on a plain mapping

`env:` must be a **list** of single-key maps:

```yaml
env:
  - MY_VAR: hello      # correct

env:
  MY_VAR: hello        # throws — the bakelet calls forEach on this
```

### `Cannot find vault in config Bakelets.`

The `config: - vault:` section and the `baker vault` command were both removed. For a per-person
secret, have the person place it themselves and assert it with `baker check` rather than shipping
an encrypted file that everyone must be able to decrypt.

---

## Getting more detail

Almost every command takes `--verbose` / `-v`, which prints the flattened Ansible variables and the
raw playbook output. It's the first thing to reach for.

Every failure is also appended to `~/.baker/bake.log` with the command that failed, the package
manager in use, and the likely fix. `env:` values are redacted from both the terminal and the log.

To see what Baker thinks exists:

```bash
cat ~/.baker/data/index.json    # the raw environment index
ls ~/.baker/cache/              # resolved baker.yml sources
```

To inspect what a bakelet staged, look under `/home/vagrant/baker/<name>/` on the target (or the
working directory in local mode) — the generated playbooks are left in place.

`baker cleanup --dry-run` prints exactly what a bake placed, without changing anything. It is a
useful way to see what Baker believes it owns.
