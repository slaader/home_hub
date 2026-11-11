// Home page boundary: machine tiles (props + last-minute quad), per-machine runtime stack
// (position-bound LEGO grid) and chart series. Live numbers come from the compute bridges
// (services), the Thermo pull clients (cpu/gpu/power/temp/minutes) and router observations;
// the grid layout below is the static contract agents extend via runtime_publish later.
import {machineKind,inLan} from './site-config.mjs';
import {machineFields,machineHash,runtimeHash,pictureUrl,defaultPicture,siteBindable,siteDefaults,siteOverrideHash,PICTURES,MACHINE_ROLES,PLATFORMS,DEVICE_LIMITS,RUNTIME_LAYERS} from './home-devices.mjs';
import {TELEMETRY_AGENT_NAME,TELEMETRY_REPO_URL,TELEMETRY_STALE_SECONDS} from './thermo-client.mjs';
import {WINDOWS_PROVIDER,WINDOWS_ADAPTER_NAME,WINDOWS_MIN_INTERVAL_MS} from './windows-telemetry.mjs';
import {WINRM_PROVIDER,WINRM_NAME,WINRM_PORT} from './winrm-telemetry.mjs';
import {NODE_EXPORTER_PROVIDER,NODE_EXPORTER_NAME,NODE_EXPORTER_PORT,LINUX_SSH_PROVIDER,LINUX_SSH_NAME} from './linux-telemetry.mjs';
import {PROMETHEUS_PROVIDER,PROMETHEUS_NAME,PROMETHEUS_PORT} from './prometheus-telemetry.mjs';
import {isFeed,feedErrors,feedOfDevice} from './telemetry-providers.mjs';

const number=(v,max=Number.MAX_SAFE_INTEGER)=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=max?v:null;
const text=(v,n=160)=>typeof v==='string'?v.replace(/[\u0000-\u001f\u007f]/g,'').slice(0,n):'';

// The site's own machines (site.json → machines) as tile definitions: static hardware and identity;
// live values never overwrite these. kind: thermo = live metrics from Thermo; nas and router have their
// own collectors; other = a static tile.
// platform only when the site names one (site.json → machines[].platform), so older definitions stay as they were.
export const homeDefinitions=site=>site.machines.map(m=>({id:m.id,name:m.name,hostname:m.hostname,ip:m.ip,picture:m.picture,
 props:{...m.hardware},...(m.thermoId?{thermo:m.thermoId}:{}),kind:machineKind(m),...(m.platform?{platform:m.platform}:{})}));
