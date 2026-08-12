const path             = require('path');
const os               = require('os');
const Promise          = require('bluebird');
const ping             = require('ping')
const inquirer         = require('inquirer');

const fs               = require('fs-extra');
const _                = require('underscore');
const { envIndexPath } = require('../../../global-vars');
const hasbin           = require('hasbin');

class Utils {
    constructor() {}

    /**
     * Expands a leading ~ against the home directory of whoever is running
     * Baker.
     *
     * path.resolve does NOT do this: it treats the tilde as an ordinary path
     * segment and yields <cwd>/~/.ssh/id_rsa, which surfaces later as an ENOENT
     * a long way from the config line that caused it. Every documented
     * `private_key:` example uses the ~ form, so this is the common path rather
     * than the edge case.
     *
     * `~user/...` is deliberately left untouched — it names a different user's
     * home, which os.homedir() cannot answer. Expanding it against the current
     * home would silently point at the wrong file.
     * Added by Claude Code (claude-opus-5[1m])
     */
    static expandTilde(p) {
        if (typeof p !== 'string' || !p.startsWith('~')) return p;
        if (p === '~') return os.homedir();
        if (p.startsWith('~/') || p.startsWith('~\\')) {
            return path.join(os.homedir(), p.slice(2));
        }
        return p;
    }

    /**
     * Private function:
     * Traverse yaml and do prompts
     */
    static async traverse(o) {
        const stack = [{ obj: o, parent: null, parentKey: '' }];

        while (stack.length) {
            const s = stack.shift();
            const obj = s.obj;
            const parent = s.parent;
            const parentKey = s.parentKey;

            for (var i = 0; i < Object.keys(obj).length; i++) {
                let key = Object.keys(obj)[i];

                //await fn(key, obj[key], obj)

                if (obj[key] instanceof Object) {
                    stack.unshift({ obj: obj[key], parent: obj, parentKey: key });
                }

                if (key == 'prompt') {
                    const input = await this.promptValue(parentKey, obj[key]);
                    // Replace "prompt" with an value provided by user.
                    parent[parentKey] = input;
                }
            }
        }
        return o;
    }

    static async promptValue(propertyName, description, hidden=false) {
        const answers = await inquirer.prompt([{
            type: hidden ? 'password' : 'input',
            name: propertyName,
            message: description
        }]);
        return answers[propertyName];
    }

    static async hasbin(bin)
    {
        return new Promise(function(resolve, reject)
        {
            hasbin(bin, function(result )
            {
                resolve(result);
            });
        });
    }

    static async hostIsAccessible(host) {
        return (await ping.promise.probe(host, {extra: ['-i 2']})).alive;
    }

    static async _ensureDir(path) {
        try {
            await fs.ensureDir(path);
        } catch (err) {
            throw `could not create directory: ${path} \n${err}`;
        }
    }

    static async initIndex(force = false) {
        if (!(await fs.pathExists(envIndexPath)) || force) {
            let envIndex = []

            try {
                await fs.outputJson(envIndexPath, envIndex, {spaces: 4});
            } catch (err) {
                console.error(err);
            }
        }
    }

    /**
     *
     * @param {String} type vm | container | DO
     * @param {Object} env
     */
    static async addToIndex(name, path, type, info) {
        await this.initIndex();
        try {
            let env = {name, path, type, info: _.pick(info, 'host', 'hostname', 'user', 'image', 'private_key', 'port')};
            if(!(await this.FindInIndex(env.name))){
                let envIndex = await fs.readJson(envIndexPath);
                envIndex.push(env);
                await fs.outputJson(envIndexPath, envIndex, {spaces: 4});
            }
        } catch (err) {
            console.error(err);
        }
    }

    /**
     * Find and return the env object from index or return null if it doesn't exist
     * @param {String} name name of the environment
     */
    static async FindInIndex(name) {
        await this.initIndex();
        let envIndex = await fs.readJson(envIndexPath);
        return envIndex.find(e => e.name === name) || null;
    }

    static async removeFromIndex(name) {
        await this.initIndex();
        let envIndex = await fs.readJson(envIndexPath);
        envIndex = envIndex.filter(e => e.name != name);
        await fs.outputJson(envIndexPath, envIndex, {spaces: 4});
    }

    static async setEnvIndexState(name, state) {
        await this.initIndex();
        let envIndex = await fs.readJson(envIndexPath);
        envIndex.forEach(env => {
            if(env.name === name)
                env.state = state;
        })
        await fs.outputJson(envIndexPath, envIndex, {spaces: 4});
    }

    static async getEnvIndex() {
        await this.initIndex();
        return await fs.readJson(envIndexPath);
    }

}

module.exports = Utils;
