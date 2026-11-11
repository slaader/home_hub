// One bounded HTTP(S) request to a telemetry endpoint the hub itself was told about (a Node Exporter's
// /metrics, a WinRM listener's /wsman), with Node's built-in net, tls and http only. Shared by
// server/linux-telemetry.mjs and server/winrm-telemetry.mjs, so the rules live in one place:
//   - host and port are validated values from the store or a set-up draft; the path is a constant of the
//     caller. Nothing the browser sends is ever a URL, and no URL with credentials is ever built.
//   - TLS is verified BEFORE the request exists: the socket is opened here, and only once it is trusted is
//     it handed to http, which then writes the request line and headers (Authorization included). Two modes:
//       ca   Node's certificate store (plus NODE_EXTRA_CA_CERTS) and hostname verification, rejectUnauthorized
//       pin  the leaf certificate's SHA-256 (of its DER) must equal the one a person approved; the hostname is
//            not checked in this mode, because a pinned certificate is identified by itself, not by its name
//     There is no "insecure" mode and no global bypass: rejectUnauthorized is false only in pin mode, and only
//     because the pin is compared before a single byte of the request is written.
//   - plain HTTP is a separate choice of the caller (a Node Exporter on the LAN without TLS); a caller never
//     sends credentials over it (enforced again here: an Authorization header over plain HTTP is refused).
//   - no redirects (a 3xx is an error), no compression (Accept-Encoding: identity; an encoded reply is refused),
//     a hard deadline over connect + TLS + reply, and a cap on the reply's size.
// Errors are Error(code): timeout, refused, unresolved, unreachable, tls-untrusted, tls-pin, tls-hostname,
// tls, redirect, too-large, encoded, http (any other status; .status carries it), invalid.
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import {createHash} from 'node:crypto';

export const HTTP_LIMITS=Object.freeze({timeoutMs:12000,maxBytes:8*1024*1024});
const HOST=/^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}))*$/,IPV4=/^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
export const validEndpointHost=h=>typeof h==='string'&&(IPV4.test(h)||HOST.test(h));
export const validEndpointPort=p=>Number.isSafeInteger(p)&&p>=1&&p<=65535;
export const CERT_PIN=/^[a-f0-9]{64}$/;
// "AB:CD:…" or "abcd…" → 64 lowercase hex digits, or null.
export const normalizePin=v=>{const p=typeof v==='string'?v.replace(/[:\s]/g,'').toLowerCase():'';return CERT_PIN.test(p)?p:null;};
export const groupsOf=hex=>String(hex).toUpperCase().match(/.{2}/g)?.join(':')||'';
const fail=(code,extra)=>{throw Object.assign(new Error(code),extra||{});};
const isIp=h=>IPV4.test(h);
const leafPin=sock=>{let der=null;try{der=sock.getPeerCertificate(true)?.raw;}catch{}return der?createHash('sha256').update(der).digest('hex'):null;};
// What a network error was, as one of the codes above. The error's own text never leaves this file.
export function netCode(e){
 const c=e?.code||'';
 if(c==='ECONNREFUSED')return 'refused';
 if(c==='ENOTFOUND'||c==='EAI_AGAIN'||c==='EAI_NODATA'||c==='EAI_NONAME')return 'unresolved';
 if(c==='ETIMEDOUT')return 'timeout';
 if(c==='ERR_TLS_CERT_ALTNAME_INVALID')return 'tls-hostname';
 if(/CERT|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)|ERR_SSL|ERR_TLS|EPROTO/.test(c))return 'tls-untrusted';
 return 'unreachable';
}

// Opens the connection and calls back only with a socket that may carry the request. trust: null (plain
// HTTP), {mode:'ca'} or {mode:'pin', pin}. connect/tlsConnect are for tests.
function opener({host,port,trust,connect=net.connect,tlsConnect=tls.connect,onSocket=()=>{}}){
 return (_opts,done)=>{
  let finished=false;const once=(e,s)=>{if(finished)return;finished=true;done(e,s);};
  if(!trust){
   const sock=connect({host,port});onSocket(sock);
   sock.once('connect',()=>once(null,sock));sock.once('error',e=>{sock.destroy();once(new Error(netCode(e)));});
   return undefined;
  }
  const pinned=trust.mode==='pin';
  if(pinned&&!CERT_PIN.test(trust.pin||''))return void once(new Error('invalid'));
  if(!pinned&&trust.mode!=='ca')return void once(new Error('invalid'));
  const sock=tlsConnect({host,port,servername:isIp(host)?undefined:host,rejectUnauthorized:!pinned,minVersion:'TLSv1.2',ALPNProtocols:['http/1.1']});onSocket(sock);
  sock.once('secureConnect',()=>{
   if(pinned){if(leafPin(sock)!==trust.pin){sock.destroy();return once(new Error('tls-pin'));}}
   else if(!sock.authorized){sock.destroy();return once(new Error('tls-untrusted'));}
   once(null,sock);
  });
  sock.once('error',e=>{sock.destroy();once(new Error(netCode(e)));});
  return undefined;
 };
}

