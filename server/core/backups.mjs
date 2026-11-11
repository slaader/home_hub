// Core module "backup-jobs": scheduled backups that the hub runs itself. The hub connects to a target
// (any SSH host with a shell and rsync: a NAS, a server) and to the sources (a path on the hub, or on another SSH
// host), and makes one hard-linked snapshot per run (server/backup-runner.mjs). Jobs are made in a wizard in the
// web UI and kept in <state>/backup-jobs/jobs.json; each job's SSH key is in its own directory under private/.
//
// Who may do what:
//   read                  see jobs, runs, snapshots and logs (GET routes, MCP backup_jobs_list)
//   backup-jobs:manage    run now, cancel, delete a snapshot (people whose role holds it, API keys with it)
//   administrator         everything that decides where data is read from and sent to: create, edit, test,
//                         confirm host keys, delete a job. Password sign-in only, never an API key, because a
//                         job can copy any file the hub can read to any machine it names.
// Paths are /api/backup-jobs…: /api/backups… belongs to whatever a household's plugin may serve there.
import os from 'node:os';
import path from 'node:path';
import {readJobs,writeJobs,newJob,applyUpdate,jobHash,missing,complete,isBackupError,BackupError,JOB_ID,JOB_LIMIT,UPDATE_FIELDS,nextRun,SNAPSHOT} from '../backup-config.mjs';
import {createBackupRunner,createBackupScheduler,createKey,publicKey,removeKey,authorizedKeys,hubAddress,errorMessage,warningMessage,pinFrom,scanHostKeys,guardSource,BACKUP_ERRORS} from '../backup-runner.mjs';
import {expandHome} from '../backup-config.mjs';
import {tx} from '../text.mjs';
import {FACETS_POINT,machineForHost} from '../machine-facets.mjs';
import {HOW,PROMPTS} from '../machine-facet-sources.mjs';

export const BACKUP_INTEGRATION='backup-jobs.runner';
export const MANAGE_SCOPE='backup-jobs:manage';
const STATUS={invalid:400,conflict:409,'not-found':404,limit:409,unreadable:500,incomplete:409,busy:409,locked:409,'not-running':409,'no-key':409,'key-failed':500,'no-tool':500,
 'path-space':500,'keyscan-failed':502,'host-key-unknown':409,'host-key-changed':409,'fingerprint-mismatch':409,'snapshot-missing':404,
 'source-protected':400,'dest-shared':409,'dest-owned':409,'history-unreadable':500};
const reply=(c,e)=>{
 if(!isBackupError(e))throw e;
 const code=`BACKUP_${e.code.replace(/-/g,'_').toUpperCase()}`;
 return c.json(STATUS[e.code]||502,{error:{code,message:errorMessage(e.code),reason:e.code,...(e.detail&&e.code==='invalid'?{details:[e.detail]}:{}),...(e.field?{field:e.field}:{})}});
};
const adminOnly=c=>{if(c.canAdmin)return false;c.error(403,'ADMIN_REQUIRED','Backup jobs are set up by an administrator signed in with a password: a job decides what is read and where it is sent.');return true;};
const off=c=>{if(c.hub.integrationEnabled(BACKUP_INTEGRATION))return false;c.json(409,{error:{code:'INTEGRATION_DISABLED',message:'Backups are turned off on Administration → Integrations.'},disabled:c.hub.integrationDisabled(BACKUP_INTEGRATION)});return true;};
const by=c=>c.principal?.username||null;

