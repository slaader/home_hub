#!/usr/bin/env node
// The leak scan before a push. git runs it through scripts/hooks/pre-push once a checkout says so:
//   git config core.hooksPath scripts/hooks
// It refuses the push when anything the push would publish breaks a rule of scripts/leak-scan.mjs (those rules
// exactly, the one public slug included):
//   - every file of every pushed tip: a branch, or what a pushed tag points at;
//   - every file version the pushed commits bring that the remote does not have yet: a value added in one
//     commit and taken out in the next is published all the same;
//   - those commits' messages, and their authors' and committers' names and e-mail addresses;
//   - every pushed annotated tag: its name, its message and its tagger; and the names of the pushed refs.
// What the remote has is what its remote-tracking refs (refs/remotes/<remote>/*) and the refs being replaced point
// at. Everything else counts as new, so a remote without tracking refs (a URL, an empty mirror) is checked in full.
// Deleting a ref is never refused. It writes nothing. When it cannot check (git fails, an object is missing) it
// refuses rather than let the push through.
//   git push → node scripts/pre-push.mjs <remote> <url>, with "<local ref> <local sha> <remote ref> <remote sha>"
//   lines on stdin (githooks(5) → pre-push)
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {scanText,scanContent,scanMode,MAX_SCANNED_BYTES} from './leak-scan.mjs';

const ZERO=/^0+$/;
const short=sha=>sha.slice(0,7);
export const NEUTRAL_IDENTITY=Object.freeze({name:'Home Hub',email:'dev@home-hub.invalid'});

/** The lines git writes to the hook → [{localRef, localSha, remoteRef, remoteSha}]. */
export function parseUpdates(text){
 return String(text).split('\n').map(line=>line.trim()).filter(Boolean).map(line=>{
  const [localRef,localSha,remoteRef,remoteSha,...rest]=line.split(/\s+/);
  if(rest.length||!/^[0-9a-f]+$/.test(localSha||'')||!/^[0-9a-f]+$/.test(remoteSha||''))throw new Error(`cannot read the ref line "${line}"`);
  return {localRef,localSha,remoteRef,remoteSha};
 });
}

const gitIn=cwd=>(args,{input,binary=false}={})=>execFileSync('git',args,{cwd,input,...(binary?{}:{encoding:'utf8'}),maxBuffer:1<<30,stdio:['pipe','pipe','pipe']});
const lines=text=>text.split('\n').filter(Boolean);
const HEADER=/^([0-9a-f]+) ([a-z]+) (\d+)$/;
// git cat-file --batch-check over many objects → Map sha → {type, size}. A missing object is an error.
function objectInfo(git,shas){
 const out=new Map();if(!shas.length)return out;
 for(const line of lines(git(['cat-file','--batch-check'],{input:shas.join('\n')+'\n'}))){
  const m=HEADER.exec(line);if(!m)throw new Error(`git cat-file: ${line}`);
  out.set(m[1],{type:m[2],size:Number(m[3])});
 }
 return out;
}
// git cat-file --batch → Map sha → Buffer.
function objectData(git,shas){
 const out=new Map();if(!shas.length)return out;
 const buffer=git(['cat-file','--batch'],{input:shas.join('\n')+'\n',binary:true});
 for(let i=0;i<buffer.length;){
  const nl=buffer.indexOf(10,i);if(nl<0)break;
  const header=buffer.toString('utf8',i,nl),m=HEADER.exec(header);if(!m)throw new Error(`git cat-file: ${header}`);
  const size=Number(m[3]);out.set(m[1],buffer.subarray(nl+1,nl+1+size));i=nl+1+size+1;
 }
 return out;
}
// The blobs of a tree, every level: [{sha, path}].
const treeFiles=(git,tree)=>git(['ls-tree','-r','-z','--full-tree',tree]).split('\0').filter(Boolean).map(entry=>{
 const tab=entry.indexOf('\t'),[,type,sha]=entry.slice(0,tab).split(' ');return {type,sha,path:entry.slice(tab+1)};
}).filter(e=>e.type==='blob');

