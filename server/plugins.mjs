// Module registry: the one contract core features and plugins both use to add to the hub.
// A module is a plain object (docs/plugins.md):
//   {id, scopes, routes:[{method,path|match,scope,handler,…}], mcpTools, mcpInstructions, pollers, assets, nav, strings, provides, setup}
// Core modules live in server/core/; plugins are loaded from an overlay directory, by default
// local/plugins/*/index.mjs (HOME_HUB_PLUGINS_DIR overrides it; "none" loads nothing). Core never
// imports from the overlay: a plugin reaches core only through this registry.
// Everything is validated when the registry is built, and a clash (two modules claiming one route,
// scope, page hash, tool or asset) is a start-up error naming both modules. Nothing is merged silently.
import {readdirSync,existsSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {repoRoot} from './edition.mjs';

export const MODULE_ID=/^[a-z][a-z0-9-]{1,31}$/;
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
export function defineModule(raw,{core=false,directory=null}={}){
 if(!plain(raw)||typeof raw.id!=='string'||!MODULE_ID.test(raw.id))throw new ModuleError(`a module needs an id matching ${MODULE_ID} (got ${JSON.stringify(raw?.id)})`);
 const id=raw.id,known=['id','title','scopes','routes','mcpTools','mcpInstructions','pollers','assets','nav','strings','apiDocs','provides','setup'];
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
 return Object.freeze({id,core,directory,title:typeof raw.title==='string'?raw.title:id,scopes:Object.freeze(scopes),routes:Object.freeze(routes),mcpTools:Object.freeze(mcpTools),mcpInstructions:Object.freeze(mcpInstructions),
  pollers:Object.freeze(pollers),assets:Object.freeze(assets),nav:Object.freeze(nav),strings:Object.freeze(strings),apiDocs:Object.freeze(apiDocs),provides:Object.freeze(provides),setup:raw.setup??null});
}

// All modules together. Throws on any clash; the message names both sides.
// reservedTools: MCP tool names already taken (the core tools defined in server/mcp.mjs).
export function createRegistry(modules,{reservedTools=[]}={}){
 const byId=new Map(),scopes=new Map(),tools=new Map(),assets=new Map(),hashes=new Map(),exact=new Map(),patterns=[];
 const clash=(what,a,b)=>{throw new ModuleError(`${what} is registered twice: by module "${a}" and by module "${b}"`);};
 for(const m of modules){
  if(byId.has(m.id))clash(`module id "${m.id}"`,m.id,m.id);byId.set(m.id,m);
  for(const [id,meta] of Object.entries(m.scopes)){if(scopes.has(id))clash(`scope "${id}"`,scopes.get(id).module,m.id);scopes.set(id,{...meta,module:m.id});}
  for(const t of m.mcpTools){if(reservedTools.includes(t.name))clash(`MCP tool "${t.name}"`,'core',m.id);if(tools.has(t.name))clash(`MCP tool "${t.name}"`,tools.get(t.name).module,m.id);tools.set(t.name,t);}
  for(const a of m.assets){if(assets.has(a.url))clash(`asset ${a.url}`,assets.get(a.url).module,m.id);assets.set(a.url,a);}
  for(const n of m.nav)if(n.hash){if(hashes.has(n.hash))clash(`page #${n.hash}`,hashes.get(n.hash).module,m.id);hashes.set(n.hash,n);}
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
    modules:modules.map(m=>({id:m.id,core:m.core,title:m.title})),
    apiDocs:modules.flatMap(m=>m.apiDocs),
    strings:modules.reduce((all,m)=>{for(const [lang,dict] of Object.entries(m.strings))all[lang]={...all[lang],...dict};return all;},{})};
  },
 });
}

export const pluginsDirectory=(env=process.env,root=repoRoot)=>env.HOME_HUB_PLUGINS_DIR==='none'?null:env.HOME_HUB_PLUGINS_DIR?path.resolve(env.HOME_HUB_PLUGINS_DIR):path.join(root,'local','plugins');
// Imports <dir>/<name>/index.mjs for every sub-directory that has one (alphabetical order).
// The default export is the module object; its id must equal the directory name.
export async function loadPlugins(directory=pluginsDirectory()){
 if(!directory||!existsSync(directory))return [];
 const names=readdirSync(directory,{withFileTypes:true}).filter(d=>d.isDirectory()&&!d.name.startsWith('.')&&!d.name.startsWith('_')).map(d=>d.name).sort();
 const loaded=[];
 for(const name of names){
  const entry=path.join(directory,name,'index.mjs');if(!existsSync(entry))continue;
  let raw;try{raw=(await import(pathToFileURL(entry).href)).default;}catch(e){throw new ModuleError(`plugin "${name}" failed to load (${entry}): ${e.message}`);}
  if(!plain(raw))throw new ModuleError(`plugin "${name}": index.mjs must default-export the module object`);
  if(raw.id!==name)throw new ModuleError(`plugin "${name}": its id is ${JSON.stringify(raw.id)}; the id must equal the directory name`);
  loaded.push(defineModule(raw,{directory:path.join(directory,name,'public')}));
 }
 return loaded;
}
