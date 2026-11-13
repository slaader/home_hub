// Review: variants an agent proposes for a project (HTML mockups, images, 3D models; later audio, video), compared
// side by side and decided by the owner. The index (sets → rounds → items → variants → media, plus one decision
// per item) is one row per set in state/hub.db (server/db.mjs; an old state/review/review.json is imported once);
// files are content-addressed blobs in state/review/blobs/.
// Writes to the index go through one queue and one transaction (with the search index); sets and decisions carry `rev`.
// Uploads arrive in ordered chunks (small requests: a chunk that fails is sent again, not the whole file).
// Errors are thrown as Error('invalid' | 'not-found' | 'conflict' | 'limit' | 'too-large').
// See docs/review.md.
import {mkdir,readFile,writeFile,rename,rm,stat,open,readdir} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {TICKET_ID} from './tickets-store.mjs';
import {openDb} from './db.mjs';

export const REVIEW_KINDS=Object.freeze(['html','image','model','video','audio']);
export const DECISIONS=Object.freeze(['pending','accept','revise','reject']);
// choose: the variants are alternatives, the owner takes one. approve: every variant is its own deliverable
// (follow-ups, clips, sheets), approved or sent back with comments one by one. A reference variant (e.g. what
// the game ships now) is shown for comparison only: it can be commented on, never taken or approved.
export const ITEM_MODES=Object.freeze(['choose','approve']);
export const APPROVALS=Object.freeze(['approved','changes']);
export const REVIEW_ID=/^R-[1-9][0-9]{0,5}$/;
export const SHA=/^[a-f0-9]{64}$/;
const IMAGE_TYPES=['image/png','image/jpeg','image/webp','image/gif'];
const VIDEO_TYPES=['video/mp4','video/webm'],AUDIO_TYPES=['audio/mpeg','audio/wav','audio/ogg','audio/flac','audio/mp4','audio/webm'];
const TYPES=Object.freeze({html:['text/html'],image:IMAGE_TYPES,model:['model/gltf-binary'],video:VIDEO_TYPES,audio:AUDIO_TYPES});
const MAGIC={'image/png':b=>b.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])),'image/jpeg':b=>b[0]===0xff&&b[1]===0xd8&&b[2]===0xff,
 'image/webp':b=>b.subarray(0,4).toString('latin1')==='RIFF'&&b.subarray(8,12).toString('latin1')==='WEBP','image/gif':b=>/^GIF8[79]a$/.test(b.subarray(0,6).toString('latin1')),
 'text/html':b=>!b.includes(0),
 // MP4 (ISO BMFF): a box of type "ftyp" first. WebM (Matroska): the EBML magic 1A 45 DF A3.
 'video/mp4':b=>b.length>=12&&b.subarray(4,8).toString('latin1')==='ftyp','video/webm':b=>b.length>=4&&b.readUInt32BE(0)===0x1a45dfa3,
 // Audio: MP3 (an ID3 tag or an MPEG frame sync), WAV (RIFF…WAVE), Ogg (Vorbis, Opus), FLAC, M4A (ftyp) and WebM.
 'audio/mpeg':b=>b.subarray(0,3).toString('latin1')==='ID3'||b.length>=2&&b[0]===0xff&&(b[1]&0xe0)===0xe0,
 'audio/wav':b=>b.subarray(0,4).toString('latin1')==='RIFF'&&b.subarray(8,12).toString('latin1')==='WAVE',
 'audio/ogg':b=>b.subarray(0,4).toString('latin1')==='OggS','audio/flac':b=>b.subarray(0,4).toString('latin1')==='fLaC',
 'audio/mp4':b=>b.length>=12&&b.subarray(4,8).toString('latin1')==='ftyp','audio/webm':b=>b.length>=4&&b.readUInt32BE(0)===0x1a45dfa3,
 // GLB: magic "glTF", container version 2, then the total length, which must be the file's size (checked in publish).
 'model/gltf-binary':b=>b.length>=12&&b.subarray(0,4).toString('latin1')==='glTF'&&b.readUInt32LE(4)===2};
export const LIMITS=Object.freeze({sets:2000,rounds:100,items:30,variants:6,media:20,comments:200,commentsPerSave:50,tickets:20,addresses:500,attachments:10,
 attachment:20*1024*1024,blob:256*1024*1024,model:128*1024*1024,chunk:8*1024*1024,inlineHtml:48*1024});
