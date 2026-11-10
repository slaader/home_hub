import {readFileSync} from 'node:fs';
import {mkdir,writeFile,rename,appendFile,readFile} from 'node:fs/promises';
import {randomBytes,createHash,timingSafeEqual,scrypt} from 'node:crypto';
import {promisify} from 'node:util';
import path from 'node:path';
import {hashPassword} from './auth.mjs';
import {legacyScopes,validScopes,writesWith} from './scopes.mjs';
const derive=promisify(scrypt),sha=s=>createHash('sha256').update(s).digest('hex');
const nameOk=s=>typeof s==='string'&&s.trim().length>0&&s.length<=80&&!/[\u0000-\u001f\u007f]/.test(s);
// passwordAt: when the password was last set; sessions opened before it are no longer valid (auth.mjs).
const userView=u=>({id:u.id,username:u.username,name:u.name,role:u.role,disabled:u.disabled===true,createdAt:u.createdAt,passwordAt:u.passwordAt||u.createdAt||null,builtin:u.id==='owner'});
const keyView=k=>({id:k.id,name:k.name,permission:k.permission||null,accountId:k.accountId||null,prefix:k.prefix,createdAt:k.createdAt,lastUsedAt:k.lastUsedAt,revokedAt:k.revokedAt});
// Service accounts: named non-human identities (agents, scripts) whose keys carry the account's scopes.
const accountView=(a,keys)=>{const own=keys.filter(k=>k.accountId===a.id).map(keyView);
 return {id:a.id,name:a.name,description:a.description||'',scopes:[...a.scopes],disabled:a.disabled===true,createdAt:a.createdAt,keys:own,
  lastUsedAt:own.map(k=>k.lastUsedAt).filter(Boolean).sort().at(-1)||null};};
