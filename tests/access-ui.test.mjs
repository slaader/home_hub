// The access page's pure parts: connection snippets, the audit filter, the API reference merge, and
// that the first-run screen and the page carry no household detail or inline HTML.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const store=new Map();
globalThis.localStorage={getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,String(v))};
const {connectionSnippets,auditMatches,allDocs,ago,when,toolLead,toolRows}=await import('../public/access-view.js');
const {roleLabel}=await import('../public/settings-view.js');
const {hasScope,setIdentity,canAdmin,SETUP_COMMAND}=await import('../public/access.js');

test('connection snippets: Claude Code, Codex and a generic MCP config, built on the page origin',()=>{
 const key='hhk_'+'a'.repeat(64),origin='https://hub.example.lan';
 const [claude,codex,json,curl]=connectionSnippets(origin,key);
 assert.deepEqual([claude.id,codex.id,json.id,curl.id],['claude','codex','json','curl']);
 assert.equal(claude.text,`claude mcp add --transport http home-hub ${origin}/mcp \\\n  --header "Authorization: Bearer ${key}"`);
 assert.match(codex.text,/\[mcp_servers\.home-hub\]\nurl = "https:\/\/hub\.example\.lan\/mcp"\nbearer_token_env_var = "HOME_HUB_KEY"/);
 assert.ok(codex.text.includes(`export HOME_HUB_KEY="${key}"`));
 assert.deepEqual(JSON.parse(json.text),{mcpServers:{'home-hub':{type:'http',url:`${origin}/mcp`,headers:{Authorization:`Bearer ${key}`}}}});
 assert.equal(curl.text,`curl -s -H "Authorization: Bearer ${key}" ${origin}/api/home`);
 // Without a key in hand nothing pretends to be one: the snippets read it from the environment.
 const plain=connectionSnippets(origin);
 assert.ok(plain.every(s=>!/hhk_[a-f0-9]{8}/.test(s.text)));
 assert.match(plain[0].text,/Bearer \$HOME_HUB_KEY"/);assert.equal(JSON.parse(plain[2].text).mcpServers['home-hub'].headers.Authorization,'Bearer ${HOME_HUB_KEY}');
});

test('the audit filter: by kind, by refusal, and by text in any column',()=>{
 const events=[
  {at:'2026-11-10T10:00:00.000Z',kind:'access',event:'role-created',subject:'Auditor',by:'alex'},
  {at:'2026-11-10T10:01:00.000Z',kind:'api',event:'api-write',subject:'agent-studio',detail:'/api/tickets · HH-12',status:201},
  {at:'2026-11-10T10:02:00.000Z',kind:'api',event:'mcp-call',subject:'agent-studio',detail:'inventory_update',status:'denied'},
  {at:'2026-11-10T10:03:00.000Z',kind:'api',event:'api-write',subject:'agent-reader',detail:'/api/admin/users',status:403},
  {at:'2026-11-10T10:04:00.000Z',kind:'device',event:'device-issued',subject:'Phone'}];
 const keep=f=>events.filter(e=>auditMatches(e,f)).map(e=>e.at.slice(14,16));
 assert.deepEqual(keep({}),['00','01','02','03','04']);
 assert.deepEqual(keep({kind:'api'}),['01','02','03']);assert.deepEqual(keep({kind:'access'}),['00']);assert.deepEqual(keep({kind:'device'}),['04']);
 assert.deepEqual(keep({only:'refused'}),['02','03'],'denied MCP calls and 403s');
 assert.deepEqual(keep({text:'hh-12'}),['01']);assert.deepEqual(keep({text:'ALEX'}),['00']);assert.deepEqual(keep({text:'agent-studio',only:'refused'}),['02']);
 assert.deepEqual(keep({text:'role created'}),['00'],'the event name as shown is searchable');
 assert.deepEqual(keep({text:'nothing like this'}),[]);
});

test('the API reference: module docs join the core groups, and a documented route is listed once',()=>{
 const core=allDocs([]);
 assert.ok(core.some(([title])=>title==='Správa přístupu')&&core.some(([title])=>title==='MCP'));
 const merged=allDocs([{title:'Správa přístupu',routes:[['GET','/api/admin/roles','admin','Roles.'],['GET','/api/admin/users','admin','Replaced.']]},{title:'Notes',routes:[['GET','/api/notes','read','All notes.']]}]);
 const access=merged.find(([title])=>title==='Správa přístupu')[1];
 const listUsers=access.filter(r=>r[0]==='GET'&&r[1]==='/api/admin/users');
 assert.equal(listUsers.length,1);assert.equal(listUsers[0][3],'Replaced.','the module\'s row wins');assert.ok(access.some(r=>r[0]==='POST'&&r[1]==='/api/admin/users'),'another method on the same path stays');
 assert.ok(access.some(r=>r[1]==='/api/admin/roles'));assert.deepEqual(merged.at(-1),['Notes',[['GET','/api/notes','read','All notes.']]]);
 const all=merged.flatMap(([,rows])=>rows.map(r=>`${r[0]} ${r[1].split('?')[0]}`));assert.equal(new Set(all).size,all.length,'no route twice');
});

test('times, roles and what the signed-in account holds',()=>{
 const now=Date.parse('2026-11-10T12:00:00.000Z');
 assert.equal(ago('2026-11-10T09:00:00.000Z',now),'3 hours ago');assert.equal(ago('2026-11-08T12:00:00.000Z',now),'2 days ago');assert.equal(ago(null,now),'—');assert.equal(ago('not a date',now),'—');
 assert.equal(when(null),'—');assert.match(when('2026-11-10T09:00:00.000Z'),/2026/);
 assert.equal(roleLabel({role:'admin',roleName:'Vlastník'}),'Owner');assert.equal(roleLabel({role:'editor',roleName:'Editor'}),'Editor');
 assert.equal(roleLabel({role:'night',roleName:'Night shift'}),'Night shift','a custom role shows its own name');
 assert.equal(roleLabel({role:'admin'}),'Administrator','a server from before roles');assert.equal(roleLabel(null),'');
 setIdentity({canAdmin:false,scopes:['read','security:read']});
 assert.deepEqual([hasScope('security:read'),hasScope('tickets:write'),canAdmin()],[true,false,false]);
 setIdentity(null);assert.equal(hasScope('read'),false);
 assert.equal(SETUP_COMMAND,'node scripts/setup.mjs');
});

test('the access pages build the DOM from text only and name no plugin',async()=>{
 for(const file of ['access-view.js','access.js','settings-view.js']){
  const src=await readFile(new URL(`../public/${file}`,import.meta.url),'utf8');
  assert.doesNotMatch(src,/innerHTML|outerHTML|insertAdjacentHTML|document\.write/,`${file}: text-safe DOM only`);
  assert.doesNotMatch(src,/nas:control|lfs:delete|backups:run|compute:control|iPhone/,`${file}: core knows no household plugin or device`);
 }
});

test('the MCP tool table: rows come from the manifest, a plugin tool is tagged, a long description folds',()=>{
 assert.deepEqual(toolLead('Search the inventory (machines, tools). Matches id and name. Returns the hash.'),['Search the inventory (machines, tools).','Matches id and name. Returns the hash.']);
 assert.deepEqual(toolLead('Add a comment, e.g. what was done.'),['Add a comment, e.g. what was done.',''],'an abbreviation does not end the sentence');
 assert.deepEqual(toolLead(undefined),['','']);
 const modules=[{id:'core',core:true,title:'Home Hub'},{id:'notes',core:false,title:'Notes'}];
 const rows=toolRows([{name:'home_status',title:'Machine status',scope:'read',write:false,description:'Current state.',module:'core'},
  {name:'notes_add',title:'Notes: add',scope:'notes:write',write:true,description:'Add a note. It is appended.',module:'notes'},
  {name:'keys_list',scope:'security:read',write:false,description:'SSH keys.',module:'gone'}],modules);
 assert.deepEqual(rows.map(r=>[r.name,r.title,r.scope,r.write,r.plugin]),[['home_status','Machine status','read',false,null],['notes_add','Notes: add','notes:write',true,'Notes'],['keys_list','keys_list','security:read',false,null]]);
 assert.deepEqual([rows[1].lead,rows[1].rest],['Add a note.','It is appended.']);
 assert.deepEqual(toolRows(),[],'without a manifest the table is empty, not a made-up list');
});
