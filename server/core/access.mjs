// Core module "access": users, API keys, service accounts and their scopes, the access audit, and
// device tokens for native clients. Everything under /api/admin/ needs an administrator's password
// sign-in (enforced by the pipeline); API keys never reach these routes.
import {readAccessAudit} from '../access-store.mjs';
import {SCOPES} from '../scopes.mjs';

const adminError=e=>[({invalid:400,'not-found':404,conflict:409,limit:409})[e.message]||503,'ACCESS_FAILED',({invalid:'Invalid account or API key request. New usernames use 3–40 lowercase letters, numbers, dots, underscores or hyphens; passwords need at least 12 characters.','not-found':'That user or API key no longer exists.',conflict:'This username already exists.',limit:'The account or active API key limit has been reached.'})[e.message]||'Access management is unavailable.'];
const deviceError=(e,c)=>[({invalid:400,'not-found':404,conflict:409,busy:429})[e.message]||503,'UPDATE_FAILED',({invalid:'Invalid request.','not-found':'Device not found.',conflict:'This record changed in another session. Reload the record before saving.',busy:'Another service action is running. Please retry shortly.'})[e.message]||(c.req.method==='GET'?'Cannot reach service controls. Try refreshing.':'Unable to confirm the operation. Refresh the current state before retrying.')];
// What the admin UI lists: id → {label, desc} (the registry's own flags stay inside).
const scopeCatalog=()=>Object.fromEntries(Object.entries(SCOPES).map(([id,{label,desc}])=>[id,{label,desc}]));
const admin=routes=>routes.map(r=>({scope:null,error:adminError,...r}));

export default {
 id:'access',title:'Users and API',
 assets:['access-view.js','access.css'],
 nav:[{groupKey:'Správa',hash:'access',labelKey:'Uživatelé a API',view:'access-view.js#accessPage',order:50}],
 routes:[...admin([
  {method:'GET',path:'/api/admin/users',handler:({json,hub})=>json(200,{users:hub.accessStore.users()})},
  {method:'GET',path:'/api/admin/keys',handler:({json,hub})=>json(200,{keys:hub.accessStore.keys()})},
  {method:'GET',path:'/api/admin/accounts',handler:({json,hub})=>json(200,{accounts:hub.accessStore.accounts(),scopes:scopeCatalog()})},
  {method:'GET',path:'/api/admin/audit',handler:async({json,hub})=>json(200,{events:await readAccessAudit(hub.stateDirectory,{accessStore:hub.accessStore,deviceTokens:hub.deviceTokens})})},
  {method:'POST',path:'/api/admin/users',handler:async({input,json,hub})=>json(201,await hub.accessStore.createUser(input))},
  {method:'POST',path:'/api/admin/users/action',async handler({input,json,hub}){await hub.accessStore.updateUser(input);return json(200,{users:hub.accessStore.users()});}},
  {method:'POST',path:'/api/admin/users/password',handler:async({input,json,hub})=>json(200,await hub.accessStore.resetPassword(input))},
  {method:'POST',path:'/api/admin/keys',handler:async({input,json,hub})=>json(201,await hub.accessStore.issueKey(input))},
  {method:'POST',path:'/api/admin/keys/revoke',async handler({input,json,hub}){await hub.accessStore.revokeKey(input);return json(200,{keys:hub.accessStore.keys()});}},
  {method:'POST',path:'/api/admin/accounts',handler:async({input,json,hub})=>json(201,await hub.accessStore.createAccount(input))},
  {method:'POST',path:'/api/admin/accounts/action',async handler({input,json,hub}){await hub.accessStore.updateAccount(input);return json(200,{accounts:hub.accessStore.accounts()});}},
  {method:'POST',path:'/api/admin/accounts/keys',handler:async({input,json,hub})=>json(201,await hub.accessStore.issueAccountKey(input))},
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
};
