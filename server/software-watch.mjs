// The software watch list: which programs the versions page follows, where their newest version is read
// (the upstream) and how the installed version is read on each machine (one detect rule per machine).
//   local/software-watch.json    a site's own list: the file next to its site.json
//                                (SOFTWARE_WATCH_FILE selects another file; no site overlay, no list)
//   config/software-watch.json   a generic example to copy from; it is never the active list
// A hub without its own list watches nothing: operating systems, NAS apps and containers are still
// discovered by the probes. The list is edited by hand, through POST /api/software-watch, or by an agent
// through the MCP tools software_watch_list / software_watch_put (scope software:write).
//
// A detect rule is data, never shell. The collector turns a rule into one "id|kind|a|b|launchd" line
// for the read-only probe (systemsSpecs in systems-data.mjs), and everything written through the API
// passes validateItem() below: paths without shell metacharacters, a fixed set of version flags for the
// cmd kind, bounded regular expressions and upstreams of known types only.
import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {repoRoot} from './edition.mjs';
import {resolvePaths} from './paths.mjs';

export const WATCH_SCHEMA=1;
export const WATCH_LIMITS=Object.freeze({items:200,categories:20,machinesPerItem:50,bytes:262144});
export const DETECT_KINDS=Object.freeze(['brew','cask','app','cmd','pydist','json']);
export const UPSTREAM_TYPES=Object.freeze(['github','codeberg','pypi','npm','brew-formula','brew-cask','node','none','thermo-feed']);
// The only arguments a cmd rule may pass to the watched binary. Anything else could make an arbitrary
// program do arbitrary things on the probed machine, so the collector refuses it too.
export const CMD_ARGS=Object.freeze(['--version','-version','-v','-V','version']);
export const VERSION_SCHEMES=Object.freeze(['llamacpp','node']);
// Categories the payload adds by itself (NAS apps, Docker containers); a list cannot redefine them.
export const RESERVED_CATEGORIES=Object.freeze(['nas-apps','containers']);

