// App-managed SSH for Windows telemetry: the hub's own key store, host-key discovery and the set-up drafts of
// the web UI. server/windows-telemetry.mjs runs the collector; this file owns the files it runs with.
//
// The key store (state/home/ssh/, private to the account the hub runs as):
//   keys/<keyId>          one private key per connection (server/ssh-keys.mjs writes the format), 0600
//   known_hosts/<connId>  one line, "hh-<id> <type> <key>": the host key a person verified for that connection
//   empty                 an empty file: ssh's whole configuration (-F) and its global known_hosts
// POSIX: directories 0700, files 0600, owned by the hub's own uid, checked after every write (a group- or
// world-readable result is an error, never silently accepted). Windows: mode bits mean nothing there, so each
// directory and file gets an explicit ACL (PowerShell FileSecurity, no inheritance): full control for the hub's own account (its
// SID, from whoami) and SYSTEM, nobody else; Windows' OpenSSH client checks the same on the key.
// A private key never leaves the store: not in an API reply, devices.json, windows-hosts.json, a log line, an
// error, MCP or an export. Backups of the state directory do contain it (docs/API.md says so).
//
// Set-up drafts: the Add/Edit device dialog builds one connection step by step on the server, so nothing the
// browser holds can stand in for a check it did not pass. A draft belongs to the signed-in person who made it,
// lives in memory for at most 30 minutes of inactivity, and is bound to one device (or to "a new device"):
//   key       generated here or imported; the draft's own key file until the draft is saved or discarded
//   scan      the host keys the host and port present (ssh-keyscan: it sends no credentials, it only asks)
//   trust     the one key the person compared with what Windows shows and confirmed; written to known_hosts/<connId>
//   test      one run of the collector with exactly this host, port, user, key and trusted host key
// Changing host or port drops the scan, the trust and the test; changing the user or the key drops the test.
// Saving takes only a draft whose test matches what it holds now, and what the form shows (a mismatch is "stale").
// A draft is for one system: os "windows" (the default, PowerShell collector, Windows account rule) or "linux"
// (server/linux-telemetry.mjs: POSIX shell collector, POSIX account rule, records carry os:"linux"). Every step
// may name the system it expects, and a draft of the other one is then "draft-missing".
// A discarded or expired draft takes its key file and known_hosts with it; the key store is swept for files no
// saved connection or live draft refers to (at start, and every few minutes).
import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile,rename,rm,stat,readdir,chmod} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import path from 'node:path';
import {generateKey,importKey,parseHostKey,FINGERPRINT} from './ssh-keys.mjs';
import {runSsh,managedArgs,collectArgs,checkResult,classifySsh,validSshHost,validSshPort,validWindowsUser,validManaged,validStorePath,
 KEY_ID,CONN_ID,DRAFT_ID,WINDOWS_TIMEOUT_MS} from './windows-telemetry.mjs';
import {validUnixUser,validLinuxManaged,collectLinuxSsh,linuxCheck} from './linux-telemetry.mjs';

const fail=(code,detail)=>{throw Object.assign(new Error(code),detail?{detail}:{});};
export const newId=prefix=>prefix+randomBytes(16).toString('hex');
export const aliasOf=connId=>`hh-${String(connId).slice(1,13)}`;

// Replace the DACL atomically instead of adding grants to any existing explicit rules.
export function windowsAclScript(target,own,isDir){
 if(!validStorePath(target)||!/^S-1-\d+(?:-\d+){1,15}$/.test(own))fail('store');
 const encoded=Buffer.from(target,'utf8').toString('base64');
 return ["$ErrorActionPreference='Stop'",
  `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))`,
  `$acl=New-Object System.Security.AccessControl.${isDir?'DirectorySecurity':'FileSecurity'}`,
  `$owner=New-Object System.Security.Principal.SecurityIdentifier('${own}')`,
  '$acl.SetOwner($owner)','$acl.SetAccessRuleProtection($true,$false)',
  `$inherit=[Security.AccessControl.InheritanceFlags]::${isDir?'ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit':'None'}`,
  `foreach($id in @('${own}','S-1-5-18') | Select-Object -Unique) {`,
  ' $sid=New-Object System.Security.Principal.SecurityIdentifier($id)',
  " $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl',$inherit,'None','Allow')",
  ' $acl.AddAccessRule($rule)','}',
  'Set-Acl -LiteralPath $p -AclObject $acl',
  `$allowed=@('${own}','S-1-5-18')`,
  'foreach($r in (Get-Acl -LiteralPath $p).Access) {',
  " if($r.IsInherited -or $r.AccessControlType -ne 'Allow' -or $r.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin $allowed){throw 'Private ACL verification failed'}",'}'
 ].join('\n');
}


