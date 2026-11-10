// Core module "inventory": the inventory page (map, table and the services catalog), all views of one file
// (data/knowledge.json) that is served only when it passes the same checker agents run.
// Writes go through one writer. By default that is the local editor (the file on this machine);
// a plugin may provide another one (extension point inventory.writer → {put(change, by), edit(input)}
// and optionally remove(change) and bulk(change, {by, user})), e.g. a bridge to the machine that owns
// the file. A hub with no file yet is an empty inventory: the first write creates it.
// The vocabulary is the site's (site.json → inventory.places, inventory.secretStores) plus the generic
// built-ins of the rules module (public/inventory-rules.js); nothing here names a household.
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {check,describe} from '../../scripts/check-knowledge.mjs';
import {createKnowledgeEditor,editInput,entryInput,deleteInput,bulkInput,entryHash,emptyDoc,LIMITS} from '../../scripts/knowledge-edit.mjs';
import {toolError} from '../mcp.mjs';
import {inventoryProvenance} from '../provenance.mjs';

const UNSUPPORTED='This hub forwards inventory edits to another machine, and that writer cannot do this yet.';
const servicesError=e=>[({invalid:400,conflict:409,busy:429})[e.message]||503,'INVENTORY_UPDATE_FAILED',e.message==='conflict'?'The entry changed. Read it again before updating.':'Cannot update the service inventory.'];
const inventoryError=e=>[({invalid:400,'not-found':404,conflict:409,busy:429,unsupported:501})[e.message]||503,'INVENTORY_EDIT_FAILED',({invalid:'That edit is not valid.','not-found':'That entry no longer exists.',conflict:'This entry changed since you opened it. Reload and edit again.',busy:'Another edit is being saved. Try again.',unsupported:UNSUPPORTED})[e.message]||'The edit could not be saved. Check that the machine holding the inventory file is reachable.'];
const hashes=entries=>Object.fromEntries(entries.map(e=>[e.id,entryHash(e)]));
const few=(ids,n=20)=>ids.length>n?`${ids.slice(0,n).join(', ')} and ${ids.length-n} more`:ids.join(', ');
// What the checker refused, for a 422 reply: the classic message list plus the structured issues.
const refusal=(message,result)=>({error:{code:'INVENTORY_INVALID',message,details:(result?.errors||[]).map(String).slice(0,10),...(result?.issues?{issues:result.issues}:{})}});
// The service account behind an API key (stamped into verified_by), or null.
const accountOf=principal=>principal.authKind==='api-key'&&principal.accountId?principal.username:null;

// GET: the checked document, or a reply saying why there is none.
async function served(c){
 const r=await c.state.load();
 if(r.missing){c.error(404,'INVENTORY_MISSING','There is no inventory file yet (data/knowledge.json).');return null;}
 if(r.unreadable){c.error(500,'INVENTORY_INVALID','The inventory file is not valid JSON (data/knowledge.json).');return null;}
 if(r.errors.length){c.error(500,'INVENTORY_INVALID',`The inventory file has ${r.errors.length} errors; run node scripts/check-knowledge.mjs.`);return null;}
 return r;
}
async function put(c,runtimeOnly){
 const change=entryInput(c.input);if(runtimeOnly&&change.entry.kind!=='runtime')throw new Error('invalid');
 const result=await c.state.put(change,accountOf(c.principal));
 if(!result?.ok)return c.json(422,refusal('Inventory validation failed.',result));
 return c.json(200,{ok:true,published:result.published,entry:result.entry,hash:result.hash});
}
async function remove(c){
 const change=deleteInput(c.input),result=await c.state.remove(change);
 if(result?.inUse)return c.json(422,{error:{code:'INVENTORY_IN_USE',message:`Other entries still depend on this one or run on it: ${few(result.inUse)}. Change or delete them first.`,details:result.inUse.slice(0,100)}});
 if(!result?.ok)return c.json(422,refusal('The checker rejected this delete.',result));
 return c.json(200,{ok:true,published:result.published,id:change.id,deleted:true});
}
// Bulk upsert. A dry run always answers 200 with what would happen; a real run answers 200, 409 or 422.
async function bulk(c){
 const change=bulkInput(c.input),key=c.principal.authKind==='api-key';
 // Keeping an entry's own verified_at / verified_by is for a person importing an exported file.
 if(change.keepVerified&&key)return c.error(400,'INVENTORY_EDIT_FAILED','keepVerified is for imports in the web UI; an API key always stamps its own writes.');
 c.subject=`${change.entries.length} entries`;
 const result=await c.state.bulk(change,{by:accountOf(c.principal),user:c.principal.authKind==='session'});
 if(result?.conflicts){
  if(change.dryRun)return c.json(200,{ok:false,dryRun:true,conflicts:result.conflicts});
  return c.json(409,{error:{code:'INVENTORY_EDIT_FAILED',message:`Nothing was changed. These entries changed since you read them, or exist already (pass their hash as base): ${few(result.conflicts)}.`,details:result.conflicts.slice(0,100)}});
 }
 if(!result?.ok){
  if(change.dryRun)return c.json(200,{ok:false,dryRun:true,errors:result?.errors||[],errorCount:result?.errorCount??0,issues:result?.issues||[]});
  return c.json(422,refusal('The checker rejected this batch; nothing was changed.',result));
 }
 return c.json(200,{ok:true,...(change.dryRun?{dryRun:true}:{published:result.published}),summary:result.summary,entries:result.results});
}

