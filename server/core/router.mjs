// Core module "router": the client census and router health behind one adapter (server/router-data.mjs).
// UniFi is the included adapter; a plugin can provide another through the "router.adapter" extension
// point. The overview's router tile reads the same observation through the home module.
import {readRouterFor,routerProvenance} from '../router-data.mjs';

export default {
 id:'router',title:'Router',
 assets:['router-view.js'],
 routes:[
  // What the router machine page draws: state, census, health, and what to set up when there is none.
  {method:'GET',path:'/api/router',async handler(c){
    const site=c.hub.site,machine=site.machines.find(m=>m.role==='router')||null;
    const router=await readRouterFor(c.hub);
    return c.json(200,{schemaVersion:1,generatedAt:new Date().toISOString(),...router,provenance:routerProvenance(router),
     configured:{adapter:site.router?.adapter||null,host:site.router?.host||machine?.ip||null,lanCidrs:[...site.lanCidrs]},
     machine:machine?{id:machine.id,name:machine.name,ip:machine.ip||null}:null});}},
 ],
 apiDocs:[{title:'Router',routes:[['GET','/api/router','read','Sčítání klientů a stav routeru z adaptéru (UniFi nebo plugin); stav not-configured, waiting, unavailable, stale nebo ok.']]}],
};
