// Provenance: every data endpoint says where its data comes from, derived from what the records carry
// (verified_by stamps, authors, collector snapshots, the router adapter), never from a per-page constant.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {hub} from './hub-helper.mjs';
import {provenance,inventoryProvenance,authorKinds,authoredProvenance,collectorSource,PROVENANCE_KINDS} from '../server/provenance.mjs';
import {collectorRun,readRun} from '../server/collector-run.mjs';
import {collectorState} from '../server/collector-state.mjs';
import {routerProvenance,normalizeRouter,ROUTER_ADAPTERS} from '../server/router-data.mjs';
import {ticketAuthors} from '../server/tickets-store.mjs';
import {setAuthors} from '../server/review-store.mjs';

const get=async(h,url,headers=h.admin)=>{const r=await fetch(h.origin+url,{headers});return {status:r.status,body:await r.json()};};
const kindsOf=p=>p.kinds.map(k=>k.kind);

test('provenance(): one kind, mixed or none; fields are bounded and unknown kinds dropped',()=>{
 assert.deepEqual(provenance([]),{kind:'none',kinds:[],lastAt:null,summary:'No data yet.'});
 const one=provenance([{kind:'collector',source:'scripts/collect-systems.mjs',lastAt:'2026-11-08T12:00:00.000Z',count:3,unit:'machines',state:'ok',intervalSeconds:21600,schedule:{trigger:'scheduled',scheduler:'launchd',label:'local.home-hub.systems-collect'}}]);
 assert.equal(one.kind,'collector');assert.equal(one.lastAt,'2026-11-08T12:00:00.000Z');
 assert.match(one.summary,/^Collected by a job \(scripts\/collect-systems\.mjs\), 3 machines, scheduled by launchd, last 2026-11-08T12:00:00\.000Z\.$/);
 const mixed=provenance([{kind:'agent',count:2,unit:'entries',accounts:['codex','codex','claude'],lastAt:'2026-11-08'},{kind:'manual',count:1,unit:'entries',lastAt:'2026-11-09'},null,{kind:'nonsense',count:9}]);
 assert.equal(mixed.summary,'Written by agents, 2 entries, codex, claude, last 2026-11-08; edited by hand, 1 entry, last 2026-11-09.','one is singular');
 assert.equal(mixed.kind,'mixed');assert.deepEqual(kindsOf(mixed),['agent','manual']);assert.deepEqual(mixed.kinds[0].accounts,['codex','claude']);assert.equal(mixed.lastAt,'2026-11-09');
 // Two sources of one kind are still one kind (two collectors behind one page).
 assert.equal(provenance([{kind:'collector',id:'a'},{kind:'collector',id:'b'}]).kind,'collector');
 const bounded=provenance([{kind:'agent',accounts:Array.from({length:12},(_,i)=>`a${i}`),detail:'x'.repeat(500),count:-1,unit:'entries',lastAt:'not a date',schedule:{trigger:'whenever'},extra:'dropped'}]).kinds[0];
 assert.equal(bounded.accounts.length,8);assert.equal(bounded.accountsMore,4);assert.equal(bounded.detail.length,160);
 for(const gone of ['count','unit','lastAt','schedule','extra'])assert.equal(gone in bounded,false,gone);
 assert.deepEqual(PROVENANCE_KINDS,['manual','agent','config','collector','telemetry','plugin','other']);
});

