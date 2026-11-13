import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,stat} from 'node:fs/promises';
import http from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {trackerView} from '../public/tracker-view.js';
import {setPrincipal} from '../public/session-cache.js';
import os from 'node:os';
import path from 'node:path';
import {createTicketStore as createStore,compareVersions} from '../server/tickets-store.mjs';
// The tracker seeds nothing by itself; these tests start with the two projects a site would configure.
const SEED=[{id:'home-hub',key:'HH',name:'Home Hub',type:'app'},{id:'sample-game',key:'GAME',name:'Sample Game',type:'game'}];
const createTicketStore=(root,options={})=>createStore(root,{seedProjects:SEED,...options});
import {hub} from './hub-helper.mjs';

async function store(t){const dir=await mkdtemp(path.join(os.tmpdir(),'tickets-'));t.after(()=>rm(dir,{recursive:true,force:true}));return {dir,s:createTicketStore(dir)};}

test('tickets: ids per project, defaults, release must exist, history and closedAt',async t=>{
 const {dir,s}=await store(t);
 const a=await s.create({project:'home-hub',title:'  Ticket system  ',type:'feature'},'admin');
 assert.equal(a.id,'HH-1');assert.equal(a.title,'Ticket system');assert.equal(a.status,'open');assert.equal(a.priority,'normal');assert.equal(a.release,null);assert.equal(a.rev,1);assert.equal(a.reporter,'admin');
 assert.equal((await s.create({project:'sample-game',title:'Sandworm pathing',type:'bug'},'admin')).id,'GAME-1');
 assert.equal((await s.create({project:'home-hub',title:'Second'},'admin')).id,'HH-2');
 await assert.rejects(s.create({project:'home-hub',title:'x',release:'2.4'},'admin'),/invalid/);
 await assert.rejects(s.create({project:'nope',title:'x'},'admin'),/invalid/);
 await assert.rejects(s.create({project:'home-hub',title:'   '},'admin'),/invalid/);
 await assert.rejects(s.create({project:'home-hub',title:'x',type:'epic'},'admin'),/invalid/);
 await assert.rejects(s.create({project:'home-hub',title:'x',secret:1},'admin'),/invalid/);
 await assert.rejects(s.create({project:'home-hub',title:'x',labels:['Has Space']},'admin'),/invalid/);
 const r=await s.saveRelease({project:'home-hub',version:'2.4',targetDate:'2026-12-01'},'admin');assert.equal(r.status,'planned');assert.equal(r.rev,1);
 const u=await s.update({id:'HH-1',rev:1,status:'done',release:'2.4',labels:['UI','api','ui']},'claude');
 assert.equal(u.rev,2);assert.equal(u.release,'2.4');assert.deepEqual(u.labels,['ui','api']);assert.ok(u.closedAt);
 assert.deepEqual(u.history.slice(1).map(h=>[h.field,h.from,h.to,h.by]),[['status','open','done','claude'],['release',null,'2.4','claude'],['labels',[],['ui','api'],'claude']]);
 await assert.rejects(s.update({id:'HH-1',rev:1,status:'open'},'x'),/conflict/);
 await assert.rejects(s.update({id:'HH-99',rev:1,status:'open'},'x'),/not-found/);
 await assert.rejects(s.update({id:'HH-1',rev:2},'x'),/invalid/);
 // A release of another project is not accepted.
 await assert.rejects(s.update({id:'GAME-1',rev:1,release:'2.4'},'x'),/invalid/);
 const reopened=await s.update({id:'HH-1',rev:2,status:'open'},'x');assert.equal(reopened.closedAt,null);
 // Unchanged values do not bump rev.
 assert.equal((await s.update({id:'HH-1',rev:3,status:'open'},'x')).rev,3);
 const c=await s.comment({id:'HH-1',text:'Done in abc123'},'codex');assert.equal(c.comments[0].by,'codex');assert.equal(c.rev,3);
 const persisted=await createTicketStore(dir).list();assert.equal(persisted.tickets.length,3);
 await assert.rejects(stat(path.join(dir,'tickets.json')),/ENOENT/,'no JSON file is written any more');
});

test('tickets: list filters, release counts and release lifecycle',async t=>{
 const {s}=await store(t);
 await s.saveRelease({project:'home-hub',version:'2.10'},'a');await s.saveRelease({project:'home-hub',version:'2.9'},'a');
 await s.create({project:'home-hub',title:'Crash on login',type:'bug',priority:'urgent',release:'2.9'},'a');
 await s.create({project:'home-hub',title:'Dark charts',type:'feature',status:'done',release:'2.9',labels:['ui']},'a');
 await s.create({project:'sample-game',title:'Spice harvester',type:'feature',assignee:'alice'},'a');
 const all=await s.list();assert.equal(all.total,3);assert.equal(all.tickets[0].title,'Crash on login');assert.equal(all.tickets[0].comments,0);assert.equal(all.tickets[0].history,undefined);
 assert.deepEqual(all.releases.map(r=>r.version),['2.9','2.10']);
 assert.deepEqual(all.releases[0].counts,{open:1,'in-progress':0,done:1,cancelled:0});
 assert.equal((await s.list({status:'active'})).total,2);
 assert.equal((await s.list({project:'home-hub',type:'bug'})).total,1);
 assert.equal((await s.list({release:'none'})).tickets[0].id,'GAME-1');
 assert.equal((await s.list({assignee:'alice'})).total,1);
 assert.equal((await s.list({label:'ui'})).total,1);
 assert.equal((await s.list({q:'HARVEST'})).total,1);
 await assert.rejects(s.list({status:'weird'}),/invalid/);
 await assert.rejects(s.list({bogus:'1'}),/invalid/);
 await assert.rejects(s.saveRelease({project:'home-hub',version:'2.9'},'a'),/conflict/);
 await assert.rejects(s.saveRelease({project:'home-hub',version:'3.0',rev:1},'a'),/not-found/);
 await assert.rejects(s.saveRelease({project:'home-hub',version:'bad version'},'a'),/invalid/);
 const released=await s.saveRelease({project:'home-hub',version:'2.9',rev:1,status:'released'},'a');assert.equal(released.releasedAt,new Date().toISOString().slice(0,10));
 const back=await s.saveRelease({project:'home-hub',version:'2.9',rev:2,status:'planned'},'a');assert.equal(back.releasedAt,null);
 assert.ok(compareVersions('2.10','2.9')>0);
 const p=await s.saveProject({id:'ob1',key:'OB',name:'OB1',description:'Memory layer'},'a');assert.equal(p.key,'OB');assert.equal(p.rev,1);assert.equal(p.next,undefined);
 await assert.rejects(s.saveProject({id:'ob1-x',key:'OB',name:'dup key'},'a'),/conflict/);
 await assert.rejects(s.saveProject({id:'ob1',key:'OB',name:'again'},'a'),/conflict/);
 await assert.rejects(s.saveProject({id:'ob1',rev:1,key:'XX'},'a'),/invalid/);
 const renamed=await s.saveProject({id:'ob1',rev:1,name:'Open Brain'},'a');assert.equal(renamed.name,'Open Brain');assert.equal(renamed.description,'Memory layer');assert.equal(renamed.rev,2);
 assert.equal((await s.saveProject({id:'home-hub',rev:1,description:'Dashboard'},'a')).description,'Dashboard');
 assert.equal((await s.create({project:'ob1',title:'Memory'},'a')).id,'OB-1');
});

test('tickets: concurrent creates get distinct ids',async t=>{
 const {s}=await store(t);
 const made=await Promise.all(Array.from({length:12},(_,i)=>s.create({project:'home-hub',title:'T'+i},'a')));
 assert.equal(new Set(made.map(x=>x.id)).size,12);assert.equal((await s.list()).total,12);
});

