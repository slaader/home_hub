// Roles for people, the wildcard for agents, and the files written before either existed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {createAccessStore,readAccessAudit,validTimeZone} from '../server/access-store.mjs';
import {hashPassword} from '../server/auth.mjs';
import {SCOPES,scopeIds,registerScopes,validScopes,resolveScopes,isWildcard,roleOf,legacyRole,legacyScopes,accountPresets,scopeFor,BUILTIN_ROLES} from '../server/scopes.mjs';
import {loadPlugins} from '../server/plugins.mjs';
import {hub,credentials} from './hub-helper.mjs';
import {fileURLToPath} from 'node:url';

const temp=async(t,name)=>{const dir=await mkdtemp(path.join(os.tmpdir(),name));t.after(()=>rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:25}));return dir;};
const sha=s=>createHash('sha256').update(s).digest('hex');
const fixtures=path.join(path.dirname(fileURLToPath(import.meta.url)),'fixtures','plugins');

test('built-in roles: what each holds, who administers, and how they read to older clients',()=>{
 assert.deepEqual(BUILTIN_ROLES.map(r=>r.id),['owner','admin','editor','viewer']);
 const [owner,admin,editor,viewer]=BUILTIN_ROLES.map(r=>roleOf(r.id));
 assert.deepEqual(owner.scopes,scopeIds());assert.deepEqual(admin.scopes,scopeIds());
 assert.deepEqual([owner.admin,admin.admin,editor.admin,viewer.admin],[true,true,false,false]);
 assert.equal(owner.assignable,false,'nobody is given the owner role');
 assert.ok(editor.scopes.includes('tickets:write')&&editor.scopes.includes('inventory:write')&&editor.scopes.includes('read'));
 assert.ok(!editor.scopes.includes('security:read'),'editor has every write scope, not the sensitive read-only ones');
 assert.deepEqual(viewer.scopes,['read']);
 assert.deepEqual([owner,admin,editor,viewer].map(legacyRole),['admin','admin','editor','viewer'],'the owner still reads as "admin"');
 const missing=roleOf('deleted-role',[]);assert.deepEqual([missing.id,missing.missing],['viewer',true],'a role that names nothing is a viewer');
 assert.deepEqual(roleOf('night',[{id:'night',name:'Night',scopes:['read','tickets:write']}]).scopes,['read','tickets:write']);
});

test('the wildcard: only where it is allowed, resolved when asked, and never a way into administration',()=>{
 assert.deepEqual(validScopes(['*'],{wildcard:true}),['*']);
 assert.deepEqual(validScopes(['*','tickets:write'],{wildcard:true}),['*'],'the wildcard swallows the rest');
 assert.throws(()=>validScopes(['*']),/invalid/,'a role is always an explicit list');
 assert.ok(isWildcard(['*'])&&!isWildcard(['read']));
 assert.deepEqual(resolveScopes(['*']),scopeIds());
 registerScopes('late-plugin',{'late:write':{label:'Late',desc:'Registered after the account was made.'}});
 assert.ok(resolveScopes(['*']).includes('late:write'),'a scope registered later is covered');
 assert.ok(roleOf('admin').scopes.includes('late:write')&&roleOf('editor').scopes.includes('late:write'));
 for(const [m,p] of [['GET','/api/admin/users'],['POST','/api/admin/roles'],['POST','/api/admin/roles/action'],['GET','/api/admin/audit'],['POST','/api/devices/tokens'],['GET','/api/devices/tokens'],['POST','/api/session'],['GET','/api/profile'],['POST','/api/profile/prefs'],['POST','/api/profile/password']])
  assert.equal(scopeFor(m,p),null,`${m} ${p} needs no scope a key could hold`);
 const presets=accountPresets([{id:'night',name:'Night',description:'',scopes:['read','tickets:write']}]);
 assert.deepEqual(presets.map(p=>p.id),['read','role:editor','role:admin','role:night','full']);
 assert.deepEqual(presets.find(p=>p.id==='full').scopes,['*']);assert.equal(presets.find(p=>p.id==='full').warn,true);
 assert.ok(presets.filter(p=>p.id!=='full').every(p=>!p.wildcard&&!p.scopes.includes('*')),'every other preset is an explicit list');
 assert.deepEqual(presets.find(p=>p.id==='role:night').scopes,['read','tickets:write']);
});

