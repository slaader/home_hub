// What the inventory pages share: the vocabulary (labels for kinds, categories, dependency kinds, secret
// stores), the fetched document with its per-entry hashes, and the calls that change it. The map
// (inventory-view.js), the table (inventory-table.js), the services catalog (inventory-services.js) and
// the entry dialog (inventory-entry.js) all read from here, so one edit refreshes them all.
import {t} from './i18n.js';
import {onSessionReset,currentPrincipal,authGuard} from './session-cache.js';
import {site} from './site.js';
import {placesOf,DEFAULT_CATEGORY,TEMPLATE_PREFIX} from './inventory-rules.js';

// Labels are Czech source text: pass them through t() when drawing.
export const KIND={network:'Síť',machine:'Stroj',runtime:'Služba',tool:'Nástroj','model-store':'Úložiště modelů','skill-store':'Úložiště skillů','secret-store':'Úložiště tajemství',external:'Vnější služba','secret-item':'Položka tajemství'};
export const GROUPS={runtime:'Služby',tool:'Nástroje','model-store':'Úložiště modelů','skill-store':'Úložiště skillů','secret-store':'Úložiště tajemství'};
// Dependency kinds: runs-on is implied by an entry's machine; the rest are recorded in depends_on.
export const DEPS={'runs-on':'Běží na',call:'Volá',data:'Používá data',secret:'Potřebuje tajemství',cert:'Potřebuje certifikát'};
export const DEP_HELP={'runs-on':'Stroj, na kterém běží (pole machine)',call:'Volá ho po síti nebo přes API',data:'Čte jeho soubory: váhy, dumpy, složky',secret:'Bere si od něj přihlašovací údaj',cert:'Bere si od něj TLS certifikát'};
// Categories colour the map cards; the same list is CATEGORIES in inventory-rules.js.
export const CATS=[['hardware','Hardware'],['network','Síť'],['service','Služby'],['model','Modely'],['tool','Nástroje'],['llm-support','Podpora LLM'],['saas','SaaS'],['secret','Tajemství']];
export const CAT_KEYS=CATS.map(c=>c[0]),CAT_LABEL=Object.fromEntries(CATS);
export const DEFAULT_CAT=DEFAULT_CATEGORY;
export const catOf=e=>CAT_KEYS.includes(e.category)?e.category:DEFAULT_CAT[e.kind];
// A card whose machine has no column or whose category is unknown is still drawn: in a last column of its own.
export const OTHER='Ostatní';
export const catLabel=c=>t(CAT_LABEL[c]||OTHER);
export const kindName=k=>KIND[k]?t(KIND[k]):k;
export const typeTag=e=>(e.type||kindName(e.kind)).split(' · ')[0];
export const hasGap=e=>(e.secrets||[]).some(s=>s.store==='unknown')||(e.kind==='runtime'&&!e.address);
export const isExample=e=>typeof e?.id==='string'&&e.id.startsWith(TEMPLATE_PREFIX);

// --- places ----------------------------------------------------------------------------------
// The site's places (site.json → inventory.places), then every machine entry the site did not list:
// a hub without a site file gets its map columns and its machine names from its own machine entries.
export const sitePlaces=()=>site().inventory?.places||[];
export const siteStores=()=>site().inventory?.secretStores||[];
export const sitePlace=id=>sitePlaces().find(p=>p.id===id);
export const allPlaces=entries=>placesOf(sitePlaces(),entries||[]);
let current=null;// the last document drawn: names for places that are machine entries
export function setCurrent(doc){current=doc||null;}
export const currentDoc=()=>current;
export function placeName(id){
 const label=sitePlace(id)?.label;if(label)return t(label);
 return current?.entries?.find(e=>e.id===id&&e.kind==='machine')?.name||id||'';
}
export const place=e=>e.kind==='machine'?e.name:e.kind==='external'?t('Mimo dům'):e.kind==='network'?t('Domácí síť'):placeName(e.machine);

// Where a secret is kept, in words: [label, tone].
export function store(s){
 const [k,v='']=String(s||'').split(':'),m=placeName(v);
 return ({keychain:[t('Klíčenka · {m}',{m}),'good'],file:[t('Soubor · {m}',{m}),'info'],'app-env':[t('Prostředí aplikace · {v}',{v}),'info'],'shell-env':[t('Proměnná shellu · {m}',{m}),'info'],'app-settings':[t('Nastavení {v}',{v}),'info'],sso:[t('Přihlášení {v}',{v:v==='google'?'Google':v}),'info'],'passwords-app':[t('Aplikace Hesla'),'good'],remembered:[t('Pamatuješ si ho'),''],unknown:[t('Nezapsáno'),'amber']})[k]||[String(s||''),siteStores().includes(s)?'good':''];
}
// Suggestions for the store field: the generic ones, then the site's own and one per place.
export function storeSuggestions(entries){
 const ids=allPlaces(entries).filter(p=>!p.lane).map(p=>p.id);
 return ['passwords-app','remembered',...siteStores(),...ids.map(id=>`keychain:${id}`),...ids.map(id=>`file:${id}`),...ids.map(id=>`shell-env:${id}`),'app-env:','app-settings:','sso:','unknown'];
}

