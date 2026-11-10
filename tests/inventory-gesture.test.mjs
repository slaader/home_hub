// Inventory map pointer model: a swipe scrolls the page and selects nothing; a lone tap selects; any other
// pointer, anywhere, spoils the tap; mouse and pen still drag cards.
import './support/site-inventory.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import * as inv from '../public/inventory-view.js';
const {pointerTracker,trackDown,trackMove,trackUp,trackClear,TOUCH_SLOP,DRAG_SLOP}=inv;
// Looked up at call time, so the file still loads against code without it and only its tests fail.
const trackStale=(...a)=>{assert.equal(typeof inv.trackStale,'function','trackStale is exported');return inv.trackStale(...a);};

// One tracker, fed in browser order. up() returns what the view would do: 'tap' (toggle), 'drop' (save a drag) or null.
// The clock is passed as a trailing argument the tracker no longer takes: quiet time must change nothing.
function map(){
 const t=pointerTracker(),out=[];let clock=1000;
 const ev=(pointerId,pointerType,clientX,clientY,isPrimary,button=0)=>({pointerId,pointerType,clientX,clientY,isPrimary,button});
 const result=r=>{out.push(!r?null:r.tap?'tap':r.drop?'drop':null);return out.at(-1);};
 return {t,out,
  down(id,{type='touch',x=100,y=200,primary=id===1,card='mini',button=0}={}){return trackDown(t,ev(id,type,x,y,primary,button),card,clock);},
  move(id,x,y,{type='touch',scale=1}={}){return trackMove(t,ev(id,type,x,y),scale,clock);},
  up(id,{type='touch'}={}){return result(trackUp(t,ev(id,type,0,0)));},
  cancel(id,{type='touch'}={}){return result(trackUp(t,ev(id,type,0,0),true));},// pointercancel and lostpointercapture
  clear(){return trackClear(t);},
  wait(ms){clock+=ms;},
  get held(){return [...t.down.keys()];}
 };
}
// A single pointer: down, moves, up. True when it is a tap.
function tap(type,[[x,y],...moves],scale=1){const m=map();m.down(1,{type,x,y});for(const [mx,my] of moves)m.move(1,mx,my,{type,scale});return m.up(1,{type})==='tap';}
const drags=(type,[[x,y],...moves],scale=1)=>{const m=map();m.down(1,{type,x,y});for(const [mx,my] of moves)m.move(1,mx,my,{type,scale});return m.up(1,{type})==='drop';};

test('a touch swipe across a map card is not a tap, so it never toggles the selection',()=>{
 assert.equal(tap('touch',[[100,200],[101,190],[102,160],[102,120]]),false,'vertical swipe (page scroll)');
 assert.equal(tap('touch',[[100,200],[140,201]]),false,'horizontal swipe (map scroll)');
 assert.equal(tap('touch',[[100,200],[100,200+TOUCH_SLOP]]),false,'at the slop it is a swipe');
 assert.equal(tap('touch',[[100,200],[100,170],[100,200]]),false,'coming back to the start does not turn a swipe into a tap');
});

test('a touch that stays put, or jitters a few pixels, is a tap; touch never drags a card',()=>{
 assert.equal(tap('touch',[[100,200]]),true,'no movement');
 assert.equal(tap('touch',[[100,200],[103,202],[98,199]]),true,'finger jitter');
 assert.equal(drags('touch',[[100,200],[100,240]]),false,'a swipe is never a drop');
});

test('mouse keeps its drag behaviour: 5 map units, scaled by the zoom of the map',()=>{
 assert.equal(DRAG_SLOP,5);
 assert.equal(tap('mouse',[[0,0],[4,0]]),true,'4 px at 1:1 is still a click');
 assert.equal(tap('mouse',[[0,0],[3,2]]),false,'5 px at 1:1 is no click');assert.equal(drags('mouse',[[0,0],[3,2]]),true,'it drags');
 assert.equal(drags('mouse',[[0,0],[3,0]],0.5),true,'fitted map (0.5 px per unit): 3 px is 6 units, a drag');
 assert.equal(tap('mouse',[[0,0],[6,0]],2),true,'zoomed map (2 px per unit): 6 px is 3 units, a click');
 assert.equal(drags('pen',[[0,0],[0,8]]),true,'pen drags like a mouse');
 const m=map();m.down(1,{type:'mouse',button:2});assert.equal(m.up(1,{type:'mouse'}),null,'a right-button press is tracked but never taps');
});

