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
 assert.deepEqual(await names(agent.headers),['home_status','inventory_get','inventory_search','inventory_update','review_get','review_list','search','ticket_attachment_get','ticket_get','tickets_list']);
 assert.deepEqual(await names(reader.headers),['home_status','inventory_get','inventory_search','review_get','review_list','search','ticket_attachment_get','ticket_get','tickets_list']);
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
