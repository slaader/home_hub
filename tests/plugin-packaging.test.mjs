// Plugins as a separate unit (docs/plugins.md → plugin.json, Importing core, Where plugins are): the static manifest and
// what it refuses, several plugin directories, plugin sources, the named exports home-hub/plugin-api and
// home-hub/testing, a plugin outside the core tree through one link, and the test runner for a plugin source.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,symlink,readlink} from 'node:fs/promises';
import {existsSync,realpathSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadPlugins,pluginsDirectories,readInstance,pluginSource,coreSeenFrom,checkCoreLink,CORE_VERSION} from '../server/plugins.mjs';
import {startupLine,buildRegistry} from '../server/index.mjs';
import {provenance} from '../server/provenance.mjs';
import * as api from '../server/plugin-api.mjs';
import * as testing from './plugin-testing.mjs';
import {linkCore,listPlugins} from '../scripts/plugins.mjs';
import {hub} from './hub-helper.mjs';
import {repoRoot} from '../server/edition.mjs';

const fixtures=fileURLToPath(new URL('./fixtures/plugins/',import.meta.url));
// Outside the checkout: os.tmpdir() is never under the core tree.
const temp=async(t,prefix='hub-pkg-')=>{const dir=realpathSync(await mkdtemp(path.join(os.tmpdir(),prefix)));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;};
// A plugin directory <dir>/<id>/ with index.mjs and, when manifest is not null, plugin.json.
async function plugin(dir,id,{manifest={id,version:'1.0.0',core:'>=1.0.0 <2.0.0'},code=`export default {id:'${id}',title:'${id}'};`,files={}}={}){
 await mkdir(path.join(dir,id),{recursive:true});await writeFile(path.join(dir,id,'index.mjs'),code);
 if(manifest!==null)await writeFile(path.join(dir,id,'plugin.json'),typeof manifest==='string'?manifest:JSON.stringify(manifest));
 for(const [name,body] of Object.entries(files)){await mkdir(path.dirname(path.join(dir,id,name)),{recursive:true});await writeFile(path.join(dir,id,name),body);}
}
const quiet={warn:()=>{}};

test('the plugin API and the testing export are what plugins import by name, and resolve to this core',async()=>{
 const named=await import('home-hub/plugin-api');
 assert.equal(named,api,'one module instance whether imported by name or by path');
 for(const name of ['tx','sentences','worstState','provenance','authoredProvenance','collectorSource','toolError','byteRange','readRouter','mergeRouter',
  'createKnowledgeEditor','entryHash','validateKnowledge','satisfies','validRange','compareVersions','parseVersion','site','loadSite','resolvePaths','CORE_VERSION'])assert.ok(name in api,name);
 assert.equal(api.provenance,provenance);assert.equal(api.CORE_VERSION,CORE_VERSION);
 assert.equal(api.worstState(['ok','error']),'stale');assert.equal(api.toolError('no').toolError,true);
 const t=await import('home-hub/testing');assert.equal(t,testing);
 for(const name of ['createHandler','buildRegistry','STARTUP_PLUGINS','hub','credentials','hashPassword','createAuth','createAccessStore','SCOPES','scopeFor','legacyScopes','site','loadSite','validateSite','BROWSER_PATHS_HOOK','CORE_FIXTURES'])assert.ok(name in testing,name);
 assert.ok(existsSync(testing.BROWSER_PATHS_HOOK));assert.ok(existsSync(path.join(testing.CORE_FIXTURES,'site.json')));
 assert.equal(coreSeenFrom(path.join(repoRoot,'local','plugins')),realpathSync(path.join(repoRoot,'package.json')),'inside the tree: the package\'s self-reference');
 assert.equal(coreSeenFrom(fixtures),realpathSync(path.join(repoRoot,'package.json')));
});

