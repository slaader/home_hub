// Local LLM runtimes read directly over HTTP (server/runtime-adapters.mjs, server/runtimes-data.mjs,
// server/core/runtimes.mjs): every adapter against recorded or documented responses, the read-only
// guarantee, the endpoint rules, the merge with a plugin's report, the API, MCP and the integration status.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {stat,readFile,mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ADAPTERS,READ_PATHS,createReader,detectKind,readRuntime,parsePrometheus,metric,errorCode} from '../server/runtime-adapters.mjs';
import {runtimeEndpoint,validateSite} from '../server/site-config.mjs';
import {createRuntimePoller,createTokenStore,createEndpointStore,allEndpoints} from '../server/runtimes-data.mjs';
import {mergeRuntimeReports,buildHome,runtimesFor} from '../server/home-data.mjs';
import {hub,SITE} from './hub-helper.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const fixture=name=>JSON.parse(readFileSync(path.join(here,'fixtures','runtimes',`${name}.json`),'utf8'));
const FIXTURES=readdirSync(path.join(here,'fixtures','runtimes')).filter(f=>f.endsWith('.json')).map(f=>f.slice(0,-5));

// A fake runtime: answers the paths of its fixture, 404 anywhere else, and records every request.
function fakeRuntime(routes,{log=[],status={}}={}){
 const fetcher=async(url,init={})=>{
  const u=new URL(url);log.push({method:init.method||'GET',path:u.pathname,search:u.search,url,redirect:init.redirect,auth:init.headers?.Authorization||null,hasSignal:Boolean(init.signal)});
  if(status[u.pathname])return new Response('{}',{status:status[u.pathname]});
  if(!Object.hasOwn(routes,u.pathname))return new Response('not found',{status:404});
  const v=routes[u.pathname];return new Response(typeof v==='string'?v:JSON.stringify(v),{status:200,headers:{'Content-Type':typeof v==='string'?'text/plain':'application/json'}});
 };
 return {fetcher,log,get:createReader({base:'http://127.0.0.1:9',fetcher})};
}
const refused=async()=>{throw Object.assign(new TypeError('fetch failed'),{cause:Object.assign(new Error('connect ECONNREFUSED'),{code:'ECONNREFUSED'})});};
const loaded=r=>r.models.filter(m=>m.state==='loaded').map(m=>m.id);
const statOf=(r,label)=>r.stats.find(s=>s.label===label)?.value;

