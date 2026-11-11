// Backup jobs, the part that touches machines: the job's own SSH key, pinned host keys, connection tests, the
// rsync runs that make snapshots on the target, retention, and the in-app scheduler.
//
// The hub is the orchestrator. It uses only tools that are already there (ssh, ssh-keygen, ssh-keyscan, rsync;
// sh, mkdir, mv, rm, ln, df, cat on the target). Nothing is installed on either side. The login shell of the user
// on the target (and on SSH sources) must accept POSIX `sh -c '…'` quoting: sh, bash, zsh, dash, ksh (fish works
// too); csh/tcsh are not supported.
//
// Security rules kept here, in one place:
//   - each job has its own ed25519 key pair in <keys dir>/<job id>/ (default private/backup-jobs/, 0700; the
//     private key 0600). The private key is never read by this code, logged, or returned; only the .pub is read.
//   - every connection uses the job's own ssh_config (written from the validated job, 0600, via temp + rename;
//     the hardening block comes first): its key only (IdentitiesOnly, no agent), its own known_hosts holding only
//     the pinned keys, StrictHostKeyChecking=yes, BatchMode, no forwarding, no multiplexing, no ~/.ssh/config.
//     A host key is pinned only after a person compared its fingerprint (trust on first use); a changed key is
//     refused, never accepted
//   - processes are spawned with an argument array (no local shell), stdin closed, bounded output, a deadline,
//     and cancellation (SIGTERM, then SIGKILL, to the whole process group). Remote commands are fixed scripts
//     run under `sh -c`, with the validated paths single-quoted
//   - a local source may not be (or lie inside) the key directory or the backup state; the key directory, the
//     hub's private/ and the backup state are excluded from any local source that contains them. Paths are
//     compared after realpath (symlinks), and without regard to case on macOS and Windows
//   - the destination holds an owner marker (.home-hub-backup-job = the job id); a job never prepares, prunes
//     or deletes in a destination another job owns
//
// Snapshot layout on the target, in the job's destination directory:
//   <dest>/2026-11-11T023000Z/<source name>/…    one directory per successful run (UTC start time)
//   <dest>/latest -> 2026-11-11T023000Z           the snapshot of the last successful run
//   <dest>/.in-progress-<stamp>/                  the run being written; renamed when it succeeds,
//                                                 removed by the next run when it did not
//   <dest>/.home-hub-backup-job                   the owner marker
// Unchanged files are hard links into the previous snapshot (rsync --link-dest), so every snapshot is a full,
// browsable tree and costs only what changed. Retention deletes whole snapshot directories after a successful run.
// A source on another machine is first mirrored into a staging directory on the hub (rsync pull, incremental),
// then pushed like a local one: rsync cannot copy between two remote machines, and no key is ever handed on.
import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile,rename,rm,stat,chmod,access,readdir,open,unlink} from 'node:fs/promises';
import {existsSync,openSync,writeSync,closeSync,realpathSync,constants as FS} from 'node:fs';
import path from 'node:path';
import {BackupError,SNAPSHOT,JOB_ID,complete,hostKeyOf,snapshotName,pruneList,parseStats,addStats,rsyncOutcome,nextRun,missedAtStart,expandHome,DEFAULT_TIMEOUT_MINUTES} from './backup-config.mjs';
import {inCidrs,hubAddress} from './site-config.mjs';

