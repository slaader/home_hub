# Home Hub JSON API

What a client (a native app, a script, an agent) needs to read the hub and run the same actions as the web UI. `H` below stands for the origin browsers use for your hub, for example `https://hub.example.lan` (site.json → `publicOrigin`, or the `ORIGIN` environment variable).

This document covers the core. A plugin documents its own routes (see `docs/plugins.md`); agents can also use the MCP endpoint (`POST /mcp`, service-account key).

## Reaching it

- Home Hub is meant for a home network: put it behind a reverse proxy that only answers your LAN or VPN.
- Every request has a 10-second server timeout. POST bodies are limited to 16 KB (64 KB for review publish and feedback).
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
| 403 | `SCOPE_REQUIRED`, `SESSION_REQUIRED`, `READ_ONLY`, `ADMIN_REQUIRED` | The credential may not do this: an API key without the scope, a route that needs a password sign-in, a read-only account, a non-administrator |
| 400/404/409/429/503 | `HOME_UNAVAILABLE`, `DEVICE_FAILED`, `INVENTORY_EDIT_FAILED`, `INVENTORY_UPDATE_FAILED`, `TICKETS_FAILED`, `REVIEW_FAILED`, `SEARCH_FAILED`, `ACCESS_FAILED`, `UPDATE_FAILED` (plugins add their own) | Feature errors: 400 invalid request, 404 unknown id, 409 conflict (read again, reapply), 429 another action is running (retry shortly), 503 the feature cannot answer right now |
| 500 | `UNAVAILABLE` | Anything else |

Timestamps are ISO 8601 UTC strings. Byte sizes are integers. A value the source did not report is `null`.

## Home: the overview

- `GET /api/home` → `{"poll","schemaVersion":1,"generatedAt","machines":[…],"router"}`. One entry per machine from the site configuration (site.json → `machines`) and per added device: identity (`id`, `name`, `hostname`, `ip`, `kind`: `thermo`, `nas`, `router` or `other`), `props` (static hardware), `online` (`online`, `stale`, `offline`, `unknown`), `lastSeen`, `quad` (CPU, GPU, power, temperature and memory averaged over the poll interval, from Thermo), `volumes`, `services` and `stack`.
- `GET /api/home/history?machine=<id>&range=30m|7d|30d|6m` → chart buckets for a machine that reports through Thermo; other machines answer with `points: []` and a `reason`.
- `POST /api/home/refresh` `{}` → the same document after an immediate Thermo pull (rate limited). `POST /api/home/settings` `{"intervalSeconds":15|30|60}` changes the pull interval (scope `home:settings`).
- `GET /api/ui/manifest` → what the web shell draws itself from: `site` (name, time zone, default language), and for a signed-in caller the `pages` it may open, the sidebar `nav`, the loaded `modules` and extra `strings`. Signed out it returns only `site`.
### Overview tile order (web UI, password sign-in only)

- `GET /api/profile/home-order` → `{"order":["studio","mini",…],"saved":true|false,"known":["studio","mini","nas","router"]}`. `order` always lists every known machine: the saved ones first, then any missing in the default order (`saved:false` = nothing saved).
- `POST /api/profile/home-order` with body `{"order":["studio","nas"]}` → `{"order":[…full list…],"saved":true}`. Only known ids, each at most once; a partial list is fine, `[]` returns to the default order. `400 INVALID_ORDER` otherwise. Read-only viewers may set their own order.
- Stored per account in `state/access.json` (`prefs.<account id>.homeOrder`); deleting the user deletes it. Session cookie only: device tokens and API keys get `403 SESSION_REQUIRED`, and the POST needs the same `Origin` and `Content-Type` as every browser write. The app keeps the default order.

### Added devices (Přehled → ⊕ Přidat zařízení; web UI, write access, never API keys)

The site's own machines come from `local/site.json`. Added devices live in `state/home/devices.json` (no secrets), their
Thermo login in `state/home/thermo-hosts.json` (mode 0600, same shape as `private/thermo-hosts.json`), and their
picture in `state/home/images/<id>.jpg`. They appear in `GET /api/home` as machines with `added:true`,
`kind:"thermo"|"other"` (built-ins carry `kind` too: `thermo`, `nas`, `router`) and `image`; their ids join `known` in
the tile order.

