// Telemetry on the overview: what a machine's state is called, and what the page shows when live numbers are
// missing. Live metrics come from a separate telemetry agent (Thermo) that is optional: the server names it
// and where to get it in /api/home → telemetry {agent, repoUrl, staleAfterSeconds} (server/thermo-client.mjs).
// Three cases are kept apart on purpose:
//   not installed   the machine names no telemetry host                    → how to install it
//   unreachable     a host is named, nothing was ever read from it         → what to check (and why)
//   stale           readings exist but the newest is older than 3 minutes  → when it was last seen
// A failed read says the agent did not answer. It never says the machine is off.
// Also here: the "local LLM runtimes" section of a machine page, the extension point a provider fills
// (home.runtimes, docs/plugins.md); until one does, it says it needs the telemetry agent.
import {el} from './views.js';
import {t,tp,locale} from './i18n.js';
import {timeZone} from './site.js';
import {notInstalled} from './ui.js';

const clock=iso=>{const ms=Date.parse(iso);if(!Number.isFinite(ms))return '';
 const sameDay=new Date(ms).toDateString()===new Date().toDateString();
 return new Intl.DateTimeFormat(locale(),{...(sameDay?{}:{day:'numeric',month:'numeric'}),hour:'2-digit',minute:'2-digit',timeZone:timeZone()}).format(new Date(ms));};
const agentOf=meta=>meta?.agent||'Thermo';

// The one-line state of a machine: {tone: ok | warn | bad | dim, text, title}.
// Machines that report through the telemetry agent are judged by their readings; a NAS or a router by its
// own feed (service probes, the router adapter); anything else has nothing to judge.
export function statusOf(m){
 const tel=m.telemetry||{};
 const notOff=t('Neúspěšné čtení neznamená, že je stroj vypnutý.');
 if(m.kind==='thermo'){
  if(tel.state==='ok'||(!tel.state&&m.online==='online'))return {tone:'ok',text:'online',title:tel.lastSampleAt?t('Poslední měření {when}',{when:clock(tel.lastSampleAt)}):''};
  if(tel.state==='stale')return {tone:'warn',text:t('stará data · {when}',{when:clock(tel.lastSampleAt)}),title:notOff};
  if(tel.reason==='no-login')return {tone:'warn',text:t('telemetrie nepřipojena'),title:t('Home Hub nemá přihlášení k telemetrii tohoto stroje.')};
  if(tel.reason==='denied')return {tone:'warn',text:t('přihlášení odmítnuto'),title:t('Telemetrie odmítla přihlášení Home Hubu.')};
  return {tone:'warn',text:t('telemetrie neodpovídá'),title:notOff};
 }
 if(m.kind==='nas'||m.kind==='router'){
  // No feed at all (no service probes for the NAS, no router adapter data) is "nothing to judge", not a failure.
  if(m.kind==='nas'&&m.online==='unknown'&&tel.state==='not-installed')return {tone:'dim',text:t('bez telemetrie'),title:t('Na tomhle stroji neběží telemetrický agent, takže Home Hub neví, jestli je zapnutý.')};
  if(m.kind==='router'&&m.online==='offline'&&!m.quad&&!m.lastSeen)return {tone:'dim',text:t('stav neznámý'),title:''};
  if(m.online==='online')return {tone:'ok',text:'online',title:m.lastSeen?t('Naposledy {when}',{when:clock(m.lastSeen)}):''};
  if(m.online==='stale')return {tone:'warn',text:m.lastSeen?t('stará data · {when}',{when:clock(m.lastSeen)}):t('stará data'),title:''};
  if(m.online==='offline')return {tone:'bad',text:t('neodpovídá'),title:notOff};
  return {tone:'dim',text:t('stav neznámý'),title:''};
 }
 return {tone:'dim',text:t('bez telemetrie'),title:t('Na tomhle stroji neběží telemetrický agent, takže Home Hub neví, jestli je zapnutý.')};
}
export const statusPill=m=>{const s=statusOf(m);return el('span',{class:`hv-status ${s.tone}`,title:s.title||null},el('i',{'aria-hidden':'true'}),s.text);};

