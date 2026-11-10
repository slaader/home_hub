// Direct adapters for local LLM runtimes: what a runtime that the hub can reach over HTTP says about itself
// (loaded models, sizes, context, TTL, a few figures), turned into one entry of the home.runtimes shape
// (docs/plugins.md → extension points). Used by the core module "runtimes" (server/core/runtimes.mjs).
//
// What an adapter may do, and nothing else:
//   - GET requests only, to the paths in READ_PATHS (an exact allowlist; anything else throws before a
//     socket is opened). No POST, no query strings, no redirects.
//   - Every body is bounded (MAX_BODY) and every request has a short timeout.
//   - Only the fields picked below are kept; prompts, request bodies, model paths, commands, client
//     addresses and any key a runtime echoes back (oMLX's admin stats carry `api_key`) are never stored.
//   - Never a model-loading route. llama-swap loads a model on a GET of /upstream/<model>/…, and its
//     /api/models/unload and /unload change state; none of them is on the list. llama.cpp's /slots is left
//     out too: some versions return the prompt a slot is working on.
import {RUNTIME_KINDS} from './site-config.mjs';

export {RUNTIME_KINDS};
export const READ_PATHS=Object.freeze([
 '/v1/models',                                   // OpenAI-compatible model list (all of them)
 '/running','/api/version','/api/metrics/stats','/api/metrics/activity','/api/metrics','/metrics', // llama-swap (+ Prometheus)
 '/api/tags','/api/ps',                          // Ollama (+ /api/version)
 '/api/v0/models',                               // LM Studio
 '/health','/props',                             // llama.cpp server (+ /metrics, /v1/models)
 '/version',                                     // vLLM
 '/v1/models/status','/admin/api/stats',         // oMLX (+ /health, /v1/models)
]);
export const MAX_BODY=512*1024;
export const TIMEOUT_MS=3000;
export const KIND_NAMES=Object.freeze({'llama-swap':'llama-swap',ollama:'Ollama',lmstudio:'LM Studio','llama-cpp':'llama.cpp server',vllm:'vLLM',sglang:'SGLang',omlx:'oMLX','mlx-serve':'mlx-serve',openai:'OpenAI API'});

const GiB=1073741824;
const arr=v=>Array.isArray(v)?v:[];
const num=v=>typeof v==='number'&&Number.isFinite(v)?v:null;
const pos=v=>{const n=num(v);return n!==null&&n>0?n:null;};
const str=(v,n=120)=>typeof v==='string'?v.replace(/[\u0000-\u001f\u007f]/g,'').slice(0,n):'';
export const gb=bytes=>pos(bytes)===null?null:Math.round(bytes/GiB*10)/10;
const short=n=>n>=1e9?`${Math.round(n/1e8)/10}G`:n>=1e6?`${Math.round(n/1e5)/10}M`:n>=1e4?`${Math.round(n/1e3)}k`:String(Math.round(n));
const tps=v=>String(Math.round(v*10)/10);
const median=v=>{const s=v.filter(x=>Number.isFinite(x)&&x>0).sort((a,b)=>a-b);return s.length?s[Math.floor(s.length/2)]:null;};
// One figure for the card: {label, value}; label is a Czech source string (English in public/i18n-en-home.js).
const stat=(label,value)=>value===null||value===undefined||value===''?null:{label,value:String(value)};
const memory=(used,max)=>pos(max)?`${gb(used)??0} / ${gb(max)} GB`:pos(used)?`${gb(used)} GB`:null;
const stats=(...items)=>items.filter(Boolean).slice(0,6);

