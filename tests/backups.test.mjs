// Backup jobs, the pure rules (server/backup-config.mjs, parts of server/backup-runner.mjs): wizard input
// validation, next and previous runs in the site's time zone (DST included), the missed-run policy, retention,
// what rsync and ssh-keyscan print, the remote scripts, and the scheduler with a fake clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,symlinkSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {targetInput,sourcesInput,excludesInput,scheduleInput,retentionInput,applyUpdate,newJob,missing,complete,jobHash,nextRun,previousRun,zonedInstant,
 missedAtStart,pruneList,snapshotName,snapshotTime,parseStats,rsyncOutcome,fingerprint,hostKeyOf,isBackupError,readJobs,expandHome,localPath} from '../server/backup-config.mjs';
import {parseKeyscan,keyState,pinFrom,parseMarks,scripts,classifySsh,rsyncResult,authorizedKeys,hubAddress,createBackupScheduler,guardSource,globEscape,within,BACKUP_ERRORS,BACKUP_WARNINGS} from '../server/backup-runner.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const invalid=(fn,pattern)=>assert.throws(fn,e=>isBackupError(e)&&e.code==='invalid'&&(!pattern||pattern.test(e.detail)),String(pattern));
const KEY='AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';
const PIN={type:'ssh-ed25519',key:KEY,fingerprint:fingerprint(KEY)};
const ready=()=>({...newJob({name:'Docs'}),enabled:true,target:{host:'nas.example.lan',port:22,user:'backup',path:'/mnt/tank/backup',hostKey:PIN},sources:[{name:'docs',kind:'local',path:'/srv/docs'}]});

test('the target step accepts a host, port, user and path, and nothing a shell or ssh could misread',()=>{
 assert.deepEqual(targetInput({host:'NAS.example.lan',port:'2222',user:'backup',path:'/mnt/tank/hub/'}),{host:'nas.example.lan',port:2222,user:'backup',path:'/mnt/tank/hub',hostKey:null});
 assert.equal(targetInput({host:'10.0.0.74',user:'b',path:'/x'}).port,22,'port defaults to 22');
 invalid(()=>targetInput({host:'-oProxyCommand=sh',user:'b',path:'/x'}),/host/);
 invalid(()=>targetInput({host:'nas',user:'b;rm',path:'/x'}),/user/);
 invalid(()=>targetInput({host:'nas',user:'b',path:'/x',extra:1}),/unknown/);
 for(const p of ['relative/dir','/mnt/my backups','/mnt/$(id)','/mnt/a\'b','/mnt/../etc','/','/x/./y','/x\ny'])invalid(()=>targetInput({host:'nas',user:'b',path:p}),/path/);
 invalid(()=>targetInput({host:'nas',user:'b',path:'/x',port:70000}),/port/);
 // The pinned key stays while host and port stay; changing either drops it.
 const current={host:'nas',port:22,user:'b',path:'/x',hostKey:PIN};
 assert.deepEqual(targetInput({host:'nas',user:'other',path:'/y'},current).hostKey,PIN);
 assert.equal(targetInput({host:'nas',port:2200,user:'b',path:'/x'},current).hostKey,null);
 assert.equal(targetInput({host:'nas2',user:'b',path:'/x'},current).hostKey,null);
});

