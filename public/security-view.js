// Bezpečnost → SSH klíče. Read-only view of data/security/ssh-keys.json (scripts/collect-security.mjs):
// a matrix of every private key (type, age, passphrase) against where it is authorized, with weak and
// old keys highlighted; then where each key lives, who owns it, what it opens, and who can get into
// each account. The page says where the collector stands: not configured, configured without a snapshot,
// a stale snapshot, or fine.
import {el} from './views.js';
import {authGuard} from './session-cache.js';
import {t,tp,locale} from './i18n.js';
import {timeZone} from './site.js';
import {pageHeader,emptyState,notInstalled} from './ui.js';
import {badge,say,freshnessBanner,fill} from './systems-view.js';

let tab='matrix';
const day=iso=>iso&&Number.isFinite(Date.parse(iso))?new Intl.DateTimeFormat(locale(),{day:'numeric',month:'numeric',year:'numeric',timeZone:timeZone()}).format(new Date(iso)):'—';
const stat=(k,v,sub,tone='')=>el('div',{class:`col-stat ${tone}`},el('div',{class:'k'},k),el('div',{class:'v'},String(v)),el('div',{class:'s',title:sub},sub));
const cell=(label,...children)=>el('td',{'data-label':label},...children);

// --- key health: type strength and age (pure; tests/collectors.test.mjs) -----------------------------
// A key file older than this is worth rotating. The age comes from the file's modification time.
export const OLD_KEY_DAYS=730;
// The same rule the collector applies (server/security-data.mjs → keyStrength).
export function keyStrength(type,bits){
 const kind=String(type||'').toUpperCase().replace(/-SK$/,''),n=Number(bits)||0;
 if(!kind)return null;
 if(kind==='DSA'||kind==='DSS')return 'weak';
 if(kind==='RSA')return n<2048?'weak':n<3072?'legacy':'ok';
 if(kind==='ECDSA')return n&&n<256?'weak':'ok';
 return 'ok';
}
/** → {strength, ageDays, old, level}; level: 'bad' (weak type), 'warn' (legacy type or old file) or ''. */
export function keyHealth(key,now=Date.now()){
 const copies=key.copies||[],primary=copies.filter(c=>!c.backup);
 const times=(primary.length?primary:copies).map(c=>Date.parse(c.mtime)).filter(Number.isFinite);
 const ageDays=times.length?Math.max(0,Math.floor((now-Math.min(...times))/86400000)):null;
 const strength=keyStrength(key.type,key.bits),old=ageDays!==null&&ageDays>OLD_KEY_DAYS;
 return {strength,ageDays,old,level:strength==='weak'?'bad':strength==='legacy'||old?'warn':''};
}
const ageText=days=>days===null?'—':days<60?t('{n} d',{n:days}):days<730?t('{n} měs.',{n:Math.round(days/30.44)}):t('{n} r.',{n:(days/365.25).toFixed(1)});
const strengthBadge=h=>h.strength==='weak'?badge(t('slabý typ'),'bad solid',t('DSA a krátké RSA nebo ECDSA klíče už nejsou bezpečné. Nahraď ho klíčem ed25519.'))
 :h.strength==='legacy'?badge(t('starší typ'),'warn',t('RSA pod 3072 bitů se pro nové klíče nedoporučuje.')):null;
const ageBadge=h=>h.old?badge(t('starý'),'warn',t('Soubor klíče je starší než dva roky. Zvaž výměnu.')):null;

// Labels stay Czech here and go through t() where they are displayed. [label, tone, explanation]
const SUDO={root:['root','bad','Účet root.'],nopasswd:['sudo bez hesla','bad','Může spustit cokoli jako root bez zadání hesla.'],
 limited:['sudo bez hesla jen pro vybrané příkazy','warn',''],password:['sudo s heslem','good','sudo funguje, ale chce heslo.'],
 none:['bez sudo','good','Účet nemá sudo.'],unknown:['sudo neověřeno','','Probe neměl práva sudo -l ověřit.'],
 'forgejo-admin':['Forgejo admin','bad','Plný přístup ke všem repozitářům a nastavení Forgejo.'],'forgejo-user':['Forgejo účet','warn','Repozitáře, ke kterým má účet přístup.'],
 'repo-write':['zápis do repozitáře','warn',''],'repo-read':['čtení repozitáře','good','']};
