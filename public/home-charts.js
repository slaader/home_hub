// Device page charts on Apache ECharts (vendored, CSP 'self'). Each card shows the current value,
// average and peak for the window, with reference lines (100 %, total memory, thermal limit) so
// the line is readable against something. Tooltips are plain text: CSP forbids inline styles.
// Colours are not written here: each measure has a series token (--home-cpu, … in home.css, one fixed
// hue per measure in every chart and gauge) and the chart chrome reads the design tokens of tokens.css.
// Labels and values stay in text colours; only the mark carries the series colour.
import {t,locale} from './i18n.js';
import {timeZone} from './site.js';
let lib=null;
export const loadECharts=()=>lib??=import('/vendor/echarts.esm.min.mjs');
let live=[];let observer=null;
const sparks=new Map();let sparkObserver=null;// tile node → its small chart (renderSpark)
// What each live chart was last drawn from, so it can be drawn again when the theme changes: the colours
// were resolved from the tokens when the option was built, and a canvas does not follow CSS.
const drawn=new WeakMap();
export function repaintCharts(){for(const chart of [...live,...sparks.values()]){const again=drawn.get(chart);if(again)try{chart.setOption(again(),{notMerge:true,lazyUpdate:true});}catch{}}}
globalThis.addEventListener?.('themechange',repaintCharts);
// A design token as a colour string for the canvas (ECharts cannot read CSS variables itself).
const FALLBACK={'--home-cpu':'#d95926','--home-gpu':'#9085e9','--home-mem':'#199e70','--home-power':'#c98500','--home-temp':'#d55181',
 '--color-text':'#eceaf4','--color-text-dim':'#a39fb5','--color-text-faint':'#6f6b82','--color-border':'#2b2937','--color-border-strong':'#403d52','--color-surface-raised':'#1a1924','--color-bad':'#ff7a85'};
export function token(name){
 let value='';try{value=getComputedStyle(document.documentElement).getPropertyValue(name).trim();}catch{}
 return value||FALLBACK[name]||'#888888';
}
// #rrggbb + opacity → rgba(); anything else is returned as it is.
export const alpha=(color,a)=>{const m=/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);return m?`rgba(${parseInt(m[1],16)},${parseInt(m[2],16)},${parseInt(m[3],16)},${a})`:color;};
export function disposeCharts(){for(const c of live)try{c.dispose();}catch{}live=[];observer?.disconnect();observer=null;}

const GB=1073741824;
export const gpuDefaultLimit=totalGb=>totalGb==null?null:totalGb*(totalGb>36?0.75:2/3);
const round=(v,d=0)=>v==null?null:Math.round(v*10**d)/10**d;
const fmt=(v,unit)=>v==null?'–':`${unit==='GB'?round(v,1):round(v,unit==='W'?1:0)}`;
// Label by the span actually shown: under ~1.5 days → clock time, otherwise day.month.
const timeLabel=(ms,range,span)=>{const d=new Date(ms);const o=range==='30m'||span<36*3600e3?{hour:'2-digit',minute:'2-digit'}:range==='7d'&&false?{hour:'2-digit',minute:'2-digit'}:range==='7d'?{weekday:'short',day:'numeric'}:{day:'numeric',month:'numeric'};return new Intl.DateTimeFormat(locale(),{...o,timeZone:timeZone()}).format(d);};

