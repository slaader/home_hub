// The poller every agent-less telemetry provider shares (Windows over SSH or WinRM, Linux over Node Exporter
// or SSH). One poll is one snapshot; a reading is the difference between two snapshots of the same connection
// (the driver's derive), so it is the true average over the interval between them (span), timestamped at its end.
// The read side has the shape of the Thermo poller (server/thermo-client.mjs), so the overview, the charts and the
// integration status read every provider alike: status, live, seconds, minutes, disks, hosts, interval, native.
//
// driver = {
//   collect(config)             → snapshot (rejects with Error(code))
//   derive(prev, cur, atSec)    → reading {t, span, cpu, cores, gpu, memUsed, …}; every rate null without prev
//   volumes(snap)               → [{name, mount, fs, used, total}]
//   native(snap, reading, iso)  → what the machine page shows beyond the gauges
//   errors                      → {code: sentence}: only these codes are kept as a status error
//   valid(config), key(config), label(config), info(config)   → identity of a connection
//   deniedCodes                 → codes that mean "credentials refused" (state 'denied')
//   unchanged(prev, cur)        → optional: true when cur is the very same source sample as prev (a Prometheus
//                                 that has not scraped since): nothing is recorded, the chain is kept, no fresh reading is faked
//   sourceTime                  → optional: the snapshot's own time (a scrape timestamp) is the reading's time
//                                 even when it is older than the poll (never newer than the answer)
// }
// Rules kept for every provider:
//   - never closer than minIntervalMs (30 s); the overview's interval only makes polls slower
//   - one poll in flight, shared by every caller; at most `concurrency` hosts at once; a host is never polled twice at once
//   - a connection's identity (driver.key) changing — host, port, user, key, certificate, credentials — starts a
//     new counter chain: readings of the old connection never land on the new one, a late answer is dropped
//   - a failure breaks the chain: the next snapshot starts a new interval instead of averaging across the gap
//   - minute rows are kept like Thermo's: <stateDirectory>/<subdir>/minutes-<id>-YYYY-MM.jsonl, 8 days in memory;
//     a device that moves to this poller from another provider of the same family reads its rows back from disk
import {mkdir,readFile,appendFile,readdir} from 'node:fs/promises';
import path from 'node:path';

