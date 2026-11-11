// Editing a machine of the site configuration on the overview: its display metadata (name, hostname, ip, hardware,
// picture) is stored as the owner's override over the site's values in state/home/site-overrides.json (0600); site.json is
// never written, no shadow device appears, and id, role, platform, thermoId, telemetry wiring, services and the
// collectors keep reading the site. Only a person signed in with a password edits it; API keys and agents are refused,
// and machine_upsert keeps refusing site machines. Reset drops the override and the uploaded picture.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,access,stat,mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {hub,SITE} from './hub-helper.mjs';
import {parseSiteOverride,siteOverrideHash,createHomeDevices} from '../server/home-devices.mjs';
import {buildHome,machineList} from '../server/home-data.mjs';

const JPEG=Buffer.from([0xff,0xd8,0xff,0xe0,0,16,0x4a,0x46,0x49,0x46,0,1,0xff,0xd9]);
async function setup(t){
 const h=await hub(t);
 const call=async(url,body,headers=h.admin)=>{const r=await h.post(url,body,headers);return {status:r.status,body:await r.json().catch(()=>({}))};};
 const home=async()=>(await fetch(`${h.origin}/api/home`,{headers:h.admin})).json();
 const machine=async id=>(await home()).machines.find(m=>m.id===id);
 const file=name=>path.join(h.dir,'home',name);
 return {h,call,home,machine,file};
}

test('a site NAS is edited in place: display values change, identity, role and wiring stay the site\'s, no shadow device',async t=>{
 const {h,call,home,machine,file}=await setup(t);
 const before=await home(),nas0=before.machines.find(m=>m.id==='nas');
 assert.deepEqual(nas0.siteOverride,{fields:[],hash:siteOverrideHash(null),image:false,updatedAt:null,updatedBy:null},'every site machine can be edited, from an empty override');
 assert.deepEqual([nas0.siteDefaults.name,nas0.siteDefaults.hostname,nas0.siteDefaults.ip,nas0.siteDefaults.hardware.ramGb],['NAS','nas.example.lan','10.0.0.74',64]);
 const saved=await call('/api/home/devices/site',{id:'nas',base:nas0.siteOverride.hash,
  machine:{name:'Storage',hostname:'storage.example.lan',ip:'10.0.0.75',hardware:{cpu:'Ryzen 9 7900',ramGb:128},picture:'server'}});
 assert.equal(saved.status,200,JSON.stringify(saved.body));assert.equal(saved.body.changed,true);
 assert.deepEqual(saved.body.override.fields,{name:'Storage',hostname:'storage.example.lan',ip:'10.0.0.75',hardware:{ramGb:128},picture:'server'},'a value equal to the site\'s is not stored');
 const after=await home(),nas=after.machines.find(m=>m.id==='nas');
 assert.equal(after.machines.length,before.machines.length,'no extra tile');
 assert.deepEqual([nas.name,nas.hostname,nas.ip,nas.props.ramGb,nas.props.cpu,nas.props.pools,nas.picture,nas.image],['Storage','storage.example.lan','10.0.0.75',128,'Ryzen 9 7900',3,'/images/generic/server.svg',null]);
 assert.deepEqual([nas.id,nas.source,nas.readOnly,nas.role,nas.kind,nas.telemetryEditable,nas.telemetryBinding],['nas','site',true,'nas','nas',true,null],'identity and wiring are the site\'s');
 assert.deepEqual(nas.siteOverride.fields,['name','hostname','ip','hardware.ramGb','picture']);assert.equal(nas.siteOverride.updatedBy,'admin');
 assert.equal(nas.siteDefaults.name,'NAS','the site\'s values stay known, for the reset');
 // Stored privately, beside nothing else; site.json is the fixture and untouched by design (it is read-only here).
 assert.equal((await stat(file('site-overrides.json'))).mode&0o777,0o600);
 await assert.rejects(access(file('devices.json')),'no shadow device');
 // Agents read the effective values and which were changed; the API still refuses to change the site record.
 const list=await (await fetch(`${h.origin}/api/home/machines`,{headers:h.admin})).json(),listed=list.machines.find(m=>m.id==='nas');
 assert.deepEqual([listed.name,listed.hostname,listed.hardware.ramGb,listed.hardware.pools,listed.readOnly,listed.hash,listed.siteOverride.fields.length],['Storage','storage.example.lan',128,3,true,null,5]);
 const up=await call('/api/home/machines',{machine:{id:'nas',name:'NAS',role:'nas'}});assert.equal(up.status,403);assert.equal(up.body.error.code,'MACHINE_READ_ONLY');
 // Unchanged again: nothing written; then everything back to the site's value drops the entry.
 const same=await call('/api/home/devices/site',{id:'nas',base:nas.siteOverride.hash,machine:saved.body.override.fields});assert.equal(same.body.changed,false);
 const back=await call('/api/home/devices/site',{id:'nas',base:nas.siteOverride.hash,machine:{name:'NAS'}});assert.equal(back.status,200);assert.equal(back.body.override,null);
 assert.deepEqual(JSON.parse(await readFile(file('site-overrides.json'),'utf8')).overrides,[]);
 assert.equal((await machine('nas')).name,'NAS');
});