test('llama-swap (recorded, v268 flavour): models with state and context, TTL from the last request, totals and memory',async()=>{
 const f=fixture('llama-swap'),{get}=fakeRuntime(f);
 const end=Math.max(...f['/api/metrics/activity'].data.map(a=>Date.parse(a.timestamp)+a.duration_ms));
 const r=await ADAPTERS['llama-swap'](get,{now:end+600000});
 assert.equal(r.version,'v268');
 assert.equal(r.models.length,5);assert.deepEqual(loaded(r),['qwen-27b'],'the model /running names is loaded, listed first');
 assert.equal(r.models[0].contextTokens,262144);
 assert.equal(r.models[0].ttlRemainingSeconds,1200,'ttl 1800 s, last request ended 10 minutes ago');
 assert.ok(r.models.slice(1).every(m=>m.state==='unloaded'&&m.ttlRemainingSeconds===null));
 assert.deepEqual(r.stats.map(s=>s.label),['tokeny/s','požadavky','tokeny ven','paměť stroje']);
 assert.equal(statOf(r,'tokeny/s'),'113.7');assert.equal(statOf(r,'požadavky'),'941');assert.equal(statOf(r,'tokeny ven'),'759k');assert.equal(statOf(r,'paměť stroje'),'70.9 / 256 GB');
});
test('llama-swap (older flavour): /api/metrics as a list gives the speed; no version',async()=>{
 const {get,log}=fakeRuntime(fixture('llama-swap-legacy'));
 const r=await ADAPTERS['llama-swap'](get,{now:Date.parse('2026-11-10T10:02:00Z')});
 assert.equal(r.version,'');assert.deepEqual(loaded(r),['gemma-12b']);
 assert.equal(statOf(r,'tokeny/s'),'33.1');
 assert.ok(log.some(x=>x.path==='/api/metrics'),'falls back to the older metrics list');
});
test('oMLX (recorded): per-model state, size and context from /v1/models/status; version and totals from the admin stats',async()=>{
 const {get}=fakeRuntime(fixture('omlx'));
 const r=await ADAPTERS.omlx(get);
 assert.equal(r.models.length,6);assert.deepEqual(loaded(r),['Qwen3.8-27B-8bit']);
 assert.equal(r.models[0].sizeGb,28.8);assert.equal(r.models[0].contextTokens,262144);
 assert.match(r.version,/^mlx-lm 0\.32/);
 assert.equal(statOf(r,'tokeny/s'),'90.7');assert.equal(statOf(r,'požadavky'),'917');assert.equal(statOf(r,'paměť modelů'),'28.8 / 192.6 GB');
 assert.ok(!JSON.stringify(r).includes('api_key'),'nothing but the picked fields');
});
test('oMLX without the status and admin endpoints: the model list and the pool count',async()=>{
 const f=fixture('omlx'),{get}=fakeRuntime({'/health':{...f['/health'],engine_pool:{...f['/health'].engine_pool,loaded_count:0}},'/v1/models':f['/v1/models']});
 const r=await ADAPTERS.omlx(get);
 assert.equal(r.models.length,6);assert.ok(r.models.every(m=>m.state==='unloaded'));assert.equal(r.version,'');
});
test('mlx-serve (recorded): packs with resident and on-disk size, version',async()=>{
 const {get}=fakeRuntime(fixture('mlx-serve'));
 const r=await ADAPTERS['mlx-serve'](get);
 assert.equal(r.version,'26.10.3');assert.deepEqual(loaded(r),['ddalcu/Krea-2-Turbo-MLX-Serve-mixed-4-8']);
 assert.equal(r.models[0].sizeGb,9.2);assert.equal(r.models[1].sizeGb,2.1);assert.equal(statOf(r,'paměť modelů'),'9.2 GB');
});
test('Ollama: installed models, what /api/ps holds (VRAM size, context, time to unload), version',async()=>{
 const {get}=fakeRuntime(fixture('ollama'));
 const r=await ADAPTERS.ollama(get,{now:Date.parse('2026-11-10T11:00:00Z')});
 assert.equal(r.version,'0.12.6');assert.equal(r.models.length,3);assert.deepEqual(loaded(r),['qwen3:30b-a3b']);
 assert.deepEqual(r.models[0],{id:'qwen3:30b-a3b',state:'loaded',sizeGb:20,contextTokens:32768,ttlRemainingSeconds:240});
 assert.equal(r.models.find(m=>m.id==='llama3.2:3b').sizeGb,1.9);
 assert.equal(statOf(r,'paměť modelů'),'20 GB');assert.equal(statOf(r,'načtené modely'),'1');
});
test('LM Studio: loaded and not-loaded models with their context length',async()=>{
 const {get}=fakeRuntime(fixture('lmstudio'));
 const r=await ADAPTERS.lmstudio(get);
 assert.deepEqual(loaded(r),['qwen3-coder-30b-a3b-instruct-mlx']);assert.equal(r.models[0].contextTokens,65536,'the loaded context, not the maximum');
 assert.equal(r.models.find(m=>m.id==='google/gemma-3-12b').state,'unloaded');assert.equal(statOf(r,'modely'),'3');
});
test('llama.cpp server: one model with its size and context, build, metrics; router mode with a state per model',async()=>{
 const one=await ADAPTERS['llama-cpp'](fakeRuntime(fixture('llama-cpp')).get);
 assert.equal(one.version,'b6950-1a2b3c4d');
 assert.deepEqual(one.models,[{id:'gemma-3-27b-it-Q4_K_M.gguf',state:'loaded',sizeGb:15.4,contextTokens:16384,ttlRemainingSeconds:null}]);
 assert.equal(statOf(one,'tokeny/s'),'24.7');assert.equal(statOf(one,'zpracovává'),'1');assert.equal(statOf(one,'tokeny ven'),'48k');assert.equal(statOf(one,'sloty'),'4');
 assert.ok(!JSON.stringify(one).includes('/models/'),'the model path from /props is not kept');
 const router=await ADAPTERS['llama-cpp'](fakeRuntime(fixture('llama-cpp-router')).get);
 assert.deepEqual(router.models.map(m=>[m.id,m.state]),[['gpt-oss-20b','loaded'],['qwen2.5-coder-7b','unloaded'],['gemma-3-4b','loading']]);
});
test('vLLM and SGLang: Prometheus metrics by name; a counter becomes tokens per second between two reads',async()=>{
 const f=fixture('vllm'),memo={},t0=Date.parse('2026-11-10T10:00:00Z');
 const first=await ADAPTERS.vllm(fakeRuntime(f).get,{now:t0,memo});
 assert.equal(first.version,'0.11.0');assert.deepEqual(first.models,[{id:'Qwen/Qwen3-8B',state:'loaded',sizeGb:null,contextTokens:40960,ttlRemainingSeconds:null}]);
 assert.equal(statOf(first,'tokeny/s'),undefined,'one read gives no rate');
 assert.equal(statOf(first,'zpracovává'),'2');assert.equal(statOf(first,'ve frontě'),'1');assert.equal(statOf(first,'KV cache'),'38 %');assert.equal(statOf(first,'tokeny ven'),'120k');
 const later=await ADAPTERS.vllm(fakeRuntime({...f,...fixture('vllm-later')}).get,{now:t0+30000,memo});
 assert.equal(statOf(later,'tokeny/s'),'50');
 const sg=await ADAPTERS.sglang(fakeRuntime(fixture('sglang')).get,{now:t0,memo:{}});
 assert.equal(statOf(sg,'tokeny/s'),'412.6');assert.equal(statOf(sg,'zpracovává'),'3');assert.equal(statOf(sg,'KV cache'),'12 %');assert.equal(statOf(sg,'tokeny ven'),'5.3M');
});
test('OpenAI-compatible fallback: reachable and its model list, state unknown',async()=>{
 const r=await ADAPTERS.openai(fakeRuntime(fixture('openai')).get);
 assert.deepEqual(r.models.map(m=>[m.id,m.state]),[['gpt-4o-mini','unknown'],['local-chat','unknown']]);assert.equal(statOf(r,'modely'),'2');
});
test('auto-detect names each runtime by its fingerprint',async()=>{
 const expect={'llama-swap':'llama-swap','llama-swap-legacy':'llama-swap',omlx:'omlx','mlx-serve':'mlx-serve',ollama:'ollama',lmstudio:'lmstudio','llama-cpp':'llama-cpp','llama-cpp-router':'llama-cpp',vllm:'vllm',sglang:'sglang',openai:'openai'};
 for(const [name,kind] of Object.entries(expect))assert.equal(await detectKind(fakeRuntime(fixture(name)).get),kind,name);
 const r=await readRuntime(fakeRuntime(fixture('ollama')).get,{kind:'auto'});assert.equal(r.kind,'ollama');
 await assert.rejects(detectKind(createReader({base:'http://127.0.0.1:9',fetcher:refused})),e=>errorCode(e)==='refused');
 await assert.rejects(detectKind(fakeRuntime({}).get),/unrecognised|http-404/);
});
test('Prometheus text: labels, comments, sums over label sets, _total names',()=>{
 const s=parsePrometheus('# HELP x y\nreq_total{model="a",code="200"} 3\nreq_total{model="b"} 4.5\nbad line\ngauge 1e3\nnan_one NaN\n');
 assert.deepEqual(s[0],{name:'req_total',labels:{model:'a',code:'200'},value:3});
 assert.equal(metric(s,'req'),7.5);assert.equal(metric(s,'gauge'),1000);assert.equal(metric(s,'missing','gauge'),1000);assert.equal(metric(s,'missing'),null);
});

