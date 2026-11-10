// The router panel on the router's machine page (GET /api/router): the client census and the router's
// health from whatever adapter this hub uses (server/router-data.mjs). It says so when no adapter is
// configured, when one is configured but has not reported yet, and when its last observation is stale
// or failed; a failed read is never shown as "no clients".
import {el} from './views.js';
import {authGuard} from './session-cache.js';
import {t} from './i18n.js';
import {emptyState,notInstalled} from './ui.js';
import {badge,when,ago,fill} from './systems-view.js';

const stat=(k,v,sub,tone='')=>el('div',{class:`col-stat ${tone}`},el('div',{class:'k'},k),el('div',{class:'v'},String(v)),el('div',{class:'s',title:sub},sub));
const cell=(label,...children)=>el('td',{'data-label':label},...children);
// A DHCP lease is not proof that a device is connected, so each presence says what was actually seen.
const PRESENCE={associated:['připojeno k Wi-Fi','good'],reachable:['dosažitelné','good'],'lease-only':['jen zápůjčka DHCP',''],'cache-only':['jen v mezipaměti','']};
const CONNECTION={Ethernet:'Kabel',Unknown:'Neznámé'};
const steps=()=>[
 t('V local/site.json nastav router: adapter „unifi“ a host (adresa brány). Sítě se berou z lanCidrs.'),
 t('V UniFi Network vytvoř API klíč jen pro čtení a ulož ho do {file} (práva 0600).',{file:'router-private/unifi-api-key'}),
 t('Připni certifikát brány: {command}',{command:'python3 scripts/collect-router-unifi.py --pin'}),
 t('Ověř sběr: {command}',{command:'python3 scripts/collect-router-unifi.py --check'}),
 t('Spouštěj sběr každou minutu (cron, launchd nebo systemd timer). Posílá jen požadavky GET a na routeru nic nemění.')];

