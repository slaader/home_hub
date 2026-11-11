// Core module "runtimes": local LLM runtimes read directly over HTTP (llama-swap, Ollama, LM Studio,
// llama.cpp server, vLLM, SGLang, oMLX, mlx-serve, anything OpenAI-compatible), for a hub that can reach
// them: on loopback when it runs on the same machine, or on the LAN. No agent on the machine is needed.
//
// It provides home.runtimes (docs/plugins.md), which home merges with any plugin that provides the same
// (server/home-data.mjs → mergeRuntimeReports). Endpoints come from site.json → runtimes[] and from the API
// (stored in <state>/runtimes-config.json); a bearer token, when a runtime needs one, is stored server-side
// and never returned. Every read is a GET on an allowlisted path (server/runtime-adapters.mjs).
//
// It also keeps its own request history of the llama-swap endpoints (server/runtime-history.mjs: the activity
// buffer, joined to the access-log stream for the client) under <state>/runtimes/<machine>/, and provides it
// as runtimes.requests for the LLM & Diffusion page.
//
// It declares itself as an integration (id runtimes.endpoints) for the integrations page: status() and
// test() return {state, summary, lastSuccessAt, lastError, configuredBy, items}; while hub.integrationEnabled
// says it is off, nothing is read (no poll, no history read, no stream held open) and nothing is provided.
import path from 'node:path';
import {runtimesFacet} from '../machine-facet-sources.mjs';
import {FACETS_POINT} from '../machine-facets.mjs';
import {toolError} from '../mcp.mjs';
import {RUNTIME_KINDS,RUNTIME_ENDPOINT_ID,RUNTIME_ENDPOINT_LIMIT} from '../site-config.mjs';
import {KIND_NAMES,READ_PATHS} from '../runtime-adapters.mjs';
import {createEndpointStore,createTokenStore,createRuntimePoller,allEndpoints,checkEndpoint,DEFAULT_INTERVAL_MS} from '../runtimes-data.mjs';
import {createRequestHistory,createHistoryCollector,HISTORY_READS} from '../runtime-history.mjs';
import {tx,sentences} from '../text.mjs';

export const INTEGRATION_ID='runtimes.endpoints';
const isEnabled=async hub=>typeof hub.integrationEnabled!=='function'||(await hub.integrationEnabled(INTEGRATION_ID))!==false;
const actor=principal=>({by:principal.username,source:principal.authKind==='api-key'?'agent':'ui'});

// One code per refusal (the message is in the source language; details name the field).
const ERRORS={
 invalid:[400,'RUNTIME_ENDPOINT_INVALID','Neplatný endpoint: zkontroluj stroj, druh a adresu (jen počátek URL, loopback nebo adresa v síti webu).'],
 'not-found':[404,'RUNTIME_ENDPOINT_NOT_FOUND','Takový endpoint není.'],
 'read-only':[403,'RUNTIME_ENDPOINT_READ_ONLY','Tenhle endpoint je z konfigurace webu (site.json) a přes API se nemění.'],
 conflict:[409,'RUNTIME_ENDPOINT_CONFLICT','Tuhle adresu už čte jiný endpoint.'],
 limit:[409,'RUNTIME_ENDPOINT_LIMIT','Endpointů může být nejvýš 40.']};
const TOOL_ERRORS={invalid:'Invalid endpoint','not-found':'No such endpoint. Use runtime_endpoints_list to see the ids',
 'read-only':'This endpoint comes from the site configuration (site.json) and cannot be changed through the API',
 conflict:'Another endpoint already reads this URL',limit:`At most ${RUNTIME_ENDPOINT_LIMIT} endpoints; remove one first`};
const routeErrors=handler=>async c=>{try{return await handler(c);}catch(e){
 const known=ERRORS[e.message];if(!known)throw e;
 return c.json(known[0],{error:{code:known[1],message:known[2],...(e.detail?{details:[e.detail]}:{})}});}};
const tool=async fn=>{try{return await fn();}catch(e){if(!TOOL_ERRORS[e.message])throw e;throw toolError(`${TOOL_ERRORS[e.message]}${e.detail?`: ${e.detail}`:''}. Nothing was changed.`);}};
const only=(input,keys)=>{if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!keys.includes(k)))throw Object.assign(new Error('invalid'),{detail:`expected only: ${keys.join(', ')}`});return input;};
const idOf=input=>{if(typeof input.id!=='string'||!RUNTIME_ENDPOINT_ID.test(input.id))throw Object.assign(new Error('invalid'),{detail:'id must be an endpoint id from runtime_endpoints_list'});return input.id;};
// Wait a little for the first read of a new endpoint, so the answer can say whether it works.
const settle=(p,ms)=>Promise.race([p,new Promise(r=>setTimeout(r,ms).unref?.())]).catch(()=>{});