test('custom roles: create, change, apply at once, and delete only once nobody holds them',async t=>{
 const s=createAccessStore(await temp(t,'hub-roles-store-'),credentials);
 assert.deepEqual(s.roles().map(r=>[r.id,r.builtin,r.users]),[['owner',true,1],['admin',true,0],['editor',true,0],['viewer',true,0]]);
 const {role}=await s.createRole({name:'Noční služba',description:'Tickets only',scopes:['tickets:write']},{by:'admin'});
 assert.deepEqual([role.id,role.name,role.scopes,role.builtin,role.admin],['nocni-sluzba','Noční služba',['read','tickets:write'],false,false],'the id comes from the name, read is always there');
 await assert.rejects(s.createRole({name:'noční služba',scopes:[]}),/conflict/,'names are unique whatever the case');
 await assert.rejects(s.createRole({name:'Editor',scopes:[]}),/conflict/,'a built-in name is taken');
 await assert.rejects(s.createRole({name:'Other',id:'admin',scopes:[]}),/conflict/,'a built-in id is taken');
 assert.throws(()=>s.createRole({name:'Wild',scopes:['*']}),/invalid/);
 assert.throws(()=>s.createRole({name:'Bad',scopes:['root']}),/invalid/);
 assert.throws(()=>s.createRole({name:'',scopes:[]}),/invalid/);
 assert.throws(()=>s.createRole({name:'X',scopes:[],admin:true}),/invalid/,'a custom role cannot be given administration');
 for(const id of ['owner','admin','editor','viewer']){assert.throws(()=>s.updateRole({id,scopes:['read']}),/builtin/);assert.throws(()=>s.updateRole({id,remove:true}),/builtin/);}

 const {user,initialPassword}=await s.createUser({username:'nina',role:'nocni-sluzba'});
 assert.deepEqual([user.role,user.roleId,user.roleName,user.permission,user.admin],['nocni-sluzba','nocni-sluzba','Noční služba','write',false]);
 assert.deepEqual(s.user(user.id).scopes,['read','tickets:write']);
 await s.updateRole({id:role.id,scopes:['review:write'],description:'Review now'});
 assert.deepEqual(s.user(user.id).scopes,['read','review:write'],'a changed role applies to the people who hold it');
 await s.updateRole({id:role.id,scopes:[]});assert.equal(s.user(user.id).permission,'read','a role without a write scope is read-only');
 assert.equal((await s.authenticate('nina',initialPassword)).roleId,'nocni-sluzba');

 await assert.rejects(s.updateRole({id:role.id,remove:true}),/in-use/);
 await assert.rejects(s.updateRole({id:role.id,remove:true,reassignTo:'owner'}),/invalid/);
 await assert.rejects(s.updateRole({id:role.id,remove:true,reassignTo:role.id}),/invalid/);
 const removed=await s.updateRole({id:role.id,remove:true,reassignTo:'editor'},{by:'admin'});
 assert.equal(removed.reassigned,1);assert.equal(s.user(user.id).roleId,'editor');assert.ok(!s.roles().some(r=>r.id===role.id));
 await assert.rejects(s.updateRole({id:role.id,scopes:[]}),/not-found/);
 const lone=await s.createRole({name:'Lone',scopes:[]});assert.equal((await s.updateRole({id:lone.role.id,remove:true})).reassigned,0,'an unused role just goes');

 await s.updateUser({id:user.id,role:'admin'});assert.deepEqual([s.user(user.id).role,s.user(user.id).admin],['admin',true]);
 await assert.rejects(s.updateUser({id:user.id,role:'owner'}),/invalid/);
 await s.updateUser({id:user.id,name:'Nina N.'});assert.equal(s.user(user.id).name,'Nina N.');
 assert.throws(()=>s.updateUser({id:user.id,role:'viewer',disabled:true}),/invalid/,'one change per call');

});

