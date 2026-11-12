// Core module "updates": which release of Home Hub is running and whether a newer one is known
// (server/update-check.mjs has the rules). The hub only tells: there is no route, button or MCP tool that
// installs anything; a person applies an update on the server, with scripts/update.mjs (docs/updating.md).
//   GET  /api/updates          what is known (scope read)
//   POST /api/updates/check    look now, at most once a minute (administrator, password sign-in)
//   POST /api/updates/dismiss  {version}: stop pointing at that release in the footer (the same)
// The card on Administration → Integrations is `updates.check`; its switch turns the check off, and so does
// HOME_HUB_UPDATE_CHECK=off in the environment. While off, nothing here makes a request.
// MCP: hub_version (read-only). hub.options.updateCheck = {settings, env, fetchJson, fetchImpl, now, random,
// setTimer, clearTimer, timing} replaces the real network, clock and timers in the tests.
import {createUpdateChecker,updateSettings,updateSummary,integrationStatus,UPDATE_INTEGRATION} from '../update-check.mjs';
import {field} from '../text.mjs';

// The environment as it was when the process started: with the check forced off there, the card has no switch.
const ENV_OFF=updateSettings({}).envOff;
const OPTIONS=['file','fetchJson','fetchImpl','loadToken','now','random','setTimer','clearTimer','timing','log'];
const zone=hub=>({timeZone:hub.site.timeZone});

// What GET /api/updates answers. Turned off by an administrator: `disabled` says by whom, and nothing else is known.
export function updatesPayload(state,hub){
 const view=state.checker.view({repoSource:state.settings.repoSource}),disabled=view.code==='disabled'?hub.integrationDisabled(UPDATE_INTEGRATION):null;
 return {...view,...field('summary',updateSummary(view,zone(hub))),...(disabled?{disabled}:{}),
  // The hub never applies an update. `tag` is the release to switch to and `command` what a person runs on the
  // server for it, from the core checkout (docs/updating.md). A tag that is not a plain release tag gets no command.
  apply:{automatic:false,tag:view.updateAvailable?view.latest.tag:null,command:view.updateAvailable?applyCommand(view.latest.tag):null}};
}
export const applyCommand=tag=>typeof tag==='string'&&/^v[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/.test(tag)?`node scripts/update.mjs apply ${tag}`:null;
const status=(state,hub)=>integrationStatus(state.checker.view({repoSource:state.settings.repoSource}),zone(hub));
// Checking and dismissing are an administrator's, signed in with a password: no API key, no device token.
const adminOnly=handler=>c=>c.canAdmin?handler(c):c.error(403,'ADMIN_REQUIRED','Administrator password sign-in is required.');
const only=(input,keys)=>input&&typeof input==='object'&&!Array.isArray(input)&&Object.keys(input).every(k=>keys.includes(k));

export default {
 id:'updates',title:'Updates',
 assets:['updates-view.js','i18n-en-updates.js'],
 setup(hub){
  const given=hub.options.updateCheck||{};
  const settings=given.settings||updateSettings({site:hub.site,version:hub.version,env:given.env||process.env});
  const checker=createUpdateChecker({stateDirectory:hub.stateDirectory,version:hub.version,settings,enabled:()=>hub.integrationEnabled(UPDATE_INTEGRATION),
   ...Object.fromEntries(OPTIONS.filter(k=>given[k]!==undefined).map(k=>[k,given[k]]))});
  // Turned on again: look soon, without a restart. Turned off: the next slot finds it off and asks nothing.
  hub.onIntegrationChange(({id,enabled})=>{if(id===UPDATE_INTEGRATION&&enabled)checker.resume();});
  return {checker,settings};
 },
 pollers:[{id:'updates',start:state=>state.checker.start(),stop:state=>state.checker.stop()}],
 routes:[
  {method:'GET',path:'/api/updates',handler:c=>c.json(200,updatesPayload(c.state,c.hub))},
  {method:'POST',path:'/api/updates/check',scope:null,write:false,handler:adminOnly(async c=>{
    if(!only(c.input,[]))return c.error(400,'INVALID_INPUT','Neplatný požadavek.');
    if(!c.hub.integrationEnabled(UPDATE_INTEGRATION))return c.error(409,'INTEGRATION_DISABLED','Integrace je vypnutá. Nejdřív ji zapni.');
    const done=await c.state.checker.checkNow();
    return c.json(200,{checked:done.checked,...(done.reason?{reason:done.reason}:{}),updates:updatesPayload(c.state,c.hub)});})},
  {method:'POST',path:'/api/updates/dismiss',scope:null,write:false,handler:adminOnly(async c=>{
    if(!only(c.input,['version'])||typeof c.input.version!=='string')return c.error(400,'INVALID_INPUT','Neplatný požadavek.');
    try{await c.state.checker.dismiss(c.input.version,c.principal.username);}
    catch(e){if(e.message==='invalid')return c.error(409,'UPDATE_NOT_CURRENT','Tohle není nejnovější známé vydání.');throw e;}
    return c.json(200,{updates:updatesPayload(c.state,c.hub)});})},
 ],
 integrations:[{id:UPDATE_INTEGRATION,title:'Kontrola aktualizací Home Hubu',kind:'upstream',docs:'docs/updating.md',
  toggle:!ENV_OFF,toggleNote:'Vypnuto proměnnou prostředí HOME_HUB_UPDATE_CHECK=off. Zapnout jde jen tam.',
  description:'Zhruba dvakrát denně se zeptá GitHubu, jestli vyšlo novější vydání Home Hubu: dva dotazy GET na api.github.com, nic se neposílá. Jen oznamuje; aktualizaci nikdy neinstaluje sám. Vypnutá: Home Hub kvůli aktualizacím nekontaktuje nikoho.',
  status:(state,hub)=>status(state,hub),
  test:async(state,hub)=>{await state.checker.checkNow();return status(state,hub);}}],
 mcpTools:[{name:'hub_version',scope:'read',title:'Home Hub: version and updates',
  description:'Which Home Hub this is: the release version, the commit, whether it is a development build (a checkout that is not on its release tag), the data epoch, the loaded plugins, and what the update check knows: the newest known release and whether it is newer, or why that is not known (a failed or disabled check never reads as "up to date"). Read-only: nothing checks, dismisses or applies an update over MCP.',
  inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,openWorldHint:false},
  async run(args,{hub,state}){
   const u=updatesPayload(state,hub),v=hub.version;
   return {version:v.version,label:v.label,commit:v.commit,exact:v.exact,dataEpoch:v.dataEpoch,
    plugins:hub.registry.modules.filter(m=>!m.core).map(m=>({id:m.id,title:m.title,...(m.version?{version:m.version}:{})})),
    // The release text is left out on purpose: it is somebody else's prose. The link leads to it.
    updates:{state:u.state,code:u.code,summary:u.summary,updateAvailable:u.updateAvailable,latest:u.latest?{version:u.latest.version,url:u.latest.url,publishedAt:u.latest.publishedAt}:null,
     checkedAt:u.checkedAt,failedAt:u.failedAt,error:u.error,quarantined:u.quarantined,automatic:false}};}}],
 apiDocs:[{title:'Aktualizace',routes:[
  ['GET','/api/updates','read','Která verze Home Hubu běží, nejnovější známé vydání a stav kontroly. MCP hub_version (jen čtení).'],
  ['POST','/api/updates/check','admin','Zkontrolovat teď (nejvýš jednou za minutu).'],
  ['POST','/api/updates/dismiss','admin','{version}: na tohle vydání už v patičce neupozorňovat.']]}],
};
