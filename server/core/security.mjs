// Core module "security": the SSH key inventory, and OS/software versions with host protection.
// Both are snapshots written by collectors (scripts/collect-security.mjs, scripts/collect-systems.mjs),
// which read the machines to probe from the site configuration. They show open ports and weak spots,
// so only administrators (or a key holding security:read) may read them.
import {loadSecurity} from '../security-data.mjs';
import {loadSystems} from '../systems-data.mjs';

const adminOnly=(c,message)=>{if(c.principal.role==='admin'||c.principal.authKind==='api-key')return false;c.error(403,'ADMIN_REQUIRED',message);return true;};

export default {
 id:'security',title:'Security',
 assets:['security-view.js','systems-view.js','security.css','systems.css'],
 nav:[
  {groupKey:'Inventář',hash:'versions',labelKey:'Verze a aktualizace',view:'systems-view.js#systemsPage',admin:true,order:21},
  {groupKey:'Bezpečnost',hash:'security',labelKey:'SSH klíče',view:'security-view.js#securityPage',admin:true,order:30},
  {groupKey:'Bezpečnost',hash:'hardening',labelKey:'Ochrana strojů',view:'systems-view.js#systemsPage',admin:true,order:31},
 ],
 routes:[
  {method:'GET',path:'/api/security',scope:'security:read',async handler(c){
    if(adminOnly(c,'Only an administrator can see the security inventory.'))return;
    const doc=await loadSecurity(c.hub.directory);return doc?c.json(200,doc):c.error(404,'SECURITY_MISSING','No SSH key inventory yet. Run node scripts/collect-security.mjs.');}},
  {method:'GET',path:'/api/systems',scope:'security:read',async handler(c){
    if(adminOnly(c,'Only an administrator can see machine versions and protection.'))return;
    const doc=await loadSystems(c.hub.directory,{site:c.hub.site});return doc?c.json(200,doc):c.error(404,'SYSTEMS_MISSING','No machine snapshot yet. Run node scripts/collect-systems.mjs.');}},
 ],
};