function sudoBadge(verdict){
 const level=typeof verdict==='string'?verdict:verdict?.level||'unknown';
 const [text,tone,title]=SUDO[level]||[level,'',''];
 const cmds=typeof verdict==='object'&&verdict?.commands?.length?`\n${verdict.commands.join('\n')}`:'';
 return badge(t(text),tone,(title?t(title):'')+cmds);
}
const ROOTISH=['nopasswd','root','forgejo-admin'];

function model(doc){
 const machines=new Map(doc.machines.map(m=>[m.id,m]));
 const ipName=new Map();for(const m of doc.machines)for(const ip of m.ips||[])ipName.set(ip,m.name);
 const account=(machine,user)=>machines.get(machine)?.accounts?.find(a=>a.user===user)||null;
 const tilde=(machine,owner,file)=>{const home=account(machine,owner)?.home;return home&&file.startsWith(home+'/')?'~'+file.slice(home.length):file;};
 // sshd AllowUsers user@ip entries for one account (addresses that account may log in from).
 const allowFrom=(machine,user)=>[...new Set((machines.get(machine)?.ssh?.allowUsers||[]).map(x=>x.split('@')).filter(([u,ip])=>u===user&&ip).map(([,ip])=>ip))];
 return {machines,ipName,account,tilde,allowFrom,mName:id=>machines.get(id)?.name||id,mIp:id=>(machines.get(id)?.ips||[]).join(', ')};
}
const fromText=(from,m)=>from.map(ip=>m.ipName.has(ip)?`${m.ipName.get(ip)} (${ip})`:ip).join(', ');

// One "what it opens" line: target · IP · account · sudo there · restrictions.
function accessLine(a,m){
 const tg=a.target,bits=[];
 if(tg.kind==='host'){
  bits.push(el('b',{},m.mName(tg.machine)),el('span',{class:'col-dim'},m.mIp(tg.machine)),el('span',{class:'col-user'},tg.user));
  bits.push(a.restricted?badge(t('jen příkaz'),'good',a.command||''):sudoBadge(a.sudo));
  // restrict / permitopen limit forwarding only; commands still run, so they never read as "ok".
  if(!a.restricted&&a.noForwarding)bits.push(badge(t('bez přesměrování (restrict)'),'',t('restrict vypíná přesměrování portů, agenta, X11 a PTY, ale libovolné příkazy dál povoluje.')));
  if(!a.restricted&&a.permitOpen?.length)bits.push(badge(t('tunel jen {targets}',{targets:a.permitOpen.join(', ')}),'',t('permitopen omezuje cíle tunelu, příkazy ne.')));
 }else if(tg.kind==='forgejo'){bits.push(el('b',{},'Forgejo'),el('span',{class:'col-user'},tg.account),sudoBadge(a.sudo));}
 else if(tg.kind==='forgejo-deploy'){bits.push(el('b',{},'Forgejo'),el('span',{class:'col-dim'},tg.repo),badge(tg.readOnly?t('deploy klíč · čtení'):t('deploy klíč · zápis'),tg.readOnly?'good':'warn'));}
 else bits.push(el('b',{},t(tg.label)),tg.user?el('span',{class:'col-user'},tg.user):null,badge(t('neověřeno'),'',t('Vychází jen z ~/.ssh/config, cíl jsem neprověřil.')));
 const allow=tg.kind==='host'?m.allowFrom(tg.machine,tg.user):[];
 if(a.from?.length)bits.push(badge(t('jen z {from}',{from:fromText(a.from,m)}),'good','authorized_keys from='));
 else if(allow.length)bits.push(badge(t('AllowUsers: jen z {from}',{from:fromText(allow,m)}),'good',t('authorized_keys nemá from=, adresy omezuje sshd AllowUsers.')));
 else if(tg.kind==='host'&&!a.restricted)bits.push(badge(t('z libovolné adresy'),'warn',t('Bez from= v authorized_keys a bez AllowUsers v sshd.')));
 return el('div',{},...bits);
}
const encBadge=k=>k.copies.every(c=>c.encrypted===true)?badge(t('chráněný heslem'),'good'):k.copies.some(c=>c.encrypted===false)?badge(t('bez hesla'),'warn',t('Soubor klíče se otevře bez passphrase.')):badge('?','',t('Sonda nepoznala, jestli má klíč passphrase.'));
const typeText=k=>[k.type,k.bits].filter(Boolean).join(' ')||'—';

