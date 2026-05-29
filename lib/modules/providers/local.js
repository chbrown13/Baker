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

    async list() {
        let entries = [];
        try {
            entries = await fs.readdir(boxes);
        } catch {
            console.table('\nBaker local boxes: ', []);
            return;
        }
        let table = [];
        for (let name of entries) {
            let stat = await fs.stat(path.join(boxes, name));
            if (stat.isDirectory()) {
                let state = await this.getState(name);
                table.push({name: name, state: state, ports: 'N/A'});
            }
        }
        console.table('\nBaker local boxes: ', table);
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

    async bake(scriptPath, ansibleSSHConfig, verbose) {
        let doc = yaml.safeLoad(await fs.readFile(path.join(scriptPath, 'baker.yml'), 'utf8'));

        let location;
        if (typeof doc.local === 'string') {
            location = path.resolve(doc.local);
        } else {
            location = process.cwd();
        }

        await fs.ensureDir(location);

        let resolveB = require('../../bakelets/resolve');
        await resolveB.resolveBakelet(bakeletsPath, remotesPath, doc, scriptPath, verbose, location);
    }
}

module.exports = LocalProvider;
