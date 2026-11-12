// The overview on a small DOM (tests/fixtures/mini-dom.mjs): tiles are moved by dragging them, with no mode
// to switch on (public/home-drag.js), and a machine page draws the local LLM runtimes a provider reported,
// or nothing at all (public/home-telemetry.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {installDom,fire,Element} from './fixtures/mini-dom.mjs';
// The CSSOM a view writes to (a bar's width), as the other UI tests stub it.
if(!('style' in Element.prototype))Object.defineProperty(Element.prototype,'style',{get(){return this._style??={};},set(v){this._style=v;},configurable:true});

const bus=new EventTarget();
globalThis.addEventListener??=bus.addEventListener.bind(bus);
globalThis.dispatchEvent??=bus.dispatchEvent.bind(bus);
const {dropAt,orderAfterDrop,keyTarget,tileDrag,MOUSE_SLOP,TOUCH_SLOP,HOLD_MS}=await import('../public/home-drag.js');
const {runtimesSection,workPanel}=await import('../public/home-telemetry.js');

const rect=(id,left,top)=>({id,left,top,right:left+200,bottom:top+300});

test('where a dropped tile lands: the nearest tile decides, by its middle',()=>{
 // A row of three tiles, "a" is in the hand.
 const row=[rect('b',220,0),rect('c',440,0)];
 assert.deepEqual(dropAt(row,250,150),{id:'b',after:false});assert.deepEqual(dropAt(row,400,150),{id:'b',after:true});
 assert.deepEqual(dropAt(row,435,150),{id:'c',after:false},'in the gap: the nearer tile');assert.deepEqual(dropAt(row,425,150),{id:'b',after:true});assert.deepEqual(dropAt(row,900,150),{id:'c',after:true},'past the end of the row');
 assert.deepEqual(dropAt(row,-50,900),{id:'b',after:false},'outside the grid altogether');
 // Two rows: the row under the pointer wins over a nearer column.
 const rows=[rect('b',220,0),rect('c',0,320),rect('d',220,320)];
 assert.deepEqual(dropAt(rows,90,400),{id:'c',after:false});assert.deepEqual(dropAt(rows,330,610),{id:'d',after:true});
 // One column (a phone): above or below the middle.
 const column=[rect('b',0,320),rect('c',0,640)];
 assert.deepEqual(dropAt(column,180,400,true),{id:'b',after:false});assert.deepEqual(dropAt(column,20,480,true),{id:'b',after:true});assert.deepEqual(dropAt(column,20,2000,true),{id:'c',after:true});
 assert.equal(dropAt([],10,10),null,'a single tile has nowhere to go');
 const ids=['a','b','c','d'];
 assert.deepEqual(orderAfterDrop(ids,'a','c',true),['b','c','a','d']);assert.deepEqual(orderAfterDrop(ids,'d','a',false),['d','a','b','c']);
 assert.deepEqual(orderAfterDrop(ids,'a','b',false),ids,'before its own neighbour: nothing moves');assert.deepEqual(orderAfterDrop(ids,'b','a',true),ids);
 assert.deepEqual(orderAfterDrop(ids,'x','a',true),ids);assert.deepEqual(orderAfterDrop(ids,'a','x',true),ids);
 assert.notEqual(orderAfterDrop(ids,'x','a',true),ids,'always a new list');
 // Keys on a focused tile: left and up are earlier, right and down later, Home and End the ends.
 assert.deepEqual(['ArrowLeft','ArrowUp','ArrowRight','ArrowDown','Home','End'].map(k=>keyTarget(k,2,5)),[1,1,3,3,0,4]);
 assert.deepEqual([keyTarget('ArrowLeft',0,5),keyTarget('ArrowRight',4,5),keyTarget('Home',0,5),keyTarget('End',4,5),keyTarget('Enter',2,5),keyTarget(' ',2,5)],Array(6).fill(null));
});

