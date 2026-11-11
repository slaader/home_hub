// App-managed SSH for Windows telemetry, without a network and without ssh: keys made and imported with Node's
// crypto (and never disclosed), the forced isolation of every managed ssh command line, hostile host/user/port and
// path values, the Windows-side PowerShell (escaping, the one account it touches), the private key store (POSIX
// modes, Windows ACLs), the set-up drafts (owner, trust, test and their invalidation, expiry, cleanup) and the
// poller's handling of a managed connection. server/windows-telemetry.mjs and server/windows-ssh.mjs, public/windows-setup.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,readdir,stat,writeFile,mkdir,utimes} from 'node:fs/promises';
import {generateKeyPairSync,createHash,randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {generateKey,importKey,parseHostKey,describeKey,fingerprintOf,KEY_COMMENT} from '../server/ssh-keys.mjs';
import {managedArgs,validWindowsUser,validSshHost,validSshPort,validManaged,MANAGED_OPTIONS,REMOTE_COMMAND,WINDOWS_USER,classifySsh,WINDOWS_ERRORS,
 createWindowsPoller,connectionKey,sshEnv} from '../server/windows-telemetry.mjs';
import {createSshVault,windowsAclScript,createWindowsSetup,keyscanArgs,scanHostKeys,sshTools,collectManaged,aliasOf,newId,WINDOWS_SETUP_ERRORS,DRAFT_LIMITS} from '../server/windows-ssh.mjs';
import {authorizeScript,psLiteral,counterScript,INSTALL_SCRIPT,FINGERPRINT_SCRIPT,WINDOWS_USER as UI_USER,validWindowsUser as uiValidUser} from '../public/windows-setup.js';

const tmp=async t=>{const d=await mkdtemp(path.join(os.tmpdir(),'hh-ssh-'));t.after(()=>rm(d,{recursive:true,force:true}));return d;};
const posix=process.platform!=='win32';
const hasKeygen=(()=>{try{execFileSync('ssh-keygen',['-?'],{stdio:'ignore'});return true;}catch(e){return e.code!=='ENOENT';}})();
const noKeyMaterial=(value,pem)=>{const s=JSON.stringify(value);assert.doesNotMatch(s,/PRIVATE KEY/);if(pem)assert.ok(!s.includes(pem.split('\n')[1]),'no line of the private key');};
// A host key blob as sshd would present it.
const u32=n=>{const b=Buffer.alloc(4);b.writeUInt32BE(n);return b;},str=b=>Buffer.concat([u32(b.length),Buffer.from(b)]);
const ed25519HostKey=()=>{const {publicKey}=generateKeyPairSync('ed25519');const x=Buffer.from(publicKey.export({format:'jwk'}).x,'base64url');
 return Buffer.concat([str('ssh-ed25519'),str(x)]).toString('base64');};

test('keys: a generated key is RSA 3072 in PKCS#1, its public line and fingerprint are OpenSSH\'s; the private part stays out of every description',async()=>{
 const k=await generateKey();
 assert.equal(k.type,'ssh-rsa');assert.equal(k.bits,3072);assert.equal(k.source,'generated');
 assert.match(k.pem,/^-----BEGIN RSA PRIVATE KEY-----\n/);
 assert.match(k.publicKey,/^ssh-rsa [A-Za-z0-9+/]+={0,2} home-hub$/);assert.equal(KEY_COMMENT,'home-hub');
 assert.match(k.fingerprint,/^SHA256:[A-Za-z0-9+/]{43}$/);
 assert.equal(k.fingerprint,fingerprintOf(Buffer.from(k.publicKey.split(' ')[1],'base64')));
 const {pem,...rest}=k;noKeyMaterial(rest,pem);
 // Two keys are two keys.
 assert.notEqual((await generateKey()).fingerprint,k.fingerprint);
});

test('keys: imports of OpenSSH, PKCS#1, SEC1 and PKCS#8 give the same public key; what is stored is a format every OpenSSH reads',()=>{
 const ed=generateKeyPairSync('ed25519'),rsa=generateKeyPairSync('rsa',{modulusLength:2048}),ec=generateKeyPairSync('ec',{namedCurve:'P-384'});
 const viaPkcs8=importKey(ed.privateKey.export({type:'pkcs8',format:'pem'}));
 assert.equal(viaPkcs8.type,'ssh-ed25519');assert.match(viaPkcs8.pem,/^-----BEGIN OPENSSH PRIVATE KEY-----\n/,'Ed25519 is stored as an OpenSSH key');
 const again=importKey(viaPkcs8.pem);// the OpenSSH form reads back to the same key
 assert.equal(again.fingerprint,viaPkcs8.fingerprint);assert.equal(again.publicKey,viaPkcs8.publicKey);
 const r1=importKey(rsa.privateKey.export({type:'pkcs1',format:'pem'})),r8=importKey(rsa.privateKey.export({type:'pkcs8',format:'pem'}));
 assert.equal(r1.fingerprint,r8.fingerprint);assert.equal(r1.bits,2048);assert.match(r8.pem,/^-----BEGIN RSA PRIVATE KEY-----/);
 const e=importKey(ec.privateKey.export({type:'sec1',format:'pem'}));assert.equal(e.type,'ecdsa-sha2-nistp384');assert.match(e.pem,/^-----BEGIN EC PRIVATE KEY-----/);
 // Windows line endings, a BOM and surrounding blanks are fine; the comment is always ours.
 assert.equal(importKey('\uFEFF\r\n'+viaPkcs8.pem.replace(/\n/g,'\r\n')+'\r\n').fingerprint,viaPkcs8.fingerprint);
 assert.ok(viaPkcs8.publicKey.endsWith(' home-hub'));
});

test('keys: ssh-keygen reads what the hub stores and agrees on the public key and fingerprint',{skip:!hasKeygen&&'ssh-keygen is not installed here'},async t=>{
 const dir=await tmp(t);
 const ed=importKey(generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'pem'}));
 for(const [name,k] of [['rsa',await generateKey()],['ed',ed],['ec',importKey(generateKeyPairSync('ec',{namedCurve:'P-256'}).privateKey.export({type:'sec1',format:'pem'}))]]){
  const f=path.join(dir,name);await writeFile(f,k.pem,{mode:0o600});
  const pub=execFileSync('ssh-keygen',['-y','-f',f]).toString().trim().split(' ').slice(0,2).join(' ');
  assert.equal(pub,k.publicKey.split(' ').slice(0,2).join(' '),name);
  assert.equal(execFileSync('ssh-keygen',['-l','-f',f]).toString().split(' ')[1],k.fingerprint,name);
 }
});

