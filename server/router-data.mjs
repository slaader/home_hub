// Router adapter: where the client census and the router's own health come from.
//
// The contract is small on purpose. An adapter is {id, title, read(context) → observation | null}:
//   observation = {status: "ok" | anything else, observedAt, attemptedAt, error,
//                  model, firmware, routerMac,
//                  devices: [{mac, ip, name, connection, presence}],          the census
//                  hardware: [{name, model, state, firmware, ip}],            gateway, switches, access points
//                  clientCounts: {wired, wireless, other}, softwareVersion}   optional
// Core checks and bounds whatever an adapter returns (normalizeRouter), keeps only clients inside the
// site's networks (site.json → lanCidrs) and works out the state the UI shows:
//   not-configured   no adapter           waiting   an adapter, but no observation yet
//   unavailable      the last attempt failed (the previous census is kept)
//   stale            older than three minutes        ok
// Included adapter: "unifi", a file drop. scripts/collect-router-unifi.py reads a UniFi gateway
// (read-only) and writes data/router-observations.json; this module only reads that file.
// Another router: a plugin provides "router.adapter" → {id, title, read} (docs/plugins.md), or writes
// the same file from its own collector. site.json → router.adapter names the one in use.
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {inCidrs} from './site-config.mjs';
import {COLLECTORS,staleAfter} from './collector-state.mjs';
const safe=(v,max=160)=>typeof v==='string'?v.replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,max):'';
const macPattern=/^(?:[a-f0-9]{2}:){5}[a-f0-9]{2}$/i;
const count=v=>Number.isSafeInteger(v)&&v>=0?v:null;
export const ROUTER_FILE='router-observations.json';
export const ROUTER_CONNECTIONS=Object.freeze(['Wi-Fi · 2.4 GHz','Wi-Fi · 5 GHz','Wi-Fi · 6 GHz','Wi-Fi','Ethernet']);
export const ROUTER_PRESENCE=Object.freeze(['associated','reachable','lease-only']);

// The file adapter's read: the snapshot a collector left in the data directory, or null.
export async function readObservationFile(directory){
 try{const raw=JSON.parse(await readFile(path.join(directory,ROUTER_FILE),'utf8'));return raw&&typeof raw==='object'&&!Array.isArray(raw)?raw:null;}catch{return null;}
}
export const ROUTER_ADAPTERS=Object.freeze({
 unifi:Object.freeze({id:'unifi',title:'UniFi Network',collector:COLLECTORS.router.script,read:({directory})=>readObservationFile(directory)}),
});
const validAdapter=a=>a&&typeof a==='object'&&typeof a.id==='string'&&/^[a-z][a-z0-9-]{1,31}$/.test(a.id)&&typeof a.read==='function';

// One raw observation → what the API serves. raw = null means "nothing observed yet".
// lanCidrs: only clients with a host address inside the site's networks are kept (none configured = any IPv4).
export function normalizeRouter(raw,{lanCidrs=[],adapter=null,now=Date.now(),staleAfterSeconds=staleAfter(COLLECTORS.router)}={}){
 const who=adapter?{id:adapter.id,title:safe(adapter.title||adapter.id,60)}:null;
 if(!raw)return {status:'not-configured',state:adapter?'waiting':'not-configured',adapter:who,observedAt:null,attemptedAt:null,error:null,freshness:'unknown',staleAfterSeconds,model:'',firmware:'',routerMac:null,devices:[],health:null};
 const age=now-Date.parse(raw.observedAt),freshness=!Number.isFinite(age)||age< -60000?'unknown':age>staleAfterSeconds*1000?'stale':'fresh';
 const devices=Array.isArray(raw.devices)?raw.devices.slice(0,500).filter(d=>d&&macPattern.test(d.mac)&&inCidrs(d.ip,lanCidrs)).map(d=>({mac:d.mac.toLowerCase(),id:d.mac.toLowerCase().replaceAll(':',''),ip:d.ip,name:safe(d.name),connection:ROUTER_CONNECTIONS.includes(d.connection)?d.connection:'Unknown',presence:ROUTER_PRESENCE.includes(d.presence)?d.presence:'cache-only'})):[];
 const status=raw.status==='ok'?'ok':'unavailable';
 const hardware=(Array.isArray(raw.hardware)?raw.hardware:Array.isArray(raw.unifiDevices)?raw.unifiDevices:[]).slice(0,50).filter(h=>h&&typeof h==='object')
  .map(h=>({name:safe(h.name,80),model:safe(h.model,60),state:safe(h.state,32).toUpperCase()||'UNKNOWN',firmware:safe(h.firmware,64),ip:inCidrs(h.ip,lanCidrs)?h.ip:null}));
 const counts=raw.clientCounts&&typeof raw.clientCounts==='object'?raw.clientCounts:{};
 const wireless=devices.filter(d=>d.connection.startsWith('Wi-Fi')).length,wired=devices.filter(d=>d.connection==='Ethernet').length;
 const down=hardware.filter(h=>h.state!=='ONLINE'&&h.state!=='UNKNOWN').length;
 const state=status!=='ok'?'unavailable':freshness==='fresh'?'ok':'stale';
 return {status,state,adapter:who,freshness,staleAfterSeconds,observedAt:raw.observedAt||null,attemptedAt:raw.attemptedAt||null,error:status==='ok'?null:safe(raw.error,80)||'unavailable',
  model:safe(raw.model),firmware:safe(raw.firmware),routerMac:macPattern.test(raw.routerMac)?raw.routerMac.toLowerCase():null,devices,
  // Health: is the feed alive, is every piece of network hardware online, how many clients are connected.
  health:{status:state!=='ok'?'unknown':down?'degraded':'ok',softwareVersion:safe(raw.softwareVersion||raw.applicationVersion,40),source:safe(raw.source,60),backend:safe(raw.backend,40),
   hardware,hardwareDown:down,clients:{connected:devices.length,wired:count(counts.wired)??wired,wireless:count(counts.wireless)??wireless,other:count(counts.other)??devices.length-wired-wireless,
    known:raw.knownClients&&typeof raw.knownClients==='object'?Math.min(Object.keys(raw.knownClients).length,5000):null}}};
}

