// Moving the overview tiles: no mode and no handle (home-view.js wires it to the grid of tiles).
//  - Mouse or pen: the tile comes along once the pointer has travelled a few pixels with the button down.
//  - Finger: the tile has to be held first (a long press). A swipe that starts earlier scrolls the page as
//    always; once the tile is lifted the page stays put and scrolls only when the finger nears an edge.
//  - Keyboard: arrow keys on a focused tile move it one place, Home and End to the ends.
//  - A click that ends a drag is swallowed, so dropping a tile never opens its page. Escape puts it back.
// Where a point lands among the other tiles is plain geometry with no DOM in it (dropAt, orderAfterDrop);
// tests/home-drag.test.mjs covers it and drives the pointer handling on a small DOM.
export const MOUSE_SLOP=6,TOUCH_SLOP=10,HOLD_MS=320,EDGE=72,HELD_SCALE=0.94,HELD_SCALE_SINGLE=0.55;

// Where a tile dropped at (x, y) lands. rects: [{id,left,top,right,bottom}] of every tile but the dragged
// one. The nearest tile decides; single = one column (above / below its middle), else left / right of it.
// → {id, after}, or null when there is no other tile.
export function dropAt(rects,x,y,single=false){
 let best=null,near=Infinity;
 for(const r of rects){const d=Math.hypot(Math.max(r.left-x,0,x-r.right),Math.max(r.top-y,0,y-r.bottom));if(d<near){best=r;near=d;}}
 return best?{id:best.id,after:single?y>(best.top+best.bottom)/2:x>(best.left+best.right)/2}:null;
}
// The list of ids after `id` was dropped before or after `target`. Unknown ids change nothing.
export function orderAfterDrop(ids,id,target,after){
 const rest=ids.filter(x=>x!==id),at=rest.indexOf(target);
 if(at<0||rest.length===ids.length)return [...ids];
 rest.splice(at+(after?1:0),0,id);return rest;
}
// Where a key moves the tile at `index` of `count`: a new index, or null when the key is not for us or the
// tile is already there. Left and up are "earlier", right and down "later".
export function keyTarget(key,index,count){
 const to={ArrowLeft:index-1,ArrowUp:index-1,ArrowRight:index+1,ArrowDown:index+1,Home:0,End:count-1}[key];
 return to===undefined||to<0||to>=count||to===index?null:to;
}

// First-last-invert-play: the nodes glide from where they were to where `change` put them.
// Skipped when the reader asked for less motion, or where there is no layout to measure (tests).
export function flip(nodes,change){
 const still=globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
 const first=still?null:new Map(nodes.filter(n=>n.getBoundingClientRect).map(n=>[n,n.getBoundingClientRect()]));
 change();
 if(!first)return;
 const moved=[];
 for(const [n,a] of first){
  if(!n.isConnected)continue;
  const b=n.getBoundingClientRect(),dx=a.left-b.left,dy=a.top-b.top;if(Math.abs(dx)<1&&Math.abs(dy)<1)continue;
  n.style.transition='none';n.style.transform=`translate(${dx}px,${dy}px)`;moved.push(n);
 }
 if(!moved.length)return;
 void moved[0].offsetWidth;// the inverted position has to be laid out before it is released
 for(const n of moved){
  n.style.transition='transform 220ms cubic-bezier(.2,.8,.2,1)';n.style.transform='';
  const done=()=>{n.style.transition='';n.removeEventListener('transitionend',done);};
  n.addEventListener('transitionend',done);setTimeout(done,300);
 }
}

const tileOf=target=>target?.closest?.('.hv-tile')||null;
const idOf=node=>node.getAttribute('data-id');
// The element that scrolls the page under the grid.
function scrollerOf(node){
 for(let n=node?.parentElement;n&&n!==document.body;n=n.parentElement){
  const o=getComputedStyle(n).overflowY;if((o==='auto'||o==='scroll')&&n.scrollHeight>n.clientHeight)return n;}
 return document.scrollingElement||document.documentElement;
}

