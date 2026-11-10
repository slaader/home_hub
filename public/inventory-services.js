// The Services view of the inventory page (#inventory-map/services; the old address #services leads there).
// It is the inventory seen through one kind: every entry of kind "runtime" is a service. Next to the map
// and the table it is the one dense list that answers "what is this service, where do I reach it, and what
// breaks with it": per service its address (port or URL, clickable), the machine it runs on, the names of
// what depends on it and of what it needs, and when and by whom it was last verified. The map shows those
// names for one selected card at a time; the table shows only how many there are.
// It shares the page's search box and the table's place and gap filters, and keeps its own sort order.
// There is nothing to maintain here separately: add or change a runtime entry (in any view, or an agent
// with inventory_update) and the list follows. Opening a row shows the same entry detail as the map.
import {canWrite} from './access.js';
import {t,tp} from './i18n.js';
import {el} from './views.js';
import {emptyState} from './ui.js';
import {place,hasGap,matcher,typeTag,isExample,index} from './inventory-data.js';
import {showCreate,linkify} from './inventory-entry.js';

export const SERVICES_PROMPT=()=>t('Projdi moje stroje a zapiš do inventáře Home Hubu každou běžící službu (MCP server „home-hub“, scope inventory:write).\n1. Zavolej inventory_describe: zjistíš schéma, druhy a pravidla.\n2. Před každým zápisem zavolej inventory_search, ať nezaložíš nic dvakrát. Stroj, na kterém služba běží, musí mít vlastní záznam druhu machine; když chybí, založ ho jako první.\n3. Každou službu ulož přes inventory_update (nebo víc naráz přes inventory_bulk_upsert, nejdřív s dryRun) jako záznam s kind „runtime“: id, name, machine, address (host:port nebo URL), version, managed_by a depends_on.\n4. U přihlašovacích údajů zapiš jen to, kde jsou uložené (store a název položky), nikdy jejich hodnotu.\nNakonec vypiš, co se ti nepodařilo ověřit.');

// Services grouped by where they run, in the order the entries have in the file.
export function serviceGroups(doc){
 const groups=new Map();
 for(const e of doc.entries.filter(x=>x.kind==='runtime')){const key=e.machine||'';if(!groups.has(key))groups.set(key,[]);groups.get(key).push(e);}
 return [...groups].map(([machine,services])=>({machine,label:services[0]?place(services[0])||machine:machine,services}));
}
const text=v=>typeof v==='string'?v:'';
// One row per service, with everything the list shows and sorts by. usedBy: the entries that name this
// service in their depends_on (what stops when it fails); needs: what it names itself.
export function serviceRows(doc){
 const {byId,usedBy}=index(doc),named=d=>({id:d.id,name:byId.get(d.id)?.name||d.id,kind:d.kind||''});
 return doc.entries.filter(e=>e.kind==='runtime').map(e=>({entry:e,id:e.id,name:text(e.name)||e.id,type:typeTag(e),place:text(place(e)),address:text(e.address),version:text(e.version),
  usedBy:(usedBy.get(e.id)||[]).map(named),needs:(e.depends_on||[]).map(named),verified:text(e.verified_at),verifiedBy:text(e.verified_by),gap:hasGap(e)}));
}
const COLUMNS=[['name','Služba'],['address','Adresa'],['place','Stroj'],['usedBy','Závisí na ní'],['needs','Potřebuje'],['verified','Ověřeno']];
const KEY={name:r=>r.name.toLowerCase(),address:r=>r.address.toLowerCase(),place:r=>r.place.toLowerCase(),usedBy:r=>r.usedBy.length,needs:r=>r.needs.length,verified:r=>r.verified};
// Sorted copy. Empty values go last in either direction; ties go by machine, then by name.
export function sortServices(rows,key='place',dir='asc'){
 const of=KEY[key]||KEY.place,sign=dir==='desc'?-1:1,empty=v=>v===''||v===0;
 return [...rows].sort((a,b)=>{const x=of(a),y=of(b);
  if(empty(x)!==empty(y))return empty(x)?1:-1;
  const c=typeof x==='number'?x-y:String(x).localeCompare(String(y),undefined,{numeric:true});
  return c?c*sign:a.place.localeCompare(b.place)||a.name.localeCompare(b.name);});
}
const emptyServices=()=>emptyState({icon:'◎',title:t('Zatím tu nejsou žádné služby'),
 body:t('Katalog služeb je pohled na inventář: každý záznam druhu „runtime“ je služba. V inventáři zatím žádný takový není.'),
 steps:[t('Služba je cokoli, co běží a má adresu: server, démon, aplikace s portem.'),t('Založ záznam s druhem „runtime“ a strojem, na kterém běží. Stroj musí mít vlastní záznam druhu „machine“.'),t('Doplň adresu, verzi, kdo ji spouští a na čem závisí. Objeví se tady i v mapě.')],
 agentPrompt:SERVICES_PROMPT(),mcpSnippet:true,
 actions:[canWrite()?{label:t('Přidat službu'),onclick:()=>showCreate({kind:'runtime'}),primary:true}:null]});

const SHOWN=3;
/**
 * The list. filters: the table's {place, gaps}, shared so a filter set in one view holds in the other;
 * sort: {sort, dir} of this view; query(): the page's search box; onOpen(id) opens an entry.
 */
