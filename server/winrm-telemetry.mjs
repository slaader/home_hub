// Windows telemetry over WinRM (WS-Management), as an alternative to SSH: the hub sends fixed, read-only WMI
// queries (WS-Enumeration Enumerate and Pull with a WQL filter) to the machine's WinRM HTTPS listener and builds the
// same data object the SSH collector's PowerShell script prints (server/windows-telemetry.mjs → snapshotFromData),
// so readings, rates, history and the machine page mean exactly the same for both transports.
//
// What is supported, and nothing more:
//   transport       HTTPS only (default port 5986). Never plain HTTP, never AllowUnencrypted.
//   authentication  Basic (a local Windows account and its password), sent only after the TLS certificate is
//                   verified: by the CA store and hostname (mode "ca"), or by a SHA-256 pin of the leaf certificate
//                   a person approved (mode "pin"; hostname not checked). No Kerberos, no NTLM/Negotiate, no
//                   CredSSP, no certificate authentication: Basic is the only scheme that needs no cryptography
//                   the hub would have to implement itself. WinRM's Basic is off by default; the guide in the
//                   web UI turns it on for the WinRM service only and adds an HTTPS listener, nothing else.
//   operations      Enumerate/Pull of the fixed WQL queries below, all in root/cimv2. No shell, no PowerShell
//                   remoting (PSRP), no Invoke, no Create/Put/Delete: the account needs only read access.
// The password lives in state/home/telemetry-hosts.json (0600, sealed: server/secret-box.mjs) and in memory; never in a reply, a log line, an
// error, MCP, inventory or an export. WinRM's fault text is classified into a code and never passed on.
import {randomUUID,createHash} from 'node:crypto';
import {endpointRequest,validEndpointHost,validEndpointPort,CERT_PIN} from './endpoint-http.mjs';
import {parseXml,find,child,childrenOf,local} from './safe-xml.mjs';
import {snapshotFromData,validWindowsUser,checkResult,WINDOWS_ERRORS} from './windows-telemetry.mjs';

export const WINRM_PROVIDER='winrm',WINRM_NAME='Windows (WinRM)',WINRM_PORT=5986;
export const WINRM_TIMEOUT_MS=25000;
const fail=code=>{throw new Error(code);};
export const validWinrmPassword=p=>typeof p==='string'&&p.length>=1&&p.length<=256&&!/[\u0000-\u001f\u007f]/.test(p);
const validTrust=t=>Boolean(t&&typeof t==='object'&&(t.mode==='ca'||t.mode==='pin'&&CERT_PIN.test(t.pin||'')));
// A stored WinRM connection (state/home/telemetry-hosts.json, 0600).
export const validWinrmRecord=r=>Boolean(r&&typeof r==='object'&&r.mode===WINRM_PROVIDER&&validEndpointHost(r.host)&&validEndpointPort(r.port)&&r.scheme==='https'&&
 validTrust(r.tls)&&validWindowsUser(r.user)&&validWinrmPassword(r.password));
export const winrmLabel=r=>`${r.user}@${r.host}:${r.port}`;

