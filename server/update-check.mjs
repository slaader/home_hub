// The update check: is there a newer release of Home Hub than the one running? It only tells. Nothing here
// downloads, installs or restarts anything; an update is applied by a person on the server, with
// scripts/update.mjs (docs/updating.md).
//
// What leaves the machine: GET https://api.github.com/repos/<repo>/releases?per_page=20 and …/releases/latest,
// about twice a day, with the constant User-Agent below, no query beyond per_page, no version, no instance id
// and no site name. Nothing is sent to the project. A token is not needed; when GITHUB_TOKEN or
// private/github-token exists (server/systems-upstream.mjs → loadGithubToken) it is used, for api.github.com only.
//
//   updateSettings()       which repository, which channel, how often, and whether the environment forbids it
//   createUpdateChecker()  the schedule, the two requests (through resolveUpstream and its ETag cache), the
//                          state file <state>/updates.json (0600)
//   updateView()           what is known, computed from the record every time it is asked. A failed check never
//                          reads as "up to date": the state is "stale" (or "error" before the first success)
//   integrationStatus()    the same as a card on Administration → Integrations
//
// updates.json = {schemaVersion: 1, sources: {core: {repo, channel, attemptedAt, checkedAt, version, tag, url,
//   publishedAt, notes, failedAt?, error?, failures, notBefore?, cache}}, quarantined: {"<version>": {at, reason}},
//   dismissed: {version, by, at} | null}
// `sources` is keyed so that plugin packages can join later (each with its own release location); today
// there is one source, "core". `quarantined` is written by the update command when it has to roll a release back
// (server/update-apply.mjs → setQuarantine), with the hub stopped, and removed when that release later runs.
import {readFileSync,existsSync} from 'node:fs';
import {mkdir,writeFile,rename} from 'node:fs/promises';
import path from 'node:path';
import {compareVersions} from './versions.mjs';
import {resolveUpstream,createFetchJson,loadGithubToken,RELEASE_NOTES_LIMIT} from './systems-upstream.mjs';
import {tx} from './text.mjs';

export const UPDATES_SCHEMA=1;
export const UPDATE_INTEGRATION='updates.check';
export const UPDATE_USER_AGENT='home-hub-update-check';
export const CORE_SOURCE='core';
const MINUTE=60000,HOUR=3600000;
// First check 2 to 5 minutes after start, then every interval ± 30 minutes. After a failure: 1 h, 2 h, 4 h,
// then the normal interval. A forced check at most once a minute. A rate-limit wait is at most a day.
// A result is "stale" once the last success is older than three intervals (36 h with the default 12 h).
export const UPDATE_TIMING=Object.freeze({firstMinMs:2*MINUTE,firstMaxMs:5*MINUTE,jitterMs:30*MINUTE,backoffMs:Object.freeze([HOUR,2*HOUR,4*HOUR]),
 forceGapMs:MINUTE,resumeMs:5000,rateLimitMaxMs:24*HOUR,staleIntervals:3,requestTimeoutMs:8000});

const plain=v=>v&&typeof v==='object'&&!Array.isArray(v);
const iso=ms=>new Date(ms).toISOString();
const time=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))?Date.parse(v):null;
const clean=(v,max)=>typeof v==='string'?v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g,' ').slice(0,max):'';

/** site = the site configuration, version = readVersion(), env = the process environment. */
export function updateSettings({site=null,version=null,env=process.env}={}){
 const own=site?.updates?.repo??null,repo=own??version?.updates?.repo??null;
 return Object.freeze({repo,repoSource:own?'site.json':repo?'package.json':null,channel:site?.updates?.channel??'stable',intervalHours:site?.updates?.intervalHours??12,
  envOff:String(env?.HOME_HUB_UPDATE_CHECK??'').trim().toLowerCase()==='off'});
}