// Does this machine show live numbers (gauges, charts)? Only with readings, fresh or stale.
export const hasReadings=m=>m.kind==='thermo'&&(m.telemetry?['ok','stale'].includes(m.telemetry.state):Boolean(m.quad));

// How to get telemetry for a machine: an added device is connected in its edit dialog, a machine from the
// site configuration in the site's files.
export function installSteps(m,meta){
 const name=agentOf(meta);
 return [t('Nainstaluj na stroj telemetrického agenta {name}. Návod je v jeho repozitáři.',{name}),
  t('V {name} zapni přístup po síti (výchozí port 49286) a založ účet pro Home Hub: uživatele (třeba homehub) a heslo aspoň 12 znaků.',{name}),
  m.source==='site'?t('Stroj je z konfigurace webu: v local/site.json mu nastav thermoId a přihlášení přidej do souboru private/thermo-hosts.json. Pak Home Hub restartuj.')
   :t('Tady otevři Upravit zařízení → Telemetrie, ověř spojení, potvrď otisk certifikátu a ulož.')];
}

// What a tile shows instead of gauges. Short: the full story is on the machine's page.
export function tileNotice(m,meta){
 const tel=m.telemetry||{},name=agentOf(meta);
 const box=(tone,title,body)=>el('div',{class:`hv-tile-note ${tone}`},el('b',{},title),el('span',{},body));
 if(tel.state==='not-installed')return box('dim',t('Telemetrie není nainstalovaná'),t('Živá čísla dodá agent {name}. Postup je na stránce stroje.',{name}));
 if(tel.state==='not-applicable')return null;
 if(tel.reason==='no-login')return box('warn',t('Telemetrie není připojená'),t('Home Hub k ní nemá přihlášení. Postup je na stránce stroje.'));
 if(tel.reason==='denied')return box('warn',t('Přihlášení odmítnuto'),t('Zkontroluj účet pro Home Hub v {name}.',{name}));
 if(tel.state==='stale')return box('warn',t('Data jsou stará'),t('Poslední měření {when}. Stroj nemusí být vypnutý.',{when:clock(tel.lastSampleAt)}));
 return box('warn',t('Telemetrie neodpovídá'),t('Stroj nemusí být vypnutý: může spát, být mimo síť, nebo {name} neběží.',{name}));
}

// The full notice on a machine's page, or null when telemetry is fine. onConnect: opens the edit dialog
// at its telemetry part (offered only for a machine the signed-in account may edit).
export function telemetryNotice(m,meta,{onConnect}={}){
 const tel=m.telemetry||{},name=agentOf(meta);
 if(tel.state==='ok'||tel.state==='not-applicable'||(!tel.state&&m.kind!=='other'))return null;
 const connect=onConnect?el('div',{class:'ui-actions'},el('button',{type:'button',class:'ui-button primary',onclick:onConnect},t('Připojit telemetrii'))):null;
 if(tel.state==='not-installed'||!tel.state){
  const box=notInstalled({dependency:name,installUrl:meta?.repoUrl,title:t('Telemetrie tu není nainstalovaná'),steps:installSteps(m,meta),
   body:t('Živé CPU, GPU, paměť, příkon, teploty a disky dodává {name}: samostatný agent, který běží na stroji. Bez něj má stroj dlaždici s údaji a zbytek Home Hubu funguje dál.',{name})});
  if(connect)box.append(connect);return box;
 }
 const notice=(title,body,checks)=>el('section',{class:'hv-notice',role:'status'},el('h3',{},title),el('p',{},body),checks?.length?el('ul',{},checks.map(c=>el('li',{},c))):null,connect);
 // Old data with a known cause (no login, a refused login) gets that cause below; otherwise just since when.
 if(tel.state==='stale'&&tel.reason!=='no-login'&&tel.reason!=='denied')return el('section',{class:'hv-notice slim',role:'status'},el('h3',{},t('Data jsou stará')),
  el('p',{},t('Poslední měření přišlo {when}; grafy níže končí tam. Neúspěšné čtení neznamená, že je stroj vypnutý: může spát, být mimo síť, nebo {name} neběží.',{when:clock(tel.lastSampleAt),name})));
 if(tel.reason==='no-login')return notice(t('Home Hub nemá přihlášení k telemetrii tohoto stroje'),
  m.source==='site'?t('Stroj uvádí hostitele telemetrie „{id}“, ale v souboru private/thermo-hosts.json pro něj není účet. Doplň ho a Home Hub restartuj.',{id:tel.thermoId})
   :t('Stroj uvádí hostitele telemetrie „{id}“, ale Home Hub k němu nemá účet. Agent ho přes API zadat nemůže, protože hesla tudy nechodí: připoj ho tady.',{id:tel.thermoId}),installSteps(m,meta).slice(1));
 if(tel.reason==='denied')return notice(t('Telemetrie odmítla přihlášení'),t('{name} na tomto stroji odpovídá, ale účet Home Hubu nepřijal. Další pokus proběhne sám za 5 minut.',{name}),
  [t('V {name} zkontroluj uživatele a heslo účtu pro Home Hub.',{name}),m.source==='site'?t('Stejné údaje musí být v souboru private/thermo-hosts.json.'):t('Po změně hesla telemetrii tady odpoj a připoj znovu (Upravit zařízení → Telemetrie).')]);
 return notice(t('Telemetrie neodpovídá'),t('Home Hub se k {name} na tomto stroji zatím nedostal. To neznamená, že je stroj vypnutý.',{name}),
  [t('Stroj je vzhůru a v síti.'),t('{name} běží a má zapnutý přístup po síti.',{name}),t('Port 49286 je povolený ve firewallu stroje.')]);
}

