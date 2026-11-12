# Home Hub: agent rules

Node 22+ ES-modules backend (`server/*.mjs`) + vanilla-JS UI (`public/`) + an MCP endpoint.
**Zero third-party npm dependencies** — that is a rule, not an accident. Do not `npm install` to solve a problem.

If `local/AGENTS.md` exists, read it too: it describes the deployment this checkout is.

## Core and overlay

This repository is two things kept apart on purpose:

- **Core** — everything outside `local/`. Generic: it knows no household. Sign-in, users, service accounts,
  scopes and API keys, the version and the update check, the overview with the Thermo telemetry client, the inventory map and services catalog,
  the tracker, review, search, the SSH-key and versions collectors, the router adapter, the Git LFS view (git hosts over their API and git), the integrations page
  (what the hub reads from outside, the switch that turns each off, and every machine with what is set up for it), the MCP endpoint.
- **Overlay** — `local/`. One household's configuration (`local/site.json`), its plugins
  (`local/plugins/<id>/`), pictures, deployment recipes and runbooks. In the private repository it is tracked;
  a public export leaves it out. A public checkout has no `local/` until its owner creates one.

`edition.json` says which tree this is (`private` or `public`; `server/edition.mjs`, `HOME_HUB_EDITION` overrides
it in tests). Do not branch on the edition to change behaviour: what differs between households belongs in
`local/site.json`, what only one household has belongs in a plugin.

Rules that keep the split honest:

- **Core never imports from `local/`.** A plugin reaches core through the module registry only.
- **A plugin registers; it does not edit core tables.** Scopes, routes, MCP tools, pollers, assets, integrations
  and sidebar entries are declared in the plugin's `index.mjs` (`server/plugins.mjs` is the contract, `docs/plugins.md` the
  guide). Never add a plugin's route to `server/core/`, its scope to `server/scopes.mjs`, its tool to
  `server/mcp.mjs` or its page to `public/app.js`.
- **No household values in core**: no real names, addresses, host names, user names or home paths. Use the
  placeholders (`example.lan`, `10.0.0.x`, `alice`). `tests/leak.test.mjs` scans the files an export would
  include and fails `npm test` on a finding; `node scripts/leak-scan.mjs` lists them.
- **Machines, networks, names and time zone come from `server/site-config.mjs`**, never from a constant.
  A missing `local/site.json` must leave an empty, working hub.

## Verification tiers

| Tier | What counts as it | Run |
|---|---|---|
| **S — small** | Copy, styling, a README/SPEC line, a doc-only change | `npm test` |
| **M — medium** | One module or endpoint changes, no contract change | `npm test` |
| **L — large** | Auth, tokens/scopes, MCP write path, the module contract, site config, knowledge/inventory schema, a collector that touches other hosts, anything that changes `docs/API.md`, the version and release tooling (`server/version.mjs`, `scripts/release.mjs`), the update check | `npm test` + the python suites + a live preview smoke test |

`npm test` runs `scripts/run-tests.mjs`: the core tests (`tests/*.test.mjs`) on a generic fixture site
(`tests/fixtures/site.json`) with no plugins, then, when `local/` exists, the overlay's tests
(`local/plugins/*/tests/*.test.mjs`, `local/tests/*.test.mjs`) with that site and its plugins. It takes under
ten seconds. **There is no reason to run a subset on this repo** — do the whole thing every time, always.

The run ends with one line per half and a total, and exits non-zero when either half failed. In a tree with
an overlay it looks like this (the `overlay` numbers are that household's):

```
core     tests 611  pass 610  fail 0  skipped 1
overlay  tests 78  pass 78  fail 0
total    tests 689  pass 688  fail 0
```

- **Core: 611 tests in 83 files (2026-11-12), and none may fail, on any machine.** In a tree that has
  `local/`, one is reported as skipped: `public edition: no overlay in the tree…` checks an export, and it
  runs there, so an export passes 611 of 611 with no `overlay` line.
- **Overlay: whatever the household added.** Its count, and which of its tests need files that are not in
  git (data, generated media, a runtime on another machine), are written down in `local/AGENTS.md`. A failing
  overlay test that is not on that list is a real failure.

```bash
npm test                                     # core, then the overlay when there is one
npm test -- tests/security.test.mjs          # one file, while iterating only (the runner sets the right site)
python3 tests/router_unifi_test.py           # the UniFi collector (10 tests), separately
LOCAL_PREVIEW=1 PORT=8891 AUTH_FILE=/abs/path/test-auth.json DATA_DIR=/abs/scratch/data node server/index.mjs
```

Core tests must pass on any machine: they use the fixture site, placeholder addresses and no network. A test
that needs a household's own data or machines is an overlay test.

## Versioning: semver, released from tags

Core is versioned with semver. `package.json → version` is the source of truth (`server/version.mjs` reads it);
the footer, `GET /api/ui/manifest`, the MCP `serverInfo`, the tool `hub_version`, the start-up line and
`<state>/run.json` show it. Releases are annotated tags `vX.Y.Z` with a GitHub Release each; `CHANGELOG.md` has
one section per version, and that section is the text of the Release. A checkout that is not on the tag of its
version is a development build and says so (`1.1.0+dev`).

What the number promises (the public surface): the HTTP API in `docs/API.md`, the MCP tools, the plugin
contract (`docs/plugins.md`: module fields, the `hub` object, extension points, the browser modules a plugin
page imports), `site.json`, the environment variables, script names and flags, and that state written by any
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
- In a tree with an overlay (private history) the tag goes on the commit of the public export, on the orphan
  branch, never on a commit of this history; the script does that itself. The tagger is a neutral identity.
- Tags are SSH-signed when `git config user.signingkey` is set (`--sign` insists, `--unsigned` declines without
  the warning). The public key belongs in `config/release-signers`; the script prints how to set it up.
- Every change that touches the public surface adds a line to the top section of `CHANGELOG.md` in the same commit.
- A breaking change needs a deprecation in an earlier MINOR and the owner's agreement. Prefer adding.
- Migrations are forward-only. Older code refuses newer state (`server/db.mjs`, `server/update-check.mjs`); it
  never "tries anyway".
- The update check (`server/update-check.mjs`, core module `updates`) only tells. Nothing in the hub applies
  an update: no route, no button, no MCP tool. Where releases are published is one line,
  `package.json → homeHub.updates.repo`; nothing else in core names that repository.
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

## Worktrees and large files

Do feature work in a worktree off `origin/main`; remove it once merged. A worktree changes nothing about
deployment. Never run a live instance from a worktree.

- `node_modules` is empty by design (no third-party deps), so worktrees are effectively free here.
- **No LFS, and don't add it.** A site's large pictures belong in its overlay (`local/images/`), compressed.
- Generated media (benchmark images, audio) stays untracked.
