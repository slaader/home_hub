import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {parseSystemsProbe,buildSystems,versionStatus,systemsSpecs,listenEntry} from '../server/systems-data.mjs';
import {compareVersions,extractVersion} from '../server/versions.mjs';
import {pickRelease,resolveUpstream,checkUpstreams,upstreamKey,collectUpstreams} from '../server/systems-upstream.mjs';
import {createHandler} from '../server/index.mjs';
import {hashPassword} from '../server/auth.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const T='\t',rec=(...f)=>f.join(T);

const macProbe=[
 rec('HOST','mini','Darwin','alice','1','2026-11-08T12:00:00Z'),
 rec('OS','macOS','26.7.1','25G241','25.6.0','arm64'),
 rec('HW','Macmini9,1','Apple M1','17179869184','8'),
 rec('UPTIME',String(Date.parse('2026-11-08T12:00:00Z')/1000-7200)),
 rec('SWU','* Label: Safari27.2TahoeAuto-27.2'),rec('SWU','Title: Safari, Version: 27.2, Size: 250130KiB, Recommended: YES, '),
 rec('SWU','* Label: macOS Tahoe 26.7.2-25G332'),rec('SWU','Title: macOS Tahoe 26.7.2, Version: 26.7.2, Size: 2994108KiB, Recommended: YES, Action: restart, '),
 rec('SWU','* Label: macOS 27.2-26B123'),rec('SWU','Title: macOS 27.2, Version: 27.2, Size: 11185069KiB, Recommended: YES, Action: restart, '),
 rec('AUTO','CriticalUpdateInstall','unset'),rec('AUTO','ConfigDataInstall','1'),rec('AUTO','AutomaticallyInstallMacOSUpdates','unset'),
 rec('FW','global','0'),rec('FW','stealth','off'),rec('PF','Disabled','2'),
 rec('FV','FileVault is On.'),rec('SIP','System Integrity Protection status: enabled.'),rec('GK','assessments enabled'),
 rec('SSHD','remotelogin','on'),rec('SSHD','PasswordAuthentication','yes'),rec('SSHD','KbdInteractiveAuthentication','yes'),
 rec('SSHD','AllowUsers','alice@10.0.0.151'),rec('SSHD','AllowUsers','alice@10.0.0.25'),
 rec('SHARE','com.apple.screensharing','loaded'),rec('SHARE','com.apple.smbd','off'),
 rec('LISTEN','launchd','root','*:22'),rec('LISTEN','T3\\x20Code','alice','*:3773'),rec('LISTEN','Python','alice','127.0.0.1:8000'),rec('LISTEN','launchd','root','*:22'),
 rec('SW','llama.cpp','cmd','version: 8670 (af76639f7) built with AppleClang','/u/llama-b8670/llama-server',''),
 rec('SW','llama.cpp','cmd','version: 0.5.0-dev (build 11200, commit 81bc6b83f)','/u/llama-b11200/llama-server','running'),
 rec('RUN','llama.cpp','4711','com.example.ob1-embeddings'),
 rec('SW','omlx','pydist','0.3.9.dev2','/u/omlx/venv/lib/python3.11/site-packages'),rec('SW','omlx','pydist','0.7.3','/u/omlx/venv-0.7.3/lib/python3.12/site-packages'),
 rec('SW','llama-swap','brew','268','llama-swap','mostlygeek/llama-swap'),rec('RUN','llama-swap','absent','com.openai.local-ai.llama-swap'),
 rec('SW','node','cmd','v25.9.0','/u/node'),
 rec('SW','thermo','app','0.8.1','/Applications/Thermo.app','103'),
 rec('SW','grok','missing','','/u/.grok/bin/grok'),
 rec('BREWOUT','fmt','12.2.0','12.2.1'),
 rec('DOCKER','open-design','vanjayak/open-design:latest','Up 2 days (healthy)','2026-05-08T10:00:00Z'),
 rec('END','ok')].join('\n');

const nasProbe=[
 rec('HOST','nas','Linux','svc_hub','1','2026-11-08T12:00:00Z'),
 rec('OS','TrueNAS','25.10.7','Debian GNU/Linux 12 (bookworm)','6.12.105-production+truenas','x86_64'),
 rec('HW','MS-7D73','AMD Ryzen 9 7900 12-Core Processor','100388098048','24'),rec('UPTIME','1394522'),
 rec('TNUPDATE','NORMAL','TrueNAS-SCALE-Goldeye','MISSION_CRITICAL','25.10.8','2026-11-03','Updates the Linux kernel to address more than 1,600 upstream CVEs.'),
 rec('APP','immich','RUNNING','1.14.58','v3.3.5_1.14.58','true','false','false','community','immich'),rec('APPUP','immich','1.14.62','v3.3.6_1.14.62','v3.3.6_1.14.62'),
 rec('APP','wiki','RUNNING','1.0.0','1.0.0_custom','true','true','true','stable','custom-app'),rec('APPUP','wiki','1.0.0','1.0.0_custom','1.0.0_custom'),
 rec('APP','home-hub','STOPPED','1.0.0','1.0.0_custom','false','false','true','stable','custom-app'),
 rec('SERVICE','ftp','RUNNING','true'),rec('SERVICE','cifs','RUNNING','true'),rec('SERVICE','ups','STOPPED','false'),
 rec('FTP','21','false','false','false'),
 rec('SSHD','passwordauthentication','no'),rec('SSHD','kbdinteractiveauthentication','no'),rec('SSHD','permitrootlogin','without-password'),rec('SSHD','allowtcpforwarding','no'),
 rec('NFT','accept:1 ','141','ip nat,ip filter,inet cf_metrics'),
 rec('LISTEN','proftpd','root','*:21'),rec('LISTEN','smbd','root','0.0.0.0:445'),rec('LISTEN','?','root','127.0.0.1:6000'),
 rec('END','ok')].join('\n');

