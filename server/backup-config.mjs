// Backup jobs: what a job is, how its input is validated, where it is kept, and the pure rules the runner and
// the scheduler follow (next run in the site's time zone, which snapshots retention keeps, what rsync reported).
// Nothing in this file spawns a process or opens a connection: server/backup-runner.mjs does that.
//
// A job (data/state/backup-jobs/jobs.json, written atomically, 0600):
//   {id, name, enabled, createdAt, updatedAt,
//    target:  {host, port, user, path, hostKey},          the machine that stores the snapshots (any SSH host)
//    sources: [{name, kind: "local" | "ssh", path, host?, port?, user?, hostKey?}],
//    excludes: ["*.tmp", …], schedule: {mode: "daily" | "weekly" | "manual", time: "HH:MM", days: [1..7]},
//    retention: {keepLast, keepDays}, timeoutMinutes}
// hostKey is the pinned SSH host key ({type, key, fingerprint, pinnedAt, pinnedBy}) once a person confirmed its
// fingerprint (trust on first use); from then on every connection checks it strictly.
// Secrets are never here: the job's private key lives in its own directory under private/ (server/backup-runner.mjs).
import {readFileSync,existsSync} from 'node:fs';
import {mkdir,writeFile,rename} from 'node:fs/promises';
import {createHash,randomBytes} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {secretIn} from './home-devices.mjs';

export const JOB_ID=/^bj-[a-z0-9]{8}$/;
export const SNAPSHOT=/^\d{4}-\d{2}-\d{2}T\d{6}Z$/;
export const SOURCE_NAME=/^[a-z0-9][a-z0-9._-]{0,39}$/;
export const JOB_LIMIT=20,SOURCE_LIMIT=10,EXCLUDE_LIMIT=50;
export const SCHEDULE_MODES=Object.freeze(['daily','weekly','manual']);
export const DEFAULT_RETENTION=Object.freeze({keepLast:14,keepDays:0});
export const DEFAULT_SCHEDULE=Object.freeze({mode:'daily',time:'02:30',days:[]});
export const DEFAULT_TIMEOUT_MINUTES=360;

// A host name or an IPv4 address. Letters, digits, dot and dash; it never starts with "-", so ssh cannot read
// it as an option. It only ever lands in the job's own ssh_config, never on a command line.
const HOST=/^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}))*$/;
const USER=/^[A-Za-z_][A-Za-z0-9._-]{0,31}$/;
// A remote path is handed to a remote shell (quoted) and to rsync, whose remote-path handling differs between
// versions; it stays in a charset where no version splits or expands it: no spaces, quotes, $, `, \ or globs.
const REMOTE_PATH=/^\/[A-Za-z0-9._/@+=,:%~-]*$/;
// A path on the hub itself goes to rsync as one argument (no shell), so spaces are fine; control characters are not.
const LOCAL_PATH=/^(?:\/|~\/)[^\u0000-\u001f\u007f]*$/;
const TIME=/^([01]\d|2[0-3]):([0-5]\d)$/;

// detail: an English sentence for agents and logs; field: which input it is about (the wizard names it in its own words).
export class BackupError extends Error{constructor(code,detail,field){super(code);this.code=code;if(detail)this.detail=detail;if(field)this.field=field;}}
export const isBackupError=e=>e instanceof BackupError;
// The field an error is about: the first word of the detail ("target.path must …" → target.path).
const invalid=detail=>{const m=/^([a-zA-Z]+(?:\[\d+\])?(?:\.[a-zA-Z]+)?)\b/.exec(detail||'');throw new BackupError('invalid',detail,m?m[1]:undefined);};
const plain=v=>v&&typeof v==='object'&&!Array.isArray(v);
const only=(v,keys,where)=>{if(!plain(v))invalid(`${where} must be an object`);const extra=Object.keys(v).filter(k=>!keys.includes(k));if(extra.length)invalid(`${where} has unknown field(s): ${extra.join(', ')}`);return v;};
const noSecret=(v,where)=>{const why=secretIn(v);if(why)invalid(`${where} looks like ${why}; secrets never go in a backup job`);return v;};
// Paths and exclude patterns: only what is unmistakably a credential. A long hex name (a content-addressed store,
// a git object, a hash-named cache) is a normal path, not a secret.
const PATH_SECRETS=[[/-----BEGIN [A-Z ]*PRIVATE KEY-----/,'a private key block'],[/\bhhk?_[a-f0-9]{64}\b/i,'a Home Hub access key'],[/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,'a JWT'],
 [/\b(password|passwd|pwd|secret|token|api[_-]?key)\s*[=:]\s*\S{6,}/i,'an assignment of a secret'],[/:\/\/[^/\s:@]+:[^/\s@]+@/,'credentials in a URL'],[/\b(ghp|gho|ghs|github_pat|glpat|xox[abpr])[-_][A-Za-z0-9_-]{10,}/,'an access token']];
