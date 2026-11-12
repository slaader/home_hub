// The update check (server/update-check.mjs, server/core/updates.mjs, public/updates-view.js) against a
// fake GitHub, a fake clock and fake timers: no test here touches the network.
// What must hold: a newer release is told, the same one is "newest", unchanged answers cost a 304, a refusal
// with a reset time is waited out, a failure never reads as "up to date", off means zero requests,
// pre-releases are ignored on the stable channel, a development build says so, and a release that was
// rolled back here is marked.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,stat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createUpdateChecker,updateSettings,updateSummary,integrationStatus,releaseUrl,errorCode,readUpdateState,UPDATE_TEXT,UPDATE_TIMING,UPDATE_USER_AGENT,UPDATES_SCHEMA,UPDATE_INTEGRATION} from '../server/update-check.mjs';
import {createFetchJson,rateLimitOf} from '../server/systems-upstream.mjs';
import {validateSite,EMPTY_SITE} from '../server/site-config.mjs';
import updatesModule from '../server/core/updates.mjs';
import {installDom,fire} from './fixtures/mini-dom.mjs';
import {hub} from './hub-helper.mjs';

const REPO='alice/home-hub',MINUTE=60000,HOUR=3600000;
const START=Date.parse('2026-11-12T10:00:00Z');
const V=(version,exact=true)=>({version,dataEpoch:1,commit:'abc1234',exact,label:exact===false?`${version}+dev (abc1234)`:version,updates:{repo:null}});
const SETTINGS=(over={})=>({repo:REPO,repoSource:'package.json',channel:'stable',intervalHours:12,envOff:false,...over});
const release=(tag,{prerelease=false,draft=false,body=`Notes for ${tag}`,at='2026-11-10T09:00:00Z'}={})=>({tag_name:tag,prerelease,draft,html_url:`https://github.com/${REPO}/releases/tag/${tag}`,published_at:at,body,assets:[{name:'ignored'}]});

