// Two pages over one payload (GET /api/systems, admins only), plus the software watch list:
//   #versions[/machine]   Verze a aktualizace: per machine, the operating system and the watched software
//                         with update badges that link to the release notes, an "outdated only" filter and
//                         the time each source was last checked. #versions/~watch is the watch list itself.
//   #hardening[/machine]  Ochrana strojů: a pass / warning / fail checklist per machine with a reason for
//                         every check, and the ports open to the network.
// The pill next to each title says where the page's data comes from (the answer's provenance): versions draw
// the machine snapshot, the release check and the watch list; protection draws the machine snapshot alone.
// Both say where the collector stands: not configured (what to add), configured without a snapshot yet,
// a stale snapshot (older than the collector's interval), or fine. SSH keys and sudo stay on #security.
import {el} from './views.js';
import {sessionCache,authGuard} from './session-cache.js';
import {t,tp,locale,say} from './i18n.js';
import {timeZone} from './site.js';
import {pageHeader,emptyState,notInstalled,copyBlock,provenancePart} from './ui.js';

// --- shared pieces (also used by the inventory map, the SSH key page and the router panel) ---------
// Replace a node's children, leaving out what is not there (the DOM would print null as text).
export const fill=(node,...children)=>node.replaceChildren(...children.flat(Infinity).filter(c=>c!==null&&c!==undefined&&c!==false));
export const when=iso=>iso&&Number.isFinite(Date.parse(iso))?new Intl.DateTimeFormat(locale(),{day:'numeric',month:'numeric',hour:'2-digit',minute:'2-digit',timeZone:timeZone()}).format(new Date(iso)):'—';
const day=iso=>iso&&Number.isFinite(Date.parse(iso))?new Intl.DateTimeFormat(locale(),{day:'numeric',month:'numeric',year:'numeric',timeZone:timeZone()}).format(new Date(iso)):'';
// Labels in these tables stay Czech; they are translated with t() where they are displayed.
const STATUS={update:['aktualizace','warn','Je venku novější verze.'],current:['aktuální','ok',''],ahead:['novější než vydání','dim','Nainstalovaná verze je novější než poslední stabilní vydání.'],
 unknown:['neověřeno','dim',''],missing:['nenalezeno','crit','Program na tomto stroji probe nenašel.'],'n/a':['bez kontroly','dim','Pro tento program se nejnovější verze nekontroluje.'],
 floating:['plovoucí tag','dim',''],major:['nová hlavní verze','info','Stejná řada je aktuální; nabízí se další hlavní verze.']};
// The older pill, kept for the inventory map's version block.
export const pill=(text,tone='',title)=>el('span',{class:`sec-pill ${tone}`,title},text);
export const statusPill=s=>{const [label,tone,title]=STATUS[s]||[s,'dim',''];return pill(t(label),tone,title?t(title):title);};
// The badge of the collector pages (design tokens): tone = good | warn | bad | info | '' (neutral).
export const badge=(text,tone='',title)=>el('span',{class:`col-badge ${tone}`,title},text);
const TONE={ok:'good',warn:'warn',crit:'bad',info:'info',dim:''};
const statusBadge=s=>{const [label,tone,title]=STATUS[s]||[s,'dim',''];return badge(t(label),TONE[tone]??'',title?t(title):undefined);};
// A sentence the server built from data (i18n.js → say); exported here for the pages that took it from this file.
export {say};
// "3 h ago" from a number of seconds; and an interval as "6 h".
export function ago(seconds){
 if(!Number.isFinite(seconds))return '—';
 if(seconds<5400)return t('před {n} min',{n:Math.max(1,Math.round(seconds/60))});
 if(seconds<172800)return t('před {n} h',{n:Math.round(seconds/3600)});
 return t('před {n} d',{n:Math.round(seconds/86400)});
}
export const every=seconds=>seconds>=3600?`${Math.round(seconds/3600)} h`:`${Math.round(seconds/60)} min`;
const link=(text,url,title)=>url?el('a',{href:url,target:'_blank',rel:'noopener noreferrer',class:'col-link',title},text):el('span',{},text);
const uptime=s=>s==null?null:s>=86400?`${Math.floor(s/86400)} d ${Math.floor(s%86400/3600)} h`:`${Math.floor(s/3600)} h ${Math.floor(s%3600/60)} min`;
const stat=(k,v,sub,tone='')=>el('div',{class:`col-stat ${tone}`},el('div',{class:'k'},k),el('div',{class:'v'},String(v)),el('div',{class:'s',title:sub},sub));
// A table cell that names its column, so a phone can stack the row as a card.
const cell=(label,...children)=>el('td',{'data-label':label},...children);
const wideCell=(label,...children)=>el('td',{'data-label':label,class:'wide'},...children);
const tilde=p=>String(p||'').replace(/^\/(?:Users|home)\/[^/]+/,'~');

