// The hub's own request history for the LLM runtimes it reads (server/runtime-history.mjs, the runtimes
// module): llama-swap's activity buffer to stored records, de-duplication across a runtime restart, the
// monthly files and their pruning, the provider, the two allowlisted reads and nothing else, the join with
// the access-log stream for the client, the site's own client names, the integration status and switch,
// and the import of older history.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir,readFile,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {fromActivity,cleanRecord,recordKey,createRequestHistory,createHistoryCollector,createHistoryReader,createStreamWatcher,historyPathAllowed,activityPath,
 parseAccessLine,joinLine,clientFor,uaFamilyOf,fromImportLine,STREAM_PATH,HISTORY_READS,ACTIVITY_MAX_PAGES,DEDUP_DAYS} from '../server/runtime-history.mjs';
import {READ_PATHS} from '../server/runtime-adapters.mjs';
import {validateSite} from '../server/site-config.mjs';
import {metricKey} from '../server/models-data.mjs';
import {importFiles,parseArgs} from '../scripts/import-runtime-history.mjs';
import {hub} from './hub-helper.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const DAY=86400000;
const NOW=Date.parse('2026-11-10T12:00:00Z');
const temp=async t=>{const dir=await mkdtemp(path.join(os.tmpdir(),'hub-hist-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;};
const MACHINES=[{id:'studio',ip:'10.0.0.151'},{id:'mini',ip:'10.0.0.25'}];
// One llama-swap activity record (v268), `ago` ms before NOW.
const act=(id,ago,extra={})=>({id,timestamp:new Date(NOW-ago).toISOString(),src:'ip:127.0.0.1',model:'qwen-27b',req_path:'/v1/chat/completions',resp_content_type:'text/event-stream',
 resp_status_code:200,tokens:{cache_tokens:100,draft_tokens:-1,input_tokens:1000+id,output_tokens:50,prompt_per_second:400,tokens_per_second:90},duration_ms:4000,has_capture:true,...extra});

// A fake llama-swap: the activity buffer (newest first), paged like v268; the access-log stream as a
// response whose body the test writes lines into; every request recorded.
function fakeLlamaSwap({buffer=[],log=[]}={}){
 const streams=[];
 const fetcher=async(url,init={})=>{
  const u=new URL(url);log.push({method:init.method||'GET',url,path:u.pathname,search:u.search,body:init.body??null});
  if(u.pathname==='/api/metrics/activity'){
   const page=Number(u.searchParams.get('page')||1),limit=Number(u.searchParams.get('limit')||25),list=fake.buffer;
   return Response.json({data:list.slice((page-1)*limit,page*limit),page,limit,total:list.length,total_pages:Math.max(1,Math.ceil(list.length/limit))});
  }
  if(u.pathname==='/logs/stream/http'){
   let controller;const body=new ReadableStream({start(c){controller=c;}});
   const s={push:line=>controller.enqueue(new TextEncoder().encode(line+'\n')),end:()=>controller.close()};streams.push(s);
   init.signal?.addEventListener('abort',()=>{try{controller.error(new DOMException('aborted','AbortError'));}catch{}});
   return new Response(body,{status:200,headers:{'Content-Type':'text/plain'}});
  }
  return new Response('not found',{status:404});
 };
 const fake={buffer,log,streams,fetcher};return fake;
}
const ALLOWED=u=>{const x=new URL(u);return historyPathAllowed(x.pathname+x.search);};

test('the activity buffer becomes stored records: request fields only, the address, a site machine named by its address',()=>{
 const raw=[act(917,60000,{src:'ip:10.0.0.25',prompt:'secret prompt'}),act(918,1000),{id:919},{timestamp:new Date(NOW).toISOString(),model:'x'}];
 const out=fromActivity(raw,{machine:'studio',runtime:'llama-swap',machines:MACHINES});
 assert.equal(out.length,2,'a record without a time or an id is left out');
 assert.deepEqual(out[0],{machine:'studio',runtime:'llama-swap',model:'qwen-27b',at:new Date(NOW-60000).toISOString(),metricId:917,path:'/v1/chat/completions',status:200,
  inputTokens:1917,outputTokens:50,cacheTokens:100,promptTps:400,generationTps:90,durationMs:4000,client:'',clientMachine:'mini',clientAddress:'10.0.0.25'});
 assert.equal(out[1].clientAddress,'127.0.0.1');assert.ok(!('clientMachine' in out[1]),'loopback names no machine');
 assert.ok(!JSON.stringify(out).includes('secret'),'nothing but the request fields');
 assert.equal(recordKey(out[0]),metricKey({machine:'studio',runtime:'llama-swap',metricId:917,at:NOW-60000}),'the key is metricKey with the time in ms');
 assert.equal(cleanRecord({machine:'Bad Id',at:NOW}),null);assert.equal(cleanRecord({machine:'studio',at:'never'}),null);
});

test('de-duplication: the same buffer twice adds nothing; after a llama-swap restart the reused ids are new records',async t=>{
 const store=createRequestHistory(await temp(t));
 const before=fromActivity([act(3,3000),act(2,60000),act(1,120000)],{machine:'studio',runtime:'llama-swap'});
 assert.deepEqual(await store.ingest('studio',before,{now:NOW}),{added:3,known:0,skipped:0});
 assert.deepEqual(await store.ingest('studio',before,{now:NOW}),{added:0,known:3,skipped:0});
 // Restarted: ids from 1 again, at new times. Neither dropped (same id) nor doubled.
 const after=fromActivity([act(2,1000),act(1,2000)],{machine:'studio',runtime:'llama-swap'});
 assert.deepEqual(await store.ingest('studio',after,{now:NOW}),{added:2,known:0,skipped:0});
 // A fresh store on the same files (a hub restart) knows all five.
 const again=createRequestHistory(store.root.replace(/\/runtimes$/,''));
 assert.deepEqual(await again.ingest('studio',[...before,...after],{now:NOW}),{added:0,known:5,skipped:0});
 const all=await again.read({from:0,to:NOW});
 assert.equal(all.length,5);assert.deepEqual(all.map(r=>r.metricId),[1,2,3,1,2],'oldest first');
 // Outside the window, or from the future: not kept.
 assert.equal((await again.ingest('studio',fromActivity([act(9,(DEDUP_DAYS+1)*DAY),act(10,-3600000)],{machine:'studio',runtime:'llama-swap'}),{now:NOW})).skipped,2);
});

test('monthly files: one per UTC month, 0600; files older than 13 months are pruned; the key set is bounded',async t=>{
 const dir=await temp(t),store=createRequestHistory(dir,{dedupCap:3});
 const months=['2025-09','2025-10','2025-11','2026-01','2026-10','2026-11'];
 const recs=months.map((m,i)=>cleanRecord({machine:'studio',runtime:'llama-swap',model:'m',at:`${m}-05T10:00:00Z`,metricId:i+1,path:'/v1/chat/completions'}));
 await store.ingest('studio',recs,{now:NOW,window:false});
 const files=(await readdir(path.join(dir,'runtimes','studio'))).sort();
 assert.deepEqual(files,['requests-2025-11.jsonl','requests-2026-01.jsonl','requests-2026-10.jsonl','requests-2026-11.jsonl'],'13 months kept: 2025-11 … 2026-11');
 const {mode}=await import('node:fs/promises').then(f=>f.stat(path.join(dir,'runtimes','studio','requests-2026-11.jsonl')));
 assert.equal(mode&0o777,0o600);
 const line=JSON.parse((await readFile(path.join(dir,'runtimes','studio','requests-2026-11.jsonl'),'utf8')).trim());
 assert.deepEqual(Object.keys(line).sort(),['at','cacheTokens','client','durationMs','generationTps','inputTokens','machine','metricId','model','outputTokens','path','promptTps','runtime','status']);
 // The window holds at most dedupCap keys; the oldest go first.
 const live=fromActivity([act(1,4*60000),act(2,3*60000),act(3,2*60000),act(4,60000)],{machine:'mini',runtime:'llama-swap'});
 assert.equal((await store.ingest('mini',live,{now:NOW})).added,4);
 assert.equal(await store.has('mini',live[3],NOW),true);assert.equal(await store.has('mini',live[0],NOW),false,'evicted: the oldest');
 await assert.rejects(store.ingest('../etc',[],{now:NOW}),/invalid/);
});

test('the provider: records in the range, one per key with the one that names a client, client named again from the family',async t=>{
 const clients={deno:'Memory service'};
 const store=createRequestHistory(await temp(t),{clients:()=>clients});
 const base={machine:'studio',runtime:'llama-swap',model:'qwen-27b',path:'/v1/chat/completions',status:200,inputTokens:10,outputTokens:20};
 await store.ingest('studio',[{...base,at:NOW-3600000,metricId:1},{...base,at:NOW-7200000,metricId:2,uaFamily:'deno',client:'Deno'},{...base,at:NOW-40*DAY,metricId:3}],{now:NOW,window:false});
 // An attributed copy of record 1 arrives later (an import): appended, and preferred.
 assert.equal((await store.ingest('studio',[{...base,at:NOW-3600000,metricId:1,uaFamily:'claude-cli'}],{now:NOW,window:false})).added,1);
 assert.equal((await store.ingest('studio',[{...base,at:NOW-3600000,metricId:1}],{now:NOW,window:false})).added,0,'an unattributed copy of a known record adds nothing');
 const r=await store.provider.read({from:NOW-DAY,to:NOW,limit:100});
 assert.deepEqual(r.map(x=>[x.metricId,x.client]),[[2,'Memory service'],[1,'Claude Code']]);
 assert.deepEqual(Object.keys(r[0]).sort(),['at','cacheTokens','client','durationMs','generationTps','inputTokens','machine','metricId','model','outputTokens','path','promptTps','runtime','status']);
 assert.equal((await store.provider.read({from:0,to:NOW,limit:1})).length,1);
 assert.equal(store.provider.id,'runtimes-history');
 const s=await store.summary('studio',{since:NOW-DAY,now:NOW});assert.equal(s.recordsToday,2);
});

test('only two reads exist: the activity pages with limit 200, and the stream; nothing else reaches a socket',async()=>{
 for(const ok of ['/api/metrics/activity?page=1&limit=200','/api/metrics/activity?page=10&limit=200',STREAM_PATH])assert.equal(historyPathAllowed(ok),true,ok);
 for(const no of ['/api/metrics/activity','/api/metrics/activity?page=11&limit=200','/api/metrics/activity?page=0&limit=200','/api/metrics/activity?page=1&limit=999',
  '/api/metrics/activity?limit=200&page=1','/api/metrics/activity?page=1&limit=200&x=1','/logs/stream/http','/logs/stream/proxy','/logs/stream/http?no-history&x',
  '/upstream/qwen/v1/models','/unload','/api/models/unload','/api/captures/1','/v1/chat/completions'])assert.equal(historyPathAllowed(no),false,no);
 assert.deepEqual(HISTORY_READS,['/api/metrics/activity?page=<1-10>&limit=200',STREAM_PATH]);
 assert.ok(!READ_PATHS.some(p=>p.includes('?')||p.startsWith('/logs')),'the adapters\' list is unchanged: no query, no stream');
 let calls=0;const get=createHistoryReader({base:'http://127.0.0.1:9',fetcher:async()=>{calls++;return Response.json({});}});
 for(const p of ['/upstream/x','/api/metrics/activity?page=1&limit=999',STREAM_PATH])await assert.rejects(get(p),/path-not-allowed/);
 assert.equal(calls,0,'refused before a request is made');
 assert.equal(activityPath(3),'/api/metrics/activity?page=3&limit=200');
});

test('the collector: the whole buffer first (at most 10 pages), then page 1 until a known record; GET only, the allowlist only',async t=>{
 const store=createRequestHistory(await temp(t)),now=()=>NOW;
 const fake=fakeLlamaSwap({buffer:Array.from({length:450},(_,i)=>act(450-i,60000+i*60000))});
 const e={id:'studio-llama-swap',machine:'studio',kind:'llama-swap',url:'http://127.0.0.1:8081'};
 const c=createHistoryCollector({store,endpoints:async()=>[e],runtimeIdOf:async()=>'llama-swap',kindOf:()=>null,tokens:{get:async()=>null},fetcher:fake.fetcher,now,machines:()=>MACHINES});
 t.after(()=>c.stopAll());
 await c.tick();
 const pages=fake.log.filter(l=>l.path==='/api/metrics/activity').map(l=>l.search);
 assert.deepEqual(pages,['?page=1&limit=200','?page=2&limit=200','?page=3&limit=200']);
 assert.equal(c.status(e.id).added,450);assert.equal((await store.read({from:0,to:NOW})).length,450);
 // Two new records: page 1 only, both stored.
 fake.buffer.unshift(act(452,30000),act(451,40000));fake.log.length=0;
 await c.tick();
 assert.deepEqual(fake.log.filter(l=>l.path==='/api/metrics/activity').map(l=>l.search),['?page=1&limit=200']);
 assert.equal((await store.read({from:0,to:NOW})).length,452);
 // llama-swap restarted: a small buffer with ids from 1 again, at new times. Nothing is dropped.
 fake.buffer=[act(2,20000),act(1,25000)];
 await c.tick();assert.equal((await store.read({from:0,to:NOW})).length,454);
 // A buffer bigger than 10 pages: the first read stops at page 10.
 const big=fakeLlamaSwap({buffer:Array.from({length:2600},(_,i)=>act(2600-i,60000+i*1000))});
 const c2=createHistoryCollector({store:createRequestHistory(await temp(t)),endpoints:async()=>[e],runtimeIdOf:async()=>'llama-swap',kindOf:()=>null,tokens:{get:async()=>null},fetcher:big.fetcher,now});
 t.after(()=>c2.stopAll());await c2.tick();
 assert.equal(big.log.filter(l=>l.path==='/api/metrics/activity').length,ACTIVITY_MAX_PAGES);
 for(const l of [...fake.log,...big.log]){
  assert.equal(l.method,'GET');assert.equal(l.body,null);assert.ok(ALLOWED(l.url),l.url);
  assert.ok(!/upstream|unload|captures|\/v1\//.test(l.url),l.url);
 }
 // An endpoint that is not llama-swap is not read for history at all.
 const other=fakeLlamaSwap();
 const c3=createHistoryCollector({store,endpoints:async()=>[{...e,id:'studio-omlx',kind:'omlx'},{...e,id:'studio-auto',kind:'auto'}],runtimeIdOf:async()=>'omlx',kindOf:()=>'omlx',tokens:{get:async()=>null},fetcher:other.fetcher,now});
 await c3.tick();assert.equal(other.log.length,0);assert.equal(c3.status('studio-omlx'),null);
});

test('clients: the access log line of a record names it; GET lines and other paths never join; unattributed without a line',async t=>{
 const line='[INFO] Request 127.0.0.1 "POST /v1/chat/completions HTTP/1.1" 200 1234 "claude-cli/2.1.30 (external, cli)" 4.012s';
 const p=parseAccessLine(line,NOW);
 assert.deepEqual(p,{arrivedAt:NOW,address:'127.0.0.1',path:'/v1/chat/completions',status:200,uaFamily:'claude-cli',durationMs:4012,used:false});
 assert.equal(parseAccessLine('[INFO] Request 127.0.0.1 "GET /v1/models HTTP/1.1" 200 2879 "home-hub-runtimes/1" 310.667µs',NOW),null,'GETs are not requests to join');
 assert.equal(parseAccessLine('garbage'),null);
 const rec={at:new Date(NOW-4000).toISOString(),path:'/v1/chat/completions',status:200,durationMs:4000};
 const lines=[{...p,path:'/v1/embeddings'},{...p,status:500},{...p,durationMs:9000},{...p,arrivedAt:NOW+60000},p];
 assert.equal(joinLine(rec,lines),p);assert.equal(p.used,true);assert.equal(joinLine(rec,lines),null,'a line joins one record only');
 // Generic names, the site's own names first, unknown families keep their name.
 assert.equal(clientFor('claude-cli'),'Claude Code');assert.equal(clientFor('Codex_exec'),'Codex');assert.equal(clientFor('deno'),'Deno');
 assert.equal(clientFor('DENO',{deno:'Memory service'}),'Memory service');assert.equal(clientFor('my-tool'),'my-tool');assert.equal(clientFor(''),'');
 assert.equal(uaFamilyOf('Mozilla/5.0 (Macintosh)'),'Mozilla');assert.equal(uaFamilyOf('x'.repeat(100)).length,40);
 // End to end: a stream line and a record, joined; a record with no line stays unattributed.
 const store=createRequestHistory(await temp(t),{clients:()=>({deno:'Memory service'})});let clock=NOW;
 const fake=fakeLlamaSwap({buffer:[]});
 const e={id:'studio-llama-swap',machine:'studio',kind:'llama-swap',url:'http://127.0.0.1:8081'};
 const c=createHistoryCollector({store,endpoints:async()=>[e],runtimeIdOf:async()=>'llama-swap',kindOf:()=>null,tokens:{get:async()=>null},fetcher:fake.fetcher,now:()=>clock,clients:()=>({deno:'Memory service'})});
 t.after(()=>c.stopAll());
 await c.tick();await new Promise(r=>setTimeout(r,20));
 assert.equal(c.status(e.id).stream.state,'connected');
 fake.streams[0].push('[INFO] Request 127.0.0.1 "POST /v1/chat/completions HTTP/1.1" 200 99 "deno/2.1" 4.01s');
 await new Promise(r=>setTimeout(r,20));
 fake.buffer=[act(2,0),act(1,600000,{duration_ms:1200})];// 2 just ended (its line came), 1 long ago (no line)
 await c.tick();
 assert.deepEqual((await store.read({from:0,to:NOW+DAY})).map(r=>r.metricId),[1],'a record that just ended waits one tick for its line');
 clock=NOW+20000;await c.tick();
 const got=await store.read({from:0,to:NOW+DAY});
 assert.deepEqual(got.map(r=>[r.metricId,r.client,r.clientAddress]),[[1,'','127.0.0.1'],[2,'Memory service','127.0.0.1']]);
 assert.equal(c.status(e.id).attributed,1);
});

test('the stream reconnects after an end or a failure, waits longer each time, and stop() ends it for good',async t=>{
 let n=0;const lines=[];
 const fetcher=async(url,init)=>{n++;assert.equal(url,'http://127.0.0.1:8081/logs/stream/http?no-history');assert.equal(init.method,'GET');assert.equal(init.redirect,'error');
  if(n===2)throw Object.assign(new TypeError('fetch failed'),{cause:{code:'ECONNREFUSED'}});
  return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(`line ${n}\npart`));c.enqueue(new TextEncoder().encode('ial\n'));c.close();}}));};
 const w=createStreamWatcher({base:'http://127.0.0.1:8081/',fetcher,onLine:l=>lines.push(l),retryMinMs:10,retryMaxMs:40});
 t.after(()=>w.stop());
 w.start();w.start();
 await new Promise(r=>setTimeout(r,150));
 assert.ok(n>=3,`reconnected: ${n}`);assert.deepEqual(lines.slice(0,2),['line 1','partial'],'lines split across chunks are joined');
 w.stop();const at=n;await new Promise(r=>setTimeout(r,100));assert.equal(n,at,'no reconnect after stop');assert.equal(w.status().state,'off');
 // A runtime without the stream (404): reconnecting, with the reason.
 const missing=createStreamWatcher({base:'http://127.0.0.1:8081',fetcher:async()=>new Response('no',{status:404}),onLine:()=>{},retryMinMs:1000});
 missing.start();await new Promise(r=>setTimeout(r,20));assert.deepEqual([missing.status().state,missing.status().lastError],['reconnecting','http-404']);missing.stop();
});

