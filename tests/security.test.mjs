import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {buildSecurity,parseAuthorizedLine,parseProbe,sudoVerdict,classifyKey,readableComment,fingerprintOf} from '../server/security-data.mjs';
import {createHandler} from '../server/index.mjs';
import {hashPassword} from '../server/auth.mjs';

// Throwaway public keys (private halves discarded); fingerprints from ssh-keygen -lf.
const A={pub:'AAAAC3NzaC1lZDI1NTE5AAAAIFfQ8Wbh6Bm3L2SvIBI8IhN2Z4+/6xWmUrll9fX44L6N',fp:'SHA256:hw9LTx1XLrOYQQmR5CvKNvxy8zEUy+t8ZjYo44mM6zg'};
const B={pub:'AAAAC3NzaC1lZDI1NTE5AAAAIDia2/QPcp+YZqgHSzGzCRJgmOljAYsfVR2qjoJPDego',fp:'SHA256:8bX+tphjMek330TUGqiYcVLJAp/KUNNHcg7EImOoLBM'};
const T='\t';
const rec=(...f)=>f.join(T);

test('fingerprints match ssh-keygen',()=>{
 assert.equal(fingerprintOf(A.pub),A.fp);
 assert.equal(fingerprintOf(B.pub),B.fp);
});

test('authorized_keys options: quoted commas, from list, restrict, permitopen',()=>{
 const e=parseAuthorizedLine(`from="10.0.0.25,10.0.0.220",command="python3 -u relay.py a,b",no-pty,restrict,permitopen="127.0.0.1:8788" ssh-ed25519 ${A.pub} mac mini key`);
 assert.equal(e.fingerprint,A.fp);assert.equal(e.type,'ssh-ed25519');assert.equal(e.comment,'mac mini key');
 assert.deepEqual(e.options.from,['10.0.0.25','10.0.0.220']);
 assert.equal(e.options.command,'python3 -u relay.py a,b');
 assert.equal(e.options.restrict,true);assert.deepEqual(e.options.permitOpen,['127.0.0.1:8788']);assert.deepEqual(e.options.flags,['no-pty']);
 assert.equal(parseAuthorizedLine('# comment only'),null);
 assert.equal(parseAuthorizedLine(`ssh-ed25519 ${B.pub}`).comment,'');
});

test('sudo verdicts: password-less ALL, password, limited, expired, none, root',()=>{
 const v=rules=>sudoVerdict({user:'u',uid:501,sudoState:'rules',sudoRules:rules},Date.parse('2026-11-08T12:00:00Z'));
 assert.equal(v(['(ALL) ALL, NOPASSWD: ALL']).level,'nopasswd');
 assert.equal(v(['(ALL) ALL']).level,'password');
 assert.equal(v(['(ALL : ALL) ALL']).level,'password');
 const limited=v(['(root) NOPASSWD: /bin/launchctl kickstart -k system/x, /bin/launchctl bootout system/y']);
 assert.equal(limited.level,'limited');assert.equal(limited.commands.length,2);
 const expired=v(['(root) NOTAFTER=20261106155726Z NOPASSWD: ALL','(ALL) ALL']);
 assert.equal(expired.level,'password');assert.equal(expired.expired.length,1);
 assert.equal(v(['(root) NOTAFTER=20991106155726Z NOPASSWD: ALL']).level,'nopasswd');
 assert.equal(sudoVerdict({user:'x',uid:3001,sudoState:'none',sudoRules:[]}).level,'none');
 assert.equal(sudoVerdict({user:'root',uid:0,sudoState:'rules',sudoRules:['(ALL) ALL']}).level,'root');
});

test('key classification and comment clean-up',()=>{
 assert.equal(classifyKey('/Users/alice/.ssh/id_ed25519',true).kind,'ssh');
 assert.equal(classifyKey('/Users/alice/local-ai/runtime/forgejo/data/ssh/forgejo.ed25519',true).kind,'ssh-host');
 assert.equal(classifyKey('/Users/alice/local-ai/runtime/certs/home-wildcard/privkey.pem',true).kind,'tls');
 assert.equal(classifyKey('/mnt/HDDs/Applications/gitea/data/jwt/private.pem',true).kind,'signing');
 assert.equal(classifyKey('/Users/alice/.t3/userdata/secrets/cloud-link-ed25519-key-pair.bin',false).kind,'app');
 assert.equal(readableComment('alice@0e\\303\\257\\302\\277\\302\\275U'),'');
 assert.equal(readableComment('studio->mini'),'studio->mini');
});

