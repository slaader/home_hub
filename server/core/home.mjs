// Core module "home": the overview (machine tiles, per-machine pages and charts), the Thermo
// telemetry client, the machine store (devices added on the page, machines written by agents, published
// runtime stacks) and the router adapter's census.
// Machines come from the site configuration (read-only) and from the store. Extension points let plugins
// enrich a machine (docs/plugins.md):
//   home.snapshots  (state, hub) => {machineId: {snapshot, bridge}}        host agents (services, memory, uptime)
//   home.services   (state, hub) => Promise<{machineId: services[]}>       service probes for agent-less machines
//   home.runtimes   (state, hub) => {machineId: {source, observedAt, runtimes[]}}   local LLM runtimes on a machine
//                   (core's own direct adapters, server/core/runtimes.mjs, are one provider; mergeRuntimeReports joins them)
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {createThermoPoller,probeThermo,checkThermoLogin,loadHostsConfig,TELEMETRY_STALE_SECONDS} from '../thermo-client.mjs';
import {worstState} from '../integrations.mjs';
import {tx} from '../text.mjs';
import {createHomeDevices,validHost,DEVICE_ID,PICTURES,MACHINE_ROLES,RUNTIME_LAYERS,RUNTIME_LIMITS,machineFields} from '../home-devices.mjs';
import {buildHome,mergeRuntimeReports,homeHistory,homeHistoryQuery,loadMachineDescriptors,homeMachineIds,machineList} from '../home-data.mjs';
import {readRouterFor} from '../router-data.mjs';
import {siteConfigPath} from '../site-config.mjs';
import {toolError} from '../mcp.mjs';

const homeError=e=>[e.message==='invalid'?400:503,'HOME_UNAVAILABLE',e.message==='invalid'?'Neplatný požadavek na data domovské stránky.':'Data domovské stránky jsou dočasně nedostupná.'];
const deviceError=(c,e,extra={})=>c.error(({invalid:400,'not-found':404,conflict:409,duplicate:409,limit:409,denied:422,pin:422,unreachable:422,secret:422})[e.message]||503,'DEVICE_FAILED',({
 invalid:'Zkontroluj pole: název, typ, hostname nebo IP, port 1024–65535, uživatele a heslo Thermo (aspoň 12 znaků) a potvrzený otisk.',
 'not-found':'Zařízení neexistuje.',conflict:'Zařízení s tímhle hostname už v přehledu je.',duplicate:'Zařízení s tímhle hostname už v přehledu je.',limit:'Přidat jde nejvýš 20 zařízení.',
 denied:'Thermo přihlášení odmítlo: zkontroluj uživatele a heslo účtu v aplikaci Thermo.',pin:'Certifikát se mezitím změnil — ověř spojení znovu.',
 unreachable:'Na té adrese a portu Thermo neodpovídá. Běží Thermo a je port povolený ve firewallu?',
 secret:'Některé pole vypadá jako tajemství (heslo, token, klíč). Zapiš, kde je uložené, ne jeho hodnotu.',...extra})[e.message]||'Zařízení teď nejde uložit.');
// Devices added on the Home page (docs/API.md). Password sign-in with write access; API keys never.
const devices=handler=>async c=>{if(c.principal.authKind==='api-key')return c.error(403,'SCOPE_REQUIRED','API keys cannot use this endpoint.');try{return await handler(c);}catch(e){return deviceError(c,e);}};

// The machine API (GET/POST /api/home/machines, POST /api/home/runtime) and its MCP tools. One code per
// refusal, so a client can tell them apart whatever language the message is in; details name the field.
const MACHINE_ERRORS={
 invalid:[400,'MACHINE_INVALID','Neplatný požadavek: zkontroluj pole stroje.'],
 secret:[422,'MACHINE_SECRET','Některé pole vypadá jako tajemství (heslo, token, klíč). Zapiš, kde je uložené, ne jeho hodnotu.'],
 'not-found':[404,'MACHINE_NOT_FOUND','Takový stroj v přehledu není.'],
 conflict:[409,'MACHINE_CONFLICT','Stroj se mezitím změnil, nebo už existuje. Načti ho znovu a změnu zopakuj s aktuálním otiskem.'],
 duplicate:[409,'MACHINE_DUPLICATE','Zařízení s tímhle hostname už v přehledu je.'],
 limit:[409,'MACHINE_LIMIT','Přidat jde nejvýš 20 zařízení.'],
 'read-only':[403,'MACHINE_READ_ONLY','Tenhle stroj je z konfigurace webu (site.json) a přes API se nemění.']};
