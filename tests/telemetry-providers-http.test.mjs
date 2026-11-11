// The new agent-less providers over HTTP and in the device store: WinRM, Node Exporter, Prometheus and Linux SSH,
// each set up in a server-side draft and saved only after a fresh test of exactly what the form shows; switching
// between providers in place (id and history kept, the old secrets gone); passwords and tokens one-way (never in a
// reply, devices.json, machine_list); agents and API keys reach none of it. Every endpoint and tool is faked.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir,stat} from 'node:fs/promises';
import {generateKeyPairSync} from 'node:crypto';
import path from 'node:path';
import {readStore} from './support/sealed.mjs';
import {hub} from './hub-helper.mjs';
import {exposition} from './fixtures/node-exporter.mjs';
import {ENDPOINT_SETUP_ERRORS} from '../server/endpoint-setup.mjs';
import {PROMETHEUS_ERRORS} from '../server/prometheus-telemetry.mjs';
import {hubAddress} from '../server/site-config.mjs';

const u32=n=>{const b=Buffer.alloc(4);b.writeUInt32BE(n);return b;},str=b=>Buffer.concat([u32(b.length),Buffer.from(b)]);
const hostKey=Buffer.concat([str('ssh-ed25519'),str(Buffer.from(generateKeyPairSync('ed25519').publicKey.export({format:'jwk'}).x,'base64url'))]).toString('base64');
const PIN='c'.repeat(64);
function fakePoller(){
 const configs=new Map(),added=[],removed=[];
 return {added,removed,addHost:c=>{added.push(c);configs.set(c.id,c);},removeHost:id=>{removed.push(id);configs.delete(id);},start:async()=>{},stop:()=>{},
  status:()=>({}),live:()=>({}),seconds:()=>[],minutes:()=>[],disks:()=>({}),native:()=>({}),hosts:()=>[...configs.keys()],targets:()=>Object.fromEntries([...configs].map(([id,c])=>[id,c.target])),
  connections:()=>Object.fromEntries([...configs].map(([id,c])=>[id,{mode:c.provider||'x',host:c.record?.host}])),interval:()=>({intervalSeconds:30,lastPollAt:null}),setIntervalMs:()=>30000,refresh:async()=>false,pause:async()=>{},resume:async()=>{}};
}
const now=()=>Math.floor(Date.now()/1000);
const promReplies=()=>({node_uname_info:{resultType:'vector',result:[{metric:{__name__:'node_uname_info',job:'nas-node',instance:'nas',nodename:'n'},value:[now(),'1']}]},
 up:{resultType:'vector',result:[{metric:{__name__:'up',job:'nas-node',instance:'nas'},value:[now(),'1']},{metric:{__name__:'up',job:'prometheus',instance:'localhost:9090'},value:[now(),'1']}]},
 'timestamp(up)':{resultType:'vector',result:[{metric:{job:'nas-node',instance:'nas'},value:[now(),String(now()-5)]}]}});
function promMatrix(){const t=now()-3,S=(name,labels,v)=>({metric:{__name__:name,job:'nas-node',instance:'nas',...labels},values:[[t-15,String(v)],[t,String(v)]]});
 return {resultType:'matrix',result:[S('up',{},1),S('node_uname_info',{nodename:'n'},1),S('node_cpu_seconds_total',{cpu:'0',mode:'idle'},5),S('node_memory_MemTotal_bytes',{},8e9),S('node_memory_MemAvailable_bytes',{},4e9)]};}
const LINUX_OUT=['HHLNX1','@t',String(now()),'@uptime','100.0 1','@stat','cpu  1 0 1 10 0 0 0 0 0 0','cpu0 1 0 1 10 0 0 0 0 0 0','@mem','MemTotal: 1000 kB','MemAvailable: 500 kB','@load','0 0 0 1/1 1','@disk','@net','@mounts','@df','@os','@cpuinfo','@hwmon','@end'].join('\n');