// The file adapter by its data directory, as before the adapter contract existed. Kept for callers that
// have no hub (plugins, scripts): a missing file reads as "not-configured".
export async function readRouter(directory,{lanCidrs=[],now=Date.now()}={}){
 const raw=await readObservationFile(directory);
 return normalizeRouter(raw,{lanCidrs,adapter:raw?ROUTER_ADAPTERS.unifi:null,now});
}
// Which adapter this hub uses: a plugin's (extension point router.adapter), else the one site.json
// names, else, for a hub that already has an observation file from before the setting existed, the
// file adapter. null = no router feed is configured.
export async function routerAdapter(hub){
 const provided=await Promise.resolve(hub.provided?.('router.adapter')).catch(()=>null);
 const wanted=hub.site.router?.adapter||null;
 if(validAdapter(provided)&&(!wanted||wanted===provided.id))return provided;
 if(wanted)return ROUTER_ADAPTERS[wanted]||{id:wanted,title:wanted,missing:true,read:async()=>null};
 return await readObservationFile(hub.directory)?ROUTER_ADAPTERS.unifi:null;
}
// The census and health for a hub, whatever adapter it uses. An adapter that throws is "unavailable".
export async function readRouterFor(hub,{now=Date.now()}={}){
 const adapter=await routerAdapter(hub),lanCidrs=hub.site.lanCidrs;
 if(!adapter)return normalizeRouter(null,{lanCidrs,now});
 let raw;try{raw=await adapter.read({directory:hub.directory,site:hub.site,hub});}catch{raw={status:'unavailable',error:'adapter-failed'};}
 const staleAfterSeconds=Number.isSafeInteger(adapter.staleAfterSeconds)&&adapter.staleAfterSeconds>=60&&adapter.staleAfterSeconds<=86400?adapter.staleAfterSeconds:undefined;
 return {...normalizeRouter(raw&&typeof raw==='object'&&!Array.isArray(raw)?raw:null,{lanCidrs,adapter,now,...(staleAfterSeconds?{staleAfterSeconds}:{})}),...(adapter.missing?{error:'unknown-adapter'}:{})};
}
export function mergeRouter(inventory,router){
 const devices=inventory.devices.map(d=>({...d})),lookup=new Map(devices.map(d=>[d.id,d])),viaAlias=new Map();
 for(const d of devices)for(const m of d.routerMacs||[]){const id=m.replaceAll(':','');if(!lookup.has(id))viaAlias.set(id,d);}
 const primaryObserved=new Set(router.devices.map(r=>r.id));
 for(const r of router.devices){
  const alias=viaAlias.get(r.id);let d=lookup.get(r.id)||alias;
  if(!d){if(devices.length>=500)continue;d={id:r.id,mac:r.mac,ip:r.ip,name:r.name||'Unidentified device',model:'Not checked',role:'Unknown',confidence:'Needs review',identity:'Router-observed device; exact identity not verified',connection:'Unknown',connectionNote:'Not reported',firmware:'Not checked',software:'Not checked',support:'Not checked',observedAt:router.observedAt,observation:'Reported by router',notes:[],evidence:[]};devices.push(d);lookup.set(r.id,d);}
  // A secondary NIC keeps its evidence but cannot replace a simultaneously observed primary NIC.
  if(!alias||!primaryObserved.has(d.id)){d.ip=r.ip;d.routerPresence=r.presence;d.routerObservedAt=router.observedAt;d.routerFreshness=router.status==='ok'?router.freshness:'stale';}
  if(alias){d.connectionNote=`${d.connectionNote} · router sees it as ${r.mac} (${r.connection}) · ${router.observedAt}`;}
  else if(r.connection!=='Unknown'){d.connection=r.connection;d.connectionNote=(r.connection==='Ethernet'?'Router client table · ':'Router wireless association table · ')+router.observedAt;}
  d.evidence=[...d.evidence,{label:'Latest router observation',value:`${r.presence} · ${router.observedAt}`},{label:'Router-reported name',value:r.name||'Not reported'}];
 }
 if(router.routerMac&&router.firmware){const routerDevice=lookup.get(router.routerMac.replaceAll(':',''));if(routerDevice){routerDevice.firmware=router.firmware;routerDevice.routerPresence='reporting';routerDevice.routerObservedAt=router.observedAt;routerDevice.routerFreshness=router.status==='ok'?router.freshness:'stale';routerDevice.evidence=[...routerDevice.evidence,{label:'Router firmware observation',value:router.firmware+' · '+router.observedAt}];}}
 return {...inventory,devices};
}
