// Git LFS view (server/core/git-lfs.mjs, docs/git-lfs.md): connections to git hosts, their write-only tokens,
// the catalog of LFS objects per repository, and the guarded deletion path.
//
// Where things are kept:
//   <state>/git-lfs/connections.json        the connections (no token), 0600
//   <tokenFile> (private/git-lfs-tokens.json) {schemaVersion, tokens: {<connection id>: value}}, 0600, never sent back
//   <state>/git-lfs/<id>/catalog.json       the catalog of one connection, 0600
//   <state>/git-lfs/<id>/mirrors/<owner>/<name>.git   bare partial mirrors (no large blobs)
//   <state>/git-lfs/audit.jsonl             one line per deletion attempt, 0600
//
// Status of an object in one repository:
//   current    the default branch's tip has a file that points to it
//   history    some commit reachable from some ref points to it, the default branch's tip does not
//   orphaned   no commit reachable from any ref points to it, and it is known to exist: the host listed it, or
//              the hub saw it referenced earlier / still holds its pointer, and the host confirmed it stores it
// Deletion is offered only for "orphaned" objects the host confirmed, past the grace period, on a provider
// that can delete; it re-scans the repository first and refuses when anything changed (fail closed).
import {readFileSync} from 'node:fs';
import {mkdir,writeFile,rename,rm,appendFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import path from 'node:path';
import {syncMirror,scanMirror,remoteRefsHash,usageView,runGit,hashOf,OID,GitError} from './git-lfs-git.mjs';
import {BUILTIN_PROVIDERS,validProvider,providerView,contextFor,checkObjects,validFullName,validName,ProviderError} from './git-lfs-providers.mjs';
import {secretIn} from './home-devices.mjs';

// Seven days, as Gitea's own LFS garbage collection waits. GIT_LFS_GRACE_HOURS (server environment) changes it.
export const GRACE_MS=7*24*3600000;
export const graceFromEnv=(env=process.env)=>/^\d{1,5}$/.test(env.GIT_LFS_GRACE_HOURS||'')&&Number(env.GIT_LFS_GRACE_HOURS)>=1?Number(env.GIT_LFS_GRACE_HOURS)*3600000:GRACE_MS;
export const REFRESH_MINUTES=360;
export const MAX_REPOS=200;
export const MAX_DELETE=500;
// current = in the default branch's newest commit; branch = not there, but in the newest commit of another branch or
// tag; history = only in older commits; orphaned = no ref reaches it any more.
const STATUSES=['current','branch','history','orphaned'];
// A stored item says current/history/orphaned; whether a history item still sits at another tip is read from its refs.
const statusOf=item=>item.status==='history'&&item.refs?.length?'branch':item.status;
// Every branch and tag tip is read (a repository with more is rare; past this the rest are reported as skipped).
const TIP_LIMIT=500;
const SORTS=['size','path','repo','commit','lastSeen','oid','status'];
const CHECK_LIMIT=2000;// objects per repository whose storage is confirmed through the batch API in one scan
const DELETE_CHUNK=25;// deletions between two checks of the host's refs
const plain=v=>v&&typeof v==='object'&&!Array.isArray(v);
const fail=(code,detail)=>{throw Object.assign(new Error(code),detail?{detail}:{});};
const clean=(v,max)=>typeof v==='string'?v.replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,max):'';
const iso=ms=>new Date(ms).toISOString();
const ms=v=>v?Date.parse(v):NaN;

