// The generic host-agent installer (scripts/install-host-agent.mjs) and the closure it copies (server/agent-closure.mjs):
// a plugin's agent laid out with no checkout and no link, its manifest and configuration, the service file it writes,
// stale and older files removed, and a failed health check rolled back. No service manager is touched: the tests use
// --no-service and fakes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,statSync,rmSync,realpathSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {agentClosure,importsOf,CORE_PREFIX} from '../server/agent-closure.mjs';
import {installedAgent,AGENT_MANIFEST} from '../server/host-agent.mjs';
import {planInstall,applyPlan,formatPlan,renderService,readPlacement,chooseMachine} from '../scripts/install-host-agent.mjs';
import {validateSite} from '../server/site-config.mjs';
import {repoRoot} from '../server/edition.mjs';
import {CORE_VERSION} from '../server/plugins.mjs';

const temp=t=>{const dir=realpathSync(mkdtempSync(path.join(os.tmpdir(),'hub-agent-')));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;};
const put=(file,body)=>{mkdirSync(path.dirname(file),{recursive:true});writeFileSync(file,body);};
// A plugin source with one plugin "relay" whose host agent imports a shared lib file and core by name.
function source(t,{agentCode=null}={}){
 const dir=temp(t),plugin=path.join(dir,'plugins','relay');
 put(path.join(plugin,'index.mjs'),`export default {id:'relay',title:'Relay'};`);
 put(path.join(plugin,'plugin.json'),JSON.stringify({id:'relay',version:'2.3.0',core:'*',hostAgents:[{id:'agent',title:'Relay agent',entry:'scripts/agent.mjs',service:'launchd-agent',health:{socket:'private/a.sock',get:'/status'},config:'server/agent-config.mjs'}]}));
 put(path.join(plugin,'server','agent-config.mjs'),`export default ({site,machine})=>({greeting:site.plugins.relay.greeting,machine});`);
 put(path.join(dir,'lib','shared.mjs'),`export const shared='lib';`);
 put(path.join(plugin,'scripts','agent.mjs'),agentCode??`import {shared} from '../../../lib/shared.mjs';
import {CORE_VERSION,installedAgent,resolvePaths} from 'home-hub/plugin-api';
import {readFileSync} from 'node:fs';import path from 'node:path';
const config=JSON.parse(readFileSync(path.join(resolvePaths().config,'agent.json'),'utf8'));
console.log(JSON.stringify({shared,core:CORE_VERSION,me:installedAgent(),greeting:config.greeting,private:resolvePaths().private}));`);
 return {dir,plugins:path.join(dir,'plugins')};
}
const siteFor=target=>validateSite({machines:[{id:'box',name:'Box',hostname:'box.example.lan'}],plugins:{relay:{greeting:'hello',agents:{agent:{box:{target,label:'com.example.relay-agent',env:{RELAY_MODE:'test'}}}}}}});