test('inventory: the verified_by stamp of each entry decides manual, agent (with the account) or other',async t=>{
 const entries=[{verified_by:'user edit in Home Hub',verified_at:'2026-11-03'},{verified_by:'Home Hub API · codex',verified_at:'2026-11-08'},{verified_by:'Home Hub API · codex',verified_at:'2026-11-05'},
  {verified_by:'Home Hub API · claude',verified_at:'2026-11-01'},{verified_by:'Home Hub API',verified_at:'2026-10-01'},{verified_by:'imported from the old hub',verified_at:'2026-09-01'},{verified_at:'2026-11-09'}];
 const p=inventoryProvenance(entries);
 assert.equal(p.kind,'mixed');assert.deepEqual(p.kinds.map(k=>[k.kind,k.count,k.unit]),[['agent',4,'entries'],['other',2,'entries'],['manual',1,'entries']]);
 assert.deepEqual(p.kinds[0].accounts,['codex','claude']);assert.equal(p.kinds[0].lastAt,'2026-11-08');
 assert.equal(p.kinds[1].detail,'imported from the old hub (1), no stamp (1)');assert.equal(p.lastAt,'2026-11-09');
 assert.equal(inventoryProvenance([{verified_by:'user edit in Home Hub'}]).kind,'manual');assert.equal(inventoryProvenance([]).kind,'none');

 // Over HTTP: the fixture entries carry no stamp; a person's edit and an agent's write change the answer.
 const h=await hub(t),agent=await h.account('codex',['inventory:write']);
 const before=await get(h,'/api/inventory');assert.equal(before.body.provenance.kind,'other');assert.equal(before.body.provenance.kinds[0].count,2);
 assert.equal((await h.post('/api/inventory/entry',{id:'studio',base:before.body.hashes.studio,fields:{notes:'checked by hand'}},h.admin)).status,200);
 assert.equal((await h.post('/api/inventory/entries',{entry:{id:'studio-ollama',kind:'runtime',machine:'studio',name:'Ollama',address:'127.0.0.1:11434'}},agent.headers)).status,200);
 const after=(await get(h,'/api/inventory')).body.provenance;
 assert.equal(after.kind,'mixed');assert.deepEqual(after.kinds.map(k=>[k.kind,k.count]).sort(),[['agent',1],['manual',1],['other',1]]);
 assert.deepEqual(after.kinds.find(k=>k.kind==='agent').accounts,['codex']);
 // The services catalog answers for its own entries only: the untouched fixture service and the agent's.
 const services=(await get(h,'/api/services')).body;assert.equal(services.services.length,2);
 assert.deepEqual(services.provenance.kinds.map(k=>[k.kind,k.count]).sort(),[['agent',1],['other',1]]);
});

test('authors: people, service accounts and the native app are told apart; a name nobody carries is other',()=>{
 const store={users:()=>[{username:'admin'},{username:'alice'}],accounts:()=>[{name:'codex'}],keys:()=>[{name:'old-script'}]};
 const kind=authorKinds(store);
 assert.deepEqual(['admin','alice','codex','old-script','Native device','gone','',null].map(kind),['manual','manual','agent','agent','manual','other',null,null]);
 const p=authoredProvenance(store,{created:[['codex','2026-11-08T10:00:00.000Z'],['codex','2026-11-08T11:00:00.000Z'],['alice','2026-11-07T10:00:00.000Z'],['gone','2026-10-01T00:00:00.000Z']],
  changes:[['admin','2026-11-09T09:00:00.000Z'],['codex','2026-11-08T12:00:00.000Z']]},{extra:[{kind:'config',source:'site.json → tracker.projects',count:2,unit:'items'}]});
 assert.equal(p.kind,'mixed');
 assert.deepEqual(p.kinds.map(k=>[k.kind,k.count,k.changes]),[['agent',2,1],['manual',1,1],['other',1,undefined],['config',2,undefined]]);
 assert.deepEqual(p.kinds[0].accounts,['codex']);assert.deepEqual(p.kinds[1].people,['alice','admin']);assert.equal(p.kinds[2].detail,'gone');
 assert.equal(p.lastAt,'2026-11-09T09:00:00.000Z');
 // A store that cannot be read classifies nothing as a person or an agent, and never throws.
 assert.equal(authorKinds({users(){throw new Error('x');}})('admin'),'other');assert.equal(authorKinds(null)('admin'),'other');
 // A source that only changed records has no count of its own.
 assert.deepEqual(authoredProvenance(store,{created:[],changes:[['admin','2026-11-09T09:00:00.000Z']]}).kinds,[{kind:'manual',changes:1,lastAt:'2026-11-09T09:00:00.000Z',people:['admin']}]);
 assert.deepEqual(ticketAuthors({reporter:'a',createdAt:'t0',history:[{field:'created',by:'a',at:'t0'},{field:'status',by:'b',at:'t1'}],comments:[{by:'c',at:'t2'}]}),{created:[['a','t0']],changes:[['b','t1'],['c','t2']]});
 assert.deepEqual(setAuthors({rounds:[{publishedBy:'a',publishedAt:'t0',feedback:{x:{updatedBy:'b',updatedAt:'t1',comments:[{by:'b',at:'t1'}]}}},{publishedBy:'a',publishedAt:'t2',feedback:{}}]}),
  {created:[['a','t0'],['a','t2']],changes:[['b','t1'],['b','t1']]});
});

