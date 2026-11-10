// Shared building blocks for pages. docs/design.md shows each one with its options.
//   layout    pageHeader, provenanceBadge, setProvenance, provenancePart
//   states    emptyState, notInstalled, errorState, loadingState, skeleton
//   pieces    copyBlock, copyButton, tabs, mcpConnect, statusPill, banner, segmented, themeSwitch, icon
//   feedback  toast, startLoading, track
// Text-safe DOM only (SPEC.md): every string lands in a text node or an attribute, never in innerHTML.
// Looks come from the design tokens in tokens.css (classes ui-*). Strings passed in are shown as given:
// translate them with t() at the call site, like everywhere else.
// Existing signatures are a contract for pages and plugins: add optional parameters, never rename.
import {el} from './views.js';
import {t,tp,locale} from './i18n.js';
import {timeZone} from './site.js';
import {icon,ICONS} from './icons.js';
import {THEMES,getTheme,setTheme} from './theme.js';
export {icon} from './icons.js';

// Copies text to the clipboard; returns whether it worked (clipboard access can be refused).
export async function copyText(text){
 try{await navigator.clipboard.writeText(String(text));return true;}catch{}
 // Older or non-secure contexts: a hidden textarea and execCommand.
 try{const area=el('textarea',{'aria-hidden':'true',tabindex:'-1',class:'ui-offscreen'});area.value=String(text);document.body.append(area);area.select();const ok=document.execCommand('copy');area.remove();return ok;}catch{return false;}
}
// A Copy button that says what happened: "Copied" with a tick, or that copying failed, then back.
// text: the string, or a function returning it at click time.
export function copyButton(text,{label}={}){
 const idle=label||t('Kopírovat');
 const mark=el('span',{class:'ui-copy-mark','aria-hidden':'true'},icon('copy')),say=el('span',{'aria-live':'polite'},idle);
 let timer=null;
 const button=el('button',{type:'button',class:'ui-button small',onclick:async()=>{
  const ok=await copyText(typeof text==='function'?text():text);
  clearTimeout(timer);button.classList.toggle('done',ok);
  mark.replaceChildren(icon(ok?'check':'alert'));say.textContent=ok?t('Zkopírováno'):t('Kopírování selhalo');
  timer=setTimeout(()=>{button.classList.remove('done');mark.replaceChildren(icon('copy'));say.textContent=idle;},1800);
 }},mark,say);
 return button;
}
// A block of text to hand to something else (an agent prompt, a config snippet) with its own Copy button.
// note: one line under the text (what to replace, where the value comes from).
export function copyBlock(label,text,{note}={}){
 return el('div',{class:'ui-copy'},el('div',{class:'ui-copy-head'},el('span',{},label),copyButton(text)),el('pre',{tabindex:'0'},String(text)),note?el('p',{class:'ui-copy-note'},note):null);
}
// action: {label, href} for a link, {label, onclick} for a button; primary:true marks the main one,
// quiet:true a secondary one without a border, danger:true a destructive one.
const actionClass=a=>`ui-button${a.primary?' primary':''}${a.quiet?' quiet':''}${a.danger?' danger':''}`;
const actionNode=a=>a.href
 ?el('a',{class:actionClass(a),href:a.href,...(/^https?:/.test(a.href)?{target:'_blank',rel:'noopener noreferrer'}:{})},a.label)
 :el('button',{type:'button',class:actionClass(a),onclick:a.onclick},a.label);
const actionsRow=(actions,cls='ui-actions')=>actions?.filter(Boolean).length?el('div',{class:cls},actions.filter(Boolean).map(actionNode)):null;
// icon option of the state blocks: a name from icons.js, a glyph to show as it is, or a node.
const stateIcon=value=>value?el('div',{class:'ui-empty-icon','aria-hidden':'true'},typeof value==='string'&&ICONS.includes(value)?icon(value):value):null;
const stepList=steps=>steps?.length?el('ol',{class:'ui-steps'},steps.map(step=>el('li',{},step))):null;

let serial=0;
/**
 * Tabs over panels: one visible at a time, arrow keys move between tabs.
 * tabs({label, items:[{id, label, content}], selected, onchange})   content: a node, or () => node (built on first show)
 */
