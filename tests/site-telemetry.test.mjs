// Telemetry of a machine from the site configuration, connected on its own tile: the fixture's NAS (id "nas", role
// nas, no platform in site.json) is read from an existing Prometheus or straight from Node Exporter, switched and
// disconnected in place, while its identity, role, services and provenance stay the site's. The binding lives in
// state/home/site-telemetry.json (no secrets), the connection in the same private files as an added device's; nothing
// is written to devices.json or site.json; agents and API keys reach none of it; a restart keeps it; a machine that
// leaves site.json is neither polled nor shown. Every endpoint and tool is faked.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir,access} from 'node:fs/promises';
import {generateKeyPairSync} from 'node:crypto';
import path from 'node:path';
import {readStore} from './support/sealed.mjs';
import {hub,SITE} from './hub-helper.mjs';
import {exposition} from './fixtures/node-exporter.mjs';
import {createHomeDevices,siteBindable,siteProviderFits} from '../server/home-devices.mjs';
import {buildHome,homeHistoryQuery,machineList} from '../server/home-data.mjs';
import {validateSite} from '../server/site-config.mjs';

const u32=n=>{const b=Buffer.alloc(4);b.writeUInt32BE(n);return b;},str=b=>Buffer.concat([u32(b.length),Buffer.from(b)]);
const hostKey=Buffer.concat([str('ssh-ed25519'),str(Buffer.from(generateKeyPairSync('ed25519').publicKey.export({format:'jwk'}).x,'base64url'))]).toString('base64');
const now=()=>Math.floor(Date.now()/1000);
function fakePoller(){
 const configs=new Map(),added=[],removed=[];
 return {added,removed,configs,addHost:c=>{added.push(c);configs.set(c.id,c);},removeHost:id=>{removed.push(id);configs.delete(id);},start:async()=>{},stop:()=>{},
  status:()=>({}),live:()=>({}),seconds:()=>[],minutes:()=>[],disks:()=>({}),native:()=>({}),hosts:()=>[...configs.keys()],targets:()=>Object.fromEntries([...configs].map(([id,c])=>[id,c.target])),
  connections:()=>Object.fromEntries([...configs].map(([id,c])=>[id,{mode:c.provider||'x',host:c.record?.host}])),interval:()=>({intervalSeconds:30,lastPollAt:null}),setIntervalMs:()=>30000,refresh:async()=>false,pause:async()=>{},resume:async()=>{}};
}
const promReplies=()=>({node_uname_info:{resultType:'vector',result:[{metric:{__name__:'node_uname_info',job:'nas-node',instance:'nas',nodename:'n'},value:[now(),'1']}]},
 up:{resultType:'vector',result:[{metric:{__name__:'up',job:'nas-node',instance:'nas'},value:[now(),'1']},{metric:{__name__:'up',job:'prometheus',instance:'localhost:9090'},value:[now(),'1']}]},
 'timestamp(up)':{resultType:'vector',result:[{metric:{job:'nas-node',instance:'nas'},value:[now(),String(now()-5)]}]}});
function promMatrix(){const t=now()-3,S=(name,labels,v)=>({metric:{__name__:name,job:'nas-node',instance:'nas',...labels},values:[[t-15,String(v)],[t,String(v)]]});
 return {resultType:'matrix',result:[S('up',{},1),S('node_uname_info',{nodename:'n'},1),S('node_cpu_seconds_total',{cpu:'0',mode:'idle'},5),S('node_memory_MemTotal_bytes',{},8e9),S('node_memory_MemAvailable_bytes',{},4e9)]};}
const LINUX_OUT=['HHLNX1','@t',String(now()),'@uptime','100.0 1','@stat','cpu  1 0 1 10 0 0 0 0 0 0','cpu0 1 0 1 10 0 0 0 0 0 0','@mem','MemTotal: 1000 kB','MemAvailable: 500 kB','@load','0 0 0 1/1 1','@disk','@net','@mounts','@df','@os','@cpuinfo','@hwmon','@end'].join('\n');

