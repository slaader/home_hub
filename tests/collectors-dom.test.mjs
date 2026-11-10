// The collector pages on a mocked DOM, with real payloads built by the server modules: versions, host
// protection, the software watch list, SSH keys and the router panel. Each is drawn in its four states
// (not configured, configured without a snapshot, stale, fine), in English without a single Czech word
// left over, and in Czech.
import test from 'node:test';
import assert from 'node:assert/strict';
import {installDom,fire} from './fixtures/mini-dom.mjs';
import {buildSystems,parseSystemsProbe,systemsSetup} from '../server/systems-data.mjs';
import {buildSecurity,securitySetup} from '../server/security-data.mjs';
import {normalizeRouter,ROUTER_ADAPTERS} from '../server/router-data.mjs';
import {describeWatch,emptyWatch} from '../server/software-watch.mjs';
import {validateSite} from '../server/site-config.mjs';
import {SITE} from './hub-helper.mjs';

const {document}=installDom();
const {systemsView,say,ago,every}=await import('../public/systems-view.js');
const {securityView}=await import('../public/security-view.js');
const {routerPanel}=await import('../public/router-view.js');
const {setPrincipal}=await import('../public/session-cache.js');
const i18n=await import('../public/i18n.js');

const T='\t',rec=(...f)=>f.join(T);
const NOW=Date.now(),iso=ms=>new Date(NOW-ms).toISOString(),HOUR=3600e3;
const macProbe=at=>[rec('HOST','mini','Darwin','alice','1',at),rec('OS','macOS','26.7.1','25G241','25.6.0','arm64'),rec('HW','Macmini9,1','Apple M1','17179869184','8'),
 rec('SWU','* Label: macOS Tahoe 26.7.2-25G332'),rec('SWU','Title: macOS Tahoe 26.7.2, Version: 26.7.2, Size: 1KiB, Recommended: YES, Action: restart, '),
 rec('FW','global','0'),rec('FW','stealth','off'),rec('PF','Enabled','12'),rec('FV','FileVault is Off.'),rec('SIP','System Integrity Protection status: enabled.'),rec('GK','assessments enabled'),
 rec('SSHD','remotelogin','on'),rec('SSHD','PasswordAuthentication','yes'),rec('SSHD','AllowUsers','alice@10.0.0.151'),rec('SHARE','com.apple.screensharing','loaded'),
 rec('LISTEN','launchd','root','*:22'),rec('LISTEN','Python','alice','127.0.0.1:8000'),
 rec('SW','node','brew','24.1.0','node',''),rec('SW','uv','brew','0.9.0','uv',''),rec('SW','ghost','missing','','/opt/homebrew/opt/ghost'),rec('RUN','node','4711','com.example.node'),
 rec('BREWOUT','fmt','12.2.0','12.2.1'),rec('DOCKER','searxng','searxng/searxng:latest','Up 2 days','2026-05-08T10:00:00Z'),rec('END','ok')].join('\n');
const nasProbe=at=>[rec('HOST','nas','Linux','svc','1',at),rec('OS','TrueNAS','25.10.7','Debian 12','6.12','x86_64'),rec('UPTIME','90000'),
 rec('TNUPDATE','NORMAL','train','MISSION_CRITICAL','25.10.8','2026-11-03','Fixes CVE-1.'),rec('APP','immich','RUNNING','1.0','v1','true','false','false','community','immich'),rec('APPUP','immich','1.1','v1.1','v1.1'),
 rec('SERVICE','ftp','RUNNING','true'),rec('SERVICE','cifs','RUNNING','true'),rec('FTP','21','false','false','true'),rec('SSHD','passwordauthentication','no'),rec('SSHD','permitrootlogin','no'),
 rec('NFT','none','0','ip nat'),rec('LISTEN','smbd','root','0.0.0.0:445'),rec('END','ok')].join('\n');
