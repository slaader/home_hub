// Core module "git-lfs": the Git LFS page (#git-lfs, docs/git-lfs.md). Connections to git hosts (GitHub,
// GitHub Enterprise, Gitea, Forgejo, and whatever a plugin adds through the extension point
// "git-lfs.providers"), a catalog of every LFS object of the chosen repositories with where it is used,
// and the guarded deletion of orphaned objects on hosts that can delete them.
// The hub talks to the hosts over their HTTP API and git (a bare partial mirror per repository under the
// state directory; server/git-lfs-git.mjs). Tokens are write-only: kept in private/git-lfs-tokens.json (0600),
// never sent back or logged. Reading needs "read"; managing connections and deleting needs "git-lfs:write".
// Distinct from the household plugin "lfs" (/api/lfs*, lfs:delete), which reads one Forgejo from its files.
import path from 'node:path';
import {placementFor} from '../git-lfs-placement.mjs';
import {createGitLfsStore} from '../git-lfs-store.mjs';
import {GitError} from '../git-lfs-git.mjs';
import {ProviderError} from '../git-lfs-providers.mjs';
import {tx} from '../text.mjs';
import {gitLfsFacet} from '../machine-facet-sources.mjs';
import {FACETS_POINT} from '../machine-facets.mjs';

export const GIT_LFS_INTEGRATION='git-lfs.hosts';
// The write scope is a core scope (server/scopes.mjs → CORE_SCOPES), like every scope a core module uses.
export const GIT_LFS_SCOPE='git-lfs:write';
const POLL_MS=5*60000;

const MESSAGES={
 invalid:[400,'INVALID_INPUT','Neplatný požadavek.'],
 'not-found':[404,'GIT_LFS_NOT_FOUND','Takové připojení nebo repozitář tu není.'],
 'token-required':[400,'GIT_LFS_TOKEN_REQUIRED','Zadej token. Uložený token se posílá jen hostu, pro který byl zadaný.'],
 'token-missing':[409,'GIT_LFS_TOKEN_MISSING','K tomuhle připojení není uložený token. Uprav připojení a zadej ho.'],
 busy:[409,'GIT_LFS_BUSY','Repozitáře se právě skenují nebo běží mazání. Zkus to za chvíli.'],
 conflict:[409,'GIT_LFS_CONFLICT','Repozitář se od náhledu změnil (refy nebo uložené objekty). Otevři náhled znovu.'],
 unverified:[503,'GIT_LFS_UNVERIFIED','Repozitář se nepodařilo znovu celý ověřit. Nic se nesmazalo.'],
 unsupported:[409,'GIT_LFS_UNSUPPORTED','Tenhle host neumí LFS objekty mazat přes API.'],
 'git-missing':[503,'GIT_LFS_GIT_MISSING','Na tomhle stroji není git. Hub nic neinstaluje; nainstaluj git a restartuj hub.'],
 'provider-missing':[409,'GIT_LFS_PROVIDER_MISSING','Plugin, který tenhle druh hostu přidal, není načtený.'],
 'audit-failed':[503,'GIT_LFS_AUDIT_FAILED','Záznam do auditu se nepodařilo zapsat; mazání se zastavilo.'],
};
const HOST={auth:'Host token odmítl (neplatný nebo prošlý).','missing-scope':'Token nemá oprávnění ke čtení repozitářů (u Gitea a Forgejo repository: Read). Token nejde upravit: vytvoř nový a vlož ho přes Upravit.',forbidden:'Host na tohle tokenu nedovolil. Chybí mu oprávnění.','not-found':'Host repozitář nebo adresu nezná (nebo na ně token nevidí).',
 network:'Host není dosažitelný.',timeout:'Host neodpověděl včas.','rate-limited':'Host omezil počet požadavků. Zkus to později.',redirect:'Host přesměrovává jinam; token se jinam neposílá. Zkontroluj adresu.',
 'host-error':'Host vrátil chybu.','bad-response':'Host odpověděl něčím, čemu hub nerozumí. Je to správný druh hostu?','too-large':'Odpověď hostu je příliš velká.','too-many':'Host vypsal příliš mnoho repozitářů.',
 'git-failed':'Git skončil chybou.','scan-failed':'Sken gitu neproběhl celý.','invalid-url':'Adresa repozitáře není http(s).'};