test('the demo plugin: plugin.json gives its version; it imports core by name; the manifest and the start-up line name the version',async t=>{
 const plugins=await loadPlugins(fixtures,quiet);
 assert.deepEqual(plugins.map(p=>[p.id,p.version,p.source]),[['demo','1.0.0','fixtures']]);
 assert.deepEqual({...plugins[0].plugin,config:{...plugins[0].plugin.config}},{id:'demo',version:'1.0.0',title:'Demo notes',core:'>=1.1.0 <2.0.0',requires:{},dataEpoch:null,config:{required:[]},hostAgents:[],source:'fixtures',sourceDirectory:path.dirname(path.resolve(fixtures))});
 const h=await hub(t,{plugins});
 const about=await (await fetch(h.origin+'/api/demo/about',{headers:h.admin})).json();
 assert.deepEqual([about.plugin,about.core,about.provenance.kind],['1.0.0',CORE_VERSION,'plugin']);
 const manifest=await (await fetch(h.origin+'/api/ui/manifest',{headers:h.admin})).json();
 assert.deepEqual(manifest.modules.find(m=>m.id==='demo'),{id:'demo',core:false,title:'Demo notes',version:'1.0.0',source:'fixtures'});
 assert.deepEqual(manifest.modules.find(m=>m.id==='core'),{id:'core',core:true,title:manifest.modules.find(m=>m.id==='core').title,version:CORE_VERSION,source:'core'});
 assert.equal(startupLine({version:{label:'1.2.0'},edition:'public',plugins:[...plugins,{id:'old'}],port:1}),'Home Hub 1.2.0 (public edition, 2 plugin(s): demo 1.0.0, old) listening on 1');
 // The demo's MCP tool refuses through the plugin API's toolError.
 const key=await h.account('agent',[]);
 const rpc=async args=>(await (await fetch(h.origin+'/mcp',{method:'POST',headers:{...key.headers,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'demo_notes',arguments:args}})})).json()).result;
 const refused=await rpc({max:0});assert.equal(refused.isError,true);assert.match(refused.content[0].text,/max must be/);
});

test('a plugin without plugin.json still loads, with one warning line',async t=>{
 const dir=await temp(t);await plugin(dir,'legacy',{manifest:null});
 const warned=[];const loaded=await loadPlugins(dir,{warn:m=>warned.push(m)});
 assert.deepEqual(loaded.map(p=>[p.id,p.version,p.plugin]),[['legacy',null,null]]);
 assert.equal(warned.length,1);assert.match(warned[0],/plugin "legacy" has no plugin\.json: loaded as an unversioned plugin/);
});

test('plugin.json: what is refused at start-up, naming the plugin and the field',async t=>{
 const refused=async(manifest,pattern,{files,extra=[]}={})=>{
  const dir=await temp(t);await plugin(dir,'p-one',{manifest,files});for(const [id,m] of extra)await plugin(dir,id,{manifest:m});
  await assert.rejects(loadPlugins(dir,quiet),pattern);
 };
 const ok={id:'p-one',version:'1.0.0',core:'>=1.0.0 <2.0.0'};
 await refused('{not json',/plugin "p-one": plugin\.json: not valid JSON/);
 await refused({...ok,colour:'red'},/plugin "p-one": plugin\.json: unknown field\(s\): colour/);
 await refused({...ok,id:'p-two'},/id is "p-two"; it must equal the directory name "p-one"/);
 await refused({...ok,version:'1.0'},/version must be a semver/);
 await refused({id:'p-one',core:'>=1.0.0'},/version is missing/);
 await refused({id:'p-one',version:'1.0.0'},/core is missing/);
 await refused({...ok,core:'>= one'},/core is not a version range/);
 await refused({...ok,core:'>=9.0.0'},new RegExp(`plugin "p-one" 1\\.0\\.0 supports Home Hub >=9\\.0\\.0; this is ${CORE_VERSION.replaceAll('.','\\.')}`));
 await refused({...ok,requires:{'p-two':'^1.0.0'}},/plugin "p-one" needs plugin "p-two" \(\^1\.0\.0\), which is not loaded/);
 await refused({...ok,requires:{'p-two':'^2.0.0'}},/plugin "p-one" needs plugin "p-two" \^2\.0\.0; 1\.0\.0 is loaded/,{extra:[['p-two',{id:'p-two',version:'1.0.0',core:'*'}]]});
 await refused({...ok,requires:{'p-two':'^1.0.0'}},/"p-two" has no plugin\.json, so its version is unknown/,{extra:[['p-two',null]]});
 await refused({...ok,requires:{'p-one':'*'}},/requires names the plugin itself/);
 await refused({...ok,requires:{'p-two':'nope'}},/requires\.p-two is not a version range/);
 await refused({...ok,dataEpoch:0},/dataEpoch must be a positive integer/);
 await refused({...ok,config:{needed:['x']}},/config has unknown field\(s\): needed/);
 await refused({...ok,hostAgents:[{id:'bridge',entry:'agent.mjs',service:'launchd-agent'}]},/hostAgents\[0\]\.entry agent\.mjs does not exist/);
 await refused({...ok,hostAgents:[{id:'bridge',entry:'../x.mjs',service:'launchd-agent'}]},/hostAgents\[0\]\.entry must be a \.mjs file inside the plugin/);
 await refused({...ok,hostAgents:[{id:'bridge',entry:'agent.mjs',service:'cron'}]},/hostAgents\[0\]\.service must be one of launchd-agent, launchd-daemon, systemd-user/,{files:{'agent.mjs':''}});
 await refused({...ok,hostAgents:[{id:'bridge',entry:'agent.mjs',service:'launchd-agent',health:{socket:'/abs/bridge.sock'}}]},/health\.socket must be a path relative/,{files:{'agent.mjs':''}});
 await refused({...ok,hostAgents:[{id:'bridge',entry:'agent.mjs',service:'launchd-agent',label:'com.example.x'}]},/hostAgents\[0\] has unknown field\(s\): label/,{files:{'agent.mjs':''}});
 // A required setting that the site does not have, by name.
 const dir=await temp(t);await plugin(dir,'p-one',{manifest:{...ok,config:{required:['hosts','controls']}}});
 await assert.rejects(loadPlugins(dir,{...quiet,site:{plugins:{'p-one':{hosts:{}}}}}),/plugin "p-one" needs site\.json → plugins\.p-one\.controls/);
 assert.equal((await loadPlugins(dir,{...quiet,site:{plugins:{'p-one':{hosts:{},controls:[]}}}})).length,1);
 // A host agent that is declared well.
 const good=await temp(t);await plugin(good,'p-one',{manifest:{...ok,hostAgents:[{id:'bridge',title:'Host bridge',entry:'scripts/agent.mjs',service:'launchd-agent',health:{socket:'private/bridge.sock',get:'/status'}}]},files:{'scripts/agent.mjs':''}});
 assert.deepEqual((await loadPlugins(good,quiet))[0].plugin.hostAgents.map(a=>({...a,health:{...a.health}})),[{id:'bridge',title:'Host bridge',entry:'scripts/agent.mjs',service:'launchd-agent',health:{socket:'private/bridge.sock',get:'/status'},config:null}]);
});