const registry={categories:{infra:'Servers and infrastructure',tools:'Toolchain'},items:[
 {id:'node',name:'Node.js',category:'infra',scheme:'node',upstream:{type:'node'},detect:{mini:{kind:'brew',formula:'node',launchd:'com.example.node'}}},
 {id:'uv',name:'uv',category:'tools',upstream:{type:'github',repo:'astral-sh/uv'},detect:{mini:{kind:'brew',formula:'uv'}}},
 {id:'ghost',name:'Ghost',category:'tools',upstream:{type:'none',note:'No feed.'},detect:{mini:{kind:'brew',formula:'ghost'}}}]};
const upstream=checked=>({checkedAt:checked,results:{node:{ok:true,version:'26.13.0',url:'https://nodejs.org/en/about/previous-releases',checkedAt:checked,ltsMajor:26,ltsMajors:[24,26],latestByMajor:{24:'24.22.2',26:'26.13.0'}},
 'github:astral-sh/uv':{ok:true,version:'0.9.4',url:'https://github.com/astral-sh/uv/releases/tag/0.9.4',publishedAt:'2026-11-01T00:00:00Z',checkedAt:iso(40*HOUR),stale:true,error:'HTTP 403 api.github.com',failedAt:checked}}});
const systemsDoc=(age=HOUR)=>buildSystems({snapshot:{collectedAt:iso(age),collectedFrom:'studio',machines:{mini:{...parseSystemsProbe(macProbe(iso(age))),stale:false},nas:parseSystemsProbe(nasProbe(iso(age)))}},
 upstream:upstream(iso(age)),registry,machines:[{id:'mini',name:'Mac mini',kind:'mac'},{id:'nas',name:'NAS',kind:'nas'},{id:'studio',name:'Mac Studio',kind:'mac'}],now:NOW,watchSource:'local'});

const KEY_A='SHA256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',KEY_R='SHA256:rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr';
const securityDoc=()=>buildSecurity({site:SITE,now:NOW,collectedFrom:'studio',probes:{
 studio:{text:[rec('HOST','studio','Darwin','alice','1',iso(HOUR)),rec('NET','10.0.0.151'),rec('LISTEN','on'),rec('SSHD','passwordauthentication','yes'),
  rec('USER','alice','501','/Users/alice','/bin/zsh','1'),rec('SUDO','alice','rule','(ALL) NOPASSWD: ALL'),rec('CFG','alice','nas','10.0.0.74','22','admin','~/.ssh/id_ed25519|','','yes'),
  rec('KEY','/Users/alice/.ssh/id_ed25519','600','alice',String(Math.floor((NOW-20*86400e3)/1000)),'OPENSSH','yes',`256 ${KEY_A} laptop (ED25519)`),
  rec('KEY','/Users/alice/.ssh/id_rsa','644','alice','1262304000','OPENSSH','no',`1024 ${KEY_R} ancient (RSA)`),
  rec('KEY','/Users/alice/certs/privkey.pem','600','alice','1793480361','','no','256 SHA256:dddd no comment (ECDSA)'),rec('END','ok')].join('\n')},
 nas:{error:'Permission denied (publickey).'}},
 extraMachines:[{id:'router',sshOpen:false,note:'SSH je na routeru vypnuté (port 22 zavřený).'}]});

