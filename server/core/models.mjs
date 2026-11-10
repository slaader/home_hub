// Core module "models": the "LLM & Diffusion" page (#models). Local language and generative models across every
// machine: what is loaded where, how much memory it holds, who called it from where, and the wiring between
// clients, front doors (llama-swap, a gateway), engines and models.
// It reads only what other modules provide (docs/plugins.md → extension points):
//   home.runtimes      (state, hub) => {machineId: {source, observedAt, runtimes[]}}     live runtimes
//   runtimes.requests  (state, hub) => {id, read({from, to, limit}) → Promise<items[]>}  request history
// and the stacks the site configuration and runtime_publish describe. Without any provider the page says how
// to connect one. Shaping is in server/models-data.mjs.
import {liveState,placements,overview,modelGroups,clientsOf,buildGraph,knownTools,history,cleanRequest,requestKey,MODEL_RANGES,LIMITS,UNATTRIBUTED} from '../models-data.mjs';
import {provenance} from '../provenance.mjs';
import {toolError} from '../mcp.mjs';

// Every provider of `name`, with the module that gave it. A provider that throws counts as absent.
async function provided(hub,name){
 return Promise.all(hub.registry.providers(name).map(async p=>{
  try{return {module:p.module,core:Boolean(hub.registry.module(p.module)?.core),value:await p.provide(hub.state(p.module),hub)};}
  catch{return {module:p.module,core:Boolean(hub.registry.module(p.module)?.core),value:null,failed:true};}}));
}
async function machinesOf(hub){
 const site=hub.site.machines.map(m=>({id:m.id,name:m.name,ip:m.ip||null,ramGb:m.hardware?.ramGb??null}));
 let added=[];try{added=(await hub.state('home')?.homeDevices?.list?.())||[];}catch{}
 return [...site,...added.filter(d=>!site.some(m=>m.id===d.id)).map(d=>({id:d.id,name:d.name,ip:d.ip||null,ramGb:d.props?.ramGb??null}))];
}
async function stacksOf(hub,machines){
 let published={};try{published=(await hub.state('home')?.homeDevices?.stacks?.())||{};}catch{}
 const name=id=>machines.find(m=>m.id===id)?.name||id;
 return [...hub.site.machines.filter(m=>m.stack&&!Object.hasOwn(published,m.id)).map(m=>({machine:m.id,name:m.name,stack:m.stack,source:'site'})),
  ...Object.entries(published).filter(([,e])=>e?.stack).map(([id,e])=>({machine:id,name:name(id),stack:e.stack,source:'published'}))];
}
export function modelsQuery(query={}){
 const keys=Object.keys(query||{});if(keys.some(k=>k!=='range'))throw new Error('invalid');
 const range=query.range??'24h';if(!MODEL_RANGES[range])throw new Error('invalid');return {range};
}

