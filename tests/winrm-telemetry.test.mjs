// Windows over WinRM (server/winrm-telemetry.mjs, server/safe-xml.mjs): fixed WQL in WS-Enumeration envelopes over
// verified HTTPS with Basic, a strict XML reader (no DTD, no entities beyond the predefined ones), Pull pagination with
// bounds, faults as codes, and the very snapshot shape the SSH collector produces, so readings mean the same.
// Every reply is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseXml} from '../server/safe-xml.mjs';
import {enumerateBody,pullBody,parseEnumeration,faultCode,cimSeconds,collectWinrm,winrmCheck,dataFromItems,validWinrmRecord,winrmInfo,
 WINRM_QUERIES,WINRM_ERRORS} from '../server/winrm-telemetry.mjs';
import {deriveReading,snapshotFromData} from '../server/windows-telemetry.mjs';

const record={mode:'winrm',host:'pc.example.lan',port:5986,scheme:'https',user:'homehub',password:'correct horse 1',tls:{mode:'pin',pin:'b'.repeat(64)}};
const wrap=(inner,{ctx=null,end=true,pull=false}={})=>`<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:n="http://schemas.xmlsoap.org/ws/2004/09/enumeration" xmlns:w="http://schemas.dmtf.org/wbem/wsman/1/wsman.xsd" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><s:Header/><s:Body><n:${pull?'PullResponse':'EnumerateResponse'}>${ctx?`<n:EnumerationContext>${ctx}</n:EnumerationContext>`:''}<w:Items>${inner}</w:Items>${end?'<w:EndOfSequence/>':''}</n:${pull?'PullResponse':'EnumerateResponse'}></s:Body></s:Envelope>`;
const frag=props=>`<w:XmlFragment>${Object.entries(props).map(([k,v])=>v===null?`<${k} xsi:nil="true"/>`:typeof v==='object'?`<${k}><cim:Datetime xmlns:cim="x">${v.dt}</cim:Datetime></${k}>`:`<${k}>${v}</${k}>`).join('')}</w:XmlFragment>`;
// What a Windows machine answers at tick k (counters grow with k), keyed by the class in the WQL.
function machine(k=0,{gpu=true,basic=true,denied=false}={}){
 const ts=String(130000000000000000n+BigInt(k)*300000000n);
 const by={Win32_OperatingSystem:[{Caption:'Microsoft Windows 11 Pro',Version:'10.0.26100',TotalVisibleMemorySize:'33554432',LastBootUpTime:{dt:'2026-11-10T07:00:00.123456+01:00'}}],
  Win32_Processor:[{Name:'Test CPU &amp; Co'}],
  Win32_PerfRawData_PerfOS_Processor:['_Total','0','1'].map(n=>({Name:n,PercentProcessorTime:String(1000000000n+BigInt(k)*150000000n),Timestamp_Sys100NS:ts})),
  Win32_PerfRawData_PerfOS_Memory:[{AvailableBytes:'17179869184'}],Win32_PageFileUsage:[{CurrentUsage:'512'}],
  Win32_LogicalDisk:[{DeviceID:'C:',VolumeName:'System',FileSystem:'NTFS',Size:'1000000000000',FreeSpace:'400000000000'},{DeviceID:'D:',VolumeName:null,FileSystem:'NTFS',Size:'2000000000000',FreeSpace:'1000000000000'}],
  Win32_PerfRawData_PerfDisk_PhysicalDisk:[{DiskReadBytesPersec:String(5000000+k*3000000),DiskWriteBytesPersec:String(9000000+k*6000000),Timestamp_Sys100NS:ts}],
  Win32_PerfRawData_Tcpip_NetworkInterface:Array.from({length:3},(_, i)=>({Name:`Adapter ${i}`,BytesReceivedPersec:String(1000+k*30000),BytesSentPersec:String(1000+k*3000),Timestamp_Sys100NS:ts})),
  Win32_PerfRawData_GPUPerformanceCounters_GPUEngine:[{Name:'pid_100_luid_0x00000000_0x0000ABCD_phys_0_eng_0_engtype_3D',RunningTime:String(k*150000000),Timestamp_Sys100NS:ts}],
  Win32_PerfRawData_GPUPerformanceCounters_GPUAdapterMemory:[{Name:'luid_0x00000000_0x0000ABCD_phys_0',DedicatedUsage:'2147483648',SharedUsage:'0',Timestamp_Sys100NS:ts}],
  Win32_VideoController:[{Name:'Test GPU',AdapterRAM:'4293918720'}]};
 const pages=new Map();let ctx=0;const seen=[];
 const request=async o=>{
  seen.push(o);
  if(denied)throw Object.assign(new Error('http'),{status:401,headers:{'www-authenticate':basic?'Basic realm="WSMAN", Negotiate':'Negotiate'},body:Buffer.alloc(0)});
  const body=String(o.body);const pull=/<n:Pull>/.test(body);
  let items,id;
  if(pull){id=/<n:EnumerationContext>([^<]+)</.exec(body)[1];items=pages.get(id);}
  else{const cls=/FROM (\w+)/.exec(body)[1];if(!gpu&&/GPU/.test(cls))throw Object.assign(new Error('http'),{status:500,headers:{},body:Buffer.from(wrapFault('w:CannotProcessFilter','0x80041010'))});items=by[cls];}
  // The network adapters come in pages of one (Enumerate, then Pull, Pull).
  if(items.length>1&&items[0].Name?.startsWith('Adapter')){const [first,...rest]=items;const next=`uuid:${++ctx}`;if(rest.length)pages.set(next,rest);
   return {status:200,headers:{'content-type':'application/soap+xml;charset=UTF-8'},body:Buffer.from(wrap(frag(first),{ctx:rest.length?next:null,end:!rest.length,pull}))};}
  return {status:200,headers:{'content-type':'application/soap+xml;charset=UTF-8'},body:Buffer.from(wrap(items.map(frag).join(''),{ctx:'uuid:done',pull}))};};
 return {request,seen};
}
const wrapFault=(sub,hr)=>`<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:w="w"><s:Body><s:Fault><s:Code><s:Value>s:Sender</s:Value><s:Subcode><s:Value>${sub}</s:Value></s:Subcode></s:Code><s:Reason><s:Text xml:lang="en-US">The WMI service returned an error ${hr}. C:\\secret\\path</s:Text></s:Reason><s:Detail><f:WSManFault xmlns:f="f" Code="2150858752"/></s:Detail></s:Fault></s:Body></s:Envelope>`;