const hostError=e=>(e instanceof ProviderError||e instanceof GitError)?[502,'GIT_LFS_HOST',HOST[e.code]||'Host vrátil chybu.',e.code]:null;
const error=e=>{const m=MESSAGES[e.message];if(m)return m;const h=hostError(e);return h?h.slice(0,3):null;};
// Off: reads answer {disabled} (200), changes are refused (409). Nothing is fetched.
const DISABLED={code:'INTEGRATION_DISABLED',message:'Integrace je vypnutá. Nejdřív ji zapni.'};
const off=c=>c.hub.integrationEnabled(GIT_LFS_INTEGRATION)?null:c.hub.integrationDisabled(GIT_LFS_INTEGRATION);
const route=r=>({error,...r,handler:async c=>{
 const disabled=off(c);
 if(disabled&&r.method==='GET')return c.json(200,{schemaVersion:1,disabled,connections:[],providers:[],items:[],total:0});
 if(disabled)return c.json(409,{error:DISABLED,disabled});
 try{return await r.handler(c);}
 catch(e){
  const m=MESSAGES[e.message];if(m)return c.json(m[0],{error:{code:m[1],message:m[2],...(e.detail?{details:[e.detail]}:{})}});
  const h=hostError(e);if(h)return c.json(h[0],{error:{code:h[1],message:h[2],host:h[3]}});
  throw e;
 }}});

function integrationStatus(state,hub,{enabled=true}={}){
 const configuredBy=[{source:'ui',name:'Git LFS → připojení'},{source:'file',name:'private/git-lfs-tokens.json'}];
 if(!enabled)return {state:'disabled',configuredBy};
 const list=state.store.status();
 if(!list.length)return {state:'not-configured',summary:'Žádné připojení ke git hostu. Přidej ho na stránce Git LFS.',configuredBy};
 const items=list.map(c=>({id:c.id,label:c.name,state:c.error||c.failed?'error':c.running?'stale':c.finishedAt?'ok':'stale',
  summary:c.error?tx('Sken selhal ({error}).',{error:c.error}):tx('{repos} repozitářů · {objects} objektů · {failed} s chybou',{repos:c.repos,objects:c.objects,failed:c.failed}),lastSuccessAt:c.finishedAt}));
 const bad=items.filter(i=>i.state==='error').length;
 return {state:bad===items.length?'error':bad?'stale':items.every(i=>i.state==='ok')?'ok':'stale',
  summary:tx('{n} připojení · {objects} LFS objektů',{n:list.length,objects:list.reduce((n,c)=>n+c.objects,0)}),
  lastSuccessAt:list.map(c=>c.finishedAt).filter(Boolean).sort().at(-1)||null,configuredBy,items};
}

