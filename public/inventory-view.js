import {canWrite} from './access.js';
import {t} from './i18n.js';
import {el,onLeave} from './views.js';
import {onSessionReset,currentPrincipal,pageAllowed,authGuard} from './session-cache.js';
import {load as loadSystems,pill,statusPill,when} from './systems-view.js';
import {versionRows,machineOs,versionSummary,systemMachineOf} from './inventory-versions.js';
import {site} from './site.js';
// #inventory-map (Inventář → Mapa inventáře): data/knowledge.json as a dependency map, restored from
// v1 into the v2 shell. Every signed-in account may read it (GET /api/inventory, as in v1); editing
// needs write access. Admins also see installed versions and updates from Systémy (GET /api/systems)
// in the selected card and the entry detail; for everyone else that block is simply left out.
// Secrets are only ever locations (store + item name); the server refuses a file that fails the checker.
const KIND={network:'Síť',machine:'Stroj',runtime:'Služba',tool:'Nástroj','model-store':'Úložiště modelů','skill-store':'Úložiště skillů','secret-store':'Úložiště tajemství',external:'Vnější služba','secret-item':'Položka tajemství'};
const GROUPS={runtime:'Služby',tool:'Nástroje','model-store':'Úložiště modelů','skill-store':'Úložiště skillů','secret-store':'Úložiště tajemství'};
// Display names of places (machines and other locations entries refer to): site.json → inventory.places.
const places=()=>Object.fromEntries((site().inventory?.places||[]).map(p=>[p.id,p.label]));
// Dependency kinds: runs-on is implied by an entry's machine; the rest are recorded in depends_on.
const DEPS={'runs-on':'Běží na',call:'Volá',data:'Používá data',secret:'Potřebuje tajemství',cert:'Potřebuje certifikát'};
const DEP_HELP={'runs-on':'Stroj, na kterém běží (pole machine)',call:'Volá ho po síti nebo přes API',data:'Čte jeho soubory: váhy, dumpy, složky',secret:'Bere si od něj přihlašovací údaj',cert:'Bere si od něj TLS certifikát'};
// Categories colour the map cards; the same lists live in scripts/check-knowledge.mjs.
const CATS=[['hardware','Hardware'],['network','Síť'],['service','Služby'],['model','Modely'],['tool','Nástroje'],['llm-support','Podpora LLM'],['saas','SaaS'],['secret','Tajemství']];
const CAT_KEYS=CATS.map(c=>c[0]),CAT_LABEL=Object.fromEntries(CATS);
const DEFAULT_CAT={machine:'hardware',network:'network',external:'saas',runtime:'service',tool:'tool','model-store':'model','skill-store':'llm-support','secret-store':'secret'};
const catOf=e=>CAT_KEYS.includes(e.category)?e.category:DEFAULT_CAT[e.kind];
const state={mapSelected:null,mapMode:'connected',mapStores:false,hidden:new Set(),listOpen:{}};
let cache=null,fetchedAt=0,pending=null,systems=null,redraw=null;
// Another account must not see this one's inventory, selection or versions (session-cache.js).
onSessionReset(()=>{cache=null;fetchedAt=0;pending=null;systems=null;redraw=null;state.mapSelected=null;state.listOpen={};document.querySelector('#inv-detail')?.close();});
const badge=(text,tone='')=>el('span',{class:`inv-badge ${tone}`},text);

function load(){
  if(cache&&Date.now()-fetchedAt<60000)return Promise.resolve(cache);
  const who=currentPrincipal(),lost=authGuard();
  pending??=fetch('/api/inventory').then(async r=>{const body=await r.json().catch(()=>({}));if(!r.ok){lost(r);throw new Error(body?.error?.message||t('Inventář není dostupný.'));}
    if(who===currentPrincipal()){cache=body;fetchedAt=Date.now();}return body;}).finally(()=>{pending=null;});
  return pending;
}
const hasGap=e=>(e.secrets||[]).some(s=>s.store==='unknown')||(e.kind==='runtime'&&!e.address);
const placeName=k=>{const label=places()[k];return label?t(label):k;};
const kindName=k=>KIND[k]?t(KIND[k]):k;
const place=e=>e.kind==='machine'?e.name:e.kind==='external'?t('Mimo dům'):e.kind==='network'?t('Domácí síť'):placeName(e.machine);
const typeTag=e=>(e.type||kindName(e.kind)).split(' · ')[0];
function index(doc){
  const byId=new Map(doc.entries.map(e=>[e.id,e])),usedBy=new Map();
  for(const e of doc.entries)for(const d of e.depends_on||[]){if(!usedBy.has(d.id))usedBy.set(d.id,[]);usedBy.get(d.id).push({id:e.id,kind:d.kind,label:d.label||''});}
  return {byId,usedBy};
}
// Every edge: recorded depends_on plus the implied runs-on link to the entry's machine (as in check-knowledge.mjs).
function deps(doc){
  const ids=new Set(doc.entries.map(e=>e.id)),out=[];
  for(const e of doc.entries){for(const d of e.depends_on||[])out.push({from:e.id,to:d.id,kind:d.kind,label:d.label||''});
    if(!e.virtual&&e.kind!=='machine'&&e.machine&&ids.has(e.machine))out.push({from:e.id,to:e.machine,kind:'runs-on',label:''});}
  return out;
}
// Breadth-first over the edges: forward = what it needs, backward = what stops if it fails.
function walk(doc,start,forward,hidden=new Set()){
  const out=[],seen=new Set([start]),edges=new Set(),queue=[[start,0]],all=deps(doc);
  while(queue.length){const [cur,depth]=queue.shift();
    for(const l of all){
      if(hidden.has(l.kind))continue;const [from,to]=forward?[l.from,l.to]:[l.to,l.from];if(from!==cur)continue;
      edges.add(`${l.from}>${l.to}`);if(seen.has(to))continue;seen.add(to);out.push({id:to,depth:depth+1,kind:l.kind,label:l.label});queue.push([to,depth+1]);}}
  return {out,seen,edges};
}
function store(s){
  const [k,v='']=s.split(':'),m=placeName(v);
  return ({keychain:[t('Klíčenka · {m}',{m}),'good'],file:[t('Soubor · {m}',{m}),'info'],'app-env':[t('Nastavení aplikace TrueNAS · {v}',{v}),'info'],'shell-env':[t('Proměnná shellu · {m}',{m}),'info'],'app-settings':[t('Nastavení {v}',{v}),'info'],sso:[t('Přihlášení {v}',{v:v==='google'?'Google':v}),'info'],'passwords-app':[t('Aplikace Hesla'),'good'],remembered:[t('Pamatuješ si ho'),''],unknown:[t('Nezapsáno'),'amber']})[k]||[s,(site().inventory?.secretStores||[]).includes(s)?'good':''];
}
const kindBadge=e=>badge(e.kind==='runtime'||e.kind==='tool'?typeTag(e):kindName(e.kind),`kind-${e.kind}`);
const link=(text,url)=>url?el('a',{href:url,target:'_blank',rel:'noopener noreferrer'},text):text;

