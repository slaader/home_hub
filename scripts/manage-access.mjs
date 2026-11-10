// Local service-owner administration: keys and viewers without the web UI. Stop Home Hub first to avoid
// competing file writers. --root DIR is the checkout that holds private/ and state/ (default: this one);
// --label NAME (or HOME_HUB_LAUNCHD_LABEL) names the launchd job to check, when the hub runs as one.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createAccessStore} from '../server/access-store.mjs';
const args=process.argv.slice(2),command=args.shift();
function option(name){const i=args.indexOf('--'+name);return i<0?undefined:args[i+1];}
const root=option('root')||path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),output=option('output');
const label=option('label')||process.env.HOME_HUB_LAUNCHD_LABEL;
if(label&&os.platform()==='darwin'&&spawnSync('/bin/launchctl',['print',`gui/${process.getuid()}/${label}`],{stdio:'ignore'}).status===0)throw new Error('Stop Home Hub before local access administration. Use Admin profile while the service runs.');
const credentials=JSON.parse(fs.readFileSync(path.join(root,'private/auth.json'),'utf8')),store=createAccessStore(path.join(root,'state'),credentials);
if(['create-key','create-viewer'].includes(command)&&(!output||!path.isAbsolute(output)||fs.existsSync(output)))throw new Error('Provide an unused private absolute --output path before creating credentials.');
let result;
if(command==='create-key')result=await store.issueKey({name:option('name'),permission:option('permission')});
else if(command==='revoke-key')result=await store.revokeKey({id:option('id')});
else if(command==='create-viewer')result=await store.createUser({username:option('username'),name:option('name')||option('username')});
else if(command==='delete-viewer')result=await store.updateUser({id:option('id'),remove:true});
else throw new Error('Expected create-key, revoke-key, create-viewer or delete-viewer.');
if(result.token||result.initialPassword){if(!output||!path.isAbsolute(output))throw new Error('A private absolute --output path is required.');fs.mkdirSync(path.dirname(output),{recursive:true,mode:0o700});fs.writeFileSync(output,JSON.stringify(result)+'\n',{mode:0o600,flag:'wx'});}
console.log(JSON.stringify({ok:true,id:result.id||result.key?.id||result.user?.id}));
