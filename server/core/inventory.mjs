// Core module "inventory": the inventory map and the services catalog, both views of one file
// (data/knowledge.json) that is served only when it passes the same checker agents run.
// Writes go through one writer. By default that is the local editor (the file on this machine);
// a plugin may provide another one (extension point inventory.writer → {put(change, by), edit(input)}),
// e.g. a bridge to the machine that owns the file.
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {validate as validateKnowledge} from '../../scripts/check-knowledge.mjs';
import {createKnowledgeEditor,editInput,entryInput,entryHash} from '../../scripts/knowledge-edit.mjs';

const servicesError=e=>[({invalid:400,conflict:409,busy:429})[e.message]||503,'INVENTORY_UPDATE_FAILED',e.message==='conflict'?'The entry changed. Read it again before updating.':'Cannot update the service inventory.'];
const inventoryError=e=>[({invalid:400,'not-found':404,conflict:409,busy:429})[e.message]||503,'INVENTORY_EDIT_FAILED',({invalid:'That edit is not valid.','not-found':'That entry no longer exists.',conflict:'This entry changed since you opened it. Reload and edit again.',busy:'Another edit is being saved. Try again.'})[e.message]||'The edit could not be saved. Check that the machine holding the inventory file is reachable.'];
const hashes=entries=>Object.fromEntries(entries.map(e=>[e.id,entryHash(e)]));
// GET: the checked document, or a reply saying why there is none.
async function served(c){
 let doc;try{doc=JSON.parse(await readFile(c.state.file,'utf8'));}catch{c.error(404,'INVENTORY_MISSING','There is no inventory file yet (data/knowledge.json).');return null;}
 const {errors,warnings}=validateKnowledge(doc);
 if(errors.length){c.error(500,'INVENTORY_INVALID',`The inventory file has ${errors.length} errors; run node scripts/check-knowledge.mjs.`);return null;}
 return {doc,warnings};
}
async function put(c,runtimeOnly){
 const change=entryInput(c.input);if(runtimeOnly&&change.entry.kind!=='runtime')throw new Error('invalid');
 const result=await c.state.put(change,c.principal.authKind==='api-key'&&c.principal.accountId?c.principal.username:null);
 if(!result?.ok)return c.json(422,{error:{code:'INVENTORY_INVALID',message:'Inventory validation failed.',details:(result?.errors||[]).map(String).slice(0,10)}});
 return c.json(200,{ok:true,published:result.published,entry:result.entry,hash:result.hash});
}

export default {
 id:'inventory',title:'Inventory',
 assets:['inventory-view.js','inventory-versions.js','inventory.css'],
 nav:[{groupKey:'Inventář',hash:'inventory-map',labelKey:'Mapa inventáře',view:'inventory-view.js#inventoryPage',order:20}],
 setup(hub){
  const file=path.join(hub.directory,'knowledge.json');
  const local=createKnowledgeEditor({file,publish:async()=>{}});
  // Resolved on first use: plugins are set up after core.
  let remote;const writer=()=>remote===undefined?(remote=hub.provided('inventory.writer')??null):remote;
  return {file,
   read:async()=>{let doc;try{doc=JSON.parse(await readFile(file,'utf8'));}catch{return null;}return validateKnowledge(doc).errors.length?null:doc;},
   // by = service-account name, recorded in verified_by (local writer only; a remote writer stamps its own).
   put:(change,by=null)=>writer()?writer().put(change,by):local.put(change,{by}),
   edit:input=>writer()?writer().edit(input):local(input)};
 },
 routes:[
  {method:'GET',path:'/api/inventory',error:inventoryError,async handler(c){const r=await served(c);if(r)return c.json(200,{doc:r.doc,gaps:r.warnings,hashes:hashes(r.doc.entries)});}},
  {method:'GET',path:'/api/inventory/export',error:inventoryError,async handler(c){const r=await served(c);if(!r)return;
    c.res.writeHead(200,{'Content-Type':'application/json','Content-Disposition':`attachment; filename="home-inventory-${r.doc.updated_at}.json"`});return c.res.end(JSON.stringify(r.doc,null,2)+'\n');}},
  {method:'GET',path:'/api/services',error:servicesError,async handler(c){const r=await served(c);if(!r)return;const services=r.doc.entries.filter(e=>e.kind==='runtime');
    return c.json(200,{updatedAt:r.doc.updated_at,services,hashes:hashes(services)});}},
  {method:'POST',path:'/api/inventory/entries',scope:'inventory:write',error:inventoryError,handler:c=>put(c,false)},
  {method:'POST',path:'/api/services',scope:'inventory:write',error:servicesError,handler:c=>put(c,true)},
  // The map's own edit form: field edits on one entry, checked and published by the writer.
  {method:'POST',path:'/api/inventory/entry',scope:'inventory:write',error:inventoryError,async handler(c){
    const result=await c.state.edit(editInput(c.input));
    if(!result?.ok)return c.json(422,{error:{code:'INVENTORY_INVALID',message:'The checker rejected this edit.',details:(result?.errors||[]).map(String).slice(0,10)}});
    return c.json(200,{ok:true,published:result.published,doc:result.doc,hashes:hashes(result.doc.entries)});}},
 ],
};
