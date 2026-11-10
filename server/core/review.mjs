// Core module "review": sets of variants (HTML mockups, images, 3D models) an agent publishes for the
// owner to decide on, with content-addressed uploads (docs/review.md).
import path from 'node:path';
import {createReadStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {createReviewStore,REVIEW_ID,SHA,LIMITS as REVIEW_LIMITS} from '../review-store.mjs';
import {byteRange} from '../http-range.mjs';

const reviewError=e=>[({invalid:400,'missing-blob':400,'digest-mismatch':400,'not-found':404,conflict:409,limit:409,'too-large':413})[e.message]||503,'REVIEW_FAILED',({invalid:'Neplatný požadavek na review (zkontroluj pole, projekt, tikety a typy souborů).','missing-blob':'Některý soubor ještě není nahraný (nahraj ho přes PUT /api/review/blobs/<sha256> nebo scripts/review-push.mjs).','digest-mismatch':'Nahraný soubor nesouhlasí se svým sha256; nahraj ho znovu od začátku.','not-found':'Review neexistuje.',conflict:'Záznam se mezitím změnil (nebo už existuje novější kolo). Načti ho znovu a změnu zopakuj.',limit:'Byl dosažen limit (počet záznamů nebo místo pro soubory).','too-large':'Soubor nebo jeho část je příliš velká.'})[e.message]||'Review teď nejde načíst ani uložit.'];
const who=c=>c.principal.username;
const write=(path,options,run)=>({method:'POST',path,scope:'review:write',error:reviewError,...options,async handler(c){c.subject=null;return run(c);}});

export default {
 id:'review',title:'Review',
 assets:['review-view.js','review.css','vendor/model-viewer.min.js'],
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
  {method:'GET',path:'/api/review',error:reviewError,handler:async c=>c.json(200,await c.state.review.list(c.query))},
  {method:'GET',match:/^\/api\/review\/sets\/(.*)$/,error:reviewError,async handler({params,json,state}){if(!REVIEW_ID.test(params[1]))throw new Error('not-found');return json(200,await state.review.get(params[1]));}},
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
};
