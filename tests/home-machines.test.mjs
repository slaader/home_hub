// Machines beyond the site configuration: the store (UI devices, agent machines, published runtime stacks),
// the machine API with its home:write scope, the MCP tools, telemetry states and the home.runtimes extension point.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHomeDevices,parseRuntime,machineHash,secretIn,PICTURES,DEVICE_LIMITS} from '../server/home-devices.mjs';
import {buildHome as build,telemetryFor,runtimesFor,machineList,homeHistoryQuery} from '../server/home-data.mjs';
import {TELEMETRY_REPO_URL,TELEMETRY_STALE_SECONDS} from '../server/thermo-client.mjs';
import {legacyScopes,SCOPES} from '../server/scopes.mjs';
import {EMPTY_SITE} from '../server/site-config.mjs';
import {hub,SITE} from './hub-helper.mjs';

const SITE_IDS=SITE.machines.map(m=>m.id),LAN=[...SITE.lanCidrs];
const quiet={status:()=>({}),seconds:()=>[],minutes:()=>[],live:()=>({}),disks:()=>({}),interval:()=>({intervalSeconds:15,lastPollAt:null}),addHost(){},removeHost(){},start:async()=>{},hosts:()=>[]};
const buildHome=input=>build({site:SITE,thermo:quiet,...input});
async function store(t,options={reserved:SITE_IDS,lanCidrs:LAN}){const dir=await mkdtemp(path.join(os.tmpdir(),'home-machines-'));t.after(()=>rm(dir,{recursive:true,force:true}));return {dir,d:createHomeDevices(dir,options)};}
const pi={id:'pi-hole',name:'Pi-hole',hostname:'pi.example.lan',ip:'10.0.0.53',role:'other',hardware:{cpu:'4c Cortex-A76',gpu:'',ramGb:8},picture:'board'};
const STACK={cols:['gguf','mlx'],engines:{gguf:'llama.cpp',mlx:'Apple MLX'},blocks:[
 {id:'api',layer:'input',col0:0,col1:1,title:'OpenAI-compatible API',port:':8080',desc:'What clients call.'},
 {id:'swap',layer:'tool',col0:0,col1:0,title:'llama-swap',port:':8081',service:'llama-swap'},
 {id:'llama',layer:'runtime',col0:0,col1:0,title:'llama-server',state:'off',models:[{id:'gemma-3-27b-it-Q4_K_M',state:'idle',sizeGb:16.5,path:'~/models/gemma-3-27b-it-Q4_K_M.gguf'}]},
 {id:'hw',layer:'hardware',col0:0,col1:1,title:'M4 Pro',port:'64 GB'}]};
const rejects=(promiseOrFn,code,detail)=>{const check=e=>{assert.equal(e.message,code);if(detail)assert.match(e.detail||'',detail);return true;};
 return typeof promiseOrFn==='function'?assert.throws(promiseOrFn,check):assert.rejects(promiseOrFn,check);};

test('machine store: create, idempotent repeat, hash-checked replace, refusals',async t=>{
 const {d}=await store(t);
 const made=await d.upsert(pi,{by:'agent-a',source:'agent'});
 assert.equal(made.created,true);assert.equal(made.changed,true);assert.match(made.hash,/^[a-f0-9]{64}$/);
 assert.deepEqual([made.device.source,made.device.createdBy,made.device.kind,made.device.thermoId,made.device.picture],['agent','agent-a','other',null,'board']);
 // The same fields again, without a base: nothing to do, the same hash.
 const again=await d.upsert(pi,{by:'agent-a',source:'agent'});assert.deepEqual([again.created,again.changed,again.hash],[false,false,made.hash]);
 // Different fields need the hash that was read; a stale or missing one is a conflict and nothing changes.
 await rejects(d.upsert({...pi,name:'Pi-hole 2'}),'conflict');
 await rejects(d.upsert({...pi,name:'Pi-hole 2'},{base:'0'.repeat(64)}),'conflict');
 await rejects(d.upsert({...pi,id:'new-one',hostname:'new.example.lan'},{base:made.hash}),'conflict');// a base for a machine that does not exist
 const changed=await d.upsert({...pi,name:'Pi-hole 2',thermoId:'pi-hole'},{by:'admin',base:made.hash});
 assert.equal(changed.changed,true);assert.notEqual(changed.hash,made.hash);
 assert.deepEqual([changed.device.name,changed.device.kind,changed.device.source,changed.device.createdBy,changed.device.updatedBy],['Pi-hole 2','thermo','agent','agent-a','admin'],'provenance survives a replace');
 assert.equal(machineHash((await d.list())[0]),changed.hash);
 // Refusals: a site machine, a second machine on the same hostname, an address outside the site's networks, bad fields, secrets.
 rejects(()=>d.upsert({id:'studio',name:'Not mine'}),'read-only');
 await rejects(d.upsert({id:'other-pi',name:'Other',hostname:'PI.example.lan'}),'duplicate');
 rejects(()=>d.upsert({...pi,id:'far',hostname:'far.example.lan',ip:'192.168.1.5'}),'invalid',/10\.0\.0\.0\/24/);
 rejects(()=>d.upsert({...pi,id:'net',ip:'10.0.0.0'}),'invalid',/host address/);
 for(const [bad,detail] of [[{id:'X',name:'x'},/machine\.id/],[{id:'ok',name:''},/machine\.name/],[{id:'ok',name:'x',role:'toaster'},/machine\.role/],[{id:'ok',name:'x',picture:'/images/x.png'},/machine\.picture/],
  [{id:'ok',name:'x',hardware:{ramGb:-1}},/ramGb/],[{id:'ok',name:'x',thermoId:'Bad Id'},/thermoId/],[{id:'ok',name:'x',hostname:'bad host'},/hostname/],[{id:'ok',name:'x',password:'p'},/unknown field/],[{id:'ok',name:'x',hardware:{serial:'1'}},/unknown field/]])
  rejects(()=>d.upsert(bad),'invalid',detail);
 rejects(()=>d.upsert({id:'leaky',name:'x',hardware:{cpu:'token=abcdef123456'}}),'secret',/hardware\.cpu/);
 rejects(()=>d.upsert({id:'leaky',name:'pwd=hunter2hunter2'}),'secret',/machine\.name/);
 assert.equal(secretIn('M4 Pro · 14c'),null);assert.equal(secretIn('~/models/gemma-3-27b-it-Q4_K_M.gguf'),null);
 assert.equal((await d.list()).length,1,'nothing refused was stored');
 // Without networks in the site configuration any well-formed address is accepted.
 const open=await store(t,{reserved:[]});assert.equal((await open.d.upsert({id:'far',name:'Far',ip:'192.168.1.5'})).device.ip,'192.168.1.5');
 // Removal checks the hash too, and takes the published stack along.
 await d.publishRuntime('pi-hole',STACK,{by:'agent-a'});
 await rejects(d.remove('pi-hole',{base:made.hash}),'conflict');await rejects(d.remove('studio'),'read-only');await rejects(d.remove('nope'),'not-found');
 assert.equal((await d.remove('pi-hole',{base:changed.hash})).device.id,'pi-hole');
 assert.deepEqual(await d.list(),[]);assert.deepEqual(await d.stacks(),{});
});