// The one link a release may carry: its page under the repository's releases. Anything else GitHub's answer
// might hold is replaced by the address built from the tag.
export const releasesPrefix=repo=>`https://github.com/${repo}/releases/`;
export function releaseUrl(repo,url,tag){
 const prefix=releasesPrefix(repo);
 if(typeof url==='string'&&url.length<=300&&url.toLowerCase().startsWith(prefix.toLowerCase())&&!/[\s<>"'`\\]/.test(url))return prefix+url.slice(prefix.length);
 return tag?`${prefix}tag/${encodeURIComponent(tag)}`:prefix;
}
// What went wrong, in a few characters, without the address that was asked.
export function errorCode(e){
 if(Number.isInteger(e?.status))return `HTTP ${e.status}`;
 if(e?.name==='TimeoutError'||e?.name==='AbortError')return 'timeout';
 const code=e?.cause?.code||e?.code;if(typeof code==='string'&&/^[A-Z][A-Z0-9_]{2,40}$/.test(code))return code;
 return clean(String(e?.message||'failed').replace(/https?:\/\/\S+/g,''),80).trim()||'failed';
}

// --- the state file ---------------------------------------------------------------------------------
const emptyState=()=>({sources:{},quarantined:{},dismissed:null});
function sourceOf(raw){
 if(!plain(raw)||typeof raw.repo!=='string')return null;
 const out={repo:raw.repo,channel:raw.channel==='prerelease'?'prerelease':'stable',attemptedAt:time(raw.attemptedAt)?raw.attemptedAt:null,checkedAt:time(raw.checkedAt)?raw.checkedAt:null,
  version:typeof raw.version==='string'&&raw.version.length<=64?raw.version:null,tag:typeof raw.tag==='string'&&raw.tag.length<=80?raw.tag:null,
  url:typeof raw.url==='string'?raw.url:null,publishedAt:time(raw.publishedAt)?raw.publishedAt:null,notes:clean(raw.notes,RELEASE_NOTES_LIMIT),
  failures:Number.isSafeInteger(raw.failures)&&raw.failures>0?raw.failures:0,cache:plain(raw.cache)?raw.cache:null};
 if(time(raw.failedAt)){out.failedAt=raw.failedAt;out.error=clean(raw.error,80)||'failed';}
 if(time(raw.notBefore))out.notBefore=raw.notBefore;
 return out;
}
/** → {state, locked}. locked: the file was written by newer code; it is neither used nor overwritten. */
export function readUpdateState(file){
 if(!existsSync(file))return {state:emptyState(),locked:false};
 let raw;try{raw=JSON.parse(readFileSync(file,'utf8'));}catch{return {state:emptyState(),locked:false};}
 if(Number.isInteger(raw?.schemaVersion)&&raw.schemaVersion>UPDATES_SCHEMA)return {state:emptyState(),locked:true};
 if(raw?.schemaVersion!==UPDATES_SCHEMA)return {state:emptyState(),locked:false};
 const state=emptyState();
 for(const [id,source] of Object.entries(plain(raw.sources)?raw.sources:{})){const s=/^[a-z][a-z0-9:._-]{0,63}$/.test(id)?sourceOf(source):null;if(s)state.sources[id]=s;}
 for(const [version,q] of Object.entries(plain(raw.quarantined)?raw.quarantined:{}).slice(0,50))if(/^[0-9A-Za-z.+-]{1,64}$/.test(version)&&plain(q)&&time(q.at))state.quarantined[version]={at:q.at,reason:clean(q.reason,120).trim()||null};
 if(plain(raw.dismissed)&&typeof raw.dismissed.version==='string'&&time(raw.dismissed.at))state.dismissed={version:raw.dismissed.version.slice(0,64),by:clean(raw.dismissed.by,80)||null,at:raw.dismissed.at};
 return {state,locked:false};
}

// --- the checker ------------------------------------------------------------------------------------
/**
 * version: readVersion(); settings: updateSettings(); enabled(): is the integration on right now.
 * fetchJson: (url, {etag, timeoutMs}) => {status, etag, json}: the tests' stand-in for the network. Without it
 * each check builds one from fetchImpl (default: fetch) and the optional GitHub token.
 * now, random, setTimer, clearTimer: the clock and the timers (tests).
 */
export function createUpdateChecker({stateDirectory,file=path.join(stateDirectory,'updates.json'),version,settings,enabled=()=>true,fetchJson=null,fetchImpl=undefined,
 loadToken=loadGithubToken,now=Date.now,random=Math.random,setTimer=setTimeout,clearTimer=clearTimeout,timing=UPDATE_TIMING,log=message=>console.error(message)}){
 let {state,locked}=readUpdateState(file);
 if(locked)log(`Update check: ${file} was written by a newer Home Hub; it is left alone and results are not kept.`);
 let timer=null,started=false,running=null,nextAt=null,queue=Promise.resolve();
 const interval=()=>settings.intervalHours*HOUR;
 // A result belongs to the repository and channel it was asked about; after either changes it is not shown.
 const record=()=>{const r=state.sources[CORE_SOURCE];return r&&r.repo===settings.repo&&r.channel===settings.channel?r:null;};
 const active=()=>!settings.envOff&&Boolean(settings.repo)&&Boolean(enabled());
 const save=()=>{if(locked)return Promise.resolve();
  const doc=JSON.stringify({schemaVersion:UPDATES_SCHEMA,...state},null,1)+'\n';
  return queue=queue.catch(()=>{}).then(async()=>{await mkdir(path.dirname(file),{recursive:true,mode:0o700});const tmp=`${file}.${process.pid}.tmp`;await writeFile(tmp,doc,{mode:0o600});await rename(tmp,file);})
   .catch(e=>log(`Update check: could not write ${file}: ${e.message}`));};
 const put=next=>{state={...state,sources:{...state.sources,[CORE_SOURCE]:next}};return save();};

 async function attempt(){
  const prev=record(),at=now(),base={repo:settings.repo,channel:settings.channel,attemptedAt:iso(at)};
  let fetcher=fetchJson;
  if(!fetcher){let token=null;try{token=(await loadToken()).token;}catch{}fetcher=createFetchJson({token,fetchImpl,userAgent:UPDATE_USER_AGENT});}
  const call=(url,options)=>fetcher(url,{...options,timeoutMs:timing.requestTimeoutMs});
  const fresh=(found,cache)=>({...base,checkedAt:iso(at),version:found?.version??null,tag:found?.tag??null,url:found?releaseUrl(settings.repo,found.url,found.tag):null,
   publishedAt:time(found?.publishedAt)?found.publishedAt:null,notes:clean(found?.notes,RELEASE_NOTES_LIMIT),failures:0,cache:cache??null});
  try{
   const found=await resolveUpstream({type:'github',repo:settings.repo,allowPrerelease:settings.channel==='prerelease',notes:true},{fetchJson:call,previous:prev?.cache?{ok:true,cache:prev.cache}:null});
   return put(fresh(found,found.cache));
  }catch(e){
   // Every request was answered and there is no release that counts: an answer, not a failure.
   if(e?.code==='no-release')return put(fresh(null,e.cache));
   const {notBefore,...kept}=prev||{version:null,tag:null,url:null,publishedAt:null,notes:'',checkedAt:null,cache:null};
   const retryAt=e?.rateLimit?.retryAt;
   return put({...kept,...base,failedAt:iso(at),error:errorCode(e),failures:(prev?.failures||0)+1,
    ...(Number.isFinite(retryAt)&&retryAt>at?{notBefore:iso(Math.min(retryAt,at+timing.rateLimitMaxMs))}:{})});
  }
 }
 // How long until the next scheduled attempt, counted from now.
 function delayAfter(){
  const r=record();
  let delay=r?.failures>0?(timing.backoffMs[r.failures-1]??interval()):interval()+(random()*2-1)*timing.jitterMs;
  if(r?.notBefore)delay=Math.max(delay,time(r.notBefore)-now());
  return Math.max(MINUTE,delay);
 }
 function arm(delay){
  if(!started)return;
  if(timer)clearTimer(timer);
  nextAt=now()+delay;timer=setTimer(tick,delay);timer?.unref?.();
 }
 async function tick(){
  timer=null;
  try{if(active())await check();}catch(e){log(`Update check failed: ${e?.message||e}`);}
  arm(delayAfter());
 }
 /** → {checked, reason?}. Makes no request while off, before a rate limit lifts, or within a minute of the last attempt. */
 async function check(){
  if(!active())return {checked:false,reason:settings.envOff?'env-off':!settings.repo?'no-repo':'disabled'};
  if(!running){
   const r=record(),t=now(),last=time(r?.attemptedAt);
   if(r?.notBefore&&time(r.notBefore)>t)return {checked:false,reason:'rate-limited'};
   if(last!==null&&t>=last&&t-last<timing.forceGapMs)return {checked:false,reason:'too-soon'};
   running=attempt().finally(()=>{running=null;});
  }
  await running;
  return {checked:true};
 }
 return {
  file,
  /** Arms the first check. No request is made here. A hub that checked recently waits out the rest of its interval. */
  start(){
   if(started)return;started=true;
   const r=record();let delay=timing.firstMinMs+random()*(timing.firstMaxMs-timing.firstMinMs);
   const last=time(r?.attemptedAt);
   if(last!==null){const due=last+(r.failures>0?(timing.backoffMs[r.failures-1]??interval()):interval())-now();delay=Math.min(Math.max(delay,due),interval()+timing.jitterMs);}
   if(r?.notBefore)delay=Math.max(delay,Math.min(time(r.notBefore)-now(),timing.rateLimitMaxMs));
   arm(delay);
  },
  async stop(){started=false;if(timer)clearTimer(timer);timer=null;nextAt=null;await Promise.resolve(running).catch(()=>{});await queue.catch(()=>{});},
  /** The integration was turned on again: look soon instead of waiting for the next slot. */
  resume(){if(started&&active())arm(timing.resumeMs);},
  /** A check asked for by a person ("Test now"). The schedule then counts from it. */
  async checkNow(){const done=await check();if(done.checked)arm(delayAfter());return done;},
  check,
  /** Do not point at this release in the footer any more. Only the newest known release can be dismissed. */
  async dismiss(target,by){
   const r=record();
   if(typeof target!=='string'||!r?.version||target!==r.version||!(compareVersions(r.version,version.version)>0))throw new Error('invalid');
   state={...state,dismissed:{version:r.version,by:clean(by,80)||null,at:iso(now())}};await save();
   return state.dismissed;
  },
  view:(extra={})=>updateView({record:record(),quarantined:state.quarantined,dismissed:state.dismissed,version,settings,enabled:Boolean(enabled()),now:now(),nextAt:started?nextAt:null,...extra}),
  state:()=>structuredClone(state),
 };
}

// --- what is known ------------------------------------------------------------------------------------
/**
 * state: ok | stale | error | off | not-configured | disabled (the integration states).
 * code says which case it is:
 *   current      the last check succeeded and the newest release is the one running
 *   available    … and a newer release exists
 *   development  … and this is a checkout that is not on its release tag, or one ahead of every release
 *   no-release   … and the repository has published nothing (that counts) yet
 *   failed       the last attempt failed after an earlier success: what is shown is the last known release
 *   old          no attempt failed, but the last success is older than three intervals
 *   never        no check has succeeded yet
 *   pending      no check has been attempted yet (a hub that just started for the first time)
 *   env-off, no-repo, disabled
 */
export function updateView({record=null,quarantined={},dismissed=null,version,settings,enabled=true,now=Date.now(),nextAt=null,timing=UPDATE_TIMING,repoSource=null}){
 const installed={version:version.version,label:version.label,exact:version.exact,commit:version.commit,dataEpoch:version.dataEpoch};
 const base={schemaVersion:1,generatedAt:iso(now),installed,repo:settings.repo,repoSource:repoSource??settings.repoSource??null,channel:settings.channel,intervalHours:settings.intervalHours,
  latest:null,updateAvailable:false,dismissed:false,quarantined:null,checkedAt:null,failedAt:null,error:null,notBefore:null,nextCheckAt:null};
 if(settings.envOff)return {...base,state:'off',code:'env-off'};
 if(!settings.repo)return {...base,state:'not-configured',code:'no-repo'};
 if(!enabled)return {...base,state:'disabled',code:'disabled'};
 const r=record,next=Number.isFinite(nextAt)?iso(nextAt):null,wait=r?.notBefore&&time(r.notBefore)>now?r.notBefore:null;
 if(!r||(!r.checkedAt&&!r.failedAt))return {...base,state:'stale',code:'pending',nextCheckAt:next};
 if(!r.checkedAt)return {...base,state:'error',code:'never',failedAt:r.failedAt,error:r.error,notBefore:wait,nextCheckAt:next};
 const latest=r.version?{version:r.version,tag:r.tag,url:r.url,publishedAt:r.publishedAt,notes:r.notes||''}:null;
 const order=latest?compareVersions(latest.version,version.version):null,updateAvailable=order!==null&&order>0;
 const failed=Boolean(r.failedAt)&&time(r.failedAt)>time(r.checkedAt),old=now-time(r.checkedAt)>settings.intervalHours*HOUR*timing.staleIntervals;
 const code=failed?'failed':old?'old':!latest?'no-release':version.exact===false||order<0?'development':updateAvailable?'available':'current';
 const q=latest&&Object.hasOwn(quarantined,latest.version)?quarantined[latest.version]:null;
 return {...base,state:failed||old?'stale':'ok',code,latest,updateAvailable,dismissed:Boolean(updateAvailable&&dismissed?.version===latest.version),
  quarantined:q&&updateAvailable?{version:latest.version,at:q.at,reason:q.reason}:null,
  checkedAt:r.checkedAt,failedAt:failed?r.failedAt:null,error:failed?r.error:null,notBefore:wait,nextCheckAt:next};
}

// --- sentences ----------------------------------------------------------------------------------------
// Czech source text with {placeholders}; English is in public/i18n-en-updates.js (tests/updates.test.mjs
// checks that every template here has an entry).
export const UPDATE_TEXT=Object.freeze({
 current:'{version} je nejnovější vydání.',
 available:'Je dostupné vydání {latest} z {date}. Běží {installed}.',
 availableUndated:'Je dostupné vydání {latest}. Běží {installed}.',
 development:'Vývojové sestavení {installed}; nejnovější vydání je {latest}.',
 developmentBehind:'Vývojové sestavení {installed}; je dostupné vydání {latest}.',
 noRelease:'Repozitář {repo} zatím žádné vydání nezveřejnil. Běží {installed}.',
 failed:'Od {since} se nepodařilo zkontrolovat ({error}). Poslední známé vydání bylo {latest}; jestli je to pořád nejnovější, není známo.',
 failedNoRelease:'Od {since} se nepodařilo zkontrolovat ({error}). Tehdy repozitář žádné vydání neměl.',
 old:'Poslední úspěšná kontrola byla {since}. Tehdy bylo nejnovější vydání {latest}; jestli to pořád platí, není známo.',
 oldNoRelease:'Poslední úspěšná kontrola byla {since}. Tehdy repozitář žádné vydání neměl.',
 never:'Žádná kontrola se zatím nepovedla ({error}).',
 pending:'Zatím se nekontrolovalo. První kontrola proběhne během několika minut.',
 envOff:'Kontrola aktualizací je vypnutá proměnnou HOME_HUB_UPDATE_CHECK=off. Home Hub nekontaktuje nikoho.',
 noRepo:'Není nastavené, odkud vydání číst: package.json → homeHub.updates.repo, nebo updates.repo v site.json.',
 disabled:'Kontrola aktualizací je vypnutá. Home Hub nekontaktuje nikoho.',
 waiting:'GitHub odmítá další dotazy do {until}; do té doby se Home Hub neptá.',
 quarantined:'Vydání {version} se tu {date} zkoušelo a vrátilo zpět ({reason}).',
 quarantinedPlain:'Vydání {version} se tu {date} zkoušelo a vrátilo zpět.',
});
// A time as the site reads it: "2026-11-09 08:00" (or just the date). The site's zone, else UTC.
function stamp(value,timeZone,{date=false}={}){
 const ms=time(value);if(ms===null)return '';
 const format=zone=>new Intl.DateTimeFormat('sv-SE',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',...(date?{}:{hour:'2-digit',minute:'2-digit'})}).format(new Date(ms));
 try{return format(timeZone||'UTC');}catch{return format('UTC');}
}
/** One sentence for the state, as {text, parts} (server/text.mjs). */
export function updateSummary(view,{timeZone=null}={}){
 const T=UPDATE_TEXT,installed=view.installed.label,latest=view.latest?.version;
 switch(view.code){
  case 'env-off':return tx(T.envOff);
  case 'no-repo':return tx(T.noRepo);
  case 'disabled':return tx(T.disabled);
  case 'pending':return tx(T.pending);
  case 'never':return tx(T.never,{error:view.error||'?'});
  case 'failed':return latest?tx(T.failed,{since:stamp(view.checkedAt,timeZone),error:view.error||'?',latest}):tx(T.failedNoRelease,{since:stamp(view.checkedAt,timeZone),error:view.error||'?'});
  case 'old':return latest?tx(T.old,{since:stamp(view.checkedAt,timeZone),latest}):tx(T.oldNoRelease,{since:stamp(view.checkedAt,timeZone)});
  case 'no-release':return tx(T.noRelease,{repo:view.repo,installed});
  case 'development':return tx(view.updateAvailable?T.developmentBehind:T.development,{installed,latest});
  case 'available':{const date=stamp(view.latest.publishedAt,timeZone,{date:true});return date?tx(T.available,{latest,date,installed}):tx(T.availableUndated,{latest,installed});}
  default:return tx(T.current,{version:latest});
 }
}
/** The view as an integration status (server/integrations.mjs → Status). */
export function integrationStatus(view,{timeZone=null}={}){
 const summary=updateSummary(view,{timeZone}),items=[];
 if(view.notBefore)items.push({id:'rate-limit',label:'Limit GitHubu',state:'off',summary:tx(UPDATE_TEXT.waiting,{until:stamp(view.notBefore,timeZone)})});
 if(view.quarantined){const q=view.quarantined,date=stamp(q.at,timeZone,{date:true});
  items.push({id:'quarantine',label:'Vrácená aktualizace',state:'stale',summary:q.reason?tx(UPDATE_TEXT.quarantined,{version:q.version,date,reason:q.reason}):tx(UPDATE_TEXT.quarantinedPlain,{version:q.version,date})});}
 const configuredBy=[];
 if(view.repo)configuredBy.push(view.repoSource==='site.json'?{source:'site.json',name:`updates.repo = ${view.repo}`}:{source:'file',name:`package.json → homeHub.updates.repo = ${view.repo}`});
 if(view.channel==='prerelease')configuredBy.push({source:'site.json',name:'updates.channel = prerelease'});
 if(view.code==='env-off')configuredBy.push({source:'env',name:'HOME_HUB_UPDATE_CHECK=off'});
 return {state:view.state,summary,lastSuccessAt:view.checkedAt,lastError:view.error,configuredBy,items};
}
