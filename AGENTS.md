# Home Hub: agent rules

Node 22+ ES-modules backend (`server/*.mjs`) + vanilla-JS UI (`public/`) + an MCP endpoint.
**Zero third-party npm dependencies** — that is a rule, not an accident. Do not `npm install` to solve a problem.

If `local/AGENTS.md` exists, read it too: it describes the deployment this checkout is.

## Core and overlay

This repository is two things kept apart on purpose:

- **Core** — everything outside `local/`. Generic: it knows no household. Sign-in, users, service accounts,
  scopes and API keys, the overview with the Thermo telemetry client, the inventory map and services catalog,
  the tracker, review, search, the SSH-key and versions collectors, the router adapter, the integrations page
  (what the hub reads from outside, and the switch that turns each off), the MCP endpoint.
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
| **L — large** | Auth, tokens/scopes, MCP write path, the module contract, site config, knowledge/inventory schema, a collector that touches other hosts, anything that changes `docs/API.md` | `npm test` + the python suites + a live preview smoke test |

`npm test` runs `scripts/run-tests.mjs`: the core tests (`tests/*.test.mjs`) on a generic fixture site
(`tests/fixtures/site.json`) with no plugins, then, when `local/` exists, the overlay's tests
(`local/plugins/*/tests/*.test.mjs`, `local/tests/*.test.mjs`) with that site and its plugins. It takes under
ten seconds. **There is no reason to run a subset on this repo** — do the whole thing every time, always.

The run ends with one line per half and a total, and exits non-zero when either half failed. In a tree with
an overlay it looks like this (the `overlay` numbers are that household's):

```
core     tests 397  pass 396  fail 0  skipped 1
overlay  tests 76  pass 76  fail 0
total    tests 473  pass 472  fail 0
```

- **Core: 397 tests in 52 files (2026-11-10), and none may fail, on any machine.** In a tree that has
  `local/`, one is reported as skipped: `public edition: no overlay in the tree…` checks an export, and it
  runs there, so an export passes 397 of 397 with no `overlay` line.
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

## Versioning — deliberately not semver

`package.json` says `1.0.0` and has never been bumped; nothing reads it. There are no git tags and no CHANGELOG.
Keep it that way, because:

- This is a **continuously deployed single-host application**, not a published artifact. No consumer pins a
  version — the web UI, native apps and the MCP clients all talk to whatever is running right now.
- A version nobody can install is theatre. The real anchors are the git commit and the pre-change archive.
- If you want a rollback anchor per deploy, tag `deploy-YYYYMMDD-HHMM` (pointing at the deployed commit). Those
  are un-orderable on purpose — they are timestamps, not releases.

Add real versioning only when there are two supported versions at once. If a native client starts needing
compatibility guarantees, version the **API** in `docs/API.md`, not `package.json`.

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
