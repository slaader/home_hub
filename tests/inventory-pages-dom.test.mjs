// The inventory pages on the mocked DOM, in English (the public default): the empty state with its agent
// prompt, the search box, the table view, the services view, what the browser remembers about the map
// (old saved layouts keep working), and the entry form's pure helpers.
import './support/site-inventory.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {installDom,fire} from './fixtures/mini-dom.mjs';

const {document,localStorage}=installDom();
const events=[];globalThis.dispatchEvent=e=>{events.push(e.type);return true;};
const {inventoryView,layoutLoad,INVENTORY_PROMPT}=await import('../public/inventory-view.js');
const {servicesPage,serviceGroups,serviceRows,sortServices}=await import('../public/inventory-services.js');
const {rowsOf,sortRows}=await import('../public/inventory-table.js');
const {slug,changedFields,parseImport,issueText}=await import('../public/inventory-entry.js');
const {matcher,invalidate,placeName,setCurrent,store,storeSuggestions}=await import('../public/inventory-data.js');
const {check,LIMITS}=await import('../public/inventory-rules.js');
const {setPrincipal}=await import('../public/session-cache.js');
const {setIdentity}=await import('../public/access.js');
const views=await import('../public/views.js');
const {t}=await import('../public/i18n.js');

const DOC=()=>({schema:1,updated_at:'2026-11-08',entries:[
 {id:'mini',kind:'machine',name:'Mac mini',address:'10.0.0.25',verified_at:'2026-11-01'},
 {id:'mini-gateway',kind:'runtime',name:'Gateway',machine:'mini',address:'http://mini.example.lan:8790',version:'2.1',verified_at:'2026-11-08',depends_on:[{id:'mini-certs',kind:'cert'}],secrets:[{what:'Voice token',store:'unknown'}]},
 {id:'mini-certs',kind:'tool',name:'Cert sync',machine:'mini',verified_at:'2026-11-03',confidence:'inferred',notes:'renews the gateway certificate'},
 {id:'mini-old',kind:'runtime',name:'Old proxy',machine:'mini',verified_at:'2026-10-01'},
 {id:'nas',kind:'machine',name:'NAS',verified_at:'2026-11-02'},
 {id:'nas-photos',kind:'runtime',name:'Photos',machine:'nas',address:'https://photos.example.lan',verified_at:'2026-11-05'},
 {id:'dns',kind:'external',name:'DNS provider',verified_at:'2026-11-04'}]});
let reply=()=>({status:200,body:{doc:DOC(),gaps:['entry "mini-gateway": where "Voice token" is kept is not recorded','entry "mini-old": no address'],hashes:{}}});
const posts=[];
globalThis.fetch=async(url,options={})=>{
 if(options.method==='POST'){posts.push([String(url),JSON.parse(options.body)]);return {ok:true,status:200,json:async()=>({ok:true,published:true,summary:{create:6,update:0,unchanged:0},entries:[]})};}
 if(String(url)==='/api/inventory'){const r=reply();return {ok:r.status===200,status:r.status,json:async()=>r.body};}
 return {ok:false,status:404,json:async()=>({})};
};
const tick=async(n=6)=>{for(let i=0;i<n;i++)await new Promise(r=>setImmediate(r));};
let user=0;
// A fresh sign-in each time: no cached inventory, no selection, no search left over.
async function mount(page=inventoryView,{write=false}={}){
 views.leaveView();setPrincipal({authKind:'session',role:write?'admin':'viewer',username:`u${++user}`});setIdentity({canWrite:write});invalidate();
 document.body.replaceChildren(page===inventoryView?inventoryView({role:'viewer'}):page({me:{role:'viewer'}}));await tick();
}
const all=cls=>document.body.querySelectorAll(cls);
const one=cls=>document.body.querySelector(cls);
const text=cls=>all(cls).map(n=>n.textContent);
// Card names as they sit on the map: column by column, top to bottom.
const spot=n=>n.getAttribute('transform').match(/translate\((\S+) (\S+)\)/).slice(1).map(Number);
const names=()=>all('.inv-node').sort((a,b)=>spot(a)[0]-spot(b)[0]||spot(a)[1]-spot(b)[1]).map(n=>n.getAttribute('aria-label').split(',')[0]);
const type=async(value,key)=>{const s=one('.inv-search');s.value=value;fire(s,key?'keydown':'input',key?{key}:{});await tick(1);};
const missing=()=>({status:404,body:{error:{code:'INVENTORY_MISSING',message:'There is no inventory file yet (data/knowledge.json).'}}});

