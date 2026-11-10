// Project Tracker: a development tracker for your own projects.
//   #projects        projects overview: health ring, activity, next release, create / edit a project
//   #projects/<id>   one project: health, activity, next release and a board of its items
//   #items           open items (tickets) with project chips and filters, as a table or a board
//   #items/<ID>      one item: description, comments, history, editing
//   #releases        releases per project as a timeline with progress, countdown and their items
// Reads need any sign-in; writes need canWrite (the server checks again, API keys need tickets:write).
// Every edit sends the rev it read; a 409 means someone else changed it — reload and redo.
import {el,onLeave} from './views.js';
import {onSessionReset,authGuard} from './session-cache.js';
import {markdown} from './tracker-md.js';
import {timeZone} from './site.js';

const TYPES=[['bug','Chyba','crit'],['feature','Funkce','ok'],['task','Úkol','']];
const STATUSES=[['open','Otevřený','warn'],['in-progress','Rozpracovaný','info'],['done','Hotovo','ok'],['cancelled','Zrušený','dim']];
const PROJECT_TYPES=[['app','Aplikace'],['game','Hra'],['other','Jiné']];
const PRIORITIES=[['urgent','Urgentní','crit'],['high','Vysoká','warn'],['normal','Normální',''],['low','Nízká','dim']];
const label=(list,v)=>list.find(x=>x[0]===v)?.[1]||v;
const pill=(list,v)=>{const x=list.find(y=>y[0]===v);return el('span',{class:`sec-pill tk-pill ${x?.[2]||''}`},x?.[1]||v);};
const when=iso=>iso&&Number.isFinite(Date.parse(iso))?new Intl.DateTimeFormat('cs-CZ',{day:'numeric',month:'numeric',year:'numeric',hour:'2-digit',minute:'2-digit',timeZone:timeZone()}).format(new Date(iso)):'—';
const dayText=d=>d?new Intl.DateTimeFormat('cs-CZ',{day:'numeric',month:'numeric',year:'numeric',timeZone:'UTC'}).format(new Date(d+'T00:00:00Z')):'—';
const TYPE_GLYPH={bug:'🐞',feature:'✦',task:'⚙'};
const glyph=type=>el('span',{class:`tk-glyph ${type}`,role:'img',title:label(TYPES,type),'aria-label':label(TYPES,type)},TYPE_GLYPH[type]||'•');
const PRIO_ORDER={urgent:0,high:1,normal:2,low:3};
const ACTIVE=['open','in-progress'],CLOSED=['done','cancelled'];
const plural=(n,one,few,many)=>n===1?one:n>=2&&n<=4?few:many;
const initials=s=>s?s.split(/[\s._@-]+/).filter(Boolean).slice(0,2).map(w=>w[0].toUpperCase()).join(''):'';
// Calendar day in the site's time zone as YYYY-MM-DD, so "today" and the activity bars follow local midnight.
const dayKey=d=>new Intl.DateTimeFormat('en-CA',{timeZone:timeZone(),year:'numeric',month:'2-digit',day:'2-digit'}).format(d);
const ago=iso=>{const m=Math.round((Date.now()-Date.parse(iso))/60000);if(!Number.isFinite(m))return '—';if(m<1)return 'právě teď';if(m<60)return `před ${m} min`;const h=Math.round(m/60);if(h<24)return `před ${h} h`;const d=Math.round(h/24);return d<30?`před ${d} d`:when(iso).split(' ').slice(0,3).join(' ');};
const statusCounts=tickets=>Object.fromEntries(STATUSES.map(([s])=>[s,tickets.filter(t=>t.status===s).length]));
const activeBugs=tickets=>tickets.filter(t=>t.type==='bug'&&ACTIVE.includes(t.status)).length;
// The next release is the planned one with the nearest target date; undated ones come after, by version.
const plannedOrder=(a,b)=>(a.targetDate||'9999')<(b.targetDate||'9999')?-1:(a.targetDate||'9999')>(b.targetDate||'9999')?1:a.version.localeCompare(b.version,'en',{numeric:true,sensitivity:'base'});
const nextRelease=(releases,project)=>releases.filter(r=>r.project===project&&r.status==='planned').sort(plannedOrder)[0];
function due(r){
 if(r.status!=='planned'||!r.targetDate)return null;
 const days=Math.round((Date.parse(r.targetDate+'T00:00:00Z')-Date.parse(dayKey(new Date())+'T00:00:00Z'))/864e5),left=r.counts.open+r.counts['in-progress'];
 const text=days>1?`za ${days} ${plural(days,'den','dny','dní')}`:days===1?'zítra':days===0?'dnes':`${-days} ${plural(-days,'den','dny','dní')} po termínu`;
 return {days,text,tone:left&&days<0?'crit':left&&days<=3?'warn':''};
}
function progressBar(done,scope){
 const pct=scope?Math.round(done/scope*100):0;
 const bar=el('div',{class:'tk-bar',role:'progressbar','aria-valuemin':'0','aria-valuemax':'100','aria-valuenow':String(pct),'aria-label':`Hotovo ${pct} %`},el('span',{}));bar.firstChild.style.width=pct+'%';
 return bar;
}
const options=(list,value,empty)=>[...(empty?[el('option',{value:''},empty)]:[]),...list.map(([v,t])=>{const o=el('option',{value:v},t);if(v===value)o.selected=true;return o;})];

async function api(url,body){
 if(body!==undefined&&new TextEncoder().encode(JSON.stringify(body)).length>16384)throw new Error('Požadavek je příliš dlouhý (maximum 16 kB). Zkrať text nebo odešli změny po částech.');
 const lost=authGuard(),r=await fetch(url,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});lost(r);
 const data=await r.json().catch(()=>({}));
 if(!r.ok){const e=new Error(data.error?.message||'Požadavek selhal.');e.status=r.status;throw e;}
 return data;
}
// Filters survive navigation between list and detail within one page load.
const defaults={project:'',status:'active',type:'',priority:'',release:'',q:''},filters={...defaults};
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

export const TRACKER_PAGES=Object.freeze(['projects','items','releases']);
export function trackerView(me,page,sub){
 const wrap=el('section',{class:'sec tk'},el('p',{class:'sec-dim'},'Načítám…'));
 const canWrite=me?.canWrite===true;
 const draw=page==='projects'?(sub?projectPage:projectsPage):page==='releases'?releasesPage:sub?ticketPage:listPage;
 draw(wrap,{canWrite,id:sub}).catch(e=>show(wrap,el('div',{class:'sec-empty'},el('h2',{},e.status===404?(page==='projects'?'Projekt neexistuje':'Položka neexistuje'):'Project Tracker nejde načíst'),el('p',{class:'sec-dim'},e.message),page==='projects'?el('a',{href:'#projects'},'← Projekty'):el('a',{href:'#items'},'← Otevřené položky'))));
 return wrap;
}