test('audit: who did what, names survive a deletion, and the list can be narrowed',async t=>{
 const dir=await temp(t,'hub-roles-audit-'),s=createAccessStore(dir,credentials);
 const {role}=await s.createRole({name:'Temp',scopes:[]},{by:'admin'});
 const {user}=await s.createUser({username:'gone',role:'temp'},{by:'admin'});
 await s.updateUser({id:user.id,role:'viewer'},{by:'admin'});
 await s.updateRole({id:role.id,remove:true},{by:'admin'});
 await s.updateUser({id:user.id,remove:true},{by:'admin'});
 const {account}=await s.createAccount({name:'agent-full',scopes:['*']},{by:'admin'});
 const key=await s.issueAccountKey({accountId:account.id},{by:'admin'});
 await s.logApi({key:key.key.id,account:account.id,name:'agent-full',route:'/api/tickets',status:201,subject:'HH-1'});
 const all=await readAccessAudit(dir,{accessStore:s});
 assert.deepEqual(all.map(e=>e.event).sort(),['account-created','api-write','key-created','role-created','role-deleted','user-created','user-deleted','user-role-changed']);
 assert.ok(all.filter(e=>e.kind==='access').every(e=>e.by==='admin'));
 assert.equal(all.find(e=>e.event==='role-deleted').subject,'Temp','the name written with the event outlives the role');
 assert.equal(all.find(e=>e.event==='user-deleted').subject,'gone');
 assert.equal(all.find(e=>e.event==='user-role-changed').detail,'role viewer');
 assert.equal(all.find(e=>e.event==='account-created').detail,'full access');
 assert.deepEqual((await readAccessAudit(dir,{accessStore:s,kind:'api'})).map(e=>e.event),['api-write']);
 assert.deepEqual((await readAccessAudit(dir,{accessStore:s,q:'TEMP'})).map(e=>e.event).sort(),['role-created','role-deleted','user-created'],'the search reads the subject and the detail (role temp)');
 assert.equal((await readAccessAudit(dir,{accessStore:s,limit:2})).length,2);
 const text=await readFile(path.join(dir,'access-audit.jsonl'),'utf8');assert.ok(!text.includes(key.token)&&!text.includes('hash'));
});

// What state/access.json looked like before roles, the wildcard and preferences existed: a viewer, a
// hand-promoted admin, a key from before service accounts for each permission, and an account with an
// explicit scope list. Everything must mean exactly what it meant.
test('an access.json from before roles loads unchanged and keeps every effective permission',async t=>{
 const dir=await temp(t,'hub-roles-old-'),file=path.join(dir,'access.json');
 const pw=hashPassword('viewer-password-123');
 const token=n=>'hhk_'+String(n).repeat(64);
 const key=(id,token,extra)=>({id,name:`key ${id}`,prefix:token.slice(0,12),hash:sha(token),createdAt:'2026-10-01T10:00:00.000Z',lastUsedAt:'2099-01-01T00:00:00.000Z',revokedAt:null,...extra});
 const old={schemaVersion:1,
  users:[{id:'aaaaaaaaaaaaaaaa',username:'guest',name:'Guest',role:'viewer',disabled:false,createdAt:'2026-10-01T10:00:00.000Z',passwordAt:'2026-10-01T10:00:00.000Z',...pw},
   {id:'bbbbbbbbbbbbbbbb',username:'second',name:'Second',role:'admin',disabled:false,createdAt:'2026-10-01T10:00:00.000Z',...pw},
   {id:'cccccccccccccccc',username:'norole',name:'No role',disabled:false,createdAt:'2026-10-01T10:00:00.000Z',...pw}],
  keys:[key('1111111111111111',token(1),{permission:'read'}),key('2222222222222222',token(2),{permission:'write'}),key('3333333333333333',token(3),{accountId:'dddddddddddddddd'}),key('4444444444444444',token(4),{accountId:'eeeeeeeeeeeeeeee'})],
  accounts:[{id:'dddddddddddddddd',name:'agent-inventory',description:'old',scopes:['read','inventory:write','gone-plugin:write'],disabled:false,createdAt:'2026-10-01T10:00:00.000Z'},
   {id:'eeeeeeeeeeeeeeee',name:'agent-reader',description:'',scopes:['read'],disabled:false,createdAt:'2026-10-01T10:00:00.000Z'}]};
 const bytes=JSON.stringify(old);await writeFile(file,bytes);
 const s=createAccessStore(dir,credentials);

 assert.deepEqual(s.users().map(u=>[u.username,u.role,u.roleId,u.permission,u.admin]),
  [['admin','admin','owner','write',true],['guest','viewer','viewer','read',false],['second','admin','admin','write',true],['norole','viewer','viewer','read',false]]);
 assert.equal(s.users()[3].roleMissing,true);assert.deepEqual(s.user('aaaaaaaaaaaaaaaa').scopes,['read']);
 assert.equal((await s.authenticate('guest','viewer-password-123')).role,'viewer');

 const read=s.verifyKey(token(1)),write=s.verifyKey(token(2)),agent=s.verifyKey(token(3)),reader=s.verifyKey(token(4));
 assert.deepEqual([read.permission,read.scopes,read.legacy],['read',['read'],true]);
 assert.equal(write.permission,'write');assert.equal(write.legacy,true);
 assert.deepEqual(write.scopes,scopeIds().filter(id=>SCOPES[id].legacy!==false),'an old write key: everything except what was never open to it');
 assert.ok(!write.scopes.includes('security:read'));
 assert.deepEqual([agent.username,agent.permission,agent.scopes,agent.fullAccess],['agent-inventory','write',['read','inventory:write','gone-plugin:write'],false],'explicit scope lists stay exactly as stored, unknown ids included');
 assert.deepEqual([reader.permission,reader.scopes],['read',['read']]);
 assert.deepEqual(s.accounts().map(a=>[a.name,a.scopes,a.fullAccess]),[['agent-inventory',['read','inventory:write','gone-plugin:write'],false],['agent-reader',['read'],false]]);
 assert.deepEqual(s.roles().filter(r=>!r.builtin),[]);
 assert.equal(await readFile(file,'utf8'),bytes,'reading migrates nothing on disk');

 // The first write adds the new optional fields; reading that again changes nothing more (idempotent),
 // and the ids, hashes and scope ids of the old records are byte for byte what they were.
 await s.setTimeZone('aaaaaaaaaaaaaaaa','Europe/Berlin');
 const after=JSON.parse(await readFile(file,'utf8'));
 assert.equal(after.schemaVersion,1,'an older server still accepts the file');
 assert.deepEqual(after.users,old.users);assert.deepEqual(after.keys,old.keys);assert.deepEqual(after.accounts,old.accounts);assert.deepEqual(after.roles,[]);
 const again=createAccessStore(dir,credentials);
 assert.deepEqual(again.users(),s.users());assert.deepEqual(again.verifyKey(token(2)).scopes,write.scopes);assert.deepEqual(again.verifyKey(token(3)).scopes,agent.scopes);
 assert.equal(again.timeZone('aaaaaaaaaaaaaaaa'),'Europe/Berlin');
 await writeFile(file,JSON.stringify({schemaVersion:1,users:[],keys:[]}));assert.deepEqual(createAccessStore(dir,credentials).accounts(),[],'the oldest shape: users and keys only');
 await writeFile(file,JSON.stringify({schemaVersion:1,users:[],keys:[],roles:[{id:'admin',name:'Fake',scopes:['read']}]}));assert.throws(()=>createAccessStore(dir,credentials),/Invalid access store/,'a stored role cannot shadow a built-in one');
});

