// Applying an update: the steps behind scripts/update.mjs (docs/updating.md). The hub never runs this: it is a
// command a person or an agent starts on the server, outside the hub's process, and it works on a checkout and
// an instance that are named to it. Everything that touches the world comes in through `ctx` (exec, probe,
// pidAlive, sleep, now, log, checkpoint), so tests/update-apply.test.mjs drives it with real git repositories
// and a service that is a stand-in.
//
//   resolveInstance()  which checkout, which plugin sources, where data, state and secrets are, how the service is
//                      stopped, started and checked: HOME_HUB_HOME/instance.json, else flags
//   preflight()        everything that can be checked without touching the instance: fetch the tags, resolve the
//                      target, stage it in a scratch worktree, compatibility and the data epoch, the target's tests,
//                      `node server/index.mjs --check` with this instance's site and plugins
//   apply()            preflight, journal, stop, archive, switch (detached at the tag), start, health check; any
//                      failure after the stop puts the previous version back
//   rollback()         the last update, undone by hand
//   recover()          an update that was cut short (a crash, a lost session) is put back on the next run
//   backup()           only the archive
//
// The journal <home>/update-journal.json (without an instance directory: <checkout>/backups/update-journal.json)
// says how far the last update got: stopping → backup → switching → switched → starting → done, or
// rolling-back → rolled-back | aborted | rollback-failed. It is written before each step, so whatever interrupts
// the command, the next run knows what to put back.
//
// Data: state migrates forward only, and older code refuses newer state (server/db.mjs). When the target's data
// epoch is higher (package.json → homeHub.dataEpoch, or a plugin's plugin.json → dataEpoch), going back is the old
// code AND the archive made here with the hub stopped; the directories it replaces are moved aside, never deleted.
//
// Only static imports: the command may be running from the very checkout it switches, so nothing is loaded later.
import {spawnSync} from 'node:child_process';
import {existsSync,readFileSync,writeFileSync,mkdirSync,renameSync,rmSync,readdirSync,statSync,appendFileSync,cpSync,symlinkSync,mkdtempSync,chmodSync,realpathSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {repoRoot} from './edition.mjs';
import {resolvePaths} from './paths.mjs';
import {readInstance} from './plugins.mjs';
import {parse,compare,satisfies,validRange} from './semver.mjs';
import {parseService,parseHealth,parseBackups,UpdateConfigError,DEFAULT_HEALTH_SECONDS} from './update-config.mjs';
import {UPDATES_SCHEMA} from './update-check.mjs';

export const JOURNAL_SCHEMA=1;
export const TERMINAL_STEPS=Object.freeze(['done','rolled-back','aborted']);
/** Refused, or failed before anything was changed (or after everything was put back). */
export class UpdateError extends Error{}
/** The previous version could not be brought back: the service is stopped and a person has to look. */
export class RollbackFailed extends Error{}

const plain=v=>v&&typeof v==='object'&&!Array.isArray(v);
const readJson=file=>{try{return JSON.parse(readFileSync(file,'utf8'));}catch{return null;}};
const inside=(child,parent)=>{const rel=path.relative(parent,child);return rel===''||(rel!=='..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel));};
const stampOf=ms=>new Date(ms).toISOString().replace(/[-:]/g,'').replace('T','-').slice(0,15);
const iso=ms=>new Date(ms).toISOString();
const short=commit=>commit?commit.slice(0,7):'?';
const oneLine=(text,max=300)=>String(text??'').replace(/\s+/g,' ').trim().slice(0,max);
const lastLines=(text,n)=>String(text??'').trimEnd().split('\n').slice(-n).join('\n');
function writeAtomic(file,text){mkdirSync(path.dirname(file),{recursive:true});const tmp=`${file}.${process.pid}.tmp`;writeFileSync(tmp,text,{mode:0o600});renameSync(tmp,file);}
const TAG=/^[A-Za-z0-9][A-Za-z0-9._+-]{0,80}$/;
// What a test run or a start-up check must not inherit from the shell that runs the update.
const INSTANCE_ENV=/^(?:HOME_HUB_.*|DATA_DIR|STATE_DIR|AUTH_FILE|SOFTWARE_WATCH_FILE|INTEGRATION_SECRETS_FILE|LOCAL_PREVIEW|PORT|ORIGIN|ORIGIN_ALIASES|BIND_HOST)$/;

// --- the world, as the real command sees it ----------------------------------------------------------
/** exec(command, args, {cwd, env, timeoutMs}) → {status, stdout, stderr}; never throws. 127: not found, 124: timed out. */
export function realExec(command,args,{cwd,env,timeoutMs=120000}={}){
 const r=spawnSync(command,args,{cwd,env,encoding:'utf8',timeout:timeoutMs,maxBuffer:256*1024*1024,stdio:['ignore','pipe','pipe']});
 if(r.error)return {status:r.error.code==='ETIMEDOUT'?124:127,stdout:r.stdout||'',stderr:`${r.stderr||''}${r.error.message}`};
 return {status:r.status??124,stdout:r.stdout||'',stderr:r.stderr||''};
}
export async function realProbe(url){
 try{const r=await fetch(url,{signal:AbortSignal.timeout(3000),redirect:'manual',headers:{'user-agent':'home-hub-update'}});await r.arrayBuffer().catch(()=>{});return r.status===200;}catch{return false;}
}
export function realPidAlive(pid){
 if(!Number.isSafeInteger(pid)||pid<=1)return false;
 try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}
}
export const realContext=(extra={})=>({exec:realExec,probe:realProbe,pidAlive:realPidAlive,sleep:ms=>new Promise(r=>setTimeout(r,ms)),now:Date.now,log:line=>console.log(line),
 checkpoint:()=>{},node:process.execPath,user:(()=>{try{return os.userInfo().username;}catch{return null;}})(),stopSeconds:45,...extra});

const git=(ctx,dir,...args)=>{const r=ctx.exec('git',['-C',dir,...args],{env:{...process.env,GIT_TERMINAL_PROMPT:'0'}});return r.status===0?r.stdout.trim():null;};
function gitDo(ctx,dir,...args){
 const r=ctx.exec('git',['-C',dir,...args],{env:{...process.env,GIT_TERMINAL_PROMPT:'0'}});
 if(r.status!==0)throw new Error(`git ${args.join(' ')} failed in ${dir}: ${oneLine(r.stderr||r.stdout)||`exit ${r.status}`}`);
 return r.stdout.trim();
}

// --- the instance --------------------------------------------------------------------------------------
/**
 * env: the environment with the instance variables (HOME_HUB_HOME, DATA_DIR, STATE_DIR, …; the command's --home,
 * --data, --state and --private flags are written into it first). root: the core checkout this code runs from.
 * options: {root, service, health, healthSeconds, backups, keep, staging} from the flags; each wins over instance.json.
 */
export function resolveInstance({env=process.env,root=repoRoot,options={}}={}){
 const home=env.HOME_HUB_HOME?path.resolve(env.HOME_HUB_HOME):null;
 let instance=null;
 try{instance=home?readInstance(home):null;}catch(e){throw new UpdateError(e.message);}
 const core=path.resolve(options.root??(home&&instance?.sources.core?path.join(home,instance.sources.core):root));
 if(!existsSync(path.join(core,'package.json')))throw new UpdateError(`${core} is not a Home Hub checkout (it has no package.json)`);
 const p=resolvePaths(env,core);
 const paths=Object.freeze({config:p.config,siteConfig:p.siteConfig,data:path.resolve(p.data),state:path.resolve(p.state),private:p.private,authFile:path.resolve(p.authFile)});
 let service=null,health=null,backups;
 try{
  const spec=options.service??instance?.service??null;service=spec?parseService(spec):null;
  const url=options.health??instance?.health?.url??null;
  health=url?parseHealth({url,seconds:options.healthSeconds??instance?.health?.seconds??DEFAULT_HEALTH_SECONDS}):null;
  backups=parseBackups(options.keep!==undefined&&options.keep!==null?{keep:options.keep}:instance?.backups??{});
 }catch(e){if(e instanceof UpdateConfigError)throw new UpdateError(e.message);throw e;}
 // Where the plugins are: the same order of choice as the server (server/plugins.mjs → pluginsDirectories).
 const chosen=env.HOME_HUB_PLUGINS_DIR;
 const pluginDirs=chosen==='none'?[]:chosen?[...new Set(chosen.split(path.delimiter).filter(Boolean).map(d=>path.resolve(d)))]
  :home&&instance?.sources.plugins?instance.sources.plugins.map(name=>path.join(home,name,'plugins')):[path.join(core,'local','plugins')];
 const sources=[{id:'core',kind:'core',dir:core,plugins:[]}];
 for(const dir of pluginDirs){
  if(!existsSync(dir))continue;
  if(inside(dir,core)){sources[0].plugins.push(path.relative(core,dir));continue;}
  const base=path.dirname(dir);let id=path.basename(base)||'plugins';
  const known=sources.find(s=>s.dir===base);
  if(known){known.plugins.push(path.basename(dir));continue;}
  for(let n=2;id==='core'||id==='node_modules'||sources.some(s=>s.id===id);n++)id=`${path.basename(base)}-${n}`;
  sources.push({id,kind:'plugins',dir:base,plugins:[path.basename(dir)]});
 }
 const work=home??path.join(core,'backups');
 return Object.freeze({home,root:core,env,paths,service,health,keep:backups.keep,sources:Object.freeze(sources),
  backups:path.resolve(options.backups??(home?path.join(home,'backups'):path.join(core,'backups'))),
  staging:path.resolve(options.staging??(home?path.join(home,'staging'):os.tmpdir())),
  files:Object.freeze({journal:path.join(work,'update-journal.json'),lock:path.join(work,'update.lock'),history:path.join(paths.state,'update-history.jsonl'),run:path.join(paths.state,'run.json'),updates:path.join(paths.state,'updates.json')})});
}

// --- facts read from files -----------------------------------------------------------------------------
// Read leniently on purpose: the target may be newer than this code and know fields this code does not. What is
// strict is the target's own `--check`.
/** package.json of a core tree → {version, dataEpoch, node} or null. */
export function coreFacts(input){
 const p=typeof input==='string'?readJson(path.join(input,'package.json')):input;
 if(!plain(p)||!parse(p.version))return null;
 const epoch=p.homeHub?.dataEpoch;
 return {version:parse(p.version).text,dataEpoch:Number.isSafeInteger(epoch)&&epoch>=1?epoch:1,node:typeof p.engines?.node==='string'?p.engines.node:null};
}
/** Every plugin of a plugins directory → [{id, version, core, requires, dataEpoch}] (version and core null without plugin.json). */
export function pluginFacts(directory){
 if(!existsSync(directory))return [];
 const pkg=readJson(path.join(path.dirname(directory),'package.json')),own=plain(pkg)&&pkg.name!=='home-hub'?pkg:null;
 return readdirSync(directory,{withFileTypes:true}).filter(d=>d.isDirectory()&&!d.name.startsWith('.')&&!d.name.startsWith('_')&&existsSync(path.join(directory,d.name,'index.mjs'))).map(d=>d.name).sort().map(id=>{
  const m=readJson(path.join(directory,id,'plugin.json'));
  if(!plain(m))return {id,version:null,core:null,requires:{},dataEpoch:null};
  const version=parse(m.version??own?.version)?.text??null,core=m.core??own?.homeHub?.core??null;
  return {id,version,core:typeof core==='string'?core:null,requires:plain(m.requires)?m.requires:{},dataEpoch:Number.isSafeInteger(m.dataEpoch)?m.dataEpoch:null};
 });
}
const pluginsOf=(inst,place=s=>s.dir)=>inst.sources.flatMap(s=>s.plugins.flatMap(rel=>pluginFacts(path.join(place(s),rel))));
/** <state>/run.json → what the running hub wrote when it began to listen, or null. */
export const readRun=inst=>{const r=readJson(inst.files.run);return plain(r)&&typeof r.version==='string'?r:null;};

/** Why run.json is not the hub that was expected ('' when it is). expect: {version, plugins:[{id, version}]}. */
export function runMismatch(run,expect,{since=0,pidAlive=realPidAlive}={}){
 if(!run)return 'run.json is missing: the hub has not finished starting';
 if(run.version!==expect.version)return `the hub that wrote run.json is ${run.version}, not ${expect.version}`;
 if(!pidAlive(run.pid))return `the process in run.json (pid ${run.pid}) is not running`;
 if(since&&!(Date.parse(run.startedAt)>=since-2000))return 'run.json is from before this start';
 if(expect.plugins){
  const have=new Map((Array.isArray(run.plugins)?run.plugins:[]).map(p=>[p.id,p.version??null])),want=new Map(expect.plugins.map(p=>[p.id,p.version??null]));
  const missing=[...want.keys()].filter(id=>!have.has(id)),extra=[...have.keys()].filter(id=>!want.has(id));
  if(missing.length)return `plugin(s) not loaded: ${missing.join(', ')}`;
  if(extra.length)return `unexpected plugin(s) loaded: ${extra.join(', ')}`;
  for(const [id,version] of want)if(version&&have.get(id)&&have.get(id)!==version)return `plugin ${id} is ${have.get(id)}, not ${version}`;
 }
 return '';
}

// --- sources as git sees them --------------------------------------------------------------------------
function inspectSource(ctx,source){
 const top=git(ctx,source.dir,'rev-parse','--show-toplevel');
 let isGit=false;try{isGit=Boolean(top)&&statSync(top).ino===statSync(source.dir).ino;}catch{}
 if(!isGit)return {...source,git:false,commit:null,branch:null,dirty:[],tag:null};
 const commit=git(ctx,source.dir,'rev-parse','HEAD'),branch=git(ctx,source.dir,'symbolic-ref','--short','-q','HEAD')||null;
 const dirty=(git(ctx,source.dir,'status','--porcelain','--untracked-files=no')||'').split('\n').filter(Boolean);
 const tag=(git(ctx,source.dir,'tag','--points-at','HEAD')||'').split('\n').filter(Boolean)[0]||null;
 return {...source,git:true,commit,branch,dirty,tag};
}
const tagCommit=(ctx,dir,tag)=>git(ctx,dir,'rev-parse','-q','--verify',`refs/tags/${tag}^{commit}`);
function newestTag(ctx,dir){
 const tags=(git(ctx,dir,'tag','--list','v*')||'').split('\n').map(t=>t.trim()).filter(t=>{const v=parse(t.slice(1));return t.startsWith('v')&&v&&!v.prerelease.length;});
 return tags.sort((a,b)=>compare(a.slice(1),b.slice(1))).at(-1)||null;
}
// Files that are not tracked here but are tracked in the target: git would refuse the checkout over them.
function collisions(ctx,dir,commit){
 const untracked=(git(ctx,dir,'ls-files','--others','--exclude-standard')||'').split('\n').filter(Boolean);if(!untracked.length)return [];
 const there=new Set((git(ctx,dir,'ls-tree','-r','--name-only',commit)||'').split('\n'));
 return untracked.filter(f=>there.has(f));
}

// --- updates.json: the note the update card reads ---------------------------------------------------------
/** quarantined[version] = entry ({at, reason}), or removed with entry null. → false when the file belongs to newer code. */
export function setQuarantine(file,version,entry){
 const raw=existsSync(file)?readJson(file):null;
 if(Number.isInteger(raw?.schemaVersion)&&raw.schemaVersion>UPDATES_SCHEMA)return false;
 const doc=plain(raw)&&raw.schemaVersion===UPDATES_SCHEMA?raw:{schemaVersion:UPDATES_SCHEMA,sources:{},quarantined:{},dismissed:null};
 const {[version]:had,...rest}=plain(doc.quarantined)?doc.quarantined:{};
 if(!entry&&had===undefined)return true;
 doc.quarantined=Object.fromEntries([...(entry?[[version,{at:entry.at,reason:oneLine(entry.reason,120)||null}]]:[]),...Object.entries(rest)].slice(0,50));
 writeAtomic(file,JSON.stringify(doc,null,1)+'\n');
 return true;
}
export const readQuarantine=file=>{const raw=readJson(file);return plain(raw?.quarantined)?raw.quarantined:{};};

// --- journal, lock, history ----------------------------------------------------------------------------
export const readJournal=inst=>{const j=readJson(inst.files.journal);return plain(j)&&j.schemaVersion===JOURNAL_SCHEMA&&typeof j.step==='string'?j:null;};
const writeJournal=(inst,journal)=>writeAtomic(inst.files.journal,JSON.stringify(journal,null,1)+'\n');
export const unfinished=journal=>Boolean(journal)&&!TERMINAL_STEPS.includes(journal.step);
function takeLock(inst,ctx){
 const held=readJson(inst.files.lock);
 if(plain(held)&&held.pid!==process.pid&&ctx.pidAlive(held.pid))throw new UpdateError(`Another update is running (pid ${held.pid}, since ${held.at}). Lock: ${inst.files.lock}`);
 writeAtomic(inst.files.lock,JSON.stringify({pid:process.pid,at:iso(ctx.now())})+'\n');
 return ()=>{try{rmSync(inst.files.lock,{force:true});}catch{}};
}
function history(inst,ctx,journal,result){
 try{
  mkdirSync(path.dirname(inst.files.history),{recursive:true});
  appendFileSync(inst.files.history,JSON.stringify({at:iso(ctx.now()),id:journal.id,from:journal.from.label,to:journal.to.label,by:journal.by,seconds:Math.round((ctx.now()-Date.parse(journal.startedAt))/1000),result,
   ...(journal.failure?{reason:journal.failure.message}:{})})+'\n',{mode:0o600});
 }catch(e){ctx.log(`  (could not write ${inst.files.history}: ${e.message})`);}
}

// --- the service ---------------------------------------------------------------------------------------
const needService=inst=>{
 if(!inst.service)throw new UpdateError(`How to stop and start the hub is not known. Say it with --service (launchd:system/<label>, systemd:<unit>, or command:{"stop":[…],"start":[…]})${inst.home?', or as "service" in '+path.join(inst.home,'instance.json'):''}.`);
 if(!inst.health)throw new UpdateError(`Where the hub answers is not known. Say it with --health http://127.0.0.1:<port>/healthz${inst.home?', or as "health" in '+path.join(inst.home,'instance.json'):''}.`);
};
const isDown=async(inst,ctx,pid)=>!(pid&&ctx.pidAlive(pid))&&!(await ctx.probe(inst.health.url));
/** Stops the service and waits until its process is gone and nothing answers. A stop command that fails is fine when the hub is down anyway. */
async function stopService(inst,ctx,pid){
 ctx.log(`  $ ${inst.service.stop.join(' ')}`);
 const r=ctx.exec(inst.service.stop[0],inst.service.stop.slice(1),{timeoutMs:60000});
 const deadline=ctx.now()+ctx.stopSeconds*1000;
 for(;;){
  if(await isDown(inst,ctx,pid)){if(r.status!==0)ctx.log(`  (the stop command said: ${oneLine(r.stderr||r.stdout)||`exit ${r.status}`}; the hub is down)`);return;}
  // Refused (no permission, no such service) with the hub still up: nothing happened, and undo() leaves it alone.
  if(r.status!==0)throw Object.assign(new Error(`the service did not stop: ${oneLine(r.stderr||r.stdout)||`exit ${r.status}`}`),{stopRefused:true});
  if(ctx.now()>=deadline)throw new Error(`the service was told to stop, but ${pid&&ctx.pidAlive(pid)?`pid ${pid} is still running`:`${inst.health.url} still answers`} after ${ctx.stopSeconds} s`);
  await ctx.sleep(300);
 }
}
async function startService(inst,ctx){
 ctx.log(`  $ ${inst.service.start.join(' ')}`);
 let r;
 for(let attempt=1;;attempt++){
  r=ctx.exec(inst.service.start[0],inst.service.start.slice(1),{timeoutMs:60000});
  if(r.status===0)return;
  if(attempt>=inst.service.startTries)break;
  await ctx.sleep(2000);
 }
 throw new Error(`the service did not start: ${oneLine(r.stderr||r.stdout)||`exit ${r.status}`}`);
}
/** Waits until the health address answers 200 and run.json shows the expected hub, started after `since`. */
async function waitHealthy(inst,ctx,expect,since,{interruptible=true}={}){
 const deadline=ctx.now()+inst.health.seconds*1000;
 for(;;){
  if(interruptible)ctx.checkpoint();
  const why=(await ctx.probe(inst.health.url))?runMismatch(readRun(inst),expect,{since,pidAlive:ctx.pidAlive}):`no answer from ${inst.health.url}`;
  if(!why)return;
  if(ctx.now()>=deadline)throw new Error(`health check failed: ${why} (waited ${inst.health.seconds} s)`);
  await ctx.sleep(500);
 }
}

// --- the archive ---------------------------------------------------------------------------------------
/** The directories an archive holds: config (an instance directory only), data, state when it is not inside data, private. */
export function archiveEntries(inst){
 const wanted=[...(inst.home?[inst.paths.config]:[]),inst.paths.data,inst.paths.state,inst.paths.private].filter(dir=>existsSync(dir));
 const entries=wanted.filter(dir=>!wanted.some(other=>other!==dir&&inside(dir,other))).filter((dir,i,all)=>all.indexOf(dir)===i).map(dir=>({name:path.basename(dir),parent:path.dirname(dir)}));
 const twice=entries.find((e,i)=>entries.findIndex(o=>o.name===e.name)!==i);
 if(twice)throw new UpdateError(`Two of the directories to archive are both called "${twice.name}"; the archive cannot hold both.`);
 for(const e of entries)if(inside(inst.backups,path.join(e.parent,e.name)))throw new UpdateError(`The backups directory ${inst.backups} is inside ${path.join(e.parent,e.name)}, which is archived. Choose another with --backups.`);
 return entries;
}
/** tar of the instance's directories into <backups>/<name>.tgz (0600), listed back to prove it reads. Call with the hub stopped. */
export function makeArchive(inst,ctx,name){
 const entries=archiveEntries(inst);
 if(!entries.length)throw new Error('there is nothing to archive: none of the data directories exists');
 mkdirSync(inst.backups,{recursive:true,mode:0o700});
 const file=path.join(inst.backups,`${name}.tgz`);
 writeFileSync(file,'',{mode:0o600});chmodSync(file,0o600);
 // Left out: a backup job's mirror of its source (the hub rebuilds it) and archives inside the data (a backup of backups).
 const made=ctx.exec('tar',['-czf',file,'--exclude','*/backup-jobs/*/staging','--exclude','*.tgz',...entries.flatMap(e=>['-C',e.parent,e.name])],{timeoutMs:3600000});
 if(made.status!==0){rmSync(file,{force:true});throw new Error(`tar failed: ${oneLine(made.stderr)||`exit ${made.status}`}`);}
 const listed=ctx.exec('tar',['-tzf',file],{timeoutMs:3600000});
 const names=listed.status===0?listed.stdout.split('\n'):[];
 const absent=entries.filter(e=>!names.some(n=>n===e.name||n===`${e.name}/`||n.startsWith(`${e.name}/`)));
 if(listed.status!==0||absent.length){throw new Error(`the archive ${file} does not read back${absent.length?` (missing: ${absent.map(e=>e.name).join(', ')})`:''}`);}
 return {file,entries,bytes:statSync(file).size,files:names.filter(Boolean).length};
}
/** Puts an archive back. What is there now is moved to <backups>/failed-<time>/, never deleted. */
export function restoreArchive(inst,ctx,backup){
 if(!existsSync(backup.file))throw new Error(`the archive ${backup.file} is gone`);
 const aside=path.join(inst.backups,`failed-${stampOf(ctx.now())}`);
 for(const e of backup.entries){
  const live=path.join(e.parent,e.name);
  if(existsSync(live)){
   mkdirSync(aside,{recursive:true,mode:0o700});
   let to=path.join(aside,e.name);for(let n=2;existsSync(to);n++)to=path.join(aside,`${e.name}-${n}`);
   try{renameSync(live,to);}catch(err){if(err.code!=='EXDEV')throw err;to=`${live}.failed-${stampOf(ctx.now())}`;renameSync(live,to);}
   ctx.log(`  moved ${live} → ${to}`);
  }
  const r=ctx.exec('tar',['-xpzf',backup.file,'-C',e.parent,e.name],{timeoutMs:3600000});
  if(r.status!==0)throw new Error(`could not restore ${e.name} from ${backup.file}: ${oneLine(r.stderr)||`exit ${r.status}`}`);
 }
 return aside;
}
function pruneArchives(inst,ctx,keepFile){
 try{
  const old=readdirSync(inst.backups).filter(n=>/^pre-.*\.tgz$/.test(n)).map(n=>({file:path.join(inst.backups,n),at:statSync(path.join(inst.backups,n)).mtimeMs})).sort((a,b)=>b.at-a.at).slice(inst.keep).filter(a=>a.file!==keepFile);
  for(const a of old){rmSync(a.file,{force:true});ctx.log(`  removed the old archive ${a.file}`);}
 }catch{}
}

// --- preflight -----------------------------------------------------------------------------------------
const cleanEnv=env=>Object.fromEntries(Object.entries(env).filter(([k])=>!INSTANCE_ENV.test(k)));
function hasTests(source,staged){
 const has=dir=>existsSync(dir)&&readdirSync(dir).some(f=>/\.test\.mjs$/.test(f));
 const plugins=path.join(staged,'plugins');
 return has(path.join(staged,'tests'))||(existsSync(plugins)&&readdirSync(plugins,{withFileTypes:true}).some(d=>d.isDirectory()&&has(path.join(plugins,d.name,'tests'))));
}
function runStep(ctx,title,command,args,options){
 ctx.log(`  $ ${[path.basename(command),...args].join(' ')}   (in ${options.cwd})`);
 const r=ctx.exec(command,args,{timeoutMs:1800000,...options});
 if(r.status!==0)throw new UpdateError(`${title} failed (exit ${r.status}). The instance was not touched.\n${lastLines(`${r.stdout}\n${r.stderr}`,40)}`);
 return r;
}
/**
 * request: {core: 'v1.3.0' | null (the newest tag here, unless only plugins were asked for), plugins: {'<source>'|'*': '<tag>'},
 *  fetch (default true), skipTests, allowUnsigned, force}.
 * → the plan: {from, to, changes: [{id, dir, from, to, tag, branch}], epochRose, expect, lines: […]}. Throws UpdateError.
 * forApply also requires what only an apply needs: the service, the health address, and a hub that is running now.
 */
export async function preflight(inst,request,ctx,{forApply=false}={}){
 const say=line=>ctx.log(line);
 const live=inst.sources.map(s=>inspectSource(ctx,s)),core=live[0];
 if(!core.git)throw new UpdateError(`${core.dir} is not a git checkout: there is nothing to switch. (A container image is rebuilt instead: docs/docker.md.)`);
 const installed=coreFacts(core.dir);
 if(!installed)throw new UpdateError(`${core.dir}/package.json has no version.`);
 const run=readRun(inst);
 if(forApply){
  needService(inst);
  if(!run)throw new UpdateError(`${inst.files.run} is missing. A running hub writes it, so either the hub is not running or its state directory is somewhere else: pass --state (or STATE_DIR), as the service has it.`);
  const why=runMismatch(run,{version:installed.version},{pidAlive:ctx.pidAlive});
  if(why)throw new UpdateError(`The hub is not running what this checkout holds: ${why}. Start (or restart) it first; an update begins from a hub that works.`);
  if(typeof run.commit==='string'&&run.commit&&!core.commit.startsWith(run.commit))throw new UpdateError(`The hub was started from commit ${run.commit}, and the checkout is now on ${short(core.commit)}: restart it first, so that "the previous version" is one that has run.`);
  if(!(await ctx.probe(inst.health.url)))throw new UpdateError(`${inst.health.url} does not answer now, before anything was changed. Check the address: a health check that cannot pass would roll every update back.`);
 }
 // 1. what is asked for
 const wanted=new Map();
 for(const [name,tag] of Object.entries(request.plugins||{})){
  const targets=name==='*'?live.filter(s=>s.kind==='plugins'):live.filter(s=>s.kind==='plugins'&&s.id===name);
  if(name==='*'&&targets.length!==1)throw new UpdateError(targets.length?`There are ${targets.length} plugin sources (${targets.map(s=>s.id).join(', ')}): say which, as --plugins <source>=<tag>.`:'--plugins: this instance has no plugin source outside the core checkout.');
  if(!targets.length)throw new UpdateError(`--plugins ${name}=…: there is no plugin source "${name}" (there ${live.length>1?'is '+live.slice(1).map(s=>s.id).join(', '):'are none'}).`);
  if(!TAG.test(tag))throw new UpdateError(`"${tag}" is not a tag name.`);
  wanted.set(targets[0].id,tag);
 }
 const coreAsked=request.core??null;
 if(coreAsked!==null&&!(coreAsked.startsWith('v')&&parse(coreAsked.slice(1))))throw new UpdateError(`"${coreAsked}" is not a release tag. Releases are tagged v<version>, such as v${installed.version}.`);
 for(const s of live)if((s.id==='core'||wanted.has(s.id))&&s.git&&s.dirty.length)throw new UpdateError(`${s.dir} has uncommitted changes to tracked files; an update would have to discard them:\n${s.dirty.slice(0,10).join('\n')}`);
 // 2. the tags
 for(const s of live){
  if(!s.git||!(s.id==='core'?coreAsked!==null||!wanted.size:wanted.has(s.id)))continue;
  if(request.fetch===false){say(`  ${s.id}: not fetching (--no-fetch); using the tags that are here`);continue;}
  const remotes=(git(ctx,s.dir,'remote')||'').split('\n').filter(Boolean),remote=remotes.includes('origin')?'origin':remotes[0];
  if(!remote){say(`  ${s.id}: no remote; using the tags that are here`);continue;}
  const r=ctx.exec('git',['-C',s.dir,'fetch','--tags','--quiet',remote],{env:{...process.env,GIT_TERMINAL_PROMPT:'0'},timeoutMs:120000});
  if(r.status!==0)throw new UpdateError(`git fetch --tags ${remote} failed in ${s.dir}: ${oneLine(r.stderr)||`exit ${r.status}`}\nWith --no-fetch the tags already here are used.`);
  say(`  ${s.id}: fetched tags from ${remote}`);
 }
 // 3. the targets
 const changes=[],lines=[];
 const coreTag=coreAsked??(wanted.size?null:newestTag(ctx,core.dir));
 let target=installed,targetCommit=core.commit;
 if(coreTag){
  const commit=tagCommit(ctx,core.dir,coreTag);
  if(!commit)throw new UpdateError(`There is no tag ${coreTag} in ${core.dir}${request.fetch===false?' (nothing was fetched)':''}.`);
  const there=coreFacts(readJsonText(git(ctx,core.dir,'show',`${commit}:package.json`)));
  if(!there)throw new UpdateError(`${coreTag} has no package.json with a version.`);
  if(there.version!==parse(coreTag.slice(1)).text)throw new UpdateError(`${coreTag} is not what it says: its package.json reads ${there.version}.`);
  const order=compare(there.version,installed.version);
  if(order<0)throw new UpdateError(`${there.version} is lower than what is installed (${installed.version}). Going back is "rollback", and only to the version the last update came from.`);
  if(commit!==core.commit){target=there;targetCommit=commit;changes.push({id:'core',dir:core.dir,from:core.commit,to:commit,tag:coreTag,branch:core.branch});}
  else if(coreAsked===null&&!wanted.size)throw new UpdateError(`Nothing to do: ${installed.version} (${coreTag}) is the newest release tag in ${core.dir}.`);
  else if(!wanted.size)throw new UpdateError(`Nothing to do: ${core.dir} is already on ${coreTag}.`);
 }else if(!wanted.size)throw new UpdateError(`Nothing to do: ${core.dir} has no release tag. Name one: apply v<version>.`);
 if(target.dataEpoch<installed.dataEpoch)throw new UpdateError(`${coreTag} has data epoch ${target.dataEpoch}, lower than the installed ${installed.dataEpoch}: it could not read this instance's state.`);
 const quarantined=readQuarantine(inst.files.updates)[target.version];
 if(changes.length&&quarantined&&!request.force)throw new UpdateError(`${target.version} was tried here on ${String(quarantined.at).slice(0,10)} and rolled back${quarantined.reason?` (${quarantined.reason})`:''}. --force tries it again.`);
 for(const [id,tag] of wanted){
  const s=live.find(x=>x.id===id);
  if(!s.git)throw new UpdateError(`The plugin source ${s.dir} is not a git checkout; it cannot be switched to ${tag}.`);
  const commit=tagCommit(ctx,s.dir,tag);
  if(!commit)throw new UpdateError(`There is no tag ${tag} in ${s.dir}.`);
  const now=parse(readJson(path.join(s.dir,'package.json'))?.version),then=parse(readJsonText(git(ctx,s.dir,'show',`${commit}:package.json`))?.version);
  if(now&&then&&compare(then,now)<0)throw new UpdateError(`${s.id} ${tag} is ${then.text}, lower than what is installed (${now.text}).`);
  if(commit!==s.commit)changes.push({id,dir:s.dir,from:s.commit,to:commit,tag,branch:s.branch});
 }
 if(!changes.length)throw new UpdateError('Nothing to do: every source is already on what was asked for.');
 for(const c of changes){
  const hit=collisions(ctx,c.dir,c.to);
  if(hit.length)throw new UpdateError(`${c.dir} has untracked file(s) that ${c.tag} also contains; git would refuse the switch:\n${hit.slice(0,10).join('\n')}`);
  // A release is signed when the checkout that is installed says who signs (config/release-signers).
  const signers=path.join(c.dir,'config','release-signers');
  if(existsSync(signers)&&readFileSync(signers,'utf8').trim()){
   const r=ctx.exec('git',['-C',c.dir,'-c','gpg.format=ssh','-c',`gpg.ssh.allowedSignersFile=${signers}`,'verify-tag',c.tag]);
   if(r.status===0)lines.push(`${c.id}: the signature of ${c.tag} is good (config/release-signers)`);
   else if(request.allowUnsigned)lines.push(`${c.id}: WARNING: ${c.tag} has no good signature; accepted because of --allow-unsigned`);
   else throw new UpdateError(`${c.id}: ${c.tag} has no good signature by a key in ${signers}: ${oneLine(r.stderr)||'verify-tag failed'}\n--allow-unsigned accepts it anyway.`);
  }else lines.push(`${c.id}: ${c.tag} is not checked for a signature (no config/release-signers in the installed checkout)`);
 }
 // 4. the target, staged next to nothing live
 mkdirSync(inst.staging,{recursive:true});
 // The real path: the server compares its own file with argv[1], and a temp directory is often behind a link.
 const staging=realpathSync(mkdtempSync(path.join(inst.staging,'home-hub-update-'))),place=s=>path.join(staging,s.id),added=[];
 try{
  for(const s of live){
   const to=changes.find(c=>c.id===s.id)?.to??s.commit;
   if(s.git){gitDo(ctx,s.dir,'worktree','add','--detach','--quiet',place(s),to);added.push(s);}
   else cpSync(s.dir,place(s),{recursive:true,filter:from=>!['.git','node_modules'].includes(path.basename(from))});
  }
  const stagedCore=place(core);
  // Paths inside the checkout follow it into the stage when the target tracks them (an overlay kept in git), and
  // stay the instance's own otherwise (data, state, secrets, a site file that is not in git).
  const at=dir=>{if(!inside(dir,core.dir))return dir;const there=path.join(stagedCore,path.relative(core.dir,dir));return existsSync(there)?there:dir;};
  const siteFile=inst.paths.siteConfig?at(inst.paths.siteConfig):null;
  const checkEnv={...inst.env,HOME_HUB_CONFIG_DIR:at(inst.paths.config),HOME_HUB_SITE_CONFIG:siteFile??'none',DATA_DIR:at(inst.paths.data),STATE_DIR:at(inst.paths.state),HOME_HUB_PRIVATE_DIR:at(inst.paths.private),AUTH_FILE:at(inst.paths.authFile)};
  // Plugins that live in the checkout without being tracked there (a site's own local/plugins) are copied in.
  let copied=false;
  for(const rel of core.plugins)if(!existsSync(path.join(stagedCore,rel))){cpSync(path.join(core.dir,rel),path.join(stagedCore,rel),{recursive:true,filter:from=>path.basename(from)!=='node_modules'});copied=true;}
  if(live.length>1){mkdirSync(path.join(staging,'node_modules'));symlinkSync(stagedCore,path.join(staging,'node_modules','home-hub'),'dir');}
  const stagedDirs=live.flatMap(s=>s.plugins.map(rel=>path.join(place(s),rel)));
  checkEnv.HOME_HUB_PLUGINS_DIR=stagedDirs.length?stagedDirs.join(path.delimiter):'none';
  // 5. compatibility and the data epoch, from files
  const before=pluginsOf(inst),after=stagedDirs.flatMap(pluginFacts),staged=coreFacts(stagedCore);
  if(!staged||staged.version!==target.version)throw new UpdateError(`The staged core reads ${staged?.version??'no version'}, not ${target.version}.`);
  if(target.node&&validRange(target.node)&&!satisfies(process.versions.node,target.node))throw new UpdateError(`Home Hub ${target.version} needs Node ${target.node}; this is ${process.versions.node}.`);
  for(const p of after){
   if(!p.core){lines.push(`plugin ${p.id}: no plugin.json, so no core range to check`);continue;}
   if(!validRange(p.core)||!satisfies(target.version,p.core))throw new UpdateError(`Plugin ${p.id}${p.version?' '+p.version:''} supports Home Hub ${p.core}; the target is ${target.version}. Update the plugins too (--plugins <tag>), or stay.`);
   for(const [id,range] of Object.entries(p.requires)){
    const other=after.find(o=>o.id===id);
    if(!other)throw new UpdateError(`Plugin ${p.id} needs plugin ${id} (${range}), which would not be installed.`);
    if(!other.version||!validRange(range)||!satisfies(other.version,range))throw new UpdateError(`Plugin ${p.id} needs plugin ${id} ${range}; ${other.version??'an unversioned one'} would be installed.`);
   }
  }
  if(after.length)lines.push(`plugins: ${after.map(p=>`${p.id}${p.version?' '+p.version:''}`).join(', ')}: every core range includes ${target.version}`);
  const epochs=[...(target.dataEpoch>installed.dataEpoch?[`core ${installed.dataEpoch} → ${target.dataEpoch}`]:[]),
   ...after.flatMap(p=>{const was=before.find(b=>b.id===p.id);return was&&p.dataEpoch!==null&&p.dataEpoch>(was.dataEpoch??1)?[`plugin ${p.id} ${was.dataEpoch??1} → ${p.dataEpoch}`]:[];})];
  const lower=after.find(p=>{const was=before.find(b=>b.id===p.id);return was&&was.dataEpoch!==null&&(p.dataEpoch??1)<was.dataEpoch;});
  if(lower)throw new UpdateError(`Plugin ${lower.id} would go to a lower data epoch; it could not read its own state.`);
  const epochRose=epochs.length>0;
  lines.push(epochRose?`DATA EPOCH RISES (${epochs.join('; ')}): after this update the old code cannot read the state. Going back means restoring the archive made before the switch; whatever is written after the update is then lost.`
   :`data epoch unchanged (${installed.dataEpoch}): going back is switching the code back, and nothing written since is lost`);
  // 6. the target's own tests
  if(request.skipTests)lines.push('tests: SKIPPED (--skip-tests)');
  else{
   const env=cleanEnv(inst.env),runner=path.join(stagedCore,'scripts','run-tests.mjs');
   say(`Testing ${target.version} in ${staging}:`);
   const summary=r=>lastLines(r.stdout,8).split('\n').filter(l=>/^\S+\s+tests \d+/.test(l)).map(l=>l.replace(/\s+/g,' ')).join('; ');
   lines.push(`tests (core): ${summary(runStep(ctx,'npm test of the target',ctx.node,[runner,...(copied&&inst.paths.siteConfig&&existsSync(inst.paths.siteConfig)?['--site',inst.paths.siteConfig]:[])],{cwd:stagedCore,env}))||'passed'}`);
   const tested=live.filter(s=>s.kind==='plugins'&&s.plugins.includes('plugins')&&hasTests(s,place(s)));
   if(tested.length)lines.push(`tests (plugins): ${summary(runStep(ctx,'the plugin tests against the target core',ctx.node,[runner,...tested.flatMap(s=>['--plugins',place(s)])],{cwd:stagedCore,env}))||'passed'}`);
   else if(live.length>1)lines.push('tests (plugins): the plugin sources have no tests');
  }
  // 7. would it start, with this instance's site and these plugins
  if(/'--check'/.test(readFileSync(path.join(stagedCore,'server','index.mjs'),'utf8'))){
   say('Start-up check with this instance\'s configuration:');
   const r=runStep(ctx,'The start-up check (node server/index.mjs --check)',ctx.node,[path.join(stagedCore,'server','index.mjs'),'--check'],{cwd:stagedCore,env:checkEnv,timeoutMs:120000});
   const said=r.stdout.split('\n').find(l=>l.startsWith('check ok'));
   // Exit 0 without that line means the check did not run at all (the file was loaded, not executed as the server).
   if(!said)throw new UpdateError(`The start-up check of ${target.version} ended without saying "check ok". The instance was not touched.\n${lastLines(`${r.stdout}\n${r.stderr}`,20)}`);
   lines.push(oneLine(said).replaceAll(staging,'<stage>'));
  }else lines.push(`start-up check: ${target.version} has no --check; skipped`);
  const label=(facts,commit,plugins)=>`${facts.version}${plugins.some(p=>p.version)?` (${plugins.filter(p=>p.version).map(p=>`${p.id} ${p.version}`).join(', ')})`:''} @ ${short(commit)}`;
  return {
   from:{label:label(installed,core.commit,before),core:{...installed,commit:core.commit,tag:core.tag},plugins:before.map(({id,version,dataEpoch})=>({id,version,dataEpoch})),
    expect:{version:installed.version,plugins:run?(Array.isArray(run.plugins)?run.plugins:[]).map(p=>({id:p.id,version:p.version??null})):null}},
   to:{label:label(target,targetCommit,after),core:{...target,commit:targetCommit,tag:coreTag??core.tag},plugins:after.map(({id,version,dataEpoch})=>({id,version,dataEpoch})),
    expect:{version:target.version,plugins:after.map(p=>({id:p.id,version:p.version}))}},
   changes,epochRose,lines};
 }finally{
  for(const s of added)ctx.exec('git',['-C',s.dir,'worktree','remove','--force',place(s)]);
  rmSync(staging,{recursive:true,force:true});
  for(const s of added)ctx.exec('git',['-C',s.dir,'worktree','prune']);
 }
}
function readJsonText(text){try{return JSON.parse(text);}catch{return null;}}

// --- apply ---------------------------------------------------------------------------------------------
const switchTo=(ctx,change,commit,{force=false,branch=null}={})=>{
 // Back onto the branch it was on when that branch still names the same commit; otherwise detached at the commit.
 if(branch&&git(ctx,change.dir,'rev-parse','-q','--verify',`refs/heads/${branch}^{commit}`)===commit)return gitDo(ctx,change.dir,'checkout','--quiet',...(force?['--force']:[]),branch);
 return gitDo(ctx,change.dir,'checkout','--quiet','--detach',...(force?['--force']:[]),commit);
};
const pathsLine=(inst,journal)=>`  journal  ${inst.files.journal}\n  archive  ${journal.backup?.file??'(none was made)'}\n  history  ${inst.files.history}`;

/**
 * Puts the `from` side of a journal back: stop, switch the code back, restore the archive when the data epoch rose
 * and the new version ran, note the quarantine, start, health check. Ends as rolled-back (or aborted, when nothing had
 * been switched yet). When that fails the service is left stopped and RollbackFailed names the files that matter.
 */
async function undo(inst,ctx,journal){
 const switched=!['stopping','backup'].includes(journal.undoFrom??journal.step);
 if(journal.step!=='rolling-back'&&journal.step!=='rollback-failed')journal.undoFrom=journal.step;
 journal.step='rolling-back';writeJournal(inst,journal);
 try{
  const head=change=>git(ctx,change.dir,'rev-parse','HEAD');
  const moved=journal.changes.some(c=>head(c)!==c.from);
  // Nothing was switched and the old hub still answers as before (a stop that was refused, or one that said yes
  // and stopped nothing): there is nothing to put back, and stopping it again would only fail the same way.
  const untouched=!switched&&!moved&&(await ctx.probe(inst.health.url))&&!runMismatch(readRun(inst),journal.from.expect,{pidAlive:ctx.pidAlive});
  if(untouched)ctx.log('  the hub still runs as it did; nothing was changed. Check the service\'s stop command before trying again.');
  if(!untouched){
   await stopService(inst,ctx,readRun(inst)?.pid??null);
   for(const c of journal.changes)if(head(c)!==c.from||c.branch){ctx.log(`  ${c.id}: back to ${short(c.from)}${c.branch?` (${c.branch})`:''}`);switchTo(ctx,c,c.from,{force:true,branch:c.branch});}
   if(journal.epochRose&&journal.started&&!journal.restored){
    if(!journal.backup)throw new Error('the data epoch rose and the new version was started, but the journal names no archive');
    ctx.log(`  restoring ${journal.backup.file} (the data epoch rose, and the new version has written its state)`);
    journal.failedState=restoreArchive(inst,ctx,journal.backup);journal.restored=true;writeJournal(inst,journal);
   }
   if(journal.quarantine&&journal.to.core.version!==journal.from.core.version){
    if(!setQuarantine(inst.files.updates,journal.to.core.version,{at:iso(ctx.now()),reason:journal.quarantine.reason}))ctx.log(`  (${inst.files.updates} belongs to newer code; the quarantine note was not written)`);
   }
   const since=ctx.now();
   await startService(inst,ctx);
   await waitHealthy(inst,ctx,journal.from.expect,since,{interruptible:false});
  }
  journal.step=switched||moved?'rolled-back':'aborted';journal.finishedAt=iso(ctx.now());writeJournal(inst,journal);
  history(inst,ctx,journal,journal.step);
  return journal;
 }catch(e){
  journal.step='rollback-failed';journal.rollbackError=oneLine(e.message);writeJournal(inst,journal);
  history(inst,ctx,journal,'rollback-failed');
  try{ctx.exec(inst.service.stop[0],inst.service.stop.slice(1),{timeoutMs:60000});}catch{}
  throw new RollbackFailed(`The previous version could not be brought back: ${e.message}\nThe service was told to stop and is left stopped. Look at these, fix the cause, then run "rollback" again:\n${pathsLine(inst,journal)}`);
 }
}

/** An update that did not finish (a crash, a lost session) is put back. → the journal, or null when there was nothing to do. */
export async function recover(inst,ctx){
 const journal=readJournal(inst);
 if(!unfinished(journal))return null;
 needService(inst);
 const release=takeLock(inst,ctx);
 try{
  ctx.log(`An update begun ${journal.startedAt} (${journal.from.label} → ${journal.to.label}) stopped at "${journal.step}". Putting ${journal.from.label} back:`);
  journal.failure??={step:journal.step,message:'the update was interrupted'};
  return await undo(inst,ctx,journal);
 }finally{release();}
}

/** preflight, then the update itself. → {journal, plan}. Throws UpdateError (nothing changed, or everything was put back) or RollbackFailed. */
export async function apply(inst,request,ctx){
 needService(inst);
 const release=takeLock(inst,ctx);
 try{
  if(unfinished(readJournal(inst)))throw new UpdateError(`An earlier update did not finish (${inst.files.journal}). Run this command again with "rollback" or "status".`);
  ctx.log('Preflight:');
  const plan=await preflight(inst,request,ctx,{forApply:true});
  for(const line of plan.lines)ctx.log(`  ${line}`);
  ctx.checkpoint();
  const started=ctx.now(),run=readRun(inst);
  const journal={schemaVersion:JOURNAL_SCHEMA,id:`${stampOf(started)}-${process.pid}`,startedAt:iso(started),by:ctx.user??null,from:plan.from,to:plan.to,changes:plan.changes,epochRose:plan.epochRose,
   settings:{service:inst.service.spec,health:inst.health,root:inst.root,home:inst.home,state:inst.paths.state},step:'stopping',started:false,backup:null};
  writeJournal(inst,journal);
  const fail=async(e,quarantine)=>{
   journal.failure={step:journal.step,message:oneLine(e.message)};
   if(e.stopRefused)journal.stopRefused=true;
   // A lost session or Ctrl-C says nothing about the release: it is put back, and not noted as a release that failed.
   if(quarantine&&!e.interrupted)journal.quarantine={reason:oneLine(e.message,120)};
   ctx.log(`\nFAILED at "${journal.step}": ${e.message}\nPutting ${plan.from.label} back:`);
   await undo(inst,ctx,journal);
   throw new UpdateError(`The update to ${plan.to.label} failed at "${journal.failure.step}": ${e.message}\n${journal.step==='aborted'?'Nothing had been switched':'It was rolled back'}; ${plan.from.label} is running again.${journal.quarantine&&plan.to.core.version!==plan.from.core.version?` ${plan.to.core.version} is noted as tried and rolled back (the update card says so; --force tries it again).`:''}\n${pathsLine(inst,journal)}`);
  };
  try{
   ctx.log(`\nStopping the hub (${plan.from.label}):`);
   await stopService(inst,ctx,run?.pid??null);
   ctx.checkpoint();
   journal.step='backup';writeJournal(inst,journal);
   ctx.log('Archiving, with the hub stopped:');
   journal.backup=makeArchive(inst,ctx,`pre-${plan.from.core.version}-to-${plan.to.core.version}-${stampOf(started)}`);
   ctx.log(`  ${journal.backup.file} (${journal.backup.entries.map(e=>e.name).join(', ')}; ${journal.backup.files} entries, ${Math.ceil(journal.backup.bytes/1024)} KiB)`);
   ctx.checkpoint();
  }catch(e){await fail(e,false);}
  try{
   journal.step='switching';writeJournal(inst,journal);
   ctx.log('Switching:');
   for(const c of plan.changes){ctx.log(`  ${c.id}: ${short(c.from)} → ${c.tag} (${short(c.to)}), detached`);switchTo(ctx,c,c.to);}
   journal.step='switched';writeJournal(inst,journal);
   setQuarantine(inst.files.updates,plan.to.core.version,null);
   ctx.checkpoint();
   journal.step='starting';journal.started=true;writeJournal(inst,journal);
   ctx.log(`Starting ${plan.to.label}:`);
   const since=ctx.now();
   await startService(inst,ctx);
   await waitHealthy(inst,ctx,plan.to.expect,since);
  }catch(e){await fail(e,true);}
  journal.step='done';journal.finishedAt=iso(ctx.now());writeJournal(inst,journal);
  history(inst,ctx,journal,'done');
  pruneArchives(inst,ctx,journal.backup.file);
  return {journal,plan};
 }finally{release();}
}

/** The last update, undone by hand. yes: required when the data epoch rose (the archive is restored and later writes are lost). */
export async function rollback(inst,ctx,{yes=false,reason=null}={}){
 needService(inst);
 const journal=readJournal(inst);
 if(!journal)throw new UpdateError(`There is no update to go back from (${inst.files.journal} does not exist).`);
 if(unfinished(journal)){const done=await recover(inst,ctx);return {journal:done,recovered:true};}
 if(journal.step!=='done')throw new UpdateError(`The last update (${journal.from.label} → ${journal.to.label}) already ended as "${journal.step}"; there is nothing to go back from.`);
 const release=takeLock(inst,ctx);
 try{
  const moved=journal.changes.filter(c=>git(ctx,c.dir,'rev-parse','HEAD')!==c.to);
  if(moved.length)throw new UpdateError(`${moved.map(c=>c.dir).join(', ')} is no longer on what the last update installed (${journal.to.label}); "rollback" only undoes that update.`);
  if(journal.epochRose){
   if(!journal.backup||!existsSync(journal.backup.file))throw new UpdateError(`The data epoch rose in that update, so going back needs its archive, and ${journal.backup?.file??'it'} is gone. The old code cannot read the current state.`);
   if(!yes)throw new UpdateError(`The data epoch rose in the update of ${journal.finishedAt}. Going back restores ${journal.backup.file}: everything written since then is lost (tickets, feedback, inventory edits, history). The current state is moved to ${path.join(inst.backups,'failed-<time>')}, not deleted. Say --yes to do it.`);
  }
  ctx.log(`Going back from ${journal.to.label} to ${journal.from.label}:`);
  journal.started=true;journal.failure={step:'done',message:oneLine(reason)||'rolled back by hand'};journal.quarantine={reason:oneLine(reason,120)||'rolled back by hand'};
  return {journal:await undo(inst,ctx,journal),recovered:false};
 }finally{release();}
}

/** Only the archive: stop, archive, start, health check. */
export async function backup(inst,ctx){
 needService(inst);
 const release=takeLock(inst,ctx);
 try{
  if(unfinished(readJournal(inst)))throw new UpdateError(`An earlier update did not finish (${inst.files.journal}). Run "rollback" first.`);
  const run=readRun(inst),version=coreFacts(inst.root)?.version??'unknown';
  if(!(await ctx.probe(inst.health.url)))throw new UpdateError(`${inst.health.url} does not answer; this command stops and starts a hub that is running.`);
  ctx.log('Stopping the hub:');
  await stopService(inst,ctx,run?.pid??null);
  let made=null,error=null;
  try{made=makeArchive(inst,ctx,`manual-${version}-${stampOf(ctx.now())}`);}catch(e){error=e;}
  ctx.log('Starting it again:');
  const since=ctx.now();
  await startService(inst,ctx);
  await waitHealthy(inst,ctx,{version:run?.version??version},run?since:0);
  if(error)throw new UpdateError(`The archive failed: ${error.message}. The hub is running again.`);
  return made;
 }finally{release();}
}

// --- status --------------------------------------------------------------------------------------------
export function status(inst,ctx){
 const sources=inst.sources.map(s=>{const g=inspectSource(ctx,s);return {id:s.id,kind:s.kind,dir:s.dir,git:g.git,commit:g.commit,branch:g.branch,tag:g.tag,dirty:g.dirty.length,version:parse(readJson(path.join(s.dir,'package.json'))?.version)?.text??null};});
 const installed=coreFacts(inst.root),run=readRun(inst),known=readJson(inst.files.updates),journal=readJournal(inst),core=sources[0];
 const newest=core.git?newestTag(ctx,inst.root):null;
 return {root:inst.root,home:inst.home,paths:inst.paths,backups:inst.backups,journalFile:inst.files.journal,installed:{...installed,commit:core.commit,branch:core.branch,tag:core.tag,exact:core.tag===`v${installed?.version}`},
  sources,plugins:pluginsOf(inst).map(({id,version,core:range,dataEpoch})=>({id,version,core:range,dataEpoch})),
  running:run?{version:run.version,pid:run.pid,alive:ctx.pidAlive(run.pid),startedAt:run.startedAt,plugins:run.plugins}:null,
  newestTag:newest,newerTag:newest&&installed&&compare(newest.slice(1),installed.version)>0?newest:null,
  known:plain(known?.sources?.core)?{version:known.sources.core.version??null,checkedAt:known.sources.core.checkedAt??null,failedAt:known.sources.core.failedAt??null}:null,
  quarantined:plain(known?.quarantined)?known.quarantined:{},
  service:inst.service?{kind:inst.service.kind,stop:inst.service.stop,start:inst.service.start}:null,health:inst.health,
  journal:journal?{id:journal.id,step:journal.step,unfinished:unfinished(journal),startedAt:journal.startedAt,finishedAt:journal.finishedAt??null,from:journal.from.label,to:journal.to.label,epochRose:journal.epochRose,
   archive:journal.backup?.file??null,failure:journal.failure??null}:null};
}
export function formatStatus(s){
 const out=[`Home Hub ${s.installed.version??'?'}${s.installed.exact?'':'+dev'} @ ${short(s.installed.commit)}${s.installed.branch?` (branch ${s.installed.branch})`:s.installed.tag?` (${s.installed.tag}, detached)`:' (detached)'}, data epoch ${s.installed.dataEpoch??'?'}`,
  `  checkout  ${s.root}${s.sources[0].dirty?`  (${s.sources[0].dirty} tracked file(s) changed)`:''}`,
  ...(s.home?[`  instance  ${s.home}`]:[]),`  data      ${s.paths.data}`,`  state     ${s.paths.state}`,`  private   ${s.paths.private}`,`  backups   ${s.backups}`];
 for(const src of s.sources.slice(1))out.push(`  plugins   ${src.dir}${src.version?`  ${src.id} ${src.version}`:''} @ ${src.git?short(src.commit)+(src.tag?` (${src.tag})`:''):'not a git checkout'}`);
 if(s.plugins.length)out.push(`  plugins   ${s.plugins.map(p=>`${p.id}${p.version?' '+p.version:''}`).join(', ')}`);
 out.push(s.running?`Running:  ${s.running.version}, pid ${s.running.pid} ${s.running.alive?'(alive)':'(NOT running)'}, since ${s.running.startedAt}`:`Running:  unknown (no run.json in ${s.paths.state}; is this the service's state directory?)`);
 out.push(`Service:  ${s.service?`${s.service.stop.join(' ')}  |  ${s.service.start.join(' ')}`:'not configured (--service, or instance.json → service)'}`);
 out.push(`Health:   ${s.health?`${s.health.url} (${s.health.seconds} s)`:'not configured (--health, or instance.json → health)'}`);
 out.push(`Newest tag here: ${s.newestTag??'none'}${s.newerTag?`  → newer than what is installed: apply ${s.newerTag}`:''} (tags as last fetched; preflight fetches)`);
 if(s.known)out.push(`Update check: newest known release ${s.known.version??'none'}${s.known.checkedAt?`, checked ${s.known.checkedAt}`:''}${s.known.failedAt?`, last failure ${s.known.failedAt}`:''}`);
 for(const [version,q] of Object.entries(s.quarantined))out.push(`Quarantined: ${version}, tried and rolled back ${q.at}${q.reason?` (${q.reason})`:''}`);
 if(s.journal){
  const j=s.journal;
  out.push(`Last update: ${j.from} → ${j.to}, begun ${j.startedAt}: ${j.step}${j.finishedAt?` at ${j.finishedAt}`:''}${j.failure?` (${j.failure.message})`:''}`);
  if(j.archive)out.push(`  archive   ${j.archive}${j.epochRose?'  (the data epoch rose: going back needs it)':''}`);
  if(j.unfinished)out.push('  UNFINISHED: run "rollback" to put the previous version back before anything else.');
 }else out.push('Last update: none recorded');
 return out;
}
