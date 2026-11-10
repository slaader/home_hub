// Review phase 2: 3D models (.glb) — upload checks, posters, surface anchors, the page CSP for <model-viewer>,
// MCP and the push script. Plus the ticket page's path back (tracker-view.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {Readable} from 'node:stream';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {createReviewStore,LIMITS} from '../server/review-store.mjs';
import {createTicketStore as createStore} from '../server/tickets-store.mjs';
// The tracker seeds nothing by itself; these tests start with the two projects a site would configure.
const SEED=[{id:'home-hub',key:'HH',name:'Home Hub',type:'app'},{id:'sample-game',key:'GAME',name:'Sample Game',type:'game'}];
const createTicketStore=(root,options={})=>createStore(root,{seedProjects:SEED,...options});
import {resolveManifest,upload} from '../scripts/review-push.mjs';
import {MODEL_VIEWER_STYLE_HASH,PAGE_CSP} from '../server/index.mjs';
import {hub} from './hub-helper.mjs';

const sha=b=>createHash('sha256').update(b).digest('hex');
const PNG=Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),Buffer.from('poster pixels')]);
// A minimal binary glTF: 12-byte header (magic, version, total length) and one JSON chunk.
function glb(json={asset:{version:'2.0'},scenes:[{nodes:[0]}],nodes:[{name:'Turret'}]},{version=2,length}={}){
 let text=JSON.stringify(json);while(text.length%4)text+=' ';
 const chunk=Buffer.alloc(8);chunk.writeUInt32LE(text.length,0);chunk.write('JSON',4,'latin1');
 const head=Buffer.alloc(12);head.write('glTF',0,'latin1');head.writeUInt32LE(version,4);head.writeUInt32LE(length??12+8+text.length,8);
 return Buffer.concat([head,chunk,Buffer.from(text)]);
}
const body=b=>Readable.from([b]);
async function stores(t){
 const dir=await mkdtemp(path.join(os.tmpdir(),'review3d-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const tickets=createTicketStore(path.join(dir,'tickets'));return {dir,tickets,r:createReviewStore(path.join(dir,'review'),{tickets})};
}
const put=(r,buf)=>r.putChunk(sha(buf),{offset:0,size:buf.length},body(buf));
const modelItem=(a,poster)=>({id:'harvester',title:'Harvester',kind:'model',variants:[{id:'a',media:[{sha256:sha(a),type:'model/gltf-binary',...(poster?{poster:{sha256:sha(poster),type:'image/png'}}:{})}]},
 {id:'b',media:[{sha256:sha(a),type:'model/gltf-binary'}]}]});
const anchor={kind:'surface',media:0,position:{x:0.123456789,y:1.5,z:-2},normal:{x:0,y:1,z:0},camera:{theta:0.785398,phi:1.2,radius:4.5,target:{x:0,y:0.5,z:0},fov:30},
 node:'Scene / Harvester / Turret',mesh:'Turret',material:'Paint',surface:'0 0 1 2 3 0.2 0.3 0.5',animation:{name:'Fire',time:1.25}};

test('3D models: glb header and length, poster as cover, size limit, surface anchors',async t=>{
 const {r}=await stores(t),model=glb();
 await put(r,model);await put(r,PNG);
 const set=await r.publish({project:'sample-game',title:'Harvester',items:[modelItem(model,PNG)]},'claude');
 assert.deepEqual(set.round.kinds,['model']);assert.deepEqual(set.cover,{sha256:sha(PNG),type:'image/png'},'the poster is the card cover');
 const media=(await r.get(set.id)).rounds[0].items[0].variants[0].media[0];
 assert.equal(media.type,'model/gltf-binary');assert.equal(media.size,model.length);assert.deepEqual(media.poster,{sha256:sha(PNG),type:'image/png',size:PNG.length});
 assert.equal((await r.media(sha(PNG))).type,'image/png','the poster is served');assert.equal((await r.media(sha(model))).type,'model/gltf-binary');
 await assert.rejects(r.frame(sha(model)),/not-found/,'a model is never a frame');

 // Not a GLB: wrong magic, glTF 1, a header length that is not the file size; the wrong kind for the type.
 const v1=glb(undefined,{version:1}),short=glb(undefined,{length:999}),fake=Buffer.from('glTF but not really a model');
 for(const b of [v1,short,fake])await put(r,b);
 for(const b of [v1,short,fake,PNG])await assert.rejects(r.publish({project:'sample-game',title:'x',items:[{...modelItem(b),variants:[{id:'a',media:[{sha256:sha(b),type:'model/gltf-binary'}]}]}]},'c'),/invalid/);
 await assert.rejects(r.publish({project:'sample-game',title:'x',items:[{id:'i',title:'t',kind:'image',variants:[{id:'a',media:[{sha256:sha(model),type:'model/gltf-binary'}]}]}]},'c'),/invalid/);
 // A poster only on models, only png/jpeg/webp, and it must look like one.
 await assert.rejects(r.publish({project:'sample-game',title:'x',items:[{id:'i',title:'t',kind:'image',variants:[{id:'a',media:[{sha256:sha(PNG),type:'image/png',poster:{sha256:sha(PNG),type:'image/png'}}]}]}]},'c'),/invalid/);
 await assert.rejects(r.publish({project:'sample-game',title:'x',items:[{...modelItem(model),variants:[{id:'a',media:[{sha256:sha(model),type:'model/gltf-binary',poster:{sha256:sha(PNG),type:'image/gif'}}]}]}]},'c'),/invalid/);
 await assert.rejects(r.publish({project:'sample-game',title:'x',items:[{...modelItem(model),variants:[{id:'a',media:[{sha256:sha(model),type:'model/gltf-binary',poster:{sha256:sha(model),type:'image/png'}}]}]}]},'c'),/invalid/);
 await assert.rejects(r.publish({project:'sample-game',title:'x',items:[{...modelItem(model),variants:[{id:'a',media:[{sha256:sha(model),type:'model/gltf-binary',poster:{sha256:'f'.repeat(64),type:'image/png'}}]}]}]},'c'),/missing-blob/);
 assert.equal(LIMITS.model,128*1024*1024);

 // Surface anchors: rounded, validated, only on models.
 const d=await r.feedback({set:set.id,round:1,item:'harvester',rev:0,variant:'a',status:'revise',comments:[{variant:'a',anchor,text:'smaller turret'}]},'alice');
 const a=d.comments[0].anchor;assert.equal(a.position.x,0.12346);assert.equal(a.node,'Scene / Harvester / Turret');assert.deepEqual(a.camera.target,{x:0,y:0.5,z:0});assert.deepEqual(a.animation,{name:'Fire',time:1.25});
 const minimal={kind:'surface',position:{x:0,y:0,z:0},normal:{x:0,y:0,z:1},camera:{theta:0,phi:1,radius:2,target:{x:0,y:0,z:0},fov:45}};
 const d2=await r.feedback({set:set.id,round:1,item:'harvester',rev:1,variant:'a',status:'revise',comments:[{variant:'b',anchor:minimal,text:'ok'}]},'alice');
 assert.deepEqual(d2.comments[1].anchor,{...minimal,media:0,node:'',mesh:'',material:'',surface:null,animation:null});
 const bad=[{...anchor,kind:'point'},{...anchor,position:{x:0,y:0}},{...anchor,position:{x:'1',y:0,z:0}},{...anchor,camera:{...anchor.camera,fov:undefined}},{...anchor,camera:{...anchor.camera,radius:-1}},
  {...anchor,surface:'<script>'},{...anchor,animation:{name:'',time:1}},{...anchor,extra:1},{...anchor,media:3},{kind:'point',x:0.5,y:0.5}];
 for(const b of bad)await assert.rejects(r.feedback({set:set.id,round:1,item:'harvester',rev:2,variant:'a',status:'revise',comments:[{variant:'a',anchor:b,text:'x'}]},'x'),/invalid/,JSON.stringify(b));
});

test('3D models over HTTP: page CSP for model-viewer, vendored file, MCP anchor, push script with poster',async t=>{
 // The CSP allows exactly model-viewer's shadow-DOM style block by hash, plus blob: textures — and nothing inline.
 const vendored=await readFile(new URL('../public/vendor/model-viewer.min.js',import.meta.url),'utf8');
 const style=/<style>([\s\S]*?)<\/style>/.exec(vendored)[1];
 assert.equal(MODEL_VIEWER_STYLE_HASH,`'sha256-${createHash('sha256').update(style).digest('base64')}'`);
 assert.ok(!/https?:\/\//.test(PAGE_CSP)&&!PAGE_CSP.includes('unsafe'),PAGE_CSP);assert.match(PAGE_CSP,/script-src 'self';/);
 assert.ok(!vendored.includes('sourceMappingURL'),'no map file is served');
 const h=await hub(t),agent=await h.account('review-agent',['review:write']),reader=await h.account('reader',[]);
 const page=await fetch(h.origin+'/');assert.equal(page.headers.get('content-security-policy'),PAGE_CSP);
 assert.match(PAGE_CSP,/style-src 'self' 'sha256-[A-Za-z0-9+/]+=*';/);assert.match(PAGE_CSP,/img-src 'self' blob:;/);assert.match(PAGE_CSP,/connect-src 'self' blob:;/);
 const mv=await fetch(h.origin+'/vendor/model-viewer.min.js');assert.equal(mv.status,200);assert.match(mv.headers.get('content-type'),/^text\/javascript/);

 const work=await mkdtemp(path.join(os.tmpdir(),'review3d-push-'));t.after(()=>rm(work,{recursive:true,force:true}));
 const model=glb();await writeFile(path.join(work,'unit-a.glb'),model);await writeFile(path.join(work,'unit-a.png'),PNG);
 const {manifest,files}=await resolveManifest({project:'sample-game',title:'Unit',items:[{id:'unit',title:'Unit',kind:'model',variants:[{id:'a',media:[{file:'unit-a.glb',poster:'unit-a.png'}]}]}]},work);
 const m=manifest.items[0].variants[0].media[0];assert.equal(m.type,'model/gltf-binary');assert.deepEqual(m.poster,{sha256:sha(PNG),type:'image/png'});assert.equal(files.size,2);
 await assert.rejects(resolveManifest({items:[{variants:[{media:[{file:'unit-a.glb',poster:'unit-a.glb'}]}]}]},work),/poster must be/);
 for(const [s,f] of files)await upload(h.origin,agent.token,s,f);
 const pub=await h.post('/api/review/publish',manifest,agent.headers);assert.equal(pub.status,201);const set=await pub.json();
 const served=await fetch(`${h.origin}/api/review/blobs/${sha(model)}`,{headers:h.admin});assert.equal(served.headers.get('content-type'),'model/gltf-binary');assert.match(served.headers.get('content-security-policy'),/^sandbox;/);
 assert.equal((await h.post('/api/review/feedback',{set:set.id,round:1,item:'unit',rev:0,variant:'a',status:'revise',comments:[{variant:'a',anchor,text:'smaller turret'}]},h.admin)).status,200);

 const rpc=async(a,name,args)=>(await (await fetch(h.origin+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',...a.headers},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})})).json()).result;
 const got=(await rpc(reader,'review_get',{id:set.id})).structuredContent.round.items[0];
 assert.equal(got.kind,'model');assert.match(got.variants[0].media[0].poster.url,/^\/api\/review\/blobs\/[a-f0-9]{64}$/);
 const c=got.decision.comments[0].anchor;assert.equal(c.kind,'surface');assert.equal(c.mesh,'Turret');assert.equal(c.camera.radius,4.5);assert.deepEqual(c.normal,{x:0,y:1,z:0});
 const tools=(await (await fetch(h.origin+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',...agent.headers},body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list'})})).json()).result.tools;
 const publish=tools.find(x=>x.name==='review_publish');assert.ok(publish.inputSchema.properties.items.items.properties.kind.enum.includes('model'));assert.match(publish.description,/gltf-binary/);
});

test('ticket page: the path back leads where the ticket was opened from',async()=>{
 const {ticketOrigin}=await import('../public/tracker-view.js');
 assert.equal(ticketOrigin('#projects/home-hub','#items/HH-2',''),'#projects/home-hub');
 assert.equal(ticketOrigin('#items/HH-2','#items/HH-3','#projects/home-hub'),'#projects/home-hub','ticket to ticket keeps the origin');
 assert.equal(ticketOrigin('#review/R-1','#items/HH-2','#items'),'#review/R-1');
 assert.equal(ticketOrigin('#items','#items/HH-2','#projects/home-hub'),'#items');
 assert.equal(ticketOrigin('#home','#items/HH-2','#projects/x'),'','anything else falls back to the list');
 assert.equal(ticketOrigin('#items/HH-2','#projects','#review/R-1'),'#review/R-1','leaving a ticket changes nothing');
});

test('ticket page: a ticket chain across projects still leads back to the project it started from',async()=>{
 // A minimal DOM for el(): enough to read tags, attributes and text.
 class FakeNode{constructor(tag,text){this.tag=tag;this.text=text;this.attrs={};this.children=[];}setAttribute(k,v){this.attrs[k]=String(v);}addEventListener(){}append(...c){this.children.push(...c);}
  get textContent(){return this.text??this.children.map(c=>c.textContent).join('');}}
 const before=[globalThis.document,globalThis.Node];globalThis.Node=FakeNode;globalThis.document={createElement:tag=>new FakeNode(tag),createTextNode:t=>new FakeNode('#text',t)};
 try{
  const {backPath}=await import('../public/tracker-view.js');
  const projects=[{id:'home-hub',name:'Home Hub'},{id:'sample-game',name:'Sample Game'}],dune={id:'GAME-7',project:'sample-game'};
  const nav=backPath(dune,projects,'#projects/home-hub'),link=nav.children.filter(c=>c.tag==='a')[1];
  assert.equal(link.attrs.href,'#projects/home-hub');assert.equal(link.textContent,'Home Hub');assert.equal(nav.textContent,'Projekty/Home Hub/GAME-7');
  assert.equal(backPath(dune,projects,'#projects').children.filter(c=>c.tag==='a')[1].attrs.href,'#projects/sample-game','from the overview: the ticket\'s own project');
  assert.equal(backPath(dune,projects,'#review/R-4').attrs.href,'#review/R-4');assert.equal(backPath(dune,projects,'').attrs.href,'#items');
 }finally{[globalThis.document,globalThis.Node]=before;}
});
