// Core module "router": the client census and router health behind one adapter (server/router-data.mjs).
// UniFi is the included adapter; a plugin can provide another through the "router.adapter" extension
// point. The overview's router tile reads the same observation through the home module.
import {readRouterFor,routerProvenance,routerAdapter,ROUTER_INTEGRATION,ROUTER_FILE,ROUTER_ADAPTERS} from '../router-data.mjs';
import {COLLECTORS} from '../collector-state.mjs';

// Integration "router.adapter": the state the router page shows, as a card on the integrations page.
const STATES={'not-configured':'not-configured',waiting:'stale',unavailable:'error',stale:'stale',ok:'ok',disabled:'disabled'};
async function routerStatus(state,hub,{enabled=true}={}){
 const site=hub.site,wanted=site.router?.adapter||null;
 const configuredBy=[...(wanted?[{source:'site.json',name:`router.adapter = ${wanted}`}]:[]),...(site.router?.host?[{source:'site.json',name:'router.host'}]:[])];
 if(!enabled)return {state:'disabled',summary:'',configuredBy};
 const adapter=await routerAdapter(hub).catch(()=>null),router=await readRouterFor(hub);
 if(adapter&&!ROUTER_ADAPTERS[adapter.id]&&!adapter.missing)configuredBy.push({source:'plugin',name:adapter.id});
 if(adapter&&!wanted&&ROUTER_ADAPTERS[adapter.id])configuredBy.push({source:'file',name:`data/${ROUTER_FILE}`});
 const summary={'not-configured':'Žádný adaptér routeru není nastavený.',waiting:'Adaptér je nastavený, ale zatím nic nenahlásil.',unavailable:'Poslední čtení routeru selhalo.',
  stale:'Poslední pozorování je staré.',ok:'Router hlásí klienty i stav.'}[router.state]||'';
 const builtin=adapter&&ROUTER_ADAPTERS[adapter.id];
 return {state:STATES[router.state]||'error',summary,lastSuccessAt:router.status==='ok'?router.observedAt:null,lastError:router.error||null,configuredBy,
  items:adapter?[{id:'adapter',label:adapter.title||adapter.id,state:STATES[router.state]||'error',summary:builtin?`${builtin.collector} · ${Math.round(COLLECTORS.router.intervalSeconds/60)} min`:'plugin',lastSuccessAt:router.observedAt}]:[]};
}

export default {
 id:'router',title:'Router',
 assets:['router-view.js'],
 routes:[
  // What the router machine page draws: state, census, health, and what to set up when there is none.
  {method:'GET',path:'/api/router',async handler(c){
    const site=c.hub.site,machine=site.machines.find(m=>m.role==='router')||null;
    const router=await readRouterFor(c.hub);
    // disabled = an administrator turned the router feed off; the page says so and shows no census.
    if(router.state==='disabled')return c.json(200,{schemaVersion:1,generatedAt:new Date().toISOString(),...router,provenance:routerProvenance(router),
     configured:{adapter:site.router?.adapter||null,host:site.router?.host||machine?.ip||null,lanCidrs:[...site.lanCidrs]},machine:machine?{id:machine.id,name:machine.name,ip:machine.ip||null}:null});
    return c.json(200,{schemaVersion:1,generatedAt:new Date().toISOString(),...router,provenance:routerProvenance(router),
     configured:{adapter:site.router?.adapter||null,host:site.router?.host||machine?.ip||null,lanCidrs:[...site.lanCidrs]},
     machine:machine?{id:machine.id,name:machine.name,ip:machine.ip||null}:null});}},
 ],
 integrations:[{id:ROUTER_INTEGRATION,title:'Adaptér routeru',kind:'router',
  // Integrations → Machines: the router's page shows the adapter.
  machines:(state,hub)=>hub.site.machines.filter(m=>m.role==='router').map(m=>m.id),
  description:'Sčítání klientů v síti a stav routeru. Vestavěný adaptér UniFi čte soubor, který zapisuje sběr routeru; jiný router připojí plugin. Vypnutý: hub soubor ani adaptér nečte. Naplánovaný sběr (cron, launchd) to nezastaví.',
  howTo:'V local/site.json nastav router.adapter („unifi“) a host a spouštěj python3 scripts/collect-router-unifi.py každou minutu.',docs:'docs/plugins.md → The router adapter',
  status:routerStatus}],
 apiDocs:[{title:'Router',routes:[['GET','/api/router','read','Sčítání klientů a stav routeru z adaptéru (UniFi nebo plugin); stav not-configured, waiting, unavailable, stale nebo ok.']]}],
};