async function atomicJson(file,value){
 await mkdir(path.dirname(file),{recursive:true,mode:0o700});
 const tmp=`${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
 await writeFile(tmp,JSON.stringify(value)+'\n',{mode:0o600});await rename(tmp,file);
}
const readJson=file=>{try{return JSON.parse(readFileSync(file,'utf8'));}catch{return null;}};
export const extensionOf=p=>{const base=String(p||'').split('/').pop();const i=base.lastIndexOf('.');return i>0&&i<base.length-1?base.slice(i+1).toLowerCase().slice(0,16):'';};

// A value that may be a token: printable, no spaces, 8–512 characters.
export function validToken(v){return typeof v==='string'&&v.length>=8&&v.length<=512&&/^[\x21-\x7e]+$/.test(v);}

/**
 * options: stateDirectory, tokenFile, providers() → extra (plugin) providers, now() → ms, graceMs, git (binary),
 * isEnabled() → is the integration on.
 */
export function createGitLfsStore({stateDirectory,tokenFile,providers:extra=()=>[],now=Date.now,graceMs=graceFromEnv(),git,isEnabled=()=>true,log=console,checkLimit=CHECK_LIMIT,deleteChunk=DELETE_CHUNK,appendAudit=appendFile}={}){
 const base=path.join(stateDirectory,'git-lfs'),connectionsFile=path.join(base,'connections.json'),auditFile=path.join(base,'audit.jsonl');
 let connections=(()=>{const raw=readJson(connectionsFile);return raw?.schemaVersion===1&&Array.isArray(raw.connections)?raw.connections.filter(c=>plain(c)&&/^c[a-f0-9]{10}$/.test(c.id)):[];})();
 let tokens=null;
 const loadTokens=()=>{if(tokens)return tokens;const raw=readJson(tokenFile);tokens=plain(raw?.tokens)?{...raw.tokens}:{};return tokens;};
 const catalogs=new Map(),running=new Map(),deleting=new Set(),jobs=new Map(),lastRefresh=new Map();
 let queue=Promise.resolve();const serial=fn=>(queue=queue.catch(()=>{}).then(fn));
 let gitState=null;// null = not checked; {ok, version}
 const warned=new Set();

 // --- providers ---------------------------------------------------------------------------------------
 function allProviders(){
  const list=[...BUILTIN_PROVIDERS];
  let more=[];try{more=(extra()||[]).flat();}catch{more=[];}
  for(const p of more){
   if(!validProvider(p)||list.some(x=>x.id===p.id)){if(!warned.has(p?.id)){warned.add(p?.id);log.error?.(`Git LFS: provider ${JSON.stringify(p?.id)} from a plugin is not valid or clashes; it is left out.`);}continue;}
   list.push({...p,kind:'plugin'});
  }
  return list;
 }
 const provider=id=>allProviders().find(p=>p.id===id)||null;
 const tokenOf=id=>{const v=loadTokens()[id];return typeof v==='string'&&v?v:null;};
 const saveConnections=()=>atomicJson(connectionsFile,{schemaVersion:1,connections});
 const saveTokens=next=>serial(async()=>{await atomicJson(tokenFile,{schemaVersion:1,tokens:next});tokens=next;});
 const connection=id=>connections.find(c=>c.id===id)||null;
 const ctxOf=(c,p=provider(c.provider))=>({...contextFor(p,{baseUrl:c.baseUrl,token:tokenOf(c.id),login:c.login}),stopped:()=>!isEnabled()});
 // fullName comes from a provider (a plugin's too) or a catalog file: checked here, so no name can reach a path
 // outside this connection's mirrors directory (and so no rm -rf can either).
 const mirrorDir=(c,fullName)=>{
  if(!validFullName(fullName))fail('invalid-repo');
  const [o,n]=fullName.split('/'),root=path.join(base,c.id,'mirrors'),dir=path.join(root,o,n+'.git');
  if(path.relative(root,dir).startsWith('..'))fail('invalid-repo');
  return dir;
 };
 // A repository as a provider describes it, checked: owner, name and fullName agree and are plain names.
 const validRepo=r=>plain(r)&&validName(r.owner)&&validName(r.name)&&r.fullName===`${r.owner}/${r.name}`;

 async function gitCheck(){
  if(gitState&&gitState.ok)return gitState;
  try{const out=(await runGit(['--version'],{git,timeoutMs:10000})).toString().trim();gitState={ok:true,version:out.replace(/^git version /,'').slice(0,60)};}
  catch{gitState={ok:false,version:null};}
  return gitState;
 }

 // --- catalog -----------------------------------------------------------------------------------------
 function catalogOf(id){
  if(catalogs.has(id))return catalogs.get(id);
  const raw=readJson(path.join(base,id,'catalog.json'));
  const cat=raw?.format===1&&plain(raw.repos)?raw:{format:1,connection:id,repos:{}};
  catalogs.set(id,cat);return cat;
 }
 const saveCatalog=id=>atomicJson(path.join(base,id,'catalog.json'),catalogOf(id));

 // Which repositories a connection covers: the selected list, or what the host lists now (owner / all).
 async function reposFor(c,p,ctx){
  if(c.repoMode==='selected')return c.repos.slice(0,MAX_REPOS).map(fullName=>({fullName}));
  const list=await p.listRepos(ctx,{owner:c.repoMode==='owner'?c.owner:undefined});
  if(!Array.isArray(list))fail('bad-response');
  // A listing with a name that is not a plain owner/name fails as a whole: dropping the entry silently would
  // make the repository look removed (and its catalog and mirror would go).
  if(list.some(r=>!validRepo(r)))fail('bad-response');
  const sorted=[...list].sort((a,b)=>a.fullName.localeCompare(b.fullName));
  return sorted.slice(0,MAX_REPOS).map(r=>({fullName:r.fullName,info:r,truncated:sorted.length>MAX_REPOS}));
 }

 /**
  * Scans one repository and returns its catalog entry (not saved). Throws on anything incomplete.
  * previous = the entry from the last scan (timestamps and remembered paths carry over).
  */
 async function scanRepo(c,p,ctx,fullName,previous,{info}={}){
  const at=now();
  const repo=info&&info.fullName===fullName?info:await p.getRepo(ctx,fullName);
  if(!validRepo(repo))fail('bad-response');
  if(repo.fullName!==fullName)fail('repo-mismatch');
  const dir=mirrorDir(c,fullName);
  await syncMirror(dir,`${ctx.web}/${repo.owner}/${repo.name}.git`,{header:ctx.gitAuthHeader},{git});
  const scan=await scanMirror(dir,{defaultBranch:repo.defaultBranch,git,tipLimit:TIP_LIMIT});
  const prev=new Map((previous?.items||[]).map(i=>[i.oid,i]));
  // What the host stores: listed (a provider that can list) or confirmed one by one through the batch API.
  let listed=null;
  if(p.capabilities.listObjects){
   const list=await p.listObjects(ctx,repo);
   if(!Array.isArray(list))fail('bad-response');
   listed=new Map();
   for(const o of list){if(!plain(o)||!OID.test(o.oid||'')||!Number.isSafeInteger(o.size)||o.size<0)fail('bad-response');listed.set(o.oid,{size:o.size,createdAt:o.createdAt&&Number.isFinite(Date.parse(o.createdAt))?new Date(Date.parse(o.createdAt)).toISOString():null});}
  }
  const referenced=scan.pointers;
  const candidates=new Map();
  for(const [oid,old] of prev)if(!referenced.has(oid))candidates.set(oid,{oid,size:old.size});
  for(const u of scan.unreachable)if(!referenced.has(u.oid)&&!candidates.has(u.oid))candidates.set(u.oid,u);
  if(listed)for(const [oid,o] of listed)if(!referenced.has(oid)&&!candidates.has(oid))candidates.set(oid,{oid,size:o.size});
  const stored=new Map();let storedCheck='skipped';
  if(listed){for(const oid of [...candidates.keys(),...referenced.keys()])stored.set(oid,listed.has(oid));storedCheck='listed';}
  else if(p.capabilities.checkObjects){
   // Candidates first (they decide what is reclaimable), then referenced objects up to the limit.
   const want=[...candidates.values(),...[...referenced.values()].map(u=>({oid:u.oid,size:u.size}))].slice(0,checkLimit);
   try{const map=await checkObjects(ctx,repo,want);for(const [k,v] of map)stored.set(k,v);storedCheck=want.length<candidates.size+referenced.size?'partial':'ok';}
   catch(e){if(e instanceof ProviderError&&['auth','forbidden','not-found'].includes(e.code))throw e;storedCheck='failed';}
  }
  const items=[];
  for(const u of referenced.values()){
   const v=usageView(u),old=prev.get(u.oid);
   items.push({...v,size:v.size??old?.size??listed?.get(u.oid)?.size??null,status:v.currentPaths.length?'current':'history',stored:stored.has(u.oid)?stored.get(u.oid):null,
    firstSeenAt:old?.firstSeenAt||iso(at),lastSeenAt:iso(at),lastReferencedAt:iso(at),unreferencedSince:null,createdAt:listed?.get(u.oid)?.createdAt||old?.createdAt||null});
  }
  for(const cnd of candidates.values()){
   const s=stored.has(cnd.oid)?stored.get(cnd.oid):null,old=prev.get(cnd.oid);
   if(s===false)continue;// the host no longer has it: nothing to show or reclaim
   items.push({oid:cnd.oid,size:cnd.size??old?.size??listed?.get(cnd.oid)?.size??null,status:'orphaned',stored:s,
    // Where it used to be, as the hub last saw it (remembered, not current).
    paths:old?.paths||[],pathCount:old?.pathCount||0,currentPaths:[],refs:[],refCount:0,via:[],firstCommit:old?.firstCommit||null,lastCommit:old?.lastCommit||null,commits:old?.commits||0,remembered:Boolean(old?.paths?.length),
    firstSeenAt:old?.firstSeenAt||iso(at),lastSeenAt:iso(at),lastReferencedAt:old?.lastReferencedAt||null,unreferencedSince:old?.unreferencedSince||iso(at),
    createdAt:listed?.get(cnd.oid)?.createdAt||old?.createdAt||null});
  }
  items.sort((a,b)=>a.oid<b.oid?-1:1);
  // No commit to read, but objects the hub knows of: the host advertised no refs (an empty answer, a
  // permission that hides them) or its default branch is not among them. Everything would look orphaned,
  // so the scan is not trusted for deletion. A repository that is empty and stores nothing is fine.
  const knows=items.length>0||(previous?.items||[]).length>0;
  const incomplete=!scan.refs.length&&knows?'no-refs':!scan.defaultRef&&knows?'no-default-branch':null;
  return {fullName,owner:repo.owner,name:repo.name,defaultBranch:repo.defaultBranch,defaultRef:scan.defaultRef,private:repo.private,
   state:'ok',error:null,scannedAt:iso(at),finishedAt:iso(now()),// A failed storage check makes the scan incomplete (nothing is deletable); a partial one leaves the
   // objects it did not reach "storage-unknown", one by one.
   complete:scan.complete&&storedCheck!=='failed'&&!incomplete,storedCheck,incomplete,
   refsRevision:scan.revision,listed:Boolean(listed),revision:revisionOf(scan.revision,Boolean(listed),items),refs:scan.refs.length,stats:scan.stats,items};
 }

 // What a deletion must quote: the refs, and for a host that lists, what it stores (every item it confirmed). The
// same function after a deletion, so the next preview matches the host as it now is.
const revisionOf=(refs,listed,items)=>hashOf({refs,stored:listed?hashOf(items.filter(i=>i.stored===true).map(i=>i.oid).sort().join('\n')):null});
const errorCode=e=>e instanceof GitError||e instanceof ProviderError?e.code:/^[a-z-]{2,30}$/.test(e?.message||'')?e.message:'failed';
 // Refreshes every repository of one connection, one after the other. One run per connection at a time.
 function refresh(id,{repo:only=null}={}){
  if(running.has(id))return running.get(id);
  if(deleting.has(id))return Promise.reject(new Error('busy'));
  const job=(async()=>{
   const c=connection(id);if(!c)fail('not-found');
   const p=provider(c.provider);if(!p)fail('provider-missing');
   if(!tokenOf(id))fail('token-missing');
   if(!(await gitCheck()).ok)fail('git-missing');
   const ctx=ctxOf(c,p),cat=catalogOf(id);
   cat.startedAt=iso(now());cat.error=null;
   let repos;
   try{repos=only?[{fullName:only}]:await reposFor(c,p,ctx);}
   catch(e){cat.error=errorCode(e);cat.finishedAt=iso(now());cat.fullFinishedAt=cat.finishedAt;await saveCatalog(id);throw e;}
   if(!only){
    cat.truncated=repos.some(r=>r.truncated);
    // Repositories no longer covered: drop their entries and mirrors.
    for(const name of Object.keys(cat.repos))if(!repos.some(r=>r.fullName===name)){delete cat.repos[name];let dir=null;try{dir=mirrorDir(c,name);}catch{}if(dir)await rm(dir,{recursive:true,force:true});}
   }
   for(const r of repos){
    if(!isEnabled())break;
    const previous=cat.repos[r.fullName];
    try{cat.repos[r.fullName]=await scanRepo(c,p,ctx,r.fullName,previous,{info:r.info});}
    catch(e){cat.repos[r.fullName]={...(previous||{fullName:r.fullName,items:[]}),state:'error',error:errorCode(e),complete:false,failedAt:iso(now())};}
    await saveCatalog(id);
   }
   cat.finishedAt=iso(now());
   // A scan of one repository does not count as the periodic full scan (due() reads fullFinishedAt).
   if(!only)cat.fullFinishedAt=cat.finishedAt;
   await saveCatalog(id);
   return cat;
  })().finally(()=>{running.delete(id);lastRefresh.set(id,now());});
  running.set(id,job);
  return job;
 }

 // --- eligibility -------------------------------------------------------------------------------------
 // Why an object may not be deleted, or null. capability = the provider can delete at all.
 function refusal(item,entry,p,{t=now()}={}){
  if(item.status==='current')return 'current';
  if(item.status==='history')return statusOf(item);
  if(!entry||entry.state!=='ok'||!entry.complete)return 'unverified';
  if(item.stored!==true)return 'storage-unknown';
  const since=Math.max(...[item.unreferencedSince,item.createdAt,item.lastReferencedAt].map(ms).filter(Number.isFinite),-Infinity);
  if(!Number.isFinite(since)||t-since<graceMs)return 'grace';
  if(!p?.capabilities.deleteObjects)return 'unsupported';
  return null;
 }
 const reclaimable=(item,entry,p,t)=>{const r=refusal(item,entry,p,{t});return r===null||r==='unsupported';};

 // --- views ---------------------------------------------------------------------------------------------
 function connectionView(c){
  const p=provider(c.provider),cat=catalogOf(c.id);let web=null;try{web=p?p.endpoints(c.baseUrl).web:null;}catch{}
  const repos=Object.values(cat.repos).map(r=>({fullName:r.fullName,state:r.state,error:r.error||null,scannedAt:r.scannedAt||null,complete:Boolean(r.complete),incomplete:r.incomplete||null,storedCheck:r.storedCheck||null,
   defaultBranch:r.defaultBranch||null,refs:r.refs??null,objects:(r.items||[]).length,bytes:(r.items||[]).reduce((n,i)=>n+(i.size||0),0),url:web?`${web}/${r.fullName}`:null}));
  return {id:c.id,provider:c.provider,providerTitle:p?.title||c.provider,providerMissing:!p,name:c.name,baseUrl:c.baseUrl,web,plainHttp:/^http:/.test(c.baseUrl||web||''),
   repoMode:c.repoMode,owner:c.owner||null,repos:c.repoMode==='selected'?[...c.repos]:[],login:c.login||null,scopes:c.scopes||null,tokenSet:Boolean(tokenOf(c.id)),
   createdAt:c.createdAt,createdBy:c.createdBy||null,updatedAt:c.updatedAt||null,updatedBy:c.updatedBy||null,
   capabilities:p?{...p.capabilities}:null,
   scan:{running:running.has(c.id),startedAt:cat.startedAt||null,finishedAt:cat.finishedAt||null,error:cat.error||null,truncated:Boolean(cat.truncated),repos}};
 }
 async function overview(){
  return {schemaVersion:1,generatedAt:iso(now()),enabled:isEnabled(),graceHours:Math.round(graceMs/3600000),refreshMinutes:REFRESH_MINUTES,maxDelete:MAX_DELETE,
   git:await gitCheck(),providers:allProviders().map(providerView),connections:connections.map(connectionView)};
 }

 // Every object of the catalogs as rows: one per (repository, oid).
 function rows(t=now()){
  const out=[];
  for(const c of connections){
   const p=provider(c.provider),cat=catalogOf(c.id);let web=null;try{web=p?p.endpoints(c.baseUrl).web:null;}catch{}
   for(const entry of Object.values(cat.repos))for(const item of entry.items||[]){
    const why=refusal(item,entry,p,{t});
    out.push({...item,status:statusOf(item),defaultBranch:entry.defaultBranch||null,connection:c.id,connectionName:c.name,provider:c.provider,repo:entry.fullName,extension:extensionOf(item.currentPaths?.[0]||item.paths?.[0]),
     reclaimable:why===null||why==='unsupported',canDelete:why===null,deleteBlocked:why,repoUrl:web?`${web}/${entry.fullName}`:null,
     ...(item.status==='orphaned'&&why==='unsupported'&&p&&web?{manual:p.manual(web,{owner:entry.owner||entry.fullName.split('/')[0],name:entry.name||entry.fullName.split('/')[1]},item.oid)}:{})});
   }
  }
  return out;
 }
 const totals=list=>{
  const t={count:list.length,bytes:0,reclaimableCount:0,reclaimableBytes:0,byStatus:Object.fromEntries(STATUSES.map(s=>[s,{count:0,bytes:0}]))};
  for(const i of list){t.bytes+=i.size||0;t.byStatus[i.status].count++;t.byStatus[i.status].bytes+=i.size||0;if(i.reclaimable){t.reclaimableCount++;t.reclaimableBytes+=i.size||0;}}
  return t;
 };
 const matches=(i,f)=>(!f.connection||i.connection===f.connection)&&(!f.repo||i.repo===f.repo)&&(!f.status||i.status===f.status)&&(f.ext===null||i.extension===f.ext)
  &&(f.minSize==null||(i.size??0)>=f.minSize)&&(f.maxSize==null||(i.size??0)<=f.maxSize)
  &&(!f.q||[i.oid,i.repo,...(i.paths||[]),...(i.refs||[])].join('\n').toLowerCase().includes(f.q));
 function list(query){
  const f=listQuery(query),all=rows(),scoped=all.filter(i=>(!f.connection||i.connection===f.connection)&&(!f.repo||i.repo===f.repo));
  const hits=all.filter(i=>matches(i,f));
  const dir=f.dir==='asc'?1:-1,key={size:i=>i.size??-1,path:i=>(i.currentPaths[0]||i.paths[0]||'~').toLowerCase(),repo:i=>i.repo,commit:i=>i.lastCommit?.at||'',lastSeen:i=>i.lastSeenAt||'',oid:i=>i.oid,status:i=>STATUSES.indexOf(i.status)}[f.sort];
  hits.sort((a,b)=>{const x=key(a),y=key(b);return (x<y?-1:x>y?1:0)*dir||(a.oid<b.oid?-1:a.oid>b.oid?1:0)||a.repo.localeCompare(b.repo);});
  const exts=new Map();for(const i of scoped)exts.set(i.extension,(exts.get(i.extension)||0)+1);
  return {schemaVersion:1,generatedAt:iso(now()),enabled:isEnabled(),query:f,total:hits.length,offset:f.offset,limit:f.limit,
   totals:totals(scoped),filtered:totals(hits),extensions:[...exts].map(([ext,count])=>({ext,count})).sort((a,b)=>b.count-a.count).slice(0,60),
   items:hits.slice(f.offset,f.offset+f.limit)};
 }

 // --- connections -------------------------------------------------------------------------------------
 // Which provider + base URL + token a test or a repository listing uses: a new token, or the stored one
 // of an existing connection, but only for the same provider and host (a stored token never goes elsewhere).
 function resolveTarget(input){
  if(!plain(input))fail('invalid','expected an object');
  const p=provider(input.provider);if(!p)fail('invalid','unknown provider');
  let baseUrl;try{baseUrl=p.fixedBaseUrl&&!input.baseUrl?p.fixedBaseUrl:input.baseUrl;p.endpoints(baseUrl);}catch{fail('invalid','baseUrl is not a usable http(s) URL of this provider');}
  let token=input.token,login=null;
  if(token!==undefined&&token!==null&&token!==''){if(!validToken(token))fail('invalid','token must be 8–512 printable characters');}
  else{
   const c=typeof input.connection==='string'?connection(input.connection):null;if(!c)fail('token-required');
   if(c.provider!==p.id||normalBase(p,c.baseUrl)!==normalBase(p,baseUrl))fail('token-required');
   token=tokenOf(c.id);login=c.login;if(!token)fail('token-required');
  }
  return {p,baseUrl,token,login};
 }
 const normalBase=(p,u)=>{try{const e=p.endpoints(u);return e.api+' '+e.web;}catch{return null;}};
 async function test(input){
  const {p,baseUrl,token}=resolveTarget(only(input,['provider','baseUrl','token','connection']));
  const ctx=contextFor(p,{baseUrl,token});
  const me=await p.whoami(ctx);
  return {ok:true,provider:p.id,web:ctx.web,api:ctx.api,plainHttp:ctx.web.startsWith('http:'),user:{login:clean(me.login,100),name:me.name?clean(me.name,120):null},
   scopes:me.scopes?me.scopes.map(s=>clean(s,60)).slice(0,40):null,scopesNote:me.scopesNote||null,warnings:(me.warnings||[]).slice(0,6),capabilities:{...p.capabilities},git:await gitCheck()};
 }
 async function repoChoices(input){
  const i=only(input,['provider','baseUrl','token','connection','owner']);
  if(i.owner!==undefined&&i.owner!==''&&!validName(i.owner))fail('invalid','owner is not a valid name');
  const {p,baseUrl,token,login}=resolveTarget(i);
  const ctx=contextFor(p,{baseUrl,token,login});
  const list=(await p.listRepos(ctx,{owner:i.owner||undefined})).sort((a,b)=>a.fullName.localeCompare(b.fullName));
  return {repos:list.slice(0,1000).map(r=>({fullName:r.fullName,owner:r.owner,private:r.private,archived:r.archived,defaultBranch:r.defaultBranch})),total:list.length,truncated:list.length>1000};
 }
 function only(input,keys){if(!plain(input)||Object.keys(input).some(k=>!keys.includes(k)))fail('invalid',`expected ${keys.join(', ')}`);return input;}

 async function save(input,actor){
  const i=only(input,['id','provider','name','baseUrl','token','repoMode','owner','repos']);
  const existing=i.id!==undefined?connection(i.id):null;if(i.id!==undefined&&!existing)fail('not-found');
  const p=provider(i.provider);if(!p)fail('invalid','unknown provider');
  const name=clean(i.name,80);if(!name)fail('invalid','name is required (at most 80 characters)');if(secretIn(name))fail('invalid','name looks like a secret');
  // Stored as the host's web address (github.com, https://ghe.example.com, https://git.example.com/sub).
  let baseUrl;try{baseUrl=p.endpoints(p.fixedBaseUrl&&!i.baseUrl?p.fixedBaseUrl:i.baseUrl).web;}catch{fail('invalid','baseUrl is not a usable http(s) URL of this provider');}
  if(!['all','owner','selected'].includes(i.repoMode))fail('invalid','repoMode is all, owner or selected');
  const owner=i.repoMode==='owner'?i.owner:null;if(i.repoMode==='owner'&&!validName(owner))fail('invalid','owner is required for repoMode owner');
  let repos=[];
  if(i.repoMode==='selected'){
   if(!Array.isArray(i.repos)||!i.repos.length||i.repos.length>MAX_REPOS||i.repos.some(r=>!validFullName(r)))fail('invalid',`repos lists 1–${MAX_REPOS} owner/name`);
   repos=[...new Set(i.repos)].sort();
  }
  // A new host or provider needs a new token: a stored token is never sent to a host it was not made for.
  const sameTarget=existing&&existing.provider===p.id&&normalBase(p,existing.baseUrl)===normalBase(p,baseUrl);
  const newToken=i.token!==undefined&&i.token!==null&&i.token!=='';
  if(newToken&&!validToken(i.token))fail('invalid','token must be 8–512 printable characters');
  if(!newToken&&!sameTarget)fail('token-required');
  if(existing&&!sameTarget&&(running.has(existing.id)||deleting.has(existing.id)))fail('busy');
  const token=newToken?i.token:tokenOf(existing.id);if(!token)fail('token-required');
  // The token is checked before anything is stored: who it is (the git user name for Gitea and Forgejo).
  const me=await p.whoami(contextFor(p,{baseUrl,token}));
  // A scan or a deletion may have started while the host answered; a changed host removes the catalog and mirrors.
  if(existing&&!sameTarget&&(running.has(existing.id)||deleting.has(existing.id)))fail('busy');
  if(existing&&!connection(existing.id))fail('not-found');
  const at=iso(now()),id=existing?.id||'c'+randomBytes(5).toString('hex');
  const next={id,provider:p.id,name,baseUrl,repoMode:i.repoMode,owner,repos,login:clean(me.login,100),scopes:me.scopes?me.scopes.map(s=>clean(s,60)).slice(0,40):null,
   createdAt:existing?.createdAt||at,createdBy:existing?.createdBy||clean(actor,80)||null,updatedAt:existing?at:null,updatedBy:existing?clean(actor,80)||null:null};
  const targetChanged=existing&&!sameTarget;
  // From here until the old catalog is gone, the connection counts as busy: no scan can start in between and
  // write the old host's catalog or mirrors under the new host.
  if(targetChanged)deleting.add(id);
  try{
   if(newToken)await saveTokens({...loadTokens(),[id]:token});
   if(targetChanged){catalogs.delete(id);await rm(path.join(base,id),{recursive:true,force:true});}
   connections=existing?connections.map(c=>c.id===id?next:c):[...connections,next];
   await saveConnections();
  }finally{if(targetChanged)deleting.delete(id);}
  return connectionView(next);
 }
 async function remove(input){
  const i=only(input,['id']);const c=connection(i.id);if(!c)fail('not-found');
  if(running.has(c.id)||deleting.has(c.id))fail('busy');
  connections=connections.filter(x=>x.id!==c.id);await saveConnections();
  const next={...loadTokens()};delete next[c.id];await saveTokens(next);
  catalogs.delete(c.id);await rm(path.join(base,c.id),{recursive:true,force:true});
  return {removed:c.id};
 }
 function startRefresh(input,{throttleMs=30000}={}){
  const i=only(input??{},['connection','repo']);
  const ids=i.connection!==undefined?[i.connection]:connections.map(c=>c.id);
  if(i.connection!==undefined&&!connection(i.connection))fail('not-found');
  if(i.repo!==undefined&&(i.connection===undefined||!validFullName(i.repo)||!catalogOf(i.connection).repos[i.repo]))fail('invalid','repo needs connection and must be one of its repositories');
  const started=[],skipped=[];
  for(const id of ids){
   if(running.has(id)||deleting.has(id)){skipped.push({connection:id,reason:'running'});continue;}
   if(now()-(lastRefresh.get(id)||0)<throttleMs){skipped.push({connection:id,reason:'throttled'});continue;}
   refresh(id,{repo:i.repo}).catch(()=>{});started.push(id);
  }
  return {started,skipped};
 }

 // --- deletion ----------------------------------------------------------------------------------------
 const REASONS={current:'Na výchozí větvi ho používá aktuální soubor.',history:'Odkazuje na něj historie (commit dosažitelný z některé větve nebo tagu). Smazat by šel jen po přepsání historie, a to hub nedělá.',
  unverified:'Poslední sken repozitáře neproběhl celý; mazání je zablokované.','storage-unknown':'Host nepotvrdil, že objekt ještě má.',grace:'Chráněné ochrannou lhůtou po posledním nahrání nebo odkazu.',
  unsupported:'Tenhle host neumí LFS objekty mazat přes API.','not-found':'Objekt v katalogu není.','in-use-elsewhere':'Stejný objekt používá jiný repozitář na tomtéž hostu.',
  'refs-changed':'Refy na hostu se během mazání změnily; zbytek se nesmazal. Obnov náhled.','refs-unverified':'Refy hostu se nepodařilo znovu přečíst; zbytek se nesmazal.',
  'audit-failed':'Záznam do auditu se nepodařilo zapsat; zbytek se nesmazal.'};
 // Objects of the same host that another repository still references: deleting them could break that one.
 function referencedElsewhere(c,fullName){
  const p=provider(c.provider);let web=null;try{web=p.endpoints(c.baseUrl).web;}catch{return new Set();}
  const out=new Set();
  for(const other of connections){
   const q=provider(other.provider);let w=null;try{w=q?.endpoints(other.baseUrl).web;}catch{}
   if(w!==web)continue;
   for(const entry of Object.values(catalogOf(other.id).repos))if(!(other.id===c.id&&entry.fullName===fullName))for(const i of entry.items||[])if(i.status!=='orphaned')out.add(i.oid);
  }
  return out;
 }
 function deleteTarget(i){
  const c=connection(i.connection);if(!c)fail('not-found');
  const p=provider(c.provider);if(!p)fail('provider-missing');
  if(!validFullName(i.repo)||!catalogOf(c.id).repos[i.repo])fail('invalid','repo must be one of the connection\'s repositories');
  return {c,p};
 }
 const oidList=v=>{if(!Array.isArray(v)||!v.length||v.length>MAX_DELETE||v.some(o=>typeof o!=='string'||!OID.test(o)))fail('invalid',`oids lists 1–${MAX_DELETE} sha256 object ids`);return [...new Set(v)];};
 // What a deletion would remove: per repository, the eligible objects (with paths and sizes) and the refused
 // ones with why, plus the revision the deletion must quote. filter = the list's filter (status forced to orphaned).
 function preview(input){
  const i=only(input,['connection','repo','oids','filter']);
  const groups=[];
  if(i.oids!==undefined){
   const {c,p}=deleteTarget(i),oids=oidList(i.oids),entry=catalogOf(c.id).repos[i.repo],elsewhere=referencedElsewhere(c,i.repo),t=now();
   groups.push(group(c,p,entry,oids.map(oid=>entry.items.find(x=>x.oid===oid)||{oid,missing:true}),elsewhere,t));
  }else{
   const f=listQuery({...(plain(i.filter)?i.filter:{}),status:'orphaned',offset:'0',limit:'1'});
   if(i.connection!==undefined)f.connection=i.connection;if(i.repo!==undefined)f.repo=i.repo;
   const t=now();
   for(const c of connections){
    if(f.connection&&c.id!==f.connection)continue;const p=provider(c.provider);if(!p)continue;
    for(const entry of Object.values(catalogOf(c.id).repos)){
     if(f.repo&&entry.fullName!==f.repo)continue;
     const picked=rows(t).filter(r=>r.connection===c.id&&r.repo===entry.fullName&&matches(r,f)).slice(0,MAX_DELETE).map(r=>entry.items.find(x=>x.oid===r.oid));
     if(picked.length)groups.push(group(c,p,entry,picked,referencedElsewhere(c,entry.fullName),t));
    }
   }
  }
  return {schemaVersion:1,generatedAt:iso(now()),graceHours:Math.round(graceMs/3600000),groups,
   eligibleCount:groups.reduce((n,g)=>n+g.eligible.length,0),eligibleBytes:groups.reduce((n,g)=>n+g.bytes,0)};
 }
 function group(c,p,entry,items,elsewhere,t){
  const eligible=[],refused=[];
  for(const item of items){
   if(item.missing){refused.push({oid:item.oid,reason:'not-found',message:REASONS['not-found']});continue;}
   const why=refusal(item,entry,p,{t})||(elsewhere.has(item.oid)?'in-use-elsewhere':null);
   if(why)refused.push({oid:item.oid,size:item.size,status:item.status,reason:why,message:REASONS[why]});
   else eligible.push({oid:item.oid,size:item.size,paths:(item.paths||[]).slice(0,5),lastCommit:item.lastCommit||null,unreferencedSince:item.unreferencedSince,createdAt:item.createdAt});
  }
  let web=null;try{web=p.endpoints(c.baseUrl).web;}catch{}
  return {connection:c.id,connectionName:c.name,provider:p.id,repo:entry.fullName,revision:entry.revision||null,scannedAt:entry.scannedAt||null,canDelete:p.capabilities.deleteObjects,
   ...(p.capabilities.deleteObjects||!web?{}:{manual:p.manual(web,{owner:entry.owner||entry.fullName.split('/')[0],name:entry.name||entry.fullName.split('/')[1]},null)}),
   eligible,refused,bytes:eligible.reduce((n,e)=>n+(e.size||0),0)};
 }
 async function audit(line){
  try{await mkdir(base,{recursive:true,mode:0o700});await appendAudit(auditFile,JSON.stringify(line)+'\n',{mode:0o600});}
  catch(e){log.error?.(`Git LFS: the audit log could not be written (${e.code||e.message}).`);throw new Error('audit-failed');}
 }
 /**
  * Deletes orphaned objects of one repository. input = {connection, repo, oids, revision, requestId}.
  * The repository is scanned again first; if its refs or the host's stored list changed since the preview
  * (revision), nothing is deleted. Every object is checked once more against the fresh scan.
  */
 async function removeObjects(input,actor){
  const i=only(input,['connection','repo','oids','revision','requestId']);
  if(typeof i.requestId!=='string'||!/^[A-Za-z0-9-]{8,64}$/.test(i.requestId))fail('invalid','requestId is 8–64 letters, digits or dashes');
  if(typeof i.revision!=='string'||!OID.test(i.revision))fail('invalid','revision is the preview\'s revision');
  const oids=oidList(i.oids);
  if(jobs.has(i.requestId)){const done=jobs.get(i.requestId);if(done.connection!==i.connection||done.repo!==i.repo)fail('conflict');return {...done.result,repeated:true};}
  const {c,p}=deleteTarget(i);
  if(!p.capabilities.deleteObjects)fail('unsupported');
  if(!tokenOf(c.id))fail('token-missing');
  if(deleting.has(c.id)||running.has(c.id))fail('busy');
  deleting.add(c.id);
  try{
   const cat=catalogOf(c.id),before=cat.repos[i.repo];
   if(!before||before.revision!==i.revision)fail('conflict');
   // Fresh scan, right now: refs, pointers and what the host stores. Any failure blocks the deletion.
   const ctx=ctxOf(c,p);let fresh;
   try{fresh=await scanRepo(c,p,ctx,i.repo,before);}
   catch(e){cat.repos[i.repo]={...before,state:'error',error:errorCode(e),complete:false,failedAt:iso(now())};await saveCatalog(c.id);fail('unverified');}
   cat.repos[i.repo]=fresh;await saveCatalog(c.id);
   if(!fresh.complete)fail('unverified');
   if(fresh.revision!==i.revision)fail('conflict');
   const elsewhere=referencedElsewhere(c,i.repo),t=now(),deleted=[],refused=[],failed=[],plan=[];
   for(const oid of oids){
    const item=fresh.items.find(x=>x.oid===oid);
    const why=!item?'not-found':refusal(item,fresh,p,{t})||(elsewhere.has(oid)?'in-use-elsewhere':null);
    if(why)refused.push({oid,reason:why,message:REASONS[why]});else plan.push({oid,item});
   }
   // The host's refs, read again (git ls-remote) before every chunk of deletions and once at the end: a push
   // after the re-scan stops the rest. null = could not be read, which stops it too.
   const url=`${ctx.web}/${fresh.owner}/${fresh.name}.git`;
   const refsNow=async()=>{try{return await remoteRefsHash(url,{header:ctx.gitAuthHeader},{git});}catch{return null;}};
   let stopped=null,next=0;
   while(next<plan.length){
    if(next%deleteChunk===0){const h=await refsNow();if(h!==fresh.refsRevision){stopped=h===null?'refs-unverified':'refs-changed';break;}}
    const {oid,item}=plan[next];
    const line={at:iso(now()),requestId:i.requestId,actor:clean(actor,80)||null,connection:c.id,provider:p.id,host:ctx.web,repo:i.repo,oid,size:item.size,revision:fresh.revision};
    // No audit line, no deletion: a failed "started" line stops before this object.
    try{await audit({...line,result:'started'});}catch{stopped='audit-failed';break;}
    next++;
    let error=null;
    try{await p.deleteObject(ctx,{owner:fresh.owner,name:fresh.name,fullName:fresh.fullName},oid);}catch(e){error=errorCode(e);}
    if(error)failed.push({oid,error});else deleted.push({oid,size:item.size});
    // What happened is reported whatever the audit does next; a failed result line stops the rest.
    try{await audit({...line,at:iso(now()),result:error?'failed':'deleted',...(error?{error}:{})});}catch{stopped='audit-failed';break;}
   }
   for(const {oid,item} of plan.slice(next))refused.push({oid,size:item.size,reason:stopped,message:REASONS[stopped]});
   // After the last deletion: did the refs change while it ran? Reported, nothing more can be undone.
   let refsChangedDuring=false;
   if(deleted.length&&!stopped){const h=await refsNow();refsChangedDuring=h!==fresh.refsRevision;}
   if(deleted.length){
    const gone=new Set(deleted.map(d=>d.oid));fresh.items=fresh.items.filter(x=>!gone.has(x.oid));
    // The revision now describes the host without these objects, so the next preview and deletion agree with it.
    fresh.revision=revisionOf(fresh.refsRevision,fresh.listed,fresh.items);
    await saveCatalog(c.id);
   }
   const result={requestId:i.requestId,connection:c.id,repo:i.repo,deleted,refused,failed,bytes:deleted.reduce((n,d)=>n+(d.size||0),0),
    ...(stopped?{stopped,stoppedMessage:REASONS[stopped]}:{}),...(refsChangedDuring?{refsChangedDuring:true}:{})};
   jobs.set(i.requestId,{connection:c.id,repo:i.repo,result});if(jobs.size>200)jobs.delete(jobs.keys().next().value);
   return result;
  }finally{deleting.delete(c.id);}
 }
 function readAudit({limit=50}={}){
  let text='';try{text=readFileSync(auditFile,'utf8');}catch{return [];}
  return text.trim().split('\n').filter(Boolean).slice(-limit).map(l=>{try{return JSON.parse(l);}catch{return null;}}).filter(Boolean).reverse();
 }

 // For the integration card and the poller.
 function status(){
  return connections.map(c=>{const cat=catalogOf(c.id),repos=Object.values(cat.repos);
   return {id:c.id,name:c.name,provider:c.provider,running:running.has(c.id),finishedAt:cat.finishedAt||null,error:cat.error||null,
    repos:repos.length,failed:repos.filter(r=>r.state!=='ok').length,objects:repos.reduce((n,r)=>n+(r.items||[]).length,0)};});
 }
 function due(t=now()){return connections.filter(c=>!running.has(c.id)&&!deleting.has(c.id)&&tokenOf(c.id)&&t-(ms(catalogOf(c.id).fullFinishedAt)||0)>=REFRESH_MINUTES*60000).map(c=>c.id);}

 return {overview,list,test,repoChoices,save,remove,refresh,startRefresh,preview,removeObjects,readAudit,status,due,provider,connection,
  files:{connectionsFile,auditFile,tokenFile,base}};
}

// GET /api/git-lfs/objects query → a filter. Unknown keys and bad values are refused.
export function listQuery(q={}){
 const keys=['connection','repo','q','ext','status','minSize','maxSize','sort','dir','offset','limit'];
 if(!plain(q)||Object.keys(q).some(k=>!keys.includes(k)))fail('invalid',`known parameters: ${keys.join(', ')}`);
 const s=k=>q[k]===undefined||q[k]===''?undefined:String(q[k]);
 const out={connection:s('connection')||null,repo:s('repo')||null,q:(s('q')||'').trim().toLowerCase().slice(0,200)||null,ext:s('ext')?.toLowerCase()||null,status:s('status')&&s('status')!=='all'?s('status'):null,
  minSize:null,maxSize:null,sort:s('sort')||'size',dir:s('dir')||'desc',offset:0,limit:50};
 if(out.connection&&!/^c[a-f0-9]{10}$/.test(out.connection))fail('invalid','connection');
 if(out.repo&&!validFullName(out.repo))fail('invalid','repo is owner/name');
 if(out.ext&&!/^[a-z0-9_+-]{1,16}$/.test(out.ext)&&out.ext!=='-')fail('invalid','ext');
 if(out.ext==='-')out.ext='';
 if(out.status&&!STATUSES.includes(out.status))fail('invalid','status is all, current, branch, history or orphaned');
 if(!SORTS.includes(out.sort))fail('invalid',`sort is ${SORTS.join(', ')}`);
 if(!['asc','desc'].includes(out.dir))fail('invalid','dir is asc or desc');
 for(const [k,max] of [['minSize',2**53-1],['maxSize',2**53-1],['offset',1e7],['limit',200]]){
  const v=s(k);if(v===undefined)continue;if(!/^\d{1,16}$/.test(v)||Number(v)>max)fail('invalid',`${k} is a whole number`);out[k]=Number(v);
 }
 if(out.limit<1)fail('invalid','limit is 1–200');
 return out;
}
