const child_process = require('child_process');
const Docker = require('dockerode');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');

const Provider = require('./provider');
const { bakeletsPath, remotesPath } = require('../../../global-vars');
const Utils = require('../utils/utils');

class DockerLocalProvider extends Provider {
    constructor() {
        super();
        let socketPath = process.env.DOCKER_HOST || '/var/run/docker.sock';
        this.docker = new Docker(
            socketPath.startsWith('/')
                ? { socketPath }
                : { host: socketPath }
        );
    }

    async pullImage(image) {
        return new Promise((resolve, reject) => {
            this.docker.pull(image, (err, stream) => {
                if (err) return reject(err);
                this.docker.modem.followProgress(stream, (err) =>
                    err ? reject(err) : resolve()
                );
            });
        });
    }

    async _findExistingContainer(name) {
        let containers = await this.docker.listContainers({ all: true });
        let match = containers.find(c =>
            c.Names && c.Names.some(n => n.replace('/', '') === name)
        );
        if (match) {
            return { id: match.Id, state: match.State === 'running' ? 'running' : 'stopped' };
        }
        return null;
    }

    async _createContainer(name, image) {
        let container = await this.docker.createContainer({
            name: name,
            Image: image,
            Tty: true,
            Cmd: ['/bin/bash', '-c', 'tail -f /dev/null'],
        });
        await container.start();
        return container;
    }

    // Removal targets the same container bake provisioned. The container must
    // still exist; cleanup does not attempt a partial host-side removal for a
    // container-side config.
    async planRemoval(scriptPath, ansibleSSHConfig, verbose) {
        let doc = yaml.safeLoad(await fs.readFile(path.join(scriptPath, 'baker.yml'), 'utf8'));
        let name = doc.name || path.basename(process.cwd());

        let resolveB = require('../../bakelets/resolve');
        return {
            root: `/${path.basename(scriptPath)}`,
            plan: await resolveB.planBakeletRemoval(
                bakeletsPath, remotesPath, doc, scriptPath, verbose, null, null, name
            )
        };
    }

    async applyRemoval(approved, verbose) {
        let resolveB = require('../../bakelets/resolve');
        return resolveB.applyBakeletRemoval(approved, verbose);
    }

    async bake(scriptPath, ansibleSSHConfig, verbose) {
        let doc = yaml.safeLoad(
            await fs.readFile(path.join(scriptPath, 'baker.yml'), 'utf8')
        );

        let image = 'ubuntu:latest';
        if (typeof doc.docker === 'string') image = doc.docker;
        else if (doc.docker && doc.docker.image) image = doc.docker.image;

        let name = doc.name || path.basename(process.cwd());

        await this.pullImage(image);

        let container;
        let existingInfo = await this._findExistingContainer(name);
        if (existingInfo) {
            if (existingInfo.state === 'stopped') {
                await this.docker.getContainer(existingInfo.id).remove({ force: true });
                container = await this._createContainer(name, image);
            } else {
                container = this.docker.getContainer(existingInfo.id);
            }
        } else {
            container = await this._createContainer(name, image);
        }

        let info = await container.inspect();
        await Utils.addToIndex(name, scriptPath, 'docker-local', {
            id: info.Id,
            image: image,
            hostname: info.NetworkSettings.IPAddress
        });

        if (doc.vars) {
            await Utils.traverse(doc.vars);
        }

        let resolveB = require('../../bakelets/resolve');
        await resolveB.resolveBakelet(
            bakeletsPath, remotesPath, doc, scriptPath, verbose,
            null, null, name
        );
    }

    async delete(name) {
        let env = await Utils.FindInIndex(name);
        if (!env || env.type !== 'docker-local') return;
        let container = this.docker.getContainer(env.info.id);
        try { await container.stop(); } catch {}
        await container.remove({ force: true });
        await Utils.removeFromIndex(name);
    }

    async ssh(name, cmdToRun, terminateProcessOnClose, verbose, options) {
        let env = await Utils.FindInIndex(name);
        if (!env || env.type !== 'docker-local') {
            throw `Unknown environment: ${name}`;
        }
        let container = this.docker.getContainer(env.info.id);

        if (cmdToRun) {
            let output = child_process.execSync(
                `docker exec ${name} /bin/bash -c '${cmdToRun.replace(/'/g, "'\\''")}'`,
                { encoding: 'utf8', maxBuffer: 2000 * 1024 }
            );
            return output;
        } else {
            child_process.execSync(
                `docker exec -it ${name} /bin/bash`,
                { stdio: 'inherit' }
            );
        }
    }
}

module.exports = DockerLocalProvider;