export const SSH_TIMEOUT_MS=60000,KEYSCAN_TIMEOUT_MS=15000,KEYGEN_TIMEOUT_MS=15000;
export const RSYNC_IO_TIMEOUT_S=600;
export const LOG_LIMIT=262144,RUN_LIMIT=200;
export const CATCH_UP_DELAY_MS=60000,MAX_TIMER_MS=3600000;
// A lock older than the job's own deadline plus this is stale whoever holds it (a reused PID cannot keep it).
export const LOCK_MARGIN_MS=10*60000;
export const OWNER_FILE='.home-hub-backup-job';
const OUTPUT_LIMIT=1048576;
const q=s=>`'${String(s).replace(/'/g,`'\\''`)}'`;
const fail=(code,detail)=>{throw new BackupError(code,detail);};

// One sentence per failure code, in the source language (English in public/i18n-en-backups.js): what it means
// and what to do. The SSH or rsync error output itself is never shown here; the run's log keeps it.
export const BACKUP_ERRORS=Object.freeze({
 invalid:'Neplatné zadání; nic se neuložilo.',
 conflict:'Úloha se mezitím změnila. Načti ji znovu a změnu zopakuj.',
 'not-found':'Taková úloha zálohy tu není.',
 limit:'Dosažen limit počtu úloh záloh.',
 unreadable:'Soubor s úlohami záloh nejde přečíst; hub ho nepřepíše. Oprav ho nebo ho přesuň stranou.',
 'history-unreadable':'Záznam běhů této úlohy nejde přečíst; hub ho nepřepíše. Oprav ho nebo ho přesuň stranou.',
 incomplete:'Úloha ještě není hotová: chybí cíl, zdroj nebo potvrzený klíč hostitele.',
 busy:'Tahle úloha právě běží. Počkej na konec nebo ji zruš.',
 locked:'Tuhle úlohu právě spouští jiný proces Home Hubu (zámek běhu). Počkej, až skončí.',
 'not-running':'Úloha teď neběží.',
 'no-key':'Klíč úlohy chybí. Smaž úlohu a založ ji znovu.',
 'key-failed':'Klíč pro úlohu se nepodařilo vytvořit (ssh-keygen).',
 'no-tool':'Na stroji s Home Hubem chybí ssh, ssh-keygen, ssh-keyscan nebo rsync.',
 'path-space':'Cesta ke klíčům nebo k ssh obsahuje mezeru; rsync by ji rozdělil. Přesuň adresář klíčů (BACKUP_KEYS_DIR).',
 'keyscan-failed':'Klíč hostitele se nepodařilo přečíst: stroj neodpovídá na portu SSH nebo jméno nejde přeložit.',
 'host-key-unknown':'Klíč hostitele ještě není potvrzený. Porovnej otisk s tím na stroji a potvrď ho.',
 'host-key-changed':'Klíč hostitele se změnil oproti potvrzenému. Může jít o přeinstalovaný stroj, ale i o podvržený. Ověř otisk na stroji; hub se do té doby nepřipojí.',
 'fingerprint-mismatch':'Stroj teď ukazuje jiný klíč, než jaký jsi potvrzoval. Zkus test znovu.',
 denied:'SSH přihlášení odmítnuto: stroj nepřijal klíč úlohy. Je veřejný klíč v authorized_keys správného uživatele a má soubor správná práva?',
 unresolved:'Jméno hostitele nejde přeložit.',
 refused:'Stroj odmítl spojení na port SSH. Běží na něm SSH server?',
 timeout:'Spojení nebo běh vypršel.',
 unreachable:'Stroj není v síti k zastižení. To neznamená, že je vypnutý.',
 ssh:'SSH spojení selhalo. Podrobnosti jsou v záznamu běhu.',
 'no-shell':'Přihlášení prošlo, ale uživatel nemá shell (nologin), nebo omezení klíče nedovolí spustit příkaz.',
 'dest-missing':'Cílový adresář na cíli neexistuje. Založ ho a dej ho uživateli zálohy.',
 'dest-readonly':'Do cílového adresáře nejde zapisovat. Patří uživateli zálohy?',
 'dest-owned':'Cílový adresář patří jiné úloze zálohy (soubor .home-hub-backup-job). Každá úloha potřebuje vlastní adresář.',
 'dest-shared':'Tenhle cílový adresář (nebo adresář nad ním či pod ním) už používá jiná úloha. Každá úloha potřebuje vlastní adresář.',
 'no-remote-rsync':'Na vzdáleném stroji chybí rsync.',
 'source-missing':'Zdroj neexistuje.',
 'source-unreadable':'Zdroj nejde přečíst.',
 'source-not-dir':'Zdroj na jiném stroji musí být adresář.',
 'source-protected':'Zdroj leží v adresáři s klíči záloh nebo ve stavu záloh hubu. Ten se zálohovat nesmí.',
 'stamp-exists':'Snímek s tímto časem už na cíli je; nový se nepřejmenoval. Zkus běh znovu.',
 rsync:'rsync skončil chybou. Podrobnosti jsou v záznamu běhu.',
 cancelled:'Běh byl zrušen.',
 interrupted:'Běh přerušilo ukončení Home Hubu. Nedokončený snímek odstraní další běh.',
 'snapshot-missing':'Takový snímek na cíli není.',
 unavailable:'Zálohy teď neodpovídají.'});
// Sentences for a run that finished with a warning (the snapshot is kept).
export const BACKUP_WARNINGS=Object.freeze({
 partial:'Některé soubory nešlo přečíst nebo během běhu zmizely (rsync 23/24). Snímek zůstal, staré snímky se nemazaly.',
 'source-empty':'Zdroj byl prázdný. Snímek zůstal, ale staré snímky se pro jistotu nemazaly.',
 'newer-snapshot':'Na cíli je snímek novější, než je tento běh (posunuté hodiny?). Staré snímky se nemazaly.',
 'prune-failed':'Snímek je hotový, ale mazání starých snímků selhalo. Zkusí se po dalším běhu.'});
export const errorMessage=code=>BACKUP_ERRORS[code]||BACKUP_ERRORS.unavailable;
export const warningMessage=code=>BACKUP_WARNINGS[code]||BACKUP_WARNINGS.partial;

// ---- processes ---------------------------------------------------------------------------------------
// The tools, by name on the PATH unless options.backupTools names them (tests use a directory of fakes).
export function backupTools(given){given=given||{};
 return {ssh:given.ssh||'ssh',rsync:given.rsync||'rsync',sshKeygen:given.sshKeygen||'ssh-keygen',sshKeyscan:given.sshKeyscan||'ssh-keyscan'};
}
// The environment a child gets: no SSH agent, a stable locale for rsync's output.
const childEnv=()=>{const env={...process.env,LC_ALL:'C',LANG:'C'};delete env.SSH_AUTH_SOCK;delete env.SSH_AGENT_PID;return env;};
const isAlive=pid=>{try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}};
// Signals go to the child's process group (it is spawned detached, as a group leader), so ssh under rsync goes too.
const killGroup=(pid,sig)=>{try{process.kill(-pid,sig);return;}catch{}try{process.kill(pid,sig);}catch{}};
// → {code, signal, stdout, stderr, error}. error: timeout | cancelled | interrupted | no-tool | spawn | null.
// onOutput(text) sees both streams; onSpawn(pid) is told the child's pid (recorded in the run lock).
export function runProcess(bin,args,{timeoutMs=SSH_TIMEOUT_MS,signal=null,onOutput=null,onSpawn=null,spawnImpl=spawn,maxOutput=OUTPUT_LIMIT}={}){
 return new Promise(resolve=>{
  let child,done=false,killer=null,why=null;const out=[],err=[];let outSize=0,errSize=0;
  const reasonOf=r=>r==='timeout'?'timeout':r==='shutdown'?'interrupted':'cancelled';
  const finish=r=>{if(done)return;done=true;clearTimeout(timer);clearTimeout(killer);signal?.removeEventListener?.('abort',onAbort);resolve(r);};
  const stop=reason=>{if(why)return;why=reason;if(child?.pid)killGroup(child.pid,'SIGTERM');killer=setTimeout(()=>{if(child?.pid)killGroup(child.pid,'SIGKILL');},5000);killer.unref?.();};
  const onAbort=()=>stop(reasonOf(signal.reason));
  const timer=setTimeout(()=>stop('timeout'),timeoutMs);timer.unref?.();
  if(signal?.aborted)return finish({code:null,signal:null,stdout:'',stderr:'',error:reasonOf(signal.reason)});
  signal?.addEventListener?.('abort',onAbort);
  try{child=spawnImpl(bin,args,{stdio:['ignore','pipe','pipe'],shell:false,windowsHide:true,detached:process.platform!=='win32',env:childEnv()});}
  catch{return finish({code:null,signal:null,stdout:'',stderr:'',error:'spawn'});}
  if(child.pid)try{onSpawn?.(child.pid);}catch{}
  const take=(list,c,size)=>{if(size<maxOutput)list.push(c.subarray(0,maxOutput-size));return size+c.length;};
  child.stdout?.on('data',c=>{outSize=take(out,c,outSize);onOutput?.(String(c));});
  child.stderr?.on('data',c=>{errSize=take(err,c,errSize);onOutput?.(String(c));});
  child.on('error',e=>finish({code:null,signal:null,stdout:'',stderr:Buffer.concat(err).toString('utf8'),error:e?.code==='ENOENT'?'no-tool':'spawn'}));
  child.on('close',(code,sig)=>finish({code,signal:sig,stdout:Buffer.concat(out).toString('utf8'),stderr:Buffer.concat(err).toString('utf8'),error:why}));
 });
}
// What an ssh failure means, as a code of BACKUP_ERRORS. Only exit 255 is ssh's own failure: any other exit
// status is the remote command's, and its stderr (a "Permission denied" from rm, say) says nothing about ssh.
export function classifySsh({code,stderr='',error=null}){
 if(error)return error;
 if(code!==255)return null;
 const s=String(stderr);
 if(/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key for \S+ has changed|host key mismatch/i.test(s))return 'host-key-changed';
 if(/Host key verification failed|No \S+ host key is known|host key is not known/i.test(s))return 'host-key-unknown';
 if(/Permission denied|Too many authentication failures/i.test(s))return 'denied';
 if(/Could not resolve hostname|nodename nor servname|Name or service not known|Temporary failure in name resolution/i.test(s))return 'unresolved';
 if(/Connection refused/i.test(s))return 'refused';
 if(/timed out/i.test(s))return 'timeout';
 if(/No route to host|Network is unreachable|Host is down|Connection reset|Connection closed by/i.test(s))return 'unreachable';
 if(/This account is currently not available|nologin|forced command|shell request failed/i.test(s))return 'no-shell';
 return 'ssh';
}
// rsync's exit status → {outcome: ok | warning} or throws the failure code. 0 done; 23/24 some files unreadable
// or vanished (a warning: the snapshot is kept). 255, 12, 30, 35: the connection or the remote side failed, so
// its stderr is read as ssh's. Anything else is rsync's own error. 23/24 are decided before any stderr is read.
export function rsyncResult({code,stderr='',error=null}){
 if(error)fail(error);
 const o=rsyncOutcome(code);
 if(o!=='failed')return o;
 if(/rsync: (?:command )?not found|sh: \d*:? ?rsync: not found|rsync: No such file or directory/i.test(stderr))fail('no-remote-rsync',`exit ${code}`);
 if([255,12,30,35].includes(code))fail(classifySsh({code:255,stderr})||'ssh',`exit ${code}`);
 fail('rsync',`exit ${code}`);
}
const noSpace=(...paths)=>{if(paths.some(p=>/\s/.test(p)))fail('path-space');};

// ---- paths a backup must never carry away -------------------------------------------------------------
const caseless=process.platform==='darwin'||process.platform==='win32';
// The real path; for a path that does not exist yet, the real path of its nearest existing parent plus the rest.
export async function realOf(p){
 let at=path.resolve(p),tail=[];
 for(;;){try{return path.join(realpathSync.native(at),...tail);}catch{const up=path.dirname(at);if(up===at)return path.join(at,...tail);tail.unshift(path.basename(at));at=up;}}
}
export const within=(child,parent,{ci=caseless}={})=>{const a=ci?child.toLowerCase():child,b=ci?parent.toLowerCase():parent;return a===b||a.startsWith(b.endsWith(path.sep)?b:b+path.sep);};
// rsync reads * ? [ and \ as pattern characters; escaped, a directory name is matched literally.
export const globEscape=s=>s.replace(/[\\*?[\]]/g,'\\$&');
// → {real, excludes: ['--exclude=/<rel>/', …]} or throws source-protected. reject: directories a source may not
// be at or inside; exclude: directories left out when they lie inside the source.
export async function guardSource(source,{reject=[],exclude=[],ci=caseless}={}){
 const real=await realOf(source);
 for(const r of reject)if(within(real,await realOf(r),{ci}))fail('source-protected');
 const excludes=[];
 for(const x of exclude){
  const rx=await realOf(x);
  if(rx.length>real.length&&within(rx,real,{ci})){const rel=rx.slice(real.length).replace(/^[\\/]+/,'').split(path.sep).join('/');const pattern=`--exclude=/${globEscape(rel)}/`;if(!excludes.includes(pattern))excludes.push(pattern);}
 }
 return {real,excludes};
}

// ---- the job's key and ssh files ---------------------------------------------------------------------
export function jobFiles(keysDirectory,id){
 const dir=path.join(keysDirectory,id);
 return {dir,key:path.join(dir,'id_ed25519'),pub:path.join(dir,'id_ed25519.pub'),config:path.join(dir,'ssh_config'),knownHosts:path.join(dir,'known_hosts')};
}
// Creates the job's key pair once. The private key never leaves this function's directory.
export async function createKey(keysDirectory,id,{tools=backupTools(),spawnImpl}={}){
 const f=jobFiles(keysDirectory,id);
 await mkdir(keysDirectory,{recursive:true,mode:0o700});await mkdir(f.dir,{recursive:true,mode:0o700});await chmod(f.dir,0o700);
 if(!existsSync(f.key)){
  const r=await runProcess(tools.sshKeygen,['-q','-t','ed25519','-N','','-C',`home-hub-backup-${id}`,'-f',f.key],{timeoutMs:KEYGEN_TIMEOUT_MS,spawnImpl});
  if(r.error==='no-tool')fail('no-tool');
  if(r.code!==0||!existsSync(f.key)||!existsSync(f.pub))fail('key-failed');
 }
 await chmod(f.key,0o600);
 return publicKey(keysDirectory,id);
}
export async function publicKey(keysDirectory,id){
 try{const line=(await readFile(jobFiles(keysDirectory,id).pub,'utf8')).trim();return /^ssh-ed25519 [A-Za-z0-9+/]+=* ?[\w.@-]*$/.test(line)?line:null;}catch{return null;}
}
export const removeKey=(keysDirectory,id)=>rm(jobFiles(keysDirectory,id).dir,{recursive:true,force:true});
// hubAddress lives in site-config.mjs (the telemetry guides need it too); re-exported for this module's callers.
export {hubAddress};
// The authorized_keys lines a person puts on the target (and on each SSH source). `restrict` turns off port,
// agent and X11 forwarding and the pty; from="…" (when the hub's address is known) accepts the key only from it.
// The key still gives a shell on that machine (the hub runs fixed scripts there); on a source that only has to
// be read, command="rrsync -ro <path>" narrows it to read-only rsync (the wizard's connection test then reports
// no-shell, the runs work). The target needs the shell: snapshots are renamed and pruned with mv and rm.
export function authorizedKeys(pub,{address=null}={}){
 if(!pub)return null;
 const from=address?`,from="${address}"`:'';
 return {line:`restrict${from} ${pub}`,plain:pub,address};
}
const ALIAS={target:'hh-target',source:i=>`hh-src-${i}`};
// Hardening first: ssh takes the first value it finds for each option, so nothing below can loosen it. The
// host blocks set only HostName, Port, User and HostKeyAlias, from values validated when the job was read.
function sshConfig(job,f){
 const host=(alias,h)=>[`Host ${alias}`,`  HostName ${h.host}`,`  Port ${h.port}`,`  User ${h.user}`,`  HostKeyAlias ${alias}`];
 const lines=['# Written by Home Hub for one backup job. Regenerated before every connection; edits are lost.',
  'Host *',`  IdentityFile "${f.key}"`,'  IdentitiesOnly yes','  IdentityAgent none',`  UserKnownHostsFile "${f.knownHosts}"`,'  GlobalKnownHostsFile /dev/null',
  '  StrictHostKeyChecking yes','  CheckHostIP no','  BatchMode yes','  PasswordAuthentication no','  KbdInteractiveAuthentication no','  ConnectTimeout 10',
  '  ServerAliveInterval 15','  ServerAliveCountMax 4','  ForwardAgent no','  ForwardX11 no','  ClearAllForwardings yes','  PermitLocalCommand no',
  '  ControlMaster no','  ControlPath none','  UpdateHostKeys no','  RequestTTY no','  LogLevel ERROR',
  ...(job.target?host(ALIAS.target,job.target):[]),
  ...job.sources.flatMap((s,i)=>s.kind==='ssh'?host(ALIAS.source(i),s):[])];
 const known=[...(job.target?.hostKey?[`${ALIAS.target} ${job.target.hostKey.type} ${job.target.hostKey.key}`]:[]),
  ...job.sources.flatMap((s,i)=>s.kind==='ssh'&&s.hostKey?[`${ALIAS.source(i)} ${s.hostKey.type} ${s.hostKey.key}`]:[])];
 return {config:lines.join('\n')+'\n',known:known.join('\n')+(known.length?'\n':'')};
}
const atomicWrite=async(file,text)=>{const tmp=`${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;await writeFile(tmp,text,{mode:0o600});await chmod(tmp,0o600);await rename(tmp,file);};
export async function writeSshFiles(job,keysDirectory){
 const f=jobFiles(keysDirectory,job.id);
 if(!existsSync(f.key))fail('no-key');
 const {config,known}=sshConfig(job,f);
 await atomicWrite(f.knownHosts,known);await atomicWrite(f.config,config);
 return f;
}

