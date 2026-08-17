const { spawn } = require('child_process');
const fs        = require('fs');
const path      = require('path');
const Git       = require('../modules/utils/git');
const Print     = require('../modules/print');
const { classifyRemote } = require('../modules/utils/source');

exports.command = 'check [target]';
exports.desc = 'Run opunit checks against a repository profile or a local test/opunit.yml file';

exports.builder = (yargs) => {
    yargs
        .example(`$0 check`, `Run test/opunit.yml against the local machine`)
        .example(`$0 check your-org/profiles:env.yml`, `Run a profile from a repository's default branch`)
        .example(`$0 check your-org/profiles@unit-1:env.yml`, `Run a profile from the branch or tag unit-1`);

    yargs.positional('target', {
        describe: `A profile address <owner>/<repo>[@<ref>]:<file>.yml. Omit to run local test/opunit.yml.`,
        type: 'string'
    });
};

exports.handler = async function (argv) {
    try {
        await runCheck(argv.target);
    } catch (err) {
        Print.error(err);
    }
};

// Resolve, then spawn — in that order, so a resolution failure means opunit is
// never started. `deps` reaches checkArgs, which is what lets a test drive the
// whole path including the spawn without touching the network.
// Added by Claude Code (claude-opus-5[1m])
async function runCheck(target, deps = {}) {
    await runOpunit(await checkArgs(target, deps));
}

// Builds opunit's argv for a target, resolving and fetching the profile first.
// The whole decision path in one function that makes no subprocess of its own —
// the same seam run.js draws between runCmdlet() and handler(): what the command
// DECIDES is testable apart from what it SPAWNS. `deps` carries the two network
// edges so a test supplies fakes and mutates nothing shared.
// Added by Claude Code (claude-opus-5[1m])
async function checkArgs(target, deps = {}) {
    if (!target) return opunitArgs(undefined);
    return opunitArgs(target, await resolveProfile(profileAddress(target), deps));
}

// Profile mode:  baker check <owner>/<repo>[@<ref>]:<file>.yml
// Local mode:    baker check
//
// An unrecognised target used to fall through to local mode, which ran a
// DIFFERENT check and reported its result as though it were the requested one.
// A target that cannot be run as a profile is an error naming the expected form;
// only the absence of a target selects local mode.
//
// Baker resolves and fetches the profile itself (see resolveProfile) and hands
// opunit a local path. `opunit profile` is never spawned: its handler fetches the
// file and calls verify('local', file, localConnector) and nothing else
// (opunit 0.9.4, index.js), so `verify local -c <path>` reaches the same code.
// Modified by Claude Code (claude-opus-5[1m])
function opunitArgs(target, profilePath) {
    if (!target) return ['verify', 'local'];

    // A target with no resolved profile must never become local mode's argv.
    // That substitution — reporting one check's result as another's — is the
    // exact failure this command was reworked to prevent, so it is guarded here
    // rather than assumed to be unreachable.
    if (!profilePath) {
        throw new Error(`${target} was not resolved to a profile file.`);
    }
    return ['verify', 'local', '-c', profilePath];
}

