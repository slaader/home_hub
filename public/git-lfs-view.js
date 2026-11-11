// Inventář → Git LFS (#git-lfs). The LFS objects of the repositories on the connected git hosts: per object
// its size, the file paths that point to it, the refs whose tip has it, the first and last commit, and its
// status: current (the default branch has it), history only (an older commit or another branch), or orphaned
// (no commit reachable from any ref; the host still stores it). Search, filters, sorting and pages are done
// by the server (GET /api/git-lfs/objects). Deleting is offered only for orphaned objects past the grace
// period on a host whose provider can delete; the dialog previews exactly what goes, and the server scans the
// repository again before it deletes anything. A host that cannot delete (GitHub, Gitea, Forgejo) says how to
// remove the object by hand. Managing connections and deleting needs the git-lfs:write permission.
import {el,onLeave} from './views.js';
import {authGuard} from './session-cache.js';
import {t,tp,locale} from './i18n.js';
import {timeZone} from './site.js';
import {pageHeader,emptyState,notInstalled,disabledNotice,errorState,loadingState,statusPill,toast} from './ui.js';
import {hasScope} from './access.js';
import {openWizard,capabilityList,tokenGuides} from './git-lfs-wizard.js';
// replaceChildren() would print null/false as text; drop empty children the way el() does.
const put=(node,...kids)=>node.replaceChildren(...kids.flat(Infinity).filter(k=>k!==undefined&&k!==null&&k!==false));

const WRITE='git-lfs:write';
let stylesheet=false;
const STATUS={current:['Na výchozí větvi','good','Je v nejnovějším commitu výchozí větve repozitáře.'],
 branch:['Na jiné větvi','info','Na výchozí větvi není, ale je v nejnovějším commitu jiné větve nebo tagu (viz Kde). Uvolnil by se až po smazání těch větví a přepsání historie.'],
 history:['Jen ve starých commitech','info','Žádná větev ani tag ho v nejnovějším commitu nemá; odkazují na něj jen starší commity. Smazat by šel jen po přepsání historie.'],
 orphaned:['Nepoužívaný','warn','Žádný commit dosažitelný z větve nebo tagu na něj neukazuje; host ho stále ukládá.']};
const BLOCKED={current:'Používá ho výchozí větev.',branch:'Je v nejnovějším commitu jiné větve. Smazat by šel až po smazání té větve a přepsání historie.',history:'Odkazuje na něj historie. Smazání by vyžadovalo přepsání historie, a to hub nedělá.',unverified:'Poslední sken repozitáře neproběhl celý; mazání je zablokované.',
 'storage-unknown':'Host nepotvrdil, že objekt ještě má.',grace:'Chráněné ochrannou lhůtou po posledním nahrání nebo odkazu.',unsupported:'Tenhle host neumí LFS objekty mazat přes API.'};
const HOST_ERRORS={auth:'Host token odmítl.','missing-scope':'Token nemá oprávnění ke čtení repozitářů (u Gitea a Forgejo repository: Read). Token nejde upravit: vytvoř nový a vlož ho přes Upravit.',forbidden:'Token na to nemá oprávnění.','not-found':'Repozitář nenalezen.',network:'Host není dosažitelný.',timeout:'Vypršel čas.','git-failed':'Git skončil chybou.','scan-failed':'Sken neproběhl celý.','token-missing':'Chybí token.','git-missing':'Chybí git.','provider-missing':'Chybí plugin hostu.','rate-limited':'Host omezil požadavky.'};
export function bytes(n){
 if(!Number.isFinite(n))return '—';
 const u=['B','KB','MB','GB','TB'];let i=0,v=n;while(v>=1024&&i<u.length-1){v/=1024;i++;}
 return `${new Intl.NumberFormat(locale(),{maximumFractionDigits:v<10&&i?1:0}).format(v)} ${u[i]}`;
}
const day=iso=>iso&&Number.isFinite(Date.parse(iso))?new Intl.DateTimeFormat(locale(),{day:'numeric',month:'numeric',year:'numeric',timeZone:timeZone()}).format(new Date(iso)):'—';
// How long ago, in whole days/months/years: "3 months ago". Ages a deletion candidate at a glance.
export function age(iso,now=Date.now()){
 const ms=now-Date.parse(iso);if(!Number.isFinite(ms))return '';
 const d=Math.max(0,Math.floor(ms/86400000));
 if(d<1)return t('dnes');if(d<45)return tp(d,'před {n} dnem|před {n} dny|před {n} dny');
 const m=Math.round(d/30.44);if(m<18)return tp(m,'před {n} měsícem|před {n} měsíci|před {n} měsíci');
 return tp(Math.round(d/365.25),'před {n} rokem|před {n} lety|před {n} lety');
}
const when=iso=>iso&&Number.isFinite(Date.parse(iso))?new Intl.DateTimeFormat(locale(),{day:'numeric',month:'numeric',year:'numeric',hour:'2-digit',minute:'2-digit',timeZone:timeZone()}).format(new Date(iso)):'—';
// One row = one object in one repository of one connection (two connections may hold the same repository).
const key=i=>`${i.connection} ${i.repo} ${i.oid}`;
// "On main" when the repository's default branch is known.
const statusLabel=(i,label)=>i.status==='current'&&i.defaultBranch?t('Na {branch}',{branch:i.defaultBranch}):t(label);
const short=sha=>sha?sha.slice(0,8):'';
const refName=r=>String(r).replace(/^refs\/heads\//,'').replace(/^refs\/tags\//,'tag ');
async function getJson(url){const lost=authGuard(),r=await fetch(url);lost(r);const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error?.message?t(d.error.message):t('Požadavek selhal.'));return d;}
async function post(url,body){const lost=authGuard(),r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});lost(r);
 const d=await r.json().catch(()=>({}));if(!r.ok)throw Object.assign(new Error([d.error?.message?t(d.error.message):t('Požadavek selhal.'),...(Array.isArray(d.error?.details)?d.error.details:[])].join(' ')),{code:d.error?.code});return d;}
