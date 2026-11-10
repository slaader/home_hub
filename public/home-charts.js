// Device page charts on Apache ECharts (vendored, CSP 'self'). Each card shows the current value,
// average and peak for the window, with reference lines (100 %, total memory, thermal limit) so
// the line is readable against something. Tooltips are plain text: CSP forbids inline styles.
import {t,locale} from './i18n.js';
import {timeZone} from './site.js';
let lib=null;
export const loadECharts=()=>lib??=import('/vendor/echarts.esm.min.mjs');
let live=[];let observer=null;
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
 {key:'cpu',live:q=>q.cpu,title:'CPU load',unit:'%',color:'#ff9e7a',ceiling:()=>100,ceilingLabel:'100 %',pick:p=>p.cpu,peak:p=>p.cpuMax},
 {key:'gpu',live:q=>q.gpu,title:'GPU load',unit:'%',color:'#c7a7ff',ceiling:()=>100,ceilingLabel:'100 %',pick:p=>p.gpu,peak:p=>p.gpuMax},
 {key:'mem',extra:{name:'GPU drží',color:'#c7a7ff',pick:p=>(p.gpuMemAlloc??p.gpuMem)!=null?(p.gpuMemAlloc??p.gpuMem)/GB:null},liveGpu:q=>(q.gpuMemAlloc??q.gpuMem)!=null?(q.gpuMemAlloc??q.gpuMem)/GB:null,live:q=>q.memUsed!=null?q.memUsed/GB:null,liveTotal:q=>q.memTotal?q.memTotal/GB:null,title:'Paměť · sjednocená (CPU + GPU)',unit:'GB',color:'#4de3c0',pick:p=>p.memUsed!=null?p.memUsed/GB:null,
  ceiling:pts=>{const tot=pts.map(p=>p.memTotal).filter(v=>v!=null);return tot.length?Math.max(...tot)/GB:null;},ceilingLabel:'celkem'},
 {key:'power',live:q=>q.power,title:'Příkon',unit:'W',color:'#ffc266',pick:p=>p.power,peak:p=>p.powerMax},
 {key:'temp',live:q=>q.temp,title:'Teplota',unit:'°C',color:'#ff6b81',pick:p=>p.temp,peak:p=>p.tempMax,limit:95,limitLabel:'throttling ~95 °C'}];

