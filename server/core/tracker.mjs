// Core module "tracker": projects, releases, tickets with attachments, and the full-text search over
// tickets and review sets. Projects are created in the UI (or seeded once from site.json → tracker.projects).
import path from 'node:path';
import {createReadStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {createTicketStore,TICKET_ID} from '../tickets-store.mjs';
import {createTicketFiles,inline as inlineFile} from '../ticket-files.mjs';

const ticketsError=e=>e.message==='too-large'?[413,'TICKETS_FAILED','Soubor je příliš velký (nejvýš 20 MB).']
 :[({invalid:400,'not-found':404,conflict:409,limit:409})[e.message]||503,'TICKETS_FAILED',({invalid:'Neplatný požadavek na ticket (zkontroluj pole, projekt a release).','not-found':'Ticket neexistuje.',conflict:'Záznam se mezitím změnil nebo už existuje. Načti ho znovu a změnu zopakuj.',limit:'Byl dosažen limit počtu záznamů.'})[e.message]||'Tickety teď nejdou načíst ani uložit.'];
const searchError=e=>[e.message==='invalid'?400:503,'SEARCH_FAILED',e.message==='invalid'?'Neplatné hledání (nejvýš 200 znaků, kind ticket|review, limit 1–100).':'Hledání teď nejde.'];
// The write log names what a write touched; a failed write names nothing (never rejected argument text).
const write=(path,status,run)=>({method:'POST',path,scope:'tickets:write',error:ticketsError,async handler(c){c.subject=null;const saved=await run(c);c.subject=saved.subject;return c.json(typeof status==='function'?status(c):status,saved.body);}});
const who=c=>c.principal.username;

export default {
 id:'tracker',title:'Project Tracker',
 assets:['tracker-view.js','tracker-md.js','search-view.js','tickets.css'],
 nav:[
  {group:'Project Tracker',hash:'projects',labelKey:'Projekty',view:'tracker-view.js#trackerPage',order:40},
  {group:'Project Tracker',hash:'items',labelKey:'Otevřené položky',view:'tracker-view.js#trackerPage',order:41},
  {group:'Project Tracker',hash:'releases',labelKey:'Releasy',view:'tracker-view.js#trackerPage',order:42},
  {hash:'search',label:'Search',view:'search-view.js#searchPage',hidden:true},
 ],
 setup(hub){
  const dir=path.join(hub.stateDirectory,'tickets');
  return {tickets:createTicketStore(dir,{db:hub.db,seedProjects:hub.site.tracker.projects}),ticketFiles:createTicketFiles(dir)};
 },
 routes:[
  // Ticket attachments: the raw file in one request (at most 20 MiB); the name comes in the query.
  {method:'PUT',match:/^\/api\/tickets\/([A-Z][A-Z0-9]{1,9}-[1-9][0-9]{0,5})\/attachments$/,scope:'tickets:write',raw:true,contentType:'application/octet-stream',error:ticketsError,
   async handler(c){const {tickets,ticketFiles}=c.state,id=c.params[1];
    await tickets.get(id);
    const file=await ticketFiles.put(c.req,{name:c.url.searchParams.get('name'),declaredLength:Number(c.req.headers['content-length'])});
    c.subject=id;return c.json(201,await tickets.attach(id,file,who(c)));}},
  write('/api/tickets',201,async c=>{const ticket=await c.state.tickets.create(c.input,who(c));return {subject:ticket.id,body:ticket};}),
  write('/api/tickets/update',200,async c=>{const saved=await c.state.tickets.update(c.input,who(c));return {subject:saved.id||saved.project,body:saved};}),
  write('/api/tickets/comment',200,async c=>{const saved=await c.state.tickets.comment(c.input,who(c));return {subject:saved.id||saved.project,body:saved};}),
  write('/api/tickets/releases',200,async c=>{const saved=await c.state.tickets.saveRelease(c.input,who(c));return {subject:saved.id||saved.project,body:saved};}),
  write('/api/tickets/attachments/delete',200,async c=>{const out=await c.state.tickets.detach(c.input,who(c));if(!out.used)await c.state.ticketFiles.remove(out.removed.sha256);return {subject:out.ticket.id,body:out.ticket};}),
  write('/api/tickets/projects',c=>c.input?.rev===undefined?201:200,async c=>{const saved=await c.state.tickets.saveProject(c.input,who(c));return {subject:saved.id||saved.project,body:saved};}),
  {method:'GET',path:'/api/tickets',error:ticketsError,handler:async c=>c.json(200,await c.state.tickets.list(c.query))},
  // An attachment: images and plain text inline, everything else as a download; always sandboxed and nosniff.
  {method:'GET',match:/^\/api\/tickets\/([A-Z][A-Z0-9]{1,9}-[1-9][0-9]{0,5})\/attachments\/([0-9a-f-]{36})$/,error:ticketsError,async handler({params,url,res,state}){
    const a=await state.tickets.attachment(params[1],params[2]),f=await state.ticketFiles.read(a.sha256),show=inlineFile(a.type)&&url.searchParams.get('download')!=='1';
    res.setHeader('Content-Security-Policy',"sandbox; default-src 'none'; style-src 'unsafe-inline'");res.setHeader('Cache-Control','private, max-age=31536000, immutable');
    res.writeHead(200,{'Content-Type':a.type==='text/plain'?'text/plain; charset=utf-8':show?a.type:'application/octet-stream','Content-Length':f.size,
     'Content-Disposition':`${show?'inline':'attachment'}; filename="${a.name.replace(/[^\x20-\x7e]/g,'_')}"; filename*=UTF-8''${encodeURIComponent(a.name)}`});
    try{await pipeline(createReadStream(f.path),res);}catch{res.destroy();}}},
  {method:'GET',match:/^\/api\/tickets\/(.*)$/,error:ticketsError,async handler({params,json,state}){if(!TICKET_ID.test(params[1]))throw new Error('not-found');return json(200,await state.tickets.get(params[1]));}},
  // Full-text search over tickets and review sets (title, description, comments, notes); plain words, diacritics ignored.
  {method:'GET',path:'/api/search',error:searchError,handler({query,json,hub}){if(Object.keys(query).some(k=>!['q','kind','project','limit'].includes(k)))throw new Error('invalid');return json(200,hub.db.search({...query,limit:query.limit===undefined?20:query.limit}));}},
 ],
};