async function listEndpoints(state,hub=null){
 const tokenIds=new Set(await state.tokens.ids());
 const endpoints=await Promise.all((await state.endpoints()).map(async e=>{const h=hub?await historyOf(state,hub,e):null;
  return {...e,hasToken:tokenIds.has(e.id),...state.poller.status(e.id),...(h?{history:(({sentence,...x})=>x)(h)}:{})};}));
 return {endpoints,kinds:[...RUNTIME_KINDS],readPaths:[...READ_PATHS],historyReadPaths:[...HISTORY_READS],limits:{endpoints:RUNTIME_ENDPOINT_LIMIT},intervalSeconds:Math.round(state.intervalMs/1000)};
}
async function upsertEndpoint(state,hub,input,principal){
 only(input,['endpoint']);
 const existing=await state.endpoints(),machines=await hub.state('home').machineIds();
 const e=checkEndpoint(input.endpoint,{site:hub.site,machines,existing});
 const r=await state.store.upsert({...e,...actor(principal)});
 await settle(state.poller.poll({force:true}),5000);
 return {ok:true,id:e.id,created:r.created,changed:r.changed,by:principal.username,endpoint:{...e,source:r.entry.source,...state.poller.status(e.id)}};
}
async function removeEndpoint(state,input){
 only(input,['id']);const id=idOf(input);
 const found=(await state.endpoints()).find(e=>e.id===id);if(!found)throw new Error('not-found');
 if(found.readOnly)throw Object.assign(new Error('read-only'),{detail:`endpoint ${id} comes from the site configuration`});
 await state.store.remove(id);await state.tokens.set(id,null).catch(()=>{});
 void state.poller.poll({force:true}).catch(()=>{});
 return {ok:true,id,removed:true};
}

