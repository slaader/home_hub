// Provenance: where the data behind an answer comes from. Every data endpoint of a page carries one small
// summary in the same shape, so the page header can say "Agent", "Collector · 2 days ago" or "Mixed" and
// list the breakdown (public/ui.js → pageHeader({provenance})). A plugin builds its own with provenance().
//
//   provenance = {kind, kinds: [source, …], lastAt, summary}
//     kind     the one kind every source has, "mixed" when they differ, "none" when there is no data yet
//     lastAt   the newest lastAt of the sources (ISO time or a YYYY-MM-DD day), or null
//     summary  one English sentence for a script or an agent; a page builds its own text from the fields
//   source = {kind, id?, source?, count?, unit?, changes?, accounts?, people?, lastAt?, state?,
//             intervalSeconds?, schedule?, detail?}
//     kind      manual     edited by a person in the web UI or the native app
//               agent      written with a service-account key, over MCP or the API (accounts names them)
//               config     read from a configuration file (source names it)
//               collector  written by an automated job (source = its script; schedule says who ran it)
//               telemetry  reported live by an agent on a machine (source names it)
//               plugin     supplied by a plugin (source = the plugin or adapter id)
//               other      a stamp or a name nobody on this hub carries: an import, an edit of the file,
//                          an account that was removed (detail lists them)
//     id        a stable name for the source inside one answer, when a page shows only part of it
//     host      the machine the source ran on, when the data says so
//     count     how many records come from this source; unit says what is counted
//     changes   later changes by this kind of source to records it did not necessarily create
//     schedule  {trigger: "scheduled" | "manual", scheduler?: "launchd" | "systemd", label?} when the
//               collector recorded how it was started (server/collector-run.mjs); absent when it did not
// Nothing here is decided per page: every field is derived from what the records themselves carry
// (verified_by stamps, createdBy / history, collectedAt and the collector state, the adapter in use).
import {USER_STAMP} from '../scripts/knowledge-edit.mjs';

export const PROVENANCE_KINDS=Object.freeze(['manual','agent','config','collector','telemetry','plugin','other']);
export const PROVENANCE_UNITS=Object.freeze(['entries','items','records','projects','rounds','machines','sources','clients']);
const LIMITS={sources:12,names:8,text:160};
const text=(v,max=LIMITS.text)=>typeof v==='string'?v.replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,max):'';
const count=v=>Number.isSafeInteger(v)&&v>=0?v:null;
const names=v=>Array.isArray(v)?[...new Set(v.map(n=>text(n,80)).filter(Boolean))]:[];
const stamp=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))?v:null;
const newest=list=>list.filter(Boolean).reduce((a,b)=>a&&Date.parse(a)>=Date.parse(b)?a:b,null);

function cleanSchedule(s){
 if(!s||typeof s!=='object'||!['scheduled','manual'].includes(s.trigger))return null;
 const scheduler=['launchd','systemd'].includes(s.scheduler)?s.scheduler:null,label=text(s.label,120);
 return {trigger:s.trigger,...(scheduler?{scheduler}:{}),...(label?{label}:{})};
}
// One source, bounded: unknown kinds and empty fields are dropped rather than passed on.
function cleanSource(s){
 if(!s||typeof s!=='object'||!PROVENANCE_KINDS.includes(s.kind))return null;
 const out={kind:s.kind};
 for(const k of ['id','source','host','detail','state']){const v=text(s[k],k==='detail'?LIMITS.text:120);if(v)out[k]=v;}
 for(const k of ['count','changes','intervalSeconds']){const v=count(s[k]);if(v!==null)out[k]=v;}
 if(PROVENANCE_UNITS.includes(s.unit)&&out.count!==undefined)out.unit=s.unit;
 for(const k of ['accounts','people']){const list=names(s[k]);if(list.length){out[k]=list.slice(0,LIMITS.names);if(list.length>LIMITS.names)out[`${k}More`]=list.length-LIMITS.names;}}
 const at=stamp(s.lastAt);if(at)out.lastAt=at;
 const schedule=cleanSchedule(s.schedule);if(schedule)out.schedule=schedule;
 return out;
}
const ONE={entries:'entry',items:'item',records:'record',projects:'project',rounds:'round',machines:'machine',sources:'source',clients:'client'};
const counted=(n,unit='records')=>`${n} ${n===1?ONE[unit]||unit:unit}`;
const WORDS={manual:'edited by hand',agent:'written by agents',config:'read from configuration',collector:'collected by a job',telemetry:'live telemetry',plugin:'supplied by a plugin',other:'of another origin'};
function phrase(s){
 const who=[...(s.accounts||[]),...(s.people||[])].join(', ');
 return [`${WORDS[s.kind]}${s.source?` (${s.source})`:''}`,s.count!==undefined?counted(s.count,s.unit):'',s.changes?`${s.changes} ${s.changes===1?'change':'changes'}`:'',who,
  s.schedule?(s.schedule.trigger==='manual'?'run by hand':`scheduled${s.schedule.scheduler?` by ${s.schedule.scheduler}`:''}`):'',s.state&&s.state!=='ok'?s.state:'',s.lastAt?`last ${s.lastAt}`:''].filter(Boolean).join(', ');
}
/** sources: [{kind, …}] in the order they should be read → the provenance document. */
export function provenance(sources=[]){
 const kinds=(Array.isArray(sources)?sources:[]).map(cleanSource).filter(Boolean).slice(0,LIMITS.sources);
 const distinct=[...new Set(kinds.map(k=>k.kind))];
 return {kind:!kinds.length?'none':distinct.length===1?distinct[0]:'mixed',kinds,lastAt:newest(kinds.map(k=>k.lastAt)),
  summary:kinds.length?`${kinds.map(phrase).join('; ')}.`.replace(/^./,c=>c.toUpperCase()):'No data yet.'};
}

