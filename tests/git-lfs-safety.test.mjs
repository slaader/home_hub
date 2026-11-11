// Git LFS view: the safety rules a review of the first version found missing, one test each. A scan without refs
// or without the default branch, the revision after a deletion, a push between deletions, names from a provider,
// paged listings, the periodic full scan, a tag on a blob, a host changed while a scan starts, a failing audit,
// redirects, busy deletions, and partial or failed storage checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readdirSync} from 'node:fs';
import path from 'node:path';
import {gitHost,workTree,pointer,git} from './support/git-host.mjs';
import {PAST,A,B,D,G,X,get,send,setup,demoRepo,deletingProvider,plugin} from './support/git-lfs-helpers.mjs';
import {BUILTIN_PROVIDERS} from '../server/git-lfs-providers.mjs';
import {REFRESH_MINUTES} from '../server/git-lfs-store.mjs';

const oidOf=ch=>ch.repeat(64);
const objects=async h=>Object.fromEntries((await get(h,'/api/git-lfs/objects')).body.items.map(i=>[i.oid,i]));
const entry=(h,id,repo='alice/media')=>h.store.overview().then(o=>o.connections.find(c=>c.id===id).scan.repos.find(r=>r.fullName===repo));
async function fakeConnection(h,host,body={}){
 return (await send(h,'/api/git-lfs/connections',{provider:'fakehost',name:'Fake',baseUrl:host.origin,token:host.token,repoMode:'selected',repos:['alice/media'],...body})).body.connection;
}
const deleteAll=async(h,c,oids,requestId)=>{
 const pv=(await send(h,'/api/git-lfs/delete/preview',{connection:c.id,repo:'alice/media',oids})).body.groups[0];
 return {pv,r:await send(h,'/api/git-lfs/delete',{connection:c.id,repo:'alice/media',oids,revision:pv.revision,requestId})};
};

test('a host that advertises no refs, or not the default branch, is not trusted: nothing becomes deletable',async t=>{
 const host=await gitHost(t);demoRepo(host);
 const h=await setup(t,{plugins:[plugin()]});
 const c=await fakeConnection(h,host);
 await h.store.refresh(c.id);
 assert.equal((await entry(h,c.id)).complete,true);
 // Every ref disappears (an empty answer, a permission that hides them): all four objects would look orphaned.
 for(const ref of host.bare('alice/media','for-each-ref','--format=%(refname)').split('\n'))host.bare('alice/media','update-ref','-d',ref);
 await h.store.refresh(c.id);h.clock.advance(PAST);
 let e=await entry(h,c.id);
 assert.equal(e.complete,false);assert.equal(e.incomplete,'no-refs');
 let items=await objects(h);
 assert.deepEqual(Object.values(items).map(i=>i.status),['orphaned','orphaned','orphaned','orphaned']);
 assert.ok(Object.values(items).every(i=>!i.canDelete&&i.deleteBlocked==='unverified'));
 const pv=(await send(h,'/api/git-lfs/delete/preview',{connection:c.id,repo:'alice/media',oids:[A]})).body.groups[0];
 assert.equal((await send(h,'/api/git-lfs/delete',{connection:c.id,repo:'alice/media',oids:[A],revision:pv.revision,requestId:'req-norefs-1'})).body.error.code,'GIT_LFS_UNVERIFIED');
 assert.deepEqual(host.deleted,[]);
 // The default branch the host names is not among the refs.
 host.addRepo('alice/trunk',{defaultBranch:'trunk'});const w=workTree(host,'alice/trunk');w.commit({'a.bin':pointer(A,1000)},'one');w.push('main');host.storeObject('alice/trunk',A,1000);
 const c2=await fakeConnection(h,host,{repos:['alice/trunk']});await h.store.refresh(c2.id);
 e=await entry(h,c2.id,'alice/trunk');assert.equal(e.complete,false);assert.equal(e.incomplete,'no-default-branch');
 // An empty repository that stores nothing is fine.
 host.addRepo('alice/empty');const c3=await fakeConnection(h,host,{repos:['alice/empty']});await h.store.refresh(c3.id);
 e=await entry(h,c3.id,'alice/empty');assert.equal(e.complete,true);assert.equal(e.incomplete,null);
});

