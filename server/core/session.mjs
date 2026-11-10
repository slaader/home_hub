// Core module "core": sign-in and sign-out, who am I, the UI manifest the shell draws itself from,
// own-account settings, and the shell's static files. It also owns the core scopes.
import {CORE_SCOPES} from '../scopes.mjs';
import {publicSite} from '../site-config.mjs';
import {validHomeOrder,homeOrder} from '../home-data.mjs';

const passwordMisses=new WeakMap(); // hub → Map(principal id → {count, at})
const missesOf=hub=>{if(!passwordMisses.has(hub))passwordMisses.set(hub,new Map());return passwordMisses.get(hub);};
// Signed in: the registry's pages and sidebar, the inventory vocabulary of the site, and translations
// (plugins' strings, then the site's own on top).
function manifestFor(principal,hub){
 const m=hub.registry.manifest(principal),strings={...m.strings};
 for(const [lang,dict] of Object.entries(hub.site.strings))strings[lang]={...strings[lang],...dict};
 return {...m,strings,inventory:hub.site.inventory};
}
const SHELL=['app.js','views.js','ui.js','site.js','access.js','session-cache.js','settings-view.js','i18n.js','i18n-en.js','i18n-en-shell.js','i18n-en-home.js','i18n-en-security.js','i18n-en-systems.js','i18n-en-access.js','i18n-en-inventory.js','i18n-en-server.js',
 'tokens.css','hub.css','settings.css','favicon.svg','images/apple-touch-icon.png','images/icon-192.png','images/icon-512.png','images/desktop.png','images/laptop.png','images/nas.png'];