- `POST /api/home/devices/probe` `{"host","port"?}` → `{"fingerprint","subject","validTo"}`: a TLS handshake with
  Thermo, nothing sent. `422` when nothing answers.
- `POST /api/home/devices` `{"name","kind","hostname","ip"?,"props"?:{"cpu","gpu","ramGb"},"thermo"?:{"port","username","password","pin"}}`
  → `201` the device. A `thermo` device first logs in once with the pinned certificate (`pin` = the fingerprint the
  user confirmed); a refused login is `422` and nothing is saved. Then the poller starts pulling it, without a restart.
  `409` for a hostname already added, at most 20 devices.
- `PUT /api/home/devices/<id>/image` with `Content-Type: image/jpeg` (≤ 3 MiB, cropped to 3:2 in the browser) → the device.
- `GET /images/home/<id>.jpg` → the picture (signed in).
- `POST /api/home/devices/remove` `{"id"}` → `{"removed"}`; the tile, its Thermo login and picture go, the metric history stays.

## Project Tracker (UI: #projects, #items, #releases)

A small tracker for your own development work, stored in `state/hub.db` ([storage.md](storage.md)).
Reading needs any sign-in (API keys: `read`); every write needs a write session or an API key with the
`tickets:write` scope. Writes return `400/404/409 TICKETS_FAILED` for invalid input, an unknown ticket, or a
stale `rev` / an existing release. HTTP POST bodies are limited to 16 KiB (UTF-8, including JSON);
tracker write arguments have the same size limit over MCP. Text-field character limits do not override this byte limit.
Send only changed fields when updating. Dates must be real calendar dates in `YYYY-MM-DD` form.

- **Projects** `{id, key, name, description, rev}`; none exist until you create one (or list seeds in site.json → `tracker.projects`). Ticket ids are `<KEY>-<n>`, e.g. `HH-12`.
- **Ticket** `{id, project, title, description, type: bug|feature|task, status: open|in-progress|done|cancelled, priority: low|normal|high|urgent, release: <version>|null, assignee|null, labels[], refs[], reporter, createdAt, updatedAt, closedAt|null, rev, comments[], history[]}`. `closedAt` is set on entering `done`/`cancelled` and cleared on reopening. `history` retains the latest 200 field changes (title/description only as "changed").
- **Release** `{project, version, status: planned|released, targetDate|null, releasedAt|null, notes, rev}`. A ticket's `release` must be an existing version of the same project. The literal `none` is reserved for filtering unassigned releases/assignees and cannot be used as a version or assignee name.

Routes:

- `GET /api/tickets?project=&status=open|in-progress|done|cancelled|active[,…]&type=&priority=&release=<version>|none&assignee=<name>|none&label=&q=&limit=` → `{updatedAt, projects, releases:[…, counts:{open,in-progress,done,cancelled}, total], total, tickets:[… without comments/history, comments:<count>]}`. Release counts are over all tickets, not just the filtered ones.
- `GET /api/tickets/<ID>` → the full ticket with `comments`, `history` and `rev`.
- `POST /api/tickets` `{project, title, description?, type?, status?, priority?, release?, assignee?, labels?, refs?}` → `201` ticket. Defaults: `task`, `open`, `normal`.
- `POST /api/tickets/update` `{id, rev, …fields to change}` → ticket. `rev` must be the one you read; otherwise `409`.
- `POST /api/tickets/comment` `{id, text}` → ticket. Append-only, no `rev`.
- `POST /api/tickets/releases` `{project, version, status?, targetDate?, releasedAt?, notes?, rev?}` → release. Omit `rev` to create; pass it to change. `released` without a date stamps today.
- `POST /api/tickets/projects` `{id, key, name, description?}` → `201` new project; `{id, rev, name?, description?}` → `200` changed project. `id` and `key` never change.

MCP `tickets_list` uses `query` for text search and an integer `limit` of 1–200 (default 50); HTTP uses `q` and supports `limit` of 1–5000. `release_save` accepts `releasedAt` as well as `targetDate`.

