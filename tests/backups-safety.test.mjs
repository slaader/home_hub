// Backup jobs, what may be read and written where (M4, S3, M6, S4, S7, N3, N4, N9, N12): cases a code review found, end to end with the fake tools
// (tests/fixtures/backup-tools) on a hub in a temp dir. No network, no real hosts.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,readdir,readlink,symlink,rm,unlink} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setup,readyJob,run,tools} from './support/backup-hub.mjs';
import {mkdtemp} from 'node:fs/promises';
import os from 'node:os';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}};
const until=async(check,ms=5000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await check())return true;await new Promise(r=>setTimeout(r,25));}return false;};
const local=s=>[{kind:'local',path:s.src,name:'docs'}];

test('M4 and S3: the key directory and the backup state are refused as sources; keys and private/ are left out, by real path, with glob characters escaped',async t=>{
 const base=await mkdtemp(path.join(os.tmpdir(),'hub-bk4-'));t.after(()=>rm(base,{recursive:true,force:true}));
 const src=path.join(base,'home');
 // Inside the source: the key directory (with characters rsync would read as a pattern) and the hub's private/.
 const keys=path.join(src,'hub','private','backup-jobs[1]*'),priv=path.join(src,'hub','private');
 const s=await setup(t,{backupKeysDirectory:keys,backupPrivateDirectory:priv});
 await mkdir(src,{recursive:true});await writeFile(path.join(src,'a.txt'),'alpha');
 await mkdir(priv,{recursive:true});await writeFile(path.join(priv,'auth.json'),'{"owner":"hash"}');
 await symlink(src,path.join(base,'home-link'));
 const id=await readyJob(s,{sources:[{kind:'local',path:path.join(base,'home-link'),name:'home'}]});
 // At save time: the keys themselves, a symlink into them, the backup state.
 for(const bad of [keys,path.join(base,'home-link','hub','private','backup-jobs[1]*'),path.join(s.b.stateDirectory,id)]){
  const r=await s.update(id,{sources:[{kind:'local',path:bad,name:'x'}]});
  assert.equal(r.status,400,bad);assert.equal(r.body.error.code,'BACKUP_SOURCE_PROTECTED');
 }
 const r=await run(s,id);assert.equal(r.result,'ok',JSON.stringify(r));
 const snap=path.join(s.target,r.snapshot,'home');
 assert.ok(existsSync(path.join(snap,'a.txt')));
 assert.ok(existsSync(path.join(keys,id,'id_ed25519')),'the key is inside the source');
 assert.ok(!existsSync(path.join(snap,'hub','private')),'but neither the key nor private/ reached the snapshot');
 assert.match(await (await s.get(`/api/backup-jobs/log?id=${id}&run=${r.id}`)).text(),/Left out of home: \/hub\/private\//);
 // At run time: a symlink that pointed somewhere harmless at save time and into the keys later.
 const ok=path.join(base,'harmless');await mkdir(ok);await symlink(ok,path.join(base,'moving'));
 assert.equal((await s.update(id,{sources:[{kind:'local',path:path.join(base,'moving'),name:'moving'}]})).status,200);
 await unlink(path.join(base,'moving'));await symlink(path.join(keys,id),path.join(base,'moving'));
 const refused=await run(s,id);assert.equal(refused.result,'failed');assert.equal(refused.error,'source-protected');
 assert.ok(!(await readdir(s.target)).some(n=>n.startsWith('.in-progress-')&&existsSync(path.join(s.target,n,'moving','id_ed25519'))),'nothing was sent');
});

test('M6: two jobs cannot share a destination: refused when saved, and the owner marker refuses what validation cannot see',async t=>{
 const s=await setup(t);const a=await readyJob(s,{sources:local(s)});
 const ra=await run(s,a);assert.equal(ra.result,'ok');
 assert.equal((await readFile(path.join(s.target,'.home-hub-backup-job'),'utf8')).trim(),a,'the destination names its job');
 const made=await s.call('create',{name:'Druhá'});const b=made.body.job.id;
 for(const p of [s.target,path.join(s.target,'inner'),path.dirname(s.target)]){
  const r=await s.update(b,{target:{host:'NAS.example.lan',user:'other',path:p}});assert.equal(r.status,409,p);assert.equal(r.body.error.code,'BACKUP_DEST_SHARED');
 }
 // The same directory under another name (a symlink here; an IP for a host name in life): only the marker sees it.
 await symlink(s.target,path.join(path.dirname(s.target),'alias'));
 const idB=await readyJob(s,{sources:local(s),target:path.join(path.dirname(s.target),'alias'),name:'Druhá'});
 const rb=await run(s,idB);
 assert.equal(rb.result,'failed');assert.equal(rb.error,'dest-owned');
 assert.ok(existsSync(path.join(s.target,ra.snapshot)),'the other job\'s snapshot is untouched');
 const del=await s.call('delete-snapshot',{id:idB,snapshot:ra.snapshot});assert.equal(del.status,409);assert.equal(del.body.error.code,'BACKUP_DEST_OWNED');
 const tested=(await s.call('test',{id:idB,part:'target'})).body.result;assert.equal(tested.error,'dest-owned');
});

test('S4: after a good run, the staging copy of a source that left the job is removed',async t=>{
 const s=await setup(t);const id=await readyJob(s);// docs (local) and projects (on another machine)
 assert.equal((await run(s,id)).result,'ok');
 const stagingDir=path.join(s.b.stateDirectory,id,'staging');
 assert.deepEqual(await readdir(stagingDir),['projects']);
 assert.equal((await s.update(id,{sources:local(s)})).status,200);
 assert.equal((await run(s,id)).result,'ok');assert.deepEqual(await readdir(stagingDir),[]);
});

test('S7, N3, N4: no test, trust, refresh, edit or delete while a run is active; deleting a snapshot of an unfinished job is a 409',async t=>{
 const s=await setup(t);const id=await readyJob(s,{sources:local(s)});
 await s.fake({rsyncDelayMs:3000});
 assert.equal((await s.call('run',{id})).status,202);
 for(const [route,body] of [['test',{id,part:'target'}],['refresh',{id}],['trust',{id,part:'target',fingerprint:'SHA256:'+'A'.repeat(43)}]]){
  const r=await s.call(route,body);assert.equal(r.status,409,route);assert.equal(r.body.error.code,'BACKUP_BUSY',route);
 }
 const del=await s.call('delete',{id,base:(await s.detail(id)).job.hash});assert.equal(del.status,409);assert.equal(del.body.error.code,'BACKUP_BUSY');
 assert.equal((await s.get(`/api/backup-jobs/detail?id=${id}`)).status,200,'the job is still there');
 await s.call('cancel',{id});await s.b.runner.wait(id);
 const draft=(await s.call('create',{name:'Rozpracovaná'})).body.job.id;
 const r=await s.call('delete-snapshot',{id:draft,snapshot:'2026-11-11T000000Z'});assert.equal(r.status,409);assert.equal(r.body.error.code,'BACKUP_INCOMPLETE');
});

test('N9 and N12: an invalid field is named for the wizard; an unreadable run history is never overwritten',async t=>{
 const s=await setup(t);const id=await readyJob(s,{sources:local(s)});
 const bad=await s.update(id,{target:{host:'nas.example.lan',user:'backup',path:'/with space'}});
 assert.equal(bad.body.error.field,'target.path');
 const runs=path.join(s.b.stateDirectory,id,'runs.json');
 await mkdir(path.dirname(runs),{recursive:true});await writeFile(runs,'{not json');
 const r=await s.call('run',{id});assert.equal(r.status,500);assert.equal(r.body.error.code,'BACKUP_HISTORY_UNREADABLE');
 assert.equal(await readFile(runs,'utf8'),'{not json','left as it was');
 const d=await s.detail(id);assert.equal(d.job.historyUnreadable,true);
 assert.ok(!existsSync(path.join(s.b.stateDirectory,id,'run.lock')),'no lock left behind');
});
