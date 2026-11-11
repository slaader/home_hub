// Machines that are not in the site configuration: devices added on the overview (⊕ Add device) and
// machines an agent wrote over MCP (machine_upsert). The site's own machines stay in site.json and are
// read-only here. One store, one write queue, atomic renames.
//   state/home/devices.json       the machines: id, name, hostname, ip, role, props, thermoId, picture (no secrets)
//   state/home/thermo-hosts.json  0600, sealed (server/secret-box.mjs): the Thermo account a device logs in with (password, pinned cert)
//   state/home/windows-hosts.json 0600: how a Windows device is read: an app-managed connection (host, port,
//                                 Windows user, the ids of its key and known_hosts in state/home/ssh/, the public
//                                 key and the verified host key; never a private key), or an older SSH alias
//   state/home/telemetry-hosts.json 0600, sealed: how a device is read by the other agent-less providers: Windows over
//                                 WinRM (host, port, local account and its password, TLS trust), Linux over Node
//                                 Exporter (host, port, scheme, TLS trust, optional Basic user and password) and
//                                 Linux from a Prometheus server (host, port, scheme, TLS trust, optional Basic or
//                                 bearer credentials, the job and instance of one node_exporter target) and
//                                 Linux over SSH (the app-managed record with os "linux": key and known_hosts ids)
//   state/home/ssh/               0700: the hub's own SSH keys and known_hosts (server/windows-ssh.mjs)
//   state/home/runtimes.json      runtime stacks published for a machine (runtime_publish), site machines included
//   state/home/site-telemetry.json 0600: the agent-less telemetry a machine of the site configuration is read through,
//                                 connected on its tile by the owner: {schema:1, bindings:[{id, provider, platform,
//                                 configuredAt, configuredBy}]}. No secrets: the connection itself (keys, passwords,
//                                 trust) is in windows-hosts.json / telemetry-hosts.json under the same id, exactly as
//                                 for an added device. The machine's identity stays in site.json and is never written.
//   state/home/site-overrides.json 0600: what the owner changed on the tile of a machine of the site configuration, over
//                                 the site's defaults (display only): {schema:1, overrides:[{id, fields:{name?, hostname?,
//                                 ip?, hardware?{cpu?,gpu?,ramGb?,diskTotalBytes?}, picture?}, image?, imageAt?, updatedAt,
//                                 updatedBy}]}. A field that is absent (or equal to the site's value) is the site's. Id, role,
//                                 platform, thermoId, ssh, stack and every collector keep reading site.json, never this file.
//   state/home/images/<id>.jpg    an uploaded tile picture, cropped to 3:2 in the browser (an added device's, or a site
//                                 machine's own picture from site-overrides.json: ids never collide, site ids are reserved)
// devices.json keeps schema 1: every field added since the first version is optional and is filled in on
// read (normalize below), so a file written by an older hub loads unchanged and nothing is rewritten.
// Errors: Error('invalid' | 'secret' | 'not-found' | 'conflict' | 'duplicate' | 'limit' | 'read-only' | 'too-large'),
// with .detail (English, names the field) where a field was at fault.
import {mkdir,readFile,writeFile,rename,rm,open} from 'node:fs/promises';
import {AsyncLocalStorage} from 'node:async_hooks';
import {existsSync} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import path from 'node:path';
import {parseHostsConfig} from './thermo-client.mjs';
import {defaultSecretBox,isSealed} from './secret-box.mjs';
import {validSshTarget,validManaged,managedLabel} from './windows-telemetry.mjs';
import {validWinrmRecord,winrmLabel} from './winrm-telemetry.mjs';
import {validExporterRecord,validLinuxManaged,exporterLabel,linuxSshLabel} from './linux-telemetry.mjs';
import {validPromRecord,promLabel} from './prometheus-telemetry.mjs';
import {inCidrs} from './site-config.mjs';
import {createPrivatePathGuard} from './windows-ssh.mjs';

export const DEVICE_ID=/^[a-z][a-z0-9_-]{1,31}$/;
export const DEVICE_KINDS=Object.freeze(['thermo','windows','winrm','node-exporter','prometheus','linux-ssh','other']);
// The agent-less telemetry providers (telemetryProvider of a device) and the system each one reads. Role is not
// platform: a Linux NAS or a Windows server reads the same way as a desktop.
//   windows        Windows over SSH (windows-hosts.json, the original one)    winrm      Windows over WinRM HTTPS
//   node-exporter  Linux over Prometheus Node Exporter                        linux-ssh  Linux over SSH
//   prometheus     Linux host metrics (node_exporter series of one job+instance) from an existing Prometheus server
export const TELEMETRY_PROVIDERS=Object.freeze(['windows','winrm','node-exporter','prometheus','linux-ssh']);
export const PROVIDER_PLATFORM=Object.freeze({windows:'windows',winrm:'windows','node-exporter':'linux',prometheus:'linux','linux-ssh':'linux'});
// The record each provider in telemetry-hosts.json holds (Windows over SSH keeps windows-hosts.json).
export const FEED_RECORD=Object.freeze({winrm:validWinrmRecord,'node-exporter':validExporterRecord,prometheus:validPromRecord,'linux-ssh':validLinuxManaged});
export const feedLabel=(provider,r)=>provider==='winrm'?winrmLabel(r):provider==='node-exporter'?exporterLabel(r):provider==='prometheus'?promLabel(r):linuxSshLabel(r);
export const MACHINE_ROLES=Object.freeze(['computer','nas','router','other']);
// The operating system, apart from the role: a Windows server and a Windows desktop are both "windows".
// null = not said. Windows telemetry (SSH + PowerShell) needs "windows" (or null, which it then sets).
export const PLATFORMS=Object.freeze(['macos','windows','linux','other']);
// The built-in generic pictures (public/images/generic/<id>.svg). A machine's picture is one of these ids or null.
export const PICTURES=Object.freeze(['desktop','laptop','mini','tower','server','nas','router','board','printer','generic']);
export const pictureUrl=id=>`/images/generic/${id}.svg`;
export const defaultPicture=role=>({computer:'desktop',nas:'nas',router:'router'})[role]||'generic';
// Can a machine of the site configuration be connected to an agent-less provider on its tile? Not when the site reads
// it through Thermo (thermoId: that stays the site files' business, and two feeds would conflict), not a router (the
// router adapter reports it). The site's platform, when it says one, limits the providers to that system's.
export const siteBindable=m=>Boolean(m&&!m.thermoId&&m.role!=='router');
export const siteProviderFits=(m,provider)=>siteBindable(m)&&Object.hasOwn(PROVIDER_PLATFORM,provider)&&(!PLATFORMS.includes(m.platform)||m.platform===PROVIDER_PLATFORM[provider]);
export const DEVICE_LIMITS=Object.freeze({devices:20,image:3*1024*1024});
export const RUNTIME_LAYERS=Object.freeze(['input','tool','runtime','engine','hardware']);
export const RUNTIME_LIMITS=Object.freeze({cols:12,engines:12,blocks:60,models:30});
const MODEL_STATES=['loaded','loading','idle'];
const MIGRATE_RETRY_MS=10*60*1000;
const HOST=/^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}))*$/,IPV4=/^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const fail=(code,detail)=>{throw Object.assign(new Error(code),detail?{detail}:{});};
const plain=x=>x&&typeof x==='object'&&!Array.isArray(x);
const onlyKeys=(x,keys)=>plain(x)&&Object.keys(x).every(k=>keys.includes(k));
const extraKeys=(x,keys,where)=>{if(!plain(x))fail('invalid',`${where} must be an object`);const extra=Object.keys(x).filter(k=>!keys.includes(k));if(extra.length)fail('invalid',`${where} has unknown field(s): ${extra.join(', ')}`);return x;};
const text=(v,max,{empty=true,where='a text field'}={})=>{if(v===undefined||v===null)v='';if(typeof v!=='string')fail('invalid',`${where} must be text`);const t=v.replace(/[\u0000-\u001f\u007f]/g,'').trim();
 if(t.length>max)fail('invalid',`${where} is longer than ${max} characters`);if(!empty&&!t)fail('invalid',`${where} is required`);return t;};
