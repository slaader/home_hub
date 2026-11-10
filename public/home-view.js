// Overview: machine tiles (picture, state, hardware, live gauges, a 30-minute CPU trend) and one page per
// machine (telemetry charts and volumes, the runtime stack as a position-bound grid, local LLM runtimes).
// Renders /api/home. Machines come from the site configuration, from "Add device" here, or from an agent
// over MCP (machine_upsert); an empty hub says so and how to fill it. Live numbers need the telemetry agent
// (home-telemetry.js says what a machine shows without it). Deep link: #host-<id>/<stack block>.
// Text-safe DOM only: el() for HTML, svg() for drawings; colours come from the design tokens (home.css).
import {el,date} from './views.js';
import {SERIES,renderCharts,disposeCharts,loadECharts,level} from './home-charts.js';
import {onSessionReset,sessionCache,authGuard} from './session-cache.js';
import {createOrderSaver} from './home-order.js';
import {t,tp,locale,say} from './i18n.js';
import {openAddDevice,openEditDevice,removeDevice} from './home-add-device.js';
import {timeZone} from './site.js';
import {emptyState,pageHeader} from './ui.js';
import {statusPill,hasReadings,tileNotice,telemetryNotice,runtimesSection} from './home-telemetry.js';
// Adding, editing and removing devices needs write access (the server checks it again).
let canEdit=false,canAdmin=false;
let cache=null,historyCache=new Map(),state={machine:null,blk:null,range:'30m'};
// A different account must not be shown the previous one's tiles or history.
onSessionReset(()=>{cache=null;historyCache.clear();editing=false;orderNote='';});

// Tile order, per signed-in account on the server (GET/POST /api/profile/home-order, password sign-in
// only). Cached per principal like other account data; when it cannot be read, tiles keep the default
// order and "Reorder" is not offered.
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

const SVG_NS='http://www.w3.org/2000/svg';
function svg(tag,attrs={},...children){const n=document.createElementNS(SVG_NS,tag);for(const [k,v] of Object.entries(attrs))if(v!==undefined&&v!==null)n.setAttribute(k,v);n.append(...children.flat().filter(Boolean));return n;}
async function load(){const lost=authGuard(),r=await fetch('/api/home');if(!r.ok){lost(r);throw new Error('home');}cache=await r.json();return cache;}
async function loadHistory(machine,range,fresh=false){
 const key=`${machine}:${range}`;const hit=historyCache.get(key);if(!fresh&&hit&&Date.now()-hit.at<30000)return hit.value;
 const lost=authGuard(),r=await fetch(`/api/home/history?machine=${machine}&range=${range}`);if(!r.ok){lost(r);throw new Error('history');}
 const value=await r.json();historyCache.set(key,{at:Date.now(),value});return value;
}
const GiB=1073741824;
const size=b=>b==null?null:b>=1e12?`${Math.round(b/1e11)/10} TB`:`${Math.round(b/1e9)} GB`;
// Memory pressure from Thermo (build 97): 0 normal · 1 warning · 2 critical.
export const pressureName=v=>v==null?null:v>=2?t('kritický'):v>=1?t('zvýšený'):t('normální');
const pressureLevel=v=>v==null?'':v>=2?'crit':v>=1?'hot':'';
// The picture of a machine: its own (uploaded, or the site's), else the built-in one for what it is.
// The next candidate is tried when one fails to load.
const GENERIC={computer:'desktop',nas:'nas',router:'router'};
export function pictureChain(m){
 const own=m.image===undefined&&!m.added?`/images/home/${m.id}.jpg`:m.image;
 return [...new Set([own,m.picture,`/images/generic/${GENERIC[m.role]||GENERIC[m.kind==='thermo'?'computer':m.kind]||'generic'}.svg`].filter(Boolean))];
}
function art(m,cls='hv-art'){
 const chain=pictureChain(m);let i=0;
 const img=el('img',{src:chain[0],alt:'',loading:'lazy',decoding:'async',draggable:'false',onerror:()=>{i++;if(i<chain.length)img.src=chain[i];else img.remove();}});
 return el('div',{class:cls},img);
}

