// Správa → Uživatelé a API (#access). Admins (password session) manage view-only users, API keys
// and iPhone device tokens and see the access audit; everyone sees their own account and the API
// reference. Secrets (initial passwords, API keys) are shown once in a dialog and never stored here.
import {el} from './views.js';
import {authGuard} from './session-cache.js';
import {t,locale} from './i18n.js';
import {timeZone,site} from './site.js';
import {mcpSnippet} from './ui.js';

const when=iso=>iso&&Number.isFinite(Date.parse(iso))?new Intl.DateTimeFormat(locale(),{day:'numeric',month:'numeric',year:'numeric',hour:'2-digit',minute:'2-digit',timeZone:timeZone()}).format(new Date(iso)):'—';
const pill=(text,tone='',title)=>el('span',{class:`sec-pill ${tone}`,title},text);
// A translated sentence with elements in it: placeholders whose name is in parts become those elements.
const rich=(text,parts)=>text.split(/(\{\w+\})/).map(x=>{const k=x.slice(1,-1);return /^\{\w+\}$/.test(x)&&Object.hasOwn(parts,k)?parts[k]:x;}).filter(x=>x!=='');
const ADMIN_ERRORS={400:'Neplatný požadavek. Jméno má 3–40 znaků (malá písmena, číslice, . _ -), heslo aspoň 12 znaků.',403:'Na tohle je potřeba přihlášení administrátorským heslem.',404:'Uživatel, klíč nebo zařízení už neexistuje.',409:'Takové jméno už existuje, nebo je dosažen limit.'};

async function api(url,body){
 const lost=authGuard(),r=await fetch(url,{...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});
 const data=await r.json().catch(()=>({}));
 if(!r.ok){lost(r);throw new Error(t(ADMIN_ERRORS[r.status]||data.error?.message)||t('Požadavek selhal.'));}
 return data;
}

function dialog(...children){
 const d=el('dialog',{class:'acc-dialog'},...children);document.body.append(d);
 d.addEventListener('close',()=>d.remove());d.showModal();return d;
}
function confirmDialog(title,text,label,tone='danger'){
 return new Promise(resolve=>{let answer=false;
  const d=dialog(el('h3',{},title),el('p',{class:'acc-dim'},text),
   el('div',{class:'acc-actions'},el('button',{class:'acc-btn',onclick:()=>d.close()},t('Zrušit')),el('button',{class:`acc-btn ${tone}`,onclick:()=>{answer=true;d.close();}},label)));
  d.addEventListener('close',()=>resolve(answer));});
}
// One-time secret: copy button, optional usage example; the value is wiped when the dialog closes.
function secretDialog(title,value,caption,example){
 const field=el('input',{class:'acc-secret',readonly:'',value,'aria-label':title,onfocus:e=>e.target.select()});
 const copy=el('button',{class:'acc-btn primary',onclick:async()=>{try{await navigator.clipboard.writeText(value);copy.textContent=t('Zkopírováno');}catch{field.select();copy.textContent=t('Označeno – zkopíruj ⌘C');}}},t('Zkopírovat'));
 const d=dialog(el('div',{class:'acc-eyebrow'},t('ZOBRAZENO JEN JEDNOU')),el('h3',{},title),el('p',{class:'acc-dim'},caption),el('div',{class:'acc-secret-row'},field,copy),
  example?el('pre',{class:'acc-code'},example):null,el('div',{class:'acc-actions'},el('button',{class:'acc-btn',onclick:()=>d.close()},t('Hotovo'))));
 d.addEventListener('close',()=>{field.value='';value='';});
}