test('tickets HTTP: session CRUD, read-only keys, tickets:write scope, errors',async t=>{
 const h=await hub(t);
 const created=await h.post('/api/tickets',{project:'home-hub',title:'From UI',type:'bug'},h.admin);assert.equal(created.status,201);
 const ticket=await created.json();assert.equal(ticket.id,'HH-1');assert.equal(ticket.reporter,'admin');
 const get=await fetch(h.origin+'/api/tickets/HH-1',{headers:h.admin});assert.equal(get.status,200);assert.equal((await get.json()).title,'From UI');
 assert.equal((await fetch(h.origin+'/api/tickets/HH-9',{headers:h.admin})).status,404);
 assert.equal((await fetch(h.origin+'/api/tickets/../x',{headers:h.admin})).status,404);
 assert.equal((await fetch(h.origin+'/api/tickets?status=nope',{headers:h.admin})).status,400);
 assert.equal((await fetch(h.origin+'/api/tickets')).status,401);
 const stale=await h.post('/api/tickets/update',{id:'HH-1',rev:5,status:'done'},h.admin);assert.equal(stale.status,409);assert.equal((await stale.json()).error.code,'TICKETS_FAILED');
 assert.equal((await h.post('/api/tickets/update',{id:'HH-1',rev:1,status:'in-progress'},h.admin)).status,200);
 assert.equal((await h.post('/api/tickets/releases',{project:'home-hub',version:'2.4'},h.admin)).status,200);
 // Origin protection still applies to session writes.
 assert.equal((await fetch(h.origin+'/api/tickets',{method:'POST',headers:{...h.admin,'Content-Type':'application/json',Origin:'https://evil.example'},body:'{}'})).status,403);
 const reader=await h.account('reader',['read']),writer=await h.account('ticket-bot',['tickets:write']);
 const list=await fetch(h.origin+'/api/tickets?project=home-hub',{headers:reader.headers});assert.equal(list.status,200);assert.equal((await list.json()).tickets[0].status,'in-progress');
 const denied=await h.post('/api/tickets',{project:'home-hub',title:'nope'},reader.headers);assert.equal(denied.status,403);assert.equal((await denied.json()).error.code,'SCOPE_REQUIRED');
 const bot=await h.post('/api/tickets/comment',{id:'HH-1',text:'Bot was here'},writer.headers);assert.equal(bot.status,200);assert.equal((await bot.json()).comments[0].by,'ticket-bot');
 assert.equal((await h.post('/api/inventory/entries',{entry:{id:'x',kind:'tool',name:'x'}},writer.headers)).status,403);
});

test('tickets MCP: tools follow scopes; create, update with rev, comment',async t=>{
 const h=await hub(t);
 const reader=await h.account('reader',['read']),writer=await h.account('agent',['tickets:write']);
 let n=0;const rpc=async(who,method,params)=>(await (await fetch(h.origin+'/mcp',{method:'POST',headers:{...who.headers,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++n,method,params})})).json()).result;
 const call=(who,name,args)=>rpc(who,'tools/call',{name,arguments:args});
 const readerTools=(await rpc(reader,'tools/list')).tools.map(x=>x.name);
 assert.ok(readerTools.includes('tickets_list')&&readerTools.includes('ticket_get'));assert.ok(!readerTools.includes('ticket_create'));
 assert.ok((await rpc(writer,'tools/list')).tools.some(x=>x.name==='ticket_update'));
 const refused=await call(reader,'ticket_create',{project:'home-hub',title:'x'});assert.equal(refused.isError,true);
 assert.equal((await call(writer,'release_save',{project:'home-hub',version:'2.5'})).isError,false);
 const made=await call(writer,'ticket_create',{project:'home-hub',title:'Agent filed',type:'bug',release:'2.5',labels:['mcp']});
 assert.equal(made.isError,false);assert.equal(made.structuredContent.id,'HH-1');
 const bad=await call(writer,'ticket_create',{project:'home-hub',title:'x',release:'9.9'});assert.equal(bad.isError,true);assert.match(bad.content[0].text,/release exists/);
 const got=await call(reader,'ticket_get',{id:'HH-1'});assert.equal(got.structuredContent.rev,1);
 const upd=await call(writer,'ticket_update',{id:'HH-1',rev:1,status:'done'});assert.equal(upd.structuredContent.status,'done');
 const conflict=await call(writer,'ticket_update',{id:'HH-1',rev:1,status:'open'});assert.equal(conflict.isError,true);assert.match(conflict.content[0].text,/rev/);
 assert.equal((await call(writer,'ticket_comment',{id:'HH-1',text:'Fixed in abc'})).structuredContent.comments.length,1);
 const listed=await call(reader,'tickets_list',{status:'done',query:'agent'});assert.equal(listed.structuredContent.total,1);assert.equal(listed.structuredContent.releases[0].counts.done,1);
 const log=await (await fetch(h.origin+'/api/admin/audit',{headers:h.admin})).json();
 assert.ok(JSON.stringify(log).includes('ticket_update'));
});


test('tickets: dates, revisions, field types and filters reject invalid values without writing',async t=>{
 const {dir,s}=await store(t);
 const ticket=await s.create({project:'home-hub',title:'Validation'},'a');
 const snapshot=async()=>JSON.stringify([await s.list(),await s.get(ticket.id)]),before=await snapshot();
 for(const d of ['2026-02-29','2026-02-30','2026-04-31','2026-13-01','not-a-date']){
  await assert.rejects(s.saveRelease({project:'home-hub',version:'1',targetDate:d},'a'),/invalid/);
  await assert.rejects(s.saveRelease({project:'home-hub',version:'1',status:'released',releasedAt:d},'a'),/invalid/);
 }
 for(const rev of [0,-1,1.5,'1',Number.MAX_SAFE_INTEGER+1]){
  await assert.rejects(s.update({id:ticket.id,rev,title:'Changed'},'a'),/invalid/);
  await assert.rejects(s.saveRelease({project:'home-hub',version:'1',rev},'a'),/invalid/);
  await assert.rejects(s.saveProject({id:'home-hub',rev,name:'Changed'},'a'),/invalid/);
 }
 await assert.rejects(s.saveRelease({project:'home-hub',version:'none'},'a'),/invalid/);
 for(const fields of [{description:null},{assignee:42},{assignee:'none'},{labels:'ui'},{refs:[1]},{title:'x'.repeat(201)}])await assert.rejects(s.update({id:ticket.id,rev:1,...fields},'a'),/invalid/);
 for(const f of [{type:'epic'},{priority:'critical'},{q:1},{q:'q'.repeat(101)},{status:0},{project:'../home-hub'},{release:'bad version'},{label:'bad label'},{limit:0},{limit:5001}])await assert.rejects(s.list(f),/invalid/);
 assert.equal(await snapshot(),before);
 assert.equal((await s.saveRelease({project:'home-hub',version:'1',targetDate:'2028-02-29'},'a')).targetDate,'2028-02-29');
});

test('tickets: interleaved comments, updates and conflicts preserve data and recover the queue',async t=>{
 const {dir,s}=await store(t);const a=await s.create({project:'home-hub',title:'Race'},'a');
 const outcomes=await Promise.allSettled([
  s.comment({id:a.id,text:'first'},'a'),s.update({id:a.id,rev:1,status:'done'},'a'),
  s.update({id:a.id,rev:1,title:'stale'},'a'),s.comment({id:a.id,text:'second'},'b'),
  s.update({id:a.id,rev:2,priority:'high',release:'missing'},'a'),s.create({project:'home-hub',title:'Next'},'a')]);
 assert.equal(outcomes[2].reason.message,'conflict');assert.equal(outcomes[4].reason.message,'invalid');assert.equal(outcomes[5].value.id,'HH-2');
 const saved=await createTicketStore(dir).get(a.id);assert.equal(saved.rev,2);assert.equal(saved.status,'done');assert.equal(saved.priority,'normal');assert.equal(saved.title,'Race');
 assert.deepEqual(saved.comments.map(c=>c.text),['first','second']);assert.equal(saved.history.length,2);
 const release=await s.saveRelease({project:'home-hub',version:'1'},'a');
 const releases=await Promise.allSettled([s.saveRelease({...release,createdAt:undefined},'a'),s.saveRelease({project:'home-hub',version:'1',rev:1,status:'released'},'a'),s.saveRelease({project:'home-hub',version:'1',rev:1,notes:'stale'},'a')]);
 assert.equal(releases[0].reason.message,'invalid');assert.equal(releases[1].status,'fulfilled');assert.equal(releases[2].reason.message,'conflict');
 const projects=await Promise.allSettled([s.saveProject({id:'home-hub',rev:1,name:'Renamed'},'a'),s.saveProject({id:'home-hub',rev:1,name:'Stale'},'a')]);
 assert.equal(projects[0].status,'fulfilled');assert.equal(projects[1].reason.message,'conflict');
 assert.equal((await stat(path.join(dir,'hub.db'))).mode&0o777,0o600);
 // A corrupt old JSON file must be refused rather than replaced with a new empty tracker.
 const fresh=await mkdtemp(path.join(os.tmpdir(),'tickets-legacy-'));t.after(()=>rm(fresh,{recursive:true,force:true}));
 await writeFile(path.join(fresh,'tickets.json'),'{broken');const broken=createTicketStore(fresh);
 await assert.rejects(broken.create({project:'home-hub',title:'Do not reset'},'a'));await assert.rejects(broken.list());
 assert.equal(await readFile(path.join(fresh,'tickets.json'),'utf8'),'{broken');
});

