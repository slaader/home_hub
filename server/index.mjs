// Home Hub HTTP server: one request pipeline (headers, who is calling, origin and scope checks, body
// limits, error replies) and a registry of modules that own the routes, pages, assets and MCP tools.
// Core features are modules in server/core/; a household adds its own as plugins under local/plugins/
// (server/plugins.mjs, docs/plugins.md). Nothing here knows about a particular household: names,
// machines and networks come from the site configuration (server/site-config.mjs).
import https from 'node:https';
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {readFileSync,readdirSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createAuth} from './auth.mjs';
import {openDb} from './db.mjs';
import {createAccessStore,apiBearerOf} from './access-store.mjs';
import {registerScopes,scopeFor,sessionOnly,useRoutes} from './scopes.mjs';
import {createMcp,MCP_TOOLS} from './mcp.mjs';
import {createDeviceTokens,bearerOf} from './device-tokens.mjs';
import {readBuild} from './build-info.mjs';
import {repoRoot,readEdition} from './edition.mjs';
import {site as loadedSite,siteConfigPath} from './site-config.mjs';
import {defineModule,createRegistry,loadPlugins} from './plugins.mjs';
import sessionModule from './core/session.mjs';
import accessModule from './core/access.mjs';
import homeModule from './core/home.mjs';
import inventoryModule from './core/inventory.mjs';
import trackerModule from './core/tracker.mjs';
import reviewModule from './core/review.mjs';
import securityModule from './core/security.mjs';

const root=repoRoot;
// The running commit, shown in the UI footer. Read once: a deploy restarts the server.
const build=readBuild(root);
// Review's 3D viewer (<model-viewer>, vendored) puts one fixed <style> block into its shadow DOM. The page CSP allows
// exactly that block by its hash instead of 'unsafe-inline'; GLB textures are decoded from blob: URLs. docs/review.md.
export const MODEL_VIEWER_STYLE_HASH=(()=>{try{const m=/<style>([\s\S]*?)<\/style>/.exec(readFileSync(path.join(root,'public','vendor','model-viewer.min.js'),'utf8'));return m?`'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`:'';}catch{return '';}})();
export const PAGE_CSP=`default-src 'self'; script-src 'self'; style-src 'self'${MODEL_VIEWER_STYLE_HASH?' '+MODEL_VIEWER_STYLE_HASH:''}; img-src 'self' blob:; connect-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`;

// Core modules, in set-up order (a later one may use the state of an earlier one).
export const CORE_MODULES=Object.freeze([sessionModule,accessModule,homeModule,inventoryModule,trackerModule,reviewModule,securityModule].map(m=>defineModule(m,{core:true})));
// Plugins found in the overlay directory when the process started.
export const STARTUP_PLUGINS=Object.freeze(await loadPlugins());
// Core + plugins as one registry; scopes of every module join the scope table (server/scopes.mjs).
export function buildRegistry(plugins=STARTUP_PLUGINS){
 const registry=createRegistry([...CORE_MODULES,...plugins.map(p=>Object.isFrozen(p)&&p.routes?p:defineModule(p))],{reservedTools:MCP_TOOLS.map(t=>t.name)});
 for(const m of registry.modules)registerScopes(m.core?'core':m.id,m.scopes);
 return registry;
}
const startupRegistry=buildRegistry();
useRoutes(startupRegistry.match);

// Pictures a site adds next to its site.json (local/images/…), served under /images/…: tile pictures of
// its own machines and the like. Listed once at start-up, so no request ever touches the file system by name.
const IMAGE_TYPES={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml'};
export function siteImages(directory){
 const out=[];if(!directory||!existsSync(directory))return out;
 const walk=(dir,prefix,depth)=>{for(const entry of readdirSync(dir,{withFileTypes:true})){
   if(!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.name)||out.length>=400)continue;
   if(entry.isDirectory()){if(depth<2)walk(path.join(dir,entry.name),`${prefix}${entry.name}/`,depth+1);}
   else if(entry.isFile()&&IMAGE_TYPES[path.extname(entry.name).toLowerCase()])out.push({module:'site',url:`/images/${prefix}${entry.name}`,file:`${prefix}${entry.name}`,type:IMAGE_TYPES[path.extname(entry.name).toLowerCase()],directory});
  }};
 walk(directory,'',0);return out;
}

