const Bakelet = require('../bakelet');
const fs      = require('fs-extra');
const https   = require('https');
const os      = require('os');
const path    = require('path');

// Declarative file placement into the provisioned environment.
//
// Selected as a `config:` entry, so `getBakeletInformation` resolves
// {files: [...]} to this module with no resolver or provider changes — the same
// property that made the agentic-tool bakelets a pure addition.
//
// Three things make this bakelet different from `config: template`:
//   1. It owns its placement. The resolver's local copy shim flattens a
//      destination to path.basename(dest), so a nested dest is inexpressible
//      through it. Local mode therefore writes with fs directly — which is not
//      "bypassing the transport", because in local mode the transport IS fs.
//   2. It converges. A manifest records what it placed, so a re-bake can remove
//      what the previous bake placed and this one does not.
//   3. It never touches a path it did not place. Pruning is driven entirely by
//      the previous manifest, so a student's own files are structurally
//      invisible to removal.
//
// Shell-safety invariant: no composed command may contain a single quote,
// because docker-local wraps commands as `docker exec <c> /bin/bash -c '<cmd>'`.
// Double quotes only. Asserted in the suite so a future edit cannot break it.
// Added by Claude Code (claude-opus-5[1m])
class Files extends Bakelet {
    constructor(name, ansibleSSHConfig, version) {
        super(ansibleSSHConfig);

        this.name = name;
        this.version = version;
        this.entries = [];
        this.runCommands = [];
        this.prune = false;
    }

    // Writes where the author points it — inside a repo they own, for the
    // per-unit case. Anything needing a system path is a packages: job.
    get requiresElevation() {
        return false;
    }

    // Placement is fs locally and POSIX commands against a Linux target
    // otherwise, so there is no package manager to resolve.
    get needsPlatform() {
        return false;
    }

    // ---- schema -----------------------------------------------------------

    // Normalises one YAML entry and rejects the combinations that have no
    // coherent meaning, at load time rather than mid-placement.
    static normalizeEntry(entry, index) {
        const where = `files: entry ${index + 1}`;

        // Shorthand: a bare string means the same relative path on both sides.
        if (typeof entry === 'string') {
            return { kind: 'file', src: entry, dest: entry, overwrite: true };
        }
        if (!entry || typeof entry !== 'object') {
            throw new Error(`${where} must be a string or a map, got ${typeof entry}.`);
        }

        if (entry.ensure !== undefined) {
            if (entry.ensure !== 'dir') {
                throw new Error(`${where}: ensure: only supports "dir", got "${entry.ensure}".`);
            }
            if (entry.src !== undefined || entry.dest !== undefined) {
                throw new Error(`${where}: ensure: cannot be combined with src: or dest:.`);
            }
            if (!entry.path) {
                throw new Error(`${where}: ensure: dir requires a path:.`);
            }
            return { kind: 'dir', dest: entry.path, overwrite: true };
        }

        if (!entry.src) {
            throw new Error(`${where}: needs a src: (or use ensure: dir with a path:).`);
        }
        const dest = entry.dest || entry.src;
        const append = entry.append === true;
        const overwrite = entry.overwrite !== false;

        // append: already defines its own convergence — it replaces its own
        // block in place — so "do not overwrite" has nothing to mean alongside.
        if (append && !overwrite) {
            throw new Error(`${where}: append: and overwrite: false are mutually exclusive.`);
        }

        return {
            kind: append ? 'append' : 'file',
            src: entry.src, dest, overwrite, append,
            mode: entry.mode
        };
    }

    async load(obj, variables) {
        this.variables = variables;
        const block = obj.files;
        if (block !== undefined && !Array.isArray(block)) {
            throw new Error('files: must be a list of entries.');
        }
        this.entries = (block || []).map(Files.normalizeEntry);
        this.prune = obj.prune === true;
        this.runCommands = obj.run || [];
        if (!Array.isArray(this.runCommands)) {
            throw new Error('run: must be a list of commands.');
        }
    }

    // ---- paths ------------------------------------------------------------

    get isLocal() {
        return Boolean(this.localLocation);
    }