/** A commit or tag object's text → {fields: [{key, value}], message}; continuation lines are joined. */
export function parseObject(text){
 const cut=text.indexOf('\n\n'),head=cut<0?text:text.slice(0,cut),message=cut<0?'':text.slice(cut+2),fields=[];
 for(const line of head.split('\n')){
  if(line.startsWith(' ')&&fields.length)fields.at(-1).value+='\n'+line.slice(1);
  else{const sp=line.indexOf(' ');fields.push(sp<0?{key:line,value:''}:{key:line.slice(0,sp),value:line.slice(sp+1)});}
 }
 return {fields,message};
}
// "Name <mail> 1794530908 +0100" → "Name <mail>"
const identity=value=>value.replace(/ -?\d+ [+-]\d{4}$/,'');
// A signed tag ends with its signature: armoured base64, not text anyone wrote.
const withoutSignature=message=>message.replace(/-----BEGIN (PGP|SSH) SIGNATURE-----\n[\s\S]*?-----END \1 SIGNATURE-----\n?$/,'');
const textFindings=(where,text)=>scanText('',text).map(f=>({where,rule:f.rule,match:f.match}));
// What a commit or a tag says about itself: who made it, its name, its message.
function metadataFindings(label,text,kind){
 const {fields,message}=parseObject(text),out=[];
 for(const {key,value} of fields){
  if(key==='author'||key==='committer'||key==='tagger')out.push(...textFindings(`${label} ${key}`,identity(value)));
  else if(key==='tag')out.push(...textFindings(`${label} name`,value));
  else if(key==='mergetag')out.push(...metadataFindings(`${label} mergetag`,value,'tag'));
 }
 const body=kind==='tag'?withoutSignature(message):message;
 for(const f of scanText('',body))out.push({where:`${label} message, line ${f.line}`,rule:f.rule,match:f.match});
 return out;
}

/**
 * Everything a push of `updates` to `remote` would publish, scanned.
 * → {findings: [{where, rule, match}], commits, files, tags}: the counts of what was looked at.
 */
