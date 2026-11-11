// App-managed SSH over HTTP and in the device store: the dialog's whole flow (draft, key, host key, trust, test,
// save, edit, cancel, disconnect, remove), with every OpenSSH tool faked (options.sshRun) so nothing connects.
// What it guards: private keys never leave the server (no API reply, devices.json, machine_list, error), a
// stale or foreign draft never saves, agents and API keys reach none of it, an older alias set-up keeps working.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,readdir,stat,writeFile} from 'node:fs/promises';
import {generateKeyPairSync} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {connectionInfo,managedLabel,WINDOWS_ERRORS} from '../server/windows-telemetry.mjs';
import {WINDOWS_SETUP_ERRORS,newId} from '../server/windows-ssh.mjs';
import {parseHostKey} from '../server/ssh-keys.mjs';
import {createHomeDevices} from '../server/home-devices.mjs';
import {hub,SITE} from './hub-helper.mjs';

const fixture=n=>readFile(new URL(`./fixtures/windows-collector-${n}.txt`,import.meta.url),'utf8');
const u32=n=>{const b=Buffer.alloc(4);b.writeUInt32BE(n);return b;},str=b=>Buffer.concat([u32(b.length),Buffer.from(b)]);
const hostKeyBlob=()=>Buffer.concat([str('ssh-ed25519'),str(Buffer.from(generateKeyPairSync('ed25519').publicKey.export({format:'jwk'}).x,'base64url'))]).toString('base64');
const files=async dir=>{try{return (await readdir(dir)).sort();}catch{return [];}};

// A poller that remembers what it was given and reports connections the way the real one does.
function fakePoller(){
 const configs=new Map(),added=[],removed=[];
 return {added,removed,addHost:c=>{added.push(c);configs.set(c.id,c);},removeHost:id=>{removed.push(id);configs.delete(id);},start:async()=>{},stop:()=>{},
  status:()=>({}),live:()=>({}),seconds:()=>[],minutes:()=>[],disks:()=>({}),native:()=>({}),hosts:()=>[...configs.keys()],
  targets:()=>Object.fromEntries([...configs.values()].map(c=>[c.id,c.managed?managedLabel(c.managed):c.target])),
  connections:()=>Object.fromEntries([...configs.values()].map(c=>[c.id,connectionInfo(c)])),
  interval:()=>({intervalSeconds:30,lastPollAt:null}),setIntervalMs:()=>30000,refresh:async()=>false,pause:async()=>{},resume:async()=>{}};
}
async function managedHub(t){
 const text=await fixture(1),hostKey=hostKeyBlob(),runs=[],poller=fakePoller();
 const sshRun=async(args,{binary='ssh'}={})=>{runs.push({binary,args});
  if(binary==='ssh'&&args[0]==='-V')return {code:0,stdout:'',stderr:'OpenSSH_9.6p1, LibreSSL',error:null};
  if(binary==='ssh-keyscan')return args.length?{code:0,stdout:`# ${args.at(-1)}:22 SSH-2.0-OpenSSH_for_Windows_9.5\n${args.at(-1)} ssh-ed25519 ${hostKey}\n`,stderr:'',error:null}:{code:1,stdout:'',stderr:'usage',error:null};
  if(binary==='ssh'&&args[0]==='-F'){const user=args[args.indexOf('-l')+1];
   return user==='refused'?{code:255,stdout:'',stderr:'alice@pc: Permission denied (publickey). /very/secret/key/path',error:null}:{code:0,stdout:text,stderr:'',error:null};}
  return {code:null,stdout:'',stderr:'',error:'spawn'};};
 const h=await hub(t,{windowsPoller:poller,sshRun});
 const ssh=path.join(h.dir,'home','ssh');
 const call=async(url,body,headers=h.admin)=>{const r=await h.post(url,body,headers);return {status:r.status,body:await r.json().catch(()=>({}))};};
 // A draft that has passed its test, for a new device (id omitted) or an existing one.
 const ready=async({id,user='alice',host='pc.example.lan',port=22}={})=>{
  const d=(await call('/api/home/devices/windows/draft',id?{id}:{})).body.draft;
  let k=d.key;if(!k){const r=await call('/api/home/devices/windows/draft/key',{draft:d.id,generate:true});assert.equal(r.status,200,JSON.stringify(r.body));k=r.body.draft.key;}
  if(!d.trusted||d.host!==host||d.port!==port){const s=await call('/api/home/devices/windows/draft/scan',{draft:d.id,host,port});assert.equal(s.status,200,JSON.stringify(s.body));
   assert.equal((await call('/api/home/devices/windows/draft/trust',{draft:d.id,fingerprint:s.body.draft.hostKeys[0].fingerprint})).status,200);}
  const r=await call('/api/home/devices/windows/draft/test',{draft:d.id,host,port,user});assert.equal(r.status,200,JSON.stringify(r.body));
  return {draft:d.id,key:k,form:{host,port,user},result:r.body.result};};
 return {h,ssh,runs,poller,hostKey,call,ready};
}