// ---------------------------------------------------------------------------------------------
function usersTab(status){
 const box=el('div',{class:'acc-stack'});
 const username=el('input',{name:'username',required:'',pattern:'[a-z][a-z0-9._-]{2,39}',autocomplete:'off',placeholder:t('jmeno-uzivatele'),title:t('3–40 znaků: malá písmena, číslice, . _ -')});
 const display=el('input',{name:'name',maxlength:'80',placeholder:t('Zobrazované jméno (nepovinné)')});
 const password=el('input',{name:'password',type:'password',autocomplete:'new-password',minlength:'12',maxlength:'256',placeholder:t('Heslo – prázdné = vygenerovat')});
 const create=el('button',{class:'acc-btn primary',type:'submit'},t('Vytvořit uživatele'));
 const form=el('form',{class:'acc-form',onsubmit:async e=>{e.preventDefault();create.disabled=true;
  try{const r=await api('/api/admin/users',{username:username.value,name:display.value||username.value,...(password.value?{password:password.value}:{})});
   status(t('Uživatel {name} vytvořen (jen čtení).',{name:r.user.username}));form.reset();await load();
   if(r.initialPassword)secretDialog(t('Heslo pro {name}',{name:r.user.username}),r.initialPassword,t('Předej ho uživateli. Uložený je jen otisk, znovu ho nezobrazím.'));}
  catch(err){status(err.message,true);}finally{create.disabled=false;}}},
  el('label',{},t('Uživatelské jméno'),username),el('label',{},t('Jméno'),display),el('label',{},t('Heslo'),password),create);
 const list=el('div',{});
 async function act(u,what){
  try{
   if(what==='toggle'){if(!await confirmDialog(u.disabled?t('Povolit {name}?',{name:u.username}):t('Zakázat {name}?',{name:u.username}),u.disabled?t('Uživatel se zase může přihlásit.'):t('Uživatel bude odhlášen při dalším požadavku.'),u.disabled?t('Povolit'):t('Zakázat'),u.disabled?'primary':'danger'))return;
    await api('/api/admin/users/action',{id:u.id,disabled:!u.disabled});status(u.disabled?t('{name}: povolen.',{name:u.username}):t('{name}: zakázán.',{name:u.username}));}
   if(what==='password'){if(!await confirmDialog(t('Nové heslo pro {name}?',{name:u.username}),t('Vygeneruji nové heslo. Staré přestane platit a uživatel bude odhlášen.'),t('Vygenerovat'),'primary'))return;
    const r=await api('/api/admin/users/password',{id:u.id});secretDialog(t('Nové heslo pro {name}',{name:u.username}),r.password,t('Předej ho uživateli. Uložený je jen otisk, znovu ho nezobrazím.'));status(t('{name}: heslo změněno, staré relace skončily.',{name:u.username}));}
   if(what==='remove'){if(!await confirmDialog(t('Smazat {name}?',{name:u.username}),t('Uživatel okamžitě ztratí přístup. Data Home Hubu zůstanou.'),t('Smazat')))return;
    await api('/api/admin/users/action',{id:u.id,remove:true});status(t('{name} smazán.',{name:u.username}));}
   await load();
  }catch(err){status(err.message,true);}
 }
 async function load(){
  const {users}=await api('/api/admin/users');
  list.replaceChildren(el('div',{class:'sec-scroll'},el('table',{class:'sec-table'},
   el('thead',{},el('tr',{},...[t('Uživatel'),t('Role'),t('Stav'),t('Vytvořen'),t('Heslo nastaveno'),''].map(h=>el('th',{},h)))),
   el('tbody',{},users.map(u=>el('tr',{},
    el('td',{},el('div',{class:'acc-name'},u.name),el('div',{class:'sec-user'},u.username)),
    el('td',{},u.builtin?pill(t('Administrátor'),'crit',t('Vestavěný účet; heslo je v private/auth.json na serveru.')):pill(t('Jen čtení'),'ok')),
    el('td',{},u.disabled?pill(t('Zakázán'),'warn'):pill(t('Aktivní'),'ok')),
    el('td',{class:'acc-dim'},u.builtin?t('vestavěný'):when(u.createdAt)),
    el('td',{class:'acc-dim'},u.builtin?'private/auth.json':when(u.passwordAt)),
    el('td',{class:'acc-row-actions'},u.builtin?el('span',{class:'acc-dim'},'—'):[
     el('button',{class:'acc-btn small',onclick:()=>act(u,'toggle')},u.disabled?t('Povolit'):t('Zakázat')),
     el('button',{class:'acc-btn small',onclick:()=>act(u,'password')},t('Nové heslo')),
     el('button',{class:'acc-btn small danger',onclick:()=>act(u,'remove')},t('Smazat'))])))))));
 }
 box.append(el('p',{class:'acc-dim'},t('Noví uživatelé mají jen čtení: vidí přehled, stroje a služby, ale nic nemění. Administrátor je jediný, vestavěný.')),form,list);
 load().catch(err=>status(err.message,true));
 return box;
}

// Connection snippets for a fresh service-account key (Claude Code, Codex and plain HTTP): ui.js → mcpSnippet.
const keySnippets=token=>mcpSnippet(token);
function showAccountKey(account,r){
 secretDialog(t('Klíč pro {name}',{name:account.name}),r.token,t('Zkopíruj ho teď. Uložený je jen otisk (SHA-256), celou hodnotu už nikdy neuvidíš. Klíč má oprávnění účtu: {scopes}.',{scopes:account.scopes.join(', ')}),keySnippets(r.token));
}