// Installed version and update from Systémy, with the same words as Verze a aktualizace: an update is
// shown even if the last upstream check failed (it still proves a newer release), flagged "neověřeno".
function versionBlock(e){
  if(!systems)return '';
  const os=machineOs(e,systems),rows=versionRows(e,systems),machine=systemMachineOf(e);
  if(!os&&!rows.length)return '';
  const unverified=r=>r.upstreamStale&&r.status!=='unknown'?pill(t('neověřeno'),'warn',r.upstreamError?t('Poslední kontrola nejnovější verze selhala: {error}; údaj z {when}.',{error:t(r.upstreamError),when:when(r.upstreamCheckedAt)}):t('Poslední kontrola nejnovější verze selhala; údaj z {when}.',{when:when(r.upstreamCheckedAt)})):null;
  const item=(name,r)=>{const s=versionSummary(r);
    return el('li',{class:'inv-ver'},el('span',{class:'inv-ver-name'},name),el('b',{class:'inv-ver-v',title:r.path||''},s.installed||'—'),statusPill(r.status),unverified(r),r.stale?pill(t('starý snímek'),'warn'):null,
      s.update?el('span',{class:'inv-ver-up'},t('dostupná aktualizace → '),el('b',{},link(s.update,r.latestUrl))):null,
      s.note&&(s.update||s.unverified)?el('small',{class:'inv-ver-note'},t(s.note)):null);};
  return el('div',{class:'inv-versions'},
    el('div',{class:'inv-ver-head'},el('span',{class:'eyebrow'},t('VERZE · SYSTÉMY')),el('a',{href:`#versions/${machine}`},t('Verze a aktualizace →'))),
    el('ul',{},os?item(os.name||t('Systém'),{...os,upstreamStale:false}):null,rows.map(r=>item(r.name,r))),
    el('small',{class:'inv-ver-src'},t('Stroje {machines} · vydání {releases}',{machines:when(systems.collectedAt),releases:when(systems.upstreamCheckedAt)})));
}

function detail(doc,e,pick){
  const {byId,usedBy}=index(doc);
  const crumbs=e.kind==='network'?t('Nejvyšší úroveň'):e.kind==='machine'?t('Domácí síť'):e.kind==='external'?t('Vnější služby'):`${place(e)} › ${GROUPS[e.kind]?t(GROUPS[e.kind]):kindName(e.kind)}`;
  const row=(label,value,mono,always=true)=>value?[el('dt',{},label),el('dd',{class:mono?'mono':''},value)]:always?[el('dt',{},label),el('dd',{class:'muted'},t('Nezapsáno'))]:[];
  const links=(title,list)=>list.length?[el('h3',{},title),el('div',{class:'inv-links'},list.map(x=>{const to=byId.get(x.id);return el('button',{class:'inv-btn',type:'button',onclick:()=>pick(x.id)},to?to.name:x.id,el('span',{class:'muted'},` · ${DEPS[x.kind]?t(DEPS[x.kind]):x.kind}${x.label?` · ${t(x.label)}`:''}`));}))]:[];
  const copy=text=>el('button',{class:'inv-btn',type:'button',onclick:async ev=>{const b=ev.currentTarget;try{await navigator.clipboard.writeText(text);b.textContent=t('Zkopírováno');}catch{b.textContent=t('Nejde zkopírovat');}}},t('Kopírovat'));
  return el('div',{class:'inv-detail'},
    el('p',{class:'muted inv-crumbs'},crumbs),
    el('div',{class:'inv-detail-head'},el('h2',{id:'inv-detail-title'},e.name),el('div',{class:'inv-head-actions'},kindBadge(e),canWrite()?el('button',{type:'button',class:'inv-btn',onclick:()=>showEditor(e)},t('Upravit')):badge(t('Jen čtení')))),
    versionBlock(e),
    e.notes?el('p',{class:'muted inv-detail-notes'},e.notes):'',
    el('dl',{class:'inv-dl'},row(t('Druh'),`${kindName(e.kind)}${e.type?` · ${e.type}`:''}`),e.kind!=='machine'&&e.kind!=='network'&&e.kind!=='external'?row(t('Stroj'),place(e)):[],row(t('Adresa'),e.address,true,e.kind==='runtime'||e.kind==='machine'),row(t('Verze (zapsaná)'),e.version,false,false),row(t('Konfigurace'),e.config,true,e.kind!=='external'),row(t('Data'),e.data,true,false),row(t('Spravuje'),e.managed_by,true,false),row(t('Jak se přihlásit'),e.login,false,false)),
    e.models?.length?[el('h3',{},t('Modely · {n}',{n:e.models.length})),el('ul',{class:'inv-list mono'},e.models.map(m=>el('li',{},m)))]:'',
    e.skills?.length?[el('h3',{},t('Skilly · {n}',{n:e.skills.length})),el('ul',{class:'inv-list mono'},e.skills.map(m=>el('li',{},m)))]:'',
    el('h3',{},t('Tajemství · kde jsou uložená')),
    (e.secrets||[]).length?el('div',{class:'inv-secrets'},e.secrets.map(s=>{const [label,tone]=store(s.store);return el('div',{class:`inv-secret ${s.store==='unknown'?'gap':''}`},
      el('div',{class:'inv-secret-head'},el('strong',{},s.what),badge(label,tone)),
      s.ref?el('p',{class:'mono'},s.ref):'',
      s.check?el('div',{class:'inv-check'},el('code',{},s.check),copy(s.check)):'',
      s.store==='unknown'?el('small',{class:'amber-text'},t('Ještě nezapsáno. Doplň, kde je uložené — nikdy hodnotu.')):'');})):el('p',{class:'muted'},t('U tohoto záznamu nejsou žádná tajemství.')),
    links(t('Závisí na'),e.depends_on||[]),links(t('Používají ho'),usedBy.get(e.id)||[]),
    el('p',{class:'muted inv-verified'},`${t('Naposledy ověřeno {when}',{when:e.verified_at})} · ${e.verified_by||t('zdroj nezapsán')}${e.confidence==='inferred'?` · ${t('odvozeno, přímo neověřeno')}`:''}`));
}
// The entry detail and the editor open in one dialog outside #root, so a re-render keeps it; a click
// on the backdrop or Escape closes it.
function dialogEl(){
  let d=document.querySelector('#inv-detail');if(d)return d;
  d=el('dialog',{id:'inv-detail',class:'inv-dialog','aria-labelledby':'inv-detail-title',onclick:ev=>{if(ev.target===d)d.close();}});
  document.body.append(d);return d;
}
const dialogHead=(eyebrow,close)=>el('header',{class:'inv-dialog-head'},el('span',{class:'eyebrow'},eyebrow),el('button',{type:'button',class:'inv-btn quiet',onclick:()=>dialogEl().close(),'aria-label':close},t('Zavřít ×')));
// Editing: the form posts to Home Hub, which hands the edit to the owner of knowledge.json.
const FIELDS=[['name','Název'],['type','Typ'],['category','Kategorie na mapě'],['address','Adresa'],['version','Verze'],['config','Konfigurace'],['data','Data'],['managed_by','Spravuje'],['login','Jak se přihlásit'],['notes','Poznámky']];
const LONG=new Set(['config','data','login','notes']);
// Suggestions for the store field: the generic ones, then per-place and site-specific ones (site.json → inventory).
const stores=()=>{const ids=(site().inventory?.places||[]).map(p=>p.id);return ['passwords-app','remembered','sso:google',...(site().inventory?.secretStores||[]),...ids.map(id=>`keychain:${id}`),...ids.map(id=>`file:${id}`),...ids.map(id=>`shell-env:${id}`),'app-env:','app-settings:','unknown'];};
function showEditor(e){
  const dialog=dialogEl(),hash=cache?.hashes?.[e.id],inputs={};
  const fields=FIELDS.map(([k,label])=>{const input=k==='category'?el('select',{id:`inv-f-${k}`,name:k},el('option',{value:''},t('Výchozí pro druh ({category})',{category:t(CAT_LABEL[DEFAULT_CAT[e.kind]]||OTHER)})),CATS.map(([v,l])=>el('option',{value:v},t(l)))):el(LONG.has(k)?'textarea':'input',{id:`inv-f-${k}`,name:k,rows:LONG.has(k)?'2':null,maxlength:'2000'});input.value=e[k]||'';inputs[k]=input;return el('div',{class:'inv-field'},el('label',{for:`inv-f-${k}`},t(label)),input);});
  const rows=el('div',{class:'inv-secret-rows'});
  const addRow=(s={})=>{const row=el('div',{class:'inv-secret-row'});const f=(name,label,list)=>{const i=el('input',{name,'aria-label':label,placeholder:label,maxlength:'500',...(list?{list:'inv-stores'}:{})});i.value=s[name]||'';return i;};
    row.append(f('what',t('Co to je')),f('store',t('Kde je uložené'),true),f('ref',t('Název položky, cesta nebo proměnná')),f('check',t('Kontrolní příkaz (nesmí ho vypsat)')),el('button',{type:'button',class:'inv-btn quiet','aria-label':t('Odebrat tajemství'),onclick:()=>row.remove()},t('Odebrat')));rows.append(row);};
  (e.secrets||[]).forEach(addRow);
  const status=el('div',{role:'alert',class:'inv-error'}),save=el('button',{type:'submit',class:'inv-btn primary'},t('Uložit'));
  const form=el('form',{class:'inv-edit',onsubmit:async ev=>{ev.preventDefault();
    const body={id:e.id,base:hash,fields:Object.fromEntries(FIELDS.map(([k])=>[k,inputs[k].value]))};
    body.fields.secrets=[...rows.querySelectorAll('.inv-secret-row')].map(r=>Object.fromEntries([...r.querySelectorAll('input')].map(i=>[i.name,i.value.trim()]))).filter(x=>x.what||x.store||x.ref||x.check);
    if(body.fields.secrets.some(x=>!x.what||!x.store)){status.textContent=t('Každé tajemství potřebuje, co to je a kde je uložené.');return;}
    save.disabled=true;status.textContent=t('Ukládám…');
    try{const lost=authGuard(),r=await fetch('/api/inventory/entry',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),out=await r.json().catch(()=>({}));
      if(!r.ok){lost(r);status.replaceChildren(el('p',{},t(out?.error?.message)||t('Uložení selhalo.')),...(out?.error?.details||[]).map(d=>el('small',{},t(d))));return;}
      cache=null;fetchedAt=0;
      if(!out.published){status.textContent=t('Uloženo, ale zveřejnění selhalo. Změna se tu ukáže po dalším publikování (scripts/push-knowledge.sh).');return;}
      dialog.close();dispatchEvent(new Event('inventoryupdated'));
    }catch{status.textContent=t('Home Hub není dosažitelný. Zkus to znovu.');}finally{save.disabled=false;}}},
    el('p',{class:'muted'},t('Změny se uloží do data/knowledge.json, zkontrolují se stejně jako úpravy agentů a zveřejní se tady. Zapisuj, kde je tajemství uložené, nikdy tajemství samotné.')),
    el('div',{class:'inv-fields'},fields),
    el('h3',{},t('Tajemství · kde jsou uložená')),rows,el('datalist',{id:'inv-stores'},stores().map(v=>el('option',{value:v}))),
    el('button',{type:'button',class:'inv-btn',onclick:()=>addRow()},t('+ Přidat tajemství')),
    status,el('div',{class:'inv-edit-actions'},el('button',{type:'button',class:'inv-btn',onclick:()=>showDetail(cache?.doc,e.id)},t('Zrušit')),save));
  dialog.replaceChildren(dialogHead(t('ÚPRAVA ZÁZNAMU'),t('Zavřít úpravu')),el('h2',{id:'inv-detail-title'},e.name),form);
  if(!dialog.open)dialog.showModal();
  if(!hash)status.textContent=t('Před úpravou obnov stránku: záznam ještě nemá otisk verze.');
}
function showDetail(doc,id){
  const dialog=dialogEl(),e=doc&&index(doc).byId.get(id);if(!e)return;
  dialog.replaceChildren(dialogHead(t('ZÁZNAM INVENTÁŘE'),t('Zavřít záznam')),detail(doc,e,next=>showDetail(doc,next)));
  if(!dialog.open)dialog.showModal();
}

