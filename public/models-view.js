// LLM & Diffusion (#models): local language and generative models across every machine. One answer from
// GET /api/models (overview, models, clients, graph, known tools) and one from GET /api/models/history
// (requests, tokens and tok/s over time), both for the chosen range. Everything comes from the hub's runtime
// providers (home.runtimes, runtimes.requests) and the machines' stacks; this page computes nothing it could
// get wrong, it only lays it out. A click in the wiring diagram filters the tables below it.
import {el,onLeave} from './views.js';
import {pageHeader,setProvenance,emptyState,errorState,loadingState,banner,segmented,statusPill} from './ui.js';
import {t,tp,locale} from './i18n.js';
import {timeZone} from './site.js';
import {wiringDiagram} from './models-graph.js';
import {usageCharts,seriesName} from './models-charts.js';

const RANGES=['24h','7d','30d'];
const KINDS=['llm','embedding','image','video','music','audio','other'];
const KIND_LABEL={llm:'LLM',embedding:'embedding',image:'difúze · obraz',video:'difúze · video',music:'hudba',audio:'zvuk a řeč',other:'ostatní'};
const DIMS=[['model','Model'],['machine','Stroj'],['client','Klient'],['kind','Druh požadavku']];
const REFRESH_MS=30000;
let stylesheet=false;

const num=v=>v==null?'—':new Intl.NumberFormat(locale(),{maximumFractionDigits:1}).format(v);
const short=v=>v==null?'—':new Intl.NumberFormat(locale(),{notation:v>=10000?'compact':'standard',maximumFractionDigits:1}).format(v);
const gb=v=>v==null?'—':`${num(v)} GB`;
const ctxLen=v=>v==null?'—':v>=1000?`${Math.round(v/1024)}k`:String(v);
const kindLabel=k=>t(KIND_LABEL[k]||KIND_LABEL.other);
const kindTag=k=>el('span',{class:'md-kind'},el('i',{class:`md-key k-${KINDS.includes(k)?k:'other'}`,'aria-hidden':'true'}),kindLabel(k));
function ago(iso){
 if(!iso)return '—';const s=(Date.now()-Date.parse(iso))/1000;const rtf=new Intl.RelativeTimeFormat(locale(),{numeric:'auto'});
 if(s<60)return rtf.format(-Math.round(s),'second');if(s<3600)return rtf.format(-Math.round(s/60),'minute');if(s<86400)return rtf.format(-Math.round(s/3600),'hour');return rtf.format(-Math.round(s/86400),'day');
}
const at=iso=>iso?new Intl.DateTimeFormat(locale(),{dateStyle:'medium',timeStyle:'short',timeZone:timeZone()}).format(new Date(iso)):'';
function ttl(sec){if(sec==null)return '—';if(sec<90)return t('{n} s',{n:Math.round(sec)});if(sec<5400)return t('{n} min',{n:Math.round(sec/60)});return t('{n} h',{n:Math.round(sec/3600)});}
const STATE_TONE={loaded:'good',loading:'warn',unloaded:'',unknown:'plain',running:'good',stopped:'bad'};
const STATE_LABEL={loaded:'načtený',loading:'načítá se',unloaded:'nenačtený',unknown:'neznámý',running:'běží',stopped:'zastavený'};
const stateTag=s=>statusPill(t(STATE_LABEL[s]||STATE_LABEL.unknown),STATE_TONE[s]??'');

function svgBar(used,total,cls='used'){
 const NS='http://www.w3.org/2000/svg',svg=document.createElementNS(NS,'svg');svg.setAttribute('class','md-bar');svg.setAttribute('viewBox','0 0 100 8');svg.setAttribute('preserveAspectRatio','none');svg.setAttribute('aria-hidden','true');
 const rect=(w,c)=>{const r=document.createElementNS(NS,'rect');r.setAttribute('x','0');r.setAttribute('y','0');r.setAttribute('height','8');r.setAttribute('rx','2');r.setAttribute('width',String(w));r.setAttribute('class',c);return r;};
 svg.append(rect(100,'md-bar-bg'),rect(total?Math.max(used>0?1.5:0,Math.min(100,used/total*100)):0,`md-bar-${cls}`));return svg;
}