// --- the integration --------------------------------------------------------------------------
const hostOf=url=>{try{return new URL(url).host;}catch{return url;}};
function itemOf(e,st,result){
 const label=`${e.name||KIND_NAMES[st.detectedKind]||KIND_NAMES[e.kind]||'runtime'} · ${e.machine} · ${hostOf(e.url)}`;
 let summary;
 if(st.state==='ok'){const n=result?.models?.length||0,loaded=(result?.models||[]).filter(m=>m.state==='loaded').length;
  summary=tx('{kind} · modelů {n}, načteno {loaded}',{kind:KIND_NAMES[st.detectedKind]||st.detectedKind||e.kind,n,loaded});}
 else if(st.state==='off')summary=tx('neodpovídá: na {host} nic neposlouchá (runtime neběží?)',{host:hostOf(e.url)});
 else if(st.state==='waiting')summary=tx('čeká na první čtení');
 else if(st.state==='stale')summary=tx('stará data, poslední chyba: {error}',{error:st.lastError||'—'});
 else summary=tx('chyba: {error}',{error:st.lastError||'—'});
 return {id:e.id,label,state:st.state==='waiting'?'stale':st.state,summary,...(st.lastSuccessAt?{lastSuccessAt:st.lastSuccessAt}:{}),
  ...(st.lastError?{lastError:st.lastError}:{}),machine:e.machine,url:e.url,kind:e.kind,detectedKind:st.detectedKind};
}
// The start of today on the site's clock, and a time as HH:MM there (with the date when it is not today).
function siteClock(timeZone,now){
 const zone=timeZone||'UTC';let parts;
 try{parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:zone,hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'}).formatToParts(now).map(x=>[x.type,x.value]));}
 catch{return siteClock('UTC',now);}
 const off=Date.UTC(+parts.year,+parts.month-1,+parts.day,+parts.hour%24,+parts.minute,+parts.second)-Math.floor(now/1000)*1000;
 const since=Math.floor((now+off)/86400000)*86400000-off;
 const label=iso=>{const ms=Date.parse(iso),local=new Date(ms+off).toISOString();return ms>=since?local.slice(11,16):`${local.slice(0,10)} ${local.slice(11,16)}`;};
 return {since,label};
}
// "historie: naposledy 14:05, dnes 12 záznamů" for an endpoint whose history the hub keeps.
async function historyOf(state,hub,e,now=Date.now()){
 const h=state.history.status(e.id);if(!h)return null;
 const clock=siteClock(hub.site?.timeZone,now),s=await state.requests.summary(e.machine,{since:clock.since,now}).catch(()=>null);
 const out={lastSyncAt:h.lastSyncAt,lastIngestedAt:s?.lastAddedAt||null,recordsToday:s?.recordsToday??0,stream:h.stream.state,...(h.lastError?{lastError:h.lastError}:{})};
 const when=out.lastIngestedAt?clock.label(out.lastIngestedAt):'—';
 const stream=h.stream.state==='connected'?tx('· klienti z logu'):tx('· log klientů nedostupný');
 return {...out,sentence:sentences(tx('· historie: naposledy přibyla {time}, dnes záznamů {n}',{time:when,n:out.recordsToday}),stream)};
}
export async function integrationStatus(state,hub){
 const list=await state.endpoints();
 const configuredBy=[];
 for(const e of list){const who=e.source==='site'?{source:'site',name:'site.json'}:{source:e.source,name:e.addedBy||'—'};
  if(!configuredBy.some(x=>x.source===who.source&&x.name===who.name))configuredBy.push(who);}
 if(!await isEnabled(hub))return {state:'disabled',summary:tx('Vypnuto: endpointy se nečtou.'),configuredBy,
  items:list.map(e=>({id:e.id,label:`${e.name||KIND_NAMES[e.kind]||'runtime'} · ${e.machine} · ${hostOf(e.url)}`,state:'disabled',summary:''}))};
 if(!list.length)return {state:'not-configured',summary:tx('Žádný endpoint: přidej ho v site.json → runtimes, přes API nebo nástrojem runtime_endpoint_upsert.'),configuredBy,items:[]};
 const items=await Promise.all(list.map(async e=>{const item=itemOf(e,state.poller.status(e.id),state.poller.states.get(e.id)?.result),h=await historyOf(state,hub,e);
  return h?{...item,summary:sentences(item.summary,h.sentence)}:item;}));
 const count=s=>items.filter(i=>i.state===s).length,ok=count('ok'),off=count('off'),bad=count('error'),old=count('stale');
 const overall=ok===items.length?'ok':bad&&!ok&&!old?'error':bad||old?'stale':ok?'ok':'off';
 const successes=items.map(i=>i.lastSuccessAt).filter(Boolean).sort(),errors=items.filter(i=>i.lastError);
 return {state:overall,summary:tx(items.length===1?'{ok} z {n} endpointu odpovídá':'{ok} z {n} endpointů odpovídá',{ok,n:items.length}),
  ...(successes.length?{lastSuccessAt:successes.at(-1)}:{}),...(errors.length?{lastError:`${errors[0].id}: ${errors[0].lastError}`}:{}),configuredBy,items};
}

const ENDPOINT_SCHEMA={type:'object',required:['machine','url'],additionalProperties:false,properties:{
 id:{type:'string',pattern:RUNTIME_ENDPOINT_ID.source,description:'Stable id of the endpoint; the key for updates and removal. Default: <machine>-<port>.'},
 machine:{type:'string',pattern:'^[a-z][a-z0-9_-]{1,31}$',description:'The machine the runtime runs on (an id from machine_list).'},
 kind:{type:'string',enum:[...RUNTIME_KINDS],description:'What runs there; auto (default) detects it with read-only requests.'},
 url:{type:'string',maxLength:120,description:'Origin only, e.g. http://127.0.0.1:11434 or http://10.0.0.5:1234: no path, no user or password. Loopback, or an address inside the site networks.'},
 name:{type:'string',maxLength:60,description:'What the machine page calls it; default: the runtime\'s name.'}}};

export default {
 id:'runtimes',title:'LLM runtimes',
 apiDocs:[{title:'LLM runtimy',routes:[
  ['GET','/api/runtimes/endpoints','read','Endpointy LLM runtimů, které hub čte přímo, se stavem posledního čtení. MCP runtime_endpoints_list.'],
  ['POST','/api/runtimes/endpoints','home:write','Přidat nebo nahradit endpoint {endpoint: {id?, machine, kind, url, name?}}. MCP runtime_endpoint_upsert.'],
  ['POST','/api/runtimes/endpoints/remove','home:write','Odebrat přidaný endpoint {id}. MCP runtime_endpoint_remove.'],
  ['POST','/api/runtimes/endpoints/token','přihlášení heslem','Uložit nebo smazat bearer token endpointu {id, token|null}; token se nikdy nevrací.']]}],
 strings:{en:{
  'LLM runtimy':'LLM runtimes',
  'Endpointy LLM runtimů, které hub čte přímo, se stavem posledního čtení. MCP runtime_endpoints_list.':'LLM runtime endpoints the hub reads directly, with the state of the last read. MCP runtime_endpoints_list.',
  'Přidat nebo nahradit endpoint {endpoint: {id?, machine, kind, url, name?}}. MCP runtime_endpoint_upsert.':'Add or replace an endpoint {endpoint: {id?, machine, kind, url, name?}}. MCP runtime_endpoint_upsert.',
  'Odebrat přidaný endpoint {id}. MCP runtime_endpoint_remove.':'Remove an added endpoint {id}. MCP runtime_endpoint_remove.',
  'Uložit nebo smazat bearer token endpointu {id, token|null}; token se nikdy nevrací.':'Store or delete an endpoint\'s bearer token {id, token|null}; the token is never returned.',
  'přihlášení heslem':'password sign-in',
 }},
 setup(hub){
  const {root,stateDirectory,options,site}=hub;
  const store=options.runtimeEndpointStore||createEndpointStore(path.join(stateDirectory,'runtimes-config.json'));
  const tokens=options.runtimeTokens||createTokenStore(options.runtimeTokensFile||process.env.RUNTIME_TOKENS_FILE||path.join(root,'private','runtime-tokens.json'));
  const seconds=Number(process.env.RUNTIMES_POLL_SECONDS);
  const intervalMs=options.runtimeIntervalMs||(Number.isFinite(seconds)&&seconds>=10&&seconds<=600?seconds*1000:DEFAULT_INTERVAL_MS);
  const endpoints=()=>allEndpoints(site,store);
  const poller=options.runtimePoller||createRuntimePoller({endpoints,tokens,fetcher:options.runtimeFetch||fetch,intervalMs,enabled:()=>isEnabled(hub),onRequest:options.runtimeOnRequest||null});
  const requests=options.runtimeHistory||createRequestHistory(stateDirectory,{clients:()=>site.runtimeClients});
  const history=createHistoryCollector({store:requests,endpoints,tokens,fetcher:options.runtimeFetch||fetch,streamFetcher:options.runtimeStreamFetch||options.runtimeFetch||fetch,
   runtimeIdOf:async id=>(await poller.runtimeIds()).get(id),kindOf:id=>poller.status(id).detectedKind,machines:()=>site.machines,clients:()=>site.runtimeClients,
   enabled:()=>isEnabled(hub),onRequest:options.runtimeOnRequest||null,...(options.runtimeStreamWatch?{watch:options.runtimeStreamWatch}:{})});
  return {store,tokens,poller,endpoints,intervalMs,requests,history,historyTimer:null,unsubscribe:null};
 },
 pollers:[{id:'runtimes',start:state=>state.poller.start(),stop:state=>state.poller.stop()},
  // The request history: after each poll interval, and at once when the integration is switched back on;
  // switching it off closes the streams at once.
  {id:'runtimes-history',start:(state,hub)=>{
   if(state.historyTimer)return;
   const tick=()=>void state.history.tick().catch(()=>{});
   state.historyTimer=setInterval(tick,state.intervalMs);state.historyTimer.unref?.();setTimeout(tick,2000).unref?.();
   if(typeof hub.onIntegrationChange==='function')state.unsubscribe=hub.onIntegrationChange(e=>{if(e.id!==INTEGRATION_ID)return;if(e.enabled)tick();else state.history.stopAll();});
  },stop:state=>{clearInterval(state.historyTimer);state.historyTimer=null;state.unsubscribe?.();state.unsubscribe=null;state.history.stopAll();}}],
 provides:{[FACETS_POINT]:()=>machines=>runtimesFacet(machines),
  'home.runtimes':state=>state.poller.report(),
  // The history, once there is one to keep or one was kept: an endpoint that is llama-swap, or files on disk.
  'runtimes.requests':async(state,hub)=>{
   if(!await isEnabled(hub))return null;
   const keeps=(await state.endpoints()).some(e=>state.history.isLlamaSwap(e))||(await state.requests.machines()).length>0;
   return keeps?state.requests.provider:null;}},
 integrations:[{id:INTEGRATION_ID,title:'LLM runtimes',kind:'llm-runtimes',toggle:true,
  status:(state,hub)=>integrationStatus(state,hub),
  test:async(state,hub)=>{if(await isEnabled(hub))await state.poller.poll({force:true});return integrationStatus(state,hub);}}],
 mcpInstructions:[
  'LLM runtimes: runtime_endpoints_list = the runtimes the hub reads directly over HTTP, with their last read.',
  {scope:'home:write',text:'With home:write: runtime_endpoint_upsert adds one by origin URL (loopback or site LAN, no credentials); runtime_endpoint_remove removes it.'},
 ],
 mcpTools:[
  {name:'runtime_endpoints_list',scope:'read',title:'LLM runtimes: list endpoints',
   description:'The local LLM runtime endpoints the hub reads directly over HTTP: those from the site configuration (source "site", read-only) and those added through the API (source "ui" / "agent"). Each with its machine, kind, the detected kind, whether a bearer token is stored (never the token), and the last read: state ok | stale | error | off (nothing listens) | waiting, lastSuccessAt, lastError. Also the kinds and the exact read-only paths the adapters may request.',
   inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,openWorldHint:false},
   run:(args,{state,hub})=>tool(async()=>{only(args,[]);return listEndpoints(state,hub);})},
  {name:'runtime_endpoint_upsert',scope:'home:write',title:'LLM runtimes: add or replace an endpoint',
   description:'Add a local LLM runtime the hub should read directly, or replace one added before (same id). The URL is an origin only (http://127.0.0.1:11434, http://10.0.0.5:1234): loopback, or an address inside the site networks; never a host name, path, user or password. kind auto detects the runtime with read-only GET requests; name it when you know it. The hub reads it at once and every 30 s, and the answer includes the first read\'s state. Reads are GET-only on fixed paths: the hub never loads, unloads or prompts a model. A runtime that needs a bearer token gets it in the web UI (password sign-in), never through MCP.',
   inputSchema:{type:'object',properties:{endpoint:ENDPOINT_SCHEMA},required:['endpoint'],additionalProperties:false},
   annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:true},
   run:(args,{state,hub,principal})=>tool(()=>upsertEndpoint(state,hub,args,principal))},
  {name:'runtime_endpoint_remove',scope:'home:write',title:'LLM runtimes: remove an endpoint',
   description:'Stop reading an endpoint that was added through the API, and delete its stored token. Endpoints from the site configuration cannot be removed here.',
   inputSchema:{type:'object',properties:{id:{type:'string',pattern:RUNTIME_ENDPOINT_ID.source}},required:['id'],additionalProperties:false},
   annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:false},
   run:(args,{state})=>tool(()=>removeEndpoint(state,args))},
 ],
 routes:[
  {method:'GET',path:'/api/runtimes/endpoints',handler:async({json,state,hub})=>json(200,await listEndpoints(state,hub))},
  {method:'POST',path:'/api/runtimes/endpoints',scope:'home:write',handler:routeErrors(async c=>{
   c.subject=typeof c.input?.endpoint?.id==='string'&&RUNTIME_ENDPOINT_ID.test(c.input.endpoint.id)?c.input.endpoint.id:null;
   const r=await upsertEndpoint(c.state,c.hub,c.input,c.principal);return c.json(r.created?201:200,r);})},
  {method:'POST',path:'/api/runtimes/endpoints/remove',scope:'home:write',handler:routeErrors(async c=>c.json(200,await removeEndpoint(c.state,c.input)))},
  // A bearer token: password sign-in with write access only (never an API key, so it never passes through an agent).
  {method:'POST',path:'/api/runtimes/endpoints/token',scope:null,handler:routeErrors(async c=>{
   if(c.principal.authKind==='api-key')return c.error(403,'SCOPE_REQUIRED','API keys cannot use this endpoint.');
   only(c.input,['id','token']);const id=idOf(c.input);
   if(!(await c.state.endpoints()).some(e=>e.id===id))throw new Error('not-found');
   if(c.input.token===undefined)throw Object.assign(new Error('invalid'),{detail:'token is required (null removes it)'});
   c.subject=id;
   const r=await c.state.tokens.set(id,c.input.token);void c.state.poller.poll({force:true}).catch(()=>{});return c.json(200,{ok:true,...r});})},
 ],
};
