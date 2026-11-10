// Bezpečnost → SSH klíče. Read-only view of data/security/ssh-keys.json (scripts/collect-security.mjs):
// where every private key lives, who owns it, whether the owner has password-less sudo, and what
// the key opens (machine · IP · account · sudo there, Forgejo, external).
import {el} from './views.js';
import {authGuard} from './session-cache.js';
import {t,tp,locale} from './i18n.js';
import {timeZone} from './site.js';

// Columns of the key → target matrix: every machine the collector could look into (in the snapshot's order),
// then the git server and everything else. Set from each loaded snapshot.
let TARGETS=[];
const setTargets=doc=>{TARGETS=[...(doc?.machines||[]).filter(m=>m.sshOpen===undefined).map(m=>[m.id,m.name||m.id]),['forgejo','Forgejo'],['other','Jiné']];};
let tab='keys';
const when=iso=>iso&&Number.isFinite(Date.parse(iso))?new Intl.DateTimeFormat(locale(),{day:'numeric',month:'numeric',year:'numeric',hour:'2-digit',minute:'2-digit',timeZone:timeZone()}).format(new Date(iso)):'—';
const day=iso=>iso&&Number.isFinite(Date.parse(iso))?new Intl.DateTimeFormat(locale(),{day:'numeric',month:'numeric',year:'numeric',timeZone:timeZone()}).format(new Date(iso)):'—';
const pill=(text,tone='',title)=>el('span',{class:`sec-pill ${tone}`,title},text);

// Labels stay Czech here and go through t() where they are displayed.
const SUDO={root:['root','crit','Účet root.'],nopasswd:['sudo bez hesla','crit','Může spustit cokoli jako root bez zadání hesla.'],
 limited:['sudo bez hesla jen pro vybrané příkazy','warn',''],password:['sudo s heslem','ok','sudo funguje, ale chce heslo.'],
 none:['bez sudo','ok','Účet nemá sudo.'],unknown:['sudo neověřeno','dim','Probe neměl práva sudo -l ověřit.'],
 'forgejo-admin':['Forgejo admin','crit','Plný přístup ke všem repozitářům a nastavení Forgejo.'],'forgejo-user':['Forgejo účet','warn','Repozitáře, ke kterým má účet přístup.'],
 'repo-write':['zápis do repozitáře','warn',''],'repo-read':['čtení repozitáře','ok','']};
function sudoPill(verdict){
 const level=typeof verdict==='string'?verdict:verdict?.level||'unknown';
 const [text,tone,title]=SUDO[level]||[level,'dim',''];
 const cmds=typeof verdict==='object'&&verdict?.commands?.length?`\n${verdict.commands.join('\n')}`:'';
 return pill(t(text),tone,(title?t(title):'')+cmds);
}

function model(doc){
 const machines=new Map(doc.machines.map(m=>[m.id,m]));
 const ipName=new Map();for(const m of doc.machines)for(const ip of m.ips||[])ipName.set(ip,m.id==='nas'?'NAS':m.name);
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
  bits.push(el('b',{},m.mName(tg.machine)),el('span',{class:'sec-dim'},m.mIp(tg.machine)),el('span',{class:'sec-user'},tg.user));
  bits.push(a.restricted?pill(t('jen příkaz'),'ok',a.command||''):sudoPill(a.sudo));
  // restrict / permitopen limit forwarding only; commands still run, so they never read as "ok".
  if(!a.restricted&&a.noForwarding)bits.push(pill(t('bez přesměrování (restrict)'),'dim',t('restrict vypíná přesměrování portů, agenta, X11 a PTY, ale libovolné příkazy dál povoluje.')));
  if(!a.restricted&&a.permitOpen?.length)bits.push(pill(t('tunel jen {targets}',{targets:a.permitOpen.join(', ')}),'dim',t('permitopen omezuje cíle tunelu, příkazy ne.')));
 }else if(tg.kind==='forgejo'){bits.push(el('b',{},'Forgejo'),el('span',{class:'sec-user'},tg.account),sudoPill(a.sudo));}
 else if(tg.kind==='forgejo-deploy'){bits.push(el('b',{},'Forgejo'),el('span',{class:'sec-dim'},tg.repo),pill(tg.readOnly?t('deploy klíč · čtení'):t('deploy klíč · zápis'),tg.readOnly?'ok':'warn'));}
 else bits.push(el('b',{},t(tg.label)),tg.user?el('span',{class:'sec-user'},tg.user):null,pill(t('neověřeno'),'dim',t('Vychází jen z ~/.ssh/config, cíl jsem neprověřil.')));
 const allow=tg.kind==='host'?m.allowFrom(tg.machine,tg.user):[];
 if(a.from?.length)bits.push(pill(t('jen z {from}',{from:fromText(a.from,m)}),'ok','authorized_keys from='));
 else if(allow.length)bits.push(pill(t('AllowUsers: jen z {from}',{from:fromText(allow,m)}),'ok',t('authorized_keys nemá from=, adresy omezuje sshd AllowUsers.')));
 else if(tg.kind==='host'&&!a.restricted)bits.push(pill(t('z libovolné adresy'),'warn',t('Bez from= v authorized_keys a bez AllowUsers v sshd.')));
 return el('div',{class:'sec-access'},...bits);
}

