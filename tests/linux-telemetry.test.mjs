// Linux telemetry (server/linux-telemetry.mjs, server/prom-text.mjs): the text exposition parser, one mapping for
// Node Exporter and the SSH script, honest rates (first reading, gap, reset, reboot), storage counted once (ZFS
// pools, bind mounts, partitions, virtual interfaces), and a collector that never sends credentials over HTTP.
// Every fixture is synthetic: generic names and placeholder addresses only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {parsePromText} from '../server/prom-text.mjs';
import {snapshotFromMetrics,deriveLinuxReading,linuxVolumes,linuxNative,linuxCheck,parseLinuxOutput,collectNodeExporter,collectLinuxSsh,
 LINUX_SCRIPT,LINUX_REMOTE_COMMAND,validUnixUser,validExporterRecord,exporterInfo,NODE_EXPORTER_ERRORS,LINUX_SSH_ERRORS,EXPORTER_METRICS} from '../server/linux-telemetry.mjs';

import {exposition} from './fixtures/node-exporter.mjs';
const metrics=o=>parsePromText(exposition(o),new Set(EXPORTER_METRICS));

test('text exposition: escapes, non-finite values, timestamps, duplicates; malformed wanted lines fail the scrape',()=>{
 const m=parsePromText('# HELP x y\n# TYPE x gauge\nx{a="q\\"uo\\\\te\\nnl",b="2",} 1.5e3 1700000000000\nx{a="nan"} NaN\nx{a="inf"} +Inf\nx{b="2",a="q\\"uo\\\\te\\nnl"} 7\ny 3\n# EOF\n');
 assert.deepEqual(m.get('x'),[{labels:{a:'q"uo\\te\nnl',b:'2'},value:7,ts:null}],'last duplicate wins; NaN and Inf are dropped');
 assert.equal(m.get('y')[0].value,3);
 assert.equal(parsePromText('x{a="1"} 2 1700000000000\n').get('x')[0].ts,1700000000000);
 for(const bad of ['x{a="\\q"} 1','x{a=1} 1','x{a="1"','x{a="1",a="2"} 1','x 1 2 3','x abc','{a="1"} 1','x{a="1"}1','x 1 1.5'])
  assert.throws(()=>parsePromText(bad+'\n'),/bad-metrics/,bad);
 assert.equal(parsePromText('other{a="\\q"} 1\nx 1\n',new Set(['x'])).get('x')[0].value,1,'unwanted lines are skipped unread');
 assert.throws(()=>parsePromText('x 1\n'.repeat(10),null,{bytes:1e6,lines:5,lineLength:100,samples:10,labels:4,labelValue:10}),/bad-metrics/,'line cap');
 assert.throws(()=>parsePromText(`x{a="${'v'.repeat(20)}"} 1\n`,null,{bytes:1e6,lines:5,lineLength:100,samples:10,labels:4,labelValue:10}),/bad-metrics/,'label value cap');
});

test('Node Exporter snapshot: CPU per core without guest time, memory, one volume per pool or device, physical disks and interfaces only',()=>{
 const s=snapshotFromMetrics(metrics());
 assert.equal(s.cpu.size,3);assert.equal(s.cpu.get('0').total,1000+10+100+50,'guest is already inside user and is not counted twice');
 assert.equal(s.mem.total,16e9);assert.equal(s.mem.available,4e9);assert.equal(s.load,null,'a NaN load is missing, never 0');
 assert.deepEqual(linuxVolumes(s).map(v=>[v.name,v.total]),[['/',1e11],['boot (ZFS · /boot)',2e11],['pool (ZFS · /mnt/pool)',4e12]],'sorted by mount; the least nested dataset stands for its pool');
 const sizes=linuxVolumes(s).map(v=>v.total);assert.equal(sizes.filter(x=>x===4e12).length,1,'ZFS datasets of one pool count once');assert.equal(sizes.filter(x=>x===1e11).length,1,'a bind mount counts once');
 assert.ok(!linuxVolumes(s).some(v=>/tmpfs|overlay|docker/.test(v.fs+v.name)));
 assert.deepEqual([...s.disks.keys()],['nvme0n1'],'no partitions, device-mapper or loop devices');assert.deepEqual([...s.net.keys()],['eth0'],'no loopback, bridge or veth');
 assert.equal(s.cpuTemp,47,'the package sensor of the CPU chip');assert.equal(s.os.name,'Debian GNU/Linux 12 (bookworm)');assert.equal(s.os.uptimeSeconds,10000);
 const c=linuxCheck(s);assert.equal(c.cpu.logical,2);assert.equal(c.sensors,'reported');assert.deepEqual(c.gpus,[]);
});