test('HTTP: people are held to their role\'s scopes; administration needs an admin role and a password',async t=>{
 const h=await hub(t,{plugins:await loadPlugins(fixtures)});
 const get=(url,headers)=>fetch(h.origin+url,{headers});
 const person=async(username,role)=>{const r=await h.post('/api/admin/users',{username,role,password:`${username}-password-123`},h.admin);assert.equal(r.status,201,username);
  const login=await h.post('/api/session',{username,password:`${username}-password-123`});return {id:(await r.json()).user.id,headers:{Cookie:login.headers.get('set-cookie').split(';')[0]}};};
 const made=await h.post('/api/admin/roles',{name:'Auditor',description:'Reads the security pages',scopes:['security:read']},h.admin);
 assert.equal(made.status,201);const auditorRole=(await made.json()).role;assert.equal(auditorRole.id,'auditor');
 const editor=await person('edith','editor'),viewer=await person('victor','viewer'),auditor=await person('audrey','auditor'),second=await person('adam','admin');

 const me=async who=>(await get('/api/me',who.headers)).json();
 assert.deepEqual(await me(editor).then(m=>[m.role,m.roleId,m.roleName,m.canWrite,m.canAdmin]),['editor','editor','Editor',true,false]);
 assert.deepEqual(await me(viewer).then(m=>[m.role,m.canWrite,m.canAdmin,m.scopes]),['viewer',false,false,['read']]);
 assert.deepEqual(await me(auditor).then(m=>[m.role,m.roleName,m.canWrite,m.scopes]),['auditor','Auditor',false,['read','security:read']]);
 assert.deepEqual(await me(second).then(m=>[m.role,m.roleId,m.canWrite,m.canAdmin]),['admin','admin',true,true]);
 assert.deepEqual(await me({headers:h.admin}).then(m=>[m.role,m.roleId,m.roleName,m.canAdmin]),['admin','owner','Vlastník',true],'the owner still reads as admin');

 // Writes: the editor may, by scope; the viewer and the auditor may not.
 assert.equal((await h.post('/api/tickets/projects',{id:'side-project',key:'SP',name:'Side project'},editor.headers)).status,201);
 assert.equal((await h.post('/api/tickets',{project:'home-hub',title:'From an editor'},editor.headers)).status,201);
 assert.equal((await h.post('/api/demo/notes',{text:'plugin scope'},editor.headers)).status,201,'an editor holds plugin write scopes too');
 for(const who of [viewer,auditor]){const r=await h.post('/api/tickets',{project:'home-hub',title:'no'},who.headers);assert.equal(r.status,403);assert.equal((await r.json()).error.code,'READ_ONLY');}
 // Security: by scope, not by being an admin.
 assert.equal((await get('/api/security',auditor.headers)).status,404,'security:read passes (no snapshot in the test dir)');
 assert.equal((await get('/api/security',second.headers)).status,404);
 for(const who of [viewer,editor]){const r=await get('/api/security',who.headers);assert.equal(r.status,403);assert.equal((await r.json()).error.code,'SCOPE_REQUIRED');}
 // The sidebar follows the same rule.
 const pages=async who=>{const m=await (await get('/api/ui/manifest',who.headers)).json();return {open:m.pages.filter(p=>!p.admin).map(p=>p.hash),nav:m.nav.flatMap(g=>g.items.map(i=>i.hash))};};
 assert.ok((await pages(auditor)).nav.includes('security')&&(await pages(auditor)).open.includes('versions'));
 assert.ok(!(await pages(auditor)).nav.includes('demo-admin'),'an admin-only page stays with administrators');
 assert.ok(!(await pages(editor)).nav.includes('security')&&!(await pages(viewer)).open.includes('hardening'));
 assert.ok((await pages(second)).nav.includes('security')&&(await pages(second)).nav.includes('demo-admin'));

 // Administration: the owner and the Admin role, nobody else, and never a key.
 for(const who of [editor,viewer,auditor]){
  for(const url of ['/api/admin/users','/api/admin/roles','/api/admin/accounts','/api/admin/keys','/api/admin/audit','/api/devices/tokens'])assert.equal((await get(url,who.headers)).status,403,url);
  assert.equal((await h.post('/api/admin/users/action',{id:who.id,role:'admin'},who.headers)).status,403,'nobody promotes themselves');
  assert.equal((await h.post('/api/admin/roles',{name:'Mine',scopes:[]},who.headers)).status,403);
 }
 assert.equal((await get('/api/admin/users',second.headers)).status,200);
 assert.equal((await h.post('/api/admin/users/action',{id:'owner',role:'viewer'},second.headers)).status,400,'the owner cannot be demoted');
 assert.equal((await h.post('/api/admin/users/action',{id:'owner',disabled:true},second.headers)).status,400);
 assert.equal((await h.post('/api/admin/users/action',{id:'owner',remove:true},second.headers)).status,400);
 assert.equal((await h.post('/api/admin/users',{username:'boss',role:'owner'},second.headers)).status,400);

 // A role change, and a role's change, apply at the next request.
 assert.equal((await h.post('/api/admin/users/action',{id:viewer.id,role:'editor'},h.admin)).status,200);
 assert.equal((await h.post('/api/tickets',{project:'home-hub',title:'Promoted'},viewer.headers)).status,201);
 assert.equal((await h.post('/api/admin/roles/action',{id:'auditor',scopes:[]},h.admin)).status,200);
 assert.equal((await get('/api/security',auditor.headers)).status,403);
 const inUse=await h.post('/api/admin/roles/action',{id:'auditor',remove:true},h.admin);assert.equal(inUse.status,409);assert.equal((await inUse.json()).error.code,'ROLE_IN_USE');
 const gone=await h.post('/api/admin/roles/action',{id:'auditor',remove:true,reassignTo:'viewer'},h.admin);assert.equal(gone.status,200);assert.equal((await gone.json()).reassigned,1);
 assert.equal((await me(auditor)).roleId,'viewer');
 assert.equal((await h.post('/api/admin/roles/action',{id:'editor',scopes:[]},h.admin)).status,400,'built-in roles cannot be changed');
 const roles=await (await get('/api/admin/roles',h.admin)).json();
 assert.deepEqual(roles.roles.map(r=>[r.id,r.users]),[['owner',1],['admin',1],['editor',2],['viewer',1]]);
 assert.equal(roles.scopes['security:read'].write,false);assert.equal(roles.scopes['demo:write'].module,'demo');
 const audit=await (await get('/api/admin/audit?kind=access&q=audrey',h.admin)).json();
 assert.ok(audit.events.length>0&&audit.events.every(e=>e.kind==='access'));assert.equal(audit.events.at(-1).by,'admin');
 for(const bad of ['?kind=nope','?limit=0','?limit=5000','?who=x'])assert.equal((await get('/api/admin/audit'+bad,h.admin)).status,400,bad);
});