// --- the matrix: key → type, age, passphrase, and every place it is authorized -------------------------
function matrix(doc,m,now){
 const hits=(k,col)=>k.access.filter(a=>col==='git'?a.target.kind.startsWith('forgejo'):col==='other'?['external','local'].includes(a.target.kind):a.target.kind==='host'&&a.target.machine===col);
 const targets=[...doc.machines.filter(x=>x.sshOpen===undefined).map(x=>[x.id,x.name||x.id]),
  ...(doc.forgejo||doc.keys.some(k=>hits(k,'git').length)?[['git',t('Git server')]]:[]),...(doc.keys.some(k=>hits(k,'other').length)?[['other',t('Jinde')]]:[])];
 const where=(k,col)=>{
  const found=hits(k,col);
  if(!found.length)return el('td',{class:'none'},'·');
  return el('td',{},...found.map(a=>{
   const tg=a.target,root=ROOTISH.includes(a.sudo);
   const tone=a.restricted?'good':root?'bad solid':a.unverified?'':'info';
   const text=tg.kind==='host'?tg.user:tg.kind==='forgejo'?tg.account:tg.kind==='forgejo-deploy'?tg.repo.split('/').pop():t(tg.label);
   const why=tg.kind==='host'?`${tg.user}@${m.mName(tg.machine)} · ${t((SUDO[a.sudo]||[a.sudo])[0])}${a.restricted?' · '+t('omezený příkaz'):''}${a.from?.length?' · '+t('jen z {from}',{from:fromText(a.from,m)}):''}`:t((SUDO[a.sudo]||[tg.label])[0]);
   return badge(`${text}${a.restricted?' ⌁':root?' #':''}`,tone,why);
  }));
 };
 const groups=new Map();for(const k of doc.keys){const home=(k.copies.find(c=>!c.backup)||k.copies[0])?.machine||'?';if(!groups.has(home))groups.set(home,[]);groups.get(home).push(k);}
 const body=[];
 for(const [home,list] of groups){
  body.push(el('tr',{class:'col-group'},el('th',{colspan:String(targets.length+4),scope:'colgroup'},t('Leží na {machine} · {ip}',{machine:m.mName(home),ip:m.mIp(home)||'—'}))));
  for(const k of list){const h=keyHealth(k,now);
   body.push(el('tr',{class:h.level==='bad'?'bad':h.level==='warn'?'attn':''},
    el('th',{scope:'row'},el('div',{class:'col-name col-mono'},k.name),el('div',{class:'col-dim'},[...new Set(k.copies.map(c=>c.owner))].join(', '))),
    el('td',{},el('span',{class:'col-mono'},typeText(k)),' ',strengthBadge(h)),
    el('td',{title:t('Podle data změny souboru klíče.')},ageText(h.ageDays),' ',ageBadge(h)),
    el('td',{},encBadge(k)),
    ...targets.map(([id])=>where(k,id))));}
 }
 return el('div',{class:'col-watch'},
  el('p',{class:'col-legend'},el('span',{},badge('# root','bad solid'),' ',t('účet se sudo bez hesla nebo Forgejo admin')),el('span',{},badge('⌁ '+t('omezeno'),'good'),' ',t('jen příkaz nebo tunel')),
   el('span',{},badge(t('účet'),'info'),' ',t('běžný přístup')),el('span',{},badge(t('neověřeno')),' ',t('jen podle ~/.ssh/config')),el('span',{},badge(t('slabý typ'),'bad solid'),' ',badge(t('starý'),'warn'),' ',t('klíč k výměně'))),
  el('section',{class:'col-card'},el('div',{class:'col-scroll',tabindex:'0',role:'region','aria-label':t('Matice klíčů')},el('table',{class:'col-matrix'},
   el('thead',{},el('tr',{},el('th',{scope:'col'},t('Klíč')),el('th',{scope:'col'},t('Typ')),el('th',{scope:'col'},t('Stáří')),el('th',{scope:'col'},'Passphrase'),
    ...targets.map(([id,label])=>el('th',{scope:'col'},label,id!=='git'&&id!=='other'&&m.mIp(id)?el('div',{class:'col-dim'},m.mIp(id)):null)))),
   el('tbody',{},body)))));
}