test('rates: only between two snapshots of one boot within five minutes; a reset is never averaged; GPU and power stay null',()=>{
 const a=snapshotFromMetrics(metrics({at:1_700_000_000})),b=snapshotFromMetrics(metrics({at:1_700_000_030,k:2}));
 const first=deriveLinuxReading(null,a,1);assert.deepEqual([first.cpu,first.diskRead,first.netRx,first.span],[null,null,null,null]);assert.ok(first.memUsed>0);
 const r=deriveLinuxReading(a,b,2);
 assert.equal(r.span,30);assert.equal(r.diskRead,Math.round(1e6/30));assert.equal(r.netRx,Math.round(3e6/30));
 assert.ok(r.cpu>0&&r.cpu<100);assert.equal(r.cores.length,2);assert.deepEqual([r.gpu,r.power,r.vramUsed],[null,null,null]);
 const gap=snapshotFromMetrics(metrics({at:1_700_000_000+301,k:2}));assert.equal(deriveLinuxReading(a,gap,3).cpu,null,'a gap longer than five minutes');
 const reboot=snapshotFromMetrics(metrics({at:1_700_000_030,k:2,boot:1_700_000_010}));assert.equal(deriveLinuxReading(a,reboot,3).diskRead,null,'a reboot');
 const reset=snapshotFromMetrics(metrics({at:1_700_000_030,k:0.5}));const rr=deriveLinuxReading(a,reset,3);
 assert.deepEqual([rr.diskRead,rr.netRx,rr.cpu],[null,null,null],'counters that went back give no rate');
 const n=linuxNative(b,r,'2026-01-01T00:00:00Z');assert.equal(n.provider,'node-exporter');assert.equal(n.temps.length,2);assert.deepEqual(n.gpus,[]);
});

