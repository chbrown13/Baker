# Troubleshooting and known issues

## Known limitations

These are real gaps in Baker, not misconfiguration. Listed so you can recognize them quickly.

### Sudo in host-direct modes

Every built-in bakelet playbook declares `become: yes`. In `local:`, `remote:`, and `docker:` modes
Ansible runs against a target with no cached sudo credentials, so provisioning fails:

```
sudo: a password is required
```

**Workaround:** grant passwordless sudo on the target.

```bash
sudo visudo
# your-username ALL=(ALL) NOPASSWD: ALL
```

For `docker:` this is already satisfied — the container runs as root.

This is the outstanding architectural decision for the project. The options under consideration
are: keep Ansible and fix `-c local` become handling (still needs sudo); replace Ansible with
direct `execSync` calls (still needs sudo); or introduce user-local bakelets that install into
`$HOME` and need no root at all. Only the third actually removes the requirement.

### Bakelets that bypass the transport

`config: keys` and `config: template` call `Ssh.copyFromHostToVM` directly instead of going
through `this.copy()`. Because the resolver rebinds `copy()`/`exec()` per mode but cannot
intercept a direct SSH call, these two bakelets:

- **work** in control-VM mode and in `remote:` mode (which sets `ansibleSSHConfig` to the remote's
  config),
- **fail** in `local:` and `docker:` mode.

Avoid `keys` and `template` in host-direct environments. See
[Extending Baker](extending.md#rules-to-follow) for why custom bakelets should not repeat this.

### `--remote` flag is broken

`lib/commands/bake.js:159` calls `BakerObj.bakeRemote(...)`, which has no definition in
`lib/modules/baker.js`. Any invocation of:

```bash
baker bake --remote <ip> --remote_key <key> --remote_user <user>
```

throws a `TypeError`.

**Use the `remote:` key in `baker.yml` instead** — that path is implemented and tested:

```yaml
remote:
  ip: 10.0.0.5
  user: ubuntu
  private_key: ~/.ssh/id_rsa
  port: 22
```

### Empty bakelet files

`services: jenkins` and `tools: jenkins-job-builder` are 0-byte files. Requiring one yields `{}`,
so the resolver's `new classFoo(...)` throws an unhelpful `TypeError: classFoo is not a
constructor` rather than reporting an unimplemented bakelet.

`services/lxd/lxd.yml` exists as a playbook but has no bakelet class, so it can't be selected.

### Temp directories accumulate

Single-file sources (gists, raw URLs, differently-named local `.yml` files) stage into
`tmp/baker-file-<random>` under your current directory, and nothing removes them.

```bash
rm -rf tmp/baker-file-*
```

### `destroy` doesn't reverse a local bake

For the `local:` provider, `baker destroy` removes `~/.baker/<name>/` and the index entry.
Everything the bake actually installed on your machine stays. Treat `local:` as additive.

The same applies to `remote:` — `destroy` removes the staging directory
`/home/vagrant/baker/<name>` on the server, nothing else.

### Bakelet ordering isn't configurable

Categories always run `lang → config → services → tools → packages → resources → env → custom →
start`. If a tool must be installed before a service, that ordering can't be expressed. Workaround:
use a `custom:` bakelet, or fold the dependency into a single bakelet.

### `start:` blocks in local and docker modes

In `local:` and `docker:` modes, `start:` runs through a synchronous `execSync` and is **not**
backgrounded, so a long-running command blocks the bake from finishing. Remote and control-VM modes
background it properly.

Use `commands:` plus `baker run` if you want to launch a server separately.

### Other pre-existing issues

- The `padLevels` warning at startup comes from a transitive dependency.
- `node-virtualbox` has been unmaintained since 2016.
- macOS and Windows are not currently tested.
- `owner/repo:sub/dir/file.yml` sub-directory paths are explicitly rejected by the source resolver.
- DigitalOcean has a provider class but no `baker.yml` key, so it can't be selected by a bake.

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

### `This command only supports VM, container, docker, and local environments`

No recognized provider key in `baker.yml`. Add one of `docker:`, `local:`, `container:`, `vm:`,
`vagrant:`, or `remote:`. See [Providers](providers.md#how-a-provider-is-selected).

### `invalid baker.yml for remote provider`

The `remote:` block is missing `ip`, `user`, or `private_key`. All three are required.

### `Can't find baker.yml in current directory`

`baker bake` with no argument requires `./baker.yml`. Pass a source explicitly, or run
`baker init`.

### `opunit not found on PATH`

`baker check` shells out to opunit:

```bash
npm install -g ottomatica/opunit
```

### `Sub-directory paths (owner/repo:sub/file.yml) are not supported yet`

Only top-level files work with the shorthand. Clone the repo and use `baker bake <dir>`, or use a
tree URL:

```bash
baker bake https://github.com/owner/repo/tree/master/subdir
```

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

### baker-srv problems

```bash
baker server ssh          # shell into the control VM
baker server reload       # stop and start it
baker setup --force       # destroy and reinstall it
baker server repair <env> # fix a wedged environment (e.g. locked dpkg)
```

If the VM won't come up at all, check that VirtualBox is installed and that hardware
virtualization is enabled:

```bash
baker status
```

---

## Getting more detail

Almost every command takes `--verbose` / `-v`, which prints the flattened Ansible variables and the
raw playbook output. It's the first thing to reach for.

To see what Baker thinks exists:

```bash
baker status                    # virtualization support + all environments
cat ~/.baker/data/index.json    # the raw environment index
```

To inspect what a bakelet staged, look under `/home/vagrant/baker/<name>/` on the target (or the
working directory in local mode) — the generated playbooks are left in place.