const registry={categories:{ai:'AI runtimes',infra:'Servers'},items:[
 {id:'llama.cpp',name:'llama.cpp',category:'ai',scheme:'llamacpp',upstream:{type:'github',repo:'ggml-org/llama.cpp'},
  detect:{mini:{kind:'cmd',path:'~/x/llama-b*/llama-server',args:'--version',match:'version: (\\S+)',launchd:'com.example.ob1-embeddings',source:{label:'GitHub release',url:'https://github.com/ggml-org/llama.cpp/releases'}}}},
 {id:'omlx',name:'oMLX',category:'ai',upstream:{type:'github',repo:'jundot/omlx'},detect:{mini:{kind:'pydist',glob:'~/omlx/venv*/lib/python*/site-packages',package:'omlx'}}},
 {id:'llama-swap',name:'llama-swap',category:'ai',upstream:{type:'github',repo:'mostlygeek/llama-swap'},detect:{mini:{kind:'brew',formula:'llama-swap',launchd:'com.openai.local-ai.llama-swap'}}},
 {id:'node',name:'Node.js',category:'infra',scheme:'node',upstream:{type:'node'},detect:{mini:{kind:'cmd',path:'~/.local/bin/node',args:'--version'}}},
 {id:'thermo',name:'Thermo',category:'infra',upstream:{type:'thermo-feed',url:'https://feed.example/stable.json'},detect:{mini:{kind:'app',path:'/Applications/Thermo.app'}}},
 {id:'grok',name:'Grok',category:'infra',upstream:{type:'none',note:'no feed'},detect:{mini:{kind:'cmd',path:'~/.grok/bin/grok',args:'--version'}}}]};
const upstream={checkedAt:'2026-11-08T12:00:00Z',results:{
 'github:ggml-org/llama.cpp':{ok:true,version:'0.9.0',url:'https://github.com/ggml-org/llama.cpp/releases/tag/v0.9.0'},
 'github:jundot/omlx':{ok:true,version:'0.7.3'},'github:mostlygeek/llama-swap':{ok:true,version:'271'},
 'node':{ok:true,version:'26.13.0',ltsMajor:26,ltsMajors:[22,24,26],latestByMajor:{26:'26.13.0',25:'25.9.0',24:'24.22.2'}},
 'thermo-feed:https://feed.example/stable.json':{ok:true,version:'0.8.1',build:104}}};

test('versions: pre-releases, Homebrew revisions, tag prefixes, extraction',()=>{
 assert.equal(compareVersions('0.7.3rc1','0.7.3'),-1);
 assert.equal(compareVersions('0.5.0-dev','0.5.0'),-1);
 assert.equal(compareVersions('268','271'),-1);
 assert.equal(compareVersions('2026.3.0','2026.10.7'),-1);
 assert.equal(compareVersions('26.13.0_2','26.13.0'),0);
 assert.equal(compareVersions('v.0.24.0','0.24.0'),0);
 assert.equal(compareVersions('0.44.2','0.44.0'),1);
 assert.equal(compareVersions('latest','1.0'),null);
 assert.equal(extractVersion('2.1.316 (Claude Code)'),'2.1.316');
 assert.equal(extractVersion('codex-cli 0.166.0'),'0.166.0');
 assert.equal(extractVersion('t3 v0.1.6'),'0.1.6');
 assert.equal(extractVersion('v2.11.9 h1:bhZtcRKQOq0fuLvEg='),'2.11.9');
 assert.equal(extractVersion('forgejo version 17.0.1 (release name 17.0.1)','version (\\S+)'),'17.0.1');
 assert.equal(extractVersion('version: v268 (2576af3), built at x','version: v?(\\S+)'),'268');
});

test('listen entries: scope from the bound address',()=>{
 assert.equal(listenEntry('launchd','root','*:22').scope,'all');
 assert.equal(listenEntry('nginx','root','[::]:80').scope,'all');
 assert.equal(listenEntry('Python','u','127.0.0.1:8000').scope,'loopback');
 assert.equal(listenEntry('x','u','[::1]:8000').scope,'loopback');
 assert.equal(listenEntry('caddy','root','10.0.0.74:443').scope,'address');
 assert.equal(listenEntry('T3\\x20Code','u','*:3773').proc,'T3 Code');
 assert.equal(listenEntry('x','u','garbage'),null);
});

test('macOS probe parses OS, updates, protection, software and dedupes sockets',()=>{
 const h=parseSystemsProbe(macProbe);
 assert.equal(h.complete,true);assert.equal(h.platform,'mac');
 assert.deepEqual(h.os,{name:'macOS',version:'26.7.1',build:'25G241',kernel:'25.6.0',arch:'arm64'});
 assert.equal(h.uptimeSeconds,7200);
 assert.equal(h.osUpdates.items.length,3);assert.equal(h.osUpdates.items[1].restart,true);assert.equal(h.osUpdates.items[0].label,'Safari27.2TahoeAuto-27.2');
 assert.equal(h.sshd.passwordauthentication,'yes');assert.deepEqual(h.sshd.allowUsers,['alice@10.0.0.151','alice@10.0.0.25']);
 assert.equal(h.listening.length,3,'duplicate *:22 collapsed');
 assert.equal(h.software['llama.cpp'].length,2);assert.equal(h.running['llama.cpp'].pid,4711);assert.equal(h.running['llama-swap'].state,'absent');
 assert.equal(h.fileVault,'on');assert.equal(h.sip,'on');assert.equal(h.gatekeeper,'on');assert.equal(h.pf.status,'disabled');
 assert.equal(parseSystemsProbe(macProbe.replace('END\tok','')).complete,false);
});

test('TrueNAS probe parses update, apps with targets, services and firewall',()=>{
 const h=parseSystemsProbe(nasProbe);
 assert.equal(h.platform,'linux');assert.equal(h.truenasUpdate.version,'25.10.8');
 assert.equal(h.apps.find(a=>a.name==='immich').latestHuman,'v3.3.6_1.14.62');
 assert.deepEqual(h.nft.inputPolicies,[{policy:'accept',chains:1}]);
 assert.equal(h.ftp.tls,false);assert.equal(h.uptimeSeconds,1394522);
});

test('version status: legacy llama.cpp builds, Node lines, feed builds, gaps',()=>{
 assert.equal(versionStatus({installed:'8670',scheme:'llamacpp',upstream:{ok:true,version:'0.9.0'},up:{type:'github'}}).status,'update');
 assert.equal(versionStatus({installed:'0.9.0',scheme:'llamacpp',upstream:{ok:true,version:'0.9.0'},up:{type:'github'}}).status,'current');
 const node=upstream.results.node;
 const odd=versionStatus({installed:'25.9.0',scheme:'node',upstream:node,up:{type:'node'}});assert.equal(odd.status,'update');assert.equal(odd.latest,'26.13.0');
 const lts24=versionStatus({installed:'24.22.2',scheme:'node',upstream:node,up:{type:'node'}});assert.equal(lts24.status,'current');assert.equal(lts24.latest,'24.22.2');
 assert.equal(versionStatus({installed:'0.8.1',build:'103',upstream:{ok:true,version:'0.8.1',build:104},up:{type:'thermo-feed'}}).status,'update');
 assert.equal(versionStatus({installed:'1.0',upstream:null,up:{type:'none'}}).status,'n/a');
 assert.equal(versionStatus({installed:'1.0',upstream:{ok:false,error:'HTTP 500'},up:{type:'pypi'}}).status,'unknown');
 assert.equal(versionStatus({installed:null,upstream:{ok:true,version:'1'},up:{type:'pypi'}}).status,'missing');
 assert.equal(versionStatus({installed:'0.44.2',upstream:{ok:true,version:'0.44.0'},up:{type:'github'}}).status,'ahead');
});

