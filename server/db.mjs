// One SQLite file, state/hub.db, for the text-heavy stores (tickets, review index), the sign-in sessions and the
// full-text search across them. node:sqlite is built into Node (no npm dependency); FTS5 is compiled in.
//
// Stores keep their document model: a collection is a table of JSON documents (one row per ticket, review set, …)
// plus one meta document. A write loads the document, lets the store's validated code change it, and saves only
// the rows that changed, all in one transaction together with their search entries. Blobs stay files.
// See docs/storage.md.
import {mkdirSync,chmodSync,existsSync} from 'node:fs';
import {readFile,rename} from 'node:fs/promises';
import path from 'node:path';

const SCHEMA=1,SEARCH_VERSION=1;
// The schema version of hub.db, for the data-epoch table (tests/data-epoch.test.mjs).
export const DB_SCHEMA=SCHEMA;
const open=new Map();
let DatabaseSync=null;
function driver(){
 if(DatabaseSync)return DatabaseSync;
 // node:sqlite still emits an ExperimentalWarning on Node 22–24; this one expected warning is silenced.
 const emit=process.emitWarning;process.emitWarning=(w,...a)=>{if(String(w?.message??w).includes('SQLite'))return;return emit.call(process,w,...a);};
 try{({DatabaseSync}=process.getBuiltinModule('node:sqlite'));}finally{process.emitWarning=emit;}
 return DatabaseSync;
}

// Shared per file: every store in one process uses the same connection. Synchronous, like the API it wraps.
export function openDb(file){
 file=path.resolve(file);if(open.has(file))return open.get(file);
 const Db=driver();mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
 const db=new Db(file);
 try{db.exec('PRAGMA journal_mode=WAL;PRAGMA synchronous=NORMAL;PRAGMA busy_timeout=5000;');migrate(db);}catch(e){db.close();throw e;}
 for(const f of [file,file+'-wal',file+'-shm'])if(existsSync(f))chmodSync(f,0o600);
 const handle=wrap(db,file);open.set(file,handle);return handle;
}

function migrate(db){
 const version=db.prepare('PRAGMA user_version').get().user_version;
 if(version>SCHEMA)throw new Error(`hub.db schema ${version} is newer than this code (${SCHEMA})`);
 if(version<1)db.exec(`BEGIN;
  CREATE TABLE IF NOT EXISTS meta(kind TEXT PRIMARY KEY, doc TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS docs(kind TEXT NOT NULL, coll TEXT NOT NULL, id TEXT NOT NULL, doc TEXT NOT NULL, PRIMARY KEY(kind,coll,id));
  CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, password_at TEXT, until INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS sessions_until ON sessions(until);
  CREATE TABLE IF NOT EXISTS search_version(kind TEXT PRIMARY KEY, version INTEGER NOT NULL);
  CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(kind UNINDEXED, id UNINDEXED, project UNINDEXED, updated UNINDEXED, title, body,
   tokenize='unicode61 remove_diacritics 2', prefix='2 3');
  PRAGMA user_version=1; COMMIT;`);
}

