// public/inventory-rules.js: the one checker the server, the CLI and the entry form share. Its messages are
// what agents and people read, so their text is pinned here; the structured issues are what the form places
// under a field. Nothing in the module may name a household: stores and places come in as arguments.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {check,validate,validStore,storeNames,describe,placesOf,templateEntries,withFields,dependents,links,walk,BUILTIN_STORES,STORE_PREFIXES,KINDS,CATEGORIES,LIMITS,TEMPLATE_PREFIX} from '../public/inventory-rules.js';
import * as checker from '../scripts/check-knowledge.mjs';
import {SITE} from './hub-helper.mjs';

const doc=()=>({schema:1,updated_at:'2026-11-01',entries:[
 {id:'mini',kind:'machine',name:'Mac mini',verified_at:'2026-11-01'},
 {id:'gw',kind:'runtime',machine:'mini',name:'Gateway',address:':8790',verified_at:'2026-11-01',secrets:[{what:'Voice token',store:'keychain:mini',ref:'gateway.voice-token',check:'security find-generic-password -s gateway.voice-token'}],depends_on:[{id:'sync',kind:'cert'}]},
 {id:'sync',kind:'tool',machine:'mini',name:'Cert sync',verified_at:'2026-11-01'}]});
const issue=(d,options)=>check(d,options).issues.map(i=>[i.level,i.id,i.field,i.code]);

test('messages keep their exact text and every one comes with a field and a code',()=>{
 const d=doc();
 Object.assign(d.entries[1],{name:'',category:'gadget',verified_at:'soon',confidence:'maybe',login:'password=hunter2hunter2'});
 d.entries[1].secrets=[{store:'drawer',check:'cat ~/.secrets/token'},{what:'Other',store:'unknown'}];
 d.entries[1].depends_on=[{id:'ghost',kind:'talks'},{id:'gw',kind:'call'}];
 d.entries[2].machine='nowhere';d.entries.push({id:'Bad Id',kind:'service',name:'x',verified_at:'2026-11-01'},{...d.entries[0]},'text');
 const {errors,warnings,issues}=check(d);
 assert.deepEqual(errors,[
  'entry "gw": name is required',
  'entry "gw": category must be one of hardware, network, service, model, tool, llm-support, saas, secret',
  'entry "gw": verified_at must be YYYY-MM-DD',
  'entry "gw": confidence must be verified or inferred',
  'entry "gw": every secret needs "what"',
  'entry "gw": secret "undefined" has unknown store "drawer"',
  'entry "gw": check for "undefined" prints a secret file',
  'entry "gw": depends_on "ghost" kind must be one of call, cert, secret, data',
  'entry "gw": depends on itself',
  'entry "gw": login looks like a secret value (assignment of a secret); record where it is kept, not the value',
  'entry "Bad Id": id must be lowercase kebab-case',
  'entry "Bad Id": kind must be one of network, machine, runtime, tool, model-store, secret-store, skill-store, external',
  'entry "mini": duplicate id',
  'entries[5]: not an object',
  'entry "gw": depends_on "ghost" does not exist',
  'entry "sync": machine must name a machine entry']);
 assert.deepEqual(warnings,['entry "gw": where "Other" is kept is not recorded']);
 assert.deepEqual(validate(d),{errors,warnings},'validate is check without the issues');
 assert.deepEqual(issues.filter(i=>i.id==='gw').map(i=>[i.field,i.code]),[['name','name-required'],['category','category'],['verified_at','verified-at'],['confidence','confidence'],
  ['secrets[0].what','secret-what'],['secrets[0].store','secret-store'],['secrets[0].check','secret-check'],['depends_on[0].kind','dep-kind'],['depends_on[1].id','dep-self'],['login','secret-value'],
  ['depends_on[0].id','dep-missing'],['secrets[1].store','gap-store']]);
 for(const i of issues){assert.equal(i.message.endsWith(i.text),true);assert.ok(['error','warning'].includes(i.level));assert.equal(typeof i.index==='number'||i.index===null,true);}
 assert.equal(issues.find(i=>i.code==='secret-store').store,'drawer');assert.equal(issues.find(i=>i.code==='secret-value').why,'assignment of a secret');
 assert.equal(issues.find(i=>i.code==='id-duplicate').index,4,'the index tells two entries with one id apart');
});

