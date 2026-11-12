// Administration → Integrations (#integrations). Every integration the loaded modules declare: its health,
// where it is configured, a switch to turn it off (and on again without a restart), a "Test now" button
// and its settings when it has any. Administrators with a password sign-in only (the server refuses the
// API to anyone else). Write-only settings are never shown: the server says only whether one is set.
// Text-safe DOM only: every string from the server lands in a text node or an attribute.
import {el} from './views.js';
import {authGuard} from './session-cache.js';
import {t,tp,say,locale} from './i18n.js';
import {timeZone} from './site.js';
import {pageHeader,emptyState,errorState,loadingState,statusPill,toast,icon} from './ui.js';
import {machinesSection,machinePage} from './machines-view.js';
import {openAddDevice} from './home-add-device.js';
import {updateDetails} from './updates-view.js';

// ---- words -------------------------------------------------------------------------------------
const KIND={telemetry:'Telemetrie','llm-runtimes':'Lokální LLM runtimy',router:'Router',collector:'Kolektory',upstream:'Kontrola vydání',storage:'Úložiště',bridge:'Mosty na jiné stroje',other:'Ostatní'};
const KIND_ICON={telemetry:'pulse','llm-runtimes':'cpu',router:'globe',collector:'list',upstream:'versions',storage:'archive',bridge:'plug',other:'puzzle'};
const STATE={ok:['v pořádku','good'],stale:['zastaralé','warn'],error:['chyba','bad'],off:['vypnuto','plain'],'not-configured':['nenastaveno','info'],disabled:['vypnuto administrátorem','']};
const SOURCE={'site.json':'site.json',env:'env',ui:'UI',file:'soubor',plugin:'plugin'};
export const kindLabel=kind=>t(KIND[kind]||KIND.other);
export function stateLabel(status){
 const [label]=STATE[status?.state]||STATE.error,age=ago(status?.lastSuccessAt);
 return status?.state==='stale'&&age?t('{state} · {age}',{state:t(label),age}):t(label);
}
export const stateTone=state=>(STATE[state]||STATE.error)[1];
const titleOf=x=>x.titleKey?t(x.titleKey):t(x.title);

// ---- time --------------------------------------------------------------------------------------
const valid=v=>typeof v==='string'&&Number.isFinite(Date.parse(v));
const when=v=>valid(v)?new Intl.DateTimeFormat(locale(),{day:'numeric',month:'numeric',year:'numeric',hour:'2-digit',minute:'2-digit',timeZone:timeZone()}).format(new Date(v)):'';
export function ago(v,now=Date.now()){
 if(!valid(v))return '';
 const s=Math.round((Date.parse(v)-now)/1000),f=new Intl.RelativeTimeFormat(locale(),{numeric:'auto'});
 for(const [unit,size] of [['day',86400],['hour',3600],['minute',60]])if(Math.abs(s)>=size)return f.format(Math.round(s/size),unit);
 return t('právě teď');
}
const time=v=>valid(v)?el('time',{datetime:v,title:when(v)},ago(v)):null;

// ---- the server --------------------------------------------------------------------------------
const BY_CODE={INTEGRATION_LOCKED:'Tuhle integraci nejde v Home Hubu vypnout ani zapnout.',INTEGRATION_DISABLED:'Integrace je vypnutá. Nejdřív ji zapni.',INTEGRATION_NOT_FOUND:'Taková integrace tu není.',
 ADMIN_REQUIRED:'Na tohle je potřeba přihlášení administrátorským heslem.',INVALID_INPUT:'Neplatný požadavek.'};
async function api(url,body){
 const lost=authGuard(),r=await fetch(url,{...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(body?30000:20000)});
 const data=await r.json().catch(()=>({}));
 if(!r.ok){lost(r);const e=new Error([t(BY_CODE[data.error?.code]||data.error?.message||'Požadavek selhal.'),...(data.error?.details||[])].join(' '));e.status=r.status;throw e;}
 return data;
}