test('machine store: at most 20 added machines',async t=>{
 const {d}=await store(t,{reserved:[]});
 for(let i=0;i<DEVICE_LIMITS.devices;i++)await d.upsert({id:`box-${i}`,name:`Box ${i}`});
 await rejects(d.upsert({id:'one-more',name:'One more'}),'limit');
 assert.equal((await d.upsert({id:'box-3',name:'Box 3'})).changed,false,'an existing machine can still be repeated');
});

test('devices.json written before roles, pictures and agents existed loads unchanged and shows the same tile',async t=>{
 const {dir,d}=await store(t);
 // The exact shape the first version of the store wrote (home-devices.mjs before machine_upsert).
 const old={schema:1,devices:[
  {id:'mac-studio-2',name:'Mac Studio 2',kind:'thermo',hostname:'studio2.example.lan',ip:'10.0.0.30',props:{cpu:'M4 Max',gpu:'40c',ramGb:128},image:true,imageAt:'2026-11-08T10:00:00.000Z',createdAt:'2026-11-08T09:59:00.000Z',createdBy:'admin'},
  {id:'printer',name:'Printer',kind:'other',hostname:'10.0.0.40',ip:null,props:{cpu:'',gpu:'',ramGb:null},image:false,createdAt:'2026-11-08T10:05:00.000Z',createdBy:'admin'}]};
 const text=JSON.stringify(old,null,1)+'\n';await writeFile(path.join(dir,'devices.json'),text,{mode:0o600});
 const list=await d.list();
 assert.deepEqual(list.map(x=>[x.id,x.role,x.thermoId,x.picture,x.source,x.kind]),[['mac-studio-2','computer','mac-studio-2',null,'ui','thermo'],['printer','other',null,null,'ui','other']]);
 assert.equal(await readFile(path.join(dir,'devices.json'),'utf8'),text,'reading migrates nothing on disk');
 // The tile keeps every field it had, with the values it had.
 const tiles=buildHome({added:list}).machines.filter(m=>m.added);
 assert.deepEqual(tiles.map(m=>[m.id,m.name,m.hostname,m.ip,m.kind,m.added,m.online]),[['mac-studio-2','Mac Studio 2','studio2.example.lan','10.0.0.30','thermo',true,'offline'],['printer','Printer','10.0.0.40','','other',true,'unknown']]);
 assert.equal(tiles[0].image,'/images/home/mac-studio-2.jpg?v=2026-11-08T10%3A00%3A00.000Z');assert.equal(tiles[1].image,null);
 assert.deepEqual(tiles[0].props,{cpu:'M4 Max',gpu:'40c',ramGb:128});assert.deepEqual(tiles[1].props,{cpu:'',gpu:'—',ramGb:null});
 assert.equal(homeHistoryQuery({machine:'mac-studio-2',range:'30m'},list,SITE).reason,undefined,'an old Thermo device still has history');
 // And it can be edited: the write keeps what the old file held and stays readable by the old code (schema 1, kind).
 const edited=await d.upsert({id:'printer',name:'Printer (hall)',hostname:'10.0.0.40',role:'other',picture:'printer'},{by:'admin',base:machineHash(list[1])});
 assert.equal(edited.changed,true);
 const after=JSON.parse(await readFile(path.join(dir,'devices.json'),'utf8'));
 assert.equal(after.schema,1);assert.deepEqual(after.devices[0],{...old.devices[0]},'the untouched device is written back as it was');
 assert.deepEqual([after.devices[1].kind,after.devices[1].createdBy,after.devices[1].createdAt,after.devices[1].picture],['other','admin','2026-11-08T10:05:00.000Z','printer']);
});