export function level(key,v){
 if(v==null)return '';
 if(key==='cpu'||key==='gpu')return v>=75?'crit':'';
 if(key==='temp')return v>80?'crit':v>60?'hot':'';
 return '';
}
export const SERIES=[
 {key:'cpu',live:q=>q.cpu,title:'CPU load',unit:'%',color:'--home-cpu',ceiling:()=>100,ceilingLabel:'100 %',pick:p=>p.cpu,peak:p=>p.cpuMax},
 {key:'gpu',live:q=>q.gpu,title:'GPU load',unit:'%',color:'--home-gpu',ceiling:()=>100,ceilingLabel:'100 %',pick:p=>p.gpu,peak:p=>p.gpuMax},
 {key:'mem',extra:{name:'GPU drží',color:'--home-gpu',pick:p=>(p.gpuMemAlloc??p.gpuMem)!=null?(p.gpuMemAlloc??p.gpuMem)/GB:null},liveGpu:q=>(q.gpuMemAlloc??q.gpuMem)!=null?(q.gpuMemAlloc??q.gpuMem)/GB:null,live:q=>q.memUsed!=null?q.memUsed/GB:null,liveTotal:q=>q.memTotal?q.memTotal/GB:null,title:'Paměť · sjednocená (CPU + GPU)',unit:'GB',color:'--home-mem',pick:p=>p.memUsed!=null?p.memUsed/GB:null,
  ceiling:pts=>{const tot=pts.map(p=>p.memTotal).filter(v=>v!=null);return tot.length?Math.max(...tot)/GB:null;},ceilingLabel:'celkem'},
 {key:'power',live:q=>q.power,title:'Příkon',unit:'W',color:'--home-power',pick:p=>p.power,peak:p=>p.powerMax},
 {key:'temp',live:q=>q.temp,title:'Teplota',unit:'°C',color:'--home-temp',pick:p=>p.temp,peak:p=>p.tempMax,limit:95,limitLabel:'throttling ~95 °C'}];

