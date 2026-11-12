#!/usr/bin/env node
// Install or update a plugin's host agent on THIS machine: the code a plugin runs as a service on another machine
// than the hub (docs/plugins.md → Host agents). Run it on the target machine, from a checkout of core with the plugin
// source; the hub never pushes code to another host.
//
//   node scripts/install-host-agent.mjs --plugin memory --agent bridge              install or update, restart, check, roll back on failure
//   node scripts/install-host-agent.mjs --plugin memory --agent bridge --dry-run    print what would change; change nothing
//   … --no-service --target DIR                                                     only lay the files out in DIR
//   … --target DIR --label LABEL [--state-home DIR] [--backups DIR]                 a side-by-side test install under another label
//
// What it installs comes from three places, none of which holds a household value in code:
//   plugin.json → hostAgents[]          the entry file, the kind of service, the health probe, the config module
//   site.json → plugins.<id>.agents.<agent>.<machine>   where on this machine: {target, label, node, env, logs}
//   the plugin's config module          what the agent needs to know, rendered to <target>/config/<agent>.json (0600)
// Options: --machine ID (default: the site machine whose id or host name is this host's name), --wait S (default 30),
// --expect-like SOCKET (the new agent must answer with at least the services another agent's socket answers with),
// --allow-dirty (a test: install files that have uncommitted changes).
//
// The copy: the agent's import closure (server/agent-closure.mjs) as real files, plugin files at their path in the plugin
// source (<target>/plugins/<id>/…, <target>/lib/…) and core files under <target>/node_modules/home-hub/, so the agent
// runs with no checkout and no link. <target>/.agent-install.json records the plugin and its version, the core version,
// both commits and every file with its sha256. A later install removes the files the previous record listed that the
// new one does not (and, once, the files of a copy laid out by the older bridge installer, .bridge-install.json).
// Before it changes anything it archives <target> (without sockets) and the service file to <backups>; after the
// restart the agent must answer its health probe, else the archive is put back and the previous agent started again.
// The service: a launchd agent (launchd-agent), a launchd daemon (launchd-daemon, as root) or a systemd user unit
// (systemd-user), from scripts/host-agent/. The agent gets HOME_HUB_HOME=<target> (its configuration, its private/)
// and HOME_HUB_AGENT_SOCKET=<target>/<health.socket>.
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync,copyFileSync,chmodSync,unlinkSync,readdirSync,rmdirSync,statSync,lstatSync,mkdtempSync,rmSync} from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {agentClosure} from '../server/agent-closure.mjs';
import {AGENT_MANIFEST} from '../server/host-agent.mjs';
import {pluginsDirectories,readPluginManifest,pluginSource} from '../server/plugins.mjs';
import {loadSite,siteConfigPath} from '../server/site-config.mjs';
import {readPackage} from '../server/version.mjs';

export const coreRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const TEMPLATES=path.join(coreRoot,'scripts','host-agent');
const LEGACY_MANIFEST='.bridge-install.json';
const LABEL=/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/,ENV_KEY=/^[A-Z_][A-Z0-9_]{0,63}$/,RESERVED=['HOME','HOME_HUB_HOME','HOME_HUB_AGENT_SOCKET'];
const plain=v=>v&&typeof v==='object'&&!Array.isArray(v);
const sha256=buffer=>createHash('sha256').update(buffer).digest('hex');
class InstallError extends Error{}
const refuse=message=>{throw new InstallError(message);};

