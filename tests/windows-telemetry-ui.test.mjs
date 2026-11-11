// Browser side of Windows telemetry, without a browser: the form refuses what the server refuses and saves only
// a tested connection, the device dialog offers Windows with an app-managed key (no hub-side terminal steps, no
// assumption about the hub's system), a Windows machine's notices name SSH (with the server's hint) instead of
// Thermo, and its page panel says what Windows does not report instead of showing a zero.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {installDom,Element} from './fixtures/mini-dom.mjs';

const bus=new EventTarget();
globalThis.addEventListener??=bus.addEventListener.bind(bus);
globalThis.dispatchEvent??=bus.dispatchEvent.bind(bus);
installDom();
// The small DOM has no style object; the panel sets bar heights on it, as the volumes do.
if(!('style' in Element.prototype))Object.defineProperty(Element.prototype,'style',{get(){return this._style??={};}});
const {statusOf,hasReadings,installSteps,tileNotice,telemetryNotice,nativePanel}=await import('../public/home-telemetry.js');
const {validateDevice,validTarget,telemetryChoices,windowsErrors,windowsSignature}=await import('../public/home-add-device.js');
const {validSshTarget,validWindowsUser,WINDOWS_ERRORS}=await import('../server/windows-telemetry.mjs');
const {WINDOWS_SETUP_ERRORS}=await import('../server/windows-ssh.mjs');
const {validWindowsUser:uiUser}=await import('../public/windows-setup.js');
const {TELEMETRY_ADAPTERS}=await import('../server/home-data.mjs');
const {dictionary}=await import('../public/i18n.js');
const text=n=>n==null?'':typeof n.textContent==='string'?n.textContent:'';

test('the form\'s rules are the server\'s; only a connection tested with exactly what the form shows is saved',()=>{
 const samples=['win','pc.example.lan','alice@pc.example.lan','alice_1@10.0.0.30','-oProxyCommand=id','a b','a;b','$(id)','`id`','%h','host:22','@host','user@','user@-host','.host','host.','a..b','a/b','x'.repeat(321),''];
 for(const s of samples)assert.equal(validTarget(s),validSshTarget(s),s);
 for(const s of ['alice','Alice Smith','ADMIN-PC\\alice','alice@corp.example.lan',"al'ice",'a$b','%u','-x',' a','a ','a  b','Slávek'])assert.equal(uiUser(s),validWindowsUser(s),s);
 const base={name:'PC',hostname:'pc.example.lan',ip:'',cpu:'',gpu:'',ramGb:'',diskGb:''};
 const conn={whost:'pc.example.lan',wport:'22',wuser:'alice'},done={...conn,windowsKey:true,windowsTrusted:true,windowsTested:windowsSignature(conn)};
 assert.deepEqual(validateDevice({...base,...done},{windows:true}),{});
 assert.ok(validateDevice({...base,...done,windowsKey:false},{windows:true}).windowsTest,'no key, no save');
 assert.ok(validateDevice({...base,...done,windowsTrusted:false},{windows:true}).windowsTest,'no confirmed host key, no save');
 assert.ok(validateDevice({...base,...done,windowsTested:null},{windows:true}).windowsTest,'no test, no save');
 for(const change of [{wuser:'bob'},{wport:'2222'},{whost:'pc2.example.lan'}])assert.ok(validateDevice({...base,...done,...change},{windows:true}).windowsTest,`an edited ${Object.keys(change)[0]} needs a new test`);
 assert.deepEqual(validateDevice({...base,...done,whost:' PC.example.lan '},{windows:true}),{},'case and blanks do not count as a change');
 for(const [k,v] of [['whost','-oProxyCommand=id'],['whost','a b'],['whost',''],['wport','0'],['wport','65536'],['wport','22 -oX'],['wport','2.5'],['wuser',"al'ice"],['wuser','$(id)'],['wuser','']])
  assert.ok(windowsErrors({...conn,[k]:v})[k],`${k}=${v}`);
 assert.deepEqual(windowsErrors(conn),{});
 assert.deepEqual(validateDevice({...base,whost:'-oX'}),{},'without Windows chosen the fields are ignored');
});