// ---- host keys --------------------------------------------------------------------------------------
// ssh-keyscan output → [{type, key, fingerprint}], ed25519 first.
export function parseKeyscan(text){
 const order=['ssh-ed25519','ecdsa-sha2-nistp256','ecdsa-sha2-nistp384','ecdsa-sha2-nistp521','ssh-rsa'],seen=new Set(),out=[];
 for(const line of String(text).split('\n')){
  if(!line.trim()||line.startsWith('#'))continue;
  const [,type,key]=line.trim().split(/\s+/);const pin=hostKeyOf({type,key});
  if(pin&&!seen.has(pin.key)){seen.add(pin.key);out.push({type:pin.type,key:pin.key,fingerprint:pin.fingerprint});}
 }
 return out.sort((a,b)=>order.indexOf(a.type)-order.indexOf(b.type));
}
export async function scanHostKeys(h,{tools=backupTools(),spawnImpl}={}){
 const r=await runProcess(tools.sshKeyscan,['-T','5','-p',String(h.port),'-t','ed25519,ecdsa,rsa','--',h.host],{timeoutMs:KEYSCAN_TIMEOUT_MS,spawnImpl});
 if(r.error==='no-tool')fail('no-tool');
 const keys=parseKeyscan(r.stdout);
 if(!keys.length)fail('keyscan-failed');
 return keys;
}
// Compare what the host shows now with what was pinned: unpinned | match | changed.
export const keyState=(pinned,keys)=>!pinned?'unpinned':keys.some(k=>k.key===pinned.key&&k.type===pinned.type)?'match':'changed';
export const pinFrom=(keys,fp,by,now=new Date())=>{const k=keys.find(x=>x.fingerprint===fp);return k?{type:k.type,key:k.key,fingerprint:k.fingerprint,pinnedAt:now.toISOString(),pinnedBy:by||null}:null;};