// The fixed queries. key = the field of the data object; required ones fail the collection when WMI refuses them.
// Every class and property is the one the SSH script reads (server/windows-telemetry.mjs → COLLECTOR_SCRIPT), except
// the display adapters: the registry is not WMI, so Win32_VideoController names them (its AdapterRAM is a 32-bit
// value, so a size of 4 GB or more is unknown and left null rather than reported wrong).
export const WINRM_QUERIES=Object.freeze([
 {key:'os',required:true,wql:'SELECT Caption,Version,TotalVisibleMemorySize,LastBootUpTime FROM Win32_OperatingSystem'},
 {key:'cpuName',wql:'SELECT Name FROM Win32_Processor'},
 {key:'cpu',required:true,wql:'SELECT Name,PercentProcessorTime,Timestamp_Sys100NS FROM Win32_PerfRawData_PerfOS_Processor'},
 {key:'avail',wql:'SELECT AvailableBytes FROM Win32_PerfRawData_PerfOS_Memory'},
 {key:'page',wql:'SELECT CurrentUsage FROM Win32_PageFileUsage'},
 {key:'vol',wql:'SELECT DeviceID,VolumeName,FileSystem,Size,FreeSpace FROM Win32_LogicalDisk WHERE DriveType=3'},
 {key:'disk',wql:"SELECT DiskReadBytesPersec,DiskWriteBytesPersec,Timestamp_Sys100NS FROM Win32_PerfRawData_PerfDisk_PhysicalDisk WHERE Name='_Total'"},
 {key:'net',wql:'SELECT Name,BytesReceivedPersec,BytesSentPersec,Timestamp_Sys100NS FROM Win32_PerfRawData_Tcpip_NetworkInterface'},
 {key:'gpu',optional:true,wql:'SELECT Name,RunningTime,Timestamp_Sys100NS FROM Win32_PerfRawData_GPUPerformanceCounters_GPUEngine WHERE RunningTime > 0'},
 {key:'gmem',optional:true,wql:'SELECT Name,DedicatedUsage,SharedUsage,Timestamp_Sys100NS FROM Win32_PerfRawData_GPUPerformanceCounters_GPUAdapterMemory'},
 {key:'adapters',wql:'SELECT Name,AdapterRAM FROM Win32_VideoController'}]);
export const WINRM_LIMITS=Object.freeze({replyBytes:1024*1024,totalBytes:8*1024*1024,pulls:16,items:20000,maxElements:500,envelope:512000});

export const WINRM_ERRORS=Object.freeze({
 refused:'Windows odmítl spojení na port WinRM HTTPS. Běží služba WinRM, má posluchač HTTPS na tomhle portu a pouští ho firewall z adresy Home Hubu?',
 unresolved:'Jméno hostitele se ze serveru s Home Hubem nedá přeložit. Zadej IP adresu nebo jméno, které zná tvoje DNS.',
 timeout:'WinRM neodpověděl včas. Stroj může spát nebo být mimo síť, nebo port blokuje firewall.',
 unreachable:'Stroj není v síti k zastižení. To neznamená, že je vypnutý.',
 'tls-untrusted':'Certifikát posluchače WinRM neověřila žádná autorita, které Home Hub věří. Použij připnutí otisku certifikátu.',
 'tls-hostname':'Certifikát posluchače WinRM nepatří k tomuhle jménu hostitele. Zadej jméno z certifikátu, nebo použij připnutí otisku.',
 'tls-pin':'Posluchač WinRM ukázal jiný certifikát, než jaký jsi potvrdil. Mohl být obnovený, ale může jít i o podvržený stroj. Načti certifikát znovu a porovnej otisk na Windows; do té doby Home Hub heslo nepošle.',
 tls:'Spojení TLS s WinRM selhalo. Je na tom portu opravdu posluchač HTTPS?',
 denied:'WinRM odmítl uživatele nebo heslo. Basic funguje jen s místním účtem Windows (ne doménovým); zkontroluj jméno a heslo.',
 'basic-disabled':'WinRM na tomhle stroji nepovoluje ověřování Basic. Spusť na Windows krok, který povolí Basic jen pro službu WinRM (návod v nastavení spojení).',
 'wmi-denied':'Přihlášení prošlo, ale WMI účtu nedovolí číst. Přidej účet do skupin Remote Management Users a Performance Monitor Users a povol mu Remote Enable na jmenném prostoru root/cimv2 (návod v nastavení spojení).',
 'winrm-fault':'WinRM vrátil chybu, kterou Home Hub nezná. Zkus to znovu; když to trvá, zkontroluj na Windows službu WinRM.',
 redirect:'WinRM odpověděl přesměrováním. Home Hub přesměrování nesleduje; zadej přímo adresu a port posluchače HTTPS.',
 http:'WinRM odpověděl neočekávanou chybou HTTP. Je na tom portu opravdu WinRM?',
 encoded:'WinRM poslal komprimovanou odpověď, i když o ni Home Hub nežádal.',
 'too-large':'Odpověď z WinRM byla nečekaně velká a byla zahozena.',
 'bad-output':'WinRM odpověděl, ale ne očekávanými daty. Je cíl opravdu Windows s WinRM?',
 'no-counters':WINDOWS_ERRORS['no-counters'],
 busy:'Právě běží jiné zkoušky spojení. Zkus to za chvíli.',unavailable:'Telemetrie Windows teď neodpovídá.'});

