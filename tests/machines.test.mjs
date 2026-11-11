// Integrations → Machines (server/machine-facets.mjs, server/machine-facet-sources.mjs, public/machines-view.js):
// every machine once, with what each module knows about it. The join (fallbacks, off, order, counts, garbage
// dropped), each core facet's rules, the admin-only route on the generic fixture hub, and the page in English.
import test from 'node:test';
import assert from 'node:assert/strict';
import {hub,SITE} from './hub-helper.mjs';
import {buildMachines,normalizeReports,machineForHost,machineState} from '../server/machine-facets.mjs';
import {telemetryFacet,runtimesFacet,securityFacets,inventoryFacet,gitLfsFacet} from '../server/machine-facet-sources.mjs';
import {installDom} from './fixtures/mini-dom.mjs';

const M=[{id:'mini',name:'Mac mini',hostname:'mini.example.lan',ip:'10.0.0.25',source:'site'},{id:'win',name:'PC',hostname:'win.example.lan',ip:'10.0.0.28',source:'added'}];

test('the join: a machine a report does not name gets its fallback; off wins; first report of an id wins; garbage is dropped',()=>{
 const reports=normalizeReports([
  {id:'backups',title:'Zálohy',order:20,page:'backup-jobs',howTo:'Založ úlohu.',machines:{mini:{state:'ok',summary:'Ukládají se sem zálohy.'}}},
  {id:'telemetry',title:'Telemetrie',order:10,machines:{mini:{state:'weird'},win:{state:'stale',href:'javascript:alert(1)'}}},
  {id:'git-lfs',title:'Git LFS',order:70,machines:{},fallback:{state:'not-applicable'}},
  {id:'versions',title:'Verze',order:30,off:true,machines:{mini:{state:'ok'}}},
  {id:'backups',title:'Duplicate',machines:{win:{state:'ok'}}},
  {id:'Bad Id',title:'x',machines:{}},{title:'no id',machines:{}},null,'text']);
 const doc=buildMachines(M,reports);
 assert.deepEqual(doc.facets.map(f=>f.id),['telemetry','backups','versions','git-lfs'],'by order, one per id');
 const [mini,win]=doc.machines;
 assert.deepEqual(mini.facets.map(f=>f.state),['error','ok','off','not-applicable'],'an unknown state is an error, never ok');
 assert.deepEqual(win.facets.map(f=>f.state),['stale','not-configured','off','not-applicable']);
 assert.equal(win.facets[1].summary,'Založ úlohu.','the fallback says how to set it up');
 assert.equal(win.facets[1].href,'#backup-jobs','and links to the page that does');
 assert.equal(win.facets[0].href,null,'only #hash links are passed on');
 assert.deepEqual(mini.counts,{ok:1,attention:1,notConfigured:0,off:1});assert.equal(mini.state,'error');
 assert.deepEqual(win.counts,{ok:0,attention:1,notConfigured:1,off:1});assert.equal(win.state,'warn');
 assert.equal(machineState([{state:'not-configured'},{state:'not-applicable'}]),'not-configured');
});

test('a host names a machine by id, host name, its first label or IP; nothing else',()=>{
 assert.equal(machineForHost(M,'MINI.example.lan')?.id,'mini');assert.equal(machineForHost(M,'10.0.0.28')?.id,'win');
 assert.equal(machineForHost(M,'mini')?.id,'mini');assert.equal(machineForHost(M,'mini.local')?.id,'mini');
 assert.equal(machineForHost(M,'minis.example.lan'),null);assert.equal(machineForHost(M,'10.0.0.2'),null);assert.equal(machineForHost(M,''),null);
});