test('HTTP: a full-access agent holds every scope, also a later one, and still never reaches administration',async t=>{
 const h=await hub(t,{plugins:await loadPlugins(fixtures)});
 const listed=await (await fetch(h.origin+'/api/admin/accounts',{headers:h.admin})).json();
 assert.deepEqual(listed.presets.map(p=>p.id),['read','role:editor','role:admin','full']);
 const full=await h.account('agent-full',listed.presets.find(p=>p.id==='full').scopes);
 assert.deepEqual([full.account.scopes,full.account.fullAccess],[['*'],true],'the wildcard is what is stored');
 assert.deepEqual(full.account.effectiveScopes,scopeIds());
 assert.ok(!(await readFile(path.join(h.dir,'access.json'),'utf8')).includes('tickets:write'),'no scope list is written out for it');
 const me=await (await fetch(h.origin+'/api/me',{headers:full.headers})).json();
 assert.deepEqual([me.role,me.authKind,me.canWrite,me.canAdmin,me.fullAccess],['api','api-key',true,false,true]);assert.deepEqual(me.scopes,scopeIds());

 assert.equal((await h.post('/api/tickets/projects',{id:'agent-project',key:'AP',name:'Agent project'},full.headers)).status,201);
 assert.equal((await h.post('/api/demo/notes',{text:'plugin scope'},full.headers)).status,201,'a plugin\'s scope is covered');
 assert.equal((await fetch(h.origin+'/api/security',{headers:full.headers})).status,404,'security:read is covered (no snapshot here)');
 for(const [method,url,body] of [['GET','/api/admin/users'],['GET','/api/admin/roles'],['GET','/api/admin/accounts'],['GET','/api/admin/keys'],['GET','/api/admin/audit'],['GET','/api/devices/tokens'],['GET','/api/profile'],['GET','/api/profile/home-order'],
  ['POST','/api/admin/users',{username:'evil'}],['POST','/api/admin/roles',{name:'Evil',scopes:[]}],['POST','/api/admin/accounts',{name:'escalate',scopes:['*']}],['POST','/api/admin/accounts/keys',{accountId:full.account.id}],['POST','/api/admin/users/password',{id:'owner'}],
  ['POST','/api/devices/tokens',{name:'x'}],['POST','/api/devices/tokens/revoke',{id:'x'}],['POST','/api/session',{username:'admin',password:'administrator-test-password'}],['POST','/api/profile/prefs',{timeZone:null}],['POST','/api/profile/password',{currentPassword:'a',newPassword:'b'}],
  ['POST','/api/home/devices',{name:'x'}]]){
  const r=method==='GET'?await fetch(h.origin+url,{headers:full.headers}):await h.post(url,body,full.headers);
  assert.equal(r.status,403,`${method} ${url}`);assert.ok(['ADMIN_REQUIRED','FORBIDDEN','SCOPE_REQUIRED','SESSION_REQUIRED'].includes((await r.json()).error.code),`${method} ${url}`);
 }
 assert.equal((await (await fetch(h.origin+'/api/admin/users',{headers:h.admin})).json()).users.length,1,'nothing was created through the key');

 // A scope that did not exist when the account was made.
 registerScopes('later',{'later:write':{label:'Later',desc:'Registered while the hub runs.'}});
 assert.ok((await (await fetch(h.origin+'/api/me',{headers:full.headers})).json()).scopes.includes('later:write'));
 const editor=await h.account('agent-editor',listed.presets.find(p=>p.id==='role:editor').scopes);
 assert.ok(!(await (await fetch(h.origin+'/api/me',{headers:editor.headers})).json()).scopes.includes('later:write'),'a role preset is a snapshot');
 assert.equal((await h.post('/api/admin/accounts',{name:'bad-mix',scopes:['root']},h.admin)).status,400);

 // MCP: every tool is listed, whoami says what the key holds, and no tool manages access.
 const rpc=(method,params,headers=full.headers)=>fetch(h.origin+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})}).then(r=>r.json());
 const tools=(await rpc('tools/list')).result.tools.map(x=>x.name);
 assert.ok(tools.includes('whoami')&&tools.includes('ticket_create')&&tools.includes('inventory_update')&&tools.includes('review_publish'));
 assert.ok(!tools.some(n=>/user|role|account|key|token|password/.test(n)),'access is never managed over MCP');
 const who=(await rpc('tools/call',{name:'whoami',arguments:{}})).result.structuredContent;
 assert.deepEqual([who.account,who.kind,who.fullAccess,who.canWrite],['agent-full','service account',true,true]);
 assert.deepEqual(who.scopes.map(x=>x.id),scopeIds());assert.equal(who.scopes.find(x=>x.id==='security:read').write,false);assert.ok(who.never.some(x=>x.startsWith('/api/admin/')));
 const reader=await h.account('agent-reader',['read']);
 const mine=(await rpc('tools/call',{name:'whoami',arguments:{}},reader.headers)).result.structuredContent;
 assert.deepEqual([mine.fullAccess,mine.canWrite,mine.scopes.map(x=>x.id)],[false,false,['read']]);
 const text=JSON.stringify(who);assert.ok(!text.includes(full.token)&&!text.includes('hash'));
});

