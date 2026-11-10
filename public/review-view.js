// Review: variants an agent proposed for a project, compared and decided here (docs/review.md).
//   #review               sets of all projects: open (undecided), done (every item taken), archive
//   #review/<project>     open sets of one project (the Review button on a project card)
//   #review/R-<n>         one set: rounds, a tab per kind, one row of variants per item, pins and the decision
// Variants of an item are compared side by side, one at a time (the default on a phone), or, for images, by
// dragging a divider across two of them (swipe). A bar on top counts the decisions and jumps to the next open item.
// 3D models (.glb) open in Google <model-viewer> (public/vendor/, loaded only when a set has a model item): orbit,
// zoom, animations, a pin on the surface remembers the camera pose; cameras of A/B/C can move together.
// HTML mockups run in a sandboxed frame (opaque origin, no network). A helper the server injects reports hover,
// clicks and scroll by postMessage; pins are drawn here, over the frame. Saving is automatic, one request guarded
// by rev at a time: picking a variant saves, a comment or the note saves when its box loses focus. "None of
// these" opens the note for what to redo; it takes links and screenshots (pasted or picked, uploaded as review blobs).
// Text: Czech source strings through t() (English in i18n-en-review.js); dates follow the active language and
// the site's time zone.
import {el,onLeave} from './views.js';
import {onSessionReset,authGuard} from './session-cache.js';
import {timeZone} from './site.js';
import {t,tp,locale} from './i18n.js';
import {pageHeader,emptyState} from './ui.js';

// Label lists are functions: t() has to run when the page is drawn, in the language active then.
const KINDS=()=>({html:t('Mockupy'),image:t('Obrázky a rendery'),model:t('3D modely')});
const DECISIONS=()=>({accept:t('Beru'),revise:t('Beru s úpravami'),reject:t('Předělat'),pending:t('Nerozhodnuto')});
const DECISION_TONE={accept:'ok',revise:'info',reject:'crit',pending:'dim'};
// Items in "approve" mode: every variant is its own deliverable, approved or sent back with comments.
const APPROVE_TEXT=()=>({accept:t('Schváleno'),reject:t('Celé předělat'),pending:t('Čeká na schválení')});
const PROJECT_TYPES=()=>({app:t('Aplikace'),game:t('Hra'),other:t('Jiné')});
const MOCK_ID=/^[A-Za-z0-9_.:-]{1,80}$/,SET_ID=/^R-[1-9][0-9]{0,5}$/,PROJECT_ID=/^[a-z][a-z0-9-]{1,39}$/;
const when=iso=>iso&&Number.isFinite(Date.parse(iso))?new Intl.DateTimeFormat(locale(),{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',timeZone:timeZone()}).format(new Date(iso)):'—';
const fin=v=>typeof v==='number'&&Number.isFinite(v);
const blob=sha=>'/api/review/blobs/'+sha;
const initials=s=>s?s.split(/[\s._@-]+/).filter(Boolean).slice(0,2).map(w=>w[0].toUpperCase()).join(''):'';
const narrow=()=>{try{return globalThis.matchMedia?.('(max-width:700px)').matches===true;}catch{return false;}};
const SHOT_TYPES=['image/png','image/jpeg','image/webp','image/gif'],SHOT_MAX=20*1024*1024,CHUNK=8*1024*1024;
// Local previews of screenshots uploaded in this page load (the server serves a blob only once a decision references it).
const previews=new Map();
const shotUrl=a=>previews.get(a.sha256)||blob(a.sha256);
// The status of one item in a round, as the page counts it: pending until a decision was saved.
export const itemStatus=(round,item)=>round.feedback[item.id]?.rev?round.feedback[item.id].status:'pending';
// Per status, how many items of a round stand there, plus how many are decided at all.
export function roundProgress(round){
 const counts={accept:0,revise:0,reject:0,pending:0};for(const item of round.items)counts[itemStatus(round,item)]++;
 return {...counts,total:round.items.length,decided:round.items.length-counts.pending};
}
// Which later round answered each comment id (the first one that lists it in addresses).
export function answeredBy(rounds){
 const out=new Map();for(const r of rounds)for(const id of r.addresses||[])if(!out.has(id))out.set(id,r);
 return out;
}
// Uploads one image as a content-addressed review blob in ≤ 8 MiB chunks; returns the attachment.
async function uploadShot(file){
 if(!SHOT_TYPES.includes(file.type))throw new Error(t('Přiložit jde jen obrázek (PNG, JPEG, WebP, GIF).'));
 if(file.size>SHOT_MAX)throw new Error(t('Obrázek je větší než 20 MB.'));
 if(!crypto?.subtle)throw new Error(t('Prohlížeč tu nemůže spočítat otisk souboru (je potřeba HTTPS).'));
 const sha=[...new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer()))].map(b=>b.toString(16).padStart(2,'0')).join('');
 let offset=0;
 for(let tries=0;tries<50;tries++){
  const lost=authGuard(),r=await fetch(`/api/review/blobs/${sha}?offset=${offset}&size=${file.size}`,{method:'PUT',headers:{'Content-Type':'application/octet-stream'},body:file.slice(offset,offset+CHUNK)});lost(r);
  const d=await r.json().catch(()=>({}));
  if(r.status===409&&Number.isSafeInteger(d.received)){offset=d.received;continue;}
  if(!r.ok)throw new Error(d.error?.message?t(d.error.message):t('Nahrání selhalo.'));
  if(d.complete){previews.set(sha,URL.createObjectURL(file));return {sha256:sha,type:file.type,name:(file.name||'screenshot').slice(0,200)};}
  offset=d.received;
 }
 throw new Error(t('Nahrání se nedokončilo.'));
}
// Text with its http(s) links clickable; everything else stays text.
function linkified(text,cls='tk-text'){
 const out=el('p',{class:cls}),re=/https?:\/\/[^\s<>"']+/g;let at=0,m;
 while((m=re.exec(text))){out.append(text.slice(at,m.index));const url=m[0].replace(/[.,;:!?)]+$/,'');out.append(el('a',{href:url,target:'_blank',rel:'noopener noreferrer'},url));at=m.index+url.length;re.lastIndex=at;}
 out.append(text.slice(at));return out;
}
const shotList=(list,remove)=>list.length?el('div',{class:'rv-shots'},list.map((a,i)=>el('figure',{class:'rv-shot'},
 el('a',{href:shotUrl(a),target:'_blank',rel:'noopener noreferrer',title:a.name||'Screenshot'},el('img',{src:shotUrl(a),alt:a.name||'Screenshot',loading:'lazy'})),
 remove?el('button',{type:'button',class:'rv-shot-x',title:t('Odebrat'),'aria-label':t('Odebrat přílohu {n}',{n:i+1}),onclick:()=>remove(i)},'×'):null))):null;
// Path back to the project, the same as the tracker's project page: Projects / <project> / Review [/ R-n].
function crumbs(project,id,set){
 const sep=()=>el('span',{class:'tk-dim'},'/'),name=project?.name||id;
 return el('nav',{class:'tk-crumbs','aria-label':t('Drobečková navigace')},
  ...(id?[el('a',{href:'#projects'},t('Projekty')),sep(),el('a',{href:'#projects/'+id},name),sep()]:[]),
  set?el('a',{href:'#review'+(id?'/'+id:'')},'Review'):el('b',{},'Review'),
  ...(set?[sep(),el('b',{},set)]:[]));
}
// Segmented switch like the tracker's table / board.
function segmented(label,items,current,pick){
 return el('div',{class:'tk-view',role:'group','aria-label':label},items.map(([v,text])=>el('button',{type:'button',class:v===current?'on':'','aria-pressed':String(v===current),onclick:()=>{if(v!==current)pick(v);}},text)));
}

async function api(url,body){
 const lost=authGuard(),r=await fetch(url,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});lost(r);
 const data=await r.json().catch(()=>({}));
 // The server's messages are Czech source text too; t() translates the ones the dictionary knows.
 if(!r.ok){const e=new Error(data.error?.message?t(data.error.message):t('Požadavek selhal.'));e.status=r.status;throw e;}
 return data;
}
// Drafts and view choices survive re-renders within one page load and one sign-in.
const drafts=new Map(),views=new Map(),filters={status:'active'};
// Where the user came from, read from the previous hash: '' = the all-projects list (sidebar), otherwise null.
let previousHash='';
if(typeof addEventListener==='function')addEventListener('hashchange',e=>{try{previousHash=new URL(e.oldURL).hash;}catch{previousHash='';}});
const fromAllList=()=>previousHash==='#review';let sessionEpoch=0,draftSeq=0;
onSessionReset(()=>{sessionEpoch++;drafts.clear();views.clear();filters.status='active';});
const status=()=>el('p',{class:'acc-status',role:'status'});
const fail=(node,e)=>{node.textContent=e.message;node.classList.add('error');};
// Unsaved work: a comment with text that has not been sent yet (saving happens when its box loses focus).
const dirty=()=>[...drafts.values()].some(d=>d.drafts.some(x=>x.text.trim()));

export function reviewView(me,sub){
 const wrap=el('section',{class:'sec tk rv'},el('p',{class:'sec-dim',role:'status'},t('Načítám…')));
 const canWrite=me?.canWrite===true,epoch=sessionEpoch;
 const run=()=>(sub&&SET_ID.test(sub)?setPage(wrap,{canWrite,id:sub,epoch}):listPage(wrap,{canWrite,project:sub&&PROJECT_ID.test(sub)?sub:'',epoch}))
  .catch(e=>{if(epoch===sessionEpoch)wrap.replaceChildren(emptyState({icon:'⚠',title:e.status===404?t('Review neexistuje'):t('Review nejde načíst'),body:e.message,
   actions:[e.status===404?null:{label:t('Zkusit znovu'),primary:true,onclick:()=>{wrap.replaceChildren(el('p',{class:'sec-dim',role:'status'},t('Načítám…')));run();}},{label:`← ${t('Všechna review')}`,href:'#review'}]}));});
 run();
 return wrap;
}