export default {
 id:'core',title:'Home Hub',
 scopes:CORE_SCOPES,
 assets:[{path:'index.html',url:'/'},...SHELL,{path:'images/apple-touch-icon.png',url:'/apple-touch-icon.png'}],
 nav:[{hash:'settings',labelKey:'Nastavení',view:'settings-view.js#settingsPage',hidden:true}],
 routes:[
  {method:'POST',path:'/api/session',scope:null,public:true,write:false,async handler({req,res,input,json,error,hub}){
    const result=await hub.auth.login(input?.username,input?.password,req.socket.remoteAddress);
    if(result.cookie)res.setHeader('Set-Cookie',result.cookie);
    return result.status===200?json(200,{ok:true}):error(result.status,'LOGIN_FAILED',result.status===429?'Too many attempts. Try again in 15 minutes.':'Username or password is incorrect.');}},
  {method:'POST',path:'/api/logout',scope:'read',public:true,parse:false,handler({req,res,json,hub}){res.setHeader('Set-Cookie',hub.auth.logout(req.headers.cookie));return json(200,{ok:true});}},
  {method:'GET',path:'/api/me',handler:({principal,canWrite,canAdmin,json,hub})=>json(200,{id:principal.id,username:principal.username,name:principal.name||principal.username,role:principal.role,authKind:principal.authKind,canWrite,canAdmin,build:hub.build})},
  // What the shell needs to draw itself. Signed out: only what the sign-in screen shows (site name,
  // default language). Signed in: the pages this caller may open, the sidebar, and plugin strings.
  {method:'GET',path:'/api/ui/manifest',public:true,handler:({principal,json,hub})=>json(200,{site:publicSite(hub.site),edition:hub.edition,signedIn:Boolean(principal),
    ...(principal?manifestFor(principal,hub):{pages:[],nav:[],modules:[],strings:{}})})},
  // The installable-app manifest carries the site's name, so it is built here, not kept as a file.
  {method:'GET',path:'/manifest.webmanifest',public:true,handler({res,hub}){
    const name=hub.site.siteName?`Home Hub · ${hub.site.siteName}`:'Home Hub';
    res.writeHead(200,{'Content-Type':'application/manifest+json; charset=utf-8'});
    res.end(JSON.stringify({name,short_name:'Home Hub',description:hub.site.siteName?`Devices, services and local AI on the ${hub.site.siteName} home network.`:'Devices and services on your home network.',
     start_url:'/#overview',scope:'/',display:'standalone',background_color:'#141816',theme_color:'#141816',
     icons:[{src:'/images/icon-192.png',sizes:'192x192',type:'image/png',purpose:'any maskable'},{src:'/images/icon-512.png',sizes:'512x512',type:'image/png',purpose:'any maskable'}]},null,2)+'\n');}},
  // Own overview tile order (Přehled → Upravit pořadí): per account, password sign-in only, read-only
  // viewers included. Ids are checked against the known machines; [] goes back to the default order.
  {method:'GET',path:'/api/profile/home-order',scope:null,async handler({principal,json,error,hub}){
    if(principal.authKind!=='session')return error(403,'SESSION_REQUIRED','Pořadí strojů se ukládá jen po přihlášení heslem.');
    const saved=hub.accessStore.homeOrder(principal.id),known=await hub.state('home').machineIds();return json(200,{order:homeOrder(saved,known),saved:Boolean(saved),known});}},
  {method:'POST',path:'/api/profile/home-order',scope:null,write:false,async handler({principal,input,json,error,hub}){
    if(principal.authKind!=='session')return error(403,'SESSION_REQUIRED','Pořadí strojů se ukládá jen po přihlášení heslem.');
    const machineIds=hub.state('home').machineIds;
    let order;try{if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>k!=='order'))throw new Error('invalid');order=validHomeOrder(input.order,await machineIds());}
    catch{return error(400,'INVALID_ORDER','Neplatné pořadí: jen známé stroje, každý nejvýš jednou.');}
    try{const saved=await hub.accessStore.setHomeOrder(principal.id,order);return json(200,{order:homeOrder(saved,await machineIds()),saved:Boolean(saved)});}
    catch(e){if(e.message==='not-found')return error(404,'NOT_FOUND','Účet už neexistuje.');throw e;}}},
  // Own password change (Nastavení): password sign-in only, the current password is required, five
  // wrong tries per account lock it for 15 minutes. Other sessions end; the caller gets a fresh cookie.
  {method:'POST',path:'/api/profile/password',scope:null,write:false,async handler({req,res,principal,input,json,error,hub}){
    if(principal.authKind!=='session')return error(403,'SESSION_REQUIRED','Heslo se mění jen po přihlášení heslem.');
    // The attempt is reserved synchronously, before any await, so parallel requests cannot all
    // read the same count and slip past the limit; it is given back only if the current
    // password was not actually tried (invalid input, unknown account, unsupported).
    const misses=missesOf(hub);
    let miss=misses.get(principal.id);if(!miss||Date.now()-miss.at>=900000)miss={count:0,at:Date.now()};
    if(miss.count>=5)return error(429,'TOO_MANY_ATTEMPTS','Příliš mnoho pokusů. Zkus to znovu za 15 minut.');
    miss.count++;miss.at=Date.now();misses.set(principal.id,miss);
    try{
     const user=await hub.accessStore.changePassword(principal.id,input);if(misses.get(principal.id)===miss)misses.delete(principal.id);
     const fresh=await hub.auth.login(user.username,input.newPassword,req.socket.remoteAddress);if(fresh.cookie)res.setHeader('Set-Cookie',fresh.cookie);
     return json(200,{ok:true,signedIn:Boolean(fresh.cookie),user:{username:user.username,role:user.role,passwordAt:user.passwordAt}});
    }catch(e){
     if(e.message==='wrong-password')return error(403,'WRONG_PASSWORD','Současné heslo nesouhlasí.');
     miss.count=Math.max(0,miss.count-1);
     if(e.message==='superseded')return error(409,'PASSWORD_CHANGED','Heslo se mezitím změnilo. Přihlas se znovu a zkus to s aktuálním heslem.');
     if(e.message==='invalid')return error(400,'INVALID_PASSWORD','Nové heslo musí mít 12 až 256 znaků a lišit se od současného.');
     if(e.message==='unsupported')return error(501,'UNSUPPORTED','Tento server neví, kam heslo správce uložit (chybí cesta k souboru s přihlášením).');
     if(e.message==='not-found')return error(404,'NOT_FOUND','Účet už neexistuje.');
     throw e;
    }}},
 ],
};