test('an empty hub shows what the map is for, the agent prompt, the MCP snippet and, for writers, how to start',async()=>{
 const was=reply;reply=missing;localStorage.clear();
 try{
  await mount(inventoryView,{write:true});
  assert.equal(one('.ui-empty').children.find(c=>c.tagName==='h2').textContent,'The inventory map is empty');
  assert.equal(all('.inv-node').length,0);assert.equal(one('.inv-map-wrap'),null,'no empty map frame');
  const [prompt,snippet]=text('.ui-copy');
  for(const word of ['inventory_describe','inventory_search','inventory_update','inventory_bulk_upsert','inventory:write','kind, machine, address, version and depends_on','never their value'])assert.ok(prompt.includes(word),word);
  assert.equal(INVENTORY_PROMPT().includes('inventory_get'),true);
  assert.match(snippet,/claude mcp add --transport http home-hub .*\/mcp/);assert.match(snippet,/Authorization: Bearer hhk_…/);
  assert.equal(one('.ui-empty').children.find(c=>c.tagName==='ol').children.length,4);assert.ok(one('.ui-empty').textContent.includes('never its value')===false&&one('.ui-empty').textContent.includes('Never its value'));
  const actions=one('.ui-actions').children;
  assert.deepEqual(actions.map(a=>a.textContent),['Start from a template','Add the first entry','Import from JSON','Users and API']);
  // The template is sent as one bulk upsert of the example entries, then the page is asked to draw again.
  posts.length=0;events.length=0;fire(actions[0],'click');await tick();
  assert.equal(posts.length,1);assert.equal(posts[0][0],'/api/inventory/bulk');
  assert.deepEqual(posts[0][1].entries.map(c=>c.entry.id),['example-router','example-server','example-hub','example-proxy','example-backup','example-dns']);
  assert.ok(posts[0][1].entries.every(c=>!('base'in c))&&!('keepVerified'in posts[0][1]));
  assert.deepEqual(check({schema:1,updated_at:'2026-11-08',entries:posts[0][1].entries.map(c=>({...c.entry,verified_at:'2026-11-08'}))}).errors,[],'what it sends passes the checker');
  assert.deepEqual(events,['inventoryupdated']);
  // A read-only account gets the explanation without the buttons.
  await mount(inventoryView);
  assert.equal(one('.ui-actions'),null);assert.match(one('.inv-empty-note').textContent,/read-only/);
  // A file with no entries is the same empty inventory.
  reply=()=>({status:200,body:{doc:{schema:1,updated_at:'2026-11-08',entries:[]},gaps:[],hashes:{}}});
  await mount(inventoryView);assert.ok(one('.ui-empty'));
 }finally{reply=was;}
});

test('a failed load says so and offers to try again',async()=>{
 const was=reply;reply=()=>({status:500,body:{error:{code:'INVENTORY_INVALID',message:'The inventory file has 2 errors; run node scripts/check-knowledge.mjs.'}}});
 try{
  await mount();
  assert.match(one('.ui-empty').textContent,/could not be loaded/);assert.match(one('.ui-empty').textContent,/2 errors/);assert.equal(one('.inv-map-wrap'),null);
  reply=was;fire(one('.ui-actions').children[0],'click');await tick();
  assert.equal(all('.inv-node').length,7,'the retry drew the map');
 }finally{reply=was;}
});