function scopePicker(catalog,selected){
 const boxes=new Map();
 const grid=el('div',{class:'acc-scopes'},Object.entries(catalog).map(([id,s])=>{
  const box=el('input',{type:'checkbox',value:id});box.checked=id==='read'||selected.includes(id);if(id==='read')box.disabled=true;boxes.set(id,box);
  return el('label',{class:'acc-scope'},box,el('span',{},el('b',{},t(s.label)),el('code',{},id),el('small',{},t(s.desc))));
 }));
 const set=list=>{for(const [id,b] of boxes)b.checked=id==='read'||list.includes(id);};
 return {grid,set,value:()=>[...boxes].filter(([,b])=>b.checked).map(([id])=>id)};
}

function accountsTab(status){
 const box=el('div',{class:'acc-stack'}),list=el('div',{class:'acc-stack'});
 let catalog={};
 const name=el('input',{name:'name',required:'',pattern:'[a-z][a-z0-9._-]{2,39}',autocomplete:'off',placeholder:'agent-studio',title:t('3–40 znaků: malá písmena, číslice, . _ -')});
 const description=el('input',{name:'description',maxlength:'200',placeholder:t('Kdo ho používá, např. Codex na serveru – údržba inventáře')});
 const pickerHost=el('div',{});let picker=null;
 const create=el('button',{class:'acc-btn primary',type:'submit'},t('Vytvořit účet a klíč'));
 const preset=(label,scopes)=>el('button',{type:'button',class:'acc-btn small',onclick:()=>picker?.set(scopes)},label);
 const form=el('form',{class:'acc-card acc-create',onsubmit:async e=>{e.preventDefault();create.disabled=true;
  try{const a=(await api('/api/admin/accounts',{name:name.value,...(description.value?{description:description.value}:{}),scopes:picker.value()})).account;
   const r=await api('/api/admin/accounts/keys',{accountId:a.id});form.reset();picker.set([]);status(t('Servisní účet {name} vytvořen.',{name:a.name}));await load();showAccountKey(a,r);}
  catch(err){status(err.message,true);}finally{create.disabled=false;}}},
  el('h3',{},t('Nový servisní účet')),
  el('div',{class:'acc-form-row'},el('label',{},t('Název'),name),el('label',{},t('Popis'),description)),
  el('div',{class:'acc-presets'},el('span',{class:'acc-dim'},t('Předvolby:')),preset(t('Agent inventáře'),['inventory:write']),preset(t('Jen čtení'),[]),preset(t('Bezpečnostní audit'),['security:read']),preset(t('Agent vývoje'),['tickets:write','review:write']),preset(t('Agent inventáře a vývoje'),['inventory:write','tickets:write','review:write'])),
  pickerHost,el('div',{class:'acc-actions'},create));

 async function act(a,what){
  try{
   if(what==='key'){const r=await api('/api/admin/accounts/keys',{accountId:a.id});await load();showAccountKey(a,r);return;}
   if(what==='toggle'){if(!await confirmDialog(a.disabled?t('Povolit {name}?',{name:a.name}):t('Zakázat {name}?',{name:a.name}),a.disabled?t('Klíče účtu začnou zase fungovat.'):t('Všechny klíče účtu přestanou fungovat hned. Účet i klíče zůstanou, jde to vrátit.'),a.disabled?t('Povolit'):t('Zakázat'),a.disabled?'primary':'danger'))return;
    await api('/api/admin/accounts/action',{id:a.id,disabled:!a.disabled});status(a.disabled?t('{name}: povolen.',{name:a.name}):t('{name}: zakázán.',{name:a.name}));}
   if(what==='remove'){if(!await confirmDialog(t('Smazat {name}?',{name:a.name}),t('Účet zmizí a všechny jeho klíče se odvolají. Nejde to vrátit.'),t('Smazat')))return;
    await api('/api/admin/accounts/action',{id:a.id,remove:true});status(t('{name} smazán, klíče odvolány.',{name:a.name}));}
   if(what==='scopes'){
    const p=scopePicker(catalog,a.scopes);let save=false;
    const d=dialog(el('h3',{},t('Oprávnění pro {name}',{name:a.name})),el('p',{class:'acc-dim'},t('Změna platí hned i pro existující klíče.')),p.grid,
     el('div',{class:'acc-actions'},el('button',{class:'acc-btn',onclick:()=>d.close()},t('Zrušit')),el('button',{class:'acc-btn primary',onclick:()=>{save=true;d.close();}},t('Uložit'))));
    d.classList.add('wide');
    await new Promise(r=>d.addEventListener('close',r));if(!save)return;
    await api('/api/admin/accounts/action',{id:a.id,scopes:p.value()});status(t('{name}: oprávnění uložena.',{name:a.name}));
   }
   if(what?.revoke){const k=what.revoke;if(!await confirmDialog(t('Odvolat klíč {prefix}…?',{prefix:k.prefix}),t('Klíč přestane fungovat hned. Ostatní klíče účtu zůstanou.'),t('Odvolat')))return;
    await api('/api/admin/keys/revoke',{id:k.id});status(t('Klíč {prefix}… odvolán.',{prefix:k.prefix}));}
   await load();
  }catch(err){status(err.message,true);}
 }
 async function load(){
  const r=await api('/api/admin/accounts');catalog=r.scopes;
  if(!picker){picker=scopePicker(catalog,[]);pickerHost.replaceChildren(picker.grid);}
  list.replaceChildren(...(r.accounts.length?r.accounts.map(a=>{
   const active=a.keys.filter(k=>!k.revokedAt);
   return el('section',{class:`acc-card acc-account${a.disabled?' off':''}`},
    el('div',{class:'acc-account-head'},
     el('div',{},el('span',{class:'sec-user acc-account-name'},a.name),' ',a.disabled?pill(t('zakázán'),'warn'):pill(t('aktivní'),'ok'),
      a.description?el('div',{class:'acc-dim'},a.description):null),
     el('div',{class:'acc-row-actions'},
      el('button',{class:'acc-btn small primary',onclick:()=>act(a,'key')},t('Nový klíč')),
      el('button',{class:'acc-btn small',onclick:()=>act(a,'scopes')},t('Oprávnění')),
      el('button',{class:'acc-btn small',onclick:()=>act(a,'toggle')},a.disabled?t('Povolit'):t('Zakázat')),
      el('button',{class:'acc-btn small danger',onclick:()=>act(a,'remove')},t('Smazat')))),
    el('div',{class:'acc-chips'},a.scopes.map(id=>pill(t(catalog[id]?.label)||id,id==='read'?'ok':id==='security:read'?'warn':['nas:control','lfs:delete','backups:run','compute:control'].includes(id)?'crit':'warn',`${id} – ${t(catalog[id]?.desc)}`))),
    active.length?el('table',{class:'sec-table acc-keys'},el('tbody',{},active.map(k=>el('tr',{},
     el('td',{},el('code',{class:'acc-prefix'},`${k.prefix}…`)),el('td',{class:'acc-dim'},t('vydán {when}',{when:when(k.createdAt)})),
     el('td',{class:'acc-dim'},k.lastUsedAt?t('použit {when}',{when:when(k.lastUsedAt)}):t('zatím nepoužit')),
     el('td',{class:'acc-row-actions'},el('button',{class:'acc-btn small danger',onclick:()=>act(a,{revoke:k})},t('Odvolat'))))))):
     el('p',{class:'acc-dim'},t('Účet nemá žádný platný klíč.')));
  }):[el('p',{class:'acc-dim'},t('Zatím žádné servisní účty.'))]));
 }
 box.append(el('p',{class:'acc-dim'},t('Servisní účty jsou pro agenty, MCP a skripty. Každý má vlastní klíče a jen vybraná oprávnění; každý zápis se zapíše do auditu. Změna oprávnění platí hned i pro vydané klíče.')),form,list);
 load().catch(err=>status(err.message,true));
 return box;
}