// The line under the page header: when each snapshot was taken, and a clear label when one is stale.
export function freshnessBanner(items){
 const stale=items.some(i=>i.state==='stale');
 return el('div',{class:`col-banner${stale?' warn':''}`,role:stale?'alert':'status'},
  ...items.map(i=>el('span',{},el('b',{},i.label),' ',i.collectedAt?`${when(i.collectedAt)} (${ago(i.ageSeconds)})`:t('zatím nikdy'),i.intervalSeconds?` · ${t('každých {every}',{every:every(i.intervalSeconds)})} `:' ',
   i.state==='stale'?badge(t('starý snímek'),'warn',t('Starší, než dovoluje interval sběru: naplánovaná úloha neběžela, kdy měla.')):i.state==='ok'?badge(t('čerstvé'),'good'):null)),
  stale?el('span',{},t('Zkontroluj naplánovanou úlohu, nebo sběr spusť ručně.')):null);
}

// --- loading -------------------------------------------------------------------------------------
// Admin-only payload: cached 30 s per signed-in principal and dropped on logout/account switch.
const cache=sessionCache(30000);
let onlyUpdates=false,onlyIssues=false,showLoopback=false;
// Also used by the inventory map for its version block (same per-principal cache).
export async function load(force=false){
 const hit=force?undefined:cache.get();if(hit)return hit;
 const store=cache.begin(),lost=authGuard();
 const r=await fetch('/api/systems');
 if(!r.ok){lost(r);const e=await r.json().catch(()=>({}));const err=new Error(e.error?.message||t('Načtení selhalo.'));err.status=r.status;err.collector=e.collector||null;err.provenance=e.provenance||null;throw err;}
 return store('',await r.json());
}

// --- not configured / no snapshot yet ---------------------------------------------------------------
const setupSteps=()=>[
 t('V local/site.json dej každému stroji položku ssh: alias z ~/.ssh/config a probe „mac“ (pro TrueNAS „nas“). Alias „local“ je stroj, na kterém sběr běží.'),
 t('Ověř, že „ssh <alias> true“ projde z tohoto stroje bez dotazu na heslo.'),
 t('Spusť sběr strojů: {command}',{command:'node scripts/collect-systems.mjs'}),
 t('Spusť kontrolu vydání: {command}',{command:'node scripts/check-upstream.mjs'}),
 t('Nainstaluj pravidelný sběr: {mac} (macOS), nebo systemd timery z {linux} (Linux).',{mac:'sh scripts/systems/install-launchd.sh',linux:'examples/systemd/'})];
function setupState(collector){
 if(collector?.state==='waiting'){const n=collector.machines?.length||0;
  return emptyState({icon:'◔',title:t('Sběr je nastavený, ale ještě neproběhl'),
   body:`${tp(n,'V konfiguraci je {n} stroj se sondou.|V konfiguraci jsou {n} stroje se sondou.|V konfiguraci je {n} strojů se sondou.')} ${t('Snímek vznikne prvním spuštěním sběru. Sběr jen čte: na strojích nic neinstaluje ani nemění.')}`,
   steps:setupSteps().slice(2)});}
 return notInstalled({title:t('Sběr verzí a ochrany strojů není nastavený'),
  body:t('Tahle stránka ukazuje verze systémů a softwaru a ochranu strojů. Čte je sběr po SSH, jen pro čtení, a zatím neví, které stroje má číst. Zbytek Home Hubu funguje dál.'),steps:setupSteps()});
}

