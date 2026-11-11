import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readdir} from 'node:fs/promises';
import {Readable} from 'node:stream';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {createReviewStore,injectHelper,FRAME_HELPER,LIMITS} from '../server/review-store.mjs';
import {createTicketStore as createStore} from '../server/tickets-store.mjs';
// The tracker seeds nothing by itself; these tests start with the two projects a site would configure.
const SEED=[{id:'home-hub',key:'HH',name:'Home Hub',type:'app'},{id:'sample-game',key:'GAME',name:'Sample Game',type:'game'}];
const createTicketStore=(root,options={})=>createStore(root,{seedProjects:SEED,...options});
import {resolveManifest,upload} from '../scripts/review-push.mjs';
import {hub} from './hub-helper.mjs';

const sha=b=>createHash('sha256').update(b).digest('hex');
const PNG=Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),Buffer.from('not really pixels')]);
const HTML='<!doctype html><html><head><title>A</title></head><body><button data-mock-id="cta">Go</button></body></html>';
const body=b=>Readable.from([b]);
async function stores(t,opts){
 const dir=await mkdtemp(path.join(os.tmpdir(),'review-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const tickets=createTicketStore(path.join(dir,'tickets'));return {dir,tickets,r:createReviewStore(path.join(dir,'review'),{tickets,...opts})};
}
const put=(r,buf)=>r.putChunk(sha(buf),{offset:0,size:buf.length},body(buf));
const htmlItem=(id='login',variants=['a','b'])=>({id,title:'Login',kind:'html',variants:variants.map(v=>({id:v,title:'Var '+v,media:[{type:'text/html',html:HTML.replace('Go',v)}]}))});

test('review store: the author edits and deletes saved comments of the latest round',async t=>{
 const {r}=await stores(t);
 await r.publish({project:'home-hub',title:'Login',items:[htmlItem()]},'claude');
 const base={set:'R-1',round:1,item:'login'};
 const d1=await r.feedback({...base,rev:0,variant:'a',status:'revise',comments:[{variant:'a',anchor:null,text:'one'},{variant:'b',anchor:null,text:'two'}]},'alice');
 const [one,two]=d1.comments;
 // Only the author, only known ids, never both on one id, never empty text.
 await assert.rejects(r.feedback({...base,rev:1,variant:'a',status:'revise',editComments:[{id:one.id,text:'x'}]},'bob'),/forbidden/);
 await assert.rejects(r.feedback({...base,rev:1,variant:'a',status:'revise',deleteComments:[two.id]},'bob'),/forbidden/);
 await assert.rejects(r.feedback({...base,rev:1,variant:'a',status:'revise',deleteComments:['nope']},'alice'),/invalid/);
 await assert.rejects(r.feedback({...base,rev:1,variant:'a',status:'revise',editComments:[{id:one.id,text:'x'}],deleteComments:[one.id]},'alice'),/invalid/);
 await assert.rejects(r.feedback({...base,rev:1,variant:'a',status:'revise',editComments:[{id:one.id,text:'  '}]},'alice'),/invalid/);
 const d2=await r.feedback({...base,rev:1,variant:'a',status:'revise',editComments:[{id:one.id,text:' one, smaller '}]},'alice');
 assert.equal(d2.comments.length,2);assert.equal(d2.comments[0].text,'one, smaller');assert.equal(d2.comments[0].id,one.id);assert.ok(d2.comments[0].editedAt);
 assert.equal(d2.comments[1].editedAt,undefined);
 const d3=await r.feedback({...base,rev:2,variant:'a',status:'accept',deleteComments:[one.id]},'alice');
 assert.deepEqual(d3.comments.map(c=>c.id),[two.id]);assert.equal(d3.status,'accept');
 // A later round makes the old one read-only: its comments can no longer change.
 await r.publish({set:'R-1',items:[htmlItem()],addresses:[two.id]},'claude');
 await assert.rejects(r.feedback({...base,rev:3,variant:'a',status:'accept',deleteComments:[two.id]},'alice'),/conflict/);
});

test('review store: publish, rounds, decisions with rev, anchors and pending feedback',async t=>{
 const {r,tickets}=await stores(t);
 const tk=await tickets.create({project:'home-hub',title:'Login screen'},'a'),dune=await tickets.create({project:'sample-game',title:'Harvester'},'a');
 await put(r,PNG);
 const set=await r.publish({project:'home-hub',title:'Login',tickets:[tk.id],items:[htmlItem(),{id:'hero',title:'Hero image',kind:'image',variants:[{id:'a',media:[{sha256:sha(PNG),type:'image/png',caption:'front'}]}]}]},'claude');
 assert.equal(set.id,'R-1');assert.equal(set.round.n,1);assert.deepEqual(set.round.kinds,['html','image']);assert.equal(set.cover.sha256,sha(PNG));assert.equal(set.url,'#review/R-1');assert.equal(set.feedbackPending,false);
 const full=await r.get('R-1');const v=full.rounds[0].items[0].variants[0];
 assert.equal(v.label,'A');assert.deepEqual(v.media[0].viewport,{width:1280,height:800});assert.ok(v.media[0].size>0);
 // Media served only once referenced, with the declared type; HTML frames get the helper.
 assert.equal((await r.media(sha(PNG))).type,'image/png');
 const frame=await r.frame(v.media[0].sha256);assert.ok(frame.startsWith('<!doctype html><html><head><script>'));assert.ok(frame.includes('data-mock-id="cta"'));
 await assert.rejects(r.frame(sha(PNG)),/not-found/);
 // Validation: kind/type mismatch, unknown project, foreign ticket, missing blob, wrong magic, duplicate ids.
 await assert.rejects(r.publish({project:'home-hub',title:'x',items:[{id:'i',title:'t',kind:'image',variants:[{id:'a',media:[{type:'text/html',html:HTML}]}]}]},'c'),/invalid/);
 await assert.rejects(r.publish({project:'nope',title:'x',items:[htmlItem()]},'c'),/invalid/);
 await assert.rejects(r.publish({project:'home-hub',title:'x',tickets:[dune.id],items:[htmlItem()]},'c'),/invalid/);
 await assert.rejects(r.publish({project:'home-hub',title:'x',items:[{id:'i',title:'t',kind:'image',variants:[{id:'a',media:[{type:'image/png',sha256:'f'.repeat(64)}]}]}]},'c'),/missing-blob/);
 await assert.rejects(r.publish({project:'home-hub',title:'x',items:[{id:'i',title:'t',kind:'image',variants:[{id:'a',media:[{type:'image/jpeg',sha256:sha(PNG)}]}]}]},'c'),/invalid/);
 await assert.rejects(r.publish({project:'home-hub',title:'x',items:[htmlItem('a'),htmlItem('a')]},'c'),/invalid/);
 await assert.rejects(r.publish({project:'home-hub',title:'x',items:[htmlItem('a',['a','a'])]},'c'),/invalid/);
 await assert.rejects(r.publish({project:'home-hub',title:'x',items:[htmlItem('a',['g'])]},'c'),/invalid/);
 await assert.rejects(r.publish({project:'home-hub',title:'x',items:[htmlItem()],extra:1},'c'),/invalid/);
 await assert.rejects(r.publish({project:'home-hub',title:'x',items:[{...htmlItem(),variants:[{id:'a',media:[{type:'text/html',html:'x'.repeat(LIMITS.inlineHtml+1)}]}]}]},'c'),/too-large/);

 // Feedback: element and point anchors, rev guard, reject needs a reason.
 const anchor={kind:'element',media:0,mockId:'cta',selector:'body > button:nth-of-type(1)',x:40,y:20,snippet:'<button data-mock-id="cta">'};
 const d1=await r.feedback({set:'R-1',round:1,item:'login',rev:0,variant:'a',status:'revise',note:'close',comments:[{variant:'a',anchor,text:' smaller button '}]},'alice');
 assert.equal(d1.rev,1);assert.equal(d1.comments[0].text,'smaller button');assert.equal(d1.comments[0].by,'alice');assert.equal(d1.comments[0].anchor.mockId,'cta');
 await assert.rejects(r.feedback({set:'R-1',round:1,item:'login',rev:0,variant:'a',status:'accept'},'x'),/conflict/);
 await assert.rejects(r.feedback({set:'R-1',round:1,item:'login',rev:1,variant:null,status:'accept'},'x'),/invalid/,'accept needs a variant');
 await assert.rejects(r.feedback({set:'R-1',round:1,item:'hero',rev:0,variant:null,status:'reject'},'x'),/invalid/,'reject needs a reason');
 await assert.rejects(r.feedback({set:'R-1',round:1,item:'hero',rev:0,variant:'a',status:'pending',comments:[{variant:'a',anchor:{kind:'point',x:1.5,y:0},text:'x'}]},'x'),/invalid/);
 await assert.rejects(r.feedback({set:'R-1',round:1,item:'hero',rev:0,variant:'a',status:'pending',comments:[{variant:'a',anchor,text:'x'}]},'x'),/invalid/,'element anchor on an image');
 await assert.rejects(r.feedback({set:'R-1',round:1,item:'login',rev:1,variant:'a',status:'pending',comments:[{variant:'a',anchor:{...anchor,mockId:'has space'},text:'x'}]},'x'),/invalid/);
 await assert.rejects(r.feedback({set:'R-1',round:1,item:'login',rev:1,variant:'z',status:'pending'},'x'),/invalid/);
 const d2=await r.feedback({set:'R-1',round:1,item:'hero',rev:0,variant:'a',status:'pending',comments:[{variant:'a',anchor:{kind:'point',x:0.25,y:0.5},text:'darker sky'}]},'alice');
 assert.deepEqual(d2.comments[0].anchor,{kind:'point',media:0,x:0.25,y:0.5});
 const listed=await r.list({feedback:'pending'});assert.equal(listed.sets.length,1);assert.equal(listed.sets[0].round.decided,1);assert.equal(listed.sets[0].round.comments,2);

 // Round 2 answers the comment; round 1 becomes read-only and pending feedback clears.
 await assert.rejects(r.publish({set:'R-1',addresses:['not-a-comment'],items:[htmlItem()]},'claude'),/invalid/);
 const r2=await r.publish({set:'R-1',notes:'smaller CTA',addresses:[d1.comments[0].id],items:[htmlItem('login',['a'])]},'claude');
 assert.equal(r2.round.n,2);assert.equal(r2.rounds,2);assert.equal(r2.feedbackPending,false);
 await assert.rejects(r.feedback({set:'R-1',round:1,item:'login',rev:1,variant:'a',status:'accept'},'x'),/conflict/);
 assert.equal((await r.feedback({set:'R-1',round:2,item:'login',rev:0,variant:'a',status:'accept'},'x')).status,'accept');
 assert.equal((await r.list({project:'home-hub'})).sets.length,1);assert.equal((await r.list({project:'sample-game'})).sets.length,0);
 assert.equal((await r.list({ticket:tk.id})).sets.length,1);
 await assert.rejects(r.list({status:'weird'}),/invalid/);

 // Archive: hidden from the default list, no more feedback or rounds.
 const s=await r.get('R-1');await assert.rejects(r.saveSet({id:'R-1',rev:s.rev+5,status:'archived'}),/conflict/);
 await r.saveSet({id:'R-1',rev:s.rev,status:'archived'});
 assert.equal((await r.list()).sets.length,0);assert.equal((await r.list({status:'archived'})).sets.length,1);
 await assert.rejects(r.feedback({set:'R-1',round:2,item:'login',rev:1,variant:'a',status:'accept'},'x'),/conflict/);
 await assert.rejects(r.publish({set:'R-1',items:[htmlItem()]},'c'),/conflict/);
});

test('review uploads: ordered chunks, resume, digest check, size and quota limits',async t=>{
 const {r,dir}=await stores(t,{maxBytes:64});
 const data=Buffer.from('0123456789abcdefghij'),h=sha(data);
 assert.deepEqual(await r.putChunk(h,{offset:0,size:20},body(data.subarray(0,8))),{received:8,size:20,complete:false});
 assert.equal((await r.putChunk(h,{offset:4,size:20},body(data.subarray(4,8)))).mismatch,true,'wrong offset reports what arrived');
 assert.deepEqual(await r.putChunk(h,{offset:8,size:20},body(data.subarray(8))),{received:20,size:20,complete:true});
 assert.equal(await r.hasBlob(h),true);await assert.rejects(r.media(h),/not-found/,'not served before it is published');
 assert.equal((await r.putChunk(h,{offset:0,size:20},body(data))).complete,true,'existing blob is not uploaded again');
 const bad=Buffer.from('aaaa');await assert.rejects(r.putChunk('b'.repeat(64),{offset:0,size:4},body(bad)),/digest-mismatch/);
 assert.deepEqual(await readdir(path.join(dir,'review','uploads')),[]);
 await assert.rejects(r.putChunk(h.replace(/./,'0'),{offset:0,size:LIMITS.blob+1},body(bad)),/too-large/);
 await assert.rejects(r.putChunk('c'.repeat(64),{offset:0,size:3},body(bad)),/too-large/,'more bytes than declared');
 const big=Buffer.alloc(60,1);await assert.rejects(r.putChunk(sha(big),{offset:0,size:60},body(big)),/limit/,'store quota');
 await assert.rejects(r.putChunk('nope',{offset:0,size:1},body(bad)),/invalid/);
});

test('frame helper goes after <head>, after a doctype, or first',()=>{
 assert.ok(injectHelper('<html><HEAD lang="cs"><title>x').startsWith('<html><HEAD lang="cs"><script>'));
 assert.ok(injectHelper('<!DOCTYPE html><p>x').startsWith('<!DOCTYPE html><script>'));
 assert.ok(injectHelper('<p>x').startsWith('<script>'));
 assert.ok(!FRAME_HELPER.includes('</script'));
});

test('review HTTP: scopes, sandbox headers, unpublished blobs, CSRF and the push script',async t=>{
 const h=await hub(t),reader=await h.account('reader',[]),agent=await h.account('review-agent',['review:write']);
 const auth=a=>({Authorization:'Bearer '+a.token});
 const putBlob=(headers,buf,q=`offset=0&size=${buf.length}`)=>fetch(`${h.origin}/api/review/blobs/${sha(buf)}?${q}`,{method:'PUT',headers:{'Content-Type':'application/octet-stream',...headers},body:buf});
 assert.equal((await putBlob(auth(reader),PNG)).status,403,'read-only key');
 assert.equal((await putBlob({Cookie:h.admin.Cookie,Origin:'https://evil.example'},PNG)).status,403,'cross-origin session upload');
 assert.equal((await putBlob({Origin:h.origin},PNG)).status,401);
 assert.equal((await fetch(`${h.origin}/api/review/blobs/${sha(PNG)}`,{method:'HEAD',headers:auth(agent)})).status,404);
 const up=await putBlob(auth(agent),PNG);assert.equal(up.status,201);assert.equal((await up.json()).complete,true);
 const unpublished=await fetch(`${h.origin}/api/review/blobs/${sha(PNG)}`,{method:'HEAD',headers:auth(agent)});assert.equal(unpublished.status,200);assert.equal(unpublished.headers.get('x-review-blob'),'unpublished');
 assert.equal((await fetch(`${h.origin}/api/review/blobs/${sha(PNG)}`,{headers:h.admin})).status,404,'browsers see only published blobs');
 assert.equal((await putBlob(auth(agent),PNG,'offset=0&size=x')).status,400);assert.equal((await putBlob(auth(agent),PNG)).status,201,'already stored: nothing to do');

 const manifest={project:'home-hub',title:'Hero',items:[{id:'hero',title:'Hero',kind:'image',variants:[{id:'a',media:[{sha256:sha(PNG),type:'image/png'}]}]},htmlItem()]};
 assert.equal((await h.post('/api/review/publish',manifest,auth(reader))).status,403);
 const pub=await h.post('/api/review/publish',manifest,auth(agent));assert.equal(pub.status,201);const set=await pub.json();assert.equal(set.id,'R-1');
 assert.equal((await h.post('/api/review/publish',{...manifest,title:'x'.repeat(161)},auth(agent))).status,400);
 assert.equal((await h.post('/api/review/publish',{...manifest,description:'x'.repeat(70000)},auth(agent))).status,413);

 const blob=await fetch(`${h.origin}/api/review/blobs/${sha(PNG)}`,{headers:h.admin});
 assert.equal(blob.status,200);assert.equal(blob.headers.get('content-type'),'image/png');assert.match(blob.headers.get('content-security-policy'),/^sandbox; default-src 'none'/);assert.equal(blob.headers.get('x-content-type-options'),'nosniff');
 const ranged=await fetch(`${h.origin}/api/review/blobs/${sha(PNG)}`,{headers:{...h.admin,Range:'bytes=0-7'}});assert.equal(ranged.status,206);assert.equal((await ranged.arrayBuffer()).byteLength,8);
 const full=await (await fetch(h.origin+'/api/review/sets/R-1',{headers:h.admin})).json();
 const frame=await fetch(h.origin+'/api/review/frame/'+full.rounds[0].items[1].variants[0].media[0].sha256,{headers:h.admin});
 const csp=frame.headers.get('content-security-policy');
 assert.equal(frame.status,200);assert.match(csp,/^sandbox allow-scripts;/);assert.ok(!csp.includes('allow-same-origin'));assert.match(csp,/default-src 'none'/);assert.match(csp,/frame-ancestors 'self'/);
 assert.equal(frame.headers.get('x-frame-options'),'SAMEORIGIN');assert.ok((await frame.text()).includes('hhReview'));
 assert.equal((await fetch(h.origin+'/api/review/frame/'+sha(PNG),{headers:h.admin})).status,404,'an image is never served as a frame');
 assert.equal((await fetch(h.origin+'/api/review/sets/R-1')).status,401);
 assert.equal((await fetch(h.origin+'/api/review/sets/R-99',{headers:h.admin})).status,404);

 // The owner decides in the browser (session + same origin); a read-only key cannot.
 const fb={set:'R-1',round:1,item:'login',rev:0,variant:'b',status:'revise',comments:[{variant:'b',anchor:{kind:'element',media:0,mockId:'cta',selector:'button',x:1,y:2,snippet:'<button>'},text:'bigger'}]};
 assert.equal((await h.post('/api/review/feedback',fb,auth(reader))).status,403);
 const saved=await h.post('/api/review/feedback',fb,h.admin);assert.equal(saved.status,200);assert.equal((await saved.json()).comments[0].by,'admin');
 assert.equal((await h.post('/api/review/feedback',fb,h.admin)).status,409);
 // Only the author edits or deletes a comment: the agent's key is refused with 403, the owner's edit keeps the id.
 const cid=(await (await fetch(h.origin+'/api/review/sets/R-1',{headers:h.admin})).json()).rounds[0].feedback.login.comments[0].id;
 const foreign=await h.post('/api/review/feedback',{...fb,rev:1,comments:[],deleteComments:[cid]},auth(agent));assert.equal(foreign.status,403);assert.equal((await foreign.json()).error.message,'Only the author of a comment can edit or delete it.');
 const edited=await (await h.post('/api/review/feedback',{...fb,rev:1,comments:[],editComments:[{id:cid,text:'much bigger'}]},h.admin)).json();
 assert.equal(edited.comments[0].id,cid);assert.equal(edited.comments[0].text,'much bigger');assert.ok(edited.comments[0].editedAt);
 assert.equal((await (await fetch(h.origin+'/api/review?feedback=pending',{headers:h.admin})).json()).sets.length,1);

 // MCP: list what waits, read the decision with its anchor, publish the next round inline.
 const rpc=async(a,name,args)=>(await (await fetch(h.origin+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',...auth(a)},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})})).json()).result;
 const waiting=await rpc(reader,'review_list',{feedbackPending:true});assert.equal(waiting.structuredContent.sets[0].id,'R-1');
 const got=(await rpc(reader,'review_get',{id:'R-1'})).structuredContent;
 const login=got.round.items.find(i=>i.id==='login');assert.equal(login.decision.variant,'b');assert.equal(login.decision.comments[0].anchor.mockId,'cta');assert.match(login.variants[0].media[0].url,/^\/api\/review\/blobs\/[a-f0-9]{64}$/);
 assert.equal((await rpc(reader,'review_publish',{set:'R-1',items:[htmlItem()]})).isError,true);
 const next=await rpc(agent,'review_publish',{set:'R-1',notes:'bigger CTA',addresses:[login.decision.comments[0].id],items:[htmlItem('login',['b'])]});
 assert.equal(next.isError,false);assert.equal(next.structuredContent.round.n,2);
 const r2=(await rpc(reader,'review_get',{id:'R-1'})).structuredContent;assert.equal(r2.round.n,2);assert.deepEqual(r2.unaddressed,[]);
 const r1=(await rpc(reader,'review_get',{id:'R-1',round:1})).structuredContent;assert.equal(r1.round.items.find(i=>i.id==='login').decision.comments[0].addressed,true);
 assert.equal((await rpc(agent,'review_publish',{project:'home-hub',title:'x',items:[{id:'i',title:'t',kind:'image',variants:[{id:'a',media:[{type:'image/png',sha256:'e'.repeat(64)}]}]}]})).isError,true);
 const audit=JSON.stringify(await (await fetch(h.origin+'/api/admin/audit',{headers:h.admin})).json());assert.ok(audit.includes('review_publish'));assert.ok(!audit.includes('bigger CTA'),'bodies are never logged');

 // The push script: files → sha256 → chunked upload (skipping known blobs) against the same hub.
 const work=await mkdtemp(path.join(os.tmpdir(),'review-push-'));t.after(()=>rm(work,{recursive:true,force:true}));
 const big=Buffer.concat([PNG,Buffer.alloc(5*1024*1024,7)]);await writeFile(path.join(work,'big.png'),big);await writeFile(path.join(work,'a.html'),HTML);
 const {manifest:m2,files}=await resolveManifest({project:'home-hub',title:'Pushed',items:[{id:'shot',title:'Shot',kind:'image',variants:[{id:'a',media:[{file:'big.png'}]}]},{id:'page',title:'Page',kind:'html',variants:[{id:'a',media:[{file:'a.html',viewport:{width:390,height:844}}]}]}]},work);
 assert.equal(m2.items[0].variants[0].media[0].type,'image/png');assert.equal(m2.items[1].variants[0].media[0].name,'a.html');assert.equal(files.size,2);
 const results=[];for(const [s,f] of files)results.push(await upload(h.origin,agent.token,s,f));assert.deepEqual(results,['uploaded','uploaded']);
 assert.equal(await upload(h.origin,agent.token,sha(big),files.get(sha(big))),'skipped');
 const pushed=await h.post('/api/review/publish',m2,auth(agent));assert.equal(pushed.status,201);
 const served=await fetch(`${h.origin}/api/review/blobs/${sha(big)}`,{headers:h.admin});assert.equal(Buffer.from(await served.arrayBuffer()).equals(big),true);
});

test('projects carry a type: app, game or other',async t=>{
 const {tickets}=await stores(t);
 const all=await tickets.list();assert.deepEqual(all.projects.map(p=>[p.id,p.type]),[['home-hub','app'],['sample-game','game']]);
 const p=await tickets.saveProject({id:'ob1',key:'OB',name:'OB1',type:'other'},'a');assert.equal(p.type,'other');
 assert.equal((await tickets.saveProject({id:'ob1',rev:1,type:null},'a')).type,null);
 await assert.rejects(tickets.saveProject({id:'ob1',rev:2,type:'web'},'a'),/invalid/);
 assert.equal((await tickets.saveProject({id:'x2',key:'XX',name:'No type'},'a')).type,null);
});

test('review store: done when every item is taken, rework with screenshots and links',async t=>{
 const {r}=await stores(t);
 await r.publish({project:'home-hub',title:'Two',items:[htmlItem('one'),htmlItem('two')]},'claude');
 const ids=async status=>(await r.list({status})).sets.map(s=>s.id);
 assert.deepEqual(await ids('active'),['R-1']);assert.deepEqual(await ids('done'),[]);assert.deepEqual(await ids('open'),['R-1'],'open still means not archived');
 await r.feedback({set:'R-1',round:1,item:'one',rev:0,variant:'a',status:'accept'},'x');
 assert.deepEqual(await ids('done'),[]);
 // A rework explained only by a screenshot is a valid reject, and a rejected item keeps the set active.
 const SHOT=Buffer.concat([PNG,Buffer.from('shot')]);
 await assert.rejects(r.feedback({set:'R-1',round:1,item:'two',rev:0,variant:null,status:'reject',attachments:[{sha256:sha(SHOT),type:'image/png'}]},'x'),/missing-blob/);
 await put(r,SHOT);
 await assert.rejects(r.feedback({set:'R-1',round:1,item:'two',rev:0,variant:null,status:'reject',attachments:[{sha256:sha(SHOT),type:'image/jpeg'}]},'x'),/invalid/,'magic must match');
 await assert.rejects(r.feedback({set:'R-1',round:1,item:'two',rev:0,variant:null,status:'reject',attachments:[{sha256:sha(SHOT),type:'text/html'}]},'x'),/invalid/);
 const rej=await r.feedback({set:'R-1',round:1,item:'two',rev:0,variant:null,status:'reject',attachments:[{sha256:sha(SHOT),type:'image/png',name:'shot.png'}]},'x');
 assert.deepEqual(rej.attachments,[{sha256:sha(SHOT),type:'image/png',size:SHOT.length,name:'shot.png'}]);
 assert.equal((await r.media(sha(SHOT))).type,'image/png','a referenced screenshot is served');
 assert.deepEqual(await ids('active'),['R-1']);
 // Omitting attachments keeps them; taking a variant makes the set done.
 const taken=await r.feedback({set:'R-1',round:1,item:'two',rev:1,variant:'b',status:'revise',note:'see https://example.com/x'},'x');
 assert.equal(taken.attachments.length,1);
 assert.deepEqual(await ids('done'),['R-1']);assert.deepEqual(await ids('active'),[]);
 assert.equal((await r.list({status:'done'})).sets[0].done,true);assert.equal((await r.get('R-1')).done,true);
 assert.equal((await r.feedback({set:'R-1',round:1,item:'two',rev:2,variant:'b',status:'revise',attachments:[]},'x')).attachments.length,0);
});

test('review store: aligned marks an image item whose variants are one shot (opened in the swipe view)',async t=>{
 const {r}=await stores(t);await put(r,PNG);
 const img=(id,extra={})=>({id,title:'Unit',kind:'image',...extra,variants:['a','b'].map(v=>({id:v,media:[{sha256:sha(PNG),type:'image/png'}]}))});
 await r.publish({project:'sample-game',title:'Before/after',items:[img('shot',{aligned:true}),img('sheet'),img('off',{aligned:false})]},'claude');
 const it=(await r.get('R-1')).rounds[0].items;
 assert.equal(it[0].aligned,true);assert.equal('aligned'in it[1],false);assert.equal('aligned'in it[2],false,'false is not stored');
 await assert.rejects(r.publish({project:'sample-game',title:'x',items:[{...htmlItem(),aligned:true}]},'c'),/invalid/,'only image and video items');
 await assert.rejects(r.publish({project:'sample-game',title:'x',items:[img('s',{aligned:'yes'})]},'c'),/invalid/);
});

test('review store: video items take mp4 and webm, a poster, aligned, and comments pinned to a time',async t=>{
 const {r}=await stores(t);
 const MP4=Buffer.concat([Buffer.from([0,0,0,0x18]),Buffer.from('ftypisom'),Buffer.alloc(12)]),WEBM=Buffer.concat([Buffer.from([0x1a,0x45,0xdf,0xa3]),Buffer.alloc(16)]);
 for(const b of [MP4,WEBM,PNG])await put(r,b);
 const clip=(id,extra={})=>({id,title:'Explosion',kind:'video',...extra,variants:[{id:'a',label:'Before',media:[{sha256:sha(MP4),type:'video/mp4',poster:{sha256:sha(PNG),type:'image/png'}}]},{id:'b',label:'After',media:[{sha256:sha(WEBM),type:'video/webm'}]}]});
 const set=await r.publish({project:'sample-game',title:'Rocket fix',items:[clip('boom',{aligned:true})]},'claude');
 assert.deepEqual(set.round.kinds,['video']);assert.equal(set.cover.sha256,sha(PNG),'the poster is the card cover');
 const it=(await r.get('R-1')).rounds[0].items[0];assert.equal(it.kind,'video');assert.equal(it.aligned,true);assert.equal(it.variants[0].media[0].poster.sha256,sha(PNG));
 // The declared type must match the file: a PNG is not a clip, an mp4 is not a webm.
 await assert.rejects(r.publish({project:'sample-game',title:'x',items:[{id:'v',title:'v',kind:'video',variants:[{id:'a',media:[{sha256:sha(PNG),type:'video/mp4'}]}]}]},'c'),/invalid/);
 await assert.rejects(r.publish({project:'sample-game',title:'x',items:[{id:'v',title:'v',kind:'video',variants:[{id:'a',media:[{sha256:sha(MP4),type:'video/webm'}]}]}]},'c'),/invalid/);
 await assert.rejects(r.publish({project:'sample-game',title:'x',items:[{id:'v',title:'v',kind:'image',variants:[{id:'a',media:[{sha256:sha(MP4),type:'video/mp4'}]}]}]},'c'),/invalid/,'a clip is not an image');
 // A comment on a clip: the time and the point; a point anchor alone is not enough.
 const d=await r.feedback({set:'R-1',round:1,item:'boom',rev:0,variant:'b',status:'revise',comments:[{variant:'b',anchor:{kind:'frame',t:0.4567,x:0.5,y:0.25},text:'fireball too small'}]},'alice');
 assert.deepEqual(d.comments[0].anchor,{kind:'frame',media:0,t:0.457,x:0.5,y:0.25});
 await assert.rejects(r.feedback({set:'R-1',round:1,item:'boom',rev:d.rev,variant:'b',status:'revise',comments:[{variant:'b',anchor:{kind:'point',x:0.5,y:0.5},text:'x'}]},'alice'),/invalid/);
 await assert.rejects(r.feedback({set:'R-1',round:1,item:'boom',rev:d.rev,variant:'b',status:'revise',comments:[{variant:'b',anchor:{kind:'frame',t:-1,x:0.5,y:0.5},text:'x'}]},'alice'),/invalid/);
});

test('review store: audio items take mp3, wav, ogg, flac and m4a, and comments pinned to a moment',async t=>{
 const {r}=await stores(t);
 const MP3=Buffer.concat([Buffer.from('ID3'),Buffer.alloc(13)]),RAW_MP3=Buffer.concat([Buffer.from([0xff,0xfb,0x90,0x64]),Buffer.alloc(12)]);
 const WAV=Buffer.concat([Buffer.from('RIFF'),Buffer.alloc(4),Buffer.from('WAVE'),Buffer.alloc(8)]),OGG=Buffer.concat([Buffer.from('OggS'),Buffer.alloc(12)]);
 const FLAC=Buffer.concat([Buffer.from('fLaC'),Buffer.alloc(12)]),M4A=Buffer.concat([Buffer.from([0,0,0,0x18]),Buffer.from('ftypM4A '),Buffer.alloc(8)]);
 const files=[[MP3,'audio/mpeg'],[RAW_MP3,'audio/mpeg'],[WAV,'audio/wav'],[OGG,'audio/ogg'],[FLAC,'audio/flac'],[M4A,'audio/mp4']];
 for(const [b] of files)await put(r,b);await put(r,PNG);
 const items=files.map(([b,type],i)=>({id:'t'+i,title:'Track',kind:'audio',variants:[{id:'a',media:[{sha256:sha(b),type}]},{id:'b',media:[{sha256:sha(b),type}]}]}));
 const set=await r.publish({project:'sample-game',title:'Music',items},'claude');assert.deepEqual(set.round.kinds,['audio']);
 // The declared type must match the file; a picture is not a track; audio is never aligned (nothing to swipe).
 await assert.rejects(r.publish({project:'sample-game',title:'x',items:[{id:'a',title:'a',kind:'audio',variants:[{id:'a',media:[{sha256:sha(PNG),type:'audio/mpeg'}]}]}]},'c'),/invalid/);
 await assert.rejects(r.publish({project:'sample-game',title:'x',items:[{id:'a',title:'a',kind:'audio',variants:[{id:'a',media:[{sha256:sha(WAV),type:'audio/ogg'}]}]}]},'c'),/invalid/);
 await assert.rejects(r.publish({project:'sample-game',title:'x',items:[{...items[0],aligned:true}]},'c'),/invalid/);
 const d=await r.feedback({set:'R-1',round:1,item:'t0',rev:0,variant:'b',status:'revise',comments:[{variant:'b',anchor:{kind:'time',t:12.3456},text:'drop comes too late'}]},'alice');
 assert.deepEqual(d.comments[0].anchor,{kind:'time',media:0,t:12.346});
 await assert.rejects(r.feedback({set:'R-1',round:1,item:'t0',rev:d.rev,variant:'b',status:'revise',comments:[{variant:'b',anchor:{kind:'frame',t:1,x:0,y:0},text:'x'}]},'alice'),/invalid/);
});

test('review store: approve items judge each deliverable; reference variants are never taken',async t=>{
 const {r}=await stores(t);
 const item={...htmlItem('clips',['a','b','c']),mode:'approve'};item.variants[0].reference=true;
 await r.publish({project:'home-hub',title:'Phase 1',items:[item,{...htmlItem('pick',['a','b']),variants:[{...htmlItem().variants[0],reference:true},htmlItem().variants[1]]}]},'claude');
 const full=await r.get('R-1'),it=full.rounds[0].items;assert.equal(it[0].mode,'approve');assert.equal(it[1].mode,'choose');assert.equal(it[0].variants[0].reference,true);
 await assert.rejects(r.publish({project:'home-hub',title:'x',items:[{...htmlItem(),mode:'vote'}]},'c'),/invalid/);
 await assert.rejects(r.publish({project:'home-hub',title:'x',items:[{...htmlItem('o',['a']),variants:[{...htmlItem().variants[0],reference:true}]}]},'c'),/invalid/,'something must be decidable');
 // approve: no chosen variant, verdicts only for non-reference variants; the status follows them.
 const base={set:'R-1',round:1,item:'clips'};
 await assert.rejects(r.feedback({...base,rev:0,variant:'b',status:'accept'},'x'),/invalid/);
 await assert.rejects(r.feedback({...base,rev:0,status:'accept',approvals:{a:'approved'}},'x'),/invalid/,'reference cannot be approved');
 await assert.rejects(r.feedback({...base,rev:0,status:'accept',approvals:{b:'maybe'}},'x'),/invalid/);
 const one=await r.feedback({...base,rev:0,status:'accept',approvals:{b:'approved'}},'x');assert.equal(one.status,'pending','one of two is not done');
 const fix=await r.feedback({...base,rev:1,status:'pending',approvals:{b:'approved',c:'changes'},comments:[{variant:'c',anchor:null,text:'tighter loop'},{variant:'a',anchor:null,text:'reference is fine to comment'}]},'x');
 assert.equal(fix.status,'revise');assert.equal(fix.comments.length,2);
 const all=await r.feedback({...base,rev:2,status:'pending',approvals:{b:'approved',c:'approved'}},'x');assert.equal(all.status,'accept');
 // choose items cannot take approvals, nor a reference variant.
 await assert.rejects(r.feedback({set:'R-1',round:1,item:'pick',rev:0,variant:'b',status:'accept',approvals:{}},'x'),/invalid/);
 await assert.rejects(r.feedback({set:'R-1',round:1,item:'pick',rev:0,variant:'a',status:'accept'},'x'),/invalid/);
 await r.feedback({set:'R-1',round:1,item:'pick',rev:0,variant:'b',status:'accept'},'x');
 assert.equal((await r.list({status:'done'})).sets.length,1);
});

test('review store: a comment carries its own screenshots, and may be only a screenshot',async t=>{
 const {r}=await stores(t);await r.publish({project:'home-hub',title:'Shots',items:[htmlItem()]},'claude');
 const SHOT=Buffer.concat([PNG,Buffer.from('comment shot')]),shot={sha256:sha(SHOT),type:'image/png',name:'clip.png'};
 await assert.rejects(r.feedback({set:'R-1',round:1,item:'login',rev:0,variant:'a',status:'revise',comments:[{variant:'a',anchor:null,text:'see',attachments:[shot]}]},'x'),/missing-blob/);
 await put(r,SHOT);
 await assert.rejects(r.feedback({set:'R-1',round:1,item:'login',rev:0,variant:'a',status:'revise',comments:[{variant:'a',anchor:null,text:''}]},'x'),/invalid/,'empty comment without a screenshot');
 const d=await r.feedback({set:'R-1',round:1,item:'login',rev:0,variant:'a',status:'revise',comments:[{variant:'a',anchor:null,text:'',attachments:[shot]},{variant:'b',anchor:null,text:'plain'}]},'x');
 assert.deepEqual(d.comments[0].attachments,[{...shot,size:SHOT.length}]);assert.equal(d.comments[0].text,'');assert.equal('attachments'in d.comments[1],false);
 assert.equal((await r.media(sha(SHOT))).type,'image/png','a comment screenshot is served');
});