    // Relative destinations anchor here. Local mode provisions a real directory
    // on the host; every other mode uses BAKER_SHARE_DIR, which the resolver
    // pushes into extra_vars for all modes and which is the repo's existing
    // answer to "where the project lives inside the environment".
    get envRoot() {
        if (this.isLocal) return this.localLocation;
        const flat = {};
        (this.variables || []).forEach((entry) => Object.assign(flat, entry));
        if (!flat.BAKER_SHARE_DIR) {
            throw new Error('files: cannot resolve the environment root (BAKER_SHARE_DIR is unset).');
        }
        return flat.BAKER_SHARE_DIR;
    }

    get stagingDir() {
        return `/home/vagrant/baker/${this.name}/files`;
    }

    get manifestPath() {
        return this.joinTarget(this.envRoot, '.baker-manifest.json');
    }

    // Target paths are POSIX in every non-local mode; locally they follow the
    // host. path.posix keeps a Windows host from emitting backslashes into a
    // command bound for a Linux container.
    joinTarget(...parts) {
        return this.isLocal ? path.join(...parts) : path.posix.join(...parts);
    }

    static isAbsoluteish(p) {
        return p.startsWith('/') || p.startsWith('~') || /^[A-Za-z]:[\\/]/.test(p);
    }

    // Resolves an entry destination to where it actually lands, and refuses a
    // relative path that would escape the environment root. Escaping requires
    // an explicit absolute path, which is a deliberate act rather than a
    // path-arithmetic accident.
    resolveDest(dest) {
        if (Files.isAbsoluteish(dest)) {
            // Locally we expand ~ ourselves; remotely the shell does it, and the
            // manifest records the original either way so it is never pruned.
            const expanded = this.isLocal ? this.resolveLocalPath(dest) : dest;
            return { full: expanded, relative: null, absolute: true };
        }

        const root = this.envRoot;
        const full = this.isLocal
            ? path.resolve(root, dest)
            : path.posix.normalize(path.posix.join(root, dest));

        const inside = this.isLocal
            ? (full === root || full.startsWith(root + path.sep))
            : (full === root || full.startsWith(root.replace(/\/$/, '') + '/'));

        if (!inside) {
            throw new Error(
                `files: dest "${dest}" resolves outside the environment root (${root}). ` +
                `Use an absolute path if that is really what you mean.`
            );
        }
        return { full, relative: dest, absolute: false };
    }

    // Sources are relative to the baker.yml directory, which is now always the
    // repository root — sub-directory addressing was removed, so a config can no
    // longer sit below the root and nothing legitimately climbs out with
    // ../../base/. An escaping src: is therefore an error rather than an
    // overlay, and reaching outside the repo would place content that is not in
    // the repo the address named.
    resolveSrc(src) {
        const resolved = path.resolve(this.bakePath, src);
        const root = path.resolve(this.bakePath);
        if (resolved !== root && !resolved.startsWith(root + path.sep)) {
            throw new Error(
                `files: src "${src}" resolves outside the repository (${root}).\n` +
                `  Sources must live inside the repository holding baker.yml. ` +
                `Use a branch or tag to vary content between units, not a path above the root.`
            );
        }
        return resolved;
    }

    static isUrl(src) {
        return /^https?:\/\//.test(src);
    }

    // ---- markers ----------------------------------------------------------

    static markerStartFor(name) {
        return `# >>> baker:${name} >>>`;
    }

    static markerEndFor(name) {
        return `# <<< baker:${name} <<<`;
    }

    get markerStart() {
        return Files.markerStartFor(this.name);
    }

    get markerEnd() {
        return Files.markerEndFor(this.name);
    }

    block(content) {
        return `${this.markerStart}\n${content.replace(/\n$/, '')}\n${this.markerEnd}\n`;
    }

    // Removes previously written blocks, leaving everything around them intact.
    //
    // Strips the block for every name given, not just the current one: an
    // instructor who names environments per assignment (cs-PM2, then cs-PM3)
    // would otherwise leave one orphaned block per assignment, because the new
    // bake cannot recognise the old marker. The previous manifest records which
    // marker it wrote, so the rename is still cleaned up.
    stripBlock(existing, names) {
        const targets = names || [this.name];
        return targets.reduce((text, name) => {
            const pattern = new RegExp(
                `${Files.escapeRegExp(Files.markerStartFor(name))}[\\s\\S]*?` +
                `${Files.escapeRegExp(Files.markerEndFor(name))}\\n?`,
                'g'
            );
            return text.replace(pattern, '');
        }, existing);
    }