const ITEM=/^[a-z0-9][a-z0-9-]{0,39}$/,SURFACE=/^[0-9 .eE+-]{1,200}$/,VARIANT=/^[a-f]$/,MOCK_ID=/^[A-Za-z0-9_.:-]{1,80}$/,PROJECT=/^[a-z][a-z0-9-]{1,39}$/;
const fail=code=>{throw new Error(code);};
const plain=x=>x&&typeof x==='object'&&!Array.isArray(x);
const onlyKeys=(x,keys)=>plain(x)&&Object.keys(x).every(k=>keys.includes(k));
function text(v,max,{empty=false}={}){if(typeof v!=='string')fail('invalid');const t=v.trim();if((!empty&&!t)||t.length>max)fail('invalid');return t;}
const opt=(input,key,max)=>key in input?text(input[key],max,{empty:true}):'';
const num=(v,min,max,digits=3)=>typeof v==='number'&&Number.isFinite(v)&&v>=min&&v<=max?Math.round(v*10**digits)/10**digits:fail('invalid');
const vec=v=>onlyKeys(v,['x','y','z'])&&['x','y','z'].every(k=>k in v)?{x:num(v.x,-1e6,1e6,5),y:num(v.y,-1e6,1e6,5),z:num(v.z,-1e6,1e6,5)}:fail('invalid');
const int=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max?v:fail('invalid');
const sha256=buf=>createHash('sha256').update(buf).digest('hex');

// The helper the hub injects into every HTML mockup. It runs inside the sandboxed (opaque-origin) frame and
// only reports: document size, scroll, the hovered element and, in comment mode, the clicked one.
export const FRAME_HELPER=`(()=>{"use strict";const P=parent;let mode="browse",last=null,raf=0;
const post=m=>{try{P.postMessage(Object.assign({hhReview:1},m),"*");}catch{}};
const target=e=>e&&e.nodeType===1?(e.closest("[data-mock-id]")||e):null;
const sel=e=>{const parts=[];for(let n=e;n&&n.nodeType===1&&n!==document.documentElement&&parts.length<8;n=n.parentElement){if(n.id){parts.unshift("#"+CSS.escape(n.id));break;}let i=1,s=n;while((s=s.previousElementSibling))if(s.tagName===n.tagName)i++;parts.unshift(n.tagName.toLowerCase()+":nth-of-type("+i+")");}return parts.join(" > ").slice(0,300);};
const info=t=>{const r=t.getBoundingClientRect();return {mockId:t.getAttribute("data-mock-id"),selector:sel(t),rect:{x:r.left+scrollX,y:r.top+scrollY,w:r.width,h:r.height},snippet:(t.outerHTML||"").slice(0,600)};};
const size=()=>{const d=document.documentElement;post({type:"size",width:d.scrollWidth,height:Math.max(d.scrollHeight,document.body?document.body.scrollHeight:0)});};
addEventListener("message",e=>{if(e.source!==P||!e.data||e.data.hhReview!==1)return;
 if(e.data.type==="mode"){mode=e.data.mode==="comment"?"comment":"browse";document.documentElement.style.cursor=mode==="comment"?"crosshair":"";if(mode!=="comment"){last=null;post({type:"hover",rect:null});}}
 if(e.data.type==="scrollTo"&&Number.isFinite(e.data.y))scrollTo({top:Math.max(0,e.data.y-80),behavior:"smooth"});});
addEventListener("mousemove",e=>{if(mode!=="comment")return;const t=target(e.target);if(!t||t===last)return;last=t;post(Object.assign({type:"hover"},info(t)));},true);
document.addEventListener("mouseleave",()=>{last=null;post({type:"hover",rect:null});});
for(const ev of ["click","submit","auxclick"])addEventListener(ev,e=>{if(mode!=="comment")return;e.preventDefault();e.stopImmediatePropagation();
 if(ev==="click"){const t=target(e.target);if(t)post(Object.assign({type:"pick",x:e.pageX,y:e.pageY},info(t)));}},true);
addEventListener("keydown",e=>{if(e.key==="Escape"&&mode==="comment"){e.preventDefault();post({type:"escape"});}},true);
addEventListener("scroll",()=>{if(raf)return;raf=requestAnimationFrame(()=>{raf=0;post({type:"scroll",x:scrollX,y:scrollY});});},{passive:true});
addEventListener("load",size);if(typeof ResizeObserver==="function")new ResizeObserver(size).observe(document.documentElement);size();post({type:"ready"});})();`;
export function injectHelper(html){
 const tag=`<script>${FRAME_HELPER}</script>`,head=/<head\b[^>]*>/i.exec(html);
 if(head)return html.slice(0,head.index+head[0].length)+tag+html.slice(head.index+head[0].length);
 const doctype=/^\s*<!doctype[^>]*>/i.exec(html);
 return doctype?doctype[0]+tag+html.slice(doctype[0].length):tag+html;
}