// --- the read-only guarantee --------------------------------------------------------------------------
test('no adapter ever requests /upstream/, an unload route, /slots or anything but a GET of an allowlisted path',async()=>{
 // Every adapter and the detection against every fixture, and against a runtime that answers 200 to anything.
 const log=[];
 const anything=async(url,init={})=>{const u=new URL(url);log.push({method:init.method||'GET',path:u.pathname,search:u.search,redirect:init.redirect});return new Response(JSON.stringify({data:[{id:'m',owned_by:'x',status:{value:'ready'}}],models:[{name:'m'}],running:[{model:'m',state:'ready'}]}),{status:200});};
 for(const name of FIXTURES){
  const f=fakeRuntime(fixture(name),{log});
  for(const adapter of Object.values(ADAPTERS))await adapter(f.get,{now:Date.now(),memo:{}}).catch(()=>{});
  await detectKind(f.get).catch(()=>{});
 }
 const any=createReader({base:'http://127.0.0.1:9',fetcher:anything});
 for(const adapter of Object.values(ADAPTERS))await adapter(any,{now:Date.now(),memo:{}}).catch(()=>{});
 await detectKind(any).catch(()=>{});
 assert.ok(log.length>100);
 for(const r of log){
  assert.equal(r.method,'GET',`${r.method} ${r.path}`);
  assert.ok(READ_PATHS.includes(r.path),`not allowlisted: ${r.path}`);
  assert.ok(!/upstream|unload|\/load|slots|completions|embeddings|chat/.test(r.path),r.path);
  assert.equal(r.search,'');assert.equal(r.redirect,'error','redirects are never followed');
 }
 for(const p of READ_PATHS)assert.ok(!/upstream|unload|\/load|slots|completions|chat/.test(p),p);
 // The reader refuses anything else before a request is made.
 const none=[];const get=createReader({base:'http://127.0.0.1:9',fetcher:async u=>{none.push(u);return new Response('{}');}});
 for(const p of ['/upstream/qwen/health','/api/models/unload','/unload','/slots','/v1/chat/completions','/v1/models?x=1','/api/pull'])
  await assert.rejects(get(p),e=>e.code==='path-not-allowed',p);
 assert.deepEqual(none,[]);
 // And the source has no other way out.
 const src=readFileSync(path.join(here,'..','server','runtime-adapters.mjs'),'utf8');
 assert.ok(!/method:\s*'(POST|PUT|DELETE|PATCH)'/.test(src)&&!/\/upstream\//.test(src.replace(/^\s*\/\/.*$/gm,'')),'no write method or upstream route in the adapters');
});
test('reads are bounded, time out, never follow redirects and send the token only as Authorization',async()=>{
 const big=createReader({base:'http://127.0.0.1:9',maxBytes:1024,fetcher:async()=>new Response('x'.repeat(5000))});
 await assert.rejects(big('/v1/models'),e=>e.code==='too-large');
 const slow=createReader({base:'http://127.0.0.1:9',timeoutMs:50,fetcher:(u,init)=>new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(init.signal.reason)))});
 await assert.rejects(slow('/v1/models'),e=>errorCode(e)==='timeout');
 const denied=createReader({base:'http://127.0.0.1:9',fetcher:async()=>new Response('{}',{status:401})});
 await assert.rejects(denied('/v1/models'),e=>e.code==='auth');
 const log=[];const f=fakeRuntime(fixture('openai'),{log});
 await createReader({base:'http://127.0.0.1:9/ignored/path',token:'secret-token-123',fetcher:f.fetcher})('/v1/models');
 assert.equal(log[0].url,'http://127.0.0.1:9/v1/models','only the origin of the base is used');assert.equal(log[0].auth,'Bearer secret-token-123');assert.ok(log[0].hasSignal);
});

