// Integrations: the outside things a module reads (a telemetry agent, a router, a collector's snapshot, a
// bridge to another machine), their health, where each is configured, and whether an administrator has
// turned one off. docs/plugins.md → Integrations describes the contract; this file holds its rules:
//   defineIntegrations()      validates a module's `integrations` list (server/plugins.mjs calls it)
//   normalizeStatus()         bounds what a status() returns, so a module cannot send anything else
//   createIntegrationStore()  data/state/integrations.json: which ones are disabled, by whom, since when
//   createSecretStore()       private/integrations.json (0600): write-only setting values, never sent back
//   runStatus()               one status() call with a deadline; a failure becomes state "error"
// A missing state file means everything is enabled, which is how the hub behaved before this existed.
import {readFileSync,existsSync} from 'node:fs';
import {mkdir,writeFile,rename} from 'node:fs/promises';
import path from 'node:path';
import {secretIn} from './home-devices.mjs';

export const INTEGRATION_KINDS=Object.freeze(['telemetry','llm-runtimes','router','collector','upstream','storage','bridge','other']);
export const INTEGRATION_STATES=Object.freeze(['ok','stale','error','off','not-configured','disabled']);
export const CONFIG_SOURCES=Object.freeze(['site.json','env','ui','file','plugin']);
export const SETTING_TYPES=Object.freeze(['text','number','boolean','select']);
// <module id>.<name>: the module part is the id of the module that declares it.
export const INTEGRATION_ID=/^([a-z][a-z0-9-]{1,31})\.([a-z][a-z0-9-]{0,39})$/;
const SETTING_KEY=/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;
const LIMITS={summary:240,error:160,name:120,configuredBy:12,items:60,label:80,settings:20,text:500};

const plain=v=>v&&typeof v==='object'&&!Array.isArray(v);
const fn=v=>typeof v==='function';
const clean=(v,max)=>typeof v==='string'?v.replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,max):'';
const iso=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))?new Date(Date.parse(v)).toISOString():null;