// --- machine filter and tabs ----------------------------------------------------------------------
function machineChips(mode,machine,doc){
 const chip=(id,label)=>{const m=id&&doc.machines.find(x=>x.id===id),on=(machine||'')===(id||'');
  return el('a',{href:id?`#${mode}/${id}`:`#${mode}`,class:`col-chip${on?' on':''}`,'aria-current':on?'true':null},label,
   m?.stale?badge(t('starý snímek'),'warn',t(m.error||'')):m&&!m.reachable?badge(t('nedostupný'),'bad',t(m.error||'')):null);};
 return el('nav',{class:'col-chips','aria-label':t('Filtr strojů')},chip(null,t('Všechny stroje')),...doc.machines.map(m=>chip(m.id,m.name||m.id)));
}
const toggle=(label,on,change)=>el('label',{class:'col-switch'},el('input',{type:'checkbox',...(on?{checked:''}:{}),onchange:e=>change(e.currentTarget.checked)}),label);
function machineHead(m,extra){
 const hw=[m.hw?.model,m.hw?.cpu,m.hw?.ramGb?`${m.hw.ramGb} GB RAM`:null].filter(Boolean).join(' · ');
 return el('header',{},el('h2',{},el('a',{class:'col-link',href:`#host-${m.id}`},m.name||m.id)),
  m.stale?badge(t('starý snímek'),'warn',t(m.error||'')):!m.reachable?badge(t('nedostupný'),'bad',t(m.error||'')):null,extra,
  el('span',{class:'meta',title:hw},m.collectedAt?t('sebráno {when}',{when:when(m.collectedAt)}):t('zatím neprozkoumáno')));
}

// --- Verze a aktualizace -------------------------------------------------------------------------
function osBlock(m){
 if(!m.os)return el('div',{class:'col-sub'},t(m.error||'Zatím neprozkoumáno.'));
 const updates=(m.os.updates||[]).map(u=>el('li',{},u.title.includes(u.version||'\u0000')?u.title:`${u.title} ${u.version||''}`,' ',
  u.kind==='major'?badge(t('hlavní verze'),'info'):u.kind==='app'?badge(t('aplikace')):badge(u.restart?t('vyžaduje restart'):t('aktualizace'),'warn'),u.date?el('span',{class:'col-dim'},` ${u.date}`):null,
  u.notes?el('div',{class:'col-dim'},t(u.notes)):null));
 return el('div',{class:'col-sub'},el('div',{class:'col-os'},el('span',{class:'col-name'},`${m.os.name} ${m.os.version||''}`),statusBadge(m.os.status||'unknown'),
   el('span',{class:'col-dim'},[m.os.build?`build ${m.os.build}`:m.os.channel,m.os.kernel,m.os.base,uptime(m.uptimeSeconds)?t('běží {uptime}',{uptime:uptime(m.uptimeSeconds)}):null].filter(Boolean).join(' · '))),
  updates.length?el('ul',{class:'col-updates'},updates):m.os.error?el('div',{class:'col-dim'},t(m.os.error)):null);
}
function softwareRow(r){
 const update=r.status==='update';
 const running=r.running==='running'?badge(t('běží'),'good',r.runLabel||''):r.running==='loaded'?badge(t('načteno, neběží'),'',r.runLabel||''):r.running==='absent'?badge(t('neběží'),'',r.runLabel||''):null;
 return el('tr',{class:update?'attn':''},
  cell(t('Program'),el('div',{class:'col-name'},r.name),el('div',{class:'col-dim'},link(say(r.source?.label,r.source?.labelT)||'—',r.source?.url)),
   r.others?.length?el('div',{class:'col-dim',title:r.others.join('\n')},t('+ další instalace: {n}',{n:r.others.length})):null),
  cell(t('Nainstalováno'),el('div',{class:'col-mono'},r.installed||'—'),r.path?el('div',{class:'col-dim col-path',title:r.raw||r.path},tilde(r.path)):null,running,r.stale?badge(t('starý snímek'),'warn'):null),
  cell(t('Nejnovější'),r.latest?el('div',{class:'col-mono'},link(r.latest,r.latestUrl,r.latestUrl?t('Poznámky k vydání'):undefined)):el('span',{class:'col-dim'},'—'),
   r.publishedAt&&r.category!=='containers'?el('div',{class:'col-dim'},t('vydáno {when}',{when:day(r.publishedAt)})):null),
  wideCell(t('Stav'),
   // An update is a badge that leads to the release notes when the source has a page for them.
   update&&r.latestUrl?el('a',{class:'col-badge warn solid',href:r.latestUrl,target:'_blank',rel:'noopener noreferrer',title:t('Poznámky k vydání')},t('aktualizace na {version}',{version:r.latest||'?'}),' ↗')
    :update?badge(t('aktualizace na {version}',{version:r.latest||'?'}),'warn solid'):statusBadge(r.status),
   r.upstreamStale&&r.status!=='unknown'?badge(t('neověřeno'),'warn',t('Poslední kontrola selhala{error}; údaj z {when}.',{error:r.upstreamError?`: ${t(r.upstreamError)}`:'',when:when(r.upstreamCheckedAt)})):null,
   r.note?el('div',{class:'col-dim col-note'},say(r.note,r.noteT)):null),
  cell(t('Zkontrolováno'),el('span',{class:'col-dim col-nowrap'},r.upstreamCheckedAt?when(r.upstreamCheckedAt):r.upstreamFailedAt?t('selhalo {when}',{when:when(r.upstreamFailedAt)}):'—')));
}
function machineCard(doc,m){
 const all=doc.software.filter(r=>r.machine===m.id),rows=all.filter(r=>!onlyUpdates||r.status==='update');
 const osUpdate=m.os?.status==='update',n=all.filter(r=>r.status==='update').length+(osUpdate?1:0);
 if(onlyUpdates&&!rows.length&&!osUpdate)return null;
 const cats=Object.keys(doc.categories).filter(c=>rows.some(r=>r.category===c));
 const body=cats.flatMap(c=>[el('tr',{class:'col-group'},el('th',{colspan:'5',scope:'colgroup'},t(doc.categories[c]))),...rows.filter(r=>r.category===c).map(softwareRow)]);
 const brew=m.brewOutdated||[];
 return el('section',{class:`col-card${n?' attn':''}`,'aria-label':m.name||m.id},
  machineHead(m,n?badge(tp(n,'{n} aktualizace|{n} aktualizace|{n} aktualizací'),'warn solid'):m.reachable?badge(t('vše aktuální'),'good'):null),
  osBlock(m),
  rows.length?el('div',{class:'col-scroll'},el('table',{class:'col-table col-pairs'},
   el('thead',{},el('tr',{},...['Program','Nainstalováno','Nejnovější','Stav','Zkontrolováno'].map(h=>el('th',{scope:'col'},t(h))))),el('tbody',{},body)))
   :el('p',{class:'col-empty'},onlyUpdates?t('Žádný sledovaný program tu na aktualizaci nečeká.'):all.length?t('Nic ke zobrazení.'):t('Na tomhle stroji se zatím žádný software nesleduje.')),
  brew.length&&!onlyUpdates?el('details',{class:'col-more'},el('summary',{},tp(brew.length,'Ostatní Homebrew: {n} zastaralý balíček|Ostatní Homebrew: {n} zastaralé balíčky|Ostatní Homebrew: {n} zastaralých balíčků')),
   el('p',{class:'col-dim'},t('Balíčky mimo sledovaný seznam (většinou knihovny), podle metadat, která si brew naposledy stáhl. Sběr nespouští brew update.')),
   el('div',{class:'col-brew'},brew.map(b=>el('div',{},el('span',{class:'col-mono'},b.name),' ',el('span',{class:'col-dim'},`${b.installed} → ${b.latest}`))))):null);
}
function machinesPanel(doc,machine){
 const cards=doc.machines.filter(m=>!machine||m.id===machine).map(m=>machineCard(doc,m)).filter(Boolean);
 return cards.length?el('div',{class:'col-cards'},cards):el('p',{class:'col-empty'},onlyUpdates?t('Žádný kandidát na aktualizaci.'):t('Nic ke zobrazení.'));
}

