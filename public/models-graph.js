// The wiring diagram of the LLM & Diffusion page, drawn on a canvas from GET /api/models → graph (built in
// server/models-data.mjs → buildGraph, never here). Lanes are machines, columns are the stages a request goes
// through: client → front door (llama-swap, a gateway) → engine → model. A line's width follows the requests in
// the selected range; particles move along it only for traffic of the last few minutes, faster and denser the
// more there is. Idle lines stay faint and still. A request from a client on one machine to a runtime on
// another crosses lanes and is drawn dashed in its own colour.
//   wiringDiagram({onSelect}) → {node, update(graph, {selected}), destroy()}
// Hover or tap a node or a line to light its path and read its numbers below the canvas; click (Enter) a model,
// runtime or client to filter the tables. Arrow keys move between nodes, Escape clears. Colours are read from
// the design tokens on every draw and again on themechange; prefers-reduced-motion draws no particles.
import {el} from './views.js';
import {t,tp,locale} from './i18n.js';
import {timeZone} from './site.js';

const COLUMNS=['client','door','engine','model'];
const COLUMN_TITLE={client:'Klienti',door:'Vstupní brána',engine:'Engine',model:'Modely'};
const KIND_TOKEN={llm:'--md-llm',embedding:'--md-embedding',image:'--md-image',video:'--md-video',music:'--md-music',audio:'--md-audio',other:'--md-other'};
const ROW=28,BOX=22,HEAD=26,LANE_TOP=24,LANE_PAD=10,MIN_WIDTH=760;
const reduced=()=>globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches===true;
const css=name=>{try{return getComputedStyle(document.documentElement).getPropertyValue(name).trim();}catch{return '';}};
const rgba=(color,a)=>{const m=/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);return m?`rgba(${parseInt(m[1],16)},${parseInt(m[2],16)},${parseInt(m[3],16)},${a})`:color;};
// A model's id without its organisation prefix, for the box; the readout keeps the whole id.
const shortName=id=>String(id).split('/').pop().split('--').pop();
const fmt=n=>new Intl.NumberFormat(locale(),{notation:n>=10000?'compact':'standard',maximumFractionDigits:1}).format(n||0);
const when=iso=>iso?new Intl.DateTimeFormat(locale(),{day:'numeric',month:'numeric',hour:'2-digit',minute:'2-digit',timeZone:timeZone()}).format(new Date(iso)):'—';
function palette(){
 const p={text:css('--color-text')||'#eceaf4',dim:css('--color-text-dim')||'#a39fb5',faint:css('--color-text-faint')||'#6f6b82',border:css('--color-border')||'#2b2937',strong:css('--color-border-strong')||'#403d52',
  surface:css('--color-surface')||'#14131c',sunken:css('--color-surface-sunken')||'#100f17',raised:css('--color-surface-raised')||'#1a1924',bad:css('--color-bad')||'#ff7a85',good:css('--color-good')||'#5fd39a',
  focus:css('--color-focus')||'#9d8cff',flow:css('--md-flow')||'#ffb27a',cross:css('--md-cross')||'#b9a8ff',sans:css('--font-sans')||'system-ui, sans-serif',mono:css('--font-mono')||'ui-monospace, monospace',kinds:{}};
 for(const [k,v] of Object.entries(KIND_TOKEN))p.kinds[k]=css(v)||'#9a96aa';
 return p;
}
function cubic(e,t){const u=1-t;return [u*u*u*e.x1+3*u*u*t*e.c1x+3*u*t*t*e.c2x+t*t*t*e.x2,u*u*u*e.y1+3*u*u*t*e.y1+3*u*t*t*e.y2+t*t*t*e.y2];}

