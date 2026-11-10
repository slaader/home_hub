// Hledání: one box in the top bar, full-text over tickets and review sets (GET /api/search, SQLite FTS5 on the
// server). #search/<words> shows the results; diacritics and case are ignored, every word is a prefix match.
// Matches come back wrapped in \u0001…\u0002 and are drawn as <mark> through text nodes, never as HTML.
import {el} from './views.js';
import {t} from './i18n.js';
import {authGuard,sessionTicket} from './session-cache.js';

const KIND={ticket:'Ticket',review:'Review'};
export const searchHash=q=>'#search/'+encodeURIComponent(q.trim());
export const queryOf=sub=>{try{return decodeURIComponent(sub||'');}catch{return '';}};
export const resultHref=r=>r.kind==='review'?`#review/${r.id}`:`#items/${r.id}`;
// "a\u0001b\u0002c" → ['a', <mark>b</mark>, 'c'] (text only).
export function marked(s){
 const out=[];let rest=String(s||'');
 for(let m;(m=/\u0001([^\u0002]*)\u0002/.exec(rest));){if(m.index)out.push(rest.slice(0,m.index));out.push(el('mark',{},m[1]));rest=rest.slice(m.index+m[0].length);}
 if(rest)out.push(rest.replace(/[\u0001\u0002]/g,''));return out;
}

export function searchBox(current=''){
 const input=el('input',{type:'search',class:'hh-search-in',placeholder:t('Hledat tickety a review…'),'aria-label':t('Hledat'),maxlength:'200',value:current});
 return el('form',{class:'hh-search',role:'search',onsubmit:e=>{e.preventDefault();const q=input.value.trim();if(q)location.hash=searchHash(q);}},input);
}

export function searchView(me,sub){
 const q=queryOf(sub),list=el('div',{class:'hh-search-list','aria-live':'polite'}),head=el('p',{class:'sec-dim'},q?t('Hledám…'):t('Napiš, co hledáš: slova z názvu, popisu, komentářů nebo poznámek.'));
 const view=el('section',{class:'hh-search-page'},el('h2',{},q?t('Hledání: {q}',{q}):t('Hledání')),head,list);
 if(!q)return view;
 const live=sessionTicket(),lost=authGuard(live);
 fetch('/api/search?'+new URLSearchParams({q,limit:'50'})).then(async r=>{
  lost(r);if(!live())return;
  if(!r.ok){head.textContent=r.status===400?t('Tohle hledání nejde (nejvýš 200 znaků).'):t('Hledání teď nejde. Zkus to znovu.');return;}
  const {results}=await r.json();if(!live())return;
  head.textContent=results.length?t('Nalezeno: {n}',{n:results.length}):t('Nic nenalezeno.');
  list.replaceChildren(...results.map(x=>el('a',{class:'hh-search-hit',href:resultHref(x)},
   el('div',{class:'hh-search-meta'},el('span',{class:`hh-search-kind ${x.kind}`},KIND[x.kind]||x.kind),x.project?el('span',{},x.project):null),
   el('b',{},...marked(x.title)),x.snippet?el('p',{},...marked(x.snippet)):null)));
 }).catch(()=>{if(live())head.textContent=t('Hledání teď nejde. Zkus to znovu.');});
 return view;
}
// Page entry for the shell (app.js): every page module exports (context) => Node, and the server's UI
// manifest names it. context = {me, page, sub, machine, site}.
export const searchPage=({me,sub})=>searchView(me,sub||'');
