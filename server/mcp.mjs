// Home Hub MCP endpoint: POST /mcp, Streamable HTTP transport answered with plain JSON (stateless,
// no session id, no server-initiated stream). Agents authenticate with a service-account key
// (Authorization: Bearer hhk_…). tools/list shows only what the key's scopes allow and
// tools/call checks the scope again. Every call of a write tool is logged (access-store logApi).
// The tools below are core; a plugin adds its own through mcpTools in its module definition
// (server/plugins.mjs), each with a run(args, {principal, state, hub}) function. The initialize
// instructions are assembled from the modules' mcpInstructions, so a plugin describes its own tools.
import {entryHash,entryInput} from '../scripts/knowledge-edit.mjs';
import {TICKET_ID,TICKET_TYPES,TICKET_STATUSES,TICKET_PRIORITIES,RELEASE_STATUSES,PROJECT_TYPES} from './tickets-store.mjs';
import {readFile} from 'node:fs/promises';
import {REVIEW_ID,REVIEW_KINDS,LIMITS as REVIEW_LIMITS} from './review-store.mjs';
import {SCOPES} from './scopes.mjs';

export const MCP_PROTOCOLS=Object.freeze(['2025-11-25','2025-06-18','2025-03-26']);
const ID=/^[a-z][a-z0-9-]{0,63}$/;
const text=(v,n=200)=>typeof v==='string'?v.slice(0,n):'';
const round=(v,d=0)=>Number.isFinite(v)?Math.round(v*10**d)/10**d:null;
const gb=b=>Number.isFinite(b)?round(b/1e9,1):null;

const TICKET_PROPS={
 title:{type:'string',minLength:1,maxLength:200},description:{type:'string',maxLength:12000,description:'What and why: steps to reproduce, acceptance criteria, notes. Shown as light Markdown (lists, **bold**, `code`, ``` fences, links); ticket ids such as APP-12 become links.'},
 type:{type:'string',enum:[...TICKET_TYPES]},status:{type:'string',enum:[...TICKET_STATUSES]},priority:{type:'string',enum:[...TICKET_PRIORITIES]},
 release:{type:['string','null'],maxLength:40,description:'Version of an existing release in the project, or null for unplanned.'},
 assignee:{type:['string','null'],maxLength:60,description:'Who works on it: the name of a user or service account of this hub (free text is accepted); null for nobody. The word none is reserved for filtering.'},
 labels:{type:'array',maxItems:10,items:{type:'string',pattern:'^[a-z0-9][a-z0-9-]{0,29}$'},description:'Lowercase tags (a-z, 0-9, hyphen), e.g. ui, api, docs.'},
 refs:{type:'array',maxItems:20,items:{type:'string',minLength:1,maxLength:300},description:'Commits, pull-request links, related ticket ids.'}};