// Ring gauge: coloured arcs on a dim track, the value in the middle. Arc colours are classes (home.css).
function ring({segments,center,unit,label,sub,tone=''}){
 const r=26,c=2*Math.PI*r;let offset=0;
 const arcs=segments.filter(x=>x.pct>0).map(x=>{const len=Math.min(100,x.pct)/100*c;
  const arc=svg('circle',{class:`arc ${x.cls}`,r,cx:32,cy:32,'stroke-dasharray':`${len.toFixed(2)} ${(c-len).toFixed(2)}`,'stroke-dashoffset':(-offset).toFixed(2),transform:'rotate(-90 32 32)'});offset+=len;return arc;});
 return el('div',{class:`hv-gauge ${tone}`,role:'img','aria-label':`${label}: ${center??'–'} ${unit||''}${sub?.title?'. '+sub.title:''}`},
  el('span',{class:'hv-k'},label),
  el('div',{class:'hv-dial'},svg('svg',{viewBox:'0 0 64 64','aria-hidden':'true'},svg('circle',{class:'track',r,cx:32,cy:32}),arcs),
   el('div',{class:'hv-dial-v'},el('b',{},center??'–'),unit?el('small',{},unit):null)),
  el('span',{class:'hv-gauge-sub',title:sub?.title||null},sub?.text||' '));
}
const loadClass=v=>v>=75?'bad':v>=50?'warn':'good';
function macGauges(m){
 const q=m.quad||{};
 const cpu=q.cpu!=null?Math.round(q.cpu):null,gpu=q.gpu!=null?Math.round(q.gpu):null;
 // GPU holds = Metal allocations (model weights stay here while loaded); in-use = active working set.
 const total=q.memTotal||null,used=q.memUsed??null,gmem=q.gpuMemAlloc??q.gpuMem??null,gactive=q.gpuMemAlloc!=null?q.gpuMem:null;
 const usedPct=total&&used!=null?used/total*100:null,gpuPct=total&&gmem!=null?Math.min(usedPct??100,gmem/total*100):0;
 const memTone=pressureLevel(q.memPressure)||(usedPct!=null&&usedPct>=90?'hot':'');
 const memSub={text:gmem!=null?`GPU ${Math.round(gmem/GiB)} GB`:total?t('z {gb} GB',{gb:Math.round(total/GiB)}):'',
  title:gmem!=null?t('GPU drží {gb} GB (alokováno, např. načtený model){active}. Celkem RAM {total} GB.',{gb:Math.round(gmem/GiB),active:gactive!=null?t(', z toho právě aktivně {gb} GB',{gb:Math.round(gactive/GiB)}):'',total:total?Math.round(total/GiB):'?'}):t('Thermo na tomto Macu zatím neposílá paměť GPU (build < 97).')};
 const temp=q.temp!=null?Math.round(q.temp):null;
 const stat=(label,value,tone='')=>el('span',{class:tone},el('span',{class:'hv-k'},label),el('b',{},value));
 return el('div',{class:`hv-metrics${m.telemetry?.state==='stale'?' stale':''}`},
  el('div',{class:'hv-gauges'},
   ring({segments:[{pct:cpu??0,cls:loadClass(cpu??0)}],center:cpu,unit:'%',label:'CPU',tone:level('cpu',cpu)}),
   ring({segments:[{pct:gpu??0,cls:loadClass(gpu??0)}],center:gpu,unit:'%',label:'GPU',tone:level('gpu',gpu)}),
   ring({segments:[{pct:gpuPct,cls:'gpu'},{pct:Math.max(0,(usedPct??0)-gpuPct),cls:'mem'}],center:used!=null?Math.round(used/GiB):null,unit:'GB',label:t('Paměť'),sub:memSub,tone:memTone})),
  el('div',{class:'hv-stats'},
   stat(t('Příkon'),q.power!=null?`${Math.round(q.power)} W`:'–'),
   stat(t('Tepl.'),temp!=null?`${temp} °C`:'–',level('temp',temp)),
   stat(t('Tlak'),pressureName(q.memPressure)??'–',pressureLevel(q.memPressure))));
}
const cells=pairs=>el('div',{class:'hv-cells'},pairs.map(([k,v])=>el('div',{class:'hv-cell'},el('span',{class:'hv-k'},k),el('b',{},v==null?'–':String(v)))));
// What a tile shows under its hardware: live gauges, another feed's counts, or why there are no live numbers.
function liveBlock(m){
 const meta=cache?.telemetry;
 // Stale readings keep their last numbers (dimmed); with none left to show, the tile says since when.
 if(m.kind==='thermo')return hasReadings(m)&&(m.quad||m.telemetry?.state!=='stale')?macGauges(m):tileNotice(m,meta);
 if(m.kind==='router'){
  const q=m.quad;if(!q&&cache?.router?.status==='not-configured')return el('div',{class:'hv-tile-note dim'},el('b',{},t('Router není nastavený. Otevři dlaždici a uvidíš, co doplnit.')));
  if(!q)return el('div',{class:'hv-tile-note dim'},el('b',{},t('Router zatím nic nehlásí')),el('span',{},t('Počty klientů dodává adaptér routeru.')));
  return cells([[t('Klienti'),q.clients],['Wi-Fi',q.wifi]]);
 }
 if(m.kind==='nas'&&(m.services?.length||m.online!=='unknown'))return cells([[t('Služby'),m.services?.length||0],[t('Dostupné'),(m.services||[]).filter(s=>s.status==='reachable').length]]);
 return tileNotice(m,meta);
}
function propsLine(m){
 const p=m.props||{};
 const items=[['CPU',p.cpu],['GPU',p.gpu&&p.gpu!=='—'?p.gpu:null],['RAM',p.ramGb!=null?`${p.ramGb} GB`:null],[p.pools?t('Pooly'):'Disk',size(p.diskTotalBytes)]].filter(([,v])=>v);
 return items.length?el('dl',{class:'hv-props'},items.flatMap(([k,v])=>[el('dt',{},k),el('dd',{title:String(v)},String(v))])):null;
}
const hostLine=m=>[m.hostname,m.ip&&m.ip!==m.hostname?m.ip:null].filter(Boolean).join(' · ');
// What decides a tile's structure; while it stays the same a refresh only swaps the numbers.
const tileShape=m=>[m.kind,hasReadings(m),m.name,hostLine(m),m.image||m.picture||'',JSON.stringify(m.props||{})].join('|');
function tile(m){
 const prefetch=()=>{if(hasReadings(m))void loadHistory(m.id,state.range).catch(()=>{});void loadECharts().catch(()=>{});};
 const node=el('a',{class:'hv-tile',href:`#host-${m.id}`,'data-id':m.id,onmouseenter:prefetch,onfocus:prefetch},
  art(m),
  el('div',{class:'hv-tile-body'},
   el('div',{class:'hv-tile-head'},el('h3',{},m.name),statusPill(m)),
   el('p',{class:'hv-host'},hostLine(m)||' '),
   propsLine(m),
   el('div',{class:'hv-live'},liveBlock(m)),
   tileSpark(m)));
 node.dataset.shape=tileShape(m);return node;
}
// In-place refresh of one tile: state, gauges and trend; the picture and layout stay put.
function updateTile(node,m){
 if(node.dataset.shape!==tileShape(m)){node.replaceWith(tile(m));return;}
 node.querySelector('.hv-status')?.replaceWith(statusPill(m));
 node.querySelector('.hv-live')?.replaceChildren(...[liveBlock(m)].filter(Boolean));
 const spark=node.querySelector('.hv-trend');
 if(spark)loadHistory(m.id,'30m',true).then(h=>{spark.querySelector('.hv-spark,.hv-spark-empty')?.remove();spark.append(sparkline(h.points||[],p=>p.cpu,100));}).catch(()=>{});
}
// 30-minute CPU trend on tiles with readings (same history endpoint as the machine page, cached 30 s).
function tileSpark(m){
 if(!hasReadings(m))return null;
 const box=el('div',{class:'hv-trend'},el('span',{class:'hv-k'},t('CPU load · 30 min')));
 loadHistory(m.id,'30m').then(h=>{box.append(sparkline(h.points||[],p=>p.cpu,100));}).catch(()=>{});
 return box;
}
// One line in the CPU series colour on a 0–scale band with a mid rule; gaps in the data stay gaps.
function sparkline(points,pick,scale){
 const vals=points.map(pick).filter(v=>v!=null);if(!vals.length)return el('div',{class:'hv-spark-empty'},t('zatím žádná data'));
 const max=Math.max(scale||0,...vals)*1.08||1,w=300,h=44,pd=2;
 const x=i=>pd+i*(w-2*pd)/Math.max(1,points.length-1),y=v=>h-pd-(v/max)*(h-2*pd);
 let d='',open=false;
 points.forEach((p,i)=>{const v=pick(p);if(v==null){open=false;return;}d+=(open?'L':'M')+x(i).toFixed(1)+' '+y(v).toFixed(1)+' ';open=true;});
 const mid=y((scale||max)/2).toFixed(1);
 return svg('svg',{class:'hv-spark',viewBox:`0 0 ${w} ${h}`,preserveAspectRatio:'none',role:'img','aria-label':t('CPU za posledních 30 minut, teď {v} %',{v:Math.round(vals.at(-1))})},
  svg('line',{class:'rule',x1:pd,x2:w-pd,y1:mid,y2:mid}),svg('path',{class:'line',d:d.trim()}));
}

