const fs   = require('fs');
const os   = require('os');
const path = require('path');
const yaml = require('js-yaml');
const chai = require('chai');
const expect = chai.expect;

const { detect, proposedTools, SIGNALS } = require('../../lib/modules/init/detect');
const { offerable, toolBakeletNames, divergentPackage,
        BASE_CLASSES, NEEDS_ARG, NO_ARG } = require('../../lib/modules/init/offer');
const { render, splitList } = require('../../lib/modules/init/render');
const Baker = require('../../lib/modules/baker');

// A stand-in for fs-extra that reports exactly the paths it was told about.
// This is the seam that makes every detection case reachable with no fixture
// repo on disk, mirroring platform.detect() taking its exec function.
function fakeFs(present) {
    const set = new Set(present.map((p) => path.normalize(p)));
    return { pathExists: async (p) => set.has(path.normalize(p)) };
}

describe('baker init — detection (layer 1)', function() {
    const REPO = '/repo';

    // AC-5: pure and injectable — every signal exercised without a fixture repo.
    it('finds nothing in an empty repo', async function() {
        expect(await detect(REPO, fakeFs([]))).to.deep.equal([]);
    });

    // AC-4: proposes the portable equivalent, never the Ansible-tier one.
    it('proposes tools: maven for a pom.xml, never lang: java', async function() {
        const found = await detect(REPO, fakeFs([`${REPO}/pom.xml`]));
        expect(proposedTools(found)).to.deep.equal(['maven']);
        expect(JSON.stringify(found)).to.not.contain('java');
    });

    it('proposes tools: node for a package.json, never lang: nodejs', async function() {
        const found = await detect(REPO, fakeFs([`${REPO}/package.json`]));
        expect(proposedTools(found)).to.deep.equal(['node']);
        expect(JSON.stringify(found)).to.not.contain('nodejs');
    });

    it('proposes claude-code for a CLAUDE.md', async function() {
        const found = await detect(REPO, fakeFs([`${REPO}/CLAUDE.md`]));
        expect(proposedTools(found)).to.deep.equal(['claude-code']);
    });

    it('proposes claude-code for a .claude directory', async function() {
        const found = await detect(REPO, fakeFs([`${REPO}/.claude`]));
        expect(proposedTools(found)).to.deep.equal(['claude-code']);
    });

    it('reports claude-code once when both markers are present', async function() {
        const found = await detect(REPO, fakeFs([`${REPO}/CLAUDE.md`, `${REPO}/.claude`]));
        expect(found).to.have.lengthOf(1);
        expect(proposedTools(found)).to.deep.equal(['claude-code']);
    });

    it('reports every distinct finding in a polyglot repo', async function() {
        const found = await detect(REPO, fakeFs([
            `${REPO}/pom.xml`, `${REPO}/package.json`, `${REPO}/CLAUDE.md`
        ]));
        expect(proposedTools(found)).to.deep.equal(['maven', 'node', 'claude-code']);
        expect(found.map((f) => f.why)).to.deep.equal(
            ['Maven project', 'Node project', 'Claude Code config']);
    });

    it('looks under the directory it was given, not the cwd', async function() {
        // A marker in cwd must not be found when detecting elsewhere.
        expect(await detect('/elsewhere', fakeFs([`${REPO}/pom.xml`]))).to.deep.equal([]);
    });

    it('never proposes an Ansible-tier bakelet from any signal', async function() {
        // The load-bearing property: detection cannot hand an instructor a
        // config that fails for every student not on Linux with sudo. The
        // warning path in init.js is reachable only by manual selection.
        const linuxOnly = offerable('local').filter((o) => o.needsLinux).map((o) => o.name);
        const proposable = SIGNALS.reduce((all, s) => all.concat(s.tools), []);
        proposable.forEach((tool) => {
            expect(linuxOnly, `${tool} is proposed by detection`).to.not.contain(tool);
        });
    });

    it('uses exact paths, never globs', async function() {
        SIGNALS.forEach((s) => {
            expect(s.marker, `${s.marker} looks like a glob`).to.not.match(/[*?[\]]/);
        });
    });

    it('defaults its accessor to the real fs, so the caller need not pass one', async function() {
        // Run against this repo, which has both a package.json and a CLAUDE.md.
        const found = await detect(path.join(__dirname, '..', '..'));
        expect(proposedTools(found)).to.contain('node');
    });
});