// A site machine connected to an agent-less provider on its tile (bindings = homeDevices.siteBindings(): only effective
// ones). Its identity, role, picture and services stay the site's; it is its own telemetry host on that provider's poller,
// drawn with live numbers (kind "thermo", the historic name for "has a telemetry feed"); role keeps saying what it is
// (a NAS keeps its service probes). telemetryBinding: {provider, platform, configuredAt}, null without one.
export function boundSiteDefinition(def,m,binding){
 const editable=siteBindable(m);
 if(!binding)return {...def,telemetryBinding:null,telemetryEditable:editable};
 return {...def,kind:'thermo',thermo:def.id,provider:binding.provider,platform:m.platform||binding.platform,
  telemetryBinding:{provider:binding.provider,platform:binding.platform,configuredAt:binding.configuredAt||null},telemetryEditable:editable};
}
// The owner's override of a site machine (homeDevices.siteOverrides()[id], or undefined) on its tile definition: display
// metadata only (name, hostname, ip, the four hardware values, the picture). id, role, platform, thermoId, the telemetry
// binding, services and stack are not touched, and nothing that reads site.json (collectors, probes, Thermo) sees it.
// Always adds siteOverride {fields: the overridden names, hash: the base an edit sends, image, updatedAt, updatedBy} and
// siteDefaults (the site's own values, for the editor's reset), so every site machine can be edited.
export function overriddenSiteDefinition(def,m,o){
 const f=o?.fields||{},hw=f.hardware||{};
 const names=[...['name','hostname','ip'].filter(k=>Object.hasOwn(f,k)),...Object.keys(hw).map(k=>'hardware.'+k),...(f.picture?['picture']:[])];
 const d=siteDefaults(m);
 const out={...def,siteOverride:{fields:names,hash:o?.hash||siteOverrideHash(null),image:o?.image===true,updatedAt:o?.updatedAt||null,updatedBy:o?.updatedBy||null},
  siteDefaults:{...d,hardware:{...d.hardware},picture:m.picture||null,image:typeof def.image==='string'?def.image:null}};
 if(!o)return out;
 for(const k of ['name','hostname','ip'])if(Object.hasOwn(f,k))out[k]=f[k];
 if(Object.keys(hw).length)out.props={...def.props,...hw};
 if(f.picture){out.picture=pictureUrl(f.picture);out.pictureId=f.picture;out.image=null;}
 if(o.image)out.image=`/api/home/devices/${m.id}/image?v=${encodeURIComponent(o.imageAt||'')}`;
 return out;
}
// Per-machine runtime stack (the position-bound grid drawn on a machine page), when the site describes one.
export const stackLayouts=site=>Object.fromEntries(site.machines.filter(m=>m.stack).map(m=>[m.id,m.stack]));
export const homeMachineIds=site=>site.machines.map(m=>m.id);
// A machine from the store (added on the overview, or written by an agent) as a tile definition. image = an
// uploaded picture served from state; picture = the built-in one behind it (pictureId, or the role's default).
// source: "ui" or "agent". hash: what machine_upsert / machine_remove expect as base.
// A device read through Windows telemetry is its own telemetry host (thermo = its id, provider "windows") and
// is drawn like any machine with live numbers (kind "thermo", the historic name for "has a telemetry feed").
// The same for every agent-less provider (server/telemetry-providers.mjs): Windows over SSH or WinRM, Linux over
// Node Exporter, Prometheus or SSH. provider names which one.
export const addedDefinition=d=>({id:d.id,name:d.name,hostname:d.hostname,ip:d.ip||'',kind:feedOfDevice(d)?'thermo':machineKind(d),added:true,platform:d.platform??null,
 image:d.image?`/images/home/${d.id}.jpg?v=${encodeURIComponent(d.imageAt||'')}`:null,
 picture:pictureUrl(d.picture||defaultPicture(d.role)),pictureId:d.picture,
 props:{cpu:d.props?.cpu||'',gpu:d.props?.gpu||'—',ramGb:d.props?.ramGb??null,...(d.props?.diskTotalBytes!=null?{diskTotalBytes:d.props.diskTotalBytes}:{})},
 ...(d.thermoId?{thermo:d.thermoId}:feedOfDevice(d)?{thermo:d.id,provider:feedOfDevice(d)}:{}),role:d.role,source:d.source,readOnly:false,hash:machineHash(d),
 createdAt:d.createdAt||null,createdBy:d.createdBy||null,updatedAt:d.updatedAt||null,updatedBy:d.updatedBy||null});

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
  const secs=spreadSpans(thermo.seconds(machine,needed-SPAN_SPREAD_MAX),cfg.stepSeconds).filter(r=>r.t>=needed);const firstSec=secs.length?secs[0].t:Infinity;
  const fill=minuteRows.filter(r=>r.t+60<=firstSec).flatMap(r=>[r,{...r,t:r.t+30}]);
  const oldest=Math.min(firstSec,fill.length?fill[0].t:Infinity);
  return {machine,range,source:cfg.source,status:cfg.source,complete:oldest<=needed+60,coverageSeconds:Number.isFinite(oldest)?Math.round(nowSec-oldest):0,from:needed*1000,points:bucketRows([...fill,...secs],cfg,nowSec)};
 }
 const oldest=minuteRows.length?minuteRows[0].t:null;
 return {machine,range,source:cfg.source,complete:range==='7d'&&oldest!==null&&oldest<=needed+cfg.stepSeconds,coverageSeconds:oldest!==null?Math.round(nowSec-oldest):0,from:needed*1000,points:minuteRows.length||range==='7d'?bucketRows(minuteRows,cfg,nowSec):emptySeries(nowSec,cfg)};
}

