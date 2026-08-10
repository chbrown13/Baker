const child_process = require('child_process');
const Ssh           = require('../ssh');

class Ansible {

    // TODO: Need to be cleaning cmd so they don't do things like
    // ; sudo rm -rf / on our server...
    static async runLocalPlaybook(doc, cmd, location, verbose, variables) {
        let flatVars = {};
        for (var i = 0; i < variables.length; i++) {
            for (var key in variables[i]) {
                flatVars[key] = variables[i][key];
            }
        }
        let extravars = JSON.stringify(flatVars);
        if (verbose) console.log(extravars);
        let localCmd = `export ANSIBLE_HOST_KEY_CHECKING=false && cd "${location}" && echo '${extravars}' > playbook.args.json && ansible-playbook -e @playbook.args.json -i "localhost," -c local ${cmd} ; rm -f playbook.args.json`;
        let output = require('child_process').execSync(localCmd, {encoding: 'utf8', maxBuffer: 2000 * 1024});

        let results = output.split('\n').filter(line => line.indexOf('ok=') >= 0 && line.indexOf('failed=') >= 0);
        if (results.length > 0) {
            let recapString = results[0];
            if (recapString.indexOf('failed=0') == -1) {
                throw new Error(`A bakelet task failed, see output for details: \r\n ${output}`);
            }
        } else {
            throw new Error(`Failed to run bakelet, see output for details: \r\n ${output}`);
        }
    }

    static async runAnsiblePlaybook(doc, cmd, ansibleSSHConfig, verbose, variables) {
        let flatVars = {};
        for (var i = 0; i < variables.length; i++) {
            for (var key in variables[i]) {
                flatVars[key] = variables[i][key];
            }
        }
        let extravars = JSON.stringify(flatVars);
        //let extravars = yaml.dump(variables);
        if (verbose) console.log(extravars);
        // return Ssh.sshExec(`export ANSIBLE_HOST_KEY_CHECKING=false && cd /home/vagrant/baker/${doc.name} && ansible all -m ping -i baker_inventory`, ansibleSSHConfig, verbose);
        let output = await Ssh.sshExec(`export ANSIBLE_HOST_KEY_CHECKING=false && cd /home/vagrant/baker/${doc.name} && echo '${extravars}' > playbook.args.json && ansible-playbook -e @playbook.args.json -i baker_inventory ${cmd} ; rm -f playbook.args.json`, ansibleSSHConfig, 2000, verbose);
        // Can do in ansible 2.5 ...
        // export ANSIBLE_STDOUT_CALLBACK=yaml &&

        // Perform error checking...
        let results = output.split('\n').filter(line => line.indexOf('ok=') >= 0 && line.indexOf('failed=') >= 0);
        if (results.length > 0) {
            let recapString = results[0];
            if( recapString.indexOf("failed=0") == -1)
            {
                throw new Error(`A bakelet task failed, see output for details: \r\n ${output}`);
            }
        }
        else
        {
            throw new Error(`Failed to run bakelet, see output for details: \r\n ${output}`);
        }
    }


    static async runAnsiblePipInstall(doc, requirements, ansibleSSHConfig, verbose) {
        return Ssh.sshExec(`export ANSIBLE_HOST_KEY_CHECKING=false && cd /home/vagrant/baker/${doc.name} && ansible all -m pip -a "requirements=${requirements}" -i baker_inventory --become`, ansibleSSHConfig, 20000, verbose);
    }

    static async runAnsibleNpmInstall(doc, packagejson, ansibleSSHConfig, verbose) {
        return Ssh.sshExec(`export ANSIBLE_HOST_KEY_CHECKING=false && cd /home/vagrant/baker/${doc.name} && ansible all -m npm -a "path=${packagejson}" -i baker_inventory`, ansibleSSHConfig, 20000, verbose);
    }

