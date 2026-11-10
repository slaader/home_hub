#!/usr/bin/env node
// Publish a Review set (or its next round) to Home Hub from the machine where the variants were made.
//   HOME_HUB_URL=https://… HOME_HUB_TOKEN=hhk_… node scripts/review-push.mjs review.json [--dry-run]
// review.json has the shape of POST /api/review/publish (docs/review.md), except that media may name a local
// file instead of a sha256:  {"file":"mockups/login-a.html"}  (relative to review.json; type from the extension).
// A 3D model (.glb) may name its rendered still the same way:  {"file":"units/harvester-a.glb","poster":"units/harvester-a.png"}.
// Files are hashed, blobs the hub already has are skipped, the rest go up in 4 MiB chunks, then the set is
// published. The token needs the review:write scope. Nothing is printed of the token. No dependencies.
import {readFile,stat,open} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';

const TYPES={'.html':'text/html','.htm':'text/html','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.glb':'model/gltf-binary'};
const CHUNK=4*1024*1024;
const die=m=>{console.error('review-push: '+m);process.exit(1);};

export async function hashFile(file){const h=createHash('sha256'),fh=await open(file,'r');try{for await(const c of fh.createReadStream())h.update(c);}finally{await fh.close().catch(()=>{});}return h.digest('hex');}
// Replaces every {file} with {sha256,type}; returns the manifest and the files to upload.
export async function resolveManifest(manifest,base){
 const files=new Map();
 for(const item of manifest.items||[])for(const v of item.variants||[])for(const m of v.media||[]){
  // A poster given as a local path becomes {sha256,type}; one already given as {sha256,type} is left alone.
  if(typeof m.poster==='string'){
   const file=path.resolve(base,m.poster),type=TYPES[path.extname(file).toLowerCase()];
   if(!['image/png','image/jpeg','image/webp'].includes(type))throw new Error(`poster must be .png, .jpg or .webp: ${m.poster}`);
   const size=(await stat(file)).size,sha=await hashFile(file);files.set(sha,{file,size});m.poster={sha256:sha,type};
  }
  if(m.file===undefined)continue;
  if(typeof m.file!=='string'||!m.file)throw new Error('media.file must be a path');
  const file=path.resolve(base,m.file),type=m.type||TYPES[path.extname(file).toLowerCase()];
  if(!type)throw new Error(`unknown file type: ${m.file} (use .html, .png, .jpg, .webp, .gif or .glb, or set "type")`);
  const size=(await stat(file)).size,sha=await hashFile(file);
  files.set(sha,{file,size});delete m.file;Object.assign(m,{sha256:sha,type});if(!m.name)m.name=path.basename(file);
 }
 return {manifest,files};
}
export async function upload(url,token,sha,{file,size},log=()=>{}){
 const headers={Authorization:'Bearer '+token};
 const head=await fetch(`${url}/api/review/blobs/${sha}`,{method:'HEAD',headers});
 if(head.status===200){log(`skip ${path.basename(file)} (already on the hub)`);return 'skipped';}
 if(head.status!==404)throw new Error(`HEAD ${sha.slice(0,12)}: HTTP ${head.status}`);
 const fh=await open(file,'r');let offset=0,tries=0;
 try{
  while(offset<size){
   const n=Math.min(CHUNK,size-offset),buf=Buffer.alloc(n);await fh.read(buf,0,n,offset);
   const r=await fetch(`${url}/api/review/blobs/${sha}?offset=${offset}&size=${size}`,{method:'PUT',headers:{...headers,'Content-Type':'application/octet-stream'},body:buf});
   const body=await r.json().catch(()=>({}));
   if(r.status===409&&Number.isSafeInteger(body.received)&&++tries<5){offset=body.received;continue;}
   if(!r.ok)throw new Error(`upload ${path.basename(file)}: HTTP ${r.status} ${body.error?.message||''}`.trim());
   offset=body.received;tries=0;log(`upload ${path.basename(file)} ${Math.round(offset/size*100)} %`);
   if(body.complete)break;
  }
 }finally{await fh.close();}
 return 'uploaded';
}

async function main(argv){
 const args=argv.filter(a=>!a.startsWith('--')),dry=argv.includes('--dry-run');
 if(args.length!==1)die('usage: review-push.mjs review.json [--dry-run]');
 const url=(process.env.HOME_HUB_URL||'').replace(/\/+$/,''),token=process.env.HOME_HUB_TOKEN||'';
 if(!dry&&(!/^https?:\/\//.test(url)||!/^hhk_/.test(token)))die('set HOME_HUB_URL and HOME_HUB_TOKEN (a service-account key with review:write)');
 const manifestFile=path.resolve(args[0]);let manifest;
 try{manifest=JSON.parse(await readFile(manifestFile,'utf8'));}catch(e){die(`cannot read ${args[0]}: ${e.message}`);}
 const {files}=await resolveManifest(manifest,path.dirname(manifestFile));
 if(dry){console.log(JSON.stringify({files:[...files].map(([sha,f])=>({sha256:sha,file:f.file,size:f.size})),publish:manifest},null,1));return;}
 for(const [sha,f] of files)await upload(url,token,sha,f,m=>console.error(m));
 const r=await fetch(url+'/api/review/publish',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(manifest)});
 const body=await r.json().catch(()=>({}));
 if(!r.ok)die(`publish: HTTP ${r.status} ${body.error?.message||''}`);
 console.log(JSON.stringify({id:body.id,round:body.round?.n,url:`${url}/${body.url}`},null,1));
}
if(import.meta.url===`file://${process.argv[1]}`)main(process.argv.slice(2)).catch(e=>die(e.message));