export const MCP_TOOLS=Object.freeze([
 {name:'home_status',scope:'read',title:'Home Hub: machine status',
  description:'Current state of the machines this Home Hub watches (computers, NAS, router): online/offline, CPU and GPU load in %, chip temperature in °C, memory in GB and running services.',
  inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,openWorldHint:false}},
 {name:'inventory_search',scope:'read',title:'Home inventory: search',
  description:'Search the home inventory (machines, runtimes/services, tools, models, network, outside services). Matches id, name, kind, machine, address and notes. Returns id, kind, name, machine, address and the entry hash.',
  inputSchema:{type:'object',properties:{
   query:{type:'string',minLength:1,maxLength:100,description:'Text to look for, e.g. a service name, a port such as "8081" or a machine id.'},
   kind:{type:'string',maxLength:40,description:'Only entries of this kind, e.g. machine, runtime, tool.'},
   machine:{type:'string',maxLength:64,description:'Only entries on this machine id, e.g. server or nas.'},
   limit:{type:'integer',minimum:1,maximum:50,description:'Maximum results (default 20).'}},required:['query'],additionalProperties:false},
  annotations:{readOnlyHint:true,openWorldHint:false}},
 {name:'inventory_get',scope:'read',title:'Home inventory: read entry',
  description:'Read one inventory entry in full, with its hash (needed for inventory_update) and the entries that depend on it or run on it.',
  inputSchema:{type:'object',properties:{id:{type:'string',pattern:ID.source,description:'Entry id, e.g. server-llama-swap.'}},required:['id'],additionalProperties:false},
  annotations:{readOnlyHint:true,openWorldHint:false}},
 {name:'inventory_update',scope:'inventory:write',title:'Home inventory: create or replace entry',
  description:'Create or replace one whole inventory entry. To change an existing entry, call inventory_get, edit the returned entry and pass its hash as base; if the entry changed in between, the update is refused and you must read it again. Omit base only to create a new entry. The checker rejects invalid entries and anything that looks like a secret: record where a password, token or key is stored, never its value.',
  inputSchema:{type:'object',properties:{
   entry:{type:'object',description:'The complete entry (id, kind, name, machine, address, version, depends_on, notes, …).'},
   base:{type:'string',pattern:'^[a-f0-9]{64}$',description:'Hash from inventory_get. Required when the entry already exists.'}},required:['entry'],additionalProperties:false},
  annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false}},
 {name:'tickets_list',scope:'read',title:'Tickets: list',
  description:'List tickets with field filters, plus every project and release (releases carry per-status ticket counts over all their tickets). Sorted by status, then priority, then latest change; total is the number of matches before limit. Tickets come without comment text, history or attachments (comments and attachments are counts); use ticket_get for the full record and its rev, and ticket_search to look for words in comments too.',
  inputSchema:{type:'object',properties:{
   project:{type:'string',maxLength:40,description:'Project id as listed in projects, e.g. my-app.'},
   status:{type:'string',maxLength:60,description:'open, in-progress, done, cancelled, or "active" (open + in-progress); comma-separated for several.'},
   type:{type:'string',enum:[...TICKET_TYPES]},priority:{type:'string',enum:[...TICKET_PRIORITIES]},
   release:{type:'string',maxLength:40,description:'Release version, or "none" for unplanned tickets.'},
   assignee:{type:'string',maxLength:60,description:'Assignee name, or "none".'},label:{type:'string',maxLength:30},
   query:{type:'string',maxLength:100,description:'Text contained in the id, title, description or a label (case-insensitive substring).'},
   limit:{type:'integer',minimum:1,maximum:200,description:'Maximum tickets (default 50).'}},additionalProperties:false},
  annotations:{readOnlyHint:true,openWorldHint:false}},
 {name:'ticket_get',scope:'read',title:'Tickets: read one',
  description:'Read one ticket in full: description, comments, attachments (metadata), change history and rev (needed for ticket_update).',
  inputSchema:{type:'object',properties:{id:{type:'string',pattern:TICKET_ID.source,description:'Ticket id: the project key, a hyphen and a number, e.g. APP-12.'}},required:['id'],additionalProperties:false},
  annotations:{readOnlyHint:true,openWorldHint:false}},
 {name:'ticket_create',scope:'tickets:write',title:'Tickets: create',
  description:'File a new ticket in an existing project (create the project first with project_save). Defaults: type task, status open, priority normal. A release must already exist in that project (see tickets_list → releases, or create it with release_save). Returns the new ticket with its id and rev.',
  inputSchema:{type:'object',properties:{...TICKET_PROPS,project:{type:'string',maxLength:40,description:'Project id as listed by tickets_list → projects, e.g. my-app.'}},required:['project','title'],additionalProperties:false},
  annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false}},
 {name:'ticket_update',scope:'tickets:write',title:'Tickets: change fields',
  description:'Change fields of a ticket (status, release, assignee, …). Pass only the fields to change and the rev from ticket_get; if the ticket changed in between, the update is refused and you must read it again. Pass null to clear release or assignee. Every change is recorded in the ticket history.',
  inputSchema:{type:'object',properties:{id:{type:'string',pattern:TICKET_ID.source},rev:{type:'integer',minimum:1,description:'rev from ticket_get.'},...TICKET_PROPS},required:['id','rev'],additionalProperties:false},
  annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false}},
 {name:'ticket_comment',scope:'tickets:write',title:'Tickets: add comment',
  description:'Add a comment to a ticket, e.g. what was done, the commit or a finding (light Markdown, as in the description). Comments need no rev and cannot be edited or removed.',
  inputSchema:{type:'object',properties:{id:{type:'string',pattern:TICKET_ID.source},text:{type:'string',minLength:1,maxLength:8000}},required:['id','text'],additionalProperties:false},
  annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false}},
 {name:'release_save',scope:'tickets:write',title:'Tickets: create or change a release',
  description:'Create a release (a version tickets can be planned into) in a project, or change one. Omit rev to create; to change an existing release pass the rev shown in tickets_list → releases. Setting status "released" stamps today as releasedAt unless you pass one; "planned" clears it. Dates are YYYY-MM-DD.',
  inputSchema:{type:'object',properties:{project:{type:'string',maxLength:40},version:{type:'string',pattern:'^(?!none$)[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$',description:'e.g. 2.4 or v0.5.0.'},
   status:{type:'string',enum:[...RELEASE_STATUSES]},targetDate:{type:['string','null'],pattern:'^\\d{4}-\\d{2}-\\d{2}$'},releasedAt:{type:['string','null'],pattern:'^\\d{4}-\\d{2}-\\d{2}$'},notes:{type:'string',maxLength:2000},rev:{type:'integer',minimum:1}},required:['project','version'],additionalProperties:false},
  annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false}},
 {name:'project_save',scope:'tickets:write',title:'Tickets: create or change a project',
  description:'Create a project (id, key, name, type) or change the name, description or type of an existing one. The key is the ticket prefix (key APP → tickets APP-1, APP-2, …); id and key can never change, and both must be unused. Omit rev to create; to change a project pass the rev shown in tickets_list → projects.',
  inputSchema:{type:'object',properties:{id:{type:'string',pattern:'^[a-z][a-z0-9-]{1,39}$',description:'Lowercase id used in URLs and filters, e.g. my-app.'},key:{type:'string',pattern:'^[A-Z][A-Z0-9]{1,9}$',description:'Ticket prefix: 2-10 capital letters or digits, e.g. APP. Required when creating.'},
   name:{type:'string',minLength:1,maxLength:80},description:{type:'string',maxLength:500},type:{type:['string','null'],enum:[...PROJECT_TYPES,null],description:'app, game or other; decides which kind of review variants a set opens on.'},rev:{type:'integer',minimum:1}},required:['id'],additionalProperties:false},
  annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false}},
 {name:'ticket_attachment_get',scope:'read',title:'Tickets: read an attachment',
  description:'Read a file attached to a ticket (ids come from ticket_get → attachments). Images up to 5 MB come back as an image, plain-text files up to 256 kB as text; anything else returns only its metadata and download path.',
  inputSchema:{type:'object',properties:{id:{type:'string',pattern:TICKET_ID.source,description:'Ticket id, e.g. APP-12.'},attachment:{type:'string',pattern:'^[0-9a-f-]{36}$'}},required:['id','attachment'],additionalProperties:false},
  annotations:{readOnlyHint:true,openWorldHint:false}},
 {name:'search',scope:'read',title:'Home Hub: full-text search',
  description:'Full-text search across tickets (id, title, description, comments, attachment names, labels, refs, people) and review sets (title, description, round notes, item and variant texts, decisions and comments). Plain words, never query syntax: every word must match as a prefix; case and diacritics are ignored (resume finds Résumé). Best match first, a title hit above a body hit; matched words are wrapped in \\u0001…\\u0002 in title and snippet. Use ticket_get or review_get for the full record, and ticket_search to narrow tickets by status, assignee, label or release.',
  inputSchema:{type:'object',properties:{query:{type:'string',minLength:1,maxLength:200,description:'Up to 12 words.'},kind:{type:'string',enum:['ticket','review'],description:'Only tickets or only review sets.'},project:{type:'string',maxLength:40,description:'Project id.'},limit:{type:'integer',minimum:1,maximum:100,description:'Maximum results (default 20).'}},required:['query'],additionalProperties:false},
  annotations:{readOnlyHint:true,openWorldHint:false}},
 {name:'review_list',scope:'read',title:'Review: list sets',
  description:'Review sets: variants (HTML mockups, images, 3D models) published for a project so that a person can compare them and decide, with those decisions. Newest change first. Filter by project or ticket; feedbackPending:true returns only sets whose latest round has decisions or comments newer than that round, i.e. feedback waiting for the publisher. Use review_get for the content.',
  inputSchema:{type:'object',properties:{project:{type:'string',maxLength:40,description:'Project id.'},ticket:{type:'string',pattern:TICKET_ID.source,description:'Only sets linked to this ticket.'},status:{type:'string',enum:['open','active','done','archived','all'],description:'open (default) = not archived; active = open and not yet decided; done = open with a variant taken for every item.'},feedbackPending:{type:'boolean'}},additionalProperties:false},
  annotations:{readOnlyHint:true,openWorldHint:false}},
 {name:'review_get',scope:'read',title:'Review: read one set',
  description:'One review set with one round (latest by default): items, their variants and media, and per item the decision: chosen variant, status (accept = take it as is; revise = take it and apply the comments; reject = none fits, propose new variants; pending = undecided) and comments. For an item with mode approve there is no chosen variant: approvals maps each variant to approved or changes (apply the comments on that variant), and status is accept when all are approved, revise when any has changes. An HTML comment anchor names the element (data-mock-id, CSS selector, the start of its outerHTML, document x/y in the mockup viewport); an image anchor is a point as 0..1 fractions; a 3D model anchor (kind surface) is the hit point and its normal in the model\'s own coordinates (glTF, metres, Y up), the camera pose (theta/phi in radians, radius in metres, target, fov in degrees), and what was hit: node (glTF node path, root first, \" / \" separated), mesh and material names, plus the playing animation and its time if any. A decision\'s note and each comment may carry links and attachments (screenshots, with url); a reject explains in them what to redo. unaddressed lists comments of earlier rounds that no later round listed in addresses.',
  inputSchema:{type:'object',properties:{id:{type:'string',pattern:REVIEW_ID.source,description:'Set id, e.g. R-3.'},round:{type:'integer',minimum:1,description:'Round number; the latest when omitted.'}},required:['id'],additionalProperties:false},
  annotations:{readOnlyHint:true,openWorldHint:false}},
 {name:'review_publish',scope:'review:write',title:'Review: publish a set or a new round',
  description:'Publish variants for a person to review. Omit set to create a new set (project and title required; the project must exist in the tracker); pass set to publish its next round (e.g. after feedback) and list in addresses the comment ids this round answers. Each item has one kind (html, image or model) and 1-6 variants a-f; all variants of an item are shown side by side. Each item has a mode: choose (default) = the variants are alternatives and the reviewer takes one; approve = every variant is its own deliverable (e.g. the screens of one flow, a set of icons) that the reviewer approves or sends back one by one. Mark a variant reference:true when it is only for comparison (e.g. what is in production now): it can be commented on but not taken or approved. HTML mockups must be one self-contained file (inline CSS/JS, images and fonts as data: URIs; no network) and should mark meaningful elements with data-mock-id. Pass small HTML inline as media {type:"text/html", html}; upload images and larger files first with scripts/review-push.mjs (or PUT /api/review/blobs/<sha256>) and reference them by sha256. A model is a binary glTF (.glb, type model/gltf-binary, at most 128 MiB, no Draco/meshopt/KTX2 compression) and may carry poster {sha256, type} — a rendered png/jpeg/webp used as the card cover. Returns the set summary with its id.',
  inputSchema:{type:'object',properties:{
   project:{type:'string',maxLength:40},set:{type:'string',pattern:REVIEW_ID.source},title:{type:'string',minLength:1,maxLength:160},description:{type:'string',maxLength:4000},
   tickets:{type:'array',maxItems:20,items:{type:'string',pattern:TICKET_ID.source}},notes:{type:'string',maxLength:4000,description:'What this round changes.'},
   addresses:{type:'array',maxItems:500,items:{type:'string',maxLength:64}},
   items:{type:'array',minItems:1,maxItems:REVIEW_LIMITS.items,items:{type:'object',required:['id','title','kind','variants'],additionalProperties:false,properties:{
    id:{type:'string',pattern:'^[a-z0-9][a-z0-9-]{0,39}$'},title:{type:'string',minLength:1,maxLength:160},description:{type:'string',maxLength:4000},kind:{type:'string',enum:[...REVIEW_KINDS]},mode:{type:'string',enum:['choose','approve']},
    variants:{type:'array',minItems:1,maxItems:REVIEW_LIMITS.variants,items:{type:'object',required:['id','media'],additionalProperties:false,properties:{
     id:{type:'string',pattern:'^[a-f]$'},label:{type:'string',maxLength:40},reference:{type:'boolean'},title:{type:'string',maxLength:160},description:{type:'string',maxLength:4000},
     media:{type:'array',minItems:1,maxItems:REVIEW_LIMITS.media,items:{type:'object',required:['type'],additionalProperties:false,properties:{
      type:{type:'string',enum:['text/html','image/png','image/jpeg','image/webp','image/gif','model/gltf-binary']},poster:{type:'object',required:['sha256','type'],additionalProperties:false,properties:{sha256:{type:'string',pattern:'^[a-f0-9]{64}$'},type:{type:'string',enum:['image/png','image/jpeg','image/webp']}}},sha256:{type:'string',pattern:'^[a-f0-9]{64}$'},html:{type:'string',maxLength:REVIEW_LIMITS.inlineHtml},
      name:{type:'string',maxLength:200},caption:{type:'string',maxLength:1000},viewport:{type:'object',properties:{width:{type:'integer',minimum:200,maximum:3840},height:{type:'integer',minimum:200,maximum:4000}},required:['width','height'],additionalProperties:false}}}}}}}}}}},
   additionalProperties:false},
  annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false}},
]);