// A mockup as a card cover: the sandboxed frame at its own viewport, scaled to the card, not clickable.
function frameCover(cover){
 const vp=cover.viewport||{width:1280,height:800},box=el('div',{class:'rv-cover rv-cover-frame','aria-hidden':'true'});
 const frame=el('iframe',{src:'/api/review/frame/'+cover.sha256,sandbox:'allow-scripts',referrerpolicy:'no-referrer',loading:'lazy',tabindex:'-1',title:''});
 frame.width=String(vp.width);frame.height=String(vp.height);box.append(frame);
 const fit=()=>{const w=box.clientWidth;if(!w)return;const s=Math.max(w/vp.width,box.clientHeight/vp.height);frame.style.transform=`scale(${s})`;};
 if(typeof ResizeObserver==='function')new ResizeObserver(()=>fit()).observe(box);
 return box;
}
// No review set on this hub yet: what Review is for and the two ways to publish, by script or through MCP.
function noSets(project,hasProjects){
 return emptyState({icon:'◇',title:t('Zatím tu není nic k posouzení'),
  body:t('Review je místo, kde agent ukáže varianty návrhu (HTML mockupy, obrázky, 3D modely) a ty mezi nimi vybereš, okomentuješ konkrétní místo a pošleš rozhodnutí zpět.'),
  steps:[hasProjects?t('Sady patří k projektu z Project Trackeru; ten už máš.'):t('Sady patří k projektu: nejdřív ho založ na stránce Projekty.'),
   t('Vytvoř servisní účet se scope review:write (Uživatelé a API → Servisní účty).'),
   t('Skriptem: popiš sadu v review.json a spusť HOME_HUB_URL=… HOME_HUB_TOKEN=hhk_… node scripts/review-push.mjs review.json.'),
   t('Nebo přes MCP: agent zavolá review_publish; malé HTML pošle rovnou, větší soubory nahraje předem.'),
   t('Rozhodnutí si agent přečte nástrojem review_get a publikuje další kolo.')],
  agentPrompt:t('Připoj se k mému Home Hubu přes MCP (příkaz níže; servisní účet potřebuje scope review:write). Připrav 2–3 varianty toho, co navrhuješ, jako samostatné HTML soubory (CSS a JS uvnitř, žádná síť, důležité prvky označ atributem data-mock-id) nebo jako obrázky. Publikuj je nástrojem review_publish: project{project} (id z tickets_list → projects), title a items[] s id, title, kind html|image|model a variantami a, b, c s media. Malé HTML pošli rovnou jako media {type:"text/html", html}; větší soubory nahraj předem skriptem scripts/review-push.mjs. Pošli mi odkaz #review/R-n. Až rozhodnu, přečti si rozhodnutí přes review_get, zapracuj je a publikuj další kolo se set a addresses.',{project:project?` "${project}"`:''}),
  mcpSnippet:true,
  actions:hasProjects?[]:[{label:`${t('Projekty')} →`,href:'#projects',primary:true}]});
}
// List ------------------------------------------------------------------------------------------
async function listPage(wrap,{canWrite,project,epoch}){
 const query=state=>new URLSearchParams({status:state,...(project?{project}:{})});
 const [data,meta]=await Promise.all([api('/api/review?'+query(filters.status)),api('/api/tickets?limit=1')]);if(epoch!==sessionEpoch||!wrap.isConnected)return;
 // An empty tab is not an empty hub: only when no set exists at all does the page explain how to publish one.
 let any=data.sets.length>0||filters.status==='all';
 if(!data.sets.length&&filters.status!=='all'){try{any=(await api('/api/review?'+query('all'))).sets.length>0;}catch{any=true;}if(epoch!==sessionEpoch||!wrap.isConnected)return;}
 const projects=new Map(meta.projects.map(p=>[p.id,p])),redraw=()=>listPage(wrap,{canWrite,project,epoch}).catch(e=>fail(msg,e)),msg=status(),kinds=KINDS();
 const title=pageHeader({eyebrow:'Project Tracker',title:'Review',lead:t('Varianty, které agenti navrhli: porovnej je, vyber a okomentuj. Rozhodnutí si agent přečte přes MCP.')});
 if(!any&&!data.sets.length)return wrap.replaceChildren(title,...(project?[el('div',{class:'tk-toolbar'},el('div',{class:'tk-toolbar-left'},crumbs(projects.get(project),project)))]:[]),noSets(project,meta.projects.length>0));
 const statusSwitch=segmented(t('Stav review'),[['active',t('Otevřená')],['done',t('Hotová')],['archived',t('Archiv')],['all',t('Vše')]],filters.status,v=>{filters.status=v;redraw();});
 // On hover a card shows a bin (archive) or, in the archive, a way back.
 const move=s=>canWrite?el('button',{type:'button',class:'rv-card-bin',title:s.status==='open'?t('Přesunout do archivu'):t('Vrátit z archivu'),'aria-label':s.status==='open'?t('Archivovat {id}',{id:s.id}):t('Vrátit {id} z archivu',{id:s.id}),
  onclick:async e=>{e.preventDefault();e.stopPropagation();const b=e.currentTarget;b.disabled=true;
   try{await api('/api/review/sets',{id:s.id,rev:s.rev,status:s.status==='open'?'archived':'open'});const c=b.closest('.rv-card-wrap');if(filters.status==='all')redraw();else{c?.remove();if(!wrap.querySelector('.rv-card-wrap'))redraw();}}
   catch(err){fail(msg,err.status===409?new Error(t('Review se mezitím změnilo. Seznam se načetl znovu.')):err);b.disabled=false;if(err.status===409)redraw();}}},s.status==='open'?'🗑':'↩'):null;
 const card=s=>el('div',{class:'rv-card-wrap'},move(s),el('a',{class:'acc-card rv-card',href:'#review/'+s.id},
  s.cover?.type==='text/html'?frameCover(s.cover):s.cover?el('img',{class:'rv-cover',src:blob(s.cover.sha256),alt:'',loading:'lazy'}):el('div',{class:'rv-cover rv-cover-none','aria-hidden':'true'},'◇'),
  el('div',{class:'rv-card-body'},
   el('div',{class:'rv-card-top'},el('b',{class:'tk-mono'},s.id),project?null:el('span',{class:'sec-dim'},projects.get(s.project)?.name||s.project),s.status==='open'&&s.done?el('span',{class:'sec-pill ok',title:t('Ke každé položce je vybraná varianta.')},t('hotovo')):null,
    s.feedbackPending?el('span',{class:'sec-pill warn',title:t('Rozhodnutí nebo připomínky čekají, až je agent zapracuje.')},t('čeká na agenta')):s.status==='open'&&s.round.decided<s.round.items?el('span',{class:'sec-pill info',title:t('Nové kolo čeká na tvoje rozhodnutí.')},t('k rozhodnutí')):null,
    s.status==='archived'?el('span',{class:'sec-pill dim'},t('archiv')):null),
   el('h3',{class:'rv-card-title'},s.title),
   el('div',{class:'sec-dim'},`${t('Kolo {n}',{n:s.round.n})} · ${tp(s.round.items,'{n} položka|{n} položky|{n} položek')} · ${t('rozhodnuto {done}/{total}',{done:s.round.decided,total:s.round.items})} · ${when(s.round.publishedAt)}`),
   el('div',{class:'rv-card-bar','aria-hidden':'true'},(()=>{const b=el('span',{});b.style.width=(s.round.items?s.round.decided/s.round.items*100:0)+'%';return b;})()),
   el('div',{class:'tk-labels'},s.round.kinds.map(k=>el('span',{class:'tk-label'},kinds[k]||k)),s.tickets.map(id=>el('span',{class:'tk-label'},id))))));
 const emptyTab={active:[t('Nic nečeká na rozhodnutí'),t('Všechny otevřené sady mají ke každé položce vybranou variantu. Hotové najdeš na kartě Hotová.')],done:[t('Zatím nic hotového'),t('Sada je hotová, když má každá její položka vybranou variantu.')],
  archived:[t('Archiv je prázdný'),t('Sem se přesouvají sady, které už nechceš mít mezi otevřenými.')]}[filters.status]||[t('Zatím žádné review'),''];
 wrap.replaceChildren(title,
  el('div',{class:'tk-toolbar'},el('div',{class:'tk-toolbar-left'},project?crumbs(projects.get(project),project):null,statusSwitch)),msg,
  data.sets.length?el('div',{class:'rv-cards'},data.sets.map(card)):el('div',{class:'tk-none'},el('h2',{},emptyTab[0]),emptyTab[1]?el('p',{class:'sec-dim'},emptyTab[1]):null));
}

