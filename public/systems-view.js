// Systémy pages, one payload (GET /api/systems, admins only):
//   #versions[/machine]   Verze a aktualizace: OS versions, watched software, update candidates
//   #hardening[/machine]  Ochrana strojů: firewall, FileVault, SIP, Gatekeeper, update policy,
//                         SSH password login, sharing and ports open to the network
// Charts sit on top (all machines), tables below follow the machine filter in the URL.
// SSH keys and sudo stay on #security; this page links there.
import {el} from './views.js';
import {loadECharts} from './home-charts.js';
import {sessionCache,authGuard} from './session-cache.js';
import {t,tp,locale} from './i18n.js';
import {timeZone} from './site.js';

// [id, name, colour] of the probed machines, in the order the server lists them (the site's machines);
// filled from each loaded document. Colours are a fixed palette by position.
const PALETTE=['#4da3ff','#8f7bff','#4de3c0','#9ecbff','#ffb020','#ff9e7a','#f78fb3','#c3e88d'];
let MACHINES=[];
const setMachines=doc=>{MACHINES=(doc?.machines||[]).map((m,i)=>[m.id,m.name||m.id,PALETTE[i%PALETTE.length]]);};
const mName=id=>MACHINES.find(m=>m[0]===id)?.[1]||id;
// Labels in these tables stay Czech; they are translated with t() where they are displayed.
// Categorical series (validated for the dark panel #121019: L band, CVD, contrast) and status tokens.
const SERIES=[['os','Systém','#378ee9'],['software','Software','#cb6f4d'],['apps','Aplikace NAS','#9979cd']];
const STATES=[['ok','v pořádku','#7be3b5'],['info','k vědomí','#6f6880'],['warn','varování','#ffc266'],['crit','kritické','#ff6b81'],['unknown','neověřeno','#3a3448']];
const STATUS={update:['aktualizace','warn','Je venku novější verze.'],current:['aktuální','ok',''],ahead:['novější než vydání','dim','Nainstalovaná verze je novější než poslední stabilní vydání.'],
 unknown:['neověřeno','dim',''],missing:['nenalezeno','crit','Program na tomto stroji probe nenašel.'],'n/a':['bez kontroly','dim','Pro tento program se nejnovější verze nekontroluje.'],
 floating:['plovoucí tag','dim',''],major:['nová hlavní verze','info','Stejná řada je aktuální; nabízí se další hlavní verze.']};
export const when=iso=>iso&&Number.isFinite(Date.parse(iso))?new Intl.DateTimeFormat(locale(),{day:'numeric',month:'numeric',hour:'2-digit',minute:'2-digit',timeZone:timeZone()}).format(new Date(iso)):'—';
const day=iso=>iso&&Number.isFinite(Date.parse(iso))?new Intl.DateTimeFormat(locale(),{day:'numeric',month:'numeric',year:'numeric',timeZone:timeZone()}).format(new Date(iso)):'';
export const pill=(text,tone='',title)=>el('span',{class:`sec-pill ${tone}`,title},text);
export const statusPill=s=>{const [label,tone,title]=STATUS[s]||[s,'dim',''];return pill(t(label),tone,title?t(title):title);};
const link=(text,url)=>url?el('a',{href:url,target:'_blank',rel:'noopener noreferrer',class:'sys-link'},text):el('span',{},text);
const uptime=s=>s==null?'—':s>=86400?`${Math.floor(s/86400)} d ${Math.floor(s%86400/3600)} h`:`${Math.floor(s/3600)} h ${Math.floor(s%3600/60)} min`;
const stat=(k,v,sub,tone='')=>el('div',{class:`sec-stat ${tone}`},el('div',{class:'k'},k),el('div',{class:'v'},v),el('div',{class:'s',title:sub},sub));

// Admin-only payload: cached 30 s per signed-in principal and dropped on logout/account switch.
const cache=sessionCache(30000);let charts=[],observer=null;
const tabs={versions:'software',hardening:'checks'};
let onlyUpdates=false,showLoopback=false;
function disposeCharts(){for(const c of charts)try{c.dispose();}catch{}charts=[];observer?.disconnect();observer=null;}
// Also used by the inventory map for its version block (same per-principal cache).
export async function load(force=false){
 const hit=force?undefined:cache.get();if(hit)return hit;
 const store=cache.begin(),lost=authGuard();
 const r=await fetch('/api/systems');
 if(!r.ok){lost(r);const e=await r.json().catch(()=>({}));const err=new Error(e.error?.message||t('Načtení selhalo.'));err.status=r.status;throw err;}
 return store('',await r.json());
}