    static async createDirectory(doc, dir, mode, ansibleSSHConfig, verbose)
    {
        return Ssh.sshExec(`export ANSIBLE_HOST_KEY_CHECKING=false && cd /home/vagrant/baker/${doc.name} && ansible all -m file -a "path=${dir} mode=${mode} state=directory" -i baker_inventory`, ansibleSSHConfig, 20000, verbose);
    }

    static async runAnsibleTemplateCmd(doc, src, dest, variables, ansibleSSHConfig, verbose) {
        let flatVars = {};
        for( var i =0; i < variables.length; i++ )
        {
            for( var key in variables[i] )
            {
                flatVars[key] = variables[i][key];
            }
        }
        let extravars = JSON.stringify(flatVars);
        //let extravars = yaml.dump(variables);
        return Ssh.sshExec(`export ANSIBLE_HOST_KEY_CHECKING=false && cd /home/vagrant/baker/${doc.name} && echo '${extravars}' > template.args.json && ansible all -m template -a "src=${src} dest=${dest}" -e @template.args.json -i baker_inventory; rm -f template.args.json`, ansibleSSHConfig, 20000, verbose);
    }

    static buildRemoteInventory(remoteSSHConfig) {
        return `${remoteSSHConfig.hostname} ansible_connection=ssh ansible_user=${remoteSSHConfig.user} ansible_ssh_private_key_file=${remoteSSHConfig.private_key}`;
    }

    static async runRemotePlaybook(doc, cmd, remoteSSHConfig, verbose, variables) {
        let flatVars = {};
        for (var i = 0; i < variables.length; i++) {
            for (var key in variables[i]) {
                flatVars[key] = variables[i][key];
            }
        }
        let extravars = JSON.stringify(flatVars);
        let inventory = Ansible.buildRemoteInventory(remoteSSHConfig);
        let localCmd = `export ANSIBLE_HOST_KEY_CHECKING=false && echo '${extravars}' > /tmp/playbook.args.json && ansible-playbook -e @/tmp/playbook.args.json -i "${inventory}" ${cmd} ; rm -f /tmp/playbook.args.json`;
        let output = child_process.execSync(localCmd, {encoding: 'utf8', maxBuffer: 2000 * 1024});

        let results = output.split('\n').filter(line => line.indexOf('ok=') >= 0 && line.indexOf('failed=') >= 0);
        if (results.length > 0) {
            let recapString = results[0];
            if (recapString.indexOf('failed=0') == -1) {
                throw new Error(`A bakelet task failed, see output for details: \r\n ${output}`);
            }
        } else {
            throw new Error(`Failed to run bakelet, see output for details: \r\n ${output}`);
        }
    }

    static async runRemoteAdhoc(doc, module, moduleArgs, remoteSSHConfig, verbose) {
        let inventory = Ansible.buildRemoteInventory(remoteSSHConfig);
        let localCmd = `export ANSIBLE_HOST_KEY_CHECKING=false && ansible all -m ${module} -a "${moduleArgs}" -i "${inventory}" --become`;
        return child_process.execSync(localCmd, {encoding: 'utf8', maxBuffer: 2000 * 1024});
    }


    static async runRemotePipInstall(doc, requirements, remoteSSHConfig, verbose) {
        return Ansible.runRemoteAdhoc(doc, 'pip', `requirements=${requirements}`, remoteSSHConfig, verbose);
    }

    static async runRemoteNpmInstall(doc, packagejson, remoteSSHConfig, verbose) {
        return Ansible.runRemoteAdhoc(doc, 'npm', `path=${packagejson}`, remoteSSHConfig, verbose);
    }

    static async runRemoteCreateDirectory(doc, dir, mode, remoteSSHConfig, verbose) {
        return Ansible.runRemoteAdhoc(doc, 'file', `path=${dir} mode=${mode} state=directory`, remoteSSHConfig, verbose);
    }

