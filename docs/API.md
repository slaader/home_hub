# Home Hub JSON API

What a client (a native app, a script, an agent) needs to read the hub and run the same actions as the web UI. `H` below stands for the origin browsers use for your hub, for example `https://hub.example.lan` (site.json → `publicOrigin`, or the `ORIGIN` environment variable).

This document covers the core. A plugin documents its own routes (see `docs/plugins.md`); agents can also use the MCP endpoint (`POST /mcp`, service-account key).

## Reaching it

- Home Hub is meant for a home network: put it behind a reverse proxy that only answers your LAN or VPN.
- Every request has ten seconds to arrive. The exception is a raw `PUT` upload (a ticket attachment, a review chunk, a device picture, a plugin's `raw` route) once its sign-in, origin and scope checks have passed: 20 minutes at most. POST bodies are limited to 16 KB (64 KB for review publish and feedback).
- Responses are `Cache-Control: no-store`.
## Authentication

Two ways to be signed in. Each one works on every `/api/*` route unless a route below says otherwise.

| | Browser | Native app |
|---|---|---|
| Credential | `homehub` cookie (HttpOnly, 12 hours) | `Authorization: Bearer hh_<64 hex>` |
| Lifetime | 12 hours from sign-in; survives restarts and deploys (`state/hub.db`, token stored as SHA-256) | Until revoked; survives restarts |
| POST needs `Origin` header | yes, exactly `https://hub.example.lan` | no |

Every POST must send `Content-Type: application/json` exactly (no `; charset=utf-8` suffix), or the server answers `403 ORIGIN_REJECTED`.

### Token flow (first launch)

1. `POST /api/session` with headers `Origin: https://hub.example.lan` and `Content-Type: application/json`, body `{"username":"admin","password":"…"}`.
   - `200 {"ok":true}` plus `Set-Cookie: homehub=<64 hex>; …`. Keep that cookie for step 2 only.
   - `401 LOGIN_FAILED` for the wrong username or password. `429 LOGIN_FAILED` after 8 failures in 15 minutes. `400 LOGIN_FAILED` for a malformed body.
2. `POST /api/devices/tokens` with the cookie, the same `Origin` and `Content-Type`, body `{"name":"Alex's iPhone"}`. The name is 1 to 60 characters with no control characters.
   - `201 {"token":"hh_…","device":{"id":"<16 hex>","name":"…","createdAt":"…","lastUsedAt":null}}`
   - **The token appears only in this response.** The server stores only its SHA-256 hash. Save it in the Keychain behind Face ID (for example `kSecAccessControlBiometryCurrentSet`).
   - This route accepts **only the cookie**. A bearer token cannot mint more tokens (`401 AUTH_REQUIRED`).
   - `409 DEVICE_LIMIT` when 20 devices already have tokens. Revoke one first.
3. Optional: `POST /api/logout` with the cookie and `Origin`, body `{}`, to drop the 12-hour browser-style session.
4. From then on, send `Authorization: Bearer <token>` on every request. No cookie and no `Origin` header are needed.

### Managing devices

- `GET /api/devices/tokens` → `{"devices":[{"id","name","createdAt","lastUsedAt","current"}]}`. `current` is `true` for the token that made the request. `lastUsedAt` is updated at most once a minute.
- `POST /api/devices/tokens/revoke` with body `{"id":"<16 hex>"}` → `{"ok":true,"devices":[…]}`. The cookie or any valid token may revoke any device, including itself; revoking yourself is how the app signs out. `404 NOT_FOUND` if the id is unknown.
- The web UI has the same list under **Services → Control → Devices with access**.
- After a revoke, the next request with that token gets `401 AUTH_REQUIRED`. The app should then delete it from the Keychain and show sign-in.

## Access: people, roles, service accounts

Who may do what is one table of **scopes** (`read`, `inventory:write`, `home:settings`, `home:write`,
`tickets:write`, `review:write`, `software:write`, `security:read`, plus whatever plugins register). A route names the scope it needs; every
caller is checked against it the same way.

| Caller | Credential | Holds |
|---|---|---|
| A person | `homehub` cookie | The scopes of their **role** |
| A service account (agent, script) | `Authorization: Bearer hhk_<64 hex>` | The scopes of the account |
| A key from before service accounts | `Authorization: Bearer hhk_<64 hex>` | `read`, or everything a write key could do before scopes existed. Never a scope added since (`security:read`, `home:write`, `software:write`, or a plugin scope marked `legacy: false`) |
| A native app | `Authorization: Bearer hh_<64 hex>` | Every scope |

**Roles.** Four are built in; administrators can add custom ones (a name, a description, a list of scopes).

| Role id | Scopes | Administration |
|---|---|---|
| `owner` | all, also ones a plugin adds later | yes. The account of `private/auth.json`; it cannot be deleted, disabled or given another role |
| `admin` | all, also later ones | yes |
| `editor` | `read` and every write scope, also later ones; not the sensitive read-only ones (`security:read`) | no |
| `viewer` | `read` | no |
| custom | exactly the scopes listed | never |

**Administration** (users, roles, service accounts, keys, the audit, device tokens) is not a scope. It
belongs to `owner` and `admin`, and only with a password sign-in. `/api/admin/*`, `/api/devices/tokens*`,
`/api/session` and `/api/profile/*` answer `403` to every API key, whatever its scopes: also to a
full-access one.

**Full access.** A service account whose stored scopes are `["*"]` holds every scope that exists when a
request is checked, so a scope a plugin registers later is covered without touching the account. It is
the only place the wildcard is accepted.

`GET /api/me` → `{id, username, name, role, roleId, roleName, authKind, canWrite, canAdmin, scopes[], build}`.
`role` is `admin` for anyone who administers (the owner included, as before roles existed), otherwise the
role id; `roleId` is the exact role (`owner`, `admin`, `editor`, `viewer` or a custom id; `null` for a key
or a device). `scopes` is the resolved list. A key reports `role: "api"` and, with the wildcard, `fullAccess: true`.

A refused call is `403` with `READ_ONLY` (the caller cannot write at all), `SCOPE_REQUIRED` (it lacks this
scope), `ADMIN_REQUIRED` (administration) or `SESSION_REQUIRED` (password sign-in only).

### Administration (administrator, password sign-in)

- `GET /api/admin/users` → `{users:[{id, username, name, role, roleId, roleName, admin, scopes, permission, disabled, createdAt, passwordAt, builtin}], roles}`.
- `POST /api/admin/users` `{username, name?, password?, role?}` → `201 {user, initialPassword?}`. `role` is an assignable role id (default `viewer`; never `owner`). Without `password` one is generated and returned once.
- `POST /api/admin/users/action`: one change per call, `{id, disabled}` | `{id, role}` | `{id, name}` | `{id, remove:true}` → `{users}`. The owner is refused (`400`).
- `POST /api/admin/users/password` `{id}` → `{user, password}`: a new generated password, shown once; the user's sessions end.
- `GET /api/admin/roles` → `{roles:[{id, name, description, builtin, admin, assignable, scopes, users, createdAt, updatedAt}], scopes:{<id>:{label, desc, write, legacy, module}}}`. `users` is how many people hold the role. In the scope catalog `write: false` marks a read-only scope and `legacy: false` one that a key from before service accounts never holds.
- `POST /api/admin/roles` `{name, description?, scopes[], id?}` → `201 {role}`. The id is made from the name unless given (`^[a-z][a-z0-9-]{1,31}$`); `read` is always included; `"*"` is refused. At most 30 custom roles.
- `POST /api/admin/roles/action` `{id, name?, description?, scopes?}` → `{role, roles}`; the change applies to the role's holders at their next request. `{id, remove:true, reassignTo?}` deletes: a role people still hold answers `409 ROLE_IN_USE` unless `reassignTo` names the role they move to (`{role, reassigned, roles}`). Built-in roles answer `400`.
- `GET /api/admin/accounts` → `{accounts:[{id, name, description, scopes, fullAccess, effectiveScopes, disabled, createdAt, lastUsedAt, keys[]}], scopes, presets}`. `scopes` is what is stored (`["*"]` for full access), `effectiveScopes` what that means now. `presets` is what an account can be created from: `read`, one per role (`role:editor`, `role:admin`, `role:<custom id>`: a snapshot of that role's scopes) and `full` (`scopes:["*"]`, `warn:true`). The role presets are worked out from the scope table when asked, so `role:editor` holds every write scope there is now (`home:write`, `software:write` and a plugin's included).
- `POST /api/admin/accounts` `{name, description?, scopes[]}` → `201 {account}`; `scopes` is a list of scope ids or `["*"]`. `POST /api/admin/accounts/action` `{id, scopes}` | `{id, description}` | `{id, disabled}` | `{id, remove:true}` (removing revokes the account's keys). `POST /api/admin/accounts/keys` `{accountId, name?}` → `201 {token, key, account}`: the token appears only here.
- `GET /api/admin/keys` → every key without its value; `POST /api/admin/keys/revoke` `{id}`. `POST /api/admin/keys` `{name, permission: read|write}` still issues a key without a service account (kept for scripts that use it).
- `GET /api/admin/audit?kind=access|device|api&q=<text>&limit=1..1000` (default 200) → `{events:[{at, kind, event, id, subject, detail?, by?, status?}]}`, newest first. `access` = changes to users, roles, accounts and keys (`by` is the administrator); `device` = device tokens; `api` = every write through a key or MCP tool, refused ones included. No event holds a password, a token or a request body.

Limits: 100 users, 30 custom roles, 50 service accounts, 100 active keys (`409`). Invalid input is `400 ACCESS_FAILED`.

### Integrations (administrator, password sign-in)

What the hub reads from outside (Thermo, the router adapter, the collectors, a plugin's bridges), declared by the
modules (`docs/plugins.md` → Integrations). The UI is Administration → Integrations (`#integrations`). No API
key reaches these routes; MCP has only the read-only tool `integrations_status` (scope `read`:
`{integrations:[{id, kind, state, summary}]}`).

- `GET /api/admin/machines` → `{schemaVersion:1, generatedAt, telemetry, facets:[{id, title, icon, page, howTo, off}], machines:[…]}`: Integrations → Machines. Every machine of the overview once, with what each module knows about it (extension point `machines.facets`, `docs/plugins.md`).
  A machine: `{id, name, hostname, ip, kind, role, platform, source: site|added, online, lastSeen, state: ok|warn|error|not-configured, counts:{ok, attention, notConfigured, off}, facets:[{id, title, icon, how?:{by, text}, state, summary?, summaryT?, details?:[{label, value, valueT?}], href, prompt?, promptT?}]}`. `how.by` is `hub`, `source`, `collector`, `agent` or `integration`; `prompt` (a ready prompt for the person's own agent, the machine filled in) comes only where the part is not set up or needs attention. An integration that declares `machines` shows as a facet `int-<id>` on those machines only.
  A facet's `state` is `ok`, `warn`, `stale`, `error`, `off`, `not-configured` or `not-applicable`; `href` is the page where that part is set up. `telemetry` is what the add-machine dialog needs (as in `GET /api/home`). Read-only.
- `GET /api/admin/integrations` → `{schemaVersion:1, generatedAt, kinds[], integrations:[…], plugins:[{id, title, version?, source?, integrations:[id]}], pluginsDirectory}`. `pluginsDirectory` names the plugin directories, comma-separated when there are several.
  An integration: `{id, module, moduleTitle, core, title, titleKey?, kind, description, howTo, page, docs, toggle, toggleNote?, enabled, disabledBy?, disabledAt?, test, settings, status}`.
  `status` = `{state, summary, summaryT?, lastSuccessAt, lastError, configuredBy:[{source, name}], items:[{id, label, state, summary, summaryT?, lastSuccessAt, lastError?}]}`;
  `state` is `ok`, `stale`, `error`, `off`, `not-configured` or `disabled`; `source` is `site.json`, `env`, `ui`, `file` or `plugin`.
  `settings` is `null` or `{schema:[{key, label, labelKey, type, secret, options?, min?, max?, help}], values}`; a write-only field's value is `{set: true|false}`, never the value.
- `POST /api/admin/integrations/toggle` `{id, enabled}` → `{changed, integration}`. Takes effect at once, no restart. `409 INTEGRATION_LOCKED` for an integration with `toggle: false`.
- `POST /api/admin/integrations/test` `{id}` → `{id, at, result: status, integration}`: the integration's own check, now. `409 INTEGRATION_NO_TEST`, or `409 INTEGRATION_DISABLED` while it is off.
- `POST /api/admin/integrations/settings` `{id, values?, clear?}` → `{integration}`. `values` maps keys of the schema to values (a select takes one of its options; a plain text that looks like a secret is refused); a write-only value is stored in `private/integrations.json` (0600); `clear` lists write-only keys to forget. `400 INVALID_INPUT` with `details` names what is wrong; `409 INTEGRATION_NO_SETTINGS`.
- Unknown id: `404 INTEGRATION_NOT_FOUND`. Every change is a line in the access audit (`integration-enabled`, `integration-disabled`, `integration-tested`, `integration-settings`, `integration-secret-cleared`) with `by`; settings lines name the keys, never values.

The state lives in `data/state/integrations.json`: `{schemaVersion: 1, disabled: {<id>: {by, at}}}`. A missing
file means every integration is on. While one is off its data routes answer **`200` with
`disabled: {id, title, by, at}`** and empty data (or `409 INTEGRATION_DISABLED` for a change), and the
`provenance` source says `state: "disabled"`:

| Integration | Off means |
|---|---|
| `home.thermo` | No Thermo session; `GET /api/home` tiles carry no telemetry; `GET /api/home/history` → `{points:[], source:"vypnuto", disabled}` |
| `home.windows` | No SSH connection to any Windows device; their tiles carry no telemetry; their `GET /api/home/history` → `{points:[], source:"vypnuto", disabled}` |
| `home.winrm`, `home.node-exporter`, `home.prometheus`, `home.linux-ssh` | The same for the devices read by that provider: no request to WinRM, a Node Exporter or Prometheus, no Linux SSH connection |
| `router.adapter` | `GET /api/router` → `state: "disabled"`, no census; the file and the adapter are not read |
| `security.systems` | `GET /api/systems` → `{disabled, machines:[], collector:{state:"disabled"}}`; `snapshot.json` is not read |
| `security.upstream` | `GET /api/systems` answers without the newest releases and with `upstreamDisabled`; `upstream.json` is not read |
| `security.keys` | `GET /api/security` → `{disabled, machines:[], keys:[]}` |
| `updates.check` | No request to GitHub about releases; `GET /api/updates` → `state: "disabled"` with `disabled` and `latest: null`; `POST /api/updates/check` → `409 INTEGRATION_DISABLED` |

`GET /api/collectors` reports a collector that is off as `state: "disabled"`. `GET /api/home` lists what is off in
`integrations.disabled: [{id, title, kind}]`. Turning a collector off does not stop its scheduled job.

### Own account (password sign-in, every role)

- `GET /api/profile` → `{user, permissions:[{id, label, desc, write}], prefs:{timeZone}, site:{timeZone}}`.
- `POST /api/profile/prefs` `{timeZone}` → `{prefs, site}`. `timeZone` is an IANA name (`Europe/Prague`), `"browser"` (whatever the browser is set to) or `null` (the site's zone). `400 INVALID_PREFS` otherwise. The choice is stored per account (`state/access.json` → `prefs.<id>.timeZone`) and arrives as `site.timeZone` in `GET /api/ui/manifest` for that person.
- `POST /api/profile/password` `{currentPassword, newPassword}` → `{ok, signedIn, user}`; the account's other sessions end. `403 WRONG_PASSWORD`, `429 TOO_MANY_ATTEMPTS` after five wrong tries in 15 minutes.

### First run

A hub without `private/auth.json` (or `AUTH_FILE`) starts with no owner: `GET /api/ui/manifest` carries
`setupRequired: true`, the web UI shows "finish setup", and `POST /api/session` answers `409 SETUP_REQUIRED`.
`node scripts/setup.mjs` creates the owner (asked on the terminal, or `--generate`, `--password-file`,
`--password-stdin`; never a password on the command line) and writes the file with an scrypt hash, mode
`0600`. The running hub picks it up: no restart. `--force` replaces the owner's password when it is lost.

### MCP

`POST /mcp` speaks JSON-RPC 2.0 (`initialize`, `tools/list`, `tools/call`, `ping`) to a service-account key.
`tools/list` shows only the tools the key's scopes allow, and `tools/call` checks the scope again.

- **Which tools exist** is decided by the modules the server loaded: the core ones and every plugin's. The
  list a person can read is `tools` in `GET /api/ui/manifest` (below); the web UI shows it under
  Users and API → Connect.
- **`initialize` → `instructions`** is a short orientation: what the hub is, who the key is and which
  scopes it holds, then a few lines per module (machines and runtime stacks, the inventory, the software
  watch list, the tracker, review, and whatever a plugin adds through `mcpInstructions`). A line about a
  write tool is left out for a key without that scope.
- `whoami` (`read`) tells a key what it is: `{account, key, kind, fullAccess, canWrite, scopes:[{id, allows, write}], never[]}`.
- `initialize` → `serverInfo.version` is the release version (`1.1.0`). `hub_version` (`read`) says more:
  `{version, label, commit, exact, dataEpoch, plugins:[{id, title}], updates:{state, code, summary, updateAvailable, latest:{version, url, publishedAt} | null, checkedAt, failedAt, error, quarantined, automatic:false}}`
  (the fields of `GET /api/updates`, without the release text). Nothing checks, dismisses or applies an update over MCP.

Users, roles, accounts and keys are never managed over MCP.

### Files written before roles existed

`state/access.json` keeps `schemaVersion: 1` and loads as it is: a user's `role` of `viewer` or `admin` is the
role of that name, an account's explicit scope list is used unchanged, and a key with
`permission: read|write` keeps the reach it had. Nothing is rewritten on read; `roles[]` and
`prefs.<id>.timeZone` appear with the first write, and an older server still accepts the file.

## Errors

Every JSON error has this shape:

```json
{"error":{"code":"INVENTORY_INVALID","message":"Inventory validation failed.","details":["optional", "strings"]}}
```

`message` is written for people and can be shown as is. Codes:

| HTTP | code | meaning |
|---|---|---|
| 400 | `INVALID_INPUT` | Body is not JSON |
| 401 | `AUTH_REQUIRED` | No valid cookie or token (expired, revoked, missing) |
| 403 | `ORIGIN_REJECTED` | Wrong or missing `Origin` (cookie POSTs) or `Content-Type` |
| 404 | `NOT_FOUND` | Unknown route or id |
| 405 | `METHOD_NOT_ALLOWED` | Only GET and POST exist |
| 409 | `DEVICE_LIMIT` | 20 device tokens already exist |
| 413 | `TOO_LARGE` | Body over 16 KB |
| 403 | `SCOPE_REQUIRED`, `SESSION_REQUIRED`, `READ_ONLY`, `ADMIN_REQUIRED` | The credential may not do this: a role or API key without the scope, a route that needs a password sign-in, a read-only account, a non-administrator |
| 409 | `SETUP_REQUIRED`, `ROLE_IN_USE` | No owner account exists yet (run `node scripts/setup.mjs`); a role people still hold cannot be deleted without `reassignTo` |
| 400/403/404/409/422 | `MACHINE_INVALID`, `MACHINE_SECRET`, `MACHINE_NOT_FOUND`, `MACHINE_CONFLICT`, `MACHINE_DUPLICATE`, `MACHINE_LIMIT`, `MACHINE_READ_ONLY` | The machine API (see Machines below): one code per refusal |
| 400/404/409/429/503 | `HOME_UNAVAILABLE`, `DEVICE_FAILED`, `INVENTORY_EDIT_FAILED`, `INVENTORY_UPDATE_FAILED`, `TICKETS_FAILED`, `REVIEW_FAILED`, `SEARCH_FAILED`, `ACCESS_FAILED`, `UPDATE_FAILED`, `MODELS_UNAVAILABLE`, `INVALID_QUERY` (plugins add their own) | Feature errors: 400 invalid request, 404 unknown id, 409 conflict (read again, reapply), 429 another action is running (retry shortly), 503 the feature cannot answer right now |
| 500 | `UNAVAILABLE` | Anything else |

Timestamps are ISO 8601 UTC strings. Byte sizes are integers. A value the source did not report is `null`.

## Provenance

The answers behind the pages carry one extra field, `provenance`: where the data in that answer comes from. It
is additive (a client that does not know it loses nothing) and derived from what the records themselves carry,
never decided per page. The web UI shows it as a pill next to the page title ("Agent", "Collector · 2 days ago",
"Mixed") with the breakdown on demand.

```json
"provenance": {
  "kind": "mixed",
  "lastAt": "2026-11-10T19:12:03.000Z",
  "summary": "Written by agents, 31 records, 4 changes, codex, claude-code, last 2026-11-10T19:12:03.000Z; edited by hand, 6 records, 12 changes, alice, last 2026-11-09T08:00:00.000Z.",
  "kinds": [
    {"kind": "agent", "count": 31, "unit": "records", "changes": 4, "accounts": ["codex", "claude-code"], "lastAt": "2026-11-10T19:12:03.000Z"},
    {"kind": "manual", "count": 6, "unit": "records", "changes": 12, "people": ["alice"], "lastAt": "2026-11-09T08:00:00.000Z"}
  ]
}
```

| Field | |
|---|---|
| `kind` | The one kind every source has; `mixed` when they differ; `none` when the answer holds no data yet (`kinds` is then `[]`) |
| `kinds` | The sources, busiest first, at most 12 |
| `lastAt` | The newest `lastAt` of the sources, or `null` |
| `summary` | One English sentence for a script or an agent. A UI builds its own text from the fields |

A source has `kind` and only the fields that apply:

| `kind` | Meaning | Derived from |
|---|---|---|
| `manual` | Edited by a person in the web UI or the native app | Inventory `verified_by: "user edit in Home Hub"`; tickets and review rounds whose author is a sign-in account |
| `agent` | Written with a service-account key, over MCP or the API; `accounts` names them | Inventory `verified_by: "Home Hub API · <account>"`; authors that are service accounts (or a key's name) |
| `config` | Read from a configuration file; `source` names it | Tracker projects seeded from `site.json → tracker.projects`; the software watch list (`local/software-watch.json`) |
| `collector` | Written by an automated, read-only job; `source` is its script | The collector state (`collectedAt`, interval, `state`) and the snapshot's `run` stamp |
| `telemetry` | Reported live by an agent on a machine (Thermo) | Reserved for the overview's telemetry; no page above sends it yet |
| `plugin` | Supplied by a plugin; `source` is the plugin or adapter id | The router adapter, when a plugin provides it |
| `other` | A stamp or name nobody on this hub carries: an import, a hand edit of the file, a removed account; `detail` lists them | Anything the rows above do not match |

| Source field | |
|---|---|
| `id` | A stable name of the source inside one answer (`systems`, `upstream`, `watch`, `security`), for a page that shows one part |
| `source` | The script, file, plugin or adapter |
| `host` | The machine the collector ran on, when the snapshot says so |
| `count`, `unit` | How many records come from it; `unit` is `entries` (inventory), `items` (tickets), `records` (the tracker list: projects, releases and items together), `projects`, `rounds`, `machines`, `sources` or `clients` |
| `changes` | Later changes by this kind of source to records it did not necessarily create (comments, edits, decisions) |
| `accounts`, `people` | Service-account names and user names, busiest first, at most 8 (`accountsMore` / `peopleMore` count the rest) |
| `lastAt` | When it last wrote: an ISO time, or a `YYYY-MM-DD` day for inventory stamps |
| `state`, `intervalSeconds` | A collector's state (see [Collector state](#collector-state)) and how often it is scheduled |
| `schedule` | How the last run was started: `{"trigger":"scheduled","scheduler":"launchd"\|"systemd","label"?}` or `{"trigger":"manual"}` (run in a terminal). Absent when the snapshot does not say (written before the stamp existed, or by cron or a pipe) |
| `detail` | Free text: the stamps or names counted as `other`, for example |

Answers that carry it: `GET /api/inventory`, `GET /api/services` (the runtime entries alone), `GET /api/tickets`,
`GET /api/tickets/<ID>` and the ticket writes, `GET /api/review`, `GET /api/review/sets/<R-n>`, `GET /api/security`,
`GET /api/systems` (sources `systems`, `upstream`, `watch`), `GET /api/software-watch` and `GET /api/router`, also
on their `404 …_MISSING` answers where a collector simply has not run. Plugins build theirs with the same helper
([plugins.md](plugins.md#provenance)).

## The UI manifest

`GET /api/ui/manifest` needs no sign-in. It tells a client what this hub is and, to a signed-in caller, what
it may open. The web shell draws its sidebar, its pages and the Connect tab from it and keeps no list of its own.

```json
{"site": {"name": "Example", "timeZone": "Europe/Berlin", "defaultLanguage": "en", "lanCidrs": ["10.0.0.0/24"]},
 "edition": "public", "signedIn": true,
 "pages": [{"hash": "overview", "admin": false, "module": "home", "view": {"url": "/home-view.js", "export": "homePage"}},
           {"hash": "versions", "admin": true, "module": "security"}],
 "nav": [{"label": null, "labelKey": "Domov", "items": [{"hash": "overview", "label": null, "labelKey": "Přehled", "soon": false, "module": "home"}]}],
 "modules": [{"id": "home", "core": true, "title": "Overview", "version": "1.2.0", "source": "core"}],
 "tools": [{"name": "machine_upsert", "title": "Overview: create or replace a machine", "scope": "home:write", "write": true, "description": "…", "module": "home"}],
 "apiDocs": [{"title": "Router", "routes": [["GET", "/api/router", "read", "…"]]}],
 "strings": {"en": {"source text": "translation"}},
 "inventory": {"places": [], "secretStores": []},
 "version": "1.1.0", "development": false}
```

| Field | Sent | Meaning |
|---|---|---|
| `site` | always | `name`, `timeZone`, `defaultLanguage`, `lanCidrs` from the site configuration. For a signed-in person `timeZone` is their own choice when they made one (`null` = the browser's zone) |
| `edition` | always | `private` (a tree with a site overlay) or `public` (an export). Behaviour never depends on it |
| `version` | signed in | The release this hub runs, a semver such as `1.1.0` (`package.json`). Shown in the footer. A caller that is not signed in learns no version |
| `development` | signed in | `true` when the checkout is not on the release tag of `version` (the footer then says `1.1.0+dev`); `false` on the tag, and where there is no git checkout to tell |
| `signedIn` | always | Whether the request carried a valid credential |
| `setupRequired` | only when `true` | No owner account exists yet: show how to create one (`node scripts/setup.mjs`) instead of a sign-in. The field is absent once an owner exists |
| `pages` | signed in (else `[]`) | Every routable page: `hash`, the `module` that owns it, and `view` (`url` of the page module and the name of its `export`). **`admin: true` here means "this caller may not open it"**: the page is listed so the client can refuse it by name, and it comes without `view` |
| `nav` | signed in (else `[]`) | The sidebar: groups in order, each with `label` (shown as written) or `labelKey` (Czech source text to translate) and `items`. An item has `hash`, `label` / `labelKey`, `module`, `soon` (a placeholder without a page), and `icon` when the module named one (a name from `public/icons.js` or a short glyph). Entries the caller may not open, and hidden pages (`settings`, `welcome`, `search`), are not in it |
| `modules` | signed in (else `[]`) | The loaded modules: `id`, `title`, `core` (`false` = a plugin), and where known `version` (a core module has the core's; a plugin its `plugin.json`'s) and `source` (`core`, or the plugin source's name). An unversioned plugin (no `plugin.json`) has neither |
| `tools` | signed in | The MCP tools of the loaded modules, in the order `tools/list` returns them: `name`, `title`, the `scope` a key needs, `write` (`false` when that scope is read-only), `description` (the text agents read) and `module` (`core` for the tools defined in `server/mcp.mjs`). The whole reference, not filtered by the caller's scopes; no input schemas and nothing callable |
| `apiDocs` | signed in | Rows the modules documented for the API reference: `[method, path, who, description]`, `who` being a scope id, `read`, `admin`, `password` or `security` |
| `strings` | signed in (else `{}`) | Translations of module and site labels, by language |
| `inventory` | signed in | The site's inventory vocabulary: `places`, `secretStores` |

**Who may open a page.** A module marks a page `admin: true`, names a `scope`, or both (`docs/plugins.md` →
nav entry fields). A page with neither is open to every signed-in account. A restricted page is open to
administrators (`owner`, `admin`) and to any role that holds its `scope`; a page with `admin: true` and no
scope is for administrators only. The manifest applies that rule for the caller: `nav` leaves the entry out
and `pages` marks it `admin: true`. The data routes behind a page check the scope again.

## Home: the overview

- `GET /api/home` → `{"poll","schemaVersion":1,"generatedAt","machines":[…],"telemetry","router"}`. One entry per machine from the site configuration (site.json → `machines`) and per added machine: identity (`id`, `name`, `hostname`, `ip`, `kind`: `thermo`, `nas`, `router` or `other`), `props` (static hardware), `online` (`online`, `stale`, `offline`, `unknown`), `lastSeen`, `quad` (CPU, GPU, power, temperature and memory averaged over the poll interval, from Thermo or from Windows telemetry), `volumes`, `services` and `stack`. `kind: "thermo"` means "has a telemetry feed", whichever provider (`telemetry.provider`) delivers it; a field a provider does not measure is `null`, never `0`.
  - Every machine also carries `platform` (`macos`, `windows`, `linux`, `other` or `null`; the operating system, apart from `role`), `native` (below; `null` unless the machine is read through Windows telemetry), `role` (`computer`, `nas`, `router`, `other`), `source` (`site` = the site configuration, `ui` = added on the overview, `agent` = written through the machine API), `readOnly`, `picture` (a path), `image` (its own picture or `null`), `telemetry`, `runtimes` and `spark`. Added machines have `added:true`, `hash`, `pictureId`, `createdAt`/`createdBy` and `updatedAt`/`updatedBy`.
  - `telemetry` = `{"state","thermoId","lastSampleAt","ageSeconds","reason"}`; a machine read through Windows telemetry also has `"provider":"windows"`, `"hostId"` (its own id), `"target"` (the label of the connection it is read through: `user@host` with `:port` when not 22 for an app-managed one, the SSH alias for an older one), `"connection"` (`{"mode":"managed","host","port","user","keyFingerprint","hostKeyFingerprint"}` or `{"mode":"alias","target"}`; public facts only, never a key or a path; `machine_list` carries neither `target` nor `connection`), `"detail"` (the collector's last error code while not `ok`, else `null`) and `"hint"` (that code's source-language sentence: what to do), and its `thermoId` is `null`. `state` is `not-installed` (the machine names no telemetry host), `not-applicable` (a router), `ok` (newest reading at most 3 minutes old), `stale` (readings exist, the newest is older) or `unreachable` (a host is named and nothing was ever read). `reason` for the last two: `no-login` (the hub has no login for that host), `denied`, `down`, `no-data`, `waiting`. A failed read never means the machine is off; `online` keeps its earlier meaning for existing clients.
  - Top-level `telemetry` = `{"agent":"Thermo","repoUrl","staleAfterSeconds":180,"adapters":[…]}`: the optional telemetry agent and where to get it (one constant, `TELEMETRY_REPO_URL` in `server/thermo-client.mjs`, still a placeholder until its repository is published). `adapters` lists what this hub can connect a device to, each `{"id","name","repoUrl","connect","defaultPort","summary"}` (`summary` is a source-language sentence). The Telemetry step of Add device offers exactly these: `thermo` (`connect:"account"`, the agent) and `windows` (`connect:"ssh"`, no agent, `repoUrl:null`, also `"platform":"windows"` and `"minIntervalSeconds":30`; see [Windows telemetry](#windows-telemetry-ssh--powershell)). Also `winrm` (`connect:"endpoint"`, platform `windows`), `node-exporter` (`connect:"endpoint"`, platform `linux`, `"recommended":true`), `prometheus` (`connect:"endpoint"`, platform `linux`) and `linux-ssh` (`connect:"ssh"`, platform `linux`); `thermo` has `"platform":"macos"`. The dialog offers the adapters of the chosen platform (all of them when none is said). See [Agent-less telemetry](#agent-less-telemetry-winrm-node-exporter-prometheus-linux-ssh).
  - `native` (Windows telemetry over SSH or WinRM; Linux sources: see Agent-less telemetry) = `{"provider":"windows","observedAt","os":{"caption","version","uptimeSeconds"},"cpu":{"name","logical","cores":[%…]},"disk":{"readBps","writeBps"},"net":{"rxBps","txBps"},"gpus":[{"id","name","util","engine","memUsed","memTotal"}],"gpuCounters","span","sensors":"unsupported"}`: per-core load, disk and network rates and each GPU, averaged over the last poll interval (`span` seconds; `null` rates after the first poll, a failure or a gap). `gpus[].name` and `memTotal` are set only when one GPU and one display adapter can be paired.
  - `spark` = `{"series":"cpu"|"gpu","end","stepSeconds":10,"windowSeconds":600,"values":[…60]}` on a machine with telemetry readings in the window, else `null`: the tile's small chart. `values` are percentages per 10 s step, the last one ending at `end` (unix seconds); `null` is a step without a reading and is drawn as a gap. `series` is `gpu` for a machine that has `runtimes`, else `cpu`.
  - `stack.source` is `published` (with `publishedAt`, `publishedBy`, `hash`, `layerKeys`) when an agent published it, `collected` for a collected descriptor, absent for the site configuration. `runtimes` is `null` unless a `home.runtimes` provider reports local LLM runtimes for the machine (docs/plugins.md); the machine page then has no such section. Otherwise it is `{"source","observedAt","runtimes":[{"id","name","kind","status","url","version","source"?,"mode"?,"activity"?,"models":[{"id","state","kind","sizeGb","contextTokens","ttlRemainingSeconds","active"?,"queued"?,"since"?}],"stats":[{"label","value"}]}]}`; `activity` (`{active, queued}`: requests or jobs running and waiting) and a model's `active`, `queued`, `since` appear only where a runtime reports them and its data is fresh; `mode: "cli"` is a command-line tool (mflux) whose models are those of its jobs. `work` is `null` without runtimes, else what generates now on that machine: `{items:[…], active, queued, watching:[names], blind:[names]}` (as [`GET /api/models`](#llm--diffusion-ui-models) → `work`), a request through a gateway counted once; `gpuProcesses` is `null` unless the machine's telemetry agent reports the processes on its GPU (Thermo, from its 30-second snapshot), else `{observedAt, gpu, attributedPercent, rows:[{pid, name, percent, runtime?, model?}]}`: the five busiest, each with its time in the GPU's queues in per cent (100 = one GPU-second per second, averaged over 5 s; the agent's estimate, not a share of the GPU load: queues overlap, so the rows can add up to more than `gpu`), named by the runtime or model whose `pids` include it; `gpu` is the device utilization in the same snapshot and `attributedPercent` the queue time of all processes together; when more than one provider contributed (the hub's own direct reads, see [LLM runtime endpoints](#llm-runtime-endpoints), and a plugin), also `"sources":[…]`, and each runtime appears once (docs/plugins.md → `home.runtimes` from more than one provider). A stack block whose service is reported live gets its `port` and `desc` rewritten as source-language sentences (`":8081 · živě"`); `portT` and `descT` carry the same as translatable parts, like the collector texts below.
- `GET /api/home/history?machine=<id>&range=30m|7d|30d|6m` → chart buckets for a machine that reports through Thermo or Windows telemetry; other machines answer with `points: []` and a `reason`. A Windows reading is the average over its poll interval and fills the 30 s buckets (and the tile's 10 s spark steps) it covers, at most 120 s back; a gap stays a gap.
- `POST /api/home/refresh` `{}` → the same document after an immediate Thermo pull (rate limited) and a Windows poll (at most one every 10 s). `POST /api/home/settings` `{"intervalSeconds":15|30|60}` changes the pull interval (scope `home:settings`); Windows polls follow it but never run more often than every 30 s.
- `GET /api/ui/manifest` → what the web shell draws itself from; see [The UI manifest](#the-ui-manifest).
### Overview tile order (web UI, password sign-in only)

- `GET /api/profile/home-order` → `{"order":["studio","mini",…],"saved":true|false,"known":["studio","mini","nas","router"]}`. `order` always lists every known machine: the saved ones first, then any missing in the default order (`saved:false` = nothing saved).
- `POST /api/profile/home-order` with body `{"order":["studio","nas"]}` → `{"order":[…full list…],"saved":true}`. Only known ids, each at most once; a partial list is fine, `[]` returns to the default order. `400 INVALID_ORDER` otherwise. Read-only viewers may set their own order.
- Stored per account in `state/access.json` (`prefs.<account id>.homeOrder`); deleting the user deletes it. Session cookie only: device tokens and API keys get `403 SESSION_REQUIRED`, and the POST needs the same `Origin` and `Content-Type` as every browser write. The app keeps the default order.

### Machines (web UI with write access, or an API key with `home:write`; MCP tools)

Machines that are not in the site configuration: added on the overview, or written by an agent. The site's own machines
(`local/site.json`) are listed too but stay read-only (`403 MACHINE_READ_ONLY`). All of them live in
`state/home/devices.json` (schema 1; fields added later are optional, so a file from an older hub loads unchanged).

A machine: `{"id","name","hostname","ip","role","hardware":{"cpu","gpu","ramGb","diskTotalBytes"},"thermoId","picture","platform"}`.
`id` is `[a-z][a-z0-9_-]{1,31}` and never changes; `role` is `computer` (default), `nas`, `router` or `other`; `ip` must
be a host address inside the site's `lanCidrs` when those are set; `thermoId` names the telemetry host the machine
reports through (`null` = not installed); `picture` is one of the built-in ids `desktop`, `laptop`, `mini`, `tower`,
`server`, `nas`, `router`, `board`, `printer`, `generic` (served at `/images/generic/<id>.svg`), or `null` for the
role's default; `platform` is `macos`, `windows`, `linux`, `other` or `null` (not said). An upsert that omits `platform`
keeps the machine's; `null` clears it. A machine without a platform hashes exactly as before the field existed, so a
`hash` read from an older hub still matches. While Windows telemetry is connected (web UI only), `platform` must stay
`windows` and `thermoId` must stay `null` (`400 MACHINE_INVALID`). Values that look like a secret (keys, tokens, `password=…`, credentials in a URL) are refused.

- `GET /api/home/machines[?stack=1]` (`read`) → `{"machines":[…],"pictures":[{"id","url"}],"roles","platforms","runtimeLayers","lanCidrs","limits":{"machines":20},"telemetry"}`.
  Each machine has the fields above plus `source`, `readOnly`, `hash` (`null` for site machines), `customPicture`,
  `telemetry` and `runtime` = `{"source":"published"|"collected"|"site"|null,"publishedAt","publishedBy","hash"}`
  (with `stack=1` also `stack`, in the form `POST /api/home/runtime` takes). A site machine lists its effective `name`,
  `hostname`, `ip`, `hardware` and `picture` (the owner's override applied, below) and `siteOverride`
  (`{"fields":["name","hardware.ramGb",…],"updatedAt","updatedBy"}`, or `null`); it stays `readOnly` here.
- `POST /api/home/machines` `{"machine":{…},"base"?}` → `201` created or `200` → `{"ok","id","hash","created","changed","by","machine"}`.
  The whole record is replaced. Like inventory entries: omit `base` to create, pass the `hash` you read to change. Without
  `base`, a machine that already holds exactly these fields is left alone (`changed:false`), so a repeated create is harmless;
  different fields without `base`, or a stale `base`, are `409 MACHINE_CONFLICT`.
- `POST /api/home/machines/remove` `{"id","base"}` → `{"ok":true,"id","removed":true}`. `base` is required. The uploaded
  picture, the stored Thermo login and a published runtime stack go with it; metric history stays.
- `POST /api/home/runtime` (≤ 64 kB) `{"machine","stack"|null,"base"?}` → `{"ok","id","hash","changed","published","publishedAt","by"}`.
  Publishes the runtime stack drawn on the machine's page (site machines included). It replaces the stack from the site
  configuration or a collected descriptor, or adds one; `stack:null` takes the publication back. Optional `base` = the
  published stack's hash. `stack` = `{"cols":[engine key per column, 1–12],"engines"?:{key: label},"blocks":[1–60]}`;
  a block is `{"id","layer","col0","col1","title","port"?,"desc"?,"state"?:"on"|"off","service"?,"models"?:[{"id","state"?,"sizeGb"?,"path"?}]}`
  with `layer` one of `input`, `tool`, `runtime`, `engine`, `hardware`. A block spans columns `col0..col1` of its
  layer; two blocks of one layer may not overlap.
- Errors: `400 MACHINE_INVALID` (with `details` naming the field), `422 MACHINE_SECRET`, `404 MACHINE_NOT_FOUND`,
  `409 MACHINE_CONFLICT` / `MACHINE_DUPLICATE` (hostname already used) / `MACHINE_LIMIT` (20 added machines),
  `403 MACHINE_READ_ONLY`.
- MCP: `machine_list` (`read`; `runtime:true` includes the published stacks), `machine_upsert`, `machine_remove`,
  `runtime_publish` (`home:write`). Same arguments and rules as the routes above. `home:write` is never given to keys
  created before scopes existed. Every call of a write tool is in the write log with the machine id.

### Editing a machine of the site configuration (web UI, password sign-in with write access only)

Every tile on the overview, a site machine's included, has an **Edit** button for a writer. For a machine from
`site.json` it changes **display metadata only**, stored as the owner's override over the site's values in
`state/home/site-overrides.json` (0600, no secrets):
`{"schema":1,"overrides":[{"id","fields":{"name"?,"hostname"?,"ip"?,"hardware"?:{"cpu"?,"gpu"?,"ramGb"?,"diskTotalBytes"?},"picture"?},"image"?,"imageAt"?,"updatedAt","updatedBy"}]}`.
`site.json` is never written; `id`, `role`, `platform`, `thermoId`, `ssh`, `stack`, the telemetry binding, the service
probes, Thermo and the router adapter keep reading the site's values (a changed hostname or ip is shown, not probed).

- `GET /api/home` → every site machine carries `siteOverride` (`{"fields":[names],"hash","image","updatedAt","updatedBy"}`;
  `hash` is the `base` an edit sends, also when nothing is overridden) and `siteDefaults` (`{"name","hostname","ip","hardware","picture","image"}`,
  the site's own values). The tile shows the override's values; a collected descriptor never wins over it.
- `POST /api/home/devices/site` `{"id","base","machine":{"name"?,"hostname"?,"ip"?,"hardware"?,"picture"?}}` →
  `{"id","override","hash","changed"}`. The whole override is replaced: an absent field, or one sent with the site's own
  value, goes back to the site's (not stored). Rules as for an added machine (name 1–60, a host name or IPv4, an ip inside
  `lanCidrs`, cpu ≤ 60, gpu ≤ 40, positive numbers or `null`, a built-in picture id; secret-looking values are
  `422 MACHINE_SECRET`). `role`, `platform`, `thermoId`, `id`, `ssh`, `stack` are refused by name (`400 MACHINE_INVALID`).
  A stale or missing `base` is `409 MACHINE_CONFLICT` / `400`; another machine's hostname `409 MACHINE_DUPLICATE`;
  an id that is not a site machine (an added device included) `404 MACHINE_NOT_FOUND`.
- `POST /api/home/devices/site/reset` `{"id","base"}` → back to the site's defaults: the override and the uploaded picture go.
  An override whose machine left `site.json` is kept on disk, ignored, and cleared only here.
- Own picture: `PUT /api/home/devices/<id>/image` and `POST /api/home/devices/image/remove` `{"id"}` work for a site
  machine too (its override's `image`); it is served at `GET /api/home/devices/<id>/image` (not under `/images/home/`,
  where the site's own picture is a static file).
- API keys, native device tokens and accounts signed in otherwise are refused (`403`); `machine_upsert` /
  `machine_remove` keep refusing site machines (`MACHINE_READ_ONLY`). A Thermo Mac and the router are editable the same
  way; their editor says who reads their telemetry, which this edit never changes.

### Devices on the overview: pictures and Thermo logins (web UI, write access, never API keys)

What needs a person: uploading a picture and giving the hub a Thermo login. A device's Thermo login is kept in
`state/home/thermo-hosts.json` (mode 0600, sealed with the hub's key: docs/storage.md → Secrets at rest; opened, the same shape as `private/thermo-hosts.json`) and its uploaded picture in
`state/home/images/<id>.jpg`. Added machines appear in `GET /api/home` with `added:true` and `kind` derived from
`thermoId` and `role` (`thermo`, `nas`, `router`, `other`); their ids join `known` in the tile order.

- `POST /api/home/devices/probe` `{"host","port"?}` → `{"fingerprint","subject","validTo"}`: a TLS handshake with
  Thermo, nothing sent. `422` when nothing answers.
- `POST /api/home/devices` `{"name","kind","hostname","ip"?,"role"?,"picture"?,"props"?:{"cpu","gpu","ramGb","diskTotalBytes"},"thermo"?:{"port","username","password","pin"}}`
  → `201` the device (its id is made from the name). A `thermo` device first logs in once with the pinned certificate (`pin` = the fingerprint the
  user confirmed); a refused login is `422` and nothing is saved. Then the poller starts pulling it, without a restart.
  `409` for a hostname already added, at most 20 devices.
- `PUT /api/home/devices/<id>/image` with `Content-Type: image/jpeg` (≤ 3 MiB, cropped to 3:2 in the browser) → the device.
- `GET /images/home/<id>.jpg` → the picture (signed in).
- `POST /api/home/devices/thermo` `{"id","thermo":{"port","username","password","pin"}}` → the device: connects a device
  that is already on the overview (for example one an agent created). The login is tried once with the pinned certificate
  first; then the device is its own telemetry host (`thermoId` = its id). `{"id","thermo":null}` forgets the login.
- `POST /api/home/devices/image/remove` `{"id"}` → the device, back on its built-in picture.
- `POST /api/home/devices/remove` `{"id"}` → `{"removed"}`; the tile, its Thermo login or Windows connection (with the hub's key
  and known_hosts for it) and picture go, the metric history stays. `machine_remove` does the same.
- `POST /api/home/devices` also takes `"kind":"windows"` (and optional `"platform":"windows"`) with
  `"windows":{"draft","host","port","user"}`: an app-managed connection whose set-up draft (below, made for a new device) passed
  its test with exactly this host, port and user; otherwise nothing is saved (`409 WINDOWS_SETUP_FAILED`, `reason` `needs-test`,
  `stale`, …). The older `"windows":{"target"}` (an alias) is still accepted: the SSH connection is tried once first; a failure is
  `422 WINDOWS_SSH_FAILED` and nothing is saved.
- `POST /api/home/devices/windows/check` `{"target"}` (older alias connections) → `{"ok":true,"target","resolved":{"hostname","user","port"}|null,"tookMs","os":{"caption","version"},"cpu":{"name","logical"},"memTotal","volumes":[{"mount","name","fs","total"}],"gpus":[name],"gpuCounters","vramUsed","sensors":"unsupported"}`.
  Runs the collector once and stores nothing. `400` for an invalid target (never tried), `422 WINDOWS_SSH_FAILED` with
  `reason` (`host-key-unknown`, `host-key-changed`, `denied`, `unresolved`, `refused`, `timeout`, `unreachable`, `ssh-config`,
  `ssh`, `no-ssh`, `no-keyscan`, `no-host-key`, `key-missing`, `key-permissions`, `no-powershell`, `powershell`, `bad-output`,
  `no-counters`, `too-large`, `spawn`, `busy`, `unavailable`) and a
  `message` saying what to do. At most two tests run at a time (`busy` otherwise).
- `POST /api/home/devices/windows` `{"id","windows":{"draft","host","port","user"}}` → the device: connects a device that is
  already on the overview (added as a plain tile, or by an agent) to Windows telemetry, or changes its connection, with a draft
  made for this device that passed its test. `{"id","windows":{"target"}}` does the same with an older alias (tested first).
  The device keeps its id, picture, creation and history and gets `platform:"windows"`; the connection it replaces is
  forgotten, with the hub's key and known_hosts for it. Refused (`400`) while it reports through Thermo or has another platform.
  `{"id","windows":null}` disconnects (and deletes the hub's key for it; the public key stays in authorized_keys on Windows
  until someone removes it there).

#### App-managed SSH: set-up drafts

The Add/Edit device dialog builds a connection on the server, one step at a time, in a **draft**
(`server/windows-ssh.mjs`). Every route below is for a person signed in with a password and write access only (`403` for API
keys, native device tokens and read-only accounts), and a draft is visible only to the person who made it. A draft lives in memory, for at most 30 minutes after its last step; at most 3 per person (the oldest gives way) and
16 in all. Each reply carries `draft` = `{"id","device","host","port","user","key":{"type","bits","fingerprint","publicKey","source","reused"}|null,"hostKeys":[{"type","fingerprint"}]|null,"trusted":{"type","fingerprint","reused"}|null,"tested":{"at"}|null,"expiresAt"}`
— never a private key, never a path. Refusals are `WINDOWS_SETUP_FAILED` with a `reason` and a sentence (`draft-missing` 404;
`busy`, `needs-key`, `needs-scan`, `needs-trust`, `needs-test`, `stale`, `trust-mismatch`, `limit` 409; `key-format`,
`key-encrypted`, `key-public`, `key-putty`, `key-unsupported`, `key-weak`, `key-mismatch` 422; `store`, `store-path` 503), or,
for a step that connects, `422 WINDOWS_SSH_FAILED` as above.

- `GET /api/home/devices/windows/tools` → `{"ok","ssh":{"ok","version"},"keyscan":{"ok"}}`: whether the hub's server has the
  OpenSSH client tools (it runs `ssh -V` and `ssh-keyscan` without arguments; nothing connects). Cached for a minute.
- `POST /api/home/devices/windows/draft` `{"id"?}` → `201 {"draft"}`. With the id of a device read through an app-managed
  connection, its host, port, user, key and verified host key are taken over (`reused:true`), so changing only the user needs
  only a new test.
- `POST …/draft/key` `{"draft","generate":true}` makes a new key (RSA 3072, Node's built-in crypto); `{"draft","privateKey"}`
  imports one (at most 16 KiB of text: OpenSSH, PKCS#1, SEC1 or unencrypted PKCS#8; RSA ≥ 2048 bits, ECDSA P-256/384/521 or
  Ed25519). Encrypted keys are refused (`key-encrypted`), never prompted for. The key gets the comment `home-hub`; the draft's
  previous key goes; the test must run again.
- `POST …/draft/scan` `{"draft","host","port"}` → `draft.hostKeys`: what `ssh-keyscan` gets from host:port (it sends no user,
  key or password). Another host or port than before drops the scan, the trust and the test.
- `POST …/draft/trust` `{"draft","fingerprint"}`: the person compared this fingerprint (one of the last scan) with what Windows
  shows and confirms it. Only this key is stored for the connection.
- `POST …/draft/test` `{"draft","host","port","user"}` → `{"draft","result"}`; `result` is what `/check` returns, plus
  `"connection":{"host","port","user","keyFingerprint","hostKeyFingerprint"}`. Another user than before drops the earlier test.
  Saving needs a test of exactly what the draft now holds, at most 15 minutes old.
- `POST …/draft/discard` `{"draft"}` → `{"discarded":true}`; the dialog sends it when it closes without saving. The draft's
  key and known_hosts go at once (a draft that expires loses them too).

At most two SSH steps (tests, host-key fetches, key generation) run at once (`busy` otherwise).

### Windows telemetry (SSH + PowerShell)

Integration `home.windows`, core module `home`, `server/windows-telemetry.mjs` (the collector) and `server/windows-ssh.mjs`
(the hub's key store, host-key discovery, set-up drafts). No agent on Windows: the hub logs in with key-only SSH and runs one
fixed, read-only PowerShell script (`-EncodedCommand`) that reads CIM classes. Nothing is installed or changed on the target.
The hub may run on Linux, macOS or Windows, and the browser's system does not matter.

**Prerequisite on the hub's server**: the OpenSSH client tools, `ssh` and `ssh-keyscan` (Windows: the optional feature
OpenSSH Client; Linux: `openssh-client` or `openssh`; macOS has them). Nothing else: no `~/.ssh/config`, no agent, no key
files made by hand. Missing tools are reported (`/tools`, `no-ssh`, `no-keyscan`).

**Set-up** (the Add/Edit device dialog, under Telemetry → Windows): host (by default the machine's address), SSH port (22) and
Windows user; *Create a new key* (or import one); copy the PowerShell step it shows and run it on Windows as administrator;
*Fetch the host key*, compare the fingerprint with what the PowerShell fingerprint snippet prints on Windows and confirm it;
*Test connection*; save. The only Windows-side steps are, as copyable PowerShell (`public/windows-setup.js`):

- installing OpenSSH Server, only when it is not there (`Add-WindowsCapability … OpenSSH.Server`, the service set to start
  automatically; the installation adds the firewall rule for port 22; another port must already be set up on Windows);
- authorizing the hub's public key for that one account: the account's SID is resolved (so localized group names do not
  matter); a standard account gets the key in `<profile>\.ssh\authorized_keys` (ACL: the account, SYSTEM, Administrators); an
  administrator in `%ProgramData%\ssh\administrators_authorized_keys` (ACL: Administrators, SYSTEM) — but the snippet stops
  for an administrator unless `$AllowAdministrator = $true` is set, because that file is shared by every administrator of the
  PC. The key line starts with `restrict` (no forwarding, no terminal). It never creates an account, changes a group, sshd's
  configuration, the firewall or UAC. Someone who already runs sshd only needs this step;
- optionally, adding a standard account to Performance Monitor Users (`S-1-5-32-558`) when the test says counters are missing
  (the membership allows reading performance counters, nothing else).

- **App-managed connection** (stored in `state/home/windows-hosts.json`, 0600): `{"mode":"managed","host","port","user",
  "keyId","connId","keyType","keyFingerprint","publicKey","keySource","hostKey":{"type","key","fingerprint"},"configuredAt",
  "configuredBy"}`; host is a host name or IPv4 address, user `name`, `DOMAIN\name` or `name@domain` (letters of any script,
  digits, space, `.`, `_`, `-`; no quotes, `%`, `$`), port 1–65535. Never in `devices.json`; agents cannot set it.
- **The key store**, `state/home/ssh/` (POSIX: directories 0700, files 0600, owned by the hub's account, checked after every
  write; Windows: an explicit ACL with only the hub's own account and SYSTEM, no inheritance): `keys/<keyId>` (the private
  key), `known_hosts/<connId>` (the one verified host key, under the alias `hh-…`), `empty` (an empty file). Files nobody refers
  to (an unfinished draft, a removed device) are deleted at start and every few minutes. **Backups of the state directory
  contain these private keys**: keep them as private as the hub's other secrets. A key is never returned by an API, written to
  `devices.json`, logged, put in an error, MCP reply or export.
- **ssh** (managed): spawned without a shell, with ssh's whole configuration replaced and nothing of the account it runs as:
  `ssh -F <empty> -T -i <key> -l <user> -p <port> -o BatchMode=yes -o StrictHostKeyChecking=yes -o CheckHostIP=no
  -o UpdateHostKeys=no -o IdentitiesOnly=yes -o IdentityAgent=none -o PreferredAuthentications=publickey -o PasswordAuthentication=no
  -o ProxyCommand=none -o ControlMaster=no -o ForwardAgent=no -o ClearAllForwardings=yes … -o UserKnownHostsFile="<known_hosts>"
  -o GlobalKnownHostsFile="<empty>" -o HostKeyAlias=hh-… -- <host> <fixed command>`; the environment loses `SSH_AUTH_SOCK`,
  `SSH_ASKPASS` and `DISPLAY`. An unknown or changed host key is always refused (`host-key-unknown`, `host-key-changed`); the
  way back is to fetch and verify the host key again in the dialog. Changing host or port drops the trust and the test;
  changing the user or the key drops the test.
- **Older alias connections** (`{"id","target"}` in the same file) keep working unchanged: ssh with the account's own
  `~/.ssh/config`, keys and `known_hosts`, as `ssh -T -o BatchMode=yes -o StrictHostKeyChecking=yes … -- <target> <fixed command>`.
  The dialog offers to convert one (the alias and `~/.ssh` stay as they are). Target rule: an alias or `user@host`; letters,
  digits, `.`, `-`, `_`, each part starting with a letter or digit (a user may start with `_`); no spaces, `%` tokens, ports or
  shell characters.
- Every run: stdin closed, killed after 25 s, stdout ≤ 1 MiB, stderr ≤ 16 KiB and only classified, never logged or returned.
- **Readings**: CPU (total and per logical processor), disk and network come from raw counters
  (`Win32_PerfRawData_*`): a reading is the difference between two polls, the true average over that interval (`span`),
  stamped when it was read. The first poll after a start, a failure or a gap over 300 s gives memory and volumes only.
  GPU: running time per engine (all processes on it), divided by the elapsed time and capped at 100 %; a GPU is as busy
  as its busiest engine, the machine's `gpu` is its busiest GPU. Memory is RAM (`memUsed`, `memTotal`, `swapUsed` from the
  page file); VRAM is in `native.gpus`. Volumes are the fixed drives. Temperatures, fans and power are not read
  (`null`, `sensors:"unsupported"`). Values are parsed locale-independently (invariant culture, counters as decimal strings).
- **Polling**: one SSH connection per device per interval, never more often than every 30 s, at most four devices at a time,
  never two polls of one device at once. Minute rows go to `<state>/windows/minutes-<id>-YYYY-MM.jsonl` (0600) and are
  read back at start, like Thermo's; 8 days are kept in memory. A device that is removed or re-targeted (any change of host,
  port, user, key or host key) is dropped at once; an answer still in flight for it is discarded.
- **Status** (`GET /api/admin/integrations`): one item per connected device: `ok`, `stale` or `error` with `lastError`
  (the codes above) and the sentence for it.

### Agent-less telemetry: WinRM, Node Exporter, Prometheus, Linux SSH

Four more providers beside Thermo (the agent) and Windows over SSH, in core module `home`. One table names them
(`server/telemetry-providers.mjs`): `telemetryProvider` of a device, its `platform`, its integration, its error sentences.

| Provider | Reads | Module | Integration | History |
|---|---|---|---|---|
| `winrm` — Windows (WinRM) | fixed WQL `Enumerate`/`Pull` of the WMI classes the SSH script reads, `POST /wsman`, HTTPS only | `server/winrm-telemetry.mjs` | `home.winrm` | `<state>/windows/` |
| `node-exporter` — Linux (Node Exporter) | `GET /metrics` of Prometheus Node Exporter (default port 9100), text format 0.0.4 | `server/linux-telemetry.mjs`, `server/prom-text.mjs` | `home.node-exporter` | `<state>/linux/` |
| `prometheus` — Linux (Prometheus) | `GET /api/v1/query` of an existing Prometheus (default 9090) for ONE node_exporter target (job + instance) | `server/prometheus-telemetry.mjs` | `home.prometheus` | `<state>/linux/` |
| `linux-ssh` — Linux (SSH) | one fixed POSIX `sh` script over the hub's own SSH key (reads `/proc`, `/sys/class/hwmon`, `df -P -k`) | `server/linux-telemetry.mjs` (+ `server/windows-ssh.mjs` drafts with `os:"linux"`) | `home.linux-ssh` | `<state>/linux/` |

- **Transport** (`server/endpoint-http.mjs`, Node's `net`/`tls`/`http` only, no dependency): host and port are validated
  values, the path is a constant, never a URL from the browser. HTTPS is verified **before** the request is written:
  `tls:{mode:"ca"}` (Node's CA store plus `NODE_EXTRA_CA_CERTS`, with hostname verification) or `tls:{mode:"pin",pin}`
  (SHA-256 of the leaf certificate a person approved; the host name is not checked in this mode). No insecure mode, no
  redirects (3xx is an error), no compression, a size cap (1 MiB per WinRM reply, 8 MiB for `/metrics` and Prometheus
  replies), a deadline. Credentials (Basic; for Prometheus also a bearer token) only over verified HTTPS; plain HTTP is
  allowed only without credentials (a Node Exporter or Prometheus on the LAN).
- **WinRM**: Basic authentication with a **local** Windows account is the only scheme; Kerberos, NTLM/Negotiate, CredSSP,
  certificates and PowerShell remoting are not supported. Basic is off in WinRM by default; the dialog's PowerShell
  step (`public/telemetry-setup.js`) enables it for the WinRM service only, adds an HTTPS listener with a self-signed
  certificate only when there is none, and one firewall rule for the hub's address; it keeps existing listeners and
  settings and never sets `AllowUnencrypted`, `TrustedHosts`, UAC or runs `quickconfig`. A standard account needs Remote
  Management Users, Performance Monitor Users and Remote Enable on `root/cimv2` (`wmimgmt.msc`). Replies are read by a
  strict XML reader (`server/safe-xml.mjs`: no DTD, no entities beyond the five predefined, no CDATA, bounded). The
  data becomes the very object the SSH PowerShell script prints, so readings, history and `native` mean the same.
  Differences: display adapters come from `Win32_VideoController` (memory ≥ 4 GB unknown: `null`).
- **Linux mapping** (Node Exporter, Prometheus and SSH alike): CPU per logical CPU and total = 1 − Δ(idle+iowait)/Δ(all
  modes but guest); memory = MemTotal − MemAvailable (the ZFS ARC counts as used), swap used; disk rates summed over whole
  physical disks (`sd*`, `vd*`, `xvd*`, `hd*`, `nvme*n*`, `mmcblk*`; no partitions, `dm-*`, `md*`, loop, zram); network
  rates summed over interfaces that are not loopback, bridges, veth, container, tunnel or VPN; volumes = local block
  filesystems, one per device and **one per ZFS pool** (its least nested mounted dataset, labelled with the pool), never
  summed into a hardware disk size; `cpuTemp` from hwmon (`coretemp`, `k10temp`, `zenpower`, `cpu_thermal`), `gpuTemp` from
  `amdgpu`/`radeon`/`nouveau` hwmon when reported; GPU utilisation and power are `null`. A rate needs two snapshots of
  one boot at most 300 s apart; a counter that went backwards gives `null`, never an average across the reset.
  `native` = `{"provider","observedAt","os":{"caption","version","arch","uptimeSeconds"},"cpu":{"name","logical","cores"},
  "load":[1,5,15]|null,"disk","net","gpus":[],"gpuCounters":false,"span","temps":[{"chip","label","c"}],"sensors":"reported"|"none"}`.
- **Prometheus**: only three fixed discovery queries (`node_uname_info`, `up`, `timestamp(up)`) and one snapshot selector
  `{__name__=~"up|<the node_exporter metrics above>",job="<job>",instance="<instance>"}[120s]`; job and instance are
  only values Prometheus listed at discovery, embedded as escaped string literals. Never `/metrics` of Prometheus, never an
  admin, lifecycle, reload or write route, never PromQL from the browser. Discovery lists each `(job, instance)` with a
  `node_uname_info` series (Prometheus' own target has none); a pair with more than one is `ambiguous` and not
  selectable. The snapshot is the target's newest scrape: its `up` sample must be 1 (`target-down`) and inside the
  two-minute window (`stale`); every other series contributes only its sample of exactly that scrape; the reading is
  stamped with the scrape time. A poll that finds the same scrape as before records nothing (no fabricated freshness).
- **Set-up drafts** (`server/endpoint-setup.mjs`; password sign-in with write access only, `403` for API keys and native
  tokens). A draft belongs to its person, is bound to one device (or a new one) and one provider, lives in memory only
  (30 min idle), and holds the password or token one-way: a view says only `password:{set,reused}`.
  - `GET /api/home/devices/hub-address` → `{"address"}`: the hub's own IPv4 address inside the site's networks
    (`lanCidrs`), or `null` when it has none there. The set-up guides put it into their firewall lines.
  - `POST /api/home/devices/endpoint/draft` `{"provider":"winrm"|"node-exporter"|"prometheus","id"?}` → `201 {"draft"}`;
    with a device id, its stored connection of that provider is reused (host, port, scheme, user, trust, secret).
  - `POST …/draft/probe` `{"draft","host","port"}` → the certificate (`fingerprint` hex, `subject`, `issuer`, `altNames`,
    `validFrom`, `validTo`, `selfSigned`, `caVerified`, `hostnameOk`): a TLS handshake only, nothing sent.
  - `POST …/draft/trust` `{"draft","mode":"ca"|"pin","fingerprint"?}`: `ca` only when the probe verified chain and name
    (`ca-unverified`), `pin` only with the probed fingerprint (`trust-mismatch`).
  - `POST …/draft/discover` (Prometheus) `{"draft","host","port","scheme","auth":"none"|"basic"|"bearer","user"?,"password"?}`
    → `{"draft","targets":[{"job","instance","nodename","release","up","lastSampleAt","eligible","reason"}]}`; no target at
    all is `422 TELEMETRY_FAILED reason:"no-targets"` with the guide sentence.
  - `POST …/draft/test` `{"draft","host","port","scheme"?,"user"?,"password"?,"auth"?,"job"?,"instance"?}` → `{"draft","result"}`
    (the facts the source reports); job+instance must be an eligible discovered target (`needs-targets`, `target-unknown`).
  - `POST …/draft/discard` `{"draft"}`.
  - Refusals: `TELEMETRY_SETUP_FAILED` with `reason` (`draft-missing`, `busy`, `needs-probe`, `needs-trust`, `needs-test`,
    `needs-password`, `needs-targets`, `target-unknown`, `stale`, `trust-mismatch`, `ca-unverified`, `plain-credentials`,
    `limit`); failures at the machine: `422 TELEMETRY_FAILED` with `provider`, `reason` and the sentence (never the
    remote text).
  - Linux SSH: the SSH draft routes under `/api/home/devices/ssh/…` (`tools`, `draft` with `{"os":"linux","id"?}`, `draft/key`,
    `draft/scan`, `draft/trust`, `draft/test`, `draft/discard`); the user is a POSIX name (`^[A-Za-z_][A-Za-z0-9._-]{0,31}$`).
- **Saving**: `POST /api/home/devices` with `"kind":"winrm"|"node-exporter"|"prometheus"|"linux-ssh"` and
  `"telemetry":{"provider","draft","host","port","scheme"?,"user"?,"auth"?,"job"?,"instance"?}` (no password: it is in the draft);
  `POST /api/home/devices/telemetry` `{"id","telemetry":{…}}` connects an existing device or **switches** it from another
  agent-less provider (Windows SSH included): its id, picture and history stay; the old connection's poller entry, key
  files and stored secret go. `{"id","telemetry":null}` disconnects whichever agent-less provider reads it. Both take only
  a draft made for that device whose test (at most 15 min old) matches what is sent (`stale`, `needs-test`). Thermo must be
  disconnected first. `platform` becomes the provider's (`windows` or `linux`) and `machine_upsert` cannot change it
  while connected.
- **A machine of the site configuration** (`source:"site"`) is connected the same way, on its own tile (page → Telemetry
  settings), with the same drafts, tests, trust, permissions, switching and disconnecting: pass its id as `id` to the draft
  routes (`…/endpoint/draft`, `…/ssh/draft` with `os:"linux"`, `…/windows/draft`) and to `POST /api/home/devices/telemetry`
  or `POST /api/home/devices/windows` (Windows over SSH: a managed connection only, never an SSH alias). Its identity
  stays in `site.json` and is never written; `machine_upsert` / `machine_remove` still refuse it (`MACHINE_READ_ONLY`),
  nothing is added to `devices.json`, and it cannot be removed (its display metadata is the owner's override: below,
  "Editing a machine of the site configuration"). What the hub stores is a
  **binding** in `state/home/site-telemetry.json` (`{"schema":1,"bindings":[{"id","provider","platform","configuredAt","configuredBy"}]}`,
  0600, no secrets); the connection itself (key ids, passwords, trust) is in `windows-hosts.json` /
  `telemetry-hosts.json` under the same id, as for an added device. Which site machines can take one, and the rule
  that keeps two feeds from reading one machine:
  - **Thermo wins where the site says so.** A site machine with `thermoId` is read through Thermo (`site.json` +
    `private/thermo-hosts.json`) and refuses a binding (`400`, detail names `thermoId`); the router is reported by the
    router adapter and refuses one too. `POST /api/home/devices/thermo` does not apply to site machines (`404`).
  - The site's `platform` (`machines[].platform`, optional: `macos`, `windows`, `linux`, `other`), when set, limits the
    providers to that system's; without it every agent-less provider is offered and the binding records the platform
    its provider reads. Disconnecting returns the tile to what the site configuration says; it never falls back to
    another stored or default connection.
  - Only ids that are site machines now count. A binding whose machine left `site.json` (or got a `thermoId`, or another
    platform) is neither polled nor shown anywhere; its connection stays on disk, so an edit of `site.json` never
    deletes a key, until `POST /api/home/devices/telemetry {"id","telemetry":null}` clears it. Pollers, restarts and the
    SSH key sweep include the effective bindings, so a connection survives a restart.
  - Reading side: the site tile keeps `source:"site"`, `readOnly:true`, `hash:null`, its name, role, picture, hardware
    and (a NAS) its probed services, and gains `kind:"thermo"` (has a telemetry feed), `platform`, `telemetry.provider`,
    gauges, history, volumes and `native`. Every site machine carries `telemetryEditable` (it can take a binding) and
    `telemetryBinding` (`{"provider","platform","configuredAt"}` or `null`); `machine_list` lists the `platform` and
    `telemetry.provider` but never the connection.
- **Reading side**: `GET /api/home` tiles carry `telemetry.provider`, `target` and `connection` (public facts:
  `{"mode","host","port","scheme","tls":{"mode","fingerprint"?},"auth","user"?,"job"?,"instance"?}`; never a password or
  token; `machine_list` carries neither). Polls: never more often than 30 s, at most four devices at a time per provider.
- **Not supported** (said so, never faked): Windows Exporter, GPU utilisation and power on Linux, IPv6 addresses,
  Kerberos/NTLM for WinRM, a custom CA bundle per connection (use pin mode or `NODE_EXTRA_CA_CERTS`).

### LLM runtime endpoints

Local LLM runtimes the hub reads itself over HTTP (core module `runtimes`), every 30 s (`RUNTIMES_POLL_SECONDS`,
10–600). What they report appears in `GET /api/home` → `machines[].runtimes` and fills the stack blocks that name
their service. Endpoints come from `site.json → runtimes` (`source: "site"`, read-only here) and from this API
(`source: "ui"` or `"agent"`, stored in `state/runtimes-config.json`).

An endpoint: `{"id"?,"machine","kind"?,"url","name"?}`. `id` is `[a-z][a-z0-9-]{1,47}` (default `<machine>-<port>`);
`machine` is a machine on the overview; `kind` is `auto` (default: recognised by its answers), `llama-swap`,
`ollama`, `lmstudio`, `llama-cpp`, `vllm`, `sglang`, `omlx`, `mlx-serve` or `openai`; `url` is an origin only:
`http(s)://<IPv4 or localhost>:<port>`, no path, query, user or password, on loopback or inside the site's
`lanCidrs` (any private range when none are set). At most 40 endpoints, each URL once.

What the hub requests, and nothing else: `GET` on `/v1/models`, `/running`, `/api/version`, `/api/metrics/stats`,
`/api/metrics/activity`, `/api/metrics`, `/metrics`, `/api/tags`, `/api/ps`, `/api/v0/models`, `/health`, `/props`,
`/version`, `/v1/models/status`, `/admin/api/stats` (bodies ≤ 512 KiB, 3 s timeout, no redirects). Never a model-loading
or unload route (llama-swap's `/upstream/…`, `/unload`, `/api/models/unload`), never `/slots`, never a prompt.
For the request history of a llama-swap endpoint, two more reads, also GET only: `/api/metrics/activity?page=<1–10>&limit=200`
(exactly those parameters) and the access-log stream `/logs/stream/http?no-history`, held open. The history goes to
`state/runtimes/<machine>/requests-YYYY-MM.jsonl` and feeds [LLM & Diffusion](#llm--diffusion-ui-models).

- `GET /api/runtimes/endpoints` (`read`) → `{"endpoints":[…],"kinds","readPaths","historyReadPaths","limits":{"endpoints":40},"intervalSeconds"}`.
  `historyReadPaths` lists the two history reads. A llama-swap endpoint also has `history`:
  `{lastSyncAt, lastIngestedAt, recordsToday, stream: connected|connecting|reconnecting|off, lastError?}`.
  Each endpoint has the fields above plus `source`, `readOnly`, `hasToken` (never the token), `addedBy`/`addedAt` for
  stored ones, and its last read: `state` (`ok`, `stale`, `error`, `off` = nothing listens there, `waiting`),
  `detectedKind`, `lastAttemptAt`, `lastSuccessAt`, `lastError` (`refused`, `timeout`, `auth`, `http-<status>`,
  `not-json`, `too-large`, `unrecognised`, …), `lastErrorAt`.
- `POST /api/runtimes/endpoints` (`home:write`) `{"endpoint":{…}}` → `201` created or `200` →
  `{"ok","id","created","changed","by","endpoint"}`; the endpoint is read at once and the answer carries that read.
  The same `id` replaces the stored entry.
- `POST /api/runtimes/endpoints/remove` (`home:write`) `{"id"}` → `{"ok","id","removed":true}`; its token goes too.
- `POST /api/runtimes/endpoints/token` (password sign-in with write access; never an API key) `{"id","token"|null}` →
  `{"ok","id","hasToken"}`. The token (8–512 printable characters) is sent as `Authorization: Bearer …` to that
  endpoint only and kept in `private/runtime-tokens.json` (mode 0600; `RUNTIME_TOKENS_FILE` overrides the path).
- Errors: `400 RUNTIME_ENDPOINT_INVALID` (with `details` naming the field), `404 RUNTIME_ENDPOINT_NOT_FOUND`,
  `403 RUNTIME_ENDPOINT_READ_ONLY` (from `site.json`), `409 RUNTIME_ENDPOINT_CONFLICT` (the URL is another
  endpoint's), `409 RUNTIME_ENDPOINT_LIMIT`.
- MCP: `runtime_endpoints_list` (`read`), `runtime_endpoint_upsert` and `runtime_endpoint_remove` (`home:write`),
  with the same arguments. Tokens never go through MCP.
- The module declares the integration `runtimes.endpoints` (kind `llm-runtimes`): its status is `ok`, `stale`,
  `error`, `off`, `not-configured` or `disabled`, with one item per endpoint (docs/plugins.md → Integrations). A
  llama-swap item's summary says when its history last grew and how many records came in today. Off, nothing is
  read, the access-log streams close and no history is provided.

## Project Tracker (UI: #projects, #items, #releases)

A small tracker for your own development work, stored in `state/hub.db` ([storage.md](storage.md)).
Reading needs any sign-in (API keys: `read`); every write needs a write session or an API key with the
`tickets:write` scope. Writes return `400/404/409 TICKETS_FAILED` for invalid input, an unknown ticket, or a
stale `rev` / an existing release. HTTP POST bodies are limited to 16 KiB (UTF-8, including JSON);
tracker write arguments have the same size limit over MCP. Text-field character limits do not override this byte limit.
Send only changed fields when updating. Dates must be real calendar dates in `YYYY-MM-DD` form.

- **Projects** `{id, key, name, description, type, rev}`; none exist until you create one in the UI, with `POST /api/tickets/projects` or MCP `project_save` (a new, empty tracker also takes the seeds listed in site.json → `tracker.projects`, once). Ticket ids are `<KEY>-<n>`, e.g. `APP-12`.
- **Ticket** `{id, project, title, description, type: bug|feature|task, status: open|in-progress|done|cancelled, priority: low|normal|high|urgent, release: <version>|null, assignee|null, labels[], refs[], reporter, createdAt, updatedAt, closedAt|null, rev, comments[], history[]}`. `closedAt` is set on entering `done`/`cancelled` and cleared on reopening. `history` retains the latest 200 field changes (title/description only as "changed").
- **Release** `{project, version, status: planned|released, targetDate|null, releasedAt|null, notes, rev}`. A ticket's `release` must be an existing version of the same project. The literal `none` is reserved for filtering unassigned releases/assignees and cannot be used as a version or assignee name.

Routes:

- `GET /api/tickets?project=&status=open|in-progress|done|cancelled|active[,…]&type=&priority=&release=<version>|none&assignee=<name>|none&label=&q=&limit=` → `{updatedAt, projects, releases:[…, counts:{open,in-progress,done,cancelled}, total], total, tickets:[… without comments/history, comments:<count>], provenance}`. Release counts are over all tickets, not just the filtered ones. `provenance` ([Provenance](#provenance)) counts who created the listed tickets (people, service accounts, projects seeded from site.json) and who changed them later.
- `GET /api/tickets/<ID>` → the full ticket with `comments`, `history`, `rev` and `provenance` (its creator, then everyone who commented or changed it). The ticket writes below answer with the same shape.
- `GET /api/tickets/search?q=<words>&project=&status=&type=&priority=&release=&assignee=&label=&limit=1..100` (default 20) → `{q, total, tickets:[… as in the list, plus snippet, score]}`. Full-text search inside tickets (title, description, comments, attachment names, labels, refs, people) with the list's field filters; `q` follows the rules of [Search](#search) and needs at least one letter or digit. Best match first; `total` counts every match. `400` for a bad parameter.
- `GET /api/tickets/people` → `{people:[{name, kind: user|agent|other, assigned, active}]}`: the names the assignee field suggests. Sign-in accounts (`user`) and service accounts (`agent`) that are not disabled, then every name tickets already carry (`other`), the busiest assignee first. `assigned` counts tickets assigned to the name, `active` those still open or in progress. Names and counts only: no ids, roles or scopes.
- `POST /api/tickets` `{project, title, description?, type?, status?, priority?, release?, assignee?, labels?, refs?}` → `201` ticket. Defaults: `task`, `open`, `normal`.
- `POST /api/tickets/update` `{id, rev, …fields to change}` → ticket. `rev` must be the one you read; otherwise `409`.
- `POST /api/tickets/comment` `{id, text}` → ticket. Append-only, no `rev`.
- `POST /api/tickets/releases` `{project, version, status?, targetDate?, releasedAt?, notes?, rev?}` → release. Omit `rev` to create; pass it to change. `released` without a date stamps today.
- `POST /api/tickets/projects` `{id, key, name, description?}` → `201` new project; `{id, rev, name?, description?}` → `200` changed project. `id` and `key` never change.

MCP `tickets_list` uses `query` for text search and an integer `limit` of 1–200 (default 50); HTTP uses `q` and supports `limit` of 1–5000. `release_save` accepts `releasedAt` as well as `targetDate`. MCP `ticket_search` takes `query` plus the same filters as `GET /api/tickets/search` and returns the same document.

`message` in a tracker, review or search error is Czech source text for a browser session or a device token (the web UI translates it through its dictionary) and English for an API key.

Attachments (stored in `state/tickets/attachments/<sha256>`, at most 20 per ticket and 100 MB per file, 2 GB in total):

- `PUT /api/tickets/<ID>/attachments?name=<file name>` with the raw file as `application/octet-stream` → `201` ticket. `tickets:write` for API keys; sessions need the same origin. The file is streamed and, like every raw upload, has up to 20 minutes to arrive. A ticket that already has 20 files answers `409` before anything is stored. A name the ticket already has (in any case) is stored with `-2`, `-3`, … before its extension, so a name is one file: read the stored name in the answer.
- `GET /api/tickets/<ID>/attachments/<attachment id>[?download=1]` → the file. The type is decided from the bytes; the client's `Content-Type` is never used, and the file name only settles what the bytes leave open (whether a file is text, sound or picture in an Ogg, WebM, Matroska or MP4 container, a bare MP3 or AAC frame). PNG/JPEG/GIF/WebP, plain text, audio (MP3, WAV, FLAC, Ogg, AAC, M4A, WebM, Matroska) and video (MP4, QuickTime, WebM, Matroska, Ogg, AVI, 3GP) are served inline under that type, everything else (SVG and HTML included) is a download or plain text. One byte range per request (`Range: bytes=a-b`, `a-` or `-n`) → `206` with `Content-Range`, which is what a player seeks with; any other `Range` → `416`. Every response is `sandbox`ed and `nosniff`.
- `POST /api/tickets/attachments/delete` `{id, attachment}` → ticket. The file is removed when no ticket uses it any more.
- `GET /api/tickets/<ID>` lists `attachments: [{id, name, type, size, sha256, by, at}]`; the list view has `attachments: <count>`.
- In a `description` or a comment, `![name]` points at the ticket's attachment of that name (not `![alt](url)`, which stays text). The web UI shows it as a chip that opens the file; a name the ticket has no file for stays as written, and one whose file was removed is shown struck through. The API stores and returns the text as it is: read the file itself with the id from `attachments`.

MCP tools (service-account key): `tickets_list`, `ticket_search`, `ticket_get`, `ticket_attachment_get` (`read`; images up to 5 MB come back as an image, text up to 256 kB as text); `ticket_create`, `ticket_update`, `ticket_comment`, `release_save`, `project_save` (`tickets:write`).

The web UI (`#projects`, `#projects/<id>`, `#items`, `#items/<ID>`, `#releases`) is in the reader's language (English unless the site sets `defaultLanguage`), with dates in the site's time zone. An empty tracker shows how to start: create a project, or copy the prompt for a coding agent (`project_save`, then `ticket_create`, scope `tickets:write`) with the MCP connection snippet. Keys on the lists: `/` filter, `n` new item, `j` / `k` move, `Enter` open, `v` table or board; on an item `c` focuses the comment box. A new item takes files while it is written (button, drop, or paste with Cmd/Ctrl+V; a paste into the description leaves the file's chip at the caret) and uploads them once the item exists; an item's page lists its files under the description as tiles and opens one in a viewer (picture, audio or video player, text; anything else is a download).

An agent that should file tickets needs `tickets:write`: a custom selection, the Editor preset or full access (see Access → service accounts).

Projects carry `type`: `app`, `game`, `other` or `null` (`POST /api/tickets/projects` and MCP `project_save` accept it).

### Review

Variants agents propose for a project (HTML mockups, images, 3D models as `.glb`, clips as `.mp4`/`.webm`, audio tracks), decided in `#review`. The full contract is in
[review.md](review.md). Writes need `review:write` for API keys.

- `GET /api/review?project=&ticket=&status=open|active|done|archived|all&feedback=pending` → `{sets:[summary], provenance}`.
- `GET /api/review/sets/<R-n>` → the full set with all rounds, decisions, comments and `provenance`. Publishing a round counts as the record (`unit: rounds`), a decision or comment as a change ([Provenance](#provenance)).
- `HEAD|GET /api/review/blobs/<sha256>` → a published file (range requests); `GET /api/review/frame/<sha256>` → a sandboxed HTML mockup.
- `PUT /api/review/blobs/<sha256>?offset=&size=` (`application/octet-stream`, ≤ 8 MiB per chunk) → `{received,size,complete}`; `409` with `received` on a wrong offset.
- `POST /api/review/publish` (≤ 64 kB) → `201` new set or `200` next round; `POST /api/review/feedback` (≤ 64 kB) `{set, round, item, rev, variant, status, note?, comments?, attachments?, editComments?:[{id, text}], deleteComments?:[id]}` (edit or delete your own saved comments; someone else's → `403`); `POST /api/review/sets` `{id, rev, status?, title?}`.
- MCP: `review_list`, `review_get` (`read`); `review_publish` (`review:write`). Upload files with `scripts/review-push.mjs`.
- The page compares variants side by side, one at a time or (images and clips of one shape) by swiping a divider (the default for an `aligned` item); clips and tracks play in sync with one variant audible, counts the round's
  decisions and shows comments as threads with the round that answered them. With no set on the hub it explains
  the two ways to publish and offers a prompt for a coding agent. Details: [review.md](review.md#the-page-review).

### Search

Full-text search over tickets (id, title, description, comments, labels, refs, people) and review sets (title,
description, round notes, item and variant texts, notes, comments). `read` is enough for API keys.

- `GET /api/search?q=<words>&kind=ticket|review&project=<id>&limit=1..100` (default 20) →
  `{q,total,results:[{kind,id,project,updatedAt,title,snippet,score,meta}],indexed:{ticket,review}}`, best match first.
- `meta` says what a hit is right now, so a result list needs no second request: for a ticket
  `{status,type,priority,assignee,release}`, for a review set `{status,done,feedbackPending,round,items,decided}`.
- `indexed` counts the documents the index holds per kind. All zeros means there is nothing to search yet (an
  empty hub), which is not the same as a query without matches. An empty `q` returns no results, only `indexed`.
- A query that is exactly an id (`APP-12`, `R-3`, any case) puts that record first.
- `q` is plain words (≤ 200 characters, at most 12 words), never query syntax: every word must match, as a prefix,
  ignoring case and diacritics (`prihlas` finds `Přihlášení`). A title hit ranks above a body hit.
- In `title` and `snippet` the matched words are wrapped in `\u0001` … `\u0002`; render them as text (e.g. `<mark>`
  via text nodes), never as HTML. Results link to `#items/<id>` or `#review/<id>`.
- `400 SEARCH_FAILED` for a bad parameter (unknown key, `kind`, `project`, `limit`).
- MCP: `search` (`read`) is the same search without `meta` and `indexed`; `ticket_search` (`read`) narrows tickets by fields.
- In the web UI `/` focuses the search box from anywhere; `#search/<words>` groups the hits by kind, `j` / `k` or the
  arrow keys walk them and `Enter` opens one. Without a query, with no matches and on an empty hub the page explains how search reads a query.

## Collectors: versions, host protection, SSH keys, software watch, router

These screens show snapshots that read-only collectors write into the data directory. Nothing here makes the hub contact another machine: a request only reads files. `docs/plugins.md` says how a machine gets an `ssh` entry; `examples/systemd/` and `scripts/systems/install-launchd.sh` schedule the collectors.

| Collector | Writes | Every | Read by |
|---|---|---|---|
| `node scripts/collect-systems.mjs` | `data/systems/snapshot.json`, `history.jsonl` | 6 h | `GET /api/systems` |
| `node scripts/check-upstream.mjs` | `data/systems/upstream.json` | 12 h | `GET /api/systems` |
| `node scripts/collect-security.mjs` | `data/security/ssh-keys.json` | 24 h | `GET /api/security` |
| `python3 scripts/collect-router-unifi.py` | `data/router-observations.json` | 1 min | `GET /api/router`, `GET /api/home` |

### Collector state

`GET /api/systems` and `GET /api/security` carry `collector` in every answer, with a snapshot (`200`) or without one (`404 SYSTEMS_MISSING` / `404 SECURITY_MISSING`, where it sits next to `error`):

```json
{"state": "ok", "configured": true, "collectedAt": "2026-11-08T12:00:00.000Z", "ageSeconds": 3600,
 "intervalSeconds": 21600, "staleAfterSeconds": 27000, "script": "scripts/collect-systems.mjs"}
```

| `state` | Meaning |
|---|---|
| `not-configured` | No machine in the site configuration has an `ssh` entry the collector could use. `machines` is `[]` |
| `waiting` | Machines are configured (`machines` lists them) but no snapshot has been written yet |
| `stale` | The snapshot is older than `staleAfterSeconds` (the interval plus a quarter): the scheduled job did not run when it should have |
| `ok` | A snapshot of the expected age |

On `/api/systems` the object also has `upstream` (the same fields for the release check, 12 h) and `watch: {"source": "local" | "none", "items": n}`.

`GET /api/collectors` (admins, or a role or key with `security:read`) gives the states alone and always answers
`200`, also on a hub where nothing has been collected:

```json
{"schemaVersion": 1, "generatedAt": "2026-11-08T12:00:00.000Z", "collectors": {
  "systems": {"state": "waiting", "configured": true, "collectedAt": null, "ageSeconds": null, "intervalSeconds": 21600, "staleAfterSeconds": 27000, "script": "scripts/collect-systems.mjs"},
  "security": {"state": "ok", "configured": true, "collectedAt": "2026-11-08T03:00:00.000Z", "ageSeconds": 32400, "intervalSeconds": 86400, "staleAfterSeconds": 108000, "script": "scripts/collect-security.mjs"},
  "router": {"state": "not-configured", "collectedAt": null}}}
```

`upstream` is present once a machine snapshot exists. `router.state` is the status of `GET /api/router`.
Use this route to ask "has anything arrived?" (the getting-started checklist does): the data routes are a
`404` until a collector has run, and a browser logs every one of those.

### `GET /api/systems` and `GET /api/security` (admins, or API keys with `security:read`)

- `/api/systems` → `{"schemaVersion":1,"generatedAt","collectedAt","oldestCollectedAt","collectedFrom","upstreamCheckedAt","upstreamFailed","categories","machines":[…],"software":[…],"collector","provenance"}` (sources `systems`, `upstream`, `watch`; the protection page shows `systems` alone). A machine: `id`, `name`, `kind` (`mac` | `nas`), `reachable`, `stale` (the last probe failed and this is its previous record), `error`, `collectedAt`, `hw`, `uptimeSeconds`, `os` (`name`, `version`, `status`, `updates[]`), `checks[]`, `listening[]`, `brewOutdated[]`, `summary`. A check: `{"id","label","state","value","detail"}` with `state` one of `ok`, `warn`, `crit`, `info`, `unknown`. A software row: `id`, `name`, `category`, `machine`, `installed`, `path`, `source` (`label`, `url`), `latest`, `latestUrl` (the release page, when the source has one), `publishedAt`, `status` (`update`, `current`, `ahead`, `unknown`, `missing`, `n/a`, `floating`), `note`, `running`, `stale`, `upstreamStale`, `upstreamError`, `upstreamCheckedAt`, `upstreamFailedAt`, `inventory` (inventory entry ids this row describes).
- `/api/security` → `{"schemaVersion":1,"collectedAt","collectedFrom","machines":[…],"keys":[…],"otherKeys":[…],"unknownAuthorized":[…],"forgejo","findings":[…],"collector","provenance"}`. A key: `fingerprint`, `type`, `bits`, `name`, `comment`, `copies[]` (`machine`, `owner`, `path`, `mode`, `mtime`, `encrypted`, `backup`), `access[]` (what it opens), `routes[]`. Private key material is never collected: fingerprints, paths and public `authorized_keys` lines only.
- **Text in two forms.** Labels, values, details, notes and finding titles are Czech sentences (the UI's source language). A sentence built from data also comes as parts, in a sibling field ending in `T`, so a client can show it in another language: `"value": "zapnutý · 12 pravidel", "valueT": [{"key": "zapnutý · {rules} pravidel", "params": {"rules": 12}}]`. The fields are `valueT`, `detailT` (checks), `noteT`, `source.labelT` (software rows) and `titleT`, `detailT` (findings). Translate each `key` (English is in `public/i18n-en-*.js`), fill the parameters, join the parts with a space; a parameter that is a list holds labels to translate one by one. A snapshot written before the parts existed has only the text.

### Software watch list

Which programs the versions page follows. A site keeps its own list in `local/software-watch.json`, next to its `site.json` (`SOFTWARE_WATCH_FILE` selects another file; a hub started without a site overlay has no list and answers a write with `409 SOFTWARE_WATCH_UNAVAILABLE`); `config/software-watch.json` is an annotated example and never the active list. Without a list only operating systems, NAS apps and containers are shown, which the probes discover by themselves.

Both routes need the `software:write` scope with an API key (old read/write keys never hold it), or an administrator's session in the browser.

- `GET /api/software-watch` → `{"schemaVersion":1,"source":"local"|"none","file","writable","example","categories":{id:label},"items":[{…item,"hash"}],"machines":[{"id","name"}],"detectKinds","upstreamTypes","cmdArgs","schemes","limits","provenance"}` (`config`, naming the file, while a list exists). `machines` are the machine ids a detect rule may name (the ones probed with `"probe": "mac"`).
- `POST /api/software-watch` applies one change and saves the file atomically:

| Body | Does |
|---|---|
| `{"item": {…}}` | Adds an item. `201` with `{"ok":true,"id","created":true,"hash","items","categories"}` |
| `{"item": {…}, "base": "<hash>"}` | Replaces the item with that id. `base` is its `hash` from the list |
| `{"remove": "<id>", "base": "<hash>"}` | Deletes it |
| `{"categories": {"id": "Label"}}` | Adds or renames categories; may be combined with `item` |

Errors: `422 SOFTWARE_WATCH_INVALID` (`error.details` lists every reason), `409 SOFTWARE_WATCH_CONFLICT` (the item changed since it was read, already exists, or `base` is missing), `404 SOFTWARE_WATCH_NOT_FOUND`, `409 SOFTWARE_WATCH_LIMIT` (200 items, 20 categories, 256 kB). A refused change writes nothing.

An item:

```json
{"id": "node", "name": "Node.js", "category": "infra", "scheme": "node",
 "upstream": {"type": "node"},
 "detect": {"mini": {"kind": "brew", "formula": "node"},
            "server": {"kind": "cmd", "path": "~/.local/bin/node", "args": "--version",
                       "launchd": "com.example.node", "source": {"label": "nodejs.org binary", "url": "https://nodejs.org/en/download"}}}}
```

| Field | Values |
|---|---|
| `id`, `name`, `category` | `id`: 1–40 of `a-z 0-9 . _ -`. `category`: an existing category id (`nas-apps` and `containers` are reserved) |
| `scheme` | Optional: `node` (LTS lines) or `llamacpp` (build numbers before semver) |
| `upstream` | `github` / `codeberg` `{repo, tagPrefix?, tagPattern?, allowPrerelease?}`, `pypi` `{package}`, `npm` `{package, tag?}`, `brew-formula` / `brew-cask` `{name}`, `node`, `none` `{note?}`. A `thermo-feed` upstream names a URL the checker fetches, so it is set in the file only; the API keeps an existing one unchanged |
| `detect.<machine>` | `brew` `{formula}` (up to 4 names, comma-separated), `cask` `{cask}`, `app` `{path}` ending in `.app`, `cmd` `{path, args, match?}`, `pydist` `{glob, package}`, `json` `{path, key?}`; plus optional `launchd`, `upstream` (override for this machine), `source {label, url}`, `inventory [ids]` |

**A detect rule is data, never shell.** Paths are absolute or start with `~/`, contain no `..` and none of the characters a shell acts on; `*` and `?` are allowed in `cmd.path` and `pydist.glob` only. `cmd.args` is one of `--version`, `-version`, `-v`, `-V`, `version`: the probe runs the binary only to print its version, as the SSH user, never as root. Regular expressions (`match`, `tagPattern`) are at most 200 characters without nested quantifiers. The collector applies the argument rule again when it builds the probe input, so a hand-edited rule with other arguments is not run either (its row reads "unverified" with the reason).

### `GET /api/router` (any signed-in account)

The client census and the router's health from the router adapter (`docs/plugins.md` → router adapter).

→ `{"schemaVersion":1,"generatedAt","state","status","adapter":{"id","title"}|null,"freshness","staleAfterSeconds","observedAt","attemptedAt","error","model","firmware","routerMac","devices":[{"mac","id","ip","name","connection","presence"}],"health":{"status","softwareVersion","hardware":[{"name","model","state","firmware","ip"}],"hardwareDown","clients":{"connected","wired","wireless","other","known"}}|null,"configured":{"adapter","host","lanCidrs"},"machine":{"id","name","ip"}|null,"provenance"}` (`collector` for the included adapter, `plugin` for one a plugin provides)

| `state` | Meaning |
|---|---|
| `not-configured` | No adapter: nothing in `site.json → router`, no plugin adapter, no observation file |
| `waiting` | An adapter is configured but has not reported yet (`error: "unknown-adapter"` when `site.json` names one nothing provides) |
| `unavailable` | The adapter's last attempt failed (`error`); `devices` is the last census it had, never an empty list presented as "no clients" |
| `stale` | The last observation is older than `staleAfterSeconds` (180 for the included adapter) |
| `ok` | A fresh observation |

`status` (`ok`, `unavailable`, `not-configured`) and `freshness` are the fields `GET /api/home → router` has always carried. `presence` is what was seen: `associated` (on Wi-Fi), `reachable`, `lease-only` (a DHCP lease is not proof of connectivity) or `cache-only`. Only clients with a host address inside `lanCidrs` are listed.

### MCP tools

| Tool | Scope | |
|---|---|---|
| `software_watch_list` | `software:write` | The list as `GET /api/software-watch` returns it |
| `software_watch_put` | `software:write` | `{item, base?}`, `{remove, base}` or `{categories}`, with the same validation; a refusal comes back as a tool error that lists the reasons |

## Inventory map and services catalog (UI: #inventory-map, #inventory-map/table, #inventory-map/services)

One file, `data/knowledge.json`, is the source of truth for machines, services, tools, model stores, outside services, what depends on what and **where** each credential is kept (never its value). The map, the table and the services view are views of one page (`#services` still opens the services view); a hub without the file is an empty inventory and the first write creates it. Every write, by a person or an agent, goes through the same checker (`public/inventory-rules.js`, also `node scripts/check-knowledge.mjs`): a write that would leave the file invalid is refused and nothing changes.

**Concurrency.** Optimistic, per entry. Every entry has a hash (sha256 of the entry as stored; `GET /api/inventory` → `hashes`). To change or delete an entry send the hash you read as `base`; if the entry changed in between you get `409`: read again and reapply. Omit `base` only to create. An entry nobody touched keeps its hash across writes to other entries.

| Route | Who | |
|---|---|---|
| `GET /api/inventory` | read | `{"doc","gaps","hashes","provenance"}`: the checked document, the gaps (facts not recorded: a secret whose store is `unknown`, a runtime without an address) and one hash per entry id; `provenance` counts the entries by their `verified_by` stamp ([Provenance](#provenance)). `404 INVENTORY_MISSING` while there is no file; `500 INVENTORY_INVALID` when the file fails the checker |
| `GET /api/inventory/export` | read | The file as a download (`home-inventory-<date>.json`) |
| `GET /api/inventory/schema` | read | How to fill it, as data: `entry.fields`, `kinds`, `categories`, `linkKinds`, `secrets.stores` (built-ins, this site's own from site.json → `inventory.secretStores`, and the prefix forms), `places` (site.json → `inventory.places`, then every machine entry), `rules`, `limits`, `examples`, and `inventory: {entries, updatedAt}`: how many entries there are (`0` while there is no file, `null` when the file fails the checker). Never fails for a missing file, so ask here when you only need the count |
| `GET /api/services` | read | `{"updatedAt","services","hashes","provenance"}`: the entries of kind `runtime` |
| `POST /api/inventory/entries` | `inventory:write` | `{"entry":{…},"base"?}`: create or replace one whole entry → `{"ok","published","entry","hash"}`. The hub stamps `verified_at`, `verified_by` ("Home Hub API · <account>") and a default `confidence` |
| `POST /api/services` | `inventory:write` | The same, for entries of kind `runtime` only |
| `POST /api/inventory/entry` | `inventory:write` | `{"id","base","fields":{…}}`: the web form's field edit → `{"ok","published","doc","hashes"}`. `fields` may hold `name`, `type`, `category`, `address`, `version`, `config`, `data`, `managed_by`, `login`, `notes` (an empty string removes the field), `machine`, `secrets` (`[{what, store, ref, check}]`) and `depends_on` (`[{id, kind, label}]`). `{}` only re-stamps the entry as verified today |
| `POST /api/inventory/bulk` | `inventory:write` | `{"entries":[{"entry":{…},"base"?}, …],"dryRun"?}`: create or replace up to 500 entries, all or nothing; the result is checked as a whole, so entries may refer to each other → `{"ok","published","summary":{"create","update","unchanged"},"entries":[{"id","action","hash"}]}`. An entry identical to the stored one is `unchanged` and needs no `base`. `dryRun: true` writes nothing and always answers `200`: the planned actions, or `{"ok":false,"errors","issues"}` / `{"ok":false,"conflicts":[ids]}`. Body up to 1 MB. `keepVerified: true` (password sign-in only; the import in the web UI) keeps each entry's own `verified_at` / `verified_by` |
| `POST /api/inventory/entries/delete` | `inventory:write` | `{"id","base"}` → `{"ok","published","id","deleted":true}`. `base` is required. `422 INVENTORY_IN_USE` (with the ids in `details`) while other entries depend on it or run on it |

Errors of these routes: `400` malformed request (unknown field, bad id, a limit exceeded), `404` unknown id, `409` stale or missing `base` (bulk: the ids are in `details`), `422 INVENTORY_INVALID` when the checker refuses the result — `details` holds its messages and `issues` the same with structure (`{id, field, code, message, text}`, `field` being a path such as `secrets[0].store`) — `429` while another write is being saved, `501` when this hub forwards edits to a writer that cannot bulk or delete, `503` when the file cannot be read or written.

An entry: `id` (lowercase letters, digits, hyphens; never changes), `kind` (`network`, `machine`, `runtime`, `tool`, `model-store`, `secret-store`, `skill-store`, `external`), `name`, `machine` (the id of a machine entry; required for everything that runs on one), and optionally `type`, `category`, `address`, `version`, `config`, `data`, `managed_by`, `login`, `notes`, `secrets`, `depends_on`, `models`, `skills`, `confidence`. Any text that looks like a secret (a key or token, a private key block, a JWT, `password=…`, credentials inside a URL, a long hex or random-looking string) is refused, as is a `check` command that would print one.

**MCP tools** (`POST /mcp`, a service-account key; a tool is listed only for a key that holds its scope):

| Tool | Scope | |
|---|---|---|
| `inventory_describe` | `read` | The schema above, `inventory: {entries, updatedAt}` included. Call it once before writing |
| `inventory_search` | `read` | Text search with optional `kind` and `machine`; returns ids and hashes |
| `inventory_get` | `read` | One entry in full, its hash and its dependents |
| `inventory_update` | `inventory:write` | Create or replace one whole entry (`entry`, `base`) |
| `inventory_bulk_upsert` | `inventory:write` | `entries: [{entry, base?}]`, `dryRun?`: as `POST /api/inventory/bulk` (one MCP request is at most 64 kB) |
| `inventory_delete` | `inventory:write` | `id`, `base`: hash-checked, refused while something depends on the entry |

## LLM & Diffusion (UI: #models)

Local language and generative models on every machine, built only from the `home.runtimes` and `runtimes.requests`
providers and the machines' stacks (`docs/plugins.md` → extension points). Scope `read`; MCP `models_overview`
(`{range?, graph?}`) returns the same overview, models, clients and known tools, the graph only with `graph:true`.

- `GET /api/models?range=24h|7d|30d` (default `24h`) → `{"schemaVersion":1,"generatedAt","range","empty","providers":{"runtimes":[…],"requests":[…]},"overview","machines","models","clients","graph","known","provenance"}`.
  - `empty` is true when no provider reports a runtime and none holds a request: the page then explains how to connect one.
  - `overview` = `{machines, runtimes:{total,up,down,unknown}, models:{total,loaded,loading,generating,queued,byKind}, memory:[{machine,name,ramGb,residentGb,loaded,models,pools:[{runtime,name,usedGb,capacityGb,basis}]}], range, requests, inputTokens, outputTokens, medianTps, attributed, lastRequestAt, observedAt}`. `residentGb` counts what engines hold; a router's budget is a pool, not residency. `medianTps` is the median generation speed of requests with at least 8 output tokens.
  - `models[]` = one entry per model name across machines: `{key, name, kind, state, active, queued, since, machines, sizeGb, contextTokens, ttlRemainingSeconds, lastRequestAt, requests, tokens, placements:[{machine, runtime, role, engine, gateways, aliases, id, state, active, queued, since, sizeGb, contextTokens, ttlRemainingSeconds, lastRequestAt, requests, tokens}]}`. `active` / `queued` are `null` where no runtime says how busy the model is; models that generate come first. A gateway alias (`qwen-27b` on llama-swap for an oMLX model) is folded into the engine's placement (`gateways`, `aliases`). `kind`: `llm`, `embedding`, `image`, `video`, `music`, `audio`, `other`.
  - `work` = what generates now: `{items:[{machine, runtime, runtimeName, gateways, mode, id, name, kind, active, queued, since}], active, queued, watching:[{machine, id, name}], blind:[…]}`; running first, oldest first. `watching` are the runtimes that report how busy they are, `blind` the running ones that cannot. The same per machine is `GET /api/home` → `machines[].work` (`watching` and `blind` as names there).
  - `clients[]` = `{client, attributed, clientMachine, via:[provider|address|loopback], requests, inputTokens, outputTokens, recent, lastAt, cross, targets:[{machine, runtime, requests, tokens, models:[{model, requests}]}]}`. `client` is `"Unattributed"` and `clientMachine` `null` where the data does not say; `loopback` means the address was 127.0.0.1 (this machine, or a tunnel into it).
  - `graph` = `{lanes:[{id, name}], nodes:[{id, column: client|door|engine|model, lane, label, sub, state, kind?, machine, runtime?, model?, known?, history?, active?, queued?, requests, tokens, recent, lastAt}], edges:[{id, from, to, requests, tokens, recent, tokensRecent, cross, lastAt}], maxRequests, maxRecent, crossRequests, recentMinutes, truncated}`. Lanes are machines plus `unknown` for clients whose machine is not known; `recent` counts the last `recentMinutes` (15).
  - `known[]` = tools a machine's stack names (site configuration or `runtime_publish`) that no provider reports: `{machine, machineName, role: client|runtime, title, description, state, source, models, kind}`.
- `GET /api/models/history?range=24h|7d|30d` → `{"schemaVersion":1,"available","range","stepMs","from","to","buckets":[ISO…],"totals":{requests,inputTokens,outputTokens,medianTps,attributed},"requests":[…],"inputTokens":[…],"outputTokens":[…],"tps":[…],"series":{"model"|"machine"|"client"|"kind":{"keys":[…],"values":{key:[…]}}},"top":{"model"|"machine"|"client"|"kind":[{key,requests,inputTokens,outputTokens,medianTps,medianDurationMs}]}}`. Buckets are hours (24h), six hours (7d) or days (30d) on the site's clock; each series keeps its eight largest keys and folds the rest into `other`. `available` is false when no provider supplies `runtimes.requests`.
- Requests come from every `runtimes.requests` provider, the hub's own llama-swap history among them
  ([LLM runtime endpoints](#llm-runtime-endpoints)). One request reported by two providers counts once (by machine,
  runtime, the runtime's record id and time), and the copy that names a client is kept. A client is named from the
  User-Agent of llama-swap's access log (`site.json → runtimeClients` for a household's own names).
- Errors: `400 INVALID_QUERY` for another range or parameter, `503 MODELS_UNAVAILABLE`.

## Backup jobs (UI: #backup-jobs)

Core module `backup-jobs` (`server/core/backups.mjs`, `server/backup-config.mjs`, `server/backup-runner.mjs`),
integration `backup-jobs.runner` (kind `storage`, can be switched off). The hub is the orchestrator: it connects to a
**target** (any SSH host with a POSIX shell and rsync: a NAS, a server) and to the **sources**, and makes one snapshot
per run. Only tools already on both sides are used (`ssh`, `ssh-keygen`, `ssh-keyscan`, `rsync` on the hub; `sh`,
`mkdir`, `mv`, `rm`, `ln`, `df`, `rsync` on the target). Nothing is installed anywhere. `/api/backups…` is not used:
a household plugin may serve its own backups there.

**Who may do what.** Reading (jobs, runs, snapshots, logs) is `read`. Running, cancelling, deleting a snapshot and
re-reading the snapshot list need `backup-jobs:manage` (a person whose role holds it, or an API key with it; old
read/write keys never get it). Creating, editing, testing, confirming host keys and deleting a job need an
**administrator with a password sign-in** (`403 ADMIN_REQUIRED` otherwise, API keys included): a job decides what the
hub reads and where it sends it.

**Keys and host keys.** Creating a job generates a dedicated ed25519 key pair with `ssh-keygen` in
`private/backup-jobs/<id>/` (directory 0700, private key 0600; `BACKUP_KEYS_DIR` moves it). The private key is never
read, logged or returned; the API returns the public key and an `authorized_keys` line,
`restrict[,from="<hub address>"] ssh-ed25519 … home-hub-backup-<id>` (`from` only when the hub has an address inside
`lanCidrs`). Host keys are **trust on first use**: `test` scans the host (`ssh-keyscan`) and returns the fingerprints
(`SHA256:…`, as `ssh-keygen -l` prints them); a person compares one with the machine and sends it to `trust`, which
scans again and pins only a key with exactly that fingerprint. From then on every connection uses the job's own
`ssh_config` (`IdentitiesOnly`, no agent, `UserKnownHostsFile` holding only the pinned keys,
`StrictHostKeyChecking yes`, `BatchMode`, no forwarding or multiplexing, `~/.ssh/config` not read). A changed host key
is refused (`host-key-changed`); changing a part's host or port drops its pin. Pins and deletions are in the access
audit (`backup-job-created`, `backup-host-key-pinned`, `backup-snapshot-deleted`, `backup-job-deleted`).

**Snapshot layout** in the target's destination directory:

```
<dest>/2026-11-11T023000Z/<source name>/…   one directory per successful run (UTC start time)
<dest>/latest -> 2026-11-11T023000Z          the snapshot of the last successful run
<dest>/.in-progress-<stamp>/                 the run being written; renamed on success, removed by the next run
<dest>/.home-hub-backup-job                  the owner marker: the id of the job that writes here
```

**One destination, one job.** Saving a target that equals, contains or lies inside another job's (same host and
port) is refused (`409 BACKUP_DEST_SHARED`). What validation cannot see (an IP and a name for one machine, a symlink)
the owner marker catches: the first run writes the job id into `.home-hub-backup-job`, and every later prepare,
rename, prune and delete-snapshot refuses a destination whose marker names another job (`dest-owned`); the
connection test reports it too.

Each source is pushed with `rsync -a --delete --numeric-ids --stats --timeout=600 --link-dest=<dest>/<previous>/<name>`,
so unchanged files are hard links into the previous snapshot: every snapshot is a full, browsable tree that costs only
what changed. A source on another SSH host is first mirrored into `state/backup-jobs/<id>/staging/<name>/` on the hub
(incremental `rsync` pull; `BACKUP_STAGING_DIR` moves it), then pushed like a local one: rsync cannot copy between two
remote hosts, and the job's key is never handed to another machine. After a good run the staging copy of a source that
is no longer in the job is removed (the hub does not check its own free space before staging: the size of a remote
source is not known without a full rsync dry run).

**What a local source never carries.** A local source may not be, or lie inside, the key directory, the backup state
(`state/backup-jobs/`) or the staging directory (`400 BACKUP_SOURCE_PROTECTED` when saved, `source-protected` when a
symlink moved in between). When a source contains any of them, or the hub's `private/`, they are excluded
(`--exclude=/<relative path>/`, with `* ? [ ] \` escaped). Paths are compared after `realpath`, and without regard to
case on macOS and Windows. `~` and `~/…` are the home of the user the hub runs as.

**Seal, then retention.** After the copies, one remote step renames `.in-progress-<stamp>` to `<stamp>` (refused if a
directory of that name already exists: `stamp-exists`) and points `latest` at it; that step decides whether the run
succeeded. Retention is a separate step after it: a snapshot stays when it is among the newest `keepLast` or younger
than `keepDays` (at least one must be set; a hand-edited file with neither prunes nothing). This run's snapshot and the
newest are never deleted. Every step that may delete (leftovers, retention, delete-snapshot) runs under the job's
deadline, not the 60 s of a short ssh command.

**Warnings** (`result: "warning"`, `warnings: [codes]`, `warningMessages`): the snapshot is kept and nothing is pruned.
`partial`: rsync exit 23/24 (unreadable or vanished files; decided by the exit status alone, before any stderr is read).
`source-empty`: a source sent nothing but its own directory. `newer-snapshot`: the target holds a snapshot named
later than this run (a clock that went back). `prune-failed`: the snapshot is good, deleting old ones failed. SSH
errors are read from stderr only when the exit status is ssh's own (255) or rsync's connection errors (12, 30, 35).

**Runs.** One run per job at a time: in memory, and a lock file `state/backup-jobs/<id>/run.lock` (`{pid, runId,
startedAt, timeoutMinutes, child}`) that a second hub process on the same state respects. A lock is taken over when its
process is gone, or when it is older than the job's deadline plus 10 minutes whoever holds it (a reused PID cannot keep
it). Each process has a deadline (short ssh commands 60 s, the rest `timeoutMinutes`, 5–2880, default 360), runs in a
process group of its own and is cancelled with SIGTERM, then SIGKILL, to the whole group. A run is recorded as
`running` when it starts and its log is written to disk as it goes (`GET …/log`, ≤ 256 KiB; the last 200 runs are
kept). Test, trust, refresh, edit and delete answer `409 BACKUP_BUSY` while the job runs. A `runs.json` that cannot be
read is never overwritten (`500 BACKUP_HISTORY_UNREADABLE`; the views show the job with `historyUnreadable: true`).

**Stopping the hub.** On SIGTERM or SIGINT the server stops taking requests and calls every module's `stop()` (at most
`SHUTDOWN_GRACE_MS`, default 15 s, then it exits anyway; a second signal exits at once). A running backup ends as
`interrupted`: its rsync and ssh are stopped and its record and log are written. After a crash or `kill -9`, the next
start marks a run left `running` as `interrupted`, removes the stale lock and stops the rsync or ssh that lock names
(only when that pid still runs one of the backup tools); the next run removes the unfinished snapshot.

**Schedule.** `daily` or `weekly` (`days` 1 = Monday … 7) at `time` HH:MM in the site time zone, or `manual`. A time
a DST change skips runs an hour later; a repeated time runs once. One in-process timer wakes at the soonest next run
(at most an hour ahead, then it looks again) and re-arms after every change; a slot that comes due while a re-arm is
in flight still fires, and concurrent re-arms leave one timer. **Missed runs:** when the hub starts and a job's newest
scheduled slot is later than both its last attempt and its last change, the job runs **once** (trigger `catch-up`) a
minute after the start, however many slots were missed. While the integration is off nothing is started or caught up.

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/api/backup-jobs` | read | `{jobs, suggestions, timeZone, canManage, disabled?}`; `suggestions` are the site's machines for the wizard |
| GET | `/api/backup-jobs/detail?id=` | read | `{job, publicKey, authorizedKeys: {line, plain, address}, runs, snapshots}` |
| GET | `/api/backup-jobs/log?id=&run=` | read | One run's log as `text/plain` |
| POST | `/api/backup-jobs/create` | admin | `{name}` → 201 with the detail; a draft job with its own key |
| POST | `/api/backup-jobs/update` | admin | `{id, base, name?, target?, sources?, excludes?, schedule?, retention?, timeoutMinutes?, enabled?}`; `base` is the job's `hash` (409 `BACKUP_CONFLICT` when stale) |
| POST | `/api/backup-jobs/test` | admin | `{id, part: "target" \| "source", index?}` → `{result: {state: trust \| changed \| ok \| problem, hostKeys?, pinned?, checks: [{id, ok, value?}], error?, message?}}` |
| POST | `/api/backup-jobs/trust` | admin | `{id, part, index?, fingerprint}` pins the host key |
| POST | `/api/backup-jobs/delete` | admin | `{id, base}`; deletes the job, its key and history. Snapshots on the target stay |
| POST | `/api/backup-jobs/run` | `backup-jobs:manage` | `{id}` → 202 `{started: {runId, snapshot, startedAt}}` |
| POST | `/api/backup-jobs/cancel` | `backup-jobs:manage` | `{id}` |
| POST | `/api/backup-jobs/delete-snapshot` | `backup-jobs:manage` | `{id, snapshot}`; `latest` moves to the newest one left |
| POST | `/api/backup-jobs/refresh` | `backup-jobs:manage` | `{id}`: read the snapshot list and free space from the target again |

A job: `{id, name, enabled, target: {host, port, user, path, hostKey: {type, fingerprint, pinnedAt, pinnedBy}},
sources: [{name, kind: "local", path} | {name, kind: "ssh", host, port, user, path, hostKey}], excludes, schedule:
{mode, time, days}, retention: {keepLast, keepDays}, timeoutMinutes, hash, missing}` (`missing`: codes `target`,
`target-key`, `sources`, `source-key:<name>`) plus, in lists, `state` (`draft`,
`off`, `ready`, `running`, `ok`, `warning`, `failed`, `cancelled`, `interrupted`), `running`, `nextRunAt`, `lastRun`, `lastSuccessAt`,
`sizeBytes` (logical size of the newest good snapshot), `snapshots`, `space`. A run: `{id, trigger: manual | schedule |
catch-up, by, startedAt, finishedAt, durationMs, result: running | ok | warning | failed | cancelled | interrupted,
error?, message?, warnings?, warningMessages?, snapshot, present, deletedAt, stats: {files, filesTransferred, totalBytes,
transferredBytes, sentBytes}, pruned}`. Validation: hosts are names or IPv4 addresses,
users `[A-Za-z_][A-Za-z0-9._-]*`, remote paths absolute without spaces, quotes or shell characters; local paths
absolute or `~/…`; no `.`/`..` segments; nothing that looks like a secret (in paths and exclude patterns only
unmistakable credentials count: a hash-named directory is fine). `jobs.json` is read with the same validators: a part
written by hand that fails them is dropped, so the job reads as incomplete. Errors are `BACKUP_<REASON>` with a
sentence in `message` (`server/backup-runner.mjs → BACKUP_ERRORS`); a validation error also has `field`
(`target.path`, `sources[1].host`, …) and the English `details`. While the integration is off, reads carry `disabled` and
`test`, `trust`, `run`, `delete-snapshot` and `refresh` answer `409 INTEGRATION_DISABLED`.

MCP: `backup_jobs_list` (scope `read`) returns every job as in `GET /api/backup-jobs`.

**On the target, once per job** (the wizard shows the same): a user with a real shell (not `nologin`), the destination
directory owned by it, the `authorized_keys` line in `~<user>/.ssh/authorized_keys` (`.ssh` 0700, file 0600), SSH on,
rsync present. That user's login shell must accept POSIX `sh -c '…'` quoting (sh, bash, zsh, dash, ksh; fish works;
csh and tcsh do not). A source on another machine needs the same public key for the user the job names there. The key
gives a shell on each of those machines (restricted by `restrict`, and by `from="…"` when given). On the target an
`rrsync` forced command is not possible, because the hub runs `mkdir`, `mv`, `rm`, `ln`, `cat` and `df` in the
destination; on a source that only has to be read, `command="rrsync -ro <path>"` before the key narrows it to read-only
rsync (the wizard's connection test then reports `no-shell`; the runs work).

## Git LFS (UI: #git-lfs)

LFS objects of repositories on connected git hosts (GitHub, GitHub Enterprise, Gitea, Forgejo, or a plugin's
provider). The rules, the hosts' real capabilities and the token permissions are in `docs/git-lfs.md`. Reading needs
`read`. Managing connections and deleting needs `git-lfs:write`, a core scope that old write keys do not get. While
the integration `git-lfs.hosts` is off, every GET answers `200 {"disabled":{…}}` with empty lists and every POST
answers `409 INTEGRATION_DISABLED`.

- `GET /api/git-lfs` → `{"schemaVersion":1,"enabled","graceHours","refreshMinutes","maxDelete","git":{ok,version},"providers":[…],"connections":[…]}`.
  - `providers[]` = `{id, title, kind: builtin|plugin, capabilities:{listRepos, checkObjects, listObjects, deleteObjects, tokenScopes}, fixedBaseUrl, token:{permissions[], note, url, urlTemplate}}`. `urlTemplate` holds `{web}` for the host's address.
  - `connections[]` = `{id, provider, providerTitle, name, baseUrl, web, plainHttp, repoMode: all|owner|selected, owner, repos, login, scopes, tokenSet, createdAt, createdBy, updatedAt, updatedBy, capabilities, placement: {service:{id,name,machine,machineName}, storage:{…}|null}|null (where the inventory says the host and its LFS object store run; server/git-lfs-placement.mjs), scan:{running, startedAt, finishedAt, error, truncated, repos:[{fullName, state: ok|error, error, scannedAt, complete, incomplete: no-refs|no-default-branch|null, storedCheck: listed|ok|partial|failed|skipped, defaultBranch, refs, objects, bytes, url}]}}`. The token itself is never in an answer; `tokenSet` says whether one is stored.
- `GET /api/git-lfs/objects?connection=&repo=&q=&ext=&status=all|current|branch|history|orphaned&minSize=&maxSize=&sort=size|path|repo|status|commit|lastSeen|oid&dir=asc|desc&offset=&limit=` (`commit` = the date of `lastCommit`; `limit` 1–200, default 50; sizes in bytes; `ext=-` = no extension) → `{"total","offset","limit","totals","filtered","extensions":[{ext,count}],"items":[…]}`.
  - `totals` (for the chosen connection or repository) and `filtered` (after every filter) = `{count, bytes, reclaimableCount, reclaimableBytes, byStatus:{current|branch|history|orphaned:{count, bytes}}}`.
  - An item = `{oid, size, status, stored: true|false|null, paths[], pathCount, currentPaths[], refs[] (tips that contain it), refCount, via[] (refs its commits were reached from), firstCommit:{sha,at}, lastCommit, commits, remembered, firstSeenAt, lastSeenAt, lastReferencedAt, unreferencedSince, createdAt, connection, connectionName, provider, repo, repoUrl, extension, reclaimable, canDelete, deleteBlocked, manual?}`. `deleteBlocked` is `current`, `history`, `unverified`, `storage-unknown`, `grace`, `unsupported` or `null`. `manual` = `{text, url}`: how to remove a reclaimable object by hand on a host that cannot delete.
  - `400 INVALID_INPUT` for an unknown parameter or value.
- `POST /api/git-lfs/refresh` (`read`; an API key needs `git-lfs:write`) `{connection?, repo?}` → `202 {"started":[ids],"skipped":[{connection, reason: running|throttled}]}`. At most one scan per connection every 30 s.
- `POST /api/git-lfs/test` (`git-lfs:write`) `{provider, baseUrl?, token}` or `{provider, baseUrl?, connection}` (the stored token, same provider and host only) → `{"ok":true,"web","api","plainHttp","user":{login,name},"scopes":[…]|null,"scopesNote","warnings":[…],"capabilities","git"}`.
- `POST /api/git-lfs/repos` (`git-lfs:write`) `{provider, baseUrl?, token | connection, owner?}` → `{"repos":[{fullName, owner, private, archived, defaultBranch}],"total","truncated"}` (at most 1000).
- `POST /api/git-lfs/connections` (`git-lfs:write`) `{id?, provider, name, baseUrl?, token?, repoMode, owner?, repos?}` → `201` (new) or `200 {"connection":{…}}`. The token is checked against the host before anything is stored. Leaving out `token` keeps the stored one, but only while provider and host stay the same (`400 GIT_LFS_TOKEN_REQUIRED` otherwise). Up to 200 repositories. Saving starts a scan.
- `POST /api/git-lfs/connections/remove` (`git-lfs:write`) `{id}` → `{"removed":id}`. Removes the token, the catalog and the mirrors; the host is not touched.
- `POST /api/git-lfs/delete/preview` (`git-lfs:write`) `{connection, repo, oids:[…]}` or `{connection?, repo?, filter:{q?, ext?, minSize?, maxSize?}}` (orphaned objects only) → `{"groups":[{connection, connectionName, provider, repo, revision, scannedAt, canDelete, manual?, eligible:[{oid, size, paths, lastCommit, unreferencedSince, createdAt}], refused:[{oid, size, status, reason, message}], bytes}],"eligibleCount","eligibleBytes","graceHours"}`. `reason` also covers `not-found` and `in-use-elsewhere`.
- `POST /api/git-lfs/delete` (`git-lfs:write`) `{connection, repo, oids:[1–500], revision, requestId}` → `{"requestId","deleted":[{oid,size}],"refused":[{oid,reason,message}],"failed":[{oid,error}],"bytes","stopped?","stoppedMessage?","refsChangedDuring?"}`, after a fresh scan of the repository.
  - Before every 25 deletions the host's refs are read again. `stopped` is `refs-changed` or `refs-unverified` when that check stops the rest, and `audit-failed` when an audit line could not be written. Objects not reached are in `refused` with the same reason.
  - `refsChangedDuring: true` means the refs changed after the last check, when nothing was left to stop.

  Errors:
  - `409 GIT_LFS_UNSUPPORTED`: the host cannot delete. This is every built-in provider.
  - `409 GIT_LFS_CONFLICT`: the revision is not the preview's, or the refs or the stored list changed.
  - `503 GIT_LFS_UNVERIFIED`: the fresh scan failed or was incomplete. Nothing is deleted.
  - `409 GIT_LFS_BUSY`: a scan or another deletion is running.

  The same `requestId` again returns the first answer (`repeated: true`).
- `GET /api/git-lfs/audit` (`git-lfs:write`) → `{"items":[…]}`, the last 50 audit lines, newest first: `{at, requestId, actor, connection, provider, host, repo, oid, size, revision, result: started|deleted|failed, error?}`.
- Host failures answer `502 GIT_LFS_HOST` with `error.host` = `auth`, `forbidden`, `not-found`, `network`, `timeout`, `rate-limited`, `redirect`, `host-error`, `bad-response`, `too-large` or `too-many`. git failures are recorded per repository (`scan.repos[].error`). A missing git binary is `503 GIT_LFS_GIT_MISSING`.

## Version and updates

Home Hub tells which release it runs and whether a newer one is known. It never applies an update: there is no
route for that, and no MCP tool. The check itself is the integration `updates.check` (Administration →
Integrations); `HOME_HUB_UPDATE_CHECK=off` in the environment turns it off for good.

- `GET /api/updates` (any signed-in account, or an API key: scope `read`) →
  `{schemaVersion:1, generatedAt, state, code, summary, summaryT?, installed:{version, label, exact, commit, dataEpoch}, latest:{version, tag, url, publishedAt, notes} | null, updateAvailable, dismissed, quarantined:{version, at, reason} | null, checkedAt, failedAt, error, notBefore, nextCheckAt, repo, repoSource, channel, intervalHours, apply:{automatic:false, tag, command}, disabled?}`.
  - `state` is an integration state; `code` says which case it is:

    | `state` | `code` | Meaning |
    |---|---|---|
    | `ok` | `current` | The last check succeeded and `latest` is the release that is running |
    | `ok` | `available` | … and `latest` is newer: `updateAvailable: true` |
    | `ok` | `development` | … and this is a development build (`installed.exact` is `false`), or a version ahead of every release. `updateAvailable` still says whether `latest` is newer |
    | `ok` | `no-release` | … and the repository has published no release that counts (`latest: null`) |
    | `stale` | `failed` | The last attempt failed (`error`, `failedAt`). `latest` is what was known at `checkedAt`; whether it is still the newest is **not known** |
    | `stale` | `old` | No attempt failed, but the last success is older than three intervals (36 h by default) |
    | `stale` | `pending` | Nothing has been attempted yet: the first check runs 2 to 5 minutes after start |
    | `error` | `never` | No check has succeeded yet (`error`) |
    | `off` | `env-off` | `HOME_HUB_UPDATE_CHECK=off` |
    | `not-configured` | `no-repo` | No repository is named (`package.json → homeHub.updates.repo`, `site.json → updates.repo`) |
    | `disabled` | `disabled` | An administrator turned the integration off: `disabled: {id, title, by, at}`, `latest: null` |

    A failed check never answers `current`. A client that wants one bit shows "update available" only for
    `updateAvailable && !dismissed`, and shows nothing, not "up to date", in every other case.
  - `latest.notes` is the text of the Release (at most 8 000 characters): somebody else's prose, to be shown as
    plain text. `latest.url` always starts with `https://github.com/<repo>/releases/`.
  - `error` is short: `HTTP 403`, `timeout`, `ENOTFOUND`. `notBefore` is set while GitHub's rate limit asks the hub
    to wait (at most a day); `nextCheckAt` is the next scheduled attempt.
  - `quarantined` marks a release that was tried on this hub and rolled back (written to `state/updates.json` by
    `scripts/update.mjs`, `docs/updating.md`). `apply.tag` is the release tag to switch to and `apply.command` the
    command a person runs on the server for it, from the core checkout (`node scripts/update.mjs apply <tag>`;
    `null` when no newer release is known); `apply.automatic` is always `false`.
- `POST /api/updates/check` `{}` (administrator, password sign-in; never an API key or a device token) →
  `{checked, reason?, updates}`. `checked: false` with `reason` `too-soon` (one forced check a minute),
  `rate-limited`, `env-off` or `no-repo` means no request was made. `409 INTEGRATION_DISABLED` while it is off.
- `POST /api/updates/dismiss` `{version}` (the same) → `{updates}`: stop pointing at that release in the footer.
  Only the newest known release that is newer than the running one can be dismissed (`409 UPDATE_NOT_CURRENT`
  otherwise); the next release is told again.

`state/run.json` (0600) is written when the server listens: `{version, commit, exact, dataEpoch, pid, startedAt,
plugins:[{id}]}`. A tool that changed the code reads it to confirm which process is answering.

## Other read-only routes

- `GET /api/inventory`: the inventory (`{"doc","gaps","hashes","provenance"}`); `GET /api/services`: its runtime entries; `GET /api/inventory/export`: the file as a download.
- `GET /api/systems` and `GET /api/security` (any role or API key that holds `security:read`: the owner, Admin, a custom role that lists it): OS and software versions with host protection, and the SSH key inventory. Each `software` row carries `inventory`: the inventory entry ids it describes when the id/name match would miss them (from the software watch list); the web inventory map uses it for its version block.
- `GET /healthz` → `{"ok":true}` with no auth. Use it as a reachability probe.

## Example (curl)

```bash
H='https://hub.example.lan'
curl -s -c jar -H "Origin: $H" -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"…"}' "$H/api/session"
TOKEN=$(curl -s -b jar -H "Origin: $H" -H 'Content-Type: application/json' \
  -d '{"name":"curl test"}' "$H/api/devices/tokens" | jq -r .token)
curl -s -H "Authorization: Bearer $TOKEN" "$H/api/home" | jq '.machines[] | {id, online}'
curl -s -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"project":"my-app","title":"Filed from curl"}' "$H/api/tickets"
```
