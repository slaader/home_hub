#!/usr/bin/env node
// Cuts a release locally. It checks, bumps package.json, commits and tags. It NEVER pushes and never calls a
// write API: publishing is the owner's step, and the commands for it are printed at the end.
//   node scripts/release.mjs 1.3.0                     check, bump, commit "Release v1.3.0", tag v1.3.0
//   node scripts/release.mjs 1.3.0 --dry-run           every check that needs no change; nothing is written
//   node scripts/release.mjs 1.3.0 --notes             print the CHANGELOG section (the body of the Release)
//   node scripts/release.mjs 1.0.0 --baseline <commit> tag a commit that is already published; no bump, no commit
// Options: --sign (refuse without a signing key), --unsigned (do not sign and do not warn about it),
//          --branch <name> (default main), --remote <name> (in the printed commands; default github, else origin).
//
// It refuses unless: the version is a semver greater than every existing v* tag; the tree is clean and on the
// branch; CHANGELOG.md has a section for the version; a PATCH leaves the data epoch alone and a changed epoch
// is explained under "### Data"; the leak scan is clean; and the tests pass on exactly what ships.
//
// Two kinds of tree (edition.json; AGENTS.md → Development):
//   public   the dev repository. The release commit is tagged on the branch and pushed as it is, so every
//            tracked file is scanned (README.md and .gitignore too) and so is the identity git writes the
//            release commit with.
//   private  (deprecated, removed in 2.0: a tree with the household overlay) nothing of this history may be
//            published. The release commit stays here; scripts/publish-public-branch.mjs commits its export onto
//            the orphan branch `public`, and the tag goes on that commit. The tests run in the exported tree,
//            because that is what ships.
// The tagger is a neutral identity, not your git identity: a tag object is published with its tagger's name
// and e-mail address. Signing, when a key is configured, is by that key and does not depend on the tagger.
import {execFileSync,spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,existsSync,mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {repoRoot,scanLeaks,scanText,exportFiles,formatFindings} from './leak-scan.mjs';
import {NEUTRAL_IDENTITY} from './pre-push.mjs';
import {exportPublic} from './export-public.mjs';
import {publishPublicBranch} from './publish-public-branch.mjs';
import {readEdition} from '../server/edition.mjs';
import {compareVersions} from '../server/versions.mjs';
import {SEMVER,validRepo} from '../server/version.mjs';

export const CHANGELOG_HEADINGS=Object.freeze(['Added','Changed','Deprecated','Fixed','Plugin contract','Data','Upgrade notes']);
const TAGGER={name:'Home Hub release',email:'release@home-hub.invalid'};
const refuse=message=>{throw Object.assign(new Error(message),{refused:true});};

// --- CHANGELOG.md ------------------------------------------------------------------------------------
// "## 1.3.0" or "## 1.3.0 (2026-11-20)" starts a version; its section runs to the next "## ".
const SECTION=/^## v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:[ \t].*)?$/;
export function changelogSections(text){
 const out=[];let current=null;
 for(const line of String(text).split('\n')){
  const m=SECTION.exec(line);
  if(m){current={version:m[1],lines:[]};out.push(current);}
  else if(/^## /.test(line))current=null;
  else if(current)current.lines.push(line);
 }
 return out.map(s=>({version:s.version,body:s.lines.join('\n').trim()}));
}
/** The section of one version, as the body of its Release; null when there is none. */
export const changelogSection=(text,version)=>changelogSections(text).find(s=>s.version===version)?.body??null;

// --- versions ----------------------------------------------------------------------------------------
const parts=v=>SEMVER.exec(v).slice(1,4).map(Number);
/** major | minor | patch | prerelease: what `next` is, coming from `previous` (null = the first release). */
export function bumpKind(previous,next){
 if(!previous)return 'major';
 const [a,b,c]=parts(previous),[x,y,z]=parts(next);
 return x!==a?'major':y!==b?'minor':z!==c?'patch':'prerelease';
}
const dataEpochOf=text=>{try{const e=JSON.parse(text)?.homeHub?.dataEpoch;return Number.isSafeInteger(e)&&e>=1?e:1;}catch{return 1;}};

function context(root){
 const git=(args,options={})=>execFileSync('git',['-C',root,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe'],...options}).trim();
 const tryGit=args=>{try{return git(args);}catch{return null;}};
 const tags=()=>(tryGit(['tag','--list','v*'])||'').split('\n').map(t=>t.trim()).filter(t=>SEMVER.test(t.slice(1)));
 const lastTag=()=>tags().sort((a,b)=>compareVersions(a.slice(1),b.slice(1))).at(-1)||null;
 return {git,tryGit,tags,lastTag};
}
// How the tag will be made: signed when a key is configured, else annotated and unsigned.
export function signingPlan({key,sign=false,unsigned=false}){
 if(sign&&unsigned)refuse('Pass --sign or --unsigned, not both.');
 if(unsigned)return {signed:false,warn:false};
 if(key)return {signed:true,warn:false};
 if(sign)refuse(`--sign needs a signing key, and none is configured.\n${SIGNING_HELP}`);
 return {signed:false,warn:true};
}
export const SIGNING_HELP=`To sign release tags with an SSH key (keep the private key off the machine that runs the hub):
  ssh-keygen -t ed25519 -f ~/.ssh/home-hub-release -C home-hub-release
  git config gpg.format ssh
  git config user.signingkey ~/.ssh/home-hub-release.pub
  echo "release $(cat ~/.ssh/home-hub-release.pub)" > config/release-signers    # commit this file
Check a tag with:
  git -c gpg.ssh.allowedSignersFile=config/release-signers verify-tag v<version>`;

// --- the checks that run a suite ---------------------------------------------------------------------
const passes=(command,args,cwd,log)=>{log(`  $ ${[command,...args].join(' ')}   (in ${cwd})`);return spawnSync(command,args,{cwd,stdio:['ignore','ignore','inherit']}).status===0;};
/** The default suites: npm test and the python suite, in the directory that ships. */
export const SUITES=Object.freeze({
 tests:(dir,log)=>passes(process.execPath,[path.join(dir,'scripts','run-tests.mjs')],dir,log),
 python:(dir,log)=>!existsSync(path.join(dir,'tests','router_unifi_test.py'))||passes('python3',[path.join(dir,'tests','router_unifi_test.py')],dir,log),
});

/**
 * → {version, tag, mode, commit, tagged, signed, publish: [command, …], undo: [command, …], notes}
 * Throws an Error with .refused for anything it will not release. suites, publish: stand-ins for the tests.
 */
export function release({root=repoRoot,version,baseline=null,dryRun=false,sign=false,unsigned=false,branch='main',remote=null,suites=SUITES,publish=publishPublicBranch,log=()=>{}}={}){
 if(typeof version!=='string'||!SEMVER.test(version))refuse(`"${version}" is not a version. Use a semver such as 1.3.0 (no leading v).`);
 const {git,tryGit,tags,lastTag}=context(root),tag=`v${version}`;
 if(tryGit(['rev-parse','--git-dir'])===null)refuse(`${root} is not a git checkout.`);
 const mode=readEdition(root,{})==='private'?'private':'public';
 if(tags().includes(tag)||tryGit(['rev-parse','-q','--verify',`refs/tags/${tag}`]))refuse(`Tag ${tag} already exists.`);
 const changelogFile=path.join(root,'CHANGELOG.md');
 const notes=existsSync(changelogFile)?changelogSection(readFileSync(changelogFile,'utf8'),version):null;
 if(!notes)refuse(`CHANGELOG.md has no section "## ${version}" with text in it. Write what changed first.`);
 const packageFile=path.join(root,'package.json');
 const pkg=JSON.parse(readFileSync(packageFile,'utf8')),slug=validRepo(pkg.homeHub?.updates?.repo)?pkg.homeHub.updates.repo:null;
 const pushTo=remote||((tryGit(['remote'])||'').split('\n').includes('github')?'github':'origin');
 const plan=signingPlan({key:tryGit(['config','--get','user.signingkey']),sign,unsigned});
 const notesCommand=`node scripts/release.mjs ${version} --notes | gh release create ${tag}${slug?` --repo ${slug}`:''} --title ${tag} --notes-file - --verify-tag`;
 const makeTag=commit=>{
  git(['tag',plan.signed?'-s':'-a','-m',`Home Hub ${version}`,tag,commit],{env:{...process.env,GIT_COMMITTER_NAME:process.env.PUBLIC_AUTHOR_NAME||TAGGER.name,GIT_COMMITTER_EMAIL:process.env.PUBLIC_AUTHOR_EMAIL||TAGGER.email}});
  if(plan.warn)log(`\nWARNING: ${tag} is NOT signed: no signing key is configured (git config user.signingkey).\nAnyone who can move the tag or tamper with a mirror can change what "${tag}" means. Pass --unsigned to accept that without this warning.\n${SIGNING_HELP}\n`);
 };

 // --- a release of something already published: a tag on an existing commit, nothing else ---------------
 if(baseline!==null){
  const commit=tryGit(['rev-parse','-q','--verify',`${baseline}^{commit}`]);
  if(!commit)refuse(`"${baseline}" is not a commit in this repository. Fetch the public repository first.`);
  const there=tryGit(['show',`${commit}:package.json`]);
  let said=null;try{said=JSON.parse(there).version;}catch{}
  if(said!==version)refuse(`package.json at ${commit.slice(0,7)} says version ${JSON.stringify(said)}, not ${version}. A baseline names what is already out; it does not rename it.`);
  // In a tree with private history, only a commit of the public line may carry a tag that will be pushed.
  if(mode==='private'&&tryGit(['merge-base',commit,'HEAD']))refuse(`${commit.slice(0,7)} shares history with this private branch. Only a commit of the public export (the orphan branch) can be released from here.`);
  const newer=tags().filter(t=>compareVersions(t.slice(1),version)>=0);
  if(newer.length)refuse(`${newer.join(', ')} already exist(s); a baseline comes before every other release.`);
  const publishCommands=[`git push ${pushTo} refs/tags/${tag}`,notesCommand];
  if(dryRun){log(`Dry run: would tag ${commit.slice(0,7)} as ${tag} (${plan.signed?'signed':'unsigned'}).`);return {version,tag,mode,commit,tagged:false,signed:plan.signed,publish:publishCommands,undo:[],notes};}
  makeTag(commit);
  return {version,tag,mode,commit,tagged:true,signed:plan.signed,publish:publishCommands,undo:[`git tag -d ${tag}`],notes};
 }

 // --- a new release -------------------------------------------------------------------------------------
 const on=tryGit(['symbolic-ref','--short','-q','HEAD']);
 if(on!==branch)refuse(`Releases are cut from ${branch}; this checkout is on ${on||'a detached HEAD'}.`);
 const dirty=git(['status','--porcelain']);
 if(dirty)refuse(`The working tree is not clean:\n${dirty.split('\n').slice(0,10).join('\n')}`);
 // A public tree publishes the release commit as it is, under the identity git writes it with.
 if(mode==='public')for(const who of ['GIT_AUTHOR_IDENT','GIT_COMMITTER_IDENT']){
  const ident=(tryGit(['var',who])||'').replace(/ -?\d+ [+-]\d{4}$/,''),found=ident?scanText(who,ident):[];
  if(!ident||found.length)refuse(`${ident?`The release commit would be published as "${ident}" (${found.map(f=>f.rule).join(', ')}).`:`git has no identity to write the release commit with (${who}).`} Use the neutral identity of this repository: git config user.name "${NEUTRAL_IDENTITY.name}" && git config user.email ${NEUTRAL_IDENTITY.email}`);
 }
 const last=lastTag(),previous=last?last.slice(1):null;
 if(previous&&!(compareVersions(version,previous)>0))refuse(`${version} is not greater than the last release (${previous}).`);
 if(compareVersions(version,pkg.version)<0)refuse(`${version} is lower than package.json (${pkg.version}).`);
 // The data epoch: a PATCH never changes an on-disk format; a release that does says so under "### Data".
 const epoch=dataEpochOf(JSON.stringify(pkg)),before=previous?dataEpochOf(tryGit(['show',`${last}:package.json`])):null;
 const kind=bumpKind(previous,version);
 if(before!==null&&epoch<before)refuse(`The data epoch went down (${before} → ${epoch}). It only rises.`);
 if(before!==null&&epoch!==before){
  if(kind==='patch')refuse(`The data epoch changed (${before} → ${epoch}) and ${version} is a PATCH. A change of on-disk format needs a MINOR release.`);
  if(!/^### Data\s*$/m.test(notes))refuse(`The data epoch changed (${before} → ${epoch}); the CHANGELOG section for ${version} needs a "### Data" part that says what and how to roll back.`);
 }
 // A public tree publishes every tracked file as it is; an export writes its own README.md and .gitignore.
 const findings=scanLeaks(root,exportFiles(root,{generated:mode==='public'}));
 if(findings.length)refuse(`The leak scan found ${findings.length} household detail(s) in files that would be published:\n${formatFindings(findings.slice(0,20))}`);
 // What the public repository has (as last fetched) must be part of what we are about to put on top of.
 if(mode==='private'){
  const theirs=tryGit(['rev-parse','-q','--verify',`refs/remotes/${pushTo}/main^{commit}`]),ours=tryGit(['rev-parse','-q','--verify','refs/heads/public^{commit}']);
  if(theirs&&ours&&theirs!==ours&&tryGit(['merge-base','--is-ancestor',theirs,ours])===null)
   refuse(`${pushTo}/main (${theirs.slice(0,7)}) has a commit the local branch "public" (${ours.slice(0,7)}) does not: an edit made on the web. Bring it in first (the runbook for publishing says how), or a push would discard it.`);
 }
 if(dryRun){log(`Dry run: ${version} (${kind}) could be released from ${branch} in this ${mode} tree. The test suites were not run.`);return {version,tag,mode,commit:null,tagged:false,signed:plan.signed,publish:[],undo:[],notes};}

 // From here on the tree changes. A failed suite puts package.json back.
 const head=git(['rev-parse','HEAD']),original=readFileSync(packageFile,'utf8');
 const bumped=original.replace(/("version"\s*:\s*")[^"]*(")/,`$1${version}$2`);
 if(JSON.parse(bumped).version!==version)refuse('package.json: the version line could not be rewritten.');
 writeFileSync(packageFile,bumped);
 const restore=()=>writeFileSync(packageFile,original);
 const scratch=mode==='private'?mkdtempSync(path.join(os.tmpdir(),'home-hub-release-')):null;
 try{
  const ships=mode==='private'?path.join(scratch,'tree'):root;
  if(mode==='private'){exportPublic(ships,{root});log(`Testing the exported tree (what ships):`);}else log('Testing this tree:');
  if(!suites.tests(ships,log)){restore();refuse('npm test failed on what would ship. Nothing was committed or tagged.');}
  if(!suites.python(ships,log)){restore();refuse('The python suite failed on what would ship. Nothing was committed or tagged.');}
 }catch(e){restore();throw e;}
 finally{if(scratch)rmSync(scratch,{recursive:true,force:true});}
 if(bumped!==original){git(['add','package.json']);git(['commit','-q','-m',`Release ${tag}`]);}
 const releaseCommit=git(['rev-parse','HEAD']);
 // The release commit exists now. If tagging fails (a signing key that does not work), say how to finish or go back.
 const tagged=make=>{try{return make();}catch(e){refuse(`The release commit ${releaseCommit.slice(0,7)} was made, but tagging failed: ${String(e.stderr||e.message).trim().split('\n').at(-1)}\nFix the cause and run this again with the same version (the bump is already committed), or go back with: git reset --hard ${head.slice(0,12)}`);}};
 if(mode==='public'){
  tagged(()=>makeTag(releaseCommit));
  return {version,tag,mode,commit:releaseCommit,releaseCommit,tagged:true,signed:plan.signed,notes,
   publish:[`git push ${pushTo} ${branch} refs/tags/${tag}`,notesCommand],
   undo:[`git tag -d ${tag}`,...(releaseCommit!==head?[`git reset --hard ${head.slice(0,12)}`]:[])]};
 }
 const publicBefore=tryGit(['rev-parse','-q','--verify','refs/heads/public^{commit}']);
 const exported=tagged(()=>{const done=publish({root,log});makeTag(done.commit);return done;});
 return {version,tag,mode,commit:exported.commit,releaseCommit,tagged:true,signed:plan.signed,notes,
  publish:[`git push origin ${branch}`,`git push ${pushTo} refs/heads/${exported.branch}:refs/heads/main refs/tags/${tag}`,notesCommand],
  undo:[`git tag -d ${tag}`,publicBefore?`git update-ref refs/heads/${exported.branch} ${publicBefore.slice(0,12)}`:`git branch -D ${exported.branch}`,...(releaseCommit!==head?[`git reset --hard ${head.slice(0,12)}`]:[])]};
}

export function report(r){
 const lines=[];
 if(!r.tagged)return lines;
 lines.push(`${r.tag} is prepared locally. Nothing was pushed.`);
 if(r.releaseCommit&&r.releaseCommit!==r.commit)lines.push(`  release commit  ${r.releaseCommit.slice(0,7)} (this private history: never published)`,`  public commit   ${r.commit.slice(0,7)} (its export, on the orphan branch)`);
 lines.push(`  tag             ${r.tag} → ${r.commit.slice(0,7)} (${r.signed?'signed':'not signed'})`,'','Publishing is your step. In this order:');
 for(const command of r.publish)lines.push(`  ${command}`);
 if(r.undo.length){lines.push('','To undo it before anything is pushed:');for(const command of r.undo)lines.push(`  ${command}`);}
 return lines;
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),flag=name=>args.includes(name),value=name=>{const i=args.indexOf(name);return i>=0&&args[i+1]&&!args[i+1].startsWith('--')?args[i+1]:null;};
 const taking=['--baseline','--branch','--remote'],version=args.find((a,i)=>!a.startsWith('--')&&!taking.includes(args[i-1]));
 const known=['--notes','--dry-run','--sign','--unsigned',...taking],unknown=args.filter(a=>a.startsWith('--')&&!known.includes(a));
 if(!version||unknown.length||(flag('--baseline')&&!value('--baseline'))){
  console.error(`${unknown.length?`Unknown option: ${unknown.join(', ')}\n`:''}Usage: node scripts/release.mjs <version> [--dry-run] [--sign | --unsigned] [--branch main] [--remote github]\n       node scripts/release.mjs <version> --notes\n       node scripts/release.mjs <version> --baseline <commit>`);process.exit(2);}
 try{
  if(flag('--notes')){
   const notes=existsSync(path.join(repoRoot,'CHANGELOG.md'))?changelogSection(readFileSync(path.join(repoRoot,'CHANGELOG.md'),'utf8'),version):null;
   if(!notes){console.error(`CHANGELOG.md has no section "## ${version}".`);process.exit(1);}
   process.stdout.write(notes+'\n');
  }else{
   const done=release({version,baseline:value('--baseline'),dryRun:flag('--dry-run'),sign:flag('--sign'),unsigned:flag('--unsigned'),branch:value('--branch')||'main',remote:value('--remote'),log:console.log});
   for(const line of report(done))console.log(line);
  }
 }catch(e){console.error(e.refused?`Not released: ${e.message}`:e.stack||e.message);process.exit(1);}
}