// ── Filters from the diagram ───────────────────────────────────────────────────────────────────
// filter = {machine, runtime, model} | {machine, runtime} | {client} | {machine} | null
export function placementMatches(p,f){
 if(!f)return true;if(f.client)return false;
 if(f.machine&&p.machine!==f.machine)return false;
 if(f.runtime&&p.runtime!==f.runtime&&!(p.gateways||[]).includes(f.runtime))return false;
 if(f.model&&p.id!==f.model)return false;
 return true;
}
export function groupMatches(g,f,clients=[]){
 if(!f)return true;
 if(f.client){const used=new Set(clients.filter(c=>c.client===f.client).flatMap(c=>c.targets.flatMap(tg=>tg.models.map(m=>`${tg.machine}\u0000${m.model}`))));
  return g.placements.some(p=>used.has(`${p.machine}\u0000${p.id}`)||(p.aliases||[]).some(a=>used.has(`${p.machine}\u0000${a}`)));}
 return g.placements.some(p=>placementMatches(p,f));
}
export function clientMatches(c,f,models=[]){
 if(!f)return true;if(f.client)return c.client===f.client;
 const placements=models.flatMap(g=>g.placements).filter(p=>placementMatches(p,f));
 return c.targets.some(tg=>(!f.machine||tg.machine===f.machine)&&(!f.runtime&&!f.model?true:tg.runtime===f.runtime||tg.models.some(m=>placements.some(p=>p.machine===tg.machine&&(p.id===m.model||(p.aliases||[]).includes(m.model))))));
}
// ── Sorting the models table ───────────────────────────────────────────────────────────────────
const STATE_RANK={loaded:3,loading:2,unloaded:1,unknown:0};
const SORTS={name:g=>g.name.toLowerCase(),kind:g=>KINDS.indexOf(g.kind),machine:g=>g.machines.join(','),state:g=>STATE_RANK[g.state]??0,size:g=>g.sizeGb??-1,context:g=>g.contextTokens??-1,ttl:g=>g.ttlRemainingSeconds??-1,last:g=>g.lastRequestAt?Date.parse(g.lastRequestAt):0,requests:g=>g.requests};
export function sortGroups(groups,{key='state',dir='desc'}={}){
 const f=SORTS[key]||SORTS.state,sign=dir==='asc'?1:-1;
 return [...groups].sort((a,b)=>{const x=f(a),y=f(b);return (x<y?-1:x>y?1:0)*sign||b.requests-a.requests||a.name.localeCompare(b.name);});
}