// One request. spec = {host, port, path, query (an object of fixed parameter names → strings, URL-encoded here), method='GET', headers={}, body=null, trust, timeoutMs, maxBytes, okStatus}.
// Resolves {status, headers, body (Buffer)} for any status in okStatus (default 200); rejects with a code.
export function endpointRequest({host,port,path,query=null,method='GET',headers={},body=null,trust=null,timeoutMs=HTTP_LIMITS.timeoutMs,maxBytes=HTTP_LIMITS.maxBytes,okStatus=[200],connect,tlsConnect}){
 return new Promise((resolve,reject)=>{
  if(!validEndpointHost(host)||!validEndpointPort(port)||typeof path!=='string'||!/^\/[A-Za-z0-9/_.-]{0,64}$/.test(path))return reject(new Error('invalid'));
  if(query!==null&&(typeof query!=='object'||Object.entries(query).some(([k,v])=>!/^[a-z_]{1,16}$/.test(k)||typeof v!=='string'||v.length>4096)))return reject(new Error('invalid'));
  const target=query?`${path}?${new URLSearchParams(query).toString()}`:path;
  const auth=Object.keys(headers).some(k=>k.toLowerCase()==='authorization');
  if(auth&&!trust)return reject(new Error('invalid'));// never credentials over plain HTTP
  let done=false,req=null,pendingSocket=null;
  const finish=(e,v)=>{if(done)return;done=true;clearTimeout(timer);if(e){try{req?.destroy();pendingSocket?.destroy();}catch{}reject(e);}else resolve(v);};
  const timer=setTimeout(()=>finish(new Error('timeout')),timeoutMs);
  const payload=body==null?null:Buffer.isBuffer(body)?body:Buffer.from(String(body),'utf8');
  try{
   req=http.request({host,port,path:target,method,agent:undefined,createConnection:opener({host,port,trust,connect,tlsConnect,onSocket:sock=>{pendingSocket=sock;if(done)sock.destroy();}}),
    headers:{Host:port===(trust?443:80)?host:`${host}:${port}`,'Accept-Encoding':'identity',Connection:'close','User-Agent':'home-hub',...headers,...(payload?{'Content-Length':String(payload.length)}:{})}});
  }catch{return finish(new Error('invalid'));}
  // Our own codes (from the opener) carry no .code; Node's errors are mapped.
  req.on('error',e=>finish(new Error(!e?.code&&/^[a-z-]{2,20}$/.test(e?.message||'')?e.message:netCode(e))));
  req.on('response',res=>{
   const status=res.statusCode||0;
   if(status>=300&&status<400){res.resume();return finish(new Error('redirect'));}
   const enc=String(res.headers['content-encoding']||'identity').toLowerCase();
   if(enc!=='identity'){res.resume();return finish(new Error('encoded'));}
   const declared=Number(res.headers['content-length']);
   if(Number.isFinite(declared)&&declared>maxBytes){res.destroy();return finish(new Error('too-large'));}
   const chunks=[];let size=0;
   res.on('data',c=>{size+=c.length;if(size>maxBytes){res.destroy();return finish(new Error('too-large'));}chunks.push(c);});
   res.on('end',()=>{const out={status,headers:res.headers,body:Buffer.concat(chunks)};
    if(!okStatus.includes(status))return finish(Object.assign(new Error('http'),{status,headers:res.headers,body:out.body}));finish(null,out);});
   res.on('error',()=>finish(new Error('unreachable')));
  });
  if(payload)req.write(payload);
  req.end();
 });
}

// The certificate an HTTPS endpoint presents, read without sending a request or a credential (only the TLS
// handshake). {fingerprint (hex), subject, issuer, altNames, validFrom, validTo, selfSigned, caVerified, hostnameOk, caError}:
// caVerified = the chain is trusted by Node's store AND the name matches host (what mode "ca" will need).
export function probeCertificate({host,port,timeoutMs=6000,tlsConnect=tls.connect}){
 return new Promise((resolve,reject)=>{
  if(!validEndpointHost(host)||!validEndpointPort(port))return reject(new Error('invalid'));
  let done=false;const finish=(e,v)=>{if(done)return;done=true;clearTimeout(timer);try{sock.destroy();}catch{}e?reject(e):resolve(v);};
  const sock=tlsConnect({host,port,servername:isIp(host)?undefined:host,rejectUnauthorized:false,minVersion:'TLSv1.2',ALPNProtocols:['http/1.1']});
  const timer=setTimeout(()=>finish(new Error('timeout')),timeoutMs);
  sock.on('error',e=>finish(new Error(netCode(e))));
  sock.on('secureConnect',()=>{
   let cert=null;try{cert=sock.getPeerCertificate(true);}catch{}
   if(!cert?.raw)return finish(new Error('tls'));
   const nameError=(()=>{try{return tls.checkServerIdentity(host,cert)||null;}catch(e){return e;}})();
   const clean=(v,n)=>String(v??'').replace(/[\u0000-\u001f\u007f]/g,'').slice(0,n);
   const altNames=clean(cert.subjectaltname,600).split(/,\s*/).filter(Boolean).slice(0,12);
   finish(null,{fingerprint:createHash('sha256').update(cert.raw).digest('hex'),subject:clean(cert.subject?.CN,160),issuer:clean(cert.issuer?.CN||cert.issuer?.O,160),
    altNames,validFrom:clean(cert.valid_from,60),validTo:clean(cert.valid_to,60),selfSigned:Boolean(cert.issuerCertificate&&cert.issuerCertificate.fingerprint256===cert.fingerprint256),
    caVerified:sock.authorized===true&&!nameError,hostnameOk:!nameError,caError:sock.authorized?null:clean(sock.authorizationError,60)||null});
  });
 });
}
