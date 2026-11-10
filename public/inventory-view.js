// #inventory-map (Inventář → Mapa inventáře): data/knowledge.json as a dependency map and as a table.
// Every signed-in account may read it (GET /api/inventory); editing needs write access. Admins also see
// installed versions and updates from Systémy (GET /api/systems) in the selected card and the entry
// detail; for everyone else that block is simply left out. An inventory with no entries shows what the
// map is for and how to fill it (by hand, from a template, from a file, or by an agent over MCP).
// Secrets are only ever locations (store + item name); the server refuses a file that fails the checker.
// The vocabulary and the fetched document live in inventory-data.js, the entry dialog in
// inventory-entry.js, the table in inventory-table.js; this file is the page and the map.
import {canWrite} from './access.js';
import {t,tp} from './i18n.js';
import {el,onLeave} from './views.js';
import {pageHeader,emptyState} from './ui.js';
import {onSessionReset,currentPrincipal,pageAllowed} from './session-cache.js';
import {load as loadSystems} from './systems-view.js';
import {CATS,CAT_KEYS,DEPS,DEP_HELP,OTHER,catOf,catLabel,kindName,place,store,sitePlace,allPlaces,index,deps,matcher,isExample,
 load,setCurrent,setSystems,systemsDoc,announce} from './inventory-data.js';
import {showDetail,showCreate,showImport,seedTemplate,removeExamples,versionBlock,linkify} from './inventory-entry.js';
import {tableView} from './inventory-table.js';

const TABLE=()=>({sort:'name',dir:'asc',kind:'',place:'',gaps:false});
const state={mapSelected:null,mapMode:'connected',mapStores:false,hidden:new Set(),listOpen:{},query:'',table:TABLE()};
let redraw=null;
// Another account must not see this one's selection or search (session-cache.js; inventory-data.js drops the data).
onSessionReset(()=>{redraw=null;state.mapSelected=null;state.listOpen={};state.query='';state.table=TABLE();document.querySelector('#inv-detail')?.close();});

// Breadth-first over the edges: forward = what it needs, backward = what stops if it fails.
function walk(doc,start,forward,hidden=new Set()){
  const out=[],seen=new Set([start]),edges=new Set(),queue=[[start,0]],all=deps(doc);
  while(queue.length){const [cur,depth]=queue.shift();
    for(const l of all){
      if(hidden.has(l.kind))continue;const [from,to]=forward?[l.from,l.to]:[l.to,l.from];if(from!==cur)continue;
      edges.add(`${l.from}>${l.to}`);if(seen.has(to))continue;seen.add(to);out.push({id:to,depth:depth+1,kind:l.kind,label:l.label});queue.push([to,depth+1]);}}
  return {out,seen,edges};
}

// The numbers on top. onGaps: show the entries that have a gap (the table, filtered).
function stats(doc,gaps,onGaps){
  const count=k=>doc.entries.filter(e=>e.kind===k).length;let located=0,unknown=0;
  for(const e of doc.entries)for(const s of e.secrets||[])s.store==='unknown'?unknown++:located++;
  const tile=([n,label],i)=>{const warn=i>=5&&n,inner=[el('b',{},n),el('span',{},t(label))];
    return warn?el('button',{type:'button',class:'inv-stat amber',title:t('Ukázat záznamy s mezerami'),onclick:onGaps},inner):el('div',{class:'inv-stat'},inner);};
  return el('div',{class:'inv-stats'},[[count('machine'),'Stroje'],[count('runtime'),'Služby'],[count('tool'),'Nástroje'],[count('model-store'),'Úložiště modelů'],[located,'Tajemství dohledaná'],[unknown,'Tajemství nezapsaná'],[gaps.length,'Mezery celkem']].map(tile));
}