test('the map: lanes with counts, a legend, zoom, and a search box that lights the matches',async()=>{
 localStorage.clear();await mount();
 assert.deepEqual(text('.inv-lane-label'),['MINI · M4','NAS · LINUX NAS','OUTSIDE THE HOUSE']);assert.deepEqual(text('.inv-lane-count'),['4','2','1']);
 assert.deepEqual(text('.inv-stat').slice(0,2),['2Machines','3Services']);
 assert.match(one('.inv-legend').textContent,/Hardware.*Services.*Calls.*an arrow points at what is needed/);
 assert.equal(all('.inv-dim').length,0);assert.equal(one('.inv-count').textContent,'');
 await type('gateway');
 const lit=()=>all('.inv-node').filter(n=>n.classList.contains('hit')).map(n=>n.getAttribute('aria-label').split(',')[0]);
 assert.deepEqual(lit(),['Gateway','Cert sync'],'the name, and a note that mentions it');
 assert.equal(all('.inv-node').filter(n=>n.classList.contains('dim')).length,5);assert.equal(one('.inv-count').textContent,'2 matches');
 await type('certificate gateway');assert.deepEqual(lit(),['Cert sync'],'every word must match');assert.equal(one('.inv-count').textContent,'1 match');
 // Enter selects the best match (a name before a note); the selection's chain then wins over the search.
 await type('gateway');await type('gateway','Enter');
 const selected=all('.inv-node').find(n=>n.getAttribute('aria-pressed')==='true');
 assert.equal(selected.getAttribute('aria-label').split(',')[0],'Gateway');
 const tone=name=>all('.inv-node').find(n=>n.getAttribute('aria-label').startsWith(name+',')).getAttribute('class');
 assert.match(tone('Cert sync'),/\bon\b.*\bup\b/,'what it needs');assert.match(tone('Mac mini'),/\bup\b/);assert.match(tone('Photos'),/\bdim\b/);
 assert.ok(all('.inv-edge').some(g=>/hot need/.test(g.getAttribute('class'))));assert.match(one('.inv-legend').textContent,/needs.*stops/);
 fire(selected,'keydown',{key:'Escape'});await tick(1);assert.equal(all('.inv-node').some(n=>n.getAttribute('aria-pressed')==='true'),false,'Escape clears the selection');
 await type('zzz');assert.equal(one('.inv-count').textContent,'0 matches');assert.equal(all('.inv-node').filter(n=>n.classList.contains('dim')).length,7);
 await type('');
 // Zoom keeps the drawing's own coordinates (the viewBox) and scales its size on the page.
 const svg=()=>one('.inv-map-wrap').children[0],size=()=>[Number(svg().getAttribute('width')),Number(svg().getAttribute('viewBox').split(' ')[2])];
 const zoom=()=>all('.inv-zoom-btn');
 assert.equal(size()[0],size()[1]);assert.equal(zoom()[1].textContent,'100 %');
 fire(zoom()[0],'click');await tick(1);assert.equal(zoom()[1].textContent,'90 %');assert.equal(size()[0],Math.round(size()[1]*0.9));assert.equal(layoutLoad().zoom,0.9);
 fire(zoom()[3],'click');await tick(1);assert.ok(one('.inv-map-wrap').classList.contains('fit'));assert.equal(layoutLoad().fit,true);
 fire(zoom()[1],'click');await tick(1);assert.equal(zoom()[1].textContent,'100 %');assert.equal(one('.inv-map-wrap').classList.contains('fit'),false);
});

