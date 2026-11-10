// První kroky (#welcome): the checklist for a new hub. Each step is read from the hub's real state
// (onboarding.js says how), so it ticks itself as things get set up; nothing here is stored except the
// "hide this" flag, per account in this browser. A new public hub lands here after the first sign-in and
// the sidebar keeps a link while steps are open; a configured household opens it from the account menu.
import {el} from './views.js';
import {t,tp} from './i18n.js';
import {pageHeader,errorState,loadingState,mcpConnect,copyBlock,statusPill,banner,toast} from './ui.js';
import {loadOnboarding,isDismissed,setDismissed} from './onboarding.js';
import {pageAllowed,sessionTicket} from './session-cache.js';
import {TELEMETRY_AGENT_NAME,TELEMETRY_AGENT_URL} from './site.js';

const steps=(...lines)=>el('ol',{class:'ui-steps'},lines.filter(Boolean).map(line=>el('li',{},line)));
const actions=(...list)=>{const shown=list.filter(Boolean);return shown.length?el('div',{class:'ui-actions'},shown.map(a=>el('a',{class:`ui-button${a.primary?' primary':''}`,href:a.href,...(/^https?:/.test(a.href)?{target:'_blank',rel:'noopener noreferrer'}:{})},a.label))):null;};
const code=text=>el('code',{},text);
// A translated sentence with nodes in it: rich('Zkopíruj {from} do {to}.',{from:code('a'),to:code('b')}).
const rich=(text,parts)=>String(text).split(/(\{\w+\})/).filter(Boolean).map(piece=>{const m=/^\{(\w+)\}$/.exec(piece);return m&&parts[m[1]]!==undefined?parts[m[1]]:piece;});

