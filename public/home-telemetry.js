// Telemetry on the overview: what a machine's state is called, and what the page shows when live numbers are
// missing. Live metrics come from a separate telemetry agent (Thermo) that is optional: the server names it
// and where to get it in /api/home → telemetry {agent, repoUrl, staleAfterSeconds} (server/thermo-client.mjs).
// Three cases are kept apart on purpose:
//   not installed   the machine names no telemetry host                    → how to install it
//   unreachable     a host is named, nothing was ever read from it         → what to check (and why)
//   stale           readings exist but the newest is older than 3 minutes  → when it was last seen
// A failed read says the agent did not answer. It never says the machine is off.
// A Windows machine has no agent: the hub reads it over SSH (telemetry.provider "windows"), normally with a
// connection it manages itself (telemetry.connection.mode "managed": host, port, user, its own key), else through
// an older SSH alias. Its notices name the SSH side instead, with the server's hint for the last failure
// (telemetry.hint, a source-language sentence), and its page adds what only Windows reports (nativePanel:
// per-core load, disk and network, GPUs). Nothing here assumes which system the hub runs on.
// Also here: the "local LLM runtimes" cards of a machine page. They show what a home.runtimes provider
// reported (docs/plugins.md). The telemetry agent does not report runtimes, and nothing here says it will:
// a machine no provider reports on has no such section.
import {el} from './views.js';
import {t,tp,locale} from './i18n.js';
import {timeZone} from './site.js';
import {notInstalled} from './ui.js';

const clock=iso=>{const ms=Date.parse(iso);if(!Number.isFinite(ms))return '';
 const sameDay=new Date(ms).toDateString()===new Date().toDateString();
 return new Intl.DateTimeFormat(locale(),{...(sameDay?{}:{day:'numeric',month:'numeric'}),hour:'2-digit',minute:'2-digit',timeZone:timeZone()}).format(new Date(ms));};
