// Windows telemetry over SSH (server/windows-telemetry.mjs): what may reach the ssh command line, how the
// collector's output is read (real output of the script, two polls apart, in tests/fixtures), honest readings
// (no invented zeroes, GPU engines never summed past 100 %), the poller (offline, removed and re-targeted
// hosts), the device store (connecting an existing device in place, hashes of older records), the overview
// payload and the HTTP routes. No network: ssh is never spawned here.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtemp,rm,readFile,readdir,stat,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {validSshTarget,sshArgs,resolveArgs,runSsh,classifySsh,parseCollectorOutput,deriveReading,gpuDevices,collectWindows,checkWindows,createWindowsPoller,
 COLLECTOR_SCRIPT,REMOTE_COMMAND,SSH_OPTIONS,WINDOWS_ERRORS,WINDOWS_MIN_INTERVAL_MS} from '../server/windows-telemetry.mjs';
import {createHomeDevices,machineHash,normalizeDevice} from '../server/home-devices.mjs';
import {buildHome,homeHistory,spreadSpans,sparkFor} from '../server/home-data.mjs';
import {telemetrySources} from '../server/core/home.mjs';
import {hub,SITE} from './hub-helper.mjs';

const fixture=n=>readFile(new URL(`./fixtures/windows-collector-${n}.txt`,import.meta.url),'utf8');
const HOSTILE=['-oProxyCommand=sh -c id','-p 2222 host','host -oX','a b','a;b','a|b','a&b','$(id)','`id`','a\nb','%h','host:22','[::1]','@host','user@','user@-host','-host','.host','host.','a..b',
 'user@host@x','a/b','a\\b','"a"',"a'b",'', 'x'.repeat(321),null,42,{}];

test('ssh: only an alias or user@host reaches the command line, after "--", with the safety options forced',()=>{
 for(const ok of ['win','pc-windows','pc.example.lan','alice@pc.example.lan','alice_1@10.0.0.30','A1','pc_2'])assert.equal(validSshTarget(ok),true,ok);
 for(const bad of HOSTILE)assert.equal(validSshTarget(bad),false,JSON.stringify(bad));
 for(const bad of HOSTILE)assert.throws(()=>sshArgs(bad),/invalid/,JSON.stringify(bad));
 const args=sshArgs('pc-windows');
 const dash=args.indexOf('--');
 assert.equal(args[dash+1],'pc-windows','the target follows "--", so it can never be an option');
 assert.equal(args.length,dash+3,'nothing but the target and the fixed command after it');
 assert.equal(args.at(-1),REMOTE_COMMAND);
 for(const o of ['BatchMode=yes','StrictHostKeyChecking=yes','PasswordAuthentication=no','ForwardAgent=no','ClearAllForwardings=yes','ControlMaster=no','PermitLocalCommand=no'])
  assert.ok(args.includes(o)&&args[args.indexOf(o)-1]==='-o',o);
 assert.ok(!args.some(a=>/StrictHostKeyChecking=(no|accept-new|off)|UserKnownHostsFile=\/dev\/null/i.test(a)),'host-key verification is never weakened');
 assert.deepEqual(SSH_OPTIONS.filter(o=>/^(ProxyCommand|LocalCommand|RemoteCommand)/i.test(o)),[]);
 // The remote command is constant: the encoded collector, and short enough for cmd.exe (8191 characters).
 assert.match(REMOTE_COMMAND,/^powershell\.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/);
 assert.ok(REMOTE_COMMAND.length<8000,`${REMOTE_COMMAND.length} characters`);
 assert.equal(Buffer.from(REMOTE_COMMAND.split(' ').at(-1),'base64').toString('utf16le'),COLLECTOR_SCRIPT);
 // Read-only: the script reads CIM classes and one registry key; nothing that writes, installs or starts anything.
 assert.doesNotMatch(COLLECTOR_SCRIPT,/Set-|New-|Remove-|Install-|Invoke-Expression|iex |Start-Process|Add-|Enable-|Register-|Out-File|>\s*\S/i);
 assert.deepEqual(resolveArgs('win'),['-G','--','win']);assert.throws(()=>resolveArgs('-G'),/invalid/);
});

