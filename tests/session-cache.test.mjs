import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {sessionCache,setPrincipal,onSessionReset,pageAllowed,pageOf,PAGES,ADMIN_PAGES} from '../public/session-cache.js';

const admin={authKind:'session',role:'admin',username:'admin'},viewer={authKind:'session',role:'viewer',username:'reader'};

test('admin systems data cached in the browser is gone after logout and sign-in as a viewer',()=>{
 const cache=sessionCache(30000);let reset=0;onSessionReset(()=>reset++);
 setPrincipal(admin);
 cache.begin()('',{hardening:'admin-only'});
 assert.deepEqual(cache.get(),{hardening:'admin-only'},'admin sees their own cached copy');
 setPrincipal(null);   // logout / authlost
 assert.equal(cache.get(),undefined,'nothing is served while signed out');
 setPrincipal(viewer);
 assert.equal(cache.get(),undefined,'viewer within the 30 s window gets no admin data');
 assert.ok(reset>=2,'view reset hooks run on every principal change');
});
test('a fetch that started under the admin and finishes after the switch is not cached for the viewer',()=>{
 const cache=sessionCache(30000);
 setPrincipal(admin);const store=cache.begin();
 setPrincipal(null);setPrincipal(viewer);
 store('',{hardening:'admin-only'});
 assert.equal(cache.get(),undefined);
 // Even an entry bound to another principal is never returned (defence in depth).
 setPrincipal(admin);cache.begin()('',{x:1});setPrincipal(viewer);assert.equal(cache.get(),undefined);
});
test('cache entries expire and are bound to the same principal re-signing in only within the TTL',()=>{
 const cache=sessionCache(1000);setPrincipal(admin);cache.begin()('k',1,0);
 assert.equal(cache.get('k',500),1);assert.equal(cache.get('k',1500),undefined);
});
test('router guards admin-only pages, not just the sidebar links',async()=>{
 for(const page of ['versions','hardening','security']){assert.ok(ADMIN_PAGES.includes(page));assert.equal(pageAllowed(page,viewer),false,page);assert.equal(pageAllowed(page,admin),true);}
 for(const page of ['access','settings',null])assert.equal(pageAllowed(page,viewer),true);
 assert.equal(pageAllowed('hardening',null),false);
 const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
 assert.match(app,/pageAllowed\(page,me\)/,'render() checks the page against the principal');
 assert.match(app,/function login\(message=''\)\{\n me=null;setPrincipal\(null\);/,'logout/authlost drops caches');
 assert.match(app,/me=await r\.json\(\);setPrincipal\(me\);/,'sign-in binds caches to the new principal');
 const systems=await readFile(new URL('../public/systems-view.js',import.meta.url),'utf8');
 assert.match(systems,/sessionCache\(30000\)/);assert.doesNotMatch(systems,/let cache=null/);
});

test('router: Inventář pages — the map for every account, versions for admins only, machines only via tiles',async()=>{
 assert.equal(pageOf('#inventory-map'),'inventory-map');assert.equal(pageOf('#versions/studio'),'versions');
 for(const h of ['#overview','#host-studio','#nope','',null,'#__proto__'])assert.equal(pageOf(h),null,String(h));
 assert.ok(PAGES.includes('inventory-map')&&!ADMIN_PAGES.includes('inventory-map'));
 assert.equal(pageAllowed('inventory-map',viewer),true,'v1 showed the inventory to every signed-in account');
 assert.equal(pageAllowed('inventory-map',admin),true);
 assert.equal(pageAllowed(pageOf('#versions/mini'),viewer),false,'deep links into versions are guarded too');
 const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
 assert.match(app,/page=pageOf\(location\.hash\)/,'render() resolves the page through the shared table');
 assert.match(app,/if\(page&&!pageAllowed\(page,me\)\)/,'and refuses pages the principal may not open');
 assert.match(app,/manifest\.pages\.find\(p=>p\.hash===\(page\|\|HOME_PAGE\)\)/,'the page module comes from the server manifest');
 const security=await readFile(new URL('../server/core/security.mjs',import.meta.url),'utf8');
 assert.match(security,/hash:'versions',[^}]*admin:true/,'versions link only for admins');
 assert.doesNotMatch(app,/#host-\$\{id\}|'Stroje'/,'no machine list in the sidebar');
 assert.match(app,/setIdentity\(null\)/,'edit rights are dropped on logout');
 const inv=await readFile(new URL('../public/inventory-view.js',import.meta.url),'utf8');
 assert.match(inv,/if\(pageAllowed\('versions',me\)\)loadSystems\(\)/,'only accounts that may read versions fetch /api/systems');
 assert.match(inv,/onSessionReset\(\(\)=>\{cache=null;[^}]*systems=null/,'inventory and versions are dropped on account change');
 const home=await readFile(new URL('../public/home-view.js',import.meta.url),'utf8');
 assert.match(home,/const orderCache=sessionCache\(/,'tile order is bound to the principal');
});
