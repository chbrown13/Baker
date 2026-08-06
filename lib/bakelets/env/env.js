const Bakelet = require('../bakelet');

// Environment variables for the USER, not the system.
//
// This previously rendered an Ansible playbook that appended to
// /etc/environment — a Debian/systemd convention that does not exist on macOS,
// has no Windows analogue, and needs root. Writing the user's own environment
// instead makes env: portable AND drops its elevation requirement, which
// matters because a per-unit config re-bakes often and an admin prompt on every
// assignment teaches people to click through prompts.
//
// POSIX: every export lives in ~/.baker/env.sh, rewritten whole on each bake so
// a key removed from baker.yml disappears rather than lingering, plus one
// source line in the profile. Windows: SetEnvironmentVariable at User scope,
// which the registry persists for new shells.
// Added by Claude Code (claude-opus-5[1m])
class Env extends Bakelet {
    constructor(name, ansibleSSHConfig, version) {
        super(ansibleSSHConfig);

        this.name = name;
        this.version = version;
    }

    // Varies by platform without being package-manager shaped, so it opts in
    // directly rather than through a commands table.
    get needsPlatform() {
        return true;
    }

    // Writing the user's own environment needs no sudo anywhere. This is the
    // property that keeps a files:/env: per-unit bake prompt-free.
    get requiresElevation() {
        return false;
    }

    async load(obj, variables) {
        this.variables = variables;
        // env: is a list of single-key maps; the resolver hands this bakelet
        // {env: [...]}. Unchanged from the playbook version.
        this.envVars = (obj.env || []).map((e) => ({
            key: Object.keys(e)[0],
            value: Object.values(e)[0]
        }));
    }

    async install() {
        for (const cmd of this.installCommands()) {
            await this.exec(cmd);
        }
    }

    installCommands() {
        if (!this.envVars.length) return [];
        return this.shell === 'powershell'
            ? this.windowsCommands()
            : this.posixCommands();
    }

    // Escaped for a double-quoted shell assignment, because that is what the
    // value ends up inside once env.sh is sourced. The quoted heredoc keeps
    // these characters literal on the way IN; without escaping them they would
    // still expand on the way OUT, so a value of $HOME would silently become
    // the user's home directory.
    static escapePosix(value) {
        return String(value).replace(/([\\"$`])/g, '\\$1');
    }

    // PowerShell escapes a double quote inside a double-quoted string with a
    // backtick, and the backtick itself is the escape character.
    static escapePowershell(value) {
        return String(value).replace(/`/g, '``').replace(/"/g, '`"');
    }

    posixCommands() {
        const lines = this.envVars
            .map((v) => `export ${v.key}="${Env.escapePosix(v.value)}"`)
            .join('\n');

        return [
            'mkdir -p ~/.baker',
            // Quoted heredoc delimiter: the body is written literally, so a $
            // or backtick in a value cannot be expanded at write time.
            `cat > ~/.baker/env.sh <<"BAKER_ENV"\n${lines}\nBAKER_ENV`,
            // Appended once. ~ expands here, so the profile ends up with an
            // absolute path that stays correct if HOME is later reinterpreted.
            'grep -q baker/env.sh ~/.profile 2>/dev/null || echo . ~/.baker/env.sh >> ~/.profile'
        ];
    }

    windowsCommands() {
        // One call per variable. Naturally idempotent — setting the same value
        // twice is a no-op — but unlike the POSIX file this cannot prune a key
        // that baker.yml stopped declaring. Documented, not silently ignored.
        return this.envVars.map((v) =>
            `[Environment]::SetEnvironmentVariable("${v.key}", "${Env.escapePowershell(v.value)}", "User")`
        );
    }
}

module.exports = Env;
