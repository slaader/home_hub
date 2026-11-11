// SSH keys for the hub's own (app-managed) connections, with Node's built-in crypto only: no ssh-keygen and no
// dependency. Generating a dedicated key, reading a key someone imports, the OpenSSH public key line and its
// SHA256 fingerprint, and host keys as ssh-keyscan prints them.
// Nothing here implements cryptography. Keys come from crypto.generateKeyPair and crypto.createPrivateKey; this
// file only converts between encodings (the OpenSSH wire format, PEM, JWK) and checks that a key is consistent
// by signing and verifying once.
//
// What is stored is always a format every OpenSSH client reads (Linux, macOS and Windows builds alike):
//   RSA    PKCS#1 PEM ("BEGIN RSA PRIVATE KEY")       generated keys are RSA 3072
//   ECDSA  SEC1 PEM ("BEGIN EC PRIVATE KEY")          P-256, P-384, P-521
//   Ed25519 an unencrypted OpenSSH key ("BEGIN OPENSSH PRIVATE KEY")
// Encrypted keys are refused, never prompted for: the hub signs in unattended, so a passphrase would have to be
// stored next to the key anyway. Error codes (Error.message): key-format, key-encrypted, key-public, key-putty,
// key-unsupported, key-weak, key-mismatch. No error ever carries any part of the key.
import {generateKeyPair,createPrivateKey,createPublicKey,createHash,randomBytes,sign,verify} from 'node:crypto';
import {promisify} from 'node:util';

const generate=promisify(generateKeyPair);
export const KEY_LIMITS=Object.freeze({importBytes:16384,rsaMinBits:2048,rsaMaxBits:8192,generatedBits:3072});
export const KEY_COMMENT='home-hub';
const fail=code=>{throw new Error(code);};

// --- the OpenSSH wire format (RFC 4251 strings and mpints) -----------------------------------------------
const u32=n=>{const b=Buffer.alloc(4);b.writeUInt32BE(n>>>0);return b;};
const sshString=v=>{const b=Buffer.isBuffer(v)?v:Buffer.from(v,'latin1');return Buffer.concat([u32(b.length),b]);};
const unsigned=b=>{let i=0;while(i<b.length-1&&b[i]===0)i++;return b.subarray(i);};
const mpint=b=>{const v=unsigned(Buffer.from(b));if(v.length===1&&v[0]===0)return sshString(Buffer.alloc(0));return sshString(v[0]&0x80?Buffer.concat([Buffer.from([0]),v]):v);};
function reader(buf){
 let o=0;
 const take=n=>{if(!Number.isSafeInteger(n)||n<0||o+n>buf.length)fail('key-format');const v=buf.subarray(o,o+n);o+=n;return v;};
 const r={u32:()=>take(4).readUInt32BE(0),bytes:()=>take(r.u32()),text:()=>r.bytes().toString('latin1'),left:()=>buf.length-o};
 return r;
}
const b64u=b=>Buffer.from(b).toString('base64url');
const fromB64u=s=>Buffer.from(String(s||''),'base64url');
const bigOf=b=>{const v=unsigned(Buffer.from(b));return v.length?BigInt('0x'+v.toString('hex')):0n;};
const bufOf=n=>{let h=n.toString(16);if(h.length%2)h='0'+h;return Buffer.from(h,'hex');};
const padTo=(b,size)=>{const v=unsigned(Buffer.from(b));if(v.length>size)fail('key-format');return Buffer.concat([Buffer.alloc(size-v.length),v]);};

const CURVES=Object.freeze({'P-256':{ssh:'nistp256',size:32,node:'prime256v1',bits:256},'P-384':{ssh:'nistp384',size:48,node:'secp384r1',bits:384},'P-521':{ssh:'nistp521',size:66,node:'secp521r1',bits:521}});
const curveBySsh=name=>Object.entries(CURVES).find(([,c])=>c.ssh===name);
const curveByNode=name=>Object.entries(CURVES).find(([,c])=>c.node===name||c.ssh===name);

// The public key blob (what authorized_keys and known_hosts hold, base64) of a public JWK.
function blobOfJwk(j){
 if(j.kty==='RSA')return {type:'ssh-rsa',blob:Buffer.concat([sshString('ssh-rsa'),mpint(fromB64u(j.e)),mpint(fromB64u(j.n))])};
 if(j.kty==='OKP'&&j.crv==='Ed25519')return {type:'ssh-ed25519',blob:Buffer.concat([sshString('ssh-ed25519'),sshString(fromB64u(j.x))])};
 if(j.kty==='EC'&&CURVES[j.crv]){const c=CURVES[j.crv],type=`ecdsa-sha2-${c.ssh}`;
  return {type,blob:Buffer.concat([sshString(type),sshString(c.ssh),sshString(Buffer.concat([Buffer.from([4]),padTo(fromB64u(j.x),c.size),padTo(fromB64u(j.y),c.size)]))])};}
 fail('key-unsupported');
}
// "SHA256:…", exactly as ssh-keygen -l prints it.
export const fingerprintOf=blob=>'SHA256:'+createHash('sha256').update(blob).digest('base64').replace(/=+$/,'');
export const FINGERPRINT=/^SHA256:[A-Za-z0-9+/]{43}$/;

