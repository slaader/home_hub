// Core module "home": the overview (machine tiles, per-machine pages and charts), the Thermo
// telemetry client, Windows telemetry over SSH (server/windows-telemetry.mjs), the machine store (devices added on the page, machines written by agents, published
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
import {createWindowsPoller,checkWindows,validSshTarget,runSsh,WINDOWS_PROVIDER,WINDOWS_ERRORS,WINDOWS_MIN_INTERVAL_MS} from '../windows-telemetry.mjs';
import {createSshVault,createWindowsSetup,collectManaged,sshTools,WINDOWS_SETUP_ERRORS,LINUX_SETUP_ERRORS} from '../windows-ssh.mjs';
import {createSnapshotPoller} from '../telemetry-poller.mjs';
import {windowsDriver} from '../windows-telemetry.mjs';
import {collectWinrm,winrmCheck,winrmKey,winrmInfo,winrmLabel,validWinrmConfig,WINRM_PROVIDER,WINRM_ERRORS} from '../winrm-telemetry.mjs';
import {collectNodeExporter,collectLinuxSsh,linuxCheck,exporterDriver,linuxSshDriver,NODE_EXPORTER_PROVIDER,LINUX_SSH_PROVIDER,NODE_EXPORTER_ERRORS,LINUX_SSH_ERRORS} from '../linux-telemetry.mjs';
import {collectPrometheus,discoverTargets,prometheusDriver,PROMETHEUS_PROVIDER,PROMETHEUS_ERRORS} from '../prometheus-telemetry.mjs';
import {createEndpointSetup,ENDPOINT_SETUP_ERRORS,ENDPOINT_PROVIDERS} from '../endpoint-setup.mjs';
import {endpointRequest,probeCertificate} from '../endpoint-http.mjs';
import {FEEDS,isFeed,feedOfDevice} from '../telemetry-providers.mjs';
import {worstState} from '../integrations.mjs';
import {tx} from '../text.mjs';
import {telemetryFacet} from '../machine-facet-sources.mjs';
import {FACETS_POINT} from '../machine-facets.mjs';
import {createHomeDevices,validHost,DEVICE_ID,PICTURES,MACHINE_ROLES,PLATFORMS,RUNTIME_LAYERS,RUNTIME_LIMITS,machineFields,siteProviderFits} from '../home-devices.mjs';
import {buildHome,mergeRuntimeReports,homeHistory,homeHistoryQuery,loadMachineDescriptors,homeMachineIds,machineList} from '../home-data.mjs';
import {readRouterFor} from '../router-data.mjs';
import {siteConfigPath,hubAddress} from '../site-config.mjs';
import {privateFile} from '../paths.mjs';
import {toolError} from '../mcp.mjs';

const homeError=e=>[e.message==='invalid'?400:503,'HOME_UNAVAILABLE',e.message==='invalid'?'Neplatný požadavek na data domovské stránky.':'Data domovské stránky jsou dočasně nedostupná.'];
// A refusal that names its field (e.detail, English) carries it as details, like the machine API.
const DEVICE_INVALID='Zkontroluj pole: název, typ, hostname nebo IP, port 1024–65535, uživatele a heslo Thermo (aspoň 12 znaků) a potvrzený otisk.';
const deviceError=(c,e,extra={})=>e?.message==='invalid'&&typeof e.detail==='string'?c.json(400,{error:{code:'DEVICE_FAILED',message:extra.invalid||DEVICE_INVALID,details:[e.detail]}}):c.error(({invalid:400,'not-found':404,conflict:409,duplicate:409,limit:409,denied:422,pin:422,unreachable:422,secret:422})[e.message]||503,'DEVICE_FAILED',({
 invalid:DEVICE_INVALID,
 'not-found':'Zařízení neexistuje.',conflict:'Zařízení s tímhle hostname už v přehledu je.',duplicate:'Zařízení s tímhle hostname už v přehledu je.',limit:'Přidat jde nejvýš 20 zařízení.',
 denied:'Thermo přihlášení odmítlo: zkontroluj uživatele a heslo účtu v aplikaci Thermo.',pin:'Certifikát se mezitím změnil — ověř spojení znovu.',
 unreachable:'Na té adrese a portu Thermo neodpovídá. Běží Thermo a je port povolený ve firewallu?',
 secret:'Některé pole vypadá jako tajemství (heslo, token, klíč). Zapiš, kde je uložené, ne jeho hodnotu.',...extra})[e.message]||'Zařízení teď nejde uložit.');
// Only failures of the SSH check carry .windows, so a Thermo "denied" keeps its own message.
const windowsFailure=(c,e)=>e.windows&&Object.hasOwn(WINDOWS_ERRORS,e.message)
 ?c.json(422,{error:{code:'WINDOWS_SSH_FAILED',reason:e.message,message:WINDOWS_ERRORS[e.message]}}):null;
// A step of an app-managed set-up that cannot go on (server/windows-ssh.mjs): one code per reason, a sentence on what to do.
const setupFailure=(c,e)=>{const table=e?.setup==='endpoint'?ENDPOINT_SETUP_ERRORS:e?.setup==='linux'?LINUX_SETUP_ERRORS:WINDOWS_SETUP_ERRORS;
 const known=Object.hasOwn(table,e?.message)?table[e.message]:null;
 return known?c.json(known[0],{error:{code:e?.setup==='endpoint'||e?.setup==='linux'?'TELEMETRY_SETUP_FAILED':'WINDOWS_SETUP_FAILED',reason:e.message,message:known[1]}}):null;};
// A step of another provider (WinRM, Node Exporter, Prometheus, Linux SSH) that failed at the machine: its code and sentence.
const feedFailure=(c,e)=>e?.feed&&isFeed(e.feed)&&Object.hasOwn(FEEDS[e.feed].errors,e.message)
 ?c.json(422,{error:{code:'TELEMETRY_FAILED',provider:e.feed,reason:e.message,message:FEEDS[e.feed].errors[e.message]}}):null;
// Runs a set-up step of a draft: refusals of the draft stay set-up errors (of `setup`), failures at the machine become the provider's code.
const feedStep=(provider,setup,table,promise)=>promise.catch(e=>{
 if(e?.message==='invalid')throw e;
 if(Object.hasOwn(table,e?.message))throw Object.assign(e,{setup});
 throw Object.assign(new Error(Object.hasOwn(FEEDS[provider].errors,e?.message)?e.message:'unavailable'),{feed:provider});});
// What an SSH step (a test, a host-key fetch) failed with, as a Windows SSH failure; a set-up refusal stays one.
const sshStep=promise=>promise.catch(e=>{if(e?.message==='invalid'||Object.hasOwn(WINDOWS_SETUP_ERRORS,e?.message))throw e;
 throw Object.assign(new Error(Object.hasOwn(WINDOWS_ERRORS,e?.message)?e.message:'unavailable'),{windows:true});});