// Makes the tiles of `grid` (children with class hv-tile and data-id) movable.
//   enabled()        false = leave everything alone (one tile, or the order cannot be saved)
//   onDrop(ids, id)  the new order, when a drag or a key changed it; the page reorders the tiles in it
//   onEnd()          a drag is over, however it ended (the page may repaint again)
//   clock, timers    for tests
// → {busy(): a tile is held or dragged, destroy()}
export function tileDrag({grid,enabled=()=>true,onDrop=()=>{},onEnd=()=>{},clock=()=>Date.now(),timers=globalThis}){
 const root=globalThis.window||globalThis,off=new AbortController(),on=(node,type,fn,options={})=>node.addEventListener(type,fn,{...options,signal:off.signal});
 let held=null,quietUntil=0;// held: {tile,id,pointer,touch,x0,y0,x,y,active,timer,scroller,top0,single,scale,target,frame,speed}
 const tiles=()=>[...grid.children].filter(n=>n.classList.contains('hv-tile'));
 const order=()=>tiles().map(idOf);
 const unmark=()=>{for(const n of tiles())n.classList.remove('drop-before','drop-after');};
 const scrolled=()=>held.scroller?held.scroller.scrollTop-held.top0:0;

 function place(){
  held.tile.style.transform=`translate(${Math.round(held.x-held.x0)}px,${Math.round(held.y-held.y0+scrolled())}px) scale(${held.scale})`;
  const rects=tiles().filter(n=>n!==held.tile).map(n=>{const r=n.getBoundingClientRect();return {id:idOf(n),left:r.left,top:r.top,right:r.right,bottom:r.bottom};});
  const at=dropAt(rects,held.x,held.y,held.single),now=order();
  unmark();held.target=null;
  if(!at)return;
  const next=orderAfterDrop(now,held.id,at.id,at.after);
  if(next.join()===now.join())return;// dropping here changes nothing: no marker
  held.target=next;tiles().find(n=>idOf(n)===at.id)?.classList.add(at.after?'drop-after':'drop-before');
 }
 function lift(){
  if(!held||held.active)return;
  timers.clearTimeout(held.timer);held.active=true;
  held.single=(globalThis.getComputedStyle?.(grid).gridTemplateColumns||'').trim().split(/\s+/).length<2;
  held.scroller=globalThis.document?.body?scrollerOf(grid):null;held.top0=held.scroller?held.scroller.scrollTop:0;
  // The held tile shrinks around the pointer, so the tiles it could land between stay in view: a little
  // in a grid, a lot in one column, where a tile is about as tall as the screen.
  held.scale=held.single?HELD_SCALE_SINGLE:HELD_SCALE;
  const box=held.tile.getBoundingClientRect();held.tile.style.transformOrigin=`${Math.round(held.x0-box.left)}px ${Math.round(held.y0-box.top)}px`;
  grid.classList.add('sorting');grid.classList.toggle('single',held.single);held.tile.classList.add('dragging');
  try{held.tile.setPointerCapture?.(held.pointer);}catch{}
  try{globalThis.getSelection?.()?.removeAllRanges();}catch{}
  if(held.touch)try{globalThis.navigator?.vibrate?.(8);}catch{}
  place();
 }
 // Near the top or bottom edge of the window the page scrolls under the held tile.
 function edgeScroll(){
  if(!held?.active||!held.scroller||!globalThis.requestAnimationFrame)return;
  const h=globalThis.innerHeight||0,near=held.y<EDGE?held.y-EDGE:held.y>h-EDGE?held.y-(h-EDGE):0;
  held.speed=Math.max(-0.9,Math.min(0.9,near/60));// px per ms: up to 900 px a second at the very edge
  if(!held.speed||held.frame)return;
  let last=0;
  const step=now=>{if(!held?.active||!held.speed){if(held)held.frame=0;return;}
   held.scroller.scrollTop+=held.speed*Math.min(50,last?now-last:16);last=now;place();held.frame=requestAnimationFrame(step);};
  held.frame=requestAnimationFrame(step);
 }
 function release(commit){
  const h=held;if(!h)return;held=null;
  timers.clearTimeout(h.timer);if(h.frame)globalThis.cancelAnimationFrame?.(h.frame);
  if(!h.active)return;
  quietUntil=clock()+450;// the click that this pointer-up produces is not a click on the tile
  const next=commit?h.target:null,all=tiles();
  flip(all,()=>{
   h.tile.classList.remove('dragging');grid.classList.remove('sorting');unmark();h.tile.style.transform='';h.tile.style.transformOrigin='';
   try{h.tile.releasePointerCapture?.(h.pointer);}catch{}
   if(next)onDrop(next,h.id);
  });
  onEnd();
 }

 on(grid,'pointerdown',e=>{
  if(e.isPrimary===false||(e.pointerType==='mouse'&&e.button!==0))return;
  if(held)release(false);// a pointer whose end never arrived (released outside the window)
  const tile=enabled()?tileOf(e.target):null;if(!tile||tile.parentNode!==grid)return;
  held={tile,id:idOf(tile),pointer:e.pointerId,touch:e.pointerType==='touch',x0:e.clientX,y0:e.clientY,x:e.clientX,y:e.clientY,active:false,timer:null,target:null,frame:0,speed:0};
  if(held.touch)held.timer=timers.setTimeout(lift,HOLD_MS);
 });
 on(root,'pointermove',e=>{
  if(!held||e.pointerId!==held.pointer)return;
  held.x=e.clientX;held.y=e.clientY;
  if(!held.active){
   const far=Math.hypot(held.x-held.x0,held.y-held.y0);
   if(held.touch){if(far>TOUCH_SLOP)release(false);return;}// the finger moved before the hold: that is a scroll
   if(far<=MOUSE_SLOP)return;
   lift();
  }
  e.preventDefault?.();place();edgeScroll();
 });
 on(root,'pointerup',e=>{if(held&&e.pointerId===held.pointer)release(true);});
 on(root,'pointercancel',e=>{if(held&&e.pointerId===held.pointer)release(false);});
 on(root,'keydown',e=>{if(e.key==='Escape'&&held?.active){e.preventDefault?.();release(false);}});
 // A lifted tile owns the gesture: the page must not scroll under the finger, and no menu may open.
 on(grid,'touchmove',e=>{if(held?.active&&e.cancelable!==false)e.preventDefault();},{passive:false});
 on(grid,'contextmenu',e=>{if(held?.touch||clock()<quietUntil)e.preventDefault();});
 // The browser's own drag of a link or a picture, and a text selection begun on a tile, would fight ours.
 on(grid,'dragstart',e=>{if(enabled())e.preventDefault();});
 on(grid,'selectstart',e=>{if(held)e.preventDefault();});
 on(grid,'click',e=>{if(clock()<quietUntil){quietUntil=0;e.preventDefault();e.stopPropagation();}},{capture:true});
 on(grid,'keydown',e=>{
  if(held||!enabled()||e.altKey||e.ctrlKey||e.metaKey||e.shiftKey)return;
  const tile=e.target;if(!tile?.classList?.contains('hv-tile')||tile.parentNode!==grid)return;
  const ids=order(),to=keyTarget(e.key,ids.indexOf(idOf(tile)),ids.length);
  if(to===null){if(['ArrowLeft','ArrowUp','ArrowRight','ArrowDown'].includes(e.key))e.preventDefault();return;}// at an end: stay, do not scroll away
  e.preventDefault();
  const id=idOf(tile),next=ids.filter(x=>x!==id);next.splice(to,0,id);
  flip(tiles(),()=>onDrop(next,id));
 });
 return {busy:()=>Boolean(held?.active),destroy:()=>{release(false);off.abort();}};
}