// Protect secret state with the same owner-only permissions as SSH keys. Shared with the device store.
export function createPrivatePathGuard({platform=process.platform,run=runSsh,uid=typeof process.getuid==='function'?process.getuid():null}={}){
 let sid=null;
 // Windows: the hub's own SID, then an ACL with exactly that SID and SYSTEM. (OI)(CI) on a directory makes new files inherit it.
 async function ownSid(){
  if(sid)return sid;
  const r=await run(['/user','/fo','csv','/nh'],{binary:'whoami',timeoutMs:10000,maxStdout:4096});
  const m=/"(S-1-\d+(?:-\d+){1,15})"/.exec(r.stdout||'');if(r.error||r.code!==0||!m)fail('store');
  return sid=m[1];
 }
 async function restrictAcl(target,isDir){
  const own=await ownSid();
  const encoded=Buffer.from(windowsAclScript(target,own,isDir),'utf16le').toString('base64');
  const r=await run(['-NoProfile','-NonInteractive','-EncodedCommand',encoded],{binary:'powershell.exe',timeoutMs:15000,maxStdout:16384});
  if(r.error||r.code!==0)fail('store');
 }
 async function privateOnPosix(target,isDir){
  if(isDir)await chmod(target,0o700);
  const s=await stat(target);
  if((s.mode&0o077)!==0||(uid!==null&&s.uid!==uid))fail('store');
 }
 return (target,isDir)=>platform==='win32'?restrictAcl(target,isDir):privateOnPosix(target,isDir);
}

// --- the key store ------------------------------------------------------------------------------------
// platform/spawnImpl/uid are for tests. Every method rejects with Error('store') when the files cannot be
// made private, or Error('store-path') when the directory's path is one ssh would misread (%, $, quotes).
export function createSshVault(dir,{platform=process.platform,run=runSsh,uid=typeof process.getuid==='function'?process.getuid():null}={}){
 const keys=path.join(dir,'keys'),hosts=path.join(dir,'known_hosts'),empty=path.join(dir,'empty');
 let ready=null;
 const secure=createPrivatePathGuard({platform,run,uid});
 async function init(){
  if(!validStorePath(path.join(keys,'k'.padEnd(33,'0')))||!validStorePath(path.join(hosts,'c'.padEnd(33,'0'))))fail('store-path');
  for(const d of [dir,keys,hosts]){await mkdir(d,{recursive:true,mode:0o700});await secure(d,true);}
  try{await stat(empty);}catch{await put(empty,'',true);}
 }
 const ensure=()=>ready??=init().catch(e=>{ready=null;throw e.message==='store-path'?e:new Error('store');});
 // Written to a new file (never following an existing one), made private, then renamed into place.
 async function put(file,content,initializing=false){
  if(!initializing)await ensure();
  const tmp=`${file}.${randomBytes(6).toString('hex')}.tmp`;
  try{await writeFile(tmp,content,{mode:0o600,flag:'wx'});await secure(tmp,false);await rename(tmp,file);}
  catch(e){throw e.message==='store'?e:new Error('store');}
  finally{await rm(tmp,{force:true}).catch(()=>{});}
 }
 const keyFile=id=>KEY_ID.test(id||'')?path.join(keys,id):fail('invalid');
 const hostsFile=id=>CONN_ID.test(id||'')?path.join(hosts,id):fail('invalid');
 const exists=async f=>{try{return (await stat(f)).isFile();}catch{return false;}};
 const knownHostsLine=(connId,hostKey)=>`${aliasOf(connId)} ${hostKey.type} ${hostKey.key}\n`;
 return {
  dir,ensure,
  writeKey:(id,pem)=>put(keyFile(id),pem),
  hasKey:id=>exists(keyFile(id)),
  deleteKey:async id=>{if(KEY_ID.test(id||''))await rm(keyFile(id),{force:true});},
  writeKnownHosts:(connId,hostKey)=>put(hostsFile(connId),knownHostsLine(connId,hostKey)),
  deleteKnownHosts:async id=>{if(CONN_ID.test(id||''))await rm(hostsFile(id),{force:true});},
  // The arguments of a managed connection (record: a stored one, or a draft's). The connection's known_hosts is
  // written again when it is missing or differs from the stored host key; a missing key is 'key-missing'.
  async spec(record){
   await ensure();
   if(!await exists(keyFile(record.keyId)))fail('key-missing');
   const kh=hostsFile(record.connId),line=knownHostsLine(record.connId,record.hostKey);
   if((await readFile(kh,'utf8').catch(()=>null))!==line)await put(kh,line);
   return {host:record.host,port:record.port,user:record.user,keyFile:keyFile(record.keyId),knownHosts:kh,empty,alias:aliasOf(record.connId)};
  },
  // Removes key and known_hosts files nobody refers to. keep = {keys:Set, conns:Set}; minAgeMs spares files
  // younger than that (a draft that is being made right now).
  async sweep({keys:keepKeys=new Set(),conns:keepConns=new Set()}={},{minAgeMs=0,now=Date.now()}={}){
   let removed=0;
   for(const [d,keep,re] of [[keys,keepKeys,KEY_ID],[hosts,keepConns,CONN_ID]]){
    let names=[];try{names=await readdir(d);}catch{continue;}
    for(const name of names){
     const base=name.replace(/\.[a-f0-9]{12}\.tmp$/,'');
     if(!re.test(base))continue;// not a file of ours: never touched
     if(name===base&&keep.has(base))continue;
     const f=path.join(d,name);let age=Infinity;try{age=now-(await stat(f)).mtimeMs;}catch{}
     if(minAgeMs<=0||age>=minAgeMs){await rm(f,{force:true}).catch(()=>{});removed++;}
    }
   }
   return removed;
  }};
}