const accountNameOk=s=>typeof s==='string'&&/^[a-z][a-z0-9._-]{2,39}$/.test(s);
const descriptionOk=s=>s===undefined||typeof s==='string'&&s.length<=200&&!/[\u0000-\u001f\u007f]/.test(s);
export const apiBearerOf=header=>typeof header==='string'&&/^Bearer hhk_[a-f0-9]{64}$/.test(header)?header.slice(7):null;
// ownerFile: the auth file holding the built-in admin's hash (private/auth.json); needed to change that password.
export function createAccessStore(directory,credentials,{now=Date.now,ownerFile=null}={}){
 const file=path.join(directory,'access.json'),owner={id:'owner',username:credentials.username,name:credentials.username,role:'admin',disabled:false,createdAt:null,
  // Kept in the auth file: sessions survive restarts (state/hub.db), so the stamp that ends older ones must too.
  passwordAt:typeof credentials.passwordAt==='string'?credentials.passwordAt:null};
 let state={schemaVersion:1,users:[],keys:[],accounts:[],prefs:{}};
 try{state=JSON.parse(readFileSync(file,'utf8'));if(state.schemaVersion!==1||!Array.isArray(state.users)||!Array.isArray(state.keys)||state.accounts!==undefined&&!Array.isArray(state.accounts)||state.prefs!==undefined&&(!state.prefs||typeof state.prefs!=='object'||Array.isArray(state.prefs)))throw new Error('Invalid access store');state.accounts??=[];state.prefs??={};}catch(e){if(e.code!=='ENOENT')throw e;}
 let queue=Promise.resolve();const stamp=()=>new Date(now()).toISOString();
 const transact=(change,event)=>{const op=queue.then(async()=>{const draft=structuredClone(state),result=change(draft);await mkdir(directory,{recursive:true,mode:0o700});await writeFile(file+'.tmp',JSON.stringify(draft),{mode:0o600});await rename(file+'.tmp',file);state=draft;if(event)await appendFile(path.join(directory,'access-audit.jsonl'),JSON.stringify({at:stamp(),event,...((result?.id||result?.user?.id||result?.key?.id||result?.account?.id)?{id:result.id||result.user?.id||result.key?.id||result.account?.id}:{})})+'\n',{mode:0o600});return result;});queue=op.catch(()=>{});return op;};
 const lookup=id=>id==='owner'?owner:state.users.find(u=>u.id===id);
 const api={
  user:id=>{const u=lookup(id);return u&&!u.disabled?userView(u):null;},
  users:()=>[owner,...state.users].map(userView),
  async authenticate(username,password){
   const u=typeof username==='string'?(username===credentials.username?owner:state.users.find(x=>x.username===username)):null;
   const stored=u?.id==='owner'?credentials:u||credentials;
   const candidate=await derive(password,stored.salt,64);
   return u&&!u.disabled&&timingSafeEqual(candidate,Buffer.from(stored.hash,'hex'))?userView(u):null;
  },
  createUser(input){
   if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['username','name','password'].includes(k))||typeof input.username!=='string'||!/^[a-z][a-z0-9._-]{2,39}$/.test(input.username)||!nameOk(input.name||input.username))throw new Error('invalid');
   const generated=!input.password,password=generated?randomBytes(18).toString('base64url'):input.password;
   if(typeof password!=='string'||password.length<12||password.length>256)throw new Error('invalid');
   return transact(d=>{if(d.users.length>=100)throw new Error('limit');if(input.username===owner.username||d.users.some(u=>u.username===input.username))throw new Error('conflict');const u={id:randomBytes(8).toString('hex'),username:input.username,name:(input.name||input.username).trim(),role:'viewer',disabled:false,createdAt:stamp(),passwordAt:stamp(),...hashPassword(password)};d.users.push(u);return {user:userView(u),...(generated?{initialPassword:password}:{})};},'user-created');
  },
  updateUser(input){
   if(!input||typeof input!=='object'||Object.keys(input).some(k=>!['id','disabled','remove'].includes(k))||typeof input.id!=='string'||input.id==='owner'||(typeof input.disabled!=='boolean'&&input.remove!==true)||('disabled'in input&&'remove'in input))throw new Error('invalid');
   return transact(d=>{const u=d.users.find(x=>x.id===input.id);if(!u)throw new Error('not-found');if(input.remove){d.users=d.users.filter(x=>x!==u);if(d.prefs)delete d.prefs[u.id];}else u.disabled=input.disabled;return userView(u);},input.remove?'user-deleted':'user-updated');
  },
  // Admin sets a new generated password for a viewer; it is returned once and their open sessions end.
  resetPassword(input){
   if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>k!=='id')||typeof input.id!=='string'||input.id==='owner')throw new Error('invalid');
   const password=randomBytes(18).toString('base64url');
   return transact(d=>{const u=d.users.find(x=>x.id===input.id);if(!u)throw new Error('not-found');const prev=Date.parse(u.passwordAt||u.createdAt||'');let at=stamp();if(Number.isFinite(prev)&&Date.parse(at)<=prev)at=new Date(prev+1).toISOString();Object.assign(u,hashPassword(password),{passwordAt:at});return {user:userView(u),password};},'user-password-reset');
  },
  // A signed-in user changes their own password; the current one is required. The built-in admin's
  // hash lives in the auth file, rewritten atomically (0600); viewers live in access.json. The new
  // passwordAt ends every other session of that user (auth.mjs); the route signs the caller in again.
  async changePassword(id,input){
   if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['currentPassword','newPassword'].includes(k)))throw new Error('invalid');
   const {currentPassword:cur,newPassword:next}=input;
   if(typeof cur!=='string'||cur.length>256||typeof next!=='string'||next.length<12||next.length>256||next===cur)throw new Error('invalid');
   const u=lookup(id);if(!u||u.disabled)throw new Error('not-found');
   const stored=u.id==='owner'?credentials:u;
   // The hash we verify against is captured now and re-checked inside the serialized write: an
   // admin reset or another change that lands while scrypt runs makes this one fail ('superseded')
   // instead of silently overwriting the newer password.
   const verified=stored.hash;
   if(!timingSafeEqual(await derive(cur,stored.salt,64),Buffer.from(verified,'hex')))throw new Error('wrong-password');
   const fresh=hashPassword(next);
   const newer=prev=>{let at=stamp();const t=Date.parse(prev||'');if(Number.isFinite(t)&&Date.parse(at)<=t)at=new Date(t+1).toISOString();return at;};
   if(u.id!=='owner')return transact(d=>{const x=d.users.find(y=>y.id===id);if(!x||x.disabled)throw new Error('not-found');if(x.hash!==verified)throw new Error('superseded');Object.assign(x,fresh,{passwordAt:newer(x.passwordAt||x.createdAt)});return userView(x);},'user-password-changed');
   if(!ownerFile)throw new Error('unsupported');
   const op=queue.then(async()=>{
    if(credentials.hash!==verified)throw new Error('superseded');
    const onDisk=JSON.parse(await readFile(ownerFile,'utf8'));
    const passwordAt=newer(owner.passwordAt);
    await writeFile(ownerFile+'.tmp',JSON.stringify({...onDisk,username:credentials.username,...fresh,passwordAt}),{mode:0o600});await rename(ownerFile+'.tmp',ownerFile);
    Object.assign(credentials,fresh,{passwordAt});owner.passwordAt=passwordAt;
    await mkdir(directory,{recursive:true,mode:0o700});
    await appendFile(path.join(directory,'access-audit.jsonl'),JSON.stringify({at:stamp(),event:'owner-password-changed',id:'owner'})+'\n',{mode:0o600});
    return userView(owner);
   });
   queue=op.catch(()=>{});return op;
  },
  // Own preferences of a signed-in user (today: the overview tile order), keyed by user id ('owner'
  // for the built-in admin). Callers validate the value; no audit event, it is not an access change.
  homeOrder:id=>{const p=typeof id==='string'&&Object.hasOwn(state.prefs,id)?state.prefs[id]:null;return Array.isArray(p?.homeOrder)?[...p.homeOrder]:null;},
  setHomeOrder(id,order){
   if(typeof id!=='string'||!Array.isArray(order))throw new Error('invalid');
   return transact(d=>{if(id!=='owner'&&!d.users.some(u=>u.id===id&&!u.disabled))throw new Error('not-found');
    d.prefs??={};const own={...(Object.hasOwn(d.prefs,id)?d.prefs[id]:{})};
    if(order.length)own.homeOrder=[...order];else delete own.homeOrder;
    if(Object.keys(own).length)d.prefs[id]=own;else delete d.prefs[id];
    return order.length?[...order]:null;});
  },
  accounts:()=>state.accounts.map(a=>accountView(a,state.keys)),
  createAccount(input){
   if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['name','description','scopes'].includes(k))||!accountNameOk(input.name)||!descriptionOk(input.description))throw new Error('invalid');
   const scopes=validScopes(input.scopes);
   return transact(d=>{if(d.accounts.length>=50)throw new Error('limit');if(d.accounts.some(a=>a.name===input.name))throw new Error('conflict');
    const a={id:randomBytes(8).toString('hex'),name:input.name,description:(input.description||'').trim(),scopes,disabled:false,createdAt:stamp()};d.accounts.push(a);return {account:accountView(a,d.keys)};},'account-created');
  },
  // {id, scopes} | {id, description} | {id, disabled} | {id, remove:true}. Removing revokes the account's keys.
  updateAccount(input){
   const keys=input&&typeof input==='object'&&!Array.isArray(input)?Object.keys(input):[];
   if(typeof input?.id!=='string'||keys.length!==2||!['scopes','description','disabled','remove'].includes(keys.find(k=>k!=='id')))throw new Error('invalid');
   const field=keys.find(k=>k!=='id');
   const scopes=field==='scopes'?validScopes(input.scopes):null;
   if(field==='description'&&!descriptionOk(input.description)||field==='disabled'&&typeof input.disabled!=='boolean'||field==='remove'&&input.remove!==true)throw new Error('invalid');
   return transact(d=>{const a=d.accounts.find(x=>x.id===input.id);if(!a)throw new Error('not-found');
    if(field==='remove'){d.accounts=d.accounts.filter(x=>x!==a);for(const k of d.keys)if(k.accountId===a.id)k.revokedAt??=stamp();}
    else if(field==='scopes')a.scopes=scopes;else if(field==='description')a.description=input.description.trim();else a.disabled=input.disabled;
    return {account:accountView(a,d.keys)};},field==='remove'?'account-deleted':'account-updated');
  },
  issueAccountKey(input){
   if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['accountId','name'].includes(k))||typeof input.accountId!=='string'||input.name!==undefined&&!nameOk(input.name))throw new Error('invalid');
   return transact(d=>{const a=d.accounts.find(x=>x.id===input.accountId);if(!a)throw new Error('not-found');if(d.keys.filter(k=>!k.revokedAt).length>=100)throw new Error('limit');
    const token='hhk_'+randomBytes(32).toString('hex'),key={id:randomBytes(8).toString('hex'),name:(input.name||`${a.name} · ${stamp().slice(0,10)}`).trim(),accountId:a.id,prefix:token.slice(0,12),hash:sha(token),createdAt:stamp(),lastUsedAt:null,revokedAt:null};
    d.keys.push(key);return {token,key:keyView(key),account:accountView(a,d.keys)};},'key-created');
  },
  keys:()=>state.keys.map(k=>({...keyView(k),accountName:state.accounts.find(a=>a.id===k.accountId)?.name||null})),
  issueKey(input){
   if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['name','permission'].includes(k))||!nameOk(input.name)||!['read','write'].includes(input.permission))throw new Error('invalid');
   return transact(d=>{if(d.keys.filter(k=>!k.revokedAt).length>=100)throw new Error('limit');const token='hhk_'+randomBytes(32).toString('hex'),key={id:randomBytes(8).toString('hex'),name:input.name.trim(),permission:input.permission,prefix:token.slice(0,12),hash:sha(token),createdAt:stamp(),lastUsedAt:null,revokedAt:null};d.keys.push(key);return {token,key:keyView(key)};},'key-created');
  },
  revokeKey(input){
   if(!input||typeof input!=='object'||Object.keys(input).some(k=>k!=='id')||typeof input.id!=='string')throw new Error('invalid');
   return transact(d=>{const key=d.keys.find(k=>k.id===input.id);if(!key)throw new Error('not-found');key.revokedAt??=stamp();return keyView(key);},'key-revoked');
  },
  // One line per write by an API key (route or MCP tool, status, the entry it touched). No bodies, no tokens.
  logApi(entry){
   const line={at:stamp(),event:entry.tool?'mcp-call':'api-write',key:entry.key||null,account:entry.account||null,name:String(entry.name||'').slice(0,80),
    ...(entry.route?{route:String(entry.route).slice(0,80)}:{}),...(entry.tool?{tool:String(entry.tool).slice(0,40)}:{}),status:entry.status,...(entry.subject?{subject:String(entry.subject).slice(0,64)}:{})};
   return mkdir(directory,{recursive:true,mode:0o700}).then(()=>appendFile(path.join(directory,'api-audit.jsonl'),JSON.stringify(line)+'\n',{mode:0o600}));
  },
  verifyKey(token){
   if(typeof token!=='string'||!/^hhk_[a-f0-9]{64}$/.test(token))return null;const digest=Buffer.from(sha(token),'hex');
   const key=state.keys.find(k=>!k.revokedAt&&timingSafeEqual(Buffer.from(k.hash,'hex'),digest));if(!key)return null;
   const account=key.accountId?state.accounts.find(x=>x.id===key.accountId):null;if(key.accountId&&(!account||account.disabled))return null;
   if(!key.lastUsedAt||now()-Date.parse(key.lastUsedAt)>60000){const used=stamp();transact(d=>{const k=d.keys.find(k=>k.id===key.id);if(k&&!k.revokedAt)k.lastUsedAt=used;return null;}).catch(()=>{});}
   if(account){const a=account;
    return {id:key.id,username:a.name,keyName:key.name,role:'api',permission:writesWith(a.scopes)?'write':'read',authKind:'api-key',scopes:[...a.scopes],accountId:a.id};}
   return {id:key.id,username:key.name,keyName:key.name,role:'api',permission:key.permission,authKind:'api-key',scopes:legacyScopes(key.permission),accountId:null,legacy:true};
  }
 };return api;
}

