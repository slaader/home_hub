# Changelog

Home Hub core, newest first. One section per release; the section is the text of that release on GitHub
(`node scripts/release.mjs <version> --notes` prints it). Parts, in this order, empty ones left out:
**Added**, **Changed**, **Fixed**, **Plugin contract**, **Data**, **Upgrade notes**. What the version number
promises is in `AGENTS.md` → Versioning. The top section is the release being prepared: a change to the public
surface adds its line there in the same commit.

## 1.1.0

Home Hub has a version, and tells you when a newer one is out.

### Added

- **Version.** `package.json → version` is the source of truth. The footer shows it (`version 1.1.0`, or
  `1.1.0+dev` on a checkout that is not on its release tag, with the commit and deploy time in the tooltip), and so do
  the start-up line, `GET /api/ui/manifest` (`version`, `development`, signed in only), the MCP `serverInfo.version`
  and the new read-only MCP tool `hub_version`. `/healthz` still says only `{ok:true}`.
- **`<state>/run.json`** (0600), written when the server listens: `{version, commit, exact, dataEpoch, pid, startedAt,
  plugins}`.
- **Update check.** A core module asks GitHub about twice a day whether a newer release exists and says so on
  Administration → Integrations (card `updates.check`: release notes, "Test now", the switch) and, for an
  administrator, in the footer (`→ 1.2.0`). It only tells; nothing installs an update. A failed check never
  reads as "up to date". `GET /api/updates` (scope `read`), `POST /api/updates/check` and
  `POST /api/updates/dismiss` (administrator, password sign-in). On by default: turn it off with the switch or
  `HOME_HUB_UPDATE_CHECK=off`. The README says exactly what is contacted.
- **`site.json → updates`**: `repo` (follow a fork), `channel` (`stable` or `prerelease`), `intervalHours` (6 to 168).
- **`package.json → homeHub`**: `dataEpoch` (rises with every change of on-disk format) and `updates.repo`
  (where releases are published).
- **Release tooling**: this file, `scripts/release.mjs` (checks, bumps, commits, tags; never pushes) and
  `tests/data-epoch.test.mjs`.

### Changed

- The footer no longer says "private edition" or "public edition"; it says the version.
- The start-up line names the version and the plugins: `Home Hub 1.1.0 (public edition, 0 plugin(s)) listening on 8781`.
- MCP `serverInfo.version` is the release version (it was the constant `2`).
- A refused request of `createFetchJson` (`server/systems-upstream.mjs`) carries `rateLimit: {remaining, retryAt}`
  when the answer was a 403 or 429.

### Plugin contract

- `hub.version`: `{version, dataEpoch, commit, exact, label}`.
- `server/integrations.mjs` is unchanged; the update check is an ordinary integration of kind `upstream`.

### Data

- Epoch 1 (the first numbered one). New file `<state>/updates.json` (0600): the last answer of the update check and
  its ETags. An older Home Hub ignores it; deleting it only costs one full check.

### Upgrade notes

- From 1.0.0: pull (or check out `v1.1.0`) and restart. Nothing to migrate.
- The hub now makes outgoing requests to `api.github.com` on its own. If that is not wanted, set
  `HOME_HUB_UPDATE_CHECK=off` before the first start of this version.

## 1.0.0

The first numbered release: the public core as it stood on 2026-11-12. It names what was already published;
no code changed for it.

### Added

- The overview with Thermo and agent-less telemetry, the inventory map and services catalog, software versions and
  host protection, SSH keys, the router census, the tracker, review, search, LLM runtimes and the LLM & Diffusion
  page, backup jobs, the Git LFS view, integrations, users, roles, service accounts and API keys, and the MCP
  endpoint.
- The module contract for plugins (`docs/plugins.md`) and the site configuration (`local/site.json`).
