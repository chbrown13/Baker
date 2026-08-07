const child_process = require('child_process');
const fs      = require('fs-extra');
const path    = require('path');
const Promise = require('bluebird');
const Spinner = require('../modules/spinner');
const start   = require('./start');
const Ssh     = require('../modules/ssh');

const Ansible = require('../modules/configuration/ansible');
const Platform = require('../modules/platform');
const Preflight = require('../modules/preflight');
const BakeLog = require('../modules/bake-log');
const { spinnerDot } = require('../../global-vars');

// Builds the copy/exec/execCapture trio for the active transport.
//
// Extracted from the two identical patch blocks that resolve() and
// resolveCustom() each carried, so a transport is defined once and every
// bakelet in a bake shares one object. execCapture is the new member: the local
// and docker shims previously discarded stdout, and platform detection needs to
// read it back.
// Added by Claude Code (claude-opus-5[1m])
function makeTransport({ localLocation, remoteSSHConfig, dockerContainer, vmName, verbose, platformName, trace }) {
    // Records the command in flight so a failure can name it. execSync does not
    // reliably attach .cmd to its errors, and an empty "command:" line in
    // bake.log is exactly the detail someone debugging over email needs.
    const note = (cmd) => { if (trace) trace.lastCommand = cmd; return cmd; };
    if (localLocation) {
        // Bakelets address the box as /home/vagrant/baker/<name>/, a control-VM
        // convention. In local mode that prefix is rewritten to the real
        // location, which on Windows is a drive path — hence path.sep rather
        // than a hardcoded '/', and a function replacement so a '$' in the
        // path cannot be read as a capture-group reference.
        const prefix = new RegExp(`/home/vagrant/baker/${vmName}/`, 'g');
        const replacement = path.join(localLocation, path.sep);
        const rewrite = (cmd) => String(cmd).replace(prefix, () => replacement);

        // cmd.exe cannot run what Baker generates, so on Windows every local
        // command goes through PowerShell instead.
        const options = { cwd: localLocation, encoding: 'utf8', maxBuffer: 2000 * 1024 };
        if (platformName === 'win32') options.shell = 'powershell.exe';

        return {
            copy: async (src, dest) => {
                await fs.copy(src, path.join(localLocation, path.basename(dest)));
            },
            exec: async (cmd) => { child_process.execSync(rewrite(note(cmd)), options); },
            execCapture: async (cmd) => child_process.execSync(rewrite(note(cmd)), options)
        };
    }

    if (remoteSSHConfig) {
        return {
            copy: async (src, dest) => { await Ssh.copyFromHostToVM(src, dest, remoteSSHConfig, false); },
            exec: async (cmd) => { await Ssh.sshExec(note(cmd), remoteSSHConfig, 20000, verbose); },
            execCapture: async (cmd) => Ssh.sshExec(note(cmd), remoteSSHConfig, 20000, verbose)
        };
    }

    if (dockerContainer) {
        const wrap = (cmd) => `docker exec "${dockerContainer}" /bin/bash -c '${cmd}'`;
        const options = { encoding: 'utf8', maxBuffer: 2000 * 1024 };
        return {
            copy: async (src, dest) => {
                child_process.execSync(`docker cp "${src}" "${dockerContainer}":"${path.dirname(dest)}"`);
            },
            exec: async (cmd) => { child_process.execSync(wrap(note(cmd)), options); },
            execCapture: async (cmd) => child_process.execSync(wrap(note(cmd)), options)
        };
    }

    // Control-VM mode keeps the Bakelet base-class methods, which route over
    // SSH to baker-srv. That path is slated for removal and no platform-aware
    // bakelet supports it, so it gets no transport object.
    return null;
}

// The platform of the TARGET, not the operator. Only local mode provisions the
// machine Baker runs on; docker and remote both target Linux regardless of the
// laptop, which is what makes a macOS host baking into a container resolve apt.
function targetPlatformName({ localLocation, remoteSSHConfig, dockerContainer }) {
    if (localLocation) return process.platform;
    if (remoteSSHConfig || dockerContainer) return 'linux';
    return 'linux';
}