// --- host keys and tools ------------------------------------------------------------------------------
// ssh-keyscan only performs the key exchange: it sends no user, no key and no password. Bounded like ssh.
const KEY_ORDER=['ssh-ed25519','ecdsa-sha2-nistp256','ecdsa-sha2-nistp384','ecdsa-sha2-nistp521','ssh-rsa'];
export function keyscanArgs(host,port){
 if(!validSshHost(host)||!validSshPort(port))fail('invalid');
 return ['-T','6','-p',String(port),'-t','ed25519,ecdsa,rsa','--',host];
}
// [{type, key, fingerprint}] the host presents, preferred type first. Rejects with a WINDOWS_ERRORS code.
export async function scanHostKeys(host,port,{run=runSsh}={}){
 const r=await run(keyscanArgs(host,port),{binary:'ssh-keyscan',timeoutMs:15000,maxStdout:65536});
 if(r.error==='no-ssh')fail('no-keyscan');
 if(r.error)fail(r.error==='timeout'?'timeout':r.error==='too-large'?'too-large':'spawn');
 const found=[];
 for(const line of String(r.stdout).split(/\r?\n/).slice(0,64)){
  const parts=line.trim().split(/\s+/);if(parts.length<3||line.startsWith('#'))continue;
  const k=parseHostKey(parts[1],parts[2]);if(k&&!found.some(x=>x.fingerprint===k.fingerprint))found.push(k);
 }
 if(!found.length){const code=classifySsh({code:255,stderr:r.stderr});fail(['unresolved','refused','timeout','unreachable'].includes(code)?code:'no-host-key');}
 return found.sort((a,b)=>KEY_ORDER.indexOf(a.type)-KEY_ORDER.indexOf(b.type)).slice(0,6);
}
// Are the OpenSSH client tools on the hub's server? {ok, ssh:{ok, version}, keyscan:{ok}}. Starts nothing that connects.
export async function sshTools({run=runSsh}={}){
 const v=await run(['-V'],{timeoutMs:5000,maxStdout:4096});
 const k=await run([],{binary:'ssh-keyscan',timeoutMs:5000,maxStdout:4096});
 const version=/OpenSSH[\w.-]{0,40}/.exec(`${v.stderr||''} ${v.stdout||''}`)?.[0]||null;
 const ssh={ok:!['no-ssh','spawn','timeout'].includes(v.error),version},keyscan={ok:!['no-ssh','spawn','timeout'].includes(k.error)};
 return {ok:ssh.ok&&keyscan.ok,ssh,keyscan};
}

