# Configuration sources

`baker bake` needs a directory containing a `baker.yml`. It accepts several ways of naming one,
all through a single optional positional argument:

```bash
baker bake                                # ./baker.yml
baker bake ./path/to/dir                  # a directory containing baker.yml
baker bake owner/repo                     # clone a GitHub repo
baker bake owner/repo:units/one           # clone, then use the baker.yml in units/one
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

## GitHub shorthand

`owner/repo` clones `https://github.com/owner/repo.git` into Baker's cache and uses its top-level
`baker.yml`.

`owner/repo:subdir` clones the repo and uses the `baker.yml` in that subdirectory, so one repo can
carry many configs without cluttering its root:

```bash
baker bake your-org/configs:units/one
baker bake your-org/configs:units/two
```

Two constraints:

- The address must name a **directory**, and that directory must contain a literal `baker.yml`.
- An address ending in `.yml` or `.yaml` is **rejected**, because it names a file — that is
  `baker check`'s grammar, not `bake`'s. See below.

## URLs

A bare URL is ambiguous between "clone this repo" and "fetch this one file". Baker disambiguates:

| URL shape | Action |
|-----------|--------|
| ends in `.git` | clone |
| a GitHub/GitLab **tree** URL | clone at that ref, use the subdirectory |
| a gist or GitLab snippet page | fetch the single file |
| a raw URL whose path ends in `.yml`/`.yaml` | fetch the single file |
| anything else | clone |

### Tree URLs

`https://github.com/ottomatica/baker-examples/tree/master/jenkins` clones the repo at branch
`master` and returns the `jenkins/` subdirectory. GitLab's `/-/tree/` form works too, including
nested groups.

One caveat: a branch name containing a slash (`feature/x`) can't be separated from the subpath
without an API call, so only single-segment refs work.

### Gists and snippets

GitHub gists are fetched through the API. Baker looks for a file named `baker.yml`, then
`baker.yaml`, then falls back to the first file in the gist.

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
| `--box <path>` | `-b` | Directory containing `baker.yml`; routes to `bakeBox` |

`--box` is not simply an alias for `--local` — it takes a different code path
(`provider.bakeBox`).

## One grammar per verb

`bake` and `check` share one classifier but accept **disjoint** address forms. Baker's ends in a
directory; opunit's ends in `.yml`:

```bash
baker bake  your-org/configs:units/one   # a directory containing baker.yml
baker check your-org/profiles:env.yml    # a profile file, passed to opunit
```

`lib/commands/check.js` imports `classifyRemote` from the resolver, so the two vocabularies are
kept provably disjoint in one place. Giving `bake` a `:file.yml` address is an error that names
`baker check`, rather than silently doing the wrong thing:

```
your-org/profiles:env.yml addresses a file. `bake` takes a directory containing a
baker.yml — try owner/repo:path/to/directory
To run an opunit profile, use: baker check your-org/profiles:env.yml
```

## The cache

Everything Baker clones or fetches goes under `~/.baker/cache/`, **never your working directory**:

```
~/.baker/cache/<host>/<owner>/<repo>/   clones
~/.baker/cache/fetch/<hash>/            single-file fetches (raw URL, gist, snippet)
```

This matters when you run Baker from inside a repository you care about — nothing is written
there. Re-running the same address updates the cached clone rather than failing, and local
modifications inside the cache are discarded on the next run, so a dirtied cache recovers by
itself.

The cache is disposable. Deleting it costs one re-clone:

```bash
rm -rf ~/.baker/cache
```