describe('baker init — offering (layer 2)', function() {
    // AC-6: generated from the directory, not hardcoded.
    it('lists every bakelet in lib/bakelets/tools', function() {
        const onDisk = fs.readdirSync(path.join(__dirname, '..', '..', 'lib', 'bakelets', 'tools'))
            .filter((f) => f.endsWith('.js'))
            .map((f) => f.replace(/\.js$/, ''))
            .filter((n) => !BASE_CLASSES.includes(n))
            .sort();
        expect(toolBakeletNames()).to.deep.equal(onDisk);
    });

    it('would pick up a new bakelet with no edit to init', function() {
        // Asserted structurally: the list comes from readdirSync of the tools
        // directory, so it cannot drift from disk the way the old hardcoded
        // java8 / nodejs9 / python2 list did.
        const names = toolBakeletNames();
        expect(names).to.contain('maven');
        expect(names).to.contain('opunit');
        expect(names.length).to.be.greaterThan(10);
    });

    it('excludes the two base classes', function() {
        expect(toolBakeletNames()).to.not.contain('agentic-tool');
        expect(toolBakeletNames()).to.not.contain('package-tool');
    });

    // AC-7: every offered bakelet is actually offerable.
    it('classifies every offered bakelet as either needing an argument or not', function() {
        // The guard. A new bakelet lands in neither table and fails here, rather
        // than reaching an instructor and failing at bake time on a student's
        // machine. This is what caught `pip`, which the spec's table omitted.
        const unclassified = toolBakeletNames()
            .filter((n) => !NEEDS_ARG[n] && !NO_ARG.includes(n));
        expect(unclassified,
            `unclassified bakelet(s): add to NEEDS_ARG or NO_ARG in lib/modules/init/offer.js`)
            .to.deep.equal([]);
    });

    it('gives every argument-taking bakelet a field and a hint for its prompt', function() {
        Object.keys(NEEDS_ARG).forEach((name) => {
            expect(NEEDS_ARG[name].field, `${name} has no field`).to.be.a('string').and.not.empty;
            expect(NEEDS_ARG[name].hint, `${name} has no hint`).to.be.a('string').and.not.empty;
        });
    });

    it('does not classify a bakelet as both needing and not needing an argument', function() {
        Object.keys(NEEDS_ARG).forEach((name) => {
            expect(NO_ARG, `${name} is in both tables`).to.not.contain(name);
        });
    });

    it('lists no name in NO_ARG that is not a real bakelet', function() {
        const real = toolBakeletNames();
        NO_ARG.forEach((n) => expect(real, `${n} is not a bakelet`).to.contain(n));
        Object.keys(NEEDS_ARG).forEach((n) => expect(real, `${n} is not a bakelet`).to.contain(n));
    });

    it('surfaces the required field on the offer itself', function() {
        const offers = offerable('local');
        const byName = (n) => offers.find((o) => o.name === n);
        expect(byName('baker').needsArg).to.equal('source');
        expect(byName('docker-extension').needsArg).to.equal('address');
        expect(byName('pip').needsArg).to.equal('packages');
        expect(byName('maven').needsArg).to.equal(null);
    });

    // AC-8: Ansible-tier tools are offered but flagged.
    it('warns on every Linux-only tool under local:', function() {
        const linuxOnly = offerable('local').filter((o) => o.needsLinux);
        expect(linuxOnly.map((o) => o.name)).to.deep.equal(['dazed', 'defects4j', 'jekyll']);
        linuxOnly.forEach((o) => {
            expect(o.warning, `${o.name} carries no warning`).to.contain('Linux only');
            expect(o.warning).to.contain('sudo');
        });
    });

    it('warns on every Linux-only tool under docker: too', function() {
        offerable('docker').filter((o) => o.needsLinux).forEach((o) => {
            expect(o.warning, `${o.name} carries no warning`).to.be.a('string');
        });
    });

    it('drops the warning under remote:, where the instructor controls the OS', function() {
        offerable('remote').forEach((o) => expect(o.warning).to.equal(null));
    });

    it('never warns about a portable-tier tool', function() {
        offerable('local').filter((o) => !o.needsLinux)
            .forEach((o) => expect(o.warning, `${o.name} warns unnecessarily`).to.equal(null));
    });

    it('reads requiresAnsible from the same flag the pre-flight gate uses', function() {
        // Not a second list: offerable reads the bakelet class, so init and the
        // bake gate cannot disagree about which tools are Linux-only.
        const Jekyll = require('../../lib/bakelets/tools/jekyll');
        const Maven  = require('../../lib/bakelets/tools/maven');
        expect(Jekyll.prototype.requiresAnsible).to.equal(true);
        expect(Maven.prototype.requiresAnsible).to.equal(false);
    });

    // AC-10: divergent package names.
    describe('divergent package names', function() {
        it('flags a known apt-only spelling with the equivalents', function() {
            const advice = divergentPackage('build-essential');
            expect(advice.detail).to.contain('Debian/Ubuntu');
            expect(advice.detail).to.contain('base-devel');
            expect(advice.suggest).to.contain('cpp');
        });

        it('flags python3-dev and points at the python bakelet', function() {
            const advice = divergentPackage('python3-dev');
            expect(advice.detail).to.contain('python3-devel');
            expect(advice.suggest).to.contain('python');
        });

        it('flags an unlisted -dev name by its suffix', function() {
            // A name list alone would rot; the Debian -dev convention generalises.
            const advice = divergentPackage('libpq-dev');
            expect(advice).to.not.equal(null);
            expect(advice.detail).to.contain('-devel');
            expect(advice.suggest).to.equal(null);
        });

        it('says nothing about a name that works everywhere', function() {
            expect(divergentPackage('git')).to.equal(null);
            expect(divergentPackage('curl')).to.equal(null);
        });

        it('names the package in its own advice', function() {
            expect(divergentPackage('libssl-dev').detail).to.contain('libssl-dev');
        });
    });
});

