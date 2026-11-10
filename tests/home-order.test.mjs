// Overview tile order per signed-in account: GET/POST /api/profile/home-order.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {hub,credentials,SITE} from './hub-helper.mjs';
import {createHandler} from '../server/index.mjs';
import {createAccessStore} from '../server/access-store.mjs';
import {homeOrder as order,validHomeOrder as validOrder} from '../server/home-data.mjs';
// The known machines are the fixture site's; the helpers take them as their second argument.
const HOME_MACHINE_IDS=SITE.machines.map(m=>m.id);
const homeOrder=(saved,ids=HOME_MACHINE_IDS)=>order(saved,ids),validHomeOrder=(input,ids=HOME_MACHINE_IDS)=>validOrder(input,ids);

const DEFAULT=['mini','studio','mini_server','nas','router'];
const ROUTE='/api/profile/home-order';
async function viewer(h,username='reader'){
 const r=await h.post('/api/admin/users',{username,name:'Reader',password:'viewer-password-123'},h.admin);assert.equal(r.status,201);
 const login=await h.post('/api/session',{username,password:'viewer-password-123'});assert.equal(login.status,200);
 return {id:(await r.json()).user.id,headers:{Cookie:login.headers.get('set-cookie').split(';')[0]}};
}
const get=(h,headers)=>fetch(h.origin+ROUTE,{headers});

test('order helpers: strict input, tolerant read-back',()=>{
 assert.deepEqual(HOME_MACHINE_IDS,DEFAULT);
 assert.deepEqual(homeOrder(null),DEFAULT,'nothing saved = default');
 assert.deepEqual(homeOrder(['studio']),['studio','mini','mini_server','nas','router'],'missing ids follow in default order');
 assert.deepEqual(homeOrder(['gone','studio','studio','router']),['studio','router','mini','mini_server','nas'],'unknown and repeated stored ids are dropped');
 assert.deepEqual(validHomeOrder([]),[]);
 assert.deepEqual(validHomeOrder(['router','mini']),['router','mini']);
 for(const bad of [null,'studio',{},['studio','studio'],['studio','bogus'],[1],[...DEFAULT,'mini'],['__proto__']])assert.throws(()=>validHomeOrder(bad),/invalid/,JSON.stringify(bad));
});

test('saves and validates the order of the signed-in account',async t=>{
 const h=await hub(t);
 const first=await (await get(h,h.admin)).json();
 assert.deepEqual(first,{order:DEFAULT,saved:false,known:DEFAULT});
 const ok=await h.post(ROUTE,{order:['studio','nas']},h.admin);
 assert.equal(ok.status,200);assert.deepEqual(await ok.json(),{order:['studio','nas','mini','mini_server','router'],saved:true});
 assert.deepEqual((await (await get(h,h.admin)).json()).order,['studio','nas','mini','mini_server','router']);
 for(const body of [{order:['studio','bogus']},{order:['nas','nas']},{order:'studio'},{order:[...DEFAULT,'mini']},{order:['studio'],extra:1},[],{}]){
  const r=await h.post(ROUTE,body,h.admin);assert.equal(r.status,400,JSON.stringify(body));assert.equal((await r.json()).error.code,'INVALID_ORDER');}
 assert.deepEqual((await (await get(h,h.admin)).json()).order[0],'studio','a refused write changes nothing');
 const reset=await (await h.post(ROUTE,{order:[]},h.admin)).json();
 assert.deepEqual(reset,{order:DEFAULT,saved:false},'[] goes back to the default order');
 const stored=JSON.parse(await readFile(path.join(h.dir,'access.json'),'utf8'));
 assert.equal(stored.prefs.owner,undefined,'a reset leaves no empty preference behind');
});

