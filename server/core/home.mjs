// Core module "home": the overview (machine tiles, per-machine pages and charts), the Thermo
// telemetry client, devices added on the page, and the router adapter's census.
// Machines come from the site configuration; two extension points let plugins enrich a tile:
//   home.snapshots  (state, hub) => {machineId: {snapshot, bridge}}        host agents (services, memory, uptime)
//   home.services   (state, hub) => Promise<{machineId: services[]}>       service probes for agent-less machines
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {createThermoPoller,probeThermo,checkThermoLogin} from '../thermo-client.mjs';
import {createHomeDevices,validHost,DEVICE_ID} from '../home-devices.mjs';
import {buildHome,homeHistory,homeHistoryQuery,loadMachineDescriptors,homeMachineIds} from '../home-data.mjs';
import {readRouter} from '../router-data.mjs';

const homeError=e=>[e.message==='invalid'?400:503,'HOME_UNAVAILABLE',e.message==='invalid'?'Neplatný požadavek na data domovské stránky.':'Data domovské stránky jsou dočasně nedostupná.'];
const deviceError=(c,e,extra={})=>c.error(({invalid:400,'not-found':404,conflict:409,limit:409,denied:422,pin:422,unreachable:422})[e.message]||503,'DEVICE_FAILED',({
 invalid:'Zkontroluj pole: název, typ, hostname nebo IP, port 1024–65535, uživatele a heslo Thermo (aspoň 12 znaků) a potvrzený otisk.',
 'not-found':'Zařízení neexistuje.',conflict:'Zařízení s tímhle hostname už v přehledu je.',limit:'Přidat jde nejvýš 20 zařízení.',
 denied:'Thermo přihlášení odmítlo: zkontroluj uživatele a heslo účtu v aplikaci Thermo.',pin:'Certifikát se mezitím změnil — ověř spojení znovu.',
 unreachable:'Na té adrese a portu Thermo neodpovídá. Běží Thermo a je port povolený ve firewallu?',...extra})[e.message]||'Zařízení teď nejde uložit.');
// Devices added on the Home page (docs/API.md). Password sign-in with write access; API keys never.
const devices=handler=>async c=>{if(c.principal.authKind==='api-key')return c.error(403,'SCOPE_REQUIRED','API keys cannot use this endpoint.');try{return await handler(c);}catch(e){return deviceError(c,e);}};