function copyLine(c,m){
 const acct=m.account(c.machine,c.owner);
 return el('div',{class:'sec-copy'},
  el('div',{},el('b',{},m.mName(c.machine)),' ',el('span',{class:'sec-dim'},m.mIp(c.machine)),c.backup?pill(t('záloha'),'warn'):null),
  el('div',{class:'sec-path',title:c.path},m.tilde(c.machine,c.owner,c.path)),
  el('div',{class:'sec-dim'},`${c.owner} · ${c.mode} · ${day(c.mtime)}`));
}

function keysTable(doc,m){
 const rows=doc.keys.map(k=>{
  const owners=[...new Map(k.copies.map(c=>[`${c.machine}/${c.owner}`,c])).values()];
  const enc=k.copies.every(c=>c.encrypted===true)?pill(t('chráněný heslem'),'ok'):k.copies.some(c=>c.encrypted===false)?pill(t('bez hesla'),'warn',t('Soubor klíče se otevře bez passphrase.')):pill('?','dim');
  return el('tr',{},
   el('td',{},el('div',{class:'sec-key'},k.name),k.comment&&k.comment!==k.name?el('div',{class:'sec-dim'},k.comment):null,
    el('div',{class:'sec-fp',title:k.fingerprint},`${k.type||''} ${k.bits||''} · ${k.fingerprint.slice(7,19)}…`),enc),
   el('td',{},...k.copies.map(c=>copyLine(c,m))),
   el('td',{},...owners.map(c=>el('div',{class:'sec-owner'},el('span',{class:'sec-user'},c.owner),' ',t('na'),' ',m.mName(c.machine),' ',sudoPill(m.account(c.machine,c.owner)?.sudo)))),
   el('td',{},k.access.length?k.access.map(a=>accessLine(a,m)):el('span',{class:'sec-dim'},t('Nikam nevede – nenašel jsem ho v žádném authorized_keys ani ve Forgejo.'))),
   el('td',{},k.routes.length?k.routes.map(r=>el('div',{class:'sec-route',title:`${r.hostname}:${r.port}${r.proxyJump?' '+t('přes {jump}',{jump:r.proxyJump}):''}`},
     el('code',{},`ssh ${r.alias}`),' ',r.accepted===false?pill(t('cíl ho nepřijímá'),'warn'):r.alsoGit?pill(t('i git'),'dim',t('Stejný Host blok vybírá klíč i pro git na Forgejo (:2222).')):null)):el('span',{class:'sec-dim'},'—')));
 });
 return el('div',{class:'sec-scroll'},el('table',{class:'sec-table'},
  el('thead',{},el('tr',{},...[t('Klíč'),t('Kde leží'),t('Vlastník · sudo na tom stroji'),t('Co odemyká (stroj · IP · účet · sudo tam)'),t('Použití v ~/.ssh/config')].map(h=>el('th',{},h)))),
  el('tbody',{},rows)));
}

