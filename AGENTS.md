# Home Hub: agent rules

Node 22+ ES-modules backend (`server/*.mjs`) + vanilla-JS UI (`public/`) + an MCP endpoint.
**Zero third-party npm dependencies** — that is a rule, not an accident. Do not `npm install` to solve a problem.

This repository is core, and it is public: every commit and tag pushed here is published (Development, below).
A household's plugins and configuration live in repositories and directories of their own; when the work is about
them, read that repository's `AGENTS.md`.

## Core and plugins

Two things kept apart on purpose:

- **Core** — this repository. Generic: it knows no household. Sign-in, users, service accounts,
  scopes and API keys, the version, the update check and the update command, the overview with the Thermo telemetry client, the inventory map and services catalog,
  the tracker, review, search, the SSH-key and versions collectors, the router adapter, the Git LFS view (git hosts over their API and git), the integrations page
  (what the hub reads from outside, the switch that turns each off, and every machine with what is set up for it), the MCP endpoint.
- **Plugins and configuration** — one household's, outside this repository. Plugins are `plugins/<id>/` (with
  `plugin.json` and `index.mjs`) in a **plugin source**, a directory with `plugins/` and a `package.json`, usually a
  repository of its own; the hub finds them through `HOME_HUB_HOME/instance.json → sources.plugins` or
  `HOME_HUB_PLUGINS_DIR` (`docs/plugins.md` → Where plugins are). The site file, the software watch list and the
  pictures are in the instance's `config/` (`HOME_HUB_HOME`, `HOME_HUB_CONFIG_DIR`); data and secrets in its
  `data/` and `private/` (`docs/storage.md`).

The in-tree overlay `local/` (`local/site.json`, `local/plugins/<id>/`) is still the default when none of those
variables is set, and `npm test` still runs its tests, but it is **deprecated and goes in 2.0**: build nothing new
on it, and never commit it here (`.gitignore` leaves it out). `edition.json` (`server/edition.mjs`) is deprecated
too: it says `public`, and nothing new may read it or branch on it. What differs between households belongs in
`site.json`, what only one household has belongs in a plugin.

Rules that keep the split honest:

- **Core never imports from a plugin.** A plugin reaches core through the module registry, and imports core only
  by name (`home-hub/plugin-api`, `home-hub/testing`).
- **A plugin registers; it does not edit core tables.** Scopes, routes, MCP tools, pollers, assets, integrations
  and sidebar entries are declared in the plugin's `index.mjs` (`server/plugins.mjs` is the contract, `docs/plugins.md` the
  guide). Never add a plugin's route to `server/core/`, its scope to `server/scopes.mjs`, its tool to
  `server/mcp.mjs` or its page to `public/app.js`.
- **No household values in core**, not in a file, a commit message, a commit identity or a tag: no real names,
  addresses, host names, user names or home paths. Use the placeholders (`example.lan`, `10.0.0.x`, `alice`).
  `tests/leak.test.mjs` scans the tracked files and fails `npm test` on a finding; `node scripts/leak-scan.mjs`
  lists them; the pre-push hook refuses a push that would publish one (Development).
- **Machines, networks, names and time zone come from `server/site-config.mjs`**, never from a constant.
  A missing site file must leave an empty, working hub.

## Verification tiers

| Tier | What counts as it | Run |
|---|---|---|
| **S — small** | Copy, styling, a README/SPEC line, a doc-only change | `npm test` |
| **M — medium** | One module or endpoint changes, no contract change | `npm test` |
| **L — large** | Auth, tokens/scopes, MCP write path, the module contract, site config, knowledge/inventory schema, a collector that touches other hosts, anything that changes `docs/API.md`, the version and release tooling (`server/version.mjs`, `scripts/release.mjs`), the update check, the update command (`scripts/update.mjs`, `server/update-apply.mjs`, `server/update-config.mjs`), where things are (`server/paths.mjs`), `plugin.json` and the plugin API exports (`server/plugin-api.mjs`, `tests/plugin-testing.mjs`, `server/semver.mjs`), the host-agent installer (`scripts/install-host-agent.mjs`, `server/agent-closure.mjs`), the leak scan and the pre-push hook (`scripts/leak-scan.mjs`, `scripts/pre-push.mjs`, `scripts/hooks/`) | `npm test` + the python suites + a live preview smoke test |

