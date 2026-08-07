const fs            = require('fs-extra');
const path          = require('path');
const yaml          = require('js-yaml');

const Provider         =      require('./providers/provider');
const LocalProvider    =      require('./providers/local');
const RemoteProvider   =      require('./providers/remote');
const DockerLocalProvider =   require('./providers/docker-local');


// conf variables:
// const spinnerDot = conf.get('spinnerDot');

const { configPath } = require('../../global-vars');

// Environment keys Baker used to provision through the baker-srv control VM.
// The providers behind them are gone, so a config carrying one is met with a
// message naming what to use instead rather than a null-provider crash.
const RETIRED_ENV_KEYS = {
    vm:         'vm',
    vagrant:    'vagrant',
    container:  'container',
    persistent: 'persistent'
};

class Baker {
    /**
     *
     * @param {Provider} provider
     */
    constructor(provider) {
        this.provider = provider;
    }

    async ssh(name) {
        await this.provider.ssh(name);
    }

    async delete(name) {
        await this.provider.delete(name);
    }

    async bake(scriptPath, ansibleSSHConfig, verbose) {
        await this.provider.bake(scriptPath, ansibleSSHConfig, verbose);
    }

    // Removal entry points, mirroring bake(). Only the three retained providers
    // implement them; the rest have no cleanup path and say so.
    async planRemoval(scriptPath, ansibleSSHConfig, verbose) {
        if (typeof this.provider.planRemoval !== 'function') {
            throw new Error('cleanup supports local:, docker:, and remote: environments only.');
        }
        return this.provider.planRemoval(scriptPath, ansibleSSHConfig, verbose);
    }

    async applyRemoval(approved, verbose) {
        return this.provider.applyRemoval(approved, verbose);
    }

    async images(){
        await this.provider.images();
    }

    static async init() {
        let bakerYML = await fs.readFile(path.join(configPath, './bakerTemplate.yml'), 'utf8');
        let dir = path.resolve(process.cwd());
        await fs.writeFile('baker.yml', bakerYML, {encoding:'utf8'});
    }

    /**
     * detects the type of environment.
     * Helper function for commands to automatically create the right provider object.
     * @param {String} bakePath path to the baker.yml file
     */
    static async chooseProvider(bakePath){
        let doc = yaml.safeLoad(await fs.readFile(path.join(bakePath, 'baker.yml'), 'utf8'));

        // safeLoad returns undefined for an empty file, which used to surface as
        // a bare "Cannot read properties of undefined" from the key checks below.
        if( !doc || typeof doc !== 'object' || Array.isArray(doc) )
            throw new Error(`baker.yml is empty or is not a YAML mapping.\n` + Baker.supportedEnvList());

        let envName = doc.name;

        // Retired keys are checked before the supported ones so an old config
        // gets the explanation rather than falling through to 'unsupported'.
        let retired = Object.keys(RETIRED_ENV_KEYS).find(key => doc[key]);
        if( retired )
            throw new Error(Baker.retiredEnvMessage(retired));

        let envType = doc.docker ? 'docker-local' : doc.local ? 'local' : doc.remote ? 'remote' : 'other';

        let provider = null;
        if(envType === 'remote'){
            if(!RemoteProvider.validateBakerYML(bakePath)){
                console.error('invalid baker.yml for remote provider');
                process.exit(1);
            }
            else
                provider = new RemoteProvider(doc.remote.user, doc.remote.private_key, doc.remote.ip, doc.remote.port);
        }
        else if(envType === 'docker-local')
        {
            provider = new DockerLocalProvider();
        }
        else if(envType === 'local')
        {
            provider = new LocalProvider();
        }
        else
            throw new Error(Baker.unsupportedEnvMessage());

        let BakerObj = new Baker(provider);

        return {envName, provider, BakerObj, doc};
    }

    /**
     * Message for a baker.yml written against a provider Baker no longer has.
     * @param {String} key the retired top-level key found in the config
     */
    static retiredEnvMessage(key) {
        return `'${key}:' is no longer supported.\n` + Baker.supportedEnvList();
    }

    static unsupportedEnvMessage() {
        return `no supported environment found in baker.yml.\n` + Baker.supportedEnvList();
    }

    static supportedEnvList() {
        return [
            `Baker supports: local:, docker:, remote:`,
            `  local:  configure this machine`,
            `  docker: configure a container`,
            `  remote: configure a host over SSH`
        ].join('\n');
    }

    static async getCWDBakerYML(){
        let cwd = path.resolve(process.cwd());
        let bakePath = path.resolve(cwd, 'baker.yml')
        if(await fs.pathExists(bakePath)){
            let bakerYML = yaml.safeLoad(await fs.readFile(bakePath, 'utf8'));
            bakerYML.cwd = cwd;
            return bakerYML;
        } else{
            return undefined;
        }
    }

    /**
     * Get ssh configurations
     * @param {Obj} machine
     * @param {Obj} nodeName Optionally give name of machine when multiple machines declared in single Vagrantfile.
     */
    static async getSSHConfig (machine, nodeName) {
        this.provider.getSSHConfig(machine, nodeName);
    }

}

module.exports = Baker;
