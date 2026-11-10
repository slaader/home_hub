// The hub's own request history for the local LLM runtimes it reads directly (core module "runtimes").
// Today that is llama-swap, the one runtime that keeps a request log: GET /api/metrics/activity is a ring
// buffer of finished requests (newest first, paged) that reading does not drain, and GET
// /logs/stream/http?no-history is its access log as a plain-text stream, one line per request with the
// method, path, status, User-Agent and duration. The first gives the figures, the second says who sent it.
//
//   <state>/runtimes/<machine>/requests-YYYY-MM.jsonl   one request per line, by the UTC month of `at`
//
// What a line holds, and nothing else: {machine, runtime, model, at, metricId, path, status, inputTokens,
// outputTokens, cacheTokens, promptTps, generationTps, durationMs, client, uaFamily?, clientMachine?,
// clientAddress?}. Never a prompt, a body, a header other than the User-Agent's first word, or a full UA.
//
// What may be requested, and nothing else (HISTORY_READS): GET /api/metrics/activity?page=<1..10>&limit=200
// and GET /logs/stream/http?no-history. Both are refused before a socket opens when the path differs in any
// character. No POST, no /upstream/…, no unload, no capture.
//
// De-duplication: metricKey (machine, runtime, the runtime's record id, the record's time). A llama-swap
// restart starts its ids again at 1, but with new times, so a restart neither drops nor repeats a record.
// The store remembers the keys of the last DEDUP_DAYS days (at most DEDUP_CAP of them) and ignores anything
// older than that window when it comes from a runtime. A record that names a client may follow one of the
// same key that did not (an import of older attributed history): it is appended, and reading prefers it.
import {readFile,readdir,appendFile,mkdir,unlink} from 'node:fs/promises';
import path from 'node:path';
import {metricKey} from './models-data.mjs';
import {RuntimeReadError,MAX_BODY,errorCode} from './runtime-adapters.mjs';

export const ACTIVITY_PAGE_LIMIT=200;
export const ACTIVITY_MAX_PAGES=10;
export const STREAM_PATH='/logs/stream/http?no-history';
export const activityPath=page=>`/api/metrics/activity?page=${page}&limit=${ACTIVITY_PAGE_LIMIT}`;
// For the docs and GET /api/runtimes/endpoints: the two reads, as patterns.
export const HISTORY_READS=Object.freeze([`/api/metrics/activity?page=<1-${ACTIVITY_MAX_PAGES}>&limit=${ACTIVITY_PAGE_LIMIT}`,STREAM_PATH]);
const ACTIVITY=/^\/api\/metrics\/activity\?page=([1-9][0-9]?)&limit=200$/;
export function historyPathAllowed(p){
 if(p===STREAM_PATH)return true;
 const m=typeof p==='string'?ACTIVITY.exec(p):null;return Boolean(m)&&Number(m[1])<=ACTIVITY_MAX_PAGES;
}
export const RETENTION_MONTHS=13;
export const DEDUP_DAYS=35;
export const DEDUP_CAP=200000;
export const UNATTRIBUTED='Unattributed';
const DAY=86400000;
// How long an access-log line waits for its record, and how long after a request ended its record waits
// for its line before it is stored (unattributed if none came).
export const LINE_TTL_MS=15*60000;
export const JOIN_AFTER_MS=15000;

const text=(v,n=120)=>typeof v==='string'?v.replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,n):'';
const int=v=>Number.isSafeInteger(v)&&v>=0?v:null;
const num=(v,max=1e12)=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=max?v:null;
const plain=v=>v&&typeof v==='object'&&!Array.isArray(v);
const MACHINE=/^[a-z][a-z0-9_-]{1,31}$/;
const IPV4=/^(\d{1,3})(\.\d{1,3}){3}$/;
const isLoopback=a=>/^127\.|^::1$|^localhost$/i.test(a);
const timeMs=v=>{const t=typeof v==='number'?v:Date.parse(v);return Number.isFinite(t)?t:null;};
const monthOf=ms=>new Date(ms).toISOString().slice(0,7);
const cleanPath=p=>text(p,200).split('?')[0].replace(/[^A-Za-z0-9/_.:-]/g,'').slice(0,120);
// The serial queue of one file set: appends never interleave.
const serial=()=>{let last=Promise.resolve();return fn=>{const next=last.then(fn,fn);last=next.catch(()=>{});return next;};};

