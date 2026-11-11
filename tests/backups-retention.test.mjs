// Backup jobs, outcomes, sealing and retention (M1, M2, M3, N5, N8): cases a code review found, end to end with the fake tools
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

test('M1: a run whose rsync exits 23 with "Permission denied (13)" ends as a warning, not as an ssh failure',async t=>{
 const s=await setup(t);const id=await readyJob(s,{sources:local(s)});
 await s.fake({rsyncExit:23,rsyncStderr:'rsync: [sender] send_files failed to open "/srv/docs/a.txt": Permission denied (13)\nrsync error: some files/attrs were not transferred (see previous errors) (code 23) at main.c(1338) [sender=3.2.7]\n'});
 const r=await run(s,id);
 assert.equal(r.result,'warning');assert.equal(r.error,null);assert.deepEqual(r.warnings,['partial']);assert.equal(r.present,true);
});

test('M2: a snapshot named later than this run never makes retention delete this run\'s snapshot',async t=>{
 const s=await setup(t);const id=await readyJob(s,{sources:local(s),retention:{keepLast:1}});
 const first=await run(s,id);assert.equal(first.result,'ok');
 await mkdir(path.join(s.target,'2099-01-01T000000Z'));// a clock that went back, or a copy made by hand
 const second=await run(s,id);
 assert.equal(second.result,'warning');assert.deepEqual(second.warnings,['newer-snapshot']);assert.deepEqual(second.pruned,[]);
 assert.ok(existsSync(path.join(s.target,second.snapshot)),'this run\'s snapshot stays');assert.ok(existsSync(path.join(s.target,first.snapshot)),'nothing is pruned');
 assert.equal(await readlink(path.join(s.target,'latest')),second.snapshot,'latest is this run, not the highest name');
});

test('M3: a slow rm on the target (pruning, leftovers, delete-snapshot) runs under the job deadline, not the short ssh one',async t=>{
 const s=await setup(t,{backupSshTimeoutMs:250});const id=await readyJob(s,{sources:local(s),retention:{keepLast:1}});
 const first=await run(s,id);assert.equal(first.result,'ok');
 await mkdir(path.join(s.target,'.in-progress-2026-01-01T000000Z'));// a leftover the next prepare removes
 await s.fake({slowRmMs:450});
 const second=await run(s,id);
 assert.equal(second.result,'ok',JSON.stringify(second));assert.deepEqual(second.pruned,[first.snapshot]);
 assert.ok(!existsSync(path.join(s.target,first.snapshot)));assert.ok(!existsSync(path.join(s.target,'.in-progress-2026-01-01T000000Z')));
 assert.equal(await readlink(path.join(s.target,'latest')),second.snapshot);
 const del=await s.call('delete-snapshot',{id,snapshot:second.snapshot});assert.equal(del.status,200,JSON.stringify(del.body));assert.ok(!existsSync(path.join(s.target,second.snapshot)));
});

test('M3: when pruning fails the run keeps its snapshot and ends as a warning',async t=>{
 const s=await setup(t,{backupSshTimeoutMs:250});const id=await readyJob(s,{sources:local(s),retention:{keepLast:1}});
 const first=await run(s,id);
 // The job's own deadline is the minimum (5 min), so make rm fail instead: the old snapshot cannot be removed.
 await writeFile(path.join(s.target,first.snapshot,'docs','pin'),'x');
 if(process.getuid?.()===0)return;// root removes it anyway
 const {chmod}=await import('node:fs/promises');const locked=path.join(s.target,first.snapshot,'docs');await chmod(locked,0o500);
 try{
  const second=await run(s,id);
  assert.equal(second.result,'warning');assert.deepEqual(second.warnings,['prune-failed']);assert.equal(second.present,true);
  assert.equal(await readlink(path.join(s.target,'latest')),second.snapshot);
 }finally{await chmod(locked,0o700);}
});

test('N5: a snapshot name that already exists on the target is never overwritten',async t=>{
 const fixed=new Date('2026-11-11T02:30:00Z');
 const s=await setup(t,{backupNow:()=>new Date(fixed)});const id=await readyJob(s,{sources:local(s)});
 await mkdir(path.join(s.target,'2026-11-11T023000Z','docs'),{recursive:true});await writeFile(path.join(s.target,'2026-11-11T023000Z','docs','old.txt'),'old');
 const r=await run(s,id);
 assert.equal(r.result,'failed');assert.equal(r.error,'stamp-exists');
 assert.equal(await readFile(path.join(s.target,'2026-11-11T023000Z','docs','old.txt'),'utf8'),'old');
});

test('N8: an empty source keeps every older snapshot (warning)',async t=>{
 const s=await setup(t);const id=await readyJob(s,{sources:local(s),retention:{keepLast:1}});
 const first=await run(s,id);
 for(const f of await readdir(s.src))await rm(path.join(s.src,f),{recursive:true,force:true});
 const second=await run(s,id);
 assert.equal(second.result,'warning');assert.deepEqual(second.warnings,['source-empty']);assert.ok(existsSync(path.join(s.target,first.snapshot)));
});