test('what the browser saved before still loads: v3 orders are kept, new keys are optional, v1 is not thrown away',async()=>{
 // A layout written by the version before this one: no view, zoom, fit or controls.
 const old={spacing:'compact',lines:'all',depth:'direct',columns:'machine',together:false,focus:false,secretItems:false,hiddenCats:['saas'],soloPrev:null,
  modes:{machine:{cols:['nas · Linux NAS','mini · M4'],order:{'mini · M4':['mini','mini-old','mini-gateway','mini-certs']}},category:{cols:null,order:{}}}};
 localStorage.clear();localStorage.setItem('home-hub.inventory.map.v3',JSON.stringify(old));
 const loaded=layoutLoad();
 assert.deepEqual({...loaded,view:undefined,zoom:undefined,fit:undefined,controls:undefined},{...old,view:undefined,zoom:undefined,fit:undefined,controls:undefined},'every old key reads back as it was');
 assert.deepEqual([loaded.view,loaded.zoom,loaded.fit,loaded.controls],['map',1,false,null]);
 await mount();
 assert.deepEqual(text('.inv-lane-label'),['NAS · LINUX NAS','MINI · M4'],'saved column order; the hidden category stays hidden');
 assert.deepEqual(names(),['NAS','Photos','Mac mini','Old proxy','Gateway','Cert sync'],'saved card order');
 // Junk in the new keys falls back to the defaults instead of breaking the map.
 localStorage.setItem('home-hub.inventory.map.v3',JSON.stringify({...old,view:'grid',zoom:'big',fit:'yes',controls:7}));
 assert.deepEqual([layoutLoad().view,layoutLoad().zoom,layoutLoad().fit,layoutLoad().controls],['map',1,false,null]);
 localStorage.setItem('home-hub.inventory.map.v3',JSON.stringify({zoom:9}));assert.equal(layoutLoad().zoom,1.6);
 // Only the first map's key (v1: positions per card): its display choices carry over, the key itself stays.
 const v1=JSON.stringify({pos:{mini:{x:10,y:20}},lanes:{},linked:[],spacing:'roomy',lines:'all',depth:'all'});
 localStorage.clear();localStorage.setItem('home-hub.inventory.map.v1',v1);
 assert.deepEqual([layoutLoad().spacing,layoutLoad().lines,layoutLoad().depth,layoutLoad().columns],['roomy','all','all','machine']);
 await mount();
 const cards=all('.inv-node').filter(n=>spot(n)[0]===12).map(n=>spot(n)[1]).sort((a,b)=>a-b);
 assert.equal(cards[1]-cards[0],66,'roomy spacing from the v1 layout');
 assert.equal(localStorage.getItem('home-hub.inventory.map.v1'),v1);assert.equal(localStorage.getItem('home-hub.inventory.map.v3'),null,'nothing is written until the person changes something');
 localStorage.setItem('home-hub.inventory.map.v3','{not json');assert.equal(layoutLoad().spacing,'roomy','a broken v3 value falls back to the older key');
 localStorage.clear();
});

