// Git LFS view: the git hosts it can talk to (docs/git-lfs.md → Providers). A provider is a plain object:
//
//   {id, title, kind:'builtin'|'plugin',
//    capabilities: {listRepos, checkObjects, listObjects, deleteObjects, tokenScopes},  every one a boolean
//    fixedBaseUrl,             a URL when the host is fixed (github.com); null = the wizard asks for one
//    endpoints(baseUrl),       → {api, web}; throws Error('invalid') for a URL it cannot use
//    token: {url(web), steps?:[Czech source lines], permissions:[Czech source lines], note},  where to click, what to grant
//    whoami(ctx)               → {login, name, scopes|null, scopesNote, warnings}
//    listRepos(ctx, {owner})   → [{owner, name, fullName, defaultBranch, private}]
//    getRepo(ctx, fullName)    → the same shape for one
//    gitAuth(ctx)              → {username}: the user name sent with the token over git and LFS (basic auth)
//    listObjects?(ctx, repo)   → [{oid, size, createdAt|null}], every object the host stores for the repo (only when capabilities.listObjects)
//    deleteObject?(ctx, repo, oid)  → removes one stored LFS object (only when capabilities.deleteObjects)
//    manual(web, repo, oid)    → {text, url|null}: how a person removes an unused object by hand}
//   ctx = {api, web, token, login, fetch}
//
// What the real hosts allow (official docs and API specs, checked 2026-11-11; links in docs/git-lfs.md):
// none of GitHub, Gitea, Forgejo or GitLab has an API that lists a repository's LFS objects or deletes one.
// All of them serve the Git LFS batch API, which says whether the host still stores a given object. So the
// built-in providers are read-only: listRepos + checkObjects. A plugin may add a provider that can list and
// delete (through the module extension point "git-lfs.providers"); the deletion path honours only that.
export const CAPABILITIES=Object.freeze(['listRepos','checkObjects','listObjects','deleteObjects','tokenScopes']);
const NAME=/^[A-Za-z0-9_.-]{1,100}$/;
export const validName=s=>typeof s==='string'&&NAME.test(s)&&s!=='.'&&s!=='..'&&!s.endsWith('.git');
export const validFullName=s=>typeof s==='string'&&s.split('/').length===2&&s.split('/').every(validName);
const MAX_BODY=8*1024*1024,PAGES=40;

export class ProviderError extends Error{constructor(code,status=null){super(code);this.code=code;this.status=status;}}

// A base URL a person typed → its origin and path, without credentials, query or fragment, and without a
// trailing slash. http is accepted (a LAN host); the UI warns that the token then travels unencrypted.
export function cleanBaseUrl(input,{strip=[]}={}){
 if(typeof input!=='string'||input.length>300)throw new Error('invalid');
 let u;try{u=new URL(input.trim());}catch{throw new Error('invalid');}
 if(!['https:','http:'].includes(u.protocol)||u.username||u.password||u.search||u.hash||!u.hostname)throw new Error('invalid');
 let p=u.pathname.replace(/\/+$/,'');
 for(const s of strip)if(p.toLowerCase().endsWith(s))p=p.slice(0,-s.length);
 if(/[^A-Za-z0-9._~/-]/.test(p)||p.split('/').some(x=>x==='.'||x==='..'))throw new Error('invalid');
 return u.origin+p;
}

