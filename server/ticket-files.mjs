// Files attached to tickets: content-addressed blobs in state/tickets/attachments/<sha256>.
// An upload streams into a temp file while it is hashed and sniffed, then moves into place.
// The served type is decided here from the bytes, never from what the browser claimed:
// raster images, plain text, audio and video may be shown or played inline, everything else is a download.
import {mkdir,rename,rm,stat,open,readdir} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';

export const FILE_LIMITS=Object.freeze({file:100*1024*1024,total:2*1024**3});
const SHA=/^[a-f0-9]{64}$/;
const fail=code=>{throw new Error(code);};
const IMAGES=[['image/png',b=>b.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))],['image/jpeg',b=>b[0]===0xff&&b[1]===0xd8&&b[2]===0xff],
 ['image/gif',b=>/^GIF8[79]a$/.test(b.subarray(0,6).toString('latin1'))],['image/webp',b=>b.subarray(0,4).toString('latin1')==='RIFF'&&b.subarray(8,12).toString('latin1')==='WEBP']];
const TEXT=/\.(txt|md|log|json|csv|ya?ml|toml|ini|conf|sh|mjs|js|ts|py|html|css|xml|diff|patch)$/i;
const ascii=(b,from,to)=>b.subarray(from,to).toString('latin1');
// MP4-family brands (the four characters after "ftyp") that are video; pictures (HEIC, AVIF) and unknown ones stay downloads.
const MP4_VIDEO=/^(isom|iso[2-9]|mp4[12]|avc1|M4V |M4VH|M4VP|mmp4|dash|MSNV|f4v )$/,MP4_AUDIO=/^(M4A |M4B |M4P |F4A |F4B )$/;
// Audio and video by their container. The name only settles what the container leaves open (sound or picture);
// a wrong guess costs nothing: the player fails and the file is still a download.
function media(b,name){
 const riff=ascii(b,0,4)==='RIFF'?ascii(b,8,12):'';
 if(riff==='WAVE')return 'audio/wav';
 if(riff==='AVI ')return 'video/x-msvideo';
 if(ascii(b,0,4)==='fLaC')return 'audio/flac';
 if(ascii(b,0,4)==='OggS')return /\.(ogv|ogm)$/i.test(name)?'video/ogg':'audio/ogg';
 // An ID3v2 tag: version 2-4, then a size of four 7-bit bytes.
 if(ascii(b,0,3)==='ID3'&&b[3]>=2&&b[3]<=4&&b[4]!==0xff&&((b[6]|b[7]|b[8]|b[9])&0x80)===0)return 'audio/mpeg';
 // Without a tag in front: an MPEG audio frame (11 sync bits, then no reserved version, layer, bit rate or sample
 // rate) or an ADTS frame of AAC (12 sync bits, layer 0). Both are short patterns, so the name has to agree.
 if(b.length>3&&b[0]===0xff&&(b[1]&0xe0)===0xe0){
  if(/\.mp[23]$/i.test(name)&&(b[1]&0x18)!==0x08&&(b[1]&0x06)!==0&&(b[2]&0xf0)!==0xf0&&(b[2]&0x0c)!==0x0c)return 'audio/mpeg';
  if(/\.aac$/i.test(name)&&(b[1]&0xf6)===0xf0)return 'audio/aac';
 }
 if(b[0]===0x1a&&b[1]===0x45&&b[2]===0xdf&&b[3]===0xa3){
  const doc=ascii(b,0,64);
  if(doc.includes('webm'))return /\.weba$/i.test(name)?'audio/webm':'video/webm';
  if(doc.includes('matroska'))return /\.mka$/i.test(name)?'audio/x-matroska':'video/x-matroska';
 }
 if(ascii(b,4,8)==='ftyp'){
  const brand=ascii(b,8,12);
  if(MP4_AUDIO.test(brand)||(MP4_VIDEO.test(brand)&&/\.(m4a|m4b)$/i.test(name)))return 'audio/mp4';
  if(brand==='qt  ')return 'video/quicktime';
  if(brand.startsWith('3g'))return 'video/3gpp';
  if(MP4_VIDEO.test(brand))return 'video/mp4';
 }
 return null;
}
// What we will serve the file as. Text must be valid UTF-8 without NULs and look like a text file by name.
export function sniff(head,name){
 for(const [type,test] of IMAGES)if(test(head))return type;
 if(head.subarray(0,5).toString('latin1')==='%PDF-')return 'application/pdf';
 const av=media(head,name);if(av)return av;
 if(TEXT.test(name)&&!head.includes(0)){try{new TextDecoder('utf-8',{fatal:true}).decode(head.subarray(0,Math.max(0,head.length-4)));return 'text/plain';}catch{}}
 return 'application/octet-stream';
}
// Shown or played in the page; everything else is offered as a download. Only the picture types sniff() knows:
// an image type that can carry a script (SVG) is never inline, whatever a stored record says.
export const inline=type=>IMAGES.some(([image])=>image===type)||type==='text/plain'||type.startsWith('audio/')||type.startsWith('video/');
export function cleanName(raw){
 const name=String(raw||'').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f"]/g,'').trim().slice(0,120);
 return name||'soubor';
}

export function createTicketFiles(root){
 const dir=path.join(root,'attachments');let used=null,swept=null;
 // What an upload leaves behind when the process ends under it (.upload-<uuid>) is removed before this process
 // makes a temp file of its own: once, on the first upload. Nothing else ever would, and it counts in the total.
 const sweep=()=>swept??=(async()=>{let names=[];try{names=await readdir(dir);}catch{}
  for(const n of names)if(n.startsWith('.upload-'))await rm(path.join(dir,n),{force:true}).catch(()=>{});})();
 const file=sha=>SHA.test(sha)?path.join(dir,sha):fail('not-found');
 async function usage(){if(used!==null)return used;let total=0,names=[];try{names=await readdir(dir);}catch(e){if(e.code!=='ENOENT')throw e;}
  for(const n of names)try{total+=(await stat(path.join(dir,n))).size;}catch{}return used=total;}
 // body: async iterable of Buffers. Returns {sha256,size,type,name}.
 async function put(body,{name,declaredLength}){
  if(Number.isFinite(declaredLength)&&declaredLength>FILE_LIMITS.file)fail('too-large');
  await mkdir(dir,{recursive:true,mode:0o700});await sweep();
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