// --- endpoints ---------------------------------------------------------------------------------------
test('an endpoint is an origin on loopback or inside the site networks, with no path and no credentials',()=>{
 const lan=['10.0.0.0/24'];
 assert.deepEqual(runtimeEndpoint({machine:'studio',kind:'llama-swap',url:'http://127.0.0.1:8081'},{lanCidrs:lan}),{id:'studio-8081',machine:'studio',kind:'llama-swap',url:'http://127.0.0.1:8081',name:''});
 assert.equal(runtimeEndpoint({machine:'mini',url:'http://10.0.0.25:11434/',name:' Ollama '},{lanCidrs:lan}).url,'http://10.0.0.25:11434');
 assert.equal(runtimeEndpoint({machine:'mini',url:'http://localhost:1234'},{lanCidrs:lan}).kind,'auto');
 assert.equal(runtimeEndpoint({machine:'mini',url:'http://[::1]:1234'},{lanCidrs:lan}).url,'http://[::1]:1234');
 assert.equal(runtimeEndpoint({machine:'mini',url:'http://192.168.1.20:8000'}).url,'http://192.168.1.20:8000','no lanCidrs: a private address is fine');
 const bad=[[{machine:'mini',url:'http://10.0.1.5:8000'},/site networks/],[{machine:'mini',url:'http://8.8.8.8:80'},/private/],
  [{machine:'mini',url:'http://user:pw@127.0.0.1:8000'},/credentials/],[{machine:'mini',url:'http://127.0.0.1:8081/upstream/x'},/origin only/],
  [{machine:'mini',url:'http://127.0.0.1:8081/?a=1'},/origin only/],[{machine:'mini',url:'http://studio.example.lan:8081'},/IP address/],
  [{machine:'mini',url:'ftp://127.0.0.1'},/http/],[{machine:'mini',url:'http://127.0.0.1:1',kind:'magic'},/kind/],[{machine:'Bad!',url:'http://127.0.0.1:1'},/machine/],
  [{machine:'mini',url:'http://127.0.0.1:1',token:'x'},/unknown field/],[{machine:'mini',url:'http://127.0.0.1:1',id:'X'},/id/]];
 for(const [input,why] of bad)assert.throws(()=>runtimeEndpoint(input,{lanCidrs:input.url.includes('8.8.8.8')||input.url.includes('192.168')?[]:lan}),why,JSON.stringify(input));
 // In site.json: the machine must be one of the file's, ids and URLs once.
 const site=validateSite({lanCidrs:lan,machines:[{id:'studio'}],runtimes:[{machine:'studio',kind:'omlx',url:'http://127.0.0.1:8000'}]});
 assert.equal(site.runtimes[0].id,'studio-8000');assert.ok(Object.isFrozen(site.runtimes));
 assert.throws(()=>validateSite({machines:[{id:'studio'}],runtimes:[{machine:'mini',url:'http://127.0.0.1:8000'}]}),/runtimes\[0\]\.machine/);
 assert.throws(()=>validateSite({machines:[{id:'studio'}],runtimes:[{machine:'studio',url:'http://127.0.0.1:8000'},{machine:'studio',id:'other',url:'http://127.0.0.1:8000'}]}),/URL twice/);
 assert.throws(()=>validateSite({machines:[{id:'studio'}],runtimes:[{machine:'studio',url:'http://127.0.0.1:8000/x'}]}),/site config: runtimes\[0\]\.url/);
 assert.deepEqual(validateSite({}).runtimes,[]);
});

