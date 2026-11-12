import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {hub} from './hub-helper.mjs';

const rpc=(h,headers,method,params,id=1)=>fetch(h.origin+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',...headers},
 body:JSON.stringify({jsonrpc:'2.0',...(id===null?{}:{id}),method,...(params?{params}:{})})});
const call=async(h,headers,name,args)=>(await (await rpc(h,headers,'tools/call',{name,arguments:args})).json()).result;

test('MCP handshake, auth and transport rules',async t=>{
 const h=await hub(t);const agent=await h.account('agent-studio',['inventory:write']);
 const init=await rpc(h,agent.headers,'initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'test',version:'1'}});
 assert.equal(init.status,200);const r=(await init.json()).result;
 assert.equal(r.protocolVersion,'2025-06-18');assert.equal(r.serverInfo.name,'home-hub');assert.ok(r.capabilities.tools);assert.match(r.instructions,/agent-studio/);
 assert.equal((await (await rpc(h,agent.headers,'initialize',{protocolVersion:'1999-01-01'})).json()).result.protocolVersion,'2025-11-25','unknown version → latest');
 assert.equal((await rpc(h,agent.headers,'notifications/initialized',undefined,null)).status,202);
 assert.deepEqual((await (await rpc(h,agent.headers,'ping')).json()).result,{});
 assert.equal((await (await rpc(h,agent.headers,'resources/list')).json()).error.code,-32601);
 const none=await rpc(h,{},'tools/list');assert.equal(none.status,401);assert.match(none.headers.get('www-authenticate'),/Bearer/);
 assert.equal((await rpc(h,h.admin,'tools/list')).status,401,'browser sessions do not get MCP');
 assert.equal((await rpc(h,{Authorization:'Bearer hhk_'+'0'.repeat(64)},'tools/list')).status,401);
 assert.equal((await fetch(h.origin+'/mcp',{headers:agent.headers})).status,405);
 assert.equal((await rpc(h,{...agent.headers,Origin:'https://evil.example'},'tools/list')).status,403);
 const batch=await fetch(h.origin+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',...agent.headers},body:JSON.stringify([{jsonrpc:'2.0',id:1,method:'ping'}])});
 assert.equal(batch.status,400);
 const bad=await fetch(h.origin+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',...agent.headers},body:'{'});
 assert.equal((await bad.json()).error.code,-32700);
});

test('MCP tools follow scopes; inventory_update is hash-checked, secret-proof and logged',async t=>{
 const h=await hub(t);
 const agent=await h.account('agent-studio',['inventory:write']),reader=await h.account('reader-mini',[]);
 const names=async hd=>(await (await rpc(h,hd,'tools/list')).json()).result.tools.map(x=>x.name).sort();
 assert.deepEqual(await names(agent.headers),['backup_jobs_list','home_status','hub_version','integrations_status','inventory_bulk_upsert','inventory_delete','inventory_describe','inventory_get','inventory_search','inventory_update','machine_list','models_overview','review_get','review_list','runtime_endpoints_list','search','ticket_attachment_get','ticket_get','ticket_search','tickets_list','whoami']);
 assert.deepEqual(await names(reader.headers),['backup_jobs_list','home_status','hub_version','integrations_status','inventory_describe','inventory_get','inventory_search','machine_list','models_overview','review_get','review_list','runtime_endpoints_list','search','ticket_attachment_get','ticket_get','ticket_search','tickets_list','whoami']);
 const tools=(await (await rpc(h,agent.headers,'tools/list')).json()).result.tools;
 assert.ok(tools.every(x=>x.inputSchema?.type==='object'&&typeof x.description==='string'&&!('scope'in x)));

 const found=await call(h,reader.headers,'inventory_search',{query:'8081'});
 assert.equal(found.isError,false);assert.deepEqual(found.structuredContent.entries.map(e=>e.id),['studio-llama-swap']);
 const got=await call(h,reader.headers,'inventory_get',{id:'studio'});
 assert.deepEqual(got.structuredContent.dependents,[{id:'studio-llama-swap',via:'runs-on'}]);
 const entry=(await call(h,agent.headers,'inventory_get',{id:'studio-llama-swap'})).structuredContent;
 assert.equal((await call(h,agent.headers,'inventory_get',{id:'nope'})).isError,true);

 const denied=await call(h,reader.headers,'inventory_update',{entry:{...entry.entry,version:'x'},base:entry.hash});
 assert.equal(denied.isError,true);assert.match(denied.content[0].text,/inventory:write/);

 const stale=await call(h,agent.headers,'inventory_update',{entry:{...entry.entry,version:'v191'},base:'0'.repeat(64)});
 assert.equal(stale.isError,true);assert.match(stale.content[0].text,/changed since you read it/);
 const secret=await call(h,agent.headers,'inventory_update',{entry:{...entry.entry,notes:'password=hunter2hunter2'},base:entry.hash});
 assert.equal(secret.isError,true);assert.match(secret.content[0].text,/rejected/);
 const done=await call(h,agent.headers,'inventory_update',{entry:{...entry.entry,version:'v191'},base:entry.hash});
 assert.equal(done.isError,false,done.content[0].text);assert.equal(done.structuredContent.by,'agent-studio');
 const onDisk=JSON.parse(await readFile(path.join(h.dir,'knowledge.json'),'utf8')).entries.find(e=>e.id==='studio-llama-swap');
 assert.equal(onDisk.version,'v191');assert.equal(onDisk.verified_by,'Home Hub API · agent-studio','the change names the service account');assert.ok(!JSON.stringify(onDisk).includes('hunter2'));
 const created=await call(h,agent.headers,'inventory_update',{entry:{id:'studio-omlx',kind:'runtime',machine:'studio',name:'oMLX',address:'127.0.0.1:8000'}});
 assert.equal(created.isError,false,created.content[0].text);

 const status=await call(h,reader.headers,'home_status',{});
 assert.equal(status.isError,false);assert.ok(Array.isArray(status.structuredContent.machines));
 assert.equal((await (await rpc(h,agent.headers,'tools/call',{name:'rm_rf',arguments:{}})).json()).error.code,-32602);

 const audit=await (await fetch(h.origin+'/api/admin/audit',{headers:h.admin})).json();
 const mcp=audit.events.filter(e=>e.event==='mcp-call').map(e=>[e.subject,e.detail,e.status]).sort();
 // the reader's refused call never ran the tool but is logged as denied (no entry id from its arguments);
 // the agent's two failures and two writes are all logged
 assert.deepEqual(mcp,[['agent-studio','inventory_update · studio-llama-swap','error'],['agent-studio','inventory_update · studio-llama-swap','error'],
  ['agent-studio','inventory_update · studio-llama-swap','ok'],['agent-studio','inventory_update · studio-omlx','ok'],['reader-mini','inventory_update','denied']]);
 const raw=(await readFile(path.join(h.dir,'api-audit.jsonl'),'utf8')).trim().split('\n').map(l=>JSON.parse(l)).find(e=>e.status==='denied');
 assert.equal(raw.tool,'inventory_update');assert.equal(raw.name,'reader-mini');assert.ok(raw.account&&raw.key);assert.equal(raw.subject,undefined,'no request contents');
 assert.ok(audit.events.filter(e=>e.event==='mcp-call').every(e=>e.subject!=='reader-mini'||e.status==='denied'),'read-only tool calls are not logged');
});

// Users and API → Connect draws its tool table from the UI manifest. That list is the registry itself:
// the same tools, in the same order, as a key with every scope gets from tools/list.
test('the UI manifest lists the MCP tools of the running registry, without handlers or schemas',async t=>{
 const h=await hub(t);const full=await h.account('agent-full',['*']);
 const listed=(await (await rpc(h,full.headers,'tools/list')).json()).result.tools;
 const manifest=await (await fetch(h.origin+'/api/ui/manifest',{headers:h.admin})).json();
 assert.deepEqual(manifest.tools.map(x=>x.name),listed.map(x=>x.name));
 for(const name of ['whoami','machine_list','machine_upsert','machine_remove','runtime_publish','inventory_describe','inventory_bulk_upsert','inventory_delete','software_watch_list','software_watch_put','ticket_search'])
  assert.ok(manifest.tools.some(x=>x.name===name),name);
 for(const tool of manifest.tools){
  assert.deepEqual(Object.keys(tool).sort(),['description','module','name','scope','title','write'],tool.name);
  const real=listed.find(x=>x.name===tool.name);
  assert.equal(tool.description,real.description);assert.equal(tool.title,real.title||tool.name);
  assert.ok(manifest.modules.some(m=>m.id===tool.module),`${tool.name}: module ${tool.module} is a loaded module`);
 }
 const by=Object.fromEntries(manifest.tools.map(x=>[x.name,x]));
 assert.deepEqual([by.home_status.scope,by.home_status.write,by.home_status.module],['read',false,'core']);
 assert.deepEqual([by.machine_upsert.scope,by.machine_upsert.write,by.machine_upsert.module],['home:write',true,'home']);
 assert.deepEqual([by.software_watch_put.scope,by.software_watch_put.write],['software:write',true]);
 // a reader's manifest carries the same reference (what exists and what it needs), a signed-out one nothing
 assert.equal((await (await fetch(h.origin+'/api/ui/manifest')).json()).tools,undefined);
 const view=await import('../public/access-view.js');
 assert.equal(/MCP_TOOLS\s*=/.test(await readFile(path.join(import.meta.dirname,'..','public','access-view.js'),'utf8')),false,'the page keeps no tool list of its own');
 const rows=view.toolRows(manifest.tools,manifest.modules);
 assert.equal(rows.length,listed.length);assert.ok(rows.every(r=>r.plugin===null),'core modules are not shown as plugins');
});

// What an agent reads on connect: short, generic, and only about tools its key can see.
test('initialize instructions: an orientation assembled from the modules, cut to the key\'s scopes',async t=>{
 const h=await hub(t);
 const full=await h.account('agent-full',['*']),reader=await h.account('reader',[]),inv=await h.account('agent-inventory',['inventory:write']);
 const read=async k=>(await (await rpc(h,k.headers,'initialize',{protocolVersion:'2025-06-18'})).json()).result.instructions;
 const tools=async k=>(await (await rpc(h,k.headers,'tools/list')).json()).result.tools.map(x=>x.name);
 const all=await read(full),plain=await read(reader),some=await read(inv);
 assert.match(all,/^Home Hub: /);assert.match(all,/service account "agent-full"/);assert.match(plain,/with scopes: read\./);
 // every area is covered: machines, runtime stacks, inventory (describe first, search before update, hashes), software watch, tracker, review
 for(const word of ['whoami','home_status','machine_list','machine_upsert','runtime_publish','inventory_describe','inventory_search','inventory_get','inventory_update','inventory_bulk_upsert','inventory_delete','software_watch_list','software_watch_put','tickets_list','ticket_search','ticket_get','ticket_create','review_list','review_get','review_publish'])
  assert.ok(all.includes(word),word);
 assert.match(all,/inventory_describe once[^\n]*inventory_search before you add/);assert.match(all,/hash you read as base/);assert.match(all,/Never store a secret/);
 assert.ok(all.length<4000&&plain.length<2100,`short: ${all.length} / ${plain.length} characters`);
 // a tool the text names is a tool that exists, and one the key can call
 const named=text=>[...new Set(text.match(/\b[a-z]+(?:_[a-z]+)+\b/g))];
 for(const [key,text] of [[full,all],[reader,plain],[inv,some]]){const listed=await tools(key);for(const name of named(text))assert.ok(listed.includes(name),`${key.account.name}: ${name} is named but not listed`);}
 for(const word of ['machine_upsert','runtime_publish','inventory_update','software_watch','ticket_create','review_publish','Never store a secret'])assert.ok(!plain.includes(word),`a read-only key is not told about ${word}`);
 assert.ok(some.includes('inventory_update')&&!some.includes('machine_upsert')&&!some.includes('ticket_create'));
 // generic: nothing of one household, in either direction
 const {SITE}=await import('./hub-helper.mjs');
 for(const m of SITE.machines)assert.ok(!all.includes(m.name)&&!all.includes(m.hostname||'\u0000'),m.id);
 assert.ok(!all.includes(SITE.siteName));
});
