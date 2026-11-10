import test from 'node:test';
import assert from 'node:assert/strict';
import tls from 'node:tls';
import {generateKeyPairSync, X509Certificate} from 'node:crypto';
import {mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {encodeFrame, createThermoSession, createThermoPoller} from '../server/thermo-client.mjs';

// Minimal self-signed cert via openssl would need a binary; node can only do keys.
// We instead reuse node's internal test trick: tls server with a fixed fixture cert.
import {execFileSync} from 'node:child_process';
import {readFileSync, mkdtempSync} from 'node:fs';
import {createHash as createHashSync} from 'node:crypto';
// One self-signed fixture cert per run; PIN is its SHA-256 DER fingerprint, which every test
// session must present because unpinned hosts now require CA verification.
let fixture=null;
function cert(){
 if(fixture)return fixture;
 const dir=mkdtempSync(path.join(tmpdir(),'thermo-cert-'));
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(dir,'k.pem'),
  '-out',path.join(dir,'c.pem'),'-days','2','-subj','/CN=localhost','-batch'],{stdio:'ignore'});
 fixture={key:readFileSync(path.join(dir,'k.pem')),cert:readFileSync(path.join(dir,'c.pem'))};
 return fixture;
}
const PIN=createHashSync('sha256').update(new X509Certificate(cert().cert).raw).digest('hex');

function startMockServer(overrides={}){
 const dir=mkdtempSync(path.join(tmpdir(),"thermo-cert-"));const {key,cert:crt}=cert(dir);
 const state={logins:0,hello:0,cursors:[]};
 const server=tls.createServer({key,cert:crt},sock=>{
  let buffer=Buffer.alloc(0);
  sock.on('data',chunk=>{
   buffer=Buffer.concat([buffer,chunk]);
   while(buffer.length>=4){
    const size=buffer.readUInt32BE(0);if(buffer.length<4+size)return;
    const msg=JSON.parse(buffer.subarray(4,4+size).toString('utf8'));buffer=buffer.subarray(4+size);
    handle(msg);
   }
  });
  function send(obj){try{sock.write(encodeFrame(obj));}catch{}}
  function handle(msg){
   if(msg.type==='login'){state.logins++;assert.equal(msg.username,'homehub');assert.ok(msg.password.length>=12);assert.ok(msg.label);
    send({type:'token',token:'tok-'+state.logins,hostID:'HOST-1',name:'mock'});return;}
   if(msg.type==='hello'){state.hello++;assert.equal(msg.token,'tok-1');
    send({type:'ready',major:1,nonce:msg.nonce,serverContinuous:1});return;}
   if(msg.type==='samples'){state.cursors.push(msg.after||null);
    const t0=Math.floor(Date.now()/1000)-2;
    send({type:'samples',nonce:msg.nonce,samples:{session:'6A625D1F-1111-2222-3333-444455556666',observedAt:Date.now()/1000,
     oldestSeq:1,newestSeq:3,gap:false,readings:[
      {seq:1,t:t0,n:4,cpu:10,cpuMax:12,gpu:5,gpuMax:6,cpuTemp:40,cpuTempMax:41,gpuTemp:38,gpuTempMax:39,memUsed:1_000_000,memTotal:2_000_000,power:30,powerMax:35},
      {seq:2,t:t0+1,n:4,cpu:20,cpuMax:22,gpu:7,gpuMax:8,cpuTemp:41,cpuTempMax:42,gpuTemp:39,gpuTempMax:40,memUsed:1_100_000,memTotal:2_000_000,power:32,powerMax:36},
      {seq:3,t:t0+2,n:4,cpu:30,cpuMax:32,gpu:9,gpuMax:10,cpuTemp:42,cpuTempMax:43,gpuTemp:40,gpuTempMax:41,memUsed:1_200_000,memTotal:2_000_000,power:34,powerMax:38}]}});return;}
   if(msg.type==='minutes'){
    if(overrides.pageMinutes){
     const cut=state.cut??=Math.floor(Date.now()/1000)-7200;
     if((msg.afterMinute??0)<cut-1)send({type:'minutes',nonce:msg.nonce,minutes:{observedAt:Date.now()/1000,more:true,rows:[{t:cut-7200,cpu:10,cpuMax:12},{t:cut-1,cpu:11,cpuMax:13}]}});
     else send({type:'minutes',nonce:msg.nonce,minutes:{observedAt:Date.now()/1000,more:false,rows:[{t:Date.now()/1000-60,cpu:20,cpuMax:22,power:30,cpuTemp:50}]}});
     return;}
    send({type:'minutes',nonce:msg.nonce,minutes:{observedAt:Date.now()/1000,more:false,rows:overrides.minuteRows||[
     {t:Math.floor(Date.now()/1000)-60,cpu:11,cpuMax:20,gpu:4,gpuMax:9,cpuTemp:40,cpuTempMax:44,gpuTemp:38,gpuTempMax:41,memUsed:1e6,memTotal:2e6,power:31,powerMax:40,n:240}]}});return;}
   if(msg.type==='disks'){
    send({type:'disks',nonce:msg.nonce,disks:{observedAt:Date.now()/1000,measuredAt:null,disks:[
     {name:'Macintosh HD',mount:'/',fs:'apfs',total:5e11,free:2e11,used:3e11}]}});return;}
  }
 });
 return new Promise(resolve=>{
  server.listen(0,'127.0.0.1',()=>resolve({server,port:server.address().port,state}));
 });
}

