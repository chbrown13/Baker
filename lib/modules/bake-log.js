const fs   = require('fs-extra');
const os   = require('os');
const path = require('path');

// Failure reporting for bakelets, plus a local log.
//
// A raw package-manager failure is not something a cohort member can act on:
// pacman says "target not found", apt exits 100, choco prints a wall of NuGet
// output. Baker knows what it was doing and which manager it used, so it says
// that first and keeps the real output underneath.
//
// The log stays on the machine — it is a record, not telemetry, which is the
// same line `baker cleanup` draws for ~/.baker/cleanup.log.
// Added by Claude Code (claude-opus-5[1m])
class BakeLog {

    static logPath() {
        return path.join(os.homedir(), '.baker', 'bake.log');
    }

    // Values shorter than this are skipped: redacting "8080" or "true" would
    // shred the surrounding output for no protection, since neither identifies
    // anything on its own.
    static get MIN_SECRET_LENGTH() {
        return 4;
    }

    // Secret values a bake knows about. env: values are user-supplied and
    // routinely hold API keys; vault entries are secret by definition.
    static collectSecrets(doc) {
        const secrets = [];
        (doc && doc.env ? doc.env : []).forEach((entry) => {
            Object.keys(entry || {}).forEach((key) => {
                const value = String(entry[key]);
                if (value.length >= BakeLog.MIN_SECRET_LENGTH) secrets.push(value);
            });
        });
        return secrets;
    }

    // Replaces every known secret with ***. Applied to the terminal message as
    // well as the log: people paste terminal output into chat at least as often
    // as they attach files.
    static redact(text, secrets = []) {
        let out = String(text === undefined || text === null ? '' : text);
        // Longest first, so a secret containing another is not partly revealed.
        secrets.slice().sort((a, b) => b.length - a.length).forEach((secret) => {
            out = out.split(secret).join('***');
        });
        return out;
    }

    // Whether an error came from a shell command or from Baker's own checks.
    // A child_process failure carries an exit status and captured streams; a
    // Baker-authored error ("source not found: …", "dest resolves outside …")
    // carries a message that is already the best thing to show. Leading with
    // "command failed" for those would bury the one useful sentence.
    static isCommandFailure(error) {
        if (!error) return false;
        return error.status !== undefined || Boolean(error.stderr) || Boolean(error.stdout);
    }

    // The human-facing message: what Baker was doing, then the fix, then where
    // the full output went, then the real output last.
    static describeFailure({ bakeletName, manager, command, output, secrets = [], authored }) {
        const lines = [];
        if (authored) {
            // The bakelet already explained itself; say which bakelet it was
            // and get out of the way. Bakelets that prefix their own name get
            // it stripped, so the line does not stutter.
            const prefix = new RegExp(`^${bakeletName}:\\s*`);
            lines.push(`✗ ${bakeletName}: ${BakeLog.redact(authored, secrets).replace(prefix, '')}`);
        } else {
            lines.push(manager
                ? `✗ ${bakeletName}: command failed with ${manager}.`
                : `✗ ${bakeletName}: command failed.`);
        }

        if (bakeletName === 'system') {
            lines.push('');
            lines.push('  Package names differ between systems. Either use the name this one');
            lines.push('  expects, or give per-manager names in baker.yml:');
            lines.push('');
            lines.push('      packages:');
            lines.push('        - name: fd');
            lines.push('          apt: fd-find');
            lines.push('          brew: fd');
        }

        lines.push('');
        lines.push(`  Full output: ${BakeLog.logPath()}`);

        // An authored error names its own subject; repeating the last shell
        // command Baker happened to run would point at the wrong thing.
        if (command && !authored) {
            lines.push('');
            lines.push(`  Command: ${BakeLog.redact(command, secrets)}`);
        }
        if (output && !authored) {
            lines.push('');
            lines.push('  --- output ---');
            lines.push(BakeLog.redact(output, secrets));
        }
        return lines.join('\n');
    }

    // Appends one entry. Never throws: a logging failure must not replace the
    // real error the user needs to see.
    static async append({ bakeletName, command, exitCode, output, secrets = [] }) {
        try {
            const when = new Date().toISOString();
            const entry = [
                `--- ${when} ${bakeletName || 'bakelet'} ---`,
                `command: ${BakeLog.redact(command, secrets)}`,
                `exit: ${exitCode === undefined ? 'unknown' : exitCode}`,
                BakeLog.redact(output, secrets),
                ''
            ].join('\n');

            await fs.ensureDir(path.dirname(BakeLog.logPath()));
            await fs.appendFile(BakeLog.logPath(), entry);
            return true;
        } catch (err) {
            return false;
        }
    }

    // Wraps a bakelet failure: logs it, then returns the Error to throw.
    static async wrap(error, { bakeletName, manager, command, secrets = [] }) {
        const commandFailure = BakeLog.isCommandFailure(error);
        const output = commandFailure
            ? `${error.stdout || ''}${error.stderr || ''}`
            : (error && error.message) || String(error);

        await BakeLog.append({
            bakeletName,
            command: command || (error && error.cmd),
            exitCode: error && error.status,
            output,
            secrets
        });

        const wrapped = new Error(BakeLog.describeFailure({
            bakeletName, manager, command: command || (error && error.cmd), output, secrets,
            authored: commandFailure ? null : output
        }));
        wrapped.cause = error;
        return wrapped;
    }
}

module.exports = BakeLog;
