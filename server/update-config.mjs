// What the update command (scripts/update.mjs, server/update-apply.mjs) has to be told about one installation:
// how its service is stopped and started, where it answers, and how many pre-update archives to keep.
// None of it is in code: it comes from <HOME_HUB_HOME>/instance.json or from flags (docs/updating.md).
//
//   service   "launchd:system/com.example.home-hub"      a LaunchDaemon: bootout, then bootstrap of its plist
//             "launchd:gui/501/com.example.home-hub"     a LaunchAgent of that user
//             "systemd:home-hub.service"                 a system unit (systemctl stop / start)
//             "systemd-user:home-hub.service"            a user unit (systemctl --user)
//             {"stop": [argv…], "start": [argv…]}        anything else: two commands, run without a shell
//   health    {"url": "http://127.0.0.1:8781/healthz", "seconds": 60}
//   backups   {"keep": 5}
// A system service is stopped and started through `sudo -n` unless the command already runs as root: the rule that
// allows it belongs to the machine (sudoers), never to this file.
import os from 'node:os';
import path from 'node:path';

export class UpdateConfigError extends Error{}
const no=message=>{throw new UpdateConfigError(message);};
const plain=v=>v&&typeof v==='object'&&!Array.isArray(v);
const LABEL=/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/,DOMAIN=/^(?:system|gui\/\d{1,10}|user\/\d{1,10})$/,UNIT=/^[A-Za-z0-9@][A-Za-z0-9@._:-]{0,200}$/;
const argv=(v,where)=>Array.isArray(v)&&v.length>=1&&v.length<=32&&v.every(a=>typeof a==='string'&&a.length>0&&a.length<=1000&&!a.includes('\u0000'))?Object.freeze([...v]):no(`${where} must be a command as a list of 1 to 32 texts, such as ["systemctl","stop","home-hub"]`);

export const DEFAULT_HEALTH_SECONDS=60,DEFAULT_KEEP=5;

/** A service as text or as {stop, start} → frozen {kind, spec, stop: [argv], start: [argv], startTries}. Throws UpdateConfigError. */
export function parseService(spec,{uid=process.getuid?.()??0,home=os.homedir()}={}){
 if(typeof spec==='string'&&spec.startsWith('command:')){
  let raw;try{raw=JSON.parse(spec.slice(8));}catch{no('service "command:…" must be followed by JSON: command:{"stop":[…],"start":[…]}');}
  spec=raw;
 }
 if(plain(spec)){
  const extra=Object.keys(spec).filter(k=>k!=='stop'&&k!=='start');if(extra.length)no(`service has unknown field(s): ${extra.join(', ')}`);
  return Object.freeze({kind:'command',spec:Object.freeze({stop:argv(spec.stop,'service.stop'),start:argv(spec.start,'service.start')}),stop:argv(spec.stop,'service.stop'),start:argv(spec.start,'service.start'),startTries:1});
 }
 if(typeof spec!=='string'||!spec||spec.length>400)no('service must be a text such as "launchd:system/com.example.home-hub", or {"stop": […], "start": […]}');
 const at=spec.indexOf(':'),kind=at<0?'':spec.slice(0,at),rest=spec.slice(at+1);
 const sudo=uid===0?[]:['sudo','-n'];
 if(kind==='launchd'){
  const cut=rest.lastIndexOf('/'),domain=rest.slice(0,cut),label=rest.slice(cut+1);
  if(cut<0||!DOMAIN.test(domain)||!LABEL.test(label))no(`service "${spec}": write launchd:system/<label>, launchd:gui/<uid>/<label> or launchd:user/<uid>/<label>`);
  const system=domain==='system',run=system?sudo:[];
  const plist=system?path.join('/Library/LaunchDaemons',`${label}.plist`):path.join(home,'Library','LaunchAgents',`${label}.plist`);
  // launchd refuses a bootstrap while the boot-out of the same label is still finishing: the start is tried again.
  return Object.freeze({kind,spec,stop:Object.freeze([...run,'/bin/launchctl','bootout',`${domain}/${label}`]),start:Object.freeze([...run,'/bin/launchctl','bootstrap',domain,plist]),startTries:4});
 }
 if(kind==='systemd'||kind==='systemd-user'){
  if(!UNIT.test(rest))no(`service "${spec}": write ${kind}:<unit>, such as ${kind}:home-hub.service`);
  const base=kind==='systemd'?[...sudo,'systemctl']:['systemctl','--user'];
  return Object.freeze({kind,spec,stop:Object.freeze([...base,'stop',rest]),start:Object.freeze([...base,'start',rest]),startTries:1});
 }
 return no(`service "${spec}" is not a kind this knows: launchd:…, systemd:…, systemd-user:…, or {"stop": […], "start": […]}`);
}
/** {url, seconds?} → frozen {url, seconds}. Only http and https, no credentials in the address. */
export function parseHealth(raw){
 if(typeof raw==='string')raw={url:raw};
 if(!plain(raw))no('health must be an object: {"url": "http://127.0.0.1:8781/healthz", "seconds": 60}');
 const extra=Object.keys(raw).filter(k=>k!=='url'&&k!=='seconds');if(extra.length)no(`health has unknown field(s): ${extra.join(', ')}`);
 let url;try{url=new URL(raw.url);}catch{no('health.url must be an address such as http://127.0.0.1:8781/healthz');}
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password||String(raw.url).length>300)no('health.url must be a plain http or https address without a user name or password');
 const seconds=raw.seconds??DEFAULT_HEALTH_SECONDS;
 if(!Number.isSafeInteger(seconds)||seconds<2||seconds>900)no('health.seconds must be a whole number from 2 to 900');
 return Object.freeze({url:url.href,seconds});
}
/** {keep?} → frozen {keep}: how many pre-update archives stay. */
export function parseBackups(raw={}){
 if(!plain(raw))no('backups must be an object: {"keep": 5}');
 const extra=Object.keys(raw).filter(k=>k!=='keep');if(extra.length)no(`backups has unknown field(s): ${extra.join(', ')}`);
 const keep=raw.keep??DEFAULT_KEEP;
 if(!Number.isSafeInteger(keep)||keep<1||keep>100)no('backups.keep must be a whole number from 1 to 100');
 return Object.freeze({keep});
}
