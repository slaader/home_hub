// Core module "integrations": Administration → Integrations (#integrations). Every integration the loaded
// modules declare (server/integrations.mjs, docs/plugins.md → Integrations), its health, where it is
// configured, and the switch that turns it off. Everything under /api/admin/ needs an administrator's
// password sign-in (the pipeline enforces it; API keys never get here). Each change is a line in the
// access audit with who made it. Over MCP there is only a read-only summary, never a switch.
import path from 'node:path';
import {runStatus,settingsInput,settingsView,INTEGRATION_KINDS} from '../integrations.mjs';
import {pluginsDirectories} from '../plugins.mjs';
import {machinesOverview} from '../machine-facets.mjs';

const MESSAGES={
 invalid:[400,'INVALID_INPUT','Neplatný požadavek.'],
 'not-found':[404,'INTEGRATION_NOT_FOUND','Taková integrace tu není.'],
 locked:[409,'INTEGRATION_LOCKED','Tuhle integraci nejde v Home Hubu vypnout ani zapnout.'],
 'no-test':[409,'INTEGRATION_NO_TEST','Tahle integrace nemá test.'],
 'no-settings':[409,'INTEGRATION_NO_SETTINGS','Tahle integrace nemá nastavení.'],
 disabled:[409,'INTEGRATION_DISABLED','Integrace je vypnutá. Nejdřív ji zapni.'],
};
const fail=(code,detail)=>{throw Object.assign(new Error(code),detail?{detail}:{});};
const only=(input,keys,required=[])=>{
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!keys.includes(k))||required.some(k=>input[k]===undefined))fail('invalid',`expected ${keys.join(', ')}`);
 return input;
};
const error=e=>{const m=MESSAGES[e.message];return m?[m[0],m[1],m[2]]:null;};
// A known refusal answers with its details (which field was wrong); anything else is the plain error.
const routes=list=>list.map(r=>({scope:null,error,...r,handler:async c=>{try{return await r.handler(c);}catch(e){
 const m=MESSAGES[e.message];if(!m)throw e;return c.json(m[0],{error:{code:m[1],message:m[2],...(e.detail?{details:[e.detail]}:{})}});}}}));
const subject=i=>({id:i.id,name:i.title});
const by=c=>c.principal.username;

// One row of the page: what the integration is, its switch, its status, its settings.
async function row(hub,i,{withStatus=true}={}){
 const enabled=hub.integrationEnabled(i.id),info=hub.integrations.store.disabledInfo(i.id),m=hub.registry.module(i.module);
 const [status,settings]=await Promise.all([
  withStatus?runStatus(i,hub.state(i.module),hub,{enabled}):null,
  settingsView(i,hub.state(i.module),hub,hub.integrations.secrets)]);
 return {id:i.id,module:i.module,moduleTitle:m?.title??i.module,core:m?.core===true,title:i.title,...(i.titleKey?{titleKey:i.titleKey}:{}),kind:i.kind,
  description:i.description,howTo:i.howTo,page:i.page,docs:i.docs,
  toggle:i.toggle,...(i.toggleNote?{toggleNote:i.toggleNote}:{}),enabled,...(info?{disabledBy:info.by,disabledAt:info.at}:{}),
  test:Boolean(i.test),settings,...(status?{status}:{})};
}
const find=(hub,id)=>{if(typeof id!=='string')fail('invalid','id must be an integration id');const i=hub.registry.integration(id);if(!i)fail('not-found');return i;};
// The plugin directories as people know them: inside the checkout, the relative path; elsewhere the last two parts.
const dirLabel=(hub,dir)=>{const rel=path.relative(hub.root,dir);return rel&&!rel.startsWith('..')&&!path.isAbsolute(rel)?rel:path.join(path.basename(path.dirname(dir)),path.basename(dir));};
const pluginsLabel=hub=>{const dirs=pluginsDirectories();return dirs.length?dirs.map(d=>dirLabel(hub,d)).join(', '):null;};

export async function integrationsList(hub){
 const rows=await Promise.all(hub.registry.integrations.map(i=>row(hub,i)));
 return {schemaVersion:1,generatedAt:new Date().toISOString(),kinds:[...INTEGRATION_KINDS],integrations:rows,
  plugins:hub.registry.modules.filter(m=>!m.core).map(m=>({id:m.id,title:m.title,...(m.version?{version:m.version,source:m.source}:{}),integrations:m.integrations.map(i=>i.id)})),
  pluginsDirectory:pluginsLabel(hub)};
}