export function createBackups(hub){
 const o=hub.options;
 const stateDirectory=o.backupStateDirectory||path.join(hub.stateDirectory,'backup-jobs');
 const keysDirectory=o.backupKeysDirectory||process.env.BACKUP_KEYS_DIR||path.join(hub.root,'private','backup-jobs');
 const file=path.join(stateDirectory,'jobs.json');
 const tools=o.backupTools||null;
 const timeZone=()=>hub.site.timeZone||undefined;
 const stagingDirectory=o.backupStagingDirectory||process.env.BACKUP_STAGING_DIR||null;
 // What a local source may never be (the keys, the backup state and staging) and what is always left out of one
 // that contains it (those, and the hub's whole private/ directory).
 const privateDirectory=o.backupPrivateDirectory||path.join(hub.root,'private');
 const own=[keysDirectory,stateDirectory,...(stagingDirectory?[stagingDirectory]:[])];
 const protect={reject:own,exclude:[...own,privateDirectory]};
 const runner=createBackupRunner({stateDirectory,keysDirectory,tools,spawnImpl:o.backupSpawn,stagingDirectory,protect,sshTimeoutMs:o.backupSshTimeoutMs,now:o.backupNow||(()=>new Date())});
 // One change at a time to jobs.json: read, change, write. A stale base is refused (refetch, never force).
 let queue=Promise.resolve();
 const change=fn=>{const op=queue.then(async()=>{const jobs=readJobs(file);const out=await fn(jobs);if(out?.write!==false)await writeJobs(file,out?.jobs||jobs);return out?.result;});queue=op.catch(()=>{});return op.then(r=>{scheduler.arm().catch(()=>{});return r;});};
 const find=(jobs,id)=>{const job=typeof id==='string'&&JOB_ID.test(id)?jobs.find(j=>j.id===id):null;if(!job)throw new BackupError('not-found');return job;};
 const scheduler=createBackupScheduler({jobs:async()=>{try{return readJobs(file);}catch{return [];}},runner,timeZone,enabled:()=>hub.integrationEnabled(BACKUP_INTEGRATION),
  now:o.backupNow||(()=>new Date()),setTimer:o.backupSetTimer||setTimeout,clearTimer:o.backupClearTimer||clearTimeout,catchUpDelayMs:o.backupCatchUpDelayMs,log:m=>console.error(m)});
 const address=()=>o.backupHubAddress!==undefined?o.backupHubAddress:hubAddress(hub.site.lanCidrs||[]);
 return {file,stateDirectory,keysDirectory,protect,runner,scheduler,change,find,address,jobs:()=>readJobs(file),timeZone};
}

// ---- what the API says about a job ---------------------------------------------------------------
const pinView=k=>k?{type:k.type,fingerprint:k.fingerprint,pinnedAt:k.pinnedAt,pinnedBy:k.pinnedBy}:null;
function jobView(job){
 return {id:job.id,name:job.name,enabled:job.enabled,createdAt:job.createdAt,updatedAt:job.updatedAt,
  target:job.target?{host:job.target.host,port:job.target.port,user:job.target.user,path:job.target.path,hostKey:pinView(job.target.hostKey)}:null,
  sources:job.sources.map(s=>s.kind==='local'?{name:s.name,kind:'local',path:s.path}:{name:s.name,kind:'ssh',host:s.host,port:s.port,user:s.user,path:s.path,hostKey:pinView(s.hostKey)}),
  excludes:[...job.excludes],schedule:{...job.schedule},retention:{...job.retention},timeoutMinutes:job.timeoutMinutes,hash:jobHash(job),missing:missing(job)};
}
const runView=r=>({id:r.id,trigger:r.trigger,by:r.by??null,startedAt:r.startedAt,finishedAt:r.finishedAt,durationMs:r.durationMs,result:r.result,error:r.error??null,
 ...(r.error?{message:errorMessage(r.error)}:{}),...(r.warnings?.length?{warnings:r.warnings,warningMessages:r.warnings.map(warningMessage)}:{}),
 snapshot:r.snapshot??null,deletedAt:r.deletedAt??null,stats:r.stats??null,pruned:r.pruned??[]});