test('each account has its own order; read-only viewers may set theirs; deleting a user drops it',async t=>{
 const h=await hub(t),v=await viewer(h);
 assert.equal((await h.post(ROUTE,{order:['router']},v.headers)).status,200,'viewer (read-only) saves own order');
 assert.equal((await h.post(ROUTE,{order:['studio']},h.admin)).status,200);
 assert.equal((await (await get(h,v.headers)).json()).order[0],'router');
 assert.equal((await (await get(h,h.admin)).json()).order[0],'studio');
 const stored=JSON.parse(await readFile(path.join(h.dir,'access.json'),'utf8'));
 assert.deepEqual(stored.prefs,{owner:{homeOrder:['studio']},[v.id]:{homeOrder:['router']}},'keyed by account id, nothing else stored');
 assert.equal((await h.post('/api/admin/users/action',{id:v.id,remove:true},h.admin)).status,200);
 const after=JSON.parse(await readFile(path.join(h.dir,'access.json'),'utf8'));
 assert.equal(after.prefs[v.id],undefined,'removed with the user');
 assert.deepEqual(after.prefs.owner,{homeOrder:['studio']});
});

test('the saved order survives a restart',async t=>{
 const h=await hub(t);
 assert.equal((await h.post(ROUTE,{order:['nas','studio']},h.admin)).status,200);
 const server=http.createServer(createHandler({directory:h.dir,stateDirectory:h.dir,credentials,origin:h.origin,secure:false}));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
 const base=`http://127.0.0.1:${server.address().port}`;
 const login=await fetch(base+'/api/session',{method:'POST',headers:{Origin:h.origin,'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'administrator-test-password'})});
 const cookie=login.headers.get('set-cookie').split(';')[0];
 assert.deepEqual((await (await fetch(base+ROUTE,{headers:{Cookie:cookie}})).json()).order,['nas','studio','mini','mini_server','router']);
});

test('password sign-in only: API keys and device tokens are refused, anonymous gets 401',async t=>{
 const h=await hub(t);
 const key=await h.account('agent.reader',['read','home:settings','inventory:write']);
 for(const r of [await get(h,key.headers),await h.post(ROUTE,{order:['nas']},key.headers)]){assert.equal(r.status,403);assert.equal((await r.json()).error.code,'SESSION_REQUIRED');}
 const minted=await (await h.post('/api/devices/tokens',{name:'Test iPhone'},h.admin)).json();
 const device={Authorization:`Bearer ${minted.token}`};
 for(const r of [await get(h,device),await h.post(ROUTE,{order:['nas']},device)]){assert.equal(r.status,403);assert.equal((await r.json()).error.code,'SESSION_REQUIRED');}
 assert.equal((await get(h,{})).status,401);
 assert.equal((await h.post(ROUTE,{order:['nas']})).status,401);
 assert.equal((await (await get(h,h.admin)).json()).saved,false,'nothing was written');
});

test('same-origin JSON only, like every other session write',async t=>{
 const h=await hub(t);
 const send=headers=>fetch(h.origin+ROUTE,{method:'POST',headers:{'Content-Type':'application/json',...h.admin,...headers},body:JSON.stringify({order:['nas']})});
 assert.equal((await send({Origin:'https://evil.example'})).status,403,'foreign origin');
 assert.equal((await fetch(h.origin+ROUTE,{method:'POST',headers:{'Content-Type':'application/json',...h.admin},body:'{"order":["nas"]}'})).status,403,'no Origin header');
 assert.equal((await send({Origin:h.origin,'Content-Type':'text/plain'})).status,403,'not JSON');
 assert.equal((await (await get(h,h.admin)).json()).saved,false);
 assert.equal((await send({Origin:h.origin})).status,200);
});

test('access.json written before prefs existed still loads; a malformed prefs field is refused',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'hub-prefs-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 await writeFile(path.join(dir,'access.json'),JSON.stringify({schemaVersion:1,users:[],keys:[],accounts:[]}));
 const store=createAccessStore(dir,credentials);
 assert.equal(store.homeOrder('owner'),null);
 assert.deepEqual(await store.setHomeOrder('owner',['router']),['router']);
 assert.deepEqual(store.homeOrder('owner'),['router']);
 await assert.rejects(store.setHomeOrder('nobody',['router']),/not-found/,'only existing accounts');
 await writeFile(path.join(dir,'access.json'),JSON.stringify({schemaVersion:1,users:[],keys:[],prefs:[]}));
 assert.throws(()=>createAccessStore(dir,credentials),/Invalid access store/);
});
