// Devices added on the Home page (Přehled → ⊕ Přidat zařízení). Built-in machines stay in home-data.mjs.
//   state/home/devices.json       the tiles: id, name, kind, hostname, ip, props (no secrets)
//   state/home/thermo-hosts.json  0600: the Thermo account a "thermo" device logs in with (password, pinned cert)
//   state/home/images/<id>.jpg    the tile picture, cropped to 3:2 in the browser
// Writes go through one queue and an atomic rename. Errors: Error('invalid' | 'not-found' | 'conflict' | 'limit' | 'too-large').
import {mkdir,readFile,writeFile,rename,rm,open} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {parseHostsConfig} from './thermo-client.mjs';

export const DEVICE_ID=/^[a-z][a-z0-9_-]{1,31}$/;
export const DEVICE_KINDS=Object.freeze(['thermo','other']);
export const DEVICE_LIMITS=Object.freeze({devices:20,image:3*1024*1024});
const HOST=/^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}))*$/,IPV4=/^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const fail=code=>{throw new Error(code);};
const plain=x=>x&&typeof x==='object'&&!Array.isArray(x);
const onlyKeys=(x,keys)=>plain(x)&&Object.keys(x).every(k=>keys.includes(k));
const text=(v,max,{empty=true}={})=>{if(v===undefined||v===null)return '';if(typeof v!=='string')fail('invalid');const t=v.replace(/[\u0000-\u001f\u007f]/g,'').trim();if(t.length>max||(!empty&&!t))fail('invalid');return t;};
export const validHost=h=>typeof h==='string'&&(IPV4.test(h)||HOST.test(h));
const port=v=>v===undefined||v===null?49286:Number.isSafeInteger(v)&&v>=1024&&v<=65535?v:fail('invalid');
// "Mac Studio 2" → "mac-studio-2"; diacritics dropped, never one of the taken ids.
export function deviceId(name,taken){
 const base=(name.normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').replace(/^[^a-z]+/,'')||'device').slice(0,28).replace(/-+$/,'')||'device';
 let id=DEVICE_ID.test(base)?base:'device-'+base;id=id.slice(0,28);for(let n=2;taken.includes(id);n++)id=`${base.slice(0,26)}-${n}`;return id;
}

export function createHomeDevices(root,{reserved=[]}={}){
 const file=path.join(root,'devices.json'),secrets=path.join(root,'thermo-hosts.json'),images=path.join(root,'images');
 let queue=Promise.resolve();
 const readJson=async(f,empty)=>{try{return JSON.parse(await readFile(f,'utf8'));}catch(e){if(e.code==='ENOENT')return empty();throw e;}};
 const read=async()=>{const d=await readJson(file,()=>({schema:1,devices:[]}));if(d?.schema!==1||!Array.isArray(d.devices))throw new Error('Invalid devices file');return d;};
 const atomic=async(f,value)=>{await mkdir(root,{recursive:true,mode:0o700});const tmp=f+'.'+randomUUID();
  try{await writeFile(tmp,JSON.stringify(value,null,1)+'\n',{mode:0o600,flag:'wx'});await rename(tmp,f);}finally{await rm(tmp,{force:true});}};
 const serial=fn=>{const run=queue.then(fn);queue=run.catch(()=>{});return run;};
 const imageFile=id=>DEVICE_ID.test(id)?path.join(images,id+'.jpg'):fail('invalid');

 async function list(){return (await read()).devices;}
 // Thermo logins of added devices, in the same shape as private/thermo-hosts.json.
 async function thermoHosts(){return parseHostsConfig(await readJson(secrets,()=>({hosts:[]})));}
 // input: {name, kind, hostname, ip?, props?{cpu,gpu,ramGb}, thermo?{port, username, password, pin}}
 // Returns {device, thermo: the host config or null}. The caller checks the Thermo login before calling.
 function parse(input){
  if(!onlyKeys(input,['name','kind','hostname','ip','props','thermo']))fail('invalid');
  const name=text(input.name,60,{empty:false}),kind=DEVICE_KINDS.includes(input.kind)?input.kind:fail('invalid');
  const hostname=text(input.hostname,253,{empty:false});if(!validHost(hostname))fail('invalid');
  const ip=text(input.ip,15);if(ip&&!IPV4.test(ip))fail('invalid');
  const p=input.props??{};if(!onlyKeys(p,['cpu','gpu','ramGb']))fail('invalid');
  const ramGb=p.ramGb===undefined||p.ramGb===null||p.ramGb===''?null:Number.isFinite(p.ramGb)&&p.ramGb>0&&p.ramGb<=65536?p.ramGb:fail('invalid');
  const props={cpu:text(p.cpu,60),gpu:text(p.gpu,40),ramGb};
  let thermo=null;
  if(kind==='thermo'){
   const t=input.thermo;if(!onlyKeys(t,['port','username','password','pin']))fail('invalid');
   const pin=typeof t.pin==='string'?t.pin.replace(/:/g,'').toLowerCase():'';if(!/^[a-f0-9]{64}$/.test(pin))fail('invalid');
   if(typeof t.password!=='string'||t.password.length<12||t.password.length>256)fail('invalid');
   const username=text(t.username,32,{empty:false});
   thermo={host:hostname,port:port(t.port),username,label:'home-hub',password:t.password,pin};
  }else if(input.thermo!==undefined)fail('invalid');
  return {name,kind,hostname,ip:ip||null,props,thermo};
 }
 const add=(input,by)=>{
  const d=parse(input);
  return serial(async()=>{
   const data=await read();if(data.devices.length>=DEVICE_LIMITS.devices)fail('limit');
   if(data.devices.some(x=>x.hostname.toLowerCase()===d.hostname.toLowerCase()))fail('conflict');
   const id=deviceId(d.name,[...reserved,...data.devices.map(x=>x.id)]);
   const device={id,name:d.name,kind:d.kind,hostname:d.hostname,ip:d.ip,props:d.props,image:false,createdAt:new Date().toISOString(),createdBy:by};
   let thermo=null;
   if(d.thermo){thermo={id,...d.thermo};const s=await readJson(secrets,()=>({hosts:[]}));s.hosts=[...(s.hosts||[]).filter(h=>h.id!==id),thermo];await atomic(secrets,s);}
   data.devices.push(device);await atomic(file,data);
   return {device,thermo:thermo?parseHostsConfig({hosts:[thermo]})[0]:null};
  });
 };
 const remove=id=>serial(async()=>{
  const data=await read(),device=data.devices.find(x=>x.id===id)||fail('not-found');
  data.devices=data.devices.filter(x=>x!==device);await atomic(file,data);
  const s=await readJson(secrets,()=>({hosts:[]}));if((s.hosts||[]).some(h=>h.id===id)){s.hosts=s.hosts.filter(h=>h.id!==id);await atomic(secrets,s);}
  await rm(imageFile(id),{force:true});return device;
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
   device.image=true;device.imageAt=new Date().toISOString();await atomic(file,data);return device;
  });
 }
 async function image(id){if(!DEVICE_ID.test(id))fail('not-found');try{const fh=await open(imageFile(id),'r');await fh.close();return imageFile(id);}catch{fail('not-found');}}
 return {list,thermoHosts,add,remove,putImage,image};
}
