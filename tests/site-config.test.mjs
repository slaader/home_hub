// Site configuration (server/site-config.mjs) and the edition marker (server/edition.mjs): a missing file is
// an empty, working hub; a wrong file is a loud error; nothing household-specific is seeded or assumed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {validateSite,loadSite,EMPTY_SITE,ipv4,parseCidr,inCidrs,inLan,machineKind,sshHosts,siteConfigPath,softwareWatchPath,publicSite} from '../server/site-config.mjs';
import {readEdition,isPublicRelease,repoRoot} from '../server/edition.mjs';
import {createHandler} from '../server/index.mjs';
import {readRouter} from '../server/router-data.mjs';
import {systemMachines} from '../server/systems-data.mjs';
import {hashPassword} from '../server/auth.mjs';
import {SITE} from './hub-helper.mjs';

test('CIDR checks: real networks, host addresses only',()=>{
 assert.equal(ipv4('10.0.0.1'),0x0a000001);for(const bad of ['10.0.0','10.0.0.256','10.0.0.01','a.b.c.d','',null,'10.0.0.1/24'])assert.equal(ipv4(bad),null,String(bad));
 assert.deepEqual(parseCidr('10.0.0.0/24'),{base:0x0a000000,bits:24,mask:0xffffff00,text:'10.0.0.0/24'});
 for(const bad of ['10.0.0.1/24','10.0.0.0','10.0.0.0/33','10.0.0.0/x'])assert.equal(parseCidr(bad),null,bad);
 const lan=['10.0.0.0/24','172.16.4.0/22'];
 for(const ip of ['10.0.0.1','10.0.0.254','172.16.7.254','172.16.5.0'])assert.equal(inCidrs(ip,lan),true,ip);
 for(const ip of ['10.0.0.0','10.0.0.255','10.0.1.1','172.16.4.0','172.16.7.255','172.16.8.1','999.0.0.1','10.0.0.5x'])assert.equal(inCidrs(ip,lan),false,ip);
 assert.equal(inCidrs('203.0.113.9',[]),true,'no networks configured: any well-formed IPv4');assert.equal(inCidrs('nope',[]),false);
 assert.equal(inCidrs('10.0.0.1',['10.0.0.0/31']),true,'point-to-point networks have no network/broadcast address');
});

test('a missing file is an empty generic site; a present but wrong file is an error',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'site-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 assert.equal(loadSite({file:path.join(dir,'none.json')}),EMPTY_SITE);assert.equal(loadSite({file:null}),EMPTY_SITE);
 assert.deepEqual({name:EMPTY_SITE.siteName,lan:EMPTY_SITE.lanCidrs,zone:EMPTY_SITE.timeZone,lang:EMPTY_SITE.defaultLanguage,origin:EMPTY_SITE.publicOrigin,machines:EMPTY_SITE.machines,seeds:EMPTY_SITE.tracker.projects},
  {name:'',lan:[],zone:null,lang:'en',origin:null,machines:[],seeds:[]});
 const write=async v=>{const f=path.join(dir,'site.json');await writeFile(f,typeof v==='string'?v:JSON.stringify(v));return f;};
 await assert.rejects(async()=>loadSite({file:await write('{nope')}),/not valid JSON/);
 for(const [bad,why] of [[{sitename:'x'},/unknown field\(s\): sitename/],[{lanCidrs:['10.0.0.5/24']},/lanCidrs\[0\]/],[{timeZone:'Mars/Olympus'},/timeZone/],[{defaultLanguage:'de'},/defaultLanguage/],
  [{publicOrigin:'https://hub.example.lan/path'},/publicOrigin/],[{machines:[{id:'Bad Id'}]},/machines\[0\]\.id/],[{machines:[{id:'aa'},{id:'aa'}]},/duplicate ids/],[{machines:[{id:'aa',ip:'10.0.0'}]},/ip must be/],
  [{machines:[{id:'aa',role:'toaster'}]},/role must be/],[{machines:[{id:'aa',ssh:{alias:'x',probe:'windows'}}]},/ssh\.probe/],[{machines:[{id:'aa',picture:'http://x/y.png'}]},/picture/],
  [{inventory:{secretStores:['Has Space']}},/secretStores\[0\]/],[{tracker:{projects:[{id:'x',key:'lower'}]}},/tracker\.projects\[0\]/],[{security:{order:['ghost']}},/security\.order\[0\]/]])
  await assert.rejects(async()=>loadSite({file:await write(bad)}),why,JSON.stringify(bad));
 const ok=loadSite({file:await write({siteName:'Home',lanCidrs:['10.1.0.0/16'],machines:[{id:'box',thermoId:'box'},{id:'store',role:'nas',ssh:{alias:'store-admin',probe:'nas'}},{id:'gw',role:'router',ip:'10.1.0.1'}],plugins:{demo:{anything:true}}})});
 assert.ok(Object.isFrozen(ok)&&Object.isFrozen(ok.machines[0]));
 assert.deepEqual(ok.machines.map(machineKind),['thermo','nas','router']);assert.equal(ok.machines[0].name,'box');
 assert.deepEqual([...sshHosts(ok)],[['store','store-admin']]);assert.deepEqual(systemMachines(ok),[{id:'store',name:'store',kind:'nas'}]);
 assert.equal(inLan(ok,'10.1.200.7'),true);assert.equal(inLan(ok,'10.2.0.1'),false);assert.equal(ok.plugins.demo.anything,true);
 assert.deepEqual(publicSite(ok),{name:'Home',timeZone:null,defaultLanguage:'en',lanCidrs:['10.1.0.0/16']});
});

