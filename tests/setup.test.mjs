// First run: a hub without an auth file starts, says so, and takes the owner from scripts/setup.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,writeFile,stat,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHandler} from '../server/index.mjs';
import {createAccessStore,validCredentials} from '../server/access-store.mjs';
import {createOwner,passwordProblem,hubUrl} from '../scripts/setup.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temp=async(t,name)=>{const dir=await mkdtemp(path.join(os.tmpdir(),name));t.after(()=>rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:25}));return dir;};
// Runs a script; stdin is closed at once unless input is given. Resolves {code, out, err}.
const run=(args,{input,env={}}={})=>new Promise(resolve=>{
 const child=spawn(process.execPath,args,{cwd:root,env:{...process.env,...env},stdio:['pipe','pipe','pipe']});
 let out='',err='';child.stdout.on('data',d=>{out+=d;});child.stderr.on('data',d=>{err+=d;});
 child.on('close',code=>resolve({code,out,err}));child.stdin.end(input??'');
});
const mode=async file=>(await stat(file)).mode&0o777;

test('createOwner writes a 0600 scrypt record once, and replaces it only when forced',async t=>{
 const dir=await temp(t,'hub-setup-'),authFile=path.join(dir,'private','auth.json');
 assert.equal(passwordProblem('short'),'The password needs at least 12 characters.');assert.equal(passwordProblem('a-long-enough-password'),null);
 await assert.rejects(createOwner({authFile,username:'Admin',password:'a-long-enough-password'}),/user name/);
 await assert.rejects(createOwner({authFile,username:'alex',password:'short'}),/12 characters/);
 const made=await createOwner({authFile,username:'alex',name:'Alex',password:'a-long-enough-password'});
 assert.deepEqual([made.username,made.replaced],['alex',false]);
 const record=JSON.parse(await readFile(authFile,'utf8'));
 assert.ok(validCredentials(record));assert.deepEqual([record.username,record.name],['alex','Alex']);assert.equal(record.createdAt,record.passwordAt);
 assert.ok(!JSON.stringify(record).includes('a-long-enough-password'),'only the hash is stored');
 if(process.platform!=='win32'){assert.equal(await mode(authFile),0o600);assert.equal(await mode(path.dirname(authFile)),0o700);}
 await assert.rejects(createOwner({authFile,username:'other',password:'another-long-password'}),/already exists/,'a second run cannot take the hub over');
 assert.equal(JSON.parse(await readFile(authFile,'utf8')).hash,record.hash);
 const forced=await createOwner({authFile,username:'alex',password:'another-long-password',force:true});assert.equal(forced.replaced,true);
 const next=JSON.parse(await readFile(authFile,'utf8'));
 assert.notEqual(next.hash,record.hash);assert.equal(next.createdAt,record.createdAt);assert.ok(next.passwordAt>record.passwordAt,'the stamp moves, so sessions of the old password end');
 const store=createAccessStore(dir,next,{ownerFile:authFile});
 assert.equal(await store.authenticate('alex','a-long-enough-password'),null);assert.equal((await store.authenticate('alex','another-long-password')).roleId,'owner');
 assert.equal(await hubUrl({url:'https://hub.example.lan'}),'https://hub.example.lan');
});

test('scripts/setup.mjs: from flags, never printing the password, refusing a second run',async t=>{
 const dir=await temp(t,'hub-setup-cli-'),authFile=path.join(dir,'auth.json');
 const generated=await run(['scripts/setup.mjs','--generate','--auth-file',authFile,'--url','https://hub.example.lan']);
 assert.equal(generated.code,0,generated.err);assert.match(generated.out,/Owner created: admin/);assert.match(generated.out,/https:\/\/hub\.example\.lan/);
 const access=await readFile(path.join(dir,'ACCESS.txt'),'utf8'),password=/Password: (\S+)/.exec(access)[1];
 assert.ok(password.length>=24&&!generated.out.includes(password)&&!generated.err.includes(password),'the generated password is only in ACCESS.txt');
 if(process.platform!=='win32'){assert.equal(await mode(authFile),0o600);assert.equal(await mode(path.join(dir,'ACCESS.txt')),0o600);}
 const record=JSON.parse(await readFile(authFile,'utf8'));
 assert.equal((await createAccessStore(dir,record).authenticate('admin',password)).roleId,'owner');
 const again=await run(['scripts/setup.mjs','--generate','--auth-file',authFile]);assert.equal(again.code,1);assert.match(again.err,/already has an owner/);
 assert.equal(JSON.parse(await readFile(authFile,'utf8')).hash,record.hash,'nothing was overwritten');

 const second=path.join(dir,'second.json');
 const piped=await run(['scripts/setup.mjs','--username','alex','--password-stdin','--auth-file',second],{input:'piped-password-123\n'});
 assert.equal(piped.code,0,piped.err);assert.ok(!piped.out.includes('piped-password-123'));
 assert.equal((await createAccessStore(dir,JSON.parse(await readFile(second,'utf8'))).authenticate('alex','piped-password-123')).username,'alex');
 const third=path.join(dir,'third.json'),pwFile=path.join(dir,'pw.txt');await writeFile(pwFile,'file-password-1234\n',{mode:0o600});
 assert.equal((await run(['scripts/setup.mjs','--username','sam','--password-file',pwFile,'--auth-file',third])).code,0);
 assert.equal((await createAccessStore(dir,JSON.parse(await readFile(third,'utf8'))).authenticate('sam','file-password-1234')).username,'sam');
 const short=await run(['scripts/setup.mjs','--password-stdin','--auth-file',path.join(dir,'short.json')],{input:'short\n'});assert.equal(short.code,1);assert.match(short.err,/12 characters/);
 const noTty=await run(['scripts/setup.mjs','--auth-file',path.join(dir,'none.json')]);assert.equal(noTty.code,2);assert.match(noTty.err,/No terminal/);
 const typo=await run(['scripts/setup.mjs','--pasword','x']);assert.equal(typo.code,2);assert.match(typo.out,/Unknown option: --pasword/);
});