// Detection is lazy and memoised: a bake whose bakelets need no platform
// knowledge never pays for the probe, and one that does runs it exactly once no
// matter how many bakelets ask. Laziness is also what keeps every unconverted
// bakelet byte-for-byte unchanged in behaviour.
async function getPlatform(ctx) {
    if (ctx.platform) return ctx.platform;
    if (!ctx.transport) {
        throw new Error(
            'Platform-aware bakelets are not supported when provisioning through baker-srv. ' +
            'Use local:, docker:, or remote: in your baker.yml.'
        );
    }
    if (!ctx.pending) {
        ctx.pending = Platform.detect(ctx.transport.execCapture, ctx.platformName);
    }
    ctx.platform = await ctx.pending;
    return ctx.platform;
}

// Builds a bakelet and wires it to the bake's transport and platform WITHOUT
// running it. Extracted from the identical bodies of resolve() and
// resolveCustom(): the bake pre-flight gate needs constructed bakelets it can
// interrogate before anything executes, and `baker cleanup` will need the same.
// Added by Claude Code (claude-opus-5[1m])
async function constructBakelet(classFoo, opts) {
    const { vmName, bakerScriptPath, remotesPath, bakeletName, bakeletPath, version,
        verbose, localLocation, remoteSSHConfig, dockerContainer, ctx } = opts;

    // Order preserved from the original: local wins over remote wins over docker.
    let ansibleSSHConfig;
    if (localLocation) {
        ansibleSSHConfig = null;
    } else if (remoteSSHConfig) {
        ansibleSSHConfig = remoteSSHConfig;
    } else if (dockerContainer) {
        ansibleSSHConfig = null;
    } else {
        throw new Error('no transport for this environment: expected local:, docker:, or remote:.');
    }

    const j = new classFoo(vmName, ansibleSSHConfig, version);
    j.setRemotesPath(remotesPath);
    j.setBakePath(bakerScriptPath);
    j.setVerbose(verbose);
    j.setBakeletName(bakeletName);
    // Only custom bakelets carry an explicit path; resolve() never set one.
    if (bakeletPath !== undefined) j.setBakeletPath(bakeletPath);

    // copy/exec/execCapture come from the one transport built for this bake.
    // Control-VM mode has no transport and keeps the Bakelet base methods.
    if (ctx && ctx.transport) {
        Object.assign(j, ctx.transport);
    }
    if (localLocation) {
        j.setLocalLocation(localLocation);
    }

    // Resolved only for bakelets that declare they need it, so every
    // unconverted bakelet keeps exactly its previous behaviour and no bake pays
    // for a probe it cannot use.
    if (j.needsPlatform) {
        j.platform = await getPlatform(ctx);
    }

    return j;
}

module.exports.constructBakelet = constructBakelet;

// Reverse of the install order, so teardown precedes what it depends on.
// Deferred sections keep their slots as `none`, so v2 needs no revision here.
const REMOVE_ORDER = ['start', 'custom', 'env', 'resources', 'packages', 'tools', 'services', 'config', 'lang'];

// Sections with no inverse in v1. Reported, never constructed — which also
// keeps a bakelet whose load() writes files (lang/R.js) from being prepared
// during a read-only plan.
const DEFERRED = new Set(['start', 'custom', 'packages', 'services', 'lang']);

// Builds the removal plan for a doc. Read-only end to end: every bakelet is
// constructed and prepared, never loaded-with-side-effects and never installed.
// Added by Claude Code (claude-opus-5[1m])
module.exports.planBakeletRemoval = async function(bakeletsPath, remotesPath, doc, bakerScriptPath, verbose, localLocation, remoteSSHConfig, dockerContainer) {
    const ctx = {
        trace: { lastCommand: null },
        transport: makeTransport({
            localLocation, remoteSSHConfig, dockerContainer,
            vmName: doc.name, verbose, platformName: process.platform
        }),
        platformName: targetPlatformName({ localLocation, remoteSSHConfig, dockerContainer }),
        platform: null,
        pending: null,
        secrets: BakeLog.collectSecrets(doc)
    };

    let extra_vars = doc.vars ? doc.vars.slice() : [];
    extra_vars.push({ BAKER_SHARE_DIR: `/${path.basename(bakerScriptPath)}` });

    const plan = [];

    for (const section of REMOVE_ORDER) {
        if (!doc[section]) continue;

        if (DEFERRED.has(section)) {
            plan.push({
                kind: 'none', section, bakelet: section,
                reason: `no inverse available for ${section}: — deferred to a later version`
            });
            continue;
        }

        for (const item of sectionEntries(doc, section, bakeletsPath)) {
            const dir = path.join(bakeletsPath, section);
            const info = item.override || getBakeletInformation(item.entry, dir);
            let classFoo;
            try {
                classFoo = require(info.mod);
                if (typeof classFoo !== 'function') continue;
            } catch (err) {
                // Unresolvable entries are skipped rather than thrown on: a
                // plan is a report, and one bad name should not hide the rest.
                plan.push({
                    kind: 'none', section, bakelet: info.bakeletName,
                    reason: `cannot load ${info.bakeletName}; nothing to remove`
                });
                continue;
            }

            const j = await constructBakelet(classFoo, {
                vmName: doc.name, bakerScriptPath, remotesPath, bakeletName: info.bakeletName,
                version: info.version, verbose, localLocation, remoteSSHConfig, dockerContainer, ctx
            });

            await j.prepare(item.entry, extra_vars);
            for (const operation of await j.plan()) {
                plan.push(Object.assign({ section }, operation, { _bakelet: j }));
            }
        }
    }

    return plan;
};

