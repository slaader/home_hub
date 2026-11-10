// Site configuration: everything that describes one particular household (its name, LAN, machines,
// inventory vocabulary, seed projects). Core code never hardcodes any of it; it reads this module.
//   local/site.json            the real file (private overlay, not part of the public export)
//   config/site.example.json   a generic example to copy
//   HOME_HUB_SITE_CONFIG       another path (tests, a second instance); "none" = no file
// A missing file is fine: the hub runs empty and generic. A file that is present but wrong is a loud
// start-up error, never a silent fallback. Plugins keep their own settings under "plugins".<id>.
import {readFileSync,existsSync} from 'node:fs';
import path from 'node:path';
import {repoRoot} from './edition.mjs';

const MACHINE_ID=/^[a-z][a-z0-9_-]{1,31}$/;
export const MACHINE_ROLES=Object.freeze(['computer','nas','router','other']);
export const SSH_PROBES=Object.freeze(['mac','nas']);
export const LANGUAGES=Object.freeze(['en','cs']);
const fail=message=>{throw new Error(`site config: ${message}`);};
const plain=v=>v&&typeof v==='object'&&!Array.isArray(v);
const keys=(v,allowed,where)=>{if(!plain(v))fail(`${where} must be an object`);const extra=Object.keys(v).filter(k=>!allowed.includes(k));if(extra.length)fail(`${where} has unknown field(s): ${extra.join(', ')}`);return v;};
const str=(v,max,where,{empty=true}={})=>{if(typeof v!=='string'||v.length>max||/[\u0000-\u001f\u007f]/.test(v)||(!empty&&!v.trim()))fail(`${where} must be a string of at most ${max} characters`);return v;};
const list=(v,max,where)=>{if(!Array.isArray(v)||v.length>max)fail(`${where} must be a list of at most ${max} items`);return v;};

// --- IPv4 and CIDR ---------------------------------------------------------------------------
export function ipv4(text){
 const m=/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(typeof text==='string'?text:'');if(!m)return null;
 const parts=m.slice(1).map(Number);if(parts.some((p,i)=>p>255||String(p)!==m[i+1]))return null;
 return ((parts[0]<<24)|(parts[1]<<16)|(parts[2]<<8)|parts[3])>>>0;
}
export function parseCidr(text){
 const m=/^([0-9.]+)\/(\d{1,2})$/.exec(typeof text==='string'?text:'');if(!m)return null;
 const base=ipv4(m[1]),bits=Number(m[2]);if(base===null||bits>32)return null;
 const mask=bits===0?0:(0xffffffff<<(32-bits))>>>0;
 if(((base&mask)>>>0)!==base)return null; // must be the network address, e.g. 10.0.0.0/24
 return {base,bits,mask,text:`${m[1]}/${bits}`};
}
// True when ip is a usable host address inside one of the networks (the network and broadcast
// addresses are excluded). With no networks configured every well-formed IPv4 address passes.
export function inCidrs(ip,cidrs){
 const n=ipv4(ip);if(n===null)return false;if(!cidrs?.length)return true;
 return cidrs.some(c=>{const net=typeof c==='string'?parseCidr(c):c;if(!net||((n&net.mask)>>>0)!==net.base)return false;
  if(net.bits>=31)return true;const host=(n&~net.mask)>>>0,last=(~net.mask)>>>0;return host!==0&&host!==last;});
}

