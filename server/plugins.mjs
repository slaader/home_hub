// Module registry: the one contract core features and plugins both use to add to the hub.
// A module is a plain object (docs/plugins.md):
//   {id, scopes, routes:[{method,path|match,scope,handler,…}], mcpTools, mcpInstructions, pollers, assets, nav, strings, provides, integrations, setup}
// Core modules live in server/core/; plugins are loaded from one or more plugin directories, by default
// local/plugins/*/index.mjs (HOME_HUB_PLUGINS_DIR, or HOME_HUB_HOME's instance.json, chooses others; "none" loads
// nothing). Each plugin may carry a static plugin.json (its version, the core range it supports, the plugins it
// needs); it is checked before index.mjs runs. Core never imports from a plugin: a plugin reaches core only through
// this registry and the named exports home-hub/plugin-api and home-hub/testing.
// Everything is validated when the registry is built, and a clash (two modules claiming one route,
// scope, page hash, tool, asset or integration id) is a start-up error naming both modules. Nothing is merged silently.
import {readdirSync,existsSync,readFileSync,realpathSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {repoRoot} from './edition.mjs';
import {defineIntegrations} from './integrations.mjs';
import {readPackage} from './version.mjs';
import {parse as parseVersion,validRange,satisfies} from './semver.mjs';
import {parseService,parseHealth,parseBackups,UpdateConfigError} from './update-config.mjs';

export const MODULE_ID=/^[a-z][a-z0-9-]{1,31}$/;
// The version of this core (package.json → version): what a plugin's core range is checked against.
export const CORE_VERSION=readPackage().version;
const SCOPE_ID=/^[a-z][a-z0-9-]{0,31}(:[a-z][a-z0-9-]{0,31})?$/;
const HASH=/^[a-z][a-z0-9-]{0,39}$/;
const TOOL=/^[a-z][a-z0-9_]{1,63}$/;
const METHODS=['GET','POST','PUT'];
const ASSET_TYPES={'.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.html':'text/html','.webmanifest':'application/manifest+json','.mp3':'audio/mpeg'};
const plain=v=>v&&typeof v==='object'&&!Array.isArray(v);
const fn=v=>typeof v==='function';

class ModuleError extends Error{}
const bad=(id,message)=>{throw new ModuleError(`module "${id}": ${message}`);};

// One module → a normalized, frozen copy. core:true marks modules shipped in server/core/.
// manifest: the plugin's plugin.json as readPluginManifest returns it (null: none, or a core module).
export function defineModule(raw,{core=false,directory=null,manifest=null}={}){
 if(!plain(raw)||typeof raw.id!=='string'||!MODULE_ID.test(raw.id))throw new ModuleError(`a module needs an id matching ${MODULE_ID} (got ${JSON.stringify(raw?.id)})`);
 const id=raw.id,known=['id','title','scopes','routes','mcpTools','mcpInstructions','pollers','assets','nav','strings','apiDocs','provides','integrations','setup'];
 const extra=Object.keys(raw).filter(k=>!known.includes(k));if(extra.length)bad(id,`unknown field(s): ${extra.join(', ')}`);
 const scopes={};
 for(const [scope,meta] of Object.entries(raw.scopes??{})){
  if(!SCOPE_ID.test(scope))bad(id,`scope id "${scope}" is not valid`);
  if(!plain(meta)||typeof meta.label!=='string'||!meta.label||typeof meta.desc!=='string')bad(id,`scope "${scope}" needs {label, desc}`);
  scopes[scope]=Object.freeze({label:meta.label,desc:meta.desc,...(meta.readOnly===true?{readOnly:true}:{}),...(meta.legacy===false?{legacy:false}:{})});
 }
 const routes=(raw.routes??[]).map((r,i)=>{
  const where=`routes[${i}]`;
  if(!plain(r)||!METHODS.includes(r.method))bad(id,`${where}.method must be one of ${METHODS.join(', ')}`);
  if((typeof r.path==='string')===(r.match instanceof RegExp))bad(id,`${where} needs exactly one of path (string) or match (RegExp)`);
  if(typeof r.path==='string'&&!/^\/[A-Za-z0-9._~/-]*$/.test(r.path))bad(id,`${where}.path "${r.path}" is not a plain URL path`);
  if(r.match&&(r.match.global||r.match.sticky))bad(id,`${where}.match must not use the g or y flag`);
  if(!fn(r.handler))bad(id,`${where}.handler must be a function`);
  const extraKeys=Object.keys(r).filter(k=>!['method','path','match','scope','handler','public','write','session','head','raw','contentType','bodyLimit','parse','denied','error'].includes(k));
  if(extraKeys.length)bad(id,`${where} has unknown field(s): ${extraKeys.join(', ')}`);
  // scope: what an API key needs. GET defaults to "read"; a write route must say it (null = never with a key).
  if(r.method!=='GET'&&r.scope===undefined)bad(id,`${where} (${r.method} ${r.path??r.match}) must declare scope (a scope id, or null for password sign-in only)`);
  const scope=r.scope===undefined?'read':r.scope;
  if(scope!==null&&(typeof scope!=='string'||!SCOPE_ID.test(scope)))bad(id,`${where}.scope must be a scope id or null`);
  if(r.raw&&r.method!=='PUT')bad(id,`${where}: raw uploads are PUT routes`);
  if(r.method==='PUT'&&!r.raw)bad(id,`${where}: PUT routes are raw uploads (raw:true with a contentType)`);
  if(r.raw&&typeof r.contentType!=='string')bad(id,`${where}: a raw upload needs contentType`);
  if(r.head&&r.method!=='GET')bad(id,`${where}: head applies to GET routes`);
  if(r.bodyLimit!==undefined&&(!Number.isSafeInteger(r.bodyLimit)||r.bodyLimit<1||r.bodyLimit>1048576))bad(id,`${where}.bodyLimit must be 1..1048576 bytes`);
  if(r.error!==undefined&&!fn(r.error))bad(id,`${where}.error must be a function`);
  return Object.freeze({module:id,method:r.method,path:r.path??null,match:r.match??null,scope,handler:r.handler,
   public:r.public===true,session:r.session===true,head:r.head===true,raw:r.raw===true,contentType:r.contentType??null,
   // write: the caller needs write permission. Default: every non-GET route whose scope is not "read".
   write:r.write===undefined?(r.method!=='GET'&&scope!=='read'):r.write===true,
   bodyLimit:r.bodyLimit??16384,parse:r.parse!==false,denied:r.denied??null,error:r.error??null});
 });
 const mcpTools=(raw.mcpTools??[]).map((tool,i)=>{
  const where=`mcpTools[${i}]`;
  if(!plain(tool)||typeof tool.name!=='string'||!TOOL.test(tool.name))bad(id,`${where}.name must match ${TOOL}`);
  if(typeof tool.scope!=='string'||!SCOPE_ID.test(tool.scope))bad(id,`${where} (${tool.name}) needs a scope`);
  if(typeof tool.description!=='string'||!tool.description||!plain(tool.inputSchema)||tool.inputSchema.type!=='object')bad(id,`${where} (${tool.name}) needs a description and an object inputSchema`);
  if(!fn(tool.run))bad(id,`${where} (${tool.name}) needs run(args, context)`);
  return Object.freeze({...tool,module:id});
 });
 // Orientation for agents: this module's lines in the MCP initialize instructions (server/mcp.mjs). One short
 // text, or parts [{text, scope?}]; a part that names a scope is said only to keys that hold it.
 const instructionParts=raw.mcpInstructions===undefined?[]:Array.isArray(raw.mcpInstructions)?raw.mcpInstructions:[raw.mcpInstructions];
 if(instructionParts.length>6)bad(id,'mcpInstructions takes at most 6 parts');
 const mcpInstructions=instructionParts.map((part,i)=>{
  const p=typeof part==='string'?{text:part}:part,where=`mcpInstructions[${i}]`;
  if(!plain(p)||typeof p.text!=='string'||!p.text.trim()||p.text.length>600||/[\u0000-\u001f]/.test(p.text))bad(id,`${where} needs a text of 1 to 600 characters on one line`);
  const extraKeys=Object.keys(p).filter(k=>!['text','scope'].includes(k));if(extraKeys.length)bad(id,`${where} has unknown field(s): ${extraKeys.join(', ')}`);
  if(p.scope!==undefined&&(typeof p.scope!=='string'||!SCOPE_ID.test(p.scope)))bad(id,`${where}.scope must be a scope id`);
  return Object.freeze({module:id,text:p.text.trim(),scope:p.scope??null});
 });
 const pollers=(raw.pollers??[]).map((p,i)=>{
  if(!plain(p)||typeof p.id!=='string'||!fn(p.start))bad(id,`pollers[${i}] needs {id, start(state, hub)} and optionally stop`);
  if(p.stop!==undefined&&!fn(p.stop))bad(id,`pollers[${i}].stop must be a function`);
  return Object.freeze({module:id,id:p.id,start:p.start,stop:p.stop??null});
 });
 // Assets: core modules serve from public/ at /<path>; a plugin serves from <plugin>/public/ at /plugins/<id>/<path>.
 const assets=(raw.assets??[]).map((a,i)=>{
  const entry=typeof a==='string'?{path:a}:a;
  if(!plain(entry)||typeof entry.path!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(entry.path)||entry.path.split('/').some(s=>s==='..'||s==='.'||s===''))bad(id,`assets[${i}] needs a relative path without "..": ${JSON.stringify(entry?.path)}`);
  const type=entry.type??ASSET_TYPES[path.extname(entry.path).toLowerCase()];
  if(typeof type!=='string')bad(id,`assets[${i}] (${entry.path}): unknown file type, set type`);
  if(entry.url!==undefined&&(!core||typeof entry.url!=='string'||!entry.url.startsWith('/')))bad(id,`assets[${i}].url is for core modules only`);
  const url=core?(entry.url??'/'+entry.path):`/plugins/${id}/${entry.path}`;
  const file=entry.file??entry.path,base=core?path.join(repoRoot,'public'):directory;
  if(base&&!existsSync(path.join(base,file)))bad(id,`assets[${i}]: ${path.join(base,file)} does not exist`);
  return Object.freeze({module:id,url,file,type,directory:core?null:directory});
 });
 const nav=(raw.nav??[]).map((n,i)=>{
  const where=`nav[${i}]`;
  if(!plain(n))bad(id,`${where} must be an object`);
  const extraKeys=Object.keys(n).filter(k=>!['group','groupKey','hash','label','labelKey','view','admin','scope','hidden','soon','order','hashes','icon'].includes(k));
  if(extraKeys.length)bad(id,`${where} has unknown field(s): ${extraKeys.join(', ')}`);
  if(typeof n.label!=='string'&&typeof n.labelKey!=='string')bad(id,`${where} needs label or labelKey`);
  // icon: the entry's mark in the sidebar: an icon name from public/icons.js, or a short glyph. Optional.
  if(n.icon!==undefined&&(typeof n.icon!=='string'||!n.icon||n.icon.length>24||/[\u0000-\u001f<>]/.test(n.icon)))bad(id,`${where}.icon must be an icon name or a short glyph`);
  if(n.scope!==undefined&&(typeof n.scope!=='string'||!SCOPE_ID.test(n.scope)))bad(id,`${where}.scope must be a scope id`);
  if(n.soon===true){if(n.hash!==undefined||n.view!==undefined)bad(id,`${where}: a "soon" entry has no hash or view`);}
  else{
   if(typeof n.hash!=='string'||!HASH.test(n.hash))bad(id,`${where}.hash must match ${HASH}`);
   if(typeof n.view!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._/-]*\.js(#[A-Za-z_$][\w$]*)?$/.test(n.view))bad(id,`${where}.view must be "<asset>.js#exportName" (an asset of this module)`);
   if(n.hidden!==true&&typeof n.group!=='string'&&typeof n.groupKey!=='string')bad(id,`${where} needs group or groupKey (or hidden:true)`);
  }
  const [file,exportName='default']=(n.view??'').split('#');
  if(n.view&&!assets.some(a=>a.file===file||a.url.endsWith('/'+file)))bad(id,`${where}.view "${file}" is not listed in this module's assets`);
  return Object.freeze({module:id,group:n.group??null,groupKey:n.groupKey??null,hash:n.hash??null,label:n.label??null,labelKey:n.labelKey??null,
   view:n.view?{url:assets.find(a=>a.file===file||a.url.endsWith('/'+file)).url,export:exportName}:null,
   admin:n.admin===true,scope:n.scope??null,hidden:n.hidden===true,soon:n.soon===true,order:Number.isFinite(n.order)?n.order:100,icon:n.icon??null});
 });
 const strings={};
 for(const [lang,dict] of Object.entries(raw.strings??{})){if(!plain(dict)||Object.values(dict).some(v=>typeof v!=='string'))bad(id,`strings.${lang} must map source text to a translation`);strings[lang]=Object.freeze({...dict});}
 // Rows for the API reference on the access page: [{title, routes:[[method, path, who, description]]}]; who is a scope id or "read".
 const apiDocs=(raw.apiDocs??[]).map((d,i)=>{
  if(!plain(d)||typeof d.title!=='string'||!Array.isArray(d.routes)||d.routes.some(r=>!Array.isArray(r)||r.length!==4||r.some(c=>typeof c!=='string')))bad(id,`apiDocs[${i}] needs {title, routes:[[method, path, who, description]]}`);
  return Object.freeze({title:d.title,routes:Object.freeze(d.routes.map(r=>Object.freeze([...r])))});
 });
 const provides={};
 for(const [name,provider] of Object.entries(raw.provides??{})){if(!fn(provider))bad(id,`provides.${name} must be a function (state, hub) => value`);provides[name]=provider;}
 if(raw.setup!==undefined&&!fn(raw.setup))bad(id,'setup must be a function (hub) => state');
 // Integrations (server/integrations.mjs, docs/plugins.md → Integrations): what this module reads from
 // outside, its health, and whether an administrator may turn it off. Ids are "<module id>.<name>".
 const integrations=defineIntegrations(raw.integrations,id,message=>bad(id,message));
 for(const i of integrations)for(const name of i.provides)if(!provides[name])bad(id,`integration ${i.id} lists provides "${name}", which this module does not provide`);
 // version and source: a core module has the core's; a plugin its plugin.json's (null without one).
 const version=core?CORE_VERSION:manifest?.version??null,source=core?'core':manifest?.source??null;
 return Object.freeze({id,core,directory,version,source,plugin:manifest,title:typeof raw.title==='string'?raw.title:id,scopes:Object.freeze(scopes),routes:Object.freeze(routes),mcpTools:Object.freeze(mcpTools),mcpInstructions:Object.freeze(mcpInstructions),
  pollers:Object.freeze(pollers),assets:Object.freeze(assets),nav:Object.freeze(nav),strings:Object.freeze(strings),apiDocs:Object.freeze(apiDocs),provides:Object.freeze(provides),integrations,setup:raw.setup??null});
}

// All modules together. Throws on any clash; the message names both sides.
// reservedTools: MCP tool names already taken (the core tools defined in server/mcp.mjs).
export function createRegistry(modules,{reservedTools=[]}={}){
 const byId=new Map(),scopes=new Map(),tools=new Map(),assets=new Map(),hashes=new Map(),exact=new Map(),patterns=[],integrations=new Map();
 const clash=(what,a,b)=>{throw new ModuleError(`${what} is registered twice: by module "${a}" and by module "${b}"`);};
 for(const m of modules){
  if(byId.has(m.id))clash(`module id "${m.id}"`,m.id,m.id);byId.set(m.id,m);
  for(const [id,meta] of Object.entries(m.scopes)){if(scopes.has(id))clash(`scope "${id}"`,scopes.get(id).module,m.id);scopes.set(id,{...meta,module:m.id});}
  for(const t of m.mcpTools){if(reservedTools.includes(t.name))clash(`MCP tool "${t.name}"`,'core',m.id);if(tools.has(t.name))clash(`MCP tool "${t.name}"`,tools.get(t.name).module,m.id);tools.set(t.name,t);}
  for(const a of m.assets){if(assets.has(a.url))clash(`asset ${a.url}`,assets.get(a.url).module,m.id);assets.set(a.url,a);}
  for(const n of m.nav)if(n.hash){if(hashes.has(n.hash))clash(`page #${n.hash}`,hashes.get(n.hash).module,m.id);hashes.set(n.hash,n);}
  for(const i of m.integrations??[]){if(integrations.has(i.id))clash(`integration "${i.id}"`,integrations.get(i.id).module,m.id);integrations.set(i.id,i);}
  for(const r of m.routes){
   if(r.path){const key=`${r.method} ${r.path}`;if(exact.has(key))clash(`route ${key}`,exact.get(key).module,m.id);exact.set(key,r);}
   else{const same=patterns.find(p=>p.method===r.method&&p.match.source===r.match.source&&p.match.flags===r.match.flags);if(same)clash(`route ${r.method} ${r.match}`,same.module,m.id);patterns.push(r);}
  }
 }
 // A scope used by a route or tool must be defined by some module (plugins may use core scopes and each other's).
 for(const m of modules){
  for(const r of m.routes)if(r.scope!==null&&!scopes.has(r.scope))bad(m.id,`route ${r.method} ${r.path??r.match} uses scope "${r.scope}", which no module defines`);
  for(const t of m.mcpTools)if(!scopes.has(t.scope))bad(m.id,`MCP tool ${t.name} uses scope "${t.scope}", which no module defines`);
  for(const n of m.nav)if(n.scope&&!scopes.has(n.scope))bad(m.id,`page #${n.hash} uses scope "${n.scope}", which no module defines`);
  for(const p of m.mcpInstructions)if(p.scope&&!scopes.has(p.scope))bad(m.id,`mcpInstructions uses scope "${p.scope}", which no module defines`);
 }
 // An exact path wins over a pattern; patterns are tried in registration order (core first).
 const match=(method,pathname)=>{
  const hit=exact.get(`${method} ${pathname}`);if(hit)return {route:hit,params:null};
  for(const r of patterns)if(r.method===method){const params=r.match.exec(pathname);if(params)return {route:r,params};}
  return null;
 };
 const nav=modules.flatMap(m=>m.nav);
 return Object.freeze({
  modules:[...byId.values()],module:id=>byId.get(id)||null,scopes,tools:[...tools.values()],instructions:modules.flatMap(m=>m.mcpInstructions),assets,nav,match,
  routes:modules.flatMap(m=>m.routes),pollers:modules.flatMap(m=>m.pollers),
  // Every integration in registration order (core first); integration(id) finds one.
  integrations:[...integrations.values()],integration:id=>integrations.get(id)||null,
  providers:name=>modules.filter(m=>m.provides[name]).map(m=>({module:m.id,provide:m.provides[name]})),
  // What the browser needs to draw the shell for this caller: pages it may open and the sidebar.
  manifest(me){
   // A restricted entry (admin:true, or one that names a scope) is open to administrators, and to anyone
   // whose role holds its scope. In the reply, admin:true marks a page this caller may not open.
   const admin=me?.role==='admin',open=n=>(!n.admin&&!n.scope)||admin||Boolean(n.scope&&me?.scopes?.includes(n.scope)),visible=nav.filter(open);
   const groups=[];
   for(const n of visible.filter(n=>!n.hidden).sort((a,b)=>a.order-b.order)){
    const key=n.groupKey??n.group;let g=groups.find(x=>x.key===key);
    if(!g)groups.push(g={key,label:n.group,labelKey:n.groupKey,items:[]});
    g.items.push({hash:n.hash,label:n.label,labelKey:n.labelKey,soon:n.soon,module:n.module,...(n.icon?{icon:n.icon}:{})});
   }
   return {pages:nav.filter(n=>n.hash).map(n=>({hash:n.hash,admin:!open(n),module:n.module,...(open(n)?{view:n.view}:{})})),
    nav:groups.map(({key,...g})=>g),
    modules:modules.map(m=>({id:m.id,core:m.core,title:m.title,...(m.version?{version:m.version,source:m.source}:{})})),
    apiDocs:modules.flatMap(m=>m.apiDocs),
    strings:modules.reduce((all,m)=>{for(const [lang,dict] of Object.entries(m.strings))all[lang]={...all[lang],...dict};return all;},{})};
  },
 });
}

// --- where plugins come from -----------------------------------------------------------------------------------
// The plugin directories, in this order of choice (docs/plugins.md → Where plugins are):
//   HOME_HUB_PLUGINS_DIR           one or more directories, separated by path.delimiter (":" here); "none" = none
//   HOME_HUB_HOME/instance.json    {"sources":{"plugins":["household", …]}} → <home>/household/plugins, …
//                                  (the same file tells the update command where core is and how the service is
//                                  stopped, started and checked: sources.core, service, health, backups)
//   <root>/local/plugins           the overlay inside the core checkout (deprecated in 1.2, removed in 2.0)
// Every directory holds <id>/index.mjs per plugin; ids are unique across all of them.
export const INSTANCE_FILE='instance.json';
const SOURCE_NAME=/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// <home>/instance.json, or null when there is none. A file that is there but wrong stops the start, naming the field.
export function readInstance(home){
 const file=path.join(home,INSTANCE_FILE);
 let text;try{text=readFileSync(file,'utf8');}catch(e){if(e.code==='ENOENT')return null;throw new ModuleError(`instance: cannot read ${file}: ${e.message}`);}
 let raw;try{raw=JSON.parse(text);}catch(e){throw new ModuleError(`instance: ${file} is not valid JSON: ${e.message}`);}
 const no=message=>{throw new ModuleError(`instance: ${file}: ${message}`);};
 if(!plain(raw))no('must be an object');
 const extra=Object.keys(raw).filter(k=>!['$comment','schemaVersion','sources','service','health','backups'].includes(k));if(extra.length)no(`unknown field(s): ${extra.join(', ')}`);
 if(raw.schemaVersion!==undefined&&raw.schemaVersion!==1)no('schemaVersion must be 1');
 const sources=raw.sources??{};if(!plain(sources))no('sources must be an object');
 const extraSources=Object.keys(sources).filter(k=>k!=='plugins'&&k!=='core');if(extraSources.length)no(`sources has unknown field(s): ${extraSources.join(', ')}`);
 const sourceName=n=>typeof n==='string'&&SOURCE_NAME.test(n)&&n!=='.'&&n!=='..';
 if(sources.core!==undefined&&!sourceName(sources.core))no(`sources.core must be the name of a directory in ${home}`);
 let plugins=null;
 if(sources.plugins!==undefined){
  if(!Array.isArray(sources.plugins)||sources.plugins.length>16)no('sources.plugins must be a list of at most 16 directory names');
  plugins=sources.plugins.map((n,i)=>sourceName(n)?n:no(`sources.plugins[${i}] must be the name of a directory in ${home}`));
  if(new Set(plugins).size!==plugins.length)no('sources.plugins names a directory twice');
 }
 if(plugins&&sources.core!==undefined&&plugins.includes(sources.core))no('sources.core is also named in sources.plugins');
 // What the update command needs (scripts/update.mjs, docs/updating.md); the server only checks that it is well formed.
 const part=(read,value)=>{if(value===undefined)return null;try{return read(value);}catch(e){if(e instanceof UpdateConfigError)no(e.message);throw e;}};
 const service=part(v=>parseService(v).spec,raw.service),health=part(parseHealth,raw.health),backups=part(parseBackups,raw.backups);
 return Object.freeze({schemaVersion:1,sources:Object.freeze({core:sources.core??null,plugins:plugins&&Object.freeze(plugins)}),service,health,backups});
}
export function pluginsDirectories(env=process.env,root=repoRoot){
 const chosen=env.HOME_HUB_PLUGINS_DIR;
 if(chosen==='none')return [];
 if(chosen)return [...new Set(chosen.split(path.delimiter).filter(Boolean).map(d=>path.resolve(d)))];
 if(env.HOME_HUB_HOME){
  const home=path.resolve(env.HOME_HUB_HOME),instance=readInstance(home);
  if(instance?.sources.plugins)return instance.sources.plugins.map(name=>path.join(home,name,'plugins'));
 }
 return [path.join(root,'local','plugins')];
}
// The first plugin directory, or null (older callers; the list is pluginsDirectories).
export const pluginsDirectory=(env=process.env,root=repoRoot)=>pluginsDirectories(env,root)[0]??null;

// --- plugin sources and the link to core -----------------------------------------------------------------------
// A plugin source is the directory a plugins/ directory sits in, when it has a package.json of its own (not core's):
// {"name", "version", "homeHub": {"core": "<range>"}}. Its version is the version of plugins that state none, and
// homeHub.core their core range. A plugins directory without one (local/plugins) has no source package.
export function pluginSource(directory,root=repoRoot){
 const base=path.dirname(path.resolve(directory)),file=path.join(base,'package.json');
 if(!existsSync(file))return null;
 try{if(realpathSync(file)===realpathSync(path.join(root,'package.json')))return null;}catch{}
 const no=message=>{throw new ModuleError(`plugin source ${base}: ${message}`);};
 let raw;try{raw=JSON.parse(readFileSync(file,'utf8'));}catch(e){no(`package.json is not valid JSON: ${e.message}`);}
 if(!plain(raw))no('package.json must be an object');
 if(raw.version!==undefined&&!parseVersion(raw.version))no(`package.json → version must be a semver such as 1.0.0 (got ${JSON.stringify(raw.version)})`);
 const own=raw.homeHub===undefined?{}:plain(raw.homeHub)?raw.homeHub:no('package.json → homeHub must be an object');
 if(own.core!==undefined&&!validRange(own.core))no(`package.json → homeHub.core is not a version range: ${JSON.stringify(own.core)}`);
 return Object.freeze({name:typeof raw.name==='string'&&raw.name?raw.name:path.basename(base),version:raw.version??null,core:own.core??null,directory:base});
}
// Which core a plugin in this directory gets when it imports 'home-hub/…': the real path of that core's package.json,
// or null when the name does not resolve from there (no link, outside the core tree).
// Node's own order, done by hand so nothing is cached: the package's self-reference (the nearest package.json above is
// core's, named home-hub, with exports), then node_modules/home-hub in each directory above.
export function coreSeenFrom(directory){
 const start=path.resolve(directory),up=[];
 for(let d=start;;d=path.dirname(d)){up.push(d);if(path.dirname(d)===d)break;}
 const scope=up.find(d=>existsSync(path.join(d,'package.json')));
 if(scope){try{const own=JSON.parse(readFileSync(path.join(scope,'package.json'),'utf8'));if(own?.name==='home-hub'&&own.exports)return realpathSync(path.join(scope,'package.json'));}catch{}}
 for(const d of up){if(path.basename(d)==='node_modules')continue;const file=path.join(d,'node_modules','home-hub','package.json');if(existsSync(file))return realpathSync(file);}
 return null;
}
const linkCommand=directory=>`node scripts/plugins.mjs link --plugins ${directory}`;
// Two copies of core in one process would each keep their own state: a plugin that would import another core is refused.
export function checkCoreLink(directory,root=repoRoot){
 const seen=coreSeenFrom(directory);if(!seen)return null;
 const own=realpathSync(path.join(root,'package.json'));
 if(seen!==own)throw new ModuleError(`plugins in ${directory} would import another Home Hub core (${path.dirname(seen)}), not this one (${root}). Point the link at this core: ${linkCommand(directory)}`);
 return seen;
}

// --- plugin.json -----------------------------------------------------------------------------------------------
// Static facts about a plugin, read before any of its code runs (docs/plugins.md → plugin.json):
//   {"id", "version", "title", "core": "<range>", "requires": {"<plugin id>": "<range>"}, "dataEpoch",
//    "config": {"required": ["<key of site.json → plugins.<id>>", …]},
//    "hostAgents": [{"id", "title", "entry", "service", "health": {"socket", "get"}}]}
export const MANIFEST_FILE='plugin.json';
export const AGENT_SERVICES=Object.freeze(['launchd-agent','launchd-daemon','systemd-user']);
const MANIFEST_FIELDS=['$comment','id','version','title','core','requires','dataEpoch','config','hostAgents'];
const AGENT_FIELDS=['id','title','entry','service','health','config'];
const RELATIVE=/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const relative=v=>typeof v==='string'&&RELATIVE.test(v)&&!v.split('/').some(s=>s==='..'||s==='.'||s==='');
const CONFIG_KEY=/^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
/** <directory>/<name>/plugin.json, normalized and frozen, or null when the plugin has none. Throws naming the field. */
export function readPluginManifest(directory,name,{source=pluginSource(directory)}={}){
 const dir=path.join(directory,name),file=path.join(dir,MANIFEST_FILE);
 let text;try{text=readFileSync(file,'utf8');}catch(e){if(e.code==='ENOENT')return null;throw new ModuleError(`plugin "${name}": cannot read ${file}: ${e.message}`);}
 const no=message=>{throw new ModuleError(`plugin "${name}": ${MANIFEST_FILE}: ${message}`);};
 let raw;try{raw=JSON.parse(text);}catch(e){no(`not valid JSON: ${e.message}`);}
 if(!plain(raw))no('must be an object');
 const extra=Object.keys(raw).filter(k=>!MANIFEST_FIELDS.includes(k));if(extra.length)no(`unknown field(s): ${extra.join(', ')}`);
 if(raw.id!==name)no(`id is ${JSON.stringify(raw.id)}; it must equal the directory name "${name}"`);
 if(raw.version!==undefined&&!parseVersion(raw.version))no(`version must be a semver such as 1.0.0 (got ${JSON.stringify(raw.version)})`);
 const version=raw.version??source?.version??no('version is missing (and the plugin source has no package.json version)');
 if(raw.title!==undefined&&(typeof raw.title!=='string'||!raw.title.trim()||raw.title.length>80||/[\u0000-\u001f]/.test(raw.title)))no('title must be a text of 1 to 80 characters');
 if(raw.core!==undefined&&!validRange(raw.core))no(`core is not a version range: ${JSON.stringify(raw.core)}`);
 const core=raw.core??source?.core??no('core is missing: the range of Home Hub versions this plugin supports, such as ">=1.2.0 <2.0.0"');
 const requires={};
 if(raw.requires!==undefined){
  if(!plain(raw.requires))no('requires must be an object: {"<plugin id>": "<range>"}');
  for(const [id,range] of Object.entries(raw.requires)){
   if(!MODULE_ID.test(id))no(`requires names "${id}", which is not a plugin id`);
   if(id===name)no('requires names the plugin itself');
   if(!validRange(range))no(`requires.${id} is not a version range: ${JSON.stringify(range)}`);
   requires[id]=range;
  }
 }
 if(raw.dataEpoch!==undefined&&(!Number.isSafeInteger(raw.dataEpoch)||raw.dataEpoch<1))no('dataEpoch must be a positive integer');
 let required=[];
 if(raw.config!==undefined){
  if(!plain(raw.config))no('config must be an object: {"required": ["<key>", …]}');
  const extraConfig=Object.keys(raw.config).filter(k=>k!=='required');if(extraConfig.length)no(`config has unknown field(s): ${extraConfig.join(', ')}`);
  if(raw.config.required!==undefined&&(!Array.isArray(raw.config.required)||raw.config.required.length>32||raw.config.required.some(k=>typeof k!=='string'||!CONFIG_KEY.test(k))))no('config.required must be a list of keys of site.json → plugins.<id>');
  required=[...new Set(raw.config.required??[])];
 }
 const hostAgents=(raw.hostAgents===undefined?[]:Array.isArray(raw.hostAgents)&&raw.hostAgents.length<=8?raw.hostAgents:no('hostAgents must be a list of at most 8 agents')).map((a,i)=>{
  const where=`hostAgents[${i}]`;
  if(!plain(a))no(`${where} must be an object`);
  const extraAgent=Object.keys(a).filter(k=>!AGENT_FIELDS.includes(k));if(extraAgent.length)no(`${where} has unknown field(s): ${extraAgent.join(', ')}`);
  if(typeof a.id!=='string'||!MODULE_ID.test(a.id))no(`${where}.id must match ${MODULE_ID}`);
  if(a.title!==undefined&&(typeof a.title!=='string'||!a.title.trim()||a.title.length>80))no(`${where}.title must be a text of 1 to 80 characters`);
  if(!relative(a.entry)||!/\.m?js$/.test(a.entry))no(`${where}.entry must be a .mjs file inside the plugin, as a relative path without ".."`);
  if(!existsSync(path.join(dir,a.entry)))no(`${where}.entry ${a.entry} does not exist`);
  if(!AGENT_SERVICES.includes(a.service))no(`${where}.service must be one of ${AGENT_SERVICES.join(', ')}`);
  let health=null;
  if(a.health!==undefined){
   if(!plain(a.health))no(`${where}.health must be an object: {"socket", "get"}`);
   const extraHealth=Object.keys(a.health).filter(k=>!['socket','get'].includes(k));if(extraHealth.length)no(`${where}.health has unknown field(s): ${extraHealth.join(', ')}`);
   if(a.health.socket!==undefined&&!relative(a.health.socket))no(`${where}.health.socket must be a path relative to the agent's directory, without ".."`);
   if(a.health.get!==undefined&&(typeof a.health.get!=='string'||!/^\/[A-Za-z0-9._~/-]{0,199}$/.test(a.health.get)))no(`${where}.health.get must be a URL path such as /status`);
   health=Object.freeze({socket:a.health.socket??null,get:a.health.get??null});
  }
  // config: a module of the plugin whose default export ({site, machine}) => object is what the agent needs to know;
  // the installer writes it to <target>/config/<agent id>.json.
  if(a.config!==undefined&&(!relative(a.config)||!/\.m?js$/.test(a.config)||!existsSync(path.join(dir,a.config))))no(`${where}.config must be a .mjs module inside the plugin that exists`);
  return Object.freeze({id:a.id,title:a.title??a.id,entry:a.entry,service:a.service,health,config:a.config??null});
 });
 if(new Set(hostAgents.map(a=>a.id)).size!==hostAgents.length)no('hostAgents lists an id twice');
 return Object.freeze({id:name,version:parseVersion(version).text,title:raw.title??null,core,requires:Object.freeze(requires),dataEpoch:raw.dataEpoch??null,
  config:Object.freeze({required:Object.freeze(required)}),hostAgents:Object.freeze(hostAgents),
  source:source?.name??path.basename(path.dirname(path.resolve(directory))),sourceDirectory:source?.directory??path.dirname(path.resolve(directory))});
}

// --- loading ---------------------------------------------------------------------------------------------------
/**
 * Imports <dir>/<name>/index.mjs for every sub-directory that has one, directory by directory (alphabetical within
 * each). The default export is the module object; its id must equal the directory name. Before the import, the
 * plugin's plugin.json is checked: its fields, the core range against coreVersion, and after all are loaded, its
 * requires and the keys it needs in site.json → plugins.<id>. A plugin without plugin.json loads with one warning.
 * Every failure stops the start, naming the plugin (docs/plugins.md → What is refused at start-up).
 * directories: a directory, a list, or null. site: the site whose plugins.<id> the config check reads.
 */
export async function loadPlugins(directories=pluginsDirectories(),{coreVersion=CORE_VERSION,site=null,warn=message=>console.warn(message),root=repoRoot}={}){
 const list=(directories===null||directories===undefined?[]:Array.isArray(directories)?directories:[directories]).filter(d=>d&&existsSync(d));
 const loaded=[],where=new Map();
 for(const directory of list){
  checkCoreLink(directory,root);
  const source=pluginSource(directory,root);
  const names=readdirSync(directory,{withFileTypes:true}).filter(d=>d.isDirectory()&&!d.name.startsWith('.')&&!d.name.startsWith('_')).map(d=>d.name).sort();
  for(const name of names){
   const entry=path.join(directory,name,'index.mjs');if(!existsSync(entry))continue;
   if(where.has(name))throw new ModuleError(`plugin "${name}" is in two plugin directories: ${where.get(name)} and ${directory}`);
   where.set(name,directory);
   const manifest=readPluginManifest(directory,name,{source});
   if(!manifest)warn(`plugin "${name}" has no ${MANIFEST_FILE}: loaded as an unversioned plugin (Home Hub 2.0 will refuse it). docs/plugins.md → plugin.json`);
   else if(!satisfies(coreVersion,manifest.core))throw new ModuleError(`plugin "${name}" ${manifest.version} supports Home Hub ${manifest.core}; this is ${coreVersion}. Update the plugin, or run a core it supports.`);
   let raw;try{raw=(await import(pathToFileURL(entry).href)).default;}
   catch(e){
    const hint=e?.code==='ERR_MODULE_NOT_FOUND'&&/'home-hub'|home-hub\//.test(e.message)?` It imports Home Hub by name, which does not resolve from ${directory}: ${linkCommand(directory)}`:'';
    throw new ModuleError(`plugin "${name}" failed to load (${entry}): ${e.message}${hint}`);
   }
   if(!plain(raw))throw new ModuleError(`plugin "${name}": index.mjs must default-export the module object`);
   if(raw.id!==name)throw new ModuleError(`plugin "${name}": its id is ${JSON.stringify(raw.id)}; the id must equal the directory name`);
   loaded.push(defineModule(raw,{directory:path.join(directory,name,'public'),manifest}));
  }
 }
 checkRequirements(loaded,{site});
 return loaded;
}
// What one plugin needs of the others (plugin.json → requires) and of the site (config.required). After loading,
// because a plugin may need one that loads after it.
export function checkRequirements(plugins,{site=null}={}){
 const byId=new Map(plugins.map(p=>[p.id,p]));
 for(const p of plugins){
  if(!p.plugin)continue;
  for(const [id,range] of Object.entries(p.plugin.requires)){
   const other=byId.get(id);
   if(!other)throw new ModuleError(`plugin "${p.id}" needs plugin "${id}" (${range}), which is not loaded`);
   if(!other.version)throw new ModuleError(`plugin "${p.id}" needs plugin "${id}" ${range}; "${id}" has no ${MANIFEST_FILE}, so its version is unknown`);
   if(!satisfies(other.version,range))throw new ModuleError(`plugin "${p.id}" needs plugin "${id}" ${range}; ${other.version} is loaded`);
  }
  if(site&&p.plugin.config.required.length){
   const own=plain(site.plugins?.[p.id])?site.plugins[p.id]:{};
   const missing=p.plugin.config.required.filter(k=>own[k]===undefined);
   if(missing.length)throw new ModuleError(`plugin "${p.id}" needs site.json → plugins.${p.id}.${missing.join(', plugins.'+p.id+'.')} (docs/plugins.md → Site configuration)`);
  }
 }
}