// A reading that is the average over the span before it (Windows telemetry: one reading per poll, see
// server/windows-telemetry.mjs) also stands for the steps of that span it covers, the way a minute row is
// spread over both 30 s buckets of its minute. Copies go back one step at a time, never further than
// SPAN_SPREAD_MAX; a reading without a span (Thermo's 1 s samples) stays as it is.
export const SPAN_SPREAD_MAX=120;
export function spreadSpans(rows,step){
 const out=[];
 for(const r of rows){const span=Number.isFinite(r?.span)?Math.min(r.span,SPAN_SPREAD_MAX):0;
  for(let k=Math.ceil(span/step)-1;k>=1;k--)out.push({...r,t:r.t-k*step,spread:true,memUsed:null,memTotal:null,swapUsed:null,vramUsed:null});out.push(r);}
 return out.sort((a,b)=>a.t-b.t);
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
 if(!layout)return null;const collected=layout.source==='collected'||layout.source==='published';
 const byId=new Map(services.map(s=>[s.id,s]));
 const staticPaths=new Map(layout.blocks.flatMap(b=>(b.models||[]).map(m=>[m.id,m.path??null])));
 const blocks=layout.blocks.map(b=>{
  if(!b.service)return {...b};
  // Collected layouts already carry the state seen on the device; live bridge data only
  // refines blocks whose service the bridge actually reports.
  if(collected&&!byId.has(b.service))return {...b,models:b.models||[]};
  const svc=byId.get(b.service);const running=svc?.status==='reachable',port=svc?.url?String(svc.url).split(':')[2]||'':null;
  // port and desc are sentences built here, in the source language; portT / descT carry their parts
  // (server/text.mjs), so the browser can say them in the reader's language.
  return {...b,state:running?'on':'off',
   port:port!==null?`:${port} · ${running?'živě':'dřív'}`:b.port,
   ...(port!==null?{portT:[{key:running?':{port} · živě':':{port} · dřív',params:{port}}]}:{}),
   models:running?(svc.models||[]).map(m=>({id:m.id,state:m.state,sizeGb:m.sizeBytes!=null?Math.round(m.sizeBytes/1073741824*10)/10:null,path:staticPaths.get(m.id)??null,ttlSeconds:m.ttlSeconds??null,ttlRemainingSeconds:m.ttlRemainingSeconds??null})).slice(0,30):[],
   stats:running?{requests:svc.stats?.requests??null,uptimeSeconds:svc.stats?.uptimeSeconds??null}:null,
   pool:running&&svc.pool?{capacityGb:svc.pool.capacityGb,allocatedGb:svc.pool.allocatedGb}:null,
   desc:running?b.desc:`${b.desc} — služba teď nedosaditelná.`,
   ...(running?{}:{descT:[{key:b.desc||'',params:{}},{key:'— služba teď nedosaditelná.',params:{}}]})};
 });
 return {...layout,blocks};
}
// A published runtime stack (runtime_publish, parseRuntime in home-devices.mjs) as the grid the page draws:
// layers = the names of the layers that hold a block, top to bottom; a block's layer is an index into it.
export function runtimeGrid(entry){
 const stack=entry?.stack;if(!stack||!Array.isArray(stack.blocks)||!Array.isArray(stack.cols))return null;
 const layerKeys=RUNTIME_LAYERS.filter(l=>stack.blocks.some(b=>b.layer===l));
 return {source:'published',publishedAt:entry.publishedAt||null,publishedBy:entry.publishedBy||null,hash:runtimeHash(stack),
  layers:layerKeys.map(l=>l.toUpperCase()),layerKeys,cols:[...stack.cols],engines:{...stack.engines},
  blocks:stack.blocks.map(b=>({...b,layer:layerKeys.indexOf(b.layer),...(b.layer==='engine'?{engine:true}:{}),...(b.layer==='hardware'?{hw:true}:{}),models:(b.models||[]).map(m=>({...m}))}))};
}
// Telemetry of one machine, in words that never claim more than was seen:
//   not-installed  the machine names no telemetry host (no thermoId)
//   not-applicable a router: the agent does not run there, the router adapter reports it instead
//   ok             the newest reading is at most TELEMETRY_STALE_SECONDS old
//   stale          there are readings, but the newest is older than that
//   unreachable    a host is named and nothing has been read from it. reason: no-login (the hub has no login
//                  for that host id), denied (the agent refused the login), down (the last pull failed),
//                  no-data (connected, nothing received yet), waiting (not tried yet)
// A failed pull says the agent did not answer; it is not proof the machine is off.
// provider (only when a host is named): "thermo", or an agent-less one (windows, winrm, node-exporter, prometheus,
// linux-ssh; the details below say "Windows" but hold for each). Such a machine has no Thermo id (thermoId
// null, hostId = its own id, target = the label of the connection it is read through: user@host[:port] for an
// app-managed one, the SSH alias for an older one; connection = {mode:"managed", host, port, user, keyFingerprint,
// hostKeyFingerprint} or {mode:"alias", target}: public facts only, never a key or a path), and when it is not "ok" also detail: the last error code of the SSH collector
// (host-key-unknown, denied, timeout, … see server/windows-telemetry.mjs → WINDOWS_ERRORS), or null, and hint: that
// code's source-language sentence (what to do), or null.
export function telemetryFor(def,thermo,nowSec){
 if(!def.thermo)return {state:def.kind==='router'?'not-applicable':'not-installed',thermoId:null,lastSampleAt:null,ageSeconds:null,reason:null};
 if(isFeed(def.provider)){const r=telemetryFor({...def,provider:undefined},thermo,nowSec),error=thermo?.status?.()?.[def.thermo]?.error,errors=feedErrors(def.provider);
  const target=thermo?.targets?.()?.[def.thermo],connection=thermo?.connections?.()?.[def.thermo];
  return {...r,thermoId:null,provider:def.provider,hostId:def.thermo,target:typeof target==='string'?target:null,connection:connection&&typeof connection==='object'?connection:null,detail:r.state==='ok'?null:typeof error==='string'?error:null,
   hint:r.state!=='ok'&&typeof error==='string'&&Object.hasOwn(errors,error)?errors[error]:null};}
 const ring=thermo?.seconds?.(def.thermo)||[],rows=thermo?.minutes?.(def.thermo)||[],live=thermo?.live?.()?.[def.thermo]?.reading;
 const stamps=[ring.length?ring.at(-1).t:null,rows.length?rows.at(-1).t:null,live?.t].filter(Number.isFinite);
 const newest=stamps.length?Math.max(...stamps):null,age=newest===null?null:Math.max(0,nowSec-newest);
 const state=age===null?'unreachable':age<=TELEMETRY_STALE_SECONDS?'ok':'stale';
 const status=thermo?.status?.()?.[def.thermo]?.state||null,hosts=thermo?.hosts?.();
 const reason=state==='ok'?null:Array.isArray(hosts)&&!hosts.includes(def.thermo)?'no-login':status==='denied'?'denied':status==='down'?'down':status==='up'?'no-data':'waiting';
 return {state,thermoId:def.thermo,lastSampleAt:newest===null?null:new Date(newest*1000).toISOString(),ageSeconds:age,reason};
}
// Local LLM runtimes on a machine, as a provider reported them (extension point home.runtimes, see
// docs/plugins.md). Core reads no runtime itself: it only bounds and cleans what a provider hands over. A
// machine no provider reports on carries runtimes: null, and its page then has no such section at all.
const RUNTIME_STATES=['running','stopped','unknown'];
export function runtimesFor(entry){
 if(!entry||typeof entry!=='object'||!Array.isArray(entry.runtimes))return null;
 const sources=Array.isArray(entry.sources)?[...new Set(entry.sources.map(x=>text(x,40)).filter(Boolean))].slice(0,4):[];
 return {source:text(entry.source,40)||sources[0]||'',...(sources.length>1?{sources}:{}),observedAt:text(entry.observedAt,40)||null,
  runtimes:entry.runtimes.filter(r=>r&&typeof r==='object').slice(0,20).map(r=>({id:text(r.id,60),name:text(r.name,60)||text(r.id,60),kind:text(r.kind,40),
   status:RUNTIME_STATES.includes(r.status)?r.status:'unknown',url:text(r.url,120)||null,version:text(r.version,40)||null,
   ...(r.source?{source:text(r.source,40)}:{}),
   models:Array.isArray(r.models)?r.models.filter(m=>m&&typeof m==='object').slice(0,30).map(m=>({id:text(m.id,120),state:text(m.state,16),sizeGb:number(m.sizeGb,100000),
    contextTokens:number(m.contextTokens,1e9),ttlRemainingSeconds:number(m.ttlRemainingSeconds,1e9)})):[],
   stats:Array.isArray(r.stats)?r.stats.filter(x=>x&&typeof x==='object').slice(0,12).map(x=>({label:text(x.label,40),value:text(String(x.value??''),40)})):[]}))};
}
// Several home.runtimes providers (the direct adapters of core, a plugin's bridge, …) may report one machine.
// reports = their values, in registry order. Per machine the runtimes are joined and each runtime appears
// once: two entries are the same runtime when they listen on the same address (any loopback name counts as
// one), or carry the same id and one of them has no address. Of the two, the richer one is kept (a known
// state beats "unknown", then the one that says more: models and their sizes, context and TTL, figures,
// version; the first reported wins a tie) and the gaps in it are filled from the other: its version, the
// size / context / TTL of a model both list, and figures it lacks (up to four in all). Models only the other lists are added
// when that one is not stale. The machine names every source that contributed to a runtime, and the oldest
// observation time of the entries it shows (a stale plugin that only filled in sizes does not make it stale).
const endpointKey=url=>{try{const u=new URL(url),host=['localhost','[::1]'].includes(u.hostname)||/^127\./.test(u.hostname)?'loopback':u.hostname;
 return `${host}:${u.port||(u.protocol==='https:'?'443':'80')}`;}catch{return null;}};