export function tabs({label,items=[],selected,onchange}={}){
 const group=`ui-tabs-${++serial}`,list=items.filter(Boolean);
 let current=list.some(i=>i.id===selected)?selected:list[0]?.id;
 const built=new Map();
 const panels=list.map(i=>el('div',{class:'ui-tabpanel',role:'tabpanel',id:`${group}-p-${i.id}`,'aria-labelledby':`${group}-t-${i.id}`,hidden:''}));
 const buttons=list.map(i=>el('button',{type:'button',class:'ui-tab',role:'tab',id:`${group}-t-${i.id}`,'aria-controls':`${group}-p-${i.id}`,onclick:()=>show(i.id,true)},i.label));
 function show(id,notify){
  current=id;
  list.forEach((i,n)=>{
   const on=i.id===id;
   buttons[n].setAttribute('aria-selected',String(on));buttons[n].setAttribute('tabindex',on?'0':'-1');
   if(on&&!built.has(i.id)){built.set(i.id,true);panels[n].replaceChildren(typeof i.content==='function'?i.content():i.content);}
   if(on)panels[n].removeAttribute('hidden');else panels[n].setAttribute('hidden','');
  });
  if(notify)onchange?.(id);
 }
 const move=e=>{
  const at=list.findIndex(i=>i.id===current),next={ArrowRight:at+1,ArrowLeft:at-1,Home:0,End:list.length-1}[e.key];
  if(next===undefined)return;e.preventDefault();
  const n=(next+list.length)%list.length;show(list[n].id,true);buttons[n].focus();
 };
 if(list.length)show(current,false);
 return el('div',{class:'ui-tabs'},label?el('p',{class:'ui-tabs-label'},label):null,
  el('div',{class:'ui-tablist',role:'tablist','aria-label':label||t('Varianty'),onkeydown:move},buttons),panels);
}

// How an agent connects to this hub over MCP with a service-account key (Users and API → service accounts).
// token: the key itself when it was just issued; otherwise a placeholder the reader replaces.
// One text with every client, as plain text:
export function mcpSnippet(token='hhk_…',origin=globalThis.location?.origin||''){
 const mcp=`${origin}/mcp`;
 return `# Claude Code\nclaude mcp add --transport http home-hub ${mcp} \\\n  --header "Authorization: Bearer ${token}"\n\n# Codex (~/.codex/config.toml)\n[mcp_servers.home-hub]\nurl = "${mcp}"\nhttp_headers = { Authorization = "Bearer ${token}" }\n\n# HTTP API\ncurl -s -H "Authorization: Bearer ${token}" ${origin}/api/home`;
}
// The same, one entry per client: [{id, label, text}] for Claude Code, Codex and any client that reads
// the common "mcpServers" JSON.
export function mcpSnippets(token='hhk_…',origin=globalThis.location?.origin||''){
 const mcp=`${origin}/mcp`;
 return [
  {id:'claude',label:'Claude Code',text:`claude mcp add --transport http home-hub ${mcp} \\\n  --header "Authorization: Bearer ${token}"`},
  {id:'codex',label:'Codex',text:`# ~/.codex/config.toml\n[mcp_servers.home-hub]\nurl = "${mcp}"\nhttp_headers = { Authorization = "Bearer ${token}" }`},
  {id:'json',label:'JSON',text:JSON.stringify({mcpServers:{'home-hub':{type:'http',url:mcp,headers:{Authorization:`Bearer ${token}`}}}},null,2)},
 ];
}
/**
 * The MCP connection snippet as tabs (Claude Code, Codex, JSON), each with its own Copy button.
 * mcpConnect({token, origin, label})   without a token the snippet carries a placeholder and says so
 */
export function mcpConnect({token,origin,label}={}){
 const note=token?null:t('Místo hhk_… vlož klíč servisního účtu (Uživatelé a API → Servisní účty).');
 return tabs({label:label===undefined?t('Připojení agenta (MCP)'):label,
  items:mcpSnippets(token||undefined,origin).map(s=>({id:s.id,label:s.label,content:()=>copyBlock(s.label,s.text,{note})}))});
}