// ---- one card ----------------------------------------------------------------------------------
const pill=status=>statusPill(stateLabel(status),stateTone(status?.state));
const sourceChip=c=>el('span',{class:'ig-chip'},el('b',{},t(SOURCE[c.source]||c.source)),' ',c.source==='ui'?t(c.name):c.name);
function items(list){
 if(!list?.length)return null;
 return el('ul',{class:'ig-items','aria-label':t('Části')},list.map(i=>el('li',{class:'ig-item'},
  el('span',{class:'ig-item-label'},t(i.label)),
  // "off" on a part is a fact, not a fault (no token, schedule unknown): its sentence says it, no pill.
  // A part of a card that is turned off says only "off": the card already says by whom.
  i.state==='off'?el('span',{class:'ig-item-nopill'}):i.state==='disabled'?statusPill(t('vypnuto'),''):pill(i),
  el('span',{class:'ig-item-text'},say(i.summary,i.summaryT),i.lastError?el('code',{class:'ig-err'},i.lastError):null),
  el('span',{class:'ig-item-when'},time(i.lastSuccessAt)))));
}
function settingsForm(row,replace){
 const s=row.settings;if(!s)return null;
 const problem=el('p',{class:'ig-problem',role:'alert'});
 const fields=s.schema.map(f=>{
  const id=`ig-${row.id.replace(/\W/g,'-')}-${f.key}`,value=s.values?.[f.key];
  let control;
  if(f.type==='select')control=el('select',{id,name:f.key},f.options.map(o=>el('option',{value:String(o.value),...(String(o.value)===String(value)?{selected:''}:{})},t(o.label))));
  else if(f.type==='boolean')control=el('input',{id,name:f.key,type:'checkbox',...(value?{checked:''}:{})});
  else if(f.secret)control=el('input',{id,name:f.key,type:'password',autocomplete:'off',placeholder:value?.set?t('uloženo – nová hodnota ho nahradí'):t('nenastaveno')});
  else control=el('input',{id,name:f.key,type:f.type==='number'?'number':'text',value:value??'',...(f.min!==undefined?{min:String(f.min)}:{}),...(f.max!==undefined?{max:String(f.max)}:{}),...(f.placeholder?{placeholder:t(f.placeholder)}:{})});
  const clear=f.secret&&value?.set?el('button',{type:'button',class:'ui-button small danger',onclick:async e=>{
    e.currentTarget.disabled=true;
    try{const done=await api('/api/admin/integrations/settings',{id:row.id,clear:[f.key]});toast.good(t('Hodnota je smazaná.'));replace(done.integration);}
    catch(err){problem.textContent=err.message;e.currentTarget.disabled=false;}}},t('Smazat')):null;
  return el('div',{class:'ig-field'},el('label',{for:id},f.labelKey?t(f.labelKey):t(f.label||f.key)),el('div',{class:'ig-field-row'},control,clear),
   f.secret?el('small',{},t('Jen pro zápis: uloží se na serveru a už se nikdy neukáže.')):f.help?el('small',{},t(f.help)):null);
 });
 const form=el('form',{class:'ig-form',onsubmit:async e=>{
  e.preventDefault();problem.textContent='';const go=form.querySelector('button[type="submit"]');go.disabled=true;
  const values={};
  for(const f of s.schema){const node=form.elements[f.key];if(!node)continue;
   if(f.type==='boolean')values[f.key]=node.checked;else if(f.secret){if(node.value)values[f.key]=node.value;}else values[f.key]=node.value;}
  try{const done=await api('/api/admin/integrations/settings',{id:row.id,values});toast.good(t('Nastavení je uložené.'));replace(done.integration);}
  catch(err){problem.textContent=err.message;}finally{go.disabled=false;}}},
  ...fields,problem,el('div',{class:'ig-form-actions'},el('button',{type:'submit',class:'ui-button small primary'},t('Uložit nastavení'))));
 return el('details',{class:'ig-settings'},el('summary',{},icon('settings'),t('Nastavení')),form);
}
function toggle(row,replace){
 if(!row.toggle)return el('p',{class:'ig-locked'},icon('info'),t(row.toggleNote||'Tady nejde vypnout: zapíná a vypíná se jinde (prostředí nebo konfigurace).'));
 const label=t('Zapnuto');
 const sw=el('button',{type:'button',class:'ig-switch',role:'switch','data-focus':'switch','aria-checked':String(row.enabled),'aria-label':t('{name}: zapnuto',{name:titleOf(row)}),
  // Busy, not disabled, while the request runs: a disabled button would lose the keyboard focus.
  onclick:async()=>{
   if(sw.getAttribute('aria-busy')==='true')return;
   const enabled=!row.enabled;sw.setAttribute('aria-busy','true');
   try{
    const done=await api('/api/admin/integrations/toggle',{id:row.id,enabled});replace(done.integration);
    (enabled?toast.good:toast)(enabled?t('{name} je zapnutá.',{name:titleOf(row)}):t('{name} je vypnutá. Stránky místo jejích dat řeknou, že je vypnutá.',{name:titleOf(row)}),
     {action:{label:t('Vrátit'),onclick:async()=>{try{replace((await api('/api/admin/integrations/toggle',{id:row.id,enabled:!enabled})).integration);}catch(e){toast.bad(e.message);}}}});
   }catch(e){toast.bad(e.message);sw.removeAttribute('aria-busy');}
  }},el('span',{class:'ig-switch-track','aria-hidden':'true'},el('span',{class:'ig-switch-thumb'})));
 return el('label',{class:'ig-toggle'},sw,el('span',{},row.enabled?label:t('Vypnuto')));
}
function testButton(row,replace){
 if(!row.test)return null;
 const b=el('button',{type:'button',class:'ui-button small','data-focus':'test',...(row.enabled?{}:{disabled:'',title:t('Integrace je vypnutá. Nejdřív ji zapni.')}),onclick:async()=>{
  if(b.getAttribute('aria-busy')==='true')return;
  b.setAttribute('aria-busy','true');const was=b.textContent;b.textContent=t('Testuji…');
  try{const done=await api('/api/admin/integrations/test',{id:row.id});
   const s=done.result;(s.state==='ok'?toast.good:s.state==='error'?toast.bad:toast)(t('Test {name}: {state}. {summary}',{name:titleOf(row),state:stateLabel(s),summary:say(s.summary,s.summaryT)}));
   replace(done.integration);}
  catch(e){toast.bad(e.message);b.removeAttribute('aria-busy');b.textContent=was;}}},t('Otestovat teď'));
 return b;
}
export function card(row,{onchange}={}){
 const s=row.status||{state:'error',summary:''};
 let node;
 // The control that had the keyboard keeps it in the redrawn card (data-focus names it).
 const replace=next=>{const was=node.contains?.(document.activeElement)?document.activeElement?.getAttribute?.('data-focus'):null;
  const fresh=card(next,{onchange});node.replaceWith(fresh);node=fresh;if(was)fresh.querySelector?.(`[data-focus="${was}"]`)?.focus();onchange?.(next);};
 const how=(s.state==='not-configured'||!s.state)&&(row.howTo||row.page||row.docs)?el('div',{class:'ig-how'},
  row.howTo?el('p',{},t(row.howTo)):null,
  el('p',{class:'ig-how-links'},row.page?el('a',{class:'ui-button small quiet',href:`#${row.page}`},t('Otevřít stránku')):null,row.docs?el('span',{class:'ig-doc'},t('Dokumentace:'),' ',el('code',{},row.docs)):null)):null;
 node=el('article',{class:`ig-card${row.enabled?'':' off'}`,'data-state':s.state,'aria-labelledby':`ig-t-${row.id.replace(/\W/g,'-')}`},
  el('header',{class:'ig-card-head'},
   el('span',{class:'ig-mark','aria-hidden':'true'},icon(KIND_ICON[row.kind]||'puzzle')),
   el('div',{class:'ig-card-title'},el('h3',{id:`ig-t-${row.id.replace(/\W/g,'-')}`},titleOf(row)),
    el('span',{class:'ig-module'},row.core?t('jádro'):t('plugin {name}',{name:row.moduleTitle}),' · ',el('code',{},row.id))),
   pill(s)),
  s.summary&&s.state!=='disabled'?el('p',{class:'ig-summary'},say(s.summary,s.summaryT),s.lastSuccessAt&&s.state!=='stale'?el('span',{class:'ig-dim'},' · ',t('naposledy'),' ',time(s.lastSuccessAt)):null):null,
  s.state==='error'&&s.lastError?el('p',{class:'ig-error'},t('Poslední chyba:'),' ',el('code',{},s.lastError)):null,
  !row.enabled?el('p',{class:'ig-off-note'},row.disabledBy?t('Vypnul {by} {when}. Hub ji nečte a stránky ukazují, že je vypnutá.',{by:row.disabledBy,when:ago(row.disabledAt)||''}):t('Vypnutá. Hub ji nečte a stránky ukazují, že je vypnutá.')):null,
  row.description?el('p',{class:'ig-desc'},t(row.description)):null,
  s.configuredBy?.length?el('div',{class:'ig-config'},el('span',{class:'ig-config-label'},t('Nastaveno přes:')),...s.configuredBy.map(sourceChip))
   :el('div',{class:'ig-config'},el('span',{class:'ig-config-label'},t('Nastaveno přes:')),el('span',{class:'ig-dim'},t('nic – výchozí stav'))),
  items(s.items),how,
  // The update check also shows the release it found: its notes and how to update (updates-view.js).
  row.id==='updates.check'&&row.enabled?updateDetails():null,
  el('footer',{class:'ig-card-foot'},toggle(row,replace),testButton(row,replace)),
  settingsForm(row,replace));
 return node;
}