function matrix(doc,m){
 setTargets(doc);
 const cell=(k,col)=>{
  const hits=k.access.filter(a=>col==='forgejo'?a.target.kind.startsWith('forgejo'):col==='other'?['external','local'].includes(a.target.kind):a.target.kind==='host'&&a.target.machine===col);
  if(!hits.length)return el('td',{class:'sec-mx-empty'},'·');
  return el('td',{},...hits.map(a=>{
   const tg=a.target;
   const tone=a.restricted?'ok':['nopasswd','root','forgejo-admin'].includes(a.sudo)?'crit':a.unverified?'dim':'warn';
   const text=tg.kind==='host'?tg.user:tg.kind==='forgejo'?tg.account:tg.kind==='forgejo-deploy'?tg.repo.split('/').pop():t(tg.label);
   const why=tg.kind==='host'?`${tg.user}@${m.mName(tg.machine)} · ${t((SUDO[a.sudo]||[a.sudo])[0])}${a.restricted?' · '+t('omezený příkaz'):''}${a.from?.length?' · '+t('jen z {from}',{from:fromText(a.from,m)}):''}`:t((SUDO[a.sudo]||[tg.label])[0]);
   return el('span',{class:`sec-mx ${tone}`,title:why},text,a.restricted?' ⌁':['nopasswd','root','forgejo-admin'].includes(a.sudo)?' #':'');
  }));
 };
 const groups=new Map();for(const k of doc.keys){const home=(k.copies.find(c=>!c.backup)||k.copies[0])?.machine||'?';if(!groups.has(home))groups.set(home,[]);groups.get(home).push(k);}
 const body=[];
 for(const [home,list] of groups){
  body.push(el('tr',{class:'sec-group'},el('th',{colspan:String(TARGETS.length+1)},t('Leží na {machine} · {ip}',{machine:m.mName(home),ip:m.mIp(home)}))));
  for(const k of list)body.push(el('tr',{},el('th',{scope:'row'},el('div',{class:'sec-key'},k.name),el('div',{class:'sec-dim'},[...new Set(k.copies.map(c=>c.owner))].join(', '))),...TARGETS.map(([id])=>cell(k,id))));
 }
 return el('div',{},
  el('p',{class:'sec-legend'},pill('# root','crit'),' ',t('účet se sudo bez hesla nebo Forgejo admin'),' · ',pill('⌁ '+t('omezeno'),'ok'),' ',t('jen příkaz nebo tunel'),' · ',pill(t('účet'),'warn'),' ',t('běžný přístup'),' · ',pill(t('neověřeno'),'dim'),' ',t('jen podle ~/.ssh/config')),
  el('div',{class:'sec-scroll'},el('table',{class:'sec-table sec-matrix'},
   el('thead',{},el('tr',{},el('th',{},t('Klíč → kam')),...TARGETS.map(([id,label])=>el('th',{},id==='forgejo'||id==='other'?t(label):label,id!=='forgejo'&&id!=='other'?el('div',{class:'sec-dim'},m.mIp(id)):null)))),
   el('tbody',{},body))));
}

