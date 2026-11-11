// Git LFS view (server/core/git-lfs.mjs, docs/git-lfs.md): the git half. One bare, partial mirror per repository
// under the hub's state directory, fetched without any large blob, and a scan of it that finds every LFS
// pointer reachable from any ref and says where it is (paths, ref tips, commits).
//
// Safety rules kept here:
//  - The token never reaches argv, the mirror's config or a log: it goes to git as an http.extraHeader through
//    GIT_CONFIG_* environment variables, for this one process. Credential helpers, the user's and the system's
//    git configuration and every protocol but http(s) are switched off, so nothing is stored or prompted.
//  - The mirror is `--filter=blob:limit=1024`: git-lfs never treats a blob of 1024 bytes or more as a pointer,
//    so every pointer arrives and no large content does. git-lfs itself is not needed (pointers are parsed here).
//  - The scan never fetches (GIT_NO_LAZY_FETCH, --missing=print) and fails closed: any git error, a truncated
//    output or an output over its limit throws, and the caller treats the repository as not verified.
import {spawn} from 'node:child_process';
import {mkdir,rm,stat,rename} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

export const POINTER_LIMIT=1024;// bytes: git-lfs's blob size cutoff for pointer files
export const OID=/^[a-f0-9]{64}$/;
const SHA=/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const MB=1024*1024;
export class GitError extends Error{constructor(code,detail){super(code);this.code=code;this.detail=detail||null;}}

// The git binary: GIT_LFS_GIT (server environment only), else git on the PATH.
export const gitBinary=(env=process.env)=>env.HOME_HUB_GIT_LFS_GIT||'git';

// Environment for one git process. auth = {header} or null; the header value is the whole Authorization value.
export function gitEnv(auth,{base=process.env}={}){
 const config=[
  ['credential.helper',''],['core.askPass',''],['protocol.allow','never'],['protocol.https.allow','always'],['protocol.http.allow','always'],
  ['http.followRedirects','false'],['core.quotePath','false'],['gc.auto','0'],['maintenance.auto','false'],['fetch.writeCommitGraph','false'],
  ...(auth?.header?[['http.extraHeader','Authorization: '+auth.header]]:[]),
 ];
 const env={PATH:base.PATH||'/usr/bin:/bin',HOME:base.HOME||'/nonexistent',LANG:'C',LC_ALL:'C',GIT_TERMINAL_PROMPT:'0',GIT_ASKPASS:'',SSH_ASKPASS:'',
  GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_NO_LAZY_FETCH:'1',GIT_NO_REPLACE_OBJECTS:'1',GIT_CONFIG_COUNT:String(config.length)};
 config.forEach(([k,v],i)=>{env[`GIT_CONFIG_KEY_${i}`]=k;env[`GIT_CONFIG_VALUE_${i}`]=v;});
 return env;
}

// Runs git; resolves stdout (Buffer). Rejects GitError: auth, not-found, network, timeout, too-large, git-failed.
// stderr is read only to classify the failure and is never returned or logged.
export function runGit(args,{gitDir=null,auth=null,input=null,timeoutMs=120000,maxBytes=64*MB,git=gitBinary(),cwd}={}){
 return new Promise((resolve,reject)=>{
  const full=[...(gitDir?['--git-dir='+gitDir]:[]),...args];
  // Without --git-dir (clone, ls-remote) git runs in the temp dir, so it never discovers and reads the
  // configuration of a repository it happens to be started in (the hub's own checkout).
  let child;try{child=spawn(git,full,{cwd:cwd||(gitDir?undefined:os.tmpdir()),env:gitEnv(auth),stdio:['pipe','pipe','pipe']});}catch{return reject(new GitError('git-missing'));}
  const out=[];let size=0,err='',done=false;
  const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);if(error)reject(error);else resolve(value);};
  const timer=setTimeout(()=>{child.kill('SIGKILL');finish(new GitError('timeout'));},timeoutMs);timer.unref?.();
  child.stdout.on('data',chunk=>{size+=chunk.length;if(size>maxBytes){child.kill('SIGKILL');finish(new GitError('too-large'));}else out.push(chunk);});
  child.stderr.on('data',chunk=>{if(err.length<8192)err+=chunk.toString('utf8');});
  child.on('error',e=>finish(new GitError(e.code==='ENOENT'?'git-missing':'git-failed')));
  child.on('close',code=>{if(code===0)return finish(null,Buffer.concat(out));finish(new GitError(classify(err)));});
  child.stdin.on('error',()=>{});child.stdin.end(input??undefined);
 });
}
export function classify(stderr){
 const s=String(stderr||'');
 if(/Authentication failed|could not read Username|returned error: 40[13]|HTTP 40[13]|terminal prompts disabled|Invalid username or password/i.test(s))return 'auth';
 if(/not found|returned error: 404|HTTP 404|does not appear to be a git repository/i.test(s))return 'not-found';
 if(/Could not resolve host|Failed to connect|Connection refused|timed out|SSL|TLS|unable to access/i.test(s))return 'network';
 return 'git-failed';
}

