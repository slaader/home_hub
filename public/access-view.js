// Administration → Users and API (#access). Administrators (the owner or the Admin role, signed in with
// a password) manage people and their roles, custom roles, service accounts with their API keys, and
// device tokens, and read the access audit. Everyone else sees how to connect and the API reference.
// Secrets (generated passwords, API keys) are shown once in a dialog and never kept in this module.
// Text-safe DOM only: every string from the server lands in a text node or an attribute.
import {el} from './views.js';
import {authGuard} from './session-cache.js';
import {t,tp,locale} from './i18n.js';
import {timeZone,site} from './site.js';
import {pageHeader,emptyState,copyBlock,copyText} from './ui.js';

// ---- formatting -------------------------------------------------------------------------------
const valid=iso=>typeof iso==='string'&&Number.isFinite(Date.parse(iso));
export const when=iso=>valid(iso)?new Intl.DateTimeFormat(locale(),{day:'numeric',month:'numeric',year:'numeric',hour:'2-digit',minute:'2-digit',timeZone:timeZone()}).format(new Date(iso)):'—';
// "3 hours ago": for last-used times, where how long ago matters more than the date (the date is the tooltip).
export function ago(iso,now=Date.now()){
 if(!valid(iso))return '—';
 const s=Math.round((Date.parse(iso)-now)/1000),f=new Intl.RelativeTimeFormat(locale(),{numeric:'auto'});
 for(const [unit,size] of [['year',31536000],['month',2592000],['day',86400],['hour',3600],['minute',60]])if(Math.abs(s)>=size)return f.format(Math.round(s/size),unit);
 return f.format(Math.min(0,Math.round(s/60)),'minute');
}
const time=(iso,relative=false)=>el('time',{datetime:valid(iso)?iso:null,title:relative?when(iso):null},relative?ago(iso):when(iso));
const pill=(text,tone='',title)=>el('span',{class:`ax-pill ${tone}`.trim(),title},text);
const initials=name=>String(name||'?').replace(/[^\p{L}\p{N}]+/gu,' ').trim().split(/\s+/).map(w=>w[0]).join('').slice(0,2).toUpperCase()||'?';
// A translated sentence with elements in it: placeholders whose name is in parts become those elements.
const rich=(text,parts)=>text.split(/(\{\w+\})/).map(x=>{const k=x.slice(1,-1);return /^\{\w+\}$/.test(x)&&Object.hasOwn(parts,k)?parts[k]:x;}).filter(x=>x!=='');
const button=(label,onclick,cls='')=>el('button',{type:'button',class:`ax-btn ${cls}`.trim(),onclick},label);
const ROLE_TONE={owner:'accent',admin:'bad',editor:'warn',viewer:'good'};
const rolePill=(id,name,title)=>pill(t(name)||id,ROLE_TONE[id]||'info',title);

// ---- talking to the server ---------------------------------------------------------------------
// What a refusal means, said in the UI's language: by error code first, then by status.
const BY_CODE={ROLE_IN_USE:'Tuhle roli ještě někdo má. Vyber, kam se lidé přesunou.',ADMIN_REQUIRED:'Na tohle je potřeba přihlášení administrátorským heslem.'};
const BY_STATUS={400:'Neplatný požadavek. Jméno má 3–40 znaků (malá písmena, číslice, . _ -), heslo aspoň 12 znaků.',403:'Na tohle je potřeba přihlášení administrátorským heslem.',404:'Uživatel, klíč nebo zařízení už neexistuje.',409:'Takové jméno už existuje, nebo je dosažen limit.'};
async function api(url,body){
 const lost=authGuard(),r=await fetch(url,{...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});
 const data=await r.json().catch(()=>({}));
 if(!r.ok){lost(r);throw new Error(t(BY_CODE[data.error?.code]||BY_STATUS[r.status]||data.error?.message)||t('Požadavek selhal.'));}
 return data;
}
// A part of the page that loads: a placeholder, then the content, or the error with a way to try again.
// reload() keeps what is on screen until the new data arrives, so an action does not flash the list.
function loader(load,render){
 const host=el('div',{class:'ax-load'});
 let turn=0,drawn=false;
 async function reload(){
  const mine=++turn;host.setAttribute('aria-busy','true');
  if(!drawn)host.replaceChildren(el('div',{class:'ax-skeleton',role:'status'},el('span',{},t('Načítám…'))));
  try{const data=await load();if(mine!==turn)return;host.replaceChildren(render(data));drawn=true;}
  catch(err){if(mine!==turn)return;drawn=false;host.replaceChildren(el('div',{class:'ax-failure',role:'alert'},el('strong',{},t('Nepodařilo se načíst.')),el('span',{},err?.name==='TimeoutError'?t('Home Hub neodpovídá. Zkus to znovu.'):err?.message||''),button(t('Zkusit znovu'),reload,'small')));}
  finally{if(mine===turn)host.removeAttribute('aria-busy');}
 }
 reload();
 return {host,reload};
}

// ---- dialogs ----------------------------------------------------------------------------------
function dialog(cls,...children){
 const d=el('dialog',{class:`ax-dialog ${cls}`.trim()},...children);document.body.append(d);
 d.addEventListener('close',()=>d.remove());d.showModal();return d;
}
function confirmDialog(title,text,label,tone='danger'){
 return new Promise(resolve=>{let answer=false;
  const d=dialog('',el('h3',{},title),el('p',{class:'ax-note'},text),
   el('div',{class:'ax-actions'},button(t('Zrušit'),()=>d.close()),button(label,()=>{answer=true;d.close();},tone)));
  d.addEventListener('close',()=>resolve(answer));});
}
// A form in a dialog. submit(form) does the work; a thrown error is shown inside and the dialog stays
// open. Resolves with what submit returned, or undefined when the dialog was dismissed.
function formDialog({title,lead,body,label,tone='primary',wide=false,submit,ready}){
 return new Promise(resolve=>{let result;
  const problem=el('p',{class:'ax-status error',role:'alert'}),go=el('button',{type:'submit',class:`ax-btn ${tone}`},label);
  const form=el('form',{class:'ax-form',onsubmit:async e=>{e.preventDefault();go.disabled=true;problem.textContent='';
    try{result=await submit(form);d.close();}catch(err){problem.textContent=err.message;}finally{go.disabled=false;sync();}}},
   el('h3',{},title),lead?el('p',{class:'ax-note'},lead):null,body,problem,
   el('div',{class:'ax-actions'},button(t('Zrušit'),()=>d.close()),go));
  // ready(form): false keeps the submit button off (e.g. a warning that has not been acknowledged).
  const sync=()=>{if(ready)go.disabled=!ready(form);};
  form.addEventListener('input',sync);form.addEventListener('change',sync);
  const d=dialog(wide?'wide':'',form);sync();
  d.addEventListener('close',()=>resolve(result));});
}
const field=(label,control,hint)=>el('label',{class:'ax-field'},el('span',{},label),control,hint?el('small',{},hint):null);

