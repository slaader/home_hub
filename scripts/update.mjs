#!/usr/bin/env node
// Update this Home Hub to a release tag, with a way back. Run it on the server, as the person (or the agent)
// who may restart the service; the hub itself never runs it, and nothing in the hub can (docs/updating.md).
//
//   node scripts/update.mjs status                          what is installed and running, the newest tag, the last update
//   node scripts/update.mjs preflight [v1.3.0]              everything that can be checked without touching the instance
//   node scripts/update.mjs apply     [v1.3.0]              preflight, stop, archive, switch, start, health check; back on any failure
//   node scripts/update.mjs rollback  [--yes]               undo the last update (or finish putting back one that was cut short)
//   node scripts/update.mjs backup                          only the archive (stop, archive, start)
//
// Without a tag: the newest release tag after a fetch. --to <tag> is the same as the bare tag.
// --plugins [<source>=]<tag>   also (or only) switch a plugin source, a git checkout of its own, to its tag
//
// Which installation: this checkout, or --root DIR (a release that has no update command yet is updated by running
// this file from a newer checkout with --root). Where its data is: the same variables the server reads
// (HOME_HUB_HOME, DATA_DIR, STATE_DIR, HOME_HUB_PRIVATE_DIR), or --home, --data, --state, --private.
// How it is stopped, started and checked: <HOME_HUB_HOME>/instance.json → service, health, backups; or
//   --service launchd:system/<label> | launchd:gui/<uid>/<label> | systemd:<unit> | systemd-user:<unit> | 'command:{"stop":[…],"start":[…]}'
//   --health http://127.0.0.1:<port>/healthz   [--health-seconds 60]
//   --backups DIR  [--keep 5]                  where archives go (default <home>/backups, else <checkout>/backups)
// Other: --no-fetch (use the tags that are here), --skip-tests, --allow-unsigned, --force (a release that was rolled
// back here before), --staging DIR (where the scratch worktree is made), --reason TEXT (rollback), --json (status).
//
// Exit: 0 done; 1 refused, or failed and put back (the previous version runs); 2 usage; 3 the previous version could
// not be brought back and the service is stopped.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {resolveInstance,preflight,apply,rollback,backup,recover,status,formatStatus,readJournal,unfinished,realContext,UpdateError,RollbackFailed} from '../server/update-apply.mjs';

const VALUE=['--to','--plugins','--root','--home','--data','--state','--private','--service','--health','--health-seconds','--backups','--keep','--staging','--reason'];
const FLAG=['--no-fetch','--skip-tests','--allow-unsigned','--force','--yes','--json','--help'];
const COMMANDS=['status','preflight','apply','rollback','backup'];
const USAGE=`Usage: node scripts/update.mjs status | preflight [<tag>] | apply [<tag>] | rollback [--yes] | backup
  [--plugins [<source>=]<tag>]… [--root DIR] [--home DIR] [--data DIR] [--state DIR] [--private DIR]
  [--service SPEC] [--health URL] [--health-seconds N] [--backups DIR] [--keep N] [--staging DIR]
  [--no-fetch] [--skip-tests] [--allow-unsigned] [--force] [--reason TEXT] [--json]
docs/updating.md has the whole of it.`;

class UsageError extends Error{}
export function parseArgs(argv){
 const out={command:null,tag:null,plugins:{},flags:new Set(),values:{}};
 for(let i=0;i<argv.length;i++){
  const a=argv[i];
  if(VALUE.includes(a)){
   const v=argv[++i];if(v===undefined||v.startsWith('--'))throw new UsageError(`${a} needs a value`);
   if(a==='--plugins'){const at=v.indexOf('=');const [source,tag]=at<0?['*',v]:[v.slice(0,at),v.slice(at+1)];if(!source||!tag||out.plugins[source])throw new UsageError('--plugins takes <tag>, or <source>=<tag> once per source');out.plugins[source]=tag;}
   else if(a==='--to'){if(out.tag)throw new UsageError('the target tag is given twice');out.tag=v;}
   else out.values[a.slice(2)]=v;
  }else if(FLAG.includes(a))out.flags.add(a.slice(2));
  else if(a.startsWith('--'))throw new UsageError(`unknown option ${a}`);
  else if(!out.command)out.command=a;
  else if(!out.tag)out.tag=a;
  else throw new UsageError(`unexpected argument ${a}`);
 }
 if(out.flags.has('help'))return out;
 if(!COMMANDS.includes(out.command))throw new UsageError(out.command?`unknown command ${out.command}`:'which command?');
 if((out.tag||Object.keys(out.plugins).length)&&!['preflight','apply'].includes(out.command))throw new UsageError(`${out.command} takes no tag`);
 const whole=(name,min)=>{const v=out.values[name];if(v===undefined)return undefined;if(!/^\d{1,4}$/.test(v)||Number(v)<min)throw new UsageError(`--${name} takes a whole number`);return Number(v);};
 out.options={root:out.values.root,service:out.values.service,health:out.values.health,healthSeconds:whole('health-seconds',2),backups:out.values.backups,keep:whole('keep',1),staging:out.values.staging};
 return out;
}
/** The instance the flags and the environment name. A rollback without --service uses what the update it undoes was run with. */
export function instanceFor(args,env=process.env){
 const e={...env};
 for(const [flag,name] of [['home','HOME_HUB_HOME'],['data','DATA_DIR'],['state','STATE_DIR'],['private','HOME_HUB_PRIVATE_DIR']])if(args.values[flag])e[name]=path.resolve(args.values[flag]);
 let inst=resolveInstance({env:e,options:args.options});
 if(args.command==='rollback'&&(!inst.service||!inst.health)){
  const used=readJournal(inst)?.settings;
  if(used)inst=resolveInstance({env:e,options:{...args.options,service:args.options.service??inst.service?.spec??used.service,health:args.options.health??inst.health?.url??used.health?.url,healthSeconds:args.options.healthSeconds??inst.health?.seconds??used.health?.seconds}});
 }
 return inst;
}