// --- the inventory: where each key lives and what it opens ----------------------------------------------
function keysTable(doc,m,now){
 const rows=doc.keys.map(k=>{
  const owners=[...new Map(k.copies.map(c=>[`${c.machine}/${c.owner}`,c])).values()],h=keyHealth(k,now);
  return el('tr',{class:h.level==='bad'?'bad':h.level==='warn'?'attn':''},
   cell(t('Klíč'),el('div',{class:'col-name col-mono'},k.name),k.comment&&k.comment!==k.name?el('div',{class:'col-dim'},k.comment):null,
    el('div',{class:'col-dim col-mono',title:k.fingerprint},`${typeText(k)} · ${k.fingerprint.slice(7,19)}… · ${ageText(h.ageDays)}`),encBadge(k),strengthBadge(h),ageBadge(h)),
   cell(t('Kde leží'),el('div',{class:'col-lines'},k.copies.map(c=>el('div',{},el('b',{},m.mName(c.machine)),c.backup?badge(t('záloha'),'warn'):null,
    el('span',{class:'col-dim col-path',title:c.path},m.tilde(c.machine,c.owner,c.path)),el('span',{class:'col-dim'},`${c.owner} · ${c.mode} · ${day(c.mtime)}`))))),
   cell(t('Vlastník · sudo na tom stroji'),el('div',{class:'col-lines'},owners.map(c=>el('div',{},el('span',{class:'col-user'},c.owner),t('na'),m.mName(c.machine),sudoBadge(m.account(c.machine,c.owner)?.sudo))))),
   cell(t('Co odemyká (stroj · IP · účet · sudo tam)'),k.access.length?el('div',{class:'col-lines'},k.access.map(a=>accessLine(a,m))):el('span',{class:'col-dim'},t('Nikam nevede – nenašel jsem ho v žádném authorized_keys ani ve Forgejo.'))),
   cell(t('Použití v ~/.ssh/config'),k.routes.length?el('div',{class:'col-lines'},k.routes.map(r=>el('div',{title:`${r.hostname}:${r.port}${r.proxyJump?' '+t('přes {jump}',{jump:r.proxyJump}):''}`},
     el('code',{class:'col-mono'},`ssh ${r.alias}`),r.accepted===false?badge(t('cíl ho nepřijímá'),'warn'):r.alsoGit?badge(t('i git'),'',t('Stejný Host blok vybírá klíč i pro git na Forgejo (:2222).')):null))):el('span',{class:'col-dim'},'—')));
 });
 return el('section',{class:'col-card'},el('div',{class:'col-scroll'},el('table',{class:'col-table'},
  el('thead',{},el('tr',{},...[t('Klíč'),t('Kde leží'),t('Vlastník · sudo na tom stroji'),t('Co odemyká (stroj · IP · účet · sudo tam)'),t('Použití v ~/.ssh/config')].map(h=>el('th',{scope:'col'},h)))),
  el('tbody',{},rows))));
}