test('session logs in, caches token, pages samples/minutes/disks', async()=>{
 const {server,port,state}=await startMockServer();
 const seenMinutes=[];const seenDisks=[];
 const config={id:'mock',host:'127.0.0.1',port,username:'homehub',label:'home-hub',password:'test-password-1234',pin:PIN};
 const session=createThermoSession({config,onMinute:(id,row)=>seenMinutes.push([id,row]),onDisk:(id,reply)=>seenDisks.push([id,reply])});
 const samples=await session.samples({max:600});
 assert.equal(samples.readings.length,3);
 assert.equal(samples.newestSeq,3);
 assert.equal(state.logins,1);
 assert.equal(config.token,'tok-1','token cached for reconnect');
 const mins=await session.minutes({afterMinute:0,max:720});
 assert.equal(mins.rows.length,1);
 assert.equal(seenMinutes.length,0,'solicited minute replies are not re-delivered to onMinute');
 const disks=await session.disks({});
 assert.equal(disks.disks[0].mount,'/');
 assert.equal(seenDisks.length,1);
 const samples2=await session.samples({after:{session:'6A625D1F-1111-2222-3333-444455556666',seq:3},max:600});
 assert.equal(samples2.readings.length,3);
 assert.deepEqual(state.cursors[1],{session:'6A625D1F-1111-2222-3333-444455556666',seq:3},'cursor sent');
 session.close();
 await new Promise(r=>server.close(r));
});

test('denied login sticks and fails fast', async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),"thermo-cert-"));const {key,cert:crt}=cert(dir);
 const server=tls.createServer({key,cert:crt},sock=>{
  let buffer=Buffer.alloc(0);
  sock.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);
   if(buffer.length>=4){const size=buffer.readUInt32BE(0);if(buffer.length<4+size)return;
    const msg=JSON.parse(buffer.subarray(4,4+size).toString('utf8'));
    if(msg.type==='login'||msg.type==='hello')sock.write(encodeFrame({type:'denied'}));}});
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const config={id:'x',host:'127.0.0.1',port:server.address().port,username:'homehub',label:'home-hub',password:'test-password-1234',pin:PIN};
 const session=createThermoSession({config});
 await assert.rejects(()=>session.samples({}),/denied/);
 await assert.rejects(()=>session.samples({}),/denied/,'stays denied, no reconnect storm');
 assert.equal(session.denied(),true);
 session.close();
 await new Promise(r=>server.close(r));
});