// ---- remote scripts --------------------------------------------------------------------------------------
// Each prints "HHB <word> <value>" lines; anything else is noise for the log.
const LIST_SNAPSHOTS='for x in */; do x=${x%/}; [ -d "$x" ] && [ ! -L "$x" ] && echo "HHB snap $x"; done; :';
const RELINK='last=""; for x in */; do x=${x%/}; case "$x" in [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9]*Z) [ -L "$x" ] || last=$x;; esac; done; if [ -n "$last" ]; then ln -sfn "$last" latest; else rm -f latest; fi';
const DF='df -Pk "$d" 2>/dev/null | awk \'NR==2{print "HHB df "$2" "$4}\'';
// The owner marker: a destination that names another job is refused; strict = the marker must be there too.
const OWNED=(id,{strict=false}={})=>`o=$(cat ${OWNER_FILE} 2>/dev/null); if [ -n "$o" ]${strict?' || [ -z "$o" ]':''}; then if [ "$o" != ${q(id)} ]; then echo "HHB error dest-owned"; exit 7; fi; fi`;
export const scripts={
 checkTarget:dest=>[`d=${q(dest)}`,'if [ -d "$d" ]; then echo "HHB dir yes"; else echo "HHB dir no"; exit 0; fi',
  't="$d/.home-hub-write-test.$$"','if ( : > "$t" ) 2>/dev/null; then rm -f "$t"; echo "HHB writable yes"; else echo "HHB writable no"; fi',
  'if command -v rsync >/dev/null 2>&1; then echo "HHB rsync yes"; else echo "HHB rsync no"; fi',DF,
  `if [ -f "$d/${OWNER_FILE}" ]; then echo "HHB owner $(cat "$d/${OWNER_FILE}")"; fi`,`cd "$d" && { ${LIST_SNAPSHOTS}; }`].join('\n'),
 checkSource:p=>[`d=${q(p)}`,'if [ -e "$d" ]; then echo "HHB exists yes"; else echo "HHB exists no"; exit 0; fi','if [ -d "$d" ]; then echo "HHB dir yes"; else echo "HHB dir no"; fi',
  'if [ -r "$d" ]; then echo "HHB readable yes"; else echo "HHB readable no"; fi','if command -v rsync >/dev/null 2>&1; then echo "HHB rsync yes"; else echo "HHB rsync no"; fi'].join('\n'),
 // Before a run: the destination exists, belongs to this job (or to none yet: then it does from now on), leftovers of
 // an unfinished run go, the new run's directories exist.
 prepare:(dest,stamp,names,id)=>[`d=${q(dest)}`,'if [ ! -d "$d" ]; then echo "HHB error dest-missing"; exit 3; fi','cd "$d" || exit 3',OWNED(id),
  `if [ ! -f ${OWNER_FILE} ]; then if ! printf '%s\\n' ${q(id)} > ${OWNER_FILE} 2>/dev/null; then echo "HHB error dest-readonly"; exit 4; fi; fi`,
  `for x in .in-progress-*; do if [ -e "$x" ] && [ "$x" != ${q('.in-progress-'+stamp)} ]; then rm -rf -- "$x"; fi; done`,
  `if ! mkdir -p -- ${names.map(n=>q(`.in-progress-${stamp}/${n}`)).join(' ')} 2>/dev/null; then echo "HHB error dest-readonly"; exit 4; fi`,
  'if ! command -v rsync >/dev/null 2>&1; then echo "HHB error no-remote-rsync"; exit 5; fi',LIST_SNAPSHOTS].join('\n'),
 // After the copies: the new snapshot gets its name and latest points at it. This decides whether the run succeeded.
 seal:(dest,stamp,id)=>[`d=${q(dest)}`,'cd "$d" || exit 3',OWNED(id,{strict:true}),
  `if [ -e ${q(stamp)} ]; then echo "HHB error stamp-exists"; exit 6; fi`,`mv -- ${q('.in-progress-'+stamp)} ${q(stamp)} || exit 4`,
  `ln -sfn ${q(stamp)} latest`,LIST_SNAPSHOTS,DF].join('\n'),
 // Retention, separately: a failure here leaves a good snapshot (the run ends with a warning).
 prune:(dest,names,id)=>[`d=${q(dest)}`,'cd "$d" || exit 3',OWNED(id,{strict:true}),`rm -rf -- ${names.map(q).join(' ')} || exit 4`,LIST_SNAPSHOTS,DF].join('\n'),
 remove:(dest,name,id)=>[`d=${q(dest)}`,'cd "$d" || exit 3',OWNED(id,{strict:true}),`if [ ! -d ${q(name)} ]; then echo "HHB error snapshot-missing"; fi`,`rm -rf -- ${q(name)} || exit 4`,RELINK,LIST_SNAPSHOTS,DF].join('\n'),
 list:dest=>[`d=${q(dest)}`,'cd "$d" || exit 3',LIST_SNAPSHOTS,DF].join('\n'),
};
// Only the marks the scripts above print are read; an error code is kept only when it is one of ours.
const FLAGS=['dir','writable','rsync','exists','readable'];
export function parseMarks(text){
 const out={snapshots:[],errors:[]};
 for(const line of String(text).split('\n')){
  const m=/^HHB (\w+) ?(.*)$/.exec(line.trim());if(!m)continue;const [,k,v]=m;
  if(k==='snap'){if(SNAPSHOT.test(v))out.snapshots.push(v);}
  else if(k==='error'){if(Object.hasOwn(BACKUP_ERRORS,v))out.errors.push(v);}
  else if(k==='df'){const [total,avail]=v.split(' ').map(Number);if(Number.isFinite(total)&&Number.isFinite(avail))out.space={totalBytes:total*1024,availableBytes:avail*1024};}
  else if(k==='owner'){out.owner=JOB_ID.test(v)?v:'other';}
  else if(FLAGS.includes(k)&&(v==='yes'||v==='no'))out[k]=v==='yes';
 }
 out.snapshots.sort();return out;
}

