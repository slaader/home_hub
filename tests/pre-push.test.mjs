// scripts/hooks/pre-push (→ scripts/pre-push.mjs) on throw-away repositories pushing to a bare remote: a planted
// household value is refused in a file, in a file an earlier commit brought, in a commit message, in an author's
// or committer's identity, in a tag message, in a tagger and in a ref name; a clean push passes; and only what the
// remote does not have yet is read.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,readFile} from 'node:fs/promises';
import {statSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseUpdates,parseObject,refusal,NEUTRAL_IDENTITY} from '../scripts/pre-push.mjs';
import {scanText} from '../scripts/leak-scan.mjs';

const repoRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const hooks=path.join(repoRoot,'scripts','hooks');
// Built from pieces so this file passes the scan it tests.
const owner=['sg','dovin'].join(''),subnet=['192','168','50'].join('.'),site=['Sla','ader'].join('');
const mail=['first.last','mail.somewhere.org'].join('@'),domain=['home.',owner,'.xyz'].join('');

// No configuration of this machine and no git state of a caller (git exports GIT_DIR into its hooks).
const ENV=(()=>{
 const env={...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null',GIT_TERMINAL_PROMPT:'0',
  GIT_AUTHOR_NAME:NEUTRAL_IDENTITY.name,GIT_AUTHOR_EMAIL:NEUTRAL_IDENTITY.email,GIT_COMMITTER_NAME:NEUTRAL_IDENTITY.name,GIT_COMMITTER_EMAIL:NEUTRAL_IDENTITY.email,
  PATH:`${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH||''}`};
 for(const key of Object.keys(env))if(/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|PREFIX)$/.test(key))delete env[key];
 return env;
})();

async function repos(t){
 const dir=await mkdtemp(path.join(os.tmpdir(),'hub-pre-push-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const remote=path.join(dir,'remote.git'),work=path.join(dir,'work');
 const run=(cwd,args,env={},input)=>spawnSync('git',args,{cwd,env:{...ENV,...env},encoding:'utf8',input});
 const ok=(cwd,args,env)=>{const r=run(cwd,args,env);if(r.status!==0)throw new Error(`git ${args.join(' ')}: ${r.stderr}`);return r.stdout.trim();};
 const git=(...args)=>ok(work,args);
 await mkdir(work);ok(dir,['init','-q','--bare',remote]);
 git('init','-q','-b','main');git('config','core.hooksPath',hooks);git('remote','add','origin',remote);
 const commit=async(message,files={},env={})=>{
  for(const [file,content] of Object.entries(files)){
   const full=path.join(work,file);
   if(content===null){git('rm','-q',file);continue;}
   await mkdir(path.dirname(full),{recursive:true});await writeFile(full,content);
  }
  git('add','-A');ok(work,['commit','-q','--allow-empty','-m',message],env);return git('rev-parse','HEAD');
 };
 const push=(...args)=>run(work,['push',...args]);
 const remoteRef=ref=>run(remote,['rev-parse','-q','--verify',ref]).stdout.trim()||null;
 return {dir,remote,work,run,git,commit,push,remoteRef};
}
const short=sha=>sha.slice(0,7);
const refused=(r,...expected)=>{
 assert.notEqual(r.status,0,`the push should have been refused:\n${r.stderr}`);
 assert.match(r.stderr,/pre-push: refused\. This push would publish household details/);
 for(const text of expected)assert.ok(r.stderr.includes(text),`"${text}" in:\n${r.stderr}`);
};
const passed=r=>{assert.equal(r.status,0,r.stderr);assert.match(r.stderr,/pre-push: leak scan clean/);};

test('the hook is a small executable shim that runs scripts/pre-push.mjs',async()=>{
 const file=path.join(hooks,'pre-push');
 assert.ok(statSync(file).mode&0o100,'executable, or git ignores it and the push goes through unchecked');
 const text=await readFile(file,'utf8');
 assert.match(text,/^#!\/bin\/sh\n/);assert.match(text,/exec node "\$\(dirname "\$0"\)\/\.\.\/pre-push\.mjs" "\$@"/);
 assert.match(text,/git config core\.hooksPath scripts\/hooks/,'it says how to enable it');
});

test('a clean push passes: a branch, an annotated tag, a deletion',async t=>{
 const {git,commit,push,remoteRef}=await repos(t);
 const first=await commit('Add notes',{'docs/notes.md':'ssh alice@hub.example.lan, 10.0.0.25\n','public/logo.png':Buffer.from([0x89,0x50,0x4e,0x47,0,1,2])});
 passed(push('-q','origin','main'));
 assert.equal(remoteRef('refs/heads/main'),first);
 git('tag','-a','v1.0.0','-m','Home Hub 1.0.0');
 const tagged=push('-q','origin','v1.0.0');passed(tagged);assert.match(tagged.stderr,/1 tag\(s\)/);
 assert.equal(remoteRef('refs/tags/v1.0.0^{commit}'),first);
 git('branch','topic');passed(push('-q','origin','topic'));
 const gone=push('-q','origin','--delete','topic');assert.equal(gone.status,0,gone.stderr);assert.equal(remoteRef('refs/heads/topic'),null);
});

test('a household value in a file is refused, and nothing is pushed',async t=>{
 const {commit,push,remoteRef}=await repos(t);
 const base=await commit('Base',{'README.md':'# Hub\n'});passed(push('-q','origin','main'));
 const bad=await commit('Add notes',{'docs/notes.md':`intro\nssh ${owner}@host\n`,'public/shot.png':Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0]),Buffer.from(`tEXt at ${subnet}.25`)])});
 refused(push('origin','main'),`refs/heads/main ${short(bad)} docs/notes.md:2`,'owner-name',`refs/heads/main ${short(bad)} public/shot.png`,'home-subnet');
 assert.equal(remoteRef('refs/heads/main'),base,'the remote did not move');
});