// Normalises how each section hands its entries to a bakelet, mirroring
// resolveBakelet: most sections dispatch per entry, `packages:` and `env:` are
// handed their whole value.
function sectionEntries(doc, section, bakeletsPath) {
    if (section === 'env') {
        return [{
            entry: { env: doc.env },
            override: { mod: path.join(bakeletsPath, 'env', 'env'), version: '', bakeletName: 'env' }
        }];
    }
    if (section === 'packages') {
        return [{
            entry: doc.packages,
            override: { mod: path.join(bakeletsPath, 'packages', 'system'), version: '', bakeletName: 'system' }
        }];
    }
    return (doc[section] || []).map((entry) => ({ entry }));
}

// Executes approved operations in the order the plan produced them, which is
// already REMOVE_ORDER. Each is independent and idempotent: an interrupted run
// converges when re-run rather than needing a rollback.
module.exports.applyBakeletRemoval = async function(approved, verbose) {
    const results = [];
    for (const operation of approved) {
        try {
            await operation._bakelet.uninstall(operation);
            results.push({ operation, status: 'removed' });
        } catch (error) {
            results.push({ operation, status: 'failed', error });
            if (verbose) console.error(error);
        }
    }
    return results;
};

// Every bakelet a doc will run, constructed but not loaded or installed, so the
// pre-flight gate can interrogate them before anything touches the machine.
//
// Unresolvable entries are skipped rather than thrown on: the normal flow
// produces a much better "Cannot find X, did you mean Y?" message, and
// pre-flight must not pre-empt it with a raw require error.
// Added by Claude Code (claude-opus-5[1m])
async function collectBakelets(bakeletsPath, remotesPath, doc, bakerScriptPath, verbose, localLocation, remoteSSHConfig, dockerContainer, ctx) {
    const sections = ['lang', 'config', 'services', 'tools', 'resources'];
    const planned = [];

    const build = async (dir, entry, override) => {
        const info = override || getBakeletInformation(entry, dir);
        let classFoo;
        try {
            classFoo = require(info.mod);
            if (typeof classFoo !== 'function') return;
        } catch (err) {
            return;
        }
        planned.push(await constructBakelet(classFoo, {
            vmName: doc.name, bakerScriptPath, remotesPath, bakeletName: info.bakeletName,
            version: info.version, verbose, localLocation, remoteSSHConfig, dockerContainer, ctx
        }));
    };

    for (const section of sections) {
        if (!doc[section]) continue;
        for (const entry of doc[section]) {
            await build(path.join(bakeletsPath, section), entry);
        }
    }
    if (doc.packages) {
        await build(path.join(bakeletsPath, 'packages'), doc.packages,
            { mod: path.join(bakeletsPath, 'packages', 'system'), version: '', bakeletName: 'system' });
    }
    if (doc.env) {
        await build(path.join(bakeletsPath, 'env'), { env: doc.env },
            { mod: path.join(bakeletsPath, 'env', 'env'), version: '', bakeletName: 'env' });
    }
    if (doc.custom) {
        for (const entry of doc.custom) {
            await build(bakeletsPath, entry,
                { mod: path.join(bakeletsPath, 'custom'), version: '', bakeletName: 'custom' });
        }
    }

    return planned;
}

