// Service-account scopes: which API key may call which endpoint. One registry for the HTTP API and
// the MCP tools, so a scope always means the same thing. Core defines its scopes below; a plugin adds
// its own through its module definition (server/plugins.mjs), never by editing this file. Which scope
// a route needs is declared on the route. Admin routes (users, keys, accounts) and device-token
// minting are never reachable with an API key, whatever its scopes.

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
export const writesWith=scopes=>scopes.some(s=>!SCOPES[s]?.readOnly);

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

export function validScopes(input){
 const ids=scopeIds();
 if(!Array.isArray(input)||input.length>ids.length||input.some(s=>typeof s!=='string'||!SCOPES[s]))throw new Error('invalid');
 return ids.filter(s=>s==='read'||input.includes(s));
}