// --- the document ----------------------------------------------------------------------------
export function index(doc){
 const byId=new Map(doc.entries.map(e=>[e.id,e])),usedBy=new Map();
 for(const e of doc.entries)for(const d of e.depends_on||[]){if(!usedBy.has(d.id))usedBy.set(d.id,[]);usedBy.get(d.id).push({id:e.id,kind:d.kind,label:d.label||''});}
 return {byId,usedBy};
}
// Every edge: recorded depends_on plus the implied runs-on link to the entry's machine (as in inventory-rules.js).
export function deps(doc){
 const ids=new Set(doc.entries.map(e=>e.id)),out=[];
 for(const e of doc.entries){for(const d of e.depends_on||[])out.push({from:e.id,to:d.id,kind:d.kind,label:d.label||''});
  if(!e.virtual&&e.kind!=='machine'&&e.machine&&ids.has(e.machine))out.push({from:e.id,to:e.machine,kind:'runs-on',label:''});}
 return out;
}
// Does an entry match what was typed in a search box? Every word must appear somewhere in its text.
// fields(entry): the texts to look in; by default everything a person might search by.
const searchable=e=>[e.id,e.name,e.kind,kindName(e.kind),e.type,e.machine,e.kind==='machine'?'':placeName(e.machine),e.address,e.version,e.notes,catLabel(catOf(e)),...(e.depends_on||[]).map(d=>d.id)];
export function matcher(query,fields=searchable){
 const words=String(query||'').toLowerCase().split(/\s+/).filter(Boolean);
 if(!words.length)return null;
 return e=>{const text=fields(e).filter(v=>typeof v==='string').join('\n').toLowerCase();return words.every(w=>text.includes(w));};
}

const EMPTY=()=>({doc:{schema:1,updated_at:null,entries:[]},gaps:[],hashes:{},missing:true});
let cache=null,fetchedAt=0,pending=null,systems=null;
// Another account must not see this one's inventory or versions (session-cache.js).
onSessionReset(()=>{cache=null;fetchedAt=0;pending=null;systems=null;current=null;});
export const cached=()=>cache;
export const hashOf=id=>cache?.hashes?.[id]||null;
export function invalidate(){cache=null;fetchedAt=0;}
// Installed versions from the systems page (admins); null for everyone else.
export const systemsDoc=()=>systems;
export function setSystems(doc){systems=doc||null;}
// {doc, gaps, hashes, missing?}. A hub with no inventory file yet answers 404 INVENTORY_MISSING: that is
// an empty inventory (missing: true), not an error.
export function load(){
 if(cache&&Date.now()-fetchedAt<60000)return Promise.resolve(cache);
 const who=currentPrincipal(),lost=authGuard();
 pending??=fetch('/api/inventory').then(async r=>{const body=await r.json().catch(()=>({}));
   let data=body;
   if(!r.ok){lost(r);if(r.status!==404||body?.error?.code!=='INVENTORY_MISSING')throw Object.assign(new Error(body?.error?.message||t('Inventář není dostupný.')),{code:body?.error?.code||null});data=EMPTY();}
   data={gaps:[],hashes:{},...data};
   if(who===currentPrincipal()){cache=data;fetchedAt=Date.now();}return data;}).finally(()=>{pending=null;});
 return pending;
}

// --- writes ----------------------------------------------------------------------------------
// Every call resolves to {ok, status, body}; a network failure rejects. After a successful write the
// cache is dropped, so the next load() reads the published file.
async function post(url,body){
 const lost=authGuard(),r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),out=await r.json().catch(()=>({}));
 if(!r.ok)lost(r);
 return {ok:r.ok,status:r.status,body:out};
}
const written=async call=>{const r=await call;if(r.ok&&r.body?.dryRun!==true)invalidate();return r;};
export const saveFields=(id,base,fields)=>written(post('/api/inventory/entry',{id,base,fields}));
export const removeEntry=(id,base)=>written(post('/api/inventory/entries/delete',{id,base}));
// entries: [{entry, base?}]
export const bulkUpsert=(entries,{dryRun=false,keepVerified=false}={})=>written(post('/api/inventory/bulk',{entries,...(dryRun?{dryRun:true}:{}),...(keepVerified?{keepVerified:true}:{})}));
// Tell the shell (app.js) that the inventory changed: it draws the current page again.
export const announce=()=>dispatchEvent(new Event('inventoryupdated'));
