// The Git LFS page and its wizard on the mocked DOM (tests/fixtures/mini-dom.mjs), with API answers of the shape
// server/git-lfs-store.mjs builds: every status drawn, English without a Czech word left, deletion offered only for
// what the server says can go, the manual way shown where the host cannot delete, and the wizard's token link and
// permissions following the chosen kind of host.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {installDom,fire,Element} from './fixtures/mini-dom.mjs';
import {BUILTIN_PROVIDERS,providerView} from '../server/git-lfs-providers.mjs';

const {document}=installDom();
document.head=new Element('head');document.append(document.head);
// Form controls as the page uses them: value (a select defaults to its first option), options, showModal.
const E=Element.prototype;
Object.defineProperty(E,'value',{configurable:true,get(){if(this._value!==undefined)return this._value;if(this.tagName==='select'){const o=this.children.find(x=>x.tagName==='option');return o?.getAttribute('value')??'';}return this.getAttribute('value')??'';},set(v){this._value=String(v);}});
Object.defineProperty(E,'options',{configurable:true,get(){return this.children.filter(x=>x.tagName==='option');}});
E.showModal=function(){this.open=true;};E.close=function(){this.open=false;fire(this,'close');};
globalThis.location={hash:'#git-lfs',origin:'http://127.0.0.1'};
const i18n=await import('../public/i18n.js');
const {setIdentity}=await import('../public/access.js');
const {gitLfsPage,sizeBound,bytes}=await import('../public/git-lfs-view.js');
const {leaveView}=await import('../public/views.js');
const {openWizard,webAddress,tokenUrl}=await import('../public/git-lfs-wizard.js');

const text=n=>n.textContent;
const all=(n,tag,out=[])=>{for(const k of n.children){if(k.tagName===tag)out.push(k);all(k,tag,out);}return out;};
const find=(n,tag,label)=>all(n,tag).find(x=>text(x).includes(label));
const tick=()=>new Promise(r=>setTimeout(r,0));
const CZECH=/[ěščřžýáíéůúťďňĚŠČŘŽÝÁÍÉŮÚ]/;
const providers=[...BUILTIN_PROVIDERS.map(providerView),{...providerView(BUILTIN_PROVIDERS[1]),id:'fakehost',title:'Fake host',kind:'plugin',capabilities:{listRepos:true,checkObjects:true,listObjects:true,deleteObjects:true,tokenScopes:true}}];
const item=(o,status,extra={})=>({oid:o.repeat(64),size:1048576*3,status,stored:true,paths:['art/'+o+'.png'],pathCount:1,currentPaths:status==='current'?['art/'+o+'.png']:[],refs:status==='orphaned'?[]:['refs/heads/main'],refCount:status==='orphaned'?0:1,via:[],
 firstCommit:{sha:'1'.repeat(40),at:'2026-01-01T12:00:00Z'},lastCommit:{sha:'2'.repeat(40),at:'2026-01-02T12:00:00Z'},commits:1,firstSeenAt:'2026-11-01T00:00:00Z',lastSeenAt:'2026-11-11T08:00:00Z',lastReferencedAt:null,
 unreferencedSince:status==='orphaned'?'2026-11-09T00:00:00Z':null,createdAt:null,connection:'c0000000001',connectionName:'Fake',provider:'fakehost',repo:'alice/media',extension:'png',reclaimable:false,canDelete:false,
 deleteBlocked:status,repoUrl:'https://git.example.lan/alice/media',...extra});
const tot={count:4,bytes:4*3145728,reclaimableCount:2,reclaimableBytes:2*3145728,byStatus:{current:{count:1,bytes:3145728},history:{count:1,bytes:3145728},orphaned:{count:2,bytes:2*3145728}}};
const conn={id:'c0000000001',provider:'fakehost',providerTitle:'Fake host',name:'Fake',baseUrl:'https://git.example.lan',web:'https://git.example.lan',plainHttp:false,repoMode:'all',owner:null,repos:[],login:'alice',scopes:null,tokenSet:true,
 createdAt:'2026-11-01T00:00:00Z',capabilities:providers.at(-1).capabilities,scan:{running:false,startedAt:'2026-11-11T08:00:00Z',finishedAt:'2026-11-11T08:01:00Z',error:null,truncated:false,
  repos:[{fullName:'alice/media',state:'ok',error:null,scannedAt:'2026-11-11T08:00:00Z',complete:true,storedCheck:'listed',defaultBranch:'main',refs:3,objects:4,bytes:tot.bytes,url:'https://git.example.lan/alice/media'}]}};