test('safe XML: no DTD, no unknown entities, no CDATA, bounded; the five entities and character references decode',()=>{
 assert.equal(parseXml('<a x="1&amp;2">&lt;&#x41;&#66;&quot;</a>').text,'<AB"');assert.equal(parseXml('<a x="1&amp;2"/>').attrs.x,'1&2');
 for(const bad of ['<!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>','<a>&x;</a>','<a>&constructor;</a>','<a>&toString;</a>','<a>&</a>','<a><![CDATA[x]]></a>','<a><b></a>','<a/><b/>','<?pi x?><a/>','<a>&#0;</a>','<a>&#xD800;</a>','<a b=1/>'])
  assert.throws(()=>parseXml(bad),/bad-xml/,bad);
 assert.throws(()=>parseXml('<a>'+'<b>'.repeat(70)+'</b>'.repeat(70)+'</a>'),/bad-xml/,'depth');
 assert.throws(()=>parseXml('<a>'+'<b/>'.repeat(20)+'</a>',{bytes:1e6,depth:8,nodes:10,attributes:4,text:100}),/bad-xml/,'node cap');
});

test('envelopes: only the fixed WQL of the allowlist, a validated To address, an escaped and checked context',()=>{
 const body=enumerateBody(record,WINRM_QUERIES[0].wql);
 assert.match(body,/<a:To>https:\/\/pc\.example\.lan:5986\/wsman<\/a:To>/);assert.match(body,/<w:Filter Dialect="http:\/\/schemas\.microsoft\.com\/wbem\/wsman\/1\/WQL">SELECT Caption/);
 assert.match(body,/root\/cimv2\/\*/);assert.match(body,/enumeration\/Enumerate</);
 assert.throws(()=>enumerateBody(record,'SELECT * FROM Win32_Process'),/invalid/,'no query outside the list');
 assert.throws(()=>enumerateBody({...record,host:'a"/><x'},WINRM_QUERIES[0].wql),/invalid/);
 assert.match(pullBody(record,'uuid:1-2'),/<n:EnumerationContext>uuid:1-2</);assert.throws(()=>pullBody(record,'x</n:EnumerationContext><evil/>'),/bad-output/);
 assert.ok(WINRM_QUERIES.every(q=>/^SELECT [A-Za-z_,0-9]+ FROM Win32_\w+( WHERE [A-Za-z=0-9'_> ]+)?$/.test(q.wql)),'read-only selects of CIM classes only');
 assert.ok(!/Invoke|Create|Put|Delete|Shell|Command/i.test(WINRM_QUERIES.map(q=>q.wql).join(' ')));
});

test('replies: XmlFragment or class elements, nil, datetimes; faults as codes without their text',()=>{
 const r=parseEnumeration(wrap(frag({Name:'a',Size:null,When:{dt:'2026-11-10T06:00:00Z'}})+'<p:Win32_X xmlns:p="p"><p:Name>b</p:Name></p:Win32_X>',{ctx:'uuid:1',end:false}));
 assert.deepEqual(r.items,[{Name:'a',Size:null,When:'2026-11-10T06:00:00Z'},{Name:'b'}]);assert.deepEqual([r.context,r.ended],['uuid:1',false]);
 assert.equal(cimSeconds('2026-11-10T07:00:00.123456+01:00'),Date.parse('2026-11-10T06:00:00Z')/1000);assert.equal(cimSeconds('20261110070000.500000+060'),Date.parse('2026-11-10T06:00:00Z')/1000);assert.equal(cimSeconds('junk'),null);
 assert.equal(faultCode(wrapFault('w:CannotProcessFilter','0x80041010')),'wmi-class');assert.equal(faultCode(wrapFault('w:CannotProcessFilter','0x80041003')),'wmi-denied');
 assert.equal(faultCode(wrapFault('w:AccessDenied','')),'wmi-denied');assert.equal(faultCode('<x>'),'winrm-fault');
 assert.throws(()=>parseEnumeration(wrapFault('w:AccessDenied','')),/wmi-denied/);
});

test('collection: Basic only over the pinned certificate, Pull pages, the SSH snapshot shape, honest GPU and adapter memory',async()=>{
 const m0=machine(0),m1=machine(1);
 const a=await collectWinrm(record,{request:m0.request,now:()=>1}),b=await collectWinrm(record,{request:m1.request,now:()=>2});
 assert.ok(m0.seen.every(o=>o.path==='/wsman'&&o.method==='POST'&&o.trust.mode==='pin'&&o.trust.pin==='b'.repeat(64)&&/^Basic /.test(o.headers.Authorization)));
 assert.equal(m0.seen.filter(o=>/<n:Pull>/.test(o.body)).length,2,'the network adapters came over two Pulls');
 assert.equal(b.net.length,3);assert.equal(b.os.caption,'Microsoft Windows 11 Pro');assert.equal(b.os.memTotal,33554432*1024);assert.equal(b.cpuName[0],'Test CPU & Co');
 assert.equal(b.volumes.find(v=>v.mount==='D:').label,null,'a nil property stays null');
 assert.equal(b.adapters[0].memTotal,null,'a 32-bit AdapterRAM at its ceiling is unknown, not 4 GB');
 const r=deriveReading(a,b,2);
 assert.equal(r.cpu,50,'PercentProcessorTime raw is the idle timer (inverse counter), as over SSH');assert.equal(r.diskRead,100000);assert.equal(r.netRx,3000,'three adapters, 30 kB each in 30 s');assert.equal(r.gpu,50);assert.deepEqual([r.power,r.cpuTemp],[null,null]);
 const facts=winrmCheck(b);assert.equal(facts.cpu.logical,2);assert.deepEqual(facts.gpus,['Test GPU']);
 // The same data object through the SSH parser gives the same snapshot.
 assert.deepEqual(snapshotFromData(dataFromItems({os:[{Caption:'X',Version:'1',TotalVisibleMemorySize:'1',LastBootUpTime:null}]},5)).os,{caption:'X',version:'1',memTotal:1024,bootUnix:null});
 const noGpu=await collectWinrm(record,{request:machine(0,{gpu:false}).request});assert.equal(noGpu.gmem.length,0,'no GPU counter classes: that part is empty, the rest is read');
});

test('refusals: Basic off vs a wrong password, invalid records; the password never appears in what readers see',async()=>{
 assert.ok(validWinrmRecord({...record,password:'p'}),'accept an existing nonempty password without imposing a creation policy');
 await assert.rejects(collectWinrm(record,{request:machine(0,{denied:true,basic:false}).request}),/basic-disabled/);
 await assert.rejects(collectWinrm(record,{request:machine(0,{denied:true}).request}),/denied/);
 await assert.rejects(collectWinrm(record,{request:async()=>{throw new Error('tls-pin');}}),/tls-pin/);
 await assert.rejects(collectWinrm(record,{request:async()=>({status:200,headers:{'content-type':'text/html'},body:Buffer.from('<html/>')})}),/bad-output/);
 for(const bad of [{scheme:'http'},{tls:null},{tls:{mode:'insecure'}},{password:''},{user:'a"b'},{host:'-x'}])assert.ok(!validWinrmRecord({...record,...bad}),JSON.stringify(bad));
 const info=winrmInfo({record});assert.deepEqual(info,{mode:'winrm',host:'pc.example.lan',port:5986,scheme:'https',user:'homehub',auth:'basic',tls:{mode:'pin',fingerprint:'b'.repeat(64)}});
 assert.ok(!JSON.stringify(info).includes('correct horse'));
 for(const c of ['basic-disabled','wmi-denied','tls-pin','denied'])assert.ok(WINRM_ERRORS[c]);
 assert.doesNotMatch(Object.values(WINRM_ERRORS).join(' '),/Kerberos|NTLM|AllowUnencrypted=true/,'no implied other authentication');
});