test('the table view sorts, filters and remembers that it was chosen',async()=>{
 localStorage.clear();await mount();
 const tabs=()=>one('.inv-tabs').children;
 assert.deepEqual(tabs().map(b=>[b.textContent,b.getAttribute('aria-pressed')]),[['Map','true'],['Table','false'],['Services','false']]);
 fire(tabs()[1],'click');await tick(1);
 assert.equal(one('.inv-map-wrap'),null);assert.equal(layoutLoad().view,'table');assert.equal(tabs()[1].getAttribute('aria-pressed'),'true');
 const rows=()=>text('.inv-rowbtn'),count=()=>one('.inv-table-view').querySelector('.inv-count').textContent;
 assert.deepEqual(rows(),['Cert sync','DNS provider','Gateway','Mac mini','NAS','Old proxy','Photos'],'by name');assert.equal(count(),'7 entries');
 const sort=label=>fire(all('.inv-sort').find(b=>b.textContent.startsWith(label)),'click');
 sort('Verified');assert.deepEqual(rows().slice(0,2),['Old proxy','Mac mini'],'oldest first');
 assert.equal(all('.inv-sort').find(b=>b.textContent.startsWith('Verified')).parentNode.getAttribute('aria-sort'),'ascending');
 sort('Verified');assert.deepEqual(rows().slice(0,2),['Gateway','Photos'],'then newest first');
 sort('Address');assert.deepEqual(rows().slice(0,3),['Mac mini','Gateway','Photos']);assert.deepEqual(rows().slice(-2),['NAS','Old proxy'].sort(),'entries without an address go last');
 sort('Name');
 const [kind,place]=one('.inv-table-filters').children;
 kind.value='runtime';fire(kind,'change');assert.deepEqual(rows(),['Gateway','Old proxy','Photos']);assert.equal(count(),'3 of 7 entries');
 place.value='nas · Linux NAS';fire(place,'change');assert.deepEqual(rows(),['Photos']);
 fire(all('.inv-more').find(b=>b.textContent==='Clear filters'),'click');assert.equal(rows().length,7);
 fire(all('.inv-chip').find(b=>b.textContent==='Only with gaps'),'click');assert.deepEqual(rows(),['Gateway','Old proxy'],'an unknown secret location, a service without an address');
 fire(all('.inv-chip').find(b=>b.textContent==='Only with gaps'),'click');
 await type('mini');assert.deepEqual(rows(),['Cert sync','Gateway','Mac mini','Old proxy'],'the page search filters the table too');
 await type('nothing-like-this');assert.equal(rows().length,0);assert.equal(one('.inv-none').hidden,false);
 await type('');
 // The gaps tile on top opens the table filtered to them; a row opens the entry.
 fire(tabs()[0],'click');await tick(1);assert.ok(one('.inv-map-wrap'));
 fire(all('.inv-stat').find(b=>b.tagName==='button'),'click');await tick(1);
 assert.equal(layoutLoad().view,'table');assert.deepEqual(rows(),['Gateway','Old proxy']);
 fire(all('.inv-rowbtn')[0],'click');
 assert.equal(one('.inv-detail').querySelector('.inv-title').textContent,'Gateway');assert.match(one('.inv-detail').textContent,/Not recorded yet\. Add where it is stored — never the value\./);
 one('.inv-dialog').remove();localStorage.clear();
});

test('table rows and their order are plain data',()=>{
 const rows=rowsOf(DOC()),by=id=>rows.find(r=>r.id===id);
 assert.deepEqual([by('mini').usedBy,by('mini').needs],[3,0],'what runs on a machine counts as using it');
 assert.deepEqual([by('mini-certs').usedBy,by('mini-gateway').needs,by('mini-gateway').unknown,by('mini-gateway').gap,by('mini-old').gap,by('nas-photos').gap],[1,1,1,true,true,false]);
 assert.equal(by('dns').place,'Outside the house');assert.equal(by('nas-photos').place,'nas · Linux NAS');
 assert.deepEqual(sortRows(rows,'links','desc').slice(0,2).map(r=>r.id),['mini','mini-certs']);
 assert.deepEqual(sortRows(rows,'version').map(r=>r.id)[0],'mini-gateway','rows without a version sink');
 assert.deepEqual(sortRows(rows,'nonsense').map(r=>r.name),sortRows(rows).map(r=>r.name));assert.equal(rows[0].id,'mini','sorting copies');
});