// Recent access events (users, API keys, device tokens) for the admin audit tab, newest first.
// The audit files hold ids and names only; usernames and key names are resolved from the stores.
export async function readAccessAudit(directory,{accessStore,deviceTokens,limit=200}={}){
 const lines=async f=>{try{return (await readFile(path.join(directory,f),'utf8')).split('\n').filter(Boolean).slice(-limit).map(l=>{try{return JSON.parse(l);}catch{return null;}}).filter(Boolean);}catch(e){if(e.code==='ENOENT')return [];throw e;}};
 const users=new Map((accessStore?.users()||[]).map(u=>[u.id,u.username])),keys=new Map((accessStore?.keys()||[]).map(k=>[k.id,k.name]));
 const accounts=new Map((accessStore?.accounts?.()||[]).map(a=>[a.id,a.name]));
 const devices=new Map((deviceTokens?.list()||[]).map(d=>[d.id,d.name]));
 const access=(await lines('access-audit.jsonl')).map(e=>({at:e.at,event:e.event,id:e.id||null,subject:e.event?.startsWith('key-')?keys.get(e.id)||null:e.event?.startsWith('account-')?accounts.get(e.id)||null:users.get(e.id)||null}));
 const api=(await lines('api-audit.jsonl')).map(e=>({at:e.at,event:e.event,id:e.key||null,subject:e.name||null,detail:[e.tool||e.route,e.subject].filter(Boolean).join(' · '),status:e.status}));
 const device=(await lines('device-tokens-audit.jsonl')).map(e=>({at:e.at,event:`device-${e.event}`,id:e.id||null,subject:e.name||devices.get(e.id)||null}));
 return [...access,...device,...api].filter(e=>typeof e.at==='string').sort((a,b)=>b.at.localeCompare(a.at)).slice(0,limit);
}