// A fake child process for runSsh: stdout/stderr streams, kill, and the events ssh would give.
function fakeSpawn(script){
 const calls=[];
 const spawnImpl=(bin,args,opts)=>{const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.killed=null;
  child.kill=sig=>{child.killed=sig;setImmediate(()=>child.emit('close',null));};calls.push({bin,args,opts,child});setImmediate(()=>script(child));return child;};
 return {spawnImpl,calls};
}
test('ssh runner: argument array without a shell, bounded output, hard timeout, missing ssh',async()=>{
 const ok=fakeSpawn(c=>{c.stdout.write('HHWIN1 {}');c.stderr.write('noise');c.emit('close',0);});
 const r=await runSsh(sshArgs('win'),{spawnImpl:ok.spawnImpl});
 assert.equal(r.code,0);assert.equal(r.stdout,'HHWIN1 {}');assert.equal(ok.calls[0].bin,'ssh');assert.equal(ok.calls[0].opts.shell,false);assert.deepEqual(ok.calls[0].opts.stdio,['ignore','pipe','pipe']);
 const big=fakeSpawn(c=>{c.stdout.write(Buffer.alloc(2048));});
 const r2=await runSsh(['x'],{spawnImpl:big.spawnImpl,maxStdout:1024});assert.equal(r2.error,'too-large');assert.equal(big.calls[0].child.killed,'SIGKILL');
 const hang=fakeSpawn(()=>{});
 const r3=await runSsh(['x'],{spawnImpl:hang.spawnImpl,timeoutMs:20});assert.equal(r3.error,'timeout');assert.equal(hang.calls[0].child.killed,'SIGKILL');
 const missing=fakeSpawn(c=>c.emit('error',Object.assign(new Error('spawn ssh ENOENT'),{code:'ENOENT'})));
 assert.equal((await runSsh(['x'],{spawnImpl:missing.spawnImpl})).error,'no-ssh');
});

test('ssh failures become codes with a sentence each; stderr is never passed on',async()=>{
 const cases=[['Host key verification failed.','host-key-unknown'],['No ED25519 host key is known for win and you have requested strict checking.','host-key-unknown'],
  ['@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@','host-key-changed'],['alice@pc: Permission denied (publickey,keyboard-interactive).','denied'],
  ['ssh: Could not resolve hostname nope: nodename nor servname provided','unresolved'],['ssh: connect to host pc port 22: Connection refused','refused'],
  ['ssh: connect to host pc port 22: Operation timed out','timeout'],['ssh: connect to host pc port 22: No route to host','unreachable'],
  ['/x/.ssh/config: line 3: Bad configuration option: foo','ssh-config']];
 for(const [stderr,code] of cases){assert.equal(classifySsh({code:255,stderr}),code,stderr);assert.ok(WINDOWS_ERRORS[code],code);}
 assert.equal(classifySsh({code:255,stderr:'something else'}),'ssh');
 assert.equal(classifySsh({code:1,stderr:"'powershell.exe' is not recognized as an internal or external command"}),'no-powershell');
 assert.equal(classifySsh({code:0,stderr:''}),null);assert.equal(classifySsh({error:'timeout'}),'timeout');
 const run=async()=>({code:255,stdout:'',stderr:'Permission denied (publickey). secret-looking /path/id_key',error:null});
 await assert.rejects(collectWindows('win',{run}),e=>e.message==='denied'&&!JSON.stringify(e).includes('id_key'));
 await assert.rejects(collectWindows('win',{run:async()=>({code:0,stdout:'#< CLIXML\nnot it',stderr:'',error:null})}),/bad-output/);
 for(const code of Object.keys(WINDOWS_ERRORS))assert.ok(WINDOWS_ERRORS[code].length>10,code);
});

test('collector output: the real script output parses; CLIXML noise, missing classes and junk are handled',async()=>{
 const a=parseCollectorOutput('#< CLIXML\r\n'+await fixture(1));
 assert.equal(a.os.caption,'Microsoft Windows 11 Pro');assert.equal(a.os.memTotal,67027988*1024);
 assert.equal([...a.cpu.keys()].filter(k=>/^\d+$/.test(k)).length,24);assert.equal(typeof a.cpu.get('_Total').ts,'bigint','counters stay exact');
 assert.deepEqual(a.volumes.map(v=>v.mount),['C:','D:','E:','G:']);assert.ok(a.gmem.length>=1);assert.equal(a.adapters[0].name,'AMD Radeon RX 6900 XT');
 for(const junk of ['','HHWIN1 not json','HHWIN1 []','HHWIN1 {"v":2}','plain text'])assert.throws(()=>parseCollectorOutput(junk),/bad-output/,junk);
 // A machine without GPU counters, a page file or volumes: empty and null, never zero.
 const bare=parseCollectorOutput('HHWIN1 '+JSON.stringify({v:1,t:1,os:['Windows Server','10.0.20348','8388608',null],cpu:[['0','10','100'],['_Total','10','100']],avail:'4294967296',page:[],vol:[],disk:[],net:[],gts:null,gpu:[],gmem:[],adapters:[]}));
 assert.equal(bare.swapUsed,null);assert.equal(bare.disk,null);assert.equal(bare.gmem.length,0);assert.equal(bare.os.bootUnix,null);
 const r=deriveReading(null,bare,100);
 assert.equal(r.cpu,null,'one snapshot has no interval: no CPU figure');assert.equal(r.gpu,null,'no GPU counters: null, not 0');
 assert.equal(r.memUsed,4294967296);assert.deepEqual([r.power,r.cpuTemp,r.gpuTemp,r.diskRead,r.netRx,r.swapUsed],[null,null,null,null,null,null]);
 // Strings in odd shapes are cut and cleaned, unknown rows dropped.
 const odd=parseCollectorOutput('HHWIN1 '+JSON.stringify({v:1,os:['x\u0000y'.repeat(100)],cpu:[['0','-5','1'],'junk',[null,'1','2']],vol:[['C:',null,'NTFS','not a number','1']]}));
 assert.ok(odd.os.caption.length<=120&&!odd.os.caption.includes('\u0000'));assert.equal(odd.cpu.size,0);assert.equal(odd.volumes[0].size,null);
});

