// Who may use this hub: people (the built-in owner from the auth file, plus users in state/access.json),
// their roles, service accounts with API keys, and each account's own preferences. Passwords are stored
// as scrypt hashes and keys as SHA-256 hashes; neither a password nor a key is ever written or logged.
//
// state/access.json, schemaVersion 1 (every field after `keys` is optional on read, so a file written by
// an older version loads as it is, and a file written here still loads there):
//   users[]    {id, username, name, role, disabled, createdAt, passwordAt, salt, hash}
//              role is a role id: "viewer", "editor", "admin" or a custom role's id. Files from before
//              roles existed hold "viewer" (and, if hand-edited, "admin"), which mean the same now.
//   keys[]     {id, name, prefix, hash, createdAt, lastUsedAt, revokedAt} plus accountId (a service
//              account's key) or permission "read"|"write" (a key from before service accounts)
//   accounts[] {id, name, description, scopes[], disabled, createdAt}; scopes ["*"] = full access
//   roles[]    {id, name, description, scopes[], createdAt, updatedAt}: custom roles only
//   prefs      {<user id>: {homeOrder[], timeZone}}
import {readFileSync} from 'node:fs';
import {mkdir,writeFile,rename,appendFile,readFile} from 'node:fs/promises';
import {randomBytes,createHash,timingSafeEqual,scrypt} from 'node:crypto';
import {promisify} from 'node:util';
import path from 'node:path';
import {hashPassword} from './auth.mjs';
import {legacyScopes,validScopes,writesWith,resolveScopes,isWildcard,roleOf,legacyRole,builtinRole,accountPresets,BUILTIN_ROLES,ROLE_ID,RESERVED_ROLE_IDS} from './scopes.mjs';

