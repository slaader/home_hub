// Tracker and search additions: ticket full-text search with field filters, the names the assignee field
// suggests, what /api/search says about its hits and its index, messages by caller, and a hub.db written by an
// earlier version that must load unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {openDb} from '../server/db.mjs';
import {createTicketStore} from '../server/tickets-store.mjs';
import {createReviewStore} from '../server/review-store.mjs';
import {MCP_TOOLS} from '../server/mcp.mjs';
import {hub} from './hub-helper.mjs';

const SEED=[{id:'home-hub',key:'HH',name:'Home Hub',type:'app'},{id:'sample-game',key:'GAME',name:'Sample Game',type:'game'}];
async function tmp(t,prefix='tracker-search-'){const dir=await mkdtemp(path.join(os.tmpdir(),prefix));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
const strip=s=>s.replace(/[\u0001\u0002]/g,'');

test('ticket search: words anywhere in a ticket, narrowed by the list filters, ranked, limited',async t=>{
 const dir=await tmp(t),db=openDb(path.join(dir,'hub.db'));t.after(()=>db.close());
 const s=createTicketStore(dir,{db,seedProjects:SEED});
 await s.saveRelease({project:'home-hub',version:'1.0'},'alex');
 const a=await s.create({project:'home-hub',title:'Login times out',type:'bug',assignee:'alex',labels:['auth'],release:'1.0'},'alex');
 const b=await s.create({project:'home-hub',title:'Settings page',description:'The login form needs a timeout hint.',labels:['ui']},'robin');
 const c=await s.create({project:'sample-game',title:'Menu music'},'robin');
 await s.comment({id:c.id,text:'Loops badly after login to the lobby.'},'sam');
 await s.update({id:b.id,rev:1,status:'done'},'robin');

 const all=await s.search({q:'login'});
 assert.equal(all.tickets[0].id,a.id,'a title hit ranks first');
 assert.deepEqual(all.tickets.map(x=>x.id).sort(),[c.id,a.id,b.id].sort(),'the description and a comment are searched too');
 assert.equal(all.total,3);assert.equal(all.q,'login');
 assert.ok(all.tickets.every(x=>typeof x.score==='number'&&typeof x.comments==='number'&&!('history'in x)),'hits are list summaries');
 const inComment=all.tickets.find(x=>x.id===c.id);
 assert.match(strip(inComment.snippet),/login to the lobby/i);assert.match(inComment.snippet,/\u0001login\u0002/i,'matched words are marked');
 assert.deepEqual((await s.search({q:'log',status:'active'})).tickets.map(x=>x.id).sort(),[c.id,a.id].sort(),'prefix match, status filter');
 assert.deepEqual((await s.search({q:'login',project:'sample-game'})).tickets.map(x=>x.id),[c.id]);
 assert.deepEqual((await s.search({q:'login',assignee:'alex'})).tickets.map(x=>x.id),[a.id]);
 assert.deepEqual((await s.search({q:'login',assignee:'none',status:'done'})).tickets.map(x=>x.id),[b.id]);
 assert.deepEqual((await s.search({q:'login',label:'ui'})).tickets.map(x=>x.id),[b.id]);
 assert.deepEqual((await s.search({q:'login',release:'1.0'})).tickets.map(x=>x.id),[a.id]);
 assert.deepEqual((await s.search({q:'login',type:'bug',priority:'normal'})).tickets.map(x=>x.id),[a.id]);
 const one=await s.search({q:'login',limit:1});assert.equal(one.tickets.length,1);assert.equal(one.total,3,'total counts every match');
 assert.deepEqual((await s.search({q:'nothinglikethis'})).tickets,[]);
 for(const bad of [{},{q:''},{q:'  '},{q:'"*'},{q:'x'.repeat(201)},{q:'a',limit:0},{q:'a',limit:101},{q:'a',status:'nope'},{q:'a',type:'epic'},{q:'a',project:'Bad Id'},{q:'a',extra:1},{q:['a']}])
  await assert.rejects(s.search(bad),/invalid/,JSON.stringify(bad));
});

test('people: assignees with their load first, then reporters and comment authors',async t=>{
 const dir=await tmp(t),db=openDb(path.join(dir,'hub.db'));t.after(()=>db.close());
 const s=createTicketStore(dir,{db,seedProjects:SEED});
 assert.deepEqual(await s.people(),[]);
 const a=await s.create({project:'home-hub',title:'One',assignee:'robin'},'alex');
 await s.create({project:'home-hub',title:'Two',assignee:'robin',status:'done'},'alex');
 await s.create({project:'home-hub',title:'Three',assignee:'sam'},'alex');
 await s.comment({id:a.id,text:'noted'},'agent-one');
 assert.deepEqual(await s.people(),[{name:'robin',assigned:2,active:1},{name:'sam',assigned:1,active:1},{name:'agent-one',assigned:0,active:0},{name:'alex',assigned:0,active:0}]);
});

test('HTTP: people, ticket search, and what /api/search tells about its hits and its index',async t=>{
 const h=await hub(t),get=(url,headers=h.admin)=>fetch(h.origin+url,{headers});
 assert.equal((await fetch(h.origin+'/api/tickets/people')).status,401);assert.equal((await fetch(h.origin+'/api/tickets/search?q=x')).status,401);
 const empty=await (await get('/api/search?q=')).json();
 assert.deepEqual(empty.indexed,{ticket:0,review:0},'an empty hub says there is nothing to search yet');assert.deepEqual(empty.results,[]);
 const agent=await h.account('dev-agent',['tickets:write']),reader=await h.account('reader',[]);
 const one=await (await h.post('/api/tickets',{project:'home-hub',title:'Export fails on large files',type:'bug',assignee:'dev-agent',priority:'high'},h.admin)).json();
 const two=await (await h.post('/api/tickets',{project:'home-hub',title:'Second ticket',description:'Mentions HH-1 and the export.'},h.admin)).json();
 assert.equal(one.id,'HH-1');

 const people=(await (await get('/api/tickets/people',reader.headers)).json()).people;
 assert.deepEqual(people[0],{name:'dev-agent',kind:'agent',assigned:1,active:1},'the busiest assignee first; a service account is an agent');
 assert.ok(people.some(p=>p.name==='admin'&&p.kind==='user')&&people.some(p=>p.name==='reader'&&p.kind==='agent'));
 assert.ok(people.every(p=>Object.keys(p).sort().join()==='active,assigned,kind,name'),'names and counts only: no ids, roles or scopes');
 await h.post('/api/admin/accounts/action',{id:reader.account.id,disabled:true},h.admin);
 assert.ok(!(await (await get('/api/tickets/people')).json()).people.some(p=>p.name==='reader'),'a disabled account is not suggested');

 const found=await (await get('/api/tickets/search?q=export&priority=high',agent.headers)).json();
 assert.deepEqual(found.tickets.map(x=>x.id),[one.id]);assert.equal(found.tickets[0].assignee,'dev-agent');
 assert.equal((await get('/api/tickets/search?q=export&status=nope')).status,400);assert.equal((await get('/api/tickets/search')).status,400);
 // A session gets the Czech source text (the UI translates it); an API key gets English.
 assert.match((await (await get('/api/tickets/search?q=')).json()).error.message,/Neplatný požadavek/);
 assert.match((await (await get('/api/tickets/search?q=',agent.headers)).json()).error.message,/^Invalid ticket request/);
 assert.match((await (await get('/api/search?q=a&kind=user',agent.headers)).json()).error.message,/^Invalid search/);
 assert.match((await (await get('/api/review/sets/R-999',agent.headers)).json()).error.message,/^The review does not exist/);
 assert.match((await (await get('/api/review/sets/R-999')).json()).error.message,/^Review neexistuje/);

 const hits=await (await get('/api/search?q=export')).json();
 assert.deepEqual(hits.indexed,{ticket:2,review:0});
 assert.deepEqual(hits.results[0].meta,{status:'open',type:'bug',priority:'high',assignee:'dev-agent',release:null});
 assert.deepEqual((await (await get('/api/search?q=HH-1')).json()).results.map(x=>x.id),['HH-1','HH-2'],'a query that is an id puts that record first');
 assert.equal((await (await get('/api/search?q=hh-2')).json()).results[0].id,two.id);

 // A review set is described too: its state and how far its latest round is decided.
 const html='<!doctype html><title>x</title><p>Export dialog</p>';
 const set=await (await h.post('/api/review/publish',{project:'home-hub',title:'Export dialog',items:[{id:'dialog',title:'Dialog',kind:'html',variants:[{id:'a',media:[{type:'text/html',html}]},{id:'b',media:[{type:'text/html',html:html+' '}]}]}]},h.admin)).json();
 const review=(await (await get('/api/search?q=dialog&kind=review')).json()).results[0];
 assert.equal(review.id,set.id);assert.deepEqual(review.meta,{status:'open',done:false,feedbackPending:false,round:1,items:1,decided:0});
});

test('MCP: ticket_search is a read tool with the list filters; descriptions carry no project of ours',async t=>{
 const h=await hub(t),reader=await h.account('reader',[]);
 await h.post('/api/tickets',{project:'home-hub',title:'Rotate the backup key',labels:['ops'],status:'in-progress'},h.admin);
 await h.post('/api/tickets',{project:'sample-game',title:'Backup of saves'},h.admin);
 let n=0;const rpc=async(method,params)=>(await (await fetch(h.origin+'/mcp',{method:'POST',headers:{...reader.headers,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++n,method,params})})).json()).result;
 const call=(name,args)=>rpc('tools/call',{name,arguments:args});
 const tools=(await rpc('tools/list')).tools,tool=tools.find(x=>x.name==='ticket_search');
 assert.ok(tool,'listed for a key that only reads');assert.deepEqual(tool.inputSchema.required,['query']);assert.equal(tool.inputSchema.additionalProperties,false);assert.equal(tool.annotations.readOnlyHint,true);
 const all=await call('ticket_search',{query:'backup'});assert.equal(all.isError,false);assert.deepEqual(all.structuredContent.tickets.map(x=>x.id).sort(),['GAME-1','HH-1']);
 assert.deepEqual((await call('ticket_search',{query:'backup',status:'active',label:'ops'})).structuredContent.tickets.map(x=>x.id),['HH-1']);
 assert.deepEqual((await call('ticket_search',{query:'backup',project:'sample-game',limit:1})).structuredContent.tickets.map(x=>x.id),['GAME-1']);
 for(const bad of [{},{query:''},{query:'x',limit:500},{query:'x',limit:'2'},{query:'x',q:'y'},{query:'x',status:'nope'}]){
  const out=await call('ticket_search',bad);assert.equal(out.isError,true,JSON.stringify(bad));assert.match(out.content[0].text,/^Invalid ticket search/);}
 const audit=await (await fetch(h.origin+'/api/admin/audit',{headers:h.admin})).json();
 assert.ok(!audit.events.some(e=>e.event==='mcp-call'),'reading is not logged');
 // Tool texts are for any hub: no ticket ids, project names or people of one household.
 const texts=JSON.stringify([...MCP_TOOLS.filter(x=>/^(ticket|tickets|release|project|review|search)/.test(x.name)),tool]);
 assert.doesNotMatch(texts,/\bHH-\d|home-hub|\bOB-?\d|ob1|claude|codex|Přihlášení/i);
 assert.match((await rpc('initialize',{protocolVersion:'2025-06-18'})).instructions,/ticket_search/);
});