test('tracker and review over HTTP: seeded projects are configuration; tickets and rounds name who wrote them',async t=>{
 const h=await hub(t),agent=await h.account('codex',['tickets:write','review:write']);
 // A new tracker holds only the projects the site configuration seeded.
 const empty=(await get(h,'/api/tickets')).body.provenance;
 assert.deepEqual(empty.kinds,[{kind:'config',source:'site.json → tracker.projects',count:2,unit:'projects'}]);assert.equal(empty.kind,'config');
 assert.equal((await get(h,'/api/review?status=all')).body.provenance.kind,'none');
 const made=await (await h.post('/api/tickets',{project:'home-hub',title:'Filed by an agent'},agent.headers)).json();
 assert.equal(made.provenance.kind,'agent','a write answers with the ticket and its provenance');
 assert.equal((await h.post('/api/tickets',{project:'home-hub',title:'Filed by a person'},h.admin)).status,201);
 const changed=await (await h.post('/api/tickets/update',{id:'HH-1',rev:1,status:'in-progress'},h.admin)).json();
 assert.deepEqual(changed.provenance.kinds.map(k=>[k.kind,k.count,k.changes]),[['agent',1,undefined],['manual',undefined,1]]);
 await h.post('/api/tickets/comment',{id:'HH-1',text:'on it'},agent.headers);
 const one=(await get(h,'/api/tickets/HH-1')).body.provenance;
 assert.equal(one.kind,'mixed');assert.deepEqual(one.kinds.map(k=>[k.kind,k.count,k.changes]),[['agent',1,1],['manual',undefined,1]]);
 assert.deepEqual(one.kinds[0].accounts,['codex']);assert.deepEqual(one.kinds[1].people,['admin']);
 const list=(await get(h,'/api/tickets')).body;
 assert.deepEqual(list.provenance.kinds.map(k=>[k.kind,k.count,k.changes]),[['agent',1,1],['manual',1,1],['config',2,undefined]]);
 assert.deepEqual(list.provenance.kinds.map(k=>k.unit),['records','records','projects'],'the list counts projects, releases and items together; seeds are projects');
 // The project filter narrows it (the other project holds only its seed); the status filter does not.
 assert.deepEqual(kindsOf((await get(h,'/api/tickets?project=sample-game')).body.provenance),['config']);
 assert.deepEqual((await get(h,'/api/tickets?status=done')).body.provenance,list.provenance);
 assert.equal('authors' in list,false,'the raw author list stays inside the server');
 // A release or a project is answered as before.
 const release=await (await h.post('/api/tickets/releases',{project:'home-hub',version:'1.0'},h.admin)).json();assert.equal('provenance' in release,false);

 // Review: an agent publishes, a person decides.
 const html=Buffer.from('<!doctype html><title>x</title><p>mock</p>'),sha=(await import('node:crypto')).createHash('sha256').update(html).digest('hex');
 assert.equal((await fetch(`${h.origin}/api/review/blobs/${sha}?offset=0&size=${html.length}`,{method:'PUT',headers:{'Content-Type':'application/octet-stream',...agent.headers},body:html})).status,201);
 const pub=await h.post('/api/review/publish',{project:'home-hub',title:'Header',items:[{id:'head',title:'Header',kind:'html',variants:[{id:'a',media:[{sha256:sha,type:'text/html'}]}]}]},agent.headers);assert.equal(pub.status,201);
 assert.deepEqual((await get(h,'/api/review')).body.provenance.kinds.map(k=>[k.kind,k.count,k.unit]),[['agent',1,'rounds']]);
 assert.equal((await h.post('/api/review/feedback',{set:'R-1',round:1,item:'head',rev:0,variant:'a',status:'accept'},h.admin)).status,200);
 const set=(await get(h,'/api/review/sets/R-1')).body;
 assert.equal(set.provenance.kind,'mixed');assert.deepEqual(set.provenance.kinds.map(k=>[k.kind,k.count,k.changes]),[['agent',1,undefined],['manual',undefined,1]]);
 assert.equal(set.rounds.length,1,'the set itself is unchanged');
 assert.deepEqual(kindsOf((await get(h,'/api/review?status=all')).body.provenance),['agent','manual']);
});

