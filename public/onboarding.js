// Getting started: what a new hub still needs, read from the hub's real state. No storage of its own on
// the server: each step asks an API that already exists, and "dismissed" is one localStorage flag per
// account in this browser.
//   signin      you are here
//   agent       a service account with a key (GET /api/admin/accounts, administrators only)
//   machines    at least one machine on the overview (GET /api/home)
//   telemetry   optional: a machine reports live numbers (GET /api/home)
//   inventory   at least one inventory entry (GET /api/inventory/schema → inventory.entries)
//   collectors  optional: a collector has delivered something (GET /api/collectors, the router census)
// Every read is one that answers 200 on a brand-new hub (a count, a state), never the data route itself:
// GET /api/inventory, /api/systems and /api/security are 404 until something exists, and the browser would
// log each of those in the console of a hub that is merely new.
// done is true, false, or null when this account may not look (a viewer cannot list service accounts).
// The checklist is offered on its own to a hub that looks new. A household that runs the private edition
// with machines configured never sees it unless someone opens it from the account menu.
import {sessionCache,authGuard,currentPrincipal} from './session-cache.js';

const KEY=me=>`hh-welcome:${me?.username||''}`;
export function isDismissed(me){try{return globalThis.localStorage?.getItem(KEY(me))==='dismissed';}catch{return false;}}
export function setDismissed(me,value){
 try{if(value)globalThis.localStorage?.setItem(KEY(me),'dismissed');else globalThis.localStorage?.removeItem(KEY(me));}catch{}
 globalThis.dispatchEvent?.(new Event('onboardingchange'));
}
export const STEP_IDS=Object.freeze(['signin','agent','machines','telemetry','inventory','collectors']);
const OPTIONAL=['telemetry','collectors'];

// What the APIs said → the six steps. Pure, so the rules can be tested without a hub.
//   home: /api/home body or null; accounts: /api/admin/accounts body, null (failed) or undefined (not allowed);
//   inventory: /api/inventory/schema body ({inventory:{entries}}; an /api/inventory body works too) or null;
//   systems, security: true (has data), false (none), undefined (not allowed)
export function onboardingSteps({home=null,accounts,inventory=null,systems,security}={}){
 const machines=Array.isArray(home?.machines)?home.machines:[];
 const live=machines.filter(m=>m.kind==='thermo'&&(m.thermo==='up'||m.quad));
 const list=Array.isArray(accounts?.accounts)?accounts.accounts.filter(a=>a.disabled!==true):null;
 const withKey=list?list.filter(a=>(a.keys||[]).some(k=>!k.revokedAt)):[];
 const used=list?list.some(a=>a.lastUsedAt):false;
 const entries=Number.isInteger(inventory?.inventory?.entries)?inventory.inventory.entries:Array.isArray(inventory?.doc?.entries)?inventory.doc.entries.length:0;
 const router=home?.router?.status==='ok';
 const collectors={systems,security,router:home?router:undefined};
 const known=Object.values(collectors).filter(v=>v!==undefined);
 const steps=[
  {id:'signin',done:true},
  {id:'agent',done:list?withKey.length>0:null,detail:{accounts:list?.length??null,withKey:withKey.length,used}},
  {id:'machines',done:home?machines.length>0:null,detail:{count:machines.length}},
  {id:'telemetry',done:home?live.length>0:null,detail:{count:live.length}},
  {id:'inventory',done:inventory?entries>0:false,detail:{count:entries}},
  {id:'collectors',done:known.length?known.some(Boolean):null,detail:collectors},
 ].map(s=>({...s,optional:OPTIONAL.includes(s.id)}));
 const required=steps.filter(s=>!s.optional);
 return {steps,machines:machines.length,done:steps.filter(s=>s.done===true).length,total:steps.length,
  requiredDone:required.filter(s=>s.done===true).length,requiredTotal:required.length,
  // A step this account cannot check does not hold the checklist open.
  complete:required.every(s=>s.done!==false)};
}
// Offered without being asked for? Not when dismissed, complete, or a configured private household.
export const offersOnboarding=(status,{edition,dismissed}={})=>Boolean(status)&&!dismissed&&!status.complete&&!(edition==='private'&&status.machines>0);

const cache=sessionCache(20000);
const getJson=async(url,lost)=>{try{const r=await fetch(url);if(r.status===401){lost(r);return null;}return r.ok?await r.json():null;}catch{return null;}};
// Has this collector delivered a snapshot? (state ok or stale; waiting and not-configured have no collectedAt)
const delivered=collector=>Boolean(collector?.collectedAt);
// me: the /api/me document. quick:true asks only /api/home, which is enough to decide whether to offer
// the checklist to a hub that already has machines.
const pending=new Map();// one read at a time per account and depth: the shell and the page often ask together
export function loadOnboarding(me,{force=false,quick=false}={}){
 const key=quick?'quick':'full',hit=force?undefined:cache.get(key)??(quick?cache.get('full'):undefined);
 if(hit)return Promise.resolve(hit);
 const slot=`${currentPrincipal()}|${key}`;
 if(!force&&pending.has(slot))return pending.get(slot);
 const run=read(me,key).finally(()=>{if(pending.get(slot)===run)pending.delete(slot);});
 pending.set(slot,run);return run;
}
async function read(me,key){
 const keep=cache.begin(),lost=authGuard(),admin=me?.canAdmin===true,security=me?.role==='admin'||me?.scopes?.includes('security:read')===true;
 const home=await getJson('/api/home',lost);
 if(key==='quick')return keep('quick',onboardingSteps({home}));
 const [accounts,inventory,state]=await Promise.all([
  admin?getJson('/api/admin/accounts',lost):undefined,getJson('/api/inventory/schema',lost),security?getJson('/api/collectors',lost):undefined]);
 const collectors=state?.collectors;
 return keep('full',onboardingSteps({home,accounts,inventory,systems:security?delivered(collectors?.systems):undefined,security:security?delivered(collectors?.security):undefined}));
}
