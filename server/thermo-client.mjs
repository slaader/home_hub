// Home Hub → Thermo consumer (build 96 pull API). One persistent, pull-only session per Mac:
// login with an account (username/password/label) once, keep the issued token, then page
// samples/minutes/disks over framed JSON on TLS. Never cadence-subscribe: cadenceMS 0 means
// the server pushes no snapshots, which is what the hub wants.
import tls from 'node:tls';
import {readFile, writeFile, mkdir, rename, readdir} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID, createHash} from 'node:crypto';

// Thermo is a soft dependency: a separate telemetry agent that runs on each machine and has its own
// repository. Without it the hub works and the overview says how to get it. This is the one place that
// names the agent and where to find it.
// TO BE FILLED: replace OWNER with the account the telemetry repository is published under.
export const TELEMETRY_AGENT_NAME='Thermo';
export const TELEMETRY_REPO_URL='https://github.com/OWNER/home-hub-telemetry';
// A machine whose newest reading is older than this is "stale", not "ok" (AGENTS.md: stale after 3 minutes).
export const TELEMETRY_STALE_SECONDS=180;

const MAX_FRAME=1_048_576;
export function encodeFrame(obj){const body=Buffer.from(JSON.stringify(obj));if(!body.length||body.length>MAX_FRAME)throw new Error('invalid');const header=Buffer.allocUnsafe(4);header.writeUInt32BE(body.length,0);return Buffer.concat([header,body]);}
export function createFrameParser(onFrame){
 let buffer=Buffer.alloc(0);
 return chunk=>{
  buffer=Buffer.concat([buffer,chunk]);
  while(buffer.length>=4){
   const size=buffer.readUInt32BE(0);
   if(size===0||size>MAX_FRAME){throw new Error('invalid');}
   if(buffer.length<4+size)break;
   let msg;try{msg=JSON.parse(buffer.subarray(4,4+size).toString('utf8'));}catch{throw new Error('invalid');}
   buffer=buffer.subarray(4+size);onFrame(msg);
  }
 };
}
export function parseHostsConfig(raw){
 const hosts=[];
 for(const entry of Array.isArray(raw?.hosts)?raw.hosts:[]){
  if(typeof entry?.host!=='string'||!entry.host||entry.host.length>253)continue;
  const port=Number.isSafeInteger(entry.port)?entry.port:49286;
  if(port<1024||port>65535)continue;
  const password=typeof entry.password==='string'&&entry.password.length>=12&&entry.password.length<=256?entry.password:null;
  const token=typeof entry.token==='string'&&entry.token.length<=128?entry.token:null;
  if(!password&&!token)continue;
  // A supplied pin that does not parse must never degrade to "no pin". A host without a pin
  // is only reachable through normal CA verification (see connectStable), never unverified.
  let pin=null;
  if(entry.pin!=null){const p=typeof entry.pin==='string'?entry.pin.replace(/:/g,'').toLowerCase():'';if(!/^[a-f0-9]{64}$/.test(p))continue;pin=p;}
  hosts.push({id:String(entry.id||entry.host).slice(0,40),host:entry.host,port,
   username:typeof entry.username==='string'?entry.username.slice(0,32):'homehub',
   label:typeof entry.label==='string'?entry.label.slice(0,40):'home-hub',password,token,
   pin});
 }
 return hosts;
}
export async function loadHostsConfig(file){try{return parseHostsConfig(JSON.parse(await readFile(file,'utf8')));}catch{return [];}}

