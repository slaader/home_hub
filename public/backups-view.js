// Zálohování (#backup-jobs): backups the hub runs itself (server/core/backups.mjs).
//   #backup-jobs               every job: state, last and next run, size, snapshots; run now / cancel
//   #backup-jobs/<id>          one job: its set-up, and a table of its runs and the snapshots they made
//   #backup-jobs/new, /edit-<id>   the set-up wizard (public/backups-wizard.js)
// Everyone who can read sees the jobs. Running, cancelling and deleting a snapshot need backup-jobs:manage;
// setting a job up needs an administrator with a password sign-in (the server checks both again).
// Text-safe DOM only; strings are Czech source text through t() (English in i18n-en-backups.js).
import {el,onLeave} from './views.js';
import {authGuard} from './session-cache.js';
import {t,tp,locale} from './i18n.js';
import {timeZone,zoneName} from './site.js';
import {pageHeader,emptyState,errorState,loadingState,disabledNotice,statusPill,toast,banner} from './ui.js';
import {wizardView} from './backups-wizard.js';

const css=()=>{if(!document.querySelector('link[href="/backups.css"]'))document.head.append(el('link',{rel:'stylesheet',href:'/backups.css'}));};

// ---- the server ----------------------------------------------------------------------------------
export async function api(url,body){
 const lost=authGuard(),r=await fetch(url,{...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(body?90000:20000)});
 const data=await r.json().catch(()=>({}));
 if(!r.ok){lost(r);const f=data.error?.field,e=new Error([t(data.error?.message||'Požadavek selhal.'),...(f?[t('Zkontroluj: {field}.',{field:fieldName(f)})]:data.error?.details||[])].join(' '));e.status=r.status;e.code=data.error?.code;e.reason=data.error?.reason;throw e;}
 return data;
}

// ---- words and numbers -----------------------------------------------------------------------------
// What a field of the wizard is called, for an error that names it (target.path, sources[1].host, …).
const FIELDS={name:'název úlohy',host:'stroj',port:'port SSH',user:'uživatel',path:'cesta',kind:'odkud',schedule:'plán',time:'čas',days:'dny v týdnu',mode:'plán',
 retention:'uchování',keepLast:'ponechat posledních',keepDays:'ponechat mladší než',excludes:'vynechat',timeoutMinutes:'nejdelší běh',enabled:'spouštět podle plánu',target:'cíl',sources:'zdroje'};
export function fieldName(f){
 const m=/^([a-zA-Z]+)(?:\[(\d+)\])?(?:\.([a-zA-Z]+))?$/.exec(f||'');if(!m)return f;
 const [,part,index,leaf]=m,where=part==='target'?t('cíl'):part==='sources'?t('zdroj {n}',{n:Number(index)+1}):part==='excludes'?t('vynechat (řádek {n})',{n:Number(index)+1}):t(FIELDS[part]||part);
 return leaf?`${where} – ${t(FIELDS[leaf]||leaf)}`:where;
}
// What a job still lacks (the server's codes) in words.
export const missingText=list=>(list||[]).map(m=>m==='target'?t('cíl'):m==='target-key'?t('potvrzený klíč cíle'):m==='sources'?t('zdroje'):m.startsWith('source-key:')?t('potvrzený klíč zdroje {name}',{name:m.slice(11)}):m).join(', ');
const STATE={ok:['v pořádku','good'],warning:['s varováním','warn'],failed:['selhala','bad'],cancelled:['zrušena','warn'],interrupted:['přerušena','bad'],running:['běží','info'],
 ready:['připravena','info'],draft:['rozpracovaná',''],off:['vypnutá','']};
