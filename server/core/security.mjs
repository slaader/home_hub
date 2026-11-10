// Core module "security": the SSH key inventory, OS/software versions with host protection, and the
// software watch list the versions page follows.
// The first two are snapshots written by collectors (scripts/collect-security.mjs, scripts/collect-systems.mjs),
// which read the machines to probe from the site configuration. They show open ports and weak spots,
// so only administrators (or a key holding security:read) may read them. Each answer says where its
// collector stands (collector: not-configured, waiting, stale or ok), with or without a snapshot.
// The watch list (server/software-watch.mjs) is the one thing here that is written: by an administrator
// in the browser or by a key holding software:write, over HTTP or the MCP tools below.
import path from 'node:path';
import {loadSecurity,securitySetup} from '../security-data.mjs';
import {loadSystems,systemsSetup} from '../systems-data.mjs';
import {createWatchStore,describeWatch,isWatchError,watchPath,DETECT_KINDS,UPSTREAM_TYPES,CMD_ARGS,VERSION_SCHEMES} from '../software-watch.mjs';
import {toolError} from '../mcp.mjs';
import {readRouterFor} from '../router-data.mjs';
import {provenance,collectorSource} from '../provenance.mjs';
import {readRun} from '../collector-run.mjs';

// The pipeline has already checked the route's scope (security:read) for keys, people and devices alike; this
// is the same rule once more at the door: administrators, and any role or key that holds security:read.
const adminOnly=(c,message)=>{if(c.principal.role==='admin'||c.principal.authKind==='api-key'||c.principal.scopes?.includes('security:read'))return false;c.error(403,'ADMIN_REQUIRED',message);return true;};
// The state of one collector as /api/collectors gives it: the fields of collector-state.mjs, nothing of the snapshot.
const collectorFacts=({state,configured,collectedAt,ageSeconds,intervalSeconds,staleAfterSeconds,script})=>({state,configured,collectedAt,ageSeconds,intervalSeconds,staleAfterSeconds,script});
// Detect rules run on machines probed with the macOS probe; the NAS probe discovers its apps by itself.
const watchMachines=site=>site.machines.filter(m=>m.ssh?.probe==='mac').map(m=>({id:m.id,name:m.name}));
const fileLabel=(file,root)=>{if(!file)return null;const rel=path.relative(root,file);return rel&&!rel.startsWith('..')&&!path.isAbsolute(rel)?rel:path.basename(file);};
async function watchList(state,hub){
 return {...describeWatch(await state.watch.read(),{machines:watchMachines(hub.site)}),file:fileLabel(state.watch.file,hub.root),writable:Boolean(state.watch.file),example:'config/software-watch.json',
  next:'A change shows on the versions page after the next run of node scripts/check-upstream.mjs and node scripts/collect-systems.mjs (or their scheduled jobs).'};
}
const WATCH_MESSAGES={invalid:'The change was rejected as invalid; nothing was saved.',conflict:'The item changed since you read it, already exists, or base is missing. Read the list again and pass the hash of the item as base (omit base only to create a new item).',
 'not-found':'No watched item with that id.',limit:'A limit of the watch list was reached; nothing was saved.',
 unavailable:'This Home Hub runs without a site overlay, so it has no file to keep a watch list in. Create local/site.json (or set SOFTWARE_WATCH_FILE) and restart.'};
const watchError=e=>isWatchError(e)?[({invalid:422,conflict:409,'not-found':404,limit:409,unavailable:409})[e.code]||400,`SOFTWARE_WATCH_${e.code.replace('-','_').toUpperCase()}`,WATCH_MESSAGES[e.code]||'The watch list cannot be changed.']:null;

const text=(maxLength,description)=>({type:'string',maxLength,...(description?{description}:{})});
const UPSTREAM_SCHEMA={type:'object',required:['type'],additionalProperties:false,
 description:'Where the newest version is read. github or codeberg: {type, repo: "owner/name", tagPrefix?, tagPattern?, allowPrerelease?}; pypi: {type, package}; npm: {type, package, tag?}; brew-formula or brew-cask: {type, name}; node: {type}; none: {type, note?} for software without a release feed.',
 properties:{type:{type:'string',enum:UPSTREAM_TYPES.filter(t=>t!=='thermo-feed')},repo:text(201),package:text(201),name:text(80),tag:text(40),tagPrefix:text(40),tagPattern:text(200,'Only tags matching this regular expression count, e.g. ^v?\\d+\\.\\d+\\.\\d+$'),allowPrerelease:{type:'boolean'},note:text(300)}};