function wrap(db,file){
 const q=sql=>db.prepare(sql);
 const st={
  meta:q('SELECT doc FROM meta WHERE kind=?'),putMeta:q('INSERT INTO meta(kind,doc) VALUES(?,?) ON CONFLICT(kind) DO UPDATE SET doc=excluded.doc'),
  rows:q('SELECT coll,id,doc FROM docs WHERE kind=? ORDER BY rowid'),
  put:q('INSERT INTO docs(kind,coll,id,doc) VALUES(?,?,?,?) ON CONFLICT(kind,coll,id) DO UPDATE SET doc=excluded.doc'),
  del:q('DELETE FROM docs WHERE kind=? AND coll=? AND id=?'),
  unindex:q('DELETE FROM search WHERE kind=? AND id=?'),index:q('INSERT INTO search(kind,id,project,updated,title,body) VALUES(?,?,?,?,?,?)'),
  clearIndex:q('DELETE FROM search WHERE kind=?'),
  indexVersion:q('SELECT version FROM search_version WHERE kind=?'),setIndexVersion:q('INSERT OR REPLACE INTO search_version(kind,version) VALUES(?,?)'),
 };
 function tx(fn){db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r;}catch(e){try{db.exec('ROLLBACK');}catch{}throw e;}}

 // A document store. split(data) → {meta, colls:{name:[[id,doc],…]}}; join(meta, colls) → data.
 // search(coll, doc) → {kind,id,project,updated,title,body} | null decides what goes into the search index.
 // searchKinds names the search kinds this collection writes, so a SEARCH_VERSION bump can rebuild them.
 const collections=new Map();
 function collection(kind,spec){if(!collections.has(kind))collections.set(kind,makeCollection(kind,spec));return collections.get(kind);}
 function makeCollection(kind,{empty,split,join,search=()=>null,searchKinds=[],legacy=null,valid=()=>true}){
  let snapshot=null,ready=null;
  const stamp=(coll,id)=>coll+'\u0000'+id;
  function load(){
   const m=st.meta.get(kind);if(!m)return null;
   const colls={};for(const r of st.rows.all(kind))(colls[r.coll]??=[]).push([r.id,JSON.parse(r.doc)]);
   const data=join(JSON.parse(m.doc),colls);return data;
  }
  function save(data,{full=false}={}){
   const {meta,colls}=split(data),next=new Map();
   for(const [coll,rows] of Object.entries(colls))for(const [id,doc] of rows)next.set(stamp(coll,id),{coll,id,doc,json:JSON.stringify(doc)});
   tx(()=>{
    st.putMeta.run(kind,JSON.stringify(meta));
    for(const [key,r] of next)if(full||snapshot?.get(key)!==r.json){
     st.put.run(kind,r.coll,r.id,r.json);const e=search(r.coll,r.doc);
     if(e){st.unindex.run(e.kind,e.id);st.index.run(e.kind,e.id,e.project??null,e.updated??null,e.title??'',e.body??'');}
    }
    if(snapshot)for(const key of snapshot.keys())if(!next.has(key)){const [coll,id]=key.split('\u0000');st.del.run(kind,coll,id);}
   });
   snapshot=new Map([...next].map(([k,r])=>[k,r.json]));
  }
  function reindex(data){
   const {colls}=split(data);
   tx(()=>{
    for(const k of searchKinds)st.clearIndex.run(k);
    for(const [coll,rows] of Object.entries(colls))for(const [,doc] of rows){const e=search(coll,doc);if(e)st.index.run(e.kind,e.id,e.project??null,e.updated??null,e.title??'',e.body??'');}
    for(const k of searchKinds)st.setIndexVersion.run(k,SEARCH_VERSION);
   });
  }
  const stale=()=>searchKinds.some(k=>st.indexVersion.get(k)?.version!==SEARCH_VERSION);
  // First use: import the old JSON file once (then it is renamed *.migrated), and rebuild the index if it is missing.
  async function init(){
   if(st.meta.get(kind)){if(stale())reindex(load());return;}
   let data=empty();
   if(legacy){
    let raw=null;try{raw=await readFile(legacy,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
    if(raw!==null){data=JSON.parse(raw);if(!valid(data))throw new Error(`Invalid ${path.basename(legacy)}; not imported`);}
   }
   if(st.meta.get(kind))return;
   snapshot=null;save(data,{full:true});reindex(data);
   if(legacy&&existsSync(legacy))await rename(legacy,legacy+'.migrated');
  }
  const ensure=()=>ready??=init().catch(e=>{ready=null;throw e;});
  const store={
   async read(){await ensure();const data=load();snapshot=new Map();const {colls}=split(data);for(const [coll,rows] of Object.entries(colls))for(const [id,doc] of rows)snapshot.set(stamp(coll,id),JSON.stringify(doc));return data;},
   // The caller serialises writes (one queue per store), so read → change → write cannot interleave.
   async write(data){await ensure();save(data);},
   async reindex(){await ensure();reindex(load());},
  };
  return store;
 }

 // Hashed sign-in sessions, so a restart or deploy no longer signs everyone out.
 const ses={get:q('SELECT user_id,password_at,until FROM sessions WHERE hash=?'),put:q('INSERT OR REPLACE INTO sessions(hash,user_id,password_at,until) VALUES(?,?,?,?)'),
  del:q('DELETE FROM sessions WHERE hash=?'),prune:q('DELETE FROM sessions WHERE until<?'),count:q('SELECT count(*) n FROM sessions')};
 const sessions={
  get(hash){const r=ses.get.get(hash);return r?{userId:r.user_id,passwordAt:r.password_at,until:r.until}:undefined;},
  set(hash,s){ses.put.run(hash,s.userId,s.passwordAt??null,s.until);},
  delete(hash){ses.del.run(hash);},
  prune(now){ses.prune.run(now);},
  get size(){return ses.count.get().n;},
 };

 // Full-text search. Input is plain words, never FTS syntax: each word is quoted and prefix-matched (AND).
 const KINDS=['ticket','review'];
 // max: the largest limit a caller may ask for. HTTP and MCP callers get 100; a store that filters the hits
 // further (tickets-store search) passes its own ceiling.
 function search({q,kind,project,limit=20}={},{max=100}={}){
  if(typeof q!=='string'||q.length>200)throw new Error('invalid');
  if(kind!==undefined&&kind!==''&&!KINDS.includes(kind)||project!==undefined&&project!==''&&!/^[a-z][a-z0-9-]{1,39}$/.test(project))throw new Error('invalid');
  limit=Number(limit);if(!Number.isInteger(limit)||limit<1||limit>max)throw new Error('invalid');
  const words=q.normalize('NFC').match(/[\p{L}\p{N}_]+/gu)?.slice(0,12)||[];
  if(!words.length)return {q,total:0,results:[]};
  const match=words.map(w=>`"${w}"*`).join(' ');
  const where=['search MATCH ?'],args=[match];
  if(kind){where.push('kind=?');args.push(kind);}if(project){where.push('project=?');args.push(project);}
  // A query that is an id (APP-12, R-3) puts that very record first; everything else is ranked by relevance.
  const rows=db.prepare(`SELECT kind,id,project,updated,highlight(search,4,char(1),char(2)) title,snippet(search,5,char(1),char(2),'…',14) snippet,bm25(search,0,0,0,0,4,1) score
   FROM search WHERE ${where.join(' AND ')} ORDER BY (id=?) DESC, score LIMIT ?`).all(...args,q.trim().toUpperCase(),limit);
  // \u0001…\u0002 mark the matches; the UI renders them as <mark> through text nodes, never as HTML.
  return {q,total:rows.length,results:rows.map(r=>({kind:r.kind,id:r.id,project:r.project,updatedAt:r.updated,title:r.title,snippet:r.snippet,score:Number((-r.score).toPrecision(4))}))};
 }
 // How many documents of each kind the index holds: lets a client tell "nothing to search yet" from "no match".
 const indexed=q('SELECT kind,count(*) n FROM search GROUP BY kind');
 function searchStats(){const out=Object.fromEntries(KINDS.map(k=>[k,0]));for(const r of indexed.all())if(Object.hasOwn(out,r.kind))out[r.kind]=Number(r.n);return out;}
 return {file,db,collection,sessions,search,searchStats,close(){open.delete(file);db.close();}};
}