test('compatibility: a hub.db written before attachments, search stats and this code loads unchanged',async t=>{
 const dir=await tmp(t),file=path.join(dir,'hub.db');
 // The shape an earlier version left behind: schema 1, a ticket without the attachments field, a review set,
 // and a search index built by a version that did not record its index version.
 const {DatabaseSync}=process.getBuiltinModule('node:sqlite'),raw=new DatabaseSync(file);
 raw.exec(`CREATE TABLE meta(kind TEXT PRIMARY KEY, doc TEXT NOT NULL);
  CREATE TABLE docs(kind TEXT NOT NULL, coll TEXT NOT NULL, id TEXT NOT NULL, doc TEXT NOT NULL, PRIMARY KEY(kind,coll,id));
  CREATE TABLE sessions(hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, password_at TEXT, until INTEGER NOT NULL);
  CREATE INDEX sessions_until ON sessions(until);
  CREATE TABLE search_version(kind TEXT PRIMARY KEY, version INTEGER NOT NULL);
  CREATE VIRTUAL TABLE search USING fts5(kind UNINDEXED, id UNINDEXED, project UNINDEXED, updated UNINDEXED, title, body, tokenize='unicode61 remove_diacritics 2', prefix='2 3');
  PRAGMA user_version=1;`);
 const at='2026-01-05T10:00:00.000Z';
 const project={id:'legacy-app',key:'LEG',name:'Legacy App',description:'',createdAt:null,rev:1,next:3},seeded={id:'home-hub',key:'HH',name:'Home Hub',description:'',createdAt:null,rev:1,next:1,type:'app'};
 const ticket={id:'LEG-1',project:'legacy-app',title:'Old ticket',description:'Written before attachments existed.',type:'task',status:'open',priority:'normal',release:'0.9',assignee:'robin',labels:['old'],refs:[],reporter:'alex',
  createdAt:at,updatedAt:at,closedAt:null,rev:1,comments:[{id:'c1',at,by:'sam',text:'still relevant'}],history:[{at,by:'alex',field:'created',from:null,to:'open'}]};
 const other={...ticket,id:'LEG-2',title:'Untouched ticket',comments:[],release:null};
 const release={project:'legacy-app',version:'0.9',status:'planned',targetDate:null,releasedAt:null,notes:'',createdAt:at,createdBy:'alex',rev:1,updatedAt:at};
 const sha='a'.repeat(64),set={id:'R-1',project:'legacy-app',title:'Old review',description:'',tickets:['LEG-1'],status:'open',createdAt:at,createdBy:'agent',updatedAt:at,rev:1,
  rounds:[{n:1,notes:'first round',addresses:[],publishedAt:at,publishedBy:'agent',items:[{id:'screen',title:'Screen',description:'',kind:'html',mode:'choose',variants:[{id:'a',label:'A',title:'',description:'',media:[{sha256:sha,type:'text/html',name:'',caption:'',viewport:{width:1280,height:800},size:10}]}]}],feedback:{}}]};
 const put=raw.prepare('INSERT INTO docs(kind,coll,id,doc) VALUES(?,?,?,?)'),meta=raw.prepare('INSERT INTO meta(kind,doc) VALUES(?,?)');
 meta.run('tickets',JSON.stringify({schema:1,revision:7,updatedAt:at}));meta.run('review',JSON.stringify({schema:1,next:2,updatedAt:at}));
 put.run('tickets','projects','home-hub',JSON.stringify(seeded));put.run('tickets','projects','legacy-app',JSON.stringify(project));
 put.run('tickets','releases','legacy-app/0.9',JSON.stringify(release));put.run('tickets','tickets','LEG-1',JSON.stringify(ticket));put.run('tickets','tickets','LEG-2',JSON.stringify(other));
 put.run('review','sets','R-1',JSON.stringify(set));put.run('review','blobs',sha,JSON.stringify({type:'text/html',size:10}));
 raw.close();

 const db=openDb(file);t.after(()=>db.close());
 // Seeds in the site file never replace or add to what the database already holds.
 const s=createTicketStore(dir,{db,seedProjects:[{id:'another',key:'ANO',name:'Another'}]});
 const review=createReviewStore(path.join(dir,'review'),{tickets:s,db});
 const list=await s.list();
 assert.deepEqual(list.projects.map(p=>p.id),['home-hub','legacy-app'],'existing projects stay, a new seed is not applied');
 assert.deepEqual(list.tickets.map(x=>x.id).sort(),['LEG-1','LEG-2']);assert.equal(list.releases[0].counts.open,1);
 const got=await s.get('LEG-1');assert.deepEqual(got.attachments,[],'a ticket from before attachments reads as having none');assert.equal(got.comments[0].text,'still relevant');
 assert.deepEqual((await review.list({status:'all'})).sets.map(x=>x.id),['R-1']);assert.equal((await review.get('R-1')).rounds[0].notes,'first round');
 // The index of an older version is rebuilt on first use, and every new read works on the old rows.
 assert.deepEqual(db.search({q:'relevant'}).results.map(x=>x.id),['LEG-1']);assert.deepEqual(db.search({q:'old review'}).results.map(x=>x.id),['R-1']);
 assert.deepEqual(db.searchStats(),{ticket:2,review:1});
 assert.deepEqual((await s.search({q:'attachments',assignee:'robin'})).tickets.map(x=>x.id).sort(),['LEG-1','LEG-2']);
 assert.deepEqual((await s.people()).map(p=>p.name),['robin','alex','sam']);
 // New work continues the numbering, and rows nobody changed keep their exact bytes.
 const made=await s.create({project:'legacy-app',title:'New after upgrade'},'alex');assert.equal(made.id,'LEG-3');
 await s.comment({id:'LEG-1',text:'after the upgrade'},'alex');
 const row=id=>db.db.prepare('SELECT doc FROM docs WHERE kind=? AND coll=? AND id=?').get('tickets','tickets',id).doc;
 assert.equal(row('LEG-2'),JSON.stringify(other),'an untouched ticket is byte-identical');
 assert.equal(db.db.prepare('SELECT doc FROM docs WHERE kind=? AND id=?').get('review','R-1').doc,JSON.stringify(set),'an untouched review set is byte-identical');
 assert.equal(db.db.prepare('PRAGMA user_version').get().user_version,1,'no schema change');
 assert.deepEqual(db.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'search_%' ORDER BY name").all().map(r=>r.name),['docs','meta','search','sessions']);
});
