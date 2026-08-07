# Extending Baker

Three extension points, in increasing order of effort: a **custom playbook** in your project, a
**built-in bakelet** contributed to the repo, and a **provider**.

## Custom playbooks (`custom:`)

The `custom:` key runs an Ansible playbook you supply, using the same transport and variables as
any built-in bakelet. Nothing needs to change in Baker itself.

```yaml
custom:
  - mytool:
      path: ./playbooks/mytool.yml
```

**`path:` is a path to a playbook file, not a JavaScript module.** It is resolved relative to the
directory containing your `baker.yml`. Baker always instantiates its own built-in `Custom` class —
you cannot supply a bakelet class this way — and that class simply copies your playbook to the
target and runs it.

The key (`mytool` above) names the staged file: the playbook lands at
`/home/vagrant/baker/<env-name>/mytool.yml` and is executed from there.

Your playbook receives the flattened `vars:` list plus `BAKER_SHARE_DIR` as Ansible extra-vars, so
it can reference them directly:

```yaml
---
- hosts: all
  become: yes

  tasks:
    - name: Deploy the app config
      template:
        src: "{{ BAKER_SHARE_DIR }}/templates/app.conf.j2"
        dest: /etc/myapp/app.conf
```

Custom playbooks run near the end of the sequence, after `env:` and before `start:`. For anything
that needs to run earlier, or that needs real logic rather than a playbook, contribute a built-in
bakelet instead.

## Contributing a built-in bakelet

A built-in bakelet is a JavaScript class paired with a playbook. Two files, in matching positions:

```
lib/bakelets/<category>/<name>.js                                 the class
remotes/bakelets-source/<category>/<name>/<name><version>.yml     the playbook
```

Categories are `lang`, `tools`, `services`, `packages`, `config`, `resources`, `env`. The
directory determines which `baker.yml` key selects it — nothing needs registering, because the
resolver builds the module path from the category and name.

### The class contract

```js
const Bakelet = require('../bakelet');
const Ansible = require('../../modules/configuration/ansible');
const path    = require('path');

class MyTool extends Bakelet {
    constructor(name, ansibleSSHConfig, version) {
        super(ansibleSSHConfig);
        this.name = name;
        this.version = version;
    }

    // Stage whatever install() will need. `obj` is the raw YAML entry,
    // `variables` is the flattened vars: list plus BAKER_SHARE_DIR.
    async load(obj, variables) {
        this.variables = variables;
        this.options = (obj && obj.mytool) || {};

        const playbook = path.resolve(this.remotesPath,
            `bakelets-source/tools/mytool/mytool.yml`);
        await this.copy(playbook, `/home/vagrant/baker/${this.name}/mytool.yml`);
    }

    // Do the work.
    async install() {
        await Ansible.runAnsiblePlaybook(
            {name: this.name}, 'mytool.yml',
            this.ansibleSSHConfig, this.verbose, this.variables
        );
    }
}

module.exports = MyTool;
```

Note that `obj` is the whole YAML entry. For a bare string entry (`- mytool`) it is that string;
for an object entry (`- mytool: {…}`) it is the object, so read your options from
`obj[<name>]` and guard for both shapes.

Before `load()` is called, the resolver populates:

| Property | Value |
|----------|-------|
| `this.remotesPath` | Baker's `remotes/` directory |
| `this.bakePath` | directory containing the `baker.yml` |
| `this.bakeletName` | the resolved name — `mytool` above |
| `this.bakeletPath` | the `path:` value (custom playbooks only) |
| `this.verbose` | the `--verbose` flag |
| `this.localLocation` | working directory, local mode only |

### Rules to follow

**Use `this.copy()` and `this.exec()`, never `Ssh.*` directly.** These two methods are rebound per
execution mode, and they are the only reason one bakelet works across host, container, VM, and
remote targets. Calling `Ssh.copyFromHostToVM` yourself hardcodes the control-VM transport and
breaks local and docker modes — which is exactly the bug the built-in `config/template` and
`config/template` bakelets have.

**Avoid single quotes in any command string.** Docker mode wraps commands as
`docker exec <container> /bin/bash -c '<cmd>'`. A single quote inside terminates the wrapper early.
Use double quotes, or restructure.

**Make installs idempotent.** Re-baking an existing environment is normal. The pattern used by the
agentic-tool bakelets works well and needs no exit-code handling:

```js
await this.exec(`command -v mytool >/dev/null 2>&1 || (curl -fsSL https://… | sh)`);
```

**Write the staging path as `/home/vagrant/baker/<name>/`.** It looks wrong for local mode, but the
resolver rewrites that prefix to the real local location. Deviating from it breaks the rewrite.

### Versioning

If your bakelet is versioned, the playbook filename carries the version and the class interpolates
it:

```js
let playbook = path.resolve(this.remotesPath,
    `bakelets-source/lang/mylang/mylang${this.version}.yml`);
```

`mylang3` in a `baker.yml` yields `version = '3'` and selects `mylang3.yml`. Ship a playbook for
every version you intend to support — there is no fallback, and a missing file fails at the copy
step.

Set a default in the constructor if a bare name should work:

```js
this.version = version || 2;   // `mylang` → mylang2.yml
```

### Templated playbooks

When the playbook depends on options, render a Mustache template instead of copying a static file.
`apt.js` and `R.js` are the models:

```js
const rendered = mustache.render(
    await fs.readFile(templatePath, 'utf8'), viewObject);
await this.exec(
    `echo "${rendered.replace(/"/g, '\\"')}" > /home/vagrant/baker/${this.name}/mylang.yml`);
```

Note the escaping — the rendered YAML goes through a shell `echo`.

### Two kinds of bakelet

Bakelets come in two shapes, and which you write decides where it can run.

**Exec-based** (preferred). Declare a `commands` table keyed by package manager and let the base
class do the rest. These work on Linux, macOS, and Windows, need no Ansible, and need no sudo
unless they install to a system path:

```javascript
class Maven extends PackageTool {
    constructor(name, cfg, version) { super(name, cfg, version); this.binName = 'mvn'; }
    get commands() {
        return {
            apt: `${this.sudo}apt-get install -y maven`,
            brew: 'brew install maven',
            choco: 'choco install -y maven'
        };
    }
}
```

Rules the suite enforces: no `sudo` in a `brew` command (Homebrew refuses to run under it), no
single quotes anywhere (docker-local wraps commands in `bash -c '...'`), and use `this.sudo` rather
than a literal prefix so the command still works as root in a container. Omitting a manager is a
deliberate statement that the tool does not work there — Baker then fails naming `docker:` and
`remote:` rather than inventing a package name.

**Playbook-backed.** Provisions through Ansible, which pins it to a Linux target. Declare it:

```javascript
get requiresAnsible() { return true; }
```

so the bake pre-flight refuses it on a macOS or Windows laptop before anything runs, instead of
failing partway through.

### Playbook conventions

```yaml
---
- hosts: all
  become: yes

  tasks:
    - name: Install the thing
      apt:
        name: thing
        state: present
```

`hosts: all` matches whatever inventory the transport supplies. `become: yes` is what every
built-in playbook uses — and is also what forces the passwordless-sudo requirement in host-direct
modes. If your bakelet can install into the user's home directory without root, omit `become:` and
it will work in more places.

### Tests

Add a suite under `test/bake/`. Existing suites stub `child_process` and the SSH layer so they run
without any real target. `test/bake/test-agentic-tool-bakelets.js` is a good template for a
bakelet-only test.

```bash
npm test
```

## Writing a provider

Larger, and needs changes in three places.

### 1. The class

Extend `Provider` in `lib/modules/providers/`:

```js
const Provider = require('./provider');
const { bakeletsPath, remotesPath } = require('../../../global-vars');

class MyProvider extends Provider {
    async bake(scriptPath, ansibleSSHConfig, verbose) {
        const doc = yaml.safeLoad(
            await fs.readFile(path.join(scriptPath, 'baker.yml'), 'utf8'));

        // 1. Create/ensure the target exists.
        // 2. Register it: await Utils.addToIndex(name, scriptPath, 'mytype', info);
        // 3. Prompt for vars: if (doc.vars) await Utils.traverse(doc.vars);

        const resolveB = require('../../bakelets/resolve');
        await resolveB.resolveBakelet(
            bakeletsPath, remotesPath, doc, scriptPath, verbose,
            /* localLocation */ null, /* remoteSSHConfig */ null, /* dockerContainer */ null);
    }

    async ssh(name, cmdToRun, terminateProcessOnClose, verbose, options) { … }
    async start(name)  { … }
    async stop(name)   { … }
    async delete(name) { … }
    async getState(name) { … }
    async list()       { … }
    async getSSHConfig(name) { … }
}
```

### 2. Selection

Add a key test to `Baker.chooseProvider()` in `lib/modules/baker.js`, and place it in the priority
chain deliberately — earlier keys win.

### 3. Execution mode

If your target is reachable by one of the four existing modes, pass the corresponding argument to
`resolveBakelet` and you're done.

If it needs a **new** transport, you have more work: add `patchAnsibleForX` / `unpatchAnsibleForX`
in `resolve.js`, add a matching family of methods in `lib/modules/configuration/ansible.js`, and
add a `copy`/`exec` rebinding branch in both `resolve()` and `resolveCustom()`.

### 4. Removal support

Implement `planRemoval` and `applyRemoval` if the provider should work with `baker cleanup`.
`planRemoval` **must be side-effect free** — it is called to render a plan the user then approves,
and `--dry-run` relies on it changing nothing.

A provider without them is refused by `cleanup` with a message naming the three that have them,
rather than half-removing an environment.

## Adding a CLI command

Drop a yargs module into `lib/commands/`. `baker.js` loads the directory, so no registration is
needed.

```js
exports.command = 'mycmd [arg]';
exports.desc = 'What it does';
exports.builder = (yargs) => {
    yargs.example('$0 mycmd thing', 'Do the thing');
    yargs.positional('arg', {describe: '…', type: 'string'});
    yargs.options({verbose: {alias: 'v', type: 'boolean', demand: false}});
};
exports.handler = async function (argv) {
    try {
        const {envName, provider, BakerObj} = await Baker.chooseProvider(process.cwd());
        …
    } catch (err) {
        Print.error(err);
    }
};
```

Note that yargs runs in `strict(true)` mode, so unknown flags are rejected. Because `.commandDir()`
registers every file in `lib/commands/`, a scratch or template file placed there becomes a real
command in `--help` — there is no skeleton file in the tree for that reason.
