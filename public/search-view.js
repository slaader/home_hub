// Search: one box in the top bar, full-text over tickets and review sets (GET /api/search, SQLite FTS5 on the
// server). #search/<words> shows the results grouped by kind; diacritics and case are ignored, every word is a
// prefix match. Matches come back wrapped in \u0001…\u0002 and are drawn as <mark> through text nodes, never as HTML.
// Keys: "/" anywhere focuses the search box (or the filter a page marks with data-slash); on the results page
// j / k or the arrow keys walk the hits and Enter opens the focused one.
import {el,onLeave} from './views.js';
import {t,tp,locale} from './i18n.js';
import {timeZone} from './site.js';
import {authGuard,sessionTicket} from './session-cache.js';
import {pageHeader,emptyState} from './ui.js';

const KINDS=()=>[['ticket',t('Položky')],['review','Review']];
const TICKET_STATUS=()=>({open:[t('Otevřený'),'warn'],'in-progress':[t('Rozpracovaný'),'info'],done:[t('Hotovo'),'ok'],cancelled:[t('Zrušený'),'dim']});
export const searchHash=q=>'#search/'+encodeURIComponent(q.trim());
export const queryOf=sub=>{try{return decodeURIComponent(sub||'');}catch{return '';}};
export const resultHref=r=>r.kind==='review'?`#review/${r.id}`:`#items/${r.id}`;
// "a\u0001b\u0002c" → ['a', <mark>b</mark>, 'c'] (text only).
export function marked(s){
 const out=[];let rest=String(s||'');
 for(let m;(m=/\u0001([^\u0002]*)\u0002/.exec(rest));){if(m.index)out.push(rest.slice(0,m.index));out.push(el('mark',{},m[1]));rest=rest.slice(m.index+m[0].length);}
 if(rest)out.push(rest.replace(/[\u0001\u0002]/g,''));return out;
}
// Results by kind, in a fixed order (tickets, then review sets), each group keeping the server's ranking.
export function groupResults(results){
 const known=['ticket','review'],kinds=[...known,...new Set((results||[]).map(r=>r.kind).filter(k=>!known.includes(k)))];
 return kinds.map(kind=>({kind,results:(results||[]).filter(r=>r.kind===kind)})).filter(g=>g.results.length);
}
const typing=node=>Boolean(node)&&(['INPUT','TEXTAREA','SELECT'].includes(node.tagName)||node.isContentEditable===true);
// "/" from anywhere: the page's own filter when it marks one (data-slash), otherwise the search box in the top bar.
if(typeof addEventListener==='function')addEventListener('keydown',e=>{
 if(e.key!=='/'||e.defaultPrevented||e.metaKey||e.ctrlKey||e.altKey||typing(document.activeElement)||document.querySelector('dialog[open]'))return;
 const target=document.querySelector('#main [data-slash]')||document.querySelector('.hh-search-in');if(!target)return;
 e.preventDefault();target.focus();target.select?.();
});

export function searchBox(current=''){
 const input=el('input',{type:'search',class:'hh-search-in',placeholder:t('Hledat tickety a review…'),'aria-label':t('Hledat'),'aria-keyshortcuts':'/',title:t('Hledat (klávesa /)'),maxlength:'200',value:current,
  onkeydown:e=>{if(e.key==='Escape'){input.blur();}else if(e.key==='ArrowDown'){const first=document.querySelector('.sr-hit');if(first){e.preventDefault();first.focus();}}}});
 return el('form',{class:'hh-search',role:'search',onsubmit:e=>{e.preventDefault();const q=input.value.trim();if(q)location.hash=searchHash(q);}},input);
}