test('payload: rows pick the running binary and the newest venv; checks and summary per machine',()=>{
 const snapshot={collectedAt:'2026-11-08T12:00:00Z',machines:{mini:parseSystemsProbe(macProbe),nas:parseSystemsProbe(nasProbe)}};
 const doc=buildSystems({snapshot,upstream,registry,now:Date.parse('2026-11-08T12:05:00Z')});
 const row=(id,m='mini')=>doc.software.find(r=>r.id===id&&r.machine===m);
 assert.equal(row('llama.cpp').installed,'0.5.0-dev','running candidate wins over the older install');
 assert.deepEqual(row('llama.cpp').others,['8670 (/u/llama-b8670/llama-server)']);
 assert.equal(row('llama.cpp').status,'update');assert.equal(row('llama.cpp').running,'running');
 assert.equal(row('omlx').installed,'0.7.3');assert.equal(row('omlx').status,'current');
 assert.equal(row('llama-swap').source.label,'Homebrew tap mostlygeek/llama-swap');assert.equal(row('llama-swap').source.url,'https://github.com/mostlygeek/homebrew-llama-swap');
 assert.equal(row('node').status,'update');assert.equal(row('thermo').status,'update');
 assert.equal(row('grok').status,'missing');
 assert.equal(row('docker:open-design').status,'floating');
 assert.equal(row('app:immich','nas').status,'update');assert.equal(row('app:immich','nas').latest,'v3.3.6_1.14.62');
 assert.match(row('app:wiki','nas').note,/nový obraz/);assert.equal(row('app:home-hub','nas').running,'absent');
 const mini=doc.machines.find(m=>m.id==='mini'),nas=doc.machines.find(m=>m.id==='nas');
 assert.equal(mini.os.status,'update','26.7.2 is in the same major line');
 assert.deepEqual(mini.os.updates.map(u=>u.kind),['app','minor','major']);
 const c=(m,id)=>m.checks.find(x=>x.id===id);
 assert.equal(c(mini,'firewall').state,'warn');assert.equal(c(mini,'filevault').state,'ok');
 assert.equal(c(mini,'ssh-password').state,'warn');assert.match(c(mini,'ssh-password').detail,/10\.0\.0\.151/);
 assert.equal(c(mini,'security-responses').state,'ok');
 assert.equal(c(nas,'firewall').state,'warn');assert.equal(c(nas,'ftp').state,'warn');assert.equal(c(nas,'ssh-password').state,'ok');
 assert.match(c(nas,'os-update').detail,/^Bezpečnostní vydání/);
 assert.equal(c(nas,'exposed').value,'2 portů');
 assert.equal(nas.summary.appUpdates,2);assert.equal(nas.summary.osUpdate,1);
 assert.equal(doc.machines.find(m=>m.id==='studio').reachable,false);
});

test('upstream: highest stable release, prefixes, patterns, ETag reuse and stale fallback',async()=>{
 const rel=(tag,extra={})=>({tag_name:tag,html_url:`https://x/${tag}`,published_at:'2026-11-01T00:00:00Z',...extra});
 assert.equal(pickRelease([rel('v1.19.5'),rel('v2.2.6'),rel('v2.3.0-beta.1',{prerelease:true}),rel('v2.2.5')]).version,'2.2.6');
 assert.equal(pickRelease([rel('v0.7.4.dev1'),rel('v0.7.3')]).version,'0.7.3','dev tags are skipped even without the prerelease flag');
 assert.equal(pickRelease([rel('rust-v0.167.0'),rel('rust-v0.166.0'),rel('v9.9.9')],{tagPrefix:'rust-v'}).version,'0.167.0');
 assert.equal(pickRelease([rel('b12001'),rel('v0.9.0')],{tagPattern:'^v?\\d+\\.\\d+\\.\\d+$'}).version,'0.9.0');
 assert.equal(pickRelease([rel('v1.0.0',{draft:true})]),null);
 const calls=[];
 const fetchJson=async(url,{etag}={})=>{calls.push([url,etag]);
  if(url.endsWith('/releases/latest'))return {status:200,json:rel('v0.9.0')};
  if(url.includes('api.github.com'))return etag==='"e1"'?{status:304,etag}:{status:200,etag:'"e1"',json:[rel('b12001'),rel('b12000')]};
  if(url.includes('dist-tags'))return {status:200,json:{latest:'2.1.319',stable:'2.1.311'}};
  if(url.includes('pypi.org'))return {status:200,json:{info:{version:'0.6.4'},releases:{'0.6.4':[{upload_time_iso_8601:'2026-11-02T00:00:00Z'}]}}};
  if(url.includes('nodejs.org'))return {status:200,json:[{version:'v27.0.0-alpha.1',lts:false},{version:'v26.13.0',lts:'Lithium'},{version:'v25.9.0',lts:false},{version:'v24.22.2',lts:'Krypton'},{version:'v24.21.0',lts:'Krypton'}]};
  if(url.includes('formulae.brew.sh/api/cask'))return {status:200,json:{version:'4.23118.0,8175c354'}};
  if(url.includes('feed.example'))return {status:200,json:{manifest:Buffer.from(JSON.stringify({version:'0.8.1',build:104})).toString('base64')}};
  throw new Error('HTTP 503 '+url);};
 const gh=await resolveUpstream({type:'github',repo:'ggml-org/llama.cpp',tagPattern:'^v?\\d+\\.\\d+\\.\\d+$'},{fetchJson});
 assert.equal(gh.version,'0.9.0','latest release joins the page when builds crowd it out');assert.equal(gh.cache.list.etag,'"e1"');
 const again=await resolveUpstream({type:'github',repo:'ggml-org/llama.cpp'},{fetchJson,previous:gh});
 assert.equal(again.version,'0.9.0');assert.equal(calls.at(-2)[1],'"e1"','second call sends If-None-Match');assert.match(calls.at(-1)[0],/\/releases\/latest$/,'a list 304 does not skip /latest');
 assert.equal((await resolveUpstream({type:'npm',package:'@anthropic-ai/claude-code'},{fetchJson})).version,'2.1.319');
 assert.equal((await resolveUpstream({type:'pypi',package:'mlx-audio'},{fetchJson})).publishedAt,'2026-11-02T00:00:00Z');
 const node=await resolveUpstream({type:'node'},{fetchJson});
 assert.equal(node.version,'26.13.0');assert.deepEqual(node.ltsMajors.sort(),[24,26]);assert.equal(node.latestByMajor[24],'24.22.2');assert.equal(node.latestByMajor[27],undefined);
 assert.equal((await resolveUpstream({type:'brew-cask',name:'claude'},{fetchJson})).version,'4.23118.0');
 assert.equal((await resolveUpstream({type:'thermo-feed',url:'https://feed.example/stable.json'},{fetchJson})).build,104);
 const reg={items:[{id:'a',upstream:{type:'pypi',package:'x'}},{id:'b',upstream:{type:'codeberg',repo:'f/f'}}]};
 assert.deepEqual([...collectUpstreams(reg).keys()],['pypi:x','codeberg:f/f']);
 const first=await checkUpstreams(reg,{fetchJson,now:()=>'t1'});
 assert.equal(first.results['pypi:x'].ok,true);assert.equal(first.results['codeberg:f/f'].ok,false);
 const prev={results:{'codeberg:f/f':{ok:true,version:'17.0.1'}}};
 const second=await checkUpstreams(reg,{fetchJson,previous:prev,now:()=>'t2'});
 assert.equal(second.results['codeberg:f/f'].version,'17.0.1');assert.equal(second.results['codeberg:f/f'].stale,true);
 assert.equal(upstreamKey({type:'none'}),null);
});