test('readings: the real pair gives interval averages; per-core, memory, disk and network; sensors null',async()=>{
 const a=parseCollectorOutput(await fixture(1)),b=parseCollectorOutput(await fixture(2));
 const r=deriveReading(a,b,Math.round(b.t/1000));
 assert.ok(r.span>1&&r.span<60,`span ${r.span}`);
 assert.ok(r.cpu>=0&&r.cpu<=100);assert.equal(r.cores.length,24);assert.ok(r.cores.every(v=>v>=0&&v<=100));
 assert.ok(r.memUsed>0&&r.memUsed<r.memTotal);assert.ok(r.diskRead>=0&&r.diskWrite>=0&&r.netRx>=0);
 assert.ok(r.gpu>=0&&r.gpu<=100);assert.equal(r.gpus[0].name,'AMD Radeon RX 6900 XT');assert.ok(r.gpus[0].memUsed>0);
 assert.deepEqual([r.power,r.cpuTemp,r.gpuTemp,r.memPressure],[null,null,null,null]);
 // Reversed (counters went back): no rate is made up.
 const back=deriveReading(b,a,Math.round(a.t/1000));assert.equal(back.cpu,null);assert.equal(back.span,null);
});

// Two synthetic snapshots for exact GPU arithmetic. Elapsed 10 s = 1e8 units of 100 ns.
const SEC=10_000_000n,L1='luid_0x00000000_0x0000AAAA_phys_0',L2='luid_0x00000000_0x0000BBBB_phys_0';
const snap=(gpu,ts)=>({gpuTs:ts,gpu:new Map(Object.entries(gpu).map(([k,v])=>[k,BigInt(v)])),gmem:[{id:L1,dedicated:1e9,shared:0},{id:L2,dedicated:2e9,shared:0}],adapters:[{name:'GPU A',memTotal:8e9},{name:'GPU B',memTotal:16e9}],
 cpu:new Map([['_Total',{idle:0n,ts}]]),os:{memTotal:null},avail:null,swapUsed:null,disk:null,net:[],volumes:[],cpuName:[]});
test('GPU: per engine (summed over its processes, capped at 100 %), then the busiest engine per device; never a sum of engines',()=>{
 const e=(pid,luid,eng,type)=>`pid_${pid}_${luid}_eng_${eng}_engtype_${type}`;
 const prev=snap({[e(1,L1,0,'3D')]:0,[e(2,L1,0,'3D')]:0,[e(1,L1,1,'Copy')]:0,[e(3,L2,0,'3D')]:5*Number(SEC),[e(9,L2,4,'Video Decode')]:0},0n);
 const cur=snap({
  [e(1,L1,0,'3D')]:3*Number(SEC),[e(2,L1,0,'3D')]:4*Number(SEC),// two processes on one engine: 30 % + 40 % = 70 %
  [e(1,L1,1,'Copy')]:9*Number(SEC),// another engine of the same GPU at 90 %: the GPU is at 90 %, not 160 %
  [e(3,L2,0,'3D')]:5*Number(SEC)+8*Number(SEC),[e(4,L2,0,'3D')]:6*Number(SEC),// 80 % + a new process with 60 % = capped at 100 %
  // pid 9 exited: its engine simply has nothing this time
 },10n*SEC);
 const gpus=gpuDevices(prev,cur);
 const by=Object.fromEntries(gpus.map(g=>[g.id,g]));
 assert.equal(by[L1].util,90);assert.equal(by[L1].engine,'Copy');
 assert.equal(by[L2].util,100,'one engine never reads above 100 %');
 assert.ok(gpus.every(g=>g.util<=100));assert.equal(gpus[0].name,null,'two GPUs: the counters do not say which adapter is which');
 const r=deriveReading({...prev,cpu:new Map([['_Total',{idle:0n,ts:0n}]])},{...cur,cpu:new Map([['_Total',{idle:5n*SEC,ts:10n*SEC}]])},10);
 assert.equal(r.gpu,100,'the machine shows its busiest GPU');assert.equal(r.cpu,50);assert.equal(r.vramUsed,3e9);
 // A counter that went backwards (a reused pid) counts as a new instance.
 const reset=gpuDevices(snap({[e(5,L1,0,'3D')]:9*Number(SEC)},0n),snap({[e(5,L1,0,'3D')]:2*Number(SEC)},10n*SEC));
 assert.equal(reset.find(g=>g.id===L1).util,20);
 // No active engine at all, but the counters exist: 0 %, a real measurement.
 assert.equal(deriveReading({...snap({},0n)},{...snap({},10n*SEC),cpu:new Map([['_Total',{idle:10n*SEC,ts:10n*SEC}]])},10).gpu,0);
});