// Horizontal stacked bars: one row per machine, legend on top, plain-text tooltip (CSP: no inline styles).
async function stackedChart(node,{rows,series,title}){
 const echarts=await loadECharts();if(!node.isConnected)return;
 const chart=echarts.init(node,null,{renderer:'canvas'});charts.push(chart);
 const names=rows.map(r=>r.name);
 chart.setOption({animation:false,grid:{left:96,right:44,top:34,bottom:6},
  legend:{top:0,left:0,icon:'roundRect',itemWidth:10,itemHeight:10,itemGap:14,textStyle:{color:'#a8a1b4',fontFamily:'ui-monospace,Menlo,monospace',fontSize:11}},
  tooltip:{trigger:'axis',axisPointer:{type:'shadow',shadowStyle:{color:'rgba(255,255,255,.03)'}},backgroundColor:'rgba(18,16,25,.95)',borderColor:'#3a3448',
   textStyle:{color:'#f3ede4',fontSize:11,fontFamily:'ui-monospace,Menlo,monospace'},
   formatter:items=>[`${items[0]?.name} · ${title}`,...items.filter(i=>i.value).map(i=>`${i.seriesName}: ${i.value}`),items.every(i=>!i.value)?t('nic'):''].filter(Boolean).join('<br>')},
  xAxis:{type:'value',minInterval:1,splitLine:{lineStyle:{color:'#25212f'}},axisLabel:{color:'#6f6880',fontFamily:'ui-monospace,Menlo,monospace',fontSize:10}},
  yAxis:{type:'category',data:names,inverse:true,axisTick:{show:false},axisLine:{lineStyle:{color:'#25212f'}},axisLabel:{color:'#f3ede4',fontSize:12}},
  series:series.map(([key,label,color],i)=>({name:label,type:'bar',stack:'all',barMaxWidth:22,data:rows.map(r=>r[key]||0),
   itemStyle:{color,borderColor:'#121019',borderWidth:2,borderRadius:i===series.length-1?[0,4,4,0]:0},emphasis:{focus:'series'},
   label:i===series.length-1?{show:true,position:'right',color:'#a8a1b4',fontFamily:'ui-monospace,Menlo,monospace',fontSize:11,
    formatter:p=>{const sum=series.reduce((s,[k])=>s+(rows[p.dataIndex][k]||0),0);return sum?String(sum):'0';}}:undefined}))});
 observer??=new ResizeObserver(()=>charts.forEach(c=>c.resize()));observer.observe(node);
}

function header(doc,mode){
 return el('div',{class:'dev-head'},el('div',{class:'dev-title'},el('a',{class:'home-back',href:'#overview'},`← ${t('Přehled')}`),
  el('h2',{},mode==='versions'?t('Verze a aktualizace'):t('Ochrana strojů')),
  el('div',{class:'dev-host'},t('Stroje {collected} · nejnovější verze {upstream}{failed} · automaticky každých 6 h (stroje) a 12 h (vydání)',{collected:when(doc.collectedAt),upstream:when(doc.upstreamCheckedAt),
   failed:doc.upstreamFailed?` (${tp(doc.upstreamFailed,'{n} zdroj neověřen|{n} zdroje neověřeny|{n} zdrojů neověřeno')})`:''}))),
  el('div',{class:'dev-host'},t('ručně: {commands}',{commands:'node scripts/collect-systems.mjs · node scripts/check-upstream.mjs'})));
}
function machineChips(mode,machine,doc){
 const chip=(id,label,tint)=>{const a=el('a',{href:id?`#${mode}/${id}`:`#${mode}`,class:`sys-chip${(machine||'')===(id||'')?' on':''}`});
  if(tint){const d=el('span',{class:'dot'});d.style.background=tint;a.append(d);}a.append(label);
  const m=id&&doc.machines.find(x=>x.id===id);if(m?.stale)a.append(pill(t('starý snímek'),'warn',t(m.error||'')));else if(m&&!m.reachable)a.append(pill(t('nedostupný'),'crit',t(m.error||'')));return a;};
 return el('nav',{class:'sys-chips','aria-label':t('Filtr strojů')},chip(null,t('Všechny stroje')),...MACHINES.map(([id,l,t])=>chip(id,l,t)));
}
function tabNav(mode,list,paint){
 return el('div',{class:'sec-tabs',role:'tablist'},list.map(([id,label])=>el('button',{role:'tab','data-tab':id,class:tabs[mode]===id?'on':'','aria-selected':String(tabs[mode]===id),onclick:e=>{tabs[mode]=id;e.currentTarget.parentNode.querySelectorAll('button').forEach(b=>{b.classList.toggle('on',b.dataset.tab===id);b.setAttribute('aria-selected',String(b.dataset.tab===id));});paint();}},label)));
}