// --- the declaration -------------------------------------------------------------------------------
function settingsOf(raw,where,bad){
 if(raw===undefined)return null;
 if(!plain(raw)||!fn(raw.read)||!fn(raw.write)||!Array.isArray(raw.schema)||!raw.schema.length||raw.schema.length>LIMITS.settings)bad(`${where}.settings needs {schema: [field, …] (1–${LIMITS.settings}), read(state, hub), write(state, hub, values)}`);
 const keys=new Set();
 const schema=raw.schema.map((f,i)=>{
  const at=`${where}.settings.schema[${i}]`;
  if(!plain(f)||typeof f.key!=='string'||!SETTING_KEY.test(f.key))bad(`${at}.key must match ${SETTING_KEY}`);
  if(keys.has(f.key))bad(`${at}: key "${f.key}" is listed twice`);keys.add(f.key);
  const extra=Object.keys(f).filter(k=>!['key','label','labelKey','type','secret','options','min','max','step','help','placeholder'].includes(k));if(extra.length)bad(`${at} has unknown field(s): ${extra.join(', ')}`);
  if(typeof f.label!=='string'&&typeof f.labelKey!=='string')bad(`${at} needs label or labelKey`);
  const type=f.type??'text';if(!SETTING_TYPES.includes(type))bad(`${at}.type must be one of ${SETTING_TYPES.join(', ')}`);
  if(f.secret===true&&type!=='text')bad(`${at}: only a text field can be secret`);
  let options=null;
  if(type==='select'){
   if(!Array.isArray(f.options)||!f.options.length||f.options.length>20)bad(`${at}: a select needs 1–20 options`);
   options=f.options.map(o=>{const opt=plain(o)?o:{value:o};if(!['string','number'].includes(typeof opt.value))bad(`${at}: an option value is a string or a number`);return Object.freeze({value:opt.value,label:typeof opt.label==='string'?opt.label:String(opt.value)});});
  }
  for(const k of ['min','max','step'])if(f[k]!==undefined&&(type!=='number'||!Number.isFinite(f[k])))bad(`${at}.${k} is a number, for a number field`);
  return Object.freeze({key:f.key,label:f.label??null,labelKey:f.labelKey??null,type,secret:f.secret===true,...(options?{options:Object.freeze(options)}:{}),
   ...(f.min!==undefined?{min:f.min}:{}),...(f.max!==undefined?{max:f.max}:{}),...(f.step!==undefined?{step:f.step}:{}),
   help:typeof f.help==='string'?f.help:null,placeholder:typeof f.placeholder==='string'?f.placeholder:null});
 });
 return Object.freeze({schema:Object.freeze(schema),read:raw.read,write:raw.write});
}
const KNOWN=['id','title','titleKey','kind','description','toggle','toggleNote','status','test','settings','provides','howTo','page','docs','machines'];
/** A module's raw `integrations` → a frozen, validated list. bad(message) throws the module error. */
export function defineIntegrations(raw,moduleId,bad){
 if(raw===undefined)return Object.freeze([]);
 if(!Array.isArray(raw)||raw.length>20)bad('integrations must be a list of at most 20');
 const ids=new Set();
 return Object.freeze(raw.map((x,i)=>{
  const where=`integrations[${i}]`;
  if(!plain(x))bad(`${where} must be an object`);
  const extra=Object.keys(x).filter(k=>!KNOWN.includes(k));if(extra.length)bad(`${where} has unknown field(s): ${extra.join(', ')}`);
  const m=typeof x.id==='string'?INTEGRATION_ID.exec(x.id):null;
  if(!m)bad(`${where}.id must be "<module>.<name>" (${INTEGRATION_ID})`);
  if(m[1]!==moduleId)bad(`${where}.id "${x.id}" must start with this module's id ("${moduleId}.")`);
  if(ids.has(x.id))bad(`${where}: integration "${x.id}" is listed twice`);ids.add(x.id);
  if(typeof x.title!=='string'||!x.title.trim())bad(`${where} (${x.id}) needs a title`);
  if(x.titleKey!==undefined&&typeof x.titleKey!=='string')bad(`${where}.titleKey must be a string`);
  if(!INTEGRATION_KINDS.includes(x.kind))bad(`${where}.kind must be one of ${INTEGRATION_KINDS.join(', ')}`);
  for(const k of ['description','toggleNote','howTo','docs'])if(x[k]!==undefined&&typeof x[k]!=='string')bad(`${where}.${k} must be a string`);
  if(x.page!==undefined&&(typeof x.page!=='string'||!/^[a-z][a-z0-9-]{0,39}(\/[A-Za-z0-9._~-]{1,60})?$/.test(x.page)))bad(`${where}.page must be a page hash such as "versions" or "host-router"`);
  if(x.toggle!==undefined&&typeof x.toggle!=='boolean')bad(`${where}.toggle must be true or false`);
  if(!fn(x.status))bad(`${where} (${x.id}) needs status(state, hub) => Status`);
  if(x.test!==undefined&&!fn(x.test))bad(`${where}.test must be a function`);
  if(x.provides!==undefined&&(!Array.isArray(x.provides)||x.provides.some(p=>typeof p!=='string'||!p)))bad(`${where}.provides must list extension-point names`);
  // machines(state, hub) → [machineId | {machine, item?}]: the machines this integration belongs to. Each then shows it on its
  // page under Integrations → Machines, with the state of its status item `item` (or of the whole integration).
  if(x.machines!==undefined&&!fn(x.machines))bad(`${where}.machines must be a function (state, hub) => [machine id | {machine, item}]`);
  return Object.freeze({id:x.id,module:moduleId,title:x.title,titleKey:x.titleKey??null,kind:x.kind,description:x.description??null,
   toggle:x.toggle!==false,toggleNote:x.toggleNote??null,status:x.status,test:x.test??null,settings:settingsOf(x.settings,where,bad),
   provides:Object.freeze([...(x.provides||[])]),howTo:x.howTo??null,page:x.page??null,docs:x.docs??null,machines:x.machines??null});
 }));
}