test('refusals: stale base, site-controlled fields, bad or secret values, address collisions, unknown ids, API keys',async t=>{
 const {h,call,machine,file}=await setup(t);
 const base=(await machine('nas')).siteOverride.hash;
 const r=async machineBody=>call('/api/home/devices/site',{id:'nas',base,machine:machineBody});
 for(const k of ['role','platform','thermoId','id','ssh','stack']){const x=await r({name:'X',[k]:k==='role'?'computer':'x'});assert.equal(x.status,400,k);assert.equal(x.body.error.code,'MACHINE_INVALID');assert.match(x.body.error.details[0],/stays in the site configuration/);}
 assert.equal((await r({name:''})).status,400);
 assert.equal((await r({ip:'192.168.1.5'})).status,400,'outside the site networks');
 assert.equal((await r({hostname:'bad host'})).status,400);
 assert.equal((await r({hardware:{ramGb:-1}})).status,400);
 assert.equal((await r({picture:'/images/x.png'})).status,400,'a built-in picture id only');
 const secret=await r({hardware:{cpu:'token=abcdef123456'}});assert.equal(secret.status,422);assert.equal(secret.body.error.code,'MACHINE_SECRET');
 const dup=await r({hostname:'mini.example.lan'});assert.equal(dup.status,409);assert.equal(dup.body.error.code,'MACHINE_DUPLICATE','another machine\'s address');
 assert.equal((await call('/api/home/devices/site',{id:'nas',base:'0'.repeat(64),machine:{name:'X'}})).status,409,'a stale base');
 assert.equal((await call('/api/home/devices/site',{id:'nas',machine:{name:'X'}})).status,400,'base is required');
 assert.equal((await call('/api/home/devices/site',{id:'ghost',base,machine:{name:'X'}})).status,404);
 // An added device is not a site machine: its own editor (machine API) changes it, not this route.
 const added=await call('/api/home/devices',{name:'Box',kind:'other',hostname:'box.example.lan'});assert.equal(added.status,201);
 assert.equal((await call('/api/home/devices/site',{id:added.body.id,base,machine:{name:'X'}})).status,404);
 assert.equal((await call('/api/home/devices/site/reset',{id:added.body.id,base})).status,404);
 // API keys (agents), with every scope there is: none of it.
 const key=await h.account('agent',['read','home:write']);
 for(const [url,b] of [['/api/home/devices/site',{id:'nas',base,machine:{name:'X'}}],['/api/home/devices/site/reset',{id:'nas',base}],['/api/home/devices/image/remove',{id:'nas'}]])
  assert.equal((await call(url,b,key.headers)).status,403,url);
 const put=await fetch(`${h.origin}/api/home/devices/nas/image`,{method:'PUT',headers:{Origin:h.origin,'Content-Type':'image/jpeg',...key.headers},body:JPEG});assert.equal(put.status,403);
 // Native clients have write permission, but cannot change the owner's site overrides or pictures.
 const native=await h.handler.hub.deviceTokens.issue('Test native client');
 const guest=await (await h.post('/api/admin/users',{username:'guest'},h.admin)).json();
 const login=await h.post('/api/session',{username:'guest',password:guest.initialPassword});
 const reader={Cookie:login.headers.get('set-cookie').split(';')[0]};
 for(const headers of [{Authorization:'Bearer '+native.token},reader]){
  for(const [url,b] of [['/api/home/devices/site',{id:'nas',base,machine:{name:'X'}}],['/api/home/devices/site/reset',{id:'nas',base}],['/api/home/devices/image/remove',{id:'nas'}]])
   assert.equal((await call(url,b,headers)).status,403,url);
  assert.equal((await fetch(`${h.origin}/api/home/devices/nas/image`,{method:'PUT',headers:{Origin:h.origin,'Content-Type':'image/jpeg',...headers},body:JPEG})).status,403);
 }
 await assert.rejects(access(file('site-overrides.json')),'nothing stored by a refusal');
});