test('HTTP: add a Windows device with a key the hub made; nothing private leaves the server; the ssh it ran ignores the account\'s own setup',async t=>{
 const {h,ssh,runs,poller,call,ready}=await managedHub(t);
 const tools=await (await fetch(`${h.origin}/api/home/devices/windows/tools`,{headers:h.admin})).json();
 assert.deepEqual(tools,{ok:true,ssh:{ok:true,version:'OpenSSH_9.6p1'},keyscan:{ok:true}});
 const r=await ready();
 assert.equal(r.result.os.caption,'Microsoft Windows 11 Pro');assert.equal(r.result.connection.user,'alice');
 const managed=runs.filter(x=>x.binary==='ssh'&&x.args[0]==='-F').at(-1).args;
 assert.ok(managed[1].startsWith(ssh+path.sep),'the hub\'s own empty configuration');
 assert.ok(managed[managed.indexOf('-i')+1].startsWith(path.join(ssh,'keys')+path.sep),'the hub\'s own key');
 for(const o of ['IdentitiesOnly=yes','IdentityAgent=none','StrictHostKeyChecking=yes','BatchMode=yes'])assert.ok(managed.includes(o),o);
 assert.ok(managed.some(a=>a.startsWith('UserKnownHostsFile="'+path.join(ssh,'known_hosts'))));
 assert.ok(!managed.some(a=>a.startsWith('~')||/[\\/]\.ssh[\\/]|accept-new/.test(a)),'nothing from ~/.ssh, never accept-new');
 const keyscan=runs.find(x=>x.binary==='ssh-keyscan'&&x.args.length).args;assert.ok(!keyscan.includes('-i')&&!keyscan.includes('-l'),'discovery sends no credentials');
 // A form that differs from what was tested is refused, nothing is stored.
 const stale=await call('/api/home/devices',{name:'Office PC',kind:'windows',hostname:'office.example.lan',windows:{draft:r.draft,...r.form,user:'bob'}});
 assert.deepEqual([stale.status,stale.body.error.code,stale.body.error.reason],[409,'WINDOWS_SETUP_FAILED','stale']);
 assert.equal(stale.body.error.message,WINDOWS_SETUP_ERRORS.stale[1]);
 const junk=await call('/api/home/devices',{name:'Office PC',kind:'windows',hostname:'office.example.lan',windows:{draft:r.draft,...r.form,keyFile:'/etc/passwd'}});assert.equal(junk.status,400,'no other field, no path');
 const saved=await call('/api/home/devices',{name:'Office PC',kind:'windows',hostname:'office.example.lan',windows:{draft:r.draft,...r.form}});
 assert.equal(saved.status,201,JSON.stringify(saved.body));assert.equal(saved.body.platform,'windows');
 const cfg=poller.added.at(-1);assert.equal(cfg.id,'office-pc');assert.equal(cfg.managed.user,'alice');assert.equal(cfg.target,'alice@pc.example.lan');
 assert.equal((await call('/api/home/devices',{name:'Office PC 2',kind:'windows',hostname:'office2.example.lan',windows:{draft:r.draft,...r.form}})).body.error.reason,'draft-missing','a draft saves once');
 // Where things are: the private key in the store only, 0600; the connection without it; devices.json without either.
 const [keyFile]=await files(path.join(ssh,'keys'));assert.ok(keyFile);
 if(process.platform!=='win32')assert.equal((await stat(path.join(ssh,'keys',keyFile))).mode&0o777,0o600);
 const pem=await readFile(path.join(ssh,'keys',keyFile),'utf8');assert.match(pem,/PRIVATE KEY/);const pemLine=pem.split('\n')[1];
 const hosts=await readFile(path.join(h.dir,'home','windows-hosts.json'),'utf8'),devicesFile=await readFile(path.join(h.dir,'home','devices.json'),'utf8');
 assert.match(hosts,/"mode": "managed"/);assert.doesNotMatch(hosts,/PRIVATE KEY/);assert.ok(!hosts.includes(pemLine));
 assert.ok(!devicesFile.includes(keyFile)&&!devicesFile.includes('pc.example.lan')&&!devicesFile.includes('alice'),'devices.json holds no connection');
 // The signed-in UI sees public facts; agents (machine_list) not even those; no reply anywhere has the private key or a path.
 const home=await (await fetch(`${h.origin}/api/home`,{headers:h.admin})).json();
 const tile=home.machines.find(m=>m.id==='office-pc');
 assert.deepEqual(tile.telemetry.connection,{mode:'managed',host:'pc.example.lan',port:22,user:'alice',keyFingerprint:r.key.fingerprint,hostKeyFingerprint:cfg.managed.hostKey.fingerprint});
 const list=await (await fetch(`${h.origin}/api/home/machines`,{headers:h.admin})).json();
 for(const body of [home,list,saved.body,stale.body])assert.ok(!JSON.stringify(body).includes(pemLine)&&!/PRIVATE KEY|known_hosts|\/home\/ssh/.test(JSON.stringify(body)));
 assert.ok(!JSON.stringify(list).includes(r.key.fingerprint)&&!JSON.stringify(list).includes('pc.example.lan'),'machine_list carries no connection');
 // A refused login: the code and its sentence, not ssh's output.
 const d2=(await call('/api/home/devices/windows/draft',{})).body.draft;
 await call('/api/home/devices/windows/draft/key',{draft:d2.id,generate:true});
 const s2=await call('/api/home/devices/windows/draft/scan',{draft:d2.id,host:'pc2.example.lan',port:22});await call('/api/home/devices/windows/draft/trust',{draft:d2.id,fingerprint:s2.body.draft.hostKeys[0].fingerprint});
 const refused=await call('/api/home/devices/windows/draft/test',{draft:d2.id,host:'pc2.example.lan',port:22,user:'refused'});
 assert.deepEqual([refused.status,refused.body.error.reason],[422,'denied']);assert.equal(refused.body.error.message,WINDOWS_ERRORS.denied);
 assert.ok(!JSON.stringify(refused.body).includes('/very/secret'),'ssh\'s stderr is never passed on');
 // Cancelled: the draft's key goes at once.
 const before=(await files(path.join(ssh,'keys'))).length;
 assert.equal((await call('/api/home/devices/windows/draft/discard',{draft:d2.id})).status,200);
 assert.equal((await files(path.join(ssh,'keys'))).length,before-1);
});

