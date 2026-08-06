const Bakelet  = require('../bakelet');
const fs       = require('fs-extra');
const mustache = require('mustache');
const path     = require('path');

// Renders a template and writes it to the target.
//
// Previously this called Ssh.copyFromHostToVM directly and then Ansible's
// template module, which meant it only ever worked in remote mode — in local
// and docker modes `ansibleSSHConfig` is null and the copy silently went
// nowhere. Rendering here and writing through this.exec() makes it work on
// every transport and every platform, and needs no elevation.
//
// Ansible's template module is Jinja2 and this is Mustache. For the variable
// interpolation these templates actually use — {{ name }} — the two agree;
// Jinja loops and conditionals do not carry over, and there are none in the
// shipped templates.
// Added by Claude Code (claude-opus-5[1m])
class Template extends Bakelet {

    constructor(name, ansibleSSHConfig, version) {
        super(ansibleSSHConfig);

        this.name = name;
        this.version = version;
    }

    get needsPlatform() {
        return true;
    }

    // Writes wherever the author pointed it, which for the per-unit use case is
    // inside a repo they own. Anything needing a system path is a files: job.
    get requiresElevation() {
        return false;
    }

    async load(obj, variables) {
        this.srcPath = path.resolve(this.bakePath, obj.template.src);
        this.dest = obj.template.dest;
        this.variables = variables;
    }

    // extra_vars arrives as a list of single-key maps, the same shape the
    // Ansible path flattened before handing to -e.
    flatVariables() {
        const flat = {};
        (this.variables || []).forEach((entry) => Object.assign(flat, entry));
        return flat;
    }

    // The rendered file is Baker's, at a path the config names, so the inverse
    // is exactly that path.
    async plan() {
        if (!this.dest) {
            return [{ kind: 'none', bakelet: 'template', reason: 'no dest declared' }];
        }
        if (!(await this.filterExisting([this.dest])).length) {
            return [{ kind: 'none', bakelet: 'template', reason: `${this.dest} already gone` }];
        }
        return [{
            kind: 'paths', bakelet: 'template', default: true,
            paths: [this.dest], emptyOnly: [],
            restore: 'baker bake <same source>'
        }];
    }

    async uninstall(operation) {
        for (const target of operation.paths) {
            await this.removePath(target);
        }
    }

    async install() {
        const source = await fs.readFile(this.srcPath, 'utf8');
        const rendered = mustache.render(source, this.flatVariables());
        await this.exec(this.writeCommand(this.dest, rendered));
    }

    // Written through the shell rather than this.copy() because the local-mode
    // copy shim flattens its destination to path.basename(dest) — so a nested
    // dest would land in the wrong place. Heredoc and here-string bodies are
    // both literal, so nothing in the rendered content gets re-interpreted.
    writeCommand(dest, content) {
        if (this.shell === 'powershell') {
            return `New-Item -ItemType Directory -Force -Path (Split-Path -Parent "${dest}") | Out-Null; ` +
                `Set-Content -LiteralPath "${dest}" -Value @"\n${content}\n"@`;
        }
        return `mkdir -p "$(dirname "${dest}")" && cat > "${dest}" <<"BAKER_TEMPLATE"\n${content}\nBAKER_TEMPLATE`;
    }
}

module.exports = Template;