test('where the configuration comes from: local/site.json, HOME_HUB_SITE_CONFIG, or nothing',()=>{
 assert.equal(siteConfigPath({HOME_HUB_SITE_CONFIG:'none'}),null);assert.equal(siteConfigPath({HOME_HUB_SITE_CONFIG:'/tmp/x.json'}),'/tmp/x.json');
 assert.equal(siteConfigPath({}),path.join(repoRoot,'local','site.json'));
 assert.equal(softwareWatchPath({SOFTWARE_WATCH_FILE:'/tmp/watch.json'}),'/tmp/watch.json');
 assert.equal(softwareWatchPath({},'/srv/hub'),path.join('/srv/hub','local','software-watch.json'),'beside the site file; config/software-watch.json is only an example');
 assert.equal(softwareWatchPath({HOME_HUB_SITE_CONFIG:'none'}),null);
});

test('the shipped example configuration is valid and uses placeholders only',async()=>{
 const example=loadSite({file:path.join(repoRoot,'config','site.example.json')});
 assert.equal(example.machines.length,4);assert.ok(example.machines.every(m=>inLan(example,m.ip)&&(/\.example\.lan$/.test(m.hostname)||m.hostname===m.ip)));
 assert.equal(example.defaultLanguage,'en');
});

test('edition: the marker file, the environment override, and public when unmarked',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'edition-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 assert.equal(readEdition(dir,{}),'public','an unmarked tree assumes nothing household-specific');assert.equal(isPublicRelease(dir,{}),true);
 await writeFile(path.join(dir,'edition.json'),'{"edition":"private"}');assert.equal(readEdition(dir,{}),'private');assert.equal(isPublicRelease(dir,{}),false);
 assert.equal(readEdition(dir,{HOME_HUB_EDITION:'public'}),'public');assert.throws(()=>readEdition(dir,{HOME_HUB_EDITION:'beta'}),/HOME_HUB_EDITION/);
 await writeFile(path.join(dir,'edition.json'),'{"edition":"nightly"}');assert.equal(readEdition(dir,{}),'public');
 assert.ok(['private','public'].includes(readEdition()));
});

test('a hub without a site configuration boots empty: no machines, no seeded projects, English',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'hub-empty-'));t.after(()=>rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:25}));
 const credentials={username:'admin',...hashPassword('test-only-password')};
 const server=http.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();return new Promise(r=>server.close(r));});
 const origin=`http://127.0.0.1:${server.address().port}`;
 server.on('request',createHandler({directory:dir,stateDirectory:dir,credentials,origin,secure:false,site:EMPTY_SITE,plugins:[]}));
 const manifest=await (await fetch(origin+'/api/ui/manifest')).json();
 assert.deepEqual(manifest.site,{name:'',timeZone:null,defaultLanguage:'en',lanCidrs:[]});
 const login=await fetch(origin+'/api/session',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'test-only-password'})});
 const Cookie=login.headers.get('set-cookie').split(';')[0],get=async url=>{const r=await fetch(origin+url,{headers:{Cookie}});return {status:r.status,body:await r.json()};};
 const home=await get('/api/home');assert.equal(home.status,200);assert.deepEqual(home.body.machines,[]);assert.equal(home.body.router.status,'not-configured');
 const tickets=await get('/api/tickets');assert.deepEqual(tickets.body.projects,[],'the tracker seeds nothing unless site.json asks for it');assert.deepEqual(tickets.body.tickets,[]);
 assert.deepEqual((await get('/api/review')).body.sets,[]);
 assert.equal((await get('/api/inventory')).status,404);assert.equal((await get('/api/security')).status,404);assert.equal((await get('/api/systems')).status,404);
 assert.deepEqual((await get('/api/profile/home-order')).body,{order:[],saved:false,known:[]});
 assert.equal((await get('/api/compute')).status,404,'no plugin, no plugin routes');
 const webmanifest=await (await fetch(origin+'/manifest.webmanifest')).json();assert.equal(webmanifest.name,'Home Hub');
 assert.match(await (await fetch(origin+'/')).text(),/<title>Home Hub<\/title>/);
});

test('the site drives core data: the router adapter keeps only LAN clients, machines come from the fixture',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'site-router-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const devices=[{mac:'aa:bb:cc:dd:ee:01',ip:'10.0.0.5',name:'in'},{mac:'aa:bb:cc:dd:ee:02',ip:'10.0.0.255',name:'broadcast'},{mac:'aa:bb:cc:dd:ee:03',ip:'10.9.0.5',name:'elsewhere'},{mac:'nope',ip:'10.0.0.6'}];
 await writeFile(path.join(dir,'router-observations.json'),JSON.stringify({status:'ok',observedAt:new Date().toISOString(),devices}));
 assert.deepEqual((await readRouter(dir,{lanCidrs:SITE.lanCidrs})).devices.map(d=>d.name),['in']);
 assert.deepEqual((await readRouter(dir)).devices.map(d=>d.name),['in','broadcast','elsewhere'],'no LAN configured: every well-formed address');
 assert.deepEqual(systemMachines(SITE).map(m=>m.id),['mini','studio','mini_server','nas']);
 const index=await readFile(new URL('../public/index.html',import.meta.url),'utf8');assert.doesNotMatch(index,/Example|Europe\//,'no site name or zone baked into the page');
});