// Positions for every node and edge at a given width. Lane order: clients of unknown machines first, then the
// machines as the server listed them.
export function layout(graph,width=MIN_WIDTH){
 const W=Math.max(MIN_WIDTH,Math.floor(width)),lanes=[...graph.lanes].sort((a,b)=>(a.id==='unknown'?-1:0)-(b.id==='unknown'?-1:0));
 const widths={client:150,door:130,engine:150,model:0};const fixed=widths.client+widths.door+widths.engine,gap=Math.max(36,Math.min(110,(W-24-fixed-200)/3));
 widths.model=Math.max(200,W-24-fixed-3*gap);
 const x={client:12};x.door=x.client+widths.client+gap;x.engine=x.door+widths.door+gap;x.model=x.engine+widths.engine+gap;
 const order={client:(a,b)=>(b.attributed===true)-(a.attributed===true)||b.requests-a.requests||a.label.localeCompare(b.label),
  door:(a,b)=>b.requests-a.requests||a.label.localeCompare(b.label),engine:(a,b)=>(a.known===true)-(b.known===true)||b.requests-a.requests||a.label.localeCompare(b.label),
  model:(a,b)=>(b.state==='loaded')-(a.state==='loaded')||b.requests-a.requests||a.label.localeCompare(b.label)};
 const boxes=new Map(),bands=[];let y=HEAD;
 for(const lane of lanes){
  const cols=Object.fromEntries(COLUMNS.map(c=>[c,graph.nodes.filter(n=>n.lane===lane.id&&n.column===c).sort(order[c])]));
  const rows=Math.max(1,...COLUMNS.map(c=>cols[c].length)),h=LANE_TOP+rows*ROW+LANE_PAD;
  for(const c of COLUMNS)cols[c].forEach((n,i)=>{const top=y+LANE_TOP+(rows-cols[c].length)*ROW/2+i*ROW;boxes.set(n.id,{x:x[c],y:top,w:widths[c],h:BOX,node:n});});
  bands.push({lane,y,h});y+=h;
 }
 const edges=graph.edges.filter(e=>boxes.has(e.from)&&boxes.has(e.to)).map(e=>{const a=boxes.get(e.from),b=boxes.get(e.to);
  const x1=a.x+a.w,y1=a.y+BOX/2,x2=b.x,y2=b.y+BOX/2,dx=Math.max(30,(x2-x1)*0.5);return {...e,x1,y1,x2,y2,c1x:x1+dx,c2x:x2-dx};});
 return {width:W,height:y+8,x,widths,bands,boxes,edges};
}
// Every edge on a path through a node (upstream and downstream) or through an edge.
export function pathOf(graph,{node,edge}={}){
 const out=new Set(),down=new Map(),up=new Map();
 for(const e of graph.edges){(down.get(e.from)||down.set(e.from,[]).get(e.from)).push(e);(up.get(e.to)||up.set(e.to,[]).get(e.to)).push(e);}
 const walk=(start,map,end)=>{const seen=new Set(),todo=[start];while(todo.length){const id=todo.pop();for(const e of map.get(id)||[]){if(out.has(e.id)&&seen.has(e.id))continue;out.add(e.id);seen.add(e.id);todo.push(e[end]);}}};
 if(node){walk(node,down,'to');walk(node,up,'from');}
 if(edge){const e=graph.edges.find(x=>x.id===edge);if(e){out.add(e.id);walk(e.to,down,'to');walk(e.from,up,'from');}}
 return out;
}
export function describeNode(n){
 if(!n)return '';
 const parts=[n.label];
 if(n.column==='model')parts.push(t(n.state==='loaded'?'načtený':n.state==='loading'?'načítá se':n.history?'jen v historii':'nenačtený'),n.sizeGb!=null?`${n.sizeGb} GB`:null);
 else if(n.known)parts.push(t('známý, bez živých statistik'));
 else if(n.column!=='client')parts.push(t(n.state==='running'?'běží':n.state==='stopped'?'zastavený':'stav neznámý'));
 if(n.sub)parts.push(n.sub==='loopback'?t('loopback: tento stroj nebo SSH tunel'):n.sub);
 parts.push(tp(n.requests,'{n} požadavek|{n} požadavky|{n} požadavků'),t('{n} tokenů',{n:fmt(n.tokens)}));
 if(n.recent)parts.push(t('{n} za posledních 15 min',{n:n.recent}));
 if(n.lastAt)parts.push(t('naposledy {at}',{at:when(n.lastAt)}));
 return parts.filter(Boolean).join(' · ');
}
export function describeEdge(e,graph){
 const name=id=>graph.nodes.find(n=>n.id===id)?.label||id;
 return [`${name(e.from)} → ${name(e.to)}`,e.cross?t('mezi stroji'):null,tp(e.requests,'{n} požadavek|{n} požadavky|{n} požadavků'),t('{n} tokenů',{n:fmt(e.tokens)}),
  e.recent?t('{n} za posledních 15 min',{n:e.recent}):t('teď bez provozu'),e.lastAt?t('naposledy {at}',{at:when(e.lastAt)}):null].filter(Boolean).join(' · ');
}

