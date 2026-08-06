const chalk    = require('chalk');
const inquirer = require('inquirer');
const path     = require('path');

const Baker      = require('../modules/baker');
const CleanupLog = require('../modules/cleanup-log');
const Print      = require('../modules/print');
const { resolveSource } = require('../modules/utils/source');

// `baker cleanup` — the declarative inverse of `baker bake`.
//
// Same source grammar, same provider selection, same bakelet construction, so
// removal routes through local, docker-local, and remote exactly as
// installation does. Any divergence between how bake resolves a config and how
// cleanup resolves it would silently remove the wrong thing.
//
// The ordering plan → render → confirm → apply IS the safety property: nothing
// is touched until every answer is in, so aborting at any prompt changes
// nothing and --dry-run is simply the first two steps.
// Added by Claude Code (claude-opus-5[1m])
exports.command = 'cleanup [source]';
exports.desc = 'Remove what a bake put on this machine (the inverse of bake)';

exports.builder = (yargs) => {
    yargs
        .example(`$0 cleanup`, `Undo the bake described by ./baker.yml`)
        .example(`$0 cleanup ./units/one`, `Undo the bake described by that directory`)
        .example(`$0 cleanup --dry-run`, `Print exactly what would be removed, and stop`)
        .example(`$0 cleanup --yes`, `Non-interactive: remove only the safe defaults`);

    yargs.positional('source', {
        describe: 'Where the baker.yml comes from — identical grammar to bake. Omit to use ./baker.yml.',
        type: 'string'
    });

    yargs.option('dry-run', { describe: 'Print the plan and exit. No prompts, no changes.', type: 'boolean', default: false });
    yargs.option('yes', { alias: 'y', describe: 'Accept the default answer for every prompt.', type: 'boolean', default: false });
    yargs.option('all', { describe: 'With --yes, select everything not refused. Cannot override a guard.', type: 'boolean', default: false });
    yargs.option('verbose', { alias: 'v', describe: 'Extra output from the removal process.', type: 'boolean', default: false });
};

exports.handler = async function (argv) {
    try {
        if (argv.all && !argv.yes) {
            throw new Error('--all requires --yes. It widens what is selected; it does not skip confirmation.');
        }

        const bakePath = await resolveSource(argv.source);
        const { BakerObj, provider } = await chooseProvider(bakePath);
        if (!BakerObj || typeof BakerObj.planRemoval !== 'function') {
            throw new Error(
                'cleanup supports local:, docker:, and remote: environments only.'
            );
        }

        const { plan, root } = await BakerObj.planRemoval(bakePath, null, argv.verbose);

        render(plan, bakePath, root);

        if (argv.dryRun) {
            // Stops here having changed nothing, and having written nothing to
            // the log — which is what makes it quotable in a participant guide.
            Print.info('Dry run: nothing was removed.');
            return;
        }

        const selectable = plan.filter((p) => p.kind !== 'none' && p.kind !== 'refused');
        if (!selectable.length) {
            Print.info('Nothing to remove.');
            return;
        }

        const approved = argv.yes
            ? selectable.filter((p) => argv.all || p.default)
            : await promptPlan(selectable);

        if (!approved.length) {
            Print.info('Nothing selected; nothing was removed.');
            return;
        }

        const results = await BakerObj.applyRemoval(approved, argv.verbose);
        await recordRun({
            plan, approved, results, source: argv.source || '.',
            provider: providerLabel(provider), root
        });
        summarize(results, plan, approved);
    } catch (err) {
        Print.error(err);
        process.exitCode = 1;
    }
};

// Split out so tests can drive the command without a real provider.
async function chooseProvider(bakePath) {
    return Baker.chooseProvider(bakePath);
}

function describe(operation) {
    switch (operation.kind) {
        case 'paths':
            return operation.paths.length === 1
                ? operation.paths[0]
                : `${operation.paths.length} paths`;
        case 'block':
            return `baker block in ${operation.file}`;
        case 'repo':
            return `${operation.path} (cloned repository)`;
        case 'exec':
            return operation.summary || operation.command;
        case 'refused':
            // Refused entries name a concrete target; repeating the bakelet
            // label here would print it twice.
            return operation.path || operation.file || '';
        default:
            return operation.bakelet;
    }
}