function stats(doc,gaps){
  const count=k=>doc.entries.filter(e=>e.kind===k).length;let located=0,unknown=0;
  for(const e of doc.entries)for(const s of e.secrets||[])s.store==='unknown'?unknown++:located++;
  return el('div',{class:'inv-stats'},[[count('machine'),'Stroje'],[count('runtime'),'Služby'],[count('tool'),'Nástroje'],[count('model-store'),'Úložiště modelů'],[located,'Tajemství dohledaná'],[unknown,'Tajemství nezapsaná'],[gaps.length,'Mezery celkem']].map(([n,label],i)=>el('div',{class:`inv-stat${i>=5&&n?' amber':''}`},el('b',{},n),el('span',{},t(label)))));
}

// Secret items: each Keychain item or variable listed in a secret store becomes its own map card, kept in
// that store; entries whose secrets name the item link to it instead of to the whole store. Map only.
const refTokens=ref=>(ref||'').split(';').map(t=>t.trim().replace(/\s*\(.*\)$/,'').replace(/\s+in\s+~\S*$/,'')).filter(Boolean);
function withSecretItems(doc){
  const stores=doc.entries.filter(e=>e.kind==='secret-store'),storeFor=new Map(),items=[];
  for(const st of stores){
    const counts={};for(const x of st.secrets||[])counts[x.store]=(counts[x.store]||0)+1;
    const key=Object.keys(counts).sort((a,b)=>counts[b]-counts[a])[0];if(key&&!storeFor.has(key))storeFor.set(key,st.id);
    (st.secrets||[]).forEach((x,i)=>refTokens(x.ref).forEach((t,j)=>items.push({id:`si-${st.id}-${i}-${j}`,kind:'secret-item',category:'secret',virtual:true,store:st.id,machine:st.machine,name:x.what,address:t,depends_on:[{id:st.id,kind:'runs-on',label:'uloženo v'}]})));
  }
  const match=(st,t)=>items.filter(it=>it.store===st&&(it.address===t||t.endsWith('*')&&it.address.startsWith(t.slice(0,-1))));
  const entries=doc.entries.map(e=>{
    if(e.kind==='secret-store'||!e.secrets?.length)return e;
    const add=[],covered=new Set();
    for(const x of e.secrets){const st=storeFor.get(x.store);if(!st)continue;const hit=refTokens(x.ref).flatMap(t=>match(st,t));
      if(hit.length){covered.add(st);for(const it of hit)if(!add.some(a=>a.id===it.id))add.push({id:it.id,kind:'secret',label:x.what});}}
    if(!add.length)return e;
    return {...e,depends_on:[...(e.depends_on||[]).filter(d=>!(d.kind==='secret'&&covered.has(d.id))),...add]};
  });
  return {...doc,entries:[...entries,...items]};
}
// Map: cards coloured by category, arrows for dependencies (arrow points at what is needed; line pattern = kind).
// Columns are by machine or by category. The browser keeps only the order of columns and of cards in each column,
// so hidden, removed or new cards never leave holes or land in the wrong column.
const NS='http://www.w3.org/2000/svg';
function svg(tag,attrs={},...children){const n=document.createElementNS(NS,tag);for(const [k,v] of Object.entries(attrs)){if(k.startsWith('on'))n.addEventListener(k.slice(2),v);else if(v!=null)n.setAttribute(k,v);}for(const c of children.flat(Infinity))if(c!=null&&c!=='')n.append(c instanceof Node?c:document.createTextNode(String(c)));return n;}
const clip=(t,n)=>t&&t.length>n?`${t.slice(0,n-1)}…`:t||'';
// Text with every http(s) URL turned into a link that opens in a new tab.
const linkify=text=>text.split(/(https?:\/\/[^\s;,)]+)/).map((part,i)=>i%2?el('a',{href:part,target:'_blank',rel:'noopener noreferrer'},part):part);
// v3: Czech column labels (the saved column order is keyed by label), so v1 layouts start fresh.
const LAYOUT_KEY='home-hub.inventory.map.v3';
// The map's machine columns come from the site's places (site.json → inventory.places), in their order:
// column = this place has a column of its own under that heading; lane = its cards belong to the shared
// Network ("net") or Outside ("outside") column instead; short = the tag on cards in the category layout.
const placeList=()=>site().inventory?.places||[];
const placeOf=id=>placeList().find(p=>p.id===id);
const machineCols=()=>[...placeList().filter(p=>p.column).map(p=>[p.id,p.column]),['net','Síť'],['outside','Mimo dům']];
const machineCol=e=>e.kind==='network'||placeOf(e.id)?.lane==='net'?'net':e.kind==='external'||placeOf(e.id)?.lane==='outside'||placeOf(e.machine)?.lane==='outside'?'outside':e.kind==='machine'?e.id:e.machine;
// A card whose machine has no column (an unknown or missing machine id, a machine not listed above) or whose
// category is unknown is still drawn: in a last column of its own.
const OTHER='Ostatní';
const catLabel=c=>t(CAT_LABEL[c]||OTHER);
const machineRank=e=>{const i=placeList().findIndex(p=>p.id===(e.kind==='machine'?e.id:e.machine));return i<0?999:i;};
function layoutLoad(){
  const strings=a=>Array.isArray(a)?a.filter(x=>typeof x==='string').map(x=>x.slice(0,80)).slice(0,300):null;
  const mode=v=>({cols:strings(v?.cols),order:Object.fromEntries(Object.entries(v?.order&&typeof v.order==='object'?v.order:{}).map(([k,a])=>[k.slice(0,40),strings(a)||[]]))});
  try{const v=JSON.parse(localStorage.getItem(LAYOUT_KEY)||'{}');
    return {spacing:v.spacing==='roomy'?'roomy':'compact',lines:v.lines==='all'?'all':'chain',depth:v.depth==='all'?'all':'direct',columns:v.columns==='category'?'category':'machine',
      together:v.together===true,focus:v.focus===true,secretItems:v.secretItems===true,hiddenCats:Array.isArray(v.hiddenCats)?v.hiddenCats.filter(k=>CAT_KEYS.includes(k)):[],soloPrev:Array.isArray(v.soloPrev)?v.soloPrev.filter(k=>CAT_KEYS.includes(k)):null,
      modes:{machine:mode(v.modes?.machine),category:mode(v.modes?.category)}};}
  catch{return {spacing:'compact',lines:'chain',depth:'direct',columns:'machine',together:false,focus:false,secretItems:false,hiddenCats:[],soloPrev:null,modes:{machine:mode(),category:mode()}};}
}
// Map columns in their default order: machines (machine card first) or categories (grouped by machine
// inside), then Ostatní for every card that has no column. Each card is in exactly one column; empty ones are left out.
export function columnGroups(list,columns){
  const storeKey=e=>e.store||e.id,order=new Map(list.map((e,i)=>[e.id,i])),at=id=>order.get(id)??-1;
  const [known,keyOf,sort]=columns==='category'
    ?[CATS,catOf,(a,b)=>machineRank(a)-machineRank(b)||at(storeKey(a))-at(storeKey(b))||at(a.id)-at(b.id)]
    :[machineCols(),machineCol,(a,b)=>(b.kind==='machine')-(a.kind==='machine')||CAT_KEYS.indexOf(catOf(a))-CAT_KEYS.indexOf(catOf(b))];
  const keys=new Set(known.map(([k])=>k));
  return [...known.map(([k,label])=>({label,cards:list.filter(e=>keyOf(e)===k)})),{label:OTHER,cards:list.filter(e=>!keys.has(keyOf(e)))}]
    .filter(g=>g.cards.length).map(g=>({...g,cards:g.cards.sort(sort)}));
}
// Size of the map in map units: every lane, and every card plus room for its outgoing arrows. Never NaN, so
// one bad position cannot collapse the SVG (an invalid viewBox clips the whole map).
export function mapExtent(points,lanes,{COL,ROW,TOP}){
  const fin=v=>Number.isFinite(v)?v:0;
  return {width:Math.max(fin(lanes)*COL,0,...points.map(p=>fin(p?.x)+W+150)),height:Math.max(TOP+ROW,...points.map(p=>fin(p?.y)+H+24))};
}
function layoutSave(l){try{localStorage.setItem(LAYOUT_KEY,JSON.stringify(l));}catch{}}
const W=180,H=40;
// Pointer gestures on the map: one tracker per map, fed by every pointer on the page (bindMapPointers).
// It records each pointer that is down, by pointerId, whatever its type and wherever it went down. A press on a
// card is the candidate tap only if it is the one and only pointer down; any other pointer going down anywhere
// while the press is held kills the tap for good. Moving past the slop kills it too: touch TOUCH_SLOP screen px
// (a swipe; the page pans natively, see touch-action in inventory.css), mouse and pen DRAG_SLOP map units
// (scale = screen px per map unit) - that is a card drag. Touch never drags. Up, cancel and lost capture
// remove only their own pointer; a press ends with a tap only on its own pointerup while still a tap.
// A pointer is forgotten only on a real signal that it is up, never because it was quiet: a finger held still
// for a minute is still down. The signals: its own up, cancel or lost capture; a pointerdown reusing its id (its
// up was lost; only that id is replaced); for a mouse, any event of it with no button held (trackStale); and
// window blur or a hidden tab, which forget everything. A press cut off this way is handed back to be undone.
export const TOUCH_SLOP=10,DRAG_SLOP=5;
export const pointerTracker=()=>({down:new Map(),press:null});
function forget(t,id){t.down.delete(id);if(t.press?.id===id)t.press=null;}
// pointerdown. card: id of the card under the pointer, or null (background, outside the map). Returns the
// press this pointer started, or null.
export function trackDown(t,ev,card=null){
  forget(t,ev.pointerId);
  if(t.press)t.press.tap=false;
  t.down.set(ev.pointerId,{type:ev.pointerType});
  if(t.down.size===1&&card!=null&&ev.button===0&&ev.isPrimary!==false)
    t.press={id:ev.pointerId,type:ev.pointerType,touch:ev.pointerType==='touch',x:ev.clientX,y:ev.clientY,card,moved:false,tap:true};
  return t.press?.id===ev.pointerId?t.press:null;
}
// pointermove. Returns the press when the move is its pointer's (check press.moved for a drag), else null.
export function trackMove(t,ev,scale=1){
  if(!t.down.has(ev.pointerId))return null;
  const g=t.press;if(g?.id!==ev.pointerId)return null;
  if(!g.moved){const d=Math.abs(ev.clientX-g.x)+Math.abs(ev.clientY-g.y);g.moved=g.touch?d>=TOUCH_SLOP:d/scale>=DRAG_SLOP;if(g.moved)g.tap=false;}
  return g;
}
// Before handling a pointerdown (down=true) or pointermove: is a tracked pointer with this id provably no longer
// the one that went down? A down reusing the id means its up was lost; a mouse event with buttons 0 means that
// mouse is up. Forgets it and returns its press (the caller undoes a drag), else null. Only a mouse is judged by
// buttons; pen and touch are left to their own up, cancel and lost capture.
export function trackStale(t,ev,down=false){
  const p=t.down.get(ev.pointerId);
  if(!p||!(down||p.type==='mouse'&&ev.pointerType==='mouse'&&ev.buttons===0))return null;
  const g=t.press?.id===ev.pointerId?t.press:null;forget(t,ev.pointerId);return g;
}
// pointerup (cancel=false), pointercancel or lostpointercapture (cancel=true). Returns {press,tap,drop} when the
// press's own pointer ended (drop: a mouse or pen drag to save), else null.
export function trackUp(t,ev,cancel=false){
  if(!t.down.has(ev.pointerId))return null;
  const g=t.press;forget(t,ev.pointerId);
  if(g?.id!==ev.pointerId)return null;
  return {press:g,tap:!cancel&&g.tap,drop:!cancel&&!g.touch&&g.moved};
}
// Window blur, tab hidden: no pointer can be trusted to still be down. Returns the press that was cut off.
export function trackClear(t){const g=t.press;t.down.clear();t.press=null;return g;}
// One listener set for the map, on the document in the capture phase so no pointer goes unseen. cardOf(ev):
// card id under the pointer or null; scaleOf(): screen px per map unit. signal: aborting it removes every
// listener (the view's dispose); live(): a backstop that does the same on the first event after it turns false.
// onPress(press), onDrag(press,ev) on each move of a moved mouse/pen press, and onEnd({press,tap,drop}) - also
// for a press cut off by cancel, lost capture, a reused id, a mouse with no button held, blur or a hidden tab.
export function bindMapPointers({doc,win,signal,cardOf,scaleOf,live=()=>true,onPress,onDrag,onEnd}){
  const t=pointerTracker(),off=new AbortController(),opts={capture:true,signal:off.signal};
  if(signal?.aborted)off.abort();else signal?.addEventListener('abort',()=>off.abort(),{once:true,signal:off.signal});
  const on=(target,type,fn,capture=true)=>target.addEventListener(type,ev=>{if(!live())return off.abort();fn(ev);},{...opts,capture});
  const end=r=>{if(r)onEnd(r);};
  const cut=g=>{if(g)onEnd({press:g,tap:false,drop:false});};
  const clear=()=>cut(trackClear(t));
  // The card is read before a cut-off drag is undone: undoing it redraws the map, detaching ev.target.
  on(doc,'pointerdown',ev=>{const card=cardOf(ev);cut(trackStale(t,ev,true));const g=trackDown(t,ev,card);if(g)onPress(g);});
  on(doc,'pointermove',ev=>{cut(trackStale(t,ev));const g=trackMove(t,ev,t.press?.id===ev.pointerId?scaleOf():1);if(g?.moved&&!g.touch)onDrag(g,ev);});
  on(doc,'pointerup',ev=>end(trackUp(t,ev)));
  on(doc,'pointercancel',ev=>end(trackUp(t,ev,true)));
  on(doc,'lostpointercapture',ev=>end(trackUp(t,ev,true)));
  // The window's own blur only: focus moving between elements (a card has tabindex) fires blur too, and a
  // capturing window listener would see it.
  on(win,'blur',ev=>{if(ev.target===win)clear();},false);
  on(doc,'visibilitychange',()=>{if(doc.visibilityState==='hidden')clear();});
  return {tracker:t,stop:()=>off.abort()};
}
function geometry(a,b){
  const ay=a.y+H/2,by=b.y+H/2,acx=a.x+W/2,bcx=b.x+W/2;
  if(Math.abs(bcx-acx)<W*0.75){const sx=Math.max(a.x,b.x)+W,bx=sx+14+Math.min(Math.abs(by-ay)*0.06,22);return {d:`M ${a.x+W} ${ay} C ${bx} ${ay}, ${bx} ${by}, ${b.x+W+2} ${by}`,mx:0.25*sx+0.75*bx,my:(ay+by)/2};}
  const right=bcx>acx,x1=right?a.x+W:a.x,x2=right?b.x-2:b.x+W+2,h=(x2-x1)/2;
  return {d:`M ${x1} ${ay} C ${x1+h} ${ay}, ${x1+h} ${by}, ${x2} ${by}`,mx:x1+h,my:(ay+by)/2};
}
// signal: the map's lifetime; aborting it removes the map's document and window listeners.
function map(src,signal){
  const layout=layoutLoad();let doc=src,byId,all;
  const top=el('div',{class:'inv-impact'}),show=el('div',{class:'inv-chips'}),depRow=el('div',{class:'inv-chips'}),arrange=el('div',{class:'inv-chips inv-ticks'}),wrap=el('div',{class:'inv-map-wrap'});
  // Clicking the selected card again clears the highlight; list entries always select.
  const select=id=>{state.mapSelected=id;state.listOpen={};draw();};
  const toggle=id=>select(state.mapSelected===id?null:id);
  const save=()=>{layoutSave(layout);draw();};
  const saved=()=>layout.modes[layout.columns];
  // Pointers: one tracker for the whole map (bindMapPointers); cur is the drawing it acts on. draw() replaces
  // it, and a press that began on an older drawing does nothing. Taps select on every device; only a mouse
  // or pen drags cards (touch swipes scroll the page). The listeners go with `signal`; isConnected is a
  // backstop for a map that was on the page and then dropped without a dispose (seen: it was attached, which
  // the caller does right after map() returns).
  let cur=null,seen=false;queueMicrotask(()=>{if(wrap.isConnected)seen=true;});
  bindMapPointers({doc:document,win:window,signal,live:()=>wrap.isConnected?(seen=true):!seen,
    cardOf:ev=>{const n=ev.target?.closest?.('.inv-node');return n&&cur?.idOf.get(n)||null;},
    scaleOf:()=>cur?.svgEl.getScreenCTM()?.a||1,
    onPress:p=>{p.view=cur;if(p.touch)return;const members=layout.together?cur.colOf.get(p.card).cards.map(x=>x.id):[p.card];
      Object.assign(p,{members,start:new Map(members.map(id=>[id,{...cur.pos.get(id)}]))});},
    onDrag:(p,ev)=>{const v=cur;if(p.view!==v)return;const k=v.svgEl.getScreenCTM()?.a||1,dx=(ev.clientX-p.x)/k,dy=(ev.clientY-p.y)/k;
      if(!p.dragging){p.dragging=true;for(const id of p.members){const n=v.nodeEls.get(id);n.classList.add('dragging');n.parentNode.append(n);}}
      for(const [id,s] of p.start){const q=v.pos.get(id);q.x=Math.max(0,Math.round(s.x+dx));q.y=Math.max(40,Math.round(s.y+dy));v.nodeEls.get(id).setAttribute('transform',`translate(${q.x} ${q.y})`);}
      v.relink(new Set(p.members));},
    // A swipe or a spoiled click does nothing; a drag cut off by cancel, blur or a hidden tab goes back.
    onEnd:({press:p,tap,drop})=>{if(p.view!==cur)return;if(tap)return toggle(p.card);if(drop)return cur.drop(p.card);if(p.dragging)draw();}});
  let pos=new Map(),shown=[];
  const spacing=()=>({ROW:layout.spacing==='roomy'?66:48,COL:W+(layout.spacing==='roomy'?96:40),TOP:48});
  // Columns in the saved order, cards in the saved order; a card with no saved place goes right after its default neighbour.
  function arranged(list){
    const s=saved(),gs=columnGroups(list,layout.columns);gs.forEach((g,i)=>g.rank=i);
    const ci=g=>{const i=(s.cols||[]).indexOf(g.label);return i<0?1000+g.rank:i;};gs.sort((a,b)=>ci(a)-ci(b));
    for(const g of gs){const rank=new Map((s.order[g.label]||[]).map((id,i)=>[id,i]));if(!rank.size)continue;
      const out=g.cards.filter(e=>rank.has(e.id)).sort((a,b)=>rank.get(a.id)-rank.get(b.id));
      g.cards.forEach((e,i)=>{if(rank.has(e.id))return;const prev=i?g.cards[i-1]:null;out.splice(prev?out.indexOf(prev)+1:0,0,e);});
      g.cards=out;}
    return gs;
  }
  const lay=(gs,COL,ROW,TOP)=>{const p=new Map();gs.forEach((g,i)=>g.cards.forEach((e,r)=>p.set(e.id,{x:i*COL+12,y:TOP+r*ROW})));return {p,lanes:gs.map((g,i)=>({label:g.label,x:i*COL}))};};
  // Put `id` into the full saved order `full` (hidden items included) right before the visible item that now follows it.
  const place_=(full,visible,id)=>{const out=full.filter(x=>x!==id),next=visible[visible.indexOf(id)+1],prev=visible[visible.indexOf(id)-1];
    if(next&&out.includes(next))out.splice(out.indexOf(next),0,id);else if(prev&&out.includes(prev))out.splice(out.indexOf(prev)+1,0,id);else out.push(id);return out;};
  function draw(){
    const {ROW,COL,TOP}=spacing(),hiddenCats=new Set(layout.hiddenCats);
    doc=layout.secretItems?withSecretItems(src):src;({byId}=index(doc));all=deps(doc);
    if(state.mapSelected&&!byId.has(state.mapSelected))state.mapSelected=null;
    const sel=state.mapSelected&&byId.get(state.mapSelected);
    const needs=sel?walk(doc,sel.id,true,state.hidden):{out:[],seen:new Set(),edges:new Set()},breaks=sel?walk(doc,sel.id,false,state.hidden):{out:[],seen:new Set(),edges:new Set()};
    const touches=k=>k.split('>').includes(sel?.id);
    const connected=layout.depth==='all'?{seen:new Set([...needs.seen,...breaks.seen]),edges:new Set([...needs.edges,...breaks.edges])}
      :{seen:new Set([sel?.id,...needs.out.filter(x=>x.depth===1).map(x=>x.id),...breaks.out.filter(x=>x.depth===1).map(x=>x.id)]),edges:new Set([...needs.edges,...breaks.edges].filter(touches))};
    const active=state.mapMode==='needs'?needs:state.mapMode==='impact'?breaks:connected;
    const focus=!!sel&&layout.focus;
    shown=doc.entries.filter(e=>(state.mapStores||!['model-store','skill-store','secret-store'].includes(e.kind))&&!hiddenCats.has(catOf(e))&&(!focus||active.seen.has(e.id)));
    // Always packed: only visible columns get a lane, and cards stack in their saved order with no gaps.
    const gs=arranged(shown),fresh=lay(gs,COL,ROW,TOP),colOf=new Map(gs.flatMap(g=>g.cards.map(c=>[c.id,g])));
    pos=new Map(shown.map(e=>[e.id,{...(fresh.p.get(e.id)||{x:12,y:TOP})}]));
    const laneList=fresh.lanes;
    const {width,height}=mapExtent([...pos.values()],laneList.length,{COL,ROW,TOP});
    const lanes=laneList.map(l=>[svg('rect',{x:l.x,y:0,width:W+24,height,rx:10,class:l.label==='Mimo dům'||l.label==='SaaS'?'inv-lane outside':'inv-lane'}),svg('text',{x:l.x+12,y:28,class:'inv-lane-label'},t(l.label).toUpperCase())]);
    // Runs-on is drawn only when columns are categories: in machine columns the column already says it.
    const edges=[],labels=[],lines=[];
    for(const l of all){
      if(!pos.has(l.from)||!pos.has(l.to)||state.hidden.has(l.kind))continue;
      if(l.kind==='runs-on'&&layout.columns!=='category')continue;
      const hot=!!sel&&active.edges.has(`${l.from}>${l.to}`)&&active.seen.has(l.from)&&active.seen.has(l.to);
      if(!hot&&(layout.lines==='chain'||l.kind==='runs-on'))continue;
      const g=geometry(pos.get(l.from),pos.get(l.to)),path=svg('path',{d:g.d,'marker-end':`url(#inv-arrow-${hot?'hot':'dim'})`});
      const group=svg('g',{class:`inv-edge ${l.kind} ${hot?'hot':''}`},path);
      hot?edges.push(group):edges.unshift(group);
      const label=hot&&l.label&&l.kind!=='runs-on'?svg('text',{x:g.mx,y:g.my+4,class:'inv-edge-label','text-anchor':'middle'},clip(t(l.label),26)):null;
      if(label)labels.push(label);
      lines.push({...l,path,label});
    }
    let svgEl;const nodeEls=new Map(),idOf=new Map();
    const relink=ids=>{for(const l of lines)if(ids.has(l.from)||ids.has(l.to)){const g=geometry(pos.get(l.from),pos.get(l.to));l.path.setAttribute('d',g.d);if(l.label){l.label.setAttribute('x',g.mx);l.label.setAttribute('y',g.my+4);}}};
    // A mouse or pen drag of card `id` was dropped: save where it landed.
    const drop=id=>{
      if(focus)return draw();// focus layouts are temporary
      const s=saved(),g=colOf.get(id);
      if(layout.together){// whole column: reorder columns by where it was dropped
        const xs=new Map(gs.map(c=>[c.label,c===g?pos.get(id).x:fresh.p.get(c.cards[0].id).x])),visible=gs.map(c=>c.label).sort((a,b)=>xs.get(a)-xs.get(b));
        s.cols=place_([...(s.cols||[]),...gs.map(c=>c.label).filter(l=>!(s.cols||[]).includes(l))],visible,g.label);}
      else{// one card: reorder inside its own column by where it was dropped
        const visible=g.cards.map(c=>c.id).sort((a,b)=>pos.get(a).y-pos.get(b).y),known=s.order[g.label]||[];
        s.order[g.label]=place_([...known,...g.cards.map(c=>c.id).filter(x=>!known.includes(x))],visible,id);}
      save();};
    const nodes=shown.map(e=>{const p=pos.get(e.id),on=!sel||active.seen.has(e.id),isSel=e.id===sel?.id,cat=catOf(e);
      const sub=e.address||e.type||kindName(e.kind),tag=layout.columns==='category'&&e.kind!=='machine'&&placeOf(e.machine)?.short?`${placeOf(e.machine).short} · `:'';
      const node=svg('g',{class:`inv-node cat-${cat} ${on?'on':'dim'} ${isSel?'selected':''} ${sel?state.mapMode:''}`,transform:`translate(${p.x} ${p.y})`,tabindex:'0',role:'button','aria-pressed':String(isSel),
        'aria-label':`${e.name}, ${catLabel(cat)}. ${isSel?t('Vybráno; dalším stiskem výběr zrušíš.'):t('Stiskem zvýrazníš jeho závislosti.')}${layout.together?` ${t('Tažením posuneš celý sloupec.')}`:''}`,
        onkeydown:ev=>{if(ev.key==='Enter'||ev.key===' '){ev.preventDefault();toggle(e.id);}}},// pointers: bindMapPointers in map()
        svg('title',{},`${e.name} · ${catLabel(cat)}${e.address?` · ${e.address}`:''}`),svg('rect',{width:W,height:H,rx:8}),svg('circle',{cx:12,cy:H/2,r:4.5,class:'dot'}),
        svg('text',{x:22,y:17,class:'name'},clip(e.name,21)),svg('text',{x:22,y:31,class:'sub'},clip(tag+sub,24)));
      nodeEls.set(e.id,node);idOf.set(node,e.id);return node;});
    const marker=id=>svg('marker',{id,class:id,viewBox:'0 0 10 10',refX:'9',refY:'5',markerWidth:id.endsWith('hot')?'7':'6',markerHeight:id.endsWith('hot')?'7':'6',orient:'auto'},svg('path',{d:'M 0 0 L 10 5 L 0 10 z'}));
    svgEl=svg('svg',{viewBox:`0 0 ${width} ${height}`,width,height,role:'group','aria-label':t('Mapa závislostí'),onclick:ev=>{if(sel&&!ev.target.closest('.inv-node'))select(null);}},
      svg('defs',{},marker('inv-arrow-hot'),marker('inv-arrow-dim')),lanes,edges,nodes,labels);
    cur={svgEl,idOf,nodeEls,pos,colOf,relink,drop};
    wrap.replaceChildren(svgEl);
    // Lists show the first 5 (direct links come first); the rest open on demand. The panels keep one height.
    const list=(res,empty,key)=>{if(!sel)return el('p',{class:'muted inv-walk-empty'},empty);if(!res.out.length)return el('p',{class:'muted inv-walk-empty'},key==='needs'?t('Zatím nemá zapsané závislosti.'):t('Nic zapsaného na něm nezávisí.'));
      const open=!!state.listOpen?.[key],items=open?res.out:res.out.slice(0,5);
      return [el('ul',{class:'inv-walk'},items.map(x=>el('li',{class:`depth-${Math.min(x.depth,4)}`},el('button',{type:'button',class:'inv-name',title:byId.get(x.id)?.name||x.id,onclick:()=>select(x.id)},el('span',{},byId.get(x.id)?.name||x.id),el('small',{},`${x.depth>1?`${t('nepřímo')} · `:''}${x.label?t(x.label):x.kind==='runs-on'?t('běží na'):DEPS[x.kind]?t(DEPS[x.kind]):x.kind}`))))),
        res.out.length>5?el('button',{type:'button',class:'inv-more','aria-expanded':String(open),onclick:()=>{state.listOpen={...state.listOpen,[key]:!open};draw();}},open?t('Méně'):t('Další {n}',{n:res.out.length-5})):''];};
    const mode=(m,label)=>el('button',{type:'button',class:state.mapMode===m?'active':'','aria-pressed':String(state.mapMode===m),onclick:()=>{state.mapMode=m;draw();}},label);
    // The selected card's key facts: versions (admins), address with clickable URLs, how to log in, which secrets and where, notes.
    const facts=e=>{if(!e)return '';const rows=[];
      if(e.address)rows.push([t('Adresa'),linkify(e.address),e.address]);
      if(e.login)rows.push([t('Jak se přihlásit'),e.login,e.login]);
      if(e.secrets?.length){const text=e.secrets.map(x=>`${x.what} · ${store(x.store)[0]}${x.ref?` · ${x.ref}`:''}`).join('; ');rows.push([t('Tajemství · {n}',{n:e.secrets.length}),text,text]);}
      return el('div',{class:'inv-facts'},versionBlock(e),el('dl',{},rows.map(([k,v,tip])=>[el('dt',{},k),el('dd',{title:tip},v)])),e.notes?el('p',{class:'inv-notes',title:e.notes},e.notes):'');};
    top.replaceChildren(el('div',{class:'inv-card inv-selected'},el('span',{class:'eyebrow'},t('VYBRÁNO')),
        sel?[el('h2',{title:sel.name},sel.name),el('p',{class:'muted'},`${place(sel)} · ${catLabel(catOf(sel))}${sel.version?` · ${sel.version}`:''}`),facts(sel)]:[el('h2',{class:'muted'},t('Nic není vybráno')),el('p',{class:'muted'},systems?t('Klikni na kartu: ukáže se adresa, přihlášení, tajemství a nainstalovaná verze a zvýrazní se, s čím souvisí. Dalším klikem výběr zrušíš.'):t('Klikni na kartu: ukáže se adresa, přihlášení, tajemství a zvýrazní se, s čím souvisí. Dalším klikem výběr zrušíš.'))],
        el('div',{class:'inv-sel-actions'},el('div',{class:'inv-mode',role:'group','aria-label':t('Zvýraznit na mapě')},mode('connected',t('Souvisí')),mode('needs',t('Potřebuje')),mode('impact',t('Rozbije'))),
          el('button',{type:'button',class:'inv-btn',...(sel?{onclick:()=>showDetail(src,sel.virtual?sel.store:sel.id)}:{disabled:''})},sel?.virtual?t('Otevřít úložiště'):t('Otevřít záznam')))),
      el('div',{class:'inv-card'},el('span',{class:'eyebrow'},`${t('POTŘEBUJE')}${sel?` · ${needs.out.length}`:''}`),list(needs,t('Tady bude, co vybraná karta potřebuje.'),'needs')),
      el('div',{class:'inv-card inv-breaks'},el('span',{class:'eyebrow'},`${t('KDYŽ SELŽE, ZASTAVÍ SE')}${sel?` · ${breaks.out.length}`:''}`),list(breaks,t('Tady bude, co se zastaví, když selže.'),'breaks')));
    const chip=(label,on,fn,extra='')=>el('button',{type:'button',class:`inv-chip ${on?'on':''} ${extra}`,'aria-pressed':String(on),onclick:fn},label);
    const base=doc.entries.filter(e=>state.mapStores||!['model-store','skill-store','secret-store'].includes(e.kind));
    // Category chips cycle: shown → only this one → hidden (the others come back as they were) → shown.
    const cats=CATS.filter(([k])=>base.some(e=>catOf(e)===k)),keys=cats.map(([k])=>k),visible=keys.filter(k=>!hiddenCats.has(k));
    const stepOf=k=>hiddenCats.has(k)?'off':visible.length===1&&visible[0]===k&&keys.length>1?'solo':'on';
    const step=k=>{const now=stepOf(k);
      if(now==='on'){layout.soloPrev=layout.hiddenCats.filter(x=>x!==k);layout.hiddenCats=keys.filter(x=>x!==k);}
      else if(now==='solo'){layout.hiddenCats=[...new Set([...(layout.soloPrev||[]),k])];layout.soloPrev=null;}
      else layout.hiddenCats=layout.hiddenCats.filter(x=>x!==k);
      save();};
    const next={on:l=>t('Klikni: jen {category}',{category:l}),solo:l=>t('Klikni: skrýt {category} a vrátit ostatní',{category:l}),off:l=>t('Klikni: znovu ukázat {category}',{category:l})};
    show.replaceChildren(el('span',{class:'inv-chip-title'},t('Ukázat')),
      ...cats.map(([k,cs])=>{const st=stepOf(k),l=t(cs);return el('button',{type:'button',class:`inv-chip inv-cat cat-${k} ${st==='off'?'off':''} ${st==='solo'?'solo':''}`,'aria-pressed':String(st!=='off'),title:next[st](l),onclick:()=>step(k)},
        el('span',{class:'inv-swatch'}),`${l} · ${base.filter(e=>catOf(e)===k).length}`,st==='solo'?el('span',{class:'inv-only'},t('jen')):'');}),
      layout.hiddenCats.length?el('button',{type:'button',class:'inv-more inv-show-all',onclick:()=>{layout.hiddenCats=[];layout.soloPrev=null;save();}},t('Ukázat vše')):'',
      el('span',{class:'inv-chip-gap'}),
      chip(t('Úložiště (modely, skilly, tajemství)'),state.mapStores,()=>{state.mapStores=!state.mapStores;draw();}),
      chip(t('Položky tajemství'),layout.secretItems,()=>{layout.secretItems=!layout.secretItems;save();}));
    depRow.replaceChildren(el('span',{class:'inv-chip-title'},t('Závislosti')),
      ...Object.entries(DEPS).map(([k,l])=>{const off=state.hidden.has(k);return el('button',{type:'button',class:`inv-chip ${off?'off':''}`,'aria-pressed':String(!off),title:t(DEP_HELP[k]),onclick:()=>{off?state.hidden.delete(k):state.hidden.add(k);draw();}},svg('svg',{width:26,height:8,class:'inv-sample','aria-hidden':'true'},svg('line',{x1:0,y1:4,x2:26,y2:4,class:k})),t(l));}),
      el('span',{class:'inv-chip-gap'}),
      state.mapMode==='connected'?chip(t('I nepřímé'),layout.depth==='all',()=>{layout.depth=layout.depth==='all'?'direct':'all';save();}):'',
      chip(t('Jen související karty'),layout.focus,()=>{layout.focus=!layout.focus;save();}),
      chip(t('Všechny vazby'),layout.lines==='all',()=>{layout.lines=layout.lines==='all'?'chain':'all';save();}));
    const custom=!!saved().cols||Object.values(saved().order).some(a=>a.length);
    const cols=(m,label)=>el('button',{type:'button',class:layout.columns===m?'active':'','aria-pressed':String(layout.columns===m),onclick:()=>{layout.columns=m;save();}},label);
    arrange.replaceChildren(el('span',{class:'inv-chip-title'},t('Sloupce')),el('div',{class:'inv-mode inv-cols',role:'group','aria-label':t('Sloupce')},cols('machine',t('Podle stroje')),cols('category',t('Podle kategorie'))),
      el('span',{class:'inv-chip-gap'}),
      chip(t('Posouvat celý sloupec'),layout.together,()=>{layout.together=!layout.together;save();}),
      el('button',{type:'button',class:'inv-chip',...(custom?{}:{disabled:''}),onclick:()=>{saved().cols=null;saved().order={};save();}},t('Výchozí pořadí')),
      chip(t('Volnější rozestupy'),layout.spacing==='roomy',()=>{layout.spacing=layout.spacing==='roomy'?'compact':'roomy';save();}),
      el('small',{class:'muted'},[layout.together?t('Tažením karty nahoru nebo dolů změníš pořadí ve sloupci; tažením do strany posuneš celý sloupec.'):t('Tažením karty nahoru nebo dolů změníš pořadí ve sloupci.'),layout.columns==='category'?t('Každá karta říká, na kterém stroji běží.'):t('Každý stroj má svůj sloupec.'),t('Uloženo v tomto prohlížeči.')].join(' ')));
  }
  draw();redraw=draw;
  const fit=el('button',{type:'button',class:'inv-btn phone-only','aria-pressed':'false',onclick:()=>{const on=wrap.classList.toggle('fit');fit.setAttribute('aria-pressed',String(on));fit.textContent=on?t('Skutečná velikost'):t('Přizpůsobit obrazovce');}},t('Přizpůsobit obrazovce'));
  return el('div',{},top,show,depRow,arrange,fit,wrap);
}