// One slim toolbar row: page-specific controls on the left, "+ Nová položka" on the right.
// No page title or tabs: the sidebar already names the page and links the three tracker pages.
function toolbar(canWrite,projects,preset,...left){
 return el('div',{class:'tk-toolbar'},el('div',{class:'tk-toolbar-left'},left),
  canWrite&&projects?el('button',{class:'acc-btn primary small',type:'button',onclick:()=>newTicket(projects,preset)},'+ Nová položka'):null);
}
function projectChips(projects,onPick){
 return el('div',{class:'sys-chips'},[['','Všechny projekty'],...projects.map(p=>[p.id,p.name])].map(([id,name])=>
  el('button',{type:'button',class:`sys-chip${filters.project===id?' on':''}`,'aria-pressed':String(filters.project===id),'aria-label':id?'Projekt '+name:name,onclick:()=>{filters.project=id;filters.release='';onPick();}},name)));
}

// List ------------------------------------------------------------------------------------------
async function listPage(wrap,{canWrite}){
 const board=prefs.view==='board',picked={...filters,...(board?{status:''}:{})},query=new URLSearchParams(Object.entries(picked).filter(([,v])=>v));
 const result=await load(wrap,Promise.all([api('/api/tickets?'+query),api('/api/tickets'+(picked.project?'?project='+encodeURIComponent(picked.project):''))]));if(!result)return;
 const [data,all]=result;
 const redraw=()=>listPage(wrap,{canWrite}).catch(e=>fail(msg,e)),msg=status();
 const count=s=>all.tickets.filter(t=>s.includes(t.status)).length,bugs=all.tickets.filter(t=>t.type==='bug'&&['open','in-progress'].includes(t.status)).length;
 const stat=(k,v,s,tone='')=>el('div',{class:`sec-stat ${tone}`},el('div',{class:'k'},k),el('div',{class:'v'},String(v)),el('div',{class:'s'},s));
 const select=(key,list,empty)=>el('select',{'aria-label':empty,onchange:e=>{filters[key]=e.target.value;redraw();}},options(list,filters[key],empty));
 const releases=[...new Set(data.releases.map(r=>r.version))].map(v=>[v,v]);
 let typing;
 const search=el('input',{type:'search',maxlength:'100',placeholder:'Hledat (id, název, popis, štítek)',value:filters.q,'aria-label':'Hledat',oninput:e=>{filters.q=e.target.value.trim();clearTimeout(typing);typing=setTimeout(()=>{if(search.isConnected)redraw();},300);}});
 const rows=data.tickets.map(t=>el('tr',{class:`tk-row prio-${t.priority}${CLOSED.includes(t.status)?' tk-closed':''}`,onclick:()=>{location.hash='#items/'+t.id;}},
  el('td',{class:'tk-id'},el('a',{href:'#items/'+t.id},t.id)),
  el('td',{},el('div',{class:'tk-name'},glyph(t.type),' ',t.title),t.labels.length?el('div',{class:'tk-labels'},t.labels.map(l=>el('span',{class:'tk-label'},l))):null),
  el('td',{},pill(PRIORITIES,t.priority)),el('td',{},pill(STATUSES,t.status)),
  el('td',{class:'tk-mono'},t.release||'—'),el('td',{class:'tk-mono'},t.assignee||'—'),
  el('td',{class:'tk-mono',title:'Komentáře a přílohy'},[t.comments?`💬 ${t.comments}`:'',t.attachments?`📎 ${t.attachments}`:''].filter(Boolean).join(' ')),el('td',{class:'tk-mono tk-dim',title:when(t.updatedAt)},ago(t.updatedAt)),
  el('td',{class:'tk-actions'},canWrite?quickActions(t,msg,redraw):null)));
 const viewToggle=el('div',{class:'tk-view',role:'group','aria-label':'Zobrazení'},[['table','☰ Tabulka'],['board','▦ Nástěnka']].map(([v,text])=>
  el('button',{type:'button',class:prefs.view===v?'on':'','aria-pressed':String(prefs.view===v),onclick:()=>{if(prefs.view===v)return;prefs.view=v;try{globalThis.localStorage?.setItem('tk-view',v);}catch{}redraw();}},text)));
 const focused=document.activeElement,focusLabel=wrap.contains(focused)?focused.getAttribute('aria-label'):null,caret=focused?.selectionStart;
 show(wrap,toolbar(canWrite,data.projects,null,projectChips(data.projects,redraw)),
  el('div',{class:'sec-stats tk-stats'},stat('Otevřené',count(['open']),'čeká na práci','warn'),stat('Rozpracované',count(['in-progress']),'právě se dělá'),stat('Hotové',count(['done']),'uzavřeno'),stat('Aktivní bugy',bugs,'otevřené + rozpracované',bugs?'crit':''),stat('Releasy',data.releases.filter(r=>r.status==='planned').length,'naplánované')),
  el('div',{class:'tk-filters'},
   board?null:select('status',[['active','Aktivní (otevřené + rozpracované)'],...STATUSES],'Všechny stavy'),select('type',TYPES,'Všechny typy'),
   select('priority',PRIORITIES,'Všechny priority'),select('release',[['none','Bez releasu'],...releases],'Všechny releasy'),search,viewToggle),
  msg,
  board&&all.total?boardView(data.tickets,{canWrite,msg,redraw,projects:data.projects,showProject:!picked.project}):
  data.tickets.length?el('div',{class:'sec-scroll'},el('table',{class:'sec-table tk-table'},
   el('thead',{},el('tr',{},['ID','Název','Priorita','Stav','Release','Řeší','','Změněno',''].map(h=>el('th',{},h)))),el('tbody',{},rows)))
   :el('div',{class:'sec-empty'},el('h2',{},'Žádné položky'),el('p',{class:'sec-dim'},all.total?'Filtrům nic neodpovídá.':canWrite?'Založ první tlačítkem „+ Nová položka“.':'Zatím tu nic není.')));
 if(focusLabel){const control=[...wrap.querySelectorAll('[aria-label]')].find(n=>n.getAttribute('aria-label')===focusLabel);control?.focus();if(control===search)search.setSelectionRange(caret??search.value.length,caret??search.value.length);}
}

