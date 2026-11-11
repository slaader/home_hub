// The set-up wizard for one backup job (#backup-jobs/new, #backup-jobs/edit-<id>). Administrators only.
//   1 Cíl           host, port, user and destination directory on the target; the first save creates the job
//                   and its own ed25519 key on the hub
//   2 Přístup       the public key and the authorized_keys line, and what to do on the target
//   3 Spojení       trust on first use: the host key's fingerprint to compare and confirm, then the checks
//                   over SSH (login, directory, write access, rsync, free space)
//   4 Zdroje        what to back up: paths on this hub and/or on other SSH hosts (each host's key confirmed too)
//   5 Plán          daily / weekly / by hand at HH:MM in the site's time zone, retention, exclude patterns
//   6 Souhrn        review, enable, save; optionally run now
// Every step saves to the server (with the job's hash, so a change made elsewhere is never overwritten), so
// the wizard can be left and resumed. Text-safe DOM only.
import {el} from './views.js';
import {t} from './i18n.js';
import {zoneName} from './site.js';
import {pageHeader,errorState,loadingState,copyBlock,statusPill,toast,banner,segmented} from './ui.js';
import {api,bytes,scheduleText,retentionText,targetText,sourceText,missingText} from './backups-view.js';

const STEPS=[['target','Cíl'],['access','Přístup'],['connect','Spojení'],['sources','Zdroje'],['schedule','Plán'],['review','Souhrn']];
const CHECKS={ssh:'Přihlášení přes SSH',dir:'Adresář existuje',writable:'Do adresáře jde zapisovat',rsync:'rsync na stroji',space:'Volné místo',exists:'Cesta existuje',readable:'Jde číst',owner:'Adresář patří této úloze',protected:'Mimo klíče a stav záloh'};
const DAYS=['Po','Út','St','Čt','Pá','So','Ne'];

const field=(label,control,help)=>el('label',{class:'bk-field'},el('span',{},label),control,help?el('small',{},help):null);
const input=(name,value,attrs={})=>el('input',{name,value:value??'',autocomplete:'off',spellcheck:'false',...attrs});
const problem=()=>el('p',{class:'bk-problem',role:'alert'});
const datalist=(id,suggestions)=>el('datalist',{id},suggestions.map(s=>el('option',{value:s.host},`${s.name}${s.role?` · ${s.role}`:''}`)));