test('sources: a path on the hub (spaces allowed) or on an SSH host; names are unique folder names',()=>{
 const s=sourcesInput([{kind:'local',path:'~/Documents/My Files/'},{kind:'ssh',host:'mini.example.lan',user:'alice',path:'/Users/alice/Projects'},{kind:'local',path:'/srv/projects'}]);
 assert.deepEqual(s.map(x=>x.name),['my-files','projects','projects-2']);
 assert.equal(s[0].path,'~/Documents/My Files');assert.equal(s[1].port,22);assert.equal(s[1].hostKey,null);
 invalid(()=>sourcesInput([{kind:'local',path:'a',name:'x'},{kind:'local',path:'b',name:'x'}]),/path/);
 invalid(()=>sourcesInput([{kind:'local',path:'/a',name:'x'},{kind:'local',path:'/b',name:'x'}]),/used twice/);
 invalid(()=>sourcesInput([{kind:'ftp',path:'/a'}]),/kind/);
 invalid(()=>sourcesInput([{kind:'local',path:'/a',name:'../up'}]),/name/);
 invalid(()=>sourcesInput([{kind:'ssh',host:'h',user:'u',path:'/with space'}]),/path/);
 invalid(()=>sourcesInput([{kind:'local',path:'/a/token=abcdef1234567890'}]),/secret/);
 invalid(()=>sourcesInput(Array.from({length:11},(_,i)=>({kind:'local',path:`/p${i}`}))),/at most/);
 const kept=sourcesInput([{kind:'ssh',host:'h',user:'u',path:'/b'}],[{name:'b',kind:'ssh',host:'h',port:22,user:'u',path:'/a',hostKey:PIN}]);
 assert.deepEqual(kept[0].hostKey,PIN,'the same host keeps its pinned key');
});

test('excludes, schedule and retention are validated; a job is enabled only when complete',()=>{
 assert.deepEqual(excludesInput(['*.tmp','node_modules/','*.tmp']),['*.tmp','node_modules/']);
 invalid(()=>excludesInput(['--delete']),/must not start/);invalid(()=>excludesInput(['a\nb']));
 assert.deepEqual(scheduleInput({mode:'weekly',time:'23:05',days:[7,1,1]}),{mode:'weekly',time:'23:05',days:[1,7]});
 assert.deepEqual(scheduleInput({mode:'manual'}).mode,'manual');
 invalid(()=>scheduleInput({mode:'daily',time:'24:00'}),/HH:MM/);invalid(()=>scheduleInput({mode:'weekly',time:'01:00',days:[]}),/weekdays/);invalid(()=>scheduleInput({mode:'hourly',time:'01:00'}),/mode/);
 assert.deepEqual(retentionInput({keepLast:'7',keepDays:30}),{keepLast:7,keepDays:30});
 invalid(()=>retentionInput({keepLast:0,keepDays:0}),/keepLast or keepDays/);invalid(()=>retentionInput({keepLast:-1}));
 const draft=newJob({name:'Docs'});
 assert.deepEqual(missing(draft),['target','sources']);assert.equal(draft.enabled,false);
 invalid(()=>applyUpdate(draft,{enabled:true}),/cannot be enabled/);
 const withTarget=applyUpdate(draft,{target:{host:'nas',user:'b',path:'/x'},sources:[{kind:'local',path:'/srv'}]});
 assert.deepEqual(missing(withTarget),['target-key']);
 assert.equal(complete(ready()),true);assert.notEqual(jobHash(ready()),jobHash({...ready(),name:'Other'}));
 invalid(()=>applyUpdate(ready(),{name:'api_key=abcdefghijklmnop'}),/secret/);
});

test('next and previous runs follow the site time zone, across both DST changes',()=>{
 const tz='Europe/Berlin',daily={mode:'daily',time:'02:30',days:[]};
 assert.equal(new Date(zonedInstant(2026,11,11,2,30,tz)).toISOString(),'2026-11-11T01:30:00.000Z');
 assert.equal(new Date(zonedInstant(2026,7,1,2,30,tz)).toISOString(),'2026-07-01T00:30:00.000Z');
 assert.equal(new Date(zonedInstant(2026,3,29,2,30,tz)).toISOString(),'2026-03-29T01:30:00.000Z','a skipped time runs an hour later (03:30 CEST)');
 assert.equal(new Date(zonedInstant(2026,10,25,2,30,tz)).toISOString(),'2026-10-25T00:30:00.000Z','a repeated time runs the first time');
 assert.equal(nextRun(daily,new Date('2026-11-11T01:00:00Z'),tz).toISOString(),'2026-11-11T01:30:00.000Z');
 assert.equal(nextRun(daily,new Date('2026-11-11T01:30:00Z'),tz).toISOString(),'2026-11-12T01:30:00.000Z','strictly after');
 assert.equal(previousRun(daily,new Date('2026-11-11T01:30:00Z'),tz).toISOString(),'2026-11-11T01:30:00.000Z');
 const weekly={mode:'weekly',time:'23:00',days:[3,7]};// Wednesday, Sunday
 assert.equal(nextRun(weekly,new Date('2026-11-11T23:00:00Z'),tz).toISOString(),'2026-11-15T22:00:00.000Z','Wed 11 Nov 23:00 CET passed; next is Sunday');
 assert.equal(previousRun(weekly,new Date('2026-11-14T12:00:00Z'),tz).toISOString(),'2026-11-11T22:00:00.000Z');
 assert.equal(nextRun({mode:'manual',time:'02:30',days:[]},new Date(),tz),null);
 assert.equal(nextRun(daily,new Date('2026-11-11T12:00:00Z'),'UTC').toISOString(),'2026-11-12T02:30:00.000Z');
});

