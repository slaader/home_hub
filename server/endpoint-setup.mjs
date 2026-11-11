// Set-up drafts for the HTTP(S) telemetry endpoints (Windows over WinRM, Linux over Node Exporter), the
// counterpart of the SSH drafts in server/windows-ssh.mjs. The Add/Edit device dialog builds one connection step
// by step on the server, so nothing the browser holds can stand in for a check it did not pass:
//   certificate  probe: the TLS handshake only (no request, no credential); what the endpoint presents
//   trust        the person approves it: "ca" (only when the certificate verified against the CA store for this
//                host name at the probe) or "pin" (exactly the fingerprint the probe saw)
//   test         one collection with exactly this host, port, scheme, user, password and trust
// Changing host, port or scheme drops the certificate, the trust and the test; changing the user or the
// password drops the test. Saving takes only a draft whose fresh test matches what it holds now and what the
// form shows ("stale" otherwise). The password is one-way: the browser sends it, it is never sent back (a view
// says only whether one is set); editing a connection reuses the stored one until a new one is typed.
// A draft belongs to the signed-in person who made it, is bound to one device (or "a new device") and one
// provider, lives in memory only, and goes with its password when it is discarded, saved or 30 minutes idle.
import {randomBytes} from 'node:crypto';
import {probeCertificate,validEndpointHost,validEndpointPort,normalizePin,CERT_PIN} from './endpoint-http.mjs';
import {validWindowsUser} from './windows-telemetry.mjs';
import {WINRM_PROVIDER,WINRM_PORT,validWinrmPassword,validWinrmRecord} from './winrm-telemetry.mjs';
import {NODE_EXPORTER_PROVIDER,NODE_EXPORTER_PORT,validBasicUser,validExporterPassword,validExporterRecord} from './linux-telemetry.mjs';
import {PROMETHEUS_PROVIDER,PROMETHEUS_PORT,validPromRecord,validPromPassword,validBearer,validLabelValue} from './prometheus-telemetry.mjs';

const fail=(code,detail)=>{throw Object.assign(new Error(code),detail?{detail}:{});};
export const ENDPOINT_DRAFT_ID=/^e[a-f0-9]{32}$/;
export const ENDPOINT_PROVIDERS=Object.freeze([WINRM_PROVIDER,NODE_EXPORTER_PROVIDER,PROMETHEUS_PROVIDER]);
// [HTTP status, sentence in the source language (English in public/i18n-en-home.js)]. None carries a secret.
export const ENDPOINT_SETUP_ERRORS=Object.freeze({
 'draft-missing':[404,'Tohle nastavení spojení vypršelo nebo bylo zavřené. Začni znovu.'],
 busy:[409,'Na tomhle nastavení právě běží jiný krok. Počkej, až doběhne.'],
 'needs-probe':[409,'Nejdřív načti certifikát pro tenhle host a port.'],
 'needs-trust':[409,'Nejdřív porovnej otisk certifikátu s tím na stroji a potvrď ho.'],
 'needs-test':[409,'Nejdřív vyzkoušej spojení s tímhle nastavením.'],
 'needs-password':[409,'Zadej heslo účtu.'],
 stale:[409,'Host, port, schéma nebo uživatel se od zkoušky změnil. Vyzkoušej spojení znovu.'],
 'trust-mismatch':[409,'Tenhle otisk endpoint při posledním načtení neukázal. Načti certifikát znovu.'],
 'ca-unverified':[409,'Certifikát pro tohle jméno neověřila žádná autorita, které Home Hub věří. Porovnej otisk a připni ho, nebo zadej jméno z certifikátu.'],
 'plain-credentials':[422,'Přihlašovací údaje Home Hub posílá jen přes ověřené HTTPS. Pro HTTP nech uživatele i heslo prázdné.'],
 'needs-targets':[409,'Nejdřív načti cíle z Promethea a vyber stroj.'],
 'target-unknown':[409,'Tenhle cíl Prometheus při posledním načtení nenabídl (nebo je pod ním víc strojů). Načti cíle znovu a vyber jeden.'],
 limit:[409,'Rozpracovaných nastavení spojení je moc. Zavři ostatní dialogy, nebo to zkus za půl hodiny.']});