// One JSON request to the host's API. Redirects are not followed (a token must not travel to another host).
export async function apiRequest(ctx,method,url,{body,headers={},timeoutMs=20000,auth}={}){
 if(!url.startsWith(ctx.api+'/')&&!url.startsWith(ctx.web+'/'))throw new ProviderError('invalid-url');
 // The integration was switched off mid-scan: no further request leaves the hub.
 if(ctx.stopped?.())throw new ProviderError('disabled');
 let res;
 try{
  res=await (ctx.fetch||fetch)(url,{method,redirect:'manual',signal:AbortSignal.timeout(timeoutMs),
   headers:{Accept:'application/json','User-Agent':'home-hub-git-lfs',...(auth??{Authorization:ctx.authHeader}),...(body!==undefined?{'Content-Type':'application/json'}:{}),...headers},
   ...(body!==undefined?{body:typeof body==='string'?body:JSON.stringify(body)}:{})});
 }catch(e){throw new ProviderError(e?.name==='TimeoutError'?'timeout':'network');}
 const text=await readLimited(res);
 if(res.status===401)throw new ProviderError('auth',401);
 // Gitea and Forgejo name what a token lacks: "token does not have at least one of required scope(s): [read:repository]".
 if(res.status===403)throw new ProviderError(/rate limit/i.test(text)?'rate-limited':/required scope\(s\)[^\[]*\[[^\]]*read:repository/i.test(text)?'missing-scope':'forbidden',403);
 if(res.status===404)throw new ProviderError('not-found',404);
 if(res.status===429)throw new ProviderError('rate-limited',429);
 if(res.status>=300&&res.status<400)throw new ProviderError('redirect',res.status);
 if(!res.ok)throw new ProviderError('host-error',res.status);
 let data=null;if(text){try{data=JSON.parse(text);}catch{throw new ProviderError('bad-response',res.status);}}
 return {data,headers:res.headers,status:res.status};
}
async function readLimited(res){
 if(!res.body)return '';
 const reader=res.body.getReader(),chunks=[];let size=0;
 for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>MAX_BODY){reader.cancel().catch(()=>{});throw new ProviderError('too-large');}chunks.push(value);}
 return Buffer.concat(chunks.map(c=>Buffer.from(c))).toString('utf8');
}
const bool=v=>v===true;
const repoOf=(r,branchKey='default_branch')=>{
 const owner=r?.owner?.login??r?.owner?.username,name=r?.name;
 if(!validName(owner)||!validName(name))return null;
 return {owner,name,fullName:`${owner}/${name}`,defaultBranch:typeof r[branchKey]==='string'&&r[branchKey]&&!/[\0\r\n ~^:?*[\\]/.test(r[branchKey])?r[branchKey]:null,private:bool(r.private),archived:bool(r.archived),empty:bool(r.empty)};
};
async function pages(ctx,first,{perPage,param='per_page'}){
 const out=[];
 for(let page=1;page<=PAGES;page++){
  const sep=first.includes('?')?'&':'?';
  const {data,headers}=await apiRequest(ctx,'GET',`${first}${sep}${param}=${perPage}&page=${page}`);
  if(!Array.isArray(data))throw new ProviderError('bad-response');
  out.push(...data);
  // With a total (Gitea, Forgejo: X-Total-Count) the total decides: a host may cap a page below the limit we
  // asked for (MAX_RESPONSE_ITEMS), and stopping on a short page would drop repositories, whose catalogs and
  // mirrors would then be removed. Without one, a short or empty page is the last.
  const header=headers.get('x-total-count'),total=header!==null&&/^\d+$/.test(header.trim())?Number(header):null;
  if(!data.length)return out;
  if(total!==null){if(out.length>=total)return out;continue;}
  if(data.length<perPage)return out;
 }
 throw new ProviderError('too-many');
}

// The Git LFS batch API (https://github.com/git-lfs/git-lfs/blob/main/docs/api/batch.md), "download":
// for each oid, does the host still store it? → Map(oid → true | false | null (unknown)). Nothing is downloaded.
export async function checkObjects(ctx,repo,objects,{chunk=100}={}){
 const out=new Map(),url=`${ctx.web}/${repo.owner}/${repo.name}.git/info/lfs/objects/batch`;
 for(let i=0;i<objects.length;i+=chunk){
  const part=objects.slice(i,i+chunk);
  const {data}=await apiRequest(ctx,'POST',url,{auth:{Authorization:ctx.gitAuthHeader},headers:{Accept:'application/vnd.git-lfs+json','Content-Type':'application/vnd.git-lfs+json'},
   body:{operation:'download',transfers:['basic'],objects:part.map(o=>({oid:o.oid,size:Number.isSafeInteger(o.size)?o.size:0})),hash_algo:'sha256'}});
  const seen=new Map((Array.isArray(data?.objects)?data.objects:[]).map(o=>[o?.oid,o]));
  for(const o of part){
   const r=seen.get(o.oid);
   if(!r)out.set(o.oid,null);
   else if(r.actions?.download)out.set(o.oid,true);
   else if(r.error&&[404,410].includes(Number(r.error.code)))out.set(o.oid,false);
   else out.set(o.oid,null);// a validation error (422), a size mismatch: unknown, never "gone"
  }
 }
 return out;
}

// --- GitHub (github.com and GitHub Enterprise Server) ---------------------------------------------------
// REST: https://docs.github.com/en/rest/repos/lfs has only enable/disable; LFS objects are removed only by
// deleting the repository or through GitHub Support (docs: removing-files-from-git-large-file-storage).
const github={
 id:'github',title:'GitHub',kind:'builtin',
 capabilities:{listRepos:true,checkObjects:true,listObjects:false,deleteObjects:false,tokenScopes:true},
 fixedBaseUrl:'https://github.com',
 endpoints(baseUrl){
  const base=cleanBaseUrl(baseUrl||'https://github.com',{strip:['/api/v3']});
  if(/^https:\/\/(www\.)?github\.com$/i.test(base))return {api:'https://api.github.com',web:'https://github.com'};
  if(base!==new URL(base).origin)throw new Error('invalid');// GitHub Enterprise lives at the root of its host
  return {api:base+'/api/v3',web:base};
 },
 token:{url:web=>web==='https://github.com'?'https://github.com/settings/personal-access-tokens/new':`${web}/settings/personal-access-tokens/new`,
  steps:['Vpravo nahoře klikni na svůj avatar → Settings.','Vlevo úplně dole Developer settings → Personal access tokens → Fine-grained tokens → Generate new token.','Repository access: All repositories, nebo Only select repositories.','Permissions → Repository permissions → Contents: Read-only (Metadata: Read-only se přidá sám). Nic dalšího.','Generate token a token hned zkopíruj: GitHub ho ukáže jen jednou.'],
  permissions:['Fine-grained token: Repository access = vybrané repozitáře (nebo všechny), Permissions → Contents: Read-only (Metadata: Read-only se přidá sám).','Classic token: scope repo (soukromé repozitáře) nebo public_repo (jen veřejné).'],
  note:'GitHub nemá API, které by vypsalo nebo smazalo LFS objekty. Hub je jen čte; nepoužívané objekty odstraní jen smazání repozitáře nebo GitHub Support.'},
 async whoami(ctx){
  const {data,headers}=await apiRequest(ctx,'GET',ctx.api+'/user');
  if(typeof data?.login!=='string')throw new ProviderError('bad-response');
  const raw=headers.get('x-oauth-scopes');
  const scopes=raw===null?null:raw.split(',').map(s=>s.trim()).filter(Boolean);
  const warnings=[];
  if(scopes&&!scopes.some(s=>s==='repo'||s==='public_repo'))warnings.push('Token nemá scope repo ani public_repo: git a LFS repozitáře nepřečte.');
  if(scopes&&scopes.some(s=>['delete_repo','admin:org','admin:repo_hook','workflow','write:packages'].includes(s)))warnings.push('Token má víc oprávnění, než hub potřebuje. Stačí čtení obsahu.');
  return {login:data.login,name:typeof data.name==='string'?data.name:null,scopes,
   scopesNote:scopes===null?'Fine-grained token: GitHub jeho oprávnění nevypisuje; ověří je až výpis repozitářů.':null,warnings};
 },
 async listRepos(ctx,{owner}={}){
  let list;
  if(owner){
   if(!validName(owner))throw new ProviderError('invalid');
   try{list=await pages(ctx,`${ctx.api}/orgs/${owner}/repos?type=all`,{perPage:100});}
   catch(e){if(e.code!=='not-found')throw e;list=await pages(ctx,`${ctx.api}/users/${owner}/repos?type=owner`,{perPage:100});}
  }else list=await pages(ctx,`${ctx.api}/user/repos?affiliation=owner,collaborator,organization_member`,{perPage:100});
  return list.map(r=>repoOf(r)).filter(Boolean);
 },
 async getRepo(ctx,fullName){const {data}=await apiRequest(ctx,'GET',`${ctx.api}/repos/${fullName}`);const r=repoOf(data);if(!r)throw new ProviderError('bad-response');return r;},
 gitAuth:()=>({username:'x-access-token'}),
 manual:()=>({text:'GitHub nepoužívané LFS objekty přes API nemaže. Uvolní je jen smazání a znovuvytvoření repozitáře, nebo požádej GitHub Support.',url:'https://docs.github.com/en/repositories/working-with-files/managing-large-files/removing-files-from-git-large-file-storage'}),
};

// --- Gitea and Forgejo (the same API) --------------------------------------------------------------------
// REST (https://docs.gitea.com/api, https://codeberg.org/api/swagger): LFS appears only as GET …/media/{path}.
// Listing and deleting LFS objects exist only in the signed-in web UI (Settings → LFS), not in the API.
function giteaLike(id,title,{scopeEndpoint}){
 return {
  id,title,kind:'builtin',
  capabilities:{listRepos:true,checkObjects:true,listObjects:false,deleteObjects:false,tokenScopes:scopeEndpoint},
  fixedBaseUrl:null,
  endpoints(baseUrl){const base=cleanBaseUrl(baseUrl,{strip:['/api/v1']});return {api:base+'/api/v1',web:base};},
  token:{url:web=>`${web}/user/settings/applications`,
   steps:['Vpravo nahoře klikni na svůj avatar → Nastavení (Settings).','Vlevo Aplikace (Applications). Tokeny nejsou mezi klíči SSH / GPG.','V části Vygenerovat nový token (Generate new token) zadej název, třeba Home Hub (jen čtení).','Přístup k repozitářům a organizacím: Vše (All), aby hub viděl i soukromé repozitáře.','Oprávnění: repository, user a organization na Číst (Read), všechno ostatní Bez přístupu (No access). Starší verze mají místo toho zaškrtávátka: read:repository, read:user, read:organization.','Vygeneruj token a hned ho zkopíruj: host ho ukáže jen jednou.'],
   permissions:['repository: Read (read:repository)','user: Read (read:user)','organization: Read (read:organization), jen když vybíráš repozitáře organizace'],
   note:`${title} má výpis a mazání LFS jen ve webovém rozhraní (Nastavení repozitáře → LFS), ne v API. Hub je jen čte a ukáže, co jde bezpečně smazat ručně.`},
  async whoami(ctx){
   const {data}=await apiRequest(ctx,'GET',ctx.api+'/user');
   const login=data?.login??data?.username;if(typeof login!=='string')throw new ProviderError('bad-response');
   // Signing in needs only read:user; a scan lists repositories, so the check asks for one (a token without
   // repository: Read fails here, before a connection that could never scan is saved).
   await apiRequest(ctx,'GET',`${ctx.api}/user/repos?limit=1`);
   let scopes=null,scopesNote=null;const warnings=[];
   if(scopeEndpoint){
    try{const {data:tok}=await apiRequest(ctx,'GET',ctx.api+'/token');if(Array.isArray(tok?.scopes))scopes=tok.scopes.filter(s=>typeof s==='string').slice(0,40);}
    catch(e){if(!['not-found','forbidden'].includes(e.code))throw e;}
   }
   if(scopes===null)scopesNote=scopeEndpoint?'Gitea oprávnění tokenu nevypisuje (verze starší než 1.27); ověří je až výpis repozitářů.':'Forgejo oprávnění tokenu nevypisuje; ověří je až výpis repozitářů.';
   if(scopes&&!scopes.some(s=>/^(read|write):repository$/.test(s)||s==='all'))warnings.push('Token nemá read:repository: git a LFS repozitáře nepřečte.');
   if(scopes&&scopes.some(s=>/^write:/.test(s)||s==='all'||s==='sudo'))warnings.push('Token má i zápis. Hubu stačí čtení.');
   return {login,name:typeof data.full_name==='string'&&data.full_name?data.full_name:null,scopes,scopesNote,warnings};
  },
  async listRepos(ctx,{owner}={}){
   let list;
   if(owner){
    if(!validName(owner))throw new ProviderError('invalid');
    try{list=await pages(ctx,`${ctx.api}/orgs/${owner}/repos`,{perPage:50,param:'limit'});}
    catch(e){if(e.code!=='not-found')throw e;list=await pages(ctx,`${ctx.api}/users/${owner}/repos`,{perPage:50,param:'limit'});}
   }else list=await pages(ctx,`${ctx.api}/user/repos`,{perPage:50,param:'limit'});
   return list.map(r=>repoOf(r)).filter(Boolean);
  },
  async getRepo(ctx,fullName){const {data}=await apiRequest(ctx,'GET',`${ctx.api}/repos/${fullName}`);const r=repoOf(data);if(!r)throw new ProviderError('bad-response');return r;},
  gitAuth:ctx=>({username:ctx.login||'oauth2'}),
  manual:(web,repo,oid)=>({text:`Smaž ho ve webovém rozhraní ${title}: repozitář → Nastavení → LFS (správce repozitáře). Na serveru to umí i úloha cron gc_lfs.`,
   url:`${web}/${repo.owner}/${repo.name}/settings/lfs${oid?`/show/${oid}`:''}`}),
 };
}
// Gitea answers GET /api/v1/token with the token's scopes from 1.27 on (older versions: 404, scopes unknown).
const gitea=giteaLike('gitea','Gitea',{scopeEndpoint:true});
const forgejo=giteaLike('forgejo','Forgejo',{scopeEndpoint:false});

export const BUILTIN_PROVIDERS=Object.freeze([github,gitea,forgejo]);

// A provider from a plugin, checked like a module field: wrong shape = it is left out (and logged once).
export function validProvider(p){
 if(!p||typeof p!=='object'||typeof p.id!=='string'||!/^[a-z][a-z0-9-]{1,31}$/.test(p.id)||typeof p.title!=='string')return false;
 if(!p.capabilities||typeof p.capabilities!=='object'||CAPABILITIES.some(k=>typeof p.capabilities[k]!=='boolean'))return false;
 for(const f of ['endpoints','whoami','listRepos','getRepo','gitAuth','manual'])if(typeof p[f]!=='function')return false;
 if(p.capabilities.listObjects&&typeof p.listObjects!=='function')return false;
 if(p.capabilities.deleteObjects&&(typeof p.deleteObject!=='function'||!p.capabilities.listObjects))return false;
 if(!p.token||typeof p.token.url!=='function'||!Array.isArray(p.token.permissions))return false;
 if(p.token.steps!==undefined&&(!Array.isArray(p.token.steps)||p.token.steps.some(x=>typeof x!=='string')))return false;
 return true;
}
// What the browser learns about a provider: never a function.
export const providerView=p=>({id:p.id,title:p.title,kind:p.kind==='builtin'?'builtin':'plugin',capabilities:{...p.capabilities},fixedBaseUrl:p.fixedBaseUrl||null,
 // urlTemplate: where to create a token on a host of this kind, with {web} for the host's address.
 token:{steps:[...(p.token.steps||[])].slice(0,12),permissions:[...p.token.permissions],note:p.token.note||null,url:p.fixedBaseUrl?safeCall(()=>p.token.url(p.endpoints(p.fixedBaseUrl).web)):null,urlTemplate:safeCall(()=>p.token.url('{web}'))}});
const safeCall=fn=>{try{const v=fn();return typeof v==='string'?v.slice(0,300):null;}catch{return null;}};

// ctx for one call. token is the stored value; it lives only in this object, in memory.
export function contextFor(provider,{baseUrl,token,login,fetchImpl}){
 const {api,web}=provider.endpoints(baseUrl);
 const ctx={api,web,token,login:login||null,fetch:fetchImpl,authHeader:`Bearer ${token}`};
 const user=provider.gitAuth(ctx)?.username||'oauth2';
 ctx.gitAuthHeader='Basic '+Buffer.from(`${user}:${token}`).toString('base64');
 // Gitea and Forgejo accept "token <value>"; GitHub accepts Bearer. Both accept the other form too on current
 // versions, but each gets the one its docs name.
 if(provider.id==='gitea'||provider.id==='forgejo')ctx.authHeader=`token ${token}`;
 return ctx;
}