// An OpenSSH key file with the given cipher/kdf: what ssh-keygen writes for a passphrase-protected key.
const openSshFile=(cipher,kdf,inner=Buffer.alloc(16))=>`-----BEGIN OPENSSH PRIVATE KEY-----\n${Buffer.concat([Buffer.from('openssh-key-v1\0','latin1'),str(cipher),str(kdf),str(kdf==='none'?'':Buffer.alloc(24)),u32(1),str(Buffer.from(ed25519HostKey(),'base64')),str(inner)]).toString('base64')}\n-----END OPENSSH PRIVATE KEY-----\n`;
test('keys: encrypted, public, PuTTY, weak, mismatched or junk keys are refused with a code, never prompted for, never echoed',()=>{
 const rsa=generateKeyPairSync('rsa',{modulusLength:2048});
 const cases=[
  [rsa.privateKey.export({type:'pkcs8',format:'pem',cipher:'aes-256-cbc',passphrase:'correct horse'}),'key-encrypted'],
  [rsa.privateKey.export({type:'pkcs1',format:'pem',cipher:'aes-256-cbc',passphrase:'correct horse'}),'key-encrypted'],
  [openSshFile('aes256-ctr','bcrypt'),'key-encrypted'],
  [generateKeyPairSync('rsa',{modulusLength:1024}).privateKey.export({type:'pkcs1',format:'pem'}),'key-weak'],
  ['ssh-ed25519 '+ed25519HostKey()+' alice@laptop','key-public'],
  [rsa.publicKey.export({type:'spki',format:'pem'}),'key-public'],
  ['PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\n','key-putty'],
  [openSshFile('none','none',Buffer.concat([u32(7),u32(8)])),'key-format'],// check words differ: corrupt
  ['','key-format'],['hello','key-format'],['-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----','key-format'],
  ['x'.repeat(20000),'key-format'],[42,'key-format'],[null,'key-format']];
 for(const [text,code] of cases){
  let err=null;try{importKey(text);}catch(e){err=e;}
  assert.ok(err,`refused: ${String(text).slice(0,40)}`);assert.equal(err.message,code,String(text).slice(0,40));
  const s=JSON.stringify({message:err.message,...err});
  if(typeof text==='string'&&text.length>60)assert.ok(!s.includes(text.split('\n')[1]?.slice(0,30)||'@@'),'the error carries no part of the key');
 }
 // An OpenSSH Ed25519 key whose header names another public key than its private part makes.
 const good=importKey(generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'pem'})).pem;
 const raw=Buffer.from(good.split('\n').slice(1,-2).join(''),'base64');
 const other=Buffer.from(ed25519HostKey(),'base64');
 const at=raw.indexOf(Buffer.from('ssh-ed25519'))+11+4;// the header's 32-byte public key
 other.subarray(other.length-32).copy(raw,at);
 assert.throws(()=>importKey(`-----BEGIN OPENSSH PRIVATE KEY-----\n${raw.toString('base64')}\n-----END OPENSSH PRIVATE KEY-----\n`),/key-mismatch|key-format/);
});

test('host keys: only accepted types whose blob says the same type; fingerprints as ssh-keygen prints them',()=>{
 const key=ed25519HostKey(),k=parseHostKey('ssh-ed25519',key);
 assert.equal(k.type,'ssh-ed25519');assert.equal(k.fingerprint,'SHA256:'+createHash('sha256').update(Buffer.from(key,'base64')).digest('base64').replace(/=+$/,''));
 assert.equal(parseHostKey('ssh-rsa',key),null,'the blob says ed25519');
 for(const [t,k2] of [['ssh-dss',key],['ssh-ed25519','not base64!'],['ssh-ed25519','AAAA'+'\n'],['ssh-ed25519','x'.repeat(5000)],['ssh-ed25519',key+'=']])assert.equal(parseHostKey(t,k2),null,t);
});