// draft (not complete) | off (complete, not enabled) | running | ok | warning | failed | cancelled | interrupted | ready (never ran)
function stateOf(job,h,live){
 if(live)return 'running';if(!complete(job))return 'draft';if(!job.enabled)return 'off';
 return h.runs[0]?.result||'ready';
}
async function summary(b,job){
 const h=await b.runner.history(job.id),live=b.runner.status(job.id),last=h.runs[0]||null,ok=h.runs.find(r=>r.result==='ok'||r.result==='warning');
 return {...jobView(job),state:stateOf(job,h,live),running:live,
  nextRunAt:job.enabled&&complete(job)?(b.scheduler.next(job.id)||nextRun(job.schedule,new Date(),b.timeZone()))?.toISOString()??null:null,
  lastRun:last?runView(last):null,lastSuccessAt:ok?.finishedAt??null,sizeBytes:ok?.stats?.totalBytes??null,
  snapshots:h.snapshots.length,listedAt:h.listedAt,space:h.space,...(h.unreadable?{historyUnreadable:true}:{})};
}
async function detail(b,job){
 const h=await b.runner.history(job.id),pub=await publicKey(b.keysDirectory,job.id);
 return {job:await summary(b,job),publicKey:pub,authorizedKeys:authorizedKeys(pub,{address:b.address()}),
  runs:h.runs.slice(0,100).map(r=>({...runView(r),present:Boolean(r.snapshot&&h.snapshots.includes(r.snapshot)&&!r.deletedAt)})),
  // Snapshots on the target that no recorded run made (older history, made by hand) are listed too.
  snapshots:h.snapshots.map(name=>({name,run:h.runs.find(r=>r.snapshot===name)?.id??null}))};
}
// Machines of the site configuration, offered as suggestions in the wizard (free entry always works).
const suggestions=site=>site.machines.filter(m=>m.hostname||m.ip).map(m=>({id:m.id,name:m.name,host:m.hostname||m.ip,role:m.role,local:m.ssh?.alias==='local'}));

// ---- the integration card ----------------------------------------------------------------------------
const ITEM_STATE={ok:'ok',warning:'stale',failed:'error',cancelled:'stale',interrupted:'error',running:'ok',ready:'not-configured',draft:'not-configured',off:'off'};
// A run's result in words (source language; the card translates the list parameter word by word).
const RESULT_WORDS={ok:'hotovo',warning:'s varováním',failed:'chyba',cancelled:'zrušeno',interrupted:'přerušeno',running:'běží'};
async function integrationStatus(b,hub,{enabled=true}={}){
 const configuredBy=[{source:'ui',name:'#backup-jobs'},{source:'file',name:'state/backup-jobs/jobs.json'}];
 if(!enabled)return {state:'disabled',summary:'',configuredBy};
 let jobs;try{jobs=b.jobs();}catch{return {state:'error',summary:'Soubor s úlohami záloh nejde přečíst.',lastError:'unreadable',configuredBy};}
 if(!jobs.length)return {state:'not-configured',summary:'Zatím žádná úloha zálohy.',configuredBy};
 const items=await Promise.all(jobs.map(async job=>{const s=await summary(b,job);
  return {id:job.id,label:job.name,state:ITEM_STATE[s.state]||'error',
   summary:s.state==='draft'?'Rozpracovaná v průvodci.':s.state==='off'?'Vypnutá.':s.lastRun?tx('Poslední běh: {result}. Snímků na cíli: {n}.',{result:[RESULT_WORDS[s.lastRun.result]||s.lastRun.result],n:s.snapshots}):'Ještě neběžela.',
   lastSuccessAt:s.lastSuccessAt,...(s.lastRun?.error?{lastError:s.lastRun.error}:{})};}));
 const states=items.map(i=>i.state).filter(s=>s!=='off'&&s!=='not-configured');
 const state=!states.length?'not-configured':states.every(s=>s==='ok')?'ok':states.some(s=>s==='ok'||s==='stale')?'stale':'error';
 const last=items.map(i=>i.lastSuccessAt).filter(Boolean).sort().at(-1)||null;
 return {state,summary:tx('Úloh: {n}, aktivních: {active}.',{n:jobs.length,active:jobs.filter(j=>j.enabled&&complete(j)).length}),lastSuccessAt:last,configuredBy,items};
}

// Two jobs may not write into one directory, or one inside the other: they would prune each other's snapshots.
// Host names are compared as written (an IP and a name for one machine are caught by the owner marker instead).
const nested=(a,b)=>a===b||a.startsWith(b.endsWith('/')?b:b+'/')||b.startsWith(a.endsWith('/')?a:a+'/');
const sameDestination=(a,b)=>Boolean(a&&b&&a.host.toLowerCase()===b.host.toLowerCase()&&a.port===b.port&&nested(a.path,b.path));
const idOf=input=>input&&typeof input==='object'?input.id:undefined;
const partOf=input=>{const part=input?.part,index=input?.index??0;if(!['target','source'].includes(part)||!Number.isInteger(index)||index<0||index>20)throw new BackupError('invalid','part must be "target" or "source" (with index)');return {part,index};};