// ── Clients ─────────────────────────────────────────────────────────────────────────────────────────
// The first word of a User-Agent ("claude-cli/2.1 (external, cli)" → "claude-cli"): the product token, bounded.
export function uaFamilyOf(userAgent){const raw=text(userAgent,200);return raw?raw.split(/[\s/(;]/)[0].replace(/[^A-Za-z0-9._+-]/g,'').slice(0,40):'';}
// Generic names for well-known User-Agent families. A household names its own (site.json → runtimeClients,
// family → name), which win; an unknown family keeps its own name, so it can be named later.
export const CLIENT_FAMILIES=Object.freeze([
 [/^claude-(cli|code)$/i,'Claude Code'],[/^codex/i,'Codex'],[/^opencode/i,'OpenCode'],
 [/^(python-httpx|httpx|aiohttp|python-requests|python-urllib\d*|openai-python)$/i,'Python'],[/^openai$/i,'OpenAI SDK'],
 [/^(node|undici|node-fetch|axios)$/i,'Node.js'],[/^deno$/i,'Deno'],[/^bun$/i,'Bun'],[/^go-http-client$/i,'Go'],
 [/^curl$/i,'curl'],[/^wget$/i,'Wget'],[/^(mozilla|com\.apple\.webkit\.networking)$/i,'Browser'],[/^litellm/i,'LiteLLM'],
 [/^open-?webui/i,'Open WebUI'],[/^home-hub/i,'Home Hub']]);
export function clientFor(family,own={}){
 const f=text(family,40);if(!f)return '';
 for(const [k,v] of Object.entries(own||{}))if(k.toLowerCase()===f.toLowerCase())return text(v,60);
 for(const [re,name] of CLIENT_FAMILIES)if(re.test(f))return name;
 return f;
}

// ── llama-swap access log ──────────────────────────────────────────────────────────────────────────
// [INFO] Request 127.0.0.1 "POST /v1/chat/completions HTTP/1.1" 200 1234 "claude-cli/2.1" 7.15s
const LINE=/Request (\S+) "([A-Z]+) (\S+) HTTP\/[\d.]+" (-?\d+) (-?\d+) "((?:[^"\\]|\\.)*)" (\S+)\s*$/;
export function parseGoDuration(value){
 let ms=0,matched=false;
 for(const m of String(value).matchAll(/(\d+(?:\.\d+)?)(h|ms|µs|us|ns|m|s)/g)){matched=true;ms+=Number(m[1])*({h:3600000,m:60000,s:1000,ms:1,'µs':0.001,us:0.001,ns:0.000001})[m[2]];}
 return matched?Math.round(ms):null;
}
// One line → {arrivedAt, address, path, status, uaFamily, durationMs}, or null. Only POSTs: model requests;
// the GETs (the hub's own reads among them) never produce a record to join.
export function parseAccessLine(line,arrivedAt=Date.now()){
 const m=LINE.exec(String(line).slice(0,4096));if(!m)return null;
 const [,address,method,rawPath,status,,ua,duration]=m;if(method!=='POST')return null;
 return {arrivedAt,address:text(address,64),path:cleanPath(rawPath),status:Number(status),uaFamily:uaFamilyOf(ua.replace(/\\"/g,'"')),durationMs:parseGoDuration(duration),used:false};
}
// The line of one record: the same path and status, a duration within max(1.5 s, 10 %), and arrived from a
// little before the record's time to a little after it ended (llama-swap's timestamp is close to the end of
// the request; the window allows either end). The closest duration wins; a line joins one record only.
export function joinLine(record,lines){
 const at=timeMs(record.at),duration=record.durationMs||0;let best=null,bestDiff=Infinity;
 if(at==null)return null;
 for(const line of lines){
  if(line.used||line.path!==record.path)continue;
  if(record.status!=null&&line.status!==record.status)continue;
  if(line.arrivedAt<at-10000||line.arrivedAt>at+duration+JOIN_AFTER_MS)continue;
  const diff=Math.abs((line.durationMs||0)-duration);if(diff>Math.max(1500,duration*0.1)||diff>=bestDiff)continue;
  best=line;bestDiff=diff;
 }
 if(best)best.used=true;
 return best;
}

// ── Records ─────────────────────────────────────────────────────────────────────────────────────────
// A stored line, cleaned (also what an import passes through). null when it is not a request of a machine.
export function cleanRecord(r){
 if(!plain(r))return null;
 const at=timeMs(r.at),machine=text(r.machine,32);if(at==null||!MACHINE.test(machine))return null;
 const address=text(r.clientAddress,64).replace(/^ip:/,'');
 const out={machine,runtime:text(r.runtime,60)||'unknown',model:text(r.model,160)||'unknown',at:new Date(at).toISOString(),metricId:int(r.metricId),
  path:cleanPath(r.path)||'other',status:int(r.status),inputTokens:int(r.inputTokens),outputTokens:int(r.outputTokens),cacheTokens:int(r.cacheTokens),
  promptTps:num(r.promptTps,1e7),generationTps:num(r.generationTps,1e7),durationMs:int(r.durationMs),client:text(r.client,60)===UNATTRIBUTED?'':text(r.client,60)};
 const family=uaFamilyOf(r.uaFamily);if(family){out.uaFamily=family;if(!out.client)out.client=clientFor(family);}
 if(MACHINE.test(text(r.clientMachine,32)))out.clientMachine=text(r.clientMachine,32);
 if(address&&(IPV4.test(address)||isLoopback(address)))out.clientAddress=address;
 return out;
}
export const recordKey=r=>metricKey({machine:r.machine,runtime:r.runtime,metricId:r.metricId,at:timeMs(r.at)});
// llama-swap's activity records (one page's data[]) → stored records of this machine and runtime. The
// address names a client machine when it is a site machine's (never on loopback: that is this machine or
// a tunnel into it, the same as an SSH forward).
export function fromActivity(items,{machine,runtime,machines=[]}){
 return (Array.isArray(items)?items:[]).filter(plain).map(m=>{
  const t=plain(m.tokens)?m.tokens:m,address=text(m.src,64).replace(/^ip:/,'');
  const where=address&&!isLoopback(address)?machines.find(x=>x.ip&&x.ip===address)?.id:null;
  return cleanRecord({machine,runtime,model:m.model,at:m.timestamp,metricId:m.id,path:m.req_path,status:m.resp_status_code,
   inputTokens:t.input_tokens,outputTokens:t.output_tokens,cacheTokens:t.cache_tokens,promptTps:t.prompt_per_second,generationTps:t.tokens_per_second,
   durationMs:m.duration_ms,clientAddress:address,...(where?{clientMachine:where}:{})});
 }).filter(r=>r&&r.metricId!==null);
}

// A line of an older history file, for scripts/import-runtime-history.mjs: either this store's own format, or
// the v1 compute bridge's history ({kind: "request", serviceId, metricId, at, model, path: a kind word,
// status, …tokens, uaFamily, requestor}). Events and anything without a record id are left out.
export function fromImportLine(raw,{machine}){
 if(!plain(raw)||raw.kind==='event')return null;
 if(raw.machine!==undefined&&raw.machine!==machine)return null;
 const v1=raw.kind==='request'||raw.serviceId!==undefined;
 const r=cleanRecord(v1?{machine,runtime:raw.serviceId||'llama-swap',model:raw.model,at:raw.at,metricId:raw.metricId,path:raw.path,status:raw.status,
  inputTokens:raw.inputTokens,outputTokens:raw.outputTokens,cacheTokens:raw.cacheTokens,promptTps:raw.promptTps,generationTps:raw.generationTps,durationMs:raw.durationMs,
  client:raw.requestor,uaFamily:raw.uaFamily}:{...raw,machine});
 return r&&r.metricId!==null?r:null;
}

// ── The store ───────────────────────────────────────────────────────────────────────────────────────
const FILE=/^requests-(\d{4}-\d{2})\.jsonl$/;
export function createRequestHistory(stateDirectory,{retentionMonths=RETENTION_MONTHS,dedupDays=DEDUP_DAYS,dedupCap=DEDUP_CAP,clients=()=>({}),maxLines=400000}={}){
 const root=path.join(stateDirectory,'runtimes');
 const dir=machine=>{if(!MACHINE.test(machine))throw new Error('invalid');return path.join(root,machine);};
 const known=new Map();// machine → Map(key → {at, attributed})
 const queues=new Map(),pruned=new Map(),stats=new Map();
 const queue=machine=>{if(!queues.has(machine))queues.set(machine,serial());return queues.get(machine);};
 async function filesOf(machine){try{return (await readdir(dir(machine))).filter(f=>FILE.test(f)).sort();}catch{return [];}}
 async function machines(){try{return (await readdir(root,{withFileTypes:true})).filter(d=>d.isDirectory()&&MACHINE.test(d.name)).map(d=>d.name).sort();}catch{return [];}}
 // Every record of one machine in [from, to], file by file (a file is one month).
 async function readMachine(machine,from,to){
  const out=[];
  for(const f of await filesOf(machine)){
   const start=Date.parse(`${FILE.exec(f)[1]}-01T00:00:00Z`),end=new Date(start).setUTCMonth(new Date(start).getUTCMonth()+1);
   if(start>to||end<=from)continue;
   let body;try{body=await readFile(path.join(dir(machine),f),'utf8');}catch{continue;}
   let n=0;
   for(const line of body.split('\n')){if(!line||++n>maxLines)continue;let r;try{r=cleanRecord(JSON.parse(line));}catch{continue;}if(!r||r.machine!==machine)continue;const at=Date.parse(r.at);if(at>=from&&at<=to)out.push(r);}
  }
  return out;
 }
 async function keysOf(machine,now){
  if(known.has(machine))return known.get(machine);
  const map=new Map();
  for(const r of await readMachine(machine,now-dedupDays*DAY,now+DAY)){const k=recordKey(r),seen=map.get(k);if(!seen||(!seen.attributed&&r.client))map.set(k,{at:Date.parse(r.at),attributed:Boolean(r.client)});}
  known.set(machine,map);return map;
 }
 function trim(map,now){
  const cutoff=now-dedupDays*DAY;
  for(const [k,v] of map){if(v.at<cutoff)map.delete(k);}
  if(map.size>dedupCap)for(const [k] of [...map].sort((a,b)=>a[1].at-b[1].at).slice(0,map.size-dedupCap))map.delete(k);// the oldest go
 }
 // Monthly: once per machine and month, drop the files older than the retention.
 async function prune(machine,now){
  const month=monthOf(now);if(pruned.get(machine)===month)return 0;pruned.set(machine,month);
  const d=new Date(now),oldest=monthOf(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()-(retentionMonths-1),1));let removed=0;
  for(const f of await filesOf(machine))if(FILE.exec(f)[1]<oldest){await unlink(path.join(dir(machine),f)).catch(()=>{});removed++;}
  return removed;
 }
 // records: cleaned or raw records of one machine. window: false for an import (any age, every month read).
 // → {added, known, skipped}
 function ingest(machine,records,{now=Date.now(),window=true}={}){
  return queue(machine)(async()=>{
   await mkdir(dir(machine),{recursive:true,mode:0o700});
   const map=window?await keysOf(machine,now):await importKeys(machine,records);
   const byMonth=new Map();let added=0,dup=0,skipped=0;
   for(const raw of Array.isArray(records)?records:[]){
    const r=cleanRecord({...raw,machine});const at=r&&Date.parse(r.at);
    if(!r||r.metricId===null||at>now+300000||(window&&at<now-dedupDays*DAY)){skipped++;continue;}
    const k=recordKey(r),seen=map.get(k);
    if(seen&&(seen.attributed||!r.client)){dup++;continue;}
    map.set(k,{at,attributed:Boolean(r.client)});added++;
    const month=r.at.slice(0,7);byMonth.set(month,(byMonth.get(month)||'')+JSON.stringify(r)+'\n');
   }
   for(const [month,chunk] of byMonth)await appendFile(path.join(dir(machine),`requests-${month}.jsonl`),chunk,{mode:0o600});
   if(window)trim(map,now);
   await prune(machine,now);
   const s=stats.get(machine)||{lastIngestedAt:null,lastAddedAt:null};s.lastIngestedAt=now;if(added)s.lastAddedAt=now;stats.set(machine,s);
   return {added,known:dup,skipped};
  });
 }
 // An import may reach back further than the window: the keys of every month it touches.
 async function importKeys(machine,records){
  const times=(Array.isArray(records)?records:[]).map(r=>timeMs(r?.at)).filter(v=>v!=null);
  const map=new Map();if(!times.length)return map;
  for(const r of await readMachine(machine,Math.min(...times)-DAY,Math.max(...times)+DAY)){const k=recordKey(r),seen=map.get(k);if(!seen||(!seen.attributed&&r.client))map.set(k,{at:Date.parse(r.at),attributed:Boolean(r.client)});}
  known.delete(machine);// the live window is rebuilt from the files on its next use
  return map;
 }
 const has=async(machine,record,now=Date.now())=>(await keysOf(machine,now)).has(recordKey(record));
 // runtimes.requests: the stored records in [from, to], one per key (the one that names a client), oldest
 // first. client is named again from uaFamily with today's table, so a new site.json entry renames history.
 async function read({from=0,to=Date.now(),limit=200000}={}){
  const own=clients()||{},out=new Map();
  for(const machine of await machines()){
   for(const r of await readMachine(machine,from,to)){
    const k=recordKey(r),seen=out.get(k);if(seen&&(seen.client||!r.client))continue;
    out.set(k,r);
   }
  }
  return [...out.values()].sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)).slice(-limit).map(r=>{
   const client=r.uaFamily?clientFor(r.uaFamily,own):r.client;
   return {machine:r.machine,runtime:r.runtime,model:r.model,at:r.at,metricId:r.metricId,path:r.path,status:r.status,inputTokens:r.inputTokens??0,outputTokens:r.outputTokens??0,
    cacheTokens:r.cacheTokens,promptTps:r.promptTps,generationTps:r.generationTps,durationMs:r.durationMs,client:client||'',
    ...(r.clientMachine?{clientMachine:r.clientMachine}:{}),...(r.clientAddress?{clientAddress:r.clientAddress}:{})};
  });
 }
 // For the integration page: when this machine's history was last read, last grew, and how many of its
 // records fall on or after `since` (the start of today on the site's clock).
 async function summary(machine,{since,now=Date.now()}={}){
  const map=await keysOf(machine,now),s=stats.get(machine)||{};let today=0;
  for(const v of map.values())if(v.at>=since)today++;
  return {lastIngestedAt:s.lastIngestedAt?new Date(s.lastIngestedAt).toISOString():null,lastAddedAt:s.lastAddedAt?new Date(s.lastAddedAt).toISOString():null,recordsToday:today};
 }
 return {root,windowMs:dedupDays*DAY,ingest,read,has,summary,machines,readMachine,prune,provider:{id:'runtimes-history',read}};
}