// --- collecting through a managed connection ----------------------------------------------------------
export async function collectManaged(record,{vault,run=runSsh,timeoutMs=WINDOWS_TIMEOUT_MS,platform=process.platform}={}){
 if(!validManaged(record))fail('invalid');
 return collectArgs(managedArgs(await vault.spec(record),{platform}),{run,timeoutMs});
}

// --- set-up drafts ------------------------------------------------------------------------------------
// Error codes (Error.message) besides WINDOWS_ERRORS': the keys below, and invalid. [HTTP status, the sentence in
// the source language (English in public/i18n-en-home.js)]. None of them carries any part of a key.
export const WINDOWS_SETUP_ERRORS=Object.freeze({
 'draft-missing':[404,'Tohle nastavení spojení vypršelo nebo bylo zavřené. Začni znovu: vytvoř nebo naimportuj klíč.'],
 busy:[409,'Na tomhle nastavení právě běží jiný krok. Počkej, až doběhne.'],
 'needs-key':[409,'Nejdřív vytvoř nebo naimportuj klíč.'],
 'needs-scan':[409,'Nejdřív načti klíč hostitele pro tenhle host a port.'],
 'needs-trust':[409,'Nejdřív porovnej otisk klíče hostitele s tím na Windows a potvrď ho.'],
 'needs-test':[409,'Nejdřív vyzkoušej spojení s tímhle nastavením.'],
 stale:[409,'Host, port nebo uživatel se od zkoušky změnil. Vyzkoušej spojení znovu.'],
 'trust-mismatch':[409,'Tenhle otisk Windows při posledním načtení neukázal. Načti klíč hostitele znovu.'],
 limit:[409,'Rozpracovaných nastavení spojení je moc. Zavři ostatní dialogy, nebo to zkus za půl hodiny.'],
 store:[503,'Home Hub nemůže klíč bezpečně uložit: úložiště klíčů nejde nastavit jen pro jeho účet. Zkontroluj práva adresáře se stavem na serveru.'],
 'store-path':[503,'Cesta k adresáři se stavem obsahuje znak, který SSH čte jako syntaxi (%, $ nebo uvozovky). Přesuň stav jinam.'],
 'key-format':[422,'Tohle nevypadá jako soukromý klíč SSH. Vlož celý soubor klíče včetně řádků BEGIN a END.'],
 'key-encrypted':[422,'Klíč je chráněný heslem. Home Hub se přihlašuje bez obsluhy, takže by heslo musel uložit vedle klíče; šifrované klíče proto nebere. Vytvoř tady nový klíč jen pro Home Hub.'],
 'key-public':[422,'Tohle je veřejný klíč. Home Hub potřebuje soukromý klíč, nebo si tady vytvoř nový.'],
 'key-putty':[422,'Klíč PuTTY (.ppk) Home Hub nečte. V PuTTYgen ho exportuj jako OpenSSH key, nebo tady vytvoř nový klíč.'],
 'key-unsupported':[422,'Tenhle druh klíče Home Hub nepodporuje. Použij RSA, ECDSA nebo Ed25519 bez hesla, nebo tady vytvoř nový klíč.'],
 'key-weak':[422,'Klíč RSA je kratší než 2048 bitů. Vytvoř tady nový klíč.'],
 'key-mismatch':[422,'Části klíče k sobě nepatří (poškozený soubor?). Vytvoř tady nový klíč.']});
// The same refusals for a Linux draft, where two of them name the other system.
export const LINUX_SETUP_ERRORS=Object.freeze({...WINDOWS_SETUP_ERRORS,
 'needs-trust':[409,'Nejdřív porovnej otisk klíče hostitele s tím na stroji a potvrď ho.'],
 'trust-mismatch':[409,'Tenhle otisk stroj při posledním načtení neukázal. Načti klíč hostitele znovu.']});