// --- Verze a aktualizace -------------------------------------------------------------------------
function softwareTable(doc,machine){
 const rows=doc.software.filter(r=>(!machine||r.machine===machine)&&(!onlyUpdates||r.status==='update'));
 const cats=Object.keys(doc.categories).filter(c=>rows.some(r=>r.category===c));
 if(!rows.length)return el('p',{class:'sec-dim sys-empty'},onlyUpdates?t('Žádný kandidát na aktualizaci.'):t('Nic ke zobrazení.'));
 const body=cats.flatMap(c=>[el('tr',{class:'sec-group'},el('th',{colspan:'6'},t(doc.categories[c]))),
  ...rows.filter(r=>r.category===c).map(r=>el('tr',{class:r.status==='update'?'sys-upd':''},
   el('td',{},el('div',{class:'sys-name'},r.name),r.others?.length?el('div',{class:'sec-dim',title:r.others.join('\n')},t('+ další instalace: {n}',{n:r.others.length})):null),
   el('td',{},el('b',{},mName(r.machine)),r.stale?pill(t('starý snímek'),'warn'):null),
   el('td',{},el('div',{class:'sys-ver'},r.installed||'—'),r.path?el('div',{class:'sec-path',title:r.raw||r.path},r.path.replace(/^\/Users\/[^/]+/,'~')):null,
    r.running==='running'?pill(t('běží'),'ok',r.runLabel||''):r.running==='loaded'?pill(t('načteno, neběží'),'dim',r.runLabel||''):r.running==='absent'?pill(t('neběží'),'dim',r.runLabel||''):null),
   el('td',{},link(t(r.source?.label||'—'),r.source?.url)),
   el('td',{},r.latest?el('div',{class:'sys-ver'},link(r.latest,r.latestUrl)):el('span',{class:'sec-dim'},'—'),r.publishedAt&&r.category!=='containers'?el('div',{class:'sec-dim'},day(r.publishedAt)):null),
   el('td',{},statusPill(r.status),r.upstreamStale&&r.status!=='unknown'?pill(t('neověřeno'),'warn',t('Poslední kontrola selhala{error}; údaj z {when}.',{error:r.upstreamError?`: ${t(r.upstreamError)}`:'',when:when(r.upstreamCheckedAt)})):null,
    r.note?el('div',{class:'sec-dim sys-note'},t(r.note)):null)))]);
 return el('div',{class:'sec-scroll'},el('table',{class:'sec-table sys-table'},
  el('thead',{},el('tr',{},...['Program','Stroj','Nainstalováno','Odkud','Nejnovější','Stav'].map(h=>el('th',{},t(h))))),el('tbody',{},body)));
}
function osTable(doc,machine){
 const ms=doc.machines.filter(m=>!machine||m.id===machine);
 return el('div',{class:'sec-scroll'},el('table',{class:'sec-table sys-table'},
  el('thead',{},el('tr',{},...['Stroj','Systém','Jádro / základ','Hardware','Běží','Dostupné aktualizace','Stav'].map(h=>el('th',{},t(h))))),
  el('tbody',{},ms.map(m=>el('tr',{},
   el('td',{},el('b',{},m.name),m.stale?pill(t('starý snímek'),'warn',t(m.error||'')):!m.reachable?pill(t('nedostupný'),'crit',t(m.error||'')):null),
   el('td',{},m.os?el('div',{class:'sys-ver'},`${m.os.name} ${m.os.version||''}`):'—',m.os?.build?el('div',{class:'sec-dim'},`build ${m.os.build}`):m.os?.channel?el('div',{class:'sec-dim'},m.os.channel):null),
   el('td',{class:'sec-dim'},[m.os?.kernel,m.os?.base].filter(Boolean).join(' · ')||'—'),
   el('td',{class:'sec-dim'},[m.hw?.model,m.hw?.cpu,m.hw?.ramGb?`${m.hw.ramGb} GB RAM`:null].filter(Boolean).join(' · ')||'—'),
   el('td',{class:'sec-dim'},uptime(m.uptimeSeconds)),
   el('td',{},m.os?.updates?.length?m.os.updates.map(u=>el('div',{class:'sys-upd-line'},el('span',{},u.title.includes(u.version)?u.title:`${u.title} ${u.version||''}`),' ',
     u.kind==='major'?pill(t('hlavní verze'),'info'):u.kind==='app'?pill(t('aplikace'),'dim'):pill(u.restart?t('vyžaduje restart'):t('aktualizace'),'warn'),u.date?el('span',{class:'sec-dim'},` ${u.date}`):null,
     u.notes?el('div',{class:'sec-dim sys-note'},t(u.notes)):null)):el('span',{class:'sec-dim'},t(m.os?.error)||(m.os?.status==='unknown'?t('neověřeno'):t('žádné')))),
   el('td',{},statusPill(m.os?.status||'unknown')))))));
}
function brewTable(doc,machine){
 const ms=doc.machines.filter(m=>(!machine||m.id===machine)&&m.brewOutdated?.length);
 if(!ms.length)return el('p',{class:'sec-dim sys-empty'},t('Žádné zastaralé balíčky Homebrew.'));
 return el('div',{class:'sys-brew'},el('p',{class:'sec-dim'},t('Ostatní balíčky Homebrew, které nejsou ve sledovaném seznamu (většinou knihovny). Podle metadat, která si brew naposledy stáhl; sběr nespouští brew update.')),
  ...ms.map(m=>el('details',{class:'sec-findings'},el('summary',{},tp(m.brewOutdated.length,'{name} · {n} zastaralý|{name} · {n} zastaralé|{name} · {n} zastaralých',{name:m.name})),
   el('div',{class:'sys-brew-list'},m.brewOutdated.map(b=>el('div',{},el('span',{class:'sys-name'},b.name),' ',el('span',{class:'sec-dim'},`${b.installed} → ${b.latest}`)))))));
}
function versionsPage(box,doc,machine){
 const sw=doc.software.filter(r=>!['nas-apps','containers'].includes(r.category));
 const upd=doc.software.filter(r=>r.status==='update'),osUpd=doc.machines.filter(m=>m.os?.status==='update');
 const unknown=doc.software.filter(r=>r.status==='unknown').length,stale=doc.machines.filter(m=>m.stale||!m.reachable).length;
 const chartNode=el('div',{class:'sys-chart',role:'img','aria-label':t('Kandidáti na aktualizaci podle stroje: systém, software a aplikace NAS')});
 const content=el('div',{});
 const paint=()=>{content.replaceChildren(tabs.versions==='os'?osTable(doc,machine):tabs.versions==='brew'?brewTable(doc,machine):el('div',{},
  el('label',{class:'sys-toggle'},el('input',{type:'checkbox',...(onlyUpdates?{checked:''}:{}),onchange:e=>{onlyUpdates=e.currentTarget.checked;paint();}}),` ${t('Jen kandidáti na aktualizaci')}`),softwareTable(doc,machine)));};
 box.replaceChildren(header(doc,'versions'),
  el('div',{class:'sec-stats'},
   stat(t('Kandidáti na aktualizaci'),upd.length+osUpd.length,t('systém + software + aplikace NAS'),upd.length+osUpd.length?'warn':''),
   stat(t('Systémy'),`${osUpd.length} / ${doc.machines.length}`,osUpd.map(m=>`${m.name} → ${m.os.updates.find(u=>u.kind!=='major'&&u.kind!=='app')?.version||''}`).join(', ')||t('všechny aktuální'),osUpd.length?'warn':''),
   stat(t('Software'),sw.filter(r=>r.status==='update').length,tp(sw.length,'z {n} sledované instalace|z {n} sledovaných instalací|z {n} sledovaných instalací'),''),
   stat(t('Aplikace NAS'),doc.software.filter(r=>r.category==='nas-apps'&&r.status==='update').length,tp(doc.software.filter(r=>r.category==='nas-apps').length,'z {n} aplikace v TrueNAS|z {n} aplikací v TrueNAS|z {n} aplikací v TrueNAS'),''),
   stat(t('Neověřeno'),unknown+stale,stale?tp(stale,'{n} stroj bez čerstvého snímku|{n} stroje bez čerstvého snímku|{n} strojů bez čerstvého snímku'):t('verze, které nešly porovnat'),unknown+stale?'warn':'')),
  el('section',{class:'sys-card'},el('h3',{},t('Kandidáti na aktualizaci podle stroje')),chartNode),
  machineChips('versions',machine,doc),
  tabNav('versions',[['software',t('Software')],['os',t('Operační systémy')],['brew',t('Ostatní Homebrew')]],paint),content);
 paint();
 const rows=MACHINES.map(([id,name])=>{const m=doc.machines.find(x=>x.id===id);return {name,os:m?.summary?.osUpdate||0,software:m?.summary?.softwareUpdates||0,apps:m?.summary?.appUpdates||0};});
 stackedChart(chartNode,{rows,series:SERIES.map(([k,l,c])=>[k,t(l),c]),title:t('kandidáti na aktualizaci')}).catch(()=>chartNode.replaceChildren(el('p',{class:'sec-dim'},t('Graf se nepodařilo vykreslit.'))));
}