test('site.json → runtimeClients: User-Agent family → client name, validated; empty by default',()=>{
 assert.deepEqual(validateSite({}).runtimeClients,{});
 const s=validateSite({runtimeClients:{deno:'Memory service','python-httpx':'Notebook'}});
 assert.deepEqual(s.runtimeClients,{deno:'Memory service','python-httpx':'Notebook'});assert.ok(Object.isFrozen(s.runtimeClients));
 for(const bad of [[],'x',{'a b':'x'},{'':'x'},{deno:''},{deno:'x'.repeat(61)},{deno:5},{deno:'a',DENO:'b'},Object.fromEntries(Array.from({length:61},(_,i)=>[`f${i}`,'x']))])
  assert.throws(()=>validateSite({runtimeClients:bad}),/runtimeClients/,JSON.stringify(bad).slice(0,60));
});

test('the runtimes module: history as runtimes.requests on the models page, the integration item, and the switch stops reads and the stream',async t=>{
 const site=validateSite({lanCidrs:['10.0.0.0/24'],machines:[{id:'studio',ip:'10.0.0.151'},{id:'mini',ip:'10.0.0.25'}],runtimeClients:{deno:'Memory service'},
  runtimes:[{id:'studio-llama-swap',machine:'studio',kind:'llama-swap',url:'http://127.0.0.1:8081'}]});
 const now=Date.now(),recent=(id,ago,extra)=>({...act(id,0,extra),timestamp:new Date(now-ago).toISOString()});
 const fake=fakeLlamaSwap({buffer:[recent(2,120000,{src:'ip:10.0.0.25'}),recent(1,180000)]});
 const routes={'/v1/models':{data:[{id:'qwen-27b'}]},'/running':{running:[]}};
 const fetcher=async(url,init)=>{const u=new URL(url);if(routes[u.pathname])return Response.json(routes[u.pathname]);return fake.fetcher(url,init);};
 const h=await hub(t,{site,runtimeFetch:fetcher});
 const state=h.handler.hub.state('runtimes'),hubApi=h.handler.hub;
 const poller=h.handler.registry.pollers.find(p=>p.id==='runtimes-history');
 t.after(()=>poller.stop(state,hubApi));
 await state.poller.poll({force:true});await state.history.tick();await new Promise(r=>setTimeout(r,20));
 fake.streams[0]?.push('[INFO] Request 10.0.0.25 "POST /v1/chat/completions HTTP/1.1" 200 99 "deno/2.1" 4s');
 const files=await readdir(path.join(h.dir,'runtimes','studio'));assert.ok(files.some(f=>/^requests-\d{4}-\d{2}\.jsonl$/.test(f)),'stored under <state>/runtimes/<machine>/');
 const d=await (await fetch(h.origin+'/api/models',{headers:h.admin})).json();
 assert.equal(d.overview.requests,2);
 assert.ok(d.providers.requests.some(p=>p.module==='runtimes'&&p.id==='runtimes-history'&&p.count===2));
 assert.ok(d.clients.some(c=>c.clientMachine==='mini'),'the address of a site machine names it');
 const series=await (await fetch(h.origin+'/api/models/history?range=24h',{headers:h.admin})).json();assert.equal(series.available,true);assert.equal(series.totals.requests,2);
 const integration=h.handler.registry.integrations.find(g=>g.id==='runtimes.endpoints');
 const item=(await integration.status(state,hubApi)).items[0];
 assert.match(item.summary.text,/· historie: naposledy přibyla \d\d:\d\d, dnes záznamů \d+ · klienti z logu$/);assert.equal(item.summary.parts.length,3);
 const card=(await (await fetch(h.origin+'/api/admin/integrations',{headers:h.admin})).json()).integrations.find(g=>g.id==='runtimes.endpoints');
 assert.equal(card.status.items[0].summaryT.length,3,'the summary reaches the page translatable');
 const listed=await (await fetch(h.origin+'/api/runtimes/endpoints',{headers:h.admin})).json();assert.deepEqual(listed.historyReadPaths,HISTORY_READS);
 const hist=listed.endpoints[0].history;
 assert.ok(hist.recordsToday>=1);assert.ok(hist.lastIngestedAt);assert.equal(hist.stream,'connected');assert.ok(!('sentence' in hist));
 // Switched off: the stream closes at once, nothing more is read, nothing is provided.
 poller.start(state,hubApi);
 assert.equal((await h.post('/api/admin/integrations/toggle',{id:'runtimes.endpoints',enabled:false},h.admin)).status,200);
 assert.equal(state.history.status('studio-llama-swap').stream.state,'off','no stream is held open');
 fake.log.length=0;await state.history.tick();await state.poller.poll({force:true});assert.equal(fake.log.length,0,'nothing read while off');
 const provider=h.handler.registry.providers('runtimes.requests').find(p=>p.module==='runtimes');
 assert.equal(await provider.provide(state,hubApi),null,'nothing is provided while off');
 assert.equal((await h.post('/api/admin/integrations/toggle',{id:'runtimes.endpoints',enabled:true},h.admin)).status,200);
 await state.history.tick();assert.ok(fake.log.some(l=>l.path==='/logs/stream/http'),'back on: the stream again');
 for(const l of fake.log){assert.equal(l.method,'GET');assert.ok(ALLOWED(l.url),l.url);}
});