test('certificate pin mismatch fails closed, matching pin connects',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'thermo-cert-'));const {key,cert:crt}=cert(dir);
 const {createHash}=await import('node:crypto');
 const der=createHash('sha256').update(crt.toString('utf8').replace(/-----(BEGIN|END) CERTIFICATE-----|\n/g,''),'base64').digest('hex');
 const server=tls.createServer({key,cert:crt},sock=>{let buffer=Buffer.alloc(0);
  sock.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);
   while(buffer.length>=4){const size=buffer.readUInt32BE(0);if(buffer.length<4+size)return;
    const msg=JSON.parse(buffer.subarray(4,4+size).toString('utf8'));buffer=buffer.subarray(4+size);
    if(msg.type==='login')sock.write(encodeFrame({type:'token',token:'tok',hostID:'H',name:'m'}));
    if(msg.type==='samples')sock.write(encodeFrame({type:'samples',nonce:msg.nonce,samples:{session:'6A625D1F-1111-2222-3333-444455556666',observedAt:Date.now()/1000,oldestSeq:1,newestSeq:2,gap:false,readings:[{seq:1,t:Date.now()/1000-1,n:4,cpu:1},{seq:2,t:Date.now()/1000,n:4,cpu:2}]}}));}});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base={id:'x',host:'127.0.0.1',port:server.address().port,username:'homehub',label:'home-hub',password:'test-password-1234',pin:PIN};
 await assert.rejects(()=>createThermoSession({config:{...base,pin:'0'.repeat(64)}}).samples({}),/pin|unavailable/);
 const session=createThermoSession({config:{...base,pin:der}});
 const s=await session.samples({});assert.equal(s.readings.length,2);
 session.close();
 await new Promise(r=>server.close(r));
});
test('poller pages through minute history until more=false', async()=>{
 const {server,port}=await startMockServer({pageMinutes:true});
 const dir=await mkdtemp(path.join(tmpdir(),'thermo-page-'));
 const hostsFile=path.join(dir,'hosts.json');
 await writeFile(hostsFile,JSON.stringify({hosts:[
  {id:'mock',host:'127.0.0.1',port,username:'homehub',password:'test-password-1234',label:'home-hub',pin:PIN}]}));
 const poller=createThermoPoller({hostsFile,stateDirectory:dir});
 await poller.start();
 await new Promise(r=>setTimeout(r,900));
 assert.equal(poller.minutes('mock').length,3,'two backfill rows + one fresh row');
 assert.ok(poller.minutes('mock').every((r,i,a)=>!i||r.t>a[i-1].t),'ascending');
 poller.stop();
 await new Promise(r=>server.close(r));
});
test('poller drains seconds ring, persists minute rows and cursors', async()=>{
 const {server,port}=await startMockServer();
 const dir=await mkdtemp(path.join(tmpdir(),'thermo-state-'));
 const hostsFile=path.join(dir,'hosts.json');
 await (await import('node:fs/promises')).writeFile(hostsFile,JSON.stringify({hosts:[
  {id:'mock',host:'127.0.0.1',port,username:'homehub',password:'test-password-1234',label:'home-hub',pin:PIN}]}));
 const poller=createThermoPoller({hostsFile,stateDirectory:dir,now:()=>Date.now()});
 await poller.start();
 await new Promise(r=>setTimeout(r,200));
 assert.equal(Object.values(poller.status()).every(s=>s.state==='up'),true);
 assert.equal(poller.seconds('mock').length,3);
 assert.equal(poller.minutes('mock').length,1);
 assert.equal(String(poller.disks().mock.disks[0].mount),'/');
 await poller.poll();
 const cursorRaw=JSON.parse(await readFile(path.join(dir,'thermo','cursors.json'),'utf8'));
 assert.equal(cursorRaw.mock.session,'6A625D1F-1111-2222-3333-444455556666');
 assert.equal(Number(cursorRaw.mock.seq),3);
 assert.ok(Number.isFinite(Number(cursorRaw.mock.minute))&&cursorRaw.mock.minute>Date.now()/1000-120,'minute cursor recent');
 const month=new Date().toISOString().slice(0,7);
 const rows=(await readFile(path.join(dir,'thermo',`minutes-mock-${month}.jsonl`),'utf8')).trim().split('\n').map(l=>JSON.parse(l));
 assert.ok(rows.length>=1&&rows[0].t>Date.now()/1000-120);
 poller.stop();
 await new Promise(r=>server.close(r));
});
test('idle socket drop by the server is not an outage; next request reconnects', async()=>{
 const {server,port,state}=await startMockServer();
 const peers=new Set();server.on('secureConnection',s=>peers.add(s));
 const states=[];
 const config={id:'mock',host:'127.0.0.1',port,username:'homehub',label:'home-hub',password:'test-password-1234',pin:PIN};
 const session=createThermoSession({config,onState:(id,s)=>states.push(s)});
 try{
  await session.samples({});
  for(const s of peers)s.destroy();
  await new Promise(r=>setTimeout(r,100));
  assert.equal(session.connected(),false);
  assert.deepEqual(states,['up'],'idle drop must not report down');
  const again=await session.samples({});
  assert.equal(again.readings.length,3);
  assert.equal(state.hello,1,'reconnect reuses cached token');
  assert.deepEqual(states,['up','up']);
 }finally{session.close();await new Promise(r=>server.close(r));}
});
test('ad-hoc refresh pulls now, coalesces concurrent callers and rate-limits to one per 5 s', async()=>{
 const {server,port}=await startMockServer();
 const dir=await mkdtemp(path.join(tmpdir(),'thermo-refresh-'));const hostsFile=path.join(dir,'hosts.json');
 await writeFile(hostsFile,JSON.stringify({hosts:[{id:'mock',host:'127.0.0.1',port,username:'homehub',password:'test-password-1234',label:'home-hub',pin:PIN}]}));
 const poller=createThermoPoller({hostsFile,stateDirectory:dir});
 try{
  await poller.start();
  const [a,b]=await Promise.all([poller.refresh(),poller.refresh()]);
  assert.equal(a,true);assert.equal(b,true,'concurrent caller shares the in-flight pull');
  assert.equal(await poller.refresh(),false,'second pull within 5 s is skipped');
 }finally{poller.stop();await new Promise(r=>server.close(r));}
});
test('expired cached token falls back to password login instead of locking the host out', async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),"thermo-cert-"));const {key,cert:crt}=cert(dir);
 const seen=[];
 const server=tls.createServer({key,cert:crt},sock=>{
  let buffer=Buffer.alloc(0);
  sock.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);while(buffer.length>=4){const size=buffer.readUInt32BE(0);if(buffer.length<4+size)return;const msg=JSON.parse(buffer.subarray(4,4+size).toString('utf8'));buffer=buffer.subarray(4+size);seen.push(msg.type);
   if(msg.type==='hello')sock.write(encodeFrame({type:'denied'}));
   else if(msg.type==='login')sock.write(encodeFrame({type:'token',token:'fresh',hostID:'H',name:'m'}));
   else if(msg.type==='samples')sock.write(encodeFrame({type:'samples',nonce:msg.nonce,samples:{session:'S',newestSeq:1,oldestSeq:1,readings:[]}}));}});
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const config={id:'mock',host:'127.0.0.1',port:server.address().port,username:'homehub',label:'home-hub',password:'test-password-1234',pin:PIN,token:'stale'};
 const states=[];const session=createThermoSession({config,onState:(id,s)=>states.push(s)});
 try{
  const r=await session.samples({});
  assert.equal(r.session,'S');assert.deepEqual(seen.slice(0,3),['hello','login','samples']);
  assert.equal(config.token,'fresh');assert.equal(session.denied(),false);assert.ok(!states.includes('denied'));
 }finally{session.close();await new Promise(r=>server.close(r));}
});
import {parseHostsConfig} from '../server/thermo-client.mjs';
test('review fixes: invalid pins reject the host, valid pins normalise; polls never overlap', async()=>{
 const base={host:'h',password:'x'.repeat(12)};
 assert.equal(parseHostsConfig({hosts:[{...base,pin:'ZZ'}]}).length,0,'typo pin must not silently disable pinning');
 const upper='AB'.repeat(32),colon=Array(32).fill('ab').join(':');
 assert.equal(parseHostsConfig({hosts:[{...base,pin:upper}]})[0].pin,'ab'.repeat(32));
 assert.equal(parseHostsConfig({hosts:[{...base,pin:colon}]})[0].pin,'ab'.repeat(32));
 assert.equal(parseHostsConfig({hosts:[{...base}]})[0].pin,null);
 const {server,port}=await startMockServer();
 const dir=await mkdtemp(path.join(tmpdir(),'thermo-overlap-'));const hostsFile=path.join(dir,'hosts.json');
 await writeFile(hostsFile,JSON.stringify({hosts:[{id:'mock',host:'127.0.0.1',port,username:'homehub',password:'test-password-1234',label:'home-hub',pin:PIN}]}));
 const poller=createThermoPoller({hostsFile,stateDirectory:dir});
 try{await poller.start();const a=poller.poll(),b=poller.poll();assert.equal(a,b,'second caller joins the in-flight poll');await a;
  const rows=(await readFile(path.join(dir,'thermo',`minutes-mock-${new Date().toISOString().slice(0,7)}.jsonl`),'utf8')).trim().split('\n').map(l=>JSON.parse(l).t);
  assert.equal(new Set(rows).size,rows.length,'no duplicate minute rows');
 }finally{poller.stop();await new Promise(r=>server.close(r));}
});
test('credentials are never sent without a matching pin or a CA-verified certificate', async()=>{
 const {key,cert:crt}=cert();
 const received=[];
 const server=tls.createServer({key,cert:crt},sock=>{sock.on('data',chunk=>received.push(chunk.toString('utf8')));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base={id:'x',host:'127.0.0.1',port:server.address().port,username:'homehub',label:'home-hub',password:'secret-password-1234'};
 try{
  // No pin: the self-signed certificate fails normal verification, so the handshake aborts.
  await assert.rejects(()=>createThermoSession({config:{...base}}).samples({}),/unavailable|pin/);
  // No pin, cached token only: same, the token must not leak either.
  await assert.rejects(()=>createThermoSession({config:{...base,password:null,token:'cached-token'}}).samples({}),/unavailable|pin/);
  // Wrong pin (certificate does not match): fails closed before hello/login.
  await assert.rejects(()=>createThermoSession({config:{...base,pin:'ab'.repeat(32)}}).samples({}),/pin|unavailable/);
  // Malformed pin handed straight to the session (bypassing parseHostsConfig) never connects unverified.
  await assert.rejects(()=>createThermoSession({config:{...base,pin:'nope'}}).samples({}),/pin/);
  await new Promise(r=>setTimeout(r,100));
  const wire=received.join('');
  assert.ok(!wire.includes('secret-password-1234'),'password never written to an unverified peer');
  assert.ok(!wire.includes('cached-token'),'token never written to an unverified peer');
 }finally{await new Promise(r=>server.close(r));}
});
