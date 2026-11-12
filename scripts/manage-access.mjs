// Local service-owner administration without the web UI: users and their roles, service accounts, keys.
// Stop Home Hub first to avoid competing file writers (a running hub does not see these changes until it
// restarts, and its next write would overwrite them).
//
//   node scripts/manage-access.mjs list
//   node scripts/manage-access.mjs create-user --username alex [--name "Alex"] [--role viewer|editor|admin|<custom id>] --output /abs/file
//   node scripts/manage-access.mjs set-role --id <user id> --role editor
//   node scripts/manage-access.mjs delete-user --id <user id>
//   node scripts/manage-access.mjs create-account --name agent-studio [--description "…"] (--preset read|full|role:<id> | --scopes a,b) --output /abs/file
//   node scripts/manage-access.mjs revoke-key --id <key id>
//   node scripts/manage-access.mjs create-key --name NAME --permission read|write --output /abs/file     (a key without a service account)
//   create-viewer / delete-viewer                                                                        (the older names of create-user / delete-user)
//
// --root DIR is the checkout that holds private/ (default: this one); --state DIR is where access.json lives
// (default: STATE_DIR, else <data>/state, else the older <root>/state when that is where the file is). With
// HOME_HUB_HOME, DATA_DIR or HOME_HUB_PRIVATE_DIR set, those decide (server/paths.mjs), as for the server.
// --label NAME (or HOME_HUB_LAUNCHD_LABEL) names the launchd job to check, when the hub runs as one.
// Secrets (a generated password, a key) go only into the --output file (0600, must not exist), never to the terminal.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createAccessStore} from '../server/access-store.mjs';
import {resolvePaths} from '../server/paths.mjs';
const args=process.argv.slice(2),command=args.shift();
function option(name){const i=args.indexOf('--'+name);return i<0?undefined:args[i+1];}
const root=option('root')||path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),output=option('output');
const label=option('label')||process.env.HOME_HUB_LAUNCHD_LABEL;
if(label&&os.platform()==='darwin'&&spawnSync('/bin/launchctl',['print',`gui/${process.getuid()}/${label}`],{stdio:'ignore'}).status===0)throw new Error('Stop Home Hub before local access administration. Use Users and API in the web UI while the service runs.');
// Where the state and the auth file are: the environment (HOME_HUB_HOME, STATE_DIR, AUTH_FILE, …), else this root's (server/paths.mjs).
const paths=resolvePaths(process.env,root);
const legacyState=path.join(root,'state'),state=option('state')||process.env.STATE_DIR||(!paths.home&&!process.env.DATA_DIR&&fs.existsSync(path.join(legacyState,'access.json'))&&!fs.existsSync(path.join(paths.state,'access.json'))?legacyState:paths.state);
const authFile=paths.authFile;
const credentials=JSON.parse(fs.readFileSync(authFile,'utf8')),store=createAccessStore(state,credentials);
const SECRET=['create-key','create-viewer','create-user','create-account'];
if(SECRET.includes(command)&&(!output||!path.isAbsolute(output)||fs.existsSync(output)))throw new Error('Provide an unused private absolute --output path before creating credentials.');
const by={by:'local administration'};
let result;
if(command==='list'){
 // Names, roles and scopes only: nothing here is a secret.
 console.log(JSON.stringify({state,users:store.users().map(u=>({id:u.id,username:u.username,role:u.roleId,disabled:u.disabled})),
  roles:store.roles().map(r=>({id:r.id,name:r.name,builtin:r.builtin,admin:r.admin,scopes:r.scopes,users:r.users})),
  accounts:store.accounts().map(a=>({id:a.id,name:a.name,scopes:a.scopes,disabled:a.disabled,keys:a.keys.filter(k=>!k.revokedAt).map(k=>({id:k.id,prefix:k.prefix,lastUsedAt:k.lastUsedAt}))})),
  legacyKeys:store.keys().filter(k=>!k.accountId&&!k.revokedAt).map(k=>({id:k.id,name:k.name,permission:k.permission}))},null,1));
 process.exit(0);
}
if(command==='create-key')result=await store.issueKey({name:option('name'),permission:option('permission')},by);
else if(command==='revoke-key')result=await store.revokeKey({id:option('id')},by);
else if(command==='create-viewer'||command==='create-user')result=await store.createUser({username:option('username'),name:option('name')||option('username'),...(command==='create-user'&&option('role')?{role:option('role')}:{})},by);
else if(command==='delete-viewer'||command==='delete-user')result=await store.updateUser({id:option('id'),remove:true},by);
else if(command==='set-role')result=await store.updateUser({id:option('id'),role:option('role')},by);
else if(command==='create-account'){
 // Plugin scopes exist only once the plugins are loaded, which the server module does on import (it does not listen).
 await import('../server/index.mjs');
 const preset=option('preset'),found=preset?store.presets().find(p=>p.id===preset):null;
 if(preset&&!found)throw new Error(`Unknown preset "${preset}". One of: ${store.presets().map(p=>p.id).join(', ')}.`);
 if(!preset&&option('scopes')===undefined)throw new Error('Say what the account may do: --preset read|full|role:<id>, or --scopes a,b.');
 const scopes=found?found.scopes:option('scopes').split(',').map(s=>s.trim()).filter(Boolean);
 const {account}=await store.createAccount({name:option('name'),...(option('description')?{description:option('description')}:{}),scopes},by);
 result={...await store.issueAccountKey({accountId:account.id},by),account};
}
else throw new Error('Expected list, create-user, set-role, delete-user, create-account, create-key or revoke-key.');
if(result.token||result.initialPassword){if(!output||!path.isAbsolute(output))throw new Error('A private absolute --output path is required.');fs.mkdirSync(path.dirname(output),{recursive:true,mode:0o700});fs.writeFileSync(output,JSON.stringify(result)+'\n',{mode:0o600,flag:'wx'});}
console.log(JSON.stringify({ok:true,id:result.account?.id||result.id||result.key?.id||result.user?.id}));