// A grid of tiles laid out by their place in it; a drop reorders the nodes, as the page does.
function stage({cols=3,ids=['a','b','c','d','e'],enabled=true}={}){
 const {document}=installDom();
 globalThis.getComputedStyle=()=>({gridTemplateColumns:Array(cols).fill('200px').join(' '),overflowY:'visible'});
 const grid=document.createElement('div');grid.setAttribute('class','hv-tiles');document.body.append(grid);
 const tiles=Object.fromEntries(ids.map(id=>{
  const a=document.createElement('a'),inner=document.createElement('span');a.setAttribute('class','hv-tile');a.setAttribute('data-id',id);a.style={};a.append(inner);
  a.getBoundingClientRect=()=>{const i=grid.children.indexOf(a);return rect(id,(i%cols)*220,Math.floor(i/cols)*320);};
  grid.append(a);return [id,a];}));
 const pending=new Map();let clock=1000,seq=0;
 const timers={setTimeout:(fn,ms)=>{pending.set(++seq,{fn,at:clock+ms});return seq;},clearTimeout:id=>pending.delete(id)};
 const tick=ms=>{clock+=ms;for(const [id,job] of [...pending])if(job.at<=clock){pending.delete(id);job.fn();}};
 const drops=[],state={on:enabled,ended:0};
 const drag=tileDrag({grid,enabled:()=>state.on,clock:()=>clock,timers,onEnd:()=>state.ended++,
  onDrop:(order,id)=>{drops.push({order,id});for(const x of order)grid.append(tiles[x]);}});
 const order=()=>grid.children.map(n=>n.getAttribute('data-id')),marks=()=>grid.children.filter(n=>/drop-/.test(n.getAttribute('class'))).map(n=>n.getAttribute('class').replace('hv-tile ',''));
 const at=(type,x,y,more={})=>({pointerId:1,pointerType:type,button:0,isPrimary:true,clientX:x,clientY:y,...more});
 return {grid,tiles,drops,state,drag,tick,order,marks,mouse:(x,y)=>at('mouse',x,y),touch:(x,y)=>at('touch',x,y),inner:id=>tiles[id].children[0]};
}

test('a mouse drags a tile straight away; the click that ends the drag does not open the page',()=>{
 const s=stage();let opened=0;s.tiles.a.addEventListener('click',()=>opened++);
 fire(s.inner('a'),'pointerdown',s.mouse(100,150));
 fire(s.inner('a'),'pointermove',s.mouse(100+MOUSE_SLOP,150));
 assert.equal(s.drag.busy(),false,'a twitch of the hand is not a drag');
 fire(s.inner('a'),'pointermove',s.mouse(560,170));
 assert.equal(s.drag.busy(),true);assert.match(s.tiles.a.getAttribute('class'),/dragging/);assert.match(s.grid.getAttribute('class'),/sorting/);
 assert.equal(s.tiles.a.style.transform,'translate(460px,20px) scale(0.94)','the tile follows the pointer, a little smaller');assert.equal(s.tiles.a.style.transformOrigin,'100px 150px','shrunk around the point it is held by');
 assert.equal(s.tiles.c.getAttribute('class'),'hv-tile drop-after','the landing place is marked');assert.deepEqual(s.marks(),['drop-after']);
 fire(s.grid,'pointermove',s.mouse(470,170));assert.equal(s.tiles.c.getAttribute('class'),'hv-tile drop-before');
 fire(s.grid,'pointermove',s.mouse(560,170));
 fire(s.grid,'pointerup',s.mouse(560,170));
 assert.deepEqual(s.drops,[{order:['b','c','a','d','e'],id:'a'}]);assert.deepEqual(s.order(),['b','c','a','d','e']);
 assert.equal(s.drag.busy(),false);assert.equal(s.tiles.a.getAttribute('class'),'hv-tile');assert.deepEqual(s.marks(),[]);assert.doesNotMatch(s.grid.getAttribute('class'),/sorting/);
 assert.equal(s.state.ended,1);
 const click=fire(s.inner('a'),'click');
 assert.equal(click.defaultPrevented,true,'the link is not followed');assert.equal(opened,0,'and nothing on the tile hears the click');
 assert.equal(fire(s.inner('a'),'click').defaultPrevented,false,'the next click is a click again');assert.equal(opened,1);
});

