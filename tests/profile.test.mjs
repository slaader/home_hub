import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,stat,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createHandler} from '../server/index.mjs';
import {hashPassword} from '../server/auth.mjs';

const OLD='old-admin-password-1',NEW='new-admin-password-2';
async function hub(t,{withAuthFile=true}={}){
 const dir=await mkdtemp(path.join(os.tmpdir(),'hub-profile-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const credentials={username:'admin',...hashPassword(OLD)},authFile=path.join(dir,'auth.json');
 await writeFile(authFile,JSON.stringify({...credentials,note:'kept'}),{mode:0o600});
 const origin='http://127.0.0.1:8996';
 const server=http.createServer(createHandler({directory:dir,stateDirectory:dir,credentials,authFile:withAuthFile?authFile:null,origin,secure:false,bridgeRequest:async()=>{throw new Error('offline');}}));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections?.();return new Promise(r=>server.close(r));});
 const base=`http://127.0.0.1:${server.address().port}`;
 const post=(route,body,cookie)=>fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin,...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(body)});
 const login=async(username,password)=>{const r=await post('/api/session',{username,password});return r.status===200?r.headers.get('set-cookie').split(';')[0]:null;};
 const me=cookie=>fetch(base+'/api/me',{headers:{Cookie:cookie}}).then(r=>r.status);
 return {dir,base,authFile,post,login,me};
}

test('admin changes own password: checks, other sessions end, auth file rewritten, caller stays signed in',async t=>{
 const h=await hub(t);
 const a=await h.login('admin',OLD),b=await h.login('admin',OLD);assert.ok(a&&b);
 assert.equal((await h.post('/api/profile/password',{currentPassword:OLD,newPassword:NEW})).status,401,'needs a session');
 const wrong=await h.post('/api/profile/password',{currentPassword:'nope-nope-nope',newPassword:NEW},a);
 assert.equal(wrong.status,403);assert.equal((await wrong.json()).error.code,'WRONG_PASSWORD');
 assert.equal((await h.post('/api/profile/password',{currentPassword:OLD,newPassword:'short'},a)).status,400);
 assert.equal((await h.post('/api/profile/password',{currentPassword:OLD,newPassword:OLD},a)).status,400,'must differ');
 assert.equal((await h.post('/api/profile/password',{currentPassword:OLD,newPassword:NEW,extra:1},a)).status,400);
 const ok=await h.post('/api/profile/password',{currentPassword:OLD,newPassword:NEW},a);
 assert.equal(ok.status,200);const body=await ok.json();assert.equal(body.signedIn,true);assert.equal(body.user.username,'admin');
 const fresh=ok.headers.get('set-cookie').split(';')[0];
 assert.equal(await h.me(fresh),200,'fresh cookie works');
 assert.equal(await h.me(a),401,'the old session of the caller ended');
 assert.equal(await h.me(b),401,'other sessions ended');
 assert.equal(await h.login('admin',OLD),null,'old password no longer works');
 assert.ok(await h.login('admin',NEW),'new password works');
 const onDisk=JSON.parse(await readFile(h.authFile,'utf8'));
 assert.equal(onDisk.username,'admin');assert.equal(onDisk.note,'kept','other fields preserved');
 assert.match(onDisk.hash,/^[a-f0-9]{128}$/);assert.match(onDisk.salt,/^[a-f0-9]{32}$/);
 assert.equal((await stat(h.authFile)).mode&0o777,0o600);
 assert.match(await readFile(path.join(h.dir,'access-audit.jsonl'),'utf8'),/owner-password-changed/);
});