// ---- connecting an agent -----------------------------------------------------------------------
// Ready-to-paste configuration for the MCP endpoint of this hub. token: the key itself when it was just
// issued; otherwise the snippets read it from the environment variable HOME_HUB_KEY.
export function connectionSnippets(origin,token){
 const mcp=`${origin}/mcp`,bearer=token||'$HOME_HUB_KEY';
 return [
  {id:'claude',label:'Claude Code',text:`claude mcp add --transport http home-hub ${mcp} \\\n  --header "Authorization: Bearer ${bearer}"`},
  {id:'codex',label:'Codex',text:`# ~/.codex/config.toml\n[mcp_servers.home-hub]\nurl = "${mcp}"\nbearer_token_env_var = "HOME_HUB_KEY"\n\n# shell\nexport HOME_HUB_KEY="${token||'hhk_…'}"`},
  {id:'json',label:'MCP JSON',text:JSON.stringify({mcpServers:{'home-hub':{type:'http',url:mcp,headers:{Authorization:`Bearer ${token||'${HOME_HUB_KEY}'}`}}}},null,2)},
  {id:'curl',label:'curl',text:`curl -s -H "Authorization: Bearer ${bearer}" ${origin}/api/home`},
 ];
}
let snippetTab='claude';
// The snippets as tabs with a Copy button each.
function snippetTabs(token){
 const all=connectionSnippets(location.origin,token),host=el('div',{});
 const tabs=el('div',{class:'ax-seg',role:'tablist','aria-label':t('Klient')},all.map(s=>el('button',{type:'button',role:'tab','data-id':s.id,onclick:()=>{snippetTab=s.id;paint();}},s.label)));
 function paint(){const s=all.find(x=>x.id===snippetTab)||all[0];host.replaceChildren(copyBlock(s.label,s.text));
  tabs.querySelectorAll('button').forEach(b=>{b.classList.toggle('on',b.dataset.id===s.id);b.setAttribute('aria-selected',String(b.dataset.id===s.id));});}
 paint();
 return el('div',{class:'ax-snippets'},tabs,host);
}
// One-time secret: shown once with Copy; the value is wiped when the dialog closes.
function secretDialog({title,value,caption,snippets=false}){
 const input=el('input',{class:'ax-secret',readonly:'',value,'aria-label':title,onfocus:e=>e.target.select()});
 const copy=button(t('Zkopírovat'),async()=>{copy.textContent=await copyText(value)?t('Zkopírováno'):t('Označeno – zkopíruj ⌘C');if(copy.textContent!==t('Zkopírováno'))input.select();},'primary');
 const d=dialog(snippets?'wide':'',el('div',{class:'ax-eyebrow'},t('ZOBRAZENO JEN JEDNOU')),el('h3',{},title),el('p',{class:'ax-note'},caption),el('div',{class:'ax-secret-row'},input,copy),
  snippets?[el('h4',{},t('Připojení agenta')),snippetTabs(value)]:null,el('div',{class:'ax-actions'},button(t('Hotovo, mám ho uložený'),()=>d.close(),'primary')));
 d.addEventListener('close',()=>{input.value='';value='';});
}

// ---- scopes -----------------------------------------------------------------------------------
// One scope as a chip: a write scope is marked, a scope no loaded module defines is shown as unknown.
const scopeChip=(id,catalog)=>{const s=catalog[id];return s?pill(t(s.label),s.write?'warn':'good',`${id} – ${t(s.desc)}`):pill(id,'dim',t('Tohle oprávnění teď žádný modul nezná; nic neotevírá.'));};
const scopeChips=(ids,catalog)=>el('div',{class:'ax-chips'},ids.map(id=>scopeChip(id,catalog)));
// Check boxes for every scope, read-only ones first. read is always on.
function scopePicker(catalog,selected){
 const boxes=new Map();
 const option=([id,s])=>{const box=el('input',{type:'checkbox',value:id});box.checked=id==='read'||selected.includes(id);if(id==='read')box.disabled=true;boxes.set(id,box);
  return el('label',{class:'ax-scope'},box,el('span',{},el('b',{},t(s.label)),el('code',{},id),el('small',{},t(s.desc))));};
 const group=(title,entries)=>entries.length?el('fieldset',{class:'ax-scope-group'},el('legend',{},title),el('div',{class:'ax-scopes'},entries.map(option))):null;
 const entries=Object.entries(catalog);
 const node=el('div',{class:'ax-picker'},group(t('Čtení'),entries.filter(([,s])=>!s.write)),group(t('Zápis a akce'),entries.filter(([,s])=>s.write)));
 return {node,set:list=>{for(const [id,b] of boxes)b.checked=id==='read'||list.includes(id);},value:()=>[...boxes].filter(([,b])=>b.checked).map(([id])=>id)};
}

// ---- people -----------------------------------------------------------------------------------
function peopleTab(status,me){
 let roles=[];
 const secretNote=()=>t('Předej ho uživateli. Uložený je jen otisk, znovu ho nezobrazím.');
 const roleSelect=current=>{const s=el('select',{name:'role'},roles.filter(r=>r.assignable).map(r=>el('option',{value:r.id,selected:r.id===current?'':null},t(r.name))));
  const about=el('small',{}),sync=()=>{about.textContent=t(roles.find(r=>r.id===s.value)?.description||'');};s.addEventListener('change',sync);sync();
  return {select:s,about};};
 async function add(){
  const username=el('input',{name:'username',required:'',pattern:'[a-z][a-z0-9._-]{2,39}',autocomplete:'off',autocapitalize:'none',spellcheck:'false',placeholder:t('jmeno-uzivatele')});
  const display=el('input',{name:'name',maxlength:'80',autocomplete:'off',placeholder:t('Zobrazované jméno (nepovinné)')});
  const password=el('input',{name:'password',type:'password',autocomplete:'new-password',minlength:'12',maxlength:'256',placeholder:t('Prázdné = vygenerovat')});
  const role=roleSelect('viewer');
  const r=await formDialog({title:t('Nový uživatel'),lead:t('Každý člověk má vlastní jméno a heslo. Co smí, určuje role.'),label:t('Vytvořit uživatele'),
   body:[field(t('Uživatelské jméno'),username,t('3–40 znaků: malá písmena, číslice, . _ -')),field(t('Jméno'),display),el('label',{class:'ax-field'},el('span',{},t('Role')),role.select,role.about),field(t('Heslo'),password,t('Aspoň 12 znaků. Když pole necháš prázdné, heslo vygeneruji a ukážu ho jednou.'))],
   submit:()=>api('/api/admin/users',{username:username.value,name:display.value||username.value,role:role.select.value,...(password.value?{password:password.value}:{})})});
  if(!r)return;
  status(t('Uživatel {name} vytvořen s rolí {role}.',{name:r.user.username,role:t(r.user.roleName)}));list.reload();
  if(r.initialPassword)secretDialog({title:t('Heslo pro {name}',{name:r.user.username}),value:r.initialPassword,caption:secretNote()});
 }
 async function act(u,what){
  try{
   if(what==='role'){
    const role=roleSelect(u.roleId);
    const done=await formDialog({title:t('Role pro {name}',{name:u.username}),lead:t('Změna platí hned, při dalším požadavku uživatele.'),label:t('Uložit'),
     body:el('label',{class:'ax-field'},el('span',{},t('Role')),role.select,role.about),submit:()=>api('/api/admin/users/action',{id:u.id,role:role.select.value})});
    if(!done)return;status(t('{name}: role změněna.',{name:u.username}));
   }
   if(what==='toggle'){if(!await confirmDialog(u.disabled?t('Povolit {name}?',{name:u.username}):t('Zakázat {name}?',{name:u.username}),u.disabled?t('Uživatel se zase může přihlásit.'):t('Uživatel bude odhlášen při dalším požadavku.'),u.disabled?t('Povolit'):t('Zakázat'),u.disabled?'primary':'danger'))return;
    await api('/api/admin/users/action',{id:u.id,disabled:!u.disabled});status(u.disabled?t('{name}: povolen.',{name:u.username}):t('{name}: zakázán.',{name:u.username}));}
   if(what==='password'){if(!await confirmDialog(t('Nové heslo pro {name}?',{name:u.username}),t('Vygeneruji nové heslo. Staré přestane platit a uživatel bude odhlášen.'),t('Vygenerovat'),'primary'))return;
    const r=await api('/api/admin/users/password',{id:u.id});secretDialog({title:t('Nové heslo pro {name}',{name:u.username}),value:r.password,caption:secretNote()});status(t('{name}: heslo změněno, staré relace skončily.',{name:u.username}));}
   if(what==='remove'){if(!await confirmDialog(t('Smazat {name}?',{name:u.username}),t('Uživatel okamžitě ztratí přístup. Data Home Hubu zůstanou.'),t('Smazat')))return;
    await api('/api/admin/users/action',{id:u.id,remove:true});status(t('{name} smazán.',{name:u.username}));}
   list.reload();
  }catch(err){status(err.message,true);}
 }
 const row=u=>el('article',{class:`ax-row${u.disabled?' off':''}`},
  el('span',{class:'ax-avatar','aria-hidden':'true'},initials(u.name)),
  el('div',{class:'ax-row-main'},
   el('div',{class:'ax-row-title'},el('b',{},u.name),rolePill(u.roleId,u.roleName,t(roles.find(r=>r.id===u.roleId)?.description||'')),u.disabled?pill(t('Zakázán'),'warn'):null,u.id===me?.id?pill(t('to jsi ty'),'dim'):null,
    u.roleMissing?pill(t('role už neexistuje'),'bad',t('Role tohoto uživatele byla smazána; do přiřazení nové má jen čtení.')):null),
   el('div',{class:'ax-row-sub'},el('code',{},u.username),u.builtin?el('span',{},t('vestavěný účet · nejde smazat, zakázat ani mu změnit roli')):null)),
  el('dl',{class:'ax-row-meta'},el('div',{},el('dt',{},t('Vytvořen')),el('dd',{},u.createdAt?time(u.createdAt):'—')),el('div',{},el('dt',{},t('Heslo nastaveno')),el('dd',{},u.passwordAt?time(u.passwordAt):'—'))),
  u.builtin?el('div',{class:'ax-row-actions'},el('a',{class:'ax-btn small',href:'#settings'},u.id===me?.id?t('Změnit heslo'):t('Nastavení'))):el('div',{class:'ax-row-actions'},
   button(t('Role'),()=>act(u,'role'),'small'),button(t('Nové heslo'),()=>act(u,'password'),'small'),
   button(u.disabled?t('Povolit'):t('Zakázat'),()=>act(u,'toggle'),'small'),button(t('Smazat'),()=>act(u,'remove'),'small danger')));
 const list=loader(async()=>{const r=await api('/api/admin/users');roles=r.roles;return r.users;},users=>el('div',{class:'ax-rows'},users.map(row),
  users.length===1?el('p',{class:'ax-note ax-hint'},t('Zatím jsi tu jen ty. Přidej další lidi z domácnosti a dej jim roli: Čtenář jen čte, Editor i mění, Admin navíc spravuje přístup.')):null));
 return el('div',{class:'ax-stack'},sectionHead(t('Lidé'),t('Kdo se přihlašuje jménem a heslem. Co smí, určuje role.'),button(t('+ Nový uživatel'),()=>add().catch(err=>status(err.message,true)),'primary')),list.host);
}
const sectionHead=(title,lead,...actions)=>el('div',{class:'ax-section-head'},el('div',{},el('h2',{},title),lead?el('p',{class:'ax-note'},lead):null),actions.length?el('div',{class:'ax-section-actions'},actions):null);