function accounts(doc,m){
 return el('div',{class:'sec-machines'},doc.machines.map(mm=>{
  const head=el('header',{},el('h3',{},mm.name),el('span',{class:'sec-dim'},(mm.ips||[]).join(' · ')||'—'));
  if(!mm.reachable)return el('section',{class:'sec-machine'},head,el('p',{class:'sec-dim'},mm.note||mm.error?t(mm.note||mm.error):t('Nedostupné.')));
  const s=mm.ssh||{};
  const facts=el('div',{class:'sec-facts'},
   pill(s.listening?t('SSH zapnuté'):t('SSH vypnuté'),s.listening?'':'ok'),
   s.passwordAuth==null?null:pill(s.passwordAuth?t('přihlášení heslem povoleno'):t('jen klíče'),s.passwordAuth?'warn':'ok'),
   s.rootLogin?pill(`root: ${s.rootLogin}`,s.rootLogin==='no'?'ok':'dim','PermitRootLogin'):null,
   s.allowUsers?.length?pill(`AllowUsers: ${[...new Set(s.allowUsers.map(x=>x.replace(/^(.*)@(.*)$/,(_,u,ip)=>`${u}@${m.ipName.get(ip)||ip}`)))].join(', ')}`,'ok',s.allowUsers.join('\n')):null,
   s.accessGroup?.length&&s.accessGroup[0]!=='*'?pill(`Remote Login: ${s.accessGroup.join(', ')}`,'dim','com.apple.access_ssh'):null);
  const rows=mm.accounts.map(a=>el('tr',{},
   el('td',{},el('span',{class:'sec-user'},a.user),el('div',{class:'sec-dim'},`uid ${a.uid} · ${a.home||'—'}`)),
   el('td',{},sudoPill(a.sudo),a.sudo.expired?.length?el('div',{class:'sec-dim',title:a.sudo.expired.join('\n')},tp(a.sudo.expired.length,'+ {n} prošlé pravidlo|+ {n} prošlá pravidla|+ {n} prošlých pravidel')):null),
   el('td',{},a.authorizedKeys.length?a.authorizedKeys.map(e=>{
    const src=doc.keys.find(k=>k.fingerprint===e.fingerprint);
    const origin=src?[...new Set(src.copies.map(c=>m.mName(c.machine)))].join(', '):null;
    return el('div',{class:'sec-access'},el('b',{},src?src.name:(e.comment||e.fingerprint).slice(0,40)),
     origin?el('span',{class:'sec-dim'},t('z {origin}',{origin})):pill(t('cizí – privátní část nenalezena'),'warn',e.fingerprint),
     e.from.length?pill(t('jen z {from}',{from:fromText(e.from,m)}),'ok'):null,e.restricted?pill(t('jen příkaz'),'ok',e.command||''):e.noForwarding?pill(t('bez přesměrování'),'dim',t('restrict: příkazy povolené, přesměrování ne.')):null);
   }):el('span',{class:'sec-dim'},t('žádné povolené klíče')))));
  return el('section',{class:'sec-machine'},head,facts,el('div',{class:'sec-scroll'},el('table',{class:'sec-table'},
   el('thead',{},el('tr',{},el('th',{},t('Účet')),el('th',{},'sudo'),el('th',{},t('Kdo se sem dostane (authorized_keys)')))),el('tbody',{},rows))));
 }));
}

function otherKeys(doc,m){
 const rows=doc.otherKeys.map(o=>el('tr',{},el('td',{},t(o.label),o.backup?pill(t('záloha'),'warn'):null),el('td',{},el('b',{},m.mName(o.machine)),' ',el('span',{class:'sec-dim'},m.mIp(o.machine))),
  el('td',{},el('div',{class:'sec-path',title:o.path},m.tilde(o.machine,o.owner,o.path))),el('td',{},`${o.owner} · ${o.mode}`),el('td',{class:'sec-dim'},[o.type,o.bits].filter(Boolean).join(' ')||'—')));
 return el('div',{},el('p',{class:'sec-dim'},t('Privátní klíče, které nejsou klientské SSH klíče: HTTPS certifikáty, klíče SSH serverů (Forgejo, starý Gitea), podpisové klíče a identita aplikací.')),
  el('div',{class:'sec-scroll'},el('table',{class:'sec-table'},el('thead',{},el('tr',{},...[t('Účel'),t('Stroj'),t('Cesta'),t('Vlastník · práva'),t('Typ')].map(h=>el('th',{},h)))),el('tbody',{},rows))));
}