export function wizardView({me,id}){
 const page=el('div',{class:'bk-page bk-wizard'});
 if(me?.canAdmin!==true){page.append(pageHeader({back:{label:t('Zálohování'),href:'#backup-jobs'},title:t('Nová záloha')}),
  errorState({title:t('Jen pro administrátora'),body:t('Zálohy nastavuje administrátor přihlášený heslem: úloha rozhoduje, co se čte a kam se to posílá.')}));return page;}
 const s={detail:null,step:0,suggestions:[],timeZone:null,tests:{}};
 const job=()=>s.detail?.job||null;
 const save=async change=>{s.detail=await api('/api/backup-jobs/update',{id:job().id,base:job().hash,...change});return s.detail;};
 const go=i=>{s.step=Math.max(0,Math.min(STEPS.length-1,i));draw();};

 function stepper(){
  const reached=i=>i===0||Boolean(job())&&(i<=1||Boolean(job().target))&&(i<=3||Boolean(job().target?.hostKey))&&(i<=4||job().sources.length>0);
  return el('ol',{class:'bk-steps','aria-label':t('Kroky průvodce')},STEPS.map(([key,label],i)=>el('li',{class:i===s.step?'on':i<s.step?'done':''},
   el('button',{type:'button',class:'bk-step',...(i===s.step?{'aria-current':'step'}:{}),...(reached(i)?{}:{disabled:''}),onclick:()=>go(i)},el('b',{},String(i+1)),t(label)))));
 }
 const nav=(next,{back=true,nextLabel}={})=>el('div',{class:'bk-nav'},back&&s.step>0?el('button',{type:'button',class:'ui-button quiet',onclick:()=>go(s.step-1)},t('← Zpět')):el('span'),
  next?el('button',{type:'submit',class:'ui-button primary'},nextLabel||t('Uložit a pokračovat')):null);
 const busy=async(form,work)=>{const go=form.querySelector('[type="submit"]'),out=form.querySelector('.bk-problem');if(out)out.textContent='';if(go)go.disabled=true;
  try{await work();}catch(e){if(out)out.textContent=e.message;else toast.bad(e.message);}finally{if(go)go.disabled=false;}};

 // ---- 1: target ----
 function targetStep(){
  const j=job(),tg=j?.target,err=problem();
  const form=el('form',{class:'bk-form',onsubmit:e=>{e.preventDefault();busy(form,async()=>{
   const f=form.elements;
   if(!job())s.detail=await api('/api/backup-jobs/create',{name:f.name.value.trim()||t('Záloha')});
   await save({name:f.name.value.trim()||job().name,target:{host:f.host.value.trim(),port:f.port.value.trim(),user:f.user.value.trim(),path:f.path.value.trim()}});
   go(1);});}},
   el('p',{class:'bk-lead'},t('Cíl je stroj, na který se zálohy ukládají: NAS nebo jakýkoli stroj s SSH a rsync. Hub se k němu přihlásí vlastním klíčem jako uživatel, kterého tu zadáš.')),
   field(t('Název úlohy'),input('name',j?.name||'',{required:'',maxlength:'80',placeholder:t('např. Dokumenty na NAS')})),
   el('div',{class:'bk-row'},
    field(t('Cílový stroj'),input('host',tg?.host,{required:'',list:'bk-hosts',placeholder:'nas.example.lan'}),t('Jméno nebo IPv4 adresa. Stroje z konfigurace webu se nabízejí.')),
    field(t('Port SSH'),input('port',tg?.port??22,{inputmode:'numeric',pattern:'[0-9]{1,5}',class:'bk-short'}))),
   el('div',{class:'bk-row'},
    field(t('Uživatel na cíli'),input('user',tg?.user,{required:'',placeholder:'hubbackup'}),t('Nejlépe samostatný uživatel jen pro zálohy.')),
    field(t('Cílový adresář'),input('path',tg?.path,{required:'',placeholder:'/mnt/tank/backups/home-hub'}),t('Absolutní cesta bez mezer. Musí existovat a patřit tomu uživateli.'))),
   datalist('bk-hosts',s.suggestions),err,nav(true));
  return form;
 }
 // ---- 2: access ----
 function accessStep(){
  const d=s.detail,j=job(),ak=d.authorizedKeys;
  return el('form',{class:'bk-form',onsubmit:e=>{e.preventDefault();go(2);}},
   el('p',{class:'bk-lead'},t('Hub pro tuhle úlohu vytvořil vlastní klíč ed25519. Soukromá část zůstává na hubu a nikdy se neukáže; na cíl patří jen veřejná část.')),
   ak?copyBlock(t('Řádek do authorized_keys na cíli'),ak.line,{note:ak.address?t('restrict vypne přesměrování portů, agenta i terminál; from="{address}" klíč přijme jen z adresy hubu. Když hub připojuje z jiné adresy, from="…" uprav nebo vynech.',{address:ak.address}):t('restrict vypne přesměrování portů, agenta i terminál. Můžeš doplnit from="adresa hubu", aby klíč fungoval jen odtud.')}):banner({tone:'bad',title:t('Veřejný klíč chybí.')}),
   d.publicKey?copyBlock(t('Jen veřejný klíč'),d.publicKey):null,
   el('h3',{class:'bk-h3'},t('Co udělat na cílovém stroji ({host})',{host:j.target?.host||'—'})),
   el('ol',{class:'ui-steps'},
    el('li',{},t('Založ uživatele {user} se skutečným shellem (sh, bash nebo zsh, ne nologin). Na TrueNAS: Credentials → Users.',{user:j.target?.user||'—'})),
    el('li',{},t('Založ cílový adresář {path} a dej ho tomu uživateli (vlastník a právo zápisu).',{path:j.target?.path||'—'})),
    el('li',{},t('Vlož řádek výše do ~{user}/.ssh/authorized_keys (adresář .ssh s právy 700, soubor 600). Na TrueNAS jde vložit do pole Authorized Keys u uživatele.',{user:j.target?.user||''})),
    el('li',{},t('Zapni službu SSH a ověř, že je na stroji rsync (TrueNAS i běžné Linuxy ho mají).')),
    el('li',{},t('Na stroji si zobraz otisk jeho klíče, budeš ho v dalším kroku porovnávat:'),el('code',{class:'bk-code'},'ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub'))),
   el('p',{class:'bk-note'},t('Hub potřebuje na cíli spustit mkdir, mv, rm, ln a df (přejmenování snímku a mazání starých), proto omezení příkazem rrsync tady nepoužívá. Bezpečnost dává samostatný uživatel, který smí jen do svého adresáře.')),
   el('p',{class:'bk-note'},t('Přihlašovací shell toho uživatele musí rozumět příkazům ve stylu sh (sh, bash, zsh, dash, ksh); csh a tcsh nejsou podporované.')),
   nav(true,{nextLabel:t('Hotovo, pokračovat')}));
 }
 // ---- the host-key and connection check of one part (target or an SSH source) ----
 function hostCheck(part,index=0,{onOk}={}){
  const key=`${part}:${index}`,box=el('div',{class:'bk-check','aria-live':'polite'});
  const show=r=>{
   s.tests[key]=r;const out=[];
   if(r.state==='trust'){
    out.push(banner({tone:'warn',title:t('Potvrď klíč hostitele.'),body:t('Hub se k tomuto stroji ještě nepřipojil. Porovnej otisk s tím, co ukazuje stroj sám (ssh-keygen -lf na jeho veřejný klíč). Shoduje se? Potvrď ho; od té doby hub jiný klíč odmítne.')}));
    out.push(el('ul',{class:'bk-keys'},r.hostKeys.map(k=>el('li',{},el('span',{class:'bk-mono'},k.type),el('code',{class:'bk-fp'},k.fingerprint),
     el('button',{type:'button',class:'ui-button small primary',onclick:async e=>{e.currentTarget.disabled=true;
      try{s.detail=await api('/api/backup-jobs/trust',{id:job().id,part,index,fingerprint:k.fingerprint});toast.good(t('Klíč hostitele je připnutý.'));await run();}
      catch(err){toast.bad(err.message);e.currentTarget.disabled=false;}}},t('Otisk souhlasí, potvrdit'))))));
   }else if(r.state==='changed'){
    out.push(banner({tone:'bad',title:t('Klíč hostitele se změnil!'),body:t(r.message||'')}));
    out.push(el('p',{class:'bk-note'},t('Potvrzený: {fp}',{fp:r.pinned?.fingerprint||'—'})),el('ul',{class:'bk-keys'},r.hostKeys.map(k=>el('li',{},el('span',{class:'bk-mono'},k.type),el('code',{class:'bk-fp'},k.fingerprint)))));
    out.push(el('p',{class:'bk-note'},t('Když jde o přeinstalovaný stroj a nový otisk jsi ověřil, změň v kroku Cíl port nebo jméno a vrať je zpět: tím se starý klíč zapomene.')));
   }else{
    out.push(el('ul',{class:'bk-checks'},r.checks.map(c=>el('li',{class:c.ok?'ok':'bad'},statusPill(c.ok?t('ano'):t('ne'),c.ok?'good':'bad'),t(CHECKS[c.id]||c.id),
     c.value?el('span',{class:'bk-dim'},t('{free} volných z {total}',{free:bytes(c.value.availableBytes),total:bytes(c.value.totalBytes)})):null))));
    if(r.error)out.push(banner({tone:'bad',title:t('Spojení zatím nefunguje.'),body:t(r.message||'')}));
    else{out.push(banner({tone:'good',title:t('Spojení funguje.'),body:r.snapshots?t('Na cíli už je {n} snímků této úlohy.',{n:r.snapshots}):null}));onOk?.();}
   }
   box.replaceChildren(...out);
  };
  async function run(){
   box.replaceChildren(loadingState(t('Zkouším spojení…')));
   try{show((await api('/api/backup-jobs/test',{id:job().id,part,index})).result);}
   catch(e){box.replaceChildren(banner({tone:'bad',title:t('Test se nepovedl.'),body:e.message}));}
  }
  const button=el('button',{type:'button',class:'ui-button',onclick:run},t('Vyzkoušet spojení'));
  if(s.tests[key])show(s.tests[key]);
  return el('div',{class:'bk-check-wrap'},button,box);
 }
 // ---- 3: connect ----
 function connectStep(){
  const j=job();
  return el('form',{class:'bk-form',onsubmit:e=>{e.preventDefault();if(!job().target?.hostKey)return toast.bad(t('Nejdřív potvrď klíč hostitele.'));go(3);}},
   el('p',{class:'bk-lead'},t('Hub přečte klíč hostitele {target}. Po jeho potvrzení se přihlásí a ověří adresář, zápis, rsync a volné místo.',{target:targetText(j.target)})),
   j.target?.hostKey?el('p',{class:'bk-note'},t('Připnutý klíč: {type} {fp}',{type:j.target.hostKey.type,fp:j.target.hostKey.fingerprint})):null,
   hostCheck('target'),nav(true,{nextLabel:t('Pokračovat')}));
 }
 // ---- 4: sources ----
 function sourceRow(src={kind:'local'},rows){
  const row=el('fieldset',{class:'bk-source'});
  const draw=kind=>{
   const v=row.values||src;
   row.replaceChildren(...[el('legend',{},t('Zdroj')),
    segmented({label:t('Odkud'),value:kind,name:'kind',options:[{id:'local',label:t('Tento hub')},{id:'ssh',label:t('Jiný stroj (SSH)')}],onchange:k=>{row.values=collect();draw(k);}}),
    kind==='ssh'?el('div',{class:'bk-row'},field(t('Stroj'),input('host',v.host,{required:'',list:'bk-hosts',placeholder:'mini.example.lan'})),field(t('Port SSH'),input('port',v.port??22,{inputmode:'numeric',class:'bk-short'})),field(t('Uživatel'),input('user',v.user,{required:'',placeholder:'alice'}))):null,
    el('div',{class:'bk-row'},field(t('Cesta'),input('path',v.path,{required:'',placeholder:kind==='ssh'?'/Users/alice/Projects':'~/Documents'}),kind==='ssh'?t('Absolutní cesta k adresáři, bez mezer.'):t('Absolutní cesta, nebo začíná ~/ (domov uživatele, pod kterým hub běží).')),
     field(t('Složka ve snímku'),input('name',v.name,{pattern:'[a-z0-9][a-z0-9._\\-]{0,39}',placeholder:t('podle cesty')}))),
    el('button',{type:'button',class:'ui-button small quiet bk-remove',onclick:()=>{row.remove();rows.changed?.();}},t('Odebrat zdroj'))].filter(Boolean));
   row.dataset.kind=kind;
  };
  const collect=()=>{const get=n=>row.querySelector(`[name="${n}"]`)?.value.trim()??'';const kind=row.dataset.kind;
   return kind==='ssh'?{kind,host:get('host'),port:get('port'),user:get('user'),path:get('path'),...(get('name')?{name:get('name')}:{})}:{kind,path:get('path'),...(get('name')?{name:get('name')}:{})};};
  row.collect=collect;draw(src.kind||'local');return row;
 }
 function sourcesStep(){
  const j=job(),rows=el('div',{class:'bk-sources'}),err=problem();
  for(const src of j.sources)rows.append(sourceRow(src,rows));
  if(!j.sources.length)rows.append(sourceRow({kind:'local'},rows));
  const checks=el('div',{class:'bk-source-checks'},j.sources.map((src,i)=>el('div',{class:'bk-source-check'},el('h3',{class:'bk-h3'},`${src.name}: `,sourceText(src)),hostCheck('source',i))));
  const saveSources=()=>save({sources:[...rows.querySelectorAll('.bk-source')].map(r=>r.collect())});
  const form=el('form',{class:'bk-form',onsubmit:e=>{e.preventDefault();busy(form,async()=>{
   await saveSources();
   const pending=job().sources.filter(x=>x.kind==='ssh'&&!x.hostKey);
   if(pending.length){toast(t('Uloženo. U zdrojů na jiných strojích ještě potvrď jejich klíč.'));draw();return;}
   go(4);});}},
   el('p',{class:'bk-lead'},t('Co zálohovat: adresáře na tomhle hubu a/nebo na jiných strojích. Každý zdroj má ve snímku svou složku. Zdroj na jiném stroji hub nejdřív zrcadlí k sobě (do pracovní kopie), pak ho pošle na cíl; na tom stroji musí být stejný veřejný klíč úlohy.')),
   el('p',{class:'bk-note'},t('Klíče záloh, adresář private/ hubu a stav záloh (včetně pracovních kopií) se ze zdroje na tomhle hubu vždy vynechají; zdroj uvnitř klíčů nebo stavu záloh hub odmítne.')),
   el('p',{class:'bk-note'},t('Na zdroji na jiném stroji dává klíč úlohy shell, stejně jako na cíli. Kdo chce víc omezení, může před klíč v authorized_keys toho stroje dát command="rrsync -ro <cesta>": zálohy poběží, jen test spojení v průvodci ohlásí chybějící shell.')),
   rows,el('button',{type:'button',class:'ui-button small',onclick:()=>rows.append(sourceRow({kind:'local'},rows))},t('+ Přidat zdroj')),
   datalist('bk-hosts',s.suggestions),
   j.sources.length?el('div',{},el('h3',{class:'bk-h3'},t('Ověření zdrojů')),el('p',{class:'bk-note'},t('Ověřuje uložené zdroje. Po změně je nejdřív ulož.')),checks):null,
   err,nav(true));
  return form;
 }
 // ---- 5: schedule, retention, excludes ----
 function scheduleStep(){
  const j=job();let mode=j.schedule.mode;
  const days=el('div',{class:'bk-days',role:'group','aria-label':t('Dny v týdnu')},DAYS.map((d,i)=>el('label',{class:'bk-day'},el('input',{type:'checkbox',name:'day',value:String(i+1),...(j.schedule.days.includes(i+1)?{checked:''}:{})}),t(d))));
  const time=field(t('Čas'),input('time',j.schedule.time,{type:'time',required:''}),t('V časovém pásmu {zone}.',{zone:s.timeZone||zoneName()}));
  const sync=()=>{days.hidden=mode!=='weekly';time.hidden=mode==='manual';};
  const err=problem();
  const form=el('form',{class:'bk-form',onsubmit:e=>{e.preventDefault();busy(form,async()=>{const f=form.elements;
   await save({schedule:{mode,time:f.time.value,days:[...form.querySelectorAll('[name="day"]:checked')].map(x=>Number(x.value))},
    retention:{keepLast:f.keepLast.value,keepDays:f.keepDays.value},excludes:f.excludes.value.split('\n').map(x=>x.trim()).filter(Boolean),timeoutMinutes:Number(f.timeout.value)});go(5);});}},
   el('p',{class:'bk-lead'},t('Kdy se záloha spouští. Když hub v plánovaný čas neběží, po startu zálohu jednou dožene (jednou, i když zmeškal víc termínů).')),
   segmented({label:t('Plán'),value:mode,name:'mode',options:[{id:'daily',label:t('Denně')},{id:'weekly',label:t('Vybrané dny')},{id:'manual',label:t('Jen ručně')}],onchange:m=>{mode=m;sync();}}),
   el('div',{class:'bk-row'},time),days,
   el('h3',{class:'bk-h3'},t('Uchování snímků')),
   el('div',{class:'bk-row'},field(t('Ponechat posledních'),input('keepLast',j.retention.keepLast,{type:'number',min:'0',max:'1000',class:'bk-short'}),t('snímků (0 = podle stáří)')),
    field(t('Ponechat mladší než'),input('keepDays',j.retention.keepDays,{type:'number',min:'0',max:'3650',class:'bk-short'}),t('dní (0 = podle počtu)'))),
   el('p',{class:'bk-note'},t('Snímek zůstane, když ho drží aspoň jedno pravidlo. Nejnovější se nesmaže nikdy. Mazání proběhne jen po úspěšném běhu.')),
   field(t('Vynechat (vzory rsync, jeden na řádek)'),el('textarea',{name:'excludes',rows:'4',spellcheck:'false'},j.excludes.join('\n')),t('Např. *.tmp, node_modules/, .cache/. Klíč úlohy se vynechá vždy.')),
   field(t('Nejdelší běh (minuty)'),input('timeout',j.timeoutMinutes,{type:'number',min:'5',max:'2880',class:'bk-short'}),t('Pak se běh ukončí jako chyba.')),
   err,nav(true));
  sync();return form;
 }
 // ---- 6: review ----
 function reviewStep(){
  const j=job(),err=problem();
  const finish=async(form,runNow)=>busy(form,async()=>{
   await save({enabled:form.elements.enabled.checked});
   if(runNow)await api('/api/backup-jobs/run',{id:j.id});
   toast.good(runNow?t('Uloženo, záloha běží.'):t('Uloženo.'));location.hash=`#backup-jobs/${j.id}`;});
  const form=el('form',{class:'bk-form',onsubmit:e=>{e.preventDefault();finish(form,false);}},
   el('dl',{class:'bk-facts'},
    el('div',{class:'bk-fact'},el('dt',{},t('Cíl')),el('dd',{},el('span',{class:'bk-path'},targetText(j.target)),j.target?.hostKey?el('small',{class:'bk-dim bk-mono'},j.target.hostKey.fingerprint):null)),
    el('div',{class:'bk-fact'},el('dt',{},t('Zdroje')),el('dd',{},...j.sources.map(x=>el('span',{class:'bk-path'},`${x.name}: `,sourceText(x))))),
    el('div',{class:'bk-fact'},el('dt',{},t('Plán')),el('dd',{},scheduleText(j.schedule))),
    el('div',{class:'bk-fact'},el('dt',{},t('Uchování')),el('dd',{},retentionText(j.retention))),
    el('div',{class:'bk-fact'},el('dt',{},t('Vynechat')),el('dd',{class:'bk-mono'},j.excludes.join('  ')||'—'))),
   el('p',{class:'bk-note'},t('Snímky vzniknou na cíli jako {path}/<čas začátku>/<složka zdroje>/…; nejnovější ukazuje odkaz {path}/latest.',{path:j.target?.path||'…'})),
   j.missing.length?banner({tone:'warn',title:t('Úloha ještě není hotová.'),body:t('Chybí: {what}.',{what:missingText(j.missing)})}):null,
   el('label',{class:'bk-toggle'},el('input',{type:'checkbox',name:'enabled',...(j.enabled||!j.missing.length?{checked:''}:{}),...(j.missing.length?{disabled:''}:{})}),t('Spouštět podle plánu')),
   err,
   el('div',{class:'bk-nav'},el('button',{type:'button',class:'ui-button quiet',onclick:()=>go(4)},t('← Zpět')),
    el('div',{class:'bk-actions'},el('button',{type:'submit',class:'ui-button'},t('Uložit')),
     j.missing.length?null:el('button',{type:'button',class:'ui-button primary',onclick:()=>finish(form,true)},t('Uložit a spustit teď')))));
  return form;
 }

 const body=el('div',{class:'bk-body'});
 function draw(){
  const [key,label]=STEPS[s.step];
  const view={target:targetStep,access:accessStep,connect:connectStep,sources:sourcesStep,schedule:scheduleStep,review:reviewStep}[key];
  body.replaceChildren(stepper(),el('section',{class:'bk-panel','aria-label':t(label)},el('h2',{class:'bk-h2'},`${s.step+1}. ${t(label)}`),view()));
 }
 async function start(){
  body.replaceChildren(loadingState(t('Načítám…')));
  try{
   const list=await api('/api/backup-jobs');s.suggestions=list.suggestions||[];s.timeZone=list.timeZone;
   if(id){s.detail=await api(`/api/backup-jobs/detail?id=${encodeURIComponent(id)}`);const j=job();
    // Resume where it stands: the first step that is not done yet.
    s.step=!j.target?0:!j.target.hostKey?2:!j.sources.length||j.missing.length?3:5;}
   draw();
  }catch(e){body.replaceChildren(errorState({title:t('Průvodce se nepodařilo otevřít'),body:e.message,retry:start}));}
 }
 start();
 page.append(pageHeader({back:{label:t('Zálohování'),href:id?`#backup-jobs/${id}`:'#backup-jobs'},eyebrow:t('Zálohování'),title:id?t('Upravit zálohu'):t('Nová záloha'),
  lead:t('Šest kroků: kam, přístup, ověření spojení, co, kdy a souhrn. Každý krok se ukládá, průvodce jde kdykoli opustit a vrátit se.')}),body);
 return page;
}
