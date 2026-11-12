// LLM & Diffusion (#models): kind inference, placements across machines, the wiring graph (clients → front door →
// engine → model, cross-machine edges, weights from traffic), history buckets, the empty state, the API and the
// MCP tool. Everything runs on providers given to the hub as plugins; core itself reads no runtime.
import test from 'node:test';
import assert from 'node:assert/strict';
import {inferKind,requestKind,modelKey,liveState,placements,overview,modelGroups,clientsOf,buildGraph,knownTools,history,buckets,cleanRequest,clientMachineOf,metricsToRequests,metricKey,workOf,UNATTRIBUTED} from '../server/models-data.mjs';
import {modelsQuery,toolView} from '../server/core/models.mjs';
import {hub} from './hub-helper.mjs';

const now=Date.parse('2026-11-10T12:00:00Z'),iso=ms=>new Date(ms).toISOString();
const MACHINES=[{id:'mini',name:'Mac mini',ip:'10.0.0.25',ramGb:64},{id:'studio',name:'Mac Studio',ip:'10.0.0.151',ramGb:256}];
// Two machines: a gateway in front of an MLX engine and a media engine on the studio; a lone engine on the mini.
const runtimes=()=>({
 studio:{source:'test',observedAt:iso(now-10000),runtimes:[
  {id:'llama-swap',name:'llama-swap',kind:'llama.cpp · sidecar',status:'running',role:'gateway',memory:{usedGb:46,capacityGb:200,basis:'budget'},models:[
   {id:'qwen-27b',state:'loaded',sizeGb:46,via:'omlx',target:'Qwen3.8-27B-8bit',ttlRemainingSeconds:540,lastRequestAt:iso(now-30000)},
   {id:'krea-image',state:'unloaded',via:'mlx-serve',target:'org/Krea-2-Turbo'},
   {id:'gemma-gguf',state:'unloaded',via:'llama.cpp',contextTokens:8192}]},
  {id:'omlx',name:'oMLX',kind:'MLX',status:'running',memory:{usedGb:27.5,capacityGb:190},models:[
   {id:'Qwen3.8-27B-8bit',state:'loaded',sizeGb:27.5,contextTokens:262144,engine:'vlm'},
   {id:'mlx-community--chatterbox-multilingual-v3',state:'unloaded',engine:'audio_tts'},
   {id:'Qwen3-Embedding-0.6B',state:'unloaded'}]},
  {id:'mlx-serve',name:'mlx-serve',status:'stopped',models:[{id:'org/Krea-2-Turbo',state:'unloaded',capabilities:['image']},{id:'org/Magenta-RT',state:'unloaded',capabilities:['audio','music']}]}]},
 mini:{source:'test',observedAt:iso(now-5000),runtimes:[{id:'omlx',name:'oMLX',status:'running',models:[{id:'Qwen3.8-27B-8bit',state:'unloaded',sizeGb:27}]}]},
});
const live=()=>liveState(runtimes(),MACHINES);
const req=(over={})=>cleanRequest({machine:'studio',runtime:'llama-swap',model:'qwen-27b',at:now-60000,path:'/v1/chat/completions',inputTokens:1000,outputTokens:200,generationTps:100,client:'Claude Code',...over});

test('kind: capabilities first, then engine family and name; requests by path',()=>{
 assert.equal(inferKind({id:'x',capabilities:['image']}),'image');
 assert.equal(inferKind({id:'org/Magenta-RT',capabilities:['audio','music']}),'music','music wins over audio');
 assert.equal(inferKind({id:'Qwen3-Embedding-0.6B'}),'embedding','an embedding model named after an LLM family');
 assert.equal(inferKind({id:'mlx-community--chatterbox-multilingual-v3',engine:'audio_tts'}),'audio','"chat" in a TTS name is still audio');
 assert.equal(inferKind({id:'ltx-2.5-video'}),'video');assert.equal(inferKind({id:'FLUX.2-dev'}),'image');assert.equal(inferKind({id:'stable-audio-sfx'}),'audio');
 assert.equal(inferKind({id:'Qwen3.8-27B-8bit',engine:'vlm'}),'llm');
 assert.equal(inferKind({id:'mystery-7'},{id:'ollama'}),'llm','a language-model runtime makes an unnamed model an LLM');
 assert.equal(inferKind({id:'mystery-7'},{id:'tool'}),'other');assert.equal(inferKind({id:'x',kind:'music'}),'music','an explicit kind is kept');
 assert.deepEqual(['/v1/chat/completions','/v1/messages','/v1/embeddings','/v1/images/generations','/v1/audio/speech','/health','responses'].map(requestKind),['chat','chat','embeddings','images','audio','other','chat']);
 assert.equal(modelKey('mlx-community--Qwen3-8B'),'qwen3-8b');assert.equal(modelKey('org/Model.gguf'),'model');
});