// ---- the page ------------------------------------------------------------------------------------
function counts(rows){
 const n=state=>rows.filter(r=>r.status?.state===state).length;
 const stat=(label,value,tone)=>el('div',{class:`ig-stat ${tone}`.trim()},el('b',{},String(value)),el('span',{},label));
 return el('div',{class:'ig-stats',role:'group','aria-label':t('Souhrn')},
  stat(t('v pořádku'),n('ok'),'good'),stat(t('chce pozornost'),n('stale')+n('error'),n('error')?'bad':n('stale')?'warn':''),
  stat(t('nenastaveno'),n('not-configured'),''),stat(t('vypnuto'),n('disabled')+n('off'),''));
}
function plugins(doc){
 const note=doc.pluginsDirectory?t('Pluginy se načítají ze složky {dir} při startu serveru. Celý plugin za běhu vypnout nejde; vypnout jde jeho integrace výše.',{dir:doc.pluginsDirectory})
  :t('Tenhle hub nenačítá žádné pluginy (HOME_HUB_PLUGINS_DIR=none).');
 const byId=new Map(doc.integrations.map(i=>[i.id,i]));
 return el('section',{class:'ig-group','aria-labelledby':'ig-plugins'},
  el('h2',{id:'ig-plugins'},icon('puzzle'),t('Pluginy')),el('p',{class:'ig-lead'},note),
  doc.plugins.length?el('ul',{class:'ig-plugins'},doc.plugins.map(p=>el('li',{},
   el('b',{},t(p.title)),' ',el('code',{},p.id),
   el('span',{class:'ig-dim'},p.integrations.length?` · ${p.integrations.map(id=>byId.get(id)?titleOf(byId.get(id)):id).join(', ')}`:` · ${t('bez integrací')}`))))
   :emptyState({compact:true,icon:'puzzle',title:t('Žádné pluginy'),body:t('Tahle instalace je jen jádro. Plugin je složka local/plugins/<id>/ s index.mjs (docs/plugins.md).')}));
}
// #integrations/machine/<id> → that machine's page; anything else → the list.
export const machineOfHash=hash=>{const p=String(hash||'').replace(/^#/,'').split('/');if(p[0]!=='integrations'||p[1]!=='machine'||!p[2])return null;try{return decodeURIComponent(p[2]);}catch{return null;}};
export function integrationsView({me}={}){
 const machineId=machineOfHash(globalThis.location?.hash);
 if(machineId)return machineView(machineId);
 const body=el('div',{class:'ig-body'},loadingState(t('Načítám integrace…')));
 const head=pageHeader({eyebrow:t('Správa'),title:t('Integrace'),
  lead:t('Odkud Home Hub bere data, jestli to funguje a kde je to nastavené. Vypnutou integraci hub nečte a stránky místo starých dat řeknou, že je vypnutá. Zapnout ji jde zase bez restartu.'),
  actions:[{label:t('Obnovit'),onclick:()=>draw()}]});
 let doc=null,machines=null;
 const addMachine=()=>openAddDevice({meta:machines?.telemetry,onSaved:()=>{toast.good(t('Stroj je přidaný.'));draw();}});
 const paint=()=>{
  const rows=doc.integrations;let stats=counts(rows);
  // A card redraws itself after a change (focus stays where it was); only the counts follow.
  const onchange=next=>{doc.integrations=doc.integrations.map(r=>r.id===next.id?next:r);const fresh=counts(doc.integrations);stats.replaceWith(fresh);stats=fresh;};
  const groups=doc.kinds.filter(k=>rows.some(r=>r.kind===k)).map(k=>el('section',{class:'ig-group','aria-labelledby':`ig-k-${k}`},
   el('h2',{id:`ig-k-${k}`},icon(KIND_ICON[k]||'puzzle'),kindLabel(k)),
   el('div',{class:'ig-grid'},rows.filter(r=>r.kind===k).map(r=>card(r,{onchange})))));
  body.replaceChildren(stats,machines?machinesSection(machines,{onAdd:me?.canWrite?addMachine:null}):el('p',{class:'ig-dim'},t('Stroje se nepodařilo načíst.')),
   ...(rows.length?groups:[emptyState({icon:'plug',title:t('Žádné integrace'),body:t('Žádný načtený modul nehlásí integraci.')})]),
   plugins(doc));
 };
 async function draw(){
  try{[doc,machines]=await Promise.all([api('/api/admin/integrations'),api('/api/admin/machines').catch(()=>null)]);paint();}
  catch(e){body.replaceChildren(e.status===403?emptyState({icon:'shield',title:t('Jen pro administrátora'),body:t('Integrace spravuje administrátor přihlášený heslem.')})
   :errorState({title:t('Integrace se nepodařilo načíst'),body:e.name==='TimeoutError'?t('Home Hub neodpovídá. Zkus to znovu.'):e.message,retry:draw}));}
 }
 draw();
 return el('div',{class:'ig-page'},head,body);
}
function machineView(id){
 const body=el('div',{class:'ig-body'},loadingState(t('Načítám stroj…')));
 api('/api/admin/machines').then(doc=>body.replaceChildren(machinePage(doc,id)))
  .catch(e=>body.replaceChildren(errorState({title:t('Stroj se nepodařilo načíst'),body:e.message,retry:()=>{body.replaceWith(machineView(id));}})));
 return body;
}
export const integrationsPage=({me}={})=>integrationsView({me});