test('own time zone: a preference per account, applied through the manifest, password sign-in only',async t=>{
 assert.ok(validTimeZone('Europe/Prague')&&validTimeZone('UTC')&&validTimeZone('browser')&&validTimeZone('America/Argentina/Buenos_Aires'));
 for(const bad of ['Mars/Olympus','../etc/passwd','',null,42,'x'.repeat(70),'Europe/Prague; rm'])assert.equal(validTimeZone(bad),false,String(bad));
 const h=await hub(t);
 const manifest=async()=>(await fetch(h.origin+'/api/ui/manifest',{headers:h.admin})).json();
 assert.equal((await manifest()).site.timeZone,'Europe/Berlin','the site\'s zone until the person chooses');
 const profile=await (await fetch(h.origin+'/api/profile',{headers:h.admin})).json();
 assert.deepEqual([profile.user.username,profile.user.roleId,profile.user.builtin,profile.prefs.timeZone,profile.site.timeZone],['admin','owner',true,null,'Europe/Berlin']);
 const set=await h.post('/api/profile/prefs',{timeZone:'Asia/Tokyo'},h.admin);assert.equal(set.status,200);assert.equal((await set.json()).site.timeZone,'Asia/Tokyo');
 assert.equal((await manifest()).site.timeZone,'Asia/Tokyo');
 assert.equal((await (await fetch(h.origin+'/api/ui/manifest')).json()).site.timeZone,'Europe/Berlin','signed out: the site\'s zone');
 await h.post('/api/profile/prefs',{timeZone:'browser'},h.admin);assert.equal((await manifest()).site.timeZone,null,'"browser" = no zone forced');
 await h.post('/api/profile/prefs',{timeZone:null},h.admin);assert.equal((await manifest()).site.timeZone,'Europe/Berlin');
 for(const bad of [{timeZone:'Mars/Olympus'},{timeZone:5},{},{timeZone:null,extra:1}])assert.equal((await h.post('/api/profile/prefs',bad,h.admin)).status,400,JSON.stringify(bad));
 const agent=await h.account('agent-reader',['read']);
 assert.equal((await h.post('/api/profile/prefs',{timeZone:null},agent.headers)).status,403);
 assert.equal((await h.post('/api/profile/prefs',{timeZone:null},{...h.admin,Origin:'https://evil.example'})).status,403);
 const stored=JSON.parse(await readFile(path.join(h.dir,'access.json'),'utf8'));assert.equal(stored.prefs.owner,undefined,'back to the default leaves nothing behind');
});

