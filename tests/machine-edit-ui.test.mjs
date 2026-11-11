// Every machine tile on the overview has an Edit action for a writer: the tile is a card holding its link and, beside
// it (never inside it), an Edit button. Dragging and keyboard moves still work on that card, the button never lifts it.
// A site machine's editor (the NAS, a Thermo Mac, the router) edits its display metadata as an override and sends only
// what the person changed (or what was overridden already); a Thermo Mac and the router say who reads their telemetry.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {installDom,Element,fire} from './fixtures/mini-dom.mjs';

const bus=new EventTarget();
globalThis.addEventListener??=bus.addEventListener.bind(bus);
globalThis.dispatchEvent??=bus.dispatchEvent.bind(bus);
installDom();
if(!('style' in Element.prototype))Object.defineProperty(Element.prototype,'style',{get(){return this._style??={};}});
if(!('value' in Element.prototype))Object.defineProperty(Element.prototype,'value',{get(){return this._value??this.getAttribute('value')??'';},set(v){this._value=String(v);}});
Element.prototype.showModal??=function(){this.open=true;};
Element.prototype.scrollIntoView??=function(){};
const posts=[];
globalThis.fetch=async(url,o={})=>{posts.push({url,body:o.body&&typeof o.body==='string'?JSON.parse(o.body):null});return {ok:true,status:200,json:async()=>({})};};
const {tileDrag}=await import('../public/home-drag.js');
const {openSiteEdit,siteForm}=await import('../public/home-add-device.js');
const {setLang}=await import('../public/i18n.js');
setLang('cs');
const meta={agent:'Thermo',adapters:[{id:'thermo',name:'Thermo',platform:'macos'},{id:'node-exporter',name:'Linux (Node Exporter)',platform:'linux'},{id:'prometheus',name:'Linux (Prometheus)',platform:'linux'}]};
const HASH='a'.repeat(64);
const siteMachine=over=>({id:'nas',name:'NAS',hostname:'nas.example.lan',ip:'10.0.0.74',role:'nas',kind:'nas',source:'site',readOnly:true,platform:null,telemetryEditable:true,telemetryBinding:null,
 props:{cpu:'Ryzen 9 7900',gpu:'—',ramGb:64,diskTotalBytes:66e12,pools:3},telemetry:{state:'not-installed',thermoId:null},picture:'/images/nas.png',image:null,
 siteOverride:{fields:[],hash:HASH,image:false,updatedAt:null,updatedBy:null},
 siteDefaults:{name:'NAS',hostname:'nas.example.lan',ip:'10.0.0.74',hardware:{cpu:'Ryzen 9 7900',gpu:'—',ramGb:64,diskTotalBytes:66e12},picture:'/images/nas.png',image:null},...over});
const all=(n,pred,out=[])=>{for(const k of n.children){if(pred(k))out.push(k);all(k,pred,out);}return out;};
const text=n=>n.textContent;
const inputs=d=>all(d,n=>n.tagName==='input'&&!['radio','checkbox','file'].includes(n.getAttribute('type')));
const tick=()=>new Promise(r=>setTimeout(r,10));

test('a tile card holds its link and an Edit button beside it; the button never lifts the card, the link still moves it by keys',()=>{
 const grid=document.createElement('div');grid.setAttribute('class','hv-tiles');document.body.append(grid);
 globalThis.getComputedStyle=()=>({gridTemplateColumns:'200px 200px',overflowY:'visible'});
 const cards={};
 for(const [i,id] of ['a','b'].entries()){const card=document.createElement('div'),link=document.createElement('a'),edit=document.createElement('button');
  card.setAttribute('class','hv-tile');card.setAttribute('data-id',id);link.setAttribute('class','hv-tile-link');edit.setAttribute('class','hv-tile-edit');
  card.getBoundingClientRect=()=>({left:grid.children.indexOf(card)*220,top:0,right:grid.children.indexOf(card)*220+200,bottom:300});
  card.append(link,edit);grid.append(card);cards[id]={card,link,edit};void i;}
 const drops=[];
 const drag=tileDrag({grid,onDrop:(order,id)=>{drops.push({order,id});for(const x of order)grid.append(cards[x].card);}});
 const at=(x,y)=>({pointerId:1,pointerType:'mouse',button:0,isPrimary:true,clientX:x,clientY:y});
 fire(cards.a.edit,'pointerdown',at(190,10));fire(cards.a.edit,'pointermove',at(400,40));
 assert.equal(drag.busy(),false,'pressing Edit and moving does not pick the tile up');fire(cards.a.edit,'pointerup',at(400,40));
 fire(cards.a.link,'pointerdown',at(100,150));fire(cards.a.link,'pointermove',at(420,150));assert.equal(drag.busy(),true,'the card is dragged from its link');
 fire(cards.a.link,'pointerup',at(420,150));assert.deepEqual(drops.at(-1),{order:['b','a'],id:'a'});
 const ev=fire(cards.a.link,'keydown',{key:'ArrowLeft'});assert.equal(ev.defaultPrevented,true);assert.deepEqual(drops.at(-1),{order:['a','b'],id:'a'},'arrow keys on the focused link move its card');
 fire(cards.a.edit,'keydown',{key:'ArrowRight'});assert.equal(drops.length,2,'keys on the Edit button are the button\'s');
 drag.destroy();grid.remove();
});