// --- the merge with a plugin's report ---------------------------------------------------------------------
test('the same runtime from two providers appears once, with the richer data, gaps filled from the other',()=>{
 const plugin={studio:{source:'plugin compute',observedAt:'2026-11-10T10:00:05Z',runtimes:[
  {id:'llama-swap',name:'llama-swap',kind:'llama.cpp server (GGUF) · oMLX sidecar',status:'running',url:'http://127.0.0.1:8081/ui/',version:'v268',
   models:[{id:'qwen-27b',state:'loaded',sizeGb:46,contextTokens:null,ttlRemainingSeconds:900},{id:'ornith',state:'unloaded',sizeGb:150,contextTokens:null,ttlRemainingSeconds:null}],
   stats:[{label:'požadavky',value:'941'},{label:'rozpočet paměti',value:'46 / 200 GB'}]},
  {id:'comfy',name:'ComfyUI',kind:'',status:'running',url:'http://127.0.0.1:8189/',version:null,models:[],stats:[]}]}};
 const direct={studio:{source:'přímo z runtimu',observedAt:'2026-11-10T10:00:00Z',runtimes:[
  {id:'llama-swap',name:'llama-swap',kind:'llama-swap',source:'přímo z runtimu',status:'running',url:'http://localhost:8081',version:'v268',
   models:[{id:'qwen-27b',state:'loaded',sizeGb:null,contextTokens:262144,ttlRemainingSeconds:1200},{id:'ornith',state:'unloaded',sizeGb:null,contextTokens:262144,ttlRemainingSeconds:null}],
   stats:[{label:'tokeny/s',value:'113.7'},{label:'požadavky',value:'941'}]},
  {id:'omlx',name:'oMLX',kind:'omlx',source:'přímo z runtimu',status:'running',url:'http://127.0.0.1:8000',version:'mlx-lm 0.32',models:[{id:'Qwen3.8-27B-8bit',state:'loaded',sizeGb:28.8,contextTokens:262144,ttlRemainingSeconds:null}],stats:[]}]},
  mini:{source:'přímo z runtimu',observedAt:'2026-11-10T10:00:00Z',runtimes:[{id:'ollama',name:'Ollama',status:'running',url:'http://10.0.0.25:11434',models:[],stats:[]}]}};
 const merged=mergeRuntimeReports([direct,plugin]);
 assert.deepEqual(merged.mini,direct.mini,'a machine one provider reports is passed through');
 const s=merged.studio;
 assert.deepEqual(s.runtimes.map(r=>r.id),['llama-swap','omlx','comfy'],'each runtime once');
 const ls=s.runtimes[0];
 assert.deepEqual(ls.models.find(m=>m.id==='qwen-27b'),{id:'qwen-27b',state:'loaded',sizeGb:46,contextTokens:262144,ttlRemainingSeconds:1200},'the richer entry, sizes filled in');
 assert.deepEqual(ls.stats.map(x=>x.label),['tokeny/s','požadavky','rozpočet paměti']);
 assert.deepEqual(s.sources,['přímo z runtimu','plugin compute']);assert.equal(s.observedAt,'2026-11-10T10:00:00Z');
 // A stale plugin (state unknown) loses to a fresh direct read even when it lists more.
 const stale=structuredClone(plugin);stale.studio.runtimes[0].status='unknown';stale.studio.runtimes[0].models.push({id:'old',state:'unknown'});
 const staleMerge=mergeRuntimeReports([direct,{studio:{...stale.studio,observedAt:'2026-11-10T09:00:00Z',runtimes:stale.studio.runtimes.slice(0,1)}}]).studio,again=staleMerge.runtimes[0];
 assert.equal(staleMerge.observedAt,'2026-11-10T10:00:00Z','a stale plugin that only filled gaps does not date the machine');
 assert.equal(again.status,'running');assert.ok(!again.models.some(m=>m.id==='old'),'nothing stale is added');
 // The same order either way round: who reports first does not decide.
 assert.deepEqual(mergeRuntimeReports([plugin,direct]).studio.runtimes.find(r=>r.id==='llama-swap').models[0].contextTokens,262144);
 assert.equal(runtimesFor(s).sources.length,2);
});