test('collector runs: launchd and systemd are scheduled, a terminal is by hand, anything else is not said',()=>{
 assert.deepEqual(collectorRun({env:{XPC_SERVICE_NAME:'local.home-hub.systems-collect'},tty:false}),{trigger:'scheduled',scheduler:'launchd',label:'local.home-hub.systems-collect'});
 assert.deepEqual(collectorRun({env:{XPC_SERVICE_NAME:'application.com.apple.Terminal.1234'},tty:true}),{trigger:'manual'});
 assert.deepEqual(collectorRun({env:{XPC_SERVICE_NAME:'0'},tty:true}),{trigger:'manual'});
 assert.equal(collectorRun({env:{XPC_SERVICE_NAME:'0'},tty:false}),null,'a pipe or another tool: not knowable');
 assert.equal(collectorRun({env:{XPC_SERVICE_NAME:'application.com.example.app'},tty:false}),null);
 assert.deepEqual(collectorRun({env:{INVOCATION_ID:'abc',HOME_HUB_UNIT:'home-hub-systems-collect.service'},tty:false}),{trigger:'scheduled',scheduler:'systemd',label:'home-hub-systems-collect.service'});
 assert.deepEqual(collectorRun({env:{INVOCATION_ID:'abc'},tty:false}),{trigger:'scheduled',scheduler:'systemd'});
 assert.deepEqual(collectorRun({env:{INVOCATION_ID:'abc'},tty:true}),{trigger:'manual'},'a shell inside a terminal unit is still a person');
 // What a snapshot holds is read back in the same shape; anything else is "not recorded".
 assert.deepEqual(readRun({trigger:'scheduled',scheduler:'launchd',label:'a.b',extra:1}),{trigger:'scheduled',scheduler:'launchd',label:'a.b'});
 assert.deepEqual(readRun({trigger:'manual',label:'x'}),{trigger:'manual'});
 for(const bad of [null,undefined,'launchd',{trigger:'cron'},{}])assert.equal(readRun(bad),null);
 assert.deepEqual(readRun({trigger:'scheduled',scheduler:'cron',label:'bad label'}),{trigger:'scheduled'});
 const state=collectorState('systems',{configured:true,collectedAt:'2026-11-08T12:00:00.000Z',now:Date.parse('2026-11-08T13:00:00Z')});
 assert.deepEqual(collectorSource(state,{id:'systems',run:{trigger:'manual'},count:2,unit:'machines',host:'studio'}),
  {kind:'collector',id:'systems',source:'scripts/collect-systems.mjs',state:'ok',intervalSeconds:21600,lastAt:'2026-11-08T12:00:00.000Z',count:2,unit:'machines',schedule:{trigger:'manual'},host:'studio'});
});