export default {
 id:'git-lfs',title:'Git LFS',
 assets:['git-lfs-view.js','git-lfs-wizard.js','git-lfs.css','i18n-en-git-lfs.js'],
 nav:[{groupKey:'Inventář',hash:'git-lfs',labelKey:'Git LFS',view:'git-lfs-view.js#gitLfsPage',order:24,icon:'archive'}],
 // options.gitLfsTokenFile, gitLfsNow, gitLfsGraceMs, gitLfsGit, gitLfsCheckLimit, gitLfsDeleteChunk, gitLfsAppendAudit: tests.
 // Otherwise GIT_LFS_TOKENS_FILE or private/git-lfs-tokens.json, and GIT_LFS_GRACE_HOURS (default 7 days).
 setup:hub=>({store:createGitLfsStore({stateDirectory:hub.stateDirectory,
  tokenFile:hub.options.gitLfsTokenFile||process.env.GIT_LFS_TOKENS_FILE||path.join(hub.root,'private','git-lfs-tokens.json'),
  providers:()=>hub.collect('git-lfs.providers'),now:hub.options.gitLfsNow,graceMs:hub.options.gitLfsGraceMs,git:hub.options.gitLfsGit,
  checkLimit:hub.options.gitLfsCheckLimit,deleteChunk:hub.options.gitLfsDeleteChunk,appendAudit:hub.options.gitLfsAppendAudit,
  isEnabled:()=>hub.integrationEnabled(GIT_LFS_INTEGRATION)})}),
 pollers:[{id:'git-lfs',
  start(state,hub){
   const tick=()=>{if(!hub.integrationEnabled(GIT_LFS_INTEGRATION))return;for(const id of state.store.due())state.store.refresh(id).catch(()=>{});};
   state.timer=setInterval(tick,POLL_MS);state.timer.unref?.();state.first=setTimeout(tick,60000);state.first.unref?.();
  },
  stop(state){clearInterval(state.timer);clearTimeout(state.first);}}],
 routes:[
  // Each connection also says where its files live, as the inventory has it (server/git-lfs-placement.mjs).
  {method:'GET',path:'/api/git-lfs',handler:async c=>{const o=await c.state.store.overview();
   const doc=await Promise.resolve().then(()=>c.hub.state('inventory')?.read?.()).catch(()=>null),entries=Array.isArray(doc?.entries)?doc.entries:null;
   return c.json(200,{...o,connections:o.connections.map(x=>({...x,placement:entries?placementFor(x.web,entries):null}))});}},
  {method:'GET',path:'/api/git-lfs/objects',handler:async c=>c.json(200,c.state.store.list(c.query))},
  {method:'GET',path:'/api/git-lfs/audit',scope:GIT_LFS_SCOPE,handler:async c=>c.json(200,{items:c.state.store.readAudit()})},
  // A person who can read may ask for a fresh scan (throttled; it changes nothing on the hosts). An API key needs
  // git-lfs:write for it, so a read-only key in a script cannot keep the hub busy fetching.
  {method:'POST',path:'/api/git-lfs/refresh',scope:'read',async handler(c){
    if(c.principal.authKind==='api-key'&&!c.principal.scopes?.includes(GIT_LFS_SCOPE))return c.json(403,{error:{code:'SCOPE_REQUIRED',message:`This API key lacks the "${GIT_LFS_SCOPE}" scope.`}});
    return c.json(202,c.state.store.startRefresh(c.input));}},
  {method:'POST',path:'/api/git-lfs/test',scope:GIT_LFS_SCOPE,handler:async c=>c.json(200,await c.state.store.test(c.input))},
  {method:'POST',path:'/api/git-lfs/repos',scope:GIT_LFS_SCOPE,handler:async c=>c.json(200,await c.state.store.repoChoices(c.input))},
  {method:'POST',path:'/api/git-lfs/connections',scope:GIT_LFS_SCOPE,bodyLimit:32768,async handler(c){
    const created=c.input?.id===undefined,view=await c.state.store.save(c.input,c.principal.username);c.subject=view.id;
    c.state.store.refresh(view.id).catch(()=>{});
    return c.json(created?201:200,{connection:view});}},
  {method:'POST',path:'/api/git-lfs/connections/remove',scope:GIT_LFS_SCOPE,handler:async c=>c.json(200,await c.state.store.remove(c.input))},
  {method:'POST',path:'/api/git-lfs/delete/preview',scope:GIT_LFS_SCOPE,bodyLimit:65536,handler:async c=>c.json(200,c.state.store.preview(c.input))},
  {method:'POST',path:'/api/git-lfs/delete',scope:GIT_LFS_SCOPE,bodyLimit:65536,handler:async c=>c.json(200,await c.state.store.removeObjects(c.input,c.principal.username))},
 ].map(route),
 // Integrations → Machines: which machine runs a connected git host and which keeps its LFS files (from the inventory).
 provides:{[FACETS_POINT]:(state,hub)=>async machines=>{
  const off=!hub.integrationEnabled(GIT_LFS_INTEGRATION);if(off)return gitLfsFacet(machines,{off});
  const [o,doc]=await Promise.all([state.store.overview(),Promise.resolve().then(()=>hub.state('inventory')?.read?.()).catch(()=>null)]);
  return gitLfsFacet(machines,{connections:o.connections,entries:Array.isArray(doc?.entries)?doc.entries:null});}},
 integrations:[{id:GIT_LFS_INTEGRATION,title:'Git LFS (git hosty)',kind:'upstream',page:'git-lfs',docs:'docs/git-lfs.md',
  description:'Katalog LFS objektů repozitářů na GitHubu, Gitea a Forgejo přes jejich API a git (částečný mirror bez velkých souborů). Vypnutá: hub hosty nekontaktuje, katalog nečte a mazání odmítne.',
  howTo:'Na stránce Git LFS přidej připojení: druh hostu, adresu, token jen pro čtení a repozitáře.',
  status:integrationStatus}],
 apiDocs:[{title:'Git LFS',routes:[
  ['GET','/api/git-lfs','read','Druhy hostů s jejich schopnostmi, připojení (bez tokenů) a stav skenů.'],
  ['GET','/api/git-lfs/objects','read','LFS objekty: hledání, filtry (connection, repo, ext, status, minSize, maxSize), řazení, stránkování a součty.'],
  ['POST','/api/git-lfs/refresh','read','{connection?, repo?} spustí nový sken (nejvýš jednou za 30 s). API klíč potřebuje git-lfs:write.'],
  ['POST','/api/git-lfs/test','git-lfs:write','{provider, baseUrl?, token | connection} ověří token: kdo to je a jaká má oprávnění.'],
  ['POST','/api/git-lfs/repos','git-lfs:write','{provider, baseUrl?, token | connection, owner?} repozitáře, které token vidí.'],
  ['POST','/api/git-lfs/connections','git-lfs:write','{id?, provider, name, baseUrl?, token?, repoMode, owner?, repos?} založí nebo změní připojení.'],
  ['POST','/api/git-lfs/connections/remove','git-lfs:write','{id} odebere připojení, jeho token, katalog a mirrory.'],
  ['POST','/api/git-lfs/delete/preview','git-lfs:write','{connection, repo, oids} nebo {filter} → co by se smazalo a co ne a proč.'],
  ['POST','/api/git-lfs/delete','git-lfs:write','{connection, repo, oids, revision, requestId} smaže nepoužívané objekty po novém skenu (jen host, který mazání umí).'],
  ['GET','/api/git-lfs/audit','git-lfs:write','Posledních 50 záznamů auditu mazání.']]}],
};