export const validHost=h=>typeof h==='string'&&(IPV4.test(h)||HOST.test(h));
const port=v=>v===undefined||v===null?49286:Number.isSafeInteger(v)&&v>=1024&&v<=65535?v:fail('invalid','thermo.port must be 1024-65535');
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
// What the owner may change on a machine of the site configuration (display metadata), and what stays the site's.
export const SITE_OVERRIDE_FIELDS=Object.freeze(['name','hostname','ip','hardware','picture']);
export const SITE_HARDWARE_FIELDS=Object.freeze(['cpu','gpu','ramGb','diskTotalBytes']);
export const SITE_CONTROLLED=Object.freeze(['id','role','platform','thermoId','ssh','stack','source']);

// What looks like a secret value rather than a description (the same idea as the inventory checker):
// machines and runtime stacks are shown to every signed-in reader and to agents, so none may be stored.
const SECRET_PATTERNS=[
 [/\bhh(?:k)?_[a-f0-9]{64}\b/i,'a Home Hub access key'],[/-----BEGIN [A-Z ]*PRIVATE KEY-----/,'a private key block'],
 [/\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/,'an API key'],[/\b(ghp|gho|ghs|github_pat|glpat|xox[abpr])[-_][A-Za-z0-9_-]{10,}/,'an access token'],
 [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,'a JWT'],[/\b(password|passwd|pwd|secret|token|api[_-]?key)\s*[=:]\s*\S{6,}/i,'an assignment of a secret'],
 [/:\/\/[^/\s:@]+:[^/\s@]+@/,'credentials in a URL'],[/\b[A-Fa-f0-9]{40,}\b/,'a long hex string'],
 // No "/" or "-" in the run, so paths and model names never match.
 [/(?<![A-Za-z0-9+_])(?=[A-Za-z0-9+_]*\d)(?=[A-Za-z0-9+_]*[A-Z])(?=[A-Za-z0-9+_]*[a-z])[A-Za-z0-9+_]{32,}={0,2}(?![A-Za-z0-9+_])/,'a long random-looking string']];
export const secretIn=value=>{if(typeof value!=='string')return null;for(const [re,why] of SECRET_PATTERNS)if(re.test(value))return why;return null;};
const noSecret=(value,where)=>{const why=secretIn(value);if(why)fail('secret',`${where} looks like ${why}`);return value;};

