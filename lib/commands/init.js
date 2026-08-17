const chalk    = require('chalk');
const fs       = require('fs-extra');
const inquirer = require('inquirer');
const path     = require('path');

const Print = require('../modules/print');
const { detect, proposedTools } = require('../modules/init/detect');
const { offerable, divergentPackage } = require('../modules/init/offer');
const { render, splitList } = require('../modules/init/render');

exports.command = 'init';
exports.desc = 'Write a starter baker.yml for this directory';

exports.builder = (yargs) => {
    yargs.example(`$0 init`, `Answer a few questions and write a baker.yml here`);
};

// `baker init` is an AUTHORING tool, not a student tool. The instructor runs it
// once per assignment, in the assignment repo, and commits the result; students
// clone and run `baker bake`. That inverts the usual quality bar — the file this
// writes executes on every student's machine, so init's real job is producing a
// config that survives a mixed room of Windows, macOS, and Linux laptops
// without sudo. Hence the warnings before the write rather than after.
//
// The orchestration below is hand-verified; every decision it makes lives in
// lib/modules/init/ and is unit tested. Same split run.js draws between what a
// command decides and what it does.
// Added by Claude Code (claude-opus-5[1m])
exports.handler = async function (argv) {
    try {
        // `argv.ask` is never set by yargs; it exists so a test can reach the
        // catch arm below. An unhandled throw here would surface as a raw stack
        // trace to an instructor, which is the one thing Print.error prevents.
        await runInit(process.cwd(), (argv || {}).ask);
    } catch (err) {
        Print.error(err);
    }
};

// `ask` is injected, defaulting to the real inquirer-backed prompts — the same
// seam platform.detect() and Git.resolveRef use. It is what makes the refusal
// and the two abort paths testable WITHOUT testing inquirer: the spec marked
// those manual to avoid driving a TTY, but the logic around the prompts is
// exactly where the old implementation failed silently, so it is worth a test.
// Added by Claude Code (claude-opus-5[1m])
async function runInit(cwd, ask = prompts) {
    const destination = path.join(cwd, 'baker.yml');

    // Refuse rather than overwrite. The old implementation rejected a promise
    // into a spinner and swallowed it with a bare `catch { return; }`, so this
    // path failed silently — the instructor saw nothing and the file survived
    // by accident rather than by decision.
    if (await fs.pathExists(destination)) {
        Print.error(
            `A baker.yml already exists here (${destination}).\n` +
            `\`init\` writes a new config and will not edit an existing one. ` +
            `Remove or rename it first, then re-run.`
        );
        return;
    }

    const name = await ask.input('Environment name', path.basename(cwd), required('an environment name'));
    const target = await ask.target();

    const findings = await detect(cwd);
    if (findings.length) {
        Print.info(`Detected: ${findings.map((f) => f.why).join(', ')}`);
    }

    const offered = offerable(target);
    const tools = await ask.tools(offered, proposedTools(findings));

    // Required-argument bakelets ask their follow-up. Without this the config
    // parses and then throws at bake time on the student's machine.
    const toolArgs = {};
    for (const offer of toolsNeedingArg(offered, tools)) {
        toolArgs[offer.name] = await ask.input(
            `${offer.name} requires '${offer.needsArg}' (${offer.argHint})`,
            undefined, required(`a value for '${offer.needsArg}'`));
    }

    // Conflict → confirm, don't block. An instructor may know their cohort is
    // Linux-only. Defaults to No because the common case is that they do not.
    for (const offer of conflictingTools(offered, tools, target)) {
        Print.warning(`${offer.name}: ${offer.warning}`);
        const proceed = await ask.confirm(
            `Keep ${offer.name} anyway? Students run this on their own machines.`, false);
        if (!proceed) {
            Print.info('Nothing written.');
            return;
        }
    }

    const packages = splitList(
        await ask.input('System packages, comma separated (blank to skip)', ''));

    // apt-only spellings are the likeliest way init ships an assignment that
    // breaks for part of a class — an instructor on Ubuntu types what works on
    // their own laptop.
    for (const advice of divergentPackages(packages)) {
        Print.warning(advice.detail +
            (advice.suggest ? `\n    Consider ${advice.suggest} instead — Baker maps it per manager.` : ''));
        const keep = await ask.confirm(`Keep '${advice.name}' anyway?`, false);
        if (!keep) {
            Print.info('Nothing written.');
            return;
        }
    }

    const materials = await ask.input(
        'Directory holding student materials (blank to skip)', '');
    if (materials && !await fs.pathExists(path.resolve(cwd, materials))) {
        // Warn but continue: the instructor may scaffold in whichever order
        // they prefer, and refusing here would force an empty directory first.
        Print.warning(`${materials} does not exist yet — bake will fail until it does.`);
    }
    const prune = materials
        ? await ask.confirm('Remove files a previous unit placed that this one does not?', true)
        : false;

    const remote = target === 'remote' ? await ask.remote() : {};

    await fs.writeFile(destination,
        render(Object.assign({ name, target, tools, toolArgs, packages, materials, prune }, remote)),
        'utf8');

    Print.success(`Wrote baker.yml — commit it, and students run 'baker bake'.`);
}