const SPEC={host:'pc.example.lan',port:22,user:'alice',keyFile:'/srv/hub/state/home/ssh/keys/k'+'0'.repeat(32),knownHosts:'/srv/hub/state/home/ssh/known_hosts/c'+'0'.repeat(32),empty:'/srv/hub/state/home/ssh/empty',alias:'hh-'+'0'.repeat(12)};
test('managed ssh: the account\'s own configuration, agent, keys and known_hosts are never used; only validated values reach the command line',()=>{
 const args=managedArgs(SPEC,{platform:'linux'});
 const opt=o=>args.some((a,i)=>a===o&&args[i-1]==='-o');
 assert.deepEqual(args.slice(0,9),['-F',SPEC.empty,'-T','-i',SPEC.keyFile,'-l','alice','-p','22'],'an empty file is the whole configuration; key, user and port are explicit');
 for(const o of ['IdentitiesOnly=yes','IdentityAgent=none','BatchMode=yes','StrictHostKeyChecking=yes','PasswordAuthentication=no','KbdInteractiveAuthentication=no',
  'PreferredAuthentications=publickey','ProxyCommand=none','ForwardAgent=no','ClearAllForwardings=yes','ControlMaster=no','ControlPath=none','PermitLocalCommand=no','UpdateHostKeys=no','AddKeysToAgent=no'])assert.ok(opt(o),o);
 assert.ok(opt(`UserKnownHostsFile="${SPEC.knownHosts}"`),'only this connection\'s verified host key');
 assert.ok(opt(`GlobalKnownHostsFile="${SPEC.empty}"`),'no system-wide known_hosts, and no /dev/null either');
 assert.ok(opt(`HostKeyAlias=${SPEC.alias}`));
 assert.ok(!args.some(a=>/accept-new|StrictHostKeyChecking=(no|off|ask)|\/dev\/null|^(ProxyJump|LocalCommand|RemoteCommand|KnownHostsCommand)=/i.test(a)),'never a weaker host-key check or a command hook');
 const dash=args.indexOf('--');assert.deepEqual(args.slice(dash+1),['pc.example.lan',REMOTE_COMMAND],'the host after "--", then only the fixed collector');
 assert.ok(MANAGED_OPTIONS.every(o=>/^[A-Za-z0-9]+=[A-Za-z0-9-]+$/.test(o)),'fixed options, no values from outside');
 // Windows paths: forward slashes, quoted (a profile path may contain spaces).
 const win=managedArgs({...SPEC,keyFile:'C:\\Users\\alice smith\\hub\\keys\\k1',knownHosts:'C:\\Users\\alice smith\\hub\\kh',empty:'C:\\Users\\alice smith\\hub\\empty'},{platform:'win32'});
 assert.ok(win.includes('UserKnownHostsFile="C:/Users/alice smith/hub/kh"'));assert.equal(win[1],'C:\\Users\\alice smith\\hub\\empty');
 // Hostile values never make it into an argument list.
 const hostileHosts=['-oProxyCommand=id','pc.example.lan -p 2','a b','$(id)','`id`','pc;id','pc|id','%h','host:22','[::1]','@pc','pc/x','pc\\x','.pc','pc..lan','','x'.repeat(300),null,42];
 for(const host of hostileHosts)assert.throws(()=>managedArgs({...SPEC,host}),/invalid/,String(host));
 for(const port of [0,65536,-1,22.5,'22','22 -oX',null,NaN])assert.throws(()=>managedArgs({...SPEC,port}),/invalid/,String(port));
 for(const user of ['-oProxyCommand=id','al"ice',"al'ice",'al`ice','al$ice','%u','al%ice','a;b','a|b','a&b','a\nb','a\tb',' alice','alice ','alice.','a  b','a\\b\\c','\\alice','alice@-x','alice@','x'.repeat(200),'',null])
  assert.throws(()=>managedArgs({...SPEC,user}),/invalid/,JSON.stringify(user));
 for(const p of ['/srv/%d/key','/srv/${HOME}/key','/srv/"x"/key','relative/key','~/key','/srv/a\nb'])assert.throws(()=>managedArgs({...SPEC,keyFile:p},{platform:'linux'}),/invalid/,p);
 assert.throws(()=>managedArgs({...SPEC,knownHosts:'/srv/a\\ b'},{platform:'linux'}),/invalid/,'a backslash would be read as an escape on POSIX');
 assert.throws(()=>managedArgs({...SPEC,alias:'pc.example.lan'}),/invalid/);
 // A name is its own argument after -l, so even "alice -oX" (a legal Windows name) is a value, never an option.
 assert.deepEqual(managedArgs({...SPEC,user:'alice -oX'},{platform:'linux'}).slice(5,7),['-l','alice -oX']);
 // What may be a Windows account.
 for(const ok of ['alice','Alice Smith','alice_1','ADMIN-PC\\alice','alice@corp.example.lan','Slávek','Ünal','user.name','_svc'])assert.equal(validWindowsUser(ok),true,ok);
 // The browser has the same rule.
 assert.equal(UI_USER.source,WINDOWS_USER.source);
 for(const s of ['alice','Alice Smith','a  b',"al'ice",'ADMIN-PC\\alice','-x','alice@corp.example.lan','al%ice'])assert.equal(uiValidUser(s),validWindowsUser(s),s);
 assert.equal(validSshHost('10.0.0.30'),true);assert.equal(validSshPort(2222),true);
 // ssh inherits nothing that could ask someone or reach an agent.
 const env=sshEnv({PATH:'/bin',SSH_AUTH_SOCK:'/tmp/agent',SSH_ASKPASS:'/bin/askpass',DISPLAY:':0',SystemRoot:'C:\\Windows'});
 assert.deepEqual(Object.keys(env).sort(),['PATH','SystemRoot']);
});