const noPathSecret=(v,where)=>{const hit=PATH_SECRETS.find(([re])=>re.test(v));if(hit)invalid(`${where} looks like ${hit[1]}; secrets never go in a backup job`);return v;};
const text=(v,max,where,{empty=false}={})=>{if(typeof v!=='string'||v.length>max||/[\u0000-\u001f\u007f]/.test(v)||(!empty&&!v.trim()))invalid(`${where} must be a text of 1 to ${max} characters`);return noSecret(v.trim(),where);};
const noDots=(p,where)=>{if(p.split('/').some(s=>s==='..'||s==='.'))invalid(`${where} must not contain "." or ".." segments`);return p;};

export const validHost=v=>typeof v==='string'&&HOST.test(v)&&!v.includes('..');
export function remotePath(v,where,{root=false}={}){
 if(typeof v!=='string'||v.length>1024||!REMOTE_PATH.test(v))invalid(`${where} must be an absolute path (letters, digits and . _ / @ + = , : % ~ -; no spaces)`);
 const p=noDots(v.length>1?v.replace(/\/+$/,''):v,where).replace(/\/{2,}/g,'/');
 if(!root&&p==='/')invalid(`${where} must not be the root directory`);
 return noPathSecret(p,where);
}
export function localPath(v,where){
 if(typeof v!=='string'||v.length>1024||!(LOCAL_PATH.test(v)||v==='~'))invalid(`${where} must be an absolute path or start with ~/`);
 return noPathSecret(noDots(v.length>1?v.replace(/\/+$/,''):v,where).replace(/\/{2,}/g,'/'),where);
}
const port=(v,where)=>{const n=v===undefined||v===null||v===''?22:Number(v);if(!Number.isInteger(n)||n<1||n>65535)invalid(`${where} must be a port number 1–65535`);return n;};
const host=(v,where)=>{if(!validHost(v))invalid(`${where} must be a host name or an IPv4 address`);return v.toLowerCase();};
const user=(v,where)=>{if(typeof v!=='string'||!USER.test(v))invalid(`${where} must be a user name (letters, digits, . _ -)`);return v;};

// A pinned host key as stored. Only the runner writes one (after a person confirmed the fingerprint).
const KEY_TYPE=/^(ssh-ed25519|ecdsa-sha2-nistp(256|384|521)|ssh-rsa)$/;
export function hostKeyOf(v){
 if(!plain(v)||!KEY_TYPE.test(v.type)||typeof v.key!=='string'||!/^[A-Za-z0-9+/]{40,2000}={0,2}$/.test(v.key))return null;
 return {type:v.type,key:v.key,fingerprint:fingerprint(v.key),pinnedAt:typeof v.pinnedAt==='string'?v.pinnedAt:null,pinnedBy:typeof v.pinnedBy==='string'?v.pinnedBy.slice(0,64):null};
}
// SHA256:… as ssh-keygen -l prints it: the hash of the key blob, base64 without padding.
export const fingerprint=key=>'SHA256:'+createHash('sha256').update(Buffer.from(key,'base64')).digest('base64').replace(/=+$/,'');