// "Mac Studio 2" → "mac-studio-2"; diacritics dropped, never one of the taken ids.
export function deviceId(name,taken){
 const base=(name.normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').replace(/^[^a-z]+/,'')||'device').slice(0,28).replace(/-+$/,'')||'device';
 let id=DEVICE_ID.test(base)?base:'device-'+base;id=id.slice(0,28);for(let n=2;taken.includes(id);n++)id=`${base.slice(0,26)}-${n}`;return id;
}

// A stored device as the current shape. Files written before roles, thermoId, pictures and agents existed
// have only {id,name,kind,hostname,ip,props,image,createdAt,createdBy}: a "thermo" device was a computer that
// is its own Thermo host, anything else a plain tile. platform and telemetryProvider came later (null = none).
// telemetryProvider "windows" is kept by the hub like the uploaded picture: only the web UI sets it.
export function normalizeDevice(d){
 const p=plain(d.props)?d.props:{};
 return {...d,ip:d.ip||null,hostname:typeof d.hostname==='string'?d.hostname:'',image:d.image===true,
  props:{cpu:typeof p.cpu==='string'?p.cpu:'',gpu:typeof p.gpu==='string'?p.gpu:'',ramGb:Number.isFinite(p.ramGb)?p.ramGb:null,diskTotalBytes:Number.isFinite(p.diskTotalBytes)?p.diskTotalBytes:null},
  role:MACHINE_ROLES.includes(d.role)?d.role:d.kind==='thermo'?'computer':'other',
  thermoId:d.thermoId===null||typeof d.thermoId==='string'?d.thermoId:d.kind==='thermo'?d.id:null,
  picture:PICTURES.includes(d.picture)?d.picture:null,source:d.source==='agent'?'agent':'ui',
  platform:PLATFORMS.includes(d.platform)?d.platform:null,telemetryProvider:TELEMETRY_PROVIDERS.includes(d.telemetryProvider)?d.telemetryProvider:null};
}
// The fields a client reads and writes (machine_list, machine_upsert, the edit dialog), in a fixed order.
export const machineFields=d=>({id:d.id,name:d.name,hostname:d.hostname,ip:d.ip||null,role:d.role,
 hardware:{cpu:d.props.cpu,gpu:d.props.gpu,ramGb:d.props.ramGb,diskTotalBytes:d.props.diskTotalBytes},thermoId:d.thermoId,picture:d.picture,platform:d.platform??null});
// Optimistic concurrency, like inventory entries: the hash of what a client read must still match on write.
// A machine without a platform hashes exactly as before platforms existed, so a hash read from an older hub still matches.
export const machineHash=d=>{const f=machineFields(d);if(f.platform===null)delete f.platform;return sha(f);};
export const runtimeHash=stack=>sha(stack);

// {id?, name, hostname?, ip?, role?, hardware?{cpu,gpu,ramGb,diskTotalBytes}, thermoId?, picture?, platform?} → clean fields.
// lanCidrs: the site's networks; when set, an ip must be a host address inside one of them.
// platform: absent = keep what the machine has (undefined here), null = not said.
export function parseMachine(input,{lanCidrs=[],needId=true}={}){
 extraKeys(input,['id','name','hostname','ip','role','hardware','thermoId','picture','platform'],'machine');
 const id=input.id===undefined&&!needId?null:typeof input.id==='string'&&DEVICE_ID.test(input.id)?input.id:fail('invalid','machine.id must be 2-32 characters: a lowercase letter, then letters, digits, _ or -');
 const name=noSecret(text(input.name,60,{empty:false,where:'machine.name'}),'machine.name');
 const hostname=text(input.hostname,253,{where:'machine.hostname'});if(hostname&&!validHost(hostname))fail('invalid','machine.hostname must be a host name or an IPv4 address');
 const ip=text(input.ip,15,{where:'machine.ip'});
 if(ip&&!IPV4.test(ip))fail('invalid','machine.ip must be an IPv4 address');
 if(ip&&!inCidrs(ip,lanCidrs))fail('invalid',`machine.ip must be a host address inside the site's networks (${lanCidrs.join(', ')})`);
 const role=input.role===undefined||input.role===null?'computer':MACHINE_ROLES.includes(input.role)?input.role:fail('invalid',`machine.role must be one of ${MACHINE_ROLES.join(', ')}`);
 const h=extraKeys(input.hardware??{},['cpu','gpu','ramGb','diskTotalBytes'],'machine.hardware');
 const number=(v,max,where)=>v===undefined||v===null||v===''?null:typeof v==='number'&&Number.isFinite(v)&&v>0&&v<=max?v:fail('invalid',`${where} must be a number above 0 and at most ${max}, or null`);
 const props={cpu:noSecret(text(h.cpu,60,{where:'machine.hardware.cpu'}),'machine.hardware.cpu'),gpu:noSecret(text(h.gpu,40,{where:'machine.hardware.gpu'}),'machine.hardware.gpu'),
  ramGb:number(h.ramGb,65536,'machine.hardware.ramGb'),diskTotalBytes:number(h.diskTotalBytes,1e16,'machine.hardware.diskTotalBytes')};
 const thermoId=input.thermoId===undefined||input.thermoId===null||input.thermoId===''?null:typeof input.thermoId==='string'&&DEVICE_ID.test(input.thermoId)?input.thermoId:fail('invalid','machine.thermoId must be a host id of the telemetry agent (same form as machine.id), or null');
 const picture=input.picture===undefined||input.picture===null||input.picture===''?null:PICTURES.includes(input.picture)?input.picture:fail('invalid',`machine.picture must be one of ${PICTURES.join(', ')}, or null`);
 const platform=input.platform===undefined?undefined:input.platform===null||input.platform===''?null:PLATFORMS.includes(input.platform)?input.platform:fail('invalid',`machine.platform must be one of ${PLATFORMS.join(', ')}, or null`);
 return {id,name,hostname,ip:ip||null,role,props,thermoId,picture,platform};
}
// The site's own values of what an override may change (site.json → machines[]), in the override's shape.
export const siteDefaults=m=>({name:m.name,hostname:m.hostname||'',ip:m.ip||'',
 hardware:Object.fromEntries(SITE_HARDWARE_FIELDS.map(k=>[k,m.hardware?.[k]??(k==='cpu'||k==='gpu'?'':null)])),picture:null});
// The owner's override of a site machine's display metadata: {name?, hostname?, ip?, hardware?{cpu?, gpu?, ramGb?,
// diskTotalBytes?}, picture?}. The whole override is replaced: a field that is absent goes back to the site's value, and
// so does one sent with the site's value (it is not stored). Only what differs is checked, with the rules of an added
// machine (name, hostname, an ip inside the site's networks, hardware, a built-in picture id; nothing secret-looking).
// What the site controls (id, role, platform, thermoId, ssh, stack) is refused by name. → the stored fields, in order.
export function parseSiteOverride(input,m,{lanCidrs=[]}={}){
 if(!plain(input))fail('invalid','override must be an object');
 const kept=Object.keys(input).filter(k=>SITE_CONTROLLED.includes(k));
 if(kept.length)fail('invalid',`${kept.map(k=>'machine.'+k).join(', ')} stays in the site configuration (site.json) and is not changed here`);
 extraKeys(input,SITE_OVERRIDE_FIELDS,'override');
 const site=siteDefaults(m),out={};
 if(input.name!==undefined){const name=noSecret(text(input.name,60,{empty:false,where:'machine.name'}),'machine.name');if(name!==site.name)out.name=name;}
 if(input.hostname!==undefined){const h=text(input.hostname,253,{where:'machine.hostname'});
  if(h!==site.hostname){if(h&&!validHost(h))fail('invalid','machine.hostname must be a host name or an IPv4 address');out.hostname=h;}}
 if(input.ip!==undefined){const ip=text(input.ip,15,{where:'machine.ip'});
  if(ip!==site.ip){if(ip&&!IPV4.test(ip))fail('invalid','machine.ip must be an IPv4 address');
   if(ip&&!inCidrs(ip,lanCidrs))fail('invalid',`machine.ip must be a host address inside the site's networks (${lanCidrs.join(', ')})`);out.ip=ip;}}
 if(input.hardware!==undefined){
  const h=extraKeys(input.hardware,SITE_HARDWARE_FIELDS,'machine.hardware'),hw={};
  const number=(v,max,where)=>v===null||v===''?null:typeof v==='number'&&Number.isFinite(v)&&v>0&&v<=max?v:fail('invalid',`${where} must be a number above 0 and at most ${max}, or null`);
  const limits={cpu:60,gpu:40};
  for(const k of SITE_HARDWARE_FIELDS){if(h[k]===undefined)continue;
   const v=k in limits?noSecret(text(h[k],limits[k],{where:`machine.hardware.${k}`}),`machine.hardware.${k}`):number(h[k],k==='ramGb'?65536:1e16,`machine.hardware.${k}`);
   if(v!==site.hardware[k])hw[k]=v;}
  if(Object.keys(hw).length)out.hardware=hw;}
 if(input.picture!==undefined&&input.picture!==null){if(!PICTURES.includes(input.picture))fail('invalid',`machine.picture must be one of ${PICTURES.join(', ')}, or null for the site's own picture`);out.picture=input.picture;}
 return out;
}
// The hash a client sends back as base (optimistic concurrency): of the stored fields and the uploaded picture.
export const siteOverrideHash=o=>sha({fields:o?.fields||{},image:o?.image===true?o.imageAt||true:false});

// Windows telemetry through an older SSH alias: {target} = an alias from ~/.ssh/config of the account the hub
// runs as, or user@host. Still accepted so existing set-ups and API clients keep working; the web UI makes app-managed
// connections instead (server/windows-ssh.mjs → set-up drafts), which reach this store as a checked record only.
export function parseWindows(w){
 if(!onlyKeys(w,['target']))fail('invalid','windows needs only target: an SSH alias from ~/.ssh/config or user@host');
 const target=typeof w.target==='string'?w.target.trim():'';
 if(!validSshTarget(target))fail('invalid','windows.target must be an SSH alias or user@host: letters, digits, dots, dashes and underscores, starting with a letter or digit');
 return {target};
}

// The Thermo account a device logs in with: {port?, username, password, pin}. host = where to connect.
function parseThermo(t,host){
 if(!onlyKeys(t,['port','username','password','pin']))fail('invalid','thermo needs port, username, password and pin');
 const pin=typeof t.pin==='string'?t.pin.replace(/:/g,'').toLowerCase():'';if(!/^[a-f0-9]{64}$/.test(pin))fail('invalid','thermo.pin must be the confirmed SHA-256 certificate fingerprint');
 if(typeof t.password!=='string'||t.password.length<12||t.password.length>256)fail('invalid','thermo.password must be 12-256 characters');
 const username=text(t.username,32,{empty:false,where:'thermo.username'});
 return {host,port:port(t.port),username,label:'home-hub',password:t.password,pin};
}

// A runtime stack as an agent publishes it:
//   {cols:[engine key per column], engines?:{key: label}, blocks:[{id, layer, col0, col1, title, port?, desc?,
//     state?, service?, models?:[{id, state?, sizeGb?, path?}]}]}
// layer is one of input | tool | runtime | engine | hardware. Blocks are placed on a grid: a block spans the
// columns col0..col1 of its layer, and what sits above or below it is whatever overlaps those columns.
export function parseRuntime(input){
 extraKeys(input,['cols','engines','blocks'],'stack');
 const key=(v,where)=>typeof v==='string'&&/^[a-z][a-z0-9-]{0,15}$/.test(v)?v:fail('invalid',`${where} must be a short lowercase key such as gguf or mlx`);
 if(!Array.isArray(input.cols)||!input.cols.length||input.cols.length>RUNTIME_LIMITS.cols)fail('invalid',`stack.cols must list 1-${RUNTIME_LIMITS.cols} column keys`);
 const cols=input.cols.map((c,i)=>key(c,`stack.cols[${i}]`));
 if(input.engines!==undefined&&(!plain(input.engines)||Object.keys(input.engines).length>RUNTIME_LIMITS.engines))fail('invalid',`stack.engines must map at most ${RUNTIME_LIMITS.engines} column keys to a label`);
 const engines=Object.fromEntries(Object.entries(input.engines??{}).map(([k,v])=>[key(k,`stack.engines key "${k}"`),noSecret(text(v,40,{empty:false,where:`stack.engines.${k}`}),`stack.engines.${k}`)]));
 if(!Array.isArray(input.blocks)||!input.blocks.length||input.blocks.length>RUNTIME_LIMITS.blocks)fail('invalid',`stack.blocks must list 1-${RUNTIME_LIMITS.blocks} blocks`);
 const seen=new Set();
 const blocks=input.blocks.map((b,i)=>{
  const where=`stack.blocks[${i}]`;extraKeys(b,['id','layer','col0','col1','title','port','desc','state','service','models'],where);
  if(typeof b.id!=='string'||!/^[a-z][a-z0-9_-]{0,39}$/.test(b.id))fail('invalid',`${where}.id must be a lowercase id`);
  if(seen.has(b.id))fail('invalid',`${where}.id "${b.id}" is used twice`);seen.add(b.id);
  if(!RUNTIME_LAYERS.includes(b.layer))fail('invalid',`${where}.layer must be one of ${RUNTIME_LAYERS.join(', ')}`);
  if(!Number.isInteger(b.col0)||!Number.isInteger(b.col1)||b.col0<0||b.col1<b.col0||b.col1>=cols.length)fail('invalid',`${where}: col0..col1 must be column numbers from 0 to ${cols.length-1}, col0 <= col1`);
  if(b.state!==undefined&&b.state!=='on'&&b.state!=='off')fail('invalid',`${where}.state must be on or off`);
  if(b.service!==undefined&&(typeof b.service!=='string'||!/^[a-z0-9][a-z0-9._-]{0,59}$/.test(b.service)))fail('invalid',`${where}.service must be a service id`);
  if(b.models!==undefined&&(!Array.isArray(b.models)||b.models.length>RUNTIME_LIMITS.models))fail('invalid',`${where}.models must list at most ${RUNTIME_LIMITS.models} models`);
  const models=(b.models??[]).map((m,j)=>{
   const at=`${where}.models[${j}]`;extraKeys(m,['id','state','sizeGb','path'],at);
   if(m.state!==undefined&&!MODEL_STATES.includes(m.state))fail('invalid',`${at}.state must be one of ${MODEL_STATES.join(', ')}`);
   if(m.sizeGb!==undefined&&m.sizeGb!==null&&!(typeof m.sizeGb==='number'&&Number.isFinite(m.sizeGb)&&m.sizeGb>=0&&m.sizeGb<=100000))fail('invalid',`${at}.sizeGb must be a number of gigabytes`);
   return {id:noSecret(text(m.id,120,{empty:false,where:`${at}.id`}),`${at}.id`),state:m.state??'idle',sizeGb:m.sizeGb??null,path:noSecret(text(m.path,240,{where:`${at}.path`}),`${at}.path`)||null};});
  return {id:b.id,layer:b.layer,col0:b.col0,col1:b.col1,title:noSecret(text(b.title,60,{empty:false,where:`${where}.title`}),`${where}.title`),
   port:noSecret(text(b.port,80,{where:`${where}.port`}),`${where}.port`),desc:noSecret(text(b.desc,400,{where:`${where}.desc`}),`${where}.desc`),
   state:b.state??'on',...(b.service?{service:b.service}:{}),models};});
 // Position is the only link between blocks, so two blocks may not claim the same cell.
 for(const a of blocks)for(const b of blocks)if(a!==b&&a.layer===b.layer&&a.col0<=b.col1&&b.col0<=a.col1)fail('invalid',`stack.blocks "${a.id}" and "${b.id}" overlap on the ${a.layer} layer`);
 return {cols,engines,blocks};
}

// siteMachines: the site configuration's machines ({id, role, thermoId, platform}); only they can carry a site binding.
export function createHomeDevices(root,{reserved=[],lanCidrs=[],siteMachines=[],box=defaultSecretBox(),log=console}={}){
 const siteFile=path.join(root,'site-telemetry.json'),overrideFile=path.join(root,'site-overrides.json');
 const file=path.join(root,'devices.json'),secrets=path.join(root,'thermo-hosts.json'),windowsFile=path.join(root,'windows-hosts.json'),feedFile=path.join(root,'telemetry-hosts.json'),runtimes=path.join(root,'runtimes.json'),images=path.join(root,'images');
 let queue=Promise.resolve();
 const protect=createPrivatePathGuard();
 const readJson=async(f,empty)=>{try{return JSON.parse(await readFile(f,'utf8'));}catch(e){if(e.code==='ENOENT')return empty();throw e;}};
 const read=async()=>{const d=await readJson(file,()=>({schema:1,devices:[]}));if(d?.schema!==1||!Array.isArray(d.devices))throw new Error('Invalid devices file');return d;};
 const readRuntimes=async()=>{const d=await readJson(runtimes,()=>({schema:1,stacks:{}}));if(d?.schema!==1||!plain(d.stacks))throw new Error('Invalid runtimes file');return d;};
 const atomic=async(f,value)=>{await mkdir(root,{recursive:true,mode:0o700});await protect(root,true);const tmp=f+'.'+randomUUID();
  try{await writeFile(tmp,JSON.stringify(value,null,1)+'\n',{mode:0o600,flag:'wx'});await protect(tmp,false);await rename(tmp,f);}finally{await rm(tmp,{force:true});}};
 // inQueue: whether the caller already runs in the write queue (it must not wait for the queue then).
 const inQueue=new AsyncLocalStorage();
 const serial=fn=>{const run=queue.then(()=>inQueue.run(true,fn));queue=run.catch(()=>{});return run;};
 // The two files that hold passwords and tokens are sealed (server/secret-box.mjs); the file's purpose binds each
 // envelope to its file. A plain file (written before sealing) is still read, and is rewritten sealed once, in the
 // write queue, only if it is still plain then (a write in between already sealed it).
 const SEALED={[secrets]:'home/thermo-hosts',[feedFile]:'home/telemetry-hosts'},migrating=new Map();
 // A sealed file whose key is certainly gone (a reinstall that kept state/ but not private/). How each caller meets it:
 //   read    pollers and dialogs: as if empty (its devices show "no login"); the file stays as it is, so a key that
 //           comes back makes everything work again
 //   strict  the SSH key sweep: an error, so no key file is swept while connections cannot be read
 //   write   a person saving or removing a login: the file is renamed aside (<name>.lost-<time>, never deleted) and the
 //           store goes on without it, sealing with a new key; only when certain (confirmLost), else 'secrets-locked'
 // Certain = the box says so (key files that answered and hold no such key) AND the marker (secret-key.json: every
 // key-file fingerprint the files here were sealed with, and the key file in use) knows the file's key, AND either
 // the marker's key file is this hub's and its directory is there (the key alone went: a reinstall without it), or
 // the marker's key directory is gone altogether (the hub moved). A launch with another key path while the marker's
 // directory is still there (a preview over this state), an unmounted volume at this path: never certain.
 const markerFile=path.join(root,'secret-key.json'),MARKER_KFPS=16;
 const readMarker=async()=>{const m=await readJson(markerFile,()=>null).catch(()=>null);return m&&m.schema===2&&Array.isArray(m.kfps)?m:null;};
 const confirmLost=async raw=>{const m=await readMarker();
  if(!m||raw.kid!=='file'||typeof raw.kfp!=='string'||!m.kfps.includes(raw.kfp)||!box.keyFile||typeof m.keyFile!=='string')return false;
  return m.keyFile===box.keyFile?existsSync(path.dirname(box.keyFile)):!existsSync(path.dirname(m.keyFile));};
 const setAside=async(f,text)=>{const now=await readFile(f,'utf8').catch(()=>null);if(now!==text)return;
  const aside=`${f}.lost-${new Date().toISOString().replace(/[:.]/g,'-')}`;await rename(f,aside);
  log.warn?.(`home: the key of ${path.basename(f)} is gone; its secrets were set aside as ${path.basename(aside)} and are to be entered again`);};
 const openSecret=async(f,raw,text,mode)=>{try{return await box.open(raw,SEALED[f]);}catch(e){if(e.reason!=='secrets-lost')throw e;
   if(mode==='read')return null;
   if(mode!=='write'||!await confirmLost(raw))throw Object.assign(new Error('secrets-locked'),{reason:'secrets-locked',detail:e.detail});
   await (inQueue.getStore()?setAside(f,text):serial(()=>setAside(f,text)));return null;}};
 const readSecret=async(f,empty,mode='read')=>{const text=await readFile(f,'utf8').catch(e=>{if(e.code==='ENOENT')return null;throw e;});if(text===null)return empty();
  const raw=JSON.parse(text);if(isSealed(raw)){const value=await openSecret(f,raw,text,mode);if(value!==null&&!raw.kfp)migrate(f);return value===null?empty():value;}
  migrate(f);return raw;};
 // A plain file (an older hub's) or one sealed before files named their key: sealed again, in the write queue, only if
 // it still is that. One try at a time per file; after a failure (no key can be made now), the next waits ten minutes.
 const migrate=f=>{  const after=migrating.get(f);
  if(after===undefined||after<=Date.now()){migrating.set(f,Infinity);void serial(async()=>{const now=await readJson(f,()=>null);
    if(now&&!isSealed(now))await atomicSecret(f,now);else if(isSealed(now)&&!now.kfp)await atomicSecret(f,await box.open(now,SEALED[f]));})
   .then(()=>migrating.delete(f),e=>{migrating.set(f,Date.now()+MIGRATE_RETRY_MS);log.warn?.(`home: ${path.basename(f)} is not sealed again yet (${e.reason||e.code||'error'})`);});}};
 // Before a change that touches more than one file: both secret files open, and the sealing key is there when the
 // change will seal (new secrets, or entries of this id to drop), so a locked key refuses the whole change up front
 // instead of leaving it half done. A device with no secrets needs no key (none is made for it).
 const unlocked=async(id,{seal=false}={})=>{const s=await readSecret(secrets,()=>({hosts:[]}),'write'),f=await readFeeds('write');
  if(seal||(s.hosts||[]).some(h=>h?.id===id)||f.hosts.some(h=>h?.id===id))await box.ready();};
 // Sealing also keeps the marker in step: which key (source, fingerprint, key file) the files here are sealed with.
 // The marker goes first, so a crash in between never leaves a sealed file the marker does not know.
 const atomicSecret=async(f,value)=>{const env=await box.seal(value,SEALED[f]);
  if(env.kid==='file'){const m=await readMarker(),kfps=m?.kfps||[];
   if(!m||m.keyFile!==box.keyFile||!kfps.includes(env.kfp))await atomic(markerFile,{schema:2,keyFile:box.keyFile,kfps:[...kfps.filter(k=>k!==env.kfp),env.kfp].slice(-MARKER_KFPS)});}
  await atomic(f,env);};
 const imageFile=id=>DEVICE_ID.test(id)?path.join(images,id+'.jpg'):fail('invalid');
 const sameHost=(a,b)=>a&&b&&a.toLowerCase()===b.toLowerCase();
 // What goes into the file: the legacy "kind" stays in step with thermoId, so an older hub still reads it.
 const stored=d=>({...d,kind:d.thermoId?'thermo':'other'});
 const saveLogin=async(id,login)=>{const s=await readSecret(secrets,()=>({hosts:[]}),'write');const had=(s.hosts||[]).some(h=>h.id===id);
  if(!login&&!had)return false;s.hosts=[...(s.hosts||[]).filter(h=>h.id!==id),...(login?[{id,...login}]:[])];await atomicSecret(secrets,s);return had;};
 const readWindows=async()=>{const w=await readJson(windowsFile,()=>({schema:1,hosts:[]}));return Array.isArray(w?.hosts)?w:{schema:1,hosts:[]};};
 // entry: {target} (an alias), a managed record (validManaged), or null to forget. Returns the entry it replaced, or null.
 // Entries of other devices are kept exactly as they are, whatever shape they have.
 const saveWindows=async(id,entry)=>{const w=await readWindows(),previous=w.hosts.find(h=>h?.id===id)||null;
  if(!entry&&!previous)return null;
  const next=!entry?null:entry.mode==='managed'?(validManaged(entry)?{...entry,id}:fail('invalid')):{id,target:entry.target};
  w.hosts=[...w.hosts.filter(h=>h?.id!==id),...(next?[next]:[])];await atomic(windowsFile,{schema:1,hosts:w.hosts});return previous;};
 // What the poller gets for a stored entry: {id, target} for an alias, {id, target: its label, managed} for a managed one.
 const hostOf=h=>h?.mode==='managed'?(validManaged(h)?{id:h.id,target:managedLabel(h),managed:h}:null):h&&validSshTarget(h.target)?{id:h.id,target:h.target}:null;
 // The other providers: telemetry-hosts.json = {schema:1, hosts:[{id, provider, record}]}. A record holds a
 // password for WinRM and for a Node Exporter with Basic: this file is 0600 and its records never leave the server.
 const readFeeds=async(mode='read')=>{const f=await readSecret(feedFile,()=>({schema:1,hosts:[]}),mode);return Array.isArray(f?.hosts)?f:{schema:1,hosts:[]};};
 const feedOf=h=>h&&Object.hasOwn(FEED_RECORD,h.provider)&&FEED_RECORD[h.provider](h.record)?{id:h.id,provider:h.provider,target:feedLabel(h.provider,h.record),record:h.record}:null;
 // entry: {provider, record} or null. Returns the entry it replaced (any provider), or null.
 const saveFeed=async(id,entry)=>{const f=await readFeeds('write'),previous=f.hosts.find(h=>h?.id===id)||null;
  if(!entry&&!previous)return null;
  if(entry&&(!Object.hasOwn(FEED_RECORD,entry.provider)||!FEED_RECORD[entry.provider](entry.record)))fail('invalid');
  f.hosts=[...f.hosts.filter(h=>h?.id!==id),...(entry?[{id,provider:entry.provider,record:entry.record}]:[])];await atomicSecret(feedFile,{schema:1,hosts:f.hosts});return previous;};
 // Site bindings (site-telemetry.json). Every stored one, well-formed; effective = its id is a site machine that can
 // take this provider now. One that is not (the machine left site.json, got a thermoId, another platform) is neither
 // polled nor shown, and its connection is kept on disk until it is disconnected: an edit of site.json never deletes a key.
 const siteById=id=>siteMachines.find(m=>m?.id===id)||null;
 const readSite=async()=>{const f=await readJson(siteFile,()=>({schema:1,bindings:[]}));
  return (Array.isArray(f?.bindings)?f.bindings:[]).filter(b=>b&&typeof b.id==='string'&&DEVICE_ID.test(b.id)&&TELEMETRY_PROVIDERS.includes(b.provider));};
 const effective=b=>siteProviderFits(siteById(b.id),b.provider);
 const bindingOf=b=>({id:b.id,provider:b.provider,platform:PROVIDER_PLATFORM[b.provider],configuredAt:typeof b.configuredAt==='string'?b.configuredAt:null,configuredBy:typeof b.configuredBy==='string'?b.configuredBy:null});
 const saveSite=async(id,next)=>{const all=await readSite();
  const bindings=[...all.filter(b=>b.id!==id),...(next?[{id,provider:next.provider,platform:PROVIDER_PLATFORM[next.provider],configuredAt:new Date().toISOString(),configuredBy:next.by||null}]:[])];
  await atomic(siteFile,{schema:1,bindings});};
 const siteView=(id,provider)=>{const m=siteById(id);return {id,source:'site',readOnly:true,telemetryProvider:provider||null,platform:m?.platform||(provider?PROVIDER_PLATFORM[provider]:null)};};
 const siteRefusal=(m,provider)=>{
  if(!m)fail('not-found');
  if(m.thermoId)fail('invalid','the site configuration reads this machine through Thermo (thermoId); its telemetry is set in the site files');
  if(m.role==='router')fail('invalid','a router is reported by the router adapter, not by host telemetry');
  if(!siteProviderFits(m,provider))fail('invalid',`the site configuration says this machine runs ${m.platform}; this telemetry needs platform ${PROVIDER_PLATFORM[provider]}`);};
 // Site overrides (site-overrides.json): every stored one that is well formed; one whose machine left site.json is kept
 // on disk (an edit of site.json never deletes what the owner wrote) and neither shown nor counted until it is reset.
 const readOverrides=async()=>{const f=await readJson(overrideFile,()=>({schema:1,overrides:[]}));
  return (Array.isArray(f?.overrides)?f.overrides:[]).filter(o=>o&&typeof o.id==='string'&&DEVICE_ID.test(o.id)&&plain(o.fields));};
 const writeOverrides=all=>atomic(overrideFile,{schema:1,overrides:all});
 const overrideView=o=>({fields:{...o.fields,...(o.fields.hardware?{hardware:{...o.fields.hardware}}:{})},image:o.image===true,imageAt:typeof o.imageAt==='string'?o.imageAt:null,
  updatedAt:typeof o.updatedAt==='string'?o.updatedAt:null,updatedBy:typeof o.updatedBy==='string'?o.updatedBy:null,hash:siteOverrideHash(o)});
 // Whose hostname this would be: an added device's, or another site machine's (its effective one).
 const hostTaken=async(id,host)=>{if(!host)return false;const all=await readOverrides();
  return (await read()).devices.some(x=>sameHost(x.hostname,host))
   ||siteMachines.some(m=>m.id!==id&&sameHost(all.find(o=>o.id===m.id)?.fields.hostname??m.hostname,host));};
 // One override, changed inside the write queue: next(current) → the new entry, or null to drop it.
 const changeOverride=async(id,next)=>{const all=await readOverrides(),current=all.find(o=>o.id===id)||null,entry=next(current);
  if(!current&&!entry)return null;const rest=all.filter(o=>o.id!==id);await writeOverrides(entry?[...rest,entry]:rest);return entry;};

 async function list(){return (await read()).devices.map(normalizeDevice);}
 // The effective overrides of site machines: {machineId: {fields, image, imageAt, updatedAt, updatedBy, hash}}.
 async function siteOverrides(){return Object.fromEntries((await readOverrides()).filter(o=>siteById(o.id)).map(o=>[o.id,overrideView(o)]));}
 // Replace the override of a site machine (the owner's edit dialog). base: the hash it read (GET /api/home →
 // siteOverride.hash, also for a machine without one), required. The uploaded picture is kept (putImage/removeImage own it).
 // Returns {id, override, hash, changed}.
 const setSiteOverride=(id,input,{by=null,base}={})=>{
  if(typeof base!=='string'||!/^[a-f0-9]{64}$/.test(base))fail('invalid','base must be the 64-character siteOverride.hash the machine was read with');
  return serial(async()=>{
   const m=siteById(id);if(!m)fail('not-found');
   const fields=parseSiteOverride(input,m,{lanCidrs});
   const all=await readOverrides(),current=all.find(o=>o.id===id)||null;
   if(base!==siteOverrideHash(current))fail('conflict');
   if(fields.hostname&&await hostTaken(id,fields.hostname))fail('duplicate');
   const same=sha(fields)===sha(current?.fields||{});
   if(same)return {id,override:current?overrideView(current):null,hash:siteOverrideHash(current),changed:false};
   const keepImage=current?.image===true?{image:true,imageAt:current.imageAt}:{};
   const entry=Object.keys(fields).length||keepImage.image?{id,fields,...keepImage,updatedAt:new Date().toISOString(),updatedBy:by}:null;
   await writeOverrides([...all.filter(o=>o.id!==id),...(entry?[entry]:[])]);
   return {id,override:entry?overrideView(entry):null,hash:siteOverrideHash(entry),changed:true};
  });
 };
 // Back to the site's defaults: the override and the uploaded picture go. base: as for setSiteOverride.
 // An override whose machine left site.json is cleared here as well (the only way it goes).
 const resetSiteOverride=(id,{base}={})=>{
  if(typeof base!=='string'||!/^[a-f0-9]{64}$/.test(base))fail('invalid','base must be the 64-character siteOverride.hash the machine was read with');
  return serial(async()=>{
   const all=await readOverrides(),current=all.find(o=>o.id===id)||null;
   if(!siteById(id)&&!current)fail('not-found');
   if(base!==siteOverrideHash(current))fail('conflict');
   if(current){await writeOverrides(all.filter(o=>o!==current));await rm(imageFile(id),{force:true});}
   return {id,override:null,hash:siteOverrideHash(null),changed:Boolean(current)};
  });
 };
 // Thermo logins of added devices, in the same shape as private/thermo-hosts.json.
 async function thermoHosts(){return parseHostsConfig(await readSecret(secrets,()=>({hosts:[]})));}
 // Connections of devices read through Windows telemetry: [{id, target, managed?}]. Only devices that still say so count.
 async function windowsHosts(){
  const ids=new Set([...(await list()).filter(d=>d.telemetryProvider==='windows').map(d=>d.id),...(await siteBindings()).filter(b=>b.provider==='windows').map(b=>b.id)]);
  return (await readWindows()).hosts.filter(h=>h&&ids.has(h.id)).map(hostOf).filter(Boolean);
 }
 // The effective site bindings: [{id, provider, platform, configuredAt, configuredBy}] (no connection, no secret).
 async function siteBindings(){return (await readSite()).filter(effective).map(bindingOf);}
 // What a telemetry set-up is for: an added device, or a site machine that can take a binding (bindable). null = unknown id.
 //   {id, site, thermoId, platform, sitePlatform (site machines: what site.json says), telemetryProvider, role, bindable}
 async function telemetryTarget(id){
  const d=(await list()).find(x=>x.id===id);
  if(d)return {id,site:false,thermoId:d.thermoId,platform:d.platform,telemetryProvider:d.telemetryProvider,role:d.role,bindable:true};
  const m=siteById(id);if(!m)return null;
  const b=(await siteBindings()).find(x=>x.id===id)||null;
  return {id,site:true,thermoId:m.thermoId||null,platform:m.platform||b?.platform||null,sitePlatform:m.platform||null,telemetryProvider:b?.provider||null,role:m.role,bindable:siteBindable(m)};
 }
 // The stored entry of one device (server side only: the set-up dialog starts from it), or null.
 async function windowsEntry(id){return (await readWindows()).hosts.find(h=>h?.id===id)||null;}
 // The key and known_hosts ids every stored managed connection uses (Windows and Linux over SSH): what the key store must keep.
 async function windowsSecrets(){
  const keys=new Set(),conns=new Set();
  const add=h=>{if(h?.mode!=='managed')return;if(typeof h.keyId==='string')keys.add(h.keyId);if(typeof h.connId==='string')conns.add(h.connId);};
  for(const h of (await readWindows()).hosts)add(h);
  for(const h of (await readFeeds('strict')).hosts)add(h?.record);
  return {keys,conns};
 }
 // Connections of one provider in telemetry-hosts.json: [{id, provider, target, record}] for devices that still say so.
 async function feedHosts(provider){
  const ids=new Set([...(await list()).filter(d=>d.telemetryProvider===provider).map(d=>d.id),...(await siteBindings()).filter(b=>b.provider===provider).map(b=>b.id)]);
  return (await readFeeds()).hosts.filter(h=>h&&h.provider===provider&&ids.has(h.id)).map(feedOf).filter(Boolean);
 }
 // The stored entry of one device ({provider, record}; server side only: the set-up dialog starts from it), or null.
 async function feedEntry(id){const h=(await readFeeds()).hosts.find(x=>x?.id===id);return h?{provider:h.provider,record:h.record}:null;}
 // The overview's own dialog. input: {name, kind, hostname, ip?, role?, picture?, props?{cpu,gpu,ramGb},
 // thermo?{port, username, password, pin}, platform?, windows?{target}}; the id is made from the name.
 // kind "windows" = read through SSH + PowerShell (platform is then windows): either windows:{target} (an alias),
 // or no windows field and managed = the checked connection from a set-up draft (the caller's, never the input's).
 // Returns {device, thermo: the host config or null, windows: {id,target,managed?} or null}. The caller checks the login first.
 function parse(input,managed=null,feed=null){
  if(!onlyKeys(input,['name','kind','hostname','ip','props','thermo','role','picture','platform','windows']))fail('invalid');
  const kind=DEVICE_KINDS.includes(input.kind)?input.kind:fail('invalid','kind must be thermo, windows or other');
  if(input.props!==undefined&&!onlyKeys(input.props,['cpu','gpu','ramGb','diskTotalBytes']))fail('invalid');
  const m=parseMachine({name:input.name,hostname:input.hostname,ip:input.ip,role:input.role??(kind==='other'?'other':'computer'),picture:input.picture,hardware:input.props,platform:input.platform??null},{lanCidrs,needId:false});
  if(!m.hostname)fail('invalid','hostname is required');
  if(kind!=='thermo'&&input.thermo!==undefined)fail('invalid');
  if(kind!=='windows'&&input.windows!==undefined)fail('invalid');
  const feedKind=Object.hasOwn(FEED_RECORD,kind);
  if(Object.hasOwn(PROVIDER_PLATFORM,kind)&&m.platform!==null&&m.platform!==PROVIDER_PLATFORM[kind])fail('invalid',`${kind} telemetry needs platform ${PROVIDER_PLATFORM[kind]}`);
  if(managed&&(kind!=='windows'||input.windows!==undefined||!validManaged(managed)))fail('invalid');
  // A WinRM, Node Exporter or Linux SSH device is added only with the checked record of a set-up draft (the caller's).
  if(feedKind&&(!feed||feed.provider!==kind||!FEED_RECORD[kind](feed.record)))fail('invalid','this telemetry needs a tested connection from the set-up dialog');
  if(!feedKind&&feed)fail('invalid');
  return {...m,platform:Object.hasOwn(PROVIDER_PLATFORM,kind)?PROVIDER_PLATFORM[kind]:m.platform,kind,thermo:kind==='thermo'?parseThermo(input.thermo,m.hostname):null,
   windows:kind==='windows'?(managed?{...managed}:parseWindows(input.windows)):null,feed:feedKind?{provider:kind,record:{...feed.record}}:null};
 }
 const add=(input,by,{managed=null,feed=null}={})=>{
  const d=parse(input,managed,feed);
  return serial(async()=>{
   const data=await read();if(data.devices.length>=DEVICE_LIMITS.devices)fail('limit');
   if(data.devices.some(x=>sameHost(x.hostname,d.hostname)))fail('conflict');
   const id=deviceId(d.name,[...reserved,...data.devices.map(x=>x.id),...(await readSite()).map(b=>b.id)]);
   const device=stored({id,name:d.name,hostname:d.hostname,ip:d.ip,role:d.role,props:d.props,thermoId:d.thermo?id:null,picture:d.picture,source:'ui',image:false,
    ...(d.platform?{platform:d.platform}:{}),...(d.windows?{telemetryProvider:'windows'}:d.feed?{telemetryProvider:d.feed.provider}:{}),createdAt:new Date().toISOString(),createdBy:by});
   let thermo=null;
   if(d.thermo||d.windows||d.feed)await unlocked(id,{seal:Boolean(d.thermo||d.feed)});
   if(d.thermo){thermo={id,...d.thermo};await saveLogin(id,d.thermo);}
   if(d.windows)await saveWindows(id,d.windows);
   if(d.feed)await saveFeed(id,d.feed);
   data.devices.push(device);await atomic(file,data);
   return {device:normalizeDevice(device),thermo:thermo?parseHostsConfig({hosts:[thermo]})[0]:null,windows:d.windows?hostOf({...d.windows,id}):null,feed:d.feed?feedOf({id,...d.feed}):null};
  });
 };
 // Create or replace one machine by id (machine_upsert and the edit dialog). The whole record is replaced;
 // what the hub keeps for itself stays: the uploaded picture, who created it and when, the Thermo login.
 //   base absent:  create; or, when the machine already holds exactly these fields, nothing to do (idempotent)
 //   base present: the hash the caller read; a mismatch is a conflict, so is a base for a machine that is not there
 // Returns {device, hash, created, changed}.
 const upsert=(input,{by=null,source='ui',base}={})=>{
  const m=parseMachine(input,{lanCidrs});
  if(base!==undefined&&(typeof base!=='string'||!/^[a-f0-9]{64}$/.test(base)))fail('invalid','base must be the 64-character hash from machine_list');
  if(reserved.includes(m.id))fail('read-only');
  return serial(async()=>{
   const data=await read(),index=data.devices.findIndex(x=>x.id===m.id),current=index<0?null:normalizeDevice(data.devices[index]);
   if(data.devices.some(x=>x.id!==m.id&&sameHost(x.hostname,m.hostname)))fail('duplicate');
   const now=new Date().toISOString();
   if(!current){
    if(base!==undefined)fail('conflict');
    if(data.devices.length>=DEVICE_LIMITS.devices)fail('limit');
    const device=stored({...m,platform:m.platform??null,source:source==='agent'?'agent':'ui',image:false,createdAt:now,createdBy:by});
    data.devices.push(device);await atomic(file,data);
    return {device:normalizeDevice(device),hash:machineHash(normalizeDevice(device)),created:true,changed:true};
   }
   if(current.telemetryProvider){
    const need=PROVIDER_PLATFORM[current.telemetryProvider],what=need==='windows'?'Windows':'Linux';
    if(m.thermoId)fail('invalid',`machine.thermoId cannot be set while ${what} telemetry is connected; disconnect it in the web UI first`);
    if(m.platform!==undefined&&m.platform!==need)fail('invalid',`machine.platform must stay ${need} while ${what} telemetry is connected`);
   }
   const next={...current,...m,platform:m.platform===undefined?current.platform:m.platform},hash=machineHash(next);
   if(base===undefined?hash!==machineHash(current):base!==machineHash(current))fail('conflict');
   if(hash===machineHash(current))return {device:current,hash,created:false,changed:false};
   const device=stored({...next,updatedAt:now,updatedBy:by});
   data.devices[index]=device;await atomic(file,data);
   return {device:normalizeDevice(device),hash,created:false,changed:true};
  });
 };
 // base (optional): the hash the caller read. Returns {device, hadLogin, hadWindows, windows}: hadLogin = a stored
 // telemetry login went with it; windows = the Windows entry that went (its key files are the caller's to delete).
 const remove=(id,{base}={})=>serial(async()=>{
  if(reserved.includes(id))fail('read-only');
  const data=await read(),device=data.devices.find(x=>x.id===id)||fail('not-found');
  if(base!==undefined&&base!==machineHash(normalizeDevice(device)))fail('conflict');
  await unlocked(id);
  data.devices=data.devices.filter(x=>x!==device);await atomic(file,data);
  const windows=await saveWindows(id,null),hadWindows=windows!==null;
  const feed=await saveFeed(id,null);
  const hadLogin=await saveLogin(id,null)||hadWindows||feed!==null;
  const r=await readRuntimes();if(Object.hasOwn(r.stacks,id)){delete r.stacks[id];await atomic(runtimes,r);}
  await rm(imageFile(id),{force:true});return {device:normalizeDevice(device),hadLogin,hadWindows,windows,feed:feed?{provider:feed.provider,record:feed.record}:null};
 });
 // Connect an existing device to Thermo (login checked by the caller first), or forget its login (thermo = null).
 // The device becomes its own Thermo host: thermoId = its id. Returns {device, thermo: host config or null, hadLogin}.
 const setThermo=(id,input)=>serial(async()=>{
  const data=await read(),index=data.devices.findIndex(x=>x.id===id);if(index<0)fail('not-found');
  const current=normalizeDevice(data.devices[index]);
  if(input!==null&&current.telemetryProvider)fail('invalid',`${PROVIDER_PLATFORM[current.telemetryProvider]==='windows'?'Windows':'Linux'} telemetry is connected; disconnect it before connecting Thermo`);
  const login=input===null?null:parseThermo(input,current.hostname||current.ip||fail('invalid','the device needs a hostname or an IP first'));
  const hadLogin=await saveLogin(id,login);
  const device=stored({...current,thermoId:login?id:current.thermoId===id?null:current.thermoId,updatedAt:new Date().toISOString()});
  data.devices[index]=device;await atomic(file,data);
  return {device:normalizeDevice(device),thermo:login?parseHostsConfig({hosts:[{id,...login}]})[0]:null,hadLogin};
 });
 // Connect a device that is already on the overview (added as a plain tile, or by an agent) to Windows
 // telemetry, re-target it, or forget it (null). input: {target} (an alias), or null; managed (option): the
 // checked connection of a set-up draft instead. Nothing else about the device changes: its id, picture,
 // history and creation stay. The caller checks the connection first.
 // Returns {device, windows: {id,target,managed?} or null, hadLogin, previous: the entry it replaced or null}.
 const setWindows=(id,input,{managed=null,by=null}={})=>{
  if(managed&&(input!==undefined||!validManaged(managed)))fail('invalid');
  const login=managed?{...managed}:input===null?null:parseWindows(input);
  return serial(async()=>{
   await unlocked(id);
   const data=await read(),index=data.devices.findIndex(x=>x.id===id);if(index<0)return siteWindows(id,login,{managed:Boolean(managed),by});
   const current=normalizeDevice(data.devices[index]);
   if(login&&current.thermoId)fail('invalid','the device reports through Thermo; disconnect Thermo first');
   if(login&&current.platform&&current.platform!=='windows')fail('invalid',`the device's platform is ${current.platform}; Windows telemetry needs platform windows`);
   const previous=await saveWindows(id,login);
   // Connecting Windows over SSH replaces whatever other provider read the device (its secrets go with it).
   const replaced=login||current.telemetryProvider==='windows'?await saveFeed(id,null):null;
   const {telemetryProvider,...rest}=current;
   const keep=!login&&telemetryProvider&&telemetryProvider!=='windows'?{telemetryProvider}:{};
   const device=stored({...rest,...keep,...(login?{telemetryProvider:'windows',platform:'windows'}:{}),updatedAt:new Date().toISOString()});
   data.devices[index]=device;await atomic(file,data);
   return {device:normalizeDevice(device),windows:login?hostOf({...login,id}):null,hadLogin:previous!==null,previous,replaced:replaced?{provider:replaced.provider,record:replaced.record}:null};
  });
 };
 // setWindows for a machine of the site configuration (inside the write queue): only a connection the hub manages (no
 // SSH alias of the hub's account), and only where the site allows it. Its binding is written; site.json never is.
 async function siteWindows(id,login,{managed,by}){
  const m=siteById(id),had=(await readSite()).find(b=>b.id===id)||null;
  if(login){if(!managed)fail('invalid','a machine from the site configuration connects Windows over SSH only with a connection Home Hub manages');siteRefusal(m,'windows');}
  else if(!m&&!had)fail('not-found');
  const previous=await saveWindows(id,login);
  const replaced=login||had?.provider==='windows'?await saveFeed(id,null):null;
  if(login)await saveSite(id,{provider:'windows',by});else if(had?.provider==='windows')await saveSite(id,null);
  const provider=login?'windows':had&&had.provider!=='windows'?had.provider:null;
  return {device:siteView(id,provider),windows:login?hostOf({...login,id}):null,hadLogin:previous!==null,previous,replaced:replaced?{provider:replaced.provider,record:replaced.record}:null};
 }
 // Connect a device that is already on the overview to WinRM, Node Exporter or Linux SSH (entry = {provider,
 // record}: the checked record of a set-up draft), switch it from another agent-less provider, or disconnect it
 // (null). Nothing else about the device changes: its id, picture, history and creation stay. Thermo must be
 // disconnected first; the platform must be the provider's (null is set to it).
 // Returns {device, feed: {id, provider, target, record} or null, previous: {provider, record} of telemetry-hosts.json
 // or null, previousWindows: the windows-hosts.json entry it replaced or null, hadLogin}.
 const setFeed=(id,entry,{by=null}={})=>{
  if(entry!==null&&(!entry||!Object.hasOwn(FEED_RECORD,entry.provider)||!FEED_RECORD[entry.provider](entry.record)))fail('invalid');
  return serial(async()=>{
   const data=await read(),index=data.devices.findIndex(x=>x.id===id);if(index<0)return siteFeed(id,entry,by);
   const current=normalizeDevice(data.devices[index]);
   if(entry){
    const need=PROVIDER_PLATFORM[entry.provider];
    if(current.thermoId)fail('invalid','the device reports through Thermo; disconnect Thermo first');
    if(current.platform&&current.platform!==need)fail('invalid',`the device's platform is ${current.platform}; this telemetry needs platform ${need}`);
   }
   const previous=await saveFeed(id,entry?{provider:entry.provider,record:entry.record}:null);
   const previousWindows=entry||current.telemetryProvider==='windows'?await saveWindows(id,null):null;
   const {telemetryProvider,...rest}=current;
   const device=stored({...rest,...(entry?{telemetryProvider:entry.provider,platform:PROVIDER_PLATFORM[entry.provider]}:{}),updatedAt:new Date().toISOString()});
   data.devices[index]=device;await atomic(file,data);
   return {device:normalizeDevice(device),feed:entry?feedOf({id,...entry}):null,previous:previous?{provider:previous.provider,record:previous.record}:null,previousWindows,
    hadLogin:previous!==null||previousWindows!==null,previousProvider:telemetryProvider||null};
  });
 };
 // setFeed for a machine of the site configuration (inside the write queue). Disconnecting (entry null) also clears a
 // binding that is no longer effective (its machine left site.json): that is the only way its secrets go.
 async function siteFeed(id,entry,by){
  const m=siteById(id),had=(await readSite()).find(b=>b.id===id)||null;
  if(entry)siteRefusal(m,entry.provider);else if(!m&&!had)fail('not-found');
  const previous=await saveFeed(id,entry?{provider:entry.provider,record:entry.record}:null);
  const previousWindows=entry||had?.provider==='windows'?await saveWindows(id,null):null;
  if(entry||had)await saveSite(id,entry?{provider:entry.provider,by}:null);
  return {device:siteView(id,entry?.provider||null),feed:entry?feedOf({id,...entry}):null,previous:previous?{provider:previous.provider,record:previous.record}:null,previousWindows,
   hadLogin:previous!==null||previousWindows!==null,previousProvider:had?.provider||null};
 }
 // The picture arrives as one JPEG (the browser crops and encodes it); at most 3 MiB.
 async function putImage(id,body,declaredLength,{by=null}={}){
  if(Number.isFinite(declaredLength)&&declaredLength>DEVICE_LIMITS.image)fail('too-large');
  const chunks=[];let size=0;for await(const c of body){size+=c.length;if(size>DEVICE_LIMITS.image)fail('too-large');chunks.push(c);}
  const buf=Buffer.concat(chunks);if(buf.length<4||buf[0]!==0xff||buf[1]!==0xd8||buf[2]!==0xff)fail('invalid');
  return serial(async()=>{
   const data=await read(),device=data.devices.find(x=>x.id===id)||(siteById(id)?null:fail('not-found'));
   await mkdir(images,{recursive:true,mode:0o700});const tmp=imageFile(id)+'.'+randomUUID();
   try{await writeFile(tmp,buf,{mode:0o600,flag:'wx'});await rename(tmp,imageFile(id));}finally{await rm(tmp,{force:true});}
   const at=new Date().toISOString();
   // A machine of the site configuration: its own picture is part of its override (site.json is never written).
   if(!device){const entry=await changeOverride(id,o=>({id,fields:o?.fields||{},image:true,imageAt:at,updatedAt:at,updatedBy:by}));return {id,source:'site',siteOverride:overrideView(entry)};}
   device.image=true;device.imageAt=at;await atomic(file,data);return normalizeDevice(device);
  });
 }
 // Back to a built-in picture (or, on a site machine, to its override's or the site's own): the uploaded one goes.
 const removeImage=(id,{by=null}={})=>serial(async()=>{
  const data=await read(),device=data.devices.find(x=>x.id===id)||(siteById(id)?null:fail('not-found'));
  await rm(imageFile(id),{force:true});
  if(!device){const at=new Date().toISOString();
   const entry=await changeOverride(id,o=>!o?null:Object.keys(o.fields).length?{id,fields:o.fields,updatedAt:at,updatedBy:by}:null);
   return {id,source:'site',siteOverride:entry?overrideView(entry):null};}
  device.image=false;delete device.imageAt;await atomic(file,data);return normalizeDevice(device);
 });
 async function image(id){if(!DEVICE_ID.test(id))fail('not-found');try{const fh=await open(imageFile(id),'r');await fh.close();return imageFile(id);}catch{fail('not-found');}}

 // Published runtime stacks: {machineId: {stack, publishedAt, publishedBy}}; stack is what parseRuntime returned.
 async function stacks(){return (await readRuntimes()).stacks;}
 // machine must be a known id (the caller passes the site's machines; added devices are checked here).
 // stack = null takes the publication back. base (optional): the hash of the publication the caller read.
 // Returns {machine, hash: of what is now published or null, changed}.
 const publishRuntime=(machine,input,{by=null,base,known=[]}={})=>{
  if(typeof machine!=='string'||!DEVICE_ID.test(machine))fail('invalid','machine must be a machine id');
  if(base!==undefined&&(typeof base!=='string'||!/^[a-f0-9]{64}$/.test(base)))fail('invalid','base must be the 64-character hash of the published stack');
  const stack=input===null?null:parseRuntime(input);
  return serial(async()=>{
   if(!known.includes(machine)&&!(await read()).devices.some(x=>x.id===machine))fail('not-found');
   const data=await readRuntimes(),current=Object.hasOwn(data.stacks,machine)?data.stacks[machine]:null,currentHash=current?runtimeHash(current.stack):null;
   if(base!==undefined&&base!==currentHash)fail('conflict');
   const hash=stack?runtimeHash(stack):null;
   if(hash===currentHash)return {machine,hash,changed:false,publishedAt:current?.publishedAt||null};
   const publishedAt=new Date().toISOString();
   if(stack)data.stacks[machine]={stack,publishedAt,publishedBy:by};else delete data.stacks[machine];
   await atomic(runtimes,data);
   return {machine,hash,changed:true,publishedAt:stack?publishedAt:null};
  });
 };
 return {list,siteBindings,siteOverrides,setSiteOverride,resetSiteOverride,isSiteMachine:id=>Boolean(siteById(id)),telemetryTarget,thermoHosts,windowsHosts,windowsEntry,windowsSecrets,feedHosts,feedEntry,add,upsert,remove,setThermo,setWindows,setFeed,putImage,removeImage,image,stacks,publishRuntime};
}
