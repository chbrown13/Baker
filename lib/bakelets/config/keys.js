const Bakelet = require('../bakelet');
const Ansible = require('../../modules/configuration/ansible');
const path    = require('path');

const { privateKey } = require('../../../global-vars');

class Keys extends Bakelet {

    constructor(name,ansibleSSHConfig, version) {
        super(ansibleSSHConfig);

        this.name = name;
        this.version = version;
    }

    // Playbook-backed: provisions through Ansible, so it needs a Linux target.
    get requiresAnsible() {
        return true;
    }

    async load(obj, variables)
    {
        if( Array.isArray(obj.keys) )
        {
            // Routed through this.copy rather than Ssh.copyFromHostToVM: the
            // direct call took ansibleSSHConfig, which is null outside remote
            // mode, so keys silently placed nothing in local and docker modes.
            // The injected transport also rewrites the /home/vagrant prefix.
            for (let clientName of obj.keys)
            {
                await this.copy(
                    privateKey,
                    `/home/vagrant/baker/${this.name}/${clientName}_id_rsa`
                );
            }

            variables.push({baker_client_keys : obj.keys.map( k => `${k}_id_rsa`) });
            this.variables = variables;
            let playbook = path.resolve(this.remotesPath, `bakelets-source/config/keys${this.version}.yml`);
            await this.copy(playbook,`/home/vagrant/baker/${this.name}/keys${this.version}.yml`);
        }
    }

    async install()
    {
        var cmd = `keys${this.version}.yml`;
        await Ansible.runAnsiblePlaybook(
            {name: this.name}, cmd, this.ansibleSSHConfig, this.verbose, this.variables
        );
    }


}

module.exports = Keys;

