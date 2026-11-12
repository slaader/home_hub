// Where configuration, data, state and secrets live (server/paths.mjs): with nothing set, every path is the one the
// checkout always used; with HOME_HUB_HOME an instance directory holds them all; a variable that is set always wins.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,stat,readFile} from 'node:fs/promises';
import {existsSync,statSync} from 'node:fs';
import {spawn} from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {resolvePaths,privateFile,pluginDataDirectory} from '../server/paths.mjs';
import {repoRoot} from '../server/edition.mjs';
import {siteConfigPath,softwareWatchPath} from '../server/site-config.mjs';
import {watchPath} from '../server/software-watch.mjs';
import {defaultKeyFile} from '../server/secret-box.mjs';
import {defaultGithubTokenFile} from '../server/systems-upstream.mjs';
import {defaultAuthFile} from '../scripts/setup.mjs';
import {stateDirectory} from '../scripts/import-runtime-history.mjs';
import {hub} from './hub-helper.mjs';

const temp=async(t,prefix='hub-paths-')=>{const dir=await mkdtemp(path.join(os.tmpdir(),prefix));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;};

test('without any variable every path is the checkout\'s own, as before',()=>{
 const p=resolvePaths({},'/srv/hub');
 assert.deepEqual({...p},{root:'/srv/hub',home:null,config:'/srv/hub/local',siteConfig:'/srv/hub/local/site.json',softwareWatch:'/srv/hub/local/software-watch.json',
  data:'/srv/hub/data',state:'/srv/hub/data/state',private:'/srv/hub/private',authFile:'/srv/hub/private/auth.json'});
 assert.ok(Object.isFrozen(p));
 // The expressions the code used before this module, for the real checkout.
 assert.equal(siteConfigPath({}),path.join(repoRoot,'local','site.json'));
 assert.equal(watchPath({}),path.join(repoRoot,'local','software-watch.json'));
 assert.equal(softwareWatchPath({}),watchPath({}),'one answer, wherever it is asked');
 assert.equal(defaultKeyFile({}),path.join(repoRoot,'private','secret.key'));
 assert.equal(defaultKeyFile({AUTH_FILE:'/x/test-auth.json'}),'/x/secret.key','a preview with its own AUTH_FILE gets its own key');
 assert.equal(defaultGithubTokenFile({}),path.join(repoRoot,'private','github-token'));
 assert.equal(defaultAuthFile({}),path.join(repoRoot,'private','auth.json'));
 assert.equal(stateDirectory({}),path.join(repoRoot,'data','state'));
 assert.equal(stateDirectory({DATA_DIR:'/d'}),'/d/state');assert.equal(stateDirectory({DATA_DIR:'/d',STATE_DIR:'/s'}),'/s');
 assert.equal(privateFile('integrations.json',{}),path.join(repoRoot,'private','integrations.json'));
});

test('an instance directory holds config/, data/ and private/',()=>{
 const p=resolvePaths({HOME_HUB_HOME:'/srv/instance'},'/srv/hub');
 assert.deepEqual({...p},{root:'/srv/hub',home:'/srv/instance',config:'/srv/instance/config',siteConfig:'/srv/instance/config/site.json',softwareWatch:'/srv/instance/config/software-watch.json',
  data:'/srv/instance/data',state:'/srv/instance/data/state',private:'/srv/instance/private',authFile:'/srv/instance/private/auth.json'});
 const env={HOME_HUB_HOME:'/srv/instance'};
 assert.equal(defaultKeyFile(env),'/srv/instance/private/secret.key');
 assert.equal(defaultGithubTokenFile(env),'/srv/instance/private/github-token');
 assert.equal(defaultAuthFile(env),'/srv/instance/private/auth.json');
 assert.equal(stateDirectory(env),'/srv/instance/data/state');
 assert.equal(privateFile('runtime-tokens.json',env),'/srv/instance/private/runtime-tokens.json');
});

