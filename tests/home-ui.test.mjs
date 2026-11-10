// Browser side of the overview, without a browser: what a machine's state is called, which picture a tile
// tries, what the device form refuses, and that the lists the form shows match the server's.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// The globals the views touch at import time (as in tests/auth-lost.test.mjs).
const bus=new EventTarget();
globalThis.addEventListener=bus.addEventListener.bind(bus);
globalThis.dispatchEvent=bus.dispatchEvent.bind(bus);
const {statusOf,hasReadings,installSteps}=await import('../public/home-telemetry.js');
const {validateDevice,inNetworks,PICTURES}=await import('../public/home-add-device.js');
const {pictureChain,orderedMachines,moveId}=await import('../public/home-view.js');
const server=await import('../server/home-devices.mjs');
const {inCidrs}=await import('../server/site-config.mjs');
const {TELEMETRY_REPO_URL}=await import('../server/thermo-client.mjs');

test('a machine\'s state: readings decide for telemetry machines, a failed read is never "off"',()=>{
 const mac=telemetry=>({kind:'thermo',online:'offline',telemetry});
 assert.deepEqual([statusOf(mac({state:'ok',lastSampleAt:new Date().toISOString()})).tone,statusOf(mac({state:'ok'})).text],['ok','online']);
 const stale=statusOf(mac({state:'stale',lastSampleAt:'2026-11-10T10:00:00Z',reason:'down'}));assert.equal(stale.tone,'warn');assert.match(stale.text,/^stale · last data /);assert.match(stale.title,/does not mean the machine is off/);
 assert.deepEqual(['down','no-data','waiting'].map(reason=>statusOf(mac({state:'unreachable',reason})).text),Array(3).fill('telemetry not responding'));
 assert.equal(statusOf(mac({state:'unreachable',reason:'no-login'})).text,'telemetry not connected');
 assert.equal(statusOf(mac({state:'unreachable',reason:'denied'})).text,'login refused');
 for(const reason of ['down','no-login','denied'])assert.equal(statusOf(mac({state:'unreachable',reason})).tone,'warn','unreachable is a warning, not an "offline"');
 // Without the agent there is nothing to judge.
 assert.deepEqual([statusOf({kind:'other',online:'unknown',telemetry:{state:'not-installed'}}).tone,statusOf({kind:'other',online:'unknown',telemetry:{state:'not-installed'}}).text],['dim','no telemetry']);
 assert.equal(statusOf({kind:'nas',online:'unknown',telemetry:{state:'not-installed'}}).text,'no telemetry');
 // A NAS or a router is judged by its own feed; a router nobody reports on is unknown, not failing.
 assert.equal(statusOf({kind:'nas',online:'online',telemetry:{state:'not-installed'}}).tone,'ok');
 assert.deepEqual([statusOf({kind:'nas',online:'offline',telemetry:{state:'not-installed'}}).tone,statusOf({kind:'nas',online:'offline',telemetry:{}}).text],['bad','not responding']);
 assert.equal(statusOf({kind:'router',online:'offline',quad:null,lastSeen:null,telemetry:{state:'not-applicable'}}).text,'status unknown');
 assert.equal(statusOf({kind:'router',online:'stale',quad:{clients:3},lastSeen:'2026-11-07T21:05:00Z',telemetry:{state:'not-applicable'}}).tone,'warn');
 // Live numbers are drawn only when there are readings, fresh or old.
 assert.deepEqual(['ok','stale','unreachable','not-installed'].map(state=>hasReadings({kind:'thermo',telemetry:{state}})),[true,true,false,false]);
 assert.equal(hasReadings({kind:'nas',telemetry:{state:'ok'}}),false);
 // How to install: an added device is connected in its dialog, a site machine in the site's files.
 const meta={agent:'Thermo',repoUrl:TELEMETRY_REPO_URL};
 assert.match(installSteps({source:'agent'},meta)[2],/Edit device → Telemetry/);assert.match(installSteps({source:'site'},meta)[2],/local\/site\.json/);assert.match(installSteps({source:'ui'},meta)[0],/Thermo/);
});