// "~/x" → the real home directory's x; anything else must be absolute.
const expand=(v,where,home=os.homedir())=>{
 if(typeof v!=='string'||!v||v.length>300||/[\u0000-\u001f]/.test(v))refuse(`${where} must be a path`);
 const p=v==='~'?home:v.startsWith('~/')?path.join(home,v.slice(2)):v;
 if(!path.isAbsolute(p))refuse(`${where} must be absolute or start with ~/`);
 return path.resolve(p);
};
/** site.json → plugins.<plugin>.agents.<agent>.<machine>: where the agent goes on that machine. Strict. */
export function readPlacement(site,{plugin,agent,machine}){
 const where=`site.json → plugins.${plugin}.agents.${agent}.${machine}`;
 const raw=site.plugins?.[plugin]?.agents?.[agent]?.[machine];
 if(raw===undefined)refuse(`${where} is missing: say where the agent goes on this machine ({"target", "label"}, optionally "node", "env", "logs")`);
 if(!plain(raw))refuse(`${where} must be an object`);
 const extra=Object.keys(raw).filter(k=>!['target','label','node','env','logs'].includes(k));if(extra.length)refuse(`${where} has unknown field(s): ${extra.join(', ')}`);
 if(typeof raw.label!=='string'||!LABEL.test(raw.label))refuse(`${where}.label must be a service label such as com.example.agent`);
 const env={};
 if(raw.env!==undefined){if(!plain(raw.env))refuse(`${where}.env must be an object of strings`);
  for(const [k,v] of Object.entries(raw.env)){if(!ENV_KEY.test(k))refuse(`${where}.env names "${k}", which is not an environment variable name`);
   if(RESERVED.includes(k))refuse(`${where}.env must not set ${k}: the installer sets it`);
   if(typeof v!=='string'||v.length>500||/[\u0000-\u001f]/.test(v))refuse(`${where}.env.${k} must be a short text`);env[k]=v;}}
 return {target:expand(raw.target,`${where}.target`),label:raw.label,node:raw.node===undefined?process.execPath:expand(raw.node,`${where}.node`),env,logs:raw.logs===undefined?null:expand(raw.logs,`${where}.logs`)};
}
/** The site machine this host is: --machine, else the one whose id or first host-name label is this host's short name. */
export function chooseMachine(site,explicit,hostname=os.hostname()){
 if(explicit){if(!site.machines.some(m=>m.id===explicit))refuse(`--machine ${explicit} is not a machine of the site`);return explicit;}
 const me=hostname.split('.')[0].toLowerCase();
 const hits=site.machines.filter(m=>m.id.toLowerCase()===me||m.hostname.split('.')[0].toLowerCase()===me);
 if(hits.length!==1)refuse(`Cannot tell which machine of the site this is (host name ${hostname}); pass --machine`);
 return hits[0].id;
}
const git=(dir,...args)=>{const r=spawnSync('git',['-C',dir,...args],{encoding:'utf8'});return r.status===0?r.stdout.trim():null;};
// The commit of a tree and whether any of the given files differ from it (null: not a git checkout).
function sourceState(dir,files){
 const commit=git(dir,'rev-parse','HEAD');if(!commit)return {commit:null,dirty:null};
 const top=git(dir,'rev-parse','--show-toplevel');
 const changed=files.length?git(top,'status','--porcelain','--',...files.map(f=>path.relative(top,f))):'';
 return {commit,dirty:changed===null?null:changed.split('\n').filter(Boolean)};
}
const xml=v=>String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const fill=(template,values)=>template.replace(/\{\{(\w+)\}\}/g,(_,k)=>values[k]??'');
const systemdQuote=v=>`"${String(v).replace(/\\/g,'\\\\').replace(/"/g,'\\"').replace(/%/g,'%%')}"`;
/** The service file for the agent: {kind, file, text, domain}. */
export function renderService({service,label,node,entry,target,env,stdout,stderr,title,plugin,agent,user=os.userInfo().username,home=os.homedir()}){
 if(service==='systemd-user'){
  const text=fill(readFileSync(path.join(TEMPLATES,'systemd.service'),'utf8'),{label,agent,plugin,title,node:systemdQuote(node),entry:systemdQuote(entry),target,stdout,stderr,
   environment:Object.entries(env).map(([k,v])=>`Environment=${systemdQuote(`${k}=${v}`)}`).join('\n')});
  return {kind:service,file:path.join(home,'.config','systemd','user',`${label}.service`),text};
 }
 const daemon=service==='launchd-daemon';
 const text=fill(readFileSync(path.join(TEMPLATES,'launchd.plist'),'utf8'),{label:xml(label),node:xml(node),entry:xml(entry),target:xml(target),stdout:xml(stdout),stderr:xml(stderr),
  environment:Object.entries(env).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`\t\t<key>${xml(k)}</key>\n\t\t<string>${xml(v)}</string>`).join('\n'),
  user:daemon?`\t<key>UserName</key>\n\t<string>${xml(user)}</string>\n`:''});
 return {kind:service,file:daemon?path.join('/Library/LaunchDaemons',`${label}.plist`):path.join(home,'Library','LaunchAgents',`${label}.plist`),text,domain:daemon?'system':`gui/${process.getuid?.()??0}`};
}
// Two property lists say the same thing (plutil reads both); without plutil, the same text.
function sameService(file,text){
 if(!existsSync(file))return false;
 const old=readFileSync(file,'utf8');if(old===text)return true;
 if(!file.endsWith('.plist'))return false;
 const json=input=>{const r=spawnSync('/usr/bin/plutil',['-convert','json','-o','-','-'],{input,encoding:'utf8'});return r.status===0?JSON.parse(r.stdout):null;};
 const a=json(old),b=json(text);return Boolean(a&&b)&&JSON.stringify(sortKeys(a))===JSON.stringify(sortKeys(b));
}
const sortKeys=v=>Array.isArray(v)?v.map(sortKeys):plain(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sortKeys(v[k])])):v;

