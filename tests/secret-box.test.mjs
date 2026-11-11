// Secrets at rest (server/secret-box.mjs): sealed with AES-256-GCM, the key kept apart from the data, a file bound
// to its purpose, the Keychain reached without the key on a command line, and the device store's two secret files
// sealed, older plain ones still read and rewritten sealed. No test touches the real Keychain.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,stat,readdir,mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createSecretBox,keychainSource,isSealed} from '../server/secret-box.mjs';
import {createHomeDevices} from '../server/home-devices.mjs';

const KEY='ab'.repeat(32),PIN='c'.repeat(64),NOFILE=path.join(os.tmpdir(),`secret-box-none-${process.pid}`,'secret.key');
async function tmp(t){const dir=await mkdtemp(path.join(os.tmpdir(),'secret-box-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
const fakeKeychain=()=>{const k={store:null,scripts:[]};
 k.source=keychainSource({run:async script=>{k.scripts.push(script);
  if(script.startsWith('find-generic-password'))return k.locked?{code:51,stdout:''}:k.store?{code:0,stdout:`security> ${k.store}\n`}:{code:44,stdout:''};
  const m=/-w ([0-9a-f]{64})\n$/.exec(script);if(script.startsWith('add-generic-password')&&m&&!k.store){k.store=m[1];return {code:0,stdout:''};}
  return {code:45,stdout:''};}});return k;};

test('seal and open: no plain text, bound to the purpose, tampering refused',async t=>{
 const box=createSecretBox({env:{HOME_HUB_SECRET_KEY:KEY},keyFile:NOFILE});
 const env=await box.seal({password:'correct horse battery'},'home/thermo-hosts');
 assert.ok(isSealed(env));assert.equal(env.kid,'env');assert.ok(!JSON.stringify(env).includes('correct horse'));
 assert.deepEqual(await box.open(env,'home/thermo-hosts'),{password:'correct horse battery'});
 await assert.rejects(box.open(env,'home/telemetry-hosts'),{reason:'secrets-locked'},'one sealed file is not another');
 const flipped=Buffer.from(env.data,'base64');flipped[0]^=1;const bad={...env,data:flipped.toString('base64')};
 await assert.rejects(box.open(bad,'home/thermo-hosts'),{reason:'secrets-locked'});
 await assert.rejects(createSecretBox({env:{HOME_HUB_SECRET_KEY:'cd'.repeat(32)},keyFile:NOFILE}).open(env,'home/thermo-hosts'),{reason:'secrets-locked'},'another HOME_HUB_SECRET_KEY is a mistake to fix, not a loss');
 assert.throws(()=>createSecretBox({env:{HOME_HUB_SECRET_KEY:'short'},keyFile:NOFILE}),{reason:'invalid'});
});

test('the key file: made once, 0600, outside the data; a missing one is never invented for an older file',async t=>{
 const dir=await tmp(t),keyFile=path.join(dir,'private','secret.key');
 const box=createSecretBox({env:{},platform:'linux',keyFile});assert.equal(box.kid,'file');
 const env=await box.seal({a:1},'p');assert.equal(env.kid,'file');
 if(process.platform!=='win32')assert.equal((await stat(keyFile)).mode&0o777,0o600);
 assert.match(await readFile(keyFile,'utf8'),/^[0-9a-f]{64}\n$/);
 assert.deepEqual(await createSecretBox({env:{},platform:'linux',keyFile}).open(env,'p'),{a:1},'a restart reads the same key');
 await rm(keyFile);
 await assert.rejects(createSecretBox({env:{},platform:'linux',keyFile}).open(env,'p'),{reason:'secrets-lost'},'the key file is gone: certainly lost');
 await assert.rejects(rm(keyFile),{code:'ENOENT'},'opening never creates a key');
 await assert.rejects(createSecretBox({env:{},platform:'linux',keyFile}).open({...env,kid:'keychain'},'p'),{reason:'secrets-locked'},'sealed by a Keychain not set up here: it may still hold the key');
 await assert.rejects(createSecretBox({env:{},platform:'linux',keyFile}).open({...env,kid:'env'},'p'),{reason:'secrets-locked'},'HOME_HUB_SECRET_KEY no longer given: uncertain');
 // Two hubs making the key at once agree on one: each opens what the other sealed.
 const race=path.join(dir,'race','secret.key'),boxes=Array.from({length:4},()=>createSecretBox({env:{},platform:'linux',keyFile:race}));
 const sealed=await Promise.all(boxes.map((b,i)=>b.seal({i},'p')));
 for(const b of boxes)for(const [i,e] of sealed.entries())assert.deepEqual(await b.open(e,'p'),{i});
});

test('the macOS Keychain: the key goes over stdin, is made only when there is none, and is reused',async t=>{
 const dir=await tmp(t),k=fakeKeychain(),keyFile=path.join(dir,'secret.key');
 assert.equal(createSecretBox({env:{},platform:'darwin',keychain:k.source,keyFile}).kid,'file','the Keychain only when asked for');
 const box=createSecretBox({env:{HOME_HUB_SECRET_KEYCHAIN:'1'},platform:'darwin',keychain:k.source,keyFile});assert.equal(box.kid,'keychain');
 const env=await box.seal({a:1},'p');assert.equal(env.kid,'keychain');
 assert.deepEqual(k.scripts.map(s=>s.split(' ')[0]),['find-generic-password','add-generic-password','find-generic-password']);
 assert.match(k.scripts[1],/^add-generic-password -s "Home Hub" -a "secret-key" -D "application password" -w [0-9a-f]{64}\n$/);assert.doesNotMatch(k.scripts[1],/-U\b/,'never overwrites a key');
 await assert.rejects(stat(keyFile),{code:'ENOENT'},'no key file next to it');
 const again=fakeKeychain();again.store=k.store;
 assert.deepEqual(await createSecretBox({env:{HOME_HUB_SECRET_KEYCHAIN:'1'},platform:'darwin',keychain:again.source,keyFile}).open(env,'p'),{a:1});
 assert.deepEqual(again.scripts.map(s=>s.split(' ')[0]),['find-generic-password'],'reads, never adds');
 const shut=fakeKeychain();shut.store=k.store;shut.locked=true;
 await assert.rejects(createSecretBox({env:{HOME_HUB_SECRET_KEYCHAIN:'1'},platform:'darwin',keychain:shut.source,keyFile}).seal({a:1},'p'),{reason:'secrets-locked'},'a locked Keychain: nothing sealed, nothing in plain text');
 assert.deepEqual(shut.scripts.map(s=>s.split(' ')[0]),['find-generic-password'],'locked is not "none": no new key is added');
});

test('moving between key sources: a file opens with whichever key there is; broken envelopes are refused cleanly',async t=>{
 const dir=await tmp(t),k=fakeKeychain();
 const env=await createSecretBox({env:{HOME_HUB_SECRET_KEYCHAIN:'1'},platform:'darwin',keychain:k.source,keyFile:path.join(dir,'none')}).seal({a:1},'p');
 assert.equal(env.kid,'keychain');
 assert.deepEqual(await createSecretBox({env:{HOME_HUB_SECRET_KEY:k.store},platform:'linux',keyFile:NOFILE}).open(env,'p'),{a:1},'the same key from the environment on another machine');
 await writeFile(path.join(dir,'secret.key'),k.store+'\n',{mode:0o600});
 assert.deepEqual(await createSecretBox({env:{},platform:'linux',keyFile:path.join(dir,'secret.key')}).open(env,'p'),{a:1},'or from a key file');
 const box=createSecretBox({env:{HOME_HUB_SECRET_KEY:KEY},keyFile:NOFILE}),good=await box.seal({a:1},'p');
 for(const bad of [{...good,iv:''},{...good,tag:Buffer.alloc(4).toString('base64')},{...good,kid:'other'},{...good,alg:'A128GCM'},{...good,data:'!!'}])
  await assert.rejects(box.open(bad,'p'),e=>e instanceof Error&&['secrets-locked','invalid'].includes(e.reason));
});

test('the device store: Thermo and telemetry secrets sealed on disk; a plain older file is read and rewritten sealed',async t=>{
 const dir=await tmp(t),box=createSecretBox({env:{HOME_HUB_SECRET_KEY:KEY},keyFile:NOFILE});
 const plain={schema:1,hosts:[{id:'box',provider:'node-exporter',record:{mode:'node-exporter',host:'10.0.0.21',port:9100,scheme:'http',tls:null,user:null,password:null}}]};
 await writeFile(path.join(dir,'telemetry-hosts.json'),JSON.stringify(plain),{mode:0o600});
 await writeFile(path.join(dir,'thermo-hosts.json'),JSON.stringify({hosts:[{id:'mini',host:'10.0.0.5',port:49286,username:'homehub',label:'home-hub',password:'correct horse battery',pin:PIN}]}),{mode:0o600});
 const d=createHomeDevices(dir,{box});
 assert.equal((await d.feedEntry('box')).record.host,'10.0.0.21','the plain file is read');
 assert.equal((await d.thermoHosts())[0].password,'correct horse battery');
 for(let i=0;i<100&&!isSealed(JSON.parse(await readFile(path.join(dir,'thermo-hosts.json'),'utf8')));i++)await new Promise(r=>setTimeout(r,10));
 for(let i=0;i<100&&!isSealed(JSON.parse(await readFile(path.join(dir,'telemetry-hosts.json'),'utf8')));i++)await new Promise(r=>setTimeout(r,10));
 for(const [name,purpose] of [['telemetry-hosts.json','home/telemetry-hosts'],['thermo-hosts.json','home/thermo-hosts']]){
  const raw=JSON.parse(await readFile(path.join(dir,name),'utf8'));assert.ok(isSealed(raw),`${name} rewritten sealed`);
  assert.ok(!JSON.stringify(raw).includes('correct horse')&&!JSON.stringify(raw).includes('10.0.0.21'));
  if(process.platform!=='win32')assert.equal((await stat(path.join(dir,name))).mode&0o777,0o600);
  assert.ok(await box.open(raw,purpose));}
 assert.equal((await createHomeDevices(dir,{box}).thermoHosts())[0].password,'correct horse battery','a restart opens it');
 // A key source that cannot be read (here a key file that is not a key; a locked Keychain alike): uncertain, so
 // everything stays as it is and changes are refused.
 await writeFile(path.join(dir,'bad.key'),'not a key\n',{mode:0o600});
 const other=createHomeDevices(dir,{box:createSecretBox({env:{},platform:'linux',keyFile:path.join(dir,'bad.key')})});
 await assert.rejects(other.thermoHosts(),{reason:'secrets-locked'},'without its key the file stays closed');
 // A change while locked is refused before anything is written: the device and its secrets stay as they were.
 await writeFile(path.join(dir,'devices.json'),JSON.stringify({schema:1,devices:[{id:'mini',name:'Mini',hostname:'mini.example.lan',ip:null,role:null,props:{},thermoId:'mini',picture:null,source:'ui',image:false,kind:'thermo'}]}),{mode:0o600});
 const before=await Promise.all(['devices.json','thermo-hosts.json'].map(n=>readFile(path.join(dir,n),'utf8')));
 await assert.rejects(other.remove('mini'),{reason:'secrets-locked'});
 assert.deepEqual(await Promise.all(['devices.json','thermo-hosts.json'].map(n=>readFile(path.join(dir,n),'utf8'))),before);
 // Windows set-up while locked: refused before windows-hosts.json changes (the feed entry of this id needs the key).
 await writeFile(path.join(dir,'windows-hosts.json'),JSON.stringify({schema:1,hosts:[{id:'box',target:'win-alias'}]}),{mode:0o600});
 const winBefore=await readFile(path.join(dir,'windows-hosts.json'),'utf8');
 await assert.rejects(other.setWindows('box',null),{reason:'secrets-locked'});
 assert.equal(await readFile(path.join(dir,'windows-hosts.json'),'utf8'),winBefore);
 assert.equal((await createHomeDevices(dir,{box}).remove('mini')).hadLogin,true,'with the key it goes, login and all');
});

test('a reinstall without the key: nothing is renamed by reading; saving a login sets the old file aside; nothing to do by hand',async t=>{
 const dir=await tmp(t),priv=path.join(dir,'private'),keyFile=path.join(priv,'secret.key'),boxAt=(k=keyFile)=>createSecretBox({env:{},platform:'linux',keyFile:k});
 const login={port:49286,username:'homehub',password:'correct horse battery',pin:PIN};
 const first=createHomeDevices(dir,{box:boxAt()});
 const mini=(await first.add({name:'Mini',kind:'thermo',hostname:'mini.example.lan',thermo:login},'alice')).device;
 const NE={mode:'node-exporter',host:'10.0.0.21',port:9100,scheme:'http',tls:null,user:null,password:null};
 await first.add({name:'Box',kind:'node-exporter',hostname:'box.example.lan'},'alice',{feed:{provider:'node-exporter',record:NE}});
 const marker=JSON.parse(await readFile(path.join(dir,'secret-key.json'),'utf8'));assert.equal(marker.keyFile,keyFile);assert.equal(marker.kfps.length,1);
 const sealedText=await readFile(path.join(dir,'thermo-hosts.json'),'utf8'),savedKey=await readFile(keyFile,'utf8');
 const lostFiles=async()=>(await readdir(dir)).filter(n=>n.includes('.lost-'));
 // A preview (or any launch) with another key path over the same state: reads see no login, a save is refused, nothing moves.
 const preview=createHomeDevices(dir,{box:boxAt(path.join(dir,'preview','secret.key'))});
 assert.deepEqual(await preview.thermoHosts(),[]);
 await assert.rejects(preview.setThermo(mini.id,{...login,password:'from a preview 12'}),{reason:'secrets-locked'});
 assert.equal(await readFile(path.join(dir,'thermo-hosts.json'),'utf8'),sealedText);assert.deepEqual(await lostFiles(),[]);
 // private/ is gone (state/ kept): reads see no login and change nothing; the SSH key sweep is refused.
 await rm(priv,{recursive:true});
 const gone=createHomeDevices(dir,{box:boxAt()});
 assert.deepEqual(await gone.thermoHosts(),[]);assert.deepEqual(await lostFiles(),[]);
 await assert.rejects(gone.windowsSecrets(),{reason:'secrets-locked'},'no SSH key is swept while connections cannot be read');
 // The key comes back (a volume mounted late, private/ restored): everything works again, nothing was lost.
 await mkdir(priv,{recursive:true});await writeFile(keyFile,savedKey,{mode:0o600});
 assert.equal((await createHomeDevices(dir,{box:boxAt()}).thermoHosts())[0].password,'correct horse battery');
 // Really gone (a reinstall: private/ is there again with a new sign-in, but no key): the owner enters the password again.
 await rm(keyFile);
 const warnings=[],again=createHomeDevices(dir,{box:boxAt(),log:{warn:m=>warnings.push(m)}});
 assert.deepEqual(await again.thermoHosts(),[],'the tile says "no login"');assert.deepEqual(await lostFiles(),[],'reading renames nothing');
 await again.setThermo(mini.id,{...login,password:'a new password 12'});
 const aside=await lostFiles();assert.equal(aside.length,1,'set aside, not deleted');assert.equal(await readFile(path.join(dir,aside[0]),'utf8'),sealedText);
 assert.equal(warnings.length,1);assert.doesNotMatch(warnings[0],/correct horse/);
 assert.equal((await createHomeDevices(dir,{box:boxAt()}).thermoHosts())[0].password,'a new password 12','sealed with the new key, and it stays');
 // The other file, still sealed with the old key, is no dead end: removing its device sets it aside too.
 assert.deepEqual(await again.feedHosts('node-exporter'),[]);
 await again.remove('box');assert.equal((await lostFiles()).length,2,'telemetry-hosts.json set aside as well');
 assert.equal((await again.thermoHosts())[0].password,'a new password 12','the login entered again is untouched');
 // The right key, a damaged file: not certain, so nothing more is set aside.
 const f=path.join(dir,'thermo-hosts.json'),env=JSON.parse(await readFile(f,'utf8')),data=Buffer.from(env.data,'base64');data[0]^=1;
 await writeFile(f,JSON.stringify({...env,data:data.toString('base64')}),{mode:0o600});
 await assert.rejects(createHomeDevices(dir,{box:boxAt()}).setThermo(mini.id,login),{reason:'secrets-locked'});
 assert.equal((await lostFiles()).length,2);
});

test('a hub moved to another path without its key: the old key directory is gone, so a new login is taken',async t=>{
 const dir=await tmp(t),login={port:49286,username:'homehub',password:'correct horse battery',pin:PIN};
 const old=path.join(dir,'old-home','private','secret.key'),now=path.join(dir,'new-home','private','secret.key');
 const box=k=>createSecretBox({env:{},platform:'linux',keyFile:k}),state=path.join(dir,'state');
 const mini=(await createHomeDevices(state,{box:box(old)}).add({name:'Mini',kind:'thermo',hostname:'mini.example.lan',thermo:login},'alice')).device;
 await mkdir(path.dirname(now),{recursive:true});
 const moved=createHomeDevices(state,{box:box(now)});
 await assert.rejects(moved.setThermo(mini.id,{...login,password:'a new password 12'}),{reason:'secrets-locked'},'the old key directory is still there: maybe a preview, so no');
 await rm(path.join(dir,'old-home'),{recursive:true});
 await moved.setThermo(mini.id,{...login,password:'a new password 12'});
 assert.equal((await moved.thermoHosts())[0].password,'a new password 12');
 assert.equal((await readdir(state)).filter(n=>n.includes('.lost-')).length,1);
});

test('a device without secrets needs no key: removed even where no key can be made, and none is made for it',async t=>{
 const dir=await tmp(t);
 const box=createSecretBox({env:{},platform:'linux',keyFile:path.join('/dev/null','secret.key')});
 const d=createHomeDevices(dir,{box});
 const added=await d.add({name:'Plain',kind:'other',hostname:'plain.example.lan'},'alice');
 assert.equal((await d.remove(added.device.id)).hadLogin,false);
 await assert.rejects(box.seal({a:1},'p'),{reason:'secrets-locked'},'this key directory cannot be written at all');
});
