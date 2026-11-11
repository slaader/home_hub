// The core modules' answers to the extension point "machines.facets" (server/machine-facets.mjs): what each one
// knows about every machine. Each function takes the overview's machines and what its module already reads; none of
// them opens a connection or writes anything. Wired in the modules' `provides` (home, runtimes, security, inventory,
// git-lfs; backups builds its own from its job summaries).
import {tx} from './text.mjs';
import {FEEDS} from './telemetry-providers.mjs';
import {systemMachines} from './systems-data.mjs';
import {securityMachines} from './security-data.mjs';
import {collectorState} from './collector-state.mjs';
import {placementFor} from './git-lfs-placement.mjs';
import {sameId} from './machine-facets.mjs';

const ids=list=>new Set(list.map(m=>m.id));

// Who does the work for each part, and the prompt a person hands to their own coding agent where something is
// missing. Czech source templates ({id}, {name}, {hostname} are filled per machine in server/machine-facets.mjs);
// English is in public/i18n-en-machines.js. Exported so a test can check that every one has a translation.
export const HOW={
 telemetry:{by:'source',text:'Home Hub data čte sám: z Thermo (macOS), node_exporter nebo Promethea (Linux), WinRM nebo SSH (Windows a Linux). Na stroji musí běžet zdroj; připojení nastavíš na stránce stroje v Přehledu.'},
 backups:{by:'hub',text:'Home Hub zálohuje sám: rsync přes SSH s vlastním klíčem, plán, uchovávání a kontrola místa. Na cílovém stroji stačí účet s SSH, rsync a řádek do authorized_keys z průvodce.'},
 versions:{by:'collector',text:'Kolektor scripts/collect-systems.mjs běží na stroji hubu (launchd, každých 6 h), přihlásí se přes SSH a jen čte. Stroj musí být v local/site.json s ssh.alias a ssh.probe (mac nebo nas).'},
 protection:{by:'collector',text:'Stejný kolektor jako verze (collect-systems): firewall, šifrování disku, SSH heslem, otevřené porty. Jen čte.'},
 keys:{by:'collector',text:'Kolektor scripts/collect-security.mjs běží na stroji hubu jednou denně a přes SSH přečte otisky klíčů a authorized_keys. Soukromé klíče nikdy neopustí stroj.'},
 inventory:{by:'agent',text:'Inventář sám nic nezjišťuje: zapíše ho agent přes MCP (inventory_update) nebo ty na mapě inventáře.'},
 runtimes:{by:'hub',text:'Home Hub runtimy čte sám přes jejich HTTP API (jen GET). Adresu zapíše agent přes MCP (runtime_endpoint_upsert) nebo local/site.json → runtimes.'},
 gitLfs:{by:'hub',text:'Home Hub čte git host přes jeho API a git; kde běží a kde leží LFS soubory, ví z inventáře.'},
};
export const PROMPTS={
 telemetry:'Připrav stroj „{name}“ ({hostname}) tak, aby Home Hub četl jeho telemetrii. Zjisti systém. macOS: nainstaluj Thermo a založ v něm účet pro Home Hub. Linux: spusť prometheus-node-exporter na portu 9100 dostupný jen z LAN (nebo stroj přidej jako target existujícího Promethea). Windows: zapni OpenSSH Server nebo WinRM přes HTTPS. Nic jiného neměň a pošli mi adresu, port a účet; připojení pak nastavím v Home Hubu na stránce stroje.',
 backups:'Připrav stroj „{name}“ ({hostname}) pro zálohy Home Hubu přes rsync a SSH. Jako cíl: vytvoř účet s přístupem přes SSH, adresář pro snímky a ověř, že je nainstalovaný rsync. Jako zdroj: ověř, že účet hubu smí číst zálohované adresáře. Řádek do authorized_keys ti pošlu z průvodce na stránce Zálohování; nic jiného na stroji neměň.',
 versions:'Zapoj stroj „{name}“ ({hostname}, id {id}) do kolektoru verzí a ochrany Home Hubu. Na stroji, kde běží Home Hub: přidej do ~/.ssh/config alias, který se na stroj přihlásí klíčem bez hesla, a v local/site.json u stroje {id} nastav ssh: {alias, probe: "mac"} (macOS) nebo "nas" (TrueNAS); pro jiný systém nejdřív napiš sondu podle scripts/systems/mac-probe.sh, jen pro čtení. Je-li stroj v hubu jen přidaný, přidej ho do local/site.json se stejným id, v hubu ho odeber a hub restartuj. Pak spusť node scripts/collect-systems.mjs --only {id} a pravidelný běh zajisti přes scripts/systems/install-launchd.sh. Na sondovaném stroji nic neinstaluj ani neměň.',
 keys:'Zapoj stroj „{name}“ ({hostname}, id {id}) do inventáře SSH klíčů Home Hubu. Na stroji, kde běží Home Hub: ověř, že se ssh alias stroje z local/site.json (ssh.alias, keys nesmí být false) přihlásí klíčem bez hesla, spusť node scripts/collect-security.mjs a denní běh zajisti přes scripts/systems/install-launchd.sh --with-security. Sonda posílá jen otisky a veřejné řádky authorized_keys; na stroji nic neměň.',
 inventory:'Zapiš stroj „{name}“ (id {id}, {hostname}) do inventáře Home Hubu. Připoj se přes MCP klíčem servisního účtu se scopes read a inventory:write. Zavolej inventory_describe a inventory_search, ať nic nezdvojíš. Zapiš stroj (kind machine, id {id}) a služby, které na něm běží, s adresami, porty a závislostmi. Hesla a tokeny nikdy, jen kde jsou uložené.',
 runtimes:'Zjisti, jestli na stroji „{name}“ ({hostname}) běží lokální LLM runtimy (llama-swap, Ollama, LM Studio, llama.cpp, vLLM, oMLX, mlx-serve) a na jakých portech. Připoj se k Home Hubu přes MCP klíčem se scopes read a home:write a každý zapiš přes runtime_endpoint_upsert (machine {id}, adresa http://<IP v LAN>:<port>). Na stroji nic neměň.',
};