test('telemetry: which provider reads it, off when that provider is turned off, the router is not applicable',()=>{
 const f=telemetryFacet([
  {id:'a',thermo:'a',telemetry:{state:'ok',thermoId:'a',ageSeconds:4}},
  {id:'b',thermo:'b',telemetry:{state:'unreachable',provider:'node-exporter',target:'b.example.lan:9100',detail:'timeout'}},
  {id:'c',telemetry:{state:'not-installed'}},{id:'r',kind:'router',telemetry:{state:'not-applicable'}},
  {id:'d',thermo:'d',telemetry:{state:'stale',provider:'winrm'}}],{enabled:id=>id!=='home.winrm'});
 assert.equal(f.machines.a.state,'ok');assert.match(f.machines.a.summary.text,/Thermo/);
 assert.equal(f.machines.b.state,'error');assert.ok(f.machines.b.details.some(d=>d.value==='b.example.lan:9100'));
 assert.equal(f.machines.c.state,'not-configured');assert.equal(f.machines.r.state,'not-applicable');
 assert.equal(f.machines.d.state,'off','WinRM is turned off in Integrations');
});

test('runtimes, versions, protection, SSH keys, inventory and Git LFS facets follow their sources',()=>{
 const r=runtimesFacet([{id:'s',runtimes:{runtimes:[{id:'x',name:'llama-swap',status:'running'},{id:'y',name:'oMLX',status:'stopped'}]}},{id:'n',runtimes:null}]);
 assert.equal(r.machines.s.state,'warn');assert.match(r.machines.s.summary.text,/llama-swap, oMLX · běží 1 z 2/);assert.equal(r.machines.n,undefined);assert.equal(r.fallback.state,'not-applicable');

 const site={machines:[{id:'mini',ssh:{probe:'mac',keys:true}},{id:'nas',ssh:{probe:'nas'}},{id:'gone',ssh:{probe:'mac'}},{id:'r'}]};
 const systems={machines:[{id:'mini',reachable:true,summary:{osUpdate:1,softwareUpdates:2,appUpdates:0,checks:{warn:1,crit:0}}},{id:'nas',reachable:false,error:'timeout'}]};
 const [versions,protection,keys]=securityFacets([{id:'mini'},{id:'nas'},{id:'gone'},{id:'r'}],{site,systems,security:{machines:[{id:'mini',reachable:true,accounts:[1,2],collectedAt:new Date().toISOString()}]}});
 assert.equal(versions.machines.mini.state,'warn');assert.match(versions.machines.mini.summary.text,/3/);
 assert.equal(protection.machines.mini.state,'warn');assert.equal(versions.machines.nas.state,'error');
 assert.equal(versions.machines.gone.state,'stale','probed but never read');assert.equal(versions.machines.r,undefined,'not probed: the fallback says how');
 assert.equal(keys.machines.mini.state,'ok');assert.equal(keys.machines.nas,undefined);
 const off=securityFacets([{id:'mini'}],{site,systems:null,security:null,on:{systems:false,keys:true}});assert.equal(off[0].off,true);assert.equal(off[2].off,false);

 const inv=inventoryFacet([{id:'studio'},{id:'mini'}],[{id:'studio',kind:'machine'},{id:'a',machine:'studio'},{id:'b',machine:'studio'}]);
 assert.equal(inventoryFacet([{id:'mini_server'}],[{id:'mini-server',kind:'machine'},{id:'f',machine:'mini-server'}]).machines.mini_server.summary.parts[0].params.n,1,'mini-server in the inventory is mini_server in the site');
 assert.equal(inv.machines.studio.state,'ok');assert.equal(inv.machines.studio.summary.parts[0].params.n,2);assert.equal(inv.machines.mini,undefined);

 const entries=[{id:'forgejo',kind:'runtime',name:'Forgejo',machine:'mini-server',address:'https://git.example.lan',depends_on:[{id:'s3'}]},{id:'s3',kind:'runtime',name:'SeaweedFS object store',machine:'mini'}];
 const lfs=gitLfsFacet([{id:'mini'},{id:'mini_server'},{id:'nas'}],{connections:[{name:'homegit',web:'https://git.example.lan'}],entries});
 assert.equal(lfs.machines.mini_server.summary,'Běží tu git host.');assert.equal(lfs.machines.mini.summary,'Ukládá LFS soubory git hostu.');assert.equal(lfs.machines.nas,undefined);
});