/**
 * Everything the install would do, worked out without changing anything. → the plan that formatPlan prints and
 * applyPlan carries out. options: plugin, agent, machine, target, label, stateHome, backups, allowDirty, env, site;
 * serviceHome: whose Library/LaunchAgents or .config/systemd/user the service file goes to (tests: a temp directory).
 */
export async function planInstall({plugin,agent:agentId,machine:explicitMachine=null,target:targetOverride=null,label:labelOverride=null,stateHome=null,backups=null,
 allowDirty=false,env=process.env,site=loadSite(),directories=pluginsDirectories(env),root=coreRoot,hostname=os.hostname(),serviceHome=os.homedir()}){
 if(!plugin||!agentId)refuse('Say which agent: --plugin <id> --agent <id>');
 const directory=directories.find(d=>existsSync(path.join(d,plugin,'index.mjs')));
 if(!directory)refuse(`No plugin "${plugin}" in ${directories.join(', ')||'(no plugin directories)'}`);
 const source=pluginSource(directory,root),manifest=readPluginManifest(directory,plugin,{source});
 if(!manifest)refuse(`plugin "${plugin}" has no plugin.json, so it declares no host agent`);
 const agent=manifest.hostAgents.find(a=>a.id===agentId);
 if(!agent)refuse(`plugin "${plugin}" declares no host agent "${agentId}" (plugin.json → hostAgents: ${manifest.hostAgents.map(a=>a.id).join(', ')||'none'})`);
 const machine=chooseMachine(site,explicitMachine,hostname);
 const placement=readPlacement(site,{plugin,agent:agentId,machine});
 const target=targetOverride?expand(targetOverride,'--target'):placement.target,label=labelOverride??placement.label;
 if(!LABEL.test(label))refuse('--label must be a service label');
 const home=stateHome?expand(stateHome,'--state-home'):os.homedir();
 // Logs: <state home>/logs for a test install with its own state home, else the configured place, else <target>/logs.
 const logs=stateHome?path.join(home,'logs'):placement.logs??path.join(target,'logs');
 const sourceRoot=manifest.sourceDirectory,pluginDir=path.join(directory,plugin);
 const entry=path.join(pluginDir,agent.entry);
 const closure=agentClosure(entry,{sourceRoot,coreRoot:root});
 const entryInCopy=closure.find(f=>f.from===path.resolve(entry)).to;
 // Uncommitted agent files are refused: an installed copy must be a commit of each tree.
 const core=sourceState(root,closure.filter(f=>f.part==='core').map(f=>f.from)),plugins=sourceState(sourceRoot,closure.filter(f=>f.part==='plugin').map(f=>f.from));
 const dirty=[...(core.dirty||[]),...(plugins.dirty||[])];
 if(!allowDirty&&(core.commit===null||plugins.commit===null))refuse('The core checkout and the plugin source must be git checkouts, so the copy is a commit (or --allow-dirty for a test)');
 if(!allowDirty&&dirty.length)refuse(`These agent files have uncommitted changes; commit them first (or --allow-dirty for a test):\n${dirty.join('\n')}`);
 const files=closure.map(f=>{const body=readFileSync(f.from);return {...f,sha256:sha256(body),size:body.length};});
 // The agent's configuration: the plugin's config module turns the site into what the agent needs.
 let config=null;
 if(agent.config){
  const make=(await import(pathToFileURL(path.join(pluginDir,agent.config)).href)).default;
  if(typeof make!=='function')refuse(`plugin "${plugin}": ${agent.config} must default-export a function ({site, machine}) => object`);
  const body=await make({site,machine,plugin,agent:agentId});
  if(!plain(body))refuse(`plugin "${plugin}": ${agent.config} must return an object`);
  const doc={$comment:`Written by scripts/install-host-agent.mjs from ${siteConfigPath(env)?path.basename(siteConfigPath(env)):'the site'} → plugins for the agent "${agentId}" of the plugin "${plugin}" on ${machine}. Do not edit: install again.`,plugin,agent:agentId,machine,...body};
  const text=JSON.stringify(doc,null,1)+'\n';
  config={to:`config/${agentId}.json`,text,sha256:sha256(Buffer.from(text))};
 }
 const socket=agent.health?.socket?path.join(target,agent.health.socket):null;
 if(socket&&Buffer.byteLength(socket)>103)refuse(`The socket path ${socket} is longer than the 103 bytes macOS allows; choose a shorter --target`);
 const serviceEnv={PATH:`${path.dirname(placement.node)}:/usr/bin:/bin`,...placement.env,HOME:home,HOME_HUB_HOME:target,...(socket?{HOME_HUB_AGENT_SOCKET:socket}:{})};
 const service=renderService({service:agent.service,label,node:placement.node,entry:path.join(target,entryInCopy),target,env:serviceEnv,stdout:path.join(logs,`${label}.out.log`),stderr:path.join(logs,`${label}.err.log`),title:`${agent.title} (Home Hub plugin ${plugin})`,plugin,agent:agentId,home:serviceHome});
 // What is there now.
 const readJson=file=>{try{return JSON.parse(readFileSync(file,'utf8'));}catch{return null;}};
 const old=readJson(path.join(target,AGENT_MANIFEST)),legacyRecord=readJson(path.join(target,LEGACY_MANIFEST));
 const newPaths=new Set([...files.map(f=>f.to),...(config?[config.to]:[])]);
 const stale=(old?.files||[]).map(f=>f.path).filter(p=>typeof p==='string'&&!newPaths.has(p)).sort();
 const legacy=(legacyRecord?.files||[]).filter(p=>typeof p==='string'&&!newPaths.has(p)&&!stale.includes(p)).sort();
 const fileState=f=>{const at=path.join(target,f.to);return !existsSync(at)?'new':sha256(readFileSync(at))===f.sha256?'same':'changed';};
 const changed=files.filter(f=>fileState(f)!=='same').map(f=>({to:f.to,state:fileState(f)}));
 const configState=config?(!existsSync(path.join(target,config.to))?'new':sha256(readFileSync(path.join(target,config.to)))===config.sha256?'same':'changed'):null;
 const record={schema:1,plugin,agent:agentId,version:manifest.version,core:readPackage(root).version,machine,label,service:agent.service,entry:entryInCopy,
  commits:{core:core.commit,plugin:plugins.commit},dirty:dirty.length>0,files:files.map(f=>({path:f.to,sha256:f.sha256})),...(config?{config:{path:config.to,sha256:config.sha256}}:{}),
  from:{core:root,plugins:sourceRoot}};
 return {plugin,agentId,agent,manifest,machine,placement,target,label,home,logs,socket,health:agent.health,files,config,configState,service,serviceChanged:!sameService(service.file,service.text),
  old,legacyRecord,stale,legacy,changed,record,backups:backups?expand(backups,'--backups'):path.join(os.homedir(),'local-ai','backups')};
}

