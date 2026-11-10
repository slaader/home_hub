// Home page: machine tiles (art + props + last-minute quad) and per-machine child pages
// (chart ranges + LEGO runtime-stack grid). Renders /api/home data; block links exist only
// through grid position, exactly like the approved mockup. Deep link: #host-studio/lserver.
import {el,date} from './views.js';
import {SERIES,renderCharts,disposeCharts,loadECharts,level} from './home-charts.js';
import {onSessionReset,sessionCache,authGuard} from './session-cache.js';
import {createOrderSaver} from './home-order.js';
import {t,tp,locale} from './i18n.js';
import {openAddDevice,removeDevice} from './home-add-device.js';
import {timeZone} from './site.js';
import {emptyState} from './ui.js';
// Adding and removing devices needs write access (the server checks it again).
let canEdit=false;
let cache=null,historyCache=new Map(),state={machine:null,blk:null,range:'30m'};
// A different account must not be shown the previous one's tiles or history.
onSessionReset(()=>{cache=null;historyCache.clear();editing=false;orderNote='';});

// Tile order, per signed-in account on the server (GET/POST /api/profile/home-order, password sign-in
// only). Cached per principal like other account data; when it cannot be read, tiles keep the default
// order and the "Upravit pořadí" button is not offered.
const orderCache=sessionCache(43200000);// as long as a sign-in lives (12 h)
let editing=false,orderNote='';
async function loadOrder(){
 const hit=orderCache.get();if(hit)return hit;
 const store=orderCache.begin(),lost=authGuard();
 try{const r=await fetch('/api/profile/home-order');if(r.ok){const b=await r.json();return store('',{order:Array.isArray(b.order)?b.order:null,available:true});}
  lost(r);return r.status===403?store('',{order:null,available:false}):{order:null,available:false};}
 catch{return {order:null,available:false};}
}
export function orderedMachines(machines,order){
 if(!Array.isArray(order))return machines;const rank=id=>{const i=order.indexOf(id);return i<0?order.length:i;};
 return machines.map((m,i)=>({m,i})).sort((a,b)=>rank(a.m.id)-rank(b.m.id)||a.i-b.i).map(x=>x.m);
}
// Move `id` to position `to` (0-based) in the list of ids.
export function moveId(ids,id,to){const out=ids.filter(x=>x!==id);out.splice(Math.max(0,Math.min(out.length,to)),0,id);return out;}
// A 401 signs out only the account that made the move: Alice's late 401 must not end Bob's sign-in
// (the saver's 'stale' outcome arrives after this, too late to stop it).
export async function sendOrder(order){
 const lost=authGuard();
 const r=await fetch('/api/profile/home-order',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({order})});
 if(!r.ok){lost(r);throw new Error('order');}
 const b=await r.json();return {order:b.order,available:true};
}
// One save at a time, newest move wins, bound to the sign-in that made it (home-order.js).
const orderSaver=createOrderSaver({cache:orderCache,send:sendOrder});

const ART={
 mini:'<svg viewBox="0 0 72 56"><rect width="72" height="56" fill="#0a0d12"/><rect x="12" y="18" width="48" height="20" rx="4" fill="#1a2230" stroke="#4da3ff" stroke-opacity=".5"/><rect x="30" y="26" width="12" height="3" rx="1.5" fill="#4da3ff" fill-opacity=".6"/><path d="M20 42h32" stroke="#141a23" stroke-width="4"/></svg>',
 studio:'<svg viewBox="0 0 72 56"><rect width="72" height="56" fill="#0a0d12"/><rect x="14" y="16" width="44" height="26" rx="9" fill="#1a2230" stroke="#4da3ff" stroke-opacity=".5"/><rect x="26" y="27" width="20" height="3" rx="1.5" fill="#4da3ff" fill-opacity=".6"/><path d="M22 46h28" stroke="#141a23" stroke-width="4"/></svg>',
 m1:'<svg viewBox="0 0 72 56"><rect width="72" height="56" fill="#0a0d12"/><rect x="14" y="16" width="44" height="26" rx="9" fill="#1a2230" stroke="#4da3ff" stroke-opacity=".5"/><rect x="26" y="27" width="20" height="3" rx="1.5" fill="#4da3ff" fill-opacity=".6"/><path d="M22 46h28" stroke="#141a23" stroke-width="4"/></svg>',
 nas:'<svg viewBox="0 0 72 56"><rect width="72" height="56" fill="#0a0d12"/><rect x="12" y="8" width="48" height="17" rx="4" fill="#1a2230" stroke="#9ecbff" stroke-opacity=".4"/><rect x="12" y="30" width="48" height="17" rx="4" fill="#1a2230" stroke="#9ecbff" stroke-opacity=".4"/><circle cx="20" cy="16.5" r="2" fill="#3ddc84"/><circle cx="20" cy="38.5" r="2" fill="#3ddc84"/><path d="M28 16.5h26M28 38.5h26" stroke="#2a3444" stroke-width="2"/></svg>',
 router:'<svg viewBox="0 0 72 56"><rect width="72" height="56" fill="#0a0d12"/><rect x="14" y="32" width="44" height="14" rx="5" fill="#1a2230" stroke="#ffb020" stroke-opacity=".5"/><path d="M26 24a14 14 0 0 1 20 0M31 29a7 7 0 0 1 10 0" fill="none" stroke="#ffb020" stroke-opacity=".6" stroke-width="2"/><circle cx="21" cy="39" r="1.6" fill="#3ddc84"/></svg>'};