// ── Pieces ─────────────────────────────────────────────────────────────────────────────────────
function stat(label,value,note){return el('div',{class:'md-stat'},el('span',{class:'md-stat-label'},label),el('span',{class:'md-stat-value'},value),note?el('span',{class:'md-stat-note'},note):null);}
function strip(o){
 const r=o.runtimes,tokens=(o.inputTokens||0)+(o.outputTokens||0);
 return el('section',{class:'md-strip','aria-label':t('Přehled')},
  stat(t('Stroje s runtimy'),String(o.machines)),
  stat(t('Runtimy'),[String(r.up),el('small',{},` / ${r.total}`)],r.down||r.unknown?[r.down?t('{n} zastavené',{n:r.down}):null,r.down&&r.unknown?' · ':null,r.unknown?t('{n} bez čerstvých dat',{n:r.unknown}):null]:t('všechny běží')),
  stat(t('Načtené modely'),[String(o.models.loaded),el('small',{},` / ${o.models.total}`)],Object.entries(o.models.byKind||{}).map(([k,n])=>`${kindLabel(k)} ${n}`).join(' · ')||null),
  stat(t('Požadavky · {range}',{range:o.range}),short(o.requests),o.requests?t('{n} přiřazených klientům',{n:short(o.attributed)}):t('žádná historie')),
  stat(t('Tokeny · {range}',{range:o.range}),short(tokens),tokens?t('vstup {in} · výstup {out}',{in:short(o.inputTokens),out:short(o.outputTokens)}):null),
  stat(t('Medián tok/s'),o.medianTps==null?'—':num(o.medianTps),o.medianTps==null?t('není z čeho počítat'):t('generování, {range}',{range:o.range})),
  o.memory.length?el('div',{class:'md-stat md-mem'},el('span',{class:'md-stat-label'},t('Paměť modelů na strojích')),
   ...o.memory.map(m=>el('div',{class:'md-mem-row'},el('b',{},m.name),svgBar(m.residentGb||0,m.ramGb||Math.max(...m.pools.map(p=>p.capacityGb||0),m.residentGb||0,1)),
    el('span',{},m.ramGb?t('{used} z {total} GB',{used:num(m.residentGb),total:num(m.ramGb)}):gb(m.residentGb)),
    m.pools.length?el('span',{class:'md-pools'},m.pools.map(p=>`${p.name} ${p.basis==='budget'?t('rozpočet'):t('drží')} ${p.usedGb==null?'?':num(p.usedGb)}/${p.capacityGb==null?'?':num(p.capacityGb)} GB`).join(' · ')):null))):null);
}
function panel(title,lead,...content){return el('section',{class:'md-panel'},el('div',{class:'md-panel-head'},el('h2',{},title),lead?el('p',{},lead):null),...content);}

// The model's own name large, its organisation (org/… or org--…) small under it; the whole id as the title.
function modelCell(id){const m=/^(.*?)(?:\/|--)([^/]*)$/.exec(id),name=m?m[2]:id;return el('td',{class:'md-name',title:id},name,m?el('span',{class:'md-alias'},m[1]):null);}
function modelsTable(data,{filter,sort,query,onSort}){
 const kinds=[...new Set(data.models.map(g=>g.kind))],machines=[...new Set(data.models.flatMap(g=>g.machines))];
 let groups=data.models.filter(g=>groupMatches(g,filter,data.clients));
 if(query.text){const q=query.text.toLowerCase();groups=groups.filter(g=>[g.name,...g.placements.flatMap(p=>[p.id,p.runtime,p.machine,...(p.aliases||[])])].some(s=>String(s).toLowerCase().includes(q)));}
 if(query.kind)groups=groups.filter(g=>g.kind===query.kind);
 if(query.machine)groups=groups.filter(g=>g.machines.includes(query.machine));
 if(query.state==='loaded')groups=groups.filter(g=>g.placements.some(p=>p.state==='loaded'||p.state==='loading'));
 groups=sortGroups(groups,sort);
 const head=(key,label,cls='')=>el('th',{scope:'col',class:cls||null,'aria-sort':sort.key===key?(sort.dir==='asc'?'ascending':'descending'):'none'},el('button',{type:'button',onclick:()=>onSort(key)},label));
 const where=p=>[el('b',{},p.machineName||p.machine),' · ',p.runtimeName||p.runtime,(p.gateways||[]).length?el('span',{class:'md-alias'},t('přes {via} jako {alias}',{via:p.gateways.join(', '),alias:(p.aliases||[]).join(', ')})):null];
 const rows=[];
 for(const g of groups){
  const one=g.placements.length===1?g.placements[0]:null;
  rows.push(el('tr',{},
   modelCell(g.name),el('td',{},kindTag(g.kind)),
   el('td',{},one?where(one):tp(g.machines.length,'{n} stroj|{n} stroje|{n} strojů')+' · '+tp(g.placements.length,'{n} umístění|{n} umístění|{n} umístění')),
   el('td',{},stateTag(g.state)),el('td',{class:'num'},gb(g.sizeGb)),el('td',{class:'num md-hide-narrow'},ctxLen(g.contextTokens)),
   el('td',{class:'num md-hide-narrow'},ttl(g.ttlRemainingSeconds)),el('td',{class:'md-hide-narrow',title:at(g.lastRequestAt)||null},ago(g.lastRequestAt)),el('td',{class:'num'},g.requests?short(g.requests):'—')));
  if(!one)for(const p of g.placements)rows.push(el('tr',{class:'md-sub'},modelCell(p.id),el('td',{},p.engine||''),el('td',{},where(p)),el('td',{},stateTag(p.state)),
   el('td',{class:'num'},gb(p.sizeGb)),el('td',{class:'num md-hide-narrow'},ctxLen(p.contextTokens)),el('td',{class:'num md-hide-narrow'},ttl(p.ttlRemainingSeconds)),el('td',{class:'md-hide-narrow',title:at(p.lastRequestAt)||null},ago(p.lastRequestAt)),el('td',{class:'num'},p.requests?short(p.requests):'—')));
 }
 const select=(name,label,options,value)=>el('select',{'aria-label':label,'data-q':name,onchange:e=>query.set(name,e.target.value)},el('option',{value:''},label),...options.map(([v,l])=>{const o=el('option',{value:v},l);if(v===value)o.selected=true;return o;}));
 const search=el('input',{type:'search',placeholder:t('Hledat model, runtime, stroj…'),'aria-label':t('Hledat model'),value:query.text||'',oninput:e=>query.set('text',e.target.value,{soft:true})});
 return [el('div',{class:'md-filters'},search,
   select('kind',t('Všechny druhy'),kinds.map(k=>[k,kindLabel(k)]),query.kind),
   select('machine',t('Všechny stroje'),machines.map(m=>[m,data.machines.find(x=>x.machine===m)?.name||m]),query.machine),
   select('state',t('Načtené i nenačtené'),[['loaded',t('Jen načtené')]],query.state)),
  groups.length?el('div',{class:'md-table-wrap'},el('table',{class:'md-table'},el('thead',{},el('tr',{},head('name',t('Model')),head('kind',t('Druh')),head('machine',t('Stroj · runtime')),head('state',t('Stav')),
   head('size',t('Velikost'),'num'),head('context',t('Kontext'),'num md-hide-narrow'),head('ttl',t('TTL zbývá'),'num md-hide-narrow'),head('last',t('Poslední požadavek'),'md-hide-narrow'),head('requests',t('Požadavky'),'num'))),el('tbody',{},rows)))
   :emptyState({compact:true,icon:'search',title:t('Žádný model neodpovídá filtru'),body:t('Zruš filtr nebo hledání.')})];
}