// Two machines: key A lives on "studio" and is authorized on "nas" (sudo without password);
// key B is authorized on nas but its private half is nowhere; a stale key C opens nothing.
const studioProbe=[
 rec('HOST','studio','Darwin','alice','1','2026-11-08T12:00:00Z'),rec('NET','10.0.0.151'),rec('LISTEN','on'),
 rec('SSHD','passwordauthentication','yes'),rec('SSHD','allowusers','alice@10.0.0.25'),
 rec('USER','alice','501','/Users/alice','/bin/zsh','1'),rec('SUDO','alice','rule','(ALL) NOPASSWD: ALL'),
 rec('CFG','alice','nas','10.0.0.74','22','admin','~/.ssh/id_a|','','yes'),
 rec('CFG','alice','gone','10.0.0.74','22','root','~/.ssh/id_a|','','yes'),
 rec('KEY','/Users/alice/.ssh/id_a','600','alice','1793480361','OPENSSH','no',`256 ${A.fp} studio->nas (ED25519)`),
 rec('KEY','/Users/alice/.ssh/backup-1/id_a','644','alice','1793480361','OPENSSH','no',`256 ${A.fp} old name (ED25519)`),
 rec('KEY','/Users/alice/.ssh/id_c','600','alice','1793480361','OPENSSH','yes','256 SHA256:ccccccccccccccccccccccccccccccccccccccccccc stale (ED25519)'),
 rec('KEY','/Users/alice/certs/privkey.pem','600','alice','1793480361','','no','256 SHA256:dddd no comment (ECDSA)'),
 rec('END','ok')].join('\n');
const nasProbe=[
 rec('HOST','nas','Linux','admin','1','2026-11-08T12:00:00Z'),rec('NET','10.0.0.74','172.16.0.1'),rec('LISTEN','on'),rec('SSHD','passwordauthentication','no'),
 rec('USER','root','0','/root','/usr/bin/zsh','1'),rec('SUDO','root','rule','(ALL : ALL) ALL'),
 rec('USER','admin','3003','/mnt/home/admin','/usr/bin/zsh','1'),rec('SUDO','admin','rule','(ALL) ALL, NOPASSWD: ALL'),
 rec('AUTH','admin','/mnt/home/admin/.ssh/authorized_keys',`from="10.0.0.151" ssh-ed25519 ${A.pub} studio->nas`),
 rec('AUTH','admin','/mnt/home/admin/.ssh/authorized_keys',`ssh-ed25519 ${B.pub} phone`),
 rec('END','ok')].join('\n');

test('probe records parse into accounts, routes and keys',()=>{
 const h=parseProbe(nasProbe);
 assert.equal(h.complete,true);assert.deepEqual(h.ips,['10.0.0.74','172.16.0.1']);
 assert.equal(h.accounts.length,2);assert.equal(h.auth.length,2);assert.equal(h.auth[0].file,'/mnt/home/admin/.ssh/authorized_keys');
 const s=parseProbe(studioProbe);assert.equal(s.routes[0].identityFiles[0],'~/.ssh/id_a');assert.equal(s.keys[0].encrypted,false);
});

test('build joins keys to what they open and flags the risks',()=>{
 const doc=buildSecurity({probes:{studio:{text:studioProbe},nas:{text:nasProbe},mini:{error:'ssh: connect timed out'}},
  descriptors:{studio:{id:'studio',name:'Mac Studio',addresses:[{ip:'10.0.0.151'}]},nas:{id:'nas',name:'NAS',hostname:'nas.example.lan',addresses:[{ip:'10.0.0.74'}]}},
  forgejo:{users:[{login:'alice',isAdmin:true,keys:[{title:'studio',key:`ssh-ed25519 ${A.pub}`}]}],deployKeys:[]},
  extraMachines:[{id:'router',sshOpen:false,note:'SSH off'}],now:Date.parse('2026-11-08T12:00:00Z')});
 const a=doc.keys.find(k=>k.fingerprint===A.fp);
 assert.equal(a.name,'id_a','label comes from the primary copy, not the backup');assert.equal(a.comment,'studio->nas');
 assert.equal(a.copies.length,2);assert.equal(a.copies.find(c=>c.path.includes('backup')).backup,true);
 const nas=a.access.find(x=>x.target.kind==='host');
 assert.equal(nas.target.machine,'nas');assert.equal(nas.target.user,'admin');assert.deepEqual(nas.target.ips,['10.0.0.74']);
 assert.equal(nas.sudo,'nopasswd');assert.deepEqual(nas.from,['10.0.0.151']);
 assert.ok(a.access.some(x=>x.target.kind==='forgejo'&&x.sudo==='forgejo-admin'));
 assert.equal(a.routes.find(r=>r.alias==='nas').accepted,true);
 assert.equal(a.routes.find(r=>r.alias==='gone').accepted,false,'root@nas does not accept the key');
 assert.deepEqual(doc.unknownAuthorized.map(u=>u.comment),['phone']);
 assert.equal(doc.otherKeys[0].kind,'tls');
 assert.equal(doc.machines.find(m=>m.id==='mini').reachable,false);
 assert.equal(doc.machines.at(-1).id,'router');
 const titles=doc.findings.map(f=>f.title).join('\n');
 assert.match(titles,/klíčů bez passphrase otevírá účet se sudo bez hesla/);
 assert.match(titles,/id_c \(stale\): nikam nevede/);
 assert.match(titles,/soubor čitelný i pro ostatní \(644\)/);
 assert.match(titles,/cizí klíč „phone“/);
 assert.match(titles,/Mac Studio: SSH přijímá i heslo/);
 assert.match(titles,/alias „gone“/);
 assert.equal(doc.findings[0].level,'high','most severe first');
 assert.doesNotMatch(JSON.stringify(doc),/AAAAC3/,'snapshot keeps fingerprints, not key blobs');
});

