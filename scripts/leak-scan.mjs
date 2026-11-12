// Which files make up the public core, and the scan that keeps household details out of them.
// Used by scripts/export-public.mjs (refuses to export on a finding) and tests/leak.test.mjs (npm test
// fails on a finding), so both look at exactly the same files with exactly the same rules.
//   node scripts/leak-scan.mjs        list findings in the files an export would include (exit 1 if any)
import {readFileSync,readdirSync,existsSync,statSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const repoRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
// Never exported: the household overlay, anything a running hub writes, deployment recipes, and the
// documents that describe this one deployment (the export writes its own README).
export const EXCLUDED_DIRS=Object.freeze(['local','private','data','state','router-private','deploy','node_modules','.git','.claude']);
// Written by the export itself (the private README describes this deployment).
export const EXCLUDED_FILES=Object.freeze(['README.md','edition.json','.gitignore']);
const IGNORED_NAMES=/^(\.DS_Store|__pycache__|.*\.pem|.*\.key|home-hub-preview\.png)$/;
// Throwaway TLS keys the core tests need (tests/fixtures/tls-README.md); every other *.key stays out.
export const FIXTURE_KEYS=/^tests\/fixtures\/tls-[a-z]+\.key$/;
const excluded=(rel,generated=false)=>!FIXTURE_KEYS.test(rel)&&(EXCLUDED_DIRS.some(d=>rel===d||rel.startsWith(d+'/'))||(!generated&&EXCLUDED_FILES.includes(rel))||rel.split('/').some(part=>IGNORED_NAMES.test(part)));

// Tracked files when this is a git checkout (untracked scratch files never leave); every file otherwise
// (an exported tree is not a repository).
// generated:true also lists the files an export writes itself (README.md, edition.json): for scanning a
// finished public tree rather than choosing what to copy.
export function exportFiles(root=repoRoot,{generated=false}={}){
 let all;
 if(existsSync(path.join(root,'.git'))){
  all=execFileSync('git',['-C',root,'ls-files','-z'],{encoding:'utf8',maxBuffer:64*1024*1024}).split('\0').filter(Boolean).filter(f=>existsSync(path.join(root,f)));
 }else{
  all=[];const walk=dir=>{for(const e of readdirSync(path.join(root,dir),{withFileTypes:true})){const rel=dir?`${dir}/${e.name}`:e.name;if(excluded(rel,generated))continue;if(e.isDirectory())walk(rel);else if(e.isFile())all.push(rel);}};walk('');
 }
 return all.filter(f=>!excluded(f,generated)).sort();
}

// What must not appear in the public core. Matching is per line; `allow(match, line, index)` lists the
// neutral placeholders and technical look-alikes that are fine.
const EMAIL=/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
// Placeholder mail domains, plus strings that look like an address but are not one: OpenSSH key and
// certificate type names (sk-ssh-ed25519@openssh.com) and scp-style git remotes (git@host:path).
const EMAIL_ALLOWED=/@(?:[a-z0-9-]+\.)*example\.(?:com|org|net|lan)$|@(?:[a-z0-9-]+\.)*(?:test|invalid|localhost)$|@openssh\.com$|^git@/i;
// The words themselves are assembled from pieces, so that this file passes its own scan.
const word=(...parts)=>parts.join('');
const OWNER=word('sg','dovin'),SITE=word('sla','ader'),SUBNET=word('192','\\.168','\\.50');
// The one place the site word may stand: the public repository's slug, "<site word>/home_hub", written in
// lower case, on its own (after a quote, a space, a bracket…) or right after "github.com/" (with or without
// https://). Not as part of a longer path, another host, another repository name, or an address.
const PUBLIC_REPO=word(SITE,'/home','_hub');
function publicRepoSlug(match,text,index){
 if(match!==SITE||text.slice(index,index+PUBLIC_REPO.length)!==PUBLIC_REPO)return false;
 if(/[A-Za-z0-9_-]/.test(text[index+PUBLIC_REPO.length]||''))return false;
 const before=text.slice(Math.max(0,index-40),index);
 return /(?:^|[^A-Za-z0-9_.\/@:-])$/.test(before)||/(?:^|[^A-Za-z0-9_.\/@:-])(?:https:\/\/)?github\.com\/$/.test(before);
}
export const LEAK_RULES=Object.freeze([
 {id:'owner-name',pattern:new RegExp(OWNER,'gi')},
 {id:'home-subnet',pattern:new RegExp(SUBNET,'g')},
 // A macOS home path. Placeholder users (alice, bob, you) and the shell variable in the SSH probe are fine.
 {id:'home-path',pattern:/\/Users\/[^\s'"`)]*/g,allow:m=>/^\/Users\/(?:alice|bob|you|example|Shared)(?:\/|$)|^\/Users\/\$|^\/Users\/<|^\/Users\/\*|^\/Users\/$/.test(m)},
 // The site word is also the owner of the public repository, and the update check has to name that repository
 // (package.json → homeHub.updates.repo). Exactly that slug passes, and nothing else: see publicRepoSlug.
 {id:'site-name',pattern:new RegExp(SITE,'gi'),allow:(m,text,index)=>publicRepoSlug(m,text,index)},
 {id:'home-domain',pattern:new RegExp(word('home\\.',OWNER),'gi')},
 {id:'email',pattern:EMAIL,allow:m=>EMAIL_ALLOWED.test(m)},
]);
const TEXT=/\.(mjs|js|ts|json|md|css|html|svg|sh|py|txt|webmanifest|yml|yaml|toml|plist|swift|cnf|conf)$|^(AGENTS|SPEC|LICENSE|README)[^/]*$|\/(Caddyfile[^/]*|LICENSE[^/]*|[A-Z-]+-LICENSE)$/;
// Third-party files vendored as they were published (their licences name their authors).
const VENDORED=/^public\/vendor\//;
export const isScanned=file=>TEXT.test(file)&&!VENDORED.test(file);

// → [{file, line, rule, match}]
export function scanText(file,text){
 const out=[];const lines=text.split('\n');
 for(let i=0;i<lines.length;i++)for(const rule of LEAK_RULES){
  rule.pattern.lastIndex=0;let m;
  while((m=rule.pattern.exec(lines[i]))!==null){if(!rule.allow?.(m[0],lines[i],m.index))out.push({file,line:i+1,rule:rule.id,match:m[0].slice(0,80)});if(m[0]==='')rule.pattern.lastIndex++;}
 }
 return out;
}
// Pictures and other binary files carry text too (EXIF comments, generator metadata with paths): their
// bytes are searched for everything except e-mail addresses, which random bytes would imitate.
export function scanBinary(file,buffer){
 const text=buffer.toString('latin1'),out=[];
 for(const rule of LEAK_RULES){if(rule.id==='email')continue;rule.pattern.lastIndex=0;let m;
  while((m=rule.pattern.exec(text))!==null){if(!rule.allow?.(m[0],text,m.index))out.push({file,line:0,rule:rule.id,match:m[0].replace(/[^\x20-\x7e]/g,'?').slice(0,80)});if(m[0]==='')rule.pattern.lastIndex++;}}
 return out;
}
export function scanLeaks(root=repoRoot,files=exportFiles(root)){
 const findings=[];
 for(const file of files){
  if(VENDORED.test(file))continue;
  const full=path.join(root,file);if(statSync(full).size>16*1024*1024)continue;
  findings.push(...(isScanned(file)?scanText(file,readFileSync(full,'utf8')):scanBinary(file,readFileSync(full))));
 }
 return findings;
}
export const formatFindings=findings=>findings.map(f=>`${f.file}:${f.line}  ${f.rule}  ${f.match}`).join('\n');

if(process.argv[1]===fileURLToPath(import.meta.url)){
 const findings=scanLeaks();
 if(findings.length){console.error(formatFindings(findings));console.error(`\n${findings.length} finding(s) in files a public export would include.`);process.exit(1);}
 console.log(`No household details in the ${exportFiles().length} files a public export includes.`);
}