module.exports.resolveBakelet = async function(bakeletsPath, remotesPath, doc, bakerScriptPath, verbose, localLocation, remoteSSHConfig, dockerContainer)
{
    const localMode = !!localLocation;
    const remoteMode = !!remoteSSHConfig;
    const dockerMode = !!dockerContainer;

    // One transport and one platform descriptor per bake, shared by every
    // bakelet. Built here rather than per-bakelet so detection cannot run twice.
    const trace = { lastCommand: null };
    const ctx = {
        trace,
        transport: makeTransport({
            localLocation, remoteSSHConfig, dockerContainer,
            vmName: doc.name, verbose, platformName: process.platform, trace
        }),
        platformName: targetPlatformName({ localLocation, remoteSSHConfig, dockerContainer }),
        platform: null,
        pending: null,
        // Values that must never reach the terminal or the log in the clear.
        secrets: BakeLog.collectSecrets(doc)
    };

    // Pre-flight before anything runs. Skipped for the control-VM path, which
    // has no transport to probe and is slated for removal.
    if (ctx.transport) {
        const planned = await collectBakelets(bakeletsPath, remotesPath, doc, bakerScriptPath, verbose, localLocation, remoteSSHConfig, dockerContainer, ctx);

        // Ansible support needs only the target OS, which is known from the
        // transport without probing anything.
        Preflight.checkAnsible(planned, Preflight.osOf(ctx.platformName));

        // Elevation is about this machine, so it is a local-mode question only,
        // and the full descriptor is resolved only when something needs it.
        if (localLocation && planned.some((b) => b.requiresElevation)) {
            const warnings = Preflight.checkElevation(planned, await getPlatform(ctx));
            warnings.forEach((w) => console.warn(w));
        }
    }

    try {
        if( verbose ) console.log( doc );

        let extra_vars = [];
        if( doc.vars )
        {
            extra_vars = doc.vars;
        }
        extra_vars.push( {BAKER_SHARE_DIR: `/${path.basename(bakerScriptPath)}` });

        if( doc.lang )
        {
            for (var i = 0; i < doc.lang.length; i++)
            {
                await resolve(doc.name, bakerScriptPath, remotesPath, path.join(bakeletsPath,"lang"), doc.lang[i], extra_vars, verbose, localLocation, remoteSSHConfig, dockerContainer, ctx);
            }
        }

        if( doc.config )
        {
            for (var i = 0; i < doc.config.length; i++)
            {
                await resolve(doc.name, bakerScriptPath, remotesPath, path.join(bakeletsPath,"config"), doc.config[i], extra_vars, verbose, localLocation, remoteSSHConfig, dockerContainer, ctx);
            }
        }

        if( doc.services )
        {
            for (var i = 0; i < doc.services.length; i++)
            {
                await resolve(doc.name, bakerScriptPath, remotesPath, path.join(bakeletsPath,"services"), doc.services[i], extra_vars, verbose, localLocation, remoteSSHConfig, dockerContainer, ctx);
            }
        }

        if( doc.tools )
        {
            for (var i = 0; i < doc.tools.length; i++)
            {
                await resolve(doc.name, bakerScriptPath, remotesPath, path.join(bakeletsPath,"tools"), doc.tools[i], extra_vars, verbose, localLocation, remoteSSHConfig, dockerContainer, ctx);
            }
        }

        if( doc.packages )
        {
            // The only section handed to its bakelet whole rather than per
            // entry: `packages:` entries are package names, not bakelet names,
            // so there is nothing to dispatch on. One invocation also means one
            // install command for the whole list, which is what every package
            // manager is faster at.
            await resolve(doc.name, bakerScriptPath, remotesPath, path.join(bakeletsPath,"packages"), doc.packages, extra_vars, verbose, localLocation, remoteSSHConfig, dockerContainer, ctx,
                { mod: path.join(bakeletsPath, 'packages', 'system'), version: '', bakeletName: 'system' });
        }

        if( doc.resources )
        {
            for (var i = 0; i < doc.resources.length; i++)
            {
                await resolve(doc.name, bakerScriptPath, remotesPath, path.join(bakeletsPath,"resources"), doc.resources[i], extra_vars, verbose, localLocation, remoteSSHConfig, dockerContainer, ctx);
            }
        }

        if( doc.env )
        {
            doc.env = [{env: doc.env}];
            await resolve(doc.name, bakerScriptPath, remotesPath, path.join(bakeletsPath,"env"), doc.env[0], extra_vars, verbose, localLocation, remoteSSHConfig, dockerContainer, ctx);
        }

        if( doc.custom )
        {
            for (var i = 0; i < doc.custom.length; i++)
            {
                let info = getBakeletInformation(doc.custom[i], "");
                info.mod = bakeletsPath + "/custom";
                await resolveCustom(doc.name, bakerScriptPath, bakerScriptPath, doc.custom[i][info.bakeletName].path, info, doc.custom[i], extra_vars, verbose, localLocation, remoteSSHConfig, dockerContainer, ctx);
            }
        }

        if( doc.start )
        {
            if (localMode) {
                console.log("Starting command locally", doc.start);
                startDetached(doc.start, localLocation);
            } else if (remoteMode) {
                console.log("Starting command on remote", doc.start);
                let inventory = Ansible.buildRemoteInventory(remoteSSHConfig);
                let cmd = `export ANSIBLE_HOST_KEY_CHECKING=false && ansible all -m shell -a 'nohup bash -c "${doc.start}" > ~/start.out 2> ~/start.err &' -i "${inventory}" -v`;
                child_process.execSync(cmd, {encoding: 'utf8', maxBuffer: 2000 * 1024});
            } else if (dockerMode) {
                console.log("Starting command in container", doc.start);
                child_process.execSync(dockerStartCommand(dockerContainer, doc.start), {stdio: 'inherit'});
            } else {
                throw new Error('no transport for start:: expected local:, docker:, or remote:.');
            }
        }

    } catch (error) {
        throw `Error: ${error}`
    }
}