// --- MCP tools (inventory_search, inventory_get and inventory_update are in server/mcp.mjs) ----
const WRITE_ERRORS={busy:'Another inventory write is in progress; nothing was changed. Try again.',unsupported:UNSUPPORTED+' Nothing was changed.'};
const unavailable=e=>toolError(WRITE_ERRORS[e.message]||'The inventory is not available right now; nothing was changed.');
const known=(args,allowed)=>{const extra=Object.keys(args).filter(k=>!allowed.includes(k));if(extra.length)throw toolError(`Unknown argument(s): ${extra.join(', ')}. Use: ${allowed.join(', ')||'no arguments'}.`);};
const tools=[
 {name:'inventory_describe',scope:'read',title:'Home inventory: schema and rules',
  description:'How to fill the home inventory correctly, as data: the entry fields, the kinds, categories and dependency (link) kinds, the secret stores an entry may point at, the places (machines) entries can live on, the validation rules the checker enforces, the limits and a few example entries. Call it once before writing with inventory_update or inventory_bulk_upsert.',
  inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,openWorldHint:false},
  async run(args,{state,hub}){
   known(args,[]);const doc=await state.read();
   return {...describe(hub.site.inventory,doc?.entries||[]),inventory:{entries:doc?doc.entries.length:null,updatedAt:doc?.updated_at||null}};
  }},
 {name:'inventory_delete',scope:'inventory:write',title:'Home inventory: delete entry',
  description:'Delete one inventory entry. Pass the hash from inventory_get as base; if the entry changed in between, nothing is deleted and you must read it again. An entry that others depend on or run on (inventory_get → dependents) cannot be deleted until they are changed or deleted. Deleting cannot be undone.',
  inputSchema:{type:'object',properties:{
   id:{type:'string',pattern:'^[a-z][a-z0-9-]{0,63}$',description:'Entry id, e.g. server-old-proxy.'},
   base:{type:'string',pattern:'^[a-f0-9]{64}$',description:'Hash from inventory_get.'}},required:['id','base'],additionalProperties:false},
  annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:false},
  async run(args,{state,principal}){
   known(args,['id','base']);
   let change;try{change=deleteInput({id:args.id,base:args.base});}catch{throw toolError('Invalid request: id must be an inventory id and base the 64-character hash from inventory_get.');}
   let result;
   try{result=await state.remove(change);}
   catch(e){
    if(e.message==='not-found')throw toolError(`No inventory entry "${change.id}"; nothing was deleted.`);
    if(e.message==='conflict')throw toolError('The entry changed since you read it; nothing was deleted. Read it again with inventory_get and decide again.');
    throw unavailable(e);
   }
   if(result?.inUse)throw toolError(`Not deleted: these entries still depend on "${change.id}" or run on it: ${few(result.inUse)}. Change or delete them first.`);
   if(!result?.ok)throw toolError(`The inventory checker rejected the result, nothing was changed: ${(result?.errors||[]).map(String).join('; ')||'invalid inventory'}`);
   return {ok:true,id:change.id,deleted:true,published:result.published!==false,by:principal.username};
  }},
 {name:'inventory_bulk_upsert',scope:'inventory:write',title:'Home inventory: create or replace several entries',
  description:`Create or replace up to ${LIMITS.bulkEntries} whole entries in one call (one request is at most 64 kB). All or nothing: the resulting inventory is checked as a whole, so entries may refer to each other (a machine and what runs on it), and if anything is invalid or any hash is stale nothing changes. For each existing entry pass its hash as base; omit base for a new one. An entry identical to the stored one is reported as unchanged. Set dryRun to see what would happen without writing: it returns the planned action per entry, or the checker's errors. Secret values are refused exactly as in inventory_update.`,
  inputSchema:{type:'object',properties:{
   entries:{type:'array',minItems:1,maxItems:LIMITS.bulkEntries,description:'The changes, each a complete entry.',items:{type:'object',properties:{
     entry:{type:'object',description:'The complete entry (id, kind, name, machine, address, version, depends_on, notes, …); see inventory_describe.'},
     base:{type:'string',pattern:'^[a-f0-9]{64}$',description:'Hash from inventory_get or inventory_search. Required when the entry already exists.'}},required:['entry'],additionalProperties:false}},
   dryRun:{type:'boolean',description:'true = check everything and report, write nothing (default false).'}},required:['entries'],additionalProperties:false},
  annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false},
  async run(args,{state,principal}){
   known(args,['entries','dryRun']);
   let change;try{change=bulkInput({entries:args.entries,...(args.dryRun!==undefined?{dryRun:args.dryRun}:{})});}
   catch{throw toolError(`Invalid request: entries must be 1 to ${LIMITS.bulkEntries} items of {entry, base?}; each entry is an object with a valid id (lowercase letters, digits, hyphens) and only known fields, every id at most once; base is a 64-character hash; dryRun is true or false.`);}
   let result;
   try{result=await state.bulk(change,{by:principal.accountId?principal.username:null,user:false});}catch(e){throw unavailable(e);}
   if(result?.conflicts){
    const hint='Read them again (inventory_get) and pass the current hash as base; omit base only for an entry that does not exist yet.';
    if(change.dryRun)return {ok:false,dryRun:true,conflicts:result.conflicts,hint};
    throw toolError(`Nothing was changed. These entries changed since you read them, or exist already: ${few(result.conflicts)}. ${hint}`);
   }
   if(!result?.ok){
    if(change.dryRun)return {ok:false,dryRun:true,errors:result?.errors||[],errorCount:result?.errorCount??0,issues:result?.issues||[]};
    throw toolError(`The inventory checker rejected the batch, nothing was changed: ${(result?.errors||[]).map(String).slice(0,10).join('; ')||'invalid entries'}`);
   }
   return {ok:true,...(change.dryRun?{dryRun:true}:{published:result.published!==false}),summary:result.summary,entries:result.results,by:principal.username};
  }},
];