test('host-key discovery sends no credentials and is bounded; tools are detected without connecting',async()=>{
 assert.deepEqual(keyscanArgs('pc.example.lan',2222),['-T','6','-p','2222','-t','ed25519,ecdsa,rsa','--','pc.example.lan']);
 for(const host of ['-v','a b','$(id)'])assert.throws(()=>keyscanArgs(host,22),/invalid/);
 const key=ed25519HostKey(),calls=[];
 const run=async(args,opts)=>{calls.push({args,opts});return {code:0,stdout:`# pc:22 SSH-2.0-OpenSSH_for_Windows_9.5\npc ssh-rsa ${Buffer.concat([str('ssh-rsa'),str(Buffer.from([1,0,1])),str(randomBytes(64))]).toString('base64')}\npc ssh-ed25519 ${key}\npc ssh-ed25519 ${key}\njunk line\n`,stderr:'',error:null};};
 const keys=await scanHostKeys('pc',22,{run});
 assert.deepEqual(keys.map(k=>k.type),['ssh-ed25519','ssh-rsa'],'preferred type first, duplicates once');
 assert.equal(calls[0].opts.binary,'ssh-keyscan');assert.ok(calls[0].opts.timeoutMs<=15000&&calls[0].opts.maxStdout<=65536);
 assert.ok(!calls[0].args.some(a=>/^-i$|^-l$|IdentityFile|User=/.test(a)),'no key and no user');
 await assert.rejects(scanHostKeys('pc',22,{run:async()=>({code:null,stdout:'',stderr:'',error:'no-ssh'})}),/no-keyscan/);
 await assert.rejects(scanHostKeys('pc',22,{run:async()=>({code:1,stdout:'',stderr:'getaddrinfo pc: nodename nor servname provided',error:null})}),/unresolved/);
 await assert.rejects(scanHostKeys('pc',22,{run:async()=>({code:0,stdout:'',stderr:'',error:null})}),/no-host-key/);
 const tools=await sshTools({run:async(args,{binary='ssh'}={})=>binary==='ssh'?{code:0,stdout:'',stderr:'OpenSSH_9.6p1, OpenSSL 3.0',error:null}:{code:null,stdout:'',stderr:'',error:'no-ssh'}});
 assert.deepEqual(tools,{ok:false,ssh:{ok:true,version:'OpenSSH_9.6p1'},keyscan:{ok:false}},'ssh alone is not enough: the client tools include ssh-keyscan');
 for(const code of ['no-keyscan','no-host-key','key-missing','key-permissions'])assert.ok(WINDOWS_ERRORS[code],code);
 assert.equal(classifySsh({code:255,stderr:'Load key "/x/k": No such file or directory'}),'key-missing');
 assert.equal(classifySsh({code:255,stderr:'WARNING: UNPROTECTED PRIVATE KEY FILE!'}),'key-permissions');
 for(const sentence of Object.values(WINDOWS_ERRORS))assert.doesNotMatch(sentence,/\bMac\b|Terminál|Terminal/,'no message assumes the hub runs on a Mac');
});

test('Windows set-up PowerShell: literals cannot break out; one account, its SID, the right file and ACL; administrators only on purpose',()=>{
 assert.equal(psLiteral("it's"),"'it''s'");assert.equal(psLiteral('a\u2019b'),"'a\u2019\u2019b'",'typographic quotes are quotes to PowerShell too');
 assert.equal(psLiteral('$(Remove-Item C:\\)'),"'$(Remove-Item C:\\)'",'nothing inside a single-quoted literal is expanded');
 for(const bad of ['a\nb','a\rb','a\u0000b','a\u2028b',null,7])assert.throws(()=>psLiteral(bad),/invalid/);
 const pub=`ssh-rsa ${'A'.repeat(40)}== home-hub`;
 const s=authorizeScript('Alice Smith',pub);
 assert.match(authorizeScript('Alice Smith',pub,{allowAdministrator:true}),/\$AllowAdministrator = \$true/);
 assert.match(s,/^\$User = 'Alice Smith'$/m);assert.match(s,new RegExp(`^\\$Key = 'restrict ssh-rsa ${'A'.repeat(40)}== home-hub'$`,'m'));
 assert.match(s,/^\$AllowAdministrator = \$false/m,'an administrator is never authorized without saying so');
 assert.match(s,/NTAccount\(\$User\)\)\.Translate\(\[System\.Security\.Principal\.SecurityIdentifier\]\)/,'by SID, not by a localized name');
 assert.match(s,/Get-LocalGroupMember -SID 'S-1-5-32-544'/);assert.match(s,/administrators_authorized_keys/);assert.match(s,/'S-1-5-32-544', 'S-1-5-18'/);
 assert.match(s,/Win32_UserProfile/);assert.match(s,/authorized_keys'/);assert.match(s,/SetAccessRuleProtection\(\$true, \$false\)/);assert.match(s,/New-Object System.Security.AccessControl.FileSecurity/);
 assert.match(s,/\$text\.Contains\(\$KeyBody\)/,'added once');
 assert.doesNotMatch(s,/New-LocalUser|net user|Add-LocalGroupMember|Set-NetFirewall|Disable-|EnableLUA|sshd_config|Set-ItemProperty|Remove-Item/i,'no account, group, firewall, UAC or sshd change');
 assert.equal((s.match(/\$User/g)||[]).length>=4,true);
 for(const user of ["al'ice",'a\nb','-x','a$b','',null])assert.throws(()=>authorizeScript(user,pub),/invalid/,JSON.stringify(user));
 for(const key of [`ssh-rsa AAAA' ; Remove-Item C:\\ ; '`,'ssh-rsa AAAA\nssh-rsa BBBB','ssh-dss '+'A'.repeat(40),`ssh-rsa ${'A'.repeat(40)} evil'comment`,`command="x" ssh-rsa ${'A'.repeat(40)}`,''])
  assert.throws(()=>authorizeScript('alice',key),/invalid/,key);
 assert.match(counterScript('alice'),/-SID 'S-1-5-32-558' -Member 'alice'/);assert.throws(()=>counterScript("x'y"),/invalid/);
 assert.match(INSTALL_SCRIPT,/OpenSSH\.Server~~~~0\.0\.1\.0/);assert.doesNotMatch(INSTALL_SCRIPT,/Disable|EnableLUA|-Enabled False|PasswordAuthentication/i);
 assert.match(FINGERPRINT_SCRIPT,/ssh_host_\*_key\.pub/);assert.match(FINGERPRINT_SCRIPT,/SHA256/);
});