// home:write and software:write arrived after roles and presets did. Nothing lists scopes by hand, so the
// built-in roles, the presets and the wildcard pick them up; keys from before service accounts never do.
test('newer scopes: Editor, the presets and full access hold home:write and software:write; a legacy write key does not',async t=>{
 const NEWER=['home:write','software:write'];
 for(const id of NEWER)assert.ok(SCOPES[id]&&!SCOPES[id].readOnly&&SCOPES[id].legacy===false,id);
 for(const role of ['owner','admin','editor'])assert.ok(NEWER.every(id=>roleOf(role).scopes.includes(id)),role);
 assert.deepEqual(roleOf('editor').scopes,scopeIds().filter(id=>id==='read'||!SCOPES[id].readOnly),'Editor = read and every write scope there is');
 assert.deepEqual(roleOf('viewer').scopes,['read']);
 assert.ok(NEWER.every(id=>resolveScopes(['*']).includes(id)));
 assert.deepEqual(legacyScopes('read'),['read']);
 assert.deepEqual(legacyScopes('write').filter(id=>SCOPES[id].legacy===false),[],'nothing marked legacy:false reaches an old write key');
 assert.ok(legacyScopes('write').includes('tickets:write')&&legacyScopes('write').includes('inventory:write'),'it keeps what it always had');
 // A plugin's scope follows the same rules without any list being edited.
 registerScopes('lab-plugin',{'lab:write':{label:'Lab – zápis',desc:'A write scope added later.',legacy:false},'lab:read':{label:'Lab – čtení',desc:'A sensitive read.',readOnly:true,legacy:false}});
 assert.ok(roleOf('editor').scopes.includes('lab:write')&&!roleOf('editor').scopes.includes('lab:read'));
 assert.ok(roleOf('admin').scopes.includes('lab:read')&&resolveScopes(['*']).includes('lab:read'));
 assert.ok(!legacyScopes('write').includes('lab:write')&&!legacyScopes('write').includes('lab:read'));

 const h=await hub(t);
 const listed=await (await fetch(h.origin+'/api/admin/accounts',{headers:h.admin})).json(),preset=id=>listed.presets.find(p=>p.id===id);
 assert.ok(NEWER.every(id=>preset('role:editor').scopes.includes(id)&&preset('role:admin').scopes.includes(id)));
 assert.deepEqual([preset('read').scopes,preset('full').scopes],[['read'],['*']]);
 // The preset preview draws a chip per scope from this catalog: every scope of every preset has its label there.
 for(const p of listed.presets)for(const id of p.scopes)if(id!=='*')assert.ok(listed.scopes[id]?.label,`${p.id}: ${id}`);
 assert.deepEqual(Object.keys(listed.scopes),scopeIds(),'full access previews every scope of the catalog');
 assert.deepEqual(NEWER.map(id=>[listed.scopes[id].write,listed.scopes[id].legacy]),[[true,false],[true,false]]);
 assert.deepEqual([listed.scopes['tickets:write'].legacy,listed.scopes['security:read'].legacy,listed.scopes.read.legacy],[true,false,true]);

 const editor=await h.account('agent-editor',preset('role:editor').scopes),full=await h.account('agent-full',['*']);
 const old={Authorization:'Bearer '+(await (await h.post('/api/admin/keys',{name:'Old writer',permission:'write'},h.admin)).json()).token};
 const me=async headers=>(await (await fetch(h.origin+'/api/me',{headers})).json()).scopes;
 const tools=async headers=>(await (await fetch(h.origin+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})})).json()).result.tools.map(x=>x.name);
 for(const who of [editor.headers,full.headers]){
  const held=await me(who);assert.ok(NEWER.every(id=>held.includes(id)));
  const names=await tools(who);for(const name of ['machine_upsert','machine_remove','runtime_publish','software_watch_list','software_watch_put'])assert.ok(names.includes(name),name);
 }
 assert.ok(NEWER.every(id=>!editor.account.scopes.includes('*')&&editor.account.scopes.includes(id)),'the Editor preset stores the list, new scopes included');
 const oldScopes=await me(old),oldTools=await tools(old);
 assert.ok(oldScopes.includes('tickets:write')&&NEWER.every(id=>!oldScopes.includes(id))&&!oldScopes.includes('security:read'));
 assert.ok(oldTools.includes('ticket_create')&&oldTools.includes('machine_list'));
 for(const name of ['machine_upsert','machine_remove','runtime_publish','software_watch_list','software_watch_put'])assert.ok(!oldTools.includes(name),`a legacy key must not see ${name}`);
 const refused=await h.post('/api/home/machines',{machine:{id:'pi',name:'Pi'}},old);
 assert.equal(refused.status,403);assert.equal((await refused.json()).error.code,'SCOPE_REQUIRED');
});
