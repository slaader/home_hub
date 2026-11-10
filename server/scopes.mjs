// Service-account scopes: which API key may call which endpoint. One registry for the HTTP API and
// the MCP tools, so a scope always means the same thing. Core defines its scopes below; a plugin adds
// its own through its module definition (server/plugins.mjs), never by editing this file. Which scope
// a route needs is declared on the route. Admin routes (users, roles, keys, accounts) and device-token
// minting are never reachable with an API key, whatever its scopes: not even with the wildcard.
// People are checked against the same table: a role is a set of these scopes (see the end of this file).

// label/desc are shown in the admin UI. They are written in the UI's source language (Czech) and
// translated through public/i18n-en-*.js like every other string.
// readOnly: holding it does not make a key a writer. legacy:false: old read/write keys never get it.
export const CORE_SCOPES=Object.freeze({
 'read':{label:'Čtení',desc:'Číst přehled, stroje, inventář, služby, zálohy, modely a paměť. Každý servisní účet ho má.',readOnly:true},
 'inventory:write':{label:'Inventář – zápis',desc:'Zakládat a měnit záznamy inventáře a služeb (s kontrolou otisku a bez tajemství).'},
 'home:settings':{label:'Nastavení přehledu',desc:'Měnit interval čtení Thermo.'},
 'tickets:write':{label:'Tickety – zápis',desc:'Zakládat a měnit tickety, komentáře, releasy a projekty vývoje.'},
 'review:write':{label:'Review – zápis',desc:'Nahrávat varianty k posouzení (mockupy, rendery) a ukládat rozhodnutí a připomínky.'},
 'security:read':{label:'Bezpečnost – čtení',desc:'Číst inventář SSH klíčů, verze systémů a ochranu strojů.',readOnly:true,legacy:false},

 // Overview module (server/core/home.mjs): machine_upsert, machine_remove, runtime_publish. New, so old read/write keys never get it.
 'home:write':{label:'Přehled – zápis',desc:'Přidávat, měnit a odebírat stroje v přehledu a zveřejňovat jejich runtime stack a endpointy LLM runtimů, které hub čte (s kontrolou otisku a bez tajemství).',legacy:false},
 'software:write':{label:'Sledovaný software – zápis',desc:'Číst a měnit seznam sledovaného softwaru: odkud se bere nejnovější verze a jak se na stroji zjistí nainstalovaná.',legacy:false},
});

// The live table: core scopes first, then whatever the loaded plugins registered, in load order.
// Stored keys keep their scope ids as they are; an id whose plugin is not loaded simply opens nothing.
export const SCOPES={};
const owners=new Map();
export function registerScopes(owner,definitions){
 for(const [id,meta] of Object.entries(definitions)){
  const held=owners.get(id);
  if(held&&held!==owner)throw new Error(`scope "${id}" is registered twice: by "${held}" and by "${owner}"`);
  owners.set(id,owner);SCOPES[id]=Object.freeze({label:meta.label,desc:meta.desc,...(meta.readOnly?{readOnly:true}:{}),...(meta.legacy===false?{legacy:false}:{})});
 }
}
registerScopes('core',CORE_SCOPES);
export const scopeIds=()=>Object.keys(SCOPES);
// Everything a legacy "write" key could do before scopes existed (it never had security:read).
export const legacyScopes=permission=>permission==='write'?scopeIds().filter(s=>SCOPES[s].legacy!==false):['read'];
// Does this list make its holder a writer? (An id no loaded module defines counts as before: it opens no route.)
export const writesWith=scopes=>resolveScopes(scopes).some(s=>!SCOPES[s]?.readOnly);

// Own-account routes (Nastavení, password change) need a password sign-in, never a key.
export const sessionOnly=pathname=>pathname.startsWith('/api/profile/');
// Routes: (method, pathname) → {route}|null, from the module registry. index.mjs installs the registry
// of the modules loaded at start-up; a handler built with its own modules passes its own matcher.
let defaultMatch=()=>null;
export const useRoutes=match=>{defaultMatch=match;};
// The scope an API key needs for this request, or null when keys may never call it.
export function scopeFor(method,pathname,match=defaultMatch){
 if(pathname.startsWith('/api/admin/')||pathname.startsWith('/api/devices/tokens')||pathname==='/api/session'||sessionOnly(pathname))return null;
 const hit=match(method==='HEAD'?'GET':method,pathname);
 if(hit)return hit.route.scope;
 return method==='GET'||method==='HEAD'?'read':null;
}

