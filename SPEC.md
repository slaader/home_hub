# Home Hub: specification

Home Hub is one page for a home network: which machines there are and how they are doing, what runs where and
what depends on what, who may reach it, and a small tracker for your own projects. It is a single Node process
with no third-party dependencies and a plain-JavaScript front end.

## Scope

Core features:

- **Sign-in and access** — one built-in administrator, read-only viewers, service accounts with scopes and API
  keys, device tokens for native clients, an access audit. Sessions and keys are stored as SHA-256 hashes.
- **Overview** — a tile per machine from the site configuration, plus devices added in the UI. Live CPU, GPU,
  power, temperature and memory come from the Thermo app when it runs on the machine (optional).
- **Inventory** — one checked file (`data/knowledge.json`): machines, runtimes, tools, stores and how they
  depend on each other, shown as a map and as a services catalog. Secrets are recorded as locations, never values.
- **Security** — SSH key inventory, OS and software versions with update candidates, host protection checks.
  Collected over SSH by read-only probes.
- **Router** — client census from a UniFi gateway (read-only adapter).
- **Project tracker, review, search** — projects, releases, tickets with attachments; review sets of variants
  with decisions; full-text search over both.
- **MCP endpoint** — the same data and writes for agents, limited by the key's scopes.

Everything else is a plugin (`docs/plugins.md`): a household adds its own features and its own configuration
in `local/` without changing core.

## Structure

| Path | |
|---|---|
| `server/index.mjs` | Request pipeline: headers, credentials, origin and scope checks, body limits, error replies |
| `server/plugins.mjs` | The module registry: the contract core features and plugins share |
| `server/core/` | Core features as modules: routes, pages, assets |
| `server/site-config.mjs` | The site configuration, validated |
| `server/*-store.mjs`, `server/db.mjs` | State: SQLite (`state/hub.db`) and JSON files (`docs/storage.md`) |
| `public/` | The UI: `app.js` (shell), one module per page, `ui.js` and `tokens.css` (shared pieces) |
| `scripts/` | Collectors, the inventory checker and editor, the export |
| `tests/` | Core tests; `tests/fixtures/site.json` is the generic site they run on |
| `local/` | The overlay: `site.json`, `plugins/`, pictures. Not part of a public export |

Commands: `node server/index.mjs`, `npm test`, `node scripts/collect-systems.mjs`,
`node scripts/collect-security.mjs`, `node scripts/check-knowledge.mjs`.

## Code style

Use ES modules, small functions, explicit validation, and text-safe DOM rendering: strings reach the page only
through text nodes and attributes (`el()` in `public/views.js`), never through `innerHTML` built from data.
Validate input where it enters (request bodies, files read from disk, probe output) and fail closed.
Distinguish what was observed from what is assumed: `softwareVersion`, `firmwareVersion` and `protocolVersion`
are different facts; an unknown value is `null`, not a guess.

## Boundaries

- No secrets reach the browser or the inventory: tokens and passwords are stored hashed, bodies and tokens are
  never logged, the inventory checker rejects anything that looks like a secret.
- Collectors are read-only on the machines they probe.
- An observation older than 3 minutes is stale. A failed probe is not proof that a device is off; a DHCP lease is
  not proof that it is connected.
- Every write is checked twice: by role or scope at the pipeline, and by revision or hash at the store
  (a stale write is refused, never merged silently).
- The UI works at 320, 768, 1024 and 1440 px, by keyboard and on touch.

## Language

UI strings are written in Czech in the code and translated through `public/i18n-en-*.js`. A browser starts in
the site's `defaultLanguage` (English without a site configuration) until its user chooses.
