// The inventory as a table: every entry on one line, sortable by any column and filtered by the page's
// search box, by kind, by place and by "has a gap". On a phone each row becomes a small card.
// Pure helpers (rowsOf, sortRows) are exported for tests.
import {t,tp} from './i18n.js';
import {el} from './views.js';
import {KIND,catOf,catLabel,kindName,place,hasGap,index,matcher,isExample} from './inventory-data.js';

const COLUMNS=[['name','Název'],['kind','Druh'],['place','Kde'],['address','Adresa'],['version','Verze'],['links','Vazby'],['secrets','Tajemství'],['verified','Ověřeno']];
const text=v=>typeof v==='string'?v:'';
// One row per entry, with everything the columns show and sort by.
export function rowsOf(doc){
 const {usedBy}=index(doc),runs=new Map();
 for(const e of doc.entries)if(e.kind!=='machine'&&e.machine)runs.set(e.machine,(runs.get(e.machine)||0)+1);
 return doc.entries.map(e=>({entry:e,id:e.id,name:text(e.name)||e.id,kind:e.kind,kindLabel:kindName(e.kind),place:text(place(e)),address:text(e.address),version:text(e.version),
  needs:(e.depends_on||[]).length,usedBy:(usedBy.get(e.id)||[]).length+(runs.get(e.id)||0),secrets:(e.secrets||[]).length,unknown:(e.secrets||[]).filter(s=>s.store==='unknown').length,
  gap:hasGap(e),verified:text(e.verified_at),inferred:e.confidence==='inferred'}));
}
const KEY={name:r=>r.name.toLowerCase(),kind:r=>r.kindLabel.toLowerCase(),place:r=>r.place.toLowerCase(),address:r=>r.address.toLowerCase(),version:r=>r.version.toLowerCase(),links:r=>r.needs+r.usedBy,secrets:r=>r.secrets,verified:r=>r.verified};
// Sorted copy. Empty values go last in either direction; ties keep the name order.
export function sortRows(rows,key='name',dir='asc'){
 const of=KEY[key]||KEY.name,sign=dir==='desc'?-1:1,empty=v=>v===''||v===0;
 return [...rows].sort((a,b)=>{const x=of(a),y=of(b);
  if(empty(x)!==empty(y))return empty(x)?1:-1;
  const c=typeof x==='number'?x-y:String(x).localeCompare(String(y),undefined,{numeric:true});
  return c?c*sign:a.name.localeCompare(b.name);});
}

/**
 * state: {sort, dir, kind, place, gaps} kept by the page between redraws; query: the search box text.
 * onOpen(id) opens an entry; onChange() is called after a filter or sort changed (the page saves it).
 */