test('probe specs: one line per watched item, separators stripped',()=>{
 const reg={items:[{id:'x',detect:{mini:{kind:'cmd',path:"/a b/c|d'e",args:'--version',launchd:'system/l'}}},{id:'y',detect:{studio:{kind:'brew',formula:'f'}}}]};
 assert.equal(systemsSpecs(reg,'mini'),'x|cmd|/a b/c d e|--version|system/l');
 assert.equal(systemsSpecs(reg,'nas'),'');
});

test('shipped registry: every item resolves to a known upstream and detect kind',async()=>{
 const reg=JSON.parse(await (await import('node:fs/promises')).readFile(path.join(root,'config','software-watch.json'),'utf8'));
 for(const item of reg.items){
  assert.ok(reg.categories[item.category],`${item.id}: category`);
  assert.ok(item.upstream.type==='none'||upstreamKey(item.upstream),`${item.id}: upstream`);
  for(const [m,d] of Object.entries(item.detect)){
   assert.ok(['mini','studio','mini_server'].includes(m),`${item.id}: machine ${m}`);
   assert.ok(['brew','cask','app','cmd','pydist','json'].includes(d.kind),`${item.id}/${m}: kind`);
   assert.doesNotMatch(systemsSpecs({items:[item]},m),/\n/);
  }
 }
});

test('probe scripts are valid POSIX sh',()=>{
 for(const f of ['mac-probe.sh','nas-probe.sh']){const r=spawnSync('/bin/sh',['-n',path.join(root,'scripts','systems',f)]);assert.equal(r.status,0,`${f}: ${r.stderr}`);}
});

test('/api/systems: sign-in required, admin only, 404 until collected, assets served',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'hub-sys-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const origin='http://127.0.0.1:8997',credentials={username:'admin',...hashPassword('test-systems-password')};
 const server=http.createServer(createHandler({directory:dir,stateDirectory:dir,credentials,origin,secure:false,bridgeRequest:async()=>{throw new Error('offline');}}));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections?.();return new Promise(r=>server.close(r));});
 const base=`http://127.0.0.1:${server.address().port}`;
 assert.equal((await fetch(`${base}/api/systems`)).status,401);
 const login=await fetch(`${base}/api/session`,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify({username:'admin',password:'test-systems-password'})});
 assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
 const missing=await fetch(`${base}/api/systems`,{headers:{Cookie:cookie}});
 assert.equal(missing.status,404);assert.equal((await missing.json()).error.code,'SYSTEMS_MISSING');
 await mkdir(path.join(dir,'systems'),{recursive:true});
 await writeFile(path.join(dir,'systems','snapshot.json'),JSON.stringify({collectedAt:'2026-11-08T12:00:00Z',machines:{nas:parseSystemsProbe(nasProbe)}}));
 const ok=await fetch(`${base}/api/systems`,{headers:{Cookie:cookie}});
 assert.equal(ok.status,200);const doc=await ok.json();
 assert.equal(doc.machines.length,4);assert.equal(doc.machines.find(m=>m.id==='nas').os.status,'update');
 assert.ok(doc.software.some(r=>r.id==='app:immich'));
 for(const asset of ['/systems-view.js','/systems.css','/session-cache.js'])assert.equal((await fetch(`${base}${asset}`)).status,200,asset);
});

test('nftables without input hooks is unfiltered ingress (warn), not a policy named "none"',()=>{
 const withNft=line=>nasProbe.replace(/NFT\t[^\n]*/,line);
 const fw=probe=>{const h=parseSystemsProbe(probe);return {nft:h.nft,check:buildSystems({snapshot:{machines:{nas:{...h,complete:true}}},upstream,registry}).machines.find(m=>m.id==='nas').checks.find(c=>c.id==='firewall')};};
 // Empty ruleset: no tables, no chains.
 let r=fw(withNft(rec('NFT','none','0','')));
 assert.deepEqual(r.nft.inputPolicies,[]);assert.equal(r.nft.inputHooks,0);
 assert.equal(r.check.state,'warn');assert.equal(r.check.value,'vstup nefiltrován');assert.match(r.check.detail,/ruleset je prázdný/);
 // Tables exist (Docker NAT, metrics) but no chain hooks input.
 r=fw(withNft(rec('NFT','none','141','ip nat,ip filter,inet cf_metrics')));
 assert.equal(r.nft.inputHooks,0);assert.equal(r.check.state,'warn');assert.match(r.check.detail,/ip nat, ip filter, inet cf_metrics/);
 // A dropping input chain is a real firewall; accept-only stays a warning.
 assert.equal(fw(withNft(rec('NFT','drop:1 ','20','inet filter'))).check.state,'ok');
 assert.equal(fw(withNft(rec('NFT','accept:2 drop:1 ','20','inet filter'))).check.state,'ok');
 assert.equal(fw(withNft(rec('NFT','accept:1 ','141','ip nat'))).check.value,'vstup povolen (accept)');
 assert.equal(fw(withNft(rec('NFT','unknown'))).check.state,'unknown');
 // Snapshot persisted by the old parser (policy "none") still reads as unfiltered.
 const legacy=parseSystemsProbe(nasProbe);legacy.nft={inputPolicies:[{policy:'none',chains:null}],rules:0,tables:[]};
 assert.equal(buildSystems({snapshot:{machines:{nas:{...legacy,complete:true}}},upstream,registry}).machines.find(m=>m.id==='nas').checks.find(c=>c.id==='firewall').value,'vstup nefiltrován');
});

