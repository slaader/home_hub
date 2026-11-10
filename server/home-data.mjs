// Home page boundary: machine tiles (props + last-minute quad), per-machine runtime stack
// (position-bound LEGO grid) and chart series. Live numbers come from the compute bridges
// (services), the Thermo pull clients (cpu/gpu/power/temp/minutes) and router observations;
// the grid layout below is the static contract agents extend via runtime_publish later.
import {machineKind,inLan} from './site-config.mjs';

const number=(v,max=Number.MAX_SAFE_INTEGER)=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=max?v:null;
const text=(v,n=160)=>typeof v==='string'?v.replace(/[\u0000-\u001f\u007f]/g,'').slice(0,n):'';

// The site's own machines (site.json → machines) as tile definitions: static hardware and identity;
// live values never overwrite these. kind: thermo = live metrics from Thermo; nas and router have their
// own collectors; other = a static tile.
export const homeDefinitions=site=>site.machines.map(m=>({id:m.id,name:m.name,hostname:m.hostname,ip:m.ip,picture:m.picture,
 props:{...m.hardware},...(m.thermoId?{thermo:m.thermoId}:{}),kind:machineKind(m)}));
// Per-machine runtime stack (the position-bound grid drawn on a machine page), when the site describes one.
export const stackLayouts=site=>Object.fromEntries(site.machines.filter(m=>m.stack).map(m=>[m.id,m.stack]));
export const homeMachineIds=site=>site.machines.map(m=>m.id);
// A device added on the Home page (home-devices.mjs) as a tile definition; its picture is served from state.
export const addedDefinition=d=>({id:d.id,name:d.name,hostname:d.hostname,ip:d.ip||'',kind:d.kind,added:true,
 image:d.image?`/images/home/${d.id}.jpg?v=${encodeURIComponent(d.imageAt||'')}`:null,
 props:{cpu:d.props?.cpu||'',gpu:d.props?.gpu||'—',ramGb:d.props?.ramGb??null},...(d.kind==='thermo'?{thermo:d.id}:{})});

// Per-account order of the overview tiles (stored in access.json, see access-store.mjs).
// A saved list must name only known machines, each once; it may be partial or empty (= default).
// ids: the site's machines plus the added devices.
export function validHomeOrder(input,ids=[]){
 if(!Array.isArray(input)||input.length>ids.length||input.some(id=>typeof id!=='string'||!ids.includes(id))||new Set(input).size!==input.length)throw new Error('invalid');
 return [...input];
}
// The order to show: saved ids that are still known, then every known id missing from it, in default order.
export function homeOrder(saved,ids=[]){
 const kept=Array.isArray(saved)?saved.filter((id,i)=>ids.includes(id)&&saved.indexOf(id)===i):[];
 return [...kept,...ids.filter(id=>!kept.includes(id))];
}

export const homeRanges=Object.freeze({'30m':{buckets:60,stepSeconds:30,source:'Thermo samples · 30 s'},
 '7d':{buckets:168,stepSeconds:3600,source:'Thermo minutes · 1 h'},'30d':{buckets:120,stepSeconds:21600,source:'rollups · 6 h'},'6m':{buckets:180,stepSeconds:86400,source:'rollups · 1 d'}});

