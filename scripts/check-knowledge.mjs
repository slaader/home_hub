#!/usr/bin/env node
// Validates and queries data/knowledge.json, the home inventory.
//   node scripts/check-knowledge.mjs                 validate (exit 1 on errors)
//   node scripts/check-knowledge.mjs --find <text>   search every field
//   node scripts/check-knowledge.mjs --needs <id>    what <id> depends on (transitively)
//   node scripts/check-knowledge.mjs --impact <id>   what stops if <id> fails (transitively)
//   node scripts/check-knowledge.mjs --gaps          entries with missing facts
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {site as loadedSite} from '../server/site-config.mjs';

export const KINDS = ['network', 'machine', 'runtime', 'tool', 'model-store', 'secret-store', 'skill-store', 'external'];
export const LINK_KINDS = ['call', 'cert', 'secret', 'data'];
// runs-on is never written: every placed entry runs on its machine, so walks add that link themselves.
export const DEP_KINDS = ['runs-on', ...LINK_KINDS];
// Display grouping for the map. Each kind has a default; set "category" only where an entry differs
// (model servers and generators are "model", the OB1 stack is "llm-support").
export const CATEGORIES = ['hardware', 'network', 'service', 'model', 'tool', 'llm-support', 'saas', 'secret'];
const DEFAULT_CATEGORY = {machine: 'hardware', network: 'network', external: 'saas', runtime: 'service', tool: 'tool', 'model-store': 'model', 'skill-store': 'llm-support', 'secret-store': 'secret'};
export const categoryOf = e => e.category || DEFAULT_CATEGORY[e.kind];
export const STORE_PREFIXES = ['keychain:', 'file:', 'app-env:', 'shell-env:', 'app-settings:', 'sso:'];
// remembered = the user knows it and it is written down nowhere. A site adds the names of its own
// stores (a password manager vault, …) in site.json → inventory.secretStores.
export const STORE_NAMES = ['passwords-app', 'remembered', 'unknown'];
export const storeNames = () => [...STORE_NAMES, ...loadedSite().inventory.secretStores];
const ID = /^[a-z][a-z0-9-]*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

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

export function validStore(store) {
  return storeNames().includes(store) || STORE_PREFIXES.some(p => store.startsWith(p) && store.length > p.length);
}

function strings(value, at, out = []) {
  if (typeof value === 'string') out.push([at, value]);
  else if (Array.isArray(value)) value.forEach((v, i) => strings(v, `${at}[${i}]`, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) strings(v, at ? `${at}.${k}` : k, out);
  return out;
}

export function validate(doc) {
  const errors = [], warnings = [];
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.entries)) return {errors: ['top level must be an object with an "entries" array'], warnings};
  if (doc.schema !== 1) errors.push('schema must be 1');
  if (!DATE.test(doc.updated_at || '')) errors.push('updated_at must be YYYY-MM-DD');
  const byId = new Map();
  for (const [i, e] of doc.entries.entries()) {
    const at = e?.id ? `entry "${e.id}"` : `entries[${i}]`;
    if (!e || typeof e !== 'object') { errors.push(`${at}: not an object`); continue; }
    if (!ID.test(e.id || '')) errors.push(`${at}: id must be lowercase kebab-case`);
    else if (byId.has(e.id)) errors.push(`${at}: duplicate id`);
    else byId.set(e.id, e);
    if (!KINDS.includes(e.kind)) errors.push(`${at}: kind must be one of ${KINDS.join(', ')}`);
    if (!e.name) errors.push(`${at}: name is required`);
    if (e.category !== undefined && !CATEGORIES.includes(e.category)) errors.push(`${at}: category must be one of ${CATEGORIES.join(', ')}`);
    if (!DATE.test(e.verified_at || '')) errors.push(`${at}: verified_at must be YYYY-MM-DD`);
    if (e.confidence && !['verified', 'inferred'].includes(e.confidence)) errors.push(`${at}: confidence must be verified or inferred`);
    for (const s of e.secrets || []) {
      if (!s.what) errors.push(`${at}: every secret needs "what"`);
      if (!validStore(s.store || '')) errors.push(`${at}: secret "${s.what}" has unknown store "${s.store}"`);
      for (const [re, why] of PRINTING_CHECKS) if (s.check && re.test(s.check)) errors.push(`${at}: check for "${s.what}" ${why}`);
    }
    for (const d of e.depends_on || []) {
      if (!LINK_KINDS.includes(d.kind)) errors.push(`${at}: depends_on "${d.id}" kind must be one of ${LINK_KINDS.join(', ')}`);
      if (d.id === e.id) errors.push(`${at}: depends on itself`);
    }
    for (const [field, text] of strings(e, '')) {
      if (field.endsWith('.check')) continue;
      for (const [re, why] of SECRET_PATTERNS) if (re.test(text)) errors.push(`${at}: ${field} looks like a secret value (${why}); record where it is kept, not the value`);
    }
  }
  for (const e of byId.values()) {
    const placed = ['machine', 'runtime', 'tool', 'model-store', 'secret-store', 'skill-store'].includes(e.kind);
    if (e.kind === 'machine') {
      if (e.machine && !byId.has(e.machine)) errors.push(`entry "${e.id}": machine "${e.machine}" does not exist`);
    } else if (placed) {
      const m = byId.get(e.machine);
      if (!m || m.kind !== 'machine') errors.push(`entry "${e.id}": machine must name a machine entry`);
    }
    for (const d of e.depends_on || []) if (!byId.has(d.id)) errors.push(`entry "${e.id}": depends_on "${d.id}" does not exist`);
    for (const s of e.secrets || []) if (s.store === 'unknown') warnings.push(`entry "${e.id}": where "${s.what}" is kept is not recorded`);
    if (e.kind === 'runtime' && !e.address) warnings.push(`entry "${e.id}": no address`);
  }
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

export async function load(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

function line(e) {
  const where = e.address ? `  ${e.address}` : '';
  return `${e.id.padEnd(22)} ${e.kind.padEnd(12)} ${(e.machine || '').padEnd(9)} ${e.name}${where}`;
}

async function main(argv) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const fileArg = argv.indexOf('--file');
  const file = fileArg >= 0 ? argv[fileArg + 1] : path.join(root, 'data', 'knowledge.json');
  const doc = await load(file);
  const {errors, warnings} = validate(doc);
  const name = id => doc.entries.find(e => e.id === id)?.name || id;
  const flag = f => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
  if (flag('--find')) { find(doc, flag('--find')).forEach(e => console.log(line(e))); return 0; }
  for (const [f, forward, title] of [['--needs', true, 'needs'], ['--impact', false, 'stops if it fails']]) {
    const id = flag(f);
    if (!id) continue;
    if (!doc.entries.some(e => e.id === id)) { console.error(`no entry "${id}"`); return 1; }
    const list = walk(doc, id, forward);
    console.log(`${name(id)} ${title}: ${list.length ? '' : 'nothing recorded'}`);
    list.forEach(x => console.log(`${'  '.repeat(x.depth)}${name(x.id)} (${x.id}) · ${x.kind}${x.label ? ' · ' + x.label : ''}`));
    return 0;
  }
  if (argv.includes('--gaps')) { warnings.forEach(w => console.log(w)); return 0; }
  errors.forEach(e => console.error(`error: ${e}`));
  console.log(`${doc.entries.length} entries · ${errors.length} errors · ${warnings.length} gaps (run with --gaps to list)`);
  return errors.length ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