test('two deletions in a row: the revision after a deletion matches the host, and a push between chunks stops the rest',async t=>{
 const host=await gitHost(t);const {w,first}=demoRepo(host);
 const extra=oidOf('7');
 for(const o of [G,X,extra])host.storeObject('alice/media',o,100,'2026-01-01T00:00:00Z');
 // Once armed, the first deletion is followed by a push of a new branch (someone working while it runs).
 let push=false,pushes=0;
 const provider=deletingProvider({onDelete:async()=>{if(push&&pushes++===0)host.bare('alice/media','update-ref','refs/heads/pushed-meanwhile',first);}});
 const h=await setup(t,{plugins:[{id:'fake-lfs',title:'Fake',provides:{'git-lfs.providers':()=>[provider]}}],extra:{gitLfsDeleteChunk:1}});
 const c=await fakeConnection(h,host);
 await h.store.refresh(c.id);h.clock.advance(PAST);await h.store.refresh(c.id);
 let {r}=await deleteAll(h,c,[G],'req-first-01');assert.deepEqual(r.body.deleted.map(d=>d.oid),[G]);
 ({r}=await deleteAll(h,c,[X],'req-second-1'));
 assert.equal(r.status,200,'the second preview carries the revision of the host after the first deletion');assert.deepEqual(r.body.deleted.map(d=>d.oid),[X]);
 // The catalog's revision is what a fresh scan computes.
 const before=(await send(h,'/api/git-lfs/delete/preview',{connection:c.id,repo:'alice/media',oids:[extra]})).body.groups[0].revision;
 await h.store.refresh(c.id);
 assert.equal((await send(h,'/api/git-lfs/delete/preview',{connection:c.id,repo:'alice/media',oids:[extra]})).body.groups[0].revision,before);
 // A push during the deletion: refs are read again before each chunk (one object here), so the second stops.
 const more=oidOf('8');host.storeObject('alice/media',more,100,'2026-01-01T00:00:00Z');
 h.clock.advance(PAST);await h.store.refresh(c.id);h.clock.advance(PAST);await h.store.refresh(c.id);
 push=true;pushes=0;
 ({r}=await deleteAll(h,c,[extra,more],'req-pushed-01'));
 assert.equal(r.status,200);assert.equal(r.body.deleted.length,1);assert.equal(r.body.stopped,'refs-changed');
 assert.deepEqual(r.body.refused.map(x=>x.reason),['refs-changed']);
 assert.equal(host.deleted.length,3,'G, X and one of the last two; the other was kept');
 assert.ok(w.dir);
});

test('a provider\'s repository names never reach the file system unchecked',async t=>{
 const host=await gitHost(t);demoRepo(host);
 const base=BUILTIN_PROVIDERS.find(p=>p.id==='gitea');
 let names=[{owner:'alice',name:'media',fullName:'alice/media'}];
 const sneaky={...base,id:'sneaky',title:'Sneaky',kind:'plugin',token:{...base.token,note:null},
  listRepos:async()=>names.map(n=>({defaultBranch:'main',private:false,archived:false,...n})),
  getRepo:async(ctx,fullName)=>({owner:'alice',name:'media',fullName:fullName==='alice/media'?'../../outside':fullName,defaultBranch:'main'})};
 const h=await setup(t,{plugins:[{id:'sneaky-lfs',title:'Sneaky',provides:{'git-lfs.providers':()=>[sneaky]}}]});
 const c=(await send(h,'/api/git-lfs/connections',{provider:'sneaky',name:'S',baseUrl:host.origin,token:host.token,repoMode:'all'})).body.connection;
 await h.store.refresh(c.id);
 assert.equal((await entry(h,c.id)).state,'ok');
 // The listing starts to name a path: the scan fails as a whole and keeps the catalog (nothing is "removed").
 names=[{owner:'alice',name:'media',fullName:'../../alice/media'},{owner:'..',name:'x',fullName:'../x'}];
 await h.store.refresh(c.id).catch(()=>{});
 const view=(await h.store.overview()).connections[0];
 assert.equal(view.scan.error,'bad-response');assert.deepEqual(view.scan.repos.map(r=>r.fullName),['alice/media']);
 assert.ok(existsSync(path.join(h.dir,'git-lfs',c.id,'mirrors','alice','media.git')),'the mirror is still there');
 assert.deepEqual(readdirSync(path.join(h.dir,'git-lfs')).sort(),['connections.json',c.id].sort(),'nothing written beside it');
 // getRepo answers another name for a selected repository: that repository fails, nothing else happens.
 const c2=(await send(h,'/api/git-lfs/connections',{provider:'sneaky',name:'S2',baseUrl:host.origin,token:host.token,repoMode:'selected',repos:['alice/media']})).body.connection;
 await h.store.refresh(c2.id);
 const e=(await h.store.overview()).connections.find(x=>x.id===c2.id).scan.repos[0];
 assert.equal(e.state,'error');assert.equal(e.error,'bad-response');
 assert.equal(existsSync(path.join(h.dir,'outside')),false);assert.equal(existsSync(path.join(h.dir,'git-lfs','outside')),false);
});