// --- validation ------------------------------------------------------------------------------
function machine(raw,i){
 const where=`machines[${i}]`;keys(raw,['id','name','hostname','ip','role','picture','thermoId','hardware','ssh','stack'],where);
 if(typeof raw.id!=='string'||!MACHINE_ID.test(raw.id))fail(`${where}.id must match ${MACHINE_ID}`);
 const role=raw.role??'computer';if(!MACHINE_ROLES.includes(role))fail(`${where}.role must be one of ${MACHINE_ROLES.join(', ')}`);
 const ip=raw.ip??'';if(ip!==''&&ipv4(ip)===null)fail(`${where}.ip must be an IPv4 address`);
 const picture=raw.picture??null;if(picture!==null&&!/^\/(images|plugins)\/[A-Za-z0-9._/-]{1,120}$/.test(picture))fail(`${where}.picture must be a path under /images/ or /plugins/`);
 const thermoId=raw.thermoId??null;if(thermoId!==null&&(typeof thermoId!=='string'||!MACHINE_ID.test(thermoId)))fail(`${where}.thermoId must be a machine-style id`);
 let hardware={};if(raw.hardware!==undefined){keys(raw.hardware,['cpu','gpu','ramGb','diskTotalBytes','pools','wifi'],`${where}.hardware`);
  for(const [k,v] of Object.entries(raw.hardware)){if(['cpu','gpu','wifi'].includes(k))str(v,80,`${where}.hardware.${k}`);else if(v!==null&&(typeof v!=='number'||!Number.isFinite(v)||v<0))fail(`${where}.hardware.${k} must be a number or null`);}
  hardware={...raw.hardware};}
 let ssh=null;if(raw.ssh!==undefined&&raw.ssh!==null){keys(raw.ssh,['alias','probe','keys'],`${where}.ssh`);
  if(typeof raw.ssh.alias!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/.test(raw.ssh.alias))fail(`${where}.ssh.alias must be an ssh host alias, or "local"`);
  const probe=raw.ssh.probe??null;if(probe!==null&&!SSH_PROBES.includes(probe))fail(`${where}.ssh.probe must be one of ${SSH_PROBES.join(', ')}`);
  if(raw.ssh.keys!==undefined&&typeof raw.ssh.keys!=='boolean')fail(`${where}.ssh.keys must be true or false`);
  ssh={alias:raw.ssh.alias,probe,keys:raw.ssh.keys!==false};}
 let stack=null;if(raw.stack!==undefined&&raw.stack!==null){if(!plain(raw.stack)||!Array.isArray(raw.stack.layers)||!Array.isArray(raw.stack.cols)||!Array.isArray(raw.stack.blocks))fail(`${where}.stack needs layers, cols and blocks`);stack=raw.stack;}
 return {id:raw.id,name:str(raw.name??raw.id,60,`${where}.name`,{empty:false}),hostname:str(raw.hostname??'',253,`${where}.hostname`),ip,role,picture,thermoId,hardware,ssh,stack};
}
export function validateSite(raw={}){
 keys(raw,['$comment','siteName','lanCidrs','timeZone','defaultLanguage','publicOrigin','machines','inventory','tracker','security','router','strings','plugins'],'the file');
 const lanCidrs=list(raw.lanCidrs??[],16,'lanCidrs').map((c,i)=>parseCidr(c)?.text??fail(`lanCidrs[${i}] must be an IPv4 network such as 10.0.0.0/24`));
 const timeZone=raw.timeZone??null;
 if(timeZone!==null){try{new Intl.DateTimeFormat('en',{timeZone});}catch{fail('timeZone must be an IANA zone such as Europe/Berlin, or null');}}
 const defaultLanguage=raw.defaultLanguage??'en';if(!LANGUAGES.includes(defaultLanguage))fail(`defaultLanguage must be one of ${LANGUAGES.join(', ')}`);
 let publicOrigin=raw.publicOrigin??null;
 if(publicOrigin!==null){let url;try{url=new URL(publicOrigin);}catch{fail('publicOrigin must be an http(s) origin');}if(!['http:','https:'].includes(url.protocol)||url.origin!==publicOrigin)fail('publicOrigin must be a bare origin such as https://hub.example.lan');}
 const machines=list(raw.machines??[],50,'machines').map(machine);
 const ids=machines.map(m=>m.id);if(new Set(ids).size!==ids.length)fail('machines have duplicate ids');
 const inv=keys(raw.inventory??{},['places','secretStores'],'inventory');
 // A place is where inventory entries live (a machine id, or something like a work laptop). On the map:
 // column = it gets a column of its own with this heading; lane = it shares the Network or Outside column;
 // short = the tag shown on its cards when the map is grouped by category. Order = column and sort order.
 const places=list(inv.places??[],100,'inventory.places').map((p,i)=>{const where=`inventory.places[${i}]`;keys(p,['id','label','short','column','lane'],where);
  if(p.lane!==undefined&&!['net','outside'].includes(p.lane))fail(`${where}.lane must be "net" or "outside"`);
  return {id:str(p.id,64,`${where}.id`,{empty:false}),label:str(p.label,80,`${where}.label`,{empty:false}),...(p.short?{short:str(p.short,30,`${where}.short`)}:{}),...(p.column?{column:str(p.column,60,`${where}.column`)}:{}),...(p.lane?{lane:p.lane}:{})};});
 const secretStores=list(inv.secretStores??[],40,'inventory.secretStores').map((s,i)=>{if(typeof s!=='string'||!/^[a-z][a-z0-9-]{0,39}$/.test(s))fail(`inventory.secretStores[${i}] must be a lowercase name`);return s;});
 const tracker=keys(raw.tracker??{},['projects'],'tracker');
 const projects=list(tracker.projects??[],50,'tracker.projects').map((p,i)=>{keys(p,['id','key','name','type'],`tracker.projects[${i}]`);
  if(typeof p.id!=='string'||!/^[a-z][a-z0-9-]{1,39}$/.test(p.id)||typeof p.key!=='string'||!/^[A-Z][A-Z0-9]{1,9}$/.test(p.key))fail(`tracker.projects[${i}] needs an id (a-z, 0-9, -) and a KEY`);
  if(p.type!==undefined&&p.type!==null&&!['app','game','other'].includes(p.type))fail(`tracker.projects[${i}].type must be app, game or other`);
  return {id:p.id,key:p.key,name:str(p.name??p.id,80,`tracker.projects[${i}].name`,{empty:false}),...(p.type?{type:p.type}:{})};});
 const security=keys(raw.security??{},['gitHost','gitUrl','certificates','order'],'security');
 const certificates=list(security.certificates??[],20,'security.certificates').map((c,i)=>{keys(c,['match','label'],`security.certificates[${i}]`);try{new RegExp(c.match);}catch{fail(`security.certificates[${i}].match must be a regular expression`);}return {match:str(c.match,200,`security.certificates[${i}].match`,{empty:false}),label:str(c.label,120,`security.certificates[${i}].label`,{empty:false})};});
 const order=list(security.order??[],50,'security.order').map((id,i)=>ids.includes(id)?id:fail(`security.order[${i}] is not a machine id`));
 // The router feed (server/router-data.mjs): adapter = "unifi" (included) or the id of an adapter a plugin provides;
 // host = the gateway the included collector reads (default: the machine with role "router"); site = its UniFi site name.
 let router=null;if(raw.router!==undefined&&raw.router!==null){keys(raw.router,['adapter','host','site'],'router');
  if(typeof raw.router.adapter!=='string'||!/^[a-z][a-z0-9-]{1,31}$/.test(raw.router.adapter))fail('router.adapter must be an adapter id such as "unifi"');
  const host=raw.router.host??null;if(host!==null&&(typeof host!=='string'||!/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(host)))fail('router.host must be an IPv4 address or a host name');
  const name=raw.router.site??null;if(name!==null&&(typeof name!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(name)))fail('router.site must be a UniFi site name such as "default"');
  router={adapter:raw.router.adapter,host,site:name};}
 if(raw.plugins!==undefined&&!plain(raw.plugins))fail('plugins must be an object keyed by plugin id');
 // Translations of the site's own labels (the UI's source language is Czech): {"en": {"source text": "translation"}}.
 const strings={};
 for(const [lang,dict] of Object.entries(raw.strings??{})){if(!LANGUAGES.includes(lang)||!plain(dict)||Object.values(dict).some(v=>typeof v!=='string'))fail(`strings.${lang} must map source text to a translation`);strings[lang]={...dict};}
 return deepFreeze({siteName:str(raw.siteName??'',60,'siteName'),lanCidrs,timeZone,defaultLanguage,publicOrigin,machines,
  inventory:{places,secretStores},tracker:{projects},
  security:{gitHost:security.gitHost?str(security.gitHost,253,'security.gitHost'):null,gitUrl:security.gitUrl?str(security.gitUrl,300,'security.gitUrl'):null,certificates,order},
  router,strings,plugins:raw.plugins??{}});
}
function deepFreeze(v){if(v&&typeof v==='object'&&!Object.isFrozen(v)){Object.freeze(v);for(const x of Object.values(v))deepFreeze(x);}return v;}
export const EMPTY_SITE=validateSite({});