const richness=r=>(r.status!=='unknown'?1000:0)+(Array.isArray(r.models)?r.models.length*2+r.models.reduce((a,m)=>a+['sizeGb','contextTokens','ttlRemainingSeconds'].filter(k=>m?.[k]!=null).length,0):0)+(Array.isArray(r.stats)?r.stats.length*3:0)+(r.version?2:0);
function fillRuntime(base,other){
 const theirs=new Map((other.models||[]).filter(m=>m&&typeof m.id==='string').map(m=>[m.id,m]));
 const models=(base.models||[]).map(m=>{const o=theirs.get(m?.id);if(!o)return m;const out={...m};for(const k of ['sizeGb','contextTokens','ttlRemainingSeconds'])if(out[k]==null&&o[k]!=null&&(k!=='ttlRemainingSeconds'||o.state===m.state))out[k]=o[k];return out;});
 if(other.status!=='unknown')for(const o of theirs.values())if(!models.some(m=>m?.id===o.id))models.push(o);
 const labels=new Set((base.stats||[]).map(x=>x?.label));
 return {...base,version:base.version||other.version||null,url:base.url||other.url||null,models:models.slice(0,30),
  stats:[...(base.stats||[]),...(other.stats||[]).filter(x=>x&&!labels.has(x.label))].slice(0,Math.max(4,(base.stats||[]).length)),
  _from:[...new Set([...(base._from||[base.source]),...(other._from||[other.source])])],_observedAt:base._observedAt};
}
export function mergeRuntimeReports(reports=[]){
 const out={};
 const entries=new Map();
 for(const report of reports){if(!report||typeof report!=='object')continue;
  for(const [machine,entry] of Object.entries(report)){if(!entry||typeof entry!=='object'||!Array.isArray(entry.runtimes))continue;if(!entries.has(machine))entries.set(machine,[]);entries.get(machine).push(entry);}}
 for(const [machine,list] of entries){
  if(list.length===1){out[machine]=list[0];continue;}
  const kept=[];
  for(const entry of list)for(const r of entry.runtimes){
   if(!r||typeof r!=='object')continue;
   const tagged={...r,source:r.source||entry.source||'',_observedAt:entry.observedAt||null},key=endpointKey(r.url);
   const i=kept.findIndex(k=>key&&endpointKey(k.url)===key||k.id===r.id&&(!key||!endpointKey(k.url)));
   if(i<0){kept.push(tagged);continue;}
   const [base,other]=richness(tagged)>richness(kept[i])?[tagged,kept[i]]:[kept[i],tagged];
   kept[i]=fillRuntime(base,other);
  }
  const sources=[...new Set(kept.flatMap(r=>r._from||[r.source]).filter(Boolean))];
  const times=kept.map(r=>r._observedAt).filter(Boolean).sort();
  out[machine]={source:sources[0]||'',sources,observedAt:times[0]||null,runtimes:kept.map(({_observedAt,_from,...r})=>r)};
 }
 return out;
}
// What a stack block that names a service needs from a runtime nobody's host agent reports (see mergeStack):
// a runtime read directly then fills its block the same way a bridge's service does. Only runtimes in a known
// state: "unknown" would draw the block as off.
const runtimeServices=reported=>(reported?.runtimes||[]).filter(r=>r.status!=='unknown').map(r=>({id:r.id,name:r.name,status:r.status==='running'?'reachable':'unreachable',url:r.url,
 models:r.models.map(m=>({id:m.id,state:m.state,sizeBytes:m.sizeGb!=null?m.sizeGb*1073741824:null,ttlRemainingSeconds:m.ttlRemainingSeconds}))}));