test('services are a view of the inventory page: one dense list with addresses, machines, dependents and verification',async()=>{
 localStorage.clear();await mount(()=>inventoryView({role:'viewer'},'services'),{write:true});
 assert.deepEqual(all('.inv-tabs')[0].children.map(b=>[b.textContent,b.getAttribute('aria-pressed')]),[['Map','false'],['Table','false'],['Services','true']]);
 assert.equal(one('.ui-head').textContent.startsWith('InventoryServices'),true,'the header names the view');
 assert.equal(layoutLoad().view,'services','the view named in the address is remembered like a clicked tab');
 assert.equal(one('.inv-map-wrap'),null);
 const rows=()=>all('.inv-services')[0].children.find(c=>c.tagName==='tbody').children,names=()=>rows().map(r=>r.querySelector('.inv-rowbtn').textContent);
 const cells=r=>Object.fromEntries(r.children.map(c=>[c.getAttribute('data-label'),c.textContent]));
 // Sorted by machine, then name; every row says where, on what, who depends on it, what it needs and when it was checked.
 assert.deepEqual(names(),['Gateway','Old proxy','Photos']);
 assert.deepEqual(cells(rows()[0]),{Service:'GatewayService · 2.1',Address:'http://mini.example.lan:8790',Machine:'mini · Mac mini M4','Depends on it':'nothing recorded',Needs:'Cert sync',Verified:'2026-11-08'});
 assert.equal(rows()[0].querySelector('.inv-addr').children[0].getAttribute('href'),'http://mini.example.lan:8790','a URL in the address is a link');
 assert.match(cells(rows()[1]).Address,/No address recorded/);assert.ok(rows()[1].classList.contains('gap'));
 assert.equal(one('.inv-count').textContent,'');assert.equal(all('.inv-count')[1].textContent,'3 services');
 assert.equal(all('.inv-btn').find(b=>b.classList.contains('primary')).textContent,'+ Add a service');
 // The search box and the table's filters are the page's: they hold across the views.
 await type('photos');assert.deepEqual(names(),['Photos']);assert.equal(all('.inv-count')[1].textContent,'1 of 3 services');
 fire(all('.inv-tabs')[0].children[1],'click');assert.deepEqual(text('.inv-rowbtn'),['Photos'],'the table shows the same search');
 await type('');const place=all('.inv-table-filters')[0].children[1];place.value='nas · Linux NAS';fire(place,'change');
 fire(all('.inv-tabs')[0].children[2],'click');assert.deepEqual(names(),['Photos'],'the place picked in the table filters the services too');
 assert.equal(all('.inv-table-filters')[0].children[0].value,'nas · Linux NAS');
 fire(all('.inv-more').find(b=>b.textContent==='Clear filters'),'click');assert.deepEqual(names(),['Gateway','Old proxy','Photos']);
 // Sorting by a column; a name in "Needs" opens that entry, a row opens its own.
 fire(all('.inv-sort').find(b=>b.textContent.startsWith('Verified')),'click');assert.deepEqual(names(),['Old proxy','Photos','Gateway']);
 fire(rows()[2].querySelector('.inv-rel-item'),'click');assert.equal(one('.inv-detail').querySelector('.inv-title').textContent,'Cert sync');one('.inv-dialog').remove();
 fire(rows()[1],'click');assert.equal(one('.inv-detail').querySelector('.inv-title').textContent,'Photos','a row opens the entry');one('.inv-dialog').remove();
 assert.deepEqual(serviceGroups(DOC()).map(g=>[g.machine,g.services.length]),[['mini',2],['nas',1]]);
 const listed=serviceRows({entries:[...DOC().entries,{id:'app',kind:'tool',name:'App',machine:'mini',depends_on:[{id:'mini-gateway',kind:'call'}]}]});
 assert.deepEqual(listed.find(r=>r.id==='mini-gateway').usedBy,[{id:'app',name:'App',kind:'call'}],'dependents are named, not just counted');
 assert.deepEqual(sortServices(listed,'usedBy','desc').map(r=>r.id),['mini-gateway','mini-old','nas-photos'],'rows without dependents sink');
 // No runtime entries: say what a service is and point at kind "runtime".
 const was=reply;reply=()=>({status:200,body:{doc:{...DOC(),entries:DOC().entries.filter(e=>e.kind!=='runtime'&&e.id!=='mini-certs')},gaps:[],hashes:{}}});
 try{
  await mount(()=>inventoryView({role:'viewer'},'services'),{write:true});
  assert.equal(one('.ui-empty').children.find(c=>c.tagName==='h2').textContent,'No services yet');
  assert.match(one('.ui-empty').textContent,/every entry of kind “runtime” is a service/);
  for(const word of ['inventory_describe','inventory_search','inventory_update','kind "runtime"','inventory:write'])assert.ok(text('.ui-copy')[0].includes(word),word);
  assert.deepEqual(one('.ui-actions').children.map(a=>a.textContent),['Add a service']);
  await mount(()=>inventoryView({role:'viewer'},'services'));assert.equal(one('.ui-actions'),null,'read-only: no add button');
 }finally{reply=was;localStorage.clear();}
});

