# Plugins and site configuration

Home Hub is a generic core plus whatever one household adds. The additions live in an overlay directory,
`local/`, in two forms:

- **`local/site.json`** — facts about the site: its name, network, machines. Core reads it.
- **`local/plugins/<id>/`** — features only this household has. Core loads them.

Core never imports from `local/`. A hub without `local/` works: it is empty and generic.

```mermaid
flowchart LR
  subgraph core["Core (public)"]
    P[server/plugins.mjs<br>module registry]
    I[server/index.mjs<br>request pipeline]
    C[server/core/*.mjs<br>core modules]
    S[server/site-config.mjs]
  end
  subgraph overlay["Overlay: local/ (private)"]
    J[site.json]
    X[plugins/&lt;id&gt;/index.mjs]
  end
  J --> S --> C
  C --> P
  X --> P
  P --> I
  I --> M["GET /api/ui/manifest"] --> A[public/app.js<br>sidebar and pages]
```

## Site configuration

Copy `config/site.example.json` to `local/site.json`. Every field is optional. `server/site-config.mjs`
validates the file at start-up: an unknown field or a wrong value stops the server with a message that names
the field. `HOME_HUB_SITE_CONFIG=/path/to/file.json` selects another file; `none` selects no file.

| Field | Meaning | Without it |
|---|---|---|
| `siteName` | Shown in the page title, the footer and the installable-app name | Just "Home Hub" |
| `lanCidrs` | Your networks, e.g. `["10.0.0.0/24"]`. The router adapter and machine descriptors keep only host addresses inside them | Any well-formed IPv4 address is accepted |
| `timeZone` | IANA zone for every time the UI shows | The browser's zone in the UI, the process zone on the server |
| `defaultLanguage` | `en` or `cs`: the language a browser starts in until its user picks one | `en` |
| `publicOrigin` | The origin browsers use, e.g. `https://hub.example.lan`. Used when `ORIGIN` is not set | `ORIGIN` must be set (a local preview is its own origin) |
| `machines[]` | The machines on the overview. See below | No tiles; add devices in the UI |
| `inventory.places[]` | `{id, label, short, column, lane}`: where inventory entries live. `column` gives the place its own column on the map, `lane` (`net` or `outside`) puts it in a shared one, `short` tags its cards. Order is column order | The map has only the Network, Outside and Other columns |
| `inventory.secretStores[]` | Names of your secret stores (a password manager vault, …) that inventory entries may point at | Only the built-in ones: `passwords-app`, `remembered`, `unknown`, and the `keychain:` / `file:` / … prefixes |
| `tracker.projects[]` | `{id, key, name, type}`: projects a brand-new tracker starts with | The tracker starts with no projects |
| `security` | `gitHost` / `gitUrl` of a Forgejo the SSH-key collector should read, `certificates[]` (`{match, label}` names for TLS key files), `order[]` (machine order in the key list) | No git server is queried; TLS keys are labelled generically |
| `strings.en` | English for your own labels (the UI's source language is Czech): `{"source text": "translation"}` | Your labels show as written |
| `plugins.<id>` | Free-form settings for a plugin; core does not look inside | — |

A machine:

| Field | Meaning |
|---|---|
| `id` | Lowercase id (`a-z`, `0-9`, `_`, `-`), used in URLs (`#host-<id>`), data files and by the collectors |
| `name`, `hostname`, `ip` | What the tile shows |
| `role` | `computer`, `nas`, `router` or `other`. A `router` tile reads the router adapter's census; a `nas` tile is online when a plugin's service probes answer |
| `picture` | A path under `/images/` (yours go in `local/images/`) |
| `thermoId` | The host id in the Thermo hosts file. Set it and the tile shows live CPU, GPU, power, temperature and memory from the Thermo app. Thermo is optional: without it the tile is static |
| `hardware` | Static facts: `cpu`, `gpu`, `ramGb`, `diskTotalBytes`, `pools`, `wifi` |
| `ssh` | `{alias, probe, keys}`: how the collectors reach it. `alias` is an ssh config alias, or `local` for the machine the collector runs on. `probe` is `mac` or `nas` for `scripts/collect-systems.mjs`. `keys:false` leaves it out of `scripts/collect-security.mjs` |
| `stack` | The runtime grid drawn on the machine page: `{layers, cols, engines, blocks}` |

Pictures: any image under `local/images/` is served at `/images/<same path>`. The overview looks for
`/images/home/<machine id>.jpg`. The software watch list for the versions page is `local/software-watch.json`
when it exists, otherwise the example in `config/software-watch.json`.

## A plugin

A plugin is a directory `local/plugins/<id>/` with an `index.mjs` whose default export is a module object.
`<id>` must equal the object's `id`. Directories whose name starts with `_` or `.` are skipped.
`HOME_HUB_PLUGINS_DIR=/another/dir` loads from elsewhere; `none` loads nothing.

```
local/plugins/notes/
  index.mjs          the module definition (below)
  server/            its server code
  public/            its browser files, served at /plugins/notes/<file>
  scripts/           its command-line tools
  tests/*.test.mjs   run by npm test
```

The whole contract, with every field optional except `id`:

```js
export default {
  id: 'notes',                       // = directory name
  title: 'Notes',

  // Scopes this plugin adds to the service-account scope table.
  scopes: {'notes:write': {label: 'Poznámky – zápis', desc: 'Přidávat poznámky.'}},

  // Called once per hub. Returns the plugin's state; handlers get it as c.state. Must be synchronous.
  setup: hub => ({notes: []}),

  routes: [
    // GET: an API key needs "read" unless you say otherwise. Sign-in is required unless public: true.
    {method: 'GET', path: '/api/notes', handler: ({json, state}) => json(200, {notes: state.notes})},
    // A pattern instead of a path; params is the RegExp match.
    {method: 'GET', match: /^\/api\/notes\/(\d+)$/, handler: ({params, json, state}) => json(200, state.notes[params[1]])},
    // A write route must name its scope (or null: password sign-in only, never an API key).
    {method: 'POST', path: '/api/notes', scope: 'notes:write',
     handler(c) { c.state.notes.push(String(c.input.text)); c.subject = 'note'; return c.json(201, {ok: true}); },
     // What a thrown error means: [status, code, message], or nothing for a plain 500.
     error: e => e.message === 'invalid' ? [400, 'NOTES_FAILED', 'Invalid note.'] : null},
  ],

  // MCP tools, listed for keys that hold the scope. Throw toolError('…') (server/mcp.mjs) for a refusal.
  mcpTools: [{name: 'notes_list', scope: 'read', title: 'Notes', description: 'All notes.',
              inputSchema: {type: 'object', properties: {}, additionalProperties: false},
              run: (args, {state, principal, hub}) => ({notes: state.notes})}],

  // Background readers, started by the server after it listens.
  pollers: [{id: 'refresh', start: (state, hub) => {}, stop: state => {}}],

  // Files under public/, each served at /plugins/notes/<path>. Nothing else in the directory is reachable.
  assets: ['notes-view.js'],

  // Sidebar entries and pages. view = "<asset>#<export>"; the export is (context) => Node.
  nav: [{group: 'Notes', hash: 'notes', label: 'Notes', view: 'notes-view.js#notesPage', order: 60}],

  // English for this plugin's Czech source strings (labels above, messages it sends).
  strings: {en: {'Poznámky – zápis': 'Notes – write', 'Přidávat poznámky.': 'Add notes.'}},

  // Rows for the API reference on the Users and API page.
  apiDocs: [{title: 'Notes', routes: [['GET', '/api/notes', 'read', 'All notes.']]}],

  // Extension points of core (see below).
  provides: {},
};
```

A complete small example that the test suite loads is `tests/fixtures/plugins/demo/`.

### Routes

A handler gets one context object:

| Field | |
|---|---|
| `req`, `res`, `url`, `pathname`, `query` | The request; `query` is the search parameters as an object |
| `params` | The match of a `match` route, else `null` |
| `input` | The parsed JSON body of a POST |
| `principal` | Who is calling: `{id, username, role, permission, authKind}` (`session`, `device` or `api-key`), plus `scopes` for a key |
| `canWrite`, `canAdmin`, `signedIn`, `device` | Shortcuts |
| `json(status, data)`, `error(status, code, message)` | Replies |
| `state` | What this module's `setup` returned |
| `hub` | The hub: `site`, `directory` (data), `stateDirectory`, `db`, `auth`, `accessStore`, `registry`, `options`, `state(id)`, `collect(name)`, `provided(name)` |
| `subject` | Set it to what a write touched; it goes into the API write log |

The pipeline does the common checks before your handler runs, in this order: the credential, admin-only path
prefixes, the API key's scope, the `Origin` and `Content-Type` of a browser POST, sign-in, write permission, the
body size limit, JSON parsing.

| Route field | Default | Meaning |
|---|---|---|
| `method` | — | `GET`, `POST` or `PUT` |
| `path` \| `match` | — | An exact path, or a RegExp (no `g`/`y` flag). An exact path wins over a pattern |
| `scope` | `read` for GET; required otherwise | The scope an API key needs; `null` = never with an API key |
| `public` | `false` | No sign-in needed |
| `write` | `true` for non-GET routes whose scope is not `read` | The caller needs write permission |
| `head` | `false` | Also answer HEAD (GET routes) |
| `bodyLimit` | `16384` | Largest POST body in bytes |
| `parse` | `true` | Parse the POST body as JSON |
| `raw`, `contentType`, `denied` | — | A PUT upload: the handler reads `req` itself; `contentType` is required exactly; `denied` replaces the read-only message |
| `error` | — | `(error, context) => [status, code, message]` for errors the handler throws |

### What is refused at start-up

The server does not start when a plugin is wrong. The message names the plugin and, for a clash, both sides.

- An unknown field, a missing `handler`, a write route without `scope`, a `view` that is not in `assets`,
  an asset path with `..`, an asset file that does not exist.
- Two modules registering the same route (method + path, or method + the same pattern), scope id, page hash,
  MCP tool name, asset URL or module id. Core modules count: a plugin cannot take `/api/home`.
- A route or tool using a scope that no loaded module defines.

A plugin may use a core scope (`read`, `tickets:write`, …) or another plugin's.

### Extension points

`provides` adds to a core feature without touching it. Each provider is `(state, hub) => value` (a promise is
fine).

| Name | Value | Used by |
|---|---|---|
| `home.snapshots` | `{machineId: {snapshot, bridge}}` — what an agent on the machine reports: `snapshot.services[]`, `memory`, `uptimeSeconds`, `collectedAt` | Overview tiles and the machine page stack |
| `home.services` | `{machineId: services[]}` — reachability probes for a machine without an agent (role `nas`) | The NAS tile's online state and service list |
| `inventory.writer` | `{put(change, by), edit(input)}` or `null` — where inventory edits go instead of the local file | Inventory map and services catalog |

Plugins can define their own names for each other: `hub.collect(name)` returns every provider's value,
`hub.provided(name)` the first.

### The browser side

`GET /api/ui/manifest` describes the shell to the browser: the site (`name`, `timeZone`, `defaultLanguage`), and
for a signed-in caller the pages it may open, the sidebar groups, the loaded modules, extra strings and API
docs. Entries with `admin: true` are left out for other roles, and the router refuses those pages too.

A page module exports one function per page: `(context) => Node`, with
`context = {me, page, sub, machine, site}` (`#notes/42` gives `page: 'notes'`, `sub: '42'`). Import core helpers
by URL, as the browser sees them:

```js
import {el} from '/views.js';
import {pageHeader, emptyState, notInstalled} from '/ui.js';
import {t} from '/i18n.js';

export function notesPage({me}) {
  return el('div', {}, pageHeader({eyebrow: 'Notes', title: 'Notes', lead: `Signed in as ${me.username}.`}),
    emptyState({icon: '◇', title: 'No notes yet', body: 'Add the first one.', mcpSnippet: true}));
}
```

Nav entry fields: `group` / `groupKey` (sidebar heading; `…Key` is Czech source text passed through `t()`),
`label` / `labelKey`, `hash`, `view`, `order` (core uses 10–50), `admin`, `hidden` (routable, not in the
sidebar), `soon` (a faded placeholder with no page).

Build text-safe DOM only: `el()` puts strings into text nodes and attributes. Never assign `innerHTML` from data.

### Tests

Put them in `local/plugins/<id>/tests/*.test.mjs`. `npm test` runs them after the core tests, with your
`site.json` and all your plugins loaded. A test builds a hub with `createHandler` from `server/index.mjs` and
passes fakes through its options (they arrive as `hub.options`); `tests/hub-helper.mjs` has a ready helper.
Under the test runner, front-end modules can be imported in Node with the same URL-style imports.

## Editions and the public export

`edition.json` at the repository root says `private` (the tree with an overlay) or `public` (an export).
`server/edition.mjs` exposes `readEdition()` and `isPublicRelease()`; `HOME_HUB_EDITION` overrides the file in
tests. The server prints the edition and the number of plugins when it starts. Behaviour does not branch on the
edition: a public tree is simply one without `local/`.

```bash
node scripts/leak-scan.mjs                    # list household details in the files an export would include
node scripts/export-public.mjs <outDir>       # copy the core tree, write edition public and a README stub
node scripts/publish-public-branch.mjs        # commit that export onto the local orphan branch "public"
```

The export copies tracked files outside `local/`, `private/`, `data/`, `state/`, `router-private/` and
`deploy/`. It refuses, with a non-zero exit code, when the scan finds the owner's name, the home subnet, a home
path, the site name, the home domain or an e-mail address outside the placeholder domains.
`tests/leak.test.mjs` runs the same scan in `npm test`. Neither script pushes anything.