test('listings: a host that caps its pages below the asked limit still lists everything (X-Total-Count)',async t=>{
 const host=await gitHost(t,{maxPage:2});for(const n of ['a1','a2','a3','a4','a5'])host.addRepo('alice/'+n);
 const h=await setup(t);
 const r=await send(h,'/api/git-lfs/repos',{provider:'gitea',baseUrl:host.origin,token:host.token});
 assert.deepEqual(r.body.repos.map(x=>x.name||x.fullName),['alice/a1','alice/a2','alice/a3','alice/a4','alice/a5']);
});

test('a scan of one repository does not postpone the periodic full scan; a tag on a blob does not break a scan',async t=>{
 const host=await gitHost(t);const {w}=demoRepo(host);
 w.git('tag','-a','-m','annotated','v2');
 w.git('tag','blob-tag',w.git('rev-parse','HEAD:README.md'));w.git('tag','tree-tag',w.git('rev-parse','HEAD^{tree}'));
 w.git('push','-q','origin','--tags');
 const h=await setup(t);
 const c=(await send(h,'/api/git-lfs/connections',{provider:'gitea',name:'G',baseUrl:host.origin,token:host.token,repoMode:'all'})).body.connection;
 await h.store.refresh(c.id);
 const e=await entry(h,c.id);assert.equal(e.state,'ok');assert.equal(e.complete,true);
 const items=await objects(h);
 assert.ok(items[A].refs.includes('refs/tags/v2'),'an annotated tag on a commit is a tip');
 assert.equal(items[B].status,items[B].refs.length?'branch':'history','at another tip: on another branch; at none: only in old commits');
 // The full scan is due after REFRESH_MINUTES; scanning one repository in between does not reset that clock.
 h.clock.advance(REFRESH_MINUTES*60000+1);
 assert.deepEqual(h.store.due(h.clock.now),[c.id]);
 await h.store.refresh(c.id,{repo:'alice/media'});
 assert.deepEqual(h.store.due(h.clock.now),[c.id]);
 await h.store.refresh(c.id);
 assert.deepEqual(h.store.due(h.clock.now),[]);
});

test('changing a connection\'s host while a scan starts is refused, after the host answered',async t=>{
 const host=await gitHost(t);demoRepo(host);
 const other=await gitHost(t,{token:'other-token-123456'});other.delay['/api/v1/user']=300;
 const h=await setup(t);
 const c=(await send(h,'/api/git-lfs/connections',{provider:'gitea',name:'G',baseUrl:host.origin,token:host.token,repoMode:'all'})).body.connection;
 await h.store.refresh(c.id);
 host.delay['/api/v1/user/repos']=800;// the scan below is still running when the other host answers (at 300 ms)
 const saving=send(h,'/api/git-lfs/connections',{id:c.id,provider:'gitea',name:'G',baseUrl:other.origin,token:other.token,repoMode:'all'});
 await new Promise(r=>setTimeout(r,100));
 const scan=h.store.refresh(c.id);
 const r=await saving;
 assert.equal(r.status,409);assert.equal(r.body.error.code,'GIT_LFS_BUSY');
 await scan;
 assert.equal((await entry(h,c.id)).state,'ok','the scan of the old host finished with its catalog intact');
 assert.equal((await h.store.overview()).connections[0].baseUrl,host.origin);
});