export const DRAFT_LIMITS=Object.freeze({ttlMs:30*60000,perOwner:3,total:16,testFreshMs:15*60000});
// saved(): async {keys:Set, conns:Set} of the stored connections (the device store's windowsSecrets()).
// check(record): what a test runs (default: collect once through the store, then checkResult).
// checkLinux(record): what a Linux draft's test runs (default: the Linux collector once, then linuxCheck).
export function createWindowsSetup({vault,saved=async()=>({keys:new Set(),conns:new Set()}),run=runSsh,check,checkLinux,now=Date.now,limits=DRAFT_LIMITS,platform=process.platform}={}){
 const drafts=new Map(),pendingKeys=new Set();let timer=null;
 const testWindows=check||(async record=>checkResult(await collectManaged(record,{vault,run,platform})));
 const testLinux=checkLinux||(async record=>linuxCheck(await collectLinuxSsh(record,{vault,run,platform})));
 const SYSTEMS={windows:{validUser:validWindowsUser,valid:validManaged,test:testWindows,userDetail:'windows.user must be a Windows account name'},
  linux:{validUser:validUnixUser,valid:validLinuxManaged,test:testLinux,userDetail:'user must be a POSIX account name: a letter or _, then letters, digits, . _ -, at most 32'}};
 const sameHost=(a,b)=>String(a||'').toLowerCase()===String(b||'').toLowerCase();
 const testKey=d=>[d.host?.toLowerCase(),d.port,d.user,d.key?.id,d.trusted?.fingerprint].join('|');
 async function drop(d){drafts.delete(d.id);if(d.keyOwned&&d.key)await vault.deleteKey(d.key.id).catch(()=>{});await vault.deleteKnownHosts(d.connId).catch(()=>{});}
 async function expire(){const t=now();for(const d of [...drafts.values()])if(!d.busy&&t-d.touched>limits.ttlMs)await drop(d);}
 // The draft id must be one the server made, the draft this person's, alive and not in the middle of another step.
 async function take(owner,id,os){
  await expire();
  const d=typeof id==='string'&&DRAFT_ID.test(id)?drafts.get(id):null;
  if(!d||d.owner!==owner||os&&d.os!==os)fail('draft-missing');
  if(d.busy)fail('busy');
  d.touched=now();return d;
 }
 // One step at a time per draft. A discard that arrives during a step (the dialog was closed meanwhile) waits for it.
 const step=async(owner,id,fn,os)=>{const d=await take(owner,id,os);if(d.busy)fail('busy');d.busy=true;
  try{return await fn(d);}finally{d.busy=false;d.touched=now();if(d.discarded||drafts.get(d.id)!==d)await drop(d);}};
 const params=({host,port,user}={},{needUser=false,os='windows'}={})=>{
  if(!validSshHost(host))fail('invalid','windows.host must be a host name or an IPv4 address');
  if(!validSshPort(port))fail('invalid','windows.port must be 1-65535');
  if((needUser||user!==undefined)&&!SYSTEMS[os].validUser(user))fail('invalid',SYSTEMS[os].userDetail);
  return {host,port,user};
 };
 // Host or port changed: whatever was learnt about the old one no longer applies.
 async function moveTo(d,host,port){
  if(d.host!==null&&sameHost(d.host,host)&&d.port===port)return;
  d.host=host;d.port=port;d.scanned=null;d.trusted=null;d.tested=null;
  await vault.deleteKnownHosts(d.connId).catch(()=>{});
 }
 // What the browser sees of a draft. Never the private key (it is not even in memory), never a path.
 const view=d=>({id:d.id,os:d.os,device:d.deviceId,host:d.host,port:d.port,user:d.user,
  key:d.key?{type:d.key.type,bits:d.key.bits,fingerprint:d.key.fingerprint,publicKey:d.key.publicKey,source:d.key.source,reused:!d.keyOwned}:null,
  hostKeys:d.scanned?d.scanned.keys.map(k=>({type:k.type,fingerprint:k.fingerprint})):null,
  trusted:d.trusted?{type:d.trusted.type,fingerprint:d.trusted.fingerprint,reused:Boolean(d.trusted.reused)}:null,
  tested:d.tested&&d.tested.key===testKey(d)?{at:new Date(d.tested.at).toISOString()}:null,
  expiresAt:new Date(d.touched+limits.ttlMs).toISOString()});
 const record=d=>({mode:'managed',...(d.os==='linux'?{os:'linux'}:{}),host:d.host,port:d.port,user:d.user,keyId:d.key.id,connId:d.connId,keyType:d.key.type,keyFingerprint:d.key.fingerprint,
  publicKey:d.key.publicKey,keySource:d.key.source,hostKey:{type:d.trusted.type,key:d.trusted.key,fingerprint:d.trusted.fingerprint}});
 async function referenced(){
  const s=await saved().catch(()=>null);if(!s)return null;
  const keys=new Set([...s.keys,...pendingKeys]),conns=new Set(s.conns);
  for(const d of drafts.values()){if(d.key)keys.add(d.key.id);conns.add(d.connId);}
  return {keys,conns};
 }
 const api={
  // A new draft for owner (the signed-in username). deviceId: the device it will be saved to, or null for a
  // new one. current: that device's stored managed connection, if any: its key and (for the same host and
  // port) its verified host key are reused, so changing only the user needs nothing but a new test.
  async create(owner,{deviceId=null,current=null,os='windows'}={}){
   if(typeof owner!=='string'||!owner||!Object.hasOwn(SYSTEMS,os))fail('invalid');
   await expire();
   const mine=[...drafts.values()].filter(d=>d.owner===owner).sort((a,b)=>a.touched-b.touched);
   // A person's oldest unfinished draft gives way (a closed tab never cancelled it); the whole hub is capped.
   while(mine.length>=limits.perOwner){const old=mine.shift();if(old.busy)fail('limit');await drop(old);}
   if(drafts.size>=limits.total)fail('limit');
   const d={id:newId('d'),owner,os,deviceId,connId:newId('c'),host:null,port:22,user:null,key:null,keyOwned:false,scanned:null,trusted:null,tested:null,busy:false,touched:now()};
   drafts.set(d.id,d);d.busy=true;
   try{if(current&&SYSTEMS[os].valid(current)){
    d.host=current.host;d.port=current.port;d.user=current.user;
    if(await vault.hasKey(current.keyId).catch(()=>false))d.key={id:current.keyId,type:current.keyType||current.publicKey.split(' ')[0],bits:null,fingerprint:current.keyFingerprint,publicKey:current.publicKey,source:current.keySource||'generated'};
    d.trusted={host:current.host,port:current.port,...current.hostKey,reused:true};
    drafts.set(d.id,d);
    try{await vault.writeKnownHosts(d.connId,current.hostKey);}catch(e){await drop(d);throw e;}
   }
   return view(d);
   }catch(e){await drop(d);throw e;}finally{d.busy=false;}
  },
  // {generate:true} or {privateKey:"…"}. The draft's previous key, if it made one, is deleted.
  key:(owner,id,input,{os}={})=>step(owner,id,async d=>{
   const generateIt=input?.generate===true,text=input?.privateKey;
   if(generateIt===(typeof text==='string'))fail('invalid','send generate:true or privateKey');
   const m=generateIt?await generateKey():importKey(text);
   const keyId=newId('k');pendingKeys.add(keyId);
   try{await vault.writeKey(keyId,m.pem);
   if(d.keyOwned&&d.key)await vault.deleteKey(d.key.id).catch(()=>{});
   d.key={id:keyId,type:m.type,bits:m.bits,fingerprint:m.fingerprint,publicKey:m.publicKey,source:m.source};d.keyOwned=true;d.tested=null;
   return view(d);
   }finally{pendingKeys.delete(keyId);}},os),
  // The host keys at host:port. A different host or port than before starts over.
  scan:(owner,id,input,{os}={})=>step(owner,id,async d=>{
   const {host,port}=params(input);await moveTo(d,host,port);
   const keys=await scanHostKeys(host,port,{run});
   d.scanned={host,port,keys};d.trusted=null;d.tested=null;await vault.deleteKnownHosts(d.connId).catch(()=>{});
   return view(d);},os),
  // The person confirms one fingerprint of the last scan of the draft's current host and port.
  trust:(owner,id,input,{os}={})=>step(owner,id,async d=>{
   const fp=input?.fingerprint;if(typeof fp!=='string'||!FINGERPRINT.test(fp))fail('invalid','fingerprint must be SHA256:…');
   if(!d.scanned||!sameHost(d.scanned.host,d.host)||d.scanned.port!==d.port)fail('needs-scan');
   const k=d.scanned.keys.find(x=>x.fingerprint===fp);if(!k)fail('trust-mismatch');
   await vault.writeKnownHosts(d.connId,k);
   d.trusted={host:d.host,port:d.port,type:k.type,key:k.key,fingerprint:k.fingerprint};d.tested=null;
   return view(d);},os),
  // One run of the collector with what the form shows. Returns {draft, result}; rejects with the collector's code.
  test:(owner,id,input,{os}={})=>step(owner,id,async d=>{
   const {host,port,user}=params(input,{needUser:true,os:d.os});
   await moveTo(d,host,port);
   if(d.user!==user){d.user=user;d.tested=null;}
   if(!d.key)fail('needs-key');
   if(!d.trusted)fail(d.scanned?'needs-trust':'needs-scan');
   d.tested=null;
   const started=now(),result=await SYSTEMS[d.os].test(record(d));
   d.tested={key:testKey(d),at:now()};
   return {draft:view(d),result:{ok:true,tookMs:now()-started,connection:{host:d.host,port:d.port,user:d.user,keyFingerprint:d.key.fingerprint,hostKeyFingerprint:d.trusted.fingerprint},...result}};},os),
  // The connection to store, if this draft may be saved now for this device with what the form shows. The draft
  // stays reserved (busy) until commit() or release(): two saves of one draft cannot both pass.
  async claim(owner,id,input,{deviceId=null,os='windows'}={}){
   const d=await take(owner,id,os);
   if(d.busy)fail('busy');
   const {host,port,user}=params(input,{needUser:true,os});
   if(d.deviceId!==deviceId)fail('draft-missing');
   if(!d.key)fail('needs-key');if(!d.trusted)fail('needs-trust');
   if(!sameHost(d.host,host)||d.port!==port||d.user!==user)fail('stale');
   if(!d.tested||d.tested.key!==testKey(d))fail('needs-test');
   if(now()-d.tested.at>limits.testFreshMs)fail('needs-test');
   const r=record(d);if(!SYSTEMS[d.os].valid(r))fail('invalid');
   d.busy=true;return r;
  },
  // Saved: the files now belong to the stored connection.
  commit(id){drafts.delete(id);},
  async release(id){const d=drafts.get(id);if(d){d.busy=false;d.touched=now();if(d.discarded)await drop(d);}},
  async discard(owner,id,{os}={}){
   await expire();
   const d=typeof id==='string'&&DRAFT_ID.test(id)?drafts.get(id):null;
   if(!d||d.owner!==owner||os&&d.os!==os)fail('draft-missing');
   if(d.busy){d.discarded=true;return true;}
   await drop(d);return true;},
  // A stored connection that is no longer used (disconnected, replaced or its device removed): its files go,
  // unless a live draft still uses that key or that known_hosts.
  async forget(entry,{keep=null}={}){
   if(!entry||entry.mode!=='managed')return;
   const inDrafts=[...drafts.values()];
   if(KEY_ID.test(entry.keyId||'')&&entry.keyId!==keep?.keyId&&!inDrafts.some(d=>d.key?.id===entry.keyId))await vault.deleteKey(entry.keyId).catch(()=>{});
   if(CONN_ID.test(entry.connId||'')&&entry.connId!==keep?.connId)await vault.deleteKnownHosts(entry.connId).catch(()=>{});
  },
  // Removes expired drafts, then every key-store file nobody refers to. A one-minute startup grace protects files
  // being written while the server becomes ready; later only those older than ten minutes (the draft that is writing one is in memory).
  async sweep({startup=false}={}){
   await expire();
   const keep=await referenced();if(!keep)return 0;// the device store could not be read: delete nothing
   return vault.sweep(keep,{minAgeMs:startup?60000:10*60000});// file ages are wall-clock time
  },
  start(){if(timer)return;timer=setInterval(()=>void api.sweep().catch(()=>{}),5*60000);timer.unref?.();return api.sweep({startup:true}).catch(()=>0);},
  stop(){clearInterval(timer);timer=null;},
  size:()=>drafts.size};
 return api;
}
