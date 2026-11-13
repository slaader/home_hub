# Changelog

Home Hub core, newest first. One section per release; the section is the text of that release on GitHub
(`node scripts/release.mjs <version> --notes` prints it). Parts, in this order, empty ones left out:
**Added**, **Changed**, **Deprecated**, **Fixed**, **Plugin contract**, **Data**, **Upgrade notes**. What the version
number promises is in `AGENTS.md` → Versioning. The top section is the release being prepared, `## Unreleased`
until the release gives it its number: a change to the public surface adds its line there in the same commit.

## Unreleased

Core is developed in its public repository: a change is an ordinary commit, checked for household details before
every push, instead of a private tree published through an export.

### Added

- **Pre-push hook.** `scripts/hooks/pre-push` runs `scripts/pre-push.mjs`, the rules of `scripts/leak-scan.mjs` over
  everything a push would publish: every file of each pushed tip, every file version the new commits bring (a value
  added and taken out again is still published), those commits' messages, authors and committers, and each pushed
  tag's name, message and tagger. It refuses the push and names the commit, tag or file; only what the remote does
  not have yet is read. Enable it once per checkout: `git config core.hooksPath scripts/hooks`.

### Deprecated

All of these keep working through 1.x and are removed in 2.0.

- **The export**: `scripts/export-public.mjs`, `scripts/publish-public-branch.mjs` and `npm run export:public`, and the
  private mode of `scripts/release.mjs` that publishes through them. Core is developed in the public repository, so
  nothing is exported any more. Run by hand, the two scripts say so.
- **The in-tree overlay `local/` as the default** for the site configuration (`local/site.json`,
  `local/software-watch.json`, `local/images/`) and the plugins (`local/plugins/`). Keep them outside the code: an
  instance directory (`HOME_HUB_HOME`: `config/`, and `instance.json → sources.plugins` for plugin sources), or
  `HOME_HUB_CONFIG_DIR` and `HOME_HUB_PLUGINS_DIR`.
- **`edition.json`**, `HOME_HUB_EDITION` and `server/edition.mjs` (`readEdition`, `isPublicRelease`; `readEdition` is
  also exported by `home-hub/testing`). Every tree is the public tree: the file stays `{"edition":"public"}` in 1.x
  and nothing new reads it.

### Fixed

- `scripts/release.mjs` in a public tree scans every tracked file it publishes, `README.md` and `.gitignore` included
  (it left those to `npm test`, as an export writes its own), and refuses before it commits when git would write the
  release commit under an identity that breaks a leak rule.

## 1.2.0

Updates are applied by one command with a way back, the household's data and plugins can live outside the code
checkout, and a plugin is a versioned unit that says which Home Hub it supports.

### Added

- **Instance directory.** `HOME_HUB_HOME` keeps configuration, data and secrets apart from the code: `<home>/config`
  (`site.json`, `software-watch.json`, `images/`), `<home>/data` (with `state/`), `<home>/private`. New variables
  `HOME_HUB_CONFIG_DIR` and `HOME_HUB_PRIVATE_DIR` move one part each. `server/paths.mjs` decides every default; the
  server, the scripts and the UniFi collector ask it. With none of the new variables set nothing moves.
- `sh scripts/systems/install-launchd.sh --home DIR` installs the collector jobs for an instance directory.
- **Plugins as a unit of their own.** A plugin may carry a static `plugin.json`: its version, the core range it
  supports, the plugins it `requires`, its `dataEpoch`, the settings it needs (`config.required`) and its host agents.
  Core checks it before running any plugin code. `GET /api/ui/manifest → modules[]` and the admin integrations list
  gain `version` and `source`; the start-up line, the footer tooltip and the MCP tool `hub_version` name each plugin
  with its version.
- **Several plugin directories.** `HOME_HUB_PLUGINS_DIR` takes several, separated by `:`; an instance's
  `HOME_HUB_HOME/instance.json → sources.plugins` names its plugin sources. A plugin source's `package.json` gives
  the version and core range of plugins that state none.
- `node server/index.mjs --check`: every start-up check (site, plugins, registry, auth file), then exit; writes nothing.
- `node scripts/plugins.mjs list | link`: the plugin directories, their plugins and versions, and the one link
  (`node_modules/home-hub → core`) that lets plugins outside the core tree import core by name.