    static async runRemoteTemplateCmd(doc, src, dest, variables, remoteSSHConfig, verbose) {
        let flatVars = {};
        for (var i = 0; i < variables.length; i++) {
            for (var key in variables[i]) {
                flatVars[key] = variables[i][key];
            }
        }
        let extravars = JSON.stringify(flatVars);
        let inventory = Ansible.buildRemoteInventory(remoteSSHConfig);
        let localCmd = `export ANSIBLE_HOST_KEY_CHECKING=false && echo '${extravars}' > /tmp/template.args.json && ansible all -m template -a "src=${src} dest=${dest}" -e @/tmp/template.args.json -i "${inventory}" ; rm -f /tmp/template.args.json`;
        return child_process.execSync(localCmd, {encoding: 'utf8', maxBuffer: 2000 * 1024});
    }

    static buildDockerInventory(containerName) {
        return `${containerName} ansible_connection=docker ansible_user=root`;
    }

    static async runDockerPlaybook(doc, cmd, containerName, verbose, variables) {
        let flatVars = {};
        for (var i = 0; i < variables.length; i++) {
            for (var key in variables[i]) {
                flatVars[key] = variables[i][key];
            }
        }
        let extravars = JSON.stringify(flatVars);
        let inventory = Ansible.buildDockerInventory(containerName);
        let localCmd = `export ANSIBLE_HOST_KEY_CHECKING=false && echo '${extravars}' > /tmp/playbook.args.json && ansible-playbook -e @/tmp/playbook.args.json -i "${inventory}" ${cmd} ; rm -f /tmp/playbook.args.json`;
        let output = child_process.execSync(localCmd, {encoding: 'utf8', maxBuffer: 2000 * 1024});

        let results = output.split('\n').filter(line => line.indexOf('ok=') >= 0 && line.indexOf('failed=') >= 0);
        if (results.length > 0) {
            let recapString = results[0];
            if (recapString.indexOf('failed=0') == -1) {
                throw new Error(`A bakelet task failed, see output for details: \r\n ${output}`);
            }
        } else {
            throw new Error(`Failed to run bakelet, see output for details: \r\n ${output}`);
        }
    }

    static async runDockerAdhoc(doc, module, moduleArgs, containerName, verbose) {
        let inventory = Ansible.buildDockerInventory(containerName);
        let localCmd = `export ANSIBLE_HOST_KEY_CHECKING=false && ansible all -m ${module} -a "${moduleArgs}" -i "${inventory}" --become`;
        return child_process.execSync(localCmd, {encoding: 'utf8', maxBuffer: 2000 * 1024});
    }


    static async runDockerPipInstall(doc, requirements, containerName, verbose) {
        return Ansible.runDockerAdhoc(doc, 'pip', `requirements=${requirements}`, containerName, verbose);
    }

    static async runDockerNpmInstall(doc, packagejson, containerName, verbose) {
        return Ansible.runDockerAdhoc(doc, 'npm', `path=${packagejson}`, containerName, verbose);
    }

    static async runDockerCreateDirectory(doc, dir, mode, containerName, verbose) {
        return Ansible.runDockerAdhoc(doc, 'file', `path=${dir} mode=${mode} state=directory`, containerName, verbose);
    }

    static async runDockerTemplateCmd(doc, src, dest, variables, containerName, verbose) {
        let flatVars = {};
        for (var i = 0; i < variables.length; i++) {
            for (var key in variables[i]) {
                flatVars[key] = variables[i][key];
            }
        }
        let extravars = JSON.stringify(flatVars);
        let inventory = Ansible.buildDockerInventory(containerName);
        let localCmd = `export ANSIBLE_HOST_KEY_CHECKING=false && echo '${extravars}' > /tmp/template.args.json && ansible all -m template -a "src=${src} dest=${dest}" -e @/tmp/template.args.json -i "${inventory}" ; rm -f /tmp/template.args.json`;
        return child_process.execSync(localCmd, {encoding: 'utf8', maxBuffer: 2000 * 1024});
    }

}

module.exports = Ansible;