// Only these kinds of key, with these sizes. An RSA-PSS key, DSA, a security key (sk-…) or a short RSA key is refused.
function checked(key){
 const type=key.asymmetricKeyType,d=key.asymmetricKeyDetails||{};
 if(type==='rsa'){if(!(d.modulusLength>=KEY_LIMITS.rsaMinBits))fail('key-weak');if(d.modulusLength>KEY_LIMITS.rsaMaxBits)fail('key-unsupported');return {key,bits:d.modulusLength};}
 if(type==='ed25519')return {key,bits:256};
 if(type==='ec'){const c=curveByNode(d.namedCurve);if(!c)fail('key-unsupported');return {key,bits:c[1].bits};}
 fail('key-unsupported');
}
// Sign once and verify with the public half: a key whose parts do not belong together is refused.
function consistent(key){
 const data=randomBytes(32),alg=key.asymmetricKeyType==='ed25519'?null:'sha256';
 let ok=false;try{ok=verify(alg,data,createPublicKey(key),sign(alg,data,key));}catch{ok=false;}
 if(!ok)fail('key-mismatch');
}
// {type, bits, publicKey: "type base64 home-hub", blob (base64), fingerprint}. The comment is always ours,
// so an imported key's own comment (often user@machine) is never shown or sent anywhere.
export function describeKey(key){
 const {bits}=checked(key);
 const {type,blob}=blobOfJwk(createPublicKey(key).export({format:'jwk'}));
 return {type,bits,blob:blob.toString('base64'),publicKey:`${type} ${blob.toString('base64')} ${KEY_COMMENT}`,fingerprint:fingerprintOf(blob)};
}

// An unencrypted OpenSSH private key for Ed25519 (PROTOCOL.key): the only format OpenSSH reads for Ed25519 on every platform.
function openSshEd25519(seed,pub){
 const pubBlob=Buffer.concat([sshString('ssh-ed25519'),sshString(pub)]),check=randomBytes(4);
 let priv=Buffer.concat([check,check,sshString('ssh-ed25519'),sshString(pub),sshString(Buffer.concat([seed,pub])),sshString(KEY_COMMENT)]);
 const pad=(8-priv.length%8)%8;priv=Buffer.concat([priv,Buffer.from(Array.from({length:pad},(_,i)=>i+1))]);
 const body=Buffer.concat([Buffer.from('openssh-key-v1\0','latin1'),sshString('none'),sshString('none'),sshString(Buffer.alloc(0)),u32(1),sshString(pubBlob),sshString(priv)]);
 return `-----BEGIN OPENSSH PRIVATE KEY-----\n${body.toString('base64').match(/.{1,70}/g).join('\n')}\n-----END OPENSSH PRIVATE KEY-----\n`;
}
// The private key as it is written to the key store (see the table at the top).
function serialize(key){
 const type=key.asymmetricKeyType;
 if(type==='rsa')return key.export({type:'pkcs1',format:'pem'});
 if(type==='ec')return key.export({type:'sec1',format:'pem'});
 const j=key.export({format:'jwk'});return openSshEd25519(fromB64u(j.d),fromB64u(j.x));
}
// {pem, type, bits, publicKey, blob, fingerprint, source}. pem is the private key: it goes to the key store and nowhere else.
function material(key,source){consistent(key);return {...describeKey(key),source,pem:serialize(key)};}

// A new key for one connection: RSA 3072 (every Windows OpenSSH Server accepts it, with rsa-sha2 signatures).
export async function generateKey(){
 const {privateKey}=await generate('rsa',{modulusLength:KEY_LIMITS.generatedBits,publicExponent:0x10001});
 return material(privateKey,'generated');
}

