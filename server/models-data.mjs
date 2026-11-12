// "LLM & Diffusion" page boundary (core): local language and generative models across every machine.
// Core reads no runtime itself. Everything comes from two extension points (docs/plugins.md):
//   home.runtimes      {machineId: {source, observedAt, runtimes[]}}   what runs where right now
//   runtimes.requests  {id, read({from, to, limit}) → items[]}        request history, when a provider keeps one
// plus what the site already says about a machine's stack (site.json → machines[].stack, runtime_publish), which
// names tools no provider watches (mflux, ComfyUI, …): those are listed as "known, no live stats".
// The functions here are pure: the module (server/core/models.mjs) collects, these shape. Nothing is invented:
// a client that the data does not name is "Unattributed", a client machine that it does not name is null.
const text=(v,n=120)=>typeof v==='string'?v.replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,n):'';
const num=(v,max=1e12)=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=max?v:null;
const plain=v=>v&&typeof v==='object'&&!Array.isArray(v);
const MACHINE=/^[a-z0-9][a-z0-9_-]{0,31}$/;
const timeMs=v=>{const t=typeof v==='number'?v:Date.parse(v);return Number.isFinite(t)?t:null;};
const iso=ms=>ms==null?null:new Date(ms).toISOString();
export const median=values=>{const s=values.filter(v=>Number.isFinite(v)).sort((a,b)=>a-b);if(!s.length)return null;const m=Math.floor(s.length/2);return s.length%2?s[m]:(s[m-1]+s[m])/2;};
const round=(v,d=1)=>v==null?null:Math.round(v*10**d)/10**d;

export const MODEL_KINDS=Object.freeze(['llm','embedding','image','video','music','audio','other']);
export const REQUEST_KINDS=Object.freeze(['chat','embeddings','images','audio','other']);
export const MODEL_STATES=Object.freeze(['loaded','loading','unloaded','unknown']);
export const MODEL_RANGES=Object.freeze({'24h':{ms:86400000,stepMs:3600000},'7d':{ms:7*86400000,stepMs:6*3600000},'30d':{ms:30*86400000,stepMs:86400000}});
// Traffic this recent drives the moving particles of the wiring diagram; older traffic only weighs the line.
export const RECENT_MS=15*60000;
export const UNATTRIBUTED='Unattributed';
export const LIMITS=Object.freeze({machines:24,runtimes:20,models:60,requests:200000,series:8,graphModels:48,clients:40});

// ── Kind of a model ─────────────────────────────────────────────────────────────────────────────
// Explicit kind first, then what the runtime says it can do (capabilities), then its engine family and its
// name. Order matters: an embedding model named after an LLM family is still an embedding model, a TTS model
// whose name contains "chat" is still audio.
const CAPABILITY_KINDS=[['embedding',/^(embed|embedding|embeddings|rerank)$/],['music',/^music$/],['video',/^video$/],['image',/^(image|images|text-to-image|image-generation|diffusion)$/],
 ['audio',/^(audio|sound|speech|tts|stt|asr|voice|transcription)$/],['llm',/^(chat|completion|completions|text|vision|tools|reasoning|llm)$/]];
const NAME_KINDS=[
 ['embedding',/embed|(^|[^a-z])(bge|e5|gte|minilm)([^a-z]|$)|nomic|rerank/],
 ['music',/music|magenta|ace-?step|(^|[^a-z])yue([^a-z]|$)|riffusion|songbloom|diffrhythm/],
 ['audio',/audio|tts|(^|[^a-z])stt([^a-z]|$)|whisper|parakeet|chatterbox|kokoro|voice|speech|(^|[^a-z])sfx([^a-z]|$)|sound|s3tokenizer/],
 ['video',/video|(^|[^a-z])ltx|wan2|mochi|cogvideo/],
 ['image',/image|flux|krea|sdxl|stable-diffusion|(^|[^a-z])sd3|diffusion|hidream|txt2img|(^|[^a-z])t2i([^a-z]|$)|comfy/],
 ['llm',/llm|instruct|qwen|gemma|llama|mistral|mixtral|(^|[^a-z])phi|deepseek|gpt|ornith|(^|[^a-z])vlm|mlx-lm|gguf|coder|glm|kimi|olmo|granite|hermes|chat/]];
