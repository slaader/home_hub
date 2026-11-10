// Is the hub answering? Pages fetch on their own, so this watches every same-origin request instead of
// asking them to report: a request that fails on the network (or a 502/504 from a proxy in front of a hub
// that is down) marks the hub unreachable; the next answer marks it back. While it is down, /healthz is
// tried every few seconds so recovery is noticed on a page that does not poll.
// It raises 'hubstate' on window with detail {down, offline, since}; app.js shows the banner and redraws
// the page when the hub is back. Nothing here reads or keeps a request or a response.
let down=false,since=null,lastOk=Date.now(),timer=null,installed=false;
const offline=()=>globalThis.navigator?.onLine===false;
export const hubState=()=>({down,offline:offline(),since,lastOk});
const announce=()=>globalThis.dispatchEvent?.(new CustomEvent('hubstate',{detail:hubState()}));
function mark(ok){
 if(ok){lastOk=Date.now();if(!down)return;down=false;since=null;clearInterval(timer);timer=null;announce();return;}
 if(down)return;
 down=true;since=Date.now();announce();
 timer=setInterval(()=>{pingHub();},5000);
}
// One cheap unauthenticated request; resolves to whether the hub answered.
export async function pingHub(){
 try{const r=await raw('/healthz',{cache:'no-store'});mark(r.ok);return r.ok;}catch{mark(false);return false;}
}
let raw=(...args)=>globalThis.fetch(...args);
const sameOrigin=input=>{
 const url=typeof input==='string'?input:input?.url||String(input||'');
 return url.startsWith('/')&&!url.startsWith('//')||(globalThis.location?.origin&&url.startsWith(globalThis.location.origin+'/'));
};
export function watchNetwork(){
 if(installed||typeof globalThis.fetch!=='function')return;installed=true;
 const original=globalThis.fetch.bind(globalThis);raw=original;
 globalThis.fetch=async(input,init)=>{
  const own=sameOrigin(input);
  try{const r=await original(input,init);if(own)mark(r.status!==502&&r.status!==504);return r;}
  catch(e){if(own&&e?.name!=='AbortError')mark(false);throw e;}
 };
 globalThis.addEventListener?.('offline',announce);
 globalThis.addEventListener?.('online',()=>{announce();pingHub();});
}