// The small chart on a tile: one utilisation series over the hub's live window, the last ten minutes of the
// 1-second readings it holds, in 10 s steps that end on the last full step of the clock (two reads a few
// seconds apart then agree, and the newest step is never half empty). A step without a reading is null: the
// chart leaves a gap there, never a guess. prefer: the series to draw when the machine has it; CPU otherwise.
// null when the window holds nothing for it.
export const SPARK_WINDOW_SECONDS=600,SPARK_STEP_SECONDS=10;
export function sparkFor(thermo,machine,nowSec,prefer='cpu'){
 const step=SPARK_STEP_SECONDS,n=SPARK_WINDOW_SECONDS/step,end=Math.floor(nowSec/step)*step,start=end-n*step;
 const sums={cpu:Array(n).fill(0),gpu:Array(n).fill(0)},counts={cpu:Array(n).fill(0),gpu:Array(n).fill(0)};
 for(const r of spreadSpans(thermo?.seconds?.(machine,start-SPAN_SPREAD_MAX)||[],step)){
  if(!Number.isFinite(r?.t)||r.t<=start||r.t>end)continue;const i=Math.ceil((r.t-start)/step)-1;
  for(const key of ['cpu','gpu'])if(Number.isFinite(r[key])){sums[key][i]+=r[key];counts[key][i]++;}
 }
 const series=prefer==='gpu'&&counts.gpu.some(Boolean)?'gpu':'cpu';
 if(!counts[series].some(Boolean))return null;
 return {series,end,stepSeconds:step,windowSeconds:SPARK_WINDOW_SECONDS,values:sums[series].map((v,i)=>counts[series][i]?Math.round(v/counts[series][i]*10)/10:null)};
}
// Telemetry agents this hub can connect a device to. The "Telemetry" step of Add device offers exactly these,
// so an adapter added here (with its form in public/home-add-device.js) appears there by itself. One today.
// connect: how the hub gets in ("account" = a user and password on the agent, sent only to a pinned certificate).
// summary: what it measures, in the source language (English in public/i18n-en-home.js).
// "windows" needs no agent: the hub reads the machine over key-only SSH (connect "ssh"), see server/windows-telemetry.mjs.
// platform: the system the adapter reads (Thermo is a macOS agent). recommended: the first choice for that system.
// connect "endpoint" = an HTTP(S) endpoint with optional credentials (WinRM, Node Exporter, Prometheus); "ssh" = the hub's own key.
const MIN=WINDOWS_MIN_INTERVAL_MS/1000;
export const TELEMETRY_ADAPTERS=Object.freeze([Object.freeze({id:'thermo',name:TELEMETRY_AGENT_NAME,repoUrl:TELEMETRY_REPO_URL,connect:'account',platform:'macos',defaultPort:49286,summary:'CPU, GPU, paměť, příkon, teploty a disky'}),
 Object.freeze({id:WINDOWS_PROVIDER,name:WINDOWS_ADAPTER_NAME,repoUrl:null,connect:'ssh',platform:'windows',defaultPort:22,minIntervalSeconds:MIN,
  summary:'CPU a jádra, GPU, paměť, disky a síť přes SSH a PowerShell, bez agenta; teploty a příkon Windows nehlásí'}),
 Object.freeze({id:WINRM_PROVIDER,name:WINRM_NAME,repoUrl:null,connect:'endpoint',platform:'windows',defaultPort:WINRM_PORT,minIntervalSeconds:MIN,
  summary:'stejné čítače Windows přes WinRM HTTPS (WMI jen ke čtení), přihlášení Basic místním účtem po ověření certifikátu'}),
 Object.freeze({id:NODE_EXPORTER_PROVIDER,name:NODE_EXPORTER_NAME,repoUrl:'https://github.com/prometheus/node_exporter',connect:'endpoint',platform:'linux',recommended:true,defaultPort:NODE_EXPORTER_PORT,minIntervalSeconds:MIN,
  summary:'CPU a jádra, paměť, svazky, disky, síť a teploty z /metrics Node Exporteru; Prometheus server není potřeba'}),
 Object.freeze({id:PROMETHEUS_PROVIDER,name:PROMETHEUS_NAME,repoUrl:'https://prometheus.io/docs/prometheus/latest/installation/',connect:'endpoint',platform:'linux',defaultPort:PROMETHEUS_PORT,minIntervalSeconds:MIN,
  summary:'metriky Linuxu jednoho cíle node_exporter z Prometheu, který už máš (API jen ke čtení)'}),
 Object.freeze({id:LINUX_SSH_PROVIDER,name:LINUX_SSH_NAME,repoUrl:null,connect:'ssh',platform:'linux',defaultPort:22,minIntervalSeconds:MIN,
  summary:'bez agenta: pevný skript, který jen čte /proc, /sys a df, přes SSH klíčem Home Hubu'})]);
