// Settings (#settings): the signed-in account, what its role allows, and its own preferences: language
// and theme (per browser), time zone (per account, GET/POST /api/profile*), and the password. Opened from the
// profile menu at the bottom of the sidebar. POST /api/profile/password needs the current password; on
// success the server ends this account's other sessions and hands this browser a fresh one.
import {el} from './views.js';
import {authGuard} from './session-cache.js';
import {t,getLang,setLang,locale,LANGS} from './i18n.js';
import {site,setSite} from './site.js';
import {pageHeader,segmented,themeSwitch} from './ui.js';

// The role's own name when the server sent one (Vlastník, Admin, Editor, Čtenář or a custom role's name).
export const roleLabel=me=>me?.roleName?t(me.roleName):me?.role==='admin'?t('Správce'):me?.role==='viewer'?t('Čtenář'):me?.role||'';
const signIn=me=>me?.authKind==='session'?t('heslem'):me?.authKind==='device'?t('tokenem zařízení'):me?.authKind==='api-key'?t('API klíčem'):me?.authKind||'—';
const browserZone=()=>{try{return Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC';}catch{return 'UTC';}};
const zones=()=>{try{return Intl.supportedValuesOf('timeZone');}catch{return [];}};
const clockIn=zone=>{try{return new Intl.DateTimeFormat(locale(),{weekday:'short',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',timeZone:zone||undefined,timeZoneName:'short'}).format(new Date());}catch{return '';}};
async function call(url,body){
 const lost=authGuard(),r=await fetch(url,{...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});
 const data=await r.json().catch(()=>({}));
 if(r.status===401)lost(r);
 if(!r.ok)throw new Error(t(data.error?.message)||t('Požadavek selhal.'));
 return data;
}

function passwordForm(me){
 const status=el('p',{class:'set-status',role:'status'});
 const field=(id,label,autocomplete,hint)=>[el('label',{for:id},t(label)),el('input',{id,name:id,type:'password',autocomplete,required:'',minlength:id==='current'?'1':'12',maxlength:'256'}),hint?el('small',{class:'set-hint'},t(hint)):null];
 const show=(text,tone)=>{status.textContent=text;status.className=`set-status ${tone||''}`;status.setAttribute('role',tone==='bad'?'alert':'status');};
 const form=el('form',{class:'set-form',onsubmit:async e=>{
   e.preventDefault();const f=e.currentTarget,button=f.querySelector('button');
   const current=f.current.value,next=f.next.value,again=f.again.value;
   if(next.length<12)return show(t('Nové heslo musí mít aspoň 12 znaků.'),'bad');
   if(next===current)return show(t('Nové heslo musí být jiné než současné.'),'bad');
   if(next!==again)return show(t('Nová hesla se neshodují.'),'bad');
   button.disabled=true;show(t('Ukládám…'));
   try{
    const lost=authGuard(),r=await fetch('/api/profile/password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({currentPassword:current,newPassword:next})});
    const body=await r.json().catch(()=>({}));
    if(r.status===401){lost(r);return;}
    if(!r.ok)return show(t(body.error?.message)||t('Heslo se nepodařilo změnit.'),'bad');
    f.reset();show(body.signedIn?t('Heslo je změněné. Ostatní přihlášení tohoto účtu skončila, tady zůstáváš přihlášený.'):t('Heslo je změněné. Přihlas se znovu novým heslem.'),'good');
    if(!body.signedIn)setTimeout(lost.signedOut,1500);// only if this same sign-in is still on screen
   }catch{show(t('Home Hub neodpovídá. Zkus to znovu.'),'bad');}
   finally{button.disabled=false;}
  }},
  // Lets password managers attach the new password to the right account.
  el('input',{type:'text',name:'username',autocomplete:'username',value:me.username||'',hidden:'','aria-hidden':'true',tabindex:'-1'}),
  ...field('current','Současné heslo','current-password'),
  ...field('next','Nové heslo','new-password','Aspoň 12 znaků. Nejlépe delší fráze nebo heslo z password manageru.'),
  ...field('again','Nové heslo znovu','new-password'),
  status,
  el('div',{class:'set-actions'},el('button',{type:'submit',class:'hh-primary'},t('Změnit heslo'))));
 return form;
}

// What was just saved, shown once on the page drawn after it (saving a zone redraws the whole shell).
let flash='';
// The zone times are shown in: the site's, this browser's, or one picked from the list. Saved per account.
function zoneCard(profile){
 const siteZone=profile.site.timeZone,current=profile.prefs.timeZone;
 const status=el('p',{class:'set-status good',role:'status'},flash);flash='';
 const preview=el('p',{class:'set-clock','aria-live':'polite'});
 const groups=new Map();for(const z of zones()){const region=z.includes('/')?z.split('/')[0]:t('Ostatní');groups.set(region,[...(groups.get(region)||[]),z]);}
 const option=(value,label)=>el('option',{value,selected:(current||'')===value?'':null},label);
 const select=el('select',{id:'set-zone',name:'timeZone'},
  option('',siteZone?t('Podle webu ({zone})',{zone:siteZone}):t('Podle webu (pásmo prohlížeče)')),
  option('browser',t('Podle tohoto prohlížeče ({zone})',{zone:browserZone()})),
  // A saved zone this browser does not list still shows as chosen.
  current&&current!=='browser'&&!zones().includes(current)?option(current,current):null,
  [...groups].map(([region,list])=>el('optgroup',{label:region},list.map(z=>option(z,z.replaceAll('_',' '))))));
 const effective=()=>select.value==='browser'?null:select.value||siteZone||null;
 const tick=()=>{preview.textContent=t('Právě teď: {time}',{time:clockIn(effective())});};
 select.addEventListener('change',async()=>{
  tick();select.disabled=true;status.className='set-status';status.textContent=t('Ukládám…');
  try{
   const saved=await call('/api/profile/prefs',{timeZone:select.value||null});
   // Every time on every page follows site.timeZone, so set it and let the shell draw itself again. 'langchange'
   // is the shell's "how things are formatted has changed": it redraws the clock, the page and the footer.
   setSite({timeZone:saved.site.timeZone});flash=t('Časové pásmo uloženo.');dispatchEvent(new Event('langchange'));
  }catch(err){status.className='set-status bad';status.textContent=err.message||t('Home Hub neodpovídá. Zkus to znovu.');select.disabled=false;}
 });
 tick();
 return el('section',{class:'set-card'},el('h3',{},t('Časové pásmo')),
  el('p',{class:'set-dim'},t('V jakém pásmu se ukazují všechny časy. Volba patří k tvému účtu a platí ve všech prohlížečích.')),
  el('div',{class:'set-form'},el('label',{for:'set-zone'},t('Pásmo')),select),preview,status);
}
// The account card: who, the role, and what the role allows.
function accountCard(me,profile){
 const allowed=profile?.permissions||[];
 return el('section',{class:'set-card'},el('h3',{},t('Účet')),
  el('dl',{class:'set-dl'},
   el('dt',{},t('Uživatel')),el('dd',{},me?.username||'—'),
   el('dt',{},t('Jméno')),el('dd',{},me?.name||me?.username||'—'),
   el('dt',{},t('Role')),el('dd',{},roleLabel(me),el('span',{class:'set-dim'},` · ${me?.canAdmin?t('plný přístup, správa uživatelů a klíčů'):me?.canWrite?t('čtení a zápis podle role'):t('jen čtení')}`)),
   el('dt',{},t('Přihlášení')),el('dd',{},signIn(me))),
  allowed.length?[el('p',{class:'set-dim set-allowed-head'},t('Co tvoje role smí')),
   el('ul',{class:'set-allowed'},allowed.map(p=>el('li',{title:`${p.id} – ${t(p.desc)}`},el('span',{class:`set-dot ${p.write?'write':'read'}`,'aria-hidden':'true'}),t(p.label))))]:null,
  me?.canAdmin?el('p',{class:'set-dim'},el('a',{href:'#access'},t('Spravovat uživatele, role a klíče →'))):el('p',{class:'set-dim'},t('Roli ti mění administrátor.')));
}

export function settingsView(me){
 const session=me?.authKind==='session';
 const account=el('div',{},accountCard(me,null)),zone=el('div',{});
 if(session){
  zone.append(el('section',{class:'set-card','aria-busy':'true'},el('h3',{},t('Časové pásmo')),el('p',{class:'set-dim'},t('Načítám…'))));
  const load=()=>call('/api/profile').then(profile=>{account.replaceChildren(accountCard(me,profile));zone.replaceChildren(zoneCard(profile));})
   .catch(err=>zone.replaceChildren(el('section',{class:'set-card'},el('h3',{},t('Časové pásmo')),el('p',{class:'set-status bad',role:'alert'},err.message||t('Home Hub neodpovídá. Zkus to znovu.')),
    el('div',{class:'set-actions'},el('button',{type:'button',class:'ui-button',onclick:load},t('Zkusit znovu'))))));
  load();
 }else zone.append(el('section',{class:'set-card'},el('h3',{},t('Časové pásmo')),el('p',{class:'set-dim'},t('Časy se ukazují v pásmu webu ({zone}). Vlastní pásmo si nastavíš po přihlášení heslem v prohlížeči.',{zone:site().timeZone||browserZone()}))));
 return el('div',{class:'set'},
  pageHeader({eyebrow:t('Účet'),title:t('Nastavení'),lead:t('Tvůj účet, jazyk, vzhled, časové pásmo a heslo.')}),
  el('div',{class:'set-grid'},
   account,
   el('section',{class:'set-card'},el('h3',{},t('Jazyk')),
    el('p',{class:'set-dim'},t('Jazyk rozhraní. Volba platí pro tento prohlížeč.')),
    segmented({label:t('Jazyk'),value:getLang(),onchange:setLang,options:LANGS.map(([id,name])=>({id,label:name,lang:id}))})),
   // The same switch as in the account menu and on the sign-in card; ui.js keeps them in step.
   el('section',{class:'set-card'},el('h3',{},t('Vzhled')),
    el('p',{class:'set-dim'},t('Světlý, tmavý, nebo podle systému. Volba platí pro tento prohlížeč.')),
    themeSwitch()),
   zone,
   el('section',{class:'set-card'},el('h3',{},t('Změna hesla')),
    session?[el('p',{class:'set-dim'},t('Po změně skončí všechna ostatní přihlášení tohoto účtu (jiné prohlížeče a záložky). Tokeny zařízení a API klíče platí dál.')),passwordForm(me)]
     :el('p',{class:'set-dim'},t('Heslo se dá změnit jen po přihlášení heslem v prohlížeči, ne přes token zařízení nebo API klíč.')))));
}
// Page entry for the shell (app.js): every page module exports (context) => Node, and the server's UI
// manifest names it. context = {me, page, sub, machine, site}.
export const settingsPage=({me})=>settingsView(me);