// One set ---------------------------------------------------------------------------------------
async function setPage(wrap,{canWrite,id,epoch}){
 const fromAll=fromAllList(),[set,meta]=await Promise.all([api('/api/review/sets/'+id),api('/api/tickets?limit=1')]);if(epoch!==sessionEpoch||!wrap.isConnected)return;
 const guard=e=>{if(dirty()){e.preventDefault();e.returnValue='';}};
 addEventListener('beforeunload',guard);onLeave(()=>removeEventListener('beforeunload',guard));
 views.set(set.id,{...(views.get(set.id)||{}),fromAll});
 renderSet(wrap,{canWrite,epoch,meta},set);
}
function renderSet(wrap,ctx,set){
 const {canWrite,meta}=ctx,project=meta.projects.find(p=>p.id===set.project),view=views.get(set.id)||{};views.set(set.id,view);
 const latest=set.rounds[set.rounds.length-1],round=set.rounds.find(r=>r.n===view.round)||latest,readOnly=!canWrite||round!==latest||set.status!=='open';
 // Default tab: a game opens on its 3D models and renders, anything else on its mockups.
 const order=project?.type==='game'?['model','image','html']:['html','image','model'];
 const kinds=[...new Set(round.items.map(i=>i.kind))].sort((a,b)=>order.indexOf(a)-order.indexOf(b));
 const kind=kinds.includes(view.kind)?view.kind:kinds[0],kindNames=KINDS();
 const msg=status(),redraw=()=>renderSet(wrap,ctx,set);
 // A later round's addresses mark which comments of this round were answered, and by which round.
 const answeredIn=answeredBy(set.rounds.filter(r=>r.n>round.n)),answeredAny=answeredBy(set.rounds);
 const archive=canWrite?el('button',{type:'button',class:'acc-btn small',onclick:async e=>{const b=e.currentTarget;b.disabled=true;
   try{const saved=await api('/api/review/sets',{id:set.id,rev:set.rev,status:set.status==='open'?'archived':'open'});Object.assign(set,{status:saved.status,rev:saved.rev});redraw();}catch(err){fail(msg,err);b.disabled=false;}}},set.status==='open'?t('Archivovat'):t('Vrátit z archivu')):null;
 const head=el('div',{class:'tk-head'},
  // Path back the way the user came: from the sidebar list → Review / R-n, otherwise through the project.
  el('div',{},view.fromAll?crumbs(null,null,set.id):crumbs(project,set.project,set.id),
   el('h1',{class:'tk-title'},set.title),
   set.description?el('p',{class:'tk-text acc-dim'},set.description):null,
   el('div',{class:'tk-pills'},view.fromAll?el('a',{class:'sec-pill tk-pill info',href:'#projects/'+set.project,title:t('Otevřít projekt')},project?.name||set.project):null,project?.type?el('span',{class:'sec-pill'},PROJECT_TYPES()[project.type]||project.type):null,
    set.status==='archived'?el('span',{class:'sec-pill dim'},t('archiv')):null,set.feedbackPending?el('span',{class:'sec-pill warn'},t('čeká na agenta')):null,
    set.tickets.map(id=>el('a',{class:'sec-pill tk-pill info',href:'#items/'+id},id)))),archive);
 const rounds=set.rounds.length>1?segmented(t('Kolo'),set.rounds.map(r=>[r.n,`${t('Kolo {n}',{n:r.n})} · ${when(r.publishedAt)}`]),round.n,n=>{
  if(round===latest&&dirty()&&!confirm(t('Rozepsané připomínky k tomuto kolu zůstanou, dokud stránku neopustíš. Přepnout?')))return;view.round=n;redraw();}):null;
 const kindTabs=kinds.length>1?segmented(t('Typ variant'),kinds.map(k=>[k,`${kindNames[k]||k} (${round.items.filter(i=>i.kind===k).length})`]),kind,k=>{view.kind=k;redraw();}):null;
 // Round and kind switches share one toolbar row under the title.
 const switches=rounds||kindTabs?el('div',{class:'tk-toolbar rv-switches'},el('div',{class:'tk-toolbar-left'},...[kindTabs,rounds].filter(Boolean))):null;
 const notes=round.notes||round.addresses.length?el('aside',{class:'rv-notes'},el('b',{},t('Kolo {n} od {who}',{n:round.n,who:round.publishedBy})),round.notes?linkified(round.notes):null,
  round.addresses.length?el('p',{class:'sec-dim'},tp(round.addresses.length,'Odpovídá na {n} připomínku z předchozích kol.|Odpovídá na {n} připomínky z předchozích kol.|Odpovídá na {n} připomínek z předchozích kol.')):null):null;
 const old=round!==latest?el('p',{class:'rv-banner'},t('Starší kolo — jen pro čtení. Aktuální je kolo {n}.',{n:latest.n})):null;
 // Decisions at a glance, and the way to the next item that still needs one (in another kind tab if need be).
 const goTo=item=>{if(item.kind!==kind){view.kind=item.kind;redraw();}requestAnimationFrame(()=>wrap.querySelector('#rv-item-'+item.id)?.scrollIntoView({behavior:'smooth',block:'start'}));};
 const summary=summaryBar(round,{actionable:!readOnly,goTo});
 const shown=round.items.filter(i=>i.kind===kind);
 wrap.replaceChildren(...[head,switches,old,notes,summary.node,msg].filter(Boolean),
  ...shown.map((item,index)=>itemSection({set,round,item,readOnly,latest:round===latest&&set.status==='open',answeredIn,epoch:ctx.epoch,index,count:shown.length,onSaved:summary.draw,
   // Comments of earlier rounds on this item that no round has answered yet.
   carried:set.rounds.filter(r=>r.n<round.n).flatMap(r=>(r.feedback[item.id]?.comments||[]).filter(c=>!answeredAny.has(c.id)).map(c=>({...c,round:r.n})))})));
}
// The round's decisions as one bar: how many items are decided, how they went, and a jump to the next open one.
function summaryBar(round,{actionable,goTo}){
 const node=el('div',{class:'rv-summary',role:'status'});
 const draw=()=>{
  const p=roundProgress(round),labels=DECISIONS(),next=round.items.find(i=>itemStatus(round,i)==='pending');
  const bar=el('div',{class:'rv-summary-bar','aria-hidden':'true'},['accept','revise','reject'].map(s=>{const part=el('span',{class:s});part.style.width=(p.total?p[s]/p.total*100:0)+'%';return part;}));
  node.replaceChildren(
   el('div',{class:'rv-summary-text'},el('b',{},t('Rozhodnuto {done} z {total}',{done:p.decided,total:p.total})),
    ['accept','revise','reject','pending'].filter(s=>p[s]).map(s=>el('span',{class:`sec-pill ${DECISION_TONE[s]}`},`${labels[s]} ${p[s]}`))),
   bar,
   next&&actionable?el('button',{type:'button',class:'acc-btn small',onclick:()=>goTo(next)},`${t('Další nerozhodnutá')} ↓`)
    :!next?el('span',{class:'sec-dim'},t('Vše rozhodnuto. Agent si rozhodnutí přečte přes MCP (review_get).')):null);
 };
 draw();return {node,draw};
}

// Two image variants in one frame with a divider to drag: left of it the first variant, right of it the second.
// The divider is a range input laid over the pictures, so the mouse, a finger and the arrow keys all move it.
function swipeStage(item,cmp){
 const pick=id=>item.variants.find(v=>v.id===id)||item.variants[0];
 const top=el('img',{alt:'',draggable:'false',decoding:'async'}),base=el('img',{alt:'',draggable:'false',decoding:'async'});
 const tagL=el('span',{class:'rv-swipe-tag left'}),tagR=el('span',{class:'rv-swipe-tag right'});
 const range=el('input',{type:'range',min:'0',max:'100',step:'0.5',class:'rv-swipe-range','aria-label':t('Poloha dělicí čáry')});
 const stage=el('div',{class:'rv-swipe-stage'},base,el('div',{class:'rv-swipe-top'},top),tagL,tagR,range,el('span',{class:'rv-swipe-line','aria-hidden':'true'}));
 const setPos=v=>{cmp.pos=v;stage.style.setProperty('--pos',v+'%');};
 range.addEventListener('input',()=>setPos(Number(range.value)));
 const actions=el('div',{class:'rv-variant-actions'});
 const side=(key,label)=>el('label',{class:'rv-swipe-side'},label,el('select',{onchange:e=>{cmp[key]=e.target.value;draw();}},item.variants.map(v=>{const o=el('option',{value:v.id},`${v.label}${v.title?' · '+v.title:''}`);if(v.id===cmp[key])o.selected=true;return o;})));
 const controls=el('div',{class:'rv-swipe-controls'});
 function draw(){
  const left=pick(cmp.left),right=pick(cmp.right);
  top.setAttribute('src',blob(left.media[0].sha256));top.setAttribute('alt',t('Varianta {label}',{label:left.label}));
  base.setAttribute('src',blob(right.media[0].sha256));base.setAttribute('alt',t('Varianta {label}',{label:right.label}));
  tagL.textContent=left.label;tagR.textContent=right.label;range.value=String(cmp.pos);setPos(cmp.pos);
  controls.replaceChildren(side('left',t('Vlevo')),el('button',{type:'button',class:'acc-btn small',title:t('Prohodit strany'),'aria-label':t('Prohodit strany'),onclick:()=>{[cmp.left,cmp.right]=[cmp.right,cmp.left];draw();}},'⇄'),side('right',t('Vpravo')),
   el('span',{class:'sec-dim'},t('Táhni čárou, nebo šipkami ← →. Připomínky se připínají v zobrazení Vedle sebe nebo Po jedné.')));
 }
 return {node:el('div',{class:'rv-swipe',hidden:''},controls,stage,actions),actions,draw};
}