test('a tile tries the machine\'s own picture first, then the built-in one for what it is',()=>{
 assert.deepEqual(pictureChain({id:'studio',role:'computer',kind:'thermo',image:'/images/home/studio.jpg',picture:'/images/desktop.png'}),['/images/home/studio.jpg','/images/desktop.png','/images/generic/desktop.svg']);
 assert.deepEqual(pictureChain({id:'nas',role:'nas',kind:'nas',image:null,picture:null}),['/images/generic/nas.svg'],'the server said there is no site picture: none is asked for');
 assert.deepEqual(pictureChain({id:'old',kind:'router'}),['/images/home/old.jpg','/images/generic/router.svg'],'an older server did not say: the site picture is tried');
 assert.deepEqual(pictureChain({id:'pi',added:true,role:'other',kind:'other',image:null,picture:'/images/generic/board.svg'}),['/images/generic/board.svg','/images/generic/generic.svg']);
 assert.deepEqual(pictureChain({id:'m',added:true,role:'computer',kind:'thermo',image:'/images/home/m.jpg?v=1',picture:'/images/generic/desktop.svg'}),['/images/home/m.jpg?v=1','/images/generic/desktop.svg']);
 // Order helpers used by the reorder mode.
 assert.deepEqual(orderedMachines([{id:'a'},{id:'b'},{id:'c'}],['c','a']).map(m=>m.id),['c','a','b']);
 assert.deepEqual(moveId(['a','b','c'],'c',0),['c','a','b']);assert.deepEqual(moveId(['a','b','c'],'a',9),['b','c','a']);
});

test('the device form refuses what the server would, field by field',()=>{
 const ok={name:'Mac mini',hostname:'mini.example.lan',ip:'10.0.0.30',cpu:'10c M4',gpu:'10c',ramGb:'24',diskGb:'500'};
 assert.deepEqual(validateDevice(ok,{lanCidrs:['10.0.0.0/24']}),{});
 const fields=(values,options)=>Object.keys(validateDevice({...ok,...values},options)).sort();
 assert.deepEqual(fields({name:'  '}),['name']);assert.deepEqual(fields({name:'x'.repeat(61)}),['name']);
 assert.deepEqual(fields({hostname:''}),['hostname']);assert.deepEqual(fields({hostname:''},{needHost:false}),[],'an existing machine may have no hostname');
 assert.deepEqual(fields({hostname:''},{needHost:false,thermo:true}).includes('hostname'),true,'but connecting Thermo needs one');
 assert.deepEqual(fields({hostname:'bad host'}),['hostname']);assert.deepEqual(fields({hostname:'10.0.0.30'}),[]);
 assert.deepEqual(fields({ip:'300.1.1.1'}),['ip']);assert.deepEqual(fields({ip:''}),[]);
 assert.deepEqual(fields({ip:'192.168.1.5'},{lanCidrs:['10.0.0.0/24']}),['ip']);assert.match(validateDevice({...ok,ip:'192.168.1.5'},{lanCidrs:['10.0.0.0/24']}).ip,/10\.0\.0\.0\/24/);
 assert.deepEqual(fields({ramGb:'0'}),['ramGb']);assert.deepEqual(fields({ramGb:'70000'}),['ramGb']);assert.deepEqual(fields({ramGb:''}),[]);assert.deepEqual(fields({diskGb:'-5'}),['diskGb']);
 assert.deepEqual(fields({cpu:'x'.repeat(61),gpu:'x'.repeat(41)}),['cpu','gpu']);
 // The Thermo part: port, user, password, and a fingerprint that was read and confirmed.
 const thermo={port:'49286',username:'homehub',password:'correct horse battery',fingerprint:'ab'.repeat(32),confirmed:true};
 assert.deepEqual(fields(thermo,{thermo:true}),[]);
 assert.deepEqual(fields({...thermo,port:'80',username:' ',password:'short'},{thermo:true}),['password','port','username']);
 assert.deepEqual(fields({...thermo,fingerprint:null},{thermo:true}),['probe']);assert.deepEqual(fields({...thermo,confirmed:false},{thermo:true}),['probe']);
 assert.deepEqual(fields({port:'',username:'',password:''}),[],'Thermo fields are ignored when Thermo is not being connected');
 // The network rule is the server's rule.
 for(const [ip,cidrs] of [['10.0.0.30',['10.0.0.0/24']],['10.0.0.0',['10.0.0.0/24']],['10.0.0.255',['10.0.0.0/24']],['10.0.1.1',['10.0.0.0/24']],['192.168.1.5',[]],['10.1.2.3',['10.0.0.0/8','192.168.0.0/16']],['192.168.5.1',['10.0.0.0/8','192.168.0.0/16']],['10.0.0.1',['10.0.0.0/31']],['999.0.0.1',[]]])
  assert.equal(inNetworks(ip,cidrs),inCidrs(ip,cidrs),`${ip} in ${cidrs}`);
});