describe('baker init — render (layer 3)', function() {
    // Writes a rendered config to a temp dir and runs it through the REAL
    // chooseProvider, which is the protection against the failure that motivated
    // this feature: init writing a config bake rejects.
    async function chooseFor(answers) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baker-init-'));
        try {
            fs.writeFileSync(path.join(dir, 'baker.yml'), render(answers), 'utf8');
            return await Baker.chooseProvider(dir);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }

    const LOCAL  = { name: 'unit-1', target: 'local' };
    const DOCKER = { name: 'unit-1', target: 'docker' };
    const REMOTE = { name: 'unit-1', target: 'remote',
                     user: 'student', ip: '10.0.0.5', privateKey: '~/.ssh/id_rsa' };

    // AC-13: provenance.
    it('opens with the provenance header and a reference pointer', function() {
        const out = render(LOCAL);
        expect(out.startsWith('# Generated by baker init. Edit freely.\n')).to.equal(true);
        expect(out).to.contain('# Reference: docs/baker-yml-reference.md');
    });

    it('carries no version number that would go stale in diffs', function() {
        expect(render(LOCAL).split('\n')[0]).to.not.match(/\d+\.\d+/);
        expect(render(LOCAL).split('\n')[1]).to.not.match(/\d+\.\d+\.\d+/);
    });

    // AC-2: no retired key can be emitted.
    it('never emits a retired provider key, for any answers', function() {
        const everything = {
            name: 'unit-1', target: 'local',
            tools: ['maven', 'node', 'pip', 'baker', 'docker-extension', 'jekyll'],
            toolArgs: { pip: 'pytest, jsonschema', baker: 'your-org/Baker',
                        'docker-extension': 'dockersamples/labspace-extension' },
            packages: ['git', 'curl'],
            materials: './materials', prune: true
        };
        [LOCAL, DOCKER, REMOTE, everything].forEach((answers) => {
            const doc = yaml.safeLoad(render(answers));
            ['vm', 'vagrant', 'container', 'persistent'].forEach((key) => {
                expect(doc, `${key} was emitted`).to.not.have.property(key);
            });
        });
    });

    // AC-1: generated configs are bakeable, through the real chooseProvider.
    describe('AC-1: every generated config is accepted by the real chooseProvider', function() {
        it('accepts a local: config', async function() {
            const { provider, envName } = await chooseFor(LOCAL);
            expect(provider.constructor.name).to.equal('LocalProvider');
            expect(envName).to.equal('unit-1');
        });

        it('accepts a docker: config', async function() {
            const { provider } = await chooseFor(DOCKER);
            expect(provider.constructor.name).to.equal('DockerLocalProvider');
        });

        it('accepts a remote: config', async function() {
            const { provider } = await chooseFor(REMOTE);
            expect(provider.constructor.name).to.equal('RemoteProvider');
        });

        it('accepts a config with every section populated', async function() {
            const { provider } = await chooseFor({
                name: 'unit-1', target: 'local',
                tools: ['maven', 'pip'], toolArgs: { pip: 'pytest' },
                packages: ['git'], materials: './materials', prune: true
            });
            expect(provider.constructor.name).to.equal('LocalProvider');
        });

        it('accepts a minimal config with no tools, packages, or materials', async function() {
            const doc = yaml.safeLoad(render(LOCAL));
            expect(Object.keys(doc)).to.deep.equal(['name', 'local']);
            const { provider } = await chooseFor(LOCAL);
            expect(provider).to.be.an('object');
        });
    });

    describe('target keys', function() {
        it('writes local: . so the environment root is the repo', function() {
            expect(yaml.safeLoad(render(LOCAL)).local).to.equal('.');
        });

        it('writes a docker image, defaulting to ubuntu:latest', function() {
            expect(yaml.safeLoad(render(DOCKER)).docker).to.equal('ubuntu:latest');
        });

        it('honours an explicit docker image', function() {
            expect(yaml.safeLoad(render({ ...DOCKER, image: 'node:20' })).docker).to.equal('node:20');
        });

        it('writes all three remote fields, which validateBakerYML requires', function() {
            const remote = yaml.safeLoad(render(REMOTE)).remote;
            expect(remote).to.deep.equal({
                user: 'student', ip: '10.0.0.5', private_key: '~/.ssh/id_rsa'
            });
        });
    });

    describe('tools', function() {
        it('omits the section entirely when nothing is selected', function() {
            expect(yaml.safeLoad(render(LOCAL))).to.not.have.property('tools');
        });

        it('writes a bare name for a tool needing no argument', function() {
            expect(yaml.safeLoad(render({ ...LOCAL, tools: ['maven', 'node'] })).tools)
                .to.deep.equal(['maven', 'node']);
        });

        it('writes a mapping for a tool that requires a field', function() {
            const doc = yaml.safeLoad(render({
                ...LOCAL, tools: ['baker'], toolArgs: { baker: 'your-org/Baker' }
            }));
            expect(doc.tools).to.deep.equal([{ baker: 'your-org/Baker' }]);
        });

        it('writes pip as a packages list, which is the shape pip reads', function() {
            const doc = yaml.safeLoad(render({
                ...LOCAL, tools: ['pip'], toolArgs: { pip: 'pytest, jsonschema' }
            }));
            expect(doc.tools).to.deep.equal([{ pip: { packages: ['pytest', 'jsonschema'] } }]);
        });

        it('preserves the order tools were selected in', function() {
            // tools: entries run top to bottom, so `python` before `pip` is what
            // guarantees the interpreter exists first.
            const doc = yaml.safeLoad(render({
                ...LOCAL, tools: ['python', 'pip'], toolArgs: { pip: 'pytest' }
            }));
            expect(doc.tools[0]).to.equal('python');
            expect(doc.tools[1]).to.have.property('pip');
        });
    });

    describe('packages', function() {
        it('omits the section when none are given', function() {
            expect(yaml.safeLoad(render(LOCAL))).to.not.have.property('packages');
        });

        it('writes a bare list of names', function() {
            expect(yaml.safeLoad(render({ ...LOCAL, packages: ['git', 'curl'] })).packages)
                .to.deep.equal(['git', 'curl']);
        });

        it('drops empty entries rather than emitting a null', function() {
            expect(yaml.safeLoad(render({ ...LOCAL, packages: ['git', '', null] })).packages)
                .to.deep.equal(['git']);
        });
    });

    // AC-12: student materials produce a pruning files: block.
    describe('AC-12: student materials', function() {
        it('emits config: - files: with the source, dest ., and prune: true', function() {
            const doc = yaml.safeLoad(render({ ...LOCAL, materials: './materials', prune: true }));
            expect(doc.config).to.deep.equal([
                { files: [{ src: './materials', dest: '.' }], prune: true }
            ]);
        });

        it('omits prune when the instructor declines it', function() {
            const doc = yaml.safeLoad(render({ ...LOCAL, materials: './materials', prune: false }));
            expect(doc.config[0]).to.not.have.property('prune');
            expect(doc.config[0].files[0].src).to.equal('./materials');
        });

        it('omits the config section entirely when no materials are given', function() {
            expect(yaml.safeLoad(render(LOCAL))).to.not.have.property('config');
        });

        it('puts prune beside files, not inside the list', function() {
            // The shape matters: `prune` is a sibling of `files:`, and nesting it
            // inside an entry would be silently ignored at bake time.
            const doc = yaml.safeLoad(render({ ...LOCAL, materials: './m', prune: true }));
            expect(doc.config[0].prune).to.equal(true);
            expect(doc.config[0].files[0]).to.not.have.property('prune');
        });
    });

    describe('YAML safety', function() {
        it('round-trips a name containing a colon', function() {
            const doc = yaml.safeLoad(render({ ...LOCAL, name: 'my: repo' }));
            expect(doc.name).to.equal('my: repo');
        });

        it('round-trips a name containing a hash', function() {
            expect(yaml.safeLoad(render({ ...LOCAL, name: '#1' })).name).to.equal('#1');
        });

        it('round-trips a name that looks like a number', function() {
            expect(yaml.safeLoad(render({ ...LOCAL, name: '1.0' })).name).to.equal('1.0');
        });

        it('round-trips a name that looks like a boolean', function() {
            expect(yaml.safeLoad(render({ ...LOCAL, name: 'no' })).name).to.equal('no');
        });

        it('round-trips a materials path containing a space', function() {
            const doc = yaml.safeLoad(render({ ...LOCAL, materials: './unit 1/', prune: true }));
            expect(doc.config[0].files[0].src).to.equal('./unit 1/');
        });

        it('does not fold a long value across lines', function() {
            const long = './' + 'a'.repeat(200);
            const out = render({ ...LOCAL, materials: long, prune: true });
            expect(out).to.contain(long);
            expect(yaml.safeLoad(out).config[0].files[0].src).to.equal(long);
        });

        it('refuses an unknown target rather than silently writing local:', function() {
            // A fourth target added without updating render would otherwise emit
            // `local: .` and the instructor would ship a config provisioning the
            // wrong place — the silent-substitution class this repo guards against.
            expect(() => render({ name: 'x', target: 'vm' })).to.throw(/Unknown target 'vm'/);
            expect(() => render({ name: 'x', target: undefined })).to.throw(/Unknown target/);
        });

        it('names the three valid targets in that error', function() {
            let msg = '';
            try { render({ name: 'x', target: 'vagrant' }); } catch (e) { msg = e.message; }
            expect(msg).to.contain('local');
            expect(msg).to.contain('docker');
            expect(msg).to.contain('remote');
        });

        it('produces parseable YAML for every target', function() {
            [LOCAL, DOCKER, REMOTE].forEach((a) => {
                expect(() => yaml.safeLoad(render(a))).to.not.throw();
            });
        });
    });

    describe('splitList', function() {
        it('splits and trims a comma separated string', function() {
            expect(splitList(' a , b ,c ')).to.deep.equal(['a', 'b', 'c']);
        });

        it('drops empty entries', function() {
            expect(splitList('a,,b,')).to.deep.equal(['a', 'b']);
        });

        it('returns an empty list for a blank string', function() {
            expect(splitList('')).to.deep.equal([]);
        });

        it('returns an empty list for an absent answer, not ["undefined"]', function() {
            // String(undefined) is 'undefined', which would otherwise be handed
            // to a package manager as a package name.
            expect(splitList(undefined)).to.deep.equal([]);
            expect(splitList(null)).to.deep.equal([]);
        });
    });

    describe('required answers', function() {
        it('refuses a missing environment name by name', function() {
            // js-yaml's own failure is `unacceptable kind of an object to dump
            // [object Undefined]`, which names neither the field nor the caller.
            expect(() => render({ target: 'local' })).to.throw(/environment name is required/);
        });

        it('refuses an empty or whitespace name', function() {
            expect(() => render({ name: '', target: 'local' })).to.throw(/environment name/);
            expect(() => render({ name: '   ', target: 'local' })).to.throw(/environment name/);
        });

        it('refuses a remote block missing every field, naming all three', function() {
            let msg = '';
            try { render({ name: 'x', target: 'remote' }); } catch (e) { msg = e.message; }
            expect(msg).to.contain('user');
            expect(msg).to.contain('ip');
            expect(msg).to.contain('private_key');
        });

        it('names only the field that is actually missing', function() {
            let msg = '';
            try {
                render({ name: 'x', target: 'remote', user: 'u', ip: '10.0.0.1' });
            } catch (e) { msg = e.message; }
            expect(msg).to.contain('private_key');
            expect(msg).to.not.match(/needs user/);
        });

        it('refuses a blank remote field, not just an absent one', function() {
            expect(() => render({
                name: 'x', target: 'remote', user: 'u', ip: '10.0.0.1', privateKey: '   '
            })).to.throw(/private_key/);
        });

        it('is the only thing standing between a partial remote: and a crash', async function() {
            // Why the guard above cannot be deleted on the belief that something
            // downstream catches a partial block. chooseProvider calls
            // validateBakerYML WITHOUT await, and it is async — so it always
            // returns a truthy promise and the intended
            // "invalid baker.yml for remote provider" + exit(1) is dead code.
            //
            // What actually happens is worse than acceptance: construction
            // reaches path.resolve(undefined) inside RemoteProvider and throws a
            // raw TypeError with a Node stack trace. Documented here so the
            // behaviour is known rather than rediscovered.
            const RemoteProvider = require('../../lib/modules/providers/remote');
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baker-partial-'));
            try {
                fs.writeFileSync(path.join(dir, 'baker.yml'), 'name: x\nremote:\n  user: u\n');

                expect(await RemoteProvider.validateBakerYML(dir),
                    'validateBakerYML itself does reject a partial block').to.equal(false);

                let err;
                try { await Baker.chooseProvider(dir); } catch (e) { err = e; }
                expect(err, 'chooseProvider does not await the validation').to.be.an('error');
                expect(err.message, 'and fails with a raw type error, not Baker\'s message')
                    .to.contain('must be of type string');
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });
    });
});

// The orchestration. The spec marked AC-9 and AC-11 manual to avoid driving a
// TTY — but the logic AROUND the prompts is exactly where the old
// implementation failed silently (it rejected a promise into a spinner and
// swallowed it with a bare `catch { return; }`). Injecting the prompt set makes
// that logic testable without testing inquirer itself.
describe('baker init — orchestration', function() {
    const init = require('../../lib/commands/init');
    let work, printed;

    // Print writes through console.log; capturing it is how the refusal message
    // is asserted. Restored in afterEach.
    let origLog;
    beforeEach(function() {
        work = fs.mkdtempSync(path.join(os.tmpdir(), 'baker-init-run-'));
        printed = [];
        origLog = console.log;
        console.log = (...args) => printed.push(args.join(' '));
    });
    afterEach(function() {
        console.log = origLog;
        fs.rmSync(work, { recursive: true, force: true });
    });

    // A prompt set that answers from a script instead of a terminal.
    function scriptedPrompts(overrides = {}) {
        return Object.assign({
            input: async (message, fallback) => (fallback === undefined ? '' : fallback),
            confirm: async (message, fallback) => fallback,
            target: async () => 'local',
            tools: async () => [],
            remote: async () => ({ user: 'u', ip: '10.0.0.1', privateKey: '~/.ssh/id_rsa' })
        }, overrides);
    }

    const output = () => printed.join('\n');

    it('writes a bakeable baker.yml with the default answers', async function() {
        await init.runInit(work, scriptedPrompts());
        const written = fs.readFileSync(path.join(work, 'baker.yml'), 'utf8');
        expect(written).to.contain('# Generated by baker init.');
        const { provider } = await Baker.chooseProvider(work);
        expect(provider.constructor.name).to.equal('LocalProvider');
    });

    it('names the environment after the directory by default', async function() {
        await init.runInit(work, scriptedPrompts());
        expect(yaml.safeLoad(fs.readFileSync(path.join(work, 'baker.yml'), 'utf8')).name)
            .to.equal(path.basename(work));
    });

    it('reports success naming the next step', async function() {
        await init.runInit(work, scriptedPrompts());
        expect(output()).to.contain('Wrote baker.yml');
        expect(output()).to.contain('baker bake');
    });

    // AC-11: an existing baker.yml is never overwritten.
    describe('AC-11: an existing baker.yml is never overwritten', function() {
        it('leaves the file byte-identical and writes nothing', async function() {
            const existing = 'name: mine\nlocal: .\n';
            fs.writeFileSync(path.join(work, 'baker.yml'), existing);

            await init.runInit(work, scriptedPrompts());

            expect(fs.readFileSync(path.join(work, 'baker.yml'), 'utf8')).to.equal(existing);
        });

        it('names the file in the message', async function() {
            fs.writeFileSync(path.join(work, 'baker.yml'), 'name: mine\n');
            await init.runInit(work, scriptedPrompts());
            expect(output()).to.contain('baker.yml');
            expect(output()).to.contain('already exists');
        });

        it('asks nothing at all before refusing', async function() {
            // The refusal must come first: prompting and then discarding the
            // answers would waste the instructor's time and read as a bug.
            fs.writeFileSync(path.join(work, 'baker.yml'), 'name: mine\n');
            let asked = 0;
            await init.runInit(work, scriptedPrompts({
                input: async (m, f) => { asked++; return f; },
                target: async () => { asked++; return 'local'; }
            }));
            expect(asked).to.equal(0);
        });
    });

    // AC-9: conflicting picks require confirmation.
    describe('AC-9: a declined conflict writes nothing', function() {
        it('does not write when an Ansible-tier pick is declined', async function() {
            await init.runInit(work, scriptedPrompts({
                tools: async () => ['jekyll'],
                confirm: async () => false
            }));
            expect(fs.existsSync(path.join(work, 'baker.yml'))).to.equal(false);
            expect(output()).to.contain('Nothing written');
        });

        it('warns with the Linux/sudo cost before asking', async function() {
            await init.runInit(work, scriptedPrompts({
                tools: async () => ['jekyll'], confirm: async () => false
            }));
            expect(output()).to.contain('Linux only');
            expect(output()).to.contain('sudo');
        });

        it('writes when the instructor accepts the conflict', async function() {
            await init.runInit(work, scriptedPrompts({
                tools: async () => ['jekyll'],
                confirm: async (message, fallback) =>
                    (message.includes('jekyll') ? true : fallback)
            }));
            expect(yaml.safeLoad(fs.readFileSync(path.join(work, 'baker.yml'), 'utf8')).tools)
                .to.deep.equal(['jekyll']);
        });

        it('does not confirm an Ansible-tier pick under remote:', async function() {
            // remote: is the one target whose OS the instructor controls.
            let confirms = [];
            await init.runInit(work, scriptedPrompts({
                target: async () => 'remote',
                tools: async () => ['jekyll'],
                confirm: async (m, f) => { confirms.push(m); return f; }
            }));
            expect(confirms.join(' ')).to.not.contain('jekyll');
            expect(fs.existsSync(path.join(work, 'baker.yml'))).to.equal(true);
        });
    });

    // AC-10: divergent package names are warned about, with confirmation.
    describe('AC-10: divergent package names', function() {
        it('does not write when a divergent package is declined', async function() {
            await init.runInit(work, scriptedPrompts({
                input: async (message, fallback) =>
                    (message.includes('System packages') ? 'build-essential' : fallback ?? ''),
                confirm: async () => false
            }));
            expect(fs.existsSync(path.join(work, 'baker.yml'))).to.equal(false);
        });

        it('shows the equivalents and the portable suggestion', async function() {
            await init.runInit(work, scriptedPrompts({
                input: async (message, fallback) =>
                    (message.includes('System packages') ? 'build-essential' : fallback ?? ''),
                confirm: async () => false
            }));
            expect(output()).to.contain('base-devel');
            expect(output()).to.contain('cpp');
        });

        it('writes the package when the instructor keeps it anyway', async function() {
            await init.runInit(work, scriptedPrompts({
                input: async (message, fallback) =>
                    (message.includes('System packages') ? 'build-essential' : fallback ?? ''),
                confirm: async (message, fallback) =>
                    (message.includes('build-essential') ? true : fallback)
            }));
            expect(yaml.safeLoad(fs.readFileSync(path.join(work, 'baker.yml'), 'utf8')).packages)
                .to.deep.equal(['build-essential']);
        });

        it('warns about an unlisted -dev name without inventing a suggestion', async function() {
            await init.runInit(work, scriptedPrompts({
                input: async (message, fallback) =>
                    (message.includes('System packages') ? 'libpq-dev' : fallback ?? ''),
                confirm: async (message, fallback) =>
                    (message.includes('libpq-dev') ? true : fallback)
            }));
            expect(output()).to.contain('-devel');
            expect(output()).to.not.contain('Consider tools:');
        });

        it('says nothing about a package that works everywhere', async function() {
            await init.runInit(work, scriptedPrompts({
                input: async (message, fallback) =>
                    (message.includes('System packages') ? 'git, curl' : fallback ?? '')
            }));
            expect(output()).to.not.contain('Debian/Ubuntu spelling');
            expect(yaml.safeLoad(fs.readFileSync(path.join(work, 'baker.yml'), 'utf8')).packages)
                .to.deep.equal(['git', 'curl']);
        });
    });

    it('asks for a required tool argument and writes it', async function() {
        await init.runInit(work, scriptedPrompts({
            tools: async () => ['pip'],
            input: async (message, fallback) =>
                (message.includes('pip requires') ? 'pytest, jsonschema' : fallback ?? '')
        }));
        expect(yaml.safeLoad(fs.readFileSync(path.join(work, 'baker.yml'), 'utf8')).tools)
            .to.deep.equal([{ pip: { packages: ['pytest', 'jsonschema'] } }]);
    });

    it('warns when the materials directory does not exist but still writes', async function() {
        await init.runInit(work, scriptedPrompts({
            input: async (message, fallback) =>
                (message.includes('student materials') ? './not-there' : fallback ?? '')
        }));
        expect(output()).to.contain('does not exist yet');
        expect(fs.existsSync(path.join(work, 'baker.yml'))).to.equal(true);
    });

    it('does not warn when the materials directory exists', async function() {
        fs.mkdirSync(path.join(work, 'materials'));
        await init.runInit(work, scriptedPrompts({
            input: async (message, fallback) =>
                (message.includes('student materials') ? './materials' : fallback ?? '')
        }));
        expect(output()).to.not.contain('does not exist yet');
    });

    it('collects all three remote fields when remote: is chosen', async function() {
        await init.runInit(work, scriptedPrompts({ target: async () => 'remote' }));
        const doc = yaml.safeLoad(fs.readFileSync(path.join(work, 'baker.yml'), 'utf8'));
        expect(doc.remote).to.deep.equal({
            user: 'u', ip: '10.0.0.1', private_key: '~/.ssh/id_rsa'
        });
    });

    it('reports the detected findings for the directory it runs in', async function() {
        fs.writeFileSync(path.join(work, 'pom.xml'), '<project/>');
        await init.runInit(work, scriptedPrompts());
        expect(output()).to.contain('Detected: Maven project');
    });

    it('pre-checks the detected tools rather than selecting them outright', async function() {
        fs.writeFileSync(path.join(work, 'pom.xml'), '<project/>');
        let offeredChecked = null;
        await init.runInit(work, scriptedPrompts({
            tools: async (offered, checked) => { offeredChecked = checked; return []; }
        }));
        expect(offeredChecked).to.deep.equal(['maven']);
        // Detection proposes; the instructor decides. Nothing selected means
        // nothing written.
        expect(yaml.safeLoad(fs.readFileSync(path.join(work, 'baker.yml'), 'utf8')))
            .to.not.have.property('tools');
    });

    describe('the CLI entry point', function() {
        it('registers as "init"', function() {
            expect(init.command).to.equal('init');
        });

        it('describes itself without calling itself broken', function() {
            expect(init.desc).to.be.a('string');
            expect(init.desc.toLowerCase()).to.not.contain('broken');
        });

        it('offers an example through the builder', function() {
            const examples = [];
            init.builder({ example: (cmd, desc) => examples.push([cmd, desc]) });
            expect(examples).to.have.lengthOf(1);
            expect(examples[0][0]).to.contain('init');
        });

        it('the handler tolerates being called with no argv', async function() {
            // yargs always passes one, but the handler must not depend on it.
            const existing = 'name: mine\nlocal: .\n';
            fs.writeFileSync(path.join(work, 'baker.yml'), existing);
            const origCwd = process.cwd();
            process.chdir(work);
            try {
                await init.handler();
            } finally {
                process.chdir(origCwd);
            }
            expect(output()).to.contain('already exists');
        });

        it('the handler prints a failure rather than throwing a stack trace', async function() {
            // An unhandled throw here would surface as a raw stack trace to an
            // instructor. Print.error is what stands between them and that.
            const origCwd = process.cwd();
            process.chdir(work);
            try {
                await init.handler({ ask: {
                    input: async () => { throw new Error('prompt exploded'); },
                    target: async () => 'local', tools: async () => [],
                    confirm: async () => false, remote: async () => ({})
                } });
            } finally {
                process.chdir(origCwd);
            }
            expect(output()).to.contain('prompt exploded');
            expect(fs.existsSync(path.join(work, 'baker.yml'))).to.equal(false);
        });

        it('the handler refuses an existing baker.yml without throwing', async function() {
            // Exercises the real entry point, which reads process.cwd(). Safe to
            // run for real because the refusal returns before any prompt.
            const existing = 'name: mine\nlocal: .\n';
            fs.writeFileSync(path.join(work, 'baker.yml'), existing);
            const origCwd = process.cwd();
            process.chdir(work);
            try {
                await init.handler({});
            } finally {
                process.chdir(origCwd);
            }
            expect(fs.readFileSync(path.join(work, 'baker.yml'), 'utf8')).to.equal(existing);
            expect(output()).to.contain('already exists');
        });
    });

    // The prompt definitions themselves. Driven through an injected runner, so
    // no TTY is involved and the question objects — which is what AC-3 is a
    // claim about — become assertable rather than eyeball-verified.
    describe('prompt definitions', function() {
        // Captures the questions and answers with whatever is scripted.
        function capture(answer) {
            const seen = [];
            const runner = async (questions) => {
                seen.push(questions[0]);
                return { value: answer };
            };
            return { seen, runner };
        }

        // AC-3: the provider prompt defaults to local: and states the trade-off.
        describe('AC-3: the provider prompt', function() {
            it('defaults to local and lists it first', async function() {
                const { seen, runner } = capture('local');
                await init.askTarget(runner);
                expect(seen[0].default).to.equal('local');
                expect(seen[0].choices[0].value).to.equal('local');
            });

            it('keeps all three targets selectable', async function() {
                const { seen, runner } = capture('local');
                await init.askTarget(runner);
                expect(seen[0].choices.map((c) => c.value)).to.deep.equal(['local', 'docker', 'remote']);
            });

            it('says docker places files inside the container', async function() {
                const { seen, runner } = capture('local');
                await init.askTarget(runner);
                const docker = seen[0].choices.find((c) => c.value === 'docker');
                expect(docker.name).to.contain('files:');
                expect(docker.name).to.contain('container');
            });

            it('says remote cannot serve a class from one committed file', async function() {
                const { seen, runner } = capture('local');
                await init.askTarget(runner);
                const remote = seen[0].choices.find((c) => c.value === 'remote');
                expect(remote.name).to.contain('cannot serve a class');
            });

            it('gives every option a consequence, not a bare name', async function() {
                const { seen, runner } = capture('local');
                await init.askTarget(runner);
                seen[0].choices.forEach((c) => {
                    expect(c.name.length, `${c.value} has no explanation`).to.be.greaterThan(40);
                });
            });

            it('returns the chosen value', async function() {
                const { runner } = capture('remote');
                expect(await init.askTarget(runner)).to.equal('remote');
            });
        });

        describe('the tools checkbox', function() {
            it('pre-checks exactly the detected tools', async function() {
                const { seen, runner } = capture([]);
                await init.askTools(offerable('local'), ['maven'], runner);
                const checked = seen[0].choices.filter((c) => c.checked).map((c) => c.value);
                expect(checked).to.deep.equal(['maven']);
            });

            it('annotates a Linux-only tool with its warning', async function() {
                const { seen, runner } = capture([]);
                await init.askTools(offerable('local'), [], runner);
                const jekyll = seen[0].choices.find((c) => c.value === 'jekyll');
                expect(jekyll.name).to.contain('Linux only');
            });

            it('annotates a tool that will ask for an argument', async function() {
                const { seen, runner } = capture([]);
                await init.askTools(offerable('local'), [], runner);
                const pip = seen[0].choices.find((c) => c.value === 'pip');
                expect(pip.name).to.contain('packages');
            });

            it('leaves a plain tool unannotated', async function() {
                const { seen, runner } = capture([]);
                await init.askTools(offerable('local'), [], runner);
                const maven = seen[0].choices.find((c) => c.value === 'maven');
                expect(maven.name.trim()).to.equal('maven');
            });

            it('returns an empty list when nothing is selected', async function() {
                const runner = async () => ({ value: undefined });
                expect(await init.askTools(offerable('local'), [], runner)).to.deep.equal([]);
            });

            it('returns the selected names', async function() {
                const runner = async () => ({ value: ['maven', 'node'] });
                expect(await init.askTools(offerable('local'), [], runner))
                    .to.deep.equal(['maven', 'node']);
            });
        });

        describe('the input prompt', function() {
            it('appends a colon and carries the default through', async function() {
                const { seen, runner } = capture('x');
                await init.askInput('Environment name', 'fallback', undefined, runner);
                expect(seen[0].message).to.equal('Environment name:');
                expect(seen[0].default).to.equal('fallback');
            });

            it('trims the answer', async function() {
                const runner = async () => ({ value: '  spaced  ' });
                expect(await init.askInput('m', undefined, undefined, runner)).to.equal('spaced');
            });

            it('returns an empty string when the answer is undefined', async function() {
                const runner = async () => ({ value: undefined });
                expect(await init.askInput('m', undefined, undefined, runner)).to.equal('');
            });

            it('passes the validator through to the prompt', async function() {
                const { seen, runner } = capture('x');
                const validate = init.required('a name');
                await init.askInput('m', undefined, validate, runner);
                expect(seen[0].validate).to.equal(validate);
            });
        });

        describe('the confirm prompt', function() {
            it('carries the default through', async function() {
                const { seen, runner } = capture(true);
                await init.askConfirm('Keep it?', false, runner);
                expect(seen[0].type).to.equal('confirm');
                expect(seen[0].default).to.equal(false);
                expect(seen[0].message).to.equal('Keep it?');
            });

            it('returns the answer', async function() {
                const runner = async () => ({ value: false });
                expect(await init.askConfirm('m', true, runner)).to.equal(false);
            });
        });

        describe('the remote prompts', function() {
            it('asks for all three fields, each required', async function() {
                const seen = [];
                const runner = async (questions) => {
                    seen.push(questions[0]);
                    return { value: 'answer' };
                };
                const remote = await init.askRemote(runner);

                expect(seen).to.have.lengthOf(3);
                expect(seen.map((q) => q.message)).to.deep.equal(
                    ['Remote user:', 'Remote host or IP:', 'Private key path:']);
                seen.forEach((q) => {
                    expect(q.validate('')).to.contain('Please enter');
                    expect(q.validate('x')).to.equal(true);
                });
                expect(remote).to.deep.equal(
                    { user: 'answer', ip: 'answer', privateKey: 'answer' });
            });

            it('defaults the key path to the documented location', async function() {
                const seen = [];
                const runner = async (questions) => {
                    seen.push(questions[0]);
                    return { value: 'answer' };
                };
                await init.askRemote(runner);
                expect(seen[2].default).to.equal('~/.ssh/id_rsa');
            });
        });

        it('the exported prompt set wires every question the flow uses', function() {
            expect(Object.keys(init.prompts).sort())
                .to.deep.equal(['confirm', 'input', 'remote', 'target', 'tools']);
            Object.values(init.prompts).forEach((fn) => expect(fn).to.be.a('function'));
        });
    });

    describe('the name prompt validator', function() {
        it('rejects an empty name', function() {
            expect(init.required('an environment name')('')).to.contain('Please enter');
        });

        it('rejects whitespace only', function() {
            expect(init.required('an environment name')('   ')).to.contain('Please enter');
        });

        it('accepts a real name', function() {
            expect(init.required('an environment name')('unit-1')).to.equal(true);
        });
    });
});

// AC-14: the stranded scaffolding is gone.
describe('baker init — the old scaffolding is deleted', function() {
    const root = path.join(__dirname, '..', '..');

    it('config/bakerTemplate.yml no longer exists', function() {
        expect(fs.existsSync(path.join(root, 'config', 'bakerTemplate.yml'))).to.equal(false);
    });

    it('config/baker2Template.yml.mustache no longer exists', function() {
        expect(fs.existsSync(path.join(root, 'config', 'baker2Template.yml.mustache'))).to.equal(false);
    });

    it('lib/modules/init/interactive.js no longer exists', function() {
        expect(fs.existsSync(path.join(root, 'lib', 'modules', 'init', 'interactive.js')))
            .to.equal(false);
    });

    it('Baker.init() is gone', function() {
        expect(Baker.init).to.equal(undefined);
    });

    it('Utils.hostIsAccessible is gone', function() {
        const Utils = require('../../lib/modules/utils/utils');
        expect(Utils.hostIsAccessible).to.equal(undefined);
    });

    // AC-15: the docs no longer call init broken.
    describe('AC-15: the docs describe init as working', function() {
        const read = (p) => fs.readFileSync(path.join(root, 'docs', p), 'utf8');

        it('the command table no longer marks init broken', function() {
            const table = read('baker-commands.md')
                .split('\n').find((l) => l.includes('[`init`]') && l.includes('|'));
            expect(table).to.be.a('string');
            expect(table.toLowerCase()).to.not.contain('broken');
        });

        it('baker-commands.md no longer shows init producing a vm: key', function() {
            const section = read('baker-commands.md').split('## `baker init`')[1].split('\n---')[0];
            expect(section).to.not.contain(`'vm:' is no longer supported`);
            expect(section.toLowerCase()).to.not.contain('currently broken');
        });

        it('troubleshooting.md no longer has an "init writes a config bake rejects" entry', function() {
            expect(read('troubleshooting.md')).to.not.contain('writes a config `baker bake` rejects');
        });

        it('getting-started.md points at init rather than telling the reader to write it by hand', function() {
            const gs = read('getting-started.md');
            expect(gs).to.contain('`baker init` writes a starter file');
            expect(gs).to.not.contain('Write this by hand.');
        });

        it('no doc still claims init produces a config bake rejects', function() {
            ['baker-commands.md', 'troubleshooting.md', 'getting-started.md'].forEach((page) => {
                expect(read(page), `${page} still calls init broken`)
                    .to.not.match(/init.{0,60}(currently produces|currently broken)/i);
            });
        });
    });

    it('the ping dependency is gone from package.json', function() {
        const pkg = require(path.join(root, 'package.json'));
        expect(pkg.dependencies).to.not.have.property('ping');
    });

    it('nothing in lib/ still requires ping', function() {
        const hits = [];
        (function walk(dir) {
            fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
                const full = path.join(dir, e.name);
                if (e.isDirectory()) return walk(full);
                if (!e.name.endsWith('.js')) return;
                if (/require\(['"]ping['"]\)/.test(fs.readFileSync(full, 'utf8'))) hits.push(full);
            });
        })(path.join(root, 'lib'));
        expect(hits).to.deep.equal([]);
    });
});