test('#services still works: it leads to the Services view; the header pill follows the answer\'s provenance',async()=>{
 const went=[];globalThis.location={hash:'#services',replace:h=>{went.push(h);globalThis.location.hash=h;}};
 try{
  const node=servicesPage();assert.deepEqual(went,['#inventory-map/services']);assert.equal(node.getAttribute('role'),'status');
  // The tabs keep the address in step without another page load.
  const states=[];globalThis.history={replaceState:(a,b,hash)=>{states.push(hash);globalThis.location.hash=hash;}};
  localStorage.clear();await mount(()=>inventoryView({role:'viewer'},'services'));
  fire(all('.inv-tabs')[0].children[0],'click');fire(all('.inv-tabs')[0].children[1],'click');fire(all('.inv-tabs')[0].children[2],'click');
  assert.deepEqual(states,['#inventory-map','#inventory-map/table','#inventory-map/services']);
 }finally{delete globalThis.location;delete globalThis.history;localStorage.clear();}
 const was=reply,provenance={kind:'agent',kinds:[{kind:'agent',count:7,unit:'entries',accounts:['codex'],lastAt:'2026-11-08'}],lastAt:'2026-11-08',summary:'x'};
 reply=()=>({status:200,body:{doc:DOC(),gaps:[],hashes:{},provenance}});
 try{
  await mount(inventoryView);
  const pill=one('.ui-prov');assert.equal(pill.querySelector('.ui-prov-text').textContent,'Agent · codex');assert.equal(pill.getAttribute('aria-expanded'),'false');
  assert.equal(pill.getAttribute('aria-label'),'Data provenance: Agent · codex');
  const pop=one('.ui-prov-pop');assert.ok(pop.hasAttribute('hidden'));
  fire(pill,'click');assert.equal(pill.getAttribute('aria-expanded'),'true');assert.equal(pop.hasAttribute('hidden'),false);
  assert.match(pop.textContent,/Written by an agent with a service-account key/);assert.match(pop.textContent,/7 entries/);assert.match(pop.textContent,/service accounts: codex/);
  fire(pill,'click');assert.ok(pop.hasAttribute('hidden'),'a second press closes it');
  // An answer without provenance (an older server, an empty inventory) simply has no pill.
  reply=()=>({status:200,body:{doc:DOC(),gaps:[],hashes:{}}});await mount(inventoryView);assert.equal(one('.ui-prov'),null);
  reply=missing;await mount(inventoryView);assert.equal(one('.ui-prov'),null);
 }finally{reply=was;}
});

test('search, place names and store labels come from the site and from the entries',()=>{
 const doc=DOC();setCurrent(doc);
 const find=q=>doc.entries.filter(matcher(q)).map(e=>e.id);
 assert.deepEqual(find('NAS'),['nas','nas-photos'],'by machine id, name or place');assert.deepEqual(find('8790'),['mini-gateway']);assert.deepEqual(find('tool'),['mini-certs'],'by kind');
 assert.equal(matcher('  '),null);assert.deepEqual(doc.entries.filter(matcher('gateway',e=>[e.name])).map(e=>e.id),['mini-gateway']);
 assert.equal(placeName('mini'),'mini · Mac mini M4','a place the site named');
 setCurrent({entries:[{id:'pi',kind:'machine',name:'Garage Pi'}]});
 assert.equal(placeName('pi'),'Garage Pi','a machine entry the site did not list');assert.equal(placeName('ghost'),'ghost');
 assert.deepEqual(store('keychain:pi'),['Keychain · Garage Pi','good']);assert.deepEqual(store('example-vault'),['example-vault','good'],'the site\'s own store');
 assert.deepEqual(store('drawer'),['drawer','']);assert.deepEqual(store('unknown'),['Not recorded','amber']);assert.deepEqual(store('app-env:proxy'),['App environment · proxy','info']);
 const suggestions=storeSuggestions([{id:'pi',kind:'machine',name:'Garage Pi'}]);
 for(const s of ['passwords-app','example-vault','keychain:studio','keychain:pi','file:pi','unknown'])assert.ok(suggestions.includes(s),s);
 assert.ok(!suggestions.includes('keychain:router'),'a place in the Network lane holds no keychain');
 setCurrent(null);
});