test('SSH script: one line of read-only POSIX sh that any login shell passes on unchanged; its output means the same',()=>{
 assert.doesNotMatch(LINUX_SCRIPT,/['\\!\n]/,'no quote, backslash, ! or line break');
 assert.match(LINUX_REMOTE_COMMAND,/^env LC_ALL=C \/bin\/sh -c '/);
 assert.doesNotMatch(LINUX_SCRIPT,/sudo|rm |mv |cp |tee|>\s*\/(?!dev\/null)|curl|wget|apt|dnf|yum|python|chmod|kill/,'reads only');
 const out=['motd line','HHLNX1','@t','1700000030','@uptime','10030.50 99.0','@stat','cpu  200 0 100 2000 20 0 0 0 0 0','cpu0 100 0 50 1000 10 0 0 0 0 0','cpu1 100 0 50 1000 10 0 0 0 0 0',
  '@mem','MemTotal:       16000000 kB','MemAvailable:    4000000 kB','SwapTotal: 0 kB','SwapFree: 0 kB','@load','0.50 0.25 0.10 1/100 42',
  '@disk',' 259 0 nvme0n1 10 0 2000 5 20 0 4000 1 0 0 0','259 1 nvme0n1p1 10 0 1000 5 20 0 3000 1 0 0 0','@net','Inter-|   Receive','eth0: 3000 1 0 0 0 0 0 0 1000 1 0 0 0 0 0 0','lo: 9 9 0 0 0 0 0 0 9 9 0 0 0 0 0 0',
  '@mounts','/dev/sda1 / ext4 rw 0 0','/dev/sda1 /srv/my\\040bind ext4 rw 0 0','pool /mnt/pool zfs rw 0 0','pool/a /mnt/pool/a zfs rw 0 0','tmpfs /run tmpfs rw 0 0',
  '@df','Filesystem 1024-blocks Used Available Capacity Mounted on','/dev/sda1 1000 400 600 40% /','/dev/sda1 1000 400 600 40% /srv/my bind','pool 4000 1000 3000 25% /mnt/pool','pool/a 3500 500 3000 15% /mnt/pool/a','tmpfs 10 0 10 0% /run',
  '@os','PRETTY_NAME="Test Linux 1"','6.1.0-test','aarch64','@cpuinfo','model name	: Test CPU','@hwmon','cpu_thermal|temp1_input||48500','@end'].join('\n');
 const s=parseLinuxOutput(out);
 assert.equal(s.source,'linux-ssh');assert.equal(s.cpu.get('all').total,2320);assert.equal(s.mem.total,16000000*1024);
 assert.deepEqual(linuxVolumes(s).map(v=>v.name),['/','pool (ZFS · /mnt/pool)']);assert.deepEqual([...s.disks.keys()],['nvme0n1']);assert.deepEqual([...s.net.keys()],['eth0']);
 assert.equal(s.cpuTemp,48.5);assert.equal(s.os.arch,'aarch64');assert.equal(s.os.uptimeSeconds,10031);assert.equal(s.cpuName,'Test CPU');
 assert.throws(()=>parseLinuxOutput('no marker'),/bad-output/);assert.throws(()=>parseLinuxOutput('HHLNX1\n@t\n1\n'),/bad-output/,'cut off before the end');
 for(const u of ['alice','_svc','a.b-c']) assert.ok(validUnixUser(u));for(const u of ['-x','a b','a;b','$(id)','a'.repeat(33),'ali\'ce'])assert.ok(!validUnixUser(u),u);
});

test('Node Exporter collector: GET /metrics only; credentials only over verified HTTPS; failures are codes',async()=>{
 const calls=[];const reply=(status,body,type='text/plain; version=0.0.4')=>async o=>{calls.push(o);if(status!==200)throw Object.assign(new Error('http'),{status,body:Buffer.from(body)});return {status,headers:{'content-type':type},body:Buffer.from(body)};};
 const plain={mode:'node-exporter',host:'10.0.0.21',port:9100,scheme:'http',tls:null,user:null,password:null};
 const s=await collectNodeExporter(plain,{request:reply(200,exposition())});
 assert.equal(s.cpu.size,3);assert.equal(calls[0].path,'/metrics');assert.equal(calls[0].trust,null);assert.ok(!('Authorization' in calls[0].headers));assert.equal(calls[0].method,undefined);
 assert.ok(!validExporterRecord({...plain,user:'u',password:'p'.repeat(10)}),'a stored record never has credentials over HTTP');
 const tlsRec={...plain,scheme:'https',tls:{mode:'pin',pin:'a'.repeat(64)},user:'homehub',password:'correct-horse'};
 await collectNodeExporter(tlsRec,{request:reply(200,exposition())});
 assert.deepEqual(calls.at(-1).trust,{mode:'pin',pin:'a'.repeat(64)});assert.match(calls.at(-1).headers.Authorization,/^Basic /);
 assert.deepEqual(exporterInfo({record:tlsRec}),{mode:'node-exporter',host:'10.0.0.21',port:9100,scheme:'https',tls:{mode:'pin',fingerprint:'a'.repeat(64)},auth:'basic',user:'homehub'});
 assert.ok(!JSON.stringify(exporterInfo({record:tlsRec})).includes('correct-horse'));
 for(const [status,code,rec] of [[401,'denied',tlsRec],[401,'needs-auth',plain],[404,'not-exporter',plain],[500,'http',plain]])
  await assert.rejects(collectNodeExporter(rec,{request:reply(status,'')}),new RegExp(code));
 await assert.rejects(collectNodeExporter(plain,{request:reply(400,'Client sent an HTTP request to an HTTPS server.')}),/plain-http/);
 await assert.rejects(collectNodeExporter(plain,{request:reply(200,'<html>','text/html')}),/bad-output/);
 await assert.rejects(collectNodeExporter(plain,{request:reply(200,'node_cpu_seconds_total{cpu="0" 1\n')}),/bad-output/);
 await assert.rejects(collectNodeExporter(plain,{request:async()=>{throw new Error('tls-pin');}}),/tls-pin/);
 // A Prometheus server's own /metrics on the Node Exporter provider: named as such, never a "connection works".
 await assert.rejects(collectNodeExporter({...plain,port:9090},{request:reply(200,'# HELP prometheus_build_info x\n# TYPE prometheus_build_info gauge\nprometheus_build_info{version="3.0.0"} 1\nprocess_cpu_seconds_total 1.5\n')}),/is-prometheus/);
 for(const code of ['denied','tls-pin','not-exporter','plain-http','is-prometheus'])assert.ok(NODE_EXPORTER_ERRORS[code]);
});

test('Linux SSH collector: the hub\'s own key and known_hosts, the POSIX user rule, the fixed command; shell failures named',async()=>{
 const record={mode:'managed',os:'linux',host:'10.0.0.22',port:22,user:'homehub',keyId:'k'+'1'.repeat(32),connId:'c'+'2'.repeat(32),keyFingerprint:'SHA256:'+'A'.repeat(43),
  hostKey:{type:'ssh-ed25519',key:'A'.repeat(68),fingerprint:'SHA256:'+'B'.repeat(43)}};
 const vault={spec:async r=>({host:r.host,port:r.port,user:r.user,keyFile:'/state/home/ssh/keys/'+r.keyId,knownHosts:'/state/home/ssh/known_hosts/'+r.connId,empty:'/state/home/ssh/empty',alias:'hh-222222222222'})};
 let args;const run=async a=>{args=a;return {code:1,stdout:'',stderr:'This account is currently not available.',error:null};};
 await assert.rejects(collectLinuxSsh(record,{vault,run,platform:'linux'}),/no-shell/);
 assert.equal(args.at(-1),LINUX_REMOTE_COMMAND);assert.ok(args.includes('IdentitiesOnly=yes')&&args.includes('StrictHostKeyChecking=yes'));assert.equal(args[args.indexOf('-l')+1],'homehub');
 await assert.rejects(collectLinuxSsh({...record,user:'-oProxyCommand=x'},{vault,run}),/invalid/);
 await assert.rejects(collectLinuxSsh(record,{vault,run:async()=>({code:255,stdout:'',stderr:'Permission denied (publickey).',error:null}),platform:'linux'}),/denied/);
 for(const code of ['no-shell','collector','denied','host-key-changed'])assert.ok(LINUX_SSH_ERRORS[code]);
 assert.doesNotMatch(Object.entries(LINUX_SSH_ERRORS).filter(([k])=>k!=='no-ssh').map(([,v])=>v).join(' '),/Windows|PowerShell/,'Linux messages never name the other system (no-ssh is about the hub\'s own server)');
});
