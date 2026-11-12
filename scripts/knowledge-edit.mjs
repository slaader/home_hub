// The one writer of data/knowledge.json (the source of truth for the inventory): field edits from the
// entry form, whole entries from agents, deletes and bulk upserts. Every change is applied to the
// document in memory, checked with the same validate() agents run, and only then written (atomically);
// after that the publish step runs, if one is configured (see createKnowledgeEditor). The hub calls it
// for its own file; a bridge on another machine can run the same editor next to the file it owns.
//
// Concurrency is optimistic and per entry: entryHash(entry) is the version stamp. A change to an
// existing entry carries the hash its author read (base); a different hash on disk means "conflict".
// The hash is sha256 over JSON.stringify(entry) exactly as stored, so an entry nobody touched keeps
// its hash across any number of writes to its neighbours.
import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {check} from './check-knowledge.mjs';
import {resolvePaths} from '../server/paths.mjs';
import {EDITABLE,ENTRY_FIELDS,SECRET_FIELDS,ENTRY_ID,LIMITS,withFields,dependents} from '../public/inventory-rules.js';
export {EDITABLE,LIMITS};
const run=promisify(execFile);
const HASH=/^[a-f0-9]{64}$/,DATE=/^\d{4}-\d{2}-\d{2}$/;
const plain=v=>v&&typeof v==='object'&&!Array.isArray(v);
const only=(v,keys)=>plain(v)&&Object.keys(v).every(k=>keys.includes(k));
const invalid=()=>{throw new Error('invalid');};
const todayUtc=()=>new Date().toISOString().slice(0,10);
export const entryHash=e=>createHash('sha256').update(JSON.stringify(e)).digest('hex');
// The same content whatever the key order: lets a bulk upsert see that an entry it was sent is the one on disk.
const canonical=v=>Array.isArray(v)?v.map(canonical):plain(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
export const emptyDoc=(today=todayUtc())=>({schema:1,updated_at:today,entries:[]});

// --- who wrote it ----------------------------------------------------------------------------
// by: a service-account name → "Home Hub API · <account>"; user: true → a person in the web UI.
export const USER_STAMP='user edit in Home Hub';
const stampOf=({by=null,user=false}={})=>user?USER_STAMP:typeof by==='string'&&/^[a-z][a-z0-9._-]{2,39}$/.test(by)?`Home Hub API · ${by}`:'Home Hub API';

// --- shape checks (the content check is validate()) ------------------------------------------
function entryShape(entry){
 if(!plain(entry)||typeof entry.id!=='string'||!ENTRY_ID.test(entry.id)||Object.keys(entry).some(k=>!ENTRY_FIELDS.includes(k)))invalid();
 if(Buffer.byteLength(JSON.stringify(entry))>LIMITS.entryBytes)invalid();
 return structuredClone(entry);
}
// One whole entry: {entry, base?}. base = the hash the caller read; omit it only to create.
export function entryInput(input){
 if(!only(input,['entry','base'])||!plain(input.entry)||('base'in input&&!HASH.test(input.base)))invalid();
 return {entry:entryShape(input.entry),...('base'in input?{base:input.base}:{})};
}
// by: the service account that made the change (shown as verified_by "Home Hub API · <account>").
export function applyEntry(doc,{entry,base},today=todayUtc(),by=null){
 const existing=doc.entries.find(e=>e.id===entry.id);
 if(existing?entryHash(existing)!==base:base!==undefined)throw new Error('conflict');
 const next={...entry,verified_at:today,verified_by:stampOf({by}),confidence:entry.confidence||'verified'};
 return {entry:next,doc:{...doc,updated_at:today,entries:existing?doc.entries.map(e=>e.id===next.id?next:e):[...doc.entries,next]}};
}

// Field edits from the entry form: {id, base, fields}. fields: the text fields in EDITABLE, machine,
// secrets [{what, store, ref, check}] and depends_on [{id, kind, label}]. An emptied field is removed.
const short=(v,max)=>{const x=v??'';if(typeof x!=='string'||x.length>max)invalid();return x.trim();};
function secretRows(v){
 if(!Array.isArray(v)||v.length>LIMITS.secrets)invalid();
 return v.map(s=>{if(!plain(s))invalid();const out={};for(const f of SECRET_FIELDS){const x=short(s[f],LIMITS.secretTextLength);if(x)out[f]=x;}return out;});
}
function dependencyRows(v){
 if(!Array.isArray(v)||v.length>LIMITS.dependsOn)invalid();
 return v.map(d=>{if(!only(d,['id','kind','label'])||typeof d.id!=='string'||!ENTRY_ID.test(d.id))invalid();
  const kind=short(d.kind,20),label=short(d.label,LIMITS.labelLength);return {id:d.id,...(kind?{kind}:{}),...(label?{label}:{})};});
}
export function editInput(input){
 if(!plain(input)||typeof input.id!=='string'||!ENTRY_ID.test(input.id)||!HASH.test(input.base)||!plain(input.fields))invalid();
 const fields={};
 for(const [k,v] of Object.entries(input.fields)){
  if(EDITABLE.includes(k))fields[k]=short(v,k==='notes'?LIMITS.notesLength:LIMITS.textLength);
  else if(k==='machine'){fields.machine=short(v,LIMITS.idLength);if(fields.machine&&!ENTRY_ID.test(fields.machine))invalid();}
  else if(k==='secrets')fields.secrets=secretRows(v);
  else if(k==='depends_on')fields.depends_on=dependencyRows(v);
  else invalid();
 }
 return {id:input.id,base:input.base,fields};
}
export function applyEdit(doc,{id,base,fields},today=todayUtc()){
 const entry=doc.entries.find(e=>e.id===id);
 if(!entry)throw new Error('not-found');
 if(entryHash(entry)!==base)throw new Error('conflict');
 const next={...withFields(entry,fields),verified_at:today,verified_by:USER_STAMP};
 return {doc:{...doc,updated_at:today,entries:doc.entries.map(e=>e.id===id?next:e)},entry:next};
}

// Delete: {id, base}. The hash is required, so nobody deletes an entry they have not just read.
export function deleteInput(input){
 if(!only(input,['id','base'])||typeof input.id!=='string'||!ENTRY_ID.test(input.id)||!HASH.test(input.base))invalid();
 return {id:input.id,base:input.base};
}
// Returns {doc, entry} or, while other entries still depend on it or run on it, {inUse: [ids]}.
export function applyDelete(doc,{id,base},today=todayUtc()){
 const entry=doc.entries.find(e=>e.id===id);
 if(!entry)throw new Error('not-found');
 if(entryHash(entry)!==base)throw new Error('conflict');
 const inUse=dependents(doc,id);
 if(inUse.length)return {inUse};
 return {doc:{...doc,updated_at:today,entries:doc.entries.filter(e=>e.id!==id)},entry};
}

// Bulk upsert: {entries: [{entry, base?}], dryRun?, keepVerified?}. At most LIMITS.bulkEntries
// entries, each id once. keepVerified (an import of an exported file) keeps each entry's own
// verified_at / verified_by / confidence instead of stamping them.
export function bulkInput(input){
 if(!only(input,['entries','dryRun','keepVerified'])||!Array.isArray(input.entries)||!input.entries.length||input.entries.length>LIMITS.bulkEntries)invalid();
 for(const k of ['dryRun','keepVerified'])if(k in input&&typeof input[k]!=='boolean')invalid();
 const entries=input.entries.map(entryInput),ids=entries.map(c=>c.entry.id);
 if(new Set(ids).size!==ids.length)invalid();
 return {entries,dryRun:input.dryRun===true,keepVerified:input.keepVerified===true};
}
// Applies every change or none. Returns {doc, results: [{id, action, hash}], conflicts: [ids]}:
// action is create, update or unchanged (the entry sent is the one on disk: nothing is restamped, its
// hash stays). A conflict is an existing entry whose base is missing or stale, or a base for an entry
// that does not exist; with any conflict the doc returned is the one passed in.
export function applyBulk(doc,{entries,keepVerified=false},{today=todayUtc(),by=null,user=false}={}){
 const current=new Map(doc.entries.map(e=>[e.id,e])),replaced=new Map(),added=[],results=[],conflicts=[];
 for(const {entry,base} of entries){
  const existing=current.get(entry.id);
  if(existing&&same(existing,entry)){results.push({id:entry.id,action:'unchanged',hash:entryHash(existing)});continue;}
  if(existing?entryHash(existing)!==base:base!==undefined){conflicts.push(entry.id);continue;}
  const next=keepVerified
   ?{...entry,verified_at:DATE.test(entry.verified_at||'')?entry.verified_at:today,verified_by:typeof entry.verified_by==='string'&&entry.verified_by?entry.verified_by:stampOf({by,user})}
   :{...entry,verified_at:today,verified_by:stampOf({by,user}),confidence:entry.confidence||'verified'};
  if(existing)replaced.set(entry.id,next);else added.push(next);
  results.push({id:entry.id,action:existing?'update':'create',hash:entryHash(next)});
 }
 if(conflicts.length)return {doc,results:[],conflicts};
 const changed=replaced.size+added.length>0;
 return {doc:changed?{...doc,updated_at:today,entries:[...doc.entries.map(e=>replaced.get(e.id)??e),...added]}:doc,results,conflicts,changed};
}
export const bulkSummary=results=>({create:results.filter(r=>r.action==='create').length,update:results.filter(r=>r.action==='update').length,unchanged:results.filter(r=>r.action==='unchanged').length});

/**
 * The editor for one file. Every method resolves to {ok:true, published, doc, …} or {ok:false, errors,
 * issues} when the checker refuses the result (nothing is written), and rejects with Error('invalid' |
 * 'not-found' | 'conflict' | 'busy') otherwise.
 *   editor(input)                    field edit from the entry form       → {entry, hash}
 *   editor.put(input, {by})          one whole entry                      → {entry, hash}
 *   editor.remove(input)             delete                               → {entry} | {ok:false, inUse}
 *   editor.bulk(input, {by, user})   bulk upsert (dryRun writes nothing)  → {results, summary} | {ok:false, conflicts}
 * A missing file is an empty inventory: the first write creates it.
 * publish runs after each saved change: by default nothing (the hub serves the file it just wrote), or
 * the script named by KNOWLEDGE_PUBLISH (e.g. one that copies the file to the machine that serves it).
 * secretStores: the site's own store names; default = the site this process loaded.
 */
export function createKnowledgeEditor({file=path.join(resolvePaths().data,'knowledge.json'),secretStores,publish=process.env.KNOWLEDGE_PUBLISH?()=>run(path.resolve(process.env.KNOWLEDGE_PUBLISH),[],{timeout:30000}):async()=>{}}={}){
 let busy=false;
 const read=async()=>{let text;try{text=await readFile(file,'utf8');}catch(e){if(e.code==='ENOENT')return emptyDoc();throw e;}return JSON.parse(text);};
 const write=async doc=>{await mkdir(path.dirname(file),{recursive:true});const tmp=`${file}.edit-${process.pid}`;await writeFile(tmp,JSON.stringify(doc,null,2)+'\n',{mode:0o600});await rename(tmp,file);};
 // apply(doc) → {doc, …extra} to check and save, or {stop: result} to answer without writing.
 const save=async(apply,{dryRun=false}={})=>{
  if(busy)throw new Error('busy');busy=true;
  try{
   const applied=apply(await read());
   if(applied.stop)return applied.stop;
   const {doc,...extra}=applied,{errors,issues}=check(doc,{secretStores});
   const failed=issues.filter(i=>i.level==='error');
   if(errors.length)return {ok:false,...(dryRun?{dryRun:true}:{}),errors:errors.slice(0,10),errorCount:errors.length,issues:failed.slice(0,50).map(({level,...i})=>i)};
   if(dryRun)return {ok:true,dryRun:true,...extra};
   let published=true;
   if(extra.changed!==false){await write(doc);try{await publish();}catch{published=false;}}
   return {ok:true,published,...extra,doc};
  }finally{busy=false;}
 };
 const editor=async input=>{const edit=editInput(input);return save(doc=>{const r=applyEdit(doc,edit);return {...r,hash:entryHash(r.entry)};});};
 editor.put=async(input,{by=null}={})=>{const change=entryInput(input);
  return save(doc=>{const r=applyEntry(doc,change,undefined,by);return {...r,hash:entryHash(r.entry)};});};
 editor.remove=async input=>{const change=deleteInput(input);
  return save(doc=>{const r=applyDelete(doc,change);return r.inUse?{stop:{ok:false,inUse:r.inUse}}:r;});};
 editor.bulk=async(input,{by=null,user=false}={})=>{const change=bulkInput(input);
  return save(doc=>{const r=applyBulk(doc,change,{by,user});
   if(r.conflicts.length)return {stop:{ok:false,...(change.dryRun?{dryRun:true}:{}),conflicts:r.conflicts}};
   return {doc:r.doc,results:r.results,summary:bulkSummary(r.results),changed:r.changed};},{dryRun:change.dryRun});};
 return editor;
}