test('placements: a gateway alias folds into its engine model; one model on two machines is one group',()=>{
 const list=placements(live());
 const qwen=list.filter(p=>p.id==='Qwen3.8-27B-8bit');
 assert.deepEqual(qwen.map(p=>[p.machine,p.runtime,p.state]),[['studio','omlx','loaded'],['mini','omlx','unloaded']].sort((a,b)=>MACHINES.findIndex(m=>m.id===a[0])-MACHINES.findIndex(m=>m.id===b[0])));
 const studio=qwen.find(p=>p.machine==='studio');
 assert.deepEqual([studio.gateways,studio.aliases,studio.ttlRemainingSeconds,studio.lastRequestAt],[['llama-swap'],['qwen-27b'],540,iso(now-30000)],'TTL and last request come from the gateway entry');
 assert.ok(!list.some(p=>p.id==='qwen-27b'),'the alias is not a model of its own');
 const gguf=list.find(p=>p.id==='gemma-gguf');assert.deepEqual([gguf.runtime,gguf.engine,gguf.viaRuntime],['llama-swap','llama.cpp',null],'an engine inside the gateway');
 const groups=modelGroups(list,[req()]);
 const g=groups.find(x=>x.key==='qwen3.8-27b-8bit');
 assert.deepEqual([g.kind,g.state,g.machines.sort(),g.placements.length,g.requests],['llm','loaded',['mini','studio'],2,1]);
 assert.equal(groups[0].state,'loaded','loaded models first');
 assert.equal(groups.find(x=>x.name==='org/Magenta-RT').kind,'music');
});

test('overview: machines, runtimes up/down, loaded vs available, memory against RAM and pools, tokens and median tok/s',()=>{
 const l=live(),list=placements(l),requests=[req(),req({generationTps:50,at:now-120000}),req({outputTokens:2,generationTps:999})];
 const o=overview(l,list,requests,{now});
 assert.deepEqual([o.machines,o.runtimes.total,o.runtimes.up,o.runtimes.down],[2,4,3,1]);
 assert.deepEqual([o.models.total,o.models.loaded],[list.length,1]);
 const studio=o.memory.find(m=>m.machine==='studio');
 assert.equal(studio.ramGb,256);assert.equal(studio.residentGb,27.5,'resident = what engines hold; a budget is not residency');
 assert.deepEqual(studio.pools.map(p=>[p.runtime,p.basis]),[['llama-swap','budget'],['omlx','resident']]);
 assert.deepEqual([o.requests,o.inputTokens,o.outputTokens,o.medianTps],[3,3000,402,75],'tiny outputs do not count for tok/s');
});

test('graph: client → front door → engine → model, a cross-machine edge, weights and recent traffic from requests',()=>{
 const l=live(),list=placements(l);
 const requests=[req({client:'Codex',clientMachine:'mini'}),req({client:'Codex',clientMachine:'mini',at:now-3600000}),req({client:'',clientAddress:'ip:127.0.0.1'}),
  req({runtime:'omlx',model:'Qwen3.8-27B-8bit',client:'script',clientAddress:'10.0.0.151'}),req({model:'retired-model',client:'OB1'})];
 const g=buildGraph(l,list,requests,{machines:MACHINES,now});
 const id=(col,label)=>g.nodes.find(n=>n.column===col&&n.label===label)?.id;
 const edge=(a,b)=>g.edges.find(e=>e.from===a&&e.to===b);
 const codex=g.nodes.find(n=>n.column==='client'&&n.label==='Codex');assert.equal(codex.lane,'mini');
 const door=id('door','llama-swap'),omlx='rt:studio:omlx',model='md:studio:omlx:Qwen3.8-27B-8bit';
 const cx=edge(codex.id,door);assert.deepEqual([cx.requests,cx.recent,cx.cross],[2,1,true],'a client on the mini using the studio\'s llama-swap');
 assert.equal(edge(door,omlx).requests,3);assert.equal(edge(omlx,model).requests,4,'the direct oMLX call joins at the engine');
 const script=g.nodes.find(n=>n.label==='script');assert.equal(script.lane,'studio','a LAN address names its machine');assert.equal(edge(script.id,omlx).requests,1);
 const anon=g.nodes.find(n=>n.label===UNATTRIBUTED);assert.deepEqual([anon.lane,anon.sub],['unknown','loopback'],'loopback names no machine');
 assert.equal(edge(door,'en:studio:llama.cpp')?.requests,0,'an idle path is still drawn');
 const gone=g.nodes.find(n=>n.label==='retired-model');assert.ok(gone.history,'a model seen only in history gets a node');
 assert.equal(g.maxRequests,4);assert.equal(g.crossRequests,2);
 assert.ok(g.edges.every(e=>g.nodes.some(n=>n.id===e.from)&&g.nodes.some(n=>n.id===e.to)),'every edge has both ends');
 assert.ok(g.lanes.some(l=>l.id==='unknown'));
 // No traffic: the structure stays, no client column, nothing moves.
 const idle=buildGraph(l,list,[],{machines:MACHINES,now});
 assert.equal(idle.nodes.filter(n=>n.column==='client').length,0);assert.equal(idle.maxRecent,0);assert.ok(idle.edges.length>0);
});