function accounts(doc,m){
 return el('div',{class:'col-cards'},doc.machines.map(mm=>{
  const head=el('header',{},el('h3',{},mm.name),el('span',{class:'meta'},(mm.ips||[]).join(' · ')||'—'));
  if(!mm.reachable)return el('section',{class:'col-card'},head,el('p',{class:'col-empty'},mm.note||mm.error?t(mm.note||mm.error):t('Nedostupné.')));
  const s=mm.ssh||{};
  const facts=el('div',{class:'col-sub col-os'},
   badge(s.listening?t('SSH zapnuté'):t('SSH vypnuté'),s.listening?'':'good'),
   s.passwordAuth==null?null:badge(s.passwordAuth?t('přihlášení heslem povoleno'):t('jen klíče'),s.passwordAuth?'warn':'good'),
   s.rootLogin?badge(`root: ${s.rootLogin}`,s.rootLogin==='no'?'good':'','PermitRootLogin'):null,
   s.allowUsers?.length?badge(`AllowUsers: ${[...new Set(s.allowUsers.map(x=>x.replace(/^(.*)@(.*)$/,(_,u,ip)=>`${u}@${m.ipName.get(ip)||ip}`)))].join(', ')}`,'good',s.allowUsers.join('\n')):null,
   s.accessGroup?.length&&s.accessGroup[0]!=='*'?badge(`Remote Login: ${s.accessGroup.join(', ')}`,'','com.apple.access_ssh'):null);
  const rows=mm.accounts.map(a=>el('tr',{},
   cell(t('Účet'),el('span',{class:'col-user'},a.user),el('div',{class:'col-dim'},`uid ${a.uid} · ${a.home||'—'}`)),
   cell('sudo',sudoBadge(a.sudo),a.sudo.expired?.length?el('div',{class:'col-dim',title:a.sudo.expired.join('\n')},tp(a.sudo.expired.length,'+ {n} prošlé pravidlo|+ {n} prošlá pravidla|+ {n} prošlých pravidel')):null),
   cell(t('Kdo se sem dostane (authorized_keys)'),a.authorizedKeys.length?el('div',{class:'col-lines'},a.authorizedKeys.map(e=>{
    const src=doc.keys.find(k=>k.fingerprint===e.fingerprint);
    const origin=src?[...new Set(src.copies.map(c=>m.mName(c.machine)))].join(', '):null;
    return el('div',{},el('b',{},src?src.name:(e.comment||e.fingerprint).slice(0,40)),
     origin?el('span',{class:'col-dim'},t('z {origin}',{origin})):badge(t('cizí – privátní část nenalezena'),'warn',e.fingerprint),
     e.from.length?badge(t('jen z {from}',{from:fromText(e.from,m)}),'good'):null,e.restricted?badge(t('jen příkaz'),'good',e.command||''):e.noForwarding?badge(t('bez přesměrování'),'',t('restrict: příkazy povolené, přesměrování ne.')):null);
   })):el('span',{class:'col-dim'},t('žádné povolené klíče')))));
  return el('section',{class:'col-card'},head,facts,rows.length?el('div',{class:'col-scroll'},el('table',{class:'col-table'},
   el('thead',{},el('tr',{},el('th',{scope:'col'},t('Účet')),el('th',{scope:'col'},'sudo'),el('th',{scope:'col'},t('Kdo se sem dostane (authorized_keys)')))),el('tbody',{},rows))):el('p',{class:'col-empty'},t('Žádné účty s přihlášením.')));
 }));
}

function otherKeys(doc,m){
 if(!doc.otherKeys.length)return el('p',{class:'col-empty'},t('Žádné jiné privátní klíče sonda nenašla.'));
 const rows=doc.otherKeys.map(o=>el('tr',{},cell(t('Účel'),t(o.label),o.backup?badge(t('záloha'),'warn'):null),cell(t('Stroj'),el('b',{},m.mName(o.machine)),' ',el('span',{class:'col-dim'},m.mIp(o.machine))),
  cell(t('Cesta'),el('span',{class:'col-dim col-path',title:o.path},m.tilde(o.machine,o.owner,o.path))),cell(t('Vlastník · práva'),`${o.owner} · ${o.mode}`),cell(t('Typ'),el('span',{class:'col-dim'},[o.type,o.bits].filter(Boolean).join(' ')||'—'))));
 return el('div',{class:'col-watch'},el('p',{class:'col-lead'},t('Privátní klíče, které nejsou klientské SSH klíče: HTTPS certifikáty, klíče SSH serverů, podpisové klíče a identita aplikací.')),
  el('section',{class:'col-card'},el('div',{class:'col-scroll'},el('table',{class:'col-table'},el('thead',{},el('tr',{},...[t('Účel'),t('Stroj'),t('Cesta'),t('Vlastník · práva'),t('Typ')].map(h=>el('th',{scope:'col'},h)))),el('tbody',{},rows)))));
}