function render(plan, bakePath, root) {
    const willRemove = plan.filter((p) => p.kind !== 'none' && p.kind !== 'refused' && p.default);
    const willAsk = plan.filter((p) => p.kind !== 'none' && p.kind !== 'refused' && !p.default);
    const none = plan.filter((p) => p.kind === 'none');
    const refused = plan.filter((p) => p.kind === 'refused');

    // Stated on every run rather than left to the docs: per-unit configs change
    // often, so removing "what the config describes now" is a live limitation
    // rather than a rare one.
    if (plan.some((p) => p.bakelet && String(p.bakelet).startsWith('files'))) {
        console.log(chalk.dim(
            `\n  Note: cleanup removes what this config describes now. If the config has\n` +
            `  changed since you baked, files from the older version remain in:\n` +
            `    ${root}\n`
        ));
    }

    const group = (title, items, colour) => {
        if (!items.length) return;
        console.log(colour(`\n${title}`));
        items.forEach((p) => {
            const reason = p.reason ? chalk.dim(`  — ${p.reason}`) : '';
            console.log(`  ${String(p.bakelet).padEnd(22)} ${describe(p)}${reason}`);
        });
    };

    group('will remove', willRemove, chalk.green);
    group('will ask', willAsk, chalk.yellow);
    group('refused (a guard blocks this)', refused, chalk.red);
    group('no inverse available', none, chalk.dim);
    console.log('');
}

// One checkbox per selectable operation, pre-set to its default. Defaults
// encode a risk gradient: things Baker created in a scope Baker owns are on;
// things shared with the rest of the machine are off.
async function promptPlan(selectable) {
    const answers = await inquirer.prompt([{
        type: 'checkbox',
        name: 'selected',
        message: 'Select what to remove:',
        pageSize: 20,
        choices: selectable.map((operation, index) => ({
            name: `${String(operation.bakelet).padEnd(22)} ${describe(operation)}` +
                (operation.prompt ? chalk.dim(`\n      ${operation.prompt}`) : ''),
            value: index,
            checked: Boolean(operation.default)
        }))
    }]);
    return (answers.selected || []).map((index) => selectable[index]);
}

// The provider TYPE, not the environment name — the log answers "which
// transport did this run act through".
function providerLabel(provider) {
    if (!provider) return 'unknown';
    return provider.constructor.name
        .replace(/Provider$/, '')
        .replace(/([a-z])([A-Z])/g, '$1-$2')
        .toLowerCase();
}

async function recordRun({ plan, approved, results, source, provider, root }) {
    const approvedSet = new Set(approved);
    const items = [];

    results.forEach(({ operation, status, error }) => {
        items.push({
            operation,
            disposition: status === 'removed' ? 'REMOVED' : 'FAILED',
            detail: error ? error.message : ''
        });
    });
    plan.filter((p) => p.kind === 'refused').forEach((operation) => {
        items.push({ operation, disposition: 'REFUSED', detail: operation.reason });
    });
    plan.filter((p) => p.kind !== 'none' && p.kind !== 'refused' && !approvedSet.has(p))
        .forEach((operation) => {
            items.push({ operation, disposition: 'KEPT', detail: 'declined at prompt' });
        });

    await CleanupLog.append({ source, provider, root, items });
}

function summarize(results, plan, approved) {
    const removed = results.filter((r) => r.status === 'removed').length;
    const failed = results.filter((r) => r.status === 'failed');
    const refused = plan.filter((p) => p.kind === 'refused').length;
    const kept = plan.filter((p) => p.kind !== 'none' && p.kind !== 'refused').length - approved.length;

    console.log(chalk.green(`\nRemoved ${removed} item(s).`) +
        (kept ? chalk.dim(` Kept ${kept}.`) : '') +
        (refused ? chalk.red(` Refused ${refused}.`) : ''));
    failed.forEach((f) => console.log(chalk.red(`  failed: ${f.error.message}`)));
    console.log(chalk.dim(`Recorded in ${CleanupLog.logPath()}`));
}

// Exported for tests, which drive these without a provider or a TTY.
exports._internal = { render, describe, promptPlan, recordRun, summarize, providerLabel };
