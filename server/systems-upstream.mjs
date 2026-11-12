// Newest upstream versions for config/software-watch.json (scripts/check-upstream.mjs → data/systems/upstream.json).
// One resolver per source type. GitHub and Codeberg: the highest stable version among recent releases,
// because the "latest release" flag is not reliable (it pointed OpenCode at 1.19.5 while 2.2.6 was out).
// fetchJson is injectable so the tests run offline.
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {compareVersions,parseVersion} from './versions.mjs';

const UA='home-hub-systems/1';
export function upstreamKey(up){
 switch(up?.type){
  case 'github':case 'codeberg':return `${up.type}:${up.repo}`;
  case 'pypi':return `pypi:${up.package}`;
  case 'npm':return `npm:${up.package}@${up.tag||'latest'}`;
  case 'brew-formula':case 'brew-cask':return `${up.type}:${up.name}`;
  case 'node':return 'node';
  case 'thermo-feed':return `thermo-feed:${up.url}`;
  default:return null;
 }
}
export function collectUpstreams(registry){
 const map=new Map();
 for(const item of registry?.items||[])for(const up of [item.upstream,...Object.values(item.detect||{}).map(d=>d.upstream)]){const k=upstreamKey(up);if(k&&!map.has(k))map.set(k,up);}
 return map;
}

// Optional GitHub token, so the 12-hourly check is not capped at 60 anonymous requests per hour.
// Source: GITHUB_TOKEN in the environment, else the file GITHUB_TOKEN_FILE or <repo>/private/github-token
// (gitignored, 0600). It is sent only to https://api.github.com, never logged and never written to data/.
export const DEFAULT_GITHUB_TOKEN_FILE=fileURLToPath(new URL('../private/github-token',import.meta.url));
const tokenOk=t=>typeof t==='string'&&/^[A-Za-z0-9_.-]{20,255}$/.test(t);
export async function loadGithubToken({env=process.env,file=env.GITHUB_TOKEN_FILE||DEFAULT_GITHUB_TOKEN_FILE}={}){
 const fromEnv=env.GITHUB_TOKEN?.trim();
 if(fromEnv)return tokenOk(fromEnv)?{token:fromEnv,source:'env'}:{token:null,source:'env',invalid:true};
 let raw;try{raw=(await readFile(file,'utf8')).trim();}catch(e){return {token:null,source:e.code==='ENOENT'?null:'file',...(e.code==='ENOENT'?{}:{invalid:true})};}
 if(!raw)return {token:null,source:null};
 return tokenOk(raw)?{token:raw,source:'file'}:{token:null,source:'file',invalid:true};
}
const isGithubApi=url=>{try{const u=new URL(url);return u.protocol==='https:'&&u.hostname==='api.github.com'&&(u.port===''||u.port==='443');}catch{return false;}};

// What a refusal says about when to ask again (GitHub: 403 or 429 with x-ratelimit-* or retry-after), so a
// caller can wait instead of asking again. retryAt: epoch milliseconds, or null when the answer names no time.
export function rateLimitOf(headers,now=Date.now()){
 const get=name=>{try{return headers?.get?.(name)??null;}catch{return null;}};
 const number=v=>v!==null&&v!==''&&Number.isFinite(Number(v))?Number(v):null;
 const remaining=number(get('x-ratelimit-remaining')),reset=number(get('x-ratelimit-reset')),retryAfter=number(get('retry-after'));
 const times=[retryAfter!==null&&retryAfter>=0?now+retryAfter*1000:null,remaining===0&&reset!==null&&reset>0?reset*1000:null].filter(v=>v!==null);
 return {remaining,retryAt:times.length?Math.max(...times):null};
}
// fetchJson with an optional token. Redirects are followed by hand so the Authorization header is
// recomputed per hop and never forwarded to another host. userAgent: what the caller calls itself.
// A refusal throws an Error with .status and, when the answer carried them, .rateLimit = {remaining, retryAt}.
export function createFetchJson({token=null,fetchImpl=fetch,userAgent=UA}={}){
 return async function fetchJson(url,{etag=null,timeoutMs=20000}={}){
  const signal=AbortSignal.timeout(timeoutMs);let current=url,r;
  for(let hop=0;;hop++){
   const github=isGithubApi(current);
   const headers={'User-Agent':userAgent,Accept:github?'application/vnd.github+json':'application/json'};
   if(etag)headers['If-None-Match']=etag;
   if(github&&token)headers.Authorization=`Bearer ${token}`;
   r=await fetchImpl(current,{headers,redirect:'manual',signal});
   const location=[301,302,303,307,308].includes(r.status)?r.headers.get('location'):null;
   if(!location)break;
   if(hop>=5)throw new Error(`too many redirects ${url.replace(/\?.*$/,'')}`);
   current=new URL(location,current).toString();
  }
  // 304 only answers a conditional request; without our If-None-Match it validates nothing.
  if(r.status===304){if(!etag)throw Object.assign(new Error(`HTTP 304 without If-None-Match ${url.replace(/\?.*$/,'')}`),{status:304});return {status:304,etag};}
  if(!r.ok)throw Object.assign(new Error(`HTTP ${r.status} ${url.replace(/\?.*$/,'')}`),{status:r.status,...([403,429].includes(r.status)?{rateLimit:rateLimitOf(r.headers)}:{})});
  const text=await r.text();if(text.length>24_000_000)throw new Error('response too large');
  return {status:r.status,etag:r.headers.get('etag'),json:JSON.parse(text)};
 };
}
// Anonymous unless GITHUB_TOKEN is set in the environment (kept for callers that pass nothing).
export const defaultFetchJson=(url,opts)=>createFetchJson({token:tokenOk(process.env.GITHUB_TOKEN?.trim())?process.env.GITHUB_TOKEN.trim():null})(url,opts);