// --- provenance: where the data on a page comes from ---------------------------------------------------
// The server sends one summary with every data answer (docs/API.md → Provenance; server/provenance.mjs):
//   {kind, kinds: [{kind, id, source, count, unit, changes, accounts, people, host, lastAt, state,
//    intervalSeconds, schedule, detail}], lastAt, summary}
// The badge is a small pill next to the page title ("Agent", "Collector · 2 days ago", "Mixed"); pressing
// it (mouse, Enter or Space) opens the breakdown, Escape or a click elsewhere closes it.
const PROV_ICON={manual:'users',agent:'cpu',config:'settings',collector:'pulse',telemetry:'bolt',plugin:'puzzle',other:'tag',mixed:'grid'};
const provLabel=kind=>({manual:t('Ručně'),agent:t('Agent'),config:t('Konfigurace'),collector:t('Kolektor'),telemetry:t('Telemetrie'),plugin:t('Plugin'),other:t('Jiný zdroj'),mixed:t('Smíšený zdroj')})[kind]||kind;
const provWhat=kind=>({manual:t('Upravil člověk ve webovém rozhraní nebo v aplikaci.'),agent:t('Zapsal agent klíčem servisního účtu, přes MCP nebo API.'),config:t('Načteno z konfiguračního souboru.'),
 collector:t('Zapsala automatická úloha, která stroje jen čte.'),telemetry:t('Hlásí živě agent na stroji.'),plugin:t('Dodává plugin.'),other:t('Razítko nebo jméno, které tady nenese žádný účet: import, úprava souboru nebo zrušený účet.')})[kind]||'';
const provCount=(n,unit)=>({entries:()=>tp(n,'{n} záznam|{n} záznamy|{n} záznamů'),rounds:()=>tp(n,'{n} kolo|{n} kola|{n} kol'),
 machines:()=>tp(n,'{n} stroj|{n} stroje|{n} strojů'),records:()=>tp(n,'{n} zápis|{n} zápisy|{n} zápisů'),projects:()=>tp(n,'{n} projekt|{n} projekty|{n} projektů'),items:()=>tp(n,'{n} položka|{n} položky|{n} položek'),sources:()=>tp(n,'{n} zdroj|{n} zdroje|{n} zdrojů'),clients:()=>tp(n,'{n} klient|{n} klienti|{n} klientů')})[unit]?.()||String(n);
const provState=state=>({'not-configured':t('nenastaveno'),waiting:t('zatím neběžel'),stale:t('starý snímek'),unavailable:t('poslední pokus selhal')})[state]||'';
const DAY_ONLY=/^\d{4}-\d{2}-\d{2}$/;
// "2 days ago" in the reader's language; a calendar day (an inventory stamp) is counted in whole days.
function provAgo(at,now=Date.now()){
 const time=Date.parse(at);if(!Number.isFinite(time))return '';
 const rel=(n,unit)=>new Intl.RelativeTimeFormat(locale(),{numeric:'auto'}).format(n,unit);
 if(DAY_ONLY.test(at))return rel(Math.min(0,Math.round((time-Date.parse(new Date(now).toISOString().slice(0,10)))/864e5)),'day');
 const minutes=Math.min(0,Math.round((time-now)/60000));
 if(minutes>-1)return t('právě teď');if(minutes>-60)return rel(minutes,'minute');
 const hours=Math.round(minutes/60);return hours>-36?rel(hours,'hour'):rel(Math.round(hours/24),'day');
}
const provWhen=at=>!Number.isFinite(Date.parse(at))?'':DAY_ONLY.test(at)
 ?new Intl.DateTimeFormat(locale(),{day:'numeric',month:'numeric',year:'numeric',timeZone:'UTC'}).format(new Date(at))
 :new Intl.DateTimeFormat(locale(),{day:'numeric',month:'numeric',year:'numeric',hour:'2-digit',minute:'2-digit',timeZone:timeZone()}).format(new Date(at));
