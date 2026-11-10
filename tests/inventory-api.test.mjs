// The inventory's write API beyond single entries: the schema as data, delete, bulk upsert (all or nothing,
// per-entry hash, dry run), an empty hub's first write, and the same through the MCP tools
// inventory_describe, inventory_delete and inventory_bulk_upsert. Also what must never change: the hash of
// an entry nobody touched, and the shapes old files and old clients use.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,rm,access} from 'node:fs/promises';
import path from 'node:path';
import {hub,knowledge} from './hub-helper.mjs';
import {entryHash} from '../scripts/knowledge-edit.mjs';
import {LIMITS} from '../public/inventory-rules.js';

const rpc=(h,headers,method,params)=>fetch(h.origin+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',...headers},body:JSON.stringify({jsonrpc:'2.0',id:1,method,...(params?{params}:{})})});
const call=async(h,headers,name,args={})=>(await (await rpc(h,headers,'tools/call',{name,arguments:args})).json()).result;
const onDisk=async h=>JSON.parse(await readFile(path.join(h.dir,'knowledge.json'),'utf8'));
const get=async(h,url,headers)=>{const r=await fetch(h.origin+url,{headers});return {status:r.status,body:await r.json().catch(()=>null)};};
const post=async(h,url,body,headers)=>{const r=await h.post(url,body,headers);return {status:r.status,body:await r.json().catch(()=>null)};};
const today=()=>new Date().toISOString().slice(0,10);
const service=(id,extra={})=>({id,kind:'runtime',machine:'studio',name:id,address:'127.0.0.1:9000',...extra});

test('an entry hash is sha256 of the stored JSON and survives writes to its neighbours',async t=>{
 // Pinned literals: agents hold these hashes, so the function behind them must never change.
 const gw={id:'gw',kind:'runtime',machine:'mini',name:'Gateway',address:':8790',verified_at:'2026-11-01',secrets:[{what:'Voice token',store:'keychain:mini',ref:'local-ai.gateway.voice-token'}],depends_on:[{id:'sync',kind:'cert'}]};
 assert.equal(entryHash(gw),'dba93cdb75cd5f0e6f9c1dff692997889209ccd9ddb53b65ddefc2447fb69591');
 const odd={id:'odd',kind:'tool',machine:'mini',name:'Odd',address:null,data:null,verified_at:'2026-11-01'};
 assert.equal(entryHash(odd),'43f038643374a196319a237127ee4519652a7c737e28aee882fc881cfbbd92dd');
 const h=await hub(t);
 // The old shape: a top-level field the hub does not know, null where text is "not recorded", keys in the author's order.
 const old={schema:1,updated_at:'2026-11-01',about:'written by hand',entries:[{id:'mini',kind:'machine',name:'Mac mini',verified_at:'2026-11-01'},gw,{id:'sync',kind:'tool',machine:'mini',name:'Cert sync',verified_at:'2026-11-01'},odd]};
 await writeFile(path.join(h.dir,'knowledge.json'),JSON.stringify(old));
 const before=await get(h,'/api/inventory',h.admin);
 assert.equal(before.status,200,'the old shape loads unchanged');assert.deepEqual(Object.keys(before.body),['doc','gaps','hashes'],'the read API keeps its fields');
 assert.equal(before.body.hashes.gw,entryHash(gw));assert.equal(before.body.hashes.odd,entryHash(odd));
 // Every kind of write to other entries: a field edit, a whole-entry put, a bulk upsert, a delete.
 assert.equal((await post(h,'/api/inventory/entry',{id:'sync',base:before.body.hashes.sync,fields:{version:'2'}},h.admin)).status,200);
 assert.equal((await post(h,'/api/inventory/entries',{entry:{id:'extra',kind:'tool',machine:'mini',name:'Extra'}},h.admin)).status,200);
 assert.equal((await post(h,'/api/inventory/bulk',{entries:[{entry:{id:'more',kind:'tool',machine:'mini',name:'More'}}]},h.admin)).status,200);
 const mid=await get(h,'/api/inventory',h.admin);
 assert.equal((await post(h,'/api/inventory/entries/delete',{id:'extra',base:mid.body.hashes.extra},h.admin)).status,200);
 const after=await get(h,'/api/inventory',h.admin);
 assert.equal(after.body.hashes.gw,before.body.hashes.gw);assert.equal(after.body.hashes.odd,before.body.hashes.odd);assert.equal(after.body.hashes.mini,before.body.hashes.mini);
 const disk=await onDisk(h);
 assert.equal(disk.about,'written by hand','unknown top-level fields are kept');
 assert.deepEqual(disk.entries.find(e=>e.id==='odd'),odd,'an untouched entry is written back exactly as it was');
 assert.deepEqual(disk.entries.map(e=>e.id),['mini','gw','sync','odd','more'],'entries keep their order; new ones go last');
});

test('GET /api/inventory/schema describes the inventory with this site\'s places and stores',async t=>{
 const h=await hub(t),reader=await h.account('reader-schema',[]);
 assert.equal((await fetch(h.origin+'/api/inventory/schema')).status,401);
 const {status,body}=await get(h,'/api/inventory/schema',reader.headers);
 assert.equal(status,200,'a read key may fetch it');
 assert.deepEqual(body.kinds.map(k=>k.id),['network','machine','runtime','tool','model-store','secret-store','skill-store','external']);
 assert.equal(body.kinds.find(k=>k.id==='runtime').needsMachine,true);assert.equal(body.kinds.find(k=>k.id==='external').needsMachine,false);
 assert.deepEqual(body.linkKinds.map(k=>k.id),['call','cert','secret','data']);
 assert.ok(body.entry.fields.find(f=>f.name==='id').required&&body.entry.fields.find(f=>f.name==='depends_on'));
 const stores=body.secrets.stores.map(s=>s.store);
 for(const s of ['passwords-app','remembered','unknown','example-vault','keychain:<machine id>','file:<machine id>'])assert.ok(stores.includes(s),s);
 assert.deepEqual(body.places.filter(p=>p.source==='site').map(p=>p.id),['studio','mini','mini-server','nas','router','work-macbook'],'places from site.json');
 assert.ok(body.rules.some(r=>/never its value/.test(r))&&body.rules.length>=6);
 assert.equal(body.limits.bulkEntries,LIMITS.bulkEntries);assert.deepEqual(body.tools.write.tools,['inventory_update','inventory_bulk_upsert','inventory_delete']);
 assert.ok(body.examples.length>=4&&body.examples.every(e=>e.id.startsWith('example-')));
 // A machine entry the site did not list becomes a place too.
 assert.equal((await post(h,'/api/inventory/entries',{entry:{id:'garage-pi',kind:'machine',name:'Garage Pi'}},h.admin)).status,200);
 const again=(await get(h,'/api/inventory/schema',h.admin)).body;
 assert.deepEqual(again.places.filter(p=>p.source==='machine'),[{id:'garage-pi',label:'Garage Pi',source:'machine'}]);
});

test('bulk upsert: all or nothing, per-entry hash, unchanged entries, dry run and limits',async t=>{
 const h=await hub(t),agent=await h.account('agent-bulk',['inventory:write']),reader=await h.account('reader-bulk',[]);
 const start=await onDisk(h),swap=start.entries[1],base=entryHash(swap);
 const batch=[{entry:{id:'nas',kind:'machine',name:'NAS'}},{entry:service('nas-photos',{machine:'nas',depends_on:[{id:'studio-llama-swap',kind:'call'}]})},{entry:{...swap,version:'v200'},base}];
 assert.equal((await post(h,'/api/inventory/bulk',{entries:batch},reader.headers)).status,403,'a read key cannot write');
 assert.equal((await fetch(h.origin+'/api/inventory/bulk',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403,'a browser POST needs the origin');

 // Dry run: says what would happen and writes nothing.
 const dry=await post(h,'/api/inventory/bulk',{entries:batch,dryRun:true},agent.headers);
 assert.equal(dry.status,200);assert.equal(dry.body.ok,true);assert.equal(dry.body.dryRun,true);assert.deepEqual(dry.body.summary,{create:2,update:1,unchanged:0});
 assert.deepEqual(dry.body.entries.map(e=>[e.id,e.action]),[['nas','create'],['nas-photos','create'],['studio-llama-swap','update']]);
 assert.deepEqual(await onDisk(h),start,'a dry run leaves the file alone');

 // One invalid entry refuses the whole batch, with the checker's messages and structured issues.
 const bad=await post(h,'/api/inventory/bulk',{entries:[...batch,{entry:service('leaky',{notes:'password=hunter2hunter2'})}]},agent.headers);
 assert.equal(bad.status,422);assert.equal(bad.body.error.code,'INVENTORY_INVALID');assert.match(bad.body.error.details[0],/entry "leaky": notes looks like a secret value/);
 assert.deepEqual(bad.body.error.issues.map(i=>[i.id,i.field,i.code]),[['leaky','notes','secret-value']]);
 assert.deepEqual(await onDisk(h),start,'nothing of a refused batch is written');
 assert.ok(!JSON.stringify(await get(h,'/api/admin/audit',h.admin)).includes('hunter2'),'refused text never reaches the log');
 const dryBad=await post(h,'/api/inventory/bulk',{entries:[{entry:service('orphan',{machine:'nowhere'})}],dryRun:true},agent.headers);
 assert.equal(dryBad.status,200,'a dry run reports, it does not fail');assert.equal(dryBad.body.ok,false);assert.equal(dryBad.body.issues[0].code,'machine-required');

 // A stale or missing hash on one entry refuses the whole batch too.
 for(const entries of [[batch[0],{entry:{...swap,version:'v200'},base:'0'.repeat(64)}],[batch[0],{entry:{...swap,version:'v200'}}],[{entry:{id:'ghost',kind:'machine',name:'Ghost'},base}]]){
  const stale=await post(h,'/api/inventory/bulk',{entries},agent.headers);
  assert.equal(stale.status,409);assert.equal(stale.body.error.details.length,1);
 }
 assert.deepEqual((await post(h,'/api/inventory/bulk',{entries:[batch[2].entry].map(entry=>({entry})),dryRun:true},agent.headers)).body,{ok:false,dryRun:true,conflicts:['studio-llama-swap']});
 assert.deepEqual(await onDisk(h),start);

 // The real run: everything is written, stamped with the account, and entries may refer to each other.
 const done=await post(h,'/api/inventory/bulk',{entries:batch},agent.headers);
 assert.equal(done.status,200);assert.equal(done.body.published,true);assert.deepEqual(done.body.summary,{create:2,update:1,unchanged:0});
 const disk=await onDisk(h),photos=disk.entries.find(e=>e.id==='nas-photos');
 assert.equal(photos.verified_by,'Home Hub API · agent-bulk');assert.equal(photos.verified_at,today());assert.equal(photos.confidence,'verified');
 assert.equal(done.body.entries.find(e=>e.id==='nas-photos').hash,entryHash(photos),'the hash returned is the stored entry\'s');
 assert.equal(disk.entries.find(e=>e.id==='studio-llama-swap').version,'v200');assert.equal(entryHash(disk.entries[0]),entryHash(start.entries[0]),'the untouched machine keeps its hash');

 // Sending an entry exactly as stored (any key order) changes nothing and needs no hash.
 const {id,...rest}=photos,same=await post(h,'/api/inventory/bulk',{entries:[{entry:{...rest,id}}]},agent.headers);
 assert.equal(same.status,200);assert.deepEqual(same.body.summary,{create:0,update:0,unchanged:1});assert.equal(same.body.entries[0].hash,entryHash(photos));
 assert.deepEqual(await onDisk(h),disk,'an unchanged batch does not rewrite the file');

 // Shape and size limits.
 const many=Array.from({length:LIMITS.bulkEntries+1},(_,i)=>({entry:service(`svc-${i}`)}));
 for(const body of [{entries:[]},{entries:many},{entries:[batch[0],batch[0]]},{entries:[{entry:{id:'Bad Id',kind:'tool'}}]},{entries:[{entry:service('x',{surprise:1})}]},{entries:batch,dryRun:'yes'},{entries:batch,extra:1},{entries:[{entry:service('big',{notes:'n'.repeat(LIMITS.entryBytes)})}]}])
  assert.equal((await post(h,'/api/inventory/bulk',body,agent.headers)).status,400,JSON.stringify(body).slice(0,60));
 assert.equal((await post(h,'/api/inventory/bulk',{entries:Array.from({length:LIMITS.bulkEntries},(_,i)=>({entry:service(`svc-${i}`)})),dryRun:true},agent.headers)).body.summary.create,LIMITS.bulkEntries,'the limit itself is accepted');

 // Write log: one line per attempt with the route, status and a count, never the entries.
 const audit=(await get(h,'/api/admin/audit',h.admin)).body.events.filter(e=>e.event==='api-write'&&e.detail?.startsWith('/api/inventory/bulk'));
 assert.ok(audit.some(e=>e.detail==='/api/inventory/bulk · 3 entries'&&e.status===200));assert.ok(audit.some(e=>e.status===422)&&audit.some(e=>e.status===409)&&audit.some(e=>e.status===403));
});

test('an import keeps who verified an entry; an API key cannot ask for that; a person\'s writes are stamped as theirs',async t=>{
 const h=await hub(t),agent=await h.account('agent-import',['inventory:write']);
 const imported={id:'nas',kind:'machine',name:'NAS',verified_at:'2026-01-05',verified_by:'agent on the nas',confidence:'inferred'};
 const refused=await post(h,'/api/inventory/bulk',{entries:[{entry:imported}],keepVerified:true},agent.headers);
 assert.equal(refused.status,400);assert.match(refused.body.error.message,/keepVerified/);
 assert.equal((await post(h,'/api/inventory/bulk',{entries:[{entry:imported},{entry:{id:'pi',kind:'machine',name:'Pi'}}],keepVerified:true},h.admin)).status,200);
 const disk=await onDisk(h);
 assert.deepEqual(disk.entries.find(e=>e.id==='nas'),imported,'an imported entry is stored exactly as exported, so its hash carries over');
 assert.deepEqual(disk.entries.find(e=>e.id==='pi'),{id:'pi',kind:'machine',name:'Pi',verified_at:today(),verified_by:'user edit in Home Hub'},'missing stamps are filled in');
 assert.equal((await post(h,'/api/inventory/bulk',{entries:[{entry:{id:'desk',kind:'machine',name:'Desk'}}]},h.admin)).status,200);
 assert.equal((await onDisk(h)).entries.find(e=>e.id==='desk').verified_by,'user edit in Home Hub','a session write names a person, not the API');
});

test('delete: hash-checked, refused while something depends on the entry',async t=>{
 const h=await hub(t),agent=await h.account('agent-delete',['inventory:write']),reader=await h.account('reader-delete',[]);
 await post(h,'/api/inventory/bulk',{entries:[{entry:service('studio-proxy',{depends_on:[{id:'studio-llama-swap',kind:'call'}]})}]},agent.headers);
 const {hashes}=(await get(h,'/api/inventory',h.admin)).body;
 assert.equal((await post(h,'/api/inventory/entries/delete',{id:'studio-proxy',base:hashes['studio-proxy']},reader.headers)).status,403);
 const used=await post(h,'/api/inventory/entries/delete',{id:'studio-llama-swap',base:hashes['studio-llama-swap']},agent.headers);
 assert.equal(used.status,422);assert.equal(used.body.error.code,'INVENTORY_IN_USE');assert.deepEqual(used.body.error.details,['studio-proxy']);
 const machine=await post(h,'/api/inventory/entries/delete',{id:'studio',base:hashes.studio},agent.headers);
 assert.equal(machine.status,422);assert.deepEqual(machine.body.error.details,['studio-llama-swap','studio-proxy'],'what runs on a machine keeps it too');
 assert.equal((await post(h,'/api/inventory/entries/delete',{id:'studio-proxy',base:'0'.repeat(64)},agent.headers)).status,409,'a stale hash deletes nothing');
 for(const body of [{id:'studio-proxy'},{id:'studio-proxy',base:'short'},{id:'../x',base:hashes.studio},{id:'studio-proxy',base:hashes['studio-proxy'],force:true}])
  assert.equal((await post(h,'/api/inventory/entries/delete',body,agent.headers)).status,400,JSON.stringify(body));
 assert.equal((await onDisk(h)).entries.length,3);
 const gone=await post(h,'/api/inventory/entries/delete',{id:'studio-proxy',base:hashes['studio-proxy']},agent.headers);
 assert.deepEqual(gone,{status:200,body:{ok:true,published:true,id:'studio-proxy',deleted:true}});
 assert.equal((await post(h,'/api/inventory/entries/delete',{id:'studio-proxy',base:hashes['studio-proxy']},agent.headers)).status,404);
 assert.deepEqual((await onDisk(h)).entries.map(e=>e.id),['studio','studio-llama-swap']);
 assert.equal((await onDisk(h)).updated_at,today());
 assert.equal((await post(h,'/api/inventory/entries/delete',{id:'studio-llama-swap',base:hashes['studio-llama-swap']},agent.headers)).status,200,'with its dependent gone it can go');
});

test('the entry form may also move an entry to another machine and change what it depends on',async t=>{
 const h=await hub(t);
 await post(h,'/api/inventory/bulk',{entries:[{entry:{id:'mini',kind:'machine',name:'Mac mini'}},{entry:service('studio-proxy')}]},h.admin);
 const base=(await get(h,'/api/inventory',h.admin)).body.hashes['studio-proxy'];
 const edit=fields=>post(h,'/api/inventory/entry',{id:'studio-proxy',base,fields},h.admin);
 const moved=await edit({machine:'mini',depends_on:[{id:'studio-llama-swap',kind:'call',label:' forwards to '}]});
 assert.equal(moved.status,200);
 const entry=moved.body.doc.entries.find(e=>e.id==='studio-proxy');
 assert.equal(entry.machine,'mini');assert.deepEqual(entry.depends_on,[{id:'studio-llama-swap',kind:'call',label:'forwards to'}]);assert.equal(entry.verified_by,'user edit in Home Hub');
 const next=moved.body.hashes['studio-proxy'],again=fields=>post(h,'/api/inventory/entry',{id:'studio-proxy',base:next,fields},h.admin);
 const ghost=await again({depends_on:[{id:'ghost',kind:'call'}]});
 assert.equal(ghost.status,422);assert.deepEqual(ghost.body.error.issues.map(i=>[i.field,i.code]),[['depends_on[0].id','dep-missing']]);
 assert.equal((await again({machine:'nowhere'})).body.error.issues[0].code,'machine-required');
 assert.equal((await again({depends_on:[{id:'studio-proxy',kind:'call'}]})).body.error.issues[0].code,'dep-self');
 for(const fields of [{depends_on:'x'},{depends_on:[{id:'UPPER',kind:'call'}]},{depends_on:[{id:'mini',kind:'call',extra:1}]},{machine:'Not An Id'},{kind:'tool'},{id:'renamed'}])
  assert.equal((await again(fields)).status,400,JSON.stringify(fields));
 assert.equal((await again({depends_on:[]})).body.doc.entries.find(e=>e.id==='studio-proxy').depends_on,undefined,'an emptied list is removed');
});

test('a hub with no inventory file is an empty inventory that the first write creates',async t=>{
 const h=await hub(t),agent=await h.account('agent-first',['inventory:write']),file=path.join(h.dir,'knowledge.json');
 await rm(file);
 const missing=await get(h,'/api/inventory',h.admin);
 assert.equal(missing.status,404);assert.equal(missing.body.error.code,'INVENTORY_MISSING','the read API still says there is no file');
 assert.equal((await get(h,'/api/services',h.admin)).status,404);
 const schema=await get(h,'/api/inventory/schema',h.admin);assert.equal(schema.status,200);assert.deepEqual(schema.body.places.filter(p=>p.source==='machine'),[]);
 // An agent can look before it writes, instead of being told the inventory is not deployed.
 const found=await call(h,agent.headers,'inventory_search',{query:'anything'});
 assert.equal(found.isError,false);assert.equal(found.structuredContent.count,0);
 assert.equal((await call(h,agent.headers,'inventory_describe')).structuredContent.inventory.entries,0);
 await assert.rejects(access(file),'reading never creates the file');
 const first=await call(h,agent.headers,'inventory_update',{entry:{id:'server',kind:'machine',name:'Server'}});
 assert.equal(first.isError,false,first.content[0].text);
 const doc=await onDisk(h);
 assert.equal(doc.schema,1);assert.equal(doc.updated_at,today());assert.deepEqual(doc.entries.map(e=>e.id),['server']);
 assert.equal((await get(h,'/api/inventory',h.admin)).status,200);
 // A file that is not JSON is never treated as empty, and never overwritten.
 await writeFile(file,'{ not json');
 const broken=await get(h,'/api/inventory',h.admin);assert.equal(broken.status,500);assert.equal(broken.body.error.code,'INVENTORY_INVALID');
 assert.equal((await post(h,'/api/inventory/bulk',{entries:[{entry:{id:'x',kind:'machine',name:'X'}}]},h.admin)).status,503);
 assert.equal(await readFile(file,'utf8'),'{ not json');
 assert.equal((await call(h,agent.headers,'inventory_search',{query:'x'})).isError,true);
});

test('MCP: inventory_describe, inventory_bulk_upsert and inventory_delete follow scopes and the same rules',async t=>{
 const h=await hub(t),agent=await h.account('agent-mcp',['inventory:write']),reader=await h.account('reader-mcp',[]);
 const tools=(await (await rpc(h,agent.headers,'tools/list')).json()).result.tools;
 for(const name of ['inventory_describe','inventory_delete','inventory_bulk_upsert']){const tool=tools.find(x=>x.name===name);assert.ok(tool,name);assert.equal(tool.inputSchema.type,'object');assert.equal(tool.inputSchema.additionalProperties,false);assert.ok(!('scope'in tool)&&!('run'in tool)&&!('module'in tool));}
 assert.equal(tools.find(x=>x.name==='inventory_delete').annotations.destructiveHint,true);
 assert.deepEqual(tools.find(x=>x.name==='inventory_bulk_upsert').inputSchema.required,['entries']);
 const visible=(await (await rpc(h,reader.headers,'tools/list')).json()).result.tools.map(x=>x.name);
 assert.ok(visible.includes('inventory_describe')&&!visible.includes('inventory_delete')&&!visible.includes('inventory_bulk_upsert'));

 const described=await call(h,reader.headers,'inventory_describe');
 assert.equal(described.isError,false);assert.equal(described.structuredContent.inventory.entries,2);assert.equal(described.structuredContent.kinds.length,8);
 assert.ok(described.structuredContent.secrets.stores.some(s=>s.store==='example-vault'),'the site\'s own store is listed');
 assert.equal((await call(h,reader.headers,'inventory_describe',{verbose:true})).isError,true,'unknown arguments are refused');

 const batch=[{entry:{id:'nas',kind:'machine',name:'NAS'}},{entry:service('nas-photos',{machine:'nas'})}];
 const denied=await call(h,reader.headers,'inventory_bulk_upsert',{entries:batch});
 assert.equal(denied.isError,true);assert.match(denied.content[0].text,/inventory:write/);
 const dry=await call(h,agent.headers,'inventory_bulk_upsert',{entries:batch,dryRun:true});
 assert.equal(dry.isError,false);assert.deepEqual(dry.structuredContent.summary,{create:2,update:0,unchanged:0});assert.equal((await onDisk(h)).entries.length,2);
 const secret=await call(h,agent.headers,'inventory_bulk_upsert',{entries:[...batch,{entry:service('leaky',{login:'sk-abcdefghijklmnopqrstuv'})}]});
 assert.equal(secret.isError,true);assert.match(secret.content[0].text,/nothing was changed.*looks like a secret value/);assert.equal((await onDisk(h)).entries.length,2);
 const dryBad=await call(h,agent.headers,'inventory_bulk_upsert',{entries:[{entry:service('leaky',{login:'sk-abcdefghijklmnopqrstuv'})}],dryRun:true});
 assert.equal(dryBad.isError,false);assert.equal(dryBad.structuredContent.ok,false);assert.equal(dryBad.structuredContent.issues[0].code,'secret-value');
 for(const args of [{entries:[]},{entries:'x'},{entries:batch,dryRun:1},{entries:batch,keepVerified:true},{entries:[{entry:{id:'nas'},base:'nope'}]}])
  assert.equal((await call(h,agent.headers,'inventory_bulk_upsert',args)).isError,true,JSON.stringify(args).slice(0,50));
 const done=await call(h,agent.headers,'inventory_bulk_upsert',{entries:batch});
 assert.equal(done.isError,false,done.content[0].text);assert.equal(done.structuredContent.by,'agent-mcp');assert.equal(done.structuredContent.published,true);
 assert.equal((await onDisk(h)).entries.find(e=>e.id==='nas-photos').verified_by,'Home Hub API · agent-mcp');
 const exists=await call(h,agent.headers,'inventory_bulk_upsert',{entries:[{entry:{id:'nas',kind:'machine',name:'NAS 2'}}]});
 assert.equal(exists.isError,true);assert.match(exists.content[0].text,/exist already: nas\./);

 const nas=(await call(h,agent.headers,'inventory_get',{id:'nas'})).structuredContent,photos=(await call(h,agent.headers,'inventory_get',{id:'nas-photos'})).structuredContent;
 assert.equal((await call(h,reader.headers,'inventory_delete',{id:'nas-photos',base:photos.hash})).isError,true);
 const inUse=await call(h,agent.headers,'inventory_delete',{id:'nas',base:nas.hash});
 assert.equal(inUse.isError,true);assert.match(inUse.content[0].text,/still depend on "nas" or run on it: nas-photos/);
 assert.match((await call(h,agent.headers,'inventory_delete',{id:'nas-photos',base:'0'.repeat(64)})).content[0].text,/changed since you read it/);
 assert.equal((await call(h,agent.headers,'inventory_delete',{id:'nas-photos'})).isError,true,'the hash is required');
 const gone=await call(h,agent.headers,'inventory_delete',{id:'nas-photos',base:photos.hash});
 assert.deepEqual(gone.structuredContent,{ok:true,id:'nas-photos',deleted:true,published:true,by:'agent-mcp'});
 assert.match((await call(h,agent.headers,'inventory_delete',{id:'nas-photos',base:photos.hash})).content[0].text,/No inventory entry "nas-photos"/);

 // Write tools are logged with the account and the tool; reads are not.
 const calls=(await get(h,'/api/admin/audit',h.admin)).body.events.filter(e=>e.event==='mcp-call').map(e=>[e.subject,e.detail,e.status]);
 assert.ok(calls.some(c=>c[0]==='agent-mcp'&&c[1]==='inventory_delete · nas-photos'&&c[2]==='ok'));
 assert.ok(calls.some(c=>c[0]==='agent-mcp'&&c[1]==='inventory_bulk_upsert'&&c[2]==='ok')&&calls.some(c=>c[0]==='reader-mcp'&&c[1]==='inventory_bulk_upsert'&&c[2]==='denied'));
 assert.ok(!calls.some(c=>c[1].startsWith('inventory_describe')));
});

test('a writer provided by a plugin keeps getting single edits; what it cannot do answers 501',async t=>{
 const seen=[],ok={ok:true,published:true,entry:knowledge().entries[1],hash:'0'.repeat(64),doc:knowledge()};
 const remote={id:'remote-writer',provides:{'inventory.writer':()=>({put:async(change,by)=>{seen.push(['put',change.entry.id,by]);return ok;},edit:async input=>{seen.push(['edit',input.id]);return ok;}})}};
 const h=await hub(t,{plugins:[remote]}),agent=await h.account('agent-remote',['inventory:write']);
 const base=entryHash(knowledge().entries[1]);
 assert.equal((await post(h,'/api/inventory/entries',{entry:service('studio-x')},agent.headers)).status,200);
 assert.equal((await post(h,'/api/inventory/entry',{id:'studio-llama-swap',base,fields:{version:'9'}},h.admin)).status,200);
 assert.deepEqual(seen,[['put','studio-x','agent-remote'],['edit','studio-llama-swap']],'put and edit go to the plugin\'s writer, as before');
 const bulk=await post(h,'/api/inventory/bulk',{entries:[{entry:service('studio-y')}]},agent.headers);
 assert.equal(bulk.status,501);assert.match(bulk.body.error.message,/another machine/);
 assert.equal((await post(h,'/api/inventory/entries/delete',{id:'studio-llama-swap',base},agent.headers)).status,501);
 const tool=await call(h,agent.headers,'inventory_delete',{id:'studio-llama-swap',base});
 assert.equal(tool.isError,true);assert.match(tool.content[0].text,/Nothing was changed/);
 assert.deepEqual(await onDisk(h),knowledge(),'the local file is not touched when a writer is provided');
});