test('a hub without an owner says "finish setup", refuses sign-in, and picks the owner up without a restart',async t=>{
 const dir=await temp(t,'hub-firstrun-'),authFile=path.join(dir,'auth.json');
 const server=http.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
 server.on('request',createHandler({directory:dir,stateDirectory:dir,credentials:{},authFile,origin,secure:false}));
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
 const post=(url,body,headers={})=>fetch(origin+url,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
 const manifest=async()=>(await fetch(origin+'/api/ui/manifest')).json();
 assert.deepEqual([(await manifest()).setupRequired,(await manifest()).signedIn],[true,false]);
 assert.equal((await fetch(origin+'/')).status,200,'the shell is served');assert.equal((await fetch(origin+'/healthz')).status,200);
 assert.equal((await fetch(origin+'/api/me')).status,401);assert.equal((await fetch(origin+'/api/home')).status,401);
 const early=await post('/api/session',{username:'admin',password:'anything-at-all-123'});assert.equal(early.status,409);assert.equal((await early.json()).error.code,'SETUP_REQUIRED');
 assert.equal((await post('/api/admin/users',{username:'first'})).status,401,'nothing can be created without an owner');
 await writeFile(authFile,'{"username":"admin","hash":"not a hash"}');assert.equal((await manifest()).setupRequired,true,'a broken auth file is not an owner');
 await rm(authFile);

 await createOwner({authFile,username:'alex',password:'owner-password-1234'});
 assert.equal((await manifest()).setupRequired,undefined,'the running hub sees the new owner');
 assert.equal((await post('/api/session',{username:'alex',password:'wrong-password-123'})).status,401);
 const login=await post('/api/session',{username:'alex',password:'owner-password-1234'});assert.equal(login.status,200);
 const cookie={Cookie:login.headers.get('set-cookie').split(';')[0]};
 const me=await (await fetch(origin+'/api/me',{headers:cookie})).json();assert.deepEqual([me.username,me.roleId,me.canAdmin],['alex','owner',true]);
 const changed=await post('/api/profile/password',{currentPassword:'owner-password-1234',newPassword:'owner-password-5678'},cookie);assert.equal(changed.status,200,'the owner can change the password setup wrote');
 if(process.platform!=='win32')assert.equal(await mode(authFile),0o600);
});

test('the server process starts without an auth file instead of crashing',async t=>{
 const dir=await temp(t,'hub-boot-');
 const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
 const child=spawn(process.execPath,['server/index.mjs'],{cwd:root,stdio:['ignore','pipe','pipe'],
  env:{...process.env,LOCAL_PREVIEW:'1',PORT:String(port),DATA_DIR:dir,AUTH_FILE:path.join(dir,'missing','auth.json'),HOME_HUB_PLUGINS_DIR:'none',HOME_HUB_SITE_CONFIG:'none',HOME_HUB_EDITION:'public'}});
 let out='';child.stdout.on('data',d=>{out+=d;});child.stderr.on('data',d=>{out+=d;});
 t.after(()=>{child.kill();});
 const up=await new Promise(resolve=>{const started=Date.now();const poll=async()=>{try{if((await fetch(`http://127.0.0.1:${port}/healthz`)).ok)return resolve(true);}catch{}
  if(child.exitCode!==null||Date.now()-started>15000)return resolve(false);setTimeout(poll,100);};poll();});
 assert.ok(up,`the server did not come up:\n${out}`);
 assert.match(out,/No owner account yet/);assert.match(out,/node scripts\/setup\.mjs/);
 const manifest=await (await fetch(`http://127.0.0.1:${port}/api/ui/manifest`)).json();
 assert.deepEqual([manifest.setupRequired,manifest.signedIn,manifest.edition,manifest.site.defaultLanguage],[true,false,'public','en']);
});