test('a click without a drag opens the page; a drop that changes nothing saves nothing',()=>{
 const s=stage();
 fire(s.inner('b'),'pointerdown',s.mouse(300,100));fire(s.inner('b'),'pointerup',s.mouse(301,101));
 assert.equal(fire(s.inner('b'),'click').defaultPrevented,false);assert.deepEqual(s.drops,[]);assert.equal(s.state.ended,0);
 // Picked up and put down in its own place: no marker, no save, and still no click.
 fire(s.inner('b'),'pointerdown',s.mouse(300,100));fire(s.inner('b'),'pointermove',s.mouse(250,120));
 assert.equal(s.drag.busy(),true);assert.deepEqual(s.marks(),[],'before its right-hand neighbour is where it already is');
 fire(s.grid,'pointerup',s.mouse(250,120));
 assert.deepEqual(s.drops,[]);assert.deepEqual(s.order(),['a','b','c','d','e']);assert.equal(fire(s.inner('b'),'click').defaultPrevented,true);
 // The right button, and a second finger, start nothing.
 fire(s.inner('b'),'pointerdown',{...s.mouse(300,100),button:2});fire(s.grid,'pointermove',s.mouse(600,100));assert.equal(s.drag.busy(),false);
 fire(s.inner('b'),'pointerdown',{...s.touch(300,100),isPrimary:false});s.tick(HOLD_MS);assert.equal(s.drag.busy(),false);
 // The browser's own drag of the link is refused, so it cannot take the pointer away.
 assert.equal(fire(s.inner('b'),'dragstart').defaultPrevented,true);
});

test('a finger scrolls the page unless it rests on the tile first; a held tile owns the gesture',()=>{
 const s=stage({cols:1});
 // A swipe: the finger moves before the hold is over. The page scrolls, nothing is picked up.
 fire(s.inner('a'),'pointerdown',s.touch(100,150));s.tick(HOLD_MS-50);
 assert.equal(fire(s.inner('a'),'touchmove',{cancelable:true}).defaultPrevented,false,'scrolling is left alone');
 fire(s.inner('a'),'pointermove',s.touch(100,150+TOUCH_SLOP+1));s.tick(HOLD_MS);
 assert.equal(s.drag.busy(),false);fire(s.grid,'pointerup',s.touch(100,300));assert.deepEqual(s.drops,[]);
 // The browser took the touch for a scroll before the hold was over.
 fire(s.inner('a'),'pointerdown',s.touch(100,150));fire(s.grid,'pointercancel',s.touch(100,150));s.tick(HOLD_MS);assert.equal(s.drag.busy(),false);
 // A long press: the tile lifts under a still finger, then follows it.
 fire(s.inner('a'),'pointerdown',s.touch(100,150));fire(s.inner('a'),'pointermove',s.touch(103,152));s.tick(HOLD_MS);
 assert.equal(s.drag.busy(),true);assert.match(s.tiles.a.getAttribute('class'),/dragging/);assert.match(s.grid.getAttribute('class'),/single/,'one column: the marker goes above or below');assert.match(s.tiles.a.style.transform,/scale\(0\.55\)$/,'and the held tile is small enough to see where it goes');
 assert.equal(fire(s.inner('a'),'touchmove',{cancelable:true}).defaultPrevented,true,'the page stays put under a held tile');
 assert.equal(fire(s.inner('a'),'contextmenu').defaultPrevented,true,'no long-press menu');
 fire(s.grid,'pointermove',s.touch(100,820));// below the middle of the third tile (640…940)
 assert.deepEqual(s.marks(),['drop-after']);assert.equal(s.tiles.c.getAttribute('class'),'hv-tile drop-after');
 fire(s.grid,'pointerup',s.touch(100,820));
 assert.deepEqual(s.drops,[{order:['b','c','a','d','e'],id:'a'}]);
 assert.equal(fire(s.inner('a'),'contextmenu').defaultPrevented,true,'the menu that a long press brings up late is refused too');
 // A long press that goes nowhere is not a tap either.
 fire(s.inner('d'),'pointerdown',s.touch(100,1100));s.tick(HOLD_MS);fire(s.grid,'pointerup',s.touch(100,1100));
 assert.equal(s.drops.length,1);assert.equal(fire(s.inner('d'),'click').defaultPrevented,true);
});