// --- the poller ----------------------------------------------------------------------------------------
test('the poller keeps the last answer per endpoint: ok, then refused (stopped), stale after errors, waiting before the first read',async()=>{
 let now=Date.parse('2026-11-10T10:00:00Z');const f=fixture('ollama');let mode='ok';
 const fetcher=async(url,init)=>mode==='refused'?refused():mode==='broken'?new Response('{}',{status:500}):fakeRuntime(f).fetcher(url,init);
 const endpoints=[{id:'mini-11434',machine:'mini',kind:'auto',url:'http://10.0.0.25:11434',name:''}];
 const tokens={get:async()=>null,ids:async()=>[]};
 const p=createRuntimePoller({endpoints:async()=>endpoints,tokens,fetcher,now:()=>now});
 assert.equal(p.status('mini-11434').state,'waiting');assert.deepEqual(await p.report(),{});
 await p.poll({force:true});
 let st=p.status('mini-11434');assert.equal(st.state,'ok');assert.equal(st.detectedKind,'ollama');
 let r=(await p.report()).mini;assert.equal(r.source,'přímo z runtimu');assert.equal(r.runtimes[0].id,'ollama');assert.equal(r.runtimes[0].status,'running');assert.equal(r.runtimes[0].name,'Ollama');
 mode='refused';now+=30000;await p.poll({force:true});
 st=p.status('mini-11434');assert.equal(st.state,'off');assert.equal(st.lastError,'refused');
 r=(await p.report()).mini.runtimes[0];assert.equal(r.status,'stopped');assert.ok(r.models.every(m=>m.state==='unloaded'),'a stopped runtime holds nothing');assert.deepEqual(r.stats,[]);
 mode='broken';now+=30000;await p.poll({force:true});
 st=p.status('mini-11434');assert.equal(st.state,'stale');assert.equal(st.lastError,'http-500');
 r=(await p.report()).mini.runtimes[0];assert.equal(r.status,'unknown');assert.ok(r.models.every(m=>m.state==='unknown'));
 mode='ok';now+=30000;await p.poll({force:true});assert.equal(p.status('mini-11434').state,'ok');
 now+=200000;assert.equal(p.status('mini-11434').state,'stale','no read for over three minutes');
 // Disabled: nothing is read and nothing provided.
 const off=createRuntimePoller({endpoints:async()=>endpoints,tokens,fetcher:async()=>{throw new Error('must not read');},enabled:async()=>false});
 await off.poll({force:true});assert.deepEqual(await off.report(),{});
});
test('two runtimes of one kind on a machine get distinct ids; a store and the site combine, the site winning a clash',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'hub-rt-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const store=createEndpointStore(path.join(dir,'runtimes-config.json'));
 await store.upsert({id:'studio-8000',machine:'studio',kind:'auto',url:'http://127.0.0.1:9000',name:'',by:'alice',source:'agent'});
 await store.upsert({id:'studio-11435',machine:'studio',kind:'ollama',url:'http://127.0.0.1:11435',name:'',by:'alice',source:'agent'});
 await store.upsert({id:'studio-11434',machine:'studio',kind:'ollama',url:'http://127.0.0.1:11434',name:'',by:'alice',source:'ui'});
 const site={runtimes:[{id:'studio-8000',machine:'studio',kind:'omlx',url:'http://127.0.0.1:8000',name:''}]};
 const all=await allEndpoints(site,store);
 assert.deepEqual(all.map(e=>[e.id,e.source,e.readOnly]),[['studio-8000','site',true],['studio-11435','agent',false],['studio-11434','ui',false]]);
 const p=createRuntimePoller({endpoints:async()=>all.slice(1),tokens:{get:async()=>null,ids:async()=>[]},fetcher:fakeRuntime(fixture('ollama')).fetcher});
 await p.poll({force:true});
 assert.deepEqual((await p.report()).studio.runtimes.map(r=>r.id),['ollama','ollama-11434']);
 assert.equal((await stat(store.file)).mode&0o777,0o600);
});

