// Git LFS view (server/core/git-lfs.mjs, docs/git-lfs.md): real git repositories in a temp dir served by a fake
// host on 127.0.0.1 (tests/support/git-host.mjs: Gitea- or GitHub-shaped API, git over smart HTTP, the LFS batch
// API). Covers the scan (paths, refs, commits, current / history / orphaned), the partial mirror, where tokens may
// and may not go, the wizard endpoints, permissions, the integration switch, and every rule of the deletion path.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,statSync,existsSync,readdirSync,mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {gitHost,workTree,oid,pointer,git} from './support/git-host.mjs';
import {H,PAST,A,B,C,D,E,F,G,X,get,send,setup,demoRepo,deletingProvider,plugin} from './support/git-lfs-helpers.mjs';
import {parsePointer,gitEnv,classify} from '../server/git-lfs-git.mjs';
import {listQuery,extensionOf,validToken} from '../server/git-lfs-store.mjs';
import {BUILTIN_PROVIDERS,cleanBaseUrl,validProvider,providerView,contextFor} from '../server/git-lfs-providers.mjs';

test('pointer parsing, query validation, base URLs and provider shapes',()=>{
 assert.deepEqual(parsePointer(Buffer.from(pointer(A,12))),{oid:A,size:12});
 assert.deepEqual(parsePointer(Buffer.from(pointer(A,12).replace(/\n/g,'\r\n'))),{oid:A,size:12},'CRLF pointers count');
 assert.deepEqual(parsePointer(Buffer.from(`version https://hawser.github.com/spec/v1\noid sha256:${A}\nsize 3\n`)),{oid:A,size:3},'the pre-release spec URL counts');
 assert.deepEqual(parsePointer(Buffer.from(`something else\noid sha256:${A}\n`)),{oid:A,size:null,loose:true},'a text that names an oid like a pointer is kept as a reference');
 assert.equal(parsePointer(Buffer.from('hello world')),null);
 assert.equal(parsePointer(Buffer.alloc(1024,'a')),null,'1024 bytes or more is never a pointer (git-lfs cutoff)');
 assert.equal(extensionOf('a/b/Clip.MP4'),'mp4');assert.equal(extensionOf('Makefile'),'');assert.equal(extensionOf('.env'),'');
 assert.equal(validToken('short'),false);assert.equal(validToken('has space 123'),false);assert.equal(validToken('ghp_abcdefgh1234'),true);
 assert.deepEqual(listQuery({}),{connection:null,repo:null,q:null,ext:null,status:null,minSize:null,maxSize:null,sort:'size',dir:'desc',offset:0,limit:50});
 assert.equal(listQuery({ext:'-'}).ext,'','"-" filters files without an extension');
 for(const bad of [{nope:'1'},{status:'gone'},{sort:'x'},{limit:'0'},{limit:'201'},{minSize:'-1'},{repo:'../x'},{connection:'x'}])assert.throws(()=>listQuery(bad),/invalid/,JSON.stringify(bad));
 assert.equal(cleanBaseUrl('https://git.example.lan/sub/'),'https://git.example.lan/sub');
 for(const bad of ['ftp://x','https://u:p@git.example.lan','https://git.example.lan/?a=1','https://git.example.lan/#x','javascript:alert(1)'])assert.throws(()=>cleanBaseUrl(bad),/invalid/,bad);
 const [github,gitea,forgejo]=BUILTIN_PROVIDERS;
 assert.deepEqual(github.endpoints('https://github.com'),{api:'https://api.github.com',web:'https://github.com'});
 assert.deepEqual(github.endpoints('https://ghe.example.lan/api/v3'),{api:'https://ghe.example.lan/api/v3',web:'https://ghe.example.lan'});
 assert.deepEqual(gitea.endpoints('https://git.example.lan/api/v1'),{api:'https://git.example.lan/api/v1',web:'https://git.example.lan'});
 // The documented reality: no built-in provider can list or delete LFS objects through its API.
 for(const p of BUILTIN_PROVIDERS){assert.equal(p.capabilities.listObjects,false,p.id);assert.equal(p.capabilities.deleteObjects,false,p.id);assert.equal(p.capabilities.checkObjects,true,p.id);assert.ok(validProvider(p),p.id);}
 assert.equal(forgejo.capabilities.tokenScopes,false);
 const view=providerView(gitea);assert.equal(view.token.urlTemplate,'{web}/user/settings/applications');assert.ok(!JSON.stringify(view).includes('function'));
 assert.equal(providerView(github).token.url,'https://github.com/settings/personal-access-tokens/new');
 assert.ok(providerView(gitea).token.steps.length>=5);assert.deepEqual(providerView({...gitea,token:{...gitea.token,steps:undefined}}).token.steps,[],'steps are optional for a plugin');
 assert.equal(validProvider({...gitea,token:{...gitea.token,steps:[1]}}),false,'steps are text');
 assert.equal(validProvider({...deletingProvider(),deleteObject:undefined}),false,'a provider that claims deletion needs deleteObject');
 assert.equal(validProvider({...deletingProvider(),capabilities:{...deletingProvider().capabilities,listObjects:false}}),false,'deleting needs listing');
 // git: the token goes in an environment variable, never in the arguments; no helper, no user config, http(s) only.
 const env=gitEnv({header:'Basic c2VjcmV0'});
 assert.equal(env.GIT_CONFIG_NOSYSTEM,'1');assert.equal(env.GIT_CONFIG_GLOBAL,'/dev/null');assert.equal(env.GIT_TERMINAL_PROMPT,'0');
 const cfg=Object.fromEntries(Array.from({length:Number(env.GIT_CONFIG_COUNT)},(_,i)=>[env[`GIT_CONFIG_KEY_${i}`],env[`GIT_CONFIG_VALUE_${i}`]]));
 assert.equal(cfg['credential.helper'],'');assert.equal(cfg['protocol.allow'],'never');assert.equal(cfg['http.extraHeader'],'Authorization: Basic c2VjcmV0');assert.equal(cfg['http.followRedirects'],'false');
 assert.equal(classify('fatal: Authentication failed for'),'auth');assert.equal(classify('fatal: unable to access: Could not resolve host'),'network');
});

