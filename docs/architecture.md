# Architecture

Internals, aimed at contributors. For the user-level model see [Core concepts](concepts.md).

## Repository layout

```
baker.js                        CLI entry point — yargs, .commandDir('./lib/commands')
global-vars.js                  Shared paths (~/.baker, bakelets, remotes)

lib/
  commands/                     One file per CLI command (yargs command modules)
  modules/
    baker.js                    Baker class + chooseProvider()
    ssh.js                      SSH/SCP helpers over ssh2 and scp2
    platform.js                 Package-manager detection against the target
    preflight.js                Elevation + Ansible gate, run before any bakelet
    bake-log.js                 Failure wrapping, ~/.baker/bake.log, redaction
    validator.js                baker.yml validation
    print.js, spinner.js        Output helpers
    configstore.js              Persistent settings
    init/                       `baker init`'s three layers:
      detect.js                   read the repo, propose, decide nothing
      offer.js                    enumerate lib/bakelets/tools/, annotate each
      render.js                   answers object -> baker.yml string
    configuration/ansible.js    Four families of Ansible invocation
    utils/
      source.js                 Unified baker.yml source resolver
      git.js                    Clone / tree-URL / gist / snippet fetching,
                                ls-remote ref resolution for `baker check`
      utils.js                  Env index, prompts, file helpers
    providers/
      provider.js               Base class
      local.js  docker-local.js  remote.js
  bakelets/
    bakelet.js                  Base class: copy() / exec() / execCapture(),
                                command tables, requiresAnsible, requiresElevation
    resolve.js                  Dispatcher — the heart of the system
    custom.js  start.js
    lang/ tools/ services/ packages/ config/ resources/ env/

remotes/bakelets-source/        Ansible playbooks and Mustache templates
config/                         Ansible fragments and host scaffolding
test/bake/                      Mocha suites (npm test)
test/integration/               Integration suites (npm run int-test)
```

## Command flow

Every CLI command is a yargs module with `command` / `desc` / `builder` / `handler`. `baker.js`
loads the whole directory, so adding a command means adding a file.

A typical `baker bake` proceeds:

```
bake.js handler
  └─ resolveSource(source)              → a directory containing baker.yml (under ~/.baker/cache)
  └─ Baker.chooseProvider(bakePath)     → {envName, provider, BakerObj, doc}
       └─ throws on a retired key, an empty file, or no recognised key
  └─ BakerObj.bake(bakePath, …)         → provider.bake(...)
       └─ provider-specific setup       (pull image / mkdir on remote)
       └─ resolveBakelet(...)
            └─ makeTransport()          → one {copy, exec, execCapture} for the bake
            └─ constructBakelet() × n   → build without running
            └─ Preflight.check()        → refuse an impossible bake, change nothing
            └─ run each bakelet's load() then install()
```

The `Baker` class is a thin delegator: `ssh`, `delete`, `bake`, `planRemoval`, and `applyRemoval`
forward straight to the provider. The interesting logic is in `chooseProvider` and the providers.

### Provider selection

`Baker.chooseProvider()` checks retired keys first, then the three live ones:

```js
let retired = Object.keys(RETIRED_ENV_KEYS).find(key => doc[key]);
if (retired) throw new Error(Baker.retiredEnvMessage(retired));

let envType = doc.docker ? 'docker-local'
            : doc.local ? 'local'
            : doc.remote ? 'remote'
            : 'other';
```

Retired keys are tested first deliberately: a config carrying both `local:` and `vm:` gets the
specific explanation rather than silently ignoring the dead half. `'other'` throws too, so the
function never returns a null provider. There are no override flags.

## The provider contract

Providers extend `lib/modules/providers/provider.js` and implement:

| Method | Purpose |
|--------|---------|
| `bake(scriptPath, ansibleSSHConfig, verbose)` | Create the target, then run bakelets against it |
| `ssh(name, cmdToRun, terminate, verbose, options)` | Interactive shell, or run one command |
| `delete(name)` | Tear down the target |
| `planRemoval` / `applyRemoval` | The `baker cleanup` seam — `planRemoval` must be side-effect free |
| `list()` | Print a table of this provider's environments |
| `getSSHConfig(name)` | Connection details |

`bake()` is where a provider differs most. The pattern is: prepare the target, then hand off to
`resolveBakelet` with the argument that selects the execution mode.

```js
// local.js
await resolveB.resolveBakelet(bakeletsPath, remotesPath, doc, scriptPath, verbose, location);

// remote.js
await resolveB.resolveBakelet(…, verbose, null, remoteSSHConfig);

// docker-local.js
await resolveB.resolveBakelet(…, verbose, null, null, name);
```

The three trailing parameters — `localLocation`, `remoteSSHConfig`, `dockerContainer` — are
mutually exclusive. Whichever is truthy selects the mode. All three absent is now unreachable: it
was the control-VM path, and `makeTransport()` throws
`no transport for this environment: expected local:, docker:, or remote:.` if it ever happens.

## The bakelet dispatcher

`lib/bakelets/resolve.js` is the central piece. `resolveBakelet()` walks the categories in fixed
order (`lang`, `config`, `services`, `tools`, `packages`, `resources`, `env`, `custom`, `start`)
and calls `resolve()` per entry.

### Name and version parsing

`getBakeletInformation()` turns a YAML entry into `{mod, version, bakeletName}`:

- **Object entries** (`{mysql: {version: 8}}`) take the first key as the bakelet name.
- **String entries** run through
  `/([a-zA-Z]*)([0-9]+\.?[0-9]*$)|([a-zA-Z-0-9]*)/`, which splits a trailing version off an
  alphabetic prefix. `neo4j3.3` → `neo4j` + `3.3`; `jupyter` → `jupyter` + `''`.

The module path is `<bakeletsPath>/<category>/<name>`, loaded with `require`. On failure the
resolver scans every category for a matching name and suggests the right one:
`Did you mean services:mysql?`

### Mode patching

Once the class is loaded, the resolver constructs it and rebinds its transport methods according
to the mode:

| Mode | `j.copy` | `j.exec` |
|------|----------|----------|
| local | `fs.copy` into `localLocation` | `execSync` with cwd = `localLocation` |
| remote | `Ssh.copyFromHostToVM` | `Ssh.sshExec` |
| docker | `docker cp` | `docker exec … /bin/bash -c '<cmd>'` |

Local mode also rewrites paths: any occurrence of `/home/vagrant/baker/<name>/` in a command is
replaced with the real local location, because bakelets still address the target using that
staging path. The rewrite uses `path.sep` rather than a hardcoded `/`, so it works on a Windows
drive path, and a function replacement so a `$` in the path is not read as a capture-group
reference.

For remote and docker modes the resolver additionally **monkey-patches the static methods on the
`Ansible` module** for the duration of the install, then restores them:

```js
patchAnsibleForDocker(container, verbose);
await Spinner.spinPromise(j.install(), `Installing ${name}`, spinnerDot);
unpatchAnsibleForDocker();
```

Six methods are swapped — `runAnsiblePlaybook`, `runAnsibleAptInstall`, `runAnsiblePipInstall`,
`runAnsibleNpmInstall`, `runAnsibleTemplateCmd`, `createDirectory` — with the originals saved on
`Ansible.__saved` / `Ansible.__savedDocker`.

This is what lets an unmodified bakelet call `Ansible.runAnsiblePlaybook` and have it land on the
right transport. It is also global mutable state, so bakelet installs cannot safely run in
parallel.

## The Ansible layer

`lib/modules/configuration/ansible.js` holds four families of methods, one per transport. They
mirror each other:

