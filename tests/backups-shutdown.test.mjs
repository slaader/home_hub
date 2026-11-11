// Backup jobs, stopping the hub and recovering after it (M5): cases a code review found, end to end with the fake tools
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

test('M5: stopping the hub ends a running backup as interrupted, stops its rsync and keeps its log on disk',async t=>{
 const s=await setup(t);const id=await readyJob(s,{sources:local(s)});
 await s.fake({rsyncDelayMs:20000});
 assert.equal((await s.call('run',{id})).status,202);
 const lockFile=path.join(s.b.stateDirectory,id,'run.lock');
 const running=(await s.detail(id)).runs[0];assert.equal(running.result,'running','recorded as running from the start');
 const logFile=path.join(s.b.stateDirectory,id,'logs',`${running.id}.log`);
 assert.ok(await until(async()=>/rsync push docs/.test(await readFile(logFile,'utf8').catch(()=>''))),'the log is on disk while it runs');
 assert.ok(await until(async()=>{try{return JSON.parse(await readFile(lockFile,'utf8')).child>0;}catch{return false;}}),'the lock names the child');
 const child=JSON.parse(await readFile(lockFile,'utf8')).child;
 await s.handler.stop();
 const after=(await s.detail(id)).runs[0];
 assert.equal(after.result,'interrupted');assert.equal(after.error,'interrupted');
 assert.ok(await until(()=>!alive(child)),'rsync is gone');assert.ok(!existsSync(lockFile));
 assert.match(await readFile(path.join(s.b.stateDirectory,id,'logs',`${after.id}.log`),'utf8'),/Stopped: interrupted/);
});

test('M5: at start, a run a dead hub left "running" becomes interrupted and the child it left behind is stopped',async t=>{
 const s=await setup(t);const id=await readyJob(s,{sources:local(s)});
 // What a hub killed with SIGKILL leaves: a running record, a lock of a dead process, an rsync still going.
 await s.fake({rsyncDelayMs:30000});
 const dst=path.join(s.dir,'orphan-dst');
 const orphan=spawn(tools.rsync,['-a',s.src+'/',dst+'/'],{detached:true,stdio:'ignore',env:process.env});orphan.unref();
 t.after(()=>{try{process.kill(-orphan.pid,'SIGKILL');}catch{}});
 const runId='r-2026-11-11T010000Z';
 await mkdir(path.join(s.b.stateDirectory,id,'logs'),{recursive:true});
 await writeFile(path.join(s.b.stateDirectory,id,'runs.json'),JSON.stringify({runs:[{id:runId,trigger:'schedule',startedAt:'2026-11-11T01:00:00.000Z',result:'running'}],snapshots:[]}));
 await writeFile(path.join(s.b.stateDirectory,id,'run.lock'),JSON.stringify({pid:2147480000,runId,startedAt:new Date().toISOString(),timeoutMinutes:360,child:orphan.pid}));
 assert.ok(alive(orphan.pid));
 assert.deepEqual(await s.b.runner.recover([id]),[id]);
 assert.ok(await until(()=>!alive(orphan.pid)),'the orphaned rsync is stopped');
 const r=(await s.detail(id)).runs.find(x=>x.id===runId);assert.equal(r.result,'interrupted');assert.ok(r.finishedAt);
 assert.ok(!existsSync(path.join(s.b.stateDirectory,id,'run.lock')));
 // A child pid that is not one of our tools is left alone.
 const other=spawn(process.execPath,['-e','setTimeout(()=>{},20000)'],{detached:true,stdio:'ignore'});other.unref();t.after(()=>{try{process.kill(other.pid,'SIGKILL');}catch{}});
 await writeFile(path.join(s.b.stateDirectory,id,'run.lock'),JSON.stringify({pid:2147480000,runId,startedAt:new Date().toISOString(),timeoutMinutes:360,child:other.pid}));
 await s.b.runner.recover([id]);assert.ok(alive(other.pid),'an unrelated process is not killed');
});

test('M5: the server exits on SIGTERM after its modules stop',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'hub-sig-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const child=spawn(process.execPath,[path.join(root,'server','index.mjs')],{cwd:root,stdio:['ignore','pipe','pipe'],
  env:{...process.env,LOCAL_PREVIEW:'1',PORT:'0',DATA_DIR:dir,AUTH_FILE:path.join(dir,'none.json'),BACKUP_KEYS_DIR:path.join(dir,'keys'),HOME_HUB_PLUGINS_DIR:'none',HOME_HUB_SITE_CONFIG:path.join(root,'tests','fixtures','site.json')}});
 let out='';child.stdout.on('data',d=>{out+=d;});child.stderr.on('data',d=>{out+=d;});
 assert.ok(await until(()=>/listening on/.test(out),15000),out);
 const exited=new Promise(r=>child.on('exit',(code,signal)=>r({code,signal})));
 child.kill('SIGTERM');
 let hang;const result=await Promise.race([exited,new Promise(r=>{hang=setTimeout(()=>r('hung'),10000);})]);clearTimeout(hang);
 if(result==='hung')child.kill('SIGKILL');
 assert.deepEqual(result,{code:0,signal:null},out);assert.match(out,/SIGTERM: stopping Home Hub/);
});