function isObject(obj) {
    return obj === Object(obj) && Object.prototype.toString.call(obj) !== '[object Array]'
}

// `start:` runs the environment's app, which is usually long-lived. Remote mode
// has always backgrounded it through nohup; local and docker used a blocking
// execSync, so a server under start: hung the bake instead of finishing it.
// These two put all three transports on the same footing.
function startDetached(command, cwd) {
    const child = child_process.spawn(command, {
        cwd,
        shell: true,
        // setsid so the process outlives the bake; Windows has no equivalent
        // and spawn already detaches there.
        detached: process.platform !== 'win32',
        stdio: 'ignore'
    });
    child.unref();
    return child;
}

function dockerStartCommand(container, command) {
    // -d returns as soon as the process is launched inside the container.
    return `docker exec -d ${container} /bin/bash -c '${command}'`;
}

module.exports.startDetached = startDetached;
module.exports.dockerStartCommand = dockerStartCommand;

function getBakeletInformation(bakelet, dir)
{
    let mod = "";
    let version = "";
    let bakeletName = "";
    if( isObject(bakelet) )
    {
        // complex objects, like templates.
        bakeletName = Object.keys(bakelet)[0];
        mod = dir + "/" + bakeletName;
    }
    else
    {
        // This will correctly match neo4j3.3, java8, python etc.
        let regex = /([a-zA-Z]*)([0-9]+\.?[0-9]*$)|([a-zA-Z-0-9]*)/;
        mod =  dir + "/" + bakelet;
        let match = bakelet.match(regex);
        if( match.length == 4)
        {
            if( match[1] === undefined && match[2] === undefined )
            {
                mod =  dir + "/" + match[3];
                bakeletName = match[3];
            }
            else
            {
                mod =  dir + "/" + match[1];
                version = match[2];
                bakeletName = match[1];
            }
        }
    }
    return { mod: mod, version: version, bakeletName: bakeletName };
}


async function resolveCustom(vmName, bakerScriptPath, remotesPath, bakeletPath, info, bakelet, extra_vars, verbose, localLocation, remoteSSHConfig, dockerContainer, ctx) {
    const localMode = !!localLocation;
    const remoteMode = !!remoteSSHConfig;
    const dockerMode = !!dockerContainer;
    let mod = info.mod;
    let version = info.version;
    let bakeletName = info.bakeletName;

    if (verbose) console.log("Found", bakeletName, version, extra_vars);

    let classFoo = require(mod)

    const j = await constructBakelet(classFoo, {
        vmName, bakerScriptPath, remotesPath, bakeletName, bakeletPath, version,
        verbose, localLocation, remoteSSHConfig, dockerContainer, ctx
    });

    // Failures are wrapped with what Baker was doing and logged locally, with
    // any known secrets redacted from both. A raw manager error is not
    // something a non-expert can act on.
    try {
        await Spinner.spinPromise(j.load(bakelet, extra_vars), `Preparing ${bakeletName}`, spinnerDot);
        if (localMode) {
            await j.install();
        } else if (remoteMode) {
            await patchAnsibleForRemote(remoteSSHConfig, verbose);
            await Spinner.spinPromise(j.install(), `Installing ${bakeletName}`, spinnerDot);
            await unpatchAnsibleForRemote();
        } else if (dockerMode) {
            await patchAnsibleForDocker(dockerContainer, verbose);
            await Spinner.spinPromise(j.install(), `Installing ${bakeletName}`, spinnerDot);
            await unpatchAnsibleForDocker();
        } else {
            await Spinner.spinPromise(j.install(), `Installing ${bakeletName}`, spinnerDot);
        }
    } catch (error) {
        throw await BakeLog.wrap(error, {
            bakeletName,
            manager: j.platform && j.platform.manager,
            command: ctx && ctx.trace && ctx.trace.lastCommand,
            secrets: (ctx && ctx.secrets) || []
        });
    }
}