// What each step says: title, one line under it, a state word, and the body shown when it is open.
function describe(step,me){
 const d=step.detail||{};
 switch(step.id){
  case 'signin':return {title:t('Přihlášení funguje'),line:t('Jsi přihlášený jako {user}.',{user:me.username}),
   body:()=>[el('p',{},t('Heslo vestavěného správce změníš v Nastavení. Další lidé dostanou vlastní účet jen pro čtení v Uživatelích a API.')),
    actions({label:t('Nastavení'),href:'#settings'},pageAllowed('access',me)?{label:t('Uživatelé a API'),href:'#access'}:null)]};
  case 'agent':return {title:t('Připoj svého kódovacího agenta'),
   line:step.done===null?t('Servisní účty zakládá jen správce.'):step.done?(d.used?t('Agent se už připojil.'):t('Servisní účet s klíčem je připravený.')):t('Založ servisní účet a dej agentovi připojovací úryvek.'),
   state:step.done&&d.used?[t('připojeno'),'good']:null,
   body:()=>[el('p',{},t('Agent (Claude Code, Codex a další) mluví s Home Hubem přes MCP. Přihlašuje se klíčem servisního účtu, který smí jen to, co mu dovolí jeho oprávnění. Klíče se nikdy nedostanou ke správě uživatelů.')),
    steps(t('Otevři Uživatelé a API → Servisní účty a založ účet, třeba agent-laptop, s oprávněními, která potřebuje.'),t('Vydej mu klíč. Celý se ukáže jen jednou.'),t('Vlož úryvek níž do agenta a místo hhk_… dej ten klíč.')),
    mcpConnect(),
    actions(pageAllowed('access',me)?{label:t('Otevřít Uživatelé a API'),href:'#access',primary:true}:null)]};
  case 'machines':return {title:t('Přidej své stroje'),
   line:step.done?tp(d.count,'{n} stroj v přehledu.|{n} stroje v přehledu.|{n} strojů v přehledu.'):t('Přehled je zatím prázdný.'),
   body:()=>[el('p',{},t('Stroje se berou z konfigurace webu (local/site.json). Jednotlivé zařízení jde přidat i rovnou v Přehledu.')),
    steps(rich(t('Zkopíruj {from} do {to} a vyplň název, síť a stroje.'),{from:code('config/site.example.json'),to:code('local/site.json')}),t('Restartuj Home Hub.'),t('Nebo v Přehledu použij tlačítko Přidat zařízení.')),
    copyBlock(t('Zadání pro agenta'),t('Nastav tenhle Home Hub. Přečti docs/getting-started.md, docs/plugins.md a config/site.example.json. Zeptej se mě na název webu, síť (CIDR), časové pásmo a stroje (název, hostname, IP, role). Zapiš local/site.json, ověř ho spuštěním npm test a řekni mi, jak Home Hub restartovat. Žádná hesla ani tokeny do souboru nepatří.')),
    actions({label:t('Otevřít Přehled'),href:'#overview',primary:true})]};
  case 'telemetry':return {title:t('Nainstaluj telemetrického agenta'),
   line:step.done?tp(d.count,'{n} stroj posílá živá čísla.|{n} stroje posílají živá čísla.|{n} strojů posílá živá čísla.'):t('Bez něj dlaždice ukazují jen statické údaje z konfigurace.'),
   body:()=>[el('p',{},t('{name} je malá aplikace na stroji, která Home Hubu dává živé vytížení CPU a GPU, příkon, teplotu a paměť. Všechno ostatní funguje i bez ní.',{name:TELEMETRY_AGENT_NAME})),
    steps(t('Nainstaluj {name} na stroj a zapni v něm vzdálený přístup.',{name:TELEMETRY_AGENT_NAME}),t('V Přehledu zvol Přidat zařízení, zadej adresu stroje a přihlášení agenta a potvrď otisk jeho certifikátu.'),t('Stroj z konfigurace webu propojíš polem thermoId.')),
    actions({label:t('Jak nainstalovat {name}',{name:TELEMETRY_AGENT_NAME}),href:TELEMETRY_AGENT_URL,primary:true},{label:t('Otevřít Přehled'),href:'#overview'})]};
  case 'inventory':return {title:t('Naplň inventář'),
   line:step.done?tp(d.count,'{n} záznam v inventáři.|{n} záznamy v inventáři.|{n} záznamů v inventáři.'):t('Inventář je zatím prázdný.'),
   body:()=>[el('p',{},t('Inventář říká, co kde běží a co na čem závisí: stroje, běhová prostředí, nástroje, úložiště. Tajemství se do něj nezapisují, jen místo, kde jsou uložená. Nejlíp ho naplní agent, který na strojích pracuje.')),
    copyBlock(t('Zadání pro agenta'),t('Jsi připojený k Home Hubu přes MCP. Projdi tenhle stroj a zapiš do inventáře, co na něm běží: nástrojem inventory_search zjisti, co už tam je, a nástrojem inventory_update přidej nebo oprav záznamy (stroj, běhová prostředí, nástroje, úložiště, porty, závislosti). U každého uveď, jak jsi ho ověřil. Nikdy nezapisuj hesla ani tokeny, jen kde jsou uložené. Když si nejsi jistý, zeptej se mě.')),
    actions({label:t('Otevřít mapu inventáře'),href:'#inventory-map',primary:true})]};
  case 'collectors':{
   const names={systems:t('verze systémů a softwaru'),security:t('SSH klíče'),router:t('klienti routeru')};
   const marks=Object.entries(names).filter(([id])=>d[id]!==undefined).map(([id,name])=>statusPill(name,d[id]?'good':''));
   return {title:t('Nastav kolektory'),
    line:step.done===null?t('Stav kolektorů vidí jen správce.'):step.done?t('Aspoň jeden kolektor už dodal data.'):t('Kolektory zatím nic nedodaly.'),
    body:()=>[el('p',{},t('Kolektory jsou skripty, které se na stroje dívají přes SSH a nic na nich nemění. Dodávají verze systémů a softwaru, inventář SSH klíčů a seznam klientů routeru. Spouštěj je z plánovače, třeba jednou za hodinu.')),
     marks.length?el('p',{class:'ui-actions'},marks):null,
     steps(rich(t('{cmd} čte verze a ochranu strojů (stroje s polem ssh v konfiguraci webu).'),{cmd:code('node scripts/collect-systems.mjs')}),rich(t('{cmd} čte inventář SSH klíčů.'),{cmd:code('node scripts/collect-security.mjs')}),rich(t('{cmd} čte klienty UniFi routeru.'),{cmd:code('python3 scripts/collect-router-unifi.py')})),
     actions(pageAllowed('versions',me)?{label:t('Verze a aktualizace'),href:'#versions'}:null,pageAllowed('security',me)?{label:t('SSH klíče'),href:'#security'}:null)]};}
  default:return {title:step.id,line:'',body:()=>[]};
 }
}