async function setup(t){
 const requests=[],pollers={winrm:fakePoller(),'node-exporter':fakePoller(),prometheus:fakePoller(),'linux-ssh':fakePoller()};
 const endpointRequest=async o=>{requests.push(o);
  if(o.path==='/metrics')return {status:200,headers:{'content-type':'text/plain; version=0.0.4'},body:Buffer.from(exposition({at:now()}))};
  if(o.path==='/api/v1/query'){const q=o.query.query;const d=promReplies()[q]||(q.startsWith('{__name__=~')?promMatrix():null);
   return {status:200,headers:{'content-type':'application/json'},body:Buffer.from(JSON.stringify({status:'success',data:d}))};}
  if(o.path==='/wsman')throw Object.assign(new Error('http'),{status:401,headers:{'www-authenticate':'Basic'},body:Buffer.alloc(0)});
  throw new Error('unreachable');};
 const probeCertificate=async({host})=>({fingerprint:PIN,subject:host,issuer:host,altNames:[],validFrom:'',validTo:'Jan 1 2099',selfSigned:true,caVerified:false,hostnameOk:true,caError:'DEPTH_ZERO_SELF_SIGNED_CERT'});
 const sshRun=async(args,{binary='ssh'}={})=>{
  if(binary==='ssh'&&args[0]==='-V')return {code:0,stdout:'',stderr:'OpenSSH_9.6p1',error:null};
  if(binary==='ssh-keyscan')return args.length?{code:0,stdout:`${args.at(-1)} ssh-ed25519 ${hostKey}\n`,stderr:'',error:null}:{code:1,stdout:'',stderr:'usage',error:null};
  if(binary==='ssh'&&args[0]==='-F')return {code:0,stdout:LINUX_OUT,stderr:'',error:null};
  return {code:null,stdout:'',stderr:'',error:'spawn'};};
 const h=await hub(t,{feedPollers:pollers,endpointRequest,probeCertificate,sshRun,windowsPoller:fakePoller()});
 const call=async(url,body,headers=h.admin)=>{const r=await h.post(url,body,headers);return {status:r.status,body:await r.json().catch(()=>({}))};};
 const home=async()=>(await fetch(`${h.origin}/api/home`,{headers:h.admin})).json();
 return {h,call,home,pollers,requests};
}

test('Node Exporter: tested plain-HTTP connection saved for a new Linux device; credentials never over HTTP; a stale form never saves',async t=>{
 const {h,call,home,pollers,requests}=await setup(t);
 const d=(await call('/api/home/devices/endpoint/draft',{provider:'node-exporter'})).body.draft;
 assert.deepEqual([d.provider,d.port,d.scheme,d.password],['node-exporter',9100,'http',{set:false,reused:false}]);
 const creds=await call('/api/home/devices/endpoint/draft/test',{draft:d.id,host:'10.0.0.21',port:9100,scheme:'http',user:'u',password:'secret-pass'});
 assert.deepEqual([creds.status,creds.body.error.reason],[422,'plain-credentials']);assert.equal(creds.body.error.message,ENDPOINT_SETUP_ERRORS['plain-credentials'][1]);
 assert.equal(requests.length,0,'nothing was sent');
 const ok=await call('/api/home/devices/endpoint/draft/test',{draft:d.id,host:'10.0.0.21',port:9100,scheme:'http'});
 assert.equal(ok.status,200,JSON.stringify(ok.body));assert.equal(ok.body.result.cpu.logical,2);assert.equal(requests.at(-1).path,'/metrics');assert.equal(requests.at(-1).trust,null);
 const stale=await call('/api/home/devices',{name:'Box',kind:'node-exporter',hostname:'box.example.lan',telemetry:{provider:'node-exporter',draft:d.id,host:'10.0.0.22',port:9100,scheme:'http'}});
 assert.deepEqual([stale.status,stale.body.error.reason],[409,'stale']);
 const saved=await call('/api/home/devices',{name:'Box',kind:'node-exporter',hostname:'box.example.lan',telemetry:{provider:'node-exporter',draft:d.id,host:'10.0.0.21',port:9100,scheme:'http'}});
 assert.equal(saved.status,201,JSON.stringify(saved.body));assert.equal(saved.body.platform,'linux');assert.equal(saved.body.telemetryProvider,'node-exporter');
 assert.equal(pollers['node-exporter'].added.at(-1).record.host,'10.0.0.21');
 assert.equal((await call('/api/home/devices',{name:'Box 2',kind:'node-exporter',hostname:'box2.example.lan',telemetry:{provider:'node-exporter',draft:d.id,host:'10.0.0.21',port:9100,scheme:'http'}})).body.error.reason,'draft-missing','a draft saves once');
 const file=path.join(h.dir,'home','telemetry-hosts.json');
 if(process.platform!=='win32')assert.equal((await stat(file)).mode&0o777,0o600);
 const tile=(await home()).machines.find(m=>m.id==='box');assert.equal(tile.telemetry.provider,'node-exporter');assert.equal(tile.kind,'thermo');
 const list=await (await fetch(`${h.origin}/api/home/machines`,{headers:h.admin})).json();assert.ok(!JSON.stringify(list).includes('10.0.0.21'),'machine_list carries no connection');
 const forged=await call('/api/home/devices',{name:'Forged',kind:'node-exporter',hostname:'f.example.lan',telemetry:{provider:'node-exporter',draft:'e'+'0'.repeat(32),host:'10.0.0.9',port:9100,scheme:'http'}});
 assert.equal(forged.body.error.reason,'draft-missing');
 const noDraft=await call('/api/home/devices',{name:'Raw',kind:'node-exporter',hostname:'r.example.lan'});assert.equal(noDraft.status,400,'never without a tested draft');
});