const avg=v=>v.length?v.reduce((a,b)=>a+b,0)/v.length:null;
const maxOf=v=>v.length?Math.max(...v):null;
// Bucket raw {t,...} rows into fixed-width windows ending at `now`.
export function bucketRows(rows,{stepSeconds,buckets},nowSec){
 const out=Array.from({length:buckets},(_,i)=>({t:nowSec-(buckets-1-i)*stepSeconds,cpu:[],cpuMax:[],gpu:[],gpuMax:[],power:[],powerMax:[],temp:[],tempMax:[],memUsed:[],memTotal:[],gpuMem:[],gpuMemMax:[],gpuMemAlloc:[],pressure:[],n:0}));
 // Window = (start, nowSec]; bucket i covers [start+i·step, start+(i+1)·step) and is labelled by its end.
 const start=nowSec-buckets*stepSeconds;
 const peak=(v,m)=>Number.isFinite(m)?Math.max(m,Number.isFinite(v)?v:m):v;
 for(const r of rows){if(!Number.isFinite(r?.t)||r.t<start||r.t>nowSec)continue;let idx=Math.floor((r.t-start)/stepSeconds);if(idx>=buckets)idx=buckets-1;if(idx<0)continue;const b=out[idx];b.n++;
  if(Number.isFinite(r.cpu)){b.cpu.push(r.cpu);b.cpuMax.push(peak(r.cpu,r.cpuMax));}
  if(Number.isFinite(r.gpu)){b.gpu.push(r.gpu);b.gpuMax.push(peak(r.gpu,r.gpuMax));}
  if(Number.isFinite(r.power)){b.power.push(r.power);b.powerMax.push(peak(r.power,r.powerMax));}
  const temp=chipTemp(r);if(temp!=null){b.temp.push(temp);const tm=[r.cpuTempMax,r.gpuTempMax,temp].filter(Number.isFinite);b.tempMax.push(Math.max(...tm));}
  if(Number.isFinite(r.memUsed))b.memUsed.push(r.memUsed);if(Number.isFinite(r.memTotal))b.memTotal.push(r.memTotal);
  if(Number.isFinite(r.gpuMem))b.gpuMem.push(r.gpuMem);if(Number.isFinite(r.gpuMemMax))b.gpuMemMax.push(r.gpuMemMax);else if(Number.isFinite(r.gpuMem))b.gpuMemMax.push(r.gpuMem);
  if(Number.isFinite(r.gpuMemAlloc))b.gpuMemAlloc.push(r.gpuMemAlloc);
  const pr=Number.isFinite(r.memPressureMax)?r.memPressureMax:r.memPressure;if(Number.isFinite(pr))b.pressure.push(pr);}
 return out.map(b=>({t:b.t,points:b.n,cpu:avg(b.cpu),cpuMax:maxOf(b.cpuMax),gpu:avg(b.gpu),gpuMax:maxOf(b.gpuMax),power:avg(b.power),powerMax:maxOf(b.powerMax),temp:avg(b.temp),tempMax:maxOf(b.tempMax),memUsed:avg(b.memUsed),memTotal:maxOf(b.memTotal),gpuMem:avg(b.gpuMem),gpuMemMax:maxOf(b.gpuMemMax),gpuMemAlloc:avg(b.gpuMemAlloc),memPressure:maxOf(b.pressure)}));
}
function emptySeries(nowSec,cfg){return Array.from({length:cfg.buckets},(_,i)=>({t:nowSec-(cfg.buckets-1-i)*cfg.stepSeconds,points:0,cpu:null,cpuMax:null,gpu:null,gpuMax:null,power:null,powerMax:null,temp:null,tempMax:null,memUsed:null,memTotal:null,gpuMem:null,gpuMemMax:null,gpuMemAlloc:null,memPressure:null}));}