test('key store (POSIX): private directories and files, owned by the hub; known_hosts rewritten from the stored key; orphans swept',{skip:!posix&&'POSIX modes'},async t=>{
 const dir=path.join(await tmp(t),'ssh'),vault=createSshVault(dir);
 const keyId=newId('k'),connId=newId('c'),pem=(await generateKey()).pem;
 await vault.writeKey(keyId,pem);
 for(const d of [dir,path.join(dir,'keys'),path.join(dir,'known_hosts')])assert.equal((await stat(d)).mode&0o777,0o700,d);
 assert.equal((await stat(path.join(dir,'keys',keyId))).mode&0o777,0o600);assert.equal(await readFile(path.join(dir,'keys',keyId),'utf8'),pem);
 assert.equal((await stat(path.join(dir,'empty'))).size,0);
 const hostKey=parseHostKey('ssh-ed25519',ed25519HostKey());
 const record={host:'pc',port:22,user:'alice',keyId,connId,hostKey};
 const spec=await vault.spec(record);
 assert.equal(await readFile(spec.knownHosts,'utf8'),`${aliasOf(connId)} ssh-ed25519 ${hostKey.key}\n`,'written when missing');
 assert.equal((await stat(spec.knownHosts)).mode&0o777,0o600);
 await writeFile(spec.knownHosts,'hh-tampered ssh-ed25519 AAAA\n');await vault.spec(record);
 assert.equal(await readFile(spec.knownHosts,'utf8'),`${aliasOf(connId)} ssh-ed25519 ${hostKey.key}\n`,'what is stored wins over a changed file');
 await assert.rejects(vault.spec({...record,keyId:newId('k')}),/key-missing/);
 assert.doesNotThrow(()=>managedArgs(spec,{platform:'linux'}),'what the store gives is a valid command line');
 // A key file nobody refers to (here a stray, group-readable one) is swept.
 const loose=newId('k');await writeFile(path.join(dir,'keys',loose),'x',{mode:0o644});
 // Sweep: what no connection or draft refers to goes; files that are not ours stay.
 await writeFile(path.join(dir,'keys','README'),'not ours');
 const removed=await vault.sweep({keys:new Set([keyId]),conns:new Set([connId])});
 assert.equal(removed,1);assert.deepEqual((await readdir(path.join(dir,'keys'))).sort(),[keyId,'README'].sort());
 assert.equal(await vault.sweep({keys:new Set(),conns:new Set()},{minAgeMs:60000}),0,'young files are spared');
 // A directory that cannot be made private, or a path ssh would misread, is an error.
 const bad=createSshVault(path.join(await tmp(t),'50%off','ssh'));await assert.rejects(bad.writeKey(newId('k'),'x'),/store-path/);
 const other=createSshVault(path.join(await tmp(t),'ssh'),{uid:(process.getuid?.()??0)+1});await assert.rejects(other.writeKey(newId('k'),'x'),/store/);
});

test('key store (Windows): an explicit ACL for the hub\'s own SID and SYSTEM, no inheritance; a failure means nothing is stored',async t=>{
 const dir=path.join(await tmp(t),'ssh'),calls=[];
 const run=async(args,{binary})=>{calls.push([binary,...args]);
  if(binary==='whoami')return {code:0,stdout:'"desktop-x\\\\hub","S-1-5-21-1-2-3-1001"\r\n',stderr:'',error:null};
  return {code:0,stdout:'processed 1 files',stderr:'',error:null};};
 const vault=createSshVault(dir,{platform:'win32',run});
 const keyId=newId('k');await vault.writeKey(keyId,'PEM');
 const aclCalls=calls.filter(c=>c[0]==='powershell.exe');
 assert.ok(aclCalls.length>=4,'every directory and file has an explicit replacement DACL');
 for(const c of aclCalls){
  const script=Buffer.from(c.at(-1),'base64').toString('utf16le');
  assert.match(script,/New-Object System.Security.AccessControl.(DirectorySecurity|FileSecurity)/);
  assert.match(script,/SetAccessRuleProtection\(\$true,\$false\)/);
  assert.match(script,/S-1-5-21-1-2-3-1001/);assert.match(script,/S-1-5-18/);
  assert.match(script,/Set-Acl -LiteralPath/);assert.match(script,/Private ACL verification failed/);
 }
 assert.ok(aclCalls.some(c=>Buffer.from(c.at(-1),'base64').toString('utf16le').includes('DirectorySecurity')));
 assert.equal(calls.filter(c=>c[0]==='whoami').length,1,'the SID is asked once');
 const failing=createSshVault(path.join(await tmp(t),'ssh'),{platform:'win32',run:async(a,{binary})=>binary==='whoami'?{code:0,stdout:'"x","S-1-5-21-9"',stderr:'',error:null}:{code:5,stdout:'',stderr:'Access is denied.',error:null}});
 await assert.rejects(failing.writeKey(newId('k'),'PEM'),/store/);
 await assert.rejects(createSshVault(path.join(await tmp(t),'ssh'),{platform:'win32',run:async()=>({code:null,stdout:'',stderr:'',error:'no-ssh'})}).writeKey(newId('k'),'PEM'),/store/);
});

