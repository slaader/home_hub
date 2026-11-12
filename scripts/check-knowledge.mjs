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
import {resolvePaths} from '../server/paths.mjs';

// The rules themselves live in public/inventory-rules.js: one pure module that this checker, the hub
// and the entry form in the browser all run, so they can never disagree. Here they meet the site: the
// names of its own secret stores (a password manager vault, …) come from site.json → inventory.secretStores.
import * as rules from '../public/inventory-rules.js';
export {KINDS, PLACED_KINDS, LINK_KINDS, DEP_KINDS, CATEGORIES, categoryOf, STORE_PREFIXES, BUILTIN_STORES, LIMITS, links, walk, find, dependents, placesOf, templateEntries, TEMPLATE_PREFIX} from '../public/inventory-rules.js';

const siteStores = () => loadedSite().inventory.secretStores;
// Options for one particular site: {secretStores}; the default is the site this process loaded.
const forSite = (options = {}) => ({...options, secretStores: options.secretStores ?? siteStores()});
export const storeNames = (secretStores = siteStores()) => rules.storeNames(secretStores);
export const validStore = (store, secretStores = siteStores()) => rules.validStore(store, secretStores);
// {errors, warnings}: errors make the file unusable, warnings are gaps (facts not recorded yet).
export const validate = (doc, options) => rules.validate(doc, forSite(options));
// The same, plus issues: [{level, id, field, code, message, text}] for a form or an agent to act on.
export const check = (doc, options) => rules.check(doc, forSite(options));
// The schema as data (inventory_describe, GET /api/inventory/schema).
export const describe = (inventory = loadedSite().inventory, entries = []) => rules.describe(inventory, entries);

export async function load(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

function line(e) {
  const where = e.address ? `  ${e.address}` : '';
  return `${e.id.padEnd(22)} ${e.kind.padEnd(12)} ${(e.machine || '').padEnd(9)} ${e.name}${where}`;
}

async function main(argv) {
  const fileArg = argv.indexOf('--file');
  const file = fileArg >= 0 ? argv[fileArg + 1] : path.join(resolvePaths().data, 'knowledge.json');
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