// The watch list (GET /api/software-watch): what is followed, and how to let an agent fill it.
const watchPrompt=machines=>t('Připoj se k Home Hubu přes MCP klíčem servisního účtu se scope software:write. Zavolej software_watch_list: vrátí stroje, kategorie a povolené druhy pravidel. Zjisti, jaký software na strojích {machines} používám a stojí za to u něj hlídat verze (běhová prostředí, servery, nástroje pro vývoj). Pro každý přidej položku nástrojem software_watch_put: upstream, odkud se čte nejnovější verze (github, codeberg, pypi, npm, brew-formula, brew-cask), a pro každý stroj pravidlo detect (brew, cask, app, cmd s přepínačem verze, pydist nebo json). Na stroje se dívej jen pro čtení, nic neinstaluj a neměň. Nakonec vypiš, co jsi přidal a co jsi vynechal.',
 {machines:machines.length?machines.map(m=>m.id).join(', '):t('z local/site.json')});
const upstreamText=u=>!u?'—':u.type==='none'?t('bez kontroly'):[u.type,u.repo||u.package||u.name||''].filter(Boolean).join(' · ');
const detectText=d=>[d.kind,d.formula||d.cask||d.path||d.glob||''].filter(Boolean).join(' · ');
function watchPanel(){
 const node=el('div',{class:'col-watch'},el('p',{class:'loading',role:'status'},t('Načítám seznam sledovaného softwaru…')));
 (async()=>{
  try{
   const lost=authGuard(),r=await fetch('/api/software-watch');
   if(!r.ok){lost(r);throw Object.assign(new Error('watch'),{status:r.status});}
   const doc=await r.json(),prompt=watchPrompt(doc.machines||[]);
   if(!doc.items.length){
    fill(node,emptyState({icon:'◎',title:t('Zatím se nesleduje žádný software'),
     body:t('Operační systémy, aplikace na NAS a kontejnery se zjišťují samy. Programy, u kterých chceš hlídat verze, patří do seznamu sledovaného softwaru: odkud se čte nejnovější verze a jak se na stroji zjistí ta nainstalovaná.'),
     steps:[...(doc.machines?.length?[]:[t('Nejdřív dej strojům v local/site.json položku ssh se sondou „mac“: pravidla se čtou na strojích s macOS.')]),
      t('V sekci Uživatelé a API založ servisní účet se scope software:write a vydej mu klíč.'),
      t('Připoj svého agenta přes MCP (níže) a dej mu zadání. Použije nástroje software_watch_list a software_watch_put.'),
      t('Nebo zkopíruj položky z {example} do {file} a uprav je ručně.',{example:doc.example||'config/software-watch.json',file:doc.file||'local/software-watch.json'}),
      t('Po dalším běhu sběru se programy objeví na téhle stránce.')],
     agentPrompt:prompt,mcpSnippet:true,actions:[{label:t('Uživatelé a API'),href:'#access',primary:true}]}));
    return;
   }
   const cats=Object.keys(doc.categories).filter(c=>doc.items.some(i=>i.category===c)),loose=doc.items.filter(i=>!cats.includes(i.category));
   const row=i=>el('tr',{},
    cell(t('Program'),el('div',{class:'col-name'},i.name),el('div',{class:'col-dim col-mono'},i.id)),
    cell(t('Nejnovější verze z'),el('span',{class:'col-mono'},upstreamText(i.upstream))),
    cell(t('Stroje a pravidla'),Object.entries(i.detect||{}).map(([m,d])=>el('div',{},el('b',{},m),' ',el('span',{class:'col-dim col-mono'},detectText(d)),d.upstream?el('span',{class:'col-dim'},` (${upstreamText(d.upstream)})`):null))));
   fill(node,
    el('p',{class:'col-lead'},t('Seznam je v souboru {file}. Mění ho správce ručně, nebo agent nástroji software_watch_list a software_watch_put (scope software:write); pravidlo je vždy jen údaj pro sondu, nikdy příkaz.',{file:doc.file||'local/software-watch.json'})),
    el('section',{class:'col-card'},el('div',{class:'col-scroll'},el('table',{class:'col-table'},
     el('thead',{},el('tr',{},...['Program','Nejnovější verze z','Stroje a pravidla'].map(h=>el('th',{scope:'col'},t(h))))),
     el('tbody',{},[...cats.flatMap(c=>[el('tr',{class:'col-group'},el('th',{colspan:'3',scope:'colgroup'},t(doc.categories[c]))),...doc.items.filter(i=>i.category===c).map(row)]),...loose.map(row)])))),
    copyBlock(t('Zadání pro agenta'),prompt));
  }catch(e){
   fill(node,emptyState({icon:'⚠',title:e.status===403?t('Jen pro administrátora'):t('Seznam sledovaného softwaru se nepodařilo načíst'),body:t('Zkus to znovu.')}));
  }
 })();
 return node;
}