// Adding a device: read the certificate Thermo presents, sending nothing. The user compares the fingerprint
// with the one the Thermo app shows before any password goes out (it is then pinned).
export function probeThermo({host,port=49286,timeoutMs=5000}){
 return new Promise((resolve,reject)=>{
  const isIp=/^\d+\.\d+\.\d+\.\d+$/.test(host);let done=false;
  const finish=(err,value)=>{if(done)return;done=true;clearTimeout(timer);try{sock.destroy();}catch{}err?reject(err):resolve(value);};
  const sock=tls.connect({host,port,servername:isIp?undefined:host,rejectUnauthorized:false,minVersion:'TLSv1.2'});
  const timer=setTimeout(()=>finish(new Error('unreachable')),timeoutMs);
  sock.on('error',()=>finish(new Error('unreachable')));
  sock.on('secureConnect',()=>{
   let cert=null;try{cert=sock.getPeerCertificate(true);}catch{}
   if(!cert?.raw)return finish(new Error('unreachable'));
   finish(null,{fingerprint:createHash('sha256').update(cert.raw).digest('hex'),subject:String(cert.subject?.CN||'').slice(0,120),validTo:String(cert.valid_to||'').slice(0,60)});
  });
 });
}
// One login with the pinned certificate and one small pull; resolves 'ok', rejects with 'denied', 'pin' or 'unreachable'.
export async function checkThermoLogin(config,{timeoutMs=8000}={}){
 const session=createThermoSession({config});
 try{
  await Promise.race([session.samples({max:1}),new Promise((_,reject)=>setTimeout(()=>reject(new Error('unavailable')),timeoutMs))]);return 'ok';
 }catch(e){throw new Error(session.denied()?'denied':e.message==='pin'?'pin':'unreachable');}
 finally{session.close();}
}