const machines=handler=>async c=>{try{return await handler(c);}catch(e){
 const known=MACHINE_ERRORS[e.message];if(!known)throw e;
 return c.json(known[0],{error:{code:known[1],message:known[2],...(e.detail?{details:[e.detail]}:{})}});}};
const TOOL_ERRORS={
 invalid:'Invalid request',secret:'Rejected: a value looks like a secret. Record where a password, token or key is kept, never its value',
 'not-found':'No such machine. Use machine_list to see the ids',
 conflict:'It changed since you read it, or it already exists (or does not exist yet: omit base to create). Call machine_list again and repeat the change with the current hash as base',
 duplicate:'Another machine already uses this hostname',limit:'The overview holds at most 20 added machines; remove one first',
 'read-only':'This machine comes from the site configuration (site.json) and cannot be changed through the API. Its runtime stack can still be published with runtime_publish'};
const tool=async fn=>{try{return await fn();}catch(e){if(!TOOL_ERRORS[e.message])throw e;throw toolError(`${TOOL_ERRORS[e.message]}${e.detail?`: ${e.detail}`:''}. Nothing was changed.`);}};
const only=(input,keys)=>{if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!keys.includes(k)))throw Object.assign(new Error('invalid'),{detail:`expected only: ${keys.join(', ')}`});return input;};
// Who made a write and through what: an API key is an agent, anything else a person in the UI.
const actor=principal=>({by:principal.username,source:principal.authKind==='api-key'?'agent':'ui'});

async function listMachines(state,hub,withStack=false){
 return machineList({site:hub.site,added:await state.homeDevices.list(),published:await state.homeDevices.stacks(),home:await state.payload(),withStack});
}
async function upsertMachine(state,input,principal){
 only(input,['machine','base']);
 const r=await state.homeDevices.upsert(input.machine,{...actor(principal),...(input.base!==undefined?{base:input.base}:{})});
 return {ok:true,id:r.device.id,hash:r.hash,created:r.created,changed:r.changed,by:principal.username,machine:machineFields(r.device)};
}
async function removeMachine(state,input){
 only(input,['id','base']);
 if(typeof input.id!=='string'||!DEVICE_ID.test(input.id))throw Object.assign(new Error('invalid'),{detail:'id must be a machine id'});
 if(typeof input.base!=='string'||!/^[a-f0-9]{64}$/.test(input.base))throw Object.assign(new Error('invalid'),{detail:'base must be the 64-character hash from machine_list'});
 const gone=await state.homeDevices.remove(input.id,{base:input.base});if(gone.hadLogin)state.thermoPoller.removeHost(gone.device.id);
 return {ok:true,id:gone.device.id,removed:true};
}
async function publishRuntime(state,hub,input,principal){
 only(input,['machine','stack','base']);
 if(input.stack===undefined)throw Object.assign(new Error('invalid'),{detail:'stack is required (null takes the published stack back)'});
 const r=await state.homeDevices.publishRuntime(input.machine,input.stack,{by:principal.username,known:homeMachineIds(hub.site),...(input.base!==undefined?{base:input.base}:{})});
 return {ok:true,id:r.machine,hash:r.hash,changed:r.changed,published:r.hash!==null,publishedAt:r.publishedAt,by:principal.username};
}

