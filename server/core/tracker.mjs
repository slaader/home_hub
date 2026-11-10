// Core module "tracker": projects, releases, tickets with attachments, and the full-text search over
// tickets and review sets. Projects are created in the UI (or seeded once from site.json → tracker.projects).
import path from 'node:path';
import {createReadStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {createTicketStore,TICKET_ID,TICKET_TYPES,TICKET_PRIORITIES} from '../tickets-store.mjs';
import {createTicketFiles,inline as inlineFile} from '../ticket-files.mjs';
import {toolError} from '../mcp.mjs';

// Messages come in two languages: Czech source text for the web UI (which translates it through its
// dictionary, like every other string) and English for an API key, i.e. a script or an agent.
const TICKET_MESSAGES={
 'too-large':['Soubor je příliš velký (nejvýš 20 MB).','The file is too large (20 MB at most).'],
 invalid:['Neplatný požadavek na ticket (zkontroluj pole, projekt a release).','Invalid ticket request (check the fields, the project and the release).'],
 'not-found':['Ticket neexistuje.','The ticket does not exist.'],
 conflict:['Záznam se mezitím změnil nebo už existuje. Načti ho znovu a změnu zopakuj.','The record changed in the meantime or already exists. Read it again and repeat the change.'],
 limit:['Byl dosažen limit počtu záznamů.','The record limit has been reached.'],
 unavailable:['Tickety teď nejdou načíst ani uložit.','Tickets cannot be loaded or saved right now.'],
};
const SEARCH_MESSAGES={
 invalid:['Neplatné hledání (nejvýš 200 znaků, kind ticket|review, limit 1–100).','Invalid search (200 characters at most, kind ticket|review, limit 1-100).'],
 unavailable:['Hledání teď nejde.','Search is unavailable right now.'],
};
const say=(pair,c)=>pair[c?.principal?.authKind==='api-key'?1:0];
const ticketsError=(e,c)=>[({'too-large':413,invalid:400,'not-found':404,conflict:409,limit:409})[e.message]||503,'TICKETS_FAILED',say(TICKET_MESSAGES[e.message]||TICKET_MESSAGES.unavailable,c)];
const searchError=(e,c)=>[e.message==='invalid'?400:503,'SEARCH_FAILED',say(SEARCH_MESSAGES[e.message]||SEARCH_MESSAGES.unavailable,c)];
// The write log names what a write touched; a failed write names nothing (never rejected argument text).
const write=(path,status,run)=>({method:'POST',path,scope:'tickets:write',error:ticketsError,async handler(c){c.subject=null;const saved=await run(c);c.subject=saved.subject;return c.json(typeof status==='function'?status(c):status,saved.body);}});
const who=c=>c.principal.username;
// Names the assignee field offers: sign-in accounts and service accounts that are not disabled, then every
// name the tickets already carry. Only names and counts leave the server, never ids, roles or scopes.
async function people({state,hub}){
 const out=new Map(),add=(name,kind)=>{if(typeof name==='string'&&name&&!out.has(name))out.set(name,{name,kind,assigned:0,active:0});};
 try{for(const u of hub.accessStore?.users?.()||[])if(!u.disabled)add(u.username,'user');}catch{}
 try{for(const a of hub.accessStore?.accounts?.()||[])if(!a.disabled)add(a.name,'agent');}catch{}
 for(const p of await state.tickets.people()){add(p.name,'other');Object.assign(out.get(p.name),{assigned:p.assigned,active:p.active});}
 return [...out.values()].sort((a,b)=>b.active-a.active||b.assigned-a.assigned||a.name.localeCompare(b.name,'en')).slice(0,200);
}
// What a search hit is right now (a ticket's status, a review set's state), so a result list can show it
// without one request per hit. The index itself only knows the text.
async function describeHits(results,{state,hub}){
 if(!results.length)return results;
 const tickets=results.some(r=>r.kind==='ticket')?new Map((await state.tickets.list()).tickets.map(t=>[t.id,t])):new Map();
 let sets=new Map();
 if(results.some(r=>r.kind==='review'))try{sets=new Map((await hub.state('review').review.list({status:'all'})).sets.map(s=>[s.id,s]));}catch{}
 return results.map(r=>{
  const t=r.kind==='ticket'?tickets.get(r.id):null,s=r.kind==='review'?sets.get(r.id):null;
  return {...r,...(t?{meta:{status:t.status,type:t.type,priority:t.priority,assignee:t.assignee,release:t.release}}:{}),
   ...(s?{meta:{status:s.status,done:s.done,feedbackPending:s.feedbackPending,round:s.round.n,items:s.round.items,decided:s.round.decided}}:{})};
 });
}
const SEARCH_ARGS=['query','project','status','type','priority','release','assignee','label','limit'];

export default {
 id:'tracker',title:'Project Tracker',
 mcpInstructions:[
  'Tracker: tickets_list shows projects, releases and tickets by field filters. ticket_search finds tickets by words, comments included; search looks through tickets and review sets together. ticket_get returns one ticket with its rev, comments and attachments (ticket_attachment_get reads one).',
  {scope:'tickets:write',text:'With tickets:write: ticket_create, ticket_update (pass the rev from ticket_get), ticket_comment, and release_save and project_save (omit rev to create, pass it to change).'},
 ],
 assets:['tracker-view.js','tracker-md.js','search-view.js','tickets.css','i18n-en-tracker.js'],
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
  // Full-text search inside tickets with the list's field filters (status, assignee, label, release, …).
  {method:'GET',path:'/api/tickets/search',error:ticketsError,handler:async c=>c.json(200,await c.state.tickets.search(c.query))},
  {method:'GET',path:'/api/tickets/people',error:ticketsError,handler:async c=>c.json(200,{people:await people(c)})},
  // An attachment: images and plain text inline, everything else as a download; always sandboxed and nosniff.
  {method:'GET',match:/^\/api\/tickets\/([A-Z][A-Z0-9]{1,9}-[1-9][0-9]{0,5})\/attachments\/([0-9a-f-]{36})$/,error:ticketsError,async handler({params,url,res,state}){
    const a=await state.tickets.attachment(params[1],params[2]),f=await state.ticketFiles.read(a.sha256),show=inlineFile(a.type)&&url.searchParams.get('download')!=='1';
    res.setHeader('Content-Security-Policy',"sandbox; default-src 'none'; style-src 'unsafe-inline'");res.setHeader('Cache-Control','private, max-age=31536000, immutable');
    res.writeHead(200,{'Content-Type':a.type==='text/plain'?'text/plain; charset=utf-8':show?a.type:'application/octet-stream','Content-Length':f.size,
     'Content-Disposition':`${show?'inline':'attachment'}; filename="${a.name.replace(/[^\x20-\x7e]/g,'_')}"; filename*=UTF-8''${encodeURIComponent(a.name)}`});
    try{await pipeline(createReadStream(f.path),res);}catch{res.destroy();}}},
  {method:'GET',match:/^\/api\/tickets\/(.*)$/,error:ticketsError,async handler({params,json,state}){if(!TICKET_ID.test(params[1]))throw new Error('not-found');return json(200,await state.tickets.get(params[1]));}},
  // Full-text search over tickets and review sets (title, description, comments, notes); plain words, diacritics ignored.
  // `indexed` counts what the index holds per kind (0 everywhere = nothing to search yet); each hit carries `meta`.
  {method:'GET',path:'/api/search',error:searchError,async handler(c){const {query,json,hub}=c;if(Object.keys(query).some(k=>!['q','kind','project','limit'].includes(k)))throw new Error('invalid');
    const found=hub.db.search({...query,limit:query.limit===undefined?20:query.limit});
    return json(200,{...found,results:await describeHits(found.results,c),indexed:hub.db.searchStats()});}},
 ],
 mcpTools:[
  {name:'ticket_search',scope:'read',title:'Tickets: full-text search with filters',
   description:'Find tickets by words in their title, description, comments, attachment names, labels, refs or people, narrowed by the same field filters as tickets_list. Plain words, never query syntax: every word must match as a prefix, and case and diacritics are ignored. Best match first. Each ticket comes as in tickets_list plus snippet, the matching text with the matched words wrapped in \\u0001…\\u0002. Use tickets_list when you only filter by fields, and search to look in review sets too.',
   inputSchema:{type:'object',properties:{
    query:{type:'string',minLength:1,maxLength:200,description:'Words to look for, e.g. "login timeout".'},
    project:{type:'string',maxLength:40,description:'Project id.'},
    status:{type:'string',maxLength:60,description:'open, in-progress, done, cancelled, or "active" (open + in-progress); comma-separated for several.'},
    type:{type:'string',enum:[...TICKET_TYPES]},priority:{type:'string',enum:[...TICKET_PRIORITIES]},
    release:{type:'string',maxLength:40,description:'Release version, or "none" for tickets without a release.'},
    assignee:{type:'string',maxLength:60,description:'Assignee name, or "none" for unassigned tickets.'},
    label:{type:'string',maxLength:30},
    limit:{type:'integer',minimum:1,maximum:100,description:'Maximum tickets (default 20).'}},required:['query'],additionalProperties:false},
   annotations:{readOnlyHint:true,openWorldHint:false},
   async run(args,{state}){
    if(Object.keys(args).some(k=>!SEARCH_ARGS.includes(k))||typeof args.query!=='string'||args.limit!==undefined&&!Number.isInteger(args.limit))throw toolError('Invalid ticket search: use query, project, status, type, priority, release, assignee, label and an integer limit.');
    const {query,...filter}=args;
    try{return await state.tickets.search({...filter,q:query});}
    catch(e){throw toolError(e.message==='invalid'?'Invalid ticket search: query needs at least one letter or digit (at most 200 characters), limit is 1-100, and the filters take the same values as tickets_list.':'Tickets are not available right now.');}
   }},
 ],
 // Rows for the API reference (Users and API); the first card of the same title already lists the basic routes.
 apiDocs:[
  {title:'Project Tracker',routes:[
   ['GET','/api/tickets/search?q=&status=&assignee=&label=&release=','read','Fulltext v ticketech (i komentáře) se stejnými filtry jako seznam.'],
   ['GET','/api/tickets/people','read','Jména pro pole Řeší: účty, servisní účty a lidé z ticketů.'],
   ['PUT','/api/tickets/<ID>/attachments?name=','tickets:write','Příloha ticketu: soubor jako application/octet-stream, nejvýš 20 MB.'],
   ['GET','/api/tickets/<ID>/attachments/<id>','read','Soubor přílohy; obrázky a text přímo, ostatní ke stažení.']]},
  {title:'Hledání',routes:[['GET','/api/search?q=&kind=ticket|review&project=&limit=','read','Fulltext přes tickety a review; slova jako předpony, bez diakritiky.']]},
 ],
};