test('poller: bounded and honest — no overlap, interval floor, failures, removed and re-targeted hosts',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'win-poller-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const [one,two]=[parseCollectorOutput(await fixture(1)),parseCollectorOutput(await fixture(2))];
 let clock=two.t,calls=[],next=[];
 const collect=target=>{calls.push(target);const step=next.shift();return step instanceof Error?Promise.reject(step):typeof step==='function'?step():Promise.resolve(step);};
 const p=createWindowsPoller({stateDirectory:dir,hosts:async()=>[{id:'pc',target:'pc-windows'}],intervalMs:1000,collect,now:()=>clock});
 assert.equal(p.interval().intervalSeconds,WINDOWS_MIN_INTERVAL_MS/1000,'never faster than the floor');
 assert.equal(p.setIntervalMs(15000),WINDOWS_MIN_INTERVAL_MS);assert.equal(p.setIntervalMs(60000),60000);
 next=[{...one,t:clock}];await p.start();p.stop();
 assert.deepEqual(calls,['pc-windows']);
 let ring=p.seconds('pc');assert.equal(ring.length,1);assert.equal(ring[0].cpu,null,'the first snapshot has no interval');assert.ok(ring[0].memUsed>0);
 assert.equal(p.status().pc.state,'up');assert.equal(p.disks().pc.disks.length,4);assert.equal(p.native().pc.sensors,'unsupported');
 clock+=30000;next=[{...two,t:clock}];await p.poll();
 ring=p.seconds('pc');assert.equal(ring.length,2);assert.ok(ring[1].cpu!=null&&ring[1].span>0);assert.equal(ring[1].t,Math.round(clock/1000),'stamped when it was read');
 // A poll in flight is shared, never doubled.
 clock+=30000;let release;next=[()=>new Promise(r=>{release=()=>r({...two,t:clock});})];
 const first=p.poll(),second=p.poll();assert.equal(first,second);release();await first;assert.equal(calls.length,3);
 // Offline: the code is kept, the chain is broken (no average across the gap), the old readings stay.
 clock+=30000;next=[new Error('timeout')];await p.poll();
 assert.deepEqual([p.status().pc.state,p.status().pc.error],['down','timeout']);assert.equal(p.seconds('pc').length,3);
 clock+=30000;next=[{...two,t:clock}];await p.poll();assert.equal(p.seconds('pc').at(-1).cpu,null,'after a failure the next snapshot starts a new interval');
 clock+=30000;next=[new Error('denied')];await p.poll();assert.equal(p.status().pc.state,'denied');
 // Re-targeted while a poll runs: the late answer belongs to the old target and is dropped.
 clock+=30000;next=[()=>new Promise(r=>{release=()=>r({...two,t:clock+1000});})];const late=p.poll();
 p.addHost({id:'pc',target:'pc-new'});release();await late;
 assert.equal(p.status().pc,undefined,'nothing from the old target lands on the new one');
 assert.equal(p.live().pc,undefined,'a new target cannot display the old target live data');
 assert.deepEqual(p.seconds('pc'),[],'retargeting starts a new counter chain and live ring');
 // Removed: forgotten at once.
 p.removeHost('pc');assert.deepEqual(p.hosts(),[]);assert.deepEqual(p.seconds('pc'),[]);assert.deepEqual(p.status(),{});
 p.addHost({id:'bad',target:'-oProxyCommand=x'});assert.deepEqual(p.hosts(),[],'an invalid target is never taken');
 // Paused: no ssh at all.
 await p.pause();const before=calls.length;p.addHost({id:'pc',target:'pc-windows'});await p.poll();assert.equal(calls.length,before);
});

