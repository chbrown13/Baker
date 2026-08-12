const os = require('os');
const path = require('path');
const chai = require('chai');
const expect = chai.expect;

const Utils = require('../../lib/modules/utils/utils');
const Bakelet = require('../../lib/bakelets/bakelet');
const LocalProvider = require('../../lib/modules/providers/local');
const RemoteProvider = require('../../lib/modules/providers/remote');

// A `~` in a config used to mean different things depending on which key it
// appeared under: `local:` expanded it, `files:` dest expanded it, and
// `remote: private_key:` did not — even though every documented example of
// private_key uses the ~ form. These pin the one shared implementation.
// Added by Claude Code (claude-opus-5[1m])
describe('~ expansion', function() {
    const home = os.homedir();

    describe('Utils.expandTilde', function() {
        it('expands a bare ~ to the home directory', function() {
            expect(Utils.expandTilde('~')).to.equal(home);
        });

        it('expands a ~/ prefix', function() {
            expect(Utils.expandTilde('~/.ssh/id_rsa')).to.equal(path.join(home, '.ssh/id_rsa'));
        });

        it('expands a ~\\ prefix for Windows-style configs', function() {
            expect(Utils.expandTilde('~\\.ssh\\id_rsa')).to.equal(path.join(home, '.ssh\\id_rsa'));
        });

        it('leaves ~user alone rather than guessing another home', function() {
            expect(Utils.expandTilde('~someone/.ssh/id_rsa')).to.equal('~someone/.ssh/id_rsa');
        });

        it('leaves an absolute path untouched', function() {
            expect(Utils.expandTilde('/tmp/test_rsa')).to.equal('/tmp/test_rsa');
        });

        it('leaves a relative path untouched — resolving is the caller\'s job', function() {
            expect(Utils.expandTilde('keys/id_rsa')).to.equal('keys/id_rsa');
        });

        it('passes a non-string through rather than throwing', function() {
            expect(Utils.expandTilde(undefined)).to.equal(undefined);
        });

        it('does not treat a ~ inside the path as a prefix', function() {
            expect(Utils.expandTilde('/tmp/~backup/key')).to.equal('/tmp/~backup/key');
        });
    });

    describe('remote: private_key', function() {
        it('expands ~ when the provider is constructed — the baker ssh path', function() {
            const provider = new RemoteProvider('admin', '~/.ssh/id_rsa', '10.0.0.1', 22);
            expect(provider.sshConfig.private_key).to.equal(path.join(home, '.ssh/id_rsa'));
        });

        it('expands ~ for bake and cleanup — the path that used to fail', function() {
            const doc = { remote: { user: 'admin', ip: '10.0.0.1', private_key: '~/.ssh/id_rsa' } };
            expect(RemoteProvider.sshConfigFromDoc(doc).private_key)
                .to.equal(path.join(home, '.ssh/id_rsa'));
        });

        it('never leaves a literal ~ segment for fs.readFileSync to choke on', function() {
            const resolved = RemoteProvider.resolveKeyPath('~/.ssh/id_rsa');
            expect(resolved.split(path.sep)).to.not.include('~');
        });

        it('makes a relative key path absolute', function() {
            expect(path.isAbsolute(RemoteProvider.resolveKeyPath('keys/id_rsa'))).to.equal(true);
        });

        it('agrees between the constructor and sshConfigFromDoc', function() {
            const doc = { remote: { user: 'admin', ip: '10.0.0.1', private_key: '~/.ssh/id_rsa', port: 2222 } };
            const constructed = new RemoteProvider(
                doc.remote.user, doc.remote.private_key, doc.remote.ip, doc.remote.port
            );
            expect(constructed.sshConfig).to.deep.equal(RemoteProvider.sshConfigFromDoc(doc));
        });

        it('defaults the port to 22 in sshConfigFromDoc', function() {
            const doc = { remote: { user: 'admin', ip: '10.0.0.1', private_key: '/tmp/k' } };
            expect(RemoteProvider.sshConfigFromDoc(doc).port).to.equal(22);
        });
    });

    describe('other config keys that accept ~', function() {
        it('local: resolves ~ to the home directory', function() {
            expect(LocalProvider.resolveLocation('~/project')).to.equal(path.join(home, 'project'));
        });

        it('local: still resolves a relative path against cwd', function() {
            expect(LocalProvider.resolveLocation('project')).to.equal(path.resolve('project'));
        });

        it('the bakelet base expands ~ the same way', function() {
            const bakelet = new Bakelet({});
            expect(bakelet.resolveLocalPath('~/.config/tool')).to.equal(path.join(home, '.config/tool'));
        });

        it('the bakelet base no longer mangles ~user into the current home', function() {
            const bakelet = new Bakelet({});
            expect(bakelet.resolveLocalPath('~someone/x')).to.equal('~someone/x');
        });
    });
});