function clientsTable(data,filter){
 const rows=data.clients.filter(c=>clientMatches(c,filter,data.models));
 const name=id=>data.machines.find(m=>m.machine===id)?.name||id;
 const from=c=>c.clientMachine?[el('b',{},name(c.clientMachine)),c.via.includes('address')?el('span',{class:'md-alias'},t('podle adresy')):null]
  :[el('span',{class:'md-dim'},t('stroj neznámý')),c.via.includes('loopback')?el('span',{class:'md-alias'},t('loopback: tento stroj nebo SSH tunel')):null];
 if(!data.clients.length)return [emptyState({compact:true,icon:'users',title:t('Žádné požadavky v tomto rozsahu'),body:t('Klienti se objeví, jakmile poskytovatel runtimů předá historii požadavků (runtimes.requests).')})];
 return [el('div',{class:'md-table-wrap'},el('table',{class:'md-table'},
  el('thead',{},el('tr',{},el('th',{scope:'col'},t('Klient')),el('th',{scope:'col'},t('Odkud')),el('th',{scope:'col'},t('Kam')),el('th',{scope:'col',class:'num'},t('Požadavky')),el('th',{scope:'col',class:'num md-hide-narrow'},t('Tokeny')),el('th',{scope:'col',class:'md-hide-narrow'},t('Naposledy')))),
  el('tbody',{},rows.map(c=>el('tr',{},el('td',{},c.attributed?el('b',{},c.client):el('span',{class:'md-dim'},t('Nepřiřazeno'))),el('td',{},from(c)),
   el('td',{},c.targets.map(tg=>el('div',{},`${tg.runtime} @ ${name(tg.machine)}`,c.clientMachine&&tg.machine!==c.clientMachine?[' ',statusPill(t('mezi stroji'),'accent')]:null,el('span',{class:'md-alias'},tg.models.map(m=>`${m.model} ×${m.requests}`).join(', '))))),
   el('td',{class:'num'},short(c.requests)),el('td',{class:'num md-hide-narrow'},short(c.inputTokens+c.outputTokens)),el('td',{class:'md-hide-narrow',title:at(c.lastAt)||null},ago(c.lastAt))))))),
  el('p',{class:'md-note'},t('Klienta pozná poskytovatel historie, pokud ho umí určit (u llama-swap podle User-Agent v jeho přístupovém logu). Stroj klienta je známý jen tam, kde to data říkají: llama-swap na loopbacku vidí všechny požadavky z 127.0.0.1, včetně těch, které přišly SSH tunelem z jiného stroje.'))];
}