const page={schemaVersion:1,total:4,offset:0,limit:50,totals:tot,filtered:tot,extensions:[{ext:'png',count:4}],items:[item('a','current'),item('b','history'),
 item('c','orphaned',{canDelete:true,reclaimable:true,deleteBlocked:null}),
 item('d','orphaned',{reclaimable:true,deleteBlocked:'unsupported',manual:{text:'Smaž ho ve webovém rozhraní Gitea: repozitář → Nastavení → LFS (správce repozitáře). Na serveru to umí i úloha cron gc_lfs.',url:'https://git.example.lan/alice/media/settings/lfs/show/'+'d'.repeat(64)}})]};
const calls=[];
globalThis.fetch=async(url,opts={})=>{calls.push({url,method:opts.method||'GET',body:opts.body?JSON.parse(opts.body):null});
 const body=url==='/api/git-lfs'?{schemaVersion:1,enabled:true,graceHours:24,git:{ok:true},providers,connections:[conn]}:url.startsWith('/api/git-lfs/objects')?page:
  url==='/api/git-lfs/delete/preview'?{groups:[{connection:conn.id,repo:'alice/media',revision:'e'.repeat(64),canDelete:true,eligible:[{oid:'c'.repeat(64),size:3145728,paths:['art/c.png']}],refused:[],bytes:3145728}]}:{};
 return {ok:true,status:200,json:async()=>body,headers:new Map()};};

test('the page in English: every status, totals, deletion only where the server allows it, the manual way otherwise',async t=>{
 t.after(()=>leaveView());
 i18n.setLang('en');setIdentity({role:'admin',scopes:['read','git-lfs:write'],canWrite:true});
 const view=gitLfsPage({me:{role:'admin',scopes:['read','git-lfs:write']}});document.body.append(view);
 for(let i=0;i<6;i++)await tick();
 const shown=text(view);
 for(const s of ['On the default branch','On another branch','Only in old commits','Orphaned','Reclaimable','Fake host','can delete','alice/media'])assert.ok(shown.includes(s),s);
 assert.equal(CZECH.test(shown),false,'no Czech left: '+(shown.match(new RegExp('.{0,30}'+CZECH.source+'.{0,30}'))||[''])[0]);
 assert.doesNotMatch(shown,/null/,"no literal null drawn");
 const rows=all(view,'tr').filter(r=>r.getAttribute('class'));
 assert.deepEqual(rows.map(r=>r.getAttribute('class')),['current','history','orphaned','orphaned']);
 const boxes=rows.map(r=>all(r,'input')[0]);
 assert.deepEqual(boxes.map(b=>Boolean(b.disabled)),[true,true,false,true],'only the one the server marks canDelete can be picked');
 assert.ok(calls.some(c=>c.url.startsWith('/api/git-lfs/objects?')&&c.url.includes('sort=size')));
 const del=find(view,'button','Delete selected');assert.ok(del.hasAttribute('disabled'));
 boxes[2].checked=true;fire(boxes[2],'change');
 const del2=find(view,'button','Delete selected');assert.equal(del2.hasAttribute('disabled'),false);
 fire(del2,'click');for(let i=0;i<4;i++)await tick();
 const pv=calls.find(c=>c.url==='/api/git-lfs/delete/preview');assert.deepEqual(pv.body,{connection:conn.id,repo:'alice/media',oids:['c'.repeat(64)]});
 const dialog=all(document.body,'dialog').at(-1);assert.ok(text(dialog).includes('1 orphaned LFS object will be deleted'));assert.equal(CZECH.test(text(dialog)),false);
 fire(find(dialog,'button','Delete for good'),'click');for(let i=0;i<4;i++)await tick();
 const sent=calls.find(c=>c.url==='/api/git-lfs/delete');
 assert.equal(sent.body.revision,'e'.repeat(64));assert.deepEqual(sent.body.oids,['c'.repeat(64)]);assert.match(sent.body.requestId,/^[0-9a-f-]{36}$/);
 // The details of the read-only orphan: the manual way, translated.
 fire(all(rows[3],'button').at(-1),'click');
 const info=all(document.body,'dialog').at(-1);
 assert.ok(text(info).includes('Delete it in the Gitea web interface'));assert.ok(all(info,'a').some(a=>a.getAttribute('href').endsWith('/settings/lfs/show/'+'d'.repeat(64))));
 // A reader sees no checkbox to tick and no connection buttons.
 leaveView();setIdentity({role:'viewer',scopes:['read']});
 const reader=gitLfsPage({me:{role:'viewer',scopes:['read']}});for(let i=0;i<6;i++)await tick();
 assert.ok(all(reader,'tr').filter(r=>r.getAttribute('class')).every(r=>all(r,'input')[0].disabled));
 assert.equal(find(reader,'button','Edit'),undefined);assert.equal(find(reader,'button','Add connection'),undefined);
 assert.equal(sizeBound('1,5'),String(1572864));assert.equal(sizeBound(''),'');assert.equal(sizeBound('x'),null);assert.equal(bytes(3145728),'3 MB');
});