test('the entry form sends only what changed, makes ids from names and reads export files',()=>{
 const entry={id:'gw',kind:'runtime',machine:'mini',name:'Gateway',address:':8790',data:null,notes:' kept ',secrets:[{what:'Token',store:'keychain:mini',ref:'gw.token',extra:'x'}],depends_on:[{id:'sync',kind:'cert'}]};
 const form=over=>({name:'Gateway',type:'',category:'',address:':8790',version:'',managed_by:'',login:'',config:'',data:'',notes:'kept',machine:'mini',secrets:[{what:'Token',store:'keychain:mini',ref:'gw.token'}],depends_on:[{id:'sync',kind:'cert'}],...over});
 assert.deepEqual(changedFields(entry,form()),{},'an untouched form changes nothing: no null, whitespace or key-order noise');
 assert.deepEqual(changedFields(entry,form({address:'',version:'2',machine:'studio'})),{address:'',version:'2',machine:'studio'});
 assert.deepEqual(changedFields(entry,form({secrets:[]})),{secrets:[]});
 assert.deepEqual(changedFields(entry,form({depends_on:[{id:'sync',kind:'cert',label:'renews'}]})),{depends_on:[{id:'sync',kind:'cert',label:'renews'}]});
 assert.equal(slug('mini Žluťoučký Kůň 2'),'mini-zlutoucky-kun-2');assert.equal(slug('  --  '),'');assert.equal(slug('3D printer'),'x-3d-printer');
 assert.ok(slug('a'.repeat(200)).length<=LIMITS.idLength);assert.match(slug('Reverse proxy (Caddy)'),/^[a-z][a-z0-9-]*$/);
 assert.deepEqual(parseImport(JSON.stringify(DOC())).entries.map(e=>e.id),DOC().entries.map(e=>e.id),'a whole exported document');
 assert.equal(parseImport(JSON.stringify(DOC().entries)).entries.length,7,'or a bare list');
 for(const [bad,why] of [['{',/not valid JSON/],['{"schema":1}',/no list of entries/],['[]',/no entries/],['[1]',/object with an id/],['[{"id":"a","kind":"tool","colour":"red"}]',/does not know: colour/],['[{"id":"a"},{"id":"a"}]',/twice/],
   [JSON.stringify(Array.from({length:LIMITS.bulkEntries+1},(_,i)=>({id:`e${i}`}))),/more entries than one import can take \(500\)/]]){
  const r=parseImport(bad);assert.equal(r.entries,undefined);assert.match(t(r.error,r.vars),why);}
 // The checker's issues, said in the reader's language, with the reason translated too.
 const issues=check({schema:1,updated_at:'2026-11-08',entries:[{id:'gw',kind:'runtime',machine:'nowhere',name:'',login:'token=abcdef123456',verified_at:'2026-11-08',secrets:[{what:'T',store:'drawer',check:'printenv T'}],depends_on:[{id:'ghost',kind:'call'}]}]}).issues;
 const said=Object.fromEntries(issues.map(i=>[i.code,issueText(i)]));
 assert.equal(said['name-required'],'A name is required.');assert.equal(said['machine-required'],'Choose the machine it runs on.');
 assert.equal(said['secret-value'],'This looks like a secret value (an assignment of a secret). Record where it is stored, not the value.');
 assert.equal(said['secret-store'],'Unknown store “drawer”. Pick one from the list, or use a form such as keychain:<machine>.');
 assert.equal(said['secret-check'],'This command would print the secret (it prints an environment variable). Use one that only proves it exists.');
 assert.equal(said['dep-missing'],'There is no entry “ghost”.');assert.equal(said['gap-address'],'A service without an address counts as a gap.');
 assert.equal(issueText({code:'brand-new',text:'the checker\'s own words'}),'the checker\'s own words','an unknown code shows the checker\'s text');
});
