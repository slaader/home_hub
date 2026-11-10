// A 401 ends the sign-in that sent the request, never the account signed in when the reply lands.
// Reproduces the review finding: Alice's tile-order POST is deferred, Bob signs in, then Alice's request
// returns 401. Before the fix home-view raised 'authlost' first, and app.js signed Bob out.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';

// The browser globals the views use at import time and on completion; fetch is answered by hand.
const bus=new EventTarget();
globalThis.addEventListener=bus.addEventListener.bind(bus);
globalThis.dispatchEvent=bus.dispatchEvent.bind(bus);
const requests=[];
globalThis.fetch=(url,opts)=>new Promise(resolve=>requests.push({url,opts,answer:(status,body={})=>resolve({ok:status>=200&&status<300,status,json:async()=>body})}));

const {sessionCache,setPrincipal,currentPrincipal,principalKey,authGuard}=await import('../public/session-cache.js');
const {createOrderSaver}=await import('../public/home-order.js');
const {sendOrder}=await import('../public/home-view.js');
const {load:loadSystems}=await import('../public/systems-view.js');

const alice={authKind:'session',role:'admin',username:'alice'},bob={authKind:'session',role:'viewer',username:'bob'};
const START={order:['mini','studio','mini_server','nas','router'],available:true};
const A=['studio','mini','mini_server','nas','router'];
// app.js: on 'authlost' while signed in, go back to the sign-in screen (login() → setPrincipal(null)).
let signedOut=0;
bus.addEventListener('authlost',()=>{if(currentPrincipal()!==null){signedOut++;setPrincipal(null);}});
const reset=()=>{signedOut=0;requests.length=0;};

test('a deferred 401 on Alice\'s tile-order save after switching to Bob does not sign Bob out',async()=>{
 reset();setPrincipal(alice);
 const cache=sessionCache(43200000);cache.begin()('',START);
 const saver=createOrderSaver({cache,send:sendOrder});// as home-view wires it
 const saving=saver.save(A);
 assert.equal(requests.length,1,'Alice\'s POST is in flight');
 assert.equal(requests[0].url,'/api/profile/home-order');
 setPrincipal(null);setPrincipal(bob);// Alice signs out, Bob signs in
 const bobs={order:['router','mini','studio','mini_server','nas'],available:true};
 cache.begin()('',bobs);
 requests[0].answer(401,{error:{code:'AUTH_REQUIRED'}});
 assert.equal(await saving,'stale');
 assert.equal(signedOut,0,'no authlost for Bob');
 assert.equal(currentPrincipal(),principalKey(bob),'Bob is still signed in');
 assert.deepEqual(cache.get(),bobs,'and his cached order is untouched');
});

test('a 401 on the same sign-in still signs out, so an expired session is noticed',async()=>{
 reset();setPrincipal(alice);
 const cache=sessionCache(43200000);cache.begin()('',START);
 const saving=createOrderSaver({cache,send:sendOrder}).save(A);
 requests[0].answer(401);
 assert.equal(await saving,'stale','the sign-out itself makes the outcome stale');
 assert.equal(signedOut,1);assert.equal(currentPrincipal(),null);
});

test('systems load: a late 401 from the previous account does not sign out the next one',async()=>{
 reset();setPrincipal(alice);
 const loading=loadSystems(true);
 setPrincipal(null);setPrincipal(bob);
 requests[0].answer(401);
 await assert.rejects(loading,e=>e.status===401);
 assert.equal(signedOut,0);assert.equal(currentPrincipal(),principalKey(bob));
});

test('authGuard: fires only for a 401, only while the sign-in that took it is current',()=>{
 reset();setPrincipal(alice);
 const before=authGuard();
 before({status:403});before({status:500});assert.equal(signedOut,0,'only 401 means signed out');
 setPrincipal(bob);
 before({status:401});before.signedOut();
 assert.equal(signedOut,0,'Alice\'s guard is dead once Bob signed in (also for the delayed signedOut)');
 const now=authGuard();now({status:401});
 assert.equal(signedOut,1,'Bob\'s own 401 signs Bob out');
 const nobody=authGuard();nobody({status:401});
 assert.equal(signedOut,1,'nobody signed in: nothing to end');
});

test('every view raises authlost only through authGuard',async()=>{
 const dir=new URL('../public/',import.meta.url);
 for(const f of (await readdir(dir)).filter(f=>f.endsWith('.js'))){
  const src=await readFile(new URL(f,dir),'utf8');
  if(f==='session-cache.js'){assert.match(src,/if\(live\(\)\)dispatchEvent\(new Event\('authlost'\)\)/);continue;}
  assert.doesNotMatch(src,/new Event\('authlost'\)/,`${f} dispatches authlost directly`);
  assert.doesNotMatch(src,/const authLost=r=>/,`${f} keeps an unguarded authLost helper`);
 }
});