// One item: a row of variants and the decision under it ----------------------------------------
// Saves itself: a pick saves at once, a comment or the note when its box loses focus. Saves run one at a time
// (each needs the previous rev); a conflict re-reads the set once and retries. The frame is green once a variant
// is taken and red when the item went back for rework.
function itemSection({set,round,item,readOnly,latest,answeredIn,carried,epoch,index,count,onSaved}){
 const key=`${set.id}/${round.n}/${item.id}`;
 let decision=round.feedback[item.id]||{rev:0,variant:null,status:'pending',note:'',comments:[],attachments:[]};
 const shots=()=>decision.attachments||[];
 const fresh=()=>({drafts:[],commenting:false,choice:decision.variant,reject:decision.status==='reject',note:decision.note||'',attachments:[...shots()],approvals:{...(decision.approvals||{})},noteOpen:false,focus:null});
 // approve: each non-reference variant gets its own verdict (approved / changes); choose: one variant is taken.
 const approveMode=item.mode==='approve',decidable=item.variants.filter(v=>!v.reference).map(v=>v.id);
 const state=drafts.get(key)||fresh();if(!readOnly)drafts.set(key,state);state.approvals??={};
 const label=vid=>item.variants.find(v=>v.id===vid)?.label||vid.toUpperCase();
 const pickText=(vid,on)=>approveMode?(on?t('✓ Schváleno {label}',{label:label(vid)}):t('✓ Schválit {label}',{label:label(vid)})):on?t('✓ Vybráno {label}',{label:label(vid)}):t('Vybrat {label}',{label:label(vid)});
 // Pins of one variant: drafts (numbered 1…) and saved comments (S1…).
 const pinsFor=vid=>[...state.drafts.map((d,i)=>({...d,n:String(i+1),kind:'draft'})),...decision.comments.map((c,i)=>({...c,n:'S'+(i+1),kind:answeredIn.has(c.id)?'done':'saved'}))].filter(p=>p.variant===vid&&p.anchor);
 const viewers=new Map(),picks=new Map(),zooms=new Map();
 // How the variants are compared: side by side, one at a time (tabs; the default on a phone) or, for images, swipe.
 const cmpKey='cmp:'+key,canSwipe=item.kind==='image'&&item.variants.length>1;
 const cmp=views.get(cmpKey)||{mode:narrow()&&item.variants.length>1?'one':'side',one:item.variants[0].id,left:item.variants[0].id,right:(item.variants[1]||item.variants[0]).id,pos:50};views.set(cmpKey,cmp);
 const swipe=canSwipe?swipeStage(item,cmp):null,modeBar=el('div',{class:'rv-modes'});
 // 3D: moving one variant's camera moves the others (toggle in the item header), so A/B/C are seen from the same side.
 const syncText=on=>on?`🔗 ${t('Pohledy spolu')}`:t('Pohledy zvlášť');
 const camSync=item.kind==='model'&&item.variants.length>1?(()=>{const on=views.get('cam-sync')!==false;
  const b=el('button',{type:'button',class:'acc-btn small rv-sync','aria-pressed':String(on),title:t('Otáčení a přiblížení jedné varianty pohne i ostatními.'),
   onclick:()=>{const next=b.getAttribute('aria-pressed')!=='true';views.set('cam-sync',next);b.setAttribute('aria-pressed',String(next));b.textContent=syncText(next);}},syncText(on));return b;})():null;
 const onCamera=(from,cam)=>{if(camSync?.getAttribute('aria-pressed')!=='true')return;for(const [vid,v] of viewers)if(vid!==from)v.setCamera?.(cam);};
 const refreshPins=()=>{for(const [vid,v] of viewers)v.setPins(pinsFor(vid));};
 // One variant at most. Picking it again clears it; "None of these" clears it too. Either way it saves.
 const choose=vid=>{
  if(approveMode){if(state.approvals[vid]==='approved')delete state.approvals[vid];else state.approvals[vid]='approved';state.reject=false;}
  else{state.choice=state.choice===vid?null:vid;if(state.choice)state.reject=false;}
  sync();save();};
 const approveAll=()=>{for(const id of decidable)state.approvals[id]='approved';state.reject=false;sync();save();};
 const picked=vid=>approveMode?state.approvals[vid]==='approved':vid===state.choice;
 const swipeActions=()=>{if(!swipe)return;swipe.actions.replaceChildren(...[...new Set([cmp.left,cmp.right])].filter(vid=>!readOnly&&decidable.includes(vid))
  .map(vid=>el('button',{type:'button',class:'acc-btn small rv-pick','aria-pressed':String(picked(vid)),onclick:()=>choose(vid)},pickText(vid,picked(vid)))));};
 const sync=()=>{for(const c of row.children){const vid=c.dataset.variant,b=picks.get(vid);
  if(approveMode){const a=state.approvals[vid];c.classList.toggle('rv-chosen',a==='approved');c.classList.toggle('rv-changes',a==='changes');}
  else c.classList.toggle('rv-chosen',vid===state.choice);
  if(b){b.setAttribute('aria-pressed',String(picked(vid)));b.textContent=pickText(vid,picked(vid));}}
  swipeActions();frame();drawPanel();};
 // The item's frame follows the saved decision: green = a variant taken, red = back for rework.
 // approve items: green = all approved, amber = some sent back with comments.
 const frame=()=>{if(!section)return;const st=decision.rev?decision.status:'pending';
  section.classList.toggle('rv-taken',approveMode?st==='accept':st==='accept'||st==='revise');section.classList.toggle('rv-changes',approveMode&&st==='revise');section.classList.toggle('rv-rework',st==='reject');};
 const setCommenting=on=>{state.commenting=on;if(on&&cmp.mode==='swipe'){cmp.mode='side';applyMode();}for(const v of viewers.values())v.setMode(on);row.classList.toggle('rv-commenting',on);drawPanel();};
 // A comment on a variant also picks it when nothing is picked yet.
 const addDraft=(variant,anchor)=>{state.drafts.push({id:++draftSeq,variant,anchor,text:''});state.focus=draftSeq;if(!approveMode&&!state.choice&&!state.reject&&decidable.includes(variant))state.choice=variant;refreshPins();sync();};
 // Esc: drop the comment being written (an empty draft), otherwise leave comment mode.
 const cancel=()=>{const last=state.drafts[state.drafts.length-1];
  if(last&&!last.text.trim()){state.drafts.pop();if(state.choice===last.variant&&state.choice!==decision.variant&&!state.drafts.some(d=>d.variant===last.variant))state.choice=decision.variant;refreshPins();sync();return;}
  if(state.commenting)setCommenting(false);};
 const onKey=e=>{if(e.key!=='Escape'||readOnly||!section.isConnected)return;const inPanel=panel.contains(document.activeElement);if(!state.commenting&&!inPanel)return;
  if(inPanel&&document.activeElement.tagName==='TEXTAREA'&&document.activeElement.value.trim())return;e.preventDefault();document.activeElement?.blur?.();cancel();};
 addEventListener('keydown',onKey);onLeave(()=>removeEventListener('keydown',onKey));
 let section=null;
 const row=el('div',{class:'rv-row'});row.style.setProperty('--rv-cols',String(Math.min(item.variants.length,3)));
 // Shows the chosen way of comparing: the grid, one variant with tabs to flip through, or the swipe frame.
 function applyMode(focusTab=false){
  const one=cmp.mode==='one';
  if(one)row.dataset.focus=cmp.one;else delete row.dataset.focus;
  for(const c of row.children)c.classList.toggle('on',one&&c.dataset.variant===cmp.one);
  for(const [vid,b] of zooms)b.textContent=one&&vid===cmp.one?`⤡ ${t('Porovnat')}`:`⤢ ${t('Zvětšit')}`;
  row.hidden=cmp.mode==='swipe';if(swipe){swipe.node.hidden=cmp.mode!=='swipe';if(cmp.mode==='swipe'){swipe.draw();swipeActions();}}
  if(item.variants.length<2){modeBar.hidden=true;return;}
  const flip=d=>{const ids=item.variants.map(v=>v.id);cmp.one=ids[(ids.indexOf(cmp.one)+d+ids.length)%ids.length];applyMode(true);};
  modeBar.replaceChildren(...[segmented(t('Způsob porovnání'),[['side',t('Vedle sebe')],['one',t('Po jedné')],...(canSwipe?[['swipe',t('Přejíždět')]]:[])],cmp.mode,m=>{cmp.mode=m;applyMode();}),
   one?el('div',{class:'rv-tabs',role:'tablist','aria-label':t('Varianta')},item.variants.map(v=>el('button',{type:'button',role:'tab','aria-selected':String(v.id===cmp.one),tabindex:v.id===cmp.one?'0':'-1',class:v.id===cmp.one?'on':'',title:v.title||'',
    onclick:()=>{cmp.one=v.id;applyMode(true);},onkeydown:e=>{if(e.key==='ArrowRight'){e.preventDefault();flip(1);}else if(e.key==='ArrowLeft'){e.preventDefault();flip(-1);}}},v.label,picked(v.id)?' ✓':''))):null].filter(Boolean));
  if(focusTab)modeBar.querySelector('[role=tab].on')?.focus();
 }
 for(const v of item.variants){
  const viewer=item.kind==='html'?frameViewer(v,{onPick:a=>addDraft(v.id,a),onEscape:()=>cancel()}):item.kind==='model'?modelViewer(v,{onPick:a=>addDraft(v.id,a),onCamera:cam=>onCamera(v.id,cam)}):imageViewer(v,{onPick:a=>addDraft(v.id,a)});viewers.set(v.id,viewer);
  const zoom=item.variants.length>1?el('button',{type:'button',class:'acc-btn small',title:t('Zobrazit jen tuto variantu přes celou šířku'),onclick:()=>{if(cmp.mode==='one'&&cmp.one===v.id)cmp.mode='side';else{cmp.mode='one';cmp.one=v.id;}applyMode();}},`⤢ ${t('Zvětšit')}`):null;if(zoom)zooms.set(v.id,zoom);
  const pick=readOnly||v.reference?null:el('button',{type:'button',class:'acc-btn small rv-pick','aria-pressed':'false',onclick:()=>choose(v.id)},pickText(v.id,false));if(pick)picks.set(v.id,pick);
  const verdict=(decision.approvals||{})[v.id];
  row.append(el('article',{class:'rv-variant','data-variant':v.id},
   el('header',{class:'rv-variant-head'},el('b',{class:'rv-letter'},v.label),el('span',{class:'rv-variant-title'},v.title),v.reference?el('span',{class:'sec-pill dim',title:t('Jen pro srovnání — nevybírá se ani neschvaluje, komentovat jde.')},t('reference')):null,zoom),
   viewer.node,
   v.description?el('p',{class:'tk-text acc-dim rv-variant-desc'},v.description):null,
   readOnly?(approveMode?(verdict?el('span',{class:`sec-pill ${verdict==='approved'?'ok':'warn'}`},verdict==='approved'?t('schváleno'):t('k úpravě')):null):decision.variant===v.id?el('span',{class:`sec-pill ${DECISION_TONE[decision.status]}`},t('vybráno')):null)
    :el('div',{class:'rv-variant-actions'},pick,el('button',{type:'button',class:'acc-btn small',onclick:()=>addDraft(v.id,null)},t('+ Připomínka k celé variantě {label}',{label:v.label})))));
 }
 const panel=el('div',{class:'rv-decide'}),badge=el('span',{class:'rv-item-state'}),saveLine=el('span',{class:'sec-dim rv-save-state',role:'status'});
 const anchorText=a=>!a?t('celá varianta'):a.kind==='surface'?`${t('povrch')} · ${a.node?a.node.split(' / ').pop():a.mesh||'model'}`+(a.material?` · ${a.material}`:'')+(a.animation?` · ${a.animation.name} ${a.animation.time.toFixed(1)} s`:'')+(a.media?` · ${t('model {n}',{n:a.media+1})}`:'')
  :a.kind==='point'?t('bod {x} % × {y} %',{x:Math.round(a.x*100),y:Math.round(a.y*100)})+(a.media?` · ${t('obrázek {n}',{n:a.media+1})}`:''):(a.mockId?`#${a.mockId}`:a.selector.split(' > ').slice(-2).join(' > ')||t('prvek'))+(a.media?` · ${t('stránka {n}',{n:a.media+1})}`:'');
 // Comments with text are ready to save; an empty one stays a draft.
 // A comment is ready with text or a screenshot, and not while its screenshot is still uploading.
 const ready=()=>state.drafts.filter(d=>!d.uploading&&(d.text.trim()||d.attachments?.length));
 // The status follows the choice: nothing → pending, a variant → accept, comments on it → revise, "None of these" → reject.
 // approve: every deliverable approved → accept; any with comments → revise (the server computes the same).
 const approvalsNow=()=>{const a={...state.approvals};for(const d of ready())if(decidable.includes(d.variant))a[d.variant]='changes';return a;};
 const statusNow=()=>{if(state.reject)return 'reject';
  if(approveMode){const a=approvalsNow();return decidable.every(id=>a[id]==='approved')?'accept':Object.values(a).includes('changes')?'revise':'pending';}
  return !state.choice?'pending':ready().some(d=>d.variant===state.choice)||decision.comments.some(c=>c.variant===state.choice)?'revise':'accept';};
 const sameApprovals=()=>{const a=approvalsNow(),b=decision.approvals||{};return [...new Set([...Object.keys(a),...Object.keys(b)])].every(k=>a[k]===b[k]);};
 const sameShots=()=>state.attachments.map(a=>a.sha256).join()===shots().map(a=>a.sha256).join();
 const changed=()=>ready().length>0||approveMode&&!sameApprovals()||(state.choice||null)!==(decision.variant||null)||statusNow()!==decision.status||state.note.trim()!==(decision.note||'').trim()||!sameShots();
 const hasReason=()=>Boolean(state.note.trim()||state.attachments.length||ready().length||decision.comments.length);
 const focusPin=c=>{if(cmp.mode==='swipe'||cmp.mode==='one'&&cmp.one!==c.variant){cmp.mode='one';cmp.one=c.variant;applyMode();}viewers.get(c.variant)?.focus(c.anchor);};
 const savedText=()=>{const approve=APPROVE_TEXT();if(!decision.rev)return approveMode?approve.pending:t('nerozhodnuto');
  if(approveMode){const a=decision.approvals||{},ok=decidable.filter(id=>a[id]==='approved').length,fix=decidable.filter(id=>a[id]==='changes').length;
   return decision.status==='reject'?approve.reject:decision.status==='accept'?`${approve.accept} · ${ok}/${decidable.length}`:`${fix?t('k úpravě {n}',{n:fix})+' · ':''}${t('schváleno {done}/{total}',{done:ok,total:decidable.length})}`;}
  return `${DECISIONS()[decision.status]||decision.status}${decision.variant?' · '+label(decision.variant):''}`;};
 const setSaveLine=(text,bad=false)=>{saveLine.textContent=text;saveLine.classList.toggle('error',bad);};
 let chain=Promise.resolve(),redrawing=false;
 const save=()=>{if(readOnly)return chain;chain=chain.then(()=>saveNow(true)).catch(()=>{});return chain;};
 async function saveNow(retry){
  if(epoch!==sessionEpoch||!changed())return;
  if(state.reject&&!hasReason()){setSaveLine(t('Napiš, co předělat (nebo přilož screenshot) — uloží se po opuštění pole.'));return;}
  const sent=ready(),body={set:set.id,round:round.n,item:item.id,rev:decision.rev,variant:approveMode?null:state.choice||null,status:statusNow(),...(approveMode?{approvals:state.reject?{}:approvalsNow()}:{}),note:state.note.trim(),
   attachments:state.attachments.map(({sha256,type,name})=>({sha256,type,name})),comments:sent.map(d=>({variant:d.variant,anchor:d.anchor,text:d.text.trim(),...(d.attachments?.length?{attachments:d.attachments.map(({sha256,type,name})=>({sha256,type,name}))}:{})}))};
  setSaveLine(t('Ukládám…'));
  try{
   const reply=await api('/api/review/feedback',body);if(epoch!==sessionEpoch)return;
   decision={rev:reply.rev,variant:reply.variant,status:reply.status,...(reply.approvals?{approvals:reply.approvals}:{}),note:reply.note,comments:reply.comments,attachments:reply.attachments||[],updatedAt:reply.updatedAt,updatedBy:reply.updatedBy};round.feedback[item.id]=decision;
   state.drafts=state.drafts.filter(d=>!sent.includes(d));if(approveMode)state.approvals={...(reply.approvals||{})};
   refreshPins();sync();if(cmp.mode==='one')applyMode();onSaved?.();setSaveLine(t('Uloženo {at} · agent si to přečte přes MCP.',{at:when(decision.updatedAt)}));
  }catch(e){
   if(e.status===409&&retry){
    // Someone (another tab, or a pick a moment ago) moved the rev: read the decision again and try once more.
    try{const again=await api('/api/review/sets/'+set.id),r=again.rounds[again.rounds.length-1];
     if(r.n===round.n){decision=r.feedback[item.id]||{rev:0,variant:null,status:'pending',note:'',comments:[],attachments:[]};round.feedback[item.id]=decision;return saveNow(false);}}catch{}
    setSaveLine(t('Agent mezitím publikoval nové kolo. Rozepsané zůstalo — obnov stránku.'),true);return;
   }
   setSaveLine(e.message,true);
  }
 }
 // Leaving the page (another hash) still sends what is ready.
 onLeave(()=>{if(!readOnly)save();});
 // One comment as a message of a thread: who, when, which variant and place, the text and its screenshots, and
 // under it the answer: the later round that addressed it, or that it still waits for the agent.
 const message=(c,badge)=>{const reply=answeredIn.get(c.id);return el('li',{class:`rv-msg${reply?' rv-done':''}`},badge,
  el('div',{class:'rv-msg-body'},
   el('div',{class:'rv-msg-head'},el('span',{class:'tk-avatar','aria-hidden':'true'},initials(c.by)||'?'),el('b',{},c.by||''),el('span',{class:'sec-dim'},when(c.at)),el('span',{class:'tk-label'},label(c.variant)),el('span',{class:'sec-dim'},anchorText(c.anchor))),
   c.text?linkified(c.text):null,shotList(c.attachments||[]),
   reply?el('div',{class:'rv-reply'},el('div',{class:'rv-msg-head'},el('span',{class:'tk-avatar','aria-hidden':'true'},initials(reply.publishedBy)||'?'),el('b',{},reply.publishedBy),el('span',{class:'sec-pill ok'},t('zapracováno v kole {n}',{n:reply.n}))),reply.notes?linkified(reply.notes.length>280?reply.notes.slice(0,280)+'…':reply.notes):null)
    :latest?el('span',{class:'sec-pill warn rv-wait'},t('čeká na agenta')):null));};
 function savedList(){
  if(!decision.comments.length)return null;
  return el('details',{class:'rv-saved',open:''},el('summary',{},t('Připomínky ({n})',{n:decision.comments.length})+(decision.rev?` · ${decision.updatedBy} ${when(decision.updatedAt)}`:'')),
   el('ol',{class:'rv-thread'},decision.comments.map((c,i)=>message(c,el('button',{type:'button',class:'rv-pin-badge saved',title:t('Ukázat ve variantě'),'aria-label':t('Ukázat připomínku {n} ve variantě',{n:i+1}),onclick:()=>focusPin(c)},'S'+(i+1))))));
 }
 // Comments of earlier rounds that no round answered: they still stand, so they stay in sight.
 const carriedList=()=>carried?.length?el('details',{class:'rv-saved rv-carried'},el('summary',{},t('Nevyřízené z dřívějších kol ({n})',{n:carried.length})),
  el('ol',{class:'rv-thread'},carried.map(c=>message(c,el('span',{class:'rv-pin-badge old',title:t('Kolo {n}',{n:c.round})},'K'+c.round))))):null;
 // The note box: text with links, screenshots pasted or picked; saved when the focus leaves the box.
 function noteBox(){
  const msg=status(),file=el('input',{type:'file',accept:SHOT_TYPES.join(','),multiple:'',hidden:''});
  const add=async files=>{
   const list=[...files].filter(f=>f&&f.type?.startsWith('image/'));if(!list.length)return false;
   if(state.attachments.length+list.length>10){fail(msg,new Error(t('Nejvýš 10 příloh k položce.')));return true;}
   setSaveLine(t('Nahrávám screenshot…'));
   try{for(const f of list)state.attachments.push(await uploadShot(f));drawPanel();save();}catch(e){fail(msg,e);setSaveLine('');}
   return true;
  };
  file.addEventListener('change',()=>{add(file.files);file.value='';});
  const area=el('textarea',{rows:state.reject?'3':'2',maxlength:'4000','data-key':'note','aria-label':t('Poznámka'),
   placeholder:state.reject?t('Co předělat? Odkazy vlož do textu, screenshot ze schránky (Cmd/Ctrl+V) nebo přes 📎.'):t('Poznámka pro agenta k celé položce (odkazy, screenshot ze schránky)'),
   oninput:e=>{state.note=e.target.value;}});area.value=state.note;
  area.addEventListener('paste',e=>{const files=[...(e.clipboardData?.files||[])];if(files.some(f=>f.type.startsWith('image/'))){e.preventDefault();add(files);}});
  const box=el('div',{class:'rv-note'+(state.reject?' rv-note-rework':'')},
   state.reject?el('b',{class:'rv-note-title'},t('Nic z toho — co předělat')):null,area,
   shotList(state.attachments,i=>{state.attachments.splice(i,1);drawPanel();save();}),
   el('div',{class:'rv-note-tools'},el('button',{type:'button',class:'acc-btn small',onclick:()=>file.click()},`📎 ${t('Přiložit screenshot')}`),file,
    el('span',{class:'sec-dim'},t('Uloží se, jakmile z pole odejdeš.'))),msg);
  box.addEventListener('focusout',e=>{if(!redrawing&&!box.contains(e.relatedTarget))save();});
  return box;
 }
 function drawPanel(){
  badge.className=`sec-pill rv-item-state ${DECISION_TONE[decision.rev?decision.status:'pending']}`;badge.textContent=savedText();
  if(readOnly){panel.replaceChildren(...[decision.note?linkified(decision.note):null,shotList(shots()),savedList(),carriedList()].filter(Boolean));panel.hidden=!panel.childElementCount;return;}
  // Keep the caret where it was: a save that finishes while you type elsewhere in the panel redraws it.
  const active=panel.contains(document.activeElement)?document.activeElement:null,activeKey=active?.dataset?.key,sel=activeKey?[active.selectionStart,active.selectionEnd]:null;
  const list=state.drafts.length?el('ol',{class:'rv-comments rv-drafts'},state.drafts.map((d,i)=>{
   // Screenshots on this comment: pasted into its box or picked with 📎; uploaded at once, saved with the comment.
   d.attachments??=[];
   const addShots=async files=>{const list=[...files].filter(f=>f?.type?.startsWith('image/'));if(!list.length)return;
    if(d.attachments.length+list.length>10){setSaveLine(t('Nejvýš 10 screenshotů k jedné připomínce.'),true);return;}
    d.uploading=true;setSaveLine(t('Nahrávám screenshot…'));
    try{for(const f of list)d.attachments.push(await uploadShot(f));setSaveLine(t('Screenshot je u připomínky — uloží se, jakmile z ní odejdeš.'));}catch(e){setSaveLine(e.message,true);}
    // Back into this comment's box so you can keep writing; it saves when you leave the comment.
    d.uploading=false;drawPanel();const box=panel.querySelector(`[data-key="draft-${d.id}"]`);if(box&&section.isConnected){box.focus();box.setSelectionRange(box.value.length,box.value.length);}else save();};
   const area=el('textarea',{rows:'1',maxlength:'2000',placeholder:t('Co změnit? Screenshot vlož ze schránky nebo přes 📎. Uloží se, jakmile z připomínky odejdeš.'),'aria-label':t('Připomínka {n}',{n:i+1}),'data-key':'draft-'+d.id,oninput:e=>{d.text=e.target.value;}});area.value=d.text;
   area.addEventListener('paste',e=>{const files=[...(e.clipboardData?.files||[])];if(files.some(f=>f.type.startsWith('image/'))){e.preventDefault();addShots(files);}});
   const file=el('input',{type:'file',accept:SHOT_TYPES.join(','),multiple:'',hidden:''});file.addEventListener('change',()=>{addShots(file.files);file.value='';});
   if(state.focus===d.id)queueMicrotask(()=>{area.focus();state.focus=null;});
   // Saved when the focus leaves the whole comment (text, 📎 and its screenshots), not when it moves to 📎.
   const li=el('li',{},el('button',{type:'button',class:'rv-pin-badge',title:t('Ukázat ve variantě'),onclick:()=>focusPin(d)},String(i+1)),
    el('div',{class:'rv-draft-body'},el('div',{class:'sec-dim'},`${label(d.variant)} · ${anchorText(d.anchor)}`),area,
     shotList(d.attachments,k=>{d.attachments.splice(k,1);drawPanel();}),
     el('div',{class:'rv-draft-tools'},el('button',{type:'button',class:'acc-btn small',title:t('Přiložit screenshot k této připomínce'),onclick:()=>file.click()},d.uploading?t('Nahrávám…'):'📎 Screenshot'),file)),
    el('button',{type:'button',class:'acc-btn small',title:t('Odebrat připomínku'),'aria-label':t('Odebrat připomínku {n}',{n:i+1}),onmousedown:e=>e.preventDefault(),onclick:()=>{state.drafts.splice(i,1);refreshPins();drawPanel();}},'×'));
   li.addEventListener('focusout',e=>{if(!redrawing&&!li.contains(e.relatedTarget))save();});
   return li;
  })):null;
  const mode=el('button',{type:'button',class:'acc-btn small','aria-pressed':String(state.commenting),onclick:()=>setCommenting(!state.commenting)},state.commenting?`✓ ${t('Komentuji — klikni do varianty')}`:`💬 ${t('Komentovat')}`);
  const reject=el('button',{type:'button',class:'acc-btn small rv-reject','aria-pressed':String(state.reject),title:t('Žádná varianta nevyhovuje, agent má připravit nové. Otevře pole pro popis, odkazy a screenshoty.'),
   onclick:()=>{state.reject=!state.reject;if(state.reject){state.choice=null;state.approvals={};state.noteOpen=true;}sync();if(state.reject)panel.querySelector('textarea[data-key=note]')?.focus();save();}},approveMode?t('Celé předělat'):t('Nic z toho — předělat'));
  const all=approveMode&&decidable.length>1?el('button',{type:'button',class:'acc-btn small',disabled:decidable.every(id=>state.approvals[id]==='approved')?'':null,onclick:approveAll},`✓ ${t('Schválit vše')}`):null;
  const noteBtn=state.noteOpen||state.note||state.attachments.length||state.reject?null:el('button',{type:'button',class:'acc-btn small',onclick:()=>{state.noteOpen=true;drawPanel();panel.querySelector('textarea[data-key=note]')?.focus();}},t('+ Poznámka'));
  const note=state.noteOpen||state.note||state.attachments.length||state.reject?noteBox():null;
  // What to do with an item nobody has touched yet, in one line.
  const hint=statusNow()==='pending'&&!state.drafts.length&&!state.commenting?el('p',{class:'rv-hint'},approveMode?t('Schval každou variantu zvlášť, nebo k ní napiš připomínku a vrátí se k úpravě.'):t('Vyber variantu tlačítkem pod ní. Připomínka k ní znamená „beru s úpravami“; když nevyhovuje žádná, zvol „Nic z toho“.')):null;
  // Replacing the panel blurs the box being typed in; that is not "leaving" it, so it must not save.
  redrawing=true;try{panel.replaceChildren(...[
   el('div',{class:'rv-bar'},el('div',{class:'rv-bar-left'},el('span',{class:'rv-bar-title'},t('Rozhodnutí')),all,mode,reject,noteBtn),el('div',{class:'rv-bar-right'},saveLine)),
   hint,
   state.commenting&&!state.drafts.length?el('p',{class:'sec-dim'},(item.kind==='html'?t('Najeď na prvek mockupu a klikni.'):item.kind==='model'?t('Klikni na povrch modelu (tažením dál otáčíš).'):t('Klikni do obrázku.'))+' '+t('Esc ruší.')):null,
   list,note,savedList(),carriedList()].filter(Boolean));}finally{redrawing=false;}
  if(activeKey){const again=panel.querySelector(`[data-key="${activeKey}"]`);if(again){again.focus();try{again.setSelectionRange(...sel);}catch{}}}
 }
 section=el('section',{class:'rv-item',id:'rv-item-'+item.id},
  el('header',{class:'rv-item-head'},el('span',{class:'rv-item-no'},`${index+1}/${count}`),el('h2',{class:'rv-item-title'},item.title),camSync,badge),
  item.description?el('p',{class:'tk-text acc-dim rv-item-desc'},item.description):null,modeBar,row,swipe?.node,panel);
 drawPanel();refreshPins();sync();applyMode();if(state.commenting)setCommenting(true);
 if(!readOnly&&decision.rev&&!changed())setSaveLine(t('Uloženo {at}',{at:when(decision.updatedAt)}));
 return section;
}