/** What the plan would do, as lines for a person. */
export function formatPlan(p,{noService=false}={}){
 const c=p.record.commits,lines=[];
 lines.push(`Host agent "${p.agentId}" of plugin ${p.plugin} ${p.record.version} (core ${p.record.core}; commits core ${(c.core||'?').slice(0,10)}, plugin ${(c.plugin||'?').slice(0,10)}${p.record.dirty?', dirty':''}) for ${p.machine} → ${p.target}`);
 lines.push(`  ${p.files.length} files, ${p.changed.length} new or changed${p.config?`; configuration ${p.config.to}: ${p.configState}`:''}${p.legacy.length?`; files of the older bridge copy to retire: ${p.legacy.length}`:''}${p.stale.length?`; no longer needed: ${p.stale.length}`:''}`);
 for(const f of p.changed)lines.push(`   ${f.state==='new'?'+':'~'} ${f.to}`);
 for(const f of [...p.legacy,...p.stale])lines.push(`   - ${f}`);
 if(p.legacyRecord)lines.push(`   - ${LEGACY_MANIFEST} (replaced by ${AGENT_MANIFEST})`);
 if(!noService){
  lines.push(`  ${p.service.kind} ${p.label}: ${p.serviceChanged?`new service file ${p.service.file}`:'service file unchanged'}; restarted if anything changed`);
  if(p.serviceChanged&&existsSync(p.service.file))for(const d of diffLines(readFileSync(p.service.file,'utf8'),p.service.text))lines.push(`     ${d}`);
  if(p.health)lines.push(`  health: GET ${p.health.get||'/'} on ${p.socket}`);
 }
 return lines;
}
// What changes in the service file, for the person who reviews it before the restart: key by key for a property list
// (plutil reads both), else line by line.
function diffLines(a,b){
 const json=input=>{if(!existsSync('/usr/bin/plutil'))return null;const r=spawnSync('/usr/bin/plutil',['-convert','json','-o','-','-'],{input,encoding:'utf8'});try{return r.status===0?JSON.parse(r.stdout):null;}catch{return null;}};
 const flat=(v,prefix='',out={})=>{if(plain(v))for(const [k,x] of Object.entries(v))flat(x,prefix?`${prefix}.${k}`:k,out);else if(Array.isArray(v))v.forEach((x,i)=>flat(x,`${prefix}[${i}]`,out));else out[prefix]=v;return out;};
 const x=json(a),y=json(b);
 if(x&&y){const fx=flat(x),fy=flat(y),out=[];
  for(const k of [...new Set([...Object.keys(fx),...Object.keys(fy)])].sort()){if(fx[k]===fy[k])continue;if(k in fx)out.push(`- ${k} = ${fx[k]}`);if(k in fy)out.push(`+ ${k} = ${fy[k]}`);}
  return out;}
 const xl=a.split('\n'),yl=b.split('\n'),out=[];const yset=new Set(yl),xset=new Set(xl);
 for(const l of xl)if(!yset.has(l)&&l.trim())out.push(`- ${l.trim()}`);
 for(const l of yl)if(!xset.has(l)&&l.trim())out.push(`+ ${l.trim()}`);
 return out;
}