function topTable(h,dim){
 const rows=h.top?.[dim]||[];if(!rows.length)return null;
 return el('div',{class:'md-table-wrap'},el('table',{class:'md-table'},
  el('thead',{},el('tr',{},el('th',{scope:'col'},t(DIMS.find(d=>d[0]===dim)[1])),el('th',{scope:'col',class:'num'},t('Požadavky')),el('th',{scope:'col',class:'num'},t('Vstup')),el('th',{scope:'col',class:'num'},t('Výstup')),el('th',{scope:'col',class:'num md-hide-narrow'},t('Medián tok/s')),el('th',{scope:'col',class:'num md-hide-narrow'},t('Medián trvání')))),
  el('tbody',{},rows.slice(0,10).map(r=>el('tr',{},el('td',{class:dim==='model'?'md-name':null},seriesName(r.key)),el('td',{class:'num'},short(r.requests)),el('td',{class:'num'},short(r.inputTokens)),el('td',{class:'num'},short(r.outputTokens)),
   el('td',{class:'num md-hide-narrow'},r.medianTps==null?'—':num(r.medianTps)),el('td',{class:'num md-hide-narrow'},r.medianDurationMs==null?'—':`${num(r.medianDurationMs/1000)} s`))))));
}

function knownList(known){
 if(!known.length)return null;
 return el('div',{class:'md-known'},known.filter(k=>k.role==='runtime').map(k=>el('article',{},el('h3',{},k.title,kindTag(k.kind),statusPill(k.state==='off'?t('vypnuto'):t('známý, bez živých statistik'),k.state==='off'?'':'plain')),
  el('p',{},[k.machineName,k.models.length?` · ${k.models.join(', ')}`:'',k.description?` · ${k.description}`:''].join('')))));
}

function emptyPage(known){
 return el('div',{class:'md-page'},emptyState({icon:'flow',title:t('Zatím žádné runtimy modelů'),
  body:t('Tahle stránka ukazuje lokální LLM, embeddingové a difúzní modely (obraz, video, hudba, zvuk) na všech strojích: co je kde načtené, kolik paměti drží, kdo je odkud volá a jak je to zapojené. Data dodávají poskytovatelé runtimů; žádný tu zatím není.'),
  steps:[t('Přidej runtimy do site.json → runtimes (llama-swap, Ollama, LM Studio, vLLM, oMLX…), hub je pak čte přímo.'),t('Nebo je zapoj na stránce Integrace, nebo pluginem, který poskytuje home.runtimes a runtimes.requests (docs/plugins.md).'),t('Nebo připoj agenta přes MCP: runtime_publish zapíše stack stroje a models_overview ukáže, co hub vidí.')],
  agentPrompt:t('Připoj lokální LLM runtimy k Home Hubu: zjisti, které runtimy (llama-swap, Ollama, LM Studio, vLLM, oMLX, mlx-serve) běží na strojích z machine_list, a zapiš je do site.json → runtimes nebo zveřejni stack přes runtime_publish. Potom ověř models_overview.'),
  mcpSnippet:true}),
  known.length?panel(t('Známé ze stacku'),t('Nástroje, které popisuje stack strojů (site.json nebo runtime_publish). Hub k nim nemá živá data.'),knownList(known)):null);
}