const tryWindows=(state,target)=>sshStep(state.checkWindows(target));
// At most two SSH steps (tests and host-key fetches, each spawns an OpenSSH tool) at a time; more are refused, never queued.
const gate=(max=2)=>{let running=0;return async fn=>{if(running>=max)throw Object.assign(new Error('busy'),{windows:true});running++;try{return await fn();}finally{running--;}};};
const limited=(fn,run)=>target=>run(()=>fn(target));
// Devices added on the Home page (docs/API.md). Password sign-in with write access; API keys never.
// The key of the sealed secret files is not there (docs/storage.md → Secrets at rest): nothing was changed.
const SECRETS_LOCKED='Uložená hesla teď nejdou otevřít: chybí klíč, kterým jsou zašifrovaná. Nic se nezměnilo. Viz docs/storage.md → Secrets at rest.';
const lockedFailure=(c,e)=>e?.reason==='secrets-locked'?c.json(503,{error:{code:'SECRETS_LOCKED',message:SECRETS_LOCKED}}):null;
const devices=handler=>async c=>{if(c.principal.authKind==='api-key')return c.error(403,'SCOPE_REQUIRED','API keys cannot use this endpoint.');try{return await handler(c);}catch(e){return lockedFailure(c,e)||windowsFailure(c,e)||feedFailure(c,e)||setupFailure(c,e)||deviceError(c,e);}};
// Keys, host trust and connection tests of app-managed SSH: a person signed in with a password and write access.
// Not an API key, not a native device token: nothing but that person's own browser session reaches a set-up draft.
const sessionWrite=handler=>devices(async c=>c.principal?.authKind==='session'&&c.canWrite?handler(c)
 :c.error(403,'SESSION_REQUIRED','Spojení s Windows a jeho klíč nastavuje jen účet se zápisem, přihlášený heslem.'));
// The same rule for the other providers' set-up and connection (its message does not name one system).
const sessionFeed=handler=>devices(async c=>c.principal?.authKind==='session'&&c.canWrite?handler(c)
 :c.error(403,'SESSION_REQUIRED','Telemetrické spojení a jeho tajemství nastavuje jen účet se zápisem, přihlášený heslem.'));
// The owner's edit of a machine of the site configuration (its display metadata, over the site's defaults): a person
// signed in with a password and write access. Not an API key, not a native device token; agents keep machine_upsert,
// which refuses site machines. Refusals carry the machine API's codes (MACHINE_INVALID, MACHINE_CONFLICT, …).
const siteEdit=handler=>machines(async c=>c.principal?.authKind==='session'&&c.canWrite?handler(c)
 :c.error(403,'SESSION_REQUIRED','Stroj z konfigurace webu upravuje jen účet se zápisem, přihlášený heslem.'));
// {draft, host, port, user} of a managed connection the form saves.
const managedInput=w=>{only(w,['draft','host','port','user']);return w;};
const stamped=(record,principal)=>({...record,configuredAt:new Date().toISOString(),configuredBy:principal.username});
// What a telemetry set-up or connection is for: an added device, or a machine of the site configuration that can take
// an agent-less binding (no thermoId, not the router; the site's platform, when it names one, must be the provider's).
// Unknown id: 404. A site machine is only ever reached by a person signed in with a password (never a device token).
async function telemetryTarget(state,id,{provider=null,principal=null}={}){
 if(typeof id!=='string'||!DEVICE_ID.test(id))throw new Error('invalid');
 const target=await state.homeDevices.telemetryTarget(id);if(!target)throw new Error('not-found');
 if(target.site){
  if(principal&&principal.authKind!=='session')throw Object.assign(new Error('invalid'),{detail:'a machine from the site configuration is connected only by a person signed in with a password'});
  if(!target.bindable)throw Object.assign(new Error('invalid'),{detail:target.thermoId?'the site configuration reads this machine through Thermo (thermoId); its telemetry is set in the site files':'a router is reported by the router adapter'});
  if(provider&&!siteProviderFits({role:target.role,thermoId:target.thermoId,platform:target.sitePlatform},provider))throw Object.assign(new Error('invalid'),{detail:`the site configuration says this machine runs ${target.sitePlatform}; pick a provider for that system`});
 }
 return target;
}

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

// A connection that is no longer used (replaced, disconnected, its device removed): its poller forgets the device, and
// an app-managed SSH connection's key files go (WinRM, Node Exporter and Prometheus secrets went with their store entry).
const detach=async(state,id,entry)=>{if(!entry||!isFeed(entry.provider))return;state.feedPollers[entry.provider]?.removeHost(id);
 if(entry.provider===LINUX_SSH_PROVIDER)await state.windowsSetup?.forget(entry.record).catch(()=>{});};
// A removed device: stop reading it, whichever telemetry it had; an app-managed connection's key files go with it.
const forget=(state,gone)=>{if(gone.hadWindows){state.windowsPoller.removeHost(gone.device.id);void state.windowsSetup?.forget(gone.windows).catch(()=>{});}
 if(gone.feed)void detach(state,gone.device.id,gone.feed);
 if(!gone.hadWindows&&!gone.feed&&gone.hadLogin)state.thermoPoller.removeHost(gone.device.id);};