// ---- telemetry (home) -----------------------------------------------------------------------------------
const TELEMETRY_STATE={ok:'ok',stale:'stale',unreachable:'error','not-installed':'not-configured','not-applicable':'not-applicable'};
// enabled(integrationId) → whether that integration is on; thermoIntegration: the id of Thermo's.
export function telemetryFacet(machines,{enabled=()=>true,thermoIntegration='home.thermo'}={}){
 const out={};
 for(const m of machines){
  const tl=m.telemetry||{},feed=FEEDS[tl.provider]||null,thermo=!feed&&Boolean(m.thermo||tl.thermoId);
  const name=feed?feed.name:thermo?'Thermo':null,integration=feed?feed.integration:thermo?thermoIntegration:null;
  const href=`#host-${m.id}`;
  if(integration&&!enabled(integration)){out[m.id]={state:'off',summary:tx('{provider} je vypnutý v Integracích.',{provider:name}),href};continue;}
  const state=TELEMETRY_STATE[tl.state]||(name?'error':'not-configured');
  if(state==='not-applicable'){out[m.id]={state,summary:'Router čte adaptér routeru, ne telemetrie.',href};continue;}
  if(state==='not-configured'){out[m.id]={state,summary:'Telemetrie není připojená. Připoj ji na stránce stroje v Přehledu.',href};continue;}
  const age=Number.isFinite(tl.ageSeconds)?tl.ageSeconds:null;
  out[m.id]={state,href,
   summary:state==='ok'?tx('Čte {provider}.',{provider:name}):state==='stale'?tx('{provider}: data jsou zastaralá.',{provider:name}):tx('{provider}: stroj neodpovídá.',{provider:name}),
   details:[{label:'Zdroj',value:name},
    ...(tl.target?[{label:'Cíl',value:tl.target}]:[]),
    ...(age!==null?[{label:'Poslední vzorek',value:tx('před {n} s',{n:Math.round(age)})}]:[]),
    ...(tl.detail?[{label:'Chyba čtení',value:tl.detail}]:[])]};
 }
 return {id:'telemetry',title:'Telemetrie',icon:'pulse',order:10,page:'overview',
  howTo:'Telemetrie není připojená. Připoj ji na stránce stroje v Přehledu.',how:HOW.telemetry,prompt:PROMPTS.telemetry,machines:out};
}