test('HTTP: imports are checked and never echoed; encrypted keys are refused, not prompted for',async t=>{
 const {call}=await managedHub(t);
 const d=(await call('/api/home/devices/windows/draft',{})).body.draft;
 const rsa=generateKeyPairSync('rsa',{modulusLength:2048});
 const enc=rsa.privateKey.export({type:'pkcs8',format:'pem',cipher:'aes-256-cbc',passphrase:'correct horse battery'});
 const refused=await call('/api/home/devices/windows/draft/key',{draft:d.id,privateKey:enc});
 assert.deepEqual([refused.status,refused.body.error.code,refused.body.error.reason],[422,'WINDOWS_SETUP_FAILED','key-encrypted']);
 assert.ok(!JSON.stringify(refused.body).includes(enc.split('\n')[1]));
 const pub=await call('/api/home/devices/windows/draft/key',{draft:d.id,privateKey:'ssh-ed25519 '+hostKeyBlob()+' a@b'});assert.equal(pub.body.error.reason,'key-public');
 const pem=rsa.privateKey.export({type:'pkcs1',format:'pem'});
 const ok=await call('/api/home/devices/windows/draft/key',{draft:d.id,privateKey:pem});
 assert.equal(ok.status,200);assert.equal(ok.body.draft.key.source,'imported');assert.equal(ok.body.draft.key.bits,2048);
 assert.ok(!JSON.stringify(ok.body).includes(pem.split('\n')[1]),'the reply has only the public key');
 assert.equal((await call('/api/home/devices/windows/draft/key',{draft:d.id,privateKey:'x'.repeat(40000)})).status,413);
 assert.equal((await call('/api/home/devices/windows/draft/key',{draft:d.id,generate:true,privateKey:pem})).status,400);
 assert.equal((await call('/api/home/devices/windows/draft/key',{draft:d.id,generate:true,path:'/etc/ssh/ssh_host_rsa_key'})).status,400,'never a path from the browser');
});