test('HTTPS endpoints: certificate first, pin approved, password one-way; WinRM refuses CA trust it could not verify',async t=>{
 const {h,call,home,pollers,requests}=await setup(t);
 const add=await call('/api/home/machines',{machine:{id:'pc',name:'PC',hostname:'pc.example.lan',platform:'windows'}});assert.equal(add.status,201);
 const d=(await call('/api/home/devices/endpoint/draft',{provider:'winrm',id:'pc'})).body.draft;
 const early=await call('/api/home/devices/endpoint/draft/test',{draft:d.id,host:'pc.example.lan',port:5986,user:'homehub',password:'correct horse 1'});
 assert.equal(early.body.error.reason,'needs-probe');assert.equal(requests.length,0,'no password before the certificate is trusted');
 assert.equal((await call('/api/home/devices/endpoint/draft/probe',{draft:d.id,host:'pc.example.lan',port:5986})).body.draft.certificate.fingerprint,PIN);
 assert.equal((await call('/api/home/devices/endpoint/draft/trust',{draft:d.id,mode:'ca'})).body.error.reason,'ca-unverified');
 assert.equal((await call('/api/home/devices/endpoint/draft/trust',{draft:d.id,mode:'pin',fingerprint:'d'.repeat(64)})).body.error.reason,'trust-mismatch');
 const tr=await call('/api/home/devices/endpoint/draft/trust',{draft:d.id,mode:'pin',fingerprint:PIN.match(/../g).join(':').toUpperCase()});assert.equal(tr.body.draft.trust.mode,'pin');
 const denied=await call('/api/home/devices/endpoint/draft/test',{draft:d.id,host:'pc.example.lan',port:5986,user:'homehub',password:'correct horse 1'});
 assert.deepEqual([denied.status,denied.body.error.code,denied.body.error.provider,denied.body.error.reason],[422,'TELEMETRY_FAILED','winrm','denied']);
 assert.deepEqual(requests.at(-1).trust,{mode:'pin',pin:PIN});assert.match(requests.at(-1).headers.Authorization,/^Basic /);
 assert.ok(!JSON.stringify(denied.body).includes('correct horse'),'the password is never echoed');
 assert.equal((await call('/api/home/devices/telemetry',{id:'pc',telemetry:{provider:'winrm',draft:d.id,host:'pc.example.lan',port:5986,user:'homehub'}})).body.error.reason,'needs-test');
 // Node Exporter with Basic over a pinned certificate.
 const n=(await call('/api/home/devices/endpoint/draft',{provider:'node-exporter'})).body.draft;
 await call('/api/home/devices/endpoint/draft/probe',{draft:n.id,host:'10.0.0.23',port:9100});await call('/api/home/devices/endpoint/draft/trust',{draft:n.id,mode:'pin',fingerprint:PIN});
 const tested=await call('/api/home/devices/endpoint/draft/test',{draft:n.id,host:'10.0.0.23',port:9100,scheme:'https',user:'homehub',password:'exporter-pass'});
 assert.equal(tested.status,200,JSON.stringify(tested.body));assert.deepEqual(tested.body.draft.password,{set:true,reused:false});
 const saved=await call('/api/home/devices',{name:'Tls box',kind:'node-exporter',hostname:'tls.example.lan',telemetry:{provider:'node-exporter',draft:n.id,host:'10.0.0.23',port:9100,scheme:'https',user:'homehub'}});
 assert.equal(saved.status,201,JSON.stringify(saved.body));
 const stored=await readFile(path.join(h.dir,'home','telemetry-hosts.json'),'utf8');assert.doesNotMatch(stored,/exporter-pass/,'sealed: no password on disk');assert.match(JSON.stringify(await readStore(path.join(h.dir,'home','telemetry-hosts.json'))),/exporter-pass/,'the password lives in the sealed store');
 const devicesFile=await readFile(path.join(h.dir,'home','devices.json'),'utf8');assert.doesNotMatch(devicesFile,/exporter-pass|10\.0\.0\.23/);
 const h2=await home();assert.doesNotMatch(JSON.stringify(h2),/exporter-pass/);
 // Editing reuses the stored password server-side without ever sending it back.
 const again=(await call('/api/home/devices/endpoint/draft',{provider:'node-exporter',id:'tls-box'})).body.draft;
 assert.deepEqual([again.password,again.trust.mode,again.user],[{set:true,reused:true},'pin','homehub']);assert.doesNotMatch(JSON.stringify(again),/exporter-pass/);
 assert.equal(pollers['node-exporter'].added.at(-1).record.password,'exporter-pass');
});

