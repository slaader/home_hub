// Client-side caches of per-account data. Every entry is bound to the principal that fetched it,
// and all of them are dropped whenever the signed-in account changes (logout, expired session,
// a new sign-in), so a viewer never sees what an admin's session loaded a moment earlier.
// The router also refuses admin-only pages for other roles instead of only hiding their links.
const caches=new Set(),resets=new Set();
let principal=null,generation=0;

export const principalKey=me=>me&&typeof me==='object'?JSON.stringify([me.authKind||'',me.role||'',me.username||'']):null;
export const currentPrincipal=()=>principal;
export function clearSessionCaches(){generation++;for(const c of caches)c.clear();for(const fn of resets)try{fn();}catch{}}
// Call with the /api/me document after sign-in, and with null on logout or authlost.
export function setPrincipal(me){const key=principalKey(me);if(key!==principal||key===null){principal=key;clearSessionCaches();}}
// Views holding their own module state register a reset hook instead of a sessionCache.
export function onSessionReset(fn){resets.add(fn);return ()=>resets.delete(fn);}
// Capture the signed-in session now; the returned check stays true only while that same sign-in lasts
// (no sign-out, account switch or new sign-in since). Async UI work uses it to drop late completions.
export function sessionTicket(){const who=principal,gen=generation;return ()=>who!==null&&who===principal&&gen===generation;}
// A 401 says that the sign-in which sent the request has ended, not whichever account is signed in when
// the reply lands. Take the guard before fetching and hand it the response:
//   const lost=authGuard();const r=await fetch(url);if(!r.ok)lost(r);
// It raises 'authlost' (app.js → back to sign-in) only while that same sign-in is still the current one,
// so a late 401 from a previous account never signs out the next. signedOut() is the same check without
// a response, for "this sign-in has just ended" (e.g. after a password change).
export function authGuard(live=sessionTicket()){
 const signedOut=()=>{if(live())dispatchEvent(new Event('authlost'));};
 const lost=r=>{if(r?.status===401)signedOut();return r;};
 lost.signedOut=signedOut;return lost;
}

export function sessionCache(ttlMs){
 const map=new Map();
 const cache={
  get(key='',now=Date.now()){const e=map.get(key);return e&&principal!==null&&e.who===principal&&e.gen===generation&&now-e.at<ttlMs?e.value:undefined;},
  // Capture the principal before fetching; a reply that lands after a sign-out or account switch is dropped.
  begin(){const who=principal,gen=generation,live=sessionTicket();return (key,value,now=Date.now())=>{if(live())map.set(key,{at:now,who,gen,value});return value;};},
  clear(){map.clear();}
 };
 caches.add(cache);return cache;
}

// Pages the router knows (#<page>[/sub]); anything else is the overview or a #host-<id> machine page.
// #inventory-map is open to every signed-in account, as the v1 inventory was (GET /api/inventory is plain read).
// The list comes from the server's UI manifest (GET /api/ui/manifest → pages): app.js hands it to setPages()
// after sign-in, so plugin pages route like core ones. PAGES and ADMIN_PAGES are the core pages, in force
// until then (tests/plugins.test.mjs checks they match what the server's core modules register).
export const HOME_PAGE='overview';
export const PAGES=Object.freeze(['security','access','versions','hardening','settings','inventory-map','projects','items','releases','review','search']);
export const ADMIN_PAGES=Object.freeze(['security','versions','hardening']);
let pages=new Map(PAGES.map(hash=>[hash,{admin:ADMIN_PAGES.includes(hash)}]));
// list: [{hash, admin}] from the manifest; null goes back to the core pages.
export function setPages(list){pages=new Map((Array.isArray(list)?list:PAGES.map(hash=>({hash,admin:ADMIN_PAGES.includes(hash)}))).filter(p=>typeof p?.hash==='string'&&p.hash!==HOME_PAGE).map(p=>[p.hash,{admin:p.admin===true}]));}
export const pageOf=hash=>{const raw=String(hash||'').replace(/^#/,'').split('/')[0];return pages.has(raw)?raw:null;};
export const pageAllowed=(page,me)=>!pages.get(page)?.admin||me?.role==='admin';
