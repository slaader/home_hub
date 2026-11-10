// Applies one inventory entry edit from Home Hub to data/knowledge.json (the source of truth),
// then runs the publish step, if one is configured (see createKnowledgeEditor). The hub calls it for its own
// file; a bridge on another machine can run the same editor next to the file it owns.
import {readFile,writeFile,rename} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {validate} from './check-knowledge.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const run=promisify(execFile);
export const EDITABLE=['name','type','category','address','version','config','data','managed_by','login','notes'];
export const entryHash=e=>createHash('sha256').update(JSON.stringify(e)).digest('hex');
export function entryInput(input){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['entry','base'].includes(k))||!input.entry||typeof input.entry!=='object'||Array.isArray(input.entry)||!/^[a-z][a-z0-9-]{0,63}$/.test(input.entry.id)||('base'in input&&!/^[a-f0-9]{64}$/.test(input.base)))throw new Error('invalid');
 const allowed=['id','kind','machine','name','type','category','address','version','config','data','managed_by','login','notes','secrets','depends_on','models','skills','verified_at','verified_by','confidence'];
 if(Object.keys(input.entry).some(k=>!allowed.includes(k)))throw new Error('invalid');
 return {entry:structuredClone(input.entry),...('base'in input?{base:input.base}:{})};
}
// by: the service account that made the change (shown as verified_by "Home Hub API · <account>").
export function applyEntry(doc,{entry,base},today=new Date().toISOString().slice(0,10),by=null){
 const existing=doc.entries.find(e=>e.id===entry.id);
 if(existing?entryHash(existing)!==base:base!==undefined)throw new Error('conflict');
 const next={...entry,verified_at:today,verified_by:typeof by==='string'&&/^[a-z][a-z0-9._-]{2,39}$/.test(by)?`Home Hub API · ${by}`:'Home Hub API',confidence:entry.confidence||'verified'};
 return {entry:next,doc:{...doc,updated_at:today,entries:existing?doc.entries.map(e=>e.id===next.id?next:e):[...doc.entries,next]}};
}

// Shape check only; the content check is the same validate() agents run.
export function editInput(input){
  if(!input||typeof input!=='object'||!/^[a-z][a-z0-9-]{0,63}$/.test(input.id)||!/^[a-f0-9]{64}$/.test(input.base)||!input.fields||typeof input.fields!=='object')throw new Error('invalid');
  const fields={};
  for(const [k,v] of Object.entries(input.fields)){
    if(EDITABLE.includes(k)){if(typeof v!=='string'||v.length>2000)throw new Error('invalid');fields[k]=v.trim();}
    else if(k==='secrets'){if(!Array.isArray(v)||v.length>30)throw new Error('invalid');
      fields.secrets=v.map(s=>{if(!s||typeof s!=='object')throw new Error('invalid');const out={};for(const f of ['what','store','ref','check']){const x=s[f]??'';if(typeof x!=='string'||x.length>500)throw new Error('invalid');if(x.trim())out[f]=x.trim();}return out;});}
    else throw new Error('invalid');
  }
  return {id:input.id,base:input.base,fields};
}
export function applyEdit(doc,{id,base,fields},today=new Date().toISOString().slice(0,10)){
  const entry=doc.entries.find(e=>e.id===id);
  if(!entry)throw new Error('not-found');
  if(entryHash(entry)!==base)throw new Error('conflict');
  const next={...entry};
  for(const k of EDITABLE)if(k in fields){if(fields[k])next[k]=fields[k];else delete next[k];}
  if('secrets' in fields){if(fields.secrets.length)next.secrets=fields.secrets;else delete next.secrets;}
  next.verified_at=today;next.verified_by='user edit in Home Hub';
  const updated={...doc,updated_at:today,entries:doc.entries.map(e=>e.id===id?next:e)};
  return {doc:updated,entry:next};
}
// publish runs after each saved edit: by default nothing (the hub serves the file it just wrote), or the
// script named by KNOWLEDGE_PUBLISH (e.g. one that copies the file to the machine that serves it).
export function createKnowledgeEditor({file=path.join(root,'data','knowledge.json'),publish=process.env.KNOWLEDGE_PUBLISH?()=>run(path.resolve(process.env.KNOWLEDGE_PUBLISH),[],{timeout:30000}):async()=>{}}={}){
  let busy=false;
  const save=async apply=>{
    if(busy)throw new Error('busy');busy=true;
    try{
      const {doc,entry}=apply(JSON.parse(await readFile(file,'utf8')));
      const {errors}=validate(doc);
      if(errors.length)return {ok:false,errors:errors.slice(0,10)};
      const tmp=`${file}.edit-${process.pid}`;await writeFile(tmp,JSON.stringify(doc,null,2)+'\n',{mode:0o600});await rename(tmp,file);
      let published=true;try{await publish();}catch{published=false;}
      return {ok:true,published,entry,hash:entryHash(entry),doc};
    }finally{busy=false;}
  };
  const editor=async input=>{const edit=editInput(input);return save(doc=>applyEdit(doc,edit));};
  editor.put=async(input,{by=null}={})=>{const change=entryInput(input);return save(doc=>applyEntry(doc,change,undefined,by));};
  return editor;
}
