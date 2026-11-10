// The real inventory map (inventoryView) on a tiny mocked DOM, driven by pointer events dispatched the way a
// browser does: capture at window/document, then the card, then bubbling. Checks what the user sees:
// which card is selected, and what layout a mouse drag saved.
import './support/site-inventory.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {installDom,fire} from './fixtures/mini-dom.mjs';

const {document,window,localStorage}=installDom();
const {inventoryView}=await import('../public/inventory-view.js');
const {setPrincipal}=await import('../public/session-cache.js');
const views=await import('../public/views.js');
// What app.js render() does before it replaces the page; looked up at call time so this file still loads without it.
const leave=()=>views.leaveView?.();

const DOC={updated_at:'2026-11-08T00:00:00Z',entries:[
 {id:'mini',kind:'machine',name:'Mac mini'},
 {id:'svc-a',kind:'runtime',name:'Alpha',machine:'mini',address:'http://alpha'},
 {id:'svc-b',kind:'runtime',name:'Beta',machine:'mini',address:'http://beta'},
 {id:'nas',kind:'machine',name:'NAS box'}]};
globalThis.fetch=async url=>{if(String(url)==='/api/inventory')return {ok:true,status:200,json:async()=>({doc:DOC,gaps:[]})};return {ok:false,status:404,json:async()=>({})};};
const tick=()=>new Promise(r=>setImmediate(r));
let user=0;
// Mount as the router does: the page being replaced is disposed, then the new view goes in.
function mountNow(){
 leave();
 setPrincipal({authKind:'session',role:'viewer',username:`u${++user}`});// fresh selection and inventory cache
 localStorage.clear();document.visibilityState='visible';
 document.body.replaceChildren(inventoryView({role:'viewer'}));
}
async function mount(){
 mountNow();
 for(let i=0;i<5;i++)await tick();
 const cards=()=>new Map(document.body.querySelectorAll('.inv-node').map(n=>[n.getAttribute('aria-label').split(',')[0],n]));
 assert.equal(cards().size,4,'the map is drawn');
 const at=name=>cards().get(name).children.find(c=>c.tagName==='rect');// the card's rect, as a real hit test returns
 const svg=()=>document.body.querySelector('.inv-map-wrap').children[0];
 const pe=(pointerId,pointerType,clientX,clientY,isPrimary)=>({pointerId,pointerType,clientX,clientY,isPrimary,button:0,buttons:1,width:1,height:1});
 return {
  cards,
  selected:()=>[...cards()].filter(([,n])=>n.getAttribute('aria-pressed')==='true').map(([k])=>k)[0]??null,
  down:(id,target,{type='touch',x=100,y=200,primary=true}={})=>fire(typeof target==='string'?at(target):target,'pointerdown',pe(id,type,x,y,primary)),
  move:(id,target,x,y,{type='touch'}={})=>fire(typeof target==='string'?at(target):target,'pointermove',pe(id,type,x,y,true)),
  up:(id,target,{type='touch',x=100,y=200}={})=>fire(typeof target==='string'?at(target):target,'pointerup',{...pe(id,type,x,y,true),buttons:0}),
  cancel:(id,target,{type='touch'}={})=>fire(typeof target==='string'?at(target):target,'pointercancel',pe(id,type,0,0,true)),
  lost:(id,{type='mouse'}={})=>fire(document,'lostpointercapture',{...pe(id,type,0,0,true),buttons:0}),
  hover:(id,target,x,y,{type='mouse'}={})=>fire(typeof target==='string'?at(target):target,'pointermove',{...pe(id,type,x,y,true),buttons:0}),
  svg,saved:()=>JSON.parse(localStorage.getItem('home-hub.inventory.map.v3')||'null')
 };
}

test('DOM: a lone touch tap selects the card and a second tap clears it; a swipe selects nothing',async()=>{
 const m=await mount();
 m.down(1,'Alpha');m.up(1,'Alpha');assert.equal(m.selected(),'Alpha');
 m.down(2,'Alpha');m.move(2,'Alpha',102,201);m.up(2,'Alpha');assert.equal(m.selected(),null,'tap again: deselected');
 m.down(3,'Beta');m.move(3,'Beta',100,170);m.up(3,'Beta');assert.equal(m.selected(),null,'a swipe');
 m.down(4,'Beta');m.cancel(4,'Beta');assert.equal(m.selected(),null,'browser took over the scroll');
});