// One-click status moves, shared by the table rows and the board cards.
const NEXT={open:[['in-progress','▶','Začít'],['done','✓','Hotovo']],'in-progress':[['done','✓','Hotovo']]};
async function setStatus(t,next,button,msg,redraw){
 button.disabled=true;const epoch=sessionEpoch;
 try{await api('/api/tickets/update',{id:t.id,rev:t.rev,status:next});}catch(e){if(epoch===sessionEpoch){fail(msg,e);button.disabled=false;}return;}
 if(epoch===sessionEpoch)await redraw();
}
function quickActions(t,msg,redraw){
 const stop=fn=>e=>{e.stopPropagation();fn(e);};
 return el('div',{class:'tk-quickrow'},...(NEXT[t.status]||[]).map(([next,icon,text])=>
   el('button',{type:'button',class:`tk-qa${next==='done'?' ok':''}`,title:text,'aria-label':`${text}: ${t.id}`,onclick:stop(e=>setStatus(t,next,e.currentTarget,msg,redraw))},icon)),
  el('button',{type:'button',class:'tk-qa',title:'Komentovat','aria-label':`Komentovat: ${t.id}`,onclick:stop(()=>{prefs.focusComment=true;location.hash='#items/'+t.id;})},'💬'));
}
// Board: open → in progress → done (the latest few), cancelled stays out.
const DONE_SHOWN=8;
function boardView(tickets,ctx){
 const cols=[['open','Otevřené','warn'],['in-progress','Rozpracované','info'],['done','Hotové','ok']];
 return el('div',{class:'tk-board'},cols.map(([s,name,tone])=>{
  const all=tickets.filter(t=>t.status===s);
  const list=s==='done'?[...all].sort((a,b)=>(b.closedAt||b.updatedAt).localeCompare(a.closedAt||a.updatedAt)).slice(0,DONE_SHOWN)
   :[...all].sort((a,b)=>PRIO_ORDER[a.priority]-PRIO_ORDER[b.priority]||b.updatedAt.localeCompare(a.updatedAt));
  return el('section',{class:`tk-col ${tone}`,'aria-label':name},el('h3',{class:'tk-col-head'},el('span',{class:'tk-dot'}),name,el('span',{class:'tk-count'},String(all.length))),
   list.length?list.map(t=>boardCard(t,ctx)):el('p',{class:'tk-col-empty'},s==='in-progress'?'Nikdo na ničem nedělá.':s==='done'?'Zatím nic hotového.':'Nic nečeká. 🎉'),
   all.length>list.length?el('p',{class:'tk-col-more'},`+ ${all.length-list.length} starších`):null);
 }));
}
function boardCard(t,{canWrite,msg,redraw,projects,showProject}){
 const project=showProject?projects.find(p=>p.id===t.project):null;
 return el('article',{class:`tk-card prio-${t.priority}`,onclick:()=>{location.hash='#items/'+t.id;}},
  el('div',{class:'tk-card-top'},glyph(t.type),el('a',{href:'#items/'+t.id,class:'tk-card-id'},t.id),project?el('span',{class:'tk-dim tk-mono'},project.key):null,
   ['urgent','high'].includes(t.priority)?pill(PRIORITIES,t.priority):null,
   t.assignee?el('span',{class:'tk-avatar',title:t.assignee,'aria-label':'Řeší '+t.assignee},initials(t.assignee)):null),
  el('div',{class:'tk-card-title'},t.title),
  el('div',{class:'tk-card-foot'},t.release?el('span',{class:'tk-chip'},t.release):null,t.comments?el('span',{class:'tk-dim tk-mono'},`💬 ${t.comments}`):null,
   el('span',{class:'tk-dim tk-mono',title:when(t.updatedAt)},ago(t.updatedAt)),canWrite&&!CLOSED.includes(t.status)?quickActions(t,msg,redraw):null));
}

// New ticket dialog ------------------------------------------------------------------------------
async function newTicket(projects,preset){
 const epoch=sessionEpoch;
 const releasesData=await api('/api/tickets?limit=1').catch(()=>({releases:[]}));if(epoch!==sessionEpoch)return;
 const msg=status(),field=(text,input)=>el('label',{},text,input);
 const project=el('select',{name:'project'},options(projects.map(p=>[p.id,p.name]),preset||filters.project||projects[0]?.id));
 const release=el('select',{name:'release'});
 const fillReleases=()=>release.replaceChildren(...options(releasesData.releases.filter(r=>r.project===project.value&&r.status==='planned').map(r=>[r.version,r.version]),'','Bez releasu'));
 project.addEventListener('change',fillReleases);fillReleases();
 const form=el('form',{class:'tk-form',onsubmit:async e=>{e.preventDefault();const f=e.currentTarget,b=f.querySelector('button[type=submit]');b.disabled=true;
   try{const t=await api('/api/tickets',{project:f.project.value,title:f.title.value,description:f.description.value,type:f.type.value,priority:f.priority.value,release:f.release.value||null,assignee:f.assignee.value.trim()||null,labels:splitList(f.labels.value)});
    dialog.close();location.hash='#items/'+t.id;}catch(err){fail(msg,err);}finally{b.disabled=false;}}},
  el('div',{class:'tk-grid3'},field('Projekt',project),field('Typ',el('select',{name:'type'},options(TYPES,'feature'))),field('Priorita',el('select',{name:'priority'},options(PRIORITIES,'normal')))),
  field('Název',el('input',{name:'title',required:'',maxlength:'200',autocomplete:'off'})),
  field('Popis',el('textarea',{name:'description',rows:'7',maxlength:'12000',placeholder:'Co a proč. U chyby kroky k reprodukci, u funkce kritéria přijetí.'})),mdHint(),
  el('div',{class:'tk-grid3'},field('Release',release),field('Řeší',el('input',{name:'assignee',maxlength:'60',placeholder:'např. alice, claude'})),field('Štítky',el('input',{name:'labels',placeholder:'ui, api, mcp'}))),
  msg,el('div',{class:'acc-actions'},el('button',{type:'button',class:'acc-btn',onclick:()=>dialog.close()},'Zrušit'),el('button',{type:'submit',class:'acc-btn primary'},'Založit položku')));
 const dialog=el('dialog',{class:'acc-dialog wide','aria-label':'Nová položka'},el('h3',{},'Nová položka'),form);
 showDialog(dialog);form.title.focus();
}
const mdHint=()=>el('span',{class:'tk-md-hint'},'Formátování: **tučně**, `kód`, - seznam, 1. kroky, HH-12 = odkaz');
const splitList=v=>v.split(/[,\n]/).map(s=>s.trim()).filter(Boolean);

