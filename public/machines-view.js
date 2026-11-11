// Administration → Integrations → Machines (GET /api/admin/machines, server/machine-facets.mjs). Every machine
// once, and per machine what each module knows about it: telemetry, backups, versions, protection, SSH keys,
// inventory, LLM runtimes, Git LFS (and what plugins add). Each part is set up where it always was (Overview,
// Backups, Git LFS, …); this page says what is set up and what is not, and links there.
// machinesSection: the cards at the top of the Integrations page. machinePage: one machine
// (#integrations/machine/<id>). Text-safe DOM only.
import {el} from './views.js';
import {t,tp,say} from './i18n.js';
import {pageHeader,emptyState,statusPill,icon,copyBlock} from './ui.js';

export const machineHref=id=>`#integrations/machine/${encodeURIComponent(id)}`;
const FACET={ok:['v pořádku','good'],warn:['varování','warn'],stale:['zastaralé','warn'],error:['chyba','bad'],off:['vypnuto','plain'],
 'not-configured':['nenastaveno','info'],'not-applicable':['netýká se','']};
export const facetLabel=state=>t((FACET[state]||FACET.error)[0]);
export const facetTone=state=>(FACET[state]||FACET.error)[1];
// Who does the work for a part (server/machine-facets.mjs → HOW_BY).
const BY={hub:['Home Hub sám','Home Hub to dělá celé sám; na stroji nic neinstaluješ.'],
 source:['Home Hub čte zdroj na stroji','Home Hub data čte sám, ale na stroji musí běžet zdroj (aplikace nebo služba).'],
 collector:['Kolektor (plánovaná úloha)','Skript na stroji hubu, který se pravidelně přihlásí přes SSH a jen čte. Nastavení je v local/site.json.'],
 agent:['Agent přes MCP','Data do hubu zapíše agent (klíč servisního účtu, MCP) nebo ty ručně.'],
 integration:['Integrace modulu','Integrace modulu nebo pluginu; nastavuje se podle jejího postupu.']};
export const byLabel=by=>t((BY[by]||BY.integration)[0]);
const ONLINE={online:['online','good'],stale:['zastaralé','warn'],offline:['offline','bad'],unknown:['stav neznámý','']};
const onlinePill=m=>{const [label,tone]=ONLINE[m.online]||ONLINE.unknown;return statusPill(t(label),tone);};

// The whole machine in one pill: what needs attention first, then how much is set up.
export function machinePill(m){
 const c=m.counts||{};
 if(m.state==='error')return statusPill(t('potřebuje pozornost'),'bad');
 if(m.state==='warn')return statusPill(t('potřebuje pozornost'),'warn');
 if(!c.ok)return statusPill(t('nic nenastaveno'),'info');
 return c.notConfigured?statusPill(t('částečně nastaveno'),'info'):statusPill(t('vše nastaveno'),'good');
}
export function countsLine(c={}){
 return [c.ok?tp(c.ok,'{n} v pořádku|{n} v pořádku|{n} v pořádku'):null,
  c.attention?tp(c.attention,'{n} chce pozornost|{n} chtějí pozornost|{n} chce pozornost'):null,
  c.notConfigured?tp(c.notConfigured,'{n} nenastaveno|{n} nenastaveno|{n} nenastaveno'):null,
  c.off?tp(c.off,'{n} vypnuto|{n} vypnuto|{n} vypnuto'):null].filter(Boolean).join(' · ')||t('nic nenastaveno');
}
const hostLine=m=>[m.hostname,m.ip&&m.ip!==m.hostname?m.ip:null].filter(Boolean).join(' · ');

function machineCard(m){
 return el('a',{class:'mc-card','data-state':m.state,href:machineHref(m.id)},
  el('div',{class:'mc-card-head'},el('div',{class:'mc-card-title'},el('h3',{},m.name),el('p',{class:'mc-host'},hostLine(m)||m.id)),machinePill(m)),
  el('ul',{class:'mc-strip','aria-label':t('Části')},m.facets.filter(f=>f.state!=='not-applicable').map(f=>
   el('li',{class:`mc-dot ${facetTone(f.state)}`.trim(),'data-state':f.state,title:`${t(f.title)}: ${facetLabel(f.state)}`},icon(f.icon),el('span',{class:'ui-sr'},`${t(f.title)}: ${facetLabel(f.state)}`)))),
  el('p',{class:'mc-counts'},countsLine(m.counts)));
}

