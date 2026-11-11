// Home Hub shell: sidebar + top bar + one page. Sign-in → the overview (#overview) → a machine page (#host-<id>).
// What the sidebar lists and which module draws #<page>[/sub] is not written here: it comes from the
// server's UI manifest (GET /api/ui/manifest), built from the modules that are loaded there: core ones
// (overview, inventory, security, tracker, review, access, settings, search) and whatever plugins a site
// adds. The manifest is already filtered for the signed-in account; admin-only pages are refused here too.
// A page module exports one function, (context) => Node, with context = {me, page, sub, machine, site}.
// Machine pages (#host-<id>) have no sidebar entries; they open from the overview tiles.
//
// Around the page the shell provides: the sidebar (a rail when collapsed, a drawer on a phone), the command
// palette (Cmd/Ctrl-K, palette.js), the loading bar and toasts (ui.js), a banner while the hub does not
// answer (net.js), the theme and language switches, the build footer, and the offer of the getting-started
// checklist to a hub that looks new (onboarding.js). docs/design.md describes the pieces.
import {el,leaveView} from './views.js';
import {refreshHome,setPollInterval} from './home-view.js';
import {roleLabel} from './settings-view.js';
import {setIdentity,setupScreen} from './access.js';
import {setPrincipal,setPages,pageAllowed,pageOf,HOME_PAGE} from './session-cache.js';
import {t,tp,locale,getLang,setLang,setDefaultLang,addStrings,LANGS} from './i18n.js';
import {site,setSite,timeZone,zoneName} from './site.js';
import {emptyState,errorState,banner,segmented,themeSwitch,toast,startLoading,icon} from './ui.js';
import {navIcon} from './icons.js';
import {getTheme,setTheme,resolvedTheme} from './theme.js';
import {createPalette} from './palette.js';
import {watchNetwork,pingHub,hubState} from './net.js';
import {loadOnboarding,offersOnboarding,isDismissed} from './onboarding.js';
const root=document.querySelector('#root');
let me=null,loginMessage='',manifest={pages:[],nav:[]},knownMachines=[];
const WELCOME='welcome';
const clock=el('span',{class:'hh-clock'});
const tick=()=>{clock.textContent=new Intl.DateTimeFormat(locale(),{weekday:'short',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',timeZone:timeZone()}).format(new Date());};
tick();setInterval(tick,15000);
// Per-browser shell preferences. Storage can be refused (private mode, a blocked cookie jar): then the
// shell simply starts in its default shape every time.
const pref={get:key=>{try{return localStorage.getItem(key);}catch{return null;}},set:(key,value)=>{try{localStorage.setItem(key,value);}catch{}}};
const brandName=()=>site().name||'Home Hub';
const orb=()=>el('span',{class:'hh-orb','aria-hidden':'true'});

function login(message=''){
 me=null;setPrincipal(null);setPages(null);setIdentity(null);leaveView();drawn++;document.querySelector('#inv-detail')?.close();
 palette.close();setDrawer(false);onboarding=null;telemetry.hidden=true;
 // message is Czech source text (a t() key), so a language switch on this screen redraws it translated.
 loginMessage=message;
 document.title=site().name?`Home Hub · ${site().name}`:'Home Hub';
 const alert=el('p',{role:'alert',class:'hh-error'},t(message));
 root.replaceChildren(el('main',{id:'main',class:'hh-login'},
  el('div',{class:'hh-login-card'},
   el('div',{class:'hh-mark'},orb(),'Home Hub'),
   site().name?el('p',{class:'hh-login-site'},site().name):null,
   el('p',{class:'hh-dim'},t('Stroje, služby a lokální AI na jednom místě.')),
   el('form',{onsubmit:async event=>{event.preventDefault();const form=event.currentTarget;const button=form.querySelector('button');button.disabled=true;alert.textContent='';
     try{const response=await fetch('/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:form.username.value,password:form.password.value})});
      const result=await response.json().catch(()=>({}));if(!response.ok){alert.textContent=t(result.error?.message)||t('Přihlášení selhalo.');return;}await start();}
     catch{alert.textContent=t('Home Hub není dosažitelný. Zkus to znovu.');}finally{button.disabled=false;}}},
    el('label',{for:'username'},t('Uživatel')),el('input',{id:'username',name:'username',autocomplete:'username',autocapitalize:'none',spellcheck:'false',required:'',value:'admin'}),
    el('label',{for:'password'},t('Heslo')),el('input',{id:'password',name:'password',type:'password',autocomplete:'current-password',required:''}),
    alert,el('button',{type:'submit',class:'hh-primary'},t('Vstoupit'))),
   el('div',{class:'hh-login-foot'},langSwitch(),themeSwitch()))));
 root.querySelector('#password')?.focus();
}
// First run: this hub has no owner account yet (manifest → setupRequired). The screen is public/access.js → setupScreen.
function setup(){me=null;setPrincipal(null);setPages(null);setIdentity(null);leaveView();drawn++;root.replaceChildren(setupScreen({retry:start}));}
// CZ | EN switch: in the account menu and on the sign-in card. The choice is per browser (localStorage).
const langSwitch=()=>segmented({label:t('Jazyk'),value:getLang(),onchange:setLang,options:LANGS.map(([id,name,short])=>({id,label:short,title:name,lang:id}))});
async function logout(){try{await fetch('/api/logout',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});}finally{login();}}
// Bottom of the sidebar: who is signed in; click opens language, theme, Nastavení, the getting-started
// checklist and Odhlásit (Escape or a click outside closes it).
let closeProfile=()=>{};
addEventListener('click',()=>closeProfile());
addEventListener('keydown',e=>{if(e.key==='Escape'){closeProfile(true);setDrawer(false);}});
function profileMenu(page){
 const name=me.name||me.username,initials=name.replace(/[^\p{L}\p{N}]+/gu,' ').trim().split(/\s+/).map(w=>w[0]).join('').slice(0,2).toUpperCase()||'?';
 const item=(hash,mark,label)=>el('a',{href:`#${hash}`,role:'menuitem',class:page===hash?'on':'',onclick:()=>closeProfile()},icon(mark),label);
 const menu=el('div',{class:'hh-menu',role:'menu',id:'hh-menu',hidden:''},
  el('div',{class:'hh-menu-head'},el('b',{},name),el('span',{},`${me.username} · ${roleLabel(me)}`)),
  el('div',{class:'hh-menu-row'},el('span',{},t('Jazyk')),langSwitch()),
  el('div',{class:'hh-menu-row'},el('span',{},t('Vzhled')),themeSwitch()),
  el('div',{class:'hh-menu-sep',role:'separator'}),
  item('settings','settings',t('Nastavení')),
  pageAllowed(WELCOME,me)&&manifest.pages.some(p=>p.hash===WELCOME)?item(WELCOME,'flag',t('První kroky')):null,
  el('button',{type:'button',role:'menuitem',class:'hh-out',onclick:logout},icon('signout'),t('Odhlásit')));
 const button=el('button',{type:'button',class:`hh-acct${page==='settings'?' on':''}`,'aria-haspopup':'menu','aria-expanded':'false','aria-controls':'hh-menu',title:`${name} · ${roleLabel(me)}`,
   onclick:e=>{e.stopPropagation();if(menu.hidden){menu.hidden=false;button.setAttribute('aria-expanded','true');menu.querySelector('[role="menuitem"]')?.focus();}else closeProfile();}},
  el('span',{class:'hh-face','aria-hidden':'true'},initials),el('span',{class:'hh-acct-text'},el('b',{},name),el('small',{},roleLabel(me))),el('span',{class:'hh-acct-caret','aria-hidden':'true'},'⌃'));
 menu.addEventListener('click',e=>e.stopPropagation());
 // Up and down walk the menu's entries.
 menu.addEventListener('keydown',e=>{
  if(e.key!=='ArrowDown'&&e.key!=='ArrowUp')return;
  const items=[...menu.querySelectorAll('[role="menuitem"]')],at=items.indexOf(document.activeElement);if(!items.length)return;
  e.preventDefault();items[(at+(e.key==='ArrowDown'?1:-1)+items.length)%items.length].focus();
 });
 closeProfile=refocus=>{if(!menu.hidden){menu.hidden=true;button.setAttribute('aria-expanded','false');if(refocus===true)button.focus();}};
 return el('div',{class:'hh-acct-wrap'},menu,button);
}
// Sidebar: one group per section, a heading above its items, exactly as the manifest lists them:
// admin-only entries are already left out for other roles, and the router refuses their pages
// anyway (pageAllowed in render()). An entry marked soon is a faded placeholder without a link.
// Labels: labelKey is source text for t(); label is shown as it is (a product name such as "Review").
// Collapsed (desktop) it is a rail of icons; on a phone it is a drawer opened from the top bar.
const labelOf=x=>x.labelKey?t(x.labelKey):x.label||'';
let railed=pref.get('hh-sidebar')==='rail',drawer=false,navScroll=0;
function setRail(next){railed=next;pref.set('hh-sidebar',next?'rail':'full');root.querySelector('.hh-shell')?.classList.toggle('rail',next);paintCollapse();}
function paintCollapse(){
 const button=root.querySelector('.hh-collapse');if(!button)return;
 const label=railed?t('Rozbalit postranní panel'):t('Sbalit postranní panel');
 button.setAttribute('aria-label',label);button.setAttribute('title',label);button.setAttribute('aria-pressed',String(railed));
}
function setDrawer(next,{refocus=false}={}){
 if(drawer===next)return;drawer=next;
 const shellNode=root.querySelector('.hh-shell');if(!shellNode)return;
 shellNode.classList.toggle('drawer',next);document.documentElement.classList.toggle('hh-lock',next);
 const button=shellNode.querySelector('.hh-menu-btn');button?.setAttribute('aria-expanded',String(next));
 if(next)shellNode.querySelector('.hh-nav a[href]')?.focus();else if(refocus)button?.focus();
}
// The offer of the getting-started checklist, while this hub still looks new (onboarding.js).
let onboarding=null;
const startEntry=page=>offersOnboarding(onboarding,{edition:manifest.edition,dismissed:isDismissed(me)})&&manifest.pages.some(p=>p.hash===WELCOME)
 ?el('a',{class:`hh-start${page===WELCOME?' on':''}`,href:`#${WELCOME}`,title:t('První kroky'),'aria-current':page===WELCOME?'page':null},navIcon({hash:WELCOME}),
   el('span',{class:'hh-nav-label'},t('První kroky')),el('span',{class:'hh-start-count'},`${onboarding.requiredDone}/${onboarding.requiredTotal}`)):null;
// The offer comes and goes without drawing the page again (the checklist page itself reports progress).
function paintStart(){
 const side=root.querySelector('.hh-side');if(!side||!me)return;
 const next=startEntry(pageOf(location.hash)),old=side.querySelector('.hh-start');
 if(old&&next)old.replaceWith(next);else if(old)old.remove();else if(next)side.querySelector('.hh-acct-wrap')?.before(next);
}
function sidebar(machine,page){
 const current=machine?HOME_PAGE:page||HOME_PAGE;
 const link=item=>{const label=labelOf(item);return item.soon?el('a',{class:'soon','aria-disabled':'true',title:label},navIcon({...item,label}),el('span',{class:'hh-nav-label'},label))
  :el('a',{href:`#${item.hash}`,class:item.hash===current?'on':'',title:label,'aria-current':item.hash===current&&!machine?'page':null},navIcon({...item,label}),el('span',{class:'hh-nav-label'},label));};
 const group=g=>{const title=labelOf(g);return g.items.length?el('div',{class:'hh-nav-group',role:'group','aria-label':title},el('div',{class:'hh-nav-h','aria-hidden':'true'},title),...g.items.map(link)):null;};
 const nav=el('nav',{class:'hh-nav','aria-label':t('Hlavní navigace')},...manifest.nav.map(group));
 nav.addEventListener('scroll',()=>{navScroll=nav.scrollTop;},{passive:true});
 return el('aside',{class:'hh-side',id:'hh-side'},
  el('div',{class:'hh-brand'},
   el('a',{class:'hh-mark',href:`#${HOME_PAGE}`,title:brandName()},orb(),el('span',{class:'hh-brand-text'},el('b',{},brandName()),site().name?el('small',{},'Home Hub'):null)),
   el('button',{type:'button',class:'hh-icon-btn hh-collapse',onclick:()=>setRail(!railed)},icon('sidebar'))),
  nav,startEntry(page),profileMenu(page));
}
const hashPage=()=>location.hash.slice(1).split('/')[0];
const route=()=>{const raw=hashPage();return raw.startsWith('host-')?raw.slice(5):null;};
// Page modules are imported on first use and kept; a failed import is retried on the next visit.
const modules=new Map();
const pageModule=url=>{if(!modules.has(url))modules.set(url,import(url).catch(e=>{modules.delete(url);throw e;}));return modules.get(url);};
// The button in the top bar that opens the command palette; the shortcut is shown the way this platform writes it.
const MAC=/Mac|iPhone|iPad/.test(globalThis.navigator?.platform||'');
const jumpButton=()=>el('button',{type:'button',class:'hh-jump','aria-label':t('Hledat nebo přejít na…'),'aria-keyshortcuts':MAC?'Meta+K':'Control+K',onclick:e=>{e.stopPropagation();palette.open();}},
 icon('search'),el('span',{class:'hh-jump-text'},t('Hledat nebo přejít na…')),el('kbd',{class:'hh-kbd'},MAC?'⌘K':'Ctrl K'));
const bannerSlot=el('div',{class:'hh-banner'});
const shell=(machine,page,main,withSearch=true)=>el('div',{class:`hh-shell${railed?' rail':''}`},
 sidebar(machine,page),
 el('button',{type:'button',class:'hh-scrim',tabindex:'-1','aria-label':t('Zavřít nabídku'),onclick:()=>setDrawer(false,{refocus:true})}),
 el('header',{class:'hh-top'},
  el('button',{type:'button',class:'hh-icon-btn hh-menu-btn','aria-label':t('Nabídka'),'aria-expanded':'false','aria-controls':'hh-side',onclick:e=>{e.stopPropagation();setDrawer(!drawer,{refocus:true});}},icon('menu')),
  el('a',{class:'hh-top-brand',href:`#${HOME_PAGE}`},orb(),el('span',{},brandName())),
  withSearch?jumpButton():null,
  el('div',{class:'hh-top-right'},telemetry,clock)),
 bannerSlot,
 el('main',{id:'main',class:'hh-main',tabindex:'-1'},main),
 footer());
// The browser tab says which page this is: "Inventory map · Home Hub · <site>". A machine page is named by
// the machine's name once the overview data has told the shell what it is (until then, by its id).
function pageTitle(machine,page){
 const base=site().name?`Home Hub · ${site().name}`:'Home Hub';
 const item=manifest.nav.flatMap(g=>g.items).find(i=>i.hash===(page||HOME_PAGE));
 const label=machine?knownMachines.find(m=>m.id===machine)?.name||machine:item?labelOf(item):page===WELCOME?t('První kroky'):page==='settings'?t('Nastavení'):page==='search'?t('Hledání'):'';
 return label?`${label} · ${base}`:base;
}
// Each call takes a number; a page whose module arrives after a newer call (or a sign-out) is dropped.
let drawn=0,shownPage=null;
async function render(){
 if(!me)return;
 const turn=++drawn;
 const machine=route(),page=pageOf(location.hash);
 // Admin-only pages are guarded here too, not just hidden from the sidebar.
 if(page&&!pageAllowed(page,me)){leaveView();root.replaceChildren(shell(null,null,
  emptyState({icon:'shield',title:t('Jen pro administrátora'),body:t('Tahle stránka je dostupná jen správci.'),actions:[{label:`← ${t('Přehled')}`,href:`#${HOME_PAGE}`}]}),false));afterDraw(null,page);return;}
 const entry=manifest.pages.find(p=>p.hash===(page||HOME_PAGE));
 let view=null,failed=false;
 const loaded=startLoading();
 if(entry?.view)try{view=(await pageModule(entry.view.url))[entry.view.export];}catch{failed=true;}
 loaded();
 if(turn!==drawn||!me)return;
 leaveView();// the page being replaced lets go of its document/window listeners and timers
 let main;
 try{main=typeof view==='function'?view({me,page:page||HOME_PAGE,sub:location.hash.slice(1).split('/')[1]||null,machine,site:site()})
  :failed||entry
   ?errorState({title:t('Stránku se nepodařilo načíst'),body:t('Modul téhle stránky se nenačetl. Zkus ji otevřít znovu.'),retry:()=>render()})
   :emptyState({icon:'box',title:t('Tady zatím nic není'),body:t('Tenhle Home Hub nemá žádnou úvodní stránku. Zkontroluj, které moduly server načetl.')});}
 // A page that throws while it draws must not take the shell with it.
 catch{leaveView();main=errorState({title:t('Stránku se nepodařilo zobrazit'),body:t('Při vykreslení téhle stránky nastala chyba. Zkus ji otevřít znovu.'),retry:()=>render()});}
 root.replaceChildren(shell(machine,page,main));
 afterDraw(machine,page);
}
// After the shell is drawn again: the sidebar keeps its scroll position, a new page starts at its top with
// the keyboard at the content, and the tab title names it.
function afterDraw(machine,page){
 const key=machine?`host-${machine}`:page||HOME_PAGE,moved=shownPage!==null&&shownPage!==key;shownPage=key;
 drawer=false;document.documentElement.classList.remove('hh-lock');
 const nav=root.querySelector('.hh-nav');if(nav)nav.scrollTop=navScroll;
 paintCollapse();paintRefresh();paintFresh();paintBanner();
 document.title=pageTitle(machine,page);
 if(moved){scrollTo(0,0);root.querySelector('#main')?.focus({preventScroll:true});}
}
// Footer: what is running. Home Hub has no semver on purpose; the edition, the number of plugins and the
// commit are the version.
function footer(){
 const b=me?.build,at=b?.at&&Number.isFinite(Date.parse(b.at))?new Intl.DateTimeFormat(locale(),{day:'numeric',month:'numeric',year:'numeric',hour:'2-digit',minute:'2-digit',timeZone:timeZone()}).format(new Date(b.at)):null;
 const plugins=(manifest.modules||[]).filter(m=>!m.core).length;
 return el('footer',{class:'hh-foot'},el('span',{},site().name?t('Home Hub · {site} · časy v {zone}',{site:site().name,zone:zoneName()}):t('Home Hub · časy v {zone}',{zone:zoneName()})),
  el('span',{class:'hh-version'},
   el('span',{},manifest.edition==='private'?t('soukromá edice'):t('veřejná edice')),
   el('span',{title:(manifest.modules||[]).filter(m=>!m.core).map(m=>m.title||m.id).join(', ')||null},tp(plugins,'{n} plugin|{n} pluginy|{n} pluginů')),
   b?.commit?el('span',{title:at?t('Commit {commit}, nasazeno {at}',{commit:b.commit,at}):t('Commit {commit}',{commit:b.commit})},t('verze {commit}',{commit:b.commit}),at?' · '+at:''):null));
}
// Freshness pill + pull interval switch: one place for all devices. Shown on the overview and the machine
// pages of a hub that has live telemetry; other pages and hubs without it keep a quiet top bar.
let poll=null,liveTelemetry=false;
const freshEvery=el('span',{class:'hh-fresh-every'}),freshAge=el('span',{});const fresh=el('span',{class:'hh-fresh',title:''},el('span',{class:'dot'}),freshEvery,freshAge);
const seg=el('span',{class:'hh-seg',role:'group','aria-label':''});
const refresh=refreshButton();
const telemetry=el('div',{class:'hh-telemetry',hidden:''},fresh,seg,refresh);
function paintFresh(){
 telemetry.hidden=!(me&&poll&&liveTelemetry&&(route()!==null||pageOf(location.hash)===null));
 if(!poll)return;const age=poll.lastPollAt?Math.max(0,Math.round((Date.now()-poll.lastPollAt)/1000)):null;
 fresh.title=t('Jak často Home Hub čte Thermo na Macích; hodnoty na dlaždicích jsou průměr za tento interval.');seg.setAttribute('aria-label',t('Interval čtení'));
 freshEvery.textContent=`Ø ${poll.intervalSeconds} s ·`;freshAge.textContent=age==null?t('čekám'):t('před {n} s',{n:age});
 fresh.classList.toggle('stale',age!=null&&age>poll.intervalSeconds*2+5);
 seg.replaceChildren(...[15,30,60].map(v=>el('button',{class:poll.intervalSeconds===v?'on':'','aria-pressed':String(poll.intervalSeconds===v),title:t('Číst Thermo každých {n} s',{n:v}),onclick:async()=>{try{await setPollInterval(v);}catch{toast.bad(t('Interval se nepodařilo změnit.'));}}},`${v} s`)));
}
addEventListener('homedata',e=>{
 poll=e.detail?.poll||poll;
 if(Array.isArray(e.detail?.machines)){
  knownMachines=e.detail.machines.map(m=>({id:m.id,name:m.name}));liveTelemetry=e.detail.machines.some(m=>m.kind==='thermo'||m.thermo);
  if(me&&route())document.title=pageTitle(route(),null);
 }
 paintFresh();
});
setInterval(paintFresh,1000);
// The button is made once, before the site's language is known: its words are set when the shell is drawn.
function paintRefresh(){if(refresh.disabled)return;refresh.textContent=`↻ ${t('Obnovit')}`;refresh.title=t('Načíst teď z Thermo');}
function refreshButton(){
 const b=el('button',{class:'hh-quiet hh-refresh',title:t('Načíst teď z Thermo'),onclick:async()=>{if(b.disabled)return;b.disabled=true;b.classList.add('busy');b.textContent=`↻ ${t('Načítám…')}`;
   try{const r=await refreshHome();b.textContent=`↻ ${r?.refresh?.pulled?t('Načteno z Thermo'):t('Data jsou čerstvá (< 5 s)')}`;}catch{b.textContent=`↻ ${t('Nepovedlo se')}`;}finally{setTimeout(()=>{b.disabled=false;b.classList.remove('busy');b.textContent=`↻ ${t('Obnovit')}`;},2200);}}},`↻ ${t('Obnovit')}`);
 return b;
}
// The banner under the top bar while the browser is offline or the hub does not answer: what is on screen
// was loaded earlier. When the hub is back the page is drawn again with fresh data.
let wasDown=false;
function paintBanner(){
 const s=hubState(),at=new Intl.DateTimeFormat(locale(),{hour:'2-digit',minute:'2-digit',timeZone:timeZone()}).format(new Date(s.lastOk));
 if(!me||(!s.down&&!s.offline)){bannerSlot.replaceChildren();return;}
 bannerSlot.replaceChildren(banner({tone:'warn',
  title:s.offline?t('Jsi offline.'):t('Home Hub neodpovídá.'),
  body:t('To, co vidíš, je z {at} a může být zastaralé.',{at}),
  actions:[{label:t('Zkusit znovu'),onclick:async()=>{if(!await pingHub())toast.bad(t('Home Hub pořád neodpovídá.'));}}]}));
}
addEventListener('hubstate',e=>{
 const down=e.detail.down||e.detail.offline;
 paintBanner();
 if(wasDown&&!down&&me){toast.good(t('Spojení je zpátky.'));render();}
 wasDown=down;
});
watchNetwork();
// Command palette: every page this account may open, a few shell actions, machine pages seen so far,
// and full-text search when the hub has it.
const palette=createPalette({
 pages:()=>{
  const listed=manifest.nav.flatMap(g=>g.items.filter(i=>i.hash).map(i=>({hash:i.hash,label:labelOf(i),group:labelOf(g),icon:i.icon})));
  const extra=[['settings',t('Nastavení')],[WELCOME,t('První kroky')]].filter(([hash])=>manifest.pages.some(p=>p.hash===hash)&&!listed.some(i=>i.hash===hash)).map(([hash,label])=>({hash,label,group:'Home Hub'}));
  return [...listed,...extra];
 },
 machines:()=>knownMachines,
 canSearch:()=>manifest.pages.some(p=>p.hash==='search'),
 actions:()=>[
  {id:'theme',label:resolvedTheme()==='dark'?t('Přepnout na světlý vzhled'):t('Přepnout na tmavý vzhled'),icon:resolvedTheme()==='dark'?'sun':'moon',run:()=>setTheme(resolvedTheme()==='dark'?'light':'dark')},
  ...(getTheme()==='system'?[]:[{id:'theme-system',label:t('Vzhled podle systému'),icon:'monitor',run:()=>setTheme('system')}]),
  ...LANGS.filter(([id])=>id!==getLang()).map(([id,name])=>({id:`lang-${id}`,label:t('Jazyk: {name}',{name}),icon:'globe',run:()=>setLang(id)})),
  {id:'sidebar',label:railed?t('Rozbalit postranní panel'):t('Sbalit postranní panel'),icon:'sidebar',run:()=>setRail(!railed)},
  {id:'signout',label:t('Odhlásit'),icon:'signout',run:logout},
 ],
});
addEventListener('keydown',e=>{
 if((e.metaKey||e.ctrlKey)&&!e.altKey&&!e.shiftKey&&e.key.toLowerCase()==='k'&&me){e.preventDefault();closeProfile();palette.toggle();}
});
// The manifest answers without a sign-in too, with just what the sign-in screen needs (site name, default language).
async function loadManifest(){
 const r=await fetch('/api/ui/manifest');if(!r.ok)throw new Error('manifest');
 manifest=await r.json();
 setSite({...manifest.site,inventory:manifest.inventory,apiDocs:manifest.apiDocs||[],tools:manifest.tools||[],modules:manifest.modules||[]});addStrings(manifest.strings);setDefaultLang(manifest.site?.defaultLanguage);
 document.title=manifest.site?.name?`Home Hub · ${manifest.site.name}`:'Home Hub';tick();
 return manifest;
}
// Is this a hub that still needs setting up? One read of /api/home answers for a hub that has machines;
// the sidebar then offers the checklist (or not). A new public hub opened without a page in the address
// lands on the checklist instead of an empty overview.
async function offerOnboarding(){
 if(!manifest.pages.some(p=>p.hash===WELCOME)||isDismissed(me))return;
 const who=me,landing=manifest.edition==='public'&&!location.hash;
 const status=loadOnboarding(me,{quick:true}).then(quick=>offersOnboarding(quick,{edition:manifest.edition})?loadOnboarding(who):quick).catch(()=>null)
  .then(result=>{if(me!==who||!result)return;onboarding=result;return result;});
 if(!landing){status.then(()=>{if(me===who)paintStart();});return;}
 const result=await Promise.race([status,new Promise(resolve=>setTimeout(()=>resolve(null),2500))]);
 if(me===who&&!location.hash&&offersOnboarding(result,{edition:manifest.edition,dismissed:isDismissed(me)}))history.replaceState(null,'',`#${WELCOME}`);
}
async function start(){
 try{
  const found=await loadManifest();
  if(found.setupRequired)return setup();
  if(!found.signedIn)return login();
  const r=await fetch('/api/me');if(r.status===401)return login();if(!r.ok)throw new Error();
  me=await r.json();setPrincipal(me);setPages(manifest.pages);setIdentity(me);await offerOnboarding();await render();
 }
 catch{login('Home Hub teď neodpovídá. Zkus to znovu.');}
}
addEventListener('hashchange',()=>{if(me){palette.close();render();}});
// Language switched (account menu or sign-in card): draw the current page, or the sign-in, again in it.
addEventListener('langchange',()=>{tick();if(me){closeProfile();render();}else if(root.querySelector('.hh-setup'))setup();else if(root.querySelector('.hh-login'))login(loginMessage);});
// The checklist page reports what it found (detail = the status), or it was dismissed or brought back:
// the sidebar offer follows. Theme switches need nothing here: colours follow the tokens, and ui.js keeps
// every theme switch on screen in step.
addEventListener('onboardingchange',e=>{if(!me)return;if(e.detail)onboarding=e.detail;paintStart();});
// An inventory edit was saved: draw the map again from the published file.
addEventListener('inventoryupdated',()=>{if(me)render();});
// Session expired (e.g. hub restarted): go back to sign-in instead of showing frozen numbers.
addEventListener('authlost',()=>{if(me)login('Přihlášení vypršelo, přihlas se znovu.');});
await start();