// ---- one job's parts -------------------------------------------------------------------------------
// Each validator takes what the browser sent and the job as it is (to keep a pinned key when the host did not change).
export function targetInput(raw,current=null){
 only(raw,['host','port','user','path'],'target');
 const t={host:host(raw.host,'target.host'),port:port(raw.port,'target.port'),user:user(raw.user,'target.user'),path:remotePath(raw.path,'target.path')};
 // A pin belongs to host and port: change either and the key must be confirmed again.
 t.hostKey=current&&current.host===t.host&&current.port===t.port?current.hostKey??null:null;
 return t;
}
// name-2, name-3 …, shortened so the suffix always fits in 40 characters.
const uniqueName=(name,taken)=>{for(let n=2;;n++){const suffix=`-${n}`,candidate=name.slice(0,40-suffix.length).replace(/[-._]+$/,'')+suffix;if(!taken.has(candidate)&&SOURCE_NAME.test(candidate))return candidate;}};
const defaultName=p=>{const base=path.posix.basename(p==='/'?'root':p).toLowerCase().replace(/[^a-z0-9._-]+/g,'-').replace(/^[^a-z0-9]+/,'').slice(0,40);return SOURCE_NAME.test(base)?base:'source';};
export function sourcesInput(raw,current=[]){
 if(!Array.isArray(raw)||raw.length>SOURCE_LIMIT)invalid(`sources must be a list of at most ${SOURCE_LIMIT}`);
 const names=new Set();
 return raw.map((s,i)=>{
  const where=`sources[${i}]`;only(s,['name','kind','path','host','port','user'],where);
  if(!['local','ssh'].includes(s.kind))invalid(`${where}.kind must be "local" (this hub) or "ssh" (another machine)`);
  const out=s.kind==='local'?{kind:'local',path:localPath(s.path,`${where}.path`)}:{kind:'ssh',host:host(s.host,`${where}.host`),port:port(s.port,`${where}.port`),user:user(s.user,`${where}.user`),path:remotePath(s.path,`${where}.path`,{root:true})};
  let name=s.name===undefined||s.name===''?defaultName(out.path):s.name;
  if(typeof name!=='string'||!SOURCE_NAME.test(name))invalid(`${where}.name must be a short folder name (a-z, 0-9, . _ -)`);
  if(names.has(name)){if(s.name)invalid(`${where}.name "${name}" is used twice`);name=uniqueName(name,names);}
  names.add(name);
  if(out.kind==='ssh'){const was=current.find(c=>c.kind==='ssh'&&c.host===out.host&&c.port===out.port);out.hostKey=was?.hostKey??null;}
  return {name,...out};
 });
}
// ~ and ~/x on the hub: the home of the user the hub runs as.
export const expandHome=(p,home=os.homedir())=>p==='~'?home:p.startsWith('~/')?path.join(home,p.slice(2)):p;
export function excludesInput(raw){
 if(!Array.isArray(raw)||raw.length>EXCLUDE_LIMIT)invalid(`excludes must be a list of at most ${EXCLUDE_LIMIT} patterns`);
 const out=[];
 for(const [i,p] of raw.entries()){if(typeof p!=='string'||p.length>200||/[\u0000-\u001f\u007f]/.test(p)||!p.trim())invalid(`excludes[${i}] must be a pattern of 1 to 200 characters`);const v=noPathSecret(p.trim(),`excludes[${i}]`);if(v.startsWith('-'))invalid(`excludes[${i}] must not start with "-"`);if(!out.includes(v))out.push(v);}
 return out;
}
export function scheduleInput(raw){
 only(raw,['mode','time','days'],'schedule');
 if(!SCHEDULE_MODES.includes(raw.mode))invalid(`schedule.mode must be one of ${SCHEDULE_MODES.join(', ')}`);
 if(raw.mode==='manual')return {mode:'manual',time:typeof raw.time==='string'&&TIME.test(raw.time)?raw.time:DEFAULT_SCHEDULE.time,days:[]};
 if(typeof raw.time!=='string'||!TIME.test(raw.time))invalid('schedule.time must be HH:MM (24-hour clock, the site time zone)');
 let days=[];
 if(raw.mode==='weekly'){
  if(!Array.isArray(raw.days)||!raw.days.length||raw.days.some(d=>!Number.isInteger(d)||d<1||d>7))invalid('schedule.days must list weekdays 1 (Monday) to 7 (Sunday)');
  days=[...new Set(raw.days)].sort();
 }
 return {mode:raw.mode,time:raw.time,days};
}
export function retentionInput(raw){
 only(raw,['keepLast','keepDays'],'retention');
 const n=(v,max,where)=>{const x=v===undefined||v===null||v===''?0:Number(v);if(!Number.isInteger(x)||x<0||x>max)invalid(`${where} must be a whole number 0–${max}`);return x;};
 const keepLast=n(raw.keepLast,1000,'retention.keepLast'),keepDays=n(raw.keepDays,3650,'retention.keepDays');
 if(!keepLast&&!keepDays)invalid('retention needs keepLast or keepDays (keeping everything forever would fill the target)');
 return {keepLast,keepDays};
}
const timeoutInput=v=>{const n=Number(v);if(!Number.isInteger(n)||n<5||n>2880)invalid('timeoutMinutes must be 5–2880');return n;};