const exists=async p=>{try{await stat(p);return true;}catch{return false;}};
/**
 * Clones (first time) or fetches the bare partial mirror of one repository. dir = its directory under the
 * state dir; url = the http(s) clone URL (checked by the caller to be on the connection's host).
 * Refs that disappeared upstream are pruned, so the mirror's refs are the server's refs.
 */
export async function syncMirror(dir,url,auth,{git=gitBinary(),timeoutMs=600000}={}){
 if(!/^https?:\/\//.test(url))throw new GitError('invalid-url');
 if(await exists(path.join(dir,'HEAD'))){
  // The URL is set again each time (a renamed host), never with credentials in it.
  await runGit(['config','remote.origin.url',url],{gitDir:dir,git});
  await runGit(['fetch','--prune','--prune-tags','--no-write-fetch-head','--quiet','origin'],{gitDir:dir,auth,git,timeoutMs,maxBytes:MB});
  return {cloned:false};
 }
 await mkdir(path.dirname(dir),{recursive:true,mode:0o700});
 const tmp=`${dir}.tmp-${process.pid}-${Date.now()}`;
 await rm(tmp,{recursive:true,force:true});
 try{
  await runGit(['clone','--mirror','--quiet','--no-hardlinks',`--filter=blob:limit=${POINTER_LIMIT}`,url,tmp],{auth,git,timeoutMs,maxBytes:MB});
  await rm(dir,{recursive:true,force:true});await rename(tmp,dir);
 }catch(e){await rm(tmp,{recursive:true,force:true});throw e;}
 return {cloned:true};
}

/**
 * Pointer text → {oid, size} when it is a valid git-lfs pointer; {oid, size:null, loose:true} when it only
 * mentions an oid the way a pointer does (kept as a reference, so nothing it names is ever called unused);
 * null otherwise. Both the current and the pre-release spec URL count.
 */
export function parsePointer(buffer){
 if(!buffer||buffer.length>=POINTER_LIMIT)return null;
 const text=buffer.toString('utf8').replace(/\r\n/g,'\n');
 const oid=/^oid sha256:([a-f0-9]{64})$/m.exec(text)?.[1];if(!oid)return null;
 const strict=/^version https:\/\/(git-lfs\.github\.com\/spec\/v1|hawser\.github\.com\/spec\/v1)\n/.test(text);
 const sizeText=/^size (\d{1,16})$/m.exec(text)?.[1],size=sizeText!==undefined?Number(sizeText):NaN;
 if(strict&&Number.isSafeInteger(size))return {oid,size};
 return {oid,size:Number.isSafeInteger(size)?size:null,loose:true};
}

const lines=buf=>buf.toString('utf8').split('\n').filter(Boolean);
export const hashOf=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');

/**
 * Scans a mirror. defaultBranch = the provider's default branch name. tipLimit = how many branch/tag tips are
 * read in full to say which ones contain an object (the default branch always is).
 * → {refs, revision, defaultRef, pointers: Map(oid → usage), complete:true, stats}
 * usage = {oid, size, loose, paths, currentPaths, refs (tips containing it), via (refs a commit was reached
 * from), firstCommit, lastCommit, commits}
 */
export async function scanMirror(dir,{defaultBranch=null,tipLimit=40,git=gitBinary(),timeoutMs=300000,maxBytes=256*MB}={}){
 const run=(args,opts={})=>runGit(args,{gitDir:dir,git,timeoutMs,maxBytes,...opts});
 // 1. Refs: the server's refs as the mirror holds them.
 const refs=[];
 // %(*objecttype): what an annotated tag peels to (empty for anything else).
 for(const line of lines(await run(['for-each-ref','--format=%(objectname) %(objecttype) %(*objecttype) %(refname)']))){
  const m=/^([a-f0-9]{40,64}) (commit|tag|tree|blob) (commit|tag|tree|blob|) (refs\/\S.*)$/.exec(line);if(!m)throw new GitError('scan-failed');
  refs.push({name:m[4],sha:m[1],type:m[2],peeled:m[3]||m[2]});
 }
 refs.sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
 const revision=refsHash(refs);
 // The default branch: the provider's, else what the host's HEAD pointed to when the mirror was made.
 let headRef=defaultBranch?'refs/heads/'+defaultBranch:null;
 if(!headRef){try{headRef=(await run(['symbolic-ref','-q','HEAD'])).toString().trim()||null;}catch{headRef=null;}}
 const defaultRef=headRef&&refs.some(r=>r.name===headRef&&r.peeled==='commit')?headRef:null;
 const pointers=new Map(),byBlob=new Map();
 if(!refs.length)return {refs,revision,defaultRef,pointers,unreachable:[],complete:true,stats:{blobs:0,pointers:0,commits:0,tipsRead:0,tipsSkipped:0}};
 // 2. Every blob the mirror holds that is small enough to be a pointer, read and parsed.
 const small=[];
 for(const line of lines(await run(['cat-file','--batch-all-objects','--batch-check=%(objectname) %(objecttype) %(objectsize)']))){
  const m=/^([a-f0-9]{40,64}) (blob|tree|commit|tag) (\d+)$/.exec(line);if(!m)throw new GitError('scan-failed');
  if(m[2]==='blob'&&Number(m[3])>=40&&Number(m[3])<POINTER_LIMIT)small.push(m[1]);
 }
 for(let i=0;i<small.length;i+=5000){
  const ids=small.slice(i,i+5000),body=await run(['cat-file','--batch'],{input:ids.join('\n')+'\n'});let at=0;
  for(const id of ids){
   const end=body.indexOf(10,at);if(end<0)throw new GitError('scan-failed');
   const m=/^([a-f0-9]{40,64}) blob (\d+)$/.exec(body.subarray(at,end).toString());if(!m||m[1]!==id)throw new GitError('scan-failed');
   const length=Number(m[2]);at=end+1;const p=parsePointer(body.subarray(at,at+length));at+=length+1;
   if(p)byBlob.set(id,p);
  }
 }
 // 3. Reachability, authoritative: every object reachable from any ref (missing = filtered large blobs).
 const reachable=new Map();
 for(const line of lines(await run(['rev-list','--objects','--all','--missing=print']))){
  if(line.startsWith('?'))continue;
  const sp=line.indexOf(' '),id=sp<0?line:line.slice(0,sp);
  if(byBlob.has(id))reachable.set(id,sp<0?'':line.slice(sp+1));
 }
 const usage=(blob)=>{
  const p=byBlob.get(blob);let u=pointers.get(p.oid);
  if(!u){u={oid:p.oid,size:p.size,loose:Boolean(p.loose),blobs:new Set(),paths:new Set(),currentPaths:new Set(),refs:new Set(),via:new Set(),firstCommit:null,lastCommit:null,commits:0};pointers.set(p.oid,u);}
  else if(u.size===null&&p.size!==null){u.size=p.size;u.loose=Boolean(p.loose);}
  else if(p.size!==null&&u.size!==null&&p.size!==u.size)u.sizeConflict=true;
  if(!p.loose)u.loose=false;
  u.blobs.add(blob);return u;
 };
 for(const [blob,name] of reachable){const u=usage(blob);if(name)u.paths.add(name);}
 // 4. Where: every commit reachable from any ref, with the files it added or changed (diff to its first
 //    parent), the ref it was reached from, and its date.
 let commits=0;
 if(reachable.size){
  const log=await run(['log','--all','--source','--no-renames','--raw','--no-abbrev','--diff-merges=first-parent','-z','--format=%x01%H %ct %S']);
  for(const chunk of log.toString('utf8').split('\x01')){
   if(!chunk)continue;
   const nul=chunk.indexOf('\0');const head=(nul<0?chunk:chunk.slice(0,nul)).trim();
   const hm=/^([a-f0-9]{40,64}) (\d+) (.*)$/.exec(head);if(!hm)throw new GitError('scan-failed');
   commits++;
   const commit={sha:hm[1],at:new Date(Number(hm[2])*1000).toISOString()},via=hm[3];
   const parts=nul<0?[]:chunk.slice(nul+1).replace(/^\n/,'').split('\0');
   for(let i=0;i+1<parts.length;i+=2){
    const meta=parts[i].replace(/^\n/,''),file=parts[i+1];
    const mm=/^:\d{6} \d{6} [a-f0-9]{40,64} ([a-f0-9]{40,64}) [A-Z]\d*$/.exec(meta);if(!mm)continue;
    if(!reachable.has(mm[1]))continue;
    const u=usage(mm[1]);u.paths.add(file);u.commits++;if(via.startsWith('refs/'))u.via.add(via);
    // git log walks newest first: the first commit met is the latest one, the last met the earliest.
    if(!u.lastCommit||u.lastCommit.at<commit.at)u.lastCommit=commit;
    if(!u.firstCommit||u.firstCommit.at>=commit.at)u.firstCommit=commit;
   }
  }
 }
 // 5. Tips: which refs contain it right now. The default branch always; then branches and tags, up to tipLimit.
 // Only tips that are (or peel to) a commit have a tree to read: a tag may point at a blob or a tree.
 const tips=[...(defaultRef?[defaultRef]:[]),...refs.filter(r=>r.name!==defaultRef&&r.peeled==='commit'&&/^refs\/(heads|tags)\//.test(r.name)).map(r=>r.name)];
 const read=tips.slice(0,Math.max(1,tipLimit));
 for(const ref of reachable.size?read:[]){
  const out=await run(['ls-tree','-r','-z',ref+'^{tree}']);
  for(const entry of out.toString('utf8').split('\0')){
   const m=/^\d{6} blob ([a-f0-9]{40,64})\t([\s\S]+)$/.exec(entry);if(!m||!reachable.has(m[1]))continue;
   const u=usage(m[1]);u.refs.add(ref);u.paths.add(m[2]);if(ref===defaultRef)u.currentPaths.add(m[2]);
  }
 }
 // Pointers the mirror still holds but no ref reaches any more (a force-push, a deleted branch): the objects
 // they name are candidates for "orphaned", once the host confirms it still stores them.
 const unreachable=new Map();
 for(const [blob,p] of byBlob)if(!reachable.has(blob)&&!pointers.has(p.oid)&&!unreachable.has(p.oid))unreachable.set(p.oid,{oid:p.oid,size:p.size});
 return {refs,revision,defaultRef,pointers,unreachable:[...unreachable.values()],complete:true,
  stats:{blobs:small.length,pointers:pointers.size,commits,tipsRead:reachable.size?read.length:0,tipsSkipped:Math.max(0,tips.length-read.length)}};
}

// The refs revision as scanMirror computes it, from a list of {name, sha}: one sha and name per line, by name.
export function refsHash(refs){
 return hashOf([...refs].sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0).map(r=>`${r.sha} ${r.name}`).join('\n'));
}
/**
 * The host's refs right now, without fetching anything (git ls-remote), hashed like scanMirror's revision.
 * Used between deletions to notice a push that happened after the re-scan.
 */
export async function remoteRefsHash(url,auth,{git=gitBinary(),timeoutMs=60000}={}){
 if(!/^https?:\/\//.test(url))throw new GitError('invalid-url');
 const refs=[];
 for(const line of lines(await runGit(['ls-remote','--refs',url],{auth,git,timeoutMs,maxBytes:64*MB}))){
  const m=/^([a-f0-9]{40,64})\t(refs\/\S.*)$/.exec(line);if(!m)throw new GitError('scan-failed');
  refs.push({name:m[2],sha:m[1]});
 }
 return refsHash(refs);
}

// A plain description of one usage (Sets → sorted, bounded lists) for the catalog.
export function usageView(u,{max=50}={}){
 const list=s=>[...s].sort().slice(0,max);
 return {oid:u.oid,size:u.size,loose:u.loose||undefined,sizeConflict:u.sizeConflict||undefined,paths:list(u.paths),pathCount:u.paths.size,currentPaths:list(u.currentPaths),
  refs:list(u.refs),refCount:u.refs.size,via:list(u.via),firstCommit:u.firstCommit,lastCommit:u.lastCommit,commits:u.commits};
}
export const validSha=s=>typeof s==='string'&&SHA.test(s);
