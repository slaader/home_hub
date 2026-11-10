// Who is signed in, for views that only need to know what they may show, and the first-run screen the
// shell draws in place of the sign-in while this hub has no owner account (GET /api/ui/manifest →
// setupRequired). The owner is created on the server, by someone who can run a command there: a page
// anyone on the network can open must not be able to claim the hub.
import {el} from './views.js';
import {t,getLang,setLang,LANGS} from './i18n.js';
import {copyBlock} from './ui.js';

let identity=null;
export const setIdentity=value=>{identity=value;};
export const currentIdentity=()=>identity;
export const canWrite=()=>identity?.canWrite===true;
export const canAdmin=()=>identity?.canAdmin===true;
// Does the signed-in account hold this scope? (Its role's scopes for a person; everything for an administrator.)
export const hasScope=scope=>Array.isArray(identity?.scopes)&&identity.scopes.includes(scope);

export const SETUP_COMMAND='node scripts/setup.mjs';
/**
 * "Finish setup": what is missing, the one command that fixes it, and a button that looks again.
 * retry() re-reads the manifest (app.js → start); it resolves once the screen has been replaced or redrawn.
 */
let looked=false;// "try again" was pressed: the redrawn screen says that there is still no owner
export function setupScreen({retry}={}){
 const status=el('p',{class:'ax-status error',role:'status','aria-live':'polite'},looked?t('Vlastník ještě neexistuje. Spusť příkaz na serveru a zkus to znovu.'):'');
 const again=el('button',{type:'button',class:'hh-primary',onclick:async()=>{again.disabled=true;looked=true;status.textContent=t('Zjišťuji…');
   try{await retry?.();}finally{if(again.isConnected)again.disabled=false;}}},t('Hotovo, zkusit znovu'));
 return el('main',{id:'main',class:'hh-login hh-setup'},
  el('div',{class:'hh-login-card'},
   el('div',{class:'hh-mark'},el('span',{class:'hh-orb'}),'Home Hub'),
   el('h1',{},t('Dokonči nastavení')),
   el('p',{class:'hh-dim'},t('Tenhle Home Hub běží, ale ještě nemá vlastníka: účet, kterým se přihlásíš a který spravuje všechno ostatní.')),
   el('ol',{},
    el('li',{},t('Otevři terminál na stroji, kde Home Hub běží, ve složce s jeho kódem.')),
    el('li',{},t('Spusť příkaz níže. Zeptá se na jméno a heslo; heslo uloží jen jako otisk.')),
    el('li',{},t('Vrať se sem a přihlas se. Restart není potřeba.'))),
   copyBlock(t('Příkaz'),SETUP_COMMAND),
   // The sentence with the command set as code: the text is split around the {command} placeholder.
   el('p',{class:'hh-dim'},...t('Bez terminálu, třeba v kontejneru? {command} vytvoří heslo samo a uloží ho do private/ACCESS.txt.').split('{command}').flatMap((part,i)=>i?[el('code',{},`${SETUP_COMMAND} --generate`),part]:[part])),
   el('div',{class:'ax-actions'},again),status,
   el('div',{class:'hh-lang hh-login-lang',role:'group','aria-label':t('Jazyk')},
    ...LANGS.map(([id,name,short])=>el('button',{type:'button',lang:id,class:getLang()===id?'on':'','aria-pressed':String(getLang()===id),title:name,onclick:()=>setLang(id)},short)))));
}