function versionsPage(box,doc,sub){
 // The watch list is its own address (#versions/~watch; no machine id can start with ~).
 const watch=sub==='~watch',machine=doc.machines.some(m=>m.id===sub)?sub:null;
 const sw=doc.software.filter(r=>!['nas-apps','containers'].includes(r.category)),apps=doc.software.filter(r=>r.category==='nas-apps');
 const upd=doc.software.filter(r=>r.status==='update'),osUpd=doc.machines.filter(m=>m.os?.status==='update');
 const unknown=doc.software.filter(r=>r.status==='unknown').length,stale=doc.machines.filter(m=>m.stale||!m.reachable).length;
 const content=el('div',{}),filters=el('div',{class:'col-toolbar'});
 const paint=()=>{
  const list=!watch;
  fill(filters,el('nav',{class:'col-chips','aria-label':t('Pohled')},
    ...[[false,'#versions',t('Podle strojů')],[true,'#versions/~watch',t('Sledovaný software')]].map(([on,href,label])=>el('a',{href,class:`col-chip${watch===on?' on':''}`,'aria-current':watch===on?'true':null},label))),
   list?machineChips('versions',machine,doc):null,
   list?toggle(t('Jen zastaralé'),onlyUpdates,v=>{onlyUpdates=v;paint();}):null);
  fill(content,list?machinesPanel(doc,machine):watchPanel());
 };
 const c=doc.collector||{};
 fill(box,
  pageHeader({eyebrow:t('Inventář'),title:t('Verze a aktualizace'),lead:t('Co na kterém stroji běží v jaké verzi a co čeká na aktualizaci. Sběr jen čte; nic neinstaluje ani neaktualizuje.'),provenance:doc.provenance,
   actions:[{label:t('Obnovit'),onclick:()=>{cache.clear();dispatchEvent(new Event('hashchange'));}}]}),
  freshnessBanner([{label:t('Stroje:'),...c,collectedAt:doc.collectedAt},{label:t('Nejnovější verze:'),...(c.upstream||{}),collectedAt:doc.upstreamCheckedAt}]),
  // Nothing on the watch list: only what the probes discover by themselves is listed. Say where to change that.
  !watch&&c.watch&&c.watch.items===0?el('div',{class:'col-banner'},el('span',{},t('Zatím se nesleduje žádný software: vidíš jen systémy, aplikace NAS a kontejnery.')),el('a',{class:'col-link',href:'#versions/~watch'},t('Nastavit seznam sledovaného softwaru'))):null,
  doc.upstreamFailed?el('div',{class:'col-banner warn'},tp(doc.upstreamFailed,'{n} zdroj neověřen|{n} zdroje neověřeny|{n} zdrojů neověřeno'),' ',el('span',{},t('Poslední kontrola těchto zdrojů selhala; jejich řádky jsou označené.'))):null,
  el('div',{class:'col-stats'},
   stat(t('Kandidáti na aktualizaci'),upd.length+osUpd.length,apps.length?t('systém + software + aplikace NAS'):t('systém + software'),upd.length+osUpd.length?'warn':''),
   stat(t('Systémy'),`${osUpd.length} / ${doc.machines.length}`,osUpd.map(m=>`${m.name} → ${m.os.updates.find(u=>u.kind!=='major'&&u.kind!=='app')?.version||''}`).join(', ')||t('všechny aktuální'),osUpd.length?'warn':''),
   stat(t('Software'),sw.filter(r=>r.status==='update').length,tp(sw.length,'z {n} sledované instalace|z {n} sledovaných instalací|z {n} sledovaných instalací'),''),
   apps.length?stat(t('Aplikace NAS'),apps.filter(r=>r.status==='update').length,tp(apps.length,'z {n} aplikace v TrueNAS|z {n} aplikací v TrueNAS|z {n} aplikací v TrueNAS'),''):null,
   stat(t('Neověřeno'),unknown+stale,stale?tp(stale,'{n} stroj bez čerstvého snímku|{n} stroje bez čerstvého snímku|{n} strojů bez čerstvého snímku'):t('verze, které nešly porovnat'),unknown+stale?'warn':'')),
  filters,content);
 paint();
}