// A set-up with a real key store, a fake ssh-keyscan and a fake test; the clock is ours.
async function setup(t,{saved}={}){
 const dir=path.join(await tmp(t),'ssh'),vault=createSshVault(dir);
 const hostKeys=[ed25519HostKey(),ed25519HostKey()];let clock=1_000_000,scans=[],tests=[];
 const run=async args=>{scans.push(args);return {code:0,stdout:hostKeys.map(k=>`${args.at(-1)} ssh-ed25519 ${k}`).join('\n'),stderr:'',error:null};};
 const check=async record=>{tests.push(record);if(record.user==='refused')throw new Error('denied');return {os:{caption:'Windows 11'}};};
 const s=createWindowsSetup({vault,run,check,now:()=>clock,saved:saved||(async()=>({keys:new Set(),conns:new Set()}))});
 return {dir,vault,s,scans,tests,hostKeys,tick:ms=>{clock+=ms;},files:async sub=>{try{return (await readdir(path.join(dir,sub))).sort();}catch{return [];}}};
}
const fpOf=key=>parseHostKey('ssh-ed25519',key).fingerprint;
test('drafts: one person\'s, step by step; trust and test are bound to exactly what they were made for',async t=>{
 const {s,scans,tests,hostKeys,files}=await setup(t);
 const draft=await s.create('admin');
 assert.match(draft.id,/^d[a-f0-9]{32}$/);assert.deepEqual([draft.key,draft.trusted,draft.tested],[null,null,null]);
 // Another person, a made-up id or junk: as if it did not exist.
 for(const [owner,id] of [['alice',draft.id],['admin','d'+'0'.repeat(32)],['admin','../../etc'],['admin',null]])await assert.rejects(s.scan(owner,id,{host:'pc',port:22}),/draft-missing/);
 await assert.rejects(s.test('admin',draft.id,{host:'pc',port:22,user:'alice'}),/needs-key/);
 let v=await s.key('admin',draft.id,{generate:true});
 assert.match(v.key.publicKey,/^ssh-rsa /);noKeyMaterial(v);assert.equal((await files('keys')).length,1);
 const firstKey=(await files('keys'))[0];
 v=await s.key('admin',draft.id,{generate:true});assert.deepEqual((await files('keys')).length,1,'the replaced draft key is deleted');assert.notEqual((await files('keys'))[0],firstKey);
 await assert.rejects(s.key('admin',draft.id,{generate:true,privateKey:'x'}),/invalid/);
 await assert.rejects(s.test('admin',draft.id,{host:'pc',port:22,user:'alice'}),/needs-scan/);
 v=await s.scan('admin',draft.id,{host:'pc.example.lan',port:22});
 assert.equal(v.hostKeys.length,2);assert.equal(scans.at(-1).at(-1),'pc.example.lan');
 await assert.rejects(s.trust('admin',draft.id,{fingerprint:fpOf(ed25519HostKey())}),/trust-mismatch/,'only a key the host presented');
 await assert.rejects(s.trust('admin',draft.id,{fingerprint:'SHA256:short'}),/invalid/);
 v=await s.trust('admin',draft.id,{fingerprint:fpOf(hostKeys[1])});assert.equal(v.trusted.fingerprint,fpOf(hostKeys[1]));
 assert.equal((await files('known_hosts')).length,1);
 for(const bad of [{host:'-oX',port:22,user:'alice'},{host:'pc.example.lan',port:0,user:'alice'},{host:'pc.example.lan',port:22,user:"a'b"}])await assert.rejects(s.test('admin',draft.id,bad),/invalid/);
 const r=await s.test('admin',draft.id,{host:'pc.example.lan',port:22,user:'alice'});
 assert.equal(r.result.os.caption,'Windows 11');assert.ok(r.draft.tested);assert.equal(r.result.connection.hostKeyFingerprint,fpOf(hostKeys[1]));
 assert.equal(tests.at(-1).hostKey.key,hostKeys[1],'the test runs with the confirmed key only');
 // Saving: what the form shows must be what was tested, for the device the draft was made for.
 const form={host:'pc.example.lan',port:22,user:'alice'};
 await assert.rejects(s.claim('admin',draft.id,{...form,user:'bob'}),/stale/);
 await assert.rejects(s.claim('admin',draft.id,{...form,port:2222}),/stale/);
 await assert.rejects(s.claim('admin',draft.id,form,{deviceId:'other'}),/draft-missing/);
 await assert.rejects(s.claim('bob',draft.id,form),/draft-missing/);
 const record=await s.claim('admin',draft.id,{...form,host:'PC.example.lan'});
 assert.equal(validManaged(record),true);noKeyMaterial(record);assert.equal(record.hostKey.key,hostKeys[1]);
 await assert.rejects(s.claim('admin',draft.id,form),/busy/,'a claimed draft cannot be saved twice');
 s.commit(draft.id);await assert.rejects(s.claim('admin',draft.id,form),/draft-missing/);
 assert.equal((await files('keys')).length,1,'committed files stay: they belong to the saved connection now');
});