// ---- roles ------------------------------------------------------------------------------------
function rolesTab(status){
 let catalog={},roles=[];
 async function edit(role){
  const name=el('input',{name:'name',required:'',maxlength:'40',autocomplete:'off',value:role?.name||'',placeholder:t('např. Host, Auditor, Rodina')});
  const description=el('input',{name:'description',maxlength:'200',autocomplete:'off',value:role?.description||'',placeholder:t('Pro koho role je a co s ní smí')});
  const picker=scopePicker(catalog,role?.scopes||[]);
  const from=(label,ids)=>button(label,()=>picker.set(ids),'small');
  const done=await formDialog({wide:true,title:role?t('Upravit roli {name}',{name:role.name}):t('Nová role'),label:role?t('Uložit'):t('Vytvořit roli'),
   lead:role?t('Změna platí hned pro všechny, kdo roli mají.'):t('Role je pojmenovaná sada oprávnění. Správu uživatelů, rolí a klíčů vlastní role dát nemůže; tu má jen Vlastník a Admin.'),
   body:[el('div',{class:'ax-form-row'},field(t('Název'),name),field(t('Popis'),description)),
    el('div',{class:'ax-presets'},el('span',{},t('Začít z:')),from(t('Čtenář'),roles.find(r=>r.id==='viewer')?.scopes||[]),from(t('Editor'),roles.find(r=>r.id==='editor')?.scopes||[])),picker.node],
   submit:()=>role?api('/api/admin/roles/action',{id:role.id,name:name.value,description:description.value,scopes:picker.value()}):api('/api/admin/roles',{name:name.value,...(description.value?{description:description.value}:{}),scopes:picker.value()})});
  if(!done)return;status(role?t('Role {name} uložena.',{name:done.role.name}):t('Role {name} vytvořena.',{name:done.role.name}));list.reload();
 }
 async function remove(role){
  try{
   if(!role.users){if(!await confirmDialog(t('Smazat roli {name}?',{name:role.name}),t('Roli nikdo nemá. Smazání nejde vrátit.'),t('Smazat')))return;await api('/api/admin/roles/action',{id:role.id,remove:true});}
   else{
    // A role people still hold: they must move somewhere in the same step.
    const target=el('select',{name:'reassignTo'},roles.filter(r=>r.assignable&&r.id!==role.id).map(r=>el('option',{value:r.id,selected:r.id==='viewer'?'':null},t(r.name))));
    const done=await formDialog({title:t('Smazat roli {name}?',{name:role.name}),tone:'danger',label:t('Přesunout a smazat'),
     lead:tp(role.users,'Roli má {n} uživatel. Vyber, jakou roli dostane místo ní.|Roli mají {n} uživatelé. Vyber, jakou roli dostanou místo ní.|Roli má {n} uživatelů. Vyber, jakou roli dostanou místo ní.'),
     body:field(t('Nová role'),target),submit:()=>api('/api/admin/roles/action',{id:role.id,remove:true,reassignTo:target.value})});
    if(!done)return;
   }
   status(t('Role {name} smazána.',{name:role.name}));list.reload();
  }catch(err){status(err.message,true);}
 }
 const card=r=>el('article',{class:'ax-card ax-role'},
  el('header',{class:'ax-card-head'},
   el('div',{},el('h3',{},rolePill(r.id,r.name),r.builtin?pill(t('vestavěná'),'dim'):null,r.admin?pill(t('správa přístupu'),'bad',t('Smí spravovat uživatele, role, servisní účty, klíče a zařízení. Jen po přihlášení heslem.')):null),
    el('p',{class:'ax-note'},t(r.description)||'—')),
   el('div',{class:'ax-row-actions'},el('span',{class:'ax-count'},tp(r.users,'{n} uživatel|{n} uživatelé|{n} uživatelů')),
    r.builtin?null:[button(t('Upravit'),()=>edit(r).catch(err=>status(err.message,true)),'small'),button(t('Smazat'),()=>remove(r),'small danger')])),
  r.admin||r.id==='editor'?el('p',{class:'ax-note'},r.admin?t('Všechna oprávnění, i ta, která později přidá plugin.'):t('Čtení a všechny zápisy, i ty, které později přidá plugin.')):null,
  scopeChips(r.scopes,catalog));
 const list=loader(async()=>{const r=await api('/api/admin/roles');catalog=r.scopes;roles=r.roles;return r.roles;},all=>{const custom=all.filter(r=>!r.builtin);
  return el('div',{class:'ax-stack'},el('div',{class:'ax-cards'},all.filter(r=>r.builtin).map(card)),
   el('h3',{class:'ax-sub'},t('Vlastní role')),
   custom.length?el('div',{class:'ax-cards'},custom.map(card)):emptyState({icon:'◇',title:t('Zatím žádná vlastní role'),body:t('Vestavěné role stačí většině domácností. Vlastní roli založ, když někdo potřebuje jen část: třeba vidět bezpečnost, ale nic neměnit.'),
    steps:[t('Zvol název, který řekne, pro koho role je.'),t('Zaškrtni jen oprávnění, která potřebuje. Čtení má každá role.'),t('Přiřaď ji lidem na záložce Lidé.')],actions:[{label:t('+ Nová role'),onclick:()=>edit(null).catch(err=>status(err.message,true)),primary:true}]}));});
 return el('div',{class:'ax-stack'},sectionHead(t('Role a oprávnění'),t('Role říká, co člověk smí. Čtyři jsou vestavěné, další si založíš. Každá může sloužit i jako předvolba servisního účtu.'),button(t('+ Nová role'),()=>edit(null).catch(err=>status(err.message,true)),'primary')),list.host);
}

