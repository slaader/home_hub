// Shared by the backup tests: a hub in a temp dir with the fake ssh, ssh-keygen, ssh-keyscan and rsync
// (tests/fixtures/backup-tools), a job made through the wizard API, and one run awaited to its end.
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {hub} from '../hub-helper.mjs';

export const TOOLS=path.join(path.dirname(fileURLToPath(import.meta.url)),'..','fixtures','backup-tools');
export const tools={ssh:path.join(TOOLS,'ssh'),rsync:path.join(TOOLS,'rsync'),sshKeygen:path.join(TOOLS,'ssh-keygen'),sshKeyscan:path.join(TOOLS,'ssh-keyscan')};
export const NAS_KEY='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';
export const MINI_KEY='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHb6m1Nn0kqf4bWv8u0f1pY3r3o9R1qgK9yJ6Q2c7Lx4';
export const OTHER_KEY='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v';

export async function setup(t,extra={}){
 // Keys in a temp dir of their own: a test never writes into the checkout's private/.
 const keys=await mkdtemp(path.join(os.tmpdir(),'hub-bk-'));t.after(()=>rm(keys,{recursive:true,force:true}));
 const h=await hub(t,{backupTools:tools,backupKeysDirectory:keys,backupHubAddress:'10.0.0.25',backupCatchUpDelayMs:3600000,...extra});
 const fakeFile=path.join(h.dir,'fake.json'),before=process.env.HHB_FAKE;process.env.HHB_FAKE=fakeFile;
 t.after(()=>{if(before===undefined)delete process.env.HHB_FAKE;else process.env.HHB_FAKE=before;});
 const fake=v=>writeFile(fakeFile,JSON.stringify({hostKeys:{'nas.example.lan':NAS_KEY,'mini.example.lan':MINI_KEY},...v}));
 await fake({});
 const b=h.handler.hub.state('backup-jobs');
 t.after(()=>b.runner.cancelAll());
 const get=(url,headers=h.admin)=>fetch(h.origin+url,{headers});
 const call=async(route,body,headers=h.admin)=>{const r=await h.post(`/api/backup-jobs/${route}`,body,headers);return {status:r.status,body:await r.json().catch(()=>null)};};
 const detail=async id=>(await (await get(`/api/backup-jobs/detail?id=${id}`)).json());
 const update=async(id,change)=>{const d=await detail(id);return call('update',{id,base:d.job.hash,...change});};
 return {...h,b,keys,fake,get,call,detail,update,target:path.join(h.dir,'nas','backup'),src:path.join(h.dir,'docs'),remote:path.join(h.dir,'mini','projects')};
}
// Through the wizard: target, its key, sources (one on the hub, one on another machine) with theirs, schedule.
export async function readyJob(s,{sources,retention={keepLast:2},target=s.target,name='Dokumenty'}={}){
 const made=await s.call('create',{name});assert.equal(made.status,201);const id=made.body.job.id;
 assert.equal((await s.update(id,{target:{host:'nas.example.lan',user:'backup',path:target}})).status,200);
 const scan=await s.call('test',{id,part:'target'});
 assert.equal((await s.call('trust',{id,part:'target',fingerprint:scan.body.result.hostKeys[0].fingerprint})).status,200);
 await mkdir(target,{recursive:true});
 await mkdir(path.join(s.src,'sub'),{recursive:true});await writeFile(path.join(s.src,'a.txt'),'alpha');await writeFile(path.join(s.src,'sub','b.txt'),'bravo');await writeFile(path.join(s.src,'x.tmp'),'skip');
 await mkdir(s.remote,{recursive:true});await writeFile(path.join(s.remote,'c.txt'),'charlie');
 assert.equal((await s.update(id,{sources:sources??[{kind:'local',path:s.src,name:'docs'},{kind:'ssh',host:'mini.example.lan',user:'alice',path:s.remote,name:'projects'}]})).status,200);
 for(const [i,src] of (await s.detail(id)).job.sources.entries())if(src.kind==='ssh'){
  const r=await s.call('test',{id,part:'source',index:i});assert.equal(r.body.result.state,'trust');
  assert.equal((await s.call('trust',{id,part:'source',index:i,fingerprint:r.body.result.hostKeys[0].fingerprint})).status,200);
 }
 const done=await s.update(id,{schedule:{mode:'daily',time:'03:15'},retention,enabled:true});assert.equal(done.status,200,JSON.stringify(done.body));
 return id;
}
export const run=async(s,id)=>{const r=await s.call('run',{id});assert.equal(r.status,202,JSON.stringify(r.body));await s.b.runner.wait(id);return (await s.detail(id)).runs[0];};