const provEvery=s=>s>=3600?`${Math.round(s/3600)} h`:`${Math.max(1,Math.round(s/60))} min`;
const provNames=(list,more)=>`${list.join(', ')}${more?` +${more}`:''}`;
// The facts of one source, as short texts in reading order.
function provFacts(s){
 const out=[];
 if(Number.isFinite(s.count))out.push(provCount(s.count,s.unit));
 if(s.changes)out.push(tp(s.changes,'{n} pozdější změna|{n} pozdější změny|{n} pozdějších změn'));
 if(s.accounts?.length)out.push(t('servisní účty: {names}',{names:provNames(s.accounts,s.accountsMore)}));
 if(s.people?.length)out.push(t('lidé: {names}',{names:provNames(s.people,s.peopleMore)}));
 if(s.host)out.push(t('ze stroje {host}',{host:s.host}));
 if(s.schedule)out.push(s.schedule.trigger==='manual'?t('spuštěno ručně'):s.schedule.scheduler?t('plánovaně ({scheduler})',{scheduler:s.schedule.label?`${s.schedule.scheduler} ${s.schedule.label}`:s.schedule.scheduler}):t('plánovaně'));
 if(s.intervalSeconds)out.push(t('každých {every}',{every:provEvery(s.intervalSeconds)}));
 if(provState(s.state))out.push(provState(s.state));
 if(s.lastAt)out.push(t('naposledy {when} ({ago})',{when:provWhen(s.lastAt),ago:provAgo(s.lastAt)}));
 if(s.detail)out.push(s.detail);
 return out;
}
// What the pill says: the kind, and for a source with a clock or a single author the one fact that matters most.
function provSummary(p){
 const label=provLabel(p.kind);if(p.kind==='mixed')return label;
 const sources=p.kinds,timed=['collector','telemetry','plugin'].includes(p.kind);
 const state=sources.map(s=>s.state).find(s=>s==='not-configured'||s==='waiting');
 if(timed&&!p.lastAt&&state)return `${label} · ${provState(state)}`;
 if(timed&&p.lastAt)return `${label} · ${provAgo(p.lastAt)}`;
 const names=[...new Set(sources.flatMap(s=>s.accounts||[]))];
 return p.kind==='agent'&&names.length===1&&!sources.some(s=>s.accountsMore)?`${label} · ${names[0]}`:label;
}
/**
 * A part of a provenance: only the sources with these ids (a page that draws one part of an answer).
 * provenancePart(provenance, ['systems']) → the same shape, with kind and lastAt worked out again
 */
export function provenancePart(provenance,ids){
 if(!provenance||!Array.isArray(provenance.kinds))return null;
 const kinds=provenance.kinds.filter(s=>ids.includes(s.id)),distinct=[...new Set(kinds.map(s=>s.kind))];
 const lastAt=kinds.map(s=>s.lastAt).filter(Boolean).reduce((a,b)=>a&&Date.parse(a)>=Date.parse(b)?a:b,null);
 return {...provenance,kinds,kind:!kinds.length?'none':distinct.length===1?distinct[0]:'mixed',lastAt};
}
/**
 * The provenance pill with its breakdown. Returns null when there is nothing to say (no provenance in the
 * answer, or no data yet), so a caller can pass the result straight into el().
 * provenanceBadge(provenance)
 */
