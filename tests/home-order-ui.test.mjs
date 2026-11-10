// Browser side of the Přehled tile order: saves are serialized, newest wins, bound to the sign-in.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {sessionCache,setPrincipal} from '../public/session-cache.js';
import {createOrderSaver} from '../public/home-order.js';

const alice={authKind:'session',role:'admin',username:'alice'},bob={authKind:'session',role:'viewer',username:'bob'};
const START={order:['mini','studio','mini_server','nas','router'],available:true};
const A=['studio','mini','mini_server','nas','router'],B=['nas','studio','mini','mini_server','router'],C=['router','nas','studio','mini','mini_server'];
// A send() whose requests the test answers by hand, in any order.
function server(){
 const calls=[];
 const send=order=>new Promise((resolve,reject)=>calls.push({order,ok:()=>resolve({order,available:true}),fail:()=>reject(new Error('order'))}));
 return {calls,send};
}
const tick=()=>new Promise(r=>setImmediate(r));
function setup(){
 setPrincipal(alice);
 const cache=sessionCache(43200000);cache.begin()('',START);
 const s=server();return {cache,...s,saver:createOrderSaver({cache,send:s.send})};
}

test('a failed save after an account switch does not touch the next account\'s cached order',async()=>{
 const {cache,calls,saver}=setup();
 const saving=saver.save(A);
 assert.deepEqual(cache.get().order,A,'the move shows at once');
 setPrincipal(null);setPrincipal(bob);// Alice signs out, Bob signs in before her request fails
 const bobs={order:['router','mini','studio','mini_server','nas'],available:true};
 cache.begin()('',bobs);
 calls[0].fail();
 assert.equal(await saving,'stale','the caller is told not to touch the screen');
 assert.deepEqual(cache.get(),bobs,'Bob keeps his own order, Alice\'s rollback is dropped');
 setPrincipal(alice);
 assert.equal(cache.get(),undefined,'and nothing of Alice\'s is left behind for her either');
});

test('a success after an account switch is dropped, and a waiting move is never sent with the new sign-in',async()=>{
 const {cache,calls,saver}=setup();
 const first=saver.save(A),second=saver.save(B);
 assert.equal(calls.length,1,'B waits for A');
 setPrincipal(null);setPrincipal(bob);
 calls[0].ok();
 assert.equal(await first,'stale');assert.equal(await second,'stale');
 assert.equal(calls.length,1,'Alice\'s waiting order is not POSTed under Bob\'s cookie');
 assert.equal(cache.get(),undefined,'nothing cached for Bob');
 // Bob's own move works normally while Alice's pump is gone.
 cache.begin()('',START);
 const bobSave=saver.save(C);assert.equal(calls.length,2);calls[1].ok();
 assert.equal(await bobSave,'saved');assert.deepEqual(cache.get().order,C);
});

test('saves never overlap: an earlier move failing after a newer one was made does not undo the newer one',async()=>{
 const {cache,calls,saver}=setup();
 const a=saver.save(A),b=saver.save(B);
 assert.equal(calls.length,1,'only one request in flight');
 assert.deepEqual(cache.get().order,B,'the newest move is shown');
 calls[0].fail();// A fails while B is waiting
 assert.equal(await a,'superseded');
 assert.deepEqual(cache.get().order,B,'A\'s failure does not restore the old order over B');
 await tick();assert.equal(calls.length,2);assert.deepEqual(calls[1].order,B,'B is sent after A finished');
 calls[1].ok();
 assert.equal(await b,'saved');assert.deepEqual(cache.get().order,B);
});

test('reversed completion cannot happen; a newer failure rolls back to the last confirmed order, not the oldest',async()=>{
 const {cache,calls,saver}=setup();
 const a=saver.save(A),b=saver.save(B);
 calls[0].ok();assert.equal(await a,'superseded');
 assert.deepEqual(cache.get().order,B,'A\'s success does not overwrite the newer B on screen');
 await tick();calls[1].fail();
 assert.equal(await b,'failed');
 assert.deepEqual(cache.get().order,A,'back to A, which the server confirmed, not to the start');
});

test('both fail: back to the order from before the first move; moves made while saving coalesce to the newest',async()=>{
 const {cache,calls,saver}=setup();
 const a=saver.save(A),b=saver.save(B),c=saver.save(C);
 assert.equal(await b,'superseded','B is replaced by C before it is sent');
 calls[0].fail();assert.equal(await a,'superseded');
 await tick();assert.equal(calls.length,2);assert.deepEqual(calls[1].order,C,'only the newest waiting order is sent');
 calls[1].fail();assert.equal(await c,'failed');
 assert.deepEqual(cache.get(),START);
 assert.equal(calls.length,2);
 // After the queue drained, the next move starts from what is cached now.
 const d=saver.save([]);assert.deepEqual(cache.get().order,null,'reset to default shows at once');
 calls[2].ok();assert.equal(await d,'saved');assert.deepEqual(cache.get().order,[]);
});

test('home-view saves through the serialized saver and leaves the screen alone on stale or superseded results',async()=>{
 const home=await readFile(new URL('../public/home-view.js',import.meta.url),'utf8');
 assert.match(home,/createOrderSaver\(\{cache:orderCache,send:sendOrder\}\)/);
 assert.match(home,/if\(outcome==='stale'\|\|outcome==='superseded'\)return;/);
 assert.doesNotMatch(home,/orderCache\.begin\(\)\('',before\)/,'no rollback through a fresh begin() under whoever is signed in now');
});

test('every module the browser imports is served, including home-order.js',async t=>{
 const {readdir}=await import('node:fs/promises');const {hub}=await import('./hub-helper.mjs');
 const dir=new URL('../public/',import.meta.url),names=new Set();
 for(const f of (await readdir(dir)).filter(f=>f.endsWith('.js')))
  for(const m of (await readFile(new URL(f,dir),'utf8')).matchAll(/(?:from|import\()\s*'\.\/([^']+)'/g))names.add(m[1]);
 assert.ok(names.has('home-order.js'));
 const h=await hub(t);
 for(const name of names){const r=await fetch(`${h.origin}/${name}`);assert.equal(r.status,200,name);assert.match(r.headers.get('content-type'),/javascript/,name);}
});