// All keys at a glance: service-account keys and older read / read & write keys.
function keysTab(status){
 const box=el('div',{class:'acc-stack'});
 const list=el('div',{});
 async function revoke(k){
  if(!await confirmDialog(t('Odvolat „{name}“?',{name:k.name}),t('Klíč přestane fungovat hned při dalším požadavku. Nejde to vrátit.'),t('Odvolat')))return;
  try{await api('/api/admin/keys/revoke',{id:k.id});status(t('Klíč „{name}“ odvolán.',{name:k.name}));await load();}catch(err){status(err.message,true);}
 }
 async function load(){
  const {keys}=await api('/api/admin/keys');
  const sorted=[...keys].sort((a,b)=>Boolean(a.revokedAt)-Boolean(b.revokedAt)||String(b.createdAt).localeCompare(String(a.createdAt)));
  list.replaceChildren(sorted.length?el('div',{class:'sec-scroll'},el('table',{class:'sec-table'},
   el('thead',{},el('tr',{},...[t('Klíč'),t('Patří'),t('Oprávnění'),t('Vytvořen'),t('Naposledy použit'),t('Stav'),''].map(h=>el('th',{},h)))),
   el('tbody',{},sorted.map(k=>el('tr',{class:k.revokedAt?'acc-revoked':''},
    el('td',{},el('div',{class:'acc-name'},k.name),el('code',{class:'acc-prefix'},`${k.prefix}…`)),
    el('td',{},k.accountId?el('span',{class:'sec-user'},k.accountName||t('(smazaný účet)')):el('span',{class:'acc-dim'},t('starý klíč'))),
    el('td',{},k.accountId?pill(t('podle účtu'),'dim'):k.permission==='write'?pill(t('plný zápis'),'crit',t('Starý klíč s právem zápisu může všechny zápisy: inventář, NAS, zálohy, LFS, modely. Nahraď ho servisním účtem.')):pill(t('jen čtení'),'ok')),
    el('td',{class:'acc-dim'},when(k.createdAt)),el('td',{class:'acc-dim'},k.lastUsedAt?when(k.lastUsedAt):t('zatím nepoužit')),
    el('td',{},k.revokedAt?pill(t('odvolán {when}',{when:when(k.revokedAt)}),'dim'):pill(t('aktivní'),'ok')),
    el('td',{class:'acc-row-actions'},k.revokedAt?el('span',{class:'acc-dim'},'—'):el('button',{class:'acc-btn small danger',onclick:()=>revoke(k)},t('Odvolat')))))))):
   el('p',{class:'acc-dim'},t('Zatím žádné API klíče.')));
 }
 box.append(el('p',{class:'acc-dim'},t('Všechny klíče na jednom místě. Nové klíče vydávej u servisního účtu (záložka Servisní účty), mají jen potřebná oprávnění. Staré klíče „plný zápis“ fungují dál, ale smí všechny zápisy.')),list);
 load().catch(err=>status(err.message,true));
 return box;
}