// Page tabs (HTML) or thumbnails (images) when a variant has several media; mark(i) moves the selection.
function mediaStrip(variant,cls,pick,content){
 const buttons=variant.media.map((m,i)=>el('button',{type:'button','aria-pressed':String(i===0),class:i===0?'on':'',title:m.caption||m.name||'',onclick:()=>pick(i)},content(m,i)));
 const node=variant.media.length<2?null:el('div',{class:cls},buttons);
 return {node,mark(i){buttons.forEach((b,j)=>{b.classList.toggle('on',i===j);b.setAttribute('aria-pressed',String(i===j));});}};
}
function pinNode(p,{onClick}){
 const n=el('button',{type:'button',class:`rv-pin ${p.kind}`,title:p.text||t('Nová připomínka'),onclick:onClick},p.n);return n;
}

// HTML mockup: sandboxed frame at its own viewport size, scaled to the column; pins in an overlay. --------------
function frameViewer(variant,{onPick,onEscape}){
 let index=0,mode=false,pins=[],scroll={x:0,y:0},scale=1,hover=null;
 const node=el('div',{class:'rv-media'}),box=el('div',{class:'rv-frame'}),overlay=el('div',{class:'rv-overlay'}),highlight=el('div',{class:'rv-highlight',hidden:''});
 let frame=null;
 const vp=()=>variant.media[index].viewport||{width:1280,height:800};
 const post=m=>{try{frame?.contentWindow?.postMessage({hhReview:1,...m},'*');}catch{}};
 let laidOut='';
 // Only a width change rescales; setting the height here must not feed the ResizeObserver back into itself.
 // Fit the column width, never upscale, and keep tall (phone) viewports to a sane height unless the variant is zoomed.
 function layout(force){
  const w=node.clientWidth||vp().width,zoomed=Boolean(node.closest('.rv-row[data-focus]')),maxH=zoomed?Math.max(480,innerHeight*0.85):520;
  const s=Math.min(1,w/vp().width,maxH/vp().height),key=w+'|'+zoomed;if(!force&&key===laidOut)return;laidOut=key;scale=s;
  box.style.width=Math.round(vp().width*s)+'px';box.style.height=Math.round(vp().height*s)+'px';if(frame)frame.style.transform=`scale(${s})`;draw();
 }
 function draw(){
  const place=(n,x,y)=>{const px=(x-scroll.x)*scale,py=(y-scroll.y)*scale;n.style.left=px+'px';n.style.top=py+'px';n.hidden=px<-12||py<-12||px>box.clientWidth+12||py>box.clientHeight+12;};
  overlay.replaceChildren(highlight,...pins.filter(p=>(p.anchor.media||0)===index).map(p=>{const n=pinNode(p,{onClick:()=>post({type:'scrollTo',y:p.anchor.y})});place(n,p.anchor.x,p.anchor.y);return n;}));
  if(hover&&mode){highlight.hidden=false;highlight.style.left=(hover.x-scroll.x)*scale+'px';highlight.style.top=(hover.y-scroll.y)*scale+'px';highlight.style.width=hover.w*scale+'px';highlight.style.height=hover.h*scale+'px';}else highlight.hidden=true;
 }
 function load(){
  frame=el('iframe',{src:'/api/review/frame/'+variant.media[index].sha256,sandbox:'allow-scripts',referrerpolicy:'no-referrer',loading:'lazy',title:`Mockup ${variant.label}${variant.media[index].name?' · '+variant.media[index].name:''}`});
  frame.width=String(vp().width);frame.height=String(vp().height);scroll={x:0,y:0};hover=null;
  box.replaceChildren(frame,overlay);layout(true);
 }
 // Messages are trusted only from this frame's own window and only in the expected shape.
 function onMessage(e){
  if(!node.isConnected){if(attached)detach();return;}
  if(!frame||e.source!==frame.contentWindow||!e.data||e.data.hhReview!==1)return;const d=e.data;
  if(d.type==='ready')post({type:'mode',mode:mode?'comment':'browse'});
  else if(d.type==='scroll'&&fin(d.x)&&fin(d.y)){scroll={x:d.x,y:d.y};draw();}
  else if(d.type==='hover'){const r=d.rect;hover=r&&fin(r.x)&&fin(r.y)&&fin(r.w)&&fin(r.h)?r:null;draw();}
  else if(d.type==='escape'&&mode)onEscape?.();
  else if(d.type==='pick'&&mode&&fin(d.x)&&fin(d.y)){
   onPick({kind:'element',media:index,mockId:typeof d.mockId==='string'&&MOCK_ID.test(d.mockId)?d.mockId:null,selector:typeof d.selector==='string'?d.selector.slice(0,300):'',
    x:Math.max(0,Math.min(100000,Math.round(d.x))),y:Math.max(0,Math.min(100000,Math.round(d.y))),snippet:typeof d.snippet==='string'?d.snippet.slice(0,1000):''});
  }
 }
 let attached=true;addEventListener('message',onMessage);const ro=typeof ResizeObserver==='function'?new ResizeObserver(()=>layout()):null;ro?.observe(node);
 const detach=()=>{attached=false;removeEventListener('message',onMessage);ro?.disconnect();};onLeave(detach);
 const caption=el('p',{class:'sec-dim rv-caption'});
 const pick=i=>{index=i;strip.mark(i);caption.textContent=variant.media[i].caption||'';caption.hidden=!variant.media[i].caption;load();};
 const strip=mediaStrip(variant,'rv-media-tabs',pick,(m,i)=>m.name||t('Stránka {n}',{n:i+1}));
 node.append(...[strip.node,box,caption].filter(Boolean));pick(0);
 return {node,setMode(on){mode=on;box.classList.toggle('rv-commenting',on);post({type:'mode',mode:on?'comment':'browse'});draw();},setPins(list){pins=list;draw();},
  focus(a){if(!a)return;if((a.media||0)!==index)pick(a.media||0);setTimeout(()=>post({type:'scrollTo',y:a.y}),index===(a.media||0)?0:400);box.scrollIntoView({block:'nearest',behavior:'smooth'});}};
}