// ---- service accounts -------------------------------------------------------------------------
// What an agent can be told to do with a fresh key: the tools and scopes are named so it does not guess.
const AGENT_PROMPT=origin=>`Connect to my Home Hub over MCP at ${origin}/mcp using the service-account key in $HOME_HUB_KEY (Authorization: Bearer). First call whoami to see which scopes the key holds. Then call home_status, machine_list and inventory_search to learn what runs here. With the inventory:write scope, keep the inventory current: call inventory_describe once for the rules, search before you add, read an entry with inventory_get, change it, and pass its hash as base to inventory_update (never store secrets, only where they are kept). With tickets:write, file what you find with ticket_create and report progress with ticket_comment.`;
function accountsTab(status){
 let catalog={},presets=[];
 const showKey=(account,r)=>secretDialog({snippets:true,title:t('Klíč pro {name}',{name:account.name}),value:r.token,
  caption:account.fullAccess?t('Zkopíruj ho teď. Uložený je jen otisk (SHA-256), celou hodnotu už nikdy neuvidíš. Klíč má plný přístup.'):t('Zkopíruj ho teď. Uložený je jen otisk (SHA-256), celou hodnotu už nikdy neuvidíš. Klíč má oprávnění účtu: {scopes}.',{scopes:account.scopes.join(', ')})});
 // The presets as cards, each saying what it includes; "custom" opens the scope picker. Full access warns
 // and must be acknowledged. value() is the scope list to store.
 function presetChooser(current){
  const picker=scopePicker(catalog,current&&!current.includes('*')?current:[]);
  const custom={id:'custom',name:'Vlastní výběr',description:'Zaškrtni přesně ta oprávnění, která účet potřebuje.',scopes:null};
  const same=(a,b)=>a.length===b.length&&a.every(x=>b.includes(x));
  let chosen=current?(presets.find(p=>same(p.scopes,current))||custom).id:'read';
  const ack=el('input',{type:'checkbox',name:'ack'});
  const warning=el('div',{class:'ax-warning',role:'alert'},el('strong',{},t('Plný přístup: rozmysli si to')),
   el('p',{},t('Klíč smí všechno, co umí kterákoli role: měnit inventář a tickety, ovládat služby a spouštět akce, číst bezpečnostní přehledy. Platí to i pro oprávnění, která teprve přidá nějaký plugin.')),
   el('p',{},t('Nikdy se nedostane ke správě uživatelů, rolí, klíčů a zařízení ani k tvému účtu. Dej ho jen agentovi, kterému věříš, na stroji, který máš pod kontrolou.')),
   el('label',{class:'ax-check'},ack,el('span',{},t('Rozumím, chci plný přístup.'))));
  const detail=el('div',{class:'ax-preset-detail'});
  const cards=el('div',{class:'ax-preset-grid',role:'radiogroup','aria-label':t('Předvolba oprávnění')},[...presets,custom].map(p=>{
   const radio=el('input',{type:'radio',name:'preset',value:p.id});radio.checked=p.id===chosen;radio.addEventListener('change',()=>{chosen=p.id;paint();});
   return el('label',{class:`ax-preset${p.warn?' warn':''}`},radio,el('span',{},el('b',{},t(p.name)),
    el('small',{class:'ax-preset-count'},p.wildcard?t('všechna oprávnění, i budoucí'):p.scopes?tp(p.scopes.length,'{n} oprávnění|{n} oprávnění|{n} oprávnění'):t('podle výběru')),el('small',{},t(p.description))));}));
  function paint(){
   const p=presets.find(x=>x.id===chosen);
   detail.replaceChildren(...(chosen==='custom'?[picker.node]:p.wildcard?[warning,el('p',{class:'ax-note'},tp(Object.keys(catalog).length,'Dnes to je {n} oprávnění:|Dnes to jsou {n} oprávnění:|Dnes to je {n} oprávnění:')),scopeChips(Object.keys(catalog),catalog)]
    :[el('p',{class:'ax-note'},t('Zahrnuje:')),scopeChips(p.scopes,catalog),p.role?el('p',{class:'ax-note'},t('Seznam se zkopíruje teď. Pozdější změna role ani nový plugin ho nezmění; jen Plný přístup se rozšiřuje sám.')):null]));
   for(const c of cards.children)c.classList.toggle('on',c.querySelector('input').checked);
  }
  paint();
  return {node:el('div',{class:'ax-stack'},cards,detail),value:()=>chosen==='custom'?picker.value():presets.find(p=>p.id===chosen).scopes,
   ready:()=>!presets.find(p=>p.id===chosen)?.wildcard||ack.checked};
 }
 async function add(){
  const name=el('input',{name:'name',required:'',pattern:'[a-z][a-z0-9._-]{2,39}',autocomplete:'off',autocapitalize:'none',spellcheck:'false',placeholder:'agent-studio'});
  const description=el('input',{name:'description',maxlength:'200',autocomplete:'off',placeholder:t('Kdo ho používá, např. Codex na serveru – údržba inventáře')});
  const chooser=presetChooser(null);
  const made=await formDialog({wide:true,title:t('Nový servisní účet'),label:t('Vytvořit účet a klíč'),lead:t('Účet pro agenta, MCP klienta nebo skript. Dostane vlastní klíč a jen ta oprávnění, která vybereš.'),
   body:[el('div',{class:'ax-form-row'},field(t('Název'),name,t('3–40 znaků: malá písmena, číslice, . _ -')),field(t('Popis'),description)),el('h4',{},t('Co smí')),chooser.node],ready:chooser.ready,
   async submit(){const a=(await api('/api/admin/accounts',{name:name.value,...(description.value?{description:description.value}:{}),scopes:chooser.value()})).account;return {account:a,key:await api('/api/admin/accounts/keys',{accountId:a.id})};}});
  if(!made)return;status(t('Servisní účet {name} vytvořen.',{name:made.account.name}));list.reload();showKey(made.account,made.key);
 }
 async function act(a,what){
  try{
   if(what==='key'){const r=await api('/api/admin/accounts/keys',{accountId:a.id});list.reload();showKey(a,r);return;}
   if(what==='toggle'){if(!await confirmDialog(a.disabled?t('Povolit {name}?',{name:a.name}):t('Zakázat {name}?',{name:a.name}),a.disabled?t('Klíče účtu začnou zase fungovat.'):t('Všechny klíče účtu přestanou fungovat hned. Účet i klíče zůstanou, jde to vrátit.'),a.disabled?t('Povolit'):t('Zakázat'),a.disabled?'primary':'danger'))return;
    await api('/api/admin/accounts/action',{id:a.id,disabled:!a.disabled});status(a.disabled?t('{name}: povolen.',{name:a.name}):t('{name}: zakázán.',{name:a.name}));}
   if(what==='remove'){if(!await confirmDialog(t('Smazat {name}?',{name:a.name}),t('Účet zmizí a všechny jeho klíče se odvolají. Nejde to vrátit.'),t('Smazat')))return;
    await api('/api/admin/accounts/action',{id:a.id,remove:true});status(t('{name} smazán, klíče odvolány.',{name:a.name}));}
   if(what==='scopes'){
    const chooser=presetChooser(a.scopes);
    const done=await formDialog({wide:true,title:t('Oprávnění pro {name}',{name:a.name}),lead:t('Změna platí hned i pro existující klíče.'),label:t('Uložit'),body:chooser.node,ready:chooser.ready,
     submit:()=>api('/api/admin/accounts/action',{id:a.id,scopes:chooser.value()})});
    if(!done)return;status(t('{name}: oprávnění uložena.',{name:a.name}));
   }
   if(what?.revoke){const k=what.revoke;if(!await confirmDialog(t('Odvolat klíč {prefix}…?',{prefix:k.prefix}),t('Klíč přestane fungovat hned. Ostatní klíče účtu zůstanou.'),t('Odvolat')))return;
    await api('/api/admin/keys/revoke',{id:k.id});status(t('Klíč {prefix}… odvolán.',{prefix:k.prefix}));}
   list.reload();
  }catch(err){status(err.message,true);}
 }
 const card=a=>{const active=a.keys.filter(k=>!k.revokedAt);
  return el('article',{class:`ax-card ax-account${a.disabled?' off':''}`},
   el('header',{class:'ax-card-head'},
    el('div',{},el('h3',{},el('code',{class:'ax-account-name'},a.name),a.disabled?pill(t('zakázán'),'warn'):pill(t('aktivní'),'good'),
      a.fullAccess?pill(t('plný přístup'),'bad',t('Všechna oprávnění, i ta, která později přidá plugin. Bez správy přístupu.')):null),
     el('p',{class:'ax-note'},a.description||t('Bez popisu.'))),
    el('div',{class:'ax-row-actions'},button(t('Nový klíč'),()=>act(a,'key'),'small primary'),button(t('Oprávnění'),()=>act(a,'scopes'),'small'),
     button(a.disabled?t('Povolit'):t('Zakázat'),()=>act(a,'toggle'),'small'),button(t('Smazat'),()=>act(a,'remove'),'small danger'))),
   a.fullAccess?el('p',{class:'ax-note'},tp(a.effectiveScopes.length,'Dnes {n} oprávnění; každé další přibude samo.|Dnes {n} oprávnění; každé další přibude samo.|Dnes {n} oprávnění; každé další přibude samo.')):null,
   scopeChips(a.fullAccess?a.effectiveScopes:a.scopes,catalog),
   active.length?el('ul',{class:'ax-keys'},active.map(k=>el('li',{},el('code',{class:'ax-prefix'},`${k.prefix}…`),el('span',{class:'ax-key-name'},k.name),
     el('span',{class:'ax-key-meta'},t('vydán'),' ',time(k.createdAt)),el('span',{class:'ax-key-meta'},k.lastUsedAt?[t('naposledy použit'),' ',time(k.lastUsedAt,true)]:t('zatím nepoužit')),
     button(t('Odvolat'),()=>act(a,{revoke:k}),'small danger')))):el('p',{class:'ax-note ax-hint'},t('Účet nemá žádný platný klíč.')));};
 const list=loader(async()=>{const r=await api('/api/admin/accounts');catalog=r.scopes;presets=r.presets||[];return r.accounts;},accounts=>accounts.length?el('div',{class:'ax-cards wide'},accounts.map(card)):
  emptyState({icon:'⚙',title:t('Zatím žádný servisní účet'),body:t('Servisní účet je identita pro agenta nebo skript: vlastní klíč, jen vybraná oprávnění, každý zápis v auditu.'),
   steps:[t('Založ účet a vyber, co smí: jen čtení, některou roli, nebo plný přístup.'),t('Zkopíruj klíč. Uvidíš ho jen jednou.'),t('Vlož nastavení do svého agenta a zadej mu první úkol.')],
   agentPrompt:AGENT_PROMPT(location.origin),mcpSnippet:connectionSnippets(location.origin)[0].text,actions:[{label:t('+ Nový servisní účet'),onclick:()=>add().catch(err=>status(err.message,true)),primary:true}]}));
 return el('div',{class:'ax-stack'},sectionHead(t('Servisní účty'),t('Pro agenty, MCP a skripty. Každý má vlastní klíče a jen vybraná oprávnění; každý zápis se zapíše do auditu.'),button(t('+ Nový servisní účet'),()=>add().catch(err=>status(err.message,true)),'primary')),list.host);
}