// "*" in a stored scope list is the wildcard: every scope there is now and every scope a plugin registers
// later. It is resolved when a request is checked, never written out as a list, so a new plugin's scope
// is covered without touching the account. Only the "Full access (agent)" preset stores it.
export const ALL_SCOPES='*';
export const isWildcard=scopes=>Array.isArray(scopes)&&scopes.includes(ALL_SCOPES);
// A stored list as the scope ids it stands for right now. Unknown ids (a plugin that is not loaded) stay
// in the list and simply open nothing.
export const resolveScopes=scopes=>isWildcard(scopes)?scopeIds():[...scopes];
// wildcard:true accepts ["*"] (service accounts); a custom role is always an explicit list.
export function validScopes(input,{wildcard=false}={}){
 const ids=scopeIds();
 if(!Array.isArray(input)||input.length>ids.length+1||input.some(s=>typeof s!=='string'))throw new Error('invalid');
 if(input.includes(ALL_SCOPES)){if(!wildcard)throw new Error('invalid');return [ALL_SCOPES];}
 if(input.some(s=>!SCOPES[s]))throw new Error('invalid');
 return ids.filter(s=>s==='read'||input.includes(s));
}

// Roles for people. A role is a set of scopes; a signed-in person may call a route when their role holds
// the route's scope, exactly like an API key. Administration (users, roles, service accounts, keys,
// device tokens) is not a scope: only the roles marked admin have it, and only with a password sign-in.
// Built-in roles are resolved when asked, so they follow the scopes plugins register:
//   owner   the built-in account from the auth file; cannot be deleted, disabled or given another role
//   admin   everything, including administration
//   editor  read and every write scope, no administration, no sensitive read-only scopes (security:read)
//   viewer  read only
// name/description are source-language text (Czech), translated in the UI like scope labels.
export const BUILTIN_ROLES=Object.freeze([
 {id:'owner',name:'Vlastník',description:'Vestavěný účet tohoto Home Hubu. Smí všechno včetně správy; nejde smazat, zakázat ani mu změnit roli.',admin:true,assignable:false,grants:()=>scopeIds()},
 {id:'admin',name:'Admin',description:'Všechno včetně správy uživatelů, rolí, servisních účtů, klíčů a zařízení.',admin:true,assignable:true,grants:()=>scopeIds()},
 {id:'editor',name:'Editor',description:'Čtení a všechny zápisy. Bez správy přístupu a bez citlivých přehledů (bezpečnost).',admin:false,assignable:true,grants:()=>scopeIds().filter(s=>s==='read'||!SCOPES[s].readOnly)},
 {id:'viewer',name:'Čtenář',description:'Jen čtení: vidí přehled, stroje, inventář a tracker, nic nemění.',admin:false,assignable:true,grants:()=>['read']},
]);
export const ROLE_ID=/^[a-z][a-z0-9-]{1,31}$/;
// Ids a custom role may not take: the built-in ones and the principal kinds.
export const RESERVED_ROLE_IDS=Object.freeze([...BUILTIN_ROLES.map(r=>r.id),'api','device','service','none']);
export const builtinRole=id=>BUILTIN_ROLES.find(r=>r.id===id)||null;
// One role as the rest of the server sees it. custom: the stored custom roles ([{id,name,description,scopes}]).
// An id that names nothing (a deleted role left on a hand-edited file) resolves to viewer, marked missing.
export function roleOf(id,custom=[]){
 const built=builtinRole(id);
 if(built)return {id:built.id,name:built.name,description:built.description,builtin:true,admin:built.admin,assignable:built.assignable,scopes:built.grants()};
 const own=custom.find(r=>r.id===id);
 if(own)return {id:own.id,name:own.name,description:own.description||'',builtin:false,admin:false,assignable:true,scopes:[...own.scopes]};
 return {...roleOf('viewer'),missing:true};
}
// What a client that knew only "admin" and "viewer" reads in `role`: the owner reports "admin", as it
// always has; every other role reports its id. The exact id is `roleId`.
export const legacyRole=role=>role.id==='owner'?'admin':role.id;

// What a service account can be created from: read only, every role a person can have (a snapshot of the
// role's scopes as they are now), and full access. Presets fill in the scope list; only "full" stores the
// wildcard and so follows scopes added later. No preset, and no scope, reaches administration: a key
// made from the Admin role holds Admin's scopes, never its administration.
export function accountPresets(custom=[]){
 const fromRole=(r,description=r.description)=>({id:`role:${r.id}`,name:r.name,description,scopes:r.scopes,wildcard:false,role:r.id});
 return [
  {id:'read',name:'Jen čtení',description:'Číst všechno, co vidí role Čtenář. Nic nemění.',scopes:['read'],wildcard:false,role:'viewer'},
  fromRole(roleOf('editor')),
  fromRole(roleOf('admin'),'Všechna oprávnění, která existují teď, jako pevný seznam: později přidaná už ne. Bez správy přístupu.'),
  ...custom.map(r=>fromRole(roleOf(r.id,custom))),
  {id:'full',name:'Plný přístup (agent)',description:'Všechna oprávnění, která existují teď, i ta, která později přidá plugin. Ke správě uživatelů, rolí, klíčů a zařízení se klíč nedostane nikdy.',scopes:[ALL_SCOPES],wildcard:true,warn:true},
 ];
}
