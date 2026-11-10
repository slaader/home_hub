#!/usr/bin/env node
// Collect OS versions, watched software versions and host protection for Home Hub → data/systems/snapshot.json.
// Run on a machine that reaches every other one over SSH, by hand or from a scheduled job:
//   node scripts/collect-systems.mjs [--data DIR] [--host id=alias ...] [--only id,id]
// Which machines, and through which ssh alias, comes from the site configuration (machines[].ssh:
// alias + probe; alias "local" = this machine). Read-only everywhere. scripts/systems/mac-probe.sh runs
// on each Mac as the SSH user (watched binaries are never executed as root); scripts/systems/nas-probe.sh
// runs on a TrueNAS box through a sudo-capable alias because its middleware needs root. A machine that cannot be
// reached keeps its previous record, marked stale. Each run also appends one line to history.jsonl.
import {spawn} from 'node:child_process';
import {readFile,writeFile,rename,mkdir,appendFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseSystemsProbe,buildSystems,systemsSpecs,systemMachines} from '../server/systems-data.mjs';
import {site as loadedSite,sshHosts,softwareWatchPath} from '../server/site-config.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
const opt=name=>{const i=args.indexOf(name);return i>=0?args[i+1]:null;};
const dataDir=path.resolve(opt('--data')||process.env.DATA_DIR||path.join(root,'data'));
const outDir=process.env.SYSTEMS_DIR||path.join(dataDir,'systems');
const registryFile=softwareWatchPath();
const site=loadedSite(),SYSTEM_MACHINES=systemMachines(site);
// id=alias; "local" runs the probe on this machine.
const hosts=sshHosts(site,m=>m.ssh.probe);
args.forEach((a,i)=>{if(a==='--host'){const [id,alias]=String(args[i+1]||'').split('=');if(id&&alias)hosts.set(id,alias);}});
const only=opt('--only')?.split(',').filter(Boolean);
for(const [id,alias] of hosts)if(alias==='skip'||(only&&!only.includes(id)))hosts.delete(id);

function run(cmd,argv,{timeoutMs=300000}={}){
 return new Promise(resolve=>{
  const child=spawn(cmd,argv,{stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
  const timer=setTimeout(()=>{child.kill('SIGKILL');stderr+=`\ntimeout after ${timeoutMs/1000}s`;},timeoutMs);
  child.stdout.on('data',d=>{stdout+=d;if(stdout.length>4_000_000)child.kill('SIGKILL');});child.stderr.on('data',d=>{stderr+=d;});
  child.on('error',e=>{clearTimeout(timer);resolve({code:-1,stdout,stderr:String(e.message)});});
  child.on('close',code=>{clearTimeout(timer);resolve({code,stdout,stderr});});
 });
}

async function probe(id,alias,script){
 let r;
 if(alias==='local')r=await run('/bin/sh',['-c',script,'systems-probe']);
 else{
  // The script travels base64-encoded inside the remote command, so the remote stdin stays empty.
  const b64=Buffer.from(script).toString('base64');
  r=await run('ssh',['-n','-o','BatchMode=yes','-o','ConnectTimeout=8','-o','ServerAliveInterval=10','-o','ServerAliveCountMax=3',alias,`sh -c "$(printf %s ${b64} | base64 -d)" systems-probe`]);
 }
 if(r.stdout.includes('\nEND\tok'))return {record:parseSystemsProbe(r.stdout)};
 return {error:(r.stderr.trim().split('\n').pop()||`exit ${r.code}`).slice(0,300)};
}

const registry=JSON.parse(await readFile(registryFile,'utf8'));
const [macProbe,nasProbe]=await Promise.all(['mac-probe.sh','nas-probe.sh'].map(f=>readFile(path.join(root,'scripts','systems',f),'utf8')));
const previous=await readFile(path.join(outDir,'snapshot.json'),'utf8').then(JSON.parse).catch(()=>null);
const started=Date.now();
const results=await Promise.all([...hosts].map(async([id,alias])=>{
 const kind=SYSTEM_MACHINES.find(m=>m.id===id)?.kind||'mac';
 const script=kind==='nas'?nasProbe:`SPECS='${systemsSpecs(registry,id)}'\n${macProbe}`;
 return [id,alias,await probe(id,alias,script)];
}));
const machines={...(previous?.machines||{})};
for(const [id,alias,res] of results){
 if(res.record)machines[id]={...res.record,alias,stale:false,lastError:null};
 else if(machines[id])machines[id]={...machines[id],stale:true,lastError:res.error,lastAttemptAt:new Date().toISOString()};
 else machines[id]={host:id,alias,complete:false,stale:false,lastError:res.error,lastAttemptAt:new Date().toISOString(),os:{},hw:{},osUpdates:{checked:false,items:[]},
  autoUpdate:{},firewall:{},sshd:{allowUsers:[]},sharing:{},listening:[],software:{},running:{},brewOutdated:[],docker:[],apps:[],services:[],errors:[]};
}
const snapshot={schemaVersion:1,collectedAt:new Date().toISOString(),collectedFrom:(await run('hostname',['-s'])).stdout.trim(),machines};
await mkdir(outDir,{recursive:true,mode:0o700});
const file=path.join(outDir,'snapshot.json'),tmp=`${file}.${process.pid}.tmp`;
await writeFile(tmp,JSON.stringify(snapshot,null,1)+'\n',{mode:0o600});await rename(tmp,file);

// History for trend charts: one compact line per run, capped at ~2 years of 6-hourly runs.
const upstream=await readFile(path.join(outDir,'upstream.json'),'utf8').then(JSON.parse).catch(()=>null);
const doc=buildSystems({snapshot,upstream,registry,machines:SYSTEM_MACHINES});
const line={at:snapshot.collectedAt,machines:Object.fromEntries(doc.machines.filter(m=>m.summary).map(m=>[m.id,{os:m.summary.osUpdate,software:m.summary.softwareUpdates,apps:m.summary.appUpdates,warn:m.summary.checks.warn,crit:m.summary.checks.crit,stale:m.stale}]))};
const histFile=path.join(outDir,'history.jsonl');
const hist=(await readFile(histFile,'utf8').catch(()=>'')).split('\n').filter(Boolean);
if(hist.length>=3000){const keep=hist.slice(-2999);await writeFile(histFile,keep.join('\n')+'\n'+JSON.stringify(line)+'\n',{mode:0o600});}
else await appendFile(histFile,JSON.stringify(line)+'\n',{mode:0o600});

for(const m of doc.machines){
 if(!hosts.has(m.id))continue;
 const s=m.summary;
 console.log(`${m.id.padEnd(12)} ${m.stale?'STALE ':''}${m.reachable?`${m.os?.name} ${m.os?.version} · OS ${m.os?.status} · ${s.softwareUpdates} software + ${s.appUpdates} apps to update · checks warn ${s.checks.warn} crit ${s.checks.crit}`:m.error||'unreachable'}`);
}
console.log(`${doc.software.length} software rows → ${path.relative(process.cwd(),file)} (${((Date.now()-started)/1000).toFixed(1)} s)${upstream?'':' · no upstream.json yet: run node scripts/check-upstream.mjs'}`);
