import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {hashPassword} from '../server/auth.mjs';
import {createHandler} from '../server/index.mjs';
import {createDeviceTokens,bearerOf,maxDevices} from '../server/device-tokens.mjs';
const credentials={username:'admin',...hashPassword('test-only-password')};
const fixture={observed_at:'2026-10-29T19:00:00Z',devices:[{ip:'10.0.0.86',mac:'1c:90:ff:32:b6:07',identity_status:'Confirmed'}]};
async function serve(fn){
 const dir=await mkdtemp(path.join(os.tmpdir(),'hub-tokens-'));await writeFile(path.join(dir,'inventory.json'),JSON.stringify(fixture));
 const origin='http://127.0.0.1:8892',start=()=>{const server=http.createServer(createHandler({directory:dir,credentials,origin,secure:false}));return new Promise(r=>server.listen(0,'127.0.0.1',()=>r(server)));};
 const servers=[];const open=async()=>{const s=await start();servers.push(s);return `http://127.0.0.1:${s.address().port}`;};
 try{await fn({dir,origin,open});}finally{for(const s of servers){s.closeAllConnections();await new Promise(r=>s.close(r));}await rm(dir,{recursive:true});}
}
const post=(url,body,headers={})=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
test('bearer header parsing accepts only well-formed device tokens',()=>{
 assert.equal(bearerOf('Bearer hh_'+'a'.repeat(64)),'hh_'+'a'.repeat(64));
 for(const h of [undefined,'','Bearer','Basic abc','Bearer hh_'+'a'.repeat(63),'Bearer hh_'+'A'.repeat(64),'bearer hh_'+'a'.repeat(64)])assert.equal(bearerOf(h),null);
});
test('a password sign-in issues a device token that then works without cookie or Origin, and revoking it locks it out',()=>serve(async({dir,origin,open})=>{
 const base=await open();
 const login=await post(`${base}/api/session`,{username:'admin',password:'test-only-password'},{Origin:origin});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie');
 assert.equal((await post(`${base}/api/devices/tokens`,{name:'Test iPhone'},{Cookie:cookie})).status,403,'cookie POST still needs Origin');
 assert.equal((await post(`${base}/api/devices/tokens`,{name:''},{Cookie:cookie,Origin:origin})).status,400);
 assert.equal((await post(`${base}/api/devices/tokens`,{name:'x',extra:1},{Cookie:cookie,Origin:origin})).status,400);
 const issued=await post(`${base}/api/devices/tokens`,{name:'Test iPhone'},{Cookie:cookie,Origin:origin});assert.equal(issued.status,201);
 const {token,device}=await issued.json();assert.match(token,/^hh_[a-f0-9]{64}$/);assert.match(device.id,/^[a-f0-9]{16}$/);assert.equal(device.name,'Test iPhone');
 const stored=await readFile(path.join(dir,'state','device-tokens.json'),'utf8');assert(!stored.includes(token.slice(3)),'only the hash is stored');
 assert(!(await readFile(path.join(dir,'state','device-tokens-audit.jsonl'),'utf8')).includes(token.slice(3)));
 const auth={Authorization:`Bearer ${token}`};
 assert.equal((await fetch(`${base}/api/home`,{headers:auth})).status,200);
 const list=await (await fetch(`${base}/api/devices/tokens`,{headers:auth})).json();assert.equal(list.devices.length,1);assert.equal(list.devices[0].current,true);assert(list.devices[0].lastUsedAt);assert(!('hash' in list.devices[0]));
 assert.equal((await post(`${base}/api/devices/tokens`,{name:'Another'},auth)).status,401,'a token cannot mint tokens');
 assert.equal((await post(`${base}/api/devices/tokens/revoke`,{id:'0000000000000000'},auth)).status,404);
 // Tokens and browser sessions both survive a restart (sessions live in state/hub.db, hashed).
 const restarted=await open();assert.equal((await fetch(`${restarted}/api/home`,{headers:auth})).status,200);assert.equal((await fetch(`${restarted}/api/home`,{headers:{Cookie:cookie}})).status,200);
 const revoked=await post(`${restarted}/api/devices/tokens/revoke`,{id:device.id},auth);assert.equal(revoked.status,200);assert.deepEqual((await revoked.json()).devices,[]);
 const after=await fetch(`${restarted}/api/home`,{headers:auth});assert.equal(after.status,401);assert.equal((await after.json()).error.code,'AUTH_REQUIRED');
 assert.equal((await post(`${restarted}/api/home/settings`,{intervalSeconds:30},auth)).status,401,'revoked token is rejected on POST too, not reported as an Origin problem');
 assert.equal((await fetch(`${base}/api/home`,{headers:{Authorization:'Bearer hh_'+'0'.repeat(64)}})).status,401);
}));
test('the browser can list and revoke device access with its cookie',()=>serve(async({origin,open})=>{
 const base=await open();const cookie=(await post(`${base}/api/session`,{username:'admin',password:'test-only-password'},{Origin:origin})).headers.get('set-cookie');
 const {device}=await (await post(`${base}/api/devices/tokens`,{name:'Old phone'},{Cookie:cookie,Origin:origin})).json();
 const list=await (await fetch(`${base}/api/devices/tokens`,{headers:{Cookie:cookie}})).json();assert.equal(list.devices[0].current,false);
 assert.equal((await post(`${base}/api/devices/tokens/revoke`,{id:device.id},{Cookie:cookie})).status,403,'cookie revoke needs Origin');
 assert.equal((await post(`${base}/api/devices/tokens/revoke`,{id:device.id},{Cookie:cookie,Origin:origin})).status,200);
 assert.equal((await fetch(`${base}/api/devices/tokens`)).status,401);
}));
test('the store caps the number of devices and rejects bad names',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'hub-tokens-'));
 try{const store=createDeviceTokens(dir);await assert.rejects(store.issue('bad\u0007name'),/invalid/);await assert.rejects(store.issue('x'.repeat(61)),/invalid/);
  for(let i=0;i<maxDevices;i++)await store.issue(`Phone ${i}`);await assert.rejects(store.issue('One more'),/limit/);
  assert.equal(createDeviceTokens(dir).list().length,maxDevices);
 }finally{await rm(dir,{recursive:true});}
});