test('Escape or a cancelled pointer puts the tile back; the page hears that the drag is over',()=>{
 const s=stage();
 fire(s.inner('a'),'pointerdown',s.mouse(100,150));fire(s.grid,'pointermove',s.mouse(560,170));assert.deepEqual(s.marks(),['drop-after']);
 const key=fire(s.grid,'keydown',{key:'Escape'});
 assert.equal(key.defaultPrevented,true);assert.equal(s.drag.busy(),false);assert.deepEqual(s.drops,[]);assert.deepEqual(s.marks(),[]);assert.equal(s.tiles.a.style.transform,'');assert.equal(s.tiles.a.style.transformOrigin,'');assert.equal(s.state.ended,1);
 fire(s.grid,'pointerup',s.mouse(560,170));assert.deepEqual(s.drops,[],'the button coming up afterwards drops nothing');
 fire(s.inner('a'),'pointerdown',s.mouse(100,150));fire(s.grid,'pointermove',s.mouse(560,170));fire(s.grid,'pointercancel',s.mouse(560,170));
 assert.equal(s.drag.busy(),false);assert.deepEqual(s.drops,[]);assert.equal(s.state.ended,2);
 // A pointer whose end never arrived does not block the next drag.
 fire(s.inner('a'),'pointerdown',s.mouse(100,150));fire(s.inner('e'),'pointerdown',s.mouse(320,400));fire(s.grid,'pointermove',s.mouse(60,100));
 assert.match(s.tiles.e.getAttribute('class'),/dragging/);fire(s.grid,'pointerup',s.mouse(60,100));
 assert.deepEqual(s.drops,[{order:['e','a','b','c','d'],id:'e'}]);
 // Gone with the page: no listener is left behind.
 s.drag.destroy();fire(s.inner('a'),'pointerdown',s.mouse(100,150));fire(s.grid,'pointermove',s.mouse(560,170));assert.equal(s.drag.busy(),false);
});

test('arrow keys on a focused tile move it; without a saved order nothing moves',()=>{
 const s=stage();
 const press=(id,key,more={})=>fire(s.tiles[id],'keydown',{key,...more});
 assert.equal(press('b','ArrowRight').defaultPrevented,true);assert.deepEqual(s.drops.at(-1),{order:['a','c','b','d','e'],id:'b'});
 press('b','ArrowUp');assert.deepEqual(s.order(),['a','b','c','d','e']);
 press('d','Home');assert.deepEqual(s.order(),['d','a','b','c','e']);press('d','End');assert.deepEqual(s.order(),['a','b','c','e','d']);
 const before=s.drops.length;
 assert.equal(press('a','ArrowLeft').defaultPrevented,true,'at the end: stays, and the page does not scroll away');assert.equal(s.drops.length,before);
 assert.equal(press('a','ArrowRight',{ctrlKey:true}).defaultPrevented,false,'shortcuts of the browser are left alone');
 assert.equal(press('a','Enter').defaultPrevented,false,'Enter still opens the page');
 assert.equal(fire(s.inner('a'),'keydown',{key:'ArrowRight'}).defaultPrevented,false,'only the tile itself, not something inside it');
 assert.equal(s.drops.length,before);
 // An account that cannot save an order (or a single tile): tiles are plain links.
 s.state.on=false;
 assert.equal(press('a','ArrowRight').defaultPrevented,false);fire(s.inner('a'),'pointerdown',s.mouse(100,150));fire(s.grid,'pointermove',s.mouse(560,170));
 assert.equal(s.drag.busy(),false);assert.equal(fire(s.inner('a'),'dragstart').defaultPrevented,false);assert.equal(s.drops.length,before);
});