export function createModels(hub){
 const cache=new Map();
 // Requests of the last 30 days from every provider, cleaned and de-duplicated (two providers may watch the
 // same runtime: the hub's own history and a plugin's). One request is one metricKey where the provider
 // carries the runtime's record id; of two copies the one that names a client stays. Held for 20 s: the
 // page and the tool read it together.
 async function requests(now){
  const hit=cache.get('requests');if(hit&&hit.until>now)return hit.value;
  const from=now-MODEL_RANGES['30d'].ms-86400000,sources=[],seen=new Map(),items=[];
  for(const p of await provided(hub,'runtimes.requests')){
   if(p.value===null&&!p.failed)continue;// a provider with nothing to offer here
   if(!p.value||typeof p.value.read!=='function'){sources.push({module:p.module,core:p.core,id:p.value?.id||p.module,count:0,failed:Boolean(p.failed)});continue;}
   let raw=[];let failed=false;try{raw=await p.value.read({from,to:now,limit:LIMITS.requests});}catch{failed=true;}
   let n=0,last=0;
   for(const r of (Array.isArray(raw)?raw:[]).slice(0,LIMITS.requests)){
    const c=cleanRequest(r);if(!c)continue;const key=requestKey(c),at=seen.get(key);
    if(at!==undefined){if(items[at].client===UNATTRIBUTED&&c.client!==UNATTRIBUTED)items[at]=c;continue;}
    seen.set(key,items.length);items.push(c);n++;last=Math.max(last,c.at);}
   sources.push({module:p.module,core:p.core,id:String(p.value.id||p.module).slice(0,60),count:n,lastAt:last?new Date(last).toISOString():null,failed});
  }
  items.sort((a,b)=>a.at-b.at);
  const value={items,sources,providers:sources.length};cache.set('requests',{value,until:now+20000});return value;
 }
 async function live(){
  const machines=await machinesOf(hub),runtimes=await provided(hub,'home.runtimes');
  const merged=Object.assign({},...runtimes.map(p=>p.value&&typeof p.value==='object'?p.value:{}));
  const state=liveState(merged,machines);
  const sources=runtimes.map(p=>{const v=p.value&&typeof p.value==='object'?p.value:{};const ids=Object.keys(v);
   return {module:p.module,core:p.core,source:ids.map(id=>v[id]?.source).find(Boolean)||p.module,machines:ids.length,lastAt:ids.map(id=>v[id]?.observedAt).filter(Boolean).sort().at(-1)||null,failed:Boolean(p.failed)};});
  return {machines,state,sources,stacks:await stacksOf(hub,machines)};
 }
 async function read({range='24h',now=Date.now()}={}){
  const [{machines,state,sources,stacks},req]=await Promise.all([live(),requests(now)]);
  const from=now-MODEL_RANGES[range].ms,inRange=req.items.filter(r=>r.at>=from&&r.at<=now);
  const list=placements(state),known=knownTools(stacks,state);
  return {schemaVersion:1,generatedAt:new Date(now).toISOString(),range,
   empty:!state.length&&!req.items.length,
   providers:{runtimes:sources.map(s=>({module:s.module,source:s.source,machines:s.machines,lastAt:s.lastAt,failed:s.failed})),
    requests:req.sources.map(s=>({module:s.module,id:s.id,count:s.count,lastAt:s.lastAt||null,failed:s.failed}))},
   overview:overview(state,list,inRange,{range,now}),
   machines:state.map(m=>({machine:m.machine,name:m.name,ramGb:m.ramGb,source:m.source,observedAt:m.observedAt,
    runtimes:m.runtimes.map(r=>({id:r.id,name:r.name,kind:r.kind,role:r.role,status:r.status,version:r.version,url:r.url,memory:r.memory,models:r.models.length,loaded:r.models.filter(x=>x.state==='loaded').length}))})),
   models:modelGroups(list,inRange),
   clients:clientsOf(inRange,list,machines,{now}),
   graph:buildGraph(state,list,inRange,{machines,known,now}),
   known,
   provenance:provenance([
    ...sources.filter(s=>s.machines).map(s=>({kind:s.core?'telemetry':'plugin',id:`runtimes:${s.module}`,source:s.source,count:s.machines,unit:'machines',lastAt:s.lastAt,...(s.failed?{state:'failed'}:{})})),
    ...req.sources.filter(s=>s.count).map(s=>({kind:s.core?'telemetry':'plugin',id:`requests:${s.module}`,source:s.id,count:s.count,unit:'records',lastAt:s.lastAt})),
    ...(known.length?[{kind:'config',id:'stack',source:'site.json / runtime_publish',count:known.length,unit:'items'}]:[])])};
 }
 async function readHistory({range='24h',now=Date.now()}={}){
  const [{machines,state},req]=await Promise.all([live(),requests(now)]);
  return {schemaVersion:1,generatedAt:new Date(now).toISOString(),available:req.providers>0,
   ...history(req.items,placements(state),{range,now,timeZone:hub.site.timeZone||'UTC',machines})};
 }
 return {read,readHistory};
}