// --- the service manager -------------------------------------------------------------------------------------------
const run=(cmd,args)=>spawnSync(cmd,args,{encoding:'utf8'});
export const systemServices={
 stop(service,label){
  if(service.kind==='systemd-user'){run('systemctl',['--user','stop',label]);return;}
  run('/bin/launchctl',['bootout',`${service.domain}/${label}`]);
  for(let i=0;i<20;i++){if(run('/bin/launchctl',['print',`${service.domain}/${label}`]).status!==0)break;spawnSync('/bin/sleep',['0.25']);}
 },
 start(service,label){
  if(service.kind==='systemd-user'){run('systemctl',['--user','daemon-reload']);const r=run('systemctl',['--user','enable','--now',label]);if(r.status!==0)throw new InstallError(`systemctl --user enable --now ${label} failed: ${r.stderr.trim()}`);run('systemctl',['--user','restart',label]);return;}
  const r=run('/bin/launchctl',['bootstrap',service.domain,service.file]);if(r.status!==0)throw new InstallError(`launchctl bootstrap failed: ${r.stderr.trim()}`);
 },
};
// GET a path on a Unix socket → the parsed JSON object, or null.
export function askSocket(socket,route='/',{timeoutMs=5000}={}){
 return new Promise(resolve=>{
  if(!socket||!existsSync(socket))return resolve(null);
  const req=http.request({socketPath:socket,path:route,method:'GET',timeout:timeoutMs},res=>{let body='';res.setEncoding('utf8');res.on('data',d=>{body+=d;if(body.length>4194304)req.destroy();});
   res.on('end',()=>{if(res.statusCode!==200)return resolve(null);try{const v=JSON.parse(body);resolve(plain(v)?v:null);}catch{resolve(null);}});});
  req.on('timeout',()=>req.destroy());req.on('error',()=>resolve(null));req.end();
 });
}
const serviceIds=answer=>Array.isArray(answer?.services)?answer.services.map(s=>s?.id).filter(id=>typeof id==='string').sort():[];
// The new agent is up when its health GET answers, lists every service the comparison did, and says it is this version.
async function waitHealthy(p,{before,seconds,ask=askSocket}){
 const deadline=Date.now()+seconds*1000;
 while(Date.now()<deadline){
  const answer=await ask(p.socket,p.health?.get||'/');
  if(answer&&before.every(id=>serviceIds(answer).includes(id))&&(!answer.agent||answer.agent.version===p.record.version&&answer.agent.plugin===p.plugin))return answer;
  await new Promise(r=>setTimeout(r,1000));
 }
 return null;
}
// After a rollback: the previous agent answers its health GET at all (it is the older version, whatever it says).
async function waitAnswering(p,{seconds,ask=askSocket}){
 const deadline=Date.now()+seconds*1000;
 while(Date.now()<deadline){if(await ask(p.socket,p.health?.get||'/'))return true;await new Promise(r=>setTimeout(r,1000));}
 return false;
}

