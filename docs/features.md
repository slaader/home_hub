# Home Hub features in detail

The [README](../README.md) is the short tour. This page is the long one: each part of the hub, what it reads,
where it keeps its state and which API and MCP tools go with it. [API.md](API.md) has every endpoint.

- [Overview and machines](#overview-and-machines)
- [Inventory map, table and services catalog](#inventory-map-table-and-services-catalog)
- [Project tracker, review and search](#project-tracker-review-and-search)
- [Users, roles and service accounts](#users-roles-and-service-accounts)
- [Live telemetry (optional)](#live-telemetry-optional)
- [How LLM stats are read](#how-llm-stats-are-read), [what the GPU is doing now](#what-the-gpu-is-doing-now)
- [Collectors (optional)](#collectors-optional)
- [Plugins](#plugins)
- [Security model](#security-model)

## Overview and machines

The overview shows a tile per machine. Machines come from three places: `local/site.json` (read-only on the
page, marked "from site config"), devices added on the page with **Add device**, and machines an agent writes
over MCP. An empty hub shows a welcome state with both ways to fill it. Each account can put the tiles in its
own order, by dragging or with the arrow keys on a focused tile.

- **Machine page** (`#host-<id>`): hardware facts, charts and volumes when the machine reports telemetry, and
  its runtime stack: a layered drawing of what clients call, the launchers, the model servers, the engines
  and the chip. The stack comes from `site.json` or from an agent.
- **Machine API and MCP tools** (scope `home:write`): `machine_list`, `machine_upsert` (hash-checked,
  idempotent by id, the address checked against `lanCidrs`, secret-looking values refused), `machine_remove`
  and `runtime_publish`. Over HTTP: `GET` / `POST /api/home/machines`, `POST /api/home/machines/remove`,
  `POST /api/home/runtime`.
- **Passwords never travel through the API.** An agent can name a machine's telemetry host; a person connects
  its login in Edit device → Telemetry.
- **Pictures**: ten generic ones are built in (`public/images/generic/*.svg`). Your own tile pictures go in
  `local/images/home/<machine id>.jpg` and win.
- **Local LLM runtimes**: the hub reads reachable runtime endpoints directly, or a plugin supplies
  `home.runtimes`: one card per runtime with its version, state, models and reported figures. Configure
  `runtimes[]` in `site.json` or add an endpoint through the API. The telemetry agent does not report runtimes.
  Above the cards, a panel says what the GPU is doing now ([below](#what-the-gpu-is-doing-now)).
- **State**: added machines in `state/home/devices.json`, published stacks in `state/home/runtimes.json`.

## Inventory map, table and services catalog

One file, `data/knowledge.json`, records machines, services, tools, model stores and outside services, what
depends on what, and where each credential is kept (never its value). A hub without the file has an empty
inventory, and the first write creates it.

- **Empty hub.** The map explains what it is for and how to fill it: a copyable prompt for a coding agent,
  the MCP snippet, **Start from a template** (six `example-…` entries, removed again with one button),
  **Add the first entry** and **Import from JSON**.
- **Map** (`#inventory-map`): a search box that lights the matching cards (Enter selects the best one), zoom
  and fit-width, a mini legend, lane counts, and colours for what the selected card needs and what stops with
  it. A machine entry that your `inventory.places` does not list gets a column of its own.
- **Table**: every entry on one line, sortable by any column, filtered by the search box, kind, place and
  "only with gaps". Rows become cards on a phone.
- **Entry form**: create, edit (also the machine and the dependencies), delete, and "Still true" to re-stamp
  an entry. Only the fields that changed are sent. When someone else changed the entry first, the form shows
  what they changed and offers to load their version or to keep your edits on top of it.
- **Services**, the third view (`#inventory-map/services`; `#services` leads there): every entry of kind
  `runtime` on one line with its address (URLs are links), machine, what depends on it, what it needs, and
  when and by whom it was last verified. Same search box and place and gap filters as the table.
- **Where it comes from.** The pill next to the title counts the entries by who last verified them: people
  in the form, service accounts by name, or other stamps (an import). The same pill is on the tracker,
  review, SSH keys, versions and protection pages (`docs/API.md` → Provenance).
- **One checker for everyone.** The rules live in `public/inventory-rules.js`, a pure module that
  `scripts/check-knowledge.mjs`, the hub and the entry form in the browser all run, so the form's inline
  messages are the server's.
- **API and MCP**: `GET /api/inventory/schema`, `POST /api/inventory/bulk` (all or nothing, `dryRun`),
  `POST /api/inventory/entries/delete`; MCP tools `inventory_describe`, `inventory_search`, `inventory_get`,
  `inventory_update`, `inventory_bulk_upsert` and `inventory_delete`. A change to an existing entry takes the
  hash of what was read. Details in [docs/API.md](API.md).

## Project tracker, review and search

- **Tracker** (`#projects`, `#items`, `#releases`): projects with a ticket prefix, releases, and tickets with
  comments, attachments, labels and a change history, as a table or a board. A change takes the `rev` of what
  was read.
  Files go on a ticket while it is written or later: by button, by drop, or pasted (Cmd/Ctrl+V), up to 100 MB
  each. A screenshot pasted into the description or a comment stays in the text as a chip (`![name]`); under the
  description the files are tiles with a preview, and a click opens one: a picture, a player for audio and
  video, text, or the download.
- **Review** (`#review`): an agent publishes variants (HTML mockups, images, 3D models, video and audio clips) for a person to
  compare side by side, pin comments on and decide; the next round answers the comments.
  [docs/review.md](review.md) has the details.
- **Search** (`#search`, and the command palette on Cmd-K or Ctrl-K): full text over tickets and review
  sets. Words match as prefixes; case and accents are ignored.
- **MCP**: `tickets_list`, `ticket_search`, `ticket_get`, `ticket_attachment_get`, `ticket_create`,
  `ticket_update`, `ticket_comment`, `release_save`, `project_save`, `search`, `review_list`, `review_get`
  and `review_publish`.

## Users, roles and service accounts

Sidebar → Administration → Users and API (`#access`). An administrator (the owner or the Admin role, signed in
with a password) sees seven tabs; everyone else sees only how to connect.

- **People:** each person has a name, a password and a **role**. Create (generated or chosen password), change
  the role, disable, delete, generate a new password. A reset ends that user's sessions at their next request.
- **Roles:** Owner (the account of `private/auth.json`; it cannot be deleted, disabled or demoted), Admin
  (everything, including administration), Editor (every write, no administration), Viewer (read only), and
  **custom roles**: a named set of scopes. A role in use is deleted only by moving its people to another.
- **Service accounts:** identities for agents and scripts. Created from a preset that shows what it includes:
  Read only, any role, a custom selection, or **Full access (agent)**: every scope there is and any a plugin
  adds later (stored as `["*"]`). No key, full access included, reaches users, roles, keys, devices or
  anyone's own account. The key is shown once, with ready-to-paste settings for Claude Code, Codex and a
  generic MCP client.
- **API keys:** every key in one list (active, revoked, last used) with revoke. Only a SHA-256 is stored.
- **Devices:** native-app tokens (`hh_…`) with revoke.
- **Connect and API:** the MCP connection card, who may do what, the scope table, the MCP tools this hub
  offers (from the modules that are loaded, plugins included) and every endpoint.
- **Audit:** changes to users, roles, accounts, keys and devices (with who made them) and every write through
  a key or MCP tool, refused ones included; filter by kind, by refusal and by text. No secrets.

Settings (the account menu) holds the account's own password, language, theme and time zone.

Editor and the role presets are worked out from the scope table, so they include a scope that a plugin adds.
State written by an older version loads unchanged: `state/access.json` keeps its roles and scope lists, and a
key from before service accounts (`permission: read|write`) keeps exactly what it could do and never gets a
scope added since. `node scripts/manage-access.mjs list` shows users, roles and accounts from the command line
while the hub is stopped. Details in [docs/API.md](API.md) → Access.

## Live telemetry (optional)

The overview can show live load, power draw and temperature per machine. Those numbers come from a small
telemetry agent that runs on the machine (Thermo). Home Hub reads it over a pinned TLS connection; it never
installs or changes anything there.

- Add a machine that runs it with **Overview → Add device**, or set `thermoId` on a machine in `site.json`.
- Each machine says where its telemetry stands: not installed, unreachable, stale (the newest reading is
  older than 3 minutes) or fine. Tiles and machine pages show which, with the install steps. A failed read is
  never shown as "off".
- Without it, nothing breaks: tiles show the facts from your configuration.
- **Windows needs no agent.** In **Add device** (or **Edit device**) choose the system Windows and Telemetry →
  Windows (SSH): enter host, SSH port and the Windows user, let the hub create its own key, run the one PowerShell
  step it shows on Windows, confirm the host-key fingerprint, test and save. The hub may run on Linux, macOS or
  Windows; its server needs only the OpenSSH client tools (`ssh`, `ssh-keyscan`). Keys live in `state/home/ssh/`
  (private to the hub's account): back that up as privately as `private/`. Details: [docs/API.md](API.md) →
  Windows telemetry. Windows can also be read over **WinRM HTTPS** (Basic with a local account, only after the
  listener's certificate is verified or pinned; the dialog shows the one explicit PowerShell step that enables Basic
  for the WinRM service only).
- **Linux needs no agent from the hub either.** Choose the system Linux and one of: **Node Exporter** (recommended:
  the hub reads its `/metrics` on port 9100 directly, no Prometheus server needed), **Prometheus** (a Prometheus you
  already run, on the host or in Docker: the hub reads one node_exporter target, job + instance, through the
  read-only `/api/v1/query` on port 9090), or **SSH** (the hub's own key and a fixed script that only reads `/proc`,
  `/sys` and `df`). GPU and power are not measured on Linux; temperatures appear where the machine reports them.
  Passwords and tokens of these connections live in `state/home/telemetry-hosts.json` (0600, sealed with the hub's key: docs/storage.md → Secrets at rest). Details:
  [docs/API.md](API.md) → Agent-less telemetry.
- A machine from `site.json` without `thermoId` (a NAS, for example) is connected on its own page: **Telemetry
  settings** stores only the connection (`state/home/site-telemetry.json`, no secrets), never edits `site.json`, and
  the machine keeps its identity, services and read-only status.
- Every tile has **Edit** for an account with write access signed in with a password. On a machine from `site.json`
  it changes the name, address, hardware and picture shown, as an override over the site's values
  (`state/home/site-overrides.json`), with **Reset to site defaults**; id, role, system and how it is read stay the site's.
- Where to get it: `https://example.com/home-hub/telemetry-agent`. This address is a placeholder until the
  agent has a public home. The UI takes it from one constant, `TELEMETRY_AGENT_URL` in `public/site.js`, and
  the API reports `TELEMETRY_REPO_URL` from `server/thermo-client.mjs`.

## How LLM stats are read

A machine page has a **Local LLM runtimes** section, and the engine blocks of its runtime stack list the
models of the runtimes above them, once something reports that machine's runtimes. There are three ways in:

1. **Direct adapters (included).** When the hub can reach a runtime over HTTP (on `127.0.0.1` because the
   hub runs on the same machine, or on the LAN) it reads it itself, every 30 seconds. List it in `site.json`:

   ```json
   "runtimes": [
     {"machine": "studio", "kind": "ollama", "url": "http://127.0.0.1:11434"},
     {"machine": "gpu-box", "kind": "auto", "url": "http://10.0.0.42:8000", "name": "vLLM"}
   ]
   ```

   or let an agent add it (`runtime_endpoint_upsert`, scope `home:write`; `POST /api/runtimes/endpoints`).
   Supported: llama-swap, Ollama, LM Studio, llama.cpp server (also router mode), vLLM, SGLang, oMLX,
   mlx-serve, and anything OpenAI-compatible (reachable and its model list). `kind: "auto"` recognises the
   runtime by its answers. The `url` is an origin only (no path, no user or password), on loopback or inside
   `lanCidrs`, written as an IP address. A runtime that needs a bearer token gets it in the web UI; the token
   is stored server-side (`private/runtime-tokens.json`, mode 0600) and never shown again.
   Every read is a `GET` on a fixed list of read-only paths, with a bounded body and a short timeout. The hub
   never loads, unloads or prompts a model, and never requests a route that would (llama-swap's
   `/upstream/…`, for instance, loads one).
2. **A plugin or a bridge.** For a runtime the hub cannot reach (on another machine with no open port, or
   behind a socket), a plugin can provide `home.runtimes` from its own source, such as a small bridge process on
   that machine ([docs/plugins.md](plugins.md)). When a plugin and the direct adapters report the same
   runtime (the same address), it is shown once: the entry that says more is kept and the other fills its gaps.
3. **A telemetry agent (later).** The telemetry agent does not report runtimes today. If it ever does, it
   becomes one more provider of the same shape.

### What the GPU is doing now

On a machine page, the runtimes open with a panel that says whether the GPU is working, and on what:

- **Generating and queued.** Runtimes that report what is in flight (llama-swap, llama.cpp server, vLLM, SGLang and
  oMLX) mark each model as generating or queued, with how long it has been at it. A request that llama-swap passes
  on to another runtime is counted once. A plugin can add the jobs of command-line tools (`mode: "cli"`) the same
  way. The panel names the runtimes that cannot tell (Ollama, LM Studio, mlx-serve). The **LLM & Diffusion** page
  shows the same at the top, in its model table and on the wiring diagram.
- **GPU time by process.** With the telemetry agent on the machine, the three processes with the most GPU time are
  listed, also while a model generates, each labelled with the runtime or model it belongs to. The figure is the
  agent's estimate of time in the GPU's queues over 5 seconds (100 % = one GPU-second per second). It is not a
  share of the GPU load in the panel's header, and the rows can add up to more.
- Runtimes are read every 30 seconds, so a request that takes only a few seconds can fall between two reads.

### Usage history on the LLM & Diffusion page

The **LLM & Diffusion** page (`#models`) charts requests, tokens and tokens per second over time, lists the
clients that sent them and draws the traffic on its wiring diagram. For a llama-swap the hub reads directly,
the hub keeps that history itself:

- Every 30 seconds it reads llama-swap's request log (`GET /api/metrics/activity`, 200 records a page, at most
  10 pages, stopping at the first record it already has). Reading does not empty that log. The first read
  takes the whole log, so the page has history from the first minute.
- It also keeps llama-swap's access log open (`GET /logs/stream/http?no-history`). It matches each request to
  its log line by path, status, time and duration, and names the client from the first word of the line's
  User-Agent: `claude-cli` is Claude Code, `codex` Codex, `python-httpx` Python, and so on. Name your own in
  `site.json`:

  ```json
  "runtimeClients": {"deno": "Memory service", "node": "AI gateway"}
  ```

  Without the stream, or for a request whose line never came, the client is "Unattributed". A request from
  `127.0.0.1` names no machine (it may be this one or anything tunnelled into it). A request from a site
  machine's `ip` names that machine.
- It stores request fields only, never a prompt or a body: one JSON line per request in
  `data/state/runtimes/<machine>/requests-YYYY-MM.jsonl`. It keeps 13 months and de-duplicates by llama-swap's
  record id together with its time, so a restarted llama-swap (whose ids start at 1 again) neither loses nor
  repeats a request.
- `node scripts/import-runtime-history.mjs --machine <id> <file.jsonl>` adds older history from a file on
  this machine (the store's own format, or a v1 hub's `history-YYYY-MM.jsonl`). Running it twice adds nothing.
- Turning **LLM runtimes** off on the integrations page stops the reads and closes the stream. Each
  llama-swap endpoint's line there shows when a record was last added and how many came in today.

A plugin can supply history from elsewhere (`runtimes.requests`, [docs/plugins.md](plugins.md)). When two
sources report the same request, it is counted once, and the copy that names a client is kept.

## Collectors (optional)

Collectors are scripts you run from a scheduler. They look at your machines over SSH, read only, and write
files under `data/` that the hub serves.

```sh
node scripts/collect-systems.mjs        # OS and software versions, update candidates, host protection
node scripts/check-upstream.mjs         # newest upstream releases of the software you watch
node scripts/collect-security.mjs       # where SSH keys live and what they open
python3 scripts/collect-router-unifi.py # client census from a UniFi gateway
```

They reach the machines that have an `ssh` entry in `site.json`. A collector never updates, installs or
writes on a machine it probes.

- **Four states on every collector page** (`#versions`, `#hardening`, `#security`, the router panel of the
  router's machine page): not configured (what to add to `local/site.json` and which command to run),
  configured without a snapshot, stale (older than the collector's interval plus a quarter) and fine.
- **Versions and updates**: one card per machine with its operating system and watched software, update
  badges that link to the release notes, an "Outdated only" filter and the time each source was last checked.
- **Host protection**: a pass / warning / fail checklist per machine, problems first, each check with a
  sentence on why it matters, and the open ports per machine.
- **SSH keys**: every key with its type, age and passphrase against where it is authorized. DSA and short RSA
  keys are marked as a weak type, files older than two years as old. Private key material is never collected.
- **Software watch list**: which programs the versions page follows. It is kept in
  `local/software-watch.json` (`config/software-watch.json` is an annotated example, never the active list)
  and shown on `#versions/~watch`. An administrator edits the file, or an agent uses the MCP tools
  `software_watch_list` and `software_watch_put` (scope `software:write`; also `GET` / `POST
  /api/software-watch`). Each item has an upstream and one detect rule per machine: `brew`, `cask`, `app`,
  `cmd`, `pydist` or `json`. A rule is data for a read-only probe, never a command: a `cmd` rule may pass only
  one fixed version flag, and paths cannot carry shell characters. Operating systems, NAS apps and containers
  are discovered without a list. [docs/API.md](API.md) has the format.
- **Router**: one adapter feeds the client census and the router's health (`GET /api/router`). UniFi is
  included: `"router": {"adapter": "unifi"}` in `site.json` names it, and the collector takes the gateway and
  your networks from the same file. A plugin can provide another adapter. Without a `router` setting the
  router page says what to set up.
- **Scheduling**: on macOS, `sh scripts/systems/install-launchd.sh` installs the jobs (`--with-security` adds
  the daily SSH key job, `--print` shows the property lists without installing, `--label-prefix` chooses the
  job names). `examples/systemd/` has the same jobs as user units for Linux.

## Plugins

The core knows no particular household. What only you have goes into a plugin: a directory
`local/plugins/<id>/` with an `index.mjs` that registers routes, scopes, MCP tools, pages and sidebar entries
through the same registry the core features use.

```
local/
  site.json            your site
  images/              your pictures
  plugins/notes/       a plugin: index.mjs, server/, public/, tests/
```

A plugin page is drawn with the same building blocks as the core pages (`public/ui.js`, the tokens in
`public/tokens.css`), so it follows the theme and looks like the rest. Its MCP tools appear on the Connect tab,
and it can add its own lines to what an agent reads when it connects. The contract is in
[docs/plugins.md](plugins.md); a complete small example is `tests/fixtures/plugins/demo/`.

## Security model

Home Hub is meant for a home network. It is not hardened for the open internet: keep it on your LAN or VPN.

- **People sign in with a password and hold a role.** Owner and Admin administer, Editor writes, Viewer
  reads, and a custom role is a named set of scopes. Passwords are stored as scrypt hashes; sessions last 12
  hours in an HttpOnly, SameSite=Strict cookie whose token is stored only as a SHA-256 hash.
- **Agents and scripts use service-account keys with scopes.** A key reaches only what its scopes allow:

  | Scope | Allows |
  |---|---|
  | `read` | Every read endpoint except security (always included) |
  | `inventory:write` | Create and change inventory and service entries |
  | `home:write` | Add, change and remove machines on the overview; publish a machine's runtime stack; add and remove LLM runtime endpoints |
  | `home:settings` | The telemetry read interval |
  | `tickets:write` | Tickets, comments, releases, projects |
  | `review:write` | Publish review sets and store decisions |
  | `software:write` | Read and change the software watch list |
  | `security:read` | SSH key inventory, versions, host protection |

  A plugin adds its own scopes to the same table.
- **API keys never reach administration.** Users, roles, keys, service accounts, device tokens and your own
  password can be managed only from a browser signed in with a password. No scope opens those routes.
- **Every write is checked twice**: by role or scope when the request arrives, and by revision or hash where
  it is stored. A stale write is refused, not merged.
- **Secrets stay out.** The inventory records where a secret is kept, never its value, and its checker rejects
  anything that looks like one. Tokens and request bodies are never logged. Every write attempt by a key is
  logged, with the route and the result.
- **The browser side is locked down**: a strict Content-Security-Policy (no inline script or style), a
  same-origin check on every POST, and DOM built from text nodes only.
- **Collectors are read-only** on the machines they probe.