test('the closure: plugin files at their source paths, core files under node_modules/home-hub, refusals',t=>{
 const s=source(t);
 const files=agentClosure(path.join(s.plugins,'relay','scripts','agent.mjs'),{sourceRoot:s.dir,coreRoot:repoRoot});
 const to=files.map(f=>f.to);
 assert.ok(to.includes('plugins/relay/scripts/agent.mjs')&&to.includes('lib/shared.mjs'));
 for(const f of ['package.json','server/plugin-api.mjs','server/paths.mjs','server/host-agent.mjs','scripts/knowledge-edit.mjs','public/inventory-rules.js'])assert.ok(to.includes(`${CORE_PREFIX}/${f}`),f);
 assert.ok(files.every(f=>f.part===(f.to.startsWith(CORE_PREFIX)?'core':'plugin')));
 assert.ok(!to.some(f=>/(^|\/)tests\//.test(f)),'no test file');
 assert.deepEqual(importsOf(`import a from './a.mjs';export {d} from './d.mjs';import './e.mjs';await import('./f.mjs');import x from 'node:fs';import {y} from 'home-hub/plugin-api';`).sort(),['./a.mjs','./d.mjs','./e.mjs','./f.mjs','home-hub/plugin-api','node:fs']);
 const refused=(code,pattern)=>{const r=source(t,{agentCode:code});assert.throws(()=>agentClosure(path.join(r.plugins,'relay','scripts','agent.mjs'),{sourceRoot:r.dir,coreRoot:repoRoot}),pattern);};
 refused(`import x from 'left-pad';`,/imports "left-pad", which is not a relative file/);
 refused(`import {x} from 'home-hub/internal';`,/"home-hub\/internal", which core's package\.json does not export/);
 refused(`import './gone.mjs';`,/plugins\/relay\/scripts\/gone\.mjs does not exist/);
 refused(`import '../../../../../../outside.mjs';`,/outside the plugin source and the core checkout/);
 // Inside the core tree (today's local/), a relative import of a core file would break in the copy: refused.
 const inTree=path.join(repoRoot,'local','plugins','memory','scripts','memory-bridge.mjs');
 if(existsSync(inTree))assert.ok(agentClosure(inTree,{sourceRoot:path.join(repoRoot,'local'),coreRoot:repoRoot}).some(f=>f.to==='plugins/memory/scripts/memory-bridge.mjs'));
});

test('install --no-service: the copy runs with no checkout and no link, knows what it is, and reads its configuration',async t=>{
 const s=source(t),target=path.join(temp(t),'agent');
 const plan=await planInstall({plugin:'relay',agent:'agent',site:siteFor(target),directories:[s.plugins],allowDirty:true,env:{},hostname:'box'});
 assert.equal(plan.machine,'box');assert.equal(plan.target,target);assert.equal(plan.socket,path.join(target,'private','a.sock'));
 assert.match(formatPlan(plan,{noService:true}).join('\n'),new RegExp(`Host agent "agent" of plugin relay 2\\.3\\.0 \\(core ${CORE_VERSION.replaceAll('.','\\.')};.*for box → `));
 await applyPlan(plan,{noService:true,log:()=>{}});
 const record=JSON.parse(readFileSync(path.join(target,AGENT_MANIFEST),'utf8'));
 assert.deepEqual([record.plugin,record.agent,record.version,record.core,record.machine,record.label,record.entry],['relay','agent','2.3.0',CORE_VERSION,'box','com.example.relay-agent','plugins/relay/scripts/agent.mjs']);
 assert.ok(record.files.every(f=>/^[a-f0-9]{64}$/.test(f.sha256)&&existsSync(path.join(target,f.path))));
 const config=JSON.parse(readFileSync(path.join(target,'config','agent.json'),'utf8'));
 assert.deepEqual([config.plugin,config.agent,config.machine,config.greeting],['relay','agent','box','hello']);
 if(process.platform!=='win32'){assert.equal(statSync(path.join(target,'config','agent.json')).mode&0o777,0o600);assert.equal(statSync(path.join(target,'private')).mode&0o777,0o700);}
 // Run the copy as its service would: HOME_HUB_HOME=<target>, nothing else of this checkout.
 const r=spawnSync(process.execPath,[path.join(target,'plugins','relay','scripts','agent.mjs')],{cwd:target,encoding:'utf8',env:{PATH:process.env.PATH,HOME_HUB_HOME:target}});
 assert.equal(r.status,0,r.stderr);
 const out=JSON.parse(r.stdout);
 assert.deepEqual([out.shared,out.core,out.greeting,out.private],['lib',CORE_VERSION,'hello',path.join(target,'private')]);
 assert.deepEqual({...out.me,commit:null},{plugin:'relay',agent:'agent',version:'2.3.0',core:CORE_VERSION,commit:null});
 assert.deepEqual(installedAgent(target).version,'2.3.0');assert.equal(installedAgent(path.join(target,'nothing')),null);
 // Installing again changes nothing; a file the agent no longer needs goes, and so does a copy by the older installer.
 assert.deepEqual((await planInstall({plugin:'relay',agent:'agent',site:siteFor(target),directories:[s.plugins],allowDirty:true,env:{},hostname:'box'})).changed,[]);
 put(path.join(s.plugins,'relay','scripts','agent.mjs'),`import {CORE_VERSION} from 'home-hub/plugin-api';console.log(CORE_VERSION);`);
 put(path.join(target,'local','plugins','memory','scripts','memory-bridge.mjs'),'old');put(path.join(target,'server','edition.mjs'),'old');
 put(path.join(target,'.bridge-install.json'),JSON.stringify({schema:1,files:['local/plugins/memory/scripts/memory-bridge.mjs','server/edition.mjs']}));
 const next=await planInstall({plugin:'relay',agent:'agent',site:siteFor(target),directories:[s.plugins],allowDirty:true,env:{},hostname:'box'});
 assert.deepEqual(next.stale,['lib/shared.mjs']);assert.deepEqual(next.legacy,['local/plugins/memory/scripts/memory-bridge.mjs','server/edition.mjs']);
 assert.deepEqual(next.changed.map(f=>f.to),['plugins/relay/scripts/agent.mjs']);
 await applyPlan(next,{noService:true,log:()=>{}});
 for(const gone of ['lib','local','server','.bridge-install.json'])assert.equal(existsSync(path.join(target,gone)),false,`${gone} removed`);
 assert.ok(existsSync(path.join(target,CORE_PREFIX,'server','plugin-api.mjs')));
});

test('the service file: a launchd agent or daemon, or a systemd user unit, from the templates',()=>{
 const base={label:'com.example.a',node:'/opt/node/bin/node',entry:'/srv/a/plugins/x/agent.mjs',target:'/srv/a',env:{PATH:'/opt/node/bin:/usr/bin:/bin',HOME_HUB_HOME:'/srv/a',NOTE:'a<b & "c"'},stdout:'/srv/logs/a.out.log',stderr:'/srv/logs/a.err.log',title:'Agent',plugin:'x',agent:'a',user:'alice',home:'/home/alice'};
 const agent=renderService({...base,service:'launchd-agent'});
 assert.equal(agent.file,'/home/alice/Library/LaunchAgents/com.example.a.plist');assert.match(agent.domain,/^gui\/\d+$/);
 assert.match(agent.text,/<key>Label<\/key>\n\t<string>com\.example\.a<\/string>/);assert.match(agent.text,/<string>a&lt;b &amp; "c"<\/string>/);
 assert.ok(agent.text.indexOf('HOME_HUB_HOME')<agent.text.indexOf('NOTE')&&agent.text.indexOf('NOTE')<agent.text.indexOf('<key>PATH'),'environment in a stable order');
 assert.doesNotMatch(agent.text,/UserName|\{\{/);
 const daemon=renderService({...base,service:'launchd-daemon'});assert.equal(daemon.file,'/Library/LaunchDaemons/com.example.a.plist');assert.match(daemon.text,/<key>UserName<\/key>\n\t<string>alice<\/string>/);assert.equal(daemon.domain,'system');
 const unit=renderService({...base,service:'systemd-user'});
 assert.equal(unit.file,'/home/alice/.config/systemd/user/com.example.a.service');
 assert.match(unit.text,/^ExecStart="\/opt\/node\/bin\/node" "\/srv\/a\/plugins\/x\/agent\.mjs"$/m);assert.match(unit.text,/^Environment="NOTE=a<b & \\"c\\""$/m);assert.doesNotMatch(unit.text,/\{\{/);
 if(process.platform==='darwin'&&existsSync('/usr/bin/plutil')){const r=spawnSync('/usr/bin/plutil',['-lint','-'],{input:agent.text,encoding:'utf8'});assert.equal(r.status,0,r.stdout+r.stderr);}
});

test('what the installer refuses, by name',async t=>{
 const s=source(t),target=path.join(temp(t),'agent');
 const plan=o=>planInstall({plugin:'relay',agent:'agent',site:siteFor(target),directories:[s.plugins],allowDirty:true,env:{},hostname:'box',...o});
 await assert.rejects(plan({plugin:'nothing'}),/No plugin "nothing"/);
 await assert.rejects(plan({agent:'other'}),/declares no host agent "other" \(plugin\.json → hostAgents: agent\)/);
 await assert.rejects(plan({hostname:'elsewhere'}),/Cannot tell which machine of the site this is/);
 await assert.rejects(plan({machine:'nope'}),/--machine nope is not a machine of the site/);
 await assert.rejects(plan({site:validateSite({machines:[{id:'box'}]})}),/plugins\.relay\.agents\.agent\.box is missing/);
 const site=extra=>validateSite({machines:[{id:'box'}],plugins:{relay:{greeting:'x',agents:{agent:{box:{target,label:'com.example.a',...extra}}}}}});
 await assert.rejects(plan({site:site({colour:1})}),/has unknown field\(s\): colour/);
 await assert.rejects(plan({site:site({env:{HOME_HUB_HOME:'/x'}})}),/env must not set HOME_HUB_HOME: the installer sets it/);
 await assert.rejects(plan({site:site({label:'bad label'})}),/label must be a service label/);
 await assert.rejects(plan({site:site({target:'relative/dir'})}),/target must be absolute or start with ~\//);
 await assert.rejects(plan({target:'/'+'x'.repeat(120)}),/longer than the 103 bytes macOS allows/);
 assert.equal(readPlacement(site({target:'~/agent'}),{plugin:'relay',agent:'agent',machine:'box'}).target,path.join(os.homedir(),'agent'));
 assert.equal(chooseMachine(validateSite({machines:[{id:'box',hostname:'Box.example.lan'}]}),null,'box.local'),'box');
 // A git checkout with an uncommitted agent file is refused.
 const g=(...a)=>spawnSync('git',['-C',s.dir,...a],{encoding:'utf8',env:{...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_AUTHOR_NAME:'T',GIT_AUTHOR_EMAIL:'t@example.lan',GIT_COMMITTER_NAME:'T',GIT_COMMITTER_EMAIL:'t@example.lan'}});
 g('init','-q');g('add','-A');g('commit','-q','-m','x');
 // (the core files' state is this checkout's own, so only the plugin side is looked at here)
 const committed=await plan({allowDirty:true});assert.equal(committed.record.commits.plugin.length,40);
 put(path.join(s.dir,'lib','shared.mjs'),`export const shared='changed';`);
 // Core's own tree is a git checkout here, or not (an export, an image): then that alone is refused.
 const coreIsGit=spawnSync('git',['-C',repoRoot,'rev-parse','HEAD'],{encoding:'utf8'}).status===0;
 await assert.rejects(plan({allowDirty:false}),coreIsGit?/uncommitted changes; commit them first.*lib\/shared\.mjs/s:/must be git checkouts/);
});

test('a restart that does not answer is rolled back to the archived agent; one that answers as this version is done',async t=>{
 if(!existsSync('/usr/bin/tar'))return t.skip('no tar');
 const s=source(t),root=temp(t),target=path.join(root,'agent'),backups=path.join(root,'backups'),home=path.join(root,'home');
 const site=siteFor(target),opts={plugin:'relay',agent:'agent',site,directories:[s.plugins],allowDirty:true,env:{},hostname:'box',backups,stateHome:home,serviceHome:home};
 // The agent as it was: one file and a service file, which the rollback must bring back exactly.
 put(path.join(target,'plugins','relay','scripts','agent.mjs'),'the previous agent');
 const first=await planInstall(opts);assert.ok(first.service.file.startsWith(home+path.sep),'never the real LaunchAgents');put(first.service.file,'<plist>previous</plist>');
 const calls=[],services={stop:(svc,label)=>calls.push(['stop',label]),start:(svc,label)=>calls.push(['start',label])};
 const failed=await applyPlan(first,{services,ask:async()=>null,wait:1,log:()=>{},warn:()=>{}});
 assert.equal(failed.status,'rolled-back');assert.ok(existsSync(failed.archive));
 assert.equal(readFileSync(path.join(target,'plugins','relay','scripts','agent.mjs'),'utf8'),'the previous agent');
 assert.equal(existsSync(path.join(target,AGENT_MANIFEST)),false);assert.equal(readFileSync(first.service.file,'utf8'),'<plist>previous</plist>');
 assert.deepEqual(calls.map(c=>c[0]),['stop','start','stop','start']);
 // The same install with an agent that answers as 2.3.0 with every service the other agent lists.
 const again=await planInstall(opts);calls.length=0;
 const answers=[null,{services:[{id:'a'},{id:'b'}],agent:{plugin:'relay',version:'2.3.0'}}];
 const done=await applyPlan(again,{services,ask:async socket=>socket==='/other.sock'?{services:[{id:'a'}]}:answers.shift()??answers.at(-1),expectLike:'/other.sock',wait:5,log:()=>{},warn:()=>{}});
 assert.equal(done.status,'done');assert.deepEqual(calls.map(c=>c[0]),['stop','start']);
 assert.equal(readFileSync(again.service.file,'utf8'),again.service.text);assert.match(again.service.text,/HOME_HUB_AGENT_SOCKET/);
 assert.equal(JSON.parse(readFileSync(path.join(target,AGENT_MANIFEST),'utf8')).version,'2.3.0');
 // An answer that says another version is not this install.
 const third=await planInstall(opts);put(path.join(target,'plugins','relay','scripts','agent.mjs'),'tampered');
 const stale=await applyPlan(await planInstall(opts),{services,ask:async()=>({services:[],agent:{plugin:'relay',version:'2.2.0'}}),wait:1,log:()=>{},warn:()=>{}});
 assert.equal(stale.status,'rolled-back');assert.ok(third);
});