// A single host session. connect() resolves once authenticated; requests queue while offline
// and fail fast after `staleMs` so the poller can mark the source stale instead of hanging.
export function createThermoSession({config,onMinute,onDisk,onState=(()=>{})}){
 const pending=new Map();let socket=null,current=null,connecting=null,deadUntil=0,denied=false,deniedUntil=0,closed=false,lastPull=0;
 // A password denial backs off for 5 min instead of locking the host out forever.
 const DENY_BACKOFF_MS=5*60*1000;
 const nextNonce=()=>randomUUID().replaceAll('-','').slice(0,24);
 // The server throttles pull requests to one per 200 ms per connection; pacing here keeps
 // 'busy' to a rare retry instead of a wasted round-trip each cycle.
 const pace=()=>{const wait=Math.max(0,220-(Date.now()-lastPull));lastPull=Date.now()+wait;return wait?new Promise(r=>setTimeout(r,wait)):Promise.resolve();};
 function hello(){
  const base={major:1,minor:0,windowSeconds:5,cadenceMS:0,nonce:nextNonce()};
  return config.token?{...base,type:'hello',token:config.token}:{...base,type:'login',username:config.username,password:config.password,label:config.label};
 }
 function settle(nonce,error,value){const w=pending.get(nonce);if(!w)return;pending.delete(nonce);clearTimeout(w.timer);error?w.reject(error):w.resolve(value);}
 function flushErrors(error){for(const nonce of [...pending.keys()])settle(nonce,error);}
 // One persistent TLS session per host; login only when no token is cached yet. Requests queue
 // while connecting and fail fast when the socket dies, so the poller marks the source stale.
 async function connectStable(){
  if(denied&&Date.now()<deniedUntil)throw new Error('denied');
  if(denied){denied=false;}
  if(closed)throw new Error('unavailable');
  if(socket)return;
  if(connecting)return connecting;
  const pinned=typeof config.pin==='string'&&/^[a-f0-9]{64}$/.test(config.pin);
  if(config.pin!=null&&!pinned)throw new Error('pin');
  connecting=new Promise((resolve,reject)=>{
   let settled=false;
   const isIp=/^\d+\.\d+\.\d+\.\d+$/.test(config.host);
   // Fail closed: with a pin we authenticate the self-signed certificate ourselves (below,
   // before any credential is written); without one, normal CA + hostname verification must
   // pass, otherwise the handshake errors out and no password/token is ever sent.
   const sock=tls.connect({host:config.host,port:config.port,servername:isIp?undefined:config.host,rejectUnauthorized:!pinned,minVersion:'TLSv1.2'});
   current=sock;let failed=false;const viaToken=Boolean(config.token);
   sock.setTimeout(10000,()=>sock.destroy(new Error('unavailable')));
   const fail=error=>{
    if(failed)return;failed=true;
    const idleDrop=socket===sock&&pending.size===0;
    if(current===sock){socket=null;connecting=null;current=null;}
    if(!closed&&!idleDrop){deadUntil=Date.now()+5000;onState(config.id,'down');}flushErrors(error);
    try{sock.destroy();}catch{}
    if(!settled){settled=true;reject(error);}
   };
   sock.on('error',()=>fail(new Error('unavailable')));
   sock.on('close',()=>fail(new Error('unavailable')));
   const parser=chunk=>{
    try{for(const frame of framesFrom(chunk)){
     if((frame?.type==='token'&&frame.token)||frame?.type==='ready'){if(frame.token)config.token=frame.token;settled=true;connecting=null;socket=sock;deadUntil=0;onState(config.id,'up');resolve({hostID:frame.hostID,name:frame.name});}
     else if(frame?.type==='denied'&&viaToken){
      // Cached token no longer valid (Thermo restarted or the token was rotated): forget it and
      // log in with the password on the very next request instead of marking the host denied.
      delete config.token;failed=true;settled=true;connecting=null;if(current===sock){current=null;}try{sock.destroy();}catch{}flushErrors(new Error('unavailable'));reject(new Error('token-expired'));}
     else if(frame?.type==='denied'){denied=true;deniedUntil=Date.now()+DENY_BACKOFF_MS;settled=true;connecting=null;onState(config.id,'denied');try{sock.destroy();}catch{}flushErrors(new Error('denied'));reject(new Error('denied'));}
     else if(frame?.type==='samples')settle(frame.nonce,null,frame.samples||{});
     else if(frame?.type==='busy')settle(frame.nonce,new Error('busy'));
     else if(frame?.type==='minutes'){const reply=frame.minutes||{};if(!pending.has(frame.nonce)&&Array.isArray(reply.rows))for(const row of reply.rows)onMinute?.(config.id,row);settle(frame.nonce,null,reply);}
     else if(frame?.type==='disks'){const reply=frame.disks||{};if(reply.disks)onDisk?.(config.id,reply);settle(frame.nonce,null,reply);}
    }}catch{try{sock.destroy();}catch{}}
   };
   const carry={buffer:Buffer.alloc(0)};
   function framesFrom(chunk){
    carry.buffer=Buffer.concat([carry.buffer,chunk]);const out=[];
    while(carry.buffer.length>=4){const size=carry.buffer.readUInt32BE(0);if(size===0||size>MAX_FRAME)throw new Error('invalid');if(carry.buffer.length<4+size)break;
     try{out.push(JSON.parse(carry.buffer.subarray(4,4+size).toString('utf8')));}catch{throw new Error('invalid');}carry.buffer=carry.buffer.subarray(4+size);}
    return out;
   }
   sock.on('data',parser);
   sock.on('secureConnect',()=>{
    // Pin the self-signed certificate the way Thermo does: SHA-256 of the DER. Credentials go
    // out only after either the pin matched or Node's CA/hostname verification succeeded.
   if(pinned){
    let der=null;try{der=sock.getPeerCertificate(true)?.raw;}catch{}
    if(!der||createHash('sha256').update(der).digest('hex')!==config.pin){fail(new Error('pin'));return;}
   }else if(!sock.authorized){fail(new Error('pin'));return;}
   try{sock.write(encodeFrame(hello()));}catch{fail(new Error('invalid'));}
   });
  });
  return connecting;
 }
 async function request(type,extra={},timeoutMs=12000){
  if(Date.now()<deadUntil)throw new Error('unavailable');
  try{await connectStable();}catch(e){if(e.message!=='token-expired')throw e;await connectStable();}
  await pace();
  const nonce=nextNonce();
  const value=await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{pending.delete(nonce);reject(new Error('unavailable'));},timeoutMs);
   pending.set(nonce,{resolve,reject,timer});
   try{socket.write(encodeFrame({major:1,minor:0,windowSeconds:5,cadenceMS:0,type,nonce,...extra}));}
   catch{clearTimeout(timer);pending.delete(nonce);reject(new Error('unavailable'));}
  });
  return value;
 }
 return {
  id:config.id,denied:()=>denied,connected:()=>Boolean(socket),
  samples:extra=>request('samples',extra),
  minutes:extra=>request('minutes',extra),
  disks:extra=>request('disks',extra),
  close(){closed=true;try{(current||socket)?.destroy();}catch{}socket=null;current=null;connecting=null;flushErrors(new Error('unavailable'));}
 };
}