test('missed-run policy: one catch-up at start when the newest slot passed after the last attempt',()=>{
 const tz='UTC',job={...ready(),schedule:{mode:'daily',time:'02:00',days:[]},createdAt:'2026-11-01T00:00:00Z',updatedAt:'2026-11-01T00:00:00Z'};
 const now=new Date('2026-11-11T09:00:00Z');
 assert.equal(missedAtStart(job,'2026-11-11T02:00:01Z',now,tz),null,'ran at the slot');
 assert.equal(missedAtStart(job,'2026-11-08T02:00:00Z',now,tz).toISOString(),'2026-11-11T02:00:00.000Z','down for days: one catch-up for the newest slot');
 assert.equal(missedAtStart(job,null,now,tz).toISOString(),'2026-11-11T02:00:00.000Z','never ran since it was set up');
 assert.equal(missedAtStart({...job,updatedAt:'2026-11-11T08:00:00Z',createdAt:'2026-11-11T08:00:00Z'},null,now,tz),null,'made after the slot: nothing missed');
 assert.equal(missedAtStart({...job,enabled:false},null,now,tz),null);
 assert.equal(missedAtStart({...job,schedule:{mode:'manual',time:'02:00',days:[]}},null,now,tz),null);
});

test('retention keeps the newest N and everything younger than D days, and never the newest snapshot',()=>{
 const names=['2026-11-01T020000Z','2026-11-05T020000Z','2026-11-09T020000Z','2026-11-10T020000Z','2026-11-11T020000Z','latest','notes'];
 const now=new Date('2026-11-11T03:00:00Z');
 assert.deepEqual(pruneList(names,{keepLast:3},now),['2026-11-01T020000Z','2026-11-05T020000Z']);
 assert.deepEqual(pruneList(names,{keepDays:3},now),['2026-11-01T020000Z','2026-11-05T020000Z']);
 assert.deepEqual(pruneList(names,{keepLast:1,keepDays:7},now),['2026-11-01T020000Z'],'a snapshot either rule keeps stays');
 assert.deepEqual(pruneList(names,{keepLast:1},now),['2026-11-01T020000Z','2026-11-05T020000Z','2026-11-09T020000Z','2026-11-10T020000Z']);
 assert.deepEqual(pruneList(['2026-01-01T000000Z'],{keepDays:1},now),[],'the only snapshot is never pruned');
 assert.deepEqual(pruneList([],{keepLast:1},now),[]);
 assert.equal(snapshotName(new Date('2026-11-11T02:30:05.900Z')),'2026-11-11T023005Z');
 assert.equal(snapshotTime('2026-11-11T023005Z').toISOString(),'2026-11-11T02:30:05.000Z');assert.equal(snapshotTime('latest'),null);
});