// --- what a status() may say -----------------------------------------------------------------------
// summary: a Czech source sentence, or {text, parts} from server/text.mjs → tx(), so the browser can
// translate a sentence with numbers in it (summaryT, as elsewhere in the API).
function sentence(v,max){
 if(typeof v==='string')return {text:clean(v,max),parts:null};
 if(plain(v)&&typeof v.text==='string'){
  const parts=Array.isArray(v.parts)?v.parts.slice(0,4).filter(p=>plain(p)&&typeof p.key==='string').map(p=>({key:clean(p.key,max),
   params:Object.fromEntries(Object.entries(plain(p.params)?p.params:{}).slice(0,8).map(([k,x])=>[clean(k,32),Array.isArray(x)?x.slice(0,12).map(y=>clean(String(y),80)):typeof x==='number'?x:clean(String(x??''),120)]))})):null;
  return {text:clean(v.text,max),parts:parts?.length?parts:null};
 }
 return {text:'',parts:null};
}
const stateOf=v=>INTEGRATION_STATES.includes(v)?v:'error';
// An error from a status is a short code or sentence; anything that looks like a secret is dropped.
const errorText=v=>{const s=clean(typeof v==='string'?v:v?.message,LIMITS.error);return s&&!secretIn(s)?s:s?'error':null;};
export function normalizeStatus(raw){
 const r=plain(raw)?raw:{};
 const summary=sentence(r.summary,LIMITS.summary);
 const configuredBy=(Array.isArray(r.configuredBy)?r.configuredBy:[]).filter(c=>plain(c)&&CONFIG_SOURCES.includes(c.source)).slice(0,LIMITS.configuredBy)
  .map(c=>({source:c.source,name:clean(c.name,LIMITS.name)})).filter(c=>c.name&&!secretIn(c.name));
 const items=(Array.isArray(r.items)?r.items:[]).filter(plain).slice(0,LIMITS.items).map((it,i)=>{const s=sentence(it.summary,LIMITS.summary);
  return {id:clean(it.id,60)||String(i),label:clean(it.label,LIMITS.label)||clean(it.id,60)||String(i),state:stateOf(it.state),summary:s.text,...(s.parts?{summaryT:s.parts}:{}),
   lastSuccessAt:iso(it.lastSuccessAt),...(it.lastError?{lastError:errorText(it.lastError)}:{})};});
 return {state:plain(raw)?stateOf(r.state):'error',summary:summary.text,...(summary.parts?{summaryT:summary.parts}:{}),
  lastSuccessAt:iso(r.lastSuccessAt),lastError:r.lastError?errorText(r.lastError):null,configuredBy,items};
}
// The worst of a few item states, for a status made of parts (several hosts, several bridges).
// No parts, or only parts that are not configured: "not-configured". Everything fine: "ok". Some
// broken and some fine: "stale" (it works, partly). Nothing fine: "error".
export function worstState(states){
 const live=states.filter(s=>s!=='not-configured'&&s!=='off');
 if(!live.length)return states.includes('off')?'off':'not-configured';
 if(live.every(s=>s==='ok'))return 'ok';
 if(live.some(s=>s==='ok'||s==='stale'))return 'stale';
 return 'error';
}

const deadline=(promise,ms)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('timeout')),ms);timer.unref?.();
 Promise.resolve(promise).then(v=>{clearTimeout(timer);resolve(v);},e=>{clearTimeout(timer);reject(e);});});
/**
 * One status (or test) call: fn(state, hub, {enabled}) with a deadline. A disabled integration answers
 * "disabled" whatever its status says; its configuredBy and items are kept, so the card still says where
 * it is configured. Never throws.
 */
