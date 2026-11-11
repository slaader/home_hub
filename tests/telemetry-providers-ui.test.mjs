// Browser side of WinRM, Node Exporter, Prometheus and Linux SSH, without a browser: the form's rules match the
// server's, the copyable guides change only what they say (no automatic remote configuration, no curl | sh, no
// AllowUnencrypted, no UAC change, credentials never over plain HTTP), every provider is named by its own name in
// notices, and the Linux panel says GPU and power are not measured instead of showing 0.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {installDom,Element} from './fixtures/mini-dom.mjs';

const bus=new EventTarget();
globalThis.addEventListener??=bus.addEventListener.bind(bus);
globalThis.dispatchEvent??=bus.dispatchEvent.bind(bus);
installDom();
if(!('style' in Element.prototype))Object.defineProperty(Element.prototype,'style',{get(){return this._style??={};}});
const {statusOf,tileNotice,telemetryNotice,nativePanel,installSteps,FEED_NAMES}=await import('../public/home-telemetry.js');
const {endpointErrors,endpointSignature,endpointScheme,windowsErrors,FEED_PLATFORM}=await import('../public/home-add-device.js');
const setup=await import('../public/telemetry-setup.js');
const {validUnixUser}=await import('../server/linux-telemetry.mjs');
const {PROVIDER_PLATFORM}=await import('../server/home-devices.mjs');
const {FEEDS}=await import('../server/telemetry-providers.mjs');
const {dictionary,setLang}=await import('../public/i18n.js');
setLang('cs');// the source strings, as written
const text=n=>{if(n==null)return '';let s=typeof n.textContent==='string'?n.textContent:'';return s;};

test('the form\'s rules are the server\'s: users, credentials only over HTTPS, a test of exactly what the form shows',()=>{
 assert.deepEqual(FEED_PLATFORM,{...PROVIDER_PLATFORM});
 for(const p of Object.keys(FEED_PLATFORM))assert.equal(FEED_NAMES[p],FEEDS[p].name,'one name per provider on both sides');
 for(const u of ['alice','_x','a.b-c','-x','a b','$(id)','a'.repeat(33),"o'neil"])assert.equal(setup.validUnixUser(u),validUnixUser(u),u);
 assert.ok(windowsErrors({whost:'h.example.lan',wport:'22',wuser:'DOMAIN\\x'},{os:'linux'}).wuser);assert.deepEqual(windowsErrors({whost:'h.example.lan',wport:'22',wuser:'homehub'},{os:'linux'}),{});
 const base={ehost:'10.0.0.21',eport:'9100',escheme:'http',eauth:'none',euser:'',epassword:''};
 assert.deepEqual(endpointErrors(base,{provider:'node-exporter'}),{});
 assert.ok(endpointErrors({...base,eauth:'basic',euser:'u',epassword:'secret-pass'},{provider:'node-exporter'}).eauth,'no credentials over HTTP');
 assert.ok(endpointErrors({...base,escheme:'https'},{provider:'winrm'}).euser,'WinRM needs a local account');
 assert.ok(endpointErrors({...base,escheme:'https',euser:'DOMAIN\\x'},{provider:'winrm'}).euser,'Basic takes local accounts only');
 assert.ok(endpointErrors({...base,ehost:'-oX'},{provider:'prometheus'}).ehost);assert.ok(endpointErrors({...base,eport:'0'},{provider:'prometheus'}).eport);
 const a=endpointSignature({...base,ejob:'node',einstance:'a'}),b=endpointSignature({...base,ejob:'node',einstance:'b'});assert.notEqual(a,b,'another target needs a new test');
 assert.equal(endpointSignature({...base,ehost:' 10.0.0.21 '}),endpointSignature(base));
});

