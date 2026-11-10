import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {buildHome as build,homeHistory as history,homeHistoryQuery as historyQuery,mergeStack as merge,stackLayouts} from '../server/home-data.mjs';
import {SITE} from './hub-helper.mjs';
// The machines come from the site configuration; these tests run on the generic fixture site.
const STACKS=stackLayouts(SITE);
const buildHome=input=>build({site:SITE,...input});
const mergeStack=(machine,services=[])=>merge(machine,services,STACKS[machine]);
const homeHistory=(thermo,machine,range,now)=>history(thermo,machine,range,now,['mini','studio','mini_server']);
const homeHistoryQuery=input=>historyQuery(input,[],SITE);
import {createHandler} from '../server/index.mjs';
import {hashPassword} from '../server/auth.mjs';

const nowSec=Math.floor(Date.now()/1000),nowMs=nowSec*1000;
const thermoStub=(overrides={})=>({
 status:()=>({mini:{state:'up'},studio:{state:'up'},mini_server:{state:'down'}}),
 live:()=>({mini:{at:nowMs,reading:{t:nowSec,cpu:30,cpuMax:44,gpu:10,power:24,cpuTemp:52}}}),
 seconds:(host,since)=>host==='mini'?[...Array(120)].map((_,i)=>({t:nowSec-119+i,cpu:30+(i%10),cpuMax:40,gpu:5,power:22,cpuTemp:50})).filter(r=>!since||r.t>=since):[],
 minutes:host=>host==='mini'?[...Array(720)].map((_,i)=>({t:nowSec-720*60+i*60,cpu:20+(i%7),cpuMax:40,gpu:5,gpuMax:9,power:25,powerMax:35,cpuTemp:50,cpuTempMax:58})):[],
 disks:()=>({mini:{observedAt:nowMs,disks:[{name:'Macintosh HD',mount:'/',fs:'apfs',total:3.996e12,free:5.39e11,used:3.457e12}]}}),
 ...overrides});
const snapshot=services=>({collectedAt:new Date(nowMs).toISOString(),memory:{usedBytes:34e9,totalBytes:68e9},uptimeSeconds:86400,services});