function devicesTab(status){
 const list=el('div',{});
 async function revoke(d){
  if(!await confirmDialog(t('Odebrat {name}?',{name:d.name}),t('Zařízení se při dalším požadavku odhlásí a bude se muset znovu přihlásit heslem.'),t('Odebrat')))return;
  try{await api('/api/devices/tokens/revoke',{id:d.id});status(t('{name} odebráno.',{name:d.name}));await load();}catch(err){status(err.message,true);}
 }
 async function load(){
  const {devices}=await api('/api/devices/tokens');
  list.replaceChildren(devices.length?el('div',{class:'sec-scroll'},el('table',{class:'sec-table'},
   el('thead',{},el('tr',{},...[t('Zařízení'),t('Přidáno'),t('Naposledy použito'),''].map(h=>el('th',{},h)))),
   el('tbody',{},devices.map(d=>el('tr',{},el('td',{},el('div',{class:'acc-name'},d.name)),el('td',{class:'acc-dim'},when(d.createdAt)),
    el('td',{class:'acc-dim'},d.lastUsedAt?when(d.lastUsedAt):t('zatím nepoužito')),
    el('td',{class:'acc-row-actions'},el('button',{class:'acc-btn small danger',onclick:()=>revoke(d)},t('Odebrat')))))))):
   el('p',{class:'acc-dim'},t('Žádné zařízení nemá přístup. Aplikace Home Hub pro iPhone se sem přidá sama po přihlášení heslem.')));
 }
 load().catch(err=>status(err.message,true));
 return el('div',{class:'acc-stack'},el('p',{class:'acc-dim'},...rich(t('Zařízení (aplikace pro iPhone) s dlouhodobým tokenem {token}. Token má práva administrátora kromě správy uživatelů a klíčů a platí, dokud ho neodebereš.'),{token:el('code',{},'hh_…')})),list);
}

const EVENTS={'account-created':'Vytvořen servisní účet','account-updated':'Změněn servisní účet','account-deleted':'Smazán servisní účet','api-write':'Zápis přes API','mcp-call':'Nástroj přes MCP','user-created':'Vytvořen uživatel','user-updated':'Změněn stav uživatele','user-deleted':'Smazán uživatel','user-password-reset':'Nové heslo uživatele',
 'key-created':'Vytvořen API klíč','key-revoked':'Odvolán API klíč','device-issued':'Přidáno zařízení','device-revoked':'Odebráno zařízení'};
function auditTab(status){
 const list=el('div',{});
 api('/api/admin/audit').then(({events})=>list.replaceChildren(events.length?el('div',{class:'sec-scroll'},el('table',{class:'sec-table'},
  el('thead',{},el('tr',{},...[t('Kdy'),t('Událost'),t('Kdo / čeho se týká'),t('Co'),t('Výsledek')].map(h=>el('th',{},h)))),
  el('tbody',{},events.map(e=>el('tr',{},el('td',{class:'acc-dim'},when(e.at)),el('td',{},t(EVENTS[e.event])||e.event),
   el('td',{},e.subject?el('span',{class:'sec-user'},e.subject):el('span',{class:'acc-dim'},e.id?t('{id} (už neexistuje)',{id:e.id}):'—')),
   el('td',{},e.detail?el('code',{class:'acc-route'},e.detail):el('span',{class:'acc-dim'},'—')),
   el('td',{},e.status===undefined?el('span',{class:'acc-dim'},'—'):pill(e.status==='ok'||(e.status>=200&&e.status<300)?t('provedeno'):e.status===403||e.status===401||e.status==='denied'?t('odmítnuto'):t('chyba'),e.status==='ok'||(e.status>=200&&e.status<300)?'ok':'warn',String(e.status)))))))):
  el('p',{class:'acc-dim'},t('Zatím žádné změny přístupu.')))).catch(err=>status(err.message,true));
 return el('div',{class:'acc-stack'},el('p',{class:'acc-dim'},t('Posledních 200 událostí: změny uživatelů, servisních účtů, klíčů a zařízení a každý zápis přes API nebo MCP (i odmítnutý). Záznamy neobsahují hesla, tokeny ani obsah požadavků.')),list);
}