test('guides: explicit, minimal, nothing automatic; Basic only for the WinRM service over HTTPS, existing listeners kept',async()=>{
 const winrm=setup.winrmListenerScript({host:'pc.example.lan',port:5986});
 assert.match(winrm,/Service\\Auth\\Basic -Value \$true/);assert.match(winrm,/Transport=HTTPS/);assert.match(winrm,/if \(\$https\.Count -eq 0\)/,'an HTTPS listener only when there is none');
 assert.match(winrm,/-RemoteAddress \$HubAddress/,'the firewall rule is for the hub only');
 assert.doesNotMatch(winrm,/AllowUnencrypted\s+-Value|AllowUnencrypted \$true|quickconfig|Enable-PSRemoting|TrustedHosts|LocalAccountTokenFilterPolicy|EnableLUA|Client\\Auth|Remove-Item/i);
 assert.match(setup.winrmAccountScript('homehub'),/S-1-5-32-580/);assert.match(setup.winrmAccountScript('homehub'),/S-1-5-32-558/);assert.throws(()=>setup.winrmAccountScript("a'b"),/invalid/);
 assert.match(winrm,/\$HubAddress = '<10\.0\.0\.x>'/,'no hub address: the placeholder');assert.match(winrm,/^& \{$/m,'one block, so a refused address stops it all');
 assert.ok(winrm.indexOf("throw 'Set $HubAddress")<winrm.indexOf('Set-Service'),'the address is checked before any change');
 assert.match(setup.winrmListenerScript({hub:'10.0.0.25'}),/\$HubAddress = '10\.0\.0\.25'/,'the hub address is filled in');
 assert.match(setup.winrmListenerScript({hub:"10.0.0.1'; evil"}),/\$HubAddress = '<10\.0\.0\.x>'/,'an unusable address becomes the placeholder');
 assert.match(setup.nodeExporterFirewall({hub:'10.0.0.25'}),/ufw allow from 10\.0\.0\.25 /);assert.match(setup.nodeExporterFirewall({hub:'x;rm'}),/<HUB-IP>/);
 assert.match(setup.winrmListenerScript({host:"x'; evil"}),/\$Name = '<pc\.example\.lan>'/,'an unusable host becomes the placeholder, never code');
 const linux=[setup.NODE_EXPORTER_PACKAGES,setup.nodeExporterManual(),setup.NODE_EXPORTER_FIREWALL,setup.nodeExporterTls({host:'box.example.lan'}),setup.prometheusScrape({host:'box.example.lan'}),setup.PROMETHEUS_DOCKER].join('\n');
 assert.doesNotMatch(linux,/curl[^\n]*\|\s*(sudo\s+)?(ba)?sh|wget[^\n]*\|\s*sh/,'never curl | sh');
 assert.match(linux,/sha256sum --ignore-missing -c sha256sums\.txt/,'a downloaded release is checked');assert.match(linux,/--web\.listen-address=<LAN-IP>:9100/);
 assert.doesNotMatch(linux,/0\.0\.0\.0|--web\.listen-address=:9100/,'not every interface by default');
 assert.match(setup.prometheusScrape({host:'box.example.lan'}),/targets: \['box\.example\.lan:9100'\]/);
 const key='ssh-ed25519 '+'A'.repeat(68)+' home-hub';const auth=setup.linuxAuthorizeScript(key);
 assert.match(auth,/^umask 077/m);assert.match(auth,/grep -qxF 'restrict ssh-ed25519 A+ home-hub'/);assert.match(auth,/chmod 600 ~\/\.ssh\/authorized_keys/);assert.doesNotMatch(auth,/\bsudo [a-z]|\/root|Users\//);
 assert.throws(()=>setup.linuxAuthorizeScript("ssh-ed25519 AAAA'; rm -rf ~"),/invalid/);assert.throws(()=>setup.shLiteral("a'b"),/invalid/);
 const src=await readFile(new URL('../public/home-add-device.js',import.meta.url),'utf8');
 for(const must of ['/api/home/devices/endpoint/draft','/draft/probe','/draft/trust','/draft/discover','/draft/test','/api/home/devices/telemetry','/api/home/devices/ssh','/api/home/devices/hub-address','keepalive:true',"type:'password'","autocomplete:'new-password'"])assert.ok(src.includes(must),must);
 assert.doesNotMatch(src,/value:mine\?\.password|password:draft\.password|\.password\.value\s*=\s*draft/,'a stored password is never put back into the form');
});

const linuxM=(provider,telemetry={},native=null)=>({id:'box',kind:'thermo',online:'offline',platform:'linux',added:true,source:'ui',native,telemetry:{provider,hostId:'box',thermoId:null,state:'unreachable',reason:'down',...telemetry}});
test('a Linux or WinRM machine: notices name its provider and the server\'s hint; the panel never shows GPU or power as 0',()=>{
 for(const p of ['node-exporter','prometheus','linux-ssh','winrm']){
  const m=linuxM(p,{detail:'timeout',hint:'Prometheus neodpověděl včas. Stroj může spát nebo být mimo síť, nebo port blokuje firewall.',connection:{mode:p,host:'10.0.0.40',port:9090,job:'node',instance:'a'}});
  const s=statusOf(m);assert.equal(s.text,'telemetrie neodpovídá');
  const page=text(telemetryNotice(m,{agent:'Thermo'}));assert.match(page,new RegExp(FEED_NAMES[p].replace(/[()]/g,'\\$&')));assert.doesNotMatch(page,/Thermo|49286|OpenSSH Server/,p);
  assert.doesNotMatch(text(tileNotice(m,{agent:'Thermo'})),/Thermo/,p);
 }
 assert.equal(statusOf(linuxM('prometheus',{detail:'tls-pin',hint:'x'})).text,'certifikát neověřen');
 assert.match(text(telemetryNotice(linuxM('prometheus',{connection:{mode:'prometheus',host:'10.0.0.40',port:9090,job:'nas-node',instance:'nas'}}),{})),/nas-node/);
 const none={...linuxM(null),telemetry:{state:'not-installed'}};assert.match(installSteps(none,{}).join(' '),/Node Exporter/);assert.match(text(tileNotice(none,{agent:'Thermo'})),/Node Exporter/);
 const panel=nativePanel(linuxM('node-exporter',{state:'ok'},{provider:'node-exporter',os:{caption:'Debian',version:'6.1',arch:'x86_64',uptimeSeconds:90000},cpu:{name:'CPU',logical:2,cores:[10,null]},load:[0.5,0.25,0.1],
  disk:{readBps:1000,writeBps:null},net:{rxBps:5e6,txBps:0},temps:[{chip:'coretemp',label:'Package id 0',c:47}],gpus:[],span:30}));
 const p=text(panel);assert.match(p,/Linux \(Node Exporter\)/);assert.match(p,/47 °C/);assert.match(p,/0\.5 \/ 0\.25 \/ 0\.1/);assert.match(p,/tenhle zdroj je neměří/);assert.doesNotMatch(p,/GPU 1|0 W/);
 assert.equal(nativePanel({...linuxM(null),native:{provider:'x'}}),null);
 for(const s of [...Object.values(FEEDS).flatMap(f=>Object.values(f.errors))])assert.ok(dictionary[s],`English for "${s}"`);
});


test('editing keeps the endpoint scheme that was saved; only a new WinRM connection defaults to HTTPS',()=>{
 for(const provider of ['winrm','node-exporter','prometheus'])for(const scheme of ['http','https'])assert.equal(endpointScheme(provider,{scheme}),scheme);
 assert.equal(endpointScheme('winrm',null),'https');assert.equal(endpointScheme('prometheus',null),'http');assert.equal(endpointScheme('node-exporter',null),'http');
});