async function listMachines(state,hub,withStack=false){
 return machineList({site:hub.site,added:await state.homeDevices.list(),published:await state.homeDevices.stacks(),home:await state.payload(),withStack,siteTelemetry:await state.homeDevices.siteBindings(),siteOverrides:await state.homeDevices.siteOverrides()});
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
 const gone=await state.homeDevices.remove(input.id,{base:input.base});forget(state,gone);
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
const quietThermo=poller=>({interval:()=>poller.interval?.()||{intervalSeconds:15,lastPollAt:null},status:()=>({}),live:()=>({}),seconds:()=>[],minutes:()=>[],disks:()=>({}),gpuProcesses:()=>({})});
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

// --- integration "home.windows": Windows telemetry over SSH ------------------------------------------
export const WINDOWS_INTEGRATION='home.windows';
const quietWindows=poller=>({interval:()=>poller.interval?.(),status:()=>({}),live:()=>({}),seconds:()=>[],minutes:()=>[],disks:()=>({}),native:()=>({}),hosts:()=>poller.hosts?.()||[],targets:()=>poller.targets?.()||{},connections:()=>poller.connections?.()||{}});
// One read side for the overview and the charts: each machine id goes to the poller that owns it (the
// Windows devices to the Windows poller, everything else to Thermo). Both have the same shape.
// feeds: [{poller, ids}] for the other agent-less providers (windows/windowsIds is the first of them, kept by name).
export function telemetrySources({thermo,windows,windowsIds=[],feeds=[]}){
 const all=[...(windows?[{poller:windows,ids:windowsIds}]:[]),...feeds].map(f=>({poller:f.poller,ids:new Set(f.ids)}));
 const owner=id=>all.find(f=>f.ids.has(id))?.poller||null,pick=id=>owner(id)||thermo;
 const fed=id=>Boolean(owner(id));
 const merge=name=>{const a=thermo?.[name]?.()||{};const out=Object.fromEntries(Object.entries(a).filter(([id])=>!fed(id)));
  for(const f of all)for(const [id,v] of Object.entries(f.poller?.[name]?.()||{}))if(f.ids.has(id))out[id]=v;return out;};
 return {interval:()=>thermo?.interval?.()||{intervalSeconds:15,lastPollAt:null},
  status:()=>merge('status'),live:()=>merge('live'),disks:()=>merge('disks'),native:()=>merge('native'),targets:()=>merge('targets'),connections:()=>merge('connections'),
  // The busiest processes on each Mac's GPU (Thermo's snapshot); the other providers do not report them.
  gpuProcesses:()=>merge('gpuProcesses'),
  seconds:(id,since)=>pick(id)?.seconds?.(id,since)||[],minutes:id=>pick(id)?.minutes?.(id)||[],
  // Without a host list on every side, nobody is blamed for a missing login.
  hosts:()=>{const a=thermo?.hosts?.(),lists=all.map(f=>f.poller?.hosts?.());if(!Array.isArray(a)||lists.some(l=>!Array.isArray(l)))return undefined;
   return [...a.filter(id=>!fed(id)),...lists.flatMap((l,i)=>l.filter(id=>all[i].ids.has(id)))];}};
}
async function windowsStatus(state,hub,opts){return feedStatus(state,hub,WINDOWS_PROVIDER,opts);}
async function feedStatus(state,hub,provider,{enabled=true}={}){
 const {homeDevices}=state,poller=state.feedPollers[provider],errors=FEEDS[provider].errors;
 const configured=await (provider===WINDOWS_PROVIDER?homeDevices.windowsHosts():homeDevices.feedHosts(provider)).catch(()=>[]),added=await homeDevices.list().catch(()=>[]);
 const fromSite=new Set((await homeDevices.siteBindings().catch(()=>[])).filter(b=>b.provider===provider).map(b=>b.id));
 const status=enabled?poller.status?.()||{}:{},live=enabled?poller.live?.()||{}:{},now=Date.now();
 const items=configured.map(({id})=>{
  const st=status[id],lv=live[id],at=Number.isFinite(lv?.at)?new Date(lv.at).toISOString():null,fresh=Number.isFinite(lv?.at)&&now-lv.at<=TELEMETRY_STALE_SECONDS*1000;
  const base={id,label:added.find(d=>d.id===id)?.name||hub.site.machines.find(m=>m.id===id)?.name||id,lastSuccessAt:at};
  if(!enabled)return {...base,state:'disabled',summary:'Nečte se.'};
  if(st&&st.state!=='up')return {...base,state:'error',summary:errors[st.error]||'Neodpovídá.',lastError:st.error||'unavailable'};
  if(fresh)return {...base,state:'ok',summary:'Čte se živě.'};
  return {...base,state:'stale',summary:at?'Poslední čtení je staré.':'Zatím nic nepřečteno.'};
 });
 // A site machine connected on its tile counts as set up there (its identity stays in site.json; the binding is the hub's).
 const configuredBy=[...(configured.some(c=>!fromSite.has(c.id))?[{source:'ui',name:provider===WINDOWS_PROVIDER?'Přehled → Přidat zařízení → Windows':tx('Přehled → Přidat zařízení → {name}',{name:FEEDS[provider].name})}]:[]),
  ...(configured.some(c=>fromSite.has(c.id))?[{source:'ui',name:'Přehled → stroj z konfigurace webu → Telemetrie'}]:[])];
 if(!items.length)return {state:'not-configured',summary:provider===WINDOWS_PROVIDER?'Žádný stroj s Windows není připojený.':tx('Přes {name} není připojený žádný stroj.',{name:FEEDS[provider].name}),configuredBy,items};
 const ok=items.filter(i=>i.state==='ok').length,newest=items.map(i=>i.lastSuccessAt).filter(Boolean).sort().at(-1)||null;
 return {state:worstState(items.map(i=>i.state)),summary:provider===WINDOWS_PROVIDER?tx('Windows se čte z {ok} z {total} strojů.',{ok,total:items.length}):tx('{name} se čte z {ok} z {total} strojů.',{name:FEEDS[provider].name,ok,total:items.length}),lastSuccessAt:newest,
  lastError:items.find(i=>i.lastError)?.lastError||null,configuredBy,items};
}
const windowsIntegration={id:WINDOWS_INTEGRATION,title:'Telemetrie Windows (SSH)',kind:'telemetry',
 description:'CPU a jádra, GPU, paměť, disky a síť strojů s Windows, čtené přes SSH klíčem a pevným skriptem PowerShellu, který jen čte. Na Windows se nic neinstaluje. Vypnutá: hub se nepřipojuje a stroje s Windows jsou bez živých čísel.',
 howTo:'Na přehledu přidej zařízení (nebo uprav existující), zvol systém Windows a telemetrii Windows (SSH) a postupuj podle návodu v dialogu.',page:'overview',docs:'docs/API.md → Windows telemetry',
 status:windowsStatus,
 async test(state,hub){await state.windowsPoller.refresh?.().catch(()=>false);return windowsStatus(state,hub);}};
// The other agent-less providers, one integration each, so each can be turned off on its own.
const feedIntegration=(provider,title,description,howTo)=>({id:FEEDS[provider].integration,title,kind:'telemetry',description,howTo,page:'overview',docs:'docs/API.md → Agent-less telemetry',
 status:(state,hub,opts)=>feedStatus(state,hub,provider,opts),
 async test(state,hub){await state.feedPollers[provider].refresh?.().catch(()=>false);return feedStatus(state,hub,provider);}});
const FEED_INTEGRATIONS=[
 feedIntegration(WINRM_PROVIDER,'Telemetrie Windows (WinRM)','Stejné čítače Windows jako přes SSH, čtené pevnými dotazy WMI přes WinRM HTTPS s ověřováním Basic místním účtem, až po ověření certifikátu. Vypnutá: hub se nepřipojuje.','Na přehledu uprav zařízení s Windows, zvol Windows (WinRM) a postupuj podle návodu v dialogu.'),
 feedIntegration(NODE_EXPORTER_PROVIDER,'Telemetrie Linuxu (Node Exporter)','CPU a jádra, paměť, svazky, disky, síť a teploty Linuxu z /metrics Prometheus Node Exporteru, bez Prometheus serveru. Vypnutá: hub nic nečte.','Na přehledu přidej nebo uprav zařízení, zvol systém Linux a Linux (Node Exporter).'),
 feedIntegration(PROMETHEUS_PROVIDER,'Telemetrie Linuxu (Prometheus)','Metriky Linuxu jednoho cíle node_exporter z existujícího Prometheu přes jeho API jen ke čtení. Vypnutá: hub se Promethea neptá.','Na přehledu přidej nebo uprav zařízení, zvol systém Linux a Linux (Prometheus), načti cíle a vyber stroj.'),
 feedIntegration(LINUX_SSH_PROVIDER,'Telemetrie Linuxu (SSH)','CPU, paměť, svazky, disky, síť a teploty Linuxu přes SSH klíčem Home Hubu a pevný skript, který jen čte /proc a /sys. Vypnutá: hub se nepřipojuje.','Na přehledu přidej nebo uprav zařízení, zvol systém Linux a Linux (SSH).')];

// The record a draft yields for saving: Linux SSH from the SSH drafts (os linux), the others from the endpoint drafts.
async function claimFeed(state,principal,t,deviceId){
 if(!t||typeof t!=='object'||!isFeed(t.provider)||t.provider===WINDOWS_PROVIDER)throw new Error('invalid');
 if(t.provider===LINUX_SSH_PROVIDER){only(t,['provider','draft','host','port','user']);
  const record=await feedStep(LINUX_SSH_PROVIDER,'linux',LINUX_SETUP_ERRORS,state.windowsSetup.claim(principal.username,t.draft,t,{deviceId,os:'linux'}));
  return {provider:t.provider,draft:t.draft,record:stamped(record,principal)};}
 only(t,['provider','draft','host','port','scheme','user','auth','job','instance']);
 const record=await feedStep(t.provider,'endpoint',ENDPOINT_SETUP_ERRORS,Promise.resolve().then(()=>state.endpointSetup.claim(principal.username,t.draft,t,{deviceId,provider:t.provider})));
 return {provider:t.provider,draft:t.draft,record:stamped(record,principal)};
}
const releaseFeed=(state,provider,draft)=>provider===LINUX_SSH_PROVIDER?state.windowsSetup.release(draft):state.endpointSetup.release(draft);
const commitFeed=(state,provider,draft)=>provider===LINUX_SSH_PROVIDER?state.windowsSetup.commit(draft):state.endpointSetup.commit(draft);
// Linux over SSH: the SSH drafts of Windows, for os "linux" (POSIX user, the Linux collector), under their own paths.
const linuxStep=(c,fn)=>feedStep(LINUX_SSH_PROVIDER,'linux',LINUX_SETUP_ERRORS,Promise.resolve().then(fn));
const LINUX_SSH_ROUTES=[
 {method:'GET',path:'/api/home/devices/ssh/tools',error:homeError,handler:sessionFeed(async({json,state})=>json(200,await state.sshTools()))},
 {method:'POST',path:'/api/home/devices/ssh/draft',scope:null,error:homeError,handler:sessionFeed(async({input,json,state,principal})=>{
   only(input,['id','os']);if(input.os!=='linux')throw Object.assign(new Error('invalid'),{detail:'os must be linux'});
   let deviceId=null,current=null;
   if(input.id!==undefined){const device=await telemetryTarget(state,input.id,{provider:LINUX_SSH_PROVIDER,principal});deviceId=device.id;
    const entry=device.telemetryProvider===LINUX_SSH_PROVIDER?await state.homeDevices.feedEntry(device.id):null;current=entry?.provider===LINUX_SSH_PROVIDER?entry.record:null;}
   return json(201,{draft:await linuxStep(null,()=>state.windowsSetup.create(principal.username,{deviceId,current,os:'linux'}))});})},
 {method:'POST',path:'/api/home/devices/ssh/draft/key',scope:null,bodyLimit:32768,error:homeError,handler:sessionFeed(async({input,json,state,principal})=>{
   only(input,['draft','generate','privateKey']);const ask={generate:input.generate,privateKey:input.privateKey};
   const run=()=>state.windowsSetup.key(principal.username,input.draft,ask,{os:'linux'});
   return json(200,{draft:await linuxStep(null,()=>ask.generate===true?state.sshGate(run):run())});})},
 {method:'POST',path:'/api/home/devices/ssh/draft/scan',scope:null,error:homeError,handler:sessionFeed(async({input,json,state,principal})=>{
   only(input,['draft','host','port']);return json(200,{draft:await linuxStep(null,()=>state.sshGate(()=>state.windowsSetup.scan(principal.username,input.draft,input,{os:'linux'})))});})},
 {method:'POST',path:'/api/home/devices/ssh/draft/trust',scope:null,error:homeError,handler:sessionFeed(async({input,json,state,principal})=>{
   only(input,['draft','fingerprint']);return json(200,{draft:await linuxStep(null,()=>state.windowsSetup.trust(principal.username,input.draft,input,{os:'linux'}))});})},
 {method:'POST',path:'/api/home/devices/ssh/draft/test',scope:null,error:homeError,handler:sessionFeed(async({input,json,state,principal})=>{
   only(input,['draft','host','port','user']);return json(200,await linuxStep(null,()=>state.sshGate(()=>state.windowsSetup.test(principal.username,input.draft,input,{os:'linux'}))));})},
 {method:'POST',path:'/api/home/devices/ssh/draft/discard',scope:null,error:homeError,handler:sessionFeed(async({input,json,state,principal})=>{
   only(input,['draft']);await linuxStep(null,()=>state.windowsSetup.discard(principal.username,input.draft,{os:'linux'}));return json(200,{discarded:true});})}];
// WinRM, Node Exporter and Prometheus: the endpoint drafts (server/endpoint-setup.mjs). Every request to the machine
// (certificate, discovery, test) goes through the same gate as the SSH steps: at most two at once, never queued.
const endpointStep=(state,principal,id,fn)=>{const provider=state.endpointSetup.providerOf(principal.username,id)||NODE_EXPORTER_PROVIDER;
 return feedStep(provider,'endpoint',ENDPOINT_SETUP_ERRORS,Promise.resolve().then(fn));};
const ENDPOINT_ROUTES=[
 // The hub's own address in the site's networks, for the firewall line of the set-up guides (null: none there).
 {method:'GET',path:'/api/home/devices/hub-address',error:homeError,handler:sessionFeed(async({json,hub})=>json(200,{address:hubAddress(hub.site.lanCidrs||[])}))},
 {method:'POST',path:'/api/home/devices/endpoint/draft',scope:null,error:homeError,handler:sessionFeed(async({input,json,state,principal})=>{
   only(input,['id','provider']);if(!ENDPOINT_PROVIDERS.includes(input.provider))throw Object.assign(new Error('invalid'),{detail:`provider must be one of ${ENDPOINT_PROVIDERS.join(', ')}`});
   let deviceId=null,current=null;
   if(input.id!==undefined){const device=await telemetryTarget(state,input.id,{provider:input.provider,principal});deviceId=device.id;
    const entry=device.telemetryProvider===input.provider?await state.homeDevices.feedEntry(device.id):null;current=entry?.provider===input.provider?entry.record:null;}
   return json(201,{draft:await feedStep(input.provider,'endpoint',ENDPOINT_SETUP_ERRORS,Promise.resolve().then(()=>state.endpointSetup.create(principal.username,{provider:input.provider,deviceId,current})))});})},
 {method:'POST',path:'/api/home/devices/endpoint/draft/probe',scope:null,error:homeError,handler:sessionFeed(async({input,json,state,principal})=>{
   only(input,['draft','host','port']);return json(200,{draft:await endpointStep(state,principal,input.draft,()=>state.sshGate(()=>state.endpointSetup.probe(principal.username,input.draft,input)))});})},
 {method:'POST',path:'/api/home/devices/endpoint/draft/trust',scope:null,error:homeError,handler:sessionFeed(async({input,json,state,principal})=>{
   only(input,['draft','mode','fingerprint']);return json(200,{draft:await endpointStep(state,principal,input.draft,()=>state.endpointSetup.trust(principal.username,input.draft,input))});})},
 {method:'POST',path:'/api/home/devices/endpoint/draft/discover',scope:null,error:homeError,handler:sessionFeed(async({input,json,state,principal})=>{
   only(input,['draft','host','port','scheme','auth','user','password']);
   return json(200,await endpointStep(state,principal,input.draft,()=>state.sshGate(()=>state.endpointSetup.discover(principal.username,input.draft,input))));})},
 {method:'POST',path:'/api/home/devices/endpoint/draft/test',scope:null,error:homeError,handler:sessionFeed(async({input,json,state,principal})=>{
   only(input,['draft','host','port','scheme','auth','user','password','job','instance']);
   return json(200,await endpointStep(state,principal,input.draft,()=>state.sshGate(()=>state.endpointSetup.test(principal.username,input.draft,input))));})},
 {method:'POST',path:'/api/home/devices/endpoint/draft/discard',scope:null,error:homeError,handler:sessionFeed(async({input,json,state,principal})=>{
   only(input,['draft']);await endpointStep(state,principal,input.draft,()=>state.endpointSetup.discard(principal.username,input.draft));return json(200,{discarded:true});})}];

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
 picture:{type:['string','null'],enum:[...PICTURES,null],description:'One of the built-in pictures; null picks one by role. A picture the owner uploaded in the web UI takes precedence.'},
 platform:{type:['string','null'],enum:[...PLATFORMS,null],description:'Operating system, separate from role: macos, windows, linux or other; null = not said. Omit it to keep what the machine has. Windows telemetry (connected by the owner in the web UI) keeps it windows.'}}};
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
 assets:['home-view.js','home-charts.js','home-add-device.js','home-order.js','home-drag.js','home-telemetry.js','windows-setup.js','telemetry-setup.js','home.css','vendor/echarts.esm.min.mjs',...PICTURES.map(id=>`images/generic/${id}.svg`)],
 nav:[{groupKey:'Domov',hash:'overview',labelKey:'Přehled',view:'home-view.js#homePage',order:10}],
 apiDocs:[{title:'Domov',routes:[
  ['GET','/api/home/machines','read','Stroje: z konfigurace webu (jen ke čtení) a přidané, s otiskem. MCP machine_list.'],
  ['POST','/api/home/machines','home:write','Založit nebo nahradit stroj {machine, base?}. MCP machine_upsert.'],
  ['POST','/api/home/machines/remove','home:write','Odebrat přidaný stroj {id, base}. MCP machine_remove.'],
  ['POST','/api/home/runtime','home:write','Zveřejnit runtime stack stroje {machine, stack|null, base?}. MCP runtime_publish.']]}],
 setup(hub){
  const {site,directory,stateDirectory,options}=hub;
  const ids=homeMachineIds(site);
  const homeDevices=options.homeDevices||createHomeDevices(path.join(stateDirectory,'home'),{reserved:ids,lanCidrs:site.lanCidrs,siteMachines:site.machines});
  const thermoHostsFile=options.thermoHostsFile||process.env.THERMO_HOSTS_FILE||privateFile('thermo-hosts.json');
  const thermoPoller=options.thermoPoller||createThermoPoller({hostsFile:thermoHostsFile,extraHosts:()=>homeDevices.thermoHosts(),stateDirectory});
  // App-managed SSH: the hub's own keys and known_hosts (state/home/ssh), and the set-up drafts of the device dialog.
  // options.sshRun stands in for every OpenSSH tool the hub starts (tests); nothing else ever spawns one.
  const sshRun=options.sshRun||runSsh;
  const sshVault=options.sshVault||createSshVault(path.join(stateDirectory,'home','ssh'),{run:sshRun});
  const windowsSetup=options.windowsSetup||createWindowsSetup({vault:sshVault,run:sshRun,saved:()=>homeDevices.windowsSecrets()});
  const windowsPoller=options.windowsPoller||createWindowsPoller({stateDirectory,hosts:()=>homeDevices.windowsHosts(),collectManaged:record=>collectManaged(record,{vault:sshVault,run:sshRun})});
  // The HTTP(S) providers: options.endpointRequest / options.probeCertificate stand in for every request the hub makes to
  // a WinRM, Node Exporter or Prometheus endpoint (tests); nothing else opens such a connection.
  const request=options.endpointRequest||endpointRequest;
  const collectors={[WINRM_PROVIDER]:r=>collectWinrm(r,{request}),[NODE_EXPORTER_PROVIDER]:r=>collectNodeExporter(r,{request}),
   [PROMETHEUS_PROVIDER]:r=>collectPrometheus(r,{request}),[LINUX_SSH_PROVIDER]:r=>collectLinuxSsh(r,{vault:sshVault,run:sshRun})};
  const drivers={[WINRM_PROVIDER]:windowsDriver({provider:WINRM_PROVIDER,collect:c=>collectors[WINRM_PROVIDER](c.record),errors:WINRM_ERRORS,valid:validWinrmConfig,key:winrmKey,label:c=>winrmLabel(c.record),info:winrmInfo}),
   [NODE_EXPORTER_PROVIDER]:exporterDriver({collect:collectors[NODE_EXPORTER_PROVIDER]}),[PROMETHEUS_PROVIDER]:prometheusDriver({collect:collectors[PROMETHEUS_PROVIDER]}),
   [LINUX_SSH_PROVIDER]:linuxSshDriver({collect:collectors[LINUX_SSH_PROVIDER]})};
  // One poller per provider (each has its own off switch); a family shares its history directory, so a device that
  // switches between Windows over SSH and WinRM, or between the Linux sources, keeps its history.
  const feedPollers={[WINDOWS_PROVIDER]:windowsPoller,...Object.fromEntries(Object.keys(drivers).map(p=>[p,options.feedPollers?.[p]||createSnapshotPoller({driver:drivers[p],subdir:FEEDS[p].family,stateDirectory,
   hosts:()=>homeDevices.feedHosts(p),minIntervalMs:WINDOWS_MIN_INTERVAL_MS})]))};
  const endpointSetup=options.endpointSetup||createEndpointSetup({probe:options.probeCertificate||probeCertificate,discover:conn=>discoverTargets(conn,{request}),
   check:{[WINRM_PROVIDER]:async r=>winrmCheck(await collectors[WINRM_PROVIDER](r)),[NODE_EXPORTER_PROVIDER]:async r=>linuxCheck(await collectors[NODE_EXPORTER_PROVIDER](r)),
    [PROMETHEUS_PROVIDER]:async r=>({...linuxCheck(await collectors[PROMETHEUS_PROVIDER](r)),job:r.job,instance:r.instance})}});
  // Whether the OpenSSH client tools are there, asked at most once a minute.
  let tools=null;
  const toolsNow=()=>{if(!tools||Date.now()-tools.at>60000)tools={at:Date.now(),value:sshTools({run:sshRun})};return tools.value;};
  // The site's own tile pictures (<site images>/home/<id>.jpg), looked up once: the page then asks only for files that exist.
  const imagesDirectory=options.siteImagesDirectory===undefined?(options.site?null:siteConfigPath()&&path.join(path.dirname(siteConfigPath()),'images')):options.siteImagesDirectory;
  const sitePictures=Object.fromEntries(ids.filter(id=>imagesDirectory&&existsSync(path.join(imagesDirectory,'home',`${id}.jpg`))).map(id=>[id,`/images/home/${id}.jpg`]));
  const settled=async name=>Promise.all(hub.collect(name).map(v=>Promise.resolve(v).catch(()=>({}))));
  const merged=async name=>Object.assign({},...await settled(name));
  // Integrations an administrator turned off: the overview says so instead of showing nothing silently.
  const disabledIntegrations=()=>hub.registry.integrations.filter(i=>!hub.integrationEnabled(i.id)).map(i=>({id:i.id,title:i.title,...(i.titleKey?{titleKey:i.titleKey}:{}),kind:i.kind}));
  // The telemetry the overview reads: Thermo and Windows, each quiet while its integration is off.
  // bindings: the effective site bindings (homeDevices.siteBindings()); a site machine bound to a provider reads from its poller.
  const telemetry=(added,bindings=[])=>{const of=p=>[...added.filter(d=>feedOfDevice(d)===p).map(d=>d.id),...bindings.filter(b=>b.provider===p).map(b=>b.id)];
   return telemetrySources({thermo:hub.integrationEnabled(THERMO_INTEGRATION)?thermoPoller:quietThermo(thermoPoller),
   windows:hub.integrationEnabled(WINDOWS_INTEGRATION)?windowsPoller:quietWindows(windowsPoller),windowsIds:of(WINDOWS_PROVIDER),
   feeds:Object.keys(drivers).map(p=>({poller:hub.integrationEnabled(FEEDS[p].integration)?feedPollers[p]:quietWindows(feedPollers[p]),ids:of(p)}))});};
  const payload=async()=>{const added=await homeDevices.list(),bindings=await homeDevices.siteBindings();return {...buildHome({site,added,siteTelemetry:bindings,siteOverrides:await homeDevices.siteOverrides(),published:await homeDevices.stacks(),sitePictures,descriptors:await loadMachineDescriptors(process.env.MACHINES_DIR||path.join(directory,'machines'),ids),
   snapshots:await merged('home.snapshots'),runtimes:mergeRuntimeReports(await settled('home.runtimes')),thermo:telemetry(added,bindings),router:await readRouterFor(hub),probed:await merged('home.services')}),
   integrations:{disabled:disabledIntegrations()}};};
  // Thermo off: close the sessions and stop pulling; on again: pull right away. Neither waits for the network.
  if(!hub.integrationEnabled(THERMO_INTEGRATION))void thermoPoller.pause?.();
  if(!hub.integrationEnabled(WINDOWS_INTEGRATION))void windowsPoller.pause?.();
  for(const p of Object.keys(drivers))if(!hub.integrationEnabled(FEEDS[p].integration))void feedPollers[p].pause?.();
  hub.onIntegrationChange(e=>{
   if(e.id===THERMO_INTEGRATION)void Promise.resolve(e.enabled?thermoPoller.resume?.():thermoPoller.pause?.()).catch(()=>{});
   if(e.id===WINDOWS_INTEGRATION)void Promise.resolve(e.enabled?windowsPoller.resume?.():windowsPoller.pause?.()).catch(()=>{});
   for(const p of Object.keys(drivers))if(e.id===FEEDS[p].integration)void Promise.resolve(e.enabled?feedPollers[p].resume?.():feedPollers[p].pause?.()).catch(()=>{});});
  const sshGate=gate(2);
  return {homeDevices,thermoPoller,windowsPoller,feedPollers,endpointSetup,windowsSetup,sshVault,sshGate,sshTools:toolsNow,thermoHostsFile,payload,telemetry,checkThermo:options.checkThermo||checkThermoLogin,probeCert:options.probeCert||probeThermo,
   checkWindows:limited(options.checkWindows||(target=>checkWindows(target,{run:sshRun})),sshGate),
   machineIds:async()=>[...ids,...(await homeDevices.list()).map(d=>d.id)]};
 },
 pollers:[{id:'thermo',start:state=>state.thermoPoller.start(),stop:state=>state.thermoPoller.stop?.()},
  // The other agent-less providers: the same interval rule as Windows.
  {id:'feeds',start:async state=>{const s=state.thermoPoller.interval?.()?.intervalSeconds;
    await Promise.all(Object.entries(state.feedPollers).filter(([p])=>p!==WINDOWS_PROVIDER).map(([,poller])=>{if(Number.isFinite(s))poller.setIntervalMs?.(s*1000);return poller.start?.();}));},
   stop:state=>{for(const [p,poller] of Object.entries(state.feedPollers))if(p!==WINDOWS_PROVIDER)poller.stop?.();}},
  // Windows polls follow the overview's interval, never faster than WINDOWS_MIN_INTERVAL_MS (the poller enforces it).
  // First the key store is swept (files of drafts that never finished, of connections removed while the hub was down).
  {id:'windows',start:async state=>{await state.windowsSetup.start?.();const s=state.thermoPoller.interval?.()?.intervalSeconds;if(Number.isFinite(s))state.windowsPoller.setIntervalMs?.(s*1000);return state.windowsPoller.start();},
   stop:state=>{state.windowsSetup.stop?.();return state.windowsPoller.stop?.();}}],
 integrations:[thermoIntegration,windowsIntegration,...FEED_INTEGRATIONS],
 // Integrations → Machines: how each machine's telemetry is read (server/machine-facets.mjs).
 provides:{[FACETS_POINT]:(state,hub)=>machines=>telemetryFacet(machines,{enabled:id=>hub.integrationEnabled(id),thermoIntegration:THERMO_INTEGRATION})},
 mcpInstructions:[
  'Machines: home_status is the live state (online, load, temperature, memory, services). machine_list is what the overview holds: each machine with its hash, where it comes from and where its runtime stack comes from.',
  {scope:'home:write',text:'With home:write: machine_upsert adds or replaces a machine and machine_remove removes one (pass the hash from machine_list as base; machines from the site configuration are read-only). runtime_publish replaces the runtime stack drawn on a machine\'s page: what clients call, launchers, model servers, engines and the chip.'},
 ],
 mcpTools:[
  {name:'machine_list',scope:'read',title:'Overview: list machines',
   description:'The machines on the Home Hub overview: those from the site configuration (source "site", read-only here; the owner may override their display name, address, hardware and picture in the web UI, listed in siteOverride) and those added in the web UI or by an agent (source "ui" / "agent"), each with its hash, telemetry state and where its runtime stack comes from. Also returns the built-in picture ids, the roles, the site networks an ip must lie in and the telemetry agent to install. Pass runtime:true to get each published runtime stack as well.',
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
    const added=await state.homeDevices.list(),bindings=await state.homeDevices.siteBindings(),q=homeHistoryQuery(query,added,hub.site,bindings);
    if(q.reason)return json(200,q);
    // The provider that reads it: an added device's own, or the binding of a site machine.
    const device=added.find(d=>d.id===q.machine),feed=feedOfDevice(device)||bindings.find(b=>b.id===q.machine)?.provider||null,viaWindows=feed===WINDOWS_PROVIDER;
    if(feed&&!hub.integrationEnabled(FEEDS[feed].integration))return json(200,{...q,points:[],complete:false,source:'vypnuto',reason:viaWindows?'Telemetrie Windows je vypnutá administrátorem.':tx('Telemetrie {name} je vypnutá administrátorem.',{name:FEEDS[feed].name}),disabled:hub.integrationDisabled(FEEDS[feed].integration)});
    if(!feed&&!hub.integrationEnabled(THERMO_INTEGRATION))return json(200,{...q,points:[],complete:false,source:'vypnuto',reason:'Telemetrie Thermo je vypnutá administrátorem.',disabled:hub.integrationDisabled(THERMO_INTEGRATION)});
    // A machine reads the Thermo host named by its thermoId (a device connected on the overview is its own host);
    // a Windows device is its own host on the Windows poller.
    const thermoId=hub.site.machines.find(m=>m.id===q.machine)?.thermoId||device?.thermoId||q.machine;
    const h=homeHistory(state.telemetry(added,bindings),thermoId,q.range,undefined,[thermoId]);
    const label=viaWindows?'Windows':feed?FEEDS[feed].name:null;
    return json(200,{...h,...(label?{source:h.source.replace('Thermo',label),...(h.status?{status:h.status.replace('Thermo',label)}:{})}:{}),machine:q.machine});}},
  {method:'POST',path:'/api/home/settings',scope:'home:settings',error:homeError,async handler({input,json,state}){const ms=Number(input?.intervalSeconds)*1000;await state.thermoPoller.setIntervalMs(ms);for(const p of Object.values(state.feedPollers))p.setIntervalMs?.(ms);return json(200,await state.payload());}},
  // Refresh button: pull Thermo now (rate-limited in the poller), then return fresh tiles. Reads only.
  {method:'POST',path:'/api/home/refresh',scope:'read',error:homeError,async handler({json,state}){const [pulled]=await Promise.all([state.thermoPoller.refresh().catch(()=>false),...Object.values(state.feedPollers).map(p=>p.refresh?.().catch(()=>false))]);return json(200,{...await state.payload(),refresh:{pulled:pulled===true,at:new Date().toISOString()}});}},
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
    const gone=await state.homeDevices.remove(input.id);forget(state,gone);return json(200,{removed:gone.device.id});})},
  // Windows telemetry through an older SSH alias: try a target without storing anything. {target} → what the
  // machine reports (Windows version, CPU, memory, volumes, GPUs), or 422 WINDOWS_SSH_FAILED with a reason and what to do.
  {method:'POST',path:'/api/home/devices/windows/check',scope:null,error:homeError,handler:devices(async({input,json,state})=>{
    if(!input||typeof input!=='object'||Object.keys(input).some(k=>k!=='target')||!validSshTarget(input.target))throw new Error('invalid');
    return json(200,await tryWindows(state,input.target));})},
  // App-managed SSH (server/windows-ssh.mjs): the device dialog builds a connection in a server-side draft, step
  // by step: key, host key, trust, test. Every reply carries the draft as the browser may see it (no private key).
  {method:'GET',path:'/api/home/devices/windows/tools',error:homeError,handler:sessionWrite(async({json,state})=>json(200,await state.sshTools()))},
  {method:'POST',path:'/api/home/devices/windows/draft',scope:null,error:homeError,handler:sessionWrite(async({input,json,state,principal})=>{
    only(input,['id']);let deviceId=null,current=null;
    if(input.id!==undefined){
     const device=await telemetryTarget(state,input.id,{provider:WINDOWS_PROVIDER,principal});
     deviceId=device.id;
     const entry=device.telemetryProvider===WINDOWS_PROVIDER?await state.homeDevices.windowsEntry(device.id):null;
     current=entry?.mode==='managed'?entry:null;}
    return json(201,{draft:await state.windowsSetup.create(principal.username,{deviceId,current})});})},
  // {draft, generate:true} makes a new key; {draft, privateKey:"…"} imports one (at most 16 KiB of text).
  {method:'POST',path:'/api/home/devices/windows/draft/key',scope:null,bodyLimit:32768,error:homeError,handler:sessionWrite(async({input,json,state,principal})=>{
    only(input,['draft','generate','privateKey']);
    const ask={generate:input.generate,privateKey:input.privateKey};// exactly one of them (checked by the set-up)
    const draft=ask.generate===true?await state.sshGate(()=>state.windowsSetup.key(principal.username,input.draft,ask,{os:'windows'})):await state.windowsSetup.key(principal.username,input.draft,ask,{os:'windows'});
    return json(200,{draft});})},
  {method:'POST',path:'/api/home/devices/windows/draft/scan',scope:null,error:homeError,handler:sessionWrite(async({input,json,state,principal})=>{
    only(input,['draft','host','port']);
    return json(200,{draft:await sshStep(state.sshGate(()=>state.windowsSetup.scan(principal.username,input.draft,input,{os:'windows'})))});})},
  {method:'POST',path:'/api/home/devices/windows/draft/trust',scope:null,error:homeError,handler:sessionWrite(async({input,json,state,principal})=>{
    only(input,['draft','fingerprint']);
    return json(200,{draft:await state.windowsSetup.trust(principal.username,input.draft,input,{os:'windows'})});})},
  {method:'POST',path:'/api/home/devices/windows/draft/test',scope:null,error:homeError,handler:sessionWrite(async({input,json,state,principal})=>{
    only(input,['draft','host','port','user']);
    return json(200,await sshStep(state.sshGate(()=>state.windowsSetup.test(principal.username,input.draft,input,{os:'windows'}))));})},
  // The dialog was closed without saving: the draft's key and known_hosts go now, not only when it expires.
  {method:'POST',path:'/api/home/devices/windows/draft/discard',scope:null,error:homeError,handler:sessionWrite(async({input,json,state,principal})=>{
    only(input,['draft']);await state.windowsSetup.discard(principal.username,input.draft,{os:'windows'});return json(200,{discarded:true});})},
  ...LINUX_SSH_ROUTES,...ENDPOINT_ROUTES,
  // Connect a device that is already on the overview to Windows telemetry, or change its connection:
  //   {id, windows:{draft, host, port, user}}  an app-managed connection whose draft (made for this device) passed its test
  //   {id, windows:{target}}                   an older SSH alias (tried once first)
  //   {id, windows:null}                       disconnect
  // The device keeps its id, picture and history; the connection it replaces is forgotten, with its key files.
  {method:'POST',path:'/api/home/devices/windows',scope:null,error:homeError,handler:devices(async({input,json,state,principal})=>{
    if(!input||typeof input!=='object'||Object.keys(input).some(k=>!['id','windows'].includes(k))||typeof input.id!=='string'||!DEVICE_ID.test(input.id)||input.windows===undefined)throw new Error('invalid');
    // A machine of the site configuration: password sign-in only, and only a managed connection (the store refuses an alias).
    const device=await state.homeDevices.telemetryTarget(input.id);
    if(device?.site&&principal.authKind!=='session')throw Object.assign(new Error('invalid'),{detail:'a machine from the site configuration is connected only by a person signed in with a password'});
    if(input.windows===null){const r=await state.homeDevices.setWindows(input.id,null);if(r.hadLogin)state.windowsPoller.removeHost(input.id);await state.windowsSetup.forget(r.previous);return json(200,r.device);}
    if(!device)throw new Error('not-found');
    if(device.site)await telemetryTarget(state,device.id,{provider:WINDOWS_PROVIDER,principal});
    if(!input.windows||typeof input.windows!=='object')throw new Error('invalid');
    if(device.thermoId)throw Object.assign(new Error('invalid'),{detail:'disconnect Thermo first'});
    if(input.windows.draft!==undefined){
     if(principal.authKind!=='session')throw new Error('invalid');
     const w=managedInput(input.windows),managed=stamped(await state.windowsSetup.claim(principal.username,w.draft,w,{deviceId:device.id}),principal);
     let r;try{r=await state.homeDevices.setWindows(device.id,undefined,{managed,by:principal.username});}catch(e){await state.windowsSetup.release(w.draft);throw e;}
     state.windowsSetup.commit(w.draft);await state.windowsSetup.forget(r.previous,{keep:managed});await detach(state,device.id,r.replaced);
     state.windowsPoller.addHost(r.windows);return json(200,r.device);}
    const target=input.windows.target;
    if(!validSshTarget(target)||device.site)throw Object.assign(new Error('invalid'),device.site?{detail:'a machine from the site configuration connects Windows over SSH only with a connection Home Hub manages'}:{});
    await tryWindows(state,target);
    const r=await state.homeDevices.setWindows(input.id,input.windows);await state.windowsSetup.forget(r.previous);await detach(state,input.id,r.replaced);state.windowsPoller.addHost(r.windows);return json(200,r.device);})},
  // Connect a device that is already on the overview to WinRM, Node Exporter, Prometheus or Linux SSH, switch it from
  // another agent-less provider (deliberately: the old connection, its poller and its secrets go), or disconnect it:
  //   {id, telemetry:{provider, draft, host, port, scheme?, user?, auth?, job?, instance?}}  a draft (made for this device) that passed its fresh test
  //   {id, telemetry:null}                                                                    disconnect whichever agent-less provider reads it
  // The device keeps its id, picture and history. Password sign-in only: drafts belong to a browser session.
  {method:'POST',path:'/api/home/devices/telemetry',scope:null,error:homeError,handler:sessionFeed(async({input,json,state,principal})=>{
    only(input,['id','telemetry']);
    if(typeof input.id!=='string'||!DEVICE_ID.test(input.id)||input.telemetry===undefined)throw new Error('invalid');
    // Disconnect: the device or site machine (a binding whose machine left site.json is cleared here as well).
    if(input.telemetry===null){const r=await state.homeDevices.setFeed(input.id,null);await detach(state,input.id,r.previous);
     if(r.previousWindows){state.windowsPoller.removeHost(input.id);await state.windowsSetup.forget(r.previousWindows);}return json(200,r.device);}
    const device=await telemetryTarget(state,input.id,{provider:isFeed(input.telemetry?.provider)?input.telemetry.provider:null,principal});
    if(device.thermoId)throw Object.assign(new Error('invalid'),{detail:'disconnect Thermo first'});
    const {provider,record,draft}=await claimFeed(state,principal,input.telemetry,device.id);
    let r;try{r=await state.homeDevices.setFeed(device.id,{provider,record},{by:principal.username});}catch(e){releaseFeed(state,provider,draft);throw e;}
    commitFeed(state,provider,draft);
    if(r.previous&&(r.previous.provider!==provider||r.previous.record!==record)){if(r.previous.provider!==provider)state.feedPollers[r.previous.provider]?.removeHost(device.id);
     if(r.previous.provider===LINUX_SSH_PROVIDER)await state.windowsSetup.forget(r.previous.record,{keep:provider===LINUX_SSH_PROVIDER?record:null}).catch(()=>{});}
    if(r.previousWindows){state.windowsPoller.removeHost(device.id);await state.windowsSetup.forget(r.previousWindows,{keep:provider===LINUX_SSH_PROVIDER?record:null});}
    state.feedPollers[provider].addHost(r.feed);return json(200,r.device);})},
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
    // A Windows device with an app-managed connection: its draft (made for a new device) must have passed its test
    // with exactly what is sent; nothing is stored otherwise.
    if(input?.kind==='windows'&&input.windows&&typeof input.windows==='object'&&input.windows.draft!==undefined){
     if(principal.authKind!=='session')throw new Error('invalid');
     const w=managedInput(input.windows),managed=stamped(await state.windowsSetup.claim(principal.username,w.draft,w,{deviceId:null}),principal);
     let saved;try{saved=await state.homeDevices.add({...input,windows:undefined},principal.username,{managed});}catch(e){await state.windowsSetup.release(w.draft);throw e;}
     state.windowsSetup.commit(w.draft);state.windowsPoller.addHost(saved.windows);return json(201,saved.device);}
    // A device read by WinRM, Node Exporter, Prometheus or Linux SSH: its draft (made for a new device) must have passed its fresh test.
    if(Object.hasOwn(FEEDS,input?.kind)&&input.kind!==WINDOWS_PROVIDER){
     if(principal.authKind!=='session')throw new Error('invalid');
     if(!input.telemetry||typeof input.telemetry!=='object'||input.telemetry.provider!==input.kind)throw new Error('invalid');
     const {provider,record,draft}=await claimFeed(state,principal,input.telemetry,null);
     const {telemetry:_t,...fields}=input;
     let saved;try{saved=await state.homeDevices.add(fields,principal.username,{feed:{provider,record}});}catch(e){releaseFeed(state,provider,draft);throw e;}
     commitFeed(state,provider,draft);state.feedPollers[provider].addHost(saved.feed);return json(201,saved.device);}
    // A Windows device through an older SSH alias: the SSH connection is tried once before anything is stored.
    if(input?.kind==='windows'&&validSshTarget(input?.windows?.target))await tryWindows(state,input.windows.target);
    const saved=await state.homeDevices.add(input,principal.username);if(saved.thermo)state.thermoPoller.addHost(saved.thermo);if(saved.windows)state.windowsPoller.addHost(saved.windows);
    return json(201,saved.device);})},
  // A machine of the site configuration, edited on its tile: {id, base, machine:{name?, hostname?, ip?, hardware?, picture?}}
  // replaces the owner's override (absent fields go back to the site's values); base = siteOverride.hash from GET /api/home.
  // Only display metadata: id, role, platform, thermoId and the collectors' wiring stay in site.json, which is never written.
  {method:'POST',path:'/api/home/devices/site',scope:null,error:homeError,handler:siteEdit(async({input,json,state,principal})=>{
    only(input,['id','base','machine']);
    if(typeof input.id!=='string'||!DEVICE_ID.test(input.id))throw Object.assign(new Error('invalid'),{detail:'id must be a machine id'});
    if(!state.homeDevices.isSiteMachine(input.id))throw new Error('not-found');
    return json(200,await state.homeDevices.setSiteOverride(input.id,input.machine,{by:principal.username,base:input.base}));})},
  // Back to the site's defaults: the override and the uploaded picture go. {id, base}.
  {method:'POST',path:'/api/home/devices/site/reset',scope:null,error:homeError,handler:siteEdit(async({input,json,state})=>{
    only(input,['id','base']);
    if(typeof input.id!=='string'||!DEVICE_ID.test(input.id))throw Object.assign(new Error('invalid'),{detail:'id must be a machine id'});
    return json(200,await state.homeDevices.resetSiteOverride(input.id,{base:input.base}));})},
  // Back to a built-in picture: the uploaded one is deleted. A site machine (password sign-in only) goes back to its override's or the site's.
  {method:'POST',path:'/api/home/devices/image/remove',scope:null,error:homeError,handler:devices(async({input,json,error,state,principal})=>{
    if(!input||typeof input!=='object'||Object.keys(input).some(k=>k!=='id')||typeof input.id!=='string'||!DEVICE_ID.test(input.id))throw new Error('invalid');
    if(state.homeDevices.isSiteMachine(input.id)&&principal.authKind!=='session')return error(403,'SESSION_REQUIRED','Stroj z konfigurace webu upravuje jen účet se zápisem, přihlášený heslem.');
    return json(200,await state.homeDevices.removeImage(input.id,{by:principal.username}));})},
  // An added device's tile picture: one JPEG cropped in the browser (at most 3 MiB). Password sign-in only.
  {method:'PUT',match:/^\/api\/home\/devices\/([a-z][a-z0-9_-]{1,31})\/image$/,scope:null,raw:true,contentType:'image/jpeg',denied:'Zařízení přidává jen účet se zápisem, přihlášený heslem.',error:homeError,
   async handler({req,params,json,error,state,principal}){
    // A site machine's own picture: password sign-in only, like the rest of its edit.
    if(state.homeDevices.isSiteMachine(params[1])&&principal.authKind!=='session'){req.resume();return error(403,'SESSION_REQUIRED','Stroj z konfigurace webu upravuje jen účet se zápisem, přihlášený heslem.');}
    try{return json(200,await state.homeDevices.putImage(params[1],req,Number(req.headers['content-length']),{by:principal.username}));}
    catch(e){req.resume();return error(({invalid:400,'not-found':404,'too-large':413})[e.message]||503,'DEVICE_FAILED',({invalid:'Obrázek musí být JPEG.','not-found':'Zařízení neexistuje.','too-large':'Obrázek je větší než 3 MB.'})[e.message]||'Obrázek nejde uložit.');}}},
  // The picture the owner uploaded for a machine of the site configuration (its override). Not under /images/home/, where
  // the site's own picture of the same id is a static file and would win.
  {method:'GET',match:/^\/api\/home\/devices\/([a-z][a-z0-9_-]{1,31})\/image$/,async handler({params,res,error,state}){
    if(!state.homeDevices.isSiteMachine(params[1])||!(await state.homeDevices.siteOverrides())[params[1]]?.image)return error(404,'NOT_FOUND','Not found.');
    let file;try{file=await state.homeDevices.image(params[1]);}catch{return error(404,'NOT_FOUND','Not found.');}
    res.setHeader('Cache-Control','private, max-age=86400');res.writeHead(200,{'Content-Type':'image/jpeg'});return res.end(await readFile(file));}},
  // The picture of an added device, from state (a site's own machine pictures are static files and win).
  {method:'GET',match:/^\/images\/home\/([a-z][a-z0-9_-]{1,31})\.jpg$/,async handler({params,res,error,state}){
    let file;try{file=await state.homeDevices.image(params[1]);}catch{return error(404,'NOT_FOUND','Not found.');}
    res.setHeader('Cache-Control','private, max-age=86400');res.writeHead(200,{'Content-Type':'image/jpeg'});return res.end(await readFile(file));}},
 ],
};