export function provenanceBadge(provenance){
 const p=provenance&&Array.isArray(provenance.kinds)?provenance:null;
 if(!p||!p.kinds.length||!PROV_ICON[p.kind])return null;
 const id=`ui-prov-${++serial}`,summary=provSummary(p);
 const tone=p.kinds.some(s=>s.state==='stale'||s.state==='unavailable')?' warn':p.kinds.every(s=>s.state==='not-configured'||s.state==='waiting')?' idle':'';
 const pop=el('div',{class:'ui-prov-pop',id,role:'group','aria-label':t('Původ dat'),hidden:''},
  el('p',{class:'ui-prov-title'},t('Odkud jsou data na téhle stránce')),
  el('ul',{class:'ui-prov-list'},p.kinds.map(s=>el('li',{class:'ui-prov-item'},
   el('span',{class:'ui-prov-mark','aria-hidden':'true'},icon(PROV_ICON[s.kind]||'tag')),
   el('div',{},
    el('div',{class:'ui-prov-head'},el('b',{},provLabel(s.kind)),s.source?el('code',{},s.source):null),
    el('p',{class:'ui-prov-what'},provWhat(s.kind)),
    el('ul',{class:'ui-prov-facts'},provFacts(s).map(f=>el('li',{},f))))))),
  el('p',{class:'ui-prov-note'},t('Odvozeno z dat samotných: z razítek záznamů, jejich autorů a ze snímků kolektorů.')));
 const button=el('button',{type:'button',class:`ui-prov${tone}`,'aria-expanded':'false','aria-controls':id,'aria-label':t('Původ dat: {summary}',{summary}),title:t('Odkud jsou data na téhle stránce'),
   onclick:e=>{e.stopPropagation();toggle(pop.hasAttribute('hidden'));}},
  icon(PROV_ICON[p.kind]),el('span',{class:'ui-prov-text'},summary),el('span',{class:'ui-prov-caret','aria-hidden':'true'},icon('chevron')));
 const wrap=el('span',{class:'ui-prov-wrap','data-kind':p.kind},button,pop);
 const inside=node=>{for(let n=node;n;n=n.parentNode)if(n===wrap)return true;return false;};
 const outside=e=>{if(!wrap.isConnected||!inside(e.target))toggle(false);};
 const keys=e=>{if(e.key==='Escape'&&!pop.hasAttribute('hidden')){e.stopPropagation();toggle(false);button.focus();}};
 function toggle(open){
  if(open===!pop.hasAttribute('hidden'))return;
  if(open)pop.removeAttribute('hidden');else pop.setAttribute('hidden','');
  button.setAttribute('aria-expanded',String(open));
  const doc=globalThis.document;
  if(open){doc?.addEventListener?.('click',outside);doc?.addEventListener?.('keydown',keys,true);place();}
  else{doc?.removeEventListener?.('click',outside);doc?.removeEventListener?.('keydown',keys,true);}
 }
 // Keeps the breakdown inside the window: it opens under the pill and moves left as far as it has to.
 function place(){
  pop.style?.removeProperty?.('left');
  const box=pop.getBoundingClientRect?.(),width=globalThis.document?.documentElement?.clientWidth;
  if(!box||!Number.isFinite(width))return;
  const over=box.right-(width-8);
  if(over>0)pop.style.left=`${-Math.min(over,Math.max(0,box.left-8))}px`;
 }
 // Leaving it with the keyboard closes it too.
 wrap.addEventListener('focusout',e=>{if(e.relatedTarget&&!inside(e.relatedTarget))toggle(false);});
 return wrap;
}
/**
 * Puts (or replaces, or with null removes) the provenance pill of a page header that is already drawn:
 * for a page whose header is on screen before its data arrives.
 * setProvenance(headerNode, provenance)
 */
export function setProvenance(header,provenance){
 const slot=header?.querySelector?.('.ui-prov-slot');if(!slot)return;
 const badge=provenanceBadge(provenance);
 slot.replaceChildren(...(badge?[badge]:[]));
}

/**
 * The top of a page: optional eyebrow (section name), the title, one lead sentence, actions on the right.
 * pageHeader({eyebrow, title, lead, actions:[{label, href|onclick, primary}], back:{label, href}, provenance})
 *   provenance   the `provenance` of the page's data answer: a pill next to the title that says where the
 *                data comes from (see provenanceBadge); leave it out, or fill it later with setProvenance
 */
export function pageHeader({eyebrow,title,lead,actions,back,provenance}={}){
 return el('header',{class:'ui-head'},
  el('div',{class:'ui-head-text'},
   back?.href?el('a',{class:'ui-back',href:back.href},`← ${back.label||''}`):null,
   eyebrow?el('p',{class:'ui-eyebrow'},eyebrow):null,
   el('div',{class:'ui-title'},el('h1',{},title||''),el('span',{class:'ui-prov-slot'},provenanceBadge(provenance))),
   lead?el('p',{class:'ui-lead'},lead):null),
  actionsRow(actions,'ui-head-actions'));
}

