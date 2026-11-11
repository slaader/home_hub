// Windows telemetry without an agent: the hub logs in to the machine with key-only SSH and runs one fixed,
// read-only PowerShell script that reads CIM classes (performance counters and inventory). Nothing is installed
// or changed on the machine. The hub may run on Linux, macOS or Windows; it needs the OpenSSH client tools
// (ssh, and ssh-keyscan for fetching a host key) on its own server, nothing else.
//
// Two kinds of connection:
//   managed  the normal one. Host, port and Windows user are set in the web UI; the key, the verified host key
//            and an empty ssh configuration are the hub's own files (server/windows-ssh.mjs → the key store).
//            ssh is told to ignore everything of the account it runs as: -F <empty file> (no ~/.ssh/config and
//            no system-wide ssh_config), -i <its key> with IdentitiesOnly and IdentityAgent=none (no agent, no
//            other keys), UserKnownHostsFile=<this connection's verified key> and GlobalKnownHostsFile=<empty>,
//            HostKeyAlias (the known_hosts entry does not depend on how the host is spelled), explicit -l and -p.
//   alias    the older one, kept so a configuration made before keeps working until its owner converts it:
//            an SSH alias from ~/.ssh/config of the account the hub runs as (or user@host), with that account's
//            keys and known_hosts. Nothing new is set up this way; the web UI offers to convert it.
//
// Security rules kept here, in one place:
//   - every value that reaches the ssh command line is validated strictly (validSshTarget, validSshHost,
//     validWindowsUser, validSshPort, the key store's own paths) and the host is passed as its own argument
//     after "--", so it can never be read as an ssh option
//   - ssh is spawned with an argument array (no shell), stdin closed, BatchMode (never a password prompt),
//     StrictHostKeyChecking=yes (an unknown or changed host key is refused, never accepted), no forwarding,
//     no multiplexing, a connect timeout and a hard kill after WINDOWS_TIMEOUT_MS, stdout and stderr bounded;
//     the environment that could make ssh ask someone (SSH_ASKPASS, DISPLAY) or reach an agent is removed
//   - the remote command is the constant below (-EncodedCommand, so no quoting is involved); nothing the
//     browser sends ever reaches the command line except the validated host, port, user (or alias)
//   - stderr is only classified into an error code; it is never logged or returned
//
// Counters: CPU, disk and network come from Win32_PerfRawData_* (cumulative raw values with their own
// 100 ns timestamps). One poll is one snapshot; a reading is the difference between two snapshots, so it is
// the true average over the interval between them (span), timestamped at its end. Nothing between polls is
// invented: the first snapshot after a start, a reconnect or a long gap yields memory and volumes only.
// GPU utilisation follows Task Manager: per engine (luid + physical index + engine), the running time of every
// process on it is summed, divided by the elapsed time and capped at 100 %; a GPU is as busy as its busiest
// engine; the machine's GPU figure is its busiest GPU. Engines of different processes are never added up
// across engines, so the figure cannot exceed 100 %. Sensors (temperatures, fans, power) are not read:
// Windows exposes none reliably without vendor drivers, so those stay null.
// Numbers are read locale-independently: the script sets the invariant culture and sends counters as decimal
// strings (they exceed 2^53), parsed here as BigInt.
import {spawn} from 'node:child_process';
import path from 'node:path';
import {createSnapshotPoller,minuteRow,MIN_INTERVAL_MS} from './telemetry-poller.mjs';

export const WINDOWS_PROVIDER='windows';
export const WINDOWS_ADAPTER_NAME='Windows (SSH)';
// Polls are never closer than this; the overview's Thermo interval (15/30/60 s) only makes them slower.
export const WINDOWS_MIN_INTERVAL_MS=MIN_INTERVAL_MS;
export const WINDOWS_TIMEOUT_MS=25000;
const MAX_STDOUT=1_048_576,MAX_STDERR=16_384,MARK='HHWIN1 ';
// A reading that would average over more than this (a missed poll, the machine slept) is not made: the gap stays a gap.
export const WINDOWS_MAX_SPAN_SECONDS=300;

// An SSH alias (Host entry in ~/.ssh/config) or user@host. Letters, digits, dot, dash, underscore; the first
// character of either part is a letter, digit (or _ for a user), so nothing can start with "-" and be taken
// for an option; no spaces, no %-tokens, no shell characters, no port syntax.
const TARGET=/^(?:([A-Za-z0-9_][A-Za-z0-9._-]{0,63})@)?([A-Za-z0-9](?:[A-Za-z0-9._-]{0,251}[A-Za-z0-9])?)$/;
export const validSshTarget=v=>typeof v==='string'&&v.length<=320&&TARGET.test(v)&&!v.includes('..');