// ---- LLM runtimes (runtimes; the overview's merged reports, plugin bridges included) ----------------------
export function runtimesFacet(machines){
 const out={};
 for(const m of machines){
  const list=Array.isArray(m.runtimes?.runtimes)?m.runtimes.runtimes:[];if(!list.length)continue;
  const up=list.filter(r=>r.status==='running'),known=list.filter(r=>r.status!=='unknown');
  out[m.id]={state:known.length&&up.length===known.length?'ok':up.length?'warn':known.length?'error':'stale',href:`#host-${m.id}`,
   summary:tx('{names} · běží {up} z {n}',{names:list.map(r=>r.name||r.id).join(', '),up:up.length,n:list.length}),
   details:list.slice(0,8).map(r=>({label:r.name||r.id,value:tx('{status}{version}',{status:[r.status==='running'?'běží':r.status==='stopped'?'zastavený':'neznámý stav'],version:r.version?` · ${r.version}`:''})}))};
 }
 return {id:'runtimes',title:'LLM runtimy',icon:'cpu',order:60,page:'models',how:HOW.runtimes,prompt:PROMPTS.runtimes,machines:out,
  fallback:{state:'not-applicable',summary:'Žádný LLM runtime.'}};
}

// ---- versions, protection and SSH keys (security) -----------------------------------------------------------
// systems = loadSystems(…) or null, security = loadSecurity(…) or null; on = {systems, keys} integration switches.
export function securityFacets(machines,{site,systems,security,on={systems:true,keys:true},now=Date.now()}){
 const probed=ids(systemMachines(site)),keyed=ids(securityMachines(site));
 const versions={},protection={},keys={};
 for(const m of machines){
  if(probed.has(m.id)){
   const row=systems?.machines?.find(x=>x.id===m.id);
   if(!row){versions[m.id]=protection[m.id]={state:'stale',summary:'Kolektor verzí stroj ještě nepřečetl.'};}
   else if(!row.reachable){versions[m.id]=protection[m.id]={state:'error',summary:'Při posledním běhu kolektoru nebyl dosažitelný.',...(row.error?{details:[{label:'Chyba čtení',value:String(row.error)}]}:{})};}
   else{
    const s=row.summary||{},os=s.osUpdate||0,sw=s.softwareUpdates||0,apps=s.appUpdates||0,n=os+sw+apps,c=s.checks||{};
    versions[m.id]={state:row.stale?'stale':n?'warn':'ok',summary:n?tx('Čeká {n} aktualizací.',{n}):'Všechno sledované je aktuální.',
     details:[{label:'Aktualizace systému',value:String(os)},{label:'Aktualizace softwaru',value:String(sw)},{label:'Aktualizace aplikací',value:String(apps)},...(s.unknown?[{label:'Neznámá verze',value:String(s.unknown)}]:[])]};
    protection[m.id]={state:row.stale?'stale':c.crit?'error':c.warn?'warn':'ok',
     summary:c.crit||c.warn?tx('{warn} upozornění, {crit} kritických.',{warn:c.warn||0,crit:c.crit||0}):'Bez upozornění.'};
   }
  }
  if(keyed.has(m.id)){
   const row=security?.machines?.find(x=>x.id===m.id);
   const stale=row?.collectedAt&&collectorState('security',{configured:true,collectedAt:row.collectedAt,now}).state==='stale';
   keys[m.id]=!row?{state:'stale',summary:'Kolektor SSH klíčů stroj ještě nepřečetl.'}
    :!row.reachable?{state:'error',summary:'Při posledním běhu kolektoru nebyl dosažitelný.'}
    :{state:stale?'stale':'ok',summary:tx('Účtů: {n}.',{n:Array.isArray(row.accounts)?row.accounts.length:0})};
  }
 }
 const notProbed='Kolektor čte jen stroje, které mají v local/site.json ssh.probe (a běží na nich agent kolektoru).';
 return [
  {id:'versions',title:'Verze a aktualizace',icon:'versions',order:30,page:'versions',off:!on.systems,howTo:notProbed,how:HOW.versions,prompt:PROMPTS.versions,machines:versions},
  {id:'protection',title:'Ochrana stroje',icon:'shield',order:35,page:'hardening',off:!on.systems,howTo:notProbed,how:HOW.protection,prompt:PROMPTS.versions,machines:protection},
  {id:'ssh-keys',title:'SSH klíče',icon:'key',order:40,page:'security',off:!on.keys,howTo:'Kolektor SSH klíčů čte jen stroje, které mají v local/site.json ssh (a keys není false).',how:HOW.keys,prompt:PROMPTS.keys,machines:keys}];
}