// --- carrying it out ---------------------------------------------------------------------------------------------------
function archive(p){
 mkdirSync(p.backups,{recursive:true,mode:0o700});chmodSync(p.backups,0o700);
 const stamp=new Date().toISOString().replace(/[-:]/g,'').replace(/\..*/,'').replace('T','-');
 const file=path.join(p.backups,`home-hub-agent-${p.label}-${stamp}.tgz`);
 const args=['-czf',file,'--exclude','*.sock'];
 if(existsSync(p.target))args.push('-C',path.dirname(p.target),path.basename(p.target));
 if(existsSync(p.service.file))args.push('-C',path.dirname(p.service.file),path.basename(p.service.file));
 if(args.length===4)return null;
 const r=run('/usr/bin/tar',args);if(r.status!==0)throw new InstallError(`tar could not archive ${p.target}: ${r.stderr.trim()}`);
 chmodSync(file,0o600);return file;
}
// Put the archived tree and service file back: only regular files and directories under the target are written.
function restore(p,saved){
 for(const rel of [...p.files.map(f=>f.to),...(p.config?[p.config.to]:[]),AGENT_MANIFEST]){const at=path.join(p.target,rel);try{if(lstatSync(at).isFile())unlinkSync(at);}catch{}}
 if(!saved)return;
 const scratch=mkdtempSync(path.join(os.tmpdir(),'home-hub-agent-restore-'));
 try{
  const r=run('/usr/bin/tar',['-xzf',saved,'-C',scratch]);if(r.status!==0)throw new InstallError(`tar could not read ${saved}`);
  const copyTree=(from,to)=>{for(const e of readdirSync(from,{withFileTypes:true})){const a=path.join(from,e.name),b=path.join(to,e.name);
   if(e.isDirectory()){mkdirSync(b,{recursive:true});copyTree(a,b);}else if(e.isFile()){mkdirSync(path.dirname(b),{recursive:true});copyFileSync(a,b);chmodSync(b,statSync(a).mode&0o777);}}};
  const tree=path.join(scratch,path.basename(p.target));if(existsSync(tree))copyTree(tree,p.target);
  const service=path.join(scratch,path.basename(p.service.file));if(existsSync(service)){copyFileSync(service,p.service.file);chmodSync(p.service.file,0o644);}
 }finally{rmSync(scratch,{recursive:true,force:true});}
}
const removeEmptyParents=(target,rel)=>{let dir=path.dirname(path.join(target,rel));while(dir.startsWith(target+path.sep)){try{if(readdirSync(dir).length)break;rmdirSync(dir);}catch{break;}dir=path.dirname(dir);}};
function layOut(p){
 for(const rel of [...p.legacy,...p.stale]){const at=path.join(p.target,rel);try{if(lstatSync(at).isFile()){unlinkSync(at);removeEmptyParents(p.target,rel);}}catch{}}
 if(p.legacyRecord)try{unlinkSync(path.join(p.target,LEGACY_MANIFEST));}catch{}
 for(const f of p.files){const at=path.join(p.target,f.to);mkdirSync(path.dirname(at),{recursive:true});copyFileSync(f.from,at);chmodSync(at,0o644);}
 mkdirSync(path.join(p.target,'private'),{recursive:true,mode:0o700});chmodSync(path.join(p.target,'private'),0o700);
 if(p.config){const at=path.join(p.target,p.config.to);mkdirSync(path.dirname(at),{recursive:true,mode:0o700});chmodSync(path.dirname(at),0o700);writeFileSync(at,p.config.text,{mode:0o600});chmodSync(at,0o600);}
 writeFileSync(path.join(p.target,AGENT_MANIFEST),JSON.stringify({...p.record,installedAt:new Date().toISOString()},null,1)+'\n',{mode:0o644});
}