Attachments (stored in `state/tickets/attachments/<sha256>`, at most 20 per ticket and 20 MB per file, 2 GB in total):

- `PUT /api/tickets/<ID>/attachments?name=<file name>` with the raw file as `application/octet-stream` → `201` ticket. `tickets:write` for API keys; sessions need the same origin.
- `GET /api/tickets/<ID>/attachments/<attachment id>[?download=1]` → the file. The type is sniffed from the bytes: PNG/JPEG/GIF/WebP and plain text are shown inline, everything else (SVG and HTML included) is a download or plain text. Every response is `sandbox`ed and `nosniff`.
- `POST /api/tickets/attachments/delete` `{id, attachment}` → ticket. The file is removed when no ticket uses it any more.
- `GET /api/tickets/<ID>` lists `attachments: [{id, name, type, size, sha256, by, at}]`; the list view has `attachments: <count>`.

MCP tools (service-account key): `tickets_list`, `ticket_get`, `ticket_attachment_get` (`read`; images up to 5 MB come back as an image, text up to 256 kB as text); `ticket_create`, `ticket_update`, `ticket_comment`, `release_save`, `project_save` (`tickets:write`).

Service-account presets in Uživatelé a API: **Agent vývoje** (`read` + `tickets:write` + `review:write`) and **Agent inventáře a vývoje** (`read` + `inventory:write` + `tickets:write` + `review:write`).

Projects carry `type`: `app`, `game`, `other` or `null` (`POST /api/tickets/projects` and MCP `project_save` accept it).

### Review

Variants agents propose for a project (HTML mockups, images, 3D models as `.glb`), decided in `#review`. The full contract is in
[review.md](review.md). Writes need `review:write` for API keys.

- `GET /api/review?project=&ticket=&status=open|active|done|archived|all&feedback=pending` → `{sets:[summary]}`.
- `GET /api/review/sets/<R-n>` → the full set with all rounds, decisions and comments.
- `HEAD|GET /api/review/blobs/<sha256>` → a published file (range requests); `GET /api/review/frame/<sha256>` → a sandboxed HTML mockup.
- `PUT /api/review/blobs/<sha256>?offset=&size=` (`application/octet-stream`, ≤ 8 MiB per chunk) → `{received,size,complete}`; `409` with `received` on a wrong offset.
- `POST /api/review/publish` (≤ 64 kB) → `201` new set or `200` next round; `POST /api/review/feedback` (≤ 64 kB) `{set, round, item, rev, variant, status, note?, comments?, attachments?}`; `POST /api/review/sets` `{id, rev, status?, title?}`.
- MCP: `review_list`, `review_get` (`read`); `review_publish` (`review:write`). Upload files with `scripts/review-push.mjs`.

### Search

Full-text search over tickets (id, title, description, comments, labels, refs, people) and review sets (title,
description, round notes, item and variant texts, notes, comments). `read` is enough for API keys.

- `GET /api/search?q=<words>&kind=ticket|review&project=<id>&limit=1..100` (default 20) →
  `{q,total,results:[{kind,id,project,updatedAt,title,snippet,score}]}`, best match first.
- `q` is plain words (≤ 200 characters, at most 12 words), never query syntax: every word must match, as a prefix,
  ignoring case and diacritics (`prihlas` finds `Přihlášení`). A title hit ranks above a body hit.
- In `title` and `snippet` the matched words are wrapped in `\u0001` … `\u0002`; render them as text (e.g. `<mark>`
  via text nodes), never as HTML. Results link to `#items/<id>` or `#review/<id>`.
- `400 SEARCH_FAILED` for a bad parameter (unknown key, `kind`, `project`, `limit`).

## Other read-only routes

- `GET /api/inventory`: the inventory (`{"doc","gaps","hashes"}`); `GET /api/services`: its runtime entries; `GET /api/inventory/export`: the file as a download.
- `GET /api/systems` and `GET /api/security` (admins, or API keys with `security:read`): OS and software versions with host protection, and the SSH key inventory. Each `software` row carries `inventory`: the inventory entry ids it describes when the id/name match would miss them (from the software watch list); the web inventory map uses it for its version block.
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
  -d '{"project":"home-hub","title":"Filed from curl"}' "$H/api/tickets"
```