export const statePill=state=>{const [label,tone]=STATE[state]||STATE.failed;return statusPill(t(label),tone);};
const RESULT={ok:['hotovo','good'],warning:['s varováním','warn'],failed:['chyba','bad'],cancelled:['zrušeno','warn'],interrupted:['přerušeno','bad'],running:['běží','info']};
const resultPill=r=>{const [label,tone]=RESULT[r]||RESULT.failed;return statusPill(t(label),tone);};
const TRIGGER={manual:'ručně',schedule:'plán','catch-up':'dohnání'};
const valid=v=>typeof v==='string'&&Number.isFinite(Date.parse(v));
export const when=v=>valid(v)?new Intl.DateTimeFormat(locale(),{day:'numeric',month:'numeric',year:'numeric',hour:'2-digit',minute:'2-digit',timeZone:timeZone()}).format(new Date(v)):'—';
export function bytes(n){
 if(!Number.isFinite(n))return '—';
 const units=['B','KB','MB','GB','TB','PB'];let i=0,v=n;while(v>=1024&&i<units.length-1){v/=1024;i++;}
 return `${new Intl.NumberFormat(locale(),{maximumFractionDigits:v<10&&i?1:0}).format(v)} ${units[i]}`;
}
export function duration(ms){
 if(!Number.isFinite(ms))return '—';
 const s=Math.round(ms/1000);if(s<60)return t('{n} s',{n:s});
 const m=Math.floor(s/60);if(m<60)return t('{m} min {s} s',{m,s:s%60});
 return t('{h} h {m} min',{h:Math.floor(m/60),m:m%60});
}
const num=n=>Number.isFinite(n)?new Intl.NumberFormat(locale()).format(n):'—';
const DAYS=['po','út','st','čt','pá','so','ne'];
export function scheduleText(s){
 if(!s||s.mode==='manual')return t('jen ručně');
 if(s.mode==='daily')return t('denně v {time}',{time:s.time});
 return t('{days} v {time}',{days:s.days.map(d=>t(DAYS[d-1])).join(', '),time:s.time});
}
export function retentionText(r){
 const parts=[];if(r?.keepLast)parts.push(tp(r.keepLast,'poslední {n} snímek|poslední {n} snímky|posledních {n} snímků'));if(r?.keepDays)parts.push(tp(r.keepDays,'{n} den|{n} dny|{n} dní'));
 return parts.length?t('ponechat {what}',{what:parts.join(t(' a '))}):'—';
}
export const targetText=tg=>tg?`${tg.user}@${tg.host}${tg.port!==22?`:${tg.port}`:''}:${tg.path}`:'—';
export const sourceText=s=>s.kind==='local'?t('tento hub: {path}',{path:s.path}):`${s.user}@${s.host}${s.port!==22?`:${s.port}`:''}:${s.path}`;
const canRun=me=>me?.canAdmin===true||(Array.isArray(me?.scopes)&&me.scopes.includes('backup-jobs:manage'));

// ---- actions ---------------------------------------------------------------------------------------
async function act(button,run,done){
 button.disabled=true;button.setAttribute('aria-busy','true');
 try{const out=await run();done?.(out);}catch(e){toast.bad(e.message);}finally{button.disabled=false;button.removeAttribute('aria-busy');}
}
function runButtons(job,me,refresh){
 if(!canRun(me)||!job.missing||job.missing.length)return [];
 if(job.running)return [el('button',{type:'button',class:'ui-button small danger',onclick:e=>{if(!confirm(t('Zrušit běžící zálohu {name}?',{name:job.name})))return;
  act(e.currentTarget,()=>api('/api/backup-jobs/cancel',{id:job.id}),()=>{toast(t('Zálohu ruším…'));refresh();});}},t('Zrušit'))];
 return [el('button',{type:'button',class:'ui-button small',onclick:e=>act(e.currentTarget,()=>api('/api/backup-jobs/run',{id:job.id}),()=>{toast.good(t('Záloha běží.'));refresh();})},t('Spustit teď'))];
}
// While something runs, the page reads again every few seconds; it stops when the page goes.
function poller(refresh){let timer=null;onLeave(()=>clearTimeout(timer));return busy=>{clearTimeout(timer);if(busy)timer=setTimeout(refresh,4000);};}

