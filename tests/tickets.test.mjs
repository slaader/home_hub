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
 constructor(tag,text=''){this.tag=tag;this.text=text;this.children=[];this.attrs={};this.listeners={};this.style={};this._value=undefined;this.classList={add:c=>{this.attrs.class=(this.attrs.class||'')+' '+c;}};}
 setAttribute(k,v){this.attrs[k]=String(v);if(k==='value')this.value=v;}
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
 globalThis.Node=TrackerNode;globalThis.document={createElement:tag=>new TrackerNode(tag),createTextNode:text=>new TrackerNode('#text',text),activeElement:null};
 document.body=new TrackerNode('body');document.activeElement=document.body;globalThis.location={hash:'#items'};setPrincipal({username:'ui-writer',role:'admin'});
 t.after(()=>{setPrincipal(null);Object.assign(globalThis,saved);});
}

test('tickets UI: late filter replies cannot replace newer results or steal focus',async t=>{
 dom(t);const authEvents=[];globalThis.dispatchEvent=e=>authEvents.push(e.type);const {s}=await store(t);await s.saveRelease({project:'home-hub',version:'1'},'a');await s.saveRelease({project:'sample-game',version:'1'},'a');const base=await s.list(),pending=[];
 globalThis.fetch=url=>new Promise(resolve=>pending.push({url,resolve}));
 const root=trackerView({canWrite:true},'items');document.body.append(root);
 const reply=(p,title)=>p.resolve(Response.json({...base,tickets:title?[{id:'HH-1',title,status:'open',type:'bug',priority:'normal',labels:[],release:null,assignee:null,comments:0,updatedAt:new Date().toISOString()}]:[],total:title?1:0}));
 pending.splice(0).forEach(p=>reply(p));await flush();
 const status=nodes(root,n=>n.attrs['aria-label']==='Všechny stavy')[0];assert.ok(status);
 const releaseFilter=nodes(root,n=>n.attrs['aria-label']==='Všechny releasy')[0];assert.equal(nodes(releaseFilter,n=>n.tag==='option'&&n.attrs.value==='1').length,1);
 status.listeners.change({target:{value:'done'}});const old=pending.splice(0);
 status.focus();status.listeners.change({target:{value:'open'}});const newest=pending.splice(0);newest.forEach(p=>reply(p,'Newest result'));await flush();
 assert.ok(root.textContent.includes('Newest result'));assert.equal(document.activeElement.getAttribute('aria-label'),'Všechny stavy');
 old[0].resolve(Response.json({error:{message:'Stale failure'}},{status:503}));reply(old[1],'Old result');await flush();
 assert.ok(root.textContent.includes('Newest result'));assert.ok(!root.textContent.includes('Stale failure'));
 // A delayed response also must not repopulate an old session's view.
 const project=nodes(root,n=>n.tag==='button'&&n.textContent==='Home Hub')[0];project.listeners.click();const abandoned=pending.splice(0);
 setPrincipal(null);setPrincipal({username:'ui-next',role:'viewer'});abandoned[0].resolve(Response.json({error:{message:'Old session expired'}},{status:401}));reply(abandoned[1],'Old account');await flush();assert.ok(!root.textContent.includes('Old account'));assert.deepEqual(authEvents,[]);
 setPrincipal({username:'ui-reader',role:'viewer'});
 const reader=trackerView({canWrite:false},'items');document.body.append(reader);const reset=pending.splice(0);
 assert.ok(reset.every(p=>!p.url.includes('project=')&&!p.url.includes('status=open')));reset.forEach(p=>reply(p));await flush();
 assert.ok(!reader.textContent.includes('+ Nová položka'));
});

test('tickets UI: session reset closes dialogs and discards a pending dialog load',async t=>{
 dom(t);const {s}=await store(t);const data=await s.list();globalThis.fetch=async()=>Response.json(data);
 const root=trackerView({canWrite:true},'projects');document.body.append(root);await flush();
 const add=()=>nodes(root,n=>n.tag==='button'&&n.textContent==='+ Nová položka')[0].listeners.click();
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
 const edit=nodes(root,n=>n.tag==='form'&&n.textContent.startsWith('Upravit'))[0];assert.ok(edit);
 const fields=Object.fromEntries(['title','description','type','status','priority','release','assignee','labels','refs'].map(k=>[k,{value:Array.isArray(ticket[k])?ticket[k].join(k==='refs'?'\n':', '):ticket[k]||''}]));fields.priority.value='high';fields.querySelector=()=>({disabled:false});
 edit.listeners.submit({preventDefault(){},currentTarget:fields});await flush();
 assert.deepEqual(posts[0].body,{id:ticket.id,rev:1,priority:'high'});assert.equal((await s.get(ticket.id)).description,ticket.description);
 const comment=nodes(root,n=>n.tag==='form'&&n.textContent.includes('Přidat komentář'))[0],button={disabled:false},text={value:'ž'.repeat(8000)};
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
 byName(root,'text').value='half-written comment';byName(root,'description').value='new description draft';
 const start=buttonText(root,'Začít');await start.listeners.click({currentTarget:start});await flush();
 assert.equal((await s.get(ticket.id)).status,'in-progress');assert.equal(gets,before,'no refetch after a write');
 assert.equal(byName(root,'text').value,'half-written comment');assert.equal(byName(root,'description').value,'new description draft');
 assert.equal(byName(root,'status').value,'in-progress');assert.equal((await s.get(ticket.id)).description,'old');
});
test('tickets UI: a saved comment clears its box even when every later read fails',async t=>{
 dom(t);const {s}=await store(t);const ticket=await s.create({project:'home-hub',title:'No duplicates'},'a');let down=false;
 globalThis.fetch=async(url,options={})=>{if(options.method==='POST')return Response.json(await s.comment(JSON.parse(options.body),'ui'));if(down)return Response.json({error:{message:'down'}},{status:503});return Response.json(url.startsWith('/api/tickets/')?await s.get(ticket.id):await s.list());};
 const root=trackerView({canWrite:true},'items',ticket.id);document.body.append(root);await flush();down=true;
 byName(root,'description').value='kept edit';const form=nodes(root,n=>n.tag==='form'&&n.textContent.includes('Přidat komentář'))[0],button={disabled:false};
 await form.listeners.submit({preventDefault(){},currentTarget:{text:{value:'only once'},querySelector:()=>button}});await flush();
 assert.equal((await s.get(ticket.id)).comments.length,1);assert.ok(root.textContent.includes('only once'));
 assert.equal(byName(root,'text').value,'');assert.equal(byName(root,'description').value,'kept edit');assert.ok(!root.textContent.includes('down'));
});
test('tickets UI: a release action shows the saved state when the follow-up refresh fails',async t=>{
 dom(t);const {s}=await store(t);await s.saveRelease({project:'home-hub',version:'2.4'},'a');let down=false;
 globalThis.fetch=async(url,options={})=>{if(options.method==='POST')return Response.json(await s.saveRelease(JSON.parse(options.body),'ui'));if(down)return Response.json({error:{message:'down'}},{status:503});return Response.json(await s.list());};
 const root=trackerView({canWrite:true},'releases');document.body.append(root);await flush();down=true;
 const mark=buttonText(root,'Označit jako vydané');await mark.listeners.click({currentTarget:mark});await flush();
 assert.equal((await s.list()).releases[0].status,'released');
 const back=buttonText(root,'Vrátit do plánu');assert.ok(back);assert.ok(!back.disabled);assert.ok(root.textContent.includes('nepodařilo obnovit'));
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