test('drafts: a new host or port drops trust and test; a new user or key drops the test; an old test expires',async t=>{
 const {s,hostKeys}=await setup(t);
 const ready=async()=>{const d=await s.create('admin');await s.key('admin',d.id,{generate:true});await s.scan('admin',d.id,{host:'pc',port:22});
  await s.trust('admin',d.id,{fingerprint:fpOf(hostKeys[0])});await s.test('admin',d.id,{host:'pc',port:22,user:'alice'});return d.id;};
 const form={host:'pc',port:22,user:'alice'};
 let id=await ready();
 await assert.rejects(s.test('admin',id,{...form,host:'pc2'}),/needs-scan/,'another host: the verified key belonged to the old one');
 await assert.rejects(s.claim('admin',id,{...form,host:'pc2'}),/needs-trust/);
 id=await ready();await assert.rejects(s.test('admin',id,{...form,port:2222}),/needs-scan/);
 id=await ready();await s.scan('admin',id,{host:'pc',port:22});await assert.rejects(s.claim('admin',id,form),/needs-trust/,'a new scan needs a new confirmation');
 id=await ready();await assert.rejects(s.test('admin',id,{...form,user:'refused'}),/denied/);await assert.rejects(s.claim('admin',id,form),/stale|needs-test/,'a failed test leaves nothing to save');
 id=await ready();await s.key('admin',id,{generate:true});await assert.rejects(s.claim('admin',id,form),/needs-test/,'another key needs another test');
 id=await ready();const view=await s.trust('admin',id,{fingerprint:fpOf(hostKeys[0])});assert.equal(view.tested,null,'re-confirming drops the test as well');
});

test('drafts: discard, expiry and the per-person limit take their files with them; a reused key is never deleted by a draft',async t=>{
 const ctx=await setup(t),{s,files,hostKeys,tick}=ctx;
 const d=await s.create('admin');await s.key('admin',d.id,{generate:true});await s.scan('admin',d.id,{host:'pc',port:22});await s.trust('admin',d.id,{fingerprint:fpOf(hostKeys[0])});
 assert.equal((await files('keys')).length,1);assert.equal((await files('known_hosts')).length,1);
 await assert.rejects(s.discard('alice',d.id),/draft-missing/);
 assert.equal(await s.discard('admin',d.id),true);assert.deepEqual([await files('keys'),await files('known_hosts')],[[],[]]);
 // Expiry: half an hour after the last step.
 const e=await s.create('admin');await s.key('admin',e.id,{generate:true});tick(DRAFT_LIMITS.ttlMs+1);
 await assert.rejects(s.key('admin',e.id,{generate:true}),/draft-missing/);assert.deepEqual(await files('keys'),[]);
 // A test older than 15 minutes is not enough to save.
 const f=await s.create('admin');await s.key('admin',f.id,{generate:true});await s.scan('admin',f.id,{host:'pc',port:22});await s.trust('admin',f.id,{fingerprint:fpOf(hostKeys[0])});
 await s.test('admin',f.id,{host:'pc',port:22,user:'alice'});tick(DRAFT_LIMITS.testFreshMs+1);
 await assert.rejects(s.claim('admin',f.id,{host:'pc',port:22,user:'alice'}),/needs-test/);
 // Three unfinished drafts per person: the oldest gives way.
 const ids=[];for(let i=0;i<DRAFT_LIMITS.perOwner+1;i++){tick(10);ids.push((await s.create('admin')).id);}
 await assert.rejects(s.discard('admin',f.id),/draft-missing/);await assert.rejects(s.discard('admin',ids[0]),/draft-missing/);
 assert.equal(await s.discard('admin',ids.at(-1)),true);
 // Editing a stored connection: its key and verified host key are reused, and stay when the draft goes.
 const keyId=newId('k');await ctx.vault.writeKey(keyId,(await generateKey()).pem);
 const hk=parseHostKey('ssh-ed25519',hostKeys[0]);
 const current={mode:'managed',host:'pc',port:22,user:'alice',keyId,connId:newId('c'),keyType:'ssh-rsa',keyFingerprint:'SHA256:'+'A'.repeat(43),publicKey:'ssh-rsa AAAA home-hub',keySource:'generated',hostKey:hk};
 const g=await s.create('admin',{deviceId:'pc',current});
 assert.deepEqual([g.host,g.user,g.key.reused,g.trusted.reused,g.trusted.fingerprint],['pc','alice',true,true,hk.fingerprint]);
 await s.test('admin',g.id,{host:'pc',port:22,user:'bob'});// only the user changes: no new key, no new trust
 assert.equal((await s.claim('admin',g.id,{host:'pc',port:22,user:'bob'},{deviceId:'pc'})).keyId,keyId);await s.release(g.id);
 await s.discard('admin',g.id);assert.ok((await files('keys')).includes(keyId),'the stored connection keeps its key');
 // forget(): a replaced or removed connection's files go, unless kept.
 await s.forget(current,{keep:{keyId}});assert.ok((await files('keys')).includes(keyId));
 await s.forget(current);assert.ok(!(await files('keys')).includes(keyId));
 for(const code of Object.keys(WINDOWS_SETUP_ERRORS))assert.ok(Array.isArray(WINDOWS_SETUP_ERRORS[code])&&WINDOWS_SETUP_ERRORS[code][1].length>10,code);
});