- `node scripts/run-tests.mjs --plugins <source> [--site <file>]` runs a plugin source's tests against this core.
- **The update command.** `node scripts/update.mjs status | preflight [<tag>] | apply [<tag>] | rollback | backup`
  applies a release from the server's shell, outside the hub's process (`docs/updating.md`). `apply` fetches the tags,
  stages the target in a scratch worktree (its tests, every plugin's core range and `requires`, the Node version, the
  data epoch, and `node server/index.mjs --check` with the instance's own site file and plugins), stops the service,
  archives `config/`, `data/`, the state directory and `private/` with the hub stopped, switches each source to its
  tag (detached), starts the service and waits for `/healthz` and for `run.json` to show the target version and
  plugins. Any failure after the stop puts the previous version back, and a release that failed is noted in
  `<state>/updates.json → quarantined`, which the update card already shows. When the data epoch rose, going back
  also restores the archive (the replaced directories are moved aside, never deleted). A journal
  (`update-journal.json`) lets the next run put back an update that was cut short. `--plugins [<source>=]<tag>`
  switches a plugin source of an instance in the same transaction. `--root DIR` updates a checkout that has no
  update command yet (1.1.0 and older). The hub still has no route, button or MCP tool that applies anything.
- **`instance.json → service, health, backups, sources.core`**: how the instance's service is stopped and started
  (`"launchd:system/<label>"`, `"launchd:gui/<uid>/<label>"`, `"systemd:<unit>"`, `"systemd-user:<unit>"` or
  `{"stop": […], "start": […]}`), where it answers (`{"url", "seconds"}`), how many pre-update archives stay
  (`{"keep"}`) and which directory of the instance is the core checkout. Without an instance directory the same
  comes from `--service`, `--health`, `--health-seconds`, `--backups`, `--keep` and `--root`.
- `GET /api/updates → apply.command`: the command that applies the newest release (`node scripts/update.mjs apply
  <tag>`), or `null`. The update card shows it instead of "switch the checkout and restart".
- `<state>/update-history.jsonl`: one line per update, `{at, id, from, to, by, seconds, result}`.
- **Host agents.** `node scripts/install-host-agent.mjs --plugin <id> --agent <id>` installs a plugin's host agent on
  the machine it runs on: the agent's import closure as real files (no checkout, no link), its configuration rendered
  from `site.json → plugins.<id>` (placement in `plugins.<id>.agents.<agent>.<machine>`), `<target>/.agent-install.json`
  with versions, commits and checksums, a launchd or systemd service from `scripts/host-agent/`, a health check and a
  rollback to the archived copy. `--dry-run`, `--target`/`--label` for a side-by-side test, `--no-service`.

### Changed

- The scripts (`check-knowledge`, `knowledge-edit`, `manage-access`, `collect-security`'s machine descriptors) follow
  `DATA_DIR` when it is set, like the server and the other collectors already did. Without it they read the checkout's
  `data/` as before.
- `.gitignore` (and the one a public export writes) and `.dockerignore` leave out `backups/`, where the update
  command keeps its archives and journal in a checkout without an instance directory.
- `docs/docker.md` → Updating: the rebuild from a release tag, step by step, with the start-up check, the volume
  backup and the way back.
- `softwareWatchPath` (`server/site-config.mjs`) gives the same answer as `watchPath`: the list beside the site file,
  never the example in `config/`.

### Plugin contract

- `hub.pluginData(id)`: a plugin's own data directory, `<data>/plugins/<id>/` (0700, made on first use).
- `plugin.json` (`docs/plugins.md → plugin.json`) and the range syntax of `server/semver.mjs`.
- Named imports: `home-hub/plugin-api` (`server/plugin-api.mjs`) and `home-hub/testing` (`tests/plugin-testing.mjs`),
  through `package.json → exports`. These two files are the server-side contract; a plugin no longer needs a
  relative path into the core tree.
- `home-hub/plugin-api` also exports `site` and `loadSite`, for a plugin's scripts that need the site configuration,
  and `installedAgent()`, what an installed host agent is (its plugin, version, core and commit).
- `plugin.json → hostAgents[].config`: the module that says what a host agent needs to know.
- `home-hub/testing` also exports what a household's tests check their data against (the overview's machine
  definitions, the systems parser, the model graph, the runtime read paths, the inventory rules).
- A plugin without `plugin.json` still loads, with a warning. **Deprecated**: 2.0 will require `plugin.json`, and will
  no longer read plugins from `local/plugins` by default.

### Data

- Epoch 1, unchanged: nothing that 1.1.0 wrote changes format, so going back to 1.1.0 is switching the code back.
- New files, all ignored by 1.1.0: `<state>/update-history.jsonl`; `update-journal.json` and `update.lock` in the
  instance directory (without one, in `<checkout>/backups/`); the archives in `backups/`; `<data>/plugins/<id>/`
  for a plugin that uses `hub.pluginData`. `<state>/updates.json` keeps schema 1; the update command writes its
  `quarantined` part, which 1.1.0 already reads.

### Upgrade notes

- From 1.1.0: that release has no update command, so run this one's from a scratch worktree against your checkout
  (`docs/updating.md` → The first update of a release that has no update command), or do it by hand as before:
  stop the hub, back up `data/`, `private/` and the state directory, `git fetch --tags && git checkout v1.2.0`, start.
- From now on: `node scripts/update.mjs apply <tag> --service … --health …`. After an update the checkout is detached
  at the tag, so `git pull` no longer applies to it. Rehearse a rollback once (`docs/updating.md` → Rehearsing the
  rollback): it proves the service commands, the health address and the paths before a release depends on them.
- Nothing has to move. `HOME_HUB_HOME`, `instance.json`, `plugin.json` and plugin sources outside the checkout are
  all optional; a hub with everything in its checkout runs as it did.
- In Docker nothing changes but the documented procedure (`docs/docker.md` → Updating).

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