// ---- inventory -----------------------------------------------------------------------------------------------
export function inventoryFacet(machines,entries){
 const out={},list=Array.isArray(entries)?entries:[];
 for(const m of machines){
  const own=list.find(e=>e?.kind==='machine'&&e.id===m.id)||list.find(e=>e?.kind==='machine'&&sameId(e.id,m.id));if(!own)continue;
  const on=list.filter(e=>e?.machine===own.id).length;
  out[m.id]={state:'ok',summary:tx('V inventáři · {n} záznamů běží na něm.',{n:on}),href:'#inventory-map'};
 }
 return {id:'inventory',title:'Inventář',icon:'list',order:50,page:'inventory-map',how:HOW.inventory,prompt:PROMPTS.inventory,
  howTo:'Stroj v inventáři není. Zapíše ho agent (MCP inventory_update) nebo ho přidáš na mapě inventáře.',machines:out};
}

// ---- Git LFS -------------------------------------------------------------------------------------------------
export function gitLfsFacet(machines,{connections=[],entries=null,off=false}){
 // The inventory names machines its own way; a placement's machine is the hub machine with the same id (sameId).
 const out={},add=(inv,line)=>{const m=machines.find(x=>x.id===inv)||machines.find(x=>sameId(x.id,inv));if(m)(out[m.id]??={state:'ok',lines:[]}).lines.push(line);};
 for(const c of connections){
  const p=entries?placementFor(c.web,entries):null;if(!p)continue;
  if(p.service?.machine)add(p.service.machine,{label:'Git host',value:`${c.name} · ${p.service.name}`});
  if(p.storage?.machine)add(p.storage.machine,{label:'LFS soubory',value:`${c.name} · ${p.storage.name}`});
 }
 for(const [id,v] of Object.entries(out))out[id]={state:'ok',href:'#git-lfs',details:v.lines,
  summary:v.lines.map(l=>l.label).includes('LFS soubory')?(v.lines.some(l=>l.label==='Git host')?'Git host a jeho LFS soubory.':'Ukládá LFS soubory git hostu.'):'Běží tu git host.'};
 return {id:'git-lfs',title:'Git LFS',icon:'archive',order:70,page:'git-lfs',off,how:HOW.gitLfs,machines:out,
  fallback:{state:'not-applicable',summary:'Žádný připojený git host tu neběží ani tu neukládá LFS soubory.'}};
}