// --- who wrote it: people, service accounts, anything else ---------------------------------------
// A record names its author (a user name, a service-account name, a key's name). The access store says
// which of those are people and which are agents today; a name nobody carries any more is "other".
export const DEVICE_AUTHOR='Native device';
export function authorKinds(accessStore){
 const list=fn=>{try{return (fn()||[]).filter(n=>typeof n==='string'&&n);}catch{return [];}};
 const people=new Set(list(()=>accessStore.users().map(u=>u.username)));
 // A key issued before service accounts acts under its own name.
 const agents=new Set(list(()=>[...accessStore.accounts().map(a=>a.name),...accessStore.keys().map(k=>k.name)]));
 return name=>typeof name!=='string'||!name?null:people.has(name)||name===DEVICE_AUTHOR?'manual':agents.has(name)?'agent':'other';
}
// Collects authored records per kind. add(name, at, {change}) counts one record created (or, with
// change, one later change) by that author; sources(unit) gives the provenance sources, busiest first.
export function authorTally(kindOf){
 const by=new Map();
 const row=kind=>{if(!by.has(kind))by.set(kind,{kind,count:0,changes:0,names:new Map(),lastAt:null});return by.get(kind);};
 return {
  add(name,at,{change=false}={}){
   const kind=kindOf(name);if(!kind)return;
   const r=row(kind);if(change)r.changes++;else r.count++;
   r.names.set(name,(r.names.get(name)||0)+1);r.lastAt=newest([r.lastAt,stamp(at)]);
  },
  sources(unit='items'){
   return [...by.values()].sort((a,b)=>b.count-a.count||b.changes-a.changes).map(r=>{
    // A source that only changed records (a person deciding on an agent's variants) has no count of its own.
    const list=[...r.names].sort((a,b)=>b[1]-a[1]).map(([n])=>n);
    return {kind:r.kind,...(r.count?{count:r.count,unit}:{}),...(r.changes?{changes:r.changes}:{}),lastAt:r.lastAt,
     ...(r.kind==='agent'?{accounts:list}:r.kind==='manual'?{people:list}:{detail:list.slice(0,4).join(', ')+(list.length>4?` +${list.length-4}`:'')})};
   });
  }};
}

/**
 * Records that name their authors → the provenance document.
 * facts: {created: [[name, at]], changes: [[name, at]]}; extra: sources that are not authors (a seed from
 * the site configuration); unit: what `count` counts.
 */
export function authoredProvenance(accessStore,facts,{unit='items',extra=[]}={}){
 const tally=authorTally(authorKinds(accessStore));
 for(const [name,at] of facts?.created||[])tally.add(name,at);
 for(const [name,at] of facts?.changes||[])tally.add(name,at,{change:true});
 return provenance([...tally.sources(unit),...extra]);
}

// --- inventory: the verified_by stamp of every entry ---------------------------------------------
// "user edit in Home Hub" = a person in the web UI; "Home Hub API · <account>" = a service-account key
// (plain "Home Hub API" = a key without an account); any other text was kept by an import or written
// into the file by something else, and is listed as it stands.
const API_STAMP=/^Home Hub API(?: · (.+))?$/;
export function inventoryProvenance(entries=[]){
 const rows={manual:{kind:'manual',count:0,lastAt:null},agent:{kind:'agent',count:0,lastAt:null,accounts:new Map()},other:{kind:'other',count:0,lastAt:null,stamps:new Map()}};
 const day=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)?v:null;
 for(const e of Array.isArray(entries)?entries:[]){
  const by=typeof e?.verified_by==='string'?e.verified_by.trim():'',api=API_STAMP.exec(by);
  const r=by===USER_STAMP?rows.manual:api?rows.agent:rows.other;
  r.count++;r.lastAt=newest([r.lastAt,day(e?.verified_at)]);
  if(api?.[1])r.accounts.set(api[1],(r.accounts.get(api[1])||0)+1);
  if(r===rows.other)r.stamps.set(by||'no stamp',(r.stamps.get(by||'no stamp')||0)+1);
 }
 const top=map=>[...map].sort((a,b)=>b[1]-a[1]);
 return provenance(Object.values(rows).filter(r=>r.count).sort((a,b)=>b.count-a.count).map(r=>({kind:r.kind,count:r.count,unit:'entries',lastAt:r.lastAt,
  ...(r.accounts?.size?{accounts:top(r.accounts).map(([n])=>n)}:{}),
  ...(r.stamps?.size?{detail:top(r.stamps).slice(0,3).map(([s,n])=>`${s} (${n})`).join(', ')+(r.stamps.size>3?` +${r.stamps.size-3}`:'')}:{})})));
}

// --- collectors: the state object of collector-state.mjs plus what the snapshot says about its run --
// state: {state, collectedAt, intervalSeconds, script}; run: the snapshot's own `run` stamp, if it has one.
export function collectorSource(state,{id,run=null,count:n=null,unit=null,host='',detail=''}={}){
 if(!state||typeof state!=='object')return null;
 return {kind:'collector',...(id?{id}:{}),source:state.script,state:state.state,intervalSeconds:state.intervalSeconds,lastAt:state.collectedAt,
  ...(n!==null?{count:n,unit}:{}),...(run?{schedule:run}:{}),...(host?{host}:{}),...(detail?{detail}:{})};
}
