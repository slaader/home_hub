// A fake git host for the Git LFS tests: one HTTP server on 127.0.0.1 that answers like Gitea/Forgejo
// (/api/v1) or GitHub Enterprise (/api/v3), serves real git over smart HTTP (git http-backend, CGI) from bare
// repositories in a temp dir, and the Git LFS batch API from an in-memory object store. It also has a small
// "list and delete" API for a test provider that can delete (no real host has one). No external network.
import http from 'node:http';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const GIT_ENV={...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_AUTHOR_NAME:'Test',GIT_AUTHOR_EMAIL:'test@example.lan',GIT_COMMITTER_NAME:'Test',GIT_COMMITTER_EMAIL:'test@example.lan'};
export const git=(cwd,...args)=>execFileSync('git',args,{cwd,env:GIT_ENV,stdio:['ignore','pipe','pipe']}).toString().trim();
export const oid=ch=>ch.repeat(64);
export const pointer=(o,size)=>`version https://git-lfs.github.com/spec/v1\noid sha256:${o}\nsize ${size}\n`;

// A work tree that pushes to a bare repository served by the host. commit(files, message) writes the files
// (a value of null deletes one) and commits; at = a fixed date so the history is stable.
export function workTree(host,fullName,{branch='main'}={}){
 const dir=mkdtempSync(path.join(host.root,'work-'));let tick=0;
 git(dir,'init','-q','-b',branch);git(dir,'remote','add','origin',host.barePath(fullName));
 return {dir,
  commit(files,message='change',{at}={}){
   for(const [name,body] of Object.entries(files)){const file=path.join(dir,name);if(body===null){git(dir,'rm','-q','--',name);continue;}mkdirSync(path.dirname(file),{recursive:true});writeFileSync(file,body);git(dir,'add','--',name);}
   const when=at||`2026-01-0${Math.min(9,1+tick++)}T12:00:00Z`;
   execFileSync('git',['commit','-q','-m',message],{cwd:dir,env:{...GIT_ENV,GIT_AUTHOR_DATE:when,GIT_COMMITTER_DATE:when}});
   return git(dir,'rev-parse','HEAD');
  },
  git:(...args)=>git(dir,...args),
  push:(...refs)=>git(dir,'push','-q','--force','origin',...(refs.length?refs:['--all'])),
 };
}

/**
 * kind: 'gitea' (API under /api/v1, token auth "token …") or 'github' (API under /api/v3, Bearer, X-OAuth-Scopes).
 * token: the one token it accepts; login: who that is. scopes: what /token (gitea) or X-OAuth-Scopes (github) says.
 */