// `override` names the module directly, for sections whose entries are data
// rather than bakelet names (packages:). Everything else derives it from the
// entry as before.
async function resolve(vmName, bakerScriptPath, remotesPath, dir, bakelet, extra_vars, verbose, localLocation, remoteSSHConfig, dockerContainer, ctx, override) {
    const localMode = !!localLocation;
    const remoteMode = !!remoteSSHConfig;
    const dockerMode = !!dockerContainer;
    let info = override || getBakeletInformation(bakelet, dir);
    let mod = info.mod;
    let version = info.version;
    let bakeletName = info.bakeletName;

    if (verbose) console.log("Found", bakeletName, version, extra_vars);

    let classFoo = null;
    try {
        classFoo = require(mod);
    } catch (error) {
        let correctPath = (await getSupportedBakeletList(path.join(dir, '..'))).filter(bakelet => bakelet.name === info.bakeletName)[0];
        let errorMessage = `Cannot find ${info.bakeletName} in ${path.join(info.mod, '..').split('/').pop()} Bakelets. `;
        if (correctPath) errorMessage += `Did you mean ${correctPath.dir}:${info.bakeletName}?`
        throw Error(errorMessage);
    }

    const j = await constructBakelet(classFoo, {
        vmName, bakerScriptPath, remotesPath, bakeletName, version,
        verbose, localLocation, remoteSSHConfig, dockerContainer, ctx
    });

    // Failures are wrapped with what Baker was doing and logged locally, with
    // any known secrets redacted from both. A raw manager error is not
    // something a non-expert can act on.
    try {
        await Spinner.spinPromise(j.load(bakelet, extra_vars), `Preparing ${bakeletName}`, spinnerDot);
        if (localMode) {
            await j.install();
        } else if (remoteMode) {
            await patchAnsibleForRemote(remoteSSHConfig, verbose);
            await Spinner.spinPromise(j.install(), `Installing ${bakeletName}`, spinnerDot);
            await unpatchAnsibleForRemote();
        } else if (dockerMode) {
            await patchAnsibleForDocker(dockerContainer, verbose);
            await Spinner.spinPromise(j.install(), `Installing ${bakeletName}`, spinnerDot);
            await unpatchAnsibleForDocker();
        } else {
            await Spinner.spinPromise(j.install(), `Installing ${bakeletName}`, spinnerDot);
        }
    } catch (error) {
        throw await BakeLog.wrap(error, {
            bakeletName,
            manager: j.platform && j.platform.manager,
            command: ctx && ctx.trace && ctx.trace.lastCommand,
            secrets: (ctx && ctx.secrets) || []
        });
    }
}