// --- integration "home.thermo": the Thermo pull client -----------------------------------------------
export const THERMO_INTEGRATION='home.thermo';
// What the overview reads while Thermo is turned off: no readings, no disks, no live state.
const quietThermo=poller=>({interval:()=>poller.interval?.()||{intervalSeconds:15,lastPollAt:null},status:()=>({}),live:()=>({}),seconds:()=>[],minutes:()=>[],disks:()=>({})});
const relLabel=(root,file)=>{const rel=path.relative(root,file);return rel&&!rel.startsWith('..')&&!path.isAbsolute(rel)?rel:path.basename(file);};
// Hosts, their last reading and their errors, from the poller's own state. The hosts file is read for
// its ids only; logins never leave it.
async function thermoStatus(state,hub,{enabled=true}={}){
 const {thermoPoller,homeDevices,thermoHostsFile}=state;
 const fromFile=(await loadHostsConfig(thermoHostsFile).catch(()=>[])).map(h=>h.id);
 const fromUi=(await homeDevices.thermoHosts().catch(()=>[])).map(h=>h.id);
 const added=await homeDevices.list().catch(()=>[]);
 const ids=[...new Set([...fromFile,...fromUi,...(enabled?thermoPoller.hosts?.()||[]:[])])];
 const nameOf=id=>hub.site.machines.find(m=>m.thermoId===id)?.name||added.find(d=>d.id===id||d.thermoId===id)?.name||id;
 const status=enabled?thermoPoller.status?.()||{}:{},live=enabled?thermoPoller.live?.()||{}:{};
 const now=Date.now();
 const items=ids.map(id=>{
  const st=status[id],lv=live[id],at=Number.isFinite(lv?.at)?new Date(lv.at).toISOString():null,fresh=Number.isFinite(lv?.at)&&now-lv.at<=TELEMETRY_STALE_SECONDS*1000;
  const base={id,label:nameOf(id),lastSuccessAt:at};
  if(!enabled)return {...base,state:'disabled',summary:'Nečte se.'};
  if(st?.state==='denied')return {...base,state:'error',summary:'Thermo odmítlo přihlášení.',lastError:'denied'};
  if(st?.state==='down')return {...base,state:'error',summary:'Neodpovídá.',lastError:st.error||'unavailable'};
  if(fresh)return {...base,state:'ok',summary:'Čte se živě.'};
  if(at)return {...base,state:'stale',summary:'Poslední čtení je staré.'};
  return {...base,state:'stale',summary:'Zatím nic nepřečteno.'};
 });
 const configuredBy=[
  ...(fromFile.length?[...(process.env.THERMO_HOSTS_FILE&&!hub.options.thermoHostsFile?[{source:'env',name:'THERMO_HOSTS_FILE'}]:[]),{source:'file',name:relLabel(hub.root,thermoHostsFile)}]:[]),
  ...(fromUi.length?[{source:'ui',name:'Přehled → Přidat zařízení'}]:[]),
  ...(hub.site.machines.some(m=>m.thermoId)?[{source:'site.json',name:'machines[].thermoId'}]:[])];
 const ok=items.filter(i=>i.state==='ok').length,newest=items.map(i=>i.lastSuccessAt).filter(Boolean).sort().at(-1)||null;
 if(!items.length)return {state:'not-configured',summary:'Žádný stroj nemá přihlášení k Thermo.',configuredBy,items};
 return {state:worstState(items.map(i=>i.state)),summary:tx('Thermo čte {ok} z {total} strojů.',{ok,total:items.length}),lastSuccessAt:newest,
  lastError:items.find(i=>i.lastError)?.lastError||null,configuredBy,items};
}
const thermoIntegration={id:THERMO_INTEGRATION,title:'Telemetrie Thermo',kind:'telemetry',
 description:'Živé CPU, GPU, paměť, příkon, teploty a disky strojů z aplikace Thermo. Vypnutá: hub zavře spojení, nic nečte a přehled ukáže stroje bez telemetrie.',
 howTo:'Na přehledu přidej zařízení s Thermo (Přidat zařízení), nebo zapiš hostitele do souboru private/thermo-hosts.json.',page:'overview',docs:'docs/plugins.md → Site configuration (thermoId)',
 status:thermoStatus,
 // A pull now (at most one every 5 s), then the state it left.
 async test(state,hub){await state.thermoPoller.refresh?.().catch(()=>false);return thermoStatus(state,hub);},
 settings:{schema:[{key:'intervalSeconds',label:'Interval čtení',type:'select',options:[{value:15,label:'15 s'},{value:30,label:'30 s'},{value:60,label:'60 s'}],help:'Jak často hub čte Thermo na strojích.'}],
  read:state=>({intervalSeconds:state.thermoPoller.interval?.().intervalSeconds??null}),
  async write(state,hub,values){if(values.intervalSeconds!==undefined)await state.thermoPoller.setIntervalMs(values.intervalSeconds*1000);}}};