const rpcClient=(h,who)=>async(name,args)=>{
 const r=await fetch(h.origin+'/mcp',{method:'POST',headers:{...who.headers,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});
 return (await r.json()).result;
};

test('tickets: UTF-8 byte budget applies to HTTP and MCP, and partial edits remain possible',async t=>{
 const h=await hub(t),writer=await h.account('byte-writer',['tickets:write']),call=rpcClient(h,writer);
 const huge={project:'home-hub',title:'Too large',description:'ž'.repeat(9000)};
 assert.equal((await h.post('/api/tickets',huge,h.admin)).status,413);
 assert.equal((await call('ticket_create',huge)).isError,true);
 const base={project:'home-hub',title:'Boundary',description:''};
 base.description='x'.repeat(16384-Buffer.byteLength(JSON.stringify(base)));
 assert.equal(Buffer.byteLength(JSON.stringify(base)),16384);
 // Character limits still apply even when the body fits.
 assert.equal((await h.post('/api/tickets',base,h.admin)).status,400);
 const exact={project:'home-hub',title:'Exact byte boundary',description:'ž'.repeat(8000)};
 exact.description+='x'.repeat(16384-Buffer.byteLength(JSON.stringify(exact)));
 assert.equal((await h.post('/api/tickets',exact,h.admin)).status,201);exact.description+='x';
 assert.equal((await h.post('/api/tickets',exact,h.admin)).status,413);assert.equal((await call('ticket_create',exact)).isError,true);
 const large={project:'home-hub',title:'Near limit',description:'ž'.repeat(7900)};
 const made=await h.post('/api/tickets',large,h.admin);assert.equal(made.status,201);const ticket=await made.json();
 assert.equal((await call('ticket_update',{id:ticket.id,rev:1,refs:['r'.repeat(300)],assignee:'a'.repeat(60)})).isError,false);
 assert.equal((await h.post('/api/tickets/update',{id:ticket.id,rev:2,status:'done'},h.admin)).status,200);
 assert.equal((await (await fetch(h.origin+'/api/tickets/'+ticket.id,{headers:h.admin})).json()).description,large.description);
});

test('tickets MCP: rejects schema violations and accepts explicit release dates',async t=>{
 const h=await hub(t),writer=await h.account('schema-writer',['tickets:write']),call=rpcClient(h,writer);
 for(const filter of [{limit:0},{limit:201},{limit:1.5},{limit:'2'},{q:'hidden alias'},{type:'epic'},{query:42},{query:'x'.repeat(101)},{status:0}])assert.equal((await call('tickets_list',filter)).isError,true,JSON.stringify(filter));
 assert.equal((await call('ticket_get',{id:'HH-1',extra:'no'})).isError,true);
 assert.equal((await call('release_save',{project:'home-hub',version:'1',targetDate:'2026-02-30'})).isError,true);
 const r=await call('release_save',{project:'home-hub',version:'1',status:'released',releasedAt:'2026-10-01'});assert.equal(r.structuredContent.releasedAt,'2026-10-01');
 const list=await (await fetch(h.origin+'/mcp',{method:'POST',headers:{...writer.headers,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})})).json();
 assert.ok(list.result.tools.find(t=>t.name==='release_save').inputSchema.properties.releasedAt);
});

test('tickets: audit never copies rejected ids or release arguments into log subjects',async t=>{
 const h=await hub(t),writer=await h.account('audit-writer',['tickets:write']),call=rpcClient(h,writer);
 const marker='hhk_synthetic-secret-argument';
 assert.equal((await call('ticket_update',{id:marker,rev:1,status:'done'})).isError,true);
 assert.equal((await call('release_save',{project:marker,version:marker})).isError,true);
 assert.equal((await h.post('/api/tickets/update',{id:marker,rev:1,status:'done'},writer.headers)).status,404);
 const created=await call('ticket_create',{project:'home-hub',title:marker});assert.equal(created.isError,false);
 const release=await call('release_save',{project:'home-hub',version:marker});assert.equal(release.isError,false);
 // A subsequent awaited write makes all finish-event audit appends observable.
 await call('ticket_comment',{id:created.structuredContent.id,text:marker});
 const log=await readFile(path.join(h.dir,'api-audit.jsonl'),'utf8');
 assert.ok(!log.includes(marker));assert.ok(log.includes('HH-1'));assert.ok(log.includes('home-hub'));
});

test('tickets HTTP: every write route enforces scopes, session permissions and origin',async t=>{
 const h=await hub(t),reader=await h.account('scope-reader',['read']),unrelated=await h.account('inventory-writer',['inventory:write']);
 const user=await (await h.post('/api/admin/users',{username:'viewer',password:'viewer-test-password'},h.admin)).json();assert.ok(user.user);
 const login=await h.post('/api/session',{username:'viewer',password:'viewer-test-password'}),viewer={Cookie:login.headers.get('set-cookie').split(';')[0]};
 for(const route of ['','/update','/comment','/releases','/projects']){
  const url='/api/tickets'+route;
  assert.equal((await h.post(url,{},reader.headers)).status,403);assert.equal((await h.post(url,{},unrelated.headers)).status,403);
  assert.equal((await h.post(url,{},viewer)).status,403);assert.equal((await h.post(url,{})).status,401);
  assert.equal((await h.post(url,{}, {...h.admin,Origin:'https://evil.example'})).status,403);
 }
 assert.equal((await fetch(h.origin+'/api/tickets',{headers:viewer})).status,200);
 for(const id of ['..%2fsecret','%2e%2e%2fsecret','HH-1%2f..%2fsecret'])assert.equal((await fetch(h.origin+'/api/tickets/'+id,{headers:h.admin})).status,404);
});

test('tickets HTTP and MCP: split multibyte request chunks preserve Czech text',async t=>{
 const h=await hub(t),writer=await h.account('unicode-writer',['tickets:write']);
 const send=async(route,body,headers)=>{
  const bytes=Buffer.from(JSON.stringify(body)),split=bytes.indexOf(Buffer.from('ž'))+1;assert.ok(split>0);
  return new Promise((resolve,reject)=>{
   const req=http.request(h.origin+route,{method:'POST',headers:{Origin:h.origin,'Content-Type':'application/json',...headers}},res=>{
    let raw='';res.setEncoding('utf8');res.on('data',s=>raw+=s);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(raw)}));
   });req.on('error',reject);req.write(bytes.subarray(0,split));setTimeout(()=>req.end(bytes.subarray(split)),20);
  });
 };
 const title='žluťoučký kůň 🐛';
 const rest=await send('/api/tickets',{project:'home-hub',title},h.admin);assert.equal(rest.status,201);assert.equal(rest.data.title,title);
 const mcp=await send('/mcp',{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'ticket_create',arguments:{project:'home-hub',title}}},writer.headers);
 assert.equal(mcp.data.result.structuredContent.title,title);
});


