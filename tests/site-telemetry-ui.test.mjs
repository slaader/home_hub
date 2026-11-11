// The browser side of a site machine's telemetry, without a browser: its page offers "Telemetry settings" (never
// Edit or Remove), the dialog shows the identity read-only and offers only agent-less providers, a draft is made
// for the site machine's own id, and a machine whose system is not said is told every way there is, never that only
// the Thermo agent would do. The NAS here is the generic fixture's (id "nas", role nas, no platform).
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {installDom,Element,fire} from './fixtures/mini-dom.mjs';

const bus=new EventTarget();
globalThis.addEventListener??=bus.addEventListener.bind(bus);
globalThis.dispatchEvent??=bus.dispatchEvent.bind(bus);
const {document}=installDom();
if(!('style' in Element.prototype))Object.defineProperty(Element.prototype,'style',{get(){return this._style??={};}});
// What the dialog needs of an element beyond the mini DOM: a value, a modal, scrolling.
if(!('value' in Element.prototype))Object.defineProperty(Element.prototype,'value',{get(){return this._value??this.getAttribute('value')??'';},set(v){this._value=String(v);}});
Element.prototype.showModal??=function(){this.open=true;};
Element.prototype.scrollIntoView??=function(){};
const posts=[];
globalThis.fetch=async(url,o={})=>{posts.push({url,body:o.body?JSON.parse(o.body):null});
 const draft={id:'e'+'1'.repeat(32),provider:'prometheus',device:'nas',host:null,port:9090,scheme:'http',password:{set:false,reused:false},trust:null};
 return {ok:true,status:200,json:async()=>(/endpoint\/draft$/.test(url)?{draft}:{draft,targets:[]})};};
const {statusOf,tileNotice,telemetryNotice,installSteps}=await import('../public/home-telemetry.js');
const {openSiteTelemetry}=await import('../public/home-add-device.js');
const {setLang}=await import('../public/i18n.js');
setLang('cs');
const ADAPTERS=[{id:'thermo',name:'Thermo',platform:'macos'},{id:'windows',name:'Windows (SSH)',platform:'windows'},{id:'winrm',name:'Windows (WinRM)',platform:'windows'},
 {id:'node-exporter',name:'Linux (Node Exporter)',platform:'linux',recommended:true},{id:'prometheus',name:'Linux (Prometheus)',platform:'linux'},{id:'linux-ssh',name:'Linux (SSH)',platform:'linux'}];
const meta={agent:'Thermo',repoUrl:'https://example.lan/thermo',adapters:ADAPTERS};
const nas=(over={})=>({id:'nas',name:'NAS',hostname:'nas.example.lan',ip:'10.0.0.74',role:'nas',kind:'nas',source:'site',readOnly:true,online:'online',platform:null,
 telemetryEditable:true,telemetryBinding:null,services:[{id:'smb',name:'SMB',status:'reachable'}],props:{cpu:'Ryzen',ramGb:64},telemetry:{state:'not-installed',thermoId:null,reason:null},...over});
const text=n=>n?n.textContent:'';
const all=(n,pred,out=[])=>{for(const k of n.children){if(pred(k))out.push(k);all(k,pred,out);}return out;};

test('hints for a machine whose system is not said: every way there is, and the site tile is set up on its page',()=>{
 const m=nas();
 const steps=installSteps(m,meta).join(' ');
 assert.match(steps,/Prometheus, který už máš/);assert.match(steps,/WinRM/);assert.match(steps,/Nastavení telemetrie/);
 assert.doesNotMatch(steps,/Nainstaluj na stroj telemetrického agenta|thermo-hosts\.json|jen zařízení přidanému/,'not "install Thermo", not "only added devices"');
 const tile=text(tileNotice({...m,kind:'other'},meta));assert.doesNotMatch(tile,/Živá čísla dodá agent Thermo/);assert.match(tile,/Linux a Windows jdou číst bez agenta/);
 let clicked=0;const notice=telemetryNotice({...m,kind:'other'},meta,{onConnect:()=>clicked++});
 assert.doesNotMatch(text(notice),/Telemetrie tu není nainstalovaná|Jak nainstalovat Thermo/);assert.match(text(notice),/Telemetrie tu není připojená/);
 const button=all(notice,n=>n.tagName==='button').find(b=>text(b)==='Připojit telemetrii');assert.ok(button,'the notice offers to connect');fire(button,'click');assert.equal(clicked,1);
 assert.doesNotMatch(statusOf(m).title,/neběží telemetrický agent/,'the status does not claim an agent is missing');
 // A site machine the site reads through Thermo keeps the site-file instructions; a Linux one names its sources.
 assert.match(installSteps({...m,platform:null,telemetryEditable:false,kind:'thermo'},meta).join(' '),/thermo-hosts\.json/);
 assert.match(installSteps({...m,platform:'linux'},meta).join(' '),/Node Exporter[\s\S]*Nastavení telemetrie/);
 // An added Mac-less device without a platform: every way too, through its own edit dialog.
 assert.match(installSteps({id:'x',source:'ui',platform:null},meta).join(' '),/Upravit zařízení → Telemetrie, zvol systém a zdroj/);
 assert.match(installSteps({id:'x',source:'ui',platform:'macos'},meta).join(' '),/Nainstaluj na stroj telemetrického agenta Thermo/,'a Mac still gets Thermo');
});