test('clients: attribution only where the data has it; known tools from the stack',()=>{
 const l=live(),list=placements(l);
 const c=clientsOf([req({client:'Codex',clientMachine:'mini'}),req({client:''}),req({client:'Codex',clientMachine:'mini',model:'krea-image',path:'/v1/images/generations'})],list,MACHINES,{now});
 assert.deepEqual(c.map(x=>[x.client,x.clientMachine,x.requests,x.cross]),[['Codex','mini',2,true],[UNATTRIBUTED,null,1,false]]);
 assert.deepEqual(c[0].targets[0].models.map(m=>m.model).sort(),['Qwen3.8-27B-8bit','org/Krea-2-Turbo']);
 assert.deepEqual(clientMachineOf({clientAddress:'10.0.0.99'},MACHINES),{machine:null,via:'address'});
 const stacks=[{machine:'studio',name:'Mac Studio',source:'site',stack:{layers:['INPUT','RUNTIME','HARDWARE'],blocks:[
  {title:'OpenCode / Claude',layer:0},{title:'llama-swap',layer:1,service:'llama-swap'},{title:'mflux',layer:1,state:'off',models:[{id:'FLUX.2 dev'}]},{title:'ComfyUI (Desktop)',layer:1},{title:'Notes app',layer:1},{title:'M5',layer:2,hw:true}]}}];
 const k=knownTools(stacks,l);
 assert.deepEqual(k.map(x=>[x.role,x.title,x.kind,x.state]),[['client','OpenCode / Claude',null,'on'],['runtime','mflux','image','off'],['runtime','ComfyUI (Desktop)','image','on']],'live runtimes and non-AI tools are left out');
 const g=buildGraph(l,list,[],{machines:MACHINES,known:k,now});
 assert.ok(g.nodes.find(n=>n.label==='mflux').known);assert.equal(g.nodes.find(n=>n.label==='OpenCode / Claude').column,'client');
});

test('history: buckets on the site clock, series by model, machine, client and kind',()=>{
 const b=buckets('24h',now,'Europe/Berlin');assert.equal(b.starts.length,24);assert.ok(b.to>now&&b.to-now<=3600000);
 const d=buckets('30d',now,'Europe/Berlin');assert.equal(new Date(d.to).getUTCHours(),23,'days end at local midnight (UTC+1)');
 assert.throws(()=>buckets('1y',now),/invalid/);
 const list=placements(live());
 const h=history([req(),req({at:now-7200000,client:''}),req({model:'krea-image',path:'/v1/images/generations',outputTokens:0}),req({at:now-40*86400000})],list,{range:'24h',now,timeZone:'Europe/Berlin'});
 assert.equal(h.totals.requests,3,'outside the range is left out');assert.equal(h.requests.reduce((a,v)=>a+v,0),3);
 assert.deepEqual(h.series.kind.keys.sort(),['chat','images']);assert.ok(h.series.client.keys.includes(UNATTRIBUTED));
 assert.equal(h.series.model.values['Qwen3.8-27B-8bit'].reduce((a,v)=>a+v,0),2,'aliases count for their model');
 assert.equal(h.top.model[0].key,'Qwen3.8-27B-8bit');assert.equal(h.totals.medianTps,100);
});