test('/api/security: sign-in required, admin only, 404 until collected',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'hub-sec-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const origin='http://127.0.0.1:8998',credentials={username:'admin',...hashPassword('test-security-password')};
 const server=http.createServer(createHandler({directory:dir,stateDirectory:dir,credentials,origin,secure:false,bridgeRequest:async()=>{throw new Error('offline');}}));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections?.();return new Promise(r=>server.close(r));});
 const base=`http://127.0.0.1:${server.address().port}`;
 assert.equal((await fetch(`${base}/api/security`)).status,401);
 const login=await fetch(`${base}/api/session`,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify({username:'admin',password:'test-security-password'})});
 assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
 const missing=await fetch(`${base}/api/security`,{headers:{Cookie:cookie}});
 assert.equal(missing.status,404);assert.equal((await missing.json()).error.code,'SECURITY_MISSING');
 const doc=buildSecurity({probes:{nas:{text:nasProbe}},now:Date.now()});
 await mkdir(path.join(dir,'security'),{recursive:true});await writeFile(path.join(dir,'security','ssh-keys.json'),JSON.stringify(doc));
 const ok=await fetch(`${base}/api/security`,{headers:{Cookie:cookie}});
 assert.equal(ok.status,200);assert.equal((await ok.json()).machines[0].id,'nas');
 const js=await fetch(`${base}/security-view.js`);assert.equal(js.status,200);
 const css=await fetch(`${base}/security.css`);assert.equal(css.status,200);
});

test('authorized_keys `restrict` does not count as a command restriction; only command= does',()=>{
 const probe=(opts)=>[
  rec('HOST','nas','Linux','admin','1','2026-11-08T12:00:00Z'),rec('NET','10.0.0.74'),rec('LISTEN','on'),rec('SSHD','passwordauthentication','no'),
  rec('USER','admin','3003','/mnt/home/admin','/usr/bin/zsh','1'),rec('SUDO','admin','rule','(ALL) NOPASSWD: ALL'),
  rec('AUTH','admin','/mnt/home/admin/.ssh/authorized_keys',`${opts} ssh-ed25519 ${A.pub} studio->nas`),rec('END','ok')].join('\n');
 const studio=[rec('HOST','studio','Darwin','alice','1','2026-11-08T12:00:00Z'),rec('NET','10.0.0.151'),rec('LISTEN','on'),
  rec('USER','alice','501','/Users/alice','/bin/zsh','1'),
  rec('KEY','/Users/alice/.ssh/id_a','600','alice','1793480361','OPENSSH','no',`256 ${A.fp} studio->nas (ED25519)`),rec('END','ok')].join('\n');
 const build=opts=>buildSecurity({probes:{studio:{text:studio},nas:{text:probe(opts)}},
  descriptors:{studio:{id:'studio',name:'Mac Studio',addresses:[{ip:'10.0.0.151'}]},nas:{id:'nas',name:'NAS',addresses:[{ip:'10.0.0.74'}]}},now:Date.parse('2026-11-08T12:00:00Z')});
 for(const opts of ['restrict','restrict,permitopen="127.0.0.1:8788"']){
  const doc=build(opts);
  const access=doc.keys.find(k=>k.fingerprint===A.fp).access.find(x=>x.target.kind==='host');
  assert.equal(access.restricted,false,`${opts}: commands are still allowed`);assert.equal(access.noForwarding,true);
  const entry=doc.machines.find(m=>m.id==='nas').accounts[0].authorizedKeys[0];assert.equal(entry.restricted,false);assert.equal(entry.noForwarding,true);
  const titles=doc.findings.map(f=>f.title).join('\n');
  assert.match(titles,/klíčů bez passphrase otevírá účet se sudo bez hesla/,`${opts}: root warning stays`);
  assert.match(titles,/NAS \(admin\): klíč „studio->nas“ bez omezení adresy/,`${opts}: unrestricted-address warning stays`);
 }
 const forced=build('restrict,command="/usr/local/bin/backup-only"');
 const fa=forced.keys.find(k=>k.fingerprint===A.fp).access.find(x=>x.target.kind==='host');
 assert.equal(fa.restricted,true);assert.equal(fa.noForwarding,true);
 const ft=forced.findings.map(f=>f.title).join('\n');
 assert.doesNotMatch(ft,/klíčů bez passphrase otevírá účet se sudo bez hesla/,'a forced command does constrain the key');
 assert.doesNotMatch(ft,/bez omezení adresy/);
});