test('several plugin directories; an id is unique across them; instance.json names the sources of an instance',async t=>{
 const a=await temp(t),b=await temp(t);await plugin(a,'p-one');await plugin(b,'p-two');
 assert.deepEqual(pluginsDirectories({HOME_HUB_PLUGINS_DIR:[a,b].join(path.delimiter)}),[a,b]);
 assert.deepEqual(pluginsDirectories({HOME_HUB_PLUGINS_DIR:'none'}),[]);
 assert.deepEqual(pluginsDirectories({},'/srv/hub'),['/srv/hub/local/plugins']);
 assert.deepEqual((await loadPlugins([a,b],quiet)).map(p=>p.id),['p-one','p-two']);
 await plugin(b,'p-one');await assert.rejects(loadPlugins([a,b],quiet),/plugin "p-one" is in two plugin directories/);
 // An instance: <home>/instance.json → sources.plugins.
 const home=await temp(t);
 assert.deepEqual(pluginsDirectories({HOME_HUB_HOME:home},'/srv/hub'),['/srv/hub/local/plugins'],'no instance.json: the overlay, as before');
 await writeFile(path.join(home,'instance.json'),JSON.stringify({schemaVersion:1,sources:{plugins:['household','extra']}}));
 assert.deepEqual(pluginsDirectories({HOME_HUB_HOME:home},'/srv/hub'),[path.join(home,'household','plugins'),path.join(home,'extra','plugins')]);
 assert.deepEqual(pluginsDirectories({HOME_HUB_HOME:home,HOME_HUB_PLUGINS_DIR:a}),[a],'HOME_HUB_PLUGINS_DIR wins');
 await writeFile(path.join(home,'instance.json'),JSON.stringify({sources:{}}));
 assert.deepEqual(pluginsDirectories({HOME_HUB_HOME:home},'/srv/hub'),['/srv/hub/local/plugins']);
 for(const [bad,pattern] of [[{sources:{plugins:['../x']}},/sources\.plugins\[0\] must be the name of a directory/],[{colour:1},/unknown field\(s\): colour/],[{sources:{plugins:['a','a']}},/names a directory twice/],[{schemaVersion:2},/schemaVersion must be 1/]]){
  await writeFile(path.join(home,'instance.json'),JSON.stringify(bad));assert.throws(()=>readInstance(home),pattern);}
 await writeFile(path.join(home,'instance.json'),'{');assert.throws(()=>pluginsDirectories({HOME_HUB_HOME:home}),/is not valid JSON/);
});