// ---------------------------------------------------------------------------------------------
// API reference. who: public | read | write | admin (password session) | adminRole (admin session or device) | password (cookie needed)
const WHO={security:['admin / security:read','crit'],key:['klíč servisního účtu','warn'],public:['bez přihlášení','dim'],read:['čtení','ok'],write:['zápis','warn'],admin:['admin heslem','crit'],adminRole:['admin / zařízení','crit'],password:['přihlášení heslem','warn']};
const ROUTES=[
 ['Účet',[['GET','/api/me','read','Kdo jsem a co smím (canWrite, canAdmin).'],['POST','/api/session','public','Přihlášení {username,password} → cookie homehub.'],['POST','/api/logout','read','Odhlášení.']]],
 ['Domov',[['GET','/api/home','read','Dlaždice strojů: Thermo, služby, router.'],['GET','/api/home/history?machine=<id>&range=30m|7d|30d|6m','read','Řady pro grafy.'],
  ['POST','/api/home/refresh','read','Načíst Thermo hned (omezeno na 1× za 5 s).'],['POST','/api/home/settings','home:settings','Interval čtení Thermo {intervalSeconds: 15|30|60}.']]],
 ['Bezpečnost',[['GET','/api/security','security','Inventář SSH klíčů (snímek z collect-security).']]],
 ['Inventář',[['GET','/api/inventory','read','Celý inventář (knowledge.json) s hashi záznamů.'],['GET','/api/inventory/export','read','Stažení inventáře jako soubor.'],['GET','/api/services','read','Běžící služby (záznamy kind=runtime).'],
  ['POST','/api/inventory/entry','inventory:write','Úprava záznamu s kontrolou.'],['POST','/api/inventory/entries','inventory:write','Nový / celý záznam; vyžaduje aktuální base hash.'],['POST','/api/services','inventory:write','Totéž pro služby.']]],
 ['Správa přístupu',[['GET','/api/admin/users','admin','Seznam uživatelů.'],['POST','/api/admin/users','admin','Nový uživatel {username, name?, password?} → initialPassword jednou.'],
  ['POST','/api/admin/users/action','admin','{id, disabled: true|false} nebo {id, remove: true}.'],['POST','/api/admin/users/password','admin','{id} → nové vygenerované heslo jednou; staré relace končí.'],
  ['GET','/api/admin/keys','admin','Seznam API klíčů (bez hodnot).'],['POST','/api/admin/keys','admin','{name, permission: read|write} → token jednou.'],['POST','/api/admin/keys/revoke','admin','{id}.'],['GET','/api/admin/accounts','admin','Servisní účty, jejich klíče a katalog scopes.'],['POST','/api/admin/accounts','admin','{name, description?, scopes[]} – read se přidá vždy.'],['POST','/api/admin/accounts/action','admin','{id, scopes} | {id, description} | {id, disabled} | {id, remove: true}.'],['POST','/api/admin/accounts/keys','admin','{accountId, name?} → token jednou.'],['GET','/api/admin/audit','admin','Změny přístupu a zápisy přes API / MCP.']]],
 ['Project Tracker',[['GET','/api/tickets?project=&status=active&type=&release=none|…&q=','read','Tickety, projekty a releasy (s počty podle stavu).'],['GET','/api/tickets/HH-12','read','Celý ticket s komentáři, historií a rev.'],
  ['POST','/api/tickets','tickets:write','Nový ticket {project, title, type?, priority?, release?, …}.'],['POST','/api/tickets/update','tickets:write','Změna polí {id, rev, …}; starý rev → 409.'],
  ['POST','/api/tickets/comment','tickets:write','Komentář {id, text}.'],['POST','/api/tickets/releases','tickets:write','Release {project, version, status?, targetDate?, notes?, rev?}.'],['POST','/api/tickets/projects','tickets:write','Nový projekt {id, key, name, description?} nebo změna {id, rev, name?, description?}.']]],
 ['MCP',[['POST','/mcp','key','JSON-RPC 2.0 (initialize, tools/list, tools/call, ping); nástroje podle scopes servisního účtu.']]],
 ['Zařízení',[['GET','/api/devices/tokens','adminRole','Zařízení s tokenem.'],['POST','/api/devices/tokens','password','{name} → token hh_… jednou (jen z přihlášení heslem).'],['POST','/api/devices/tokens/revoke','adminRole','{id}.']]],
];
// Core groups, then the groups plugins documented. Rows for a title that already exists join that card.
function allDocs(){const out=new Map(ROUTES.map(([title,routes])=>[title,[...routes]]));for(const d of site().apiDocs||[])out.set(d.title,[...(out.get(d.title)||[]),...d.routes]);return [...out];}
const whoPill=who=>{const [label,tone,title]=WHO[who]||[who,'warn','Servisní účet s tímto scope; admin, zařízení a starý klíč se zápisem také.'];return pill(t(label),tone,title&&t(title));};
function apiTab(){
 const base=location.origin;
 const scopeCard=el('section',{class:'acc-card'},el('h3',{},t('Scopes servisních účtů')),el('div',{class:'acc-dim',style:'margin-bottom:10px'},t('Načítám…')));
 api('/api/admin/accounts').then(({scopes})=>scopeCard.replaceChildren(el('h3',{},t('Scopes servisních účtů')),el('div',{class:'sec-scroll acc-flat'},el('table',{class:'sec-table'},el('tbody',{},
  Object.entries(scopes).map(([id,sc])=>el('tr',{},el('td',{},el('code',{class:'acc-route'},id)),el('td',{},el('b',{},t(sc.label))),el('td',{class:'acc-dim'},t(sc.desc))))))))).catch(()=>scopeCard.remove());
 const mcpCard=el('section',{class:'acc-card'},el('h3',{},t('MCP pro agenty')),
  el('p',{class:'acc-dim'},...rich(t('Endpoint {url} (MCP Streamable HTTP, odpovědi v JSON). Přihlášení klíčem servisního účtu. Agent vidí jen nástroje, na které má scope.'),{url:el('code',{},`${base}/mcp`)})),
  el('div',{class:'sec-scroll acc-flat'},el('table',{class:'sec-table'},el('tbody',{},[
   ['home_status','read',t('Stav strojů: online, CPU, GPU, teplota, paměť, služby.')],
   ['inventory_search','read',t('Hledání v inventáři (id, název, druh, stroj, adresa, poznámky).')],
   ['inventory_get','read',t('Celý záznam s otiskem (hash) a co na něm závisí.')],
   ['inventory_update','inventory:write',t('Založení nebo nahrazení záznamu; u existujícího záznamu vyžaduje otisk z inventory_get. Tajemství checker odmítne.')],
   ['tickets_list','read',t('Tickety s filtry, projekty a releasy.')],['ticket_get','read',t('Celý ticket s komentáři a rev.')],
   ['ticket_create','tickets:write',t('Založení ticketu.')],['ticket_update','tickets:write',t('Změna polí; vyžaduje rev z ticket_get.')],
   ['ticket_comment','tickets:write',t('Komentář k ticketu.')],['release_save','tickets:write',t('Založení nebo změna releasu.')],['project_save','tickets:write',t('Založení projektu nebo změna názvu a popisu.')]]
   .map(([n,sc,d])=>el('tr',{},el('td',{},el('code',{class:'acc-route'},n)),el('td',{},pill(sc,sc==='read'?'ok':'warn')),el('td',{class:'acc-dim'},d)))))),
  el('pre',{class:'acc-code'},`# Claude Code
claude mcp add --transport http home-hub ${base}/mcp \
  --header "Authorization: Bearer $HOME_HUB_KEY"

# Codex (~/.codex/config.toml)
[mcp_servers.home-hub]
url = "${base}/mcp"
bearer_token_env_var = "HOME_HUB_KEY"`));
 const yes=el('span',{class:'acc-yes'},'✓'),no=()=>el('span',{class:'acc-no'},'—');
 const matrix=[[t('Administrátor (heslo)'),1,1,1,1],[t('Uživatel (jen čtení)'),1,0,0,0],[t('Servisní účet'),1,'scope','scope',0],[t('Starý klíč · čtení'),1,0,0,0],[t('Starý klíč · zápis'),1,1,0,0],[t('Zařízení (iPhone)'),1,1,1,0]];
 return el('div',{class:'acc-stack'},
  el('div',{class:'acc-grid2'},
   el('section',{class:'acc-card'},el('h3',{},t('Jak se připojit')),
    el('dl',{class:'acc-dl'},el('dt',{},t('Adresa')),el('dd',{},el('code',{},base)),
     el('dt',{},t('Prohlížeč')),el('dd',{},...rich(t('cookie {cookie} po {login}; POST musí mít stejný {origin}.'),{cookie:el('code',{},'homehub'),login:el('code',{},'POST /api/session'),origin:el('code',{},'Origin')})),
     el('dt',{},t('Skripty')),el('dd',{},el('code',{},'Authorization: Bearer hhk_…'),' ',t('(API klíč)')),
     el('dt',{},'iPhone'),el('dd',{},el('code',{},'Authorization: Bearer hh_…'),' ',t('(token zařízení)')),
     el('dt',{},t('POST tělo')),el('dd',{},...rich(t('JSON, {type} (přesně), max 16 kB'),{type:el('code',{},'Content-Type: application/json')})),
     el('dt',{},t('Chyby')),el('dd',{},el('code',{},'{"error":{"code","message"}}'),' ',t('· 401 přihlásit · 403 chybí právo · 404 · 409 konflikt')))),
   el('section',{class:'acc-card'},el('h3',{},t('Kdo co smí')),
    el('table',{class:'sec-table acc-matrix'},el('thead',{},el('tr',{},...['',t('Číst'),t('Akce a zápis'),t('Bezpečnost'),t('Uživatelé a klíče')].map(h=>el('th',{},h)))),
     el('tbody',{},matrix.map(([label,...cells])=>el('tr',{},el('td',{},label),...cells.map(c=>el('td',{},c==='scope'?el('span',{class:'acc-dim'},t('podle scopes')):c?yes.cloneNode(true):no())))))))),
  scopeCard,mcpCard,
  el('section',{class:'acc-card'},el('h3',{},t('Příklad')),el('pre',{class:'acc-code'},
   `# ${t('čtení')}\ncurl -s -H "Authorization: Bearer $HOME_HUB_KEY" ${base}/api/home\n\n# ${t('zápis (klíč s právem zápisu)')}\ncurl -s -X POST -H "Authorization: Bearer $HOME_HUB_KEY" \\\n  -H 'Content-Type: application/json' -d '{"intervalSeconds":30}' \\\n  ${base}/api/home/settings`)),
  // Core routes, then the groups the loaded plugins documented (module field apiDocs, via the UI manifest).
  ...allDocs().map(([group,routes])=>el('section',{class:'acc-card'},el('h3',{},t(group)),el('div',{class:'sec-scroll acc-flat'},el('table',{class:'sec-table'},
   el('tbody',{},routes.map(([method,route,who,desc])=>el('tr',{},el('td',{class:'acc-method'},el('span',{class:`acc-m ${method.toLowerCase()}`},method)),
    el('td',{},el('code',{class:'acc-route'},route)),el('td',{},whoPill(who)),el('td',{class:'acc-dim'},t(desc))))))))));
}