test('rsync statistics are read from GNU rsync and openrsync alike; exit codes 23 and 24 are warnings',()=>{
 const gnu='Number of files: 1,234 (reg: 1,000, dir: 234)\nNumber of created files: 3\nNumber of regular files transferred: 12\nTotal file size: 5,678,901 bytes\nTotal transferred file size: 45,678 bytes\nTotal bytes sent: 50,000\n';
 assert.deepEqual(parseStats(gnu),{files:1234,filesTransferred:12,totalBytes:5678901,transferredBytes:45678,sentBytes:50000});
 const open='Number of files: 4\nNumber of files transferred: 2\nTotal file size: 1.5 MB\nTotal transferred file size: 4 B\nTotal sent: 263 B\n';
 assert.deepEqual(parseStats(open),{files:4,filesTransferred:2,totalBytes:1572864,transferredBytes:4,sentBytes:263});
 assert.deepEqual(parseStats('nothing'),{files:null,filesTransferred:null,totalBytes:null,transferredBytes:null,sentBytes:null});
 assert.equal(rsyncOutcome(0),'ok');assert.equal(rsyncOutcome(24),'warning');assert.equal(rsyncOutcome(23),'warning');assert.equal(rsyncOutcome(12),'failed');assert.equal(rsyncOutcome(null),'failed');
});

test('host keys: keyscan output, fingerprints as ssh-keygen prints them, pin states',()=>{
 const rsa='AAAAB3NzaC1yc2EAAAADAQABAAABAQC7'+'x'.repeat(60);
 const keys=parseKeyscan(`# nas:22 SSH-2.0-OpenSSH_9.6\nnas ssh-rsa ${rsa}\n[nas]:2222 ssh-ed25519 ${KEY}\nnas ssh-ed25519 ${KEY}\ngarbage\n`);
 assert.deepEqual(keys.map(k=>k.type),['ssh-ed25519','ssh-rsa'],'ed25519 first, duplicates once');
 assert.match(keys[0].fingerprint,/^SHA256:[A-Za-z0-9+/]{43}$/);
 assert.equal(keys[0].fingerprint,'SHA256:'+createHash('sha256').update(Buffer.from(KEY,'base64')).digest().toString('base64').replace(/=+$/,''));
 assert.equal(keyState(null,keys),'unpinned');assert.equal(keyState(PIN,keys),'match');assert.equal(keyState({...PIN,key:rsa,type:'ssh-ed25519'},keys),'changed');
 assert.equal(pinFrom(keys,'SHA256:wrong',null),null);
 const pin=pinFrom(keys,keys[0].fingerprint,'alice',new Date('2026-11-11T00:00:00Z'));assert.deepEqual(pin,{...PIN,pinnedAt:'2026-11-11T00:00:00.000Z',pinnedBy:'alice'});
 assert.equal(hostKeyOf({type:'ssh-dss',key:KEY}),null);assert.equal(hostKeyOf({type:'ssh-ed25519',key:'short'}),null);
});

