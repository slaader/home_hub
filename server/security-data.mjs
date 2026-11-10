// Security section: SSH key inventory. The collector (scripts/collect-security.mjs) runs
// scripts/security/ssh-probe.sh on every machine, then buildSecurity() joins the records:
// each private key (by SHA256 fingerprint) → where its copies live, who owns them, and what
// it opens (authorized_keys entries, Forgejo account and deploy keys, ssh config routes).
// No private key material ever reaches this module: the probe sends fingerprints, paths and
// public authorized_keys lines only.
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {site as loadedSite} from './site-config.mjs';

export const SECURITY_SCHEMA=1;
const KEY_TYPE=/^(ssh-(ed25519|rsa|dss)|ecdsa-sha2-nistp(256|384|521)|sk-(ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com)(-cert-v01@openssh\.com)?$/;
const clean=(v,n=400)=>typeof v==='string'?v.replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,n):'';

export function fingerprintOf(b64){
 const blob=Buffer.from(b64,'base64');
 if(!blob.length)return null;
 return 'SHA256:'+createHash('sha256').update(blob).digest('base64').replace(/=+$/,'');
}

// Split on a separator outside double quotes (authorized_keys options and tokens).
function splitOutside(text,sep){
 const out=[];let cur='',quoted=false;
 for(let i=0;i<text.length;i++){const c=text[i];
  if(c==='\\'&&quoted&&i+1<text.length){cur+=c+text[++i];continue;}
  if(c==='"')quoted=!quoted;
  if(!quoted&&(sep===' '?/\s/.test(c):c===sep)){if(cur)out.push(cur);cur='';continue;}
  cur+=c;}
 if(cur)out.push(cur);return out;
}

export function parseAuthorizedLine(line){
 const tokens=splitOutside(clean(line,8000),' ');
 const at=tokens.findIndex(t=>KEY_TYPE.test(t));
 if(at<0||!tokens[at+1])return null;
 const type=tokens[at],b64=tokens[at+1],comment=tokens.slice(at+2).join(' ');
 const fingerprint=fingerprintOf(b64);if(!fingerprint)return null;
 const options={from:[],command:null,restrict:false,permitOpen:[],flags:[]};
 for(const opt of tokens.slice(0,at).flatMap(t=>splitOutside(t,','))){
  const m=/^([A-Za-z0-9-]+)(?:="(.*)")?$/s.exec(opt);if(!m)continue;
  const name=m[1].toLowerCase(),value=m[2]?.replace(/\\"/g,'"')??null;
  if(name==='from'&&value)options.from.push(...value.split(',').map(s=>s.trim()).filter(Boolean));
  else if(name==='command')options.command=value;
  else if(name==='restrict')options.restrict=true;
  else if(name==='permitopen'&&value)options.permitOpen.push(value);
  else options.flags.push(value==null?name:`${name}=${value}`);
 }
 return {type,fingerprint,comment:clean(comment,200),options};
}

// "256 SHA256:abc comment words (ED25519)" from ssh-keygen -l.
export function parseKeygenLine(line){
 const m=/^(\d+)\s+(SHA256:[A-Za-z0-9+/]+)\s*(.*?)\s*\(([A-Z0-9-]+)\)\s*$/.exec(clean(line,600));
 if(!m)return null;
 const comment=m[3]==='no comment'?'':m[3];
 return {bits:Number(m[1]),fingerprint:m[2],comment,type:m[4]};
}

// sudo -l rule lines → one verdict. "(ALL) ALL, NOPASSWD: ALL" means password-less root.
export function sudoVerdict(account,now=Date.now()){
 if(account.user==='root'||account.uid===0)return {level:'root',commands:[],expired:[]};
 if(account.sudoState==='none')return {level:'none',commands:[],expired:[]};
 if(account.sudoState==='unknown')return {level:'unknown',commands:[],expired:[],detail:account.sudoDetail||''};
 let nopassAll=false,passAll=false;const commands=[],expired=[];
 for(const raw of account.sudoRules||[]){
  let rule=raw.replace(/^\([^)]*\)\s*/,'');
  const until=/NOTAFTER=(\d{14})Z\s*/.exec(rule);
  if(until){const t=Date.parse(until[1].replace(/(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)/,'$1-$2-$3T$4:$5:$6Z'));if(Number.isFinite(t)&&t<now){expired.push(raw);continue;}rule=rule.replace(until[0],'');}
  rule=rule.replace(/\b(NOTBEFORE|TIMEOUT)=\S+\s*/g,'');
  let nopass=false;
  for(let part of rule.split(',').map(s=>s.trim()).filter(Boolean)){
   for(;;){const tag=/^(NOPASSWD|PASSWD|SETENV|NOSETENV|NOEXEC|EXEC|LOG_INPUT|NOLOG_INPUT|LOG_OUTPUT|NOLOG_OUTPUT|MAIL|NOMAIL|FOLLOW|NOFOLLOW|INTERCEPT|NOINTERCEPT):\s*/.exec(part);if(!tag)break;
    if(tag[1]==='NOPASSWD')nopass=true;else if(tag[1]==='PASSWD')nopass=false;part=part.slice(tag[0].length);}
   if(part==='ALL'){if(nopass)nopassAll=true;else passAll=true;}
   else if(nopass)commands.push(part);
  }
 }
 const level=nopassAll?'nopasswd':passAll?'password':commands.length?'limited':'none';
 return {level,commands:[...new Set(commands)].slice(0,12),expired};
}