// me: the /api/me document. The version block needs what #versions needs (admin); others never fetch it.
// Lifetime: the shell's leaveView() (navigation, re-render, sign-in) disposes the view, which removes the map's
// document/window listeners. A load that finishes after that draws and binds nothing. Each map drawn here
// disposes the one before it.
export function inventoryView(me){
  const body=el('div',{},el('p',{class:'muted'},t('Načítám inventář…')));
  const who=currentPrincipal(),life=new AbortController();let mapLife=null;
  onLeave(()=>{life.abort();mapLife?.abort();});
  const show=({doc,gaps})=>{if(life.signal.aborted)return;mapLife?.abort();mapLife=new AbortController();
    body.replaceChildren(stats(doc,gaps),el('div',{class:'inv-source'},el('p',{class:'muted'},t('Z data/knowledge.json · aktualizováno {when} · agenti ho udržují skillem home-inventory.',{when:doc.updated_at})),el('a',{class:'inv-btn',href:'/api/inventory/export',download:''},'Export JSON')),map(doc,mapLife.signal));};
  load().then(show).catch(e=>{if(!life.signal.aborted)body.replaceChildren(el('p',{class:'inv-empty'},t(e.message)));});
  if(pageAllowed('versions',me))loadSystems().then(d=>{if(who!==currentPrincipal()||life.signal.aborted)return;systems=d;if(body.isConnected)redraw?.();}).catch(()=>{});
  return el('div',{class:'inv-page'},el('div',{class:'dev-head'},el('div',{class:'dev-title'},el('a',{class:'home-back',href:'#overview'},`← ${t('Přehled')}`),el('h2',{},t('Mapa inventáře')),
    el('div',{class:'dev-host'},t('Co běží kde, jak se přihlásit, kde je které tajemství a co na čem závisí.')))),body);
}
// Page entry for the shell (app.js): every page module exports (context) => Node, and the server's UI
// manifest names it. context = {me, page, sub, machine, site}.
export const inventoryPage=({me})=>inventoryView(me);