// --- managed connections: what may be set in the web UI ----------------------------------------------------
// Host: a host name or an IPv4 address (the same rule as a machine's hostname); it starts with a letter or digit.
const HOST=/^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}))*$/,IPV4=/^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
export const validSshHost=h=>typeof h==='string'&&(IPV4.test(h)||HOST.test(h));
export const validSshPort=p=>Number.isSafeInteger(p)&&p>=1&&p<=65535;
// A Windows account: "name", "DOMAIN\\name" or "name@corp.example.lan". Letters (any script), digits, space, dot,
// underscore and dash inside a name; it starts with a letter, digit or underscore and does not end in a space or
// dot. Never a quote, %, $, ` or any other character ssh or PowerShell would read as syntax. public/windows-setup.js
// has the same rule (tests keep them equal).
const NAME='[\\p{L}\\p{N}_](?:[\\p{L}\\p{N} ._-]{0,62}[\\p{L}\\p{N}_-])?';
export const WINDOWS_USER=new RegExp(`^(?:${NAME}\\\\)?${NAME}(?:@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?)?$`,'u');
export const validWindowsUser=u=>typeof u==='string'&&u.length<=128&&WINDOWS_USER.test(u)&&!/\s\s/.test(u);
// Ids the server makes (128 random bits each): a key in the store, a connection's known_hosts, a set-up draft.
export const KEY_ID=/^k[a-f0-9]{32}$/,CONN_ID=/^c[a-f0-9]{32}$/,DRAFT_ID=/^d[a-f0-9]{32}$/;
const HOST_KEY_TYPE=/^(ssh-ed25519|ecdsa-sha2-nistp(256|384|521)|ssh-rsa)$/,B64=/^[A-Za-z0-9+/]{16,4096}={0,2}$/,FP=/^SHA256:[A-Za-z0-9+/]{43}$/;
// A stored managed connection (state/home/windows-hosts.json; no private key in it, only its id).
export const validManaged=m=>Boolean(m&&typeof m==='object'&&m.mode==='managed'&&validSshHost(m.host)&&validSshPort(m.port)&&validWindowsUser(m.user)&&
 KEY_ID.test(m.keyId||'')&&CONN_ID.test(m.connId||'')&&m.hostKey&&HOST_KEY_TYPE.test(m.hostKey.type||'')&&B64.test(m.hostKey.key||'')&&FP.test(m.hostKey.fingerprint||'')&&
 FP.test(m.keyFingerprint||''));
// What a managed connection looks like to a person: alice@pc.example.lan, with :port when it is not 22.
export const managedLabel=m=>`${m.user}@${m.host}${m.port!==22?`:${m.port}`:''}`;

// The collector, read-only. Kept compact: -EncodedCommand doubles its size (UTF-16) and base64 adds a third,
// and Windows' default SSH shell (cmd.exe) takes at most 8191 characters per command line.
export const COLLECTOR_SCRIPT=[
 "$ProgressPreference='SilentlyContinue';$ErrorActionPreference='SilentlyContinue'",
 '[Threading.Thread]::CurrentThread.CurrentCulture=[Globalization.CultureInfo]::InvariantCulture',
 'function Q($c,$p,$f){$a=@{ClassName=$c;Property=$p};if($f){$a.Filter=$f};@(Get-CimInstance @a)}',
 'function S($x){if($x -eq $null){$null}else{[string]$x}}',
 '$o=[ordered]@{v=1;t=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()}',
 '$s=Q Win32_OperatingSystem Caption,Version,TotalVisibleMemorySize,LastBootUpTime|select -First 1',
 '$o.os=@((S $s.Caption),(S $s.Version),(S $s.TotalVisibleMemorySize),$(if($s.LastBootUpTime){([DateTimeOffset]$s.LastBootUpTime).ToUnixTimeSeconds()}))',
 '$o.cpuName=@(Q Win32_Processor Name|%{S $_.Name})',
 '$o.cpu=@(Q Win32_PerfRawData_PerfOS_Processor Name,PercentProcessorTime,Timestamp_Sys100NS|%{,@((S $_.Name),(S $_.PercentProcessorTime),(S $_.Timestamp_Sys100NS))})',
 '$m=Q Win32_PerfRawData_PerfOS_Memory AvailableBytes|select -First 1',
 '$o.avail=S $m.AvailableBytes',
 '$o.page=@(Q Win32_PageFileUsage CurrentUsage|%{S $_.CurrentUsage})',
 "$o.vol=@(Q Win32_LogicalDisk DeviceID,VolumeName,FileSystem,Size,FreeSpace 'DriveType=3'|%{,@((S $_.DeviceID),(S $_.VolumeName),(S $_.FileSystem),(S $_.Size),(S $_.FreeSpace))})",
 "$o.disk=@(Q Win32_PerfRawData_PerfDisk_PhysicalDisk DiskReadBytesPersec,DiskWriteBytesPersec,Timestamp_Sys100NS \"Name='_Total'\"|%{,@((S $_.DiskReadBytesPersec),(S $_.DiskWriteBytesPersec),(S $_.Timestamp_Sys100NS))})",
 '$o.net=@(Q Win32_PerfRawData_Tcpip_NetworkInterface Name,BytesReceivedPersec,BytesSentPersec,Timestamp_Sys100NS|%{,@((S $_.Name),(S $_.BytesReceivedPersec),(S $_.BytesSentPersec),(S $_.Timestamp_Sys100NS))})',
 '$g=Q Win32_PerfRawData_GPUPerformanceCounters_GPUEngine Name,RunningTime,Timestamp_Sys100NS',
 '$o.gts=S ($g|select -First 1).Timestamp_Sys100NS',
 '$o.gpu=@($g|?{$_.RunningTime -gt 0}|%{,@((S $_.Name),(S $_.RunningTime))})',
 '$o.gmem=@(Q Win32_PerfRawData_GPUPerformanceCounters_GPUAdapterMemory Name,DedicatedUsage,SharedUsage|%{,@((S $_.Name),(S $_.DedicatedUsage),(S $_.SharedUsage))})',
 "$o.adapters=@(Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*'|?{$_.DriverDesc}|%{$q=$_.'HardwareInformation.qwMemorySize';if($q -is [byte[]]){$q=[BitConverter]::ToUInt64($q,0)};,@((S $_.DriverDesc),(S $q))})",
 "'HHWIN1 '+($o|ConvertTo-Json -Compress -Depth 4)"].join('\n');