test('what the form offers is what the server accepts, and every built-in picture exists',async()=>{
 assert.deepEqual([...PICTURES],[...server.PICTURES]);
 for(const id of PICTURES){const svg=await readFile(new URL(`../public/images/generic/${id}.svg`,import.meta.url),'utf8');assert.match(svg,/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 480 320"/);assert.doesNotMatch(svg,/<script|href=|url\(http/i,'a picture is a drawing, nothing else');}
 for(const role of server.MACHINE_ROLES)assert.ok(server.PICTURES.includes(server.defaultPicture(role)),role);
 // The view draws without innerHTML and without hex colours of its own: text-safe DOM, colours from tokens.
 for(const file of ['home-view.js','home-telemetry.js','home-add-device.js']){const src=await readFile(new URL(`../public/${file}`,import.meta.url),'utf8');
  assert.doesNotMatch(src,/innerHTML|insertAdjacentHTML|outerHTML/,file);assert.doesNotMatch(src,/['"`]#[0-9a-fA-F]{3,8}['"`]/,`${file}: colours belong in home.css`);}
 const css=await readFile(new URL('../public/home.css',import.meta.url),'utf8');
 for(const token of ['--home-cpu','--home-gpu','--home-mem','--home-power','--home-temp'])assert.match(css,new RegExp(`${token}:#`),token);
 assert.doesNotMatch(css,/var\(--(panel|line|txt|dim|faint|accent2?|ok|warn|crit|mono|sans)\b/,'home.css reads the design tokens, not the old shell palette');
});

// A canvas does not follow CSS: the chart colours are read from the tokens when a chart is drawn, so a
// theme change has to draw the live charts again (docs/design.md → Themes).
test('machine charts are drawn again with the new colours when the theme changes',async()=>{
 const COLORS={dark:{'--color-text':'#f3ede4','--home-cpu':'#d95926'},light:{'--color-text':'#1d1a26','--home-cpu':'#eb6834'}};
 let theme='dark';
 const before={getComputedStyle:globalThis.getComputedStyle,document:globalThis.document,ResizeObserver:globalThis.ResizeObserver};
 globalThis.getComputedStyle=()=>({getPropertyValue:name=>COLORS[theme][name]||''});
 globalThis.document={documentElement:{},createElement:()=>({})};
 globalThis.ResizeObserver=class{observe(){}disconnect(){}};
 try{
  const {renderCharts,disposeCharts,SERIES}=await import('../public/home-charts.js');
  const options=[],charts=new Map();
  const echarts={getInstanceByDom:node=>charts.get(node)||null,init(node){const chart={setOption:o=>options.push(o),dispose(){charts.delete(node);},resize(){},getDom:()=>node};charts.set(node,chart);return chart;}};
  const node={textContent:'',classList:{add(){},remove(){}},querySelector:()=>null,contains:()=>false};
  const card={def:SERIES.find(s=>s.key==='cpu'),node,value:{className:'',replaceChildren(){}},sub:{textContent:''}};
  const colours=o=>[o.tooltip.textStyle.color,o.series.at(-1).lineStyle.color];
  await renderCharts([card],{points:[{t:1000,cpu:10},{t:1060,cpu:20}]},'30m',{},{echarts});
  assert.equal(options.length,1);assert.deepEqual(colours(options[0]),['#f3ede4','#d95926']);
  theme='light';dispatchEvent(new Event('themechange'));
  assert.equal(options.length,2,'the live chart got a new option');assert.deepEqual(colours(options[1]),['#1d1a26','#eb6834']);
  assert.deepEqual(options[1].series.at(-1).data,options[0].series.at(-1).data,'the same data, only the colours change');
  disposeCharts();dispatchEvent(new Event('themechange'));
  assert.equal(options.length,2,'a chart that left the page is not drawn again');
 }finally{Object.assign(globalThis,before);}
});
