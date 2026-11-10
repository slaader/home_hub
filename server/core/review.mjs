// Core module "review": sets of variants (HTML mockups, images, 3D models) an agent publishes for the
// owner to decide on, with content-addressed uploads (docs/review.md).
import path from 'node:path';
import {createReadStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {createReviewStore,setAuthors,REVIEW_ID,SHA,LIMITS as REVIEW_LIMITS} from '../review-store.mjs';
import {authoredProvenance} from '../provenance.mjs';
import {byteRange} from '../http-range.mjs';

// Messages come in two languages: Czech source text for the web UI (which translates it through its
// dictionary, like every other string) and English for an API key, i.e. the push script or an agent.
const REVIEW_MESSAGES={
 invalid:['Neplatný požadavek na review (zkontroluj pole, projekt, tikety a typy souborů).','Invalid review request (check the fields, the project, the tickets and the file types).'],
 'missing-blob':['Některý soubor ještě není nahraný (nahraj ho přes PUT /api/review/blobs/<sha256> nebo scripts/review-push.mjs).','A file is not uploaded yet (upload it with PUT /api/review/blobs/<sha256> or scripts/review-push.mjs).'],
 'digest-mismatch':['Nahraný soubor nesouhlasí se svým sha256; nahraj ho znovu od začátku.','The uploaded file does not match its sha256; upload it again from the start.'],
 'not-found':['Review neexistuje.','The review does not exist.'],
 conflict:['Záznam se mezitím změnil (nebo už existuje novější kolo). Načti ho znovu a změnu zopakuj.','The record changed in the meantime (or a newer round exists). Read it again and repeat the change.'],
 limit:['Byl dosažen limit (počet záznamů nebo místo pro soubory).','A limit was reached (the number of records or the space for files).'],
 'too-large':['Soubor nebo jeho část je příliš velká.','The file or a part of it is too large.'],
 unavailable:['Review teď nejde načíst ani uložit.','Review cannot be loaded or saved right now.'],
};
const reviewError=(e,c)=>[({invalid:400,'missing-blob':400,'digest-mismatch':400,'not-found':404,conflict:409,limit:409,'too-large':413})[e.message]||503,'REVIEW_FAILED',
 (REVIEW_MESSAGES[e.message]||REVIEW_MESSAGES.unavailable)[c?.principal?.authKind==='api-key'?1:0]];
const who=c=>c.principal.username;
const write=(path,options,run)=>({method:'POST',path,scope:'review:write',error:reviewError,...options,async handler(c){c.subject=null;return run(c);}});

export default {
 id:'review',title:'Review',
 mcpInstructions:[
  'Review (variants published for a person to compare and decide): review_list with feedbackPending:true finds decisions waiting for you. review_get returns a set with the decision and comments per item.',
  {scope:'review:write',text:'With review:write: review_publish creates a set, or the next round of one, listing the comment ids that round answers.'},
 ],
 assets:['review-view.js','review.css','vendor/model-viewer.min.js','i18n-en-review.js'],
 nav:[{group:'Project Tracker',hash:'review',label:'Review',view:'review-view.js#reviewPage',order:43}],
 setup:hub=>({review:createReviewStore(path.join(hub.stateDirectory,'review'),{tickets:hub.state('tracker').tickets,db:hub.db})}),
 routes:[
  // Review uploads: raw chunks of one content-addressed blob, appended in order (docs/review.md).
  {method:'PUT',match:/^\/api\/review\/blobs\/(.*)$/,scope:'review:write',raw:true,contentType:'application/octet-stream',error:reviewError,async handler(c){
    const {req,url,params,state}=c,sha=params[1],length=Number(req.headers['content-length']);
    if(Number.isFinite(length)&&length>REVIEW_LIMITS.chunk)return c.error(413,'TOO_LARGE',`One chunk may be at most ${REVIEW_LIMITS.chunk} bytes.`);
    const n=k=>/^\d{1,12}$/.test(url.searchParams.get(k)||'')?Number(url.searchParams.get(k)):NaN;
    const out=await state.review.putChunk(sha,{offset:n('offset'),size:n('size')},req);req.resume();c.subject=sha.slice(0,12);
    if(out.mismatch)return c.json(409,{error:{code:'REVIEW_FAILED',message:'Upload offset does not match; continue from received.'},received:out.received,size:out.size});
    return c.json(out.complete?201:200,out);}},
  write('/api/review/publish',{bodyLimit:65536},async c=>{const saved=await c.state.review.publish(c.input,who(c));c.subject=saved.id;return c.json(c.input?.set===undefined?201:200,saved);}),
  write('/api/review/feedback',{bodyLimit:65536},async c=>{const saved=await c.state.review.feedback(c.input,who(c));c.subject=saved.set;return c.json(200,saved);}),
  write('/api/review/sets',{},async c=>{const saved=await c.state.review.saveSet(c.input);c.subject=saved.id;return c.json(200,saved);}),
  // provenance (server/provenance.mjs): who published the rounds (agents, as a rule) and who decided on them (people).
  {method:'GET',path:'/api/review',error:reviewError,async handler(c){const {authors,...data}=await c.state.review.list(c.query,{authors:true});
    return c.json(200,{...data,provenance:authoredProvenance(c.hub.accessStore,authors,{unit:'rounds'})});}},
  {method:'GET',match:/^\/api\/review\/sets\/(.*)$/,error:reviewError,async handler({params,json,state,hub}){if(!REVIEW_ID.test(params[1]))throw new Error('not-found');
    const set=await state.review.get(params[1]);return json(200,{...set,provenance:authoredProvenance(hub.accessStore,setAuthors(set),{unit:'rounds'})});}},
  // An HTML mockup runs sandboxed in an opaque origin: no cookies, no Home Hub API, no network (docs/review.md).
  {method:'GET',match:/^\/api\/review\/frame\/(.*)$/,error:reviewError,async handler({params,res,state}){
    const html=await state.review.frame(params[1]);
    res.setHeader('Content-Security-Policy',"sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'");
    res.setHeader('X-Frame-Options','SAMEORIGIN');res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});return res.end(html);}},
  {method:'GET',match:/^\/api\/review\/blobs\/(.*)$/,head:true,error:reviewError,async handler({req,res,params,principal,error,state}){
    const review=state.review,sha=params[1];
    // The push script asks with HEAD whether an upload can be skipped, before the blob is published.
    if(req.method==='HEAD'&&principal.authKind==='api-key'&&SHA.test(sha)&&!(await review.media(sha).then(()=>true,()=>false))){res.writeHead(await review.hasBlob(sha)?200:404,{'X-Review-Blob':'unpublished'});return res.end();}
    const media=await review.media(sha);let range;
    try{range=byteRange(req.headers.range,media.size);}catch{res.setHeader('Content-Range',`bytes */${media.size}`);return error(416,'INVALID_RANGE','Invalid media range.');}
    res.setHeader('Content-Security-Policy',"sandbox; default-src 'none'");res.setHeader('Cache-Control','private, max-age=31536000, immutable');
    res.writeHead(range.status,{'Content-Type':media.type,'Accept-Ranges':'bytes','Content-Length':range.end-range.start+1,...(range.status===206?{'Content-Range':`bytes ${range.start}-${range.end}/${media.size}`}:{})});
    if(req.method==='HEAD')res.end();else try{await pipeline(createReadStream(media.file,{start:range.start,end:range.end}),res);}catch{res.destroy();}}},
 ],
 // Rows for the API reference (Users and API). The MCP tools review_list, review_get and review_publish do the same for agents.
 apiDocs:[{title:'Review',routes:[
  ['GET','/api/review?project=&ticket=&status=active|done|archived|all&feedback=pending','read','Sady variant k posouzení se stavem posledního kola.'],
  ['GET','/api/review/sets/<R-n>','read','Celá sada: kola, položky, varianty, rozhodnutí a připomínky.'],
  ['PUT','/api/review/blobs/<sha256>?offset=&size=','review:write','Nahrání souboru po částech (nejvýš 8 MiB na požadavek).'],
  ['POST','/api/review/publish','review:write','Nová sada {project, title, items} nebo další kolo {set, items, addresses?}.'],
  ['POST','/api/review/feedback','review:write','Rozhodnutí k položce {set, round, item, rev, variant, status, note?, comments?}.'],
  ['POST','/api/review/sets','review:write','Archivace nebo přejmenování sady {id, rev, status?, title?}.']]}],
};