test('the remote scripts quote every path, and their output is read strictly',()=>{
 const s=scripts.prepare('/mnt/tank/backup','2026-11-11T020000Z',['docs','my-files'],'bj-aaaaaaaa');
 assert.match(s,/^d='\/mnt\/tank\/backup'$/m);assert.match(s,/mkdir -p -- '.in-progress-2026-11-11T020000Z\/docs' '.in-progress-2026-11-11T020000Z\/my-files'/);
 assert.match(scripts.prune('/d',['2026-11-01T020000Z'],'bj-aaaaaaaa'),/rm -rf -- '2026-11-01T020000Z'/);
 assert.doesNotMatch(scripts.seal('/d','2026-11-11T020000Z','bj-aaaaaaaa'),/rm -rf/,'naming the snapshot never deletes anything');
 assert.match(scripts.seal('/d','2026-11-11T020000Z','bj-aaaaaaaa'),/ln -sfn '2026-11-11T020000Z' latest/,'latest points at this run, not at the highest name');
 assert.match(scripts.checkTarget("/it's"),/d='\/it'\\''s'/,'a quote cannot end the quoting');
 const m=parseMarks('HHB dir yes\nHHB writable no\nHHB df 1000 250\nHHB snap 2026-11-11T020000Z\nHHB snap latest\nHHB snap 2026-11-01T020000Z\nnoise\nHHB error dest-readonly\n');
 assert.deepEqual(m.snapshots,['2026-11-01T020000Z','2026-11-11T020000Z']);assert.equal(m.dir,true);assert.equal(m.writable,false);
 assert.deepEqual(m.space,{totalBytes:1024000,availableBytes:256000});assert.deepEqual(m.errors,['dest-readonly']);
 assert.equal(classifySsh({code:255,stderr:'Permission denied (publickey).'}),'denied');
 assert.equal(classifySsh({code:255,stderr:'WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!'}),'host-key-changed');
 assert.equal(classifySsh({code:255,stderr:'Host key verification failed.'}),'host-key-unknown');
 assert.equal(classifySsh({code:255,stderr:'ssh: connect to host nas port 22: Connection refused'}),'refused');
 assert.equal(classifySsh({code:255,stderr:'This account is currently not available.'}),'no-shell');
 assert.equal(classifySsh({code:255,stderr:'??'}),'ssh');assert.equal(classifySsh({code:0,stderr:''}),null);assert.equal(classifySsh({error:'timeout'}),'timeout');
});

test('the authorized_keys line restricts the key, and names the hub address only when it is in the site networks',()=>{
 const pub='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl home-hub-backup-bj-abc';
 assert.equal(authorizedKeys(pub,{address:'10.0.0.25'}).line,`restrict,from="10.0.0.25" ${pub}`);
 assert.equal(authorizedKeys(pub).line,`restrict ${pub}`);assert.equal(authorizedKeys(null),null);
 const ifs={en0:[{family:'IPv4',address:'10.0.0.25',internal:false}],lo0:[{family:'IPv4',address:'127.0.0.1',internal:true}]};
 assert.equal(hubAddress(['10.0.0.0/24'],ifs),'10.0.0.25');assert.equal(hubAddress(['10.1.0.0/24'],ifs),null);assert.equal(hubAddress([],ifs),null);
});

test('the scheduler wakes at the soonest run, starts what is due, catches up once at start, and stops when off',async()=>{
 let clock=new Date('2026-11-11T01:00:00Z'),on=true;const timers=[],started=[];
 const daily={...ready(),id:'bj-aaaaaaaa',schedule:{mode:'daily',time:'02:00',days:[]},createdAt:'2026-11-01T00:00:00Z',updatedAt:'2026-11-01T00:00:00Z'};
 const weekly={...ready(),id:'bj-bbbbbbbb',schedule:{mode:'weekly',time:'03:00',days:[3]},createdAt:'2026-11-01T00:00:00Z',updatedAt:'2026-11-01T00:00:00Z'};
 const draft={...newJob({name:'Draft'}),id:'bj-cccccccc'};
 const history={'bj-aaaaaaaa':{runs:[{startedAt:'2026-11-10T02:00:00Z'}]},'bj-bbbbbbbb':{runs:[{startedAt:'2026-11-01T03:00:00Z'}]},'bj-cccccccc':{runs:[]}};
 const runner={history:async id=>history[id],start:async(job,{trigger})=>{started.push([job.id,trigger,clock.toISOString()]);}};
 const s=createBackupScheduler({jobs:async()=>[daily,weekly,draft],runner,timeZone:()=>'UTC',enabled:()=>on,now:()=>clock,catchUpDelayMs:60000,
  setTimer:(fn,ms)=>{const t={ms};t.fn=()=>{t.cleared=true;return fn();};timers.push(t);return t;},clearTimer:t=>{t.cleared=true;}});
 await s.start();
 // The weekly job (Wednesdays 03:00) last ran 1 Nov; Wed 4 Nov 03:00 passed since: one catch-up. The daily one ran yesterday: none.
 const live=()=>timers.filter(t=>!t.cleared);
 const catchUp=live().find(t=>t.ms===60000),main=live().find(t=>t!==catchUp);
 assert.ok(catchUp,'a catch-up timer');assert.equal(main.ms,3600000,'the next run (02:00) is an hour away');
 assert.equal(s.next('bj-aaaaaaaa').toISOString(),'2026-11-11T02:00:00.000Z');assert.equal(s.next('bj-cccccccc'),null,'a draft is never planned');
 await catchUp.fn();
 assert.deepEqual(started,[['bj-bbbbbbbb','catch-up','2026-11-11T01:00:00.000Z']]);
 clock=new Date('2026-11-11T02:00:00Z');await main.fn();
 assert.deepEqual(started.at(-1),['bj-aaaaaaaa','schedule','2026-11-11T02:00:00.000Z']);
 assert.equal(s.next('bj-aaaaaaaa').toISOString(),'2026-11-12T02:00:00.000Z','re-armed for tomorrow');
 // Off: the timer still wakes, but nothing starts.
 on=false;clock=new Date('2026-11-11T03:00:00Z');const n=started.length;await live().at(-1).fn();assert.equal(started.length,n);
 s.stop();assert.equal(live().length,0);
});

test('every backup message and server sentence has an English entry',async()=>{
 globalThis.localStorage??={getItem:()=>null,setItem:()=>{}};
 const {dictionary}=await import('../public/i18n.js');
 const missingEn=[];
 for(const text of [...Object.values(BACKUP_ERRORS),...Object.values(BACKUP_WARNINGS)])if(!Object.hasOwn(dictionary,text))missingEn.push(text);
 for(const file of ['server/core/backups.mjs','server/backup-runner.mjs','server/backup-config.mjs']){
  const src=readFileSync(path.join(root,file),'utf8').split('\n').filter(l=>!/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  for(const m of src.matchAll(/'((?:[^'\\\n]|\\.)*[áčďéěíňóřšťúůýžÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ](?:[^'\\\n]|\\.)*)'/g))if(!Object.hasOwn(dictionary,m[1].replace(/\\'/g,"'")))missingEn.push(`${file}: ${m[1]}`);
 }
 assert.deepEqual([...new Set(missingEn)],[]);
});

test('M1: rsync exit 23/24 is a warning whatever its stderr says; only exit 255 is read as an ssh failure',()=>{
 // What GNU rsync really prints for an unreadable file: "Permission denied (13)", exit 23.
 const real23='rsync: [sender] send_files failed to open "/srv/docs/private.txt": Permission denied (13)\nrsync error: some files/attrs were not transferred (see previous errors) (code 23) at main.c(1338) [sender=3.2.7]\n';
 assert.equal(rsyncResult({code:23,stderr:real23}),'warning');
 assert.equal(rsyncResult({code:24,stderr:'file has vanished: "/srv/x" Permission denied'}),'warning');
 assert.equal(rsyncResult({code:0,stderr:'Permission denied'}),'ok');
 assert.equal(classifySsh({code:23,stderr:real23}),null,'not ssh: the remote command failed');
 assert.equal(classifySsh({code:1,stderr:'rm: cannot remove x: Permission denied'}),null);
 const code=f=>{try{f();}catch(e){return e.code;}};
 assert.equal(code(()=>rsyncResult({code:255,stderr:'backup@nas: Permission denied (publickey).'})),'denied');
 assert.equal(code(()=>rsyncResult({code:12,stderr:'ssh: connect to host nas port 22: Connection refused\nrsync: connection unexpectedly closed (0 bytes received so far) [sender]'})),'refused');
 assert.equal(code(()=>rsyncResult({code:12,stderr:'sh: 1: rsync: not found\nrsync: connection unexpectedly closed'})),'no-remote-rsync');
 assert.equal(code(()=>rsyncResult({code:11,stderr:'rsync: write failed: No space left on device (28)'})),'rsync');
 assert.equal(code(()=>rsyncResult({code:null,error:'timeout'})),'timeout');
});

test('M2: retention never deletes this run\'s snapshot, and deletes nothing when neither rule is set',()=>{
 const later='2099-01-01T000000Z',mine='2026-11-11T020000Z',older=['2026-11-09T020000Z','2026-11-10T020000Z'];
 // A directory named later than this run (a clock that went back) would be "the newest"; keep protects this run's.
 assert.ok(!pruneList([...older,mine,later],{keepLast:1},new Date('2026-11-11T03:00:00Z'),{keep:[mine]}).includes(mine));
 assert.deepEqual(pruneList([...older,mine],{keepLast:0,keepDays:0},new Date()),[],'no rule: nothing is pruned');
});

test('S2: a job edited after the slot it would have run in did not miss it',()=>{
 const job={...ready(),schedule:{mode:'daily',time:'02:00',days:[]},createdAt:'2026-11-01T00:00:00Z',updatedAt:'2026-11-11T05:00:00Z'};
 assert.equal(missedAtStart(job,'2026-11-05T02:00:00Z',new Date('2026-11-11T09:00:00Z'),'UTC'),null,'the later of last attempt and last change counts');
 assert.ok(missedAtStart({...job,updatedAt:'2026-11-01T00:00:00Z'},'2026-11-05T02:00:00Z',new Date('2026-11-11T09:00:00Z'),'UTC'));
});

test('S5: only the marks the scripts print are read; unknown error codes are dropped',()=>{
 const m=parseMarks('HHB dir yes\nHHB snapshots 99\nHHB __proto__ x\nHHB error rm-everything\nHHB error dest-owned\nHHB owner bj-bbbbbbbb\nHHB writable maybe\n');
 assert.deepEqual(m.errors,['dest-owned']);assert.equal(m.dir,true);assert.equal(m.writable,undefined);assert.equal(m.owner,'bj-bbbbbbbb');
 assert.equal(Object.hasOwn(m,'__proto__'),false);assert.equal(m.snapshots.length,0);
 assert.equal(parseMarks('HHB owner ../../etc').owner,'other');
});

test('S8: jobs.json is read with the wizard\'s validators: a hand-written newline or a duplicate name never reaches ssh_config',()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'hhb-jobs-'));
 try{
  const file=path.join(dir,'jobs.json');
  writeFileSync(file,JSON.stringify({schemaVersion:1,jobs:[{id:'bj-aaaaaaaa',name:'x',enabled:true,
   target:{host:'nas\n  ProxyCommand sh -c id',port:22,user:'b',path:'/x',hostKey:PIN},
   sources:[{name:'a',kind:'ssh',host:'mini',user:'u\nHost *',path:'/p'},{name:'b',kind:'local',path:'/ok'},{name:'b',kind:'local',path:'/dup'},{name:'c',kind:'local',path:'/new\nline'}],
   retention:{keepLast:0,keepDays:0},schedule:{mode:'daily',time:'02:00',days:[]}}]}));
  const [job]=readJobs(file);
  assert.equal(job.target,null,'an invalid target is dropped');assert.deepEqual(job.sources.map(s=>s.name),['b'],'invalid and duplicate sources are dropped');
  assert.equal(complete(job),false,'so the job cannot run');assert.deepEqual(job.retention,{keepLast:14,keepDays:0},'no rule: the default');
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('N1, N2, N10: unique names at 40 characters, ~ is the home directory, hash-named paths are not secrets',()=>{
 const long='a'.repeat(40);
 const named=sourcesInput([{kind:'local',path:`/x/${long}`},{kind:'local',path:`/y/${long}`},{kind:'local',path:`/z/${long}`}]).map(s=>s.name);
 assert.equal(new Set(named).size,3);for(const n of named)assert.ok(n.length<=40,n);
 assert.equal(localPath('~/','p'),'~');assert.equal(expandHome('~','/home/alice'),'/home/alice');assert.equal(expandHome('~/docs','/home/alice'),'/home/alice/docs');assert.equal(expandHome('/srv','/h'),'/srv');
 assert.equal(localPath('/srv/store/3f786850e387550fdab836ed7e6dc881de23001b','p'),'/srv/store/3f786850e387550fdab836ed7e6dc881de23001b');
 assert.deepEqual(excludesInput(['objects/da39a3ee5e6b4b0d3255bfef95601890afd80709']),['objects/da39a3ee5e6b4b0d3255bfef95601890afd80709']);
 invalid(()=>localPath('/srv/token=abcdefgh12345678','p'),/secret/);
});

test('M4: the key directory is refused as a source and left out of one, after symlinks and regardless of case; glob characters are escaped',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'hhb-guard-'));
 try{
  const keys=path.join(dir,'src','hub','k[1]*'),state=path.join(dir,'state');mkdirSync(keys,{recursive:true});mkdirSync(state);
  symlinkSync(path.join(dir,'src'),path.join(dir,'link'));
  const opts={reject:[keys,state],exclude:[keys,state]};
  const code=async f=>{try{await f();}catch(e){return e.code;}};
  assert.equal(await code(()=>guardSource(keys,opts)),'source-protected','the key directory itself');
  assert.equal(await code(()=>guardSource(path.join(keys,'id_ed25519'),opts)),'source-protected','a file in it');
  assert.equal(await code(()=>guardSource(path.join(dir,'link','hub','k[1]*'),opts)),'source-protected','through a symlink');
  assert.equal(await code(()=>guardSource(path.join(dir,'state','x'),opts)),'source-protected','inside the backup state');
  const {excludes}=await guardSource(path.join(dir,'link'),opts);
  assert.deepEqual(excludes,['--exclude=/hub/k\\[1\\]\\*/'],'relative to the source after realpath, glob characters escaped');
  assert.equal(globEscape('a*b?[c]\\d'),'a\\*b\\?\\[c\\]\\\\d');
  // Case: on a case-insensitive file system /SRC/Hub is the same directory as /src/hub.
  assert.equal(within('/Users/alice/SRC/Hub/k','/users/alice/src',{ci:true}),true);assert.equal(within('/Users/alice/SRC/Hub/k','/users/alice/src',{ci:false}),false);
  assert.equal(within('/srv/docs2','/srv/docs',{ci:false}),false,'a sibling with the same prefix is not inside');
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('S6: concurrent re-arms leave one timer chain, and a slot that came due during a re-arm still fires',async()=>{
 let clock=new Date('2026-11-11T01:59:59Z');const timers=[],started=[];
 const job={...ready(),id:'bj-aaaaaaaa',schedule:{mode:'daily',time:'02:00',days:[]},createdAt:'2026-11-01T00:00:00Z',updatedAt:'2026-11-01T00:00:00Z'};
 let slowJobs=null;
 const s=createBackupScheduler({jobs:async()=>{if(slowJobs)await slowJobs;return [job];},runner:{history:async()=>({runs:[{startedAt:'2026-11-10T02:00:00Z'}]}),start:async(j,{trigger})=>{started.push([trigger,clock.toISOString()]);}},
  timeZone:()=>'UTC',now:()=>clock,setTimer:(fn,ms)=>{const t={ms};t.fn=()=>{t.cleared=true;return fn();};timers.push(t);return t;},clearTimer:t=>{t.cleared=true;}});
 await s.start();
 let release;slowJobs=new Promise(r=>{release=r;});
 const a=s.arm(),b=s.arm(),c2=s.arm();release();await Promise.all([a,b,c2]);
 assert.equal(timers.filter(t=>!t.cleared).length,1,'one live timer');
 // The clock passes 02:00 while a re-arm is in flight; the slot is still planned and fires.
 clock=new Date('2026-11-11T02:00:30Z');await s.arm();
 assert.equal(s.next('bj-aaaaaaaa').toISOString(),'2026-11-11T02:00:00.000Z','a due slot is kept, not skipped to tomorrow');
 await timers.filter(t=>!t.cleared)[0].fn();
 assert.deepEqual(started,[['schedule','2026-11-11T02:00:30.000Z']]);
 assert.equal(s.next('bj-aaaaaaaa').toISOString(),'2026-11-12T02:00:00.000Z');
 // A changed schedule starts counting from now.
 job.schedule={mode:'daily',time:'01:00',days:[]};await s.arm();
 assert.equal(s.next('bj-aaaaaaaa').toISOString(),'2026-11-12T01:00:00.000Z','not at once for the 01:00 that already passed today');
 s.stop();
});

test('N9: every field name and missing-part word the wizard shows has an English entry',async()=>{
 globalThis.localStorage??={getItem:()=>null,setItem:()=>{}};
 const {dictionary}=await import('../public/i18n.js');
 const src=readFileSync(path.join(root,'public','backups-view.js'),'utf8');
 const fields=/const FIELDS=\{([^}]*)\}/.exec(src)[1];
 const words=[...fields.matchAll(/:'([^']+)'/g)].map(m=>m[1]);
 assert.ok(words.length>15);
 assert.deepEqual(words.filter(w=>!Object.hasOwn(dictionary,w)),[]);
});