// --- Ochrana strojů ---------------------------------------------------------------------------------
const CHECK_ORDER=['firewall','stealth','pf','filevault','sip','gatekeeper','security-responses','auto-macos','os-update','ssh-password','ssh-root','ssh-forwarding','ftp','sharing','exposed'];
// What a check result means for the reader: [mark, tone, label]. Problems are listed first.
const RESULT={crit:['✕','bad','nesplněno'],warn:['!','warn','varování'],unknown:['?','unknown','neověřeno'],info:['i','info','k vědomí'],ok:['✓','good','splněno']};
const SEVERITY=['crit','warn','unknown','info','ok'];
// Why each check is there, in one sentence (Czech source, translated where shown).
const CHECK_WHY={
 firewall:'Firewall rozhoduje, které příchozí spojení stroj přijme. Bez něj chrání stroj jen router.',
 stealth:'Stroj ve stealth režimu neodpovídá na ping ani na sondy zavřených portů, takže se v síti hůř hledá.',
 pf:'Packet filter je nízkoúrovňový firewall macOS. Bez vlastních pravidel jen doplňuje aplikační firewall.',
 filevault:'Šifrování disku chrání data, když se stroj ztratí nebo ho někdo odnese.',
 sip:'System Integrity Protection brání i uživateli root měnit systémové soubory.',
 gatekeeper:'Gatekeeper pouští jen podepsané a notarizované aplikace.',
 'security-responses':'Rychlé bezpečnostní opravy se mají instalovat samy, bez čekání na velkou aktualizaci.',
 'auto-macos':'Automatická instalace drží systém aktuální; ruční režim je v pořádku, když aktualizace hlídáš.',
 'os-update':'Čekající aktualizace systému obvykle opravuje známé bezpečnostní chyby.',
 'ssh-password':'Přihlášení heslem jde hádat hrubou silou. Klíče jsou bezpečnější.',
 'ssh-root':'Přímé přihlášení jako root obchází účty jednotlivých lidí a jejich sudo pravidla.',
 'ssh-forwarding':'Přesměrování portů dělá z přihlášeného účtu průchod dál do sítě.',
 ftp:'FTP bez TLS posílá hesla i data nešifrovaně.',
 sharing:'Každá zapnutá služba sdílení je další cesta do stroje.',
 exposed:'Porty otevřené do sítě jsou to, co ze stroje vidí ostatní zařízení. Každý má mít svůj důvod.'};