test('poller: minute rows are kept like Thermo\'s and come back after a restart',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'win-minutes-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const b=parseCollectorOutput(await fixture(2));
 const base=Math.floor(b.t/60000)*60000;let clock=base+5000;
 const cpuSnap=(idle,ts)=>({...b,cpu:new Map([['_Total',{idle:BigInt(idle),ts:BigInt(ts)}]])});
 const seq=[cpuSnap(0,0),cpuSnap(150_000_000,300_000_000),cpuSnap(300_000_000,600_000_000)];// 50 % each 30 s
 const p=createWindowsPoller({stateDirectory:dir,hosts:async()=>[{id:'pc',target:'pc'}],collect:async()=>({...seq.shift(),t:clock}),now:()=>clock});
 await p.start();p.stop();clock+=30000;await p.poll();clock+=30000;await p.poll();// the third reading is in the next minute
 const rows=p.minutes('pc');assert.equal(rows.length,1);assert.equal(rows[0].t,base/1000);assert.equal(rows[0].cpu,50);assert.equal(rows[0].power,null);
 await new Promise(r=>setTimeout(r,20));
 const again=createWindowsPoller({stateDirectory:dir,hosts:async()=>[],collect:async()=>{throw new Error('x');}});await again.start();again.stop();
 assert.equal(again.minutes('pc').length,1);
 const [file]=await readdir(path.join(dir,'windows'));assert.match(file,/^minutes-pc-\d{4}-\d{2}\.jsonl$/);assert.equal((await stat(path.join(dir,'windows',file))).mode&0o777,0o600);
});

test('device store: Windows is connected to an existing device in place; older records keep their hash',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'win-devices-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 // A file written before platforms existed: the hash a client read then still matches.
 const legacy={id:'desk',name:'Desk',kind:'other',hostname:'desk.example.lan',ip:null,props:{cpu:'',gpu:'',ramGb:null,diskTotalBytes:null},image:false,createdAt:'2026-01-01T00:00:00Z',createdBy:'admin'};
 await writeFile(path.join(dir,'devices.json'),JSON.stringify({schema:1,devices:[legacy]}));
 const d=createHomeDevices(dir,{reserved:SITE.machines.map(m=>m.id)});
 const old=createHash('sha256').update(JSON.stringify({id:'desk',name:'Desk',hostname:'desk.example.lan',ip:null,role:'other',hardware:{cpu:'',gpu:'',ramGb:null,diskTotalBytes:null},thermoId:null,picture:null})).digest('hex');
 const [desk]=await d.list();assert.equal(machineHash(desk),old);assert.equal(desk.platform,null);assert.equal(desk.telemetryProvider,null);
 // Connect it (the user added it as a plain tile earlier): same id, same creation, no new device.
 assert.throws(()=>d.setWindows('desk',{target:'-oProxyCommand=x'}),/invalid/);
 assert.throws(()=>d.setWindows('desk',{target:'pc',extra:1}),/invalid/);
 const r=await d.setWindows('desk',{target:'pc-windows'});
 assert.deepEqual(r.windows,{id:'desk',target:'pc-windows'});assert.equal(r.device.platform,'windows');assert.equal(r.device.createdAt,'2026-01-01T00:00:00Z');
 assert.equal((await d.list()).length,1);assert.deepEqual(await d.windowsHosts(),[{id:'desk',target:'pc-windows'}]);
 assert.equal((await stat(path.join(dir,'windows-hosts.json'))).mode&0o777,0o600);
 assert.equal((await readFile(path.join(dir,'devices.json'),'utf8')).includes('pc-windows'),false,'the target is not in the machine record agents write');
 // Re-target, then the platform rule, Thermo and agents' upserts.
 assert.deepEqual((await d.setWindows('desk',{target:'alice@pc.example.lan'})).windows,{id:'desk',target:'alice@pc.example.lan'});
 await assert.rejects(d.setThermo('desk',{port:49286,username:'u',password:'correct horse battery',pin:'ab'.repeat(32)}),/invalid/);
 const cur=(await d.list())[0];
 const up=await d.upsert({id:'desk',name:'Desk 2',hostname:'desk.example.lan',role:'computer'},{base:machineHash(cur)});
 assert.equal(up.device.platform,'windows','an upsert without platform keeps it');assert.equal(up.device.telemetryProvider,'windows','and the hub keeps its telemetry');
 await assert.rejects(d.upsert({id:'desk',name:'Desk 2',hostname:'desk.example.lan',role:'computer',thermoId:'desk'},{base:up.hash}),/invalid/);
 await assert.rejects(d.upsert({id:'desk',name:'Desk 2',hostname:'desk.example.lan',role:'computer',platform:'linux'},{base:up.hash}),/invalid/);
 // Disconnect: telemetry goes, the device stays.
 const off=await d.setWindows('desk',null);assert.equal(off.hadLogin,true);assert.equal(off.device.telemetryProvider,null);assert.deepEqual(await d.windowsHosts(),[]);
 assert.equal((await d.list()).length,1);
 // A new Windows device; its removal takes the target with it.
 const added=await d.add({name:'Gaming PC',kind:'windows',hostname:'gaming.example.lan',windows:{target:'gaming'}},'admin');
 assert.equal(added.device.platform,'windows');assert.deepEqual(added.windows,{id:'gaming-pc',target:'gaming'});
 assert.throws(()=>d.add({name:'X',kind:'windows',hostname:'x.example.lan',platform:'macos',windows:{target:'x'}},'a'),/invalid/);
 assert.throws(()=>d.add({name:'X',kind:'other',hostname:'x.example.lan',windows:{target:'x'}},'a'),/invalid/);
 assert.throws(()=>d.add({name:'X',kind:'windows',hostname:'x.example.lan',windows:{target:'$(id)'}},'a'),/invalid/);
 const gone=await d.remove('gaming-pc');assert.equal(gone.hadWindows,true);assert.deepEqual(await d.windowsHosts(),[]);
 // Platform without telemetry, and a plain tile from before stays exactly as it was.
 const mac=await d.add({name:'Mac',kind:'other',hostname:'mac.example.lan',platform:'macos'},'a');assert.equal(mac.device.platform,'macos');
 assert.equal(normalizeDevice({...legacy}).platform,null);
});

