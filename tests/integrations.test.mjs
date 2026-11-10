// Integrations (server/integrations.mjs, server/core/integrations.mjs): the declaration the registry
// accepts, the enable/disable state file, the admin API with its audit, write-only settings, what the
// pages of a turned-off integration answer, and the read-only MCP summary.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,stat,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {hub} from './hub-helper.mjs';
import {defineModule,createRegistry} from '../server/plugins.mjs';
import {createIntegrationStore,normalizeStatus,worstState,settingsInput,runStatus} from '../server/integrations.mjs';
import {createThermoPoller} from '../server/thermo-client.mjs';

const tmp=async t=>{const dir=await mkdtemp(path.join(os.tmpdir(),'hub-int-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;};
const rpc=(h,headers,method,params)=>fetch(h.origin+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',...headers},body:JSON.stringify({jsonrpc:'2.0',id:1,method,...(params?{params}:{})})});

// A plugin with one integration of every feature: a provider it silences, a poller it skips, a test, settings.
function demoPlugin(calls){
 return {id:'demo-int',title:'Demo integration plugin',
  setup:hub=>({hub,polled:0,saved:null}),
  pollers:[{id:'tick',start:state=>{state.polled++;}}],
  provides:{'home.snapshots':()=>({mini:{snapshot:{services:[],collectedAt:new Date().toISOString()},bridge:'connected'}}),'demo.value':()=>42},
  integrations:[
   {id:'demo-int.feed',title:'Demo feed',kind:'bridge',description:'A test feed.',provides:['home.snapshots','demo.value'],
    status:(state,hub,{enabled})=>{calls.push(['status',enabled]);return {state:'ok',summary:'Vše běží.',lastSuccessAt:'2026-11-10T10:00:00Z',configuredBy:[{source:'env',name:'DEMO_SOCKET'},{source:'nowhere',name:'x'}],
     items:[{id:'a',label:'Part A',state:'ok',summary:'fine'},{id:'b',label:'Part B',state:'weird',summary:'?'}]};},
    test:(state)=>{calls.push(['test']);return {state:'stale',summary:'Tested.',lastError:'token=abcdefgh12345'};},
    settings:{schema:[{key:'interval',label:'Interval',type:'select',options:[15,30]},{key:'note',label:'Note',type:'text'},{key:'apiKey',label:'API key',type:'text',secret:true}],
     read:state=>({interval:state.saved?.interval??15,note:state.saved?.note??''}),
     write:(state,hub,values)=>{state.saved={...state.saved,...values};}}},
   {id:'demo-int.fixed',title:'Fixed',kind:'other',toggle:false,toggleNote:'Jen přes env.',status:()=>({state:'off',summary:'Off by env.'})},
  ]};
}
const start=async(t,extra={})=>{const dir=await tmp(t),calls=[];const h=await hub(t,{plugins:[demoPlugin(calls)],integrationSecretsFile:path.join(dir,'private','integrations.json'),...extra});return {...h,calls,secrets:path.join(dir,'private','integrations.json')};};

test('the registry accepts integrations only in the declared shape and refuses clashes',()=>{
 const base={id:'alpha',provides:{'x.y':()=>1}};
 const ok=defineModule({...base,integrations:[{id:'alpha.feed',title:'Feed',kind:'telemetry',provides:['x.y'],status:()=>({state:'ok'})}]});
 assert.equal(ok.integrations[0].toggle,true,'toggle defaults to on');
 assert.deepEqual(createRegistry([ok]).integrations.map(i=>i.id),['alpha.feed']);
 const refuses=(integrations,pattern)=>assert.throws(()=>defineModule({...base,integrations}),pattern);
 refuses([{id:'beta.feed',title:'F',kind:'telemetry',status:()=>{}}],/must start with this module's id/);
 refuses([{id:'alpha',title:'F',kind:'telemetry',status:()=>{}}],/<module>\.<name>/);
 refuses([{id:'alpha.feed',title:'F',kind:'weather',status:()=>{}}],/kind must be one of/);
 refuses([{id:'alpha.feed',title:'F',kind:'other'}],/needs status/);
 refuses([{id:'alpha.feed',title:'F',kind:'other',status:()=>{},colour:'red'}],/unknown field/);
 refuses([{id:'alpha.feed',title:'F',kind:'other',status:()=>{}},{id:'alpha.feed',title:'G',kind:'other',status:()=>{}}],/listed twice/);
 refuses([{id:'alpha.feed',title:'F',kind:'other',provides:['nope'],status:()=>{}}],/does not provide/);
 refuses([{id:'alpha.feed',title:'F',kind:'other',status:()=>{},settings:{schema:[{key:'n',label:'N',type:'number',secret:true}],read(){},write(){}}}],/only a text field can be secret/);
 assert.throws(()=>createRegistry([ok,defineModule({...base})]),/module id "alpha" is registered twice/);
});

test('a status is bounded: unknown states are errors, secrets and unknown sources are dropped',()=>{
 const s=normalizeStatus({state:'great',summary:'x'.repeat(500),lastError:'password=hunter2hunter2',lastSuccessAt:'nope',configuredBy:[{source:'env',name:'A'},{source:'disk',name:'B'},{source:'file',name:'token=abcdef123456'}],
  items:[{id:'i',state:'ok',summary:{text:'Čte {n}.',parts:[{key:'Čte {n}.',params:{n:3}}]}}]});
 assert.equal(s.state,'error');assert.equal(s.summary.length,240);assert.equal(s.lastError,'error');assert.equal(s.lastSuccessAt,null);
 assert.deepEqual(s.configuredBy,[{source:'env',name:'A'}]);
 assert.deepEqual(s.items[0].summaryT,[{key:'Čte {n}.',params:{n:3}}]);
 assert.equal(normalizeStatus(null).state,'error');
 assert.equal(worstState([]),'not-configured');assert.equal(worstState(['ok','ok']),'ok');assert.equal(worstState(['ok','error']),'stale');
 assert.equal(worstState(['error','not-configured']),'error');assert.equal(worstState(['off']),'off');
 assert.throws(()=>settingsInput([{key:'n',type:'number',min:1,max:5}],{values:{n:9}}),/invalid/);
 assert.throws(()=>settingsInput([{key:'s',type:'text'}],{values:{s:'api_key=abcdefgh1234'}}),e=>/looks like a secret/.test(e.detail));
 assert.deepEqual(settingsInput([{key:'k',type:'text',secret:true}],{values:{k:''},clear:['k']}),{plain:{},secrets:{},clear:['k']});
});

test('the state file: missing means everything on; a change is written, heard and survives a restart',async t=>{
 const dir=await tmp(t);
 const store=createIntegrationStore(dir),heard=[];store.onChange(e=>heard.push(e));
 assert.equal(store.enabled('home.thermo'),true);
 assert.equal((await store.set('home.thermo',false,'alice')).changed,true);
 assert.equal((await store.set('home.thermo',false,'alice')).changed,false,'turning off what is off changes nothing');
 const file=JSON.parse(await readFile(path.join(dir,'integrations.json'),'utf8'));
 assert.equal(file.schemaVersion,1);assert.equal(file.disabled['home.thermo'].by,'alice');assert.ok(Date.parse(file.disabled['home.thermo'].at));
 assert.equal((await stat(path.join(dir,'integrations.json'))).mode&0o777,0o600);
 assert.equal(createIntegrationStore(dir).enabled('home.thermo'),false,'read back on start');
 await store.set('home.thermo',true,'alice');assert.deepEqual(heard.map(e=>e.enabled),[false,true]);
 await writeFile(path.join(dir,'integrations.json'),'{not json');
 const broken=createIntegrationStore(dir);assert.equal(broken.enabled('home.thermo'),true,'an unreadable file leaves everything on');
 const slow=await runStatus({status:()=>new Promise(()=>{})},{},{},{timeoutMs:20});assert.equal(slow.state,'error');assert.equal(slow.lastError,'timeout');
 const off=await runStatus({status:()=>({state:'ok',configuredBy:[{source:'env',name:'X'}]})},{},{},{enabled:false});assert.equal(off.state,'disabled');assert.deepEqual(off.configuredBy,[{source:'env',name:'X'}]);
});

test('admin API: list, toggle with audit, silenced providers, test, settings with write-only values',async t=>{
 const h=await start(t);
 const get=headers=>fetch(h.origin+'/api/admin/integrations',{headers});
 assert.equal((await get({})).status,401);
 const reader=await h.account('reader',[]);
 assert.equal((await get(reader.headers)).status,403,'no API key reaches the admin API');
 assert.equal((await h.post('/api/admin/integrations/toggle',{id:'demo-int.feed',enabled:false},reader.headers)).status,403);
 const list=await (await get(h.admin)).json();
 const ids=list.integrations.map(i=>i.id);
 for(const id of ['home.thermo','router.adapter','security.systems','security.upstream','security.keys','demo-int.feed','demo-int.fixed'])assert.ok(ids.includes(id),id);
 const feed=list.integrations.find(i=>i.id==='demo-int.feed');
 assert.equal(feed.status.state,'ok');assert.deepEqual(feed.status.configuredBy,[{source:'env',name:'DEMO_SOCKET'}]);assert.equal(feed.status.items[1].state,'error');
 assert.equal(feed.enabled,true);assert.equal(feed.test,true);assert.equal(feed.module,'demo-int');assert.equal(feed.core,false);
 assert.deepEqual(list.plugins,[{id:'demo-int',title:'Demo integration plugin',integrations:['demo-int.feed','demo-int.fixed']}]);
 const hubState=h.handler.hub;
 assert.equal(hubState.provided('demo.value'),42);

 // Off: written, audited, the providers it lists answer nothing, its status says disabled, its test is refused.
 const off=await h.post('/api/admin/integrations/toggle',{id:'demo-int.feed',enabled:false},h.admin);
 assert.equal(off.status,200);const offRow=(await off.json()).integration;
 assert.equal(offRow.enabled,false);assert.equal(offRow.disabledBy,'admin');assert.equal(offRow.status.state,'disabled');
 assert.equal(hubState.provided('demo.value'),undefined);assert.deepEqual(hubState.collect('home.snapshots'),[]);
 assert.equal(hubState.integrationEnabled('demo-int.feed'),false);assert.equal(hubState.integrationDisabled('demo-int.feed').by,'admin');
 assert.ok(h.calls.some(([k,enabled])=>k==='status'&&enabled===false),'status hears that it is off');
 const refused=await h.post('/api/admin/integrations/test',{id:'demo-int.feed'},h.admin);assert.equal(refused.status,409);assert.equal((await refused.json()).error.code,'INTEGRATION_DISABLED');
 const home=await (await fetch(h.origin+'/api/home',{headers:h.admin})).json();
 assert.deepEqual(home.integrations.disabled.map(i=>i.id),['demo-int.feed'],'the overview says what is off');
 const state=JSON.parse(await readFile(path.join(h.dir,'integrations.json'),'utf8'));assert.equal(state.disabled['demo-int.feed'].by,'admin');

 // On again, without a restart.
 assert.equal((await h.post('/api/admin/integrations/toggle',{id:'demo-int.feed',enabled:true},h.admin)).status,200);
 assert.equal(hubState.provided('demo.value'),42);
 const tested=await (await h.post('/api/admin/integrations/test',{id:'demo-int.feed'},h.admin)).json();
 assert.equal(tested.result.state,'stale');assert.equal(tested.result.lastError,'error','a secret-looking error is not passed on');

 // toggle:false refuses; bad input names what is wrong.
 const locked=await h.post('/api/admin/integrations/toggle',{id:'demo-int.fixed',enabled:false},h.admin);assert.equal(locked.status,409);assert.equal((await locked.json()).error.code,'INTEGRATION_LOCKED');
 assert.equal((await h.post('/api/admin/integrations/toggle',{id:'demo-int.feed',enabled:'no'},h.admin)).status,400);
 assert.equal((await h.post('/api/admin/integrations/toggle',{id:'nope.nope',enabled:false},h.admin)).status,404);
 assert.equal((await h.post('/api/admin/integrations/toggle',{id:'demo-int.feed',enabled:false},{...h.admin,Origin:'https://evil.example'})).status,403);

 // Settings: plain values go to write(); the write-only one is stored 0600 and answered {set}, never shown.
 const saved=await h.post('/api/admin/integrations/settings',{id:'demo-int.feed',values:{interval:'30',note:'kitchen',apiKey:'sk-test-value-123'}},h.admin);
 assert.equal(saved.status,200);const row=(await saved.json()).integration;
 assert.deepEqual(row.settings.values,{interval:30,note:'kitchen',apiKey:{set:true}});
 assert.equal(hubState.integrationSecret('demo-int.feed','apiKey'),'sk-test-value-123');
 assert.equal((await stat(h.secrets)).mode&0o777,0o600);
 const listed=await (await get(h.admin)).text();assert.ok(!listed.includes('sk-test-value-123'),'a write-only value never comes back');
 assert.equal((await h.post('/api/admin/integrations/settings',{id:'demo-int.feed',values:{color:'red'}},h.admin)).status,400);
 assert.equal((await h.post('/api/admin/integrations/settings',{id:'demo-int.feed',values:{note:'token=abcdef123456'}},h.admin)).status,400);
 assert.equal((await h.post('/api/admin/integrations/settings',{id:'demo-int.fixed',values:{}},h.admin)).status,409);
 const cleared=await (await h.post('/api/admin/integrations/settings',{id:'demo-int.feed',clear:['apiKey']},h.admin)).json();
 assert.deepEqual(cleared.integration.settings.values.apiKey,{set:false});assert.equal(hubState.integrationSecret('demo-int.feed','apiKey'),null);

 // The access audit has who and when, never a value.
 const audit=await (await fetch(h.origin+'/api/admin/audit?kind=access',{headers:h.admin})).json();
 const mine=audit.events.filter(e=>e.event.startsWith('integration-'));
 assert.deepEqual(mine.map(e=>e.event).sort(),['integration-disabled','integration-enabled','integration-secret-cleared','integration-settings','integration-tested'].sort());
 assert.ok(mine.every(e=>e.by==='admin'&&e.id==='demo-int.feed'&&e.subject==='Demo feed'));
 assert.equal(mine.find(e=>e.event==='integration-settings').detail,'interval, note, apiKey');
 assert.ok(!JSON.stringify(audit).includes('sk-test-value-123'));
});

test('MCP: integrations_status is read-only and says ids, kinds, states and summaries only',async t=>{
 const h=await start(t);const reader=await h.account('reader',[]);
 const tools=(await (await rpc(h,reader.headers,'tools/list')).json()).result.tools.map(x=>x.name);
 assert.ok(tools.includes('integrations_status'));assert.ok(!tools.some(n=>/integration.*(toggle|enable|disable|set)/.test(n)),'no switch over MCP');
 const out=JSON.parse((await (await rpc(h,reader.headers,'tools/call',{name:'integrations_status',arguments:{}})).json()).result.content[0].text);
 const feed=out.integrations.find(i=>i.id==='demo-int.feed');
 assert.deepEqual(Object.keys(feed).sort(),['id','kind','state','summary']);assert.equal(feed.state,'ok');
});

test('a generic hub: honest not-configured cards, and pages of a turned-off integration answer "disabled"',async t=>{
 const h=await start(t,{plugins:[]});
 const list=await (await fetch(h.origin+'/api/admin/integrations',{headers:h.admin})).json();
 const by=id=>list.integrations.find(i=>i.id===id);
 assert.equal(by('home.thermo').status.state,'not-configured');assert.ok(by('home.thermo').howTo);
 assert.equal(by('router.adapter').status.state,'not-configured');
 assert.equal(by('security.systems').status.state,'stale','configured in the site (ssh probes), never ran');
 assert.equal(by('security.upstream').status.items.find(i=>i.id==='github-token').summary.length>0,true);
 assert.ok(!JSON.stringify(list).includes(process.env.GITHUB_TOKEN||'\u0000no-token'),'a token value is never in the answer');
 assert.deepEqual(list.plugins,[]);

 for(const id of ['router.adapter','security.systems','security.keys','home.thermo'])assert.equal((await h.post('/api/admin/integrations/toggle',{id,enabled:false},h.admin)).status,200);
 const router=await (await fetch(h.origin+'/api/router',{headers:h.admin})).json();
 assert.equal(router.state,'disabled');assert.equal(router.disabled.by,'admin');assert.equal(router.provenance.kinds[0].state,'disabled');
 const systems=await fetch(h.origin+'/api/systems',{headers:h.admin});assert.equal(systems.status,200);
 const sdoc=await systems.json();assert.equal(sdoc.disabled.id,'security.systems');assert.deepEqual(sdoc.machines,[]);assert.equal(sdoc.provenance.kinds[0].state,'disabled');
 const keys=await (await fetch(h.origin+'/api/security',{headers:h.admin})).json();assert.equal(keys.disabled.id,'security.keys');
 const collectors=await (await fetch(h.origin+'/api/collectors',{headers:h.admin})).json();
 assert.equal(collectors.collectors.systems.state,'disabled');assert.equal(collectors.collectors.security.state,'disabled');
 const history=await (await fetch(h.origin+'/api/home/history?machine=mini&range=30m',{headers:h.admin})).json();
 assert.equal(history.source,'vypnuto');assert.deepEqual(history.points,[]);
 const home=await (await fetch(h.origin+'/api/home',{headers:h.admin})).json();
 assert.deepEqual(home.integrations.disabled.map(i=>i.id).sort(),['home.thermo','router.adapter','security.keys','security.systems']);
});

test('the Thermo poller pauses and resumes without a restart',async t=>{
 const dir=await tmp(t);let opened=0;
 const poller=createThermoPoller({hostsFile:path.join(dir,'none.json'),stateDirectory:dir,extraHosts:async()=>{opened++;return [];}});
 await poller.start();assert.equal(opened,1);
 await poller.pause();assert.equal(poller.paused(),true);assert.equal(await poller.refresh(),false,'no pull while paused');
 await poller.resume();assert.equal(poller.paused(),false);assert.equal(opened,2,'hosts are read again on resume');
 poller.stop();
 const late=createThermoPoller({hostsFile:path.join(dir,'none.json'),stateDirectory:dir,extraHosts:async()=>{opened++;return [];}});
 await late.pause();await late.start();assert.equal(opened,2,'started while off: nothing is opened');
 await late.resume();assert.equal(opened,3);late.stop();
});
