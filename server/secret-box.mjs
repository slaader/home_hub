// Secrets at rest: the stores that keep a password or token (the Thermo logins of added devices, the WinRM, Node
// Exporter and Prometheus credentials) are written sealed with AES-256-GCM, so a copy of state/ (a backup, a
// support bundle, a mistaken commit) holds no usable secret. The key is kept apart from the data, from the first
// source that applies (it seals new files):
//   1. HOME_HUB_SECRET_KEY        64 hex characters (containers, a service manager's secret store, tests)
//   2. the macOS login Keychain   only with HOME_HUB_SECRET_KEYCHAIN=1: generic password, service "Home Hub",
//                                 account "secret-key"; needs the login keychain unlocked (a LaunchDaemon may not have it)
//   3. a key file                 HOME_HUB_SECRET_KEY_FILE, else secret.key next to AUTH_FILE (private/ by default;
//                                 a preview with its own AUTH_FILE gets its own key), 0600, created on first use
// Opening tries the key of the source the file names (kid) first, then every other key that is there; the GCM tag
// decides. A key is created only for sealing, only in the sealing source, only when it has none: a missing key is
// never replaced while it may still exist (that would orphan every file sealed with it): 'secrets-locked'.
// A file written before sealing existed (plain JSON) is still read and is rewritten sealed by its store.
// A file whose key is certainly gone ('secrets-lost': see open) is the store's to set aside; its secrets are entered again.
// Envelope: {"sealed":1, "alg":"A256GCM", "kid":"env"|"keychain"|"file", "kfp" (keyFingerprint), "iv", "tag", "data"} (base64), with the
// file's purpose as additional authenticated data, so one sealed file cannot be swapped in for another.
// The key never appears on a command line: it reaches the Keychain through `security -i` on stdin.
import {createCipheriv,createDecipheriv,randomBytes,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {readFile,mkdir,link,rm,open} from 'node:fs/promises';
import path from 'node:path';
import {repoRoot} from './edition.mjs';

const HEX_KEY=/^[0-9a-f]{64}$/i,KIDS=['env','keychain','file'];
const SERVICE='Home Hub',ACCOUNT='secret-key',NOT_FOUND=44;
export class SecretBoxError extends Error{constructor(reason,detail){super(reason);this.reason=reason;if(detail)this.detail=detail;}}
const locked=detail=>new SecretBoxError('secrets-locked',detail);
// Which key sealed a file, without saying anything about the key: 64 bits of a hash of it.
export const keyFingerprint=key=>createHash('sha256').update('home-hub secret-box key\0').update(key).digest('hex').slice(0,16);

export const isSealed=v=>Boolean(v&&typeof v==='object'&&v.sealed===1&&typeof v.kid==='string'&&typeof v.iv==='string'&&typeof v.tag==='string'&&typeof v.data==='string');

// `security -i` with a script on stdin (never argv): {code, stdout}. It exits with the last command's status.
export function securityRun(script,{binary='/usr/bin/security',timeoutMs=10000}={}){
 return new Promise(resolve=>{
  let child;try{child=spawn(binary,['-i'],{stdio:['pipe','pipe','pipe']});}catch{return resolve({code:null,stdout:''});}
  let out='';const timer=setTimeout(()=>child.kill('SIGKILL'),timeoutMs);
  child.stdout.on('data',d=>{if(out.length<65536)out+=d;});child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});
  child.on('error',()=>{clearTimeout(timer);resolve({code:null,stdout:''});});
  child.on('close',code=>{clearTimeout(timer);resolve({code,stdout:out});});
  child.stdin.end(script);});
}
// A value for `security -i`: its own tokenizer takes double-quoted words; the values here are fixed or hex.
const word=s=>{if(!/^[\w .:-]+$/.test(s))throw new Error('invalid');return `"${s}"`;};
// get() → key | null (there is none) | throws 'secrets-locked' (there may be one, it cannot be read now).
export function keychainSource({service=SERVICE,account=ACCOUNT,run=securityRun}={}){
 const get=async()=>{const r=await run(`find-generic-password -s ${word(service)} -a ${word(account)} -w\n`);
  if(r.code===NOT_FOUND)return null;
  const hex=r.stdout.split(/\s+/).find(x=>HEX_KEY.test(x));
  if(r.code!==0||!hex)throw locked('the macOS Keychain did not give the key (is the login keychain unlocked?)');
  return Buffer.from(hex,'hex');};
 return {get,
  // Never -U: an existing key is never overwritten. A refusal (another process made it first) is settled by reading again.
  async create(key){await run(`add-generic-password -s ${word(service)} -a ${word(account)} -D ${word('application password')} -w ${key.toString('hex')}\n`);}};
}
export function fileSource(file){
 return {
  async get(){let hex;try{hex=(await readFile(file,'utf8')).trim();}catch(e){if(e.code==='ENOENT')return null;throw locked(`${file} cannot be read (${e.code})`);}
   if(!HEX_KEY.test(hex))throw locked(`${file} does not hold a 64-character hex key`);return Buffer.from(hex,'hex');},
  // Written in full and synced under a temporary name, then linked into place: exclusive, so two processes making
  // the key at once agree on one (the loser reads the winner's), and a crash never leaves a half-written key.
  async create(key){const tmp=`${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
   try{await mkdir(path.dirname(file),{recursive:true,mode:0o700});
    const h=await open(tmp,'wx',0o600);try{await h.writeFile(key.toString('hex')+'\n');await h.sync();}finally{await h.close();}
    try{await link(tmp,file);}catch(e){if(e.code!=='EEXIST')throw e;}
    try{const d=await open(path.dirname(file),'r');try{await d.sync();}finally{await d.close();}}catch{}}
   catch(e){throw locked(`a key cannot be written to ${file} (${e.code||e.message}); set HOME_HUB_SECRET_KEY or HOME_HUB_SECRET_KEY_FILE`);}
   finally{await rm(tmp,{force:true});}}};
}
export const defaultKeyFile=(env=process.env)=>env.HOME_HUB_SECRET_KEY_FILE?path.resolve(env.HOME_HUB_SECRET_KEY_FILE)
 :path.join(env.AUTH_FILE?path.dirname(path.resolve(env.AUTH_FILE)):path.join(repoRoot,'private'),'secret.key');

/**
 * options: env, platform, keyFile, keychain (a source), useKeychain.
 * → {kid, ready() (the sealing key is there, or made), seal(value, purpose) → envelope, open(envelope, purpose) → value}
 */
export function createSecretBox({env=process.env,platform=process.platform,keyFile=defaultKeyFile(env),keychain=keychainSource(),useKeychain=env.HOME_HUB_SECRET_KEYCHAIN==='1'}={}){
 const fromEnv=env.HOME_HUB_SECRET_KEY;
 if(fromEnv!==undefined&&fromEnv!==''&&!HEX_KEY.test(fromEnv))throw new SecretBoxError('invalid','HOME_HUB_SECRET_KEY must be 64 hex characters');
 const sources={
  env:fromEnv?{get:async()=>Buffer.from(fromEnv,'hex'),create:async()=>{}}:null,
  keychain:platform==='darwin'&&useKeychain?keychain:null,
  file:fileSource(keyFile)};
 const kid=fromEnv?'env':sources.keychain?'keychain':'file';
 const keys=new Map(),pending=new Map();
 // The key of one source, cached once read (a failure is not cached: an unlocked keychain or a restored key file
 // is picked up on the next try). Created only when asked (sealing) and only when the source has none.
 const keyOf=(id,{create=false}={})=>{
  const slot=create?`${id}+`:id;
  if(keys.has(id))return Promise.resolve(keys.get(id));
  if(pending.has(slot))return pending.get(slot);
  const run=(async()=>{const s=sources[id];if(!s)throw locked(`the key source "${id}" is not available here`);
   let key=await s.get();
   if(!key&&create){await s.create(randomBytes(32));key=await s.get();}
   if(!key)throw new SecretBoxError('absent',`no key in the "${id}" source`);
   keys.set(id,key);return key;})().finally(()=>pending.delete(slot));
  pending.set(slot,run);return run;};
 const decrypt=(key,env,purpose)=>{
  const iv=Buffer.from(env.iv,'base64'),tag=Buffer.from(env.tag,'base64');if(iv.length!==12||tag.length!==16)return undefined;
  try{const d=createDecipheriv('aes-256-gcm',key,iv,{authTagLength:16});d.setAAD(Buffer.from(String(purpose)));d.setAuthTag(tag);
   return JSON.parse(Buffer.concat([d.update(Buffer.from(env.data,'base64')),d.final()]).toString('utf8'));}catch{return undefined;}};
 return {kid,keyFile,
  ready:()=>keyOf(kid,{create:true}).then(()=>true),
  async seal(value,purpose){const key=await keyOf(kid,{create:true}),iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv,{authTagLength:16});c.setAAD(Buffer.from(String(purpose)));
   const data=Buffer.concat([c.update(JSON.stringify(value),'utf8'),c.final()]);
   return {sealed:1,alg:'A256GCM',kid,kfp:keyFingerprint(key),iv:iv.toString('base64'),tag:c.getAuthTag().toString('base64'),data:data.toString('base64')};},
  async open(env,purpose){
   if(!isSealed(env)||env.alg!=='A256GCM'||!KIDS.includes(env.kid))throw new SecretBoxError('invalid','not a sealed file');
   // 'secrets-lost' only when that is certain: the file names its key (kfp), its source is set up here, every source
   // answered, and none holds
   // that key (the key file is gone, or another key took its place). Anything uncertain (a source that could not be
   // read, a locked Keychain, the right key that does not open the file) is 'secrets-locked': wait, change nothing.
   // Only a key file can be certainly gone: the Keychain's "not found" also means "not in this session's search list",
   // and another HOME_HUB_SECRET_KEY is a mistake to fix, not a loss. The store confirms even this against its marker.
   const why=[];let certain=typeof env.kfp==='string'&&env.kid==='file';
   for(const id of [env.kid,...KIDS.filter(k=>k!==env.kid)]){if(!sources[id])continue;
    let key;try{key=await keyOf(id);}catch(e){if(e.reason!=='absent')certain=false;why.push(e.detail||e.message);continue;}
    const value=decrypt(key,env,purpose);if(value!==undefined)return value;
    if(env.kfp===keyFingerprint(key))certain=false;why.push(`the "${id}" key does not open it`);}
   if(certain)throw new SecretBoxError('secrets-lost',why.join('; ')||'no key source is available');
   throw locked(why.join('; ')||'no key source is available');}};
}
let shared=null;
export const defaultSecretBox=()=>shared||(shared=createSecretBox());