// ---------------------------------------------------------------------------------------------
let tab='users';
export function accessView(me){
 const admin=me?.canAdmin===true;
 const tabs=admin?[['users',t('Uživatelé')],['accounts',t('Servisní účty')],['keys',t('API klíče')],['devices',t('Zařízení')],['api','API'],['audit',t('Audit')]]:[['api','API']];
 if(!tabs.some(([id])=>id===tab))tab=tabs[0][0];
 const statusLine=el('p',{class:'acc-status',role:'status','aria-live':'polite'});
 const status=(text,error=false)=>{statusLine.textContent=text;statusLine.classList.toggle('error',error);};
 const content=el('div',{});
 const nav=el('div',{class:'sec-tabs',role:'tablist'},tabs.map(([id,label])=>el('button',{role:'tab','data-tab':id,onclick:()=>{tab=id;paint();}},label)));
 function paint(){
  status('');
  content.replaceChildren(tab==='accounts'?accountsTab(status):tab==='keys'?keysTab(status):tab==='devices'?devicesTab(status):tab==='audit'?auditTab(status):tab==='api'?apiTab():usersTab(status));
  nav.querySelectorAll('button').forEach(b=>{b.classList.toggle('on',b.dataset.tab===tab);b.setAttribute('aria-selected',String(b.dataset.tab===tab));});
 }
 const role=admin?t('Administrátor'):me?.authKind==='device'?t('Zařízení'):me?.canWrite?t('Čtení i zápis'):t('Jen čtení');
 const box=el('div',{class:'sec acc'},
  el('div',{class:'dev-head'},el('div',{class:'dev-title'},el('a',{class:'home-back',href:'#overview'},t('← Přehled')),el('h2',{},t('Uživatelé a API')),
   el('div',{class:'dev-host'},t('Přihlášen {name} · {role}',{name:me?.name||me?.username||'?',role}),admin?'':t(' · správa přístupu je jen pro administrátora (přihlášení heslem)')))),
  nav,statusLine,content);
 paint();
 return box;
}
// Page entry for the shell (app.js): every page module exports (context) => Node, and the server's UI
// manifest names it. context = {me, page, sub, machine, site}.
export const accessPage=({me})=>accessView(me);