// --- HTTP ------------------------------------------------------------------------------------
export class RuntimeReadError extends Error{constructor(code,status=null){super(code);this.code=code;this.status=status;}}
// What went wrong, as a short code the integration page and the logs can show. refused = nothing listens
// there (on loopback that means the runtime is not running); the rest says nothing about the machine.
export function errorCode(e){
 if(e instanceof RuntimeReadError)return e.code;
 const code=e?.cause?.code||e?.code||'';
 if(e?.name==='TimeoutError'||e?.name==='AbortError'||code==='UND_ERR_CONNECT_TIMEOUT'||code==='UND_ERR_HEADERS_TIMEOUT')return 'timeout';
 if(code==='ECONNREFUSED')return 'refused';
 if(code==='ENOTFOUND'||code==='EAI_AGAIN')return 'dns';
 if(['EHOSTUNREACH','ENETUNREACH','EHOSTDOWN'].includes(code))return 'unreachable';
 if(code==='ECONNRESET'||code==='UND_ERR_SOCKET')return 'reset';
 if(/CERT|TLS|SSL/.test(code)||/certificate/i.test(e?.cause?.message||''))return 'tls';
 return 'error';
}
// A reader bound to one runtime's base URL (an origin, nothing after it). get(path, 'json'|'text').
// token: a bearer token stored server-side for this endpoint; sent as Authorization and nowhere else.
export function createReader({base,token=null,fetcher=fetch,timeoutMs=TIMEOUT_MS,maxBytes=MAX_BODY,onRequest=null}){
 const origin=new URL(base).origin;
 return async function get(path,as='json'){
  if(!READ_PATHS.includes(path))throw new RuntimeReadError('path-not-allowed');
  const url=origin+path;onRequest?.({method:'GET',url});
  const response=await fetcher(url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(timeoutMs),
   headers:{Accept:as==='json'?'application/json':'text/plain','User-Agent':'home-hub-runtimes/1',...(token?{Authorization:`Bearer ${token}`}:{})}});
  let size=0;const chunks=[];
  if(response.body)for await(const chunk of response.body){size+=chunk.length;if(size>maxBytes)throw new RuntimeReadError('too-large');chunks.push(Buffer.from(chunk));}
  if(!response.ok)throw new RuntimeReadError(response.status===401||response.status===403?'auth':`http-${response.status}`,response.status);
  const text=Buffer.concat(chunks).toString('utf8');
  if(as==='text')return text;
  try{return JSON.parse(text);}catch{throw new RuntimeReadError('not-json');}
 };
}
// An optional read: its failure leaves the field empty instead of failing the runtime.
const optional=p=>p.then(v=>v,()=>null);

// --- Prometheus text format -----------------------------------------------------------------------
// [{name, labels, value}]; comments and malformed lines are skipped. Enough for the gauges and counters below.
export function parsePrometheus(text){
 const out=[];
 for(const line of String(text).split('\n')){
  if(!line||line.startsWith('#'))continue;
  const m=/^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})?\s+(\S+)/.exec(line);if(!m)continue;
  const value=Number(m[3]);if(!Number.isFinite(value))continue;
  const labels={};for(const l of (m[2]||'').matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g))labels[l[1]]=l[2];
  out.push({name:m[1],labels,value});
 }
 return out;
}
// The sum of one metric over all its label sets (a counter per model, say), or null when it is absent.
// names: alternatives, first match wins (metric names differ between versions).
export function metric(samples,...names){
 for(const name of names){const hit=samples.filter(s=>s.name===name||s.name===`${name}_total`);if(hit.length)return hit.reduce((a,s)=>a+s.value,0);}
 return null;
}
// tokens per second from a counter and the previous sample of it (memo = what the last read kept).
function rate(memo,key,value,now){
 if(!memo||value===null)return null;const before=memo[key];memo[key]={value,at:now};
 if(!before||value<before.value||now<=before.at)return null;
 const r=(value-before.value)/((now-before.at)/1000);return r>0?r:null;
}

// --- model states -------------------------------------------------------------------------------
// loaded | loading | unloaded | unknown, from the words runtimes use.
export function modelState(v){
 const s=typeof v==='string'?v.toLowerCase():v;
 if(s===true||['ready','loaded','running','active'].includes(s))return 'loaded';
 if(['starting','loading','stopping','unloading','shutdown','swapping'].includes(s))return 'loading';
 if(s===false||['unloaded','stopped','not-loaded','not_loaded','idle','',null,undefined].includes(s))return 'unloaded';
 return 'unknown';
}
const model=(id,{state='unknown',sizeGb=null,contextTokens=null,ttlRemainingSeconds=null}={})=>({id:str(id,120),state,sizeGb,contextTokens:pos(contextTokens),ttlRemainingSeconds:num(ttlRemainingSeconds)!==null?Math.max(0,Math.round(ttlRemainingSeconds)):null});
const loadedFirst=models=>models.filter(m=>m.id).sort((a,b)=>(b.state==='loaded')-(a.state==='loaded')).slice(0,30);

// --- adapters -----------------------------------------------------------------------------------
// Each one: (get, {now, memo}) → {version, models, stats}. The first read is the one that must work: it
// throws when the runtime does not answer; every other read is optional.