export function modelsPage(){
 if(!stylesheet){document.head.append(el('link',{rel:'stylesheet',href:'/models.css'}));stylesheet=true;}
 const header=pageHeader({eyebrow:t('Lokální AI'),title:t('LLM a difúze'),lead:t('Lokální jazykové a generativní modely na všech strojích: co je načtené, paměť, provoz a kdo je odkud volá.')});
 const body=el('div',{},loadingState(t('Načítám modely…')));
 const root=el('div',{class:'md-page'},header,body);
 const state={range:'24h',dim:'model',filter:null,sort:{key:'state',dir:'desc'},query:{text:'',kind:'',machine:'',state:''},data:null,history:null};
 let graph=null,charts=null,timer=null,left=false,built=false;
 const parts={};
 state.query.set=(name,value,{soft}={})=>{state.query[name]=value;drawModels(soft);};
 async function load({quiet}={}){
  try{
   const [d,h]=await Promise.all([fetch(`/api/models?range=${state.range}`).then(r=>{if(!r.ok)throw new Error(String(r.status));return r.json();}),
    fetch(`/api/models/history?range=${state.range}`).then(r=>r.ok?r.json():null).catch(()=>null)]);
   if(left)return;state.data=d;state.history=h;setProvenance(header,d.provenance);draw();
  }catch{if(left)return;if(!quiet||!state.data)body.replaceChildren(errorState({title:t('Modely se nepodařilo načíst'),retry:()=>load()}));}
 }
 function drawModels(soft){
  if(!parts.models)return;const focusName=soft?document.activeElement?.getAttribute?.('type'):null;
  parts.models.replaceChildren(...modelsTable(state.data,{filter:state.filter,sort:state.sort,query:state.query,onSort:key=>{state.sort=state.sort.key===key?{key,dir:state.sort.dir==='asc'?'desc':'asc'}:{key,dir:['name','kind','machine'].includes(key)?'asc':'desc'};drawModels();}}));
  if(focusName==='search'){const input=parts.models.querySelector('input[type=search]');input?.focus();input?.setSelectionRange?.(input.value.length,input.value.length);}
 }
 function drawFiltered(){
  drawModels();parts.clients.replaceChildren(...clientsTable(state.data,state.filter));
  parts.filter.replaceChildren(...(state.filter?[el('span',{class:'md-filter'},t('Filtr: {what}',{what:state.filter.label||''}),el('button',{type:'button','aria-label':t('Zrušit filtr'),onclick:()=>{state.filter=null;graph?.clear();drawFiltered();}},'×'))]:[]));
 }
 function drawUsage(){
  const h=state.history;if(!parts.usage)return;
  if(!h||!h.totals?.requests){charts?.destroy();charts=null;
   parts.usage.replaceChildren(emptyState({compact:true,icon:'pulse',title:h?.available?t('V tomto rozsahu žádné požadavky'):t('Historie požadavků tu není'),
    body:h?.available?t('Poskytovatel historie je připojený, ale za {range} nic nezaznamenal.',{range:state.range}):t('Žádný poskytovatel nedodává runtimes.requests. Živý stav nahoře platí; grafy se objeví, až hub začne historii držet.')}));return;}
  charts??=usageCharts();
  parts.usage.replaceChildren(el('div',{class:'md-toolbar'},segmented({label:t('Rozdělit podle'),value:state.dim,options:DIMS.map(([id,label])=>({id,label:t(label)})),onchange:id=>{state.dim=id;drawUsage();}})),
   charts.node,topTable(h,state.dim));
  charts.update(h,state.dim);
 }
 function draw(){
  const d=state.data;
  if(d.empty){graph?.destroy();graph=null;charts?.destroy();charts=null;built=false;body.replaceChildren(emptyPage(d.known||[]));return;}
  if(!built){
   graph=wiringDiagram({onSelect:f=>{state.filter=f;drawFiltered();}});
   parts.strip=el('div',{});parts.banners=el('div',{});parts.models=el('div',{class:'md-stack'});parts.clients=el('div',{});parts.usage=el('div',{});parts.known=el('div',{});parts.filter=el('div',{class:'md-filterbox'});
   parts.stamp=el('span',{class:'md-stamp'});
   const legend=el('div',{class:'md-legend'},...KINDS.map(k=>el('span',{},el('i',{class:`md-key k-${k}`,'aria-hidden':'true'}),kindLabel(k))),
    el('span',{},el('i',{class:'md-key line k-flow','aria-hidden':'true'}),t('provoz (šířka = požadavky)')),el('span',{},el('i',{class:'md-key dash','aria-hidden':'true'}),t('mezi stroji')),el('span',{},el('i',{class:'md-key line faint','aria-hidden':'true'}),t('bez provozu')));
   body.replaceChildren(el('div',{class:'md-page'},
    el('div',{class:'md-toolbar'},segmented({label:t('Rozsah'),value:state.range,options:RANGES.map(id=>({id,label:id})),onchange:id=>{state.range=id;load();}}),parts.filter,el('span',{class:'md-grow'}),parts.stamp),
    parts.banners,parts.strip,
    panel(t('Zapojení'),t('Klienti vlevo podle stroje, na kterém běží; uprostřed vstupní brána a enginy; vpravo modely. Pohyb ukazuje provoz posledních 15 minut.'),graph.node,legend),
    panel(t('Modely'),t('Všechny modely, které runtimy hlásí. Jeden model na více strojích je jeden řádek s umístěními pod ním.'),parts.models),
    panel(t('Využití a historie'),null,parts.usage),
    panel(t('Klienti: odkud se pracuje'),t('Který klient z kterého stroje posílal požadavky na který runtime.'),parts.clients),
    parts.known));
   built=true;
  }
  parts.stamp.textContent=d.overview.observedAt?t('stav runtimů {when}',{when:ago(d.overview.observedAt)}):'';
  const stale=d.machines.filter(m=>m.observedAt&&Date.now()-Date.parse(m.observedAt)>180000);
  const noHistory=!d.providers.requests.length,emptyHistory=!noHistory&&!d.providers.requests.some(p=>p.count);
  parts.banners.replaceChildren(...[
   stale.length?banner({tone:'warn',title:t('Starší data.'),body:t('{machines}: poslední stav je starší než 3 minuty; runtimy ukazujeme jako neznámé.',{machines:stale.map(m=>m.name).join(', ')})}):null,
   noHistory||emptyHistory?banner({tone:'info',title:t('Bez historie požadavků.'),body:noHistory?t('Žádný poskytovatel nedodává runtimes.requests, takže provoz, klienti a grafy jsou prázdné. Živý stav runtimů platí.'):t('Poskytovatel historie je připojený, ale zatím nic nezaznamenal (hub může runtimy číst jen jako snímek, historii pak drží jiný hub).')}):null].filter(Boolean));
  parts.strip.replaceChildren(strip(d.overview));
  graph.update(d.graph,{selected:graph.selected()});
  if(state.filter&&!d.models.some(g=>groupMatches(g,state.filter,d.clients))&&!d.clients.some(c=>clientMatches(c,state.filter,d.models)))state.filter=null;
  drawFiltered();drawUsage();
  parts.known.replaceChildren(...(d.known.some(k=>k.role==='runtime')?[panel(t('Známé ze stacku, bez živých statistik'),t('Generativní a jiné nástroje, které popisuje stack strojů (site.json nebo runtime_publish), ale žádný poskytovatel je nehlásí.'),knownList(d.known))]:[]));
 }
 load();
 timer=setInterval(()=>{if(!document.hidden)load({quiet:true});},REFRESH_MS);
 onLeave(()=>{left=true;clearInterval(timer);graph?.destroy();charts?.destroy();});
 return root;
}