// range: 30m from the seconds ring, 7d from minute rows; 30d/6m come back `partial`
// with whatever minute rows we hold until Postgres rollups land.
export function homeHistory(thermo,machine,range,nowSec=Math.floor(Date.now()/1000),thermoIds=[]){
 const cfg=Object.hasOwn(homeRanges,range)?homeRanges[range]:null;if(!cfg||!thermoIds.includes(machine))throw new Error('invalid');
 const needed=nowSec-cfg.buckets*cfg.stepSeconds;
 const minuteRows=thermo.minutes(machine).filter(r=>r.t>=needed);
 if(range==='30m'){
  // The Thermo seconds ring holds ~5 min, so after a hub restart the older part of the
  // window comes from minute rows (each spread over both 30 s buckets of its minute).
  const secs=thermo.seconds(machine,needed);const firstSec=secs.length?secs[0].t:Infinity;
  const fill=minuteRows.filter(r=>r.t+60<=firstSec).flatMap(r=>[r,{...r,t:r.t+30}]);
  const oldest=Math.min(firstSec,fill.length?fill[0].t:Infinity);
  return {machine,range,source:cfg.source,status:cfg.source,complete:oldest<=needed+60,coverageSeconds:Number.isFinite(oldest)?Math.round(nowSec-oldest):0,from:needed*1000,points:bucketRows([...fill,...secs],cfg,nowSec)};
 }
 const oldest=minuteRows.length?minuteRows[0].t:null;
 return {machine,range,source:cfg.source,complete:range==='7d'&&oldest!==null&&oldest<=needed+cfg.stepSeconds,coverageSeconds:oldest!==null?Math.round(nowSec-oldest):0,from:needed*1000,points:minuteRows.length||range==='7d'?bucketRows(minuteRows,cfg,nowSec):emptySeries(nowSec,cfg)};
}

