// The module contract (server/plugins.mjs, docs/plugins.md): what a plugin may register, what is refused
// at start-up, and that a loaded plugin's routes, scopes, MCP tools, pages and assets work end to end.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {defineModule,createRegistry,loadPlugins,pluginsDirectory} from '../server/plugins.mjs';
import {CORE_MODULES,buildRegistry} from '../server/index.mjs';
import {SCOPES,CORE_SCOPES,legacyScopes,validScopes,scopeFor} from '../server/scopes.mjs';
import {PAGES,ADMIN_PAGES} from '../public/session-cache.js';
import {hub} from './hub-helper.mjs';

const fixtures=path.join(path.dirname(fileURLToPath(import.meta.url)),'fixtures','plugins');
const ok=()=>{};
const mod=extra=>({id:'p-one',...extra});

test('a module is validated field by field, and the message names the module',()=>{
 assert.throws(()=>defineModule({}),/needs an id/);
 assert.throws(()=>defineModule({id:'Bad Id'}),/needs an id/);
 assert.throws(()=>defineModule(mod({surprise:1})),/module "p-one": unknown field\(s\): surprise/);
 assert.throws(()=>defineModule(mod({scopes:{'p:write':{label:'x'}}})),/needs \{label, desc\}/);
 assert.throws(()=>defineModule(mod({scopes:{'Not A Scope':{label:'x',desc:'y'}}})),/is not valid/);
 assert.throws(()=>defineModule(mod({routes:[{method:'DELETE',path:'/api/p',handler:ok}]})),/method must be one of/);
 assert.throws(()=>defineModule(mod({routes:[{method:'GET',handler:ok}]})),/exactly one of path/);
 assert.throws(()=>defineModule(mod({routes:[{method:'GET',path:'/api/p',match:/x/,handler:ok}]})),/exactly one of path/);
 assert.throws(()=>defineModule(mod({routes:[{method:'GET',path:'/api/p'}]})),/handler must be a function/);
 assert.throws(()=>defineModule(mod({routes:[{method:'GET',match:/x/g,handler:ok}]})),/g or y flag/);
 // A write route must say what an API key needs: an explicit scope, or null for "never with a key".
 assert.throws(()=>defineModule(mod({routes:[{method:'POST',path:'/api/p',handler:ok}]})),/must declare scope/);
 assert.throws(()=>defineModule(mod({routes:[{method:'PUT',path:'/api/p',scope:null,handler:ok}]})),/raw uploads/);
 assert.throws(()=>defineModule(mod({routes:[{method:'GET',path:'/api/p',handler:ok,typo:true}]})),/unknown field\(s\): typo/);
 assert.throws(()=>defineModule(mod({mcpTools:[{name:'p_tool',scope:'read',description:'d',inputSchema:{type:'object'}}]})),/needs run/);
 assert.throws(()=>defineModule(mod({pollers:[{id:'x'}]})),/pollers\[0\]/);
 // mcpInstructions: one short text, or parts {text, scope?}
 assert.throws(()=>defineModule(mod({mcpInstructions:['']})),/mcpInstructions\[0\] needs a text/);
 assert.throws(()=>defineModule(mod({mcpInstructions:['x'.repeat(601)]})),/1 to 600 characters/);
 assert.throws(()=>defineModule(mod({mcpInstructions:['two\nlines']})),/on one line/);
 assert.throws(()=>defineModule(mod({mcpInstructions:[{text:'ok',when:'always'}]})),/unknown field\(s\): when/);
 assert.throws(()=>defineModule(mod({mcpInstructions:[{text:'ok',scope:'Not A Scope'}]})),/scope must be a scope id/);
 assert.throws(()=>defineModule(mod({mcpInstructions:Array(7).fill('ok')})),/at most 6 parts/);
 assert.deepEqual(defineModule(mod({mcpInstructions:' Notes: notes_list lists them. '})).mcpInstructions,[{module:'p-one',text:'Notes: notes_list lists them.',scope:null}]);
 assert.throws(()=>defineModule(mod({assets:['../secret.js']})),/without "\.\."/);
 assert.throws(()=>defineModule(mod({nav:[{group:'G',hash:'p',label:'P',view:'p.js#page'}]})),/not listed in this module's assets/);
 assert.throws(()=>defineModule(mod({nav:[{hash:'p',view:'p.js'}]})),/needs label or labelKey/);
 assert.throws(()=>defineModule(mod({nav:[{group:'G',label:'Soon',soon:true,hash:'p'}]})),/has no hash or view/);
 assert.throws(()=>defineModule(mod({setup:'no'})),/setup must be a function/);
 const m=defineModule(mod({routes:[{method:'GET',path:'/api/p',handler:ok},{method:'POST',path:'/api/p',scope:'read',handler:ok},{method:'POST',path:'/api/p/w',scope:null,handler:ok}]}));
 assert.deepEqual(m.routes.map(r=>[r.scope,r.write]),[['read',false],['read',false],[null,true]],'GET defaults to read; a read-scoped POST needs no write permission');
 assert.ok(Object.isFrozen(m)&&Object.isFrozen(m.routes));
});

test('clashes between modules are start-up errors that name both sides',()=>{
 const core=CORE_MODULES;
 const plug=(id,extra)=>defineModule({id,...extra});
 assert.throws(()=>createRegistry([...core,plug('p-one',{routes:[{method:'GET',path:'/api/home',handler:ok}]})]),/route GET \/api\/home is registered twice: by module "home" and by module "p-one"/);
 assert.throws(()=>createRegistry([...core,plug('p-one',{routes:[{method:'GET',match:/^\/api\/tickets\/(.*)$/,handler:ok}]})]),/registered twice: by module "tracker" and by module "p-one"/);
 assert.throws(()=>createRegistry([...core,plug('p-one',{scopes:{'tickets:write':{label:'x',desc:'y'}}})]),/scope "tickets:write" is registered twice: by module "core" and by module "p-one"/);
 assert.throws(()=>createRegistry([...core,plug('p-one',{scopes:{'p:w':{label:'x',desc:'y'}}}),plug('p-two',{scopes:{'p:w':{label:'x',desc:'y'}}})]),/by module "p-one" and by module "p-two"/);
 assert.throws(()=>createRegistry([...core,plug('p-one'),plug('p-one')]),/module id "p-one" is registered twice/);
 assert.throws(()=>buildRegistry([{id:'p-one',mcpTools:[{name:'home_status',scope:'read',description:'d',inputSchema:{type:'object'},run:ok}]}]),/MCP tool "home_status" is registered twice: by module "core" and by module "p-one"/);
 assert.throws(()=>createRegistry([...core,plug('p-one',{routes:[{method:'POST',path:'/api/p',scope:'nobody:defined',handler:ok}]})]),/uses scope "nobody:defined", which no module defines/);
 assert.throws(()=>createRegistry([...core,plug('p-one',{mcpInstructions:[{text:'x',scope:'nobody:defined'}]})]),/mcpInstructions uses scope "nobody:defined", which no module defines/);
 // A plugin may use a core scope, and another plugin's.
 const r=createRegistry([...core,plug('p-one',{scopes:{'p:w':{label:'x',desc:'y'}}}),plug('p-two',{routes:[{method:'POST',path:'/api/p2',scope:'p:w',handler:ok},{method:'POST',path:'/api/p3',scope:'tickets:write',handler:ok}]})]);
 assert.equal(r.match('POST','/api/p2').route.scope,'p:w');
 assert.equal(r.match('GET','/api/tickets/HH-1').route.module,'tracker');
 assert.equal(r.match('GET','/api/tickets').route.path,'/api/tickets','an exact path wins over a pattern');
 assert.equal(r.match('GET','/nope'),null);
});

test('plugins load from a directory: one sub-directory with index.mjs each, id = directory name',async()=>{
 const loaded=await loadPlugins(fixtures);
 assert.deepEqual(loaded.map(m=>m.id),['demo'],'_shared is skipped');
 assert.equal(loaded[0].assets[0].url,'/plugins/demo/demo-view.js','plugin assets are served under /plugins/<id>/');
 assert.deepEqual(await loadPlugins(path.join(fixtures,'missing')),[]);
 assert.deepEqual(await loadPlugins(null),[]);
 assert.equal(pluginsDirectory({HOME_HUB_PLUGINS_DIR:'none'}),null);
 assert.equal(pluginsDirectory({HOME_HUB_PLUGINS_DIR:'/x/y'}),'/x/y');
 assert.match(pluginsDirectory({}),/local[\\/]plugins$/);
});

test('core: the scope table and the page list match what the core modules register',()=>{
 const registry=buildRegistry([]);
 assert.deepEqual([...registry.scopes.keys()],Object.keys(CORE_SCOPES));
 for(const id of Object.keys(CORE_SCOPES))assert.ok(SCOPES[id],id);
 const pages=registry.nav.filter(n=>n.hash&&n.hash!=='overview');
 assert.deepEqual(pages.map(n=>n.hash).sort(),[...PAGES].sort(),'public/session-cache.js PAGES = core pages');
 assert.deepEqual(pages.filter(n=>n.admin).map(n=>n.hash).sort(),[...ADMIN_PAGES].sort());
 // Every write route says its scope, and every core route's handler belongs to a core module.
 for(const r of registry.routes)assert.ok(r.method==='GET'||r.scope===null||SCOPES[r.scope],`${r.method} ${r.path??r.match}`);
 assert.equal(scopeFor('POST','/api/unknown',registry.match),null);assert.equal(scopeFor('GET','/api/unknown',registry.match),'read');
 const admin=registry.manifest({role:'admin'}),viewer=registry.manifest({role:'viewer'});
 assert.deepEqual(admin.nav.map(g=>g.labelKey||g.label),['Domov','Lokální AI','Inventář','Bezpečnost','Project Tracker','Správa']);
 assert.deepEqual(viewer.nav.map(g=>g.labelKey||g.label),['Domov','Lokální AI','Inventář','Project Tracker','Správa'],'admin-only groups disappear for other roles');
 assert.deepEqual(admin.nav[2].items.map(i=>i.hash),['inventory-map','versions']);assert.deepEqual(viewer.nav[2].items.map(i=>i.hash),['inventory-map']);
 // #services is still a page (it leads to the Services view of the inventory page), just not a sidebar entry.
 assert.ok(viewer.pages.find(p=>p.hash==='services').view,'the old services address stays routable');
 assert.ok(viewer.pages.find(p=>p.hash==='versions').admin&&!viewer.pages.find(p=>p.hash==='versions').view,'an admin page is listed for routing, without its module');
 assert.deepEqual(admin.pages.find(p=>p.hash==='overview').view,{url:'/home-view.js',export:'homePage'});
});

test('a loaded plugin: routes, scope checks, write log, MCP tool, manifest, assets, pollers, providers',async t=>{
 const plugins=await loadPlugins(fixtures);
 const h=await hub(t,{plugins,demoNotes:['first']});
 const cookie=h.admin,get=(url,headers=cookie)=>fetch(h.origin+url,{headers});
 // routes: sign-in required by default, patterns with params, the module's own error mapping
 assert.equal((await fetch(h.origin+'/api/demo/notes')).status,401);
 assert.deepEqual(await (await get('/api/demo/notes')).json(),{notes:['first'],site:'Example'});
 assert.deepEqual(await (await get('/api/demo/notes/0')).json(),{note:'first'});
 const missing=await get('/api/demo/notes/7');assert.equal(missing.status,404);assert.equal((await missing.json()).error.code,'DEMO_FAILED');
 assert.equal((await h.post('/api/demo/notes',{text:'second'},cookie)).status,201);
 assert.equal((await h.post('/api/demo/notes',{},cookie)).status,400);
 // scopes: the plugin's scope joined the table; keys need it for the write and may read without it
 assert.ok(SCOPES['demo:write']);assert.deepEqual(validScopes(['demo:write']),['read','demo:write']);assert.ok(legacyScopes('write').includes('demo:write'));
 const reader=await h.account('reader',[]),writer=await h.account('noter',['demo:write']);
 assert.equal((await get('/api/demo/notes',reader.headers)).status,200);
 const refused=await h.post('/api/demo/notes',{text:'x'},reader.headers);assert.equal(refused.status,403);assert.equal((await refused.json()).error.code,'SCOPE_REQUIRED');
 assert.equal((await h.post('/api/demo/notes',{text:'third'},writer.headers)).status,201);
 const audit=await (await get('/api/admin/audit')).json();
 assert.ok(audit.events.some(e=>e.event==='api-write'&&e.subject==='noter'&&e.detail==='/api/demo/notes · note-3'&&e.status===201),'the write log names what the route set as subject');
 assert.ok(audit.events.some(e=>e.event==='api-write'&&e.subject==='reader'&&e.status===403));
 const accounts=await (await get('/api/admin/accounts')).json();assert.equal(accounts.scopes['demo:write'].label,'Demo – zápis');
 // MCP: the tool is listed for a key that holds its scope and runs with the module's state
 const rpc=(body,headers)=>fetch(h.origin+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify({jsonrpc:'2.0',id:1,...body})}).then(r=>r.json());
 const tools=(await rpc({method:'tools/list'},reader.headers)).result.tools.map(x=>x.name);
 assert.ok(tools.includes('demo_notes')&&tools.includes('home_status'));
 const called=(await rpc({method:'tools/call',params:{name:'demo_notes',arguments:{}}},reader.headers)).result;
 // MCP instructions: the plugin's lines join the core ones; its scoped part only for a key that holds the scope
 const told=async headers=>(await rpc({method:'initialize',params:{}},headers)).result.instructions;
 assert.match(await told(reader.headers),/\nDemo: demo_notes lists the notes\.$/);assert.match(await told(writer.headers),/\nDemo: demo_notes lists the notes\. With demo:write: POST \/api\/demo\/notes adds one\.$/);
 assert.deepEqual(called.structuredContent,{notes:['first','second','third'],for:'reader'});
 // manifest: pages, sidebar, strings and API docs, filtered by role
 const anonymous=await (await fetch(h.origin+'/api/ui/manifest')).json();
 assert.deepEqual(anonymous,{site:{name:'Example',timeZone:'Europe/Berlin',defaultLanguage:'en',lanCidrs:['10.0.0.0/24']},edition:anonymous.edition,signedIn:false,pages:[],nav:[],modules:[],strings:{}});
 const m=await (await get('/api/ui/manifest')).json();
 assert.equal(m.signedIn,true);assert.deepEqual(m.pages.find(p=>p.hash==='demo').view,{url:'/plugins/demo/demo-view.js',export:'demoPage'});
 assert.deepEqual(m.nav.at(-1),{label:'Demo',labelKey:null,items:[{hash:'demo',label:'Notes',labelKey:null,soon:false,module:'demo'},{hash:'demo-admin',label:'Admin notes',labelKey:null,soon:false,module:'demo'},{hash:null,label:'Later',labelKey:null,soon:true,module:'demo'}]});
 assert.equal(m.strings.en['Demo – zápis'],'Demo – write');assert.ok(m.apiDocs.some(d=>d.title==='Demo'),'a plugin\'s API docs join the core ones');assert.ok(m.modules.some(x=>x.id==='demo'&&!x.core));
 assert.equal(m.inventory.places[0].id,'studio');
 // the MCP tools as people read them (Users and API → Connect): the plugin's tool next to the core ones, nothing callable
 assert.deepEqual(m.tools.find(x=>x.name==='demo_notes'),{name:'demo_notes',title:'Demo: notes',scope:'read',write:false,description:'The notes kept by the demo plugin.',module:'demo'});
 assert.equal(m.tools.find(x=>x.name==='home_status').module,'core');
 const user=await h.post('/api/admin/users',{username:'viewer1',name:'V',password:'viewer-password-123'},cookie);assert.equal(user.status,201);
 const vLogin=await h.post('/api/session',{username:'viewer1',password:'viewer-password-123'}),vCookie={Cookie:vLogin.headers.get('set-cookie').split(';')[0]};
 const vm=await (await get('/api/ui/manifest',vCookie)).json();
 assert.deepEqual(vm.nav.at(-1).items.map(i=>i.label),['Notes','Later'],'the admin-only entry is not in a viewer\'s sidebar');
 assert.equal(vm.pages.find(p=>p.hash==='demo-admin').view,undefined);
 // assets: under the plugin prefix only, and nothing else from the plugin directory
 const asset=await fetch(h.origin+'/plugins/demo/demo-view.js');assert.equal(asset.status,200);assert.match(asset.headers.get('content-type'),/javascript/);
 assert.match(await asset.text(),/export function demoPage/);
 for(const url of ['/demo-view.js','/plugins/demo/index.mjs','/plugins/demo/../demo/index.mjs','/plugins/demo/%2e%2e/index.mjs','/plugins/other/demo-view.js'])assert.equal((await fetch(h.origin+url)).status,404,url);
 // pollers and providers
 const handler=h.handler;await handler.start();assert.equal(handler.state('demo').ticks,1);await handler.stop();assert.equal(handler.state('demo').stopped,true);
 assert.deepEqual(handler.hub.collect('home.snapshots'),[{mini:{bridge:'demo',snapshot:null,notes:3}}]);
 const home=await (await get('/api/home')).json();assert.equal(home.machines.find(x=>x.id==='mini').bridge,'demo','core merges what providers return into the tiles');
});

test('the browser shell takes its pages from the manifest, not from a table of its own',async()=>{
 const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
 assert.match(app,/fetch\('\/api\/ui\/manifest'\)/);assert.match(app,/setPages\(manifest\.pages\)/);assert.match(app,/manifest\.nav\.map\(group\)/);
 assert.doesNotMatch(app,/import \{[^}]*\b(securityView|trackerView|reviewView|accessView|inventoryView|systemsView)\b/,'page modules are imported on demand');
});