// ── decisions, pure and exported ──────────────────────────────────────────────

// Offers for the selected tools that require a follow-up value.
function toolsNeedingArg(offered, selected) {
    return offered.filter((o) => selected.includes(o.name) && o.needsArg);
}

// Selected tools whose Linux/sudo requirement conflicts with the chosen target.
// `warning` is already target-aware, so this needs no second target check —
// which is what keeps the two from disagreeing.
function conflictingTools(offered, selected, target) {
    return offered.filter((o) => selected.includes(o.name) && o.warning);
}

// Advice for every package name Baker has something to say about.
function divergentPackages(packages) {
    return packages.map(divergentPackage).filter(Boolean);
}

// ── prompts ───────────────────────────────────────────────────────────────────
//
// Each takes its prompt runner as an optional argument, defaulting to the real
// inquirer. That is the same seam used throughout Baker (platform.detect's exec
// function, Git.resolveRef's raw), and here it earns its keep twice: the
// question objects become assertable — AC-3 is a claim about what the provider
// list SAYS and in what order, which is otherwise only checkable by eye — and no
// test has to drive or stub a TTY to reach them.

function required(what) {
    return (value) => (String(value || '').trim() ? true : `Please enter ${what}.`);
}

async function askInput(message, fallback, validate, prompt = inquirer.prompt) {
    const answer = await prompt([{
        type: 'input', name: 'value', message: `${message}:`, default: fallback, validate
    }]);
    return String(answer.value === undefined ? '' : answer.value).trim();
}

async function askConfirm(message, fallback, prompt = inquirer.prompt) {
    const answer = await prompt([{
        type: 'confirm', name: 'value', message, default: fallback
    }]);
    return answer.value;
}

// The provider key is the one thing init writes that binds a decision for
// people not in the room: chooseProvider reads it from the committed file and
// there is no student-side override today. So the prompt states what each
// target MEANS for a class rather than presenting three equal options — but all
// three stay selectable, because an instructor may be authoring for their own
// testing or for a study on a controlled VM.
async function askTarget(prompt = inquirer.prompt) {
    const answer = await prompt([{
        type: 'list', name: 'value', message: 'Where will this run?', default: 'local',
        choices: [
            { value: 'local', name:
                `this machine (local) — each student's own laptop; the normal choice for an assignment` },
            { value: 'docker', name:
                `a container (docker) — note: files: lands inside the container, not in the student's repo` },
            { value: 'remote', name:
                `a server over SSH (remote) — one fixed host and key; cannot serve a class from one committed file` }
        ]
    }]);
    return answer.value;
}

// Detection supplies DEFAULTS; the checkbox is the decision point, so a wrong
// guess costs one keystroke and is always visible before it ships.
async function askTools(offered, checked, prompt = inquirer.prompt) {
    const answer = await prompt([{
        type: 'checkbox', name: 'value', message: 'Tools to install:', pageSize: 20,
        choices: offered.map((o) => ({
            value: o.name,
            checked: checked.includes(o.name),
            name: o.name + (o.warning ? chalk.yellow(`  (${o.warning})`) : '') +
                            (o.needsArg ? chalk.dim(`  (asks for '${o.needsArg}')`) : '')
        }))
    }]);
    return answer.value || [];
}

// All three fields are required: a partial remote: block fails
// validateBakerYML at bake time, far from the prompt that caused it.
async function askRemote(prompt = inquirer.prompt) {
    return {
        user: await askInput('Remote user', undefined, required('the SSH user'), prompt),
        ip: await askInput('Remote host or IP', undefined, required('a host or IP'), prompt),
        privateKey: await askInput('Private key path', '~/.ssh/id_rsa', required('a private key path'), prompt)
    };
}

// The real prompt set, and the default for runInit's `ask`. Bundled as one
// object so a test substitutes the whole layer at a single seam rather than
// stubbing inquirer, which would leak into every other suite the way the
// child_process.spawn replacement in test-check-command.js once did.
const prompts = {
    input: askInput,
    confirm: askConfirm,
    target: askTarget,
    tools: askTools,
    remote: askRemote
};

module.exports.runInit = runInit;
module.exports.prompts = prompts;
module.exports.askInput = askInput;
module.exports.askConfirm = askConfirm;
module.exports.askTarget = askTarget;
module.exports.askTools = askTools;
module.exports.askRemote = askRemote;
module.exports.toolsNeedingArg = toolsNeedingArg;
module.exports.conflictingTools = conflictingTools;
module.exports.divergentPackages = divergentPackages;
module.exports.required = required;
