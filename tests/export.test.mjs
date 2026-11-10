// The public export (scripts/export-public.mjs) and the orphan branch it is committed to
// (scripts/publish-public-branch.mjs), exercised on a throw-away repository.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {exportPublic,publicReadme,readmeFromSource,PUBLIC_README_MARK} from '../scripts/export-public.mjs';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {publishPublicBranch} from '../scripts/publish-public-branch.mjs';
import {scanText} from '../scripts/leak-scan.mjs';

const owner=['sg','dovin'].join('');
async function repo(t){
 const dir=await mkdtemp(path.join(os.tmpdir(),'hub-export-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const root=path.join(dir,'repo'),git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 const put=async(file,text)=>{await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),text);};
 await mkdir(root,{recursive:true});git('init','-q','-b','main');git('config','user.name','Private Person');git('config','user.email','private.person@example.com');
 for(const [file,text] of [['server/index.mjs','export const ok=true;\n'],['public/app.js','// app\n'],['docs/API.md','# API\nhttps://hub.example.lan\n'],['README.md','# Private notes about one household\n'],
  ['edition.json','{"edition":"private"}\n'],['local/site.json','{"siteName":"Somewhere"}\n'],['local/plugins/x/index.mjs','export default {id:"x"};\n'],['deploy/Caddyfile','hub\n'],['private/auth.json','{}\n'],['data/knowledge.json','{}\n']])await put(file,text);
 git('add','-A');git('commit','-q','-m','private work');
 return {dir,root,git,put};
}

test('export: core files only, edition public, a README of its own; refuses on a household detail',async t=>{
 const {dir,root,git,put}=await repo(t),out=path.join(dir,'out');
 const r=exportPublic(out,{root});
 assert.deepEqual((await readdir(out)).sort(),['.gitignore','README.md','docs','edition.json','public','server']);
 assert.equal(await readFile(path.join(out,'edition.json'),'utf8'),'{"edition":"public"}\n');
 assert.match(await readFile(path.join(out,'README.md'),'utf8'),/^# Home Hub\n/);assert.doesNotMatch(await readFile(path.join(out,'README.md'),'utf8'),/Private notes/);
 for(const gone of ['local','deploy','private','data'])assert.equal(existsSync(path.join(out,gone)),false,gone);
 assert.equal(r.files,6,'three copied files and the three the export writes');
 assert.throws(()=>exportPublic(out,{root}),/not empty/);assert.throws(()=>exportPublic(path.join(root,'out'),{root}),/outside the repository/);
 await put('server/note.mjs',`// ask ${owner} about this\n`);git('add','-A');git('commit','-q','-m','a leak');
 const out2=path.join(dir,'out2');
 assert.throws(()=>exportPublic(out2,{root}),e=>/Refusing to export: 1 household detail/.test(e.message)&&e.findings[0].file==='server/note.mjs'&&e.findings[0].rule==='owner-name');
 assert.equal(existsSync(out2),false,'a refused export writes nothing');
 assert.deepEqual(scanText('README.md',publicReadme({commit:'abc1234'})),[],'the generated README passes the same scan');
});

test('export README: the repository README without its private sections, scanned like every other file',async t=>{
 const {dir,root,git,put}=await repo(t);
 const readme=secret=>`# Home Hub\n${PUBLIC_README_MARK}\n\nWhat it is.\n\n<!-- private:begin -->\n## Our deployment\nRuns on the studio, ask ${owner}.\n<!-- private:end -->\n\n## Appended later\nA module section${secret}.\n`;
 await put('README.md',readme(''));git('add','-A');git('commit','-q','-m','a public README');
 const out=path.join(dir,'out');exportPublic(out,{root});
 const written=await readFile(path.join(out,'README.md'),'utf8');
 assert.equal(written,`# Home Hub\n${PUBLIC_README_MARK}\n\nWhat it is.\n\n## Appended later\nA module section.\n`,'public text before and after the private block, nothing from inside it');
 assert.doesNotMatch(written,/Our deployment|studio|private:|commit/,'no private section, no marker of one, no word about the private repository');
 // A household detail outside the markers refuses the export instead of slipping through.
 await put('README.md',readme(`, see ${owner}`));git('add','-A');git('commit','-q','-m','a leak in the public part');
 assert.throws(()=>exportPublic(path.join(dir,'out2'),{root}),e=>/Refusing to export/.test(e.message)&&e.findings.some(f=>f.file==='README.md'&&f.rule==='owner-name'));
 // An unclosed private block is an error, and a README that does not declare itself public is not used.
 assert.throws(()=>readmeFromSource(`${PUBLIC_README_MARK}\n<!-- private:begin -->\nsecret`),/not closed/);
 assert.equal(readmeFromSource('# Notes about one household\n'),null);
 assert.match(publicReadme({source:'# Notes about one household\n'}),/^# Home Hub\n/);
});

test('this repository: the README is public apart from its marked private section',()=>{
 const file=fileURLToPath(new URL('../README.md',import.meta.url)),source=readFileSync(file,'utf8');
 const readme=publicReadme({source});
 assert.match(readme,/^# Home Hub\n/);assert.doesNotMatch(readme,/private:begin|private:end/);
 assert.deepEqual(scanText('README.md',readme),[],'no household detail in the public part of README.md');
 for(const must of ['## Quick start','node scripts/setup.mjs','## Connect your agent','/mcp','## Security model','API keys never reach administration','## What works out of the box','docs/getting-started.md','docs/design.md'])assert.ok(readme.includes(must),must);
});

test('publish: an orphan branch, one commit per export, a neutral author, the working tree untouched, nothing pushed',async t=>{
 const {root,git,put}=await repo(t);
 const REF='refs/heads/public';// "public" is also a directory here, so name the branch in full
 const head=git('rev-parse','HEAD'),status=git('status','--porcelain');
 const first=publishPublicBranch({root});
 assert.equal(first.changed,true);assert.equal(git('rev-parse',REF),first.commit);
 assert.equal(git('rev-list','--count',REF),'1');assert.equal(git('rev-list','--max-parents=0',REF),first.commit,'the first export has no parent');
 assert.throws(()=>git('merge-base',REF,'main'),'no common ancestor with main');
 assert.equal(git('log','-1','--format=%an <%ae> | %cn <%ce>',REF),'Home Hub export <export@home-hub.invalid> | Home Hub export <export@home-hub.invalid>','not the private git identity');
 assert.deepEqual(git('ls-tree','-r','--name-only',REF).split('\n'),['.gitignore','README.md','docs/API.md','edition.json','public/app.js','server/index.mjs']);
 assert.equal(git('show',REF+':edition.json'),'{"edition":"public"}');
 assert.equal(git('rev-parse','HEAD'),head);assert.equal(git('status','--porcelain'),status);assert.equal(git('branch','--show-current'),'main');
 assert.equal(git('remote'),'','no remote was added and nothing was pushed');
 assert.equal(publishPublicBranch({root}).changed,false,'an identical export adds no commit');assert.equal(git('rev-list','--count',REF),'1');
 await put('server/more.mjs','export const more=1;\n');git('add','-A');git('commit','-q','-m','more private work');
 const second=publishPublicBranch({root});
 assert.equal(git('rev-list','--count',REF),'2');assert.equal(git('rev-parse',REF+'^'),first.commit,'the next export sits on the previous one');
 assert.equal(git('log','--format=%s',REF).split('\n').every(s=>/^Public export \d{4}-\d{2}-\d{2}$/.test(s)),true,'messages say nothing about private commits');
 assert.ok(second.commit!==first.commit);
 // A branch that grew out of main is refused rather than published.
 git('branch','leaky','main');assert.throws(()=>publishPublicBranch({root,branch:'leaky'}),/shares history with HEAD/);
 assert.throws(()=>publishPublicBranch({root,branch:'main'}),/not a usable branch name/);
});