const modelsError=e=>e.message==='invalid'?[400,'INVALID_QUERY','Neplatný rozsah: 24h, 7d nebo 30d.']:[503,'MODELS_UNAVAILABLE','Data modelů jsou dočasně nedostupná.'];
// What the MCP tool returns: the overview, every model with its placements, the clients; the graph on request.
export function toolView(data,{graph=false}={}){
 return {generatedAt:data.generatedAt,range:data.range,empty:data.empty,overview:data.overview,
  models:data.models.map(g=>({name:g.name,kind:g.kind,state:g.state,requests:g.requests,lastRequestAt:g.lastRequestAt,
   placements:g.placements.map(p=>({machine:p.machine,runtime:p.runtime,via:p.gateways,aliases:p.aliases,engine:p.engine,state:p.state,sizeGb:p.sizeGb,contextTokens:p.contextTokens,ttlRemainingSeconds:p.ttlRemainingSeconds,lastRequestAt:p.lastRequestAt}))})),
  clients:data.clients.map(c=>({client:c.client,clientMachine:c.clientMachine,via:c.via,requests:c.requests,inputTokens:c.inputTokens,outputTokens:c.outputTokens,lastAt:c.lastAt,targets:c.targets})),
  known:data.known.map(k=>({machine:k.machine,role:k.role,title:k.title,kind:k.kind,state:k.state,models:k.models})),
  providers:data.providers,...(graph?{graph:data.graph}:{})};
}

export default {
 id:'models',title:'LLM & Diffusion',
 assets:['models-view.js','models-graph.js','models-charts.js','models.css','i18n-en-models.js'],
 nav:[{groupKey:'Lokální AI',hash:'models',labelKey:'LLM a difúze',view:'models-view.js#modelsPage',order:15,icon:'flow'}],
 setup:hub=>createModels(hub),
 routes:[
  {method:'GET',path:'/api/models',error:modelsError,handler:async({query,json,state})=>json(200,await state.read(modelsQuery(query)))},
  {method:'GET',path:'/api/models/history',error:modelsError,handler:async({query,json,state})=>json(200,await state.readHistory(modelsQuery(query)))},
 ],
 mcpInstructions:['Local AI models: models_overview says which LLM, embedding and diffusion models are loaded on which machine and runtime, their memory, request counts and which clients called them.'],
 mcpTools:[{name:'models_overview',scope:'read',title:'LLM & Diffusion: models across machines',
  description:'Local language, embedding and generative (image, video, music, audio) models on every machine the hub watches: each model with its placements (machine, runtime, the gateway it is reached through, state, size, context, TTL left, last request), the overview (machines, runtimes up and down, models loaded, resident memory per machine against its RAM and pools, requests, tokens and median tokens/s in the range), the clients that sent requests and where they ran ("Unattributed" and a null clientMachine where the data does not say), and tools the stack names without live stats. Pass graph:true for the wiring diagram (nodes and weighted edges). Read-only.',
  inputSchema:{type:'object',properties:{range:{type:'string',enum:Object.keys(MODEL_RANGES),description:'Window for requests and tokens. Default 24h.'},graph:{type:'boolean',description:'Include the wiring diagram.'}},additionalProperties:false},
  annotations:{readOnlyHint:true,openWorldHint:false},
  async run(args,{state}){
   const extra=Object.keys(args||{}).filter(k=>!['range','graph'].includes(k));if(extra.length)throw toolError(`Unknown argument(s): ${extra.join(', ')}.`);
   if(args?.range!==undefined&&!MODEL_RANGES[args.range])throw toolError('range must be 24h, 7d or 30d.');
   return toolView(await state.read({range:args?.range||'24h'}),{graph:args?.graph===true});
  }}],
 apiDocs:[{title:'LLM a difúze',routes:[
  ['GET','/api/models?range=24h|7d|30d','read','Modely na všech strojích: přehled, tabulka modelů, klienti, schéma zapojení. MCP models_overview.'],
  ['GET','/api/models/history?range=24h|7d|30d','read','Požadavky, tokeny a tok/s v čase podle modelu, stroje, klienta a druhu.']]}],
};