test('deletion: busy during a scan; an audit that cannot be written stops it, and what was deleted is still reported',async t=>{
 const host=await gitHost(t);demoRepo(host);
 for(const o of [G,X])host.storeObject('alice/media',o,100,'2026-01-01T00:00:00Z');
 let auditCalls=0,failAt=Infinity;
 const h=await setup(t,{plugins:[plugin()],extra:{gitLfsAppendAudit:async()=>{if(++auditCalls>=failAt)throw new Error('disk full');}}});
 const c=await fakeConnection(h,host);
 await h.store.refresh(c.id);h.clock.advance(PAST);await h.store.refresh(c.id);
 const pv=(await send(h,'/api/git-lfs/delete/preview',{connection:c.id,repo:'alice/media',oids:[G,X]})).body.groups[0];
 h.clock.advance(60000);const scan=h.store.refresh(c.id);
 let r=await send(h,'/api/git-lfs/delete',{connection:c.id,repo:'alice/media',oids:[G,X],revision:pv.revision,requestId:'req-busy-001'});
 assert.equal(r.status,409);assert.equal(r.body.error.code,'GIT_LFS_BUSY');await scan;
 // The very first audit line fails: nothing is deleted.
 auditCalls=0;failAt=1;
 r=await send(h,'/api/git-lfs/delete',{connection:c.id,repo:'alice/media',oids:[G,X],revision:pv.revision,requestId:'req-audit-01'});
 assert.equal(r.status,200);assert.equal(r.body.stopped,'audit-failed');assert.deepEqual(r.body.deleted,[]);assert.deepEqual(host.deleted,[]);
 assert.deepEqual(r.body.refused.map(x=>x.reason),['audit-failed','audit-failed']);
 // The "deleted" line of the first object fails: it is reported as deleted (only), the second is not touched.
 auditCalls=0;failAt=2;
 r=await send(h,'/api/git-lfs/delete',{connection:c.id,repo:'alice/media',oids:[G,X],revision:pv.revision,requestId:'req-audit-02'});
 assert.equal(r.status,200);assert.equal(r.body.stopped,'audit-failed');
 assert.equal(r.body.deleted.length,1);assert.deepEqual(r.body.failed,[]);assert.equal(host.deleted.length,1);
 assert.deepEqual(r.body.refused.map(x=>x.reason),['audit-failed']);
 assert.equal(r.body.refused[0].oid===r.body.deleted[0].oid,false);
});

test('redirects: neither the API nor git follows one, so the token never reaches another host',async t=>{
 const host=await gitHost(t);demoRepo(host);
 const evil=await gitHost(t);
 const h=await setup(t);
 host.redirect['/api/v1/user']=evil.origin+'/api/v1/user';
 const r=await send(h,'/api/git-lfs/test',{provider:'gitea',baseUrl:host.origin,token:host.token});
 assert.equal(r.status,502);assert.equal(r.body.error.host,'redirect');
 delete host.redirect['/api/v1/user'];
 const c=(await send(h,'/api/git-lfs/connections',{provider:'gitea',name:'G',baseUrl:host.origin,token:host.token,repoMode:'all'})).body.connection;
 await h.store.refresh(c.id).catch(()=>{});
 host.redirect['/alice/media.git/']=evil.origin+'/alice/media.git/info/refs?service=git-upload-pack';
 const mirror=path.join(h.dir,'git-lfs',c.id,'mirrors','alice','media.git');
 git(mirror,'update-ref','-d','refs/heads/feature');// so a fetch would have something to do
 h.clock.advance(60000);await h.store.refresh(c.id);
 const e=await entry(h,c.id);assert.equal(e.state,'error');assert.equal(e.complete,false);
 host.redirect['/api/v1/repos/']=evil.origin+'/api/v1/repos/alice/media';
 h.clock.advance(60000);await h.store.refresh(c.id);
 assert.deepEqual(evil.log,[],'the other host was never contacted');
});

test('storage checks: a failed batch API blocks deletion for the repository; a partial one leaves the rest unknown',async t=>{
 const host=await gitHost(t);const {w,second}=demoRepo(host);
 const h=await setup(t,{extra:{gitLfsCheckLimit:2}});
 const c=(await send(h,'/api/git-lfs/connections',{provider:'gitea',name:'G',baseUrl:host.origin,token:host.token,repoMode:'all'})).body.connection;
 await h.store.refresh(c.id);
 host.bare('alice/media','update-ref','-d','refs/heads/feature');
 h.clock.advance(60000);await h.store.refresh(c.id);
 let e=await entry(h,c.id);assert.equal(e.storedCheck,'partial');assert.equal(e.complete,true);
 let items=await objects(h);
 assert.equal(items[D].status,'orphaned');assert.equal(items[D].stored,true,'the orphan candidate is checked first');
 assert.equal(Object.values(items).filter(i=>i.stored===null).length,2,'two of the three referenced objects were past the limit');
 h.clock.advance(PAST);
 assert.equal((await objects(h))[D].reclaimable,true);
 host.fail['/alice/media.git/info/lfs']=500;
 h.clock.advance(60000);await h.store.refresh(c.id);
 e=await entry(h,c.id);assert.equal(e.storedCheck,'failed');assert.equal(e.complete,false);
 items=await objects(h);assert.equal(items[D].deleteBlocked,'unverified');assert.equal(items[D].reclaimable,false);
 assert.ok(w.dir&&second);
});