test('DOM: two fingers on one card or on two cards select nothing, in either release order',async()=>{
 const m=await mount();
 for(const [a,b] of [['Alpha','Alpha'],['Alpha','Beta']])for(const first of [1,2]){
  m.down(1,a);m.down(2,b,{x:140,primary:false});
  const [x,y]=first===1?[1,2]:[2,1];m.up(x,x===1?a:b);m.up(y,y===1?a:b);
  assert.equal(m.selected(),null,`${a}+${b}, finger ${first} up first`);
 }
 m.down(5,'Beta');m.up(5,'Beta');assert.equal(m.selected(),'Beta','a lone tap still works afterwards');
});

test('DOM finding 1: mouse down, lostpointercapture without pointerup, then a lone touch tap selects',async()=>{
 const m=await mount();
 m.down(1,'Alpha',{type:'mouse'});m.lost(1);
 m.down(7,'Beta',{type:'touch'});m.up(7,'Beta');
 assert.equal(m.selected(),'Beta');
 m.down(8,'Beta',{type:'touch'});m.up(8,'Beta');assert.equal(m.selected(),null,'and the next tap toggles it off');
});

test('DOM finding 2: first finger on a card, second on the SVG background or off the map, first released: no selection',async()=>{
 for(const where of ['background','page']){
  const m=await mount();
  const other=where==='background'?m.svg():document.body;
  m.down(1,'Alpha');m.down(2,other,{x:300,y:300,primary:false});m.up(1,'Alpha');
  assert.equal(m.selected(),null,`second finger on the ${where}`);
  m.up(2,other);assert.equal(m.selected(),null);
  m.down(3,'Alpha');m.up(3,'Alpha');assert.equal(m.selected(),'Alpha','once both are up, a lone tap selects');
 }
});

test('DOM finding 3: mouse down, touch down, mouse up, mouse click while the touch is still held: no selection',async()=>{
 const m=await mount();
 m.down(1,'Alpha',{type:'mouse'});m.down(2,'Beta',{type:'touch'});m.up(1,'Alpha',{type:'mouse'});
 assert.equal(m.selected(),null);
 m.down(1,'Alpha',{type:'mouse'});m.up(1,'Alpha',{type:'mouse'});
 assert.equal(m.selected(),null,'the touch is still on the screen');
 m.up(2,'Beta');assert.equal(m.selected(),null,'and the touch was never alone');
 m.down(1,'Alpha',{type:'mouse'});m.up(1,'Alpha',{type:'mouse'});assert.equal(m.selected(),'Alpha','a click with nothing else down selects');
});

test('DOM: mouse drag still moves a card and saves the new order; a mouse click still selects',async()=>{
 const m=await mount();
 m.down(1,'Alpha',{type:'mouse',x:100,y:200});
 m.move(1,'Alpha',100,230,{type:'mouse'});
 assert.match(m.cards().get('Alpha').getAttribute('class'),/dragging/,'the card is being dragged');
 m.move(1,document.body,100,262,{type:'mouse'});// moves keep coming even off the card
 m.up(1,document.body,{type:'mouse',x:100,y:262});
 assert.equal(m.selected(),null,'a drag selects nothing');
 const order=Object.values(m.saved().modes.machine.order).find(a=>a.includes('svc-a'));
 assert.deepEqual(order,['mini','svc-b','svc-a'],'Alpha was dropped below Beta');
 m.down(1,'Beta',{type:'mouse'});m.move(1,'Beta',102,201,{type:'mouse'});m.up(1,'Beta',{type:'mouse'});
 assert.equal(m.selected(),'Beta','a click under the slop selects');
});

test('DOM: blur and a hidden tab forget held pointers, so a later lone tap works; a cut-off drag is not saved',async()=>{
 const m=await mount();
 m.down(1,'Alpha');fire(window,'blur');
 m.down(2,'Beta');m.up(2,'Beta');assert.equal(m.selected(),'Beta','after blur the lost finger 1 no longer counts');
 m.up(1,'Alpha');assert.equal(m.selected(),'Beta','finger 1\'s late up does nothing');
 m.down(3,'Alpha');document.visibilityState='hidden';fire(document,'visibilitychange');document.visibilityState='visible';
 m.down(4,'Alpha');m.up(4,'Alpha');assert.equal(m.selected(),'Alpha','after a hidden tab, too');
 m.down(1,'Beta',{type:'mouse'});m.move(1,'Beta',100,260,{type:'mouse'});fire(window,'blur');
 assert.equal(m.saved(),null,'no layout saved');
 assert.doesNotMatch(m.cards().get('Beta').getAttribute('class'),/dragging/,'the map is redrawn, the card back in place');
});

