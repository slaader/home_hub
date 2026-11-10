// #services (Inventář → Služby): the services catalog. It is the inventory seen through one kind: every
// entry of kind "runtime" is a service, grouped by the machine it runs on. There is nothing to maintain
// here separately: add or change a runtime entry (in the map, or an agent with inventory_update) and the
// catalog follows. Opening a card shows the same entry detail as the map.
import {canWrite} from './access.js';
import {t,tp} from './i18n.js';
import {el,onLeave} from './views.js';
import {pageHeader,emptyState} from './ui.js';
import {currentPrincipal,pageAllowed} from './session-cache.js';
import {load as loadSystems} from './systems-view.js';
import {load,setCurrent,setSystems,systemsDoc,place,hasGap,matcher,typeTag,isExample,index} from './inventory-data.js';
import {showDetail,showCreate,linkify,badge} from './inventory-entry.js';

export const SERVICES_PROMPT=()=>t('Projdi moje stroje a zapiš do inventáře Home Hubu každou běžící službu (MCP server „home-hub“, scope inventory:write).\n1. Zavolej inventory_describe: zjistíš schéma, druhy a pravidla.\n2. Před každým zápisem zavolej inventory_search, ať nezaložíš nic dvakrát. Stroj, na kterém služba běží, musí mít vlastní záznam druhu machine; když chybí, založ ho jako první.\n3. Každou službu ulož přes inventory_update (nebo víc naráz přes inventory_bulk_upsert, nejdřív s dryRun) jako záznam s kind „runtime“: id, name, machine, address (host:port nebo URL), version, managed_by a depends_on.\n4. U přihlašovacích údajů zapiš jen to, kde jsou uložené (store a název položky), nikdy jejich hodnotu.\nNakonec vypiš, co se ti nepodařilo ověřit.');

// Services grouped by where they run, in the order the entries have in the file.
export function serviceGroups(doc){
 const groups=new Map();
 for(const e of doc.entries.filter(x=>x.kind==='runtime')){const key=e.machine||'';if(!groups.has(key))groups.set(key,[]);groups.get(key).push(e);}
 return [...groups].map(([machine,services])=>({machine,label:services[0]?place(services[0])||machine:machine,services}));
}
function card(doc,e,usedBy){
 const needs=(e.depends_on||[]).length,users=(usedBy.get(e.id)||[]).length;
 return el('article',{class:`inv-service${hasGap(e)?' gap':''}`,tabindex:'0',role:'button','aria-label':`${e.name}. ${t('Otevřít záznam')}`,
   onclick:ev=>{if(!ev.target.closest('a'))showDetail(doc,e.id);},onkeydown:ev=>{if((ev.key==='Enter'||ev.key===' ')&&ev.target===ev.currentTarget){ev.preventDefault();showDetail(doc,e.id);}}},
  el('header',{},el('h3',{},e.name),badge(typeTag(e),'kind-runtime'),isExample(e)?badge(t('Ukázka'),'amber'):null),
  e.address?el('p',{class:'mono inv-service-addr'},linkify(e.address)):el('p',{class:'amber-text inv-service-addr'},t('Adresa není zapsaná')),
  e.notes?el('p',{class:'inv-service-notes'},e.notes):null,
  el('footer',{},e.version?el('span',{class:'inv-service-version',title:`${t('Verze (zapsaná)')}: ${e.version}`},e.version):null,el('span',{title:t('Potřebuje {n}',{n:needs})},`→ ${needs}`),el('span',{title:t('Závisí na něm {n}',{n:users})},`← ${users}`),
   (e.secrets||[]).length?el('span',{},tp(e.secrets.length,'{n} tajemství|{n} tajemství|{n} tajemství')):null,el('span',{class:'inv-service-when'},e.verified_at||'')));
}
const emptyServices=(inventoryEmpty)=>emptyState({icon:'◎',title:t('Zatím tu nejsou žádné služby'),
 body:inventoryEmpty?t('Katalog služeb je pohled na inventář: každý záznam druhu „runtime“ je služba. Inventář je zatím prázdný, takže není co ukázat.'):t('Katalog služeb je pohled na inventář: každý záznam druhu „runtime“ je služba. V inventáři zatím žádný takový není.'),
 steps:[t('Služba je cokoli, co běží a má adresu: server, démon, aplikace s portem.'),t('Založ záznam s druhem „runtime“ a strojem, na kterém běží. Stroj musí mít vlastní záznam druhu „machine“.'),t('Doplň adresu, verzi, kdo ji spouští a na čem závisí. Objeví se tady i v mapě.')],
 agentPrompt:SERVICES_PROMPT(),mcpSnippet:true,
 actions:[canWrite()?{label:t('Přidat službu'),onclick:()=>showCreate({kind:'runtime'}),primary:true}:null,{label:t('Otevřít mapu inventáře'),href:'#inventory-map'}]});