// GitHub's two endpoints, with an ETag per endpoint that changes when the releases change.
function github(releases=[]){
 const g={releases,revision:1,calls:[],fail:null};
 g.publish=(...more)=>{g.releases=[...more,...g.releases];g.revision++;};
 g.fetchJson=async(url,{etag=null}={})=>{
  g.calls.push({url,etag});
  if(g.fail)throw g.fail;
  const list=url===`https://api.github.com/repos/${REPO}/releases?per_page=20`;
  if(!list)assert.equal(url,`https://api.github.com/repos/${REPO}/releases/latest`);
  const tag=`"${list?'list':'latest'}-${g.revision}"`;
  const latest=g.releases.find(r=>!r.prerelease&&!r.draft);
  if(!list&&!latest)throw Object.assign(new Error('HTTP 404 https://api.github.com/…'),{status:404});
  if(etag===tag)return {status:304,etag};
  return {status:200,etag:tag,json:list?g.releases:latest};
 };
 return g;
}
function clock(start=START){
 const c={t:start,timers:[]};
 c.now=()=>c.t;
 c.setTimer=(fn,ms)=>{const timer={fn,at:c.t+ms,ms,unref(){}};c.timers.push(timer);return timer;};
 c.clearTimer=timer=>{c.timers=c.timers.filter(x=>x!==timer);};
 // Move the clock; every timer that came due runs (and may arm the next one).
 c.advance=async ms=>{const end=c.t+ms;for(;;){const due=c.timers.filter(x=>x.at<=end).sort((a,b)=>a.at-b.at)[0];if(!due)break;c.timers=c.timers.filter(x=>x!==due);c.t=due.at;await due.fn();}c.t=end;};
 return c;
}
async function tmp(t){const dir=await mkdtemp(path.join(os.tmpdir(),'hub-updates-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
async function setup(t,{version=V('1.1.0'),releases=[release('v1.1.0'),release('v1.0.0',{at:'2026-11-01T09:00:00Z'})],settings={},dir=null,...extra}={}){
 const stateDirectory=dir||await tmp(t),g=github(releases),c=clock();
 const checker=createUpdateChecker({stateDirectory,version,settings:SETTINGS(settings),fetchJson:g.fetchJson,now:c.now,setTimer:c.setTimer,clearTimer:c.clearTimer,random:()=>0.5,log:()=>{},...extra});
 return {stateDirectory,g,c,checker,file:path.join(stateDirectory,'updates.json')};
}
const sentence=view=>updateSummary(view,{timeZone:'UTC'}).text;

test('a newer release is told, the same one is the newest, and an unchanged answer is a 304',async t=>{
 const {g,c,checker,file,stateDirectory}=await setup(t);
 assert.deepEqual({state:checker.view().state,code:checker.view().code},{state:'stale',code:'pending'},'nothing is known before the first check, and it does not say "ok"');
 assert.deepEqual(await checker.check(),{checked:true});
 assert.deepEqual(g.calls,[{url:`https://api.github.com/repos/${REPO}/releases?per_page=20`,etag:null},{url:`https://api.github.com/repos/${REPO}/releases/latest`,etag:null}],'two requests, nothing but per_page in the query');
 let view=checker.view();
 assert.deepEqual({state:view.state,code:view.code,available:view.updateAvailable,latest:view.latest.version,checkedAt:view.checkedAt},{state:'ok',code:'current',available:false,latest:'1.1.0',checkedAt:'2026-11-12T10:00:00.000Z'});
 assert.equal(sentence(view),'1.1.0 je nejnovější vydání.');
 // a second look within a minute asks nobody
 assert.deepEqual(await checker.check(),{checked:false,reason:'too-soon'});assert.equal(g.calls.length,2);
 // later: both requests carry their own ETag and both answer 304; the result is fresh again
 c.t+=2*HOUR;await checker.check();
 assert.deepEqual(g.calls.slice(2).map(x=>x.etag),['"list-1"','"latest-1"']);
 view=checker.view();assert.equal(view.code,'current');assert.equal(view.checkedAt,'2026-11-12T12:00:00.000Z');
 // a release appears
 g.publish(release('v1.2.0',{at:'2026-11-12T11:30:00Z',body:'## Added\n- the update check'}));
 c.t+=2*HOUR;await checker.check();
 view=checker.view();
 assert.deepEqual({state:view.state,code:view.code,available:view.updateAvailable,dismissed:view.dismissed},{state:'ok',code:'available',available:true,dismissed:false});
 assert.deepEqual(view.latest,{version:'1.2.0',tag:'v1.2.0',url:`https://github.com/${REPO}/releases/tag/v1.2.0`,publishedAt:'2026-11-12T11:30:00Z',notes:'## Added\n- the update check'});
 assert.equal(sentence(view),'Je dostupné vydání 1.2.0 z 2026-11-12. Běží 1.1.0.');
 assert.deepEqual(view.installed,{version:'1.1.0',label:'1.1.0',exact:true,commit:'abc1234',dataEpoch:1});
 // the state file: private, versioned, with the ETag cache; a restart reads it and asks nobody
 assert.equal((await stat(file)).mode&0o777,0o600);
 const doc=JSON.parse(await readFile(file,'utf8'));
 assert.equal(doc.schemaVersion,UPDATES_SCHEMA);assert.equal(doc.sources.core.cache.v,2);assert.equal(doc.sources.core.repo,REPO);assert.deepEqual(doc.quarantined,{});assert.equal(doc.dismissed,null);
 const again=await setup(t,{dir:stateDirectory});again.c.t=c.t;
 assert.equal(again.checker.view().code,'available');assert.equal(again.g.calls.length,0);
 // the same file under another repository or channel is not this hub's answer
 assert.equal((await setup(t,{dir:stateDirectory,settings:{repo:'bob/fork'}})).checker.view().code,'pending');
 assert.equal((await setup(t,{dir:stateDirectory,settings:{channel:'prerelease'}})).checker.view().code,'pending');
});

test('pre-releases and drafts are ignored on the stable channel; the prerelease channel takes them',async t=>{
 const releases=[release('v1.3.0-rc.1',{prerelease:true}),release('v1.2.5',{draft:true}),release('v1.2.0'),release('nightly'),release('v1.1.0')];
 const stable=await setup(t,{version:V('1.2.0'),releases});await stable.checker.check();
 assert.deepEqual({code:stable.checker.view().code,latest:stable.checker.view().latest.version,available:stable.checker.view().updateAvailable},{code:'current',latest:'1.2.0',available:false});
 const pre=await setup(t,{version:V('1.2.0'),releases,settings:{channel:'prerelease'}});await pre.checker.check();
 assert.deepEqual({code:pre.checker.view().code,latest:pre.checker.view().latest.version,available:pre.checker.view().updateAvailable},{code:'available',latest:'1.3.0-rc.1',available:true});
 // only pre-releases published: on the stable channel that is "no release yet"
 const only=await setup(t,{version:V('1.0.0'),releases:[release('v1.1.0-rc.1',{prerelease:true})]});await only.checker.check();
 assert.equal(only.checker.view().code,'no-release');
 // someone running the release candidate is told when the release itself is out
 const rc=await setup(t,{version:V('1.3.0-rc.1'),releases:[release('v1.3.0')]});await rc.checker.check();
 assert.equal(rc.checker.view().updateAvailable,true);
});

test('a repository without releases is an answer, not a failure, and it is cached',async t=>{
 const {g,c,checker}=await setup(t,{version:V('1.0.0'),releases:[]});
 await checker.check();
 const view=checker.view();
 assert.deepEqual({state:view.state,code:view.code,latest:view.latest,available:view.updateAvailable,error:view.error},{state:'ok',code:'no-release',latest:null,available:false,error:null});
 assert.equal(sentence(view),`Repozitář ${REPO} zatím žádné vydání nezveřejnil. Běží 1.0.0.`);
 c.t+=HOUR;await checker.check();
 assert.deepEqual(g.calls.slice(2).map(x=>x.etag),['"list-1"',null],'the list is asked with its ETag; "no latest release" is a 404 every time');
 assert.equal(checker.view().code,'no-release');
 g.publish(release('v1.0.0'));c.t+=HOUR;await checker.check();assert.equal(checker.view().code,'current');
});

test('a failed check never reads as up to date: stale after a success, error before the first one',async t=>{
 const {g,c,checker}=await setup(t,{releases:[release('v1.1.0')]});
 await checker.check();assert.equal(checker.view().code,'current');
 g.fail=Object.assign(new TypeError('fetch failed'),{cause:{code:'ENOTFOUND'}});
 c.t+=3*HOUR;await checker.check();
 let view=checker.view();
 assert.deepEqual({state:view.state,code:view.code,error:view.error,checkedAt:view.checkedAt,failedAt:view.failedAt,latest:view.latest.version,available:view.updateAvailable},
  {state:'stale',code:'failed',error:'ENOTFOUND',checkedAt:'2026-11-12T10:00:00.000Z',failedAt:'2026-11-12T13:00:00.000Z',latest:'1.1.0',available:false});
 assert.equal(sentence(view),'Od 2026-11-12 10:00 se nepodařilo zkontrolovat (ENOTFOUND). Poslední známé vydání bylo 1.1.0; jestli je to pořád nejnovější, není známo.');
 const status=integrationStatus(view,{timeZone:'Europe/Prague'});
 assert.equal(status.state,'stale');assert.equal(status.lastSuccessAt,'2026-11-12T10:00:00.000Z');assert.equal(status.lastError,'ENOTFOUND');assert.match(status.summary.text,/^Od 2026-11-12 11:00 /,'in the site\'s zone');
 // a release that was already known to be newer stays known while the network is down
 const behind=await setup(t,{version:V('1.0.0'),releases:[release('v1.1.0')]});await behind.checker.check();
 behind.g.fail=Object.assign(new Error('HTTP 500 https://api.github.com/repos/x/y/releases'),{status:500});behind.c.t+=3*HOUR;await behind.checker.check();
 assert.deepEqual({state:behind.checker.view().state,error:behind.checker.view().error,available:behind.checker.view().updateAvailable},{state:'stale',error:'HTTP 500',available:true});
 // it works again: fresh, and the failure is gone
 g.fail=null;c.t+=3*HOUR;await checker.check();
 view=checker.view();assert.deepEqual({state:view.state,code:view.code,error:view.error,failedAt:view.failedAt},{state:'ok',code:'current',error:null,failedAt:null});
 // no failure, but nobody looked for more than three intervals (36 h): not known either
 c.t+=37*HOUR;view=checker.view();
 assert.deepEqual({state:view.state,code:view.code},{state:'stale',code:'old'});assert.match(sentence(view),/^Poslední úspěšná kontrola byla 2026-11-12 16:00\. .*není známo\.$/);
 // never succeeded
 const never=await setup(t);never.g.fail=Object.assign(new Error('timed out'),{name:'TimeoutError'});await never.checker.check();
 view=never.checker.view();
 assert.deepEqual({state:view.state,code:view.code,error:view.error,latest:view.latest,available:view.updateAvailable,checkedAt:view.checkedAt},{state:'error',code:'never',error:'timeout',latest:null,available:false,checkedAt:null});
 assert.equal(sentence(view),'Žádná kontrola se zatím nepovedla (timeout).');
 for(const v of [view,behind.checker.view()])assert.ok(!/nejnovější vydání\.$/.test(sentence(v)));
 assert.equal(errorCode(new Error('boom https://api.github.com/repos/a/b/releases?per_page=20 now')),'boom  now','no address in what is kept');
});

test('a refusal with a reset time is waited out, for at most a day; the request says nothing about this hub',async t=>{
 const dir=await tmp(t),c=clock(),calls=[];
 let reset=Math.floor((START+40*MINUTE)/1000),answer='limit';
 const fetchImpl=async(url,init)=>{
  calls.push({url,headers:init.headers});
  if(answer==='limit')return new Response('{"message":"API rate limit exceeded"}',{status:403,headers:{'x-ratelimit-remaining':'0','x-ratelimit-reset':String(reset)}});
  return url.endsWith('/latest')?new Response('{}',{status:404}):new Response('[]',{status:200,headers:{etag:'"e"'}});
 };
 const checker=createUpdateChecker({stateDirectory:dir,version:V('1.1.0'),settings:SETTINGS(),fetchImpl,loadToken:async()=>({token:null}),now:c.now,setTimer:c.setTimer,clearTimer:c.clearTimer,random:()=>0.5,log:()=>{}});
 await checker.check();
 assert.equal(calls.length,1,'the list failed, so the second request is not made');
 assert.deepEqual(calls[0].headers,{'User-Agent':UPDATE_USER_AGENT,Accept:'application/vnd.github+json'},'a constant name, no token, no version, no instance id');
 assert.equal(UPDATE_USER_AGENT,'home-hub-update-check');
 let view=checker.view();
 assert.deepEqual({state:view.state,code:view.code,error:view.error,notBefore:view.notBefore},{state:'error',code:'never',error:'HTTP 403',notBefore:'2026-11-12T10:40:00.000Z'});
 assert.deepEqual(integrationStatus(view,{timeZone:'UTC'}).items.map(i=>[i.id,i.state,i.summary.text]),[['rate-limit','off','GitHub odmítá další dotazy do 2026-11-12 10:40; do té doby se Home Hub neptá.']]);
 c.t+=10*MINUTE;assert.deepEqual(await checker.checkNow(),{checked:false,reason:'rate-limited'});assert.equal(calls.length,1,'asking again before the reset makes no request');
 // the schedule waits for the reset too, not just for the one-hour backoff
 checker.start();assert.ok(c.timers[0].at>=START+40*MINUTE);await checker.stop();
 c.t=START+41*MINUTE;answer='ok';assert.deepEqual(await checker.check(),{checked:true});
 assert.equal(calls.length,3);assert.equal(checker.view().notBefore,null);assert.equal(checker.view().code,'no-release');
 // a reset far in the future is not believed beyond a day
 answer='limit';reset=Math.floor((c.t+5*24*HOUR)/1000);c.t+=2*MINUTE;await checker.check();
 assert.equal(checker.view().notBefore,new Date(c.t+24*HOUR).toISOString());
 // what createFetchJson exposes: status and the rate limit of the refusal
 const refused=await createFetchJson({fetchImpl:async()=>new Response('{}',{status:429,headers:{'retry-after':'120'}})})('https://api.github.com/repos/a/b/releases').catch(e=>e);
 assert.equal(refused.status,429);assert.ok(Math.abs(refused.rateLimit.retryAt-(Date.now()+120000))<5000);assert.equal(refused.rateLimit.remaining,null);
 assert.deepEqual(rateLimitOf(new Headers({'x-ratelimit-remaining':'12','x-ratelimit-reset':'1900000000'}),0),{remaining:12,retryAt:null},'a reset only counts when nothing is left');
 assert.deepEqual(rateLimitOf(new Headers({'x-ratelimit-remaining':'0','x-ratelimit-reset':'1900000000','retry-after':'5'}),1000),{remaining:0,retryAt:1900000000000});
 assert.equal((await createFetchJson({fetchImpl:async()=>new Response('{}',{status:500})})('https://api.github.com/x').catch(e=>e)).rateLimit,undefined);
 // a token, when there is one, goes to api.github.com and is not part of the name
 const withToken=[];
 await createFetchJson({token:'t'.repeat(40),userAgent:UPDATE_USER_AGENT,fetchImpl:async(url,init)=>{withToken.push(init.headers);return new Response('[]',{status:200});}})('https://api.github.com/repos/a/b/releases');
 assert.deepEqual(withToken[0],{'User-Agent':UPDATE_USER_AGENT,Accept:'application/vnd.github+json',Authorization:`Bearer ${'t'.repeat(40)}`});
});

test('the schedule: first check 2 to 5 minutes after start, then every interval; backoff 1 h, 2 h, 4 h after failures',async t=>{
 for(const [random,minutes] of [[0,2],[1,5],[0.5,3.5]]){
  const s=await setup(t,{random:()=>random});s.checker.start();s.checker.start();
  assert.equal(s.c.timers.length,1);assert.equal(s.c.timers[0].ms,minutes*MINUTE);assert.equal(s.g.calls.length,0,'starting asks nobody');
  await s.checker.stop();assert.equal(s.c.timers.length,0);
 }
 const {g,c,checker,stateDirectory}=await setup(t);
 checker.start();assert.equal(checker.view().nextCheckAt,new Date(START+3.5*MINUTE).toISOString());
 await c.advance(4*MINUTE);
 assert.equal(g.calls.length,2);assert.equal(checker.view().code,'current');
 assert.equal(c.timers.length,1);assert.equal(c.timers[0].ms,12*HOUR,'random 0.5 = no jitter');
 await c.advance(12*HOUR);assert.equal(g.calls.length,4);
 // failures: 1 h, 2 h, 4 h, then the normal interval again
 g.fail=Object.assign(new Error('HTTP 502'),{status:502});
 const waits=[];
 for(let i=0;i<5;i++){await c.advance(c.timers[0].at-c.t);waits.push(c.timers[0].ms/HOUR);}
 assert.deepEqual(waits,[1,2,4,12,12]);
 g.fail=null;await c.advance(c.timers[0].at-c.t);assert.equal(checker.view().code,'current');assert.equal(c.timers[0].ms,12*HOUR);
 // jitter is ± 30 minutes
 const early=await setup(t,{random:()=>0}),late=await setup(t,{random:()=>1});
 for(const s of [early,late]){s.checker.start();await s.c.advance(6*MINUTE);}
 assert.equal(early.c.timers[0].ms,11.5*HOUR);assert.equal(late.c.timers[0].ms,12.5*HOUR);
 // a restart soon after a check waits out the rest of the interval instead of asking again
 const last=c.t;await checker.stop();
 const next=await setup(t,{dir:stateDirectory});next.c.t=last+HOUR;next.checker.start();
 assert.equal(next.c.timers[0].ms,11*HOUR);await next.c.advance(10*HOUR);assert.equal(next.g.calls.length,0);
 // a person's check moves the schedule to count from it
 const forced=await setup(t);forced.checker.start();forced.c.t+=MINUTE;
 assert.deepEqual(await forced.checker.checkNow(),{checked:true});assert.equal(forced.c.timers.length,1);assert.equal(forced.c.timers[0].ms,12*HOUR);
 assert.deepEqual(await forced.checker.checkNow(),{checked:false,reason:'too-soon'},'at most one forced check a minute');assert.equal(forced.g.calls.length,2);
 assert.deepEqual([UPDATE_TIMING.firstMinMs,UPDATE_TIMING.firstMaxMs,UPDATE_TIMING.jitterMs,UPDATE_TIMING.forceGapMs,UPDATE_TIMING.rateLimitMaxMs],[2*MINUTE,5*MINUTE,30*MINUTE,MINUTE,24*HOUR]);
 // the interval comes from the configuration
 const weekly=await setup(t,{settings:{intervalHours:168}});weekly.checker.start();await weekly.c.advance(4*MINUTE);assert.equal(weekly.c.timers[0].ms,168*HOUR);
 weekly.c.t+=10*24*HOUR;assert.equal(weekly.checker.view().state,'ok','stale only after three of its own intervals');
});

test('off means zero requests: the switch, the environment, and no repository',async t=>{
 // the environment
 const env=await setup(t,{settings:{envOff:true}});env.checker.start();await env.c.advance(72*HOUR);
 assert.deepEqual(await env.checker.checkNow(),{checked:false,reason:'env-off'});assert.equal(env.g.calls.length,0);
 assert.deepEqual({state:env.checker.view().state,code:env.checker.view().code},{state:'off',code:'env-off'});
 assert.equal(sentence(env.checker.view()),'Kontrola aktualizací je vypnutá proměnnou HOME_HUB_UPDATE_CHECK=off. Home Hub nekontaktuje nikoho.');
 assert.deepEqual(integrationStatus(env.checker.view()).configuredBy.at(-1),{source:'env',name:'HOME_HUB_UPDATE_CHECK=off'});
 // the switch, and turning it on again without a restart
 let on=false;
 const sw=await setup(t,{enabled:()=>on});sw.checker.start();await sw.c.advance(72*HOUR);
 assert.deepEqual(await sw.checker.checkNow(),{checked:false,reason:'disabled'});assert.equal(sw.g.calls.length,0);
 assert.deepEqual({state:sw.checker.view().state,code:sw.checker.view().code,latest:sw.checker.view().latest},{state:'disabled',code:'disabled',latest:null});
 on=true;sw.checker.resume();assert.equal(sw.c.timers[0].ms,UPDATE_TIMING.resumeMs);await sw.c.advance(10000);
 assert.equal(sw.g.calls.length,2);assert.equal(sw.checker.view().code,'current');
 on=false;await sw.c.advance(72*HOUR);assert.equal(sw.g.calls.length,2,'turned off again: the schedule keeps ticking and asks nothing');
 assert.equal(sw.checker.view().latest,null,'and what was known is not shown');
 // no repository
 const none=await setup(t,{settings:{repo:null,repoSource:null}});none.checker.start();await none.c.advance(72*HOUR);
 assert.deepEqual(await none.checker.checkNow(),{checked:false,reason:'no-repo'});assert.equal(none.g.calls.length,0);
 assert.deepEqual({state:none.checker.view().state,code:none.checker.view().code},{state:'not-configured',code:'no-repo'});
 // settings: site.json over package.json; only "off" turns it off
 const version={...V('1.0.0'),updates:{repo:'core/repo'}};
 assert.deepEqual(updateSettings({site:EMPTY_SITE,version,env:{}}),{repo:'core/repo',repoSource:'package.json',channel:'stable',intervalHours:12,envOff:false});
 assert.deepEqual(updateSettings({site:validateSite({updates:{repo:'alice/fork',channel:'prerelease',intervalHours:24}}),version,env:{HOME_HUB_UPDATE_CHECK:' OFF '}}),{repo:'alice/fork',repoSource:'site.json',channel:'prerelease',intervalHours:24,envOff:true});
 assert.equal(updateSettings({site:EMPTY_SITE,version:V('1.0.0'),env:{}}).repo,null);
 for(const value of ['on','1','','0','false'])assert.equal(updateSettings({env:{HOME_HUB_UPDATE_CHECK:value}}).envOff,false,value);
 assert.deepEqual(EMPTY_SITE.updates,{repo:null,channel:'stable',intervalHours:12});
 for(const bad of [{repo:'https://github.com/a/b'},{repo:'a'},{repo:'a/b.git'},{repo:7},{channel:'beta'},{intervalHours:5},{intervalHours:169},{intervalHours:'12'},{token:'x'}])assert.throws(()=>validateSite({updates:bad}),/site config: updates/,JSON.stringify(bad));
});

test('a development build says so; a release that was rolled back here is marked; a release can be dismissed',async t=>{
 // not on its release tag
 const dev=await setup(t,{version:V('1.1.0',false)});await dev.checker.check();
 assert.deepEqual({state:dev.checker.view().state,code:dev.checker.view().code,available:dev.checker.view().updateAvailable},{state:'ok',code:'development',available:false});
 assert.equal(sentence(dev.checker.view()),'Vývojové sestavení 1.1.0+dev (abc1234); nejnovější vydání je 1.1.0.');
 // ahead of every release
 const ahead=await setup(t,{version:V('1.3.0')});await ahead.checker.check();
 assert.equal(ahead.checker.view().code,'development');assert.equal(sentence(ahead.checker.view()),'Vývojové sestavení 1.3.0; nejnovější vydání je 1.1.0.');
 // a development build that is behind is still told about the release
 const behind=await setup(t,{version:V('1.0.0',false)});await behind.checker.check();
 assert.equal(behind.checker.view().updateAvailable,true);assert.equal(sentence(behind.checker.view()),'Vývojové sestavení 1.0.0+dev (abc1234); je dostupné vydání 1.1.0.');
 // a tree without git: the number stands as written
 const archive=await setup(t,{version:V('1.1.0',null)});await archive.checker.check();assert.equal(archive.checker.view().code,'current');

 // quarantine: written by whatever applied 1.2.0 here and had to roll it back
 const dir=await tmp(t);
 await writeFile(path.join(dir,'updates.json'),JSON.stringify({schemaVersion:1,sources:{},quarantined:{'1.2.0':{at:'2026-11-11T20:00:00Z',reason:'health check'},'1.1.5':{at:'2026-11-01T00:00:00Z',reason:'old'}},dismissed:null}));
 const q=await setup(t,{dir,releases:[release('v1.2.0'),release('v1.1.0')]});await q.checker.check();
 const view=q.checker.view();
 assert.equal(view.code,'available');assert.deepEqual(view.quarantined,{version:'1.2.0',at:'2026-11-11T20:00:00Z',reason:'health check'});
 const status=integrationStatus(view,{timeZone:'UTC'});
 assert.equal(status.state,'ok');assert.deepEqual(status.items.map(i=>[i.id,i.state,i.summary.text]),[['quarantine','stale','Vydání 1.2.0 se tu 2026-11-11 zkoušelo a vrátilo zpět (health check).']]);
 assert.deepEqual(JSON.parse(await readFile(q.file,'utf8')).quarantined['1.2.0'],{at:'2026-11-11T20:00:00Z',reason:'health check'},'a check keeps what it did not write');
 // dismiss: only the newest known release, and only while it is newer than what runs
 await assert.rejects(q.checker.dismiss('1.1.0','admin'),/invalid/);await assert.rejects(q.checker.dismiss('9.9.9','admin'),/invalid/);await assert.rejects(q.checker.dismiss(null,'admin'),/invalid/);
 assert.deepEqual(await q.checker.dismiss('1.2.0','admin'),{version:'1.2.0',by:'admin',at:new Date(q.c.t).toISOString()});
 assert.equal(q.checker.view().dismissed,true);assert.equal(q.checker.view().updateAvailable,true,'dismissed is about the footer, not about the fact');
 q.g.publish(release('v1.2.1'));q.c.t+=HOUR;await q.checker.check();
 assert.equal(q.checker.view().dismissed,false,'the next release is told again');assert.equal(q.checker.view().quarantined,null);
 const current=await setup(t);await current.checker.check();await assert.rejects(current.checker.dismiss('1.1.0','admin'),/invalid/);

 // a state file from newer code is neither used nor overwritten
 const newer=await tmp(t),text=JSON.stringify({schemaVersion:UPDATES_SCHEMA+1,sources:{core:{future:true}}});
 await writeFile(path.join(newer,'updates.json'),text);
 const logged=[];const n=await setup(t,{dir:newer,log:m=>logged.push(m)});await n.checker.check();
 assert.equal(n.checker.view().code,'current','it still checks, in memory');assert.equal(await readFile(path.join(newer,'updates.json'),'utf8'),text);assert.match(logged[0],/newer Home Hub/);
 assert.deepEqual(readUpdateState(path.join(newer,'nothing.json')),{state:{sources:{},quarantined:{},dismissed:null},locked:false});
 await writeFile(path.join(newer,'broken.json'),'{nope');assert.equal(readUpdateState(path.join(newer,'broken.json')).locked,false);
});

test('the release link leads to the repository\'s releases on GitHub or is rebuilt from the tag',()=>{
 const base=`https://github.com/${REPO}/releases/`;
 assert.equal(releaseUrl(REPO,`${base}tag/v1.2.0`,'v1.2.0'),`${base}tag/v1.2.0`);
 assert.equal(releaseUrl(REPO,`https://github.com/Alice/Home-Hub/releases/tag/v1.2.0`,'v1.2.0'),`${base}tag/v1.2.0`,'GitHub may spell the owner differently');
 for(const bad of ['https://evil.example/x',`https://github.com/${REPO}`,`https://github.com/${REPO}/releases`,`https://github.com/mallory/x/releases/tag/v1`,`javascript:alert(1)`,`${base}tag/v1"onclick="x`,null,7,`${base}${'a'.repeat(400)}`])
  assert.equal(releaseUrl(REPO,bad,'v1.2.0'),`${base}tag/v1.2.0`,String(bad));
 assert.equal(releaseUrl(REPO,null,null),base);assert.equal(releaseUrl(REPO,null,'v1 2/x'),`${base}tag/v1%202%2Fx`);
});

test('HTTP: anyone signed in reads it; checking and dismissing are an administrator\'s; off answers "disabled"',async t=>{
 const g=github([release('v1.2.0',{body:'<img src=x onerror=alert(1)>'}),release('v1.1.0')]),c=clock();
 const h=await hub(t,{version:V('1.1.0'),updateCheck:{settings:SETTINGS(),fetchJson:g.fetchJson,now:c.now,setTimer:c.setTimer,clearTimer:c.clearTimer,random:()=>0.5,log:()=>{}}});
 const reader=await h.account('reader',[]),full=await h.account('agent',['*']);
 const get=headers=>fetch(h.origin+'/api/updates',{headers});
 assert.equal((await get({})).status,401);
 const first=await (await get(reader.headers)).json();
 assert.deepEqual({state:first.state,code:first.code,latest:first.latest,apply:first.apply,summary:first.summary},{state:'stale',code:'pending',latest:null,apply:{automatic:false,tag:null,command:null},summary:UPDATE_TEXT.pending});
 assert.deepEqual(first.summaryT,[{key:UPDATE_TEXT.pending,params:{}}]);
 // no API key checks or dismisses, whatever its scopes; nor does anyone from another origin
 for(const key of [reader,full])for(const route of ['check','dismiss'])assert.equal((await h.post(`/api/updates/${route}`,{},key.headers)).status,403,`${key.account.name} ${route}`);
 assert.equal((await h.post('/api/updates/check',{},{...h.admin,Origin:'https://evil.example'})).status,403);
 assert.equal((await h.post('/api/updates/check',{},{})).status,401);assert.equal(g.calls.length,0);
 assert.equal((await h.post('/api/updates/check',{force:true},h.admin)).status,400);
 // the administrator checks
 const checked=await (await h.post('/api/updates/check',{},h.admin)).json();
 assert.equal(checked.checked,true);assert.equal(g.calls.length,2);
 assert.deepEqual({state:checked.updates.state,code:checked.updates.code,available:checked.updates.updateAvailable,tag:checked.updates.apply.tag,command:checked.updates.apply.command,notes:checked.updates.latest.notes},{state:'ok',code:'available',available:true,tag:'v1.2.0',command:'node scripts/update.mjs apply v1.2.0',notes:'<img src=x onerror=alert(1)>'});
 assert.deepEqual(await (await h.post('/api/updates/check',{},h.admin)).json().then(r=>[r.checked,r.reason]),[false,'too-soon']);assert.equal(g.calls.length,2);
 // the card on Administration → Integrations
 const row=(await (await fetch(h.origin+'/api/admin/integrations',{headers:h.admin})).json()).integrations.find(i=>i.id===UPDATE_INTEGRATION);
 assert.deepEqual({module:row.module,core:row.core,kind:row.kind,toggle:row.toggle,test:row.test,enabled:row.enabled,state:row.status.state},{module:'updates',core:true,kind:'upstream',toggle:true,test:true,enabled:true,state:'ok'});
 assert.equal(row.status.summary,'Je dostupné vydání 1.2.0 z 2026-11-10. Běží 1.1.0.');assert.equal(row.status.lastSuccessAt,'2026-11-12T10:00:00.000Z');
 assert.deepEqual(row.status.configuredBy,[{source:'file',name:`package.json → homeHub.updates.repo = ${REPO}`}]);
 c.t+=2*MINUTE;
 const tested=await (await h.post('/api/admin/integrations/test',{id:UPDATE_INTEGRATION},h.admin)).json();
 assert.equal(tested.result.state,'ok');assert.equal(g.calls.length,4,'"Test now" is a real check');
 // dismiss
 assert.equal((await h.post('/api/updates/dismiss',{version:'9.9.9'},h.admin)).status,409);
 assert.equal((await h.post('/api/updates/dismiss',{version:7},h.admin)).status,400);assert.equal((await h.post('/api/updates/dismiss',{version:'1.2.0',x:1},h.admin)).status,400);
 const dismissed=await (await h.post('/api/updates/dismiss',{version:'1.2.0'},h.admin)).json();
 assert.equal(dismissed.updates.dismissed,true);assert.equal(JSON.parse(await readFile(path.join(h.dir,'updates.json'),'utf8')).dismissed.by,'admin');
 // MCP: read-only, the same state, without the release text
 const rpc=(key,method,params)=>fetch(h.origin+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',...key.headers},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})}).then(r=>r.json());
 const tools=(await rpc(full,'tools/list')).result.tools.map(x=>x.name);
 assert.ok(tools.includes('hub_version'));assert.ok(!tools.some(n=>/update.*(check|apply|dismiss|install)|upgrade/.test(n)),'nothing checks, dismisses or applies over MCP');
 const told=(await rpc(reader,'tools/call',{name:'hub_version',arguments:{}})).result.structuredContent;
 assert.deepEqual(told.updates.latest,{version:'1.2.0',url:`https://github.com/${REPO}/releases/tag/v1.2.0`,publishedAt:'2026-11-10T09:00:00Z'});
 assert.ok(!JSON.stringify(told).includes('onerror'));assert.equal(told.updates.updateAvailable,true);assert.equal(told.updates.automatic,false);
 // the poller: starting it arms a timer and asks nobody; stopping clears it
 await h.handler.start();assert.equal(c.timers.length,1);assert.equal(g.calls.length,4);
 // off: nothing is asked, nothing is shown, and the routes say so
 const off=await h.post('/api/admin/integrations/toggle',{id:UPDATE_INTEGRATION,enabled:false},h.admin);assert.equal(off.status,200);
 await c.advance(48*HOUR);assert.equal(g.calls.length,4);
 const disabled=await (await get(reader.headers)).json();
 assert.deepEqual({state:disabled.state,code:disabled.code,latest:disabled.latest,available:disabled.updateAvailable,by:disabled.disabled.by,id:disabled.disabled.id},{state:'disabled',code:'disabled',latest:null,available:false,by:'admin',id:UPDATE_INTEGRATION});
 const refused=await h.post('/api/updates/check',{},h.admin);assert.equal(refused.status,409);assert.equal((await refused.json()).error.code,'INTEGRATION_DISABLED');
 assert.equal((await h.post('/api/admin/integrations/test',{id:UPDATE_INTEGRATION},h.admin)).status,409);assert.equal(g.calls.length,4);
 const mcp=(await rpc(reader,'tools/call',{name:'integrations_status',arguments:{}})).result.structuredContent.integrations.find(i=>i.id===UPDATE_INTEGRATION);
 assert.deepEqual({kind:mcp.kind,state:mcp.state},{kind:'upstream',state:'disabled'});
 assert.equal((await rpc(reader,'tools/call',{name:'hub_version',arguments:{}})).result.structuredContent.updates.latest,null);
 // on again: it looks within seconds, without a restart
 assert.equal((await h.post('/api/admin/integrations/toggle',{id:UPDATE_INTEGRATION,enabled:true},h.admin)).status,200);
 await c.advance(10000);assert.equal(g.calls.length,6);assert.equal((await (await get(reader.headers)).json()).code,'available');
 await h.handler.stop();assert.equal(c.timers.length,0);
});

test('a hub that is told nothing checks nothing by itself in a test, and the environment switch is honoured',async t=>{
 // The default handler (no injected network): creating it and reading its state makes no request.
 const real=globalThis.fetch;let outside=0;
 globalThis.fetch=(url,...rest)=>{if(!String(url).startsWith('http://127.0.0.1:'))outside++;return real(url,...rest);};
 t.after(()=>{globalThis.fetch=real;});
 const h=await hub(t,{updateCheck:{env:{HOME_HUB_UPDATE_CHECK:'off'}}});
 await h.handler.start();
 const u=await (await real(h.origin+'/api/updates',{headers:h.admin})).json();
 assert.deepEqual({state:u.state,code:u.code},{state:'off',code:'env-off'});
 const checked=await (await h.post('/api/updates/check',{},h.admin)).json();assert.deepEqual([checked.checked,checked.reason],[false,'env-off']);
 const row=(await (await real(h.origin+'/api/admin/integrations',{headers:h.admin})).json()).integrations.find(i=>i.id===UPDATE_INTEGRATION);
 assert.equal(row.status.state,'off');assert.deepEqual(row.status.configuredBy.at(-1),{source:'env',name:'HOME_HUB_UPDATE_CHECK=off'});
 await h.handler.stop();
 const plainHub=await hub(t);
 const pending=await (await real(plainHub.origin+'/api/updates',{headers:plainHub.admin})).json();
 assert.ok(['pending','no-repo'].includes(pending.code),pending.code);
 assert.equal(outside,0);
});

test('every sentence, the card and the API reference have English entries with the same placeholders',async()=>{
 const {dictionary}=await import('../public/i18n.js');
 const holes=s=>[...String(s).matchAll(/\{(\w+)\}/g)].map(m=>m[1]).sort().join(',');
 const integration=updatesModule.integrations[0];
 const texts=[...Object.values(UPDATE_TEXT),integration.title,integration.description,integration.toggleNote,'Limit GitHubu','Vrácená aktualizace','Tohle není nejnovější známé vydání.',
  ...updatesModule.apiDocs.flatMap(d=>[d.title,...d.routes.map(r=>r[3])])];
 for(const key of texts){assert.ok(Object.hasOwn(dictionary,key),key);assert.equal(holes(dictionary[key]),holes(key),key);assert.ok(!/[ěščřžýáíéůúťďň]/i.test(dictionary[key]),dictionary[key]);}
});

test('the release block: somebody else\'s text stays text, and only a release link becomes a link',async t=>{
 const {document}=installDom();
 globalThis.location={hash:'#integrations',origin:'http://127.0.0.1'};
 const events=[];globalThis.dispatchEvent=e=>{events.push(e);return true;};globalThis.CustomEvent=class{constructor(type,init){this.type=type;this.detail=init?.detail;}};
 const posts=[];
 const answer=over=>({schemaVersion:1,state:'ok',code:'available',repo:REPO,installed:{version:'1.1.0',label:'1.1.0'},updateAvailable:true,dismissed:false,apply:{automatic:false,tag:'v1.2.0',command:'node scripts/update.mjs apply v1.2.0'},
  latest:{version:'1.2.0',tag:'v1.2.0',url:`https://github.com/${REPO}/releases/tag/v1.2.0`,publishedAt:'2026-11-10T09:00:00Z',notes:'<img src=x onerror=alert(1)>\n[link](javascript:alert(1))'},...over});
 let next=answer();
 const real=globalThis.fetch;t.after(()=>{globalThis.fetch=real;});
 globalThis.fetch=async(url,init)=>{if(init?.method==='POST'){posts.push([url,JSON.parse(init.body)]);next=answer({dismissed:true});return new Response(JSON.stringify({updates:next}),{status:200});}return new Response(JSON.stringify(next),{status:200});};
 const {updateDetails,releaseLink,footerHint}=await import('../public/updates-view.js');
 const {setLang}=await import('../public/i18n.js');setLang('en');
 const all=(n,tag,out=[])=>{for(const k of n.children){if(k.tagName===tag)out.push(k);all(k,tag,out);}return out;};
 const settle=()=>new Promise(r=>setTimeout(r,5));
 const box=updateDetails();document.body.append(box);await settle();
 assert.equal(box.hidden,false);
 assert.equal(all(box,'img').length,0);assert.equal(all(box,'script').length,0);
 assert.equal(all(box,'pre')[0].textContent,'<img src=x onerror=alert(1)>\n[link](javascript:alert(1))');
 const links=all(box,'a');
 assert.deepEqual(links.map(a=>[a.getAttribute('href'),a.getAttribute('rel'),a.textContent]),[[`https://github.com/${REPO}/releases/tag/v1.2.0`,'noopener noreferrer','Open on GitHub']]);
 assert.ok(!/null|undefined/.test(box.textContent),box.textContent);
 assert.match(box.textContent,/Release 1\.2\.0/);assert.match(box.textContent,/does not update itself\. On the server, run the command below in its checkout: it checks release v1\.2\.0/);
 assert.deepEqual(all(box,'code').map(c=>c.textContent),['node scripts/update.mjs apply v1.2.0'],'the card names the command');
 assert.equal(events.at(-1).type,'updateschange');assert.deepEqual(footerHint(events.at(-1).detail),{latest:'1.2.0'});
 // dismissing asks the server and the footer hears about it
 const button=all(box,'button')[0];assert.equal(button.textContent,'Do not show in the footer');
 fire(button,'click');await settle();
 assert.deepEqual(posts,[['/api/updates/dismiss',{version:'1.2.0'}]]);assert.equal(all(box,'button').length,0);assert.equal(footerHint(events.at(-1).detail),null);
 // a link that is not a release page of that repository is not made into a link
 for(const url of ['https://evil.example/releases/',`https://github.com/mallory/x/releases/tag/v1`,'javascript:alert(1)',`https://github.com/${REPO}/issues`,null])assert.equal(releaseLink(answer({latest:{version:'1.2.0',url}})),null,String(url));
 assert.equal(releaseLink({repo:'x" onmouseover="1/y',latest:{url:'https://github.com/x" onmouseover="1/y/releases/tag/v1'}}),null);
 next=answer({latest:{version:'1.2.0',tag:'v1.2.0',url:'https://evil.example/x',publishedAt:null,notes:''}});
 const second=updateDetails();await settle();assert.equal(all(second,'a').length,0);assert.equal(all(second,'pre').length,0);assert.ok(!/null|undefined/.test(second.textContent),second.textContent);
 // nothing known: the block stays out of the way; the footer shows a release only when one is known to be newer
 next=answer({latest:null,updateAvailable:false,code:'no-release'});
 const empty=updateDetails();await settle();assert.equal(empty.hasAttribute('hidden')&&empty.hidden!==false,true);
 for(const quiet of [null,{},answer({updateAvailable:false}),answer({dismissed:true}),answer({latest:null}),{updateAvailable:'yes',latest:{version:'2.0.0'}}])assert.equal(footerHint(quiet),null);
 assert.deepEqual(footerHint(answer({state:'stale',code:'failed'})),{latest:'1.2.0'},'a release known to be newer stays known while a check fails');
});