export default {
 id:'integrations',title:'Integrations',
 assets:['integrations-view.js','machines-view.js','integrations.css','i18n-en-integrations.js','i18n-en-machines.js'],
 nav:[{groupKey:'Správa',hash:'integrations',labelKey:'Integrace',view:'integrations-view.js#integrationsPage',admin:true,order:52,icon:'plug'}],
 routes:routes([
  {method:'GET',path:'/api/admin/integrations',handler:async({json,hub})=>json(200,await integrationsList(hub))},
  // Integrations → Machines: every machine of the overview with what each module knows about it (server/machine-facets.mjs).
  {method:'GET',path:'/api/admin/machines',handler:async({json,hub})=>json(200,await machinesOverview(hub))},
  // {id, enabled}: turn one on or off. An integration with toggle:false refuses (its switch is elsewhere).
  {method:'POST',path:'/api/admin/integrations/toggle',async handler(c){
    const input=only(c.input,['id','enabled'],['id','enabled']);if(typeof input.enabled!=='boolean')fail('invalid','enabled must be true or false');
    const i=find(c.hub,input.id);c.subject=i.id;if(!i.toggle)fail('locked');
    const done=await c.hub.integrations.store.set(i.id,input.enabled,by(c));
    if(done.changed)await c.hub.accessStore.record(input.enabled?'integration-enabled':'integration-disabled',subject(i),{by:by(c)}).catch(()=>{});
    return c.json(200,{changed:done.changed,integration:await row(c.hub,i)});}},
  // {id}: run the integration's own check now (a pull, a probe). Refused while it is off.
  {method:'POST',path:'/api/admin/integrations/test',async handler(c){
    const i=find(c.hub,only(c.input,['id'],['id']).id);c.subject=i.id;if(!i.test)fail('no-test');if(!c.hub.integrationEnabled(i.id))fail('disabled');
    const result=await runStatus(i,c.hub.state(i.module),c.hub,{timeoutMs:20000,call:i.test});
    await c.hub.accessStore.record('integration-tested',subject(i),{by:by(c),detail:result.state}).catch(()=>{});
    return c.json(200,{id:i.id,at:new Date().toISOString(),result,integration:await row(c.hub,i)});}},
  // {id, values?, clear?}: plain values go to the module's write(); write-only ones are stored here and
  // never sent back; clear lists write-only keys to forget. The audit names the keys, never a value.
  {method:'POST',path:'/api/admin/integrations/settings',async handler(c){
    const input=only(c.input,['id','values','clear'],['id']);const i=find(c.hub,input.id);c.subject=i.id;if(!i.settings)fail('no-settings');
    const change=settingsInput(i.settings.schema,input);
    for(const [key,value] of Object.entries(change.secrets))await c.hub.integrations.secrets.set(i.id,key,value);
    const cleared=[];for(const key of change.clear)if(await c.hub.integrations.secrets.clear(i.id,key))cleared.push(key);
    if(Object.keys(change.plain).length){
     try{await i.settings.write(c.hub.state(i.module),c.hub,change.plain);}
     catch(e){fail('invalid',typeof e?.detail==='string'?e.detail:'the module refused these values');}
    }
    const keys=[...Object.keys(change.plain),...Object.keys(change.secrets)];
    if(keys.length)await c.hub.accessStore.record('integration-settings',subject(i),{by:by(c),detail:keys.join(', ')}).catch(()=>{});
    if(cleared.length)await c.hub.accessStore.record('integration-secret-cleared',subject(i),{by:by(c),detail:cleared.join(', ')}).catch(()=>{});
    return c.json(200,{integration:await row(c.hub,i)});}},
 ]),
 mcpInstructions:'Integrations: integrations_status lists what this hub reads from outside (telemetry, router, collectors, bridges) with the state of each. Turning one on or off is for an administrator in the web UI.',
 mcpTools:[{name:'integrations_status',scope:'read',title:'Home Hub: integrations',
  description:'Every integration of this Home Hub (Thermo telemetry, the router adapter, the collectors, bridges to other machines, plugin sources) with its kind and its state: ok, stale, error, off, not-configured or disabled (turned off by an administrator; its data is then not shown). Read-only: an administrator turns integrations on and off in the web UI.',
  inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,openWorldHint:false},
  async run(args,{hub}){
   const rows=await Promise.all(hub.registry.integrations.map(async i=>{const s=await runStatus(i,hub.state(i.module),hub,{enabled:hub.integrationEnabled(i.id)});return {id:i.id,kind:i.kind,state:s.state,summary:s.summary};}));
   return {integrations:rows};}}],
 apiDocs:[{title:'Integrace',routes:[
  ['GET','/api/admin/machines','admin','Stroje: každý stroj z Přehledu a co o něm ví který modul (telemetrie, zálohy, verze, SSH klíče, inventář, LLM runtimy, Git LFS): nastaveno, nenastaveno, varování, vypnuto.'],
  ['GET','/api/admin/integrations','admin','Všechny integrace: stav, kde jsou nastavené, vypínač, test a nastavení. MCP integrations_status (jen čtení).'],
  ['POST','/api/admin/integrations/toggle','admin','{id, enabled}: zapnout nebo vypnout integraci. Zapíše se do auditu.'],
  ['POST','/api/admin/integrations/test','admin','{id}: spustit test integrace teď.'],
  ['POST','/api/admin/integrations/settings','admin','{id, values?, clear?}: uložit nastavení; tajné hodnoty se jen zapisují, nikdy nevrací.']]}],
};