export const telemetryMeta=()=>({agent:TELEMETRY_AGENT_NAME,repoUrl:TELEMETRY_REPO_URL,staleAfterSeconds:TELEMETRY_STALE_SECONDS,adapters:TELEMETRY_ADAPTERS.map(a=>({...a}))});
// Whole /api/home payload. site = the site configuration; thermo = createThermoPoller(); router =
// readRouter() result. Two optional feeds come from plugins (docs/plugins.md → extension points):
// snapshots = {machineId: {snapshot, bridge}} (what a host agent reports: services, memory, uptime) and
// probed = {machineId: services[]|null} (service probes for a machine without an agent, e.g. a NAS).
// Missing pieces degrade to offline tiles, never throw.
// published = {machineId: {stack, publishedAt, publishedBy}} (runtime_publish): it replaces the stack of the
// site configuration or of a collected descriptor. runtimes = {machineId: {...}} from home.runtimes providers.
// Each machine with telemetry also carries spark, the series of its tile's small chart (sparkFor).
// sitePictures = {machineId: url} for the site machines that have their own tile picture.
// siteTelemetry = the effective site bindings ([{id, provider, platform, configuredAt}], homeDevices.siteBindings()).
// siteOverrides = {machineId: override} (homeDevices.siteOverrides()): what the owner changed on a site machine's tile.
export function buildHome({site,snapshots:computeLatest={},thermo,router=null,probed={},descriptors={},added=[],published={},runtimes={},sitePictures=null,siteTelemetry=[],siteOverrides={},now=Date.now()}={}){
 const layouts=stackLayouts(site);
 const nowSec=Math.floor(now/1000);
 const poll=thermo?.interval?.()||{intervalSeconds:QUAD_WINDOW_SECONDS,lastPollAt:null};
 // source: where a machine is defined. "site" = the site configuration, read-only from the API.
 const roles=new Map(site.machines.map(m=>[m.id,m.role]));
 const bound=new Map((siteTelemetry||[]).map(b=>[b.id,b])),siteOf=id=>site.machines.find(m=>m.id===id);
 const machines=[...homeDefinitions(site).map(d=>boundSiteDefinition({...d,role:roles.get(d.id),source:'site',readOnly:true},siteOf(d.id),bound.get(d.id)||null)),...added.map(d=>({...addedDefinition(d),telemetryEditable:true}))].map(base=>{
  const collected=machineFromDescriptor(descriptors[base.id],site);const def={...base,...(collected||{}),props:{...base.props,...(collected?.props||{})}};
  if(sitePictures&&!def.added)def.image=Object.hasOwn(sitePictures,def.id)?sitePictures[def.id]:null;
  // The owner's override wins over the site's values and over a collected descriptor: it is the most deliberate.
  if(def.source==='site')Object.assign(def,overriddenSiteDefinition(def,siteOf(def.id),Object.hasOwn(siteOverrides||{},def.id)?siteOverrides[def.id]:undefined));
  const publishedStack=Object.hasOwn(published||{},def.id)?runtimeGrid(published[def.id]):null;
  // Service probes belong to what the machine is (role nas), not to how its telemetry is read.
  const nasServices=(def.kind==='nas'||def.role==='nas')&&Array.isArray(probed?.[def.id])?probed[def.id]:null;
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
   // A NAS with telemetry: a service that answers says it is up, whatever the telemetry source says right now.
   const answering=Array.isArray(nasServices)?nasServices.filter(s=>s.status==='reachable'||s.status==='auth-required'):[];
   if(answering.length&&online!=='online')online='online';
   const stamps=[seconds.length?seconds.at(-1).t*1000:null,snapshot?.collectedAt?Date.parse(snapshot.collectedAt):null,...answering.map(s=>Date.parse(s.observedAt||'')).filter(Number.isFinite)].filter(Boolean);
   lastSeen=stamps.length?new Date(Math.max(...stamps)).toISOString():null;
  }
  const services=Array.isArray(nasServices)?nasServices.map(s=>({id:s.id,name:s.name,status:s.status==='auth-required'?'reachable':s.status,url:s.url,models:s.models||[]})):snapshot?.services||[];
  let routerQuad=def.kind==='router'&&router&&router.status==='ok'?{clients:router.devices.length,wifi:router.devices.filter(d=>String(d.connection).startsWith('Wi-Fi')).length,power:null,temp:null}:null;
  // No live router feed yet: show the freshly collected census, marked stale with its time.
  const census=def.kind==='router'&&Array.isArray(descriptors[def.id]?.clients)?descriptors[def.id].clients:null;
  if(def.kind==='router'&&!routerQuad&&census){routerQuad={clients:census.length,wifi:census.filter(c=>c.connection==='wifi'||c.connection==='wireless').length,power:null,temp:null};online='stale';lastSeen=collected?.collectedAt||null;}
  const reported=runtimesFor(Object.hasOwn(runtimes||{},def.id)?runtimes[def.id]:null);
  return {...def,hostname:def.hostname||'',ip:def.ip,online,lastSeen,
   thermo:thermoStatus||null,bridge:entry.bridge||null,
   quad:live||routerQuad,
   volumes:volumesFor(thermo,def.thermo||def.id),
   memoryUsedBytes:snapshot?.memory?.usedBytes??null,memoryTotalBytes:snapshot?.memory?.totalBytes??(def.props?.ramGb!=null?def.props.ramGb*1073741824:null),
   uptimeSeconds:snapshot?.uptimeSeconds??null,
   services:services.map(s=>({id:s.id,name:s.name,status:s.status,url:s.url,models:(s.models||[]).filter(m=>m.state==='loaded').map(m=>m.id)})),
   collectedAt:collected?.collectedAt||null,reviewNeeded:collected?.reviewNeeded||[],
   telemetry:telemetryFor(def,thermo,nowSec),
   platform:PLATFORMS.includes(def.platform)?def.platform:null,
   // What only Windows telemetry reports (per-core load, disk and network rates, each GPU); null elsewhere.
   native:isFeed(def.provider)?thermo?.native?.()?.[def.thermo]||null:null,
   runtimes:reported,
   // A machine that reports LLM runtimes works on its GPU; anywhere else the CPU says more.
   spark:def.thermo?sparkFor(thermo,def.thermo,nowSec,reported?.runtimes.length?'gpu':'cpu'):null,
   stack:mergeStack(def.id,[...services,...runtimeServices(reported).filter(r=>!services.some(s=>s.id===r.id))],publishedStack||collected?.stack||layouts[def.id]||null)};
 });
 const routerClients=router&&Array.isArray(router.devices)?router.devices.filter(d=>['associated','reachable','lease-only'].includes(d.presence)).length:null;
 return {poll,schemaVersion:1,generatedAt:new Date(now).toISOString(),machines,
  telemetry:telemetryMeta(),
  router:router?{status:router.status,freshness:router.freshness,observedAt:router.observedAt,model:router.model,firmware:router.firmware,clients:routerClients}:null};
}
// bindings: the effective site bindings; a site machine bound to a provider has history like an added device.
export function homeHistoryQuery(input,added=[],site={machines:[]},bindings=[]){
 const machine=input?.machine,range=input?.range??'30m';
 if(![...site.machines,...added].some(h=>h.id===machine)||!Object.hasOwn(homeRanges,String(range)))throw new Error('invalid');
 if(!site.machines.some(m=>m.id===machine&&m.thermoId)&&!bindings.some(b=>b.id===machine&&site.machines.some(m=>m.id===machine))
  &&!added.some(d=>d.id===machine&&(d.thermoId||d.kind==='thermo'||isFeed(d.telemetryProvider))))return {machine,range,points:[],complete:false,source:'žádný zdroj',reason:'Stroj nemá připojenou telemetrii.'};
 return {machine,range};
}