test('runtime stacks: validated, bounded, hash-checked; a publication replaces the site stack or adds one',async t=>{
 const {d}=await store(t);
 for(const [bad,detail] of [
  [{...STACK,blocks:[{...STACK.blocks[0],layer:'cloud'}]},/layer must be one of input, tool, runtime, engine, hardware/],
  [{...STACK,blocks:[...STACK.blocks,{id:'clash',layer:'tool',col0:0,col1:1,title:'Clash'}]},/overlap on the tool layer/],
  [{...STACK,blocks:[{...STACK.blocks[0],col1:2}]},/col0\.\.col1/],[{...STACK,blocks:[STACK.blocks[0],STACK.blocks[0]]},/used twice/],
  [{...STACK,cols:[]},/stack\.cols/],[{...STACK,cols:Array(13).fill('gguf')},/stack\.cols/],[{...STACK,blocks:[]},/stack\.blocks/],
  [{...STACK,blocks:Array.from({length:61},(_,i)=>({id:`b${i}`,layer:'input',col0:0,col1:0,title:'x'}))},/stack\.blocks/],
  [{...STACK,blocks:[{...STACK.blocks[0],title:'x'.repeat(61)}]},/longer than 60/],[{...STACK,extra:1},/unknown field/],[{...STACK,blocks:[{...STACK.blocks[0],url:'http://x'}]},/unknown field/],
  [{...STACK,blocks:[{...STACK.blocks[2],models:Array(31).fill({id:'m'})}]},/at most 30 models/],[{...STACK,engines:Object.fromEntries(Array.from({length:13},(_,i)=>[`e${i}`,'x']))},/stack\.engines/]])
  rejects(()=>parseRuntime(bad),'invalid',detail);
 rejects(()=>parseRuntime({...STACK,blocks:[{...STACK.blocks[0],desc:'call it with api_key=sk-live-0123456789abcdef'}]}),'secret',/blocks\[0\]\.desc/);
 await rejects(d.publishRuntime('unknown-box',STACK,{known:SITE_IDS}),'not-found');
 // On a site machine that has a stack in site.json: the publication replaces it.
 const first=await d.publishRuntime('mini',STACK,{by:'agent-a',known:SITE_IDS});
 assert.equal(first.changed,true);assert.match(first.hash,/^[a-f0-9]{64}$/);
 assert.deepEqual(await d.publishRuntime('mini',STACK,{by:'agent-b',known:SITE_IDS}).then(r=>[r.changed,r.hash]),[false,first.hash],'the same stack again changes nothing');
 await rejects(d.publishRuntime('mini',{...STACK,cols:['gguf','torch']},{known:SITE_IDS,base:'0'.repeat(64)}),'conflict');
 const stack=buildHome({published:await d.stacks()}).machines.find(m=>m.id==='mini').stack;
 assert.equal(stack.source,'published');assert.equal(stack.publishedBy,'agent-a');assert.equal(stack.hash,first.hash);
 assert.deepEqual(stack.layers,['INPUT','TOOL','RUNTIME','HARDWARE'],'only the layers that hold a block, top to bottom');assert.deepEqual(stack.layerKeys,['input','tool','runtime','hardware']);
 assert.deepEqual(stack.blocks.map(b=>[b.id,b.layer,b.state]),[['api',0,'on'],['swap',1,'on'],['llama',2,'off'],['hw',3,'on']]);
 assert.equal(stack.blocks[3].hw,true);assert.equal(stack.blocks[2].models[0].path,'~/models/gemma-3-27b-it-Q4_K_M.gguf');
 // A live service refines its block; a block whose service is not reported keeps what was published.
 const live=buildHome({published:await d.stacks(),snapshots:{mini:{snapshot:{collectedAt:new Date().toISOString(),services:[{id:'llama-swap',status:'unreachable',url:'http://127.0.0.1:8081',models:[]}]}}}}).machines.find(m=>m.id==='mini').stack;
 assert.equal(live.blocks[1].state,'off');assert.equal(live.blocks[2].models.length,1);
 // On a machine without one (mini_server has no stack in the fixture) it adds it; taking it back returns to none.
 assert.equal(buildHome({}).machines.find(m=>m.id==='mini_server').stack,null);
 await d.publishRuntime('mini_server',STACK,{known:SITE_IDS});
 assert.equal(buildHome({published:await d.stacks()}).machines.find(m=>m.id==='mini_server').stack.blocks.length,4);
 assert.deepEqual(await d.publishRuntime('mini_server',null,{known:SITE_IDS}).then(r=>[r.changed,r.hash]),[true,null]);
 await d.publishRuntime('mini',null,{known:SITE_IDS});
 assert.equal(buildHome({published:await d.stacks()}).machines.find(m=>m.id==='mini').stack.source,undefined,'back to the stack from the site configuration');
});

