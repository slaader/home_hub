// Administration → Integrations → Machines: every machine once, and per machine what each module knows about it
// (telemetry, backups, versions, SSH keys, inventory, LLM runtimes, Git LFS, whatever a plugin adds). One machine
// list (the overview's: site.json plus the machines added on the overview or over MCP), so a machine set up in one
// place shows in all of them, with what is set up and what is not.
//
// Extension point "machines.facets" (docs/plugins.md): a module provides
//   (state, hub) => (machines) => report | [report] | Promise of either
// machines = the overview's machines (GET /api/home → machines). A report is one facet:
//   {id, title, icon?, order?, page?, howTo?, off?, only?, how?, prompt?, machines: {[machineId]: entry}, fallback?: entry}
//   entry = {state, summary?, summaryT?, details?: [{label, value, valueT?}], href?}
// state is one of FACET_STATES. A machine the report does not name gets `fallback` (default: not-configured with
// the report's howTo); with only: true it gets nothing (the facet belongs to the machines it names, e.g. a NAS relay).
// off: true marks the whole facet as turned off by an administrator (each machine shows "off").
// how = {by, text}: who does the work (HOW_BY: hub, source, collector, agent, integration) and in one sentence how.
// prompt = a Czech source template for the person's own coding agent, with {id}, {name} and {hostname} of the machine
// filled in here; the page offers it, ready to copy, where the part is not set up or needs attention.
// Read-only: nothing here writes, and a provider that throws or answers garbage is left out, never fatal.
import {textOf,fill} from './text.mjs';
import {runStatus} from './integrations.mjs';

export const FACETS_POINT='machines.facets';
export const FACET_STATES=Object.freeze(['ok','warn','stale','error','off','not-configured','not-applicable']);
const ID=/^[a-z][a-z0-9-]{0,39}$/;
const ATTENTION=['warn','stale','error'];
export const HOW_BY=Object.freeze(['hub','source','collector','agent','integration']);
// Where a ready prompt for an agent helps: the part is missing or not working. Not "warn": that part works and
// reports a finding (updates waiting), which is the job of its own page.
const PROMPT_STATES=['not-configured','stale','error'];
const str=(v,n=300)=>typeof v==='string'?v.replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,n):'';
const href=v=>typeof v==='string'&&/^#[A-Za-z0-9][A-Za-z0-9._/:-]{0,120}$/.test(v)?v:null;
const parts=v=>Array.isArray(v)?v.slice(0,6).filter(p=>p&&typeof p.key==='string').map(p=>({key:str(p.key,300),params:p.params&&typeof p.params==='object'?p.params:{}})):null;

// summary may be a plain string or a tx() result ({text, parts}); both land as summary + summaryT.
function entryOf(raw,report){
 if(!raw||typeof raw!=='object')return null;
 const state=FACET_STATES.includes(raw.state)?raw.state:'error';
 const summary=str(textOf(raw.summary)),summaryT=parts(raw.summaryT)||parts(raw.summary?.parts);
 const details=(Array.isArray(raw.details)?raw.details:[]).slice(0,12).filter(d=>d&&typeof d==='object').map(d=>{
  const value=str(textOf(d.value),300),valueT=parts(d.valueT)||parts(d.value?.parts);
  return {label:str(d.label,80),value,...(valueT?.length?{valueT}:{}),...(href(d.href)?{href:d.href}:{})};}).filter(d=>d.label);
 return {state,...(summary?{summary}:{}),...(summaryT?.length?{summaryT}:{}),...(details.length?{details}:{}),href:href(raw.href)||(report.page?`#${report.page}`:null)};
}