test('the document itself, and values of the wrong type, are reported instead of throwing',()=>{
 assert.deepEqual(check(null).errors,['top level must be an object with an "entries" array']);
 assert.deepEqual(check([]).errors,['top level must be an object with an "entries" array']);
 assert.deepEqual(check({schema:2,updated_at:'x',entries:[]}).errors,['schema must be 1','updated_at must be YYYY-MM-DD']);
 const d=doc();
 Object.assign(d.entries[1],{address:8790,notes:['a'],secrets:'keychain',depends_on:{id:'sync'},models:[1]});
 Object.assign(d.entries[2],{secrets:['x'],depends_on:['sync',{kind:'call'}]});
 assert.deepEqual(check(d).errors,['entry "gw": address must be text','entry "gw": notes must be text','entry "gw": secrets must be a list','entry "gw": depends_on must be a list','entry "gw": models[0] must be text',
  'entry "sync": secrets[0] must be an object','entry "sync": depends_on[0] must be an object with an id','entry "sync": depends_on[1] must be an object with an id']);
 // null means "not recorded" in files written by hand: it stays valid.
 const n=doc();Object.assign(n.entries[2],{address:null,data:null,secrets:null,depends_on:null});
 assert.deepEqual(check(n).errors,[]);
});

test('a site adds its own secret stores; the built-ins are generic',()=>{
 assert.deepEqual(BUILTIN_STORES,['passwords-app','remembered','unknown']);
 assert.deepEqual(storeNames(['family-vault']),['passwords-app','remembered','unknown','family-vault']);
 assert.ok(validStore('family-vault',['family-vault'])&&!validStore('family-vault')&&!validStore('family-vault',[]));
 for(const p of STORE_PREFIXES){assert.ok(validStore(p+'x'));assert.ok(!validStore(p));}
 assert.ok(!validStore(undefined)&&!validStore(7));
 const d=doc();d.entries[1].secrets[0].store='family-vault';
 assert.deepEqual(issue(d).filter(i=>i[0]==='error'),[['error','gw','secrets[0].store','secret-store']]);
 assert.deepEqual(issue(d,{secretStores:['family-vault']}).filter(i=>i[0]==='error'),[]);
 // The checker script reads them from the site this process loaded (the fixture site names example-vault).
 assert.deepEqual(SITE.inventory.secretStores,['example-vault']);
 assert.ok(checker.validStore('example-vault')&&checker.storeNames().includes('example-vault'));
 d.entries[1].secrets[0].store='example-vault';
 assert.deepEqual(checker.validate(d).errors,[]);assert.equal(checker.validate(d,{secretStores:[]}).errors.length,1,'a caller may pass another site\'s stores');
});

test('places: the site\'s own first, then every machine entry it did not list',()=>{
 const site=[{id:'mini',label:'mini · Mac mini',short:'mini',column:'Mac mini'},{id:'router',label:'Router',lane:'net'}];
 const entries=[{id:'mini',kind:'machine',name:'Mac mini'},{id:'pi',kind:'machine',name:'Garage Pi'},{id:'svc',kind:'runtime',machine:'pi',name:'Svc'},{id:'router',kind:'network',name:'Router'}];
 assert.deepEqual(placesOf(site,entries),[{...site[0],source:'site'},{...site[1],source:'site'},{id:'pi',label:'Garage Pi',column:'Garage Pi',source:'machine'}]);
 assert.deepEqual(placesOf([],entries).map(p=>p.id),['mini','pi'],'without a site file the machines are the places');
 assert.deepEqual(placesOf(),[]);
});

