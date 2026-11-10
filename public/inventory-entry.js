// One dialog for an inventory entry: its detail, the form that edits or creates it, deleting it, and
// importing a file. It lives outside #root, so a re-render of the page keeps it; a click on the backdrop
// or Escape closes it.
// The form checks itself with the server's own checker (inventory-rules.js → check), run on the whole
// document with the draft in place: what it says under a field is what the server would answer.
// Secrets are only ever locations (store + item name); the checker refuses anything that looks like a value.
import {canWrite} from './access.js';
import {t} from './i18n.js';
import {el} from './views.js';
import {pill,statusPill,when} from './systems-view.js';
import {versionRows,machineOs,versionSummary,systemMachineOf} from './inventory-versions.js';
import {check,dependents,withFields,templateEntries,KINDS,PLACED_KINDS,LINK_KINDS,ENTRY_FIELDS,LIMITS} from './inventory-rules.js';
import {GROUPS,DEPS,CATS,CAT_LABEL,DEFAULT_CAT,OTHER,catOf,kindName,typeTag,place,placeName,store,storeSuggestions,siteStores,index,isExample,
 cached,hashOf,invalidate,load,systemsDoc,saveFields,removeEntry,bulkUpsert,announce} from './inventory-data.js';

export const badge=(text,tone='')=>el('span',{class:`inv-badge ${tone}`},text);
export const kindBadge=e=>badge(e.kind==='runtime'||e.kind==='tool'?typeTag(e):kindName(e.kind),`kind-${e.kind}`);
const link=(text,url)=>url?el('a',{href:url,target:'_blank',rel:'noopener noreferrer'},text):text;
// Text with every http(s) URL turned into a link that opens in a new tab.
export const linkify=text=>String(text||'').split(/(https?:\/\/[^\s;,)]+)/).map((part,i)=>i%2?el('a',{href:part,target:'_blank',rel:'noopener noreferrer'},part):part);
const today=()=>new Date().toISOString().slice(0,10);
const clip=(s,n)=>{const x=String(s??'');return x.length>n?`${x.slice(0,n-1)}…`:x;};

