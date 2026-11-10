// state/hub.db: the one-time import of the old JSON files, full-text search, and sign-in sessions that survive a restart.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,stat,mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {openDb} from '../server/db.mjs';
import {createTicketStore as createStore} from '../server/tickets-store.mjs';
// The tracker seeds nothing by itself; these tests start with the two projects a site would configure.
const SEED=[{id:'home-hub',key:'HH',name:'Home Hub',type:'app'},{id:'sample-game',key:'GAME',name:'Sample Game',type:'game'}];
const createTicketStore=(root,options={})=>createStore(root,{seedProjects:SEED,...options});
import {createReviewStore} from '../server/review-store.mjs';
import {createAuth,hashPassword} from '../server/auth.mjs';
import {createAccessStore} from '../server/access-store.mjs';
import {hub} from './hub-helper.mjs';

async function tmp(t,prefix='hubdb-'){const dir=await mkdtemp(path.join(os.tmpdir(),prefix));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
const strip=s=>s.replace(/[\u0001\u0002]/g,'');

test('storage: old tickets.json and review.json are imported once, then renamed *.migrated',async t=>{
 const dir=await tmp(t);await mkdir(path.join(dir,'tickets'));await mkdir(path.join(dir,'review'));
 const now='2026-11-01T10:00:00.000Z';
 const legacy={schema:1,revision:7,updatedAt:now,projects:[{id:'home-hub',key:'HH',name:'Home Hub',type:'app',description:'',createdAt:null,rev:1,next:3}],releases:[{project:'home-hub',version:'2.0',status:'planned',targetDate:null,releasedAt:null,notes:'',createdAt:now,createdBy:'a',updatedAt:now,rev:1}],
  tickets:[{id:'HH-2',project:'home-hub',title:'Přihlášení v nové záložce',description:'Session se ztratí po deployi.',type:'bug',status:'open',priority:'high',release:'2.0',assignee:null,labels:['auth'],refs:[],reporter:'a',createdAt:now,updatedAt:now,closedAt:null,rev:1,
   comments:[{id:'c1',at:now,by:'a',text:'Restart vymaže paměť serveru.'}],history:[]}]};
 await writeFile(path.join(dir,'tickets','tickets.json'),JSON.stringify(legacy));
 await writeFile(path.join(dir,'review','review.json'),JSON.stringify({schema:1,next:2,updatedAt:now,blobs:{},sets:[{id:'R-1',project:'home-hub',title:'Vyhledávací pole',description:'',tickets:['HH-2'],status:'open',createdAt:now,createdBy:'a',updatedAt:now,rev:1,
  rounds:[{n:1,notes:'Dvě varianty umístění',addresses:[],publishedAt:now,publishedBy:'a',items:[],feedback:{}}]}]}));
 const db=openDb(path.join(dir,'hub.db')),tickets=createTicketStore(path.join(dir,'tickets'),{db}),review=createReviewStore(path.join(dir,'review'),{tickets,db});
 const list=await tickets.list();assert.deepEqual(list.tickets.map(x=>x.id),['HH-2']);assert.equal(list.releases[0].total,1);
 assert.equal((await review.get('R-1')).rounds[0].notes,'Dvě varianty umístění');
 for(const f of ['tickets/tickets.json','review/review.json']){await assert.rejects(stat(path.join(dir,f)),/ENOENT/);await stat(path.join(dir,f+'.migrated'));}
 // Numbering, revisions and the document revision carry on from the imported file.
 const next=await tickets.create({project:'home-hub',title:'Další'},'a');assert.equal(next.id,'HH-3');
 assert.equal((await tickets.list()).tickets.length,2);
 assert.deepEqual(db.search({q:'restart'}).results.map(r=>r.id),['HH-2'],'comments are searchable after the import');
 assert.deepEqual(db.search({q:'umisteni'}).results.map(r=>r.id),['R-1'],'review notes are searchable, diacritics ignored');
 // A second store on the same database does not import again or lose anything.
 assert.equal((await createTicketStore(path.join(dir,'tickets'),{db}).list()).tickets.length,2);
});

test('storage: search ignores diacritics and case, matches prefixes, filters, and never takes FTS syntax from the user',async t=>{
 const dir=await tmp(t),db=openDb(path.join(dir,'hub.db')),s=createTicketStore(dir,{db});
 const a=await s.create({project:'home-hub',title:'Přihlášení v nové záložce',description:'Po deployi je potřeba se znovu přihlásit.',labels:['auth']},'a');
 const b=await s.create({project:'sample-game',title:'Písek na textuře',type:'bug'},'a');
 await s.comment({id:b.id,text:'Žlutá je moc sytá, zkus přihlášení obejít'},'a');
 assert.deepEqual(db.search({q:'PRIHLASENI'}).results.map(r=>r.id).sort(),[a.id,b.id].sort());
 assert.equal(db.search({q:'prihlas'}).results.length,2,'prefix match');
 assert.deepEqual(db.search({q:'prihlaseni zalozce'}).results.map(r=>r.id),[a.id],'all words must match');
 assert.deepEqual(db.search({q:'prihlaseni',project:'sample-game'}).results.map(r=>r.id),[b.id]);
 assert.equal(db.search({q:'prihlaseni',kind:'review'}).results.length,0);
 // A title hit ranks above a comment hit.
 assert.equal(db.search({q:'prihlaseni'}).results[0].id,a.id);
 const hit=db.search({q:'zalozce'}).results[0];assert.match(hit.title,/\u0001záložce\u0002/);assert.equal(strip(hit.title),`${a.id} Přihlášení v nové záložce`);assert.equal(hit.kind,'ticket');
 // Updates and comments re-index; nothing stale is left behind.
 await s.update({id:a.id,rev:1,title:'Session po restartu'},'a');
 assert.equal(db.search({q:'zalozce'}).results.length,0);assert.deepEqual(db.search({q:'restartu'}).results.map(r=>r.id),[a.id]);
 for(const q of ['"','*','NEAR(a b)','a OR','title:x','-','()',"'; DROP TABLE docs; --",'^x'])assert.doesNotThrow(()=>db.search({q}),q);
 assert.deepEqual(db.search({q:'  '}).results,[]);
 for(const bad of [{q:1},{q:'x'.repeat(201)},{q:'a',kind:'user'},{q:'a',project:'../x'},{q:'a',limit:0},{q:'a',limit:101},{q:'a',limit:'x'}])assert.throws(()=>db.search(bad),/invalid/);
});

test('storage: sessions are stored hashed and survive a restart; logout and a password change still end them',async t=>{
 const dir=await tmp(t),file=path.join(dir,'hub.db'),ownerFile=path.join(dir,'auth.json');
 const credentials={username:'admin',...hashPassword('first-password-123')};await writeFile(ownerFile,JSON.stringify(credentials));
 const boot=()=>{const creds=JSON.parse(JSON.stringify(credentials));const accounts=createAccessStore(dir,creds,{ownerFile});return {accounts,auth:createAuth(creds,{accounts,sessions:openDb(file).sessions})};};
 let {auth,accounts}=boot();
 const first=(await auth.login('admin','first-password-123','ip')).cookie,second=(await auth.login('admin','first-password-123','ip')).cookie;
 assert(auth.valid(first)&&auth.valid(second));
 const token=/homehub=([a-f0-9]{64})/.exec(first)[1];for(const f of [file,file+'-wal'])assert(!(await readFile(f).catch(()=>Buffer.alloc(0))).includes(token),'only the SHA-256 is stored');
 assert.equal((await stat(file)).mode&0o777,0o600);
 // "Restart": new auth and access store over the same files.
 ({auth,accounts}=boot());assert(auth.valid(first),'a restart keeps the session');assert.equal(auth.principal(first).username,'admin');
 auth.logout(first);assert(!auth.valid(first));
 // The owner's password change is stamped in auth.json, so the old session stays ended after the next restart too.
 await accounts.changePassword('owner',{currentPassword:'first-password-123',newPassword:'second-password-456'});
 assert(!auth.valid(second));
 const stored=JSON.parse(await readFile(ownerFile,'utf8'));assert.match(stored.passwordAt,/^\d{4}-/);
 const creds=stored,again=createAuth(creds,{accounts:createAccessStore(dir,creds,{ownerFile}),sessions:openDb(file).sessions});
 assert(!again.valid(second),'a restart does not bring an ended session back');
 const fresh=(await again.login('admin','second-password-456','ip')).cookie;assert(again.valid(fresh));
});

test('storage HTTP: /api/search needs a sign-in, finds tickets, and rejects bad queries',async t=>{
 const h=await hub(t);
 assert.equal((await fetch(h.origin+'/api/search?q=x')).status,401);
 const made=await (await h.post('/api/tickets',{project:'home-hub',title:'Vyhledávání přes SQLite'},h.admin)).json();
 const r=await fetch(h.origin+'/api/search?q=vyhledavani',{headers:h.admin});assert.equal(r.status,200);
 const body=await r.json();assert.deepEqual(body.results.map(x=>x.id),[made.id]);assert.equal(body.results[0].project,'home-hub');
 const {token}=await h.account('reader',[]);assert.equal((await fetch(h.origin+'/api/search?q=sqlite',{headers:{Authorization:'Bearer '+token}})).status,200,'read scope is enough');
 for(const q of ['q=a&kind=user','q=a&limit=500','q=a&extra=1'])assert.equal((await fetch(h.origin+'/api/search?'+q,{headers:h.admin})).status,400,q);
 // MCP: the same search as a read tool.
 const call=async args=>(await (await fetch(h.origin+'/mcp',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'search',arguments:args}})})).json()).result;
 const hit=await call({query:'vyhledavani'});assert.deepEqual(hit.structuredContent.results.map(x=>x.id),[made.id]);
 assert.equal((await call({query:'x',limit:500})).isError,true);
});