test('Prometheus: targets from Prometheus only, exact job+instance, switch providers in place, disconnect removes the secret',async t=>{
 const {h,call,pollers,requests}=await setup(t);
 await call('/api/home/machines',{machine:{id:'storage',name:'Storage',hostname:'storage.example.lan',role:'nas'}});
 const d=(await call('/api/home/devices/endpoint/draft',{provider:'prometheus',id:'storage'})).body.draft;assert.equal(d.port,9090);
 const early=await call('/api/home/devices/endpoint/draft/test',{draft:d.id,host:'10.0.0.40',port:9090,scheme:'http',auth:'none',job:'nas-node',instance:'nas'});
 assert.equal(early.body.error.reason,'needs-targets');
 const found=await call('/api/home/devices/endpoint/draft/discover',{draft:d.id,host:'10.0.0.40',port:9090,scheme:'http',auth:'none'});
 assert.equal(found.status,200,JSON.stringify(found.body));assert.deepEqual(found.body.targets.map(x=>[x.job,x.instance,x.eligible]),[['nas-node','nas',true]],'Prometheus itself is not a target');
 assert.ok(requests.every(o=>o.path==='/api/v1/query'),'the API only, never /metrics of Prometheus');
 const forged=await call('/api/home/devices/endpoint/draft/test',{draft:d.id,host:'10.0.0.40',port:9090,scheme:'http',auth:'none',job:'prometheus',instance:'localhost:9090'});
 assert.equal(forged.body.error.reason,'target-unknown','only a target Prometheus offered');
 const bad=await call('/api/home/devices/endpoint/draft/test',{draft:d.id,host:'10.0.0.40',port:9090,scheme:'http',auth:'bearer',password:'t'.repeat(20),job:'nas-node',instance:'nas'});
 assert.equal(bad.body.error.reason,'plain-credentials');
 const ok=await call('/api/home/devices/endpoint/draft/test',{draft:d.id,host:'10.0.0.40',port:9090,scheme:'http',auth:'none',job:'nas-node',instance:'nas'});
 assert.equal(ok.status,200,JSON.stringify(ok.body));assert.equal(ok.body.result.job,'nas-node');assert.match(requests.at(-1).query.query,/job="nas-node",instance="nas"\}\[120s\]$/);
 const saved=await call('/api/home/devices/telemetry',{id:'storage',telemetry:{provider:'prometheus',draft:d.id,host:'10.0.0.40',port:9090,scheme:'http',auth:'none',job:'nas-node',instance:'nas'}});
 assert.equal(saved.status,200,JSON.stringify(saved.body));assert.deepEqual([saved.body.platform,saved.body.telemetryProvider,saved.body.id],['linux','prometheus','storage']);
 assert.equal(pollers.prometheus.added.at(-1).record.instance,'nas');
 // MCP/API: the platform stays Linux while it is connected.
 const list=await (await fetch(`${h.origin}/api/home/machines`,{headers:h.admin})).json();const m=list.machines.find(x=>x.id==='storage');
 const up=await call('/api/home/machines',{machine:{...Object.fromEntries(Object.entries(m).filter(([k])=>['id','name','hostname','ip','role','hardware','thermoId','picture'].includes(k))),platform:'windows'},base:m.hash});
 assert.equal(up.status,400);assert.match(JSON.stringify(up.body),/must stay linux/);
 // Switch deliberately to Node Exporter: the device keeps its id; the Prometheus poller forgets it.
 const n=(await call('/api/home/devices/endpoint/draft',{provider:'node-exporter',id:'storage'})).body.draft;
 await call('/api/home/devices/endpoint/draft/test',{draft:n.id,host:'10.0.0.40',port:9100,scheme:'http'});
 const sw=await call('/api/home/devices/telemetry',{id:'storage',telemetry:{provider:'node-exporter',draft:n.id,host:'10.0.0.40',port:9100,scheme:'http'}});
 assert.equal(sw.status,200,JSON.stringify(sw.body));assert.equal(sw.body.telemetryProvider,'node-exporter');assert.deepEqual(pollers.prometheus.removed,['storage']);
 const hosts=(await readStore(path.join(h.dir,'home','telemetry-hosts.json'))).hosts;assert.deepEqual(hosts.map(x=>[x.id,x.provider]),[['storage','node-exporter']]);
 const off=await call('/api/home/devices/telemetry',{id:'storage',telemetry:null});assert.equal(off.status,200);assert.equal(off.body.telemetryProvider,null);
 assert.deepEqual((await readStore(path.join(h.dir,'home','telemetry-hosts.json'))).hosts,[]);assert.deepEqual(pollers['node-exporter'].removed,['storage']);
 // No Node Exporter targets at all: the guide, never a fake success.
 const msg=PROMETHEUS_ERRORS['no-targets'];assert.match(msg,/scrape_configs/);
});

