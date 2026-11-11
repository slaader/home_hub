// The one HTTP(S) transport of the endpoint providers (server/endpoint-http.mjs), against real local servers:
// TLS is verified before a request exists (no Authorization header ever reaches an unverified or wrong-pin
// server), credentials never go over plain HTTP, no redirect is followed, compressed or oversized replies are
// refused, a hung server is cut off, and the certificate probe sends nothing but a handshake.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import net from 'node:net';
import {readFileSync} from 'node:fs';
import {createHash,X509Certificate} from 'node:crypto';
import {endpointRequest,probeCertificate,normalizePin,groupsOf} from '../server/endpoint-http.mjs';

const fx=n=>readFileSync(new URL(`./fixtures/${n}`,import.meta.url));
const [cert,key,otherCert,otherKey]=['tls-test.crt','tls-test.key','tls-other.crt','tls-other.key'].map(fx);
const pin=pem=>createHash('sha256').update(new X509Certificate(pem).raw).digest('hex');
async function serve(t,handler,{secure=false,pair=[cert,key]}={}){
 const seen=[];
 const s=secure?https.createServer({cert:pair[0],key:pair[1]},(q,r)=>{seen.push({url:q.url,auth:q.headers.authorization||null});handler(q,r);}):http.createServer((q,r)=>{seen.push({url:q.url,auth:q.headers.authorization||null});handler(q,r);});
 await new Promise(r=>s.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{s.closeAllConnections?.();s.close(r);}));
 return {port:s.address().port,seen};
}
const ok=(q,r)=>{r.writeHead(200,{'Content-Type':'text/plain'});r.end('hello');};

test('plain HTTP: a fixed path and query, never credentials, no redirects, no compression, bounded and timed',async t=>{
 const {port,seen}=await serve(t,(q,r)=>{
  if(q.url.startsWith('/redirect')){r.writeHead(302,{Location:'http://10.0.0.9/x'});return r.end();}
  if(q.url.startsWith('/gzip')){r.writeHead(200,{'Content-Encoding':'gzip'});return r.end('x');}
  if(q.url.startsWith('/big')){r.writeHead(200);return r.end('x'.repeat(5000));}
  if(q.url.startsWith('/hang'))return;
  ok(q,r);});
 const r=await endpointRequest({host:'127.0.0.1',port,path:'/metrics',query:{query:'up{job="a b"}'}});
 assert.equal(r.body.toString(),'hello');assert.equal(seen.at(-1).url,'/metrics?query=up%7Bjob%3D%22a+b%22%7D');
 await assert.rejects(endpointRequest({host:'127.0.0.1',port,path:'/metrics',headers:{Authorization:'Basic eA=='}}),/invalid/,'no credentials over plain HTTP');
 assert.ok(!seen.some(x=>x.auth),'nothing with credentials reached the server');
 await assert.rejects(endpointRequest({host:'127.0.0.1',port,path:'/redirect'}),/redirect/);
 assert.equal(seen.filter(x=>x.url==='/x').length,0,'a redirect is never followed');
 await assert.rejects(endpointRequest({host:'127.0.0.1',port,path:'/gzip'}),/encoded/);
 await assert.rejects(endpointRequest({host:'127.0.0.1',port,path:'/big',maxBytes:1000}),/too-large/);
 await assert.rejects(endpointRequest({host:'127.0.0.1',port,path:'/hang',timeoutMs:150}),/timeout/);
 for(const bad of [{host:'-oX',path:'/m'},{host:'a b',path:'/m'},{host:'127.0.0.1',path:'http://x/'},{host:'127.0.0.1',path:'/m?x=1'},{host:'127.0.0.1',path:'/../etc'.replace('..','%2e%2e')},{host:'127.0.0.1',path:'/m',query:{'a&b':'x'}}])
  await assert.rejects(endpointRequest({port,...bad}),/invalid/,JSON.stringify(bad));
 await assert.rejects(endpointRequest({host:'127.0.0.1',port:1,path:'/m'}),/refused|unreachable/);
});

test('TLS: pin and CA modes are verified before the request; a wrong certificate never sees the Authorization header',async t=>{
 const {port,seen}=await serve(t,ok,{secure:true});
 const auth={Authorization:'Basic c2VjcmV0'};
 const good=await endpointRequest({host:'127.0.0.1',port,path:'/wsman',trust:{mode:'pin',pin:pin(cert)},headers:auth});
 assert.equal(good.status,200);assert.equal(seen.length,1);assert.equal(seen[0].auth,'Basic c2VjcmV0');
 await assert.rejects(endpointRequest({host:'127.0.0.1',port,path:'/wsman',trust:{mode:'pin',pin:pin(otherCert)},headers:auth}),/tls-pin/);
 await assert.rejects(endpointRequest({host:'127.0.0.1',port,path:'/wsman',trust:{mode:'ca'},headers:auth}),/tls-untrusted/,'a self-signed certificate is not trusted by the CA store');
 assert.equal(seen.length,1,'no request reached the server after a failed verification');
 // CA mode with the test certificate as a trusted CA: the name must match too.
 const withCa=o=>tls.connect({...o,ca:[cert,otherCert]});
 assert.equal((await endpointRequest({host:'localhost',port,path:'/x',trust:{mode:'ca'},tlsConnect:withCa})).status,200);
 const other=await serve(t,ok,{secure:true,pair:[otherCert,otherKey]});
 await assert.rejects(endpointRequest({host:'localhost',port:other.port,path:'/x',trust:{mode:'ca'},tlsConnect:withCa,headers:auth}),/tls-hostname/);
 assert.equal(other.seen.length,0);
 await assert.rejects(endpointRequest({host:'127.0.0.1',port,path:'/x',trust:{mode:'pin',pin:'nope'}}),/invalid/);
 await assert.rejects(endpointRequest({host:'127.0.0.1',port,path:'/x',trust:{mode:'insecure'}}),/invalid/,'there is no insecure mode');
});

test('certificate probe: only a handshake; facts to compare, CA verification reported honestly',async t=>{
 const {port,seen}=await serve(t,ok,{secure:true});
 const facts=await probeCertificate({host:'127.0.0.1',port});
 assert.equal(facts.fingerprint,pin(cert));assert.equal(facts.subject,'localhost');assert.equal(facts.caVerified,false);assert.equal(facts.hostnameOk,true);
 assert.equal(seen.length,0,'no HTTP request at all');
 assert.equal((await probeCertificate({host:'localhost',port,tlsConnect:o=>tls.connect({...o,ca:[cert]})})).caVerified,true);
 assert.equal(normalizePin(groupsOf(facts.fingerprint)),facts.fingerprint);assert.equal(normalizePin('xyz'),null);
 const plain=await serve(t,ok);await assert.rejects(probeCertificate({host:'127.0.0.1',port:plain.port,timeoutMs:2000}),/tls|unreachable|timeout/);
});


test('a TLS handshake timeout closes the pending TCP socket before it can carry a request',async t=>{
 let peer,closed;
 const ended=new Promise(r=>{closed=r;});
 const server=net.createServer(s=>{peer=s;s.resume();s.once('close',closed);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>{peer?.destroy();server.close();});
 await assert.rejects(endpointRequest({host:'127.0.0.1',port:server.address().port,path:'/metrics',trust:{mode:'ca'},timeoutMs:100}),/timeout/);
 await Promise.race([ended,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('pending socket leaked')),1000);timer.unref();})]);
 assert.ok(peer.destroyed);
});
