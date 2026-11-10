// The three collectors of the security module as integrations (server/integrations.mjs):
//   security.systems   scripts/collect-systems.mjs   versions, updates and protection of the machines
//   security.upstream  scripts/check-upstream.mjs    the newest release of every watched program
//   security.keys      scripts/collect-security.mjs  the SSH key inventory
// Each runs on its own schedule (launchd, systemd, cron, by hand) and leaves a snapshot under data/. The
// hub only reads those snapshots: turning one off makes the hub stop reading its file and hides its data,
// but the scheduled job keeps running. Status comes from the snapshot itself: when it was written, how
// the job was started (its `run` stamp: scheduler and label), and which machines it reached.
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {loadSystems,systemsSetup,systemsDirectory} from './systems-data.mjs';
import {loadSecurity,securitySetup} from './security-data.mjs';
import {collectorState,COLLECTORS} from './collector-state.mjs';
import {readRun} from './collector-run.mjs';
import {loadGithubToken} from './systems-upstream.mjs';
import {readWatch} from './software-watch.mjs';
import {tx} from './text.mjs';

export const SYSTEMS_INTEGRATION='security.systems',UPSTREAM_INTEGRATION='security.upstream',KEYS_INTEGRATION='security.keys';
const LAUNCHD_NOTE='Vypnutí jen skryje data v Home Hubu a hub přestane číst soubor se snímkem. Naplánovanou úlohu (launchd, systemd, cron) nezastaví: ta poběží dál.';

const every=s=>s>=3600?`${Math.round(s/3600)} h`:`${Math.round(s/60)} min`;
// collector-state.mjs → integration state: "waiting" (configured, never ran) counts as stale.
const STATE={'not-configured':'not-configured',waiting:'stale',stale:'stale',ok:'ok'};
const SUMMARY={'not-configured':'Nastavení neříká, které stroje číst.',waiting:'Je nastavený, ale ještě neproběhl.',stale:'Snímek je starší, než dovoluje interval: úloha neběžela, kdy měla.',ok:'Snímek je čerstvý.'};
// How the snapshot says its job was started, as one item row.
function scheduleItem(run,intervalSeconds,collectedAt){
 const summary=!run?tx('Plán neznámý (snímek to neříká) · má běžet každých {every}',{every:every(intervalSeconds)})
  :run.trigger==='manual'?tx('Naposledy spuštěno ručně · má běžet každých {every}',{every:every(intervalSeconds)})
  :tx('Plánovaně: {scheduler} · každých {every}',{scheduler:[run.scheduler,run.label].filter(Boolean).join(' ')||'?',every:every(intervalSeconds)});
 return {id:'schedule',label:'Plán',state:run?.trigger==='scheduled'?'ok':'off',summary,lastSuccessAt:collectedAt};
}
const machineItems=machines=>(machines||[]).slice(0,30).map(m=>({id:m.id,label:m.name||m.id,state:m.reachable?(m.stale?'stale':'ok'):'error',
 summary:m.reachable?(m.stale?'Starší data.':'Přečteno.'):'Nedostupný.',lastSuccessAt:m.collectedAt||null,...(m.reachable?{}:{lastError:m.error||'unreachable'})}));
const readJson=file=>readFile(file,'utf8').then(JSON.parse).catch(()=>null);
const label=(root,file)=>{if(!file)return null;const rel=path.relative(root,file);return rel&&!rel.startsWith('..')&&!path.isAbsolute(rel)?rel:path.basename(file);};