// ---- the runner -------------------------------------------------------------------------------------
// stateDirectory/<job id>/runs.json   {runs: [newest first, ≤ RUN_LIMIT], snapshots: [...], listedAt, space}
// stateDirectory/<job id>/logs/<run id>.log   one run's log, ≤ LOG_LIMIT bytes, written as it happens
// stateDirectory/<job id>/run.lock    {pid, runId, startedAt, timeoutMinutes, child}: one run per job, across
//                                     hub processes too. child = the pid of the rsync/ssh running now
// A run is recorded as "running" when it starts; a hub that stops in the middle (a signal, a crash) leaves that
// record, and recover() marks it "interrupted" at the next start (and stops a child the dead hub left behind).
// protect: {reject, exclude} directories for guardSource (the module passes the keys, the hub's private/ and the
// backup state). sshTimeoutMs: the deadline of short ssh commands (tests shorten it).
export function createBackupRunner({stateDirectory,keysDirectory,tools:given,spawnImpl,stagingDirectory=null,now=()=>new Date(),onRunEnd=null,protect=null,sshTimeoutMs=SSH_TIMEOUT_MS}={}){
 const tools=backupTools(given);
 const running=new Map();
 const guard=protect||{reject:[keysDirectory,stateDirectory,...(stagingDirectory?[stagingDirectory]:[])],exclude:[keysDirectory,stateDirectory,...(stagingDirectory?[stagingDirectory]:[])]};
 const jobDir=id=>path.join(stateDirectory,id);
 const runsFile=id=>path.join(jobDir(id),'runs.json');
 const logFile=(id,runId)=>path.join(jobDir(id),'logs',`${runId}.log`);
 const lockFile=id=>path.join(jobDir(id),'run.lock');
 const stagingRoot=id=>stagingDirectory?path.join(stagingDirectory,id):path.join(stateDirectory,id,'staging');
 const staging=(id,name)=>path.join(stagingRoot(id),name);

 // A missing file is an empty history; a file that is there but cannot be read is an error, never overwritten.
 async function readHistory(id){
  let raw;try{raw=await readFile(runsFile(id),'utf8');}catch(e){if(e.code==='ENOENT')return {runs:[],snapshots:[],listedAt:null,space:null};throw new BackupError('history-unreadable');}
  let doc;try{doc=JSON.parse(raw);}catch{throw new BackupError('history-unreadable');}
  if(!doc||typeof doc!=='object'||!Array.isArray(doc.runs))throw new BackupError('history-unreadable');
  return {runs:doc.runs.filter(r=>r&&typeof r==='object'&&typeof r.id==='string'),snapshots:Array.isArray(doc.snapshots)?doc.snapshots.filter(s=>SNAPSHOT.test(s)):[],listedAt:doc.listedAt??null,space:doc.space??null};
 }
 // For views: an unreadable history reads as empty, with unreadable:true.
 const history=id=>readHistory(id).catch(()=>({runs:[],snapshots:[],listedAt:null,space:null,unreadable:true}));
 // One writer at a time per job, so a run's record and a snapshot listing never overwrite each other.
 const queues=new Map();
 function saveHistory(id,change){
  const next=(queues.get(id)||Promise.resolve()).then(async()=>{
   const doc=await readHistory(id);change(doc);
   const dropped=doc.runs.slice(RUN_LIMIT);doc.runs=doc.runs.slice(0,RUN_LIMIT);
   await mkdir(jobDir(id),{recursive:true,mode:0o700});
   const tmp=`${runsFile(id)}.${process.pid}.tmp`;await writeFile(tmp,JSON.stringify(doc,null,1)+'\n',{mode:0o600});await rename(tmp,runsFile(id));
   for(const r of dropped)await rm(logFile(id,r.id),{force:true});
   return doc;
  });
  queues.set(id,next.catch(()=>{}));return next;
 }
 const recordListing=(id,marks)=>saveHistory(id,doc=>{doc.snapshots=marks.snapshots;doc.listedAt=now().toISOString();if(marks.space)doc.space={...marks.space,at:doc.listedAt};});

 // ---- the lock ----
 const readLock=async id=>{try{return JSON.parse(await readFile(lockFile(id),'utf8'));}catch{return null;}};
 const lockStale=held=>{const at=Date.parse(held?.startedAt||'');const limit=(Number.isInteger(held?.timeoutMinutes)?held.timeoutMinutes:DEFAULT_TIMEOUT_MINUTES)*60000+LOCK_MARGIN_MS;
  return !held||!Number.isInteger(held.pid)||!isAlive(held.pid)||!Number.isFinite(at)||+now()-at>limit;};
 // A child a dead (or stale) hub left behind: stopped, but only when it is still one of our tools.
 async function stopOrphan(held){
  const pid=held?.child;if(!Number.isInteger(pid)||pid<=1||pid===process.pid||!isAlive(pid))return false;
  const ps=await runProcess('ps',['-o','command=','-p',String(pid)],{timeoutMs:5000});
  const cmd=ps.stdout.trim();if(!cmd||!(cmd.includes(tools.rsync)||cmd.includes(tools.ssh)||/(^|\/)(rsync|ssh)(\s|$)/.test(cmd)))return false;
  killGroup(pid,'SIGTERM');for(let i=0;i<20&&isAlive(pid);i++)await new Promise(r=>setTimeout(r,100));if(isAlive(pid))killGroup(pid,'SIGKILL');
  return true;
 }
 async function lock(id,runId,timeoutMinutes){
  await mkdir(jobDir(id),{recursive:true,mode:0o700});
  for(let attempt=0;attempt<2;attempt++){
   try{const h=await open(lockFile(id),'wx',0o600);await h.writeFile(JSON.stringify({pid:process.pid,runId,startedAt:now().toISOString(),timeoutMinutes,child:null}));await h.close();return;}
   catch(e){
    if(e.code!=='EEXIST')throw e;
    const held=await readLock(id);
    if(!lockStale(held))fail('locked');
    await stopOrphan(held);await unlink(lockFile(id)).catch(()=>{});
   }
  }
  fail('locked');
 }
 const unlock=id=>unlink(lockFile(id)).catch(()=>{});
 const noteChild=async(id,pid)=>{const held=await readLock(id);if(held&&held.pid===process.pid)await writeFile(lockFile(id),JSON.stringify({...held,child:pid}),{mode:0o600}).catch(()=>{});};

 // ---- one bounded log per run, on disk as it is written ----
 function createLog(file){
  let text='',cut=false,fd=null;
  try{fd=openSync(file,'w',0o600);}catch{}
  const put=s=>{text+=s;if(fd!==null)try{writeSync(fd,s);}catch{}};
  const add=s=>{if(cut)return;const room=LOG_LIMIT-Buffer.byteLength(text);if(Buffer.byteLength(s)<=room){put(s);return;}put(s.slice(0,Math.max(0,room-80))+'\n… log truncated (limit reached) …\n');cut=true;};
  return {line:s=>add(`[${now().toISOString()}] ${s}\n`),raw:add,text:()=>text,close:()=>{if(fd!==null){try{closeSync(fd);}catch{}fd=null;}}};
 }

 // ---- ssh helpers bound to one job ----
 function remote(job,f,alias,script,{signal,log,timeoutMs=sshTimeoutMs,onSpawn}={}){
  return runProcess(tools.ssh,['-F',f.config,'-T',alias,`sh -c ${q(script)}`],{timeoutMs,signal,spawnImpl,onSpawn,onOutput:log?s=>{const rest=s.split('\n').filter(l=>!l.startsWith('HHB ')).join('\n');if(rest.trim())log.raw(rest.endsWith('\n')?rest:rest+'\n');}:null});
 }
 const sshFailure=r=>{const code=classifySsh(r);if(code)fail(code);};

 // A connection test for one part of the job: the host key first, then what can be checked over SSH.
 // → {part, index, state: 'trust' | 'changed' | 'ok' | 'problem', hostKeys?, pinned?, checks: [{id, ok, value?}], error?}
 async function test(job,{part,index=0}){
  if(running.has(job.id))fail('busy');
  const h=part==='target'?job.target:job.sources[index];
  if(!h)fail('invalid','nothing to test');
  if(part==='source'&&h.kind==='local')return testLocal(h,index);
  const keys=await scanHostKeys(h,{tools,spawnImpl});
  const state=keyState(h.hostKey,keys),shown=keys.map(({type,fingerprint})=>({type,fingerprint}));
  if(state==='unpinned')return {part,index,state:'trust',hostKeys:shown,checks:[],error:'host-key-unknown'};
  if(state==='changed')return {part,index,state:'changed',hostKeys:shown,pinned:{type:h.hostKey.type,fingerprint:h.hostKey.fingerprint},checks:[],error:'host-key-changed'};
  const f=await writeSshFiles(job,keysDirectory);
  const alias=part==='target'?ALIAS.target:ALIAS.source(index);
  const r=await remote(job,f,alias,part==='target'?scripts.checkTarget(h.path):scripts.checkSource(h.path));
  const code=classifySsh(r);
  if(code)return {part,index,state:'problem',checks:[{id:'ssh',ok:false}],error:code,pinned:{type:h.hostKey.type,fingerprint:h.hostKey.fingerprint}};
  const m=parseMarks(r.stdout),checks=[{id:'ssh',ok:true}];let error=null;
  if(part==='target'){
   checks.push({id:'dir',ok:m.dir===true},...(m.dir?[{id:'writable',ok:m.writable===true},{id:'rsync',ok:m.rsync===true}]:[]));
   if(m.owner)checks.push({id:'owner',ok:m.owner===job.id});
   if(m.space)checks.push({id:'space',ok:true,value:m.space});
   error=m.dir!==true?'dest-missing':m.writable!==true?'dest-readonly':m.rsync!==true?'no-remote-rsync':m.owner&&m.owner!==job.id?'dest-owned':null;
   if(!error)await recordListing(job.id,m);
  }else{
   checks.push({id:'exists',ok:m.exists===true},...(m.exists?[{id:'dir',ok:m.dir===true},{id:'readable',ok:m.readable===true},{id:'rsync',ok:m.rsync===true}]:[]));
   error=m.exists!==true?'source-missing':m.dir!==true?'source-not-dir':m.readable!==true?'source-unreadable':m.rsync!==true?'no-remote-rsync':null;
  }
  if(r.code!==0&&!error)error=r.code===127||/not found/i.test(r.stderr)?'no-shell':'ssh';
  return {part,index,state:error?'problem':'ok',checks,error,pinned:{type:h.hostKey.type,fingerprint:h.hostKey.fingerprint},...(m.snapshots.length?{snapshots:m.snapshots.length}:{})};
 }
 async function testLocal(s,index){
  const p=expandHome(s.path),checks=[];let error=null;
  try{await guardSource(p,guard);}catch(e){return {part:'source',index,state:'problem',checks:[{id:'protected',ok:false}],error:e.code||'source-protected'};}
  try{const st=await stat(p);checks.push({id:'exists',ok:true},{id:'dir',ok:st.isDirectory()});
   try{await access(p,FS.R_OK);checks.push({id:'readable',ok:true});}catch{checks.push({id:'readable',ok:false});error='source-unreadable';}
  }catch{checks.push({id:'exists',ok:false});error='source-missing';}
  return {part:'source',index,state:error?'problem':'ok',checks,error};
 }

 // ---- a run ----
 async function execute(job,entry){
  const {log,controller:ctl}=entry,signal=ctl.signal,stamp=entry.snapshot,dest=job.target.path,long=job.timeoutMinutes*60000;
  const deadline=setTimeout(()=>ctl.abort('timeout'),long);deadline.unref?.();
  const record=entry.record;
  const warnings=new Set();
  const step=(name,message)=>{entry.step=name;log.line(message);};
  const onSpawn=pid=>{noteChild(job.id,pid);};
  try{
   step('prepare',`Job ${job.id} (${job.name}), trigger ${entry.trigger}; snapshot ${stamp}.`);
   const f=await writeSshFiles(job,keysDirectory);
   noSpace(f.config,tools.ssh);
   // Local sources are checked before anything is sent: never the keys or the backup state, and those
   // directories excluded when a source contains them.
   const guards=new Map();
   for(const s of job.sources)if(s.kind==='local')guards.set(s.name,await guardSource(expandHome(s.path),guard));
   const e=`${tools.ssh} -F ${f.config}`;
   const prep=await remote(job,f,ALIAS.target,scripts.prepare(dest,stamp,job.sources.map(s=>s.name),job.id),{signal,log,timeoutMs:long,onSpawn});
   sshFailure(prep);
   const marks=parseMarks(prep.stdout);
   if(marks.errors.length)fail(marks.errors[0]);
   if(prep.code!==0)fail('ssh');
   const previous=marks.snapshots.filter(s=>s<stamp).at(-1)||null;
   log.line(previous?`Previous snapshot: ${previous} (unchanged files become hard links into it).`:'No previous snapshot: this one is a full copy.');
   const base=['-a','--delete','--numeric-ids','--stats',`--timeout=${RSYNC_IO_TIMEOUT_S}`,'-e',e,...job.excludes.map(x=>`--exclude=${x}`)];
   const rsync=async(args,what)=>{
    log.line(`rsync ${what}`);
    const r=await runProcess(tools.rsync,args,{timeoutMs:long,signal,spawnImpl,onSpawn,onOutput:s=>log.raw(s)});
    if(rsyncResult(r)==='warning'){warnings.add('partial');log.line(`rsync finished with code ${r.code}: some files could not be read or vanished; the snapshot is kept.`);}
    return parseStats(r.stdout);
   };
   for(const [i,s] of job.sources.entries()){
    if(signal.aborted)break;
    step(`source:${s.name}`,`Source ${s.name}: ${s.kind==='local'?s.path:`${s.user}@${s.host}:${s.path}`}`);
    let from,extra=[];
    if(s.kind==='ssh'){
     const dir=staging(job.id,s.name);await mkdir(dir,{recursive:true,mode:0o700});
     await rsync([...base,`${ALIAS.source(i)}:${s.path==='/'?'/':s.path+'/'}`,dir+'/'],`pull ${s.name} into the staging copy on the hub`);
     from=dir+'/';
    }else{
     const p=expandHome(s.path);let st;try{st=await stat(p);}catch{fail('source-missing');}
     from=st.isDirectory()?p.replace(/\/?$/,'/'):p;extra=st.isDirectory()?guards.get(s.name).excludes:[];
     for(const x of extra)log.line(`Left out of ${s.name}: ${x.slice(10)} (the hub's keys or state).`);
    }
    const link=previous?[`--link-dest=${dest}/${previous}/${s.name}`]:[];
    const stats=await rsync([...base,...extra,...link,from,`${ALIAS.target}:${dest}/.in-progress-${stamp}/${s.name}/`],`push ${s.name} to the target`);
    record.sources.push({name:s.name,stats});record.stats=addStats(record.stats,stats);
    // Only the source's own directory came across: nothing to back up, or it was not mounted. Kept, not trusted.
    if(Number.isFinite(stats.files)&&stats.files<=1){warnings.add('source-empty');log.line(`Source ${s.name} was empty.`);}
   }
   if(signal.aborted)fail(signal.reason==='timeout'?'timeout':signal.reason==='shutdown'?'interrupted':'cancelled');
   step('finalize','Copies complete: naming the snapshot.');
   const seal=await remote(job,f,ALIAS.target,scripts.seal(dest,stamp,job.id),{log,timeoutMs:long,onSpawn});
   sshFailure(seal);
   const sealed=parseMarks(seal.stdout);
   if(sealed.errors.length)fail(sealed.errors[0]);
   if(seal.code!==0)fail('ssh',`seal exit ${seal.code}`);
   await recordListing(job.id,sealed);
   record.snapshot=stamp;record.result='ok';
   // Retention: after a fully clean run only, never this run's snapshot, and not at all when the target holds a
   // snapshot named later than this one (a clock that went back): the newest name is not this run's then.
   if(sealed.snapshots.some(s=>s>stamp))warnings.add('newer-snapshot');
   const prune=warnings.size?[]:pruneList(sealed.snapshots,job.retention,now(),{keep:[stamp]});
   if(prune.length){
    step('prune',`Retention removes: ${prune.join(', ')}`);
    try{
     const pr=await remote(job,f,ALIAS.target,scripts.prune(dest,prune,job.id),{log,timeoutMs:long,onSpawn});
     const pm=parseMarks(pr.stdout);
     if(classifySsh(pr)||pr.code!==0)throw new Error(pm.errors[0]||classifySsh(pr)||`exit ${pr.code}`);
     await recordListing(job.id,pm);record.pruned=prune.filter(p=>!pm.snapshots.includes(p));
    }catch(err){warnings.add('prune-failed');log.line(`Retention failed (${err.message}); the snapshot is kept, older ones stay until the next run.`);}
   }else log.line(warnings.size?'Retention skipped: the run had a warning.':'Retention removes nothing.');
   // A staging copy of a source that is no longer in the job is removed after a good run.
   try{const keep=new Set(job.sources.filter(s=>s.kind==='ssh').map(s=>s.name));for(const name of await readdir(stagingRoot(job.id)).catch(()=>[]))if(!keep.has(name)){await rm(staging(job.id,name),{recursive:true,force:true});log.line(`Removed the staging copy of ${name}, no longer a source.`);}}catch{}
   if(warnings.size){record.result='warning';record.warnings=[...warnings];}
   log.line(`Done: ${record.result}.`);
  }catch(err){
   const reason=signal.aborted?signal.reason:null;
   const code=reason==='timeout'?'timeout':reason==='shutdown'?'interrupted':reason?'cancelled':err instanceof BackupError?err.code:'unavailable';
   record.result=code==='cancelled'?'cancelled':code==='interrupted'?'interrupted':'failed';record.error=code;
   log.line(`Stopped: ${code}${err?.detail?` (${err.detail})`:''}. The unfinished snapshot is removed by the next run.`);
  }finally{
   clearTimeout(deadline);
   const end=now();record.finishedAt=end.toISOString();record.durationMs=Math.max(0,+end-Date.parse(record.startedAt));
   log.close();
   await saveHistory(job.id,doc=>{doc.runs=[record,...doc.runs.filter(r=>r.id!==record.id)];}).catch(()=>{});
  }
  return record;
 }

 async function start(job,{trigger='manual',by=null}={}){
  if(running.has(job.id))fail('busy');
  if(!complete(job))fail('incomplete');
  const startedAt=now(),h=await readHistory(job.id);
  // A snapshot name is the start second; two runs in one second get the next free one.
  let at=+startedAt;const taken=new Set([...h.snapshots,...h.runs.map(r=>r.snapshot).filter(Boolean)]);
  while(taken.has(snapshotName(at)))at+=1000;
  const snapshot=snapshotName(at),runId=`r-${snapshot}`;
  await lock(job.id,runId,job.timeoutMinutes);
  const record={id:runId,trigger,by,startedAt:startedAt.toISOString(),finishedAt:null,durationMs:null,result:'running',error:null,
   snapshot:null,stats:{files:null,filesTransferred:null,totalBytes:null,transferredBytes:null,sentBytes:null},sources:[],pruned:[]};
  try{
   await saveHistory(job.id,doc=>{doc.runs=[record,...doc.runs];});
   await mkdir(path.dirname(logFile(job.id,runId)),{recursive:true,mode:0o700});
  }catch(e){await unlock(job.id);throw e;}
  const entry={runId,jobId:job.id,snapshot,trigger,by,startedAt:record.startedAt,step:'prepare',controller:new AbortController(),log:createLog(logFile(job.id,runId)),record:{...record}};
  running.set(job.id,entry);
  entry.done=execute(job,entry).finally(async()=>{running.delete(job.id);await unlock(job.id);}).then(r=>{try{onRunEnd?.(job,r);}catch{}return r;});
  return {runId,snapshot,startedAt:entry.startedAt};
 }
 // At start: runs a stopped hub left "running" become "interrupted", and a stale lock goes (with its child).
 async function recover(ids){
  const fixed=[];
  for(const id of ids){
   if(running.has(id))continue;
   const held=await readLock(id);
   if(held){if(!lockStale(held))continue;await stopOrphan(held);await unlock(id);}
   let h;try{h=await readHistory(id);}catch{continue;}
   const open=h.runs.filter(r=>r.result==='running');if(!open.length)continue;
   const at=now().toISOString();
   await saveHistory(id,doc=>{for(const r of doc.runs)if(r.result==='running'){r.result='interrupted';r.error='interrupted';r.finishedAt=r.finishedAt||at;}}).catch(()=>{});
   for(const r of open)await writeFile(logFile(id,r.id),`[${at}] Interrupted: the hub stopped while this run was in progress.\n`,{flag:'a',mode:0o600}).catch(()=>{});
   fixed.push(id);
  }
  return fixed;
 }
 function cancel(id){const e=running.get(id);if(!e)fail('not-running');e.controller.abort('cancelled');return {runId:e.runId};}
 async function deleteSnapshot(job,name){
  if(!SNAPSHOT.test(name))fail('invalid','not a snapshot name');
  if(!complete(job))fail('incomplete');
  if(running.has(job.id))fail('busy');
  const f=await writeSshFiles(job,keysDirectory);
  const r=await remote(job,f,ALIAS.target,scripts.remove(job.target.path,name,job.id),{timeoutMs:job.timeoutMinutes*60000});
  sshFailure(r);
  const m=parseMarks(r.stdout);
  if(m.errors.includes('dest-owned'))fail('dest-owned');
  if(m.errors.includes('snapshot-missing')){await recordListing(job.id,m);fail('snapshot-missing');}
  if(r.code!==0)fail('ssh');
  await recordListing(job.id,m);
  await saveHistory(job.id,doc=>{for(const run of doc.runs)if(run.snapshot===name)run.deletedAt=now().toISOString();});
  return {snapshots:m.snapshots,space:m.space??null};
 }
 async function refresh(job){
  if(running.has(job.id))fail('busy');
  const f=await writeSshFiles(job,keysDirectory);
  const r=await remote(job,f,ALIAS.target,scripts.list(job.target.path));sshFailure(r);if(r.code!==0)fail('dest-missing');
  const m=parseMarks(r.stdout);await recordListing(job.id,m);return {snapshots:m.snapshots,space:m.space??null};
 }
 async function readLog(id,runId){
  if(!/^r-\d{4}-\d{2}-\d{2}T\d{6}Z$/.test(runId))return null;
  const live=running.get(id);if(live?.runId===runId)return live.log.text();
  try{return await readFile(logFile(id,runId),'utf8');}catch{return null;}
 }
 async function forget(id){if(running.has(id))fail('busy');await rm(jobDir(id),{recursive:true,force:true});if(stagingDirectory)await rm(path.join(stagingDirectory,id),{recursive:true,force:true});}
 const status=id=>{const e=running.get(id);return e?{runId:e.runId,snapshot:e.snapshot,startedAt:e.startedAt,step:e.step,trigger:e.trigger}:null;};
 // reason: 'cancelled' (the default) or 'shutdown' (the hub is stopping: the runs end as "interrupted").
 const stopAll=(reason='cancelled')=>{for(const e of running.values())e.controller.abort(reason);return Promise.all([...running.values()].map(e=>e.done));};
 return {tools,guard,start,cancel,test,deleteSnapshot,refresh,history,readHistory,readLog,forget,status,recover,
  wait:id=>running.get(id)?.done??Promise.resolve(null),running:()=>[...running.keys()],
  cancelAll:()=>stopAll('cancelled'),shutdown:()=>stopAll('shutdown')};
}