test('llama-swap metrics: the activity log becomes request records, keyed for de-duplication',()=>{
 const items=[{id:917,timestamp:'2026-11-08T20:35:23+01:00',src:'ip:127.0.0.1',model:'qwen-flash-next',req_path:'/v1/chat/completions',resp_status_code:200,tokens:{cache_tokens:66735,input_tokens:67118,output_tokens:445,prompt_per_second:498.79,tokens_per_second:119.29},duration_ms:4603},{id:918}];
 const [r,...rest]=metricsToRequests(items,{machine:'studio'});
 assert.equal(rest.length,0,'a record without a time is dropped');
 assert.deepEqual([r.runtime,r.kind,r.inputTokens,r.outputTokens,r.generationTps,r.clientAddress,r.client,r.metricId],['llama-swap','chat',67118,445,119.29,'127.0.0.1',UNATTRIBUTED,917]);
 assert.equal(metricKey(r),metricKey(metricsToRequests(items,{machine:'studio'})[0]));
});

test('API and MCP: empty without providers, the page data with them, read scope, bad ranges refused',async t=>{
 assert.deepEqual(modelsQuery({}),{range:'24h'});assert.throws(()=>modelsQuery({range:'1y'}),/invalid/);assert.throws(()=>modelsQuery({host:'x'}),/invalid/);
 const empty=await hub(t,{plugins:[]});
 const e=await (await fetch(empty.origin+'/api/models',{headers:empty.admin})).json();
 assert.equal(e.empty,true);assert.deepEqual([e.models,e.clients,e.graph.nodes],[[],[],[]]);assert.equal(e.provenance.kind,'config');assert.ok(e.known.some(k=>k.title==='llama-server'&&k.state==='off'),'the stack still names its tools: known, no live stats');
 assert.equal((await fetch(empty.origin+'/api/models')).status,401);
 assert.equal((await fetch(empty.origin+'/api/models?range=1y',{headers:empty.admin})).status,400);
 const hh=await (await fetch(empty.origin+'/api/models/history?range=7d',{headers:empty.admin})).json();
 assert.deepEqual([hh.available,hh.buckets.length,hh.totals.requests],[false,28,0]);
 const records=[{machine:'studio',runtime:'llama-swap',model:'qwen-27b',at:iso(Date.now()-60000),path:'/v1/chat/completions',inputTokens:10,outputTokens:20,generationTps:80,client:'Codex',clientMachine:'mini'}];
 const plugin={id:'fake-runtimes',provides:{'home.runtimes':()=>runtimes(),'runtimes.requests':()=>({id:'fake',read:async({from,to})=>records.filter(r=>Date.parse(r.at)>=from&&Date.parse(r.at)<=to)})}};
 const h=await hub(t,{plugins:[plugin]});
 const d=await (await fetch(h.origin+'/api/models',{headers:h.admin})).json();
 assert.equal(d.empty,false);assert.equal(d.overview.requests,1);assert.ok(d.models.length>3);
 assert.deepEqual(d.clients.map(c=>[c.client,c.clientMachine]),[['Codex','mini']]);
 assert.ok(d.graph.edges.some(e=>e.cross));assert.deepEqual(d.provenance.kinds.map(s=>s.kind),['plugin','plugin','config']);
 const reader=await h.account('reader',[]);
 const rpc=(name,args)=>fetch(h.origin+'/mcp',{method:'POST',headers:{...reader.headers,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})}).then(r=>r.json());
 const out=await rpc('models_overview',{});const view=JSON.parse(out.result.content[0].text);
 assert.equal(view.overview.requests,1);assert.ok(!('graph' in view));assert.ok(view.models.every(m=>Array.isArray(m.placements)));
 assert.ok(JSON.parse((await rpc('models_overview',{graph:true})).result.content[0].text).graph.nodes.length);
 assert.equal((await rpc('models_overview',{range:'1y'})).result.isError,true);
 assert.deepEqual(Object.keys(toolView(d)).sort(),['clients','empty','generatedAt','known','models','overview','providers','range','work']);
});