// --- machine page: runtime stack ---------------------------------------------------------------
function overlap(a,b){return !(a.col1<b.col0||b.col1<a.col0);}
// Layers of a published stack carry keys (translated here); a site's own stack names its layers itself.
const LAYER_LABEL={input:'VSTUP',tool:'NÁSTROJ',runtime:'RUNTIME',engine:'ENGINE',hardware:'HARDWARE'};
const layerName=(stack,i)=>stack.layerKeys?.[i]?t(LAYER_LABEL[stack.layerKeys[i]]):t(stack.layers[i]||'');
// Engine families with a colour of their own (home.css); any other column key uses the accent.
const ENGINES=['gguf','mlx','torch','mix','edge','media','cloud','dev','share','net'];
const engineClass=key=>ENGINES.includes(key)?` eng-${key}`:'';
// Detail panel beside the grid: empty hint until a block is picked, then the block's story.
let animatePanel=false;
function stackPanel(machine,blk){
 const still=animatePanel?'':' still';
 if(!blk)return el('aside',{class:'hv-panel empty'+still},
  el('div',{class:'hv-panel-icon','aria-hidden':'true'},el('i'),el('i'),el('i')),
  el('b',{},t('Vyber blok v diagramu')),
  el('span',{},t('Ukáže se, na čem stojí, co je nad ním, port, stav a modely.')));
 const stack=machine.stack;
 const below=stack.blocks.filter(b=>b.layer===blk.layer+1&&overlap(b,blk));
 const above=stack.blocks.filter(b=>b.layer===blk.layer-1&&overlap(b,blk));
 const models=blk.models||[];
 const chip=b=>el('button',{type:'button',class:`hv-chip ${b.state==='off'?'off':''}`,onclick:()=>selectBlock(machine,b.id)},t(b.title));
 const sec=(label,...body)=>el('div',{class:'hv-panel-sec'},el('span',{class:'hv-k'},label),...body);
 return el('aside',{class:`hv-panel${still}${blk.engine||blk.hw?'':engineClass(stack.cols[blk.col0])}`},
  el('div',{class:'hv-panel-head'},
   el('div',{},el('span',{class:'hv-k'},layerName(stack,blk.layer)),el('h3',{},t(blk.title))),
   el('button',{type:'button',class:'hv-close','aria-label':t('Zavřít detail'),onclick:()=>selectBlock(machine,blk.id)},'×')),
  el('div',{class:'hv-badges'},
   blk.hw||blk.engine?null:el('span',{class:`hv-status ${blk.state==='off'?'dim':'ok'}`},el('i',{'aria-hidden':'true'}),blk.state==='off'?t('vypnuto'):t('běží')),
   blk.port?el('span',{class:'hv-badge'},say(blk.port,blk.portT)):null,
   stack.engines?.[stack.cols[blk.col0]]&&!blk.hw?el('span',{class:'hv-badge'},t(stack.engines[stack.cols[blk.col0]])):null),
  blk.desc?el('p',{class:'hv-panel-desc'},say(blk.desc,blk.descT)):null,
  sec(t('Stojí na'),el('div',{class:'hv-chips'},below.length?below.map(chip):el('span',{class:'hv-none'},t('— nejspodnější vrstva')))),
  sec(t('Nad ním'),el('div',{class:'hv-chips'},above.length?above.map(chip):el('span',{class:'hv-none'},t('— nic')))),
  blk.stats&&blk.stats.requests!=null?sec(t('Provoz'),el('span',{class:'hv-v'},`${tp(blk.stats.requests,'{n} request|{n} requesty|{n} requestů')} · uptime ${Math.round((blk.stats.uptimeSeconds||0)/3600)} h`)):null,
  blk.pool?sec(t('Rozpočet paměti'),el('span',{class:'hv-v'},`${blk.pool.allocatedGb} / ${blk.pool.capacityGb} GB`)):null,
  sec(t('Modely · {n}',{n:models.length}),
   models.length?el('ul',{class:'hv-models'},models.map(m=>el('li',{class:m.state==='loaded'?'loaded':m.state==='loading'?'loading':''},
    el('div',{},m.id,m.sizeGb?` · ${m.sizeGb} GB`:'',m.ttlRemainingSeconds?` · TTL ${Math.round(m.ttlRemainingSeconds/60)} min`:''),m.path?el('small',{},m.path):null))):el('span',{class:'hv-none'},t('žádné'))));
}
function stackGrid(machine){
 const stack=machine.stack,cols=stack.cols.length;
 const grid=el('div',{class:'hv-stack'});grid.style.gridTemplateColumns=`64px repeat(${cols},minmax(84px,1fr))`;
 const layerCount=Math.max(...stack.blocks.map(b=>b.layer))+1,chosen=stack.blocks.find(x=>x.id===state.blk)||null;
 for(let L=0;L<layerCount;L++){
  grid.append(el('div',{class:'hv-layer'},layerName(stack,L)));
  const placed=stack.blocks.filter(b=>b.layer===L);
  for(let c=0;c<cols;c++){
   const b=placed.find(b=>c>=b.col0&&c<=b.col1);
   // A column with nothing on this row is a dashed gap: "nothing in between" is information too.
   if(!b){const gap=el('div',{class:'hv-gap'},t('NIC'));gap.style.gridColumnStart=String(c+2);grid.append(gap);continue;}
   if(b.col0!==c)continue;
   const sel=state.blk===b.id?' sel':'',rel=chosen&&chosen.id!==b.id&&overlap(chosen,b)?' rel':'';
   const btn=el('button',{type:'button',class:`hv-blk${b.engine?' engine':''}${b.hw?' hw':''}${b.state==='off'?' off':''}${sel}${rel}${b.engine||b.hw?'':engineClass(stack.cols[b.col0])}`,'aria-pressed':String(state.blk===b.id),onclick:()=>selectBlock(machine,b.id)},
    el('b',{},t(b.title)),el('small',{},say(b.port||'',b.portT)),b.state!=='off'&&!b.hw&&!b.engine?el('i',{class:'dot','aria-hidden':'true'}):null);
   btn.style.gridColumnStart=String(c+2);btn.style.gridColumnEnd=String(b.col1+3);grid.append(btn);
  }
 }
 return el('div',{class:'hv-stack-layout',id:'hv-stack-slot'},el('div',{class:'hv-stack-main'},el('div',{class:'hv-stack-wrap'},grid),
  el('div',{class:'hv-legend'},
   ...Object.entries(stack.engines||{}).map(([k,v])=>el('span',{class:engineClass(k).trim()},el('i',{'aria-hidden':'true'}),t(v))),
   el('span',{},el('i',{class:'gap','aria-hidden':'true'}),t('nic mezi tím')),
   el('span',{},el('i',{class:'gap off','aria-hidden':'true'}),t('vypnuto (schopnost bez bloku)')))),
  stackPanel(machine,chosen));
}
function selectBlock(machine,id){
 state.blk=state.blk===id?null:id;
 history.replaceState(null,'',`#host-${machine.id}${state.blk?'/'+state.blk:''}`);
 const old=document.querySelector('#hv-stack-slot');
 animatePanel=true;const fresh=stackGrid(machine);animatePanel=false;
 if(old)old.replaceWith(fresh);
}
addEventListener('keydown',e=>{if(e.key==='Escape'&&state.blk&&document.querySelector('#hv-stack-slot')){const m=cache?.machines.find(x=>location.hash.startsWith(`#host-${x.id}`));if(m)selectBlock(m,state.blk);}});
const stamp=iso=>{const ms=Date.parse(iso);return Number.isFinite(ms)?new Intl.DateTimeFormat(locale(),{day:'numeric',month:'numeric',hour:'2-digit',minute:'2-digit',timeZone:timeZone()}).format(new Date(ms)):'';};
// Where the drawn stack comes from: published by an agent, collected on the machine, or the site configuration.
function stackSource(m){
 const s=m.stack;if(!s)return null;
 if(s.source==='published')return t('zveřejnil {who} · {when}',{who:s.publishedBy||'API',when:stamp(s.publishedAt)});
 if(s.source==='collected')return t('sebráno ze stroje · {when}',{when:stamp(m.collectedAt)});
 return t('z konfigurace webu');
}
function stackSection(m){
 if(m.stack)return section(t('Runtime stack'),stackSource(m),stackGrid(m));
 return section(t('Runtime stack'),null,emptyState({icon:'▤',title:t('Runtime stack zatím není'),
  body:t('Vrstvený diagram toho, co na stroji běží: od API, které volají klienti, přes routery a servery modelů až po čip. Zveřejní ho agent, který stroj zná.'),
  agentPrompt:t('Popiš runtime stack stroje „{id}“ v Home Hubu. Připoj se přes MCP klíčem servisního účtu se scopes read a home:write. Zjisti, co na stroji běží (brány a API, llama-swap, Ollama, LM Studio, llama.cpp, vLLM a podobně, na jakých portech, s jakými modely) a zveřejni to nástrojem runtime_publish: vrstvy input, tool, runtime, engine, hardware, jeden sloupec na rodinu enginu. Nezapisuj žádná hesla, tokeny ani klíče. Nakonec výsledek ověř nástrojem machine_list s runtime: true.',{id:m.id})}));
}