test('map cards allow native touch panning; the view feeds one map-level tracker from the document',async()=>{
 const css=await readFile(new URL('../public/inventory.css',import.meta.url),'utf8');
 const rule=css.match(/\.inv-node\{[^}]*\}/)[0];
 assert.match(rule,/touch-action:(manipulation|auto|pan-x pan-y)/,rule);
 assert.doesNotMatch(css,/\.inv-node[^{]*\{[^}]*touch-action:none/,'no map card blocks scrolling');
 const view=await readFile(new URL('../public/inventory-view.js',import.meta.url),'utf8');
 assert.match(view,/bindMapPointers\(\{doc:document,win:window,/,'one listener set for the map');
 for(const type of ['pointerdown','pointermove','pointerup','pointercancel','lostpointercapture'])assert.match(view,new RegExp(`on\\(doc,'${type}'`),type);
 assert.match(view,/on\(win,'blur',ev=>\{if\(ev\.target===win\)clear\(\);\},false\)/,'the window\'s own blur, not a focus change');assert.match(view,/visibilitychange',\(\)=>\{if\(doc\.visibilityState==='hidden'\)clear\(\);/);
 assert.doesNotMatch(view,/onpointer(down|move|up|cancel):/,'no per-card pointer handlers');
});

test('two fingers on one card select nothing, whichever finger lifts first',()=>{
 for(const order of [[1,2],[2,1]]){
  const m=map();m.down(1);m.down(2,{x:140});
  assert.deepEqual(order.map(id=>m.up(id)),[null,null],`release order ${order}`);
  assert.deepEqual(m.held,[],'nothing is tracked once both fingers are up');assert.equal(m.t.press,null);
 }
 const m=map();m.down(1);m.down(2);m.up(1);
 assert.equal(m.out[0],null,'no selection while another finger is on the card');
 m.down(3);assert.equal(m.up(3),null,'a third finger cannot tap while the second is still down');
 m.up(2);assert.deepEqual(m.held,[]);
});

test('a second finger on another card spoils the tap too (the tracker is per map, not per card)',()=>{
 for(const order of [[1,2],[2,1]]){
  const m=map();m.down(1,{card:'mini'});m.down(2,{card:'nas',primary:false});
  assert.deepEqual(order.map(id=>m.up(id)),[null,null],`release order ${order}`);assert.deepEqual(m.held,[]);
 }
});

test('a second finger after a swipe does not reset the swipe into a tap',()=>{
 const m=map();m.down(1);m.move(1,100,150);
 m.down(2,{x:300,y:300});m.move(2,301,300);
 assert.equal(m.t.press.moved,true,'the swipe is remembered; the new finger starts nothing');
 assert.equal(m.up(2),null);assert.equal(m.up(1),null);
 const n=map();n.down(1);n.move(1,100,150);n.down(2);n.up(1);n.up(2);
 assert.deepEqual(n.out,[null,null],'either release order');
});

test('moves of the other finger do not count as the first finger\'s swipe, and nothing it does makes a tap',()=>{
 const m=map();m.down(1);m.down(2);assert.equal(m.move(2,400,400),null,'the move is not the press\'s');
 assert.equal(m.t.press.moved,false,'only the press\'s own pointer moves it');
 assert.equal(m.up(1),null,'still not a tap: two fingers were down');
});

test('pointercancel ends the press without a tap, and only the matching pointer\'s events count',()=>{
 const m=map();m.down(1);assert.equal(m.cancel(1),null,'browser took over the scroll');assert.deepEqual(m.held,[]);
 const n=map();n.down(1);n.down(2);n.cancel(2);
 assert.deepEqual(n.held,[1],'the first finger is still tracked after the second was cancelled');
 assert.equal(n.up(1),null,'and it is no tap');assert.deepEqual(n.held,[]);
 const o=map();o.down(1);o.cancel(1);assert.equal(o.up(1),null,'a stray up after the cancel does nothing');
 const p=map();p.down(1);assert.equal(p.up(9),null,'an up from a pointer that never came down is ignored');
 assert.deepEqual(p.held,[1],'and does not end the real press');assert.equal(p.up(1),'tap');
});

test('a lone touch taps, and a new touch after all fingers are up taps again',()=>{
 const m=map();m.down(1);assert.equal(m.up(1),'tap');assert.deepEqual(m.held,[]);
 m.down(4,{primary:true});m.move(4,103,201);assert.equal(m.up(4),'tap','a fresh single tap after a finished gesture');
 const b=map();b.down(1,{card:null});assert.equal(b.up(1),null,'a tap on the background is no card tap');
});

test('a touch that starts while another finger is already on the screen elsewhere is never a tap',()=>{
 const m=map();m.down(7,{primary:false});assert.equal(m.up(7),null);
});

test('mouse drag and click are unchanged; a touch joining a mouse drag does not stop the drop',()=>{
 const m=map();m.down(1,{type:'mouse'});m.move(1,110,200,{type:'mouse'});
 assert.equal(m.up(1,{type:'mouse'}),'drop','mouse drag is saved');
 const c=map();c.down(1,{type:'mouse'});c.move(1,102,200,{type:'mouse'});
 assert.equal(c.up(1,{type:'mouse'}),'tap','mouse click under the slop still selects');
 const j=map();j.down(1,{type:'mouse'});j.move(1,130,200,{type:'mouse'});j.down(2,{type:'touch',primary:true});
 assert.equal(j.t.press.id,1,'the touch joins, it does not take over the mouse drag');
 assert.equal(j.up(2),null);assert.equal(j.up(1,{type:'mouse'}),'drop');
 const k=map();k.down(1,{type:'mouse'});k.down(2,{type:'touch',primary:true});
 assert.equal(k.up(1,{type:'mouse'}),null,'a click with a finger also down neither selects nor saves a drop');
 const x=map();x.down(1,{type:'mouse'});x.move(1,130,200,{type:'mouse'});assert.equal(x.cancel(1,{type:'mouse'}),null,'a cancelled drag is not saved');
});

test('finding 1: mouse down, lost capture with no pointerup, then a lone touch taps',()=>{
 const m=map();m.down(1,{type:'mouse',primary:true});m.cancel(1,{type:'mouse'});// lostpointercapture only
 assert.deepEqual(m.held,[],'the mouse is no longer counted as down');
 m.down(2,{type:'touch',primary:true});assert.equal(m.up(2),'tap','the touch is alone, so it taps');
 m.down(3,{type:'touch',primary:true});assert.equal(m.up(3),'tap','and again');
 // Same with no event at all for the lost mouse up: its next pointerdown replaces only its own entry.
 const n=map();n.down(1,{type:'mouse'});n.down(1,{type:'mouse'});
 assert.deepEqual(n.held,[1],'one entry per pointerId');assert.equal(n.up(1,{type:'mouse'}),'tap');
});

test('finding 2: a second finger on the map background (or off the map) spoils the first finger\'s tap',()=>{
 // card null: the SVG background, a lane, or anywhere else on the page (the view's cardOf finds no card)
 const m=map();m.down(1,{card:'mini'});m.down(2,{card:null,primary:false});
 assert.equal(m.up(1),null,'first finger released while the second is on the background');
 assert.equal(m.up(2),null);assert.deepEqual(m.held,[]);
 const r=map();r.down(1,{card:'mini'});r.down(2,{card:null});r.up(2);
 assert.equal(r.up(1),null,'still no tap after the background finger left first: the press is dead for good');
 const b=map();b.down(1,{card:null});b.down(2,{card:'mini',primary:false});
 assert.equal(b.up(2),null,'a finger on the background first: the card finger never becomes a candidate');b.up(1);
 b.down(3,{card:'mini',primary:true});assert.equal(b.up(3),'tap','afterwards a lone tap works');
});

test('finding 3: mouse down, touch down, mouse up, then a mouse click while the touch is held selects nothing',()=>{
 const m=map();
 m.down(1,{type:'mouse',primary:true,card:'mini'});m.down(2,{type:'touch',primary:true,card:'nas'});
 assert.equal(m.up(1,{type:'mouse'}),null,'the first mouse click is spoiled by the touch');
 m.down(1,{type:'mouse',primary:true,card:'mini'});
 assert.equal(m.t.press,null,'no candidate: the touch is still down');
 assert.equal(m.up(1,{type:'mouse'}),null,'the second mouse click does not select either');
 assert.deepEqual(m.held,[2],'the held touch is never forgotten');
 assert.equal(m.up(2),null,'nor does the touch, which was never alone');
 m.down(1,{type:'mouse',primary:true});assert.equal(m.up(1,{type:'mouse'}),'tap','with nothing else down a click selects again');
});

test('no reset because a primary pointer arrived: a pointer whose up was lost stays until its id comes down again',()=>{
 const m=map();m.down(1);m.down(2);m.up(1);// pretend the second finger's up was lost
 m.down(5,{primary:true});assert.equal(m.up(5),null,'finger 2 may still be held, so finger 5 is no lone tap');
 assert.deepEqual(m.held,[2]);
 m.down(2,{primary:true});assert.deepEqual(m.held,[2],'its id came down again: only that entry is replaced');assert.equal(m.up(2),'tap');
 // A press whose pointer id comes down again starts over; the other pointer stays.
 const o=map();o.down(1,{type:'mouse'});o.down(2,{type:'touch',primary:true});o.down(1,{type:'mouse'});
 assert.deepEqual(o.held.sort(),[1,2],'re-down of id 1 replaced only id 1; the touch is still held');
 assert.equal(o.up(1,{type:'mouse'}),null,'and it still spoils the click');
});

test('review r4 finding 1: a touch held still for over 30 s is still down, so a mouse click selects nothing',()=>{
 const m=map();m.down(2,{type:'touch',card:'nas'});
 m.wait(30001);m.down(1,{type:'mouse',primary:true,card:'mini'});
 assert.equal(m.t.press,null,'no candidate while the touch is held');
 assert.equal(m.up(1,{type:'mouse'}),null,'the click does not select');
 m.wait(10*60000);m.down(1,{type:'mouse'});assert.equal(m.up(1,{type:'mouse'}),null,'nor ten minutes later');
 assert.deepEqual(m.held,[2],'the touch is never forgotten for being quiet');
 m.up(2);m.down(1,{type:'mouse'});assert.equal(m.up(1,{type:'mouse'}),'tap','once it is up, a click selects');
});

test('review r4 finding 1: a paused mouse drag survives another pointer going down, and still drops',()=>{
 const m=map();m.down(1,{type:'mouse'});m.move(1,100,240,{type:'mouse'});
 m.wait(30001);m.down(2,{type:'touch',card:null,primary:true});
 assert.equal(m.t.press?.id,1,'the drag is still the press');assert.equal(m.t.press.moved,true);
 assert.equal(m.up(2),null);
 assert.equal(m.move(1,100,260,{type:'mouse'})?.id,1,'its moves still count');
 assert.equal(m.up(1,{type:'mouse'}),'drop','and its release saves the drop');assert.deepEqual(m.held,[]);
});

test('trackStale: a mouse event with no button held, or a down reusing an id, forgets that pointer and hands back its press',()=>{
 const ev=(pointerId,pointerType,buttons)=>({pointerId,pointerType,buttons,clientX:0,clientY:0,isPrimary:true,button:0});
 const m=map();m.down(1,{type:'mouse'});m.move(1,100,240,{type:'mouse'});
 assert.equal(trackStale(m.t,ev(1,'mouse',1)),null,'button still held: nothing');
 assert.equal(trackStale(m.t,ev(9,'mouse',0)),null,'an untracked id: nothing');
 const cut=trackStale(m.t,ev(1,'mouse',0));
 assert.equal(cut?.id,1,'the drag is handed back to be undone');assert.equal(cut.moved,true);
 assert.deepEqual(m.held,[]);assert.equal(m.t.press,null);
 m.down(2,{type:'touch',primary:true});assert.equal(m.up(2),'tap','the stale mouse no longer blocks a lone tap');
 for(const type of ['pen','touch']){const n=map();n.down(1,{type});
  assert.equal(trackStale(n.t,ev(1,type,0)),null,`${type}: buttons 0 is not trusted`);assert.deepEqual(n.held,[1]);}
 const r=map();r.down(1,{type:'mouse'});r.move(1,100,240,{type:'mouse'});
 assert.equal(trackStale(r.t,ev(1,'mouse',1),true)?.id,1,'a pointerdown reusing the id cuts the old press off');
 assert.deepEqual(r.held,[]);
 const k=map();k.down(1);k.down(2,{primary:false});
 assert.equal(trackStale(k.t,ev(2,'touch',1),true),null,'a reused id with no press of its own: nothing to undo');
 assert.deepEqual(k.held,[1],'only that id is forgotten');
});

test('window blur or a hidden tab forgets every pointer; the cut-off press never taps',()=>{
 const m=map();m.down(1);m.down(2);
 const cut=m.clear();assert.equal(cut.id,1,'the press that was cut off is handed back (to undo a drag)');
 assert.deepEqual(m.held,[]);assert.equal(m.up(1),null,'its late pointerup does nothing');assert.equal(m.up(2),null);
 m.down(3,{primary:true});assert.equal(m.up(3),'tap','a lone tap afterwards works');
 assert.equal(map().clear(),null,'nothing held, nothing cut off');
});