test('drafts: a discard during a step waits for it; the start-up sweep keeps only what saved connections use',async t=>{
 let saved={keys:new Set(),conns:new Set()};
 const ctx=await setup(t,{saved:async()=>saved}),{s,files}=ctx;
 const d=await s.create('admin');const generating=s.key('admin',d.id,{generate:true});
 assert.equal(await s.discard('admin',d.id),true);await generating;
 assert.deepEqual(await files('keys'),[],'the key made meanwhile is deleted with the draft');
 // Orphans from before a restart (no draft survives one) go; a saved connection's files stay.
 const keep=newId('k'),orphan=newId('k'),conn=newId('c');
 await ctx.vault.writeKey(keep,'A');await ctx.vault.writeKey(orphan,'B');await ctx.vault.writeKnownHosts(conn,parseHostKey('ssh-ed25519',ctx.hostKeys[0]));
 saved={keys:new Set([keep]),conns:new Set()};
 const old=new Date(Date.now()-120000);
 await utimes(path.join(ctx.dir,'keys',orphan),old,old);
 await utimes(path.join(ctx.dir,'known_hosts',conn),old,old);
 const fresh=newId('k');await ctx.vault.writeKey(fresh,'C');
 assert.equal(await s.sweep({startup:true}),2);await ctx.vault.deleteKey(fresh); assert.deepEqual(await files('keys'),[keep]);assert.deepEqual(await files('known_hosts'),[]);
 // An unreadable device store deletes nothing.
 const broken=createWindowsSetup({vault:ctx.vault,saved:async()=>{throw new Error('Invalid devices file');}});
 assert.equal(await broken.sweep({startup:true}),0);assert.deepEqual(await files('keys'),[keep]);
});

test('poller: a managed connection is collected through the hub\'s files; any change of it is a new connection; only public facts are shown',async t=>{
 const dir=await tmp(t),hostKey=parseHostKey('ssh-ed25519',ed25519HostKey());
 const managed={mode:'managed',host:'pc.example.lan',port:2222,user:'alice',keyId:newId('k'),connId:newId('c'),keyFingerprint:'SHA256:'+'B'.repeat(43),publicKey:'ssh-rsa AAAA home-hub',hostKey};
 const snap={t:Date.now(),os:{caption:'W',version:'10',memTotal:8e9,bootUnix:null},cpuName:[],cpu:new Map([['_Total',{idle:0n,ts:1n}]]),avail:4e9,swapUsed:null,volumes:[],disk:null,net:[],gpuTs:null,gpu:new Map(),gmem:[],adapters:[]};
 const seen=[];
 const p=createWindowsPoller({stateDirectory:dir,hosts:async()=>[{id:'pc',target:'ignored',managed}],collect:async()=>{throw new Error('alias path used');},collectManaged:async m=>{seen.push(m);return snap;}});
 await p.start();p.stop();
 assert.equal(seen.length,1);assert.equal(seen[0].keyId,managed.keyId);assert.equal(p.status().pc.state,'up');
 assert.deepEqual(p.targets(),{pc:'alice@pc.example.lan:2222'});
 assert.deepEqual(p.connections().pc,{mode:'managed',host:'pc.example.lan',port:2222,user:'alice',keyFingerprint:managed.keyFingerprint,hostKeyFingerprint:hostKey.fingerprint});
 assert.ok(!JSON.stringify(p.connections()).includes(managed.keyId),'no key id, no path');
 for(const change of [{user:'bob'},{port:22},{host:'pc2.example.lan'},{keyId:newId('k')},{hostKey:parseHostKey('ssh-ed25519',ed25519HostKey())}]){
  assert.notEqual(connectionKey({managed:{...managed,...change}}),connectionKey({managed}),JSON.stringify(Object.keys(change)));
  p.addHost({id:'pc',managed:{...managed,...change}});assert.equal(p.status().pc,undefined,'readings of the old connection never show for the new one');
  await p.poll();
 }
 p.addHost({id:'pc',managed:{...managed,user:"a'b"}});assert.notEqual(p.targets().pc,"a'b@pc.example.lan:2222",'an invalid connection is never taken');
 // A managed collection needs its key file; collectManaged validates before building anything.
 await assert.rejects(collectManaged({...managed,host:'-oX'},{vault:{spec:async()=>{throw new Error('not reached');}}}),/invalid/);
});

test('draft steps and claims reserve the draft before another simultaneous request can enter',async t=>{
 const {s,hostKeys,files}=await setup(t),d=await s.create('admin');
 const both=await Promise.allSettled([s.key('admin',d.id,{generate:true}),s.key('admin',d.id,{generate:true})]);
 assert.equal(both.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(both.find(r=>r.status==='rejected').reason.message,'busy');
 assert.equal((await files('keys')).length,1);
 await s.scan('admin',d.id,{host:'pc',port:22});await s.trust('admin',d.id,{fingerprint:fpOf(hostKeys[0])});
 const form={host:'pc',port:22,user:'alice'};await s.test('admin',d.id,form);
 const claims=await Promise.allSettled([s.claim('admin',d.id,form),s.claim('admin',d.id,form)]);
 assert.equal(claims.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(claims.find(r=>r.status==='rejected').reason.message,'busy');
 await s.release(d.id);await s.discard('admin',d.id);
});