test('DOM: focus moving to a card (an element blur, which does not bubble) forgets nothing',async()=>{
 const m=await mount();
 m.down(1,'Alpha',{type:'mouse'});fire(document.body,'blur',{bubbles:false});fire(m.cards().get('Alpha'),'focus',{bubbles:false});
 m.move(1,'Alpha',100,262,{type:'mouse'});m.up(1,'Alpha',{type:'mouse',x:100,y:262});
 assert.deepEqual(Object.values(m.saved().modes.machine.order).find(a=>a.includes('svc-a')),['mini','svc-b','svc-a'],'the drag survived the focus change');
 m.down(2,'Beta');m.down(3,document.body,{primary:false});fire(document.body,'blur',{bubbles:false});m.up(2,'Beta');
 assert.equal(m.selected(),null,'the second finger is still counted after an element blur');m.up(3,document.body);
});

test('DOM: the map\'s document listeners go away once the map is gone, even with no dispose (backstop)',async()=>{
 leave();const before=document.listeners.length;
 const m=await mount();
 const mounted=document.listeners.length;assert.ok(mounted>before,'listeners added for the map');
 document.body.replaceChildren();// navigate away
 fire(document.body,'pointerdown',{pointerId:1,pointerType:'touch',isPrimary:true,button:0,clientX:0,clientY:0});
 assert.equal(document.listeners.length,before,'removed on the first event after the map left the page (the isConnected backstop, no dispose)');
 void m;
});

// Review r4. Clock control for the old 30 s inactivity drop: the view used Date.now for it.
async function withClock(fn){const real=Date.now;let now=real();Date.now=()=>now;try{await fn(ms=>{now+=ms;});}finally{Date.now=real;}}
const order=m=>Object.values(m.saved()?.modes.machine.order||{}).find(a=>a.includes('svc-a'))||null;
const translateOf=n=>n.getAttribute('transform');

test('DOM review r4 finding 1: a touch held still for over 30 s, then a mouse click on another card: no selection',async()=>{
 const m=await mount();
 await withClock(async wait=>{
  m.down(2,'Beta');wait(30001);
  m.down(1,'Alpha',{type:'mouse'});m.up(1,'Alpha',{type:'mouse'});
  assert.equal(m.selected(),null,'the touch is still on the screen');
  m.up(2,'Beta');assert.equal(m.selected(),null,'and the touch was never alone');
  m.down(1,'Alpha',{type:'mouse'});m.up(1,'Alpha',{type:'mouse'});assert.equal(m.selected(),'Alpha','with nothing else down a click selects');
 });
});

test('DOM review r4 finding 1: a paused mouse drag plus another pointer: the drag continues and saves on release',async()=>{
 const m=await mount();
 await withClock(async wait=>{
  m.down(1,'Alpha',{type:'mouse',x:100,y:200});m.move(1,'Alpha',100,230,{type:'mouse'});
  wait(30001);m.down(2,document.body,{type:'touch',x:400,y:400});m.up(2,document.body);
  m.move(1,document.body,100,262,{type:'mouse'});m.up(1,document.body,{type:'mouse',x:100,y:262});
 });
 assert.deepEqual(order(m),['mini','svc-b','svc-a'],'Alpha was dropped below Beta');
 assert.doesNotMatch(m.cards().get('Alpha').getAttribute('class'),/dragging/,'no card is left marked as dragging');
 assert.equal(m.selected(),null,'a drag selects nothing');
});