const when=iso=>iso&&Number.isFinite(Date.parse(iso))?new Intl.DateTimeFormat(locale(),{day:'numeric',month:'short',year:'numeric',timeZone:timeZone()}).format(new Date(iso)):'';
// How search reads a query: shown before the first search and whenever nothing was found.
const tips=()=>el('ul',{class:'sr-tips'},
 [t('Piš obyčejná slova; musí se najít všechna.'),
  t('Stačí začátek slova: „exp“ najde export i exportovat. Uprostřed slova se nehledá.'),
  t('Velikost písmen a diakritika nerozhodují.'),
  t('Hledá se v názvu, popisu, komentářích, štítcích, odkazech a jménech u položek a v názvech, poznámkách a připomínkách review.'),
  t('Id najdeš přímo: napiš třeba APP-12 nebo R-3.'),
  t('Agenti hledají stejně přes MCP: nástroje search a ticket_search (scope read).')].map(text=>el('li',{},text)));
// What a hit is right now: a ticket's status, a review set's state.
function stateOf(r){
 const m=r.meta;if(!m)return null;
 if(r.kind==='ticket'){const s=TICKET_STATUS()[m.status];return s?el('span',{class:`sec-pill ${s[1]}`},s[0]):null;}
 if(m.status==='archived')return el('span',{class:'sec-pill dim'},t('archiv'));
 if(m.feedbackPending)return el('span',{class:'sec-pill warn'},t('čeká na agenta'));
 return m.done?el('span',{class:'sec-pill ok'},t('hotovo')):el('span',{class:'sec-pill info'},t('rozhodnuto {done}/{total}',{done:m.decided,total:m.items}));
}
// The indexed title starts with the id, which the meta line already shows: drop it, match marks included
// (the id is indexed as two words, so a match may mark only a part of it).
export function titleOf(r){
 const s=String(r.title||''),id=String(r.id||'');let i=0,j=0;
 while(i<s.length&&j<id.length){const ch=s[i];if(ch==='\u0001'||ch==='\u0002'){i++;continue;}if(ch!==id[j])return s;i++;j++;}
 if(j<id.length)return s;
 while(s[i]==='\u0002')i++;
 return s.slice(i).replace(/^\s+/,'')||s;
}
const hit=r=>el('a',{class:`sr-hit ${r.kind}`,href:resultHref(r)},
 el('div',{class:'sr-hit-meta'},el('span',{class:'sr-id'},r.id),stateOf(r),r.project?el('span',{},r.project):null,r.meta?.assignee?el('span',{},r.meta.assignee):null,r.updatedAt?el('span',{class:'sr-date'},when(r.updatedAt)):null),
 el('b',{class:'sr-title'},...marked(titleOf(r))),
 r.snippet?el('p',{},...marked(r.snippet)):null);