// ---- API keys: every key in one place ------------------------------------------------------------
let keyFilter='active';
function keysTab(status){
 async function revoke(k){
  if(!await confirmDialog(t('Odvolat „{name}“?',{name:k.name}),t('Klíč přestane fungovat hned při dalším požadavku. Nejde to vrátit.'),t('Odvolat')))return;
  try{await api('/api/admin/keys/revoke',{id:k.id});status(t('Klíč „{name}“ odvolán.',{name:k.name}));list.reload();}catch(err){status(err.message,true);}
 }
 const row=k=>el('tr',{class:k.revokedAt?'off':''},
  el('td',{'data-label':t('Klíč')},el('b',{},k.name),el('code',{class:'ax-prefix'},`${k.prefix}…`)),
  el('td',{'data-label':t('Patří')},k.accountId?el('code',{},k.accountName||t('(smazaný účet)')):el('span',{class:'ax-dim'},t('bez účtu'))),
  el('td',{'data-label':t('Oprávnění')},k.accountId?pill(t('podle účtu'),'dim'):k.permission==='write'?pill(t('plný zápis'),'bad',t('Klíč z doby před servisními účty: smí všechny zápisy, které tehdy existovaly. Nahraď ho servisním účtem.')):pill(t('jen čtení'),'good')),
  el('td',{'data-label':t('Vytvořen')},time(k.createdAt)),el('td',{'data-label':t('Naposledy použit')},k.lastUsedAt?time(k.lastUsedAt,true):el('span',{class:'ax-dim'},t('zatím nepoužit'))),
  el('td',{'data-label':t('Stav')},k.revokedAt?pill(t('odvolán'),'dim',when(k.revokedAt)):pill(t('aktivní'),'good')),
  el('td',{class:'ax-row-actions'},k.revokedAt?null:button(t('Odvolat'),()=>revoke(k),'small danger')));
 const list=loader(async()=>(await api('/api/admin/keys')).keys,keys=>{
  const shown=keys.filter(k=>keyFilter==='all'||(keyFilter==='active')===!k.revokedAt).sort((a,b)=>Boolean(a.revokedAt)-Boolean(b.revokedAt)||String(b.createdAt).localeCompare(String(a.createdAt)));
  const chips=el('div',{class:'ax-seg',role:'group','aria-label':t('Stav')},[['active',t('Aktivní')],['revoked',t('Odvolané')],['all',t('Všechny')]].map(([id,label])=>
   el('button',{type:'button',class:keyFilter===id?'on':'','aria-pressed':String(keyFilter===id),onclick:()=>{keyFilter=id;list.reload();}},`${label} · ${keys.filter(k=>id==='all'||(id==='active')===!k.revokedAt).length}`)));
  if(!keys.length)return emptyState({icon:'⚿',title:t('Zatím žádný API klíč'),body:t('Klíče vznikají u servisních účtů: každý účet má vlastní a nese jeho oprávnění.'),actions:[{label:t('Servisní účty'),onclick:()=>openTab('accounts'),primary:true}]});
  return el('div',{class:'ax-stack'},chips,shown.length?el('div',{class:'ax-table-wrap'},el('table',{class:'ax-table'},
   el('thead',{},el('tr',{},...[t('Klíč'),t('Patří'),t('Oprávnění'),t('Vytvořen'),t('Naposledy použit'),t('Stav'),''].map(h=>el('th',{scope:'col'},h)))),el('tbody',{},shown.map(row)))):el('p',{class:'ax-note ax-hint'},t('V tomhle výběru není žádný klíč.')));});
 return el('div',{class:'ax-stack'},sectionHead(t('API klíče'),t('Všechny klíče na jednom místě. Nový klíč vydáš u servisního účtu. Uložený je vždy jen otisk, hodnotu už nikdo nezobrazí.')),list.host);
}

