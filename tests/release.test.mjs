// scripts/release.mjs on throw-away repositories: it tags correctly, refuses every bad case, never pushes,
// and in a tree with private history puts the tag on the public export, never on a private commit.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {existsSync,readFileSync} from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// No global git configuration reaches these repositories (a signing key, a hooks path, an identity).
Object.assign(process.env,{GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null',GIT_AUTHOR_NAME:'Private Person',GIT_AUTHOR_EMAIL:'private.person@example.com',GIT_COMMITTER_NAME:'Private Person',GIT_COMMITTER_EMAIL:'private.person@example.com'});
delete process.env.PUBLIC_AUTHOR_NAME;delete process.env.PUBLIC_AUTHOR_EMAIL;
const {release,report,changelogSections,changelogSection,bumpKind,signingPlan,SIGNING_HELP,CHANGELOG_HEADINGS}=await import('../scripts/release.mjs');
const {readVersion,readPackage}=await import('../server/version.mjs');

const repoRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const CHANGELOG=`# Changelog\n\nNewest first.\n\n## 1.1.0\n\n### Added\n\n- The update check.\n\n### Data\n\n- Epoch 1 → 2.\n\n## 1.0.1 (2026-11-13)\n\n### Fixed\n\n- A typo.\n\n## Unreleased ideas\n\n- not a version\n\n## 1.0.0\n\nThe first release.\n`;
const PACKAGE=(version,epoch=1)=>`{"name":"x","version":"${version}","type":"module","homeHub":{"dataEpoch":${epoch},"updates":{"repo":"alice/home-hub"}}}\n`;
const owner=['sg','dovin'].join('');
async function repo(t,{privateTree=false}={}){
 const dir=await mkdtemp(path.join(os.tmpdir(),'hub-release-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const root=path.join(dir,'repo'),git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 const put=async(file,text)=>{await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),text);};
 const commit=async(message,files={})=>{for(const [file,text] of Object.entries(files))await put(file,text);git('add','-A');git('commit','-q','-m',message);return git('rev-parse','HEAD');};
 await mkdir(root,{recursive:true});git('init','-q','-b','main');
 const first=await commit('first',{'package.json':PACKAGE('1.0.0'),'CHANGELOG.md':CHANGELOG,'server/index.mjs':'export const ok=true;\n',
  ...(privateTree?{'edition.json':'{"edition":"private"}\n','local/site.json':'{"siteName":"Somewhere"}\n','README.md':'# Private notes\n'}:{})});
 const ran=[];
 const suites={tests:dir=>{ran.push(['tests',dir,JSON.parse(readFileSync(path.join(dir,'package.json'),'utf8')).version,existsSync(path.join(dir,'local'))]);return true;},python:dir=>{ran.push(['python',dir]);return true;}};
 const go=(options={})=>release({root,suites,log:()=>{},...options});
 return {dir,root,git,put,commit,first,ran,suites,go};
}
const refused=(fn,pattern)=>assert.throws(fn,e=>e.refused===true&&pattern.test(e.message),String(pattern));
const tagger=(git,tag)=>git('for-each-ref','--format=%(taggername) %(taggeremail)',`refs/tags/${tag}`);

test('the changelog: one section per version, and its text is the body of the release',()=>{
 assert.deepEqual(changelogSections(CHANGELOG).map(s=>s.version),['1.1.0','1.0.1','1.0.0']);
 assert.equal(changelogSection(CHANGELOG,'1.0.1'),'### Fixed\n\n- A typo.','a date after the number is fine; the next "## " ends the section');
 assert.equal(changelogSection(CHANGELOG,'1.0.0'),'The first release.');assert.equal(changelogSection(CHANGELOG,'2.0.0'),null);
 assert.equal(changelogSection('## v1.2.0-rc.1\n\ntext\n','1.2.0-rc.1'),'text');
 assert.deepEqual([bumpKind(null,'1.0.0'),bumpKind('1.0.0','2.0.0'),bumpKind('1.0.0','1.1.0'),bumpKind('1.1.0','1.1.1'),bumpKind('1.1.1-rc.1','1.1.1')],['major','major','minor','patch','prerelease']);
 // this repository's own file: a section for the version in package.json, known parts only, newest first
 const own=readFileSync(path.join(repoRoot,'CHANGELOG.md'),'utf8'),sections=changelogSections(own),version=readPackage(repoRoot).version;
 assert.ok(sections.some(s=>s.version===version),`CHANGELOG.md needs a section for ${version}`);
 assert.deepEqual(sections.map(s=>s.version),[...sections.map(s=>s.version)].sort((a,b)=>-a.localeCompare(b,'en',{numeric:true})),'newest first');
 for(const heading of own.match(/^### .*$/gm)||[])assert.ok(CHANGELOG_HEADINGS.includes(heading.slice(4)),heading);
 assert.ok(!own.includes(['sla','ader'].join('')));
});

test('a public tree: the baseline tags what is already out, a release bumps, commits and tags; nothing is pushed',async t=>{
 const {root,git,go,first,ran,commit}=await repo(t);
 git('remote','add','origin','/nonexistent/never-used.git');
 // the first release names an existing commit: no bump, no commit
 const base=go({version:'1.0.0',baseline:first.slice(0,10)});
 assert.deepEqual({tag:base.tag,commit:base.commit,tagged:base.tagged,signed:base.signed,mode:base.mode},{tag:'v1.0.0',commit:first,tagged:true,signed:false,mode:'public'});
 assert.equal(git('rev-parse','v1.0.0^{commit}'),first);assert.equal(git('cat-file','-t','v1.0.0'),'tag','an annotated tag');assert.equal(git('rev-parse','HEAD'),first);
 assert.equal(tagger(git,'v1.0.0'),'Home Hub release <release@home-hub.invalid>','a neutral tagger, not the person\'s identity');
 assert.deepEqual(base.publish,['git push origin refs/tags/v1.0.0','node scripts/release.mjs 1.0.0 --notes | gh release create v1.0.0 --repo alice/home-hub --title v1.0.0 --notes-file - --verify-tag']);
 assert.equal(base.notes,'The first release.');assert.deepEqual(base.undo,['git tag -d v1.0.0']);assert.equal(ran.length,0,'a baseline runs no suite: nothing new ships');
 assert.equal(readVersion(root).exact,true,'the hub then knows it runs that release');
 // work, then a patch
 await commit('a fix',{'server/index.mjs':'export const ok=true;// fixed\n'});assert.equal(readVersion(root).exact,false);
 const dry=go({version:'1.0.1',dryRun:true});assert.equal(dry.tagged,false);assert.equal(git('status','--porcelain'),'');assert.deepEqual(git('tag','--list').split('\n'),['v1.0.0']);assert.equal(ran.length,0);
 const before=git('rev-parse','HEAD');
 const done=go({version:'1.0.1'});
 assert.equal(git('log','-1','--format=%s'),'Release v1.0.1');assert.equal(git('rev-parse','HEAD~1'),before);assert.equal(git('status','--porcelain'),'');
 assert.equal(readFileSync(path.join(root,'package.json'),'utf8'),PACKAGE('1.0.1'),'only the version changed');
 assert.equal(git('rev-parse','v1.0.1^{commit}'),git('rev-parse','HEAD'));assert.equal(done.commit,git('rev-parse','HEAD'));
 assert.deepEqual(ran.map(r=>r.slice(0,3)),[['tests',root,'1.0.1'],['python',root]],'the suites ran on the bumped tree');
 assert.deepEqual(done.publish,['git push origin main refs/tags/v1.0.1','node scripts/release.mjs 1.0.1 --notes | gh release create v1.0.1 --repo alice/home-hub --title v1.0.1 --notes-file - --verify-tag']);
 assert.deepEqual(done.undo,['git tag -d v1.0.1',`git reset --hard ${before.slice(0,12)}`]);
 const lines=report(done).join('\n');assert.match(lines,/v1\.0\.1 is prepared locally\. Nothing was pushed\./);assert.match(lines,/not signed/);assert.match(lines,/Publishing is your step/);
 assert.equal(readVersion(root).exact,true);assert.equal(readVersion(root).version,'1.0.1');
 assert.equal(git('for-each-ref','refs/remotes').trim(),'','nothing was pushed or fetched');
 // a minor with a format change, said under "### Data"
 await commit('a format',{'package.json':PACKAGE('1.0.1',2)});
 assert.equal(go({version:'1.1.0',remote:'github'}).publish[0],'git push github main refs/tags/v1.1.0');
 assert.equal(JSON.parse(readFileSync(path.join(root,'package.json'),'utf8')).homeHub.dataEpoch,2);
});

test('it refuses: bad versions, a dirty tree, another branch, no changelog, the epoch rules, a leak, failing tests',async t=>{
 const {root,git,go,first,ran,commit,put,suites}=await repo(t);
 for(const bad of ['v1.0.1','1.0','latest','1.0.1.2','',undefined,'01.0.0'])refused(()=>go({version:bad}),/is not a version/);
 refused(()=>go({version:'1.0.2'}),/no section "## 1\.0\.2"/);
 refused(()=>go({version:'1.0.0',baseline:'nope'}),/is not a commit/);
 refused(()=>go({version:'1.0.1',baseline:first}),/says version "1\.0\.0", not 1\.0\.1/);
 refused(()=>go({version:'1.0.1',sign:true}),/needs a signing key/);refused(()=>go({version:'1.0.1',sign:true,unsigned:true}),/not both/);
 go({version:'1.0.0',baseline:first});
 refused(()=>go({version:'1.0.0'}),/already exists/);refused(()=>go({version:'1.0.0',baseline:first}),/already exists/);
 // the tree
 await put('scratch.txt','x');refused(()=>go({version:'1.0.1'}),/not clean:\n\?\? scratch\.txt/);await rm(path.join(root,'scratch.txt'));
 git('checkout','-q','-b','feature');refused(()=>go({version:'1.0.1'}),/cut from main; this checkout is on feature/);
 assert.equal(go({version:'1.0.1',branch:'feature',dryRun:true}).tagged,false);
 git('checkout','-q','--detach');refused(()=>go({version:'1.0.1'}),/detached HEAD/);git('checkout','-q','main');
 // failing suites put package.json back and leave no commit and no tag
 const head=git('rev-parse','HEAD');
 refused(()=>go({version:'1.0.1',suites:{...suites,tests:()=>false}}),/npm test failed/);
 refused(()=>go({version:'1.0.1',suites:{...suites,python:()=>false}}),/python suite failed/);
 assert.throws(()=>go({version:'1.0.1',suites:{tests:()=>{throw new Error('boom');},python:()=>true}}),/boom/);
 assert.equal(readFileSync(path.join(root,'package.json'),'utf8'),PACKAGE('1.0.0'));assert.equal(git('rev-parse','HEAD'),head);assert.equal(git('status','--porcelain'),'');assert.deepEqual(git('tag','--list').split('\n'),['v1.0.0']);
 // the data epoch
 await commit('epoch',{'package.json':PACKAGE('1.0.0',2)});
 refused(()=>go({version:'1.0.1'}),/data epoch changed \(1 → 2\) and 1\.0\.1 is a PATCH/);
 assert.equal(go({version:'1.1.0',dryRun:true}).tagged,false,'a MINOR may change it, when "### Data" says so');
 await commit('no data part',{'CHANGELOG.md':CHANGELOG.replace('### Data\n\n- Epoch 1 → 2.\n\n','')});
 refused(()=>go({version:'1.1.0'}),/needs a "### Data" part/);
 await commit('epoch back',{'package.json':PACKAGE('1.0.0',1),'CHANGELOG.md':CHANGELOG});
 go({version:'1.1.0'});
 refused(()=>go({version:'1.0.1'}),/1\.0\.1 is not greater than the last release \(1\.1\.0\)/);
 refused(()=>go({version:'1.0.1',baseline:first}),/says version/);
 await commit('2.0 notes',{'CHANGELOG.md':'## 2.0.0\n\nBig.\n\n## 0.9.0\n\nOld.\n\n'+CHANGELOG,'package.json':PACKAGE('1.1.0',1)});
 // a household detail in a file that would be published
 await commit('a leak',{'docs/notes.md':`ssh ${owner}@host\n`});
 refused(()=>go({version:'2.0.0'}),/leak scan found 1 household detail/);
 git('rm','-q','docs/notes.md');git('commit','-q','-m','no leak');
 assert.equal(go({version:'2.0.0',dryRun:true}).tagged,false);
 assert.ok(ran.every(r=>r[0]!=='tests'||r[2]!=='2.0.0'),'a dry run runs no suite');
 // outside a repository
 const bare=await mkdtemp(path.join(os.tmpdir(),'hub-release-bare-'));t.after(()=>rm(bare,{recursive:true,force:true}));
 await writeFile(path.join(bare,'package.json'),PACKAGE('1.0.0'));await writeFile(path.join(bare,'CHANGELOG.md'),CHANGELOG);
 refused(()=>release({root:bare,version:'1.0.1',suites,log:()=>{}}),/not a git checkout/);
});

test('a tree with private history: the tag goes on the public export, never on a private commit',async t=>{
 const {root,git,go,first,ran,commit,dir}=await repo(t,{privateTree:true});
 // a private commit cannot be the baseline
 refused(()=>go({version:'1.0.0',baseline:first}),/shares history with this private branch/);
 const done=go({version:'1.1.0'});
 assert.equal(done.mode,'private');
 const main=git('rev-parse','main'),pub=git('rev-parse','refs/heads/public');
 assert.equal(git('log','-1','--format=%s','main'),'Release v1.1.0');assert.equal(done.releaseCommit,main);
 assert.equal(git('rev-parse','v1.1.0^{commit}'),pub);assert.notEqual(pub,main);assert.equal(done.commit,pub);
 assert.equal(spawnSync('git',['-C',root,'merge-base',pub,main]).status,1,'the tagged commit shares no history with the private branch');
 assert.equal(git('show','v1.1.0:package.json'),PACKAGE('1.1.0').trim(),'the export carries the bumped version');
 assert.deepEqual(git('ls-tree','-r','--name-only','v1.1.0').split('\n').filter(f=>f.startsWith('local/')),[]);
 assert.equal(git('show','v1.1.0:edition.json'),'{"edition":"public"}');
 assert.equal(git('log','-1','--format=%an <%ae>',pub),'Home Hub export <export@home-hub.invalid>');assert.equal(tagger(git,'v1.1.0'),'Home Hub release <release@home-hub.invalid>');
 // the suites ran on the exported tree: outside the repository, bumped, without the overlay
 const tests=ran.find(r=>r[0]==='tests');assert.ok(!tests[1].startsWith(root));assert.deepEqual(tests.slice(2),['1.1.0',false]);assert.equal(existsSync(tests[1]),false,'and the scratch tree is gone');
 assert.deepEqual(done.publish,['git push origin main','git push origin refs/heads/public:refs/heads/main refs/tags/v1.1.0','node scripts/release.mjs 1.1.0 --notes | gh release create v1.1.0 --repo alice/home-hub --title v1.1.0 --notes-file - --verify-tag']);
 assert.deepEqual(done.undo,['git tag -d v1.1.0','git branch -D public',`git reset --hard ${first.slice(0,12)}`]);
 assert.match(report(done).join('\n'),/this private history: never published/);
 // a commit of the public line can be a baseline; with a remote named github the commands use it
 git('remote','add','github','/nonexistent/never-used.git');git('tag','-d','v1.1.0');
 const base=go({version:'1.1.0',baseline:pub});assert.equal(git('rev-parse','v1.1.0^{commit}'),pub);assert.equal(base.publish[0],'git push github refs/tags/v1.1.0');
 // an edit made on the web (the remote's main is ahead of the local export) must be brought in first
 const web=execFileSync('git',['-C',root,'commit-tree',git('rev-parse',`${pub}^{tree}`),'-p',pub,'-m','web edit'],{encoding:'utf8'}).trim();
 git('update-ref','refs/remotes/github/main',web);
 await commit('more work',{'CHANGELOG.md':'## 1.2.0\n\nMore.\n\n'+CHANGELOG});
 refused(()=>go({version:'1.2.0'}),/github\/main \([0-9a-f]{7}\) has a commit the local branch "public"/);
 git('update-ref','refs/heads/public',web,pub);
 const next=go({version:'1.2.0'});
 assert.equal(git('rev-parse','v1.2.0^{commit}~1'),web,'the next export sits on top of what the public repository has');
 assert.deepEqual(next.undo.slice(0,2),['git tag -d v1.2.0',`git update-ref refs/heads/public ${web.slice(0,12)}`]);
 assert.equal(dir.length>0,true);
});

test('signing: a configured SSH key signs the tag; without one the tag is unsigned and the script says so',async t=>{
 assert.deepEqual(signingPlan({key:null}),{signed:false,warn:true});assert.deepEqual(signingPlan({key:null,unsigned:true}),{signed:false,warn:false});
 assert.deepEqual(signingPlan({key:'~/.ssh/k.pub'}),{signed:true,warn:false});assert.deepEqual(signingPlan({key:'~/.ssh/k.pub',unsigned:true}),{signed:false,warn:false});
 assert.match(SIGNING_HELP,/gpg\.format ssh/);assert.match(SIGNING_HELP,/config\/release-signers/);assert.match(SIGNING_HELP,/verify-tag/);
 const {root,git,go,first,dir}=await repo(t);
 const said=[];
 go({version:'1.0.0',baseline:first,log:m=>said.push(m)});
 assert.match(said.join('\n'),/WARNING: v1\.0\.0 is NOT signed/);assert.match(said.join('\n'),/ssh-keygen -t ed25519/);
 assert.ok(!git('cat-file','tag','v1.0.0').includes('SIGNATURE'));
 const quiet=[];git('tag','-d','v1.0.0');go({version:'1.0.0',baseline:first,unsigned:true,log:m=>quiet.push(m)});assert.equal(quiet.join('\n').includes('WARNING'),false);
 // with a key (skipped where ssh-keygen or SSH signing is not available)
 const key=path.join(dir,'release-key');
 if(spawnSync('ssh-keygen',['-q','-t','ed25519','-N','','-C','test','-f',key],{stdio:'ignore'}).status!==0)return t.diagnostic('ssh-keygen is not available: the signed case was not run');
 git('config','gpg.format','ssh');git('config','user.signingkey',`${key}.pub`);
 let done;try{done=go({version:'1.0.1',sign:true});}catch(e){if(/tagging failed/.test(e.message))return t.diagnostic(`this git cannot sign with SSH: ${e.message.split('\n')[0]}`);throw e;}
 assert.equal(done.signed,true);assert.match(git('cat-file','tag','v1.0.1'),/-----BEGIN SSH SIGNATURE-----/);assert.match(report(done).join('\n'),/\(signed\)/);
 await writeFile(path.join(dir,'signers'),`release ${(await readFile(`${key}.pub`,'utf8')).trim()}\n`);
 assert.equal(spawnSync('git',['-C',root,'-c',`gpg.ssh.allowedSignersFile=${path.join(dir,'signers')}`,'verify-tag','v1.0.1'],{stdio:'ignore'}).status,0,'the tag verifies against the committed signers file');
 assert.equal(tagger(git,'v1.0.1'),'Home Hub release <release@home-hub.invalid>');
});
