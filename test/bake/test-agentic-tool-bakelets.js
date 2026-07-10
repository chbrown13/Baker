const chai = require('chai');
const expect = chai.expect;

const AgenticTool = require('../../lib/bakelets/tools/agentic-tool');
const ClaudeCode  = require('../../lib/bakelets/tools/claude-code');
const Opencode    = require('../../lib/bakelets/tools/opencode');

// Instantiates a bakelet with a recorder in place of this.exec, runs
// load()+install(), and returns the list of commands it issued. No SSH config is
// given (null) — proving the bakelet is environment-agnostic (AC-7): it never
// touches ansibleSSHConfig, only this.exec.
async function run(Klass, yamlEntry) {
    const bakelet = new Klass('env', null, '');
    const calls = [];
    bakelet.exec = async (cmd) => { calls.push(cmd); };
    await bakelet.load(yamlEntry, []);
    await bakelet.install();
    return { bakelet, calls };
}

describe('agentic tool bakelets', function() {

    describe('claude-code', function() {
        it('installs via curl by default with an idempotency guard (AC-1)', async function() {
            const { calls } = await run(ClaudeCode, 'claude-code');
            expect(calls).to.have.lengthOf(1);
            expect(calls[0]).to.match(/^command -v claude >\/dev\/null 2>&1 \|\| \(.*\)$/);
            expect(calls[0]).to.contain('curl'); // structure only; exact URL is smoke-verified
        });

        it('installs via npm when install: npm (AC-2)', async function() {
            const { calls } = await run(ClaudeCode, { 'claude-code': { install: 'npm' } });
            expect(calls[0]).to.contain('npm install -g');
            expect(calls[0]).to.not.contain('curl');
        });

        it('keeps the idempotency guard so re-bake is a no-op (AC-3)', async function() {
            const { calls } = await run(ClaudeCode, 'claude-code');
            expect(calls[0]).to.contain('command -v claude >/dev/null 2>&1 ||');
        });

        it('throws for an unknown install method before issuing any exec (AC-6)', async function() {
            const bakelet = new ClaudeCode('env', null, '');
            const calls = [];
            bakelet.exec = async (cmd) => { calls.push(cmd); };
            await bakelet.load({ 'claude-code': { install: 'brew' } }, []);
            let err;
            try { await bakelet.install(); } catch (e) { err = e; }
            expect(err).to.be.an('error');
            expect(err.message).to.contain("Unknown install method 'brew'");
            expect(err.message).to.contain('curl');
            expect(err.message).to.contain('npm');
            expect(calls).to.have.lengthOf(0); // threw before any exec
        });
    });

    describe('opencode', function() {
        it('installs via curl by default (AC-1)', async function() {
            const { calls } = await run(Opencode, 'opencode');
            expect(calls[0]).to.match(/^command -v opencode .* \|\| \(.*\)$/);
            expect(calls[0]).to.contain('curl'); // structure only; exact URL is smoke-verified
        });

        it('throws an actionable error for a repo config missing its URL', async function() {
            const bakelet = new Opencode('env', null, '');
            const calls = [];
            bakelet.exec = async (cmd) => { calls.push(cmd); };
            await bakelet.load({ opencode: { repo: { dest: '~/x' } } }, []);
            let err;
            try { await bakelet.install(); } catch (e) { err = e; }
            expect(err).to.be.an('error');
            expect(err.message).to.contain('No repository URL');
            // the binary-install exec still ran (call 0); only the repo step failed
            expect(calls).to.have.lengthOf(1);
        });

        it('clones a config repo into the default config dir (AC-4)', async function() {
            const { calls } = await run(Opencode, {
                opencode: { repo: 'https://github.com/org/oc' }
            });
            expect(calls).to.have.lengthOf(2);
            const clone = calls[1];
            // Three-way clone-or-update against the default dest.
            expect(clone).to.contain('[ -d "~/.config/opencode/.git" ]');
            expect(clone).to.contain('git -C "~/.config/opencode" pull --ff-only');
            expect(clone).to.contain('git clone "https://github.com/org/oc" "~/.config/opencode"');
            expect(clone).to.contain('is not a git repo; skipping');
        });
    });

    describe('config-repo parsing (parseRepo)', function() {
        it('splits a url:dest string on the last colon after the scheme (AC-5)', function() {
            const b = new Opencode('env', null, '');
            b.defaultConfigDir = '~/.config/opencode';
            const { url, dest } = b.parseRepo('https://github.com/org/oc:~/.config/opencode/team');
            expect(url).to.equal('https://github.com/org/oc');
            expect(dest).to.equal('~/.config/opencode/team');
        });

        it('falls back to the default config dir when no dest is given', function() {
            const b = new Opencode('env', null, '');
            const { url, dest } = b.parseRepo('https://github.com/org/oc');
            expect(url).to.equal('https://github.com/org/oc');
            expect(dest).to.equal('~/.config/opencode');
        });

        it('accepts the object form { repo, dest }', function() {
            const b = new ClaudeCode('env', null, '');
            const { url, dest } = b.parseRepo({ repo: 'https://x/y', dest: '~/.claude/team' });
            expect(url).to.equal('https://x/y');
            expect(dest).to.equal('~/.claude/team');
        });

        it('object form without dest uses the default config dir', function() {
            const b = new ClaudeCode('env', null, '');
            const { dest } = b.parseRepo({ repo: 'https://x/y' });
            expect(dest).to.equal('~/.claude');
        });

        it('leaves an scp-style git@ URL intact (no false split on its colon)', function() {
            const b = new ClaudeCode('env', null, '');
            const { url, dest } = b.parseRepo('git@github.com:org/repo.git');
            expect(url).to.equal('git@github.com:org/repo.git');
            expect(dest).to.equal('~/.claude');
        });

        it('splits an scp-style URL only when an explicit ~/path dest is appended', function() {
            const b = new ClaudeCode('env', null, '');
            const { url, dest } = b.parseRepo('git@github.com:org/repo.git:~/.claude/team');
            expect(url).to.equal('git@github.com:org/repo.git');
            expect(dest).to.equal('~/.claude/team');
        });

        it('treats a scheme-less, colon-less string as the whole URL with default dest', function() {
            const b = new ClaudeCode('env', null, '');
            const { url, dest } = b.parseRepo('/srv/local/config-repo');
            expect(url).to.equal('/srv/local/config-repo');
            expect(dest).to.equal('~/.claude');
        });
    });

    describe('YAML entry normalization (load)', function() {
        it('treats the bare string form and empty-object form identically', async function() {
            const asString = await run(ClaudeCode, 'claude-code');
            const asObject = await run(ClaudeCode, { 'claude-code': {} });
            expect(asString.calls[0]).to.equal(asObject.calls[0]);
        });

        it('defaults config to {} for the bare string form', async function() {
            const bakelet = new ClaudeCode('env', null, '');
            await bakelet.load('claude-code', []);
            expect(bakelet.config).to.deep.equal({});
        });

        it('defaults config to {} for null or a toolKey-less object', async function() {
            const b1 = new ClaudeCode('env', null, '');
            await b1.load(null, []);
            expect(b1.config).to.deep.equal({});

            const b2 = new ClaudeCode('env', null, '');
            await b2.load({}, []);
            expect(b2.config).to.deep.equal({});
        });
    });

    describe('resolver wiring contract', function() {
        // resolve.js maps the yaml key to a module file of the same name and
        // instantiates new Class(name, sshConfig, version). Lock that toolKey
        // matches the module the resolver would require.
        it('each tool module is requirable by its toolKey and reports that key', function() {
            for (const key of ['claude-code', 'opencode']) {
                const Klass = require('../../lib/bakelets/tools/' + key);
                const instance = new Klass('env', null, '');
                expect(instance).to.be.instanceOf(AgenticTool);
                expect(instance.toolKey).to.equal(key);
            }
        });
    });

    describe('shell-safety invariant', function() {
        // docker-local wraps commands as `bash -c '<cmd>'`; a single quote breaks it.
        it('composes commands containing no single quotes', async function() {
            for (const Klass of [ClaudeCode, Opencode]) {
                const curl = await run(Klass, Klass === ClaudeCode ? 'claude-code' : 'opencode');
                expect(curl.calls[0]).to.not.contain("'");

                const key = Klass === ClaudeCode ? 'claude-code' : 'opencode';
                const withRepo = await run(Klass, { [key]: { repo: 'https://x/y' } });
                withRepo.calls.forEach(c => expect(c).to.not.contain("'"));
            }
        });

        it('every declared install command is single-quote free', function() {
            for (const Klass of [ClaudeCode, Opencode]) {
                const b = new Klass('env', null, '');
                Object.values(b.installCommands).forEach(cmd =>
                    expect(cmd).to.not.contain("'"));
            }
        });
    });

    describe('environment-agnostic (AC-7)', function() {
        it('installs using only this.exec, never ansibleSSHConfig', async function() {
            // Constructed with null SSH config; still produces a full install plan.
            const { bakelet, calls } = await run(ClaudeCode, {
                'claude-code': { repo: 'https://github.com/org/cfg' }
            });
            expect(bakelet.ansibleSSHConfig).to.equal(null);
            expect(calls).to.have.lengthOf(2); // install + repo, no SSH dependency
        });
    });
});