function checkItem(c){
 const [mark,tone,label]=RESULT[c.state]||RESULT.unknown,why=CHECK_WHY[c.id],detail=say(c.detail,c.detailT);
 return el('li',{class:`col-check ${tone}`},
  el('span',{class:'mark','aria-hidden':'true'},mark),
  el('div',{class:'what'},el('span',{class:'col-name'},t(c.label)),' ',el('span',{class:'col-visually-hidden'},`${t(label)}: `),badge(say(c.value,c.valueT)||'—',tone==='unknown'?'':tone,t(label))),
  el('div',{class:'why'},detail?el('div',{},detail):null,why?el('div',{class:'help'},t(why)):null));
}
function portsBlock(m){
 const exposed=m.listening.filter(l=>l.scope!=='loopback'),rows=m.listening.filter(l=>showLoopback||l.scope!=='loopback').sort((a,b)=>a.port-b.port);
 const scope={all:['všechna rozhraní','warn'],address:['jedna adresa',''],loopback:['jen tento stroj','good']};
 if(!m.listening.length)return null;
 return el('details',{class:'col-more'},el('summary',{},t('Porty otevřené do sítě: {n}',{n:new Set(exposed.map(l=>l.port)).size})),
  rows.length?el('div',{class:'col-scroll'},el('table',{class:'col-table col-pairs'},el('thead',{},el('tr',{},...['Port','Proces','Adresa','Dosah'].map(h=>el('th',{scope:'col'},t(h))))),
   el('tbody',{},rows.map(l=>el('tr',{},cell(t('Port'),el('span',{class:'col-mono'},String(l.port))),cell(t('Proces'),l.proc),cell(t('Adresa'),el('span',{class:'col-dim'},l.host||'*')),
    cell(t('Dosah'),(([label,tone])=>badge(t(label),tone))(scope[l.scope]||[l.scope,''])))))))
   :el('p',{class:'col-empty'},t('Žádný port otevřený do sítě.')));
}
function hardeningCard(m){
 const checks=[...m.checks].sort((a,b)=>SEVERITY.indexOf(a.state)-SEVERITY.indexOf(b.state)||(CHECK_ORDER.indexOf(a.id)+1||99)-(CHECK_ORDER.indexOf(b.id)+1||99));
 const shown=checks.filter(c=>!onlyIssues||['crit','warn','unknown'].includes(c.state)),n=s=>checks.filter(c=>c.state===s).length;
 const summary=[n('crit')?badge(t('nesplněno: {n}',{n:n('crit')}),'bad solid'):null,n('warn')?badge(t('varování: {n}',{n:n('warn')}),'warn solid'):null,
  n('unknown')?badge(t('neověřeno: {n}',{n:n('unknown')})):null,badge(t('splněno: {n}',{n:n('ok')}),'good')];
 return el('section',{class:`col-card${n('crit')?' bad':n('warn')?' attn':''}`,'aria-label':m.name||m.id},
  machineHead(m,summary),
  m.os?el('div',{class:'col-sub'},el('span',{class:'col-name'},`${m.os.name} ${m.os.version||''}`)):null,
  !m.checks.length?el('p',{class:'col-empty'},t(m.error||'Zatím neprozkoumáno.')):shown.length?el('ul',{class:'col-checks'},shown.map(checkItem)):el('p',{class:'col-empty'},t('Žádné varování ani nesplněná kontrola.')),
  portsBlock(m));
}
function hardeningPage(box,doc,sub){
 const machine=doc.machines.some(m=>m.id===sub)?sub:null;
 const all=doc.machines.flatMap(m=>m.checks.map(c=>({...c,machine:m.name})));
 const count=s=>all.filter(c=>c.state===s),warn=count('warn'),crit=count('crit'),unknown=count('unknown');
 const exposed=doc.machines.reduce((s,m)=>s+new Set(m.listening.filter(l=>l.scope!=='loopback').map(l=>l.port)).size,0);
 const content=el('div',{}),filters=el('div',{class:'col-toolbar'});
 const paint=()=>{
  fill(filters,machineChips('hardening',machine,doc),toggle(t('Jen problémy'),onlyIssues,v=>{onlyIssues=v;paint();}),toggle(t('Ukázat i porty jen pro tento stroj (127.0.0.1)'),showLoopback,v=>{showLoopback=v;paint();}));
  const ms=doc.machines.filter(m=>!machine||m.id===machine);
  fill(content,ms.length?el('div',{class:'col-cards'},ms.map(hardeningCard)):el('p',{class:'col-empty'},t('Nic ke zobrazení.')));
 };
 const [before,after='']=t('Klíče, authorized_keys a sudo pravidla jsou na stránce {link}. Sběr je jen pro čtení: probe na Macích čte stav přes systémové nástroje (pfctl, sshd -T a lsof přes sudo -n), na NAS přes TrueNAS API.').split('{link}');
 fill(box,
  pageHeader({eyebrow:t('Bezpečnost'),title:t('Ochrana strojů'),lead:t('Kontroly ochrany pro každý stroj: co je splněno, co stojí za pozornost a proč na tom záleží.'),provenance:provenancePart(doc.provenance,['systems']),
   actions:[{label:t('SSH klíče'),href:'#security'},{label:t('Obnovit'),onclick:()=>{cache.clear();dispatchEvent(new Event('hashchange'));}}]}),
  freshnessBanner([{label:t('Stroje:'),...(doc.collector||{}),collectedAt:doc.collectedAt}]),
  el('div',{class:'col-stats'},
   stat(t('Nesplněno'),crit.length,crit.map(c=>`${c.machine}: ${t(c.label)}`).join(', ')||t('žádné'),crit.length?'bad':''),
   stat(t('Varování'),warn.length,[...new Set(warn.map(c=>t(c.label)))].join(', ')||'—',warn.length?'warn':''),
   stat(t('Neověřeno'),unknown.length,unknown.length?t('sonda neměla práva to zjistit'):'—',''),
   stat(t('Splněno'),count('ok').length,tp(doc.machines.length,'na {n} stroji|na {n} strojích|na {n} strojích'),'good'),
   stat(t('Porty do sítě'),exposed,t('otevřené na všech rozhraních nebo adrese LAN'),'')),
  filters,content,
  el('p',{class:'col-foot'},before,el('a',{href:'#security',class:'col-link'},t('SSH klíče')),after));
 paint();
}