test('home tiles merge thermo quad, bridge services and router',()=>{
 const home=buildHome({snapshots:{mini:{bridge:'connected',snapshot:snapshot([{id:'llama-swap',name:'llama-swap',status:'reachable',url:'http://127.0.0.1:8081',models:[{id:'gemma-4-26B-A4B-it-OptiQ-4bit',state:'loaded'}]}])}},thermo:thermoStub(),
  router:{status:'ok',freshness:'fresh',observedAt:new Date(nowMs).toISOString(),model:'UniFi Dream Router 7',firmware:'4.2.7',devices:[{presence:'associated'},{presence:'reachable'}]},now:nowMs});
 const mini=home.machines.find(m=>m.id==='mini'),studio=home.machines.find(m=>m.id==='studio'),router=home.machines.find(m=>m.id==='router');
 assert.equal(mini.online,'online');
 // quad = mean of the last 15 one-second readings (i=105..119 → cpu 30+(i%10))
 assert.ok(Math.abs(mini.quad.cpu-(30+80/15))<1e-9);assert.equal(mini.quad.windowSeconds,15);assert.equal(mini.quad.samples,15);
 assert.equal(mini.services[0].models[0],'gemma-4-26B-A4B-it-OptiQ-4bit');
 assert.equal(mini.volumes[0].sizeBytes,3.996e12);
 assert.ok(mini.volumes[0].usedBytes>0);
 assert.equal(studio.online,'online','thermo up with fresh seconds ⇒ online');
 assert.equal(router.online,'online');
 assert.equal(home.router.clients,2);
 assert.equal(home.machines.find(m=>m.id==='mini_server').online,'offline');
});
test('stale minute rows fall back to live sample',()=>{
 const home=buildHome({snapshots:{},thermo:thermoStub({seconds:()=>[],minutes:()=>[],live:()=>({mini:{at:nowMs,reading:{t:nowSec,cpu:33,cpuMax:44,gpu:12,power:24,cpuTemp:52}}})}),now:nowMs});
 assert.equal(home.machines.find(m=>m.id==='mini').quad.cpu,33);
});
test('runtimes stack: live service marks blocks on, offline marks dashed off',async()=>{
 const services=[{id:'llama-swap',status:'reachable',url:'http://127.0.0.1:8081',models:[{id:'gemma-4-26B-A4B-it-OptiQ-4bit',state:'loaded',sizeBytes:15e9}],stats:{requests:9,uptimeSeconds:3600},pool:null}];
 const mini=mergeStack('mini',services);
 const lswap=mini.blocks.find(b=>b.id==='lswap');
 assert.equal(lswap.state,'on');assert.equal(lswap.port,':8081 · živě');
 // The same label as parts, so the English UI does not show the Czech word (server/text.mjs).
 assert.deepEqual(lswap.portT,[{key:':{port} · živě',params:{port:'8081'}}]);assert.equal(lswap.descT,undefined);
 assert.equal(lswap.models[0].path,'~/models/gemma-4-26B-A4B-it-OptiQ-4bit');
 const omlx=mini.blocks.find(b=>b.id==='omlx');
 assert.equal(omlx.state,'off');assert.deepEqual(omlx.models,[]);assert.match(omlx.desc,/nedosaditelná/);
 assert.deepEqual(omlx.descT.map(p=>p.key),[omlx.desc.replace(' — služba teď nedosaditelná.',''),'— služba teď nedosaditelná.']);
 const {say,setLang}=await import('../public/i18n.js');setLang('en');
 assert.equal(say(lswap.port,lswap.portT),':8081 · live');assert.match(say(omlx.desc,omlx.descT),/— the service cannot be reached right now\.$/);
 setLang('cs');assert.equal(say(lswap.port,lswap.portT),lswap.port);assert.equal(say('Přehled'),'Přehled');
 const studio=mergeStack('studio',[]);
 assert.equal(studio.blocks.find(b=>b.id==='lserver').state,'off');// static capability stays dashed
 assert.equal(studio.blocks.find(b=>b.id==='lserver').models.length,0);
 assert.equal(studio.blocks.find(b=>b.id==='lswap').state,'off');
 assert.equal(mergeStack('nas').blocks.length,3);
});
test('history buckets 30m from seconds and 7d from minutes; 6m reports partial',()=>{
 const thermo=thermoStub();
 const m30=homeHistory(thermo,'mini','30m',nowSec);
 assert.equal(m30.points.length,60);assert.equal(m30.complete,true);
 assert.ok(m30.points.at(-1).cpu>0);
 assert.ok(m30.points[10].cpu>0,'older 30m buckets are filled from minute rows after a restart');
 assert.equal(m30.points.filter(p=>p.cpu==null).length,0,'no alternating gaps from minute fill');
 const d7=homeHistory(thermo,'mini','7d',nowSec);
 assert.equal(d7.points.length,168);assert.equal(d7.complete,false,'12 h of minute rows is not a full week');
 assert.ok(Math.abs(d7.coverageSeconds-720*60)<=60);
 const week=thermoStub({minutes:()=>[...Array(8*24)].map((_,i)=>({t:nowSec-8*86400+i*3600,cpu:20}))});
 assert.equal(homeHistory(week,'mini','7d',nowSec).complete,true);
 const m6=homeHistory(thermo,'mini','6m',nowSec);
 assert.equal(m6.complete,false);assert.equal(m6.points.length,180);
 assert.equal(homeHistoryQuery({machine:'mini',range:'30m'}).range,'30m');
 assert.deepEqual(homeHistoryQuery({machine:'nas',range:'7d'}),{machine:'nas',range:'7d',points:[],complete:false,source:'žádný zdroj',reason:'Thermo nesahá na NAS/router'});
});
test('invalid input fails closed',()=>{
 assert.throws(()=>homeHistory(thermoStub(),'router','30m'),/invalid/);
 assert.throws(()=>homeHistoryQuery({machine:'bogus',range:'30m'}),/invalid/);
 assert.throws(()=>homeHistoryQuery({machine:'mini',range:'5m'}),/invalid/);
});
test('home routes require login and serve tiles and history',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'hubhome-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const origin='http://127.0.0.1:0';
 const server=http.createServer();
 const thermo={status:()=>({}),live:()=>({}),seconds:()=>[],minutes:()=>[],disks:()=>({})};
 const poller={latest:()=>({}),start:async()=>{},stop(){},poll:async()=>{}};
 server.on('request',createHandler({directory:dir,stateDirectory:dir,credentials:{username:'admin',...hashPassword('test-password')},origin,secure:false,bridgeRequest:async()=>{throw new Error('unavailable');},studioSocket:'',miniServerSocket:'',computeStore:{saveLatest:async()=>{},loadLatest:async()=>null,getCursor:async()=>0,setCursor:async()=>{},ingest:async()=>0,readRecords:async()=>[]},poller,thermoPoller:thermo}));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${server.address().port}`;
 assert.equal((await fetch(base+'/api/home')).status,401);
 assert.equal((await fetch(base+'/api/home/history?machine=mini&range=30m')).status,401);
 const login=await fetch(base+'/api/session',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'test-password'})});
 const cookie=login.headers.get('set-cookie').split(';')[0];
 const home=await (await fetch(base+'/api/home',{headers:{Cookie:cookie}})).json();
 assert.equal(home.machines.length,5);
 assert.ok(home.machines.every(m=>['mini','studio','mini_server','nas','router'].includes(m.id)));
 assert.ok(home.machines.every(m=>m.props&&'online'in m&&'stack'in m));
 const hist=await (await fetch(base+'/api/home/history?machine=mini&range=30m',{headers:{Cookie:cookie}})).json();
 assert.equal(hist.machine,'mini');assert.equal(hist.points.length,60);
 assert.equal((await fetch(base+'/api/home/history?machine=mini&range=bogus',{headers:{Cookie:cookie}})).status,400);
 const nas=await (await fetch(base+'/api/home/history?machine=nas&range=7d',{headers:{Cookie:cookie}})).json();
 assert.equal(nas.reason,'Thermo nesahá na NAS/router');
 await new Promise(r=>server.close(r));
});
test('collected machine descriptors replace static tiles and stacks; router falls back to census',()=>{
 const descriptors={
  studio:{schemaVersion:1,id:'studio',name:'Mac Studio',hostname:'studio.example.lan',collectedAt:'2026-11-07T21:00:00Z',
   addresses:[{ip:'10.0.0.151',mac:'aa:bb:cc:dd:ee:ff'}],hardware:{cpu:'Apple M5 Ultra',cpuCores:{performance:12,efficiency:24,total:36,labels:'12 Super + 24 Performance'},gpuCores:80,ramGb:256,disks:[{mount:'/',totalBytes:4e12}]},
   stack:{layers:['RUNTIME','HARDWARE'],cols:['mlx'],engines:{mlx:'Apple MLX'},blocks:[
    {id:'omlx',layer:0,col0:0,col1:0,title:'oMLX',service:'omlx',state:'on'},{id:'bad',layer:9,col0:0,col1:0,title:'x'},{id:'hw',layer:1,col0:0,col1:0,title:'M5 Ultra'}]},
   reviewNeeded:['GPU has 80 cores']},
  router:{schemaVersion:1,id:'router',name:'Gateway',hostname:'gateway.example.lan',collectedAt:'2026-11-07T21:05:00Z',addresses:[{ip:'10.0.0.1'}],hardware:{cpu:'Qualcomm IPQ5322 (quad-core)',cpuCores:{total:4},ramGb:3},
   clients:[{connection:'wired'},{connection:'wifi'},{connection:'wifi'}]},
  mini:{schemaVersion:2,id:'mini'}};
 const home=buildHome({thermo:thermoStub(),descriptors,now:nowMs});
 const studio=home.machines.find(m=>m.id==='studio');
 assert.equal(studio.props.gpu,'80c');assert.equal(studio.props.cpu,'36j (12S+24P) M5 Ultra');
 assert.equal(studio.stack.source,'collected');assert.deepEqual(studio.stack.blocks.map(b=>b.id),['omlx','hw'],'invalid block dropped');
 assert.equal(studio.stack.blocks[0].state,'on','collected state kept when the bridge does not report the service');
 assert.deepEqual(studio.reviewNeeded,['GPU has 80 cores']);
 const router=home.machines.find(m=>m.id==='router');
 assert.equal(router.online,'stale');assert.equal(router.quad.clients,3);assert.equal(router.quad.wifi,2);assert.equal(router.props.cpu,'4j Qualcomm IPQ5322');
 const mini=home.machines.find(m=>m.id==='mini');
 assert.equal(mini.props.gpu,'20c','unknown schema version keeps static definition');
});

test('quad temperature is the hotter of CPU and GPU; minute row is the fallback when no recent seconds',()=>{
 const hot=thermoStub({seconds:host=>host==='mini'?[{t:nowSec-1,cpu:10,gpu:96,power:120,cpuTemp:65,gpuTemp:78,memUsed:1,memTotal:2}]:[]});
 const q=buildHome({thermo:hot,now:nowMs}).machines.find(m=>m.id==='mini').quad;
 assert.equal(q.temp,78);assert.equal(q.gpu,96);assert.equal(q.samples,1);
 const old=thermoStub({seconds:host=>host==='mini'?[{t:nowSec-600,cpu:99}]:[]});
 const f=buildHome({thermo:old,now:nowMs}).machines.find(m=>m.id==='mini').quad;
 assert.equal(f.windowSeconds,60,'stale seconds ⇒ newest minute row');assert.notEqual(f.cpu,99);
});
test('memory quad prefers GPU allocations (model held) and reports pressure 0/1/2 from Thermo build 97+',()=>{
 const t=thermoStub({seconds:host=>host==='mini'?[{t:nowSec-2,cpu:5,gpu:0,memUsed:50e9,memTotal:64e9,gpuMem:3e9,gpuMemAlloc:40e9,memPressure:0},{t:nowSec-1,cpu:5,gpu:0,memUsed:51e9,memTotal:64e9,gpuMem:4e9,gpuMemAlloc:41e9,memPressure:1}]:[]});
 const q=buildHome({thermo:t,now:nowMs}).machines.find(m=>m.id==='mini').quad;
 assert.equal(q.gpuMemAlloc,41e9);assert.equal(q.gpuMem,4e9);assert.equal(q.memPressure,1,'worst level in the window');
 const h=homeHistory(t,'mini','30m',nowSec);const last=h.points.filter(p=>p.gpuMemAlloc!=null).at(-1);
 assert.ok(last.gpuMemAlloc>=40e9&&last.memPressure===1);
});
import {bucketRows} from '../server/home-data.mjs';
test('review fixes: window boundary, raw maxima, chip temperature, range validation',()=>{
 const cfg={stepSeconds:30,buckets:60};
 const pts=bucketRows([{t:10,cpu:5},{t:1800,cpu:7}],cfg,1800);
 assert.equal(pts[0].cpu,5,'reading at t=10 lies inside (0,1800] and is kept');assert.equal(pts.at(-1).cpu,7);assert.equal(pts.at(-1).t,1800);
 const peak=bucketRows([{t:1790,cpu:100},{t:1791,cpu:0}],cfg,1800).at(-1);
 assert.equal(peak.cpu,50);assert.equal(peak.cpuMax,100,'peak survives averaging');
 const hot=bucketRows([{t:1795,cpuTemp:50,gpuTemp:90},{t:1796,gpuTemp:70}],cfg,1800).at(-1);
 assert.equal(hot.temp,80,'hotter-of per reading, GPU-only readings kept');assert.equal(hot.tempMax,90);
 for(const range of ['constructor','toString','__proto__'])assert.throws(()=>homeHistoryQuery({machine:'mini',range}));
});