test('the overview wires an Edit button on every tile a writer may edit, outside the link; the machine page too',async()=>{
 const view=await readFile(new URL('../public/home-view.js',import.meta.url),'utf8'),css=await readFile(new URL('../public/home.css',import.meta.url),'utf8');
 assert.match(view,/const link=el\('a',\{class:'hv-tile-link',href:`#host-\$\{m\.id\}`/);
 assert.match(view,/const node=el\('div',\{class:'hv-tile','data-id':m\.id\},link,edit\);/,'the button is the link\'s sibling, not its child');
 assert.match(view,/if\(m\.added&&canEdit\)return \(\)=>openEditDevice/);assert.match(view,/if\(m\.source==='site'&&canEditSite\)return \(\)=>openSiteEdit/);
 assert.match(view,/'aria-label':t\('Upravit \{name\}',\{name:m\.name\}\)/,'the button names its machine');
 assert.match(view,/e\.preventDefault\(\);e\.stopPropagation\(\);open\(\);/,'a click on Edit never opens the page under it');
 assert.match(view,/Boolean\(editorOf\(m\)\)\]\.join/,'the tile is redrawn when the Edit action appears or goes');
 assert.match(view,/t\('Upravit stroj'\)/);
 assert.match(css,/\.hv-tile:has\(>\.hv-tile-link:focus-visible\)\{outline/,'the card shows the link\'s keyboard focus');
 assert.match(css,/\.hv-tile-edit\{position:absolute/);
});

test('siteForm: an untouched value is not sent, a changed or already overridden one is; a built-in picture is sent',()=>{
 const m=siteMachine({name:'Storage',props:{cpu:'Ryzen 9 7900',gpu:'—',ramGb:128,diskTotalBytes:66e12,pools:3},pictureId:'server',siteOverride:{fields:['name','hardware.ramGb','picture'],hash:HASH,image:false}});
 const f=siteForm(m);
 assert.deepEqual(f.current(),{name:'Storage',hardware:{ramGb:128},picture:'server'});
 assert.equal(f.overridden('name'),true);assert.equal(f.overridden('cpu'),false);assert.equal(f.defaultText('name'),'NAS');assert.equal(f.defaultText('ramGb'),'64 GB');
 const box=v=>({value:v});
 const form={name:box('Storage'),hostname:box('vault.example.lan'),ip:box('10.0.0.74'),cpu:box('Ryzen 9 7900'),gpu:box(''),ramGb:box('128'),diskGb:box('66000')};
 const touched=k=>k==='hostname';
 assert.deepEqual(f.body(form,touched,{picture:'server',site:false,own:false,keepOwn:false}),{name:'Storage',hostname:'vault.example.lan',hardware:{ramGb:128},picture:'server'});
 assert.deepEqual(f.body(form,()=>false,{picture:null,site:true,own:false,keepOwn:false}),{name:'Storage',hardware:{ramGb:128}},'back to the site\'s picture: picture left out');
});

test('the site editor of the NAS saves only what changed, over the site\'s values, and offers the reset when there is an override',async()=>{
 posts.length=0;
 const d=openSiteEdit({machine:siteMachine(),meta,onSaved:()=>{}});
 const body=text(d);
 assert.match(body,/Upravit stroj/);assert.match(body,/2 · Co to je/);assert.match(body,/jen k zobrazení/);assert.match(body,/Z konfigurace webu/);
 assert.ok(!body.includes('Odebrat'),'no remove');assert.ok(!body.includes('Obnovit výchozí'),'no reset without an override');
 const [name]=inputs(d);assert.equal(name.value,'NAS');name.value='Storage';
 fire(all(d,n=>n.tagName==='form')[0],'submit');await tick();
 assert.deepEqual(posts.map(p=>p.url),['/api/home/devices/site']);
 assert.deepEqual(posts[0].body,{id:'nas',base:HASH,machine:{name:'Storage'}},'one changed field, the base it was read with');
 // Nothing changed: nothing sent.
 posts.length=0;const again=openSiteEdit({machine:siteMachine(),meta,onSaved:()=>{}});fire(all(again,n=>n.tagName==='form')[0],'submit');await tick();
 assert.deepEqual(posts,[]);
 const edited=openSiteEdit({machine:siteMachine({name:'Storage',siteOverride:{fields:['name'],hash:HASH,image:false,updatedBy:'admin',updatedAt:'2026-11-11T10:00:00Z'}}),meta,onSaved:()=>{}});
 assert.match(text(edited),/Obnovit výchozí z konfigurace webu/);assert.match(text(edited),/Upraveno; konfigurace webu: NAS/);
});

test('a Thermo Mac and the router: a real editor, and a note on who reads their telemetry instead of providers',()=>{
 const mac=openSiteEdit({machine:siteMachine({id:'mini',name:'Mac mini',role:'computer',kind:'thermo',telemetryEditable:false,telemetry:{state:'ok',thermoId:'mini'}}),meta,onSaved:()=>{}});
 assert.match(text(mac),/agent Thermo podle konfigurace webu \(thermoId\)/);assert.ok(inputs(mac).length>=7,'name, address and hardware are editable');
 assert.deepEqual(all(mac,n=>n.getAttribute?.('name')==='had-telemetry'),[],'no provider choice, no Thermo disconnect');
 assert.ok(!text(mac).includes('Odpojit telemetrii'));
 const router=openSiteEdit({machine:siteMachine({id:'router',name:'Router',role:'router',kind:'router',telemetryEditable:false,telemetry:null}),meta,onSaved:()=>{}});
 assert.match(text(router),/adaptér routeru/);assert.ok(inputs(router).length>=7);
});