// One provider's answer → valid reports. Anything malformed is dropped.
export function normalizeReports(value){
 const list=(Array.isArray(value)?value:[value]).filter(r=>r&&typeof r==='object'&&typeof r.id==='string'&&ID.test(r.id)&&typeof r.title==='string'&&r.machines&&typeof r.machines==='object');
 return list.map(r=>({id:r.id,title:str(r.title,80),icon:typeof r.icon==='string'&&/^[a-z][a-z0-9-]{0,23}$/.test(r.icon)?r.icon:'puzzle',
  order:Number.isFinite(r.order)?r.order:100,page:typeof r.page==='string'&&ID.test(r.page)?r.page:null,howTo:str(r.howTo,400)||null,off:r.off===true,
  machines:r.machines,fallback:r.fallback&&typeof r.fallback==='object'?r.fallback:null,only:r.only===true,
  how:r.how&&HOW_BY.includes(r.how.by)?{by:r.how.by,text:str(textOf(r.how.text),400),...(parts(r.how.text?.parts)?.length?{textT:parts(r.how.text.parts)}:{})}:null,
  prompt:typeof r.prompt==='string'&&r.prompt.trim()?str(r.prompt,1200):null,
  // More parameters of the prompt; a list holds source-language text the browser translates (server/text.mjs).
  promptParams:r.promptParams&&typeof r.promptParams==='object'?Object.fromEntries(Object.entries(r.promptParams).slice(0,6).map(([k,v])=>[k,Array.isArray(v)?v.slice(0,3).map(x=>str(String(x),400)):str(String(v),400)])):{}}));
}

// The overall state of a machine: what needs attention first, then whether anything is set up at all.
export function machineState(facets){
 const has=s=>facets.some(f=>f.state===s);
 if(has('error'))return 'error';if(has('warn')||has('stale'))return 'warn';
 return facets.some(f=>f.state==='ok')?'ok':'not-configured';
}
export function countFacets(facets){
 return {ok:facets.filter(f=>f.state==='ok').length,attention:facets.filter(f=>ATTENTION.includes(f.state)).length,
  notConfigured:facets.filter(f=>f.state==='not-configured').length,off:facets.filter(f=>f.state==='off').length};
}

// machines: the overview's machines; reports: normalized reports of every provider.
export function buildMachines(machines,reports){
 const seen=new Set(),facetList=[];
 for(const r of [...reports].sort((a,b)=>a.order-b.order||a.id.localeCompare(b.id))){if(seen.has(r.id))continue;seen.add(r.id);facetList.push(r);}
 const list=(Array.isArray(machines)?machines:[]).filter(m=>m&&typeof m.id==='string').map(m=>{
  const params={id:m.id,name:str(m.name,80)||m.id,hostname:str(m.hostname,253)||str(m.ip,45)||m.id};
  const facets=facetList.filter(r=>!r.only||Object.hasOwn(r.machines,m.id)).map(r=>{
   const own=Object.hasOwn(r.machines,m.id)?r.machines[m.id]:null;
   const entry=r.off?{state:'off',href:r.page?`#${r.page}`:null}
    :entryOf(own,r)||entryOf(r.fallback||{state:'not-configured',summary:r.howTo||''},r);
   const all={...r.promptParams,...params};
   const prompt=r.prompt&&!r.off&&PROMPT_STATES.includes(entry.state)?{prompt:fill(r.prompt,all),promptT:[{key:r.prompt,params:all}]}:{};
   return {id:r.id,title:r.title,icon:r.icon,...(r.how?{how:r.how}:{}),...entry,...prompt};
  });
  return {id:m.id,name:str(m.name,80)||m.id,hostname:str(m.hostname,253),ip:str(m.ip,45),kind:m.kind||null,role:m.role||null,platform:m.platform||null,
   source:m.source==='site'?'site':'added',online:m.online||'unknown',lastSeen:m.lastSeen||null,
   state:machineState(facets),counts:countFacets(facets),facets};
 });
 return {facets:facetList.map(r=>({id:r.id,title:r.title,icon:r.icon,page:r.page,howTo:r.howTo,off:r.off})),machines:list};
}