test('a value a later commit takes out again is still refused, naming the commit that brought it',async t=>{
 const {commit,push,remoteRef}=await repos(t);
 const base=await commit('Base',{'README.md':'# Hub\n'});passed(push('-q','origin','main'));
 const brought=await commit('Add a note',{'docs/old.md':`the NAS is at ${subnet}.10\n`});
 await commit('Take the note out',{'docs/old.md':null});
 refused(push('origin','main'),`commit ${short(brought)} docs/old.md:1`,'home-subnet');
 assert.equal(remoteRef('refs/heads/main'),base);
});

test('a household value in a commit message is refused',async t=>{
 const {commit,push,remoteRef}=await repos(t);
 const base=await commit('Base',{'README.md':'# Hub\n'});passed(push('-q','origin','main'));
 const bad=await commit(`Fix the proxy\n\nIt answers at https://nas.${domain} now.`);
 refused(push('origin','main'),`commit ${short(bad)} message, line 3`,'home-domain');
 assert.equal(remoteRef('refs/heads/main'),base);
});

test('a household identity is refused: an author e-mail, a committer name',async t=>{
 const {git,commit,push,remoteRef}=await repos(t);
 const base=await commit('Base',{'README.md':'# Hub\n'});passed(push('-q','origin','main'));
 const byMail=await commit('A change',{'a.md':'a\n'},{GIT_AUTHOR_EMAIL:mail});
 refused(push('origin','main'),`commit ${short(byMail)} author`,'email',mail);
 git('reset','-q','--hard',base);
 const byName=await commit('Another change',{'b.md':'b\n'},{GIT_COMMITTER_NAME:`${site} admin`});
 refused(push('origin','main'),`commit ${short(byName)} committer`,'site-name');
 assert.equal(remoteRef('refs/heads/main'),base);
});

test('a household value in a tag message or a tagger is refused; a ref name too',async t=>{
 const {run,work,git,commit,push,remoteRef}=await repos(t);
 await commit('Base',{'README.md':'# Hub\n'});passed(push('-q','origin','main'));
 git('tag','-a','v1.0.0','-m',`Home Hub 1.0.0\n\nThe release for ${owner}.`);
 refused(push('origin','v1.0.0'),'tag v1.0.0 message, line 3','owner-name');
 assert.equal(run(work,['tag','-a','v1.0.1','-m','Home Hub 1.0.1'],{GIT_COMMITTER_EMAIL:mail}).status,0);
 refused(push('origin','v1.0.1'),'tag v1.0.1 tagger','email');
 assert.equal(remoteRef('refs/tags/v1.0.0'),null);assert.equal(remoteRef('refs/tags/v1.0.1'),null);
 git('branch',`notes-${owner}`);
 refused(push('origin',`notes-${owner}`),`ref refs/heads/notes-${owner}`,'owner-name');
});