test('GET /api/admin/machines: every overview machine with its facets, for an administrator only',async t=>{
 const h=await hub(t);
 const r=await fetch(h.origin+'/api/admin/machines',{headers:h.admin});assert.equal(r.status,200);
 const doc=await r.json();
 assert.deepEqual(doc.machines.map(m=>m.id),SITE.machines.map(m=>m.id));
 for(const id of ['telemetry','backups','versions','protection','ssh-keys','inventory','runtimes','git-lfs'])assert.ok(doc.facets.some(f=>f.id===id),id);
 const by=(m,f)=>doc.machines.find(x=>x.id===m).facets.find(x=>x.id===f);
 assert.equal(by('studio','inventory').state,'ok');assert.equal(by('mini','inventory').state,'not-configured');
 assert.equal(by('router','telemetry').state,'not-applicable');assert.equal(by('mini','backups').state,'not-configured');
 assert.equal(by('mini','versions').state,'stale','probed in the site, never collected');assert.equal(by('router','versions').state,'not-configured');
 assert.equal(by('mini','git-lfs').state,'not-applicable');
 assert.ok(doc.telemetry,'what the add-machine dialog needs');
 // A collector turned off shows as off on every machine.
 assert.equal((await h.post('/api/admin/integrations/toggle',{id:'security.systems',enabled:false},h.admin)).status,200);
 const after=await (await fetch(h.origin+'/api/admin/machines',{headers:h.admin})).json();
 assert.ok(after.machines.every(m=>m.facets.find(f=>f.id==='versions').state==='off'));
 // Not for a key, nor without a sign-in.
 const key=await h.account('reader',['read','security:read']);
 assert.equal((await fetch(h.origin+'/api/admin/machines',{headers:key.headers})).status,403);
 assert.equal((await fetch(h.origin+'/api/admin/machines')).status,401);
});

test('the page: machine cards and one machine, in English, with set-up links where something is missing',async()=>{
 installDom();globalThis.location={hash:'#integrations',origin:'http://127.0.0.1'};
 const i18n=await import('../public/i18n.js');i18n.setLang('en');
 const {machinesSection,machinePage,countsLine}=await import('../public/machines-view.js');
 const doc=buildMachines(M,normalizeReports([
  {id:'telemetry',title:'Telemetrie',icon:'pulse',order:10,page:'overview',machines:{mini:{state:'ok',summary:'Čte {provider}.',summaryT:[{key:'Čte {provider}.',params:{provider:'Thermo'}}],details:[{label:'Zdroj',value:'Thermo'}]}}},
  {id:'backups',title:'Zálohy',icon:'archive',order:20,page:'backup-jobs',howTo:'Žádná úloha záloh na tenhle stroj neukládá ani ho nezálohuje. Založ ji na stránce Zálohování.',machines:{}}]));
 const list=machinesSection(doc,{onAdd:()=>{}}),one=machinePage(doc,'mini'),txt=n=>n.textContent;
 const CZECH=/[ěščřžýáíéůúťďňĚŠČŘŽÝÁÍÉŮÚ]/;
 assert.ok(txt(list).includes('Machines'));assert.ok(txt(list).includes('Add machine'));assert.equal(CZECH.test(txt(list)),false,txt(list));
 assert.ok(txt(one).includes('Read by Thermo.'));assert.ok(txt(one).includes('Set up'));assert.ok(txt(one).includes('partly set up'));assert.equal(CZECH.test(txt(one)),false,txt(one));
 assert.equal(countsLine({ok:2,notConfigured:1}),'2 OK · 1 not set up');
 assert.ok(txt(machinePage(doc,'nope')).includes('Unknown machine'));
 i18n.setLang('cs');
});