export async function runStatus(integration,state,hub,{enabled=true,timeoutMs=5000,call=integration.status}={}){
 let status;
 try{status=normalizeStatus(await deadline(Promise.resolve().then(()=>call(state,hub,{enabled})),timeoutMs));}
 catch(e){status={...normalizeStatus({state:'error',summary:e?.message==='timeout'?'Stav nepřišel včas.':'Stav se nepodařilo zjistit.',lastError:e?.message==='timeout'?'timeout':'status-failed'})};}
 if(!enabled)return {...status,state:'disabled',summary:'Vypnuto administrátorem.',summaryT:undefined};
 return status;
}

// --- enable / disable -------------------------------------------------------------------------------
// data/state/integrations.json = {schemaVersion: 1, disabled: {<id>: {by, at}}}. Ids of integrations
// that are not loaded (a plugin that is gone) stay in the file and simply match nothing.
export const INTEGRATIONS_SCHEMA=1;
function readDisabled(file){
 if(!existsSync(file))return {disabled:{},problem:null};
 try{
  const raw=JSON.parse(readFileSync(file,'utf8'));
  if(raw?.schemaVersion!==INTEGRATIONS_SCHEMA||!plain(raw.disabled))return {disabled:{},problem:'invalid'};
  const disabled={};
  for(const [id,v] of Object.entries(raw.disabled))if(INTEGRATION_ID.test(id))disabled[id]={by:clean(v?.by,80)||null,at:iso(v?.at)};
  return {disabled,problem:null};
 }catch{return {disabled:{},problem:'invalid'};}
}
export function createIntegrationStore(stateDirectory,{file=path.join(stateDirectory,'integrations.json'),now=Date.now}={}){
 let {disabled,problem}=readDisabled(file);
 if(problem)console.error(`Integrations: ${file} is not a valid state file; every integration runs enabled until it is saved again.`);
 const listeners=new Set();let queue=Promise.resolve();
 const save=next=>queue=queue.catch(()=>{}).then(async()=>{
  await mkdir(path.dirname(file),{recursive:true,mode:0o700});
  const tmp=`${file}.${process.pid}.tmp`;await writeFile(tmp,JSON.stringify({schemaVersion:INTEGRATIONS_SCHEMA,disabled:next},null,1)+'\n',{mode:0o600});await rename(tmp,file);
 });
 return {
  file,
  enabled:id=>!Object.hasOwn(disabled,id),
  disabledInfo:id=>Object.hasOwn(disabled,id)?{...disabled[id]}:null,
  disabledIds:()=>Object.keys(disabled),
  /** → {changed, enabled, by, at}. Listeners hear only real changes, after the file is written. */
  async set(id,enabled,by){
   if(!INTEGRATION_ID.test(id))throw new Error('invalid');
   if(enabled===!Object.hasOwn(disabled,id))return {changed:false,enabled,...(disabled[id]||{})};
   const next={...disabled},at=new Date(now()).toISOString();
   if(enabled)delete next[id];else next[id]={by:clean(by,80)||null,at};
   await save(next);disabled=next;
   const event={id,enabled,by:clean(by,80)||null,at};
   for(const fn of listeners){try{await fn(event);}catch(e){console.error(`Integrations: a listener for ${id} failed: ${e.message}`);}}
   return {changed:true,...event};
  },
  onChange(fn){listeners.add(fn);return ()=>listeners.delete(fn);},
 };
}

// --- write-only values ----------------------------------------------------------------------------
// private/integrations.json = {schemaVersion: 1, values: {<id>: {<key>: "value"}}}, 0600. A value is
// read only by the module that declared the field (hub.integrationSecret); the API says {set: true}.
export function createSecretStore(file){
 let cache=null;
 const load=()=>{if(cache)return cache;try{const raw=JSON.parse(readFileSync(file,'utf8'));cache=plain(raw?.values)?raw.values:{};}catch{cache={};}return cache;};
 let queue=Promise.resolve();
 const save=next=>queue=queue.catch(()=>{}).then(async()=>{
  await mkdir(path.dirname(file),{recursive:true,mode:0o700});
  const tmp=`${file}.${process.pid}.tmp`;await writeFile(tmp,JSON.stringify({schemaVersion:1,values:next})+'\n',{mode:0o600});await rename(tmp,file);cache=next;
 });
 return {
  file,
  get:(id,key)=>{const v=load()[id]?.[key];return typeof v==='string'&&v?v:null;},
  has:(id,key)=>typeof load()[id]?.[key]==='string'&&load()[id][key]!=='',
  async set(id,key,value){const all=structuredClone(load());all[id]={...(all[id]||{}),[key]:value};await save(all);},
  async clear(id,key){const all=structuredClone(load());if(!all[id]||!Object.hasOwn(all[id],key))return false;delete all[id][key];if(!Object.keys(all[id]).length)delete all[id];await save(all);return true;},
 };
}