// --- machine page ------------------------------------------------------------------------------
const RANGES={'30m':'30 min','7d':'7 dní','30d':'30 dní','6m':'6 měsíců'};
const ROLES={computer:'počítač',nas:'NAS',router:'router',other:'jiné zařízení'};
const section=(title,sub,...body)=>el('section',{class:'hv-sec'},el('div',{class:'hv-sec-head'},el('h2',{},title),sub?el('p',{},sub):null),...body.flat().filter(Boolean));
function sourceBadge(m){
 if(m.source==='site')return el('span',{class:'hv-badge',title:t('Stroj je zapsaný v local/site.json; přes API a tady v přehledu se nemění.')},t('z konfigurace webu'));
 const when=m.createdAt?stamp(m.createdAt):'';
 return el('span',{class:'hv-badge',title:when||null},m.source==='agent'?t('přidal agent {name}',{name:m.createdBy||'API'}):t('přidáno v přehledu'));
}
// Machine header: picture and name left, hardware right — small labels, highlighted values.
function hostProps(m){
 const p=m.props||{};
 const items=[['CPU',p.cpu],['GPU',p.gpu&&p.gpu!=='—'?p.gpu:null],['RAM',p.ramGb!=null?`${p.ramGb} GB`:null],[p.pools?t('Pooly'):'Disk',size(p.diskTotalBytes)],['IP',m.ip]].filter(([,v])=>v);
 return items.length?el('dl',{class:'hv-host-props'},items.map(([k,v])=>el('div',{},el('dt',{},k),el('dd',{},String(v))))):null;
}
function volumes(m){
 if(!m.volumes?.length)return null;
 return el('div',{class:'hv-volumes'},el('span',{class:'hv-k'},t('Disky')),m.volumes.map(v=>{
  const pct=v.sizeBytes&&v.usedBytes!=null?Math.min(100,Math.round(v.usedBytes/v.sizeBytes*100)):null;
  const bar=el('div',{class:`hv-bar${pct!=null&&pct>=90?' hot':''}`,role:'img','aria-label':pct!=null?t('{name}: obsazeno {pct} %',{name:v.name||v.mount,pct}):v.name||v.mount},el('i'));
  bar.firstChild.style.width=`${pct??0}%`;
  return el('div',{class:'hv-volume'},el('div',{},el('b',{},v.name||v.mount),el('span',{},`${size(v.usedBytes)??'–'} / ${size(v.sizeBytes)??'–'}${pct!=null?` · ${pct} %`:''}`)),bar);}));
}
function services(m){
 if(m.kind!=='nas'||!m.services?.length)return null;
 return el('div',{class:'hv-services'},el('span',{class:'hv-k'},t('Služby')),el('div',{class:'hv-chips'},m.services.map(s=>el('span',{class:`hv-status ${s.status==='reachable'?'ok':'dim'}`},el('i',{'aria-hidden':'true'}),s.name||s.id))));
}
// What must be drawn again when it changes; anything else is refreshed in place.
const hostShape=m=>[m.name,hostLine(m),m.telemetry?.state,m.telemetry?.reason,m.hash||'',m.image||m.picture||'',Boolean(m.stack),m.stack?.source,m.stack?.hash||'',m.runtimes?JSON.stringify(m.runtimes).length:0,canEdit].join('|');
function renderChild(slot,machine,{repaint:again,focus}={}){
 disposeCharts();childCards=null;
 const meta=cache?.telemetry;
 const reload=()=>load().then(()=>{built=false;again?.();}).catch(()=>{});
 const edit=part=>openEditDevice({machine,meta,focus:part,onSaved:reload});
 const actions=machine.added&&canEdit?el('div',{class:'ui-head-actions'},
  el('button',{type:'button',class:'ui-button',onclick:()=>edit()},t('Upravit zařízení')),
  el('button',{type:'button',class:'ui-button hv-danger',onclick:async e=>{const b=e.currentTarget;b.disabled=true;
    try{if(await removeDevice(machine)){cache=null;historyCache.clear();location.hash='#overview';}else b.disabled=false;}catch{b.disabled=false;}}},t('Odebrat zařízení'))):null;
 const head=el('header',{class:'hv-host-head'},
  el('a',{href:'#overview',class:'hv-back'},t('← přehled')),
  el('div',{class:'hv-host-main'},art(machine,'hv-host-art'),
   el('div',{class:'hv-host-title'},el('h1',{},machine.name),el('p',{class:'hv-host'},hostLine(machine)||' '),
    el('div',{class:'hv-badges'},statusPill(machine),el('span',{class:'hv-badge'},t(ROLES[machine.role]||ROLES.other)),sourceBadge(machine),
     machine.collectedAt?el('span',{class:'hv-badge'},t('sebráno {when}',{when:date(machine.collectedAt)})):null)),
   actions),
  hostProps(machine));
 const notice=telemetryNotice(machine,meta,{onConnect:machine.added&&canEdit?()=>edit('telemetry'):null});
 const telemetry=[notice];
 if(hasReadings(machine)){
  const bar=el('div',{class:'hv-ranges',role:'group','aria-label':t('Období grafů')},...Object.entries(RANGES).map(([r,label])=>el('button',{type:'button',class:state.range===r?'on':'','aria-pressed':String(state.range===r),
   onclick:()=>{state.range=r;renderChild(slot,latest(machine.id)||machine,{repaint:again});},onmouseenter:()=>void loadHistory(machine.id,r).catch(()=>{})},t(label))));
  const source=el('span',{class:'hv-source'});
  const cards=SERIES.map(def=>{const value=el('div',{class:'hv-val'},'–'),sub=el('div',{class:'hv-chart-sub'}),node=el('div',{class:'hv-chart'});
   // Two lines in one chart (memory and what the GPU holds of it) need a legend; one line is named by the title.
   const legend=def.extra?el('div',{class:'hv-chart-legend'},el('span',{class:`key-${def.key}`},el('i',{'aria-hidden':'true'}),t(def.title).split(' ·')[0]),el('span',{class:'key-gpu'},el('i',{'aria-hidden':'true'}),t(def.extra.name))):null;
   return {def,value,sub,node,card:el('article',{class:`hv-card key-${def.key}`},el('h3',{},el('i',{'aria-hidden':'true'}),t(def.title)),value,sub,legend,node)};});
  childCards=cards;
  telemetry.push(el('div',{class:'hv-chartbar'},bar,source),el('div',{class:'hv-charts'},cards.map(c=>c.card)),volumes(machine));
  const gen=++viewGen;
  loadHistory(machine.id,state.range).then(h=>{if(gen!==viewGen)return;const since=h.coverageSeconds?new Date(Date.now()-h.coverageSeconds*1000):null;
   source.textContent=`${t(h.source||'')}${h.complete===false&&since?t(' · data teprve od {when}',{when:stamp(since.toISOString())}):''}`;return renderCharts(cards,h,state.range,machine.quad||{});})
   .catch(()=>{source.textContent=t('Historie nedostupná.');});
 }else if(machine.kind==='router'){
  const q=machine.quad;
  telemetry.push(el('p',{class:'hv-note'},t('Router nemá telemetrického agenta: počty klientů dodává adaptér routeru.')),q?cells([[t('Klienti'),q.clients],['Wi-Fi',q.wifi]]):null);
 }else telemetry.push(services(machine));
 slot.replaceChildren(head,
  section(t('Telemetrie'),hasReadings(machine)?t('Živá čísla a historie z agenta {name}.',{name:meta?.agent||'Thermo'}):null,telemetry),
  stackSection(machine),
  machine.kind==='router'?null:section(t('Lokální LLM runtimy'),machine.runtimes?null:t('Místo pro to, co o runtimech na stroji ohlásí telemetrický agent.'),runtimesSection(machine,meta)));
 slot.dataset.shape=hostShape(machine);
 // The router's machine page ends with the adapter's census and health (router-view.js, module "router").
 if(machine.kind==='router')import('./router-view.js').then(v=>{if(slot.isConnected)slot.append(v.routerPanel());}).catch(()=>{});
 if(focus)slot.querySelector('h1')?.focus?.();
}
let childCards=null,viewGen=0,built=false;
const latest=id=>cache?.machines.find(x=>x.id===id);
// Machine page refresh: new numbers into the existing chart instances (no rebuild, no jump).
function refreshChild(slot,machine,again){
 if(slot.dataset.shape!==hostShape(machine)){renderChild(slot,machine,{repaint:again});return;}
 slot.querySelector('.hv-host-head .hv-status')?.replaceWith(statusPill(machine));
 if(childCards){const gen=viewGen,cards=childCards,range=state.range;
  loadHistory(machine.id,range,true).then(h=>{if(gen!==viewGen)return;return renderCharts(cards,h,range,machine.quad||{},{keep:true});}).catch(()=>{});}
 // Services/models change while the page is open: rebuild the stack from the latest data
 // (selection kept, no panel animation).
 const old=document.querySelector('#hv-stack-slot');if(old&&machine.stack)old.replaceWith(stackGrid(machine));
}