// Secret items: each Keychain item or variable listed in a secret store becomes its own map card, kept in
// that store; entries whose secrets name the item link to it instead of to the whole store. Map only.
const refTokens=ref=>(ref||'').split(';').map(t=>t.trim().replace(/\s*\(.*\)$/,'').replace(/\s+in\s+~\S*$/,'')).filter(Boolean);
function withSecretItems(doc){
  const stores=doc.entries.filter(e=>e.kind==='secret-store'),storeFor=new Map(),items=[];
  for(const st of stores){
    const counts={};for(const x of st.secrets||[])counts[x.store]=(counts[x.store]||0)+1;
    const key=Object.keys(counts).sort((a,b)=>counts[b]-counts[a])[0];if(key&&!storeFor.has(key))storeFor.set(key,st.id);
    (st.secrets||[]).forEach((x,i)=>refTokens(x.ref).forEach((t,j)=>items.push({id:`si-${st.id}-${i}-${j}`,kind:'secret-item',category:'secret',virtual:true,store:st.id,machine:st.machine,name:x.what,address:t,depends_on:[{id:st.id,kind:'runs-on',label:'uloženo v'}]})));
  }
  const match=(st,t)=>items.filter(it=>it.store===st&&(it.address===t||t.endsWith('*')&&it.address.startsWith(t.slice(0,-1))));
  const entries=doc.entries.map(e=>{
    if(e.kind==='secret-store'||!e.secrets?.length)return e;
    const add=[],covered=new Set();
    for(const x of e.secrets){const st=storeFor.get(x.store);if(!st)continue;const hit=refTokens(x.ref).flatMap(t=>match(st,t));
      if(hit.length){covered.add(st);for(const it of hit)if(!add.some(a=>a.id===it.id))add.push({id:it.id,kind:'secret',label:x.what});}}
    if(!add.length)return e;
    return {...e,depends_on:[...(e.depends_on||[]).filter(d=>!(d.kind==='secret'&&covered.has(d.id))),...add]};
  });
  return {...doc,entries:[...entries,...items]};
}
// Map: cards coloured by category, arrows for dependencies (arrow points at what is needed; line pattern = kind).
// Columns are by machine or by category. The browser keeps only the order of columns and of cards in each column,
// so hidden, removed or new cards never leave holes or land in the wrong column.
const NS='http://www.w3.org/2000/svg';
function svg(tag,attrs={},...children){const n=document.createElementNS(NS,tag);for(const [k,v] of Object.entries(attrs)){if(k.startsWith('on'))n.addEventListener(k.slice(2),v);else if(v!=null)n.setAttribute(k,v);}for(const c of children.flat(Infinity))if(c!=null&&c!=='')n.append(c instanceof Node?c:document.createTextNode(String(c)));return n;}
const clip=(t,n)=>t&&t.length>n?`${t.slice(0,n-1)}…`:t||'';
// What this browser remembers about the map. v3: column and card order keyed by the column's label, per
// column mode. Later additions (view, zoom, fit, controls) are optional keys of the same object, so a
// layout saved by an older version loads unchanged. A browser that only has the v1 or v2 key keeps its
// spacing, lines and depth choices; those layouts stored card positions, which the map no longer uses.
const LAYOUT_KEY='home-hub.inventory.map.v3',OLDER_KEYS=['home-hub.inventory.map.v2','home-hub.inventory.map.v1'];
export const ZOOM={min:0.4,max:1.6,step:0.1};
function layoutRead(){
  const read=k=>{try{const v=JSON.parse(localStorage.getItem(k)||'null');return v&&typeof v==='object'&&!Array.isArray(v)?v:null;}catch{return null;}};
  const v=read(LAYOUT_KEY);if(v)return v;
  for(const k of OLDER_KEYS){const old=read(k);if(old)return {spacing:old.spacing,lines:old.lines,depth:old.depth};}
  return {};
}
export function layoutLoad(){
  const strings=a=>Array.isArray(a)?a.filter(x=>typeof x==='string').map(x=>x.slice(0,80)).slice(0,300):null;
  const mode=v=>({cols:strings(v?.cols),order:Object.fromEntries(Object.entries(v?.order&&typeof v.order==='object'?v.order:{}).map(([k,a])=>[k.slice(0,40),strings(a)||[]]))});
  const v=layoutRead(),zoom=Number.isFinite(v.zoom)?Math.min(ZOOM.max,Math.max(ZOOM.min,Math.round(v.zoom*10)/10)):1;
  return {spacing:v.spacing==='roomy'?'roomy':'compact',lines:v.lines==='all'?'all':'chain',depth:v.depth==='all'?'all':'direct',columns:v.columns==='category'?'category':'machine',
    together:v.together===true,focus:v.focus===true,secretItems:v.secretItems===true,hiddenCats:Array.isArray(v.hiddenCats)?v.hiddenCats.filter(k=>CAT_KEYS.includes(k)):[],soloPrev:Array.isArray(v.soloPrev)?v.soloPrev.filter(k=>CAT_KEYS.includes(k)):null,
    modes:{machine:mode(v.modes?.machine),category:mode(v.modes?.category)},
    view:v.view==='table'?'table':'map',zoom,fit:v.fit===true,controls:v.controls==='open'||v.controls==='closed'?v.controls:null};
}
function layoutSave(l){try{localStorage.setItem(LAYOUT_KEY,JSON.stringify(l));}catch{}}
// Map columns in their default order: machines (machine card first) or categories (grouped by machine
// inside), then Ostatní for every card that has no column. Each card is in exactly one column; empty ones are left out.
// Machine columns come from the places: the site's own (site.json → inventory.places; column = a column of
// its own under that heading, lane = its cards share the Network ("net") or Outside ("outside") column),
// then one column per machine entry the site did not list. all: every entry of the inventory, for those
// machine columns when `list` is a filtered part of it.
export function columnGroups(list,columns,all=list){
  const places=allPlaces(all),rank=new Map(places.map((p,i)=>[p.id,i]));
  const machineRank=e=>rank.get(e.kind==='machine'?e.id:e.machine)??999;
  const machineCols=[...places.filter(p=>p.column).map(p=>[p.id,p.column]),['net','Síť'],['outside','Mimo dům']];
  const machineCol=e=>e.kind==='network'||sitePlace(e.id)?.lane==='net'?'net':e.kind==='external'||sitePlace(e.id)?.lane==='outside'||sitePlace(e.machine)?.lane==='outside'?'outside':e.kind==='machine'?e.id:e.machine;
  const storeKey=e=>e.store||e.id,order=new Map(list.map((e,i)=>[e.id,i])),at=id=>order.get(id)??-1;
  const [known,keyOf,sort]=columns==='category'
    ?[CATS,catOf,(a,b)=>machineRank(a)-machineRank(b)||at(storeKey(a))-at(storeKey(b))||at(a.id)-at(b.id)]
    :[machineCols,machineCol,(a,b)=>(b.kind==='machine')-(a.kind==='machine')||CAT_KEYS.indexOf(catOf(a))-CAT_KEYS.indexOf(catOf(b))];
  const keys=new Set(known.map(([k])=>k));
  return [...known.map(([k,label])=>({label,cards:list.filter(e=>keyOf(e)===k)})),{label:OTHER,cards:list.filter(e=>!keys.has(keyOf(e)))}]
    .filter(g=>g.cards.length).map(g=>({...g,cards:g.cards.sort(sort)}));
}
// Size of the map in map units: every lane, and every card plus room for its outgoing arrows. Never NaN, so
// one bad position cannot collapse the SVG (an invalid viewBox clips the whole map).
export function mapExtent(points,lanes,{COL,ROW,TOP}){
  const fin=v=>Number.isFinite(v)?v:0;
  return {width:Math.max(fin(lanes)*COL,0,...points.map(p=>fin(p?.x)+W+150)),height:Math.max(TOP+ROW,...points.map(p=>fin(p?.y)+H+24))};
}
const W=180,H=40;
// Pointer gestures on the map: one tracker per map, fed by every pointer on the page (bindMapPointers).
// It records each pointer that is down, by pointerId, whatever its type and wherever it went down. A press on a
// card is the candidate tap only if it is the one and only pointer down; any other pointer going down anywhere
// while the press is held kills the tap for good. Moving past the slop kills it too: touch TOUCH_SLOP screen px
// (a swipe; the page pans natively, see touch-action in inventory.css), mouse and pen DRAG_SLOP map units
// (scale = screen px per map unit) - that is a card drag. Touch never drags. Up, cancel and lost capture
// remove only their own pointer; a press ends with a tap only on its own pointerup while still a tap.
// A pointer is forgotten only on a real signal that it is up, never because it was quiet: a finger held still
// for a minute is still down. The signals: its own up, cancel or lost capture; a pointerdown reusing its id (its
// up was lost; only that id is replaced); for a mouse, any event of it with no button held (trackStale); and
// window blur or a hidden tab, which forget everything. A press cut off this way is handed back to be undone.
export const TOUCH_SLOP=10,DRAG_SLOP=5;
export const pointerTracker=()=>({down:new Map(),press:null});
function forget(t,id){t.down.delete(id);if(t.press?.id===id)t.press=null;}
// pointerdown. card: id of the card under the pointer, or null (background, outside the map). Returns the
// press this pointer started, or null.
export function trackDown(t,ev,card=null){
  forget(t,ev.pointerId);
  if(t.press)t.press.tap=false;
  t.down.set(ev.pointerId,{type:ev.pointerType});
  if(t.down.size===1&&card!=null&&ev.button===0&&ev.isPrimary!==false)
    t.press={id:ev.pointerId,type:ev.pointerType,touch:ev.pointerType==='touch',x:ev.clientX,y:ev.clientY,card,moved:false,tap:true};
  return t.press?.id===ev.pointerId?t.press:null;
}
// pointermove. Returns the press when the move is its pointer's (check press.moved for a drag), else null.
export function trackMove(t,ev,scale=1){
  if(!t.down.has(ev.pointerId))return null;
  const g=t.press;if(g?.id!==ev.pointerId)return null;
  if(!g.moved){const d=Math.abs(ev.clientX-g.x)+Math.abs(ev.clientY-g.y);g.moved=g.touch?d>=TOUCH_SLOP:d/scale>=DRAG_SLOP;if(g.moved)g.tap=false;}
  return g;
}
// Before handling a pointerdown (down=true) or pointermove: is a tracked pointer with this id provably no longer
// the one that went down? A down reusing the id means its up was lost; a mouse event with buttons 0 means that
// mouse is up. Forgets it and returns its press (the caller undoes a drag), else null. Only a mouse is judged by
// buttons; pen and touch are left to their own up, cancel and lost capture.
export function trackStale(t,ev,down=false){
  const p=t.down.get(ev.pointerId);
  if(!p||!(down||p.type==='mouse'&&ev.pointerType==='mouse'&&ev.buttons===0))return null;
  const g=t.press?.id===ev.pointerId?t.press:null;forget(t,ev.pointerId);return g;
}
// pointerup (cancel=false), pointercancel or lostpointercapture (cancel=true). Returns {press,tap,drop} when the
// press's own pointer ended (drop: a mouse or pen drag to save), else null.
export function trackUp(t,ev,cancel=false){
  if(!t.down.has(ev.pointerId))return null;
  const g=t.press;forget(t,ev.pointerId);
  if(g?.id!==ev.pointerId)return null;
  return {press:g,tap:!cancel&&g.tap,drop:!cancel&&!g.touch&&g.moved};
}
// Window blur, tab hidden: no pointer can be trusted to still be down. Returns the press that was cut off.
export function trackClear(t){const g=t.press;t.down.clear();t.press=null;return g;}
// One listener set for the map, on the document in the capture phase so no pointer goes unseen. cardOf(ev):
// card id under the pointer or null; scaleOf(): screen px per map unit. signal: aborting it removes every
// listener (the view's dispose); live(): a backstop that does the same on the first event after it turns false.
// onPress(press), onDrag(press,ev) on each move of a moved mouse/pen press, and onEnd({press,tap,drop}) - also
// for a press cut off by cancel, lost capture, a reused id, a mouse with no button held, blur or a hidden tab.
export function bindMapPointers({doc,win,signal,cardOf,scaleOf,live=()=>true,onPress,onDrag,onEnd}){
  const t=pointerTracker(),off=new AbortController(),opts={capture:true,signal:off.signal};
  if(signal?.aborted)off.abort();else signal?.addEventListener('abort',()=>off.abort(),{once:true,signal:off.signal});
  const on=(target,type,fn,capture=true)=>target.addEventListener(type,ev=>{if(!live())return off.abort();fn(ev);},{...opts,capture});
  const end=r=>{if(r)onEnd(r);};
  const cut=g=>{if(g)onEnd({press:g,tap:false,drop:false});};
  const clear=()=>cut(trackClear(t));
  // The card is read before a cut-off drag is undone: undoing it redraws the map, detaching ev.target.
  on(doc,'pointerdown',ev=>{const card=cardOf(ev);cut(trackStale(t,ev,true));const g=trackDown(t,ev,card);if(g)onPress(g);});
  on(doc,'pointermove',ev=>{cut(trackStale(t,ev));const g=trackMove(t,ev,t.press?.id===ev.pointerId?scaleOf():1);if(g?.moved&&!g.touch)onDrag(g,ev);});
  on(doc,'pointerup',ev=>end(trackUp(t,ev)));
  on(doc,'pointercancel',ev=>end(trackUp(t,ev,true)));
  on(doc,'lostpointercapture',ev=>end(trackUp(t,ev,true)));
  // The window's own blur only: focus moving between elements (a card has tabindex) fires blur too, and a
  // capturing window listener would see it.
  on(win,'blur',ev=>{if(ev.target===win)clear();},false);
  on(doc,'visibilitychange',()=>{if(doc.visibilityState==='hidden')clear();});
  return {tracker:t,stop:()=>off.abort()};
}
function geometry(a,b){
  const ay=a.y+H/2,by=b.y+H/2,acx=a.x+W/2,bcx=b.x+W/2;
  if(Math.abs(bcx-acx)<W*0.75){const sx=Math.max(a.x,b.x)+W,bx=sx+14+Math.min(Math.abs(by-ay)*0.06,22);return {d:`M ${a.x+W} ${ay} C ${bx} ${ay}, ${bx} ${by}, ${b.x+W+2} ${by}`,mx:0.25*sx+0.75*bx,my:(ay+by)/2};}
  const right=bcx>acx,x1=right?a.x+W:a.x,x2=right?b.x-2:b.x+W+2,h=(x2-x1)/2;
  return {d:`M ${x1} ${ay} C ${x1+h} ${ay}, ${x1+h} ${by}, ${x2} ${by}`,mx:x1+h,my:(ay+by)/2};
}
// signal: the map's lifetime; aborting it removes the map's document and window listeners.
// ui: {query(): the search text, onHits(n|null): how many shown cards match it}.
// Returns {node, draw, pickFirst}: pickFirst selects the first card that matches the search.
function map(src,signal,ui={query:()=>'',onHits:()=>{}}){
  const layout=layoutLoad();let doc=src,byId,all;
  const top=el('div',{class:'inv-impact'}),show=el('div',{class:'inv-chips'}),depRow=el('div',{class:'inv-chips'}),arrange=el('div',{class:'inv-chips inv-ticks'}),wrap=el('div',{class:'inv-map-wrap'});
  const legend=el('div',{class:'inv-legend'}),zoomBar=el('div',{class:'inv-zoom',role:'group','aria-label':t('Přiblížení mapy')});
  // Clicking the selected card again clears the highlight; list entries always select.
  const select=id=>{state.mapSelected=id;state.listOpen={};draw();};
  const toggle=id=>select(state.mapSelected===id?null:id);
  const save=()=>{layoutSave(layout);draw();};
  const saved=()=>layout.modes[layout.columns];
  // Pointers: one tracker for the whole map (bindMapPointers); cur is the drawing it acts on. draw() replaces
  // it, and a press that began on an older drawing does nothing. Taps select on every device; only a mouse
  // or pen drags cards (touch swipes scroll the page). The listeners go with `signal`; isConnected is a
  // backstop for a map that was on the page and then dropped without a dispose (seen: it was attached, which
  // the caller does right after map() returns).
  let cur=null,seen=false,firstHit=null;queueMicrotask(()=>{if(wrap.isConnected)seen=true;});
  bindMapPointers({doc:document,win:window,signal,live:()=>wrap.isConnected?(seen=true):!seen,
    cardOf:ev=>{const n=ev.target?.closest?.('.inv-node');return n&&cur?.idOf.get(n)||null;},
    scaleOf:()=>cur?.svgEl.getScreenCTM()?.a||1,
    onPress:p=>{p.view=cur;if(p.touch)return;const members=layout.together?cur.colOf.get(p.card).cards.map(x=>x.id):[p.card];
      Object.assign(p,{members,start:new Map(members.map(id=>[id,{...cur.pos.get(id)}]))});},
    onDrag:(p,ev)=>{const v=cur;if(p.view!==v)return;const k=v.svgEl.getScreenCTM()?.a||1,dx=(ev.clientX-p.x)/k,dy=(ev.clientY-p.y)/k;
      if(!p.dragging){p.dragging=true;for(const id of p.members){const n=v.nodeEls.get(id);n.classList.add('dragging');n.parentNode.append(n);}}
      for(const [id,s] of p.start){const q=v.pos.get(id);q.x=Math.max(0,Math.round(s.x+dx));q.y=Math.max(40,Math.round(s.y+dy));v.nodeEls.get(id).setAttribute('transform',`translate(${q.x} ${q.y})`);}
      v.relink(new Set(p.members));},
    // A swipe or a spoiled click does nothing; a drag cut off by cancel, blur or a hidden tab goes back.
    onEnd:({press:p,tap,drop})=>{if(p.view!==cur)return;if(tap)return toggle(p.card);if(drop)return cur.drop(p.card);if(p.dragging)draw();}});
  let pos=new Map(),shown=[];
  const spacing=()=>({ROW:layout.spacing==='roomy'?66:48,COL:W+(layout.spacing==='roomy'?96:40),TOP:48});
  // Columns in the saved order, cards in the saved order; a card with no saved place goes right after its default neighbour.
  function arranged(list){
    const s=saved(),gs=columnGroups(list,layout.columns,doc.entries);gs.forEach((g,i)=>g.rank=i);
    const ci=g=>{const i=(s.cols||[]).indexOf(g.label);return i<0?1000+g.rank:i;};gs.sort((a,b)=>ci(a)-ci(b));
    for(const g of gs){const rank=new Map((s.order[g.label]||[]).map((id,i)=>[id,i]));if(!rank.size)continue;
      const out=g.cards.filter(e=>rank.has(e.id)).sort((a,b)=>rank.get(a.id)-rank.get(b.id));
      g.cards.forEach((e,i)=>{if(rank.has(e.id))return;const prev=i?g.cards[i-1]:null;out.splice(prev?out.indexOf(prev)+1:0,0,e);});
      g.cards=out;}
    return gs;
  }
  const lay=(gs,COL,ROW,TOP)=>{const p=new Map();gs.forEach((g,i)=>g.cards.forEach((e,r)=>p.set(e.id,{x:i*COL+12,y:TOP+r*ROW})));return {p,lanes:gs.map((g,i)=>({label:g.label,x:i*COL,count:g.cards.length}))};};
  // Put `id` into the full saved order `full` (hidden items included) right before the visible item that now follows it.
  const place_=(full,visible,id)=>{const out=full.filter(x=>x!==id),next=visible[visible.indexOf(id)+1],prev=visible[visible.indexOf(id)-1];
    if(next&&out.includes(next))out.splice(out.indexOf(next),0,id);else if(prev&&out.includes(prev))out.splice(out.indexOf(prev)+1,0,id);else out.push(id);return out;};
  function draw(){
    const {ROW,COL,TOP}=spacing(),hiddenCats=new Set(layout.hiddenCats);
    doc=layout.secretItems?withSecretItems(src):src;({byId}=index(doc));all=deps(doc);
    if(state.mapSelected&&!byId.has(state.mapSelected))state.mapSelected=null;
    const sel=state.mapSelected&&byId.get(state.mapSelected);
    const needs=sel?walk(doc,sel.id,true,state.hidden):{out:[],seen:new Set(),edges:new Set()},breaks=sel?walk(doc,sel.id,false,state.hidden):{out:[],seen:new Set(),edges:new Set()};
    const touches=k=>k.split('>').includes(sel?.id);
    const connected=layout.depth==='all'?{seen:new Set([...needs.seen,...breaks.seen]),edges:new Set([...needs.edges,...breaks.edges])}
      :{seen:new Set([sel?.id,...needs.out.filter(x=>x.depth===1).map(x=>x.id),...breaks.out.filter(x=>x.depth===1).map(x=>x.id)]),edges:new Set([...needs.edges,...breaks.edges].filter(touches))};
    const active=state.mapMode==='needs'?needs:state.mapMode==='impact'?breaks:connected;
    const focus=!!sel&&layout.focus;
    shown=doc.entries.filter(e=>(state.mapStores||!['model-store','skill-store','secret-store'].includes(e.kind))&&!hiddenCats.has(catOf(e))&&(!focus||active.seen.has(e.id)));
    // The search box: cards that match stay lit, the rest fade (a selection's chain wins over it).
    const match=matcher(ui.query()),hits=match?new Set(shown.filter(match).map(e=>e.id)):null;
    // Enter in the search box selects the best match: a card whose name or id has the words, else the first one lit.
    const named=match&&matcher(ui.query(),e=>[e.name,e.id]);
    firstHit=hits?(shown.find(e=>hits.has(e.id)&&named(e))||shown.find(e=>hits.has(e.id)))?.id||null:null;ui.onHits(hits?hits.size:null);
    // Always packed: only visible columns get a lane, and cards stack in their saved order with no gaps.
    const gs=arranged(shown),fresh=lay(gs,COL,ROW,TOP),colOf=new Map(gs.flatMap(g=>g.cards.map(c=>[c.id,g])));
    pos=new Map(shown.map(e=>[e.id,{...(fresh.p.get(e.id)||{x:12,y:TOP})}]));
    const laneList=fresh.lanes;
    const {width,height}=mapExtent([...pos.values()],laneList.length,{COL,ROW,TOP});
    const lanes=laneList.map(l=>[svg('rect',{x:l.x,y:0,width:W+24,height,rx:10,class:l.label==='Mimo dům'||l.label==='SaaS'?'inv-lane outside':'inv-lane'}),svg('text',{x:l.x+12,y:28,class:'inv-lane-label'},clip(t(l.label).toUpperCase(),19)),svg('text',{x:l.x+W+12,y:28,class:'inv-lane-count','text-anchor':'end'},l.count)]);
    // Runs-on is drawn only when columns are categories: in machine columns the column already says it.
    // A highlighted line says which way it goes: need = what the selected card needs, break = what stops with it.
    const edges=[],labels=[],lines=[];
    for(const l of all){
      if(!pos.has(l.from)||!pos.has(l.to)||state.hidden.has(l.kind))continue;
      if(l.kind==='runs-on'&&layout.columns!=='category')continue;
      const key=`${l.from}>${l.to}`,hot=!!sel&&active.edges.has(key)&&active.seen.has(l.from)&&active.seen.has(l.to);
      if(!hot&&(layout.lines==='chain'||l.kind==='runs-on'))continue;
      const way=hot?(state.mapMode==='impact'||(state.mapMode==='connected'&&!needs.edges.has(key))?'break':'need'):'dim';
      const g=geometry(pos.get(l.from),pos.get(l.to)),path=svg('path',{d:g.d,'marker-end':`url(#inv-arrow-${way})`});
      const group=svg('g',{class:`inv-edge ${l.kind} ${hot?`hot ${way}`:''}`},path);
      hot?edges.push(group):edges.unshift(group);
      const label=hot&&l.label&&l.kind!=='runs-on'?svg('text',{x:g.mx,y:g.my+4,class:'inv-edge-label','text-anchor':'middle'},clip(t(l.label),26)):null;
      if(label)labels.push(label);
      lines.push({...l,path,label});
    }
    // Labels of lines that run close together would print over each other: each one moves below the one before it.
    const byY=[...labels].sort((x,y)=>x.getAttribute('y')-y.getAttribute('y'));
    byY.forEach((label,i)=>{for(const prev of byY.slice(0,i))if(Math.abs(prev.getAttribute('x')-label.getAttribute('x'))<120&&label.getAttribute('y')-prev.getAttribute('y')<13)label.setAttribute('y',Number(prev.getAttribute('y'))+13);});
    let svgEl;const nodeEls=new Map(),idOf=new Map();
    const relink=ids=>{for(const l of lines)if(ids.has(l.from)||ids.has(l.to)){const g=geometry(pos.get(l.from),pos.get(l.to));l.path.setAttribute('d',g.d);if(l.label){l.label.setAttribute('x',g.mx);l.label.setAttribute('y',g.my+4);}}};
    // A mouse or pen drag of card `id` was dropped: save where it landed.
    const drop=id=>{
      if(focus)return draw();// focus layouts are temporary
      const s=saved(),g=colOf.get(id);
      if(layout.together){// whole column: reorder columns by where it was dropped
        const xs=new Map(gs.map(c=>[c.label,c===g?pos.get(id).x:fresh.p.get(c.cards[0].id).x])),visible=gs.map(c=>c.label).sort((a,b)=>xs.get(a)-xs.get(b));
        s.cols=place_([...(s.cols||[]),...gs.map(c=>c.label).filter(l=>!(s.cols||[]).includes(l))],visible,g.label);}
      else{// one card: reorder inside its own column by where it was dropped
        const visible=g.cards.map(c=>c.id).sort((a,b)=>pos.get(a).y-pos.get(b).y),known=s.order[g.label]||[];
        s.order[g.label]=place_([...known,...g.cards.map(c=>c.id).filter(x=>!known.includes(x))],visible,id);}
      save();};
    const places=new Map(allPlaces(src.entries).map(p=>[p.id,p]));
    const shortOf=id=>{const p=places.get(id);return p?p.short||(p.source==='machine'?clip(p.label,12):''):'';};
    const nodes=shown.map(e=>{const p=pos.get(e.id),isSel=e.id===sel?.id,cat=catOf(e),hit=!!hits?.has(e.id),on=sel?active.seen.has(e.id):!hits||hit;
      // up = the selected card needs it, down = it stops when the selected card fails.
      const tone=sel&&on&&!isSel?(state.mapMode!=='impact'&&needs.seen.has(e.id)?'up':'down'):'';
      const sub=e.address||e.type||kindName(e.kind),short=layout.columns==='category'&&e.kind!=='machine'?shortOf(e.machine):'',tag=short?`${short} · `:'';
      const node=svg('g',{class:`inv-node cat-${cat} ${on?'on':'dim'} ${isSel?'selected':''} ${sel?state.mapMode:''} ${tone} ${hit?'hit':''}`,transform:`translate(${p.x} ${p.y})`,tabindex:'0',role:'button','aria-pressed':String(isSel),
        'aria-label':`${e.name}, ${catLabel(cat)}. ${isSel?t('Vybráno; dalším stiskem výběr zrušíš.'):t('Stiskem zvýrazníš jeho závislosti.')}${layout.together?` ${t('Tažením posuneš celý sloupec.')}`:''}`,
        onkeydown:ev=>{if(ev.key==='Enter'||ev.key===' '){ev.preventDefault();toggle(e.id);}else if(ev.key==='Escape'&&sel){ev.preventDefault();select(null);}}},// pointers: bindMapPointers in map()
        svg('title',{},`${e.name} · ${catLabel(cat)}${e.address?` · ${e.address}`:''}`),svg('rect',{width:W,height:H,rx:8}),svg('circle',{cx:12,cy:H/2,r:4.5,class:'dot'}),
        svg('text',{x:22,y:17,class:'name'},clip(e.name,21)),svg('text',{x:22,y:31,class:'sub'},clip(tag+sub,24)));
      nodeEls.set(e.id,node);idOf.set(node,e.id);return node;});
    const marker=id=>svg('marker',{id,class:id,viewBox:'0 0 10 10',refX:'9',refY:'5',markerWidth:id.endsWith('dim')?'6':'7',markerHeight:id.endsWith('dim')?'6':'7',orient:'auto'},svg('path',{d:'M 0 0 L 10 5 L 0 10 z'}));
    const scaled=v=>layout.zoom===1?v:Math.round(v*layout.zoom);
    svgEl=svg('svg',{viewBox:`0 0 ${width} ${height}`,width:scaled(width),height:scaled(height),role:'group','aria-label':t('Mapa závislostí'),onclick:ev=>{if(sel&&!ev.target.closest('.inv-node'))select(null);}},
      svg('defs',{},marker('inv-arrow-need'),marker('inv-arrow-break'),marker('inv-arrow-dim')),lanes,edges,nodes,labels);
    cur={svgEl,idOf,nodeEls,pos,colOf,relink,drop};
    wrap.classList.toggle('fit',layout.fit);
    wrap.replaceChildren(svgEl);
    // Lists show the first 5 (direct links come first); the rest open on demand. The panels keep one height.
    const list=(res,empty,key)=>{if(!sel)return el('p',{class:'muted inv-walk-empty'},empty);if(!res.out.length)return el('p',{class:'muted inv-walk-empty'},key==='needs'?t('Zatím nemá zapsané závislosti.'):t('Nic zapsaného na něm nezávisí.'));
      const open=!!state.listOpen?.[key],items=open?res.out:res.out.slice(0,5);
      return [el('ul',{class:'inv-walk'},items.map(x=>el('li',{class:`depth-${Math.min(x.depth,4)}`},el('button',{type:'button',class:'inv-name',title:byId.get(x.id)?.name||x.id,onclick:()=>select(x.id)},el('span',{},byId.get(x.id)?.name||x.id),el('small',{},`${x.depth>1?`${t('nepřímo')} · `:''}${x.label?t(x.label):x.kind==='runs-on'?t('běží na'):DEPS[x.kind]?t(DEPS[x.kind]):x.kind}`))))),
        res.out.length>5?el('button',{type:'button',class:'inv-more','aria-expanded':String(open),onclick:()=>{state.listOpen={...state.listOpen,[key]:!open};draw();}},open?t('Méně'):t('Další {n}',{n:res.out.length-5})):''];};
    const mode=(m,label)=>el('button',{type:'button',class:state.mapMode===m?'active':'','aria-pressed':String(state.mapMode===m),onclick:()=>{state.mapMode=m;draw();}},label);
    // The selected card's key facts: versions (admins), address with clickable URLs, how to log in, which secrets and where, notes.
    const facts=e=>{if(!e)return '';const rows=[];
      if(e.address)rows.push([t('Adresa'),linkify(e.address),e.address]);
      if(e.login)rows.push([t('Jak se přihlásit'),e.login,e.login]);
      if(e.secrets?.length){const text=e.secrets.map(x=>`${x.what} · ${store(x.store)[0]}${x.ref?` · ${x.ref}`:''}`).join('; ');rows.push([t('Tajemství · {n}',{n:e.secrets.length}),text,text]);}
      return el('div',{class:'inv-facts'},versionBlock(e),el('dl',{},rows.map(([k,v,tip])=>[el('dt',{},k),el('dd',{title:tip},v)])),e.notes?el('p',{class:'inv-notes',title:e.notes},e.notes):'');};
    top.replaceChildren(el('div',{class:`inv-card inv-selected${sel?` cat-${catOf(sel)}`:''}`},el('span',{class:'eyebrow'},t('VYBRÁNO')),
        sel?[el('h2',{title:sel.name},el('span',{class:'inv-swatch','aria-hidden':'true'}),sel.name),el('p',{class:'muted'},`${place(sel)} · ${catLabel(catOf(sel))}${sel.version?` · ${sel.version}`:''}`),facts(sel)]:[el('h2',{class:'muted'},t('Nic není vybráno')),el('p',{class:'muted'},systemsDoc()?t('Klikni na kartu: ukáže se adresa, přihlášení, tajemství a nainstalovaná verze a zvýrazní se, s čím souvisí. Dalším klikem výběr zrušíš.'):t('Klikni na kartu: ukáže se adresa, přihlášení, tajemství a zvýrazní se, s čím souvisí. Dalším klikem výběr zrušíš.'))],
        el('div',{class:'inv-sel-actions'},el('div',{class:'inv-mode',role:'group','aria-label':t('Zvýraznit na mapě')},mode('connected',t('Souvisí')),mode('needs',t('Potřebuje')),mode('impact',t('Rozbije'))),
          el('button',{type:'button',class:'inv-btn',...(sel?{onclick:()=>showDetail(src,sel.virtual?sel.store:sel.id)}:{disabled:''})},sel?.virtual?t('Otevřít úložiště'):t('Otevřít záznam')))),
      el('div',{class:'inv-card inv-needs'},el('span',{class:'eyebrow'},`${t('POTŘEBUJE')}${sel?` · ${needs.out.length}`:''}`),list(needs,t('Tady bude, co vybraná karta potřebuje.'),'needs')),
      el('div',{class:'inv-card inv-breaks'},el('span',{class:'eyebrow'},`${t('KDYŽ SELŽE, ZASTAVÍ SE')}${sel?` · ${breaks.out.length}`:''}`),list(breaks,t('Tady bude, co se zastaví, když selže.'),'breaks')));
    const chip=(label,on,fn,extra='')=>el('button',{type:'button',class:`inv-chip ${on?'on':''} ${extra}`,'aria-pressed':String(on),onclick:fn},label);
    const base=doc.entries.filter(e=>state.mapStores||!['model-store','skill-store','secret-store'].includes(e.kind));
    // Category chips cycle: shown → only this one → hidden (the others come back as they were) → shown.
    const cats=CATS.filter(([k])=>base.some(e=>catOf(e)===k)),keys=cats.map(([k])=>k),visible=keys.filter(k=>!hiddenCats.has(k));
    const stepOf=k=>hiddenCats.has(k)?'off':visible.length===1&&visible[0]===k&&keys.length>1?'solo':'on';
    const step=k=>{const now=stepOf(k);
      if(now==='on'){layout.soloPrev=layout.hiddenCats.filter(x=>x!==k);layout.hiddenCats=keys.filter(x=>x!==k);}
      else if(now==='solo'){layout.hiddenCats=[...new Set([...(layout.soloPrev||[]),k])];layout.soloPrev=null;}
      else layout.hiddenCats=layout.hiddenCats.filter(x=>x!==k);
      save();};
    const next={on:l=>t('Klikni: jen {category}',{category:l}),solo:l=>t('Klikni: skrýt {category} a vrátit ostatní',{category:l}),off:l=>t('Klikni: znovu ukázat {category}',{category:l})};
    show.replaceChildren(el('span',{class:'inv-chip-title'},t('Ukázat')),
      ...cats.map(([k,cs])=>{const st=stepOf(k),l=t(cs);return el('button',{type:'button',class:`inv-chip inv-cat cat-${k} ${st==='off'?'off':''} ${st==='solo'?'solo':''}`,'aria-pressed':String(st!=='off'),title:next[st](l),onclick:()=>step(k)},
        el('span',{class:'inv-swatch'}),`${l} · ${base.filter(e=>catOf(e)===k).length}`,st==='solo'?el('span',{class:'inv-only'},t('jen')):'');}),
      layout.hiddenCats.length?el('button',{type:'button',class:'inv-more inv-show-all',onclick:()=>{layout.hiddenCats=[];layout.soloPrev=null;save();}},t('Ukázat vše')):'',
      el('span',{class:'inv-chip-gap'}),
      chip(t('Úložiště (modely, skilly, tajemství)'),state.mapStores,()=>{state.mapStores=!state.mapStores;draw();}),
      chip(t('Položky tajemství'),layout.secretItems,()=>{layout.secretItems=!layout.secretItems;save();}));
    const sample=k=>svg('svg',{width:26,height:8,class:'inv-sample','aria-hidden':'true'},svg('line',{x1:0,y1:4,x2:26,y2:4,class:k}));
    depRow.replaceChildren(el('span',{class:'inv-chip-title'},t('Závislosti')),
      ...Object.entries(DEPS).map(([k,l])=>{const off=state.hidden.has(k);return el('button',{type:'button',class:`inv-chip ${off?'off':''}`,'aria-pressed':String(!off),title:t(DEP_HELP[k]),onclick:()=>{off?state.hidden.delete(k):state.hidden.add(k);draw();}},sample(k),t(l));}),
      el('span',{class:'inv-chip-gap'}),
      state.mapMode==='connected'?chip(t('I nepřímé'),layout.depth==='all',()=>{layout.depth=layout.depth==='all'?'direct':'all';save();}):'',
      chip(t('Jen související karty'),layout.focus,()=>{layout.focus=!layout.focus;save();}),
      chip(t('Všechny vazby'),layout.lines==='all',()=>{layout.lines=layout.lines==='all'?'chain':'all';save();}));
    const custom=!!saved().cols||Object.values(saved().order).some(a=>a.length);
    const cols=(m,label)=>el('button',{type:'button',class:layout.columns===m?'active':'','aria-pressed':String(layout.columns===m),onclick:()=>{layout.columns=m;save();}},label);
    arrange.replaceChildren(el('span',{class:'inv-chip-title'},t('Sloupce')),el('div',{class:'inv-mode inv-cols',role:'group','aria-label':t('Sloupce')},cols('machine',t('Podle stroje')),cols('category',t('Podle kategorie'))),
      el('span',{class:'inv-chip-gap'}),
      chip(t('Posouvat celý sloupec'),layout.together,()=>{layout.together=!layout.together;save();}),
      el('button',{type:'button',class:'inv-chip',...(custom?{}:{disabled:''}),onclick:()=>{saved().cols=null;saved().order={};save();}},t('Výchozí pořadí')),
      chip(t('Volnější rozestupy'),layout.spacing==='roomy',()=>{layout.spacing=layout.spacing==='roomy'?'compact':'roomy';save();}),
      el('small',{class:'muted'},[layout.together?t('Tažením karty nahoru nebo dolů změníš pořadí ve sloupci; tažením do strany posuneš celý sloupec.'):t('Tažením karty nahoru nebo dolů změníš pořadí ve sloupci.'),layout.columns==='category'?t('Každá karta říká, na kterém stroji běží.'):t('Každý stroj má svůj sloupec.'),t('Uloženo v tomto prohlížeči.')].join(' ')));
    // Mini legend: what the colours and the line patterns mean, and which way the arrows point.
    const key=(mark,label)=>el('span',{class:'inv-key'},mark,label);
    legend.replaceChildren(
      ...cats.filter(([k])=>!hiddenCats.has(k)).map(([k,cs])=>key(el('span',{class:`inv-swatch cat-${k}`}),t(cs))),
      el('span',{class:'inv-legend-gap'}),
      ...Object.entries(DEPS).filter(([k])=>!state.hidden.has(k)&&(k!=='runs-on'||layout.columns==='category')).map(([k,l])=>key(sample(k),t(l))),
      el('span',{class:'inv-legend-gap'}),
      ...(sel?[key(el('span',{class:'inv-tone need'}),t('potřebuje')),key(el('span',{class:'inv-tone break'}),t('zastaví se'))]:[key(el('span',{class:'inv-arrow','aria-hidden':'true'},'→'),t('šipka míří na to, co je potřeba'))]));
    const zoomTo=z=>{layout.zoom=Math.min(ZOOM.max,Math.max(ZOOM.min,Math.round(z*10)/10));layout.fit=false;save();};
    const zb=(label,title,fn,extra={})=>el('button',{type:'button',class:'inv-zoom-btn',title,'aria-label':title,onclick:fn,...extra},label);
    zoomBar.replaceChildren(
      zb('−',t('Oddálit'),()=>zoomTo(layout.zoom-ZOOM.step),layout.zoom<=ZOOM.min&&!layout.fit?{disabled:''}:{}),
      zb(layout.fit?t('šířka'):`${Math.round(layout.zoom*100)} %`,t('Skutečná velikost'),()=>zoomTo(1),{class:'inv-zoom-btn inv-zoom-v'}),
      zb('+',t('Přiblížit'),()=>zoomTo(layout.zoom+ZOOM.step),layout.zoom>=ZOOM.max&&!layout.fit?{disabled:''}:{}),
      zb(t('Přizpůsobit šířce'),t('Zmenší mapu tak, aby se vešla na šířku'),()=>{layout.fit=!layout.fit;save();},{class:`inv-zoom-btn inv-zoom-fit${layout.fit?' on':''}`,'aria-pressed':String(layout.fit)}));
  }
  draw();
  // The three rows of switches fold away: open on a wide screen, closed on a phone, then as the person left them.
  const narrow=globalThis.matchMedia?.('(max-width: 900px)')?.matches===true,openNow=layout.controls?layout.controls==='open':!narrow;
  const controls=el('details',{class:'inv-controls',...(openNow?{open:''}:{}),ontoggle:()=>{layout.controls=controls.open?'open':'closed';layoutSave(layout);}},
    el('summary',{},el('span',{class:'inv-chip-title'},t('Zobrazení mapy')),el('small',{class:'muted'},t('co ukázat, které vazby, sloupce'))),show,depRow,arrange);
  return {node:el('div',{class:'inv-map'},top,controls,el('div',{class:'inv-map-bar'},legend,zoomBar),wrap),draw,
    pickFirst:()=>{if(firstHit)select(firstHit);}};
}