function stats(pts,pick,peak){
 const vals=pts.map(pick).filter(v=>v!=null);
 const peaks=peak?pts.map(peak).filter(v=>v!=null):[];
 return {last:vals.length?vals.at(-1):null,avg:vals.length?vals.reduce((a,b)=>a+b,0)/vals.length:null,
  max:peaks.length||vals.length?Math.max(...peaks,...vals):null};
}
function option(def,pts,range,ceiling,st,xMin){
 const data=pts.map(p=>[p.t*1000,def.pick(p)]);
 const peakData=def.peak?pts.map(p=>[p.t*1000,def.peak(p)]):[];
 const lines=[];
 if(st.avg!=null)lines.push({yAxis:st.avg,name:'prům.',lineStyle:{color:def.color,type:'dashed',opacity:.55},label:{formatter:t('prům. {v}',{v:fmt(st.avg,def.unit)}),color:'#a8a1b4',position:'insideEndTop',fontFamily:'ui-monospace,Menlo,monospace',fontSize:10}});
 if(ceiling!=null)lines.push({yAxis:ceiling,lineStyle:{color:'#6f6880',type:'solid',opacity:.7},label:{formatter:def.unit==='GB'?t('celkem {gb} GB',{gb:round(ceiling,0)}):t(def.ceilingLabel),color:'#6f6880',position:'insideEndTop',fontFamily:'ui-monospace,Menlo,monospace',fontSize:10}});
 if(def.key==='mem'&&ceiling!=null){const g=gpuDefaultLimit(ceiling);lines.push({yAxis:g,lineStyle:{color:'#c7a7ff',type:'dotted',opacity:.7},label:{formatter:t('GPU limit ~{gb} GB (výchozí macOS)',{gb:round(g,0)}),color:'#c7a7ff',position:'insideStartTop',fontFamily:'ui-monospace,Menlo,monospace',fontSize:10}});}
 if(def.limit)lines.push({yAxis:def.limit,lineStyle:{color:'#ff6b81',type:'dotted',opacity:.6},label:{formatter:t(def.limitLabel),color:'#ff6b81',position:'insideEndTop',fontFamily:'ui-monospace,Menlo,monospace',fontSize:10}});
 const yMax=ceiling!=null?ceiling:def.limit?Math.max(def.limit,(st.max||0)*1.1):v=>Math.ceil(v.max*1.2||1);
 return {
  animation:false,backgroundColor:'transparent',
  grid:{left:44,right:14,top:22,bottom:26},
  textStyle:{fontFamily:'ui-monospace,Menlo,monospace'},
  tooltip:{trigger:'axis',backgroundColor:'rgba(18,16,25,.95)',borderColor:'#3a3448',textStyle:{color:'#f3ede4',fontSize:11,fontFamily:'ui-monospace,Menlo,monospace'},
   axisPointer:{type:'line',lineStyle:{color:'#3a3448'}},
   formatter:items=>{const at=items[0]?.value?.[0];const head=at?new Intl.DateTimeFormat(locale(),{day:'numeric',month:'numeric',hour:'2-digit',minute:'2-digit',timeZone:timeZone()}).format(new Date(at)):'';
    return [head,...items.map(i=>`${i.seriesName}: ${fmt(i.value?.[1],def.unit)} ${def.unit}`)].join('<br>');}},
  xAxis:{type:'time',...(xMin?{min:xMin}:{}),axisLine:{lineStyle:{color:'#25212f'}},axisTick:{show:false},splitLine:{show:false},
   axisLabel:{color:'#6f6880',fontSize:10,hideOverlap:true,formatter:v=>timeLabel(v,range,xMin?Date.now()-xMin:Infinity)}},
  yAxis:{type:'value',min:0,max:yMax,splitNumber:3,axisLabel:{color:'#6f6880',fontSize:10,formatter:v=>`${round(v,def.unit==='GB'?0:0)}`},
   splitLine:{lineStyle:{color:'#1e1a27'}}},
  series:[
   ...(def.extra&&pts.some(p=>def.extra.pick(p)!=null)?[{name:t(def.extra.name),type:'line',data:pts.map(p=>[p.t*1000,def.extra.pick(p)]),showSymbol:false,connectNulls:false,smooth:.25,lineStyle:{width:2,color:def.extra.color},areaStyle:{color:def.extra.color+'22'},z:3}]:[]),
   ...(peakData.length?[{name:'max',type:'line',data:peakData,showSymbol:false,connectNulls:false,lineStyle:{width:1,color:def.color,opacity:.35,type:'dashed'},z:1}]:[]),
   {name:t(def.title).split(' ·')[0],type:'line',data,showSymbol:data.filter(d=>d[1]!=null).length<24,symbolSize:5,itemStyle:{color:def.color},connectNulls:false,smooth:.25,lineStyle:{width:2,color:def.color},
    areaStyle:{color:{type:'linear',x:0,y:0,x2:0,y2:1,colorStops:[{offset:0,color:def.color+'55'},{offset:1,color:def.color+'00'}]}},
    markLine:{symbol:'none',silent:true,data:lines},z:2}]};
}
// Renders one card per series into `box` (cards built by the caller via makeCard).
export async function renderCharts(cards,h,range,now={},{keep=false}={}){
 if(!keep)disposeCharts();
 const echarts=await loadECharts();
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
  value.className=`val ${level(def.key,current)}`;
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
  if(existing&&node.querySelector('canvas')){existing.setOption(option(def,pts,range,ceiling,st,xMin),{notMerge:true,lazyUpdate:true});continue;}
  if(existing){existing.dispose();live=live.filter(c=>c!==existing);}
  node.textContent='';node.classList.remove('empty');
  const chart=echarts.init(node,null,{renderer:'canvas'});chart.setOption(option(def,pts,range,ceiling,st,xMin));live.push(chart);observer.observe(node);
 }
}
