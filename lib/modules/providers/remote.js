const fs       = require('fs-extra');
const path     = require('path');
const Provider = require('./provider');
const Ssh      = require('../ssh');
const Utils    = require('../utils/utils');
const yaml     = require('js-yaml');

const { bakeletsPath, remotesPath } = require('../../../global-vars');

class RemoteProvider extends Provider {
    /**
     * @param {String} username ssh username for the remote host
     * @param {String} privateKey ssh key for sshing to the remote host
     * @param {String} hostname ip address of the remote host
     * @param {String} port=22 ssh port
     */
    constructor(user, private_key, hostname, port = 22) {
        super();
        this.sshConfig = {
            user,
            private_key,
            hostname,
            port
        }
    }

    async bake(scriptPath, ansibleSSHConfig, verbose) {
        let doc = yaml.safeLoad(await fs.readFile(path.join(scriptPath, 'baker.yml'), 'utf8'));

        try {
            // Direct mode: use remoteSSHConfig from the baker.yml remote: key
            let remoteSSHConfig = {
                user: doc.remote.user,
                private_key: path.resolve(doc.remote.private_key),
                hostname: doc.remote.ip,
                port: doc.remote.port || 22
            };

            // Ensure remote directory structure exists
            await Ssh.sshExec(
                `mkdir -p /home/vagrant/baker/${doc.name}/templates`,
                remoteSSHConfig, 60000, verbose
            );

            // prompt for passwords
            if (doc.vars) {
                await Utils.traverse(doc.vars);
            }

            // Installing stuff.
            let resolveB = require('../../bakelets/resolve');
            await resolveB.resolveBakelet(bakeletsPath, remotesPath, doc, scriptPath, verbose, null, remoteSSHConfig);

        } catch (err) {
            throw err;
        }
    }

    async delete(name) {
        try {
            await Ssh.sshExec(`rm -rf /home/vagrant/baker/${name}`, this.sshConfig, 30000);
        } catch (err) {
            // If server is unreachable, that's acceptable for cleanup
        }
    }

    /**
     * ssh to the environment using ssh2
     */
    async ssh() {
        try {
            await Ssh.SSH_Session(this.sshConfig);
        } catch (err) {
            throw err;
        }
    }

    /**
     * @param {String} bakePath path to the directory of baker.yml
     * @returns {Boolean} true if baker.yml is compatible with this provider, otherwise false
     */
    static async validateBakerYML(bakePath) {
        let doc = yaml.safeLoad(await fs.readFile(path.join(bakePath, 'baker.yml'), 'utf8'));
        if (doc.remote && doc.remote.ip && doc.remote.user && doc.remote.private_key)
            return true;
        else
            return false;
    }

    getSSHConfig() {
        return this.sshConfig;
    }

}

module.exports = RemoteProvider;