/**
 * directory = data dir (knowledge.json, router-observations.json, machines/, security/, systems/);
 * stateDirectory = what the hub writes (hub.db, access.json, home/, tickets/, review/).
 * site = the site configuration (default: local/site.json); plugins = module objects to load instead of
 * the overlay found at start-up (tests). Every other option is handed to the modules as hub.options.
 */
export function createHandler(options) {
  const {directory,credentials,authFile=null,origin,allowedOrigins=(process.env.ORIGIN_ALIASES||'').split(',').filter(Boolean),secure=true,
   stateDirectory=process.env.STATE_DIR||path.join(directory,'state'),site=loadedSite(),plugins,siteImagesDirectory,
   deviceTokens=createDeviceTokens(stateDirectory),accessStore=createAccessStore(stateDirectory,credentials,{ownerFile:authFile})}=options;
  const registry=plugins?buildRegistry(plugins):startupRegistry;
  // Tickets, the review index, sign-in sessions and the search index: one SQLite file (server/db.mjs, docs/storage.md).
  const db=openDb(path.join(stateDirectory,'hub.db'));
  const auth=createAuth(credentials,{secure,accounts:accessStore,sessions:db.sessions});
  const origins=[origin,...allowedOrigins];
  const states=new Map();
  const hub={root,directory,stateDirectory,site,edition:readEdition(),origin,secure,build,options,db,auth,accessStore,deviceTokens,registry,
   state:id=>states.get(id)??null,
   // Values from every module that provides `name` (docs/plugins.md → extension points).
   collect:name=>registry.providers(name).map(p=>p.provide(states.get(p.module),hub)),
   provided:name=>{const p=registry.providers(name)[0];return p?p.provide(states.get(p.module),hub):undefined;}};
  for(const m of registry.modules)states.set(m.id,m.setup?(m.setup(hub)??{}):{});
  const assets=new Map(registry.assets);
  for(const image of siteImages(siteImagesDirectory===undefined?(options.site?null:siteConfigPath()&&path.join(path.dirname(siteConfigPath()),'images')):siteImagesDirectory)){
   if(assets.has(image.url))throw new Error(`site image ${image.url} clashes with an asset of module "${assets.get(image.url).module}"`);assets.set(image.url,image);}
  const home=states.get('home'),tracker=states.get('tracker'),inventory=states.get('inventory');
  const mcp=createMcp({version:'2',tools:registry.tools,ctx:{home:()=>home.payload(),search:q=>db.search(q),tickets:tracker.tickets,ticketFiles:tracker.ticketFiles,review:states.get('review').review,
   inventory:{read:inventory.read,put:inventory.put},log:entry=>accessStore.logApi(entry),moduleContext:id=>({state:states.get(id),hub})}});
  const handler=async (req,res) => {
    res.setHeader('Content-Security-Policy',PAGE_CSP);
    res.setHeader('X-Frame-Options','DENY');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');res.setHeader('Cache-Control','no-store');
    if (secure) res.setHeader('Strict-Transport-Security','max-age=31536000');
    const json=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
    const error=(status,code,message)=>json(status,{error:{code,message}});
    let c=null,route=null;
    try {
      const url = new URL(req.url,origin),pathname=url.pathname;
      if(req.method==='GET'&&pathname==='/healthz') return json(200,{ok:true});
      // Native clients send a device token instead of the cookie; such requests need no Origin header (browsers never attach it on their own).
      const bearer=bearerOf(req.headers.authorization),apiBearer=apiBearerOf(req.headers.authorization),device=bearer?deviceTokens.verify(bearer):null;
      const principal=apiBearer?accessStore.verifyKey(apiBearer):device?{id:device,username:'Native device',role:'admin',permission:'write',authKind:'device'}:req.headers.authorization?null:auth.principal(req.headers.cookie);
      const signedIn=Boolean(principal),canWrite=principal?.permission==='write',canAdmin=principal?.role==='admin'&&principal.authKind==='session';
      if(req.headers.authorization&&!principal&&pathname.startsWith('/api/'))return error(401,'AUTH_REQUIRED','This access credential is no longer valid. Please sign in again.');
      // MCP for agents: POST only, service-account (or legacy) API key, no browser origins.
      if(pathname==='/mcp'){
        if(req.method!=='POST'){res.setHeader('Allow','POST');return error(405,'METHOD_NOT_ALLOWED','The Home Hub MCP endpoint accepts POST only.');}
        if(req.headers.origin&&!origins.includes(req.headers.origin))return error(403,'ORIGIN_REJECTED','Request not allowed.');
        if(principal?.authKind!=='api-key'){res.setHeader('WWW-Authenticate','Bearer realm="home-hub"');return error(401,'AUTH_REQUIRED','Use a service-account key: Authorization: Bearer hhk_…');}
        if(!/^application\/json\b/.test(req.headers['content-type']||''))return error(415,'UNSUPPORTED_MEDIA_TYPE','Send JSON-RPC as application/json.');
        req.setEncoding('utf8');let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>65536)return error(413,'TOO_LARGE','Request too large.');}
        const out=await mcp(raw,principal);res.writeHead(out.status,out.headers||{});return res.end(out.body||'');
      }
      const hit=registry.match(req.method==='HEAD'?'GET':req.method,pathname);route=hit?.route||null;
      // What a route handler gets. subject = what a write touched (ticket id, entry id), for the write log.
      c={req,res,url,pathname,params:hit?.params||null,query:Object.fromEntries(url.searchParams),principal,device,signedIn,canWrite,canAdmin,input:undefined,subject:null,
       json,error,hub,state:route?states.get(route.module):null,fromBrowser:!device&&!apiBearer};
      // Write log: one line per API-key write attempt, refused ones included (route, status, entry id), never bodies or tokens.
      if(principal?.authKind==='api-key'&&req.method==='POST'&&pathname.startsWith('/api/'))res.on('finish',()=>{accessStore.logApi({key:principal.id,account:principal.accountId,name:principal.username,route:pathname,status:res.statusCode,subject:c.subject}).catch(()=>{});});
      if(pathname.startsWith('/api/admin/')&&principal&&!canAdmin)return error(403,'ADMIN_REQUIRED','Administrator password sign-in is required.');
      if(pathname.startsWith('/api/devices/tokens')&&principal&&principal.role!=='admin')return error(403,'FORBIDDEN','Device access is managed by the administrator.');
      // API keys only reach what their scopes allow (legacy read/write keys map to the same scopes as before).
      if(principal?.authKind==='api-key'&&pathname.startsWith('/api/')){const need=scopeFor(req.method,pathname,registry.match);
        if(!need&&sessionOnly(pathname))return error(403,'SESSION_REQUIRED','Tohle jde jen po přihlášení heslem.');
        if(!need||!principal.scopes.includes(need))return error(403,'SCOPE_REQUIRED',need?`This API key lacks the "${need}" scope.`:'API keys cannot use this endpoint.');}
      // Raw uploads (PUT): one file or chunk per request, streamed by the route itself.
      if(req.method==='PUT'&&route?.raw){
        res.setHeader('Connection','close');
        const browserOnly=route.scope===null; // no API keys, so a key never stands in for the Origin check
        if((!device&&!(apiBearer&&!browserOnly)&&!origins.includes(req.headers.origin))||req.headers['content-type']!==route.contentType){req.resume();return error(403,'ORIGIN_REJECTED','Request not allowed.');}
        if(!signedIn){req.resume();return error(401,'AUTH_REQUIRED','Please sign in.');}
        if(!canWrite||(browserOnly&&principal.authKind==='api-key')){req.resume();return error(403,'READ_ONLY',route.denied||'This account or API key has read-only access.');}
        return await route.handler(c);
      }
      if(req.method==='POST') {
        if((!device&&!apiBearer&&!origins.includes(req.headers.origin)) || req.headers['content-type']!=='application/json') return error(403,'ORIGIN_REJECTED','Request not allowed.');
        if(!route) return error(404,'NOT_FOUND','Not found.');
        if(!route.public&&!signedIn)return error(401,'AUTH_REQUIRED','Please sign in.');
        if(route.write&&!canWrite)return error(403,'READ_ONLY','This account or API key has read-only access.');
        req.setEncoding('utf8');let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>route.bodyLimit)return error(413,'TOO_LARGE','Request too large.');}
        if(route.parse){
          try{c.input=JSON.parse(body);}catch{return error(400,'INVALID_INPUT','Invalid request.');}
          c.subject=[c.input?.entry?.id,c.input?.id].find(v=>typeof v==='string'&&v.length<=64)||null;
        }
        return await route.handler(c);
      }
      if(req.method!=='GET'&&!(req.method==='HEAD'&&route?.head))return error(405,'METHOD_NOT_ALLOWED','Read-only endpoint.');
      // A static asset wins over a pattern route outside /api/ (a site's own tile picture over an added device's).
      const asset=pathname.startsWith('/api/')?null:assets.get(pathname);
      if(route&&!asset){
        if(!route.public&&!signedIn)return error(401,'AUTH_REQUIRED','Please sign in.');
        return await route.handler(c);
      }
      if(pathname.startsWith('/api/'))return signedIn?error(404,'NOT_FOUND','Not found.'):error(401,'AUTH_REQUIRED','Please sign in.');
      if(!asset)return error(404,'NOT_FOUND','Not found.');
      const content=await readFile(path.join(asset.directory||path.join(root,'public'),asset.file));res.writeHead(200,{'Content-Type':`${asset.type}; charset=utf-8`});res.end(content);
    }catch(e){
      if(res.headersSent)return res.destroy();
      // Each route (or its module) says what its failures mean; anything else is a plain 500.
      let mapped=null;try{mapped=c&&route?.error?.(e,c);}catch{}
      if(mapped)return error(mapped[0],mapped[1],mapped[2]);
      error(500,'UNAVAILABLE','Dashboard data is temporarily unavailable.');
    }
  };
  handler.hub=hub;handler.registry=registry;handler.state=hub.state;handler.thermo=home.thermoPoller;
  // Every background reader the modules declared (Thermo pull, plugin pollers). A failure to start is logged, not fatal.
  handler.start=()=>Promise.all(registry.pollers.map(p=>Promise.resolve().then(()=>p.start(states.get(p.module),hub)).catch(e=>console.error(`Poller ${p.module}/${p.id} failed to start:`,e.message))));
  handler.stop=()=>Promise.all(registry.pollers.filter(p=>p.stop).map(p=>Promise.resolve().then(()=>p.stop(states.get(p.module),hub)).catch(()=>{})));
  return handler;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  const directory=process.env.DATA_DIR||path.join(root,'data');
  const authFile=process.env.AUTH_FILE||path.join(root,'private/auth.json');
  const credentials=JSON.parse(await readFile(authFile,'utf8'));
  if(!/^[a-f0-9]{128}$/.test(credentials.hash)||!/^[a-f0-9]{32}$/.test(credentials.salt))throw new Error('Invalid auth configuration');
  const preview=process.env.LOCAL_PREVIEW==='1';const port=Number(process.env.PORT||8781);
  // Where browsers reach this hub: ORIGIN, else the site's publicOrigin; a local preview is its own origin.
  const origin=process.env.ORIGIN||(preview?`http://127.0.0.1:${port}`:loadedSite().publicOrigin);
  if(!origin)throw new Error('Set ORIGIN (or publicOrigin in local/site.json) to the URL browsers use, or run with LOCAL_PREVIEW=1.');
  const handler=createHandler({directory,credentials,authFile,origin,secure:!preview});
  handler.start();
  const server=(preview||process.env.HTTP_BEHIND_PROXY==='1')?http.createServer(handler):https.createServer({key:await readFile(process.env.TLS_KEY||path.join(root,'private/server.key')),cert:await readFile(process.env.TLS_CERT||path.join(root,'private/server.crt')),minVersion:'TLSv1.2'},handler);
  server.requestTimeout=10000;server.headersTimeout=10000;
  server.listen(port,process.env.BIND_HOST||(preview?'127.0.0.1':'0.0.0.0'),()=>console.info(`Home Hub (${readEdition()} edition, ${startupRegistry.modules.filter(m=>!m.core).length} plugin(s)) listening on ${port}`));
}
