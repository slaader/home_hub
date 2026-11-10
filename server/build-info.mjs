// Which commit is running, read straight from .git: no git process, no dependency, never throws.
// Home Hub has no semver on purpose (see AGENTS.md): the commit is the version.
//   {commit:'7a44ed7', at:'2026-11-08T21:05:00.000Z'|null}  or null outside a git checkout
// `at` is when this checkout got the commit (deploy time on the mini), not the author date.
import {readFileSync,existsSync,statSync} from 'node:fs';
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
export function readBuild(root){
 try{
  const dir=gitDir(root);if(!dir)return null;
  const commonFile=path.join(dir,'commondir'),common=existsSync(commonFile)?path.resolve(dir,readFileSync(commonFile,'utf8').trim()):dir;
  const head=readFileSync(path.join(dir,'HEAD'),'utf8').trim();
  const ref=head.startsWith('ref: ')?head.slice(5):null,sha=SHA.test(head)?head:ref?resolveRef(dir,common,ref):null;
  return sha?{commit:sha.slice(0,7),at:movedAt(ref?common:dir,ref||'HEAD')}:null;
 }catch{return null;}
}
