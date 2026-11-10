// The inventory's rules: one pure module (no DOM, no Node APIs) that both sides load.
//   server  scripts/check-knowledge.mjs re-exports it (the checker agents and the hub run);
//           scripts/knowledge-edit.mjs applies edits with it
//   browser the entry form runs the same check() while you type, so its messages are the server's
// A document is {schema: 1, updated_at: 'YYYY-MM-DD', entries: [...]}. Nothing here knows a household:
// the names of a site's own secret stores are passed in (site.json → inventory.secretStores).

export const KINDS = ['network', 'machine', 'runtime', 'tool', 'model-store', 'secret-store', 'skill-store', 'external'];
// Kinds that live on a machine: their "machine" must name a machine entry.
export const PLACED_KINDS = ['machine', 'runtime', 'tool', 'model-store', 'secret-store', 'skill-store'];
export const LINK_KINDS = ['call', 'cert', 'secret', 'data'];
// runs-on is never written: every placed entry runs on its machine, so walks add that link themselves.
export const DEP_KINDS = ['runs-on', ...LINK_KINDS];
// Display grouping for the map. Each kind has a default; set "category" only where an entry differs.
export const CATEGORIES = ['hardware', 'network', 'service', 'model', 'tool', 'llm-support', 'saas', 'secret'];
export const DEFAULT_CATEGORY = {machine: 'hardware', network: 'network', external: 'saas', runtime: 'service', tool: 'tool', 'model-store': 'model', 'skill-store': 'llm-support', 'secret-store': 'secret'};
export const categoryOf = e => e.category || DEFAULT_CATEGORY[e.kind];
export const STORE_PREFIXES = ['keychain:', 'file:', 'app-env:', 'shell-env:', 'app-settings:', 'sso:'];
// The stores every hub knows. remembered = the user knows it and it is written down nowhere.
export const BUILTIN_STORES = ['passwords-app', 'remembered', 'unknown'];
export const CONFIDENCE = ['verified', 'inferred'];
// Every field an entry may carry through the API (the file itself may hold more; they are left alone).
export const ENTRY_FIELDS = ['id', 'kind', 'machine', 'name', 'type', 'category', 'address', 'version', 'config', 'data', 'managed_by', 'login', 'notes', 'secrets', 'depends_on', 'models', 'skills', 'verified_at', 'verified_by', 'confidence'];
// The text fields the entry form edits (POST /api/inventory/entry → fields).
export const EDITABLE = ['name', 'type', 'category', 'address', 'version', 'config', 'data', 'managed_by', 'login', 'notes'];
export const SECRET_FIELDS = ['what', 'store', 'ref', 'check'];
// Sizes the API accepts. textLength, notesLength, secretTextLength, secrets and dependsOn bound the entry
// form's fields; entryBytes is one whole entry as JSON; bulkEntries is one bulk upsert.
export const LIMITS = Object.freeze({idLength: 64, textLength: 2000, notesLength: 12000, secretTextLength: 500, secrets: 30, dependsOn: 60, labelLength: 200, entryBytes: 32768, bulkEntries: 500});
export const ID = /^[a-z][a-z0-9-]*$/;
export const ENTRY_ID = /^[a-z][a-z0-9-]{0,63}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TEXT_FIELDS = ['name', 'machine', 'type', 'category', 'address', 'version', 'config', 'data', 'managed_by', 'login', 'notes', 'verified_at', 'verified_by', 'confidence'];

