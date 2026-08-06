const child_process = require('child_process');
const fs      = require('fs-extra');
const path    = require('path');
const Promise = require('bluebird');
const Spinner = require('../modules/spinner');
const start   = require('./start');
const Ssh     = require('../modules/ssh');
const vagrant = Promise.promisifyAll(require('node-vagrant'));

const Ansible = require('../modules/configuration/ansible');
const Platform = require('../modules/platform');
const { spinnerDot, bakerSSHConfig } = require('../../global-vars');

// Builds the copy/exec/execCapture trio for the active transport.
//
// Extracted from the two identical patch blocks that resolve() and
// resolveCustom() each carried, so a transport is defined once and every
// bakelet in a bake shares one object. execCapture is the new member: the local
// and docker shims previously discarded stdout, and platform detection needs to
// read it back.
// Added by Claude Code (claude-opus-5[1m])
function makeTransport({ localLocation, remoteSSHConfig, dockerContainer, vmName, verbose, platformName }) {
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
            exec: async (cmd) => { child_process.execSync(rewrite(cmd), options); },
            execCapture: async (cmd) => child_process.execSync(rewrite(cmd), options)
        };
    }

    if (remoteSSHConfig) {
        return {
            copy: async (src, dest) => { await Ssh.copyFromHostToVM(src, dest, remoteSSHConfig, false); },
            exec: async (cmd) => { await Ssh.sshExec(cmd, remoteSSHConfig, 20000, verbose); },
            execCapture: async (cmd) => Ssh.sshExec(cmd, remoteSSHConfig, 20000, verbose)
        };
    }

    if (dockerContainer) {
        const wrap = (cmd) => `docker exec "${dockerContainer}" /bin/bash -c '${cmd}'`;
        const options = { encoding: 'utf8', maxBuffer: 2000 * 1024 };
        return {
            copy: async (src, dest) => {
                child_process.execSync(`docker cp "${src}" "${dockerContainer}":"${path.dirname(dest)}"`);
            },
            exec: async (cmd) => { child_process.execSync(wrap(cmd), options); },
            execCapture: async (cmd) => child_process.execSync(wrap(cmd), options)
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

module.exports.resolveBakelet = async function(bakeletsPath, remotesPath, doc, bakerScriptPath, verbose, localLocation, remoteSSHConfig, dockerContainer)
{
    const localMode = !!localLocation;
    const remoteMode = !!remoteSSHConfig;
    const dockerMode = !!dockerContainer;

    // One transport and one platform descriptor per bake, shared by every
    // bakelet. Built here rather than per-bakelet so detection cannot run twice.
    const ctx = {
        transport: makeTransport({
            localLocation, remoteSSHConfig, dockerContainer,
            vmName: doc.name, verbose, platformName: process.platform
        }),
        platformName: targetPlatformName({ localLocation, remoteSSHConfig, dockerContainer }),
        platform: null,
        pending: null
    };

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
            for (var i = 0; i < doc.packages.length; i++)
            {
                await resolve(doc.name, bakerScriptPath, remotesPath, path.join(bakeletsPath,"packages"), doc.packages[i], extra_vars, verbose, localLocation, remoteSSHConfig, dockerContainer, ctx);
            }
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
                let externalBakeletPath = path.resolve(bakerScriptPath, doc.custom[i][info.bakeletName].path);
                info.mod = bakeletsPath + "/custom";
                console.log( info, externalBakeletPath);
                await resolveCustom(doc.name, bakerScriptPath, bakerScriptPath, doc.custom[i][info.bakeletName].path, info, doc.custom[i], extra_vars, verbose, localLocation, remoteSSHConfig, dockerContainer, ctx);
            }
        }

        if( doc.start )
        {
            if (localMode) {
                console.log("Starting command locally", doc.start);
                child_process.execSync(doc.start, {cwd: localLocation, stdio: 'inherit'});
            } else if (remoteMode) {
                console.log("Starting command on remote", doc.start);
                let inventory = Ansible.buildRemoteInventory(remoteSSHConfig);
                let cmd = `export ANSIBLE_HOST_KEY_CHECKING=false && ansible all -m shell -a 'nohup bash -c "${doc.start}" > ~/start.out 2> ~/start.err &' -i "${inventory}" -v`;
                child_process.execSync(cmd, {encoding: 'utf8', maxBuffer: 2000 * 1024});
            } else if (dockerMode) {
                console.log("Starting command in container", doc.start);
                child_process.execSync(`docker exec ${dockerContainer} /bin/bash -c '${doc.start}'`, {stdio: 'inherit'});
            } else {
                const boxes = path.join(require('os').homedir(), '.baker');
                const ansible = path.join(boxes, 'ansible-srv');
                let machine = vagrant.create({ cwd: ansible });
                let ansibleSSHConfig = bakerSSHConfig || await getSSHConfig(machine);

                console.log("Starting command", doc.start);
                start(doc.start, doc.name, ansibleSSHConfig, verbose);
            }
        }

    } catch (error) {
        throw `Error: ${error}`
    }
}

function isObject(obj) {
    return obj === Object(obj) && Object.prototype.toString.call(obj) !== '[object Array]'
}