// Small DOM harness for async view behaviour; real form/CSP/layout checks use the throwaway preview.
class TrackerNode{
 constructor(tag,text=''){this.tag=tag;this.tagName=tag.toUpperCase();this.text=text;this.children=[];this.attrs={};this.listeners={};this.style={setProperty(){}};this._value=undefined;
  const list=()=>(this.attrs.class||'').split(/\s+/).filter(Boolean),set=a=>{this.attrs.class=a.join(' ');};
  this.classList={contains:c=>list().includes(c),add:(...c)=>set([...new Set([...list(),...c])]),remove:(...c)=>set(list().filter(x=>!c.includes(x))),toggle:(c,on=!list().includes(c))=>{on?this.classList.add(c):this.classList.remove(c);return on;}};}
 setAttribute(k,v){this.attrs[k]=String(v);if(k==='value')this.value=v;}
 removeAttribute(k){delete this.attrs[k];}
 get dataset(){return Object.fromEntries(Object.entries(this.attrs).filter(([k])=>k.startsWith('data-')).map(([k,v])=>[k.slice(5),v]));}
 addEventListener(k,fn){this.listeners[k]=fn;}
 append(...nodes){for(const n of nodes){n.parent=this;this.children.push(n);}}
 replaceChildren(...nodes){for(const n of this.children)n.parent=null;this.children=[];this.append(...nodes);}
 getAttribute(k){return this.attrs[k]??null;}
 contains(node){return nodes(this,n=>n===node).length>0;}
 querySelectorAll(s){if(s==='[aria-label]')return nodes(this,n=>n.attrs['aria-label']);throw new Error('Unsupported selector '+s);}
 get textContent(){return this.text+this.children.map(n=>n.textContent).join('');}
 set textContent(s){this.text=s;this.replaceChildren();}
 get value(){if(this._value!==undefined)return this._value;if(this.tag==='select'){const opts=nodes(this,n=>n.tag==='option');return (opts.find(n=>n.selected)||opts[0])?.attrs.value||'';}return '';}
 set value(v){this._value=v;}
 get firstChild(){return this.children[0];}
 get title(){return nodes(this,n=>n.attrs.name==='title')[0];}
 get isConnected(){return this===document.body||Boolean(this.parent?.isConnected);}
 querySelector(s){const m=s.match(/^([a-z]+)(?:\[([a-z-]+)=['"]?([^'"\]]+)['"]?\])?$/);return nodes(this,n=>n!==this&&n.tag===m?.[1]&&(!m[2]||n.attrs[m[2]]===m[3]))[0]||null;}
 focus(){document.activeElement=this;}
 setSelectionRange(){}
 showModal(){this.open=true;}
 close(){this.open=false;this.listeners.close?.();}
 remove(){if(this.parent){this.parent.children=this.parent.children.filter(n=>n!==this);this.parent=null;}}
}
const nodes=(root,predicate)=>[root,...root.children.flatMap(n=>nodes(n,()=>true))].filter(predicate);
const flush=async()=>{for(let i=0;i<6;i++)await delay(0);};
function dom(t){
 const saved={document:globalThis.document,Node:globalThis.Node,fetch:globalThis.fetch,location:globalThis.location,dispatchEvent:globalThis.dispatchEvent};
 globalThis.Node=TrackerNode;globalThis.document={createElement:tag=>new TrackerNode(tag),createElementNS:(ns,tag)=>new TrackerNode(tag),createTextNode:text=>new TrackerNode('#text',text),activeElement:null};
 document.body=new TrackerNode('body');document.activeElement=document.body;globalThis.location={hash:'#items'};setPrincipal({username:'ui-writer',role:'admin'});
 t.after(()=>{setPrincipal(null);Object.assign(globalThis,saved);});
}

test('tickets UI: late filter replies cannot replace newer results or steal focus',async t=>{
 dom(t);const authEvents=[];globalThis.dispatchEvent=e=>authEvents.push(e.type);const {s}=await store(t);await s.saveRelease({project:'home-hub',version:'1'},'a');await s.saveRelease({project:'sample-game',version:'1'},'a');const base=await s.list(),pending=[];
 globalThis.fetch=url=>new Promise(resolve=>pending.push({url,resolve}));
 const root=trackerView({canWrite:true},'items');document.body.append(root);
 const reply=(p,title)=>p.resolve(Response.json({...base,tickets:title?[{id:'HH-1',title,status:'open',type:'bug',priority:'normal',labels:[],release:null,assignee:null,comments:0,updatedAt:new Date().toISOString()}]:[],total:title?1:0}));
 pending.splice(0).forEach(p=>reply(p));await flush();
 const status=nodes(root,n=>n.attrs['aria-label']==='All statuses')[0];assert.ok(status);
 const releaseFilter=nodes(root,n=>n.attrs['aria-label']==='All releases')[0];assert.equal(nodes(releaseFilter,n=>n.tag==='option'&&n.attrs.value==='1').length,1);
 status.listeners.change({target:{value:'done'}});const old=pending.splice(0);
 status.focus();status.listeners.change({target:{value:'open'}});const newest=pending.splice(0);newest.forEach(p=>reply(p,'Newest result'));await flush();
 assert.ok(root.textContent.includes('Newest result'));assert.equal(document.activeElement.getAttribute('aria-label'),'All statuses');
 old[0].resolve(Response.json({error:{message:'Stale failure'}},{status:503}));reply(old[1],'Old result');await flush();
 assert.ok(root.textContent.includes('Newest result'));assert.ok(!root.textContent.includes('Stale failure'));
 // A delayed response also must not repopulate an old session's view.
 const project=nodes(root,n=>n.tag==='button'&&n.textContent==='Home Hub')[0];project.listeners.click();const abandoned=pending.splice(0);
 setPrincipal(null);setPrincipal({username:'ui-next',role:'viewer'});abandoned[0].resolve(Response.json({error:{message:'Old session expired'}},{status:401}));reply(abandoned[1],'Old account');await flush();assert.ok(!root.textContent.includes('Old account'));assert.deepEqual(authEvents,[]);
 setPrincipal({username:'ui-reader',role:'viewer'});
 const reader=trackerView({canWrite:false},'items');document.body.append(reader);const reset=pending.splice(0);
 assert.ok(reset.every(p=>!p.url.includes('project=')&&!p.url.includes('status=open')));reset.forEach(p=>reply(p));await flush();
 assert.ok(!reader.textContent.includes('+ New item'));
});

test('tickets UI: session reset closes dialogs and discards a pending dialog load',async t=>{
 dom(t);const {s}=await store(t);const data=await s.list();globalThis.fetch=async()=>Response.json(data);
 const root=trackerView({canWrite:true},'projects');document.body.append(root);await flush();
 const add=()=>nodes(root,n=>n.tag==='button'&&n.textContent==='+ New item')[0].listeners.click();
 await add();assert.equal(nodes(document.body,n=>n.tag==='dialog').length,1);
 setPrincipal(null);assert.equal(nodes(document.body,n=>n.tag==='dialog').length,0);
 setPrincipal({username:'ui-writer',role:'admin'});let resolve;globalThis.fetch=()=>new Promise(r=>resolve=r);
 add();setPrincipal(null);resolve(Response.json(data));await flush();assert.equal(nodes(document.body,n=>n.tag==='dialog').length,0);
});