// ── Reads and the stream ────────────────────────────────────────────────────────────────────────────
// A GET of one allowlisted history path, JSON back. Same rules as the adapters' reader: no redirects,
// bounded body, short timeout, the bearer token (if any) to this origin only.
export function createHistoryReader({base,token=null,fetcher=fetch,timeoutMs=5000,maxBytes=MAX_BODY,onRequest=null}){
 const origin=new URL(base).origin;
 return async function get(p){
  if(p===STREAM_PATH||!historyPathAllowed(p))throw new RuntimeReadError('path-not-allowed');
  const url=origin+p;onRequest?.({method:'GET',url});
  const response=await fetcher(url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(timeoutMs),
   headers:{Accept:'application/json','User-Agent':'home-hub-runtimes/1',...(token?{Authorization:`Bearer ${token}`}:{})}});
  let size=0;const chunks=[];
  if(response.body)for await(const chunk of response.body){size+=chunk.length;if(size>maxBytes)throw new RuntimeReadError('too-large');chunks.push(Buffer.from(chunk));}
  if(!response.ok)throw new RuntimeReadError(response.status===401||response.status===403?'auth':`http-${response.status}`,response.status);
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new RuntimeReadError('not-json');}
 };
}
// The access-log stream of one runtime: one GET of STREAM_PATH held open, each line to onLine(line). It
// reconnects after a failure or an end, waiting 5 s, then longer, up to a minute; a line longer than 8 KiB
// and anything beyond a 64 KiB buffer is dropped. stop() closes it and stops reconnecting.
export function createStreamWatcher({base,token=null,fetcher=fetch,onLine,onRequest=null,retryMinMs=5000,retryMaxMs=60000,connectTimeoutMs=5000,maxBuffer=65536,maxLine=8192,now=Date.now}){
 const url=new URL(base).origin+STREAM_PATH;
 let stopped=true,controller=null,timer=null,delay=retryMinMs,state='off',connectedAt=null,lastError=null,generation=0;
 async function connect(gen){
  if(stopped||gen!==generation)return;
  const c=new AbortController();controller=c;state='connecting';
  const cancel=setTimeout(()=>c.abort(),connectTimeoutMs);cancel.unref?.();
  onRequest?.({method:'GET',url,stream:true});
  try{
   const response=await fetcher(url,{method:'GET',redirect:'error',signal:c.signal,headers:{Accept:'text/plain','User-Agent':'home-hub-runtimes/1',...(token?{Authorization:`Bearer ${token}`}:{})}});
   clearTimeout(cancel);
   if(!response.ok||!response.body){try{await response.body?.cancel?.();}catch{}throw new RuntimeReadError(response.status===401||response.status===403?'auth':`http-${response.status}`,response.status);}
   state='connected';connectedAt=now();lastError=null;delay=retryMinMs;
   const decoder=new TextDecoder();let buffer='';
   for await(const chunk of response.body){
    if(stopped||gen!==generation)break;
    buffer+=typeof chunk==='string'?chunk:decoder.decode(chunk,{stream:true});
    if(buffer.length>maxBuffer)buffer=buffer.slice(-maxBuffer);
    let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);if(line.length<=maxLine)try{onLine(line);}catch{}}
   }
   if(!stopped)lastError='closed';
  }catch(e){clearTimeout(cancel);if(!stopped)lastError=errorCode(e);}
  if(stopped||gen!==generation)return;
  state='reconnecting';connectedAt=null;
  timer=setTimeout(()=>void connect(gen),delay);timer.unref?.();delay=Math.min(retryMaxMs,delay*2);
 }
 return {
  url,
  start(){if(!stopped)return;stopped=false;delay=retryMinMs;void connect(++generation);},
  stop(){stopped=true;generation++;clearTimeout(timer);timer=null;try{controller?.abort();}catch{}controller=null;state='off';connectedAt=null;},
  status:()=>({state,connectedAt:connectedAt?new Date(connectedAt).toISOString():null,lastError}),
 };
}