const DETECT_SCHEMA={type:'object',required:['kind'],additionalProperties:false,
 description:`How the installed version is read on one machine. brew: {kind, formula}; cask: {kind, cask}; app: {kind, path: "/Applications/Name.app"}; cmd: {kind, path, args, match?} runs the binary with one version flag (${CMD_ARGS.join(', ')}) and reads the first version in its output, * in path matches several installs; pydist: {kind, glob, package} reads a Python dist-info in the site-packages directories glob matches; json: {kind, path, key?} reads a version field of a JSON file. Paths are absolute or start with ~/. This is data for a read-only probe, never a shell command.`,
 properties:{kind:{type:'string',enum:[...DETECT_KINDS]},formula:text(323),cask:text(80),path:text(300),args:{type:'string',enum:[...CMD_ARGS]},match:text(200,'Regular expression; its first group is the version.'),glob:text(300),package:text(100),key:text(60),
  launchd:text(127,'launchd label of the job that runs it (system/<label> for a daemon); shows whether it is running.'),upstream:UPSTREAM_SCHEMA,
  source:{type:'object',required:['label'],additionalProperties:false,properties:{label:text(120,'Where it was installed from, e.g. "Homebrew" or "vendor installer".'),url:{type:['string','null'],maxLength:300}}},
  inventory:{type:'array',maxItems:10,items:text(64),description:'Inventory entry ids this install is, when the inventory map cannot match it by name.'}}};
const ITEM_SCHEMA={type:'object',required:['id','name','category','upstream','detect'],additionalProperties:false,
 properties:{id:{type:'string',pattern:'^[a-z0-9][a-z0-9._-]{0,39}$',description:'Stable id, e.g. node or llama.cpp.'},name:{type:'string',minLength:1,maxLength:80},category:{type:'string',pattern:'^[a-z][a-z0-9-]{0,29}$',description:'An existing category id, or a new one passed in categories.'},
  scheme:{type:'string',enum:[...VERSION_SCHEMES],description:'Special version comparison: node (LTS lines) or llamacpp (build numbers before semver). Leave out otherwise.'},match:text(200),upstream:UPSTREAM_SCHEMA,
  detect:{type:'object',minProperties:1,additionalProperties:DETECT_SCHEMA,description:'One rule per machine id (see machines in software_watch_list).'}}};

