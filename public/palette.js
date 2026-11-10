// The command palette (Cmd/Ctrl-K): one box to jump to any page, run a shell action, or search tickets and
// review sets. app.js gives it the lists; it owns the dialog, the filtering and the keyboard.
//   createPalette({pages, actions, machines, canSearch}) → {open(text), close(), toggle()}
//     pages()     [{hash, label, group, icon}]            every page this account may open
//     actions()   [{id, label, hint, icon, run}]           theme, language, sign out, …
//     machines()  [{id, name}]                             machine pages known so far (may be empty)
//     canSearch() whether the hub has full-text search (the tracker module)
// Built on <dialog>: the browser traps focus, closes on Escape and returns focus to where it was.
// Matching ignores case and diacritics; every typed word must appear in the label or its group.
import {el} from './views.js';
import {t} from './i18n.js';
import {icon,navIcon} from './icons.js';
import {authGuard,sessionTicket} from './session-cache.js';
import {searchHash,resultHref,marked} from './search-view.js';

export const fold=s=>String(s||'').normalize('NFD').replace(/\p{M}/gu,'').toLowerCase();
// Items whose text holds every word of the query; a label that starts with the query comes first.
export function matchItems(items,query){
 const words=fold(query).split(/\s+/).filter(Boolean);
 if(!words.length)return items;
 const first=words.join(' ');
 return items.map(item=>({item,hay:fold(`${item.label} ${item.group||''} ${item.hint||''}`)}))
  .filter(x=>words.every(w=>x.hay.includes(w)))
  .sort((a,b)=>Number(fold(b.item.label).startsWith(first))-Number(fold(a.item.label).startsWith(first)))
  .map(x=>x.item);
}
const KIND={ticket:'Ticket',review:'Review'};

export function createPalette({pages=()=>[],actions=()=>[],machines=()=>[],canSearch=()=>false}={}){
 let dialog=null,input=null,list=null,options=[],active=0,timer=null,turn=0,results=[],resultsFor='';
 const go=hash=>{globalThis.location.hash=hash;};
 const option=(o,index)=>el('div',{class:'hh-palette-opt',role:'option',id:`hh-pal-${index}`,'aria-selected':String(index===active),
   onclick:()=>run(index),onmousemove:()=>{if(active!==index)select(index,false);}},
  o.iconNode||el('span',{class:'hh-nav-icon','aria-hidden':'true'},icon(o.icon||'chevron')),
  el('span',{class:'hh-palette-opt-text'},el('b',{},o.title||o.label),o.sub?el('small',{},o.sub):null),
  o.hint?el('span',{class:'hh-palette-hint'},o.hint):null);
 function sections(query){
  const q=query.trim(),out=[];
  const pageItems=matchItems(pages().map(p=>({...p,sub:p.group||null,iconNode:navIcon(p),run:()=>go(`#${p.hash}`)})),q);
  const machineItems=matchItems(machines().map(m=>({label:m.name||m.id,group:t('Stroje'),sub:m.id,icon:'cpu',run:()=>go('#host-'+m.id)})),q);
  const actionItems=matchItems(actions(),q);
  if(pageItems.length)out.push({title:t('Stránky'),items:pageItems});
  if(q&&machineItems.length)out.push({title:t('Stroje'),items:machineItems.slice(0,8)});
  if(actionItems.length)out.push({title:t('Akce'),items:actionItems});
  if(q&&canSearch()){
   const hits=resultsFor===q?results.map(r=>({label:r.title,title:marked(r.title),sub:[KIND[r.kind]||r.kind,r.project].filter(Boolean).join(' · '),icon:r.kind==='review'?'eye':'list',run:()=>go(resultHref(r))})):[];
   out.push({title:t('Tickety a review'),items:[...hits,{label:t('Hledat „{q}“ v ticketech a review',{q}),icon:'search',hint:'↵',run:()=>go(searchHash(q))}]});
  }
  return out;
 }
 function paint(){
  const groups=sections(input.value);
  options=groups.flatMap(g=>g.items);
  if(active>=options.length)active=Math.max(0,options.length-1);
  let index=0;
  list.replaceChildren(...(options.length?groups.flatMap(g=>[el('div',{class:'hh-palette-h',role:'presentation'},g.title),...g.items.map(o=>option(o,index++))])
   :[el('div',{class:'hh-palette-none'},t('Nic neodpovídá.'))]));
  input.setAttribute('aria-activedescendant',options.length?`hh-pal-${active}`:'');
 }
 function select(index,scroll=true){
  if(!options.length)return;
  active=(index+options.length)%options.length;
  for(const node of list.querySelectorAll('.hh-palette-opt'))node.setAttribute('aria-selected',String(node.id===`hh-pal-${active}`));
  input.setAttribute('aria-activedescendant',`hh-pal-${active}`);
  if(scroll)list.querySelector(`#hh-pal-${active}`)?.scrollIntoView({block:'nearest'});
 }
 function run(index){const o=options[index];if(!o)return;close();o.run?.();}
 // Full-text hits for what is typed, a moment after typing stops; a late answer for older text is dropped.
 function search(){
  clearTimeout(timer);const q=input.value.trim(),mine=++turn;
  if(!q||!canSearch()){results=[];resultsFor='';return;}
  timer=setTimeout(async()=>{
   const live=sessionTicket(),lost=authGuard(live);
   try{
    const r=await fetch('/api/search?'+new URLSearchParams({q,limit:'6'}));lost(r);
    if(!r.ok||mine!==turn||!live()||!dialog?.open)return;
    results=(await r.json()).results||[];resultsFor=q;paint();
   }catch{}
  },180);
 }
 const onKey=e=>{
  if(e.key==='ArrowDown'){e.preventDefault();select(active+1);}
  else if(e.key==='ArrowUp'){e.preventDefault();select(active-1);}
  else if(e.key==='Home'&&!input.value){e.preventDefault();select(0);}
  else if(e.key==='Enter'){e.preventDefault();run(active);}
 };
 function build(){
  input=el('input',{type:'text',role:'combobox',autocomplete:'off',spellcheck:'false',maxlength:'200','aria-expanded':'true','aria-controls':'hh-pal-list','aria-autocomplete':'list',
   placeholder:t('Hledat nebo přejít na…'),'aria-label':t('Hledat nebo přejít na…'),oninput:()=>{active=0;paint();search();},onkeydown:onKey});
  list=el('div',{class:'hh-palette-list',id:'hh-pal-list',role:'listbox','aria-label':t('Výsledky')});
  dialog=el('dialog',{class:'hh-palette','aria-label':t('Příkazová paleta'),onclick:e=>{if(e.target===dialog)close();},onclose:()=>{clearTimeout(timer);turn++;dialog.remove();dialog=null;}},
   el('div',{class:'hh-palette-in'},icon('search'),input),list,
   el('div',{class:'hh-palette-foot','aria-hidden':'true'},el('span',{},el('kbd',{class:'hh-kbd'},'↑↓'),t('výběr')),el('span',{},el('kbd',{class:'hh-kbd'},'↵'),t('otevřít')),el('span',{},el('kbd',{class:'hh-kbd'},'Esc'),t('zavřít'))));
  document.body.append(dialog);
 }
 function open(text=''){
  if(dialog?.open){input.focus();return;}
  build();results=[];resultsFor='';active=0;input.value=text;paint();
  dialog.showModal();input.focus();if(text)search();
 }
 function close(){if(dialog?.open)dialog.close();}
 return {open,close,toggle:()=>dialog?.open?close():open(),isOpen:()=>Boolean(dialog?.open)};
}