async function getSSHConfig(machine) {
    try {
        let sshConfig = await machine.sshConfigAsync();
        if (sshConfig && sshConfig.length > 0) {
            return sshConfig[0];
        } else {
            throw '';
        }
    } catch (err) {
        throw `Couldn't get private ssh key of machine ${err}`;
    }
}


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

    let ansibleSSHConfig;
    if (localMode) {
        ansibleSSHConfig = null;
    } else if (remoteMode) {
        ansibleSSHConfig = remoteSSHConfig;
    } else if (dockerMode) {
        ansibleSSHConfig = null;
    } else {
        const boxes = path.join(require('os').homedir(), '.baker');
        const ansible = path.join(boxes, 'ansible-srv');
        let machine = vagrant.create({ cwd: ansible });
        ansibleSSHConfig = bakerSSHConfig || await getSSHConfig(machine);
    }

    let j = new classFoo(vmName, ansibleSSHConfig, version);
    j.setRemotesPath(remotesPath);
    j.setBakePath(bakerScriptPath);
    j.setVerbose(verbose);
    j.setBakeletName(bakeletName);
    j.setBakeletPath(bakeletPath);

    // copy/exec/execCapture come from the one transport built for this bake.
    // Control-VM mode has no transport and keeps the Bakelet base methods.
    if (ctx && ctx.transport) {
        Object.assign(j, ctx.transport);
    }
    if (localMode) {
        j.setLocalLocation(localLocation);
    }

    // Resolved only for bakelets that declare they need it, so every
    // unconverted bakelet keeps exactly its previous behaviour and no bake pays
    // for a probe it cannot use.
    if (j.needsPlatform) {
        j.platform = await getPlatform(ctx);
    }

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
}

async function resolve(vmName, bakerScriptPath, remotesPath, dir, bakelet, extra_vars, verbose, localLocation, remoteSSHConfig, dockerContainer, ctx) {
    const localMode = !!localLocation;
    const remoteMode = !!remoteSSHConfig;
    const dockerMode = !!dockerContainer;
    let info = getBakeletInformation(bakelet, dir);
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

    let ansibleSSHConfig;
    if (localMode) {
        ansibleSSHConfig = null;
    } else if (remoteMode) {
        ansibleSSHConfig = remoteSSHConfig;
    } else if (dockerMode) {
        ansibleSSHConfig = null;
    } else {
        const boxes = path.join(require('os').homedir(), '.baker');
        const ansible = path.join(boxes, 'ansible-srv');
        let machine = vagrant.create({ cwd: ansible });
        ansibleSSHConfig = bakerSSHConfig || await getSSHConfig(machine);
    }

    let j = new classFoo(vmName, ansibleSSHConfig, version);
    j.setRemotesPath(remotesPath);
    j.setBakePath(bakerScriptPath);
    j.setVerbose(verbose);
    j.setBakeletName(bakeletName);

    // copy/exec/execCapture come from the one transport built for this bake.
    // Control-VM mode has no transport and keeps the Bakelet base methods.
    if (ctx && ctx.transport) {
        Object.assign(j, ctx.transport);
    }
    if (localMode) {
        j.setLocalLocation(localLocation);
    }

    // Resolved only for bakelets that declare they need it, so every
    // unconverted bakelet keeps exactly its previous behaviour and no bake pays
    // for a probe it cannot use.
    if (j.needsPlatform) {
        j.platform = await getPlatform(ctx);
    }

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
}

function patchAnsibleForRemote(remoteSSHConfig, verbose) {
    Ansible.__saved = {
        runAnsiblePlaybook: Ansible.runAnsiblePlaybook,
        runAnsibleAptInstall: Ansible.runAnsibleAptInstall,
        runAnsiblePipInstall: Ansible.runAnsiblePipInstall,
        runAnsibleNpmInstall: Ansible.runAnsibleNpmInstall,
        runAnsibleTemplateCmd: Ansible.runAnsibleTemplateCmd,
        createDirectory: Ansible.createDirectory,
    };
    Ansible.runAnsiblePlaybook = async (doc, cmd, sshConfig, verboseInner, variables) => {
        return Ansible.runRemotePlaybook(doc, cmd, remoteSSHConfig, verboseInner || verbose, variables || []);
    };
    Ansible.runAnsibleAptInstall = async (doc, cmd, sshConfig, verboseInner) => {
        return Ansible.runRemoteAptInstall(doc, cmd, remoteSSHConfig, verboseInner || verbose);
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
        Ansible.runAnsibleAptInstall = Ansible.__saved.runAnsibleAptInstall;
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
        runAnsibleAptInstall: Ansible.runAnsibleAptInstall,
        runAnsiblePipInstall: Ansible.runAnsiblePipInstall,
        runAnsibleNpmInstall: Ansible.runAnsibleNpmInstall,
        runAnsibleTemplateCmd: Ansible.runAnsibleTemplateCmd,
        createDirectory: Ansible.createDirectory,
    };
    Ansible.runAnsiblePlaybook = async (doc, cmd, sshConfig, verboseInner, variables) => {
        return Ansible.runDockerPlaybook(doc, cmd, dockerContainer, verboseInner || verbose, variables || []);
    };
    Ansible.runAnsibleAptInstall = async (doc, cmd, sshConfig, verboseInner) => {
        return Ansible.runDockerAptInstall(doc, cmd, dockerContainer, verboseInner || verbose);
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
        Ansible.runAnsibleAptInstall = Ansible.__savedDocker.runAnsibleAptInstall;
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