// llama-swap. Two flavours exist: newer builds have /api/version, /api/metrics/stats, /api/metrics/activity
// and Prometheus /metrics; older ones /api/metrics (a list of recent requests). /running says which models
// hold memory and their TTL; the last request per model (from the metrics) turns that into "unloads in".
export async function readLlamaSwap(get,{now=Date.now()}={}){
 const listed=arr((await get('/v1/models'))?.data);
 const [running,version,totals,activity,prom]=await Promise.all([optional(get('/running')),optional(get('/api/version')),optional(get('/api/metrics/stats')),optional(get('/api/metrics/activity')),optional(get('/metrics','text'))]);
 let recent=activity?arr(activity.data):null;
 if(!recent){const legacy=await optional(get('/api/metrics'));recent=Array.isArray(legacy)?legacy:arr(legacy?.data);}
 const runningBy=new Map(arr(running?.running).filter(r=>typeof r?.model==='string').map(r=>[r.model,r]));
 const last=new Map();
 for(const r of recent){const ts=Date.parse(r?.timestamp);if(typeof r?.model!=='string'||!Number.isFinite(ts))continue;const end=ts+(num(r.duration_ms)||0);if(end>(last.get(r.model)||0))last.set(r.model,end);}
 const models=listed.filter(m=>typeof m?.id==='string').map(m=>{
  const r=runningBy.get(m.id),state=modelState(r?.state??m.status?.value??(r?'ready':'unloaded'));
  const ttl=pos(r?.ttl),end=last.get(m.id);
  return model(m.id,{state,contextTokens:m.context_length??m.meta?.n_ctx,ttlRemainingSeconds:state==='loaded'&&ttl&&end?ttl-(now-end)/1000:null});
 });
 const samples=prom?parsePrometheus(prom):[];
 const speed=pos(totals?.gen_histogram?.p50)??median(recent.map(r=>num(r?.tokens?.tokens_per_second??r?.tokens_per_second)));
 return {version:str(version?.version,40),models:loadedFirst(models),
  stats:stats(stat('tokeny/s',speed?tps(speed):null),stat('požadavky',num(totals?.total_requests)!==null?short(totals.total_requests):null),
   stat('tokeny ven',num(totals?.total_output_tokens)!==null?short(totals.total_output_tokens):null),
   stat('paměť stroje',memory(metric(samples,'llamaswap_memory_used_bytes'),metric(samples,'llamaswap_memory_total_bytes'))))};
}

// Ollama: /api/tags (installed), /api/ps (in memory: size, size_vram, expires_at, context_length), /api/version.
export async function readOllama(get,{now=Date.now()}={}){
 const tags=arr((await get('/api/tags'))?.models);
 const [version,ps]=await Promise.all([optional(get('/api/version')),optional(get('/api/ps'))]);
 const loaded=new Map(arr(ps?.models).filter(m=>typeof m?.name==='string').map(m=>[m.name,m]));
 const ttl=m=>{const at=Date.parse(m?.expires_at);return Number.isFinite(at)&&at-now<366*86400000?(at-now)/1000:null;};
 const fromPs=m=>model(m.name,{state:'loaded',sizeGb:gb(m.size_vram||m.size),contextTokens:m.context_length,ttlRemainingSeconds:ttl(m)});
 const models=[...tags.filter(m=>typeof m?.name==='string').map(m=>loaded.has(m.name)?fromPs(loaded.get(m.name)):model(m.name,{state:'unloaded',sizeGb:gb(m.size)})),
  ...[...loaded.values()].filter(m=>!tags.some(t=>t?.name===m.name)).map(fromPs)];
 const vram=[...loaded.values()].reduce((a,m)=>a+(num(m.size_vram)||0),0);
 return {version:str(version?.version,40),models:loadedFirst(models),
  stats:stats(ps?stat('paměť modelů',`${gb(vram)??0} GB`):null,ps?stat('načtené modely',loaded.size):null,stat('modely',tags.length))};
}

// LM Studio's REST API (v0): every downloaded model with state loaded / not-loaded and its context length.
export async function readLmStudio(get){
 const data=arr((await get('/api/v0/models'))?.data).filter(m=>typeof m?.id==='string');
 const models=data.map(m=>model(m.id,{state:modelState(m.state),contextTokens:m.loaded_context_length??m.max_context_length}));
 return {version:'',models:loadedFirst(models),stats:stats(stat('načtené modely',models.filter(m=>m.state==='loaded').length),stat('modely',models.length))};
}