export async function main(argv,{env=process.env,ctx=null,out=line=>console.log(line)}={}){
 const args=parseArgs(argv);
 if(args.flags.has('help')){out(USAGE);return 0;}
 // A lost session or Ctrl-C must not leave the hub stopped: the signal is noted and the next step puts things back.
 let signal=null;
 const note=name=>{signal=name;};
 const signals=['SIGINT','SIGTERM','SIGHUP'];
 if(!ctx)for(const name of signals)process.on(name,note);
 const world=ctx??realContext({log:out,checkpoint:()=>{if(signal)throw Object.assign(new Error(`interrupted (${signal})`),{interrupted:true});}});
 try{
  const inst=instanceFor(args,env);
  const request={core:args.tag,plugins:args.plugins,fetch:!args.flags.has('no-fetch'),skipTests:args.flags.has('skip-tests'),allowUnsigned:args.flags.has('allow-unsigned'),force:args.flags.has('force')};
  if(args.command==='status'){
   const s=status(inst,world);
   if(args.flags.has('json'))out(JSON.stringify(s,null,1));else for(const line of formatStatus(s))out(line);
   return s.journal?.unfinished?1:0;
  }
  if(args.command==='preflight'){
   if(unfinished(readJournal(inst)))out(`NOTE: an earlier update did not finish (${inst.files.journal}); "rollback" puts it back.`);
   out(`Preflight for ${inst.root}:`);
   const plan=await preflight(inst,request,world);
   for(const line of plan.lines)out(`  ${line}`);
   out(`\nPreflight passed: ${plan.from.label} → ${plan.to.label}. Nothing was changed.`);
   if(!inst.service||!inst.health)out('To apply it, also say how the hub is stopped, started and checked: --service and --health (or instance.json).');
   return 0;
  }
  if(args.command==='apply'){
   if(unfinished(readJournal(inst))){
    const done=await recover(inst,world);
    out(`\nThe earlier update was put back (${done.step}); ${done.from.label} is running. Nothing new was applied: run the command again when you are ready.`);
    return 1;
   }
   const {journal,plan}=await apply(inst,request,world);
   out(`\nUpdated: ${plan.from.label} → ${plan.to.label} in ${Math.round((Date.parse(journal.finishedAt)-Date.parse(journal.startedAt))/1000)} s. The hub answers at ${inst.health.url}.`);
   out(`  archive  ${journal.backup.file}`);
   out(plan.epochRose?'  The data epoch rose: "rollback --yes" restores that archive, and what is written from now on would be lost.':'  To go back: the same command with "rollback" (the data epoch did not change; nothing written since is lost).');
   return 0;
  }
  if(args.command==='rollback'){
   const {journal,recovered}=await rollback(inst,world,{yes:args.flags.has('yes'),reason:args.values.reason??null});
   out(`\n${recovered?'The unfinished update was put back':'Rolled back'}: ${journal.from.label} is running (${journal.step}).${journal.restored?` The state from before the update was restored; what was there is in ${journal.failedState}.`:''}`);
   return 0;
  }
  const made=await backup(inst,world);
  out(`\nArchive: ${made.file} (${made.entries.map(e=>e.name).join(', ')}; ${made.files} entries). The hub is running again.`);
  return 0;
 }catch(e){
  if(e instanceof RollbackFailed){console.error(`\nROLLBACK FAILED. ${e.message}`);return 3;}
  if(e instanceof UpdateError){console.error(`\n${e.message}`);return 1;}
  throw e;
 }finally{if(!ctx)for(const name of signals)process.off(name,note);}
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
 try{process.exitCode=await main(process.argv.slice(2));}
 catch(e){if(e instanceof UsageError){console.error(`${e.message}\n${USAGE}`);process.exitCode=2;}else{console.error(e.stack||e.message);process.exitCode=1;}}
}
