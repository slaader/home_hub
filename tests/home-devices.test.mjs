import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,stat} from 'node:fs/promises';
import {Readable} from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import {createHomeDevices,deviceId} from '../server/home-devices.mjs';
import {buildHome as build,validHomeOrder,homeOrder} from '../server/home-data.mjs';
import {hub,SITE} from './hub-helper.mjs';
const HOME_MACHINE_IDS=SITE.machines.map(m=>m.id),buildHome=input=>build({site:SITE,...input});

const PIN='ab'.repeat(32),JPEG=Buffer.from([0xff,0xd8,0xff,0xe0,1,2,3,4]);
const thermo={kind:'thermo',thermo:{port:49286,username:'homehub',password:'correct horse battery',pin:PIN}};
async function store(t){const dir=await mkdtemp(path.join(os.tmpdir(),'home-devices-'));t.after(()=>rm(dir,{recursive:true,force:true}));return {dir,d:createHomeDevices(dir,{reserved:HOME_MACHINE_IDS})};}

test('home devices: ids, validation, secrets kept apart, picture, removal',async t=>{
 const {dir,d}=await store(t);
 assert.equal(deviceId('Mac Studio (obývák)',[]),'mac-studio-obyvak');assert.equal(deviceId('mini',['mini']),'mini-2');assert.equal(deviceId('42',[]),'device');
 const a=await d.add({name:'Mac Studio 2',hostname:'studio2.example.lan',ip:'10.0.0.30',props:{cpu:'M4 Max',gpu:'40c',ramGb:128},...thermo},'admin');
 assert.equal(a.device.id,'mac-studio-2');assert.equal(a.thermo.pin,PIN);assert.equal(a.thermo.host,'studio2.example.lan');
 assert.equal(JSON.stringify(await d.list()).includes('correct horse'),false,'no password in the tile list');
 const secrets=path.join(dir,'thermo-hosts.json');assert.equal((await stat(secrets)).mode&0o777,0o600);assert.ok((await readFile(secrets,'utf8')).includes('correct horse'));
 assert.equal((await d.thermoHosts())[0].id,'mac-studio-2');
 // Validation: bad host, short password, missing pin, thermo fields on "other", duplicate hostname, unknown keys.
 for(const bad of [{name:'x',kind:'other',hostname:'bad host'},{name:'x',kind:'other',hostname:'a.b',ip:'300.1.1.1'},{name:'x',hostname:'a.b',...thermo,thermo:{...thermo.thermo,password:'short'}},
  {name:'x',hostname:'a.b',...thermo,thermo:{...thermo.thermo,pin:'nope'}},{name:'x',kind:'other',hostname:'a.b',thermo:thermo.thermo},{name:'x',kind:'other',hostname:'a.b',extra:1},{name:'',kind:'other',hostname:'a.b'}])
  assert.throws(()=>d.add(bad,'a'),/invalid/,JSON.stringify(bad));
 await assert.rejects(d.add({name:'Again',kind:'other',hostname:'STUDIO2.example.lan'},'a'),/conflict/);
 const p=await d.add({name:'Printer',kind:'other',hostname:'10.0.0.40'},'a');assert.equal(p.thermo,null);
 // Picture: JPEG only, at most 3 MiB, the device must exist.
 await assert.rejects(d.putImage('printer',Readable.from([Buffer.from('GIF89a')])),/invalid/);
 await assert.rejects(d.putImage('nope',Readable.from([JPEG])),/not-found/);
 await assert.rejects(d.putImage('printer',Readable.from([Buffer.alloc(3*1024*1024+1)])),/too-large/);
 assert.equal((await d.putImage('printer',Readable.from([JPEG]))).image,true);assert.ok((await d.image('printer')).endsWith('printer.jpg'));
 // The overview shows both; the order accepts their ids.
 const home=buildHome({thermo:{status:()=>({}),seconds:()=>[],minutes:()=>[],live:()=>({}),disks:()=>({})},added:await d.list()});
 const added=home.machines.filter(m=>m.added);assert.deepEqual(added.map(m=>[m.id,m.kind,m.online]),[['mac-studio-2','thermo','offline'],['printer','other','unknown']]);
 assert.match(added[1].image,/^\/images\/home\/printer\.jpg\?v=/);
 const ids=[...HOME_MACHINE_IDS,'mac-studio-2','printer'];assert.deepEqual(validHomeOrder(['printer','mini'],ids),['printer','mini']);assert.throws(()=>validHomeOrder(['printer']),/invalid/);
 assert.deepEqual(homeOrder(['printer'],ids).slice(0,2),['printer','mini']);
 // Removal drops the tile, the Thermo login and the picture.
 await d.remove('mac-studio-2');await d.remove('printer');assert.deepEqual(await d.list(),[]);assert.deepEqual(await d.thermoHosts(),[]);
 await assert.rejects(d.image('printer'),/not-found/);await assert.rejects(d.remove('printer'),/not-found/);
});