function patchAnsibleForRemote(remoteSSHConfig, verbose) {
    Ansible.__saved = {
        runAnsiblePlaybook: Ansible.runAnsiblePlaybook,
        runAnsiblePipInstall: Ansible.runAnsiblePipInstall,
        runAnsibleNpmInstall: Ansible.runAnsibleNpmInstall,
        runAnsibleTemplateCmd: Ansible.runAnsibleTemplateCmd,
        createDirectory: Ansible.createDirectory,
    };
    Ansible.runAnsiblePlaybook = async (doc, cmd, sshConfig, verboseInner, variables) => {
        return Ansible.runRemotePlaybook(doc, cmd, remoteSSHConfig, verboseInner || verbose, variables || []);
    };
    Ansible.runAnsiblePipInstall = async (doc, requirements, sshConfig, verboseInner) => {
        return Ansible.runRemotePipInstall(doc, requirements, remoteSSHConfig, verboseInner || verbose);
    };
    Ansible.runAnsibleNpmInstall = async (doc, packagejson, sshConfig, verboseInner) => {
        return Ansible.runRemoteNpmInstall(doc, packagejson, remoteSSHConfig, verboseInner || verbose);
    };
    Ansible.runAnsibleTemplateCmd = async (doc, src, dest, variables, sshConfig, verboseInner) => {
        return Ansible.runRemoteTemplateCmd(doc, src, dest, variables, remoteSSHConfig, verboseInner || verbose);
    };
    Ansible.createDirectory = async (doc, dir, mode, sshConfig, verboseInner) => {
        return Ansible.runRemoteCreateDirectory(doc, dir, mode, remoteSSHConfig, verboseInner || verbose);
    };
}

function unpatchAnsibleForRemote() {
    if (Ansible.__saved) {
        Ansible.runAnsiblePlaybook = Ansible.__saved.runAnsiblePlaybook;
        Ansible.runAnsiblePipInstall = Ansible.__saved.runAnsiblePipInstall;
        Ansible.runAnsibleNpmInstall = Ansible.__saved.runAnsibleNpmInstall;
        Ansible.runAnsibleTemplateCmd = Ansible.__saved.runAnsibleTemplateCmd;
        Ansible.createDirectory = Ansible.__saved.createDirectory;
        delete Ansible.__saved;
    }
}

function patchAnsibleForDocker(dockerContainer, verbose) {
    Ansible.__savedDocker = {
        runAnsiblePlaybook: Ansible.runAnsiblePlaybook,
        runAnsiblePipInstall: Ansible.runAnsiblePipInstall,
        runAnsibleNpmInstall: Ansible.runAnsibleNpmInstall,
        runAnsibleTemplateCmd: Ansible.runAnsibleTemplateCmd,
        createDirectory: Ansible.createDirectory,
    };
    Ansible.runAnsiblePlaybook = async (doc, cmd, sshConfig, verboseInner, variables) => {
        return Ansible.runDockerPlaybook(doc, cmd, dockerContainer, verboseInner || verbose, variables || []);
    };
    Ansible.runAnsiblePipInstall = async (doc, requirements, sshConfig, verboseInner) => {
        return Ansible.runDockerPipInstall(doc, requirements, dockerContainer, verboseInner || verbose);
    };
    Ansible.runAnsibleNpmInstall = async (doc, packagejson, sshConfig, verboseInner) => {
        return Ansible.runDockerNpmInstall(doc, packagejson, dockerContainer, verboseInner || verbose);
    };
    Ansible.runAnsibleTemplateCmd = async (doc, src, dest, variables, sshConfig, verboseInner) => {
        return Ansible.runDockerTemplateCmd(doc, src, dest, variables, dockerContainer, verboseInner || verbose);
    };
    Ansible.createDirectory = async (doc, dir, mode, sshConfig, verboseInner) => {
        return Ansible.runDockerCreateDirectory(doc, dir, mode, dockerContainer, verboseInner || verbose);
    };
}

function unpatchAnsibleForDocker() {
    if (Ansible.__savedDocker) {
        Ansible.runAnsiblePlaybook = Ansible.__savedDocker.runAnsiblePlaybook;
        Ansible.runAnsiblePipInstall = Ansible.__savedDocker.runAnsiblePipInstall;
        Ansible.runAnsibleNpmInstall = Ansible.__savedDocker.runAnsibleNpmInstall;
        Ansible.runAnsibleTemplateCmd = Ansible.__savedDocker.runAnsibleTemplateCmd;
        Ansible.createDirectory = Ansible.__savedDocker.createDirectory;
        delete Ansible.__savedDocker;
    }
}

async function getSupportedBakeletList(bakeletsPath) {
    let bakeletDirs = (await fs.readdir(bakeletsPath))
    bakeletDirs = bakeletDirs.filter(dir => (fs.statSync(path.join(bakeletsPath, dir))).isDirectory());
    let bakeletList = [];
    for (let dir of bakeletDirs) {
        let names = (await fs.readdir(path.join(bakeletsPath, dir))).map(dir => dir.split('.js')[0]);
        for (let name of names) {
            bakeletList.push({ name, dir });
        }
    }
    return bakeletList;
}