export function servicesPage({me}={}){
 const body=el('div',{class:'inv-services-body'},el('p',{class:'inv-loading',role:'status'},t('Načítám služby…')));
 const who=currentPrincipal();let alive=true;onLeave(()=>{alive=false;});
 const state={query:'',machine:''};
 const show=({doc})=>{
  if(!alive)return;setCurrent(doc);
  const groups=serviceGroups(doc),total=groups.reduce((n,g)=>n+g.services.length,0);
  if(!total)return body.replaceChildren(emptyServices(!doc.entries.length));
  const {usedBy}=index(doc),list=el('div',{class:'inv-service-groups'}),count=el('span',{class:'inv-count',role:'status'});
  const draw=()=>{const match=matcher(state.query);let shown=0;
   list.replaceChildren(...groups.filter(g=>!state.machine||g.machine===state.machine).map(g=>{const services=g.services.filter(e=>!match||match(e));shown+=services.length;
    return services.length?el('section',{class:'inv-service-group'},el('h2',{},g.label||t('Bez stroje'),el('span',{class:'inv-count'},String(services.length))),el('div',{class:'inv-service-grid'},services.map(e=>card(doc,e,usedBy)))):null;}).filter(Boolean));
   if(!shown)list.replaceChildren(el('div',{class:'inv-none'},el('p',{},t('Tomuhle hledání a filtrům nic neodpovídá.'))));
   count.textContent=shown===total?tp(total,'{n} služba|{n} služby|{n} služeb'):t('{n} z {total} služeb',{n:shown,total});
   for(const b of chips.querySelectorAll('button'))b.classList.toggle('on',b.getAttribute('data-machine')===state.machine),b.setAttribute('aria-pressed',String(b.getAttribute('data-machine')===state.machine));};
  const chip=(machine,label,n)=>el('button',{type:'button',class:'inv-chip','data-machine':machine,onclick:()=>{state.machine=machine;draw();}},`${label} · ${n}`);
  const chips=el('div',{class:'inv-chips',role:'group','aria-label':t('Stroj')},chip('',t('Vše'),total),groups.length>1?groups.map(g=>chip(g.machine,g.label||t('Bez stroje'),g.services.length)):null);
  const search=el('input',{type:'search',class:'inv-search',placeholder:t('Hledat službu, adresu, stroj…'),'aria-label':t('Hledat ve službách'),oninput:()=>{state.query=search.value;draw();}});
  body.replaceChildren(el('div',{class:'inv-toolbar'},search,count,el('span',{class:'inv-toolbar-gap'}),canWrite()?el('button',{type:'button',class:'inv-btn primary',onclick:()=>showCreate({kind:'runtime',machine:state.machine})},t('+ Přidat službu')):null),chips,list,
   el('p',{class:'muted inv-source-note'},t('Služby jsou záznamy inventáře druhu „runtime“ · aktualizováno {when}.',{when:doc.updated_at||'—'})));
  draw();
 };
 const fail=e=>{if(alive)body.replaceChildren(emptyState({icon:'⚠',title:t('Služby se nepodařilo načíst'),body:t(e.message),actions:[{label:t('Zkusit znovu'),onclick:()=>{body.replaceChildren(el('p',{class:'inv-loading',role:'status'},t('Načítám služby…')));load().then(show).catch(fail);},primary:true}]}));};
 load().then(show).catch(fail);
 // The entry detail shows installed versions to those who may see the versions page.
 if(me&&pageAllowed('versions',me)&&!systemsDoc())loadSystems().then(d=>{if(who===currentPrincipal()&&alive)setSystems(d);}).catch(()=>{});
 return el('div',{class:'inv-page'},pageHeader({eyebrow:t('Inventář'),title:t('Služby'),lead:t('Co kde běží, na jaké adrese a v jaké verzi. Každá služba je záznam inventáře druhu „runtime“.')}),body);
}