// Highest stable version among release objects ({tag_name, prerelease, draft, html_url, published_at}).
export function pickRelease(releases,{tagPrefix='',tagPattern=null,allowPrerelease=false}={}){
 const re=tagPattern?new RegExp(tagPattern):null;let best=null;
 for(const r of releases||[]){
  if(!r||r.draft||(!allowPrerelease&&r.prerelease))continue;
  let tag=String(r.tag_name||'');if(tagPrefix){if(!tag.startsWith(tagPrefix))continue;tag=tag.slice(tagPrefix.length);}
  if(re&&!re.test(tag))continue;
  const v=parseVersion(tag);if(!v||(!allowPrerelease&&v.pre))continue;
  const version=tag.replace(/^[vV]\.?/,'');
  if(!best||compareVersions(version,best.version)>0)best={version,tag:r.tag_name,url:r.html_url||null,publishedAt:r.published_at||null,...(typeof r.body==='string'?{notes:r.body}:{})};
 }
 return best;
}

const isNotFound=e=>e?.status===404||/^HTTP 404\b/.test(String(e?.message||''));

// ETag cache, one entry per request. GitHub needs two requests (the release list and /releases/latest),
// and each ETag validates only its own response, so each endpoint keeps its own ETag and the releases it
// returned. Every run sends both requests; each may answer 304 on its own, and the answer is computed
// from the combination. A source is fresh only when every request it needs was answered in this run
// (200, 304 against the stored ETag of that very request, or 404 for "no latest release"); any other
// failure fails the whole source, and checkUpstreams keeps the previous result marked stale.
// Results written before UPSTREAM_CACHE_VERSION carry a single list ETag that never covered
// /releases/latest (and may come from a list-only answer), so they are ignored: full fetch, no ETags.
export const UPSTREAM_CACHE_VERSION=2;
// notes: keep the release text too (bounded), for a caller that shows it (server/update-check.mjs).
export const RELEASE_NOTES_LIMIT=8000;
const slimRelease=(r,notes=false)=>r&&typeof r==='object'?{tag_name:r.tag_name??null,prerelease:Boolean(r.prerelease),draft:Boolean(r.draft),html_url:r.html_url??null,published_at:r.published_at??null,
 ...(notes?{body:typeof r.body==='string'?r.body.slice(0,RELEASE_NOTES_LIMIT):''}:{})}:null;
const validEntry=e=>e&&typeof e==='object'&&typeof e.etag==='string'&&e.etag&&Array.isArray(e.releases);
async function fetchReleases(fetchJson,url,cached,{list=false,notes=false}={}){
 const prior=validEntry(cached)?cached:null;let r;
 try{r=await fetchJson(url,{etag:prior?.etag||null});}
 catch(e){if(!list&&isNotFound(e))return {etag:null,releases:[]};throw e;}
 if(r?.status===304){if(!prior)throw new Error(`unexpected 304 ${url.replace(/\?.*$/,'')}`);return {etag:prior.etag,releases:prior.releases};}
 if(list&&!Array.isArray(r?.json))throw new Error('release list is not an array');
 return {etag:r?.etag||null,releases:(list?r.json:[r?.json]).map(x=>slimRelease(x,notes)).filter(Boolean)};
}

