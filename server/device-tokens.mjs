import {mkdir,readFile,writeFile,rename,appendFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import path from 'node:path';
// Long-lived bearer tokens for native clients (the iPhone app). Only SHA-256 hashes are stored, in state/device-tokens.json.
export const maxDevices=20;
const sha=token=>createHash('sha256').update(token).digest();
const tokenPattern=/^hh_[a-f0-9]{64}$/;
export function bearerOf(header=''){const m=/^Bearer (\S+)$/.exec(header);return m&&tokenPattern.test(m[1])?m[1]:null;}
export function validDeviceName(name){return typeof name==='string'&&name.trim().length>0&&name.length<=60&&!/[\u0000-\u001f\u007f]/.test(name);}
const view=(d,current)=>({id:d.id,name:d.name,createdAt:d.createdAt,lastUsedAt:d.lastUsedAt,...(current===undefined?{}:{current:d.id===current})});
export function createDeviceTokens(directory,{now=Date.now}={}){
 const file=path.join(directory,'device-tokens.json');
 let devices=[];try{const d=JSON.parse(readFileSync(file,'utf8'));if(d.schemaVersion===1&&Array.isArray(d.devices))devices=d.devices.filter(x=>/^[a-f0-9]{16}$/.test(x.id)&&/^[a-f0-9]{64}$/.test(x.hash));}catch(e){if(e.code!=='ENOENT')throw e;}
 let queue=Promise.resolve();
 const save=()=>{const op=queue.then(async()=>{await mkdir(directory,{recursive:true,mode:0o700});await writeFile(file+'.tmp',JSON.stringify({schemaVersion:1,devices}),{mode:0o600});await rename(file+'.tmp',file);});queue=op.catch(()=>{});return op;};
 // Metadata only; never the token or its hash.
 const audit=(event,d)=>appendFile(path.join(directory,'device-tokens-audit.jsonl'),JSON.stringify({at:new Date(now()).toISOString(),event,id:d.id,name:d.name})+'\n',{mode:0o600}).catch(()=>{});
 return {
  // Returns the device id for a valid token, else null. lastUsedAt is written at most once a minute.
  verify(token){
   if(!token)return null;const digest=sha(token);
   const d=devices.find(x=>timingSafeEqual(Buffer.from(x.hash,'hex'),digest));if(!d)return null;
   const t=now();if(!d.lastUsedAt||t-Date.parse(d.lastUsedAt)>60000){d.lastUsedAt=new Date(t).toISOString();save().catch(()=>{});}
   return d.id;
  },
  list:current=>devices.map(d=>view(d,current??null)),
  async issue(name){
   if(!validDeviceName(name))throw new Error('invalid');if(devices.length>=maxDevices)throw new Error('limit');
   const token='hh_'+randomBytes(32).toString('hex'),d={id:randomBytes(8).toString('hex'),name:name.trim(),createdAt:new Date(now()).toISOString(),lastUsedAt:null,hash:sha(token).toString('hex')};
   devices.push(d);await save();await audit('issued',d);return {token,device:view(d)};
  },
  async revoke(id){
   const d=devices.find(x=>x.id===id);if(typeof id!=='string'||!d)throw new Error('not-found');
   devices=devices.filter(x=>x!==d);await save();await audit('revoked',d);
  }
 };
}
