const child_process = require('child_process');
const os            = require('os');
const path          = require('path');
const fs            = require('fs-extra');
const yaml          = require('js-yaml');

const Provider      = require('./provider');
const {boxes, bakeletsPath, remotesPath, configPath} = require('../../../global-vars');

class LocalProvider extends Provider {
    constructor() {
        super();
    }

    // `local: ~/project` is the natural way to write a home-relative path, but
    // path.resolve does not expand a tilde — it produced a literal directory
    // named "~" under the current working directory. `files:` already expands
    // dest the same way; this makes the two agree.
    static resolveLocation(location) {
        if (location === '~') return os.homedir();
        if (location.startsWith('~/') || location.startsWith('~\\')) {
            return path.join(os.homedir(), location.slice(2));
        }
        return path.resolve(location);
    }

    async start(name) {
        const dir = path.join(boxes, name);
        await fs.ensureDir(dir);
        await fs.writeFile(path.join(dir, '.running'), String(Date.now()));
    }

    async stop(name) {
        await fs.remove(path.join(boxes, name, '.running')).catch(() => {});
    }

    async delete(name) {
        let state = await this.getState(name);
        if (state === 'running') {
            await this.stop(name);
        }
        await fs.remove(path.join(boxes, name));
    }

    async getState(name) {
        try {
            await fs.access(path.join(boxes, name, '.running'));
            return 'running';
        } catch {
            return 'stopped';
        }
    }

    async getSSHConfig(name) {
        return {user: os.userInfo().username, host: '127.0.0.1', port: 22, hostname: '127.0.0.1', private_key: null};
    }

    async ssh(name, cmdToRun, terminateProcessOnClose, verbose = false, options = {}) {
        let cwd = path.join(boxes, name);
        if (!cmdToRun) {
            child_process.execSync(process.env.SHELL || '/bin/sh', {cwd: cwd, stdio: 'inherit'});
        } else {
            let opts = {cwd: cwd, encoding: 'utf8', maxBuffer: 20000 * 1024};
            if (verbose) opts.stdio = 'inherit';
            child_process.execSync(cmdToRun, opts);
        }
    }

    // Removal mirrors bake(): same doc, same location resolution, same
    // resolver — so cleanup targets exactly what bake produced.
    async planRemoval(scriptPath, ansibleSSHConfig, verbose) {
        let doc = yaml.safeLoad(await fs.readFile(path.join(scriptPath, 'baker.yml'), 'utf8'));
        let location = typeof doc.local === 'string' ? path.resolve(doc.local) : process.cwd();

        let resolveB = require('../../bakelets/resolve');
        return {
            root: location,
            plan: await resolveB.planBakeletRemoval(bakeletsPath, remotesPath, doc, scriptPath, verbose, location)
        };
    }

    async applyRemoval(approved, verbose) {
        let resolveB = require('../../bakelets/resolve');
        return resolveB.applyBakeletRemoval(approved, verbose);
    }

    async bake(scriptPath, ansibleSSHConfig, verbose) {
        let doc = yaml.safeLoad(await fs.readFile(path.join(scriptPath, 'baker.yml'), 'utf8'));

        let location;
        if (typeof doc.local === 'string') {
            location = LocalProvider.resolveLocation(doc.local);
        } else {
            location = process.cwd();
        }

        await fs.ensureDir(location);

        let resolveB = require('../../bakelets/resolve');
        await resolveB.resolveBakelet(bakeletsPath, remotesPath, doc, scriptPath, verbose, location);
    }
}

module.exports = LocalProvider;