// An integration that names its machines (integration.machines, server/integrations.mjs) → one facet shown only on
// those machines, in the state of its status item for the machine (or of the whole integration). This is how a
// plugin's bridges, relays and services appear on the machine pages without a provider of their own.
const FROM_INTEGRATION={ok:'ok',stale:'stale',error:'error',off:'off','not-configured':'not-configured',disabled:'off'};
const KIND_ICON={telemetry:'pulse','llm-runtimes':'cpu',router:'globe',collector:'list',upstream:'versions',storage:'archive',bridge:'plug',other:'puzzle'};
export const INTEGRATION_PROMPT='V Home Hubu zprovozni integraci „{title}“ pro stroj „{name}“ ({hostname}, id {id}). Postup podle hubu: {howTo} Nejdřív mi řekni, co přesně uděláš a jaký přístup k tomu potřebuješ; nic dalšího neměň.';
export function integrationReport(integration,status,targets){
 const machines={};
 for(const t of Array.isArray(targets)?targets:[]){
  const id=typeof t==='string'?t:t?.machine;if(typeof id!=='string'||!id)continue;
  const item=t?.item!==undefined?status?.items?.find(i=>i.id===t.item):null,from=item||status||{};
  machines[id]={state:FROM_INTEGRATION[status?.state==='disabled'?'disabled':from.state]||'error',summary:from.summary||'',...(from.summaryT?{summaryT:from.summaryT}:{}),
   ...(from.lastError?{details:[{label:'Poslední chyba',value:String(from.lastError)}]}:{}),href:'#integrations'};
 }
 const slug=`int-${integration.id.toLowerCase().replace(/[^a-z0-9]+/g,'-')}`.slice(0,40).replace(/-+$/,'');
 return {id:slug,title:integration.title,icon:KIND_ICON[integration.kind]||'plug',order:80,page:'integrations',only:true,machines,
  how:{by:'integration',text:integration.description||''},
  ...(integration.howTo?{prompt:INTEGRATION_PROMPT,promptParams:{title:[integration.title],howTo:[integration.howTo]}}:{})};
}
async function integrationReports(hub,machines){
 const list=hub.registry?.integrations?.filter(i=>i.machines)||[];
 return (await Promise.all(list.map(async i=>{
  try{
   const state=hub.state(i.module),enabled=hub.integrationEnabled(i.id);
   const [targets,status]=await Promise.all([Promise.resolve(i.machines(state,hub)),runStatus(i,state,hub,{enabled})]);
   return normalizeReports(integrationReport(i,status,targets));
  }catch{return [];}}))).flat();
}

// What the page reads: the overview's machines joined with every provider's facets and the integrations that name machines.
export async function machinesOverview(hub){
 const home=hub.state('home');
 const payload=home?.payload?await home.payload():{machines:[],telemetry:null};
 const answers=await Promise.all(hub.collect(FACETS_POINT).map(async p=>{
  try{const v=typeof p==='function'?await p(payload.machines):await p;return normalizeReports(v);}
  catch{return [];}}));
 const fromIntegrations=await integrationReports(hub,payload.machines);
 return {schemaVersion:1,generatedAt:new Date().toISOString(),telemetry:payload.telemetry??null,...buildMachines(payload.machines,[...answers.flat(),...fromIntegrations])};
}

// Ids written by different hands for one machine: the inventory's "mini-server" is the site's "mini_server".
export const sameId=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase().replace(/[_.\s]/g,'-')===b.toLowerCase().replace(/[_.\s]/g,'-');

// A host as written in a job or a URL → the machine it names (id, hostname, its first label, or the IP).
export function machineForHost(machines,host){
 const h=String(host||'').trim().toLowerCase().replace(/\.$/,'');if(!h)return null;
 return machines.find(m=>[m.id,m.hostname,m.ip].some(v=>typeof v==='string'&&v.toLowerCase()===h))
  ||machines.find(m=>typeof m.hostname==='string'&&m.hostname.includes('.')&&m.hostname.toLowerCase().split('.')[0]===h.split('.')[0]&&!/^\d+$/.test(h.split('.')[0]))
  ||null;
}