`npm test` runs `scripts/run-tests.mjs`: the core tests (`tests/*.test.mjs`) on a generic fixture site
(`tests/fixtures/site.json`) with no plugins. It takes under fifteen seconds. **There is no reason to run a subset
on this repo** — do the whole thing every time, always. It ends with a summary and exits non-zero on a failure:

```
core     tests 667  pass 667  fail 0
total    tests 667  pass 667  fail 0
```

- **Core: 667 tests in 90 files (2026-11-13). None may fail and none is skipped, on any machine.** One of them,
  `public edition: no overlay in the tree…`, fails in a checkout that has `local/site.json` or `local/plugins/`:
  develop core without them.
- **Plugins test themselves.** A plugin source runs its tests against this core with
  `node scripts/run-tests.mjs --plugins <source> [--site <file>]` (`docs/plugins.md` → Tests); its counts, and
  which of its tests need files that are not in git, are written down in that source's `AGENTS.md`. A checkout that
  still has the deprecated `local/` gets a second run, `overlay`, with that site and its plugins.

```bash
npm test                                     # the core tests
npm test -- tests/security.test.mjs          # one file, while iterating only (the runner sets the right site)
python3 tests/router_unifi_test.py           # the UniFi collector (10 tests), separately
LOCAL_PREVIEW=1 PORT=8891 AUTH_FILE=/abs/path/test-auth.json DATA_DIR=/abs/scratch/data node server/index.mjs
```

Core tests must pass on any machine: they use the fixture site, placeholder addresses and no network. A test
that needs a household's own data or machines belongs in that household's plugin source.

## Versioning: semver, released from tags

Core is versioned with semver. `package.json → version` is the source of truth (`server/version.mjs` reads it);
the footer, `GET /api/ui/manifest`, the MCP `serverInfo`, the tool `hub_version`, the start-up line and
`<state>/run.json` show it. Releases are annotated tags `vX.Y.Z` on `main` with a GitHub Release each; `CHANGELOG.md` has
one section per version, and that section is the text of the Release. A checkout that is not on the tag of its
version is a development build and says so (`1.1.0+dev`).

What the number promises (the public surface): the HTTP API in `docs/API.md`, the MCP tools, the plugin
contract (`docs/plugins.md`: module fields, the `hub` object, extension points, `plugin.json`, the named exports
`home-hub/plugin-api` and `home-hub/testing`, the browser modules a plugin page imports), `site.json`, the
environment variables, script names and flags, and that state written by any
earlier release of the same major migrates forward. Page layout, wording and styling are not part of it.

- **MAJOR**: something on that surface is removed, renamed or changes meaning, a configuration or plugin that
  was valid is refused, or the minimum Node major rises.
- **MINOR**: additions, deprecations, and every change of on-disk format. A format change raises
  `package.json → homeHub.dataEpoch` and is written under `### Data` in the changelog;
  `tests/data-epoch.test.mjs` fails until the epoch moves with the schema constants. It cannot see a format
  that changes without a version constant: that stays a review rule.
- **PATCH**: fixes only. Never a contract change, never a data migration, so a patch can be rolled back by
  switching code alone.

Rules:

- Do not edit `version` by hand and do not tag by hand: `node scripts/release.mjs <version>` checks (clean tree
  on `main`, changelog section, the epoch rules, the leak scan, the tests on exactly what ships), bumps, commits
  and tags. `--dry-run` only checks; `--notes` prints the Release text; `--baseline <commit>` tags something
  that is already published. **It never pushes**: it prints the push and `gh release create` commands, and
  running them is the owner's decision.
- The release commit (`Release vX.Y.Z`) and the tag go on `main` of this repository, and the push the script
  prints (`git push origin main refs/tags/vX.Y.Z`) goes through the pre-push hook like any other. The tagger is a
  neutral identity (`Home Hub release`); the release commit has the repository's (Development), and the script
  refuses before committing when git would write it under one that breaks a leak rule. Its private mode, for a
  tree whose `edition.json` says `private` (the tag on a public export, on an orphan branch), is deprecated.
- Tags are SSH-signed when `git config user.signingkey` is set (`--sign` insists, `--unsigned` declines without
  the warning). The public key belongs in `config/release-signers`; the script prints how to set it up.
- Every change that touches the public surface adds a line to the top section of `CHANGELOG.md` in the same commit.
- A breaking change needs a deprecation in an earlier MINOR and the owner's agreement. Prefer adding.
- Migrations are forward-only. Older code refuses newer state (`server/db.mjs`, `server/update-check.mjs`); it
  never "tries anyway".
