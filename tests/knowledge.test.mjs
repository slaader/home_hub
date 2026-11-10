import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {validate,walk,find,load,validStore} from '../scripts/check-knowledge.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const base=()=>({schema:1,updated_at:'2026-11-01',entries:[
 {id:'mini',kind:'machine',name:'Mac mini',verified_at:'2026-11-01'},
 {id:'gw',kind:'runtime',machine:'mini',name:'Gateway',address:':8790',verified_at:'2026-11-01',secrets:[{what:'Voice token',store:'keychain:mini',ref:'local-ai.gateway.voice-token',check:'security find-generic-password -s local-ai.gateway.voice-token'}],depends_on:[{id:'sync',kind:'cert'}]},
 {id:'sync',kind:'tool',machine:'mini',name:'Cert sync',verified_at:'2026-11-01'},
 {id:'app',kind:'tool',machine:'mini',name:'Client',verified_at:'2026-11-01',depends_on:[{id:'gw',kind:'call'}]}]});
test('a well-formed document passes and walks both directions',()=>{
 const doc=base();
 assert.deepEqual(validate(doc).errors,[]);
 assert.deepEqual(walk(doc,'app',true).map(x=>x.id),['gw','mini','sync']);
 assert.deepEqual(walk(doc,'mini',false).map(x=>x.id),['gw','sync','app']);
 assert.deepEqual(walk(doc,'sync',false).map(x=>x.id),['gw','app']);
 assert.deepEqual(find(doc,'voice-token').map(e=>e.id),['gw']);
});
test('secret values are rejected wherever they appear',()=>{
 for(const value of ['password=hunter2hunter2','sk-abcdefghijklmnopqrstuv','https://admin:pa55word@host/','-----BEGIN OPENSSH PRIVATE KEY-----','Zx8kQ2mN7pL4vR9tY3wB6cF1hJ5sD0gAeT']){
  const doc=base();doc.entries[1].login=value;
  assert.ok(validate(doc).errors.some(e=>e.includes('looks like a secret value')),value);
 }
});
test('check commands that print a secret are rejected',()=>{
 for(const check of ['security find-generic-password -s x -w','cat ~/.codex/auth.json','printenv CF_TOKEN','echo $CF_TOKEN']){
  const doc=base();doc.entries[1].secrets[0].check=check;
  assert.ok(validate(doc).errors.some(e=>e.includes('check for')),check);
 }
});
test('broken references, kinds and stores are reported',()=>{
 const doc=base();
 doc.entries[1].depends_on.push({id:'ghost',kind:'call'});
 doc.entries[2].machine='nowhere';
 doc.entries[3].kind='service';
 doc.entries[1].secrets[0].store='drawer';
 doc.entries[2].category='gadget';
 const {errors}=validate(doc);
 assert.ok(errors.some(e=>e.includes('"ghost" does not exist')));
 assert.ok(errors.some(e=>e.includes('machine must name a machine')));
 assert.ok(errors.some(e=>e.includes('kind must be one of')));
 assert.ok(errors.some(e=>e.includes('unknown store "drawer"')));
 assert.ok(errors.some(e=>e.includes('category must be one of')));
 assert.ok(validStore('app-env:home-caddy')&&validStore('unknown')&&validStore('remembered')&&validStore('sso:google')&&!validStore('keychain:'));
});
test('the inventory API needs a session and serves only a valid file',async()=>{
 const http=(await import('node:http')).default,{mkdtemp,writeFile,copyFile}=await import('node:fs/promises'),os=(await import('node:os')).default;
 const {hashPassword}=await import('../server/auth.mjs'),{createHandler}=await import('../server/index.mjs');
 const dir=await mkdtemp(path.join(os.tmpdir(),'hub-inv-'));await writeFile(path.join(dir,'inventory.json'),JSON.stringify({devices:[]}));
 const credentials={username:'admin',...hashPassword('test-only-password')},origin='http://127.0.0.1:8892';
 const server=http.createServer(createHandler({directory:dir,credentials,origin,secure:false,stateDirectory:dir}));await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`;
 try{
  assert.equal((await fetch(`${url}/api/inventory`)).status,401);
  const login=await fetch(`${url}/api/session`,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify({username:'admin',password:'test-only-password'})});const Cookie=login.headers.get('set-cookie');
  assert.equal((await fetch(`${url}/api/inventory`,{headers:{Cookie}})).status,404);
  await writeFile(path.join(dir,'knowledge.json'),JSON.stringify(base()));
  const ok=await fetch(`${url}/api/inventory`,{headers:{Cookie}});assert.equal(ok.status,200);const body=await ok.json();assert.equal(body.doc.entries.length,4);assert.ok(Array.isArray(body.gaps));
  const bad=base();bad.entries[1].login='password=hunter2hunter2';await writeFile(path.join(dir,'knowledge.json'),JSON.stringify(bad));
  assert.equal((await fetch(`${url}/api/inventory`,{headers:{Cookie}})).status,500);
  assert.equal((await fetch(`${url}/inventory-view.js`)).status,200);
 }finally{server.handler?.poller?.stop?.();server.close();}
});
test('entry edits check the version stamp, drop emptied fields and reject unknown fields',async()=>{
 const {applyEdit,editInput,entryHash,createKnowledgeEditor}=await import('../scripts/knowledge-edit.mjs');
 const doc=base(),gw=doc.entries[1];
 const edit=editInput({id:'gw',base:entryHash(gw),fields:{address:'',login:'Bearer token',secrets:[{what:'Voice token',store:'keychain:mini',ref:'local-ai.gateway.voice-token',check:''}]}});
 const {doc:next,entry}=applyEdit(doc,edit,'2026-11-02');
 assert.equal(entry.address,undefined);assert.equal(entry.login,'Bearer token');assert.equal(entry.secrets[0].check,undefined);
 assert.equal(entry.verified_by,'user edit in Home Hub');assert.equal(next.updated_at,'2026-11-02');
 assert.throws(()=>applyEdit(next,edit),/conflict/);
 assert.throws(()=>editInput({id:'gw',base:entryHash(gw),fields:{depends_on:[]}}),/invalid/);
 assert.throws(()=>editInput({id:'../x',base:entryHash(gw),fields:{}}),/invalid/);
 const {mkdtemp,writeFile,readFile}=await import('node:fs/promises'),os=(await import('node:os')).default;
 const dir=await mkdtemp(path.join(os.tmpdir(),'hub-edit-')),file=path.join(dir,'knowledge.json');await writeFile(file,JSON.stringify(base()));
 let published=0;const editor=createKnowledgeEditor({file,publish:async()=>{published++;}});
 const bad=await editor({id:'gw',base:entryHash(base().entries[1]),fields:{login:'password=hunter2hunter2'}});
 assert.equal(bad.ok,false);assert.ok(bad.errors[0].includes('looks like a secret value'));assert.equal(published,0);
 const good=await editor({id:'gw',base:entryHash(base().entries[1]),fields:{version:'Node 26'}});
 assert.equal(good.ok,true);assert.equal(published,1);assert.equal(JSON.parse(await readFile(file,'utf8')).entries[1].version,'Node 26');
});
test('the inventory edit API saves through the local editor and exports JSON',async()=>{
 const http=(await import('node:http')).default,{mkdtemp,writeFile}=await import('node:fs/promises'),os=(await import('node:os')).default;
 const {hashPassword}=await import('../server/auth.mjs'),{createHandler}=await import('../server/index.mjs'),{createKnowledgeEditor,entryHash}=await import('../scripts/knowledge-edit.mjs');
 const dir=await mkdtemp(path.join(os.tmpdir(),'hub-api-'));await writeFile(path.join(dir,'inventory.json'),JSON.stringify({devices:[]}));await writeFile(path.join(dir,'knowledge.json'),JSON.stringify(base()));
 const editor=createKnowledgeEditor({file:path.join(dir,'knowledge.json'),publish:async()=>{}}),calls=[];
 const bridgeRequest=async(route,method,input)=>{calls.push(route);if(route==='/inventory/edit')return editor(input);throw new Error('unavailable');};
 const credentials={username:'admin',...hashPassword('test-only-password')},origin='http://127.0.0.1:8893';
 const server=http.createServer(createHandler({directory:dir,credentials,origin,secure:false,stateDirectory:dir}));await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`;
 const post=(body,Cookie)=>fetch(`${url}/api/inventory/entry`,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin,...(Cookie?{Cookie}:{})},body:JSON.stringify(body)});
 try{
  const stamp=entryHash(base().entries[1]);
  assert.equal((await post({id:'gw',base:stamp,fields:{version:'x'}})).status,401);
  const Cookie=(await fetch(`${url}/api/session`,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify({username:'admin',password:'test-only-password'})})).headers.get('set-cookie');
  const list=await (await fetch(`${url}/api/inventory`,{headers:{Cookie}})).json();assert.equal(list.hashes.gw,stamp);
  const ok=await post({id:'gw',base:stamp,fields:{version:'Node 26'}},Cookie);assert.equal(ok.status,200);const out=await ok.json();assert.equal(out.doc.entries[1].version,'Node 26');assert.notEqual(out.hashes.gw,stamp);
  assert.equal((await post({id:'gw',base:stamp,fields:{version:'again'}},Cookie)).status,409);
  assert.equal((await post({id:'gw',base:out.hashes.gw,fields:{login:'password=hunter2hunter2'}},Cookie)).status,422);
  assert.equal((await post({id:'gw',base:out.hashes.gw,fields:{evil:'x'}},Cookie)).status,400);
  const exp=await fetch(`${url}/api/inventory/export`,{headers:{Cookie}});assert.equal(exp.status,200);assert.match(exp.headers.get('content-disposition'),/attachment; filename="home-inventory-/);assert.equal((await exp.json()).entries.length,4);
 }finally{server.close();}
});