test('telemetry states: not installed, unreachable, stale and ok are told apart',()=>{
 const now=1_800_000_000,def=(thermo,kind='thermo')=>({id:'box',kind,...(thermo?{thermo}:{})});
 const thermo=(over={})=>({seconds:()=>[],minutes:()=>[],live:()=>({}),status:()=>({}),hosts:()=>['box'],...over});
 assert.deepEqual(telemetryFor(def(null,'other'),thermo(),now),{state:'not-installed',thermoId:null,lastSampleAt:null,ageSeconds:null,reason:null});
 assert.equal(telemetryFor(def(null,'nas'),thermo(),now).state,'not-installed');
 assert.equal(telemetryFor(def(null,'router'),thermo(),now).state,'not-applicable');
 const ok=telemetryFor(def('box'),thermo({seconds:()=>[{t:now-4}]}),now);
 assert.deepEqual(ok,{state:'ok',thermoId:'box',lastSampleAt:new Date((now-4)*1000).toISOString(),ageSeconds:4,reason:null});
 assert.equal(telemetryFor(def('box'),thermo({seconds:()=>[{t:now-TELEMETRY_STALE_SECONDS}]}),now).state,'ok','exactly three minutes is still ok');
 // Older than three minutes: stale, with when it was last seen and why nothing newer came.
 const stale=telemetryFor(def('box'),thermo({minutes:()=>[{t:now-900}],status:()=>({box:{state:'down'}})}),now);
 assert.deepEqual([stale.state,stale.ageSeconds,stale.reason],['stale',900,'down']);
 // Nothing ever read: unreachable, and the reason says which step is missing.
 assert.deepEqual(['down','denied','up',undefined].map(state=>telemetryFor(def('box'),thermo({status:()=>({box:{state}})}),now).reason),['down','denied','no-data','waiting']);
 const noLogin=telemetryFor(def('box'),thermo({hosts:()=>[]}),now);assert.deepEqual([noLogin.state,noLogin.reason],['unreachable','no-login']);
 assert.equal(telemetryFor(def('box'),{seconds:()=>[],minutes:()=>[],live:()=>({}),status:()=>({})},now).reason,'waiting','a poller that cannot list its hosts is not blamed for a missing login');
 // In the payload: every machine carries its state, and the page learns where the agent lives from one constant.
 const home=buildHome({added:[{id:'box',name:'Box',hostname:'box.example.lan',kind:'other',props:{}}].map(d=>({...d,role:'computer',thermoId:null,picture:null,source:'agent',props:{cpu:'',gpu:'',ramGb:null,diskTotalBytes:null}}))});
 assert.deepEqual(home.telemetry,{agent:'Thermo',repoUrl:TELEMETRY_REPO_URL,staleAfterSeconds:180});assert.match(TELEMETRY_REPO_URL,/^https:\/\/github\.com\/OWNER\//,'still the placeholder to be filled');
 assert.deepEqual(Object.fromEntries(home.machines.map(m=>[m.id,m.telemetry.state])),{mini:'unreachable',studio:'unreachable',mini_server:'unreachable',nas:'not-installed',router:'not-applicable',box:'not-installed'});
 assert.deepEqual(home.machines.map(m=>m.online),['offline','offline','offline','unknown','offline','unknown'],'the online field keeps its old meaning');
});

test('home.runtimes extension point: provided runtimes are bounded and cleaned, absent ones are null',()=>{
 assert.equal(runtimesFor(null),null);assert.equal(runtimesFor({runtimes:'x'}),null);
 const r=runtimesFor({source:'agent',observedAt:'2026-11-10T10:00:00Z',extra:1,runtimes:[{id:'ollama',kind:'ollama',status:'running',url:'http://127.0.0.1:11434',models:[{id:'qwen3:14b',state:'loaded',sizeGb:9.3,secret:'x'}],stats:[{label:'tokens/s',value:42}]},
  {id:'odd',status:'exploded'},null,...Array.from({length:30},(_,i)=>({id:`r${i}`}))]});
 assert.equal(r.runtimes.length,20);assert.deepEqual(r.runtimes[0],{id:'ollama',name:'ollama',kind:'ollama',status:'running',url:'http://127.0.0.1:11434',version:null,models:[{id:'qwen3:14b',state:'loaded',sizeGb:9.3}],stats:[{label:'tokens/s',value:'42'}]});
 assert.equal(r.runtimes[1].status,'unknown');
 const home=buildHome({runtimes:{mini:{runtimes:[{id:'llama-swap',status:'running'}]},ghost:{runtimes:[]}}});
 assert.equal(home.machines.find(m=>m.id==='mini').runtimes.runtimes[0].id,'llama-swap');assert.equal(home.machines.find(m=>m.id==='studio').runtimes,null);
});

test('machine list: site machines are read-only, stored ones carry their hash and provenance',async t=>{
 const {d}=await store(t);const made=await d.upsert(pi,{by:'agent-a',source:'agent'});await d.publishRuntime('pi-hole',STACK,{by:'agent-a'});
 const added=await d.list(),published=await d.stacks();
 const list=machineList({site:SITE,added,published,home:buildHome({added,published}),withStack:true});
 assert.deepEqual(list.machines.map(m=>[m.id,m.source,m.readOnly]),[...SITE_IDS.map(id=>[id,'site',true]),['pi-hole','agent',false]]);
 const mini=list.machines[0],box=list.machines.at(-1);
 assert.equal(mini.hash,null);assert.equal(mini.runtime.source,'site');assert.equal(mini.thermoId,'mini');
 assert.deepEqual({id:box.id,name:box.name,hostname:box.hostname,ip:box.ip,role:box.role,hardware:box.hardware,thermoId:box.thermoId,picture:box.picture},{...pi,hardware:{...pi.hardware,diskTotalBytes:null},thermoId:null});
 assert.equal(box.hash,made.hash);assert.equal(box.createdBy,'agent-a');assert.equal(box.telemetry.state,'not-installed');
 assert.equal(box.runtime.source,'published');assert.deepEqual(box.runtime.stack,parseRuntime(STACK),'the stack comes back in the form runtime_publish takes');
 assert.deepEqual(list.pictures.map(p=>p.id),[...PICTURES]);assert.ok(list.pictures.every(p=>p.url===`/images/generic/${p.id}.svg`));
 assert.deepEqual(list.lanCidrs,LAN);assert.deepEqual(list.runtimeLayers,['input','tool','runtime','engine','hardware']);assert.equal(list.telemetry.repoUrl,TELEMETRY_REPO_URL);
 assert.deepEqual(machineList({site:EMPTY_SITE}).machines,[],'a hub without a site configuration lists nothing');
});

test('machine API over HTTP: home:write for keys, a write session for people, site machines read-only, old keys gain nothing',async t=>{
 const h=await hub(t,{thermoPoller:quiet});
 assert.ok(SCOPES['home:write']);assert.equal(legacyScopes('write').includes('home:write'),false,'keys from before scopes never get the new scope');
 const writer=await h.account('agent-home',['home:write']),reader=await h.account('agent-reader',['inventory:write','tickets:write']);
 const legacy={Authorization:'Bearer '+(await (await h.post('/api/admin/keys',{name:'Old writer',permission:'write'},h.admin)).json()).token};
 const get=(url,headers)=>fetch(h.origin+url,{headers});
 assert.equal((await get('/api/home/machines',{})).status,401);
 assert.equal((await get('/api/home/machines',reader.headers)).status,200,'reading needs only read');
 for(const headers of [reader.headers,legacy]){
  const r=await h.post('/api/home/machines',{machine:pi},headers);assert.equal(r.status,403);assert.equal((await r.json()).error.code,'SCOPE_REQUIRED');
  assert.equal((await h.post('/api/home/machines/remove',{id:'pi-hole',base:'0'.repeat(64)},headers)).status,403);
  assert.equal((await h.post('/api/home/runtime',{machine:'mini',stack:STACK},headers)).status,403);}
 // An agent creates, repeats and replaces.
 const created=await h.post('/api/home/machines',{machine:pi},writer.headers);assert.equal(created.status,201);
 const made=await created.json();assert.deepEqual([made.ok,made.id,made.created,made.changed,made.by],[true,'pi-hole',true,true,'agent-home']);
 const repeat=await h.post('/api/home/machines',{machine:pi},writer.headers);assert.equal(repeat.status,200);assert.equal((await repeat.json()).changed,false);
 const stale=await h.post('/api/home/machines',{machine:{...pi,name:'Renamed'}},writer.headers);assert.equal(stale.status,409);assert.equal((await stale.json()).error.code,'MACHINE_CONFLICT');
 // A person with a write session edits the same machine in the UI.
 const edited=await h.post('/api/home/machines',{machine:{...pi,name:'Pi-hole (rack)'},base:made.hash},h.admin);assert.equal(edited.status,200);const editedBody=await edited.json();
 // Each refusal has its own code, and details name the field.
 const cases=[[{machine:{...pi,id:'studio'}},403,'MACHINE_READ_ONLY'],[{machine:{...pi,id:'pi-2'}},409,'MACHINE_DUPLICATE'],[{machine:{id:'pi-2',name:'x',ip:'172.16.0.9'}},400,'MACHINE_INVALID',/machine\.ip/],
  [{machine:{id:'pi-2',name:'x',hardware:{cpu:'password: hunter2hunter2'}}},422,'MACHINE_SECRET',/hardware\.cpu/],[{machine:pi,extra:true},400,'MACHINE_INVALID',/expected only/],[{},400,'MACHINE_INVALID']];
 for(const [body,status,code,detail] of cases){const r=await h.post('/api/home/machines',body,writer.headers),e=(await r.json()).error;assert.equal(r.status,status,code);assert.equal(e.code,code);if(detail)assert.match(e.details[0],detail);}
 // The overview shows it next to the site's machines, which keep every field they had.
 const home=await (await get('/api/home',reader.headers)).json();
 assert.deepEqual(home.machines.map(m=>m.id),[...SITE_IDS,'pi-hole']);
 const tile=home.machines.at(-1);
 assert.deepEqual([tile.name,tile.added,tile.kind,tile.role,tile.source,tile.readOnly,tile.picture,tile.pictureId,tile.image,tile.hash],['Pi-hole (rack)',true,'other','other','agent',false,'/images/generic/board.svg','board',null,editedBody.hash]);
 for(const m of home.machines)for(const field of ['id','name','hostname','ip','kind','props','online','lastSeen','thermo','bridge','quad','volumes','memoryUsedBytes','memoryTotalBytes','uptimeSeconds','services','collectedAt','reviewNeeded','stack','telemetry','runtimes','role','source'])assert.ok(field in m,`${m.id}.${field}`);
 for(const field of ['poll','schemaVersion','generatedAt','machines','router','telemetry'])assert.ok(field in home,field);
 assert.deepEqual(home.machines.slice(0,5).map(m=>[m.source,m.readOnly,m.added]),Array(5).fill(['site',true,undefined]));
 const picture=await get('/images/generic/board.svg',h.admin);assert.equal(picture.status,200);assert.match(picture.headers.get('content-type'),/image\/svg\+xml/);
 // The tile order knows the new machine.
 assert.ok((await (await get('/api/profile/home-order',h.admin)).json()).known.includes('pi-hole'));
 // The runtime stack of a site machine may be published; the machine itself stays read-only.
 const pub=await h.post('/api/home/runtime',{machine:'mini',stack:STACK},writer.headers);assert.equal(pub.status,200);const published=await pub.json();assert.deepEqual([published.ok,published.id,published.changed,published.published],[true,'mini',true,true]);
 assert.equal((await h.post('/api/home/runtime',{machine:'ghost',stack:STACK},writer.headers)).status,404);
 const badStack=await h.post('/api/home/runtime',{machine:'mini',stack:{...STACK,cols:[]}},writer.headers);assert.equal(badStack.status,400);assert.match((await badStack.json()).error.details[0],/stack\.cols/);
 assert.equal((await h.post('/api/home/runtime',{machine:'mini'},writer.headers)).status,400,'stack must be given, null takes it back');
 const listed=await (await get('/api/home/machines?stack=1',reader.headers)).json();
 assert.equal(listed.machines.find(m=>m.id==='mini').runtime.hash,published.hash);assert.equal(listed.machines.find(m=>m.id==='mini').runtime.stack.blocks.length,4);
 assert.equal((await (await get('/api/home/machines',reader.headers)).json()).machines[0].runtime.stack,undefined);
 // Removal needs the current hash; site machines cannot be removed.
 assert.equal((await h.post('/api/home/machines/remove',{id:'pi-hole'},writer.headers)).status,400);
 assert.equal((await h.post('/api/home/machines/remove',{id:'pi-hole',base:made.hash},writer.headers)).status,409);
 assert.equal((await h.post('/api/home/machines/remove',{id:'studio',base:made.hash},writer.headers)).status,403);
 assert.deepEqual(await (await h.post('/api/home/machines/remove',{id:'pi-hole',base:editedBody.hash},writer.headers)).json(),{ok:true,id:'pi-hole',removed:true});
 assert.equal((await h.post('/api/home/machines/remove',{id:'pi-hole',base:editedBody.hash},writer.headers)).status,404);
 // Every key write is in the write log with what it touched; refused ones too.
 const audit=await (await get('/api/admin/audit',h.admin)).json();
 assert.ok(audit.events.some(e=>e.event==='api-write'&&e.subject==='agent-home'&&e.detail==='/api/home/machines · pi-hole'&&e.status===201));
 assert.ok(audit.events.some(e=>e.event==='api-write'&&e.subject==='agent-home'&&e.detail==='/api/home/runtime · mini'&&e.status===200));
 assert.ok(audit.events.some(e=>e.event==='api-write'&&e.subject==='agent-reader'&&e.status===403));
 // A read-only person cannot write either.
 const guest=await (await h.post('/api/admin/users',{username:'guest'},h.admin)).json();
 const login=await h.post('/api/session',{username:'guest',password:guest.initialPassword});const viewer={Cookie:login.headers.get('set-cookie').split(';')[0]};
 const denied=await h.post('/api/home/machines',{machine:pi},viewer);assert.equal(denied.status,403);assert.equal((await denied.json()).error.code,'READ_ONLY');
});

test('MCP: an agent fills an empty hub with machine_upsert and runtime_publish, and cleans up with machine_remove',async t=>{
 // No site configuration at all: what a public installer starts with.
 const h=await hub(t,{site:EMPTY_SITE,thermoPoller:quiet});
 const rpc=(headers,method,params)=>fetch(h.origin+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify({jsonrpc:'2.0',id:1,method,...(params?{params}:{})})}).then(r=>r.json());
 const call=async(headers,name,args)=>(await rpc(headers,'tools/call',{name,arguments:args})).result;
 const agent=await h.account('setup-agent',['home:write']),reader=await h.account('reader',[]);
 const names=async headers=>(await rpc(headers,'tools/list')).result.tools.map(x=>x.name);
 const mine=['machine_list','machine_upsert','machine_remove','runtime_publish'];
 assert.deepEqual((await names(agent.headers)).filter(n=>mine.includes(n)).sort(),[...mine].sort());
 assert.deepEqual((await names(reader.headers)).filter(n=>mine.includes(n)),['machine_list'],'write tools are hidden without home:write');
 const tools=(await rpc(agent.headers,'tools/list')).result.tools;
 for(const name of mine){const tool=tools.find(x=>x.name===name);assert.equal(tool.inputSchema.type,'object');assert.equal(tool.inputSchema.additionalProperties,false);assert.equal(tool.scope,undefined);}
 assert.deepEqual(tools.find(x=>x.name==='machine_upsert').inputSchema.properties.machine.properties.picture.enum,[...PICTURES,null]);
 const refused=await call(reader.headers,'machine_upsert',{machine:pi});assert.equal(refused.isError,true);assert.match(refused.content[0].text,/home:write/);
 // Empty to begin with; the list tells the agent what it may use.
 const empty=(await call(agent.headers,'machine_list',{})).structuredContent;
 assert.deepEqual(empty.machines,[]);assert.deepEqual(empty.lanCidrs,[]);assert.equal(empty.pictures.length,PICTURES.length);assert.deepEqual(empty.roles,['computer','nas','router','other']);
 // Two machines, one with the telemetry agent named.
 const mini=(await call(agent.headers,'machine_upsert',{machine:{id:'mac-mini',name:'Mac mini',hostname:'mini.example.lan',ip:'192.168.1.20',role:'computer',hardware:{cpu:'10c M4',gpu:'10c',ramGb:24},thermoId:'mac-mini',picture:'mini'}})).structuredContent;
 assert.deepEqual([mini.ok,mini.id,mini.created,mini.by],[true,'mac-mini',true,'setup-agent']);
 const nas=(await call(agent.headers,'machine_upsert',{machine:{id:'nas',name:'NAS',hostname:'nas.example.lan',role:'nas'}})).structuredContent;assert.equal(nas.created,true);
 assert.equal((await call(agent.headers,'machine_upsert',{machine:{id:'nas',name:'NAS',hostname:'nas.example.lan',role:'nas'}})).structuredContent.changed,false,'the same call again is harmless');
 // Refusals come back as tool errors that say what to do, and nothing is stored.
 const conflict=await call(agent.headers,'machine_upsert',{machine:{id:'nas',name:'Storage'}});assert.equal(conflict.isError,true);assert.match(conflict.content[0].text,/machine_list again/);
 const secret=await call(agent.headers,'machine_upsert',{machine:{id:'leak',name:'Leak',hardware:{cpu:'ghp_abcdefghij1234567890'}}});assert.equal(secret.isError,true);assert.match(secret.content[0].text,/looks like a secret.*hardware\.cpu/);
 const invalid=await call(agent.headers,'machine_upsert',{machine:{id:'bad',name:'Bad',role:'fridge'}});assert.equal(invalid.isError,true);assert.match(invalid.content[0].text,/machine\.role must be one of computer, nas, router, other/);
 assert.equal((await call(agent.headers,'machine_upsert',{machine:{id:'x1',name:'x'},force:true})).isError,true,'unknown arguments are refused');
 // Change one with the hash from the list.
 const before=(await call(agent.headers,'machine_list',{})).structuredContent.machines.find(m=>m.id==='nas');
 assert.deepEqual([before.source,before.readOnly,before.createdBy,before.picture,before.telemetry.state],['agent',false,'setup-agent',null,'not-installed']);
 const renamed=(await call(agent.headers,'machine_upsert',{machine:{id:'nas',name:'Storage',hostname:'nas.example.lan',role:'nas',picture:'nas'},base:before.hash})).structuredContent;assert.equal(renamed.changed,true);
 // The runtime stack of the mini.
 const pub=(await call(agent.headers,'runtime_publish',{machine:'mac-mini',stack:STACK})).structuredContent;assert.deepEqual([pub.ok,pub.id,pub.changed,pub.published],[true,'mac-mini',true,true]);
 const badLayer=await call(agent.headers,'runtime_publish',{machine:'mac-mini',stack:{...STACK,blocks:[{...STACK.blocks[0],layer:'middleware'}]}});assert.equal(badLayer.isError,true);assert.match(badLayer.content[0].text,/input, tool, runtime, engine, hardware/);
 assert.equal((await call(agent.headers,'runtime_publish',{machine:'nope',stack:STACK})).isError,true);
 // What a person now sees on the overview and what the status tool reports.
 const home=await (await fetch(h.origin+'/api/home',{headers:h.admin})).json();
 assert.deepEqual(home.machines.map(m=>[m.id,m.name,m.kind,m.source,m.picture,m.telemetry.state,m.telemetry.reason]),[['mac-mini','Mac mini','thermo','agent','/images/generic/mini.svg','unreachable','no-login'],['nas','Storage','nas','agent','/images/generic/nas.svg','not-installed',null]]);
 assert.equal(home.machines[0].stack.source,'published');assert.equal(home.machines[0].stack.publishedBy,'setup-agent');assert.equal(home.machines[1].stack,null);
 assert.deepEqual((await call(reader.headers,'home_status',{})).structuredContent.machines.map(m=>m.id),['mac-mini','nas']);
 const withStack=(await call(reader.headers,'machine_list',{runtime:true})).structuredContent.machines[0];assert.equal(withStack.runtime.hash,pub.hash);assert.equal(withStack.runtime.stack.blocks.length,4);
 // Remove: the hash is required and checked.
 assert.equal((await call(agent.headers,'machine_remove',{id:'nas'})).isError,true);assert.equal((await call(agent.headers,'machine_remove',{id:'nas',base:before.hash})).isError,true,'a stale hash');
 assert.deepEqual((await call(agent.headers,'machine_remove',{id:'nas',base:renamed.hash})).structuredContent,{ok:true,id:'nas',removed:true});
 assert.deepEqual((await call(agent.headers,'machine_list',{})).structuredContent.machines.map(m=>m.id),['mac-mini']);
 // Every write call is logged with the machine it touched, refused ones included; arguments never are.
 const log=(await readFile(path.join(h.dir,'api-audit.jsonl'),'utf8')).trim().split('\n').map(l=>JSON.parse(l)).filter(e=>e.event==='mcp-call');
 assert.ok(log.some(e=>e.tool==='machine_upsert'&&e.status==='ok'&&e.subject==='mac-mini'&&e.name==='setup-agent'));
 assert.ok(log.some(e=>e.tool==='runtime_publish'&&e.status==='ok'&&e.subject==='mac-mini'));assert.ok(log.some(e=>e.tool==='machine_remove'&&e.status==='ok'&&e.subject==='nas'));
 assert.ok(log.some(e=>e.tool==='machine_upsert'&&e.status==='denied'&&e.name==='reader'));assert.ok(log.some(e=>e.tool==='machine_upsert'&&e.status==='error'));
 assert.equal(JSON.stringify(log).includes('ghp_'),false);
});