test('home devices over HTTP: probe, Thermo login checked before saving, picture, keys refused',async t=>{
 const logins=[],added=[],removed=[];
 const thermoPoller={addHost:c=>added.push(c.id),removeHost:id=>removed.push(id),start:async()=>{},status:()=>({}),seconds:()=>[],minutes:()=>[],live:()=>({}),disks:()=>({}),interval:()=>({intervalSeconds:15,lastPollAt:null})};
 const h=await hub(t,{thermoPoller,probeCert:async({host,port})=>{if(host==='down.local')throw new Error('unreachable');return {fingerprint:PIN,subject:'Thermo',validTo:'2036',port};},
  checkThermo:async c=>{logins.push(c);if(c.password!=='correct horse battery')throw new Error('denied');return 'ok';}});
 const probe=await h.post('/api/home/devices/probe',{host:'studio2.local'},h.admin);assert.equal(probe.status,200);assert.equal((await probe.json()).fingerprint,PIN);
 assert.equal((await h.post('/api/home/devices/probe',{host:'down.local'},h.admin)).status,422);
 assert.equal((await h.post('/api/home/devices/probe',{host:'bad host'},h.admin)).status,400);
 const wrong=await h.post('/api/home/devices',{name:'Studio 2',hostname:'studio2.local',...thermo,thermo:{...thermo.thermo,password:'wrong password!!'}},h.admin);
 assert.equal(wrong.status,422);assert.match((await wrong.json()).error.message,/Thermo/);assert.equal(added.length,0,'nothing saved after a refused login');
 const ok=await h.post('/api/home/devices',{name:'Studio 2',hostname:'studio2.local',...thermo},h.admin);assert.equal(ok.status,201);
 const dev=await ok.json();assert.equal(dev.id,'studio-2');assert.deepEqual(added,['studio-2']);assert.equal(logins.at(-1).pin,PIN);
 assert.equal(JSON.stringify(dev).includes('correct horse'),false);
 // The picture: JPEG with the page's origin; served to signed-in users only.
 const put=(body,type='image/jpeg',headers=h.admin)=>fetch(`${h.origin}/api/home/devices/studio-2/image`,{method:'PUT',headers:{Origin:h.origin,'Content-Type':type,...headers},body});
 assert.equal((await put(Buffer.from('not a jpeg'))).status,400);assert.equal((await put(JPEG,'application/octet-stream')).status,403);
 assert.equal((await put(JPEG)).status,200);
 const img=await fetch(`${h.origin}/images/home/studio-2.jpg`,{headers:h.admin});assert.equal(img.status,200);assert.equal(img.headers.get('content-type'),'image/jpeg');
 assert.equal((await fetch(`${h.origin}/images/home/studio-2.jpg`)).status,401);
 const home=await (await fetch(`${h.origin}/api/home`,{headers:h.admin})).json();assert.ok(home.machines.some(m=>m.id==='studio-2'&&m.added&&m.kind==='thermo'));
 const order=await (await fetch(`${h.origin}/api/profile/home-order`,{headers:h.admin})).json();assert.ok(order.known.includes('studio-2'));
 assert.equal((await h.post('/api/profile/home-order',{order:['studio-2','mini']},h.admin)).status,200);
 // API keys never add, remove or upload, whatever their scopes.
 const key=await h.account('agent-home',['read','home:settings','inventory:write']);
 assert.equal((await h.post('/api/home/devices',{name:'X',kind:'other',hostname:'x.local'},key.headers)).status,403);
 assert.equal((await put(JPEG,'image/jpeg',key.headers)).status,403);
 assert.equal((await h.post('/api/home/devices/remove',{id:'studio-2'},h.admin)).status,200);assert.deepEqual(removed,['studio-2']);
 assert.equal((await h.post('/api/home/devices/remove',{id:'studio-2'},h.admin)).status,404);
});