test('overview: a Windows device reads like any machine with telemetry; what Windows lacks is null',async()=>{
 const a=parseCollectorOutput(await fixture(1)),b=parseCollectorOutput(await fixture(2));
 const nowSec=Math.round(b.t/1000);
 const reading=deriveReading(a,b,nowSec);const {gpus,cores,...row}=reading;
 const windows={status:()=>({pc:{state:'up'}}),live:()=>({pc:{at:b.t,reading:row}}),seconds:()=>[row],minutes:()=>[],disks:()=>({pc:{disks:[{name:'C:',mount:'C:',fs:'NTFS',used:1,total:2}]}}),
  native:()=>({pc:{provider:'windows',cpu:{cores},gpus,sensors:'unsupported'}}),hosts:()=>['pc'],targets:()=>({pc:'pc-windows'}),interval:()=>({intervalSeconds:30,lastPollAt:null})};
 const thermo={status:()=>({pc:{state:'down'}}),live:()=>({}),seconds:()=>[{t:nowSec,cpu:99}],minutes:()=>[],disks:()=>({}),hosts:()=>[],interval:()=>({intervalSeconds:15,lastPollAt:null})};
 const added=[normalizeDevice({id:'pc',name:'PC',hostname:'pc.example.lan',role:'computer',platform:'windows',telemetryProvider:'windows',props:{}}),
  normalizeDevice({id:'box',name:'Box',hostname:'box.example.lan',role:'computer',props:{}})];
 const home=buildHome({site:SITE,added,thermo:telemetrySources({thermo,windows,windowsIds:['pc']}),now:b.t});
 const pc=home.machines.find(m=>m.id==='pc'),box=home.machines.find(m=>m.id==='box');
 assert.equal(pc.kind,'thermo');assert.equal(pc.platform,'windows');assert.equal(pc.online,'online');
 assert.deepEqual([pc.telemetry.state,pc.telemetry.provider,pc.telemetry.thermoId,pc.telemetry.hostId,pc.telemetry.target],['ok','windows',null,'pc','pc-windows']);
 assert.equal(pc.quad.cpu,row.cpu,'its own poller, not Thermo\'s readings for the same id');
 assert.deepEqual([pc.quad.power,pc.quad.temp,pc.quad.gpuMem],[null,null,null]);
 assert.equal(pc.volumes[0].mount,'C:');assert.equal(pc.native.sensors,'unsupported');
 assert.equal(box.telemetry.state,'not-installed');assert.equal(box.native,null);assert.equal(box.platform,null);
 assert.ok(home.telemetry.adapters.some(x=>x.id==='windows'&&x.connect==='ssh'));
 // Unreachable: the collector's code and what to do.
 const down=buildHome({site:SITE,added,thermo:telemetrySources({thermo,windows:{...windows,status:()=>({pc:{state:'down',error:'host-key-unknown'}}),seconds:()=>[],live:()=>({})},windowsIds:['pc']}),now:b.t});
 const t2=down.machines.find(m=>m.id==='pc').telemetry;
 assert.deepEqual([t2.state,t2.reason,t2.detail],['unreachable','down','host-key-unknown']);assert.equal(t2.hint,WINDOWS_ERRORS['host-key-unknown']);
});

