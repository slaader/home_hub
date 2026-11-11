// Switching the Git LFS integration off mid-scan: the storage check stops before its next request.
import test from 'node:test';
import assert from 'node:assert/strict';
import {checkObjects} from '../server/git-lfs-providers.mjs';

const objects=Array.from({length:250},(_,i)=>({oid:i.toString(16).padStart(64,'0'),size:1}));
const answer=body=>new Response(JSON.stringify({objects:JSON.parse(body).objects.map(o=>({oid:o.oid,actions:{download:{}}}))}),{status:200});

test('no request leaves the hub once the integration is off, even inside one repository\'s storage check',async()=>{
 let calls=0,on=true;
 const ctx={api:'https://git.example.lan/api/v1',web:'https://git.example.lan',stopped:()=>!on,gitAuthHeader:'Basic x',
  fetch:async(url,init)=>{calls++;on=false;return answer(init.body);}};
 await assert.rejects(checkObjects(ctx,{owner:'alice',name:'media'},objects,{chunk:100}),e=>e.code==='disabled');
 assert.equal(calls,1,'the first batch went out; the rest were never sent');
});

test('off before the scan reaches the host: nothing is sent at all',async()=>{
 let calls=0;
 const ctx={api:'https://git.example.lan/api/v1',web:'https://git.example.lan',stopped:()=>true,gitAuthHeader:'Basic x',fetch:async()=>{calls++;}};
 await assert.rejects(checkObjects(ctx,{owner:'alice',name:'media'},objects),e=>e.code==='disabled');
 assert.equal(calls,0);
});