function stepNode(step,index,me,open){
 const text=describe(step,me),id=`wl-step-${step.id}`;
 const body=el('div',{class:'wl-step-body',id,hidden:''});
 let built=false;
 const head=el('button',{type:'button',class:'wl-step-head','aria-expanded':'false','aria-controls':id,onclick:()=>toggle()},
  el('span',{class:'wl-check','aria-hidden':'true'},step.done===true?'✓':String(index+1)),
  el('span',{class:'wl-step-title'},el('b',{},text.title),el('span',{},text.line)),
  el('span',{class:'wl-step-tags'},step.optional?statusPill(t('Volitelné'),'plain'):null,
   text.state?statusPill(text.state[0],text.state[1]):step.done===true?statusPill(t('hotovo'),'good'):step.done===null?statusPill(t('nevím'),''):statusPill(t('zbývá'),'accent')),
  el('span',{class:'wl-step-caret','aria-hidden':'true'},'›'));
 const node=el('li',{class:`wl-step${step.done===true?' done':step.done===null?' unknown':''}`},head,body);
 function toggle(force){
  const show=force??body.hasAttribute('hidden');
  if(show&&!built){built=true;body.replaceChildren(...text.body().flat().filter(Boolean));}
  if(show)body.removeAttribute('hidden');else body.setAttribute('hidden','');
  head.setAttribute('aria-expanded',String(show));node.classList.toggle('open',show);
 }
 if(open)toggle(true);
 return node;
}

export function welcomeView(me,site){
 const slot=el('div',{},loadingState(t('Zjišťuji, co už je nastavené…')));
 const live=sessionTicket();
 const draw=status=>{
  const required=status.steps.filter(s=>!s.optional),next=status.steps.find(s=>s.done===false&&!s.optional)||status.steps.find(s=>s.done===false);
  const tenths=Math.round(10*status.requiredDone/Math.max(1,status.requiredTotal)),hidden=isDismissed(me);
  slot.replaceChildren(...[
   status.complete?banner({tone:'good',title:t('Hotovo.'),body:t('Základ je nastavený. Volitelné kroky můžeš doplnit kdykoli.')}):null,
   el('div',{class:'wl-progress',role:'group','aria-label':t('Postup')},
    el('span',{class:'wl-count'},`${status.requiredDone}/${required.length} `,el('small',{},t('nutných kroků'))),
    el('div',{class:'wl-meter',role:'progressbar','aria-valuemin':'0','aria-valuemax':String(required.length),'aria-valuenow':String(status.requiredDone),'aria-label':t('Postup')},el('i',{class:`w${tenths}`})),
    el('button',{type:'button',class:'ui-button small',onclick:()=>load(true)},t('Zkontrolovat znovu'))),
   el('ol',{class:'wl-steps'},status.steps.map((s,i)=>stepNode(s,i,me,s===next))),
   el('div',{class:'wl-foot'},
    el('span',{},t('Tenhle seznam najdeš kdykoli v nabídce účtu pod První kroky.')),
    el('button',{type:'button',class:'ui-button small quiet',onclick:()=>{setDismissed(me,!hidden);toast(hidden?t('První kroky jsou zpátky v postranním panelu.'):t('První kroky jsou skryté. Najdeš je v nabídce účtu.'));draw(status);}},
     hidden?t('Zobrazovat v postranním panelu'):t('Skrýt z postranního panelu')))].filter(Boolean));
 };
 async function load(force){
  if(force)slot.replaceChildren(loadingState(t('Zjišťuji, co už je nastavené…')));
  let status=null;try{status=await loadOnboarding(me,{force});}catch{}
  if(!live())return;
  if(!status){slot.replaceChildren(errorState({body:t('Stav nastavení se nepodařilo zjistit.'),retry:()=>load(true)}));return;}
  dispatchEvent(new CustomEvent('onboardingchange',{detail:status}));
  draw(status);
 }
 load(false);
 return el('div',{class:'wl'},
  pageHeader({eyebrow:'Home Hub',title:site?.name?t('Vítej v {site}',{site:site.name}):t('Vítej v Home Hubu'),
   lead:t('Pár kroků, než tu bude co vidět: připoj agenta, přidej stroje a nech naplnit inventář. Každý krok se odškrtne sám, jakmile je hotový.')}),
  slot);
}
// Page entry for the shell (app.js): every page module exports (context) => Node, and the server's UI
// manifest names it. context = {me, page, sub, machine, site}.
export const welcomePage=({me,site})=>welcomeView(me,site);