// What the search box finds a review by: id and title (weighted), then every text a round carries.
export function reviewSearch(coll,s){
 if(coll!=='sets')return null;
 const parts=[s.description,s.tickets.join(' ')];
 for(const r of s.rounds){parts.push(r.notes);
  for(const i of r.items){parts.push(i.title,i.description);for(const v of i.variants){parts.push(v.label,v.title,v.description);for(const m of v.media)parts.push(m.name,m.caption);}}
  for(const d of Object.values(r.feedback)){parts.push(d.note);for(const c of d.comments)parts.push(c.text);}}
 return {kind:'review',id:s.id,project:s.project,updated:s.updatedAt,title:`${s.id} ${s.title}`,body:parts.filter(Boolean).join('\n')};
}

// Who published a set's rounds and who decided or commented on them, as [name, at] pairs
// (server/provenance.mjs → authoredProvenance). Publishing a round is the record; feedback is a change.
export const setAuthors=s=>({created:(s.rounds||[]).map(r=>[r.publishedBy,r.publishedAt]),
 changes:(s.rounds||[]).flatMap(r=>Object.values(r.feedback||{}).flatMap(d=>[...(d.updatedBy?[[d.updatedBy,d.updatedAt]]:[]),...(d.comments||[]).map(c=>[c.by,c.at])]))});