test('a failed upstream check (403/429) reaches the payload as stale/unverified, never as fresh "current"',async()=>{
 const reg={categories:{ai:'AI'},items:[
  {id:'omlx',name:'oMLX',category:'ai',upstream:{type:'github',repo:'jundot/omlx'},detect:{mini:{kind:'pydist',glob:'~/omlx/venv*/lib/python*/site-packages',package:'omlx'}}},
  {id:'llama-swap',name:'llama-swap',category:'ai',upstream:{type:'github',repo:'mostlygeek/llama-swap'},detect:{mini:{kind:'brew',formula:'llama-swap'}}}]};
 const snapshot={machines:{mini:parseSystemsProbe(macProbe)}};
 const rel=v=>({tag_name:`v${v}`,html_url:`https://x/${v}`});
 // First run succeeds: omlx is current (0.7.3), llama-swap has an update (installed 268 < 271).
 const ok=async url=>url.includes('jundot/omlx')?{status:200,etag:'"o"',json:[rel('0.7.3')]}:{status:200,etag:'"l"',json:[rel('271')]};
 const first=await checkUpstreams(reg,{fetchJson:ok,now:()=>'2026-11-08T06:00:00.000Z'});
 const row=(up,id)=>buildSystems({snapshot,upstream:up,registry:reg}).software.find(r=>r.id===id&&r.machine==='mini');
 const omlx0=row(first,'omlx');
 assert.equal(omlx0.upstreamStale,false);assert.equal(omlx0.upstreamCheckedAt,'2026-11-08T06:00:00.000Z');
 // Second run: GitHub rate-limits every request.
 const limited=async url=>{throw new Error(`HTTP ${url.includes('omlx')?403:429} ${url}`);};
 const second=await checkUpstreams(reg,{fetchJson:limited,previous:first,now:()=>'2026-11-08T18:00:00.000Z'});
 const r=second.results['github:jundot/omlx'];
 assert.equal(r.stale,true);assert.match(r.error,/HTTP 403/);assert.equal(r.checkedAt,'2026-11-08T06:00:00.000Z','checkedAt stays the last success');assert.equal(r.failedAt,'2026-11-08T18:00:00.000Z');
 const doc=buildSystems({snapshot,upstream:second,registry:reg});
 const omlx=doc.software.find(x=>x.id==='omlx'&&x.machine==='mini');
 assert.equal(omlx0.status,'current');assert.equal(omlx.status,'unknown','a stale source cannot claim current');assert.match(omlx.note,/selhala \(HTTP 403/);
 const swap=doc.software.find(x=>x.id==='llama-swap'&&x.machine==='mini');assert.equal(swap.status,'update','a known newer release stays an update');assert.equal(swap.upstreamStale,true);
 assert.equal(omlx.upstreamStale,true);assert.match(omlx.upstreamError,/HTTP 403/);
 assert.equal(omlx.upstreamCheckedAt,'2026-11-08T06:00:00.000Z');assert.equal(omlx.upstreamFailedAt,'2026-11-08T18:00:00.000Z');
 assert.equal(doc.upstreamFailed,2);
 // A third run that succeeds (here via ETag 304) clears the stale marker.
 const fresh=async(url,{etag}={})=>etag?{status:304,etag}:{status:200,json:rel('0.7.3')};
 const third=await checkUpstreams(reg,{fetchJson:fresh,previous:second,now:()=>'2026-11-09T06:00:00.000Z'});
 assert.equal(third.results['github:jundot/omlx'].stale,undefined);assert.equal(third.results['github:jundot/omlx'].error,undefined);
 assert.equal(buildSystems({snapshot,upstream:third,registry:reg}).software.find(x=>x.id==='omlx').upstreamStale,false);
 // Never-succeeded source: ok:false → unknown and flagged too.
 const none=await checkUpstreams(reg,{fetchJson:limited,now:()=>'t'});
 const n=buildSystems({snapshot,upstream:none,registry:reg}).software.find(x=>x.id==='omlx');assert.equal(n.status,'unknown');assert.equal(n.upstreamStale,true);
});
test('versionStatus: stale upstream keeps an update but demotes current/ahead to unknown',()=>{
 const up={type:'github'};
 assert.equal(versionStatus({installed:'1.0.0',upstream:{ok:true,version:'1.0.0',stale:true,error:'HTTP 429 x',checkedAt:'2026-11-01T00:00:00Z'},up}).status,'unknown');
 assert.equal(versionStatus({installed:'2.0.0',upstream:{ok:true,version:'1.0.0',stale:true,error:'HTTP 429 x'},up}).status,'unknown');
 const u=versionStatus({installed:'0.9.0',upstream:{ok:true,version:'1.0.0',stale:true,error:'HTTP 429 x'},up});assert.equal(u.status,'update');assert.match(u.note,/HTTP 429/);
 assert.equal(versionStatus({installed:'1.0.0',upstream:{ok:true,version:'1.0.0'},up}).status,'current');
});

import {createFetchJson,loadGithubToken} from '../server/systems-upstream.mjs';
test('optional GitHub token: only api.github.com gets it, never across redirects, never in the output',async t=>{
 const TOKEN='github_pat_'+'A1b2'.repeat(10);
 const seen=[];
 const fake=async(url,{headers})=>{seen.push([url,headers.Authorization||null]);
  const u=new URL(url);
  if(u.pathname==='/redirect-away')return new Response(null,{status:302,headers:{location:'https://objects.example.net/x'}});
  if(u.pathname==='/repos/old/name/releases')return new Response(null,{status:301,headers:{location:'https://api.github.com/repositories/1/releases'}});
  if(u.hostname==='api.github.com'&&u.pathname.includes('limited'))return new Response('{}',{status:403});
  return Response.json([{tag_name:'v1.2.3',html_url:'https://x'}],{headers:{etag:'"e"'}});};
 const withToken=createFetchJson({token:TOKEN,fetchImpl:fake});
 await withToken('https://api.github.com/repos/a/b/releases?per_page=20');
 await withToken('https://codeberg.org/api/v1/repos/a/b/releases');
 await withToken('https://pypi.org/pypi/x/json');
 await withToken('https://evil.example/?u=https://api.github.com/');
 await withToken('https://api.github.com.evil.example/repos/a/b');
 await withToken('http://api.github.com/repos/a/b');
 await withToken('https://api.github.com/redirect-away');
 await withToken('https://api.github.com/repos/old/name/releases');
 assert.deepEqual(seen.map(([u,a])=>[u,a?'token':null]),[
  ['https://api.github.com/repos/a/b/releases?per_page=20','token'],['https://codeberg.org/api/v1/repos/a/b/releases',null],['https://pypi.org/pypi/x/json',null],
  ['https://evil.example/?u=https://api.github.com/',null],['https://api.github.com.evil.example/repos/a/b',null],['http://api.github.com/repos/a/b',null],
  ['https://api.github.com/redirect-away','token'],['https://objects.example.net/x',null],
  ['https://api.github.com/repos/old/name/releases','token'],['https://api.github.com/repositories/1/releases','token']]);
 assert.equal(seen[0][1],`Bearer ${TOKEN}`);
 // Without a token nothing changes: no Authorization header anywhere.
 seen.length=0;await createFetchJson({fetchImpl:fake})('https://api.github.com/repos/a/b/releases');assert.equal(seen[0][1],null);
 // The token never reaches errors or the upstream.json document.
 const reg={items:[{id:'a',upstream:{type:'github',repo:'x/limited'}},{id:'b',upstream:{type:'github',repo:'x/ok'}}]};
 const doc=await checkUpstreams(reg,{fetchJson:withToken});
 assert.match(doc.results['github:x/limited'].error,/HTTP 403/);assert.equal(doc.results['github:x/ok'].version,'1.2.3');
 assert.doesNotMatch(JSON.stringify(doc),new RegExp(TOKEN));
 // Sources: env wins, then the private file; junk is ignored; missing file means anonymous.
 const dir=await mkdtemp(path.join(os.tmpdir(),'gh-token-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'github-token');
 assert.deepEqual(await loadGithubToken({env:{},file}),{token:null,source:null});
 await writeFile(file,TOKEN+'\n',{mode:0o600});
 assert.deepEqual(await loadGithubToken({env:{},file}),{token:TOKEN,source:'file'});
 assert.deepEqual(await loadGithubToken({env:{GITHUB_TOKEN:'ghp_'+'z'.repeat(36)},file}),{token:'ghp_'+'z'.repeat(36),source:'env'});
 assert.deepEqual(await loadGithubToken({env:{GITHUB_TOKEN_FILE:file}}),{token:TOKEN,source:'file'});
 await writeFile(file,'not a token\nsecond line');
 assert.equal((await loadGithubToken({env:{},file})).token,null);assert.equal((await loadGithubToken({env:{},file})).invalid,true);
});
test('check-upstream script prints no token and gitignore covers the token file',async()=>{
 const src=await (await import('node:fs/promises')).readFile(path.join(root,'scripts','check-upstream.mjs'),'utf8');
 assert.doesNotMatch(src,/console\.(log|warn|error)\([^)]*github\.token\b(?!\?)/,'only the token source is printed');
 assert.match(await (await import('node:fs/promises')).readFile(path.join(root,'.gitignore'),'utf8'),/^private\/$/m);
});

test('a failed GitHub /releases/latest fails the source: the shipped llama.cpp entry keeps 2.0.0 (stale), 1.0.0 is never "current"',async()=>{
 const shipped=JSON.parse(await (await import('node:fs/promises')).readFile(path.join(root,'config','software-watch.json'),'utf8'));
 const reg={categories:shipped.categories,items:shipped.items.filter(i=>i.id==='llama.cpp')};
 const key=upstreamKey(reg.items[0].upstream);assert.equal(key,'github:ggml-org/llama.cpp');
 const snapshot={machines:{mini_server:{...parseSystemsProbe([rec('HOST','mini_server','Darwin','alice','1','2026-11-08T12:00:00Z'),
  rec('SW','llama.cpp','cmd','version: 1.0.0 (build 12100, commit abc)','/u/llama-b12100/llama-server','running'),rec('END','ok')].join('\n')),complete:true}}};
 const row=up=>buildSystems({snapshot,upstream:up,registry:reg}).software.find(r=>r.id==='llama.cpp'&&r.machine==='mini_server');
 const rel=tag=>({tag_name:tag,html_url:`https://github.com/ggml-org/llama.cpp/releases/tag/${tag}`});
 // The first 20 releases are build tags plus 1.0.0; 2.0.0 is only reachable through /releases/latest.
 const page=[...Array.from({length:19},(_,i)=>rel(`b${12200-i}`)),rel('v1.0.0')];
 const site=({latest,listEtag})=>async url=>{const u=new URL(url);
  if(u.hostname==='formulae.brew.sh')return Response.json({versions:{stable:'1.0.0'}});
  if(u.pathname==='/repos/ggml-org/llama.cpp/releases/latest')return latest===200?Response.json(rel('v2.0.0')):new Response('{"message":"rate limited"}',{status:latest});
  if(u.pathname==='/repos/ggml-org/llama.cpp/releases')return Response.json(page,{headers:{etag:listEtag}});
  return new Response('{}',{status:500});};
 const first=await checkUpstreams(reg,{fetchJson:createFetchJson({fetchImpl:site({latest:200,listEtag:'"e1"'})}),now:()=>'2026-11-08T06:00:00.000Z'});
 assert.equal(first.results[key].version,'2.0.0');assert.equal(first.results[key].cache.list.etag,'"e1"');
 assert.equal(row(first).status,'update');assert.equal(row(first).latest,'2.0.0');
 // Next check: the list still answers (new builds, new ETag), but /latest is rate-limited.
 const second=await checkUpstreams(reg,{fetchJson:createFetchJson({fetchImpl:site({latest:403,listEtag:'"e2"'})}),previous:first,now:()=>'2026-11-08T18:00:00.000Z'});
 const r=second.results[key];
 assert.equal(r.version,'2.0.0','the partial page (1.0.0) does not replace the known 2.0.0');
 assert.equal(r.stale,true);assert.match(r.error,/HTTP 403 .*\/releases\/latest/);
 assert.equal(r.checkedAt,'2026-11-08T06:00:00.000Z');assert.equal(r.failedAt,'2026-11-08T18:00:00.000Z');
 assert.equal(r.cache.list.etag,'"e1"','the ETag of the rejected page is not stored, so a later 304 cannot confirm it');
 const doc=buildSystems({snapshot,upstream:second,registry:reg}),x=doc.software.find(s=>s.id==='llama.cpp'&&s.machine==='mini_server');
 assert.notEqual(x.status,'current');assert.equal(x.status,'update');assert.equal(x.latest,'2.0.0');
 assert.equal(x.upstreamStale,true);assert.match(x.upstreamError,/HTTP 403/);assert.equal(x.upstreamCheckedAt,'2026-11-08T06:00:00.000Z');
 assert.ok(doc.upstreamFailed>=1);
 // Without an earlier success the same failure is unverified (unknown), not "current".
 const cold=await checkUpstreams(reg,{fetchJson:createFetchJson({fetchImpl:site({latest:429,listEtag:'"e3"'})}),now:()=>'t'});
 assert.equal(cold.results[key].ok,false);assert.equal(row(cold).status,'unknown');assert.equal(row(cold).upstreamStale,true);
 // 404 from /latest is an answer ("no latest release"), not a failure; the page alone decides.
 const none=await checkUpstreams(reg,{fetchJson:createFetchJson({fetchImpl:site({latest:404,listEtag:'"e4"'})}),previous:first,now:()=>'t4'});
 assert.equal(none.results[key].version,'1.0.0');assert.equal(none.results[key].stale,undefined);assert.equal(row(none).status,'current');
 // A list answer that is not an array is a failure too, not an empty page.
 const junk=await checkUpstreams(reg,{fetchJson:async url=>url.includes('/releases/latest')?{status:200,json:rel('v2.0.0')}:url.includes('/releases')?{status:200,json:{message:'x'}}:{status:200,json:{versions:{stable:'1.0.0'}}},previous:first,now:()=>'t5'});
 assert.equal(junk.results[key].stale,true);assert.match(junk.results[key].error,/not an array/);
});

// A GitHub source needs two requests (release list and /releases/latest); an ETag validates only its own.
// site() answers each endpoint per run: 200 (with an ETag), 304 (only to a request that sent If-None-Match,
// else 200), or an error status. Every request and the If-None-Match it carried are recorded.
function releaseSite({list=200,latest=200,listEtag='"L1"',latestEtag='"R1"',latestTag='v1.0.0'}={},seen=[]){
 const rel=tag=>({tag_name:tag,html_url:`https://github.com/ggml-org/llama.cpp/releases/tag/${tag}`,published_at:'2026-11-01T00:00:00Z'});
 const page=[...Array.from({length:19},(_,i)=>rel(`b${12200-i}`)),rel('v1.0.0')];
 const answer=(mode,inm,etag,body)=>mode===304&&inm?new Response(null,{status:304}):mode===200||mode===304?Response.json(body,{headers:{etag}}):new Response('{"message":"rate limited"}',{status:mode});
 return async(url,{headers})=>{const u=new URL(url),inm=headers['If-None-Match']||null;
  if(u.hostname==='formulae.brew.sh')return Response.json({versions:{stable:'1.0.0'}});
  if(u.pathname==='/repos/ggml-org/llama.cpp/releases/latest'){seen.push(['latest',inm]);return answer(latest,inm,latestEtag,rel(latestTag));}
  if(u.pathname==='/repos/ggml-org/llama.cpp/releases'){seen.push(['list',inm]);return answer(list,inm,listEtag,page);}
  return new Response('{}',{status:500});};
}
async function llamaFixture(){
 const shipped=JSON.parse(await (await import('node:fs/promises')).readFile(path.join(root,'config','software-watch.json'),'utf8'));
 const reg={categories:shipped.categories,items:shipped.items.filter(i=>i.id==='llama.cpp')};
 const snapshot={machines:{mini_server:{...parseSystemsProbe([rec('HOST','mini_server','Darwin','alice','1','2026-11-08T12:00:00Z'),
  rec('SW','llama.cpp','cmd','version: 1.0.0 (build 12100, commit abc)','/u/llama-b12100/llama-server','running'),rec('END','ok')].join('\n')),complete:true}}};
 const row=up=>buildSystems({snapshot,upstream:up,registry:reg}).software.find(r=>r.id==='llama.cpp'&&r.machine==='mini_server');
 const run=async(spec,previous,now)=>{const seen=[];const doc=await checkUpstreams(reg,{fetchJson:createFetchJson({fetchImpl:releaseSite(spec,seen)}),previous,now:()=>now});return {doc,seen,r:doc.results['github:ggml-org/llama.cpp']};};
 return {row,run};
}

test('GitHub ETag: a 304 on the release list does not skip /releases/latest, so a failed /latest stays stale (unknown, not current)',async()=>{
 const {row,run}=await llamaFixture();
 const one=await run({},null,'2026-11-08T06:00:00.000Z');
 assert.equal(one.r.version,'1.0.0');assert.equal(row(one.doc).status,'current');
 const two=await run({list:200,latest:403},one.doc,'2026-11-08T18:00:00.000Z');
 assert.equal(two.r.stale,true);assert.equal(row(two.doc).status,'unknown');
 // Third run: the list is unchanged (304 to its ETag), /latest is still rate-limited.
 const three=await run({list:304,latest:403},two.doc,'2026-11-09T06:00:00.000Z');
 assert.deepEqual(three.seen,[['list','"L1"'],['latest','"R1"']],'both endpoints are asked, each with its own ETag');
 assert.equal(three.r.stale,true,'a list 304 alone cannot clear the failure');assert.match(three.r.error,/HTTP 403 .*\/releases\/latest/);
 assert.equal(three.r.checkedAt,'2026-11-08T06:00:00.000Z');assert.equal(three.r.failedAt,'2026-11-09T06:00:00.000Z');
 const x=row(three.doc);assert.equal(x.status,'unknown');assert.equal(x.upstreamStale,true);
});

test('GitHub ETag: list 304 + /latest 200 answers with the new latest; both 304 reuse the stored combination',async()=>{
 const {row,run}=await llamaFixture();
 const one=await run({},null,'2026-11-08T06:00:00.000Z');assert.equal(one.r.version,'1.0.0');
 // (b) The list did not change, but a new release became "latest" (off the first page).
 const two=await run({list:304,latest:200,latestEtag:'"R2"',latestTag:'v2.0.0'},one.doc,'2026-11-08T18:00:00.000Z');
 assert.deepEqual(two.seen,[['list','"L1"'],['latest','"R1"']]);
 assert.equal(two.r.version,'2.0.0');assert.equal(two.r.stale,undefined);assert.equal(two.r.checkedAt,'2026-11-08T18:00:00.000Z');
 assert.equal(two.r.cache.list.etag,'"L1"');assert.equal(two.r.cache.latest.etag,'"R2"');
 assert.equal(row(two.doc).status,'update');assert.equal(row(two.doc).latest,'2.0.0');
 // (c) Nothing changed: both answer 304 to their own ETags → fresh, same combined answer.
 const three=await run({list:304,latest:304},two.doc,'2026-11-09T06:00:00.000Z');
 assert.deepEqual(three.seen,[['list','"L1"'],['latest','"R2"']]);
 assert.equal(three.r.version,'2.0.0');assert.equal(three.r.stale,undefined);assert.equal(three.r.error,undefined);
 assert.equal(three.r.checkedAt,'2026-11-09T06:00:00.000Z');assert.equal(row(three.doc).upstreamStale,false);
 // A 304 recovers a stale source only if both endpoints validate it in the same run.
 const stale=await run({list:304,latest:503},three.doc,'t4');assert.equal(stale.r.stale,true);
 const back=await run({list:304,latest:304},stale.doc,'t5');assert.equal(back.r.stale,undefined);assert.equal(back.r.version,'2.0.0');
 // A 404 on /latest is an answer and is not cached; the next run asks without If-None-Match.
 const gone=await run({list:304,latest:404},back.doc,'t6');assert.equal(gone.r.version,'1.0.0');assert.equal(gone.r.stale,undefined);
 const after=await run({list:304,latest:200},gone.doc,'t7');assert.deepEqual(after.seen,[['list','"L1"'],['latest',null]]);
});

test('GitHub ETag: a cache written by older code (no cache version) is not trusted: full fetch, its ETags are not sent',async()=>{
 const {row,run}=await llamaFixture();
 // Pre-fix shape: one list ETag at the top level, here from a list-only answer (1.0.0) while 2.0.0 is latest.
 const legacy={schemaVersion:1,checkedAt:'2026-11-07T06:00:00.000Z',results:{'github:ggml-org/llama.cpp':{ok:true,version:'1.0.0',url:'https://x',publishedAt:null,etag:'"L1"',checkedAt:'2026-11-07T06:00:00.000Z'}}};
 const one=await run({list:304,latest:304,latestTag:'v2.0.0'},legacy,'2026-11-08T06:00:00.000Z');
 assert.deepEqual(one.seen,[['list',null],['latest',null]],'no If-None-Match from the legacy cache');
 assert.equal(one.r.version,'2.0.0','the partial legacy answer is not resurrected');assert.equal(row(one.doc).status,'update');
 assert.equal(one.r.etag,undefined);assert.equal(one.r.cache.v,2);assert.equal(one.doc.schemaVersion,2);
 // A legacy entry kept on failure stays untrusted: the next run still sends no ETag.
 const failed=await run({list:403},legacy,'t2');assert.equal(failed.r.stale,true);
 const next=await run({list:304,latest:304},failed.doc,'t3');assert.deepEqual(next.seen,[['list',null],['latest',null]]);assert.equal(next.r.stale,undefined);
 // A wrong cache version is ignored too.
 const bumped=structuredClone(next.doc);bumped.results['github:ggml-org/llama.cpp'].cache.v=1;
 assert.deepEqual((await run({list:304,latest:304},bumped,'t4')).seen,[['list',null],['latest',null]]);
});

test('ETag on other providers: Codeberg revalidates its single request; a 304 nobody asked for fails a source',async()=>{
 const seen=[];
 const fetchJson=createFetchJson({fetchImpl:async(url,{headers})=>{const u=new URL(url),inm=headers['If-None-Match']||null;seen.push([u.hostname+u.pathname,inm]);
  if(u.hostname==='codeberg.org')return inm==='"C1"'?new Response(null,{status:304}):Response.json([{tag_name:'v17.0.1',html_url:'https://codeberg.org/x'}],{headers:{etag:'"C1"'}});
  return new Response(null,{status:304,headers:{etag:'"bogus"'}});}});
 const cb={type:'codeberg',repo:'forgejo/forgejo'};
 const legacy={ok:true,version:'16.0.0',etag:'"C1"'};
 const one=await resolveUpstream(cb,{fetchJson,previous:legacy});
 assert.equal(one.version,'17.0.1');assert.deepEqual(seen.at(-1),['codeberg.org/api/v1/repos/forgejo/forgejo/releases',null],'legacy Codeberg ETag not sent');
 assert.equal(one.cache.latest,undefined,'Codeberg has no second request');
 const two=await resolveUpstream(cb,{fetchJson,previous:one});assert.equal(two.version,'17.0.1');assert.equal(seen.at(-1)[1],'"C1"');
 // PyPI, npm, Homebrew, Node and the Thermo feed never send If-None-Match; a 304 is a failure, not "unchanged".
 const reg={items:[{id:'p',upstream:{type:'pypi',package:'x'}},{id:'n',upstream:{type:'npm',package:'y'}},{id:'f',upstream:{type:'brew-formula',name:'z'}},
  {id:'c',upstream:{type:'brew-cask',name:'w'}},{id:'node',upstream:{type:'node'}},{id:'t',upstream:{type:'thermo-feed',url:'https://feed.example/stable.json'}}]};
 const previous={results:Object.fromEntries([...collectUpstreams(reg).keys()].map(k=>[k,{ok:true,version:'1.0.0',etag:'"bogus"',cache:{v:2}}]))};
 seen.length=0;const doc=await checkUpstreams(reg,{fetchJson,previous,now:()=>'t'});
 assert.ok(seen.length===6&&seen.every(([,inm])=>inm===null),'no conditional requests outside GitHub/Codeberg');
 for(const r of Object.values(doc.results)){assert.equal(r.stale,true);assert.match(r.error,/HTTP 304 without If-None-Match/);}
});
