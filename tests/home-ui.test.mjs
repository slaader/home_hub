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
const {validateDevice,inNetworks,PICTURES,telemetryChoices,choicesFor}=await import('../public/home-add-device.js');
const {pictureChain,orderedMachines,moveId,sparkLabel}=await import('../public/home-view.js');
const server=await import('../server/home-devices.mjs');
const {inCidrs}=await import('../server/site-config.mjs');
const {TELEMETRY_REPO_URL}=await import('../server/thermo-client.mjs');
const {TELEMETRY_ADAPTERS}=await import('../server/home-data.mjs');
const {dictionary}=await import('../public/i18n.js');

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
 assert.match(installSteps({source:'agent'},meta)[1],/Edit device → Telemetry/);assert.match(installSteps({source:'agent',platform:'macos'},meta)[2],/Edit device → Telemetry/);assert.match(installSteps({source:'site'},meta)[2],/local\/site\.json/);assert.match(installSteps({source:'ui'},meta)[0],/Thermo/);
});

test('a tile tries the machine\'s own picture first, then the built-in one for what it is',()=>{
 assert.deepEqual(pictureChain({id:'studio',role:'computer',kind:'thermo',image:'/images/home/studio.jpg',picture:'/images/desktop.png'}),['/images/home/studio.jpg','/images/desktop.png','/images/generic/desktop.svg']);
 assert.deepEqual(pictureChain({id:'nas',role:'nas',kind:'nas',image:null,picture:null}),['/images/generic/nas.svg'],'the server said there is no site picture: none is asked for');
 assert.deepEqual(pictureChain({id:'old',kind:'router'}),['/images/home/old.jpg','/images/generic/router.svg'],'an older server did not say: the site picture is tried');
 assert.deepEqual(pictureChain({id:'pi',added:true,role:'other',kind:'other',image:null,picture:'/images/generic/board.svg'}),['/images/generic/board.svg','/images/generic/generic.svg']);
 assert.deepEqual(pictureChain({id:'m',added:true,role:'computer',kind:'thermo',image:'/images/home/m.jpg?v=1',picture:'/images/generic/desktop.svg'}),['/images/home/m.jpg?v=1','/images/generic/desktop.svg']);
 // Order helpers behind a moved tile.
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

// Add device → 3 · Telemetry: the choices are the agents the server lists, as far as the dialog has a form
// for them. Nothing is offered that the hub cannot connect, and a later adapter needs no change to the list.
test('the telemetry choices of the device dialog come from the server',async()=>{
 const thermo={id:'thermo',name:'Thermo',summary:'CPU, GPU, paměť, příkon, teploty a disky',defaultPort:49286,platform:'macos',recommended:false};
 const windows={id:'windows',name:'Windows (SSH)',summary:'CPU a jádra, GPU, paměť, disky a síť přes SSH a PowerShell, bez agenta; teploty a příkon Windows nehlásí',defaultPort:22,platform:'windows',recommended:false};
 const all=telemetryChoices({adapters:TELEMETRY_ADAPTERS});
 assert.deepEqual(all.slice(0,2),[thermo,windows]);
 assert.deepEqual(all.map(a=>a.id),['thermo','windows','winrm','node-exporter','prometheus','linux-ssh'],'every adapter the server lists today has a form');
 assert.deepEqual(choicesFor(all,'linux').map(a=>a.id),['node-exporter','prometheus','linux-ssh'],'Linux: its own sources, the recommended one first');
 assert.deepEqual(choicesFor(all,'windows').map(a=>a.id),['windows','winrm']);assert.deepEqual(choicesFor(all,'macos').map(a=>a.id),['thermo']);
 assert.equal(choicesFor(all,'').length,6,'with no system said, every adapter');assert.equal(choicesFor(all,'other').length,6);
 const bare={id:'thermo',name:'Thermo',summary:'',defaultPort:49286,platform:null,recommended:false};
 assert.deepEqual(telemetryChoices({adapters:[{id:'future-agent',name:'Later'},{...thermo,name:'Renamed',defaultPort:50000},null,{name:'no id'}]}),[{...thermo,name:'Renamed',defaultPort:50000}],'an adapter without a form here is not offered; names and ports are the server\'s');
 assert.deepEqual(telemetryChoices({adapters:[]}),[],'a hub that supports none offers none');
 assert.deepEqual(telemetryChoices({agent:'Thermo'}),[bare],'a server from before the list: the one agent it names');
 for(const a of TELEMETRY_ADAPTERS)assert.ok(dictionary[a.summary],`English for "${a.summary}"`);
 const src=await readFile(new URL('../public/home-add-device.js',import.meta.url),'utf8');
 assert.match(src,/fit\.map\(a=>choice\('had-telemetry',a\.id,/,'one choice per offered adapter that fits the system');
 assert.doesNotMatch(src,/Zatím bez telemetrie|živé CPU, GPU, paměť, příkon a teploty/,'the old fixed pair is gone');
});

// The small chart on a tile: a bare line on a canvas. Nothing but the series is drawn, a step without a
// reading stays a gap, and like the big charts it is drawn again when the theme changes.
test('the tile chart is a bare, smooth line with gaps, in the measure\'s colour of the current theme',async()=>{
 const COLORS={dark:{'--home-cpu':'#d95926','--home-gpu':'#9085e9'},light:{'--home-cpu':'#eb6834','--home-gpu':'#6250d6'}};
 let theme='dark';
 const before={getComputedStyle:globalThis.getComputedStyle,document:globalThis.document,ResizeObserver:globalThis.ResizeObserver};
 globalThis.getComputedStyle=()=>({getPropertyValue:name=>COLORS[theme][name]||''});
 globalThis.document={documentElement:{}};
 const observed=[];globalThis.ResizeObserver=class{observe(n){observed.push(n);}unobserve(){}disconnect(){}};
 try{
  const {renderSpark,disposeSparks,sparkOption}=await import('../public/home-charts.js');
  const spark={series:'gpu',end:1_800_000_000,stepSeconds:10,windowSeconds:600,values:[null,5,7,null,null,30,12]};
  const o=sparkOption(spark),line=o.series[0];
  assert.deepEqual([o.xAxis.show,o.yAxis.show,o.legend,o.tooltip,o.title,o.series.length,line.markLine],[false,false,undefined,undefined,undefined,1,undefined],'no axes, labels, legend, grid lines or annotations');
  assert.deepEqual([o.grid.left,o.grid.right],[1,1]);assert.equal(o.animation,false);
  assert.deepEqual(line.data.map(d=>d[1]),spark.values,'empty steps stay null');assert.equal(line.connectNulls,false,'and are not bridged');
  assert.deepEqual([line.data[0][0],line.data.at(-1)[0],line.data[1][0]-line.data[0][0]],[(spark.end-60)*1000,spark.end*1000,10000]);
  assert.deepEqual([line.showSymbol,line.silent,line.smooth>0,line.lineStyle.cap,line.lineStyle.join],[false,true,true,'round','round']);
  assert.deepEqual([line.lineStyle.color,line.areaStyle.color.colorStops.at(-1).color],['#9085e9','rgba(144,133,233,0)'],'the GPU token, fading out below the line');
  assert.equal(sparkOption({...spark,series:'cpu'}).series[0].lineStyle.color,'#d95926');
  // The scale: from zero to the next quarter above the peak, never tighter than 25 %.
  assert.deepEqual([o.yAxis.min,o.yAxis.max],[0,50]);
  assert.equal(sparkOption({...spark,values:[1,2,3]}).yAxis.max,25,'an idle machine is a low line, not magnified noise');assert.equal(sparkOption({...spark,values:[96]}).yAxis.max,100);
  // Drawn on the tile, kept across refreshes, redrawn on a theme change, dropped with the tile.
  const options=[],made=[];
  const echarts={init(node){const chart={node,setOption:x=>options.push(x),dispose(){chart.gone=true;},resize(){}};made.push(chart);return chart;}};
  const tile={isConnected:true},other={isConnected:true};
  await renderSpark(tile,spark,{echarts});await renderSpark(tile,{...spark,values:[1,2,3]},{echarts});await renderSpark(other,spark,{echarts});
  assert.equal(made.length,2,'a refresh draws into the chart that is there');assert.equal(options.length,3);assert.deepEqual(observed,[tile,other]);
  theme='light';dispatchEvent(new Event('themechange'));
  assert.equal(options.length,5);assert.deepEqual(options.slice(3).map(x=>x.series[0].lineStyle.color),['#6250d6','#6250d6']);
  assert.deepEqual(options[3].series[0].data.map(d=>d[1]),[1,2,3],'the newest data, in the new colours');
  other.isConnected=false;await renderSpark(tile,spark,{echarts});
  assert.equal(made[1].gone,true,'a tile that left the page takes its chart along');
  disposeSparks();dispatchEvent(new Event('themechange'));assert.equal(options.length,6);assert.equal(made[0].gone,true);
 }finally{Object.assign(globalThis,before);}
 // No caption on the tile: the chart is named in its label and tooltip.
 assert.equal(sparkLabel({series:'gpu',windowSeconds:600,values:[1,12.4]}),'GPU over the last 10 min, now 12 %');
 assert.equal(sparkLabel({series:'cpu',windowSeconds:600,values:[3,null]}),'CPU over the last 10 min','no "now" when the newest step has no reading');
 const view=await readFile(new URL('../public/home-view.js',import.meta.url),'utf8');
 assert.doesNotMatch(view,/CPU load · 30 min|class:'rule'|loadHistory\(m\.id,'30m'/,'no caption, no rule line, no 30-minute history per tile');
});