// Tile quad: last complete minute from Thermo minute rows, falling back to the newest sample.
// Tile quad = mean of the last 15 s of 1-second Thermo readings (what the poller drained), so it
// tracks Thermo's own rolling view; temperature is the hotter of CPU and GPU like Thermo's
// "chip temperature". Falls back to the newest minute row, then the newest sample.
export const QUAD_WINDOW_SECONDS=15;
const chipTemp=r=>{const c=Number.isFinite(r?.cpuTemp)?r.cpuTemp:null,g=Number.isFinite(r?.gpuTemp)?r.gpuTemp:null;return c==null?g:g==null?c:Math.max(c,g);};
function quadFor(thermo,machine,nowSec,windowSeconds=QUAD_WINDOW_SECONDS){
 const ring=thermo.seconds(machine)||[];
 const newest=ring.length?ring.at(-1).t:null;
 const recent=newest!=null&&nowSec-newest<Math.max(120,windowSeconds*3)?ring.filter(r=>r.t>newest-windowSeconds):[];
 if(recent.length){
  const mean=f=>{const v=recent.map(f).filter(Number.isFinite);return v.length?v.reduce((x,y)=>x+y,0)/v.length:null;};
  const last=recent.at(-1);
  return {cpu:mean(r=>r.cpu),gpu:mean(r=>r.gpu),power:mean(r=>r.power),temp:mean(chipTemp),
   memUsed:last.memUsed??null,memTotal:last.memTotal??null,gpuMem:last.gpuMem??null,gpuMemAlloc:last.gpuMemAlloc??null,swapUsed:last.swapUsed??null,
   memPressure:recent.reduce((m,r)=>Number.isFinite(r.memPressure)?Math.max(m??0,r.memPressure):m,null),windowSeconds,samples:recent.length,observedAt:newest*1000};
 }
 const live=thermo.live()?.[machine]?.reading||null;
 const rows=thermo.minutes(machine);const minute=rows.length&&nowSec-rows.at(-1).t<180?rows.at(-1):null;
 const src=minute||live;if(!src)return null;
 return {cpu:src.cpu??null,gpu:src.gpu??null,power:src.power??null,temp:chipTemp(src),memUsed:src.memUsed??null,memTotal:src.memTotal??null,gpuMem:src.gpuMem??null,gpuMemAlloc:src.gpuMemAlloc??null,swapUsed:src.swapUsed??null,memPressure:src.memPressureMax??src.memPressure??null,
  windowSeconds:minute?60:1,samples:1,observedAt:(src.t?src.t*1000:Date.now())};
}
function volumesFor(thermo,machine){
 const reply=thermo.disks()?.[machine];if(!reply?.disks?.length)return [];
 return reply.disks.slice(0,6).map(d=>({name:text(d.name,60),mount:text(d.mount,60),fs:text(d.fs,16),usedBytes:number(d.used),sizeBytes:number(d.total)}));
}
// Merge the static grid with what the bridge reports right now. A block that names a `service`
// takes its live state from that service; offline ⇒ dashed, never silently gone (that is the
// user's rule: capability we have shows even when stopped, with models:[]).
export function mergeStack(machine,services=[],layout=null){
 if(!layout)return null;const collected=layout.source==='collected';
 const byId=new Map(services.map(s=>[s.id,s]));
 const staticPaths=new Map(layout.blocks.flatMap(b=>(b.models||[]).map(m=>[m.id,m.path??null])));
 const blocks=layout.blocks.map(b=>{
  if(!b.service)return {...b};
  // Collected layouts already carry the state seen on the device; live bridge data only
  // refines blocks whose service the bridge actually reports.
  if(collected&&!byId.has(b.service))return {...b,models:b.models||[]};
  const svc=byId.get(b.service);const running=svc?.status==='reachable';
  return {...b,state:running?'on':'off',
   port:svc?.url?`:${String(svc.url).split(':')[2]||''} · ${running?'živě':'dřív'}`:b.port,
   models:running?(svc.models||[]).map(m=>({id:m.id,state:m.state,sizeGb:m.sizeBytes!=null?Math.round(m.sizeBytes/1073741824*10)/10:null,path:staticPaths.get(m.id)??null,ttlSeconds:m.ttlSeconds??null,ttlRemainingSeconds:m.ttlRemainingSeconds??null})).slice(0,30):[],
   stats:running?{requests:svc.stats?.requests??null,uptimeSeconds:svc.stats?.uptimeSeconds??null}:null,
   pool:running&&svc.pool?{capacityGb:svc.pool.capacityGb,allocatedGb:svc.pool.allocatedGb}:null,
   desc:running?b.desc:`${b.desc} — služba teď nedosaditelná.`};
 });
 return {...layout,blocks};
}
// Whole /api/home payload. site = the site configuration; thermo = createThermoPoller(); router =
// readRouter() result. Two optional feeds come from plugins (docs/plugins.md → extension points):
// snapshots = {machineId: {snapshot, bridge}} (what a host agent reports: services, memory, uptime) and
// probed = {machineId: services[]|null} (service probes for a machine without an agent, e.g. a NAS).
// Missing pieces degrade to offline tiles, never throw.
export function buildHome({site,snapshots:computeLatest={},thermo,router=null,probed={},descriptors={},added=[],now=Date.now()}={}){
 const layouts=stackLayouts(site);
 const nowSec=Math.floor(now/1000);
 const poll=thermo?.interval?.()||{intervalSeconds:QUAD_WINDOW_SECONDS,lastPollAt:null};
 const machines=[...homeDefinitions(site),...added.map(addedDefinition)].map(base=>{
  const collected=machineFromDescriptor(descriptors[base.id],site);const def={...base,...(collected||{}),props:{...base.props,...(collected?.props||{})}};
  const nasServices=def.kind==='nas'&&Array.isArray(probed?.[def.id])?probed[def.id]:null;
  const entry=computeLatest?.[def.id]||{};const snapshot=entry.snapshot||null;
  const thermoStatus=def.thermo?thermo.status()?.[def.thermo]?.state:null;
  const live=def.thermo?quadFor(thermo,def.thermo,nowSec,poll.intervalSeconds):null;
  const seconds=def.thermo?thermo.seconds(def.thermo,nowSec-120):[];
  const sampleAge=seconds.length?nowSec-seconds.at(-1).t:null;
  let online='offline',lastSeen=null;
  if(def.kind==='router'){online=router&&router.status==='ok'&&router.freshness==='fresh'?'online':router&&router.status==='ok'?'stale':'offline';lastSeen=router?.observedAt||null;}
  else if(def.kind==='nas'){
   const reachable=Array.isArray(nasServices)?nasServices.filter(s=>s.status==='reachable'||s.status==='auth-required'):null;
   online=reachable===null?(snapshot?'online':'unknown'):reachable.length?'online':'offline';
   lastSeen=Array.isArray(nasServices)&&nasServices.length?nasServices.at(-1).observedAt||null:snapshot?.collectedAt||null;
  }
  else if(def.kind==='other')online='unknown';
  else{
   if(sampleAge!=null&&sampleAge<=90)online='online';else if(snapshot&&now-Date.parse(snapshot.collectedAt)<180000)online=online==='online'?'online':'stale';else if(online!=='online')online=thermoStatus==='up'?'online':'offline';
   const stamps=[seconds.length?seconds.at(-1).t*1000:null,snapshot?.collectedAt?Date.parse(snapshot.collectedAt):null].filter(Boolean);
   lastSeen=stamps.length?new Date(Math.max(...stamps)).toISOString():null;
  }
  const services=def.kind==='nas'&&Array.isArray(nasServices)?nasServices.map(s=>({id:s.id,name:s.name,status:s.status==='auth-required'?'reachable':s.status,url:s.url,models:s.models||[]})):snapshot?.services||[];
  let routerQuad=def.kind==='router'&&router&&router.status==='ok'?{clients:router.devices.length,wifi:router.devices.filter(d=>String(d.connection).startsWith('Wi-Fi')).length,power:null,temp:null}:null;
  // No live router feed yet: show the freshly collected census, marked stale with its time.
  const census=def.kind==='router'&&Array.isArray(descriptors[def.id]?.clients)?descriptors[def.id].clients:null;
  if(def.kind==='router'&&!routerQuad&&census){routerQuad={clients:census.length,wifi:census.filter(c=>c.connection==='wifi'||c.connection==='wireless').length,power:null,temp:null};online='stale';lastSeen=collected?.collectedAt||null;}
  return {...def,hostname:def.hostname||'',ip:def.ip,online,lastSeen,
   thermo:thermoStatus||null,bridge:entry.bridge||null,
   quad:live||routerQuad,
   volumes:volumesFor(thermo,def.thermo||def.id),
   memoryUsedBytes:snapshot?.memory?.usedBytes??null,memoryTotalBytes:snapshot?.memory?.totalBytes??(def.props?.ramGb!=null?def.props.ramGb*1073741824:null),
   uptimeSeconds:snapshot?.uptimeSeconds??null,
   services:services.map(s=>({id:s.id,name:s.name,status:s.status,url:s.url,models:(s.models||[]).filter(m=>m.state==='loaded').map(m=>m.id)})),
   collectedAt:collected?.collectedAt||null,reviewNeeded:collected?.reviewNeeded||[],
   stack:mergeStack(def.id,services,collected?.stack||layouts[def.id]||null)};
 });
 const routerClients=router&&Array.isArray(router.devices)?router.devices.filter(d=>['associated','reachable','lease-only'].includes(d.presence)).length:null;
 return {poll,schemaVersion:1,generatedAt:new Date(now).toISOString(),machines,
  router:router?{status:router.status,freshness:router.freshness,observedAt:router.observedAt,model:router.model,firmware:router.firmware,clients:routerClients}:null};
}
export function homeHistoryQuery(input,added=[],site={machines:[]}){
 const machine=input?.machine,range=input?.range??'30m';
 if(![...site.machines,...added].some(h=>h.id===machine)||!Object.hasOwn(homeRanges,String(range)))throw new Error('invalid');
 if(!site.machines.some(m=>m.id===machine&&m.thermoId)&&!added.some(d=>d.id===machine&&d.kind==='thermo'))return {machine,range,points:[],complete:false,source:'žádný zdroj',reason:'Thermo nesahá na NAS/router'};
 return {machine,range};
}

