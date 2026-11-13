#!/usr/bin/env node
// Deprecated, removed in 2.0, with scripts/export-public.mjs: core is developed in the public repository.
// Commits a fresh public export onto the local branch `public`:
//   node scripts/publish-public-branch.mjs [--branch public] [--author-name N] [--author-email E]
// - The branch is an ORPHAN: its first commit has no parent, and each later export is one commit on top of
//   the previous export. It never shares history with main, so no private commit can reach a public
//   remote by ancestry. The script refuses if the branch has a commit in common with the current HEAD.
// - The commit carries a neutral author and committer, not your git identity: an e-mail address in commit
//   metadata would be published with the branch, and the leak scan only reads file contents.
// - It works through a temporary index and directory: your working tree, index and HEAD are not touched.
// - It never pushes. Publishing the branch is a separate, deliberate step.
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {exportPublic} from './export-public.mjs';
import {repoRoot} from './leak-scan.mjs';

const option=(args,name,fallback)=>{const i=args.indexOf(name);return i>=0&&args[i+1]?args[i+1]:fallback;};
export function publishPublicBranch({root=repoRoot,branch='public',authorName='Home Hub export',authorEmail='export@home-hub.invalid',log=()=>{}}={}){
 if(!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,80}$/.test(branch)||['main','master'].includes(branch))throw new Error(`"${branch}" is not a usable branch name for the public export.`);
 const git=(args,env={})=>execFileSync('git',['-C',root,...args],{encoding:'utf8',env:{...process.env,...env},stdio:['ignore','pipe','pipe']}).trim();
 const ref=`refs/heads/${branch}`;
 let parent=null;try{parent=git(['rev-parse','--verify','-q',`${ref}^{commit}`]);}catch{}
 if(parent){
  let shared='';try{shared=git(['merge-base',parent,'HEAD']);}catch{}
  if(shared)throw new Error(`Branch ${branch} shares history with HEAD (${shared.slice(0,10)}). It must be an orphan; delete it and run again.`);
  if(git(['worktree','list','--porcelain']).split('\n').includes(`branch ${ref}`))throw new Error(`Branch ${branch} is checked out in a worktree. Switch that worktree away first.`);
 }
 const dir=mkdtempSync(path.join(os.tmpdir(),'home-hub-public-')),tree=path.join(dir,'tree'),index=path.join(dir,'index');
 try{
  const exported=exportPublic(tree,{root,log});
  const env={GIT_INDEX_FILE:index,GIT_WORK_TREE:tree};
  git(['add','-A','.'],env);
  const treeId=git(['write-tree'],env);
  if(parent&&git(['rev-parse',`${parent}^{tree}`])===treeId){log(`Nothing changed since the last export; ${branch} stays at ${parent.slice(0,10)}.`);return {branch,commit:parent,changed:false,files:exported.files};}
  const identity={GIT_AUTHOR_NAME:authorName,GIT_AUTHOR_EMAIL:authorEmail,GIT_COMMITTER_NAME:authorName,GIT_COMMITTER_EMAIL:authorEmail};
  const message=`Public export ${new Date().toISOString().slice(0,10)}\n\n${exported.files} files. History of the private repository is not included.\n`;
  const commit=git(['commit-tree',treeId,...(parent?['-p',parent]:[]),'-m',message],identity);
  git(['update-ref','-m',`public export`,ref,commit,...(parent?[parent]:[])]);
  log(`${branch} → ${commit.slice(0,10)} (${parent?'on top of '+parent.slice(0,10):'first export, no parent'}). Nothing was pushed.`);
  return {branch,commit,changed:true,files:exported.files};
 }finally{rmSync(dir,{recursive:true,force:true});}
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2);
 console.error('Deprecated: scripts/publish-public-branch.mjs is removed in Home Hub 2.0. Core is developed in the public repository (AGENTS.md → Development).');
 try{publishPublicBranch({branch:option(args,'--branch','public'),authorName:option(args,'--author-name',process.env.PUBLIC_AUTHOR_NAME||'Home Hub export'),authorEmail:option(args,'--author-email',process.env.PUBLIC_AUTHOR_EMAIL||'export@home-hub.invalid'),log:console.log});}
 catch(e){console.error(e.message);process.exit(1);}
}