test('the overview has no reorder mode: tiles are wired to the drag, and a move keeps the tiles',async()=>{
 const view=await readFile(new URL('../public/home-view.js',import.meta.url),'utf8'),css=await readFile(new URL('../public/home.css',import.meta.url),'utf8');
 assert.doesNotMatch(view,/Upravit pořadí|reorderTile|orderBar|\bediting=|data-move|dataTransfer/,'no mode, no ↑/↓ buttons, no HTML5 drag');
 assert.match(view,/tileDrag\(\{grid:g,enabled:\(\)=>sortable,onDrop:commit/);
 assert.match(view,/draggable:'false'/,'the link is not dragged by the browser');
 assert.match(view,/if\(dragger\?\.busy\(\)\)return;/,'a refresh never redraws the tiles under a held one');
 assert.doesNotMatch(css,/\.reordering|\.hv-move|\.hv-orderbar/);
 assert.match(css,/\.hv-tiles\.sortable \.hv-tile\{[^}]*user-select:none[^}]*-webkit-touch-callout:none/,'a long press picks the tile up instead of selecting text or opening a preview');
});

// --- machine page: local LLM runtimes -----------------------------------------------------------
const texts=(node,cls)=>{const out=[],visit=n=>{for(const k of n.children||[]){if((k.getAttribute('class')||'').split(' ').includes(cls))out.push(k.textContent);visit(k);}};visit(node);return out;};
const byTag=(node,tag)=>{const out=[],visit=n=>{for(const k of n.children||[]){if(k.tagName===tag)out.push(k);visit(k);}};visit(node);return out;};

test('local LLM runtimes: one compact card per runtime a provider reported, nothing without a provider',()=>{
 installDom();
 assert.equal(runtimesSection({runtimes:null},{staleAfterSeconds:180}),null,'a machine nobody reports on has no section');
 const observedAt=new Date(Date.now()-20000).toISOString();
 const runtimes=[
  {id:'omlx',name:'oMLX',kind:'MLX',status:'running',url:'http://127.0.0.1:8000/',version:'0.32',stats:[{label:'tokens/s',value:'90.7'},{label:'requests',value:'917'}],
   models:[{id:'big',state:'loaded',sizeGb:21.4,contextTokens:262144,ttlRemainingSeconds:600},{id:'idle-a',state:'unloaded',sizeGb:30,contextTokens:null,ttlRemainingSeconds:null},{id:'idle-b',state:'unloaded',sizeGb:null,contextTokens:null,ttlRemainingSeconds:300}]},
  {id:'swap',name:'llama-swap',kind:'',status:'running',url:'http://gpu.example.lan:8081/',version:null,stats:[],models:[{id:'m',state:'unloaded',sizeGb:null,contextTokens:null,ttlRemainingSeconds:null}]},
  {id:'old',name:'Old',kind:'',status:'unknown',url:null,version:null,stats:[],models:[{id:'x',state:'unknown',sizeGb:4,contextTokens:null,ttlRemainingSeconds:null}]},
  {id:'bare',name:'Bare',kind:'',status:'stopped',url:null,version:null,stats:[],models:[]}];
 const node=runtimesSection({runtimes:{source:'a provider',observedAt,runtimes}},{staleAfterSeconds:180},{open:['omlx']});
 const cards=byTag(node,'article');assert.equal(cards.length,4);
 const [omlx,swap,old,bare]=cards;
 assert.equal(byTag(omlx,'h3')[0].textContent,'oMLX');assert.deepEqual(texts(omlx,'hv-status'),['running']);
 assert.deepEqual(texts(omlx,'hv-runtime-meta'),['MLX · 0.32 · :8000'],'what it is, its version and where it listens on its own machine');
 assert.deepEqual(byTag(omlx,'dd').map(n=>n.textContent),['90.7','917']);assert.deepEqual(texts(omlx,'main'),['tokens/s90.7'],'the first figure is the large one');
 assert.deepEqual(texts(omlx,'hv-k'),['1 loaded model']);
 assert.deepEqual(byTag(omlx,'li').map(n=>n.textContent),['big21.4 GB · context 262k · unloads in 10 min','idle-a30 GB','idle-b'],'loaded first; a model that is not loaded has no countdown');
 assert.deepEqual(byTag(omlx,'li').map(n=>n.getAttribute('class')),['on','','']);
 const more=byTag(omlx,'details')[0];assert.equal(byTag(more,'summary')[0].textContent,'2 more models');assert.equal(more.hasAttribute('open'),true,'an opened list stays open across a refresh');assert.equal(more.getAttribute('data-id'),'omlx');
 assert.deepEqual(texts(swap,'hv-runtime-meta'),['gpu.example.lan:8081']);assert.deepEqual(texts(swap,'hv-k'),['no model is loaded']);assert.equal(byTag(swap,'details')[0].hasAttribute('open'),false);assert.equal(byTag(swap,'summary')[0].textContent,'1 model');
 assert.deepEqual(texts(old,'hv-status'),['status unknown']);assert.deepEqual(texts(old,'hv-k'),['Models'],'a runtime that was not heard from is not said to hold nothing');
 assert.deepEqual(texts(bare,'hv-status'),['stopped']);assert.deepEqual(texts(bare,'hv-k'),['no models']);assert.equal(byTag(bare,'dl').length,0);
 const source=texts(node,'hv-source');assert.equal(source.length,1);assert.match(source[0],/^a provider · read \d/);assert.equal(texts(node,'warn').length,0);
 // Older than three minutes: said so, in the warning colour.
 const stale=runtimesSection({runtimes:{source:'a provider',observedAt:new Date(Date.now()-600000).toISOString(),runtimes}},{staleAfterSeconds:180});
 assert.match(texts(stale,'warn')[0],/^a provider · stale · last read /);
 // A provider that is there but reports no runtime on this machine.
 const none=runtimesSection({runtimes:{source:'',observedAt:null,runtimes:[]}},{});
 assert.equal(byTag(none,'article').length,0);assert.deepEqual(texts(none,'hv-note'),['The provider reports no runtime on this machine right now.']);assert.equal(texts(none,'hv-source').length,0);
});

test('what the GPU does: the models at work with their kind and runtime, said plainly when idle or busy with something unwatched',()=>{
 installDom();
 assert.equal(workPanel({work:null}),null,'no runtimes: no such part');
 const since=new Date(Date.now()-185000).toISOString();
 const work={items:[{runtime:'mflux',runtimeName:'mflux',gateways:[],mode:'cli',id:'seedvr2-3b',name:'seedvr2-3b · upscale-seedvr2',kind:'image',active:1,queued:0,since},
  {runtime:'omlx',runtimeName:'oMLX',gateways:['llama-swap'],id:'Qwen3.8-27B-8bit',name:'Qwen3.8-27B-8bit',kind:'llm',active:2,queued:1,since},
  {runtime:'mflux',runtimeName:'mflux',gateways:[],id:'seedvr2-7b',name:'seedvr2-7b',kind:'image',active:0,queued:1,since:null}],active:3,queued:2,watching:['llama-swap','oMLX','mflux'],blind:['mlx-serve']};
 const busy=workPanel({work,quad:{gpu:61.6}});
 assert.equal(busy.getAttribute('class'),'hv-work gen');assert.equal(byTag(busy,'h3')[0].textContent,'The GPU is generating');assert.deepEqual(texts(busy,'hv-work-gpu'),['GPU load 62 %']);
 assert.deepEqual(byTag(busy,'li').map(n=>[n.getAttribute('class'),byTag(n,'b')[0].textContent,byTag(n,'small')[0].textContent]),[
  ['on','seedvr2-3b · upscale-seedvr2','images · diffusion · mflux · generating for 3 min'],
  ['on','Qwen3.8-27B-8bit','LLM · oMLX via llama-swap · generating ×2, the longest for 3 min · 1 queued'],
  ['wait','seedvr2-7b','images · diffusion · mflux · 1 queued']]);
 assert.deepEqual(texts(busy,'hv-work-note'),['Reported by: llama-swap, oMLX, mflux. Cannot tell whether it is generating: mlx-serve.']);
 const quiet={items:[],active:0,queued:0,watching:['llama-swap'],blind:[]};
 const idle=workPanel({work:quiet,quad:{gpu:3}});
 assert.equal(byTag(idle,'h3')[0].textContent,'The GPU is idle');assert.deepEqual(texts(idle,'hv-note'),['No model is generating anything now.']);
 const hot=workPanel({work:quiet,quad:{gpu:80}});
 assert.equal(hot.getAttribute('class'),'hv-work warn');assert.equal(byTag(hot,'h3')[0].textContent,'The GPU is busy, but nothing watched is generating');
 // The top three GPU processes, always; with them the busy-but-unwatched case points at them.
 const gpuProcesses={observedAt:new Date().toISOString(),rows:[{pid:1,name:'Game',percent:71.4},{pid:2,name:'Python',percent:6.25,runtime:'mflux',model:'seedvr2-3b'},{pid:3,name:'Python',percent:2,runtime:'oMLX'},{pid:4,name:'WindowServer',percent:1}]};
 const named=workPanel({work:quiet,quad:{gpu:80},gpuProcesses},{agent:'Thermo'});
 assert.deepEqual(texts(named,'hv-note'),['No watched runtime or tool is generating anything now. The processes below are using the GPU.']);
 const procs=byTag(byTag(named,'ol')[0],'li');
 assert.deepEqual(procs.map(n=>[byTag(n,'b')[0].textContent,byTag(n,'small')[0].textContent,texts(n,'hv-work-pct')[0]]),[['Game','not a watched runtime','71 %'],['Python','seedvr2-3b · mflux','6.3 %'],['Python','oMLX','2 %']],'three, with what each belongs to');
 assert.deepEqual(procs.map(n=>byTag(byTag(n,'span').find(x=>x.getAttribute('class')==='hv-work-bar'),'i')[0].style.width),['71.4%','6.25%','2%'],'the bar is GPU time (100 % = one GPU-second per second)');
 assert.equal(texts(byTag(named,'div').find(x=>x.getAttribute('class')==='hv-work-procs'),'hv-k')[0],'GPU time by process','the rows are named GPU time, not GPU load');
 assert.match(texts(named,'hv-work-note').at(-1),/^From Thermo: time in the GPU queues over the last 5 s, an estimate\. It is not a share of the GPU load above, and the rows can add up to more\. Read /);
 assert.equal(byTag(workPanel({work,quad:{gpu:61.6},gpuProcesses}),'ol').length,1,'also while a model generates');
 assert.equal(texts(workPanel({work:quiet}),'hv-work-gpu').length,0,'without telemetry no GPU figure is made up');
 // The cards say it too: a busy runtime has a chip, a busy model a pulsing row; a tool says "working" / "nothing running".
 const node=runtimesSection({work,quad:{gpu:61.6},runtimes:{source:'a provider',observedAt:new Date().toISOString(),runtimes:[
  {id:'omlx',name:'oMLX',kind:'MLX',status:'running',url:null,version:null,stats:[],activity:{active:2,queued:1},models:[{id:'Qwen3.8-27B-8bit',state:'loaded',active:2,queued:1,since,sizeGb:27.5,contextTokens:null,ttlRemainingSeconds:300}]},
  {id:'mflux',name:'mflux',kind:'MLX · CLI',mode:'cli',status:'stopped',url:null,version:null,stats:[],activity:{active:0,queued:0},models:[]}]}},{staleAfterSeconds:180});
 assert.equal(byTag(node,'section')[0].getAttribute('class'),'hv-work gen','the panel comes first');
 const [omlx,mflux]=byTag(node,'article');
 assert.deepEqual(texts(omlx,'hv-work-chip'),['generating ×2 · 1 queued'],'a runtime says how many, not since when');assert.equal(omlx.getAttribute('class'),'hv-runtime gen');
 assert.deepEqual(byTag(omlx,'li').map(n=>[n.getAttribute('class'),n.textContent]),[['on gen','Qwen3.8-27B-8bitgenerating ×2, the longest for 3 min · 1 queued · 27.5 GB']],'no unload countdown while it works');
 assert.deepEqual([texts(mflux,'hv-status')[0],texts(mflux,'hv-k')[0],texts(mflux,'hv-work-chip').length],['nothing running','no job is running',0]);
});

test('the page promises no runtimes from the telemetry agent, and draws the section only for a provider',async()=>{
 const read=name=>readFile(new URL(`../public/${name}`,import.meta.url),'utf8');
 const view=await read('home-view.js'),telemetry=await read('home-telemetry.js'),en=await read('i18n-en-home.js');
 assert.match(view,/machine\.runtimes\?section\(t\('Lokální LLM runtimy'\),null,runtimesSection\(machine,meta\)\):null/);
 for(const [name,text] of [['home-view.js',view],['home-telemetry.js',telemetry],['i18n-en-home.js',en]]){
  assert.doesNotMatch(text,/potřebuje telemetrického agenta|ohlásí telemetrický agent|doplní telemetrický agent|needs the telemetry agent|filled in here by the telemetry agent/,name);
  assert.doesNotMatch(text,/hv-placeholder|hv-tag/,name);}
 assert.doesNotMatch(await read('home.css'),/hv-placeholder|hv-tag/);
});

// The stack panel of a machine page: an engine has no models of its own, so it lists those of the runtime
// blocks it carries, grouped by runtime; the hardware block says what they hold in memory.
test('stack panel: an engine lists its runtimes\' models by runtime; the hardware block what is in memory',async()=>{
 installDom();
 const {stackPanel,runtimesOn,residentOn,isEngine}=await import('../public/home-view.js');
 const models=(n,loaded=[])=>Array.from({length:n},(_,i)=>({id:`m${i}`,state:loaded.includes(i)?'loaded':'unloaded',sizeGb:loaded.includes(i)?28.8:null}));
 // As a collected descriptor writes it: the layer named ENGINE marks the engines, nothing else does.
 const stack={layers:['INPUT','TOOL','RUNTIME','ENGINE','HARDWARE'],cols:['gguf','mlx','mlx','mlx'],engines:{gguf:'llama.cpp',mlx:'Apple MLX'},blocks:[
  {id:'lswap',layer:1,col0:0,col1:3,title:'llama-swap',service:'llama-swap',models:models(5,[2])},
  {id:'lserver',layer:2,col0:0,col1:0,title:'llama-server',state:'off',models:[]},
  {id:'omlx',layer:2,col0:1,col1:2,title:'oMLX',service:'omlx',models:models(6,[1])},
  {id:'mlxserve',layer:2,col0:3,col1:3,title:'mlx-serve',service:'mlx-serve',models:[{id:'pack',state:'loaded',sizeGb:9.2},{id:'sfx',state:'unloaded',sizeGb:2.1}]},
  {id:'eg',layer:3,col0:0,col1:0,title:'llama.cpp'},{id:'em',layer:3,col0:1,col1:3,title:'Apple MLX'},
  {id:'hw',layer:4,col0:0,col1:3,title:'M5 Ultra',hw:true}]};
 const block=id=>stack.blocks.find(b=>b.id===id);
 assert.ok(isEngine(stack,block('em'))&&!isEngine(stack,block('omlx'))&&!isEngine(stack,block('hw')));
 assert.ok(!isEngine(stack,{...block('lswap'),engine:'mlx'}),'a router marked with its engine family is still a server');
 assert.deepEqual(runtimesOn(stack,block('em')).map(b=>b.id),['omlx','mlxserve'],'the runtimes on it, not the router above them');
 assert.deepEqual(residentOn(stack,block('hw')),{count:2,gb:38,sized:true},'loaded models of the runtimes on its engines, each once');
 const panel=stackPanel({stack},block('em'));
 const groups=byTag(panel,'div').filter(n=>(n.getAttribute('class')||'')==='hv-model-group');
 assert.deepEqual(groups.map(g=>byTag(g,'b')[0].textContent),['oMLX · 6 models, 1 loaded','mlx-serve · 2 models, 1 loaded']);
 assert.deepEqual(byTag(groups[0],'summary').map(n=>n.textContent),['5 more models']);
 assert.ok(!texts(panel,'hv-k').some(x=>/^Models · /.test(x)),'no "Models · 0 none" on an engine');
 assert.deepEqual(texts(panel,'hv-status'),[],'an engine is not a service that runs');
 const hw=stackPanel({stack},block('hw'));
 assert.ok(texts(hw,'hv-v').includes('2 loaded models · 38 GB'));
 // An engine with nothing on it that reports models, and an ordinary runtime block, as before.
 assert.ok(texts(stackPanel({stack},block('eg')),'hv-none').includes('no runtime on it reports models'));
 assert.ok(texts(stackPanel({stack},block('omlx')),'hv-k').includes('Models · 6'));
});