test('who does the work and a prompt for an agent: filled per machine, offered only where something is missing, all in English',async()=>{
 const {HOW,PROMPTS}=await import('../server/machine-facet-sources.mjs');
 const {INTEGRATION_PROMPT,HOW_BY}=await import('../server/machine-facets.mjs');
 const en=(await import('../public/i18n-en.js')).default;
 for(const h of Object.values(HOW)){assert.ok(HOW_BY.includes(h.by),h.by);assert.ok(en[h.text],h.text);}
 for(const p of [...Object.values(PROMPTS),INTEGRATION_PROMPT])assert.ok(en[p],p.slice(0,60));
 const doc=buildMachines(M,normalizeReports({id:'inventory',title:'Inventář',how:HOW.inventory,prompt:PROMPTS.inventory,machines:{mini:{state:'ok'}}}));
 const [mini,win]=doc.machines.map(m=>m.facets[0]);
 assert.equal(mini.how.by,'agent');assert.equal(mini.prompt,undefined,'nothing to do where it works');
 assert.match(win.prompt,/„PC“ \(id win, win\.example\.lan\)/);assert.deepEqual(win.promptT[0].params,{id:'win',name:'PC',hostname:'win.example.lan'});
});

test('an integration that names its machines shows on those machines only, in the state of its item',async()=>{
 const {integrationReport}=await import('../server/machine-facets.mjs');
 const integration={id:'demo.bridge',title:'Mosty',kind:'bridge',description:'Most na Macy.',howTo:'Spusť most.'};
 const status={state:'stale',items:[{id:'mini',state:'ok',summary:'Připojeno.'},{id:'win',state:'not-configured',summary:'Nenastaveno.'}]};
 const doc=buildMachines([...M,{id:'nas',name:'NAS'}],normalizeReports(integrationReport(integration,status,[{machine:'mini',item:'mini'},{machine:'win',item:'win'}])));
 const by=id=>doc.machines.find(m=>m.id===id).facets;
 assert.equal(by('mini')[0].state,'ok');assert.equal(by('mini')[0].how.by,'integration');assert.equal(by('mini')[0].id,'int-demo-bridge');
 assert.equal(by('win')[0].state,'not-configured');assert.match(by('win')[0].prompt,/„Mosty“ pro stroj „PC“.*Spusť most\./);
 assert.deepEqual(by('nas'),[],'a machine the integration does not name does not get it');
 const off=buildMachines(M,normalizeReports(integrationReport(integration,{state:'disabled',items:status.items},['mini'])));
 assert.equal(off.machines[0].facets[0].state,'off','turned off by an administrator');
});

test('the router page shows the router adapter; the page lists who does what and the prompt, in English',async t=>{
 const h=await hub(t);
 const doc=await (await fetch(h.origin+'/api/admin/machines',{headers:h.admin})).json();
 const ids=id=>doc.machines.find(m=>m.id===id).facets.map(f=>f.id);
 assert.ok(ids('router').includes('int-router-adapter'));assert.equal(ids('mini').includes('int-router-adapter'),false);
 installDom();globalThis.location={hash:'#integrations',origin:'http://127.0.0.1'};
 const i18n=await import('../public/i18n.js');i18n.setLang('en');
 const {machinePage}=await import('../public/machines-view.js');
 const page=machinePage(doc,'mini'),txt=page.textContent;
 assert.ok(txt.includes('Who does what'));assert.ok(txt.includes('An agent over MCP'));
 assert.ok(txt.includes('Record the machine "Mac mini" (id mini'),'the inventory prompt, filled in and translated');
 assert.equal(/[ěščřžýáíéůúťďňĚŠČŘŽÝÁÍÉŮÚ„“]/.test(txt),false,txt.match(/.{40}[ěščřžýáíéůúťďň„“].{40}/)?.[0]);
 i18n.setLang('cs');
});

test('an integration\'s machines must be a function',async()=>{
 const {defineModule}=await import('../server/plugins.mjs');
 const base={id:'alpha',integrations:[{id:'alpha.x',title:'X',kind:'other',status:()=>({state:'ok'})}]};
 assert.equal(typeof defineModule({...base,integrations:[{...base.integrations[0],machines:()=>['mini']}]}).integrations[0].machines,'function');
 assert.throws(()=>defineModule({...base,integrations:[{...base.integrations[0],machines:['mini']}]}),/machines must be a function/);
});