export function servicesView({doc,filters,sort,query,onOpen,onChange=()=>{}}){
 const all=serviceRows(doc);
 if(!all.length)return {node:el('div',{class:'inv-services-view'},emptyServices()),redraw:()=>{}};
 const places=[...new Set(all.map(r=>r.place).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
 const body=el('tbody',{}),count=el('span',{class:'inv-count',role:'status'}),head=el('tr',{}),empty=el('div',{class:'inv-none'});
 // A place picked in the table that holds no service stays selected (and listed), so the filter is visible here too.
 const placeSelect=el('select',{'aria-label':t('Všechna místa'),onchange:()=>{filters.place=placeSelect.value;draw();onChange();}},
  el('option',{value:''},t('Všechna místa')),[...new Set([...places,filters.place].filter(Boolean))].map(p=>el('option',{value:p},p)));
 const gaps=el('button',{type:'button',class:'inv-chip',onclick:()=>{filters.gaps=!filters.gaps;draw();onChange();}},t('Jen s mezerami'));
 const clear=el('button',{type:'button',class:'inv-more',onclick:()=>{filters.place='';filters.gaps=false;draw();onChange();}},t('Zrušit filtry'));
 const cell=(label,cls,...children)=>el('td',{class:cls,'data-label':label},cls.includes('inv-td-name')?children:el('div',{class:'inv-td-val'},children));
 // Names of related entries: the first few as buttons that open them, the rest as a count.
 const related=(list,none)=>!list.length?el('span',{class:'inv-rel-none'},none):el('span',{class:'inv-rel'},
  list.slice(0,SHOWN).map(x=>el('button',{type:'button',class:'inv-rel-item',title:x.name,onclick:ev=>{ev.stopPropagation();onOpen(x.id);}},x.name)),
  list.length>SHOWN?el('span',{class:'inv-rel-more',title:list.slice(SHOWN).map(x=>x.name).join(', ')},`+${list.length-SHOWN}`):null);
 function draw(){
  const match=matcher(query()),rows=sortServices(all.filter(r=>(!filters.place||r.place===filters.place)&&(!filters.gaps||r.gap)&&(!match||match(r.entry))),sort.sort,sort.dir);
  placeSelect.value=filters.place||'';
  gaps.classList.toggle('on',!!filters.gaps);gaps.setAttribute('aria-pressed',String(!!filters.gaps));
  clear.hidden=!(filters.place||filters.gaps);
  count.textContent=rows.length===all.length?tp(all.length,'{n} služba|{n} služby|{n} služeb'):t('{n} z {total} služeb',{n:rows.length,total:all.length});
  head.replaceChildren(...COLUMNS.map(([key,label])=>{const on=sort.sort===key;
   return el('th',{scope:'col','aria-sort':on?(sort.dir==='desc'?'descending':'ascending'):'none'},
    el('button',{type:'button',class:`inv-sort${on?' on':''}`,onclick:()=>{sort.dir=on&&sort.dir==='asc'?'desc':'asc';sort.sort=key;draw();onChange();}},t(label),el('span',{'aria-hidden':'true'},on?(sort.dir==='desc'?' ↓':' ↑'):'')));}));
  body.replaceChildren(...rows.map(r=>el('tr',{class:r.gap?'gap':'',onclick:ev=>{if(!ev.target.closest('a,button'))onOpen(r.id);}},
   cell(t('Služba'),'inv-td-name cat-service',el('span',{class:'inv-swatch','aria-hidden':'true'}),el('button',{type:'button',class:'inv-rowbtn',onclick:ev=>{ev.stopPropagation();onOpen(r.id);}},r.name),isExample(r.entry)?el('span',{class:'inv-badge amber'},t('Ukázka')):null,
    el('small',{},[r.type,r.version].filter(Boolean).join(' · '))),
   cell(t('Adresa'),'mono inv-td-addr',r.address?el('span',{class:'inv-addr',title:r.address},linkify(r.address)):el('span',{class:'amber-text'},t('Adresa není zapsaná'))),
   cell(t('Stroj'),'',r.place||'—'),
   cell(t('Závisí na ní'),'inv-td-rel',related(r.usedBy,t('nic zapsaného'))),
   cell(t('Potřebuje'),'inv-td-rel',related(r.needs,'—')),
   cell(t('Ověřeno'),'mono',r.verified||'—',r.verifiedBy?el('small',{title:r.verifiedBy},r.verifiedBy):null))));
  empty.hidden=rows.length>0;
  empty.replaceChildren(el('p',{},t('Tomuhle hledání a filtrům nic neodpovídá.')));
 }
 draw();
 return {node:el('div',{class:'inv-table-view inv-services-view'},
   el('div',{class:'inv-chips inv-table-filters'},placeSelect,gaps,clear,el('span',{class:'inv-chip-gap'}),count),
   el('div',{class:'inv-table-wrap'},el('table',{class:'inv-table inv-services'},el('caption',{class:'inv-sr'},t('Služby: adresa, stroj, co na nich závisí a kdy byly ověřené')),el('thead',{},head),body)),empty),
  redraw:draw};
}
// #services was a page of its own. The address still works: it opens the inventory page in this view.
export function servicesPage(){
 const target='#inventory-map/services';
 if(globalThis.location){try{location.replace(target);}catch{location.hash=target;}}
 return el('p',{class:'inv-loading',role:'status'},t('Načítám služby…'));
}