// --- SOAP ------------------------------------------------------------------------------------------------
const NS='xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:a="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:n="http://schemas.xmlsoap.org/ws/2004/09/enumeration" xmlns:w="http://schemas.dmtf.org/wbem/wsman/1/wsman.xsd" xmlns:p="http://schemas.microsoft.com/wbem/wsman/1/wsman.xsd"';
const RESOURCE='http://schemas.microsoft.com/wbem/wsman/1/wmi/root/cimv2/*';
const ACTIONS={enumerate:'http://schemas.xmlsoap.org/ws/2004/09/enumeration/Enumerate',pull:'http://schemas.xmlsoap.org/ws/2004/09/enumeration/Pull'};
const esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const CONTEXT=/^[A-Za-z0-9:._-]{1,200}$/;
function envelope({host,port,action,body}){
 if(!validEndpointHost(host)||!validEndpointPort(port))fail('invalid');
 return `<?xml version="1.0" encoding="UTF-8"?><s:Envelope ${NS}><s:Header><a:To>https://${host}:${port}/wsman</a:To>`+
  `<w:ResourceURI s:mustUnderstand="true">${RESOURCE}</w:ResourceURI><a:ReplyTo><a:Address s:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous</a:Address></a:ReplyTo>`+
  `<a:Action s:mustUnderstand="true">${ACTIONS[action]}</a:Action><w:MaxEnvelopeSize s:mustUnderstand="true">${WINRM_LIMITS.envelope}</w:MaxEnvelopeSize>`+
  `<a:MessageID>uuid:${randomUUID()}</a:MessageID><w:Locale xml:lang="en-US" s:mustUnderstand="false"/><p:DataLocale xml:lang="en-US" s:mustUnderstand="false"/>`+
  `<w:OperationTimeout>PT15S</w:OperationTimeout></s:Header><s:Body>${body}</s:Body></s:Envelope>`;
}
// Only the queries above ever reach this: a WQL string is never built from input.
export const enumerateBody=({host,port},wql)=>{if(!WINRM_QUERIES.some(q=>q.wql===wql))fail('invalid');
 return envelope({host,port,action:'enumerate',body:`<n:Enumerate><w:OptimizeEnumeration/><w:MaxElements>${WINRM_LIMITS.maxElements}</w:MaxElements><w:Filter Dialect="http://schemas.microsoft.com/wbem/wsman/1/WQL">${esc(wql)}</w:Filter></n:Enumerate>`});};
export const pullBody=({host,port},context)=>{if(!CONTEXT.test(context||''))fail('bad-output');
 return envelope({host,port,action:'pull',body:`<n:Pull><n:EnumerationContext>${esc(context)}</n:EnumerationContext><n:MaxElements>${WINRM_LIMITS.maxElements}</n:MaxElements></n:Pull>`});};