let routes={};
globalThis.fetch=async url=>{const hit=routes[String(url)];if(!hit)return {ok:false,status:500,json:async()=>({})};return {ok:hit.status===200,status:hit.status,json:async()=>structuredClone(hit.body)};};
const admin={authKind:'session',role:'admin',username:'admin'};
const tick=()=>new Promise(r=>setImmediate(r));
async function mount(make,answers){routes=answers;setPrincipal(null);setPrincipal(admin);document.body.replaceChildren(make());for(let i=0;i<8;i++)await tick();return document.body.textContent;}
const all=sel=>document.body.querySelectorAll(sel);
// English must be complete: no Czech letter and no leaked placeholder or broken value anywhere on the page.
const clean=text=>{assert.doesNotMatch(text,/[ěščřžýáíůúťďňĚŠČŘŽÝÁÍŮÚŤĎŇ]/,'a Czech string without English');assert.doesNotMatch(text,/undefined|NaN|\[object|\{\w+\}/);return text;};
const missing=collector=>({status:404,body:{error:{code:'SYSTEMS_MISSING',message:'No machine snapshot yet. Run node scripts/collect-systems.mjs.'},collector}});

test('versions: not configured, configured without a snapshot, and an error each get their own screen',async()=>{
 let text=clean(await mount(()=>systemsView('versions'),{'/api/systems':missing(systemsSetup(validateSite({})))}));
 assert.match(text,/Versions and updates/);assert.match(text,/Version and host-protection collection is not configured/);
 for(const step of [/local\/site\.json/,/ssh <alias> true/,/node scripts\/collect-systems\.mjs/,/node scripts\/check-upstream\.mjs/,/sh scripts\/systems\/install-launchd\.sh/,/examples\/systemd\//])assert.match(text,step);
 assert.equal(all('.ui-missing').length,1);assert.doesNotMatch(text,/Mac Studio/,'no old instruction that names one household\'s machine');
 text=clean(await mount(()=>systemsView('hardening'),{'/api/systems':missing(systemsSetup(SITE))}));
 assert.match(text,/Host protection/);assert.match(text,/Collection is configured but has not run yet/);assert.match(text,/The configuration has 4 machines with a probe\./);assert.equal(all('.ui-missing').length,0);
 text=clean(await mount(()=>systemsView('versions'),{'/api/systems':{status:403,body:{error:{code:'ADMIN_REQUIRED',message:'x'}}}}));assert.match(text,/Administrators only/);
 text=clean(await mount(()=>systemsView('versions'),{}));assert.match(text,/Machine status could not be loaded/);assert.match(text,/Try again/);
});

test('versions: grouped by machine, update badges that link to the release notes, an outdated-only filter, last-checked times',async()=>{
 const text=clean(await mount(()=>systemsView('versions'),{'/api/systems':{status:200,body:systemsDoc()}}));
 assert.equal(all('.col-card').length,3,'one card per machine');
 for(const s of [/Mac mini/,/NAS/,/Mac Studio/,/macOS 26\.7\.1/,/TrueNAS 25\.10\.7/,/Node\.js/,/Servers and infrastructure/,/Toolchain/,/NAS apps/,/Containers \(Docker\)/,/Machines:/,/Latest versions:/,/every 6 h/,/every 12 h/,/fresh/,/Checked/])assert.match(text,s);
 const updates=all('.col-badge').filter(b=>b.tagName==='a');
 assert.deepEqual(updates.map(a=>[a.textContent,a.getAttribute('href'),a.getAttribute('title')]),[
  ['update to 24.22.2 ↗','https://nodejs.org/en/about/previous-releases','Release notes'],['update to 0.9.4 ↗','https://github.com/astral-sh/uv/releases/tag/0.9.4','Release notes']]);
 assert.ok(updates.every(a=>a.getAttribute('rel')==='noopener noreferrer'&&a.getAttribute('target')==='_blank'));
 assert.match(text,/update to v1\.1/,'a NAS app update has no release page: a badge without a link');
 assert.match(text,/1 source unverified/);assert.match(text,/unverified/);assert.match(text,/The check for the newest version failed \(HTTP 403 api\.github\.com\)\./);
 assert.match(text,/LTS line 24; the newest LTS is 26\.13\.0\./);assert.match(text,/Floating tag :latest, image from 2026-05-08/);assert.match(text,/Docker image searxng\/searxng/);
 assert.match(text,/Other Homebrew: 1 outdated package/);assert.match(text,/not found/);assert.match(text,/Not probed yet\.|not probed yet/);
 const rowsBefore=all('.attn').length,cardsBefore=all('.col-card').length;
 const box=all('.col-switch')[0].children[0];box.checked=true;fire(box,'change');
 const filtered=clean(document.body.textContent);
 assert.equal(all('.col-card').length,2,'a machine with nothing to update drops out');assert.ok(cardsBefore>2&&rowsBefore>0);
 assert.doesNotMatch(filtered,/Ghost/);assert.match(filtered,/Node\.js/);assert.doesNotMatch(filtered,/Other Homebrew/);
 box.checked=false;fire(box,'change');assert.equal(all('.col-card').length,3);
 // One machine only (#versions/nas).
 const one=clean(await mount(()=>systemsView('versions','nas'),{'/api/systems':{status:200,body:systemsDoc()}}));
 assert.equal(all('.col-card').length,1);assert.match(one,/immich/);assert.doesNotMatch(one,/Node\.js/);
});

test('a stale snapshot is labelled as stale, with what to do',async()=>{
 const doc=systemsDoc(9*HOUR);assert.equal(doc.collector.state,'stale');
 const text=clean(await mount(()=>systemsView('versions'),{'/api/systems':{status:200,body:doc}}));
 assert.match(text,/stale snapshot/);assert.match(text,/9 h ago/);assert.match(text,/Check the scheduled job, or run the collector by hand\./);
 assert.equal(all('.col-banner').filter(b=>b.classList.contains('warn')).length>=1,true);
});

test('host protection: a pass / warning / fail checklist per machine, each check with its reason; issues first, ports in their own block',async()=>{
 const text=clean(await mount(()=>systemsView('hardening'),{'/api/systems':{status:200,body:systemsDoc()}}));
 for(const s of [/Host protection/,/Failed/,/Warnings/,/Passed/,/failed: 1/,/warnings: \d/,/passed: \d/,/FileVault \(disk encryption\)/,/Disk encryption protects the data when the machine is lost or carried away\./,
  /on · 12 rules/,/Only from the addresses in AllowUsers: 10\.0\.0\.151\./,/Screen sharing/,/Ports: 1/,/No chain on the input hook \(tables ip nat\)/,/Port 21 on all interfaces, local accounts only\./,/Security release: Fixes CVE-1\./,/Ports open to the network: 1/,/SSH keys/])assert.match(text,s);
 const mini=all('.col-card')[0],marks=mini.querySelectorAll('.col-check').map(c=>c.getAttribute('class').replace('col-check ',''));
 assert.equal(marks[0],'bad','what failed comes first');assert.deepEqual([...new Set(marks)],['bad','warn','unknown','info','good'].filter(m=>marks.includes(m)),'then warnings, unverified, info, passed');
 const total=all('.col-check').length,issues=all('.col-switch')[0].children[0];issues.checked=true;fire(issues,'change');
 assert.ok(all('.col-check').length<total);assert.ok(all('.col-check').every(c=>!c.classList.contains('good')&&!c.classList.contains('info')));
 issues.checked=false;fire(issues,'change');assert.equal(all('.col-check').length,total);
 assert.doesNotMatch(document.body.textContent,/8000/);
 const loopback=all('.col-switch')[1].children[0];loopback.checked=true;fire(loopback,'change');assert.match(document.body.textContent,/8000/);loopback.checked=false;fire(loopback,'change');
});

test('software watch: an empty list explains itself with a copyable agent prompt; a filled one lists items and rules',async()=>{
 const machines=[{id:'mini',name:'Mac mini'}],base={file:'local/software-watch.json',example:'config/software-watch.json'};
 let text=clean(await mount(()=>systemsView('versions','~watch'),{'/api/systems':{status:200,body:systemsDoc()},'/api/software-watch':{status:200,body:{...describeWatch({source:'none',registry:emptyWatch()},{machines}),...base}}}));
 for(const s of [/No software is watched yet/,/software:write/,/software_watch_list/,/software_watch_put/,/on the machines mini/,/config\/software-watch\.json/,/local\/software-watch\.json/,/claude mcp add --transport http home-hub/,/Users and API/])assert.match(text,s);
 assert.equal(all('.ui-copy').length,2,'the agent prompt and the MCP connection, each with a Copy button');
 text=clean(await mount(()=>systemsView('versions','~watch'),{'/api/systems':{status:200,body:systemsDoc()},'/api/software-watch':{status:200,body:{...describeWatch({source:'none',registry:emptyWatch()},{machines:[]}),...base}}}));
 assert.match(text,/First give your machines an ssh entry with the "mac" probe/);assert.match(text,/from local\/site\.json/);
 text=clean(await mount(()=>systemsView('versions','~watch'),{'/api/systems':{status:200,body:systemsDoc()},'/api/software-watch':{status:200,body:{...describeWatch({source:'local',registry},{machines}),...base}}}));
 for(const s of [/Node\.js/,/github · astral-sh\/uv/,/brew · node/,/not checked/,/Latest version from/,/Machines and rules/,/never a command/])assert.match(text,s);
 assert.equal(all('.ui-copy').length,1);
 text=clean(await mount(()=>systemsView('versions','~watch'),{'/api/systems':{status:200,body:systemsDoc()}}));assert.match(text,/The software watch list could not be loaded/);
 // No snapshot yet: the address still shows the list, under what to set up first.
 text=clean(await mount(()=>systemsView('versions','~watch'),{'/api/systems':missing(systemsSetup(validateSite({}))),'/api/software-watch':{status:200,body:{...describeWatch({source:'none',registry:emptyWatch()},{machines:[]}),...base}}}));
 assert.match(text,/collection is not configured/);assert.match(text,/No software is watched yet/);assert.match(text,/software_watch_put/);
 // A snapshot without a watch list: the machines page says so and links to the list.
 const bare=buildSystems({snapshot:{collectedAt:iso(HOUR),machines:{nas:parseSystemsProbe(nasProbe(iso(HOUR)))}},upstream:null,registry:emptyWatch(),machines:[{id:'nas',name:'NAS',kind:'nas'}],now:NOW,watchSource:'none'});
 text=clean(await mount(()=>systemsView('versions'),{'/api/systems':{status:200,body:bare}}));
 assert.match(text,/No software is watched yet: you see only operating systems, NAS apps and containers\./);assert.match(text,/Set up the software watch list/);assert.match(text,/immich/);
});

test('SSH keys: states, the key matrix with type, age and where each key is authorized, weak and old keys highlighted, every tab',async()=>{
 const none={error:{code:'SECURITY_MISSING',message:'No SSH key inventory yet. Run node scripts/collect-security.mjs.'}};
 let text=clean(await mount(()=>securityView(),{'/api/security':{status:404,body:{...none,collector:securitySetup(validateSite({}))}}}));
 assert.match(text,/The SSH key inventory is not configured/);assert.match(text,/node scripts\/collect-security\.mjs/);assert.match(text,/install-launchd\.sh --with-security/);
 text=clean(await mount(()=>securityView(),{'/api/security':{status:404,body:{...none,collector:securitySetup(SITE)}}}));
 assert.match(text,/Key collection is configured but has not run yet/);assert.match(text,/The configuration has 4 machines with an ssh alias\./);
 const doc=securityDoc();
 text=clean(await mount(()=>securityView(),{'/api/security':{status:200,body:{...doc,collector:securitySetup(SITE,{collectedAt:doc.collectedAt,now:NOW})}}}));
 for(const s of [/SSH keys/,/Snapshot from studio:/,/fresh/,/Key matrix/,/id_ed25519/,/id_rsa/,/ED25519 256/,/RSA 1024/,/weak type/,/old/,/20 d/,/16\.\d y/,/passphrase-protected/,/no passphrase/,/Weak and old keys/,/1 weak type · 0 to replace/,
  /id_rsa \(ancient\): weak key type \(RSA 1024\)/,/the file is readable by others \(644\)/,/Mac Studio: SSH accepts passwords too/,/Router: SSH is off on the router \(port 22 closed\)\./])assert.match(text,s);
 const rows=all('.col-matrix')[0].children[1].children,weak=rows.find(r=>/id_rsa/.test(r.textContent)),fine=rows.find(r=>/id_ed25519/.test(r.textContent));
 assert.equal(weak.getAttribute('class'),'bad');assert.equal(fine.getAttribute('class'),'');
 const tabs=all('.col-chip');assert.deepEqual(tabs.map(b=>b.textContent),['Key matrix','Key inventory','Accounts on machines','Other keys']);
 assert.equal(tabs[0].getAttribute('aria-selected'),'true');
 fire(tabs[1],'click');text=clean(document.body.textContent);assert.match(text,/Location/);assert.match(text,/~\/\.ssh\/id_rsa/);assert.match(text,/ssh nas/);assert.equal(tabs[1].getAttribute('aria-selected'),'true');
 fire(tabs[2],'click');text=clean(document.body.textContent);assert.match(text,/password login allowed/);assert.match(text,/Permission denied \(publickey\)\./);assert.match(text,/password-less sudo/);
 fire(tabs[3],'click');text=clean(document.body.textContent);assert.match(text,/TLS certificate/);
 fire(tabs[0],'click');
 // A stale snapshot, and one written before findings carried their parts: the stored text is shown as it is.
 const old={...doc,collectedAt:iso(50*HOUR),findings:[{level:'warn',title:'Starý nález',detail:'uložený text'}]};
 text=await mount(()=>securityView(),{'/api/security':{status:200,body:{...old,collector:securitySetup(SITE,{collectedAt:old.collectedAt,now:NOW})}}});
 assert.match(text,/stale snapshot/);assert.match(text,/Starý nález/);assert.match(text,/uložený text/);
 text=clean(await mount(()=>securityView(),{}));assert.match(text,/The inventory could not be loaded|Home Hub is not responding/);
});

test('router panel: not configured, waiting, fine with census and hardware, stale, failed',async()=>{
 const lanCidrs=['10.0.0.0/24'],extra={configured:{adapter:null,host:'10.0.0.1',lanCidrs},machine:{id:'router',name:'Router',ip:'10.0.0.1'}};
 const obs=(over={})=>({status:'ok',observedAt:iso(30e3),model:'Gateway 7',firmware:'4.3.6',applicationVersion:'9.4',clientCounts:{wired:1,wireless:1,other:0},knownClients:{a:{},b:{},c:{}},
  unifiDevices:[{name:'Gateway',model:'UDR7',state:'ONLINE',firmware:'4.3.6',ip:'10.0.0.1'},{name:'Switch',model:'USW',state:'OFFLINE',firmware:'7.1',ip:'10.0.0.2'}],
  devices:[{mac:'aa:bb:cc:dd:ee:01',ip:'10.0.0.151',name:'Desktop',connection:'Ethernet',presence:'reachable'},{mac:'aa:bb:cc:dd:ee:02',ip:'10.0.0.77',name:'',connection:'Wi-Fi · 5 GHz',presence:'associated'}],...over});
 const page=raw=>({'/api/router':{status:200,body:{...normalizeRouter(raw,{lanCidrs,adapter:raw===null?null:ROUTER_ADAPTERS.unifi,now:NOW}),...extra}}});
 let text=clean(await mount(()=>routerPanel(),page(null)));
 assert.match(text,/The router is not configured/);for(const s of [/adapter "unifi"/,/router-private\/unifi-api-key/,/collect-router-unifi\.py --pin/,/collect-router-unifi\.py --check/,/GET requests only/])assert.match(text,s);
 text=clean(await mount(()=>routerPanel(),{'/api/router':{status:200,body:{...normalizeRouter(null,{lanCidrs,adapter:ROUTER_ADAPTERS.unifi,now:NOW}),...extra}}}));
 assert.match(text,/A router adapter is configured but has not reported yet/);assert.match(text,/The adapter UniFi Network has not written an observation yet\./);
 text=clean(await mount(()=>routerPanel(),{'/api/router':{status:200,body:{...normalizeRouter(null,{lanCidrs,adapter:{id:'mikrotik',title:'mikrotik'},now:NOW}),error:'unknown-adapter',...extra}}}));
 assert.match(text,/does not know the adapter "mikrotik"/);
 text=clean(await mount(()=>routerPanel(),page(obs())));
 for(const s of [/Clients and router health/,/fresh/,/UniFi Network/,/Clients on the network/,/Desktop/,/unnamed/,/10\.0\.0\.151/,/aa:bb:cc:dd:ee:02/,/Wired/,/Wi-Fi · 5 GHz/,/reachable/,/on Wi-Fi/,/Network hardware/,/1 down/,/offline/,/3 known in 90 days/,/firmware 4\.3\.6/,/10\.0\.0\.0\/24/])assert.match(text,s);
 text=clean(await mount(()=>routerPanel(),page(obs({observedAt:iso(20*60e3)}))));assert.match(text,/stale snapshot/);assert.match(text,/should report at least every 3 min/);
 text=clean(await mount(()=>routerPanel(),page(obs({status:'unavailable',error:'certificate-changed'}))));
 assert.match(text,/read failed/);assert.match(text,/failed \(certificate-changed\)/);assert.match(text,/Desktop/,'the last census stays visible');
 text=clean(await mount(()=>routerPanel(),page(obs({devices:[]}))));assert.match(text,/reports no client in the configured networks/);
 text=clean(await mount(()=>routerPanel(),{}));assert.match(text,/The router state could not be loaded/);
});

test('Czech stays the source language: the same pages in Czech; shared helpers',async()=>{
 i18n.setLang('cs');
 try{
  let text=await mount(()=>systemsView('versions'),{'/api/systems':{status:200,body:systemsDoc()}});
  for(const s of [/Verze a aktualizace/,/aktualizace na 24\.22\.2/,/Jen zastaralé/,/Sledovaný software/,/každých 6 h/,/Zkontrolováno/])assert.match(text,s);
  text=await mount(()=>systemsView('hardening'),{'/api/systems':{status:200,body:systemsDoc()}});
  for(const s of [/Ochrana strojů/,/nesplněno: 1/,/zapnutý · 12 pravidel/,/Šifrování disku chrání data/,/Portů: 1/])assert.match(text,s);
  text=await mount(()=>systemsView('versions'),{'/api/systems':missing(systemsSetup(validateSite({})))});assert.match(text,/Sběr verzí a ochrany strojů není nastavený/);
  text=await mount(()=>routerPanel(),{'/api/router':{status:200,body:{...normalizeRouter(null,{}),configured:{adapter:null,host:null,lanCidrs:[]},machine:null}}});assert.match(text,/Router není nastavený/);
  assert.equal(say('zapnutý · 3 pravidel',[{key:'zapnutý · {rules} pravidel',params:{rules:3}}]),'zapnutý · 3 pravidel');
 }finally{i18n.setLang('en');}
 assert.equal(say('zapnutý · 3 pravidel',[{key:'zapnutý · {rules} pravidel',params:{rules:3}}]),'on · 3 rules');
 assert.equal(say('',[{key:'{items}',params:{items:['Sdílení obrazovky','Sdílení souborů (SMB)']}}]),'Screen sharing, File sharing (SMB)','list parameters are translated one by one');
 assert.equal(say('vypnutý',undefined),'off','no parts: the stored text through the dictionary');assert.equal(say('',null),'');assert.equal(say('free text from a probe'),'free text from a probe');
 assert.deepEqual([ago(60),ago(5399),ago(7200),ago(3*86400),ago(NaN)],['1 min ago','90 min ago','2 h ago','3 d ago','—']);assert.deepEqual([every(21600),every(60)],['6 h','1 min']);
});
