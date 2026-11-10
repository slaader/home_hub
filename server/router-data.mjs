import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {inCidrs} from './site-config.mjs';
const safe=(v,max=160)=>typeof v==='string'?v.slice(0,max):'';
const macPattern=/^(?:[a-f0-9]{2}:){5}[a-f0-9]{2}$/i;
// lanCidrs: only clients with a host address inside the site's networks are kept (none configured = any IPv4).
export async function readRouter(directory,{lanCidrs=[]}={}){
 let raw;try{raw=JSON.parse(await readFile(path.join(directory,'router-observations.json'),'utf8'));}catch{return {status:'not-configured',observedAt:null,freshness:'unknown',devices:[]};}
 const age=Date.now()-Date.parse(raw.observedAt),freshness=!Number.isFinite(age)||age< -60000?'unknown':age>180000?'stale':'fresh';
 const devices=Array.isArray(raw.devices)?raw.devices.slice(0,500).filter(d=>macPattern.test(d.mac)&&inCidrs(d.ip,lanCidrs)).map(d=>({mac:d.mac.toLowerCase(),id:d.mac.toLowerCase().replaceAll(':',''),ip:d.ip,name:safe(d.name),connection:['Wi-Fi · 2.4 GHz','Wi-Fi · 5 GHz','Wi-Fi · 6 GHz','Wi-Fi','Ethernet'].includes(d.connection)?d.connection:'Unknown',presence:['associated','reachable','lease-only'].includes(d.presence)?d.presence:'cache-only'})):[];
 return {status:raw.status==='ok'?'ok':'unavailable',freshness,observedAt:raw.observedAt||null,attemptedAt:raw.attemptedAt||null,model:safe(raw.model),firmware:safe(raw.firmware),routerMac:macPattern.test(raw.routerMac)?raw.routerMac.toLowerCase():null,devices};
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