test('Linux SSH: the app-managed key workflow for os linux; removing the device deletes its key; sessions only',async t=>{
 const {h,call,pollers}=await setup(t);
 assert.equal((await call('/api/home/devices/ssh/draft',{})).status,400,'os linux is required');
 const d=(await call('/api/home/devices/ssh/draft',{os:'linux'})).body.draft;assert.equal(d.os,'linux');
 const k=await call('/api/home/devices/ssh/draft/key',{draft:d.id,generate:true});assert.equal(k.status,200);
 const s=await call('/api/home/devices/ssh/draft/scan',{draft:d.id,host:'10.0.0.50',port:22});
 await call('/api/home/devices/ssh/draft/trust',{draft:d.id,fingerprint:s.body.draft.hostKeys[0].fingerprint});
 assert.equal((await call('/api/home/devices/windows/draft/test',{draft:d.id,host:'10.0.0.50',port:22,user:'homehub'})).body.error.reason,'draft-missing','a Linux draft is not a Windows one');
 const bad=await call('/api/home/devices/ssh/draft/test',{draft:d.id,host:'10.0.0.50',port:22,user:'DOMAIN\\x'});assert.equal(bad.status,400,'the POSIX user rule');
 const r=await call('/api/home/devices/ssh/draft/test',{draft:d.id,host:'10.0.0.50',port:22,user:'homehub'});assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.result.memTotal,1000*1024);
 const saved=await call('/api/home/devices',{name:'Pi',kind:'linux-ssh',hostname:'pi.example.lan',telemetry:{provider:'linux-ssh',draft:d.id,host:'10.0.0.50',port:22,user:'homehub'}});
 assert.equal(saved.status,201,JSON.stringify(saved.body));assert.equal(pollers['linux-ssh'].added.at(-1).record.os,'linux');
 const keys=path.join(h.dir,'home','ssh','keys');assert.equal((await readdir(keys)).length,1);
 const key=await h.account('agent',['read','home:write']);
 assert.equal((await call('/api/home/devices/ssh/draft',{os:'linux'},key.headers)).status,403,'API keys never');
 assert.equal((await call('/api/home/devices/telemetry',{id:'pi',telemetry:null},key.headers)).status,403);
 assert.equal((await call('/api/home/devices/endpoint/draft',{provider:'prometheus'},key.headers)).status,403);
 const own=await fetch(`${h.origin}/api/home/devices/hub-address`,{headers:h.admin});assert.equal(own.status,200);
 assert.deepEqual(await own.json(),{address:hubAddress(['10.0.0.0/24'])},'the hub\'s own address in the site networks, or null');
 assert.equal((await fetch(`${h.origin}/api/home/devices/hub-address`,{headers:key.headers})).status,403,'API keys never');
 const list=await (await fetch(`${h.origin}/api/home/machines`,{headers:h.admin})).json();
 const gone=await call('/api/home/machines/remove',{id:'pi',base:list.machines.find(m=>m.id==='pi').hash});assert.equal(gone.status,200);
 await new Promise(r=>setTimeout(r,50));
 assert.deepEqual(await readdir(keys),[],'the key of a removed device goes');assert.deepEqual(pollers['linux-ssh'].removed,['pi']);
});