test('DOM review r4: a drag discarded by blur puts the card back and saves nothing',async()=>{
 const m=await mount();const home=translateOf(m.cards().get('Alpha'));
 m.down(1,'Alpha',{type:'mouse',x:100,y:200});m.move(1,'Alpha',100,262,{type:'mouse'});
 assert.notEqual(translateOf(m.cards().get('Alpha')),home,'the card moved');
 fire(window,'blur');
 assert.equal(translateOf(m.cards().get('Alpha')),home,'back where it was');
 assert.doesNotMatch(m.cards().get('Alpha').getAttribute('class'),/dragging/);assert.equal(m.saved(),null,'no layout saved');
 m.up(1,document.body,{type:'mouse',x:100,y:262});assert.equal(m.saved(),null,'its late release saves nothing either');
});

test('DOM review r4: a mouse event with no button held clears a stale mouse; a stale drag is rolled back',async()=>{
 const m=await mount();
 m.down(1,'Alpha',{type:'mouse'});// its pointerup never arrives
 m.hover(1,document.body,300,300);// the mouse moves with no button held: it is up
 m.down(7,'Beta');m.up(7,'Beta');assert.equal(m.selected(),'Beta','a lone touch tap works again');
 const n=await mount();const home=translateOf(n.cards().get('Alpha'));
 n.down(1,'Alpha',{type:'mouse',x:100,y:200});n.move(1,'Alpha',100,262,{type:'mouse'});
 n.hover(1,document.body,100,280);
 assert.equal(translateOf(n.cards().get('Alpha')),home,'the card goes back');
 assert.doesNotMatch(n.cards().get('Alpha').getAttribute('class'),/dragging/);assert.equal(n.saved(),null,'nothing saved');
 n.up(1,document.body,{type:'mouse',x:100,y:280});assert.equal(n.saved(),null,'a late release saves nothing');
 const r=await mount();const back=translateOf(r.cards().get('Alpha'));
 r.down(1,'Alpha',{type:'mouse',x:100,y:200});r.move(1,'Alpha',100,262,{type:'mouse'});
 r.down(1,'Beta',{type:'mouse',x:100,y:300});// the same mouse id comes down again: the old drag is over
 assert.equal(translateOf(r.cards().get('Alpha')),back,'the reused id rolls the old drag back');
 assert.doesNotMatch(r.cards().get('Alpha').getAttribute('class'),/dragging/);r.up(1,'Beta',{type:'mouse',x:100,y:300});
 assert.equal(r.saved(),null);assert.equal(r.selected(),'Beta','and the new press is a normal click');
});

test('DOM review r4 finding 2: mount and navigate away N times leaves no extra document or window listeners',async()=>{
 leave();document.body.replaceChildren();
 const base=[document.listeners.length,window.listeners.length],now=()=>[document.listeners.length,window.listeners.length];
 const away=()=>{leave();document.body.replaceChildren(views.el('p',{},'another page'));};// what render() does
 for(let i=0;i<3;i++){await mount();assert.ok(now()[0]>base[0]&&now()[1]>base[1],'the map binds while shown');away();}
 assert.deepEqual(now(),base,'navigated away before any pointer event: everything removed');
 for(let i=0;i<3;i++){mountNow();away();for(let k=0;k<5;k++)await tick();}
 assert.deepEqual(now(),base,'the inventory load finished after the view was gone: nothing was bound');
 assert.equal(document.body.querySelector('.inv-map-wrap'),null,'and nothing was drawn into the old view');
 const m=await mount();m.down(1,'Alpha');m.up(1,'Alpha');assert.equal(m.selected(),'Alpha','a fresh mount still works');
 away();assert.deepEqual(now(),base);
});

test('review r4 finding 2: the shell disposes the page it replaces (render and sign-in call leaveView)',async()=>{
 const {readFile}=await import('node:fs/promises');
 const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
 assert.match(app,/import \{[^}]*\bleaveView\b[^}]*\} from '\.\/views\.js'/);
 assert.match(app,/async function render\(\)\{[\s\S]*?\n leaveView\(\);\/\/ the page being replaced[\s\S]*?root\.replaceChildren\(shell\(machine,page,main\)\)/,'render() disposes before drawing any page');
 assert.match(app,/function login\(message=''\)\{\n me=null;setPrincipal\(null\);setPages\(null\);setIdentity\(null\);leaveView\(\);/,'so does the sign-in screen');
 const inv=await readFile(new URL('../public/inventory-view.js',import.meta.url),'utf8');
 assert.match(inv,/onLeave\(\(\)=>\{life\.abort\(\);mapLife\?\.abort\(\);\}\)/,'the inventory view registers its dispose');
});
