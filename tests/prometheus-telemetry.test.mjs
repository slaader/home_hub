// Linux host metrics from an existing Prometheus (server/prometheus-telemetry.mjs): only GET /api/v1/query with fixed
// queries, never /metrics; exact job+instance selection with escaped literals; discovery that offers node_exporter
// targets only (not Prometheus' own) and never one with several hosts; snapshots from real scrape timestamps (stale,
// down, the same scrape twice, mixed scrapes, other targets never mix in); the poller records nothing new for an
// unchanged scrape. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {promString,snapshotQuery,promQuery,discoverTargets,scrapeFromMatrix,collectPrometheus,prometheusDriver,validPromRecord,promInfo,
 DISCOVERY_QUERIES,PROMETHEUS_ERRORS,PROM_WINDOW_SECONDS} from '../server/prometheus-telemetry.mjs';
import {createSnapshotPoller} from '../server/telemetry-poller.mjs';

const json=(data,status=200)=>({status,headers:{'content-type':'application/json'},body:Buffer.from(JSON.stringify(data))});
const ok=data=>json({status:'success',data});
const vec=list=>({resultType:'vector',result:list.map(([metric,v,ts=1700000000])=>({metric,value:[ts,String(v)]}))});
const conn={host:'10.0.0.30',port:9090,scheme:'http',tls:null,auth:null};
// One target's series at scrapes ts[], cpu counters growing by `step` per scrape.
function series({job='node',instance='host-a:9100',scrapes=[1700000000,1700000015],up=1,step=10,extra={}}={}){
 const S=(name,labels,f)=>({metric:{__name__:name,job,instance,...labels},values:scrapes.map(t=>[t,String(f((t-1700000000)/15))])});// counters follow the clock of the scrape
 return [S('up',{},()=>up),S('node_uname_info',{nodename:'host-a',release:'6.1.0',sysname:'Linux',machine:'x86_64'},()=>1),
  S('node_cpu_seconds_total',{cpu:'0',mode:'idle'},i=>1000+i*step),S('node_cpu_seconds_total',{cpu:'0',mode:'user'},i=>100+i*step),
  S('node_memory_MemTotal_bytes',{},()=>8e9),S('node_memory_MemAvailable_bytes',{},()=>2e9),
  S('node_network_receive_bytes_total',{device:'eth0'},i=>1e6+i*15e3),S('node_network_transmit_bytes_total',{device:'eth0'},i=>1e6),
  S('node_boot_time_seconds',{},()=>1699990000),S('node_time_seconds',{},i=>1700000000+i*15),
  S('node_filesystem_size_bytes',{device:'pool/a',fstype:'zfs',mountpoint:'/mnt/pool/a'},()=>4e12),S('node_filesystem_free_bytes',{device:'pool/a',fstype:'zfs',mountpoint:'/mnt/pool/a'},()=>1e12),
  ...Object.entries(extra).map(([n,v])=>S(n,{},()=>v))];
}
const matrix=list=>({resultType:'matrix',result:list});

test('PromQL: job and instance only as escaped literals in one fixed selector; no other query is ever sent',async()=>{
 assert.equal(promString('a"b\\c'),'"a\\"b\\\\c"');assert.throws(()=>promString('a\nb'),/invalid/);assert.throws(()=>promString(''),/invalid/);
 const q=snapshotQuery('node','x"} or vector(1) or {a="');
 assert.match(q,/^\{__name__=~"up\|node_cpu_seconds_total\|[A-Za-z0-9_|]+",job="node",instance="x\\"\} or vector\(1\) or \{a=\\""\}\[120s\]$/,'an injection stays inside the string literal');
 const calls=[];const request=async o=>{calls.push(o);return ok(vec([]));};
 await promQuery(conn,'up',{request});
 assert.deepEqual([calls[0].path,calls[0].query,calls[0].method],['/api/v1/query',{query:'up'},undefined],'GET /api/v1/query');
 for(const bad of ['sum(rate(x[5m]))','up or vector(1)','/metrics','label_replace(up,"a","b","c","d")'])await assert.rejects(promQuery(conn,bad,{request}),/invalid/,bad);
 await assert.rejects(promQuery({...conn,auth:{type:'bearer',token:'t'.repeat(20)}},'up',{request}),/invalid/,'never credentials over plain HTTP');
 assert.equal(calls.length,1);
 assert.ok(!JSON.stringify([...Object.values(DISCOVERY_QUERIES),snapshotQuery('a','b')]).match(/admin|lifecycle|reload|\/metrics|delete/),'read-only API only');
});