test('viewer changes own password; API keys cannot; five wrong tries lock for 15 minutes',async t=>{
 const h=await hub(t);
 const admin=await h.login('admin',OLD);
 const created=await h.post('/api/admin/users',{username:'reader',password:'reader-password-1'},admin);assert.equal(created.status,201);
 const viewer=await h.login('reader','reader-password-1');assert.ok(viewer);
 const ok=await h.post('/api/profile/password',{currentPassword:'reader-password-1',newPassword:'reader-password-2'},viewer);
 assert.equal(ok.status,200,'read-only accounts may change their own password');
 assert.equal(await h.me(viewer),401);assert.ok(await h.login('reader','reader-password-2'));
 const key=await (await h.post('/api/admin/keys',{name:'agent',permission:'write'},admin)).json();
 const viaKey=await fetch(h.base+'/api/profile/password',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${key.token}`},body:JSON.stringify({currentPassword:OLD,newPassword:NEW})});
 assert.equal(viaKey.status,403);assert.equal((await viaKey.json()).error.code,'SESSION_REQUIRED');
 for(let i=0;i<5;i++)assert.equal((await h.post('/api/profile/password',{currentPassword:`wrong-${i}-xxxxxxx`,newPassword:NEW},admin)).status,403);
 const locked=await h.post('/api/profile/password',{currentPassword:OLD,newPassword:NEW},admin);
 assert.equal(locked.status,429,'locked even with the right password');
});

test('without an auth file path the admin password cannot be changed (501); assets are served',async t=>{
 const h=await hub(t,{withAuthFile:false});
 const a=await h.login('admin',OLD);
 const r=await h.post('/api/profile/password',{currentPassword:OLD,newPassword:NEW},a);
 assert.equal(r.status,501);assert.ok(await h.login('admin',OLD),'nothing changed');
 for(const asset of ['/settings-view.js','/settings.css'])assert.equal((await fetch(h.base+asset)).status,200,asset);
});

import {createAccessStore} from '../server/access-store.mjs';
test('an admin reset that lands while a viewer password change is verifying wins; the change fails',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'hub-race-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const store=createAccessStore(dir,{username:'admin',...hashPassword(OLD)});
 const {user}=await store.createUser({username:'reader',password:'reader-password-1'});
 // changePassword verifies with scrypt off the queue; the reset is queued right behind it and commits first.
 const change=store.changePassword(user.id,{currentPassword:'reader-password-1',newPassword:'reader-password-2'});
 const reset=store.resetPassword({id:user.id});
 const [c,r]=await Promise.allSettled([change,reset]);
 assert.equal(r.status,'fulfilled');
 assert.equal(c.status,'rejected');assert.equal(c.reason.message,'superseded','stale verification must not overwrite the reset');
 assert.ok(await store.authenticate('reader',r.value.password),'the admin reset password is the one that works');
 assert.equal(await store.authenticate('reader','reader-password-2'),null);
});
test('two simultaneous own-password changes: exactly one wins, for viewers and the built-in admin',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'hub-race2-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const authFile=path.join(dir,'auth.json'),credentials={username:'admin',...hashPassword(OLD)};
 await writeFile(authFile,JSON.stringify(credentials),{mode:0o600});
 const store=createAccessStore(dir,credentials,{ownerFile:authFile});
 const {user}=await store.createUser({username:'reader',password:'reader-password-1'});
 for(const [id,username,cur] of [[user.id,'reader','reader-password-1'],['owner','admin',OLD]]){
  const results=await Promise.allSettled(['first-new-password-1','second-new-password-2'].map(newPassword=>store.changePassword(id,{currentPassword:cur,newPassword})));
  const won=results.filter(r=>r.status==='fulfilled');
  assert.equal(won.length,1,`${username}: one change commits`);
  assert.equal(results.find(r=>r.status==='rejected').reason.message,'superseded');
  const winner=results[0].status==='fulfilled'?'first-new-password-1':'second-new-password-2',loser=winner.startsWith('first')?'second-new-password-2':'first-new-password-1';
  assert.ok(await store.authenticate(username,winner));assert.equal(await store.authenticate(username,loser),null);
 }
 const disk=JSON.parse(await readFile(authFile,'utf8'));assert.equal(disk.hash,credentials.hash,'auth file matches the committed admin password');
});
test('parallel wrong current passwords cannot bypass the five-try lockout',async t=>{
 const h=await hub(t);const admin=await h.login('admin',OLD);
 const statuses=(await Promise.all([...Array(12)].map((_,i)=>h.post('/api/profile/password',{currentPassword:`wrong-${i}-xxxxxxx`,newPassword:NEW},admin)))).map(r=>r.status);
 assert.equal(statuses.filter(s=>s===403).length,5,'only five attempts are actually checked');
 assert.equal(statuses.filter(s=>s===429).length,7);
 assert.equal((await h.post('/api/profile/password',{currentPassword:OLD,newPassword:NEW},admin)).status,429,'still locked for the right password');
 // Invalid input does not burn an attempt.
 const h2=await hub(t);const a2=await h2.login('admin',OLD);
 for(let i=0;i<6;i++)assert.equal((await h2.post('/api/profile/password',{currentPassword:OLD,newPassword:'short'},a2)).status,400);
 assert.equal((await h2.post('/api/profile/password',{currentPassword:OLD,newPassword:NEW},a2)).status,200);
});