// ---- devices ----------------------------------------------------------------------------------
function devicesTab(status){
 async function revoke(d){
  if(!await confirmDialog(t('Odebrat {name}?',{name:d.name}),t('Zařízení se při dalším požadavku odhlásí a bude se muset znovu přihlásit heslem.'),t('Odebrat')))return;
  try{await api('/api/devices/tokens/revoke',{id:d.id});status(t('{name} odebráno.',{name:d.name}));list.reload();}catch(err){status(err.message,true);}
 }
 const list=loader(async()=>(await api('/api/devices/tokens')).devices,devices=>devices.length?el('div',{class:'ax-rows'},devices.map(d=>el('article',{class:'ax-row'},
   el('span',{class:'ax-avatar','aria-hidden':'true'},'▯'),el('div',{class:'ax-row-main'},el('div',{class:'ax-row-title'},el('b',{},d.name)),el('div',{class:'ax-row-sub'},el('code',{},'hh_…'))),
   el('dl',{class:'ax-row-meta'},el('div',{},el('dt',{},t('Přidáno')),el('dd',{},time(d.createdAt))),el('div',{},el('dt',{},t('Naposledy použito')),el('dd',{},d.lastUsedAt?time(d.lastUsedAt,true):t('zatím nepoužito')))),
   el('div',{class:'ax-row-actions'},button(t('Odebrat'),()=>revoke(d),'small danger'))))):
  emptyState({icon:'▯',title:t('Žádné zařízení nemá přístup'),body:t('Nativní aplikace se přihlásí jménem a heslem a nechá si vystavit vlastní token. Tady ho pak uvidíš a můžeš odebrat.'),
   steps:[t('V aplikaci zadej adresu tohoto Home Hubu a přihlas se.'),t('Aplikace si uloží token do klíčenky zařízení; heslo si nepamatuje.'),t('Ztracené zařízení tady odebereš jedním klepnutím.')]}));
 return el('div',{class:'ax-stack'},sectionHead(t('Zařízení'),null),el('p',{class:'ax-note'},...rich(t('Nativní aplikace s dlouhodobým tokenem {token}. Token smí všechno jako Admin kromě správy uživatelů, rolí a klíčů a platí, dokud ho neodebereš.'),{token:el('code',{},'hh_…')})),list.host);
}

// ---- audit ------------------------------------------------------------------------------------
const EVENTS={'account-created':'Vytvořen servisní účet','account-updated':'Změněn servisní účet','account-deleted':'Smazán servisní účet','api-write':'Zápis přes API','mcp-call':'Nástroj přes MCP','user-created':'Vytvořen uživatel','user-updated':'Změněn stav uživatele','user-deleted':'Smazán uživatel','user-password-reset':'Nové heslo uživatele',
 'user-password-changed':'Uživatel si změnil heslo','owner-password-changed':'Vlastník si změnil heslo','user-role-changed':'Změněna role uživatele','role-created':'Vytvořena role','role-updated':'Změněna role','role-deleted':'Smazána role',
 'key-created':'Vytvořen API klíč','key-revoked':'Odvolán API klíč','device-issued':'Přidáno zařízení','device-revoked':'Odebráno zařízení'};
const outcome=s=>s===undefined?null:s==='ok'||(s>=200&&s<300)?'ok':s===403||s===401||s==='denied'?'refused':'error';
let auditKind='all',auditOnly='all',auditText='';
// Which of the loaded events a filter keeps (exported for the tests).
export function auditMatches(e,{kind='all',only='all',text=''}={}){
 if(kind!=='all'&&e.kind!==kind)return false;
 if(only==='refused'&&!['refused','error'].includes(outcome(e.status)))return false;
 const needle=text.trim().toLowerCase();
 return !needle||[e.event,t(EVENTS[e.event]),e.subject,e.detail,e.by,e.id,e.status].some(v=>v!=null&&String(v).toLowerCase().includes(needle));
}
function auditTab(){
 let events=[];
 const body=el('div',{});
 const search=el('input',{type:'search',class:'ax-search',placeholder:t('Hledat: účet, cesta, nástroj, ticket…'),'aria-label':t('Hledat v auditu'),value:auditText,oninput:e=>{auditText=e.target.value;paint();}});
 const seg=(label,current,options,set)=>el('div',{class:'ax-seg',role:'group','aria-label':label},options.map(([id,text])=>el('button',{type:'button',class:current===id?'on':'','aria-pressed':String(current===id),onclick:()=>{set(id);draw();}},text)));
 const bar=el('div',{class:'ax-filter'});
 const result=e=>{const o=outcome(e.status);return o?pill(o==='ok'?t('provedeno'):o==='refused'?t('odmítnuto'):t('chyba'),o==='ok'?'good':'warn',String(e.status)):el('span',{class:'ax-dim'},'—');};
 function paint(){
  const shown=events.filter(e=>auditMatches(e,{kind:auditKind,only:auditOnly,text:auditText}));
  body.replaceChildren(!events.length?emptyState({icon:'☰',title:t('Audit je zatím prázdný'),body:t('Zapíše se sem každá změna uživatelů, rolí, servisních účtů, klíčů a zařízení a každý zápis přes API nebo MCP, i odmítnutý.')}):
   !shown.length?el('p',{class:'ax-note ax-hint'},t('Filtru neodpovídá žádná událost.')):
   el('div',{class:'ax-table-wrap'},el('table',{class:'ax-table ax-audit'},
    el('thead',{},el('tr',{},...[t('Kdy'),t('Událost'),t('Kdo / čeho se týká'),t('Co'),t('Provedl'),t('Výsledek')].map(h=>el('th',{scope:'col'},h)))),
    el('tbody',{},shown.map(e=>el('tr',{},el('td',{'data-label':t('Kdy')},time(e.at)),el('td',{'data-label':t('Událost')},t(EVENTS[e.event])||e.event),
     el('td',{'data-label':t('Kdo / čeho se týká')},e.subject?el('code',{},e.subject):el('span',{class:'ax-dim'},e.id?t('{id} (už neexistuje)',{id:e.id}):'—')),
     el('td',{'data-label':t('Co')},e.detail?el('code',{class:'ax-route'},e.detail):el('span',{class:'ax-dim'},'—')),
     el('td',{'data-label':t('Provedl')},e.by?el('code',{},e.by):el('span',{class:'ax-dim'},'—')),el('td',{'data-label':t('Výsledek')},result(e))))))));
  count.textContent=events.length?t('{shown} z {total}',{shown:shown.length,total:events.length}):'';
 }
 const count=el('span',{class:'ax-count'});
 function draw(){
  bar.replaceChildren(seg(t('Druh události'),auditKind,[['all',t('Vše')],['access',t('Změny přístupu')],['api',t('Zápisy API a MCP')],['device',t('Zařízení')]],v=>{auditKind=v;}),
   seg(t('Výsledek'),auditOnly,[['all',t('Všechny výsledky')],['refused',t('Jen odmítnuté a chyby')]],v=>{auditOnly=v;}),search,count);
  paint();
 }
 const list=loader(async()=>{events=(await api('/api/admin/audit?limit=500')).events;return events;},()=>{draw();return el('div',{class:'ax-stack'},bar,body);});
 return el('div',{class:'ax-stack'},sectionHead(t('Audit'),t('Posledních 500 událostí. Záznamy neobsahují hesla, tokeny ani obsah požadavků.'),button(t('Obnovit'),()=>list.reload(),'small')),list.host);
}