// Local LLM runtimes on a machine (llama-swap, Ollama, LM Studio, llama.cpp, vLLM / SGLang, OpenAI-compatible).
// m.runtimes = what a home.runtimes provider reported, already bounded by the server; null = nobody reports yet.
const RUNTIME_STATE={running:['ok','běží'],stopped:['dim','zastaveno'],unknown:['dim','stav neznámý']};
function runtimeCard(r){
 const [tone,label]=RUNTIME_STATE[r.status]||RUNTIME_STATE.unknown;
 const loaded=r.models.filter(x=>x.state==='loaded'),rest=r.models.filter(x=>x.state!=='loaded');
 const model=x=>el('li',{class:x.state==='loaded'?'on':''},el('span',{},x.id),x.sizeGb!=null?el('small',{},`${x.sizeGb} GB`):null);
 return el('article',{class:'hv-runtime'},
  el('header',{},el('h4',{},r.name),el('span',{class:`hv-status ${tone}`},el('i',{'aria-hidden':'true'}),t(label))),
  el('p',{class:'hv-runtime-meta'},[r.kind,r.version,r.url].filter(Boolean).join(' · ')||' '),
  r.stats.length?el('dl',{class:'hv-runtime-stats'},r.stats.flatMap(x=>[el('dt',{},x.label),el('dd',{},x.value)])):null,
  r.models.length?el('ul',{class:'hv-runtime-models','aria-label':tp(r.models.length,'{n} model|{n} modely|{n} modelů')},[...loaded,...rest].map(model)):el('p',{class:'hv-runtime-none'},t('žádné modely')));
}
export function runtimesSection(m,meta){
 const name=agentOf(meta),data=m.runtimes;
 if(data?.runtimes?.length)return el('div',{class:'hv-runtimes'},data.runtimes.map(runtimeCard),
  data.observedAt||data.source?el('p',{class:'hv-source'},[data.source,data.observedAt?clock(data.observedAt):null].filter(Boolean).join(' · ')):null);
 return el('div',{class:'hv-placeholder',role:'status'},el('span',{class:'hv-tag'},t('potřebuje telemetrického agenta')),
  el('p',{},t('Co na stroji běží a které modely jsou načtené, sem doplní telemetrický agent {name}: llama-swap, Ollama, LM Studio, llama.cpp, vLLM a SGLang (metriky Prometheus) a servery kompatibilní s OpenAI.',{name})),
  meta?.repoUrl?el('a',{class:'ui-button small',href:meta.repoUrl,target:'_blank',rel:'noopener noreferrer'},t('Repozitář agenta {name}',{name})):null);
}