// ---- the list --------------------------------------------------------------------------------------
function listView(me){
 const admin=me?.canAdmin===true,body=el('div',{class:'bk-body'},loadingState(t('Načítám zálohy…')));
 const again=poller(()=>load(false));
 async function load(first=true){
  if(first)body.replaceChildren(loadingState(t('Načítám zálohy…')));
  let data;try{data=await api('/api/backup-jobs');}catch(e){body.replaceChildren(errorState({title:t('Zálohy se nepodařilo načíst'),body:e.message,retry:()=>load()}));return;}
  const parts=[];
  if(data.disabled)parts.push(disabledNotice(data.disabled,{compact:true,body:t('Plánovač teď nic nespouští a zálohu nejde spustit ručně. Úlohy i snímky zůstaly.')}));
  if(!data.jobs.length)parts.push(emptyState({icon:'archive',title:t('Zatím žádná záloha'),body:t('Home Hub umí sám zálohovat přes SSH a rsync na NAS nebo jiný stroj: každý běh je samostatný snímek, nezměněné soubory se jen odkazují.'),
   steps:[t('Připrav na cílovém stroji uživatele a adresář pro zálohy.'),t('Průvodce vytvoří klíč a ukáže řádek do authorized_keys.'),t('Ověř spojení, vyber, co zálohovat, a nastav plán.')],
   actions:admin?[{label:t('Nová záloha'),href:'#backup-jobs/new',primary:true}]:[]}),...(admin?[]:[el('p',{class:'bk-note'},t('Zálohy nastavuje administrátor přihlášený heslem.'))]));
  else parts.push(el('div',{class:'bk-table-wrap'},el('table',{class:'bk-table'},
   el('thead',{},el('tr',{},...[t('Úloha'),t('Stav'),t('Kam'),t('Poslední běh'),t('Příští běh'),t('Velikost'),t('Snímky'),''].map(h=>el('th',{scope:'col'},h)))),
   el('tbody',{},data.jobs.map(job=>el('tr',{},
    el('th',{scope:'row'},el('a',{href:`#backup-jobs/${job.id}`},job.name),el('small',{class:'bk-dim'},scheduleText(job.schedule))),
    el('td',{},statePill(job.state),job.running?el('small',{class:'bk-dim'},t('od {when}',{when:when(job.running.startedAt)})):null),
    el('td',{class:'bk-path'},targetText(job.target)),
    el('td',{},job.lastRun?[when(job.lastRun.startedAt),el('small',{class:'bk-dim'},job.lastRun.error?t(job.lastRun.message||''):duration(job.lastRun.durationMs))]:'—'),
    el('td',{},job.nextRunAt?when(job.nextRunAt):'—'),
    el('td',{class:'bk-num'},bytes(job.sizeBytes)),
    el('td',{class:'bk-num'},num(job.snapshots)),
    el('td',{class:'bk-actions'},...runButtons(job,me,()=>load(false)))))))));
  body.replaceChildren(...parts);
  again(data.jobs.some(j=>j.running));
 }
 load();
 return el('div',{class:'bk-page'},pageHeader({eyebrow:t('Domov'),title:t('Zálohování'),
  lead:t('Zálohy, které Home Hub spouští sám: rsync přes SSH na cílový stroj, jeden procházitelný snímek na běh. Časy jsou v časovém pásmu {zone}.',{zone:zoneName()}),
  actions:admin?[{label:t('Nová záloha'),href:'#backup-jobs/new',primary:true}]:[]}),body);
}