test('collector pages over HTTP: the collector with its state before a snapshot, then when it ran and who started it',async t=>{
 const h=await hub(t,{softwareWatchFile:path.join((await import('node:os')).tmpdir(),'hub-prov-none.json')});
 const none=await get(h,'/api/systems');assert.equal(none.status,404);
 assert.deepEqual(none.body.provenance.kinds,[{kind:'collector',id:'systems',source:'scripts/collect-systems.mjs',state:'waiting',intervalSeconds:21600}]);
 assert.equal(none.body.provenance.lastAt,null);
 const noKeys=await get(h,'/api/security');assert.equal(noKeys.status,404);assert.equal(noKeys.body.provenance.kinds[0].state,'waiting');assert.equal(noKeys.body.provenance.kinds[0].source,'scripts/collect-security.mjs');
 const at=new Date(Date.now()-3600e3).toISOString();
 await mkdir(path.join(h.dir,'systems'),{recursive:true});await mkdir(path.join(h.dir,'security'),{recursive:true});
 await writeFile(path.join(h.dir,'systems','snapshot.json'),JSON.stringify({schemaVersion:1,collectedAt:at,collectedFrom:'studio',run:{trigger:'scheduled',scheduler:'launchd',label:'local.home-hub.systems-collect'},machines:{}}));
 await writeFile(path.join(h.dir,'security','ssh-keys.json'),JSON.stringify({schemaVersion:1,collectedAt:at,collectedFrom:'studio',run:{trigger:'manual'},machines:[{id:'mini',reachable:true},{id:'nas',reachable:false}],keys:[],otherKeys:[],unknownAuthorized:[],forgejo:null,findings:[]}));
 const systems=(await get(h,'/api/systems')).body;
 assert.deepEqual(systems.provenance.kinds,[{kind:'collector',id:'systems',source:'scripts/collect-systems.mjs',host:'studio',state:'ok',count:0,intervalSeconds:21600,unit:'machines',lastAt:at,schedule:{trigger:'scheduled',scheduler:'launchd',label:'local.home-hub.systems-collect'}}]);
 assert.equal(systems.provenance.kind,'collector');assert.equal(systems.provenance.lastAt,at);
 const keys=(await get(h,'/api/security')).body.provenance.kinds[0];
 assert.deepEqual([keys.kind,keys.state,keys.count,keys.unit,keys.host,keys.schedule],['collector','ok',1,'machines','studio',{trigger:'manual'}]);
 // A snapshot from before the stamp existed says nothing about how it was started.
 await writeFile(path.join(h.dir,'systems','snapshot.json'),JSON.stringify({schemaVersion:1,collectedAt:at,machines:{}}));
 assert.equal('schedule' in (await get(h,'/api/systems')).body.provenance.kinds[0],false);

 // With a watch list: the release check and the list file are sources of their own, each with an id.
 const dir=path.join(h.dir,'watch');await mkdir(dir,{recursive:true});
 const file=path.join(dir,'software-watch.json');
 await writeFile(file,JSON.stringify({schemaVersion:1,categories:{infra:'Infra'},items:[{id:'node',name:'Node.js',category:'infra',upstream:{type:'node'},detect:{mini:{kind:'brew',formula:'node'}}}]}));
 const w=await hub(t,{softwareWatchFile:file});
 await mkdir(path.join(w.dir,'systems'),{recursive:true});
 await writeFile(path.join(w.dir,'systems','snapshot.json'),JSON.stringify({schemaVersion:1,collectedAt:at,machines:{}}));
 await writeFile(path.join(w.dir,'systems','upstream.json'),JSON.stringify({schemaVersion:2,checkedAt:at,run:{trigger:'manual'},results:{'node:':{ok:true,version:'24.0.0',checkedAt:at}}}));
 const watched=(await get(w,'/api/systems')).body.provenance;
 assert.equal(watched.kind,'mixed');assert.deepEqual(watched.kinds.map(k=>[k.kind,k.id]),[['collector','systems'],['collector','upstream'],['config','watch']]);
 assert.deepEqual([watched.kinds[1].source,watched.kinds[1].count,watched.kinds[1].unit,watched.kinds[1].schedule],['scripts/check-upstream.mjs',1,'sources',{trigger:'manual'}]);
 assert.deepEqual([watched.kinds[2].source,watched.kinds[2].count,watched.kinds[2].unit],['software-watch.json',1,'items']);
 assert.deepEqual((await get(w,'/api/software-watch')).body.provenance.kinds,[{kind:'config',id:'watch',source:'software-watch.json',count:1,unit:'items'}]);
 assert.equal((await get(h,'/api/software-watch')).body.provenance.kind,'none');
});

test('router: the included adapter is a collector, a plugin adapter is a plugin, no adapter is no data',async t=>{
 const now=Date.parse('2026-11-08T12:01:00Z'),raw={status:'ok',observedAt:'2026-11-08T12:00:00.000Z',devices:[{mac:'aa:bb:cc:dd:ee:01',ip:'10.0.0.20',name:'printer',connection:'Ethernet',presence:'reachable'}]};
 const unifi=routerProvenance(normalizeRouter(raw,{adapter:ROUTER_ADAPTERS.unifi,now}));
 assert.deepEqual(unifi.kinds,[{kind:'collector',id:'unifi',source:'scripts/collect-router-unifi.py',detail:'UniFi Network',state:'ok',count:1,intervalSeconds:60,unit:'clients',lastAt:'2026-11-08T12:00:00.000Z'}]);
 const other=routerProvenance(normalizeRouter(raw,{adapter:{id:'mikrotik',title:'MikroTik'},now}));
 assert.deepEqual([other.kind,other.kinds[0].source,other.kinds[0].detail],['plugin','mikrotik','MikroTik']);
 assert.equal(routerProvenance(normalizeRouter(null)).kind,'none');
 const h=await hub(t);assert.equal((await get(h,'/api/router')).body.provenance.kind,'none');
});