export function systemsView(mode='versions',sub=null){
 const box=el('div',{class:'col'},el('p',{class:'loading',role:'status'},t('Načítám stav strojů…')));
 const draw=async()=>{
  try{const doc=await load();(mode==='hardening'?hardeningPage:versionsPage)(box,doc,sub);}
  catch(e){
   const head=pageHeader({...(mode==='hardening'?{eyebrow:t('Bezpečnost'),title:t('Ochrana strojů')}:{eyebrow:t('Inventář'),title:t('Verze a aktualizace')}),provenance:e.provenance});
   // Without a snapshot the watch list can still be prepared (#versions/~watch).
   if(e.status===404)fill(box,head,setupState(e.collector),mode==='versions'&&sub==='~watch'?watchPanel():null);
   else fill(box,head,emptyState({icon:'⚠',title:e.status===403?t('Jen pro administrátora'):t('Stav strojů se nepodařilo načíst'),body:e.status===403?t('Tahle stránka je dostupná jen správci.'):t(e.message)||t('Zkus to znovu.'),
    actions:e.status===403?[]:[{label:t('Zkusit znovu'),onclick:()=>{fill(box,el('p',{class:'loading',role:'status'},t('Načítám stav strojů…')));draw();},primary:true}]}));
  }
 };
 draw();
 return box;
}
// Page entry for the shell (app.js): every page module exports (context) => Node, and the server's UI
// manifest names it. context = {me, page, sub, machine, site}.
export const systemsPage=({page,sub})=>systemsView(page,sub);