test('tickets UI: edits send changed fields, oversized comments stay editable, text stays inert',async t=>{
 dom(t);const {s}=await store(t);const ticket=await s.create({project:'home-hub',title:'<img src=x onerror=alert(1)>',description:'ž'.repeat(7900),refs:['javascript:alert(1)','https://example.test/query?a=1,2']},'a');
 const posts=[];globalThis.fetch=async(url,options={})=>{
  if(options.method==='POST'){const body=JSON.parse(options.body);posts.push({url,body});return Response.json(await s.update(body,'ui'));}
  return Response.json(url.startsWith('/api/tickets/')?await s.get(ticket.id):await s.list());
 };
 const root=trackerView({canWrite:true},'items',ticket.id);document.body.append(root);await flush();
 assert.ok(root.textContent.includes(ticket.title));assert.equal(nodes(root,n=>n.tag==='img').length,0);assert.ok(!nodes(root,n=>n.tag==='a').some(n=>n.attrs.href?.startsWith('javascript:')));
 // Read view first: the description is on the page once, and there is no edit form until it is asked for.
 assert.equal(nodes(root,n=>n.tag==='form'&&n.textContent.startsWith('Edit')).length,0,'no edit form in the read view');
 assert.equal(nodes(root,n=>n.tag==='textarea'&&n.attrs.name==='description').length,0);
 assert.equal(nodes(root,n=>n.tag==='h3'&&n.textContent==='Description').length,1);
 buttonText(root,'Edit').listeners.click();
 const edit=nodes(root,n=>n.tag==='form'&&n.textContent.startsWith('Edit'))[0];assert.ok(edit);
 assert.equal(nodes(root,n=>n.tag==='h3'&&n.textContent==='Description').length,0,'while editing, the form holds the description instead of the rendered card');
 assert.equal(nodes(root,n=>n.tag==='textarea'&&n.attrs.name==='description').length,1);assert.equal(document.activeElement,byName(root,'title'),'the keyboard starts in the form');
 const fields=Object.fromEntries(['title','description','type','status','priority','release','assignee','labels','refs'].map(k=>[k,{value:Array.isArray(ticket[k])?ticket[k].join(k==='refs'?'\n':', '):ticket[k]||''}]));fields.priority.value='high';fields.querySelector=()=>({disabled:false});
 edit.listeners.submit({preventDefault(){},currentTarget:fields});await flush();
 assert.deepEqual(posts[0].body,{id:ticket.id,rev:1,priority:'high'});assert.equal((await s.get(ticket.id)).description,ticket.description);
 assert.equal(nodes(root,n=>n.tag==='form'&&n.textContent.startsWith('Edit')).length,0,'a saved edit goes back to the read view');assert.ok(buttonText(root,'Edit'));
 // Cancel closes the form without a write; with unsaved changes it asks first.
 buttonText(root,'Edit').listeners.click();buttonText(root,'Cancel editing').listeners.click();
 assert.equal(nodes(root,n=>n.tag==='form'&&n.textContent.startsWith('Edit')).length,0);assert.equal(document.activeElement,buttonText(root,'Edit'));assert.equal(posts.length,1);
 buttonText(root,'Edit').listeners.click();byName(root,'title').value='changed my mind';
 const asked=[];globalThis.confirm=q=>{asked.push(q);return false;};t.after(()=>{delete globalThis.confirm;});
 buttonText(root,'Cancel editing').listeners.click();assert.deepEqual(asked,['Discard the unsaved edits?']);assert.equal(byName(root,'title').value,'changed my mind','kept when the answer is no');
 globalThis.confirm=()=>true;buttonText(root,'Cancel editing').listeners.click();assert.equal(nodes(root,n=>n.tag==='form'&&n.textContent.startsWith('Edit')).length,0);
 const comment=nodes(root,n=>n.tag==='form'&&n.textContent.includes('Add comment'))[0],button={disabled:false},text={value:'ž'.repeat(8000)};
 // This fits 16 KiB; use three-byte text to cross the byte limit while staying below maxlength.
 text.value='漢'.repeat(6000);await comment.listeners.submit({preventDefault(){},currentTarget:{text,querySelector:()=>button}});
 assert.equal(posts.length,1);assert.equal(button.disabled,false);assert.equal(text.value.length,6000);assert.ok(root.textContent.includes('maximum 16 kB'));
});

// Independent-review regressions: writes render from their own reply and keep unsaved input.
const byName=(root,name)=>nodes(root,n=>n.attrs.name===name)[0];
const buttonText=(root,text)=>nodes(root,n=>n.tag==='button'&&n.textContent.includes(text))[0];
test('tickets UI: a quick status change keeps the unsaved comment and edited description',async t=>{
 dom(t);const {s}=await store(t);const ticket=await s.create({project:'home-hub',title:'Drafts',description:'old'},'a');
 let gets=0;globalThis.fetch=async(url,options={})=>{if(options.method==='POST')return Response.json(await s.update(JSON.parse(options.body),'ui'));gets++;return Response.json(url.startsWith('/api/tickets/')?await s.get(ticket.id):await s.list());};
 const root=trackerView({canWrite:true},'items',ticket.id);document.body.append(root);await flush();const before=gets;
 buttonText(root,'Edit').listeners.click();
 byName(root,'text').value='half-written comment';byName(root,'description').value='new description draft';
 const start=buttonText(root,'Start');await start.listeners.click({currentTarget:start});await flush();
 assert.equal((await s.get(ticket.id)).status,'in-progress');assert.equal(gets,before,'no refetch after a write');
 assert.equal(byName(root,'text').value,'half-written comment');assert.equal(byName(root,'description').value,'new description draft');
 assert.equal(byName(root,'status').value,'in-progress');assert.equal((await s.get(ticket.id)).description,'old');
});
test('tickets UI: a saved comment clears its box even when every later read fails',async t=>{
 dom(t);const {s}=await store(t);const ticket=await s.create({project:'home-hub',title:'No duplicates'},'a');let down=false;
 globalThis.fetch=async(url,options={})=>{if(options.method==='POST')return Response.json(await s.comment(JSON.parse(options.body),'ui'));if(down)return Response.json({error:{message:'down'}},{status:503});return Response.json(url.startsWith('/api/tickets/')?await s.get(ticket.id):await s.list());};
 const root=trackerView({canWrite:true},'items',ticket.id);document.body.append(root);await flush();down=true;
 buttonText(root,'Edit').listeners.click();
 byName(root,'description').value='kept edit';const form=nodes(root,n=>n.tag==='form'&&n.textContent.includes('Add comment'))[0],button={disabled:false};
 await form.listeners.submit({preventDefault(){},currentTarget:{text:{value:'only once'},querySelector:()=>button}});await flush();
 assert.equal((await s.get(ticket.id)).comments.length,1);assert.ok(root.textContent.includes('only once'));
 assert.equal(byName(root,'text').value,'');assert.equal(byName(root,'description').value,'kept edit');assert.ok(!root.textContent.includes('down'));
});
test('tickets UI: a release action shows the saved state when the follow-up refresh fails',async t=>{
 dom(t);const {s}=await store(t);await s.saveRelease({project:'home-hub',version:'2.4'},'a');let down=false;
 globalThis.fetch=async(url,options={})=>{if(options.method==='POST')return Response.json(await s.saveRelease(JSON.parse(options.body),'ui'));if(down)return Response.json({error:{message:'down'}},{status:503});return Response.json(await s.list());};
 const root=trackerView({canWrite:true},'releases');document.body.append(root);await flush();down=true;
 const mark=buttonText(root,'Mark as released');await mark.listeners.click({currentTarget:mark});await flush();
 assert.equal((await s.list()).releases[0].status,'released');
 const back=buttonText(root,'Back to planned');assert.ok(back);assert.ok(!back.disabled);assert.ok(root.textContent.includes('could not be refreshed'));
});
test('tickets UI: the main column may shrink so wide tables scroll inside it on phones',async()=>{
 const css=await readFile(new URL('../public/hub.css',import.meta.url),'utf8');
 assert.match(css,/\.hh-main\{[^}]*min-width:0/);
});

test('tickets MCP: project_save creates and renames projects; read keys cannot see it',async t=>{
 const h=await hub(t);const reader=await h.account('reader',['read']),writer=await h.account('dev-agent',['tickets:write']);
 let n=0;const rpc=async(who,method,params)=>(await (await fetch(h.origin+'/mcp',{method:'POST',headers:{...who.headers,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++n,method,params})})).json()).result;
 const call=(who,name,args)=>rpc(who,'tools/call',{name,arguments:args});
 assert.ok(!(await rpc(reader,'tools/list')).tools.some(x=>x.name==='project_save'));assert.ok((await rpc(writer,'tools/list')).tools.some(x=>x.name==='project_save'));
 assert.equal((await call(reader,'project_save',{id:'ob1',key:'OB',name:'OB1'})).isError,true);
 const made=await call(writer,'project_save',{id:'ob1',key:'OB',name:'OB1'});assert.equal(made.isError,false);assert.equal(made.structuredContent.rev,1);
 assert.equal((await call(writer,'project_save',{id:'ob1',key:'OB',name:'again'})).isError,true);
 const renamed=await call(writer,'project_save',{id:'ob1',rev:1,name:'Open Brain',description:'Memory layer'});assert.equal(renamed.structuredContent.name,'Open Brain');
 assert.equal((await call(writer,'ticket_create',{project:'ob1',title:'Recall outcomes'})).structuredContent.id,'OB-1');
 const log=JSON.stringify(await (await fetch(h.origin+'/api/admin/audit',{headers:h.admin})).json());assert.ok(log.includes('project_save'));
});