// Image or render: pins as fractions of the picture; thumbnails switch between several images. ----------------
function imageViewer(variant,{onPick}){
 let index=0,mode=false,pins=[];
 const node=el('div',{class:'rv-media'}),box=el('div',{class:'rv-image'}),overlay=el('div',{class:'rv-overlay'}),caption=el('p',{class:'sec-dim rv-caption'});
 const img=el('img',{alt:'',loading:'lazy',decoding:'async'});
 overlay.addEventListener('click',e=>{if(!mode||e.target!==overlay)return;const r=overlay.getBoundingClientRect();if(!r.width||!r.height)return;
  onPick({kind:'point',media:index,x:Math.round(Math.max(0,Math.min(1,(e.clientX-r.left)/r.width))*1000)/1000,y:Math.round(Math.max(0,Math.min(1,(e.clientY-r.top)/r.height))*1000)/1000});});
 const draw=()=>overlay.replaceChildren(...pins.filter(p=>(p.anchor.media||0)===index).map(p=>{const n=pinNode(p,{onClick:e=>e.stopPropagation()});n.style.left=p.anchor.x*100+'%';n.style.top=p.anchor.y*100+'%';return n;}));
 const show=i=>{index=i;strip.mark(i);const m=variant.media[i];img.src=blob(m.sha256);img.alt=t('Varianta {label}',{label:variant.label})+(m.caption?': '+m.caption:'');caption.textContent=m.caption||'';caption.hidden=!m.caption;draw();};
 const strip=mediaStrip(variant,'rv-thumbs',i=>show(i),(m,i)=>el('img',{src:blob(m.sha256),alt:m.caption||m.name||t('Obrázek {n}',{n:i+1}),loading:'lazy'}));
 box.append(img,overlay);node.append(...[box,strip.node,caption].filter(Boolean));show(0);
 return {node,setMode(on){mode=on;box.classList.toggle('rv-commenting',on);},setPins(list){pins=list;draw();},focus(a){if(a&&(a.media||0)!==index)show(a.media||0);box.scrollIntoView({block:'nearest',behavior:'smooth'});}};
}