async function setup(t){
 const requests=[],pollers={winrm:fakePoller(),'node-exporter':fakePoller(),prometheus:fakePoller(),'linux-ssh':fakePoller()},windowsPoller=fakePoller();
 const endpointRequest=async o=>{requests.push(o);
  if(o.path==='/metrics')return {status:200,headers:{'content-type':'text/plain; version=0.0.4'},body:Buffer.from(exposition({at:now()}))};
  if(o.path==='/api/v1/query'){const q=o.query.query;const d=promReplies()[q]||(q.startsWith('{__name__=~')?promMatrix():null);
   return {status:200,headers:{'content-type':'application/json'},body:Buffer.from(JSON.stringify({status:'success',data:d}))};}
  throw new Error('unreachable');};
 const sshRun=async(args,{binary='ssh'}={})=>{
  if(binary==='ssh'&&args[0]==='-V')return {code:0,stdout:'',stderr:'OpenSSH_9.6p1',error:null};
  if(binary==='ssh-keyscan')return args.length?{code:0,stdout:`${args.at(-1)} ssh-ed25519 ${hostKey}\n`,stderr:'',error:null}:{code:1,stdout:'',stderr:'usage',error:null};
  if(binary==='ssh'&&args[0]==='-F')return {code:0,stdout:LINUX_OUT,stderr:'',error:null};
  return {code:null,stdout:'',stderr:'',error:'spawn'};};
 const h=await hub(t,{feedPollers:pollers,endpointRequest,probeCertificate:async()=>{throw new Error('unreachable');},sshRun,windowsPoller});
 const call=async(url,body,headers=h.admin)=>{const r=await h.post(url,body,headers);return {status:r.status,body:await r.json().catch(()=>({}))};};
 const get=async url=>(await fetch(`${h.origin}${url}`,{headers:h.admin})).json();
 const file=name=>path.join(h.dir,'home',name);
 const json=async name=>readStore(file(name));
 return {h,call,get,file,json,pollers,windowsPoller,requests};
}
// The Prometheus flow on the site NAS, up to a tested draft. Returns the body that saves it.
async function promDraft(call,id='nas'){
 const d=(await call('/api/home/devices/endpoint/draft',{provider:'prometheus',id})).body.draft;
 assert.equal(d.device,id,'the draft is bound to the site machine');
 const found=await call('/api/home/devices/endpoint/draft/discover',{draft:d.id,host:'10.0.0.90',port:9090,scheme:'http',auth:'none'});
 assert.deepEqual(found.body.targets.map(x=>[x.job,x.instance,x.eligible]),[['nas-node','nas',true]]);
 const ok=await call('/api/home/devices/endpoint/draft/test',{draft:d.id,host:'10.0.0.90',port:9090,scheme:'http',auth:'none',job:'nas-node',instance:'nas'});
 assert.equal(ok.status,200,JSON.stringify(ok.body));
 return {provider:'prometheus',draft:d.id,host:'10.0.0.90',port:9090,scheme:'http',auth:'none',job:'nas-node',instance:'nas'};
}