export const ENDPOINT_LIMITS=Object.freeze({ttlMs:30*60000,perOwner:3,total:16,testFreshMs:15*60000});
const DEFAULT_PORT={[WINRM_PROVIDER]:WINRM_PORT,[NODE_EXPORTER_PROVIDER]:NODE_EXPORTER_PORT,[PROMETHEUS_PROVIDER]:PROMETHEUS_PORT};

// check: {winrm(record) → facts, 'node-exporter'(record) → facts, prometheus(record) → facts} (a collection once, then
// what it found); discover(conn) → the node_exporter targets of a Prometheus (server/prometheus-telemetry.mjs).
// A Prometheus draft also chooses its credentials kind (auth none | basic | bearer: the secret is the password or the
// token) and one target: job and instance must be one that the last discovery with this very connection listed as
// eligible, so no label value from the browser reaches PromQL unless Prometheus itself named it.
export function createEndpointSetup({check={},discover=null,probe=probeCertificate,now=Date.now,limits=ENDPOINT_LIMITS}={}){
 const drafts=new Map();
 const sameHost=(a,b)=>String(a||'').toLowerCase()===String(b||'').toLowerCase();
 const connKey=d=>[d.provider,d.host?.toLowerCase(),d.port,d.scheme,d.auth,d.user||'',d.secretVersion,d.trust?.mode||'',d.trust?.pin||''].join('|');
 const testKey=d=>[connKey(d),d.job||'',d.instance||''].join('|');
 const drop=d=>{drafts.delete(d.id);d.password=null;};
 const expire=()=>{const t=now();for(const d of [...drafts.values()])if(!d.busy&&t-d.touched>limits.ttlMs)drop(d);};
 function take(owner,id,provider){
  expire();
  const d=typeof id==='string'&&ENDPOINT_DRAFT_ID.test(id)?drafts.get(id):null;
  if(!d||d.owner!==owner||provider&&d.provider!==provider)fail('draft-missing');
  if(d.busy)fail('busy');
  d.touched=now();return d;
 }
 // One step at a time per draft; a discard during a step takes effect when it ends.
 const step=async(owner,id,fn)=>{const d=take(owner,id);d.busy=true;
  try{return await fn(d);}finally{d.busy=false;d.touched=now();if(d.discarded||drafts.get(d.id)!==d)drop(d);}};
 const where=(d,host,port,scheme)=>{
  if(!validEndpointHost(host))fail('invalid','host must be a host name or an IPv4 address');
  if(!validEndpointPort(port))fail('invalid','port must be 1-65535');
  const s=d.provider===WINRM_PROVIDER?'https':scheme===undefined?d.scheme:scheme;
  if(s!=='http'&&s!=='https')fail('invalid','scheme must be http or https');
  return {host,port,scheme:s};
 };
 // Host, port or scheme changed: whatever was learnt about the old endpoint no longer applies.
 function moveTo(d,{host,port,scheme}){
  if(d.host!==null&&sameHost(d.host,host)&&d.port===port&&d.scheme===scheme)return;
  d.host=host;d.port=port;d.scheme=scheme;d.cert=null;d.trust=null;d.tested=null;d.targets=null;
 }
 const view=d=>({id:d.id,provider:d.provider,device:d.deviceId,host:d.host,port:d.port,scheme:d.scheme,user:d.user,
  ...(d.provider===PROMETHEUS_PROVIDER?{auth:d.auth,job:d.job,instance:d.instance,targets:d.targets&&d.targets.key===connKey(d)?d.targets.list:null}:{}),
  password:{set:Boolean(d.password),reused:d.passwordReused&&Boolean(d.password)},
  certificate:d.cert?{fingerprint:d.cert.fingerprint,subject:d.cert.subject,issuer:d.cert.issuer,altNames:d.cert.altNames,validFrom:d.cert.validFrom,validTo:d.cert.validTo,
   selfSigned:d.cert.selfSigned,caVerified:d.cert.caVerified,hostnameOk:d.cert.hostnameOk}:null,
  trust:d.trust?{mode:d.trust.mode,fingerprint:d.trust.fingerprint||null,reused:Boolean(d.trust.reused)}:null,
  tested:d.tested&&d.tested.key===testKey(d)?{at:new Date(d.tested.at).toISOString()}:null,
  expiresAt:new Date(d.touched+limits.ttlMs).toISOString()});
 const tlsOf=d=>d.scheme==='https'?(d.trust.mode==='pin'?{mode:'pin',pin:d.trust.pin}:{mode:'ca'}):null;
 const record=d=>d.provider===WINRM_PROVIDER
  ?{mode:WINRM_PROVIDER,host:d.host,port:d.port,scheme:'https',user:d.user,password:d.password,tls:tlsOf(d),...(d.trust?.fingerprint?{certFingerprint:d.trust.fingerprint}:{})}
  :d.provider===PROMETHEUS_PROVIDER
  ?{mode:PROMETHEUS_PROVIDER,host:d.host,port:d.port,scheme:d.scheme,tls:tlsOf(d),job:d.job,instance:d.instance,
   auth:d.scheme!=='https'||d.auth==='none'?null:d.auth==='basic'?{type:'basic',user:d.user,password:d.password}:{type:'bearer',token:d.password},
   ...(d.scheme==='https'&&d.trust?.fingerprint?{certFingerprint:d.trust.fingerprint}:{})}
  :{mode:NODE_EXPORTER_PROVIDER,host:d.host,port:d.port,scheme:d.scheme,tls:tlsOf(d),user:d.scheme==='https'&&d.user?d.user:null,password:d.scheme==='https'&&d.user?d.password:null,
   ...(d.scheme==='https'&&d.trust?.fingerprint?{certFingerprint:d.trust.fingerprint}:{})};
 const validRecord=r=>r.mode===WINRM_PROVIDER?validWinrmRecord(r):r.mode===PROMETHEUS_PROVIDER?validPromRecord(r):validExporterRecord(r);
 // The connection without a target (what discovery runs with).
 const connOf=d=>{const r=record(d);return {host:r.host,port:r.port,scheme:r.scheme,tls:r.tls,auth:r.auth};};
 const api={
  // A new draft. current: the device's stored record of this provider, if any: host, port, scheme, user, its
  // password (server-side) and its trust are reused, so changing nothing but the user needs only a new test.
  create(owner,{provider,deviceId=null,current=null}={}){
   if(typeof owner!=='string'||!owner||!ENDPOINT_PROVIDERS.includes(provider))fail('invalid');
   expire();
   const mine=[...drafts.values()].filter(d=>d.owner===owner).sort((a,b)=>a.touched-b.touched);
   while(mine.length>=limits.perOwner){const old=mine.shift();if(old.busy)fail('limit');drop(old);}
   if(drafts.size>=limits.total)fail('limit');
   const d={id:'e'+randomBytes(16).toString('hex'),owner,provider,deviceId,host:null,port:DEFAULT_PORT[provider],scheme:provider===WINRM_PROVIDER?'https':'http',
    user:null,password:null,passwordReused:false,secretVersion:0,cert:null,trust:null,tested:null,busy:false,touched:now(),auth:'none',job:null,instance:null,targets:null};
   if(current&&current.mode===provider&&validRecord(current)){
    if(provider===PROMETHEUS_PROVIDER){const a=current.auth;Object.assign(d,{host:current.host,port:current.port,scheme:current.scheme,auth:a?.type||'none',user:a?.type==='basic'?a.user:null,
     password:a?.password||a?.token||null,passwordReused:Boolean(a),job:current.job,instance:current.instance});}
    else Object.assign(d,{host:current.host,port:current.port,scheme:current.scheme,user:current.user||null,password:current.password||null,passwordReused:Boolean(current.password)});
    if(current.tls)d.trust={host:current.host,port:current.port,mode:current.tls.mode,pin:current.tls.pin||null,fingerprint:current.tls.pin||current.certFingerprint||null,reused:true};
   }
   drafts.set(d.id,d);return view(d);
  },
  // The certificate at host:port, without sending a request or a credential.
  probe:(owner,id,input)=>step(owner,id,async d=>{
   const w=where(d,input?.host,input?.port,'https');moveTo(d,w);
   const facts=await probe({host:w.host,port:w.port});
   d.cert={host:w.host,port:w.port,...facts};d.trust=null;d.tested=null;
   return view(d);}),
  // The person approves the certificate of the last probe of the draft's current host and port.
  trust:(owner,id,input)=>step(owner,id,async d=>{
   const mode=input?.mode;if(mode!=='ca'&&mode!=='pin')fail('invalid','mode must be ca or pin');
   if(d.scheme!=='https'||!d.cert||!sameHost(d.cert.host,d.host)||d.cert.port!==d.port)fail('needs-probe');
   if(mode==='ca'){if(!d.cert.caVerified)fail('ca-unverified');d.trust={host:d.host,port:d.port,mode:'ca',pin:null,fingerprint:d.cert.fingerprint};}
   else{const pin=normalizePin(input?.fingerprint);if(!pin)fail('invalid','fingerprint must be the SHA-256 of the certificate');if(pin!==d.cert.fingerprint)fail('trust-mismatch');
    d.trust={host:d.host,port:d.port,mode:'pin',pin,fingerprint:pin};}
   d.tested=null;return view(d);}),
  // The connection settings of the form (host, port, scheme, credentials) applied to the draft. password: a new
  // one (one-way; for a Prometheus with auth "bearer" it is the token), or absent to keep the draft's.
  // Then what a test or a discovery needs before anything is sent: the right credentials and a verified certificate.
  _apply(d,input){
   const w=where(d,input?.host,input?.port,input?.scheme);moveTo(d,w);
   const prom=d.provider===PROMETHEUS_PROVIDER;
   const auth=prom?(input?.auth===undefined?d.auth:input.auth):null;
   if(prom&&!['none','basic','bearer'].includes(auth))fail('invalid','auth must be none, basic or bearer');
   const user=input?.user===undefined||input.user===null?'':input.user;
   if(typeof user!=='string')fail('invalid','user must be text');
   if(d.provider===WINRM_PROVIDER&&!validWindowsUser(user))fail('invalid','user must be a local Windows account name');
   if(!prom&&d.provider===NODE_EXPORTER_PROVIDER&&user&&!validBasicUser(user))fail('invalid','user: letters, digits, . _ @ -, at most 64');
   if(prom&&auth==='basic'&&!validBasicUser(user))fail('invalid','user: letters, digits, . _ @ -, at most 64');
   if(prom&&auth!=='basic'&&user)fail('invalid','a user goes only with auth basic');
   const password=input?.password,typed=password!==undefined&&password!==null&&password!=='';
   if(typed&&typeof password!=='string')fail('invalid','password must be text');
   if(d.scheme==='http'&&(user||typed||prom&&auth!=='none'))fail('plain-credentials');
   if(prom&&auth!==d.auth){d.auth=auth;d.password=null;d.passwordReused=false;d.secretVersion++;}
   if(typed){
    const ok=d.provider===WINRM_PROVIDER?validWinrmPassword(password):prom?(auth==='bearer'?validBearer(password):validPromPassword(password)):validExporterPassword(password);
    if(!ok)fail('invalid',prom&&auth==='bearer'?'token: 1-4096 characters of a bearer token':d.provider===NODE_EXPORTER_PROVIDER?'password must be 1-72 bytes':'password must be 1-256 characters');
    if(password!==d.password){d.password=password;d.passwordReused=false;d.secretVersion++;}
   }
   if(d.user!==(user||null)){d.user=user||null;d.tested=null;}
   // No credentials chosen: nothing secret is kept.
   const wantsSecret=d.provider===WINRM_PROVIDER||(prom?auth!=='none':Boolean(d.user));
   if(!wantsSecret&&d.password){d.password=null;d.passwordReused=false;d.secretVersion++;}
   if(wantsSecret&&!d.password)fail('needs-password');
   if(d.scheme==='https'){if(!d.trust)fail(d.cert?'needs-trust':'needs-probe');if(!sameHost(d.trust.host,d.host)||d.trust.port!==d.port)fail('needs-probe');}
  },
  // Prometheus only: the node_exporter targets it scrapes, with this connection. Returns {draft, targets}.
  discover:(owner,id,input)=>step(owner,id,async d=>{
   if(d.provider!==PROMETHEUS_PROVIDER||typeof discover!=='function')fail('invalid');
   api._apply(d,input);d.tested=null;
   const list=await discover(connOf(d));
   // Nothing at all: the guide to add a scrape target (an error with its sentence). Only ambiguous ones: listed, none selectable.
   if(!list.length)fail('no-targets');
   d.targets={key:connKey(d),list};
   return {draft:view(d),targets:list};}),
  // One collection with what the form shows. Returns {draft, result}; rejects with the provider's code.
  test:(owner,id,input)=>step(owner,id,async d=>{
   api._apply(d,input);
   if(d.provider===PROMETHEUS_PROVIDER){
    if(!validLabelValue(input?.job)||!validLabelValue(input?.instance))fail('invalid','job and instance of a discovered target are required');
    if(!d.targets||d.targets.key!==connKey(d))fail('needs-targets');
    if(!d.targets.list.some(x=>x.eligible&&x.job===input.job&&x.instance===input.instance))fail('target-unknown');
    if(d.job!==input.job||d.instance!==input.instance){d.job=input.job;d.instance=input.instance;}
   }
   d.tested=null;
   const run=check[d.provider];if(typeof run!=='function')fail('invalid');
   const started=now(),r=record(d);if(!validRecord(r))fail('invalid');
   const result=await run(r);
   d.tested={key:testKey(d),at:now()};
   return {draft:view(d),result:{ok:true,tookMs:now()-started,connection:{provider:d.provider,host:d.host,port:d.port,scheme:d.scheme,user:d.user,
    ...(d.provider===PROMETHEUS_PROVIDER?{auth:d.auth,job:d.job,instance:d.instance}:{}),
    tls:d.trust&&d.scheme==='https'?{mode:d.trust.mode,fingerprint:d.trust.fingerprint}:null},...result}};}),
  // The record to store, if this draft may be saved now for this device with what the form shows. The draft
  // stays reserved (busy) until commit() or release(): two saves of one draft cannot both pass.
  claim(owner,id,input,{deviceId=null,provider}={}){
   const d=take(owner,id,provider);
   if(d.deviceId!==deviceId)fail('draft-missing');
   const w=where(d,input?.host,input?.port,input?.scheme);
   const user=input?.user===undefined||input.user===null||input.user===''?null:input.user;
   if(!sameHost(d.host,w.host)||d.port!==w.port||d.scheme!==w.scheme||(d.user||null)!==user)fail('stale');
   if(d.provider===PROMETHEUS_PROVIDER&&(input?.job!==d.job||input?.instance!==d.instance||(input?.auth??d.auth)!==d.auth))fail('stale');
   if(d.scheme==='https'&&!d.trust)fail('needs-trust');
   if(!d.tested||d.tested.key!==testKey(d)||now()-d.tested.at>limits.testFreshMs)fail('needs-test');
   const r=record(d);if(!validRecord(r))fail('invalid');
   d.busy=true;return r;
  },
  commit(id){const d=drafts.get(id);if(d)drop(d);},
  release(id){const d=drafts.get(id);if(d){d.busy=false;d.touched=now();if(d.discarded)drop(d);}},
  discard(owner,id){
   expire();
   const d=typeof id==='string'&&ENDPOINT_DRAFT_ID.test(id)?drafts.get(id):null;
   if(!d||d.owner!==owner)fail('draft-missing');
   if(d.busy){d.discarded=true;return true;}
   drop(d);return true;},
  // Which provider a draft of this person is for (to word a failure), or null.
  providerOf(owner,id){const d=typeof id==='string'&&ENDPOINT_DRAFT_ID.test(id)?drafts.get(id):null;return d&&d.owner===owner?d.provider:null;},
  sweep(){expire();return 0;},
  size:()=>drafts.size};
 return api;
}
export const validPin=p=>CERT_PIN.test(p||'');