test('own picture, reset to site defaults, and a Thermo Mac and the router are editable without touching their telemetry',async t=>{
 const {h,call,machine,file}=await setup(t);
 const put=await fetch(`${h.origin}/api/home/devices/nas/image`,{method:'PUT',headers:{Origin:h.origin,'Content-Type':'image/jpeg',...h.admin},body:JPEG});
 assert.equal(put.status,200);
 let nas=await machine('nas');assert.equal(nas.siteOverride.image,true);assert.match(nas.image,/^\/api\/home\/devices\/nas\/image\?v=/);
 const img=await fetch(`${h.origin}/api/home/devices/nas/image`,{headers:h.admin});assert.equal(img.status,200);assert.deepEqual(Buffer.from(await img.arrayBuffer()),JPEG);
 assert.equal((await fetch(`${h.origin}/api/home/devices/studio/image`,{headers:h.admin})).status,404,'no picture without an upload');
 // A name on top keeps the picture; the picture's removal keeps the name.
 const named=await call('/api/home/devices/site',{id:'nas',base:nas.siteOverride.hash,machine:{name:'Vault'}});assert.equal(named.body.override.image,true);
 const gone=await call('/api/home/devices/image/remove',{id:'nas'});assert.equal(gone.status,200);assert.deepEqual(gone.body.siteOverride.fields,{name:'Vault'});
 await assert.rejects(access(file('images/nas.jpg')));
 await fetch(`${h.origin}/api/home/devices/nas/image`,{method:'PUT',headers:{Origin:h.origin,'Content-Type':'image/jpeg',...h.admin},body:JPEG});
 nas=await machine('nas');
 assert.equal((await call('/api/home/devices/site/reset',{id:'nas',base:'1'.repeat(64)})).status,409);
 const reset=await call('/api/home/devices/site/reset',{id:'nas',base:nas.siteOverride.hash});assert.equal(reset.status,200);assert.equal(reset.body.changed,true);
 nas=await machine('nas');assert.deepEqual([nas.name,nas.siteOverride.fields,nas.siteOverride.image],['NAS',[],false]);
 await assert.rejects(access(file('images/nas.jpg')),'the uploaded picture goes with the reset');
 // A Mac the site reads through Thermo, and the router: their display changes, their telemetry stays the site's.
 for(const id of ['mini','router']){const m=await machine(id);
  const r=await call('/api/home/devices/site',{id,base:m.siteOverride.hash,machine:{name:`${m.name} (edited)`,hardware:{cpu:'edited'}}});assert.equal(r.status,200,id);
  const after=await machine(id);assert.deepEqual([after.name,after.props.cpu,after.kind,after.telemetryEditable,after.role],[`${m.name} (edited)`,'edited',m.kind,false,m.role],id);}
 assert.equal((await machine('mini')).telemetry.thermoId,'mini','the Mac still reads its Thermo host');
});

test('the override is display only: bindings, services and history keep the site id; a machine that leaves site.json drops it from view',async t=>{
 const nasSite=SITE.machines.find(m=>m.id==='nas');
 const fields=parseSiteOverride({name:'Storage',hostname:'nas.example.lan',hardware:{gpu:'—',ramGb:64}},nasSite,{lanCidrs:SITE.lanCidrs});
 assert.deepEqual(fields,{name:'Storage'},'site values are not stored');
 const o={nas:{fields,image:false,imageAt:null,updatedAt:'2026-11-11T00:00:00Z',updatedBy:'admin',hash:siteOverrideHash({fields})}};
 const thermo={interval:()=>({intervalSeconds:15,lastPollAt:null}),status:()=>({}),live:()=>({}),seconds:()=>[],minutes:()=>[],disks:()=>({}),native:()=>({})};
 const home=buildHome({site:SITE,thermo,siteOverrides:o,siteTelemetry:[{id:'nas',provider:'prometheus',platform:'linux',configuredAt:null}],probed:{nas:[{id:'smb',name:'SMB',status:'reachable'}]}});
 const nas=home.machines.find(m=>m.id==='nas');
 assert.deepEqual([nas.name,nas.provider,nas.thermo===null||typeof nas.thermo==='string',nas.telemetryBinding.provider,nas.services.length,nas.role],['Storage','prometheus',true,'prometheus',1,'nas']);
 assert.equal(home.machines.filter(m=>m.id==='nas').length,1,'one tile');
 const listed=machineList({site:SITE,home,siteOverrides:o}).machines.find(m=>m.id==='nas');assert.equal(listed.name,'Storage');
 // Unknown to the site: neither shown nor counted, kept on disk until reset clears it.
 const dir=await mkdtemp(path.join(os.tmpdir(),'hub-ovr-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const one=createHomeDevices(dir,{reserved:['nas'],lanCidrs:SITE.lanCidrs,siteMachines:[nasSite]});
 const w=await one.setSiteOverride('nas',{name:'Storage'},{by:'admin',base:siteOverrideHash(null)});
 const later=createHomeDevices(dir,{reserved:[],siteMachines:[]});
 assert.deepEqual(await later.siteOverrides(),{});assert.equal(JSON.parse(await readFile(path.join(dir,'site-overrides.json'),'utf8')).overrides.length,1,'kept on disk');
 await assert.rejects(later.setSiteOverride('nas',{name:'X'},{base:w.hash}),e=>e.message==='not-found');
 await later.resetSiteOverride('nas',{base:w.hash});assert.deepEqual(JSON.parse(await readFile(path.join(dir,'site-overrides.json'),'utf8')).overrides,[]);
});