export function checkPush({cwd=process.cwd(),remote='',updates}){
 const git=gitIn(cwd),findings=[];
 let newCommits=[],scanned=0,tags=0;
 const result=()=>({findings,commits:newCommits.length,files:scanned,tags});
 const pushing=updates.filter(u=>!ZERO.test(u.localSha));
 if(!pushing.length)return result();
 const commitOf=sha=>{try{return git(['rev-parse','-q','--verify',`${sha}^{commit}`]).trim()||null;}catch{return null;}};
 // What the remote already has: its remote-tracking refs and the refs this push replaces.
 const tracking=lines(git(['remote'])).includes(remote)?lines(git(['for-each-ref','--format=%(objectname)',`refs/remotes/${remote}/`])):[];
 const known=[...new Set([...tracking,...updates.filter(u=>!ZERO.test(u.remoteSha)).map(u=>u.remoteSha)].map(commitOf).filter(Boolean))];

 // Each pushed ref, down to what it names. Tags are read on the way; commits and trees are tips.
 const tips=[],trees=[],loose=[];
 for(const u of pushing){
  findings.push(...textFindings(`ref ${u.remoteRef}`,u.remoteRef));
  let sha=u.localSha;
  for(let depth=0;;depth++){
   if(depth>20)throw new Error(`${u.remoteRef}: a chain of more than 20 tags`);
   const {type}=objectInfo(git,[sha]).get(sha);
   if(type==='tag'){
    const text=objectData(git,[sha]).get(sha).toString('utf8'),{fields}=parseObject(text),field=key=>fields.find(f=>f.key===key)?.value;
    findings.push(...metadataFindings(`tag ${field('tag')||short(sha)}`,text,'tag'));tags++;
    const target=field('object');if(!target)throw new Error(`tag ${short(sha)} names no object`);
    sha=target;continue;
   }
   if(type==='commit')tips.push({ref:u.remoteRef,sha});
   else if(type==='tree')trees.push({ref:u.remoteRef,sha});
   else loose.push({ref:u.remoteRef,sha});
   break;
  }
 }

 // The commits the remote does not have: their messages and identities.
 const tipShas=[...new Set(tips.map(t=>t.sha))],range=[...tipShas,...known.map(sha=>`^${sha}`)].join('\n')+'\n';
 newCommits=tipShas.length?lines(git(['rev-list','--stdin'],{input:range})):[];
 const commitText=objectData(git,newCommits);
 for(const sha of newCommits)findings.push(...metadataFindings(`commit ${short(sha)}`,commitText.get(sha).toString('utf8'),'commit'));

 // Files: every file of each tip first (so a finding names the ref it ships in), then every file version those
 // commits bring. Each blob is searched once per way of searching it.
 const candidates=[];
 for(const t of [...tips,...trees])for(const f of treeFiles(git,t.sha))candidates.push({sha:f.sha,path:f.path,where:`${t.ref} ${short(t.sha)} ${f.path}`});
 for(const l of loose)candidates.push({sha:l.sha,path:'',where:l.ref});
 if(tipShas.length)for(const line of lines(git(['rev-list','--objects','--stdin'],{input:range}))){
  const sp=line.indexOf(' ');if(sp<0||sp===line.length-1)continue;
  candidates.push({sha:line.slice(0,sp),path:line.slice(sp+1),where:null});
 }
 const info=objectInfo(git,[...new Set(candidates.map(c=>c.sha))]),chosen=new Map();
 for(const c of candidates){
  const {type,size}=info.get(c.sha),mode=scanMode(c.path);
  if(type!=='blob'||mode==='skip'||size>MAX_SCANNED_BYTES)continue;
  const key=`${c.sha} ${mode}`;if(!chosen.has(key))chosen.set(key,c);
 }
 const data=objectData(git,[...new Set([...chosen.values()].map(c=>c.sha))]);
 for(const c of chosen.values()){
  const hits=scanContent(c.path,data.get(c.sha));scanned++;
  if(!hits.length)continue;
  // Only in an earlier commit of this push, not in any tip: name the commit that brought it.
  const where=c.where??`commit ${lines(git(['log','--format=%h','--stdin',`--find-object=${c.sha}`],{input:range})).at(-1)||'?'} ${c.path}`;
  for(const f of hits)findings.push({where:f.line?`${where}:${f.line}`:where,rule:f.rule,match:f.match});
 }
 return result();
}

export function refusal(findings,{limit=40}={}){
 const width=Math.min(72,Math.max(...findings.map(f=>f.where.length)));
 return [
  'pre-push: refused. This push would publish household details (the rules of scripts/leak-scan.mjs):','',
  ...findings.slice(0,limit).map(f=>`  ${f.where.padEnd(width)}  ${f.rule}  ${f.match}`),
  ...(findings.length>limit?[`  … and ${findings.length-limit} more`]:[]),'',
  'Nothing was pushed. To fix it:',
  '  in a file               change it. When a commit of this push brought it, rewrite that commit rather than adding',
  '                          one on top (the old version would still be published): git commit --amend, git rebase -i',
  '  in a commit message     git commit --amend (the last commit), or git rebase -i <remote>/<branch> (an earlier one)',
  '  author or committer     use the neutral identity of this repository, then rewrite the commits:',
  `                            git config user.name "${NEUTRAL_IDENTITY.name}" && git config user.email ${NEUTRAL_IDENTITY.email}`,
  `                            git rebase --exec 'git commit --amend --no-edit --reset-author' <remote>/<branch>`,
  '  in a tag                git tag -d <tag>, and make it again',
 ].join('\n');
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
 let checked,updates;
 try{updates=parseUpdates(readFileSync(0,'utf8'));checked=checkPush({remote:process.argv[2]||'',updates});}
 catch(e){console.error(`pre-push: refused, because the leak scan could not check this push:\n${String(e.stderr||e.message).trim()}`);process.exit(1);}
 if(checked.findings.length){console.error(refusal(checked.findings));process.exit(1);}
 if(updates.length)console.error(`pre-push: leak scan clean (${checked.commits} new commit(s), ${checked.files} file(s), ${checked.tags} tag(s)).`);
}