| Transport | Inventory | Invocation |
|-----------|-----------|------------|
| **local** | `"localhost,"` with `-c local` | `execSync` in the working directory |
| **remote** | inline: `<host> ansible_connection=ssh ansible_user=… ansible_ssh_private_key_file=…` | `execSync` on the host |
| **docker** | inline: `<container> ansible_connection=docker ansible_user=root` | `execSync` on the host |

Extra variables are flattened from the `vars:` list into one object, JSON-serialized, written to a
`playbook.args.json` file, and passed as `-e @playbook.args.json`. The file is removed afterward.

Error detection is textual: the output is scanned for a recap line containing both `ok=` and
`failed=`, and anything other than `failed=0` throws. If no recap line is found at all, that also
throws.

## Bakelet lifecycle

```js
class MyBakelet extends Bakelet {
    constructor(name, ansibleSSHConfig, version) { … }
    async load(obj, variables) { /* stage playbook, read options */ }
    async install()            { /* execute */ }
}
```

The resolver calls `load()` under a spinner labeled `Preparing <name>`, then `install()` under
`Installing <name>`. Between construction and `load()` it calls the setters —
`setRemotesPath`, `setBakePath`, `setVerbose`, `setBakeletName`, and for custom bakelets
`setBakeletPath`.

Three implementation patterns appear in the tree:

1. **Static playbook** — copy a `.yml` from `remotes/bakelets-source/`, run it. (`python.js`)
2. **Rendered playbook** — render a `.mustache` template with options, write it to the target with
   `echo … > file`, run it. (`apt.js`, `R.js`, `env.js`)
3. **Ad-hoc / no playbook** — call an Ansible module directly, or just `this.exec()` a shell line.
   (`maven.js`, `agentic-tool.js`)

## On-disk state

Everything Baker writes lives under `~/.baker/`. Nothing is transmitted anywhere — there is no
telemetry, and the logs below stay on the machine that produced them.

| Path | Contents |
|------|----------|
| `~/.baker/<name>/` | Per-environment state directory |
| `~/.baker/cache/` | Cloned repositories, keyed by host and repo path — one directory per repo, whatever the ref |
| `~/.baker/cache/fetch/` | Single-file fetches (raw URL, gist, snippet), keyed by a hash of the URL |
| `~/.baker/bake.log` | Failure output, with `env:` values redacted |
| `~/.baker/cleanup.log` | What `baker cleanup` removed, with a restore hint per item |
| `~/.baker/data/index.json` | Registry of known environments |

The cache is disposable: `rm -rf ~/.baker/cache` costs one re-clone and nothing else.

## Environment index

`~/.baker/data/index.json` is a flat JSON array of known environments:

```json
[{"name": "dev-box", "path": "/home/u/proj", "type": "docker-local",
  "info": {"hostname": "172.17.0.2", "image": "node:18"}}]
```

`Utils.addToIndex` / `FindInIndex` / `removeFromIndex` / `getEnvIndex` manage it. `addToIndex`
picks only a whitelist of `info` fields (`host`, `hostname`, `user`, `image`, `private_key`,
`port`) and is a no-op if the name already exists.

Not every provider uses the index — `docker-local` and `remote` do; `local` derives state from a
`.running` marker file under `~/.baker/<name>/` instead.

## Testing

```bash
npm test          # mocha test/bake/*.js       — 181 tests, no external dependencies
npm run int-test  # mocha test/integration/*.js — needs real VMs/containers
```

The unit suites stub `child_process` and the SSH layer, so they run anywhere. Coverage is measured
with `nyc` via `npx` — note that `nyc` is **not** a declared devDependency, so coverage numbers
aren't reproducible from a clean `npm ci`.

## Conventions

- ES2017+ `async`/`await` throughout; no transpilation.
- Requires are grouped and column-aligned at the top of each file.
- Commit messages follow Conventional Commits (`npm run commit` runs commitizen).
- `standard-version` drives releases and the changelog (`npm run release`).