test('HTTP: editing reuses the key and trust; a draft is bound to its device; disconnect and remove delete the hub\'s key; host trust is re-verified explicitly',async t=>{
 const {h,ssh,poller,call,ready}=await managedHub(t);
 const first=await ready();
 assert.equal((await call('/api/home/devices',{name:'Gaming',kind:'windows',hostname:'gaming.example.lan',windows:{draft:first.draft,...first.form}})).status,201);
 const keyBefore=await files(path.join(ssh,'keys')),hostsBefore=await files(path.join(ssh,'known_hosts'));
 // Only the user changes: same key, same verified host key, a new test.
 const edit=(await call('/api/home/devices/windows/draft',{id:'gaming'})).body.draft;
 assert.deepEqual([edit.key.reused,edit.trusted.reused,edit.user,edit.tested],[true,true,'alice',null]);
 assert.equal((await call('/api/home/devices/windows',{id:'gaming',windows:{draft:edit.id,...first.form,user:'bob'}})).body.error.reason,'stale','the form shows another user than the draft was tested with');
 assert.equal((await call('/api/home/devices/windows/draft/test',{draft:edit.id,...first.form,user:'bob'})).status,200);
 // A draft made for this device cannot create another one.
 assert.equal((await call('/api/home/devices',{name:'Other',kind:'windows',hostname:'other.example.lan',windows:{draft:edit.id,...first.form,user:'bob'}})).body.error.reason,'draft-missing');
 assert.equal((await call('/api/home/devices/windows',{id:'gaming',windows:{draft:edit.id,...first.form,user:'bob'}})).status,200);
 assert.equal(poller.added.at(-1).managed.user,'bob');
 assert.deepEqual(await files(path.join(ssh,'keys')),keyBefore,'the key is kept');
 const hostsAfter=await files(path.join(ssh,'known_hosts'));assert.equal(hostsAfter.length,1);assert.notDeepEqual(hostsAfter,hostsBefore,'a new known_hosts; the old one is gone');
 // Re-verify: another host means fetching and confirming its key again before any test.
 const move=(await call('/api/home/devices/windows/draft',{id:'gaming'})).body.draft;
 const moved=await call('/api/home/devices/windows/draft/test',{draft:move.id,host:'gaming2.example.lan',port:22,user:'bob'});
 assert.deepEqual([moved.status,moved.body.error.reason],[409,'needs-scan']);
 await call('/api/home/devices/windows/draft/discard',{draft:move.id});
 assert.deepEqual(await files(path.join(ssh,'keys')),keyBefore,'discarding an edit never deletes the key in use');
 // Disconnect: the poller forgets it, the key and known_hosts go.
 assert.equal((await call('/api/home/devices/windows',{id:'gaming',windows:null})).status,200);
 assert.ok(poller.removed.includes('gaming'));assert.deepEqual([await files(path.join(ssh,'keys')),await files(path.join(ssh,'known_hosts'))],[[],[]]);
 // Remove: the same.
 const again=await ready();
 assert.equal((await call('/api/home/devices',{name:'Desk',kind:'windows',hostname:'desk.example.lan',windows:{draft:again.draft,...again.form}})).status,201);
 assert.equal((await files(path.join(ssh,'keys'))).length,1);
 assert.equal((await call('/api/home/devices/remove',{id:'desk'})).status,200);
 await new Promise(r=>setTimeout(r,20));
 assert.deepEqual(await files(path.join(ssh,'keys')),[],'a removed device takes its key with it');
});