// Detail ----------------------------------------------------------------------------------------
// Where the user came to a ticket from (a project page, a review set, releases, the open-items list), so the path
// back leads there instead of always to the list. Going from one ticket to another keeps the first origin.
// Kept per tab in sessionStorage, so a reload keeps it too; a link opened in a new tab falls back to the list.
export const ORIGIN_KEY='tk-origin';
export function ticketOrigin(from,to,current){
 const ticket=h=>/^#items\/[^/]+$/.test(h||'');
 if(!ticket(to))return current;
 return ticket(from)?current:/^#(projects|review|releases|items)(\/[^/]*)?$/.test(from||'')?from:'';
}
let originHash='';
try{originHash=globalThis.sessionStorage?.getItem(ORIGIN_KEY)||'';}catch{}
if(typeof addEventListener==='function')addEventListener('hashchange',e=>{
 let from='',to='';try{from=new URL(e.oldURL).hash;to=new URL(e.newURL).hash;}catch{return;}
 const next=ticketOrigin(from,to,originHash);if(next===originHash)return;originHash=next;try{globalThis.sessionStorage?.setItem(ORIGIN_KEY,next);}catch{}
});
// The path back from a ticket: Projekty / <project> / <id> when it was opened from the project, else one link back.
// The project in the path is the one the user came from: after HH-2 → DUNE-7 it still leads back to Home Hub.
export function backPath(t,projects,origin=originHash){
 const sep=()=>el('span',{class:'tk-dim'},'/');
 if(/^#projects(\/|$)/.test(origin)){
  const id=/^#projects\/([^/]+)$/.exec(origin)?.[1]||t.project,p=projects.find(x=>x.id===id);
  return el('nav',{class:'tk-crumbs','aria-label':'Drobečková navigace'},
   el('a',{href:'#projects'},'Projekty'),sep(),el('a',{href:'#projects/'+encodeURIComponent(id)},p?.name||id),sep(),el('b',{},t.id));
 }
 const review=/^#review\/(R-[1-9][0-9]{0,5})$/.exec(origin);
 if(review)return el('a',{href:origin,class:'tk-back'},'← Review '+review[1]);
 if(/^#review(\/|$)/.test(origin))return el('a',{href:origin,class:'tk-back'},'← Review');
 if(/^#releases$/.test(origin))return el('a',{href:'#releases',class:'tk-back'},'← Releasy');
 return el('a',{href:'#items',class:'tk-back'},'← Otevřené položky');
}
async function ticketPage(wrap,{canWrite,id}){
 const result=await load(wrap,Promise.all([api('/api/tickets/'+encodeURIComponent(id)),api('/api/tickets?limit=1')]));if(!result)return;
 const [t,meta]=result;renderTicket(wrap,{canWrite,meta},t,{fields:{},comment:''});
}
// Unsaved input on a ticket page: the comment box and every edit-form field that differs from what was rendered.
// A write re-renders from the ticket the server returned (no second request that could fail), carrying these over.
const pages=new WeakMap(),pastes=new WeakMap();
function drafts(wrap){
 const page=pages.get(wrap);if(!page)return {fields:{},comment:''};
 return {comment:page.comment?.value||'',fields:Object.fromEntries(Object.entries(page.inputs).filter(([k,input])=>input.value!==page.initial[k]).map(([k,input])=>[k,input.value]))};
}
function renderTicket(wrap,ctx,t,keep){
 const {canWrite,meta}=ctx,project=meta.projects.find(p=>p.id===t.project),msg=status(),keys=meta.projects.map(p=>p.key);
 if(keep.notice)msg.textContent=keep.notice;
 // Runs a write; on success re-renders with the returned ticket, dropping the drafts the write just saved.
 const write=async(button,request,saved)=>{
  if(button)button.disabled=true;const epoch=sessionEpoch;let updated;
  try{updated=await request();}catch(e){if(wrap.isConnected){fail(msg,e);if(button)button.disabled=false;}return;}
  if(epoch!==sessionEpoch||!wrap.isConnected)return;
  // Another write may have re-rendered meanwhile: still drop what this one saved, but never show an older ticket.
  const shown=pages.get(wrap)?.ticket||t,next=drafts(wrap);saved(next);next.notice='Uloženo.';
  renderTicket(wrap,ctx,updated.updatedAt>=shown.updatedAt?updated:shown,next);
 };
 const save=(change,button,fromEdit=false)=>write(button,()=>api('/api/tickets/update',{id:t.id,rev:t.rev,...change}),next=>{if(fromEdit)next.fields={};else for(const k of Object.keys(change))delete next.fields[k];});
 const quick=[];
 if(canWrite){
  const b=(text,next,cls='')=>el('button',{type:'button',class:`acc-btn small ${cls}`,onclick:e=>save({status:next},e.currentTarget)},text);
  if(t.status==='open')quick.push(b('▶ Začít','in-progress'));
  if(['open','in-progress'].includes(t.status))quick.push(b('✓ Hotovo','done','primary'),b('Zrušit','cancelled'));
  if(['done','cancelled'].includes(t.status))quick.push(b('↺ Znovu otevřít','open'));
 }
 const fact=(k,v)=>[el('dt',{},k),el('dd',{},v)];
 const commentBox=canWrite?el('textarea',{name:'text',rows:'3',required:'',maxlength:'8000',placeholder:'Komentář, postup, commit…','aria-label':'Nový komentář'}):null;
 if(commentBox)commentBox.value=keep.comment||'';
 const edit=canWrite?editForm(t,meta,save):null;
 if(edit)for(const [k,v] of Object.entries(keep.fields||{}))if(edit.inputs[k])edit.inputs[k].value=v;
 pages.set(wrap,{ticket:t,comment:commentBox,inputs:edit?.inputs||{},initial:edit?.initial||{}});
 const comments=el('section',{class:'acc-card'},el('h3',{},`Komentáře (${t.comments.length})`),
  t.comments.length?el('ol',{class:'tk-comments'},t.comments.map(c=>el('li',{class:'tk-comment'},
   el('div',{class:'tk-comment-head'},el('span',{class:'tk-avatar','aria-hidden':'true'},initials(c.by)||'?'),el('b',{},c.by),el('span',{class:'tk-dim',title:when(c.at)},ago(c.at))),
   markdown(c.text,{keys})))):el('p',{class:'acc-dim'},'Zatím bez komentářů.'),
  canWrite?el('form',{class:'tk-form',onsubmit:e=>{e.preventDefault();const f=e.currentTarget,text=f.text.value;
    return write(f.querySelector('button'),()=>api('/api/tickets/comment',{id:t.id,text}),next=>{if(next.comment===text)next.comment='';});}},
   commentBox,el('div',{class:'acc-actions tk-comment-actions'},mdHint(),el('button',{type:'submit',class:'acc-btn'},'Přidat komentář'))):null);
 // Attachments: upload with the button, by dropping files on the section or pasting (Cmd+V) anywhere on the page.
 const files=t.attachments||[],fileUrl=a=>`/api/tickets/${encodeURIComponent(t.id)}/attachments/${a.id}`;
 const upload=async list=>{
  for(const file of list){
   if(file.size>20*1024*1024){fail(msg,new Error(`${file.name}: soubor je větší než 20 MB.`));continue;}
   msg.classList.remove('error');msg.textContent=`Nahrávám ${file.name||'soubor'}…`;
   const name=file.name&&file.name!=='image.png'?file.name:`vlozeno-${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}.${(file.type.split('/')[1]||'bin').replace('jpeg','jpg')}`;
   await write(null,async()=>{const lost=authGuard(),r=await fetch(`/api/tickets/${encodeURIComponent(t.id)}/attachments?name=${encodeURIComponent(name)}`,{method:'PUT',headers:{'Content-Type':'application/octet-stream'},body:file});lost(r);
    const data=await r.json().catch(()=>({}));if(!r.ok)throw new Error(data.error?.message||'Nahrání se nepovedlo.');return data;},()=>{});
  }
 };
 const picker=canWrite?el('input',{type:'file',multiple:'',hidden:'',onchange:e=>{const list=[...e.target.files];e.target.value='';upload(list);}}):null;
 const size=n=>n<1024?`${n} B`:n<1048576?`${Math.round(n/1024)} kB`:`${(n/1048576).toFixed(1)} MB`;
 const attachments=el('section',{class:'acc-card tk-files-card',
   ondragover:e=>{if(!canWrite)return;e.preventDefault();e.currentTarget.classList.add('tk-drop');},ondragleave:e=>e.currentTarget.classList.remove('tk-drop'),
   ondrop:e=>{if(!canWrite)return;e.preventDefault();e.currentTarget.classList.remove('tk-drop');upload([...e.dataTransfer.files]);}},
  el('div',{class:'tk-files-head'},el('h3',{},`Přílohy (${files.length})`),canWrite?el('button',{type:'button',class:'acc-btn small',onclick:()=>picker.click()},'+ Přidat soubor'):null,picker),
  files.length?el('ul',{class:'tk-files'},files.map(a=>el('li',{class:'tk-file'},
   a.type.startsWith('image/')?el('a',{href:fileUrl(a),target:'_blank',rel:'noopener',class:'tk-file-thumb'},el('img',{src:fileUrl(a),alt:a.name,loading:'lazy'})):el('a',{href:fileUrl(a)+(a.type==='text/plain'?'':'?download=1'),target:'_blank',rel:'noopener',class:'tk-file-thumb tk-file-icon','aria-hidden':'true'},a.type==='application/pdf'?'PDF':a.type==='text/plain'?'TXT':'⬇'),
   el('div',{class:'tk-file-meta'},el('a',{href:fileUrl(a)+(a.type.startsWith('image/')||a.type==='text/plain'?'':'?download=1'),target:'_blank',rel:'noopener',class:'tk-file-name',title:a.name},a.name),el('span',{class:'tk-dim'},`${size(a.size)} · ${a.by} · ${ago(a.at)}`)),
   canWrite?el('button',{type:'button',class:'acc-btn small tk-file-del','aria-label':`Odebrat ${a.name}`,title:'Odebrat přílohu',onclick:e=>{if(!confirm(`Odebrat přílohu ${a.name}?`))return;write(e.currentTarget,()=>api('/api/tickets/attachments/delete',{id:t.id,attachment:a.id}),()=>{});}},'×'):null)))
   :el('p',{class:'acc-dim'},canWrite?'Přetáhni sem soubor, vlož obrázek (Cmd+V) nebo použij tlačítko. Nejvýš 20 MB.':'Bez příloh.'));
 if(canWrite&&typeof addEventListener==='function'){const old=pastes.get(wrap);if(old)removeEventListener('paste',old);
  const onPaste=e=>{if(!wrap.isConnected){removeEventListener('paste',onPaste);return;}const list=[...(e.clipboardData?.files||[])];if(!list.length)return;e.preventDefault();upload(list);};
  pastes.set(wrap,onPaste);addEventListener('paste',onPaste);onLeave(()=>removeEventListener('paste',onPaste));}
 const history=el('details',{class:'sec-findings'},el('summary',{},`Historie změn (${t.history.length})`),
  el('ul',{},[...t.history].reverse().map(h=>el('li',{},el('span',{class:'dot'}),el('div',{},el('b',{},historyText(h)),el('div',{class:'sec-dim'},`${h.by} · ${when(h.at)}`))))));
 show(wrap,
  backPath(t,meta.projects),
  el('div',{class:'tk-head'},el('div',{},el('div',{class:'tk-mono tk-dim'},`${t.id} · ${project?.name||t.project}`),el('h1',{class:'tk-title'},t.title),
    el('div',{class:'tk-pills'},pill(TYPES,t.type),pill(PRIORITIES,t.priority),pill(STATUSES,t.status),t.release?el('a',{class:'sec-pill tk-pill',href:'#releases',onclick:()=>{filters.project=t.project;}},'release '+t.release):null)),
   el('div',{class:'tk-quick'},quick)),
  msg,
  el('div',{class:'tk-detail'},
   el('div',{class:'acc-stack'},el('section',{class:'acc-card'},el('h3',{},'Popis'),t.description?markdown(t.description,{keys}):el('p',{class:'acc-dim'},'Bez popisu.')),attachments,comments,history),
   el('div',{class:'acc-stack'},
    el('section',{class:'acc-card'},el('h3',{},'Údaje'),el('dl',{class:'acc-dl'},
     fact('Release',t.release||'—'),fact('Řeší',t.assignee||'—'),fact('Nahlásil',t.reporter||'—'),fact('Štítky',t.labels.join(', ')||'—'),
     fact('Odkazy',t.refs.length?el('div',{class:'tk-refs'},t.refs.map(r=>/^https?:\/\//.test(r)?el('a',{href:r,target:'_blank',rel:'noopener noreferrer',class:'sys-link'},r):TICKETISH.test(r)?el('a',{href:'#items/'+r,class:'sys-link'},r):el('code',{},r))):'—'),
     fact('Založeno',when(t.createdAt)),fact('Změněno',when(t.updatedAt)),...(t.closedAt?fact('Uzavřeno',when(t.closedAt)):[]),fact('Revize',String(t.rev)))),
    edit?.form||null)));
 if(prefs.focusComment){prefs.focusComment=false;commentBox?.focus();}
}
const TICKETISH=/^[A-Z][A-Z0-9]{1,9}-[1-9][0-9]{0,5}$/;
const FIELD_NAMES={attachment:'Příloha',created:'Založeno',title:'Název',description:'Popis',type:'Typ',status:'Stav',priority:'Priorita',release:'Release',assignee:'Řeší',labels:'Štítky',refs:'Odkazy'};
function historyText(h){
 if(h.field==='created')return 'Ticket založen';
 if(h.field==='attachment')return h.to?`Příloha přidána: ${h.to}`:`Příloha odebrána: ${h.from}`;
 if(h.from===null&&h.to===null)return `${FIELD_NAMES[h.field]||h.field}: upraveno`;
 const v=x=>x===null||x===undefined||(Array.isArray(x)&&!x.length)?'—':Array.isArray(x)?x.join(', '):h.field==='status'?label(STATUSES,x):h.field==='type'?label(TYPES,x):h.field==='priority'?label(PRIORITIES,x):String(x);
 return `${FIELD_NAMES[h.field]||h.field}: ${v(h.from)} → ${v(h.to)}`;
}
function editForm(t,meta,save){
 const inputs={},field=(text,input)=>{if(input.getAttribute('name'))inputs[input.getAttribute('name')]=input;return el('label',{},text,input);};
 const releases=meta.releases.filter(r=>r.project===t.project&&(r.status==='planned'||r.version===t.release)).map(r=>[r.version,r.status==='released'?`${r.version} (vydáno)`:r.version]);
 const form=el('form',{class:'acc-card tk-form',onsubmit:e=>{e.preventDefault();const f=e.currentTarget;
   const values={title:f.title.value.trim(),description:f.description.value.trim(),type:f.type.value,status:f.status.value,priority:f.priority.value,release:f.release.value||null,assignee:f.assignee.value.trim()||null,labels:[...new Set(splitList(f.labels.value).map(v=>v.toLowerCase()))],refs:[...new Set(f.refs.value.split(/\r?\n/).map(v=>v.trim()).filter(Boolean))]};
   const changed=Object.fromEntries(Object.entries(values).filter(([k,v])=>JSON.stringify(v)!==JSON.stringify(t[k])));
   if(Object.keys(changed).length)return save(changed,f.querySelector('button[type=submit]'),true);}},
  el('h3',{},'Upravit'),
  field('Název',el('input',{name:'title',required:'',maxlength:'200',value:t.title})),
  el('div',{class:'tk-grid2'},field('Stav',el('select',{name:'status'},options(STATUSES,t.status))),field('Typ',el('select',{name:'type'},options(TYPES,t.type))),
   field('Priorita',el('select',{name:'priority'},options(PRIORITIES,t.priority))),field('Release',el('select',{name:'release'},options(releases,t.release||'','Bez releasu')))),
  field('Řeší',el('input',{name:'assignee',maxlength:'60',value:t.assignee||''})),
  field('Štítky (čárkou)',el('input',{name:'labels',value:t.labels.join(', ')})),
  field('Odkazy (commit, PR, ticket; každý na vlastní řádek)',(()=>{const a=el('textarea',{name:'refs',rows:'2'});a.value=t.refs.join('\n');return a;})()),
  field('Popis',(()=>{const a=el('textarea',{name:'description',rows:'8',maxlength:'12000'});a.value=t.description;return a;})()),mdHint(),
  el('div',{class:'acc-actions'},el('button',{type:'submit',class:'acc-btn primary'},'Uložit změny')));
 return {form,inputs,initial:Object.fromEntries(Object.entries(inputs).map(([k,input])=>[k,input.value]))};
}

// Releases --------------------------------------------------------------------------------------
async function releasesPage(wrap,opts){
 const data=await load(wrap,api('/api/tickets'+(filters.project?'?project='+encodeURIComponent(filters.project):'')));if(!data)return;
 renderReleases(wrap,opts,data);
}
const NO_COUNTS=Object.freeze({open:0,'in-progress':0,done:0,cancelled:0});
function renderReleases(wrap,{canWrite},data,notice=''){
 const msg=status(),redraw=()=>releasesPage(wrap,{canWrite}).catch(e=>fail(msg,e));if(notice)msg.textContent=notice;
 // The saved release is shown at once from the POST reply; the follow-up refresh (new counts) may fail on its own.
 const saveRelease=async(body,button)=>{
  if(button)button.disabled=true;const epoch=sessionEpoch;let saved;
  try{saved=await api('/api/tickets/releases',body);}catch(e){if(wrap.isConnected){fail(msg,e);if(button)button.disabled=false;}return;}
  if(epoch!==sessionEpoch||!wrap.isConnected)return;
  const same=r=>r.project===saved.project&&r.version===saved.version,old=data.releases.find(same);
  const releases=[...data.releases.filter(r=>!same(r)),{counts:{...NO_COUNTS},total:0,...old,...saved}].sort((a,b)=>a.project.localeCompare(b.project)||a.version.localeCompare(b.version,'en',{numeric:true,sensitivity:'base'}));
  renderReleases(wrap,{canWrite},{...data,releases},'Uloženo.');
  try{const fresh=await load(wrap,api('/api/tickets'+(filters.project?'?project='+encodeURIComponent(filters.project):'')));if(fresh)renderReleases(wrap,{canWrite},fresh,'Uloženo.');}
  catch(e){const m=wrap.querySelector('p[role=status]');if(m)fail(m,new Error('Uloženo, ale přehled se nepodařilo obnovit: '+e.message));}
 };
 const projects=data.projects.filter(p=>!filters.project||p.id===filters.project);
 const item=t=>el('li',{class:CLOSED.includes(t.status)?'tk-closed':''},glyph(t.type),el('a',{href:'#items/'+t.id},t.id),el('span',{class:'tk-mini-title'},t.title),pill(STATUSES,t.status));
 const card=(r,hero)=>{
  const mine=data.tickets.filter(t=>t.project===r.project&&t.release===r.version),scope=r.total-r.counts.cancelled,d=due(r);
  const left=mine.filter(t=>ACTIVE.includes(t.status)),done=mine.filter(t=>!ACTIVE.includes(t.status));
  return el('section',{class:`acc-card tk-release${r.status==='released'?' tk-released':''}${hero?' tk-hero':''}${d?.tone?' tk-due-'+d.tone:''}`},
   el('div',{class:'tk-release-head'},el('div',{},hero?el('div',{class:'tk-eyebrow'},'Další release'):null,el('b',{class:'tk-version'},r.version),' ',el('span',{class:`sec-pill ${r.status==='released'?'ok':'warn'}`},r.status==='released'?'vydáno':'plánováno'),
     d?el('span',{class:`sec-pill tk-countdown ${d.tone}`,title:'cíl '+dayText(r.targetDate)},d.text):null,
     el('div',{class:'sec-dim'},r.status==='released'?`vydáno ${dayText(r.releasedAt)}`:`cíl ${dayText(r.targetDate)}`,` · ${r.counts.done}/${scope} hotovo · ${r.counts.open} otevřených · ${r.counts['in-progress']} rozpracovaných`)),
    canWrite?el('div',{},r.status==='planned'?el('button',{type:'button',class:'acc-btn small primary',title:r.counts.open+r.counts['in-progress']?'Release má ještě nedokončené tickety.':'',onclick:e=>saveRelease({project:r.project,version:r.version,rev:r.rev,status:'released'},e.currentTarget)},'Označit jako vydané')
     :el('button',{type:'button',class:'acc-btn small',onclick:e=>saveRelease({project:r.project,version:r.version,rev:r.rev,status:'planned'},e.currentTarget)},'Vrátit do plánu')):null),
   progressBar(r.counts.done,scope),r.notes?markdown(r.notes,{keys:data.projects.map(p=>p.key),cls:'tk-md tk-md-dim'}):null,
   !mine.length?el('p',{class:'acc-dim'},'Zatím bez ticketů.')
   :hero?el('div',{class:'tk-split'},
     el('div',{},el('h4',{class:'tk-eyebrow'},`Zbývá (${left.length})`),left.length?el('ul',{class:'tk-mini'},left.map(item)):el('p',{class:'acc-dim'},'Vše hotovo — můžeš vydat. 🚀')),
     el('div',{},el('h4',{class:'tk-eyebrow'},`Hotovo (${done.length})`),done.length?el('ul',{class:'tk-mini'},done.map(item)):el('p',{class:'acc-dim'},'Zatím nic.')))
   :el('ul',{class:'tk-mini'},mine.map(item)));
 };
 const node=(r,hero)=>el('li',{class:`tk-tl ${r.status}${hero?' next':''}`},el('span',{class:'tk-tl-dot','aria-hidden':'true'}),card(r,hero));
 const addForm=p=>el('form',{class:'acc-form tk-release-form',onsubmit:e=>{e.preventDefault();const f=e.currentTarget;saveRelease({project:p.id,version:f.version.value.trim(),targetDate:f.targetDate.value||null,notes:f.notes.value},f.querySelector('button'));}},
  el('label',{},'Verze',el('input',{name:'version',required:'',maxlength:'40',pattern:'(?!none$)[A-Za-z0-9][A-Za-z0-9._+\\-]{0,39}',placeholder:'např. 2.4 nebo v0.5.0'})),
  el('label',{},'Cílové datum',el('input',{name:'targetDate',type:'date'})),el('label',{},'Poznámka',el('input',{name:'notes',maxlength:'2000',placeholder:'Co release přináší'})),
  el('button',{type:'submit',class:'acc-btn primary'},'Přidat release'));
 show(wrap,toolbar(canWrite,data.projects,null,projectChips(data.projects,redraw)),msg,
  ...projects.map(p=>{
   const releases=data.releases.filter(r=>r.project===p.id),planned=releases.filter(r=>r.status==='planned').sort(plannedOrder),released=releases.filter(r=>r.status==='released').reverse();
   const unplanned=data.tickets.filter(t=>t.project===p.id&&!t.release&&ACTIVE.includes(t.status)).length,recent=released.slice(0,3),older=released.slice(3);
   return el('div',{class:'acc-stack tk-project'},el('h2',{class:'tk-project-name'},el('a',{href:'#projects/'+p.id},p.name),' ',el('span',{class:'sec-dim'},`${p.key} · ${unplanned} aktivních ticketů bez releasu`)),
    canWrite?addForm(p):null,
    planned.length||released.length?el('ol',{class:'tk-timeline'},...planned.map((r,i)=>node(r,i===0)),...recent.map(r=>node(r,false))):el('p',{class:'acc-dim'},'Zatím žádný release.'),
    older.length?el('details',{class:'sec-findings'},el('summary',{},`Starší vydané (${older.length})`),el('ol',{class:'tk-timeline'},older.map(r=>node(r,false)))):null);
  }));
}

// Projects --------------------------------------------------------------------------------------
// Health ring: share of open / in progress / done (cancelled left out), done % in the middle.
function healthRing(c){
 const total=c.open+c['in-progress']+c.done,pct=total?Math.round(c.done/total*100):0,a=total?c.open/total*100:0,b=total?(c.open+c['in-progress'])/total*100:0;
 const ring=el('div',{class:'tk-ring',role:'img','aria-label':`Hotovo ${pct} % (${c.done} z ${total})`},el('div',{class:'tk-ring-hole'},el('b',{},pct+'%'),el('span',{},`${c.done}/${total}`)));
 if(total)ring.style.background=`conic-gradient(var(--warn) 0 ${a}%, var(--accent2) ${a}% ${b}%, var(--ok) ${b}% 100%)`;
 return ring;
}
function health(tickets){
 const c=statusCounts(tickets),bugs=activeBugs(tickets);
 const row=(tone,k,v)=>el('li',{class:tone},el('span',{class:'tk-dot'}),el('span',{},k),el('b',{},String(v)));
 return el('div',{class:'tk-health'},healthRing(c),el('div',{class:'tk-legend-wrap'},
  el('ul',{class:'tk-legend'},row('warn','Otevřené',c.open),row('info','Rozpracované',c['in-progress']),row('ok','Hotové',c.done)),
  bugs?el('span',{class:'sec-pill crit tk-bugs'},`🐞 ${bugs} ${plural(bugs,'aktivní bug','aktivní bugy','aktivních bugů')}`):null));
}
// Closed items per day over the last 14 days, plus the latest changes.
const DAYS=14;
function activity(tickets,recent=3){
 const days=[...Array(DAYS)].map((_,i)=>dayKey(new Date(Date.now()-(DAYS-1-i)*864e5))),hits=Object.fromEntries(days.map(d=>[d,0]));
 for(const t of tickets)if(t.status==='done'&&t.closedAt){const k=dayKey(new Date(t.closedAt));if(k in hits)hits[k]++;}
 const max=Math.max(1,...Object.values(hits)),sum=Object.values(hits).reduce((x,y)=>x+y,0);
 const spark=el('div',{class:'tk-spark',role:'img','aria-label':`Uzavřeno za ${DAYS} dní: ${sum}`},days.map(d=>{const bar=el('span',{title:`${dayText(d)}: ${hits[d]}`,class:hits[d]?'hit':''});bar.style.height=Math.max(8,hits[d]/max*100)+'%';return bar;}));
 const latest=[...tickets].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).slice(0,recent);
 return el('div',{class:'tk-activity'},el('div',{class:'tk-eyebrow'},`Uzavřeno za ${DAYS} dní · ${sum}`),spark,
  latest.length?el('ul',{class:'tk-feed'},latest.map(t=>el('li',{},el('a',{href:'#items/'+t.id},t.id),' → ',el('span',{class:`tk-feed-st ${STATUSES.find(x=>x[0]===t.status)?.[2]||''}`},label(STATUSES,t.status).toLowerCase()),el('span',{class:'tk-dim'},' · '+ago(t.updatedAt))))):null);
}
function nextBlock(releases,project){
 const next=nextRelease(releases,project);
 if(!next)return el('p',{class:'sec-dim tk-next'},'Žádný naplánovaný release.');
 const scope=next.total-next.counts.cancelled,d=due(next);
 return el('div',{class:`tk-next${d?.tone?' tk-due-'+d.tone:''}`},el('div',{class:'tk-next-head'},el('span',{class:'tk-eyebrow'},'Další release'),el('a',{href:'#releases',class:'tk-version',onclick:()=>{filters.project=project;}},next.version),
   d?el('span',{class:`sec-pill tk-countdown ${d.tone}`,title:'cíl '+dayText(next.targetDate)},d.text):null,el('span',{class:'sec-dim'},`${next.counts.done}/${scope} hotovo`)),progressBar(next.counts.done,scope));
}
async function projectsPage(wrap,{canWrite}){
 const data=await load(wrap,api('/api/tickets'));if(!data)return;
 const msg=status(),redraw=()=>projectsPage(wrap,{canWrite}).catch(e=>fail(msg,e));
 const open=(project,hash)=>e=>{e.stopPropagation();filters.project=project;filters.release='';filters.status='active';location.hash=hash;};
 const card=p=>{
  const mine=data.tickets.filter(t=>t.project===p.id);
  return el('section',{class:'acc-card tk-project-card',onclick:e=>{if(!e.target?.closest?.('a,button'))location.hash='#projects/'+p.id;}},
   el('div',{class:'tk-release-head'},el('div',{},el('h2',{class:'tk-project-name'},el('a',{href:'#projects/'+p.id},p.name)),el('span',{class:'sec-pill'},p.key),p.type?el('span',{class:'sec-pill'},label(PROJECT_TYPES,p.type)):null),
    canWrite?el('button',{type:'button',class:'acc-btn small',onclick:e=>{e.stopPropagation();editProject(p,redraw);}},'Upravit'):null),
   p.description?el('p',{class:'tk-text acc-dim'},p.description):null,
   mine.length?[health(mine),activity(mine,2),nextBlock(data.releases,p.id)]
    :el('div',{class:'tk-fresh'},el('div',{class:'tk-fresh-icon','aria-hidden':'true'},'✨'),el('p',{},'Čistý štít — zatím tu nic není.'),
      canWrite?el('button',{type:'button',class:'acc-btn small primary',onclick:e=>{e.stopPropagation();newTicket(data.projects,p.id);}},'+ První položka'):null),
   el('div',{class:'tk-links'},el('a',{href:'#projects/'+p.id,class:'acc-btn small'},'Detail projektu →'),el('button',{type:'button',class:'acc-btn small',onclick:open(p.id,'#items')},'Položky →'),el('button',{type:'button',class:'acc-btn small',onclick:open(p.id,'#releases')},'Releasy →'),el('a',{class:'acc-btn small',href:'#review/'+p.id},'Review →')));
 };
 const form=canWrite?el('form',{class:'acc-card tk-form',onsubmit:async e=>{e.preventDefault();const f=e.currentTarget,b=f.querySelector('button');b.disabled=true;
   try{await api('/api/tickets/projects',{id:f.id.value.trim(),key:f.key.value.trim().toUpperCase(),name:f.name.value,description:f.description.value,type:f.type.value||null});}catch(err){fail(msg,err);b.disabled=false;return;}
   f.reset();b.disabled=false;msg.textContent='Projekt založen.';await redraw();}},
  el('h3',{},'Nový projekt'),
  el('div',{class:'tk-grid3'},el('label',{},'Id',el('input',{name:'id',required:'',pattern:'[a-z][a-z0-9\\-]{1,39}',placeholder:'např. ob1'})),
   el('label',{},'Zkratka (prefix položek)',el('input',{name:'key',required:'',pattern:'[A-Za-z][A-Za-z0-9]{1,9}',placeholder:'např. OB'})),el('label',{},'Název',el('input',{name:'name',required:'',maxlength:'80'}))),
  el('div',{class:'tk-grid2'},el('label',{},'Popis',el('input',{name:'description',maxlength:'500'})),el('label',{},'Typ',el('select',{name:'type'},options(PROJECT_TYPES,'app','Bez typu')))),
  el('p',{class:'acc-dim'},'Id a zkratka se později nedají změnit; položky budou mít čísla jako OB-1.'),
  el('div',{class:'acc-actions'},el('button',{type:'submit',class:'acc-btn primary'},'Založit projekt'))):null;
 show(wrap,toolbar(canWrite,data.projects,null),msg,
  el('div',{class:'tk-projects'},data.projects.map(card)),form);
}
// One project: health, activity and next release on top, then a board of its items.
async function projectPage(wrap,{canWrite,id}){
 const data=await load(wrap,api('/api/tickets?project='+encodeURIComponent(id)).catch(e=>{if(e.status===400)e.status=404;throw e;}));if(!data)return;
 const p=data.projects.find(x=>x.id===id);
 if(!p){const e=new Error(`Projekt „${id}“ v trackeru není.`);e.status=404;throw e;}
 const msg=status(),redraw=()=>projectPage(wrap,{canWrite,id}).catch(e=>fail(msg,e));
 const mine=data.tickets.filter(t=>t.project===id);
 const to=hash=>()=>{filters.project=id;filters.release='';filters.status='active';location.hash=hash;};
 show(wrap,
  toolbar(canWrite,data.projects,id,
   el('nav',{class:'tk-crumbs','aria-label':'Drobečková navigace'},el('a',{href:'#projects'},'Projekty'),el('span',{class:'tk-dim'},'/'),el('b',{},p.name),el('span',{class:'sec-pill'},p.key)),
   canWrite?el('button',{type:'button',class:'acc-btn small',onclick:()=>editProject(p,redraw)},'Upravit'):null,
   el('button',{type:'button',class:'acc-btn small',onclick:to('#items')},'Tabulka →'),el('button',{type:'button',class:'acc-btn small',onclick:to('#releases')},'Releasy →'),el('a',{class:'acc-btn small',href:'#review/'+id},'Review →')),
  p.description?el('p',{class:'sec-dim tk-proj-desc'},p.description):null,
  msg,
  mine.length?el('div',{class:'acc-card tk-hero-row'},health(mine),activity(mine,4),nextBlock(data.releases,id)):null,
  mine.length?boardView(mine,{canWrite,msg,redraw,projects:data.projects,showProject:false})
   :el('div',{class:'sec-empty tk-fresh'},el('div',{class:'tk-fresh-icon','aria-hidden':'true'},'✨'),el('h2',{},'Čistý štít'),el('p',{class:'sec-dim'},'V projektu zatím nejsou žádné položky.'),
     canWrite?el('button',{type:'button',class:'acc-btn primary',onclick:()=>newTicket(data.projects,id)},'+ První položka'):null));
}
function editProject(p,done){
 const msg=status();
 const form=el('form',{class:'tk-form',onsubmit:async e=>{e.preventDefault();const f=e.currentTarget,b=f.querySelector('button[type=submit]');b.disabled=true;
   try{await api('/api/tickets/projects',{id:p.id,rev:p.rev,name:f.name.value,description:f.description.value,type:f.type.value||null});dialog.close();await done();}catch(err){fail(msg,err);b.disabled=false;}}},
  el('label',{},'Název',el('input',{name:'name',required:'',maxlength:'80',value:p.name})),
  el('label',{},'Popis',(()=>{const a=el('textarea',{name:'description',rows:'3',maxlength:'500'});a.value=p.description||'';return a;})()),
  el('label',{},'Typ',el('select',{name:'type'},options(PROJECT_TYPES,p.type||'','Bez typu'))),
  msg,el('div',{class:'acc-actions'},el('button',{type:'button',class:'acc-btn',onclick:()=>dialog.close()},'Zrušit'),el('button',{type:'submit',class:'acc-btn primary'},'Uložit')));
 const dialog=el('dialog',{class:'acc-dialog','aria-label':'Upravit projekt'},el('h3',{},`${p.name} (${p.key})`),form);
 showDialog(dialog);
}
// Page entry for the shell (app.js): every page module exports (context) => Node, and the server's UI
// manifest names it. context = {me, page, sub, machine, site}.
export const trackerPage=({me,page,sub})=>trackerView(me,page,sub);