function render(box,doc,now=Date.now()){
 const m=model(doc),health=doc.keys.map(k=>keyHealth(k,now));
 const rootKeys=doc.keys.filter(k=>k.access.some(a=>a.target.kind==='host'&&['nopasswd','root'].includes(a.sudo)&&!a.restricted));
 const noPass=doc.keys.filter(k=>k.copies.some(c=>c.encrypted===false));
 const weak=health.filter(h=>h.strength==='weak').length,aging=health.filter(h=>h.strength!=='weak'&&h.level==='warn').length;
 const foreign=doc.unknownAuthorized.length+(doc.forgejo?.unknown?.length||0);
 const warn=doc.findings.filter(f=>f.level!=='info').length;
 const unprobed=doc.machines.filter(x=>x.sshOpen!==undefined&&x.note);
 const tabs=[['matrix',t('Matice klíčů')],['keys',t('Inventář klíčů')],['accounts',t('Účty na strojích')],['other',t('Ostatní klíče')]];
 const content=el('div',{});
 const buttons=tabs.map(([id,label])=>[id,el('button',{type:'button',role:'tab',class:'col-chip',onclick:()=>{tab=id;paint();}},label)]);
 const nav=el('div',{class:'col-chips',role:'tablist','aria-label':t('Pohled')},buttons.map(([,b])=>b));
 const paint=()=>{fill(content,!doc.keys.length&&(tab==='matrix'||tab==='keys')?el('p',{class:'col-empty'},t('Sonda na prověřených strojích nenašla žádný SSH klíč.')):tab==='keys'?keysTable(doc,m,now):tab==='accounts'?accounts(doc,m):tab==='other'?otherKeys(doc,m):matrix(doc,m,now));
  for(const [id,b] of buttons){b.classList.toggle('on',id===tab);b.setAttribute('aria-selected',String(id===tab));}};
 fill(box,
  pageHeader({eyebrow:t('Bezpečnost'),title:t('SSH klíče'),lead:t('Kde leží každý privátní klíč, jakého je typu a stáří a kam se s ním dá přihlásit. Sběr posílá jen otisky a veřejné řádky; klíče samotné stroj neopouštějí.'),
   actions:[{label:t('Ochrana strojů'),href:'#hardening'}]}),
  freshnessBanner([{label:doc.collectedFrom?t('Snímek z {from}:',{from:doc.collectedFrom}):t('Snímek:'),...(doc.collector||{}),collectedAt:doc.collectedAt}]),
  el('div',{class:'col-stats'},
   stat(t('SSH klíčů'),doc.keys.length,t('{n} bez passphrase',{n:noPass.length}),noPass.length?'warn':''),
   stat(t('Klíčů = root'),rootKeys.length,t('otevírají účet se sudo bez hesla'),rootKeys.length?'bad':''),
   stat(t('Slabé a staré klíče'),weak+aging,t('{weak} slabý typ · {old} k výměně',{weak,old:aging}),weak?'bad':aging?'warn':''),
   stat(t('Cizí povolené klíče'),foreign,t('privátní část není na žádném stroji'),foreign?'warn':''),
   stat(t('Nálezy'),doc.findings.length,t('{warn} k řešení · {info} info',{warn,info:doc.findings.length-warn}),warn?'warn':'')),
  doc.findings.length?el('details',{class:'col-card',open:''},el('summary',{class:'col-sub'},el('span',{class:'col-name'},t('Nálezy')),' ',el('span',{class:'col-dim'},t('{warn} k řešení · {info} info',{warn,info:doc.findings.length-warn}))),
   el('ul',{class:'col-findings'},doc.findings.map(f=>el('li',{class:f.level},el('span',{class:'dot','aria-hidden':'true'}),el('div',{},el('div',{class:'col-name'},say(f.title,f.titleT)),f.detail?el('div',{class:'col-dim'},say(f.detail,f.detailT)):null))))):null,
  nav,content,
  el('p',{class:'col-foot'},t('Klíče jsem neotevíral mimo jejich stroj: probe na každém stroji pošle jen otisk (SHA256), cestu, práva a veřejné řádky authorized_keys.'),
   ...unprobed.map(x=>` ${x.name}: ${t(x.note).replace(/\.?$/,'.')}`)));
 paint();
}