export default {
 id:'home',title:'Overview',
 assets:['home-view.js','home-charts.js','home-add-device.js','home-order.js','home.css','vendor/echarts.esm.min.mjs'],
 nav:[{groupKey:'Domov',hash:'overview',labelKey:'Přehled',view:'home-view.js#homePage',order:10}],
 setup(hub){
  const {site,directory,stateDirectory,root,options}=hub;
  const ids=homeMachineIds(site);
  const homeDevices=options.homeDevices||createHomeDevices(path.join(stateDirectory,'home'),{reserved:ids});
  const thermoHostsFile=options.thermoHostsFile||process.env.THERMO_HOSTS_FILE||path.join(root,'private','thermo-hosts.json');
  const thermoPoller=options.thermoPoller||createThermoPoller({hostsFile:thermoHostsFile,extraHosts:()=>homeDevices.thermoHosts(),stateDirectory});
  const merged=async name=>Object.assign({},...await Promise.all(hub.collect(name).map(v=>Promise.resolve(v).catch(()=>({})))));
  const payload=async()=>buildHome({site,added:await homeDevices.list(),descriptors:await loadMachineDescriptors(process.env.MACHINES_DIR||path.join(directory,'machines'),ids),
   snapshots:await merged('home.snapshots'),thermo:thermoPoller,router:await readRouter(directory,{lanCidrs:site.lanCidrs}),probed:await merged('home.services')});
  return {homeDevices,thermoPoller,payload,checkThermo:options.checkThermo||checkThermoLogin,probeCert:options.probeCert||probeThermo,
   machineIds:async()=>[...ids,...(await homeDevices.list()).map(d=>d.id)]};
 },
 pollers:[{id:'thermo',start:state=>state.thermoPoller.start(),stop:state=>state.thermoPoller.stop?.()}],
 routes:[
  {method:'GET',path:'/api/home',error:homeError,handler:async({json,state})=>json(200,await state.payload())},
  {method:'GET',path:'/api/home/history',error:homeError,async handler({query,json,state,hub}){
    const added=await state.homeDevices.list(),q=homeHistoryQuery(query,added,hub.site);
    if(q.reason)return json(200,q);
    // A site machine reads the Thermo host named by its thermoId; an added device is its own Thermo host.
    const thermoId=hub.site.machines.find(m=>m.id===q.machine)?.thermoId||q.machine;
    return json(200,{...homeHistory(state.thermoPoller,thermoId,q.range,undefined,[thermoId]),machine:q.machine});}},
  {method:'POST',path:'/api/home/settings',scope:'home:settings',error:homeError,async handler({input,json,state}){const ms=Number(input?.intervalSeconds)*1000;await state.thermoPoller.setIntervalMs(ms);return json(200,await state.payload());}},
  // Refresh button: pull Thermo now (rate-limited in the poller), then return fresh tiles. Reads only.
  {method:'POST',path:'/api/home/refresh',scope:'read',error:homeError,async handler({json,state}){const pulled=await state.thermoPoller.refresh().catch(()=>false);return json(200,{...await state.payload(),refresh:{pulled:pulled===true,at:new Date().toISOString()}});}},
  {method:'POST',path:'/api/home/devices/probe',scope:null,error:homeError,handler:devices(async({input,json,state})=>{
    if(!input||typeof input!=='object'||Object.keys(input).some(k=>!['host','port'].includes(k))||!validHost(input.host))throw new Error('invalid');
    const port=input.port??49286;if(!Number.isSafeInteger(port)||port<1024||port>65535)throw new Error('invalid');
    return json(200,await state.probeCert({host:input.host,port}));})},
  {method:'POST',path:'/api/home/devices/remove',scope:null,error:homeError,handler:devices(async({input,json,state})=>{
    if(!input||typeof input!=='object'||Object.keys(input).some(k=>k!=='id')||typeof input.id!=='string'||!DEVICE_ID.test(input.id))throw new Error('invalid');
    const gone=await state.homeDevices.remove(input.id);state.thermoPoller.removeHost(gone.id);return json(200,{removed:gone.id});})},
  // Add: a Thermo device must log in with the pinned certificate first, so a typo never lands in the config.
  {method:'POST',path:'/api/home/devices',scope:null,error:homeError,handler:devices(async({input,principal,json,state})=>{
    const t=input?.kind==='thermo'?input.thermo:null;
    if(t&&typeof t==='object'&&validHost(input.hostname)){const pin=String(t.pin||'').replace(/:/g,'').toLowerCase(),port=t.port??49286;
     if(/^[a-f0-9]{64}$/.test(pin)&&Number.isSafeInteger(port)&&typeof t.password==='string'&&t.password.length>=12&&t.password.length<=256&&typeof t.username==='string'&&t.username.trim())
      await state.checkThermo({id:'probe',host:input.hostname,port,username:t.username.trim().slice(0,32),label:'home-hub',password:t.password,token:null,pin});}
    const saved=await state.homeDevices.add(input,principal.username);if(saved.thermo)state.thermoPoller.addHost(saved.thermo);
    return json(201,saved.device);})},
  // An added device's tile picture: one JPEG cropped in the browser (at most 3 MiB). Password sign-in only.
  {method:'PUT',match:/^\/api\/home\/devices\/([a-z][a-z0-9_-]{1,31})\/image$/,scope:null,raw:true,contentType:'image/jpeg',denied:'Zařízení přidává jen účet se zápisem, přihlášený heslem.',error:homeError,
   async handler({req,params,json,error,state}){
    try{return json(200,await state.homeDevices.putImage(params[1],req,Number(req.headers['content-length'])));}
    catch(e){req.resume();return error(({invalid:400,'not-found':404,'too-large':413})[e.message]||503,'DEVICE_FAILED',({invalid:'Obrázek musí být JPEG.','not-found':'Zařízení neexistuje.','too-large':'Obrázek je větší než 3 MB.'})[e.message]||'Obrázek nejde uložit.');}}},
  // The picture of an added device, from state (a site's own machine pictures are static files and win).
  {method:'GET',match:/^\/images\/home\/([a-z][a-z0-9_-]{1,31})\.jpg$/,async handler({params,res,error,state}){
    let file;try{file=await state.homeDevices.image(params[1]);}catch{return error(404,'NOT_FOUND','Not found.');}
    res.setHeader('Cache-Control','private, max-age=86400');res.writeHead(200,{'Content-Type':'image/jpeg'});return res.end(await readFile(file));}},
 ],
};