// The prompt a person hands to their coding agent to fill an empty inventory over MCP.
export const INVENTORY_PROMPT=()=>t('Zmapuj moje stroje a služby a zapiš je do inventáře Home Hubu přes MCP (server „home-hub“, scope inventory:write).\n1. Zavolej inventory_describe: zjistíš schéma, druhy záznamů, místa, úložiště tajemství a pravidla kontroly.\n2. Projdi stroje, ke kterým máš přístup, a zjisti, co na nich běží: služby s portem, plánované úlohy, nástroje, úložiště modelů a vnější služby, na kterých závisí.\n3. U každé věci nejdřív zavolej inventory_search, ať nezaložíš nic dvakrát. Pak ji ulož přes inventory_update (u existujícího záznamu předej jako base otisk z inventory_get), nebo víc záznamů naráz přes inventory_bulk_upsert (nejdřív s dryRun: true). Každý záznam má mít kind, machine, address, version a depends_on.\n4. Nejdřív stroje (kind machine) a síť, potom to, co na nich běží.\n5. U hesel, tokenů a klíčů zapiš jen to, kde jsou uložené (store a název položky), nikdy jejich hodnotu.\nNakonec vypiš, co se ti nepodařilo ověřit.');

// What the page shows while the inventory has no entries: what the map is, what to record and how.
function emptyInventory(){
  const status=el('p',{class:'inv-form-status inv-empty-status',role:'status'});
  const seed=async()=>{status.textContent=t('Zakládám ukázkové záznamy…');
    try{const r=await seedTemplate();if(r.ok)return announce();status.textContent=[t(r.message),...(r.details||[])].join(' ');}catch{status.textContent=t('Home Hub není dosažitelný. Zkus to znovu.');}};
  return el('div',{class:'inv-empty-wrap'},emptyState({icon:'◈',title:t('Mapa inventáře je zatím prázdná'),
    body:t('Mapa je jedno místo, kde je zapsané, co doma běží: stroje, služby a nástroje na nich, vnější služby, co na čem závisí a kde je uložené každé tajemství. Nikdy jeho hodnota, jen místo, kde ho najdeš. Zapisovat může člověk i agent a každou změnu zkontroluje stejná kontrola.'),
    steps:[t('Zapiš stroje (druh machine) a síťové prvky (network).'),
      t('Ke každému stroji přidej, co na něm běží: služby (runtime) s adresou a verzí, nástroje (tool), úložiště modelů.'),
      t('Propoj je závislostmi (depends_on) a u přihlašovacích údajů zapiš, kde jsou uložené.'),
      t('Nejrychleji to udělá agent: v Uživatelé a API založ servisní účet se scope inventory:write, připoj ho přes MCP a dej mu zadání níže.')],
    agentPrompt:INVENTORY_PROMPT(),mcpSnippet:true,
    actions:canWrite()?[{label:t('Začít ze šablony'),onclick:seed,primary:true},{label:t('Přidat první záznam'),onclick:()=>showCreate({kind:'machine'})},{label:t('Import z JSON'),onclick:showImport},{label:t('Uživatelé a API'),href:'#access'}]
      :[]}),
    canWrite()?el('p',{class:'muted inv-empty-note'},t('Šablona založí šest ukázkových záznamů (router, server, tři věci na něm a vnější službu), které pak upravíš nebo smažeš.')):el('p',{class:'muted inv-empty-note'},t('Tvůj účet může jen číst. Záznamy přidá někdo s právem zápisu, nebo agent.')),
    status);
}