test('an existing device is connected to Thermo after its login was checked; keys never touch logins or pictures',async t=>{
 const logins=[],added=[],removed=[],PIN='cd'.repeat(32);
 const thermoPoller={...quiet,addHost:c=>added.push(c.id),removeHost:id=>removed.push(id)};
 const h=await hub(t,{thermoPoller,checkThermo:async c=>{logins.push(c);if(c.password!=='correct horse battery')throw new Error('denied');return 'ok';}});
 const agent=await h.account('agent-home',['home:write']);
 await h.post('/api/home/machines',{machine:{id:'mac-mini-2',name:'Mac mini 2',hostname:'mini2.example.lan',role:'computer'}},agent.headers);
 const thermo={port:49286,username:'homehub',password:'correct horse battery',pin:PIN};
 assert.equal((await h.post('/api/home/devices/thermo',{id:'mac-mini-2',thermo},agent.headers)).status,403,'never with an API key');
 assert.equal((await h.post('/api/home/devices/image/remove',{id:'mac-mini-2'},agent.headers)).status,403);
 const wrong=await h.post('/api/home/devices/thermo',{id:'mac-mini-2',thermo:{...thermo,password:'wrong password!!'}},h.admin);assert.equal(wrong.status,422);assert.deepEqual(added,[]);
 assert.equal((await h.post('/api/home/devices/thermo',{id:'ghost',thermo},h.admin)).status,404);
 assert.equal((await h.post('/api/home/devices/thermo',{id:'mac-mini-2',thermo:{...thermo,pin:'nope'}},h.admin)).status,400);
 const ok=await h.post('/api/home/devices/thermo',{id:'mac-mini-2',thermo},h.admin);assert.equal(ok.status,200);
 const device=await ok.json();assert.deepEqual([device.thermoId,device.kind],['mac-mini-2','thermo']);assert.equal(JSON.stringify(device).includes('correct horse'),false);
 assert.deepEqual(added,['mac-mini-2']);assert.equal(logins.at(-1).host,'mini2.example.lan');assert.equal(logins.at(-1).pin,PIN);
 const secrets=JSON.parse(await readFile(path.join(h.dir,'home','thermo-hosts.json'),'utf8'));assert.equal(secrets.hosts[0].id,'mac-mini-2');
 assert.equal((await readFile(path.join(h.dir,'home','devices.json'),'utf8')).includes('correct horse'),false,'the password stays in the 0600 file');
 // Forgetting the login stops the pull and returns the machine to "not installed".
 const off=await h.post('/api/home/devices/thermo',{id:'mac-mini-2',thermo:null},h.admin);assert.equal(off.status,200);assert.equal((await off.json()).thermoId,null);assert.deepEqual(removed,['mac-mini-2']);
 assert.deepEqual(JSON.parse(await readFile(path.join(h.dir,'home','thermo-hosts.json'),'utf8')).hosts,[]);
 // A machine removed through the API takes a stored login along, and only then is the poller told.
 await h.post('/api/home/devices/thermo',{id:'mac-mini-2',thermo},h.admin);
 const list=await (await fetch(h.origin+'/api/home/machines',{headers:agent.headers})).json();
 assert.equal((await h.post('/api/home/machines/remove',{id:'mac-mini-2',base:list.machines.find(m=>m.id==='mac-mini-2').hash},agent.headers)).status,200);
 assert.deepEqual(removed,['mac-mini-2','mac-mini-2']);
 const plain=await (await h.post('/api/home/machines',{machine:{id:'plain',name:'Plain',thermoId:'mini'}},agent.headers)).json();
 await h.post('/api/home/machines/remove',{id:'plain',base:plain.hash},agent.headers);
 assert.deepEqual(removed,['mac-mini-2','mac-mini-2'],'a machine that only names a host of the hosts file does not end that host\'s session');
});

test('the uploaded picture can be dropped again for a built-in one',async t=>{
 const {dir,d}=await store(t);await d.upsert(pi,{});
 await mkdir(path.join(dir,'images'),{recursive:true});
 const {Readable}=await import('node:stream');
 assert.equal((await d.putImage('pi-hole',Readable.from([Buffer.from([0xff,0xd8,0xff,0xe0,1,2])]))).image,true);
 const back=await d.removeImage('pi-hole');assert.equal(back.image,false);assert.equal(back.imageAt,undefined);
 await rejects(d.image('pi-hole'),'not-found');await rejects(d.removeImage('ghost'),'not-found');
});
