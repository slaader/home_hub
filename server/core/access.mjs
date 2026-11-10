// Core module "access": people and their roles, service accounts with scopes and API keys, the access
// audit, and device tokens for native clients. Everything under /api/admin/ needs an administrator's
// password sign-in (the owner or the Admin role; enforced by the pipeline). No API key reaches these
// routes, whatever its scopes, and none of this is offered over MCP: the one tool here, whoami, only
// tells a key what it already holds.
import {readAccessAudit,AUDIT_KINDS} from '../access-store.mjs';
import {SCOPES} from '../scopes.mjs';

const ADMIN_MESSAGES={
 invalid:'Invalid request. Names use 3–40 lowercase letters, numbers, dots, underscores or hyphens; passwords need at least 12 characters; a role or scope must be one that exists.',
 'not-found':'That user, role, service account or API key no longer exists.',
 conflict:'That name is already taken.',
 limit:'The limit has been reached (100 users, 30 custom roles, 50 service accounts, 100 active keys).',
 'in-use':'People still hold this role. Choose the role they move to, then delete it.',
 builtin:'Built-in roles cannot be changed or deleted.'};
const adminError=e=>[({invalid:400,builtin:400,'not-found':404,conflict:409,limit:409,'in-use':409})[e.message]||503,e.message==='in-use'?'ROLE_IN_USE':'ACCESS_FAILED',ADMIN_MESSAGES[e.message]||'Access management is unavailable.'];
const deviceError=(e,c)=>[({invalid:400,'not-found':404,conflict:409,busy:429})[e.message]||503,'UPDATE_FAILED',({invalid:'Invalid request.','not-found':'Device not found.',conflict:'This record changed in another session. Reload the record before saving.',busy:'Another service action is running. Please retry shortly.'})[e.message]||(c.req.method==='GET'?'Cannot reach service controls. Try refreshing.':'Unable to confirm the operation. Refresh the current state before retrying.')];
// What the admin UI lists: id → {label, desc, write, legacy, module}. write:false = holding it changes nothing;
// legacy:false = a key from before service accounts (permission "write") never holds it.
const scopeCatalog=hub=>Object.fromEntries(Object.entries(SCOPES).map(([id,{label,desc,readOnly,legacy}])=>[id,{label,desc,write:!readOnly,legacy:legacy!==false,module:hub.registry.scopes.get(id)?.module??null}]));
const admin=routes=>routes.map(r=>({scope:null,error:adminError,...r}));
// Who made the change, for the audit line.
const by=c=>({by:c.principal.username});
// GET /api/admin/audit?kind=access|device|api&q=text&limit=1..1000
function auditQuery(query){
 const extra=Object.keys(query).filter(k=>!['kind','q','limit'].includes(k));
 const limit=query.limit===undefined?200:Number(query.limit);
 if(extra.length||query.kind!==undefined&&!AUDIT_KINDS.includes(query.kind)||!Number.isInteger(limit)||limit<1||limit>1000||query.q!==undefined&&query.q.length>80)throw new Error('invalid');
 return {kind:query.kind??null,q:query.q??'',limit};
}
// What a key may not do, whatever its scopes. Told to agents by whoami so they do not go looking.
const NEVER=['/api/admin/* (users, roles, service accounts, keys, audit)','/api/devices/tokens (device tokens)','/api/session (password sign-in)','/api/profile/* (own account settings)'];