test('the site NAS connects to an existing Prometheus on its own tile: identity, services and provenance stay the site\'s',async t=>{
 const {h,call,get,file,json,pollers,requests}=await setup(t);
 const before=await get('/api/home');const nas0=before.machines.find(m=>m.id==='nas');
 assert.deepEqual([nas0.source,nas0.readOnly,nas0.kind,nas0.role,nas0.telemetryEditable,nas0.telemetryBinding,nas0.telemetry.state],['site',true,'nas','nas',true,null,'not-installed']);
 assert.equal(before.machines.find(m=>m.id==='mini').telemetryEditable,false,'a machine the site reads through Thermo keeps its site files');
 assert.equal(before.machines.find(m=>m.id==='router').telemetryEditable,false);
 const body=await promDraft(call);
 const saved=await call('/api/home/devices/telemetry',{id:'nas',telemetry:body});
 assert.equal(saved.status,200,JSON.stringify(saved.body));
 assert.deepEqual(saved.body,{id:'nas',source:'site',readOnly:true,telemetryProvider:'prometheus',platform:'linux'});
 assert.equal(pollers.prometheus.added.at(-1).id,'nas');assert.equal(pollers.prometheus.added.at(-1).record.instance,'nas');
 assert.ok(requests.every(o=>o.path==='/api/v1/query'));
 // Stored: a binding without secrets, the connection with the others, no shadow device.
 const bindings=(await json('site-telemetry.json')).bindings;
 assert.deepEqual(bindings.map(b=>[b.id,b.provider,b.platform,b.configuredBy]),[['nas','prometheus','linux','admin']]);
 assert.deepEqual((await json('telemetry-hosts.json')).hosts.map(x=>[x.id,x.provider]),[['nas','prometheus']]);
 await assert.rejects(access(file('devices.json')),'no shadow device in devices.json');
 // The tile: live telemetry from the binding, still a NAS from the site configuration.
 const home=await get('/api/home'),nas=home.machines.find(m=>m.id==='nas');
 assert.deepEqual([nas.source,nas.readOnly,nas.role,nas.kind,nas.platform,nas.name,nas.hostname],['site',true,'nas','thermo','linux','NAS','nas.example.lan']);
 assert.deepEqual([nas.telemetry.provider,nas.telemetry.hostId,nas.telemetryBinding.provider],['prometheus','nas','prometheus']);
 assert.equal(nas.hash,undefined);assert.equal(nas.added,undefined);
 // machine_list: still read-only, no hash, platform from the binding, no connection.
 const list=await get('/api/home/machines'),m=list.machines.find(x=>x.id==='nas');
 assert.deepEqual([m.source,m.readOnly,m.hash,m.platform,m.role,m.telemetry.provider],['site',true,null,'linux','nas','prometheus']);
 assert.doesNotMatch(JSON.stringify(list),/10\.0\.0\.90|nas-node/,'agents never see the connection');
 // History is the provider's, not "no source".
 const hist=await get('/api/home/history?machine=nas&range=30m');assert.equal(hist.reason,undefined);assert.match(hist.source,/Prometheus/);
 // The integration counts it, with the site's name.
 const integ=await get('/api/admin/integrations');const prom=(Array.isArray(integ)?integ:integ.integrations||integ.items||[]).find(i=>i.id==='home.prometheus');
 assert.ok(prom,'the Prometheus integration is listed');assert.deepEqual(prom.status.items.map(i=>[i.id,i.label]),[['nas','NAS']]);
 assert.ok(prom.status.configuredBy.some(c=>/konfigurace webu/.test(c.name)));
 // The machine API still refuses the site record.
 const up=await call('/api/home/machines',{machine:{id:'nas',name:'NAS',role:'nas'}});assert.equal(up.status,403);assert.equal(up.body.error.code,'MACHINE_READ_ONLY');
 const rm=await call('/api/home/machines/remove',{id:'nas',base:'a'.repeat(64)});assert.equal(rm.status,403);
 assert.notEqual((await call('/api/home/devices/remove',{id:'nas'})).status,200,'no remove of a site machine');
 // Its picture is the owner's override now (tests/site-overrides.test.mjs): with none uploaded, removing one changes nothing.
 const pic=await call('/api/home/devices/image/remove',{id:'nas'});assert.equal(pic.status,200);assert.equal(pic.body.siteOverride,null);
 await assert.rejects(access(file('site-overrides.json')),'nothing to remove writes no override');
 assert.deepEqual((await json('site-telemetry.json')).bindings.map(b=>b.id),['nas'],'refusals change nothing');
 void h;
});

