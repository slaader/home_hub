// Project Tracker: a development tracker for your own projects.
//   #projects        projects overview: health ring, activity, next release, create / edit a project
//   #projects/<id>   one project: health, activity, next release and a board of its items
//   #items           items (tickets) with project chips and quick filters, as a table or a board
//   #items/<ID>      one item, read view first: description, attachments, comments, history; "Edit" (or e)
//                    swaps the description for the edit form, so every field is on the page once
//   #releases        releases per project as a timeline with progress, countdown and their items
// Reads need any sign-in; writes need canWrite (the server checks again, API keys need tickets:write).
// Every edit sends the rev it read; a 409 means someone else changed it — reload and redo.
// Text: Czech source strings through t() (English in i18n-en-tracker.js); dates follow the active language and
// the site's time zone. A ticket is called `tk` in this file, because `t` is the translation function.
// Keys on the list pages: / filter, n new item, j / k move, Enter open, v table ↔ board; on an item: c comment, e edit.
import {el,onLeave} from './views.js';
import {onSessionReset,authGuard} from './session-cache.js';
import {markdown} from './tracker-md.js';
import {timeZone} from './site.js';
import {t,tp,locale} from './i18n.js';
import {pageHeader,emptyState,provenanceBadge} from './ui.js';

// Label lists are functions: t() has to run when the page is drawn, in the language active then.
const TYPES=()=>[['bug',t('Chyba'),'crit'],['feature',t('Funkce'),'ok'],['task',t('Úkol'),'']];
const STATUSES=()=>[['open',t('Otevřený'),'warn'],['in-progress',t('Rozpracovaný'),'info'],['done',t('Hotovo'),'ok'],['cancelled',t('Zrušený'),'dim']];
const PROJECT_TYPES=()=>[['app',t('Aplikace')],['game',t('Hra')],['other',t('Jiné')]];
const PRIORITIES=()=>[['urgent',t('Urgentní'),'crit'],['high',t('Vysoká'),'warn'],['normal',t('Normální'),''],['low',t('Nízká'),'dim']];
const TONE={open:'warn','in-progress':'info',done:'ok',cancelled:'dim'};
const label=(list,v)=>list.find(x=>x[0]===v)?.[1]||v;
const pill=(list,v)=>{const x=list.find(y=>y[0]===v);return el('span',{class:`sec-pill tk-pill ${x?.[2]||''}`},x?.[1]||v);};
const validTime=iso=>Boolean(iso)&&Number.isFinite(Date.parse(iso));
const when=iso=>validTime(iso)?new Intl.DateTimeFormat(locale(),{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',timeZone:timeZone()}).format(new Date(iso)):'—';
const dayOf=iso=>validTime(iso)?new Intl.DateTimeFormat(locale(),{day:'numeric',month:'short',year:'numeric',timeZone:timeZone()}).format(new Date(iso)):'—';
// A calendar day (YYYY-MM-DD) has no time zone: it is formatted as that day, wherever the reader is.
const dayText=d=>d?new Intl.DateTimeFormat(locale(),{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}).format(new Date(d+'T00:00:00Z')):'—';
const TYPE_GLYPH={bug:'🐞',feature:'✦',task:'⚙'};
const glyph=type=>el('span',{class:`tk-glyph ${type}`,role:'img',title:label(TYPES(),type),'aria-label':label(TYPES(),type)},TYPE_GLYPH[type]||'•');
const PRIO_ORDER={urgent:0,high:1,normal:2,low:3};
const ACTIVE=['open','in-progress'],CLOSED=['done','cancelled'];
const initials=s=>s?s.split(/[\s._@-]+/).filter(Boolean).slice(0,2).map(w=>w[0].toUpperCase()).join(''):'';
// Calendar day in the site's time zone as YYYY-MM-DD, so "today" and the activity bars follow local midnight.
const dayKey=d=>new Intl.DateTimeFormat('en-CA',{timeZone:timeZone(),year:'numeric',month:'2-digit',day:'2-digit'}).format(d);
const relative=(n,unit,style='short')=>new Intl.RelativeTimeFormat(locale(),{numeric:'auto',style}).format(n,unit);
function ago(iso){
 const m=Math.round((Date.parse(iso)-Date.now())/60000);if(!Number.isFinite(m))return '—';
 if(m>-1)return t('právě teď');if(m>-60)return relative(m,'minute');
 const h=Math.round(m/60);if(h>-24)return relative(h,'hour');
 const d=Math.round(h/24);return d>-30?relative(d,'day'):dayOf(iso);
}
const statusCounts=tickets=>Object.fromEntries(STATUSES().map(([s])=>[s,tickets.filter(x=>x.status===s).length]));
const activeBugs=tickets=>tickets.filter(x=>x.type==='bug'&&ACTIVE.includes(x.status)).length;
// The next release is the planned one with the nearest target date; undated ones come after, by version.
const plannedOrder=(a,b)=>(a.targetDate||'9999')<(b.targetDate||'9999')?-1:(a.targetDate||'9999')>(b.targetDate||'9999')?1:a.version.localeCompare(b.version,'en',{numeric:true,sensitivity:'base'});
const nextRelease=(releases,project)=>releases.filter(r=>r.project===project&&r.status==='planned').sort(plannedOrder)[0];
function due(r){
 if(r.status!=='planned'||!r.targetDate)return null;
 const days=Math.round((Date.parse(r.targetDate+'T00:00:00Z')-Date.parse(dayKey(new Date())+'T00:00:00Z'))/864e5),left=r.counts.open+r.counts['in-progress'];
 const text=days>=0?relative(days,'day','long'):tp(-days,'{n} den po termínu|{n} dny po termínu|{n} dní po termínu');
 return {days,text,tone:left&&days<0?'crit':left&&days<=3?'warn':''};
}
// Release progress: done and in-progress shares of everything that is not cancelled, with the percentage done.
function progressBar(counts,scope){
 const done=counts.done||0,doing=counts['in-progress']||0,pct=scope?Math.round(done/scope*100):0;
 const a=el('span',{class:'done'}),b=el('span',{class:'doing'});a.style.width=(scope?done/scope*100:0)+'%';b.style.width=(scope?doing/scope*100:0)+'%';
 return el('div',{class:'tk-progress'},el('div',{class:'tk-bar',role:'progressbar','aria-valuemin':'0','aria-valuemax':'100','aria-valuenow':String(pct),'aria-label':t('Hotovo {pct} %',{pct})},a,b),el('span',{class:'tk-progress-pct'},pct+' %'));
}
const options=(list,value,empty)=>[...(empty?[el('option',{value:''},empty)]:[]),...list.map(([v,text])=>{const o=el('option',{value:v},text);if(v===value)o.selected=true;return o;})];

async function api(url,body){
 if(body!==undefined&&new TextEncoder().encode(JSON.stringify(body)).length>16384)throw new Error(t('Požadavek je příliš dlouhý (maximum 16 kB). Zkrať text nebo odešli změny po částech.'));
 const lost=authGuard(),r=await fetch(url,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});lost(r);
 const data=await r.json().catch(()=>({}));
 // The server's messages are Czech source text too; t() translates the ones the dictionary knows.
 if(!r.ok){const e=new Error(data.error?.message?t(data.error.message):t('Požadavek selhal.'));e.status=r.status;throw e;}
 return data;
}
// Filters survive navigation between list and detail within one page load.
const defaults={project:'',status:'active',type:'',priority:'',release:'',assignee:'',label:'',q:''},filters={...defaults};
const prefs={view:'table',focusComment:false};
try{if(globalThis.localStorage?.getItem('tk-view')==='board')prefs.view='board';}catch{}
let sessionEpoch=0;const draws=new WeakMap(),dialogs=new Set();
onSessionReset(()=>{sessionEpoch++;Object.assign(filters,defaults);for(const d of dialogs)d.close();});
// Only the latest load for this view and sign-in may replace its contents.
async function load(wrap,request){
 const epoch=sessionEpoch,n=(draws.get(wrap)||0)+1;draws.set(wrap,n);
 const current=()=>epoch===sessionEpoch&&draws.get(wrap)===n;
 try{const data=await request;return current()?data:null;}catch(e){if(current())throw e;return null;}
}
function showDialog(dialog){
 dialogs.add(dialog);dialog.addEventListener('close',()=>{dialogs.delete(dialog);dialog.remove();});
 document.body.append(dialog);dialog.showModal();
}
const status=()=>el('p',{class:'acc-status',role:'status'});
// replaceChildren() would print a null child as the text "null"; optional parts are skipped instead.
const show=(wrap,...nodes)=>wrap.replaceChildren(...nodes.flat().filter(n=>n!=null&&n!==false));
const fail=(node,e)=>{node.textContent=e.message;node.classList.add('error');};
// provenance: where the page's data comes from (the `provenance` of the tickets answer), shown next to the title.
const head=(title,lead,actions,provenance)=>pageHeader({eyebrow:'Project Tracker',title,lead,actions:(actions||[]).filter(Boolean),provenance});

// Keyboard shortcuts of one page: plain keys, never while typing or with a dialog open. A handler returns
// false to let the key through. The listener goes away with the page (onLeave) or when its view is replaced.
const keyHandlers=new WeakMap();
const typing=node=>Boolean(node)&&(['INPUT','TEXTAREA','SELECT'].includes(node.tagName)||node.isContentEditable===true);
function shortcuts(wrap,handlers){
 if(typeof addEventListener!=='function')return;
 const old=keyHandlers.get(wrap);if(old)removeEventListener('keydown',old);
 const onKey=e=>{
  if(!wrap.isConnected){removeEventListener('keydown',onKey);return;}
  if(e.defaultPrevented||e.metaKey||e.ctrlKey||e.altKey||typing(document.activeElement)||document.querySelector('dialog[open]'))return;
  const run=handlers[e.key];if(run&&run(e)!==false)e.preventDefault();
 };
 keyHandlers.set(wrap,onKey);addEventListener('keydown',onKey);onLeave(()=>removeEventListener('keydown',onKey));
}
// j / k walk the rows or cards in page order; the marked one opens with Enter.
function moveCursor(wrap,step){
 const items=[...wrap.querySelectorAll('.tk-row,.tk-card')];if(!items.length)return;
 // A button or link that still has the focus would take the next Enter; the cursor takes it instead.
 if(document.activeElement?.closest?.('a,button'))document.activeElement.blur();
 let i=items.findIndex(n=>n.classList.contains('tk-cursor'));items[i]?.classList.remove('tk-cursor');
 i=i<0?(step>0?0:items.length-1):Math.max(0,Math.min(items.length-1,i+step));
 items[i].classList.add('tk-cursor');items[i].scrollIntoView?.({block:'nearest'});
}
function openCursor(wrap){
 if(document.activeElement?.closest?.('a,button'))return false;
 const id=wrap.querySelector('.tk-cursor')?.dataset?.id;if(!id)return false;location.hash='#items/'+id;
}
const keysHint=(...keys)=>el('p',{class:'tk-keys','aria-label':t('Klávesové zkratky')},keys.flatMap(([key,text])=>[el('kbd',{},key),el('span',{},text)]));

export const TRACKER_PAGES=Object.freeze(['projects','items','releases']);
export function trackerView(me,page,sub){
 const wrap=el('section',{class:'sec tk'},el('p',{class:'sec-dim',role:'status'},t('Načítám…')));
 const ctx={canWrite:me?.canWrite===true,user:typeof me?.username==='string'?me.username:'',id:sub};
 const draw=page==='projects'?(sub?projectPage:projectsPage):page==='releases'?releasesPage:sub?ticketPage:listPage;
 // A failed load says what failed and offers the way out: try again, or back to the list.
 const run=()=>draw(wrap,ctx).catch(e=>show(wrap,emptyState({icon:'⚠',
  title:e.status===404?(page==='projects'?t('Projekt neexistuje'):t('Položka neexistuje')):t('Project Tracker nejde načíst'),body:e.message,
  actions:[e.status===404?null:{label:t('Zkusit znovu'),primary:true,onclick:()=>{show(wrap,el('p',{class:'sec-dim',role:'status'},t('Načítám…')));run();}},
   page==='projects'?{label:`← ${t('Projekty')}`,href:'#projects'}:{label:`← ${t('Položky')}`,href:'#items'}]})));
 run();
 return wrap;
}

// A tracker without a project: how to start, by hand or by handing the job to a coding agent.
function noProjects({canWrite},redraw){
 return emptyState({icon:'◆',title:t('Zatím tu není žádný projekt'),
  body:t('Project Tracker drží projekty, jejich releasy a položky: chyby, funkce a úkoly. Každý projekt má zkratku, kterou ponesou čísla jeho položek, například APP-1.'),
  steps:[canWrite?t('Založ projekt tlačítkem „+ Nový projekt“: název, id a zkratka.'):t('Požádej správce o účet s právem zápisu, nebo nech projekt založit agenta.'),
   t('Přidej první položky a případně release, do kterého patří.'),
   t('Agenti pracují se stejnými daty přes MCP: servisní účet potřebuje scope tickets:write (Uživatelé a API → Servisní účty).')],
  agentPrompt:t('Připoj se k mému Home Hubu přes MCP (příkaz níže; servisní účet potřebuje scope tickets:write). Nástrojem project_save založ pro tento repozitář projekt: krátké id malými písmeny, zkratku ze 2–5 velkých písmen, název, jednořádkový popis a typ app, game nebo other. Potom nástrojem ticket_create založ první položky (project, title, description s kritérii přijetí, type bug|feature|task, priority). Nakonec je vypiš přes tickets_list a napiš mi jejich id.'),
  mcpSnippet:true,
  actions:canWrite?[{label:t('+ Nový projekt'),primary:true,onclick:()=>newProject(redraw)}]:[]});
}
function projectChips(projects,onPick){
 return el('div',{class:'sys-chips tk-chips'},[['',t('Všechny projekty')],...projects.map(p=>[p.id,p.name])].map(([id,name])=>
  el('button',{type:'button',class:`sys-chip${filters.project===id?' on':''}`,'aria-pressed':String(filters.project===id),'aria-label':id?t('Projekt {name}',{name}):name,onclick:()=>{filters.project=id;filters.release='';onPick();}},name)));
}

// List ------------------------------------------------------------------------------------------
async function listPage(wrap,ctx){
 const {canWrite,user}=ctx,board=prefs.view==='board',picked={...filters,...(board?{status:''}:{})},query=new URLSearchParams(Object.entries(picked).filter(([,v])=>v));
 const result=await load(wrap,Promise.all([api('/api/tickets?'+query),api('/api/tickets'+(picked.project?'?project='+encodeURIComponent(picked.project):''))]));if(!result)return;
 const [data,all]=result;
 const redraw=()=>listPage(wrap,ctx).catch(e=>fail(msg,e)),msg=status();
 const add=canWrite&&data.projects.length?{label:t('+ Nová položka'),primary:true,onclick:()=>newTicket(data.projects,null,ctx)}:null;
 const title=head(t('Položky'),t('Chyby, funkce a úkoly všech projektů. Filtry zůstávají, dokud stránku neopustíš.'),[add],all.provenance);
 if(!data.projects.length)return show(wrap,title,noProjects(ctx,redraw));
 const count=s=>all.tickets.filter(x=>s.includes(x.status)).length,bugs=activeBugs(all.tickets);
 const setView=v=>{if(prefs.view===v)return;prefs.view=v;try{globalThis.localStorage?.setItem('tk-view',v);}catch{}redraw();};
 // The numbers double as quick filters: one click narrows the table to that status.
 const stat=(k,v,s,tone,change)=>el('button',{type:'button',class:`sec-stat tk-stat ${tone}`,title:t('Zobrazit jen tyto položky'),onclick:()=>{Object.assign(filters,{type:'',priority:''},change);if(prefs.view!=='table'){prefs.view='table';try{globalThis.localStorage?.setItem('tk-view','table');}catch{}}redraw();}},
  el('div',{class:'k'},k),el('div',{class:'v'},String(v)),el('div',{class:'s'},s));
 const select=(key,list,empty)=>el('select',{class:filters[key]?'on':'','aria-label':empty,onchange:e=>{filters[key]=e.target.value;redraw();}},options(list,filters[key],empty));
 const releases=[...new Set(data.releases.map(r=>r.version))].map(v=>[v,v]);
 const names=[...new Set([user,...all.tickets.map(x=>x.assignee)].filter(Boolean))],labels=[...new Set(all.tickets.flatMap(x=>x.labels||[]))].sort();
 let debounce;
 const search=el('input',{type:'search',maxlength:'100','data-slash':'',placeholder:t('Hledat (id, název, popis, štítek)'),value:filters.q,'aria-label':t('Hledat'),'aria-keyshortcuts':'/',oninput:e=>{filters.q=e.target.value.trim();clearTimeout(debounce);debounce=setTimeout(()=>{if(search.isConnected)redraw();},300);}});
 const narrowed=['type','priority','release','assignee','label','q'].some(k=>filters[k])||(!board&&filters.status!==defaults.status);
 const clear=narrowed?el('button',{type:'button',class:'acc-btn small tk-clear',onclick:()=>{Object.assign(filters,defaults,{project:filters.project});redraw();}},t('Zrušit filtry')):null;
 const rows=data.tickets.map(tk=>el('tr',{class:`tk-row prio-${tk.priority}${CLOSED.includes(tk.status)?' tk-closed':''}`,'data-id':tk.id,onclick:()=>{location.hash='#items/'+tk.id;}},
  el('td',{class:'tk-id'},el('a',{href:'#items/'+tk.id},tk.id)),
  el('td',{},el('div',{class:'tk-name'},glyph(tk.type),' ',tk.title),tk.labels?.length?el('div',{class:'tk-labels'},tk.labels.map(l=>el('span',{class:'tk-label'},l))):null),
  el('td',{},pill(PRIORITIES(),tk.priority)),el('td',{},canWrite?statusSelect(tk,msg,redraw):pill(STATUSES(),tk.status)),
  el('td',{class:'tk-mono'},tk.release||'—'),el('td',{class:'tk-mono'},tk.assignee||'—'),
  el('td',{class:'tk-mono',title:t('Komentáře a přílohy')},[tk.comments?`💬 ${tk.comments}`:'',tk.attachments?`📎 ${tk.attachments}`:''].filter(Boolean).join(' ')),el('td',{class:'tk-mono tk-dim',title:when(tk.updatedAt)},ago(tk.updatedAt)),
  el('td',{class:'tk-actions'},canWrite?quickActions(tk,msg,redraw):null)));
 const viewToggle=el('div',{class:'tk-view',role:'group','aria-label':t('Zobrazení')},[['table',`☰ ${t('Tabulka')}`],['board',`▦ ${t('Nástěnka')}`]].map(([v,text])=>
  el('button',{type:'button',class:prefs.view===v?'on':'','aria-pressed':String(prefs.view===v),onclick:()=>setView(v)},text)));
 const focused=document.activeElement,focusLabel=wrap.contains(focused)?focused.getAttribute('aria-label'):null,caret=focused?.selectionStart;
 const nothing=()=>all.total
  ?el('div',{class:'tk-none'},el('h2',{},t('Filtrům nic neodpovídá')),el('p',{class:'sec-dim'},t('Zkus ubrat filtr nebo hledat jinými slovy.')),clear?el('button',{type:'button',class:'acc-btn',onclick:()=>{Object.assign(filters,defaults,{project:filters.project});redraw();}},t('Zrušit filtry')):null)
  :emptyState({icon:'✦',title:t('Zatím žádné položky'),body:t('Položka je chyba, funkce nebo úkol. Má stav, prioritu, řešitele, štítky a může patřit do releasu.'),
    agentPrompt:t('Přes MCP mého Home Hubu (scope tickets:write) založ nástrojem ticket_create položky pro práci, kterou v tomto repozitáři vidíš: project podle tickets_list → projects, title, description s kritérii přijetí, type bug|feature|task a priority. Než začneš na některé pracovat, nastav jí přes ticket_update stav in-progress a sebe jako assignee; po dokončení přidej ticket_comment s tím, co se změnilo.'),
    actions:[add].filter(Boolean)});
 show(wrap,title,el('div',{class:'tk-toolbar'},el('div',{class:'tk-toolbar-left'},projectChips(data.projects,redraw)),viewToggle),
  el('div',{class:'sec-stats tk-stats'},stat(t('Otevřené'),count(['open']),t('čeká na práci'),'warn',{status:'open'}),stat(t('Rozpracované'),count(['in-progress']),t('právě se dělá'),'',{status:'in-progress'}),stat(t('Hotové'),count(['done']),t('uzavřeno'),'',{status:'done'}),
   stat(t('Aktivní chyby'),bugs,t('otevřené + rozpracované'),bugs?'crit':'',{status:'active',type:'bug'}),el('div',{class:'sec-stat'},el('div',{class:'k'},t('Releasy')),el('div',{class:'v'},String(data.releases.filter(r=>r.status==='planned').length)),el('div',{class:'s'},t('naplánované')))),
  el('div',{class:'tk-filters'},
   board?null:select('status',[['active',t('Aktivní (otevřené + rozpracované)')],...STATUSES()],t('Všechny stavy')),select('type',TYPES(),t('Všechny typy')),
   select('priority',PRIORITIES(),t('Všechny priority')),select('release',[['none',t('Bez releasu')],...releases],t('Všechny releasy')),
   select('assignee',[['none',t('Nepřiřazené')],...names.map(n=>[n,n===user?t('{name} (já)',{name:n}):n])],t('Všichni řešitelé')),
   labels.length||filters.label?select('label',[...new Set([...labels,filters.label].filter(Boolean))].map(l=>[l,'#'+l]),t('Všechny štítky')):null,search,clear),
  msg,
  board&&all.total?boardView(data.tickets,{canWrite,msg,redraw,projects:data.projects,showProject:!picked.project}):
  data.tickets.length?el('div',{class:'sec-scroll'},el('table',{class:'sec-table tk-table'},
   el('thead',{},el('tr',{},['ID',t('Název položky'),t('Priorita'),t('Stav'),'Release',t('Řeší'),'',t('Změněno'),''].map(h=>el('th',{scope:'col'},h)))),el('tbody',{},rows)))
   :nothing(),
  all.total?keysHint(['/',t('hledat')],['n',t('nová položka')],['j k',t('další / předchozí')],['Enter',t('otevřít')],['v',t('tabulka / nástěnka')]):null);
 shortcuts(wrap,{n:()=>add?void add.onclick():false,v:()=>setView(prefs.view==='board'?'table':'board'),j:()=>moveCursor(wrap,1),k:()=>moveCursor(wrap,-1),Enter:()=>openCursor(wrap)});
 if(focusLabel){const control=[...wrap.querySelectorAll('[aria-label]')].find(n=>n.getAttribute('aria-label')===focusLabel);control?.focus();if(control===search)search.setSelectionRange(caret??search.value.length,caret??search.value.length);}
}

// Status moves, shared by the table rows and the board cards: a select in the row, one-click buttons, drag and drop.
const NEXT=()=>({open:[['in-progress','▶',t('Začít')],['done','✓',t('Hotovo')]],'in-progress':[['done','✓',t('Hotovo')]]});
async function setStatus(tk,next,control,msg,redraw){
 if(control)control.disabled=true;const epoch=sessionEpoch;
 try{await api('/api/tickets/update',{id:tk.id,rev:tk.rev,status:next});}catch(e){if(epoch===sessionEpoch){fail(msg,e);if(control){control.disabled=false;if('value'in control&&control.tagName==='SELECT')control.value=tk.status;}}return;}
 if(epoch===sessionEpoch)await redraw();
}
function statusSelect(tk,msg,redraw){
 const stop=e=>e.stopPropagation();
 const select=el('select',{class:`tk-status ${TONE[tk.status]||''}`,'aria-label':t('Stav položky {id}',{id:tk.id}),onclick:stop,onkeydown:stop,onchange:e=>{e.stopPropagation();setStatus(tk,e.target.value,select,msg,redraw);}},options(STATUSES(),tk.status));
 return select;
}
function quickActions(tk,msg,redraw){
 const stop=fn=>e=>{e.stopPropagation();fn(e);};
 return el('div',{class:'tk-quickrow'},...(NEXT()[tk.status]||[]).map(([next,icon,text])=>
   el('button',{type:'button',class:`tk-qa${next==='done'?' ok':''}`,title:text,'aria-label':`${text}: ${tk.id}`,onclick:stop(e=>setStatus(tk,next,e.currentTarget,msg,redraw))},icon)),
  el('button',{type:'button',class:'tk-qa',title:t('Komentovat'),'aria-label':`${t('Komentovat')}: ${tk.id}`,onclick:stop(()=>{prefs.focusComment=true;location.hash='#items/'+tk.id;})},'💬'));
}
// Board: open → in progress → done (the latest few), cancelled stays out. A writer can drag a card to another column.
const DONE_SHOWN=8,drag={ticket:null};
function boardView(tickets,ctx){
 const cols=[['open',t('Otevřené'),'warn'],['in-progress',t('Rozpracované'),'info'],['done',t('Hotové'),'ok']];
 return el('div',{class:'tk-board'},cols.map(([s,name,tone])=>{
  const all=tickets.filter(x=>x.status===s);
  const list=s==='done'?[...all].sort((a,b)=>(b.closedAt||b.updatedAt).localeCompare(a.closedAt||a.updatedAt)).slice(0,DONE_SHOWN)
   :[...all].sort((a,b)=>PRIO_ORDER[a.priority]-PRIO_ORDER[b.priority]||b.updatedAt.localeCompare(a.updatedAt));
  const col=el('section',{class:`tk-col ${tone}`,'aria-label':name,
    ondragover:e=>{if(!drag.ticket||drag.ticket.status===s)return;e.preventDefault();col.classList.add('tk-drop');},ondragleave:()=>col.classList.remove('tk-drop'),
    ondrop:e=>{e.preventDefault();col.classList.remove('tk-drop');const tk=drag.ticket;drag.ticket=null;if(tk&&tk.status!==s)setStatus(tk,s,null,ctx.msg,ctx.redraw);}},
   el('h3',{class:'tk-col-head'},el('span',{class:'tk-dot'}),name,el('span',{class:'tk-count'},String(all.length))),
   list.length?list.map(tk=>boardCard(tk,ctx)):el('p',{class:'tk-col-empty'},s==='in-progress'?t('Nikdo na ničem nedělá.'):s==='done'?t('Zatím nic hotového.'):t('Nic nečeká. 🎉')),
   all.length>list.length?el('p',{class:'tk-col-more'},tp(all.length-list.length,'+ {n} starší|+ {n} starší|+ {n} starších')):null);
  return col;
 }));
}
function boardCard(tk,{canWrite,msg,redraw,projects,showProject}){
 const project=showProject?projects.find(p=>p.id===tk.project):null;
 return el('article',{class:`tk-card prio-${tk.priority}`,'data-id':tk.id,draggable:canWrite?'true':null,onclick:()=>{location.hash='#items/'+tk.id;},
   ondragstart:e=>{if(!canWrite)return;drag.ticket=tk;try{e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',tk.id);}catch{}},ondragend:()=>{drag.ticket=null;}},
  el('div',{class:'tk-card-top'},glyph(tk.type),el('a',{href:'#items/'+tk.id,class:'tk-card-id'},tk.id),project?el('span',{class:'tk-dim tk-mono'},project.key):null,
   ['urgent','high'].includes(tk.priority)?pill(PRIORITIES(),tk.priority):null,
   tk.assignee?el('span',{class:'tk-avatar',title:tk.assignee,'aria-label':t('Řeší {name}',{name:tk.assignee})},initials(tk.assignee)):null),
  el('div',{class:'tk-card-title'},tk.title),
  tk.labels?.length?el('div',{class:'tk-labels'},tk.labels.map(l=>el('span',{class:'tk-label'},l))):null,
  el('div',{class:'tk-card-foot'},tk.release?el('span',{class:'tk-chip'},tk.release):null,tk.comments?el('span',{class:'tk-dim tk-mono'},`💬 ${tk.comments}`):null,tk.attachments?el('span',{class:'tk-dim tk-mono'},`📎 ${tk.attachments}`):null,
   el('span',{class:'tk-dim tk-mono',title:when(tk.updatedAt)},ago(tk.updatedAt)),canWrite&&!CLOSED.includes(tk.status)?quickActions(tk,msg,redraw):null));
}

// Markdown text with a preview: the textarea stays the field; "Náhled" swaps it for the rendered text.
function mdEditor(area,keys){
 const preview=el('div',{class:'tk-md-preview',hidden:''}),toggle=el('button',{type:'button',class:'tk-md-toggle','aria-pressed':'false',onclick:()=>{
   const on=toggle.getAttribute('aria-pressed')!=='true';
   // An empty field stays editable: there is nothing to preview, and a hidden required field cannot be submitted.
   if(on&&!area.value.trim()){area.focus();return;}
   toggle.setAttribute('aria-pressed',String(on));toggle.textContent=on?t('Upravit text'):t('Náhled');
   if(on)preview.replaceChildren(markdown(area.value,{keys}));
   preview.hidden=!on;area.hidden=on;if(!on)area.focus();}},t('Náhled'));
 return {node:el('div',{class:'tk-md-edit'},area,preview),toggle};
}
const mdHint=toggle=>el('div',{class:'tk-md-hint'},el('span',{},t('Formátování: **tučně**, `kód`, - seznam, 1. kroky, APP-12 = odkaz')),toggle||null);
const splitList=v=>v.split(/[,\n]/).map(s=>s.trim()).filter(Boolean);
// Who can be assigned: hub accounts, service accounts and names already on tickets. A failed read just means no suggestions.
const peopleNames=data=>Array.isArray(data?.people)?data.people.map(p=>p?.name).filter(n=>typeof n==='string'&&n):[];
let listSeq=0;
function assigneeInput(value,people,user){
 const id='tk-people-'+(++listSeq),names=[...new Set([user,...people].filter(Boolean))];
 const input=el('input',{name:'assignee',maxlength:'60',list:id,autocomplete:'off',value:value||'',placeholder:names.length?t('Vyber nebo napiš jméno'):t('Jméno řešitele')});
 return {input,list:el('datalist',{id},names.map(n=>el('option',{value:n}))),
  mine:user&&value!==user?el('button',{type:'button',class:'tk-inline-btn',onclick:()=>{input.value=user;input.focus();}},t('Přiřadit mně')):null};
}

// New ticket dialog ------------------------------------------------------------------------------
async function newTicket(projects,preset,ctx={}){
 const epoch=sessionEpoch;
 const [releasesData,peopleData]=await Promise.all([api('/api/tickets?limit=1').catch(()=>({releases:[]})),api('/api/tickets/people').catch(()=>null)]);if(epoch!==sessionEpoch)return;
 const msg=status(),field=(text,...input)=>el('label',{},text,...input),keys=projects.map(p=>p.key);
 const project=el('select',{name:'project'},options(projects.map(p=>[p.id,p.name]),preset||filters.project||projects[0]?.id));
 const release=el('select',{name:'release'});
 const fillReleases=()=>release.replaceChildren(...options((releasesData.releases||[]).filter(r=>r.project===project.value&&r.status==='planned').map(r=>[r.version,r.version]),'',t('Bez releasu')));
 project.addEventListener('change',fillReleases);fillReleases();
 const description=mdEditor(el('textarea',{name:'description',rows:'7',maxlength:'12000',placeholder:t('Co a proč. U chyby kroky k reprodukci, u funkce kritéria přijetí.')}),keys);
 const assignee=assigneeInput('',peopleNames(peopleData),ctx.user);
 const form=el('form',{class:'tk-form',onsubmit:async e=>{e.preventDefault();const f=e.currentTarget,b=f.querySelector('button[type=submit]');b.disabled=true;
   try{const made=await api('/api/tickets',{project:f.project.value,title:f.title.value,description:f.description.value,type:f.type.value,priority:f.priority.value,release:f.release.value||null,assignee:f.assignee.value.trim()||null,labels:splitList(f.labels.value)});
    dialog.close();location.hash='#items/'+made.id;}catch(err){fail(msg,err);}finally{b.disabled=false;}}},
  el('div',{class:'tk-grid3'},field(t('Projekt'),project),field(t('Typ'),el('select',{name:'type'},options(TYPES(),'feature'))),field(t('Priorita'),el('select',{name:'priority'},options(PRIORITIES(),'normal')))),
  field(t('Název položky'),el('input',{name:'title',required:'',maxlength:'200',autocomplete:'off'})),
  field(t('Popis'),description.node),mdHint(description.toggle),
  el('div',{class:'tk-grid3'},field('Release',release),field(t('Řeší'),assignee.input,assignee.list),field(t('Štítky'),el('input',{name:'labels',placeholder:'ui, api, docs'}))),
  msg,el('div',{class:'acc-actions'},el('button',{type:'button',class:'acc-btn',onclick:()=>dialog.close()},t('Zrušit')),el('button',{type:'submit',class:'acc-btn primary'},t('Založit položku'))));
 const dialog=el('dialog',{class:'acc-dialog wide tk-dialog','aria-label':t('Nová položka')},el('h3',{},t('Nová položka')),form);
 showDialog(dialog);form.title.focus();
}

// Detail ----------------------------------------------------------------------------------------
// Where the user came to a ticket from (a project page, a review set, releases, the open-items list), so the path
// back leads there instead of always to the list. Going from one ticket to another keeps the first origin.
// Kept per tab in sessionStorage, so a reload keeps it too; a link opened in a new tab falls back to the list.
export const ORIGIN_KEY='tk-origin';
export function ticketOrigin(from,to,current){
 const ticket=h=>/^#items\/[^/]+$/.test(h||'');
 if(!ticket(to))return current;
 return ticket(from)?current:/^#(projects|review|releases|items|search)(\/[^/]*)?$/.test(from||'')?from:'';
}
let originHash='';
try{originHash=globalThis.sessionStorage?.getItem(ORIGIN_KEY)||'';}catch{}
if(typeof addEventListener==='function')addEventListener('hashchange',e=>{
 let from='',to='';try{from=new URL(e.oldURL).hash;to=new URL(e.newURL).hash;}catch{return;}
 const next=ticketOrigin(from,to,originHash);if(next===originHash)return;originHash=next;try{globalThis.sessionStorage?.setItem(ORIGIN_KEY,next);}catch{}
});
// The path back from a ticket: Projects / <project> / <id> when it was opened from the project, else one link back.
// The project in the path is the one the user came from: after APP-2 → GAME-7 it still leads back to the first project.
export function backPath(tk,projects,origin=originHash){
 const sep=()=>el('span',{class:'tk-dim'},'/');
 if(/^#projects(\/|$)/.test(origin)){
  const id=/^#projects\/([^/]+)$/.exec(origin)?.[1]||tk.project,p=projects.find(x=>x.id===id);
  return el('nav',{class:'tk-crumbs','aria-label':t('Drobečková navigace')},
   el('a',{href:'#projects'},t('Projekty')),sep(),el('a',{href:'#projects/'+encodeURIComponent(id)},p?.name||id),sep(),el('b',{},tk.id));
 }
 const review=/^#review\/(R-[1-9][0-9]{0,5})$/.exec(origin);
 if(review)return el('a',{href:origin,class:'tk-back'},'← Review '+review[1]);
 if(/^#review(\/|$)/.test(origin))return el('a',{href:origin,class:'tk-back'},'← Review');
 if(/^#releases$/.test(origin))return el('a',{href:'#releases',class:'tk-back'},`← ${t('Releasy')}`);
 if(/^#search(\/|$)/.test(origin))return el('a',{href:origin,class:'tk-back'},`← ${t('Hledání')}`);
 return el('a',{href:'#items',class:'tk-back'},`← ${t('Položky')}`);
}
async function ticketPage(wrap,ctx){
 const result=await load(wrap,Promise.all([api('/api/tickets/'+encodeURIComponent(ctx.id)),api('/api/tickets?limit=1'),api('/api/tickets/people').catch(()=>null)]));if(!result)return;
 const [tk,meta,people]=result;renderTicket(wrap,{...ctx,meta,people:peopleNames(people)},tk,{fields:{},comment:''});
}
// Unsaved input on a ticket page: the comment box and every edit-form field that differs from what was rendered,
// and whether the edit form is open. A write re-renders from the ticket the server returned (no second request
// that could fail), carrying these over.
const pages=new WeakMap(),pastes=new WeakMap();
function drafts(wrap){
 const page=pages.get(wrap);if(!page)return {fields:{},comment:'',editing:false};
 return {comment:page.comment?.value||'',editing:page.editing===true,fields:Object.fromEntries(Object.entries(page.inputs).filter(([k,input])=>input.value!==page.initial[k]).map(([k,input])=>[k,input.value]))};
}
const fileSize=n=>n<1024?`${n} B`:n<1048576?`${Math.round(n/1024)} kB`:`${(n/1048576).toFixed(1)} MB`;
// Pictures of a ticket in one dialog: arrows (and the arrow keys) step through them, a click outside closes it.
function lightbox(images,index,urlOf){
 const img=el('img',{class:'tk-lightbox-img',alt:''}),caption=el('figcaption',{}),open=el('a',{class:'acc-btn small',target:'_blank',rel:'noopener'},t('Otevřít v nové kartě'));
 const go=i=>{index=(i+images.length)%images.length;const a=images[index];img.setAttribute('src',urlOf(a));img.setAttribute('alt',a.name);caption.textContent=images.length>1?`${a.name} · ${index+1}/${images.length}`:a.name;open.setAttribute('href',urlOf(a));};
 const step=(d,text,icon)=>images.length>1?el('button',{type:'button',class:'tk-lightbox-nav','aria-label':text,title:text,onclick:()=>go(index+d)},icon):null;
 const dialog=el('dialog',{class:'tk-dialog tk-lightbox','aria-label':t('Náhled přílohy'),onclick:e=>{if(e.target===dialog)dialog.close();},onkeydown:e=>{if(e.key==='ArrowRight')go(index+1);else if(e.key==='ArrowLeft')go(index-1);}},
  el('figure',{},img,caption),el('div',{class:'tk-lightbox-bar'},step(-1,t('Předchozí'),'←'),step(1,t('Další'),'→'),open,el('button',{type:'button',class:'acc-btn small',onclick:()=>dialog.close()},t('Zavřít'))));
 go(index);showDialog(dialog);
}
function renderTicket(wrap,ctx,tk,keep){
 const {canWrite,meta,user}=ctx,project=meta.projects.find(p=>p.id===tk.project),msg=status(),keys=meta.projects.map(p=>p.key);
 if(keep.notice)msg.textContent=keep.notice;
 // Runs a write; on success re-renders with the returned ticket, dropping the drafts the write just saved.
 const write=async(button,request,saved)=>{
  if(button)button.disabled=true;const epoch=sessionEpoch;let updated;
  try{updated=await request();}catch(e){if(wrap.isConnected){fail(msg,e);if(button)button.disabled=false;}return;}
  if(epoch!==sessionEpoch||!wrap.isConnected)return;
  // Another write may have re-rendered meanwhile: still drop what this one saved, but never show an older ticket.
  const shown=pages.get(wrap)?.ticket||tk,next=drafts(wrap);saved(next);next.notice=t('Uloženo.');
  renderTicket(wrap,ctx,updated.updatedAt>=shown.updatedAt?updated:shown,next);
 };
 // A save from the edit form closes it (back to the read view); any other write leaves it as it is.
 const save=(change,button,fromEdit=false)=>write(button,()=>api('/api/tickets/update',{id:tk.id,rev:tk.rev,...change}),next=>{if(fromEdit){next.fields={};next.editing=false;}else for(const k of Object.keys(change))delete next.fields[k];});
 // The read view is the default. The edit form is drawn only while editing: opened with the button or e, and
 // kept open across a re-render while it is open or still holds unsaved changes.
 const editing=canWrite&&(keep.editing===true||Object.keys(keep.fields||{}).length>0);
 const shownTicket=()=>pages.get(wrap)?.ticket||tk;
 const openEdit=()=>{if(!canWrite||pages.get(wrap)?.editing)return false;renderTicket(wrap,ctx,shownTicket(),{...drafts(wrap),editing:true,focus:'title'});};
 const closeEdit=()=>{
  if(Object.keys(drafts(wrap).fields).length&&!confirm(t('Zahodit neuložené úpravy?')))return;
  renderTicket(wrap,ctx,shownTicket(),{...drafts(wrap),fields:{},editing:false,focus:'edit'});
 };
 const quick=[],editButton=canWrite&&!editing?el('button',{type:'button',class:'acc-btn small tk-edit-open','aria-keyshortcuts':'e',onclick:()=>void openEdit()},`✎ ${t('Upravit')}`):null;
 if(canWrite){
  const b=(text,next,cls='')=>el('button',{type:'button',class:`acc-btn small ${cls}`,onclick:e=>save({status:next},e.currentTarget)},text);
  if(tk.status==='open')quick.push(b(`▶ ${t('Začít')}`,'in-progress'));
  if(ACTIVE.includes(tk.status))quick.push(b(`✓ ${t('Hotovo')}`,'done','primary'),b(t('Zrušit položku'),'cancelled'));
  if(CLOSED.includes(tk.status))quick.push(b(`↺ ${t('Znovu otevřít')}`,'open'));
  if(editButton)quick.push(editButton);
 }
 const fact=(k,v)=>[el('dt',{},k),el('dd',{},v)];
 const commentBox=canWrite?el('textarea',{name:'text',rows:'3',required:'',maxlength:'8000',placeholder:t('Komentář, postup, commit…'),'aria-label':t('Nový komentář'),'aria-keyshortcuts':'c'}):null;
 if(commentBox)commentBox.value=keep.comment||'';
 const commentEditor=commentBox?mdEditor(commentBox,keys):null;
 const edit=editing?editForm(tk,meta,save,ctx,closeEdit):null;
 if(edit)for(const [k,v] of Object.entries(keep.fields||{}))if(edit.inputs[k])edit.inputs[k].value=v;
 pages.set(wrap,{ticket:tk,comment:commentBox,editing,inputs:edit?.inputs||{},initial:edit?.initial||{}});
 const comments=el('section',{class:'acc-card'},el('h3',{},t('Komentáře ({n})',{n:tk.comments.length})),
  tk.comments.length?el('ol',{class:'tk-comments'},tk.comments.map(c=>el('li',{class:'tk-comment'},
   el('div',{class:'tk-comment-head'},el('span',{class:'tk-avatar','aria-hidden':'true'},initials(c.by)||'?'),el('b',{},c.by),el('span',{class:'tk-dim',title:when(c.at)},ago(c.at))),
   markdown(c.text,{keys})))):el('p',{class:'acc-dim'},t('Zatím bez komentářů.')),
  canWrite?el('form',{class:'tk-form',onsubmit:e=>{e.preventDefault();const f=e.currentTarget,text=f.text.value;
    return write(f.querySelector('button'),()=>api('/api/tickets/comment',{id:tk.id,text}),next=>{if(next.comment===text)next.comment='';});}},
   commentEditor.node,el('div',{class:'acc-actions tk-comment-actions'},mdHint(commentEditor.toggle),el('button',{type:'submit',class:'acc-btn'},t('Přidat komentář')))):null);
 // Attachments: upload with the button, by dropping files on the section or pasting (Cmd+V) anywhere on the page.
 const files=tk.attachments||[],fileUrl=a=>`/api/tickets/${encodeURIComponent(tk.id)}/attachments/${a.id}`,images=files.filter(a=>a.type.startsWith('image/'));
 const upload=async list=>{
  for(const file of list){
   if(file.size>20*1024*1024){fail(msg,new Error(t('{name}: soubor je větší než 20 MB.',{name:file.name})));continue;}
   msg.classList.remove('error');msg.textContent=t('Nahrávám {name}…',{name:file.name||t('soubor')});
   const name=file.name&&file.name!=='image.png'?file.name:`paste-${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}.${(file.type.split('/')[1]||'bin').replace('jpeg','jpg')}`;
   await write(null,async()=>{const lost=authGuard(),r=await fetch(`/api/tickets/${encodeURIComponent(tk.id)}/attachments?name=${encodeURIComponent(name)}`,{method:'PUT',headers:{'Content-Type':'application/octet-stream'},body:file});lost(r);
    const data=await r.json().catch(()=>({}));if(!r.ok)throw new Error(data.error?.message?t(data.error.message):t('Nahrání se nepovedlo.'));return data;},()=>{});
  }
 };
 const picker=canWrite?el('input',{type:'file',multiple:'',hidden:'',onchange:e=>{const list=[...e.target.files];e.target.value='';upload(list);}}):null;
 const thumb=a=>a.type.startsWith('image/')
  ?el('a',{href:fileUrl(a),target:'_blank',rel:'noopener',class:'tk-file-thumb','aria-label':t('Zobrazit {name}',{name:a.name}),onclick:e=>{e.preventDefault();lightbox(images,images.indexOf(a),fileUrl);}},el('img',{src:fileUrl(a),alt:a.name,loading:'lazy'}))
  :el('a',{href:fileUrl(a)+(a.type==='text/plain'?'':'?download=1'),target:'_blank',rel:'noopener',class:'tk-file-thumb tk-file-icon','aria-hidden':'true',tabindex:'-1'},a.type==='application/pdf'?'PDF':a.type==='text/plain'?'TXT':'⬇');
 const attachments=el('section',{class:'acc-card tk-files-card',
   ondragover:e=>{if(!canWrite)return;e.preventDefault();e.currentTarget.classList.add('tk-drop');},ondragleave:e=>e.currentTarget.classList.remove('tk-drop'),
   ondrop:e=>{if(!canWrite)return;e.preventDefault();e.currentTarget.classList.remove('tk-drop');upload([...e.dataTransfer.files]);}},
  el('div',{class:'tk-files-head'},el('h3',{},t('Přílohy ({n})',{n:files.length})),canWrite?el('button',{type:'button',class:'acc-btn small',onclick:()=>picker.click()},t('+ Přidat soubor')):null,picker),
  files.length?el('ul',{class:'tk-files'},files.map(a=>el('li',{class:`tk-file${a.type.startsWith('image/')?' tk-file-image':''}`},thumb(a),
   el('div',{class:'tk-file-meta'},el('a',{href:fileUrl(a)+(a.type.startsWith('image/')||a.type==='text/plain'?'':'?download=1'),target:'_blank',rel:'noopener',class:'tk-file-name',title:a.name},a.name),el('span',{class:'tk-dim'},`${fileSize(a.size)} · ${a.by} · ${ago(a.at)}`)),
   canWrite?el('button',{type:'button',class:'acc-btn small tk-file-del','aria-label':t('Odebrat {name}',{name:a.name}),title:t('Odebrat přílohu'),onclick:e=>{if(!confirm(t('Odebrat přílohu {name}?',{name:a.name})))return;write(e.currentTarget,()=>api('/api/tickets/attachments/delete',{id:tk.id,attachment:a.id}),()=>{});}},'×'):null))):null,
  canWrite?el('p',{class:'tk-dropzone'},t('Přetáhni sem soubor, vlož obrázek ze schránky (Cmd/Ctrl+V) nebo použij tlačítko. Nejvýš 20 MB na soubor.')):files.length?null:el('p',{class:'acc-dim'},t('Bez příloh.')));
 if(canWrite&&typeof addEventListener==='function'){const old=pastes.get(wrap);if(old)removeEventListener('paste',old);
  const onPaste=e=>{if(!wrap.isConnected){removeEventListener('paste',onPaste);return;}const list=[...(e.clipboardData?.files||[])];if(!list.length)return;e.preventDefault();upload(list);};
  pastes.set(wrap,onPaste);addEventListener('paste',onPaste);onLeave(()=>removeEventListener('paste',onPaste));}
 const assignMe=canWrite&&user&&tk.assignee!==user&&!CLOSED.includes(tk.status)?el('button',{type:'button',class:'tk-inline-btn',onclick:e=>save({assignee:user},e.currentTarget)},t('Vezmu si to')):null;
 show(wrap,
  backPath(tk,meta.projects),
  // Each field is on the page once: type, priority, status and labels in the head, the rest under "Údaje".
  el('div',{class:'tk-head'},el('div',{},el('div',{class:'tk-mono tk-dim'},`${tk.id} · ${project?.name||tk.project}`),
    el('div',{class:'ui-title'},el('h1',{class:'tk-title'},glyph(tk.type),' ',tk.title),provenanceBadge(tk.provenance)),
    el('div',{class:'tk-pills'},pill(TYPES(),tk.type),pill(PRIORITIES(),tk.priority),pill(STATUSES(),tk.status),
     (tk.labels||[]).map(l=>el('span',{class:'tk-label'},l)))),
   el('div',{class:'tk-quick'},quick)),
  msg,
  el('div',{class:'tk-detail'},
   // While editing, the form takes the place of the rendered description: the text is never shown twice.
   el('div',{class:'acc-stack'},edit?edit.form:el('section',{class:'acc-card'},el('h3',{},t('Popis')),tk.description?markdown(tk.description,{keys}):el('p',{class:'acc-dim'},t('Bez popisu.'))),attachments,comments,timeline(tk)),
   el('div',{class:'acc-stack'},
    el('section',{class:'acc-card'},el('h3',{},t('Údaje')),el('dl',{class:'acc-dl'},
     fact('Release',tk.release?el('a',{class:'sys-link',href:'#releases',onclick:()=>{filters.project=tk.project;}},tk.release):'—'),fact(t('Řeší'),el('span',{class:'tk-fact-row'},tk.assignee?[el('span',{class:'tk-avatar','aria-hidden':'true'},initials(tk.assignee)),tk.assignee]:'—',assignMe)),fact(t('Nahlásil'),tk.reporter||'—'),
     fact(t('Odkazy'),tk.refs.length?el('div',{class:'tk-refs'},tk.refs.map(r=>/^https?:\/\//.test(r)?el('a',{href:r,target:'_blank',rel:'noopener noreferrer',class:'sys-link'},r):TICKETISH.test(r)?el('a',{href:'#items/'+r,class:'sys-link'},r):el('code',{},r))):'—'),
     fact(t('Založeno'),when(tk.createdAt)),fact(t('Změněno'),when(tk.updatedAt)),...(tk.closedAt?fact(t('Uzavřeno'),when(tk.closedAt)):[]),fact(t('Revize'),String(tk.rev)))))));
 shortcuts(wrap,{c:()=>commentBox?void commentBox.focus():false,e:openEdit});
 if(prefs.focusComment){prefs.focusComment=false;commentBox?.focus();}
 // Opening the form puts the keyboard in its first field; closing it puts it back on the button that opened it.
 if(keep.focus==='title')edit?.inputs.title?.focus();
 else if(keep.focus==='edit')editButton?.focus();
}
const TICKETISH=/^[A-Z][A-Z0-9]{1,9}-[1-9][0-9]{0,5}$/;
const FIELD_NAMES=()=>({attachment:t('Příloha'),created:t('Založeno'),title:t('Název položky'),description:t('Popis'),type:t('Typ'),status:t('Stav'),priority:t('Priorita'),release:'Release',assignee:t('Řeší'),labels:t('Štítky'),refs:t('Odkazy')});
function historyText(h){
 if(h.field==='created')return t('Položka založena');
 if(h.field==='attachment')return h.to?t('Příloha přidána: {name}',{name:h.to}):t('Příloha odebrána: {name}',{name:h.from});
 const name=FIELD_NAMES()[h.field]||h.field;
 if(h.from===null&&h.to===null)return t('{field}: upraveno',{field:name});
 const v=x=>x===null||x===undefined||(Array.isArray(x)&&!x.length)?'—':Array.isArray(x)?x.join(', '):h.field==='status'?label(STATUSES(),x):h.field==='type'?label(TYPES(),x):h.field==='priority'?label(PRIORITIES(),x):String(x);
 return `${name}: ${v(h.from)} → ${v(h.to)}`;
}
// History as a timeline, newest first: the latest changes are shown, older ones fold away.
const EVENT_ICON={created:'✚',status:'◐',attachment:'📎',assignee:'☺',release:'⚑',priority:'▲',labels:'#',refs:'↗',title:'✎',description:'✎',type:'◆'},EVENTS_SHOWN=6;
function timeline(tk){
 const events=[...tk.history].reverse();
 const row=h=>el('li',{class:`tk-event ${h.field==='status'?TONE[h.to]||'':''}`},el('span',{class:'tk-event-icon','aria-hidden':'true'},EVENT_ICON[h.field]||'•'),
  el('div',{},el('b',{},historyText(h)),el('div',{class:'tk-dim tk-event-meta',title:when(h.at)},`${h.by} · ${ago(h.at)}`)));
 const older=events.slice(EVENTS_SHOWN);
 return el('section',{class:'acc-card'},el('h3',{},t('Historie změn ({n})',{n:events.length})),el('ol',{class:'tk-events'},events.slice(0,EVENTS_SHOWN).map(row)),
  older.length?el('details',{class:'tk-events-more'},el('summary',{},tp(older.length,'{n} starší změna|{n} starší změny|{n} starších změn')),el('ol',{class:'tk-events'},older.map(row))):null);
}
// The edit form of one ticket: every editable field once, description included. onCancel closes it.
function editForm(tk,meta,save,ctx={},onCancel){
 const inputs={},field=(text,input,...more)=>{if(input.getAttribute('name'))inputs[input.getAttribute('name')]=input;return el('label',{},text,input,...more);};
 const releases=meta.releases.filter(r=>r.project===tk.project&&(r.status==='planned'||r.version===tk.release)).map(r=>[r.version,r.status==='released'?t('{version} (vydáno)',{version:r.version}):r.version]);
 const assignee=assigneeInput(tk.assignee,ctx.people||[],ctx.user);
 const description=el('textarea',{name:'description',rows:'8',maxlength:'12000'});description.value=tk.description;
 const editor=mdEditor(description,meta.projects.map(p=>p.key));inputs.description=description;
 const form=el('form',{class:'acc-card tk-form tk-edit','aria-label':t('Upravit položku {id}',{id:tk.id}),onsubmit:e=>{e.preventDefault();const f=e.currentTarget;
   const values={title:f.title.value.trim(),description:f.description.value.trim(),type:f.type.value,status:f.status.value,priority:f.priority.value,release:f.release.value||null,assignee:f.assignee.value.trim()||null,labels:[...new Set(splitList(f.labels.value).map(v=>v.toLowerCase()))],refs:[...new Set(f.refs.value.split(/\r?\n/).map(v=>v.trim()).filter(Boolean))]};
   const changed=Object.fromEntries(Object.entries(values).filter(([k,v])=>JSON.stringify(v)!==JSON.stringify(tk[k])));
   if(Object.keys(changed).length)return save(changed,f.querySelector('button[type=submit]'),true);}},
  el('h3',{},t('Upravit')),
  field(t('Název položky'),el('input',{name:'title',required:'',maxlength:'200',value:tk.title})),
  el('div',{class:'tk-grid2'},field(t('Stav'),el('select',{name:'status'},options(STATUSES(),tk.status))),field(t('Typ'),el('select',{name:'type'},options(TYPES(),tk.type))),
   field(t('Priorita'),el('select',{name:'priority'},options(PRIORITIES(),tk.priority))),field('Release',el('select',{name:'release'},options(releases,tk.release||'',t('Bez releasu'))))),
  field(t('Řeší'),assignee.input,assignee.list),assignee.mine,
  field(t('Štítky (čárkou)'),el('input',{name:'labels',value:tk.labels.join(', ')})),
  field(t('Odkazy (commit, PR, položka; každý na vlastní řádek)'),(()=>{const a=el('textarea',{name:'refs',rows:'2'});a.value=tk.refs.join('\n');return a;})()),
  el('label',{},t('Popis'),editor.node),mdHint(editor.toggle),
  el('div',{class:'acc-actions'},onCancel?el('button',{type:'button',class:'acc-btn',onclick:onCancel},t('Zrušit úpravy')):null,el('button',{type:'submit',class:'acc-btn primary'},t('Uložit změny'))));
 return {form,inputs,initial:Object.fromEntries(Object.entries(inputs).map(([k,input])=>[k,input.value]))};
}

// Releases --------------------------------------------------------------------------------------
async function releasesPage(wrap,ctx){
 const data=await load(wrap,api('/api/tickets'+(filters.project?'?project='+encodeURIComponent(filters.project):'')));if(!data)return;
 renderReleases(wrap,ctx,data);
}
const NO_COUNTS=Object.freeze({open:0,'in-progress':0,done:0,cancelled:0});
function renderReleases(wrap,ctx,data,notice=''){
 const {canWrite}=ctx,msg=status(),redraw=()=>releasesPage(wrap,ctx).catch(e=>fail(msg,e));if(notice)msg.textContent=notice;
 const add=canWrite&&data.projects.length?{label:t('+ Nová položka'),onclick:()=>newTicket(data.projects,filters.project||null,ctx)}:null;
 const title=head(t('Releasy'),t('Verze, do kterých položky patří: co zbývá, co je hotové a kdy má release vyjít.'),[add],data.provenance);
 if(!data.projects.length)return show(wrap,title,noProjects(ctx,redraw));
 // The saved release is shown at once from the POST reply; the follow-up refresh (new counts) may fail on its own.
 const saveRelease=async(body,button)=>{
  if(button)button.disabled=true;const epoch=sessionEpoch;let saved;
  try{saved=await api('/api/tickets/releases',body);}catch(e){if(wrap.isConnected){fail(msg,e);if(button)button.disabled=false;}return;}
  if(epoch!==sessionEpoch||!wrap.isConnected)return;
  const same=r=>r.project===saved.project&&r.version===saved.version,old=data.releases.find(same);
  const releases=[...data.releases.filter(r=>!same(r)),{counts:{...NO_COUNTS},total:0,...old,...saved}].sort((a,b)=>a.project.localeCompare(b.project)||a.version.localeCompare(b.version,'en',{numeric:true,sensitivity:'base'}));
  renderReleases(wrap,ctx,{...data,releases},t('Uloženo.'));
  try{const fresh=await load(wrap,api('/api/tickets'+(filters.project?'?project='+encodeURIComponent(filters.project):'')));if(fresh)renderReleases(wrap,ctx,fresh,t('Uloženo.'));}
  catch(e){const m=wrap.querySelector('p[role=status]');if(m)fail(m,new Error(t('Uloženo, ale přehled se nepodařilo obnovit: {error}',{error:e.message})));}
 };
 const projects=data.projects.filter(p=>!filters.project||p.id===filters.project);
 const item=tk=>el('li',{class:CLOSED.includes(tk.status)?'tk-closed':''},glyph(tk.type),el('a',{href:'#items/'+tk.id},tk.id),el('span',{class:'tk-mini-title'},tk.title),pill(STATUSES(),tk.status));
 const card=(r,hero)=>{
  const mine=data.tickets.filter(x=>x.project===r.project&&x.release===r.version),scope=r.total-r.counts.cancelled,d=due(r);
  const left=mine.filter(x=>ACTIVE.includes(x.status)),done=mine.filter(x=>!ACTIVE.includes(x.status));
  return el('section',{class:`acc-card tk-release${r.status==='released'?' tk-released':''}${hero?' tk-hero':''}${d?.tone?' tk-due-'+d.tone:''}`},
   el('div',{class:'tk-release-head'},el('div',{},hero?el('div',{class:'tk-eyebrow'},t('Další release')):null,el('b',{class:'tk-version'},r.version),' ',el('span',{class:`sec-pill ${r.status==='released'?'ok':'warn'}`},r.status==='released'?t('vydáno'):t('plánováno')),
     d?el('span',{class:`sec-pill tk-countdown ${d.tone}`,title:t('cíl {date}',{date:dayText(r.targetDate)})},d.text):null,
     el('div',{class:'sec-dim'},r.status==='released'?t('vydáno {date}',{date:dayText(r.releasedAt)}):t('cíl {date}',{date:dayText(r.targetDate)}),` · ${t('{done}/{scope} hotovo',{done:r.counts.done,scope})} · ${t('otevřené: {n}',{n:r.counts.open})} · ${t('rozpracované: {n}',{n:r.counts['in-progress']})}`)),
    canWrite?el('div',{},r.status==='planned'?el('button',{type:'button',class:'acc-btn small primary',title:r.counts.open+r.counts['in-progress']?t('Release má ještě nedokončené položky.'):'',onclick:e=>saveRelease({project:r.project,version:r.version,rev:r.rev,status:'released'},e.currentTarget)},t('Označit jako vydané'))
     :el('button',{type:'button',class:'acc-btn small',onclick:e=>saveRelease({project:r.project,version:r.version,rev:r.rev,status:'planned'},e.currentTarget)},t('Vrátit do plánu'))):null),
   progressBar(r.counts,scope),r.notes?markdown(r.notes,{keys:data.projects.map(p=>p.key),cls:'tk-md tk-md-dim'}):null,
   !mine.length?el('p',{class:'acc-dim'},t('Zatím bez položek.'))
   :hero?el('div',{class:'tk-split'},
     el('div',{},el('h4',{class:'tk-eyebrow'},t('Zbývá ({n})',{n:left.length})),left.length?el('ul',{class:'tk-mini'},left.map(item)):el('p',{class:'acc-dim'},t('Vše hotovo — můžeš vydat. 🚀'))),
     el('div',{},el('h4',{class:'tk-eyebrow'},t('Hotovo ({n})',{n:done.length})),done.length?el('ul',{class:'tk-mini'},done.map(item)):el('p',{class:'acc-dim'},t('Zatím nic.'))))
   :el('ul',{class:'tk-mini'},mine.map(item)));
 };
 const node=(r,hero)=>el('li',{class:`tk-tl ${r.status}${hero?' next':''}`},el('span',{class:'tk-tl-dot','aria-hidden':'true'}),card(r,hero));
 const addForm=p=>el('form',{class:'acc-form tk-release-form',onsubmit:e=>{e.preventDefault();const f=e.currentTarget;saveRelease({project:p.id,version:f.version.value.trim(),targetDate:f.targetDate.value||null,notes:f.notes.value},f.querySelector('button'));}},
  el('label',{},t('Verze'),el('input',{name:'version',required:'',maxlength:'40',pattern:'(?!none$)[A-Za-z0-9][A-Za-z0-9._+\\-]{0,39}',placeholder:t('např. 2.4 nebo v0.5.0')})),
  el('label',{},t('Cílové datum'),el('input',{name:'targetDate',type:'date'})),el('label',{},t('Poznámka'),el('input',{name:'notes',maxlength:'2000',placeholder:t('Co release přináší')})),
  el('button',{type:'submit',class:'acc-btn primary'},t('Přidat release')));
 show(wrap,title,el('div',{class:'tk-toolbar'},el('div',{class:'tk-toolbar-left'},projectChips(data.projects,redraw))),msg,
  ...projects.map(p=>{
   const releases=data.releases.filter(r=>r.project===p.id),planned=releases.filter(r=>r.status==='planned').sort(plannedOrder),released=releases.filter(r=>r.status==='released').reverse();
   const unplanned=data.tickets.filter(x=>x.project===p.id&&!x.release&&ACTIVE.includes(x.status)).length,recent=released.slice(0,3),older=released.slice(3);
   return el('div',{class:'acc-stack tk-project'},el('h2',{class:'tk-project-name'},el('a',{href:'#projects/'+p.id},p.name),' ',el('span',{class:'sec-dim'},`${p.key} · ${t('aktivní položky bez releasu: {n}',{n:unplanned})}`)),
    canWrite?addForm(p):null,
    planned.length||released.length?el('ol',{class:'tk-timeline'},...planned.map((r,i)=>node(r,i===0)),...recent.map(r=>node(r,false)))
     :el('p',{class:'tk-none-line'},canWrite?t('Zatím žádný release. Přidej první formulářem výše, nebo ho nech založit agenta nástrojem release_save.'):t('Zatím žádný release.')),
    older.length?el('details',{class:'sec-findings'},el('summary',{},t('Starší vydané ({n})',{n:older.length})),el('ol',{class:'tk-timeline'},older.map(r=>node(r,false)))):null);
  }));
 shortcuts(wrap,{n:()=>add?void add.onclick():false});
}

// Projects --------------------------------------------------------------------------------------
// Health ring: share of open / in progress / done (cancelled left out), done % in the middle.
function healthRing(c){
 const total=c.open+c['in-progress']+c.done,pct=total?Math.round(c.done/total*100):0,a=total?c.open/total*100:0,b=total?(c.open+c['in-progress'])/total*100:0;
 const ring=el('div',{class:'tk-ring',role:'img','aria-label':t('Hotovo {pct} % ({done} z {total})',{pct,done:c.done,total})},el('div',{class:'tk-ring-hole'},el('b',{},pct+'%'),el('span',{},`${c.done}/${total}`)));
 if(total)ring.style.background=`conic-gradient(var(--warn) 0 ${a}%, var(--accent2) ${a}% ${b}%, var(--ok) ${b}% 100%)`;
 return ring;
}
function health(tickets){
 const c=statusCounts(tickets),bugs=activeBugs(tickets);
 const row=(tone,k,v)=>el('li',{class:tone},el('span',{class:'tk-dot'}),el('span',{},k),el('b',{},String(v)));
 return el('div',{class:'tk-health'},healthRing(c),el('div',{class:'tk-legend-wrap'},
  el('ul',{class:'tk-legend'},row('warn',t('Otevřené'),c.open),row('info',t('Rozpracované'),c['in-progress']),row('ok',t('Hotové'),c.done)),
  bugs?el('span',{class:'sec-pill crit tk-bugs'},`🐞 ${tp(bugs,'{n} aktivní chyba|{n} aktivní chyby|{n} aktivních chyb')}`):null));
}
// Closed items per day over the last 14 days, plus the latest changes.
const DAYS=14;
function activity(tickets,recent=3){
 const days=[...Array(DAYS)].map((_,i)=>dayKey(new Date(Date.now()-(DAYS-1-i)*864e5))),hits=Object.fromEntries(days.map(d=>[d,0]));
 for(const tk of tickets)if(tk.status==='done'&&tk.closedAt){const k=dayKey(new Date(tk.closedAt));if(k in hits)hits[k]++;}
 const max=Math.max(1,...Object.values(hits)),sum=Object.values(hits).reduce((x,y)=>x+y,0),caption=t('Uzavřeno za {days} dní: {n}',{days:DAYS,n:sum});
 const spark=el('div',{class:'tk-spark',role:'img','aria-label':caption},days.map(d=>{const bar=el('span',{title:`${dayText(d)}: ${hits[d]}`,class:hits[d]?'hit':''});bar.style.height=Math.max(8,hits[d]/max*100)+'%';return bar;}));
 const latest=[...tickets].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).slice(0,recent);
 return el('div',{class:'tk-activity'},el('div',{class:'tk-eyebrow'},caption),spark,
  latest.length?el('ul',{class:'tk-feed'},latest.map(tk=>el('li',{},el('a',{href:'#items/'+tk.id},tk.id),' → ',el('span',{class:`tk-feed-st ${TONE[tk.status]||''}`},label(STATUSES(),tk.status).toLowerCase()),el('span',{class:'tk-dim'},' · '+ago(tk.updatedAt))))):null);
}
function nextBlock(releases,project){
 const next=nextRelease(releases,project);
 if(!next)return el('p',{class:'sec-dim tk-next'},t('Žádný naplánovaný release.'));
 const scope=next.total-next.counts.cancelled,d=due(next);
 return el('div',{class:`tk-next${d?.tone?' tk-due-'+d.tone:''}`},el('div',{class:'tk-next-head'},el('span',{class:'tk-eyebrow'},t('Další release')),el('a',{href:'#releases',class:'tk-version',onclick:()=>{filters.project=project;}},next.version),
   d?el('span',{class:`sec-pill tk-countdown ${d.tone}`,title:t('cíl {date}',{date:dayText(next.targetDate)})},d.text):null),progressBar(next.counts,scope));
}
async function projectsPage(wrap,ctx){
 const {canWrite}=ctx,data=await load(wrap,api('/api/tickets'));if(!data)return;
 const msg=status(),redraw=()=>projectsPage(wrap,ctx).catch(e=>fail(msg,e));
 const add=canWrite&&data.projects.length?{label:t('+ Nová položka'),primary:true,onclick:()=>newTicket(data.projects,null,ctx)}:null;
 const title=head(t('Projekty'),t('Na čem se pracuje: stav položek, aktivita a nejbližší release každého projektu.'),[canWrite&&data.projects.length?{label:t('+ Nový projekt'),onclick:()=>newProject(redraw)}:null,add],data.provenance);
 if(!data.projects.length)return show(wrap,title,noProjects(ctx,redraw));
 const open=(project,hash)=>e=>{e.stopPropagation();Object.assign(filters,defaults,{project});location.hash=hash;};
 const card=p=>{
  const mine=data.tickets.filter(x=>x.project===p.id);
  return el('section',{class:'acc-card tk-project-card',onclick:e=>{if(!e.target?.closest?.('a,button'))location.hash='#projects/'+p.id;}},
   el('div',{class:'tk-release-head'},el('div',{},el('h2',{class:'tk-project-name'},el('a',{href:'#projects/'+p.id},p.name)),el('span',{class:'sec-pill'},p.key),p.type?el('span',{class:'sec-pill'},label(PROJECT_TYPES(),p.type)):null),
    canWrite?el('button',{type:'button',class:'acc-btn small',onclick:e=>{e.stopPropagation();editProject(p,redraw);}},t('Upravit')):null),
   p.description?el('p',{class:'tk-text acc-dim'},p.description):null,
   mine.length?[health(mine),activity(mine,2),nextBlock(data.releases,p.id)]
    :el('div',{class:'tk-fresh'},el('div',{class:'tk-fresh-icon','aria-hidden':'true'},'✨'),el('p',{},t('Čistý štít — zatím tu nic není.')),
      canWrite?el('button',{type:'button',class:'acc-btn small primary',onclick:e=>{e.stopPropagation();newTicket(data.projects,p.id,ctx);}},t('+ První položka')):null),
   el('div',{class:'tk-links'},el('a',{href:'#projects/'+p.id,class:'acc-btn small'},`${t('Detail projektu')} →`),el('button',{type:'button',class:'acc-btn small',onclick:open(p.id,'#items')},`${t('Položky')} →`),el('button',{type:'button',class:'acc-btn small',onclick:open(p.id,'#releases')},`${t('Releasy')} →`),el('a',{class:'acc-btn small',href:'#review/'+p.id},'Review →')));
 };
 show(wrap,title,msg,el('div',{class:'tk-projects'},data.projects.map(card)));
 shortcuts(wrap,{n:()=>add?void add.onclick():false});
}
// One project: health, activity and next release on top, then a board of its items.
async function projectPage(wrap,ctx){
 const {canWrite,id}=ctx,data=await load(wrap,api('/api/tickets?project='+encodeURIComponent(id)).catch(e=>{if(e.status===400)e.status=404;throw e;}));if(!data)return;
 const p=data.projects.find(x=>x.id===id);
 if(!p){const e=new Error(t('Projekt „{id}“ v trackeru není.',{id}));e.status=404;throw e;}
 const msg=status(),redraw=()=>projectPage(wrap,ctx).catch(e=>fail(msg,e));
 const mine=data.tickets.filter(x=>x.project===id);
 const to=hash=>()=>{Object.assign(filters,defaults,{project:id});location.hash=hash;};
 const add=canWrite?{label:t('+ Nová položka'),primary:true,onclick:()=>newTicket(data.projects,id,ctx)}:null;
 show(wrap,
  el('nav',{class:'tk-crumbs','aria-label':t('Drobečková navigace')},el('a',{href:'#projects'},t('Projekty')),el('span',{class:'tk-dim'},'/'),el('b',{},p.name),el('span',{class:'sec-pill'},p.key),p.type?el('span',{class:'sec-pill'},label(PROJECT_TYPES(),p.type)):null),
  pageHeader({title:p.name,lead:p.description||undefined,provenance:data.provenance,actions:[canWrite?{label:t('Upravit'),onclick:()=>editProject(p,redraw)}:null,{label:`${t('Tabulka')} →`,onclick:to('#items')},{label:`${t('Releasy')} →`,onclick:to('#releases')},{label:'Review →',href:'#review/'+id},add].filter(Boolean)}),
  msg,
  mine.length?el('div',{class:'acc-card tk-hero-row'},health(mine),activity(mine,4),nextBlock(data.releases,id)):null,
  mine.length?boardView(mine,{canWrite,msg,redraw,projects:data.projects,showProject:false})
   :emptyState({icon:'✨',title:t('Čistý štít'),body:t('V projektu zatím nejsou žádné položky.'),
     agentPrompt:t('Přes MCP mého Home Hubu (scope tickets:write) založ nástrojem ticket_create první položky projektu {id}: title, description s kritérii přijetí, type bug|feature|task a priority.',{id}),
     actions:canWrite?[{label:t('+ První položka'),primary:true,onclick:()=>newTicket(data.projects,id,ctx)}]:[]}),
  mine.length?keysHint(['n',t('nová položka')],['j k',t('další / předchozí')],['Enter',t('otevřít')]):null);
 shortcuts(wrap,{n:()=>add?void add.onclick():false,j:()=>moveCursor(wrap,1),k:()=>moveCursor(wrap,-1),Enter:()=>openCursor(wrap)});
}
// A new project: the name proposes an id and a key until either is typed by hand; both are permanent.
const slugOf=name=>name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^[^a-z]+|-+$/g,'').slice(0,40);
const keyOf=name=>{const words=name.normalize('NFD').replace(/[̀-ͯ]/g,'').toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
 return (words.length>1?words.map(w=>w[0]).join(''):(words[0]||'')).replace(/^[^A-Z]+/,'').slice(0,words.length>1?5:4);};
function newProject(done){
 const msg=status(),touched={id:false,key:false};
 const name=el('input',{name:'name',required:'',maxlength:'80',autocomplete:'off',oninput:()=>{if(!touched.id)id.value=slugOf(name.value);if(!touched.key)key.value=keyOf(name.value);}});
 const id=el('input',{name:'id',required:'',pattern:'[a-z][a-z0-9\\-]{1,39}',placeholder:'my-app',autocomplete:'off',oninput:()=>{touched.id=true;}});
 const key=el('input',{name:'key',required:'',pattern:'[A-Za-z][A-Za-z0-9]{1,9}',placeholder:'APP',autocomplete:'off',oninput:()=>{touched.key=true;}});
 const form=el('form',{class:'tk-form',onsubmit:async e=>{e.preventDefault();const f=e.currentTarget,b=f.querySelector('button[type=submit]');b.disabled=true;
   try{const made=await api('/api/tickets/projects',{id:f.id.value.trim(),key:f.key.value.trim().toUpperCase(),name:f.name.value,description:f.description.value,type:f.type.value||null});
    dialog.close();if(location.hash==='#projects')await done?.();else location.hash='#projects/'+made.id;}catch(err){fail(msg,err);b.disabled=false;}}},
  el('label',{},t('Název'),name),
  el('div',{class:'tk-grid3'},el('label',{},'Id',id),el('label',{},t('Zkratka (prefix položek)'),key),el('label',{},t('Typ'),el('select',{name:'type'},options(PROJECT_TYPES(),'app',t('Bez typu'))))),
  el('label',{},t('Popis'),el('input',{name:'description',maxlength:'500'})),
  el('p',{class:'acc-dim'},t('Id a zkratka se později nedají změnit; položky budou mít čísla jako APP-1.')),
  msg,el('div',{class:'acc-actions'},el('button',{type:'button',class:'acc-btn',onclick:()=>dialog.close()},t('Zrušit')),el('button',{type:'submit',class:'acc-btn primary'},t('Založit projekt'))));
 const dialog=el('dialog',{class:'acc-dialog wide tk-dialog','aria-label':t('Nový projekt')},el('h3',{},t('Nový projekt')),form);
 showDialog(dialog);name.focus();
}
function editProject(p,done){
 const msg=status();
 const form=el('form',{class:'tk-form',onsubmit:async e=>{e.preventDefault();const f=e.currentTarget,b=f.querySelector('button[type=submit]');b.disabled=true;
   try{await api('/api/tickets/projects',{id:p.id,rev:p.rev,name:f.name.value,description:f.description.value,type:f.type.value||null});dialog.close();await done();}catch(err){fail(msg,err);b.disabled=false;}}},
  el('label',{},t('Název'),el('input',{name:'name',required:'',maxlength:'80',value:p.name})),
  el('label',{},t('Popis'),(()=>{const a=el('textarea',{name:'description',rows:'3',maxlength:'500'});a.value=p.description||'';return a;})()),
  el('label',{},t('Typ'),el('select',{name:'type'},options(PROJECT_TYPES(),p.type||'',t('Bez typu')))),
  msg,el('div',{class:'acc-actions'},el('button',{type:'button',class:'acc-btn',onclick:()=>dialog.close()},t('Zrušit')),el('button',{type:'submit',class:'acc-btn primary'},t('Uložit'))));
 const dialog=el('dialog',{class:'acc-dialog tk-dialog','aria-label':t('Upravit projekt')},el('h3',{},`${p.name} (${p.key})`),form);
 showDialog(dialog);
}
// Page entry for the shell (app.js): every page module exports (context) => Node, and the server's UI
// manifest names it. context = {me, page, sub, machine, site}.
export const trackerPage=({me,page,sub})=>trackerView(me,page,sub);