export function createReviewStore(root,{tickets,db=openDb(path.join(root,'hub.db')),maxBytes=Number(process.env.REVIEW_MAX_BYTES)||20*1024**3}={}){
 const blobs=path.join(root,'blobs'),uploads=path.join(root,'uploads');
 let queue=Promise.resolve(),used=null;const uploading=new Map();
 const empty=()=>({schema:1,next:1,updatedAt:null,sets:[],blobs:{}});
 const store=db.collection('review',{empty,legacy:path.join(root,'review.json'),searchKinds:['review'],search:reviewSearch,
  valid:d=>d?.schema===1&&Array.isArray(d.sets)&&plain(d.blobs),
  split:({sets,blobs,...meta})=>({meta,colls:{sets:sets.map(x=>[x.id,x]),blobs:Object.entries(blobs)}}),
  join:(meta,c)=>({...meta,sets:(c.sets||[]).map(([,x])=>x),blobs:Object.fromEntries(c.blobs||[])})});
 const read=()=>store.read();
 function write(fn){
  const run=queue.then(async()=>{
   const data=await read(),now=new Date().toISOString(),result=await fn(data,now);
   data.updatedAt=now;await store.write(data);
   return result;
  });queue=run.catch(()=>{});return run;
 }
 const setOf=(data,id)=>(typeof id==='string'&&REVIEW_ID.test(id)&&data.sets.find(s=>s.id===id))||fail('not-found');
 const blobFile=sha=>SHA.test(sha)?path.join(blobs,sha):fail('invalid');
 const exists=async p=>{try{return (await stat(p)).isFile();}catch(e){if(e.code==='ENOENT')return false;throw e;}};

 // Blobs ------------------------------------------------------------------------------------------
 async function usedBytes(){
  if(used!==null)return used;let total=0;
  for(const dir of [blobs,uploads]){let names=[];try{names=await readdir(dir);}catch(e){if(e.code!=='ENOENT')throw e;}
   for(const n of names)try{total+=(await stat(path.join(dir,n))).size;}catch{}}
  return used=total;
 }
 async function sweepUploads(){
  let names=[];try{names=await readdir(uploads);}catch(e){if(e.code==='ENOENT')return;throw e;}
  for(const n of names){const p=path.join(uploads,n);try{const s=await stat(p);if(Date.now()-s.mtimeMs>864e5&&!uploading.has(n.split('.')[0])){await rm(p,{force:true});if(used!==null)used-=s.size;}}catch{}}
 }
 const hasBlob=sha=>exists(blobFile(sha));
 // Appends one chunk at `offset`; returns {received,size,complete}. The stream must be consumed or destroyed by the caller on error.
 async function putChunk(sha,{offset,size},body){
  blobFile(sha);if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(size)||size<1||offset>=size)fail('invalid');
  if(size>LIMITS.blob)fail('too-large');
  if(await hasBlob(sha))return {received:size,size,complete:true};
  if(uploading.has(sha))fail('conflict');uploading.set(sha,true);
  const part=path.join(uploads,sha+'.part');
  try{
   await mkdir(uploads,{recursive:true,mode:0o700});await mkdir(blobs,{recursive:true,mode:0o700});
   let have=0;try{have=(await stat(part)).size;}catch(e){if(e.code!=='ENOENT')throw e;}
   if(offset===0&&have>0){await rm(part,{force:true});if(used!==null)used-=have;have=0;await sweepUploads();}
   if(offset!==have)return {received:have,size,complete:false,mismatch:true};
   const fh=await open(part,'a',0o600);let wrote=0;
   try{for await(const chunk of body){wrote+=chunk.length;if(wrote>LIMITS.chunk||have+wrote>size)fail('too-large');
     if((await usedBytes())+chunk.length>maxBytes)fail('limit');await fh.write(chunk);used+=chunk.length;}}
   finally{await fh.close();}
   const received=have+wrote;
   if(received<size)return {received,size,complete:false};
   const digest=createHash('sha256');for await(const c of createReadStream(part))digest.update(c);
   if(digest.digest('hex')!==sha){await rm(part,{force:true});used-=received;fail('digest-mismatch');}
   await rename(part,blobFile(sha));return {received,size,complete:true};
  }finally{uploading.delete(sha);}
 }
 async function head(sha,n=16){const fh=await open(blobFile(sha),'r');try{const b=Buffer.alloc(n);const {bytesRead}=await fh.read(b,0,n,0);return b.subarray(0,bytesRead);}finally{await fh.close();}}
 // A published blob: {file,type,size}. Unreferenced blobs are not served.
 async function media(sha){
  if(typeof sha!=='string'||!SHA.test(sha))fail('not-found');
  const data=await read(),meta=Object.hasOwn(data.blobs,sha)?data.blobs[sha]:null;if(!meta)fail('not-found');
  const file=blobFile(sha);if(!await exists(file))fail('not-found');return {file,type:meta.type,size:(await stat(file)).size};
 }
 async function frame(sha){const m=await media(sha);if(m.type!=='text/html')fail('not-found');return injectHelper(await readFile(m.file,'utf8'));}

 // Validation ---------------------------------------------------------------------------------------
 async function projectsAndTickets(project,ids){
  const meta=await tickets.list({limit:1});if(!meta.projects.some(p=>p.id===project))fail('invalid');
  for(const id of ids){if(typeof id!=='string'||!TICKET_ID.test(id))fail('invalid');let t;try{t=await tickets.get(id);}catch{fail('invalid');}if(t.project!==project)fail('invalid');}
  return meta.projects.find(p=>p.id===project);
 }
 // Items of a round. Returns {items, inline:[{sha,buf}], checks:[{sha,type}]}.
 function itemsOf(input){
  if(!Array.isArray(input)||input.length<1||input.length>LIMITS.items)fail('invalid');
  const inline=[],checks=[],ids=new Set();
  const items=input.map(it=>{
   if(!onlyKeys(it,['id','title','description','kind','mode','aligned','variants'])||typeof it.id!=='string'||!ITEM.test(it.id)||ids.has(it.id))fail('invalid');ids.add(it.id);
   const kind=REVIEW_KINDS.includes(it.kind)?it.kind:fail('invalid'),mode=it.mode===undefined?'choose':ITEM_MODES.includes(it.mode)?it.mode:fail('invalid');
   if(!Array.isArray(it.variants)||it.variants.length<1||it.variants.length>LIMITS.variants)fail('invalid');const vids=new Set();
   const variants=it.variants.map(v=>{
    if(!onlyKeys(v,['id','label','title','description','reference','media'])||'reference'in v&&typeof v.reference!=='boolean'||typeof v.id!=='string'||!VARIANT.test(v.id)||vids.has(v.id))fail('invalid');vids.add(v.id);
    if(!Array.isArray(v.media)||v.media.length<1||v.media.length>LIMITS.media)fail('invalid');
    const media=v.media.map(m=>{
     if(!onlyKeys(m,['sha256','type','html','name','caption','viewport','poster'])||!TYPES[kind].includes(m.type))fail('invalid');
     let sha;
     if('html'in m){if('sha256'in m||m.type!=='text/html'||typeof m.html!=='string'||!m.html.trim())fail('invalid');const buf=Buffer.from(m.html,'utf8');if(buf.length>LIMITS.inlineHtml)fail('too-large');sha=sha256(buf);inline.push({sha,buf});}
     else{if(typeof m.sha256!=='string'||!SHA.test(m.sha256))fail('invalid');sha=m.sha256;}
     checks.push({sha,type:m.type});
     // A 3D model or a clip may carry a still (png/jpeg/webp) as its poster: the card cover and the placeholder while it loads.
     let poster=null;
     if('poster'in m){if(!['model','video'].includes(kind)||!plain(m.poster)||!onlyKeys(m.poster,['sha256','type'])||typeof m.poster.sha256!=='string'||!SHA.test(m.poster.sha256)||!['image/png','image/jpeg','image/webp'].includes(m.poster.type))fail('invalid');
      poster={sha256:m.poster.sha256,type:m.poster.type};checks.push({sha:poster.sha256,type:poster.type});}
     let viewport=null;
     if('viewport'in m){if(kind!=='html'||!onlyKeys(m.viewport,['width','height']))fail('invalid');viewport={width:int(m.viewport.width,200,3840),height:int(m.viewport.height,200,4000)};}
     return {sha256:sha,type:m.type,name:opt(m,'name',200),caption:opt(m,'caption',1000),...(kind==='html'?{viewport:viewport||{width:1280,height:800}}:{}),...(poster?{poster}:{})};
    });
    return {id:v.id,label:'label'in v?text(v.label,40):v.id.toUpperCase(),title:opt(v,'title',160),description:opt(v,'description',4000),...(v.reference?{reference:true}:{}),media};
   });
   if(variants.every(v=>v.reference))fail('invalid');
   // aligned: every variant of an image or video item is the same shot (same camera, framing and pixel size; for
   // clips also the same timing), so the page opens it in the swipe view. A contact sheet or grid never should be.
   if('aligned'in it&&(typeof it.aligned!=='boolean'||it.aligned&&!['image','video'].includes(kind)))fail('invalid');
   return {id:it.id,title:text(it.title,160),description:opt(it,'description',4000),kind,mode,...(it.aligned?{aligned:true}:{}),variants};
  });
  return {items,inline,checks};
 }
 function anchorOf(a,kind,variant){
  if(a===null||a===undefined)return null;
  if(kind==='html'){
   if(!onlyKeys(a,['kind','media','mockId','selector','x','y','snippet'])||a.kind!=='element')fail('invalid');
   const mockId=a.mockId===null||a.mockId===undefined?null:typeof a.mockId==='string'&&MOCK_ID.test(a.mockId)?a.mockId:fail('invalid');
   return {kind:'element',media:int(a.media??0,0,variant.media.length-1),mockId,selector:opt(a,'selector',300),x:num(a.x,0,100000),y:num(a.y,0,100000),snippet:opt(a,'snippet',1000)};
  }
  if(kind==='model'){
   // A point on the model's surface in model coordinates, its normal, the camera pose to restore, and what was hit.
   if(!onlyKeys(a,['kind','media','position','normal','camera','node','mesh','material','surface','animation'])||a.kind!=='surface')fail('invalid');
   const c=a.camera;if(!onlyKeys(c,['theta','phi','radius','target','fov'])||!['theta','phi','radius','target','fov'].every(k=>k in c))fail('invalid');
   const anim=a.animation===null||a.animation===undefined?null:onlyKeys(a.animation,['name','time'])?{name:text(a.animation.name,200),time:num(a.animation.time,0,86400)}:fail('invalid');
   const surface=a.surface===null||a.surface===undefined||a.surface===''?null:typeof a.surface==='string'&&SURFACE.test(a.surface)?a.surface:fail('invalid');
   return {kind:'surface',media:int(a.media??0,0,variant.media.length-1),position:vec(a.position),normal:vec(a.normal),
    camera:{theta:num(c.theta,-1e4,1e4,5),phi:num(c.phi,-1e4,1e4,5),radius:num(c.radius,0,1e6,5),target:vec(c.target),fov:num(c.fov,0,180)},
    node:opt(a,'node',300),mesh:opt(a,'mesh',200),material:opt(a,'material',200),surface,animation:anim};
  }
  if(kind==='video'){
   // A place in one frame of the clip: the time in seconds and the point as fractions of the picture.
   if(!onlyKeys(a,['kind','media','t','x','y'])||a.kind!=='frame')fail('invalid');
   return {kind:'frame',media:int(a.media??0,0,variant.media.length-1),t:num(a.t,0,86400),x:num(a.x,0,1),y:num(a.y,0,1)};
  }
  if(kind==='audio'){
   // A moment of the track, in seconds.
   if(!onlyKeys(a,['kind','media','t'])||a.kind!=='time')fail('invalid');
   return {kind:'time',media:int(a.media??0,0,variant.media.length-1),t:num(a.t,0,86400)};
  }
  if(!onlyKeys(a,['kind','media','x','y'])||a.kind!=='point')fail('invalid');
  return {kind:'point',media:int(a.media??0,0,variant.media.length-1),x:num(a.x,0,1),y:num(a.y,0,1)};
 }

 // Read side ----------------------------------------------------------------------------------------
 const latest=s=>s.rounds[s.rounds.length-1];
 // Done: every item of the latest round has a variant taken (accept or revise). A rework (reject) keeps the set open.
 const doneOf=s=>{const r=latest(s);return r.items.every(i=>['accept','revise'].includes(r.feedback[i.id]?.status));};
 const pendingOf=s=>{const r=latest(s);return Object.values(r.feedback).some(d=>d.updatedAt>=r.publishedAt&&(d.comments.length||d.status!=='pending'));};
 function summary(s){
  const r=latest(s),decided=r.items.filter(i=>r.feedback[i.id]&&r.feedback[i.id].status!=='pending').length;
  // Card cover: the first image, else a 3D model's poster, else the first HTML mockup (a scaled, non-interactive frame).
  const media=r.items.flatMap(i=>i.variants.flatMap(v=>v.media)),cover=media.find(m=>m.type.startsWith('image/'))||media.find(m=>m.poster)?.poster||media.find(m=>m.type==='text/html')||null;
  return {id:s.id,project:s.project,title:s.title,description:s.description,tickets:s.tickets,status:s.status,done:doneOf(s),rev:s.rev,createdAt:s.createdAt,createdBy:s.createdBy,updatedAt:s.updatedAt,
   rounds:s.rounds.length,round:{n:r.n,publishedAt:r.publishedAt,publishedBy:r.publishedBy,items:r.items.length,kinds:[...new Set(r.items.map(i=>i.kind))],decided,
    comments:Object.values(r.feedback).reduce((n,d)=>n+d.comments.length,0)},feedbackPending:pendingOf(s),cover:cover?{sha256:cover.sha256,type:cover.type,...(cover.viewport?{viewport:cover.viewport}:{})}:null};
 }
 const FILTERS=['project','ticket','status','feedback'];
 // authors: true adds `authors` = {created, changes} over the listed sets (server/provenance.mjs).
 async function list(filter={},{authors=false}={}){
  if(!onlyKeys(filter,FILTERS))fail('invalid');const f=Object.fromEntries(Object.entries(filter).filter(([,v])=>v!==undefined&&v!==''));
  if(Object.values(f).some(v=>typeof v!=='string'))fail('invalid');
  if(f.project&&!PROJECT.test(f.project)||f.ticket&&!TICKET_ID.test(f.ticket)||f.status&&!['open','active','done','archived','all'].includes(f.status)||f.feedback&&f.feedback!=='pending')fail('invalid');
  const status=f.status||'open',data=await read();
  const sets=data.sets.filter(s=>(!f.project||s.project===f.project)&&(!f.ticket||s.tickets.includes(f.ticket))&&(status==='all'||(status==='active'?s.status==='open'&&!doneOf(s):status==='done'?s.status==='open'&&doneOf(s):s.status===status))&&(!f.feedback||pendingOf(s)))
   .sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
  const out={updatedAt:data.updatedAt,sets:sets.map(summary)};
  if(!authors)return out;
  const facts={created:[],changes:[]};for(const s of sets){const a=setAuthors(s);facts.created.push(...a.created);facts.changes.push(...a.changes);}
  return {...out,authors:facts};
 }
 async function get(id){const data=await read(),s=setOf(data,id);return {...s,done:doneOf(s),feedbackPending:pendingOf(s)};}

 // Write side ---------------------------------------------------------------------------------------
 async function publish(input,by){
  if(!onlyKeys(input,['project','set','title','description','tickets','notes','addresses','items']))fail('invalid');
  const {items,inline,checks}=itemsOf(input.items);
  const ticketIds='tickets'in input?(Array.isArray(input.tickets)&&input.tickets.length<=LIMITS.tickets?[...new Set(input.tickets)]:fail('invalid')):null;
  const addresses='addresses'in input?(Array.isArray(input.addresses)&&input.addresses.length<=LIMITS.addresses&&input.addresses.every(a=>typeof a==='string'&&a.length<=64)?[...new Set(input.addresses)]:fail('invalid')):[];
  const notes=opt(input,'notes',4000),title='title'in input?text(input.title,160):null,description='description'in input?text(input.description,4000,{empty:true}):null;
  if('set'in input&&(typeof input.set!=='string'||!REVIEW_ID.test(input.set)))fail('invalid');
  let project=input.project;
  if(!('set'in input)){if(typeof project!=='string'||!PROJECT.test(project)||title===null)fail('invalid');}
  else if(project!==undefined&&(typeof project!=='string'||!PROJECT.test(project)))fail('invalid');
  if(!('set'in input)&&addresses.length)fail('invalid');
  if(project===undefined){const s=setOf(await read(),input.set);project=s.project;}
  await projectsAndTickets(project,ticketIds||[]);
  // Inline HTML becomes a blob; every referenced blob must exist and look like its declared type.
  for(const {sha,buf} of inline)if(!await hasBlob(sha)){await mkdir(blobs,{recursive:true,mode:0o700});const tmp=blobFile(sha)+'.'+randomUUID();
   try{await writeFile(tmp,buf,{mode:0o600,flag:'wx'});await rename(tmp,blobFile(sha));if(used!==null)used+=buf.length;}finally{await rm(tmp,{force:true});}}
  for(const {sha,type} of checks){if(!await hasBlob(sha))fail('missing-blob');if(!MAGIC[type](await head(sha,type==='text/html'?4096:16)))fail('invalid');}
  const sizes=Object.fromEntries(await Promise.all([...new Set(checks.map(c=>c.sha))].map(async sha=>[sha,(await stat(blobFile(sha))).size])));
  for(const {sha,type} of checks)if(type==='model/gltf-binary'){if(sizes[sha]>LIMITS.model)fail('too-large');if((await head(sha,12)).readUInt32LE(8)!==sizes[sha])fail('invalid');}
  for(const i of items)for(const v of i.variants)for(const m of v.media){m.size=sizes[m.sha256];if(m.poster)m.poster.size=sizes[m.poster.sha256];}
  return write((data,now)=>{
   for(const {sha,type} of checks){const old=Object.hasOwn(data.blobs,sha)?data.blobs[sha]:null;if(old&&old.type!==type)fail('invalid');data.blobs[sha]={type,size:sizes[sha]};}
   let s;
   if('set'in input){
    s=setOf(data,input.set);if(s.project!==project)fail('invalid');if(s.status!=='open')fail('conflict');if(s.rounds.length>=LIMITS.rounds)fail('limit');
    const known=new Set(s.rounds.flatMap(r=>Object.values(r.feedback).flatMap(d=>d.comments.map(c=>c.id))));if(!addresses.every(a=>known.has(a)))fail('invalid');
    if(title!==null)s.title=title;if(description!==null)s.description=description;if(ticketIds)s.tickets=ticketIds;
    s.rounds.push({n:s.rounds.length+1,notes,addresses,publishedAt:now,publishedBy:by,items,feedback:{}});s.updatedAt=now;s.rev++;
   }else{
    if(data.sets.length>=LIMITS.sets)fail('limit');
    s={id:`R-${data.next++}`,project,title,description:description??'',tickets:ticketIds||[],status:'open',createdAt:now,createdBy:by,updatedAt:now,rev:1,
     rounds:[{n:1,notes,addresses:[],publishedAt:now,publishedBy:by,items,feedback:{}}]};
    data.sets.push(s);
   }
   return {...summary(s),url:`#review/${s.id}`};
  });
 }
 async function feedback(input,by){
  if(!onlyKeys(input,['set','round','item','rev','variant','status','note','comments','attachments','approvals','editComments','deleteComments'])||!Number.isSafeInteger(input.rev)||input.rev<0)fail('invalid');
  const status=DECISIONS.includes(input.status)?input.status:fail('invalid'),note='note'in input?text(input.note,4000,{empty:true}):undefined;
  const comments='comments'in input?(Array.isArray(input.comments)&&input.comments.length<=LIMITS.commentsPerSave?input.comments:fail('invalid')):[];
  // Saved comments of this round changed by their author: new text ({id, text}) or removed (ids).
  const list=k=>k in input?(Array.isArray(input[k])&&input[k].length<=LIMITS.commentsPerSave?input[k]:fail('invalid')):[];
  const edits=list('editComments').map(e=>onlyKeys(e,['id','text'])&&typeof e.id==='string'?{id:e.id,text:e.text}:fail('invalid'));
  const removes=list('deleteComments').map(id=>typeof id==='string'?id:fail('invalid'));
  if(new Set([...edits.map(e=>e.id),...removes]).size!==edits.length+removes.length)fail('invalid');
  // Screenshots, uploaded first as blobs like media: on the item's note (the whole list each time) and on new comments.
  const shots=async list=>{
   if(!Array.isArray(list)||list.length>LIMITS.attachments)fail('invalid');const seen=new Set(),out=[];
   for(const a of list){
    if(!onlyKeys(a,['sha256','type','name'])||typeof a.sha256!=='string'||!SHA.test(a.sha256)||!IMAGE_TYPES.includes(a.type))fail('invalid');if(seen.has(a.sha256))continue;seen.add(a.sha256);
    if(!await hasBlob(a.sha256))fail('missing-blob');if(!MAGIC[a.type](await head(a.sha256)))fail('invalid');
    const size=(await stat(blobFile(a.sha256))).size;if(size>LIMITS.attachment)fail('too-large');
    out.push({sha256:a.sha256,type:a.type,size,name:opt(a,'name',200)});
   }
   return out;
  };
  const attachments='attachments'in input?await shots(input.attachments):undefined;
  const commentShots=[];for(const c of comments)commentShots.push(plain(c)&&'attachments'in c?await shots(c.attachments):[]);
  return write((data,now)=>{
   const s=setOf(data,input.set);if(s.status!=='open')fail('conflict');
   const r=s.rounds.find(x=>x.n===input.round)||fail('not-found');if(r!==latest(s))fail('conflict');
   const item=r.items.find(i=>i.id===input.item)||fail('not-found');
   const mode=item.mode||'choose',decidable=item.variants.filter(v=>!v.reference);
   const variant=input.variant===null||input.variant===undefined?null:decidable.find(v=>v.id===input.variant)?.id||fail('invalid');
   // approve items: one verdict per (non-reference) variant; the item's status follows from them (reject stays explicit).
   let approvals=null;
   if(mode==='approve'){
    if(variant)fail('invalid');const a=input.approvals??{};if(!plain(a))fail('invalid');
    approvals={};for(const [k,v] of Object.entries(a)){if(!decidable.some(x=>x.id===k)||!APPROVALS.includes(v))fail('invalid');approvals[k]=v;}
   }else if('approvals'in input)fail('invalid');
   if(mode==='choose'&&['accept','revise'].includes(status)&&!variant)fail('invalid');
   const old=Object.hasOwn(r.feedback,item.id)?r.feedback[item.id]:{rev:0,variant:null,status:'pending',note:'',comments:[],attachments:[]};
   if(input.rev!==old.rev)fail('conflict');
   const added=comments.map((c,i)=>{
    if(!onlyKeys(c,['variant','anchor','text','attachments']))fail('invalid');const v=item.variants.find(x=>x.id===c.variant)||fail('invalid');
    // A comment needs text or at least one screenshot.
    const files=commentShots[i],body=files.length?text(c.text??'',2000,{empty:true}):text(c.text,2000);
    return {id:randomUUID(),variant:v.id,anchor:anchorOf(c.anchor,item.kind,v),text:body,...(files.length?{attachments:files}:{}),by,at:now};
   });
   if(old.comments.length+added.length>LIMITS.comments)fail('limit');
   const own=id=>{const c=old.comments.find(x=>x.id===id)||fail('invalid');return c.by===by?c:fail('forbidden');};
   for(const id of removes)own(id);
   const changedText=new Map(edits.map(e=>{const c=own(e.id);return [e.id,c.attachments?.length?text(e.text??'',2000,{empty:true}):text(e.text,2000)];}));
   const kept=old.comments.filter(c=>!removes.includes(c.id)).map(c=>changedText.has(c.id)&&changedText.get(c.id)!==c.text?{...c,text:changedText.get(c.id),editedAt:now}:c);
   const finalStatus=approvals&&status!=='reject'?(decidable.every(v=>approvals[v.id]==='approved')?'accept':Object.values(approvals).includes('changes')?'revise':'pending'):status;
   const d={rev:old.rev+1,variant,status:finalStatus,...(approvals?{approvals}:{}),note:note??old.note,comments:[...kept,...added],attachments:attachments??old.attachments??[],updatedAt:now,updatedBy:by};
   if(status==='reject'&&!d.note&&!d.comments.length&&!d.attachments.length)fail('invalid');
   for(const a of [...(attachments||[]),...commentShots.flat()]){const known=Object.hasOwn(data.blobs,a.sha256)?data.blobs[a.sha256]:null;if(known&&known.type!==a.type)fail('invalid');data.blobs[a.sha256]={type:a.type,size:a.size};}
   r.feedback[item.id]=d;s.updatedAt=now;return {set:s.id,round:r.n,item:item.id,...d};
  });
 }
 async function saveSet(input){
  if(!onlyKeys(input,['id','rev','status','title'])||!Number.isSafeInteger(input.rev)||!('status'in input||'title'in input))fail('invalid');
  if('status'in input&&!['open','archived'].includes(input.status))fail('invalid');const title='title'in input?text(input.title,160):null;
  return write((data,now)=>{const s=setOf(data,input.id);if(s.rev!==input.rev)fail('conflict');if('status'in input)s.status=input.status;if(title!==null)s.title=title;s.updatedAt=now;s.rev++;return summary(s);});
 }
 return {list,get,publish,feedback,saveSet,putChunk,hasBlob,media,frame};
}
