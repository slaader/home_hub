// The update check in the browser (server/core/updates.mjs, GET /api/updates): the release block on the
// "Home Hub update check" card of Administration → Integrations, and what the footer needs to point at a
// newer release. Home Hub only tells; nothing here installs anything.
// Text-safe DOM only: the release text is somebody else's prose and lands in a text node, never as HTML,
// and the only link made from the answer must lead to the repository's releases on GitHub.
import {el} from './views.js';
import {authGuard} from './session-cache.js';
import {t,locale} from './i18n.js';
import {timeZone} from './site.js';
import {toast} from './ui.js';

export async function loadUpdates(){
 const lost=authGuard(),r=await fetch('/api/updates',{signal:AbortSignal.timeout(15000)});
 if(!r.ok){lost(r);throw new Error('updates');}
 return r.json();
}
/** The release page, or null when the address is not under https://github.com/<repo>/releases/. */
export function releaseLink(u){
 const url=u?.latest?.url,prefix=typeof u?.repo==='string'&&/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/.test(u.repo)?`https://github.com/${u.repo}/releases/`:null;
 return prefix&&typeof url==='string'&&url.startsWith(prefix)&&!/[\s<>"'`\\]/.test(url)?url:null;
}
/** The command that applies the newest release (docs/updating.md), or null when the answer holds none of that shape. */
export const applyCommand=u=>typeof u?.apply?.command==='string'&&/^node scripts\/update\.mjs apply v[0-9A-Za-z.+-]{1,64}$/.test(u.apply.command)?u.apply.command:null;
/** What the footer shows an administrator: only a newer release that is known and was not dismissed. */
export const footerHint=u=>u&&u.updateAvailable===true&&!u.dismissed&&typeof u.latest?.version==='string'?{latest:u.latest.version}:null;
const announce=u=>{try{dispatchEvent(new CustomEvent('updateschange',{detail:u}));}catch{}};
const day=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))?new Intl.DateTimeFormat(locale(),{day:'numeric',month:'numeric',year:'numeric',timeZone:timeZone()}).format(new Date(v)):'';

function paint(box,u){
 announce(u);
 const latest=u.latest;
 if(!latest){box.hidden=true;box.replaceChildren();return;}
 const link=releaseLink(u),date=day(latest.publishedAt);
 const dismiss=u.updateAvailable&&!u.dismissed?el('button',{type:'button',class:'ui-button small quiet',onclick:async e=>{
  const button=e.currentTarget;button.disabled=true;
  try{
   const lost=authGuard(),r=await fetch('/api/updates/dismiss',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({version:latest.version}),signal:AbortSignal.timeout(15000)});
   const data=await r.json().catch(()=>({}));if(!r.ok){lost(r);throw new Error(t(data.error?.message||'Požadavek selhal.'));}
   toast.good(t('Vydání {version} se už v patičce nepřipomíná.',{version:latest.version}));paint(box,data.updates);
  }catch(err){toast.bad(err.message);button.disabled=false;}}},t('V patičce nepřipomínat')):null;
 box.hidden=false;
 // replaceChildren() would print a missing part as the word "null": only the parts that exist go in.
 box.replaceChildren(...[
  el('p',{class:'up-head'},el('b',{},t('Vydání {version}',{version:latest.version})),date?el('span',{class:'ig-dim'},` · ${date}`):null,
   link?el('a',{href:link,target:'_blank',rel:'noopener noreferrer'},t('Otevřít na GitHubu')):null),
  // The command is the server's own text for a plain release tag (GET /api/updates → apply.command); it goes in a text node.
  u.updateAvailable?el('p',{},applyCommand(u)?t('Home Hub se neaktualizuje sám. Na serveru spusť v jeho checkoutu příkaz níže: ověří vydání {tag}, zazálohuje data, přepne, restartuje a při potížích se vrátí zpět. Postup je v docs/updating.md.',{tag:latest.tag})
   :t('Home Hub se neaktualizuje sám. Aktualizaci provede správce na serveru příkazem scripts/update.mjs; postup je v docs/updating.md.')):null,
  u.updateAvailable&&applyCommand(u)?el('code',{class:'up-command'},applyCommand(u)):null,
  latest.notes?el('details',{class:'up-notes',...(u.updateAvailable?{open:''}:{})},el('summary',{},t('Poznámky k vydání')),el('pre',{},latest.notes)):null,
  dismiss,u.updateAvailable&&u.dismissed?el('p',{class:'ig-dim'},t('V patičce se tohle vydání nepřipomíná.')):null].filter(Boolean));
}
/** The block under the card's summary. It fills in once the answer is here and stays out of the way otherwise. */
export function updateDetails(){
 const box=el('div',{class:'up-box',hidden:''});
 loadUpdates().then(u=>paint(box,u)).catch(()=>{});
 return box;
}