test('switch and disconnect in place: the old poller lets go, its secret goes, the id stays; a removed site machine is not polled',async t=>{
 const {call,get,json,pollers,file}=await setup(t);
 await call('/api/home/devices/telemetry',{id:'nas',telemetry:await promDraft(call)});
 // Direct Node Exporter on the same id: a deliberate switch.
 const n=(await call('/api/home/devices/endpoint/draft',{provider:'node-exporter',id:'nas'})).body.draft;
 assert.equal((await call('/api/home/devices/endpoint/draft/test',{draft:n.id,host:'10.0.0.90',port:9100,scheme:'http'})).status,200);
 const sw=await call('/api/home/devices/telemetry',{id:'nas',telemetry:{provider:'node-exporter',draft:n.id,host:'10.0.0.90',port:9100,scheme:'http'}});
 assert.equal(sw.status,200,JSON.stringify(sw.body));assert.equal(sw.body.telemetryProvider,'node-exporter');
 assert.deepEqual(pollers.prometheus.removed,['nas'],'the Prometheus poller forgets it');assert.equal(pollers['node-exporter'].added.at(-1).id,'nas');
 assert.deepEqual((await json('telemetry-hosts.json')).hosts.map(x=>[x.id,x.provider]),[['nas','node-exporter']],'one connection, the old one gone');
 assert.deepEqual((await json('site-telemetry.json')).bindings.map(b=>[b.id,b.provider]),[['nas','node-exporter']]);
 assert.equal((await get('/api/home')).machines.find(m=>m.id==='nas').telemetry.provider,'node-exporter');
 // Disconnect: nothing reads it, nothing is kept, the site tile is back to services only.
 const off=await call('/api/home/devices/telemetry',{id:'nas',telemetry:null});assert.equal(off.status,200);assert.equal(off.body.telemetryProvider,null);
 assert.deepEqual(pollers['node-exporter'].removed,['nas']);
 assert.deepEqual((await json('telemetry-hosts.json')).hosts,[]);assert.deepEqual((await json('site-telemetry.json')).bindings,[]);
 const nas=(await get('/api/home')).machines.find(m=>m.id==='nas');assert.deepEqual([nas.kind,nas.telemetry.state,nas.telemetryBinding],['nas','not-installed',null],'no default feed resumes');
 await assert.rejects(access(file('devices.json')));
});

test('boundaries: unknown or unfit ids, API keys, Thermo site machines and routers, platform rules',async t=>{
 const {h,call,json,file}=await setup(t);
 assert.equal((await call('/api/home/devices/endpoint/draft',{provider:'prometheus',id:'ghost'})).status,404,'an id nobody knows');
 assert.equal((await call('/api/home/devices/telemetry',{id:'ghost',telemetry:null})).status,404);
 const thermo=await call('/api/home/devices/endpoint/draft',{provider:'prometheus',id:'mini'});assert.equal(thermo.status,400);assert.match(JSON.stringify(thermo.body),/thermoId/);
 assert.equal((await call('/api/home/devices/endpoint/draft',{provider:'node-exporter',id:'router'})).status,400);
 assert.equal((await call('/api/home/devices/windows/draft',{id:'mini'})).status,400);
 assert.equal((await call('/api/home/devices/thermo',{id:'nas',thermo:{username:'homehub',password:'x'.repeat(12),pin:'a'.repeat(64)}})).status,404,'Thermo of a site machine stays in the site files');
 assert.equal((await call('/api/home/devices/windows',{id:'nas',windows:{target:'nas-admin'}})).status,400,'no SSH alias of the hub account for a site machine');
 // A draft of one machine never saves another (owner- and device-bound).
 const body=await promDraft(call,'nas');
 const other=await call('/api/home/devices/telemetry',{id:'studio',telemetry:body});assert.equal(other.status,400,'studio is a Thermo site machine');
 // Agents and API keys: none of it.
 const key=await h.account('agent',['read','home:write']);
 for(const [url,b] of [['/api/home/devices/endpoint/draft',{provider:'prometheus',id:'nas'}],['/api/home/devices/telemetry',{id:'nas',telemetry:body}],['/api/home/devices/telemetry',{id:'nas',telemetry:null}],
  ['/api/home/devices/ssh/draft',{os:'linux',id:'nas'}],['/api/home/devices/windows/draft',{id:'nas'}],['/api/home/devices/windows',{id:'nas',windows:null}]])
  assert.equal((await call(url,b,key.headers)).status,403,url);
 await assert.rejects(access(file('site-telemetry.json')),'nothing stored by a refusal');
 // The site's own platform limits the providers; the generic rule, not one household.
 const site=validateSite({machines:[{id:'box',role:'nas',platform:'windows'},{id:'pc',role:'computer'},{id:'mac',role:'computer',thermoId:'mac'},{id:'gw',role:'router'}]});
 assert.deepEqual(site.machines.map(m=>m.platform),['windows',null,null,null]);
 assert.throws(()=>validateSite({machines:[{id:'box',platform:'beos'}]}),/platform must be one of/);
 assert.deepEqual(site.machines.map(siteBindable),[true,true,false,false]);
 assert.deepEqual([siteProviderFits(site.machines[0],'prometheus'),siteProviderFits(site.machines[0],'winrm'),siteProviderFits(site.machines[1],'linux-ssh'),siteProviderFits(site.machines[1],'windows')],[false,true,true,true]);
 const store=createHomeDevices(path.join(h.dir,'other'),{reserved:site.machines.map(m=>m.id),siteMachines:site.machines});
 const rec={mode:'node-exporter',host:'10.0.0.9',port:9100,scheme:'http',tls:null,user:null,password:null,configuredAt:'x',configuredBy:'admin'};
 await assert.rejects(store.setFeed('box',{provider:'node-exporter',record:rec}),e=>e.message==='invalid'&&/runs windows/.test(e.detail));
 await assert.rejects(store.setFeed('mac',{provider:'node-exporter',record:rec}),e=>e.message==='invalid');
 await assert.rejects(store.setFeed('gw',{provider:'node-exporter',record:rec}),e=>e.message==='invalid');
 await assert.rejects(store.setFeed('nobody',{provider:'node-exporter',record:rec}),e=>e.message==='not-found');
 await assert.rejects(store.setWindows('pc',{target:'pc-alias'}),e=>e.message==='invalid','site machines: managed connections only');
 void json;
});