// --- overview ----------------------------------------------------------------------------------
// A hub without machines: what belongs here and the two ways to fill it (by hand, or through an agent).
function emptyOverview(add){
 const name=cache?.telemetry?.agent||'Thermo';
 return emptyState({icon:'◇',title:t('Vítej v Home Hubu. Přehled je zatím prázdný'),
  body:t('Přehled ukazuje stroje tvé sítě jako dlaždice: stav, parametry a s telemetrickým agentem i živé CPU, GPU, paměť, příkon a teploty. Každý stroj má stránku s grafy a runtime stackem. Naplnit ho jde dvěma způsoby.'),
  steps:[canEdit?t('Ručně: tlačítkem Přidat zařízení zadej název, adresu a vyber obrázek. Živá čísla připojíš kdykoli později.'):t('Ručně: zařízení přidává účet s právem zápisu tlačítkem Přidat zařízení.'),
   t('Přes agenta: v Uživatelé a API založ servisní účet se scopes read a home:write, připoj kódovacího agenta přes MCP (níže) a dej mu zadání.'),
   t('Živé metriky jsou volitelné: dodává je agent {name}, který běží na každém stroji. Dlaždice bez něj řekne, jak ho nainstalovat.',{name})],
  agentPrompt:t('Naplň přehled tohoto Home Hubu. Připoj se přes MCP klíčem servisního účtu se scopes read a home:write. Nejdřív zavolej machine_list: uvidíš, co v přehledu je, jaké obrázky a role jsou k dispozici a do jakých sítí musí IP adresy patřit. Zeptej se mě, jaké stroje mám (název, hostname, IP, role: computer, nas, router nebo other, CPU, GPU, RAM), a každý založ nástrojem machine_upsert s vhodným obrázkem. Ke stroji, na kterém běží lokální AI, zveřejni runtime stack nástrojem runtime_publish (vrstvy input, tool, runtime, engine, hardware). Do žádného pole nepiš hesla, tokeny ani klíče. Nakonec zavolej machine_list a shrň, co jsi přidal.'),
  mcpSnippet:true,
  actions:[canEdit?{label:t('⊕ Přidat zařízení'),onclick:add,primary:true}:null,canAdmin?{label:t('Uživatelé a API'),href:'#access'}:null]});
}
const summary=list=>{const counted=list.filter(m=>m.telemetry?.state!=='not-applicable'),ok=counted.filter(m=>m.telemetry?.state==='ok').length;
 return `${tp(list.length,'{n} stroj|{n} stroje|{n} strojů')} · ${t('telemetrie běží na {ok} z {all}',{ok,all:counted.length})}`;};