// llama.cpp server: /v1/models (one model, or several with a status in router mode), /props (context,
// slots, build), /health, and /metrics when it was started with --metrics.
export async function readLlamaCpp(get,{now=Date.now(),memo=null}={}){
 const listed=arr((await get('/v1/models'))?.data).filter(m=>typeof m?.id==='string');
 const [props,health,prom]=await Promise.all([optional(get('/props')),optional(get('/health')),optional(get('/metrics','text'))]);
 const router=listed.some(m=>m.status&&typeof m.status==='object');
 const ctx=pos(props?.default_generation_settings?.n_ctx)??pos(props?.n_ctx);
 const models=listed.map(m=>model(m.id,router?{state:modelState(m.status?.value),contextTokens:m.meta?.n_ctx_train}
  :{state:health&&health.status&&health.status!=='ok'?'loading':'loaded',sizeGb:gb(m.meta?.size),contextTokens:ctx??m.meta?.n_ctx_train}));
 const samples=prom?parsePrometheus(prom):[];
 const speed=metric(samples,'llamacpp:predicted_tokens_seconds')??rate(memo,'gen',metric(samples,'llamacpp:tokens_predicted'),now);
 const out=metric(samples,'llamacpp:tokens_predicted');
 return {version:str(props?.build_info,40),models:loadedFirst(models),
  stats:stats(stat('tokeny/s',pos(speed)?tps(speed):null),stat('zpracovává',metric(samples,'llamacpp:requests_processing')),stat('tokeny ven',out!==null?short(out):null),
   stat('sloty',pos(props?.total_slots)))};
}

// vLLM and SGLang: /v1/models (what is served is in memory) and Prometheus /metrics, read by name.
async function readPrometheusServer(get,{now=Date.now(),memo=null}={},names){
 const listed=arr((await get('/v1/models'))?.data).filter(m=>typeof m?.id==='string');
 const [prom,version]=await Promise.all([optional(get('/metrics','text')),names.version?optional(get('/version')):null]);
 const samples=prom?parsePrometheus(prom):[];
 const generated=metric(samples,...names.generated);
 const speed=(names.speed?metric(samples,...names.speed):null)??rate(memo,'gen',generated,now);
 const cache=metric(samples,...names.cache);
 return {version:str(version?.version,40),models:loadedFirst(listed.map(m=>model(m.id,{state:'loaded',contextTokens:m.max_model_len}))),
  stats:stats(stat('tokeny/s',pos(speed)?tps(speed):null),stat('zpracovává',metric(samples,...names.running)),stat('ve frontě',metric(samples,...names.waiting)),
   stat('KV cache',cache!==null?`${Math.round(cache*100)} %`:null),stat('tokeny ven',generated!==null?short(generated):null))};
}
export const readVllm=(get,ctx)=>readPrometheusServer(get,ctx,{version:true,generated:['vllm:generation_tokens'],speed:null,
 running:['vllm:num_requests_running'],waiting:['vllm:num_requests_waiting'],cache:['vllm:kv_cache_usage_perc','vllm:gpu_cache_usage_perc']});
export const readSglang=(get,ctx)=>readPrometheusServer(get,ctx,{version:false,generated:['sglang:generation_tokens'],speed:['sglang:gen_throughput'],
 running:['sglang:num_running_reqs'],waiting:['sglang:num_queue_reqs'],cache:['sglang:token_usage']});

// oMLX: /health (the engine pool), /v1/models/status (each model: loaded, loading, size, context) or, on
// builds without it, /v1/models; /admin/api/stats for the version and the totals when the admin API answers.
export async function readOmlx(get){
 const health=await get('/health');
 const [status,admin]=await Promise.all([optional(get('/v1/models/status')),optional(get('/admin/api/stats'))]);
 const pool=health?.engine_pool||{};
 let models;
 if(Array.isArray(status?.models))models=status.models.filter(m=>typeof m?.id==='string').map(m=>{const state=m.loaded?'loaded':m.is_loading?'loading':'unloaded';
  return model(m.id,{state,sizeGb:gb(state==='loaded'?m.actual_size||m.estimated_size:m.estimated_size),contextTokens:m.max_context_window??m.model_context_length});});
 else{const listed=arr((await optional(get('/v1/models')))?.data).filter(m=>typeof m?.id==='string'),count=num(pool.loaded_count);
  models=listed.map(m=>model(m.id,{state:count===0?'unloaded':count>=listed.length?'loaded':'unknown',contextTokens:m.max_model_len}));}
 const active=admin?.active_models||{};
 const engine=admin?.engines?.['mlx-lm']?.version;
 return {version:engine?str(`mlx-lm ${engine}`,40):'',models:loadedFirst(models),
  stats:stats(stat('tokeny/s',pos(admin?.avg_generation_tps)?tps(admin.avg_generation_tps):null),stat('požadavky',num(admin?.total_requests)!==null?short(admin.total_requests):null),
   stat('tokeny ven',num(admin?.total_completion_tokens)!==null?short(admin.total_completion_tokens):null),
   stat('paměť modelů',memory(active.model_memory_used??pool.current_model_memory,active.model_memory_max??pool.final_ceiling)))};
}