/**
 * What a page shows when it has nothing yet: what belongs here and how to fill it.
 * emptyState({icon, title, body, steps:[], agentPrompt, mcpSnippet, actions:[], compact})
 *   icon         a name from icons.js ('box', 'plug', …) or a glyph
 *   steps        short how-to lines, shown as a numbered list
 *   agentPrompt  a ready prompt for a coding agent, with a Copy button
 *   mcpSnippet   true = show how to connect an agent to this hub (tabs per client); {token, origin} = the
 *                same with a real key; a string = your own text in one copy block
 *   compact      true = a small dashed block for use inside a list or a card
 */
export function emptyState({icon:mark,title,body,steps,agentPrompt,mcpSnippet:snippet,actions,compact}={}){
 return el('section',{class:`ui-empty${compact?' compact':''}`,role:'status'},
  stateIcon(mark),
  el('h2',{},title||''),
  body?el('p',{},body):null,
  stepList(steps),
  agentPrompt?copyBlock(t('Zadání pro agenta'),agentPrompt):null,
  snippet?(typeof snippet==='string'?copyBlock(t('Připojení agenta (MCP)'),snippet):mcpConnect(snippet===true?{}:snippet)):null,
  actionsRow(actions));
}

/**
 * A feature whose optional companion is not set up on this hub (a soft dependency): say what is missing
 * and how to get it, instead of an error.
 * notInstalled({dependency, installUrl, steps:[], title, body, agentPrompt, actions:[], optional})
 *   optional   false hides the "Optional" tag (the default says the rest of the hub works without it)
 */
export function notInstalled({dependency,installUrl,steps,title,body,agentPrompt,actions,optional=true}={}){
 const install=installUrl?{label:t('Jak nainstalovat {name}',{name:dependency||''}),href:installUrl,primary:true}:null;
 return el('section',{class:'ui-empty ui-missing',role:'status'},
  stateIcon('puzzle'),
  optional?el('div',{class:'ui-empty-tag'},statusPill(t('Volitelné'),'warn')):null,
  el('h2',{},title||t('{name} tu není nainstalované',{name:dependency||''})),
  el('p',{},body||t('Tahle část potřebuje {name}. Bez něj zbytek Home Hubu funguje dál.',{name:dependency||''})),
  stepList(steps),
  agentPrompt?copyBlock(t('Zadání pro agenta'),agentPrompt):null,
  actionsRow([install,...(actions||[])]));
}

/**
 * Something failed to load: what, and a way to try again.
 * errorState({title, body, retry, actions:[], compact})   retry: () => void adds a "Try again" button
 */
export function errorState({title,body,retry,actions,compact}={}){
 return el('section',{class:`ui-empty ui-error${compact?' compact':''}`,role:'alert'},
  stateIcon('alert'),
  el('h2',{},title||t('Tohle se nepodařilo načíst')),
  el('p',{},body||t('Home Hub neodpovídá. Zkus to znovu.')),
  actionsRow([retry?{label:t('Zkusit znovu'),onclick:retry,primary:true}:null,...(actions||[])]));
}
// A line that says something is on its way; skeleton(n) is the same as n grey text lines.
export const loadingState=label=>el('div',{class:'ui-loading',role:'status'},el('span',{class:'ui-spinner','aria-hidden':'true'}),label||t('Načítám…'));
export const skeleton=(lines=3)=>el('div',{class:'ui-skeleton','aria-hidden':'true'},Array.from({length:Math.max(1,Math.min(12,lines))},()=>el('i',{})));

// A short state word in its semantic colour. tone: good | warn | bad | info | accent | '' (neutral).
export const statusPill=(text,tone='')=>el('span',{class:`ui-pill ${tone}`.trim()},text);

/**
 * A line of state above the content.
 * banner({tone, title, body, actions:[]})   tone: info | warn | bad | good
 */
export function banner({tone='info',title,body,actions}={}){
 return el('div',{class:`ui-banner ${tone}`,role:tone==='bad'?'alert':'status'},
  el('span',{class:'ui-banner-text'},title?el('b',{},title):null,title&&body?' ':null,body||null),
  actionsRow(actions));
}