export const encodedCommand=(script=COLLECTOR_SCRIPT)=>Buffer.from(script,'utf16le').toString('base64');
export const REMOTE_COMMAND=`powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encodedCommand()}`;

// Forced on every alias connection, over whatever ~/.ssh/config says for the alias.
export const SSH_OPTIONS=Object.freeze(['BatchMode=yes','StrictHostKeyChecking=yes','PasswordAuthentication=no','KbdInteractiveAuthentication=no',
 'ConnectTimeout=8','ServerAliveInterval=5','ServerAliveCountMax=2','ForwardAgent=no','ForwardX11=no','ClearAllForwardings=yes',
 'PermitLocalCommand=no','ControlMaster=no','ControlPath=none','UpdateHostKeys=no','RequestTTY=no']);
// Forced on every managed connection. With -F <empty file> nothing else is read, so these are the whole
// configuration: only the hub's key, only the verified host key, never a password, an agent, a proxy or a prompt.
// Each option exists in OpenSSH 7.7 and later (the oldest client Windows 10 ships), so no client refuses one.
export const MANAGED_OPTIONS=Object.freeze(['BatchMode=yes','StrictHostKeyChecking=yes','CheckHostIP=no','UpdateHostKeys=no','VerifyHostKeyDNS=no',
 'IdentitiesOnly=yes','IdentityAgent=none','AddKeysToAgent=no','PubkeyAuthentication=yes','PreferredAuthentications=publickey',
 'PasswordAuthentication=no','KbdInteractiveAuthentication=no','HostbasedAuthentication=no','ProxyCommand=none',
 'ControlMaster=no','ControlPath=none','ForwardAgent=no','ForwardX11=no','ClearAllForwardings=yes','PermitLocalCommand=no','RequestTTY=no',
 'ConnectTimeout=8','ServerAliveInterval=5','ServerAliveCountMax=2']);