test('the dialog offers Windows with a key the hub manages: the only set-up outside the app is on Windows',async()=>{
 assert.deepEqual(telemetryChoices({adapters:TELEMETRY_ADAPTERS}).map(a=>a.id),['thermo','windows','winrm','node-exporter','prometheus','linux-ssh']);
 const src=await readFile(new URL('../public/home-add-device.js',import.meta.url),'utf8'),setup=await readFile(new URL('../public/windows-setup.js',import.meta.url),'utf8');
 for(const must of ['/api/home/devices/windows','/api/home/devices/ssh','/api/home/devices/endpoint/draft','/draft/discover','/api/home/devices/telemetry','/draft/key','/draft/scan','/draft/trust','/draft/test','/draft/discard','/api/home/devices/windows/tools','keepalive:true'])assert.ok(src.includes(must),must);
 for(const must of ['OpenSSH.Server~~~~0.0.1.0','administrators_authorized_keys','S-1-5-32-544','S-1-5-18','S-1-5-32-558','ssh_host_*_key.pub'])assert.ok(setup.includes(must),must);
 // Nothing to do on the hub's own machine: no key files made in a terminal, no ~/.ssh/config, no Mac.
 assert.doesNotMatch(src+setup,/ssh-keygen -t|IdentityFile|Host \$\{|~\/\.ssh\/config|Terminál|na Macu|on the Mac/,'no hub-side terminal steps');
 assert.doesNotMatch(src+setup,/StrictHostKeyChecking|UserKnownHostsFile|accept-new/,'the guide never touches host-key checking');
 assert.doesNotMatch(src,/privateKey\s*:\s*draft|\.pem\b/,'the dialog never holds a stored private key');
 for(const a of TELEMETRY_ADAPTERS)assert.ok(dictionary[a.summary],`English for "${a.summary}"`);
 for(const sentence of Object.values(WINDOWS_ERRORS))assert.ok(dictionary[sentence],`English for "${sentence}"`);
 for(const [,sentence] of Object.values(WINDOWS_SETUP_ERRORS))assert.ok(dictionary[sentence],`English for "${sentence}"`);
 for(const sentence of [...Object.values(WINDOWS_ERRORS),...Object.values(WINDOWS_SETUP_ERRORS).map(x=>x[1])])assert.doesNotMatch(dictionary[sentence],/\bMac\b|Terminal/,'no message assumes the hub runs on a Mac');
});

const win=telemetry=>({id:'pc',kind:'thermo',online:'offline',platform:'windows',added:true,source:'ui',telemetry:{provider:'windows',hostId:'pc',thermoId:null,target:'pc-windows',...telemetry}});
const managedWin=telemetry=>win({target:'alice@pc.example.lan:2222',connection:{mode:'managed',host:'pc.example.lan',port:2222,user:'alice',keyFingerprint:'SHA256:x',hostKeyFingerprint:'SHA256:y'},...telemetry});
test('a Windows machine: its state and notices name SSH and say what to do',()=>{
 assert.equal(statusOf(win({state:'ok',lastSampleAt:new Date().toISOString()})).tone,'ok');
 assert.equal(hasReadings(win({state:'ok'})),true);
 const key=statusOf(win({state:'unreachable',reason:'down',detail:'host-key-unknown',hint:WINDOWS_ERRORS['host-key-unknown']}));
 assert.equal(key.text,'host key not verified');assert.match(key.title,/never accepts an unknown key/);
 assert.equal(statusOf(win({state:'unreachable',reason:'denied',hint:WINDOWS_ERRORS.denied})).text,'login refused');
 const down=statusOf(win({state:'unreachable',reason:'down',detail:'timeout',hint:WINDOWS_ERRORS.timeout}));assert.match(down.title,/timed out.*does not mean the machine is off/);
 const notice=text(telemetryNotice(win({state:'unreachable',reason:'down',detail:'refused',hint:WINDOWS_ERRORS.refused})));
 assert.match(notice,/Windows does not answer over SSH/);assert.match(notice,/OpenSSH Server/);assert.match(notice,/ssh pc-windows/);assert.doesNotMatch(notice,/Thermo|49286/);
 assert.match(text(telemetryNotice(win({state:'unreachable',reason:'down',detail:'host-key-changed',hint:WINDOWS_ERRORS['host-key-changed']}))),/host key is not verified.*differs from the verified one.*verify it again in Edit device/s);
 // An app-managed connection: what to check names its account and port; nothing about the hub's own terminal.
 const managed=text(telemetryNotice(managedWin({state:'unreachable',reason:'down',detail:'refused',hint:WINDOWS_ERRORS.refused})));
 assert.match(managed,/lets port 2222 through/);assert.match(managed,/for the account alice/);assert.doesNotMatch(managed,/ssh alice|Terminal|Mac\b|older alias/);
 assert.match(text(telemetryNotice(win({state:'unreachable',reason:'down',detail:'refused',hint:WINDOWS_ERRORS.refused}))),/Older alias connection.*Convert it/s,'an alias set-up is told it can be converted');
 assert.match(text(tileNotice(win({state:'unreachable',reason:'denied'}))),/did not accept Home Hub's SSH key/);
 // Not connected yet, but the machine says it runs Windows: the Windows way, not the agent.
 const plain={id:'pc',kind:'other',online:'unknown',platform:'windows',source:'ui',telemetry:{state:'not-installed'}};
 assert.match(installSteps(plain,{}).join(' '),/OpenSSH Server/);assert.match(text(tileNotice(plain,{})),/over SSH without an agent/);
 assert.match(text(telemetryNotice(plain,{})),/reports no temperatures, fans or power/);
});

test('the Windows panel: cores, rates and GPUs as measured; sensors said to be missing, never 0',()=>{
 assert.equal(nativePanel({telemetry:{provider:'thermo'},native:{}}),null);assert.equal(nativePanel(win({state:'ok'})),null);
 const m={...win({state:'ok'}),native:{provider:'windows',os:{caption:'Windows 11 Pro',version:'10.0.26200',uptimeSeconds:200000},cpu:{name:'CPU',logical:4,cores:[10,20,null,90]},
  disk:{readBps:2.5e6,writeBps:null},net:{rxBps:1500,txBps:0},gpus:[{id:'luid',name:'GPU A',util:42,engine:'3D',memUsed:2*1073741824,memTotal:16*1073741824}],gpuCounters:true,span:30,sensors:'unsupported'}};
 const out=text(nativePanel(m));
 assert.match(text(nativePanel({...m,native:{...m.native,os:{...m.native.os,uptimeSeconds:7200}}})),/2 hours/);
 assert.match(out,/Windows 11 Pro/);assert.match(out,/2 days/);assert.match(out,/2\.5 MB\/s \/ –/,'an unmeasured rate is a dash');assert.match(out,/GPU A/);assert.match(out,/42 %/);
 assert.match(out,/Windows reports no temperatures, fans or power/);assert.match(out,/average over 30 s/);
 assert.match(text(nativePanel({...m,native:{...m.native,gpus:[],gpuCounters:false}})),/no GPU counters/);
});