// ---- one job ---------------------------------------------------------------------------------------
function fact(label,...value){return el('div',{class:'bk-fact'},el('dt',{},label),el('dd',{},...value));}
function detailView(me,id){
 const admin=me?.canAdmin===true,body=el('div',{class:'bk-body'},loadingState(t('Načítám zálohu…')));
 const head=el('div',{},pageHeader({back:{label:t('Zálohování'),href:'#backup-jobs'},title:t('Záloha')}));
 const again=poller(()=>load(false));
 async function load(first=true){
  if(first)body.replaceChildren(loadingState(t('Načítám zálohu…')));
  let d;try{d=await api(`/api/backup-jobs/detail?id=${encodeURIComponent(id)}`);}
  catch(e){body.replaceChildren(errorState({title:t('Zálohu se nepodařilo načíst'),body:e.message,retry:()=>load(),actions:[{label:t('Zálohování'),href:'#backup-jobs'}]}));return;}
  const job=d.job,refresh=()=>load(false);
  const actions=[...runButtons(job,me,refresh),
   ...(canRun(me)&&!job.missing.length?[el('button',{type:'button',class:'ui-button small quiet',onclick:e=>act(e.currentTarget,()=>api('/api/backup-jobs/refresh',{id}),()=>{toast(t('Seznam snímků je načtený znovu.'));refresh();})},t('Načíst snímky z cíle'))]:[]),
   ...(admin?[el('a',{class:'ui-button small',href:`#backup-jobs/edit-${id}`},t('Upravit')),
    el('button',{type:'button',class:'ui-button small danger',onclick:e=>{if(!confirm(t('Smazat úlohu {name} a její klíč? Snímky na cíli zůstanou.',{name:job.name})))return;
     act(e.currentTarget,()=>api('/api/backup-jobs/delete',{id,base:job.hash}),()=>{toast.good(t('Úloha je smazaná.'));location.hash='#backup-jobs';});}},t('Smazat úlohu'))]:[])];
  head.replaceChildren(pageHeader({back:{label:t('Zálohování'),href:'#backup-jobs'},eyebrow:t('Záloha'),title:job.name,lead:scheduleText(job.schedule)}));
  const parts=[];
  if(d.disabled)parts.push(disabledNotice(d.disabled,{compact:true,body:t('Plánovač teď nic nespouští a zálohu nejde spustit ručně. Úlohy i snímky zůstaly.')}));
  if(job.missing.length)parts.push(banner({tone:'warn',title:t('Úloha není dokončená.'),body:t('Chybí: {what}.',{what:missingText(job.missing)}),actions:admin?[{label:t('Pokračovat v průvodci'),href:`#backup-jobs/edit-${id}`}]:[]}));
  if(job.running)parts.push(banner({tone:'info',title:t('Záloha běží.'),body:t('Od {when}, krok {step}.',{when:when(job.running.startedAt),step:job.running.step}),
   actions:[{label:t('Průběžný záznam'),href:`/api/backup-jobs/log?id=${id}&run=${job.running.runId}`}]}));
  parts.push(el('div',{class:'bk-head-row'},el('div',{class:'bk-state'},statePill(job.state),job.enabled?null:el('small',{class:'bk-dim'},t('plán je vypnutý'))),el('div',{class:'bk-actions'},...actions)));
  parts.push(el('dl',{class:'bk-facts'},
   fact(t('Cíl'),el('span',{class:'bk-path'},targetText(job.target)),job.target?.hostKey?el('small',{class:'bk-dim bk-mono'},job.target.hostKey.fingerprint):null),
   fact(t('Zdroje'),...(job.sources.length?job.sources.map(s=>el('span',{class:'bk-path'},`${s.name}: `,sourceText(s))):['—'])),
   fact(t('Plán'),scheduleText(job.schedule),job.nextRunAt?el('small',{class:'bk-dim'},t('příště {when}',{when:when(job.nextRunAt)})):null),
   fact(t('Uchování'),retentionText(job.retention)),
   fact(t('Vynechat'),job.excludes.length?el('span',{class:'bk-mono'},job.excludes.join('  ')):'—'),
   fact(t('Na cíli'),tp(job.snapshots,'{n} snímek|{n} snímky|{n} snímků'),job.space?el('small',{class:'bk-dim'},t('volno {free} z {total}',{free:bytes(job.space.availableBytes),total:bytes(job.space.totalBytes)})):null)));
  parts.push(el('h2',{class:'bk-h2'},t('Běhy a snímky')));
  if(!d.runs.length)parts.push(emptyState({compact:true,icon:'archive',title:t('Zatím žádný běh'),body:job.missing.length?t('Nejdřív dokonči průvodce.'):t('První snímek vznikne podle plánu, nebo hned tlačítkem Spustit teď.')}));
  else parts.push(el('div',{class:'bk-table-wrap'},el('table',{class:'bk-table'},
   el('thead',{},el('tr',{},...[t('Začátek'),t('Trvání'),t('Výsledek'),t('Velikost'),t('Přeneseno'),t('Souborů přeneseno'),t('Snímek'),t('Záznam'),''].map(h=>el('th',{scope:'col'},h)))),
   el('tbody',{},d.runs.map(r=>el('tr',{},
    el('th',{scope:'row'},when(r.startedAt),el('small',{class:'bk-dim'},t(TRIGGER[r.trigger]||r.trigger||''),r.by?` · ${r.by}`:'')),
    el('td',{class:'bk-num'},duration(r.durationMs)),
    el('td',{},resultPill(r.result),r.error&&r.error!=='cancelled'?el('small',{class:'bk-err'},t(r.message||'')):null,...(r.warningMessages||[]).map(w=>el('small',{class:'bk-warn'},t(w)))),
    el('td',{class:'bk-num'},bytes(r.stats?.totalBytes)),
    el('td',{class:'bk-num'},bytes(r.stats?.transferredBytes)),
    el('td',{class:'bk-num'},num(r.stats?.filesTransferred)),
    el('td',{class:'bk-mono'},r.snapshot?[r.snapshot,el('small',{class:'bk-dim'},r.present?t('na cíli'):r.deletedAt?t('smazán'):t('odstraněn uchováním'))]:'—'),
    el('td',{},el('a',{href:`/api/backup-jobs/log?id=${id}&run=${r.id}`,target:'_blank',rel:'noopener'},t('záznam'))),
    el('td',{class:'bk-actions'},r.present&&canRun(me)?el('button',{type:'button',class:'ui-button small danger',onclick:e=>{
     if(!confirm(t('Smazat snímek {name} na cíli? Tohle nejde vrátit.',{name:r.snapshot})))return;
     act(e.currentTarget,()=>api('/api/backup-jobs/delete-snapshot',{id,snapshot:r.snapshot}),()=>{toast.good(t('Snímek je smazaný.'));refresh();});}},t('Smazat snímek')):null)))))));
  const orphans=d.snapshots.filter(s=>!s.run);
  if(orphans.length)parts.push(el('p',{class:'bk-note'},t('Další snímky na cíli bez záznamu běhu: {names}',{names:orphans.map(s=>s.name).join(', ')})));
  body.replaceChildren(...parts);
  again(Boolean(job.running));
 }
 load();
 return el('div',{class:'bk-page'},head,body);
}

export function backupsPage({me,sub}){
 css();
 if(sub==='new')return wizardView({me,id:null});
 if(sub?.startsWith('edit-'))return wizardView({me,id:sub.slice(5)});
 if(sub)return detailView(me,sub);
 return listView(me);
}