test('HTTP: API keys and agents reach none of it; another person\'s draft does not exist for you',async t=>{
 const {h,call,ready}=await managedHub(t);
 const agent=await h.account('agent',['read','home:write']);
 const asAgent=(url,body)=>fetch(h.origin+url,{method:body===undefined?'GET':'POST',headers:{...agent.headers,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 const d=(await call('/api/home/devices/windows/draft',{})).body.draft;
 for(const [url,body] of [['/api/home/devices/windows/tools'],['/api/home/devices/windows/draft',{}],['/api/home/devices/windows/draft/key',{draft:d.id,generate:true}],
  ['/api/home/devices/windows/draft/scan',{draft:d.id,host:'pc',port:22}],['/api/home/devices/windows/draft/test',{draft:d.id,host:'pc',port:22,user:'a'}],
  ['/api/home/devices/windows/draft/discard',{draft:d.id}],['/api/home/devices/windows',{id:'x',windows:{draft:d.id,host:'pc',port:22,user:'a'}}]])
  assert.equal((await asAgent(url,body)).status,403,url);
 // machine_upsert takes no connection, key or path.
 for(const extra of [{windows:{draft:d.id}},{telemetryProvider:'windows'},{sshKey:'x'},{keyFile:'/etc/passwd'}]){
  const r=await asAgent('/api/home/machines',{machine:{id:'pc',name:'PC',hostname:'pc.example.lan',...extra}});assert.equal(r.status,400,JSON.stringify(extra));}
 // Unauthenticated: nothing.
 assert.equal((await fetch(`${h.origin}/api/home/devices/windows/draft`,{method:'POST',headers:{Origin:h.origin,'Content-Type':'application/json'},body:'{}'})).status,401);
 // A signed-in reader (no write access) reaches none of it either; whose draft it is was checked in the draft tests.
 const created=await (await h.post('/api/admin/users',{username:'guest',name:'Guest'},h.admin)).json();
 const login=await h.post('/api/session',{username:'guest',password:created.initialPassword});
 const viewer={Cookie:login.headers.get('set-cookie').split(';')[0]};
 assert.equal((await fetch(`${h.origin}/api/home/devices/windows/tools`,{headers:viewer})).status,403);
 for(const [url,body] of [['/api/home/devices/windows/draft',{}],['/api/home/devices/windows/draft/scan',{draft:d.id,host:'pc',port:22}]])
  assert.equal((await call(url,body,viewer)).status,403,url);
 // Made-up or malformed ids.
 for(const draft of ['d'+'0'.repeat(32),'../../etc/passwd',42])assert.equal((await call('/api/home/devices/windows/draft/scan',{draft,host:'pc',port:22})).status,404);
 for(const [host,port] of [['-oProxyCommand=id',22],['pc',0],['pc','22'],['a b',22]])assert.equal((await call('/api/home/devices/windows/draft/scan',{draft:d.id,host,port})).status,400,`${host}:${port}`);
 assert.ok((await ready()).draft);
});

test('device store: an older alias set-up keeps working and is never rewritten by a managed one; managed entries are checked',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'win-managed-store-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const legacyHosts={schema:1,hosts:[{id:'desk',target:'pc-windows'}]};
 await writeFile(path.join(dir,'devices.json'),JSON.stringify({schema:1,devices:[
  {id:'desk',name:'Desk',kind:'other',hostname:'desk.example.lan',ip:null,props:{},image:false,platform:'windows',telemetryProvider:'windows'},
  {id:'gaming',name:'Gaming',kind:'other',hostname:'gaming.example.lan',ip:null,props:{},image:false}]}));
 await writeFile(path.join(dir,'windows-hosts.json'),JSON.stringify(legacyHosts));
 const d=createHomeDevices(dir,{reserved:SITE.machines.map(m=>m.id)});
 assert.deepEqual(await d.windowsHosts(),[{id:'desk',target:'pc-windows'}],'read as before');
 const hostKey=parseHostKey('ssh-ed25519',hostKeyBlob());
 const managed={mode:'managed',host:'gaming.example.lan',port:22,user:'alice',keyId:newId('k'),connId:newId('c'),keyType:'ssh-rsa',keyFingerprint:'SHA256:'+'C'.repeat(43),publicKey:'ssh-rsa AAAA home-hub',keySource:'generated',hostKey};
 for(const bad of [{...managed,user:"a'b"},{...managed,keyId:'../../x'},{...managed,hostKey:{...hostKey,type:'ssh-dss'}},{...managed,host:'-oX'}])
  await assert.rejects(async()=>d.setWindows('gaming',undefined,{managed:bad}),/invalid/);
 assert.throws(()=>d.setWindows('gaming',{target:'pc'},{managed}),/invalid/,'one or the other');
 const r=await d.setWindows('gaming',undefined,{managed});
 assert.equal(r.windows.managed.keyId,managed.keyId);assert.equal(r.windows.target,'alice@gaming.example.lan');assert.equal(r.previous,null);
 const stored=JSON.parse(await readFile(path.join(dir,'windows-hosts.json'),'utf8'));
 assert.deepEqual(stored.hosts.find(h=>h.id==='desk'),{id:'desk',target:'pc-windows'},'the alias entry is untouched');
 assert.deepEqual((await d.windowsHosts()).map(h=>[h.id,h.target,Boolean(h.managed)]),[['desk','pc-windows',false],['gaming','alice@gaming.example.lan',true]]);
 const secrets=await d.windowsSecrets();assert.ok(secrets.keys.has(managed.keyId)&&secrets.conns.has(managed.connId));
 // Converting the alias: the old entry comes back to the caller (whose key files, if any, it deletes); ~/.ssh is never touched here.
 const conv=await d.setWindows('desk',undefined,{managed:{...managed,host:'desk.example.lan',keyId:newId('k'),connId:newId('c')}});
 assert.deepEqual(conv.previous,{id:'desk',target:'pc-windows'});
 const gone=await d.remove('gaming');assert.equal(gone.windows.keyId,managed.keyId,'the caller gets the entry to clean up');
 if(process.platform!=='win32')assert.equal((await stat(path.join(dir,'windows-hosts.json'))).mode&0o777,0o600);
});