export function inferKind(model={},runtime={}){
 if(MODEL_KINDS.includes(model.kind))return model.kind;
 const caps=(Array.isArray(model.capabilities)?model.capabilities:[]).map(c=>String(c).toLowerCase());
 for(const [kind,re] of CAPABILITY_KINDS)if(caps.some(c=>re.test(c)))return kind;
 const hay=`${model.id||''} ${model.name||''} ${model.engine||''}`.toLowerCase();
 for(const [kind,re] of NAME_KINDS)if(re.test(hay))return kind;
 // Nothing in the model itself: a runtime that only serves language models makes it one.
 if(/llama|mlx-lm|ollama|vllm|lm ?studio|omlx|gguf/i.test(`${runtime.id||''} ${runtime.name||''} ${runtime.kind||''}`))return 'llm';
 return 'other';
}
// Kind of a request, from a kind word or the URL path it was sent to.
export function requestKind(path){
 const s=text(path,200).toLowerCase().split('?')[0];
 if(['chat','completion','messages','responses'].includes(s))return 'chat';
 if(['embeddings','rerank'].includes(s))return 'embeddings';
 if(REQUEST_KINDS.includes(s))return s;
 if(/\/chat\/completions$|\/messages(\/count_tokens)?$|\/responses$|\/completions?$|\/infill$|\/api\/(chat|generate)$/.test(s))return 'chat';
 if(/\/embeddings?$|rerank/.test(s))return 'embeddings';
 if(/\/images\//.test(s))return 'images';
 if(/\/audio\//.test(s))return 'audio';
 return 'other';
}
// The name under which one model is recognised on several machines: no organisation prefix, no file extension.
export const modelKey=id=>text(id,160).toLowerCase().split('/').pop().split('--').pop().replace(/\.(gguf|safetensors|bin)$/,'');

// ── Live state ──────────────────────────────────────────────────────────────────────────────────
const ROLE_HINT=/llama-swap|gateway|litellm|proxy|router|openrouter|front.?door/i;
// How busy a model or runtime is right now, where its provider says: requests (or jobs) being worked on and
// those waiting. null = not reported (unknown), never read as idle.
const busy=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=100000?Math.round(v):null;
export function activityOf(a){if(!plain(a))return null;const active=busy(a.active),queued=busy(a.queued);return active===null&&queued===null?null:{active:active??0,queued:queued??0};}
function cleanModel(m){
 const id=text(m.id,160);if(!id)return null;
 const caps=Array.isArray(m.capabilities)?m.capabilities.slice(0,10).map(c=>text(c,30)).filter(Boolean):[];
 const work=activityOf(m),since=timeMs(m.since);
 return {id,name:text(m.name,160)||id,state:MODEL_STATES.includes(m.state)?m.state:m.state==='idle'?'unloaded':'unknown',
  active:work?.active??null,queued:work?.queued??null,since:work?.active&&since!=null?iso(since):null,
  sizeGb:num(m.sizeGb,100000),contextTokens:num(m.contextTokens,1e9),ttlRemainingSeconds:num(m.ttlRemainingSeconds,1e9),ttlSeconds:num(m.ttlSeconds,1e9),
  lastRequestAt:timeMs(m.lastRequestAt)!=null?iso(timeMs(m.lastRequestAt)):null,capabilities:caps,engine:text(m.engine,60)||null,
  via:text(m.via,60)||null,target:text(m.target,160)||null,kind:MODEL_KINDS.includes(m.kind)?m.kind:null};
}
function cleanRuntime(r){
 const id=text(r.id,60);if(!id)return null;
 const role=['gateway','engine'].includes(r.role)?r.role:ROLE_HINT.test(`${id} ${r.name||''}`)?'gateway':'engine';
 const mem=plain(r.memory)?{usedGb:num(r.memory.usedGb,100000),capacityGb:num(r.memory.capacityGb,100000),basis:r.memory.basis==='budget'?'budget':'resident'}:null;
 const seen=new Set();
 return {id,name:text(r.name,60)||id,kind:text(r.kind,80),status:['running','stopped','unknown'].includes(r.status)?r.status:'unknown',url:text(r.url,160)||null,version:text(r.version,60)||null,role,
  mode:r.mode==='cli'?'cli':'server',activity:r.status==='unknown'?null:activityOf(r.activity),
  memory:mem&&(mem.usedGb!=null||mem.capacityGb!=null)?mem:null,
  // A runtime not heard from lately says nothing about now: none of its models is busy or idle.
  models:(Array.isArray(r.models)?r.models:[]).filter(plain).map(cleanModel).filter(m=>m&&!seen.has(m.id)&&seen.add(m.id)).slice(0,LIMITS.models)
   .map(m=>r.status==='unknown'?{...m,active:null,queued:null,since:null}:m)};
}
// merged = Object.assign of every home.runtimes provider; machines = [{id, name, ramGb, ip}] the hub knows.
// → [{machine, name, ramGb, source, observedAt, runtimes[]}], machines in the hub's order, unknown ones after.
export function liveState(merged,machines=[]){
 const known=new Map(machines.map(m=>[m.id,m]));
 const ids=Object.keys(plain(merged)?merged:{}).filter(id=>MACHINE.test(id)&&plain(merged[id])&&Array.isArray(merged[id].runtimes));
 ids.sort((a,b)=>(known.has(a)?machines.findIndex(m=>m.id===a):999)-(known.has(b)?machines.findIndex(m=>m.id===b):999)||a.localeCompare(b));
 return ids.slice(0,LIMITS.machines).map(id=>{const e=merged[id],m=known.get(id)||{};const seen=new Set();
  return {machine:id,name:m.name||id,ramGb:num(m.ramGb,100000),source:text(e.source,40),observedAt:timeMs(e.observedAt)!=null?iso(timeMs(e.observedAt)):null,
   runtimes:e.runtimes.filter(plain).map(cleanRuntime).filter(r=>r&&!seen.has(r.id)&&seen.add(r.id)).slice(0,LIMITS.runtimes)};});
}

// Placements: one model on one runtime of one machine. A gateway's entry that points at an engine's model
// (via = that runtime, target = its model id) is not a placement of its own: it becomes an alias of the
// engine's placement, so one model in memory is counted once.
export function placements(live){
 const out=[];
 for(const m of live){
  const byRuntime=new Map(m.runtimes.map(r=>[r.id,r]));
  const aliases=new Map(),merged=new Set();// "runtime\0model" → [{runtime, alias, lastRequestAt}]; merged = gateway entries folded in
  for(const r of m.runtimes)if(r.role==='gateway')for(const x of r.models){
   const engine=x.via&&byRuntime.get(x.via),hit=engine&&x.target&&engine.models.find(y=>y.id===x.target);
   if(hit){const k=`${engine.id}\u0000${hit.id}`;aliases.set(k,[...(aliases.get(k)||[]),{runtime:r.id,alias:x.id,lastRequestAt:x.lastRequestAt,ttlRemainingSeconds:x.ttlRemainingSeconds,ttlSeconds:x.ttlSeconds,active:x.active,queued:x.queued,since:x.since}]);merged.add(x);}
  }
  for(const r of m.runtimes)for(const x of r.models){
   if(merged.has(x))continue;
   const al=aliases.get(`${r.id}\u0000${x.id}`)||[];
   const last=[x.lastRequestAt,...al.map(a=>a.lastRequestAt)].map(timeMs).filter(v=>v!=null);
   const viaRuntime=r.role==='gateway'&&x.via&&byRuntime.has(x.via)?x.via:null;
   // One request sent through a gateway is in flight at the gateway and at the engine at once: the larger
   // count of the two, never their sum. Unknown at both stays unknown.
   const fold=key=>{const own=x[key],theirs=al.map(a=>a[key]).filter(v=>v!=null);return own==null&&!theirs.length?null:Math.max(own??0,theirs.reduce((n,v)=>n+v,0));};
   const active=fold('active'),queued=fold('queued'),starts=[x.since,...al.map(a=>a.since)].map(timeMs).filter(v=>v!=null);
   out.push({machine:m.machine,machineName:m.name,runtime:r.id,runtimeName:r.name,role:r.role,runtimeStatus:r.status,
    engine:r.role==='gateway'?(x.via||x.engine||null):(x.engine||r.kind||r.name),viaRuntime,
    gateways:[...new Set(al.map(a=>a.runtime))],aliases:al.map(a=>a.alias),
    id:x.id,name:x.name,key:modelKey(x.id),kind:inferKind(x,r),state:x.state,sizeGb:x.sizeGb,contextTokens:x.contextTokens,
    ttlRemainingSeconds:x.ttlRemainingSeconds??al.map(a=>a.ttlRemainingSeconds).find(v=>v!=null)??null,ttlSeconds:x.ttlSeconds??al.map(a=>a.ttlSeconds).find(v=>v!=null)??null,
    lastRequestAt:last.length?iso(Math.max(...last)):null,capabilities:x.capabilities,
    active,queued,since:active&&starts.length?iso(Math.min(...starts)):null,mode:r.mode});
  }
 }
 return out;
}
// What the models of one or more machines work on right now (the machine page's "what the GPU does" and the
// LLM & Diffusion page): placements with a request or job running or waiting, running first, oldest first.
// watching: the runtimes that say how busy they are; blind: those that do not (their work cannot be seen).
export function workOf(live,list){
 const items=list.filter(p=>p.active||p.queued).map(p=>({machine:p.machine,runtime:p.runtime,runtimeName:p.runtimeName,gateways:p.gateways,mode:p.mode||'server',
  id:p.id,name:p.name,kind:p.kind,active:p.active||0,queued:p.queued||0,since:p.since}))
  .sort((a,b)=>(b.active>0)-(a.active>0)||(timeMs(a.since)??Infinity)-(timeMs(b.since)??Infinity)||a.id.localeCompare(b.id));
 const runtimes=live.flatMap(m=>m.runtimes.map(r=>({machine:m.machine,id:r.id,name:r.name,role:r.role,status:r.status,activity:r.activity})));
 return {items:items.slice(0,24),active:items.reduce((n,x)=>n+x.active,0),queued:items.reduce((n,x)=>n+x.queued,0),
  watching:runtimes.filter(r=>r.activity).map(r=>({machine:r.machine,id:r.id,name:r.name})),
  blind:runtimes.filter(r=>!r.activity&&r.status==='running').map(r=>({machine:r.machine,id:r.id,name:r.name}))};
}

// ── Requests ────────────────────────────────────────────────────────────────────────────────────
const IPV4=/^(\d{1,3})(\.\d{1,3}){3}$/;
const isLoopback=a=>/^127\.|^::1$|^localhost$/i.test(a);
export function cleanRequest(r){
 if(!plain(r))return null;const at=timeMs(r.at),machine=text(r.machine,32);if(at==null||!MACHINE.test(machine))return null;
 const address=text(r.clientAddress,64).replace(/^ip:/,'');
 return {machine,runtime:text(r.runtime,60)||'unknown',model:text(r.model,160)||'unknown',at,kind:requestKind(r.kind||r.path),
  inputTokens:num(r.inputTokens)??0,outputTokens:num(r.outputTokens)??0,promptTps:num(r.promptTps,1e7),generationTps:num(r.generationTps,1e7),durationMs:num(r.durationMs,1e9),
  client:text(r.client,60)||UNATTRIBUTED,clientMachine:MACHINE.test(text(r.clientMachine,32))?text(r.clientMachine,32):null,clientAddress:address||null,
  metricId:Number.isSafeInteger(r.metricId)&&r.metricId>=0?r.metricId:null};
}
// Where a client ran: what the provider says, else the site machine whose address sent it. A loopback
// address names no machine: it is this machine or anything tunnelled into it (an SSH forward looks the same).
export function clientMachineOf(r,machines=[]){
 if(r.clientMachine)return {machine:r.clientMachine,via:'provider'};
 if(r.clientAddress&&IPV4.test(r.clientAddress)&&!isLoopback(r.clientAddress)){const m=machines.find(x=>x.ip===r.clientAddress);return m?{machine:m.id,via:'address'}:{machine:null,via:'address'};}
 if(r.clientAddress&&isLoopback(r.clientAddress))return {machine:null,via:'loopback'};
 return {machine:null,via:null};
}
// llama-swap's own request log (GET /api/metrics/activity → data[], or the older GET /api/metrics list) as
// runtimes.requests items. Read-only and repeatable: the log is a ring buffer that reading does not drain, so a
// reader keeps metricKey() of what it already holds. src ("ip:127.0.0.1") is the address the request came from.
export function metricsToRequests(items,{machine,runtime='llama-swap'}={}){
 return (Array.isArray(items)?items:[]).filter(plain).map(m=>{const t=plain(m.tokens)?m.tokens:m;
  const r=cleanRequest({machine,runtime,model:m.model,at:m.timestamp,path:m.req_path||'other',inputTokens:t.input_tokens,outputTokens:t.output_tokens,
   promptTps:t.prompt_per_second,generationTps:t.tokens_per_second,durationMs:m.duration_ms,clientAddress:typeof m.src==='string'?m.src:''});
  return r&&{...r,metricId:Number.isSafeInteger(m.id)?m.id:null};}).filter(Boolean);
}
export const metricKey=r=>`${r.machine}\u0000${r.runtime}\u0000${r.metricId}\u0000${r.at}`;
// The identity of one request across providers: metricKey when the provider carries the runtime's record id,
// else what the request says about itself.
export const requestKey=r=>r.metricId!=null?metricKey(r):`${r.machine}\u0000${r.runtime}\u0000${r.at}\u0000${r.model}\u0000${r.outputTokens}\u0000${r.client}`;

// Which placement a request reached. A request names a runtime (a gateway or an engine) and the model name it
// asked for (perhaps a gateway alias); null when no live placement matches (an unloaded or removed model).
export function placementFor(r,list){
 const here=list.filter(p=>p.machine===r.machine);
 return here.find(p=>p.runtime===r.runtime&&p.id===r.model)
  ||here.find(p=>p.gateways.includes(r.runtime)&&p.aliases.includes(r.model))
  ||here.find(p=>p.id===r.model||p.aliases.includes(r.model))||null;
}

// ── Machines, overview ──────────────────────────────────────────────────────────────────────────
export function machineMemory(live,list){
 return live.map(m=>{
  const mine=list.filter(p=>p.machine===m.machine),loaded=mine.filter(p=>p.state==='loaded'||p.state==='loading');
  const pools=m.runtimes.filter(r=>r.memory).map(r=>({runtime:r.id,name:r.name,usedGb:r.memory.usedGb,capacityGb:r.memory.capacityGb,basis:r.memory.basis}));
  // Resident: what engines say they hold, else the size of what is loaded on them. Budgets are not residency.
  const resident=m.runtimes.filter(r=>r.role==='engine'||!r.memory||r.memory.basis!=='budget').reduce((n,r)=>{
   const reported=r.memory?.basis==='resident'&&r.memory.usedGb!=null?r.memory.usedGb:null;
   return n+(reported??loaded.filter(p=>p.runtime===r.id).reduce((s,p)=>s+(p.sizeGb||0),0));},0);
  return {machine:m.machine,name:m.name,ramGb:m.ramGb,residentGb:round(resident),loaded:loaded.length,models:mine.length,pools};
 });
}
export function overview(live,list,requests,{range='24h',now=Date.now()}={}){
 const runtimes=live.flatMap(m=>m.runtimes);
 const tps=requests.filter(r=>r.generationTps>0&&r.outputTokens>=8).map(r=>r.generationTps);
 return {machines:live.filter(m=>m.runtimes.length).length,
  runtimes:{total:runtimes.length,up:runtimes.filter(r=>r.status==='running').length,down:runtimes.filter(r=>r.status==='stopped').length,unknown:runtimes.filter(r=>r.status==='unknown').length},
  models:{total:list.length,loaded:list.filter(p=>p.state==='loaded').length,loading:list.filter(p=>p.state==='loading').length,
   generating:list.filter(p=>p.active>0).length,queued:list.filter(p=>p.queued>0).length,
   byKind:Object.fromEntries(MODEL_KINDS.map(k=>[k,list.filter(p=>p.kind===k).length]).filter(([,n])=>n))},
  memory:machineMemory(live,list),
  range,requests:requests.length,inputTokens:requests.reduce((n,r)=>n+r.inputTokens,0),outputTokens:requests.reduce((n,r)=>n+r.outputTokens,0),
  medianTps:round(median(tps)),attributed:requests.filter(r=>r.client!==UNATTRIBUTED).length,
  lastRequestAt:requests.length?iso(Math.max(...requests.map(r=>r.at))):null,observedAt:live.map(m=>m.observedAt).filter(Boolean).sort().at(-1)||null,generatedAt:iso(now)};
}

// ── Models table ────────────────────────────────────────────────────────────────────────────────
const STATE_RANK={loaded:3,loading:2,unloaded:1,unknown:0};
export function modelGroups(list,requests=[]){
 const groups=new Map();
 for(const p of list){const g=groups.get(p.key)||{key:p.key,name:p.name,kinds:new Set(),placements:[]};g.kinds.add(p.kind);g.placements.push(p);groups.set(p.key,g);}
 const usage=new Map();
 for(const r of requests){const p=placementFor(r,list);if(!p)continue;const k=`${p.machine}\u0000${p.runtime}\u0000${p.id}`;const u=usage.get(k)||{requests:0,tokens:0,last:0};u.requests++;u.tokens+=r.inputTokens+r.outputTokens;u.last=Math.max(u.last,r.at);usage.set(k,u);}
 return [...groups.values()].map(g=>{
  const kind=[...g.kinds].find(k=>k!=='other')||'other';
  const placementsOut=g.placements.map(p=>{const u=usage.get(`${p.machine}\u0000${p.runtime}\u0000${p.id}`);const last=Math.max(timeMs(p.lastRequestAt)||0,u?.last||0);
   return {machine:p.machine,machineName:p.machineName,runtime:p.runtime,runtimeName:p.runtimeName,role:p.role,runtimeStatus:p.runtimeStatus,engine:p.engine,gateways:p.gateways,aliases:p.aliases,
    id:p.id,state:p.state,sizeGb:p.sizeGb,contextTokens:p.contextTokens,ttlRemainingSeconds:p.ttlRemainingSeconds,ttlSeconds:p.ttlSeconds,lastRequestAt:last?iso(last):null,
    requests:u?.requests||0,tokens:u?.tokens||0,capabilities:p.capabilities,active:p.active??null,queued:p.queued??null,since:p.since||null};}).sort((a,b)=>STATE_RANK[b.state]-STATE_RANK[a.state]||a.machine.localeCompare(b.machine));
  const last=placementsOut.map(p=>timeMs(p.lastRequestAt)).filter(Boolean),watched=placementsOut.filter(p=>p.active!=null||p.queued!=null);
  const starts=placementsOut.filter(p=>p.active).map(p=>timeMs(p.since)).filter(v=>v!=null);
  return {key:g.key,name:g.placements[0].id,kind,state:placementsOut[0].state,machines:[...new Set(placementsOut.map(p=>p.machine))],
   active:watched.length?watched.reduce((n,p)=>n+(p.active||0),0):null,queued:watched.length?watched.reduce((n,p)=>n+(p.queued||0),0):null,since:starts.length?iso(Math.min(...starts)):null,
   sizeGb:Math.max(0,...placementsOut.map(p=>p.sizeGb||0))||null,contextTokens:Math.max(0,...placementsOut.map(p=>p.contextTokens||0))||null,
   ttlRemainingSeconds:placementsOut.find(p=>p.state==='loaded'&&p.ttlRemainingSeconds!=null)?.ttlRemainingSeconds??null,
   lastRequestAt:last.length?iso(Math.max(...last)):null,requests:placementsOut.reduce((n,p)=>n+p.requests,0),tokens:placementsOut.reduce((n,p)=>n+p.tokens,0),placements:placementsOut};
 }).sort((a,b)=>(b.active>0)-(a.active>0)||(b.queued>0)-(a.queued>0)||STATE_RANK[b.state]-STATE_RANK[a.state]||b.requests-a.requests||a.name.localeCompare(b.name));
}

// ── Clients ─────────────────────────────────────────────────────────────────────────────────────
export function clientsOf(requests,list,machines=[],{now=Date.now()}={}){
 const out=new Map();
 for(const r of requests){
  const where=clientMachineOf(r,machines),key=`${r.client}\u0000${where.machine||''}`;
  const c=out.get(key)||{client:r.client,clientMachine:where.machine,via:new Set(),requests:0,inputTokens:0,outputTokens:0,recent:0,lastAt:0,targets:new Map()};
  if(where.via)c.via.add(where.via);c.requests++;c.inputTokens+=r.inputTokens;c.outputTokens+=r.outputTokens;c.lastAt=Math.max(c.lastAt,r.at);if(now-r.at<=RECENT_MS)c.recent++;
  const p=placementFor(r,list),tk=`${r.machine}\u0000${r.runtime}`;const tg=c.targets.get(tk)||{machine:r.machine,runtime:r.runtime,requests:0,tokens:0,models:new Map()};
  tg.requests++;tg.tokens+=r.inputTokens+r.outputTokens;const mid=p?.id||r.model;tg.models.set(mid,(tg.models.get(mid)||0)+1);c.targets.set(tk,tg);
  out.set(key,c);
 }
 return [...out.values()].sort((a,b)=>b.requests-a.requests).slice(0,LIMITS.clients).map(c=>({client:c.client,attributed:c.client!==UNATTRIBUTED,clientMachine:c.clientMachine,
  via:[...c.via].sort(),requests:c.requests,inputTokens:c.inputTokens,outputTokens:c.outputTokens,recent:c.recent,lastAt:iso(c.lastAt),
  cross:[...c.targets.values()].some(t=>c.clientMachine&&t.machine!==c.clientMachine),
  targets:[...c.targets.values()].sort((a,b)=>b.requests-a.requests).map(t=>({machine:t.machine,runtime:t.runtime,requests:t.requests,tokens:t.tokens,
   models:[...t.models].sort((a,b)=>b[1]-a[1]).slice(0,6).map(([model,requests])=>({model,requests}))}))}));
}

// ── Known from the stack, no live stats ────────────────────────────────────────────────────────
const GENERATIVE=/mflux|comfy|diffus|flux|stable.?diffusion|draw ?things|magenta|musicgen|audiocraft|whisper|tts|mlx[_-]audio|voice|mlx-serve|invoke|automatic1111|fooocus|llama-server|ollama|lm ?studio|vllm|omlx|llama-swap/i;
// stacks = [{machine, name, stack, source}] from the site configuration and runtime_publish. A runtime-layer
// block that names a tool and no live runtime of that machine matches it → one "known" entry.
export function knownTools(stacks,live){
 const out=[];
 for(const {machine,name,stack,source} of stacks||[]){
  if(!plain(stack)||!Array.isArray(stack.blocks))continue;
  const liveHere=live.find(m=>m.machine===machine)?.runtimes||[];
  const layerOf=b=>typeof b.layer==='number'?String(stack.layers?.[b.layer]??'').toLowerCase():String(b.layer||'').toLowerCase();
  for(const b of stack.blocks){
   if(!plain(b)||b.hw)continue;const layer=layerOf(b),title=text(b.title,60);if(!title)continue;
   const role=/input/.test(layer)?'client':/runtime|tool/.test(layer)?'runtime':null;if(!role)continue;
   if(role==='runtime'&&!GENERATIVE.test(`${title} ${b.desc||''}`))continue;
   const tokens=title.toLowerCase().split(/[^a-z0-9-]+/).filter(t=>t.length>=4);
   if(role==='runtime'&&(liveHere.some(r=>r.id===b.service||r.id.toLowerCase()===title.toLowerCase()||tokens.some(t=>r.id.toLowerCase().includes(t)||r.name.toLowerCase().includes(t)))))continue;
   const models=(Array.isArray(b.models)?b.models:[]).map(m=>text(m?.id,120)).filter(Boolean).slice(0,8);
   out.push({machine,machineName:name||machine,role,title,description:text(b.desc,160),state:b.state==='off'?'off':'on',source,models,
    kind:role==='runtime'?inferKind({id:title,name:`${models.join(' ')} ${b.desc||''}`},{}):null});
  }
 }
 return out.slice(0,60);
}

// ── Wiring diagram ──────────────────────────────────────────────────────────────────────────────
// Columns: client → door (a gateway) → engine (an engine runtime, or an engine inside a gateway such as
// llama.cpp in llama-swap) → model. Lanes: one per machine; clients whose machine is not known share the
// lane "unknown". An edge whose ends sit in different lanes is a cross-machine edge.
export function buildGraph(live,list,requests,{machines=[],known=[],now=Date.now()}={}){
 const nodes=new Map(),edges=new Map();
 const lanes=[...live.map(m=>({id:m.machine,name:m.name}))];
 const laneIds=new Set(lanes.map(l=>l.id));
 const node=(id,data)=>{if(!nodes.has(id))nodes.set(id,{id,requests:0,tokens:0,recent:0,lastAt:null,...data});return nodes.get(id);};
 const edge=(from,to)=>{const id=`${from}→${to}`;if(!edges.has(id))edges.set(id,{id,from,to,requests:0,tokens:0,recent:0,tokensRecent:0,lastAt:null});return edges.get(id);};
 const bump=(x,r)=>{x.requests++;x.tokens+=r.inputTokens+r.outputTokens;if(now-r.at<=RECENT_MS){x.recent++;if('tokensRecent' in x)x.tokensRecent+=r.inputTokens+r.outputTokens;}x.lastAt=Math.max(x.lastAt||0,r.at);};
 const runtimeNode=(m,r)=>node(`rt:${m.machine}:${r.id}`,{column:r.role==='gateway'?'door':'engine',lane:m.machine,label:r.name,sub:r.kind||null,state:r.status,machine:m.machine,runtime:r.id,role:r.role,active:r.activity?.active??null,queued:r.activity?.queued??null});
 const engineInside=(machine,name,gateway)=>node(`en:${machine}:${name}`,{column:'engine',lane:machine,label:name,sub:gateway,state:'running',machine,runtime:null,role:'embedded'});
 const modelNode=p=>node(`md:${p.machine}:${p.runtime}:${p.id}`,{column:'model',lane:p.machine,label:p.id,sub:p.aliases.length?p.aliases.join(', '):null,state:p.state,kind:p.kind,machine:p.machine,runtime:p.runtime,model:p.id,key:p.key,sizeGb:p.sizeGb,active:p.active??null,queued:p.queued??null});
 // Static structure: every runtime, the path each model is served on.
 const inMemory=p=>p.active>0||p.queued>0||p.state==='loaded'||p.state==='loading';
 const shown=list.filter(inMemory).concat(list.filter(p=>!inMemory(p))).slice(0,LIMITS.graphModels);
 for(const m of live)for(const r of m.runtimes)runtimeNode(m,r);
 const pathOf=p=>{// [door?, engine?, model] node ids
  const m=live.find(x=>x.machine===p.machine),r=m.runtimes.find(x=>x.id===p.runtime),md=modelNode(p).id,ids=[];
  if(r.role==='gateway'){ids.push(runtimeNode(m,r).id);if(p.engine)ids.push(p.viaRuntime?runtimeNode(m,m.runtimes.find(x=>x.id===p.viaRuntime)).id:engineInside(m.machine,p.engine,r.name).id);}
  else{const g=p.gateways[0]&&m.runtimes.find(x=>x.id===p.gateways[0]);if(g)ids.push(runtimeNode(m,g).id);ids.push(runtimeNode(m,r).id);}
  ids.push(md);return ids;
 };
 for(const p of shown){const ids=pathOf(p);for(let i=1;i<ids.length;i++)edge(ids[i-1],ids[i]);}
 // Known tools without live stats: engines that serve nothing the hub can see.
 for(const k of known.filter(k=>k.role==='runtime'&&laneIds.has(k.machine)))node(`kn:${k.machine}:${k.title}`,{column:'engine',lane:k.machine,label:k.title,sub:k.models.join(', ')||null,state:k.state==='off'?'stopped':'known',known:true,kind:k.kind,machine:k.machine,runtime:null});
 // Traffic: client → the runtime it called → … → the model.
 let cross=0;
 for(const r of requests){
  const where=clientMachineOf(r,machines),lane=where.machine||'unknown';
  if(!laneIds.has(lane)){lanes.push({id:lane,name:lane==='unknown'?null:(machines.find(m=>m.id===lane)?.name||lane)});laneIds.add(lane);}
  const c=node(`cl:${lane}:${r.client}`,{column:'client',lane,label:r.client,sub:where.via==='loopback'?'loopback':null,state:r.client===UNATTRIBUTED?'unknown':'running',machine:where.machine,client:r.client,attributed:r.client!==UNATTRIBUTED});
  bump(c,r);
  const p=placementFor(r,list);let ids;
  if(p&&shown.includes(p)){ids=pathOf(p);const at=ids.indexOf(`rt:${r.machine}:${r.runtime}`);if(at>0)ids=ids.slice(at);}
  else{const m=live.find(x=>x.machine===r.machine),rt=m?.runtimes.find(x=>x.id===r.runtime);
   const end=node(`md:${r.machine}:${r.runtime}:${r.model}`,{column:'model',lane:r.machine,label:r.model,sub:null,state:'unknown',kind:inferKind({id:r.model},rt||{}),machine:r.machine,runtime:r.runtime,model:r.model,history:true});
   if(!laneIds.has(r.machine)){lanes.push({id:r.machine,name:machines.find(x=>x.id===r.machine)?.name||r.machine});laneIds.add(r.machine);}
   ids=[...(m&&rt?[runtimeNode(m,rt).id]:[node(`rt:${r.machine}:${r.runtime}`,{column:'door',lane:r.machine,label:r.runtime,sub:null,state:'unknown',machine:r.machine,runtime:r.runtime,role:'gateway'}).id]),end.id];}
  const first=edge(c.id,ids[0]);bump(first,r);if(where.machine&&where.machine!==r.machine){first.cross=true;cross++;}
  for(let i=0;i<ids.length;i++){bump(nodes.get(ids[i]),r);if(i)bump(edge(ids[i-1],ids[i]),r);}
 }
 // Known clients of the stack (site.json input layer): drawn faint, so a lane shows who usually calls from there.
 for(const k of known.filter(k=>k.role==='client'&&laneIds.has(k.machine)))if(![...nodes.values()].some(n=>n.column==='client'&&n.lane===k.machine&&n.label===k.title))
  node(`kc:${k.machine}:${k.title}`,{column:'client',lane:k.machine,label:k.title,sub:null,state:'known',known:true,machine:k.machine});
 const out=[...nodes.values()].map(n=>({...n,lastAt:n.lastAt?iso(n.lastAt):null}));
 const usedLanes=new Set(out.map(n=>n.lane));
 return {lanes:lanes.filter(l=>usedLanes.has(l.id)),nodes:out,edges:[...edges.values()].map(e=>({...e,cross:Boolean(e.cross),lastAt:e.lastAt?iso(e.lastAt):null})),
  maxRequests:Math.max(0,...[...edges.values()].map(e=>e.requests)),maxRecent:Math.max(0,...[...edges.values()].map(e=>e.recent)),crossRequests:cross,recentMinutes:RECENT_MS/60000,
  truncated:Math.max(0,list.length-shown.length)};
}

// ── History ─────────────────────────────────────────────────────────────────────────────────────
function tzOffset(ms,timeZone){
 try{const p=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone,hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'}).formatToParts(ms).map(x=>[x.type,x.value]));
  return Date.UTC(+p.year,+p.month-1,+p.day,+p.hour%24,+p.minute,+p.second)-Math.floor(ms/1000)*1000;}catch{return 0;}
}
// Bucket edges for a range: whole hours / six hours / days of the site's clock, the last bucket the one running now.
export function buckets(range,now=Date.now(),timeZone='UTC'){
 const spec=MODEL_RANGES[range];if(!spec)throw new Error('invalid');
 const off=tzOffset(now,timeZone),end=Math.ceil((now+off+1)/spec.stepMs)*spec.stepMs-off,n=Math.round(spec.ms/spec.stepMs);
 return {stepMs:spec.stepMs,starts:Array.from({length:n},(_,i)=>end-(n-i)*spec.stepMs),from:end-n*spec.stepMs,to:end};
}
const ranked=(rows,key,limit)=>{const c=new Map();for(const r of rows)c.set(key(r),(c.get(key(r))||0)+1);return [...c].sort((a,b)=>b[1]-a[1]||String(a[0]).localeCompare(String(b[0]))).map(([k])=>k).slice(0,limit);};
export function history(requests,list,{range='24h',now=Date.now(),timeZone='UTC',machines=[]}={}){
 const b=buckets(range,now,timeZone),n=b.starts.length,idx=at=>Math.min(n-1,Math.floor((at-b.from)/b.stepMs));
 const rows=requests.filter(r=>r.at>=b.from&&r.at<=now).map(r=>({...r,modelName:placementFor(r,list)?.id||r.model}));
 const dims={model:r=>r.modelName,machine:r=>r.machine,client:r=>r.client,kind:r=>r.kind};
 const series={};
 for(const [dim,key] of Object.entries(dims)){
  const top=ranked(rows,key,LIMITS.series),bySeries=Object.fromEntries(top.map(k=>[k,Array(n).fill(0)]));let other=null;
  for(const r of rows){const k=key(r);if(bySeries[k])bySeries[k][idx(r.at)]++;else{other??=Array(n).fill(0);other[idx(r.at)]++;}}
  series[dim]={keys:[...top,...(other?['other']:[])],values:{...bySeries,...(other?{other}:{})}};
 }
 const input=Array(n).fill(0),output=Array(n).fill(0),count=Array(n).fill(0),tps=Array.from({length:n},()=>[]);
 for(const r of rows){const i=idx(r.at);input[i]+=r.inputTokens;output[i]+=r.outputTokens;count[i]++;if(r.generationTps>0&&r.outputTokens>=8)tps[i].push(r.generationTps);}
 const table=(key)=>{const m=new Map();for(const r of rows){const k=key(r),x=m.get(k)||{key:k,requests:0,inputTokens:0,outputTokens:0,tps:[],durations:[]};x.requests++;x.inputTokens+=r.inputTokens;x.outputTokens+=r.outputTokens;if(r.generationTps>0&&r.outputTokens>=8)x.tps.push(r.generationTps);if(r.durationMs!=null)x.durations.push(r.durationMs);m.set(k,x);}
  return [...m.values()].sort((a,b)=>b.requests-a.requests).slice(0,20).map(({tps,durations,...x})=>({...x,medianTps:round(median(tps)),medianDurationMs:median(durations)}));};
 return {range,stepMs:b.stepMs,from:iso(b.from),to:iso(b.to),buckets:b.starts.map(iso),
  totals:{requests:rows.length,inputTokens:input.reduce((a,v)=>a+v,0),outputTokens:output.reduce((a,v)=>a+v,0),medianTps:round(median(rows.filter(r=>r.generationTps>0&&r.outputTokens>=8).map(r=>r.generationTps))),attributed:rows.filter(r=>r.client!==UNATTRIBUTED).length},
  requests:count,inputTokens:input,outputTokens:output,tps:tps.map(v=>round(median(v))),series,
  top:{model:table(dims.model),machine:table(dims.machine),client:table(dims.client),kind:table(dims.kind)}};
}