// An OpenSSH private key ("BEGIN OPENSSH PRIVATE KEY", what ssh-keygen writes by default). Only unencrypted ones:
// cipher and kdf "none". The public key in its header must be the one its private part makes.
function fromOpenSsh(body){
 const buf=Buffer.from(body.replace(/\s+/g,''),'base64'),magic=Buffer.from('openssh-key-v1\0','latin1');
 if(buf.length<magic.length||!buf.subarray(0,magic.length).equals(magic))fail('key-format');
 const r=reader(buf.subarray(magic.length));
 const cipher=r.text(),kdf=r.text();r.bytes();
 if(cipher!=='none'||kdf!=='none')fail('key-encrypted');
 if(r.u32()!==1)fail('key-unsupported');
 const header=r.bytes(),p=reader(r.bytes());
 if(p.u32()!==p.u32())fail('key-format');
 const type=p.text();let jwk;
 if(type==='ssh-ed25519'){
  const x=p.bytes(),sk=p.bytes();if(x.length!==32||sk.length!==64||!sk.subarray(32).equals(x))fail('key-format');
  jwk={kty:'OKP',crv:'Ed25519',x:b64u(x),d:b64u(sk.subarray(0,32))};
 }else if(type==='ssh-rsa'){
  const [n,e,d,iqmp,pp,q]=[p.bytes(),p.bytes(),p.bytes(),p.bytes(),p.bytes(),p.bytes()].map(bigOf);
  if(!n||!e||!d||pp<2n||q<2n||pp*q!==n)fail('key-format');
  jwk={kty:'RSA',n:b64u(bufOf(n)),e:b64u(bufOf(e)),d:b64u(bufOf(d)),p:b64u(bufOf(pp)),q:b64u(bufOf(q)),dp:b64u(bufOf(d%(pp-1n))),dq:b64u(bufOf(d%(q-1n))),qi:b64u(bufOf(iqmp))};
 }else if(/^ecdsa-sha2-nistp(256|384|521)$/.test(type)){
  const c=curveBySsh(p.text());if(!c||`ecdsa-sha2-${c[1].ssh}`!==type)fail('key-format');
  const point=p.bytes(),d=p.bytes(),size=c[1].size;
  if(point.length!==1+2*size||point[0]!==4)fail('key-format');
  jwk={kty:'EC',crv:c[0],x:b64u(point.subarray(1,1+size)),y:b64u(point.subarray(1+size)),d:b64u(padTo(d,size))};
 }else fail('key-unsupported');// DSA, security keys (sk-…: they need the device at every login), certificates
 let key;try{key=createPrivateKey({key:jwk,format:'jwk'});}catch{fail('key-format');}
 const out=material(key,'imported');
 if(out.blob!==header.toString('base64'))fail('key-mismatch');
 return out;
}

// A private key someone pasted or chose as a file (at most 16 KiB of text). Recognised: OpenSSH, PKCS#1 (RSA),
// SEC1 (EC) and unencrypted PKCS#8 PEM. Refused with a code: a public key, a PuTTY key, anything encrypted.
export function importKey(text){
 if(typeof text!=='string'||!text.trim())fail('key-format');
 if(Buffer.byteLength(text,'utf8')>KEY_LIMITS.importBytes)fail('key-format');
 const s=text.replace(/^﻿/,'').replace(/\r\n?/g,'\n').trim();
 if(/^PuTTY-User-Key-File-\d/.test(s))fail('key-putty');
 if(/^(?:ssh-(?:rsa|ed25519|dss)|ecdsa-sha2-|sk-|---- BEGIN SSH2 PUBLIC KEY)/.test(s)||/^-----BEGIN (?:RSA |EC )?PUBLIC KEY-----/.test(s))fail('key-public');
 const m=/^-----BEGIN ([A-Z0-9 ]{3,40})-----\n([\s\S]*?)\n?-----END \1-----$/.exec(s);
 if(!m)fail('key-format');
 const [,label,body]=m;
 if(label==='OPENSSH PRIVATE KEY')return fromOpenSsh(body);
 if(label==='ENCRYPTED PRIVATE KEY'||/^Proc-Type:\s*4,ENCRYPTED/m.test(body))fail('key-encrypted');
 if(label==='DSA PRIVATE KEY')fail('key-unsupported');
 if(!['RSA PRIVATE KEY','EC PRIVATE KEY','PRIVATE KEY'].includes(label))fail('key-format');
 // Without a passphrase OpenSSL never prompts: an encrypted key that slipped past the checks above just fails.
 let key;try{key=createPrivateKey({key:s+'\n',format:'pem'});}catch{fail('key-format');}
 return material(key,'imported');
}

// A host key as ssh-keyscan prints it ("<type> <base64>"): {type, key, fingerprint} or null when the line is not
// one of the types the hub accepts, or the blob does not say the type it claims.
export const HOST_KEY_TYPES=Object.freeze(['ssh-ed25519','ecdsa-sha2-nistp256','ecdsa-sha2-nistp384','ecdsa-sha2-nistp521','ssh-rsa']);
export function parseHostKey(type,key){
 if(!HOST_KEY_TYPES.includes(type)||typeof key!=='string'||key.length>4096||!/^[A-Za-z0-9+/]+={0,2}$/.test(key))return null;
 const blob=Buffer.from(key,'base64');
 if(blob.toString('base64')!==key)return null;
 try{const r=reader(blob);if(r.text()!==type)return null;}catch{return null;}
 return {type,key,fingerprint:fingerprintOf(blob)};
}
