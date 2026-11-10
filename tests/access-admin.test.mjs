import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {hashPassword} from '../server/auth.mjs';
import {createAccessStore,readAccessAudit} from '../server/access-store.mjs';
import {createHandler} from '../server/index.mjs';

const credentials={username:'admin',...hashPassword('administrator-test-password')};

test('password reset: new password works once shown, old one stops, owner is out of reach',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'hub-reset-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const s=createAccessStore(dir,credentials);
 const {user,initialPassword}=await s.createUser({username:'guest'});
 const reset=await s.resetPassword({id:user.id});
 assert.equal(typeof reset.password,'string');assert.ok(reset.password.length>=20);
 assert.equal(await s.authenticate('guest',initialPassword),null);
 assert.equal((await s.authenticate('guest',reset.password)).username,'guest');
 assert.notEqual(reset.user.passwordAt,user.passwordAt,'every reset moves the password stamp');
 const again=await s.resetPassword({id:user.id});assert.notEqual(again.user.passwordAt,reset.user.passwordAt);
 const disk=await readFile(path.join(dir,'access.json'),'utf8');
 assert.ok(!disk.includes(reset.password)&&!disk.includes(again.password),'only the hash is stored');
 assert.throws(()=>s.resetPassword({id:'owner'}),/invalid/);
 assert.throws(()=>s.resetPassword({id:user.id,password:'chosen-by-admin'}),/invalid/);
 await assert.rejects(s.resetPassword({id:'0000000000000000'}),/not-found/);
});

test('admin API: reset ends the user’s sessions, audit lists events without secrets, keys and viewers are refused',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'hub-admin-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const server=http.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
 server.on('request',createHandler({directory:dir,stateDirectory:dir,credentials,origin,secure:false,bridgeRequest:async()=>{throw new Error('offline');}}));
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
 const post=(url,body,headers={})=>fetch(origin+url,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
 const login=async(username,password)=>{const r=await post('/api/session',{username,password});return r.status===200?r.headers.get('set-cookie').split(';')[0]:null;};
 const admin={Cookie:await login('admin','administrator-test-password')};

 const created=await (await post('/api/admin/users',{username:'guest',name:'Guest'},admin)).json();
 const viewer={Cookie:await login('guest',created.initialPassword)};
 assert.equal((await fetch(origin+'/api/me',{headers:viewer})).status,200);

 const reset=await post('/api/admin/users/password',{id:created.user.id},admin);
 assert.equal(reset.status,200);const {password}=await reset.json();
 assert.equal((await fetch(origin+'/api/me',{headers:viewer})).status,401,'old session ends at the next request');
 assert.equal(await login('guest',created.initialPassword),null,'old password no longer works');
 const fresh={Cookie:await login('guest',password)};
 assert.equal((await fetch(origin+'/api/me',{headers:fresh})).status,200);
 assert.equal((await post('/api/admin/users/password',{id:'owner'},admin)).status,400);
 assert.equal((await post('/api/admin/users/password',{id:created.user.id},fresh)).status,403,'a viewer cannot reset passwords');

 const key=await (await post('/api/admin/keys',{name:'Writer',permission:'write'},admin)).json();
 const bearer={Authorization:'Bearer '+key.token};
 assert.equal((await post('/api/admin/users/password',{id:created.user.id},bearer)).status,403,'API keys never manage accounts');
 assert.equal((await fetch(origin+'/api/admin/audit',{headers:bearer})).status,403);
 assert.equal((await fetch(origin+'/api/admin/audit',{headers:fresh})).status,403);
 await post('/api/admin/keys/revoke',{id:key.key.id},admin);

 const audit=await fetch(origin+'/api/admin/audit',{headers:admin});assert.equal(audit.status,200);
 const text=await audit.text(),{events}=JSON.parse(text);
 assert.deepEqual(events.filter(e=>e.event!=='api-write').map(e=>e.event),['key-revoked','key-created','user-password-reset','user-created']);
 assert.ok(events.some(e=>e.event==='api-write'&&e.subject==='Writer'&&e.detail.startsWith('/api/admin/users/password')&&e.status===403),'the key’s refused attempt is in the log');
 assert.equal(events.find(e=>e.event==='user-password-reset').subject,'guest');
 assert.equal(events.find(e=>e.event==='key-created').subject,'Writer');
 for(const secret of [password,created.initialPassword,key.token])assert.ok(!text.includes(secret),'audit never contains secrets');

 const users=await (await fetch(origin+'/api/admin/users',{headers:admin})).json();
 assert.ok(users.users.every(u=>!('hash' in u)&&!('salt' in u)));
 for(const asset of ['/access-view.js','/access.css'])assert.equal((await fetch(origin+asset)).status,200);
});

test('audit reader merges device events and survives missing files',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'hub-audit-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 assert.deepEqual(await readAccessAudit(dir),[]);
 const {writeFile}=await import('node:fs/promises');
 await writeFile(path.join(dir,'device-tokens-audit.jsonl'),JSON.stringify({at:'2026-11-08T10:00:00.000Z',event:'issued',id:'abcdabcdabcdabcd',name:'iPhone'})+'\nnot json\n');
 await writeFile(path.join(dir,'access-audit.jsonl'),JSON.stringify({at:'2026-11-08T11:00:00.000Z',event:'user-created',id:'gone'})+'\n');
 const events=await readAccessAudit(dir);
 assert.deepEqual(events.map(e=>[e.event,e.subject]),[['user-created',null],['device-issued','iPhone']]);
});
