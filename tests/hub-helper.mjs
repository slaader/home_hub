// Shared by service-accounts and MCP tests: a hub on a temp dir with a local inventory.
import http from 'node:http';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {hashPassword} from '../server/auth.mjs';
import {createHandler} from '../server/index.mjs';
import {loadSite} from '../server/site-config.mjs';
import {fileURLToPath} from 'node:url';
// The generic site the core tests run on (scripts/run-tests.mjs points HOME_HUB_SITE_CONFIG at the same file).
export const SITE=loadSite({file:fileURLToPath(new URL('./fixtures/site.json',import.meta.url))});
export const credentials={username:'admin',...hashPassword('administrator-test-password')};
export const knowledge=()=>({schema:1,updated_at:'2026-11-08',entries:[
 {id:'studio',kind:'machine',name:'Mac Studio',verified_at:'2026-11-08'},
 {id:'studio-llama-swap',kind:'runtime',machine:'studio',name:'llama-swap',address:'127.0.0.1:8081',verified_at:'2026-11-08'}]});

// Starts a hub on a temp dir with a local inventory; returns helpers. The env flag is read at creation.
// extra: more createHandler options (fakes for Thermo checks and the like).
export async function hub(t,{bridgeRequest=async()=>{throw new Error('offline');},...extra}={}){
 const dir=await mkdtemp(path.join(os.tmpdir(),'hub-sa-'));let server=null;
 // One teardown, server first: a failed rm must never skip the close (a listening server keeps the run alive),
 // and fire-and-forget audit appends may still land while the directory is removed, so rm retries ENOTEMPTY.
 t.after(async()=>{try{if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}}
  finally{await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:25});}});
 await writeFile(path.join(dir,'knowledge.json'),JSON.stringify(knowledge()));
 server=http.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
 const before=process.env.INVENTORY_LOCAL;process.env.INVENTORY_LOCAL='1';
 const handler=createHandler({directory:dir,stateDirectory:dir,credentials,origin,secure:false,bridgeRequest,...extra});server.on('request',handler);
 if(before===undefined)delete process.env.INVENTORY_LOCAL;else process.env.INVENTORY_LOCAL=before;
 const post=(url,body,headers={})=>fetch(origin+url,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
 const login=await post('/api/session',{username:'admin',password:'administrator-test-password'});
 const admin={Cookie:login.headers.get('set-cookie').split(';')[0]};
 const account=async(name,scopes)=>{const a=await (await post('/api/admin/accounts',{name,scopes},admin)).json();const k=await (await post('/api/admin/accounts/keys',{accountId:a.account.id},admin)).json();return {account:a.account,token:k.token,headers:{Authorization:'Bearer '+k.token}};};
 return {dir,origin,post,admin,account,handler};
}

