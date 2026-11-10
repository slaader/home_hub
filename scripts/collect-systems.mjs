#!/usr/bin/env node
// Collect OS versions, watched software versions and host protection for Home Hub → data/systems/snapshot.json.
// Run on a machine that reaches every other one over SSH, by hand or from a scheduled job
// (scripts/systems/install-launchd.sh on macOS, examples/systemd/ on Linux):
//   node scripts/collect-systems.mjs [--data DIR] [--host id=alias ...] [--only id,id]
// Which machines, and through which ssh alias, comes from the site configuration (machines[].ssh:
// alias + probe; alias "local" = this machine). Without any such machine there is nothing to do: the
// script says what to add and writes nothing. Read-only everywhere: nothing is installed, upgraded or
// written on a probed machine. scripts/systems/mac-probe.sh runs on each Mac as the SSH user (watched
// binaries are never executed as root); scripts/systems/nas-probe.sh runs on a TrueNAS box through a
// sudo-capable alias because its middleware needs root. A machine that cannot be reached keeps its
// previous record, marked stale. Each run also appends one line to history.jsonl.
import {spawn} from 'node:child_process';
import {readFile,writeFile,rename,mkdir,appendFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseSystemsProbe,buildSystems,systemsSpecs,systemMachines} from '../server/systems-data.mjs';
import {site as loadedSite,sshHosts} from '../server/site-config.mjs';
import {readWatch,checkWatch} from '../server/software-watch.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