// --- not configured / no snapshot yet -----------------------------------------------------------------
const setupSteps=()=>[
 t('V local/site.json dej každému stroji položku ssh s aliasem z ~/.ssh/config. Alias „local“ je stroj, na kterém sběr běží; „keys“: false stroj vynechá.'),
 t('Ověř, že „ssh <alias> true“ projde z tohoto stroje bez dotazu na heslo.'),
 t('Spusť sběr klíčů: {command}',{command:'node scripts/collect-security.mjs'}),
 t('Aby se snímek obnovoval sám: {mac} (macOS), nebo timer z {linux} (Linux).',{mac:'sh scripts/systems/install-launchd.sh --with-security',linux:'examples/systemd/'})];
function setupState(collector){
 if(collector?.state==='waiting'){const n=collector.machines?.length||0;
  return emptyState({icon:'◔',title:t('Sběr klíčů je nastavený, ale ještě neproběhl'),
   body:`${tp(n,'V konfiguraci je {n} stroj s aliasem ssh.|V konfiguraci jsou {n} stroje s aliasem ssh.|V konfiguraci je {n} strojů s aliasem ssh.')} ${t('Sběr jen čte: posílá otisky, cesty a veřejné řádky authorized_keys, nic na strojích nemění.')}`,
   steps:setupSteps().slice(2)});}
 return notInstalled({title:t('Inventář SSH klíčů není nastavený'),
  body:t('Tahle stránka ukazuje, kde leží privátní SSH klíče a kam se s nimi dá přihlásit. Čte to sběr po SSH, jen pro čtení, a zatím neví, které stroje má číst. Zbytek Home Hubu funguje dál.'),steps:setupSteps()});
}

export function securityView(){
 const box=el('div',{class:'col'},el('p',{class:'loading',role:'status'},t('Načítám inventář klíčů…')));
 const head=()=>pageHeader({eyebrow:t('Bezpečnost'),title:t('SSH klíče')});
 const draw=async()=>{
  const retry=[{label:t('Zkusit znovu'),onclick:()=>{fill(box,el('p',{class:'loading',role:'status'},t('Načítám inventář klíčů…')));draw();},primary:true}];
  try{
   const lost=authGuard(),r=await fetch('/api/security');
   if(!r.ok){lost(r);const e=await r.json().catch(()=>({}));
    if(r.status===404)fill(box,head(),setupState(e.collector));
    else fill(box,head(),emptyState({icon:'⚠',title:r.status===403?t('Jen pro administrátora'):t('Inventář se nepodařilo načíst'),body:r.status===403?t('Tahle stránka je dostupná jen správci.'):t(e.error?.message)||t('Zkus to znovu.'),actions:r.status===403?[]:retry}));
    return;}
   render(box,await r.json());
  }catch{fill(box,head(),emptyState({icon:'⚠',title:t('Home Hub neodpovídá'),body:t('Zkus to znovu.'),actions:retry}));}
 };
 draw();
 return box;
}
// Page entry for the shell (app.js): every page module exports (context) => Node, and the server's UI
// manifest names it. context = {me, page, sub, machine, site}.
export const securityPage=()=>securityView();
