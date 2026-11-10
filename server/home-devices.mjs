// Machines that are not in the site configuration: devices added on the overview (⊕ Add device) and
// machines an agent wrote over MCP (machine_upsert). The site's own machines stay in site.json and are
// read-only here. One store, one write queue, atomic renames.
//   state/home/devices.json       the machines: id, name, hostname, ip, role, props, thermoId, picture (no secrets)
//   state/home/thermo-hosts.json  0600: the Thermo account a device logs in with (password, pinned cert)
//   state/home/runtimes.json      runtime stacks published for a machine (runtime_publish), site machines included
//   state/home/images/<id>.jpg    an uploaded tile picture, cropped to 3:2 in the browser
// devices.json keeps schema 1: every field added since the first version is optional and is filled in on
// read (normalize below), so a file written by an older hub loads unchanged and nothing is rewritten.
// Errors: Error('invalid' | 'secret' | 'not-found' | 'conflict' | 'duplicate' | 'limit' | 'read-only' | 'too-large'),
// with .detail (English, names the field) where a field was at fault.
import {mkdir,readFile,writeFile,rename,rm,open} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import path from 'node:path';
import {parseHostsConfig} from './thermo-client.mjs';
import {inCidrs} from './site-config.mjs';

export const DEVICE_ID=/^[a-z][a-z0-9_-]{1,31}$/;
export const DEVICE_KINDS=Object.freeze(['thermo','other']);
export const MACHINE_ROLES=Object.freeze(['computer','nas','router','other']);
// The built-in generic pictures (public/images/generic/<id>.svg). A machine's picture is one of these ids or null.
export const PICTURES=Object.freeze(['desktop','laptop','mini','tower','server','nas','router','board','printer','generic']);
export const pictureUrl=id=>`/images/generic/${id}.svg`;
export const defaultPicture=role=>({computer:'desktop',nas:'nas',router:'router'})[role]||'generic';
export const DEVICE_LIMITS=Object.freeze({devices:20,image:3*1024*1024});
export const RUNTIME_LAYERS=Object.freeze(['input','tool','runtime','engine','hardware']);
export const RUNTIME_LIMITS=Object.freeze({cols:12,engines:12,blocks:60,models:30});
const MODEL_STATES=['loaded','loading','idle'];
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
// is its own Thermo host, anything else a plain tile.
export function normalizeDevice(d){
 const p=plain(d.props)?d.props:{};
 return {...d,ip:d.ip||null,hostname:typeof d.hostname==='string'?d.hostname:'',image:d.image===true,
  props:{cpu:typeof p.cpu==='string'?p.cpu:'',gpu:typeof p.gpu==='string'?p.gpu:'',ramGb:Number.isFinite(p.ramGb)?p.ramGb:null,diskTotalBytes:Number.isFinite(p.diskTotalBytes)?p.diskTotalBytes:null},
  role:MACHINE_ROLES.includes(d.role)?d.role:d.kind==='thermo'?'computer':'other',
  thermoId:d.thermoId===null||typeof d.thermoId==='string'?d.thermoId:d.kind==='thermo'?d.id:null,
  picture:PICTURES.includes(d.picture)?d.picture:null,source:d.source==='agent'?'agent':'ui'};
}
// The fields a client reads and writes (machine_list, machine_upsert, the edit dialog), in a fixed order.
export const machineFields=d=>({id:d.id,name:d.name,hostname:d.hostname,ip:d.ip||null,role:d.role,
 hardware:{cpu:d.props.cpu,gpu:d.props.gpu,ramGb:d.props.ramGb,diskTotalBytes:d.props.diskTotalBytes},thermoId:d.thermoId,picture:d.picture});
// Optimistic concurrency, like inventory entries: the hash of what a client read must still match on write.
export const machineHash=d=>sha(machineFields(d));
export const runtimeHash=stack=>sha(stack);

