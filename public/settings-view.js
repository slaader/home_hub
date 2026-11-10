// Nastavení (#settings): the signed-in account and its password. Opened from the profile menu at the
// bottom of the sidebar. POST /api/profile/password needs the current password; on success the server
// ends this account's other sessions and hands this browser a fresh one, so the page stays signed in.
import {el} from './views.js';
import {authGuard} from './session-cache.js';
import {t,getLang,setLang,LANGS} from './i18n.js';

export const roleLabel=me=>me?.role==='admin'?t('Správce'):me?.role==='viewer'?t('Čtenář'):me?.role||'';
const signIn=me=>me?.authKind==='session'?t('heslem'):me?.authKind==='device'?t('tokenem zařízení'):me?.authKind==='api-key'?t('API klíčem'):me?.authKind||'—';

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

export function settingsView(me){
 const canChange=me?.authKind==='session';
 return el('div',{class:'set'},
  el('div',{class:'dev-head'},el('div',{class:'dev-title'},el('a',{class:'home-back',href:'#overview'},`← ${t('Přehled')}`),el('h2',{},t('Nastavení')),
   el('div',{class:'dev-host'},`${me?.name||me?.username||''} · ${roleLabel(me)}`))),
  el('div',{class:'set-grid'},
   el('section',{class:'set-card'},el('h3',{},t('Účet')),
    el('dl',{class:'set-dl'},
     el('dt',{},t('Uživatel')),el('dd',{},me?.username||'—'),
     el('dt',{},t('Jméno')),el('dd',{},me?.name||me?.username||'—'),
     el('dt',{},'Role'),el('dd',{},roleLabel(me),me?.role==='admin'?el('span',{class:'set-dim'},` · ${t('plný přístup, správa uživatelů a klíčů')}`):el('span',{class:'set-dim'},` · ${t('jen čtení')}`)),
     el('dt',{},t('Přihlášení')),el('dd',{},signIn(me)))),
   el('section',{class:'set-card'},el('h3',{},t('Jazyk')),
    el('p',{class:'set-dim'},t('Jazyk rozhraní. Volba platí pro tento prohlížeč.')),
    el('div',{class:'hh-lang',role:'group','aria-label':t('Jazyk')},...LANGS.map(([id,name])=>el('button',{type:'button',lang:id,class:getLang()===id?'on':'','aria-pressed':String(getLang()===id),onclick:()=>setLang(id)},name)))),
   el('section',{class:'set-card'},el('h3',{},t('Změna hesla')),
    canChange?[el('p',{class:'set-dim'},t('Po změně skončí všechna ostatní přihlášení tohoto účtu (jiné prohlížeče a záložky). Tokeny zařízení a API klíče platí dál.')),passwordForm(me)]
     :el('p',{class:'set-dim'},t('Heslo se dá změnit jen po přihlášení heslem v prohlížeči, ne přes token zařízení nebo API klíč.')))));
}
// Page entry for the shell (app.js): every page module exports (context) => Node, and the server's UI
// manifest names it. context = {me, page, sub, machine, site}.
export const settingsPage=({me})=>settingsView(me);