export function searchView(me,sub){
 const q=queryOf(sub),body=el('div',{class:'sr-body','aria-live':'polite'},el('p',{class:'sec-dim',role:'status'},q?t('Hledám…'):t('Načítám…')));
 const view=el('section',{class:'sec tk sr'},pageHeader({eyebrow:t('Hledání'),title:q?t('Hledání: {q}',{q}):t('Hledání'),lead:q?undefined:t('Napiš, co hledáš: slova z názvu, popisu, komentářů nebo poznámek.')}),body);
 const live=sessionTicket(),lost=authGuard(live);
 let only='';
 const failed=text=>body.replaceChildren(emptyState({icon:'⚠',title:t('Hledání teď nejde'),body:text,actions:[{label:t('Zkusit znovu'),primary:true,onclick:()=>{location.hash=q?searchHash(q):'#search';view.replaceWith(searchView(me,sub));}}]}));
 // Nothing indexed: this hub has no tickets or review sets yet, so there is nothing to find.
 const nothingIndexed=()=>emptyState({icon:'⌕',title:t('Zatím není co prohledávat'),
  body:t('Hledání prochází položky Project Trackeru a sady Review. Na tomhle Home Hubu zatím žádné nejsou; jakmile vzniknou, najdou se tady hned.'),
  actions:[{label:`${t('Projekty')} →`,href:'#projects',primary:true},{label:'Review →',href:'#review'}]});
 function draw(data){
  const indexed=data.indexed||{},total=(indexed.ticket||0)+(indexed.review||0),groups=groupResults(data.results),names=Object.fromEntries(KINDS());
  // Even with nothing to find yet, the page says how search will read a query.
  if(data.indexed&&!total)return body.replaceChildren(nothingIndexed(),el('div',{class:'acc-card sr-help'},el('h3',{},t('Jak hledat')),tips()));
  const scope=data.indexed?el('p',{class:'sec-dim sr-scope'},t('V indexu: {tickets} a {reviews}.',{tickets:tp(indexed.ticket||0,'{n} položka|{n} položky|{n} položek'),reviews:tp(indexed.review||0,'{n} sada review|{n} sady review|{n} sad review')})):null;
  if(!q)return body.replaceChildren(el('div',{class:'acc-card sr-help'},el('h3',{},t('Jak hledat')),tips()),...[scope].filter(Boolean));
  if(!data.results.length)return body.replaceChildren(el('div',{class:'acc-card sr-help'},el('h2',{class:'sr-none'},t('Nic nenalezeno')),el('p',{class:'sec-dim'},t('Na „{q}“ nic neodpovídá. Zkus to takhle:',{q})),tips()),...[scope].filter(Boolean));
  const shown=groups.filter(g=>!only||g.kind===only);
  const chip=(kind,text,n)=>el('button',{type:'button',class:`sys-chip${only===kind?' on':''}`,'aria-pressed':String(only===kind),onclick:()=>{only=kind;draw(data);}},text,el('span',{class:'sr-count'},String(n)));
  body.replaceChildren(
   el('div',{class:'tk-toolbar'},el('div',{class:'sys-chips',role:'group','aria-label':t('Druh výsledku')},chip('',t('Vše'),data.results.length),groups.map(g=>chip(g.kind,names[g.kind]||g.kind,g.results.length))),
    el('span',{class:'sec-dim'},data.results.length>=100?t('Prvních {n} výsledků; upřesni hledání.',{n:data.results.length}):tp(data.results.length,'{n} výsledek|{n} výsledky|{n} výsledků'))),
   ...shown.map(g=>el('section',{class:'sr-group','aria-label':names[g.kind]||g.kind},el('h2',{class:'sr-group-head'},names[g.kind]||g.kind,el('span',{class:'tk-count'},String(g.results.length))),el('div',{class:'sr-list'},g.results.map(hit)))),
   el('p',{class:'tk-keys','aria-label':t('Klávesové zkratky')},[['/',t('hledat')],['j k',t('další / předchozí')],['Enter',t('otevřít')]].flatMap(([key,text])=>[el('kbd',{},key),el('span',{},text)])));
 }
 // j / k and the arrows move the focus through the hits; Enter then follows the focused link by itself.
 if(typeof addEventListener==='function'){
  const onKey=e=>{
   if(!view.isConnected){removeEventListener('keydown',onKey);return;}
   if(e.defaultPrevented||e.metaKey||e.ctrlKey||e.altKey||typing(document.activeElement)||document.querySelector('dialog[open]'))return;
   const step=e.key==='j'||e.key==='ArrowDown'?1:e.key==='k'||e.key==='ArrowUp'?-1:0;if(!step)return;
   const hits=[...view.querySelectorAll('.sr-hit')];if(!hits.length)return;
   const at=hits.indexOf(document.activeElement);e.preventDefault();hits[at<0?(step>0?0:hits.length-1):Math.max(0,Math.min(hits.length-1,at+step))].focus();
  };
  addEventListener('keydown',onKey);onLeave(()=>removeEventListener('keydown',onKey));
 }
 fetch('/api/search?'+new URLSearchParams({q,limit:'100'})).then(async r=>{
  lost(r);if(!live())return;
  if(!r.ok)return failed(r.status===400?t('Tohle hledání nejde (nejvýš 200 znaků).'):t('Hledání teď nejde. Zkus to znovu.'));
  const data=await r.json();if(!live())return;
  draw({...data,results:Array.isArray(data.results)?data.results:[]});
 }).catch(()=>{if(live())failed(t('Hledání teď nejde. Zkus to znovu.'));});
 return view;
}
// Page entry for the shell (app.js): every page module exports (context) => Node, and the server's UI
// manifest names it. context = {me, page, sub, machine, site}.
export const searchPage=({me,sub})=>searchView(me,sub||'');