test('a restart keeps the binding, its poller host and its SSH key; a machine that leaves site.json is neither polled nor shown',async t=>{
 const {h,call,get,json}=await setup(t);
 // Linux over SSH on the site NAS: an app-managed key the key sweep must keep.
 const d=(await call('/api/home/devices/ssh/draft',{os:'linux',id:'nas'})).body.draft;assert.equal(d.device,'nas');
 await call('/api/home/devices/ssh/draft/key',{draft:d.id,generate:true});
 const s=await call('/api/home/devices/ssh/draft/scan',{draft:d.id,host:'10.0.0.74',port:22});
 await call('/api/home/devices/ssh/draft/trust',{draft:d.id,fingerprint:s.body.draft.hostKeys[0].fingerprint});
 assert.equal((await call('/api/home/devices/ssh/draft/test',{draft:d.id,host:'10.0.0.74',port:22,user:'homehub'})).status,200);
 const saved=await call('/api/home/devices/telemetry',{id:'nas',telemetry:{provider:'linux-ssh',draft:d.id,host:'10.0.0.74',port:22,user:'homehub'}});
 assert.equal(saved.status,200,JSON.stringify(saved.body));
 const keys=path.join(h.dir,'home','ssh','keys');assert.equal((await readdir(keys)).length,1);
 // "Restart": a fresh store on the same state, as the next process builds it.
 const root=path.join(h.dir,'home'),again=createHomeDevices(root,{reserved:SITE.machines.map(m=>m.id),siteMachines:SITE.machines});
 assert.deepEqual((await again.feedHosts('linux-ssh')).map(x=>[x.id,x.record.os]),[['nas','linux']],'the poller enumerates it after a restart');
 const secrets=await again.windowsSecrets();assert.equal(secrets.keys.size,1,'the key sweep keeps its key');
 assert.deepEqual((await again.siteBindings()).map(b=>[b.id,b.provider]),[['nas','linux-ssh']]);
 // The machine leaves site.json: dormant, not polled, not shown; the key is not swept (an edit of site.json deletes nothing).
 const without=SITE.machines.filter(m=>m.id!=='nas'),gone=createHomeDevices(root,{reserved:without.map(m=>m.id),siteMachines:without});
 assert.deepEqual(await gone.feedHosts('linux-ssh'),[]);assert.deepEqual(await gone.siteBindings(),[]);assert.equal(await gone.telemetryTarget('nas'),null);
 assert.equal((await gone.windowsSecrets()).keys.size,1);
 const view=machineList({site:{...SITE,machines:without},siteTelemetry:await gone.siteBindings()});assert.ok(!view.machines.some(m=>m.id==='nas'));
 // A new device never takes the id of a dormant binding.
 const added=await gone.add({name:'NAS',kind:'other',hostname:'other-nas.example.lan'},'admin');assert.notEqual(added.device.id,'nas');
 // Disconnecting the dormant binding is how its connection goes.
 const off=await gone.setFeed('nas',null);assert.equal(off.previous.provider,'linux-ssh');assert.deepEqual((await json('site-telemetry.json')).bindings,[]);
 assert.deepEqual((await json('telemetry-hosts.json')).hosts,[]);
 void get;
});