test('only what the remote does not have is read: published history passes, an empty mirror checks it all',async t=>{
 const {dir,git,commit,push,remoteRef,run}=await repos(t);
 // History the remote already has (a web edit made under someone's own name), put there without the hook.
 await commit('Base',{'README.md':'# Hub\n'});
 const old=await commit('Edit the README',{'README.md':'# Hub\n\nMore.\n'},{GIT_AUTHOR_NAME:site,GIT_AUTHOR_EMAIL:mail});
 assert.equal(push('-q','--no-verify','origin','main').status,0);
 git('fetch','-q','origin');
 const next=await commit('A clean change',{'docs/a.md':'a\n'});
 const r=push('-q','origin','main');passed(r);assert.match(r.stderr,/1 new commit\(s\)/);
 assert.equal(remoteRef('refs/heads/main'),next);
 // A second remote has none of it, so all of it is new there.
 const mirror=path.join(dir,'mirror.git');assert.equal(run(dir,['init','-q','--bare',mirror]).status,0);
 git('remote','add','mirror',mirror);
 refused(push('mirror','main'),`commit ${short(old)} author`);
});

test('it refuses when it cannot check',async t=>{
 const {work}=await repos(t);
 const r=spawnSync(process.execPath,[path.join(repoRoot,'scripts','pre-push.mjs'),'origin','x'],{cwd:work,env:ENV,encoding:'utf8',input:'not a ref line\n'});
 assert.equal(r.status,1);assert.match(r.stderr,/pre-push: refused, because the leak scan could not check this push/);
 const missing=spawnSync(process.execPath,[path.join(repoRoot,'scripts','pre-push.mjs'),'origin','x'],{cwd:work,env:ENV,encoding:'utf8',input:`refs/heads/main ${'1'.repeat(40)} refs/heads/main ${'0'.repeat(40)}\n`});
 assert.equal(missing.status,1,'an object it cannot read');assert.match(missing.stderr,/could not check/);
});

test('the pieces: ref lines, objects, the refusal, the identities this repository publishes under',()=>{
 const a='a'.repeat(40),z='0'.repeat(40);
 assert.deepEqual(parseUpdates(`refs/heads/main ${a} refs/heads/main ${z}\n(delete) ${z} refs/heads/old ${a}\n\n`),[
  {localRef:'refs/heads/main',localSha:a,remoteRef:'refs/heads/main',remoteSha:z},{localRef:'(delete)',localSha:z,remoteRef:'refs/heads/old',remoteSha:a}]);
 assert.deepEqual(parseUpdates(''),[]);
 assert.throws(()=>parseUpdates('refs/heads/main xyz refs/heads/main 000'),/cannot read the ref line/);
 const {fields,message}=parseObject(`tree ${a}\nauthor A <a@example.com> 1794530908 +0100\ngpgsig -----BEGIN SSH SIGNATURE-----\n abc\n -----END SSH SIGNATURE-----\n\nSubject\n\nBody\n`);
 assert.deepEqual(fields.map(f=>f.key),['tree','author','gpgsig']);assert.equal(fields[2].value.split('\n').length,3);assert.equal(message,'Subject\n\nBody\n');
 const many=Array.from({length:45},(_,i)=>({where:`commit ${i}`,rule:'email',match:'x'}));
 assert.match(refusal(many),/… and 5 more/);assert.match(refusal(many),new RegExp(`git config user.email ${NEUTRAL_IDENTITY.email.replace(/\./g,'\\.')}`));
 for(const who of [`${NEUTRAL_IDENTITY.name} <${NEUTRAL_IDENTITY.email}>`,'Home Hub release <release@home-hub.invalid>','Home Hub export <export@home-hub.invalid>'])assert.deepEqual(scanText('',who),[],who);
});