// maxPage: the most items a page holds whatever the client asks for (Gitea's MAX_RESPONSE_ITEMS).
export async function gitHost(t,{kind='gitea',token='test-token-123456',login='alice',scopes=['read:repository','read:user'],maxPage=Infinity}={}){
 const root=mkdtempSync(path.join(os.tmpdir(),'git-host-'));
 const repos=new Map();// fullName → {defaultBranch, private}
 const store=new Map();// fullName → Map(oid → {size, createdAt})
 const log=[];// every request: {method, path, auth}
 const fail={};// path prefix → status, to make the host fail on purpose
 const redirect={};// path prefix → Location: answered 302
 const delay={};// path prefix → ms before the request is handled
 const deleted=[];
 const barePath=fullName=>path.join(root,'repos',fullName+'.git');
 const api=kind==='github'?'/api/v3':'/api/v1';
 const json=(res,status,body,headers={})=>{res.writeHead(status,{'Content-Type':'application/json',...headers});res.end(JSON.stringify(body));};
 const apiAuth=req=>{const a=req.headers.authorization||'';return a===`token ${token}`||a===`Bearer ${token}`;};
 const basicAuth=req=>{const a=req.headers.authorization||'';if(!a.startsWith('Basic '))return false;const [,pass]=Buffer.from(a.slice(6),'base64').toString().split(':');return pass===token;};
 const repoJson=(fullName,r)=>{const [owner,name]=fullName.split('/');return {name,full_name:fullName,owner:{login:owner,username:owner},default_branch:r.defaultBranch,private:r.private,archived:false,empty:false,clone_url:`http://evil.example.lan/${fullName}.git`};};
 const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://x'),p=url.pathname;
  log.push({method:req.method,path:p,auth:req.headers.authorization||null});
  for(const [prefix,ms] of Object.entries(delay))if(p.startsWith(prefix))await new Promise(r=>setTimeout(r,ms));
  for(const [prefix,to] of Object.entries(redirect))if(p.startsWith(prefix)){req.resume();res.writeHead(302,{Location:to});return res.end();}
  for(const [prefix,status] of Object.entries(fail))if(p.startsWith(prefix)){req.resume();return json(res,status,{message:'failing on purpose'});}
  // --- git smart HTTP -------------------------------------------------------------------------------
  const gm=/^\/([^/]+\/[^/]+)\.git(\/(?:info\/refs|git-upload-pack))$/.exec(p);
  if(gm){
   if(!basicAuth(req)){req.resume();res.writeHead(401,{'WWW-Authenticate':'Basic realm="git"'});return res.end();}
   if(!repos.has(gm[1])){req.resume();res.writeHead(404);return res.end();}
   if(url.searchParams.get('service')==='git-receive-pack'||p.endsWith('receive-pack')){req.resume();res.writeHead(403);return res.end();}
   return cgi(req,res,{PATH_INFO:`/${gm[1]}.git${gm[2]}`,QUERY_STRING:url.search.slice(1)});
  }
  // --- LFS batch API -------------------------------------------------------------------------------
  const lm=/^\/([^/]+\/[^/]+)\.git\/info\/lfs\/objects\/batch$/.exec(p);
  if(lm&&req.method==='POST'){
   let body='';for await(const c of req)body+=c;
   if(!basicAuth(req))return json(res,401,{message:'Credentials needed'},{'LFS-Authenticate':'Basic realm="lfs"'});
   const objects=store.get(lm[1]);if(!objects)return json(res,404,{message:'Not found'});
   const reqBody=JSON.parse(body);
   return json(res,200,{transfer:'basic',objects:reqBody.objects.map(o=>objects.has(o.oid)?{oid:o.oid,size:objects.get(o.oid).size,actions:{download:{href:`http://lfs.example.lan/${o.oid}`}}}:{oid:o.oid,size:o.size,error:{code:404,message:'Object does not exist'}})},{'Content-Type':'application/vnd.git-lfs+json'});
  }
  // --- the REST API --------------------------------------------------------------------------------
  if(!p.startsWith(api+'/')&&!p.startsWith('/api/fake/')){req.resume();return json(res,404,{message:'not found'});}
  if(!apiAuth(req)){req.resume();return json(res,401,{message:'Bad credentials'});}
  const sub=p.startsWith(api)?p.slice(api.length):p;
  if(sub==='/user'){
   const headers=kind==='github'&&scopes?{'X-OAuth-Scopes':scopes.join(', ')}:{};
   return json(res,200,{login,username:login,full_name:'Alice Example',name:'Alice Example'},headers);
  }
  if(sub==='/token'&&kind==='gitea')return scopes?json(res,200,{id:1,name:'hub',scopes}):json(res,404,{message:'not found'});
  const page=(list)=>{
   const per=Math.min(maxPage,Number(url.searchParams.get(kind==='github'?'per_page':'limit')||30)),n=Number(url.searchParams.get('page')||1);
   return json(res,200,list.slice((n-1)*per,n*per),{'X-Total-Count':String(list.length)});
  };
  if(sub==='/user/repos')return page([...repos].map(([f,r])=>repoJson(f,r)));
  let m=/^\/(?:orgs|users)\/([^/]+)\/repos$/.exec(sub);
  if(m){const list=[...repos].filter(([f])=>f.startsWith(m[1]+'/'));return list.length?page(list.map(([f,r])=>repoJson(f,r))):json(res,404,{message:'not found'});}
  m=/^\/repos\/([^/]+\/[^/]+)$/.exec(sub);
  if(m)return repos.has(m[1])?json(res,200,repoJson(m[1],repos.get(m[1]))):json(res,404,{message:'not found'});
  // The test-only list/delete API.
  m=/^\/api\/fake\/repos\/([^/]+\/[^/]+)\/lfs(?:\/([a-f0-9]{64}))?$/.exec(p);
  if(m){
   const objects=store.get(m[1]);if(!objects)return json(res,404,{message:'not found'});
   if(req.method==='GET'&&!m[2])return json(res,200,[...objects].map(([o,v])=>({oid:o,size:v.size,created_at:v.createdAt})));
   if(req.method==='DELETE'&&m[2]){if(!objects.has(m[2]))return json(res,404,{message:'not found'});objects.delete(m[2]);deleted.push({repo:m[1],oid:m[2]});res.writeHead(204);return res.end();}
  }
  json(res,404,{message:'not found'});
 });
 function cgi(req,res,env){
  const child=spawn('git',['http-backend'],{env:{...GIT_ENV,GIT_PROJECT_ROOT:path.join(root,'repos'),GIT_HTTP_EXPORT_ALL:'1',REQUEST_METHOD:req.method,CONTENT_TYPE:req.headers['content-type']||'',
   ...(req.headers['git-protocol']?{GIT_PROTOCOL:req.headers['git-protocol']}:{}),...(req.headers['content-encoding']?{HTTP_CONTENT_ENCODING:req.headers['content-encoding']}:{}),REMOTE_USER:login,REMOTE_ADDR:'127.0.0.1',...env}});
  req.pipe(child.stdin);
  const chunks=[];child.stdout.on('data',c=>chunks.push(c));child.stderr.resume();
  child.on('close',()=>{
   const out=Buffer.concat(chunks),sep=out.indexOf('\r\n\r\n');
   if(sep<0){res.writeHead(500);return res.end();}
   const headers={};let status=200;
   for(const line of out.subarray(0,sep).toString().split('\r\n')){const i=line.indexOf(':');const k=line.slice(0,i).trim(),v=line.slice(i+1).trim();if(k.toLowerCase()==='status')status=Number(v.split(' ')[0]);else headers[k]=v;}
   res.writeHead(status,headers);res.end(out.subarray(sep+4));
  });
 }
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const origin=`http://127.0.0.1:${server.address().port}`;
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(root,{recursive:true,force:true});});
 return {origin,root,log,deleted,fail,redirect,delay,store,repos,token,login,barePath,
  baseUrl:kind==='github'?origin:origin,
  // A bare repository the host serves, with partial clone allowed, and its LFS store.
  addRepo(fullName,{defaultBranch='main',private:priv=true,objects={}}={}){
   const dir=barePath(fullName);mkdirSync(dir,{recursive:true});git(dir,'init','-q','--bare','-b',defaultBranch);
   git(dir,'config','uploadpack.allowFilter','true');git(dir,'config','http.uploadpack','true');
   repos.set(fullName,{defaultBranch,private:priv});store.set(fullName,new Map(Object.entries(objects)));
   return dir;
  },
  storeObject(fullName,o,size,createdAt='2026-01-01T00:00:00Z'){store.get(fullName).set(o,{size,createdAt});},
  bare:(fullName,...args)=>git(barePath(fullName),...args),
 };
}