export function tableView({doc,state,query,onOpen,onChange=()=>{}}){
 const all=rowsOf(doc),kinds=[...new Set(all.map(r=>r.kind))],places=[...new Set(all.map(r=>r.place).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
 if(state.kind&&!kinds.includes(state.kind))state.kind='';
 if(state.place&&!places.includes(state.place))state.place='';
 const body=el('tbody',{}),count=el('span',{class:'inv-count',role:'status'}),head=el('tr',{}),empty=el('div',{class:'inv-none'});
 const select=(label,value,options,set)=>{const s=el('select',{'aria-label':label,onchange:()=>{set(s.value);draw();onChange();}},el('option',{value:''},label),options.map(([v,l])=>el('option',{value:v},l)));s.value=value;return s;};
 const kindSelect=select(t('Všechny druhy'),state.kind||'',Object.keys(KIND).filter(k=>kinds.includes(k)).map(k=>[k,kindName(k)]),v=>{state.kind=v;});
 const placeSelect=select(t('Všechna místa'),state.place||'',places.map(p=>[p,p]),v=>{state.place=v;});
 const gaps=el('button',{type:'button',class:'inv-chip',onclick:()=>{state.gaps=!state.gaps;draw();onChange();}},t('Jen s mezerami'));
 const clear=el('button',{type:'button',class:'inv-more',onclick:()=>{state.kind='';state.place='';state.gaps=false;kindSelect.value='';placeSelect.value='';draw();onChange();}},t('Zrušit filtry'));
 // name: the cell lays out its own parts; every other cell keeps its value together (a phone shows label | value).
 const cell=(label,cls,...children)=>el('td',{class:cls,'data-label':label},cls.includes('inv-td-name')?children:el('div',{class:'inv-td-val'},children));
 function draw(){
  const match=matcher(query()),rows=sortRows(all.filter(r=>(!state.kind||r.kind===state.kind)&&(!state.place||r.place===state.place)&&(!state.gaps||r.gap)&&(!match||match(r.entry))),state.sort,state.dir);
  gaps.classList.toggle('on',!!state.gaps);gaps.setAttribute('aria-pressed',String(!!state.gaps));
  clear.hidden=!(state.kind||state.place||state.gaps);
  count.textContent=rows.length===all.length?tp(all.length,'{n} záznam|{n} záznamy|{n} záznamů'):t('{n} z {total} záznamů',{n:rows.length,total:all.length});
  head.replaceChildren(...COLUMNS.map(([key,label])=>{const on=state.sort===key;
   return el('th',{scope:'col','aria-sort':on?(state.dir==='desc'?'descending':'ascending'):'none'},
    el('button',{type:'button',class:`inv-sort${on?' on':''}`,onclick:()=>{state.dir=on&&state.dir==='asc'?'desc':'asc';state.sort=key;draw();onChange();}},t(label),el('span',{'aria-hidden':'true'},on?(state.dir==='desc'?' ↓':' ↑'):'')));}));
  body.replaceChildren(...rows.map(r=>el('tr',{class:r.gap?'gap':'',onclick:ev=>{if(!ev.target.closest('a,button'))onOpen(r.id);}},
   cell(t('Název'),`inv-td-name cat-${catOf(r.entry)}`,el('span',{class:'inv-swatch',title:catLabel(catOf(r.entry)),'aria-hidden':'true'}),el('button',{type:'button',class:'inv-rowbtn',onclick:()=>onOpen(r.id)},r.name),isExample(r.entry)?el('span',{class:'inv-badge amber'},t('Ukázka')):null,el('small',{class:'mono'},r.id)),
   cell(t('Druh'),'',r.kindLabel,r.entry.type?el('small',{},r.entry.type):null),
   cell(t('Kde'),'',r.place||'—'),
   cell(t('Adresa'),'mono',r.address||(r.kind==='runtime'?el('span',{class:'amber-text'},t('chybí')):'—')),
   cell(t('Verze'),'',r.version||'—'),
   cell(t('Vazby'),'inv-td-num',el('span',{title:t('Potřebuje {n}',{n:r.needs})},`→ ${r.needs}`),' ',el('span',{title:t('Závisí na něm {n}',{n:r.usedBy})},`← ${r.usedBy}`)),
   cell(t('Tajemství'),'inv-td-num',r.secrets?String(r.secrets):'—',r.unknown?el('span',{class:'amber-text'},` · ${t('{n} nezapsáno',{n:r.unknown})}`):null),
   cell(t('Ověřeno'),'mono',r.verified||'—',r.inferred?el('small',{},t('odvozeno')):null))));
  empty.hidden=rows.length>0;
  empty.replaceChildren(el('p',{},t('Tomuhle hledání a filtrům nic neodpovídá.')));
 }
 draw();
 return {node:el('div',{class:'inv-table-view'},
   el('div',{class:'inv-chips inv-table-filters'},kindSelect,placeSelect,gaps,clear,el('span',{class:'inv-chip-gap'}),count),
   el('div',{class:'inv-table-wrap'},el('table',{class:'inv-table'},el('caption',{class:'inv-sr'},t('Záznamy inventáře')),el('thead',{},head),body)),empty),
  redraw:draw};
}
