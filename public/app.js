// Home Hub shell: sidebar + one page. Sign-in → the overview (#overview) → a machine page (#host-<id>).
// What the sidebar lists and which module draws #<page>[/sub] is not written here: it comes from the
// server's UI manifest (GET /api/ui/manifest), built from the modules that are loaded there: core ones
// (overview, inventory, security, tracker, review, access, settings, search) and whatever plugins a site
// adds. The manifest is already filtered for the signed-in account; admin-only pages are refused here too.
// A page module exports one function, (context) => Node, with context = {me, page, sub, machine, site}.
// Machine pages (#host-<id>) have no sidebar entries; they open from the overview tiles.
import {el,leaveView} from './views.js';
import {refreshHome,setPollInterval} from './home-view.js';
import {searchBox,queryOf} from './search-view.js';
import {roleLabel} from './settings-view.js';
import {setIdentity} from './access.js';
import {setPrincipal,setPages,pageAllowed,pageOf,HOME_PAGE} from './session-cache.js';
import {t,locale,getLang,setLang,setDefaultLang,addStrings,LANGS} from './i18n.js';
import {site,setSite,timeZone,zoneName} from './site.js';
import {emptyState} from './ui.js';
const root=document.querySelector('#root');
let me=null,loginMessage='',manifest={pages:[],nav:[]};
const clock=el('span',{class:'hh-clock'});
const tick=()=>{clock.textContent=new Intl.DateTimeFormat(locale(),{weekday:'short',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',timeZone:timeZone()}).format(new Date());};
tick();setInterval(tick,15000);

function login(message=''){
 me=null;setPrincipal(null);setPages(null);setIdentity(null);leaveView();drawn++;document.querySelector('#inv-detail')?.close();
 // message is Czech source text (a t() key), so a language switch on this screen redraws it translated.
 loginMessage=message;
 const alert=el('p',{role:'alert',class:'hh-error'},t(message));
 root.replaceChildren(el('main',{id:'main',class:'hh-login'},
  el('div',{class:'hh-login-card'},
   el('div',{class:'hh-mark'},el('span',{class:'hh-orb'}),'Home Hub'),
   el('h1',{},t('Dům, jak právě dýchá.')),
   el('p',{class:'hh-dim'},t('Stroje, služby a lokální AI na jednom místě.')),
   el('form',{onsubmit:async event=>{event.preventDefault();const form=event.currentTarget;const button=form.querySelector('button');button.disabled=true;alert.textContent='';
     try{const response=await fetch('/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:form.username.value,password:form.password.value})});
      const result=await response.json().catch(()=>({}));if(!response.ok){alert.textContent=t(result.error?.message)||t('Přihlášení selhalo.');return;}await start();}
     catch{alert.textContent=t('Home Hub není dosažitelný. Zkus to znovu.');}finally{button.disabled=false;}}},
    el('label',{for:'username'},t('Uživatel')),el('input',{id:'username',name:'username',autocomplete:'username',required:'',value:'admin'}),
    el('label',{for:'password'},t('Heslo')),el('input',{id:'password',name:'password',type:'password',autocomplete:'current-password',required:''}),
    alert,el('button',{type:'submit',class:'hh-primary'},t('Vstoupit'))),langSwitch('hh-login-lang'))));
 root.querySelector('#password')?.focus();
}
// CZ | EN switch: in the profile menu and on the sign-in card. The choice is per browser (localStorage).
function langSwitch(cls){
 return el('div',{class:`hh-lang ${cls}`,role:'group','aria-label':t('Jazyk')},
  ...LANGS.map(([id,name,short])=>el('button',{type:'button',lang:id,class:getLang()===id?'on':'','aria-pressed':String(getLang()===id),title:name,onclick:e=>{e.stopPropagation();setLang(id);}},short)));
}
async function logout(){try{await fetch('/api/logout',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});}finally{login();}}
// Bottom of the sidebar: who is signed in; click opens Nastavení and Odhlásit (Escape or a click outside closes it).
let closeProfile=()=>{};
addEventListener('click',()=>closeProfile());
addEventListener('keydown',e=>{if(e.key==='Escape')closeProfile();});
function profileMenu(page){
 const name=me.name||me.username,initials=name.replace(/[^\p{L}\p{N}]+/gu,' ').trim().split(/\s+/).map(w=>w[0]).join('').slice(0,2).toUpperCase()||'?';
 const menu=el('div',{class:'hh-prof-menu',role:'menu',id:'hh-prof-menu',hidden:''},
  el('div',{class:'hh-prof-head'},el('b',{},name),el('span',{},`${me.username} · ${roleLabel(me)}`)),
  el('div',{class:'hh-prof-lang'},el('span',{},t('Jazyk')),langSwitch('')),
  el('a',{href:'#settings',role:'menuitem',class:page==='settings'?'on':''},`⚙\u2002${t('Nastavení')}`),
  el('button',{type:'button',role:'menuitem',class:'hh-prof-out',onclick:logout},`↪\u2002${t('Odhlásit')}`));
 const button=el('button',{type:'button',class:`hh-prof${page==='settings'?' on':''}`,'aria-haspopup':'menu','aria-expanded':'false','aria-controls':'hh-prof-menu',title:`${name} · ${roleLabel(me)}`,
   onclick:e=>{e.stopPropagation();if(menu.hidden){menu.hidden=false;button.setAttribute('aria-expanded','true');menu.querySelector('a')?.focus();}else closeProfile();}},
  el('span',{class:'hh-avatar','aria-hidden':'true'},initials),el('span',{class:'hh-prof-text'},el('b',{},name),el('small',{},roleLabel(me))),el('span',{class:'hh-prof-caret','aria-hidden':'true'},'⌃'));
 menu.addEventListener('click',e=>e.stopPropagation());
 menu.querySelector('a').addEventListener('click',()=>closeProfile());
 closeProfile=()=>{if(!menu.hidden){menu.hidden=true;button.setAttribute('aria-expanded','false');}};
 return el('div',{class:'hh-prof-wrap'},menu,button);
}
// Sidebar: one group per section, a heading (accent, rule) above indented items, exactly as the manifest
// lists them: admin-only entries are already left out for other roles, and the router refuses their pages
// anyway (pageAllowed in render()). An entry marked soon is a faded placeholder without a link.
// Labels: labelKey is source text for t(); label is shown as it is (a product name such as "Review").
const labelOf=x=>x.labelKey?t(x.labelKey):x.label||'';
function sidebar(machine,page){
 const current=machine?null:page||HOME_PAGE;
 const link=item=>item.soon?el('a',{class:'soon','aria-disabled':'true'},labelOf(item)):el('a',{href:`#${item.hash}`,class:item.hash===current?'on':'','aria-current':item.hash===current?'page':null},labelOf(item));
 const group=g=>{const title=labelOf(g);return g.items.length?el('div',{class:'hh-nav-group',role:'group','aria-label':title},el('div',{class:'hh-nav-h','aria-hidden':'true'},title),...g.items.map(link)):null;};
 const net=[site().name,site().lanCidrs?.[0]].filter(Boolean).join(' · ');
 return el('aside',{class:'hh-side'},
  el('a',{class:'hh-mark',href:`#${HOME_PAGE}`},el('span',{class:'hh-orb'}),'Home Hub'),
  el('nav',{class:'hh-nav','aria-label':t('Hlavní navigace')},...manifest.nav.map(group)),
  profileMenu(page),net?el('div',{class:'hh-side-net'},net):null);
}
const hashPage=()=>location.hash.slice(1).split('/')[0];
const route=()=>{const raw=hashPage();return raw.startsWith('host-')?raw.slice(5):null;};
// Page modules are imported on first use and kept; a failed import is retried on the next visit.
const modules=new Map();
const pageModule=url=>{if(!modules.has(url))modules.set(url,import(url).catch(e=>{modules.delete(url);throw e;}));return modules.get(url);};
const shell=(machine,page,main,withSearch=true)=>el('div',{class:'hh-shell'},
 sidebar(machine,page),
 el('header',{class:'hh-top'},withSearch?searchBox(page==='search'?queryOf(location.hash.slice(1).split('/')[1]):''):null,
  el('div',{class:'hh-top-right'},fresh,seg,refreshButton(),clock)),
 el('main',{id:'main',class:'hh-main'},main),
 footer());
// Each call takes a number; a page whose module arrives after a newer call (or a sign-out) is dropped.
let drawn=0;
async function render(){
 if(!me)return;
 const turn=++drawn;
 const machine=route(),page=pageOf(location.hash);
 // Admin-only pages are guarded here too, not just hidden from the sidebar.
 if(page&&!pageAllowed(page,me)){leaveView();root.replaceChildren(shell(null,null,
  el('div',{class:'sec-empty'},el('h2',{},t('Jen pro administrátora')),el('p',{class:'sec-dim'},t('Tahle stránka je dostupná jen správci.')),el('a',{href:`#${HOME_PAGE}`},`← ${t('Přehled')}`)),false));return;}
 const entry=manifest.pages.find(p=>p.hash===(page||HOME_PAGE));
 let view=null,failed=false;
 if(entry?.view)try{view=(await pageModule(entry.view.url))[entry.view.export];}catch{failed=true;}
 if(turn!==drawn||!me)return;
 leaveView();// the page being replaced lets go of its document/window listeners and timers
 const main=typeof view==='function'?view({me,page:page||HOME_PAGE,sub:location.hash.slice(1).split('/')[1]||null,machine,site:site()})
  :emptyState(failed||entry
   ?{icon:'⚠',title:t('Stránku se nepodařilo načíst'),body:t('Modul téhle stránky se nenačetl. Zkus ji otevřít znovu.'),actions:[{label:t('Zkusit znovu'),onclick:()=>render(),primary:true}]}
   :{icon:'◌',title:t('Tady zatím nic není'),body:t('Tenhle Home Hub nemá žádnou úvodní stránku. Zkontroluj, které moduly server načetl.')});
 root.replaceChildren(shell(machine,page,main));
}
// Footer: the running commit on the right. Home Hub has no semver on purpose; the commit is the version.
function footer(){
 const b=me?.build,at=b?.at&&Number.isFinite(Date.parse(b.at))?new Intl.DateTimeFormat(locale(),{day:'numeric',month:'numeric',year:'numeric',hour:'2-digit',minute:'2-digit',timeZone:timeZone()}).format(new Date(b.at)):null;
 return el('footer',{class:'hh-foot'},el('span',{},site().name?t('Home Hub · {site} · časy v {zone}',{site:site().name,zone:zoneName()}):t('Home Hub · časy v {zone}',{zone:zoneName()})),
  b?.commit?el('span',{class:'hh-version',title:at?t('Commit {commit}, nasazeno {at}',{commit:b.commit,at}):t('Commit {commit}',{commit:b.commit})},t('verze {commit}',{commit:b.commit}),at?' · '+at:''):null);
}
// Freshness pill + pull interval switch: one place for all devices.
let poll=null;
const freshText=el('span',{});const fresh=el('span',{class:'hh-fresh',title:''},el('span',{class:'dot'}),freshText);
const seg=el('span',{class:'hh-seg',role:'group','aria-label':''});
function paintFresh(){
 if(!poll)return;const age=poll.lastPollAt?Math.max(0,Math.round((Date.now()-poll.lastPollAt)/1000)):null;
 fresh.title=t('Jak často Home Hub čte Thermo na Macích; hodnoty na dlaždicích jsou průměr za tento interval.');seg.setAttribute('aria-label',t('Interval čtení'));
 freshText.textContent=`Ø ${poll.intervalSeconds} s · ${age==null?t('čekám'):t('před {n} s',{n:age})}`;
 fresh.classList.toggle('stale',age!=null&&age>poll.intervalSeconds*2+5);
 seg.replaceChildren(...[15,30,60].map(v=>el('button',{class:poll.intervalSeconds===v?'on':'','aria-pressed':String(poll.intervalSeconds===v),title:t('Číst Thermo každých {n} s',{n:v}),onclick:async()=>{try{await setPollInterval(v);}catch{}}},`${v} s`)));
}
addEventListener('homedata',e=>{poll=e.detail?.poll||poll;paintFresh();});
setInterval(paintFresh,1000);
function refreshButton(){
 const b=el('button',{class:'hh-quiet hh-refresh',title:t('Načíst teď z Thermo'),onclick:async()=>{if(b.disabled)return;b.disabled=true;b.classList.add('busy');b.textContent=`↻ ${t('Načítám…')}`;
   try{const r=await refreshHome();b.textContent=`↻ ${r?.refresh?.pulled?t('Načteno z Thermo'):t('Data jsou čerstvá (< 5 s)')}`;}catch{b.textContent=`↻ ${t('Nepovedlo se')}`;}finally{setTimeout(()=>{b.disabled=false;b.classList.remove('busy');b.textContent=`↻ ${t('Obnovit')}`;},2200);}}},`↻ ${t('Obnovit')}`);
 return b;
}
// The manifest answers without a sign-in too, with just what the sign-in screen needs (site name, default language).
async function loadManifest(){
 const r=await fetch('/api/ui/manifest');if(!r.ok)throw new Error('manifest');
 manifest=await r.json();
 setSite({...manifest.site,inventory:manifest.inventory,apiDocs:manifest.apiDocs||[]});addStrings(manifest.strings);setDefaultLang(manifest.site?.defaultLanguage);
 document.title=manifest.site?.name?`Home Hub · ${manifest.site.name}`:'Home Hub';tick();
 return manifest;
}
async function start(){
 try{
  if(!(await loadManifest()).signedIn)return login();
  const r=await fetch('/api/me');if(r.status===401)return login();if(!r.ok)throw new Error();
  me=await r.json();setPrincipal(me);setPages(manifest.pages);setIdentity(me);await render();
 }
 catch{login('Home Hub teď neodpovídá. Zkus to znovu.');}
}
addEventListener('hashchange',()=>{if(me)render();});
// Language switched (profile menu or sign-in card): draw the current page, or the sign-in, again in it.
addEventListener('langchange',()=>{tick();if(me){closeProfile();render();paintFresh();}else if(root.querySelector('.hh-login'))login(loginMessage);});
// An inventory edit was saved: draw the map again from the published file.
addEventListener('inventoryupdated',()=>{if(me)render();});
// Session expired (e.g. hub restarted): go back to sign-in instead of showing frozen numbers.
addEventListener('authlost',()=>{if(me)login('Přihlášení vypršelo, přihlas se znovu.');});
await start();
