# Configuration sources

`baker bake` needs a directory containing a `baker.yml`. It accepts several ways of naming one,
all through a single optional positional argument:

```bash
baker bake                                # ./baker.yml
baker bake ./path/to/dir                  # a directory containing baker.yml
baker bake ./env.yml                      # any .yml/.yaml file
baker bake owner/repo                     # clone a GitHub repo
baker bake owner/repo:config.yml          # clone, then use a named top-level file
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
   - A `.yml`/`.yaml` file: used directly if already named `baker.yml`, otherwise staged into a
     temp directory as `baker.yml`.
   - Any other file: error.
3. **A URL or `owner/repo` shorthand** — classified by syntax and fetched.
4. Otherwise: `Could not resolve baker source "<x>"`.

Because step 2 precedes step 3, a local directory literally named `./owner/repo` shadows the
GitHub shorthand. That's deliberate.

## GitHub shorthand

`owner/repo` clones `https://github.com/owner/repo.git` into the current directory and uses its
top-level `baker.yml`.

`owner/repo:file.yml` clones the repo and promotes the named file to `baker.yml`, so any playbooks
or templates it references still resolve alongside it.

Two constraints:

- The file must be at the **top level**. `owner/repo:sub/dir/file.yml` is rejected with an
  explicit message; sub-directory support is not implemented.
- The file must end in `.yml` or `.yaml`.

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

## Shared vocabulary with `baker check`

The `owner/repo:file.yml` form is the same address syntax opunit uses for profiles.
`lib/commands/check.js` imports `classifyRemote` from the resolver so `bake` and `check` agree on
what an address means:

```bash
baker bake  ottomatica/envs:ml.yml     # clone repo, bake ml.yml
baker check chbrown13/profile:5704.yml # opunit profile
```

## Temporary directories

Fetching a single file, or staging a differently-named local `.yml`, creates a directory under
`tmp/baker-file-<random>` relative to your current working directory.

**These are never cleaned up.** They accumulate across runs. Removing them is safe once the bake
has finished:

```bash
rm -rf tmp/baker-file-*
```