// --- Ochrana strojů ---------------------------------------------------------------------------------
const CHECK_ORDER=['firewall','stealth','pf','filevault','sip','gatekeeper','security-responses','auto-macos','os-update','ssh-password','ssh-root','ssh-forwarding','ftp','sharing','exposed'];
const TONE={ok:'ok',warn:'warn',crit:'crit',info:'dim',unknown:'dim'};
function checksMatrix(doc,machine){
 const ms=doc.machines.filter(m=>!machine||m.id===machine);
 const ids=[...new Set(ms.flatMap(m=>m.checks.map(c=>c.id)))].sort((a,b)=>(CHECK_ORDER.indexOf(a)+1||99)-(CHECK_ORDER.indexOf(b)+1||99));
 const rawLabel=id=>ms.flatMap(m=>m.checks).find(c=>c.id===id)?.label||id;const label=id=>t(rawLabel(id));
 return el('div',{class:'sec-scroll'},el('table',{class:'sec-table sys-matrix'},
  el('thead',{},el('tr',{},el('th',{},t('Kontrola')),...ms.map(m=>el('th',{},m.name,m.stale?el('div',{class:'sec-dim'},t('starý snímek')):null)))),
  el('tbody',{},ids.map(id=>el('tr',{},el('th',{scope:'row'},label(id)),...ms.map(m=>{const c=m.checks.find(x=>x.id===id);
   return el('td',{},c?[pill(t(c.value),TONE[c.state],t(c.detail||'')),c.detail&&machine?el('div',{class:'sec-dim sys-note'},t(c.detail)):null]:el('span',{class:'sec-mx-empty'},'—'));}))))));
}
function portsTable(doc,machine){
 const ms=doc.machines.filter(m=>!machine||m.id===machine);
 const scope={all:['všechna rozhraní','warn'],address:['jedna adresa','dim'],loopback:['jen tento stroj','ok']};
 const wrap=el('div',{class:'sys-ports'});
 const draw=()=>{
  const rows=ms.flatMap(m=>m.listening.filter(l=>showLoopback||l.scope!=='loopback').map(l=>({...l,machine:m.name}))).sort((a,b)=>a.machine.localeCompare(b.machine)||a.port-b.port);
  wrap.replaceChildren(el('label',{class:'sys-toggle'},el('input',{type:'checkbox',...(showLoopback?{checked:''}:{}),onchange:e=>{showLoopback=e.currentTarget.checked;draw();}}),` ${t('Ukázat i porty jen pro tento stroj (127.0.0.1)')}`),
   el('div',{class:'sec-scroll'},el('table',{class:'sec-table sys-table'},el('thead',{},el('tr',{},...['Stroj','Port','Proces','Adresa','Dosah'].map(h=>el('th',{},t(h))))),
    el('tbody',{},rows.map(l=>el('tr',{},el('td',{},el('b',{},l.machine)),el('td',{class:'sys-ver'},String(l.port)),el('td',{},l.proc),el('td',{class:'sec-dim'},l.host||'*'),el('td',{},(([label,tone])=>pill(t(label),tone))(scope[l.scope]||[l.scope,'dim']))))))));
 };
 draw();return wrap;
}
// The sentence wraps a link: the translated text is split at {link}.
function foot(){
 const [before,after='']=t('Klíče, authorized_keys a sudo pravidla jsou na stránce {link}. Sběr je jen pro čtení: probe na Macích čte stav přes systémové nástroje (pfctl, sshd -T a lsof přes sudo -n), na NAS přes TrueNAS API.').split('{link}');
 return el('p',{class:'sec-foot'},before,el('a',{href:'#security',class:'sys-link'},t('SSH klíče')),after);
}
function hardeningPage(box,doc,machine){
 const all=doc.machines.flatMap(m=>m.checks.map(c=>({...c,machine:m.name})));
 const fwOff=doc.machines.filter(m=>m.checks.some(c=>c.id==='firewall'&&c.state==='warn'));
 const exposed=doc.machines.reduce((s,m)=>s+new Set(m.listening.filter(l=>l.scope!=='loopback').map(l=>l.port)).size,0);
 const warn=all.filter(c=>c.state==='warn'),crit=all.filter(c=>c.state==='crit');
 const chartNode=el('div',{class:'sys-chart',role:'img','aria-label':t('Výsledky kontrol podle stroje')});
 const content=el('div',{});
 const paint=()=>content.replaceChildren(tabs.hardening==='ports'?portsTable(doc,machine):checksMatrix(doc,machine));
 box.replaceChildren(header(doc,'hardening'),
  el('div',{class:'sec-stats'},
   stat(t('Firewall vypnutý'),`${fwOff.length} / ${doc.machines.length}`,fwOff.map(m=>m.name).join(', ')||t('všude zapnutý'),fwOff.length?'warn':''),
   stat(t('Varování'),warn.length,[...new Set(warn.map(c=>t(c.label)))].join(', ')||'—',warn.length?'warn':''),
   stat(t('Kritické'),crit.length,crit.map(c=>`${c.machine}: ${t(c.label)}`).join(', ')||t('žádné'),crit.length?'crit':''),
   stat(t('Porty do sítě'),exposed,t('otevřené na všech rozhraních nebo adrese LAN'),''),
   el('a',{href:'#security',class:'sec-stat sys-stat-link'},el('div',{class:'k'},t('SSH klíče a sudo')),el('div',{class:'v'},'→'),el('div',{class:'s'},`${t('Bezpečnost')} · ${t('SSH klíče')}`))),
  el('section',{class:'sys-card'},el('h3',{},t('Kontroly podle stroje')),chartNode),
  machineChips('hardening',machine,doc),
  tabNav('hardening',[['checks',t('Kontroly')],['ports',t('Otevřené porty')]],paint),content,
  foot());
 paint();
 const rows=MACHINES.map(([id,name])=>{const m=doc.machines.find(x=>x.id===id);return {name,...(m?.summary?.checks||{})};});
 stackedChart(chartNode,{rows,series:STATES.map(([k,l,c])=>[k,t(l),c]),title:t('kontroly')}).catch(()=>chartNode.replaceChildren(el('p',{class:'sec-dim'},t('Graf se nepodařilo vykreslit.'))));
}

export function systemsView(mode='versions',machine=null){
 disposeCharts();
 const box=el('div',{class:'sec sys'},el('p',{class:'loading',role:'status'},t('Načítám stav strojů…')));
 (async()=>{
  try{const doc=await load();
   setMachines(doc);(mode==='hardening'?hardeningPage:versionsPage)(box,doc,MACHINES.some(m=>m[0]===machine)?machine:null);}
  catch(e){box.replaceChildren(el('div',{class:'sec-empty'},el('h2',{},e.status===404?t('Stav strojů zatím není'):e.status===403?t('Jen pro administrátora'):t('Stav strojů se nepodařilo načíst')),el('p',{class:'sec-dim'},t(e.message)||t('Zkus to znovu.'))));}
 })();
 return box;
}
// Page entry for the shell (app.js): every page module exports (context) => Node, and the server's UI
// manifest names it. context = {me, page, sub, machine, site}.
export const systemsPage=({page,sub})=>systemsView(page,sub);