test('payload: a bound NAS keeps its probed services and role, draws gauges; machines without a binding stay as they were',()=>{
 const at=now(),reading={t:at-2,cpu:12,memUsed:4e9,memTotal:8e9,span:30};
 const thermo={interval:()=>({intervalSeconds:30,lastPollAt:null}),status:()=>({nas:{state:'up'}}),live:()=>({nas:{at:Date.now(),reading}}),seconds:id=>id==='nas'?[reading]:[],minutes:()=>[],
  disks:()=>({nas:{disks:[{name:'tank',mount:'/mnt/tank',fs:'zfs',used:1e12,total:4e12}]}}),native:()=>({nas:{cpu:{cores:[10,14]},os:{caption:'Linux'}}}),targets:()=>({nas:'http://10.0.0.74:9090'}),connections:()=>({nas:{mode:'prometheus'}}),hosts:()=>['nas']};
 const probed={nas:[{id:'smb',name:'SMB',status:'reachable',observedAt:new Date().toISOString()}]};
 const plain=buildHome({site:SITE,thermo:{...thermo,status:()=>({}),live:()=>({}),seconds:()=>[],disks:()=>({}),native:()=>({}),hosts:()=>[]},probed});
 const bound=buildHome({site:SITE,thermo,probed,siteTelemetry:[{id:'nas',provider:'prometheus',platform:'linux',configuredAt:'2026-11-11T00:00:00Z'}]});
 const a=plain.machines.find(m=>m.id==='nas'),b=bound.machines.find(m=>m.id==='nas');
 assert.deepEqual([a.kind,a.role,a.services.map(s=>s.id),a.telemetry.state,a.platform],['nas','nas',['smb'],'not-installed',null]);
 assert.deepEqual([b.kind,b.role,b.source,b.readOnly,b.services.map(s=>s.id),b.telemetry.state,b.telemetry.provider,b.platform,b.online],['thermo','nas','site',true,['smb'],'ok','prometheus','linux','online']);
 assert.ok(b.quad&&b.quad.cpu===12,'gauges');assert.deepEqual(b.volumes.map(v=>v.name),['tank']);assert.deepEqual(b.native.cpu.cores,[10,14]);assert.ok(b.spark);
 assert.equal(b.picture,a.picture,'its picture stays');assert.deepEqual(b.props,a.props,'and its hardware');
 // Thermo site machines and the router: unchanged, and never bound.
 for(const id of ['mini','router'])assert.deepEqual({...bound.machines.find(m=>m.id===id),generatedAt:0},{...plain.machines.find(m=>m.id===id),generatedAt:0});
 // History: a bound site machine has a source; an unbound one says so plainly.
 assert.deepEqual(homeHistoryQuery({machine:'nas',range:'30m'},[],SITE,[{id:'nas',provider:'prometheus'}]),{machine:'nas',range:'30m'});
 assert.equal(homeHistoryQuery({machine:'nas',range:'30m'},[],SITE).reason,'Stroj nemá připojenou telemetrii.');
 assert.equal(homeHistoryQuery({machine:'nas',range:'30m'},[],SITE,[{id:'ghost',provider:'prometheus'}]).reason,'Stroj nemá připojenou telemetrii.');
});