export default {
 id:'security',title:'Security',
 mcpInstructions:[{scope:'software:write',text:'Software watch (the programs whose installed and newest versions the versions page compares): software_watch_list returns the items with a hash each and what a rule may contain. software_watch_put adds an item, or replaces or removes one given its hash as base. A detect rule is data for a read-only probe, never a command.'}],
 assets:['security-view.js','systems-view.js','security.css','systems.css'],
 nav:[
  {groupKey:'Inventář',hash:'versions',labelKey:'Verze a aktualizace',view:'systems-view.js#systemsPage',admin:true,scope:'security:read',order:21},
  {groupKey:'Bezpečnost',hash:'security',labelKey:'SSH klíče',view:'security-view.js#securityPage',admin:true,scope:'security:read',order:30},
  {groupKey:'Bezpečnost',hash:'hardening',labelKey:'Ochrana strojů',view:'systems-view.js#systemsPage',admin:true,scope:'security:read',order:31},
 ],
 // options.softwareWatchFile: another list file (tests); otherwise SOFTWARE_WATCH_FILE or local/software-watch.json.
 setup:hub=>({watch:createWatchStore({file:hub.options.softwareWatchFile||watchPath(),machines:()=>watchMachines(hub.site).map(m=>m.id)})}),
 routes:[
  {method:'GET',path:'/api/security',scope:'security:read',async handler(c){
    if(adminOnly(c,'Only an administrator can see the security inventory.'))return;
    const doc=await loadSecurity(c.hub.directory);
    // provenance (server/provenance.mjs): the collector, when it last ran, from where and who started it.
    const collector=securitySetup(c.hub.site,{collectedAt:doc?.collectedAt||null});
    if(!doc)return c.json(404,{error:{code:'SECURITY_MISSING',message:'No SSH key inventory yet. Run node scripts/collect-security.mjs.'},collector,provenance:provenance([collectorSource(collector,{id:'security'})])});
    return c.json(200,{...doc,collector,provenance:provenance([collectorSource(collector,{id:'security',run:readRun(doc.run),host:doc.collectedFrom,count:doc.machines.filter(m=>m.reachable).length,unit:'machines'})])});}},
  {method:'GET',path:'/api/systems',scope:'security:read',async handler(c){
    if(adminOnly(c,'Only an administrator can see machine versions and protection.'))return;
    const doc=await loadSystems(c.hub.directory,{site:c.hub.site,registryFile:c.state.watch.file});
    if(doc)return c.json(200,doc);
    const collector=systemsSetup(c.hub.site);
    return c.json(404,{error:{code:'SYSTEMS_MISSING',message:'No machine snapshot yet. Run node scripts/collect-systems.mjs.'},collector,provenance:provenance([collectorSource(collector,{id:'systems'})])});}},
  // Where each collector stands, without its snapshot. Always 200, also on a hub where nothing has been
  // collected: /api/systems and /api/security answer 404 there, so a screen that only wants to know
  // whether anything arrived (the getting-started checklist) asks here and leaves the console quiet.
  {method:'GET',path:'/api/collectors',scope:'security:read',async handler(c){
    if(adminOnly(c,'Only an administrator can see the state of the collectors.'))return;
    const {hub}=c,site=hub.site;
    const [systems,keys,router]=await Promise.all([
     loadSystems(hub.directory,{site,registryFile:c.state.watch.file}).catch(()=>null),loadSecurity(hub.directory).catch(()=>null),readRouterFor(hub).catch(()=>null)]);
    const {upstream=null,...current}=systems?.collector||systemsSetup(site);
    return c.json(200,{schemaVersion:1,generatedAt:new Date().toISOString(),collectors:{
     systems:collectorFacts(current),...(upstream?{upstream:collectorFacts(upstream)}:{}),
     security:collectorFacts(securitySetup(site,{collectedAt:keys?.collectedAt||null})),
     router:{state:router?.status||'unavailable',collectedAt:router?.observedAt||null}}});}},
  {method:'GET',path:'/api/software-watch',scope:'software:write',async handler(c){
    if(adminOnly(c,'Only an administrator can see the software watch list.'))return;
    const list=await watchList(c.state,c.hub);
    return c.json(200,{...list,provenance:provenance(list.source==='local'?[{kind:'config',id:'watch',source:list.file,count:list.items.length,unit:'items'}]:[])});}},
  {method:'POST',path:'/api/software-watch',scope:'software:write',bodyLimit:32768,
   error:(e,c)=>{const mapped=watchError(e);if(mapped&&e.details?.length){c.json(mapped[0],{error:{code:mapped[1],message:mapped[2],details:e.details}});return null;}return mapped;},
   async handler(c){
    if(adminOnly(c,'Only an administrator can change the software watch list.'))return;
    c.subject=null;
    let result;
    try{result=await c.state.watch.put(c.input);}
    catch(e){const mapped=watchError(e);if(!mapped)throw e;return c.json(mapped[0],{error:{code:mapped[1],message:mapped[2],...(e.details?.length?{details:e.details}:{})}});}
    c.subject=result.id||null;
    return c.json(result.created?201:200,result);}},
 ],
 mcpTools:[
  {name:'software_watch_list',scope:'software:write',title:'Software watch: read the list',
   description:'The software watch list of this Home Hub: the programs whose installed and newest versions the versions page compares. Returns the categories, every item with its hash (needed to change or remove it), the machine ids a detect rule may name, and the allowed detect kinds, upstream types and version flags. source "none" means no list exists yet: the first software_watch_put creates it.',
   inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,openWorldHint:false},
   run:(args,{state,hub})=>watchList(state,hub)},
  {name:'software_watch_put',scope:'software:write',title:'Software watch: add, replace or remove an item',
   description:'Change the software watch list by one item. To add a program pass item without base. To change one, read it with software_watch_list, edit it and pass its hash as base; if it changed in between the call is refused and you must read the list again. To delete one pass remove (its id) and base. categories {"id": "Label"} adds or renames categories, alone or together with an item. An item has one upstream (where the newest version is read) and one detect rule per machine (how the installed version is read there). Detect rules are data for a read-only probe: paths, package names and one fixed version flag; no shell commands, and nothing is installed or changed on the machines.',
   inputSchema:{type:'object',additionalProperties:false,properties:{item:ITEM_SCHEMA,base:{type:'string',pattern:'^[a-f0-9]{64}$',description:'The hash of the item from software_watch_list. Required to replace or remove.'},
    remove:{type:'string',pattern:'^[a-z0-9][a-z0-9._-]{0,39}$',description:'Id of the item to delete (with base).'},
    categories:{type:'object',maxProperties:20,additionalProperties:{type:'string',minLength:1,maxLength:60},description:'Category id → label to add or rename.'}}},
   annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false},
   async run(args,{state,hub}){
    try{return {...await state.watch.put(args),file:fileLabel(state.watch.file,hub.root)};}
    catch(e){if(!isWatchError(e))throw e;throw toolError(`${WATCH_MESSAGES[e.code]||'The watch list cannot be changed.'}${e.details?.length?` ${e.details.join('; ')}`:''}`);}}},
 ],
 apiDocs:[{title:'Bezpečnost',routes:[
  ['GET','/api/systems','security','Verze systémů a softwaru, kandidáti na aktualizaci a ochrana strojů (snímek z collect-systems).'],
  ['GET','/api/collectors','security','Stav kolektorů (verze, upstream, SSH klíče, router) bez jejich dat; odpoví vždy 200.'],
  ['GET','/api/software-watch','software:write','Seznam sledovaného softwaru s otiskem každé položky.'],
  ['POST','/api/software-watch','software:write','{item, base?} přidá nebo nahradí položku, {remove, base} ji smaže, {categories} přidá kategorie.']]}],
};