const derive=promisify(scrypt),sha=s=>createHash('sha256').update(s).digest('hex');
const plain=v=>Boolean(v)&&typeof v==='object'&&!Array.isArray(v);
const only=(input,keys)=>plain(input)&&Object.keys(input).every(k=>keys.includes(k));
const clean=s=>!/[\u0000-\u001f\u007f]/.test(s);
const nameOk=s=>typeof s==='string'&&s.trim().length>0&&s.length<=80&&clean(s);
const roleNameOk=s=>typeof s==='string'&&s.trim().length>0&&s.length<=40&&clean(s);
const USERNAME=/^[a-z][a-z0-9._-]{2,39}$/;
const accountNameOk=s=>typeof s==='string'&&USERNAME.test(s);
const descriptionOk=s=>s===undefined||typeof s==='string'&&s.length<=200&&clean(s);
const fail=code=>{throw new Error(code);};
export const apiBearerOf=header=>typeof header==='string'&&/^Bearer hhk_[a-f0-9]{64}$/.test(header)?header.slice(7):null;
// The auth file (private/auth.json): {username, salt, hash} with an scrypt hash, as hashPassword() makes it.
export const validCredentials=c=>plain(c)&&typeof c.username==='string'&&c.username.length>0&&c.username.length<=80&&/^[a-f0-9]{128}$/.test(c.hash||'')&&/^[a-f0-9]{32}$/.test(c.salt||'');
// IANA zone names as Intl knows them; "browser" = whatever the browser is set to.
export function validTimeZone(zone){
 if(zone==='browser')return true;
 if(typeof zone!=='string'||zone.length>64||!/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,2}$/.test(zone))return false;
 try{new Intl.DateTimeFormat('en',{timeZone:zone});return true;}catch{return false;}
}
// "Night shift" → "night-shift"; text without Latin letters gets a generated id.
const slug=name=>{const s=name.normalize('NFD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,32).replace(/-+$/,'');return ROLE_ID.test(s)?s:`role-${randomBytes(3).toString('hex')}`;};

const keyView=k=>({id:k.id,name:k.name,permission:k.permission||null,accountId:k.accountId||null,prefix:k.prefix,createdAt:k.createdAt,lastUsedAt:k.lastUsedAt,revokedAt:k.revokedAt});
// Service accounts: named non-human identities (agents, scripts) whose keys carry the account's scopes.
// scopes is what is stored (["*"] for full access); effectiveScopes is what that means right now.
const accountView=(a,keys)=>{const own=keys.filter(k=>k.accountId===a.id).map(keyView);
 return {id:a.id,name:a.name,description:a.description||'',scopes:[...a.scopes],fullAccess:isWildcard(a.scopes),effectiveScopes:resolveScopes(a.scopes),disabled:a.disabled===true,createdAt:a.createdAt,keys:own,
  lastUsedAt:own.map(k=>k.lastUsedAt).filter(Boolean).sort().at(-1)||null};};

function load(file){
 let state={schemaVersion:1,users:[],keys:[],accounts:[],prefs:{},roles:[]};
 try{state=JSON.parse(readFileSync(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;return state;}
 const list=v=>v===undefined||Array.isArray(v);
 const roleOk=r=>plain(r)&&typeof r.id==='string'&&ROLE_ID.test(r.id)&&!RESERVED_ROLE_IDS.includes(r.id)&&typeof r.name==='string'&&Array.isArray(r.scopes)&&r.scopes.every(s=>typeof s==='string');
 if(!plain(state)||state.schemaVersion!==1||!Array.isArray(state.users)||!Array.isArray(state.keys)||!list(state.accounts)||!list(state.roles)||state.prefs!==undefined&&!plain(state.prefs)||(state.roles||[]).some(r=>!roleOk(r)))throw new Error('Invalid access store');
 state.accounts??=[];state.prefs??={};state.roles??=[];
 return state;
}

// ownerFile: the auth file holding the owner's hash (private/auth.json). It is needed to change that
// password, and it is read again while there is no owner yet, so `node scripts/setup.mjs` takes effect
// without a restart. credentials may be empty ({}): the hub then runs without an owner until set up.
export function createAccessStore(directory,credentials,{now=Date.now,ownerFile=null}={}){
 credentials??={};
 const file=path.join(directory,'access.json'),auditFile=path.join(directory,'access-audit.jsonl');
 let state=load(file);
 let queue=Promise.resolve();const stamp=()=>new Date(now()).toISOString();
 function ownerReady(){
  if(validCredentials(credentials))return true;
  if(!ownerFile)return false;
  try{const found=JSON.parse(readFileSync(ownerFile,'utf8'));if(!validCredentials(found))return false;Object.assign(credentials,found);return true;}catch{return false;}
 }
 // The owner is not stored in access.json: it is the account of the auth file, with the role "owner".
 // passwordAt is kept in that file: sessions survive restarts (state/hub.db), so the stamp that ends older ones must too.
 const owner=()=>ownerReady()?{id:'owner',username:credentials.username,name:typeof credentials.name==='string'&&credentials.name?credentials.name:credentials.username,role:'owner',disabled:false,
  createdAt:typeof credentials.createdAt==='string'?credentials.createdAt:null,passwordAt:typeof credentials.passwordAt==='string'?credentials.passwordAt:null}:null;
 // A stored user's role. Only the auth-file account is ever the owner; "owner" on a stored user names nothing.
 const roleFor=(u,roles=state.roles)=>u.id==='owner'?roleOf('owner'):roleOf(u.role==='owner'?null:u.role,roles);
 // What the rest of the server and the admin UI see of a person. role is the legacy-compatible value
 // ("admin" for the owner, as always), roleId the exact role. passwordAt: when the password was last
 // set; sessions opened before it are no longer valid (auth.mjs).
 const userView=(u,roles=state.roles)=>{const r=roleFor(u,roles);
  return {id:u.id,username:u.username,name:u.name,role:legacyRole(r),roleId:r.id,roleName:r.name,admin:r.admin,scopes:r.scopes,permission:writesWith(r.scopes)?'write':'read',
   disabled:u.disabled===true,createdAt:u.createdAt,passwordAt:u.passwordAt||u.createdAt||null,builtin:u.id==='owner',...(r.missing?{roleMissing:true}:{})};};
 const roleView=(r,d=state)=>{const own=d.roles.find(x=>x.id===r.id);
  return {id:r.id,name:r.name,description:r.description,builtin:r.builtin,admin:r.admin,assignable:r.assignable,scopes:r.scopes,
   users:[...(owner()?[owner()]:[]),...d.users].filter(u=>roleFor(u,d.roles).id===r.id).length,createdAt:own?.createdAt||null,updatedAt:own?.updatedAt||null};};
 const assignable=(id,roles)=>typeof id==='string'&&(builtinRole(id)?builtinRole(id).assignable:roles.some(r=>r.id===id));
 // What an audit line says the change touched: the id, and the name as it was (a deleted thing keeps its name there).
 const touched=r=>{const x=[r?.user,r?.key,r?.account,r?.role].find(plain)||r;return x?.id?{id:x.id,...(typeof (x.username||x.name)==='string'?{name:(x.username||x.name).slice(0,80)}:{})}:{};};
 const audit=(event,result,{by,detail}={})=>appendFile(auditFile,JSON.stringify({at:stamp(),event,...touched(result),...(by?{by:String(by).slice(0,80)}:{}),...(detail?{detail:String(detail).slice(0,120)}:{})})+'\n',{mode:0o600});
 // One change at a time: copy, change, write to a temp file, rename. meta = {by, detail} for the audit line.
 const transact=(change,event,meta)=>{const op=queue.then(async()=>{const draft=structuredClone(state),result=change(draft);
   await mkdir(directory,{recursive:true,mode:0o700});await writeFile(file+'.tmp',JSON.stringify(draft),{mode:0o600});await rename(file+'.tmp',file);state=draft;
   if(event)await audit(typeof event==='function'?event(result):event,result,typeof meta==='function'?meta(result):meta);return result;});queue=op.catch(()=>{});return op;};
 const lookup=id=>id==='owner'?owner():state.users.find(u=>u.id===id);
 let dummy=null;// what a sign-in for an unknown name is checked against while there is no owner
 const api={
  // false until the auth file holds a valid owner (first run of a fresh install).
  ownerReady,
  user:id=>{const u=lookup(id);return u&&!u.disabled?userView(u):null;},
  users:()=>[...(owner()?[owner()]:[]),...state.users].map(u=>userView(u)),
  async authenticate(username,password){
   const own=owner();
   const u=typeof username==='string'?(own&&username===own.username?own:state.users.find(x=>x.username===username)):null;
   const stored=u&&u.id!=='owner'?u:own?credentials:(dummy??=hashPassword(randomBytes(18).toString('hex')));
   const candidate=await derive(password,stored.salt,64);
   return u&&!u.disabled&&timingSafeEqual(candidate,Buffer.from(stored.hash,'hex'))?userView(u):null;
  },
  // {username, name?, password?, role?}: role defaults to viewer. Without a password one is generated and returned once.
  createUser(input,{by}={}){
   if(!only(input,['username','name','password','role'])||typeof input.username!=='string'||!USERNAME.test(input.username)||!nameOk(input.name||input.username)||input.role!==undefined&&typeof input.role!=='string')fail('invalid');
   const generated=!input.password,password=generated?randomBytes(18).toString('base64url'):input.password;
   if(typeof password!=='string'||password.length<12||password.length>256)fail('invalid');
   const role=input.role??'viewer';
   return transact(d=>{if(!assignable(role,d.roles))fail('invalid');if(d.users.length>=100)fail('limit');if(input.username===owner()?.username||d.users.some(u=>u.username===input.username))fail('conflict');
    const u={id:randomBytes(8).toString('hex'),username:input.username,name:(input.name||input.username).trim(),role,disabled:false,createdAt:stamp(),passwordAt:stamp(),...hashPassword(password)};d.users.push(u);
    return {user:userView(u,d.roles),...(generated?{initialPassword:password}:{})};},'user-created',r=>({by,detail:`role ${r.user.roleId}`}));
  },
  // One change per call: {id, disabled} | {id, role} | {id, name} | {id, remove:true}. Never the owner.
  updateUser(input,{by}={}){
   const keys=plain(input)?Object.keys(input):[],field=keys.find(k=>k!=='id');
   if(typeof input?.id!=='string'||input.id==='owner'||keys.length!==2||!['disabled','role','name','remove'].includes(field))fail('invalid');
   if(field==='disabled'&&typeof input.disabled!=='boolean'||field==='remove'&&input.remove!==true||field==='role'&&typeof input.role!=='string'||field==='name'&&!nameOk(input.name))fail('invalid');
   return transact(d=>{const u=d.users.find(x=>x.id===input.id);if(!u)fail('not-found');
    if(field==='remove'){d.users=d.users.filter(x=>x!==u);if(d.prefs)delete d.prefs[u.id];}
    else if(field==='role'){if(!assignable(input.role,d.roles))fail('invalid');u.role=input.role;}
    else if(field==='name')u.name=input.name.trim();
    else u.disabled=input.disabled;
    return userView(u,d.roles);},field==='remove'?'user-deleted':field==='role'?'user-role-changed':'user-updated',
    r=>({by,detail:field==='role'?`role ${r.roleId}`:field==='disabled'?(r.disabled?'disabled':'enabled'):field==='name'?'name':undefined}));
  },
  // Admin sets a new generated password for a user; it is returned once and their open sessions end.
  resetPassword(input,{by}={}){
   if(!only(input,['id'])||typeof input.id!=='string'||input.id==='owner')fail('invalid');
   const password=randomBytes(18).toString('base64url');
   return transact(d=>{const u=d.users.find(x=>x.id===input.id);if(!u)fail('not-found');const prev=Date.parse(u.passwordAt||u.createdAt||'');let at=stamp();if(Number.isFinite(prev)&&Date.parse(at)<=prev)at=new Date(prev+1).toISOString();Object.assign(u,hashPassword(password),{passwordAt:at});return {user:userView(u,d.roles),password};},'user-password-reset',{by});
  },
  // A signed-in user changes their own password; the current one is required. The owner's hash lives
  // in the auth file, rewritten atomically (0600); everyone else lives in access.json. The new
  // passwordAt ends every other session of that user (auth.mjs); the route signs the caller in again.
  async changePassword(id,input){
   if(!only(input,['currentPassword','newPassword']))fail('invalid');
   const {currentPassword:cur,newPassword:next}=input;
   if(typeof cur!=='string'||cur.length>256||typeof next!=='string'||next.length<12||next.length>256||next===cur)fail('invalid');
   const u=lookup(id);if(!u||u.disabled)fail('not-found');
   const stored=u.id==='owner'?credentials:u;
   // The hash we verify against is captured now and re-checked inside the serialized write: an
   // admin reset or another change that lands while scrypt runs makes this one fail ('superseded')
   // instead of silently overwriting the newer password.
   const verified=stored.hash;
   if(!timingSafeEqual(await derive(cur,stored.salt,64),Buffer.from(verified,'hex')))fail('wrong-password');
   const fresh=hashPassword(next);
   const newer=prev=>{let at=stamp();const t=Date.parse(prev||'');if(Number.isFinite(t)&&Date.parse(at)<=t)at=new Date(t+1).toISOString();return at;};
   if(u.id!=='owner')return transact(d=>{const x=d.users.find(y=>y.id===id);if(!x||x.disabled)fail('not-found');if(x.hash!==verified)fail('superseded');Object.assign(x,fresh,{passwordAt:newer(x.passwordAt||x.createdAt)});return userView(x,d.roles);},'user-password-changed');
   if(!ownerFile)fail('unsupported');
   const op=queue.then(async()=>{
    if(credentials.hash!==verified)fail('superseded');
    const onDisk=JSON.parse(await readFile(ownerFile,'utf8'));
    const passwordAt=newer(owner().passwordAt);
    await writeFile(ownerFile+'.tmp',JSON.stringify({...onDisk,username:credentials.username,...fresh,passwordAt}),{mode:0o600});await rename(ownerFile+'.tmp',ownerFile);
    Object.assign(credentials,fresh,{passwordAt});
    await mkdir(directory,{recursive:true,mode:0o700});
    await audit('owner-password-changed',{id:'owner',name:credentials.username});
    return userView(owner());
   });
   queue=op.catch(()=>{});return op;
  },
  // Own preferences of a signed-in user, keyed by user id ('owner' for the built-in account): the overview
  // tile order and the time zone times are shown in. Callers validate the value; no audit event, it is
  // not an access change.
  homeOrder:id=>{const p=typeof id==='string'&&Object.hasOwn(state.prefs,id)?state.prefs[id]:null;return Array.isArray(p?.homeOrder)?[...p.homeOrder]:null;},
  setHomeOrder(id,order){
   if(typeof id!=='string'||!Array.isArray(order))fail('invalid');
   return transact(d=>{if(id!=='owner'&&!d.users.some(u=>u.id===id&&!u.disabled))fail('not-found');
    d.prefs??={};const own={...(Object.hasOwn(d.prefs,id)?d.prefs[id]:{})};
    if(order.length)own.homeOrder=[...order];else delete own.homeOrder;
    if(Object.keys(own).length)d.prefs[id]=own;else delete d.prefs[id];
    return order.length?[...order]:null;});
  },
  // null = the site's zone; "browser" = the browser's own; otherwise an IANA name.
  timeZone:id=>{const p=typeof id==='string'&&Object.hasOwn(state.prefs,id)?state.prefs[id]:null;return typeof p?.timeZone==='string'&&validTimeZone(p.timeZone)?p.timeZone:null;},
  setTimeZone(id,zone){
   if(typeof id!=='string'||zone!==null&&!validTimeZone(zone))fail('invalid');
   return transact(d=>{if(id!=='owner'&&!d.users.some(u=>u.id===id&&!u.disabled))fail('not-found');
    d.prefs??={};const own={...(Object.hasOwn(d.prefs,id)?d.prefs[id]:{})};
    if(zone)own.timeZone=zone;else delete own.timeZone;
    if(Object.keys(own).length)d.prefs[id]=own;else delete d.prefs[id];
    return zone;});
  },

  // Roles: the four built-in ones, then the custom ones, each with how many people hold it.
  roles:()=>[...BUILTIN_ROLES.map(r=>roleOf(r.id)),...state.roles.map(r=>roleOf(r.id,state.roles))].map(r=>roleView(r)),
  // {name, description?, scopes[], id?}: the id is made from the name unless given; read is always included.
  createRole(input,{by}={}){
   if(!only(input,['id','name','description','scopes'])||!roleNameOk(input.name)||!descriptionOk(input.description)||input.id!==undefined&&(typeof input.id!=='string'||!ROLE_ID.test(input.id)))fail('invalid');
   const scopes=validScopes(input.scopes),name=input.name.trim();
   return transact(d=>{if(d.roles.length>=30)fail('limit');
    const taken=id=>RESERVED_ROLE_IDS.includes(id)||d.roles.some(r=>r.id===id);
    if(input.id!==undefined&&taken(input.id)||[...BUILTIN_ROLES,...d.roles].some(r=>r.name.toLowerCase()===name.toLowerCase()))fail('conflict');
    let id=input.id??slug(name);for(let n=2;taken(id);n++)id=`${slug(name).slice(0,28)}-${n}`;
    const role={id,name,description:(input.description||'').trim(),scopes,createdAt:stamp(),updatedAt:stamp()};d.roles.push(role);
    return {role:roleView(roleOf(id,d.roles),d)};},'role-created',{by});
  },
  // {id, name?, description?, scopes?} changes a custom role (it applies to its users at their next request);
  // {id, remove:true, reassignTo?} deletes it. A role people still hold is deleted only with reassignTo,
  // which moves them to that role in the same write.
  updateRole(input,{by}={}){
   if(!only(input,['id','name','description','scopes','remove','reassignTo'])||typeof input.id!=='string')fail('invalid');
   const removing='remove'in input,fields=['name','description','scopes'].filter(k=>k in input);
   if(removing?(input.remove!==true||fields.length>0||input.reassignTo!==undefined&&typeof input.reassignTo!=='string'):(fields.length===0||'reassignTo'in input))fail('invalid');
   if('name'in input&&!roleNameOk(input.name)||'description'in input&&(typeof input.description!=='string'||!descriptionOk(input.description)))fail('invalid');
   const scopes='scopes'in input?validScopes(input.scopes):null;
   if(builtinRole(input.id))fail('builtin');
   return transact(d=>{const role=d.roles.find(r=>r.id===input.id);if(!role)fail('not-found');
    if(removing){
     const holders=d.users.filter(u=>u.role===role.id);
     if(holders.length){if(input.reassignTo===undefined)fail('in-use');if(input.reassignTo===role.id||!assignable(input.reassignTo,d.roles))fail('invalid');for(const u of holders)u.role=input.reassignTo;}
     const view=roleView(roleOf(role.id,d.roles),d);d.roles=d.roles.filter(r=>r!==role);return {role:view,reassigned:holders.length};
    }
    if('name'in input){const name=input.name.trim();if([...BUILTIN_ROLES,...d.roles].some(r=>r.id!==role.id&&r.name.toLowerCase()===name.toLowerCase()))fail('conflict');role.name=name;}
    if('description'in input)role.description=input.description.trim();
    if(scopes)role.scopes=scopes;
    role.updatedAt=stamp();
    return {role:roleView(roleOf(role.id,d.roles),d)};},removing?'role-deleted':'role-updated',
    r=>({by,detail:removing?(r.reassigned?`users moved to ${input.reassignTo}`:undefined):fields.join(', ')}));
  },

  accounts:()=>state.accounts.map(a=>accountView(a,state.keys)),
  // What an account can be created from (scopes.mjs → accountPresets): read only, each role, full access.
  presets:()=>accountPresets(state.roles),
  // scopes: an explicit list, or ["*"] for full access (every scope, also ones added later).
  createAccount(input,{by}={}){
   if(!only(input,['name','description','scopes'])||!accountNameOk(input.name)||!descriptionOk(input.description))fail('invalid');
   const scopes=validScopes(input.scopes,{wildcard:true});
   return transact(d=>{if(d.accounts.length>=50)fail('limit');if(d.accounts.some(a=>a.name===input.name))fail('conflict');
    const a={id:randomBytes(8).toString('hex'),name:input.name,description:(input.description||'').trim(),scopes,disabled:false,createdAt:stamp()};d.accounts.push(a);return {account:accountView(a,d.keys)};},'account-created',{by,detail:isWildcard(scopes)?'full access':undefined});
  },
  // {id, scopes} | {id, description} | {id, disabled} | {id, remove:true}. Removing revokes the account's keys.
  updateAccount(input,{by}={}){
   const keys=plain(input)?Object.keys(input):[];
   if(typeof input?.id!=='string'||keys.length!==2||!['scopes','description','disabled','remove'].includes(keys.find(k=>k!=='id')))fail('invalid');
   const field=keys.find(k=>k!=='id');
   const scopes=field==='scopes'?validScopes(input.scopes,{wildcard:true}):null;
   if(field==='description'&&(typeof input.description!=='string'||!descriptionOk(input.description))||field==='disabled'&&typeof input.disabled!=='boolean'||field==='remove'&&input.remove!==true)fail('invalid');
   return transact(d=>{const a=d.accounts.find(x=>x.id===input.id);if(!a)fail('not-found');
    if(field==='remove'){d.accounts=d.accounts.filter(x=>x!==a);for(const k of d.keys)if(k.accountId===a.id)k.revokedAt??=stamp();}
    else if(field==='scopes')a.scopes=scopes;else if(field==='description')a.description=input.description.trim();else a.disabled=input.disabled;
    return {account:accountView(a,d.keys)};},field==='remove'?'account-deleted':'account-updated',
    {by,detail:field==='scopes'?(isWildcard(scopes)?'scopes: full access':'scopes'):field==='disabled'?(input.disabled?'disabled':'enabled'):field==='description'?'description':undefined});
  },
  issueAccountKey(input,{by}={}){
   if(!only(input,['accountId','name'])||typeof input.accountId!=='string'||input.name!==undefined&&!nameOk(input.name))fail('invalid');
   return transact(d=>{const a=d.accounts.find(x=>x.id===input.accountId);if(!a)fail('not-found');if(d.keys.filter(k=>!k.revokedAt).length>=100)fail('limit');
    const token='hhk_'+randomBytes(32).toString('hex'),key={id:randomBytes(8).toString('hex'),name:(input.name||`${a.name} · ${stamp().slice(0,10)}`).trim(),accountId:a.id,prefix:token.slice(0,12),hash:sha(token),createdAt:stamp(),lastUsedAt:null,revokedAt:null};
    d.keys.push(key);return {token,key:keyView(key),account:accountView(a,d.keys)};},'key-created',{by});
  },
  keys:()=>state.keys.map(k=>({...keyView(k),accountName:state.accounts.find(a=>a.id===k.accountId)?.name||null})),
  // A key without a service account: read, or everything a write key could do before scopes existed.
  // Kept for scripts; new keys belong to a service account.
  issueKey(input,{by}={}){
   if(!only(input,['name','permission'])||!nameOk(input.name)||!['read','write'].includes(input.permission))fail('invalid');
   return transact(d=>{if(d.keys.filter(k=>!k.revokedAt).length>=100)fail('limit');const token='hhk_'+randomBytes(32).toString('hex'),key={id:randomBytes(8).toString('hex'),name:input.name.trim(),permission:input.permission,prefix:token.slice(0,12),hash:sha(token),createdAt:stamp(),lastUsedAt:null,revokedAt:null};d.keys.push(key);return {token,key:keyView(key)};},'key-created',{by});
  },
  revokeKey(input,{by}={}){
   if(!only(input,['id'])||typeof input.id!=='string')fail('invalid');
   return transact(d=>{const key=d.keys.find(k=>k.id===input.id);if(!key)fail('not-found');key.revokedAt??=stamp();return keyView(key);},'key-revoked',{by});
  },
  // One line per write by an API key (route or MCP tool, status, the entry it touched). No bodies, no tokens.
  logApi(entry){
   const line={at:stamp(),event:entry.tool?'mcp-call':'api-write',key:entry.key||null,account:entry.account||null,name:String(entry.name||'').slice(0,80),
    ...(entry.route?{route:String(entry.route).slice(0,80)}:{}),...(entry.tool?{tool:String(entry.tool).slice(0,40)}:{}),status:entry.status,...(entry.subject?{subject:String(entry.subject).slice(0,64)}:{})};
   return mkdir(directory,{recursive:true,mode:0o700}).then(()=>appendFile(path.join(directory,'api-audit.jsonl'),JSON.stringify(line)+'\n',{mode:0o600}));
  },
  // The principal behind a key, or null. scopes is always the resolved list (a full-access account holds
  // every scope registered at this moment), so callers only ever ask scopes.includes(x).
  verifyKey(token){
   if(typeof token!=='string'||!/^hhk_[a-f0-9]{64}$/.test(token))return null;const digest=Buffer.from(sha(token),'hex');
   const key=state.keys.find(k=>!k.revokedAt&&timingSafeEqual(Buffer.from(k.hash,'hex'),digest));if(!key)return null;
   const account=key.accountId?state.accounts.find(x=>x.id===key.accountId):null;if(key.accountId&&(!account||account.disabled))return null;
   if(!key.lastUsedAt||now()-Date.parse(key.lastUsedAt)>60000){const used=stamp();transact(d=>{const k=d.keys.find(k=>k.id===key.id);if(k&&!k.revokedAt)k.lastUsedAt=used;return null;}).catch(()=>{});}
   if(account){const a=account;
    return {id:key.id,username:a.name,keyName:key.name,role:'api',permission:writesWith(a.scopes)?'write':'read',authKind:'api-key',scopes:resolveScopes(a.scopes),fullAccess:isWildcard(a.scopes),accountId:a.id};}
   return {id:key.id,username:key.name,keyName:key.name,role:'api',permission:key.permission,authKind:'api-key',scopes:legacyScopes(key.permission),fullAccess:false,accountId:null,legacy:true};
  }
 };return api;
}

// Recent access events for the admin audit, newest first: changes to users, roles, service accounts and
// keys (kind "access"), device tokens ("device"), and every write through an API key or MCP tool ("api").
// The files hold ids and names only; a name is looked up in the stores first (it may have changed) and
// falls back to the one written with the event. kind / q narrow the list; limit is 1 to 1000.
export const AUDIT_KINDS=Object.freeze(['access','device','api']);
export async function readAccessAudit(directory,{accessStore,deviceTokens,limit=200,kind=null,q=''}={}){
 const lines=async f=>{try{return (await readFile(path.join(directory,f),'utf8')).split('\n').filter(Boolean).slice(-limit).map(l=>{try{return JSON.parse(l);}catch{return null;}}).filter(Boolean);}catch(e){if(e.code==='ENOENT')return [];throw e;}};
 const users=new Map((accessStore?.users()||[]).map(u=>[u.id,u.username])),keys=new Map((accessStore?.keys()||[]).map(k=>[k.id,k.name]));
 const accounts=new Map((accessStore?.accounts?.()||[]).map(a=>[a.id,a.name])),roles=new Map((accessStore?.roles?.()||[]).map(r=>[r.id,r.name]));
 const devices=new Map((deviceTokens?.list()||[]).map(d=>[d.id,d.name]));
 const nameOf=e=>(e.event?.startsWith('key-')?keys:e.event?.startsWith('account-')?accounts:e.event?.startsWith('role-')?roles:users).get(e.id)||(typeof e.name==='string'?e.name:null);
 const want=k=>!kind||kind===k;
 const access=want('access')?(await lines('access-audit.jsonl')).map(e=>({at:e.at,kind:'access',event:e.event,id:e.id||null,subject:nameOf(e),...(e.detail?{detail:e.detail}:{}),...(e.by?{by:e.by}:{})})):[];
 const api=want('api')?(await lines('api-audit.jsonl')).map(e=>({at:e.at,kind:'api',event:e.event,id:e.key||null,subject:e.name||null,detail:[e.tool||e.route,e.subject].filter(Boolean).join(' · '),status:e.status})):[];
 const device=want('device')?(await lines('device-tokens-audit.jsonl')).map(e=>({at:e.at,kind:'device',event:`device-${e.event}`,id:e.id||null,subject:e.name||devices.get(e.id)||null})):[];
 const needle=String(q||'').trim().toLowerCase();
 const hit=e=>!needle||[e.event,e.subject,e.detail,e.by,e.id,e.status].some(v=>v!=null&&String(v).toLowerCase().includes(needle));
 return [...access,...device,...api].filter(e=>typeof e.at==='string'&&hit(e)).sort((a,b)=>b.at.localeCompare(a.at)).slice(0,limit);
}