// A SOAP fault → a code. Its subcodes, the WSManFault code and the HRESULTs in its text are matched against
// known patterns; the text itself is never kept, logged or returned.
const ACCESS=/AccessDenied|\b(?:2147749891|0x80041003|2147942405|0x80070005)\b/i,NO_CLASS=/InvalidClass|CannotProcessFilter|InvalidResourceURI|\b(?:2147749904|0x80041010|2147749890|0x80041002|2147749911|0x80041017)\b/i;
export function faultCode(xml){
 let root;try{root=parseXml(xml);}catch{return 'winrm-fault';}
 const fault=find(root,'Fault');if(!fault)return 'winrm-fault';
 const parts=[];const walk=n=>{if(n.text.trim())parts.push(n.text.trim().slice(0,2000));for(const [k,v] of Object.entries(n.attrs))if(local(k)==='Code')parts.push(`code ${v}`);n.children.forEach(walk);};walk(fault);
 const all=parts.join(' ');
 if(ACCESS.test(all)||/\bcode 5\b/.test(all))return 'wmi-denied';
 if(NO_CLASS.test(all))return 'wmi-class';
 return 'winrm-fault';
}
// The items of an Enumerate or Pull reply: [{Property: text | null}], plus the context to pull with and whether it ended.
// A property element holds text, xsi:nil="true" (null), or one child (a cim:Datetime), whose text is taken.
export function parseEnumeration(xml){
 let root;try{root=parseXml(xml);}catch{fail('bad-output');}
 if(find(root,'Fault'))fail(faultCode(xml));
 const resp=find(root,'EnumerateResponse')||find(root,'PullResponse');if(!resp)fail('bad-output');
 const items=child(resp,'Items');
 const ctx=child(resp,'EnumerationContext')?.text.trim()||null;
 const ended=Boolean(child(resp,'EndOfSequence')||find(resp,'EndOfSequence'));
 const out=[];
 for(const item of items?.children||[]){
  const row={};
  for(const p of item.children){
   const nil=Object.entries(p.attrs).some(([k,v])=>local(k)==='nil'&&v==='true');
   row[local(p.name)]=nil?null:p.children.length?(p.children[0].text||'').trim():p.text.trim();
  }
  out.push(row);
 }
 return {items:out,context:ctx,ended};
}
// "2026-11-10T07:12:30.123456+01:00", "…Z" or the DMTF form "20261110071230.123456+060" → unix seconds, or null.
export function cimSeconds(v){
 if(typeof v!=='string')return null;
 let m=/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.\d{6}([+-])(\d{3})$/.exec(v);
 if(m){const ms=Date.UTC(+m[1],+m[2]-1,+m[3],+m[4],+m[5],+m[6])-(m[7]==='+'?1:-1)*Number(m[8])*60000;return Number.isFinite(ms)?Math.floor(ms/1000):null;}
 m=/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(v);
 if(!m)return null;const ms=Date.parse(`${m[1]}.${(m[2]||'0').padEnd(3,'0').slice(0,3)}${m[3]}`);return Number.isFinite(ms)?Math.floor(ms/1000):null;
}