// Empty states, language and the tracker polish (inline status, assignee suggestions, previews).
import {setLang} from '../public/i18n.js';
import {setSite} from '../public/site.js';
const EMPTY={updatedAt:null,projects:[],releases:[],total:0,tickets:[]};
test('tickets UI: an empty tracker explains itself in English and hands a ready prompt to an agent',async t=>{
 dom(t);globalThis.fetch=async()=>Response.json(EMPTY);
 for(const page of ['projects','items','releases']){
  const root=trackerView({canWrite:true,username:'alex'},page);document.body.append(root);await flush();const text=root.textContent;
  assert.ok(text.includes('No project here yet'),page);assert.ok(text.includes('project_save')&&text.includes('ticket_create')&&text.includes('tickets:write'),`${page}: the prompt names the tools and the scope`);
  assert.ok(text.includes('/mcp')&&text.includes('Authorization: Bearer'),`${page}: the MCP connection snippet`);
  assert.equal(nodes(root,n=>n.tag==='ol')[0].children.length,3,'numbered steps');
  assert.ok(buttonText(root,'+ New project'),'a writer can create the project right here');assert.ok(!text.includes('+ New item'),'no item without a project');
  assert.doesNotMatch(text,/[ěščřžůĚŠČŘŽŮ]/,`${page}: no Czech on an English hub`);
 }
 const reader=trackerView({canWrite:false},'projects');document.body.append(reader);await flush();
 assert.ok(reader.textContent.includes('No project here yet'));assert.ok(!buttonText(reader,'+ New project'));assert.ok(reader.textContent.includes('Ask the administrator'));
 // The same page in the source language.
 setLang('cs');t.after(()=>setLang('en'));
 const cs=trackerView({canWrite:true},'projects');document.body.append(cs);await flush();
 assert.ok(cs.textContent.includes('Zatím tu není žádný projekt'));assert.ok(buttonText(cs,'+ Nový projekt'));
});
test('tickets UI: the new-project dialog proposes an id and a key from the name',async t=>{
 dom(t);const {s}=await store(t);const posts=[];
 globalThis.fetch=async(url,options={})=>{if(options.method==='POST'){posts.push(JSON.parse(options.body));return Response.json(await s.saveProject(JSON.parse(options.body),'ui'),{status:201});}return Response.json(EMPTY);};
 const root=trackerView({canWrite:true},'projects');document.body.append(root);await flush();
 buttonText(root,'+ New project').listeners.click();
 const dialog=nodes(document.body,n=>n.tag==='dialog')[0],name=byName(dialog,'name'),id=byName(dialog,'id'),key=byName(dialog,'key');
 name.value='Žluté Kolo App';name.listeners.input();assert.equal(id.value,'zlute-kolo-app');assert.equal(key.value,'ZKA');
 name.value='Tracker';name.listeners.input();assert.equal(id.value,'tracker');assert.equal(key.value,'TRAC');
 key.value='TRK';key.listeners.input();name.value='Tracker Two';name.listeners.input();assert.equal(key.value,'TRK','a key typed by hand is kept');assert.equal(id.value,'tracker-two');
 const form=nodes(dialog,n=>n.tag==='form')[0];
 await form.listeners.submit({preventDefault(){},currentTarget:{id,key,name,description:{value:'Sample'},type:{value:'app'},querySelector:()=>({disabled:false})}});
 assert.deepEqual(posts,[{id:'tracker-two',key:'TRK',name:'Tracker Two',description:'Sample',type:'app'}]);assert.equal(dialog.open,false);
});
test('tickets UI: status changes inline, a filter can be cleared, the stat tiles narrow the list',async t=>{
 dom(t);const {s}=await store(t);const a=await s.create({project:'home-hub',title:'Inline',assignee:'robin',labels:['ui']},'alex');await s.create({project:'home-hub',title:'Other'},'alex');
 const posts=[],gets=[];globalThis.fetch=async(url,options={})=>{if(options.method==='POST'){const body=JSON.parse(options.body);posts.push(body);return Response.json(await s.update(body,'ui'));}
  gets.push(url);return Response.json(await s.list(Object.fromEntries(new URL(url,'http://hub.test').searchParams)));};
 const root=trackerView({canWrite:true,username:'alex'},'items');document.body.append(root);await flush();
 const select=nodes(root,n=>n.tag==='select'&&n.attrs['aria-label']===`Status of ${a.id}`)[0];assert.ok(select,'a writer changes the status in the row');
 assert.deepEqual(nodes(select,n=>n.tag==='option').map(o=>o.attrs.value),['open','in-progress','done','cancelled']);
 select.listeners.change({target:{value:'in-progress'},stopPropagation(){}});await flush();
 assert.deepEqual(posts,[{id:a.id,rev:1,status:'in-progress'}]);assert.equal((await s.get(a.id)).status,'in-progress');
 // Quick filters: assignee and label come from the tickets themselves, with "me" on top.
 const assignee=nodes(root,n=>n.attrs['aria-label']==='All assignees')[0];
 assert.deepEqual(nodes(assignee,n=>n.tag==='option').map(o=>o.textContent),['All assignees','Unassigned','alex (me)','robin']);
 assert.deepEqual(nodes(nodes(root,n=>n.attrs['aria-label']==='All labels')[0],n=>n.tag==='option').map(o=>o.attrs.value),['','ui']);
 gets.length=0;assignee.listeners.change({target:{value:'robin'}});await flush();
 assert.ok(gets[0].includes('assignee=robin'));assert.ok(root.textContent.includes('Inline')&&!root.textContent.includes('Other'));
 buttonText(root,'Clear filters').listeners.click();await flush();assert.ok(root.textContent.includes('Other'));assert.ok(!buttonText(root,'Clear filters'));
 gets.length=0;nodes(root,n=>n.tag==='button'&&n.textContent.startsWith('In progress'))[0].listeners.click();await flush();
 assert.ok(gets[0].includes('status=in-progress'),'a stat tile is a quick filter');assert.ok(root.textContent.includes('Inline')&&!root.textContent.includes('Other'));
 // A reader sees the status as text, with nothing to change.
 const reader=trackerView({canWrite:false},'items');document.body.append(reader);await flush();assert.equal(nodes(reader,n=>n.tag==='select'&&/^Status of/.test(n.attrs['aria-label']||'')).length,0);
});
test('tickets UI: the assignee field suggests people, text has a preview, history reads as a timeline, dates follow the site',async t=>{
 dom(t);setSite({timeZone:'Pacific/Auckland'});t.after(()=>setSite({timeZone:null}));
 const at='2026-01-05T11:30:00.000Z',ticket={id:'HH-1',project:'home-hub',title:'Dated',description:'See **HH-2**',type:'task',status:'open',priority:'normal',release:null,assignee:null,labels:[],refs:[],reporter:'alex',createdAt:at,updatedAt:at,closedAt:null,rev:1,
  comments:[],attachments:[{id:'11111111-1111-4111-8111-111111111111',name:'shot.png',type:'image/png',size:2048,sha256:'a'.repeat(64),by:'alex',at}],history:[{at,by:'alex',field:'created',from:null,to:'open'},{at,by:'alex',field:'attachment',from:null,to:'shot.png'}]};
 globalThis.fetch=async url=>Response.json(url==='/api/tickets/people'?{people:[{name:'robin',kind:'user',assigned:2,active:1},{name:'agent-one',kind:'agent',assigned:0,active:0}]}
  :url.startsWith('/api/tickets/')?ticket:{...EMPTY,projects:[{id:'home-hub',key:'HH',name:'Home Hub',rev:1}]});
 const root=trackerView({canWrite:true,username:'alex'},'items','HH-1');document.body.append(root);await flush();
 buttonText(root,'Edit').listeners.click();
 const input=byName(root,'assignee'),list=nodes(root,n=>n.tag==='datalist')[0];
 assert.equal(input.attrs.list,list.attrs.id);assert.deepEqual(nodes(list,n=>n.tag==='option').map(o=>o.attrs.value),['alex','robin','agent-one'],'me first, then the hub\'s people');
 assert.ok(buttonText(root,'Take it'),'one click assigns the item to me');
 assert.ok(root.textContent.includes('6 Jan 2026, 00:30'),'dates are shown in the site\'s time zone, in the reader\'s language');
 assert.deepEqual(nodes(root,n=>(n.attrs.class||'').split(' ').includes('tk-event')).map(n=>nodes(n,x=>x.tag==='b')[0].textContent),['Attachment added: shot.png','Item created'],'history, newest first');
 assert.equal(nodes(root,n=>n.tag==='img'&&n.attrs.src==='/api/tickets/HH-1/attachments/11111111-1111-4111-8111-111111111111').length,1,'an image attachment has a preview');
 // Preview of the comment being written: rendered Markdown, the ticket id a link; an empty box is not previewed.
 // (the open edit form above has a preview of its own; the comment box's is the last one)
 const box=byName(root,'text'),toggle=nodes(root,n=>n.tag==='button'&&n.textContent==='Preview').at(-1);
 toggle.listeners.click();assert.equal(box.hidden,undefined,'nothing to preview yet');
 box.value='Fixed in **HH-2**';toggle.listeners.click();assert.equal(box.hidden,true);
 const preview=nodes(root,n=>(n.attrs.class||'')==='tk-md-preview'&&n.children.length)[0];
 assert.equal(nodes(preview,n=>n.tag==='strong').length,1);assert.equal(nodes(preview,n=>n.tag==='a')[0].attrs.href,'#items/HH-2');
 toggle.listeners.click();assert.equal(box.hidden,false);assert.equal(box.value,'Fixed in **HH-2**');
 setLang('cs');t.after(()=>setLang('en'));
 const cs=trackerView({canWrite:false},'items','HH-1');document.body.append(cs);await flush();
 assert.ok(cs.textContent.includes('Historie změn')&&!cs.textContent.includes('6 Jan 2026'),'another language, another date format');assert.match(cs.textContent,/6\. .*2026/);
});