test('a variable that is set wins over the default another one derives',()=>{
 const p=resolvePaths({HOME_HUB_HOME:'/i',HOME_HUB_CONFIG_DIR:'/etc/hub',DATA_DIR:'/var/hub',HOME_HUB_PRIVATE_DIR:'/secret'},'/srv/hub');
 assert.deepEqual([p.config,p.siteConfig,p.softwareWatch,p.data,p.state,p.private,p.authFile],['/etc/hub','/etc/hub/site.json','/etc/hub/software-watch.json','/var/hub','/var/hub/state','/secret','/secret/auth.json']);
 const q=resolvePaths({HOME_HUB_HOME:'/i',HOME_HUB_SITE_CONFIG:'/x/site.json',STATE_DIR:'/st',AUTH_FILE:'/a/auth.json',SOFTWARE_WATCH_FILE:'/w.json'},'/srv/hub');
 assert.deepEqual([q.siteConfig,q.softwareWatch,q.data,q.state,q.authFile,q.private],['/x/site.json','/w.json','/i/data','/st','/a/auth.json','/i/private']);
 assert.equal(resolvePaths({HOME_HUB_HOME:'/i',HOME_HUB_SITE_CONFIG:'none'}).siteConfig,null);
 assert.equal(resolvePaths({HOME_HUB_HOME:'/i',HOME_HUB_SITE_CONFIG:'none'}).softwareWatch,null,'no site file, no watch list');
 assert.equal(resolvePaths({HOME_HUB_SITE_CONFIG:'/etc/x/site.json'},'/srv/hub').softwareWatch,'/etc/x/software-watch.json','another site file brings its own list');
 // An empty value counts as unset (the test runner clears a variable that way).
 assert.equal(resolvePaths({HOME_HUB_HOME:'',DATA_DIR:'',HOME_HUB_SITE_CONFIG:''},'/srv/hub').siteConfig,'/srv/hub/local/site.json');
 // DATA_DIR, STATE_DIR and AUTH_FILE are passed on as given, relative ones too (they always were); the rest are absolute.
 const r=resolvePaths({DATA_DIR:'data',STATE_DIR:'data/state',AUTH_FILE:'private/auth.json',HOME_HUB_PRIVATE_DIR:'p'},'/srv/hub');
 assert.deepEqual([r.data,r.state,r.authFile],['data','data/state','private/auth.json']);assert.ok(path.isAbsolute(r.private));
 assert.ok(path.isAbsolute(resolvePaths({HOME_HUB_HOME:'rel'}).home));
});

test('a plugin\'s data directory: <data>/plugins/<id>, 0700, made on first use; hub.pluginData names a loaded module only',async t=>{
 const dir=await temp(t);
 const made=pluginDataDirectory(dir,'benchmarks');
 assert.equal(made,path.join(dir,'plugins','benchmarks'));
 if(process.platform!=='win32')assert.equal(statSync(made).mode&0o777,0o700);
 assert.equal(pluginDataDirectory(dir,'benchmarks'),made,'twice is fine');
 for(const bad of ['../x','X','a',null,'a/b'])assert.throws(()=>pluginDataDirectory(dir,bad),/not a plugin id/);
 const h=await hub(t,{plugins:[{id:'notes',title:'Notes'}]});
 assert.equal(h.handler.hub.pluginData('notes'),path.join(h.dir,'plugins','notes'));
 assert.ok(existsSync(path.join(h.dir,'plugins','notes')));
 assert.throws(()=>h.handler.hub.pluginData('nobody'),/no module "nobody"/);
});

test('a server started with only HOME_HUB_HOME reads its configuration there and writes only there',async t=>{
 const home=await temp(t,'hub-home-');
 await mkdir(path.join(home,'config'),{recursive:true});
 await writeFile(path.join(home,'config','site.json'),JSON.stringify({siteName:'Instance test',defaultLanguage:'en'}));
 const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
 const runFile=path.join(repoRoot,'data','state','run.json'),before=existsSync(runFile)?(await stat(runFile)).mtimeMs:null;
 const env={...process.env,LOCAL_PREVIEW:'1',PORT:String(port),HOME_HUB_HOME:home,HOME_HUB_PLUGINS_DIR:'none',HOME_HUB_EDITION:'public',HOME_HUB_UPDATE_CHECK:'off'};
 for(const name of ['DATA_DIR','STATE_DIR','AUTH_FILE','HOME_HUB_SITE_CONFIG','HOME_HUB_CONFIG_DIR','HOME_HUB_PRIVATE_DIR','INTEGRATION_SECRETS_FILE','THERMO_HOSTS_FILE','RUNTIME_TOKENS_FILE','GIT_LFS_TOKENS_FILE','BACKUP_KEYS_DIR'])delete env[name];
 const child=spawn(process.execPath,['server/index.mjs'],{cwd:repoRoot,stdio:['ignore','pipe','pipe'],env});
 let out='';child.stdout.on('data',d=>{out+=d;});child.stderr.on('data',d=>{out+=d;});
 t.after(()=>{child.kill();});
 const up=await new Promise(resolve=>{const started=Date.now();const poll=async()=>{try{if((await fetch(`http://127.0.0.1:${port}/healthz`)).ok)return resolve(true);}catch{}
  if(child.exitCode!==null||Date.now()-started>15000)return resolve(false);setTimeout(poll,100);};poll();});
 assert.ok(up,`the server did not come up:\n${out}`);
 assert.ok(out.includes(path.join(home,'private','auth.json')),'the owner file it asks for is the instance\'s');
 const manifest=await (await fetch(`http://127.0.0.1:${port}/api/ui/manifest`)).json();
 assert.deepEqual([manifest.site.name,manifest.setupRequired],['Instance test',true]);
 const until=Date.now()+5000;while(!existsSync(path.join(home,'data','state','run.json'))&&Date.now()<until)await new Promise(r=>setTimeout(r,50));
 assert.ok(existsSync(path.join(home,'data','state','hub.db')),'state in <home>/data/state');
 assert.equal(JSON.parse(await readFile(path.join(home,'data','state','run.json'),'utf8')).pid,child.pid);
 assert.equal(existsSync(runFile)?(await stat(runFile)).mtimeMs:null,before,'the checkout\'s own state is not touched');
});