export async function resolveUpstream(up,{fetchJson=defaultFetchJson,previous=null}={}){
 const t=up?.type;
 if(t==='github'||t==='codeberg'){
  const cache=previous?.ok&&previous.cache?.v===UPSTREAM_CACHE_VERSION?previous.cache:null;
  const base=t==='github'?`https://api.github.com/repos/${up.repo}/releases`:`https://codeberg.org/api/v1/repos/${up.repo}/releases`;
  const notes=up.notes===true;
  const list=await fetchReleases(fetchJson,t==='github'?`${base}?per_page=20`:`${base}?limit=20`,cache?.list,{list:true,notes});
  // Projects that publish many builds (llama.cpp) can push the newest tagged version off the
  // first page, so GitHub's own "latest" release is added as one more candidate. It is part of the
  // answer: if it fails (403/429/5xx/timeout) the whole source fails. Only 404 is an answer
  // ("no latest release": the repo has only pre-releases or none).
  const latest=t==='github'?await fetchReleases(fetchJson,`${base}/latest`,cache?.latest,{notes}):null;
  const fresh={v:UPSTREAM_CACHE_VERSION,list,...(latest?{latest}:{})};
  // Every request was answered and none of the releases counts: that is an answer too ("nothing published
  // yet"), so the error says which one it is (code) and carries the ETags (cache) for the next run.
  const best=pickRelease([...list.releases,...(latest?.releases||[])],up);if(!best)throw Object.assign(new Error('no stable release found'),{code:'no-release',cache:fresh});
  return {ok:true,version:best.version,url:best.url||`https://${t==='github'?'github.com':'codeberg.org'}/${up.repo}/releases`,publishedAt:best.publishedAt,
   ...(notes?{tag:best.tag,notes:best.notes??''}:{}),cache:fresh};
 }
 if(t==='pypi'){
  const {json}=await fetchJson(`https://pypi.org/pypi/${encodeURIComponent(up.package)}/json`);
  const v=json?.info?.version;if(!v)throw new Error('no version');
  return {ok:true,version:v,url:`https://pypi.org/project/${up.package}/${v}/`,publishedAt:json.releases?.[v]?.[0]?.upload_time_iso_8601||null};
 }
 if(t==='npm'){
  const {json}=await fetchJson(`https://registry.npmjs.org/-/package/${up.package}/dist-tags`);
  const v=json?.[up.tag||'latest'];if(!v)throw new Error(`no dist-tag ${up.tag||'latest'}`);
  return {ok:true,version:v,url:`https://www.npmjs.com/package/${up.package}/v/${v}`,publishedAt:null,tags:Object.fromEntries(Object.entries(json).filter(([k])=>['latest','stable','next'].includes(k)))};
 }
 if(t==='brew-formula'){
  const {json}=await fetchJson(`https://formulae.brew.sh/api/formula/${encodeURIComponent(up.name)}.json`);
  const v=json?.versions?.stable;if(!v)throw new Error('no stable version');
  return {ok:true,version:v,url:`https://formulae.brew.sh/formula/${up.name}`,publishedAt:null};
 }
 if(t==='brew-cask'){
  const {json}=await fetchJson(`https://formulae.brew.sh/api/cask/${encodeURIComponent(up.name)}.json`);
  const v=String(json?.version||'').split(',')[0];if(!v)throw new Error('no version');
  return {ok:true,version:v,url:`https://formulae.brew.sh/cask/${up.name}`,publishedAt:null};
 }
 if(t==='node'){
  const {json}=await fetchJson('https://nodejs.org/dist/index.json');
  const latestByMajor={},ltsMajors=new Set();let lts=null;
  for(const r of json||[]){const v=String(r.version||'').replace(/^v/,''),p=parseVersion(v);if(!p||p.pre||/alpha|beta|rc/i.test(r.version))continue;
   const major=p.nums[0];if(!latestByMajor[major]||compareVersions(v,latestByMajor[major])>0)latestByMajor[major]=v;
   if(r.lts){ltsMajors.add(major);if(!lts||compareVersions(v,lts.version)>0)lts={version:v,codename:r.lts,date:r.date};}}
  if(!lts)throw new Error('no LTS release');
  const majors=Object.keys(latestByMajor).map(Number).sort((a,b)=>b-a).slice(0,6);
  return {ok:true,version:lts.version,url:'https://nodejs.org/en/about/previous-releases',publishedAt:lts.date||null,codename:lts.codename,
   ltsMajor:parseVersion(lts.version).nums[0],ltsMajors:[...ltsMajors].filter(m=>majors.includes(m)),latestByMajor:Object.fromEntries(majors.map(m=>[m,latestByMajor[m]]))};
 }
 if(t==='thermo-feed'){
  const {json}=await fetchJson(up.url);
  const manifest=JSON.parse(Buffer.from(String(json?.manifest||''),'base64').toString('utf8'));
  if(!manifest?.version)throw new Error('feed without version');
  return {ok:true,version:String(manifest.version),build:manifest.build??null,url:up.url.replace(/stable\.json$/,''),publishedAt:null,note:'Podpis feedu Home Hub neověřuje; ověřuje ho Thermo při instalaci.'};
 }
 throw new Error(`unsupported upstream type ${t}`);
}

// Resolve every upstream with limited concurrency. A failure keeps the previous good value but marks
// it: stale:true, error (e.g. "HTTP 403 …"), failedAt (this attempt) and checkedAt left at the last
// success, so the payload and UI can say "neověřeno" instead of presenting it as fresh.
export async function checkUpstreams(registry,{previous=null,fetchJson=defaultFetchJson,concurrency=4,now=()=>new Date().toISOString()}={}){
 const entries=[...collectUpstreams(registry)],results={};let i=0;
 async function worker(){while(i<entries.length){const [key,up]=entries[i++];const prev=previous?.results?.[key]||null;
  try{const {stale,error,failedAt,...fresh}=await resolveUpstream(up,{fetchJson,previous:prev});results[key]={...fresh,checkedAt:now()};}
  catch(e){const error=String(e.message).slice(0,200);results[key]=prev?.ok?{...prev,stale:true,error,failedAt:now()}:{ok:false,error,checkedAt:now(),failedAt:now()};}}}
 await Promise.all(Array.from({length:Math.min(concurrency,entries.length)},worker));
 return {schemaVersion:2,checkedAt:now(),results};
}