test('wizard: test a token, list repositories, save; the token is write-only and never leaves for another host',async t=>{
 const host=await gitHost(t,{scopes:['read:repository','read:user']});demoRepo(host);host.addRepo('alice/docs');host.addRepo('team/site');
 const h=await setup(t);
 // Testing needs a token or a saved connection.
 assert.equal((await send(h,'/api/git-lfs/test',{provider:'gitea',baseUrl:host.origin})).body.error.code,'GIT_LFS_TOKEN_REQUIRED');
 const bad=await send(h,'/api/git-lfs/test',{provider:'gitea',baseUrl:host.origin,token:'wrong-token-1234'});
 assert.equal(bad.status,502);assert.equal(bad.body.error.host,'auth');
 const ok=await send(h,'/api/git-lfs/test',{provider:'gitea',baseUrl:host.origin+'/api/v1',token:host.token});
 assert.equal(ok.status,200);assert.equal(ok.body.user.login,'alice');assert.deepEqual(ok.body.scopes,['read:repository','read:user']);
 assert.equal(ok.body.capabilities.deleteObjects,false);assert.equal(ok.body.plainHttp,true);assert.equal(ok.body.web,host.origin);
 assert.equal(JSON.stringify(ok.body).includes(host.token),false);
 const repos=await send(h,'/api/git-lfs/repos',{provider:'gitea',baseUrl:host.origin,token:host.token});
 assert.deepEqual(repos.body.repos.map(r=>r.fullName),['alice/docs','alice/media','team/site']);
 assert.deepEqual((await send(h,'/api/git-lfs/repos',{provider:'gitea',baseUrl:host.origin,token:host.token,owner:'team'})).body.repos.map(r=>r.fullName),['team/site']);
 // Save: checked against the host first; a wrong token stores nothing.
 assert.equal((await send(h,'/api/git-lfs/connections',{provider:'gitea',name:'Home',baseUrl:host.origin,token:'wrong-token-1234',repoMode:'all'})).status,502);
 assert.equal(existsSync(h.tokenFile),false);
 for(const bad of [{repoMode:'selected',repos:[]},{repoMode:'selected',repos:['../x']},{repoMode:'owner'},{repoMode:'nope'},{name:''},{baseUrl:'ftp://x'},{extra:1}])
  assert.equal((await send(h,'/api/git-lfs/connections',{provider:'gitea',name:'Home',baseUrl:host.origin,token:host.token,repoMode:'all',...bad})).status,400,JSON.stringify(bad));
 const saved=await send(h,'/api/git-lfs/connections',{provider:'gitea',name:'Home',baseUrl:host.origin+'/',token:host.token,repoMode:'selected',repos:['alice/media']});
 assert.equal(saved.status,201);const c=saved.body.connection;
 assert.equal(c.tokenSet,true);assert.equal(c.login,'alice');assert.equal(c.baseUrl,host.origin);assert.equal(JSON.stringify(saved.body).includes(host.token),false);
 await h.store.refresh(c.id);
 // Where the token is: only the 0600 token file. Not the connections, not the catalog, not the mirror, not an answer.
 assert.equal(statSync(h.tokenFile).mode&0o777,0o600);
 assert.equal(JSON.parse(readFileSync(h.tokenFile,'utf8')).tokens[c.id],host.token);
 const stateFiles=[];const walk=d=>{for(const e of readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);if(e.isDirectory())walk(p);else stateFiles.push(p);}};walk(path.join(h.dir,'git-lfs'));
 for(const f of stateFiles)assert.equal(readFileSync(f).includes(host.token),false,`token found in ${f}`);
 assert.equal(statSync(path.join(h.dir,'git-lfs','connections.json')).mode&0o777,0o600);
 for(const url of ['/api/git-lfs','/api/git-lfs/objects'])assert.equal(JSON.stringify((await get(h,url)).body).includes(host.token),false,url);
 // A test of the saved connection uses its stored token, but only for the same host.
 assert.equal((await send(h,'/api/git-lfs/test',{provider:'gitea',baseUrl:host.origin,connection:c.id})).status,200);
 assert.equal((await send(h,'/api/git-lfs/test',{provider:'gitea',baseUrl:'http://127.0.0.2:1',connection:c.id})).body.error.code,'GIT_LFS_TOKEN_REQUIRED');
 assert.equal((await send(h,'/api/git-lfs/test',{provider:'github',connection:c.id})).body.error.code,'GIT_LFS_TOKEN_REQUIRED');
 const before=host.log.length;
 assert.equal((await send(h,'/api/git-lfs/connections',{id:c.id,provider:'gitea',name:'Home',baseUrl:'http://127.0.0.2:1',repoMode:'all'})).body.error.code,'GIT_LFS_TOKEN_REQUIRED','a new host needs a new token');
 assert.equal(host.log.length,before);
 // Same host: rename and change the selection without the token.
 const edited=await send(h,'/api/git-lfs/connections',{id:c.id,provider:'gitea',name:'Home Gitea',baseUrl:host.origin,repoMode:'owner',owner:'alice'});
 assert.equal(edited.status,200);assert.equal(edited.body.connection.name,'Home Gitea');assert.equal(edited.body.connection.updatedBy,'admin');
 // The API calls used the "token" header; git and LFS used basic auth. The clone_url the API offered (another host) was never used.
 assert.ok(host.log.filter(l=>l.path.startsWith('/api/v1/')).every(l=>l.auth===`token ${host.token}`||l.auth==='token wrong-token-1234'));
 assert.ok(host.log.filter(l=>/\.git\//.test(l.path)).every(l=>l.auth?.startsWith('Basic ')));
 const mirror=path.join(h.dir,'git-lfs',c.id,'mirrors','alice','media.git');
 assert.equal(git(mirror,'config','remote.origin.url'),`${host.origin}/alice/media.git`);
 assert.equal(readFileSync(path.join(mirror,'config'),'utf8').includes(host.token),false);
 // Remove: connection, token, catalog and mirrors go.
 await h.store.refresh(c.id);
 assert.equal((await send(h,'/api/git-lfs/connections/remove',{id:c.id})).status,200);
 assert.deepEqual(JSON.parse(readFileSync(h.tokenFile,'utf8')).tokens,{});
 assert.equal(existsSync(path.join(h.dir,'git-lfs',c.id)),false);
 assert.deepEqual((await get(h,'/api/git-lfs')).body.connections,[]);
 assert.equal((await send(h,'/api/git-lfs/connections/remove',{id:c.id})).status,404);
});

test('scan: paths, refs and commits of every pointer; current, history only, orphaned; the mirror has no large blob',async t=>{
 const host=await gitHost(t);const {w,first,second,third}=demoRepo(host);
 const h=await setup(t);
 const c=(await send(h,'/api/git-lfs/connections',{provider:'forgejo',name:'Forgejo',baseUrl:host.origin,token:host.token,repoMode:'selected',repos:['alice/media']})).body.connection;
 await h.store.refresh(c.id);
 const all=(await get(h,'/api/git-lfs/objects')).body;
 const by=Object.fromEntries(all.items.map(i=>[i.oid,i]));
 assert.deepEqual(Object.keys(by).sort(),[A,B,C,D].sort());
 assert.equal(by[A].status,'current');assert.deepEqual(by[A].currentPaths,['art/logo-copy.png','art/logo.png'],'one pointer, two names');assert.equal(by[A].pathCount,2);
 assert.deepEqual(by[A].refs,['refs/heads/feature','refs/heads/main','refs/tags/v1']);assert.equal(by[A].firstCommit.sha,first);assert.equal(by[A].lastCommit.sha,second);
 assert.equal(by[B].status,'branch','replaced on main, still at the tip of the tag v1');assert.deepEqual(by[B].paths,['video/intro.mp4']);assert.deepEqual(by[B].refs,['refs/tags/v1']);assert.deepEqual(by[B].currentPaths,[]);
 assert.equal(by[C].status,'current');assert.equal(by[C].size,7000);
 assert.equal(by[D].status,'branch','only on another branch');assert.deepEqual(by[D].refs,['refs/heads/feature']);assert.equal(by[D].firstCommit.sha,third);
 for(const i of all.items){assert.equal(i.stored,true);assert.equal(i.canDelete,false);assert.equal(i.reclaimable,false);}
 assert.equal(all.totals.count,4);assert.equal(all.totals.bytes,16000);assert.equal(all.totals.byStatus.current.count,2);assert.equal(all.totals.byStatus.branch.bytes,8000,'both still sit at a branch or tag tip');assert.equal(all.totals.byStatus.history.count,0);assert.equal(all.totals.reclaimableBytes,0);
 // The mirror: partial, bare, every ref of the host, no large blob fetched.
 const mirror=path.join(h.dir,'git-lfs',c.id,'mirrors','alice','media.git');
 assert.equal(git(mirror,'config','remote.origin.partialclonefilter'),'blob:limit=1024');
 const bigBlob=git(w.dir,'rev-parse',`${first}:big.dat`);
 assert.throws(()=>execFileSync('git',['--git-dir='+mirror,'cat-file','-e',bigBlob],{env:{...process.env,GIT_NO_LAZY_FETCH:'1'},stdio:'ignore'}),'the 6000-byte blob is not in the mirror');
 // Search, filters, sorting, pages.
 const q=async s=>(await get(h,'/api/git-lfs/objects?'+new URLSearchParams(s))).body;
 assert.deepEqual((await q({q:'poster'})).items.map(i=>i.oid),[D]);
 assert.deepEqual((await q({q:'tags/v1',sort:'size',dir:'asc'})).items.map(i=>i.oid),[A,B],'refs are searchable');
 assert.deepEqual((await q({ext:'mp4'})).items.map(i=>i.oid).sort(),[B,C].sort());
 assert.deepEqual((await q({status:'branch',sort:'size',dir:'desc'})).items.map(i=>i.oid),[B,D]);assert.deepEqual((await q({status:'history'})).items,[],'none is only in old commits here');
 assert.deepEqual((await q({minSize:'3000',maxSize:'5000'})).items.map(i=>i.oid).sort(),[B,D].sort());
 const page=await q({sort:'size',dir:'desc',limit:'2',offset:'2'});assert.deepEqual(page.items.map(i=>i.oid),[D,A]);assert.equal(page.total,4);assert.equal(page.filtered.count,4);
 assert.deepEqual((await q({sort:'path',dir:'asc'})).items.map(i=>i.oid),[A,D,B,C],'by path, then oid');
 for(const dir of ['asc','desc']){const at=(await q({sort:'commit',dir})).items.map(i=>i.lastCommit.at);assert.deepEqual(at,[...at].sort()[dir==='asc'?'slice':'reverse'](),`by the last commit's date, ${dir}`);}
 assert.deepEqual((await q({repo:'alice/media',status:'current'})).filtered.count,2);
 assert.ok((await q({})).extensions.some(e=>e.ext==='psd'&&e.count===1));
 assert.equal((await get(h,'/api/git-lfs/objects?status=bogus')).status,400);
 // History rewritten: the feature branch is deleted and main is force-pushed without the logo copy.
 host.bare('alice/media','update-ref','-d','refs/heads/feature');
 w.git('reset','-q','--hard',second);w.git('rm','-q','art/logo-copy.png');w.git('commit','-q','--amend','-m','second, rewritten');w.git('push','-q','--force','origin','main');
 h.clock.advance(H);
 await h.store.refresh(c.id);
 const after=Object.fromEntries((await q({})).items.map(i=>[i.oid,i]));
 assert.equal(after[D].status,'orphaned','no ref reaches the poster any more; the host still stores it');
 assert.equal(after[D].stored,true);assert.equal(after[D].remembered,true);assert.deepEqual(after[D].paths,['design/poster.psd'],'where it was is remembered');
 assert.equal(after[D].unreferencedSince,new Date(h.clock.now).toISOString());assert.equal(after[D].deleteBlocked,'grace');assert.equal(after[D].reclaimable,false);
 assert.equal(after[A].status,'current');assert.deepEqual(after[A].currentPaths,['art/logo.png']);assert.deepEqual(after[A].refs,['refs/heads/main','refs/tags/v1']);
 // After the grace period: reclaimable, but this host cannot delete, so it says how to by hand.
 h.clock.advance(PAST);
 const later=(await q({status:'orphaned'})).items[0];
 assert.equal(later.reclaimable,true);assert.equal(later.canDelete,false);assert.equal(later.deleteBlocked,'unsupported');
 assert.equal(later.manual.url,`${host.origin}/alice/media/settings/lfs/show/${D}`);
 assert.equal((await q({})).totals.reclaimableBytes,3000);
 // The host no longer has it: it leaves the catalog.
 host.store.get('alice/media').delete(D);await h.store.refresh(c.id);
 assert.equal((await q({})).items.some(i=>i.oid===D),false);
});

test('read-only hosts: deletion is refused and the preview explains what to do instead',async t=>{
 const host=await gitHost(t);const {w}=demoRepo(host);
 const h=await setup(t);
 const c=(await send(h,'/api/git-lfs/connections',{provider:'gitea',name:'Gitea',baseUrl:host.origin,token:host.token,repoMode:'all'})).body.connection;
 await h.store.refresh(c.id);
 host.bare('alice/media','update-ref','-d','refs/heads/feature');await h.store.refresh(c.id);h.clock.advance(PAST);
 const pv=(await send(h,'/api/git-lfs/delete/preview',{connection:c.id,repo:'alice/media',oids:[D,A]})).body;
 assert.equal(pv.groups[0].canDelete,false);assert.deepEqual(pv.groups[0].eligible,[]);
 assert.deepEqual(pv.groups[0].refused.map(r=>[r.oid,r.reason]).sort(),[[A,'current'],[D,'unsupported']].sort());
 assert.match(pv.groups[0].manual.url,/\/alice\/media\/settings\/lfs$/);
 const del=await send(h,'/api/git-lfs/delete',{connection:c.id,repo:'alice/media',oids:[D],revision:pv.groups[0].revision,requestId:'req-readonly-1'});
 assert.equal(del.status,409);assert.equal(del.body.error.code,'GIT_LFS_UNSUPPORTED');
 assert.equal(host.log.some(l=>l.method==='DELETE'),false);
 assert.equal(w.dir.length>0,true);
});

test('GitHub (Enterprise): scopes from X-OAuth-Scopes, warnings, git with x-access-token',async t=>{
 const host=await gitHost(t,{kind:'github',scopes:['repo','delete_repo']});demoRepo(host);
 const h=await setup(t);
 const ok=(await send(h,'/api/git-lfs/test',{provider:'github',baseUrl:host.origin+'/api/v3',token:host.token})).body;
 assert.equal(ok.api,host.origin+'/api/v3');assert.deepEqual(ok.scopes,['repo','delete_repo']);assert.equal(ok.warnings.length,1,'more than it needs');
 const c=(await send(h,'/api/git-lfs/connections',{provider:'github',name:'GHE',baseUrl:host.origin,token:host.token,repoMode:'owner',owner:'alice'})).body.connection;
 await h.store.refresh(c.id);
 assert.equal((await get(h,'/api/git-lfs/objects')).body.total,4);
 assert.ok(host.log.filter(l=>l.path.startsWith('/api/v3/')).every(l=>l.auth===`Bearer ${host.token}`));
 const basic=host.log.find(l=>l.path.endsWith('/info/refs')).auth;
 assert.equal(Buffer.from(basic.slice(6),'base64').toString(),`x-access-token:${host.token}`);
 const none=await gitHost(t,{kind:'github',scopes:['read:org']});
 assert.equal((await send(h,'/api/git-lfs/test',{provider:'github',baseUrl:none.origin,token:none.token})).body.warnings.length,1,'neither repo nor public_repo');
});

test('deletion: only confirmed orphans past the grace period, re-verified right before, audited, fail closed',async t=>{
 const host=await gitHost(t);const {w}=demoRepo(host);
 host.storeObject('alice/media',G,4000,'2026-11-01T00:00:00Z');// stored, never referenced: an orphan only a listing host reveals
 host.storeObject('alice/media',X,9000,'2026-11-11T07:30:00Z');// uploaded half an hour ago
 const h=await setup(t,{plugins:[plugin()]});
 const view=(await get(h,'/api/git-lfs')).body;
 assert.ok(view.providers.some(p=>p.id==='fakehost'&&p.kind==='plugin'&&p.capabilities.deleteObjects));
 const c=(await send(h,'/api/git-lfs/connections',{provider:'fakehost',name:'Fake',baseUrl:host.origin,token:host.token,repoMode:'selected',repos:['alice/media']})).body.connection;
 await h.store.refresh(c.id);
 let items=Object.fromEntries((await get(h,'/api/git-lfs/objects')).body.items.map(i=>[i.oid,i]));
 assert.equal(items[G].status,'orphaned');assert.equal(items[G].deleteBlocked,'grace','first seen unreferenced just now');
 assert.equal(items[X].deleteBlocked,'grace');
 h.clock.advance(PAST);
 items=Object.fromEntries((await get(h,'/api/git-lfs/objects')).body.items.map(i=>[i.oid,i]));
 assert.equal(items[G].canDelete,true);assert.equal(items[X].canDelete,true);
 assert.equal(items[A].canDelete,false);assert.equal(items[B].deleteBlocked,'branch','objects at another tip are never deletable');
 // Preview: what goes and what does not.
 let pv=(await send(h,'/api/git-lfs/delete/preview',{connection:c.id,repo:'alice/media',oids:[G,A,B,F]})).body.groups[0];
 assert.deepEqual(pv.eligible.map(e=>e.oid),[G]);
 assert.deepEqual(Object.fromEntries(pv.refused.map(r=>[r.oid,r.reason])),{[A]:'current',[B]:'branch',[F]:'not-found'});
 // A stale revision deletes nothing.
 let r=await send(h,'/api/git-lfs/delete',{connection:c.id,repo:'alice/media',oids:[G],revision:'0'.repeat(64),requestId:'req-stale-001'});
 assert.equal(r.status,409);assert.equal(r.body.error.code,'GIT_LFS_CONFLICT');assert.deepEqual(host.deleted,[]);
 // Something starts to reference G after the preview: the fresh scan sees it and nothing is deleted.
 w.git('checkout','-q','-b','revive');w.commit({'restore/g.bin':pointer(G,4000)},'bring g back');w.git('push','-q','origin','revive');w.git('checkout','-q','main');
 r=await send(h,'/api/git-lfs/delete',{connection:c.id,repo:'alice/media',oids:[G],revision:pv.revision,requestId:'req-revive-01'});
 assert.equal(r.status,409);assert.equal(r.body.error.code,'GIT_LFS_CONFLICT');assert.deepEqual(host.deleted,[]);
 items=Object.fromEntries((await get(h,'/api/git-lfs/objects')).body.items.map(i=>[i.oid,i]));
 assert.equal(items[G].status,'branch','the re-scan before deleting updated the catalog: G is at the tip of revive again');assert.deepEqual(items[G].refs,['refs/heads/revive']);
 // The branch goes again: G is unreferenced, but only just, so the grace period starts over.
 host.bare('alice/media','update-ref','-d','refs/heads/revive');await h.store.refresh(c.id);
 assert.equal((await send(h,'/api/git-lfs/delete/preview',{connection:c.id,repo:'alice/media',oids:[G]})).body.groups[0].refused[0].reason,'grace');
 h.clock.advance(PAST);await h.store.refresh(c.id);
 // A failing host at delete time: the scan is incomplete, nothing is deleted.
 pv=(await send(h,'/api/git-lfs/delete/preview',{connection:c.id,repo:'alice/media',oids:[G,X]})).body.groups[0];
 assert.deepEqual(pv.eligible.map(e=>e.oid).sort(),[G,X].sort());
 host.fail['/api/fake/']=500;
 r=await send(h,'/api/git-lfs/delete',{connection:c.id,repo:'alice/media',oids:[G,X],revision:pv.revision,requestId:'req-failing-1'});
 assert.equal(r.status,503);assert.equal(r.body.error.code,'GIT_LFS_UNVERIFIED');assert.deepEqual(host.deleted,[]);
 items=Object.fromEntries((await get(h,'/api/git-lfs/objects')).body.items.map(i=>[i.oid,i]));
 assert.equal(items[G].canDelete,false);assert.equal(items[G].deleteBlocked,'unverified','an incomplete scan blocks deletion in the list too');
 delete host.fail['/api/fake/'];await h.store.refresh(c.id);
 // The real thing, with a current object mixed in that must survive.
 pv=(await send(h,'/api/git-lfs/delete/preview',{connection:c.id,repo:'alice/media',oids:[G,X,A]})).body.groups[0];
 r=await send(h,'/api/git-lfs/delete',{connection:c.id,repo:'alice/media',oids:[G,X,A],revision:pv.revision,requestId:'req-delete-01'});
 assert.equal(r.status,200);
 assert.deepEqual(r.body.deleted.map(d=>d.oid).sort(),[G,X].sort());assert.equal(r.body.bytes,13000);
 assert.equal(r.body.stopped,undefined,'the refs read between deletions (git ls-remote) agree with the scan');assert.equal(r.body.refsChangedDuring,undefined);
 assert.deepEqual(r.body.refused.map(x=>[x.oid,x.reason]),[[A,'current']]);
 assert.deepEqual(host.deleted.map(d=>d.oid).sort(),[G,X].sort());
 assert.equal((await get(h,'/api/git-lfs/objects?status=orphaned')).body.total,0);
 // The same request again is answered from memory, nothing is deleted twice.
 const again=await send(h,'/api/git-lfs/delete',{connection:c.id,repo:'alice/media',oids:[G,X,A],revision:pv.revision,requestId:'req-delete-01'});
 assert.equal(again.body.repeated,true);assert.equal(host.deleted.length,2);
 // The audit: a started and a deleted line per object, who and where; 0600; never the token.
 const auditFile=path.join(h.dir,'git-lfs','audit.jsonl');
 assert.equal(statSync(auditFile).mode&0o777,0o600);
 const lines=readFileSync(auditFile,'utf8').trim().split('\n').map(l=>JSON.parse(l));
 assert.deepEqual(lines.map(l=>[l.oid,l.result]).sort(),[[G,'started'],[G,'deleted'],[X,'started'],[X,'deleted']].sort());
 assert.ok(lines.every(l=>l.actor==='admin'&&l.repo==='alice/media'&&l.host===host.origin&&l.requestId==='req-delete-01'));
 assert.equal(readFileSync(auditFile,'utf8').includes(host.token),false);
 assert.equal((await get(h,'/api/git-lfs/audit')).body.items.length,4);
});

test('deletion: an object another repository on the same host uses is kept; bulk preview by filter',async t=>{
 const host=await gitHost(t);demoRepo(host);
 host.addRepo('alice/other');const o=workTree(host,'alice/other');o.commit({'shared.bin':pointer(E,2000)},'uses e');o.push('main');host.storeObject('alice/other',E,2000);
 host.storeObject('alice/media',E,2000,'2026-01-01T00:00:00Z');host.storeObject('alice/media',F,6000,'2026-01-01T00:00:00Z');
 const h=await setup(t,{plugins:[plugin()]});
 const c=(await send(h,'/api/git-lfs/connections',{provider:'fakehost',name:'Fake',baseUrl:host.origin,token:host.token,repoMode:'all'})).body.connection;
 await h.store.refresh(c.id);h.clock.advance(PAST);await h.store.refresh(c.id);
 const pv=(await send(h,'/api/git-lfs/delete/preview',{filter:{}})).body;
 assert.equal(pv.groups.length,1);const g=pv.groups[0];
 assert.equal(g.repo,'alice/media');assert.deepEqual(g.eligible.map(e=>e.oid),[F]);
 assert.deepEqual(g.refused.map(r=>[r.oid,r.reason]),[[E,'in-use-elsewhere']]);
 assert.equal(pv.eligibleBytes,6000);
 assert.deepEqual((await send(h,'/api/git-lfs/delete/preview',{filter:{minSize:'7000'}})).body.groups,[],'the filter narrows the bulk selection');
 const r=await send(h,'/api/git-lfs/delete',{connection:c.id,repo:'alice/media',oids:[E,F],revision:g.revision,requestId:'req-shared-01'});
 assert.deepEqual(r.body.deleted.map(d=>d.oid),[F]);assert.deepEqual(host.deleted.map(d=>d.oid),[F]);
 for(const bad of [{connection:c.id,repo:'alice/media',oids:[],revision:g.revision,requestId:'req-bad-0001'},{connection:c.id,repo:'alice/media',oids:['abc'],revision:g.revision,requestId:'req-bad-0002'},
  {connection:c.id,repo:'alice/media',oids:[F],revision:g.revision,requestId:'x'},{connection:c.id,repo:'alice/media',oids:Array(501).fill(F),revision:g.revision,requestId:'req-bad-0003'}])
  assert.equal((await send(h,'/api/git-lfs/delete',bad)).status,400);
});

test('permissions: reading needs read, managing and deleting need git-lfs:write; the integration switch stops everything',async t=>{
 const host=await gitHost(t);demoRepo(host);
 const h=await setup(t);
 const reader=await h.account('reader',['read']),writer=await h.account('lfs',['git-lfs:write']);
 const c=(await send(h,'/api/git-lfs/connections',{provider:'gitea',name:'Gitea',baseUrl:host.origin,token:host.token,repoMode:'all'},writer.headers)).body.connection;
 assert.ok(c?.id,'a key with git-lfs:write manages connections');
 await h.store.refresh(c.id);
 assert.equal((await get(h,'/api/git-lfs/objects',reader.headers)).body.total,4,'a read key sees the catalog');
 for(const [url,body] of [['/api/git-lfs/test',{provider:'gitea',baseUrl:host.origin,token:host.token}],['/api/git-lfs/connections',{provider:'gitea',name:'x',baseUrl:host.origin,token:host.token,repoMode:'all'}],
  ['/api/git-lfs/connections/remove',{id:c.id}],['/api/git-lfs/delete/preview',{filter:{}}],['/api/git-lfs/delete',{connection:c.id,repo:'alice/media',oids:[D],revision:'0'.repeat(64),requestId:'req-perm-001'}]])
  assert.equal((await send(h,url,body,reader.headers)).status,403,url);
 assert.equal((await get(h,'/api/git-lfs/audit',reader.headers)).status,403);
 h.clock.advance(60000);
 assert.equal((await send(h,'/api/git-lfs/refresh',{connection:c.id},reader.headers)).status,403,'a read-only key may not make the hub fetch');
 assert.equal((await send(h,'/api/git-lfs/refresh',{connection:c.id},writer.headers)).status,202);
 await h.store.refresh(c.id);h.clock.advance(60000);
 assert.equal((await send(h,'/api/git-lfs/refresh',{connection:c.id})).status,202,'a signed-in person who can read may ask for a fresh scan');
 assert.equal((await send(h,'/api/git-lfs/refresh',{connection:'cffffffffff'})).status,404);
 await h.store.refresh(c.id);
 const throttled=(await send(h,'/api/git-lfs/refresh',{connection:c.id})).body;assert.deepEqual(throttled.started,[]);assert.equal(throttled.skipped[0].reason,'throttled');
 // An administrator turns the integration off: reads say so, writes are refused, the host is not contacted.
 const card=(await get(h,'/api/admin/integrations')).body.integrations.find(i=>i.id==='git-lfs.hosts');
 assert.equal(card.status.state,'ok');assert.equal(card.page,'git-lfs');assert.equal(card.toggle,true);
 await h.handler.hub.integrations.store.set('git-lfs.hosts',false,'admin');
 const before=host.log.length;
 const off=(await get(h,'/api/git-lfs')).body;assert.ok(off.disabled);assert.deepEqual(off.connections,[]);
 assert.deepEqual((await get(h,'/api/git-lfs/objects')).body.items,[]);
 for(const [url,body] of [['/api/git-lfs/refresh',{}],['/api/git-lfs/test',{provider:'gitea',baseUrl:host.origin,token:host.token}],['/api/git-lfs/delete/preview',{filter:{}}]])
  assert.equal((await send(h,url,body)).status,409,url);
 assert.deepEqual(h.store.due(Date.now()+1e12).length,1,'the poller still knows the connection is due…');
 assert.equal(host.log.length,before,'…but nothing was fetched');
 assert.equal((await get(h,'/api/admin/integrations')).body.integrations.find(i=>i.id==='git-lfs.hosts').status.state,'disabled');
 // The manifest: the page is in the sidebar for everyone who can read.
 const m=(await get(h,'/api/ui/manifest',reader.headers)).body;
 assert.ok(m.pages.find(p=>p.hash==='git-lfs')?.view);
});

test('Gitea and Forgejo: a token that may sign in but not read repositories fails the check, naming what it lacks',async()=>{
 const forgejo=BUILTIN_PROVIDERS.find(p=>p.id==='forgejo'),seen=[];
 const reply=(status,body)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
 const fetchImpl=async url=>{seen.push(new URL(url).pathname);
  if(url.endsWith('/api/v1/user'))return reply(200,{login:'alice'});
  return reply(403,{message:'token does not have at least one of required scope(s): [read:repository]'});};
 await assert.rejects(forgejo.whoami(contextFor(forgejo,{baseUrl:'https://git.example.lan',token:'t0ken-value',fetchImpl})),{code:'missing-scope'});
 assert.deepEqual(seen,['/api/v1/user','/api/v1/user/repos'],'the check lists one repository after signing in');
 const ok=async url=>url.endsWith('/api/v1/user')?reply(200,{login:'alice'}):reply(200,[]);
 assert.equal((await forgejo.whoami(contextFor(forgejo,{baseUrl:'https://git.example.lan',token:'t0ken-value',fetchImpl:ok}))).login,'alice');
 const other=async url=>url.endsWith('/api/v1/user')?reply(200,{login:'alice'}):reply(403,{message:'forbidden'});
 await assert.rejects(forgejo.whoami(contextFor(forgejo,{baseUrl:'https://git.example.lan',token:'t0ken-value',fetchImpl:other})),{code:'forbidden'},'any other refusal stays forbidden');
});