const MACHINE_SCHEMA={type:'object',required:['id','name'],additionalProperties:false,properties:{
 id:{type:'string',pattern:DEVICE_ID.source,description:'Stable id, used in URLs (#host-<id>) and as the key for updates, e.g. mac-mini or nas.'},
 name:{type:'string',minLength:1,maxLength:60,description:'What the tile shows, e.g. "Mac mini (office)".'},
 hostname:{type:'string',maxLength:253,description:'Host name or IPv4 address, e.g. mini.example.lan.'},
 ip:{type:['string','null'],description:'IPv4 address. When the site lists its networks (lanCidrs in machine_list), it must be a host address inside one of them.'},
 role:{type:'string',enum:[...MACHINE_ROLES],description:'computer (default), nas, router or other.'},
 hardware:{type:'object',additionalProperties:false,description:'Static facts shown on the tile.',properties:{
  cpu:{type:'string',maxLength:60,description:'e.g. "10c M4".'},gpu:{type:'string',maxLength:40,description:'e.g. "10c" or "RTX 4090".'},
  ramGb:{type:['number','null'],exclusiveMinimum:0,maximum:65536},diskTotalBytes:{type:['number','null'],exclusiveMinimum:0}}},
 thermoId:{type:['string','null'],pattern:DEVICE_ID.source,description:'Host id of the telemetry agent (Thermo) this machine reports through, or null when the agent is not installed. Setting it does not create a login: the owner connects the agent in the web UI.'},
 picture:{type:['string','null'],enum:[...PICTURES,null],description:'One of the built-in pictures; null picks one by role. A picture the owner uploaded in the web UI takes precedence.'}}};
const STACK_SCHEMA={type:['object','null'],required:['cols','blocks'],additionalProperties:false,description:'The stack, or null to take the published one back.',properties:{
 cols:{type:'array',minItems:1,maxItems:RUNTIME_LIMITS.cols,items:{type:'string',pattern:'^[a-z][a-z0-9-]{0,15}$'},description:'One key per grid column, left to right: the engine family of that column, e.g. ["gguf","mlx","mlx"]. Keys with a colour: gguf, mlx, torch, mix, edge, media, cloud, dev, share, net.'},
 engines:{type:'object',maxProperties:RUNTIME_LIMITS.engines,additionalProperties:{type:'string',maxLength:40},description:'Legend: column key → label, e.g. {"gguf":"llama.cpp","mlx":"Apple MLX"}.'},
 blocks:{type:'array',minItems:1,maxItems:RUNTIME_LIMITS.blocks,items:{type:'object',required:['id','layer','col0','col1','title'],additionalProperties:false,properties:{
  id:{type:'string',pattern:'^[a-z][a-z0-9_-]{0,39}$'},
  layer:{type:'string',enum:[...RUNTIME_LAYERS],description:'input = what clients call (gateways, APIs); tool = routers and launchers (llama-swap, LM Studio); runtime = servers that hold models (llama-server, Ollama, vLLM); engine = the inference engine (llama.cpp, MLX, PyTorch); hardware = the chip and memory.'},
  col0:{type:'integer',minimum:0},col1:{type:'integer',minimum:0,description:'The block spans columns col0..col1 (inclusive). A block stands on whatever overlaps its columns one layer below; two blocks of one layer must not overlap.'},
  title:{type:'string',minLength:1,maxLength:60},port:{type:'string',maxLength:80,description:'Short second line, e.g. ":8081" or "64 GB unified memory".'},desc:{type:'string',maxLength:400},
  state:{type:'string',enum:['on','off'],description:'off = installed but not running (drawn dashed).'},
  service:{type:'string',pattern:'^[a-z0-9][a-z0-9._-]{0,59}$',description:'Id of a live service; when a host agent reports it, the block follows its state and models.'},
  models:{type:'array',maxItems:RUNTIME_LIMITS.models,items:{type:'object',required:['id'],additionalProperties:false,properties:{
   id:{type:'string',minLength:1,maxLength:120},state:{type:'string',enum:['loaded','loading','idle']},sizeGb:{type:['number','null'],minimum:0},path:{type:'string',maxLength:240}}}}}}}}};