// Sparkline colour per machine: a fixed palette by position among the site's machines; added devices share one.
const PALETTE=['#4da3ff','#8f7bff','#4de3c0','#9ecbff','#ffb020'];
const tint=m=>{const i=(cache?.machines||[]).filter(x=>!x.added).findIndex(x=>x.id===m.id);return PALETTE[i]||'#ff9e7a';};
const engColor={gguf:'var(--gguf)',mlx:'var(--mlx)',torch:'var(--torch)',mix:'var(--mix)',edge:'var(--edge)',media:'var(--media)',cloud:'var(--cloud)',dev:'var(--devc)',share:'var(--share)',net:'var(--net)'};
function htmlBox(tag,attrs,markup){const n=el(tag,attrs);n.innerHTML=markup;return n;}
function ensureStyles(){}
async function load(){const lost=authGuard(),r=await fetch('/api/home');if(!r.ok){lost(r);throw new Error('home');}cache=await r.json();return cache;}
async function loadHistory(machine,range,fresh=false){
 const key=`${machine}:${range}`;const hit=historyCache.get(key);if(!fresh&&hit&&Date.now()-hit.at<30000)return hit.value;
 const lost=authGuard(),r=await fetch(`/api/home/history?machine=${machine}&range=${range}`);if(!r.ok){lost(r);throw new Error('history');}
 const value=await r.json();historyCache.set(key,{at:Date.now(),value});return value;
}
function quadClass(k,v){const l=level(k==='CPU'?'cpu':k==='GPU'?'gpu':k==='TEPL.'?'temp':'',v);return l?`qc ${l}`:'qc';}
const GiB=1073741824;
// Memory pressure from Thermo (build 97): 0 normal · 1 warning · 2 critical.
export const pressureName=v=>v==null?null:v>=2?t('kritický'):v>=1?t('zvýšený'):t('normální');
const pressureLevel=v=>v==null?'':v>=2?'crit':v>=1?'hot':'';
// Ring gauge split into 100 %: one or more coloured arcs on a dim track, value in the middle.
function ring({segments,center,unit,label,sub,cls=''}){
 const r=26,c=2*Math.PI*r;let offset=0;
 const arcs=segments.filter(x=>x.pct>0).map(x=>{const len=Math.min(100,x.pct)/100*c;const a=`<circle r="${r}" cx="32" cy="32" fill="none" stroke="${x.color}" stroke-width="6" stroke-linecap="butt" stroke-dasharray="${len.toFixed(2)} ${(c-len).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 32 32)"/>`;offset+=len;return a;}).join('');
 const ticks=[0,25,50,75].map(p=>{const ang=(p/100)*2*Math.PI-Math.PI/2;const x1=32+Math.cos(ang)*31,y1=32+Math.sin(ang)*31,x2=32+Math.cos(ang)*33.5,y2=32+Math.sin(ang)*33.5;return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="#3a3448" stroke-width="1"/>`;}).join('');
 const svg=`<svg viewBox="-2 -2 68 68" aria-hidden="true"><circle r="${r}" cx="32" cy="32" fill="none" stroke="#221e2c" stroke-width="6"/>${arcs}${ticks}</svg>`;
 const box=el('div',{class:`gauge ${cls}`});
 const dial=el('div',{class:'g-dial'});dial.innerHTML=svg;
 dial.append(el('div',{class:'g-center'},el('span',{class:'g-v'},center??'–'),unit?el('span',{class:'g-u'},unit):null));
 box.append(el('div',{class:'g-k'},label),dial,el('div',{class:'g-s',title:sub?.title||''},sub?.text||'\u00a0'));
 return box;
}
const loadColor=v=>v>=75?'#ff6b81':v>=50?'#ffc266':'#7be3b5';
function macGauges(m){
 const q=m.quad||{};
 const cpu=q.cpu!=null?Math.round(q.cpu):null,gpu=q.gpu!=null?Math.round(q.gpu):null;
 // GPU holds = Metal allocations (model weights stay here while loaded); in-use = active working set.
 const total=q.memTotal||null,used=q.memUsed??null,gmem=q.gpuMemAlloc??q.gpuMem??null,gactive=q.gpuMemAlloc!=null?q.gpuMem:null;
 const usedPct=total&&used!=null?used/total*100:null,gpuPct=total&&gmem!=null?Math.min(usedPct??100,gmem/total*100):0;
 const memCls=pressureLevel(q.memPressure)||(usedPct!=null&&usedPct>=90?'hot':'');
 const memSub={text:gmem!=null?`GPU ${Math.round(gmem/GiB)} GB`:total?t('z {gb} GB',{gb:Math.round(total/GiB)}):'',
  title:gmem!=null?t('GPU drží {gb} GB (alokováno, např. načtený model){active}. Celkem RAM {total} GB.',{gb:Math.round(gmem/GiB),active:gactive!=null?t(', z toho právě aktivně {gb} GB',{gb:Math.round(gactive/GiB)}):'',total:total?Math.round(total/GiB):'?'}):t('Thermo na tomto Macu zatím neposílá paměť GPU (build < 97).')};
 const gauges=el('div',{class:'gauges'},
  ring({segments:[{pct:cpu??0,color:loadColor(cpu??0)}],center:cpu,unit:'%',label:'CPU',cls:level('cpu',cpu)}),
  ring({segments:[{pct:gpu??0,color:loadColor(gpu??0)}],center:gpu,unit:'%',label:'GPU',cls:level('gpu',gpu)}),
  ring({segments:[{pct:gpuPct,color:'#c7a7ff'},{pct:Math.max(0,(usedPct??0)-gpuPct),color:'#4de3c0'}],center:used!=null?Math.round(used/GiB):null,unit:'GB',label:t('Paměť'),sub:memSub,cls:memCls}));
 const temp=q.temp!=null?Math.round(q.temp):null;
 const stats=el('div',{class:'mini-stats'},
  el('span',{},el('span',{class:'pk'},t('Příkon')),el('b',{},q.power!=null?`${Math.round(q.power)} W`:'–')),
  el('span',{class:level('temp',temp)},el('span',{class:'pk'},t('Tepl.')),el('b',{},temp!=null?`${temp} °C`:'–')),
  el('span',{class:pressureLevel(q.memPressure)},el('span',{class:'pk'},t('Tlak')),el('b',{},pressureName(q.memPressure)??'–')));
 return el('div',{},gauges,stats);
}
function quadTiles(m){
 if(m.kind==='thermo')return macGauges(m);
 if(m.kind==='other')return el('div',{class:'tile-sec'},t('Bez živých dat — jen dlaždice.'));
 const q=m.quad||{};
 const tiles=[];
 if(m.id==='router')tiles.push(['CLIENTŮ',q.clients!=null?q.clients:null,''],['WI-FI',q.wifi!=null?q.wifi:null,''],['PŘÍKON',null,'W'],['TEPL.',null,'°C']);
 else if(m.id==='nas')tiles.push(['SLUŽBY',m.services?.length||0,''],['REACHABLE',(m.services||[]).filter(s=>s.status==='reachable').length,''],['PŘÍKON',null,'W'],['TEPL.',null,'°C']);
 return el('div',{class:'quad'},tiles.map(([k,v,u])=>el('div',{class:quadClass(k,v)},el('div',{class:'k'},t(k)),el('div',{class:'v'},v==null?'–':String(v),u?el('small',{},' '+u):null))));
}
function propsLine(m){
 const p=m.props||{};const size=v=>v==null?null:v>=1e12?`${Math.round(v/1e12)} TB`:`${Math.round(v/1e9)} GB`;
 const items=[['CPU',p.cpu],['GPU',p.gpu&&p.gpu!=='—'?p.gpu:null],['RAM',p.ramGb!=null?`${p.ramGb} GB`:null],[p.pools?t('Pooly'):'Disk',size(p.diskTotalBytes)]].filter(([,v])=>v);
 return el('div',{class:'home-props'},items.map(([k,v])=>el('span',{class:'pp'},el('span',{class:'pk'},k),el('span',{class:'pv'},String(v)))));
}
function tile(m){
 const prefetch=()=>{void loadHistory(m.id,state.range).catch(()=>{});void loadECharts().catch(()=>{});};
 return el('a',{class:`home-tile dev-${m.id}`,href:`#host-${m.id}`,onmouseenter:prefetch,onfocus:prefetch},
  tileArt(m),
  el('div',{},el('h3',{},m.name),el('div',{class:'home-host'},m.ip&&m.ip!==m.hostname?`${m.hostname} · ${m.ip}`:m.hostname),
   tileStatus(m),propsLine(m),el('div',{class:'tile-live'},quadTiles(m)),tileSpark(m)));
}
function tileStatus(m){
 if(m.online==='unknown')return el('div',{class:'tstat stale'},el('i',{}),t('stav neznámý'));
 const online=m.online==='online'?'':'off',label=m.online==='online'?`online${m.lastSeen?t(' · naposledy {when}',{when:date(m.lastSeen)}):''}`:m.online==='stale'?'stale':'offline';
 return el('div',{class:`tstat ${m.online==='stale'?'stale':online==='off'?'off':''}`},el('i',{}),label);
}
// In-place refresh of one tile: status line, gauges and sparkline; the picture and layout stay put.
function updateTile(node,m){
 node.querySelector('.tstat')?.replaceWith(tileStatus(m));
 node.querySelector('.tile-live')?.replaceChildren(quadTiles(m));
 const spark=node.querySelector('.tile-spark');
 if(spark)loadHistory(m.id,'30m',true).then(h=>{const svg=sparkline(h.points||[],p=>p.cpu,tint(m),100);const old=spark.querySelector('.spark,.src');if(old)old.replaceWith(svg);else spark.append(svg);}).catch(()=>{});
}
function quadNote(m){
 const q=m.quad;if(!q?.observedAt)return null;
 const age=Math.max(0,Math.round((Date.now()-q.observedAt)/1000));
 return el('div',{class:'qnote'},t('Ø {window} s · před {age} s',{window:q.windowSeconds||'?',age}));
}
// Generated surrealist picture per machine; the small SVG stays as a fallback if it fails to load.
function tileArt(m){
 const box=el('div',{class:'home-art'});
 // The small drawing: one made for this machine id if there is one, else by kind (nas, router), else a generic box.
 const fallback=()=>{box.innerHTML=ART[m.id]||ART[m.kind]||(/server/.test(m.id)?ART.m1:'')||ART.mini||'';};
 // An added device without a picture keeps the small drawing.
 if(m.added&&!m.image){fallback();return box;}
 const img=el('img',{src:m.image||`/images/home/${m.id}.jpg`,alt:'',loading:'lazy',decoding:'async',onerror:fallback});
 box.append(img);return box;
}
// 30-minute CPU trend on Mac tiles (same history endpoint as the device page, cached 30 s).
function tileSpark(m){
 if(m.kind!=='thermo')return null;
 const box=el('div',{class:'tile-spark'},el('div',{class:'tile-sec'},t('CPU load · 30 min')));
 loadHistory(m.id,'30m').then(h=>{box.append(sparkline(h.points||[],p=>p.cpu,tint(m),100));}).catch(()=>{});
 return box;
}
function sparkline(points,pick,color,scale){
 const vals=points.map(pick).filter(v=>v!=null);if(!vals.length)return el('div',{class:'src'},t('zatím žádná data'));
 const max=Math.max(scale||0,...vals)*1.15||1,w=300,h=74,pd=3;
 const x=i=>pd+i*(w-2*pd)/Math.max(1,points.length-1),y=v=>h-12-(v/max)*(h-24);
 let d='',open=false;
 points.forEach((p,i)=>{const v=pick(p);if(v==null)return;d+=(open?'L':'M')+x(i).toFixed(1)+' '+y(v).toFixed(1)+' ';open=true;});
 return htmlBox('div',{class:'spark'},`<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">`+[25,50,75].map(pc=>`<line class="grid-l" x1="${pd}" x2="${w-pd}" y1="${(h-12-pc/100*(h-24)).toFixed(1)}" y2="${(h-12-pc/100*(h-24)).toFixed(1)}"/>`).join('')+`<path d="${d}" fill="none" stroke="${color}" stroke-width="1.6"/></svg>`);
}
function chartCard(title,points,pick,live,color,scale,unit,src){
 const last=live!=null?live:null;
 return el('div',{class:'hc'},el('h4',{},title),
  el('div',{class:'val'},last==null?'–':String(typeof last==='number'?Math.round(last*10)/10:last),el('small',{},' '+unit)),
  sparkline(points,pick,color,scale),el('div',{class:'src'},src));
}
function overlap(a,b){return !(a.col1<b.col0||b.col1<a.col0);}
// Detail panel beside the grid: empty hint until a block is picked, then the block's story.
let animatePanel=false;
function stackPanel(machine,blk){
 const still=animatePanel?'':' still';
 if(!blk)return el('aside',{class:'stack-panel empty'+still},
  el('div',{class:'sp-empty-icon'},el('i'),el('i'),el('i')),
  el('div',{class:'sp-empty-t'},t('Vyber blok v diagramu')),
  el('div',{class:'sp-empty-s'},t('Ukáže se, na čem stojí, co je nad ním, port, stav a modely.')));
 const stack=machine.stack;
 const below=stack.blocks.filter(b=>b.layer===blk.layer+1&&overlap(b,blk));
 const above=stack.blocks.filter(b=>b.layer===blk.layer-1&&overlap(b,blk));
 const models=blk.models||[];
 const color=blk.engine||blk.hw?'var(--line-hi)':engColor[stack.cols[blk.col0]]||'var(--accent)';
 const chip=b=>el('button',{class:`sp-chip ${b.state==='off'?'off':''}`,onclick:()=>selectBlock(machine,b.id)},t(b.title));
 const panel=el('aside',{class:'stack-panel'+still},
  el('div',{class:'sp-head'},
   el('div',{},el('div',{class:'sp-layer'},t(stack.layers[blk.layer]||'')),el('h3',{},t(blk.title))),
   el('button',{class:'sp-close','aria-label':t('Zavřít detail'),onclick:()=>selectBlock(machine,blk.id)},'×')),
  el('div',{class:'sp-meta'},
   blk.hw||blk.engine?null:el('span',{class:`sp-state ${blk.state==='off'?'off':'on'}`},blk.state==='off'?t('vypnuto'):t('běží')),
   blk.port?el('span',{class:'sp-port'},t(blk.port)):null,
   stack.engines?.[stack.cols[blk.col0]]&&!blk.hw?el('span',{class:'sp-eng'},t(stack.engines[stack.cols[blk.col0]])):null),
  blk.desc?el('p',{class:'sp-desc'},t(blk.desc)):null,
  el('div',{class:'sp-sec'},el('div',{class:'sp-k'},t('Stojí na')),el('div',{class:'sp-chips'},below.length?below.map(chip):el('span',{class:'sp-none'},t('— nejspodnější vrstva')))),
  el('div',{class:'sp-sec'},el('div',{class:'sp-k'},t('Nad ním')),el('div',{class:'sp-chips'},above.length?above.map(chip):el('span',{class:'sp-none'},t('— nic')))),
  blk.stats&&blk.stats.requests!=null?el('div',{class:'sp-sec'},el('div',{class:'sp-k'},t('Provoz')),el('div',{class:'sp-v'},`${tp(blk.stats.requests,'{n} request|{n} requesty|{n} requestů')} · uptime ${Math.round((blk.stats.uptimeSeconds||0)/3600)} h`)):null,
  blk.pool?el('div',{class:'sp-sec'},el('div',{class:'sp-k'},t('Rozpočet paměti')),el('div',{class:'sp-v'},`${blk.pool.allocatedGb} / ${blk.pool.capacityGb} GB`)):null,
  el('div',{class:'sp-sec'},el('div',{class:'sp-k'},t('Modely · {n}',{n:models.length})),
   models.length?el('div',{class:'sp-models'},models.map(m=>el('div',{class:'mrow'},el('span',{class:`st ${m.state==='loaded'?'loaded':m.state==='loading'?'loading':'idle'}`}),
    el('div',{},el('div',{},m.id,m.sizeGb?` · ${m.sizeGb} GB`:'',m.ttlRemainingSeconds?` · TTL ${Math.round(m.ttlRemainingSeconds/60)} min`:''),m.path?el('div',{class:'path'},m.path):null)))):el('span',{class:'sp-none'},t('žádné'))));
 panel.style.setProperty('--sp',color);
 return panel;
}
function stackGrid(machine){
 const stack=machine.stack;if(!stack)return el('div',{class:'src'},t('Runtime diagram pro tento stroj ještě není.'));
 const cols=stack.cols.length;
 const grid=el('div',{class:'stack'});grid.style.gridTemplateColumns=`64px repeat(${cols},minmax(76px,1fr))`;
 const layerCount=Math.max(...stack.blocks.map(b=>b.layer))+1;
 for(let L=0;L<layerCount;L++){
  grid.append(el('div',{class:'lname'},t(stack.layers[L]||'')));
  const placed=stack.blocks.filter(b=>b.layer===L).sort((a,b)=>a.col0-b.col0);
  const busy=new Set();placed.forEach(b=>{for(let c=b.col0;c<=b.col1;c++)busy.add(c);});
  for(let c=0;c<cols;c++){
   if(busy.has(c)&&!placed.some(b=>b.col0===c)){
    if(!placed.some(b=>c>=b.col0&&c<=b.col1))continue;
   }
   if(busy.has(c)){
    const b=placed.find(b=>c>=b.col0&&c<=b.col1);if(b.col0!==c)continue;
    const color=b.engine?'#3a4558':engColor[stack.cols[b.col0]]||'var(--mlx)';
    const sel=state.blk===b.id?' sel':'',rel=state.blk&&state.blk!==b.id&&(overlap(stack.blocks.find(x=>x.id===state.blk)||{},b))?' rel':'';
    const btn=el('button',{class:`blk ${b.engine?'engine':''} ${b.hw?'hw':''} ${b.state==='off'?'off':''}${sel}${rel}`,onclick:()=>selectBlock(machine,b.id)},
     el('span',{class:'t'},t(b.title)),el('span',{class:'p'},t(b.port||'')),b.state!=='off'&&!b.hw&&!b.engine?el('span',{class:'dot'}):null);
    btn.style.setProperty('--c',color);btn.style.gridColumnStart=String(c+2);btn.style.gridColumnEnd=String(b.col1+3);grid.append(btn);
   }else{
    // column with nothing on this row → dashed gap unless a neighbour spans it
    const spansLeft=placed.some(b=>b.col0<=c&&b.col1>=c);if(spansLeft)continue;
    const g=el('div',{class:'gapbox'},t('NIC'));g.style.gridColumnStart=String(c+2);grid.append(g);
   }
  }
 }
 const sel=stack.blocks.find(b=>b.id===state.blk)||null;
 return el('section',{class:'stack-layout',id:'stack-slot'},el('div',{class:'stack-main'},el('div',{class:'stack-wrap'},grid),
  el('div',{class:'legend'},
   ...Object.entries(stack.engines||{}).map(([k,v])=>el('span',{},(()=>{const i=el('i');i.style.background=engColor[k]||'#4da3ff';return i;})(),t(v))),
   el('span',{},el('i',{class:'g'}),t('nic mezi tím')),
   el('span',{},el('i',{class:'g offkey'}),t('vypnuto (schopnost bez bloku)')))),
  stackPanel(machine,sel));
}
function selectBlock(machine,id){
 state.blk=state.blk===id?null:id;
 history.replaceState(null,'',`#host-${machine.id}${state.blk?'/'+state.blk:''}`);
 const old=document.querySelector('#stack-slot');
 animatePanel=true;const fresh=stackGrid(machine);animatePanel=false;
 if(old)old.replaceWith(fresh);else renderChild(document.querySelector('#home-slot'),machine);
}
addEventListener('keydown',e=>{if(e.key==='Escape'&&state.blk&&document.querySelector('#stack-slot')){const m=cache?.machines.find(x=>location.hash.startsWith(`#host-${x.id}`));if(m)selectBlock(m,state.blk);}});
const RANGES={'30m':'30 min','7d':'7 dní','30d':'30 dní','6m':'6 měsíců'};
const gb=b=>b==null?null:b>=1e12?`${Math.round(b/1e12)} TB`:`${Math.round(b/1e9)} GB`;
// Device header: name left, properties right — small labels, highlighted values.
function deviceProps(m){
 const p=m.props||{};
 const items=[['CPU',p.cpu],['GPU',p.gpu&&p.gpu!=='—'?p.gpu:null],['RAM',p.ramGb!=null?`${p.ramGb} GB`:null],[p.pools?t('Pooly'):'Disk',gb(p.diskTotalBytes)],['IP',m.ip]];
 return el('dl',{class:'dev-props'},items.filter(([,v])=>v).flatMap(([k,v])=>[el('dt',{},k),el('dd',{},String(v))]));
}
function renderChild(slot,machine){
 disposeCharts();
 const thermo=machine.kind==='thermo';
 const remove=machine.added&&canEdit?el('button',{type:'button',class:'hh-quiet dev-remove',onclick:async e=>{const b=e.currentTarget;b.disabled=true;
   try{if(await removeDevice(machine)){cache=null;location.hash='#overview';}else b.disabled=false;}catch(err){b.disabled=false;alert(err.message);}}},t('Odebrat zařízení')):null;
 const head=el('div',{class:'dev-head'},
  el('div',{class:'dev-title'},el('a',{href:'#overview',class:'home-back'},t('← přehled')),el('h2',{},machine.name),el('div',{class:'dev-host'},machine.hostname,machine.collectedAt?t(' · sebráno {when}',{when:date(machine.collectedAt)}):''),remove),
  deviceProps(machine));
 slot.replaceChildren(head);
 if(thermo){
  const bar=el('div',{class:'rangebar'},...Object.entries(RANGES).map(([r,label])=>el('button',{class:state.range===r?'on':'',onclick:()=>{state.range=r;renderChild(slot,latest(machine.id)||machine);},onmouseenter:()=>void loadHistory(machine.id,r).catch(()=>{})},t(label))));
  const source=el('span',{class:'src'});
  const cards=SERIES.map(def=>{const value=el('div',{class:'val'},'–');const sub=el('div',{class:'hc-sub'});const node=el('div',{class:'hc-chart'});
   return {def,value,sub,node,card:el('div',{class:`hc hc-${def.key}`},el('h4',{},t(def.title)),value,sub,node)};});
  childCards=cards;
  slot.append(el('div',{class:'dev-bar'},bar,source),el('div',{class:'home-charts'},cards.map(c=>c.card)));
  const gen=++viewGen;
  loadHistory(machine.id,state.range).then(h=>{if(gen!==viewGen)return;const since=h.coverageSeconds?new Date(Date.now()-h.coverageSeconds*1000):null;
   source.textContent=`${t(h.source||'')}${h.complete===false&&since?t(' · data teprve od {when}',{when:new Intl.DateTimeFormat(locale(),{day:'numeric',month:'numeric',hour:'2-digit',minute:'2-digit',timeZone:timeZone()}).format(since)}):''}`;return renderCharts(cards,h,state.range,machine.quad||{});})
   .catch(()=>source.textContent=t('Historie nedostupná.'));
 }else slot.append(el('div',{class:'src dev-note'},machine.kind==='other'?t('Přidané zařízení bez Thermo: zatím jen dlaždice s údaji.'):machine.id==='nas'?t('Živé metriky NAS (CPU, RAM, teploty) zatím nesbíráme — přijde collector pro TrueNAS.'):t('Router zatím nemá živý collector; čísla jsou ze sběru.')));
 slot.append(stackGrid(machine));
}
function renderHome(){
 ensureStyles();
 if(!cache)return el('div',{class:'src'},t('Načítám…'));
 const slot=el('div',{id:'home-slot',class:'home-page'},
  el('div',{class:'home-tiles'},cache.machines.map(m=>tile(m))));
 return slot;
}
let childCards=null,viewGen=0;
const latest=id=>cache?.machines.find(x=>x.id===id);
// Detail page refresh: new numbers into the existing chart instances (no rebuild, no jump).
function refreshChild(machine){
 if(!childCards)return;
 const gen=viewGen,cards=childCards,range=state.range;
 loadHistory(machine.id,range,true).then(h=>{if(gen!==viewGen)return;return renderCharts(cards,h,range,machine.quad||{},{keep:true});}).catch(()=>{});
 // Services/models change while the page is open: rebuild the stack from the latest data
 // (selection kept, no panel animation).
 const old=document.querySelector('#stack-slot');if(old)old.replaceWith(stackGrid(machine));
}
function emptyOverview(){
 return emptyState({icon:'◇',title:t('Zatím tu není žádný stroj'),
  body:t('Přehled ukazuje stroje z konfigurace webu a zařízení přidaná přímo tady.'),
  steps:[t('Zkopíruj config/site.example.json do local/site.json a vyplň název, síť a stroje.'),t('Restartuj Home Hub.'),t('Nebo přidej zařízení tlačítkem Přidat zařízení. Živá čísla dodá aplikace Thermo, pokud na něm běží.')],
  agentPrompt:t('Nastav tenhle Home Hub. Přečti docs/plugins.md a config/site.example.json, zeptej se mě na název webu, síť (CIDR) a stroje (název, hostname, IP, role), zapiš local/site.json a ověř ho spuštěním npm test. Žádná hesla ani tokeny do souboru nepatří.'),
  mcpSnippet:true});
}
export function homeView(machineId,me){
 ensureStyles();editing=false;orderNote='';canEdit=me?.canWrite===true;
 viewGen++;disposeCharts();childCards=null;
 const slot=el('div',{id:'home-slot',class:'home-page'});
 let built=false;
 const paint=()=>{
  notifyShell();
  if(!cache){slot.replaceChildren(el('div',{class:'src'},t('Načítám data domovské stránky…')));return;}
  if(!machineId){
   const list=orderedMachines(cache.machines,orderCache.get()?.order);
   // A hub without machines yet: say what belongs here and how to add it (reference use of ui.js → emptyState).
   if(!list.length){slot.replaceChildren(orderBar(),emptyOverview());built=false;return;}
   const grid=slot.querySelector('.home-tiles');
   const ids=list.map(m=>m.id).join(',')+(editing?'|edit':'');
   if(built&&grid&&grid.dataset.ids===ids){for(const m of list){const n=grid.querySelector(`[data-id="${m.id}"]`);if(n)updateTile(n,m);}return;}
   const g=el('div',{class:`home-tiles${editing?' reordering':''}`},list.map((m,i)=>editing?reorderTile(m,i,list):(n=>{n.dataset.id=m.id;return n;})(tile(m))));g.dataset.ids=ids;
   slot.replaceChildren(orderBar(),g);built=true;return;
  }
  const machine=cache.machines.find(m=>m.id===machineId);
  if(!machine){slot.replaceChildren(el('div',{class:'src'},t('Neznámý stroj.')));return;}
  if(built&&slot.querySelector('.dev-head')){refreshChild(machine);return;}
  const hash=(location.hash.split('/')[1]||'').replace(/[^a-z0-9_-]/g,'');
  state.blk=hash||null;
  renderChild(slot,machine);built=true;
 };
 repaint=paint;
 // Reorder mode (Přehled → Upravit pořadí): drag and drop with a mouse, ↑/↓ buttons for keyboard,
 // touch and phones. Every move shows at once and is saved one at a time, newest wins; a failed save goes
 // back to the last saved order (home-order.js).
 const rebuild=focus=>{built=false;paint();if(focus)(slot.querySelector(`[data-move="${focus}"]:not([disabled])`)||slot.querySelector(`[data-move^="${focus.split(':')[0]}:"]:not([disabled])`))?.focus();};
 const commit=async(order,focus)=>{
  const gen=viewGen,saving=orderSaver.save(order);orderNote='Ukládám…';rebuild(focus);
  const outcome=await saving;
  // A newer move or another account owns the screen now. A page opened since then only repaints a rollback.
  if(outcome==='stale'||outcome==='superseded')return;
  if(gen!==viewGen||!slot.isConnected){if(outcome==='failed')repaint?.();return;}
  if(outcome==='failed'){orderNote='Uložení selhalo, pořadí zůstalo původní.';rebuild(focus);return;}
  orderNote=order.length?'Uloženo pro tvůj účet.':'Zpět na výchozí pořadí.';
  const note=slot.querySelector('.home-order-note');if(note)note.textContent=t(orderNote);
 };
 function orderBar(){
  const saved=orderCache.get();
  // ⊕ Přidat zařízení sits next to the order button; a saved device reloads the tiles.
  const add=canEdit&&!editing?el('button',{type:'button',class:'hh-quiet',onclick:()=>openAddDevice({onSaved:()=>{load().then(()=>{built=false;paint();}).catch(()=>{});}})},t('⊕ Přidat zařízení')):null;
  if(!saved?.available)return el('div',{class:'home-orderbar'},add);
  if(!editing)return el('div',{class:'home-orderbar'},add,el('button',{type:'button',class:'hh-quiet',onclick:()=>{editing=true;orderNote='Přetáhni dlaždici myší, nebo ji posuň šipkami ↑ ↓.';rebuild();slot.querySelector('[data-move]:not([disabled])')?.focus();}},t('⇅ Upravit pořadí')));
  return el('div',{class:'home-orderbar on'},el('span',{class:'home-order-note',role:'status'},t(orderNote)),
   el('button',{type:'button',class:'hh-quiet',disabled:saved.order==null||saved.order.join()===cache.machines.map(m=>m.id).join()?'':null,onclick:()=>commit([],null)},t('Výchozí pořadí')),
   el('button',{type:'button',class:'hh-quiet hh-done',onclick:()=>{editing=false;orderNote='';rebuild();}},t('Hotovo')));
 }
 function reorderTile(m,i,list){
  const ids=list.map(x=>x.id),last=list.length-1;
  const move=(dir,label,to,off)=>el('button',{type:'button',class:'tile-move','data-move':`${m.id}:${dir}`,'aria-label':`${label}: ${m.name}`,title:label,disabled:off?'':null,onclick:()=>commit(moveId(ids,m.id,to),`${m.id}:${dir}`)},dir==='up'?'↑':'↓');
  const card=tile(m),box=el('div',{class:`${card.className} reorder`,draggable:'true','data-id':m.id,'aria-label':`${i+1}. ${m.name}`});
  box.append(...card.childNodes);
  box.prepend(el('div',{class:'tile-order'},el('span',{class:'tile-pos'},`${i+1}.`),move('up',t('Posunout dopředu'),i-1,i===0),move('down',t('Posunout dozadu'),i+1,i===last)));
  box.addEventListener('dragstart',e=>{e.dataTransfer.setData('text/plain',m.id);e.dataTransfer.effectAllowed='move';box.classList.add('dragging');});
  box.addEventListener('dragend',()=>{box.classList.remove('dragging');slot.querySelectorAll('.drop-before,.drop-after').forEach(n=>n.classList.remove('drop-before','drop-after'));});
  // One column (phone): above/below the middle; a grid: left/right of it.
  const after=e=>{const r=box.getBoundingClientRect();return getComputedStyle(box.parentNode).gridTemplateColumns.split(' ').length<2?e.clientY>r.top+r.height/2:e.clientX>r.left+r.width/2;};
  box.addEventListener('dragover',e=>{e.preventDefault();e.dataTransfer.dropEffect='move';const a=after(e);box.classList.toggle('drop-after',a);box.classList.toggle('drop-before',!a);});
  box.addEventListener('dragleave',()=>box.classList.remove('drop-before','drop-after'));
  box.addEventListener('drop',e=>{e.preventDefault();const id=e.dataTransfer.getData('text/plain');box.classList.remove('drop-before','drop-after');if(!ids.includes(id)||id===m.id)return;
   const rest=ids.filter(x=>x!==id),at=rest.indexOf(m.id)+(after(e)?1:0);commit(moveId(ids,id,at),null);});
  return box;
 }
 const orderReady=machineId||orderCache.get()?null:loadOrder();
 if(cache&&!orderReady)paint();else Promise.all([cache||load(),orderReady]).then(()=>{paint();arm();}).catch(()=>{slot.replaceChildren(el('div',{class:'src'},t('Data nejsou dostupná.')));});
 // Browser refresh follows the hub's Thermo pull interval (15/30/60 s).
 // Fetch right after the hub's next Thermo pull (lastPollAt + interval + 1.5 s), so data shown is
 // at most ~interval old instead of up to two intervals when the two clocks drift apart.
 let timer=null;
 const arm=()=>{
  clearTimeout(timer);
  const iv=(cache?.poll?.intervalSeconds||15)*1000,last=cache?.poll?.lastPollAt;
  const skew=cache?.generatedAt?Date.parse(cache.generatedAt)-Date.now():0;
  let wait=last?last+iv+1500-(Date.now()+skew):iv;if(!(wait>=1000))wait=iv;if(wait>iv+2000)wait=iv;
  timer=setTimeout(()=>{if(!slot.isConnected)return;load().then(paint).catch(()=>{}).finally(arm);},wait);
 };arm();
 return slot;
}
// The shell (top bar) shows freshness + interval switch; it listens for this event.
function notifyShell(){dispatchEvent(new CustomEvent('homedata',{detail:cache}));}
export async function setPollInterval(seconds){
 const r=await fetch('/api/home/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({intervalSeconds:seconds})});
 if(!r.ok)throw new Error('settings');cache=await r.json();notifyShell();return cache;
}
// Refresh button in the shell: asks the server to pull Thermo now, then repaints.
let repaint=null;
export async function refreshHome(){
 const lost=authGuard(),r=await fetch('/api/home/refresh',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
 if(!r.ok){lost(r);throw new Error('refresh');}cache=await r.json();historyCache.clear();repaint?.();return cache;
}
// Page entry for the shell (app.js): every page module exports (context) => Node, and the server's UI
// manifest names it. context = {me, page, sub, machine, site}.
export const homePage=({machine,me})=>homeView(machine||undefined,me);