function stats(pts,pick,peak){
 const vals=pts.map(pick).filter(v=>v!=null);
 const peaks=peak?pts.map(peak).filter(v=>v!=null):[];
 return {last:vals.length?vals.at(-1):null,avg:vals.length?vals.reduce((a,b)=>a+b,0)/vals.length:null,
  max:peaks.length||vals.length?Math.max(...peaks,...vals):null};
}
function option(def,pts,range,ceiling,st,xMin){
 const color=token(def.color),extraColor=def.extra?token(def.extra.color):null;
 const dim=token('--color-text-dim'),faint=token('--color-text-faint'),rule=token('--color-border'),strong=token('--color-border-strong'),mono='ui-monospace,Menlo,monospace';
 const data=pts.map(p=>[p.t*1000,def.pick(p)]);
 const peakData=def.peak?pts.map(p=>[p.t*1000,def.peak(p)]):[];
 const label=(formatter,position='insideEndTop')=>({formatter,color:dim,position,fontFamily:mono,fontSize:10});
 const lines=[];
 if(st.avg!=null)lines.push({yAxis:st.avg,name:'prům.',lineStyle:{color,type:'dashed',opacity:.6},label:label(t('prům. {v}',{v:fmt(st.avg,def.unit)}))});
 if(ceiling!=null)lines.push({yAxis:ceiling,lineStyle:{color:strong,type:'solid',opacity:.9},label:label(def.unit==='GB'?t('celkem {gb} GB',{gb:round(ceiling,0)}):t(def.ceilingLabel))});
 if(def.key==='mem'&&ceiling!=null){const g=gpuDefaultLimit(ceiling);lines.push({yAxis:g,lineStyle:{color:extraColor,type:'dotted',opacity:.8},label:label(t('GPU limit ~{gb} GB (výchozí macOS)',{gb:round(g,0)}),'insideStartTop')});}
 if(def.limit)lines.push({yAxis:def.limit,lineStyle:{color:token('--color-bad'),type:'dotted',opacity:.8},label:label(t(def.limitLabel))});
 const yMax=ceiling!=null?ceiling:def.limit?Math.max(def.limit,(st.max||0)*1.1):v=>Math.ceil(v.max*1.2||1);
 return {
  animation:false,backgroundColor:'transparent',
  grid:{left:44,right:14,top:22,bottom:26},
  textStyle:{fontFamily:mono},
  tooltip:{trigger:'axis',backgroundColor:token('--color-surface-raised'),borderColor:strong,textStyle:{color:token('--color-text'),fontSize:11,fontFamily:mono},
   axisPointer:{type:'line',lineStyle:{color:strong}},
   formatter:items=>{const at=items[0]?.value?.[0];const head=at?new Intl.DateTimeFormat(locale(),{day:'numeric',month:'numeric',hour:'2-digit',minute:'2-digit',timeZone:timeZone()}).format(new Date(at)):'';
    return [head,...items.map(i=>`${i.seriesName}: ${fmt(i.value?.[1],def.unit)} ${def.unit}`)].join('<br>');}},
  xAxis:{type:'time',...(xMin?{min:xMin}:{}),axisLine:{lineStyle:{color:rule}},axisTick:{show:false},splitLine:{show:false},
   axisLabel:{color:faint,fontSize:10,hideOverlap:true,formatter:v=>timeLabel(v,range,xMin?Date.now()-xMin:Infinity)}},
  yAxis:{type:'value',min:0,max:yMax,splitNumber:3,axisLabel:{color:faint,fontSize:10,formatter:v=>`${round(v,0)}`},
   splitLine:{lineStyle:{color:rule,opacity:.7}}},
  series:[
   ...(def.extra&&pts.some(p=>def.extra.pick(p)!=null)?[{name:t(def.extra.name),type:'line',data:pts.map(p=>[p.t*1000,def.extra.pick(p)]),showSymbol:false,connectNulls:false,smooth:.25,lineStyle:{width:2,color:extraColor},itemStyle:{color:extraColor},areaStyle:{color:alpha(extraColor,.14)},z:3}]:[]),
   ...(peakData.length?[{name:'max',type:'line',data:peakData,showSymbol:false,connectNulls:false,lineStyle:{width:1,color,opacity:.45,type:'dashed'},itemStyle:{color},z:1}]:[]),
   {name:t(def.title).split(' ·')[0],type:'line',data,showSymbol:data.filter(d=>d[1]!=null).length<24,symbolSize:8,itemStyle:{color},connectNulls:false,smooth:.25,lineStyle:{width:2,color},
    areaStyle:{color:{type:'linear',x:0,y:0,x2:0,y2:1,colorStops:[{offset:0,color:alpha(color,.3)},{offset:1,color:alpha(color,0)}]}},
    markLine:{symbol:'none',silent:true,data:lines},z:2}]};
}
// Renders one card per series into `box` (cards built by the caller via makeCard).
// echarts: the chart library, when the caller already has one (tests); otherwise the vendored file.
export async function renderCharts(cards,h,range,now={},{keep=false,echarts:given}={}){
 if(!keep)disposeCharts();
 const echarts=given||await loadECharts();
 const pts=h.points||[];
 if(!observer)observer=new ResizeObserver(()=>{for(const c of live)c.resize();});
 // When history is shorter than the window, start the axis where data starts instead of
 // squeezing a few hours into the right edge of a 30-day chart.
 const first=pts.find(p=>SERIES.some(d=>d.pick(p)!=null));
 const step=pts.length>1?(pts[1].t-pts[0].t)*1000:0;
 const xMin=h.complete===false&&first?first.t*1000-step:null;
 for(const {def,node,value,sub} of cards){
  const st=stats(pts,def.pick,def.peak);const ceiling=def.ceiling?def.ceiling(pts):null;
  // Big number is the live value (same on every range); window stats sit underneath.
  const current=def.live?.(now)??st.last;
  value.className=`hv-val ${level(def.key,current)}`;
  value.replaceChildren(fmt(current,def.unit),Object.assign(document.createElement('small'),{textContent:' '+def.unit}));
  const total=def.liveTotal?.(now)??ceiling;
  const g=def.liveGpu?.(now);
  sub.textContent=def.key==='mem'&&total!=null&&current!=null?t('volno {free} GB · GPU drží {gpu}{active} · max {max} GB',{free:round(total-current,1),gpu:g!=null?round(g,1)+' GB':'– (Thermo < 97)',active:now.gpuMemAlloc!=null&&now.gpuMem!=null?t(' (aktivně {gb})',{gb:round(now.gpuMem/GB,1)}):'',max:fmt(st.max,'GB')}):t('za období: prům. {avg} · max {max} {unit}',{avg:fmt(st.avg,def.unit),max:fmt(st.max,def.unit),unit:def.unit});
  const existing=echarts.getInstanceByDom(node);
  if(!pts.some(p=>def.pick(p)!=null)){
   // A transient empty reply on refresh must not wipe a chart that is already drawn.
   if(keep&&existing&&node.contains(existing.getDom().firstChild))continue;
   if(existing){existing.dispose();live=live.filter(c=>c!==existing);}
   node.textContent=t('zatím žádná data');node.classList.add('empty');continue;
  }
  // Reuse a live instance only if its canvas is still attached to this node; otherwise rebuild.
  const build=()=>option(def,pts,range,ceiling,st,xMin);
  if(existing&&node.querySelector('canvas')){existing.setOption(build(),{notMerge:true,lazyUpdate:true});drawn.set(existing,build);continue;}
  if(existing){existing.dispose();live=live.filter(c=>c!==existing);}
  node.textContent='';node.classList.remove('empty');
  const chart=echarts.init(node,null,{renderer:'canvas'});chart.setOption(build());drawn.set(chart,build);live.push(chart);observer.observe(node);
 }
}