// --- settings values from a request ---------------------------------------------------------------
/**
 * input = {values?: {key: value}, clear?: [key]} → {plain: {key: value}, secrets: {key: value}, clear: [key]}.
 * Unknown keys, wrong types and secret-looking text in a plain field are refused (Error 'invalid' with
 * detail). A secret field with an empty value is left as it is: clearing is its own action.
 */
export function settingsInput(schema,input){
 const fail=detail=>{throw Object.assign(new Error('invalid'),{detail});};
 const values=input?.values===undefined?{}:input.values,clear=input?.clear===undefined?[]:input.clear;
 if(!plain(values))fail('values must be an object');
 if(!Array.isArray(clear)||clear.some(k=>typeof k!=='string'))fail('clear must list keys');
 const byKey=new Map(schema.map(f=>[f.key,f]));
 const out={plain:{},secrets:{},clear:[]};
 for(const [key,value] of Object.entries(values)){
  const f=byKey.get(key);if(!f)fail(`unknown setting "${key}"`);
  if(f.secret){if(value===null||value==='')continue;if(typeof value!=='string'||value.length>LIMITS.text||/[\u0000-\u001f]/.test(value))fail(`${key} must be text of at most ${LIMITS.text} characters`);out.secrets[key]=value;continue;}
  if(f.type==='boolean'){if(typeof value!=='boolean')fail(`${key} must be true or false`);out.plain[key]=value;continue;}
  if(f.type==='number'){const n=typeof value==='string'&&value.trim()?Number(value):value;if(!Number.isFinite(n)||(f.min!==undefined&&n<f.min)||(f.max!==undefined&&n>f.max))fail(`${key} must be a number${f.min!==undefined?` from ${f.min}`:''}${f.max!==undefined?` to ${f.max}`:''}`);out.plain[key]=n;continue;}
  if(f.type==='select'){const hit=f.options.find(o=>o.value===value||String(o.value)===String(value));if(!hit)fail(`${key} must be one of ${f.options.map(o=>o.value).join(', ')}`);out.plain[key]=hit.value;continue;}
  if(typeof value!=='string'||value.length>LIMITS.text||/[\u0000-\u001f]/.test(value))fail(`${key} must be text of at most ${LIMITS.text} characters`);
  if(secretIn(value))fail(`${key} looks like a secret; this field is stored in plain text`);
  out.plain[key]=value;
 }
 for(const key of clear){const f=byKey.get(key);if(!f?.secret)fail(`only a write-only field can be cleared ("${key}")`);if(Object.hasOwn(out.secrets,key))fail(`${key} is both set and cleared`);out.clear.push(key);}
 return out;
}
// What the API says about the settings: the schema, the plain values, and {set} for each write-only field.
export async function settingsView(integration,state,hub,secrets){
 const s=integration.settings;if(!s)return null;
 let values={};try{const raw=await deadline(Promise.resolve().then(()=>s.read(state,hub)),3000);values=plain(raw)?raw:{};}catch{values={};}
 const out={};
 for(const f of s.schema){
  if(f.secret){out[f.key]={set:secrets.has(integration.id,f.key)};continue;}
  const v=values[f.key];out[f.key]=['string','number','boolean'].includes(typeof v)?(typeof v==='string'?v.slice(0,LIMITS.text):v):null;
 }
 return {schema:s.schema,values:out};
}
