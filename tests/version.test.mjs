// The version (server/version.mjs, server/build-info.mjs → tagCommit): package.json is the source, a checkout
// on its release tag is that release, any other checkout is a development build, and a tree without git says
// the number as written. Then where it shows: the start-up line, run.json, the UI manifest, MCP.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,stat,rename} from 'node:fs/promises';
import {existsSync,readdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {readVersion,readPackage,versionLabel,validRepo,SEMVER} from '../server/version.mjs';
import {tagCommit,headCommit,readBuild} from '../server/build-info.mjs';
import {startupLine,writeRunFile,HUB_VERSION} from '../server/index.mjs';
import {hub} from './hub-helper.mjs';

const ENV={...process.env,GIT_AUTHOR_NAME:'Test',GIT_AUTHOR_EMAIL:'test@example.com',GIT_COMMITTER_NAME:'Test',GIT_COMMITTER_EMAIL:'test@example.com',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null'};
async function repo(t,version='1.2.0'){
 const root=await mkdtemp(path.join(os.tmpdir(),'hub-version-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',env:ENV,stdio:['ignore','pipe','pipe']}).trim();
 const pkg=v=>writeFile(path.join(root,'package.json'),JSON.stringify({name:'x',version:v,homeHub:{dataEpoch:3,updates:{repo:'example/home-hub'}}}));
 await pkg(version);
 const commit=async message=>{await writeFile(path.join(root,'file.txt'),message);git('add','-A');git('commit','-q','-m',message);return git('rev-parse','HEAD');};
 return {root,git,pkg,commit};
}

test('package.json is the source: version, data epoch and the release repository are validated',async t=>{
 const {root,pkg}=await repo(t);
 assert.deepEqual(readPackage(root),{version:'1.2.0',dataEpoch:3,updates:{repo:'example/home-hub'}});
 for(const bad of ['1.2','v1.2.0','1.2.0.1','01.2.0','latest','']){await pkg(bad);assert.throws(()=>readPackage(root),/semver/,bad);}
 for(const fine of ['0.0.1','1.3.0-rc.1','10.20.30'])assert.ok(SEMVER.test(fine),fine);
 await writeFile(path.join(root,'package.json'),JSON.stringify({version:'1.0.0'}));assert.deepEqual(readPackage(root),{version:'1.0.0',dataEpoch:1,updates:{repo:null}});
 await writeFile(path.join(root,'package.json'),JSON.stringify({version:'1.0.0',homeHub:{dataEpoch:0}}));assert.throws(()=>readPackage(root),/dataEpoch/);
 await writeFile(path.join(root,'package.json'),JSON.stringify({version:'1.0.0',homeHub:{updates:{repo:'https://example.com/x'}}}));assert.throws(()=>readPackage(root),/owner\/name/);
 for(const no of ['a','a/b/c','a/b.git','/b','a/','a b/c','-a/b','a/..'])assert.equal(validRepo(no),false,no);
 assert.equal(validRepo('alice/home_hub'),true);
 await writeFile(path.join(root,'package.json'),'{not json');assert.throws(()=>readPackage(root),/cannot read/);
});

test('exact or development: a checkout on the tag of its version is that release, anything else is +dev',async t=>{
 const {root,git,pkg,commit}=await repo(t);
 // no git at all: the number stands, and whether it is a release cannot be told
 let v=readVersion(root);
 assert.deepEqual({version:v.version,dataEpoch:v.dataEpoch,commit:v.commit,exact:v.exact,label:v.label},{version:'1.2.0',dataEpoch:3,commit:null,exact:null,label:'1.2.0'});
 assert.equal(v.updates.repo,'example/home-hub');assert.ok(Object.isFrozen(v));
 git('init','-q','-b','main');const first=await commit('one');
 v=readVersion(root);assert.equal(v.exact,false);assert.equal(v.commit,first.slice(0,7));assert.equal(v.label,`1.2.0+dev (${first.slice(0,7)})`);
 assert.equal(headCommit(root),first);assert.equal(tagCommit(root,'v1.2.0'),null,'no such tag');
 // a tag of another version does not make this one exact
 git('tag','v1.1.0');assert.equal(readVersion(root).exact,false);
 // a lightweight tag is the commit itself
 git('tag','v1.2.0');assert.equal(tagCommit(root,'v1.2.0'),first);assert.equal(readVersion(root).exact,true);assert.equal(readVersion(root).label,'1.2.0');
 // an annotated tag is an object that points at the commit: read from objects/, no git process
 git('tag','-d','v1.2.0');git('tag','-a','-m','Release','v1.2.0');
 const noGit={git:()=>{throw new Error('git must not be needed here');}};
 assert.notEqual(git('rev-parse','refs/tags/v1.2.0'),first,'the ref names the tag object');
 assert.equal(tagCommit(root,'v1.2.0',noGit),first);assert.equal(readVersion(root).exact,true);
 // packed refs carry the commit on the next line
 git('pack-refs','--all');assert.equal(existsSync(path.join(root,'.git','refs','tags','v1.2.0')),false);
 assert.equal(tagCommit(root,'v1.2.0',noGit),first);assert.equal(tagCommit(root,'v1.1.0',noGit),first);
 // a tag object that sits in a pack while its ref is loose (a fresh fetch): read from the pack, still no git
 git('tag','-d','v1.2.0');git('tag','-a','-m','Release again','v1.2.0');git('repack','-a','-d','-q');git('prune-packed');
 const tagObject=git('rev-parse','refs/tags/v1.2.0');
 assert.equal(existsSync(path.join(root,'.git','objects',tagObject.slice(0,2),tagObject.slice(2))),false,'the tag object is in a pack only');assert.ok(existsSync(path.join(root,'.git','refs','tags','v1.2.0')));
 assert.equal(tagCommit(root,'v1.2.0',noGit),first);assert.equal(readVersion(root).exact,true);
 // what the files cannot say (here: the pack's index is gone) is asked of git, once
 const packDir=path.join(root,'.git','objects','pack'),index=readdirSync(packDir).find(f=>f.endsWith('.idx'));
 await rename(path.join(packDir,index),path.join(packDir,index+'.away'));
 let asked=0;assert.equal(tagCommit(root,'v1.2.0',{git:(r,name)=>{asked++;assert.equal(name,'v1.2.0');return first;}}),first);assert.equal(asked,1);
 await rename(path.join(packDir,index+'.away'),path.join(packDir,index));
 assert.equal(tagCommit(root,'v1.2.0'),first);
 // one commit later it is a development build again; detached on the tag it is the release
 const second=await commit('two');
 v=readVersion(root);assert.equal(v.exact,false);assert.equal(v.label,`1.2.0+dev (${second.slice(0,7)})`);
 git('checkout','-q','--detach','v1.2.0');assert.equal(readVersion(root).exact,true);assert.equal(readBuild(root).commit,first.slice(0,7));
 // the bump without the tag (a release being prepared) is not yet that release
 await pkg('1.3.0');assert.equal(readVersion(root).label,`1.3.0+dev (${first.slice(0,7)})`);
 for(const odd of ['../x','v1 2','','-x'])assert.equal(tagCommit(root,odd),null);
 assert.equal(versionLabel({version:'2.0.0',exact:false,commit:null}),'2.0.0+dev');
});

test('the start-up line and run.json say what is answering',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'hub-run-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const version={version:'1.2.0',dataEpoch:3,commit:'abc1234',exact:true,label:'1.2.0'};
 assert.equal(startupLine({version,edition:'public',plugins:[],port:8781}),'Home Hub 1.2.0 (public edition, 0 plugin(s)) listening on 8781');
 assert.equal(startupLine({version:{...version,label:'1.2.0+dev (abc1234)'},edition:'private',plugins:[{id:'nas'},{id:'lfs'}],port:1}),'Home Hub 1.2.0+dev (abc1234) (private edition, 2 plugin(s): nas, lfs) listening on 1');
 const state=path.join(dir,'state');
 const doc=await writeRunFile(state,{version,plugins:[{id:'nas',title:'NAS'}],pid:4242,now:Date.parse('2026-11-12T10:00:00Z')});
 assert.deepEqual(doc,{version:'1.2.0',commit:'abc1234',exact:true,dataEpoch:3,pid:4242,startedAt:'2026-11-12T10:00:00.000Z',plugins:[{id:'nas'}]});
 assert.deepEqual(JSON.parse(await readFile(path.join(state,'run.json'),'utf8')),doc);
 assert.equal((await stat(path.join(state,'run.json'))).mode&0o777,0o600);
 await writeRunFile(state,{version:{...version,version:'1.2.1'},pid:4243});
 assert.equal(JSON.parse(await readFile(path.join(state,'run.json'),'utf8')).version,'1.2.1','the next start replaces it');
});

test('this checkout: the version is read, and nobody learns it without a sign-in',async t=>{
 assert.match(HUB_VERSION.version,SEMVER);assert.ok(HUB_VERSION.dataEpoch>=1);assert.ok([true,false,null].includes(HUB_VERSION.exact));
 const h=await hub(t,{version:{version:'9.8.7',dataEpoch:2,commit:'abc1234',exact:false,label:'9.8.7+dev (abc1234)',updates:{repo:null}}});
 assert.equal(h.handler.hub.version.version,'9.8.7');
 const anonymous=await (await fetch(h.origin+'/api/ui/manifest')).json();
 assert.equal(anonymous.signedIn,false);assert.ok(!('version' in anonymous)&&!('development' in anonymous));
 assert.deepEqual(await (await fetch(h.origin+'/healthz')).json(),{ok:true});
 const signed=await (await fetch(h.origin+'/api/ui/manifest',{headers:h.admin})).json();
 assert.equal(signed.version,'9.8.7');assert.equal(signed.development,true);
 const agent=await h.account('reader',[]);
 const rpc=(method,params)=>fetch(h.origin+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',...agent.headers},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})}).then(r=>r.json());
 assert.equal((await rpc('initialize',{protocolVersion:'2025-06-18'})).result.serverInfo.version,'9.8.7');
 const told=(await rpc('tools/call',{name:'hub_version',arguments:{}})).result.structuredContent;
 assert.deepEqual({version:told.version,label:told.label,commit:told.commit,exact:told.exact,dataEpoch:told.dataEpoch,plugins:told.plugins},{version:'9.8.7',label:'9.8.7+dev (abc1234)',commit:'abc1234',exact:false,dataEpoch:2,plugins:[]});
 assert.equal(told.updates.automatic,false);assert.equal(told.updates.code,'no-repo');
 const released=await hub(t,{version:{version:'9.8.7',dataEpoch:2,commit:'abc1234',exact:true,label:'9.8.7',updates:{repo:null}}});
 assert.equal((await (await fetch(released.origin+'/api/ui/manifest',{headers:released.admin})).json()).development,false);
});