/** Carries the plan out. → {status: 'done'|'nothing'|'laid-out'|'rolled-back', archive?, answer?}. services/ask: fakes in tests. */
export async function applyPlan(p,{noService=false,wait=30,expectLike=null,services=systemServices,ask=askSocket,log=console.log,warn=console.error}={}){
 if(noService){mkdirSync(p.target,{recursive:true});layOut(p);log('Files laid out; the service manager was not touched.');return {status:'laid-out'};}
 if(p.service.kind==='launchd-daemon'&&process.getuid?.()!==0)refuse('A launchd daemon is installed as root (sudo); nothing was changed');
 const answering=await ask(p.socket,p.health?.get||'/');
 if(!p.changed.length&&p.configState!=='new'&&p.configState!=='changed'&&!p.legacy.length&&!p.stale.length&&!p.legacyRecord&&!p.serviceChanged&&answering){log('Already installed and answering; nothing to do.');return {status:'nothing'};}
 const before=serviceIds(expectLike?await ask(expectLike,p.health?.get||'/'):answering);
 const saved=archive(p);if(saved)log(`  archived the current agent to ${saved}`);
 services.stop(p.service,p.label);
 mkdirSync(p.target,{recursive:true});layOut(p);
 mkdirSync(p.logs,{recursive:true});mkdirSync(path.dirname(p.service.file),{recursive:true});
 writeFileSync(p.service.file,p.service.text,{mode:0o644});chmodSync(p.service.file,0o644);
 let answer=null;
 try{services.start(p.service,p.label);answer=p.health?await waitHealthy(p,{before,seconds:wait,ask}):{};}catch(e){warn(e.message);}
 if(answer){log(`Installed: ${p.label} answers${serviceIds(answer).length?` with ${serviceIds(answer).join(', ')}`:''}${answer.agent?` as ${answer.agent.plugin} ${answer.agent.version}`:''}.`);return {status:'done',archive:saved,answer};}
 warn(`The new agent did not answer${before.length?` with ${before.join(', ')}`:''} within ${wait} s; restoring ${saved||'(nothing archived)'}.`);
 const tail=existsSync(path.join(p.logs,`${p.label}.err.log`))?readFileSync(path.join(p.logs,`${p.label}.err.log`),'utf8').trim().split('\n').slice(-5).join('\n'):'';if(tail)warn(tail);
 services.stop(p.service,p.label);
 restore(p,saved);
 if(!saved||!existsSync(p.service.file)||readFileSync(p.service.file,'utf8')===p.service.text){try{unlinkSync(p.service.file);}catch{}warn('Rolled back the files; there was no previous agent to start.');return {status:'rolled-back',archive:saved};}
 try{services.start(p.service,p.label);const back=p.health?await waitAnswering(p,{seconds:wait,ask}):true;
  warn(back?'Rolled back: the previous agent answers again.':'Rolled back the files, but the previous agent does not answer either; check the service manager and the logs.');}
 catch(e){warn('Rollback could not restart the previous agent: '+e.message);}
 return {status:'rolled-back',archive:saved};
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),flag=name=>args.includes(name),value=name=>{const i=args.indexOf(name);return i>=0?args[i+1]:null;};
 const known=['--plugin','--agent','--machine','--target','--label','--state-home','--backups','--wait','--expect-like'],flags=['--dry-run','--no-service','--allow-dirty','--help'];
 const unknown=args.filter((a,i)=>a.startsWith('--')&&!known.includes(a)&&!flags.includes(a)||!a.startsWith('--')&&!known.includes(args[i-1]));
 if(flag('--help')||unknown.length){console.log(`${unknown.length?`Unknown: ${unknown.join(' ')}\n\n`:''}${readFileSync(fileURLToPath(import.meta.url),'utf8').split('\n').slice(1,23).map(l=>l.replace(/^\/\/ ?/,'')).join('\n')}`);process.exit(unknown.length?2:0);}
 try{
  const plan=await planInstall({plugin:value('--plugin'),agent:value('--agent'),machine:value('--machine'),target:value('--target'),label:value('--label'),stateHome:value('--state-home'),backups:value('--backups'),allowDirty:flag('--allow-dirty')});
  for(const line of formatPlan(plan,{noService:flag('--no-service')}))console.log(line);
  if(flag('--dry-run')){console.log('Dry run: nothing changed.');process.exit(0);}
  const result=await applyPlan(plan,{noService:flag('--no-service'),wait:Number(value('--wait')||30),expectLike:value('--expect-like')?expand(value('--expect-like'),'--expect-like'):null});
  process.exit(result.status==='rolled-back'?1:0);
 }catch(e){console.error(e instanceof InstallError?e.message:e.stack||e.message);process.exit(1);}
}