test('a plugin source: package.json next to plugins/ gives the version and core range of plugins that state none',async t=>{
 const src=await temp(t),dir=path.join(src,'plugins');
 await plugin(dir,'p-one',{manifest:{id:'p-one'}});await plugin(dir,'p-two',{manifest:{id:'p-two',version:'2.1.0',core:'*'}});
 await writeFile(path.join(src,'package.json'),JSON.stringify({name:'home-hub-household',version:'1.4.0',private:true,type:'module',homeHub:{core:'>=1.0.0 <2.0.0'}}));
 assert.deepEqual({...pluginSource(dir)},{name:'home-hub-household',version:'1.4.0',core:'>=1.0.0 <2.0.0',directory:src});
 assert.deepEqual((await loadPlugins(dir,quiet)).map(p=>[p.id,p.version,p.plugin.core,p.source]),[['p-one','1.4.0','>=1.0.0 <2.0.0','home-hub-household'],['p-two','2.1.0','*','home-hub-household']]);
 await writeFile(path.join(src,'package.json'),JSON.stringify({name:'x',homeHub:{core:'one'}}));
 assert.throws(()=>pluginSource(dir),/homeHub\.core is not a version range/);
 assert.equal(pluginSource(path.join(repoRoot,'local','plugins')),null,'local/ has no package of its own');
});

test('a plugin outside the core tree imports core by name through one link, and gets this core\'s own modules',async t=>{
 const src=await temp(t),dir=path.join(src,'plugins');
 await plugin(dir,'ext',{manifest:{id:'ext',version:'1.0.0',core:'^1.0.0'},code:`import {provenance,CORE_VERSION} from 'home-hub/plugin-api';
export const seen={provenance,CORE_VERSION};
export default {id:'ext',title:'External',routes:[{method:'GET',path:'/api/ext',handler:({json})=>json(200,{core:CORE_VERSION})}]};`});
 assert.equal(coreSeenFrom(dir),null,'no link yet');
 await assert.rejects(loadPlugins(dir,quiet),/plugin "ext" failed to load .*It imports Home Hub by name, which does not resolve from .*node scripts\/plugins\.mjs link --plugins/s);
 const made=linkCore({plugins:[dir],env:{}});
 assert.deepEqual(made.map(r=>[r.action,r.link]),[['created',path.join(src,'node_modules','home-hub')]]);
 assert.equal(realpathSync(made[0].link),realpathSync(repoRoot));
 assert.deepEqual(linkCore({plugins:[dir],env:{}}).map(r=>r.action),['none'],'twice: nothing to do');
 const loaded=await loadPlugins(dir,quiet);
 const mod=await import(path.join(dir,'ext','index.mjs'));
 assert.equal(mod.seen.provenance,provenance,'the same module instance as core\'s own: core is not loaded twice');
 const h=await hub(t,{plugins:loaded});
 assert.deepEqual(await (await fetch(h.origin+'/api/ext',{headers:h.admin})).json(),{core:CORE_VERSION});
 assert.equal(listPlugins({directories:[dir]})[0].core,'this');
 // A link left pointing at another checkout: the start is refused, with the command that fixes it.
 const other=await temp(t,'hub-other-core-');await writeFile(path.join(other,'package.json'),JSON.stringify({name:'home-hub',version:'9.0.0',exports:{'./package.json':'./package.json'}}));
 await rm(made[0].link);await symlink(other,made[0].link,'dir');
 assert.throws(()=>checkCoreLink(dir),/would import another Home Hub core .*node scripts\/plugins\.mjs link --plugins/);
 await assert.rejects(loadPlugins(dir,quiet),/would import another Home Hub core/);
 assert.equal(listPlugins({directories:[dir]})[0].core,'other');
 const fixed=linkCore({plugins:[dir],at:src,env:{}});
 assert.deepEqual([fixed[0].action,fixed[0].was],['replaced',other]);assert.equal(await readlink(made[0].link),realpathSync(repoRoot));
 // An instance: one link in HOME_HUB_HOME serves every source; a real directory in the way is never touched.
 const home=await temp(t);await plugin(path.join(home,'household','plugins'),'ext2');
 assert.deepEqual(linkCore({plugins:[path.join(home,'household','plugins')],env:{HOME_HUB_HOME:home}}).map(r=>r.link),[path.join(home,'node_modules','home-hub')]);
 const blocked=await temp(t);await plugin(path.join(blocked,'plugins'),'ext3');await mkdir(path.join(blocked,'node_modules','home-hub'),{recursive:true});
 assert.throws(()=>linkCore({plugins:[path.join(blocked,'plugins')],env:{}}),/exists and is not a link/);
 assert.throws(()=>linkCore({plugins:[path.join(blocked,'plugins')],at:repoRoot,env:{}}),/inside this core checkout/);
 assert.throws(()=>linkCore({plugins:[path.join(blocked,'plugins')],at:home,env:{}}),/is not above/);
});