test('one reading per poll fills the steps it covers, never more; Thermo rows are left alone',()=>{
 assert.deepEqual(spreadSpans([{t:100,span:30,cpu:1}],10).map(r=>r.t),[80,90,100]);
 assert.deepEqual(spreadSpans([{t:100,cpu:1}],10).map(r=>r.t),[100]);
 const mem=spreadSpans([{t:100,span:30,cpu:1,memUsed:42,memTotal:64,swapUsed:2,vramUsed:8}],10);
 assert.deepEqual(mem.map(r=>r.memUsed),[null,null,42],'instantaneous memory is never backfilled into past rate intervals');
 assert.deepEqual(mem.map(r=>r.vramUsed),[null,null,8]);
 assert.equal(spreadSpans([{t:1000,span:900,cpu:1}],10).length,12,'at most two minutes back');
 const now=10_000,rows=[{t:now-35,span:30,cpu:40},{t:now-5,span:30,cpu:60}];
 const spark=sparkFor({seconds:()=>rows},'pc',now);
 assert.deepEqual(spark.values.slice(-7),[null,40,40,40,60,60,60],'no gap between polls, no value before the first one');
 const h=homeHistory({seconds:()=>rows,minutes:()=>[]},'pc','30m',now,['pc']);
 assert.equal(h.points.filter(p=>p.cpu!=null).length,2);
});

test('HTTP: test, connect in place, add and disconnect; hostile targets and API keys never reach ssh',async t=>{
 const checked=[],added=[],removed=[];
 const windowsPoller={addHost:c=>added.push(c),removeHost:id=>removed.push(id),start:async()=>{},status:()=>({}),live:()=>({}),seconds:()=>[],minutes:()=>[],disks:()=>({}),native:()=>({}),hosts:()=>[],targets:()=>Object.fromEntries(added.map(c=>[c.id,c.target])),
  interval:()=>({intervalSeconds:30,lastPollAt:null}),setIntervalMs:()=>30000,refresh:async()=>false,pause:async()=>{},resume:async()=>{}};
 const result={ok:true,target:'pc-windows',os:{caption:'Windows 11',version:'10.0'},cpu:{name:'CPU',logical:8},memTotal:16e9,volumes:[],gpus:[],gpuCounters:false,sensors:'unsupported'};
 const h=await hub(t,{windowsPoller,checkWindows:async target=>{checked.push(target);if(target==='locked')throw new Error('host-key-unknown');if(target==='refused')throw new Error('denied');return {...result,target};}});
 for(const target of ['-oProxyCommand=id','a b','$(id)',''])assert.equal((await h.post('/api/home/devices/windows/check',{target},h.admin)).status,400,target);
 assert.equal((await h.post('/api/home/devices/windows/check',{target:'pc',extra:1},h.admin)).status,400);
 assert.deepEqual(checked,[],'nothing invalid was ever tried');
 const ok=await h.post('/api/home/devices/windows/check',{target:'pc-windows'},h.admin);assert.equal(ok.status,200);assert.equal((await ok.json()).os.caption,'Windows 11');
 const locked=await h.post('/api/home/devices/windows/check',{target:'locked'},h.admin);assert.equal(locked.status,422);
 const body=await locked.json();assert.deepEqual([body.error.code,body.error.reason],['WINDOWS_SSH_FAILED','host-key-unknown']);assert.equal(body.error.message,WINDOWS_ERRORS['host-key-unknown']);
 const agent=await h.account('agent',['read','home:write']);
 assert.equal((await fetch(`${h.origin}/api/home/devices/windows/check`,{method:'POST',headers:{...agent.headers,'Content-Type':'application/json'},body:JSON.stringify({target:'pc'})})).status,403,'API keys never start ssh');
 // A device an agent added as a plain tile is connected in place, after a successful test.
 const made=await fetch(`${h.origin}/api/home/machines`,{method:'POST',headers:{...agent.headers,'Content-Type':'application/json'},body:JSON.stringify({machine:{id:'gaming',name:'Gaming',hostname:'gaming.example.lan'}})});
 assert.equal(made.status,201);
 const refused=await h.post('/api/home/devices/windows',{id:'gaming',windows:{target:'refused'}},h.admin);assert.equal(refused.status,422);assert.equal((await refused.json()).error.reason,'denied');
 assert.equal(added.length,0,'nothing stored after a failed test');
 const conn=await h.post('/api/home/devices/windows',{id:'gaming',windows:{target:'pc-windows'}},h.admin);assert.equal(conn.status,200);
 const dev=await conn.json();assert.equal(dev.id,'gaming');assert.equal(dev.platform,'windows');assert.deepEqual(added.at(-1),{id:'gaming',target:'pc-windows'});
 const list=await (await h.post('/api/home/devices/windows/check',{target:'pc-windows'},h.admin)).json();assert.equal(list.ok,true);
 const machines=await (await fetch(`${h.origin}/api/home/machines`,{headers:h.admin})).json();
 const m=machines.machines.find(x=>x.id==='gaming');assert.equal(m.platform,'windows');assert.ok(machines.platforms.includes('windows'));
 assert.equal(JSON.stringify(machines).includes('pc-windows'),false,'machine_list carries no SSH target');
 const page=await (await fetch(`${h.origin}/api/home`,{headers:h.admin})).json();
 const tile=page.machines.find(x=>x.id==='gaming');assert.deepEqual([tile.kind,tile.telemetry.provider,tile.telemetry.state,tile.telemetry.target],['thermo','windows','unreachable','pc-windows']);
 // A Thermo login is refused while Windows is connected; disconnect, then add a Windows device directly.
 assert.equal((await h.post('/api/home/devices/windows',{id:'gaming',windows:null},h.admin)).status,200);assert.deepEqual(removed,['gaming']);
 const created=await h.post('/api/home/devices',{name:'Office PC',kind:'windows',hostname:'office.example.lan',windows:{target:'office'}},h.admin);
 assert.equal(created.status,201);assert.equal(checked.at(-1),'office');assert.deepEqual(added.at(-1),{id:'office-pc',target:'office'});
 const failed=await h.post('/api/home/devices',{name:'Locked PC',kind:'windows',hostname:'locked.example.lan',windows:{target:'locked'}},h.admin);
 assert.equal(failed.status,422);assert.equal((await (await fetch(`${h.origin}/api/home/machines`,{headers:h.admin})).json()).machines.some(x=>x.id==='locked-pc'),false);
 const rm1=await h.post('/api/home/devices/remove',{id:'office-pc'},h.admin);assert.equal(rm1.status,200);assert.equal(removed.at(-1),'office-pc');
 // The integration lists it like Thermo.
 const ig=await (await fetch(`${h.origin}/api/admin/integrations`,{headers:h.admin})).json();
 assert.ok(JSON.stringify(ig).includes('home.windows'));
});