// What generates now. Two providers report the Studio: the hub's own direct reads (which know how busy each
// runtime is) and a plugin's bridge (which knows the wiring). The page joins them as the machine page does.
test('what generates now: two providers joined per runtime; a gateway request counted once; table, overview, graph and MCP agree',async t=>{
 const direct={studio:{source:'přímo z runtimu',observedAt:new Date().toISOString(),runtimes:[
  {id:'llama-swap',name:'llama-swap',status:'running',url:'http://127.0.0.1:8081',activity:{active:1,queued:0},models:[{id:'qwen-27b',state:'loaded',active:1,queued:0,since:'2026-11-12T00:20:00Z'},{id:'krea-image',state:'unloaded',active:0,queued:0}]},
  {id:'omlx',name:'oMLX',status:'running',url:'http://127.0.0.1:8000',activity:{active:1,queued:1},models:[{id:'Qwen3.8-27B-8bit',state:'loaded',active:1,queued:1,since:'2026-11-12T00:20:02Z'}]},
  {id:'mlx-serve',name:'mlx-serve',status:'running',url:'http://127.0.0.1:11234',models:[{id:'org/Krea-2-Turbo',state:'unloaded'},{id:'org/Magenta-RT',state:'unloaded'}]}]}};
 const bridge={studio:{source:'plugin compute',observedAt:new Date().toISOString(),runtimes:[
  {id:'llama-swap',name:'llama-swap',status:'running',url:'http://127.0.0.1:8081/ui/',role:'gateway',memory:{usedGb:46,capacityGb:200,basis:'budget'},models:[
   {id:'qwen-27b',state:'loaded',sizeGb:46,via:'omlx',target:'Qwen3.8-27B-8bit',ttlSeconds:1800},{id:'krea-image',state:'unloaded',via:'mlx-serve',target:'org/Krea-2-Turbo'}]},
  {id:'omlx',name:'oMLX',status:'running',url:'http://127.0.0.1:8000/',role:'engine',models:[{id:'Qwen3.8-27B-8bit',state:'loaded',sizeGb:27.5,engine:'vlm'}]},
  {id:'mlx-serve',name:'mlx-serve',status:'running',url:'http://127.0.0.1:11234/',role:'engine',models:[{id:'org/Krea-2-Turbo',state:'unloaded',capabilities:['image']}]},
  {id:'mflux',name:'mflux',mode:'cli',status:'running',role:'engine',activity:{active:1,queued:1},models:[{id:'seedvr2-3b',name:'seedvr2-3b · upscale-seedvr2',kind:'image',state:'loaded',active:1,queued:0,since:'2026-11-12T00:19:00Z'},{id:'seedvr2-7b',kind:'image',state:'unloaded',active:0,queued:1}]}]}};
 const h=await hub(t,{plugins:[{id:'direct-like',provides:{'home.runtimes':()=>direct}},{id:'bridge-like',provides:{'home.runtimes':()=>bridge}}]});
 const d=await (await fetch(h.origin+'/api/models',{headers:h.admin})).json();
 assert.deepEqual(d.work.items.map(x=>[x.id,x.runtime,x.kind,x.active,x.queued,x.gateways]),[
  ['seedvr2-3b','mflux','image',1,0,[]],['Qwen3.8-27B-8bit','omlx','llm',1,1,['llama-swap']],['seedvr2-7b','mflux','image',0,1,[]]],'the wiring of one provider and the counts of the other, joined');
 assert.deepEqual([d.work.active,d.work.queued],[2,2]);
 assert.deepEqual(d.work.blind.map(r=>r.id),['mlx-serve']);
 assert.deepEqual([d.overview.models.generating,d.overview.models.queued],[2,2]);
 const qwen=d.models.find(g=>g.key==='qwen3.8-27b-8bit');assert.deepEqual([qwen.active,qwen.queued,qwen.since],[1,1,'2026-11-12T00:20:00.000Z']);
 assert.equal(d.models[0].active>0,true,'busy models first');
 assert.equal(d.models.find(g=>g.name==='org/Krea-2-Turbo').active,0,'idle as far as its gateway can tell');
 assert.equal(d.models.find(g=>g.name==='org/Magenta-RT').active,null,'only on a runtime that does not say: unknown, not idle');
 const node=d.graph.nodes.find(n=>n.model==='seedvr2-3b');assert.deepEqual([node.active,node.queued],[1,0]);
 assert.equal(d.graph.nodes.find(n=>n.id==='rt:studio:mflux').active,1);
 assert.ok(!d.known.some(k=>/mflux/i.test(k.title)),'a reported tool is no longer "known, no live stats"');
 const view=toolView(d);assert.deepEqual(view.work,d.work);assert.equal(view.models.find(m=>m.name==='seedvr2-3b').active,1);
 // A stale runtime (status unknown) says nothing about now, even if its provider sent counts.
 const stale=liveState({studio:{runtimes:[{id:'omlx',status:'unknown',activity:{active:2,queued:0},models:[{id:'m',state:'unknown',active:2,since:'2026-11-12T00:00:00Z'}]}]}},MACHINES);
 assert.deepEqual([stale[0].runtimes[0].activity,stale[0].runtimes[0].models[0].active],[null,null]);
 // workOf on its own: nothing reported → nothing busy, everything blind.
 const quiet=workOf(live(),placements(live()));
 assert.deepEqual([quiet.items,quiet.active,quiet.queued,quiet.watching],[[],0,0,[]]);assert.ok(quiet.blind.some(r=>r.id==='omlx'));
});
