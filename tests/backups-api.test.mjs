// Backup jobs end to end (server/core/backups.mjs, server/backup-runner.mjs) on a hub in a temp dir, with fakes
// for ssh, ssh-keygen, ssh-keyscan and rsync (tests/fixtures/backup-tools). No network: the "target" and the
// "remote" source are directories here, and the remote scripts run under /bin/sh for real. Covers the wizard
// API, trust on first use, the key that never leaks, snapshots with hard links, retention, the lock,
// cancellation, failures, permissions and the integration switch.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,readFile,stat,readdir,readlink,utimes,rm,chmod} from 'node:fs/promises';
import os from 'node:os';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {hub} from './hub-helper.mjs';
import {runProcess} from '../server/backup-runner.mjs';

import {setup,readyJob,run,tools,NAS_KEY,MINI_KEY,OTHER_KEY} from './support/backup-hub.mjs';

test('the wizard: a dedicated key, trust on first use, connection checks with clear errors',async t=>{
 const s=await setup(t);
 const made=await s.call('create',{name:'Dokumenty'});
 assert.equal(made.status,201);const id=made.body.job.id;
 assert.match(id,/^bj-[a-z0-9]{8}$/);assert.equal(made.body.job.state,'draft');assert.deepEqual(made.body.job.missing,['target','sources']);
 // The public key and a restricted authorized_keys line come back; the private key never does.
 assert.match(made.body.publicKey,/^ssh-ed25519 \S+ home-hub-backup-bj-/);
 assert.equal(made.body.authorizedKeys.line,`restrict,from="10.0.0.25" ${made.body.publicKey}`);
 const files=path.join(s.b.keysDirectory,id);
 assert.equal((await stat(files)).mode&0o777,0o700);assert.equal((await stat(path.join(files,'id_ed25519'))).mode&0o777,0o600);
 // Target: validated; the test first shows the host key to confirm.
 const bad=await s.update(id,{target:{host:'nas.example.lan',user:'backup',path:'/mnt/with space'}});
 assert.equal(bad.status,400);assert.equal(bad.body.error.code,'BACKUP_INVALID');assert.match(bad.body.error.details[0],/target.path/);
 assert.equal((await s.update(id,{target:{host:'nas.example.lan',user:'backup',path:s.target}})).status,200);
 const scan=await s.call('test',{id,part:'target'});
 assert.equal(scan.body.result.state,'trust');assert.equal(scan.body.result.error,'host-key-unknown');assert.match(scan.body.result.hostKeys[0].fingerprint,/^SHA256:/);
 const wrong=await s.call('trust',{id,part:'target',fingerprint:'SHA256:'+'A'.repeat(43)});
 assert.equal(wrong.status,409);assert.equal(wrong.body.error.code,'BACKUP_FINGERPRINT_MISMATCH');
 const trusted=await s.call('trust',{id,part:'target',fingerprint:scan.body.result.hostKeys[0].fingerprint});
 assert.equal(trusted.status,200);assert.equal(trusted.body.job.target.hostKey.fingerprint,scan.body.result.hostKeys[0].fingerprint);assert.equal(trusted.body.job.target.hostKey.pinnedBy,'admin');
 // Pinned: now the checks run over SSH. The destination does not exist yet; then it is not writable; then fine.
 let r=(await s.call('test',{id,part:'target'})).body.result;
 assert.equal(r.state,'problem');assert.equal(r.error,'dest-missing');assert.match(r.message,/neexistuje/);
 await mkdir(path.dirname(s.target),{recursive:true});await mkdir(s.target,{mode:0o500});
 if(process.getuid?.()!==0){r=(await s.call('test',{id,part:'target'})).body.result;assert.equal(r.error,'dest-readonly');}
 await chmod(s.target,0o700);
 r=(await s.call('test',{id,part:'target'})).body.result;
 assert.equal(r.state,'ok');assert.deepEqual(r.checks.filter(c=>c.id!=='space').map(c=>[c.id,c.ok]),[['ssh',true],['dir',true],['writable',true],['rsync',true]]);
 assert.ok(r.checks.find(c=>c.id==='space').value.availableBytes>0,'free space from df');
 // A changed host key is refused with its own error; the job keeps the old pin.
 await s.fake({hostKeys:{'nas.example.lan':OTHER_KEY}});
 r=(await s.call('test',{id,part:'target'})).body.result;assert.equal(r.state,'changed');assert.equal(r.error,'host-key-changed');assert.equal(r.pinned.fingerprint,trusted.body.job.target.hostKey.fingerprint);
 await s.fake({refuse:{'nas.example.lan':'ssh: connect to host nas.example.lan port 22: Connection refused'}});
 const down=await s.call('test',{id,part:'target'});assert.equal(down.status,502);assert.equal(down.body.error.code,'BACKUP_KEYSCAN_FAILED');
 await s.fake({});
 // The job's key is gone: the hub says so instead of connecting without it.
 await rm(path.join(files,'id_ed25519'));
 r=(await s.call('test',{id,part:'target'})).body;assert.equal(r.error.code,'BACKUP_NO_KEY');
 // Local sources are checked on the hub itself.
 await s.update(id,{sources:[{kind:'local',path:path.join(s.dir,'nowhere')}]});
 r=(await s.call('test',{id,part:'source',index:0})).body.result;assert.equal(r.error,'source-missing');
 // Nothing that came back over the API holds the private key.
 const everything=JSON.stringify([made.body,await s.detail(id),await (await s.get('/api/backup-jobs')).json()]);
 assert.ok(!everything.includes('PRIVATE KEY')&&!everything.includes('ZmFrZS1wcml2YXRl'),'the private key never leaves the server');
 // Stale base: refused, never forced.
 const stale=await s.call('update',{id,base:'0'.repeat(64),name:'x'});assert.equal(stale.status,409);assert.equal(stale.body.error.code,'BACKUP_CONFLICT');
 assert.equal((await s.call('update',{id,base:'x',colour:'red'})).status,400);
});