test('Prometheus API errors become codes: 404 is not Prometheus (e.g. Node Exporter port), auth, JSON errors, caps',async()=>{
 const fail=(status,body,type='application/json')=>async()=>{throw Object.assign(new Error('http'),{status,body:Buffer.from(body),headers:{'content-type':type}});};
 await assert.rejects(promQuery(conn,'up',{request:fail(404,'404 page not found','text/plain')}),/not-prometheus/);
 await assert.rejects(promQuery(conn,'up',{request:fail(401,'')}),/needs-auth/);
 await assert.rejects(promQuery({...conn,scheme:'https',tls:{mode:'ca'},auth:{type:'basic',user:'u',password:'p'.repeat(8)}},'up',{request:fail(403,'')}),/denied/);
 await assert.rejects(promQuery(conn,'up',{request:async()=>json({status:'error',errorType:'bad_data',error:'parse error'},400)}),/prom-error/);
 await assert.rejects(promQuery(conn,'up',{request:async()=>({status:200,headers:{'content-type':'text/plain'},body:Buffer.from('# HELP up')})}),/not-prometheus/,'a /metrics page is not the API');
 await assert.rejects(promQuery(conn,'up',{request:async()=>json({status:'success',data:{resultType:'vector',result:Array(20001).fill({})}})}),/too-large/);
 await assert.rejects(promQuery(conn,'up',{request:async()=>({status:200,headers:{'content-type':'application/json'},body:Buffer.from('{')})}),/bad-output/);
 for(const c of ['not-prometheus','no-targets','stale','target-down','ambiguous','prom-error'])assert.ok(PROMETHEUS_ERRORS[c]);
});

test('discovery: node_exporter targets by exact job and instance, Prometheus itself excluded, several hosts under one target not selectable',async()=>{
 const replies={node_uname_info:vec([[{__name__:'node_uname_info',job:'node',instance:'host-a:9100',nodename:'host-a',release:'6.1'},1],
   [{__name__:'node_uname_info',job:'node',instance:'host-b:9100',nodename:'host-b'},1],
   [{__name__:'node_uname_info',job:'fed',instance:'agg',nodename:'x'},1],[{__name__:'node_uname_info',job:'fed',instance:'agg',nodename:'y'},1]]),
  up:vec([[{__name__:'up',job:'node',instance:'host-a:9100'},1],[{__name__:'up',job:'node',instance:'host-b:9100'},0],[{__name__:'up',job:'prometheus',instance:'localhost:9090'},1]]),
  'timestamp(up)':vec([[{job:'node',instance:'host-a:9100'},1700000000.5],[{job:'node',instance:'host-b:9100'},1699999000]])};
 const list=await discoverTargets(conn,{request:async o=>ok(replies[o.query.query])});
 assert.deepEqual(list.map(x=>[x.job,x.instance,x.eligible,x.up]),[['fed','agg',false,null],['node','host-a:9100',true,true],['node','host-b:9100',true,false]]);
 assert.ok(!list.some(x=>x.job==='prometheus'),'Prometheus\' own target is not a host');
 assert.equal(list[1].lastSampleAt,'2023-11-14T22:13:20.500Z','the newest stored sample time, not the query time');assert.equal(list[0].reason,'ambiguous');
});