// Patterns that look like a secret value rather than a pointer to one.
const SECRET_PATTERNS = [
  [/\bhh(?:k)?_[a-f0-9]{64}\b/i, 'Home Hub access key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key block'],
  [/\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/, 'API key'],
  [/\b(ghp|gho|ghs|github_pat|glpat|xox[abpr])[-_][A-Za-z0-9_-]{10,}/, 'access token'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, 'JWT'],
  [/\b(password|passwd|pwd|secret|token|api[_-]?key)\s*[=:]\s*\S{6,}/i, 'assignment of a secret'],
  [/:\/\/[^/\s:@]+:[^/\s@]+@/, 'credentials in a URL'],
  [/\b[A-Fa-f0-9]{40,}\b/, 'long hex string'],
  // No "/" or "-" in the run, so paths and model names never match.
  [/(?<![A-Za-z0-9+_])(?=[A-Za-z0-9+_]*\d)(?=[A-Za-z0-9+_]*[A-Z])(?=[A-Za-z0-9+_]*[a-z])[A-Za-z0-9+_]{32,}={0,2}(?![A-Za-z0-9+_])/, 'long random-looking string']
];
// Check commands must prove a secret exists without printing it.
const PRINTING_CHECKS = [
  [/find-(generic|internet)-password\b[^|;&]*\s-w\b/, 'security ... -w prints the password'],
  [/\b(cat|less|head|tail|bat)\s+\S*(auth|token|secret|\.env|credentials|\.pem|\.key|id_[a-z0-9]+)\b/i, 'prints a secret file'],
  [/\b(printenv|echo\s+["']?\$[A-Z_]+)\b/, 'prints an environment variable'],
  [/^\s*env\s*$/, 'dumps the environment']
];

export const storeNames = (secretStores = []) => [...BUILTIN_STORES, ...secretStores];
export function validStore(store, secretStores = []) {
  return typeof store === 'string' && (storeNames(secretStores).includes(store) || STORE_PREFIXES.some(p => store.startsWith(p) && store.length > p.length));
}
// What a text looks like when it is a secret value, or null.
export const secretLike = text => { for (const [re, why] of SECRET_PATTERNS) if (re.test(text)) return why; return null; };

const plain = v => v && typeof v === 'object' && !Array.isArray(v);
const list = v => Array.isArray(v) ? v : [];
function strings(value, at, out = []) {
  if (typeof value === 'string') out.push([at, value]);
  else if (Array.isArray(value)) value.forEach((v, i) => strings(v, `${at}[${i}]`, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) strings(v, at ? `${at}.${k}` : k, out);
  return out;
}

/**
 * Checks a whole document. Returns {errors, warnings, issues}: errors and warnings are the messages
 * (errors make the file unusable, warnings are gaps: facts not recorded yet), issues say the same with
 * structure: {level, id, index, field, code, message, text, ...values}; text is the message without
 * the "entry …:" prefix, field is a path such as "secrets[0].store".
 */
export function check(doc, {secretStores = []} = {}) {
  const issues = [];
  const done = () => ({errors: issues.filter(i => i.level === 'error').map(i => i.message), warnings: issues.filter(i => i.level === 'warning').map(i => i.message), issues});
  const top = (code, text) => issues.push({level: 'error', id: null, index: null, field: null, code, message: text, text});
  if (!plain(doc) || !Array.isArray(doc.entries)) { top('doc-shape', 'top level must be an object with an "entries" array'); return done(); }
  if (doc.schema !== 1) top('doc-schema', 'schema must be 1');
  if (!DATE.test(doc.updated_at || '')) top('doc-updated', 'updated_at must be YYYY-MM-DD');
  const byId = new Map();
  for (const [i, e] of doc.entries.entries()) {
    const at = plain(e) && e.id ? `entry "${e.id}"` : `entries[${i}]`;
    const add = (level, field, code, text, values = {}) => issues.push({level, id: plain(e) && typeof e.id === 'string' ? e.id : null, index: i, field, code, message: `${at}: ${text}`, text, ...values});
    const error = (field, code, text, values) => add('error', field, code, text, values);
    if (!plain(e)) { error(null, 'entry-shape', 'not an object'); continue; }
    if (typeof e.id !== 'string' || !ID.test(e.id)) error('id', 'id-format', 'id must be lowercase kebab-case');
    else if (byId.has(e.id)) error('id', 'id-duplicate', 'duplicate id');
    else byId.set(e.id, e);
    if (!KINDS.includes(e.kind)) error('kind', 'kind', `kind must be one of ${KINDS.join(', ')}`);
    if (!e.name) error('name', 'name-required', 'name is required');
    // null is tolerated as "not recorded" (files written by hand carry it); anything else must be text.
    for (const f of TEXT_FIELDS) if (e[f] != null && typeof e[f] !== 'string') error(f, 'text', `${f} must be text`, {name: f});
    if (e.category !== undefined && !CATEGORIES.includes(e.category)) error('category', 'category', `category must be one of ${CATEGORIES.join(', ')}`);
    if (!DATE.test(e.verified_at || '')) error('verified_at', 'verified-at', 'verified_at must be YYYY-MM-DD');
    if (e.confidence && !CONFIDENCE.includes(e.confidence)) error('confidence', 'confidence', 'confidence must be verified or inferred');
    for (const f of ['secrets', 'depends_on', 'models', 'skills']) if (e[f] != null && !Array.isArray(e[f])) error(f, 'list', `${f} must be a list`, {name: f});
    for (const f of ['models', 'skills']) list(e[f]).forEach((v, n) => { if (typeof v !== 'string') error(`${f}[${n}]`, 'text', `${f}[${n}] must be text`, {name: `${f}[${n}]`}); });
    list(e.secrets).forEach((s, n) => {
      if (!plain(s)) return error(`secrets[${n}]`, 'secret-shape', `secrets[${n}] must be an object`);
      if (!s.what) error(`secrets[${n}].what`, 'secret-what', 'every secret needs "what"');
      if (!validStore(s.store || '', secretStores)) error(`secrets[${n}].store`, 'secret-store', `secret "${s.what}" has unknown store "${s.store}"`, {what: s.what, store: s.store});
      for (const [re, why] of PRINTING_CHECKS) if (typeof s.check === 'string' && s.check && re.test(s.check)) error(`secrets[${n}].check`, 'secret-check', `check for "${s.what}" ${why}`, {what: s.what, why});
    });
    list(e.depends_on).forEach((d, n) => {
      if (!plain(d) || typeof d.id !== 'string') return error(`depends_on[${n}]`, 'dep-shape', `depends_on[${n}] must be an object with an id`);
      if (!LINK_KINDS.includes(d.kind)) error(`depends_on[${n}].kind`, 'dep-kind', `depends_on "${d.id}" kind must be one of ${LINK_KINDS.join(', ')}`, {target: d.id});
      if (d.id === e.id) error(`depends_on[${n}].id`, 'dep-self', 'depends on itself');
    });
    for (const [field, text] of strings(e, '')) {
      if (field.endsWith('.check')) continue;
      for (const [re, why] of SECRET_PATTERNS) if (re.test(text)) error(field, 'secret-value', `${field} looks like a secret value (${why}); record where it is kept, not the value`, {name: field, why});
    }
  }
  const index = new Map(doc.entries.map((e, i) => [e, i]));
  for (const e of byId.values()) {
    const add = (level, field, code, text, values = {}) => issues.push({level, id: e.id, index: index.get(e), field, code, message: `entry "${e.id}": ${text}`, text, ...values});
    if (e.kind === 'machine') {
      if (e.machine && !byId.has(e.machine)) add('error', 'machine', 'machine-missing', `machine "${e.machine}" does not exist`, {machine: e.machine});
    } else if (PLACED_KINDS.includes(e.kind)) {
      const m = byId.get(e.machine);
      if (!m || m.kind !== 'machine') add('error', 'machine', 'machine-required', 'machine must name a machine entry');
    }
    list(e.depends_on).forEach((d, n) => { if (plain(d) && typeof d.id === 'string' && !byId.has(d.id)) add('error', `depends_on[${n}].id`, 'dep-missing', `depends_on "${d.id}" does not exist`, {target: d.id}); });
    list(e.secrets).forEach((s, n) => { if (plain(s) && s.store === 'unknown') add('warning', `secrets[${n}].store`, 'gap-store', `where "${s.what}" is kept is not recorded`, {what: s.what}); });
    if (e.kind === 'runtime' && !e.address) add('warning', 'address', 'gap-address', 'no address');
  }
  return done();
}
// The checker's classic answer: {errors, warnings} as message lists.
export function validate(doc, options) {
  const {errors, warnings} = check(doc, options);
  return {errors, warnings};
}

// Every dependency edge: the recorded depends_on links plus the implied runs-on link to the entry's machine.
export function links(doc) {
  const ids = new Set(doc.entries.map(e => e.id)), out = [];
  for (const e of doc.entries) {
    for (const d of e.depends_on || []) out.push({from: e.id, to: d.id, kind: d.kind, label: d.label || ''});
    if (e.kind !== 'machine' && e.machine && ids.has(e.machine)) out.push({from: e.id, to: e.machine, kind: 'runs-on', label: 'runs on'});
  }
  return out;
}
// Breadth-first over the edges: forward = what `start` needs, backward = what stops if it fails.
export function walk(doc, start, forward) {
  const out = [], seen = new Set([start]), queue = [[start, 0]], all = links(doc);
  while (queue.length) {
    const [cur, depth] = queue.shift();
    for (const l of all) {
      const [from, to] = forward ? [l.from, l.to] : [l.to, l.from];
      if (from !== cur || seen.has(to)) continue;
      seen.add(to);
      out.push({id: to, depth: depth + 1, kind: l.kind, label: l.label});
      queue.push([to, depth + 1]);
    }
  }
  return out;
}
export function find(doc, text) {
  const q = text.toLowerCase();
  return doc.entries.filter(e => strings(e, '').some(([, v]) => v.toLowerCase().includes(q)));
}
// Entries that name `id` in depends_on or run on it: what must change before `id` can be deleted.
export function dependents(doc, id) {
  return doc.entries.filter(e => e.id !== id && (e.machine === id || list(e.depends_on).some(d => d?.id === id))).map(e => e.id);
}

// One entry with the form's fields applied: an emptied text field is removed, as are empty lists.
// fields: any of EDITABLE, plus machine, secrets [{what, store, ref, check}] and depends_on [{id, kind, label}].
export function withFields(entry, fields) {
  const next = {...entry};
  for (const k of [...EDITABLE, 'machine']) if (k in fields) { if (fields[k]) next[k] = fields[k]; else delete next[k]; }
  for (const k of ['secrets', 'depends_on']) if (k in fields) { if (fields[k].length) next[k] = fields[k]; else delete next[k]; }
  return next;
}

// Where entries can live: the site's places (site.json → inventory.places), then every machine entry
// the site did not list. A hub without a site file gets its places from its own machine entries.
export function placesOf(site = [], entries = []) {
  const known = new Set(site.map(p => p.id));
  return [...site.map(p => ({...p, source: 'site'})), ...entries.filter(e => e?.kind === 'machine' && typeof e.id === 'string' && !known.has(e.id)).map(e => ({id: e.id, label: e.name || e.id, column: e.name || e.id, source: 'machine'}))];
}

// A few generic entries a new hub can start from (the map's "start from a template"): a router, a
// server, what runs on it and an outside service, with dependencies, a secret location and one gap.
// Every id starts with "example-", so they are easy to find and delete.
export const TEMPLATE_PREFIX = 'example-';
export function templateEntries() {
  const note = 'Example entry: edit it to match your setup, or delete it.';
  return [
    {id: 'example-router', kind: 'network', name: 'Router (example)', type: 'Router · Wi-Fi', address: '10.0.0.1', login: 'Admin page on the LAN', notes: note,
      secrets: [{what: 'Router admin password', store: 'passwords-app', ref: 'Router admin'}]},
    {id: 'example-server', kind: 'machine', name: 'Home server (example)', type: 'Mini PC · Linux', address: 'server.example.lan', login: 'ssh server', notes: note},
    {id: 'example-hub', kind: 'runtime', machine: 'example-server', name: 'Home Hub (example)', type: 'Node service', address: 'http://server.example.lan:8799', version: '2', config: '~/home-hub/local/site.json', login: 'Admin password sign-in', notes: note,
      secrets: [{what: 'Admin password', store: 'passwords-app', ref: 'Home Hub admin'}]},
    {id: 'example-proxy', kind: 'runtime', machine: 'example-server', name: 'Reverse proxy (example)', type: 'Caddy', address: 'https://hub.example.lan', config: '/etc/caddy/Caddyfile', notes: note,
      secrets: [{what: 'DNS API token', store: 'file:example-server', ref: '/etc/caddy/dns.env', check: 'test -s /etc/caddy/dns.env'}],
      depends_on: [{id: 'example-hub', kind: 'call', label: 'forwards to'}, {id: 'example-dns', kind: 'cert', label: 'DNS challenge'}, {id: 'example-router', kind: 'call', label: 'port forward'}]},
    {id: 'example-backup', kind: 'tool', machine: 'example-server', name: 'Nightly backup (example)', type: 'Scheduled job', config: 'crontab -l', notes: note,
      depends_on: [{id: 'example-hub', kind: 'data', label: 'copies its data folder'}]},
    {id: 'example-dns', kind: 'external', name: 'DNS provider (example)', type: 'SaaS', address: 'https://dns.example.com', login: 'Web sign-in', notes: note,
      secrets: [{what: 'Account password', store: 'unknown'}]},
  ];
}

const KIND_HELP = {
  network: 'Network gear: a router, a switch, an access point.',
  machine: 'A computer, a NAS, a single-board computer: something other entries run on.',
  runtime: 'A running service (it has an address): a server, a daemon, an app with a port. These are the services catalog.',
  tool: 'A program or job without a network address: a CLI, a scheduled job, a desktop app.',
  'model-store': 'A folder or volume that holds model weights.',
  'secret-store': 'A place that holds secrets: a keychain, a vault, an env file. List its items under secrets (location only).',
  'skill-store': 'A folder or repository of agent skills.',
  external: 'A service outside your network: a DNS provider, a git host, a SaaS.',
};
const LINK_HELP = {call: 'calls it over the network or an API', cert: 'takes a TLS certificate from it', secret: 'takes a credential from it', data: 'reads its files or data'};
const STORE_HELP = {'passwords-app': 'the operating system\'s or a browser\'s password manager', remembered: 'the owner knows it and it is written down nowhere', unknown: 'not recorded yet (reported as a gap)'};
const PREFIX_HELP = {'keychain:': ['keychain:<machine id>', 'the Keychain or keyring of that machine'], 'file:': ['file:<machine id>', 'a file on that machine; put its path in ref'], 'app-env:': ['app-env:<app>', 'the environment configured for an app or container'], 'shell-env:': ['shell-env:<machine id>', 'a shell profile variable on that machine; put its name in ref'], 'app-settings:': ['app-settings:<app>', 'kept inside the settings of an app'], 'sso:': ['sso:<provider>', 'signing in with an identity provider, no secret of its own']};

/**
 * Everything an agent needs to fill the inventory correctly, as data: the document and entry shape,
 * kinds, categories, link kinds, secret stores, places and the rules the checker enforces.
 * site: {places, secretStores} from site.json → inventory; entries: the current entries (for places).
 */
export function describe({places = [], secretStores = []} = {}, entries = []) {
  const text = (name, description, extra = {}) => ({name, type: 'string', description, ...extra});
  return {
    schema: 1,
    file: 'data/knowledge.json',
    document: {schema: 'always 1', updated_at: 'YYYY-MM-DD, set by the hub on every write', entries: 'the entries, each as described under entry'},
    entry: {fields: [
      text('id', 'Lowercase letters, digits and hyphens, starting with a letter; at most 64 characters. Never changes. Convention: <machine>-<service>.', {required: true, pattern: ENTRY_ID.source}),
      text('kind', 'What it is; see kinds.', {required: true, enum: KINDS}),
      text('name', 'The name people use for it.', {required: true}),
      text('machine', `The id of the machine entry it runs on. Required for: ${PLACED_KINDS.filter(k => k !== 'machine').join(', ')}. Not used by network and external.`),
      text('type', 'A short free-text type, e.g. "Caddy" or "Node service · launchd".'),
      text('category', 'Colour group on the map; set it only when the default for the kind is wrong.', {enum: CATEGORIES}),
      text('address', 'How to reach it: host:port, a URL, an IP address. A runtime without one is reported as a gap.'),
      text('version', 'The installed version as you observed it.'),
      text('config', 'Where its configuration lives (a path), never the configuration itself.'),
      text('data', 'Where its data lives (a path or volume).'),
      text('managed_by', 'What starts and supervises it: launchd label, systemd unit, container app, cron.'),
      text('login', 'How a person signs in, in words. Never a password or token.'),
      text('notes', 'Anything else worth knowing. No secret values.'),
      {name: 'secrets', type: 'array', description: 'Where each credential is kept, never its value: [{what, store, ref, check}]. what and store are required.'},
      {name: 'depends_on', type: 'array', description: 'What it needs: [{id, kind, label}]. id is another entry, kind is a link kind, label is optional free text. Do not list the machine it runs on: that link is implied by "machine".'},
      {name: 'models', type: 'array', description: 'For a model store or a model server: model names (strings).'},
      {name: 'skills', type: 'array', description: 'For a skill store: skill names (strings).'},
      text('confidence', 'verified (you checked it; the default) or inferred (deduced, not checked).', {enum: CONFIDENCE}),
      text('verified_at', 'YYYY-MM-DD. Set by the hub on every write.', {setByHub: true}),
      text('verified_by', 'Who wrote it. Set by the hub on every write.', {setByHub: true}),
    ]},
    kinds: KINDS.map(id => ({id, description: KIND_HELP[id], needsMachine: PLACED_KINDS.includes(id) && id !== 'machine', defaultCategory: DEFAULT_CATEGORY[id]})),
    categories: CATEGORIES,
    linkKinds: LINK_KINDS.map(id => ({id, description: LINK_HELP[id]})),
    impliedLinks: [{id: 'runs-on', description: 'from every entry to its machine; never written in depends_on'}],
    secrets: {
      fields: [text('what', 'What the credential is, e.g. "Admin password".', {required: true}), text('store', 'Where it is kept: a store name or a prefix form (see stores).', {required: true}),
        text('ref', 'The item name, path or variable name inside the store.'), text('check', 'A command that proves the secret exists without printing it.')],
      stores: [...BUILTIN_STORES.map(id => ({store: id, description: STORE_HELP[id]})), ...secretStores.map(id => ({store: id, description: 'a secret store of this site (site.json → inventory.secretStores)'})),
        ...STORE_PREFIXES.map(p => ({store: PREFIX_HELP[p][0], description: PREFIX_HELP[p][1]}))],
    },
    places: placesOf(places, entries).map(p => ({id: p.id, label: p.label, source: p.source})),
    rules: [
      'Record where a password, token or key is kept, never its value. Any text that looks like a secret is refused: an API key or token, a private key block, a JWT, "password=…", credentials inside a URL, a long hex or random-looking string.',
      'A check command must not print the secret: no "security … -w", no cat/less/head/tail of a credential file, no printenv or echo $VAR, no bare env.',
      `kind is one of: ${KINDS.join(', ')}.`,
      `An entry of kind ${PLACED_KINDS.filter(k => k !== 'machine').join(', ')} must name an existing machine entry in "machine"; create the machine first (or in the same bulk call).`,
      'Every depends_on id must exist, its kind must be a link kind, and an entry cannot depend on itself.',
      'ids are unique and never reused for something else.',
      'An entry that others depend on, or that others run on, cannot be deleted until they are changed or deleted.',
      'The whole file is checked on every write; a write that would leave it invalid is refused and nothing changes.',
    ],
    gaps: ['a secret whose store is "unknown"', 'a runtime without an address'],
    concurrency: 'Optimistic, per entry. Every entry has a hash (inventory_get, inventory_search, GET /api/inventory → hashes). To change or delete an entry pass that hash as base; if the entry changed in between the write is refused: read it again and reapply. Omit base only to create.',
    limits: {...LIMITS},
    tools: {
      read: ['inventory_describe', 'inventory_search', 'inventory_get'],
      write: {scope: 'inventory:write', tools: ['inventory_update', 'inventory_bulk_upsert', 'inventory_delete']},
    },
    examples: templateEntries(),
  };
}
