#!/usr/bin/env node
// Collect the SSH key inventory for Home Hub → data/security/ssh-keys.json.
// Run on a machine that reaches every other one over SSH. Machines and ssh aliases come from the
// site configuration (machines[].ssh; alias "local" = this machine; ssh.keys:false leaves one out):
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

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
const opt=name=>{const i=args.indexOf(name);return i>=0?args[i+1]:null;};
const out=path.resolve(opt('--out')||path.join(root,'data','security','ssh-keys.json'));
// id=alias; "local" runs the probe on this machine. A NAS needs a sudo-capable alias to see every account.
const site=loadedSite(),hosts=sshHosts(site,m=>m.ssh.keys);
const router=site.machines.find(m=>m.role==='router'&&m.ip)||null,git=site.security;
args.forEach((a,i)=>{if(a==='--host'){const [id,alias]=String(args[i+1]||'').split('=');if(id&&alias)hosts.set(id,alias);}});
for(const [id,alias] of hosts)if(alias==='skip')hosts.delete(id);

function run(cmd,argv,{timeoutMs=240000}={}){
 return new Promise(resolve=>{
  const child=spawn(cmd,argv,{stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
  const timer=setTimeout(()=>{child.kill('SIGKILL');stderr+=`\ntimeout after ${timeoutMs/1000}s`;},timeoutMs);
  child.stdout.on('data',d=>{stdout+=d;});child.stderr.on('data',d=>{stderr+=d;});
  child.on('error',e=>{clearTimeout(timer);resolve({code:-1,stdout,stderr:String(e.message)});});
  child.on('close',code=>{clearTimeout(timer);resolve({code,stdout,stderr});});
 });
}

async function probe(alias,script){
 if(alias==='local'){const r=await run('/bin/sh',['-c',script,'ssh-probe']);return r.stdout.includes('\nEND\tok')?{text:r.stdout}:{error:(r.stderr||'probe failed').trim().split('\n').pop()};}
 // The script travels base64-encoded inside the remote command, so the remote stdin stays empty.
 const b64=Buffer.from(script).toString('base64');
 const r=await run('ssh',['-n','-o','BatchMode=yes','-o','ConnectTimeout=8',alias,`sh -c "$(printf %s ${b64} | base64 -d)" ssh-probe`]);
 if(r.stdout.includes('\nEND\tok'))return {text:r.stdout};
 return {error:(r.stderr.trim().split('\n').pop()||`exit ${r.code}`).slice(0,300)};
}

function tcpOpen(host,port,ms=3000){
 return new Promise(resolve=>{const s=net.connect({host,port});const done=v=>{s.destroy();resolve(v);};s.setTimeout(ms,()=>done(false));s.on('connect',()=>done(true));s.on('error',()=>done(false));});
}

async function tea(route){const r=await run('tea',['api',route],{timeoutMs:20000});if(r.code!==0)throw new Error(r.stderr.trim()||`tea api ${route} failed`);return JSON.parse(r.stdout);}
async function forgejoKeys(){
 const users=await tea('/admin/users').catch(async()=>[await tea('/user')]);
 const withKeys=await Promise.all(users.map(async u=>({login:u.login,isAdmin:Boolean(u.is_admin),keys:(await tea(`/users/${encodeURIComponent(u.login)}/keys`)).map(k=>({title:k.title,key:k.key,fingerprint:k.fingerprint}))})));
 const repos=(await tea('/repos/search?limit=50')).data||[];
 const deployKeys=(await Promise.all(repos.map(async r=>(await tea(`/repos/${r.full_name}/keys`).catch(()=>[])).map(k=>({repo:r.full_name,title:k.title,key:k.key,fingerprint:k.fingerprint,readOnly:k.read_only}))))).flat();
 return {url:git.gitUrl||`https://${git.gitHost}`,host:git.gitHost,users:withKeys,deployKeys};
}

const script=await readFile(path.join(root,'scripts','security','ssh-probe.sh'),'utf8');
const started=Date.now();
const [probeResults,forgejo,routerSsh]=await Promise.all([
 Promise.all([...hosts].map(async([id,alias])=>[id,await probe(alias,script)])),
 args.includes('--no-forgejo')||!git.gitHost?null:forgejoKeys().catch(e=>{console.error(`Forgejo skipped: ${e.message}`);return null;}),
 router?tcpOpen(router.ip,22):null,
]);
const descriptors=await loadMachineDescriptors(process.env.MACHINES_DIR||path.join(root,'data','machines'),machineIds(site)).catch(()=>[]);
const doc=buildSecurity({probes:Object.fromEntries(probeResults),forgejo,descriptors,site,collectedFrom:(await run('hostname',['-s'])).stdout.trim(),
 extraMachines:router?[{id:router.id,sshOpen:routerSsh,note:routerSsh?'Port 22 je otevřený, ale Home Hub k routeru SSH klíč nemá.':'SSH je na routeru vypnuté (port 22 zavřený).'}]:[]});
await mkdir(path.dirname(out),{recursive:true});
const tmp=`${out}.${process.pid}.tmp`;
await writeFile(tmp,JSON.stringify(doc,null,1)+'\n',{mode:0o600});await rename(tmp,out);
for(const m of doc.machines)console.log(`${m.id.padEnd(12)} ${m.reachable?`${m.accounts.length} účtů`:m.error||m.note||'nedostupné'}`);
console.log(`${doc.keys.length} SSH klíčů, ${doc.otherKeys.length} ostatních klíčů, ${doc.unknownAuthorized.length} cizích povolených, ${doc.findings.length} nálezů → ${path.relative(process.cwd(),out)} (${((Date.now()-started)/1000).toFixed(1)} s)`);