export function wiringDiagram({onSelect}={}){
 const canvas=el('canvas',{tabindex:'0',role:'img'});
 const scroll=el('div',{class:'md-graph-scroll'},canvas);
 const readout=el('p',{class:'md-readout','aria-live':'polite'});
 const summary=el('p',{class:'ui-sr'});
 const node=el('div',{class:'md-graph'},scroll,readout,summary);
 let graph={lanes:[],nodes:[],edges:[]},geo=null,colors=palette(),hover=null,focus=-1,selected=null,frame=0,start=performance.now(),destroyed=false;
 const ctx=canvas.getContext('2d');
 const hint=()=>t('Najeď nebo klepni na uzel či čáru: ukáže cestu a čísla. Kliknutí na model, runtime nebo klienta filtruje tabulky.');
 function resize(){
  if(destroyed)return;geo=layout(graph,scroll.clientWidth||MIN_WIDTH);const dpr=Math.max(1,Math.min(3,globalThis.devicePixelRatio||1));
  canvas.width=Math.round(geo.width*dpr);canvas.height=Math.round(geo.height*dpr);canvas.style.width=`${geo.width}px`;canvas.style.height=`${geo.height}px`;
  ctx.setTransform(dpr,0,0,dpr,0,0);draw(performance.now());
 }
 const animated=()=>!reduced()&&!document.hidden&&graph.edges.some(e=>e.recent>0);
 function loop(now){frame=0;if(destroyed)return;draw(now);if(animated())frame=requestAnimationFrame(loop);}
 function kick(){if(!frame&&animated())frame=requestAnimationFrame(loop);else if(!animated())draw(performance.now());}
 const activeIds=()=>{const target=hover||(focus>=0?{node:sortedNodes()[focus]?.id}:null)||(selected?{node:selected}:null);return target?pathOf(graph,target):null;};
 const sortedNodes=()=>geo?[...geo.boxes.values()].sort((a,b)=>a.x-b.x||a.y-b.y).map(b=>b.node):[];
 function truncate(text,max){if(ctx.measureText(text).width<=max)return text;let s=text;while(s.length>1&&ctx.measureText(s+'…').width>max)s=s.slice(0,-1);return s+'…';}
 function draw(now){
  if(!geo)return;const c=colors,W=geo.width,active=activeIds(),focusId=focus>=0?sortedNodes()[focus]?.id:null;
  ctx.clearRect(0,0,W,geo.height);
  // Column titles and lanes.
  ctx.font=`600 10px ${c.mono}`;ctx.fillStyle=c.faint;ctx.textBaseline='middle';
  for(const col of COLUMNS)ctx.fillText(t(COLUMN_TITLE[col]).toUpperCase(),geo.x[col],HEAD/2);
  geo.bands.forEach((b,i)=>{if(i%2===0){ctx.fillStyle=rgba(c.raised,1);ctx.globalAlpha=.55;ctx.fillRect(0,b.y,W,b.h);ctx.globalAlpha=1;}
   ctx.strokeStyle=c.border;ctx.beginPath();ctx.moveTo(0,b.y+.5);ctx.lineTo(W,b.y+.5);ctx.stroke();
   ctx.font=`600 11px ${c.sans}`;ctx.fillStyle=c.dim;ctx.fillText(b.lane.id==='unknown'?t('Stroj neznámý'):(b.lane.name||b.lane.id),12,b.y+LANE_TOP/2+1);});
  // Lines: width from requests in the range, faint when idle.
  const max=Math.max(1,graph.maxRequests||0);
  for(const e of geo.edges){
   const on=!active||active.has(e.id),busy=e.requests>0,colour=e.cross?c.cross:busy?c.flow:c.strong;
   ctx.lineWidth=busy?1.5+4.5*Math.sqrt(e.requests/max):1;ctx.strokeStyle=rgba(colour,!on?.12:busy?(active?.95:.6):(active?.6:.45));
   ctx.setLineDash(e.cross?[6,4]:[]);ctx.beginPath();ctx.moveTo(e.x1,e.y1);ctx.bezierCurveTo(e.c1x,e.y1,e.c2x,e.y2,e.x2,e.y2);ctx.stroke();
  }
  ctx.setLineDash([]);
  // Particles: only recent traffic moves.
  if(!reduced()){const maxRecent=Math.max(1,graph.maxRecent||0),secs=(now-start)/1000;
   for(const e of geo.edges){if(!e.recent)continue;const n=Math.min(10,1+Math.ceil(Math.log2(1+e.recent)*1.5)),speed=.12+.55*(e.recent/maxRecent),on=!active||active.has(e.id);
    ctx.fillStyle=rgba(e.cross?c.cross:c.flow,on?1:.25);
    for(let i=0;i<n;i++){const [px,py]=cubic(e,((i/n)+secs*speed)%1);ctx.beginPath();ctx.arc(px,py,2.4,0,Math.PI*2);ctx.fill();}}}
  // Nodes.
  for(const b of geo.boxes.values()){
   const n=b.node,on=!active||[...active].some(id=>{const e=graph.edges.find(x=>x.id===id);return e&&(e.from===n.id||e.to===n.id);})||selected===n.id||focusId===n.id||(hover?.node===n.id);
   const kind=n.kind?c.kinds[n.kind]||c.kinds.other:null,stopped=n.state==='stopped',known=n.known||n.history||n.state==='known';
   ctx.globalAlpha=on?1:.35;
   ctx.fillStyle=c.surface;ctx.strokeStyle=stopped&&!known?c.bad:n.state==='loaded'||n.state==='running'?c.strong:c.border;ctx.lineWidth=1;ctx.setLineDash(known?[3,3]:[]);
   ctx.beginPath();ctx.roundRect(b.x+.5,b.y+.5,b.w-1,b.h-1,6);ctx.fill();ctx.stroke();ctx.setLineDash([]);
   if(kind){ctx.fillStyle=kind;ctx.fillRect(b.x+1,b.y+4,3,b.h-8);}
   if(n.state==='loaded'||n.state==='loading'){ctx.fillStyle=n.state==='loaded'?c.good:c.flow;ctx.beginPath();ctx.arc(b.x+b.w-9,b.y+b.h/2,3.2,0,Math.PI*2);ctx.fill();}
   const right=n.requests?fmt(n.requests):n.column==='model'&&n.sizeGb!=null?`${Math.round(n.sizeGb)} GB`:'';
   ctx.font=`500 10px ${c.mono}`;const rw=right?ctx.measureText(right).width+8:0;
   if(right){ctx.fillStyle=c.faint;ctx.fillText(right,b.x+b.w-(n.state==='loaded'||n.state==='loading'?16:6)-rw+8,b.y+b.h/2+1);}
   ctx.font=`${n.column==='model'?'500 11px '+c.mono:'500 12px '+c.sans}`;ctx.fillStyle=known||n.state==='unknown'?c.dim:c.text;
   ctx.fillText(truncate(n.column==='model'?shortName(n.label):n.label,b.w-(kind?14:10)-rw-(n.state==='loaded'?12:0)),b.x+(kind?10:8),b.y+b.h/2+1);
   if(selected===n.id||focusId===n.id){ctx.strokeStyle=c.focus;ctx.lineWidth=2;ctx.beginPath();ctx.roundRect(b.x-2,b.y-2,b.w+4,b.h+4,8);ctx.stroke();}
   ctx.globalAlpha=1;
  }
 }
 function hit(px,py){
  for(const b of geo.boxes.values())if(px>=b.x&&px<=b.x+b.w&&py>=b.y&&py<=b.y+b.h)return {node:b.node.id};
  let best=null,bestD=7;
  for(const e of geo.edges)for(let i=0;i<=24;i++){const [x,y]=cubic(e,i/24),d=Math.hypot(x-px,y-py);if(d<bestD){bestD=d;best={edge:e.id};}}
  return best;
 }
 const point=ev=>{const r=canvas.getBoundingClientRect();return [ev.clientX-r.left,ev.clientY-r.top];};
 function say(target){
  if(target?.node)readout.textContent=describeNode(graph.nodes.find(n=>n.id===target.node));
  else if(target?.edge)readout.textContent=describeEdge(graph.edges.find(e=>e.id===target.edge),graph);
  else if(selected)readout.textContent=describeNode(graph.nodes.find(n=>n.id===selected));
  else readout.textContent=hint();
 }
 function choose(id){
  const n=graph.nodes.find(x=>x.id===id);selected=n?id:null;
  const filter=!n?null:n.column==='model'?{machine:n.machine,runtime:n.runtime,model:n.model,label:n.label}:n.column==='client'?(n.client?{client:n.client,label:n.label}:null):n.runtime?{machine:n.machine,runtime:n.runtime,label:`${n.label} · ${n.machine}`}:{machine:n.machine,label:n.machine};
  if(!filter)selected=null;onSelect?.(filter);say(null);kick();
 }
 canvas.addEventListener('pointermove',ev=>{if(!geo)return;const h=hit(...point(ev));const key=JSON.stringify(h);if(key!==JSON.stringify(hover)){hover=h;canvas.classList.toggle('md-pointer',Boolean(h?.node));say(h);if(!frame)draw(performance.now());}});
 canvas.addEventListener('pointerleave',()=>{hover=null;say(null);if(!frame)draw(performance.now());});
 canvas.addEventListener('click',ev=>{const h=hit(...point(ev));if(h?.node)choose(selected===h.node?null:h.node);else if(!h){choose(null);}else say(h);});
 canvas.addEventListener('keydown',ev=>{
  const list=sortedNodes();if(!list.length)return;
  if(['ArrowDown','ArrowRight'].includes(ev.key)){focus=(focus+1)%list.length;}
  else if(['ArrowUp','ArrowLeft'].includes(ev.key)){focus=(focus-1+list.length)%list.length;}
  else if((ev.key==='Enter'||ev.key===' ')&&focus>=0){choose(selected===list[focus].id?null:list[focus].id);ev.preventDefault();return;}
  else if(ev.key==='Escape'){focus=-1;choose(null);return;}
  else return;
  ev.preventDefault();say({node:list[focus].id});if(!frame)draw(performance.now());
 });
 canvas.addEventListener('blur',()=>{focus=-1;if(!frame)draw(performance.now());});
 const observer=typeof ResizeObserver==='function'?new ResizeObserver(()=>resize()):null;observer?.observe(scroll);
 const onTheme=()=>{colors=palette();draw(performance.now());};
 const motion=globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');const onMotion=()=>kick();
 const onVisible=()=>kick();
 globalThis.addEventListener?.('themechange',onTheme);motion?.addEventListener?.('change',onMotion);document.addEventListener('visibilitychange',onVisible);
 // A system theme change (no themechange event) also changes the tokens.
 const scheme=globalThis.matchMedia?.('(prefers-color-scheme: dark)');scheme?.addEventListener?.('change',onTheme);
 function update(next,{selected:sel}={}){
  graph=next||{lanes:[],nodes:[],edges:[]};if(sel!==undefined)selected=graph.nodes.some(n=>n.id===sel)?sel:null;
  const busy=graph.edges.filter(e=>e.requests>0).sort((a,b)=>b.requests-a.requests).slice(0,8);
  canvas.setAttribute('aria-label',t('Schéma zapojení: {nodes} uzlů, {edges} spojení, {busy} s provozem.',{nodes:graph.nodes.length,edges:graph.edges.length,busy:graph.edges.filter(e=>e.requests>0).length}));
  summary.textContent=busy.map(e=>describeEdge(e,graph)).join('. ');
  colors=palette();resize();say(null);kick();
 }
 function destroy(){destroyed=true;if(frame)cancelAnimationFrame(frame);observer?.disconnect();globalThis.removeEventListener?.('themechange',onTheme);motion?.removeEventListener?.('change',onMotion);scheme?.removeEventListener?.('change',onTheme);document.removeEventListener('visibilitychange',onVisible);}
 return {node,update,destroy,selected:()=>selected,clear:()=>{selected=null;say(null);kick();}};
}