// Integrations → Machines: per machine, the jobs that store snapshots on it (target) and the jobs that back it up
// (an SSH source; a local source is the hub's own machine: the site machine with ssh.alias "local", else the one
// named like this host). A machine no job touches is "not configured". Read-only: job summaries as the page has them.
const JOB_WORD={ok:'v pořádku',warning:'s varováním',failed:'selhala',cancelled:'zrušená',interrupted:'přerušená',running:'běží',ready:'připravená',draft:'rozpracovaná',off:'vypnutá'};
async function backupFacet(b,hub,machines){
 const report={id:'backups',title:'Zálohy',icon:'archive',order:20,page:'backup-jobs',how:HOW.backups,prompt:PROMPTS.backups,
  howTo:'Žádná úloha záloh na tenhle stroj neukládá ani ho nezálohuje. Založ ji na stránce Zálohování.',machines:{}};
 if(!hub.integrationEnabled(BACKUP_INTEGRATION))return {...report,off:true};
 let jobs=[];try{jobs=b.jobs();}catch{return report;}
 const local=hub.site.machines.find(m=>m.ssh?.alias==='local')?.id||machineForHost(machines,os.hostname())?.id||null;
 const per=new Map(),add=(id,line)=>{if(!id)return;if(!per.has(id))per.set(id,[]);per.get(id).push(line);};
 for(const job of jobs){
  const s=await summary(b,job).catch(()=>null);if(!s)continue;
  const line={job:job.name,state:ITEM_STATE[s.state]||'error',word:JOB_WORD[s.state]||s.state};
  if(job.target?.host)add(machineForHost(machines,job.target.host)?.id,{...line,role:'target'});
  for(const src of job.sources||[])add(src.kind==='ssh'?machineForHost(machines,src.host)?.id:local,{...line,role:'source'});
 }
 for(const [id,lines] of per){
  // A failed job first, then one with a warning; only drafts and unfinished jobs: it wants finishing.
  const worst=['error','stale','ok','off'].find(x=>lines.some(l=>l.state===x))||'warn';
  const target=lines.some(l=>l.role==='target'),source=lines.some(l=>l.role==='source');
  report.machines[id]={state:worst,href:'#backup-jobs',
   summary:target&&source?'Ukládají se sem zálohy a sám je zálohovaný.':target?'Ukládají se sem zálohy.':'Je zálohovaný.',
   details:lines.map(l=>({label:l.role==='target'?'Cíl úlohy':'Zdroj úlohy',value:tx('{job}: {state}',{job:l.job,state:[l.word]})}))};
 }
 return report;
}