export function parseProbe(text){
 const host={name:'',os:'',user:'',root:false,at:null,ips:[],listening:null,accessGroup:null,sshd:{},accounts:[],auth:[],routes:[],keys:[],complete:false};
 const accounts=new Map();
 const account=u=>{if(!accounts.has(u))accounts.set(u,{user:u,uid:null,home:'',shell:'',hasSsh:false,sudoState:'rules',sudoRules:[],sudoDetail:''});return accounts.get(u);};
 for(const line of String(text).split('\n')){
  const f=line.split('\t');const tag=f[0];
  if(tag==='HOST'){host.name=clean(f[1],80);host.os=clean(f[2],20);host.user=clean(f[3],64);host.root=f[4]==='1';host.at=clean(f[5],40)||null;}
  else if(tag==='NET')host.ips=f.slice(1).map(s=>clean(s,40)).filter(s=>/^\d+\.\d+\.\d+\.\d+$/.test(s));
  else if(tag==='LISTEN')host.listening=f[1]==='on';
  else if(tag==='ACCESSGROUP')host.accessGroup=f.slice(1).map(s=>clean(s,64)).filter(Boolean);
  else if(tag==='SSHD'){const k=clean(f[1],40).toLowerCase(),v=clean(f[2],400);(host.sshd[k]??=[]).push(v);}
  else if(tag==='USER'){const a=account(clean(f[1],64));a.uid=Number(f[2]);a.home=clean(f[3],300);a.shell=clean(f[4],120);a.hasSsh=f[5]==='1';}
  else if(tag==='SUDO'){const a=account(clean(f[1],64));if(f[2]==='rule')a.sudoRules.push(clean(f[3],600));else{a.sudoState=f[2]==='none'?'none':'unknown';a.sudoDetail=clean(f[3],200);}}
  else if(tag==='AUTH'){const parsed=parseAuthorizedLine(f.slice(3).join('\t'));if(parsed)host.auth.push({user:clean(f[1],64),file:clean(f[2],300),...parsed});}
  else if(tag==='CFG')host.routes.push({user:clean(f[1],64),alias:clean(f[2],120),hostname:clean(f[3],200),port:Number(f[4])||22,remoteUser:clean(f[5],64),
   identityFiles:clean(f[6],2000).split('|').filter(Boolean),proxyJump:clean(f[7],200)||null,identitiesOnly:f[8]==='yes'});
  else if(tag==='KEY'){const kg=parseKeygenLine(f[7]||'');
   host.keys.push({path:clean(f[1],400),mode:clean(f[2],6),owner:clean(f[3],64),mtime:Number(f[4])?new Date(Number(f[4])*1000).toISOString():null,
    format:clean(f[5],40)||'PKCS8',encrypted:f[6]==='yes'?true:f[6]==='no'?false:null,...(kg||{fingerprint:null,bits:null,comment:'',type:null})});}
  else if(tag==='END')host.complete=true;
 }
 host.accounts=[...accounts.values()];
 return host;
}