- The update check (`server/update-check.mjs`, core module `updates`) only tells. Nothing in the hub applies
  an update: no route, no button, no MCP tool. Where releases are published is one line,
  `package.json → homeHub.updates.repo`; nothing else in core names that repository.
- An update is applied by `node scripts/update.mjs apply <tag>` (`docs/updating.md`), run on the server outside the
  hub's process: preflight in a scratch worktree, stop, archive, switch to the tag, start, health check, and the
  previous version back on any failure. How a service is stopped, started and checked is configuration
  (`instance.json → service, health`, or `--service`, `--health`), never a label or a path in core. The steps live
  in `server/update-apply.mjs` and take the world as an argument (`exec`, `probe`, clock): keep it that way, keep its
  imports static (the command may run from the checkout it switches), and never let a test drive a real service.
  When the data epoch rises, a rollback restores the archive; so a release that changes a format must still start
  from a restored older state after the code goes back, which is what "forward-only" asks of it.
- Plugins are versioned on their own (`plugin.json → version`, or their source's `package.json`). A plugin states
  the core range it supports in `plugin.json → core`; core refuses to start with a plugin outside its range, with an
  unmet `requires`, or without a setting its `config.required` names. A plugin imports core only by name
  (`home-hub/plugin-api`, `home-hub/testing`); what those two files export is contract, everything else is internal.
- `deploy-YYYYMMDD-HHMM` tags stay what they were: timestamps of a deployment, not releases.

## Rules

- ES modules, small functions, explicit validation, text-safe DOM rendering (SPEC.md).
- Never commit or log `private/`, `data/`, `state/`, `router-private/`, or any token value. Tokens are stored
  server-side as SHA-256 hashes; bodies and tokens are never logged.
- Do not use production credentials in a preview. Stop the preview when you are done.
- Collectors are read-only: never `brew update`, never install or upgrade anything, never write on a probed host.
- `inventory_update` rejects invalid entries and anything that looks like a secret; a stale hash (optimistic
  concurrency) is refused — refetch, don't force.
- Stale after 3 minutes. A failed probe is not proof a device is off; a DHCP lease is not proof of connectivity.
- New pages use the design tokens (`public/tokens.css`) and the shared pieces in `public/ui.js` (page header,
  empty state, not-installed notice) instead of one-off markup.
- No lint, formatter, typecheck or CI exists. Do not add one for a doc change.

## Development

This repository is where core is developed. `main` here is canonical: a change is an ordinary commit, and
releases are tags on `main`. There is no private tree any more, and the export that published one is deprecated.
A private mirror for work in progress is fine: same history, and pushes to it go through the same hook. The hook
runs on the machine that pushes, so it protects only a checkout that has it enabled.

Once per checkout (the settings are the checkout's own, `git config` without `--global`; worktrees share them):

```bash
git config core.hooksPath scripts/hooks          # the pre-push hook: scripts/pre-push.mjs
git config user.name "Home Hub"                  # the neutral identity: every commit is published with it
git config user.email dev@home-hub.invalid
```

- **The hook** applies the rules of `scripts/leak-scan.mjs` to what a push would publish: every file of each
  pushed tip, every file version the new commits bring (taking a value out in a later commit does not help: the
  earlier one is published too), those commits' messages, authors and committers, and each pushed tag's name,
  message and tagger. It refuses the push and names the commit, tag or file. Fix the cause and rewrite the
  commits that carry it; **never push with `--no-verify`**.
- **No e-mail address outside the placeholder domains** in a commit, so no `Co-Authored-By:` or `Signed-off-by:`
  trailer with a real address: only `example.com|org|net|lan`, `.test`, `.invalid`, `.localhost` and OpenSSH's
  type names pass, and the hook refuses anything else.
- The hook reads only what the remote does not have yet, from that remote's tracking refs. A new, empty remote (a
  mirror) has nothing, so a first push there checks all of history, including commits from before the hook. Seed
  such a mirror from this repository on the server side (a mirror or a migration), fetch it, then push to it.

## Worktrees and large files

Do feature work in a worktree off `origin/main`; remove it once merged. A worktree changes nothing about
deployment. Never run a live instance from a worktree. The hook and the identity above cover every worktree of
the checkout.

- `node_modules` is empty by design (no third-party deps), so worktrees are effectively free here.
- **No LFS, and don't add it.** A site's large pictures belong in its own configuration (`config/images/` of the
  instance), compressed, never in core.
- Generated media (benchmark images, audio) stays untracked.