// Poller keeps per-host cursors in stateDirectory/thermo/<id>.json, appends received minute
// rows to stateDirectory/thermo/minutes-<id>-<YYYY-MM>.jsonl and serves /api/home windows
// from memory + those files until Postgres rollups take over.
// extraHosts: async () => more host configs (devices added on the Home page); addHost/removeHost change them live.
export function createThermoPoller({hostsFile,extraHosts=async()=>[],stateDirectory,intervalMs=15000,now=Date.now,log=()=>{}}){
 const sessions=new Map(),status=new Map(),minutes=new Map(),disks=new Map(),latest=new Map();
 const seconds=new Map();  // host → [{t,cpu,gpu,cpuTemp,gpuTemp,memUsed,memTotal,power}] ~35 min
 const cursors=new Map();let timer=null;
 const minuteKey=host=>`minutes-${host}`;
 async function persistMinutes(host,rows){
  if(!rows.length)return;
  const dir=path.join(stateDirectory,'thermo');await mkdir(dir,{recursive:true,mode:0o700});
  const month=new Date(rows.at(-1).t*1000).toISOString().slice(0,7);
  const file=path.join(dir,`minutes-${host}-${month}.jsonl`);
  const {appendFile}=await import('node:fs/promises');
  await appendFile(file,rows.map(r=>JSON.stringify(r)).join('\n')+'\n',{mode:0o600});
 }
 async function saveCursors(){
  const dir=path.join(stateDirectory,'thermo');await mkdir(dir,{recursive:true,mode:0o700});
  const tmp=path.join(dir,`cursors.json.${process.pid}.tmp`);const value=Object.fromEntries(cursors);
  await writeFile(tmp,JSON.stringify(value),{mode:0o600});await rename(tmp,path.join(dir,'cursors.json'));
 }
 async function loadCursors(){try{const raw=JSON.parse(await readFile(path.join(stateDirectory,'thermo','cursors.json'),'utf8'));for(const[k,v]of Object.entries(raw))if(Number.isSafeInteger(v?.seq)||Number.isSafeInteger(v?.minute))cursors.set(k,v);}catch{}}
 function rememberMinutes(host,rows){const list=minutes.get(host)||[];for(const r of rows){if(!list.length||r.t>list.at(-1).t)list.push(r);}minutes.set(host,list.slice(-60*24*8));}
 async function pollHost(session){
  try{
   const cursor=cursors.get(session.id)||{};
   const samples=await session.samples(cursor.session?{after:{session:cursor.session,seq:cursor.seq},max:600}:{max:600});
   if(samples?.session&&Number.isSafeInteger(samples.newestSeq)){
    cursors.set(session.id,{...cursors.get(session.id),session:samples.session,seq:samples.newestSeq,gap:samples.gap===true});
    // Drain fills the 5-minute server ring at boot (≤3 fetches), then trickles ~45 s each.
    if(samples.gap===true&&Number.isSafeInteger(samples.oldestSeq))cursors.set(session.id,{...cursors.get(session.id),seq:Math.max(0,samples.oldestSeq-1),gap:false});
   }
   if(Array.isArray(samples?.readings)&&samples.readings.length){
    const ring=seconds.get(session.id)||[];
    for(const r of samples.readings){
     if(!Number.isFinite(r?.t))continue;
     if(ring.length&&r.t<=ring.at(-1).t)continue;
     ring.push({t:r.t,cpu:r.cpu??null,cpuMax:r.cpuMax??null,gpu:r.gpu??null,gpuMax:r.gpuMax??null,powerMax:r.powerMax??null,cpuTempMax:r.cpuTempMax??null,gpuTempMax:r.gpuTempMax??null,cpuTemp:r.cpuTemp??null,gpuTemp:r.gpuTemp??null,memUsed:r.memUsed??null,memTotal:r.memTotal??null,power:r.power??null,gpuMem:r.gpuMem??null,gpuMemAlloc:r.gpuMemAlloc??null,memPressure:r.memPressure??null,swapUsed:r.swapUsed??null});
    }
    const cutoff=now()/1000-35*60;
    while(ring.length&&ring[0].t<cutoff)ring.shift();
    seconds.set(session.id,ring);
    latest.set(session.id,{at:Date.now(),reading:samples.readings.at(-1),gap:samples.gap===true});
   }
   // First boot backfills ~8 days of minute rows (Thermo keeps ~33 d) so the 7d chart is
   // useful immediately; steady state is one cursor-based page per poll.
   const knownMinute=cursors.get(session.id)?.minute||0;
   let afterMinute=Math.max(0,(knownMinute||(now()/1000-8*86400))-1);
   const all=[];
   for(let page=0;page<24;page++){
    const mins=await session.minutes({afterMinute,max:720});
    const pageRows=Array.isArray(mins?.rows)?mins.rows:[];
    all.push(...pageRows);
    if(!mins?.more||!pageRows.length)break;
    afterMinute=pageRows.at(-1).t;
   }
   const rows=all.filter(r=>r.t>knownMinute);
   if(rows.length){
    await persistMinutes(session.id,rows);
    rememberMinutes(session.id,rows);
    const newest=rows.at(-1);cursors.set(session.id,{...cursors.get(session.id),minute:newest.t});
   }
   if(!disks.get(session.id)||now()-(disks.get(session.id)?.fetchedAt||0)>60000)await session.disks({});
   status.set(session.id,{state:session.denied()?'denied':'up',checkedAt:new Date(now()).toISOString()});
  }catch(e){status.set(session.id,{state:session.denied()?'denied':'down',error:e.message,checkedAt:new Date(now()).toISOString()});log(session.id,e.message);}
 }
 const sampleListeners=[];function onSampleLive(id,reading){for(const fn of sampleListeners)fn(id,reading);}
 let lastPollAt=null;
 let polling=null;
 // paused: an administrator turned the integration off (server/integrations.mjs). No session is open and
 // nothing is pulled until resume(); what was read before stays on disk.
 let paused=false,started=false;
 // Every entry point (interval tick, ad-hoc refresh, start) shares one in-flight poll, so two
 // polls never read the same cursor, append the same minute rows or finish out of order.
 function poll(){
  if(paused)return Promise.resolve();
  if(polling)return polling;
  polling=(async()=>{try{await Promise.all([...sessions.values()].map(pollHost));lastPollAt=Date.now();await saveCursors();}finally{polling=null;}})();
  return polling;
 }
 // Pull cadence is user-selectable (15/30/60 s) so the hub never polls the Macs more than needed.
 const ALLOWED_INTERVALS=[15000,30000,60000];
 async function loadInterval(){try{const v=JSON.parse(await readFile(path.join(stateDirectory,'thermo','settings.json'),'utf8')).intervalMs;if(ALLOWED_INTERVALS.includes(v))intervalMs=v;}catch{}}
 async function setIntervalMs(ms){
  if(!ALLOWED_INTERVALS.includes(ms))throw new Error('invalid');
  intervalMs=ms;if(timer){clearInterval(timer);timer=setInterval(()=>void poll(),intervalMs);timer.unref?.();}
  const dir=path.join(stateDirectory,'thermo');await mkdir(dir,{recursive:true,mode:0o700});
  await writeFile(path.join(dir,'settings.json'),JSON.stringify({intervalMs}),{mode:0o600});return intervalMs;
 }
 // On-demand pull for the refresh button: at most one every 5 s, concurrent callers share it.
 let inflight=null,lastAdhoc=0;
 function refresh(){
  if(paused)return Promise.resolve(false);
  if(inflight)return inflight;
  if(Date.now()-lastAdhoc<5000)return Promise.resolve(false);
  lastAdhoc=Date.now();
  // If a scheduled poll is running, wait for it and then pull once more so the result is fresh.
  inflight=(polling?polling.then(()=>poll(),()=>poll()):poll()).then(()=>true).finally(()=>{inflight=null;});return inflight;
 }
 async function restoreMinutes(){
  // Rehydrate the in-memory minute window from the monthly JSONL files we wrote before.
  const dir=path.join(stateDirectory,'thermo');
  let files=[];try{files=await readdir(dir);}catch{return;}
  for(const file of files){
   const m=/^minutes-(.+)-\d{4}-\d{2}\.jsonl$/.exec(file);if(!m)continue;
   const lines=(await readFile(path.join(dir,file),'utf8')).split('\n');
   const rows=[];
   for(const line of lines){if(!line)continue;try{const r=JSON.parse(line);if(Number.isFinite(r?.t))rows.push(r);}catch{}}
   rows.sort((a,b)=>a.t-b.t);
   rememberMinutes(m[1],rows);
  }
 }
 async function start(){
  started=true;
  await loadCursors();await restoreMinutes();await loadInterval();
  if(!paused)await run();
 }
 async function run(){
  const extra=await extraHosts().catch(()=>[]);
  for(const config of [...await loadHostsConfig(hostsFile),...extra])if(!sessions.has(config.id))open(config);
  await poll();clearInterval(timer);timer=setInterval(()=>void poll(),intervalMs);timer.unref?.();
 }
 // Off: stop the clock, wait for a poll in flight, close every session and forget the live readings.
 async function pause(){
  if(paused)return;paused=true;clearInterval(timer);timer=null;
  await polling?.catch(()=>{});
  for(const s of sessions.values())s.close();
  sessions.clear();status.clear();latest.clear();seconds.clear();disks.clear();
 }
 // On again: the same as a start, without reading the files again (hosts are read afresh).
 async function resume(){if(!paused)return;paused=false;if(started)await run();}
 function open(config){
  sessions.set(config.id,createThermoSession({config,onMinute:(id,row)=>{rememberMinutes(id,[row]);void persistMinutes(id,[row]);},onDisk:(id,reply)=>disks.set(id,{...reply,fetchedAt:now()}),onState:(id,state)=>status.set(id,{state,checkedAt:new Date(now()).toISOString()})}));
 }
 // A device added or removed on the Home page: start or end its session without restarting the hub.
 function addHost(config){if(sessions.has(config.id))sessions.get(config.id).close();open(config);if(timer)void poll().catch(()=>{});}
 function removeHost(id){sessions.get(id)?.close();sessions.delete(id);status.delete(id);latest.delete(id);seconds.delete(id);disks.delete(id);}
 return {start,stop:()=>{clearInterval(timer);for(const s of sessions.values())s.close();},poll,refresh,setIntervalMs,addHost,removeHost,pause,resume,paused:()=>paused,
  // Host ids the poller has a login for (the hosts file plus devices connected on the overview).
  hosts:()=>[...sessions.keys()],
  interval:()=>({intervalSeconds:intervalMs/1000,lastPollAt}),
  status:()=>Object.fromEntries(status),
  live:()=>Object.fromEntries(latest),
  disks:()=>Object.fromEntries(disks),
  minutes:host=>minutes.get(host)||[],
  // 1-second readings we drained ourselves; window since unix seconds.
  seconds:(host,sinceUnix)=>{const ring=seconds.get(host)||[];return sinceUnix?ring.filter(r=>r.t>=sinceUnix):[...ring];},
  onSample:fn=>sampleListeners.push(fn)};
}