// The change a wizard step sends → the job after it. Only the parts present are replaced.
export const UPDATE_FIELDS=Object.freeze(['name','enabled','target','sources','excludes','schedule','retention','timeoutMinutes']);
export function applyUpdate(job,input){
 const next=structuredClone(job);
 if(input.name!==undefined)next.name=text(input.name,80,'name');
 if(input.target!==undefined)next.target=targetInput(input.target,job.target);
 if(input.sources!==undefined)next.sources=sourcesInput(input.sources,job.sources);
 if(input.excludes!==undefined)next.excludes=excludesInput(input.excludes);
 if(input.schedule!==undefined)next.schedule=scheduleInput(input.schedule);
 if(input.retention!==undefined)next.retention=retentionInput(input.retention);
 if(input.timeoutMinutes!==undefined)next.timeoutMinutes=timeoutInput(input.timeoutMinutes);
 if(input.enabled!==undefined){if(typeof input.enabled!=='boolean')invalid('enabled must be true or false');next.enabled=input.enabled;}
 if(next.enabled&&missing(next).length)invalid(`the job cannot be enabled before it is complete: ${missing(next).join(', ')}`);
 return next;
}
// What a job still lacks before it can run.
// Codes: target | target-key | sources | source-key:<name> (the wizard says each in words).
export function missing(job){
 const out=[];
 if(!job.target)out.push('target');else if(!job.target.hostKey)out.push('target-key');
 if(!job.sources?.length)out.push('sources');
 for(const s of job.sources||[])if(s.kind==='ssh'&&!s.hostKey)out.push(`source-key:${s.name}`);
 return out;
}
export const complete=job=>missing(job).length===0;
export const jobHash=job=>createHash('sha256').update(JSON.stringify(job)).digest('hex');
export const newJobId=()=>'bj-'+[...randomBytes(8)].map(b=>'abcdefghijklmnopqrstuvwxyz0123456789'[b%36]).join('');
export function newJob({name,now=new Date(),taken=[]}={}){
 let id=newJobId();while(taken.includes(id))id=newJobId();
 return {id,name:text(name??'Záloha',80,'name'),enabled:false,createdAt:now.toISOString(),updatedAt:now.toISOString(),target:null,sources:[],excludes:['.DS_Store','.Trash/','*.tmp'],
  schedule:{...DEFAULT_SCHEDULE},retention:{...DEFAULT_RETENTION},timeoutMinutes:DEFAULT_TIMEOUT_MINUTES};
}

// ---- the store ---------------------------------------------------------------------------------------
// jobs.json: {schemaVersion: 1, jobs: [...]}. A missing file is no jobs; an unreadable one is an error (never
// silently replaced, so a typo by hand does not wipe every job).
export function readJobs(file){
 if(!existsSync(file))return [];
 let doc;try{doc=JSON.parse(readFileSync(file,'utf8'));}catch{throw new BackupError('unreadable');}
 if(!plain(doc)||!Array.isArray(doc.jobs))throw new BackupError('unreadable');
 return doc.jobs.filter(j=>plain(j)&&JOB_ID.test(j.id)).map(normalizeJob);
}
// What jobs.json says is checked with the same validators as the wizard's input: a part that fails (a host with a
// newline, a path with a quote, written by hand) is dropped, so the job reads as incomplete and never reaches an
// ssh_config or a remote script. Source names stay unique.
const tryOr=(fn,fallback)=>{try{return fn();}catch{return fallback;}};
function normalizeJob(j){
 const target=plain(j.target)?tryOr(()=>({...targetInput({host:j.target.host,port:j.target.port,user:j.target.user,path:j.target.path}),hostKey:hostKeyOf(j.target.hostKey)}),null):null;
 const names=new Set();
 const sources=(Array.isArray(j.sources)?j.sources:[]).filter(s=>plain(s)&&typeof s.name==='string'&&SOURCE_NAME.test(s.name)&&['local','ssh'].includes(s.kind)).flatMap(s=>{
  if(names.has(s.name))return [];
  const ok=tryOr(()=>sourcesInput([s.kind==='local'?{kind:'local',path:s.path,name:s.name}:{kind:'ssh',host:s.host,port:s.port,user:s.user,path:s.path,name:s.name}])[0],null);
  if(!ok)return [];names.add(ok.name);
  return [ok.kind==='ssh'?{...ok,hostKey:hostKeyOf(s.hostKey)}:ok];});
 const schedule=SCHEDULE_MODES.includes(j.schedule?.mode)?{mode:j.schedule.mode,time:TIME.test(j.schedule.time)?j.schedule.time:DEFAULT_SCHEDULE.time,days:Array.isArray(j.schedule.days)?j.schedule.days.filter(d=>Number.isInteger(d)&&d>=1&&d<=7):[]}:{...DEFAULT_SCHEDULE};
 const retention=tryOr(()=>retentionInput({keepLast:j.retention?.keepLast??DEFAULT_RETENTION.keepLast,keepDays:j.retention?.keepDays??0}),{...DEFAULT_RETENTION});
 return {id:j.id,name:typeof j.name==='string'?j.name:j.id,enabled:j.enabled===true,createdAt:j.createdAt??null,updatedAt:j.updatedAt??null,target,sources,
  excludes:tryOr(()=>excludesInput(Array.isArray(j.excludes)?j.excludes.filter(x=>typeof x==='string'):[]),[]),schedule,retention,timeoutMinutes:Number.isInteger(j.timeoutMinutes)?j.timeoutMinutes:DEFAULT_TIMEOUT_MINUTES};
}
export async function writeJobs(file,jobs){
 await mkdir(path.dirname(file),{recursive:true,mode:0o700});
 const tmp=`${file}.${process.pid}.${Date.now()}.tmp`;
 await writeFile(tmp,JSON.stringify({schemaVersion:1,jobs},null,1)+'\n',{mode:0o600});
 await rename(tmp,file);
}