// Files: the new-item dialog collects them and uploads them once the item exists; the item's page shows them
// under the description and as chips in the text. (The chip editor itself needs a real browser; here the
// textarea is the editor and holds the ![name] tokens.)
const PNG_BYTES=Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,1,2,3]);
const picture=(name='image.png')=>new File([PNG_BYTES],name,{type:'image/png'});
const withClass=(root,name)=>nodes(root,n=>(n.attrs.class||'').split(/\s+/).includes(name));
test('tickets UI: a new item takes pasted and dropped files, shows them, and uploads them once it exists',async t=>{
 dom(t);const {s}=await store(t);const calls=[];
 globalThis.fetch=async(url,options={})=>{
  if(options.method==='POST'){const made=await s.create(JSON.parse(options.body),'ui');calls.push(['POST',url,made.description]);return Response.json(made,{status:201});}
  if(options.method==='PUT'){
   const name=new URL(url,'http://hub.test').searchParams.get('name');calls.push(['PUT',url,options.body.size]);
   if(name.startsWith('broken'))return Response.json({error:{message:'Soubor je příliš velký (nejvýš 100 MB).'}},{status:413});
   return Response.json(await s.attach('HH-1',{sha256:'a'.repeat(64),size:options.body.size,type:'image/png',name},'ui'),{status:201});
  }
  return Response.json(url==='/api/tickets/people'?{people:[]}:url.startsWith('/api/tickets/HH-')?await s.get('HH-1'):await s.list());
 };
 const root=trackerView({canWrite:true},'items');document.body.append(root);await flush();
 nodes(root,n=>n.tag==='button'&&n.textContent==='+ New item')[0].listeners.click();await flush();
 const dialog=nodes(document.body,n=>n.tag==='dialog')[0],area=byName(dialog,'description'),title=byName(dialog,'title');
 const tiles=()=>withClass(dialog,'tk-tile-name').map(n=>n.textContent),status=()=>nodes(dialog,n=>n.attrs.role==='status')[0];
 const paste=(target,files,types=['Files'])=>{let taken=false;dialog.listeners.paste({clipboardData:{files,types},target,preventDefault(){taken=true;}});return taken;};
 assert.equal(nodes(dialog,n=>n.tag==='hr').length,1,'a divider after the fields');assert.ok(dialog.textContent.includes('Attachments (0)'));assert.deepEqual(tiles(),[]);
 // A screenshot pasted into the description: a tile, and its token where the caret is.
 area.value='See  for the glitch';area.selectionStart=area.selectionEnd=4;area.focus();
 assert.equal(paste(area,[picture()]),true);assert.equal(area.value,'See ![image.png]  for the glitch');assert.deepEqual(tiles(),['image.png']);
 // Pasted anywhere else it is attached without a place in the text; every pasted picture is "image.png", so the second gets its own name.
 assert.equal(paste(title,[picture()]),true);assert.equal(area.value,'See ![image.png]  for the glitch');assert.deepEqual(tiles(),['image.png','image-2.png']);
 // Text from an office application stays a paste of text.
 assert.equal(paste(area,[picture()],['text/plain','text/html','Files']),false);assert.equal(paste(area,[],['text/plain']),false);assert.deepEqual(tiles(),['image.png','image-2.png']);
 // Dropped files; an empty one is refused with a reason, and a drag of text is not a file drop.
 const drop=(files,types=['Files'])=>{let taken=false;dialog.listeners.drop({target:dialog,dataTransfer:{types,files},preventDefault(){taken=true;}});return taken;};
 assert.equal(drop([new File(['oops'],'broken [1].txt'),new File([],'empty.bin'),new File(['RIFF'],'beep.wav',{type:'audio/wav'})]),true);
 assert.deepEqual(tiles(),['image.png','image-2.png','broken (1).txt','beep.wav']);assert.ok(status().textContent.includes('empty.bin: the file is empty.'));
 assert.equal(drop([],['text/plain']),false);
 assert.ok(dialog.textContent.includes('Attachments (4)'));
 assert.equal(withClass(dialog,'tk-tile').map(n=>n.attrs.class).join(),'tk-tile image,tk-tile image,tk-tile text,tk-tile audio');
 // A tile opens its file in the viewer (a second dialog, on top), × takes the file away again, and with it its token.
 withClass(dialog,'tk-tile-open')[0].listeners.click();
 const viewer=nodes(document.body,n=>n.tag==='dialog'&&n.attrs.class.includes('tk-lightbox'))[0];assert.match(nodes(viewer,n=>n.tag==='img')[0].attrs.src,/^blob:/);
 buttonText(viewer,'Close').listeners.click();assert.equal(nodes(document.body,n=>n.tag==='dialog').length,1);
 withClass(dialog,'tk-tile-x')[1].listeners.click({currentTarget:{}});assert.deepEqual(tiles(),['image.png','broken (1).txt','beep.wav']);
 area.value+=' ![beep.wav] ';withClass(dialog,'tk-tile-x')[2].listeners.click({currentTarget:{}});assert.deepEqual(tiles(),['image.png','broken (1).txt']);assert.ok(!area.value.includes('beep.wav'));
 // Create: the item first, then each file to it under the name its token carries; what failed is said on the item's page.
 const fields={project:{value:'home-hub'},title:{value:'With files'},description:area,type:{value:'bug'},priority:{value:'normal'},release:{value:''},assignee:{value:''},labels:{value:''},querySelector:()=>({disabled:false})};
 await nodes(dialog,n=>n.tag==='form')[0].listeners.submit({preventDefault(){},currentTarget:fields});await flush();
 assert.deepEqual(calls,[['POST','/api/tickets','See ![image.png]  for the glitch'],['PUT','/api/tickets/HH-1/attachments?name=image.png',PNG_BYTES.length],['PUT','/api/tickets/HH-1/attachments?name=broken%20(1).txt',4]]);
 assert.equal(location.hash,'#items/HH-1');assert.equal(nodes(document.body,n=>n.tag==='dialog').length,0);
 // A view of the item that never reached the screen (the user had already moved on) does not use the notice up.
 trackerView({canWrite:true},'items','HH-1');await flush();
 const page=trackerView({canWrite:true},'items','HH-1');document.body.append(page);await flush();
 const said=nodes(page,n=>n.attrs.role==='status')[0];assert.match(said.textContent,/these attachments did not upload: broken \(1\)\.txt \(The file is too large \(100 MB at most\)\.\)/);assert.ok(said.classList.contains('error'));
 assert.deepEqual(withClass(page,'tk-tile-name').map(n=>n.textContent),['image.png']);assert.equal(withClass(page,'tk-fchip')[0].attrs['data-file'],'image.png','the token is the file\'s chip now');
 // Said once: the next visit to the item does not repeat it.
 const again=trackerView({canWrite:true},'items','HH-1');document.body.append(again);await flush();assert.equal(nodes(again,n=>n.attrs.role==='status')[0].textContent,'');
});

