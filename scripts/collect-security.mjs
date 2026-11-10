#!/usr/bin/env node
// Collect the SSH key inventory for Home Hub → data/security/ssh-keys.json.
// Run on a machine that reaches every other one over SSH, by hand or from a scheduled job. Machines and
// ssh aliases come from the site configuration (machines[].ssh; alias "local" = this machine;
// ssh.keys:false leaves one out). Without any such machine the script says what to add and writes nothing.
//   node scripts/collect-security.mjs [--out FILE] [--host id=alias ...] [--no-forgejo]
// Read-only everywhere. The probe (scripts/security/ssh-probe.sh) runs on each machine and
// sends back fingerprints, paths, public authorized_keys lines, ssh -G routes and sudo -l
// rules; private keys never leave the machine they are on. Forgejo keys come from `tea api`.
import {spawn} from 'node:child_process';
import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildSecurity} from '../server/security-data.mjs';
import {loadMachineDescriptors} from '../server/home-data.mjs';
import {site as loadedSite,sshHosts,machineIds} from '../server/site-config.mjs';
import {collectorRun} from '../server/collector-run.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

// Runs one command; never throws. → {code, stdout, stderr}
export function run(cmd,argv,{timeoutMs=240000}={}){
 return new Promise(resolve=>{
  const child=spawn(cmd,argv,{stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
  const timer=setTimeout(()=>{child.kill('SIGKILL');stderr+=`\ntimeout after ${timeoutMs/1000}s`;},timeoutMs);
  child.stdout.on('data',d=>{stdout+=d;});child.stderr.on('data',d=>{stderr+=d;});
  child.on('error',e=>{clearTimeout(timer);resolve({code:-1,stdout,stderr:String(e.message)});});
  child.on('close',code=>{clearTimeout(timer);resolve({code,stdout,stderr});});
 });
}

// One machine. exec is run() or a stand-in with the same signature (tests never open an SSH connection).
export async function probeKeys(alias,script,exec=run){
 if(alias==='local'){const r=await exec('/bin/sh',['-c',script,'ssh-probe']);return r.stdout.includes('\nEND\tok')?{text:r.stdout}:{error:(r.stderr||'probe failed').trim().split('\n').pop()};}
 // The script travels base64-encoded inside the remote command, so the remote stdin stays empty.
 const b64=Buffer.from(script).toString('base64');
 const r=await exec('ssh',['-n','-o','BatchMode=yes','-o','ConnectTimeout=8',alias,`sh -c "$(printf %s ${b64} | base64 -d)" ssh-probe`]);
 if(r.stdout.includes('\nEND\tok'))return {text:r.stdout};
 return {error:(r.stderr.trim().split('\n').pop()||`exit ${r.code}`).slice(0,300)};
}

export function tcpOpen(host,port,ms=3000){
 return new Promise(resolve=>{const s=net.connect({host,port});const done=v=>{s.destroy();resolve(v);};s.setTimeout(ms,()=>done(false));s.on('connect',()=>done(true));s.on('error',()=>done(false));});
}

// Account and deploy keys of the site's Forgejo, read with the `tea` command-line client.
export async function forgejoKeys(git,exec=run){
 const tea=async route=>{const r=await exec('tea',['api',route],{timeoutMs:20000});if(r.code!==0)throw new Error(r.stderr.trim()||`tea api ${route} failed`);return JSON.parse(r.stdout);};
 const users=await tea('/admin/users').catch(async()=>[await tea('/user')]);
 const withKeys=await Promise.all(users.map(async u=>({login:u.login,isAdmin:Boolean(u.is_admin),keys:(await tea(`/users/${encodeURIComponent(u.login)}/keys`)).map(k=>({title:k.title,key:k.key,fingerprint:k.fingerprint}))})));
 const repos=(await tea('/repos/search?limit=50')).data||[];
 const deployKeys=(await Promise.all(repos.map(async r=>(await tea(`/repos/${r.full_name}/keys`).catch(()=>[])).map(k=>({repo:r.full_name,title:k.title,key:k.key,fingerprint:k.fingerprint,readOnly:k.read_only}))))).flat();
 return {url:git.gitUrl||`https://${git.gitHost}`,host:git.gitHost,users:withKeys,deployKeys};
}

/**
 * Probe every host and write the inventory to `out`. hosts: Map id → ssh alias; exec: see probeKeys;
 * forgejo: false to skip the git server; portOpen(host, port) → boolean answers "is SSH open on the router".
 * → the document written
 */
export async function collectSecurity({site=loadedSite(),hosts=sshHosts(site,m=>m.ssh.keys),out,exec=run,forgejo=true,portOpen=tcpOpen,collectedFrom=null,now=Date.now(),
 machinesDir=process.env.MACHINES_DIR||path.join(root,'data','machines'),probeFile=path.join(root,'scripts','security','ssh-probe.sh'),warn=()=>{},started=null}){
 const router=site.machines.find(m=>m.role==='router'&&m.ip)||null,git=site.security;
 const script=await readFile(probeFile,'utf8');
 const [probeResults,forgejoDoc,routerSsh]=await Promise.all([
  Promise.all([...hosts].map(async([id,alias])=>[id,await probeKeys(alias,script,exec)])),
  !forgejo||!git.gitHost?null:forgejoKeys(git,exec).catch(e=>{warn(`Forgejo skipped: ${e.message}`);return null;}),
  router?portOpen(router.ip,22):null,
 ]);
 const descriptors=await loadMachineDescriptors(machinesDir,machineIds(site)).catch(()=>[]);
 const built=buildSecurity({probes:Object.fromEntries(probeResults),forgejo:forgejoDoc,descriptors,site,now,collectedFrom:collectedFrom??(await exec('hostname',['-s'])).stdout.trim(),
  extraMachines:router?[{id:router.id,sshOpen:routerSsh,note:routerSsh?'Port 22 je otevřený, ale Home Hub k routeru SSH klíč nemá.':'SSH je na routeru vypnuté (port 22 zavřený).'}]:[]});
 // How this run was started (a scheduled job or a terminal), when that is knowable: server/collector-run.mjs.
 const doc=started?{...built,run:started}:built;
 await mkdir(path.dirname(out),{recursive:true});
 const tmp=`${out}.${process.pid}.tmp`;
 await writeFile(tmp,JSON.stringify(doc,null,1)+'\n',{mode:0o600});await rename(tmp,out);
 return doc;
}

export const NOTHING_TO_PROBE=`No machine to read SSH keys from yet. Nothing was written.
 1. In local/site.json give each machine an ssh entry: "ssh": {"alias": "<ssh config alias>"}
    ("alias": "local" for the machine this runs on; "keys": false leaves a machine out).
 2. Check that  ssh <alias> true  works without a password prompt from this machine.
 3. Run  node scripts/collect-security.mjs  again. To keep it fresh, install the scheduled job:
    sh scripts/systems/install-launchd.sh --with-security   (macOS)   or   examples/systemd/   (Linux).`;

if(process.argv[1]===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2);
 const opt=name=>{const i=args.indexOf(name);return i>=0?args[i+1]:null;};
 const out=path.resolve(opt('--out')||path.join(opt('--data')||process.env.DATA_DIR||path.join(root,'data'),'security','ssh-keys.json'));
 // id=alias; "local" runs the probe on this machine. A NAS needs a sudo-capable alias to see every account.
 const site=loadedSite(),hosts=sshHosts(site,m=>m.ssh.keys);
 args.forEach((a,i)=>{if(a==='--host'){const [id,alias]=String(args[i+1]||'').split('=');if(id&&alias)hosts.set(id,alias);}});
 for(const [id,alias] of hosts)if(alias==='skip')hosts.delete(id);
 if(!hosts.size){console.log(NOTHING_TO_PROBE);process.exit(0);}
 const started=Date.now();
 const doc=await collectSecurity({site,hosts,out,forgejo:!args.includes('--no-forgejo'),warn:m=>console.error(m),started:collectorRun()});
 for(const m of doc.machines)console.log(`${m.id.padEnd(12)} ${m.reachable?`${m.accounts.length} accounts`:m.error||m.note||'unreachable'}`);
 console.log(`${doc.keys.length} SSH keys, ${doc.otherKeys.length} other keys, ${doc.unknownAuthorized.length} unknown authorized, ${doc.findings.length} findings → ${path.relative(process.cwd(),out)} (${((Date.now()-started)/1000).toFixed(1)} s)`);
}