// mlx-serve: /v1/models carries each pack's state, resident and on-disk bytes; /api/version its version.
export async function readMlxServe(get){
 const packs=arr((await get('/v1/models'))?.data).filter(m=>typeof m?.id==='string');
 const version=await optional(get('/api/version'));
 const models=packs.map(m=>{const state=m.loaded===true?'loaded':modelState(m.state);return model(m.id,{state,sizeGb:gb(state==='loaded'?m.bytes_resident||m.bytes_on_disk:m.bytes_on_disk),contextTokens:m.context_length});});
 const resident=packs.reduce((a,m)=>a+(num(m.bytes_resident)||0),0);
 return {version:str(version?.version,40),models:loadedFirst(models),stats:stats(stat('paměť modelů',`${gb(resident)??0} GB`),stat('modely',models.length))};
}

// Anything OpenAI-compatible: it answers and lists its models. Whether one is in memory is not known.
export async function readOpenAi(get){
 const listed=arr((await get('/v1/models'))?.data).filter(m=>typeof m?.id==='string');
 return {version:'',models:listed.slice(0,30).map(m=>model(m.id,{state:'unknown',contextTokens:m.context_length??m.max_model_len})),stats:stats(stat('modely',listed.length))};
}

export const ADAPTERS=Object.freeze({'llama-swap':readLlamaSwap,ollama:readOllama,lmstudio:readLmStudio,'llama-cpp':readLlamaCpp,vllm:readVllm,sglang:readSglang,omlx:readOmlx,'mlx-serve':readMlxServe,openai:readOpenAi});

// kind "auto": which runtime answers here, by fingerprint, with the same read-only GETs. Most specific
// first, so a server that also speaks the OpenAI API is named for what it is. Throws the first transport
// error when nothing answers at all (refused, timeout, …) so the caller can tell "not running" apart.
const OWNERS={omlx:'omlx','mlx-serve':'mlx-serve',llamacpp:'llama-cpp',vllm:'vllm',sglang:'sglang'};
export async function detectKind(get){
 let firstError=null;const attempt=p=>p.catch(e=>{firstError??=e;return null;});
 const running=await attempt(get('/running'));
 if(Array.isArray(running?.running))return 'llama-swap';
 if(firstError&&['refused','timeout','dns','unreachable','tls'].includes(errorCode(firstError)))throw firstError;
 const models=await attempt(get('/v1/models'));
 const owner=arr(models?.data).map(m=>m?.owned_by).find(o=>typeof o==='string'&&Object.hasOwn(OWNERS,o));
 if(owner)return OWNERS[owner];
 const lms=await attempt(get('/api/v0/models'));
 if(arr(lms?.data).some(m=>typeof m?.state==='string'))return 'lmstudio';
 const tags=await attempt(get('/api/tags'));
 if(Array.isArray(tags?.models))return 'ollama';
 const props=await attempt(get('/props'));
 if(props&&typeof props==='object'&&('total_slots' in props||'build_info' in props||'default_generation_settings' in props))return 'llama-cpp';
 const health=await attempt(get('/health'));
 if(health?.engine_pool)return 'omlx';
 const prom=await attempt(get('/metrics','text'));
 if(typeof prom==='string'){if(/^vllm:/m.test(prom))return 'vllm';if(/^sglang:/m.test(prom))return 'sglang';if(/^llamacpp:/m.test(prom))return 'llama-cpp';}
 if(Array.isArray(models?.data))return 'openai';
 throw firstError||new RuntimeReadError('unrecognised');
}

// One read of one runtime → {kind, version, models, stats}. kind: a RUNTIME_KINDS value; for "auto" the
// detected kind is used (pass detected to skip detection on later reads).
export async function readRuntime(get,{kind,detected=null,now=Date.now(),memo=null}){
 const actual=kind==='auto'?detected||await detectKind(get):kind;
 const adapter=ADAPTERS[actual];if(!adapter)throw new RuntimeReadError('unknown-kind');
 return {kind:actual,...await adapter(get,{now,memo})};
}