// ── The collector ───────────────────────────────────────────────────────────────────────────────────
// Every tick (the runtimes poller's interval) and for every endpoint that is llama-swap (configured so, or
// detected): keep its access-log stream open, then read the activity buffer from page 1 until a page holds a
// record the store already has, the last page, or page ACTIVITY_MAX_PAGES. The first read after a start
// therefore takes the whole buffer; later ones usually one page. A record that ended less than
// JOIN_AFTER_MS ago waits for the next tick while the stream is connected, so its log line can arrive first.
// While the integration is off (enabled() false) nothing is read and every stream is closed.
export function createHistoryCollector({store,endpoints,runtimeIdOf,kindOf,tokens,fetcher=fetch,streamFetcher=fetcher,machines=()=>[],clients=()=>({}),
 enabled=async()=>true,now=Date.now,onRequest=null,watch=createStreamWatcher,maxLines=2000}){
 const streams=new Map();// endpoint id → {key, watcher, lines[]}
 const status=new Map();// endpoint id → {lastSyncAt, lastError, lastErrorAt, added, attributed, pages}
 let running=null;
 const isLlamaSwap=e=>e.kind==='llama-swap'||(e.kind==='auto'&&kindOf(e.id)==='llama-swap');
 function stopAll(){for(const s of streams.values())s.watcher.stop();streams.clear();}
 async function ensureStream(e){
  const key=e.url;let s=streams.get(e.id);
  if(s&&s.key===key)return s;
  if(s)s.watcher.stop();
  const lines=[];
  const watcher=watch({base:e.url,token:await tokens.get(e.id),fetcher:streamFetcher,onRequest,now,onLine:line=>{
   const parsed=parseAccessLine(line,now());if(!parsed)return;lines.push(parsed);if(lines.length>maxLines)lines.splice(0,lines.length-maxLines);}});
  s={key,watcher,lines};streams.set(e.id,s);watcher.start();return s;
 }
 async function syncOne(e){
  const st=status.get(e.id)||{lastSyncAt:null,lastError:null,lastErrorAt:null,added:0,attributed:0,pages:0};status.set(e.id,st);
  const stream=await ensureStream(e),connected=stream.watcher.status().state==='connected';
  const get=createHistoryReader({base:e.url,token:await tokens.get(e.id),fetcher,onRequest});
  const runtime=(await runtimeIdOf(e.id))||'llama-swap',site=machines(),own=clients()||{};
  const t=now();let pages=0,added=0,attributed=0;
  try{
   for(let page=1;page<=ACTIVITY_MAX_PAGES;page++){
    const body=await get(activityPath(page));pages++;
    const items=fromActivity(body?.data,{machine:e.machine,runtime,machines:site});
    let seenOne=false;const fresh=[];
    for(const r of items){
     // Known, or older than the store's window (it would not be kept): everything after it is older still.
     if(Date.parse(r.at)<t-(store.windowMs??DEDUP_DAYS*DAY)||await store.has(e.machine,r,t)){seenOne=true;continue;}
     if(connected&&Date.parse(r.at)+(r.durationMs||0)+JOIN_AFTER_MS>t)continue;// its log line may still come
     const line=joinLine(r,stream.lines);
     if(line){r.uaFamily=line.uaFamily;r.client=clientFor(line.uaFamily,own);if(r.client)attributed++;}
     fresh.push(r);
    }
    if(fresh.length)added+=(await store.ingest(e.machine,fresh,{now:t})).added;
    const total=Number(body?.total_pages);
    if(seenOne||!items.length||!Array.isArray(body?.data)||body.data.length<ACTIVITY_PAGE_LIMIT||(Number.isFinite(total)&&page>=total))break;
   }
   Object.assign(st,{lastSyncAt:t,lastError:null,lastErrorAt:null,pages,added:st.added+added,attributed:st.attributed+attributed});
  }catch(err){Object.assign(st,{lastError:errorCode(err),lastErrorAt:t,pages});}
  // Lines that joined, and lines too old to join anything, go.
  const cutoff=now()-LINE_TTL_MS;for(let i=stream.lines.length-1;i>=0;i--)if(stream.lines[i].used||stream.lines[i].arrivedAt<cutoff)stream.lines.splice(i,1);
  return st;
 }
 async function tick(){
  if(running)return running;
  running=(async()=>{
   if(await enabled()===false){stopAll();return;}
   const list=(await endpoints()).filter(isLlamaSwap);
   for(const id of [...streams.keys()])if(!list.some(e=>e.id===id)){streams.get(id).watcher.stop();streams.delete(id);}
   for(const id of [...status.keys()])if(!list.some(e=>e.id===id))status.delete(id);
   for(const e of list)await syncOne(e).catch(()=>{});
  })().finally(()=>{running=null;});
  return running;
 }
 const iso=ms=>Number.isFinite(ms)?new Date(ms).toISOString():null;
 return {
  tick,stopAll,
  // Per endpoint: {lastSyncAt, lastError, lastErrorAt, added, attributed, stream: {state, connectedAt, lastError}} or null.
  status(id){const st=status.get(id),s=streams.get(id);if(!st&&!s)return null;
   return {lastSyncAt:iso(st?.lastSyncAt),lastError:st?.lastError||null,lastErrorAt:iso(st?.lastErrorAt),added:st?.added||0,attributed:st?.attributed||0,
    stream:s?s.watcher.status():{state:'off',connectedAt:null,lastError:null}};},
  isLlamaSwap,
 };
}