test('the wizard: kinds of host, the token link and permissions for each, what each one can do',()=>{
 i18n.setLang('en');
 assert.equal(webAddress(providers[1],'https://git.example.lan/api/v1/'),'https://git.example.lan');assert.equal(webAddress(providers[1],'ftp://x'),null);
 assert.equal(tokenUrl(providers[0],'https://github.com'),'https://github.com/settings/personal-access-tokens/new');
 assert.equal(tokenUrl(providers[0],'https://ghe.example.lan'),'https://ghe.example.lan/settings/personal-access-tokens/new');
 assert.equal(tokenUrl(providers[2],'https://git.example.lan'),'https://git.example.lan/user/settings/applications');
 const d=openWizard({providers});
 let shown=text(d);
 assert.ok(shown.includes('Contents: Read-only'),'GitHub first: its permissions');assert.ok(shown.includes('Developer settings → Personal access tokens → Fine-grained tokens'),'GitHub: where to click');assert.ok(shown.includes('GitHub has no API that lists or deletes LFS objects'));
 assert.ok(all(d,'a').some(a=>a.getAttribute('href')==='https://github.com/settings/personal-access-tokens/new'));
 assert.equal(CZECH.test(shown),false,'no Czech left: '+(shown.match(new RegExp('.{0,30}'+CZECH.source+'.{0,30}'))||[''])[0]);
 const kind=all(d,'select')[0];kind.value='forgejo';fire(kind,'change');
 const base=all(d,'input').find(i=>i.getAttribute('type')==='url');base.value='https://git.example.lan/';fire(base,'change');
 shown=text(d);
 assert.doesNotMatch(shown,/null/,"no literal null in the wizard");
 assert.ok(shown.includes('read:repository'));assert.ok(shown.includes('Forgejo lists and deletes LFS objects only in its web interface'));
 assert.ok(shown.includes('How to create the token')&&shown.includes('Tokens are not with the SSH / GPG keys'),'where to click, not only what to grant');
 assert.ok(all(d,'a').some(a=>a.getAttribute('href')==='https://git.example.lan/user/settings/applications'));
 for(const m of ["all","owner","selected"]){const mode=all(d,"select").find(s=>s.options.some(o=>o.getAttribute("value")===m));mode.value=m;fire(mode,"change");assert.doesNotMatch(text(d),/null/,"no literal null with repo mode "+m);}
 base.value='http://git.example.lan';fire(base,'change');assert.ok(text(d).includes('the token will travel unencrypted'));
 d.close();
});

test('the empty page: a read-only token guide for every kind of host, and general steps for any other',async()=>{
 i18n.setLang('en');
 const {tokenGuides}=await import('../public/git-lfs-wizard.js');
 const g=tokenGuides(providers),shown=text(g);
 assert.deepEqual(all(g,'summary').map(x=>text(x)),['GitHub','Gitea','Forgejo','Fake host','Another git host']);
 assert.ok(shown.includes('Tokens are not with the SSH / GPG keys'));assert.ok(shown.includes('Contents: Read-only'));
 assert.ok(shown.includes('find Access tokens or Personal access tokens'));
 assert.equal(CZECH.test(shown),false);assert.doesNotMatch(shown,/null|undefined/);
 assert.ok((await readFile(new URL('../public/git-lfs-view.js',import.meta.url),'utf8')).includes('tokenGuides(o.providers||[])'),'the empty page shows them');
});

test('the table sorts by a column header: a click sorts, a second click turns the direction',async()=>{
 const src=await readFile(new URL('../public/git-lfs-view.js',import.meta.url),'utf8');
 for(const k of ["['Soubor','path']","['Repozitář','repo']","['Velikost','size']","['Stav','status']","['Commit','commit']"])assert.ok(src.includes(k),k);
 assert.match(src,/'aria-sort':on\?/,'the sorted column says so to a screen reader');
 assert.match(src,/if\(on\)dir\.value=dir\.value==='asc'\?'desc':'asc'/,'a second click turns the direction');
});