export function homeView(machineId,me){
 editing=false;orderNote='';canEdit=me?.canWrite===true;canAdmin=me?.canAdmin===true;
 viewGen++;disposeCharts();childCards=null;built=false;
 const slot=el('div',{id:'home-slot',class:'hv-page'});
 const loading=text=>el('p',{class:'hv-loading',role:'status'},text);
 const reload=()=>load().then(()=>{built=false;paint();}).catch(()=>{});
 const add=()=>openAddDevice({meta:cache?.telemetry,onSaved:reload});
 const paint=()=>{
  notifyShell();
  if(!cache){slot.replaceChildren(loading(t('Načítám data domovské stránky…')));return;}
  if(!machineId){
   const list=orderedMachines(cache.machines,orderCache.get()?.order);
   // A hub without machines yet: say what belongs here and how to add it.
   if(!list.length){const head=pageHeader({eyebrow:t('Domov'),title:t('Přehled'),lead:t('Stroje, jejich stav a živé metriky na jednom místě.')});head.append(headActions());
    slot.replaceChildren(head,emptyOverview(add));built=false;return;}
   const grid=slot.querySelector('.hv-tiles');
   const ids=list.map(m=>m.id).join(',')+(editing?'|edit':'');
   if(built&&grid&&grid.dataset.ids===ids){
    const lead=slot.querySelector('.ui-lead');if(lead)lead.textContent=summary(list);
    if(!editing)for(const m of list){const n=grid.querySelector(`[data-id="${m.id}"]`);if(n)updateTile(n,m);}
    return;}
   const g=el('div',{class:`hv-tiles${editing?' reordering':''}`},list.map((m,i)=>editing?reorderTile(m,i,list):tile(m)));g.dataset.ids=ids;
   const head=pageHeader({eyebrow:t('Domov'),title:t('Přehled'),lead:summary(list)});head.append(headActions());
   slot.replaceChildren(head,...[orderBar()].filter(Boolean),g);built=true;return;
  }
  const machine=cache.machines.find(m=>m.id===machineId);
  if(!machine){slot.replaceChildren(emptyState({icon:'◌',title:t('Neznámý stroj.'),body:t('Stroj s tímhle id v přehledu není. Mohl být odebrán.'),actions:[{label:t('← přehled'),href:'#overview',primary:true}]}));return;}
  if(built&&slot.querySelector('.hv-host-head')){refreshChild(slot,machine,paint);return;}
  const hash=(location.hash.split('/')[1]||'').replace(/[^a-z0-9_-]/g,'');
  state.blk=hash||null;
  renderChild(slot,machine,{repaint:paint});built=true;
 };
 repaint=paint;
 // Reorder mode: drag and drop with a mouse; ↑/↓ buttons, or the arrow keys on a focused tile, for keyboard,
 // touch and phones. Every move shows at once and is saved one at a time, newest wins; a failed save goes
 // back to the last saved order (home-order.js).
 const rebuild=focus=>{built=false;paint();if(!focus)return;
  const target=focus.startsWith('tile:')?slot.querySelector(`.hv-tile[data-id="${focus.slice(5)}"]`):slot.querySelector(`[data-move="${focus}"]:not([disabled])`)||slot.querySelector(`[data-move^="${focus.split(':')[0]}:"]:not([disabled])`);
  target?.focus();};
 const commit=async(order,focus)=>{
  const gen=viewGen,saving=orderSaver.save(order);orderNote='Ukládám…';rebuild(focus);
  const outcome=await saving;
  // A newer move or another account owns the screen now. A page opened since then only repaints a rollback.
  if(outcome==='stale'||outcome==='superseded')return;
  if(gen!==viewGen||!slot.isConnected){if(outcome==='failed')repaint?.();return;}
  if(outcome==='failed'){orderNote='Uložení selhalo, pořadí zůstalo původní.';rebuild(focus);return;}
  orderNote=order.length?'Uloženo pro tvůj účet.':'Zpět na výchozí pořadí.';
  const note=slot.querySelector('.hv-order-note');if(note)note.textContent=t(orderNote);
 };
 // Top right of the header: Add device and Reorder; in reorder mode the bar below takes over.
 function headActions(){
  const saved=orderCache.get(),button=(label,onclick,cls='')=>el('button',{type:'button',class:`ui-button${cls}`,onclick},label);
  return el('div',{class:'ui-head-actions'},editing?null:[
   saved?.available&&cache.machines.length>1?button(t('⇅ Upravit pořadí'),()=>{editing=true;orderNote='Přetáhni dlaždici myší, nebo ji posuň šipkami ↑ ↓.';rebuild();slot.querySelector('[data-move]:not([disabled])')?.focus();}):null,
   canEdit?button(t('⊕ Přidat zařízení'),add,' primary'):null]);
 }
 function orderBar(){
  if(!editing)return null;
  const saved=orderCache.get();
  return el('div',{class:'hv-orderbar'},el('span',{class:'hv-order-note',role:'status'},t(orderNote)),
   el('button',{type:'button',class:'ui-button',disabled:saved?.order==null||saved.order.join()===cache.machines.map(m=>m.id).join()?'':null,onclick:()=>commit([],null)},t('Výchozí pořadí')),
   el('button',{type:'button',class:'ui-button primary',onclick:()=>{editing=false;orderNote='';rebuild();}},t('Hotovo')));
 }
 function reorderTile(m,i,list){
  const ids=list.map(x=>x.id),last=list.length-1;
  const move=(dir,label,to,off)=>el('button',{type:'button',class:'hv-move','data-move':`${m.id}:${dir}`,'aria-label':`${label}: ${m.name}`,title:label,disabled:off?'':null,onclick:()=>commit(moveId(ids,m.id,to),`${m.id}:${dir}`)},dir==='up'?'↑':'↓');
  const card=tile(m),box=el('div',{class:`${card.className} reorder`,draggable:'true',tabindex:'0','data-id':m.id,role:'group','aria-label':t('{pos}. {name} — šipky mění pořadí',{pos:i+1,name:m.name})});
  box.append(...card.childNodes);
  box.prepend(el('div',{class:'hv-order'},el('span',{class:'hv-pos'},`${i+1}.`),move('up',t('Posunout dopředu'),i-1,i===0),move('down',t('Posunout dozadu'),i+1,i===last)));
  // Arrow keys on the tile itself: left/up = earlier, right/down = later; Home and End jump to the ends.
  box.addEventListener('keydown',e=>{if(e.target!==box)return;
   const to={ArrowLeft:i-1,ArrowUp:i-1,ArrowRight:i+1,ArrowDown:i+1,Home:0,End:last}[e.key];if(to===undefined)return;e.preventDefault();
   if(to<0||to>last||to===i)return;commit(moveId(ids,m.id,to),`tile:${m.id}`);});
  box.addEventListener('dragstart',e=>{e.dataTransfer.setData('text/plain',m.id);e.dataTransfer.effectAllowed='move';box.classList.add('dragging');});
  box.addEventListener('dragend',()=>{box.classList.remove('dragging');slot.querySelectorAll('.drop-before,.drop-after').forEach(n=>n.classList.remove('drop-before','drop-after'));});
  // One column (phone): above/below the middle; a grid: left/right of it.
  const after=e=>{const r=box.getBoundingClientRect();return getComputedStyle(box.parentNode).gridTemplateColumns.split(' ').length<2?e.clientY>r.top+r.height/2:e.clientX>r.left+r.width/2;};
  box.addEventListener('dragover',e=>{e.preventDefault();e.dataTransfer.dropEffect='move';const a=after(e);box.classList.toggle('drop-after',a);box.classList.toggle('drop-before',!a);});
  box.addEventListener('dragleave',()=>box.classList.remove('drop-before','drop-after'));
  box.addEventListener('drop',e=>{e.preventDefault();const id=e.dataTransfer.getData('text/plain');box.classList.remove('drop-before','drop-after');if(!ids.includes(id)||id===m.id)return;
   const rest=ids.filter(x=>x!==id),at=rest.indexOf(m.id)+(after(e)?1:0);commit(moveId(ids,id,at),`tile:${id}`);});
  return box;
 }
 const orderReady=machineId||orderCache.get()?null:loadOrder();
 const failed=()=>slot.replaceChildren(emptyState({icon:'⚠',title:t('Data nejsou dostupná.'),body:t('Home Hub teď přehled nevrátil. Zkus to znovu.'),actions:[{label:t('Zkusit znovu'),onclick:()=>{slot.replaceChildren(loading(t('Načítám data domovské stránky…')));load().then(paint).catch(failed);},primary:true}]}));
 if(cache&&!orderReady)paint();else{slot.replaceChildren(loading(t('Načítám data domovské stránky…')));Promise.all([cache||load(),orderReady]).then(()=>{paint();arm();}).catch(failed);}
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