test('import: v1 history JSONL from a local file, de-duplicated, attributed copies preferred; arguments checked',async t=>{
 const dir=await temp(t),file=path.join(dir,'history-2026-10.jsonl');
 const v1=[{kind:'request',serviceId:'llama-swap',metricId:7,at:'2026-10-02T10:00:00.000Z',model:'qwen-27b',path:'chat',status:200,inputTokens:5,outputTokens:6,uaFamily:'deno',requestor:'Memory service'},
  {kind:'request',serviceId:'llama-swap',metricId:8,at:'2026-10-02T10:01:00.000Z',model:'qwen-27b',path:'chat',uaFamily:'',requestor:'Unattributed'},
  {kind:'event',serviceId:'llama-swap',at:'2026-10-02T10:00:00.000Z',model:'qwen-27b',state:'loaded'},{kind:'request',at:'2026-10-02T10:02:00.000Z'}];
 await writeFile(file,v1.map(x=>JSON.stringify(x)).join('\n')+'\nnot json\n');
 const state=path.join(dir,'state');
 assert.deepEqual(await importFiles({machine:'studio',files:[file],state,now:NOW}),{read:5,valid:2,added:2,known:0,skipped:3});
 assert.deepEqual(await importFiles({machine:'studio',files:[file],state,now:NOW}),{read:5,valid:2,added:0,known:2,skipped:3},'twice adds nothing');
 const r=await createRequestHistory(state,{clients:()=>({deno:'OB-like'})}).read({from:0,to:NOW});
 assert.deepEqual(r.map(x=>[x.metricId,x.client,x.path]),[[7,'OB-like','chat'],[8,'','chat']]);
 assert.equal(fromImportLine({machine:'mini',at:NOW,metricId:1},{machine:'studio'}),null,'another machine\'s line is left out');
 assert.equal(fromImportLine({machine:'studio',runtime:'llama-swap',at:NOW,metricId:1,path:'/v1/chat/completions'},{machine:'studio'}).metricId,1,'the store\'s own format');
 assert.throws(()=>parseArgs(['x.jsonl']),/--machine/);assert.throws(()=>parseArgs(['--machine','studio']),/file/);
 assert.throws(()=>parseArgs(['--machine','studio','https://example.lan/h.jsonl']),/not a URL/);
 assert.deepEqual(parseArgs(['--machine','studio','--dry-run','a.jsonl']),{machine:'studio',dryRun:true,files:['a.jsonl']});
 assert.ok(!(await readFile(path.join(root,'scripts','import-runtime-history.mjs'),'utf8')).includes('fetch('),'the importer fetches nothing');
});

test('the models page: two providers of one request count it once (metricKey), keeping the copy that names a client',async t=>{
 const at=new Date(Date.now()-60000).toISOString(),base={machine:'studio',runtime:'llama-swap',model:'qwen-27b',at,path:'/v1/chat/completions',inputTokens:1,outputTokens:2};
 const one=(id,items)=>({id,provides:{'runtimes.requests':()=>({id,read:async()=>items})}});
 const h=await hub(t,{plugins:[one('plain-history',[{...base,metricId:5},{...base,metricId:6,at:new Date(Date.now()-30000).toISOString()}]),one('named-history',[{...base,metricId:5,client:'Codex'}])]});
 const d=await (await fetch(h.origin+'/api/models',{headers:h.admin})).json();
 assert.equal(d.overview.requests,2);assert.equal(d.overview.attributed,1);
 assert.deepEqual(d.clients.map(c=>[c.client,c.requests]).sort(),[['Codex',1],['Unattributed',1]]);
 // Without a record id the old identity holds: the same request from two providers, once.
 const h2=await hub(t,{plugins:[one('first-copy',[base]),one('second-copy',[base])]});
 assert.equal((await (await fetch(h2.origin+'/api/models',{headers:h2.admin})).json()).overview.requests,1);
});