export default {
 id:'backup-jobs',title:'Backups',
 provides:{[FACETS_POINT]:(b,hub)=>machines=>backupFacet(b,hub,machines)},
 assets:['backups-view.js','backups-wizard.js','backups.css','i18n-en-backups.js'],
 nav:[{groupKey:'Domov',hash:'backup-jobs',labelKey:'Zálohování',view:'backups-view.js#backupsPage',order:14,icon:'archive'}],
 setup:hub=>createBackups(hub),
 pollers:[{id:'scheduler',start:(b,hub)=>{
   // First what a stopped hub left behind (runs still "running", a stale lock and its child), then the schedule.
   b.startup=(async()=>{let ids=[];try{ids=b.jobs().map(j=>j.id);}catch{}await b.runner.recover(ids);await b.scheduler.start();})()
    .catch(e=>console.error('Backup scheduler failed to start:',e.message));
   if(typeof hub.onIntegrationChange==='function')b.unsubscribe=hub.onIntegrationChange(e=>{if(e.id===BACKUP_INTEGRATION)b.scheduler.arm().catch(()=>{});});
  },
  // The hub is stopping (SIGTERM, SIGINT): runs end as "interrupted", their rsync and ssh are stopped, records written.
  stop:async b=>{await b.startup?.catch(()=>{});b.scheduler.stop();b.unsubscribe?.();await b.runner.shutdown();}}],
 routes:[
  {method:'GET',path:'/api/backup-jobs',async handler(c){
    const b=c.state,disabled=c.hub.integrationEnabled(BACKUP_INTEGRATION)?null:c.hub.integrationDisabled(BACKUP_INTEGRATION);
    let jobs;try{jobs=b.jobs();}catch(e){return reply(c,e);}
    return c.json(200,{schemaVersion:1,generatedAt:new Date().toISOString(),timeZone:b.timeZone()||null,...(disabled?{disabled}:{}),
     jobs:await Promise.all(jobs.map(j=>summary(b,j))),suggestions:suggestions(c.hub.site),canManage:c.canAdmin,
     hubHost:os.hostname(),limits:{jobs:JOB_LIMIT}});}},
  {method:'GET',path:'/api/backup-jobs/detail',async handler(c){
    try{const job=c.state.find(c.state.jobs(),c.query.id);return c.json(200,{...await detail(c.state,job),canManage:c.canAdmin,
     ...(c.hub.integrationEnabled(BACKUP_INTEGRATION)?{}:{disabled:c.hub.integrationDisabled(BACKUP_INTEGRATION)})});}catch(e){return reply(c,e);}}},
  // One run's log, as plain text (bounded by the runner). The private key never appears in it.
  {method:'GET',path:'/api/backup-jobs/log',async handler(c){
    try{c.state.find(c.state.jobs(),c.query.id);}catch(e){return reply(c,e);}
    const text=await c.state.runner.readLog(c.query.id,String(c.query.run||''));
    if(text===null)return c.error(404,'BACKUP_LOG_MISSING','No log for that run.');
    c.res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Content-Disposition':'inline'});return c.res.end(text);}},
  // ---- setting up (administrator) ----
  {method:'POST',path:'/api/backup-jobs/create',scope:MANAGE_SCOPE,async handler(c){
    if(adminOnly(c))return;
    try{
     const job=await c.state.change(async jobs=>{
      if(jobs.length>=JOB_LIMIT)throw new BackupError('limit');
      const j=newJob({name:c.input?.name||'Záloha',taken:jobs.map(x=>x.id)});
      await createKey(c.state.keysDirectory,j.id,{tools:c.state.runner.tools,spawnImpl:c.hub.options.backupSpawn});
      return {jobs:[...jobs,j],result:j};});
     c.subject=job.id;
     await c.hub.accessStore.record?.('backup-job-created',{id:job.id,name:job.name},{by:by(c)}).catch(()=>{});
     return c.json(201,await detail(c.state,job));
    }catch(e){return reply(c,e);}}},
  {method:'POST',path:'/api/backup-jobs/update',scope:MANAGE_SCOPE,bodyLimit:32768,async handler(c){
    if(adminOnly(c))return;
    try{
     const input=c.input;if(!input||typeof input!=='object'||Array.isArray(input))throw new BackupError('invalid','send {id, base, …changes}');
     const extra=Object.keys(input).filter(k=>!['id','base',...UPDATE_FIELDS].includes(k));if(extra.length)throw new BackupError('invalid',`unknown field(s): ${extra.join(', ')}`);
     if(c.state.runner.status(input.id))throw new BackupError('busy');
     const job=await c.state.change(async jobs=>{
      const was=c.state.find(jobs,input.id);
      if(input.base!==jobHash(was))throw new BackupError('conflict');
      const next={...applyUpdate(was,input),updatedAt:new Date().toISOString()};
      if(next.target&&jobs.some(j=>j.id!==next.id&&sameDestination(j.target,next.target)))throw new BackupError('dest-shared');
      for(const s of next.sources)if(s.kind==='local')await guardSource(expandHome(s.path),c.state.protect);
      return {jobs:jobs.map(j=>j.id===was.id?next:j),result:next};});
     return c.json(200,await detail(c.state,job));
    }catch(e){return reply(c,e);}}},
  // Step one of trust on first use: what the host shows, or (once pinned) the checks over SSH.
  {method:'POST',path:'/api/backup-jobs/test',scope:MANAGE_SCOPE,async handler(c){
    if(adminOnly(c)||off(c))return;
    try{const job=c.state.find(c.state.jobs(),idOf(c.input));const {part,index}=partOf(c.input);
     const result=await c.state.runner.test(job,{part,index});
     return c.json(200,{result:{...result,...(result.error?{message:errorMessage(result.error)}:{})}});}
    catch(e){return reply(c,e);}}},
  // Step two: the person compared the fingerprint and confirms it. The host is scanned again and only a key
  // with exactly that fingerprint is pinned; from then on a different key is refused.
  {method:'POST',path:'/api/backup-jobs/trust',scope:MANAGE_SCOPE,async handler(c){
    if(adminOnly(c)||off(c))return;
    try{
     if(c.state.runner.status(idOf(c.input)))throw new BackupError('busy');
     const {part,index}=partOf(c.input),fp=c.input?.fingerprint;
     if(typeof fp!=='string'||!/^SHA256:[A-Za-z0-9+/]{43}$/.test(fp))throw new BackupError('invalid','fingerprint must be SHA256:… as shown');
     const before=c.state.find(c.state.jobs(),idOf(c.input)),h=part==='target'?before.target:before.sources[index];
     if(!h||h.kind==='local')throw new BackupError('invalid','that part has no SSH host');
     const keys=await scanHostKeys(h,{tools:c.state.runner.tools,spawnImpl:c.hub.options.backupSpawn});
     const pin=pinFrom(keys,fp,by(c));if(!pin)throw new BackupError('fingerprint-mismatch');
     const job=await c.state.change(jobs=>{
      const was=c.state.find(jobs,before.id),next=structuredClone(was);
      const at=part==='target'?next.target:next.sources[index];
      if(!at||at.host!==h.host||at.port!==h.port)throw new BackupError('conflict');
      at.hostKey=pin;next.updatedAt=new Date().toISOString();
      return {jobs:jobs.map(j=>j.id===was.id?next:j),result:next};});
     await c.hub.accessStore.record?.('backup-host-key-pinned',{id:job.id,name:job.name},{by:by(c),detail:`${h.host}:${h.port} ${pin.fingerprint}`}).catch(()=>{});
     return c.json(200,await detail(c.state,job));
    }catch(e){return reply(c,e);}}},
  {method:'POST',path:'/api/backup-jobs/delete',scope:MANAGE_SCOPE,async handler(c){
    if(adminOnly(c))return;
    try{
     // History and staging go first, inside the change: when that fails (a run started) the job stays listed.
     const job=await c.state.change(async jobs=>{const was=c.state.find(jobs,idOf(c.input));if(c.input.base!==jobHash(was))throw new BackupError('conflict');
      await c.state.runner.forget(was.id);return {jobs:jobs.filter(j=>j.id!==was.id),result:was};});
     await removeKey(c.state.keysDirectory,job.id);
     await c.hub.accessStore.record?.('backup-job-deleted',{id:job.id,name:job.name},{by:by(c)}).catch(()=>{});
     // The snapshots stay on the target: deleting a job never deletes backups.
     return c.json(200,{deleted:job.id});
    }catch(e){return reply(c,e);}}},
  // ---- running (backup-jobs:manage) ----
  {method:'POST',path:'/api/backup-jobs/run',scope:MANAGE_SCOPE,async handler(c){
    if(off(c))return;
    try{const job=c.state.find(c.state.jobs(),idOf(c.input));const started=await c.state.runner.start(job,{trigger:'manual',by:by(c)});return c.json(202,{started});}
    catch(e){return reply(c,e);}}},
  {method:'POST',path:'/api/backup-jobs/cancel',scope:MANAGE_SCOPE,async handler(c){
    try{const job=c.state.find(c.state.jobs(),idOf(c.input));return c.json(200,{cancelled:c.state.runner.cancel(job.id)});}
    catch(e){return reply(c,e);}}},
  {method:'POST',path:'/api/backup-jobs/delete-snapshot',scope:MANAGE_SCOPE,async handler(c){
    if(off(c))return;
    try{const job=c.state.find(c.state.jobs(),idOf(c.input));const name=c.input?.snapshot;
     if(typeof name!=='string'||!SNAPSHOT.test(name))throw new BackupError('invalid','snapshot must be a snapshot name such as 2026-11-11T023000Z');
     const out=await c.state.runner.deleteSnapshot(job,name);
     await c.hub.accessStore.record?.('backup-snapshot-deleted',{id:job.id,name:job.name},{by:by(c),detail:name}).catch(()=>{});
     return c.json(200,out);}
    catch(e){return reply(c,e);}}},
  {method:'POST',path:'/api/backup-jobs/refresh',scope:MANAGE_SCOPE,async handler(c){
    if(off(c))return;
    try{const job=c.state.find(c.state.jobs(),idOf(c.input));if(!complete(job))throw new BackupError('incomplete');return c.json(200,await c.state.runner.refresh(job));}
    catch(e){return reply(c,e);}}},
 ],
 integrations:[{id:BACKUP_INTEGRATION,title:'Zálohování',kind:'storage',
  description:'Zálohy, které hub spouští sám: rsync přes SSH na cílový stroj (NAS, server), jeden snímek na běh. Vypnuté: plánovač nic nespustí, nic se nedohání a zálohu nejde spustit ručně; úlohy i snímky zůstanou.',
  howTo:'Založ úlohu v průvodci na stránce Zálohování.',page:'backup-jobs',docs:'docs/API.md → Backup jobs',
  status:(b,hub,opts)=>integrationStatus(b,hub,opts)}],
 mcpInstructions:'Backups the hub runs itself: backup_jobs_list returns each job with its state, last run, next run and snapshot count. Jobs are set up by an administrator in the web UI.',
 mcpTools:[{name:'backup_jobs_list',scope:'read',title:'Backups: list jobs',
  description:'The backup jobs this Home Hub runs (rsync over SSH to a target machine, one hard-linked snapshot per run): for each job its target and sources, schedule (site time zone), retention, state (draft, off, ready, running, ok, warning, failed, cancelled), last run with its result and statistics, next scheduled run, last success, logical size of the newest snapshot and the number of snapshots on the target. Read-only.',
  inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,openWorldHint:false},
  run:async(args,{state})=>({timeZone:state.timeZone()||null,jobs:await Promise.all(state.jobs().map(j=>summary(state,j)))})}],
 apiDocs:[{title:'Zálohování',routes:[
  ['GET','/api/backup-jobs','read','Úlohy záloh se stavem, posledním a příštím během, velikostí a počtem snímků; návrhy strojů pro průvodce.'],
  ['GET','/api/backup-jobs/detail?id=…','read','Jedna úloha: nastavení, veřejný klíč a řádek do authorized_keys, běhy a snímky na cíli.'],
  ['GET','/api/backup-jobs/log?id=…&run=…','read','Záznam jednoho běhu (text, omezená velikost).'],
  ['POST','/api/backup-jobs/create','admin','{name}: nová rozpracovaná úloha s vlastním klíčem ed25519.'],
  ['POST','/api/backup-jobs/update','admin','{id, base, target?, sources?, excludes?, schedule?, retention?, timeoutMinutes?, enabled?, name?}: změna s kontrolou otisku.'],
  ['POST','/api/backup-jobs/test','admin','{id, part, index?}: klíč hostitele, pak SSH, cílový adresář, zápis, rsync a volné místo.'],
  ['POST','/api/backup-jobs/trust','admin','{id, part, index?, fingerprint}: připnout potvrzený klíč hostitele.'],
  ['POST','/api/backup-jobs/delete','admin','{id, base}: smazat úlohu a její klíč; snímky na cíli zůstanou.'],
  ['POST','/api/backup-jobs/run','backup-jobs:manage','{id}: spustit zálohu teď (202).'],
  ['POST','/api/backup-jobs/cancel','backup-jobs:manage','{id}: zrušit běžící zálohu.'],
  ['POST','/api/backup-jobs/delete-snapshot','backup-jobs:manage','{id, snapshot}: smazat jeden snímek na cíli.'],
  ['POST','/api/backup-jobs/refresh','backup-jobs:manage','{id}: znovu načíst seznam snímků a volné místo z cíle.']]}],
};
export {BACKUP_ERRORS};