test('the test runner runs a plugin source: its plugins and tests, its fixture site, one summary line named after it',async t=>{
 const src=await temp(t),dir=path.join(src,'plugins');
 await plugin(dir,'ext',{manifest:{id:'ext'},code:`import {CORE_VERSION} from 'home-hub/plugin-api';export default {id:'ext',title:'External',setup:hub=>({site:hub.site.siteName,core:CORE_VERSION})};`,
  files:{'tests/ext.test.mjs':`import test from 'node:test';import assert from 'node:assert/strict';
import {hub,STARTUP_PLUGINS} from 'home-hub/testing';
test('the source plugin is loaded on the fixture site',async t=>{assert.deepEqual(STARTUP_PLUGINS.map(p=>p.id),['ext']);const h=await hub(t,{plugins:STARTUP_PLUGINS});assert.equal(h.handler.hub.state('ext').site,'Fixture house');});`}});
 await writeFile(path.join(src,'package.json'),JSON.stringify({name:'home-hub-example',version:'1.0.0',private:true,type:'module',homeHub:{core:'>=1.0.0 <2.0.0'}}));
 await mkdir(path.join(src,'tests','fixtures'),{recursive:true});await writeFile(path.join(src,'tests','fixtures','site.json'),JSON.stringify({siteName:'Fixture house'}));
 linkCore({plugins:[dir],env:{}});
 // A runner of its own, not a child of this one (NODE_TEST_CONTEXT would make it report to us instead of printing).
 const {NODE_TEST_CONTEXT,...env}=process.env;
 const r=spawnSync(process.execPath,[path.join(repoRoot,'scripts','run-tests.mjs'),'--plugins',src],{encoding:'utf8',env:{...env,HOME_HUB_PLUGINS_DIR:'',HOME_HUB_SITE_CONFIG:''}});
 assert.equal(r.status,0,r.stdout+r.stderr);
 assert.match(r.stdout,/^home-hub-example tests 1  pass 1  fail 0$/m);assert.doesNotMatch(r.stdout,/^core /m,'core tests are not run for a source');
 const missing=spawnSync(process.execPath,[path.join(repoRoot,'scripts','run-tests.mjs'),'--plugins',path.join(src,'nothing')],{encoding:'utf8'});
 assert.equal(missing.status,2);assert.match(missing.stderr,/no plugins\/ directory there/);
});

test('node server/index.mjs --check: every start-up check, nothing opened; non-zero when a plugin is refused',async t=>{
 const dir=await temp(t);await plugin(dir,'p-one',{manifest:{id:'p-one',version:'1.0.0',core:'>=99.0.0'}});
 const env={...process.env,HOME_HUB_SITE_CONFIG:'none',HOME_HUB_EDITION:'public',AUTH_FILE:path.join(dir,'missing.json'),DATA_DIR:path.join(dir,'data')};
 const ok=spawnSync(process.execPath,['server/index.mjs','--check'],{cwd:repoRoot,encoding:'utf8',env:{...env,HOME_HUB_PLUGINS_DIR:'none'}});
 assert.equal(ok.status,0,ok.stderr);assert.match(ok.stdout,/^check ok: Home Hub .* \(public edition, 0 plugin\(s\)\); site none$/m);
 assert.equal(existsSync(path.join(dir,'data')),false,'nothing written');
 const bad=spawnSync(process.execPath,['server/index.mjs','--check'],{cwd:repoRoot,encoding:'utf8',env:{...env,HOME_HUB_PLUGINS_DIR:dir}});
 assert.notEqual(bad.status,0);assert.match(bad.stderr,/plugin "p-one" 1\.0\.0 supports Home Hub >=99\.0\.0/);
 // The registry of a hub that loads it all is unaffected by the checks (core modules carry the core's version).
 assert.ok(buildRegistry([]).modules.every(m=>m.version===CORE_VERSION&&m.source==='core'));
});