const fail=(code,detail)=>{throw Object.assign(new Error(code),detail?{detail}:{});};
export function sshArgs(target,command=REMOTE_COMMAND){
 if(!validSshTarget(target))fail('invalid','windows.target must be an SSH alias from ~/.ssh/config or user@host');
 return ['-T',...SSH_OPTIONS.flatMap(o=>['-o',o]),'--',target,command];
}
// A path of the key store as ssh gets it. ssh expands %-tokens and ${VAR} in identity and known_hosts paths and
// splits option values at spaces, so a path with %, $, a quote or a control character is refused, and option
// values are quoted. On Windows the separators become "/", which ssh reads the same and never takes for an escape.
const SAFE_PATH=p=>typeof p==='string'&&p.length<=1024&&(path.isAbsolute(p)||path.win32.isAbsolute(p))&&!/[%$"\u0000-\u001f\u007f]/.test(p)&&!p.startsWith('~');
export const validStorePath=SAFE_PATH;
// The command line of a managed connection. spec = {host, port, user, keyFile, knownHosts, empty, alias}:
// keyFile, knownHosts and empty (an empty file, both the ssh configuration and the global known_hosts) are the
// key store's files; alias is the known_hosts name of this connection.
// validUser: the account rule of the system at the other end (Windows by default; server/linux-telemetry.mjs passes the POSIX one).
export function managedArgs(spec,{platform=process.platform,command=REMOTE_COMMAND,validUser=validWindowsUser}={}){
 const {host,port,user,keyFile,knownHosts,empty,alias}=spec||{};
 if(!validSshHost(host)||!validSshPort(port)||!validUser(user))fail('invalid');
 if(![keyFile,knownHosts,empty].every(p=>SAFE_PATH(p)&&(platform==='win32'||!p.includes('\\')))||!/^hh-[a-f0-9]{12}$/.test(alias||''))fail('invalid');
 const value=p=>`"${platform==='win32'?p.replace(/\\/g,'/'):p}"`;
 return ['-F',empty,'-T','-i',keyFile,'-l',user,'-p',String(port),...MANAGED_OPTIONS.flatMap(o=>['-o',o]),
  '-o',`UserKnownHostsFile=${value(knownHosts)}`,'-o',`GlobalKnownHostsFile=${value(empty)}`,'-o',`HostKeyAlias=${alias}`,'--',host,command];
}
// `ssh -G` prints the configuration ssh would use for the target, without connecting: shown to the user so
// they can see which host, user and port an alias resolves to.
export const resolveArgs=target=>{if(!validSshTarget(target))fail('invalid');return ['-G','--',target];};

// What ssh must not inherit: anything that would make it ask a person (askpass, a display) or reach an agent.
const DROPPED_ENV=['SSH_AUTH_SOCK','SSH_AGENT_PID','SSH_ASKPASS','SSH_ASKPASS_REQUIRE','DISPLAY','WAYLAND_DISPLAY'];
export const sshEnv=(env=process.env)=>Object.fromEntries(Object.entries(env).filter(([k])=>!DROPPED_ENV.includes(k.toUpperCase())));
// Runs ssh (or another OpenSSH client tool: binary); resolves {code, stdout, stderr, error}.
// error: timeout | too-large | no-ssh (the program is not installed) | spawn | null.
export function runSsh(args,{timeoutMs=WINDOWS_TIMEOUT_MS,spawnImpl=spawn,binary='ssh',maxStdout=MAX_STDOUT,env=sshEnv()}={}){
 return new Promise(resolve=>{
  let child,done=false,overflow=false,size=0,err='';const out=[];
  const finish=r=>{if(done)return;done=true;clearTimeout(timer);resolve(r);};
  const kill=()=>{try{child?.kill('SIGKILL');}catch{}};
  const timer=setTimeout(()=>{kill();finish({code:null,stdout:'',stderr:err,error:'timeout'});},timeoutMs);
  try{child=spawnImpl(binary,args,{stdio:['ignore','pipe','pipe'],shell:false,windowsHide:true,env});}
  catch{return finish({code:null,stdout:'',stderr:'',error:'spawn'});}
  child.stdout?.on('data',c=>{size+=c.length;if(size>maxStdout){overflow=true;kill();return;}out.push(c);});
  child.stderr?.on('data',c=>{if(err.length<MAX_STDERR)err+=String(c).slice(0,MAX_STDERR-err.length);});
  child.on('error',e=>{kill();finish({code:null,stdout:'',stderr:err,error:e?.code==='ENOENT'?'no-ssh':'spawn'});});
  child.on('close',code=>finish(overflow?{code,stdout:'',stderr:err,error:'too-large'}:{code,stdout:Buffer.concat(out).toString('utf8'),stderr:err,error:null}));
 });
}
// What went wrong, as a code the UI explains (WINDOWS_ERRORS below). null = no ssh-level failure.
export function classifySsh({code,stderr='',error=null}){
 if(error)return error;
 const s=String(stderr);
 if(/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key for \S+ has changed|host key mismatch/i.test(s))return 'host-key-changed';
 if(/Host key verification failed|No \S+ host key is known|host key is not known/i.test(s))return 'host-key-unknown';
 if(/UNPROTECTED PRIVATE KEY FILE|bad permissions/i.test(s))return 'key-permissions';
 if(/no such identity|Load key .{0,1100}No such file/i.test(s))return 'key-missing';
 if(/Permission denied|Too many authentication failures/i.test(s))return 'denied';
 if(/Could not resolve hostname|nodename nor servname|Name or service not known|Temporary failure in name resolution|No such host is known|getaddrinfo/i.test(s))return 'unresolved';
 if(/Connection refused/i.test(s))return 'refused';
 if(/timed out/i.test(s))return 'timeout';
 if(/No route to host|Network is unreachable|Host is down|Connection reset|Connection closed by/i.test(s))return 'unreachable';
 if(/Bad configuration option|Unsupported option|bad configuration|Can't open user config|Bad owner or permissions/i.test(s))return 'ssh-config';
 if(code===255)return 'ssh';
 if(/not recognized as (?:an internal or external command|the name of a cmdlet)|CommandNotFound/i.test(s))return 'no-powershell';
 return code===0?null:'powershell';
}

// One sentence per failure code (classifySsh, parse, the check, the key store), in the source language (English in
// public/i18n-en-home.js): what it means and what to do. The SSH error output itself is never shown or logged.
// None of them assumes which system the hub runs on.
export const WINDOWS_ERRORS=Object.freeze({
 'host-key-unknown':'Klíč hostitele Windows není pro tohle spojení ověřený. V Upravit zařízení → Telemetrie načti klíč hostitele, porovnej jeho otisk s tím, který ukáže Windows, a potvrď ho. Home Hub neznámý klíč nikdy nepřijme sám.',
 'host-key-changed':'Klíč hostitele Windows se liší od ověřeného. Windows mohl být přeinstalovaný, ale může jít i o podvržený stroj. Porovnej nový otisk na Windows a ověř ho znovu v Upravit zařízení → Telemetrie; do té doby se Home Hub nepřipojí.',
 denied:'Windows nepřijal klíč Home Hubu. Zkontroluj uživatele Windows a to, že příkaz pro autorizaci klíče proběhl pro tenhle účet (u správce jde klíč do administrators_authorized_keys).',
 unresolved:'Jméno hostitele se ze serveru s Home Hubem nedá přeložit. Zadej IP adresu nebo jméno, které zná tvoje DNS.',
 refused:'Windows odmítl spojení na port SSH. Běží služba OpenSSH Server (sshd), poslouchá na tomhle portu a pouští ji firewall?',
 timeout:'Spojení vypršelo. Stroj může spát nebo být mimo síť, nebo port SSH blokuje firewall.',
 unreachable:'Stroj není v síti k zastižení. To neznamená, že je vypnutý.',
 'ssh-config':'Klient SSH na serveru s Home Hubem odmítl nastavení nebo práva souborů. U spojení spravovaného Home Hubem jde o práva jeho úložiště klíčů; u staršího spojení přes alias o konfiguraci SSH účtu, pod kterým Home Hub běží.',
 ssh:'SSH spojení selhalo z neznámého důvodu. Vyzkoušej spojení znovu; když to trvá, zkontroluj na Windows službu OpenSSH Server.',
 'no-ssh':'Na serveru s Home Hubem chybí klientské nástroje OpenSSH (ssh a ssh-keyscan). Nainstaluj OpenSSH Client: ve Windows volitelná funkce OpenSSH Client, v Linuxu balíček openssh-client (nebo openssh); macOS je má.',
 'no-keyscan':'Na serveru s Home Hubem chybí ssh-keyscan z klientských nástrojů OpenSSH, takže Home Hub nenačte klíč hostitele. Nainstaluj celý OpenSSH Client.',
 'no-host-key':'Windows nevrátil žádný klíč hostitele, který by Home Hub přijal. Běží na tom portu OpenSSH Server?',
 'key-missing':'Soukromý klíč tohoto spojení na serveru s Home Hubem chybí (třeba po obnově zálohy bez něj). Vytvoř nebo naimportuj klíč znovu v Upravit zařízení → Telemetrie.',
 'key-permissions':'Klient SSH odmítl soukromý klíč kvůli jeho právům. Home Hub ukládá klíče čitelné jen pro sebe; zkontroluj, že se práva adresáře se stavem nezměnila (třeba obnovou zálohy).',
 'no-powershell':'Přihlášení prošlo, ale Windows nespustil powershell.exe. Je výchozí shell OpenSSH cmd.exe nebo PowerShell?',
 powershell:'Přihlášení prošlo, ale skript PowerShellu neskončil správně. Zkus to znovu; když to trvá, je možná omezené spouštění PowerShellu.',
 'bad-output':'Windows odpověděl, ale ne očekávanými daty. Je cíl opravdu stroj s Windows?',
 'no-counters':'Windows odpověděl, ale nevrátil čítače výkonu. Standardní účet přidej do skupiny Performance Monitor Users.',
 'too-large':'Odpověď z Windows byla nečekaně velká a byla zahozena.',
 spawn:'Klienta SSH nejde na serveru s Home Hubem spustit.',busy:'Právě běží jiné zkoušky spojení. Zkus to za chvíli.',unavailable:'Telemetrie Windows teď neodpovídá.'});
// --- parsing -------------------------------------------------------------------------------------
const str=(v,n=120)=>typeof v==='string'?v.replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,n):null;
const big=v=>typeof v==='string'&&/^\d{1,20}$/.test(v)?BigInt(v):typeof v==='number'&&Number.isSafeInteger(v)&&v>=0?BigInt(v):null;
const num=v=>{const b=big(v);return b===null||b>BigInt(Number.MAX_SAFE_INTEGER)?null:Number(b);};
const rows=(v,max)=>Array.isArray(v)?v.slice(0,max).filter(Array.isArray):[];
// The script's one line of JSON → a snapshot with BigInt counters. Anything missing is null or empty;
// no marker, or JSON that is not the expected object, is 'bad-output'.
export function parseCollectorOutput(text){
 const line=String(text??'').split(/\r?\n/).filter(l=>l.startsWith(MARK)).at(-1);
 if(!line)fail('bad-output');
 let d;try{d=JSON.parse(line.slice(MARK.length));}catch{fail('bad-output');}
 return snapshotFromData(d);
}
// The collector's data object (from the SSH script's JSON, or built from WinRM's WMI replies by
// server/winrm-telemetry.mjs in the same shape) → a snapshot. One function, so both transports mean the same.
export function snapshotFromData(d){
 if(!d||typeof d!=='object'||Array.isArray(d)||d.v!==1)fail('bad-output');
 const os=Array.isArray(d.os)?d.os:[];
 const kb=num(os[2]);
 return {
  t:Number.isSafeInteger(d.t)?d.t:null,
  os:{caption:str(os[0]),version:str(os[1],40),memTotal:kb!=null?kb*1024:null,bootUnix:Number.isSafeInteger(os[3])?os[3]:null},
  cpuName:(Array.isArray(d.cpuName)?d.cpuName:[]).map(x=>str(x,80)).filter(Boolean).slice(0,8),
  cpu:new Map(rows(d.cpu,257).map(r=>[str(r[0],12),{idle:big(r[1]),ts:big(r[2])}]).filter(([k,v])=>k&&v.idle!==null&&v.ts!==null)),
  avail:num(d.avail),
  swapUsed:Array.isArray(d.page)&&d.page.length?d.page.slice(0,16).reduce((a,x)=>a===null||num(x)===null?null:a+num(x)*1048576,0):null,
  volumes:rows(d.vol,26).map(r=>({mount:str(r[0],8),label:str(r[1],60),fs:str(r[2],16),size:num(r[3]),free:num(r[4])})).filter(v=>v.mount),
  disk:(()=>{const r=rows(d.disk,1)[0];if(!r)return null;const x={read:big(r[0]),write:big(r[1]),ts:big(r[2])};return x.ts===null?null:x;})(),
  net:rows(d.net,32).map(r=>({name:str(r[0],80),rx:big(r[1]),tx:big(r[2]),ts:big(r[3])})).filter(n=>n.name&&n.ts!==null),
  gpuTs:big(d.gts),
  gpu:new Map(rows(d.gpu,8000).map(r=>[str(r[0],160),big(r[1])]).filter(([k,v])=>k&&v!==null)),
  gmem:rows(d.gmem,16).map(r=>({id:str(r[0],80),dedicated:num(r[1]),shared:num(r[2])})).filter(g=>g.id),
  adapters:rows(d.adapters,8).map(r=>({name:str(r[0],80),memTotal:num(r[1])})).filter(a=>a.name)};
}

// --- readings ------------------------------------------------------------------------------------
const ENGINE=/^pid_\d+_(luid_0x[0-9a-f]+_0x[0-9a-f]+_phys_\d+)_eng_(\d+)_engtype_(.{0,60})$/i;
const pct=(busy,elapsed)=>elapsed>0?Math.max(0,Math.min(100,busy/elapsed*100)):null;
const round=(v,d=1)=>v==null?null:Math.round(v*10**d)/10**d;
const dt=(a,b)=>a!=null&&b!=null&&b>a?Number(b-a):null;// 100 ns units
const rise=(a,b)=>a!=null&&b!=null&&b>=a?Number(b-a):null;
// GPU devices: utilisation per engine, then the busiest engine per device. prev/cur are snapshots.
export function gpuDevices(prev,cur){
 const elapsed=dt(prev?.gpuTs,cur.gpuTs),busy=new Map(),engineOf=new Map();
 if(elapsed){
  for(const [name,running] of cur.gpu){
   const m=ENGINE.exec(name);if(!m)continue;
   const before=prev.gpu.get(name);
   // An instance seen for the first time started after the previous snapshot (that one listed every active
   // instance), so all of its running time falls into this interval. A counter that went back is a new instance.
   let d=before==null?running:running-before;if(d<0n)d=running;
   const key=`${m[1]}|${m[2]}`;busy.set(key,(busy.get(key)||0)+Number(d));engineOf.set(key,m[3]);
  }
 }
 const devices=new Map();
 for(const g of cur.gmem)devices.set(g.id,{id:g.id,util:elapsed?0:null,engine:null,memUsed:g.dedicated,memShared:g.shared});
 for(const [key,b] of busy){const id=key.split('|')[0];const dev=devices.get(id)||{id,util:0,engine:null,memUsed:null,memShared:null};
  const u=pct(b,elapsed);if(u!=null&&u>=(dev.util??0)){dev.util=u;dev.engine=u>0?engineOf.get(key):dev.engine;}devices.set(id,dev);}
 // Real GPUs: those with dedicated memory in use or any engine activity (the basic render driver has neither).
 const list=[...devices.values()].filter(d=>(d.memUsed||0)>0||(d.util||0)>0).sort((a,b)=>(b.memUsed||0)-(a.memUsed||0));
 // The counters name a GPU only by its LUID. With one GPU and one display adapter that reports memory, the two are the same.
 const real=cur.adapters.filter(a=>(a.memTotal||0)>0);
 return list.slice(0,4).map((d,i)=>({id:d.id,name:list.length===1&&real.length===1?real[0].name:null,util:round(d.util),engine:d.engine,memUsed:d.memUsed,memTotal:list.length===1&&real.length===1?real[0].memTotal:null}));
}
// One reading from two snapshots. atSec = when it was taken (unix seconds). Without prev (or with a span
// out of bounds) only the instantaneous values are given; every rate is null.
export function deriveReading(prev,cur,atSec){
 const total=cur.cpu.get('_Total'),before=prev?.cpu.get('_Total');
 const elapsed=dt(before?.ts,total?.ts),span=elapsed!=null?elapsed/1e7:null;
 const usable=prev&&span!=null&&span>0&&span<=WINDOWS_MAX_SPAN_SECONDS?prev:null;
 const busy=(a,b)=>{const e=dt(a?.ts,b?.ts),idle=rise(a?.idle,b?.idle);return e&&idle!=null?Math.max(0,Math.min(100,100-idle/e*100)):null;};
 const cores=usable?[...cur.cpu.keys()].filter(k=>/^\d+$/.test(k)).sort((a,b)=>a-b).map(k=>round(busy(usable.cpu.get(k),cur.cpu.get(k)))):[];
 const rate=(a,b,ta,tb)=>{const e=dt(ta,tb),d=rise(a,b);return e&&d!=null?d/(e/1e7):null;};
 const disk=usable&&usable.disk&&cur.disk?{read:rate(usable.disk.read,cur.disk.read,usable.disk.ts,cur.disk.ts),write:rate(usable.disk.write,cur.disk.write,usable.disk.ts,cur.disk.ts)}:{read:null,write:null};
 let rx=null,tx=null;
 if(usable)for(const n of cur.net){const p=usable.net.find(x=>x.name===n.name);if(!p)continue;const r=rate(p.rx,n.rx,p.ts,n.ts),s=rate(p.tx,n.tx,p.ts,n.ts);if(r!=null)rx=(rx||0)+r;if(s!=null)tx=(tx||0)+s;}
 const gpus=usable?gpuDevices(usable,cur):gpuDevices(null,cur);
 const counters=cur.gmem.length>0;// the GPU counter classes exist on this machine
 const utils=gpus.map(g=>g.util).filter(Number.isFinite);
 const memTotal=cur.os.memTotal,memUsed=memTotal!=null&&cur.avail!=null?Math.max(0,memTotal-cur.avail):null;
 const vram=gpus.map(g=>g.memUsed).filter(Number.isFinite);
 return {t:atSec,span:usable?round(span,2):null,
  cpu:usable?round(busy(usable.cpu.get('_Total'),total)):null,cores,
  gpu:usable&&counters?(utils.length?Math.max(...utils):0):null,
  memUsed,memTotal,swapUsed:cur.swapUsed,vramUsed:vram.length?vram.reduce((a,b)=>a+b,0):null,
  diskRead:round(disk.read,0),diskWrite:round(disk.write,0),netRx:round(rx,0),netTx:round(tx,0),
  // Not measured on Windows: null, never 0.
  power:null,cpuTemp:null,gpuTemp:null,gpuMem:null,memPressure:null,gpus};
}
// The volumes in the shape the overview reads from Thermo's disk replies.
export const volumesOf=snap=>snap.volumes.filter(v=>v.size).slice(0,12).map(v=>({name:v.label?`${v.label} (${v.mount})`:v.mount,mount:v.mount,fs:v.fs||'',
 used:v.size!=null&&v.free!=null?Math.max(0,v.size-v.free):null,total:v.size}));
// What a machine page shows beyond the common gauges.
export function nativeOf(snap,reading,observedAt,provider=WINDOWS_PROVIDER){
 const uptime=snap.os.bootUnix!=null&&snap.t!=null?Math.max(0,Math.round(snap.t/1000-snap.os.bootUnix)):null;
 return {provider,observedAt,os:{caption:snap.os.caption,version:snap.os.version,uptimeSeconds:uptime},
  cpu:{name:snap.cpuName[0]||null,logical:[...snap.cpu.keys()].filter(k=>/^\d+$/.test(k)).length||null,cores:reading.cores},
  disk:{readBps:reading.diskRead,writeBps:reading.diskWrite},net:{rxBps:reading.netRx,txBps:reading.netTx},
  gpus:reading.gpus,gpuCounters:snap.gmem.length>0,span:reading.span,sensors:'unsupported'};
}

// One collection: ssh with these arguments, then parse. Rejects with Error(code) (classifySsh codes, 'bad-output').
export async function collectArgs(args,{run=runSsh,timeoutMs=WINDOWS_TIMEOUT_MS,env}={}){
 const r=await run(args,{timeoutMs,...(env?{env}:{})});
 const marked=typeof r.stdout==='string'&&r.stdout.includes(MARK);
 if(!marked){fail(classifySsh(r)||'bad-output');}
 return parseCollectorOutput(r.stdout);
}
// One collection through an alias connection. Rejects with Error(code) (classifySsh codes, 'bad-output', 'invalid').
export const collectWindows=(target,{run=runSsh,timeoutMs=WINDOWS_TIMEOUT_MS}={})=>collectArgs(sshArgs(target),{run,timeoutMs,env:{...process.env}});
// Where an alias leads (ssh -G, no network): {hostname, user, port} or null.
export async function resolveTarget(target,{run=runSsh}={}){
 const r=await run(resolveArgs(target),{timeoutMs:5000,maxStdout:262144});
 if(r.error||r.code!==0)return null;
 const get=k=>{const m=new RegExp(`^${k} (.+)$`,'m').exec(r.stdout);return m?m[1].trim().slice(0,253):null;};
 const port=Number(get('port'));
 return {hostname:get('hostname'),user:get('user'),port:Number.isSafeInteger(port)?port:null};
}
// What a "Test connection" says about one snapshot: Windows version, CPU, memory, volumes, GPUs.
export function checkResult(snap){
 if(!snap.cpu.size&&snap.os.memTotal==null)fail('no-counters');
 const reading=deriveReading(null,snap,Math.floor(Date.now()/1000));
 return {os:{caption:snap.os.caption,version:snap.os.version},cpu:{name:snap.cpuName[0]||null,logical:[...snap.cpu.keys()].filter(k=>/^\d+$/.test(k)).length||null},
  memTotal:snap.os.memTotal,volumes:volumesOf(snap).map(v=>({mount:v.mount,name:v.name,fs:v.fs,total:v.total})),
  gpus:snap.adapters.map(a=>a.name),gpuCounters:snap.gmem.length>0,vramUsed:reading.vramUsed,sensors:'unsupported'};
}
// "Test connection" of an alias: resolve the alias, collect once, and say what was found. Rejects like collectWindows.
export async function checkWindows(target,{run=runSsh,collect=collectWindows}={}){
 if(!validSshTarget(target))fail('invalid');
 const started=Date.now();
 const resolved=await resolveTarget(target,{run}).catch(()=>null);
 const snap=await collect(target,{run});
 const facts=checkResult(snap);
 return {ok:true,target,resolved,tookMs:Date.now()-started,...facts};
}

// --- poller ----------------------------------------------------------------------------------------
// The shared snapshot poller (server/telemetry-poller.mjs) with the Windows driver. hosts = async () => [{id,
// target, managed?, winrm?}] (the devices connected on the overview): an alias connection is {id, target}; a managed
// one also carries the stored connection (managed) and is collected with collectManaged(managed)
// (server/windows-ssh.mjs gives the hub's own). WinRM connections (server/winrm-telemetry.mjs) use the same driver
// through their own poller: their snapshots have the same shape, so readings, history and the page mean the same.
// A config is the same connection as before while its identity (connectionKey) is unchanged; any change of host,
// port, user, key or verified host key is a new connection: its readings and counter chain start afresh.
// Minute rows: stateDirectory/windows/minutes-<id>-YYYY-MM.jsonl (shared by both Windows providers).
export {minuteRow};
export const connectionKey=c=>c?.managed?['managed',c.managed.host.toLowerCase(),c.managed.port,c.managed.user,c.managed.keyId,c.managed.connId,c.managed.hostKey.fingerprint].join('|'):`alias|${c?.target}`;
const validConfig=c=>Boolean(c&&typeof c.id==='string'&&(c.managed?validManaged(c.managed):validSshTarget(c.target)));
// What a connection may show to signed-in readers: never a key or a path, only what identifies it.
export const connectionInfo=c=>c.managed?{mode:'managed',host:c.managed.host,port:c.managed.port,user:c.managed.user,keyFingerprint:c.managed.keyFingerprint,hostKeyFingerprint:c.managed.hostKey.fingerprint}
 :{mode:'alias',target:c.target};
// The Windows reading side, for any transport that yields this module's snapshots.
export const windowsDriver=({collect,provider=WINDOWS_PROVIDER,errors=WINDOWS_ERRORS,valid=validConfig,key=connectionKey,label=c=>c.managed?managedLabel(c.managed):c.target,info=connectionInfo})=>({
 collect,derive:deriveReading,volumes:volumesOf,native:(snap,reading,at)=>nativeOf(snap,reading,at,provider),errors,valid,key,label,info,deniedCodes:['denied']});
export function createWindowsPoller({stateDirectory,hosts=async()=>[],intervalMs=WINDOWS_MIN_INTERVAL_MS,collect=collectWindows,collectManaged=async()=>{throw new Error('unavailable');},now=Date.now,log=()=>{},concurrency=4}={}){
 return createSnapshotPoller({driver:windowsDriver({collect:c=>c.managed?collectManaged(c.managed):collect(c.target)}),subdir:'windows',stateDirectory,hosts,intervalMs,minIntervalMs:WINDOWS_MIN_INTERVAL_MS,now,log,concurrency});
}