export default {
 id:'inventory',title:'Inventory',
 mcpInstructions:[
  'Inventory (what runs where and what depends on what): call inventory_describe once for the kinds, fields and rules. Use inventory_search before you add anything, so an entry is updated instead of duplicated. inventory_get returns one entry with its hash and what depends on it.',
  {scope:'inventory:write',text:'With inventory:write: inventory_update writes one whole entry, inventory_bulk_upsert several at once (dryRun first), inventory_delete removes one. Each takes the hash you read as base; omit base only to create.'},
 ],
 assets:['inventory-view.js','inventory-data.js','inventory-entry.js','inventory-table.js','inventory-services.js','inventory-rules.js','inventory-versions.js','inventory.css'],
 nav:[
  {groupKey:'Inventář',hash:'inventory-map',labelKey:'Mapa inventáře',view:'inventory-view.js#inventoryPage',order:20},
  // The services catalog is a view of the inventory page now; its old address stays routable and leads there.
  {hash:'services',labelKey:'Služby',view:'inventory-services.js#servicesPage',hidden:true},
 ],
 setup(hub){
  const file=path.join(hub.directory,'knowledge.json'),secretStores=hub.site.inventory.secretStores;
  const local=createKnowledgeEditor({file,secretStores,publish:async()=>{}});
  // Resolved on first use: plugins are set up after core.
  let remote;const writer=()=>remote===undefined?(remote=hub.provided('inventory.writer')??null):remote;
  const unsupported=()=>{throw new Error('unsupported');};
  // {missing} | {unreadable} | {doc, errors, warnings}
  const load=async()=>{
   let text;try{text=await readFile(file,'utf8');}catch(e){return e.code==='ENOENT'?{missing:true}:{unreadable:true};}
   let doc;try{doc=JSON.parse(text);}catch{return {unreadable:true};}
   const {errors,warnings}=check(doc,{secretStores});return {doc,errors,warnings};
  };
  return {file,load,
   // For the MCP tools: the checked document; an empty one while there is no file; null when the file is unusable.
   read:async()=>{const r=await load();return r.missing?emptyDoc():r.doc&&!r.errors.length?r.doc:null;},
   // by = service-account name, recorded in verified_by (local writer only; a remote writer stamps its own).
   put:(change,by=null)=>writer()?writer().put(change,by):local.put(change,{by}),
   edit:input=>writer()?writer().edit(input):local(input),
   remove:change=>writer()?(writer().remove?writer().remove(change):unsupported()):local.remove(change),
   bulk:(change,who={})=>writer()?(writer().bulk?writer().bulk(change,who):unsupported()):local.bulk(change,who)};
 },
 mcpTools:tools,
 apiDocs:[{title:'Inventář',routes:[
  ['GET','/api/inventory/schema','read','Schéma inventáře: pole záznamu, druhy, místa, úložiště tajemství a pravidla kontroly.'],
  ['POST','/api/inventory/bulk','inventory:write','Hromadné založení nebo nahrazení {entries:[{entry, base?}], dryRun?}; uloží se vše, nebo nic.'],
  ['POST','/api/inventory/entries/delete','inventory:write','Smazání záznamu {id, base}; vyžaduje aktuální otisk a nesmí na něm nic záviset.']]}],
 routes:[
  // provenance (server/provenance.mjs): who wrote the entries, read from each entry's verified_by stamp.
  {method:'GET',path:'/api/inventory',error:inventoryError,async handler(c){const r=await served(c);if(r)return c.json(200,{doc:r.doc,gaps:r.warnings,hashes:hashes(r.doc.entries),provenance:inventoryProvenance(r.doc.entries)});}},
  {method:'GET',path:'/api/inventory/export',error:inventoryError,async handler(c){const r=await served(c);if(!r)return;
    c.res.writeHead(200,{'Content-Type':'application/json','Content-Disposition':`attachment; filename="home-inventory-${r.doc.updated_at}.json"`});return c.res.end(JSON.stringify(r.doc,null,2)+'\n');}},
  // The schema as data, for a client or an agent that fills the inventory: never fails for a missing file.
  // inventory says how much there is (0 while there is no file, null when the file is unusable), so a screen
  // that only needs the count asks here instead of GET /api/inventory, which is a 404 on a new hub.
  {method:'GET',path:'/api/inventory/schema',error:inventoryError,async handler(c){const r=await c.state.load(),good=r.doc&&!r.errors.length?r.doc:null;
    return c.json(200,{...describe(c.hub.site.inventory,good?good.entries:[]),inventory:{entries:r.missing?0:good?good.entries.length:null,updatedAt:good?.updated_at||null}});}},
  {method:'GET',path:'/api/services',error:servicesError,async handler(c){const r=await served(c);if(!r)return;const services=r.doc.entries.filter(e=>e.kind==='runtime');
    return c.json(200,{updatedAt:r.doc.updated_at,services,hashes:hashes(services),provenance:inventoryProvenance(services)});}},
  {method:'POST',path:'/api/inventory/entries',scope:'inventory:write',bodyLimit:65536,error:inventoryError,handler:c=>put(c,false)},
  {method:'POST',path:'/api/services',scope:'inventory:write',bodyLimit:65536,error:servicesError,handler:c=>put(c,true)},
  {method:'POST',path:'/api/inventory/entries/delete',scope:'inventory:write',error:inventoryError,handler:remove},
  {method:'POST',path:'/api/inventory/bulk',scope:'inventory:write',bodyLimit:1048576,error:inventoryError,handler:bulk},
  // The map's own edit form: field edits on one entry, checked and published by the writer.
  {method:'POST',path:'/api/inventory/entry',scope:'inventory:write',bodyLimit:65536,error:inventoryError,async handler(c){
    const result=await c.state.edit(editInput(c.input));
    if(!result?.ok)return c.json(422,refusal('The checker rejected this edit.',result));
    return c.json(200,{ok:true,published:result.published,doc:result.doc,hashes:hashes(result.doc.entries)});}},
 ],
};