test('snapshot: the newest scrape of exactly this target; stale, down, missing and other targets handled honestly',()=>{
 const now=1700000020;
 const {metrics,scrape}=scrapeFromMatrix(matrix(series()),{job:'node',instance:'host-a:9100',nowSec:now});
 assert.equal(scrape,1700000015);assert.equal(metrics.get('node_cpu_seconds_total').length,2);assert.equal(metrics.get('node_cpu_seconds_total')[0].value,1010,'the sample of the newest scrape');
 // Another target's series in the reply (it cannot be, with an exact selector, but it is never used).
 const mixed=[...series(),...series({instance:'host-b:9100',step:1000})];
 assert.equal(scrapeFromMatrix(matrix(mixed),{job:'node',instance:'host-a:9100',nowSec:now}).metrics.get('node_cpu_seconds_total')[0].value,1010,'never another host');
 assert.throws(()=>scrapeFromMatrix(matrix(series({scrapes:[now-PROM_WINDOW_SECONDS-5]})),{job:'node',instance:'host-a:9100',nowSec:now}),/stale/);
 assert.throws(()=>scrapeFromMatrix(matrix(series({scrapes:[now+30]})),{job:'node',instance:'host-a:9100',nowSec:now}),/stale/,'future samples cannot be made current');
 assert.throws(()=>scrapeFromMatrix(matrix([]),{job:'node',instance:'host-a:9100',nowSec:now}),/stale/,'no samples in the window at all');
 assert.throws(()=>scrapeFromMatrix(matrix(series({up:0})),{job:'node',instance:'host-a:9100',nowSec:now}),/target-down/);
 assert.throws(()=>scrapeFromMatrix(matrix(series().filter(s=>!s.metric.__name__.startsWith('node_'))),{job:'node',instance:'host-a:9100',nowSec:now}),/no-metrics/);
 const two=[...series(),series()[1]];assert.throws(()=>scrapeFromMatrix(matrix(two.map((s,i)=>i===two.length-1?{...s,metric:{...s.metric,replica:'2'}}:s)),{job:'node',instance:'host-a:9100',nowSec:now}),/ambiguous/);
 // A series that missed the newest scrape is left out, never taken from an older one.
 const late=series().map(s=>s.metric.__name__==='node_memory_MemAvailable_bytes'?{...s,values:s.values.slice(0,1)}:s);
 assert.equal(scrapeFromMatrix(matrix(late),{job:'node',instance:'host-a:9100',nowSec:now}).metrics.has('node_memory_MemAvailable_bytes'),false);
 // NaN (a stale marker) is dropped, never read as 0.
 const nan=series().map(s=>s.metric.__name__==='node_memory_MemTotal_bytes'?{...s,values:s.values.map(([t])=>[t,'NaN'])}:s);
 assert.equal(scrapeFromMatrix(matrix(nan),{job:'node',instance:'host-a:9100',nowSec:now}).metrics.has('node_memory_MemTotal_bytes'),false);
});

test('collector and poller: rates from two real scrapes; the same scrape again records nothing; a counter reset gives no rate',async t=>{
 const record={mode:'prometheus',...conn,job:'node',instance:'host-a:9100'};
 assert.ok(validPromRecord(record));assert.ok(!validPromRecord({...record,auth:{type:'basic',user:'u',password:'p'.repeat(9)}}),'no credentials over HTTP');
 assert.ok(!validPromRecord({...record,job:'a\nb'}));
 assert.deepEqual(promInfo({record:{...record,scheme:'https',tls:{mode:'ca'},auth:{type:'bearer',token:'secret-token-value-123'}}}).auth,'bearer');
 assert.ok(!JSON.stringify(promInfo({record:{...record,scheme:'https',tls:{mode:'ca'},auth:{type:'bearer',token:'secret-token-value-123'}}})).includes('secret-token'));
 let clock=1700000020_000,scrapes=[1700000000,1700000015],step=10;const seen=[];
 const request=async o=>{seen.push(o.query.query);return ok(matrix(series({scrapes,step})));};
 const s=await collectPrometheus(record,{request,now:()=>clock});assert.equal(s.scrape,1700000015);assert.equal(s.t,1700000015000,'stamped with the scrape, not the query');
 assert.match(seen[0],/job="node",instance="host-a:9100"\}\[120s\]$/);
 const dir=await mkdtemp(path.join(os.tmpdir(),'prom-poller-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const p=createSnapshotPoller({driver:prometheusDriver({collect:r=>collectPrometheus(r,{request,now:()=>clock})}),subdir:'linux',stateDirectory:dir,
  hosts:async()=>[{id:'nas',record}],now:()=>clock});
 await p.start();p.stop();
 assert.equal(p.seconds('nas').length,1);assert.equal(p.seconds('nas')[0].cpu,null,'first scrape: no rate');assert.equal(p.seconds('nas')[0].t,1700000015,'the reading carries the scrape time');
 clock+=30000;await p.poll();assert.equal(p.seconds('nas').length,1,'Prometheus has not scraped since: nothing new is recorded');assert.equal(p.status().nas.state,'up');
 scrapes=[1700000015,1700000030];clock=1700000080_000;await p.poll();
 const r=p.seconds('nas').at(-1);assert.equal(r.span,15);assert.equal(r.cpu,50);assert.equal(r.netRx,1000);
 scrapes=[1700000030,1700000045];step=-500;clock=1700000110_000;await p.poll();
 assert.equal(p.seconds('nas').at(-1).cpu,null,'counters that went back give no rate');
 assert.equal(p.native().nas.provider,'prometheus');assert.equal(p.disks().nas.disks[0].name,'pool (ZFS · /mnt/pool/a)');
});