function setupState(doc){
 if(doc.state==='not-configured')return notInstalled({title:t('Router není nastavený'),
  body:t('Přehled klientů v síti a stav routeru dodává adaptér routeru. Součástí je adaptér pro UniFi; jiný router připojí plugin. Bez něj zbytek Home Hubu funguje dál.'),steps:steps()});
 const adapter=doc.adapter?.title||doc.adapter?.id||'?';
 return emptyState({icon:'◔',title:t('Adaptér routeru je nastavený, ale ještě nic nenahlásil'),
  body:doc.error==='unknown-adapter'?t('Adaptér „{adapter}“ tahle instalace nezná: vestavěný je „unifi“, jiný musí dodat plugin.',{adapter})
   :t('Adaptér {adapter} zatím nezapsal žádné pozorování.',{adapter}),steps:doc.error==='unknown-adapter'?[]:steps().slice(1)});
}
function banner(doc){
 const age=Number.isFinite(Date.parse(doc.observedAt))?Math.max(0,(Date.now()-Date.parse(doc.observedAt))/1000):null;
 const seen=doc.observedAt?`${when(doc.observedAt)} (${ago(age)})`:t('zatím nikdy');
 if(doc.state==='unavailable')return el('div',{class:'col-banner bad',role:'alert'},badge(t('čtení selhalo'),'bad solid'),
  el('span',{},t('Poslední pokus o čtení routeru selhal ({error}). Níže je poslední známý stav z {when}.',{error:doc.error||'?',when:seen})));
 if(doc.state==='stale')return el('div',{class:'col-banner warn',role:'alert'},badge(t('starý snímek'),'warn'),
  el('span',{},t('Poslední pozorování je z {when}. Adaptér má hlásit nejpozději každé {n} min.',{when:seen,n:Math.round((doc.staleAfterSeconds||180)/60)})));
 return el('div',{class:'col-banner',role:'status'},badge(t('čerstvé'),'good'),el('span',{},el('b',{},doc.adapter?.title||''),' · ',seen));
}
function census(doc){
 if(!doc.devices.length)return el('p',{class:'col-empty'},t('Router teď nehlásí žádného klienta v nastavených sítích.'));
 const rows=[...doc.devices].sort((a,b)=>a.ip.localeCompare(b.ip,undefined,{numeric:true})).map(d=>{const [label,tone]=PRESENCE[d.presence]||[d.presence,''];
  return el('tr',{},cell(t('Název'),el('span',{class:'col-name'},d.name||t('bez názvu'))),cell('IP',el('span',{class:'col-mono'},d.ip)),cell('MAC',el('span',{class:'col-mono col-dim'},d.mac)),
   cell(t('Připojení'),CONNECTION[d.connection]?t(CONNECTION[d.connection]):d.connection),cell(t('Stav'),badge(t(label),tone)));});
 return el('div',{class:'col-scroll'},el('table',{class:'col-table col-pairs'},
  el('thead',{},el('tr',{},el('th',{scope:'col'},t('Název')),el('th',{scope:'col'},'IP'),el('th',{scope:'col'},'MAC'),el('th',{scope:'col'},t('Připojení')),el('th',{scope:'col'},t('Stav')))),el('tbody',{},rows)));
}
function hardware(doc){
 const list=doc.health?.hardware||[];if(!list.length)return null;
 return el('section',{class:'col-card','aria-label':t('Síťové prvky')},el('header',{},el('h3',{},t('Síťové prvky')),el('span',{class:'meta'},[doc.model,doc.firmware&&t('firmware {version}',{version:doc.firmware})].filter(Boolean).join(' · '))),
  el('div',{class:'col-scroll'},el('table',{class:'col-table col-pairs'},el('thead',{},el('tr',{},el('th',{scope:'col'},t('Název')),el('th',{scope:'col'},'Model'),el('th',{scope:'col'},t('Stav')),el('th',{scope:'col'},'Firmware'),el('th',{scope:'col'},'IP'))),
   el('tbody',{},list.map(h=>el('tr',{class:h.state==='ONLINE'||h.state==='UNKNOWN'?'':'bad'},cell(t('Název'),el('span',{class:'col-name'},h.name||'—')),cell('Model',h.model||'—'),
    cell(t('Stav'),badge(h.state==='ONLINE'?t('online'):h.state==='UNKNOWN'?t('neověřeno'):h.state.toLowerCase(),h.state==='ONLINE'?'good':h.state==='UNKNOWN'?'':'bad solid')),
    cell('Firmware',el('span',{class:'col-mono'},h.firmware||'—')),cell('IP',el('span',{class:'col-mono'},h.ip||'—'))))))));
}
function render(box,doc,reload){
 const title=el('h3',{class:'col-router-title'},t('Klienti a stav routeru'));
 if(doc.state==='not-configured'||doc.state==='waiting'){fill(box,title,setupState(doc));return;}
 const c=doc.health?.clients||{},down=doc.health?.hardwareDown||0;
 fill(box,el('div',{class:'col-toolbar'},title,el('button',{type:'button',class:'ui-button small',onclick:reload},t('Obnovit'))),banner(doc),
  el('div',{class:'col-stats'},
   stat(t('Klienti'),doc.devices.length,c.known!=null?t('{n} známých za 90 dní',{n:c.known}):t('právě připojení'),''),
   stat('Wi-Fi',c.wireless??'—',t('bezdrátově'),''),stat(t('Kabel'),c.wired??'—',t('po kabelu'),''),
   stat(t('Síťové prvky'),doc.health?.hardware?.length||0,down?t('{n} mimo provoz',{n:down}):t('všechny online'),down?'bad':''),
   stat(t('Software'),doc.health?.softwareVersion||'—',doc.firmware?t('firmware {version}',{version:doc.firmware}):'—','')),
  hardware(doc),
  el('section',{class:'col-card','aria-label':t('Klienti v síti')},el('header',{},el('h3',{},t('Klienti v síti')),el('span',{class:'meta'},(doc.configured?.lanCidrs||[]).join(', ')||t('všechny sítě'))),census(doc)));
}

export function routerPanel(){
 const box=el('section',{class:'col col-router'},el('p',{class:'loading',role:'status'},t('Načítám router…')));
 const draw=async()=>{
  try{
   const lost=authGuard(),r=await fetch('/api/router');
   if(!r.ok){lost(r);throw new Error('router');}
   render(box,await r.json(),draw);
  }catch{
   fill(box,emptyState({icon:'⚠',title:t('Stav routeru se nepodařilo načíst'),body:t('Zkus to znovu.'),actions:[{label:t('Zkusit znovu'),onclick:draw,primary:true}]}));
  }
 };
 draw();
 return box;
}