// 3D model (.glb) in <model-viewer>: orbit and zoom, animations, pins on the surface. ----------------------------
// The library (public/vendor/model-viewer.min.js, Apache 2.0) is imported on first use, never on other pages.
let modelViewerModule=null;
const loadModelViewer=()=>modelViewerModule??=import('./vendor/model-viewer.min.js').catch(e=>{modelViewerModule=null;throw e;});
const metres=v=>`${v.x}m ${v.y}m ${v.z}m`;
const round5=n=>Math.round(n*1e5)/1e5;
// What a click hit: the glTF node path (root first), the mesh and the material. Node and mesh come from the
// library's internal scene (no public API names them), so they are best effort; the material name is public API.
function hitNames(mv,x,y){
 const out={node:'',mesh:'',material:''};
 try{out.material=String(mv.materialFromPoint(x,y)?.name||'').slice(0,200);}catch{}
 try{
  const key=Object.getOwnPropertySymbols(mv).find(s=>s.description==='scene'),scene=key&&mv[key],hit=scene?.hitFromPoint?.(scene.getNDC(x,y));
  if(hit?.object){
   const path=[];for(let o=hit.object;o&&o.name!=='Target'&&path.length<12;o=o.parent){const n=o.userData?.name||o.name;if(n)path.unshift(String(n).slice(0,80));}
   out.node=path.join(' / ').slice(0,300);out.mesh=String(hit.object.userData?.name||hit.object.name||'').slice(0,200);
  }
 }catch{}
 return out;
}
function modelViewer(variant,{onPick,onCamera}){
 // posed: a clip has been played or seeked, so the model is no longer in its rest pose. model-viewer cannot
 // un-apply a clip (animationName=null just selects the first one), so the rest pose comes back by reloading.
 // req: the latest restore request (pin click or animation choice); an older pending restore gives way to it.
 // pendingCam: the view a reloading model takes once loaded — the one it had, or a newer one from linked variants.
 let index=0,mode=false,pins=[],mv=null,down=null,applying=false,gen=0,posed=false,req=0,pendingCam=null,spinning=false;
 // Back to the rest pose by reloading the model, keeping the current view.
 function rest(){
  const cam=mv?.loaded?camera():null;load();if(!cam)return;pendingCam=cam;const model=mv,r=req;
  model.addEventListener('load',()=>{if(mv===model&&req===r&&pendingCam)setCamera(pendingCam);pendingCam=null;},{once:true});
 }
 const node=el('div',{class:'rv-media'}),box=el('div',{class:'rv-model'}),note=el('p',{class:'sec-dim rv-model-note'},t('Načítám 3D prohlížeč…'));
 const caption=el('p',{class:'sec-dim rv-caption'}),anims=el('div',{class:'rv-anim',hidden:''});
 const camera=()=>{const o=mv.getCameraOrbit(),target=mv.getCameraTarget();return {theta:round5(o.theta),phi:round5(o.phi),radius:round5(o.radius),target:{x:round5(target.x),y:round5(target.y),z:round5(target.z)},fov:Math.round(mv.getFieldOfView()*1000)/1000};};
 function setCamera(c,{jump=true}={}){
  if(!mv||!c)return;if(pendingCam&&!mv.loaded)pendingCam=c;applying=true;
  mv.cameraTarget=metres(c.target);mv.cameraOrbit=`${c.theta}rad ${c.phi}rad ${c.radius}m`;mv.fieldOfView=`${c.fov}deg`;if(jump)mv.jumpCameraToGoal?.();
  requestAnimationFrame(()=>{applying=false;});
 }
 // View tools under the model: back to the framing the model loads with, and a slow turntable.
 const home=el('button',{type:'button',class:'acc-btn small',title:t('Vrátit výchozí pohled'),onclick:()=>{if(!mv?.loaded)return;req++;
  mv.cameraTarget='auto auto auto';mv.cameraOrbit='auto auto auto';mv.fieldOfView='auto';mv.jumpCameraToGoal?.();requestAnimationFrame(()=>{if(mv?.loaded)onCamera?.(camera());});}},`⟲ ${t('Výchozí pohled')}`);
 const spin=el('button',{type:'button',class:'acc-btn small rv-spin','aria-pressed':'false',title:t('Pomalu otáčet modelem'),onclick:()=>{spinning=!spinning;spin.setAttribute('aria-pressed',String(spinning));
  if(mv){if(spinning)mv.setAttribute('auto-rotate','');else mv.removeAttribute('auto-rotate');}}},`↻ ${t('Otáčet')}`);
 const tools=el('div',{class:'rv-model-tools',hidden:''},home,spin,el('span',{class:'sec-dim'},t('Táhni = otáčení, kolečko nebo dva prsty = přiblížení.')));
 function drawPins(){
  if(!mv)return;for(const h of [...mv.querySelectorAll('[slot^="hotspot-"]')])h.remove();
  pins.filter(p=>(p.anchor.media||0)===index).forEach((p,i)=>{
   const b=el('button',{type:'button',slot:`hotspot-rv-${i}`,class:`rv-pin3d ${p.kind}`,title:p.text||t('Nová připomínka'),'data-visibility-attribute':'visible',
    onclick:e=>{e.stopPropagation();focus(p.anchor);}},p.n);
   if(p.anchor.surface)b.dataset.surface=p.anchor.surface;else{b.dataset.position=metres(p.anchor.position);b.dataset.normal=metres(p.anchor.normal);}
   mv.append(b);
  });
 }
 function drawAnimations(){
  const list=mv?.availableAnimations||[];anims.hidden=!list.length;if(!list.length)return anims.replaceChildren();
  const select=el('select',{'aria-label':t('Animace'),onchange:e=>{req++;if(!e.target.value){mv.pause();if(posed)rest();return;}posed=true;mv.animationName=e.target.value;mv.currentTime=0;mv.play();play.textContent='❚❚';}},
   el('option',{value:''},t('Bez animace')),list.map(n=>el('option',{value:n},n)));
  select.value=mv.animationName&&list.includes(mv.animationName)?mv.animationName:'';
  const play=el('button',{type:'button',class:'acc-btn small','aria-label':t('Přehrát nebo zastavit animaci'),onclick:()=>{req++;posed=true;if(!select.value){select.value=list[0];mv.animationName=list[0];}
   if(mv.paused){mv.play();play.textContent='❚❚';}else{mv.pause();play.textContent='▶';}}},mv.paused?'▶':'❚❚');
  anims.replaceChildren(el('span',{class:'sec-dim'},t('Animace ({n})',{n:list.length})),select,play);
 }
 function load(){
  const m=variant.media[index],self=document.createElement('model-viewer');mv=self;gen++;posed=false;pendingCam=null;
  // Events of a model that was replaced (another media picked) are ignored.
  const live=fn=>(...args)=>{if(mv===self)fn(...args);};
  for(const [k,v] of Object.entries({src:blob(m.sha256),'camera-controls':'','interaction-prompt':'none','touch-action':'pan-y','shadow-intensity':'1','max-camera-orbit':'auto auto auto',alt:`${t('3D model {label}',{label:variant.label})}${m.name?' · '+m.name:''}`}))mv.setAttribute(k,v);
  if(m.poster)mv.setAttribute('poster',blob(m.poster.sha256));if(spinning)mv.setAttribute('auto-rotate','');
  mv.addEventListener('load',live(()=>{note.hidden=true;tools.hidden=false;drawAnimations();drawPins();}));
  mv.addEventListener('error',live(()=>{note.hidden=false;tools.hidden=true;note.textContent=t('Model nejde načíst (jen .glb bez Draco/meshopt komprese).');}));
  mv.addEventListener('camera-change',live(e=>{if(!applying&&e.detail?.source==='user-interaction')onCamera?.(camera());}));
  mv.addEventListener('pointerdown',live(e=>{down={x:e.clientX,y:e.clientY};}));
  mv.addEventListener('click',live(e=>{
   if(!mode||e.target!==mv||!down||Math.hypot(e.clientX-down.x,e.clientY-down.y)>5)return;
   const hit=mv.positionAndNormalFromPoint(e.clientX,e.clientY);if(!hit)return;
   let surface=null;try{surface=mv.surfaceFromPoint?.(e.clientX,e.clientY)||null;}catch{}
   const anim=mv.animationName&&(mv.availableAnimations||[]).includes(mv.animationName)?{name:mv.animationName,time:Math.round(mv.currentTime*1000)/1000}:null;
   onPick({kind:'surface',media:index,position:{x:round5(hit.position.x),y:round5(hit.position.y),z:round5(hit.position.z)},normal:{x:round5(hit.normal.x),y:round5(hit.normal.y),z:round5(hit.normal.z)},
    camera:camera(),...hitNames(mv,e.clientX,e.clientY),surface:typeof surface==='string'&&/^[0-9 .eE+-]{1,200}$/.test(surface)?surface:null,animation:anim});
  }));
  box.replaceChildren(mv);note.hidden=false;tools.hidden=true;note.textContent=t('Načítám model…');box.classList.toggle('rv-commenting',mode);
 }
 const pick=i=>{index=i;strip.mark(i);caption.textContent=variant.media[i].caption||'';caption.hidden=!variant.media[i].caption;load();};
 const strip=mediaStrip(variant,'rv-media-tabs',i=>pick(i),(m,i)=>m.name||t('Model {n}',{n:i+1}));
 node.append(...[strip.node,box,note,tools,anims,caption].filter(Boolean));
 loadModelViewer().then(()=>pick(index),()=>{note.textContent=t('3D prohlížeč nejde načíst. Obnov stránku.');});
 // Restores the pose the pin was made from, and the animation frame it was made on.
 function focus(a){
  if(!a)return;
  // A pin made without animation is shown in the rest pose: reload when a clip has moved the model.
  if((a.media||0)!==index)pick(a.media||0);else if(!a.animation&&posed)load();
  box.scrollIntoView({block:'nearest',behavior:'smooth'});
  // Bound to this model: if another media is picked before it loads, the restore is dropped.
  const target=mv,g=gen,r=++req,current=()=>mv===target&&gen===g&&req===r&&node.isConnected;
  const go=async()=>{
   if(!current())return;setCamera(a.camera,{jump:false});
   // The clip changes on the element's next update; seek only after it, else the time lands on the old clip.
   const clip=a.animation&&(target.availableAnimations||[]).includes(a.animation.name)?a.animation.name:null;
   target.pause();if(!clip)return drawAnimations();
   posed=true;target.animationName=clip;await target.updateComplete;if(!current())return;
   target.pause();target.currentTime=a.animation.time;drawAnimations();
  };
  if(target?.loaded)go();else target?.addEventListener('load',go,{once:true});
 }
 return {node,setMode(on){mode=on;box.classList.toggle('rv-commenting',on);},setPins(list){pins=list;drawPins();},focus,setCamera(c){setCamera(c);}};
}
// Page entry for the shell (app.js): every page module exports (context) => Node, and the server's UI
// manifest names it. context = {me, page, sub, machine, site}.
export const reviewPage=({me,sub})=>reviewView(me,sub);