test('the site machine\'s telemetry settings open its site editor at telemetry: agent-less providers only, a draft for its own id',async()=>{
 posts.length=0;let saved=0;
 const dialog=openSiteTelemetry({machine:nas(),meta,onSaved:()=>saved++});
 const body=text(dialog);
 assert.match(body,/Nastavení telemetrie/);assert.match(body,/NAS · id nas · z konfigurace webu/);
 assert.match(body,/local\/site\.json/);assert.match(body,/Z konfigurace webu/,'the site\'s own picture is a choice');
 for(const no of ['Odebrat','Připojit Thermo'])assert.ok(!body.includes(no),`no "${no}"`);
 const radios=all(dialog,n=>n.tagName==='input'&&n.getAttribute('type')==='radio'&&n.getAttribute('name')==='had-telemetry').map(n=>n.getAttribute('value'));
 assert.deepEqual(radios.sort(),['linux-ssh','node-exporter','none','prometheus','winrm','windows'].sort(),'every agent-less provider while the system is not said; no Thermo');
 const system=all(dialog,n=>n.tagName==='select').find(s=>s.children.some(o=>o.getAttribute('value')==='linux')&&!s.children.some(o=>o.getAttribute('value')==='nas'));
 assert.deepEqual(system.children.map(o=>o.getAttribute('value')),['','windows','linux'],'the system to choose, agent-less ones only');
 // Choose Prometheus and load targets: the draft is made for the site machine's id.
 const prom=all(dialog,n=>n.tagName==='input'&&n.getAttribute('value')==='prometheus')[0];fire(prom,'change');
 const load=all(dialog,n=>n.tagName==='button').find(b=>text(b)==='Načíst cíle z Promethea');assert.ok(load,'the Prometheus form is shown');
 fire(load,'click');await new Promise(r=>setTimeout(r,20));
 assert.deepEqual(posts.filter(p=>p.url!=='/api/home/devices/hub-address')[0],{url:'/api/home/devices/endpoint/draft',body:{provider:'prometheus',id:'nas'}});
 assert.ok(!posts.some(p=>p.url==='/api/home/machines'),'never the machine API');
 dialog.close?.();void saved;void document;
});

test('the page wires it: a site machine gets Edit machine and its Telemetry settings, never Remove; the dialog never uses the machine API',async()=>{
 const view=await readFile(new URL('../public/home-view.js',import.meta.url),'utf8');
 assert.match(view,/machine\.source==='site'&&machine\.telemetryEditable===true&&canEditSite\?\(\)=>openSiteTelemetry/);
 assert.match(view,/machine\.source==='site'&&canEditSite\?\(\)=>openSiteEdit/);
 assert.match(view,/const actions=machine\.added&&canEdit\?/,'Remove stays for added devices only');
 assert.match(view,/canEditSite=canEdit&&me\?\.authKind==='session'/,'site edits need a password sign-in');
 assert.match(view,/onConnect:machine\.added&&canEdit\?\(\)=>edit\('telemetry'\):siteTelemetry/);
 const dialog=await readFile(new URL('../public/home-add-device.js',import.meta.url),'utf8');
 const site=dialog.slice(dialog.indexOf('if(siteMode){\n   const body'),dialog.indexOf("say(t('Ukládám…'));\n  // Connecting"));
 assert.ok(site.length>0);assert.match(site,/\/api\/home\/devices\/site'/);assert.match(site,/\/api\/home\/devices\/telemetry/);assert.match(site,/\/api\/home\/devices\/windows/);
 assert.doesNotMatch(site,/\/api\/home\/machines/);
});
