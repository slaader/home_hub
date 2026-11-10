import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createAuth,hashPassword} from '../server/auth.mjs';
import {createHandler} from '../server/index.mjs';
const credentials={username:'admin',...hashPassword('test-only-password')};
test('auth rejects wrong credentials, expires sessions, and throttles guessing',async()=>{let now=0;const auth=createAuth(credentials,{now:()=>now});assert.equal((await auth.login('admin','wrong','test')).status,401);const good=await auth.login('admin','test-only-password','test');assert.match(good.cookie,/HttpOnly; SameSite=Strict.*Secure/);assert(auth.valid(good.cookie));now=43200001;assert(!auth.valid(good.cookie));for(let i=0;i<8;i++)await auth.login('admin','wrong','guess');assert.equal((await auth.login('admin','wrong','guess')).status,429);});
test('HTTP boundary blocks unauthenticated data, cross-origin login, and file traversal',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'hub-test-'));
 const origin='http://127.0.0.1:8891';const server=http.createServer(createHandler({directory:dir,credentials,origin,secure:false}));await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 try{
  assert.deepEqual(await (await fetch(`${base}/healthz`)).json(),{ok:true});
  assert.equal((await fetch(`${base}/api/home`)).status,401);
  assert.equal((await fetch(`${base}/api/anything`)).status,401);
  assert.equal((await fetch(`${base}/private/auth.json`)).status,404);
  assert.equal((await fetch(`${base}/%2e%2e/private/auth.json`)).status,404);
  assert.equal((await fetch(`${base}/local/site.json`)).status,404);
  assert.equal((await fetch(`${base}/images/..%2f..%2fserver%2fauth.mjs`)).status,404);
  for(const file of ['/','/app.js','/ui.js','/tokens.css','/home-view.js','/favicon.svg','/manifest.webmanifest'])assert.equal((await fetch(base+file)).status,200,file);
  assert.equal((await fetch(`${base}/api/home`,{method:'DELETE'})).status,405);
  assert.equal((await fetch(`${base}/api/session`,{method:'POST',headers:{'Content-Type':'application/json',Origin:'http://evil.invalid'},body:'{}'})).status,403);
  const login=await fetch(`${base}/api/session`,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify({username:'admin',password:'test-only-password'})});assert.equal(login.status,200);
  assert.match(login.headers.get('content-security-policy'),/frame-ancestors 'none'/);const cookie=login.headers.get('set-cookie');
  assert.equal((await fetch(`${base}/api/home`,{headers:{Cookie:cookie}})).status,200);
  assert.equal((await fetch(`${base}/api/anything`,{headers:{Cookie:cookie}})).status,404);
  assert.equal((await fetch(`${base}/api/anything`,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin,Cookie:cookie},body:'{}'})).status,404);
  await fetch(`${base}/api/logout`,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin,Cookie:cookie},body:'{}'});
  assert.equal((await fetch(`${base}/api/home`,{headers:{Cookie:cookie}})).status,401);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));await rm(dir,{recursive:true});}
});