export const MIN_INTERVAL_MS=30000;
const round=(v,d=1)=>v==null?null:Math.round(v*10**d)/10**d;
const avg=v=>v.length?v.reduce((a,b)=>a+b,0)/v.length:null;
const finite=(rows,k)=>rows.map(r=>r[k]).filter(Number.isFinite);
// One minute of readings. Power is never measured by an agent-less provider; temperatures only where a source reports them.
export function minuteRow(minute,rows){
 const m=k=>round(avg(finite(rows,k)),k==='cpu'||k==='gpu'||k==='cpuTemp'||k==='gpuTemp'?1:0),x=k=>{const v=finite(rows,k);return v.length?Math.max(...v):null;};
 return {t:minute,n:rows.length,cpu:m('cpu'),cpuMax:x('cpu'),gpu:m('gpu'),gpuMax:x('gpu'),memUsed:m('memUsed'),memTotal:x('memTotal'),swapUsed:m('swapUsed'),
  vramUsed:m('vramUsed'),diskRead:m('diskRead'),diskWrite:m('diskWrite'),netRx:m('netRx'),netTx:m('netTx'),power:null,cpuTemp:m('cpuTemp'),gpuTemp:m('gpuTemp'),
  ...(finite(rows,'cpuTemp').length?{cpuTempMax:x('cpuTemp')}:{})};
}
export function createSnapshotPoller({driver,subdir,stateDirectory,hosts=async()=>[],intervalMs=MIN_INTERVAL_MS,minIntervalMs=MIN_INTERVAL_MS,now=Date.now,log=()=>{},concurrency=4}={}){
 const configs=new Map(),hostState=new Map(),minutes=new Map(),restored=new Set();
 let timer=null,polling=null,paused=false,started=false,lastPollAt=null,lastRefresh=0,generation=0;
 intervalMs=Math.max(minIntervalMs,intervalMs);
 const dir=()=>path.join(stateDirectory,subdir);
 const st=id=>{if(!hostState.has(id))hostState.set(id,{prev:null,ring:[],open:null,status:null,live:null,disks:null,native:null,busy:false,lastStarted:null});return hostState.get(id);};
 async function persist(id,rows){
  if(!rows.length||!stateDirectory)return;
  try{await mkdir(dir(),{recursive:true,mode:0o700});const month=new Date(rows.at(-1).t*1000).toISOString().slice(0,7);
   await appendFile(path.join(dir(),`minutes-${id}-${month}.jsonl`),rows.map(r=>JSON.stringify(r)).join('\n')+'\n',{mode:0o600});}catch{log(id,'persist');}
 }
 function remember(id,rows){const list=minutes.get(id)||[];for(const r of rows)if(!list.length||r.t>list.at(-1).t)list.push(r);minutes.set(id,list.slice(-60*24*8));}
 function closeMinute(id,s,nowSec){
  if(!s.open||nowSec<s.open.minute+60+120)return;
  const row=minuteRow(s.open.minute,s.open.rows);s.open=null;remember(id,[row]);void persist(id,[row]);
 }
 async function pollOne(id){
  const config=configs.get(id);if(!config||paused)return;
  const s=st(id);if(s.busy||s.lastStarted!=null&&now()-s.lastStarted<minIntervalMs)return;s.lastStarted=now();s.busy=true;const gen=config.gen,started=now();
  try{
   const snap=await driver.collect(config);
   if(configs.get(id)?.gen!==gen)return;// removed or re-targeted meanwhile: the result is for another config
   const ended=now(),remote=snap.t;
   if(s.prev&&driver.unchanged?.(s.prev,snap)){s.status={state:'up',checkedAt:new Date(ended).toISOString()};return;}
   // The source's own clock when it agrees with ours, else the moment the answer arrived.
   const atMs=Number.isFinite(remote)&&remote<=ended+5000&&(driver.sourceTime?remote>=ended-10*60000:remote>=started-5000)?remote:ended;
   const reading=driver.derive(s.prev,snap,Math.round(atMs/1000));
   s.prev=snap;
   const {gpus,cores,...row}=reading;
   if(!s.ring.length||row.t>s.ring.at(-1).t){s.ring.push(row);const cutoff=ended/1000-35*60;while(s.ring.length&&s.ring[0].t<cutoff)s.ring.shift();
    const minute=Math.floor(row.t/60)*60;
    if(s.open&&s.open.minute!==minute){const done=minuteRow(s.open.minute,s.open.rows);remember(id,[done]);void persist(id,[done]);s.open=null;}
    if(!s.open)s.open={minute,rows:[]};s.open.rows.push(row);}
   s.live={at:ended,reading:row};
   s.disks={disks:driver.volumes(snap),fetchedAt:ended};
   s.native=driver.native(snap,reading,new Date(atMs).toISOString());
   s.status={state:'up',checkedAt:new Date(ended).toISOString()};
  }catch(e){
   if(configs.get(id)?.gen!==gen)return;
   const code=typeof e?.message==='string'&&Object.hasOwn(driver.errors,e.message)?e.message:'unavailable';
   s.prev=null;
   s.status={state:(driver.deniedCodes||['denied']).includes(code)?'denied':'down',error:code,checkedAt:new Date(now()).toISOString()};log(id,code);
  }finally{s.busy=false;closeMinute(id,s,Math.floor(now()/1000));}
 }
 async function readRows(id){
  let files=[];try{files=await readdir(dir());}catch{return [];}
  const list=[];
  for(const f of files){const m=/^minutes-(.+)-\d{4}-\d{2}\.jsonl$/.exec(f);if(!m||m[1]!==id)continue;
   for(const line of (await readFile(path.join(dir(),f),'utf8').catch(()=>'')).split('\n')){if(!line)continue;try{const r=JSON.parse(line);if(Number.isFinite(r?.t))list.push(r);}catch{}}}
  return list.sort((a,b)=>a.t-b.t);
 }
 // A device this poller had not restored (it came over from another provider of the same family after the
 // start): its rows are read back, so its history continues.
 async function reload(id){if(restored.has(id)||!stateDirectory)return;restored.add(id);const rows=await readRows(id);if(rows.length){const mine=minutes.get(id)||[];minutes.set(id,[]);remember(id,[...rows.filter(r=>!mine.some(x=>x.t===r.t)),...mine].sort((a,b)=>a.t-b.t));}}
 async function sync(){const list=await hosts().catch(()=>[]);for(const h of list)if(driver.valid(h)&&(!configs.has(h.id)||configs.get(h.id).key!==driver.key(h)))setConfig(h);}
 function setConfig(h){generation++;const old=configs.get(h.id),key=driver.key(h);
  configs.set(h.id,{...h,target:driver.label(h),key,gen:generation});if(old&&old.key!==key)hostState.delete(h.id);
  if(started&&!old)void reload(h.id);}
 function poll(){
  if(paused)return Promise.resolve();if(polling)return polling;
  // With no hosts the async loop would complete before assignment, leaving a resolved promise
  // installed forever and preventing every later poll after the first device is connected.
  if(!configs.size){lastPollAt=now();return Promise.resolve();}
  polling=(async()=>{try{const ids=[...configs.keys()];for(let i=0;i<ids.length;i+=concurrency)await Promise.all(ids.slice(i,i+concurrency).map(pollOne));lastPollAt=now();}finally{polling=null;}})();
  return polling;
 }
 const schedule=()=>{clearInterval(timer);timer=setInterval(()=>void poll(),intervalMs);timer.unref?.();};
 async function restore(){
  let files=[];try{files=await readdir(dir());}catch{return;}
  const ids=new Set(files.map(f=>/^minutes-(.+)-\d{4}-\d{2}\.jsonl$/.exec(f)?.[1]).filter(Boolean));
  for(const id of ids){restored.add(id);remember(id,await readRows(id));}
 }
 async function start(){await restore();started=true;await sync();if(!paused){await poll();schedule();}}
 async function pause(){if(paused)return;paused=true;clearInterval(timer);timer=null;await polling?.catch(()=>{});for(const s of hostState.values()){s.prev=null;s.status=null;s.live=null;s.disks=null;s.native=null;s.ring=[];}}
 async function resume(){if(!paused)return;paused=false;if(started){await sync();await poll();schedule();}}
 const of=key=>()=>Object.fromEntries([...configs.keys()].map(id=>[id,hostState.get(id)?.[key]]).filter(([,v])=>v));
 return {start,stop:()=>{clearInterval(timer);timer=null;},poll,pause,resume,paused:()=>paused,
  // A device connected (or re-targeted): poll it now. Removed: forget it at once; a poll in flight is discarded.
  addHost(config){if(!driver.valid(config))return;setConfig(config);if(!paused&&started)void poll();},
  removeHost(id){configs.delete(id);hostState.delete(id);},
  has:id=>configs.has(id),
  hosts:()=>[...configs.keys()],
  targets:()=>Object.fromEntries([...configs.values()].map(c=>[c.id,c.target])),
  connections:()=>Object.fromEntries([...configs.values()].map(c=>[c.id,driver.info(c)])),
  // At most one on-demand pull every 10 s; concurrent callers share it.
  refresh(){if(paused||now()-lastRefresh<10000)return Promise.resolve(false);lastRefresh=now();return (polling||Promise.resolve()).then(()=>poll()).then(()=>true);},
  setIntervalMs(ms){intervalMs=Math.max(minIntervalMs,Number(ms)||minIntervalMs);if(timer)schedule();return intervalMs;},
  interval:()=>({intervalSeconds:intervalMs/1000,lastPollAt}),
  status:of('status'),live:of('live'),disks:of('disks'),native:of('native'),
  minutes:id=>minutes.get(id)||[],
  seconds:(id,since)=>{const ring=hostState.get(id)?.ring||[];return since?ring.filter(r=>r.t>=since):[...ring];}};
}