    static escapeRegExp(value) {
        return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    // ---- fetching ---------------------------------------------------------

    // Static and separate so tests can stub it: a plausible-but-wrong URL must
    // be caught by the live smoke, not frozen green by a unit test. Exercising
    // this body would test node's https rather than Baker's logic, so it is
    // deliberately uncovered — every caller path IS covered, via a stub.
    /* istanbul ignore next */
    static download(url) {
        return new Promise((resolve, reject) => {
            https.get(url, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    return resolve(Files.download(res.headers.location));
                }
                if (res.statusCode !== 200) {
                    return reject(new Error(`Failed to fetch ${url}: HTTP ${res.statusCode}`));
                }
                let body = '';
                res.setEncoding('utf8');
                res.on('data', (chunk) => { body += chunk; });
                res.on('end', () => resolve(body));
            }).on('error', reject);
        });
    }

    // Returns a host-side path for the entry's source, downloading a URL into a
    // temp file first. Throws naming both the resolved path and the bakePath it
    // came from — the second half is what makes a standalone baker.yml
    // diagnosable.
    async materialize(entry) {
        if (Files.isUrl(entry.src)) {
            const content = await Files.download(entry.src);
            const tmp = path.join(os.tmpdir(), `baker-files-${Date.now()}-${path.basename(entry.dest)}`);
            await fs.outputFile(tmp, content);
            return { hostPath: tmp, isDirectory: false, temporary: true };
        }

        const resolved = this.resolveSrc(entry.src);
        if (!await fs.pathExists(resolved)) {
            throw new Error(
                `files: source not found: ${resolved}\n` +
                `  (resolved from src: "${entry.src}" relative to ${this.bakePath})`
            );
        }
        const stat = await fs.stat(resolved);
        return { hostPath: resolved, isDirectory: stat.isDirectory(), temporary: false };
    }

    // ---- install ----------------------------------------------------------

    async install() {
        const previous = await this.readManifest();
        this.previous = previous;
        const placed = [];
        const seen = new Set();

        for (const entry of this.entries) {
            for (const record of await this.place(entry)) {
                // Overlays legitimately place the same path twice — base then
                // overlay. The manifest records it once; the later write won.
                if (seen.has(record.path)) continue;
                seen.add(record.path);
                placed.push(record);
            }
        }

        if (this.prune) {
            await this.pruneStale(previous, placed);
        }

        await this.writeManifest(placed);

        // After placement and pruning, so the environment is in its intended
        // state before anything is asked to run against it.
        for (const command of this.runCommands) {
            await this.exec(this.isLocal ? command : `cd "${this.envRoot}" && ${command}`);
        }
    }

    // Returns the manifest records for one entry — one per file actually
    // placed, not one per entry.
    //
    // This distinction is the whole of pruning. A directory entry's dest is
    // usually `.`, which is present in every assignment's config, so recording
    // the entry would make nothing ever look stale and a PM2-only agent would
    // survive the switch to PM3. Expanding the directory is what lets the
    // difference between two bakes be computed at all.
    async place(entry) {
        const target = this.resolveDest(entry.dest);

        if (entry.kind === 'dir') {
            await this.ensureDir(target.full);
            return [{ path: entry.dest, mode: 'dir' }];
        }

        const source = await this.materialize(entry);
        const mode = entry.overwrite ? 'overwrite' : 'once';

        if (entry.kind === 'append') {
            const content = await fs.readFile(source.hostPath, 'utf8');
            await this.appendBlock(target.full, content, this.previousMarkerFor(entry.dest));
            if (source.temporary) await fs.remove(source.hostPath).catch(() => {});
            return [{ path: entry.dest, mode: 'append', marker: this.name }];
        }

        await this.copyInto(source, target, entry);

        let records;
        if (source.isDirectory) {
            // The source is host-side in every mode, so it can be walked here
            // regardless of where the files ended up.
            const relatives = await Files.walk(source.hostPath);
            records = relatives.map((rel) => ({ path: this.joinRelative(entry.dest, rel), mode }));
        } else {
            records = [{ path: entry.dest, mode }];
        }

        if (source.temporary) await fs.remove(source.hostPath).catch(() => {});
        return records;
    }

    // Every file under a directory, as paths relative to it. Directories
    // themselves are not recorded — pruning removes them when they empty out.
    static async walk(root, prefix = '') {
        const found = [];
        for (const name of await fs.readdir(root)) {
            const full = path.join(root, name);
            const rel = prefix ? `${prefix}/${name}` : name;
            const stat = await fs.stat(full);
            if (stat.isDirectory()) {
                found.push(...await Files.walk(full, rel));
            } else {
                found.push(rel);
            }
        }
        return found;
    }

    // Joins an entry dest with a path inside a directory source, keeping the
    // manifest's relative-to-envRoot convention. A dest of "." contributes
    // nothing, which is the common overlay case.
    joinRelative(dest, rel) {
        if (Files.isAbsoluteish(dest)) {
            return `${dest.replace(/\/$/, '')}/${rel}`;
        }
        return path.posix.join(dest === '.' ? '' : dest, rel).replace(/^\.\//, '');
    }

    // Which marker the last bake wrote at this path, if any. Lets a renamed
    // environment clean up the block its predecessor left.
    previousMarkerFor(dest) {
        if (!this.previous) return null;
        const match = this.previous.entries.find((e) => e.path === dest && e.mode === 'append');
        return match ? match.marker : null;
    }

    async ensureDir(full) {
        if (this.isLocal) {
            await fs.ensureDir(full);
            return;
        }
        await this.exec(`mkdir -p "${full}"`);
    }

    async copyInto(source, target, entry) {
        if (this.isLocal) {
            if (!entry.overwrite && await fs.pathExists(target.full)) return;
            await fs.ensureDir(path.dirname(target.full));
            await fs.copy(source.hostPath, target.full, { overwrite: entry.overwrite });
            if (entry.mode) await fs.chmod(target.full, parseInt(entry.mode, 8));
            return;
        }

        // Staged first because `docker cp` targets path.dirname(dest) and cannot
        // rename in transit: a src whose basename differs from the dest basename
        // would otherwise land under the wrong name.
        const staged = this.joinTarget(this.stagingDir, path.basename(source.hostPath));
        await this.exec(`mkdir -p "${this.stagingDir}" "${path.posix.dirname(target.full)}"`);
        await this.copy(source.hostPath, staged);

        // The trailing /. is what makes a directory overlay MERGE into an
        // existing destination rather than nesting inside it. Removing it is
        // the expected regression here.
        const move = source.isDirectory
            ? `mkdir -p "${target.full}" && cp -rf "${staged}/." "${target.full}/"`
            : `mv -f "${staged}" "${target.full}"`;

        await this.exec(entry.overwrite ? move : `[ -e "${target.full}" ] || { ${move}; }`);
        if (entry.mode) await this.exec(`chmod ${entry.mode} "${target.full}"`);
    }

    // Marker-delimited block append: writes the block if absent, replaces it in
    // place if present, leaving every surrounding line untouched.
    async appendBlock(full, content, alsoStrip) {
        const block = this.block(content);
        const names = alsoStrip && alsoStrip !== this.name ? [this.name, alsoStrip] : [this.name];

        if (this.isLocal) {
            const existing = await fs.pathExists(full) ? await fs.readFile(full, 'utf8') : '';
            const stripped = this.stripBlock(existing, names);
            const separator = stripped.length && !stripped.endsWith('\n') ? '\n' : '';
            await fs.ensureDir(path.dirname(full));
            await fs.writeFile(full, stripped + separator + block);
            return;
        }

        const staged = this.joinTarget(this.stagingDir, `append-${path.basename(full)}`);
        await this.exec(`mkdir -p "${this.stagingDir}" "${path.posix.dirname(full)}"`);
        // Heredoc body is literal (quoted delimiter), so nothing in the block
        // is re-interpreted on the way in.
        await this.exec(`cat > "${staged}" <<"BAKER_BLOCK"\n${block.replace(/\n$/, '')}\nBAKER_BLOCK`);
        const deletions = names.map((name) =>
            `sed -i "/^${Files.escapeSed(Files.markerStartFor(name))}$/,` +
            `/^${Files.escapeSed(Files.markerEndFor(name))}$/d" "${full}"`
        ).join(' && ');
        await this.exec(`touch "${full}" && ${deletions} && cat "${staged}" >> "${full}"`);
    }

    static escapeSed(value) {
        return value.replace(/[\\/&.*[\]^$]/g, '\\$&');
    }

    // ---- removal (baker cleanup) -------------------------------------------

    // The destination set is re-derived from the source tree, exactly as
    // install() derives it — the same computation, run backwards. That is what
    // makes a path Baker never placed structurally impossible to remove: it is
    // never in the set, because the set comes from the config, not from
    // scanning the destination.
    //
    // Side-effect free: it reads the source tree and stats destinations, and
    // writes nothing.
    async plan() {
        const paths = [];
        const blocks = [];

        for (const entry of this.entries) {
            const target = this.resolveDest(entry.dest);

            if (entry.kind === 'append') {
                // Surgical: the block goes, the file stays.
                blocks.push({ file: target.full, marker: this.name });
                continue;
            }
            if (entry.kind === 'dir') {
                // Only if empty once Baker's contents are gone, so a directory
                // that accumulated the user's files survives with them.
                paths.push({ path: target.full, emptyOnly: true });
                continue;
            }

            let source;
            try {
                source = await this.materialize(entry);
            } catch (err) {
                // A source that has since disappeared cannot be re-derived, so
                // nothing is claimed for it rather than guessing at a path.
                continue;
            }
            if (source.isDirectory) {
                for (const rel of await Files.walk(source.hostPath)) {
                    paths.push({ path: this.joinTarget(target.full, rel) });
                }
            } else {
                paths.push({ path: target.full });
            }
            if (source.temporary) await fs.remove(source.hostPath).catch(() => {});
        }

        // Only what is still there. A plan that lists already-gone paths would
        // claim to remove them on every re-run, so convergence has to be
        // visible here rather than only true of the operations.
        const declared = paths.map((p) => p.path);
        const present = new Set(await this.filterExisting(declared));
        const live = paths.filter((p) => present.has(p.path));
        const goneCount = declared.length - live.length;

        const operations = [];
        if (live.length) {
            operations.push({
                kind: 'paths', bakelet: 'files', default: true,
                paths: live.map((p) => p.path),
                emptyOnly: live.filter((p) => p.emptyOnly).map((p) => p.path),
                envRoot: this.envRoot, alreadyGone: goneCount,
                restore: 'baker bake <same source>'
            });
        }

        for (const b of await this.filterExisting(blocks.map((x) => x.file))) {
            const block = blocks.find((x) => x.file === b);
            // Presence of the FILE is not enough: the block may already be
            // gone from it, and offering to remove it again would report work
            // that does not exist.
            if (!await this.hasBlock(block.file, block.marker)) continue;
            operations.push({
                kind: 'block', bakelet: 'files', default: true,
                file: block.file, marker: block.marker,
                restore: 'baker bake <same source>'
            });
        }

        // Baker's own bookkeeping goes with the files it describes.
        if ((await this.filterExisting([this.manifestPath])).length) {
            operations.push({
                kind: 'paths', bakelet: 'files manifest', default: true,
                paths: [this.manifestPath], emptyOnly: [], envRoot: this.envRoot,
                restore: 'baker bake <same source>'
            });
        }

        // Reported alongside whatever remains, so a partly-cleaned environment
        // says so instead of silently narrowing its plan.
        if (goneCount) {
            operations.push({
                kind: 'none', bakelet: 'files',
                reason: `${goneCount} path(s) already gone`
            });
        }

        if (operations.length) return operations;
        return [{ kind: 'none', bakelet: 'files', reason: 'nothing declared to remove' }];
    }

    // Whether a marker block is still in the file. Read-only.
    async hasBlock(file, marker) {
        const start = Files.markerStartFor(marker);
        try {
            if (this.isLocal) {
                if (!await fs.pathExists(file)) return false;
                return (await fs.readFile(file, 'utf8')).includes(start);
            }
            const out = await this.execCapture(
                `grep -c "${Files.escapeSed(start)}" "${file}" 2>/dev/null || true`);
            return parseInt(String(out).trim(), 10) > 0;
        } catch (err) {
            return false;
        }
    }

    async uninstall(operation) {
        if (operation.kind === 'block') {
            await this.removeBlock(operation.file, operation.marker);
            return;
        }
        const emptyOnly = new Set(operation.emptyOnly || []);
        for (const target of operation.paths) {
            if (emptyOnly.has(target)) {
                await this.removeIfEmpty(target);
                continue;
            }
            await this.removePath(target);
        }
    }

    // ---- manifest and prune ------------------------------------------------

    async readManifest() {
        let raw;
        try {
            if (this.isLocal) {
                if (!await fs.pathExists(this.manifestPath)) return null;
                raw = await fs.readFile(this.manifestPath, 'utf8');
            } else {
                raw = await this.execCapture(`cat "${this.manifestPath}" 2>/dev/null || true`);
            }
        } catch (err) {
            return null;
        }
        if (!raw || !String(raw).trim()) return null;

        try {
            const parsed = JSON.parse(String(raw));
            return Array.isArray(parsed.entries) ? parsed : null;
        } catch (err) {
            // Corrupt is treated as absent — prune nothing — but say so, because
            // silently pruning nothing looks identical to working correctly.
            console.warn(
                `files: ${this.manifestPath} is not valid JSON; skipping prune this run.`
            );
            return null;
        }
    }

    async writeManifest(placed) {
        const manifest = {
            version: 1,
            bakelet: 'files',
            name: this.name,
            written: new Date().toISOString(),
            entries: placed
        };
        const body = JSON.stringify(manifest, null, 2);

        if (this.isLocal) {
            await fs.outputFile(this.manifestPath, body + '\n');
            return;
        }
        await this.exec(`mkdir -p "${this.envRoot}"`);
        await this.exec(`cat > "${this.manifestPath}" <<"BAKER_MANIFEST"\n${body}\nBAKER_MANIFEST`);
    }

    // Removes what the previous bake placed and this one did not. Driven only by
    // the previous manifest, so a path Baker never placed cannot be reached.
    async pruneStale(previous, placed) {
        if (!previous) return;

        const current = new Set(placed.map((e) => e.path));
        const stale = previous.entries.filter((e) => !current.has(e.path));

        for (const entry of stale) {
            // Absolute and ~ entries are never pruned: a mistake must not be
            // able to reach into the user's home directory.
            if (Files.isAbsoluteish(entry.path)) continue;

            let target;
            try {
                target = this.resolveDest(entry.path);
            } catch (err) {
                console.warn(`files: skipping prune of ${entry.path} — ${err.message}`);
                continue;
            }
            if (target.absolute) continue;

            if (entry.mode === 'append') {
                await this.removeBlock(target.full, entry.marker || this.name);
                continue;
            }
            if (entry.mode === 'dir') {
                await this.removeIfEmpty(target.full);
                continue;
            }
            await this.removePath(target.full);
        }
    }

    async removePath(full) {
        if (this.isLocal) {
            if (!await fs.pathExists(full)) return;
            await fs.remove(full);
            await this.removeEmptyParents(path.dirname(full));
            return;
        }
        await this.exec(`rm -rf "${full}"`);
        await this.exec(`rmdir -p "${path.posix.dirname(full)}" 2>/dev/null || true`);
    }

    // Walks up removing directories that are now empty, stopping at envRoot so
    // the environment itself is never removed.
    async removeEmptyParents(dir) {
        const root = this.envRoot;
        let current = dir;
        while (current !== root && current.startsWith(root + path.sep)) {
            let remaining;
            try {
                remaining = await fs.readdir(current);
            } catch (err) {
                return;
            }
            if (remaining.length) return;
            await fs.remove(current);
            current = path.dirname(current);
        }
    }

    async removeIfEmpty(full) {
        if (this.isLocal) {
            try {
                const remaining = await fs.readdir(full);
                if (!remaining.length) await fs.remove(full);
            } catch (err) { /* already gone */ }
            return;
        }
        await this.exec(`rmdir "${full}" 2>/dev/null || true`);
    }

    async removeBlock(full, marker) {
        const name = marker || this.name;
        if (this.isLocal) {
            if (!await fs.pathExists(full)) return;
            const existing = await fs.readFile(full, 'utf8');
            await fs.writeFile(full, this.stripBlock(existing, [name]));
            return;
        }
        await this.exec(
            `[ -e "${full}" ] && ` +
            `sed -i "/^${Files.escapeSed(Files.markerStartFor(name))}$/,` +
            `/^${Files.escapeSed(Files.markerEndFor(name))}$/d" "${full}" || true`
        );
    }
}

module.exports = Files;