test('describe() is complete enough to fill the inventory without reading code',()=>{
 const d=describe({places:[{id:'mini',label:'mini · Mac mini',column:'Mac mini'}],secretStores:['family-vault']},[{id:'pi',kind:'machine',name:'Garage Pi'}]);
 assert.deepEqual(d.kinds.map(k=>k.id),KINDS);assert.ok(d.kinds.every(k=>k.description&&typeof k.needsMachine==='boolean'&&CATEGORIES.includes(k.defaultCategory)));
 assert.deepEqual(d.categories,CATEGORIES);assert.deepEqual(d.limits,{...LIMITS});
 const fields=Object.fromEntries(d.entry.fields.map(f=>[f.name,f]));
 for(const f of ['id','kind','name','machine','type','category','address','version','config','data','managed_by','login','notes','secrets','depends_on','models','skills','confidence','verified_at','verified_by'])assert.ok(fields[f]?.description,f);
 assert.deepEqual(d.entry.fields.filter(f=>f.required).map(f=>f.name),['id','kind','name']);assert.ok(fields.verified_at.setByHub&&fields.verified_by.setByHub);
 assert.deepEqual(d.secrets.fields.filter(f=>f.required).map(f=>f.name),['what','store']);
 assert.ok(d.secrets.stores.some(s=>s.store==='family-vault')&&d.secrets.stores.some(s=>s.store==='sso:<provider>'));
 assert.deepEqual(d.places,[{id:'mini',label:'mini · Mac mini',source:'site'},{id:'pi',label:'Garage Pi',source:'machine'}]);
 assert.match(d.concurrency,/hash/);assert.ok(d.impliedLinks[0].id==='runs-on'&&d.gaps.length===2);
 assert.deepEqual(d.examples,templateEntries());
 assert.equal(JSON.parse(JSON.stringify(d)).rules.length,d.rules.length,'plain data, safe to send as JSON');
});

test('the template is a valid little inventory: generic, linked, with one gap to show what a gap is',()=>{
 const entries=templateEntries().map(e=>({...e,verified_at:'2026-11-01'}));
 const {errors,warnings}=check({schema:1,updated_at:'2026-11-01',entries});
 assert.deepEqual(errors,[]);assert.deepEqual(warnings,['entry "example-dns": where "Account password" is kept is not recorded']);
 assert.ok(entries.every(e=>e.id.startsWith(TEMPLATE_PREFIX)&&/example/i.test(e.name)&&/delete/.test(e.notes)));
 assert.deepEqual([...new Set(entries.map(e=>e.kind))].sort(),['external','machine','network','runtime','tool']);
 const d={entries};
 assert.deepEqual(walk(d,'example-proxy',true).map(x=>x.id),['example-hub','example-dns','example-router','example-server']);
 assert.deepEqual(dependents(d,'example-server'),['example-hub','example-proxy','example-backup']);assert.deepEqual(dependents(d,'example-backup'),[]);
 assert.equal(links(d).filter(l=>l.kind==='runs-on').length,3);
 assert.notEqual(templateEntries()[0],templateEntries()[0],'a fresh copy every time');
});

test('withFields applies a form to an entry: emptied fields and lists are removed, nothing else moves',()=>{
 const e={id:'gw',kind:'runtime',machine:'mini',name:'Gateway',address:':8790',notes:'old',secrets:[{what:'a',store:'unknown'}],verified_at:'2026-11-01',extra:{kept:true}};
 const next=withFields(e,{address:'',notes:'new',machine:'studio',secrets:[],depends_on:[{id:'sync',kind:'call'}]});
 assert.deepEqual(next,{id:'gw',kind:'runtime',machine:'studio',name:'Gateway',notes:'new',verified_at:'2026-11-01',extra:{kept:true},depends_on:[{id:'sync',kind:'call'}]});
 assert.deepEqual(Object.keys(withFields(e,{})),Object.keys(e),'no fields, no change, same key order');
 assert.equal(e.address,':8790','the entry passed in is not modified');
});

test('core carries no household vocabulary: the rules are one module, re-exported by the checker',async()=>{
 const rules=await readFile(new URL('../public/inventory-rules.js',import.meta.url),'utf8'),script=await readFile(new URL('../scripts/check-knowledge.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(rules,/^import /m,'no imports: it loads in a browser as it is');assert.doesNotMatch(rules,/\b(process|document|window|globalThis)\.\w|\brequire\(/,'no Node or DOM globals');
 assert.doesNotMatch(script,/STORE_NAMES|SECRET_PATTERNS\s*=/,'the checker script holds no rules of its own');
 for(const name of ['KINDS','LINK_KINDS','DEP_KINDS','CATEGORIES','categoryOf','STORE_PREFIXES','links','walk','find','validate','validStore','storeNames','load'])assert.ok(name in checker,`${name} is still exported for existing callers`);
 for(const file of ['inventory-view.js','inventory-data.js','inventory-entry.js','inventory-table.js','inventory-services.js']){
  const src=await readFile(new URL(`../public/${file}`,import.meta.url),'utf8');
  assert.doesNotMatch(src,/\bPLACE\s*=|STORE_NAMES/,`${file}: places and stores come from the site and the entries`);
 }
});