// What a person may read about the tools (Users and API → Connect, from the UI manifest): the name, the
// title, the scope a key needs, whether that scope writes, the description written for agents and the
// module that registered the tool. Never the run functions, and no input schemas: tools/list has those.
// extraTools: the tools modules registered (registry.tools), in the order tools/list returns them.
export const toolCatalog=(extraTools=[])=>[...MCP_TOOLS.map(t=>({...t,module:'core'})),...extraTools]
 .map(t=>({name:t.name,title:typeof t.title==='string'&&t.title?t.title:t.name,scope:t.scope,write:!SCOPES[t.scope]?.readOnly,description:t.description,module:t.module}));

class ToolError extends Error{}
// Ticket subjects come from successful store results, never rejected argument text.
const subjectOf=(tool,args,data)=>tool==='inventory_update'?(typeof args.entry?.id==='string'&&ID.test(args.entry.id)?args.entry.id:undefined):data?.id||data?.project;

/**
 * ctx.home(): Promise<home payload>; ctx.inventory.read(): Promise<doc|null>;
 * ctx.inventory.put(change): Promise<{ok,entry,hash,published,errors}>; ctx.log(entry): Promise
 */
export function createMcp({version='2',ctx,tools:extraTools=[],instructions=[]}){
 const allowed=(principal,tool)=>principal.scopes.includes(tool.scope);
 // What an agent reads when it connects: what this is, who it is here, then a few lines per module that has
 // something to say (mcpInstructions in the module definitions, core and plugins alike, in load order).
 // A part that names a scope is left out for a key without it, so nothing points at a tool the key cannot see.
 const orientation=principal=>{
  const lines=new Map();
  for(const part of instructions)if(!part.scope||principal.scopes.includes(part.scope))lines.set(part.module,[...(lines.get(part.module)||[]),part.text]);
  return [`Home Hub: one site's machines and their runtime stacks, an inventory of what runs where, a project tracker and design review, kept current by people and agents. You are service account "${principal.username}" with scopes: ${principal.scopes.join(', ')}. tools/list shows only what these scopes allow.${principal.permission==='write'?' Read a thing before you change it: the change takes the hash or rev you read and is refused when that is stale; then read again, never force. Never store a secret (password, token, key) here: record where it is kept.':''}`,
   ...[...lines.values()].map(parts=>parts.join(' '))].join('\n');
 };
 // Core tools first, then the tools modules registered; a name can only be claimed once (checked by the registry).
 const TOOLS=[...MCP_TOOLS,...extraTools.map(({run,module,...tool})=>tool)];
 if(new Set(TOOLS.map(t=>t.name)).size!==TOOLS.length)throw new Error('MCP tool names must be unique');
 const extraRun=Object.fromEntries(extraTools.map(t=>[t.name,(args,principal)=>t.run(args,{principal,...ctx.moduleContext?.(t.module)})]));
 const run={...extraRun,
  async home_status(){
   const home=await ctx.home();
   return {generatedAt:home.generatedAt||null,machines:(home.machines||[]).map(m=>({id:m.id,name:m.name,ip:m.ip||null,online:m.online||'unknown',
    cpuPercent:round(m.quad?.cpu),gpuPercent:round(m.quad?.gpu),chipTempC:round(m.quad?.temp),
    memoryUsedGb:gb(m.quad?.memUsed??m.memoryUsedBytes),memoryTotalGb:gb(m.quad?.memTotal??m.memoryTotalBytes),
    services:(m.services||[]).map(s=>({id:s.id,name:s.name,status:s.status||null})).slice(0,30)}))};
  },
  async inventory_search(args){
   const query=text(args.query,100).toLowerCase().trim();if(!query)throw new ToolError('query must not be empty.');
   const limit=Number.isInteger(args.limit)?Math.min(50,Math.max(1,args.limit)):20;
   const doc=await inventory();
   const hits=doc.entries.filter(e=>(!args.kind||e.kind===args.kind)&&(!args.machine||e.machine===args.machine)&&
    [e.id,e.name,e.kind,e.machine,e.address,e.notes,e.category].filter(v=>typeof v==='string').join('\n').toLowerCase().includes(query));
   return {updatedAt:doc.updated_at||null,count:hits.length,entries:hits.slice(0,limit).map(e=>({id:e.id,kind:e.kind,name:e.name,machine:e.machine||null,address:e.address||null,hash:entryHash(e)}))};
  },
  async inventory_get(args){
   if(typeof args.id!=='string'||!ID.test(args.id))throw new ToolError('id must be an inventory id such as server-llama-swap.');
   const doc=await inventory(),entry=doc.entries.find(e=>e.id===args.id);
   if(!entry)throw new ToolError(`No inventory entry "${args.id}". Use inventory_search to find the right id.`);
   const dependents=doc.entries.flatMap(e=>[...(Array.isArray(e.depends_on)?e.depends_on.filter(d=>d?.id===entry.id).map(d=>({id:e.id,via:d.kind||'depends_on'})):[]),...(e.machine===entry.id?[{id:e.id,via:'runs-on'}]:[])]).slice(0,100);
   return {entry,hash:entryHash(entry),dependents};
  },
  async inventory_update(args,principal){
   let change;try{change=entryInput({entry:args.entry,...(args.base!==undefined?{base:args.base}:{})});}
   catch{throw new ToolError('Invalid request: entry must be an object with a valid id (lowercase letters, digits, hyphens), and base must be a 64-character hash.');}
   let result;
   try{result=await ctx.inventory.put(change,principal.accountId?principal.username:null);}
   catch(e){
    if(e.message==='conflict')throw new ToolError(change.base?'The entry changed since you read it, or it does not exist yet (omit base to create it). Read it again with inventory_get and reapply your change.':'An entry with this id already exists. Read it with inventory_get and pass its hash as base.');
    if(e.message==='invalid')throw new ToolError('The entry was rejected as invalid.');
    throw new ToolError('The inventory is not available right now; nothing was changed.');
   }
   if(!result?.ok)throw new ToolError(`The inventory checker rejected the entry, nothing was changed: ${(result?.errors||[]).map(String).slice(0,10).join('; ')||'invalid entry'}`);
   return {ok:true,id:result.entry?.id||change.entry.id,hash:result.hash,published:result.published!==false,by:principal.username};
  },
  async tickets_list({query,limit=50,...args}){
   if(!Number.isInteger(limit)||limit<1||limit>200||'q'in args)throw new ToolError('Invalid ticket filters: limit must be an integer from 1 to 200; use query for text search.');
   const data=await tickets(t=>t.list({...args,...(query!==undefined?{q:query}:{}),limit}));
   return {...data,releases:data.releases.map(({createdBy,createdAt,...r})=>r)};
  },
  ticket_get:args=>{if(Object.keys(args).some(k=>k!=='id'))throw new ToolError('Invalid ticket request.');return tickets(t=>t.get(args.id));},
  ticket_create:(args,principal)=>tickets(t=>t.create(args,principal.username)),
  ticket_update:(args,principal)=>tickets(t=>t.update(args,principal.username)),
  ticket_comment:(args,principal)=>tickets(t=>t.comment(args,principal.username)),
  release_save:(args,principal)=>tickets(t=>t.saveRelease(args,principal.username)),
  project_save:(args,principal)=>tickets(t=>t.saveProject(args,principal.username)),
  async ticket_attachment_get({id,attachment,...rest}){
   if(Object.keys(rest).length)throw new ToolError('Invalid attachment request.');
   const a=await tickets(t=>t.attachment(id,attachment));if(!ctx.ticketFiles)throw new ToolError('Attachments are not available on this Home Hub.');
   const meta={id:a.id,ticket:id,name:a.name,type:a.type,size:a.size,by:a.by,at:a.at,url:`/api/tickets/${id}/attachments/${a.id}`};
   let f;try{f=await ctx.ticketFiles.read(a.sha256);}catch{throw new ToolError('The attachment file is missing on the server.');}
   if(a.type.startsWith('image/')&&f.size<=5*1024*1024)return {mcpContent:[{type:'text',text:JSON.stringify(meta)},{type:'image',data:(await readFile(f.path)).toString('base64'),mimeType:a.type}],meta};
   if(a.type==='text/plain'&&f.size<=256*1024)return {mcpContent:[{type:'text',text:JSON.stringify(meta)},{type:'text',text:await readFile(f.path,'utf8')}],meta};
   return {...meta,note:'Binary or large file: only metadata is returned. Download it from url with a session or API key.'};
  },
  search({query,kind,project,limit=20,...rest}){
   if(!ctx.search)throw new ToolError('Search is not available on this Home Hub.');
   if(Object.keys(rest).length)throw new ToolError('Invalid search: use query, kind, project, limit.');
   try{return ctx.search({q:query,kind,project,limit});}catch{throw new ToolError('Invalid search: query is 1-200 characters, kind ticket|review, limit 1-100.');}
  },
  review_list:({feedbackPending,...args})=>reviews(r=>r.list({...args,...(feedbackPending?{feedback:'pending'}:{})})),
  async review_get({id,round,...rest}){
   if(Object.keys(rest).length||round!==undefined&&!Number.isInteger(round))throw new ToolError('Invalid review request.');
   const s=await reviews(r=>r.get(id)),r=round===undefined?s.rounds[s.rounds.length-1]:s.rounds.find(x=>x.n===round);
   if(!r)throw new ToolError(`Set ${s.id} has rounds 1-${s.rounds.length}.`);
   const later=new Set(s.rounds.filter(x=>x.n>r.n).flatMap(x=>x.addresses)),answered=new Set(s.rounds.flatMap(x=>x.addresses));
   const items=r.items.map(i=>({...i,variants:i.variants.map(v=>({...v,media:v.media.map(m=>({...m,url:'/api/review/blobs/'+m.sha256,...(m.poster?{poster:{...m.poster,url:'/api/review/blobs/'+m.poster.sha256}}:{})}))})),
    decision:Object.hasOwn(r.feedback,i.id)?{...r.feedback[i.id],attachments:(r.feedback[i.id].attachments||[]).map(a=>({...a,url:'/api/review/blobs/'+a.sha256})),comments:r.feedback[i.id].comments.map(c=>({...c,...(c.attachments?{attachments:c.attachments.map(x=>({...x,url:'/api/review/blobs/'+x.sha256}))}:{}),addressed:later.has(c.id)}))}:{rev:0,variant:null,status:'pending',note:'',comments:[],attachments:[]}}));
   const unaddressed=s.rounds.filter(x=>x.n<r.n).flatMap(x=>Object.entries(x.feedback).flatMap(([item,d])=>d.comments.filter(c=>!answered.has(c.id)).map(c=>({round:x.n,item,...c}))));
   return {id:s.id,project:s.project,title:s.title,description:s.description,tickets:s.tickets,status:s.status,feedbackPending:s.feedbackPending,
    rounds:s.rounds.map(x=>({n:x.n,publishedAt:x.publishedAt,publishedBy:x.publishedBy,notes:x.notes,addresses:x.addresses.length})),
    round:{n:r.n,notes:r.notes,publishedAt:r.publishedAt,items},unaddressed,url:'#review/'+s.id};
  },
  review_publish:(args,principal)=>reviews(r=>r.publish(args,principal.username)),
 };
 const TICKET_ERRORS={invalid:'Invalid ticket request: check the field values, that the project exists and that the release exists in that project.',
  'not-found':'No such ticket or release. Use tickets_list to find the right id.',
  conflict:'It changed since you read it (or already exists). Read it again (ticket_get / tickets_list), then reapply your change with the new rev.',limit:'A ticket limit was reached; nothing was changed.'};
 async function tickets(fn){if(!ctx.tickets)throw new ToolError('Tickets are not available on this Home Hub.');try{return await fn(ctx.tickets);}catch(e){if(TICKET_ERRORS[e.message])throw new ToolError(TICKET_ERRORS[e.message]);throw new ToolError('Tickets are not available right now; nothing was changed.');}}
 const REVIEW_ERRORS={invalid:'Invalid review request: check the fields, that the project exists, that the tickets belong to it, that each media type matches its item kind and that files look like their type.',
  'missing-blob':'A referenced file is not uploaded yet. Upload it with scripts/review-push.mjs (or PUT /api/review/blobs/<sha256>), or pass small HTML inline.',
  'not-found':'No such review set or round. Use review_list to find it.',conflict:'The set is archived or changed; read it again with review_get.',limit:'A review limit was reached; nothing was changed.','too-large':'An inline HTML mockup is too large (upload it as a file instead), or a .glb model is over 128 MiB.'};
 async function reviews(fn){if(!ctx.review)throw new ToolError('Review is not available on this Home Hub.');try{return await fn(ctx.review);}catch(e){if(e instanceof ToolError)throw e;if(REVIEW_ERRORS[e.message])throw new ToolError(REVIEW_ERRORS[e.message]);throw new ToolError('Review is not available right now; nothing was changed.');}}
 async function inventory(){const doc=await ctx.inventory.read();if(!doc)throw new ToolError('The inventory has not been deployed on this Home Hub.');return doc;}

 async function dispatch(msg,principal){
  const {method,params}=msg;
  if(method==='initialize'){
   const asked=params?.protocolVersion;
   return {protocolVersion:MCP_PROTOCOLS.includes(asked)?asked:MCP_PROTOCOLS[0],capabilities:{tools:{listChanged:false}},
    serverInfo:{name:'home-hub',title:'Home Hub',version},
    instructions:orientation(principal)};
  }
  if(method==='ping')return {};
  if(method==='tools/list')return {tools:TOOLS.filter(t=>allowed(principal,t)).map(({scope,...t})=>t)};
  if(method==='tools/call'){
   const tool=TOOLS.find(t=>t.name===params?.name);
   if(!tool)throw Object.assign(new Error(`Unknown tool: ${text(params?.name,60)}`),{code:-32602});
   const args=params.arguments??{};
   if(!args||typeof args!=='object'||Array.isArray(args))throw Object.assign(new Error('arguments must be an object'),{code:-32602});
   const write=tool.scope!=='read';
   // Refused write attempts are logged too (account, tool, status only; nothing from the arguments).
   if(!allowed(principal,tool)){
    if(write)await ctx.log({key:principal.id,account:principal.accountId,name:principal.username,tool:tool.name,status:'denied'}).catch(()=>{});
    return {content:[{type:'text',text:`This service account lacks the "${tool.scope}" scope needed for ${tool.name}.`}],isError:true};
   }
   try{
    const data=await run[tool.name](args,principal);
    if(write)await ctx.log({key:principal.id,account:principal.accountId,name:principal.username,tool:tool.name,status:'ok',subject:subjectOf(tool.name,args,data)}).catch(()=>{});
    if(data?.mcpContent)return {content:data.mcpContent,structuredContent:data.meta,isError:false};
    return {content:[{type:'text',text:JSON.stringify(data,null,1)}],structuredContent:data,isError:false};
   }catch(e){
    if(write)await ctx.log({key:principal.id,account:principal.accountId,name:principal.username,tool:tool.name,status:'error',subject:subjectOf(tool.name,args)}).catch(()=>{});
    if(e instanceof ToolError||e?.toolError===true)return {content:[{type:'text',text:e.message}],isError:true};
    throw e;
   }
  }
  throw Object.assign(new Error(`Method not found: ${text(method,60)}`),{code:-32601});
 }

 // Returns {status, headers, body}; the HTTP layer does auth, origin and size checks first.
 return async function handle(raw,principal){
  let msg;try{msg=JSON.parse(raw);}catch{return reply(400,{jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}});}
  if(Array.isArray(msg))return reply(400,{jsonrpc:'2.0',id:null,error:{code:-32600,message:'Batch requests are not supported.'}});
  if(!msg||typeof msg!=='object'||msg.jsonrpc!=='2.0'||typeof msg.method!=='string'){
   if(msg&&typeof msg==='object'&&('result'in msg||'error'in msg))return {status:202};
   return reply(400,{jsonrpc:'2.0',id:msg?.id??null,error:{code:-32600,message:'Invalid Request'}});
  }
  if(!('id'in msg)||msg.id===null)return {status:202}; // notification (e.g. notifications/initialized)
  try{return reply(200,{jsonrpc:'2.0',id:msg.id,result:await dispatch(msg,principal)});}
  catch(e){return reply(200,{jsonrpc:'2.0',id:msg.id,error:{code:Number.isInteger(e.code)?e.code:-32603,message:Number.isInteger(e.code)?e.message:'Internal error'}});}
 };
}
const reply=(status,body)=>({status,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
// For a plugin tool's run(): an error whose message goes back to the agent as the tool result
// (isError: true). Anything else a tool throws is reported as an internal error.
export const toolError=message=>Object.assign(new Error(message),{toolError:true});