// ---- the scheduler ------------------------------------------------------------------------------------
// One timer for all jobs: it wakes at the soonest next run (at most an hour ahead, then it looks again, so a
// changed clock or an edited job never leaves it waiting on a stale time), starts whatever is due, re-arms.
// Each job has a cursor: the instant its schedule is counted from (the start, or the slot it last fired for).
// A re-arm never moves a cursor, so a slot that came due while a re-arm was in flight still fires; changing a
// job's schedule resets its cursor to now. Every arm has a generation number: only the newest arm sets a timer,
// so concurrent re-arms can never leave two timer chains.
// At start it catches up once for each job whose newest scheduled slot passed while the hub was not running
// (missedAtStart in backup-config.mjs), CATCH_UP_DELAY_MS after the start. While the integration is off it
// starts nothing and catches nothing up. All times are in the site's time zone.
export function createBackupScheduler({jobs,runner,timeZone=()=>undefined,enabled=()=>true,now=()=>new Date(),catchUpDelayMs=CATCH_UP_DELAY_MS,setTimer=setTimeout,clearTimer=clearTimeout,log=()=>{}}={}){
 let timer=null,catchUp=null,planned=new Map(),started=false,generation=0;
 const cursors=new Map();// job id → {from: ms, schedule: JSON}
 const fire=(job,trigger)=>runner.start(job,{trigger}).catch(e=>log(`backup ${job.id}: ${trigger} run not started (${e.code||e.message})`));
 const cursorOf=(job,at)=>{const key=JSON.stringify(job.schedule),c=cursors.get(job.id);if(!c||c.schedule!==key){const fresh={from:+at,schedule:key};cursors.set(job.id,fresh);return fresh;}return c;};
 async function arm(){
  const gen=++generation;
  const list=started?await jobs():[];
  if(gen!==generation)return;// a newer arm is on its way
  if(timer)clearTimer(timer);timer=null;planned=new Map();
  if(!started)return;
  const at=now();let soonest=null;
  for(const job of list){
   if(!job.enabled||!complete(job)){cursors.delete(job.id);continue;}
   const next=nextRun(job.schedule,cursorOf(job,at).from,timeZone());if(!next)continue;
   planned.set(job.id,next);if(!soonest||next<soonest)soonest=next;
  }
  for(const id of [...cursors.keys()])if(!list.some(j=>j.id===id))cursors.delete(id);
  const wait=soonest?Math.min(Math.max(0,+soonest-+at),MAX_TIMER_MS):MAX_TIMER_MS;
  timer=setTimer(tick,wait);timer?.unref?.();
 }
 async function tick(){
  timer=null;
  const at=+now()+500;
  for(const job of await jobs()){
   const due=planned.get(job.id);if(!due||+due>at||!job.enabled||!complete(job))continue;
   cursors.set(job.id,{from:+due,schedule:JSON.stringify(job.schedule)});// counted as handled, on or off
   if(enabled())await fire(job,'schedule');
  }
  await arm();
 }
 return {
  async start(){
   started=true;
   if(enabled()){
    const due=[];
    for(const job of await jobs()){const h=await runner.history(job.id);if(missedAtStart(job,h.runs[0]?.startedAt,now(),timeZone()))due.push(job.id);}
    if(due.length){catchUp=setTimer(async()=>{catchUp=null;if(!enabled())return;for(const job of await jobs())if(due.includes(job.id)&&job.enabled&&complete(job))await fire(job,'catch-up');},catchUpDelayMs);catchUp?.unref?.();}
   }
   await arm();
  },
  stop(){started=false;generation++;if(timer)clearTimer(timer);if(catchUp)clearTimer(catchUp);timer=catchUp=null;planned=new Map();cursors.clear();},
  arm,tick,
  next:id=>planned.get(id)||null,
 };
}