// Runs one command; never throws. → {code, stdout, stderr}
export function run(cmd,argv,{timeoutMs=300000}={}){
 return new Promise(resolve=>{
  const child=spawn(cmd,argv,{stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
  const timer=setTimeout(()=>{child.kill('SIGKILL');stderr+=`\ntimeout after ${timeoutMs/1000}s`;},timeoutMs);
  child.stdout.on('data',d=>{stdout+=d;if(stdout.length>4_000_000)child.kill('SIGKILL');});child.stderr.on('data',d=>{stderr+=d;});
  child.on('error',e=>{clearTimeout(timer);resolve({code:-1,stdout,stderr:String(e.message)});});
  child.on('close',code=>{clearTimeout(timer);resolve({code,stdout,stderr});});
 });
}

// One machine. exec is run() or a stand-in with the same signature (the tests pass one, so no test ever
// opens an SSH connection). → {record} | {error}
export async function probeMachine(alias,script,exec=run){
 let r;
 if(alias==='local')r=await exec('/bin/sh',['-c',script,'systems-probe']);
 else{
  // The script travels base64-encoded inside the remote command, so the remote stdin stays empty.
  const b64=Buffer.from(script).toString('base64');
  r=await exec('ssh',['-n','-o','BatchMode=yes','-o','ConnectTimeout=8','-o','ServerAliveInterval=10','-o','ServerAliveCountMax=3',alias,`sh -c "$(printf %s ${b64} | base64 -d)" systems-probe`]);
 }
 if(r.stdout.includes('\nEND\tok'))return {record:parseSystemsProbe(r.stdout)};
 return {error:(r.stderr.trim().split('\n').pop()||`exit ${r.code}`).slice(0,300)};
}
const emptyRecord=(id,alias,error,at)=>({host:id,alias,complete:false,stale:false,lastError:error,lastAttemptAt:at,os:{},hw:{},osUpdates:{checked:false,items:[]},
 autoUpdate:{},firewall:{},sshd:{allowUsers:[]},sharing:{},listening:[],software:{},running:{},brewOutdated:[],docker:[],apps:[],services:[],errors:[]});

/**
 * Probe every host, merge with the previous snapshot and write snapshot.json and history.jsonl in outDir.
 * hosts: Map id → ssh alias; registry: the software watch list; exec: see probeMachine.
 * → {snapshot, doc, file, upstream}
 */
export async function collectSystems({site=loadedSite(),hosts=sshHosts(site,m=>m.ssh.probe),registry,outDir,exec=run,now=()=>new Date().toISOString(),
 collectedFrom=null,probesDir=path.join(root,'scripts','systems')}){
 const machineList=systemMachines(site);
 const [macProbe,nasProbe]=await Promise.all(['mac-probe.sh','nas-probe.sh'].map(f=>readFile(path.join(probesDir,f),'utf8')));
 const previous=await readFile(path.join(outDir,'snapshot.json'),'utf8').then(JSON.parse).catch(()=>null);
 const results=await Promise.all([...hosts].map(async([id,alias])=>{
  const kind=machineList.find(m=>m.id===id)?.kind||'mac';
  const script=kind==='nas'?nasProbe:`SPECS='${systemsSpecs(registry,id)}'\n${macProbe}`;
  return [id,alias,await probeMachine(alias,script,exec)];
 }));
 const machines={...(previous?.machines||{})};
 for(const [id,alias,res] of results){
  if(res.record)machines[id]={...res.record,alias,stale:false,lastError:null};
  else if(machines[id])machines[id]={...machines[id],stale:true,lastError:res.error,lastAttemptAt:now()};
  else machines[id]=emptyRecord(id,alias,res.error,now());
 }
 const snapshot={schemaVersion:1,collectedAt:now(),collectedFrom:collectedFrom??(await exec('hostname',['-s'])).stdout.trim(),machines};
 await mkdir(outDir,{recursive:true,mode:0o700});
 const file=path.join(outDir,'snapshot.json'),tmp=`${file}.${process.pid}.tmp`;
 await writeFile(tmp,JSON.stringify(snapshot,null,1)+'\n',{mode:0o600});await rename(tmp,file);

 // History for trend charts: one compact line per run, capped at ~2 years of 6-hourly runs.
 const upstream=await readFile(path.join(outDir,'upstream.json'),'utf8').then(JSON.parse).catch(()=>null);
 const doc=buildSystems({snapshot,upstream,registry,machines:machineList});
 const line={at:snapshot.collectedAt,machines:Object.fromEntries(doc.machines.filter(m=>m.summary).map(m=>[m.id,{os:m.summary.osUpdate,software:m.summary.softwareUpdates,apps:m.summary.appUpdates,warn:m.summary.checks.warn,crit:m.summary.checks.crit,stale:m.stale}]))};
 const histFile=path.join(outDir,'history.jsonl');
 const hist=(await readFile(histFile,'utf8').catch(()=>'')).split('\n').filter(Boolean);
 if(hist.length>=3000){const keep=hist.slice(-2999);await writeFile(histFile,keep.join('\n')+'\n'+JSON.stringify(line)+'\n',{mode:0o600});}
 else await appendFile(histFile,JSON.stringify(line)+'\n',{mode:0o600});
 return {snapshot,doc,file,upstream};
}

export const NOTHING_TO_PROBE=`No machine to probe yet. Nothing was written.
 1. In local/site.json give each machine an ssh entry: "ssh": {"alias": "<ssh config alias>", "probe": "mac"}
    ("nas" for TrueNAS; "alias": "local" for the machine this runs on). config/site.example.json shows one.
 2. Check that  ssh <alias> true  works without a password prompt from this machine.
 3. Run  node scripts/collect-systems.mjs  again, then install the scheduled job:
    sh scripts/systems/install-launchd.sh   (macOS)   or   examples/systemd/   (Linux).`;

if(process.argv[1]===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2);
 const opt=name=>{const i=args.indexOf(name);return i>=0?args[i+1]:null;};
 const dataDir=path.resolve(opt('--data')||process.env.DATA_DIR||path.join(root,'data'));
 const outDir=process.env.SYSTEMS_DIR||path.join(dataDir,'systems');
 const site=loadedSite();
 // id=alias; "local" runs the probe on this machine.
 const hosts=sshHosts(site,m=>m.ssh.probe);
 args.forEach((a,i)=>{if(a==='--host'){const [id,alias]=String(args[i+1]||'').split('=');if(id&&alias)hosts.set(id,alias);}});
 const only=opt('--only')?.split(',').filter(Boolean);
 for(const [id,alias] of hosts)if(alias==='skip'||(only&&!only.includes(id)))hosts.delete(id);
 if(!hosts.size){console.log(NOTHING_TO_PROBE);process.exit(0);}
 const watch=await readWatch();
 const problems=checkWatch(watch.registry,{machines:site.machines.filter(m=>m.ssh?.probe==='mac').map(m=>m.id)});
 for(const p of [...problems.errors,...problems.warnings].slice(0,20))console.warn(`watch list: ${p}`);
 const started=Date.now();
 const {doc,file,upstream}=await collectSystems({site,hosts,registry:watch.registry,outDir});
 for(const m of doc.machines){
  if(!hosts.has(m.id))continue;
  const s=m.summary;
  console.log(`${m.id.padEnd(12)} ${m.stale?'STALE ':''}${m.reachable?`${m.os?.name} ${m.os?.version} · OS ${m.os?.status} · ${s.softwareUpdates} software + ${s.appUpdates} apps to update · checks warn ${s.checks.warn} crit ${s.checks.crit}`:m.error||'unreachable'}`);
 }
 const hint=watch.source==='none'?' · no software watch list yet (local/software-watch.json): only operating systems, NAS apps and containers are listed':upstream?'':' · no upstream.json yet: run node scripts/check-upstream.mjs';
 console.log(`${doc.software.length} software rows → ${path.relative(process.cwd(),file)} (${((Date.now()-started)/1000).toFixed(1)} s)${hint}`);
}