test('tickets UI: an item shows its files under the description; ![name] is a chip; files come and go on the page',async t=>{
 dom(t);const {s}=await store(t);
 const made=await s.create({project:'home-hub',title:'Files',description:'Before ![shot.png] then ![gone.png] and ![never.png].'},'alex');
 const file=(name,type)=>({sha256:(name.length%10+'').repeat(64),size:2048,type,name});
 await s.attach(made.id,file('shot.png','image/png'),'alex');await s.attach(made.id,file('clip.mp4','video/mp4'),'alex');
 const extra=await s.attach(made.id,file('gone.png','image/png'),'alex');await s.detach({id:made.id,attachment:extra.attachments.at(-1).id},'alex');
 await s.comment({id:made.id,text:'Watch ![clip.mp4]'},'alex');
 const calls=[];globalThis.fetch=async(url,options={})=>{
  if(options.method==='PUT'){const name=new URL(url,'http://hub.test').searchParams.get('name');calls.push(['PUT',name]);if(name==='refused.png')return Response.json({error:{message:'Byl dosažen limit počtu záznamů.'}},{status:409});
   return Response.json(await s.attach(made.id,{sha256:'b'.repeat(64),size:options.body.size,type:'image/png',name},'ui'),{status:201});}
  if(options.method==='POST'){const body=JSON.parse(options.body);calls.push(['POST',url]);return Response.json(url.endsWith('/delete')?(await s.detach(body,'ui')).ticket:await s.update(body,'ui'));}
  return Response.json(url==='/api/tickets/people'?{people:[]}:url.startsWith('/api/tickets/HH-')?await s.get(made.id):await s.list());
 };
 const root=trackerView({canWrite:true},'items',made.id);document.body.append(root);await flush();
 const card=()=>withClass(root,'tk-desc')[0],chips=n=>withClass(n,'tk-fchip').map(c=>[c.attrs['data-file'],c.attrs.class,c.attrs.role||'']),names=()=>withClass(root,'tk-tile-name').map(n=>n.textContent);
 // The description card: the text, a divider, then the files as tiles with × each.
 assert.deepEqual(card().children.map(n=>n.tag),['h3','div','hr','div']);assert.ok(card().textContent.includes('Attachments (2)'));assert.deepEqual(names(),['shot.png','clip.mp4']);
 assert.equal(withClass(card(),'tk-tile-x').length,2);assert.ok(buttonText(card(),'+ Add file'));
 assert.equal(nodes(card(),n=>n.tag==='img'&&n.attrs.src?.startsWith(`/api/tickets/${made.id}/attachments/`)).length,2,'the tile and the chip of the picture');
 // In the text: a file's chip, a struck-through one for a file that was taken away, and plain text for a name the item never had.
 assert.deepEqual(chips(card()),[['shot.png','tk-fchip','button'],['gone.png','tk-fchip gone','']]);assert.ok(card().textContent.includes('![never.png]'));
 assert.deepEqual(chips(withClass(root,'tk-comment')[0]),[['clip.mp4','tk-fchip','button']],'comments too');
 // A chip and a tile open the viewer on that file.
 withClass(card(),'tk-fchip')[0].listeners.click({preventDefault(){}});
 let viewer=nodes(document.body,n=>n.tag==='dialog')[0];assert.ok(nodes(viewer,n=>n.tag==='img')[0].attrs.src.includes('/attachments/'));assert.match(viewer.textContent,/shot\.png · 2 kB · alex · just now · 1\/2/,'the file, its size, who attached it and when');
 buttonText(viewer,'Close').listeners.click();
 withClass(card(),'tk-tile-open')[1].listeners.click();viewer=nodes(document.body,n=>n.tag==='dialog')[0];
 assert.equal(nodes(viewer,n=>n.tag==='video').length,1);assert.deepEqual(nodes(viewer,n=>n.tag==='a').map(a=>a.textContent),['Download']);buttonText(viewer,'Close').listeners.click();
 assert.equal(nodes(document.body,n=>n.tag==='dialog').length,0);
 // Files dropped on the card go up one by one; a refused one says why and the next one still goes.
 root.listeners.drop({target:card(),dataTransfer:{types:['Files'],files:[picture('refused.png'),picture('shot.png')]},preventDefault(){}});await flush();await flush();
 assert.deepEqual(calls,[['PUT','refused.png'],['PUT','shot-2.png']],'a second shot.png gets a name of its own');assert.deepEqual(names(),['shot.png','clip.mp4','shot-2.png']);
 const told=()=>nodes(root,n=>n.attrs.role==='status')[0];
 assert.equal(told().textContent,'refused.png: The record limit has been reached.','the later file that was saved does not cover it');assert.ok(told().classList.contains('error'));
 // × asks first, then removes the file; its chip in the text now says it is gone.
 const asked=[];globalThis.confirm=q=>{asked.push(q);return asked.length>1;};t.after(()=>{delete globalThis.confirm;});
 const x=()=>withClass(card(),'tk-tile-x')[0];x().listeners.click({currentTarget:x()});await flush();assert.deepEqual(names(),['shot.png','clip.mp4','shot-2.png'],'kept when the answer is no');
 await x().listeners.click({currentTarget:x()});await flush();assert.deepEqual(asked,['Remove the attachment shot.png?','Remove the attachment shot.png?']);
 assert.deepEqual(names(),['clip.mp4','shot-2.png']);assert.deepEqual(chips(card()).map(c=>c[1]),['tk-fchip gone','tk-fchip gone']);
 // While editing, the form holds the description and the files: the text field keeps the tokens.
 buttonText(root,'Edit').listeners.click();
 const form=nodes(root,n=>n.tag==='form'&&n.textContent.startsWith('Edit'))[0];assert.equal(withClass(root,'tk-desc').length,0);
 assert.equal(nodes(form,n=>n.tag==='hr').length,1);assert.deepEqual(withClass(form,'tk-tile-name').map(n=>n.textContent),['clip.mp4','shot-2.png']);
 assert.equal(byName(root,'description').value,'Before ![shot.png] then ![gone.png] and ![never.png].');
 // A file that finishes uploading re-draws the page: the keyboard stays in the field it was in, with what was typed there.
 byName(root,'labels').value='typing';byName(root,'labels').focus();
 root.listeners.drop({target:root,dataTransfer:{types:['Files'],files:[picture('while-typing.png')]},preventDefault(){}});await flush();await flush();
 assert.deepEqual(withClass(root,'tk-tile-name').map(n=>n.textContent),['clip.mp4','shot-2.png','while-typing.png']);
 assert.equal(document.activeElement,byName(root,'labels'));assert.equal(byName(root,'labels').value,'typing');
 // Files handed over keep going up after the page is left; one that fails then is said on the next visit.
 calls.length=0;root.listeners.drop({target:root,dataTransfer:{types:['Files'],files:[picture('one.png'),picture('refused.png'),picture('two.png')]},preventDefault(){}});
 root.remove();await flush();await flush();await flush();
 assert.deepEqual(calls,[['PUT','one.png'],['PUT','refused.png'],['PUT','two.png']]);assert.deepEqual((await s.get(made.id)).attachments.map(a=>a.name).slice(-2),['one.png','two.png']);
 const back=trackerView({canWrite:true},'items',made.id);document.body.append(back);await flush();
 assert.equal(nodes(back,n=>n.attrs.role==='status')[0].textContent,'refused.png: The record limit has been reached.');back.remove();
 // A reader sees the files but cannot add or remove one; an item without files shows no empty section.
 const reader=trackerView({canWrite:false},'items',made.id);document.body.append(reader);await flush();
 assert.deepEqual(withClass(reader,'tk-tile-name').map(n=>n.textContent),['clip.mp4','shot-2.png','while-typing.png','one.png','two.png']);assert.equal(withClass(reader,'tk-tile-x').length,0);assert.equal(buttonText(reader,'+ Add file'),undefined);assert.ok(!reader.textContent.includes('Paste from the clipboard'));
 const bare=await s.create({project:'home-hub',title:'No files'},'alex');globalThis.fetch=async url=>Response.json(url==='/api/tickets/people'?{people:[]}:url.startsWith('/api/tickets/HH-')?await s.get(bare.id):await s.list());
 const empty=trackerView({canWrite:false},'items',bare.id);document.body.append(empty);await flush();
 assert.equal(nodes(empty,n=>n.tag==='hr').length,0);assert.ok(!empty.textContent.includes('Attachments'));
});
