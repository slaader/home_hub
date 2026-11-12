// The update command (scripts/update.mjs, server/update-apply.mjs) on throw-away git repositories: a small "core"
// with release tags, a clone that is the installation, and a service that is a stand-in (`svc stop` / `svc start`
// change a flag and write run.json the way a real hub does). git, tar, the staged test run and the staged
// `--check` are real. Nothing here touches a network, a real service or this checkout.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath} from 'node:fs/promises';
import {existsSync,readFileSync,readdirSync,writeFileSync,statSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

// No global git configuration reaches these repositories (a signing key, a hooks path, an identity).
Object.assign(process.env,{GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null',GIT_AUTHOR_NAME:'Alice',GIT_AUTHOR_EMAIL:'alice@example.com',GIT_COMMITTER_NAME:'Alice',GIT_COMMITTER_EMAIL:'alice@example.com'});
const {resolveInstance,preflight,apply,rollback,recover,backup,status,formatStatus,readJournal,setQuarantine,readQuarantine,archiveEntries,runMismatch,coreFacts,pluginFacts,realExec,UpdateError,RollbackFailed}=await import('../server/update-apply.mjs');
const {parseService,parseHealth,parseBackups,UpdateConfigError}=await import('../server/update-config.mjs');
const {readInstance}=await import('../server/plugins.mjs');
const {readUpdateState,updateView}=await import('../server/update-check.mjs');
const {parseArgs,main}=await import('../scripts/update.mjs');

// --- a core that is four files ---------------------------------------------------------------------------
const RUNNER=`import {existsSync} from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
if(process.env.HOME_HUB_HOME||process.env.STATE_DIR){console.log('the instance leaked into the tests');process.exit(1);}
if(existsSync(path.join(root,'FAIL_TESTS'))){console.log('not ok 1 - a test of this release');console.log('core     tests 1  pass 0  fail 1');process.exit(1);}
console.log(process.argv.includes('--plugins')?'household tests 2  pass 2  fail 0':'core     tests 3  pass 3  fail 0');
`;
const INDEX=`// stands in for the server: only '--check'
import {existsSync,readFileSync} from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
if(existsSync(path.join(root,'FAIL_CHECK'))){console.error('plugin "p-one" needs site.json → plugins.p-one.socket');process.exit(1);}
console.info('check ok: Home Hub '+JSON.parse(readFileSync(path.join(root,'package.json'),'utf8')).version+'; site '+process.env.HOME_HUB_SITE_CONFIG);
`;
const pkg=(version,epoch=1)=>JSON.stringify({name:'home-hub',version,type:'module',engines:{node:'>=22'},homeHub:{dataEpoch:epoch}})+'\n';
const tree=(version,epoch=1,extra={})=>({'package.json':pkg(version,epoch),'scripts/run-tests.mjs':RUNNER,'server/index.mjs':INDEX,'.gitignore':'data/\nstate/\nprivate/\nbackups/\n',...extra});
const manifest=(id,version,more={})=>JSON.stringify({id,version,core:'>=1.0.0 <2.0.0',...more})+'\n';

function repository(root){
 const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 const commit=async(message,files,{tag=null,remove=[]}={})=>{
  for(const [file,text] of Object.entries(files)){await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),text);}
  for(const file of remove)await rm(path.join(root,file),{force:true});
  git('add','-A');git('commit','-q','-m',message);if(tag)git('tag','-a','-m',tag,tag);return git('rev-parse','HEAD');
 };
 return {root,git,commit};
}
async function init(root){await mkdir(root,{recursive:true});const r=repository(root);r.git('init','-q','-b','main');return r;}
function clone(from,to){execFileSync('git',['clone','-q',from,to],{stdio:'ignore'});return repository(to);}

/**
 * An installation and its world. layout 'checkout': a clone with data/, state/ and private/ in it (state beside data,
 * as STATE_DIR puts it). layout 'home': <home>/core, <home>/household (a plugin source of its own), config/, data/,
 * private/ and instance.json. upstream has v1.0.0; the test adds what it needs.
 */
async function world(t,{layout='checkout',instance={}}={}){
 const dir=await realpath(await mkdtemp(path.join(os.tmpdir(),'hub-update-')));t.after(()=>rm(dir,{recursive:true,force:true}));
 const upstream=await init(path.join(dir,'upstream'));
 const v100=await upstream.commit('1.0.0',tree('1.0.0'),{tag:'v1.0.0'});
 const home=layout==='home'?path.join(dir,'home'):null,root=home?path.join(home,'core'):path.join(dir,'hub');
 if(home)await mkdir(home,{recursive:true});
 const hub=clone(upstream.root,root);
 let plugins=null,pluginsUpstream=null;
 const env={};
 if(home){
  pluginsUpstream=await init(path.join(dir,'household-upstream'));
  await pluginsUpstream.commit('1.0.0',{'package.json':JSON.stringify({name:'household',version:'1.0.0',homeHub:{core:'>=1.0.0 <2.0.0'}})+'\n','plugins/p-one/index.mjs':'export default {id:"p-one"};\n','plugins/p-one/plugin.json':manifest('p-one','1.0.0'),
   'plugins/p-one/tests/one.test.mjs':'// a test\n'},{tag:'v1.0.0'});
  plugins=clone(pluginsUpstream.root,path.join(home,'household'));
  for(const d of ['config','data/state','private'])await mkdir(path.join(home,d),{recursive:true});
  await writeFile(path.join(home,'config','site.json'),'{"siteName":"Example"}\n');
  await writeFile(path.join(home,'instance.json'),JSON.stringify({schemaVersion:1,sources:{core:'core',plugins:['household']},service:{stop:['svc','stop'],start:['svc','start']},health:{url:'http://127.0.0.1:9/healthz',seconds:2},...instance}));
  env.HOME_HUB_HOME=home;
 }else{
  for(const d of ['data','state','private'])await mkdir(path.join(root,d),{recursive:true});
  env.STATE_DIR=path.join(root,'state');
 }
 const base=home??root,state=home?path.join(home,'data','state'):path.join(root,'state');
 await writeFile(path.join(base,'data','knowledge.json'),'{"entries":[]}\n');
 await writeFile(path.join(base,'private','auth.json'),'{"secret":"kept"}\n',{mode:0o600});
 await writeFile(path.join(state,'hub.db'),'written by 1.0.0\n');
 // The stand-in service. A start "runs" whatever the checkout holds: it writes run.json unless the tree says it crashes.
 let clock=Date.parse('2026-11-12T10:00:00.000Z');
 const svc={running:false,pid:1000,calls:[],refuseStop:false,onStart:null,execs:[]};
 const start=()=>{
  const version=JSON.parse(readFileSync(path.join(root,'package.json'),'utf8')).version;svc.calls.push(`start ${version}`);
  if(existsSync(path.join(root,'CRASH_AT_START'))){svc.running=false;return {status:0,stdout:'',stderr:''};}
  svc.pid++;svc.running=true;
  const loaded=home?pluginFacts(path.join(home,'household','plugins')).map(p=>({id:p.id,version:p.version})):[];
  writeFileSync(path.join(state,'run.json'),JSON.stringify({version,commit:hub.git('rev-parse','HEAD').slice(0,7),exact:true,dataEpoch:1,pid:svc.pid,startedAt:new Date(clock).toISOString(),plugins:loaded}));
  svc.onStart?.(version);
  return {status:0,stdout:'',stderr:''};
 };
 const stop=()=>{svc.calls.push('stop');if(svc.ignoreStop)return {status:0,stdout:'',stderr:''};if(svc.refuseStop)return {status:1,stdout:'',stderr:'sudo: a password is required'};svc.running=false;return {status:0,stdout:'',stderr:''};};
 const lines=[];
 const ctx={exec:(command,args,options={})=>{svc.execs.push({command,args,env:options.env});return command==='svc'?(args[0]==='start'?start():stop()):realExec(command,args,options);},
  probe:async()=>svc.running,pidAlive:pid=>svc.running&&pid===svc.pid,sleep:async ms=>{clock+=ms;},now:()=>clock,log:line=>lines.push(line),checkpoint:()=>{},node:process.execPath,user:'alice',stopSeconds:2};
 start();svc.calls.length=0;
 const options=home?{}:{service:'command:{"stop":["svc","stop"],"start":["svc","start"]}',health:'http://127.0.0.1:9/healthz',healthSeconds:2};
 const inst=(more={})=>resolveInstance({env,root,options:{...options,...more}});
 const tick=ms=>{clock+=ms;};
 return {dir,upstream,hub,root,home,plugins,pluginsUpstream,env,state,base,svc,ctx,lines,inst,v100,tick};
}
const refused=(promise,pattern)=>assert.rejects(promise,e=>e instanceof UpdateError&&pattern.test(e.message)||assert.fail(`${e.constructor.name}: ${e.message}`));
const tarList=file=>execFileSync('tar',['-tzf',file],{encoding:'utf8'}).split('\n').filter(Boolean);

test('configuration: a service is a launchd label, a systemd unit or two commands; health is an address; instance.json holds them',async t=>{
 assert.deepEqual({...parseService('launchd:system/com.example.home-hub',{uid:501})},{kind:'launchd',spec:'launchd:system/com.example.home-hub',
  stop:['sudo','-n','/bin/launchctl','bootout','system/com.example.home-hub'],start:['sudo','-n','/bin/launchctl','bootstrap','system','/Library/LaunchDaemons/com.example.home-hub.plist'],startTries:4});
 assert.deepEqual(parseService('launchd:system/com.example.home-hub',{uid:0}).stop,['/bin/launchctl','bootout','system/com.example.home-hub'],'root needs no sudo');
 assert.deepEqual(parseService('launchd:gui/501/com.example.hub',{uid:501,home:'/Users/alice'}).start,['/bin/launchctl','bootstrap','gui/501','/Users/alice/Library/LaunchAgents/com.example.hub.plist']);
 assert.deepEqual(parseService('systemd:home-hub.service',{uid:1000}).stop,['sudo','-n','systemctl','stop','home-hub.service']);
 assert.deepEqual(parseService('systemd-user:home-hub.service').start,['systemctl','--user','start','home-hub.service']);
 assert.deepEqual(parseService('command:{"stop":["a","b"],"start":["c"]}').start,['c']);
 assert.equal(parseService({stop:['a'],start:['b']}).kind,'command');
 for(const [bad,why] of [['launchd:com.example.x',/launchd:system\/<label>/],['launchd:system/../x',/launchd:system/],['docker:hub',/not a kind/],[{stop:['a']},/service\.start/],[{stop:['a'],start:['b'],restart:['c']},/unknown field/],
  ['command:{',/followed by JSON/],['systemd:a b',/systemd:<unit>/],[{stop:'a b',start:['b']},/service\.stop/]])assert.throws(()=>parseService(bad),e=>e instanceof UpdateConfigError&&why.test(e.message),String(why));
 assert.deepEqual({...parseHealth({url:'http://127.0.0.1:8781/healthz'})},{url:'http://127.0.0.1:8781/healthz',seconds:60});
 for(const bad of [{url:'file:///etc/passwd'},{url:'http://alice:pw@127.0.0.1/'},{url:'http://127.0.0.1/',seconds:1},{url:'http://127.0.0.1/',retries:3},{}])assert.throws(()=>parseHealth(bad),UpdateConfigError);
 assert.equal(parseBackups().keep,5);assert.throws(()=>parseBackups({keep:0}),UpdateConfigError);
 // instance.json: the server checks these fields too, and refuses what is malformed
 const home=await mkdtemp(path.join(os.tmpdir(),'hub-instance-'));t.after(()=>rm(home,{recursive:true,force:true}));
 const put=doc=>writeFile(path.join(home,'instance.json'),JSON.stringify(doc));
 await put({sources:{core:'core',plugins:['household']},service:'launchd:system/com.example.home-hub',health:{url:'http://127.0.0.1:8781/healthz'},backups:{keep:3}});
 const read=readInstance(home);
 assert.deepEqual({core:read.sources.core,plugins:[...read.sources.plugins],service:read.service,health:{...read.health},backups:{...read.backups}},
  {core:'core',plugins:['household'],service:'launchd:system/com.example.home-hub',health:{url:'http://127.0.0.1:8781/healthz',seconds:60},backups:{keep:3}});
 for(const [bad,why] of [[{service:'docker:x'},/instance: .*not a kind/],[{health:{url:'nope'}},/health\.url/],[{backups:{keep:'all'}},/backups\.keep/],[{sources:{core:'../x'}},/sources\.core/],[{sources:{core:'a',plugins:['a']}},/also named/]]){
  await put(bad);assert.throws(()=>readInstance(home),why);}
});

test('the instance: a checkout with its data inside, or an instance directory; flags win over instance.json',async t=>{
 const w=await world(t),inst=w.inst();
 assert.deepEqual({root:inst.root,home:inst.home,data:inst.paths.data,state:inst.paths.state,private:inst.paths.private,backups:inst.backups,journal:inst.files.journal,sources:inst.sources.map(s=>s.id)},
  {root:w.root,home:null,data:path.join(w.root,'data'),state:path.join(w.root,'state'),private:path.join(w.root,'private'),backups:path.join(w.root,'backups'),journal:path.join(w.root,'backups','update-journal.json'),sources:['core']});
 assert.deepEqual(archiveEntries(inst).map(e=>e.name),['data','state','private'],'state beside data is archived on its own');
 assert.deepEqual(archiveEntries(resolveInstance({env:{},root:w.root})).map(e=>e.name),['data','private'],'state inside data comes with it');
 assert.throws(()=>archiveEntries(w.inst({backups:path.join(w.root,'private','backups')})),/inside .*private, which is archived/);
 assert.throws(()=>resolveInstance({env:{},root:path.join(w.dir,'nowhere')}),/not a Home Hub checkout/);
 const h=await world(t,{layout:'home'}),hi=h.inst();
 assert.deepEqual({root:hi.root,home:hi.home,state:hi.paths.state,backups:hi.backups,journal:hi.files.journal,staging:hi.staging,sources:hi.sources.map(s=>[s.id,s.kind,s.plugins]),service:hi.service.stop,health:hi.health.seconds},
  {root:path.join(h.home,'core'),home:h.home,state:path.join(h.home,'data','state'),backups:path.join(h.home,'backups'),journal:path.join(h.home,'update-journal.json'),staging:path.join(h.home,'staging'),
   sources:[['core','core',[]],['household','plugins',['plugins']]],service:['svc','stop'],health:2});
 assert.deepEqual(archiveEntries(hi).map(e=>e.name),['config','data','private']);
 const flagged=h.inst({service:'systemd:hub.service',health:'http://127.0.0.1:1/x',healthSeconds:9,keep:2,backups:path.join(h.dir,'elsewhere')});
 assert.deepEqual({kind:flagged.service.kind,health:{...flagged.health},keep:flagged.keep,backups:flagged.backups},{kind:'systemd',health:{url:'http://127.0.0.1:1/x',seconds:9},keep:2,backups:path.join(h.dir,'elsewhere')});
 assert.equal(resolveInstance({env:{...h.env,HOME_HUB_PLUGINS_DIR:'none'},root:h.root}).sources.length,1);
});

test('apply, the whole way: a checkout on a branch ends detached at the tag, with an archive and a journal',async t=>{
 const w=await world(t),inst=w.inst();
 const v110=await w.upstream.commit('1.1.0',tree('1.1.0',1,{'NEW':'new in 1.1.0\n'}),{tag:'v1.1.0'});
 setQuarantine(inst.files.updates,'1.1.0',{at:'2026-11-11T08:00:00.000Z',reason:'health check'});
 await refused(apply(inst,{core:null},w.ctx),/1\.1\.0 was tried here on 2026-11-11 and rolled back \(health check\)\. --force/);
 assert.deepEqual(w.svc.calls,[],'a refusal stops nothing');
 assert.ok(!existsSync(inst.files.lock),'and leaves no lock');
 const {journal,plan}=await apply(inst,{core:null,force:true},w.ctx);
 assert.deepEqual(w.svc.calls,['stop','start 1.1.0'],'one stop, one start');
 assert.equal(w.hub.git('rev-parse','HEAD'),v110);
 assert.throws(()=>w.hub.git('symbolic-ref','-q','HEAD'),'detached at the tag');
 assert.deepEqual({from:plan.from.label,to:plan.to.label,epochRose:plan.epochRose,changes:plan.changes.map(c=>[c.id,c.tag,c.branch])},
  {from:`1.0.0 @ ${w.v100.slice(0,7)}`,to:`1.1.0 @ ${v110.slice(0,7)}`,epochRose:false,changes:[['core','v1.1.0','main']]});
 assert.ok(plan.lines.some(l=>/tests \(core\): core tests 3 pass 3 fail 0/.test(l)),plan.lines.join('\n'));
 assert.ok(plan.lines.some(l=>/^check ok: Home Hub 1\.1\.0/.test(l)));
 assert.ok(plan.lines.some(l=>/data epoch unchanged \(1\)/.test(l)));
 // the staged check ran from the scratch worktree with this instance's own state, and the stage is gone
 const check=w.svc.execs.find(e=>e.args.includes('--check'));
 assert.ok(check.args[0].includes('home-hub-update-')&&!check.args[0].startsWith(w.root),'the check runs from the stage, never from the live checkout');
 assert.deepEqual({plugins:check.env.HOME_HUB_PLUGINS_DIR,state:check.env.STATE_DIR,auth:check.env.AUTH_FILE,site:check.env.HOME_HUB_SITE_CONFIG},
  {plugins:'none',state:path.join(w.root,'state'),auth:path.join(w.root,'private','auth.json'),site:path.join(w.root,'local','site.json')});
 assert.ok(!existsSync(path.dirname(path.dirname(path.dirname(check.args[0])))),'the stage is removed');
 assert.equal(w.hub.git('worktree','list').split('\n').length,1,'no worktree is left behind');
 // the archive: made with the hub stopped, 0600, holding all three directories
 assert.equal(path.dirname(journal.backup.file),path.join(w.root,'backups'));assert.match(path.basename(journal.backup.file),/^pre-1\.0\.0-to-1\.1\.0-20261112-\d{6}\.tgz$/);
 assert.equal(statSync(journal.backup.file).mode&0o777,0o600);
 const names=tarList(journal.backup.file);
 for(const f of ['data/knowledge.json','state/hub.db','state/run.json','private/auth.json'])assert.ok(names.includes(f),f);
 // the journal, the history and the note
 const saved=readJournal(inst);
 assert.deepEqual({step:saved.step,started:saved.started,by:saved.by,service:saved.settings.service,state:saved.settings.state},{step:'done',started:true,by:'alice',service:{stop:['svc','stop'],start:['svc','start']},state:path.join(w.root,'state')});
 const past=readFileSync(inst.files.history,'utf8').trim().split('\n').map(l=>JSON.parse(l));
 assert.deepEqual(past.map(h=>[h.from,h.to,h.result,h.by]),[[plan.from.label,plan.to.label,'done','alice']]);
 assert.deepEqual(readQuarantine(inst.files.updates),{},'a release that now runs is no longer noted as rolled back');
 assert.ok(!existsSync(inst.files.lock));
 assert.equal(JSON.parse(readFileSync(inst.files.run,'utf8')).version,'1.1.0');
 // status says all of it
 const s=status(inst,w.ctx),text=formatStatus(s).join('\n');
 assert.deepEqual({version:s.installed.version,tag:s.installed.tag,exact:s.installed.exact,running:s.running.version,alive:s.running.alive,step:s.journal.step,newer:s.newerTag},{version:'1.1.0',tag:'v1.1.0',exact:true,running:'1.1.0',alive:true,step:'done',newer:null});
 assert.match(text,/Home Hub 1\.1\.0 @ \w{7} \(v1\.1\.0, detached\), data epoch 1/);assert.match(text,/Last update: 1\.0\.0 @ \w{7} → 1\.1\.0 @ \w{7}, begun .*: done/);
 // going back by hand: the code switches back onto the branch it was on, the state stays, the release is noted
 w.svc.calls.length=0;await writeFile(path.join(w.state,'hub.db'),'written by 1.1.0\n');
 const back=await rollback(inst,w.ctx,{reason:'the map page is broken'});
 assert.deepEqual({step:back.journal.step,calls:w.svc.calls,head:w.hub.git('rev-parse','HEAD'),branch:w.hub.git('symbolic-ref','--short','HEAD')},{step:'rolled-back',calls:['stop','start 1.0.0'],head:w.v100,branch:'main'});
 assert.equal(readFileSync(path.join(w.state,'hub.db'),'utf8'),'written by 1.1.0\n','same data epoch: nothing written since is lost');
 assert.deepEqual(Object.entries(readQuarantine(inst.files.updates)).map(([v,q])=>[v,q.reason]),[['1.1.0','the map page is broken']]);
 await refused(rollback(inst,w.ctx),/already ended as "rolled-back"/);
 // what the hub then tells: the update card reads the same file
 const view=updateView({record:{repo:'alice/home-hub',channel:'stable',checkedAt:'2026-11-12T09:00:00.000Z',version:'1.1.0',tag:'v1.1.0',url:null,publishedAt:null,notes:''},quarantined:readUpdateState(inst.files.updates).state.quarantined,
  version:{version:'1.0.0',label:'1.0.0',exact:true,commit:'abc',dataEpoch:1},settings:{repo:'alice/home-hub',channel:'stable',intervalHours:12,envOff:false},now:Date.parse('2026-11-12T10:00:00.000Z')});
 assert.deepEqual({available:view.updateAvailable,version:view.quarantined?.version,reason:view.quarantined?.reason},{available:true,version:'1.1.0',reason:'the map page is broken'});
});

test('preflight refuses before anything is touched, and says why',async t=>{
 const w=await world(t),inst=w.inst();
 await refused(preflight(inst,{core:null},w.ctx),/Nothing to do: 1\.0\.0 \(v1\.0\.0\) is the newest release tag/);
 await refused(preflight(inst,{core:'v9.9.9'},w.ctx),/There is no tag v9\.9\.9/);
 await refused(preflight(inst,{core:'main'},w.ctx),/"main" is not a release tag/);
 await refused(preflight(inst,{core:'v1.0.0'},w.ctx),/already on v1\.0\.0/);
 await refused(preflight(inst,{core:null,plugins:{'*':'v1.0.0'}},w.ctx),/no plugin source outside the core checkout/);
 await w.upstream.commit('mislabeled',tree('1.0.5'),{tag:'v1.0.6'});
 await w.upstream.commit('tests fail',tree('1.1.0',1,{FAIL_TESTS:''}),{tag:'v1.1.0'});
 await w.upstream.commit('check fails',tree('1.2.0',1,{FAIL_CHECK:''}),{remove:['FAIL_TESTS'],tag:'v1.2.0'});
 await w.upstream.commit('older epoch',tree('1.3.0',1,{'data-note':'x'}),{remove:['FAIL_CHECK'],tag:'v1.3.0'});
 await w.upstream.commit('needs a newer node',{'package.json':JSON.stringify({name:'home-hub',version:'1.4.0',type:'module',engines:{node:'>=99'},homeHub:{dataEpoch:1}})},{tag:'v1.4.0'});
 await refused(preflight(inst,{core:'v1.0.6'},w.ctx),/v1\.0\.6 is not what it says: its package\.json reads 1\.0\.5/);
 await refused(preflight(inst,{core:'v1.1.0'},w.ctx),/npm test of the target failed \(exit 1\)\. The instance was not touched\.[\s\S]*not ok 1 - a test of this release/);
 await refused(preflight(inst,{core:'v1.2.0'},w.ctx),/start-up check \(node server\/index\.mjs --check\) failed[\s\S]*plugins\.p-one\.socket/);
 await refused(preflight(inst,{core:'v1.4.0'},w.ctx),/Home Hub 1\.4\.0 needs Node >=99/);
 assert.equal(w.hub.git('worktree','list').split('\n').length,1,'a failed preflight removes its worktree');
 const skipped=await preflight(inst,{core:'v1.1.0',skipTests:true},w.ctx);
 assert.ok(skipped.lines.includes('tests: SKIPPED (--skip-tests)'));
 // offline: the fetch is the failure, and --no-fetch uses what is here
 w.hub.git('remote','set-url','origin',path.join(w.dir,'gone'));
 await refused(preflight(inst,{core:'v1.3.0'},w.ctx),/git fetch --tags origin failed[\s\S]*--no-fetch/);
 assert.equal((await preflight(inst,{core:'v1.3.0',fetch:false},w.ctx)).to.core.version,'1.3.0');
 // a changed tracked file, and an untracked file the target would overwrite
 await writeFile(path.join(w.root,'data-note'),'mine\n');
 await refused(preflight(inst,{core:'v1.3.0',fetch:false},w.ctx),/untracked file\(s\) that v1\.3\.0 also contains[\s\S]*data-note/);
 await rm(path.join(w.root,'data-note'));await writeFile(path.join(w.root,'server','index.mjs'),INDEX+'// edited\n');
 await refused(preflight(inst,{core:'v1.3.0',fetch:false},w.ctx),/uncommitted changes to tracked files[\s\S]*server\/index\.mjs/);
 w.hub.git('checkout','-q','--','server/index.mjs');
 // going down is not an update
 w.hub.git('checkout','-q','--detach','v1.3.0');
 await refused(preflight(inst,{core:'v1.0.0',fetch:false},w.ctx),/1\.0\.0 is lower than what is installed \(1\.3\.0\)\. Going back is "rollback"/);
 w.hub.git('checkout','-q','main');
 // an apply also needs a hub that runs now, where it is said to be
 await refused(apply(w.inst({service:undefined}),{core:'v1.3.0',fetch:false},w.ctx),/How to stop and start the hub is not known[\s\S]*--service/);
 await refused(apply(resolveInstance({env:{},root:w.root,options:{service:{stop:['svc','stop'],start:['svc','start']},health:'http://127.0.0.1:9/healthz'}}),{core:'v1.3.0',fetch:false},w.ctx),/run\.json is missing[\s\S]*pass --state/);
 w.svc.running=false;
 await refused(apply(inst,{core:'v1.3.0',fetch:false},w.ctx),/not running what this checkout holds: the process in run\.json \(pid 1001\) is not running/);
 assert.deepEqual(w.svc.calls,[],'none of this stopped or started anything');
 assert.ok(!existsSync(inst.files.journal));
});

test('a release that does not come up is rolled back: the old code, the old branch, a quarantine note; state stays when the epoch did not move',async t=>{
 const w=await world(t),inst=w.inst();
 await w.upstream.commit('1.1.0',tree('1.1.0',1,{CRASH_AT_START:''}),{tag:'v1.1.0'});
 await refused(apply(inst,{core:'v1.1.0'},w.ctx),/failed at "starting": health check failed: no answer from http:\/\/127\.0\.0\.1:9\/healthz \(waited 2 s\)\nIt was rolled back; 1\.0\.0 @ \w{7} is running again\. 1\.1\.0 is noted as tried and rolled back[\s\S]*journal  .*update-journal\.json\n  archive  .*pre-1\.0\.0-to-1\.1\.0/);
 assert.deepEqual(w.svc.calls,['stop','start 1.1.0','stop','start 1.0.0']);
 assert.deepEqual({head:w.hub.git('rev-parse','HEAD'),branch:w.hub.git('symbolic-ref','--short','HEAD'),running:w.svc.running},{head:w.v100,branch:'main',running:true});
 const j=readJournal(inst);
 assert.deepEqual({step:j.step,failed:j.failure.step,restored:j.restored??false},{step:'rolled-back',failed:'starting',restored:false});
 assert.equal(readFileSync(path.join(w.state,'hub.db'),'utf8'),'written by 1.0.0\n');
 const q=readQuarantine(inst.files.updates)['1.1.0'];
 assert.match(q.reason,/^health check failed: no answer/);assert.ok(q.reason.length<=120);
 assert.deepEqual(readFileSync(inst.files.history,'utf8').trim().split('\n').map(l=>JSON.parse(l).result),['rolled-back']);
 assert.ok(!existsSync(inst.files.lock));
 // the same hub, again: refused without --force; nothing to roll back by hand
 await refused(apply(inst,{core:'v1.1.0'},w.ctx),/tried here on 2026-11-12 and rolled back/);
 await refused(rollback(inst,w.ctx),/already ended as "rolled-back"/);
 // a hub that answers but is the wrong one (run.json still the old process) does not pass either
 await w.upstream.commit('1.2.0',tree('1.2.0'),{remove:['CRASH_AT_START'],tag:'v1.2.0'});
 w.svc.onStart=version=>{if(version==='1.2.0')writeFileSync(path.join(w.state,'run.json'),JSON.stringify({version:'1.0.0',pid:w.svc.pid,startedAt:new Date(w.ctx.now()).toISOString(),plugins:[]}));};
 await refused(apply(inst,{core:'v1.2.0'},w.ctx),/health check failed: the hub that wrote run\.json is 1\.0\.0, not 1\.2\.0/);
 assert.equal(w.hub.git('rev-parse','HEAD'),w.v100);
});

test('the data epoch: when it rises, going back restores the archive, and what was there is moved aside',async t=>{
 const w=await world(t),inst=w.inst();
 await w.upstream.commit('1.1.0',tree('1.1.0',2),{tag:'v1.1.0'});
 await w.upstream.commit('1.2.0',tree('1.2.0',3,{CRASH_AT_START:''}),{tag:'v1.2.0'});
 // the new code migrates the state the moment it starts
 w.svc.onStart=version=>{if(version!=='1.0.0')writeFileSync(path.join(w.state,'hub.db'),`migrated by ${version}\n`);};
 const {plan,journal}=await apply(inst,{core:'v1.1.0'},w.ctx);
 assert.equal(plan.epochRose,true);assert.ok(plan.lines.some(l=>/^DATA EPOCH RISES \(core 1 → 2\)/.test(l)));
 assert.equal(readFileSync(path.join(w.state,'hub.db'),'utf8'),'migrated by 1.1.0\n');
 await writeFile(path.join(w.root,'data','knowledge.json'),'{"entries":["added after the update"]}\n');
 await refused(rollback(inst,w.ctx),/The data epoch rose[\s\S]*everything written since then is lost[\s\S]*--yes/);
 assert.deepEqual(w.svc.calls,['stop','start 1.1.0'],'asking is not doing');
 const back=await rollback(inst,w.ctx,{yes:true});
 assert.equal(back.journal.restored,true);
 assert.deepEqual({db:readFileSync(path.join(w.state,'hub.db'),'utf8'),knowledge:readFileSync(path.join(w.root,'data','knowledge.json'),'utf8'),auth:readFileSync(path.join(w.root,'private','auth.json'),'utf8'),mode:statSync(path.join(w.root,'private','auth.json')).mode&0o777},
  {db:'written by 1.0.0\n',knowledge:'{"entries":[]}\n',auth:'{"secret":"kept"}\n',mode:0o600});
 const aside=back.journal.failedState;
 assert.match(path.basename(aside),/^failed-20261112-\d{6}$/);
 assert.equal(readFileSync(path.join(aside,'state','hub.db'),'utf8'),'migrated by 1.1.0\n','the newer state is kept, not deleted');
 assert.equal(readFileSync(path.join(aside,'data','knowledge.json'),'utf8'),'{"entries":["added after the update"]}\n');
 assert.equal(JSON.parse(readFileSync(inst.files.run,'utf8')).version,'1.0.0');
 assert.ok(readFileSync(inst.files.history,'utf8').includes('"result":"rolled-back"'),'the history says so, in the restored state');
 assert.ok(existsSync(journal.backup.file),'the archive is still there');
 // an automatic rollback restores too, without asking: the new version ran for seconds
 w.tick(60000);
 await refused(apply(inst,{core:'v1.2.0',force:true},w.ctx),/failed at "starting"/);
 assert.equal(readJournal(inst).restored,true);
 assert.equal(readFileSync(path.join(w.state,'hub.db'),'utf8'),'written by 1.0.0\n');
 assert.equal(readdirSync(inst.backups).filter(n=>n.startsWith('failed-')).length,2);
 // a lower epoch is never a target
 w.hub.git('checkout','-q','--detach','v1.1.0');
 assert.equal(coreFacts(w.root).dataEpoch,2);
});

test('cut short: the next run puts the previous version back from the journal',async t=>{
 const w=await world(t),inst=w.inst();
 const v110=await w.upstream.commit('1.1.0',tree('1.1.0'),{tag:'v1.1.0'});
 const {journal}=await apply(inst,{core:'v1.1.0'},w.ctx);
 // as if the command died right after it started the new version
 const cut=step=>writeFileSync(inst.files.journal,JSON.stringify({...journal,step,finishedAt:undefined}));
 cut('starting');w.svc.calls.length=0;
 assert.match(formatStatus(status(inst,w.ctx)).join('\n'),/UNFINISHED: run "rollback"/);
 await refused(apply(inst,{core:'v1.1.0'},w.ctx),/An earlier update did not finish/);
 const done=await recover(inst,w.ctx);
 assert.deepEqual({step:done.step,calls:w.svc.calls,head:w.hub.git('rev-parse','HEAD'),why:done.failure.message},{step:'rolled-back',calls:['stop','start 1.0.0'],head:w.v100,why:'the update was interrupted'});
 assert.deepEqual(readQuarantine(inst.files.updates),{},'an interrupted update says nothing about the release');
 assert.equal(await recover(inst,w.ctx),null,'nothing left to recover');
 // died while archiving: nothing was switched, the hub is simply started again
 cut('backup');w.svc.running=false;w.svc.calls.length=0;
 const early=await recover(inst,w.ctx);
 assert.deepEqual({step:early.step,calls:w.svc.calls,running:w.svc.running},{step:'aborted',calls:['stop','start 1.0.0'],running:true});
 // the command line does the same before it applies anything, and says so
 cut('switched');w.hub.git('checkout','-q','--detach','v1.1.0');
 const out=[];
 const code=await main(['apply','v1.1.0','--root',w.root,'--state',w.state,'--service','command:{"stop":["svc","stop"],"start":["svc","start"]}','--health','http://127.0.0.1:9/healthz','--health-seconds','2'],{env:{},ctx:w.ctx,out:l=>out.push(l)});
 assert.equal(code,1);assert.match(out.join('\n'),/The earlier update was put back \(rolled-back\); 1\.0\.0 @ \w{7} is running\. Nothing new was applied/);
 assert.equal(w.hub.git('rev-parse','HEAD'),w.v100);
 // Ctrl-C between the switch and the start: back, and no quarantine
 let armed=false;const interrupted={...w.ctx,log:line=>{w.ctx.log(line);if(/^Starting /.test(line))armed=true;},checkpoint:()=>{if(armed)throw Object.assign(new Error('interrupted (SIGINT)'),{interrupted:true});}};
 await refused(apply(inst,{core:'v1.1.0'},interrupted),/failed at "starting": interrupted \(SIGINT\)\nIt was rolled back/);
 assert.deepEqual({head:w.hub.git('rev-parse','HEAD'),running:w.svc.running,q:readQuarantine(inst.files.updates)},{head:w.v100,running:true,q:{}});
 assert.notEqual(v110,w.v100);
});

test('a stop that is refused changes nothing; a rollback that fails leaves the service stopped and says where to look',async t=>{
 const w=await world(t),inst=w.inst();
 await w.upstream.commit('1.1.0',tree('1.1.0',1,{CRASH_AT_START:''}),{tag:'v1.1.0'});
 w.svc.refuseStop=true;const pid=w.svc.pid;
 await refused(apply(inst,{core:'v1.1.0'},w.ctx),/failed at "stopping": the service did not stop: sudo: a password is required\nNothing had been switched; 1\.0\.0 @ \w{7} is running again\.\n/);
 assert.deepEqual({calls:w.svc.calls,pid:w.svc.pid,running:w.svc.running,step:readJournal(inst).step,q:readQuarantine(inst.files.updates)},{calls:['stop'],pid,running:true,step:'aborted',q:{}},'the same process still runs');
 // a stop command that says yes and stops nothing (a wrong label, a wrong pid file): the same answer
 w.svc.refuseStop=false;w.svc.ignoreStop=true;w.svc.calls.length=0;
 await refused(apply(inst,{core:'v1.1.0'},w.ctx),/failed at "stopping": the service was told to stop, but pid \d+ is still running after 2 s\nNothing had been switched/);
 assert.deepEqual({calls:w.svc.calls,pid:w.svc.pid,running:w.svc.running,step:readJournal(inst).step},{calls:['stop'],pid,running:true,step:'aborted'});
 assert.ok(w.lines.some(l=>/the hub still runs as it did; nothing was changed/.test(l)));
 w.svc.ignoreStop=false;w.svc.calls.length=0;
 // the new version crashes, and then the old one does not come up either
 const start=w.ctx.exec;let broken=true;
 const ctx={...w.ctx,exec:(command,args,options)=>{if(command==='svc'&&args[0]==='start'&&broken){w.svc.calls.push('start (fails)');return {status:1,stdout:'',stderr:'Bootstrap failed: 5: Input/output error'};}return start(command,args,options);}};
 await assert.rejects(apply(inst,{core:'v1.1.0'},ctx),e=>e instanceof RollbackFailed&&/could not be brought back: the service did not start: Bootstrap failed: 5[\s\S]*left stopped[\s\S]*journal  [\s\S]*archive  .*\.tgz[\s\S]*history  /.test(e.message)||assert.fail(e.message));
 assert.deepEqual({step:readJournal(inst).step,running:w.svc.running,last:w.svc.calls.at(-1),head:w.hub.git('rev-parse','HEAD')},{step:'rollback-failed',running:false,last:'stop',head:w.v100},'the code is back; the service is stopped, not looping');
 assert.match(formatStatus(status(inst,ctx)).join('\n'),/rollback-failed[\s\S]*UNFINISHED/);
 // fixed: "rollback" finishes the job
 broken=false;
 const done=await rollback(inst,ctx);
 assert.deepEqual({recovered:done.recovered,step:done.journal.step,running:w.svc.running},{recovered:true,step:'rolled-back',running:true});
 assert.deepEqual(Object.keys(readQuarantine(inst.files.updates)),['1.1.0'],'the release that crashed stays noted');
});

test('an instance directory: core and a plugin source update in one transaction, and a plugin can hold core back',async t=>{
 const w=await world(t,{layout:'home'}),inst=w.inst();
 const core110=await w.upstream.commit('1.1.0',tree('1.1.0'),{tag:'v1.1.0'});
 await w.upstream.commit('2.0.0',tree('2.0.0'),{tag:'v2.0.0'});
 const p110=await w.pluginsUpstream.commit('1.1.0',{'package.json':JSON.stringify({name:'household',version:'1.1.0',homeHub:{core:'>=1.1.0 <2.0.0'}})+'\n','plugins/p-one/plugin.json':manifest('p-one','1.1.0',{core:'>=1.1.0 <2.0.0'}),
  'plugins/p-two/index.mjs':'export default {id:"p-two"};\n','plugins/p-two/plugin.json':manifest('p-two','0.3.0',{requires:{'p-one':'^1.1.0'}})},{tag:'v1.1.0'});
 // the plugins alone would need a newer core than the one installed; core alone to 2.0.0 is blocked by the plugin
 await refused(preflight(inst,{core:null,plugins:{'*':'v1.1.0'}},w.ctx),/Plugin p-one 1\.1\.0 supports Home Hub >=1\.1\.0 <2\.0\.0; the target is 1\.0\.0/);
 await refused(preflight(inst,{core:'v2.0.0'},w.ctx),/Plugin p-one 1\.0\.0 supports Home Hub >=1\.0\.0 <2\.0\.0; the target is 2\.0\.0\. Update the plugins too/);
 await refused(preflight(inst,{core:'v1.1.0',plugins:{nope:'v1.1.0'}},w.ctx),/no plugin source "nope" \(there is household\)/);
 await refused(preflight(inst,{core:'v1.1.0',plugins:{household:'v7'}},w.ctx),/There is no tag v7 in .*household/);
 const {plan,journal}=await apply(inst,{core:'v1.1.0',plugins:{'*':'v1.1.0'}},w.ctx);
 assert.deepEqual(w.svc.calls,['stop','start 1.1.0'],'one stop and one start for both');
 assert.deepEqual({core:w.hub.git('rev-parse','HEAD'),plugins:w.plugins.git('rev-parse','HEAD'),changes:plan.changes.map(c=>c.id),to:plan.to.label,expect:plan.to.expect.plugins},
  {core:core110,plugins:p110,changes:['core','household'],to:`1.1.0 (p-one 1.1.0, p-two 0.3.0) @ ${core110.slice(0,7)}`,expect:[{id:'p-one',version:'1.1.0'},{id:'p-two',version:'0.3.0'}]});
 assert.ok(plan.lines.some(l=>/tests \(plugins\): household tests 2 pass 2 fail 0/.test(l)),plan.lines.join('\n'));
 assert.ok(plan.lines.some(l=>/plugins: p-one 1\.1\.0, p-two 0\.3\.0: every core range includes 1\.1\.0/.test(l)));
 // staged like the instance: the plugins beside the target core, linked to it, with the real site file
 const check=w.svc.execs.find(e=>e.args.includes('--check')),stage=path.dirname(path.dirname(path.dirname(check.args[0])));
 assert.equal(path.dirname(stage),path.join(w.home,'staging'));
 assert.deepEqual({plugins:check.env.HOME_HUB_PLUGINS_DIR,home:check.env.HOME_HUB_HOME,site:check.env.HOME_HUB_SITE_CONFIG},{plugins:path.join(stage,'household','plugins'),home:w.home,site:path.join(w.home,'config','site.json')});
 const tests=w.svc.execs.filter(e=>e.args.some(a=>a.endsWith('run-tests.mjs')));
 assert.deepEqual(tests.at(-1).args.slice(1),['--plugins',path.join(stage,'household')]);assert.ok(!('HOME_HUB_HOME' in tests[0].env),'tests never see the instance');
 assert.ok(!existsSync(stage));
 assert.deepEqual(tarList(journal.backup.file).filter(n=>!n.endsWith('/')).map(n=>n.split('/')[0]).filter((n,i,a)=>a.indexOf(n)===i).sort(),['config','data','private']);
 assert.equal(path.dirname(journal.backup.file),path.join(w.home,'backups'));
 // only the plugins, later: the core range check still holds, and a failure names the plugin that did not load
 await w.pluginsUpstream.commit('1.2.0',{'package.json':JSON.stringify({name:'household',version:'1.2.0',homeHub:{core:'>=1.1.0 <2.0.0'}})+'\n','plugins/p-one/plugin.json':manifest('p-one','1.2.0')},{tag:'v1.2.0'});
 w.svc.calls.length=0;w.svc.onStart=()=>{const run=JSON.parse(readFileSync(inst.files.run,'utf8'));if(run.plugins.some(p=>p.version==='1.2.0'))writeFileSync(inst.files.run,JSON.stringify({...run,plugins:run.plugins.filter(p=>p.id!=='p-two')}));};
 await refused(apply(inst,{core:null,plugins:{household:'v1.2.0'}},w.ctx),/health check failed: plugin\(s\) not loaded: p-two[\s\S]*It was rolled back/);
 assert.deepEqual({core:w.hub.git('rev-parse','HEAD'),plugins:w.plugins.git('rev-parse','HEAD'),calls:w.svc.calls,q:readQuarantine(inst.files.updates)},{core:core110,plugins:p110,calls:['stop','start 1.1.0','stop','start 1.1.0'],q:{}},'core did not change, so no core release is quarantined');
 w.svc.onStart=null;
 const again=await apply(inst,{core:null,plugins:{household:'v1.2.0'}},w.ctx);
 assert.deepEqual(again.plan.changes.map(c=>[c.id,c.tag]),[['household','v1.2.0']]);
 assert.match(path.basename(again.journal.backup.file),/^pre-1\.1\.0-to-1\.1\.0-/);
 // only the archive
 w.svc.calls.length=0;
 const made=await backup(inst,w.ctx);
 assert.deepEqual({calls:w.svc.calls,name:/^manual-1\.1\.0-\d{8}-\d{6}\.tgz$/.test(path.basename(made.file)),entries:made.entries.map(e=>e.name)},{calls:['stop','start 1.1.0'],name:true,entries:['config','data','private']});
});

test('the command line: arguments, status, and a rollback that remembers how the update was run',async t=>{
 assert.deepEqual((({command,tag,plugins,options})=>({command,tag,plugins,keep:options.keep}))(parseArgs(['apply','v1.2.0','--plugins','household=v1.1.0','--keep','3'])),{command:'apply',tag:'v1.2.0',plugins:{household:'v1.1.0'},keep:3});
 assert.deepEqual(parseArgs(['preflight','--to','v1.2.0','--plugins','v2']).plugins,{'*':'v2'});
 for(const [bad,why] of [[[],/which command/],[['upgrade'],/unknown command/],[['apply','--colour','red'],/unknown option/],[['apply','--to'],/needs a value/],[['status','v1.0.0'],/takes no tag/],[['apply','v1','v2'],/unexpected argument/],[['apply','--keep','many'],/whole number/]])
  assert.throws(()=>parseArgs(bad),why);
 const w=await world(t);await w.upstream.commit('1.1.0',tree('1.1.0'),{tag:'v1.1.0'});
 const flags=['--root',w.root,'--state',w.state,'--service','command:{"stop":["svc","stop"],"start":["svc","start"]}','--health','http://127.0.0.1:9/healthz','--health-seconds','2'];
 const run=async(...argv)=>{const out=[];const code=await main(argv,{env:{},ctx:w.ctx,out:l=>out.push(l)});return {code,text:out.join('\n')};};
 const first=await run('status','--root',w.root,'--state',w.state);
 assert.equal(first.code,0);assert.match(first.text,/Home Hub 1\.0\.0 @ \w{7} \(branch main\)[\s\S]*Running:  1\.0\.0, pid 1001 \(alive\)[\s\S]*Service:  not configured[\s\S]*Last update: none recorded/);
 const pre=await run('preflight',...flags);
 assert.equal(pre.code,0);assert.match(pre.text,/Preflight passed: 1\.0\.0 @ \w{7} → 1\.1\.0 @ \w{7}\. Nothing was changed\./);assert.deepEqual(w.svc.calls,[]);
 const done=await run('apply',...flags);
 assert.equal(done.code,0);assert.match(done.text,/Updated: 1\.0\.0 @ \w{7} → 1\.1\.0 @ \w{7} in \d+ s[\s\S]*To go back: the same command with "rollback"/);
 assert.match((await run('status','--root',w.root,'--state',w.state,'--json')).text,/"step": "done"/);
 // the service and the health address come from the journal of the update being undone
 const back=await run('rollback','--root',w.root,'--state',w.state);
 assert.equal(back.code,0);assert.match(back.text,/Rolled back: 1\.0\.0 @ \w{7} is running \(rolled-back\)\./);
 assert.deepEqual(w.svc.calls,['stop','start 1.1.0','stop','start 1.0.0']);
});