// Machine descriptors (data/machines/<id>.json) are collected fresh from each device; they
// replace the static identity/props/stack above whenever present and valid.
function validStack(st){
 if(!st||!Array.isArray(st.layers)||!Array.isArray(st.cols)||!Array.isArray(st.blocks)||!st.cols.length||st.blocks.length>60)return null;
 const blocks=st.blocks.filter(b=>b&&typeof b.id==='string'&&Number.isInteger(b.layer)&&b.layer>=0&&b.layer<st.layers.length&&Number.isInteger(b.col0)&&Number.isInteger(b.col1)&&b.col0>=0&&b.col1>=b.col0&&b.col1<st.cols.length)
  .map(b=>({id:text(b.id,60),layer:b.layer,col0:b.col0,col1:b.col1,title:text(b.title,60),port:text(b.port,80),desc:text(b.desc,400),
   ...(b.service?{service:text(b.service,60)}:{}),state:b.state==='off'?'off':'on',
   // An engine: marked so, or a block without a service in the layer named ENGINE (as collected stacks write it).
   ...(b.engine&&!b.service||!b.service&&/^engine$/i.test(String(st.layers[b.layer]||''))&&b.layer!==st.layers.length-1?{engine:true}:{}),...(b.hw||b.layer===st.layers.length-1?{hw:true}:{}),
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

// The machines as the machine API lists them (GET /api/home/machines, MCP machine_list): the site's own
// (read-only) and the stored ones with their hash. home = a buildHome() payload, for telemetry and the stack.
// withStack: also return what is published for each machine, in the form runtime_publish takes.
// siteTelemetry: the effective site bindings; a bound site machine lists the platform its provider reads.
// siteOverrides: as for buildHome; a site machine lists its effective name, address, hardware and picture, and which of
// them the owner overrode (siteOverride: {fields, updatedAt, updatedBy}, or null). It stays read-only to the API.
export function machineList({site,added=[],published={},home=null,withStack=false,siteTelemetry=[],siteOverrides={}}={}){
 const live=new Map((home?.machines||[]).map(m=>[m.id,m]));
 const runtime=id=>{const m=live.get(id),entry=Object.hasOwn(published||{},id)?published[id]:null;
  const source=entry?'published':m?.stack?.source==='collected'?'collected':m?.stack?'site':null;
  return {source,publishedAt:entry?.publishedAt||null,publishedBy:entry?.publishedBy||null,hash:entry?runtimeHash(entry.stack):null,...(withStack?{stack:entry?.stack||null}:{})};};
 // How a Windows machine is reached (its SSH target and connection) is for the signed-in UI (GET /api/home), not for agents.
 const telemetry=id=>{const t=live.get(id)?.telemetry;if(!t)return null;const {target,connection,...rest}=t;return rest;};
 const machines=[
  ...site.machines.map(m=>{const o=Object.hasOwn(siteOverrides||{},m.id)?siteOverrides[m.id]:null,f=o?.fields||{};
   const shown=o?overriddenSiteDefinition({},m,o):null;
   return {id:m.id,name:f.name??m.name,hostname:f.hostname??m.hostname,ip:(Object.hasOwn(f,'ip')?f.ip:m.ip)||null,role:m.role,hardware:{...m.hardware,...(f.hardware||{})},thermoId:m.thermoId,
   picture:f.picture?pictureUrl(f.picture):m.picture,
   platform:m.platform||siteTelemetry.find(b=>b.id===m.id)?.platform||null,
   source:'site',readOnly:true,hash:null,customPicture:o?.image===true,siteOverride:shown?{fields:shown.siteOverride.fields,updatedAt:shown.siteOverride.updatedAt,updatedBy:shown.siteOverride.updatedBy}:null,
   telemetry:telemetry(m.id),runtime:runtime(m.id)};}),
  ...added.map(d=>({...machineFields(d),source:d.source,readOnly:false,hash:machineHash(d),customPicture:d.image===true,
   createdAt:d.createdAt||null,createdBy:d.createdBy||null,updatedAt:d.updatedAt||null,updatedBy:d.updatedBy||null,telemetry:telemetry(d.id),runtime:runtime(d.id)}))];
 return {machines,pictures:PICTURES.map(id=>({id,url:pictureUrl(id)})),roles:[...MACHINE_ROLES],platforms:[...PLATFORMS],runtimeLayers:[...RUNTIME_LAYERS],lanCidrs:[...site.lanCidrs],
  limits:{machines:DEVICE_LIMITS.devices},telemetry:telemetryMeta()};
}