// me: the /api/me document. The version block needs what #versions needs (admin); others never fetch it.
// Lifetime: the shell's leaveView() (navigation, re-render, sign-in) disposes the view, which removes the map's
// document/window listeners. A load that finishes after that draws and binds nothing. Each map drawn here
// disposes the one before it.
export function inventoryView(me){
  const loading=()=>el('p',{class:'inv-loading',role:'status'},t('Načítám inventář…'));
  const body=el('div',{class:'inv-body'},loading());
  const who=currentPrincipal(),life=new AbortController();let mapLife=null;
  onLeave(()=>{life.abort();mapLife?.abort();});
  const show=({doc,gaps})=>{if(life.signal.aborted)return;mapLife?.abort();mapLife=null;setCurrent(doc);
    if(!doc.entries.length){redraw=null;return body.replaceChildren(emptyInventory());}
    const layout=layoutLoad(),host=el('div',{class:'inv-view'}),hits=el('span',{class:'inv-count',role:'status'});
    let api=null;
    const mount=()=>{mapLife?.abort();mapLife=null;hits.textContent='';
      if(layout.view==='table'){const table=tableView({doc,state:state.table,query:()=>state.query,onOpen:id=>showDetail(doc,id)});api=null;redraw=table.redraw;host.replaceChildren(table.node);}
      else{mapLife=new AbortController();api=map(doc,mapLife.signal,{query:()=>state.query,onHits:n=>{hits.textContent=n==null?'':tp(n,'{n} shoda|{n} shody|{n} shod');}});redraw=api.draw;host.replaceChildren(api.node);}
      for(const b of tabs.children){const on=b.getAttribute('data-view')===layout.view;b.classList.toggle('active',on);b.setAttribute('aria-pressed',String(on));}};
    const setView=v=>{if(layout.view===v)return;const l=layoutLoad();l.view=layout.view=v;layoutSave(l);mount();};
    const tab=(v,label)=>el('button',{type:'button','data-view':v,onclick:()=>setView(v)},label);
    const tabs=el('div',{class:'inv-mode inv-tabs',role:'group','aria-label':t('Zobrazení')},tab('map',t('Mapa')),tab('table',t('Tabulka')));
    const search=el('input',{type:'search',class:'inv-search',placeholder:t('Hledat název, adresu, stroj, druh…'),'aria-label':t('Hledat v inventáři'),
      oninput:()=>{state.query=search.value;redraw?.();},onkeydown:ev=>{if(ev.key==='Enter'){ev.preventDefault();api?.pickFirst();}else if(ev.key==='Escape'&&search.value){search.value='';state.query='';redraw?.();}}});
    search.value=state.query;
    const examples=doc.entries.filter(isExample),note=el('span',{role:'status'});
    const clearExamples=el('button',{type:'button',class:'inv-btn small',onclick:async()=>{clearExamples.disabled=true;note.textContent=t('Mažu ukázky…');
      try{const r=await removeExamples();if(r.kept.length)note.textContent=t('Tyhle ukázky zůstaly, protože na nich ještě něco závisí: {ids}.',{ids:r.kept.join(', ')});announce();}
      catch{note.textContent=t('Home Hub není dosažitelný. Zkus to znovu.');clearExamples.disabled=false;}}},t('Smazat ukázky'));
    body.replaceChildren(...[
      stats(doc,gaps,()=>{state.table.gaps=true;if(layout.view==='table')mount();else setView('table');}),
      el('div',{class:'inv-toolbar'},search,hits,el('span',{class:'inv-toolbar-gap'}),tabs,
        canWrite()?el('button',{type:'button',class:'inv-btn primary',onclick:()=>showCreate()},t('+ Nový záznam')):null,
        canWrite()?el('button',{type:'button',class:'inv-btn',onclick:showImport},t('Import')):null,
        el('a',{class:'inv-btn',href:'/api/inventory/export',download:''},'Export JSON')),
      examples.length?el('div',{class:'inv-banner'},el('span',{},tp(examples.length,'V inventáři je {n} ukázkový záznam. Uprav ho podle sebe, nebo ho smaž.|V inventáři jsou {n} ukázkové záznamy. Uprav je podle sebe, nebo je smaž.|V inventáři je {n} ukázkových záznamů. Uprav je podle sebe, nebo je smaž.'),' ',note),canWrite()?clearExamples:null):null,
      host,
      el('p',{class:'muted inv-source-note'},t('Zdroj: data/knowledge.json · aktualizováno {when} · každou změnu kontroluje stejný checker, ať ji udělá člověk, nebo agent.',{when:doc.updated_at||'—'}))].filter(Boolean));
    mount();};
  const fail=e=>{if(life.signal.aborted)return;redraw=null;
    body.replaceChildren(emptyState({icon:'⚠',title:t('Inventář se nepodařilo načíst'),body:t(e.message),actions:[{label:t('Zkusit znovu'),onclick:()=>{body.replaceChildren(loading());load().then(show).catch(fail);},primary:true}]}));};
  load().then(show).catch(fail);
  if(pageAllowed('versions',me))loadSystems().then(d=>{if(who!==currentPrincipal()||life.signal.aborted)return;setSystems(d);if(body.isConnected)redraw?.();}).catch(()=>{});
  return el('div',{class:'inv-page'},pageHeader({eyebrow:t('Inventář'),title:t('Mapa inventáře'),lead:t('Co běží kde, jak se přihlásit, kde je které tajemství a co na čem závisí.')}),body);
}
// Page entry for the shell (app.js): every page module exports (context) => Node, and the server's UI
// manifest names it. context = {me, page, sub, machine, site}.
export const inventoryPage=({me})=>inventoryView(me);
