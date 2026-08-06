const fs   = require('fs-extra');
const os   = require('os');
const path = require('path');

// Append-only record of what each cleanup run removed, and how to get it back.
//
// Without this, "cleanup removed my work" is untriageable once the terminal
// scrolls — and that is the complaint this feature is most likely to generate.
//
// The log is local and never transmitted, which is consistent with the absolute
// no-telemetry constraint: it forbids sending data off the machine, not keeping
// a record on it. --dry-run writes nothing.
// Added by Claude Code (claude-opus-5[1m])
class CleanupLog {

    static logPath() {
        return path.join(os.homedir(), '.baker', 'cleanup.log');
    }

    // Recoverability is knowable at plan time and differs by kind, which is
    // what makes the hint worth recording rather than decorative.
    static restoreHint(operation) {
        if (operation.restore) return operation.restore;
        if (operation.kind === 'repo') return `git clone <url> ${operation.path}`;
        if (operation.kind === 'exec') return 'not recoverable by Baker — reinstall manually';
        return 'baker bake <same source>';
    }

    static label(operation) {
        if (operation.kind === 'paths') {
            return operation.paths.length === 1
                ? operation.paths[0]
                : `${operation.bakelet} (${operation.paths.length} paths)`;
        }
        if (operation.kind === 'block') return `${operation.file} (baker block)`;
        if (operation.kind === 'repo') return operation.path;
        return operation.bakelet;
    }

    // One entry per run. `items` is a list of {operation, disposition, detail}.
    static async append({ source, provider, root, items }) {
        const when = new Date().toISOString();
        const lines = [`${when}  cleanup ${source}  provider=${provider}  root=${root}`];

        items.forEach(({ operation, disposition, detail }) => {
            const label = CleanupLog.label(operation);
            const suffix = disposition === 'REMOVED'
                ? `restore: ${CleanupLog.restoreHint(operation)}`
                : (detail || '');
            lines.push(`  ${disposition.padEnd(13)} ${String(label).padEnd(38)} ${suffix}`.trimEnd());
        });

        try {
            await fs.ensureDir(path.dirname(CleanupLog.logPath()));
            await fs.appendFile(CleanupLog.logPath(), lines.join('\n') + '\n');
            return true;
        } catch (err) {
            // A logging failure must never replace the outcome the user needs.
            return false;
        }
    }
}

module.exports = CleanupLog;