// What a private key file is for, from where it lives. Anything else with a fingerprint is a
// client SSH key. Server host keys and TLS/JWT keys go to the "other keys" list.
// certificates: [{match, label}] from site.json → security.certificates, for TLS keys the site wants named.
export function classifyKey(file,hasFingerprint,certificates=loadedSite().security.certificates){
 const p=file.toLowerCase();
 if(/\/(forgejo|gitea)\/data\/ssh\//.test(p)||/ssh_host_[a-z0-9]+_key$/.test(p))return {kind:'ssh-host',label:/forgejo/.test(p)?'Forgejo SSH server – klíč hostitele':/gitea/.test(p)?'Gitea SSH server (starý) – klíč hostitele':'SSH server – klíč hostitele'};
 if(/\/(jwt|actions_id_token)\//.test(p))return {kind:'signing',label:/forgejo/.test(p)?'Forgejo – podpis tokenů':/gitea/.test(p)?'Gitea (starý) – podpis tokenů':'podpis tokenů'};
 if(/\/\.t3\/userdata\/secrets\//.test(p))return {kind:'app',label:'T3 Code – identita pro cloud link'};
 if(/(\/certs?\/|\/certificates\/|privkey\.pem$|server\.key$|\.key$)/.test(p)&&!/\/\.ssh\//.test(p))return {kind:'tls',label:/truenas/.test(p)?'TrueNAS – HTTPS certifikát':/home-hub/.test(p)?'Home Hub – HTTPS certifikát':certificates.find(c=>new RegExp(c.match).test(p))?.label||'TLS certifikát'};
 if(hasFingerprint)return {kind:'ssh',label:'SSH klíč'};
 return {kind:'other',label:'privátní klíč'};
}
const isBackupPath=p=>/(\/backups?[-_/]|\.bak|retired|\.old$)/i.test(p);
// ssh-keygen prints non-ASCII comment bytes as \ooo escapes; decode them, and drop comments that
// are still mojibake (a hostname typed with a broken encoding) so the UI shows the file name.
export function readableComment(comment){
 const raw=String(comment||'');
 const bytes=[];for(let i=0;i<raw.length;i++){const m=/^\\([0-7]{3})/.exec(raw.slice(i));if(m){bytes.push(parseInt(m[1],8));i+=3;}else bytes.push(...Buffer.from(raw[i]));}
 const text=Buffer.from(bytes).toString('utf8');
 return /�|ï¿½|[\u0080-\u009f]/.test(text)?'':clean(text,200);
}

const privateIp=ip=>/^(192\.168|10)\./.test(ip);
function machineIndex(descriptors,probes){
 const byName=new Map(),machines=new Map();
 for(const d of Array.isArray(descriptors)?descriptors:Object.values(descriptors||{})){
  if(!d?.id)continue;
  const ips=(d.addresses||[]).map(a=>a?.ip).filter(ip=>typeof ip==='string'&&/^\d+\.\d+\.\d+\.\d+$/.test(ip));
  machines.set(d.id,{id:d.id,name:d.name||d.id,hostname:d.hostname||'',ips});
 }
 for(const [id,p] of Object.entries(probes)){
  const m=machines.get(id)||{id,name:id,hostname:'',ips:[]};
  if(!m.ips.length&&p.host)m.ips=p.host.ips.filter(privateIp);
  machines.set(id,m);
 }
 for(const m of machines.values()){
  for(const n of [m.id,m.hostname,m.hostname.split('.')[0],...m.ips,probes[m.id]?.host?.name].filter(Boolean))byName.set(String(n).toLowerCase(),m.id);
 }
 // ssh config often spells an id with a hyphen (mini-server for mini_server).
 for(const id of [...machines.keys()])if(id.includes('_')&&!byName.has(id.replaceAll('_','-')))byName.set(id.replaceAll('_','-'),id);
 return {machines,byName};
}

// Resolve an ssh config route to what it reaches.
// forgejoMachine = the machine whose disk holds the Forgejo SSH host key; git remotes there are
// ssh://git@<it>:2222, so a Host block for that machine also picks the key git uses.
function resolveRoute(route,fromMachine,index,forgejoHost,forgejoMachine){
 const host=route.hostname.toLowerCase(),machine=index.byName.get(host);
 if(host===forgejoHost||machine&&machine===forgejoMachine&&(route.port===2222||route.remoteUser==='git'||machine===fromMachine))
  return {kind:'forgejo',label:'Forgejo (git)'};
 if(host==='github.com'||host==='ssh.github.com')return {kind:'external',label:'GitHub'};
 if(host==='gitlab.com')return {kind:'external',label:'GitLab'};
 if(['127.0.0.1','localhost','::1'].includes(host))return route.port===22?{kind:'host',machine:fromMachine}:{kind:'local',label:`${route.alias} – lokální VM na ${fromMachine} (port ${route.port})`};
 return machine?{kind:'host',machine}:{kind:'external',label:route.hostname};
}

const expandHome=(file,home)=>file.startsWith('~/')?path.posix.join(home,file.slice(2)):file;

/**
 * probes: {machineId: {text}|{error}}; forgejo: {url, host, users:[{login,isAdmin,keys:[{title,key|fingerprint}]}], deployKeys:[{repo,title,key|fingerprint,readOnly}]}|null
 * router: {id, sshOpen:boolean}|null; descriptors: data/machines/*.json
 */
export function buildSecurity({probes:rawProbes={},forgejo=null,extraMachines=[],descriptors=[],collectedFrom='',now=Date.now(),site=loadedSite()}){
 const probes={};
 for(const [id,p] of Object.entries(rawProbes))probes[id]=p?.text!=null?{host:parseProbe(p.text)}:{error:clean(p?.error||'nedostupné',300)};
 const index=machineIndex(descriptors,probes);
 const forgejoHost=(forgejo?.host||site.security.gitHost||'').toLowerCase();
 const machines=[],keys=new Map(),otherKeys=[],unknownAuthorized=[],findings=[];
 // The label comes from the primary copy (not a backup); unreadable comments fall back to the file name.
 const keyFor=(fp,meta,copy)=>{
  if(!keys.has(fp))keys.set(fp,{id:fp,fingerprint:fp,type:meta.type||null,bits:meta.bits||null,name:'',comment:'',copies:[],access:[],routes:[]});
  const k=keys.get(fp),primary=!copy.backup;
  if(!k.name||primary&&k.copies.every(c=>c.backup)){k.name=path.posix.basename(copy.path);const c=readableComment(meta.comment);if(c||primary)k.comment=c;}
  return k;};

 // 1. machines, accounts and the private key files on them
 for(const [id,p] of Object.entries(probes)){
  const m=index.machines.get(id);
  if(p.error){machines.push({id,name:m.name,ips:m.ips,hostname:m.hostname,reachable:false,error:p.error,accounts:[],ssh:null});continue;}
  const h=p.host,sshd=h.sshd;
  const one=k=>sshd[k]?.[0]??null;
  const accounts=h.accounts.map(a=>({user:a.user,uid:a.uid,home:a.home,shell:a.shell,sudo:sudoVerdict(a,now),authorizedKeys:[]}));
  machines.push({id,name:m.name,ips:m.ips,hostname:m.hostname,reachable:true,os:h.os,probedAs:h.user,complete:h.complete,collectedAt:h.at,
   ssh:{listening:h.listening,passwordAuth:one('passwordauthentication')==null?null:one('passwordauthentication')==='yes',kbdInteractive:one('kbdinteractiveauthentication')==='yes',
    rootLogin:one('permitrootlogin'),allowUsers:[...new Set(sshd.allowusers||[])],accessGroup:h.accessGroup},accounts});
  for(const k of h.keys){
   const cls=classifyKey(k.path,Boolean(k.fingerprint));
   const copy={machine:id,owner:k.owner,path:k.path,mode:k.mode,mtime:k.mtime,encrypted:k.encrypted,backup:isBackupPath(k.path)};
   if(cls.kind==='ssh'){keyFor(k.fingerprint,k,copy).copies.push(copy);}
   else otherKeys.push({...copy,kind:cls.kind,label:cls.label,fingerprint:k.fingerprint,type:k.type,bits:k.bits});
  }
 }
 const machineById=new Map(machines.map(m=>[m.id,m]));
 const forgejoMachine=otherKeys.find(o=>o.kind==='ssh-host'&&/\/forgejo\//.test(o.path))?.machine||null;
 const accountOf=(machine,user)=>machineById.get(machine)?.accounts.find(a=>a.user===user)||null;

 // 2. authorized_keys: what each fingerprint opens
 for(const [id,p] of Object.entries(probes)){
  if(p.error)continue;
  for(const e of p.host.auth){
   const acct=accountOf(id,e.user);
   // Only a forced command="..." constrains what the key can run. `restrict` disables forwarding,
   // agent/X11 and the PTY but still runs any command (a shell via `ssh host sh`), so it must not
   // silence root/sudo or unrestricted-address warnings; it is reported separately as noForwarding.
   const restricted=Boolean(e.options.command),noForwarding=Boolean(e.options.restrict);
   const entry={fingerprint:e.fingerprint,type:e.type,comment:readableComment(e.comment),from:e.options.from,command:e.options.command,restricted,noForwarding,permitOpen:e.options.permitOpen,flags:e.options.flags,file:e.file,known:keys.has(e.fingerprint)};
   acct?.authorizedKeys.push(entry);
   const target={kind:'host',machine:id,user:e.user,ips:machineById.get(id)?.ips||[]};
   if(keys.has(e.fingerprint))keys.get(e.fingerprint).access.push({target,entryComment:entry.comment,from:e.options.from,command:e.options.command,restricted,noForwarding,permitOpen:e.options.permitOpen,sudo:acct?.sudo?.level||'unknown',via:'authorized_keys'});
   else unknownAuthorized.push({machine:id,user:e.user,...entry});
  }
 }

 // 3. Forgejo: account keys (full account) and deploy keys (one repository)
 const forgejoUnknown=[];
 if(forgejo){
  for(const u of forgejo.users||[])for(const k of u.keys||[]){
   const fp=k.fingerprint||(k.key?parseAuthorizedLine(k.key)?.fingerprint:null);if(!fp)continue;
   const target={kind:'forgejo',account:u.login,admin:Boolean(u.isAdmin),title:clean(k.title,120)};
   if(keys.has(fp))keys.get(fp).access.push({target,from:[],command:null,restricted:false,sudo:u.isAdmin?'forgejo-admin':'forgejo-user',via:'forgejo'});
   else forgejoUnknown.push({...target,fingerprint:fp});
  }
  for(const k of forgejo.deployKeys||[]){
   const fp=k.fingerprint||(k.key?parseAuthorizedLine(k.key)?.fingerprint:null);if(!fp)continue;
   const target={kind:'forgejo-deploy',repo:clean(k.repo,200),readOnly:Boolean(k.readOnly),title:clean(k.title,120)};
   if(keys.has(fp))keys.get(fp).access.push({target,from:[],command:null,restricted:true,sudo:k.readOnly?'repo-read':'repo-write',via:'forgejo'});
   else forgejoUnknown.push({...target,fingerprint:fp});
  }
 }

 // 4. client routes (~/.ssh/config): which key each alias uses, and whether the target accepts it
 for(const [id,p] of Object.entries(probes)){
  if(p.error)continue;
  const homeOf=user=>p.host.accounts.find(a=>a.user===user)?.home||'';
  for(const r of p.host.routes){
   const files=new Set(r.identityFiles.map(f=>expandHome(f,homeOf(r.user))));
   const target=resolveRoute(r,id,index,forgejoHost,forgejoMachine);
   for(const k of keys.values())for(const c of k.copies){
    if(c.machine!==id||!files.has(c.path))continue;
    let accepted=null;
    const git=k.access.some(a=>a.target.kind==='forgejo'||a.target.kind==='forgejo-deploy');
    if(target.kind==='host')accepted=k.access.some(a=>a.target.kind==='host'&&a.target.machine===target.machine&&a.target.user===r.remoteUser);
    else if(target.kind==='forgejo')accepted=git;
    // A Host block for the Forgejo machine serves both ssh and git; either one counts.
    const alsoGit=target.kind==='host'&&target.machine===forgejoMachine&&git;
    if(alsoGit&&!accepted)accepted=true;
    k.routes.push({machine:id,user:r.user,alias:r.alias,hostname:r.hostname,port:r.port,remoteUser:target.kind==='external'?'':r.remoteUser,proxyJump:r.proxyJump,target,accepted,alsoGit,keyPath:c.path});
   }
  }
 }
 // External routes (GitHub, VMs) are the only evidence of what those keys open.
 for(const k of keys.values())for(const r of k.routes)if(['external','local'].includes(r.target.kind)&&!k.access.some(a=>a.target.label===r.target.label))
  k.access.push({target:{kind:r.target.kind,label:r.target.label,user:r.remoteUser||null},from:[],command:null,restricted:false,sudo:'unknown',via:'ssh-config',unverified:true});

 // 5. findings
 const mName=id=>machineById.get(id)?.name||id;
 const rootKeys=[];
 const order=site.security.order.length?site.security.order:site.machines.map(m=>m.id),rank=id=>order.indexOf(id)+1||99;
 const home=k=>(k.copies.find(c=>!c.backup)||k.copies[0])?.machine||'';
 const sorted=[...keys.values()].sort((a,b)=>rank(home(a))-rank(home(b))||a.name.localeCompare(b.name));
 for(const k of sorted){
  const label=k.comment&&k.comment!==k.name?`${k.name} (${k.comment})`:k.name||k.fingerprint.slice(0,20);
  const where=[...new Set(k.copies.map(c=>mName(c.machine)))].join(', ');
  const rootOn=[...new Set(k.access.filter(a=>a.target.kind==='host'&&['nopasswd','root'].includes(a.sudo)&&!a.restricted).map(a=>`${mName(a.target.machine)} (${a.target.user})`))];
  if(rootOn.length&&k.copies.some(c=>c.encrypted===false))rootKeys.push(`${label} (${where}) → ${rootOn.join(', ')}`);
  if(!k.access.length)findings.push({level:'info',key:k.id,title:`${label}: nikam nevede`,detail:`Neplatí v žádném authorized_keys ani ve Forgejo. Leží na ${where}. Kandidát na smazání.`});
  const copies=k.copies.length;
  if(copies>1)findings.push({level:'info',key:k.id,title:`${label}: ${copies} kopie`,detail:k.copies.map(c=>`${mName(c.machine)}:${c.path}`).join(' · ')});
  for(const c of k.copies)if(/^[0-7]{3,4}$/.test(c.mode)&&/[1-7]/.test(c.mode.slice(-2)))
   findings.push({level:'high',key:k.id,title:`${label}: soubor čitelný i pro ostatní (${c.mode})`,detail:`${mName(c.machine)}:${c.path}`});
  for(const r of k.routes)if(r.accepted===false)findings.push({level:'info',key:k.id,title:`${label}: alias „${r.alias}“ na ${mName(r.machine)} míří na ${r.target.kind==='host'?`${mName(r.target.machine)} (${r.remoteUser})`:r.target.label}, ale cíl klíč nepřijímá`,detail:'Zastaralý záznam v ~/.ssh/config nebo chybějící authorized_keys.'});
 }
 if(rootKeys.length)findings.push({level:'warn',title:`${rootKeys.length} klíčů bez passphrase otevírá účet se sudo bez hesla, tedy root`,
  detail:`Kdo získá soubor klíče, je root na cílovém stroji. Jde o záměr pro agenty, ochranu dělají jen from= a AllowUsers. ${rootKeys.join(' · ')}`});
 for(const u of unknownAuthorized)findings.push({level:['nopasswd','root'].includes(accountOf(u.machine,u.user)?.sudo.level)?'warn':'info',title:`Na ${mName(u.machine)} (${u.user}) je povolený cizí klíč „${(u.comment||u.fingerprint).slice(0,48)}“`,detail:`Jeho privátní část není na žádném z prověřených strojů (jiné zařízení nebo zapomenutý klíč).${u.from.length?` Jen z ${u.from.join(', ')}.`:' Bez omezení adresy.'}${u.restricted?' Omezený příkaz.':''}`});
 for(const u of forgejoUnknown)findings.push({level:'warn',title:`Forgejo: cizí klíč „${u.title}“ (${u.kind==='forgejo'?`účet ${u.account}`:`repozitář ${u.repo}`})`,detail:'Privátní část není na žádném z prověřených strojů.'});
 for(const m of machines){
  if(!m.reachable||!m.ssh)continue;
  if(m.ssh.passwordAuth)findings.push({level:'warn',title:`${m.name}: SSH přijímá i heslo`,detail:m.ssh.allowUsers.length?`Omezeno přes AllowUsers na ${m.ssh.allowUsers.join(', ')}.`:'Bez omezení adres (AllowUsers).'});
  for(const a of m.accounts){
   if(a.sudo.expired?.length)findings.push({level:'info',title:`${m.name}: prošlé pravidlo sudo pro ${a.user}`,detail:a.sudo.expired.join(' · ')});
   for(const e of a.authorizedKeys)if(!e.from.length&&!e.restricted&&['nopasswd','root'].includes(a.sudo.level)&&!m.ssh.allowUsers.some(x=>x.startsWith(`${a.user}@`)))
    findings.push({level:'warn',title:`${m.name} (${a.user}): klíč „${e.comment||e.fingerprint.slice(0,20)}“ bez omezení adresy`,detail:'Účet má sudo bez hesla a ani from= ani AllowUsers neomezují, odkud se klíč smí použít.'});
  }
  const present=new Set(m.accounts.map(a=>a.user));
  const stale=(m.ssh.accessGroup||[]).filter(u=>!u.startsWith('%')&&u!=='*'&&!present.has(u));
  if(stale.length)findings.push({level:'info',title:`${m.name}: Remote Login povoluje neexistující účty`,detail:`com.apple.access_ssh obsahuje ${stale.join(', ')}, kteří na stroji nejsou.`});
 }
 for(const o of otherKeys)if(o.backup)findings.push({level:'info',title:`${mName(o.machine)}: záloha klíče ${o.label}`,detail:o.path});
 const level={high:0,warn:1,info:2};findings.sort((a,b)=>level[a.level]-level[b.level]);

 for(const x of extraMachines)machines.push({id:x.id,name:index.machines.get(x.id)?.name||x.name||x.id,ips:index.machines.get(x.id)?.ips||x.ips||[],hostname:index.machines.get(x.id)?.hostname||'',reachable:false,sshOpen:x.sshOpen,note:clean(x.note,200),accounts:[],ssh:null});
 machines.sort((a,b)=>rank(a.id)-rank(b.id));
 return {schemaVersion:SECURITY_SCHEMA,collectedAt:new Date(now).toISOString(),collectedFrom,
  machines,keys:sorted,otherKeys,unknownAuthorized,forgejo:forgejo?{url:forgejo.url||`https://${forgejoHost}`,users:(forgejo.users||[]).map(u=>({login:u.login,isAdmin:Boolean(u.isAdmin),keys:(u.keys||[]).length})),deployKeys:(forgejo.deployKeys||[]).length,unknown:forgejoUnknown}:null,
  findings};
}

export async function loadSecurity(directory,file=process.env.SECURITY_FILE||path.join(directory,'security','ssh-keys.json')){
 let doc;
 try{doc=JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw new Error('invalid');}
 if(doc?.schemaVersion!==SECURITY_SCHEMA||!Array.isArray(doc.machines)||!Array.isArray(doc.keys))throw new Error('invalid');
 return doc;
}
