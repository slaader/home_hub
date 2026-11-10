// Files attached to tickets: content-addressed blobs in state/tickets/attachments/<sha256>.
// An upload streams into a temp file while it is hashed and sniffed, then moves into place.
// The served type is decided here from the bytes, never from what the browser claimed:
// raster images and plain text may be shown inline, everything else is a download.
import {mkdir,rename,rm,stat,open,readdir} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';

export const FILE_LIMITS=Object.freeze({file:20*1024*1024,total:2*1024**3});
const SHA=/^[a-f0-9]{64}$/;
const fail=code=>{throw new Error(code);};
const IMAGES=[['image/png',b=>b.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))],['image/jpeg',b=>b[0]===0xff&&b[1]===0xd8&&b[2]===0xff],
 ['image/gif',b=>/^GIF8[79]a$/.test(b.subarray(0,6).toString('latin1'))],['image/webp',b=>b.subarray(0,4).toString('latin1')==='RIFF'&&b.subarray(8,12).toString('latin1')==='WEBP']];
const TEXT=/\.(txt|md|log|json|csv|ya?ml|toml|ini|conf|sh|mjs|js|ts|py|html|css|xml|diff|patch)$/i;
// What we will serve the file as. Text must be valid UTF-8 without NULs and look like a text file by name.
export function sniff(head,name){
 for(const [type,test] of IMAGES)if(test(head))return type;
 if(head.subarray(0,5).toString('latin1')==='%PDF-')return 'application/pdf';
 if(TEXT.test(name)&&!head.includes(0)){try{new TextDecoder('utf-8',{fatal:true}).decode(head.subarray(0,Math.max(0,head.length-4)));return 'text/plain';}catch{}}
 return 'application/octet-stream';
}
export const inline=type=>type.startsWith('image/')||type==='text/plain';
export function cleanName(raw){
 const name=String(raw||'').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f"]/g,'').trim().slice(0,120);
 return name||'soubor';
}

export function createTicketFiles(root){
 const dir=path.join(root,'attachments');let used=null;
 const file=sha=>SHA.test(sha)?path.join(dir,sha):fail('not-found');
 async function usage(){if(used!==null)return used;let total=0,names=[];try{names=await readdir(dir);}catch(e){if(e.code!=='ENOENT')throw e;}
  for(const n of names)try{total+=(await stat(path.join(dir,n))).size;}catch{}return used=total;}
 // body: async iterable of Buffers. Returns {sha256,size,type,name}.
 async function put(body,{name,declaredLength}){
  if(Number.isFinite(declaredLength)&&declaredLength>FILE_LIMITS.file)fail('too-large');
  await mkdir(dir,{recursive:true,mode:0o700});
  const temp=path.join(dir,'.upload-'+randomUUID()),hash=createHash('sha256'),fh=await open(temp,'wx',0o600);let size=0,head=Buffer.alloc(0);
  try{
   for await(const chunk of body){size+=chunk.length;if(size>FILE_LIMITS.file)fail('too-large');if((await usage())+size>FILE_LIMITS.total)fail('limit');
    if(head.length<4096)head=Buffer.concat([head,chunk.subarray(0,4096-head.length)]);hash.update(chunk);await fh.write(chunk);}
  }catch(e){await fh.close();await rm(temp,{force:true});throw e;}
  await fh.close();
  if(!size){await rm(temp,{force:true});fail('invalid');}
  const sha256=hash.digest('hex'),clean=cleanName(name);
  try{await stat(file(sha256));await rm(temp,{force:true});}catch{await rename(temp,file(sha256));used+=size;}
  return {sha256,size,type:sniff(head,clean),name:clean};
 }
 async function remove(sha){try{const s=await stat(file(sha));await rm(file(sha),{force:true});if(used!==null)used-=s.size;}catch(e){if(e.code!=='ENOENT')throw e;}}
 async function read(sha){const p=file(sha);try{return {path:p,size:(await stat(p)).size};}catch{fail('not-found');}}
 return {put,remove,read};
}