// Pure: a profile address to the pieces needed to fetch it. Reuses classifyRemote
// so `check`'s grammar stays defined in one place alongside `bake`'s.
// Added by Claude Code (claude-opus-5[1m])
function profileAddress(target) {
    const remote = classifyRemote(target);

    // github-file is the only kind `check` runs. A repository (`github`), a
    // sub-directory (`github-dir`), a full URL (`url`), and anything the
    // classifier does not recognise are all refused by the same branch.
    if (!remote || remote.kind !== 'github-file') {
        throw new Error(
            `${target} is not an opunit profile address.\n` +
            `\`check\` takes <owner>/<repo>[@<ref>]:<file>.yml — a .yml file at any path in a ` +
            `GitHub repository, on the default branch or on the named branch or tag.\n` +
            `Omit the argument to run ./test/opunit.yml against this machine.`
        );
    }

    // cloneUrl is built by classifyRemote as https://github.com/<owner>/<repo>.git,
    // so the split is over Baker's own string, not over user input.
    const [owner, repo] = new URL(remote.cloneUrl).pathname
        .replace(/^\//, '').replace(/\.git$/, '').split('/');

    return { owner, repo, cloneUrl: remote.cloneUrl, file: remote.subpath, ref: remote.ref || null };
}

// Resolves the address to a commit and returns a local path to that commit's
// profile, fetching it if it is not already cached.
//
// Content-addressed: the cache path names the commit, so a hit is the right bytes
// by construction and needs no revalidation. This is what removes the staleness
// window — raw.githubusercontent serves max-age=300 even for a sha-pinned URL, but
// a URL naming immutable content cannot return the wrong thing however it is
// cached. ls-remote runs on every invocation, because it is what proves freshness.
//
// A resolution failure is a HARD failure: an older cached profile is never run and
// the cache is never advertised as a workaround. A passing `baker check` has to
// mean the current profile passed.
// Added by Claude Code (claude-opus-5[1m])
async function resolveProfile(addr, deps = {}) {
    const { raw = Git.raw, fetchUrl = Git.fetchUrl, print = Print.info } = deps;

    const { sha, ref } = await Git.resolveRef(addr.cloneUrl, addr.ref, raw);
    const dest = profileCachePath(addr, sha);

    // A hit must be a FILE, not merely something at that path. Two addresses in
    // one repo can nest — `repo:units.yml` and `repo:units.yml/one.yml` are both
    // legal — and the second leaves a directory exactly where the first expects
    // its profile. Handing opunit a directory it cannot read would report as a
    // check failure rather than as the addressing mistake it is.
    if (!isFile(dest)) {
        const url = `https://raw.githubusercontent.com/${addr.owner}/${addr.repo}/${sha}/${addr.file}`;
        let content;
        try {
            content = await fetchUrl(url, { 'User-Agent': 'baker' });
        } catch (err) {
            // Names the file, the short sha, and the ref, which separates "wrong
            // filename" from "right filename, wrong commit" — a distinction
            // opunit's flat `Cannot find <file>` cannot make.
            throw new Error(
                `${addr.file} is not in ${addr.owner}/${addr.repo} at ${sha.slice(0, 7)} (${ref}).\n` +
                `${err.message}`
            );
        }

        // mkdir -p is what makes a nested address (:units/unit-1.yml) work at all.
        await fs.promises.mkdir(path.dirname(dest), { recursive: true });

        // Temp file plus rename, never a direct write to the content-addressed
        // path. rename is atomic on POSIX and on Windows within a volume, so dest
        // either does not exist or holds a COMPLETE file. Without this, a Ctrl-C
        // mid-download leaves a truncated profile at a path every later run treats
        // as a valid hit — silently, forever, on that machine. Sibling temp so the
        // rename stays same-volume; the pid keeps concurrent runs apart.
        const tmp = `${dest}.${process.pid}.tmp`;
        try {
            await fs.promises.writeFile(tmp, content, 'utf8');
            await fs.promises.rename(tmp, dest);
        } catch (err) {
            // The only swallowed error in this path, deliberately: a failed
            // cleanup must not replace the failure the caller needs to see. The
            // temp file is pid-named and harmless if it survives.
            await fs.promises.unlink(tmp).catch(() => {});
            throw err;
        }
    }

    print(`Using profile ${addr.owner}/${addr.repo}:${addr.file} @ ${sha.slice(0, 7)} (${ref})`);
    return dest;
}

function isFile(p) {
    try {
        return fs.statSync(p).isFile();
    } catch (err) {
        return false; // ENOENT is the ordinary case: nothing cached yet.
    }
}

// ~/.baker/cache/profiles/<owner>/<repo>/<sha>/<file>. Pure.
//
// '.' and '..' are dropped from the file path rather than escaped, exactly as
// Git.cacheDir does: a cache path must never climb out of the cache root,
// whatever the address looks like.
// Added by Claude Code (claude-opus-5[1m])
function profileCachePath(addr, sha) {
    const segments = String(addr.file)
        .split('/')
        .filter((s) => s && s !== '.' && s !== '..')
        .map(Git.safeSegment);

    return path.join(
        Git.cacheRoot(), 'profiles',
        Git.safeSegment(addr.owner), Git.safeSegment(addr.repo), sha,
        ...segments
    );
}

module.exports.checkArgs = checkArgs;
module.exports.opunitArgs = opunitArgs;
module.exports.profileAddress = profileAddress;
module.exports.profileCachePath = profileCachePath;
module.exports.resolveProfile = resolveProfile;
module.exports.runCheck = runCheck;

function runOpunit(args) {
    return new Promise((resolve, reject) => {
        const child = spawn('opunit', args, { stdio: 'inherit', shell: false });
        child.on('error', (e) =>
            e.code === 'ENOENT'
                ? reject(new Error(`opunit not found on PATH. Install it: ` +
                                   `npm install -g ottomatica/opunit (0.9.4 or newer)`))
                : reject(e));
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`opunit exited with code ${code}`))));
    });
}