// ---- connect: MCP, who may do what, the API reference ------------------------------------------
// who: public | read | write | admin (administrator, password) | adminRole (administrator or device) | password (cookie) | a scope id
const WHO={security:['security:read','warn'],key:['klíč servisního účtu','warn'],public:['bez přihlášení','dim'],read:['čtení','good'],write:['zápis','warn'],admin:['admin heslem','bad'],adminRole:['admin / zařízení','bad'],password:['přihlášení heslem','warn']};
const ROUTES=[
 ['Účet',[['GET','/api/me','read','Kdo jsem a co smím: role, scopes, canWrite, canAdmin.'],['POST','/api/session','public','Přihlášení {username,password} → cookie homehub.'],['POST','/api/logout','read','Odhlášení.']]],
 ['Domov',[['GET','/api/home','read','Dlaždice strojů: Thermo, služby, router.'],['GET','/api/home/history?machine=<id>&range=30m|7d|30d|6m','read','Řady pro grafy.'],
  ['POST','/api/home/refresh','read','Načíst Thermo hned (omezeno na 1× za 5 s).'],['POST','/api/home/settings','home:settings','Interval čtení Thermo {intervalSeconds: 15|30|60}.']]],
 ['Bezpečnost',[['GET','/api/security','security','Inventář SSH klíčů (snímek z collect-security).']]],
 ['Inventář',[['GET','/api/inventory','read','Celý inventář (knowledge.json) s hashi záznamů.'],['GET','/api/inventory/export','read','Stažení inventáře jako soubor.'],['GET','/api/services','read','Běžící služby (záznamy kind=runtime).'],
  ['POST','/api/inventory/entry','inventory:write','Úprava záznamu s kontrolou.'],['POST','/api/inventory/entries','inventory:write','Nový / celý záznam; vyžaduje aktuální base hash.'],['POST','/api/services','inventory:write','Totéž pro služby.']]],
 ['Správa přístupu',[['GET','/api/admin/users','admin','Seznam uživatelů a rolí.'],['POST','/api/admin/users','admin','Nový uživatel {username, name?, password?, role?} → initialPassword jednou.'],
  ['POST','/api/admin/users/action','admin','{id, disabled} | {id, role} | {id, name} | {id, remove: true}.'],['POST','/api/admin/users/password','admin','{id} → nové vygenerované heslo jednou; staré relace končí.'],
  ['GET','/api/admin/keys','admin','Seznam API klíčů (bez hodnot).'],['POST','/api/admin/keys/revoke','admin','{id}.'],['GET','/api/admin/accounts','admin','Servisní účty, jejich klíče, katalog oprávnění a předvolby.'],['POST','/api/admin/accounts','admin','{name, description?, scopes[]} – read se přidá vždy; ["*"] = plný přístup.'],['POST','/api/admin/accounts/action','admin','{id, scopes} | {id, description} | {id, disabled} | {id, remove: true}.'],['POST','/api/admin/accounts/keys','admin','{accountId, name?} → token jednou.'],['GET','/api/admin/audit?kind=&q=&limit=','admin','Změny přístupu a zápisy přes API / MCP.']]],
 ['Project Tracker',[['GET','/api/tickets?project=&status=active&type=&release=none|…&q=','read','Tickety, projekty a releasy (s počty podle stavu).'],['GET','/api/tickets/HH-12','read','Celý ticket s komentáři, historií a rev.'],
  ['POST','/api/tickets','tickets:write','Nový ticket {project, title, type?, priority?, release?, …}.'],['POST','/api/tickets/update','tickets:write','Změna polí {id, rev, …}; starý rev → 409.'],
  ['POST','/api/tickets/comment','tickets:write','Komentář {id, text}.'],['POST','/api/tickets/releases','tickets:write','Release {project, version, status?, targetDate?, notes?, rev?}.'],['POST','/api/tickets/projects','tickets:write','Nový projekt {id, key, name, description?} nebo změna {id, rev, name?, description?}.']]],
 ['MCP',[['POST','/mcp','key','JSON-RPC 2.0 (initialize, tools/list, tools/call, ping); nástroje podle scopes servisního účtu.']]],
 ['Zařízení',[['GET','/api/devices/tokens','adminRole','Zařízení s tokenem.'],['POST','/api/devices/tokens','password','{name} → token hh_… jednou (jen z přihlášení heslem).'],['POST','/api/devices/tokens/revoke','adminRole','{id}.']]],
];
// Core groups, then what the loaded modules documented (their apiDocs, from the UI manifest). Rows for a
// title that already exists join that card; a route a module documents replaces the row written here.
export function allDocs(docs=site().apiDocs||[]){
 const out=new Map(ROUTES.map(([title,routes])=>[title,[...routes]]));
 const key=r=>`${r[0]} ${r[1].split('?')[0]}`;
 for(const d of docs){const taken=new Set(d.routes.map(key));for(const [title,rows] of out)out.set(title,rows.filter(r=>!taken.has(key(r))));out.set(d.title,[...(out.get(d.title)||[]),...d.routes]);}
 return [...out].filter(([,rows])=>rows.length);
}
const whoPill=who=>{const [label,tone]=WHO[who]||[who,'warn'];return pill(t(label),tone,WHO[who]?null:t('Role nebo servisní účet s tímto oprávněním; zařízení a starý klíč se zápisem také.'));};
// The MCP tools as the running server registered them (UI manifest → tools): the core ones and every
// plugin's, in the order tools/list returns them. Nothing is listed here by hand. A description is written
// for agents, in English: toolLead splits it into its first sentence (shown) and the rest (opens on demand).
export function toolLead(text){
 const all=String(text||'').trim(),m=/^(.*?[.!?])\s+(?=[A-Z("])/s.exec(all);
 return m?[m[1],all.slice(m[0].length)]:[all,''];
}
// [{name, title, scope, write, description, plugin}]: plugin is the title of the plugin that added the tool, else null.
export function toolRows(tools=site().tools||[],modules=site().modules||[]){
 return tools.map(tool=>{const [lead,rest]=toolLead(tool.description),owner=modules.find(m=>m.id===tool.module);
  return {name:tool.name,title:tool.title||tool.name,scope:tool.scope,write:tool.write!==false&&tool.scope!=='read',lead,rest,plugin:owner&&!owner.core?owner.title||owner.id:null};});
}
function toolsCard(){
 const rows=toolRows();
 return el('section',{class:'ax-card'},el('h3',{},t('Nástroje MCP'),' ',el('span',{class:'ax-count'},String(rows.length))),
  el('p',{class:'ax-note'},t('Co tenhle server právě nabízí: nástroje jádra i pluginů. Agent vidí jen ty, na které má jeho klíč oprávnění. Popisy jsou psané pro agenty, proto anglicky.')),
  rows.length?el('div',{class:'ax-table-wrap flat'},el('table',{class:'ax-table ax-tools'},
   el('thead',{},el('tr',{},[t('Nástroj'),t('Oprávnění'),t('Co dělá')].map(h=>el('th',{scope:'col'},h)))),
   el('tbody',{},rows.map(r=>el('tr',{},
    el('td',{},el('code',{class:'ax-route'},r.name),r.plugin?[' ',pill(r.plugin,'info',t('Nástroj z pluginu {name}',{name:r.plugin}))]:null),
    el('td',{},pill(r.scope,r.write?'warn':'good')),
    el('td',{class:'ax-dim'},el('b',{class:'ax-tool-title'},r.title),el('span',{},r.lead),r.rest?el('details',{class:'ax-more'},el('summary',{},t('Celý popis')),el('p',{},r.rest)):null))))))
  :el('p',{class:'ax-note'},t('Tenhle server neposlal seznam nástrojů. Agent ho dostane přes tools/list.')));
}
function connectTab(admin){
 const base=location.origin;
 const yes=()=>el('span',{class:'ax-yes','aria-label':t('ano')},'✓'),no=()=>el('span',{class:'ax-no','aria-label':t('ne')},'—'),some=()=>el('span',{class:'ax-dim'},t('podle oprávnění'));
 const cell=c=>el('td',{},c==='scope'?some():c==='legacy'?el('span',{class:'ax-dim'},t('jen dřívější oprávnění')):c?yes():no());
 const matrix=[[t('Vlastník, Admin'),1,1,1,1],[t('Editor'),1,1,0,0],[t('Čtenář'),1,0,0,0],[t('Vlastní role'),1,'scope','scope',0],[t('Servisní účet'),1,'scope','scope',0],[t('Servisní účet · plný přístup'),1,1,1,0],[t('Zařízení (nativní aplikace)'),1,1,1,0],[t('Starý klíč · čtení'),1,0,0,0],[t('Starý klíč · zápis'),1,'legacy',0,0]];
 const scopeCard=el('section',{class:'ax-card'});
 if(admin){const scopes=loader(async()=>(await api('/api/admin/roles')).scopes,catalog=>el('div',{class:'ax-table-wrap flat'},el('table',{class:'ax-table'},el('tbody',{},
  Object.entries(catalog).map(([id,sc])=>el('tr',{},el('td',{},el('code',{class:'ax-route'},id)),el('td',{},el('b',{},t(sc.label)),' ',sc.write?pill(t('zápis'),'warn'):pill(t('čtení'),'good'),sc.legacy===false?[' ',pill(t('ne pro staré klíče'),'dim',t('Klíč z doby před servisními účty tohle oprávnění nedostane, ani když smí zapisovat.'))]:null),el('td',{class:'ax-dim'},t(sc.desc))))))));
  scopeCard.append(el('h3',{},t('Oprávnění (scopes)')),el('p',{class:'ax-note'},t('Stejná tabulka platí pro role lidí, servisní účty i nástroje MCP. Pluginy přidávají vlastní.')),scopes.host);}
 return el('div',{class:'ax-stack'},
  el('section',{class:'ax-card ax-connect'},el('h3',{},t('Připojení agenta přes MCP')),
   el('p',{class:'ax-note'},...rich(t('Endpoint {url} (MCP Streamable HTTP, odpovědi v JSON). Přihlášení klíčem servisního účtu. Agent vidí jen nástroje, na které má oprávnění.'),{url:el('code',{},`${base}/mcp`)})),
   snippetTabs(null),
   el('p',{class:'ax-note'},admin?[t('Klíč vydáš na záložce Servisní účty. '),button(t('Otevřít servisní účty'),()=>openTab('accounts'),'small')]:t('Klíč ti vydá administrátor: Správa → Uživatelé a API → Servisní účty.'))),
  el('div',{class:'ax-grid2'},
   el('section',{class:'ax-card'},el('h3',{},t('Jak se připojit')),
    el('dl',{class:'ax-dl'},el('dt',{},t('Adresa')),el('dd',{},el('code',{},base)),
     el('dt',{},t('Prohlížeč')),el('dd',{},...rich(t('cookie {cookie} po {login}; POST musí mít stejný {origin}.'),{cookie:el('code',{},'homehub'),login:el('code',{},'POST /api/session'),origin:el('code',{},'Origin')})),
     el('dt',{},t('Skripty')),el('dd',{},el('code',{},'Authorization: Bearer hhk_…'),' ',t('(API klíč)')),
     el('dt',{},t('Aplikace')),el('dd',{},el('code',{},'Authorization: Bearer hh_…'),' ',t('(token zařízení)')),
     el('dt',{},t('POST tělo')),el('dd',{},...rich(t('JSON, {type} (přesně), max 16 kB'),{type:el('code',{},'Content-Type: application/json')})),
     el('dt',{},t('Chyby')),el('dd',{},el('code',{},'{"error":{"code","message"}}'),' ',t('· 401 přihlásit · 403 chybí právo · 404 · 409 konflikt')))),
   el('section',{class:'ax-card'},el('h3',{},t('Kdo co smí')),
    el('div',{class:'ax-table-wrap flat'},el('table',{class:'ax-table ax-matrix'},el('thead',{},el('tr',{},...['',t('Číst'),t('Zápis a akce'),t('Bezpečnost'),t('Správa přístupu')].map(h=>el('th',{scope:'col'},h)))),
     el('tbody',{},matrix.map(([label,...cells])=>el('tr',{},el('th',{scope:'row'},label),...cells.map(cell)))))),
    el('p',{class:'ax-note'},t('Správa přístupu (uživatelé, role, servisní účty, klíče, zařízení) je vždy jen pro Vlastníka a Admina přihlášeného heslem. Žádný klíč ji nedostane, ani s plným přístupem.')),
    el('p',{class:'ax-note'},t('Editor a předvolby servisních účtů se počítají z tabulky oprávnění, takže zahrnují i ta, která přidá plugin. Starý klíč se zápisem má jen oprávnění z doby před servisními účty; novější nedostane nikdy.')))),
  admin?scopeCard:null,
  toolsCard(),
  el('section',{class:'ax-card'},el('h3',{},t('Příklad')),copyBlock('curl',
   `# ${t('čtení')}\ncurl -s -H "Authorization: Bearer $HOME_HUB_KEY" ${base}/api/home\n\n# ${t('zápis (klíč s právem zápisu)')}\ncurl -s -X POST -H "Authorization: Bearer $HOME_HUB_KEY" \\\n  -H 'Content-Type: application/json' -d '{"intervalSeconds":30}' \\\n  ${base}/api/home/settings`)),
  el('h2',{class:'ax-sub'},t('Přehled API')),
  ...allDocs().map(([group,routes])=>el('section',{class:'ax-card'},el('h3',{},t(group)),el('div',{class:'ax-table-wrap flat'},el('table',{class:'ax-table ax-routes'},
   el('tbody',{},routes.map(([method,route,who,desc])=>el('tr',{},el('td',{},el('span',{class:`ax-m ${method.toLowerCase()}`},method)),
    el('td',{},el('code',{class:'ax-route'},route)),el('td',{},whoPill(who)),el('td',{class:'ax-dim'},t(desc))))))))));
}

// ---- the page ---------------------------------------------------------------------------------
let tab='people',openTab=()=>{};
export function accessView(me){
 const admin=me?.canAdmin===true;
 const tabs=admin?[['people',t('Lidé')],['roles',t('Role a oprávnění')],['accounts',t('Servisní účty')],['keys',t('API klíče')],['devices',t('Zařízení')],['connect',t('Připojení a API')],['audit',t('Audit')]]:[['connect',t('Připojení a API')]];
 if(!tabs.some(([id])=>id===tab))tab=tabs[0][0];
 const statusLine=el('p',{class:'ax-status',role:'status','aria-live':'polite'});
 const status=(text,error=false)=>{statusLine.textContent=text;statusLine.classList.toggle('error',error);};
 const content=el('div',{role:'tabpanel',id:'ax-panel'});
 const nav=el('div',{class:'ax-tabs',role:'tablist','aria-label':t('Uživatelé a API')},tabs.map(([id,label])=>el('button',{type:'button',role:'tab','data-tab':id,'aria-controls':'ax-panel',onclick:()=>openTab(id)},label)));
 // Arrow keys move between tabs, as a tab list should.
 nav.addEventListener('keydown',e=>{const i=tabs.findIndex(([id])=>id===tab),step=e.key==='ArrowRight'?1:e.key==='ArrowLeft'?-1:0;if(!step)return;
  e.preventDefault();openTab(tabs[(i+step+tabs.length)%tabs.length][0]);nav.querySelector(`[data-tab="${tab}"]`)?.focus();});
 function paint(){
  status('');
  content.replaceChildren(tab==='roles'?rolesTab(status):tab==='accounts'?accountsTab(status):tab==='keys'?keysTab(status):tab==='devices'?devicesTab(status):tab==='audit'?auditTab():tab==='connect'?connectTab(admin):peopleTab(status,me));
  nav.querySelectorAll('button').forEach(b=>{const on=b.dataset.tab===tab;b.classList.toggle('on',on);b.setAttribute('aria-selected',String(on));b.tabIndex=on?0:-1;});
 }
 openTab=id=>{if(tabs.some(([x])=>x===id)){tab=id;paint();}};
 const how=admin?t('heslem'):me?.authKind==='device'?t('tokenem zařízení'):me?.authKind==='api-key'?t('API klíčem'):t('heslem');
 const box=el('div',{class:'ax'},
  pageHeader({eyebrow:t('Správa'),title:t('Uživatelé a API'),
   lead:admin?t('Kdo se smí přihlásit a co smí: lidé a jejich role, agenti se servisními účty, klíče a zařízení.'):t('Jak se k tomuto Home Hubu připojit. Správa přístupu je jen pro Vlastníka a Admina přihlášeného heslem.')}),
  el('p',{class:'ax-whoami'},t('Přihlášen {name} · {role} · {how}',{name:me?.name||me?.username||'?',role:t(me?.roleName)||me?.role||'',how})),
  nav,statusLine,content);
 paint();
 return box;
}
// Page entry for the shell (app.js): every page module exports (context) => Node, and the server's UI
// manifest names it. context = {me, page, sub, machine, site}.
export const accessPage=({me})=>accessView(me);
