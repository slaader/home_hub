// Usage charts of the LLM & Diffusion page on Apache ECharts (vendored, served by the overview module):
// requests stacked by one dimension (model, machine, client or kind of request), tokens in and out, and the
// median generation speed. Compact on purpose: no titles inside the canvas, one axis line, a text legend
// under each chart. Colours come from the series tokens of models.css; tooltips are drawn on the canvas
// (richText), so no name from the data ever becomes markup. Charts redraw on themechange and go with the page.
import {el} from './views.js';
import {t,locale} from './i18n.js';
import {timeZone} from './site.js';

let lib=null;
const load=()=>lib??=import('/vendor/echarts.esm.min.mjs');
const css=name=>{try{return getComputedStyle(document.documentElement).getPropertyValue(name).trim();}catch{return '';}};
export const SERIES_CLASSES=['s1','s2','s3','s4','s5','s6','s7','s8','s9'];
const seriesColour=i=>css(`--md-s${i+1}`)||'#888888';
const compact=v=>new Intl.NumberFormat(locale(),{notation:Math.abs(v)>=10000?'compact':'standard',maximumFractionDigits:1}).format(v||0);
function label(ms,stepMs){const o=stepMs<86400000?{hour:'2-digit',minute:'2-digit'}:{day:'numeric',month:'numeric'};if(stepMs>3600000&&stepMs<86400000)Object.assign(o,{day:'numeric',month:'numeric'});return new Intl.DateTimeFormat(locale(),{...o,timeZone:timeZone()}).format(new Date(ms));}
// A display name for a series key: "other" and the unattributed client are translated, the rest is data.
export const seriesName=key=>key==='other'?t('ostatní'):key==='Unattributed'?t('Nepřiřazeno'):key==='chat'?t('chat'):key==='embeddings'?t('embeddingy'):key==='images'?t('obrázky'):key==='audio'?t('zvuk'):key;

function base(stepMs,buckets){
 const faint=css('--color-text-faint')||'#6f6b82',rule=css('--color-border')||'#2b2937',mono=css('--font-mono')||'monospace';
 return {animation:false,backgroundColor:'transparent',textStyle:{fontFamily:mono},grid:{left:40,right:8,top:10,bottom:22},
  tooltip:{trigger:'axis',renderMode:'richText',confine:true,backgroundColor:css('--color-surface-overlay')||'#1a1924',borderColor:css('--color-border-strong')||'#403d52',
   textStyle:{color:css('--color-text')||'#eceaf4',fontSize:11,fontFamily:mono},axisPointer:{type:'shadow',shadowStyle:{color:css('--color-hover')||'rgba(255,255,255,.05)'}}},
  xAxis:{type:'category',data:buckets.map(b=>Date.parse(b)),axisLine:{lineStyle:{color:rule}},axisTick:{show:false},axisLabel:{color:faint,fontSize:10,hideOverlap:true,formatter:v=>label(Number(v),stepMs)}},
  yAxis:{type:'value',min:0,splitNumber:3,axisLabel:{color:faint,fontSize:10,formatter:v=>compact(v)},splitLine:{lineStyle:{color:rule,opacity:.7}}}};
}
const tip=(stepMs,unit='')=>items=>[label(Number(items[0]?.axisValue),stepMs),...items.filter(i=>i.value!=null&&i.value!==0).map(i=>`${i.seriesName}: ${compact(i.value)}${unit}`)].join('\n');
// What each chart shows, from GET /api/models/history and the chosen dimension.
export function chartOptions(h,dim){
 const s=h.series?.[dim]||{keys:[],values:{}};
 return {
  requests:()=>({...base(h.stepMs,h.buckets),tooltip:{...base(h.stepMs,h.buckets).tooltip,formatter:tip(h.stepMs)},
   series:s.keys.map((k,i)=>({name:seriesName(k),type:'bar',stack:'r',barMaxWidth:18,data:s.values[k],itemStyle:{color:seriesColour(k==='other'?8:i)}}))}),
  tokens:()=>({...base(h.stepMs,h.buckets),tooltip:{...base(h.stepMs,h.buckets).tooltip,formatter:tip(h.stepMs)},
   series:[{name:t('vstup'),type:'bar',stack:'t',barMaxWidth:18,data:h.inputTokens,itemStyle:{color:seriesColour(1)}},{name:t('výstup'),type:'bar',stack:'t',barMaxWidth:18,data:h.outputTokens,itemStyle:{color:seriesColour(0)}}]}),
  tps:()=>({...base(h.stepMs,h.buckets),tooltip:{...base(h.stepMs,h.buckets).tooltip,axisPointer:{type:'line'},formatter:tip(h.stepMs,' tok/s')},
   series:[{name:t('medián tok/s'),type:'line',data:h.tps,connectNulls:false,symbol:'circle',symbolSize:4,showSymbol:true,lineStyle:{width:2,color:seriesColour(2)},itemStyle:{color:seriesColour(2)}}]}),
 };
}
// Three small charts in a grid. → {node, update(history, dim), destroy()}
export function usageCharts(){
 const slots={requests:el('div',{class:'md-chart-canvas'}),tokens:el('div',{class:'md-chart-canvas'}),tps:el('div',{class:'md-chart-canvas'})};
 const legends={requests:el('div',{class:'md-chart-legend'}),tokens:el('div',{class:'md-chart-legend'}),tps:el('div',{class:'md-chart-legend'})};
 const titles={requests:t('Požadavky'),tokens:t('Tokeny'),tps:t('Rychlost generování')};
 const node=el('div',{class:'md-charts'},...Object.keys(slots).map(k=>el('figure',{class:'md-chart'},el('h3',{},titles[k]),slots[k],legends[k])));
 const charts={};let last=null,destroyed=false;
 const key=(cls,text)=>el('span',{},el('i',{class:`md-key ${cls}`,'aria-hidden':'true'}),text);
 async function update(h,dim){
  last={h,dim};const echarts=await load();if(destroyed)return;
  const opts=chartOptions(h,dim);
  for(const k of Object.keys(slots)){charts[k]??=echarts.init(slots[k],null,{renderer:'canvas'});charts[k].setOption(opts[k](),{notMerge:true});}
  const s=h.series?.[dim]||{keys:[]};
  legends.requests.replaceChildren(...s.keys.map((k,i)=>key(SERIES_CLASSES[k==='other'?8:i],seriesName(k))));
  legends.tokens.replaceChildren(key('s2',t('vstup')),key('s1',t('výstup')));
  legends.tps.replaceChildren(key('s3 line',t('medián na {step}',{step:h.stepMs>=86400000?t('den'):h.stepMs>3600000?t('6 h'):t('hodinu')})));
 }
 const repaint=()=>{if(last)update(last.h,last.dim);};
 const resize=()=>{for(const c of Object.values(charts))c.resize();};
 const observer=typeof ResizeObserver==='function'?new ResizeObserver(resize):null;observer?.observe(node);
 globalThis.addEventListener?.('themechange',repaint);
 const scheme=globalThis.matchMedia?.('(prefers-color-scheme: dark)');scheme?.addEventListener?.('change',repaint);
 return {node,update,destroy(){destroyed=true;observer?.disconnect();globalThis.removeEventListener?.('themechange',repaint);scheme?.removeEventListener?.('change',repaint);for(const c of Object.values(charts))try{c.dispose();}catch{}}};
}