const ITEM_ID=/^[a-z0-9][a-z0-9._-]{0,39}$/;
const CATEGORY_ID=/^[a-z][a-z0-9-]{0,29}$/;
const MACHINE_ID=/^[a-z][a-z0-9_-]{1,31}$/;
const PACKAGE=/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const NPM_PACKAGE=/^(@[a-z0-9][a-z0-9._-]{0,99}\/)?[a-z0-9][a-z0-9._-]{0,99}$/;
const BREW_NAME=/^[a-z0-9][a-z0-9@._+-]{0,79}$/;
const REPO=/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9._-]{1,100}$/;
const LAUNCHD=/^(system\/)?[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const JSON_KEY=/^[A-Za-z_][A-Za-z0-9_.-]{0,59}$/;
// A file path on the probed machine: absolute or under the home directory, printable, and free of
// everything a shell would act on. * and ? are allowed only where the probe expands a glob.
const PATH_CHARS=/^(~\/|\/)[A-Za-z0-9 ._@+,:=%()\[\]\/-]{1,298}$/;
const GLOB_CHARS=/^(~\/|\/)[A-Za-z0-9 ._@+,:=%()\[\]*?\/-]{1,298}$/;
const plain=v=>v&&typeof v==='object'&&!Array.isArray(v);
const text=(v,max)=>typeof v==='string'&&v.length<=max&&!/[\u0000-\u001f\u007f]/.test(v);

export const watchExamplePath=(root=repoRoot)=>path.join(root,'config','software-watch.json');
// The list lives beside the site configuration (local/site.json → local/software-watch.json), so a hub
// started with another site file, or with none (HOME_HUB_SITE_CONFIG=none → null), never reads this one's.
export const watchPath=(env=process.env,root=repoRoot)=>resolvePaths(env,root).softwareWatch;
export const emptyWatch=()=>({schemaVersion:WATCH_SCHEMA,categories:{},items:[]});

// A stable hash of one item, for optimistic concurrency: read the list, change an item, send its hash back.
const canonical=v=>Array.isArray(v)?v.map(canonical):plain(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
export const itemHash=item=>createHash('sha256').update(JSON.stringify(canonical(item))).digest('hex');

// --- validation ------------------------------------------------------------------------------------
// A regular expression the server or the probe will run on short version strings. Bounded in length and
// free of the nested-quantifier shapes that make a match take exponential time.
export function safePattern(source){
 if(!text(source,200)||!source)return false;
 if(/\([^()]*[+*}][^()]*\)\s*[+*{]/.test(source)||/\\[1-9]/.test(source))return false;
 try{new RegExp(source);return true;}catch{return false;}
}
const unknownKeys=(v,allowed)=>Object.keys(v).filter(k=>!allowed.includes(k));

// previous: the upstream this item already has. A thermo-feed upstream names a URL the collector fetches,
// so the API keeps an existing one as it is but never accepts a new address.
function validUpstream(raw,where,errors,previous=null){
 if(!plain(raw)||!UPSTREAM_TYPES.includes(raw.type)){errors.push(`${where}.type must be one of ${UPSTREAM_TYPES.filter(t=>t!=='thermo-feed').join(', ')}`);return null;}
 const t=raw.type,fields={github:['repo','tagPrefix','tagPattern','allowPrerelease'],codeberg:['repo','tagPrefix','tagPattern','allowPrerelease'],pypi:['package'],npm:['package','tag'],
  'brew-formula':['name'],'brew-cask':['name'],node:[],none:['note'],'thermo-feed':['url']}[t];
 const extra=unknownKeys(raw,['type',...fields]);if(extra.length){errors.push(`${where} has unknown field(s) for type ${t}: ${extra.join(', ')}`);return null;}
 const out={type:t},need=(ok,message)=>{if(!ok)errors.push(`${where}.${message}`);return ok;};
 if(t==='github'||t==='codeberg'){
  if(need(typeof raw.repo==='string'&&REPO.test(raw.repo),'repo must be "owner/name"'))out.repo=raw.repo;
  if(raw.tagPrefix!==undefined&&need(typeof raw.tagPrefix==='string'&&/^[A-Za-z0-9._@\/-]{1,40}$/.test(raw.tagPrefix),'tagPrefix must be 1-40 characters of letters, digits and . _ @ / -'))out.tagPrefix=raw.tagPrefix;
  if(raw.tagPattern!==undefined&&need(safePattern(raw.tagPattern),'tagPattern must be a simple regular expression of at most 200 characters'))out.tagPattern=raw.tagPattern;
  if(raw.allowPrerelease!==undefined&&need(typeof raw.allowPrerelease==='boolean','allowPrerelease must be true or false'))out.allowPrerelease=raw.allowPrerelease;
 }else if(t==='pypi'){if(need(typeof raw.package==='string'&&PACKAGE.test(raw.package),'package must be a PyPI project name'))out.package=raw.package;}
 else if(t==='npm'){
  if(need(typeof raw.package==='string'&&NPM_PACKAGE.test(raw.package),'package must be an npm package name such as @scope/name'))out.package=raw.package;
  if(raw.tag!==undefined&&need(typeof raw.tag==='string'&&/^[a-z][a-z0-9._-]{0,39}$/.test(raw.tag),'tag must be a dist-tag such as latest'))out.tag=raw.tag;
 }else if(t==='brew-formula'||t==='brew-cask'){if(need(typeof raw.name==='string'&&BREW_NAME.test(raw.name),'name must be a Homebrew formula or cask name'))out.name=raw.name;}
 else if(t==='none'){if(raw.note!==undefined&&need(text(raw.note,300),'note must be at most 300 characters'))out.note=raw.note;}
 else if(t==='thermo-feed'){
  if(need(previous?.type==='thermo-feed'&&previous.url===raw.url,'thermo-feed upstreams are set in the file itself; through the API an existing one can only be kept unchanged'))out.url=raw.url;
 }
 return out;
}
function validSource(raw,where,errors){
 if(!plain(raw)||unknownKeys(raw,['label','url']).length||!text(raw.label,120)||!raw.label.trim()){errors.push(`${where} must be {label, url}: a label of at most 120 characters`);return null;}
 const url=raw.url??null;
 if(url!==null){let u;try{u=new URL(url);}catch{}if(typeof url!=='string'||url.length>300||!u||!['http:','https:'].includes(u.protocol)){errors.push(`${where}.url must be an http(s) URL or null`);return null;}}
 return {label:raw.label,url};
}
function validDetect(raw,where,errors,previous=null){
 if(!plain(raw)||!DETECT_KINDS.includes(raw.kind)){errors.push(`${where}.kind must be one of ${DETECT_KINDS.join(', ')}`);return null;}
 const k=raw.kind,fields={brew:['formula'],cask:['cask'],app:['path'],cmd:['path','args','match'],pydist:['glob','package'],json:['path','key']}[k];
 const extra=unknownKeys(raw,['kind',...fields,'launchd','upstream','source','inventory']);
 if(extra.length){errors.push(`${where} has unknown field(s) for kind ${k}: ${extra.join(', ')}`);return null;}
 const out={kind:k},need=(ok,message)=>{if(!ok)errors.push(`${where}.${message}`);return ok;};
 const filePath=(v,chars=PATH_CHARS)=>typeof v==='string'&&chars.test(v)&&!v.split('/').includes('..');
 const pathRule='must be an absolute path or start with ~/, without .. and without shell characters';
 if(k==='brew'){if(need(typeof raw.formula==='string'&&raw.formula.split(',').length<=4&&raw.formula.split(',').every(f=>BREW_NAME.test(f)),'formula must be a formula name (up to 4 alternatives separated by commas)'))out.formula=raw.formula;}
 else if(k==='cask'){if(need(typeof raw.cask==='string'&&BREW_NAME.test(raw.cask),'cask must be a cask name'))out.cask=raw.cask;}
 else if(k==='app'){if(need(filePath(raw.path)&&/\.app$/.test(raw.path),`path ${pathRule}, ending in .app`))out.path=raw.path;}
 else if(k==='cmd'){
  if(need(filePath(raw.path,GLOB_CHARS),`path ${pathRule} (* and ? match several installs)`))out.path=raw.path;
  if(need(CMD_ARGS.includes(raw.args),`args must be one of ${CMD_ARGS.join(', ')}: the probe runs the binary only to print its version`))out.args=raw.args;
  if(raw.match!==undefined&&need(safePattern(raw.match),'match must be a simple regular expression of at most 200 characters'))out.match=raw.match;
 }else if(k==='pydist'){
  if(need(filePath(raw.glob,GLOB_CHARS),`glob ${pathRule} (the site-packages directories to look in)`))out.glob=raw.glob;
  if(need(typeof raw.package==='string'&&PACKAGE.test(raw.package),'package must be a Python distribution name'))out.package=raw.package;
 }else if(k==='json'){
  if(need(filePath(raw.path),`path ${pathRule}`))out.path=raw.path;
  if(raw.key!==undefined&&need(typeof raw.key==='string'&&JSON_KEY.test(raw.key),'key must be a JSON field name (default: version)'))out.key=raw.key;
 }
 if(raw.launchd!==undefined&&need(typeof raw.launchd==='string'&&LAUNCHD.test(raw.launchd),'launchd must be a launchd label, optionally prefixed with system/'))out.launchd=raw.launchd;
 if(raw.upstream!==undefined){const up=validUpstream(raw.upstream,`${where}.upstream`,errors,previous?.upstream);if(up)out.upstream=up;}
 if(raw.source!==undefined){const source=validSource(raw.source,`${where}.source`,errors);if(source)out.source=source;}
 if(raw.inventory!==undefined&&need(Array.isArray(raw.inventory)&&raw.inventory.length<=10&&raw.inventory.every(x=>typeof x==='string'&&/^[a-z][a-z0-9-]{0,63}$/.test(x)),'inventory must list at most 10 inventory entry ids'))out.inventory=[...raw.inventory];
 return out;
}
/**
 * One item as the API accepts it → {item, errors}. item is a normalized copy (known fields only).
 * machines: ids a detect rule may name (the site's machines probed with the mac probe); null = any machine id.
 * categories: the category ids that exist; previous: the stored item it replaces, if any.
 */
export function validateItem(raw,{machines=null,categories=null,previous=null}={}){
 const errors=[];
 if(!plain(raw))return {item:null,errors:['item must be an object']};
 const extra=unknownKeys(raw,['id','name','category','scheme','match','upstream','detect']);
 if(extra.length)errors.push(`item has unknown field(s): ${extra.join(', ')}`);
 const item={};
 if(typeof raw.id==='string'&&ITEM_ID.test(raw.id))item.id=raw.id;else errors.push('id must be 1-40 characters: lowercase letters, digits, dot, underscore, hyphen');
 if(text(raw.name,80)&&raw.name.trim())item.name=raw.name;else errors.push('name must be 1-80 characters');
 if(typeof raw.category!=='string'||!CATEGORY_ID.test(raw.category)||RESERVED_CATEGORIES.includes(raw.category))errors.push('category must be a category id (lowercase letters, digits, hyphen); nas-apps and containers are reserved');
 else if(categories&&!categories.includes(raw.category))errors.push(`category "${raw.category}" does not exist: pass categories {"${raw.category}": "Label"} to create it${categories.length?` (existing: ${categories.join(', ')})`:''}`);
 else item.category=raw.category;
 if(raw.scheme!==undefined){if(VERSION_SCHEMES.includes(raw.scheme))item.scheme=raw.scheme;else errors.push(`scheme must be one of ${VERSION_SCHEMES.join(', ')} (or left out)`);}
 if(raw.match!==undefined){if(safePattern(raw.match))item.match=raw.match;else errors.push('match must be a simple regular expression of at most 200 characters');}
 const upstream=validUpstream(raw.upstream,'upstream',errors,previous?.upstream);if(upstream)item.upstream=upstream;
 if(!plain(raw.detect)||!Object.keys(raw.detect).length||Object.keys(raw.detect).length>WATCH_LIMITS.machinesPerItem)errors.push(`detect must map 1-${WATCH_LIMITS.machinesPerItem} machine ids to a detect rule`);
 else{item.detect={};
  for(const [machine,rule] of Object.entries(raw.detect)){
   if(!MACHINE_ID.test(machine)){errors.push(`detect: "${machine.slice(0,40)}" is not a machine id`);continue;}
   if(machines&&!machines.includes(machine)){errors.push(`detect.${machine}: no machine "${machine}" with ssh.probe "mac" in the site configuration${machines.length?` (known: ${machines.join(', ')})`:' (add machines[].ssh to local/site.json first)'}`);continue;}
   const detect=validDetect(rule,`detect.${machine}`,errors,previous?.detect?.[machine]);if(detect)item.detect[machine]=detect;
  }}
 return {item:errors.length?null:item,errors};
}
// A whole list as found on disk → problems worth telling its owner. Lenient on purpose: a hand-written
// file keeps working, and the collector prints these instead of refusing to run.
export function checkWatch(registry,{machines=null}={}){
 const errors=[],warnings=[];
 if(!plain(registry)||!Array.isArray(registry.items))return {errors:['the file must be an object with an items list'],warnings};
 if(registry.items.length>WATCH_LIMITS.items)errors.push(`more than ${WATCH_LIMITS.items} items`);
 const categories=Object.keys(plain(registry.categories)?registry.categories:{}),seen=new Set();
 for(const [i,raw] of registry.items.entries()){
  const id=typeof raw?.id==='string'?raw.id:`#${i}`;
  if(seen.has(id))errors.push(`${id}: duplicate id`);seen.add(id);
  // A stored thermo-feed upstream is checked against itself: it is allowed in the file.
  const r=validateItem(raw,{machines,categories,previous:raw});
  for(const e of r.errors)(/no machine "/.test(e)?warnings:errors).push(`${id}: ${e}`);
 }
 return {errors,warnings};
}

// --- reading -----------------------------------------------------------------------------------------
// → {source: 'local'|'none', file, registry}. A missing file is an empty list; a broken one throws
// (hiding every software row silently would be worse than an error that names the file).
export async function readWatch({file=watchPath()}={}){
 if(!file)return {source:'none',file:null,registry:emptyWatch()};
 let raw;try{raw=await readFile(file,'utf8');}catch(e){if(e.code==='ENOENT')return {source:'none',file,registry:emptyWatch()};throw new Error(`software watch list: cannot read ${file}: ${e.message}`);}
 let registry;try{registry=JSON.parse(raw);}catch(e){throw new Error(`software watch list: ${file} is not valid JSON: ${e.message}`);}
 if(!plain(registry)||!Array.isArray(registry.items))throw new Error(`software watch list: ${file} must be an object with an items list`);
 return {source:'local',file,registry:{...registry,categories:plain(registry.categories)?registry.categories:{}}};
}
// What the API and the MCP tool return: the list with a hash per item, and what a rule may contain.
export function describeWatch({source,registry},{machines=[]}={}){
 return {schemaVersion:WATCH_SCHEMA,source,categories:{...registry.categories},
  items:registry.items.map(item=>({...item,hash:itemHash(item)})),
  machines,detectKinds:[...DETECT_KINDS],upstreamTypes:UPSTREAM_TYPES.filter(t=>t!=='thermo-feed'),cmdArgs:[...CMD_ARGS],schemes:[...VERSION_SCHEMES],
  limits:{items:WATCH_LIMITS.items,categories:WATCH_LIMITS.categories}};
}

// --- writing -----------------------------------------------------------------------------------------
// The file keeps one item per line, so a change to one program is a one-line diff in the site's repository.
const spaced=v=>Array.isArray(v)?`[${v.map(spaced).join(', ')}]`:plain(v)?`{${Object.entries(v).map(([k,x])=>`${JSON.stringify(k)}: ${spaced(x)}`).join(', ')}}`:JSON.stringify(v);
export function formatWatch(registry){
 const {schemaVersion=WATCH_SCHEMA,about,categories={},items=[],...rest}=registry;
 const lines=[` "schemaVersion": ${JSON.stringify(schemaVersion)}`,...(about!==undefined?[` "about": ${JSON.stringify(about)}`]:[]),
  ...Object.entries(rest).map(([k,v])=>` ${JSON.stringify(k)}: ${spaced(v)}`),` "categories": ${spaced(categories)}`,
  ` "items": [${items.length?'\n'+items.map(item=>`  ${spaced(item)}`).join(',\n')+'\n ':''}]`];
 return `{\n${lines.join(',\n')}\n}\n`;
}
const ABOUT='Software this Home Hub watches for versions and update candidates. One upstream per item (where the newest version is read) and one detect rule per machine id from site.json (how the installed version is read there). config/software-watch.json is an annotated example; docs/API.md describes every field.';
class WatchError extends Error{constructor(code,details=[]){super(code);this.code=code;this.details=details;}}
export const isWatchError=e=>e instanceof WatchError;

/**
 * The one writer for a list file. put(change) applies one change and saves the file atomically:
 *   {item, base}      create (no base) or replace (base = the item's hash from the list) one item
 *   {remove, base}    delete the item with this id
 *   {categories}      add or relabel categories, alone or together with an item
 * Throws WatchError: invalid (details = messages), conflict, not-found, limit, unavailable (a hub
 * without a site overlay has no file to keep a list in). machines() names the
 * machine ids a rule may use.
 */
export function createWatchStore({file=watchPath(),machines=()=>null}={}){
 let queue=Promise.resolve();
 const serial=fn=>{const run=queue.then(fn,fn);queue=run.catch(()=>{});return run;};
 async function apply(change){
  if(!plain(change)||unknownKeys(change,['item','base','remove','categories']).length||(change.item!==undefined&&change.remove!==undefined))throw new WatchError('invalid',['pass item (to create or replace), remove (an id) or categories; item and remove exclude each other']);
  if(change.item===undefined&&change.remove===undefined&&change.categories===undefined)throw new WatchError('invalid',['nothing to change: pass item, remove or categories']);
  if(!file)throw new WatchError('unavailable');
  if(change.base!==undefined&&(typeof change.base!=='string'||!/^[a-f0-9]{64}$/.test(change.base)))throw new WatchError('invalid',['base must be the 64-character hash of the item from the list']);
  const current=await readWatch({file}),registry={...current.registry,items:[...current.registry.items],categories:{...current.registry.categories}};
  if(current.source==='none')registry.about=ABOUT;
  if(change.categories!==undefined){
   const entries=plain(change.categories)?Object.entries(change.categories):null;
   if(!entries||entries.some(([id,label])=>!CATEGORY_ID.test(id)||RESERVED_CATEGORIES.includes(id)||!text(label,60)||!String(label).trim()))throw new WatchError('invalid',['categories must map a category id (lowercase letters, digits, hyphen; not nas-apps or containers) to a label of at most 60 characters']);
   for(const [id,label] of entries)registry.categories[id]=label;
   if(Object.keys(registry.categories).length>WATCH_LIMITS.categories)throw new WatchError('limit',[`at most ${WATCH_LIMITS.categories} categories`]);
  }
  let result={ok:true};
  if(change.remove!==undefined){
   const at=registry.items.findIndex(i=>i.id===change.remove);
   if(typeof change.remove!=='string'||at<0)throw new WatchError('not-found');
   if(change.base!==itemHash(registry.items[at]))throw new WatchError('conflict');
   registry.items.splice(at,1);result={ok:true,id:change.remove,removed:true,hash:null};
  }else if(change.item!==undefined){
   const at=registry.items.findIndex(i=>i.id===change.item?.id),previous=at>=0?registry.items[at]:null;
   const {item,errors}=validateItem(change.item,{machines:machines(),categories:Object.keys(registry.categories),previous});
   if(errors.length)throw new WatchError('invalid',errors.slice(0,20));
   // A replace needs the hash it was read with; a create must not name a hash or an id that exists.
   if(previous?change.base!==itemHash(previous):change.base!==undefined)throw new WatchError('conflict');
   if(previous)registry.items[at]=item;else registry.items.push(item);
   if(registry.items.length>WATCH_LIMITS.items)throw new WatchError('limit',[`at most ${WATCH_LIMITS.items} items`]);
   result={ok:true,id:item.id,created:!previous,hash:itemHash(item)};
  }
  const body=formatWatch(registry);
  if(Buffer.byteLength(body)>WATCH_LIMITS.bytes)throw new WatchError('limit',[`the list may be at most ${WATCH_LIMITS.bytes} bytes`]);
  await mkdir(path.dirname(file),{recursive:true});
  const tmp=`${file}.${process.pid}.tmp`;await writeFile(tmp,body,{mode:0o644});await rename(tmp,file);
  return {...result,items:registry.items.length,categories:{...registry.categories}};
 }
 return {file,read:()=>readWatch({file}),put:change=>serial(()=>apply(change))};
}
