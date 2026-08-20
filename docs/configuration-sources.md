# Configuration sources

`baker bake` needs a directory containing a `baker.yml`. It accepts several ways of naming one,
all through a single optional positional argument:

```bash
baker bake                                # ./baker.yml
baker bake ./path/to/dir                  # a directory containing baker.yml
baker bake owner/repo                     # clone a GitHub repo, use its top-level baker.yml
baker bake owner/repo@PM3                  # clone at a branch or tag
baker bake https://github.com/o/r/tree/…  # a tree URL — clone and use a subdirectory
baker bake https://gist.github.com/…      # a gist
baker bake https://…/raw/…/baker.yml      # a raw file
```

Everything resolves to a local directory before provisioning starts, so the rest of the pipeline
sees one shape regardless of where the config came from.

## Resolution order

`resolveSource()` tries these in order and stops at the first that applies:

1. **No argument** — use the current working directory. Errors if `./baker.yml` is missing.
2. **An existing local path** — checked against the filesystem *first*, so a real directory always
   wins over a same-looking GitHub shorthand.
   - A directory: used as-is; errors if it has no `baker.yml`.
   - Any other file: error.
3. **A URL or `owner/repo` shorthand** — classified by syntax and fetched.
4. Otherwise: `Could not resolve baker source "<x>"`.

Because step 2 precedes step 3, a local directory literally named `./owner/repo` shadows the
GitHub shorthand. That's deliberate.

## `bake` takes directories, and the file is always `baker.yml`

Two rules, applied everywhere an address can point:

- **A file is never an argument.** `baker bake ./project/baker.yml` is rejected and names the
  directory to pass instead. `baker bake` reads a *directory*.
- **The file it reads is literally `baker.yml`** (or `baker.yaml`). A differently-named config used
  to be accepted and silently copied into the cache under the right name; it is now rejected with
  the `mv` that fixes it.

```
$ baker bake ./PM3.yml
==> ./PM3.yml is a file. `bake` reads a directory whose top level holds a baker.yml.
    If this is your config, rename it: mv PM3.yml baker.yml
```

The same rule applies to remote single files: a raw URL must end in `baker.yml`, and a gist must
contain one. The one place it cannot be enforced is a **GitLab snippet**, whose `/raw` endpoint
returns the primary file with no filename in the URL.

**`baker cleanup` accepts exactly the same addresses as `baker bake`** — both call the same
resolver, so an address that bakes will clean up and one that is rejected is rejected identically.

## GitHub shorthand

`owner/repo` clones `https://github.com/owner/repo.git` into Baker's cache and uses the `baker.yml`
at its **top level**. That is the only place `bake` looks.

### Selecting a variant with `@ref`

`owner/repo@<branch-or-tag>` clones at that ref. This is how one repository carries several
variants — assignments in a course, conditions in a study:

```bash
baker bake your-org/configs@PM2
baker bake your-org/configs@PM3
baker bake your-org/configs@release/1.2   # refs may contain slashes
```

Baker keeps **one cache directory per repository**, not per ref: switching refs checks the existing
clone out rather than cloning again. A re-bake at a different ref therefore converges — the
`files:` manifest prunes what the previous ref placed and this one does not.

### Sub-directory addressing was removed

`owner/repo:subdir` used to select a `baker.yml` below the root. It is now rejected:

```
your-org/configs:assignments/PM3 addresses a sub-directory, which `bake` no longer supports.
A repository must hold its baker.yml at the top level.
To select a variant, use a branch or tag: your-org/configs@PM3
```

The rejection happens **before any network access**, so a mistyped address costs nothing.

Two consequences worth knowing:

- Every path in the config is relative to the repository root, and `files: src:` may not climb
  above it. A `src: ../../base/` overlay — the old way to share content between subdirectories —
  is an error.
- Shared content between variants is a **git** concern now, not a path concern: keep the common
  material on a base branch and merge it into each variant.

An address ending in `.yml` or `.yaml` is also rejected, because it names a file — that is
`baker check`'s grammar, not `bake`'s. See below.

## URLs

A bare URL is ambiguous between "clone this repo" and "fetch this one file". Baker disambiguates:

| URL shape | Action |
|-----------|--------|
| ends in `.git` | clone |
| a GitHub/GitLab **tree** URL | clone at that ref, use the subdirectory |
| a gist or GitLab snippet page | fetch the single file |
| a raw URL whose path ends in `.yml`/`.yaml` | fetch the single file — the URL must **name** `baker.yml` |
| anything else | clone |

### Tree URLs

`https://github.com/ottomatica/baker-examples/tree/master/jenkins` clones the repo at branch
`master` and returns the `jenkins/` subdirectory. GitLab's `/-/tree/` form works too, including
nested groups.

One caveat: a branch name containing a slash (`feature/x`) can't be separated from the subpath
without an API call, so only single-segment refs work.

### Gists and snippets

GitHub gists are fetched through the API. The gist must contain a file named `baker.yml` or
`baker.yaml`. There is **no first-file fallback** — a multi-file gist without one is an error naming
what it did contain, rather than silently baking whichever file happened to be first.

GitLab snippets are fetched by appending `/raw` to the snippet URL. For a multi-file snippet that
returns the primary file only.

Both are host-derived rather than hardcoded, so GitHub Enterprise (`<host>/api/v3`,
gists under `/gist/`) and self-hosted GitLab work the same as the cloud instances.

## Explicit flags

The older flags still work and bypass the resolver entirely. Use them when you want no ambiguity:

| Flag | Alias | Behavior |
|------|-------|----------|
| `--local <path>` | `-l` | Directory containing `baker.yml` |
| `--repo <url>` | `-r` | Clone a git repository |
| `--file <url>` | `-f` | Fetch a single `baker.yml` from a gist/snippet/raw URL |

`--box` and `--remote` were removed: both routed to methods (`provider.bakeBox`,
`BakerObj.bakeRemote`) that no longer exist anywhere. Use the `remote:` key in `baker.yml` to
configure a remote host.

## One grammar per verb

`bake` and `check` share one classifier but accept **disjoint** address forms. Baker's names a
repository; opunit's ends in `.yml`:

```bash
baker bake  your-org/configs@PM3         # a repository, at a ref
baker check your-org/profiles:env.yml    # a profile file, passed to opunit
```

`lib/commands/check.js` imports `classifyRemote` from the resolver, so the two vocabularies are
kept provably disjoint in one place. Giving `bake` a `:file.yml` address is an error that names
`baker check`, rather than silently doing the wrong thing:

```
your-org/profiles:env.yml addresses a file. `bake` takes a repository whose top-level
directory holds a baker.yml — try owner/repo
To run an opunit profile, use: baker check your-org/profiles:env.yml
```

## The checkout and the cache

Baking a repository produces two copies of it, and the difference between them is the whole point.

**The checkout** is yours. It lands where you can see it — `<local:>/<repo>`, or `./<repo>` when the
config names no host directory — and Baker never forces anything onto it. A clean checkout is
fast-forwarded on the next bake; one with uncommitted changes, untracked files, or unpushed commits
is reported and left alone. Nothing you have not pushed is ever discarded.

**The cache** is Baker's. Everything it clones or fetches also goes under `~/.baker/cache/`:

```
~/.baker/cache/<host>/<owner>/<repo>/   clones
~/.baker/cache/fetch/<hash>/            single-file fetches (raw URL, gist, snippet)
~/.baker/cache/profiles/<owner>/<repo>/<sha>/<file>
                                        opunit profiles for `baker check`
```

The cache exists because of a chicken-and-egg problem: where the checkout belongs is written in the
config, so Baker has to read the config before it can know. It clones to the cache, reads `local:`,
and only then places your checkout. Re-running the same address updates the cached clone, and local
modifications inside the cache are discarded on the next run — safe precisely because the cache is
never the copy you work in. Single-file sources (gists, snippets, raw URLs) describe no repository
to check out, so they are fetched to the cache only and write nothing to your working directory.

The profile directory is **content-addressed**: the path names the commit, so a cached profile is
the right bytes by construction and is never revalidated. `baker check` still runs one
`git ls-remote` per invocation, because that is what proves the profile is current — only the
download is skipped.

The cache is disposable. Deleting it costs one re-clone:

```bash
rm -rf ~/.baker/cache
```