test('runs make hard-linked snapshots, record their statistics and logs, and retention prunes after success',async t=>{
 const s=await setup(t);
 const id=await readyJob(s);
 const first=await run(s,id);
 assert.equal(first.result,'ok',JSON.stringify(first));assert.equal(first.trigger,'manual');assert.equal(first.by,'admin');
 assert.match(first.snapshot,/^\d{4}-\d{2}-\d{2}T\d{6}Z$/);assert.equal(first.present,true);
 assert.equal(first.stats.filesTransferred,3,'a.txt, sub/b.txt and c.txt (x.tmp is excluded)');assert.equal(first.stats.totalBytes,'alpha'.length+'bravo'.length+'charlie'.length);
 const snap=path.join(s.target,first.snapshot);
 assert.equal(await readFile(path.join(snap,'docs','sub','b.txt'),'utf8'),'bravo');assert.equal(await readFile(path.join(snap,'projects','c.txt'),'utf8'),'charlie');
 assert.ok(!existsSync(path.join(snap,'docs','x.tmp')),'excluded');
 assert.equal(await readlink(path.join(s.target,'latest')),first.snapshot);
 assert.ok(!(await readdir(s.target)).some(n=>n.startsWith('.in-progress-')),'the in-progress directory was renamed');
 // The remote source was mirrored in the staging copy on the hub, then pushed.
 assert.equal(await readFile(path.join(s.b.stateDirectory,id,'staging','projects','c.txt'),'utf8'),'charlie');
 // The log: what happened, bounded, no key.
 const log=await (await s.get(`/api/backup-jobs/log?id=${id}&run=${first.id}`)).text();
 assert.match(log,/rsync push docs to the target/);assert.match(log,/No previous snapshot/);assert.ok(!log.includes('PRIVATE KEY'));
 assert.equal((await s.get(`/api/backup-jobs/log?id=${id}&run=r-1999-01-01T000000Z`)).status,404);
 // Second run: one changed file; the unchanged ones are hard links into the first snapshot.
 await writeFile(path.join(s.src,'a.txt'),'alpha, changed');const later=new Date(Date.now()+5000);await utimes(path.join(s.src,'a.txt'),later,later);
 const second=await run(s,id);
 assert.equal(second.result,'ok');assert.notEqual(second.snapshot,first.snapshot);assert.equal(second.stats.filesTransferred,1);
 const ino=async p=>(await stat(p)).ino;
 assert.equal(await ino(path.join(s.target,second.snapshot,'docs','sub','b.txt')),await ino(path.join(snap,'docs','sub','b.txt')),'unchanged: a hard link');
 assert.notEqual(await ino(path.join(s.target,second.snapshot,'docs','a.txt')),await ino(path.join(snap,'docs','a.txt')));
 assert.match(await (await s.get(`/api/backup-jobs/log?id=${id}&run=${second.id}`)).text(),new RegExp(`Previous snapshot: ${first.snapshot}`));
 // Third run: keepLast 2 removes the first snapshot.
 const third=await run(s,id);
 assert.deepEqual(third.pruned,[first.snapshot]);assert.ok(!existsSync(snap));
 const d=await s.detail(id);
 assert.deepEqual(d.snapshots.map(x=>x.name),[second.snapshot,third.snapshot]);
 assert.equal(d.runs.find(r=>r.id===first.id).present,false);assert.equal(d.job.state,'ok');assert.equal(d.job.snapshots,2);
 assert.ok(d.job.nextRunAt&&d.job.lastSuccessAt);assert.equal(d.job.sizeBytes,third.stats.totalBytes);
 // Deleting one snapshot moves latest to the one left.
 const del=await s.call('delete-snapshot',{id,snapshot:third.snapshot});
 assert.equal(del.status,200);assert.deepEqual(del.body.snapshots,[second.snapshot]);assert.equal(await readlink(path.join(s.target,'latest')),second.snapshot);
 assert.equal((await s.call('delete-snapshot',{id,snapshot:third.snapshot})).body.error.code,'BACKUP_SNAPSHOT_MISSING');
 assert.equal((await s.call('delete-snapshot',{id,snapshot:'../etc'})).status,400);
 // The audit names who pinned and deleted what.
 const audit=await (await s.get('/api/admin/audit?kind=access')).json();
 const events=audit.events.map(e=>e.event);for(const e of ['backup-job-created','backup-host-key-pinned','backup-snapshot-deleted'])assert.ok(events.includes(e),e);
 // The MCP read tool lists the job.
 const reader=await s.account('reader',[]);
 const rpc=await fetch(s.origin+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',...reader.headers},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'backup_jobs_list',arguments:{}}})});
 const listed=JSON.parse((await rpc.json()).result.content[0].text);assert.equal(listed.jobs[0].id,id);assert.equal(listed.jobs[0].snapshots,1);
 // Deleting the job removes its key and history; the snapshots on the target stay.
 assert.equal((await s.update(id,{name:'Dokumenty 2'})).status,200);
 const gone=await s.call('delete',{id,base:d.job.hash});
 assert.equal(gone.status,409,'a stale base is refused');
 assert.equal((await s.call('delete',{id,base:(await s.detail(id)).job.hash})).status,200);
 assert.ok(!existsSync(path.join(s.b.keysDirectory,id)));assert.ok(existsSync(path.join(s.target,second.snapshot)));
 assert.equal((await s.get(`/api/backup-jobs/detail?id=${id}`)).status,404);
});

test('the job key is never copied by a backup of the directory it lives in',async t=>{
 const h=await setup(t);
 const keys=path.join(h.src,'hub-private','backup-jobs');
 // A second hub on the same dir whose key directory lies inside the source.
 const s={...h,...await (async()=>{const x=await hub(t,{backupTools:tools,backupKeysDirectory:keys,backupHubAddress:null});return {...x,b:x.handler.hub.state('backup-jobs')};})()};
 s.get=(url,headers=s.admin)=>fetch(s.origin+url,{headers});
 s.call=async(route,body,headers=s.admin)=>{const r=await s.post(`/api/backup-jobs/${route}`,body,headers);return {status:r.status,body:await r.json().catch(()=>null)};};
 s.detail=async id=>(await (await s.get(`/api/backup-jobs/detail?id=${id}`)).json());
 s.update=async(id,change)=>{const d=await s.detail(id);return s.call('update',{id,base:d.job.hash,...change});};
 t.after(()=>s.b.runner.cancelAll());
 const id=await readyJob(s,{sources:[{kind:'local',path:h.src,name:'docs'}]});
 assert.equal((await s.detail(id)).authorizedKeys.line.startsWith('restrict ssh-ed25519'),true,'no from="…" without a known address');
 const r=await run(s,id);assert.equal(r.result,'ok');
 assert.ok(existsSync(path.join(keys,id,'id_ed25519')),'the key is in the source');
 assert.ok(existsSync(path.join(h.target,r.snapshot,'docs','a.txt')));
 assert.ok(!existsSync(path.join(h.target,r.snapshot,'docs','hub-private','backup-jobs')),'but not in the snapshot');
});

test('failures, warnings, the lock, cancellation, permissions and the integration switch',async t=>{
 const s=await setup(t);
 const id=await readyJob(s,{sources:[{kind:'local',path:path.join(s.dir,'docs'),name:'docs'}],retention:{keepLast:1}});
 assert.equal((await run(s,id)).result,'ok');
 // rsync exit 23: the snapshot is kept, the run says warning, and retention does not prune.
 await s.fake({rsyncExit:23});
 const warn=await run(s,id);assert.equal(warn.result,'warning');assert.deepEqual(warn.pruned,[]);assert.equal((await s.detail(id)).snapshots.length,2);
 // The target refuses the connection: failed, with the code; the unfinished snapshot is cleaned by the next run.
 await s.fake({refuse:{'nas.example.lan':'ssh: connect to host nas.example.lan port 22: Connection refused'}});
 const refused=await run(s,id);assert.equal(refused.result,'failed');assert.equal(refused.error,'refused');assert.match(refused.message,/odmítl/);
 // A changed host key: the run refuses to connect.
 await s.fake({hostKeys:{'nas.example.lan':OTHER_KEY}});
 const changed=await run(s,id);assert.equal(changed.error,'host-key-changed');
 // One run at a time: a second start is refused while the first runs; cancel stops it.
 await s.fake({rsyncDelayMs:3000});
 assert.equal((await s.call('run',{id})).status,202);
 const again=await s.call('run',{id});assert.equal(again.status,409);assert.equal(again.body.error.code,'BACKUP_BUSY');
 assert.equal((await s.update(id,{name:'x'})).body.error.code,'BACKUP_BUSY','no edits while it runs');
 assert.ok(existsSync(path.join(s.b.stateDirectory,id,'run.lock')));
 assert.equal((await s.detail(id)).job.state,'running');
 assert.equal((await s.call('cancel',{id})).status,200);
 await s.b.runner.wait(id);
 const cancelled=(await s.detail(id)).runs[0];assert.equal(cancelled.result,'cancelled');assert.equal(cancelled.error,'cancelled');
 assert.ok(!existsSync(path.join(s.b.stateDirectory,id,'run.lock')),'the lock is released');
 assert.equal((await s.call('cancel',{id})).body.error.code,'BACKUP_NOT_RUNNING');
 // A lock held by another live hub process is respected; a stale one (its process is gone) is taken over.
 await s.fake({});
 await writeFile(path.join(s.b.stateDirectory,id,'run.lock'),JSON.stringify({pid:process.pid,runId:'r-x',startedAt:new Date().toISOString(),timeoutMinutes:360}));
 const locked=await s.call('run',{id});assert.equal(locked.status,409);assert.equal(locked.body.error.code,'BACKUP_LOCKED');
 // S1: a live PID does not keep a lock past its job's deadline (plus a margin): the PID may have been reused.
 await writeFile(path.join(s.b.stateDirectory,id,'run.lock'),JSON.stringify({pid:process.pid,runId:'r-x',startedAt:new Date(Date.now()-7*3600000).toISOString(),timeoutMinutes:360}));
 assert.equal((await run(s,id)).result,'ok','an expired lock is taken over');
 await writeFile(path.join(s.b.stateDirectory,id,'run.lock'),JSON.stringify({pid:2147480000,runId:'r-x'}));
 const after=await run(s,id);assert.equal(after.result,'ok');
 assert.ok(!(await readdir(s.target)).some(n=>n.startsWith('.in-progress-')),'leftovers of the cancelled run are gone');
 assert.deepEqual(after.pruned.length>0,true,'keepLast 1 prunes after a successful run');
 // Who may do what: a read key reads but cannot run; a key with backup-jobs:manage runs but cannot set up.
 const reader=await s.account('reader',[]),runnerKey=await s.account('runner',['backup-jobs:manage']);
 assert.equal((await s.get('/api/backup-jobs',reader.headers)).status,200);
 assert.equal((await s.call('run',{id},reader.headers)).status,403);
 const asKey=await s.call('create',{name:'x'},runnerKey.headers);assert.equal(asKey.status,403);assert.equal(asKey.body.error.code,'ADMIN_REQUIRED');
 assert.equal((await s.call('trust',{id,part:'target',fingerprint:'SHA256:'+'A'.repeat(43)},runnerKey.headers)).status,403);
 assert.equal((await s.call('run',{id},runnerKey.headers)).status,202);await s.b.runner.wait(id);
 assert.equal((await s.detail(id)).runs[0].by,'runner');
 // The integration switched off: reads say so, runs and tests are refused, the jobs stay.
 assert.equal((await s.post('/api/admin/integrations/toggle',{id:'backup-jobs.runner',enabled:false},s.admin)).status,200);
 const list=await (await s.get('/api/backup-jobs')).json();assert.equal(list.disabled.id,'backup-jobs.runner');assert.equal(list.jobs.length,1);
 const offRun=await s.call('run',{id});assert.equal(offRun.status,409);assert.equal(offRun.body.error.code,'INTEGRATION_DISABLED');
 assert.equal((await s.call('test',{id,part:'target'})).body.error.code,'INTEGRATION_DISABLED');
 const card=(await (await s.get('/api/admin/integrations')).json()).integrations.find(i=>i.id==='backup-jobs.runner');assert.equal(card.status.state,'disabled');
 assert.equal((await s.post('/api/admin/integrations/toggle',{id:'backup-jobs.runner',enabled:true},s.admin)).status,200);
 const on=(await (await s.get('/api/admin/integrations')).json()).integrations.find(i=>i.id==='backup-jobs.runner');
 assert.equal(on.status.state,'ok');assert.equal(on.status.items[0].label,'Dokumenty');
 // The page is in the sidebar for everyone who can read; the scope is in the scope table.
 const manifest=await (await s.get('/api/ui/manifest')).json();assert.ok(manifest.pages.some(p=>p.hash==='backup-jobs'&&!p.admin));
 const scopes=(await (await s.get('/api/admin/accounts')).json()).scopes;assert.ok(scopes['backup-jobs:manage']);
});

test('a process that outlives its deadline or is cancelled is killed',async()=>{
 const slow=['-e','setTimeout(()=>{},10000)'];
 const timed=await runProcess(process.execPath,slow,{timeoutMs:150});assert.equal(timed.error,'timeout');
 const ctl=new AbortController();setTimeout(()=>ctl.abort('cancelled'),100);
 const cancelled=await runProcess(process.execPath,slow,{signal:ctl.signal});assert.equal(cancelled.error,'cancelled');
 const missingTool=await runProcess('/nonexistent/rsync',[]);assert.equal(missingTool.error,'no-tool');
 const big=await runProcess(process.execPath,['-e','process.stdout.write("x".repeat(3000000))'],{maxOutput:1000});assert.equal(big.stdout.length,1000,'output is bounded');
 const env=await runProcess(process.execPath,['-e','process.stdout.write(String(process.env.SSH_AUTH_SOCK))']);assert.equal(env.stdout,'undefined','no SSH agent reaches the tools');
});