export default {
 id:'home',title:'Overview',
 assets:['home-view.js','home-charts.js','home-add-device.js','home-order.js','home-drag.js','home-telemetry.js','home.css','vendor/echarts.esm.min.mjs',...PICTURES.map(id=>`images/generic/${id}.svg`)],
 nav:[{groupKey:'Domov',hash:'overview',labelKey:'Přehled',view:'home-view.js#homePage',order:10}],
 apiDocs:[{title:'Domov',routes:[
  ['GET','/api/home/machines','read','Stroje: z konfigurace webu (jen ke čtení) a přidané, s otiskem. MCP machine_list.'],
  ['POST','/api/home/machines','home:write','Založit nebo nahradit stroj {machine, base?}. MCP machine_upsert.'],
  ['POST','/api/home/machines/remove','home:write','Odebrat přidaný stroj {id, base}. MCP machine_remove.'],
  ['POST','/api/home/runtime','home:write','Zveřejnit runtime stack stroje {machine, stack|null, base?}. MCP runtime_publish.']]}],
 setup(hub){
  const {site,directory,stateDirectory,root,options}=hub;
  const ids=homeMachineIds(site);
  const homeDevices=options.homeDevices||createHomeDevices(path.join(stateDirectory,'home'),{reserved:ids,lanCidrs:site.lanCidrs});
  const thermoHostsFile=options.thermoHostsFile||process.env.THERMO_HOSTS_FILE||path.join(root,'private','thermo-hosts.json');
  const thermoPoller=options.thermoPoller||createThermoPoller({hostsFile:thermoHostsFile,extraHosts:()=>homeDevices.thermoHosts(),stateDirectory});
  // The site's own tile pictures (<site images>/home/<id>.jpg), looked up once: the page then asks only for files that exist.
  const imagesDirectory=options.siteImagesDirectory===undefined?(options.site?null:siteConfigPath()&&path.join(path.dirname(siteConfigPath()),'images')):options.siteImagesDirectory;
  const sitePictures=Object.fromEntries(ids.filter(id=>imagesDirectory&&existsSync(path.join(imagesDirectory,'home',`${id}.jpg`))).map(id=>[id,`/images/home/${id}.jpg`]));
  const settled=async name=>Promise.all(hub.collect(name).map(v=>Promise.resolve(v).catch(()=>({}))));
  const merged=async name=>Object.assign({},...await settled(name));
  // Integrations an administrator turned off: the overview says so instead of showing nothing silently.
  const disabledIntegrations=()=>hub.registry.integrations.filter(i=>!hub.integrationEnabled(i.id)).map(i=>({id:i.id,title:i.title,...(i.titleKey?{titleKey:i.titleKey}:{}),kind:i.kind}));
  const payload=async()=>({...buildHome({site,added:await homeDevices.list(),published:await homeDevices.stacks(),sitePictures,descriptors:await loadMachineDescriptors(process.env.MACHINES_DIR||path.join(directory,'machines'),ids),
   snapshots:await merged('home.snapshots'),runtimes:mergeRuntimeReports(await settled('home.runtimes')),thermo:hub.integrationEnabled(THERMO_INTEGRATION)?thermoPoller:quietThermo(thermoPoller),router:await readRouterFor(hub),probed:await merged('home.services')}),
   integrations:{disabled:disabledIntegrations()}});
  // Thermo off: close the sessions and stop pulling; on again: pull right away. Neither waits for the network.
  if(!hub.integrationEnabled(THERMO_INTEGRATION))void thermoPoller.pause?.();
  hub.onIntegrationChange(e=>{if(e.id!==THERMO_INTEGRATION)return;void Promise.resolve(e.enabled?thermoPoller.resume?.():thermoPoller.pause?.()).catch(()=>{});});
  return {homeDevices,thermoPoller,thermoHostsFile,payload,checkThermo:options.checkThermo||checkThermoLogin,probeCert:options.probeCert||probeThermo,
   machineIds:async()=>[...ids,...(await homeDevices.list()).map(d=>d.id)]};
 },
 pollers:[{id:'thermo',start:state=>state.thermoPoller.start(),stop:state=>state.thermoPoller.stop?.()}],
 integrations:[thermoIntegration],
 mcpInstructions:[
  'Machines: home_status is the live state (online, load, temperature, memory, services). machine_list is what the overview holds: each machine with its hash, where it comes from and where its runtime stack comes from.',
  {scope:'home:write',text:'With home:write: machine_upsert adds or replaces a machine and machine_remove removes one (pass the hash from machine_list as base; machines from the site configuration are read-only). runtime_publish replaces the runtime stack drawn on a machine\'s page: what clients call, launchers, model servers, engines and the chip.'},
 ],
 mcpTools:[
  {name:'machine_list',scope:'read',title:'Overview: list machines',
   description:'The machines on the Home Hub overview: those from the site configuration (source "site", read-only) and those added in the web UI or by an agent (source "ui" / "agent"), each with its hash, telemetry state and where its runtime stack comes from. Also returns the built-in picture ids, the roles, the site networks an ip must lie in and the telemetry agent to install. Pass runtime:true to get each published runtime stack as well.',
   inputSchema:{type:'object',properties:{runtime:{type:'boolean',description:'Include the published runtime stack of each machine.'}},additionalProperties:false},annotations:{readOnlyHint:true,openWorldHint:false},
   run:(args,{state,hub})=>tool(async()=>{only(args,['runtime']);return listMachines(state,hub,args.runtime===true);})},
  {name:'machine_upsert',scope:'home:write',title:'Overview: create or replace a machine',
   description:'Create a machine on the overview, or replace one you read. The whole record is replaced, so send every field you want kept. To change an existing machine pass its hash from machine_list as base; if it changed in between, the call is refused and you must read it again. Omit base to create; repeating a create with identical fields changes nothing and succeeds. Machines from the site configuration cannot be changed. Never put a password, token or key in any field: secret-looking values are rejected.',
   inputSchema:{type:'object',properties:{machine:MACHINE_SCHEMA,base:{type:'string',pattern:'^[a-f0-9]{64}$',description:'Hash from machine_list. Required when the machine already exists.'}},required:['machine'],additionalProperties:false},
   annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false},
   run:(args,{state,principal})=>tool(()=>upsertMachine(state,args,principal))},
  {name:'machine_remove',scope:'home:write',title:'Overview: remove a machine',
   description:'Remove a machine that was added in the web UI or by an agent, with its uploaded picture, stored telemetry login and published runtime stack; the metric history stays on disk. Pass the hash from machine_list as base. Machines from the site configuration cannot be removed.',
   inputSchema:{type:'object',properties:{id:{type:'string',pattern:DEVICE_ID.source},base:{type:'string',pattern:'^[a-f0-9]{64}$',description:'Hash from machine_list.'}},required:['id','base'],additionalProperties:false},
   annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:false},
   run:(args,{state})=>tool(()=>removeMachine(state,args))},
  {name:'runtime_publish',scope:'home:write',title:'Overview: publish a machine\'s runtime stack',
   description:'Publish the layered runtime stack drawn on a machine\'s page: what clients call (input), routers and launchers (tool), model servers (runtime), inference engines (engine) and the chip (hardware), placed on a grid of engine columns. It replaces the stack from the site configuration when there is one, otherwise it adds one; site machines are allowed. The whole stack is replaced on every call; publishing the same stack again changes nothing. Pass stack:null to take the publication back. Optional base = the runtime hash from machine_list, to refuse the call if someone else published in between. Never include secrets.',
   inputSchema:{type:'object',properties:{machine:{type:'string',pattern:DEVICE_ID.source,description:'Machine id from machine_list.'},stack:STACK_SCHEMA,base:{type:'string',pattern:'^[a-f0-9]{64}$'}},required:['machine','stack'],additionalProperties:false},
   annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false},
   run:(args,{state,hub,principal})=>tool(()=>publishRuntime(state,hub,args,principal))},
 ],
 routes:[
  {method:'GET',path:'/api/home',error:homeError,handler:async({json,state})=>json(200,await state.payload())},
  {method:'GET',path:'/api/home/history',error:homeError,async handler({query,json,state,hub}){
    const added=await state.homeDevices.list(),q=homeHistoryQuery(query,added,hub.site);
    if(q.reason)return json(200,q);
    if(!hub.integrationEnabled(THERMO_INTEGRATION))return json(200,{...q,points:[],complete:false,source:'vypnuto',reason:'Telemetrie Thermo je vypnutá administrátorem.',disabled:hub.integrationDisabled(THERMO_INTEGRATION)});
    // A machine reads the Thermo host named by its thermoId (a device connected on the overview is its own host).
    const thermoId=hub.site.machines.find(m=>m.id===q.machine)?.thermoId||added.find(d=>d.id===q.machine)?.thermoId||q.machine;
    return json(200,{...homeHistory(state.thermoPoller,thermoId,q.range,undefined,[thermoId]),machine:q.machine});}},
  {method:'POST',path:'/api/home/settings',scope:'home:settings',error:homeError,async handler({input,json,state}){const ms=Number(input?.intervalSeconds)*1000;await state.thermoPoller.setIntervalMs(ms);return json(200,await state.payload());}},
  // Refresh button: pull Thermo now (rate-limited in the poller), then return fresh tiles. Reads only.
  {method:'POST',path:'/api/home/refresh',scope:'read',error:homeError,async handler({json,state}){const pulled=await state.thermoPoller.refresh().catch(()=>false);return json(200,{...await state.payload(),refresh:{pulled:pulled===true,at:new Date().toISOString()}});}},
  // The machine API: what the MCP tools do, over HTTP. A write session or an API key with home:write.
  {method:'GET',path:'/api/home/machines',error:homeError,handler:async({query,json,state,hub})=>json(200,await listMachines(state,hub,query.stack==='1'))},
  {method:'POST',path:'/api/home/machines',scope:'home:write',error:homeError,handler:machines(async c=>{
    c.subject=typeof c.input?.machine?.id==='string'&&DEVICE_ID.test(c.input.machine.id)?c.input.machine.id:null;
    const r=await upsertMachine(c.state,c.input,c.principal);return c.json(r.created?201:200,r);})},
  {method:'POST',path:'/api/home/machines/remove',scope:'home:write',error:homeError,handler:machines(async c=>c.json(200,await removeMachine(c.state,c.input)))},
  {method:'POST',path:'/api/home/runtime',scope:'home:write',bodyLimit:65536,error:homeError,handler:machines(async c=>{
    c.subject=typeof c.input?.machine==='string'&&DEVICE_ID.test(c.input.machine)?c.input.machine:null;
    return c.json(200,await publishRuntime(c.state,c.hub,c.input,c.principal));})},
  {method:'POST',path:'/api/home/devices/probe',scope:null,error:homeError,handler:devices(async({input,json,state})=>{
    if(!input||typeof input!=='object'||Object.keys(input).some(k=>!['host','port'].includes(k))||!validHost(input.host))throw new Error('invalid');
    const port=input.port??49286;if(!Number.isSafeInteger(port)||port<1024||port>65535)throw new Error('invalid');
    return json(200,await state.probeCert({host:input.host,port}));})},
  {method:'POST',path:'/api/home/devices/remove',scope:null,error:homeError,handler:devices(async({input,json,state})=>{
    if(!input||typeof input!=='object'||Object.keys(input).some(k=>k!=='id')||typeof input.id!=='string'||!DEVICE_ID.test(input.id))throw new Error('invalid');
    const gone=await state.homeDevices.remove(input.id);if(gone.hadLogin)state.thermoPoller.removeHost(gone.device.id);return json(200,{removed:gone.device.id});})},
  // Connect a device that is already on the overview to Thermo, or forget its login ({id, thermo: null}).
  // As with a new device, the login is tried once with the pinned certificate before anything is stored.
  {method:'POST',path:'/api/home/devices/thermo',scope:null,error:homeError,handler:devices(async({input,json,state})=>{
    if(!input||typeof input!=='object'||Object.keys(input).some(k=>!['id','thermo'].includes(k))||typeof input.id!=='string'||!DEVICE_ID.test(input.id)||input.thermo===undefined)throw new Error('invalid');
    if(input.thermo===null){const r=await state.homeDevices.setThermo(input.id,null);if(r.hadLogin)state.thermoPoller.removeHost(input.id);return json(200,r.device);}
    const device=(await state.homeDevices.list()).find(d=>d.id===input.id);if(!device)throw new Error('not-found');
    const t=input.thermo,host=device.hostname||device.ip,pin=String(t?.pin||'').replace(/:/g,'').toLowerCase(),port=t?.port??49286;
    if(!host||!t||typeof t!=='object'||!/^[a-f0-9]{64}$/.test(pin)||!Number.isSafeInteger(port)||typeof t.password!=='string'||t.password.length<12||t.password.length>256||typeof t.username!=='string'||!t.username.trim())throw new Error('invalid');
    await state.checkThermo({id:'probe',host,port,username:t.username.trim().slice(0,32),label:'home-hub',password:t.password,token:null,pin});
    const r=await state.homeDevices.setThermo(input.id,t);state.thermoPoller.addHost(r.thermo);return json(200,r.device);})},
  // Add: a Thermo device must log in with the pinned certificate first, so a typo never lands in the config.
  {method:'POST',path:'/api/home/devices',scope:null,error:homeError,handler:devices(async({input,principal,json,state})=>{
    const t=input?.kind==='thermo'?input.thermo:null;
    if(t&&typeof t==='object'&&validHost(input.hostname)){const pin=String(t.pin||'').replace(/:/g,'').toLowerCase(),port=t.port??49286;
     if(/^[a-f0-9]{64}$/.test(pin)&&Number.isSafeInteger(port)&&typeof t.password==='string'&&t.password.length>=12&&t.password.length<=256&&typeof t.username==='string'&&t.username.trim())
      await state.checkThermo({id:'probe',host:input.hostname,port,username:t.username.trim().slice(0,32),label:'home-hub',password:t.password,token:null,pin});}
    const saved=await state.homeDevices.add(input,principal.username);if(saved.thermo)state.thermoPoller.addHost(saved.thermo);
    return json(201,saved.device);})},
  // Back to a built-in picture: the uploaded one is deleted.
  {method:'POST',path:'/api/home/devices/image/remove',scope:null,error:homeError,handler:devices(async({input,json,state})=>{
    if(!input||typeof input!=='object'||Object.keys(input).some(k=>k!=='id')||typeof input.id!=='string'||!DEVICE_ID.test(input.id))throw new Error('invalid');
    return json(200,await state.homeDevices.removeImage(input.id));})},
  // An added device's tile picture: one JPEG cropped in the browser (at most 3 MiB). Password sign-in only.
  {method:'PUT',match:/^\/api\/home\/devices\/([a-z][a-z0-9_-]{1,31})\/image$/,scope:null,raw:true,contentType:'image/jpeg',denied:'Zařízení přidává jen účet se zápisem, přihlášený heslem.',error:homeError,
   async handler({req,params,json,error,state}){
    try{return json(200,await state.homeDevices.putImage(params[1],req,Number(req.headers['content-length'])));}
    catch(e){req.resume();return error(({invalid:400,'not-found':404,'too-large':413})[e.message]||503,'DEVICE_FAILED',({invalid:'Obrázek musí být JPEG.','not-found':'Zařízení neexistuje.','too-large':'Obrázek je větší než 3 MB.'})[e.message]||'Obrázek nejde uložit.');}}},
  // The picture of an added device, from state (a site's own machine pictures are static files and win).
  {method:'GET',match:/^\/images\/home\/([a-z][a-z0-9_-]{1,31})\.jpg$/,async handler({params,res,error,state}){
    let file;try{file=await state.homeDevices.image(params[1]);}catch{return error(404,'NOT_FOUND','Not found.');}
    res.setHeader('Cache-Control','private, max-age=86400');res.writeHead(200,{'Content-Type':'image/jpeg'});return res.end(await readFile(file));}},
 ],
};
