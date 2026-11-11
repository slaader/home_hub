// Where a git host's LFS files live, from the inventory (data/knowledge.json): the service whose address names the
// host (its machine), and the object store it reaches through its dependencies (that store's machine). Only what the
// inventory says; nothing is probed. No inventory, or no entry for the host: null (the page then says nothing).
//   placementFor(web, entries) → {service:{id,name,machine,machineName}, storage:{id,name,machine,machineName}|null} | null
const STORE=/object (store|storage)|s3-compatible|blob (store|storage)/i;
const MAX_HOPS=4,PROXY=/proxy|ingress|caddy|nginx|traefik|tunnel/i;

const hostOf=web=>{try{return new URL(web).hostname.toLowerCase();}catch{return null;}};
// The address field is free text ("https://git.example.lan (…); backend 127.0.0.1:3000"): the host must appear as a
// whole name, not inside a longer one (git.example.lan is not in agit.example.lan or git.example.lan.other).
const names=(text,host)=>typeof text==='string'&&new RegExp(`(^|[^a-z0-9.-])${host.replace(/[.]/g,'\\.')}($|[^a-z0-9-]|\\.(?![a-z0-9]))`,'i').test(text);
const view=(e,byId)=>({id:e.id,name:typeof e.name==='string'?e.name:e.id,machine:typeof e.machine==='string'?e.machine:null,
 machineName:typeof e.machine==='string'&&byId.get(e.machine)?.kind==='machine'?byId.get(e.machine).name||e.machine:typeof e.machine==='string'?e.machine:null});

export function placementFor(web,entries){
 const host=hostOf(web);if(!host||!Array.isArray(entries))return null;
 const list=entries.filter(e=>e&&typeof e==='object'&&typeof e.id==='string'),byId=new Map(list.map(e=>[e.id,e]));
 // The service: a running thing whose address names the host. The full address (scheme, host, port) beats the bare
 // host; a reverse proxy or ingress that forwards to it comes last; then the inventory's order.
 let origin=null;try{origin=new URL(web).origin.toLowerCase();}catch{}
 const score=e=>{const text=String(e.address||'').toLowerCase(),what=`${e.name||''} ${e.type||''}`;
  return (origin&&text.includes(origin)&&!text.includes(origin+'.')?2:1)-(PROXY.test(what)?1.5:0);};
 const service=list.filter(e=>e.kind==='runtime'&&names(e.address,host)&&!STORE.test(`${e.name||''} ${e.type||''}`))
  .map((e,i)=>({e,i,s:score(e)})).sort((a,b)=>b.s-a.s||a.i-b.i)[0]?.e;
 if(!service)return null;
 // The store: the nearest dependency (calls and data, breadth first) that is an object store.
 let storage=null;const seen=new Set([service.id]);let frontier=[service];
 for(let hop=0;hop<MAX_HOPS&&!storage&&frontier.length;hop++){
  const next=[];
  for(const e of frontier)for(const d of Array.isArray(e.depends_on)?e.depends_on:[]){
   const t=byId.get(d?.id);if(!t||seen.has(t.id)||t.kind==='machine')continue;seen.add(t.id);
   if(STORE.test(`${t.name||''} ${t.type||''}`)){storage=t;break;}
   next.push(t);}
  frontier=next;
 }
 return {service:view(service,byId),storage:storage?view(storage,byId):null};
}