export default {
 id:'access',title:'Users and API',
 assets:['access-view.js','access.css'],
 nav:[{groupKey:'Správa',hash:'access',labelKey:'Uživatelé a API',view:'access-view.js#accessPage',order:50}],
 routes:[...admin([
  {method:'GET',path:'/api/admin/users',handler:({json,hub})=>json(200,{users:hub.accessStore.users(),roles:hub.accessStore.roles()})},
  {method:'GET',path:'/api/admin/roles',handler:({json,hub})=>json(200,{roles:hub.accessStore.roles(),scopes:scopeCatalog(hub)})},
  {method:'GET',path:'/api/admin/keys',handler:({json,hub})=>json(200,{keys:hub.accessStore.keys()})},
  {method:'GET',path:'/api/admin/accounts',handler:({json,hub})=>json(200,{accounts:hub.accessStore.accounts(),scopes:scopeCatalog(hub),presets:hub.accessStore.presets()})},
  {method:'GET',path:'/api/admin/audit',async handler({query,json,hub}){
    const filter=auditQuery(query);
    return json(200,{events:await readAccessAudit(hub.stateDirectory,{accessStore:hub.accessStore,deviceTokens:hub.deviceTokens,...filter}),...filter});}},
  {method:'POST',path:'/api/admin/users',handler:async c=>c.json(201,await c.hub.accessStore.createUser(c.input,by(c)))},
  {method:'POST',path:'/api/admin/users/action',async handler(c){await c.hub.accessStore.updateUser(c.input,by(c));return c.json(200,{users:c.hub.accessStore.users()});}},
  {method:'POST',path:'/api/admin/users/password',handler:async c=>c.json(200,await c.hub.accessStore.resetPassword(c.input,by(c)))},
  {method:'POST',path:'/api/admin/roles',handler:async c=>c.json(201,await c.hub.accessStore.createRole(c.input,by(c)))},
  {method:'POST',path:'/api/admin/roles/action',async handler(c){const done=await c.hub.accessStore.updateRole(c.input,by(c));return c.json(200,{...done,roles:c.hub.accessStore.roles()});}},
  {method:'POST',path:'/api/admin/keys',handler:async c=>c.json(201,await c.hub.accessStore.issueKey(c.input,by(c)))},
  {method:'POST',path:'/api/admin/keys/revoke',async handler(c){await c.hub.accessStore.revokeKey(c.input,by(c));return c.json(200,{keys:c.hub.accessStore.keys()});}},
  {method:'POST',path:'/api/admin/accounts',handler:async c=>c.json(201,await c.hub.accessStore.createAccount(c.input,by(c)))},
  {method:'POST',path:'/api/admin/accounts/action',async handler(c){await c.hub.accessStore.updateAccount(c.input,by(c));return c.json(200,{accounts:c.hub.accessStore.accounts()});}},
  {method:'POST',path:'/api/admin/accounts/keys',handler:async c=>c.json(201,await c.hub.accessStore.issueAccountKey(c.input,by(c)))},
 ]),
  // Device tokens: the pipeline already limits these paths to administrators and keeps API keys out.
  {method:'GET',path:'/api/devices/tokens',scope:null,error:deviceError,handler:({device,json,hub})=>json(200,{devices:hub.deviceTokens.list(device)})},
  // Minting a token needs a password sign-in (the cookie); a token cannot create more tokens.
  {method:'POST',path:'/api/devices/tokens',scope:null,error:deviceError,async handler({req,input,json,error,hub}){
    if(!hub.auth.valid(req.headers.cookie))return error(401,'AUTH_REQUIRED','Sign in with your password to add a device.');
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>k!=='name'))return error(400,'INVALID_INPUT','Invalid request.');
    try{return json(201,await hub.deviceTokens.issue(input.name));}catch(e){return e.message==='limit'?error(409,'DEVICE_LIMIT','Twenty devices already have access. Revoke one first.'):error(400,'INVALID_INPUT','Device name must be 1 to 60 characters.');}}},
  {method:'POST',path:'/api/devices/tokens/revoke',scope:null,error:deviceError,async handler({device,input,json,error,hub}){
    try{await hub.deviceTokens.revoke(input?.id);}catch{return error(404,'NOT_FOUND','That device no longer has access.');}return json(200,{ok:true,devices:hub.deviceTokens.list(device)});}},
 ],
 mcpInstructions:'Access: whoami explains the scopes of this key and what no key can ever reach. Call it when a tool is refused or missing from the list.',
 // Not administrative: a key learns only about itself. Users, roles and keys are never managed over MCP.
 mcpTools:[{name:'whoami',scope:'read',title:'Home Hub: who am I',
  description:'The service account behind this key and what it may do: its scopes (with what each allows), whether it can write, and what no key can ever reach. Call it first when a tool is refused or missing from the list.',
  inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,openWorldHint:false},
  run:(args,{principal})=>({account:principal.username,key:principal.keyName??null,kind:principal.legacy?'legacy key':'service account',
   fullAccess:principal.fullAccess===true,canWrite:principal.permission==='write',
   scopes:principal.scopes.map(id=>({id,allows:SCOPES[id]?.label??null,write:SCOPES[id]?!SCOPES[id].readOnly:null})),
   never:NEVER})}],
 apiDocs:[{title:'Správa přístupu',routes:[
  ['GET','/api/admin/roles','admin','Role (vestavěné i vlastní) s počtem uživatelů a katalog oprávnění.'],
  ['POST','/api/admin/roles','admin','Nová vlastní role {name, description?, scopes[], id?}.'],
  ['POST','/api/admin/roles/action','admin','{id, name?, description?, scopes?} nebo {id, remove: true, reassignTo?}.'],
 ]},{title:'Účet',routes:[
  ['GET','/api/profile','password','Vlastní účet, role a předvolby.'],
  ['POST','/api/profile/prefs','password','{timeZone: null | "browser" | "Europe/Prague"}.'],
  ['POST','/api/profile/password','password','{currentPassword, newPassword}; ostatní přihlášení končí.'],
 ]}],
};