// --- HTTP, MCP, tokens and the integration --------------------------------------------------------------
test('endpoints over HTTP and MCP: add, list with the last read, machine page, token write-only, remove; site entries read-only',async t=>{
 const log=[];const routes={...fixture('llama-swap'),...fixture('omlx')};
 // One fake host: :8081 answers as llama-swap, :8000 as oMLX, :11434 refuses.
 const fetcher=async(url,init)=>{const u=new URL(url);log.push({port:u.port,path:u.pathname,method:init.method,auth:init.headers?.Authorization||null});
  if(u.port==='11434')return refused();
  const f=u.port==='8081'?fixture('llama-swap'):fixture('omlx');return fakeRuntime(f).fetcher(url,init);};
 const dir=await mkdtemp(path.join(os.tmpdir(),'hub-rt-tok-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const tokensFile=path.join(dir,'private','runtime-tokens.json');
 const h=await hub(t,{runtimeFetch:fetcher,runtimeTokensFile:tokensFile});
 const agent=await h.account('agent-rt',['home:write']),reader=await h.account('reader-rt',[]);
 const rpc=(headers,method,params)=>fetch(h.origin+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',...headers},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
 const call=async(headers,name,args)=>(await (await rpc(headers,'tools/call',{name,arguments:args})).json()).result;
 const parse=r=>JSON.parse(r.content[0].text);

 // MCP: a reader sees the list tool only.
 const names=async k=>(await (await rpc(k.headers,'tools/list')).json()).result.tools.map(x=>x.name);
 assert.ok((await names(reader)).includes('runtime_endpoints_list'));assert.ok(!(await names(reader)).includes('runtime_endpoint_upsert'));
 assert.ok((await names(agent)).includes('runtime_endpoint_upsert'));
 assert.equal(parse(await call(reader.headers,'runtime_endpoints_list',{})).endpoints.length,0);

 // Add through MCP: the answer carries the first read.
 const added=parse(await call(agent.headers,'runtime_endpoint_upsert',{endpoint:{machine:'studio',url:'http://127.0.0.1:8081'}}));
 assert.equal(added.created,true);assert.equal(added.id,'studio-8081');assert.equal(added.endpoint.state,'ok');assert.equal(added.endpoint.detectedKind,'llama-swap');assert.equal(added.endpoint.source,'agent');
 // …and over HTTP.
 const omlx=await h.post('/api/runtimes/endpoints',{endpoint:{id:'studio-omlx',machine:'studio',kind:'omlx',url:'http://127.0.0.1:8000',name:'oMLX'}},agent.headers);
 assert.equal(omlx.status,201);
 assert.equal((await h.post('/api/runtimes/endpoints',{endpoint:{machine:'studio',url:'http://127.0.0.1:11434'}},agent.headers)).status,201);
 // Refusals: a reader, a bad URL, an unknown machine, a URL twice, unknown fields.
 assert.equal((await h.post('/api/runtimes/endpoints',{endpoint:{machine:'studio',url:'http://127.0.0.1:1'}},reader.headers)).status,403);
 const bad=await h.post('/api/runtimes/endpoints',{endpoint:{machine:'studio',url:'http://127.0.0.1:8081/upstream/x'}},agent.headers);
 assert.equal(bad.status,400);assert.equal((await bad.json()).error.code,'RUNTIME_ENDPOINT_INVALID');
 assert.equal((await (await h.post('/api/runtimes/endpoints',{endpoint:{machine:'nope',url:'http://127.0.0.1:1'}},agent.headers)).json()).error.code,'RUNTIME_ENDPOINT_INVALID');
 assert.equal((await (await h.post('/api/runtimes/endpoints',{endpoint:{id:'dup',machine:'studio',url:'http://127.0.0.1:8081'}},agent.headers)).json()).error.code,'RUNTIME_ENDPOINT_CONFLICT');
 assert.match((await call(agent.headers,'runtime_endpoint_upsert',{endpoint:{machine:'studio',url:'http://8.8.8.8:80'}})).content[0].text,/Invalid endpoint.*Nothing was changed/);

 // The list: states, sources, never a token.
 const list=await (await fetch(h.origin+'/api/runtimes/endpoints',{headers:reader.headers})).json();
 assert.deepEqual(list.endpoints.map(e=>[e.id,e.state,e.source]),[['studio-8081','ok','agent'],['studio-omlx','ok','agent'],['studio-11434','off','agent']]);
 assert.ok(list.readPaths.includes('/v1/models')&&!list.readPaths.some(p=>p.includes('upstream')));

 // The machine page: runtimes from the direct reads; the stack blocks follow them (no bridge here).
 const home=await (await fetch(h.origin+'/api/home',{headers:reader.headers})).json();
 const studio=home.machines.find(m=>m.id==='studio');
 assert.deepEqual(studio.runtimes.runtimes.map(r=>[r.id,r.status]),[['llama-swap','running'],['omlx','running'],['runtime','stopped']]);
 assert.equal(studio.runtimes.source,'přímo z runtimu');
 const block=studio.stack.blocks.find(b=>b.id==='omlx');assert.equal(block.state,'on');assert.deepEqual(block.models.filter(m=>m.state==='loaded').map(m=>m.id),['Qwen3.8-27B-8bit']);
 assert.equal(studio.stack.blocks.find(b=>b.id==='lswap').models.length,5);

 // A token: password sign-in only, stored 0600, sent as Authorization, never returned.
 assert.equal((await h.post('/api/runtimes/endpoints/token',{id:'studio-omlx',token:'abcdefgh12345'},agent.headers)).status,403,'never with an API key');
 assert.equal((await h.post('/api/runtimes/endpoints/token',{id:'studio-omlx',token:'short'},h.admin)).status,400);
 const saved=await h.post('/api/runtimes/endpoints/token',{id:'studio-omlx',token:'abcdefgh12345'},h.admin);
 assert.equal(saved.status,200);assert.deepEqual(await saved.json(),{ok:true,id:'studio-omlx',hasToken:true});
 assert.equal((await stat(tokensFile)).mode&0o777,0o600);assert.equal((await stat(path.dirname(tokensFile))).mode&0o777,0o700);
 log.length=0;await h.handler.hub.state('runtimes').poller.poll({force:true});
 assert.ok(log.filter(r=>r.port==='8000').every(r=>r.auth==='Bearer abcdefgh12345'));assert.ok(log.filter(r=>r.port==='8081').every(r=>r.auth===null),'only to its own endpoint');
 const text=JSON.stringify(await (await fetch(h.origin+'/api/runtimes/endpoints',{headers:h.admin})).json())+JSON.stringify(parse(await call(reader.headers,'runtime_endpoints_list',{})));
 assert.ok(!text.includes('abcdefgh12345'));assert.equal(JSON.parse(text.slice(0,text.indexOf('}{')+1)).endpoints.find(e=>e.id==='studio-omlx').hasToken,true);
 // Every request any of this made: a GET on an allowlisted path.
 assert.ok(log.every(r=>r.method==='GET'&&READ_PATHS.includes(r.path)));

 // The integration status, one item per endpoint.
 const integration=h.handler.registry.integrations.find(g=>g.id==='runtimes.endpoints');
 assert.deepEqual({kind:integration.kind,toggle:integration.toggle,title:integration.title},{kind:'llm-runtimes',toggle:true,title:'LLM runtimes'});
 const st=await integration.status(h.handler.hub.state('runtimes'),h.handler.hub);
 assert.equal(st.state,'ok');assert.match(st.summary,/2 z 3 endpointů odpovídá/);assert.ok(st.summaryT);
 assert.deepEqual(st.items.map(i=>[i.id,i.state]),[['studio-8081','ok'],['studio-omlx','ok'],['studio-11434','off']]);
 assert.deepEqual(st.configuredBy,[{source:'agent',name:'agent-rt'}]);
 assert.ok(st.lastSuccessAt&&st.lastError==='studio-11434: refused');
 assert.equal((await integration.test(h.handler.hub.state('runtimes'),h.handler.hub)).items.length,3);
 // Disabled by the integrations page: no reads, nothing on the machine page.
 h.handler.hub.integrationEnabled=async id=>id!=='runtimes.endpoints';
 assert.equal((await integration.status(h.handler.hub.state('runtimes'),h.handler.hub)).state,'disabled');
 const quiet=await (await fetch(h.origin+'/api/home',{headers:reader.headers})).json();assert.equal(quiet.machines.find(m=>m.id==='studio').runtimes,null);
 delete h.handler.hub.integrationEnabled;

 // Remove: the endpoint and its token go.
 assert.equal((await h.post('/api/runtimes/endpoints/remove',{id:'studio-omlx'},agent.headers)).status,200);
 assert.deepEqual(JSON.parse(await readFile(tokensFile,'utf8')).tokens,{});
 assert.equal((await call(agent.headers,'runtime_endpoint_remove',{id:'studio-omlx'})).isError,true);
 assert.equal(parse(await call(agent.headers,'runtime_endpoint_remove',{id:'studio-11434'})).removed,true);
 assert.deepEqual(parse(await call(reader.headers,'runtime_endpoints_list',{})).endpoints.map(e=>e.id),['studio-8081']);
});
test('endpoints from the site configuration are read-only through the API; none configured is "not-configured"',async t=>{
 const site=validateSite({lanCidrs:['10.0.0.0/24'],machines:[{id:'studio'}],runtimes:[{id:'studio-ollama',machine:'studio',kind:'ollama',url:'http://127.0.0.1:11434'}]});
 const h=await hub(t,{site,runtimeFetch:fakeRuntime(fixture('ollama')).fetcher});
 const agent=await h.account('agent-ro',['home:write']);
 const r=await h.post('/api/runtimes/endpoints',{endpoint:{id:'studio-ollama',machine:'studio',url:'http://127.0.0.1:11500'}},agent.headers);
 assert.equal(r.status,403);assert.equal((await r.json()).error.code,'RUNTIME_ENDPOINT_READ_ONLY');
 assert.equal((await h.post('/api/runtimes/endpoints/remove',{id:'studio-ollama'},agent.headers)).status,403);
 const integration=h.handler.registry.integrations.find(g=>g.id==='runtimes.endpoints');
 await h.handler.hub.state('runtimes').poller.poll({force:true});
 const st=await integration.status(h.handler.hub.state('runtimes'),h.handler.hub);
 assert.equal(st.state,'ok');assert.deepEqual(st.configuredBy,[{source:'site',name:'site.json'}]);
 const empty=await hub(t);
 assert.equal((await integration.status(empty.handler.hub.state('runtimes'),empty.handler.hub)).state,'not-configured');
});
test('a machine page without a bridge: a direct runtime fills the stack block that names it; an unknown one leaves it alone',()=>{
 const thermo={status:()=>({}),seconds:()=>[],minutes:()=>[],live:()=>({}),disks:()=>({}),interval:()=>({intervalSeconds:30,lastPollAt:null}),hosts:()=>[]};
 const runtimes={studio:{source:'přímo z runtimu',observedAt:new Date().toISOString(),runtimes:[
  {id:'mlx-serve',name:'mlx-serve',kind:'mlx-serve',status:'running',url:'http://127.0.0.1:11234',version:'26.10.3',models:[{id:'pack',state:'loaded',sizeGb:9.2,contextTokens:null,ttlRemainingSeconds:null}],stats:[]},
  {id:'omlx',name:'oMLX',kind:'omlx',status:'unknown',url:'http://127.0.0.1:8000',version:null,models:[{id:'m',state:'unknown'}],stats:[]}]}};
 const home=buildHome({site:SITE,thermo,runtimes});
 const blocks=home.machines.find(m=>m.id==='studio').stack.blocks;
 const mx=blocks.find(b=>b.id==='mlxserve');assert.equal(mx.state,'on');assert.deepEqual(mx.models,[{id:'pack',state:'loaded',sizeGb:9.2,path:null,ttlSeconds:null,ttlRemainingSeconds:null}]);
 assert.equal(blocks.find(b=>b.id==='omlx').state,'off','the site stack without a live service, as before');
});
test('a collected stack marks the blocks of its ENGINE layer as engines (not a server in it, not the hardware)',async()=>{
 const {machineFromDescriptor}=await import('../server/home-data.mjs');
 const d={schemaVersion:1,id:'studio',stack:{layers:['INPUT','RUNTIME','ENGINE','HARDWARE'],cols:['mlx'],blocks:[
  {id:'omlx',layer:1,col0:0,col1:0,title:'oMLX',service:'omlx'},{id:'em',layer:2,col0:0,col1:0,title:'Apple MLX'},{id:'odd',layer:2,col0:0,col1:0,title:'x',service:'y'},{id:'hw',layer:3,col0:0,col1:0,title:'M5'}]}};
 const blocks=machineFromDescriptor(d,SITE).stack.blocks;
 assert.deepEqual(blocks.map(b=>[b.id,Boolean(b.engine),Boolean(b.hw)]),[['omlx',false,false],['em',true,false],['odd',false,false],['hw',false,true]]);
});