async function systemsStatus(state,hub,{enabled=true}={}){
 const site=hub.site,probed=site.machines.filter(m=>m.ssh?.probe);
 const configuredBy=probed.length?[{source:'site.json',name:`machines[].ssh.probe (${probed.length})`}]:[];
 if(!enabled)return {state:'disabled',configuredBy};
 const [doc,snapshot]=await Promise.all([loadSystems(hub.directory,{site,registryFile:state.watch.file,upstream:false}).catch(()=>null),readJson(path.join(systemsDirectory(hub.directory),'snapshot.json'))]);
 const c=doc?.collector||systemsSetup(site);
 return {state:STATE[c.state]||'error',summary:SUMMARY[c.state]||'',lastSuccessAt:c.collectedAt,configuredBy,
  items:[...(c.state==='not-configured'?[]:[scheduleItem(readRun(snapshot?.run),COLLECTORS.systems.intervalSeconds,c.collectedAt)]),...machineItems(doc?.machines)]};
}
async function upstreamStatus(state,hub,{enabled=true}={}){
 const watch=await readWatch({file:state.watch.file}).catch(()=>null),items=watch?.registry?.items?.length||0;
 // The token check-upstream uses, as this hub process sees it: set or not, and from where. Never the value.
 const token=await loadGithubToken().catch(()=>({token:null,source:null}));
 const configuredBy=[...(watch?.source==='local'?[{source:'file',name:label(hub.root,state.watch.file)||'software-watch.json'}]:[]),
  ...(token.source==='env'?[{source:'env',name:'GITHUB_TOKEN'}]:token.source==='file'?[{source:'file',name:process.env.GITHUB_TOKEN_FILE?'GITHUB_TOKEN_FILE':'private/github-token'}]:[])];
 const tokenItem={id:'github-token',label:'GitHub token',state:token.token?'ok':token.invalid?'error':'off',
  summary:token.token?(token.source==='env'?'Nastavený (env GITHUB_TOKEN).':'Nastavený (soubor).'):token.invalid?'Neplatný: kontrola jde bez něj, s nižším limitem.':'Nenastavený: GitHub dovolí 60 dotazů za hodinu.',
  ...(token.invalid?{lastError:'invalid-token'}:{})};
 if(!enabled)return {state:'disabled',configuredBy,items:[tokenItem]};
 const upstream=await readJson(path.join(systemsDirectory(hub.directory),'upstream.json'));
 const c=collectorState('upstream',{configured:items>0,collectedAt:upstream?.checkedAt||null});
 const results=Object.values(upstream?.results||{}),failed=results.filter(r=>r&&r.ok===false||r?.stale).length;
 return {state:c.state==='ok'&&failed?'stale':STATE[c.state]||'error',
  summary:c.state==='not-configured'?'Seznam sledovaného softwaru je prázdný.':c.state==='ok'?(failed?tx('{failed} z {total} zdrojů se nepodařilo přečíst.',{failed,total:results.length}):tx('Přečteno {total} zdrojů.',{total:results.length})):SUMMARY[c.state],
  lastSuccessAt:c.collectedAt,lastError:failed?results.find(r=>r&&(r.ok===false||r.stale))?.error||null:null,configuredBy,
  items:[...(c.state==='not-configured'?[]:[scheduleItem(readRun(upstream?.run),COLLECTORS.upstream.intervalSeconds,c.collectedAt)]),tokenItem]};
}
async function keysStatus(state,hub,{enabled=true}={}){
 const site=hub.site,machines=site.machines.filter(m=>m.ssh&&m.ssh.keys);
 const configuredBy=[...(machines.length?[{source:'site.json',name:`machines[].ssh (${machines.length})`}]:[]),...(site.security.gitHost?[{source:'site.json',name:'security.gitHost'}]:[])];
 if(!enabled)return {state:'disabled',configuredBy};
 const doc=await loadSecurity(hub.directory).catch(()=>'invalid');
 if(doc==='invalid')return {state:'error',summary:'Snímek klíčů nejde přečíst.',lastError:'invalid-snapshot',configuredBy};
 const c=securitySetup(site,{collectedAt:doc?.collectedAt||null});
 return {state:STATE[c.state]||'error',summary:SUMMARY[c.state]||'',lastSuccessAt:c.collectedAt,configuredBy,
  items:[...(c.state==='not-configured'?[]:[scheduleItem(readRun(doc?.run),COLLECTORS.security.intervalSeconds,c.collectedAt)]),...machineItems(doc?.machines)]};
}

export const collectorIntegrations=[
 {id:SYSTEMS_INTEGRATION,title:'Sběr verzí a ochrany (collect-systems)',kind:'collector',page:'versions',docs:'docs/API.md → Collectors',
  description:`Verze systémů a softwaru, aktualizace a ochrana strojů ze snímku, který zapisuje ${COLLECTORS.systems.script}. ${LAUNCHD_NOTE}`,
  howTo:'V local/site.json dej strojům ssh.alias a ssh.probe, spusť node scripts/collect-systems.mjs a naplánuj ho (sh scripts/systems/install-launchd.sh).',
  status:systemsStatus},
 {id:UPSTREAM_INTEGRATION,title:'Kontrola vydání (check-upstream)',kind:'upstream',page:'versions',docs:'docs/API.md → Software watch list',
  description:`Nejnovější vydání sledovaného softwaru (GitHub, PyPI, npm, Homebrew) ze souboru, který zapisuje ${COLLECTORS.upstream.script}. Token pro GitHub čte ten skript; tady je vidět, co vidí proces hubu. ${LAUNCHD_NOTE}`,
  howTo:'Přidej software do seznamu sledovaného softwaru (Verze a aktualizace → Sledovaný software) a spusť node scripts/check-upstream.mjs.',
  status:upstreamStatus},
 {id:KEYS_INTEGRATION,title:'Inventář SSH klíčů (collect-security)',kind:'collector',page:'security',docs:'docs/API.md → Collectors',
  description:`Kde leží privátní SSH klíče a kam se s nimi dá přihlásit, ze snímku, který zapisuje ${COLLECTORS.security.script}. ${LAUNCHD_NOTE}`,
  howTo:'V local/site.json dej strojům ssh.alias, spusť node scripts/collect-security.mjs a naplánuj ho (install-launchd.sh --with-security).',
  status:keysStatus},
];
