// Which commit is running, read straight from .git: no dependency, never throws.
//   {commit:'7a44ed7', at:'2026-11-08T21:05:00.000Z'|null}  or null outside a git checkout
// `at` is when this checkout got the commit (deploy time on the mini), not the author date.
// The version number itself is in package.json (server/version.mjs); tagCommit() below tells that module
// whether this checkout sits exactly on the release tag of its version.
import {readFileSync,existsSync,statSync,readdirSync,openSync,readSync,closeSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {inflateSync} from 'node:zlib';
import path from 'node:path';

const SHA=/^[0-9a-f]{40}$/;
function gitDir(root){
 const dot=path.join(root,'.git');
 if(!existsSync(dot))return null;
 if(statSync(dot).isDirectory())return dot;
 const m=readFileSync(dot,'utf8').match(/^gitdir:\s*(.+)$/m);// worktree or submodule: .git is a file
 return m?path.resolve(root,m[1].trim()):null;
}
function resolveRef(dir,common,ref){
 for(const base of [dir,common]){const f=path.join(base,ref);if(existsSync(f)){const v=readFileSync(f,'utf8').trim();if(SHA.test(v))return v;}}
 const packed=path.join(common,'packed-refs');
 if(existsSync(packed))for(const line of readFileSync(packed,'utf8').split('\n')){const [sha,name]=line.split(' ');if(name===ref&&SHA.test(sha))return sha;}
 return null;
}
// When this checkout moved to the commit (commit, pull or checkout): the last reflog line of the ref.
function movedAt(common,ref){
 try{
  const lines=readFileSync(path.join(common,'logs',ref),'utf8').trimEnd().split('\n'),m=lines.at(-1).match(/> (\d+) [+-]\d{4}\t/);
  return m?new Date(Number(m[1])*1000).toISOString():null;
 }catch{return null;}
}
function readHead(root){
 const dir=gitDir(root);if(!dir)return null;
 const commonFile=path.join(dir,'commondir'),common=existsSync(commonFile)?path.resolve(dir,readFileSync(commonFile,'utf8').trim()):dir;
 const head=readFileSync(path.join(dir,'HEAD'),'utf8').trim();
 const ref=head.startsWith('ref: ')?head.slice(5):null,sha=SHA.test(head)?head:ref?resolveRef(dir,common,ref):null;
 return sha?{dir,common,ref,sha}:null;
}
export function readBuild(root){
 try{
  const head=readHead(root);
  return head?{commit:head.sha.slice(0,7),at:movedAt(head.ref?head.common:head.dir,head.ref||'HEAD')}:null;
 }catch{return null;}
}
/** The full id of the commit that is checked out, or null outside a git checkout. */
export function headCommit(root){try{return readHead(root)?.sha??null;}catch{return null;}}

// A tag → the commit it names. A lightweight tag is the commit; an annotated (or signed) one is a tag object
// that points at it. packed-refs writes the commit on the next line ("^<sha>"); otherwise the tag object is
// read from objects/ (loose) or from a pack (where a `git fetch --tags` puts it). Only what these cannot
// read (a tag object stored as a delta, another ref or pack format) needs git itself: one short
// `git rev-parse`, the single git process this file ever starts, and only for a tag that exists.
function looseObject(common,sha){
 const file=path.join(common,'objects',sha.slice(0,2),sha.slice(2));if(!existsSync(file))return null;
 const raw=inflateSync(readFileSync(file)),end=raw.indexOf(0);if(end<0)return null;
 return {type:raw.subarray(0,end).toString('latin1').split(' ')[0],body:raw.subarray(end+1).toString('utf8')};
}
// Pack index, version 2: an 8-byte header, 256 running counts by first byte, the sorted ids, a CRC each, a
// 4-byte offset each (the top bit points into a table of 8-byte offsets). The object in the pack starts with
// its type (1 commit, 4 tag; 6 and 7 are deltas) and size, then a zlib stream.
const PACK_TYPES={1:'commit',4:'tag'};
function packedObject(common,sha){
 const dir=path.join(common,'objects','pack');if(!existsSync(dir))return null;
 const id=Buffer.from(sha,'hex');
 for(const name of readdirSync(dir)){
  if(!name.endsWith('.idx'))continue;
  const idx=readFileSync(path.join(dir,name));
  if(idx.length<1032||idx.readUInt32BE(0)!==0xff744f63||idx.readUInt32BE(4)!==2)continue;
  const count=i=>idx.readUInt32BE(8+i*4),total=count(255),ids=1032;
  let lo=id[0]?count(id[0]-1):0,hi=count(id[0]),at=-1;
  while(lo<hi){const mid=(lo+hi)>>>1,order=idx.compare(id,0,20,ids+mid*20,ids+mid*20+20);if(order===0){at=mid;break;}if(order<0)lo=mid+1;else hi=mid;}
  if(at<0)continue;
  let offset=idx.readUInt32BE(ids+total*24+at*4);
  if(offset&0x80000000)offset=Number(idx.readBigUInt64BE(ids+total*28+(offset&0x7fffffff)*8));
  const pack=path.join(dir,name.replace(/\.idx$/,'.pack'));if(!existsSync(pack))return null;
  const chunk=Buffer.alloc(65536),fd=openSync(pack,'r');let read;try{read=readSync(fd,chunk,0,chunk.length,offset);}finally{closeSync(fd);}
  let i=0,byte=chunk[i++];const type=PACK_TYPES[(byte>>4)&7];while(byte&0x80&&i<read)byte=chunk[i++];
  if(!type)return null;// a delta: git reads it
  return {type,body:inflateSync(chunk.subarray(i,read),{finishFlush:2}).toString('utf8')};
 }
 return null;
}
function peel(common,sha,root,name,git){
 for(let depth=0;depth<4;depth++){
  let object=null;try{object=looseObject(common,sha)||packedObject(common,sha);}catch{}
  if(!object)return git(root,name);
  if(object.type==='commit')return sha;
  const m=object.type==='tag'?/^object ([0-9a-f]{40})$/m.exec(object.body):null;if(!m)return null;
  sha=m[1];
 }
 return null;
}
const gitPeel=(root,name)=>{try{const out=execFileSync('git',['-C',root,'rev-parse','-q','--verify',`refs/tags/${name}^{commit}`],{encoding:'utf8',timeout:3000,stdio:['ignore','pipe','ignore']}).trim();return SHA.test(out)?out:null;}catch{return null;}};
/** tagCommit(root, 'v1.2.0') → the full commit id the tag names, or null (no such tag, or no git checkout). Never throws. */
export function tagCommit(root,name,{git=gitPeel}={}){
 try{
  if(!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,80}$/.test(name))return null;
  const head=readHead(root),dir=head?.dir??gitDir(root);if(!dir)return null;
  const commonFile=path.join(dir,'commondir'),common=head?.common??(existsSync(commonFile)?path.resolve(dir,readFileSync(commonFile,'utf8').trim()):dir);
  const ref=`refs/tags/${name}`,loose=path.join(common,ref);
  if(existsSync(loose)){const sha=readFileSync(loose,'utf8').trim();return SHA.test(sha)?peel(common,sha,root,name,git):null;}
  const packed=path.join(common,'packed-refs');if(!existsSync(packed))return null;
  const lines=readFileSync(packed,'utf8').split('\n');
  for(let i=0;i<lines.length;i++){
   const [sha,refName]=lines[i].split(' ');if(refName!==ref||!SHA.test(sha))continue;
   const next=lines[i+1]||'';if(next.startsWith('^')&&SHA.test(next.slice(1)))return next.slice(1);
   return peel(common,sha,root,name,git);
  }
  return null;
 }catch{return null;}
}