function render(box,doc){
 const m=model(doc);
 const rootKeys=doc.keys.filter(k=>k.access.some(a=>a.target.kind==='host'&&['nopasswd','root'].includes(a.sudo)&&!a.restricted));
 const noPass=doc.keys.filter(k=>k.copies.some(c=>c.encrypted===false));
 const sudoAccounts=doc.machines.flatMap(mm=>(mm.accounts||[]).filter(a=>a.sudo.level==='nopasswd').map(a=>`${a.user}@${mm.name}`));
 const warn=doc.findings.filter(f=>f.level!=='info').length;
 const routerNote=doc.machines.find(x=>x.id==='router')?.note;
 const stat=(k,v,sub,tone='')=>el('div',{class:`sec-stat ${tone}`},el('div',{class:'k'},k),el('div',{class:'v'},v),el('div',{class:'s'},sub));
 const tabs=[['keys',t('Inventář klíčů')],['matrix',t('Matice přístupů')],['accounts',t('Účty na strojích')],['other',t('Ostatní klíče')]];
 const content=el('div',{class:'sec-tab'});
 const paint=()=>{content.replaceChildren(tab==='matrix'?matrix(doc,m):tab==='accounts'?accounts(doc,m):tab==='other'?otherKeys(doc,m):keysTable(doc,m));
  nav.querySelectorAll('button').forEach(b=>{b.classList.toggle('on',b.dataset.tab===tab);b.setAttribute('aria-selected',String(b.dataset.tab===tab));});};
 const nav=el('div',{class:'sec-tabs',role:'tablist'},tabs.map(([id,label])=>el('button',{role:'tab','data-tab':id,onclick:()=>{tab=id;paint();}},label)));
 box.replaceChildren(
  el('div',{class:'dev-head'},el('div',{class:'dev-title'},el('a',{class:'home-back',href:'#overview'},'← '+t('Přehled')),el('h2',{},`${t('Bezpečnost')} · ${t('SSH klíče')}`),
   el('div',{class:'dev-host'},t('Snímek {when} · sebráno z {from} · obnovit: node scripts/collect-security.mjs',{when:when(doc.collectedAt),from:doc.collectedFrom||'?'})))),
  el('div',{class:'sec-stats'},
   stat(t('SSH klíčů'),doc.keys.length,t('{n} bez passphrase',{n:noPass.length}),noPass.length?'warn':''),
   stat(t('Klíčů = root'),rootKeys.length,t('otevírají účet se sudo bez hesla'),rootKeys.length?'crit':''),
   stat(t('Účtů se sudo bez hesla'),sudoAccounts.length,sudoAccounts.join(', ')||'—',sudoAccounts.length?'warn':''),
   stat(t('Cizí povolené klíče'),doc.unknownAuthorized.length+(doc.forgejo?.unknown?.length||0),t('privátní část není na žádném stroji'),doc.unknownAuthorized.length?'warn':''),
   stat(t('Nálezy'),doc.findings.length,t('{warn} k řešení · {info} info',{warn,info:doc.findings.length-warn}),warn?'warn':'')),
  el('details',{class:'sec-findings',open:''},el('summary',{},t('Nálezy')),
   el('ul',{},doc.findings.map(f=>el('li',{class:f.level},el('span',{class:'dot'}),el('div',{},el('b',{},t(f.title)),f.detail?el('div',{class:'sec-dim'},t(f.detail)):null))))),
  nav,content,
  el('p',{class:'sec-foot'},t('Klíče jsem neotevíral mimo jejich stroj: probe na každém stroji pošle jen otisk (SHA256), cestu, práva a veřejné řádky authorized_keys.'),' ',t('Router:'),' ',
   (routerNote?t(routerNote):t('neprověřen.')).replace(/\.?$/,'.')));
 paint();
}

export function securityView(){
 const box=el('div',{class:'sec'},el('p',{class:'loading',role:'status'},t('Načítám inventář klíčů…')));
 (async()=>{
  try{
   const lost=authGuard(),r=await fetch('/api/security');
   if(!r.ok){lost(r);const e=await r.json().catch(()=>({}));
    box.replaceChildren(el('div',{class:'sec-empty'},el('h2',{},r.status===404?t('Inventář klíčů zatím není'):r.status===403?t('Jen pro administrátora'):t('Inventář se nepodařilo načíst')),el('p',{class:'sec-dim'},t(e.error?.message)||t('Zkus to znovu.'))));return;}
   render(box,await r.json());
  }catch{box.replaceChildren(el('div',{class:'sec-empty'},el('h2',{},t('Home Hub neodpovídá')),el('p',{class:'sec-dim'},t('Zkus to znovu.'))));}
 })();
 return box;
}
// Page entry for the shell (app.js): every page module exports (context) => Node, and the server's UI
// manifest names it. context = {me, page, sub, machine, site}.
export const securityPage=()=>securityView();