// Installed version and update from Systémy, with the same words as Verze a aktualizace: an update is
// shown even if the last upstream check failed (it still proves a newer release), flagged "neověřeno".
export function versionBlock(e){
 const systems=systemsDoc();if(!systems)return '';
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

// --- the dialog ------------------------------------------------------------------------------
function dialogEl(){
 let d=document.querySelector('#inv-detail');if(d)return d;
 d=el('dialog',{id:'inv-detail',class:'inv-dialog','aria-labelledby':'inv-detail-title',onclick:ev=>{if(ev.target===d)d.close();}});
 document.body.append(d);return d;
}
const dialogHead=(eyebrow,close)=>el('header',{class:'inv-dialog-head'},el('span',{class:'eyebrow'},eyebrow),el('button',{type:'button',class:'inv-btn quiet',onclick:()=>dialogEl().close(),'aria-label':close},t('Zavřít ×')));
function open(...children){const d=dialogEl();d.replaceChildren(...children);if(!d.open)d.showModal?.();d.scrollTop=0;return d;}
const docNow=()=>cached()?.doc||{schema:1,updated_at:null,entries:[]};

// --- detail ----------------------------------------------------------------------------------
function detail(doc,e,pick){
 const {byId,usedBy}=index(doc);
 const crumbs=e.kind==='network'?t('Nejvyšší úroveň'):e.kind==='machine'?t('Domácí síť'):e.kind==='external'?t('Vnější služby'):`${place(e)} › ${GROUPS[e.kind]?t(GROUPS[e.kind]):kindName(e.kind)}`;
 const row=(label,value,mono,always=true)=>value?[el('dt',{},label),el('dd',{class:mono?'mono':''},typeof value==='string'?linkify(value):value)]:always?[el('dt',{},label),el('dd',{class:'muted'},t('Nezapsáno'))]:[];
 const links=(title,list)=>list.length?[el('h3',{},`${title} · ${list.length}`),el('div',{class:'inv-links'},list.map(x=>{const to=byId.get(x.id);return el('button',{class:'inv-btn',type:'button',onclick:()=>pick(x.id)},to?to.name:x.id,el('span',{class:'muted'},` · ${DEPS[x.kind]?t(DEPS[x.kind]):x.kind}${x.label?` · ${t(x.label)}`:''}`));}))]:[];
 const copy=text=>el('button',{class:'inv-btn',type:'button',onclick:async ev=>{const b=ev.currentTarget;try{await navigator.clipboard.writeText(text);b.textContent=t('Zkopírováno');}catch{b.textContent=t('Nejde zkopírovat');}}},t('Kopírovat'));
 const runsHere=e.kind==='machine'?doc.entries.filter(x=>x.machine===e.id&&x.id!==e.id).map(x=>({id:x.id,kind:'runs-on',label:''})):[];
 const status=el('span',{class:'inv-inline-status',role:'status'});
 // "Still true": stamps today's date and the person, changing nothing else.
 const confirm=el('button',{type:'button',class:'inv-btn',title:t('Zapíše dnešní datum ověření a nic jiného nezmění.'),onclick:async()=>{confirm.disabled=true;
   try{const r=await saveFields(e.id,hashOf(e.id),{});
    if(r.ok){await refresh();return showDetail(docNow(),e.id);}
    status.textContent=r.status===409?t('Záznam se mezitím změnil. Otevři ho znovu.'):t(r.body?.error?.message)||t('Uložení selhalo.');
   }catch{status.textContent=t('Home Hub není dosažitelný. Zkus to znovu.');}finally{confirm.disabled=false;}}},t('Stále platí'));
 return el('div',{class:'inv-detail'},
  el('p',{class:'muted inv-crumbs'},crumbs),
  el('div',{class:'inv-detail-head'},el('h2',{id:'inv-detail-title',class:`inv-title cat-${catOf(e)}`},el('span',{class:'inv-swatch','aria-hidden':'true'}),e.name),
   el('div',{class:'inv-head-actions'},kindBadge(e),isExample(e)?badge(t('Ukázka'),'amber'):null,canWrite()?[confirm,el('button',{type:'button',class:'inv-btn primary',onclick:()=>showEditor(e)},t('Upravit'))]:badge(t('Jen čtení')))),
  status,
  versionBlock(e),
  e.notes?el('p',{class:'muted inv-detail-notes'},linkify(e.notes)):'',
  el('dl',{class:'inv-dl'},row(t('Druh'),`${kindName(e.kind)}${e.type?` · ${e.type}`:''}`),row('ID',e.id,true),e.kind!=='network'&&e.kind!=='external'&&(e.kind!=='machine'||e.machine)?row(t('Stroj'),e.kind==='machine'?placeName(e.machine):place(e)):[],row(t('Adresa'),e.address,true,e.kind==='runtime'||e.kind==='machine'),row(t('Verze (zapsaná)'),e.version,false,false),row(t('Konfigurace'),e.config,true,e.kind!=='external'),row(t('Data'),e.data,true,false),row(t('Spravuje'),e.managed_by,true,false),row(t('Jak se přihlásit'),e.login,false,false)),
  e.models?.length?[el('h3',{},t('Modely · {n}',{n:e.models.length})),el('ul',{class:'inv-list mono'},e.models.map(m=>el('li',{},m)))]:'',
  e.skills?.length?[el('h3',{},t('Skilly · {n}',{n:e.skills.length})),el('ul',{class:'inv-list mono'},e.skills.map(m=>el('li',{},m)))]:'',
  el('h3',{},t('Tajemství · kde jsou uložená')),
  (e.secrets||[]).length?el('div',{class:'inv-secrets'},e.secrets.map(s=>{const [label,tone]=store(s.store);return el('div',{class:`inv-secret ${s.store==='unknown'?'gap':''}`},
   el('div',{class:'inv-secret-head'},el('strong',{},s.what),badge(label,tone)),
   s.ref?el('p',{class:'mono'},s.ref):'',
   s.check?el('div',{class:'inv-check'},el('code',{},s.check),copy(s.check)):'',
   s.store==='unknown'?el('small',{class:'amber-text'},t('Ještě nezapsáno. Doplň, kde je uložené — nikdy hodnotu.')):'');})):el('p',{class:'muted'},t('U tohoto záznamu nejsou žádná tajemství.')),
  links(t('Závisí na'),e.depends_on||[]),links(t('Používají ho'),usedBy.get(e.id)||[]),links(t('Běží na něm'),runsHere),
  el('p',{class:'muted inv-verified'},`${t('Naposledy ověřeno {when}',{when:e.verified_at})} · ${e.verified_by||t('zdroj nezapsán')}${e.confidence==='inferred'?` · ${t('odvozeno, přímo neověřeno')}`:''}`));
}
export function showDetail(doc,id){
 const e=doc&&index(doc).byId.get(id);if(!e)return;
 open(dialogHead(t('ZÁZNAM INVENTÁŘE'),t('Zavřít záznam')),detail(doc,e,next=>showDetail(doc,next)));
}
// Reads the published file again and lets the page behind the dialog draw itself from it.
async function refresh(){invalidate();const fresh=await load();announce();return fresh;}

// --- what the checker says, in the reader's language -----------------------------------------
// Keyed by the issue code of inventory-rules.js → check(); an unknown code shows the checker's own text.
const ISSUE={
 'id-format':'ID smí obsahovat jen malá písmena, číslice a pomlčky a musí začínat písmenem.',
 'id-duplicate':'Záznam s tímhle ID už existuje.',
 kind:'Vyber druh záznamu.',
 'name-required':'Název je povinný.',
 category:'Tahle kategorie neexistuje.',
 'secret-what':'Napiš, co to je.',
 'secret-store':'Neznámé úložiště „{store}“. Vyber ze seznamu, nebo použij tvar jako keychain:<stroj>.',
 'secret-check':'Tenhle příkaz by tajemství vypsal ({why}). Použij takový, který jen ověří, že existuje.',
 'secret-value':'Vypadá to jako hodnota tajemství ({why}). Zapiš, kde je uložené, ne hodnotu.',
 'dep-kind':'Vyber druh závislosti.',
 'dep-self':'Záznam nemůže záviset sám na sobě.',
 'dep-missing':'Záznam „{target}“ neexistuje.',
 'machine-required':'Vyber stroj, na kterém běží.',
 'machine-missing':'Stroj „{machine}“ neexistuje.',
 'gap-address':'Služba bez adresy se počítá jako mezera.',
 'gap-store':'Nezapsané místo se počítá jako mezera.',
};
// The checker's reasons (English in its messages), as Czech source text for t().
const WHY={'Home Hub access key':'přístupový klíč Home Hubu','private key block':'blok soukromého klíče','API key':'API klíč','access token':'přístupový token',JWT:'JWT','assignment of a secret':'přiřazení tajemství','credentials in a URL':'přihlašovací údaje v URL','long hex string':'dlouhý hexadecimální řetězec','long random-looking string':'dlouhý náhodně vypadající řetězec',
 'security ... -w prints the password':'security … -w heslo vypíše','prints a secret file':'vypíše soubor s tajemstvím','prints an environment variable':'vypíše proměnnou prostředí','dumps the environment':'vypíše celé prostředí'};
export const issueText=i=>ISSUE[i.code]?t(ISSUE[i.code],{...i,why:WHY[i.why]?t(WHY[i.why]):i.why}):i.text||i.message||'';

// --- the form --------------------------------------------------------------------------------
const TEXT=[['name','Název'],['type','Typ'],['category','Kategorie na mapě'],['address','Adresa'],['version','Verze'],['managed_by','Spravuje'],['login','Jak se přihlásit'],['config','Konfigurace'],['data','Data'],['notes','Poznámky']];
const LABEL={...Object.fromEntries(TEXT),machine:'Stroj',secrets:'Tajemství',depends_on:'Závisí na',id:'ID',kind:'Druh'};
const LONG=new Set(['config','data','login','notes']);
const HINT={address:'host:port, URL nebo IP adresa',config:'Cesta ke konfiguraci, ne její obsah',login:'Slovy, jak se přihlásit. Nikdy heslo ani token.',managed_by:'launchd, systemd, kontejner, cron…'};
const norm=v=>typeof v==='string'?v.trim():'';
const secretsOf=e=>(e.secrets||[]).map(s=>Object.fromEntries(['what','store','ref','check'].map(f=>[f,norm(s?.[f])]).filter(([,v])=>v)));
const depsOf=e=>(e.depends_on||[]).map(d=>({id:d?.id||'',...(norm(d?.kind)?{kind:norm(d.kind)}:{}),...(norm(d?.label)?{label:norm(d.label)}:{})}));
// From a name to an id: lowercase ASCII words joined by hyphens, starting with a letter.
export function slug(text){
 const s=String(text||'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,LIMITS.idLength).replace(/-+$/,'');
 return s&&!/^[a-z]/.test(s)?`x-${s}`.slice(0,LIMITS.idLength):s;
}
// The fields of `values` (the form) that differ from `entry`: what an edit sends, and nothing else.
export function changedFields(entry,values){
 const out={};
 for(const [k] of TEXT)if(norm(values[k])!==norm(entry[k]))out[k]=norm(values[k]);
 if('machine'in values&&norm(values.machine)!==norm(entry.machine))out.machine=norm(values.machine);
 if(JSON.stringify(values.secrets)!==JSON.stringify(secretsOf(entry)))out.secrets=values.secrets;
 if(JSON.stringify(values.depends_on)!==JSON.stringify(depsOf(entry)))out.depends_on=values.depends_on;
 return out;
}

/**
 * The form for one entry. entry: the stored entry, or for a new one a stub {kind, machine}.
 * prefill: field values to put in the form instead of the entry's (edits carried over a conflict);
 * theirs: names of fields somebody else changed meanwhile, marked in the form; note: a line shown on top.
 */
export function showEditor(entry,{isNew=false,prefill=null,theirs=null,note=''}={}){
 const doc=docNow(),hash=isNew?null:hashOf(entry.id),inputs={},errors={},wraps={};
 const machines=doc.entries.filter(e=>e.kind==='machine'&&e.id!==entry.id);
 const start={...Object.fromEntries(TEXT.map(([k])=>[k,norm(entry[k])])),machine:norm(entry.machine),secrets:secretsOf(entry),depends_on:depsOf(entry),...prefill};
 const field=(k,label,input,{hint,wide}={})=>{
  errors[k]=el('small',{class:'inv-field-error',id:`inv-e-${k}`});inputs[k]=input;input.setAttribute('aria-describedby',`inv-e-${k}`);
  wraps[k]=el('div',{class:`inv-field${wide?' wide':''}${theirs?.has(k)?' theirs':''}`},el('label',{for:input.getAttribute('id')},label,theirs?.has(k)?el('span',{class:'inv-theirs'},t('změněno jinde')):null),input,hint?el('small',{class:'inv-hint'},hint):null,errors[k]);
  return wraps[k];};
 const text=k=>{const i=el(LONG.has(k)?'textarea':'input',{id:`inv-f-${k}`,name:k,rows:LONG.has(k)?(k==='notes'?'4':'2'):null,maxlength:String(k==='notes'?LIMITS.notesLength:LIMITS.textLength),autocomplete:'off',spellcheck:k==='notes'?null:'false'});i.value=start[k]||'';return i;};
 const select=(id,options,value)=>{const s=el('select',{id,name:id},options.map(([v,l])=>el('option',{value:v},l)));s.value=value;return s;};
 // New entries choose their id and kind; an existing entry keeps both for good.
 let idTouched=false;
 const idInput=el('input',{id:'inv-f-id',name:'id',maxlength:String(LIMITS.idLength),autocomplete:'off',spellcheck:'false',autocapitalize:'none',oninput:()=>{idTouched=true;}});
 const kindSelect=select('inv-f-kind',KINDS.map(k=>[k,`${kindName(k)} (${k})`]),KINDS.includes(entry.kind)?entry.kind:'runtime');
 const kind=()=>isNew?kindSelect.value:entry.kind;
 const machineSelect=select('inv-f-machine',[['',t('— žádný —')],...machines.map(m=>[m.id,`${m.name} (${m.id})`]),...(start.machine&&!machines.some(m=>m.id===start.machine)?[[start.machine,start.machine]]:[])],start.machine);
 const category=select('inv-f-category',[['',''],...CATS.map(([v,l])=>[v,t(l)])],start.category||'');
 const paintKind=()=>{const k=kind();category.children[0].textContent=t('Výchozí pro druh ({category})',{category:t(CAT_LABEL[DEFAULT_CAT[k]]||OTHER)});
  wraps.machine.hidden=!PLACED_KINDS.includes(k);wraps.machine.children[0].childNodes[0].textContent=k==='machine'?t('Běží na stroji (nepovinné)'):t('Stroj');};
 const basics=el('div',{class:'inv-fields'},
  field('name',t('Název'),text('name')),
  isNew?field('kind',t('Druh'),kindSelect):null,
  isNew?field('id','ID',idInput,{hint:t('Malá písmena, číslice a pomlčky. Už se nikdy nezmění.')}):null,
  field('machine',t('Stroj'),machineSelect),
  field('type',t('Typ'),text('type')),field('category',t('Kategorie na mapě'),category),
  field('address',t('Adresa'),text('address'),{hint:t(HINT.address)}),field('version',t('Verze'),text('version')),
  field('managed_by',t('Spravuje'),text('managed_by'),{hint:t(HINT.managed_by)}),field('login',t('Jak se přihlásit'),text('login'),{hint:t(HINT.login)}),
  field('config',t('Konfigurace'),text('config'),{hint:t(HINT.config)}),field('data',t('Data'),text('data')),
  field('notes',t('Poznámky'),text('notes'),{wide:true}));
 if(isNew)inputs.name.addEventListener('input',()=>{if(!idTouched)idInput.value=slug([PLACED_KINDS.includes(kind())?machineSelect.value:'',inputs.name.value].filter(Boolean).join(' '));});
 // Rows: where each secret is kept, and what the entry depends on.
 const secretRows=el('div',{class:'inv-rows'}),depRows=el('div',{class:'inv-rows'});
 const rowInput=(name,label,value,extra={})=>{const i=el('input',{name,'aria-label':label,placeholder:label,autocomplete:'off',spellcheck:'false',...extra});i.value=value||'';return i;};
 const addSecret=(s={})=>{const row=el('div',{class:'inv-row inv-secret-row'});
  row.append(rowInput('what',t('Co to je'),s.what,{maxlength:String(LIMITS.secretTextLength)}),rowInput('store',t('Kde je uložené'),s.store,{maxlength:String(LIMITS.secretTextLength),list:'inv-stores'}),rowInput('ref',t('Název položky, cesta nebo proměnná'),s.ref,{maxlength:String(LIMITS.secretTextLength)}),rowInput('check',t('Kontrolní příkaz (nesmí ho vypsat)'),s.check,{maxlength:String(LIMITS.secretTextLength)}),
   el('button',{type:'button',class:'inv-btn quiet','aria-label':t('Odebrat tajemství'),onclick:()=>{row.remove();validate();}},t('Odebrat')),el('small',{class:'inv-field-error'}));
  secretRows.append(row);return row;};
 const addDep=(d={})=>{const row=el('div',{class:'inv-row inv-dep-row'});
  const kindSel=el('select',{name:'kind','aria-label':t('Druh závislosti')},el('option',{value:''},t('— druh —')),LINK_KINDS.map(k=>el('option',{value:k},t(DEPS[k]))));kindSel.value=LINK_KINDS.includes(d.kind)?d.kind:d.id?'':'call';
  row.append(rowInput('id',t('ID záznamu, na kterém závisí'),d.id,{maxlength:String(LIMITS.idLength),list:'inv-entries',autocapitalize:'none'}),kindSel,rowInput('label',t('Popisek (nepovinný)'),d.label,{maxlength:String(LIMITS.labelLength)}),
   el('button',{type:'button',class:'inv-btn quiet','aria-label':t('Odebrat závislost'),onclick:()=>{row.remove();validate();}},t('Odebrat')),el('small',{class:'inv-field-error'}));
  depRows.append(row);return row;};
 start.secrets.forEach(addSecret);start.depends_on.forEach(addDep);
 // What the form holds now. rows: the row element behind each secrets[n] / depends_on[n] of the draft.
 const read=()=>{
  const value=row=>Object.fromEntries([...row.querySelectorAll('input,select')].map(i=>[i.name,i.value.trim()]));
  const sRows=[...secretRows.children].map(row=>[row,value(row)]).filter(([,v])=>v.what||v.store||v.ref||v.check);
  const dRows=[...depRows.children].map(row=>[row,value(row)]).filter(([,v])=>v.id||v.label);
  // machine is part of the form only for kinds that live on one; elsewhere whatever the entry holds is left alone.
  const values={...Object.fromEntries(TEXT.map(([k])=>[k,inputs[k].value.trim()])),...(PLACED_KINDS.includes(kind())?{machine:machineSelect.value}:{}),
   secrets:sRows.map(([,v])=>Object.fromEntries(Object.entries(v).filter(([,x])=>x))),depends_on:dRows.map(([,v])=>({id:v.id,...(v.kind?{kind:v.kind}:{}),...(v.label?{label:v.label}:{})}))};
  return {values,rows:{secrets:sRows.map(([r])=>r),depends_on:dRows.map(([r])=>r)}};
 };
 // The entry as the server would store it, and where it sits in the document the checker sees.
 const draft=values=>{
  if(!isNew)return {entry:withFields(entry,changedFields(entry,values)),changed:changedFields(entry,values)};
  return {entry:withFields({id:idInput.value.trim(),kind:kind(),verified_at:today()},values),changed:values};
 };
 const summary=el('div',{class:'inv-error',role:'alert'}),status=el('div',{class:'inv-form-status',role:'status'});
 const clearMarks=()=>{for(const k of Object.keys(errors)){errors[k].textContent='';errors[k].classList.remove('warn');inputs[k].removeAttribute('aria-invalid');}
  for(const row of [...secretRows.children,...depRows.children]){row.querySelector('.inv-field-error').textContent='';for(const i of row.querySelectorAll('input,select'))i.removeAttribute('aria-invalid');}};
 // Puts each issue under its field; returns the errors that have no field in this form.
 const mark=(issues,rows)=>{
  const loose=[];let first=null;
  for(const i of issues){
   const warn=i.level==='warning',m=/^(secrets|depends_on)\[(\d+)\](?:\.(\w+))?$/.exec(i.field||''),row=m?rows[m[1]][Number(m[2])]:null;
   if(row){const slot=row.querySelector('.inv-field-error');if(!warn||!slot.textContent){slot.textContent=issueText(i);slot.classList.toggle('warn',warn);}
    const input=[...row.querySelectorAll('input,select')].find(x=>x.name===m[3])||row.querySelector('input');if(!warn){input.setAttribute('aria-invalid','true');first??=input;}}
   else if(errors[i.field]&&!wraps[i.field].hidden){if(!warn||!errors[i.field].textContent){errors[i.field].textContent=issueText(i);errors[i.field].classList.toggle('warn',warn);}if(!warn){inputs[i.field].setAttribute('aria-invalid','true');first??=inputs[i.field];}}
   else if(!warn)loose.push(i);
  }
  return {loose,first};
 };
 // Runs the checker on the document with the draft in place and shows what concerns this entry.
 function validate(){
  const {values,rows}=read(),d=draft(values),entries=isNew?[...doc.entries,d.entry]:doc.entries.map(e=>e.id===entry.id?d.entry:e),at=isNew?entries.length-1:entries.findIndex(e=>e.id===entry.id);
  const issues=check({schema:1,updated_at:today(),entries},{secretStores:siteStores()}).issues.filter(i=>i.index===at);
  clearMarks();const {loose,first}=mark(issues,rows);
  summary.replaceChildren(...loose.map(i=>el('small',{},issueText(i))));
  return {values,rows,...d,failed:issues.some(i=>i.level==='error'),first};
 }
 let timer=null;const soon=()=>{clearTimeout(timer);timer=setTimeout(validate,200);};
 const save=el('button',{type:'submit',class:'inv-btn primary'},isNew?t('Založit záznam'):t('Uložit'));
 const actions=el('div',{class:'inv-edit-actions'});
 const normalActions=()=>actions.replaceChildren(
  !isNew?el('button',{type:'button',class:'inv-btn danger',onclick:askDelete},t('Smazat záznam')):el('span',{}),
  el('span',{class:'inv-actions-gap'}),
  el('button',{type:'button',class:'inv-btn',onclick:()=>isNew?dialogEl().close():showDetail(docNow(),entry.id)},t('Zrušit')),save);
 // The server refused: its issues go under the same fields as our own.
 const refused=(body,rows)=>{clearMarks();const issues=(body?.error?.issues||[]).filter(i=>!i.id||i.id===(isNew?idInput.value.trim():entry.id)).map(i=>({level:'error',...i}));
  const {loose,first}=mark(issues,rows),others=(body?.error?.issues||[]).filter(i=>i.id&&i.id!==(isNew?idInput.value.trim():entry.id));
  summary.replaceChildren(el('p',{},t(body?.error?.message)||t('Uložení selhalo.')),...(issues.length||others.length?[...loose,...others].map(i=>el('small',{},i.id&&others.includes(i)?`${i.id}: ${issueText(i)}`:issueText(i))):(body?.error?.details||[]).map(d=>el('small',{},t(d)))));
  first?.focus();};
 // 409: somebody saved this entry while the form was open. Show what they changed and let the person choose.
 async function conflict(values){
  let fresh;try{fresh=await refresh();}catch{summary.textContent=t('Záznam se mezitím změnil a novou verzi se nepodařilo načíst. Zkus to znovu.');return;}
  const now=fresh.doc.entries.find(e=>e.id===entry.id);
  if(!now){summary.replaceChildren(el('p',{},t('Tenhle záznam mezitím někdo smazal. Tvoje úpravy už není kam uložit.')));actions.replaceChildren(el('span',{class:'inv-actions-gap'}),el('button',{type:'button',class:'inv-btn primary',onclick:()=>dialogEl().close()},t('Zavřít')));return;}
  const mine=changedFields(entry,values),theirChanges=changedFields(entry,{...Object.fromEntries(TEXT.map(([k])=>[k,norm(now[k])])),machine:norm(now.machine),secrets:secretsOf(now),depends_on:depsOf(now)});
  const show=k=>Array.isArray(theirChanges[k])?t('změněno'):`${clip(norm(entry[k])||'—',40)} → ${clip(theirChanges[k]||'—',60)}`;
  const both=Object.keys(mine).filter(k=>k in theirChanges);
  summary.replaceChildren(el('div',{class:'inv-conflict'},
   el('h3',{},t('Tenhle záznam mezitím někdo změnil')),
   el('p',{},t('Tvoje úpravy se neuložily. Poslední změna: {who}, {when}.',{who:now.verified_by||t('zdroj nezapsán'),when:now.verified_at||'—'})),
   Object.keys(theirChanges).length?el('ul',{},Object.keys(theirChanges).map(k=>el('li',{},el('b',{},t(LABEL[k]||k)),': ',show(k)))):el('p',{class:'muted'},t('Obsah zůstal stejný, změnilo se jen ověření.')),
   both.length?el('p',{class:'amber-text'},t('Stejná pole jste změnili oba: {fields}. Když si své úpravy ponecháš, přepíšou jejich.',{fields:both.map(k=>t(LABEL[k]||k)).join(', ')})):null));
  actions.replaceChildren(el('span',{class:'inv-actions-gap'}),
   el('button',{type:'button',class:'inv-btn',onclick:()=>showEditor(now)},t('Načíst aktuální verzi')),
   el('button',{type:'button',class:'inv-btn primary',...(Object.keys(mine).length?{}:{disabled:''}),onclick:()=>showEditor(now,{prefill:mine,theirs:new Set(Object.keys(theirChanges)),note:t('Formulář teď vychází z aktuální verze a jsou v něm tvoje úpravy. Zkontroluj je a ulož.')})},t('Ponechat moje úpravy')));
 }
 function askDelete(){
  const inUse=dependents(doc,entry.id),byId=index(doc).byId;
  if(inUse.length){summary.replaceChildren(el('div',{class:'inv-conflict'},el('h3',{},t('Tenhle záznam teď smazat nejde')),el('p',{},t('Ještě na něm něco závisí nebo na něm běží. Nejdřív změň nebo smaž tyhle záznamy:')),
    el('div',{class:'inv-links'},inUse.slice(0,40).map(id=>el('button',{type:'button',class:'inv-btn',onclick:()=>showDetail(docNow(),id)},byId.get(id)?.name||id)))));return;}
  summary.replaceChildren(el('div',{class:'inv-conflict'},el('h3',{},t('Smazat „{name}“?',{name:entry.name})),el('p',{},t('Záznam zmizí z mapy i ze služeb. Nejde to vrátit.'))));
  const yes=el('button',{type:'button',class:'inv-btn danger solid',onclick:async()=>{yes.disabled=true;
    try{const r=await removeEntry(entry.id,hash);
     if(r.ok){dialogEl().close();return announce();}
     if(r.status===409){await refresh().catch(()=>{});summary.replaceChildren(el('p',{},t('Záznam se mezitím změnil, takže se nesmazal. Podívej se na aktuální verzi a rozhodni se znovu.')));
      return actions.replaceChildren(el('span',{class:'inv-actions-gap'}),el('button',{type:'button',class:'inv-btn primary',onclick:()=>showDetail(docNow(),entry.id)},t('Otevřít aktuální verzi')));}
     if(r.status===404){dialogEl().close();return refresh().catch(()=>{});}
     summary.replaceChildren(el('p',{},t(r.body?.error?.message)||t('Smazání selhalo.')),...(r.body?.error?.details||[]).slice(0,10).map(d=>el('small',{},d)));normalActions();
    }catch{summary.textContent=t('Home Hub není dosažitelný. Zkus to znovu.');normalActions();}}},t('Smazat natrvalo'));
  actions.replaceChildren(el('span',{class:'inv-actions-gap'}),el('button',{type:'button',class:'inv-btn',onclick:()=>{summary.replaceChildren();normalActions();}},t('Zpět')),yes);
 }
 const form=el('form',{class:'inv-edit',novalidate:'',oninput:soon,onchange:()=>{if(isNew){paintKind();if(!idTouched)idInput.value=slug([PLACED_KINDS.includes(kind())?machineSelect.value:'',inputs.name.value].filter(Boolean).join(' '));}soon();},onsubmit:async ev=>{ev.preventDefault();clearTimeout(timer);
   const v=validate();
   if(v.failed){status.textContent=t('Oprav označená pole.');v.first?.focus();return;}
   if(!isNew&&!Object.keys(v.changed).length){status.textContent=t('Nic se nezměnilo.');return;}
   save.disabled=true;status.textContent=t('Ukládám…');
   try{
    const r=isNew?await bulkUpsert([{entry:(({verified_at,...e})=>e)(v.entry)}]):await saveFields(entry.id,hash,v.changed);
    status.textContent='';
    if(r.ok){if(r.body.published===false){status.textContent=t('Uloženo, ale zveřejnění selhalo. Změna se tu ukáže po dalším publikování.');return;}dialogEl().close();return announce();}
    if(r.status===409)return isNew?refused({error:{message:'Záznam s tímhle ID mezitím někdo založil.',issues:[{id:v.entry.id,field:'id',code:'id-duplicate'}]}},v.rows):conflict(v.values);
    if(r.status===404&&!isNew){summary.replaceChildren(el('p',{},t('Tenhle záznam mezitím někdo smazal. Tvoje úpravy už není kam uložit.')));return refresh().catch(()=>{});}
    refused(r.body,v.rows);
   }catch{status.textContent='';summary.textContent=t('Home Hub není dosažitelný. Zkus to znovu.');}finally{save.disabled=false;}}},
  note?el('p',{class:'inv-note'},note):null,
  el('p',{class:'muted inv-edit-lead'},t('Změny se zkontrolují stejně jako úpravy agentů a uloží do inventáře. Zapisuj, kde je tajemství uložené, nikdy tajemství samotné.')),
  basics,
  el('h3',{},t('Tajemství · kde jsou uložená')),secretRows,el('datalist',{id:'inv-stores'},storeSuggestions(doc.entries).map(v=>el('option',{value:v}))),
  el('button',{type:'button',class:'inv-btn small',onclick:()=>addSecret().querySelector('input').focus()},t('+ Přidat tajemství')),
  el('h3',{},t('Závisí na')),el('p',{class:'muted inv-hint'},t('Co tenhle záznam potřebuje. Stroj, na kterém běží, sem nepatří: ten říká pole Stroj.')),depRows,
  el('datalist',{id:'inv-entries'},doc.entries.filter(e=>e.id!==entry.id).map(e=>el('option',{value:e.id},`${e.name} · ${kindName(e.kind)}`))),
  el('button',{type:'button',class:'inv-btn small',onclick:()=>addDep().querySelector('input').focus()},t('+ Přidat závislost')),
  summary,status,actions);
 normalActions();
 open(dialogHead(isNew?t('NOVÝ ZÁZNAM'):t('ÚPRAVA ZÁZNAMU'),t('Zavřít úpravu')),el('h2',{id:'inv-detail-title'},isNew?t('Nový záznam inventáře'):entry.name),form);
 paintKind();
 if(!isNew&&!hash){status.textContent=t('Před úpravou obnov stránku: záznam ještě nemá otisk verze.');save.disabled=true;}
 else if(prefill)validate();
 if(isNew)inputs.name.focus?.();
}
// A new entry. stub: {kind, machine} to start from (the services page starts with a runtime).
export const showCreate=(stub={})=>showEditor({kind:'runtime',...stub},{isNew:true});

// --- template, examples, import --------------------------------------------------------------
// Seeds the example entries. Resolves to {ok, message}; message is source text for t().
export async function seedTemplate(){
 const r=await bulkUpsert(templateEntries().map(entry=>({entry})));
 if(r.ok)return {ok:true};
 return {ok:false,message:r.status===409?'Ukázkové záznamy tu už jsou.':r.body?.error?.message||'Uložení selhalo.',details:r.body?.error?.details||[]};
}
// Deletes the example entries, the ones nothing depends on first. Resolves to {removed, kept}: kept are
// examples that something else still needs.
export async function removeExamples(){
 let removed=0;
 for(;;){
  const {doc,hashes}=await load(),examples=doc.entries.filter(isExample);
  const free=examples.find(e=>!dependents(doc,e.id).length);
  if(!free)return {removed,kept:examples.map(e=>e.id)};
  const r=await removeEntry(free.id,hashes[free.id]);
  if(!r.ok)return {removed,kept:examples.map(e=>e.id),message:r.body?.error?.message||''};
  removed++;
 }
}

// Reads an exported file: a whole document {entries: [...]} or a bare list of entries.
export function parseImport(text){
 let json;try{json=JSON.parse(text);}catch{return {error:'Tohle není platný JSON.'};}
 const entries=Array.isArray(json)?json:json&&Array.isArray(json.entries)?json.entries:null;
 if(!entries)return {error:'Soubor neobsahuje seznam záznamů (entries).'};
 if(!entries.length)return {error:'Soubor neobsahuje žádné záznamy.'};
 if(entries.length>LIMITS.bulkEntries)return {error:'Soubor má víc záznamů, než jde naráz nahrát ({max}).',vars:{max:LIMITS.bulkEntries}};
 if(entries.some(e=>!e||typeof e!=='object'||Array.isArray(e)||typeof e.id!=='string'))return {error:'Každý záznam musí být objekt s polem id.'};
 const unknown=[...new Set(entries.flatMap(e=>Object.keys(e).filter(k=>!ENTRY_FIELDS.includes(k))))];
 if(unknown.length)return {error:'Soubor obsahuje pole, která inventář nezná: {fields}.',vars:{fields:unknown.slice(0,8).join(', ')}};
 const ids=entries.map(e=>e.id);
 if(new Set(ids).size!==ids.length)return {error:'Některé ID je v souboru dvakrát.'};
 return {entries};
}
export function showImport(){
 const result=el('div',{class:'inv-import-result','aria-live':'polite'}),go=el('button',{type:'button',class:'inv-btn primary',disabled:''},t('Importovat'));
 let changes=null;
 const names=list=>list.length?el('p',{class:'mono inv-import-ids'},clip(list.join(', '),600)):null;
 const fail=(title,lines=[])=>{changes=null;go.disabled=true;result.replaceChildren(el('div',{class:'inv-conflict'},el('h3',{},title),...lines.slice(0,30).map(l=>el('small',{},l))));};
 const send=async dryRun=>{
  const hashes=(await load()).hashes;
  return bulkUpsert(changes.map(entry=>({entry,...(hashes[entry.id]?{base:hashes[entry.id]}:{})})),{dryRun,keepVerified:true});
 };
 // A dry run first: the server says what the file would create and change, or why it refuses it.
 const preview=async entries=>{
  changes=entries;result.replaceChildren(el('p',{class:'muted'},t('Kontroluji soubor…')));
  let r;try{r=await send(true);}catch{return fail(t('Home Hub není dosažitelný. Zkus to znovu.'));}
  const b=r.body;
  if(!r.ok)return fail(t(b?.error?.message)||t('Soubor se nepodařilo zkontrolovat.'),b?.error?.details||[]);
  if(b.conflicts)return fail(t('Inventář se mezitím změnil. Vyber soubor znovu.'),b.conflicts);
  if(!b.ok)return fail(t('Kontrola soubor odmítla ({n} chyb). Nic se nezměnilo.',{n:b.errorCount||b.errors.length}),b.issues?.length?b.issues.map(i=>`${i.id||'—'}: ${issueText(i)}`):b.errors);
  const of=a=>b.entries.filter(x=>x.action===a).map(x=>x.id),n=b.summary.create+b.summary.update;
  result.replaceChildren(el('div',{},el('div',{class:'inv-import-sum'},[['create','Nové'],['update','Změněné'],['unchanged','Beze změny']].map(([k,l])=>el('div',{class:'inv-stat'},el('b',{},b.summary[k]),el('span',{},t(l))))),
   b.summary.create?[el('h3',{},t('Nové')),names(of('create'))]:null,b.summary.update?[el('h3',{},t('Změněné')),names(of('update'))]:null,
   n?null:el('p',{class:'muted'},t('Soubor odpovídá tomu, co tu už je. Není co importovat.'))));
  go.disabled=!n;go.textContent=n?t('Importovat ({n})',{n}):t('Importovat');
 };
 const file=el('input',{type:'file',id:'inv-import-file',accept:'.json,application/json',onchange:async()=>{
   const f=file.files?.[0];if(!f)return;
   if(f.size>900000)return fail(t('Soubor je příliš velký (nejvýš 900 kB).'));
   const parsed=parseImport(await f.text());
   if(parsed.error)return fail(t(parsed.error,parsed.vars));
   preview(parsed.entries);}});
 go.addEventListener('click',async()=>{if(!changes)return;go.disabled=true;
  try{const r=await send(false);
   if(r.ok){dialogEl().close();return announce();}
   if(r.status===409){invalidate();return fail(t('Inventář se mezitím změnil. Vyber soubor znovu.'),r.body?.error?.details||[]);}
   fail(t(r.body?.error?.message)||t('Import selhal.'),(r.body?.error?.issues||[]).map(i=>`${i.id||'—'}: ${issueText(i)}`));
  }catch{fail(t('Home Hub není dosažitelný. Zkus to znovu.'));}});
 open(dialogHead(t('IMPORT'),t('Zavřít import')),el('h2',{id:'inv-detail-title'},t('Import inventáře z JSON')),
  el('div',{class:'inv-edit'},
   el('p',{class:'muted inv-edit-lead'},t('Vyber soubor z Export JSON (nebo seznam záznamů ve stejném tvaru). Import záznamy přidává a nahrazuje, nic nemaže. Nejdřív ukáže, co se změní; uloží se vše, nebo nic.')),
   el('div',{class:'inv-field wide'},el('label',{for:'inv-import-file'},t('Soubor JSON')),file),
   result,
   el('div',{class:'inv-edit-actions'},el('span',{class:'inv-actions-gap'}),el('button',{type:'button',class:'inv-btn',onclick:()=>dialogEl().close()},t('Zrušit')),go)));
}