// --- collecting ---------------------------------------------------------------------------------------------
const basic=(user,password)=>'Basic '+Buffer.from(`${user}:${password}`,'utf8').toString('base64');
const trustOf=r=>r.tls.mode==='pin'?{mode:'pin',pin:r.tls.pin}:{mode:'ca'};
// One query, all its items (Enumerate, then Pull until the end, bounded). spent = {bytes, deadline}.
async function query(record,wql,{request,spent}){
 const items=[];let body=enumerateBody(record,wql),pulls=0;
 for(;;){
  const left=spent.deadline-Date.now();if(left<=0)fail('timeout');
  let r;
  try{r=await request({host:record.host,port:record.port,path:'/wsman',method:'POST',trust:trustOf(record),timeoutMs:Math.min(15000,left),maxBytes:WINRM_LIMITS.replyBytes,
   headers:{'Content-Type':'application/soap+xml;charset=UTF-8',Authorization:basic(record.user,record.password)},body});}
  catch(e){
   if(e?.message==='http'){
    if(e.status===401){const offered=String(e.headers?.['www-authenticate']||'');fail(offered&&!/\bbasic\b/i.test(offered)?'basic-disabled':'denied');}
    if(e.status===403)fail('wmi-denied');
    if(e.status===500||e.status===400)fail(faultCode(e.body));
    fail('http');
   }
   fail(Object.hasOwn(WINRM_ERRORS,e?.message)?e.message:'unreachable');
  }
  spent.bytes+=r.body.length;if(spent.bytes>WINRM_LIMITS.totalBytes)fail('too-large');
  if(!/soap\+xml|text\/xml/i.test(String(r.headers['content-type']||'')))fail('bad-output');
  const page=parseEnumeration(r.body);
  items.push(...page.items);if(items.length>WINRM_LIMITS.items)fail('too-large');
  if(page.ended||!page.context)return items;
  if(++pulls>WINRM_LIMITS.pulls)fail('too-large');
  body=pullBody(record,page.context);
 }
}
const S=v=>v==null?null:String(v);
// The items of each query → the data object of the SSH script (strings for counters: they exceed 2^53).
export function dataFromItems(by,now=Date.now()){
 const os=by.os?.[0]||{};
 const gpu=by.gpu||[],gmem=by.gmem||[];
 return {v:1,t:now,
  os:[S(os.Caption),S(os.Version),S(os.TotalVisibleMemorySize),cimSeconds(os.LastBootUpTime)],
  cpuName:(by.cpuName||[]).map(x=>S(x.Name)),
  cpu:(by.cpu||[]).map(x=>[S(x.Name),S(x.PercentProcessorTime),S(x.Timestamp_Sys100NS)]),
  avail:S(by.avail?.[0]?.AvailableBytes),
  page:(by.page||[]).map(x=>S(x.CurrentUsage)),
  vol:(by.vol||[]).map(x=>[S(x.DeviceID),S(x.VolumeName),S(x.FileSystem),S(x.Size),S(x.FreeSpace)]),
  disk:(by.disk||[]).slice(0,1).map(x=>[S(x.DiskReadBytesPersec),S(x.DiskWriteBytesPersec),S(x.Timestamp_Sys100NS)]),
  net:(by.net||[]).map(x=>[S(x.Name),S(x.BytesReceivedPersec),S(x.BytesSentPersec),S(x.Timestamp_Sys100NS)]),
  // The engines' own timestamp; with no engine running, the adapter-memory counters' (read in the same pass).
  gts:S(gpu[0]?.Timestamp_Sys100NS??gmem[0]?.Timestamp_Sys100NS),
  gpu:gpu.map(x=>[S(x.Name),S(x.RunningTime)]),
  gmem:gmem.map(x=>[S(x.Name),S(x.DedicatedUsage),S(x.SharedUsage)]),
  adapters:(by.adapters||[]).map(x=>{const ram=/^\d{1,10}$/.test(x.AdapterRAM||'')?Number(x.AdapterRAM):null;return [S(x.Name),ram!=null&&ram>0&&ram<0xfff00000?String(ram):null];})};
}
// One collection: every query once, then the Windows snapshot. Rejects with a WINRM_ERRORS code.
export async function collectWinrm(record,{request=endpointRequest,timeoutMs=WINRM_TIMEOUT_MS,now=Date.now}={}){
 if(!validWinrmRecord(record))fail('invalid');
 const spent={bytes:0,deadline:Date.now()+timeoutMs},by={};
 for(const q of WINRM_QUERIES){
  try{by[q.key]=await query(record,q.wql,{request,spent});}
  catch(e){
   // A class this Windows does not have (no GPU counters on older builds) leaves that part empty; anything else fails.
   if(e?.message==='wmi-class'&&!q.required){by[q.key]=[];continue;}
   if(e?.message==='wmi-class')fail('bad-output');
   throw e;
  }
 }
 return snapshotFromData(dataFromItems(by,now()));
}
// What a "Test connection" reports: the facts of the SSH test (server/windows-telemetry.mjs → checkResult).
export const winrmCheck=snap=>checkResult(snap);
// --- the poller side --------------------------------------------------------------------------------------
const secretTag=p=>p?createHash('sha256').update('home-hub-telemetry\u0000'+p).digest('hex').slice(0,16):'';
export const winrmKey=c=>['winrm',c.record.host.toLowerCase(),c.record.port,c.record.user,c.record.tls.mode,c.record.tls.pin||'',secretTag(c.record.password)].join('|');
// What a connection may show to signed-in readers: never the password.
export const winrmInfo=c=>({mode:WINRM_PROVIDER,host:c.record.host,port:c.record.port,scheme:'https',user:c.record.user,auth:'basic',
 tls:{mode:c.record.tls.mode,...(c.record.tls.pin?{fingerprint:c.record.tls.pin}:{})}});
export const validWinrmConfig=c=>Boolean(c&&typeof c.id==='string'&&validWinrmRecord(c.record));