// MB as typed → bytes for the query; '' = no bound.
export const sizeBound=v=>{const s=String(v??'').trim().replace(',','.');if(!s)return '';const n=Number(s);return Number.isFinite(n)&&n>=0?String(Math.round(n*1048576)):null;};

export function gitLfsPage({me}={}){
 if(!stylesheet){document.head.append(el('link',{rel:'stylesheet',href:'/git-lfs.css'}));stylesheet=true;}
 const canManage=me?.role==='admin'||hasScope(WRITE);
 const state={overview:null,page:null,offset:0,limit:50,selected:new Map(),timer:null,alive:true};
 const header=pageHeader({eyebrow:t('Inventář'),title:t('Git LFS'),
  lead:t('Velké soubory v Git LFS na připojených git hostech: kde se který používá, kolik místa zabírá a co už nepotřebuje žádný commit.'),
  actions:[{label:t('Obnovit'),onclick:()=>refresh()},...(canManage?[{label:t('Přidat připojení'),primary:true,onclick:()=>wizard(null)}]:[])]});
 const top=el('div',{}),conns=el('section',{class:'gl-conns'}),sums=el('div',{class:'gl-sums'}),controls=el('div',{class:'gl-filters'}),table=el('div',{class:'gl-table-wrap'}),pager=el('div',{class:'gl-pager'}),bulk=el('div',{class:'gl-bulk'});
 const root=el('div',{class:'gl-page'},header,top,conns,el('section',{class:'gl-catalog'},sums,controls,bulk,table,pager),
  el('p',{class:'gl-hint'},t('Smazat jde jen objekt, na který neukazuje žádný commit dosažitelný z větve nebo tagu, po ochranné lhůtě a jen na hostu, který mazání umí. Před smazáním hub repozitář znovu naskenuje. Objekty z historie hub nemaže: to by vyžadovalo přepsání historie.')));
 onLeave(()=>{state.alive=false;clearTimeout(state.timer);});

 // --- filters ---------------------------------------------------------------------------------------
 const q=el('input',{type:'search',placeholder:t('Hledat cestu, ref, repozitář nebo oid…'),'aria-label':t('Hledat')});
 const conn=el('select',{'aria-label':t('Připojení')}),repo=el('select',{'aria-label':t('Repozitář')}),ext=el('select',{'aria-label':t('Přípona')});
 const status=el('select',{'aria-label':t('Stav')},[['all','Všechny stavy'],['current','Na výchozí větvi'],['branch','Na jiné větvi'],['history','Jen ve starých commitech'],['orphaned','Nepoužívané']].map(([v,l])=>el('option',{value:v},t(l))));
 const minS=el('input',{type:'text',inputmode:'decimal',placeholder:t('od MB'),'aria-label':t('Nejmenší velikost v MB'),class:'gl-size'}),maxS=el('input',{type:'text',inputmode:'decimal',placeholder:t('do MB'),'aria-label':t('Největší velikost v MB'),class:'gl-size'});
 const sort=el('select',{'aria-label':t('Řadit')},[['size','Velikost'],['path','Cesta'],['repo','Repozitář'],['status','Stav'],['commit','Commit'],['oid','Oid']].map(([v,l])=>el('option',{value:v},t(l))));
 const dir=el('select',{'aria-label':t('Směr řazení')},el('option',{value:'desc'},t('sestupně')),el('option',{value:'asc'},t('vzestupně')));
 let debounce;
 for(const x of [conn,repo,ext,status,sort,dir])x.addEventListener('change',()=>{state.offset=0;if(x===conn)repo.value='';load();});
 for(const x of [q,minS,maxS])x.addEventListener('input',()=>{clearTimeout(debounce);debounce=setTimeout(()=>{state.offset=0;load();},250);});
 controls.append(q,conn,repo,ext,status,el('span',{class:'gl-range'},minS,'–',maxS),sort,dir);

 const params=()=>{
  const p=new URLSearchParams({offset:String(state.offset),limit:String(state.limit),sort:sort.value,dir:dir.value});
  if(q.value.trim())p.set('q',q.value.trim());if(conn.value)p.set('connection',conn.value);if(repo.value)p.set('repo',repo.value);
  if(ext.value)p.set('ext',ext.value);if(status.value!=='all')p.set('status',status.value);
  const a=sizeBound(minS.value),b=sizeBound(maxS.value);if(a)p.set('minSize',a);if(b)p.set('maxSize',b);
  minS.classList.toggle('bad',a===null);maxS.classList.toggle('bad',b===null);
  return p;
 };
 const filterBody=()=>{const p=params(),f={};for(const k of ['q','ext','minSize','maxSize'])if(p.get(k))f[k]=p.get(k);return f;};

 // --- data ------------------------------------------------------------------------------------------
 async function loadOverview(){
  try{state.overview=await getJson('/api/git-lfs');}catch(e){if(!state.alive)return;put(top,errorState({title:t('Git LFS se nepodařilo načíst'),body:e.message,retry:()=>loadOverview()}));return;}
  if(!state.alive)return;paintOverview();await load();
 }
 async function load(){
  if(!state.overview||state.overview.disabled||!state.overview.connections?.length)return;
  const p=params();if(minS.classList.contains('bad')||maxS.classList.contains('bad'))return;
  try{state.page=await getJson('/api/git-lfs/objects?'+p);}catch(e){if(state.alive)put(table,errorState({compact:true,title:t('Seznam se nepodařilo načíst'),body:e.message,retry:()=>load()}));return;}
  if(state.alive)paintPage();
 }
 function schedule(){clearTimeout(state.timer);if(!state.alive)return;const busy=state.overview?.connections?.some(c=>c.scan.running);state.timer=setTimeout(()=>{if(document.hidden)return schedule();loadOverview().finally(schedule);},busy?3000:60000);}
 async function refresh(connection){
  try{const d=await post('/api/git-lfs/refresh',connection?{connection}:{});
   toast(d.started.length?t('Sken začal.'):t('Sken už běží nebo proběhl před chvílí.'));}
  catch(e){toast(e.message,{tone:'bad'});}
  await loadOverview();schedule();
 }
 function wizard(connection){openWizard({providers:state.overview?.providers||[],connection,onSaved:()=>{toast(t('Připojení je uložené. Repozitáře se skenují.'),{tone:'good'});loadOverview().then(schedule);}});}

 // --- connections -----------------------------------------------------------------------------------
 function paintOverview(){
  const o=state.overview;
  if(o.disabled){put(top,disabledNotice(o.disabled));put(conns);put(sums);controls.hidden=true;put(table);put(pager);put(bulk);return;}
  controls.hidden=false;
  put(top,...(o.git&&!o.git.ok?[notInstalled({dependency:'git',installUrl:'https://git-scm.com/downloads',optional:false,title:t('Na serveru hubu chybí git'),
   body:t('Hub čte repozitáře gitem (částečný mirror bez velkých souborů). Nic neinstaluje: nainstaluj git na stroji, kde hub běží, a restartuj ho.')})]:[]));
  if(!o.connections.length){
   put(conns,emptyState({icon:'archive',title:t('Žádné připojení ke git hostu'),
    body:t('Připoj GitHub, GitHub Enterprise, Gitea nebo Forgejo tokenem jen pro čtení. Hub naskenuje vybrané repozitáře a ukáže, kde se který LFS soubor používá.'),
    steps:[t('Vytvoř na hostu token jen pro čtení repozitářů.'),t('Přidej připojení a otestuj ho.'),t('Vyber repozitáře.')],
    actions:canManage?[{label:t('Přidat připojení'),primary:true,onclick:()=>wizard(null)}]:[]}),
    canManage?null:el('p',{class:'gl-hint'},t('Připojení přidává účet s oprávněním Git LFS – správa a mazání.')),
    tokenGuides(o.providers||[]));
   put(sums);controls.hidden=true;put(table);put(pager);put(bulk);return;
  }
  put(conns,...o.connections.map(connCard));
  const keep=[conn.value,repo.value];
  put(conn,el('option',{value:''},t('Všechna připojení')),...o.connections.map(c=>el('option',{value:c.id},c.name)));
  const repos=o.connections.filter(c=>!keep[0]||c.id===keep[0]).flatMap(c=>c.scan.repos.map(r=>r.fullName));
  put(repo,el('option',{value:''},t('Všechny repozitáře')),...[...new Set(repos)].sort().map(r=>el('option',{value:r},r)));
  conn.value=o.connections.some(c=>c.id===keep[0])?keep[0]:'';repo.value=repos.includes(keep[1])?keep[1]:'';
 }
 // Where the files live, as the inventory has it: the host's machine and, when it keeps LFS elsewhere, the store's.
 function placementLine(pl){
  if(!pl?.service)return null;
  // An administrator follows the machine to its page under Integrations → Machines.
  const m=x=>{const name=el('strong',{},x.machineName||x.machine||t('neznámý stroj'));
   return x.machine&&me?.role==='admin'?el('a',{href:`#integrations/machine/${encodeURIComponent(x.machine)}`,title:t('Integrace stroje')},name):name;};
  return el('p',{class:'gl-conn-place'},t('Běží na'),' ',m(pl.service),
   pl.storage?[' · ',t('LFS soubory leží na'),' ',m(pl.storage),el('span',{class:'gl-hint'},' (',pl.storage.name,')')]:[' · ',t('LFS soubory u hostu')],
   el('span',{class:'gl-hint'},' · ',t('podle inventáře')));
 }
 function connCard(c){
  const s=c.scan,failed=s.repos.filter(r=>r.state!=='ok');
  const pill=s.running?statusPill(t('Skenuje se'),'info'):s.error?statusPill(t('Sken selhal'),'bad'):failed.length?statusPill(tp(failed.length,'{n} repozitář s chybou|{n} repozitáře s chybou|{n} repozitářů s chybou'),'warn'):s.finishedAt?statusPill(t('Naskenováno'),'good'):statusPill(t('Čeká na první sken'),'');
  const caps=c.capabilities||{};
  const details=el('details',{class:'gl-conn-more'},el('summary',{},t('Repozitáře a schopnosti')),
   capabilityList(caps),
   el('ul',{class:'gl-repos'},s.repos.map(r=>el('li',{},el('a',{href:r.url||'#',target:'_blank',rel:'noopener noreferrer',class:'gl-mono'},r.fullName),' ',
    r.state==='ok'?el('span',{class:'gl-hint'},tp(r.objects,'{n} objekt|{n} objekty|{n} objektů')+' · '+bytes(r.bytes)+' · '+when(r.scannedAt)+(r.storedCheck==='partial'?' · '+t('uložení ověřeno jen částečně'):r.storedCheck==='failed'?' · '+t('uložení neověřeno'):'')):
    el('span',{class:'gl-bad'},t(HOST_ERRORS[r.error]||'Sken selhal.'),' ',r.error?el('code',{},r.error):null)))),
   s.truncated?el('p',{class:'gl-warn'},t('Token vidí víc než 200 repozitářů; skenuje se prvních 200.')):null);
  return el('article',{class:'gl-conn'},
   el('div',{class:'gl-conn-head'},el('div',{},el('h3',{},c.name),el('p',{class:'gl-hint'},c.providerTitle,' · ',el('span',{class:'gl-mono'},c.web||c.baseUrl),c.login?' · '+t('jako {login}',{login:c.login}):'')),pill),
   el('p',{class:'gl-conn-line'},
    caps.deleteObjects?statusPill(t('umí mazat'),'good'):statusPill(t('jen čtení'),'plain'),' ',
    c.plainHttp?statusPill(t('http bez šifrování'),'warn'):null,' ',
    !c.tokenSet?statusPill(t('chybí token'),'bad'):null,' ',
    el('span',{class:'gl-hint'},c.repoMode==='all'?t('všechny repozitáře tokenu'):c.repoMode==='owner'?t('vlastník {owner}',{owner:c.owner}):tp(c.repos.length,'{n} vybraný repozitář|{n} vybrané repozitáře|{n} vybraných repozitářů'),' · ',
     s.finishedAt?t('naposledy {at}',{at:when(s.finishedAt)}):t('zatím neskenováno'))),
   s.error?el('p',{class:'gl-bad'},t(HOST_ERRORS[s.error]||'Sken selhal.'),' ',el('code',{},s.error)):null,
   placementLine(c.placement),
   details,
   el('div',{class:'gl-row'},el('button',{type:'button',class:'ui-button small',onclick:()=>refresh(c.id),disabled:s.running?'':undefined},t('Skenovat')),
    canManage?el('button',{type:'button',class:'ui-button small',onclick:()=>wizard(c)},t('Upravit')):null,
    canManage?el('button',{type:'button',class:'ui-button small danger',onclick:()=>removeConnection(c)},t('Odebrat')):null));
 }
 function removeConnection(c){
  confirmDialog({title:t('Odebrat připojení {name}?',{name:c.name}),body:t('Hub zapomene token, katalog a své mirrory repozitářů. Na hostu se nic nezmění.'),confirm:t('Odebrat'),
   action:async()=>{await post('/api/git-lfs/connections/remove',{id:c.id});toast(t('Připojení odebráno.'));await loadOverview();}});
 }

 // --- the catalog -------------------------------------------------------------------------------------
 function paintPage(){
  const d=state.page,tot=d.totals,f=d.filtered;
  const stat=(k,v,sub,tone='')=>el('div',{class:`gl-stat ${tone}`},el('div',{class:'k'},k),el('div',{class:'v'},v),sub?el('div',{class:'s'},sub):null);
  put(sums,
   stat(t('Objektů'),new Intl.NumberFormat(locale()).format(tot.count),bytes(tot.bytes)),
   stat(t('Na výchozí větvi'),String(tot.byStatus.current.count),bytes(tot.byStatus.current.bytes)),
   stat(t('Na jiné větvi'),String(tot.byStatus.branch?.count??0),bytes(tot.byStatus.branch?.bytes??0)),
   stat(t('Jen ve starých commitech'),String(tot.byStatus.history.count),bytes(tot.byStatus.history.bytes)),
   stat(t('Nepoužívané'),String(tot.byStatus.orphaned.count),bytes(tot.byStatus.orphaned.bytes),tot.byStatus.orphaned.count?'warn':''),
   stat(t('Uvolnitelné'),bytes(tot.reclaimableBytes),tp(tot.reclaimableCount,'{n} objekt po ochranné lhůtě|{n} objekty po ochranné lhůtě|{n} objektů po ochranné lhůtě'),tot.reclaimableCount?'good':''),
   stat(t('Vyfiltrováno'),String(f.count),bytes(f.bytes)+' · '+t('uvolnitelné {b}',{b:bytes(f.reclaimableBytes)})));
  const keepExt=ext.value;
  put(ext,el('option',{value:''},t('Všechny přípony')),...d.extensions.map(x=>el('option',{value:x.ext||'-'},(x.ext?'.'+x.ext:t('bez přípony'))+' · '+x.count)));
  ext.value=[...ext.options].some(o=>o.value===keepExt)?keepExt:'';
  for(const k of [...state.selected.keys()])if(!d.items.some(i=>key(i)===k))state.selected.delete(k);
  if(!d.items.length){put(table,emptyState({compact:true,icon:'search',title:t('Nic neodpovídá'),body:state.overview.connections.some(c=>c.scan.running||!c.scan.finishedAt)?t('Repozitáře se ještě skenují.'):t('Žádný LFS objekt neodpovídá filtrům.')}));}
  else put(table,el('table',{class:'gl-table'},
   el('thead',{},el('tr',{},el('th',{scope:'col',class:'gl-pick'},el('span',{class:'ui-sr'},t('Vybrat'))),
    ...[['Soubor','path'],['Repozitář','repo'],['Velikost','size'],['Stav','status'],['Kde',null],['Commit','commit'],['',null]].map(([h,k])=>headCell(h,k)))),
   el('tbody',{},d.items.map(row))));
  const from=d.total?d.offset+1:0,to=Math.min(d.offset+d.items.length,d.total);
  const prev=el('button',{type:'button',class:'ui-button small',onclick:()=>{state.offset=Math.max(0,state.offset-state.limit);load();}},'← '+t('Předchozí')),next=el('button',{type:'button',class:'ui-button small',onclick:()=>{state.offset+=state.limit;load();}},t('Další')+' →');
  prev.disabled=d.offset===0;next.disabled=to>=d.total;
  put(pager,prev,el('span',{class:'gl-hint'},t('{from}–{to} z {total}',{from,to,total:d.total})),next);
  paintBulk();
 }
 // A sortable column: click sorts by it; a second click turns the direction. The selects stay in step.
 function headCell(h,k){
  if(!k)return el('th',{scope:'col'},h?t(h):'');
  const on=sort.value===k,arrow=on?(dir.value==='asc'?' ↑':' ↓'):'';
  return el('th',{scope:'col','aria-sort':on?(dir.value==='asc'?'ascending':'descending'):'none'},
   el('button',{type:'button',class:`gl-sort${on?' on':''}`,onclick:()=>{if(on)dir.value=dir.value==='asc'?'desc':'asc';else{sort.value=k;dir.value=k==='size'||k==='commit'?'desc':'asc';}state.offset=0;load();}},t(h),arrow));
 }
 function row(i){
  const [label,tone,why]=STATUS[i.status]||STATUS.history;
  const file=i.currentPaths[0]||i.paths[0]||null;
  const pick=el('input',{type:'checkbox','aria-label':t('Vybrat {oid}',{oid:short(i.oid)}),onchange:()=>{pick.checked?state.selected.set(key(i),i):state.selected.delete(key(i));paintBulk();}});
  pick.checked=state.selected.has(key(i));pick.disabled=!canManage||!i.canDelete;if(pick.disabled)pick.title=t(BLOCKED[i.deleteBlocked]||'Smazat nejde.');
  const where=i.status==='orphaned'?el('span',{class:'gl-hint'},i.remembered?t('dřív: {commit}',{commit:short(i.lastCommit?.sha)}):t('žádný ref'),' · ',t('nepoužívaný od {at}',{at:when(i.unreferencedSince)}))
   :el('span',{},i.refs.slice(0,3).map(r=>el('span',{class:'gl-ref'},refName(r))),i.refCount>3?el('span',{class:'gl-hint'},' +'+(i.refCount-3)):null);
  return el('tr',{class:i.status},
   el('td',{class:'gl-pick'},pick),
   el('td',{'data-label':t('Soubor')},el('div',{class:'gl-file'},el('strong',{},file?file.split('/').pop():t('Neznámá cesta')),el('span',{class:'gl-mono gl-path'},file||short(i.oid)+'…'),
    i.pathCount>1?el('span',{class:'gl-hint'},tp(i.pathCount-1,'+ {n} další cesta|+ {n} další cesty|+ {n} dalších cest')):null)),
   el('td',{'data-label':t('Repozitář')},el('span',{class:'gl-mono'},i.repo)),
   el('td',{'data-label':t('Velikost'),class:'gl-num'},bytes(i.size)),
   el('td',{'data-label':t('Stav')},el('span',{title:t(why)},statusPill(statusLabel(i,label),tone)),i.stored===false?el('span',{class:'gl-bad'},' '+t('na hostu chybí')):null),
   el('td',{'data-label':t('Kde')},where),
   el('td',{'data-label':t('Commit'),title:t('Datum posledního commitu, který objekt přidal nebo změnil')},i.lastCommit?[el('span',{},day(i.lastCommit.at)),el('span',{class:'gl-hint gl-mono'},' '+short(i.lastCommit.sha)),el('div',{class:'gl-hint'},age(i.lastCommit.at))]:el('span',{class:'gl-hint'},'—')),
   el('td',{},el('button',{type:'button',class:'ui-button small quiet',onclick:()=>detail(i)},t('Detail'))));
 }
 function paintBulk(){
  if(!canManage||!state.page){put(bulk);return;}
  const sel=[...state.selected.values()],orph=state.page.filtered.reclaimableCount;
  const anyDelete=state.overview.connections.some(c=>c.capabilities?.deleteObjects);
  put(bulk,
   el('span',{class:'gl-hint'},sel.length?tp(sel.length,'{n} vybraný objekt|{n} vybrané objekty|{n} vybraných objektů')+' · '+bytes(sel.reduce((n,i)=>n+(i.size||0),0)):anyDelete?t('Vyber nepoužívané objekty k smazání, nebo smaž všechny odpovídající filtrům.'):t('Žádný připojený host neumí LFS objekty mazat přes API; u nepoužívaných objektů je odkaz, kde je smazat ručně.')),
   el('button',{type:'button',class:'ui-button small danger',disabled:sel.length?undefined:'',onclick:()=>previewDelete({items:sel})},t('Smazat vybrané…')),
   anyDelete?el('button',{type:'button',class:'ui-button small danger',disabled:orph?undefined:'',onclick:()=>previewDelete({filter:true})},t('Smazat všechny odpovídající nepoužívané…')):null);
 }
 function detail(i){
  const [label,tone,why]=STATUS[i.status]||STATUS.history;
  const commitLink=c=>c?el('span',{},i.repoUrl?el('a',{href:`${i.repoUrl}/commit/${c.sha}`,target:'_blank',rel:'noopener noreferrer',class:'gl-mono'},short(c.sha)):el('span',{class:'gl-mono'},short(c.sha)),' · ',when(c.at)):'—';
  const dl=(k,v)=>[el('dt',{},k),el('dd',{},v)];
  // The LFS store is per host (Forgejo and Gitea have one [lfs] storage per instance), so it comes from the connection.
  const pl=state.overview?.connections?.find(c=>c.id===i.connection)?.placement,mn=x=>x.machineName||x.machine||t('neznámý stroj');
  const place=pl?.storage?`${mn(pl.storage)} · ${pl.storage.name}`:pl?.service?`${mn(pl.service)} · ${t('u hostu')}`:null;
  const d=el('dialog',{class:'gl-dialog','aria-labelledby':'gl-detail-title'},
   el('div',{class:'gl-dialog-head'},el('div',{},el('h2',{id:'gl-detail-title'},(i.currentPaths[0]||i.paths[0]||t('LFS objekt')).split('/').pop()),el('p',{class:'gl-hint gl-mono'},i.repo)),
    el('button',{type:'button',class:'gl-close','aria-label':t('Zavřít'),onclick:()=>d.close()},'×')),
   el('div',{class:'gl-dialog-body'},
    el('p',{},statusPill(statusLabel(i,label),tone),' ',t(why)),
    el('dl',{class:'gl-dl'},
     ...dl(t('Oid (sha256)'),el('code',{class:'gl-mono gl-wrap'},i.oid)),
     ...dl(t('Velikost'),bytes(i.size)),
     ...dl(t('Na hostu'),i.stored===true?t('uložený (ověřeno)'):i.stored===false?t('chybí'):t('neověřeno')),
     ...dl(t('Výchozí větev'),i.currentPaths.length?i.currentPaths.join(', '):t('ne')),
     ...dl(t('Refy s ním na špičce'),i.refs.length?i.refs.map(refName).join(', ')+(i.refCount>i.refs.length?' …':''):t('žádné')),
     ...dl(t('Poprvé v commitu'),commitLink(i.firstCommit)),
     ...dl(t('Naposledy v commitu'),commitLink(i.lastCommit)),
     ...dl(t('Commitů, které ho přidaly nebo změnily'),String(i.commits||0)),
     ...dl(t('Hub ho poprvé viděl'),when(i.firstSeenAt)),
     ...dl(t('Naposledy viděn při skenu'),el('span',{},when(i.lastSeenAt),el('span',{class:'gl-hint'},' · ',t('kdy ho hub naposledy našel při skenu repozitáře')))),
     ...(place?dl(t('Uložený na'),place):[]),
     ...(i.status==='orphaned'?dl(t('Nepoužívaný od'),when(i.unreferencedSince)):[])),
    el('h3',{},i.remembered?t('Cesty, kde byl naposledy'):t('Cesty')),
    i.paths.length?el('ul',{class:'gl-paths'},i.paths.map(p=>el('li',{class:'gl-mono'},p,i.currentPaths.includes(p)?el('span',{class:'gl-hint'},' · '+t('výchozí větev')):null))):el('p',{class:'gl-hint'},t('Cesta není známá: hub objekt viděl jen jako pointer bez commitu.')),
    i.pathCount>i.paths.length?el('p',{class:'gl-hint'},t('… a další ({n} celkem).',{n:i.pathCount})):null,
    i.deleteBlocked&&i.status==='orphaned'?el('p',{class:'gl-note'},t(BLOCKED[i.deleteBlocked]||'')):null,
    i.status==='history'||i.status==='branch'?el('p',{class:'gl-note'},t('Objekt potřebuje historie repozitáře. Hub ho nesmaže: uvolnit by ho šlo jen přepsáním historie (například git filter-repo) a vynuceným pushem, což mění commity všem, kdo repozitář mají.')):null,
    i.manual?el('p',{class:'gl-note'},t(i.manual.text),' ',i.manual.url?el('a',{href:i.manual.url,target:'_blank',rel:'noopener noreferrer'},t('Otevřít na hostu ↗')):null):null));
  d.addEventListener('close',()=>d.remove());document.body.append(d);d.showModal();
 }

 // --- deletion ------------------------------------------------------------------------------------------
 async function previewDelete({items,filter}){
  let groups=[];
  try{
   if(filter){const f=filterBody();const d=await post('/api/git-lfs/delete/preview',{...(conn.value?{connection:conn.value}:{}),...(repo.value?{repo:repo.value}:{}),filter:f});groups=d.groups;}
   else{
    const by=new Map();for(const i of items){const k=i.connection+' '+i.repo;if(!by.has(k))by.set(k,{connection:i.connection,repo:i.repo,oids:[]});by.get(k).oids.push(i.oid);}
    for(const g of by.values())groups.push(...(await post('/api/git-lfs/delete/preview',g)).groups);
   }
  }catch(e){toast(e.message,{tone:'bad'});return;}
  const eligible=groups.flatMap(g=>g.canDelete?g.eligible.map(e=>({...e,group:g})):[]),refused=groups.flatMap(g=>g.refused.map(r=>({...r,group:g})));
  const total=eligible.reduce((n,e)=>n+(e.size||0),0);
  const body=el('div',{},
   eligible.length?el('p',{},tp(eligible.length,'Smaže se {n} nepoužívaný LFS objekt|Smažou se {n} nepoužívané LFS objekty|Smaže se {n} nepoužívaných LFS objektů'),' · ',el('strong',{},bytes(total))):el('p',{},t('Nic z výběru teď smazat nejde.')),
   eligible.length?el('div',{class:'gl-preview'},el('table',{class:'gl-table'},el('thead',{},el('tr',{},[t('Repozitář'),t('Oid'),t('Velikost'),t('Byl v')].map(h=>el('th',{scope:'col'},h)))),
    el('tbody',{},eligible.slice(0,200).map(e=>el('tr',{},el('td',{class:'gl-mono'},e.group.repo),el('td',{class:'gl-mono'},short(e.oid)),el('td',{class:'gl-num'},bytes(e.size)),el('td',{class:'gl-mono gl-path'},e.paths[0]||'—')))))):null,
   eligible.length>200?el('p',{class:'gl-hint'},t('… a {n} dalších.',{n:eligible.length-200})):null,
   refused.length?el('details',{},el('summary',{},tp(refused.length,'{n} objekt se nesmaže|{n} objekty se nesmažou|{n} objektů se nesmaže')),
    el('ul',{},refused.slice(0,100).map(r=>el('li',{},el('span',{class:'gl-mono'},short(r.oid)),' ',t(r.message||BLOCKED[r.reason]||r.reason))))):null,
   ...groups.filter(g=>!g.canDelete&&g.manual).map(g=>el('p',{class:'gl-note'},g.repo+': ',t(g.manual.text),' ',g.manual.url?el('a',{href:g.manual.url,target:'_blank',rel:'noopener noreferrer'},t('Otevřít na hostu ↗')):null)),
   el('p',{class:'gl-note'},t('Před smazáním hub každý repozitář znovu naskenuje. Když se mezitím změnily refy nebo uložené objekty, nesmaže nic a požádá o nový náhled. Smazání nejde vrátit.')));
  confirmDialog({title:t('Smazat nepoužívané LFS objekty?'),body,confirm:t('Smazat natrvalo'),danger:true,disabled:!eligible.length,
   action:async()=>{
    let deleted=0,bytesGone=0;const problems=[];
    for(const g of groups.filter(x=>x.canDelete&&x.eligible.length)){
     try{const r=await post('/api/git-lfs/delete',{connection:g.connection,repo:g.repo,oids:g.eligible.map(e=>e.oid),revision:g.revision,requestId:crypto.randomUUID()});
      deleted+=r.deleted.length;bytesGone+=r.bytes;if(r.refused.length||r.failed.length)problems.push(t('{repo}: {n} nesmazáno',{repo:g.repo,n:r.refused.length+r.failed.length}));if(r.stoppedMessage)problems.push(t(r.stoppedMessage));}
     catch(e){problems.push(g.repo+': '+e.message);}
    }
    state.selected.clear();
    toast(t('Smazáno {n} objektů ({b}).',{n:deleted,b:bytes(bytesGone)})+(problems.length?' '+problems.join(' · '):''),{tone:problems.length?'warn':'good',timeout:problems.length?12000:5000});
    await loadOverview();
   }});
 }
 function confirmDialog({title,body,confirm,danger=false,disabled=false,action}){
  const msg=el('p',{class:'gl-bad',role:'alert'});
  const yes=el('button',{type:'button',class:`ui-button ${danger?'danger':'primary'}`,disabled:disabled?'':undefined,onclick:async()=>{yes.disabled=true;msg.textContent='';
   try{await action();d.close();}catch(e){msg.textContent=e.message;yes.disabled=false;}}},confirm);
  const d=el('dialog',{class:'gl-dialog small','aria-labelledby':'gl-confirm-title'},
   el('div',{class:'gl-dialog-head'},el('h2',{id:'gl-confirm-title'},title),el('button',{type:'button',class:'gl-close','aria-label':t('Zavřít'),onclick:()=>d.close()},'×')),
   el('div',{class:'gl-dialog-body'},typeof body==='string'?el('p',{},body):body,msg),
   el('div',{class:'gl-dialog-foot'},el('span',{}),el('div',{class:'gl-row'},el('button',{type:'button',class:'ui-button',onclick:()=>d.close()},t('Zrušit')),yes)));
  d.addEventListener('close',()=>d.remove());document.body.append(d);d.showModal();
 }

 put(top,loadingState(t('Načítám Git LFS…')));
 loadOverview().then(schedule);
 return root;
}