// Machine descriptors (data/machines/<id>.json) are collected fresh from each device; they
// replace the static identity/props/stack above whenever present and valid.
function validStack(st){
 if(!st||!Array.isArray(st.layers)||!Array.isArray(st.cols)||!Array.isArray(st.blocks)||!st.cols.length||st.blocks.length>60)return null;
 const blocks=st.blocks.filter(b=>b&&typeof b.id==='string'&&Number.isInteger(b.layer)&&b.layer>=0&&b.layer<st.layers.length&&Number.isInteger(b.col0)&&Number.isInteger(b.col1)&&b.col0>=0&&b.col1>=b.col0&&b.col1<st.cols.length)
  .map(b=>({id:text(b.id,60),layer:b.layer,col0:b.col0,col1:b.col1,title:text(b.title,60),port:text(b.port,80),desc:text(b.desc,400),
   ...(b.service?{service:text(b.service,60)}:{}),state:b.state==='off'?'off':'on',
   ...(b.engine?{engine:true}:{}),...(b.hw||b.layer===st.layers.length-1?{hw:true}:{}),
   models:Array.isArray(b.models)?b.models.slice(0,30).map(m=>({id:text(m.id,120),state:text(m.state,16),sizeGb:number(m.sizeGb,100000),path:text(m.path,240)||null})):[]}));
 if(!blocks.length)return null;
 const engines=Object.fromEntries(Object.entries(st.engines||{}).slice(0,8).map(([k,v])=>[text(k,16),text(v,40)]));
 return {source:'collected',layers:st.layers.slice(0,8).map(l=>text(l,24)),cols:st.cols.slice(0,12).map(c=>text(c,16)),engines,blocks};
}
export function machineFromDescriptor(d,site={machines:[],lanCidrs:[]}){
 const known=d&&site.machines.find(m=>m.id===d.id);
 if(!d||d.schemaVersion!==1||!known)return null;
 const hw=d.hardware||{},cores=hw.cpuCores||{};
 const ip=(d.addresses||[]).map(a=>a?.ip).find(ip=>inLan(site,ip||''))||null;
 const chip=text(hw.cpu,60).replace(/^Apple /,'').replace(/ \d+-Core$/,'').replace(/ \(.*\)$/,'');
 const split=cores.performance&&cores.efficiency&&!cores.labels?` (${cores.performance}P+${cores.efficiency}E)`:cores.performance&&cores.efficiency?` (${cores.performance}S+${cores.efficiency}P)`:'';
 const total=number(cores.total)??number(cores.threads);
 const pools=Array.isArray(hw.pools)?hw.pools.filter(p=>p&&!/boot/i.test(p.name||'')):[];
 const rootDisk=known.role==='router'?null:(hw.disks||[]).find(x=>x?.mount==='/'||x?.mount==='/System/Volumes/Data')||null;
 const props={cpu:`${total?total+'j':''}${split} ${chip}`.trim(),gpu:number(hw.gpuCores)?`${hw.gpuCores}c`:/igpu|integrated/i.test(String(hw.gpu||''))?'iGPU':'—',ramGb:number(hw.ramGb),
  diskTotalBytes:pools.length?pools.reduce((a,p)=>a+(number(p.sizeBytes)||0),0)||null:number(rootDisk?.totalBytes),...(pools.length?{pools:pools.length}:{})};
 return {name:text(d.name,60)||d.id,hostname:text(d.hostname,80),ip:ip||undefined,props,collectedAt:text(d.collectedAt,40),
  reviewNeeded:Array.isArray(d.reviewNeeded)?d.reviewNeeded.slice(0,20).map(r=>text(typeof r==='string'?r:JSON.stringify(r),300)):[],
  stack:validStack(d.stack)};
}
export async function loadMachineDescriptors(dir,ids=[]){
 const {readFile}=await import('node:fs/promises');const out={};
 for(const id of ids){try{const d=JSON.parse(await readFile(`${dir}/${id}.json`,'utf8'));if(d?.id===id)out[id]=d;}catch{}}
 return out;
}
