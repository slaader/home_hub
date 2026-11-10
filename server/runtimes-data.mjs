// LLM runtime endpoints the hub reads directly: where they come from, the bearer tokens some of them need,
// and the poller that reads them (server/runtime-adapters.mjs) and keeps the last answer of each in memory.
//
//   site.json → runtimes[]                  read-only, from the site configuration
//   <state>/runtimes-config.json            added through the API or MCP (POST /api/runtimes/endpoints)
//   <root>/private/runtime-tokens.json      {endpointId: token}, mode 0600, write-only: never returned
//
// The poller reads each endpoint every intervalMs (30 s by default). It remembers per endpoint the detected
// kind, the last good answer, and the last success and error with their times. Nothing is written to disk.
import {readFile,writeFile,rename,mkdir,chmod} from 'node:fs/promises';
import path from 'node:path';
import {runtimeEndpoint,RUNTIME_ENDPOINT_LIMIT} from './site-config.mjs';
import {createReader,readRuntime,errorCode,KIND_NAMES} from './runtime-adapters.mjs';

const invalid=detail=>Object.assign(new Error('invalid'),{detail});
async function readJson(file){try{return JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function writeJson(file,value,{dirMode=0o700}={}){
 await mkdir(path.dirname(file),{recursive:true,mode:dirMode});
 const tmp=`${file}.${process.pid}.${Date.now()}.tmp`;
 await writeFile(tmp,JSON.stringify(value,null,1)+'\n',{mode:0o600});await rename(tmp,file);await chmod(file,0o600).catch(()=>{});
}
// One write at a time per file, so two quick API calls never interleave.
const serial=()=>{let last=Promise.resolve();return fn=>{const next=last.then(fn,fn);last=next.catch(()=>{});return next;};};

// The endpoints added at run time. Each carries who added it and how (source: ui | agent).
export function createEndpointStore(file){
 const queue=serial();
 const read=async()=>{const raw=await readJson(file).catch(()=>null);return Array.isArray(raw?.endpoints)?raw.endpoints:[];};
 return {
  file,list:read,
  // endpoint: already validated (runtimeEndpoint). Replaces the entry with the same id.
  upsert:endpoint=>queue(async()=>{
   const all=await read(),at=new Date().toISOString(),before=all.find(e=>e.id===endpoint.id);
   const entry={...endpoint,addedAt:before?.addedAt||at,addedBy:before?.addedBy||endpoint.by,updatedAt:at,updatedBy:endpoint.by,source:endpoint.source};delete entry.by;
   const next=before?all.map(e=>e.id===endpoint.id?entry:e):[...all,entry];
   await writeJson(file,{schema:1,endpoints:next});return {entry,created:!before,changed:JSON.stringify(stripMeta(before))!==JSON.stringify(stripMeta(entry))};}),
  remove:id=>queue(async()=>{const all=await read();if(!all.some(e=>e.id===id))throw new Error('not-found');await writeJson(file,{schema:1,endpoints:all.filter(e=>e.id!==id)});return true;}),
 };
}
const stripMeta=e=>e?{id:e.id,machine:e.machine,kind:e.kind,url:e.url,name:e.name}:null;

// Bearer tokens, one per endpoint id. has(id) and get(id) for the poller; set(id, token|null). The file is
// 0600 in a 0700 directory, and nothing reads it but the poller.
const TOKEN=/^[\x21-\x7e]{8,512}$/;
export function createTokenStore(file){
 const queue=serial();let cache=null;
 const load=async()=>cache??(cache=(await readJson(file).catch(()=>null))?.tokens||{});
 return {
  file,
  get:async id=>{const all=await load();return Object.hasOwn(all,id)?all[id]:null;},
  ids:async()=>Object.keys(await load()),
  set:(id,token)=>queue(async()=>{
   if(token!==null&&(typeof token!=='string'||!TOKEN.test(token)))throw invalid('token must be 8 to 512 printable characters without spaces, or null to remove it');
   const all={...await load()};if(token===null)delete all[id];else all[id]=token;
   await writeJson(file,{schema:1,tokens:all});cache=all;return {id,hasToken:token!==null};}),
 };
}

// Every endpoint the hub reads: the site's, then the stored ones (a stored id that clashes with a site id
// is ignored: the site wins). Each with source (site | ui | agent) and readOnly.
export async function allEndpoints(site,store){
 const fromSite=(site.runtimes||[]).map(e=>({...e,source:'site',readOnly:true}));
 const ids=new Set(fromSite.map(e=>e.id)),urls=new Set(fromSite.map(e=>e.url));
 const stored=(await store.list()).filter(e=>e&&!ids.has(e.id)&&!urls.has(e.url)).map(e=>({id:e.id,machine:e.machine,kind:e.kind,url:e.url,name:e.name||'',source:e.source==='agent'?'agent':'ui',readOnly:false,
  addedAt:e.addedAt||null,addedBy:e.addedBy||null,updatedAt:e.updatedAt||null,updatedBy:e.updatedBy||null}));
 return [...fromSite,...stored];
}
// Validates an endpoint for the API: the shape (site-config.runtimeEndpoint), a machine the hub knows, no
// clash with another endpoint's id or URL, and room for it.
export function checkEndpoint(input,{site,machines,existing}){
 let e;try{e=runtimeEndpoint(input,{lanCidrs:site.lanCidrs,where:'endpoint'});}catch(err){throw invalid(err.message);}
 if(!machines.includes(e.machine))throw invalid(`endpoint.machine "${e.machine}" is not a machine on the overview (machine_list)`);
 const same=existing.find(x=>x.id===e.id);
 if(same?.readOnly)throw Object.assign(new Error('read-only'),{detail:`endpoint ${e.id} comes from the site configuration`});
 const clash=existing.find(x=>x.url===e.url&&x.id!==e.id);if(clash)throw Object.assign(new Error('conflict'),{detail:`${e.url} is already endpoint ${clash.id}`});
 if(!same&&existing.length>=RUNTIME_ENDPOINT_LIMIT)throw Object.assign(new Error('limit'),{detail:`at most ${RUNTIME_ENDPOINT_LIMIT} endpoints`});
 return e;
}

// --- the poller ----------------------------------------------------------------------------------
export const STALE_MS=180000;
export const DEFAULT_INTERVAL_MS=30000;
export function createRuntimePoller({endpoints,tokens,fetcher=fetch,intervalMs=DEFAULT_INTERVAL_MS,now=Date.now,enabled=async()=>true,onRequest=null}){
 const states=new Map();let timer=null,running=null,lastAll=0;
 const slot=id=>{if(!states.has(id))states.set(id,{detected:null,attemptAt:null,successAt:null,error:null,errorAt:null,failures:0,result:null,memo:{},key:''});return states.get(id);};
 async function pollOne(e){
  const s=slot(e.id),key=`${e.kind}|${e.url}`;
  // The endpoint changed (another URL or kind): forget what was learnt about the old one.
  if(s.key!==key){Object.assign(s,{detected:null,successAt:null,error:null,errorAt:null,failures:0,result:null,memo:{},key});}
  const get=createReader({base:e.url,token:await tokens.get(e.id),fetcher,onRequest});
  s.attemptAt=now();
  try{
   const r=await readRuntime(get,{kind:e.kind,detected:s.detected,now:now(),memo:s.memo});
   Object.assign(s,{result:r,successAt:now(),error:null,errorAt:null,failures:0,detected:e.kind==='auto'?r.kind:null});
  }catch(err){
   Object.assign(s,{error:errorCode(err),errorAt:now(),failures:s.failures+1});
   // A detected kind that keeps failing is guessed again (something else may listen there now).
   if(s.failures>=3)s.detected=null;
  }
  return s;
 }
 async function poll({force=false}={}){
  if(running)return running;
  if(!force&&now()-lastAll<5000)return;
  running=(async()=>{
   if(await enabled()===false)return;
   const list=await endpoints();
   for(const id of states.keys())if(!list.some(e=>e.id===id))states.delete(id);
   await Promise.all(list.map(e=>pollOne(e).catch(()=>{})));lastAll=now();
  })().finally(()=>{running=null;});
  return running;
 }
 // state = ok | stale | error | off (refused: nothing listens there) | waiting (not read yet).
 function stateOf(s){
  if(!s||!s.attemptAt)return 'waiting';
  if(!s.error)return now()-s.successAt>STALE_MS?'stale':'ok';
  if(s.error==='refused')return 'off';
  return s.successAt?'stale':'error';
 }
 const status=id=>{const s=states.get(id);return {state:stateOf(s),detectedKind:s?.detected||s?.result?.kind||null,lastAttemptAt:iso(s?.attemptAt),lastSuccessAt:iso(s?.successAt),lastError:s?.error||null,lastErrorAt:iso(s?.errorAt)};};
 // home.runtimes: {machineId: {source, observedAt, runtimes[]}} for the endpoints read at least once.
 async function report(){
  if(await enabled()===false)return {};
  const list=await endpoints(),out={};
  for(const e of list){
   const s=states.get(e.id);if(!s?.attemptAt)continue;
   const st=stateOf(s),r=s.result,kind=r?.kind||s.detected||(e.kind==='auto'?null:e.kind);
   const fresh=st==='ok';
   const entry=out[e.machine]??={source:'přímo z runtimu',observedAt:null,runtimes:[]};
   const seen=new Date(s.attemptAt).toISOString();if(!entry.observedAt||seen<entry.observedAt)entry.observedAt=seen;
   const base=kind||'runtime';let id=base;
   if(entry.runtimes.some(x=>x.id===id))id=`${base}-${new URL(e.url).port||'80'}`;
   entry.runtimes.push({id,name:e.name||KIND_NAMES[kind]||new URL(e.url).host,kind:kind||'',source:'přímo z runtimu',observedAt:seen,
    // Refused: the runtime is not running, so nothing it had is in memory. Any other failure says nothing.
    status:fresh?'running':st==='off'?'stopped':'unknown',url:e.url,version:r?.version||null,
    models:(r?.models||[]).map(m=>fresh?m:{...m,state:st==='off'?'unloaded':'unknown',ttlRemainingSeconds:null}),
    stats:fresh?r?.stats||[]:[]});
  }
  return out;
 }
 return {
  poll,report,status,states,
  start(){if(timer)return;void poll({force:true});timer=setInterval(()=>void poll({force:true}),intervalMs);timer.unref?.();},
  stop(){clearInterval(timer);timer=null;},
 };
}
const iso=ms=>Number.isFinite(ms)?new Date(ms).toISOString():null;