test('checkWindows: what the test reports, and failures as codes',async()=>{
 const text=await fixture(1);
 const run=async args=>args[0]==='-G'?{code:0,stdout:'user alice\nhostname pc.example.lan\nport 22\n',stderr:'',error:null}:{code:0,stdout:text,stderr:'',error:null};
 const r=await checkWindows('pc',{run});
 assert.deepEqual(r.resolved,{hostname:'pc.example.lan',user:'alice',port:22});assert.equal(r.cpu.logical,24);assert.equal(r.sensors,'unsupported');assert.equal(r.gpuCounters,true);
 await assert.rejects(checkWindows('-x',{run}),/invalid/);
 await assert.rejects(checkWindows('pc',{run:async args=>args[0]==='-G'?{code:0,stdout:'',stderr:''}:{code:255,stdout:'',stderr:'Host key verification failed.'}}),/host-key-unknown/);
});

// The common first-run case: start before any Windows device has been connected.
test('poller started empty keeps polling after its first host is connected',async()=>{
 const fixtureText=await fixture(1);let calls=0,clock=Date.now();
 const p=createWindowsPoller({now:()=>clock,hosts:async()=>[],collect:async()=>{calls++;return parseCollectorOutput(fixtureText);}});
 await p.start();p.stop();
 p.addHost({id:'first-pc',target:'pc-windows'});
 await p.poll();
 assert.equal(calls,1);assert.equal(p.status()['first-pc'].state,'up');
 await p.refresh();assert.equal(calls,1,'manual refresh respects the per-host minimum interval');
 clock+=30000;await p.poll();assert.equal(calls,2,'a completed initial empty poll must not latch a resolved promise');
 p.stop();
});


test('legacy aliases keep the hub account SSH agent environment',async()=>{
 const previous=process.env.SSH_AUTH_SOCK;process.env.SSH_AUTH_SOCK='/tmp/example-agent';
 try{let environment;const text=await readFile(new URL('./fixtures/windows-collector-1.txt',import.meta.url),'utf8');
  await collectWindows('example-alias',{run:async(args,options)=>{environment=options.env;return {code:0,stdout:text,stderr:'',error:null};}});
  assert.equal(environment.SSH_AUTH_SOCK,'/tmp/example-agent');
 }finally{if(previous===undefined)delete process.env.SSH_AUTH_SOCK;else process.env.SSH_AUTH_SOCK=previous;}
});