// ---- time: the schedule in the site's time zone ----------------------------------------------------------
// The offset of a zone at one instant, in minutes east of UTC (Intl only; no time-zone database of our own).
function zoneParts(ms,timeZone){
 const f=new Intl.DateTimeFormat('en-US',{timeZone,hourCycle:'h23',year:'numeric',month:'numeric',day:'numeric',hour:'numeric',minute:'numeric',second:'numeric',weekday:'short'});
 const p=Object.fromEntries(f.formatToParts(new Date(ms)).filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));
 return {y:+p.year,m:+p.month,d:+p.day,hh:+p.hour,mm:+p.minute,ss:+p.second,wd:['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].indexOf(p.weekday)+1};
}
const offsetAt=(ms,timeZone)=>{const p=zoneParts(ms,timeZone);return (Date.UTC(p.y,p.m-1,p.d,p.hh,p.mm,p.ss)-Math.floor(ms/1000)*1000)/60000;};
// A wall-clock time in the zone → the instant. A time a DST change skips lands one hour later; a time that
// happens twice is taken the first time.
// The two candidates use the offsets a day before and a day after; whichever shows the wanted wall time is it.
export function zonedInstant(y,m,d,hh,mm,timeZone){
 const wall=Date.UTC(y,m-1,d,hh,mm);
 const candidates=[...new Set([wall-offsetAt(wall-86400000,timeZone)*60000,wall-offsetAt(wall+86400000,timeZone)*60000])];
 const fits=candidates.filter(c=>{const p=zoneParts(c,timeZone);return p.hh===hh&&p.mm===mm&&p.d===d;});
 return fits.length?Math.min(...fits):Math.max(...candidates);
}
// Calendar days around an instant, in the zone: [{y, m, d, wd}].
function daysFrom(ms,timeZone,count,step){
 const start=zoneParts(ms,timeZone),out=[];
 for(let i=0;i<count;i++){const noon=new Date(Date.UTC(start.y,start.m-1,start.d+i*step,12));out.push({y:noon.getUTCFullYear(),m:noon.getUTCMonth()+1,d:noon.getUTCDate(),wd:((noon.getUTCDay()+6)%7)+1});}
 return out;
}
const slotsOn=(schedule,day,timeZone)=>{
 if(schedule.mode==='manual')return null;
 if(schedule.mode==='weekly'&&!schedule.days.includes(day.wd))return null;
 const [hh,mm]=schedule.time.split(':').map(Number);return zonedInstant(day.y,day.m,day.d,hh,mm,timeZone);
};
// The first scheduled instant strictly after `after` (a Date or ms), or null for a manual job.
export function nextRun(schedule,after,timeZone){
 if(!schedule||schedule.mode==='manual')return null;
 const ms=+after;
 for(const day of daysFrom(ms,timeZone,9,1)){const at=slotsOn(schedule,day,timeZone);if(at!==null&&at>ms)return new Date(at);}
 return null;
}
// The last scheduled instant at or before `before`, or null.
export function previousRun(schedule,before,timeZone){
 if(!schedule||schedule.mode==='manual')return null;
 const ms=+before;
 for(const day of daysFrom(ms,timeZone,9,-1)){const at=slotsOn(schedule,day,timeZone);if(at!==null&&at<=ms)return new Date(at);}
 return null;
}
// Missed-run policy: a scheduled slot that passed while the hub was down (or busy starting) is caught up
// once, at start: when the newest past slot is later than the last attempt (or the job's creation, for a job
// that never ran). Older missed slots are not replayed: one catch-up covers them all.
export function missedAtStart(job,lastAttemptAt,now,timeZone){
 if(!job.enabled||!complete(job))return null;
 const slot=previousRun(job.schedule,now,timeZone);if(!slot)return null;
 // Counted from the last attempt or the last change of the job, whichever is later: a job set up (or edited)
 // after the slot did not miss it.
 const since=Math.max(Date.parse(lastAttemptAt||'')||0,Date.parse(job.updatedAt||'')||0,Date.parse(job.createdAt||'')||0);
 return +slot>since?slot:null;
}

// ---- snapshots ---------------------------------------------------------------------------------------
// A snapshot's name is the UTC instant its run started: 2026-11-11T023000Z. Sorting the names sorts by time.
export const snapshotName=(at=new Date())=>new Date(at).toISOString().replace(/\.\d{3}Z$/,'Z').replace(/:/g,'');
export const snapshotTime=name=>SNAPSHOT.test(name)?new Date(`${name.slice(0,13)}:${name.slice(13,15)}:${name.slice(15,17)}Z`):null;
// Which snapshots retention deletes: everything that is neither among the newest keepLast nor younger than
// keepDays. The newest snapshot is never deleted, whatever the rule says.
// keep: names that are never deleted whatever the rules say (the runner passes its own run's snapshot). Neither
// rule set (a hand-edited file): nothing is deleted.
export function pruneList(names,{keepLast=0,keepDays=0}={},now=new Date(),{keep=[]}={}){
 const sorted=[...new Set(names.filter(n=>SNAPSHOT.test(n)))].sort().reverse();
 if(!sorted.length||(!keepLast&&!keepDays))return [];
 const cutoff=keepDays?+now-keepDays*86400000:Infinity;
 return sorted.filter((name,i)=>i>0&&!keep.includes(name)&&!(keepLast&&i<keepLast)&&!(keepDays&&+snapshotTime(name)>=cutoff)).sort();
}

// ---- what rsync said -------------------------------------------------------------------------------------
// --stats output of GNU rsync ("Number of regular files transferred: 1,234", "Total file size: 5,678 bytes")
// and of openrsync, the rsync of current macOS ("Number of files transferred: 2", "Total file size: 4 B").
const UNITS={'':1,b:1,bytes:1,k:1024,kb:1024,kib:1024,m:1024**2,mb:1024**2,mib:1024**2,g:1024**3,gb:1024**3,gib:1024**3,t:1024**4,tb:1024**4,tib:1024**4};
const amount=(text)=>{const m=/^([\d,.]+)\s*([A-Za-z]*)/.exec(text.trim());if(!m)return null;const n=Number(m[1].replace(/,/g,''));const unit=UNITS[m[2].toLowerCase()];return Number.isFinite(n)&&unit?Math.round(n*unit):null;};
export function parseStats(output){
 const out={files:null,filesTransferred:null,totalBytes:null,transferredBytes:null,sentBytes:null};
 for(const line of String(output).split('\n')){
  let m;
  if((m=/^Number of files:\s*(.+)$/.exec(line)))out.files=amount(m[1]);
  else if((m=/^Number of (?:regular )?files transferred:\s*(.+)$/.exec(line)))out.filesTransferred=amount(m[1]);
  else if((m=/^Total file size:\s*(.+)$/.exec(line)))out.totalBytes=amount(m[1]);
  else if((m=/^Total transferred file size:\s*(.+)$/.exec(line)))out.transferredBytes=amount(m[1]);
  else if((m=/^Total (?:bytes )?sent:\s*(.+)$/.exec(line)))out.sentBytes=amount(m[1]);
 }
 return out;
}
export const addStats=(a,b)=>Object.fromEntries(Object.keys(a).map(k=>[k,a[k]===null&&b[k]===null?null:(a[k]??0)+(b[k]??0)]));
// rsync's exit codes: 0 done; 23 some files could not be read, 24 some vanished while it ran (the snapshot
// is kept, the run says "warning"); anything else failed.
export const rsyncOutcome=code=>code===0?'ok':code===23||code===24?'warning':'failed';