// The agent-less providers (server/telemetry-providers.mjs): their names and the system each reads.
export const FEED_NAMES=Object.freeze({windows:'Windows (SSH)',winrm:'Windows (WinRM)','node-exporter':'Linux (Node Exporter)',prometheus:'Linux (Prometheus)','linux-ssh':'Linux (SSH)'});
const FEED_FAMILY={windows:'windows',winrm:'windows','node-exporter':'linux',prometheus:'linux','linux-ssh':'linux'};
export const feedOf=m=>Object.hasOwn(FEED_NAMES,m?.telemetry?.provider)?m.telemetry.provider:null;
export const familyOf=m=>FEED_FAMILY[feedOf(m)]||null;
const agentOf=(meta,m)=>feedOf(m)?FEED_NAMES[feedOf(m)]:meta?.agent||'Thermo';
const viaWindows=m=>m?.telemetry?.provider==='windows';
const viaFeed=m=>Boolean(feedOf(m))&&!viaWindows(m);
const sshFeed=m=>['windows','linux-ssh'].includes(feedOf(m));

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
  if(tel.reason==='denied')return {tone:'warn',text:t('přihlášení odmítnuto'),title:viaWindows(m)?t(tel.hint||'SSH přihlášení odmítnuto.'):feedOf(m)&&tel.hint?t(tel.hint):t('Telemetrie odmítla přihlášení Home Hubu.')};
  if(sshFeed(m)&&/^host-key/.test(tel.detail||''))return {tone:'warn',text:t('klíč hostitele neověřen'),title:t(tel.hint||'')};
  if(feedOf(m)&&/^tls-/.test(tel.detail||''))return {tone:'warn',text:t('certifikát neověřen'),title:t(tel.hint||'')};
  return {tone:'warn',text:t('telemetrie neodpovídá'),title:feedOf(m)&&tel.hint?`${t(tel.hint)} ${notOff}`:notOff};
 }
 if(m.kind==='nas'||m.kind==='router'){
  // No feed at all (no service probes for the NAS, no router adapter data) is "nothing to judge", not a failure.
  if(m.kind==='nas'&&m.online==='unknown'&&tel.state==='not-installed')return {tone:'dim',text:t('bez telemetrie'),title:t('Home Hub z tohoto stroje telemetrii nečte, takže neví, jestli je zapnutý.')};
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
// site configuration on its own page (Telemetry settings: only the connection is stored, its identity stays in
// site.json), unless the site reads it through Thermo, which is set in the site's files.
// A machine whose system is not said is told every way there is, never that only the agent would do.
const siteEditable=m=>m.source==='site'&&m.telemetryEditable===true;
export function installSteps(m,meta){
 const where=siteEditable(m)?t('Tady otevři Nastavení telemetrie: identita stroje zůstane v konfiguraci webu, uloží se jen spojení. Dialog ukáže návod, vyzkoušíš spojení a uložíš.')
  :m.source==='site'?t('Stroj je z konfigurace webu a čte se přes Thermo: telemetrii mu nastavuje konfigurace webu (thermoId v local/site.json a účet v private/thermo-hosts.json).')
  :null;
 if(m.platform==='linux')return [t('Linux nepotřebuje agenta od Home Hubu. Doporučený zdroj je Prometheus Node Exporter (čte se přímo jeho /metrics); jde i Prometheus, který už máš, nebo SSH s pevným skriptem, který jen čte /proc.'),
  where||t('Tady otevři Upravit zařízení → Telemetrie a vyber zdroj pro Linux. Dialog ukáže návod, vyzkoušíš spojení a uložíš.')];
 if(m.platform==='windows')return [t('Windows nepotřebuje agenta: Home Hub ho čte přes SSH vlastním klíčem a skriptem PowerShellu, který jen čte. Klíč vytvoří Home Hub sám; na Windows stačí OpenSSH Server a jeden příkaz, který klíč povolí.'),
  where||t('Tady otevři Upravit zařízení → Telemetrie → Windows (SSH). Dialog ukáže celý postup, vyzkoušíš spojení a uložíš.')];
 if(!m.platform&&(siteEditable(m)||m.source!=='site'))return [t('Zdroj vyber podle systému stroje. Linux (třeba NAS) bez agenta: Prometheus Node Exporter, Prometheus, který už máš, nebo SSH s pevným skriptem. Windows bez agenta: SSH nebo WinRM. macOS: agent Thermo.'),
  where||t('Tady otevři Upravit zařízení → Telemetrie, zvol systém a zdroj. Dialog ukáže návod, vyzkoušíš spojení a uložíš.')];
 const name=agentOf(meta);
 return [t('Nainstaluj na stroj telemetrického agenta {name}. Návod je v jeho repozitáři.',{name}),
  t('V {name} zapni přístup po síti (výchozí port 49286) a založ účet pro Home Hub: uživatele (třeba homehub) a heslo aspoň 12 znaků.',{name}),
  m.source==='site'?t('Stroj je z konfigurace webu: v local/site.json mu nastav thermoId a přihlášení přidej do souboru private/thermo-hosts.json. Pak Home Hub restartuj.')
   :t('Tady otevři Upravit zařízení → Telemetrie, ověř spojení, potvrď otisk certifikátu a ulož.')];
}
// The not-installed notices name the agent only for a Mac (or a machine the site reads through Thermo).
const unknownSystem=m=>!m.platform&&(siteEditable(m)||m.source!=='site');

// What a tile shows instead of gauges. Short: the full story is on the machine's page.
export function tileNotice(m,meta){
 const tel=m.telemetry||{},name=agentOf(meta,m);
 const box=(tone,title,body)=>el('div',{class:`hv-tile-note ${tone}`},el('b',{},title),el('span',{},body));
 if(tel.state==='not-installed')return box('dim',t('Telemetrie není nainstalovaná'),m.platform==='windows'?t('Windows jde číst přes SSH bez agenta. Postup je na stránce stroje.'):m.platform==='linux'?t('Linux jde číst přes Node Exporter, Prometheus nebo SSH. Postup je na stránce stroje.')
  :unknownSystem(m)?t('Linux a Windows jdou číst bez agenta, Mac přes Thermo. Postup je na stránce stroje.'):t('Živá čísla dodá agent {name}. Postup je na stránce stroje.',{name}));
 if(tel.state==='not-applicable')return null;
 if(tel.reason==='no-login')return box('warn',t('Telemetrie není připojená'),t('Home Hub k ní nemá přihlášení. Postup je na stránce stroje.'));
 if(tel.reason==='denied')return box('warn',t('Přihlášení odmítnuto'),viaWindows(m)?t('Windows nepřijal SSH klíč Home Hubu. Postup je na stránce stroje.'):feedOf(m)?t('{name} nepřijal přihlášení Home Hubu. Postup je na stránce stroje.',{name}):t('Zkontroluj účet pro Home Hub v {name}.',{name}));
 if(viaFeed(m)&&tel.state!=='stale')return box('warn',/^host-key/.test(tel.detail||'')?t('Klíč hostitele neověřen'):/^tls-/.test(tel.detail||'')?t('Certifikát neověřen'):t('Telemetrie neodpovídá'),t('Stroj nemusí být vypnutý: může spát, být mimo síť, nebo zdroj {name} neodpovídá.',{name}));
 if(viaWindows(m)&&tel.state!=='stale')return box('warn',/^host-key/.test(tel.detail||'')?t('Klíč hostitele neověřen'):t('Telemetrie neodpovídá'),t('Stroj nemusí být vypnutý: může spát, být mimo síť, nebo na něm neběží SSH.'));
 if(tel.state==='stale')return box('warn',t('Data jsou stará'),t('Poslední měření {when}. Stroj nemusí být vypnutý.',{when:clock(tel.lastSampleAt)}));
 return box('warn',t('Telemetrie neodpovídá'),t('Stroj nemusí být vypnutý: může spát, být mimo síť, nebo {name} neběží.',{name}));
}

// The full notice on a machine's page, or null when telemetry is fine. onConnect: opens the edit dialog
// at its telemetry part (offered only for a machine the signed-in account may edit).
export function telemetryNotice(m,meta,{onConnect}={}){
 const tel=m.telemetry||{},name=agentOf(meta,m);
 if(tel.state==='ok'||tel.state==='not-applicable'||(!tel.state&&m.kind!=='other'))return null;
 const connect=onConnect?el('div',{class:'ui-actions'},el('button',{type:'button',class:'ui-button primary',onclick:onConnect},t('Připojit telemetrii'))):null;
 if(tel.state==='not-installed'||!tel.state){
  const box=m.platform==='linux'
   ?notInstalled({dependency:'Node Exporter',installUrl:'https://github.com/prometheus/node_exporter',title:t('Telemetrie tu není připojená'),steps:installSteps(m,meta),
    body:t('CPU a jádra, paměť, svazky, disky, síť a teploty (když je stroj hlásí) čte Home Hub z Linuxu přes Node Exporter, Prometheus nebo SSH. GPU a příkon tyhle zdroje neměří. Bez připojení má stroj dlaždici s údaji a zbytek Home Hubu funguje dál.')})
   :m.platform==='windows'
   ?notInstalled({dependency:'OpenSSH',title:t('Telemetrie tu není připojená'),steps:installSteps(m,meta),
    body:t('CPU a jádra, GPU, paměť, disky a síť čte Home Hub z Windows sám, přes SSH. Teploty, ventilátory a příkon Windows nehlásí. Bez připojení má stroj dlaždici s údaji a zbytek Home Hubu funguje dál.')})
   :unknownSystem(m)
   ?notInstalled({dependency:t('zdroj telemetrie'),title:t('Telemetrie tu není připojená'),steps:installSteps(m,meta),
    body:t('Živá čísla čte Home Hub podle systému stroje: Linux přes Node Exporter, Prometheus nebo SSH, Windows přes SSH nebo WinRM, obojí bez agenta; Mac přes agenta Thermo. Bez připojení má stroj dlaždici s údaji a zbytek Home Hubu funguje dál.')})
   :notInstalled({dependency:name,installUrl:meta?.repoUrl,title:t('Telemetrie tu není nainstalovaná'),steps:installSteps(m,meta),
   body:t('Živé CPU, GPU, paměť, příkon, teploty a disky dodává {name}: samostatný agent, který běží na stroji. Bez něj má stroj dlaždici s údaji a zbytek Home Hubu funguje dál.',{name})});
  if(connect)box.append(connect);return box;
 }
 const notice=(title,body,checks)=>el('section',{class:'hv-notice',role:'status'},el('h3',{},title),el('p',{},body),checks?.length?el('ul',{},checks.map(c=>el('li',{},c))):null,connect);
 // Windows: the SSH collector's last failure says what to do (tel.hint); old data says since when.
 if(viaWindows(m)){
  const target=tel.target||'?',conn=tel.connection;
  const checks=[t('Stroj je vzhůru a v síti.'),conn?.mode==='managed'?t('Na Windows běží služba OpenSSH Server (sshd) a firewall pouští port {port}.',{port:conn.port}):t('Na Windows běží služba OpenSSH Server (sshd) a firewall pouští port 22.'),
   conn?.mode==='managed'?t('Na Windows proběhl příkaz, který povolí klíč Home Hubu pro účet {user} (krok 3 v nastavení spojení).',{user:conn.user})
    :t('Starší spojení přes alias: účet, pod kterým běží Home Hub, se přes ssh {target} dostane dovnitř bez hesla a bez otázek. Převeď ho na spojení, které spravuje Home Hub: Upravit zařízení → Telemetrie → Změnit.',{target})];
  if(tel.state==='stale')return el('section',{class:'hv-notice slim',role:'status'},el('h3',{},t('Data jsou stará')),
   el('p',{},[t('Poslední měření přišlo {when}; grafy níže končí tam.',{when:clock(tel.lastSampleAt)}),tel.hint?t(tel.hint):t('Neúspěšné čtení neznamená, že je stroj vypnutý.')].join(' ')));
  if(tel.reason==='no-login')return notice(t('Home Hub nemá spojení SSH tohoto stroje'),t('Připoj ho znovu: Upravit zařízení → Telemetrie → Windows (SSH).'),[]);
  return notice(/^host-key/.test(tel.detail||'')?t('Klíč hostitele Windows není ověřený'):tel.reason==='denied'?t('Windows odmítl SSH přihlášení'):t('Windows přes SSH neodpovídá'),
   tel.hint?t(tel.hint):t('Home Hub se k tomuhle stroji přes SSH zatím nedostal. To neznamená, že je stroj vypnutý.'),checks);
 }
 // WinRM, Node Exporter, Prometheus, Linux SSH: the provider's last failure says what to do (tel.hint).
 if(viaFeed(m)){
  if(tel.state==='stale')return el('section',{class:'hv-notice slim',role:'status'},el('h3',{},t('Data jsou stará')),
   el('p',{},[t('Poslední měření přišlo {when}; grafy níže končí tam.',{when:clock(tel.lastSampleAt)}),tel.hint?t(tel.hint):t('Neúspěšné čtení neznamená, že je stroj vypnutý.')].join(' ')));
  if(tel.reason==='no-login')return notice(t('Home Hub nemá spojení {name} tohoto stroje',{name}),t('Připoj ho znovu: Upravit zařízení → Telemetrie.'),[]);
  const c=tel.connection||{};
  const checks=[t('Stroj je vzhůru a v síti.'),c.host?t('Server s Home Hubem dosáhne na {host}:{port} (firewall, port).',{host:c.host,port:c.port}):null,
   feedOf(m)==='prometheus'&&c.job?t('Prometheus sbírá cíl job {job}, instance {instance}.',{job:c.job,instance:c.instance}):null].filter(Boolean);
  return notice(/^host-key/.test(tel.detail||'')?t('Klíč hostitele není ověřený'):/^tls-/.test(tel.detail||'')?t('Certifikát se změnil nebo není ověřený'):tel.reason==='denied'?t('{name} odmítl přihlášení',{name}):t('{name} neodpovídá',{name}),
   tel.hint?t(tel.hint):t('Home Hub se k tomuhle zdroji zatím nedostal. To neznamená, že je stroj vypnutý.'),checks);
 }
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

// Local LLM runtimes on a machine, one compact card per runtime: name and state, what it is, a figure or two,
// the loaded models, and the rest of its models folded away. m.runtimes = what a home.runtimes provider
// reported, already bounded by the server. Labels of the figures are the provider's (its own strings).
const RUNTIME_STATE={running:['ok','běží'],stopped:['dim','zastaveno'],unknown:['dim','stav neznámý']};
// A command-line tool (mode cli, mflux) is no server: it works while a job runs, else it has nothing to do.
const CLI_STATE={running:['ok','pracuje'],stopped:['dim','nic neběží'],unknown:['dim','stav neznámý']};
const minutes=iso=>{const s=(Date.now()-Date.parse(iso))/1000;return Number.isFinite(s)&&s>=0?s<60?t('{n} s',{n:Math.round(s)}):s<5400?t('{n} min',{n:Math.round(s/60)}):t('{n} h',{n:Math.round(s/360)/10}):null;};
// How busy a model is, in a few words: running (since when) and waiting.
const busyFacts=x=>{const time=x.since?minutes(x.since):null;return [x.active?time?x.active>1?t('generuje ×{n}, nejdéle {time}',{n:x.active,time}):t('generuje {time}',{time})
 :x.active>1?t('generuje ×{n}',{n:x.active}):t('generuje'):null,
 x.queued?tp(x.queued,'{n} ve frontě|{n} ve frontě|{n} ve frontě'):null].filter(Boolean);};
// A runtime listens on its own machine: ":8081" says more than a loopback address.
const listen=url=>{try{const u=new URL(url);return ['127.0.0.1','localhost','[::1]'].includes(u.hostname)?`:${u.port||(u.protocol==='https:'?443:80)}`:u.host;}catch{return '';}};
const kilo=n=>n>=1e6?`${Math.round(n/1e5)/10}M`:n>=1e3?`${Math.round(n/1e3)}k`:String(n);
function modelRow(x){
 const held=x.state==='loaded',busy=busyFacts(x);
 const facts=[...busy,x.sizeGb!=null?`${x.sizeGb} GB`:null,x.contextTokens?t('kontext {n}',{n:kilo(x.contextTokens)}):null,
  held&&!x.active&&x.ttlRemainingSeconds!=null?t('uvolní se za {min} min',{min:Math.max(1,Math.round(x.ttlRemainingSeconds/60))}):null,x.state==='loading'?t('načítá se'):null].filter(Boolean);
 return el('li',{class:x.active?'on gen':held?'on':x.state==='loading'||x.queued?'busy':''},el('span',{},x.id),facts.length?el('small',{},facts.join(' · ')):null);
}
function runtimeCard(r,open){
 const cli=r.mode==='cli',[tone,label]=(cli?CLI_STATE:RUNTIME_STATE)[r.status]||RUNTIME_STATE.unknown;
 const held=r.models.filter(x=>x.state==='loaded'||x.state==='loading'||x.active||x.queued),rest=r.models.filter(x=>!held.includes(x));
 // Only a runtime that answers can be said to hold nothing. A tool's models are those its jobs use.
 const heading=cli?held.length?tp(held.length,'{n} model v práci|{n} modely v práci|{n} modelů v práci'):t('žádná úloha neběží')
  :held.length?tp(held.length,'{n} načtený model|{n} načtené modely|{n} načtených modelů'):r.status==='running'&&r.models.length?t('žádný model není načtený'):r.models.length?t('Modely'):t('žádné modely');
 const busy=r.activity?busyFacts(r.activity):[];
 return el('article',{class:`hv-runtime${r.activity?.active?' gen':''}`},
  el('header',{},el('h3',{},r.name),el('span',{class:'hv-runtime-flags'},busy.length?el('span',{class:`hv-work-chip${r.activity.active?' on':''}`},busy.join(' · ')):null,
   el('span',{class:`hv-status ${tone}`},el('i',{'aria-hidden':'true'}),t(label)))),
  el('p',{class:'hv-runtime-meta'},[r.kind&&r.kind.toLowerCase()!==String(r.name).toLowerCase()?r.kind:null,r.version,r.url?listen(r.url):null].filter(Boolean).join(' · ')||' '),
  r.stats.length?el('dl',{class:'hv-runtime-stats'},r.stats.map((x,i)=>el('div',{class:i?'':'main'},el('dt',{},t(x.label)),el('dd',{},x.value)))):null,
  el('div',{class:'hv-runtime-list'},el('span',{class:'hv-k'},heading),
   held.length?el('ul',{class:'hv-runtime-models'},held.map(modelRow)):null,
   rest.length?el('details',{'data-id':r.id,open:open?'':null},el('summary',{},held.length?tp(rest.length,'{n} další model|{n} další modely|{n} dalších modelů'):tp(rest.length,'{n} model|{n} modely|{n} modelů')),
    el('ul',{class:'hv-runtime-models'},rest.map(modelRow))):null));
}
// What the GPU does right now, above the cards: its reading (m.quad.gpu, the telemetry agent's last seconds)
// and the models whose runtimes say they run a request or a job, or wait for one (m.work, server/home-data.mjs
// → workFor). Only what is watched can be named; the note says which runtimes cannot tell.
const KIND_LABEL={llm:'LLM',embedding:'embedding',image:'obrázky · difúze',video:'video · difúze',music:'hudba',audio:'zvuk',other:'jiný model'};
const GPU_BUSY=15;// per cent; an idle Mac's desktop alone keeps the GPU at a few
// The three busiest GPU processes (m.gpuProcesses, the agent's snapshot), always: their GPU time and a bar each, and
// the runtime or job a process belongs to when its id says so. That figure is time in the GPU's queues (100 % = one
// GPU-second per second, an estimate of the driver's), not a share of the GPU load in the header: the two come from
// different counters, queues overlap, and the rows can add up to more than the load. The labels say so.
const pct=v=>v>=10?String(Math.round(v)):String(Math.round(v*10)/10);
function processList(g,meta){
 const rows=(g?.rows||[]).filter(p=>p.percent!=null).slice(0,3);if(!rows.length)return null;
 return el('div',{class:'hv-work-procs'},el('span',{class:'hv-k'},t('Čas na GPU podle procesů')),
  el('ol',{},rows.map(p=>{const bar=el('i',{'aria-hidden':'true'});bar.style.width=`${Math.max(2,Math.min(100,p.percent))}%`;
   return el('li',{},el('b',{},p.name),el('small',{},p.model?t('{model} · {runtime}',{model:p.model,runtime:p.runtime}):p.runtime||t('mimo sledované runtimy')),
    el('span',{class:'hv-work-pct'},`${pct(p.percent)} %`),el('span',{class:'hv-work-bar'},bar));})),
  g.observedAt?el('p',{class:'hv-work-note'},t('Podle {agent}: čas ve frontách GPU za posledních 5 s, odhad. Není to podíl z vytížení GPU nahoře a součet může být vyšší. Čteno {when}.',{agent:meta?.agent||'Thermo',when:clock(g.observedAt)})):null);
}
export function workPanel(m,meta){
 const w=m.work;if(!w)return null;
 const gpu=Number.isFinite(m.quad?.gpu)?Math.round(m.quad.gpu):null,running=w.items.filter(x=>x.active),waiting=w.items.filter(x=>!x.active&&x.queued);
 const hot=gpu!=null&&gpu>=GPU_BUSY,tone=running.length?'gen':hot?'warn':'idle',procs=processList(m.gpuProcesses,meta);
 const title=running.length?t('GPU generuje'):hot?t('GPU pracuje, ale nic sledovaného negeneruje'):waiting.length?t('Nic negeneruje, úlohy čekají'):t('GPU je v klidu');
 const lead=running.length?null:hot?(procs?t('Žádný sledovaný runtime ani nástroj teď nic negeneruje. GPU vytěžují procesy níže.')
   :t('Žádný sledovaný runtime ani nástroj teď nic negeneruje. GPU vytěžuje něco jiného (hra, render, jiný program), nebo runtime, který neříká, co dělá.'))
  :waiting.length?null:t('Žádný model teď nic negeneruje.');
 const where=x=>x.gateways?.length?t('{runtime} přes {gateways}',{runtime:x.runtimeName,gateways:x.gateways.join(', ')}):x.runtimeName;
 const row=x=>el('li',{class:x.active?'on':'wait'},el('i',{'aria-hidden':'true'}),
  el('div',{},el('b',{},x.name||x.id),el('small',{},[t(KIND_LABEL[x.kind]||KIND_LABEL.other),where(x),...busyFacts(x)].filter(Boolean).join(' · '))));
 const note=[w.watching.length?t('Co se generuje, hlásí: {list}.',{list:w.watching.join(', ')}):null,w.blind.length?t('Neříká, jestli zrovna generuje: {list}.',{list:w.blind.join(', ')}):null].filter(Boolean).join(' ');
 return el('section',{class:`hv-work ${tone}`,'aria-label':t('Co teď dělá GPU')},
  el('header',{},el('h3',{},el('i',{'aria-hidden':'true'}),title),gpu!=null?el('span',{class:'hv-work-gpu'},t('Vytížení GPU {pct} %',{pct:gpu})):null),
  lead?el('p',{class:'hv-note'},lead):null,
  w.items.length?el('ul',{},w.items.map(row)):null,
  note?el('p',{class:'hv-work-note'},note):null,procs);
}
// open: ids of the runtimes whose folded model list is open (kept across a refresh).
export function runtimesSection(m,meta,{open=[]}={}){
 const data=m.runtimes;if(!data)return null;
 const old=data.observedAt&&Date.now()-Date.parse(data.observedAt)>(meta?.staleAfterSeconds||180)*1000;
 const source=[(data.sources?.length?data.sources:[data.source]).filter(Boolean).map(x=>t(x)).join(' + ')||null,data.observedAt?(old?t('stará data · naposledy {when}',{when:clock(data.observedAt)}):t('čteno {when}',{when:clock(data.observedAt)})):null].filter(Boolean).join(' · ');
 return el('div',{class:'hv-runtimes'},workPanel(m,meta),
  data.runtimes.length?data.runtimes.map(r=>runtimeCard(r,open.includes(r.id))):el('p',{class:'hv-note'},t('Poskytovatel teď na tomhle stroji žádný runtime nehlásí.')),
  source?el('p',{class:`hv-source${old?' warn':''}`},source):null);
}

// What only Windows telemetry reports, on the machine page: the system, per-core load, disk and network
// rates and each GPU, averaged over the last poll interval (native.span). Sensors are said to be missing,
// never shown as 0. m.native = /api/home → machines[].native.
const rate=v=>v==null?'–':v>=1e9?`${Math.round(v/1e8)/10} GB/s`:v>=1e6?`${Math.round(v/1e5)/10} MB/s`:v>=1e3?`${Math.round(v/1e3)} kB/s`:`${Math.round(v)} B/s`;
const days=s=>s==null?'–':s>=86400?tp(Math.floor(s/86400),'{n} den|{n} dny|{n} dní'):tp(Math.max(1,Math.floor(s/3600)),'{n} hodina|{n} hodiny|{n} hodin');
export function nativePanel(m){
 const n=m.native;if(!n||!feedOf(m))return null;
 if(familyOf(m)==='linux')return linuxPanel(m,n);
 const cell=(k,v)=>el('div',{},el('span',{class:'hv-k'},k),el('b',{},v??'–'));
 const cores=Array.isArray(n.cpu?.cores)?n.cpu.cores:[];
 const bars=cores.length?el('div',{class:'hv-cores',role:'img','aria-label':t('Vytížení jader: {list}',{list:cores.map(v=>v==null?'–':Math.round(v)).join(', ')})},
  cores.map((v,i)=>{const bar=el('i',{class:v==null?'none':'',title:`${i}: ${v==null?'–':Math.round(v)+' %'}`});bar.style.height=`${Math.max(4,Math.min(100,v??0))}%`;return bar;})):null;
 const gpus=(n.gpus||[]).map((g,i)=>cell(g.name||`GPU ${i+1}`,[g.util!=null?`${Math.round(g.util)} %`:'–',g.engine?g.engine:null,g.memUsed!=null?`${Math.round(g.memUsed/1073741824*10)/10}${g.memTotal?' / '+Math.round(g.memTotal/1073741824):''} GB VRAM`:null].filter(Boolean).join(' · ')));
 return el('div',{class:'hv-native'},
  el('span',{class:'hv-k'},feedOf(m)==='winrm'?t('Windows (WinRM)'):t('Windows')),
  el('p',{class:'hv-note'},t('Automatické čtení probíhá po 30 s nebo pomaleji. CPU, GPU a přenosové rychlosti jsou průměry mezi čteními; krátké špičky nejsou zachyceny.')),
  el('div',{class:'hv-native-cells'},
   cell(t('Systém'),[n.os?.caption,n.os?.version].filter(Boolean).join(' · ')||null),cell(t('Běží'),days(n.os?.uptimeSeconds)),
   cell('CPU',n.cpu?.name?`${n.cpu.name}${n.cpu.logical?` · ${n.cpu.logical}×`:''}`:null),
   cell(t('Disk čtení / zápis'),`${rate(n.disk?.readBps)} / ${rate(n.disk?.writeBps)}`),cell(t('Síť přijato / odesláno'),`${rate(n.net?.rxBps)} / ${rate(n.net?.txBps)}`),
   ...gpus,cell(t('Senzory'),t('teploty, ventilátory a příkon Windows nehlásí'))),
  bars?el('span',{class:'hv-k'},n.span?t('Jádra · průměr za {s} s',{s:Math.round(n.span)}):t('Jádra')):null,bars,
  !n.gpuCounters?el('p',{class:'hv-note'},t('Windows nevrací čítače GPU (starší ovladač, nebo účtu chybí skupina Performance Monitor Users).')):null);
}

// What only the Linux sources report, on the machine page: system and kernel, load, per-core load, disk and network
// rates and the temperatures the machine reports. GPU and power are said not to be measured, never shown as 0.
function linuxPanel(m,n){
 const cell=(k,v)=>el('div',{},el('span',{class:'hv-k'},k),el('b',{},v??'–'));
 const cores=Array.isArray(n.cpu?.cores)?n.cpu.cores:[];
 const bars=cores.length?el('div',{class:'hv-cores',role:'img','aria-label':t('Vytížení jader: {list}',{list:cores.map(v=>v==null?'–':Math.round(v)).join(', ')})},
  cores.map((v,i)=>{const bar=el('i',{class:v==null?'none':'',title:`${i}: ${v==null?'–':Math.round(v)+' %'}`});bar.style.height=`${Math.max(4,Math.min(100,v??0))}%`;return bar;})):null;
 const temps=(n.temps||[]).slice(0,8).map(x=>cell(`${x.chip||''} ${x.label||''}`.trim()||t('Teplota'),x.c!=null?`${Math.round(x.c)} °C`:'–'));
 return el('div',{class:'hv-native'},
  el('span',{class:'hv-k'},t(FEED_NAMES[feedOf(m)])),
  el('p',{class:'hv-note'},feedOf(m)==='prometheus'?t('Hodnoty jsou ze vzorků, které Prometheus sesbíral; CPU, disky a síť jsou průměry mezi dvěma sběry. Nový sběr, který Prometheus ještě neudělal, se nepočítá.')
   :t('Automatické čtení probíhá po 30 s nebo pomaleji. CPU a přenosové rychlosti jsou průměry mezi čteními; krátké špičky nejsou zachyceny.')),
  el('div',{class:'hv-native-cells'},
   cell(t('Systém'),[n.os?.caption,n.os?.version,n.os?.arch].filter(Boolean).join(' · ')||null),cell(t('Běží'),days(n.os?.uptimeSeconds)),
   cell('CPU',[n.cpu?.name,n.cpu?.logical?`${n.cpu.logical}×`:null].filter(Boolean).join(' · ')||null),
   cell(t('Zátěž 1 / 5 / 15 min'),Array.isArray(n.load)?n.load.map(v=>Math.round(v*100)/100).join(' / '):null),
   cell(t('Disk čtení / zápis'),`${rate(n.disk?.readBps)} / ${rate(n.disk?.writeBps)}`),cell(t('Síť přijato / odesláno'),`${rate(n.net?.rxBps)} / ${rate(n.net?.txBps)}`),
   ...temps,cell(t('GPU a příkon'),t('tenhle zdroj je neměří')),...(temps.length?[]:[cell(t('Senzory'),t('stroj teploty nehlásí'))])),
  bars?el('span',{class:'hv-k'},n.span?t('Jádra · průměr za {s} s',{s:Math.round(n.span)}):t('Jádra')):null,bars);
}