// onAdd: opens the add-machine dialog (null when this person may not add one).
export function machinesSection(doc,{onAdd}={}){
 const list=doc?.machines||[];
 return el('section',{class:'ig-group mc-section','aria-labelledby':'mc-title'},
  el('div',{class:'mc-section-head'},el('h2',{id:'mc-title'},icon('monitor'),t('Stroje')),
   onAdd?el('button',{type:'button',class:'ui-button small primary',onclick:onAdd},t('⊕ Přidat stroj')):null),
  el('p',{class:'ig-lead'},t('Každý stroj jednou: co je u něj nastavené (telemetrie, zálohy, verze, SSH klíče, inventář, LLM runtimy, Git LFS) a co ne. Nastavuje se na původních stránkách; tady je odkaz.')),
  list.length?el('div',{class:'mc-grid'},list.map(machineCard))
   :emptyState({compact:true,icon:'monitor',title:t('Žádný stroj'),body:t('Stroje jsou v local/site.json, nebo je přidáš tady či v Přehledu (⊕ Přidat stroj).')}));
}

function facetRow(f){
 const setup=f.state==='not-configured';
 return el('li',{class:'mc-facet','data-state':f.state},
  el('span',{class:'ig-mark','aria-hidden':'true'},icon(f.icon)),
  el('div',{class:'mc-facet-body'},
   el('div',{class:'mc-facet-head'},el('h3',{},t(f.title)),statusPill(facetLabel(f.state),facetTone(f.state))),
   f.summary?el('p',{class:'mc-facet-summary'},say(f.summary,f.summaryT)):null,
   f.details?.length?el('dl',{class:'mc-facet-details'},f.details.flatMap(d=>[el('dt',{},t(d.label)),el('dd',{},say(d.value,d.valueT))])):null,
   f.how?el('p',{class:'mc-how'},el('span',{class:'mc-by','data-by':f.how.by,title:t((BY[f.how.by]||BY.integration)[1])},byLabel(f.how.by)),' ',f.how.text?say(f.how.text,f.how.textT):null):null,
   // Where something is missing: what to hand to one's own coding agent, with this machine filled in.
   f.prompt?el('details',{class:'mc-prompt',...(setup?{open:''}:{})},el('summary',{},icon('bolt'),t('Zadání pro agenta')),
    copyBlock(t('Zadání pro agenta'),say(f.prompt,f.promptT),{note:t('Agent se k hubu připojí klíčem servisního účtu (Uživatelé a API → Servisní účty) tam, kde zapisuje přes MCP. Co se dělá na stroji, dělá tvůj agent tvým přístupem; Home Hub na cizí stroje nic neinstaluje.')})):null),
  f.href&&f.state!=='not-applicable'?el('a',{class:`ui-button small${setup?' primary':''}`,href:f.href},setup?t('Nastavit'):t('Otevřít')):el('span',{}));
}

export function machinePage(doc,id){
 // A link may carry the inventory's spelling of the id (mini-server for mini_server).
 const norm=v=>String(v).toLowerCase().replace(/[_.\s]/g,'-');
 const m=doc?.machines?.find(x=>x.id===id)||doc?.machines?.find(x=>norm(x.id)===norm(id));
 if(!m)return el('div',{class:'ig-page'},pageHeader({back:{href:'#integrations',label:t('Integrace')},eyebrow:t('Správa · Stroje'),title:id}),
  emptyState({icon:'monitor',title:t('Neznámý stroj'),body:t('Stroj s tímhle id v Přehledu není. Mohl být odebrán.'),actions:[{label:t('← Integrace'),href:'#integrations',primary:true}]}));
 const order={error:0,warn:1,stale:1,'not-configured':2,off:3,ok:4,'not-applicable':5};
 const facets=[...m.facets].sort((a,b)=>(order[a.state]??9)-(order[b.state]??9));
 return el('div',{class:'ig-page mc-page'},
  pageHeader({back:{href:'#integrations',label:t('Integrace')},eyebrow:t('Správa · Stroje'),title:m.name,lead:hostLine(m)||null,
   actions:[{label:t('Otevřít v Přehledu'),href:`#host-${m.id}`}]}),
  el('div',{class:'mc-badges'},onlinePill(m),machinePill(m),
   el('span',{class:'ui-pill'},m.source==='site'?t('z local/site.json'):t('přidaný v hubu')),
   el('span',{class:'mc-counts'},countsLine(m.counts))),
  el('ul',{class:'mc-facets'},facets.map(facetRow)),
  el('section',{class:'mc-legend','aria-label':t('Kdo co dělá')},el('h2',{},t('Kdo co dělá')),
   el('dl',{},Object.entries(BY).flatMap(([by,[label,text]])=>[el('dt',{},el('span',{class:'mc-by','data-by':by},t(label))),el('dd',{},t(text))]))));
}