// --- the small chart on a tile ----------------------------------------------------------------
// One utilisation series (m.spark from /api/home) as a bare line with a soft fill: no axes, no labels, no
// grid, no legend, nothing to hover. The scale starts at 0 and ends at the next quarter above the peak (at
// least 25 %), so an idle machine stays a low line instead of magnified noise. A step without a reading is
// null and stays a gap. The colour is the measure's token, read again on a theme change like the big charts.
const SPARK_TOKEN={cpu:'--home-cpu',gpu:'--home-gpu'};
export function sparkOption(spark){
 const color=token(SPARK_TOKEN[spark.series]||'--home-cpu'),step=spark.stepSeconds*1000,end=spark.end*1000,n=spark.values.length;
 const peak=Math.max(0,...spark.values.filter(v=>v!=null));
 return {animation:false,backgroundColor:'transparent',grid:{left:1,right:1,top:3,bottom:1},
  xAxis:{type:'time',show:false,min:end-(n-1)*step,max:end},
  yAxis:{type:'value',show:false,min:0,max:Math.max(25,Math.ceil(peak/25)*25)},
  series:[{type:'line',data:spark.values.map((v,i)=>[end-(n-1-i)*step,v]),silent:true,showSymbol:false,connectNulls:false,smooth:.4,smoothMonotone:'x',
   lineStyle:{width:1.75,color,cap:'round',join:'round'},itemStyle:{color},
   areaStyle:{color:{type:'linear',x:0,y:0,x2:0,y2:1,colorStops:[{offset:0,color:alpha(color,.24)},{offset:1,color:alpha(color,0)}]}}}]};
}
export function disposeSparks(){for(const chart of sparks.values())try{chart.dispose();}catch{}sparks.clear();sparkObserver?.disconnect();sparkObserver=null;}
// Draws spark into node (a box with a height), or redraws the chart that is already there.
export async function renderSpark(node,spark,{echarts:given}={}){
 const echarts=given||await loadECharts();
 // Tiles that left the page take their charts with them.
 for(const [old,chart] of sparks)if(old!==node&&old.isConnected===false){try{chart.dispose();}catch{}sparks.delete(old);sparkObserver?.unobserve?.(old);}
 // A tile is built before it is on the page; a chart needs a box with a size.
 if(node.isConnected===false)await new Promise(r=>(globalThis.requestAnimationFrame||setTimeout)(r));
 if(node.isConnected===false)return null;
 const build=()=>sparkOption(spark);
 let chart=sparks.get(node);
 if(!chart){
  chart=echarts.init(node,null,{renderer:'canvas'});sparks.set(node,chart);
  if(typeof ResizeObserver==='function'){sparkObserver??=new ResizeObserver(()=>{for(const c of sparks.values())c.resize();});sparkObserver.observe(node);}
 }
 chart.setOption(build(),{notMerge:true,lazyUpdate:true});drawn.set(chart,build);
 return chart;
}
