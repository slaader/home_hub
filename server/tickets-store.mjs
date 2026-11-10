// Ticket tracker for your own development work: projects, releases and tickets,
// one row each in state/hub.db (server/db.mjs; an old state/tickets/tickets.json is imported once). Every
// write goes through one queue and one transaction, which also updates the full-text index. Each ticket and
// release carries `rev`; an update must send the rev it read, otherwise it is refused as a conflict (read
// again, reapply). Comments are append-only and need no rev.
// Errors are thrown as Error('invalid' | 'not-found' | 'conflict' | 'limit').
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {openDb} from './db.mjs';

export const TICKET_TYPES=Object.freeze(['bug','feature','task']);
export const TICKET_STATUSES=Object.freeze(['open','in-progress','done','cancelled']);
export const TICKET_PRIORITIES=Object.freeze(['low','normal','high','urgent']);
export const RELEASE_STATUSES=Object.freeze(['planned','released']);
export const PROJECT_TYPES=Object.freeze(['app','game','other']);
export const CLOSED=Object.freeze(['done','cancelled']);
export const TICKET_ID=/^[A-Z][A-Z0-9]{1,9}-[1-9][0-9]{0,5}$/;
const PROJECT_ID=/^[a-z][a-z0-9-]{1,39}$/,PROJECT_KEY=/^[A-Z][A-Z0-9]{1,9}$/,VERSION=/^(?!none$)[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/,LABEL=/^[a-z0-9][a-z0-9-]{0,29}$/,DAY=/^\d{4}-\d{2}-\d{2}$/;
const LIMITS={projects:50,releases:500,tickets:5000,comments:200,history:200,labels:10,refs:20,attachments:20};
const fail=code=>{throw new Error(code);};
const plain=x=>x&&typeof x==='object'&&!Array.isArray(x);
const onlyKeys=(x,keys)=>plain(x)&&Object.keys(x).every(k=>keys.includes(k));
// Trimmed text of 1..max characters (or 0..max when empty is allowed); anything else is invalid.
function text(v,max,{empty=false}={}){if(typeof v!=='string')fail('invalid');const t=v.trim();if((!empty&&!t)||t.length>max)fail('invalid');return t;}
const oneOf=(v,list)=>list.includes(v)?v:fail('invalid');
const nullable=(v,fn)=>v===null||v===''?null:fn(v);
const day=v=>nullable(v,x=>typeof x==='string'&&DAY.test(x)&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString().slice(0,10)===x?x:fail('invalid'));
const validRev=v=>Number.isSafeInteger(v)&&v>0;
export const TICKET_BODY_LIMIT=16384;
const writeInput=(input,keys)=>onlyKeys(input,keys)&&Buffer.byteLength(JSON.stringify(input))<=TICKET_BODY_LIMIT;
function labels(v){if(!Array.isArray(v)||v.length>LIMITS.labels)fail('invalid');const out=[...new Set(v.map(l=>typeof l==='string'?l.trim().toLowerCase():''))];if(!out.every(l=>LABEL.test(l)))fail('invalid');return out;}
function refs(v){if(!Array.isArray(v)||v.length>LIMITS.refs)fail('invalid');return [...new Set(v.map(r=>text(r,300)))];}
export const compareVersions=(a,b)=>a.localeCompare(b,'en',{numeric:true,sensitivity:'base'});

// A new store starts with the projects the site asks for (site.json → tracker.projects); none by default.
const empty=(seed=[])=>({schema:1,revision:0,updatedAt:null,projects:seed.map(p=>({...p,description:'',createdAt:null,rev:1,next:1})),releases:[],tickets:[]});
const publicProject=({next,...p})=>({...p,type:p.type??null});
const summary=({comments,history,attachments,...t})=>({...t,comments:comments.length,attachments:(attachments||[]).length});

const rows=(list,key)=>(list||[]).map(x=>[key(x),x]),docs=list=>(list||[]).map(([,d])=>d);
// What the search box finds a ticket by: id and title (weighted), then description, comments, attachment names, labels, refs and people.
export const ticketSearch=(coll,t)=>coll!=='tickets'?null:{kind:'ticket',id:t.id,project:t.project,updated:t.updatedAt,title:`${t.id} ${t.title}`,
 body:[t.description,...t.comments.map(c=>c.text),...(t.attachments||[]).map(a=>a.name),t.labels.join(' '),t.refs.join(' '),t.assignee,t.reporter].filter(Boolean).join('\n')};

export function createTicketStore(root,{db=openDb(path.join(root,'hub.db')),seedProjects=[]}={}){
 let queue=Promise.resolve();
 const store=db.collection('tickets',{empty:()=>empty(seedProjects),legacy:path.join(root,'tickets.json'),searchKinds:['ticket'],search:ticketSearch,
  valid:d=>d?.schema===1&&Array.isArray(d.projects)&&Array.isArray(d.releases)&&Array.isArray(d.tickets),
  split:({projects,releases,tickets,...meta})=>({meta,colls:{projects:rows(projects,p=>p.id),releases:rows(releases,r=>r.project+'/'+r.version),tickets:rows(tickets,t=>t.id)}}),
  join:(meta,c)=>({...meta,projects:docs(c.projects),releases:docs(c.releases),tickets:docs(c.tickets)})});
 const read=()=>store.read();
 // Serialised read-modify-write; fn mutates the document and returns the reply. A throw writes nothing.
 function write(fn){
  const run=queue.then(async()=>{
   const data=await read(),now=new Date().toISOString(),result=fn(data,now);
   data.revision++;data.updatedAt=now;await store.write(data);
   return result;
  });queue=run.catch(()=>{});return run;
 }
 const projectOf=(data,id)=>data.projects.find(p=>p.id===id)||fail('invalid');
 function releaseOf(data,project,version){
  if(version===null)return null;
  if(typeof version!=='string'||!VERSION.test(version))fail('invalid');
  return data.releases.find(r=>r.project===project&&r.version===version)?.version||fail('invalid');
 }
 const ticketOf=(data,id)=>(typeof id==='string'&&TICKET_ID.test(id)&&data.tickets.find(t=>t.id===id))||fail('not-found');

 // Read side ---------------------------------------------------------------------------------
 const FILTERS=['project','status','type','priority','release','assignee','label','q','limit'];
 // Validates the field filters shared by list() and search(); returns the cleaned filter and a ticket predicate.
 function ticketFilter(filter,keys=FILTERS){
  if(!onlyKeys(filter,keys))fail('invalid');
  const f=Object.fromEntries(Object.entries(filter).filter(([,v])=>v!==undefined&&v!==''));
  for(const [k,v] of Object.entries(f))if(typeof v!=='string'&&(k!=='limit'||typeof v!=='number'))fail('invalid');
  if(f.status&&f.status.length>60)fail('invalid');
  if(f.type)oneOf(f.type,TICKET_TYPES);if(f.priority)oneOf(f.priority,TICKET_PRIORITIES);
  if(f.project&&!PROJECT_ID.test(f.project)||f.release&&f.release!=='none'&&!VERSION.test(f.release)||f.label&&!LABEL.test(f.label)||f.assignee&&f.assignee.length>60)fail('invalid');
  const statuses=f.status?String(f.status).split(',').map(s=>oneOf(s,[...TICKET_STATUSES,'active'])).flatMap(s=>s==='active'?['open','in-progress']:[s]):null;
  const match=t=>(!f.project||t.project===f.project)&&(!statuses||statuses.includes(t.status))&&(!f.type||t.type===f.type)
   &&(!f.priority||t.priority===f.priority)&&(!f.release||(f.release==='none'?t.release===null:t.release===f.release))
   &&(!f.assignee||(f.assignee==='none'?t.assignee===null:t.assignee===f.assignee))&&(!f.label||t.labels.includes(f.label));
  return {f,match};
 }
 async function list(filter={}){
  const {f,match}=ticketFilter(filter);
  if(f.q&&f.q.length>100)fail('invalid');
  const data=await read();
  const q=f.q?f.q.toLowerCase():null,limit=f.limit===undefined?null:Number(f.limit);
  if(limit!==null&&!(Number.isInteger(limit)&&limit>0&&limit<=LIMITS.tickets))fail('invalid');
  let tickets=data.tickets.filter(t=>match(t)&&(!q||[t.id,t.title,t.description,...t.labels].join('\n').toLowerCase().includes(q)));
  tickets.sort((a,b)=>TICKET_STATUSES.indexOf(a.status)-TICKET_STATUSES.indexOf(b.status)||TICKET_PRIORITIES.indexOf(b.priority)-TICKET_PRIORITIES.indexOf(a.priority)||b.updatedAt.localeCompare(a.updatedAt));
  const total=tickets.length;if(limit)tickets=tickets.slice(0,limit);
  // Release progress is counted over all tickets, not just the filtered ones.
  const releases=data.releases.filter(r=>!f.project||r.project===f.project).map(r=>{
   const mine=data.tickets.filter(t=>t.project===r.project&&t.release===r.version),counts=Object.fromEntries(TICKET_STATUSES.map(s=>[s,mine.filter(t=>t.status===s).length]));
   return {...r,counts,total:mine.length};}).sort((a,b)=>a.project.localeCompare(b.project)||compareVersions(a.version,b.version));
  return {updatedAt:data.updatedAt,projects:data.projects.map(publicProject),releases,total,tickets:tickets.map(summary)};
 }
 async function get(id){const data=await read(),t=ticketOf(data,id);return {...t,attachments:t.attachments||[]};}
 // Full-text search over tickets (title, description, comments, attachment names, labels, refs, people) with the
 // same field filters as list(). Plain words, every word a prefix match; best match first. Each hit is the list
 // summary plus `snippet` (matched words wrapped in \u0001…\u0002) and `score`.
 async function search(filter={}){
  const {f,match}=ticketFilter(filter);
  if(typeof f.q!=='string'||f.q.length>200||!/[\p{L}\p{N}_]/u.test(f.q))fail('invalid');
  const limit=f.limit===undefined?20:Number(f.limit);if(!(Number.isInteger(limit)&&limit>0&&limit<=100))fail('invalid');
  const data=await read(),byId=new Map(data.tickets.map(t=>[t.id,t]));
  const hits=db.search({q:f.q,kind:'ticket',...(f.project?{project:f.project}:{}),limit:LIMITS.tickets},{max:LIMITS.tickets}).results
   .map(r=>({r,t:byId.get(r.id)})).filter(x=>x.t&&match(x.t));
  return {q:f.q,total:hits.length,tickets:hits.slice(0,limit).map(({r,t})=>({...summary(t),snippet:r.snippet,score:r.score}))};
 }
 // The names tickets know: assignees (with how many tickets they hold, and how many of those are active),
 // reporters and comment authors. The assignee field suggests them.
 async function people(){
  const data=await read(),seen=new Map();
  const of=name=>{if(typeof name!=='string'||!name)return null;if(!seen.has(name))seen.set(name,{name,assigned:0,active:0});return seen.get(name);};
  for(const t of data.tickets){
   const a=of(t.assignee);if(a){a.assigned++;if(!CLOSED.includes(t.status))a.active++;}
   of(t.reporter);for(const c of t.comments)of(c.by);
  }
  return [...seen.values()].sort((a,b)=>b.active-a.active||b.assigned-a.assigned||a.name.localeCompare(b.name,'en'));
 }
 // Attachments: the file itself lives in ticket-files (content-addressed); the ticket keeps the metadata.
 // Like comments they need no rev; adding or removing one is recorded in the history.
 async function attachment(id,attachmentId){const t=await get(id);return t.attachments.find(a=>a.id===attachmentId)||fail('not-found');}
 async function attach(id,file,by){
  if(!plain(file)||typeof file.sha256!=='string'||!/^[a-f0-9]{64}$/.test(file.sha256)||!Number.isSafeInteger(file.size)||typeof file.type!=='string')fail('invalid');
  const name=text(file.name,120);
  return write((data,now)=>{
   const t=ticketOf(data,id);t.attachments=t.attachments||[];if(t.attachments.length>=LIMITS.attachments)fail('limit');
   t.attachments.push({id:randomUUID(),name,type:file.type,size:file.size,sha256:file.sha256,by,at:now});
   t.history.push({at:now,by,field:'attachment',from:null,to:name});t.history=t.history.slice(-LIMITS.history);t.updatedAt=now;return {...t};
  });
 }
 // Returns the ticket and whether any ticket still references the removed file.
 async function detach(input,by){
  if(!writeInput(input,['id','attachment'])||typeof input.attachment!=='string')fail('invalid');
  return write((data,now)=>{
   const t=ticketOf(data,input.id),list=t.attachments||[],a=list.find(x=>x.id===input.attachment)||fail('not-found');
   t.attachments=list.filter(x=>x!==a);t.history.push({at:now,by,field:'attachment',from:a.name,to:null});t.history=t.history.slice(-LIMITS.history);t.updatedAt=now;
   const used=data.tickets.some(x=>(x.attachments||[]).some(y=>y.sha256===a.sha256));
   return {ticket:{...t},removed:a,used};
  });
 }

 // Write side --------------------------------------------------------------------------------
 const TICKET_FIELDS=['title','description','type','status','priority','release','assignee','labels','refs'];
 function fields(input,project,data){
  const out={};
  if('title'in input)out.title=text(input.title,200);
  if('description'in input)out.description=text(input.description,12000,{empty:true});
  if('type'in input)out.type=oneOf(input.type,TICKET_TYPES);
  if('status'in input)out.status=oneOf(input.status,TICKET_STATUSES);
  if('priority'in input)out.priority=oneOf(input.priority,TICKET_PRIORITIES);
  if('release'in input)out.release=releaseOf(data,project,input.release===''?null:input.release);
  if('assignee'in input)out.assignee=nullable(input.assignee,v=>{const name=text(v,60);return name==='none'?fail('invalid'):name;});
  if('labels'in input)out.labels=labels(input.labels);
  if('refs'in input)out.refs=refs(input.refs);
  return out;
 }
 async function create(input,by){
  if(!writeInput(input,['project',...TICKET_FIELDS])||typeof input.project!=='string'||!('title'in input))fail('invalid');
  return write((data,now)=>{
   const project=projectOf(data,input.project);if(data.tickets.length>=LIMITS.tickets)fail('limit');
   const f=fields(input,project.id,data),id=`${project.key}-${project.next}`;project.next++;
   const ticket={id,project:project.id,title:f.title,description:f.description??'',type:f.type??'task',status:f.status??'open',priority:f.priority??'normal',
    release:f.release??null,assignee:f.assignee??null,labels:f.labels??[],refs:f.refs??[],reporter:by,createdAt:now,updatedAt:now,
    closedAt:CLOSED.includes(f.status)?now:null,rev:1,comments:[],attachments:[],history:[{at:now,by,field:'created',from:null,to:f.status??'open'}]};
   data.tickets.push(ticket);return ticket;
  });
 }
 async function update(input,by){
  if(!writeInput(input,['id','rev',...TICKET_FIELDS])||!validRev(input.rev)||!TICKET_FIELDS.some(k=>k in input))fail('invalid');
  return write((data,now)=>{
   const t=ticketOf(data,input.id);if(t.rev!==input.rev)fail('conflict');
   const f=fields(input,t.project,data),changed=Object.keys(f).filter(k=>JSON.stringify(f[k])!==JSON.stringify(t[k]));
   if(!changed.length)return t;
   // History keeps values for the short fields; title/description record only that they changed.
   for(const k of changed)t.history.push({at:now,by,field:k,from:['title','description'].includes(k)?null:t[k],to:['title','description'].includes(k)?null:f[k]});
   if('status'in f&&f.status!==t.status)t.closedAt=CLOSED.includes(f.status)?now:null;
   Object.assign(t,f);t.history=t.history.slice(-LIMITS.history);t.updatedAt=now;t.rev++;return t;
  });
 }
 async function comment(input,by){
  if(!writeInput(input,['id','text'])||!('text'in input))fail('invalid');
  const body=text(input.text,8000);
  return write((data,now)=>{
   const t=ticketOf(data,input.id);if(t.comments.length>=LIMITS.comments)fail('limit');
   t.comments.push({id:randomUUID(),at:now,by,text:body});t.updatedAt=now;return t;
  });
 }
 // Create a release (no rev) or change one (rev required). Released → releasedAt defaults to today.
 async function saveRelease(input,by){
  if(!writeInput(input,['project','version','status','targetDate','releasedAt','notes','rev'])||typeof input.version!=='string'||!VERSION.test(input.version))fail('invalid');
  if(input.rev!==undefined&&!validRev(input.rev))fail('invalid');
  return write((data,now)=>{
   const project=projectOf(data,input.project),old=data.releases.find(r=>r.project===project.id&&r.version===input.version);
   if(old?input.rev!==old.rev:input.rev!==undefined)fail(old||input.rev===undefined?'conflict':'not-found');
   if(!old&&data.releases.length>=LIMITS.releases)fail('limit');
   const r=old||{project:project.id,version:input.version,status:'planned',targetDate:null,releasedAt:null,notes:'',createdAt:now,createdBy:by,rev:0};
   if('status'in input)r.status=oneOf(input.status,RELEASE_STATUSES);
   if('targetDate'in input)r.targetDate=day(input.targetDate);
   if('releasedAt'in input)r.releasedAt=day(input.releasedAt);
   if('notes'in input)r.notes=text(input.notes,2000,{empty:true});
   if(r.status==='released'&&!r.releasedAt)r.releasedAt=now.slice(0,10);
   if(r.status==='planned')r.releasedAt=null;
   r.updatedAt=now;r.rev++;if(!old)data.releases.push(r);return r;
  });
 }
 // Create a project (no rev; id and key are permanent) or change its name/description/type (rev required).
 async function saveProject(input,by){
  if(!writeInput(input,['id','key','name','description','type','rev'])||typeof input.id!=='string'||!PROJECT_ID.test(input.id))fail('invalid');
  if(input.rev!==undefined&&!validRev(input.rev))fail('invalid');
  const name='name'in input?text(input.name,80):undefined,description='description'in input?text(input.description,500,{empty:true}):undefined;
  const type='type'in input?nullable(input.type,v=>oneOf(v,PROJECT_TYPES)):undefined;
  return write((data,now)=>{
   const old=data.projects.find(p=>p.id===input.id);
   if(old){
    if(input.rev!==old.rev)fail('conflict');
    if('key'in input&&input.key!==old.key)fail('invalid');
    if(name!==undefined)old.name=name;if(description!==undefined)old.description=description;if(type!==undefined)old.type=type;
    old.updatedAt=now;old.rev++;return publicProject(old);
   }
   if(input.rev!==undefined)fail('not-found');
   if(typeof input.key!=='string'||!PROJECT_KEY.test(input.key)||name===undefined)fail('invalid');
   if(data.projects.some(p=>p.key===input.key))fail('conflict');
   if(data.projects.length>=LIMITS.projects)fail('limit');
   const p={id:input.id,key:input.key,name,description:description??'',type:type??null,createdAt:now,createdBy:by,updatedAt:now,rev:1,next:1};data.projects.push(p);return publicProject(p);
  });
 }
 return {list,get,search,people,create,update,comment,saveRelease,saveProject,attach,detach,attachment};
}