// {id?, name, hostname?, ip?, role?, hardware?{cpu,gpu,ramGb,diskTotalBytes}, thermoId?, picture?} → clean fields.
// lanCidrs: the site's networks; when set, an ip must be a host address inside one of them.
export function parseMachine(input,{lanCidrs=[],needId=true}={}){
 extraKeys(input,['id','name','hostname','ip','role','hardware','thermoId','picture'],'machine');
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
 return {id,name,hostname,ip:ip||null,role,props,thermoId,picture};
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

export function createHomeDevices(root,{reserved=[],lanCidrs=[]}={}){
 const file=path.join(root,'devices.json'),secrets=path.join(root,'thermo-hosts.json'),runtimes=path.join(root,'runtimes.json'),images=path.join(root,'images');
 let queue=Promise.resolve();
 const readJson=async(f,empty)=>{try{return JSON.parse(await readFile(f,'utf8'));}catch(e){if(e.code==='ENOENT')return empty();throw e;}};
 const read=async()=>{const d=await readJson(file,()=>({schema:1,devices:[]}));if(d?.schema!==1||!Array.isArray(d.devices))throw new Error('Invalid devices file');return d;};
 const readRuntimes=async()=>{const d=await readJson(runtimes,()=>({schema:1,stacks:{}}));if(d?.schema!==1||!plain(d.stacks))throw new Error('Invalid runtimes file');return d;};
 const atomic=async(f,value)=>{await mkdir(root,{recursive:true,mode:0o700});const tmp=f+'.'+randomUUID();
  try{await writeFile(tmp,JSON.stringify(value,null,1)+'\n',{mode:0o600,flag:'wx'});await rename(tmp,f);}finally{await rm(tmp,{force:true});}};
 const serial=fn=>{const run=queue.then(fn);queue=run.catch(()=>{});return run;};
 const imageFile=id=>DEVICE_ID.test(id)?path.join(images,id+'.jpg'):fail('invalid');
 const sameHost=(a,b)=>a&&b&&a.toLowerCase()===b.toLowerCase();
 // What goes into the file: the legacy "kind" stays in step with thermoId, so an older hub still reads it.
 const stored=d=>({...d,kind:d.thermoId?'thermo':'other'});
 const saveLogin=async(id,login)=>{const s=await readJson(secrets,()=>({hosts:[]}));const had=(s.hosts||[]).some(h=>h.id===id);
  if(!login&&!had)return false;s.hosts=[...(s.hosts||[]).filter(h=>h.id!==id),...(login?[{id,...login}]:[])];await atomic(secrets,s);return had;};

 async function list(){return (await read()).devices.map(normalizeDevice);}
 // Thermo logins of added devices, in the same shape as private/thermo-hosts.json.
 async function thermoHosts(){return parseHostsConfig(await readJson(secrets,()=>({hosts:[]})));}
 // The overview's own dialog. input: {name, kind, hostname, ip?, role?, picture?, props?{cpu,gpu,ramGb},
 // thermo?{port, username, password, pin}}; the id is made from the name.
 // Returns {device, thermo: the host config or null}. The caller checks the Thermo login before calling.
 function parse(input){
  if(!onlyKeys(input,['name','kind','hostname','ip','props','thermo','role','picture']))fail('invalid');
  const kind=DEVICE_KINDS.includes(input.kind)?input.kind:fail('invalid','kind must be thermo or other');
  if(input.props!==undefined&&!onlyKeys(input.props,['cpu','gpu','ramGb','diskTotalBytes']))fail('invalid');
  const m=parseMachine({name:input.name,hostname:input.hostname,ip:input.ip,role:input.role??(kind==='thermo'?'computer':'other'),picture:input.picture,hardware:input.props},{lanCidrs,needId:false});
  if(!m.hostname)fail('invalid','hostname is required');
  if(kind!=='thermo'&&input.thermo!==undefined)fail('invalid');
  return {...m,kind,thermo:kind==='thermo'?parseThermo(input.thermo,m.hostname):null};
 }
 const add=(input,by)=>{
  const d=parse(input);
  return serial(async()=>{
   const data=await read();if(data.devices.length>=DEVICE_LIMITS.devices)fail('limit');
   if(data.devices.some(x=>sameHost(x.hostname,d.hostname)))fail('conflict');
   const id=deviceId(d.name,[...reserved,...data.devices.map(x=>x.id)]);
   const device=stored({id,name:d.name,hostname:d.hostname,ip:d.ip,role:d.role,props:d.props,thermoId:d.thermo?id:null,picture:d.picture,source:'ui',image:false,createdAt:new Date().toISOString(),createdBy:by});
   let thermo=null;
   if(d.thermo){thermo={id,...d.thermo};await saveLogin(id,d.thermo);}
   data.devices.push(device);await atomic(file,data);
   return {device:normalizeDevice(device),thermo:thermo?parseHostsConfig({hosts:[thermo]})[0]:null};
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
    const device=stored({...m,source:source==='agent'?'agent':'ui',image:false,createdAt:now,createdBy:by});
    data.devices.push(device);await atomic(file,data);
    return {device:normalizeDevice(device),hash:machineHash(normalizeDevice(device)),created:true,changed:true};
   }
   const next={...current,...m},hash=machineHash(next);
   if(base===undefined?hash!==machineHash(current):base!==machineHash(current))fail('conflict');
   if(hash===machineHash(current))return {device:current,hash,created:false,changed:false};
   const device=stored({...next,updatedAt:now,updatedBy:by});
   data.devices[index]=device;await atomic(file,data);
   return {device:normalizeDevice(device),hash,created:false,changed:true};
  });
 };
 // base (optional): the hash the caller read. Returns {device, hadLogin}: hadLogin = a stored Thermo login went with it.
 const remove=(id,{base}={})=>serial(async()=>{
  if(reserved.includes(id))fail('read-only');
  const data=await read(),device=data.devices.find(x=>x.id===id)||fail('not-found');
  if(base!==undefined&&base!==machineHash(normalizeDevice(device)))fail('conflict');
  data.devices=data.devices.filter(x=>x!==device);await atomic(file,data);
  const hadLogin=await saveLogin(id,null);
  const r=await readRuntimes();if(Object.hasOwn(r.stacks,id)){delete r.stacks[id];await atomic(runtimes,r);}
  await rm(imageFile(id),{force:true});return {device:normalizeDevice(device),hadLogin};
 });
 // Connect an existing device to Thermo (login checked by the caller first), or forget its login (thermo = null).
 // The device becomes its own Thermo host: thermoId = its id. Returns {device, thermo: host config or null, hadLogin}.
 const setThermo=(id,input)=>serial(async()=>{
  const data=await read(),index=data.devices.findIndex(x=>x.id===id);if(index<0)fail('not-found');
  const current=normalizeDevice(data.devices[index]);
  const login=input===null?null:parseThermo(input,current.hostname||current.ip||fail('invalid','the device needs a hostname or an IP first'));
  const hadLogin=await saveLogin(id,login);
  const device=stored({...current,thermoId:login?id:current.thermoId===id?null:current.thermoId,updatedAt:new Date().toISOString()});
  data.devices[index]=device;await atomic(file,data);
  return {device:normalizeDevice(device),thermo:login?parseHostsConfig({hosts:[{id,...login}]})[0]:null,hadLogin};
 });
 // The picture arrives as one JPEG (the browser crops and encodes it); at most 3 MiB.
 async function putImage(id,body,declaredLength){
  if(Number.isFinite(declaredLength)&&declaredLength>DEVICE_LIMITS.image)fail('too-large');
  const chunks=[];let size=0;for await(const c of body){size+=c.length;if(size>DEVICE_LIMITS.image)fail('too-large');chunks.push(c);}
  const buf=Buffer.concat(chunks);if(buf.length<4||buf[0]!==0xff||buf[1]!==0xd8||buf[2]!==0xff)fail('invalid');
  return serial(async()=>{
   const data=await read(),device=data.devices.find(x=>x.id===id)||fail('not-found');
   await mkdir(images,{recursive:true,mode:0o700});const tmp=imageFile(id)+'.'+randomUUID();
   try{await writeFile(tmp,buf,{mode:0o600,flag:'wx'});await rename(tmp,imageFile(id));}finally{await rm(tmp,{force:true});}
   device.image=true;device.imageAt=new Date().toISOString();await atomic(file,data);return normalizeDevice(device);
  });
 }
 // Back to a built-in picture: the uploaded one goes.
 const removeImage=id=>serial(async()=>{
  const data=await read(),device=data.devices.find(x=>x.id===id)||fail('not-found');
  await rm(imageFile(id),{force:true});device.image=false;delete device.imageAt;await atomic(file,data);return normalizeDevice(device);
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
 return {list,thermoHosts,add,upsert,remove,setThermo,putImage,removeImage,image,stacks,publishRuntime};
}