// --- loading ---------------------------------------------------------------------------------
export const siteConfigPath=(env=process.env,root=repoRoot)=>env.HOME_HUB_SITE_CONFIG==='none'?null:env.HOME_HUB_SITE_CONFIG?path.resolve(env.HOME_HUB_SITE_CONFIG):path.join(root,'local','site.json');
export function loadSite({file=siteConfigPath()}={}){
 if(!file)return EMPTY_SITE;
 let text;try{text=readFileSync(file,'utf8');}catch(e){if(e.code==='ENOENT')return EMPTY_SITE;throw new Error(`site config: cannot read ${file}: ${e.message}`);}
 let raw;try{raw=JSON.parse(text);}catch(e){throw new Error(`site config: ${file} is not valid JSON: ${e.message}`);}
 return validateSite(raw);
}
let cached=null;
// The process-wide site (read once). Code that can take a site as an argument should; tests pass their own.
export const site=()=>cached??(cached=loadSite());

// --- derived views ---------------------------------------------------------------------------
export const machineIds=s=>s.machines.map(m=>m.id);
// What the overview tile and the collectors call this machine: thermo = live Thermo telemetry.
export const machineKind=m=>m.thermoId?'thermo':m.role==='nas'?'nas':m.role==='router'?'router':'other';
export const thermoMachineIds=s=>s.machines.filter(m=>m.thermoId).map(m=>m.id);
export const inLan=(s,ip)=>inCidrs(ip,s.lanCidrs);
// id → ssh alias for the collectors ("local" runs the probe on this machine).
export const sshHosts=(s,pick=()=>true)=>new Map(s.machines.filter(m=>m.ssh&&pick(m)).map(m=>[m.id,m.ssh.alias]));
// What the browser may know before and after sign-in (GET /api/ui/manifest).
export const publicSite=s=>({name:s.siteName,timeZone:s.timeZone,defaultLanguage:s.defaultLanguage,lanCidrs:[...s.lanCidrs]});
// The software watch list (versions to follow per machine): SOFTWARE_WATCH_FILE, else the site's own
// local/software-watch.json, else the generic example shipped in config/.
export function softwareWatchPath(env=process.env,root=repoRoot){
 if(env.SOFTWARE_WATCH_FILE)return path.resolve(env.SOFTWARE_WATCH_FILE);
 const own=path.join(root,'local','software-watch.json');
 return existsSync(own)?own:path.join(root,'config','software-watch.json');
}