/**
 * A segmented choice (one of a few): language, theme, a range.
 * segmented({label, options:[{id, label, title, icon}], value, onchange})
 */
export function segmented({label,options=[],value,onchange,name}={}){
 const group=el('div',{class:'hh-choice',role:'group','aria-label':label||'','data-choice':name||null},
  options.map(o=>el('button',{type:'button',class:o.id===value?'on':'','aria-pressed':String(o.id===value),'data-id':o.id,title:o.title||null,lang:o.lang||null,
   onclick:e=>{e.stopPropagation();pressOnly(group,o.id);onchange?.(o.id);}},o.icon?icon(o.icon):null,o.label)));
 return group;
}
const pressOnly=(group,id)=>{for(const b of group.querySelectorAll('button')){const on=b.getAttribute('data-id')===id;b.classList.toggle('on',on);b.setAttribute('aria-pressed',String(on));}};
// System | Light | Dark. The choice is per browser (theme.js); every switch on screen follows a change
// made anywhere (another switch, the command palette).
export function themeSwitch(){
 const names={system:t('Podle systému'),light:t('Světlý'),dark:t('Tmavý')},icons={system:'monitor',light:'sun',dark:'moon'};
 return segmented({name:'theme',label:t('Vzhled'),value:getTheme(),onchange:setTheme,options:THEMES.map(id=>({id,label:names[id],title:names[id],icon:icons[id]}))});
}
globalThis.addEventListener?.('themechange',()=>{for(const group of globalThis.document?.querySelectorAll?.('[data-choice="theme"]')||[])pressOnly(group,getTheme());});

// --- feedback that lives outside the page: toasts and the loading bar ---------------------------------
let toastRegion=null;
const region=()=>{
 if(!toastRegion?.isConnected){toastRegion=el('div',{class:'ui-toasts',role:'region','aria-label':t('Oznámení')});document.body.append(toastRegion);}
 return toastRegion;
};
/**
 * A short message that goes away by itself: a confirmation, or an error that needs no page of its own.
 * toast(message, {tone, timeout, action:{label, onclick}}) → {close}
 *   tone     good | bad | warn | info (default)
 *   timeout  ms before it closes; 0 keeps it until closed. Errors stay longer by default.
 */
export function toast(message,{tone='info',timeout,action}={}){
 const life=timeout??(tone==='bad'?8000:4500);
 let timer=null;
 const close=()=>{clearTimeout(timer);if(!node.isConnected)return;node.classList.add('leaving');setTimeout(()=>node.remove(),220);};
 const node=el('div',{class:`ui-toast ${tone}`,role:tone==='bad'?'alert':'status'},
  el('span',{class:'ui-toast-text'},message),
  action?el('button',{type:'button',class:'ui-button small',onclick:()=>{close();action.onclick?.();}},action.label):null,
  el('button',{type:'button',class:'ui-toast-close','aria-label':t('Zavřít'),onclick:close},'×'));
 const host=region();
 while(host.children.length>=4)host.firstElementChild.remove();
 host.append(node);
 if(life>0)timer=setTimeout(close,life);
 return {close};
}
toast.good=(message,options)=>toast(message,{...options,tone:'good'});
toast.bad=(message,options)=>toast(message,{...options,tone:'bad'});

// The loading bar under the top edge. Each startLoading() returns its own done(); the bar shows while
// any is open, and only for work that takes longer than a blink.
let bar=null,open=0,showTimer=null;
const paintBar=()=>{
 if(!bar?.isConnected){bar=el('div',{class:'ui-progress','aria-hidden':'true'});document.body.append(bar);}
 clearTimeout(showTimer);
 if(open>0)showTimer=setTimeout(()=>bar.classList.add('on'),140);else bar.classList.remove('on');
};
export function startLoading(){
 let ended=false;open++;paintBar();
 return ()=>{if(ended)return;ended=true;open=Math.max(0,open-1);paintBar();};
}
// Shows the loading bar until the promise settles; returns the promise.
export function track(promise){const done=startLoading();return Promise.resolve(promise).finally(done);}
