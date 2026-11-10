// Overview → Add device / Edit device / Remove device: one dialog for a machine that is not in the site
// configuration. Three parts: the picture (a built-in one, or your own with a 3:2 frame you move and resize,
// cropped here to JPEG), what the machine is, and telemetry. Telemetry is optional. Connecting Thermo is
// checked before anything is stored: "Check connection" reads the certificate fingerprint without sending
// anything, you confirm it matches the one Thermo shows, and only then the password goes to the server
// (which logs in once, pinned). Every field is checked here first (validateDevice) and again on the server.
import {el} from './views.js';
import {authGuard} from './session-cache.js';
import {t} from './i18n.js';
import {site} from './site.js';

// The built-in pictures (server/home-devices.mjs → PICTURES; tests keep the two lists equal) and their names.
export const PICTURES=Object.freeze(['desktop','laptop','mini','tower','server','nas','router','board','printer','generic']);
const PICTURE_NAMES={desktop:'Stolní počítač',laptop:'Notebook',mini:'Mini počítač',tower:'Tower',server:'Server',nas:'NAS',router:'Router',board:'Jednodeskový počítač',printer:'Tiskárna',generic:'Jiné zařízení'};
const ROLES=[['computer','Počítač'],['nas','NAS'],['router','Router'],['other','Jiné zařízení']];
const ROLE_PICTURE={computer:'desktop',nas:'nas',router:'router',other:'generic'};
const pictureUrl=id=>`/images/generic/${id}.svg`;
const RATIO=3/2,OUT_W=1536;
const HOST=/^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}))*$/,IPV4=/^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

async function post(url,body){
 const lost=authGuard(),r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});lost(r);
 const d=await r.json().catch(()=>({}));
 // The server's message, in the UI language; details name the field (English, from the validator).
 if(!r.ok)throw new Error([d.error?.message?t(d.error.message):t('Požadavek selhal.'),...(Array.isArray(d.error?.details)?d.error.details:[])].join(' '));
 return d;
}
const groups=hex=>hex.toUpperCase().match(/.{2}/g).join(':');

// Is ip a usable host address inside one of the networks ("10.0.0.0/24")? No networks = anything goes.
// The same rule as the server's (site-config.mjs → inCidrs), so the form refuses what the API would.
const ipNumber=ip=>ip.split('.').reduce((n,part)=>n*256+Number(part),0);
export function inNetworks(ip,cidrs=[]){
 if(!IPV4.test(ip))return false;if(!cidrs.length)return true;
 const n=ipNumber(ip);
 return cidrs.some(c=>{const [base,bitsText]=String(c).split('/'),bits=Number(bitsText);if(!IPV4.test(base)||!(bits>=0&&bits<=32))return false;
  const count=2**(32-bits),start=ipNumber(base);if(n<start||n>=start+count)return false;return bits>=31||(n!==start&&n!==start+count-1);});
}
// values: what the form holds, as text. Returns {field: message}; empty = fine.
//   needHost: a hostname is required (a new device; an existing one only when Thermo is being connected)
//   thermo:   the Thermo part is being submitted (port, user, password, checked and confirmed fingerprint)
export function validateDevice(v,{lanCidrs=[],needHost=true,thermo=false}={}){
 const e={},name=v.name.trim(),host=v.hostname.trim(),ip=v.ip.trim();
 if(!name)e.name=t('Vyplň název.');else if(name.length>60)e.name=t('Název má nejvýš 60 znaků.');
 if(!host){if(needHost||thermo)e.hostname=t('Vyplň hostname nebo IP adresu.');}
 else if(!IPV4.test(host)&&!HOST.test(host))e.hostname=t('Hostname smí obsahovat jen písmena, číslice, tečky a pomlčky.');
 if(ip&&!IPV4.test(ip))e.ip=t('IP adresa má tvar čtyř čísel, třeba 10.0.0.30.');
 else if(ip&&!inNetworks(ip,lanCidrs))e.ip=t('Adresa musí být v síti tohoto webu ({networks}).',{networks:lanCidrs.join(', ')});
 const ram=String(v.ramGb??'').trim(),disk=String(v.diskGb??'').trim();
 if(ram&&!(Number(ram)>0&&Number(ram)<=65536))e.ramGb=t('RAM je číslo od 1 do 65536 (GB).');
 if(disk&&!(Number(disk)>0&&Number(disk)<=10000000))e.diskGb=t('Disk je kladné číslo (GB).');
 if((v.cpu||'').trim().length>60)e.cpu=t('Nejvýš 60 znaků.');
 if((v.gpu||'').trim().length>40)e.gpu=t('Nejvýš 40 znaků.');
 if(thermo){
  const port=Number(v.port);
  if(!Number.isInteger(port)||port<1024||port>65535)e.port=t('Port je číslo 1024–65535.');
  if(!(v.username||'').trim())e.username=t('Vyplň uživatele účtu v Thermo.');
  if((v.password||'').length<12)e.password=t('Heslo účtu v Thermo má aspoň 12 znaků.');
  if(!v.fingerprint)e.probe=t('Nejdřív ověř spojení.');else if(!v.confirmed)e.probe=t('Potvrď, že otisk sedí s tím v Thermo.');
 }
 return e;
}

// The picture with a 3:2 frame on top: drag the frame to move it, drag its corner to resize it.
// crop() → a JPEG Blob of what is inside the frame (at most 1536×1024), or null with no picture.
function cropper(onChange=()=>{}){
 let img=null,url=null,frame={x:0,y:0,w:0},drag=null;
 const stage=el('div',{class:'had-stage'}),pic=el('img',{alt:'',draggable:'false'}),box=el('div',{class:'had-frame',tabindex:'0',role:'group','aria-label':t('Výřez obrázku: šipky posouvají, Shift+šipky mění velikost')}),
  handle=el('span',{class:'had-handle'}),empty=el('div',{class:'had-empty'},t('Vyber obrázek — ukáže se tu a rámečkem zvolíš, co bude na dlaždici vidět.'));
 box.append(handle);stage.append(empty);
 const shown=()=>({w:pic.clientWidth,h:pic.clientHeight});
 const clamp=()=>{const s=shown();frame.w=Math.max(40,Math.min(frame.w,s.w,s.h*RATIO));const h=frame.w/RATIO;frame.x=Math.max(0,Math.min(frame.x,s.w-frame.w));frame.y=Math.max(0,Math.min(frame.y,s.h-h));};
 const draw=()=>{clamp();Object.assign(box.style,{left:pic.offsetLeft+frame.x+'px',top:pic.offsetTop+frame.y+'px',width:frame.w+'px',height:frame.w/RATIO+'px'});onChange();};
 // Start with the largest 3:2 frame in the middle; a 3:2 picture is then covered whole.
 const reset=()=>{const s=shown();frame.w=Math.min(s.w,s.h*RATIO);frame.x=(s.w-frame.w)/2;frame.y=(s.h-frame.w/RATIO)/2;draw();};
 box.addEventListener('pointerdown',e=>{e.preventDefault();box.setPointerCapture(e.pointerId);drag={mode:e.target===handle?'size':'move',x:e.clientX,y:e.clientY,f:{...frame}};});
 box.addEventListener('pointermove',e=>{if(!drag)return;const dx=e.clientX-drag.x,dy=e.clientY-drag.y;
  if(drag.mode==='move'){frame.x=drag.f.x+dx;frame.y=drag.f.y+dy;}else{frame.x=drag.f.x;frame.y=drag.f.y;frame.w=drag.f.w+Math.max(dx,dy*RATIO);}draw();});
 const stop=()=>{drag=null;};box.addEventListener('pointerup',stop);box.addEventListener('pointercancel',stop);
 box.addEventListener('keydown',e=>{const k={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[e.key];if(!k)return;e.preventDefault();const step=e.altKey?1:10;
  if(e.shiftKey)frame.w+=(k[0]||-k[1])*step;else{frame.x+=k[0]*step;frame.y+=k[1]*step;}draw();});
 const ro=typeof ResizeObserver==='function'?new ResizeObserver(()=>{if(img&&frame.w)draw();}):null;ro?.observe(stage);
 return {node:stage,
  loaded:()=>Boolean(img),
  async load(file){
   if(url)URL.revokeObjectURL(url);url=URL.createObjectURL(file);
   await new Promise((resolve,reject)=>{pic.onload=resolve;pic.onerror=()=>reject(new Error(t('Tenhle soubor prohlížeč neumí zobrazit jako obrázek.')));pic.src=url;});
   img=pic;stage.replaceChildren(pic,box);reset();box.focus();
  },
  info(){if(!img)return '';const s=shown(),k=pic.naturalWidth/s.w;return `${pic.naturalWidth}×${pic.naturalHeight} → ${t('výřez')} ${Math.round(frame.w*k)}×${Math.round(frame.w/RATIO*k)}`;},
  async crop(){
   if(!img)return null;const s=shown(),k=pic.naturalWidth/s.w,sw=frame.w*k,sh=sw/RATIO,scale=Math.min(1,OUT_W/sw);
   const c=document.createElement('canvas');c.width=Math.round(sw*scale);c.height=Math.round(sh*scale);
   c.getContext('2d').drawImage(pic,frame.x*k,frame.y*k,sw,sh,0,0,c.width,c.height);
   return new Promise(r=>c.toBlob(r,'image/jpeg',0.86));
  },
  dispose(){ro?.disconnect();if(url)URL.revokeObjectURL(url);}};
}

// A labelled input with a place for its error. The error is announced and the input marked invalid.
function field(label,input,hint){
 const error=el('small',{class:'had-err',role:'alert'});
 const set=message=>{error.textContent=message||'';if(message)input.setAttribute('aria-invalid','true');else input.removeAttribute('aria-invalid');};
 input.addEventListener('input',()=>set(''));
 return {node:el('label',{class:'had-field'},el('span',{},label),input,hint?el('small',{class:'had-hint'},hint):null,error),input,set};
}
const input=attrs=>el('input',{autocomplete:'off',spellcheck:'false',...attrs});
const choice=(name,value,checked,title,sub,onchange)=>el('label',{class:'had-choice'},el('input',{type:'radio',name,value,checked:checked?'':null,onchange}),el('span',{},el('b',{},title),sub?el('small',{},sub):null));

// Part 1: the picture. value() → {picture: a built-in id, own: true when a new own picture was chosen,
// keepOwn: true when the uploaded one stays}; crop() → the JPEG of a new own picture.
function picturePart({machine,role}){
 const info=el('span',{class:'had-dim'}),crop=cropper(()=>{info.textContent=crop.info();});
 let picked=machine?.pictureId||null,mode=machine?.image?'own':'builtin';
 const current=()=>picked||ROLE_PICTURE[role()]||'generic';
 const grid=el('div',{class:'had-pictures',role:'radiogroup','aria-label':t('Vestavěné obrázky')});
 const drawGrid=()=>grid.replaceChildren(...PICTURES.map(id=>el('label',{class:'had-picture',title:t(PICTURE_NAMES[id])},
  el('input',{type:'radio',name:'had-picture',value:id,checked:current()===id?'':null,onchange:()=>{picked=id;}}),el('img',{src:pictureUrl(id),alt:''}),el('span',{},t(PICTURE_NAMES[id])))));
 const file=el('input',{type:'file',accept:'image/*','aria-label':t('Vlastní obrázek')});
 const failed=el('small',{class:'had-err',role:'alert'});
 file.addEventListener('change',async()=>{const f=file.files?.[0];if(!f)return;failed.textContent='';try{await crop.load(f);info.textContent=crop.info();}catch(e){failed.textContent=e.message;}});
 const kept=machine?.image?el('div',{class:'had-kept'},el('img',{src:machine.image,alt:''}),el('span',{},t('Teď se používá tenhle nahraný obrázek. Vyber jiný soubor, nebo přepni na vestavěný obrázek.'))):null;
 const own=el('div',{class:'had-own'},kept,el('div',{class:'had-row'},file,info),crop.node,failed,
  el('small',{class:'had-hint'},t('Táhni rámeček, roh mění velikost (nebo šipky, Shift+šipky). Na dlaždici bude přesně to, co je v rámečku (3:2).')));
 const sync=()=>{grid.hidden=mode!=='builtin';own.hidden=mode!=='own';if(mode==='builtin')drawGrid();};
 const modes=el('div',{class:'had-choices',role:'radiogroup','aria-label':t('Druh obrázku')},
  choice('had-picture-mode','builtin',mode==='builtin',t('Vestavěný obrázek'),t('jeden z deseti obecných'),()=>{mode='builtin';sync();}),
  choice('had-picture-mode','own',mode==='own',t('Vlastní obrázek'),t('fotka nebo render, oříznutý na 3:2'),()=>{mode='own';sync();}));
 sync();
 return {node:el('section',{class:'had-sec'},el('h3',{},t('1 · Obrázek')),modes,grid,own),
  roleChanged:()=>{if(mode==='builtin')drawGrid();},
  value:()=>({picture:current(),own:mode==='own'&&crop.loaded(),keepOwn:mode==='own'&&!crop.loaded()&&Boolean(machine?.image)}),
  crop:()=>crop.crop(),dispose:()=>crop.dispose()};
}

// Part 3: connecting Thermo. host() = where to connect (the form's hostname). value() → the fields.
function thermoPart({host,agent}){
 let fingerprint=null;
 const port=input({type:'number',min:'1024',max:'65535',value:'49286',inputmode:'numeric'}),user=input({maxlength:'32',value:'homehub'}),pass=input({type:'password',minlength:'12',maxlength:'256',autocomplete:'new-password'});
 const fields={port:field(t('Port'),port),username:field(t('Uživatel v Thermo'),user),password:field(t('Heslo v Thermo'),pass,t('aspoň 12 znaků; uloží se jen na serveru'))};
 const out=el('div',{class:'had-probe',hidden:''}),confirm=el('input',{type:'checkbox'}),message=el('small',{class:'had-err',role:'alert'});
 const reset=()=>{fingerprint=null;out.hidden=true;out.replaceChildren();confirm.checked=false;};
 port.addEventListener('input',reset);
 const probe=el('button',{type:'button',class:'ui-button',onclick:async()=>{
  reset();message.textContent='';
  if(!host())return void(message.textContent=t('Nejdřív vyplň hostname nebo IP.'));
  probe.disabled=true;probe.textContent=t('Zkouším spojení…');
  try{const r=await post('/api/home/devices/probe',{host:host(),port:Number(port.value)||49286});fingerprint=r.fingerprint;
   out.replaceChildren(el('div',{class:'had-dim'},t('Thermo odpovídá. Otisk certifikátu (SHA-256):')),el('code',{class:'had-fp'},groups(r.fingerprint)),
    r.subject?el('div',{class:'had-dim'},`CN ${r.subject}${r.validTo?' · '+t('platí do')+' '+r.validTo:''}`):null,
    el('label',{class:'had-check'},confirm,t('Otisk sedí s tím, co ukazuje Thermo na tom zařízení (Nastavení → Síť).')));out.hidden=false;}
  catch(e){message.textContent=e.message;}finally{probe.disabled=false;probe.textContent=t('Ověřit spojení');}}},t('Ověřit spojení'));
 const needs=el('ol',{class:'had-needs'},
  el('li',{},t('Na zařízení běží {name} a má zapnutý přístup po síti (výchozí port 49286).',{name:agent})),
  el('li',{},t('V {name} je účet pro Home Hub: uživatel (třeba homehub) a heslo aspoň 12 znaků. Heslo se uloží jen na serveru (soubor 0600), ne do prohlížeče ani gitu.',{name:agent})),
  el('li',{},t('Home Hub na zařízení dosáhne: hostname nebo IP v domácí síti, port povolený ve firewallu.')),
  el('li',{},t('Ověř spojení a porovnej otisk certifikátu s tím, co ukazuje {name}. Heslo pak chodí jen na tenhle certifikát.',{name:agent})));
 return {node:el('fieldset',{class:'had-thermo'},el('legend',{},agent),needs,
   el('div',{class:'had-grid'},fields.port.node,fields.username.node,fields.password.node),el('div',{class:'had-row'},probe,message),out),
  reset,fields,setProbe:text=>{message.textContent=text||'';},
  value:()=>({port:port.value,username:user.value,password:pass.value,fingerprint,confirmed:confirm.checked}),
  body:()=>({port:Number(port.value)||49286,username:user.value.trim(),password:pass.value,pin:fingerprint}),
  clear:()=>{pass.value='';}};
}

// machine = null adds a device; a machine from /api/home (added:true) edits it. meta = /api/home → telemetry.
// focus: 'telemetry' opens with the Thermo part chosen. onSaved() after everything asked for is stored.
function deviceDialog({machine=null,meta,focus,onSaved}){
 const adding=!machine,agent=meta?.agent||'Thermo',lan=site().lanCidrs||[];
 const p=machine?.props||{},connected=Boolean(machine&&machine.telemetry?.thermoId===machine.id&&machine.telemetry?.reason!=='no-login');
 let hash=machine?.hash||null,wantThermo=!connected&&focus==='telemetry';
 const status=el('p',{class:'had-msg',role:'status'});
 const say=(text,error=false)=>{status.textContent=text||'';status.classList.toggle('error',error);};
 const name=input({required:'',maxlength:'60',placeholder:t('Mac mini (pracovna)'),value:machine?.name||''}),host=input({maxlength:'253',placeholder:'mini.example.lan',value:machine?.hostname||''}),
  ip=input({maxlength:'15',placeholder:'10.0.0.30',inputmode:'decimal',value:machine?.ip||''}),cpu=input({maxlength:'60',placeholder:'10c M4',value:p.cpu||''}),gpu=input({maxlength:'40',placeholder:'10c',value:p.gpu&&p.gpu!=='—'?p.gpu:''}),
  ram=input({type:'number',min:'1',max:'65536',step:'1',placeholder:'32',value:p.ramGb??''}),disk=input({type:'number',min:'1',step:'1',placeholder:'1000',value:p.diskTotalBytes?Math.round(p.diskTotalBytes/1e9):''});
 const role=el('select',{},ROLES.map(([id,label])=>el('option',{value:id,selected:(machine?.role||'computer')===id?'':null},t(label))));
 const picture=picturePart({machine,role:()=>role.value});
 role.addEventListener('change',()=>picture.roleChanged());
 const thermo=thermoPart({host:()=>host.value.trim()||ip.value.trim(),agent});
 host.addEventListener('input',()=>thermo.reset());
 const fields={name:field(t('Název'),name),hostname:field(t('Hostname nebo IP'),host,adding?null:t('kde je stroj v síti k zastižení')),
  ip:field(t('IP adresa'),ip,lan.length?t('v síti {networks}',{networks:lan.join(', ')}):t('když výše je jméno')),role:field(t('Role'),role),
  cpu:field(t('CPU'),cpu),gpu:field(t('GPU'),gpu),ramGb:field(t('RAM (GB)'),ram),diskGb:field(t('Disk (GB)'),disk)};
 // Telemetry: a new or unconnected device chooses; a connected one can be disconnected.
 const none=el('p',{class:'had-note'},t('Zařízení dostane dlaždici s obrázkem, adresou a parametry. Telemetrii ({name}) připojíš kdykoli později tady v úpravě zařízení.',{name:agent}));
 const sync=()=>{thermo.node.hidden=!wantThermo;none.hidden=wantThermo;};
 const disconnect=el('button',{type:'button',class:'ui-button hv-danger',onclick:async()=>{
  if(!await confirmDialog({title:t('Odpojit telemetrii?'),body:t('Home Hub zapomene účet {name} tohoto zařízení a přestane z něj číst. Historie metrik zůstane na disku.',{name:agent}),confirm:t('Odpojit'),danger:true,
   action:()=>post('/api/home/devices/thermo',{id:machine.id,thermo:null})}))return;
  dialog.close();onSaved?.();}},t('Odpojit telemetrii'));
 const telemetry=connected
  ?el('section',{class:'had-sec'},el('h3',{},t('3 · Telemetrie')),el('p',{class:'had-note'},t('Zařízení je připojené k {name}. Jiné heslo nebo certifikát: odpoj a připoj znovu.',{name:agent})),el('div',{class:'had-row'},disconnect))
  :el('section',{class:'had-sec',id:'had-telemetry'},el('h3',{},t('3 · Telemetrie')),
   el('div',{class:'had-choices',role:'radiogroup','aria-label':t('Telemetrie')},
    choice('had-telemetry','none',!wantThermo,t('Zatím bez telemetrie'),t('dlaždice s údaji, bez živých čísel'),()=>{wantThermo=false;sync();}),
    choice('had-telemetry','thermo',wantThermo,t('Připojit {name}',{name:agent}),t('živé CPU, GPU, paměť, příkon a teploty'),()=>{wantThermo=true;sync();})),
   thermo.node,none);
 sync();
 const save=el('button',{type:'submit',class:'ui-button primary'},adding?t('Přidat zařízení'):t('Uložit'));
 const values=()=>({name:name.value,hostname:host.value,ip:ip.value,cpu:cpu.value,gpu:gpu.value,ramGb:ram.value,diskGb:disk.value,...thermo.value()});
 function check(){
  const errors=validateDevice(values(),{lanCidrs:lan,needHost:adding,thermo:wantThermo&&!connected});
  for(const [key,f] of Object.entries({...fields,...thermo.fields}))f.set(errors[key]);
  thermo.setProbe(errors.probe);
  const first=Object.keys(errors)[0];
  if(first){({...fields,...thermo.fields})[first]?.input.focus();say(t('Zkontroluj označená pole.'),true);}
  return !first;
 }
 const hardware=()=>({cpu:cpu.value.trim(),gpu:gpu.value.trim(),ramGb:ram.value?Number(ram.value):null,diskTotalBytes:disk.value?Math.round(Number(disk.value)*1e9):null});
 async function upload(id){
  const jpeg=await picture.crop();if(!jpeg)return;
  say(t('Nahrávám obrázek…'));const lost=authGuard(),r=await fetch(`/api/home/devices/${id}/image`,{method:'PUT',headers:{'Content-Type':'image/jpeg'},body:jpeg});lost(r);
  if(!r.ok){const d=await r.json().catch(()=>({}));throw new Error(t('Zařízení je uložené, ale obrázek se neuložil: {why}',{why:d.error?.message?t(d.error.message):r.status}));}
 }
 async function submit(){
  const pic=picture.value();
  if(adding){
   say(wantThermo?t('Přihlašuji se do Thermo a ukládám…'):t('Ukládám…'));
   const device=await post('/api/home/devices',{name:name.value.trim(),kind:wantThermo?'thermo':'other',hostname:host.value.trim(),...(ip.value.trim()?{ip:ip.value.trim()}:{}),role:role.value,picture:pic.picture,props:hardware(),
    ...(wantThermo?{thermo:thermo.body()}:{})});thermo.clear();
   // The device exists from here on: a failed picture upload must not ask to add it again.
   try{if(pic.own)await upload(device.id);}finally{onSaved?.(device);}
   return;
  }
  say(t('Ukládám…'));
  const saved=await post('/api/home/machines',{machine:{id:machine.id,name:name.value.trim(),hostname:host.value.trim(),ip:ip.value.trim()||null,role:role.value,hardware:hardware(),thermoId:machine.telemetry?.thermoId??null,picture:pic.picture},...(hash?{base:hash}:{})});
  hash=saved.hash;
  try{
   if(pic.own)await upload(machine.id);
   else if(machine.image&&!pic.keepOwn)await post('/api/home/devices/image/remove',{id:machine.id});
   if(wantThermo&&!connected){say(t('Přihlašuji se do Thermo a ukládám…'));await post('/api/home/devices/thermo',{id:machine.id,thermo:thermo.body()});thermo.clear();}
  }finally{onSaved?.();}
 }
 const form=el('form',{class:'had-form',novalidate:'',onsubmit:async e=>{
  e.preventDefault();if(!check())return;
  save.disabled=true;
  try{await submit();dialog.close();}catch(err){say(err.message,true);save.disabled=false;}
 }},
  picture.node,
  el('section',{class:'had-sec'},el('h3',{},t('2 · Co to je')),
   el('div',{class:'had-grid two'},fields.name.node,fields.role.node,fields.hostname.node,fields.ip.node),
   el('div',{class:'had-grid four'},fields.cpu.node,fields.gpu.node,fields.ramGb.node,fields.diskGb.node)),
  telemetry,
  el('div',{class:'had-foot'},status,el('div',{class:'had-actions'},el('button',{type:'button',class:'ui-button',onclick:()=>dialog.close()},t('Zrušit')),save)));
 const title=el('h2',{id:'had-title'},adding?t('Přidat zařízení'):t('Upravit zařízení'));
 const dialog=el('dialog',{class:'had','aria-labelledby':'had-title'},
  el('div',{class:'had-head'},el('div',{},title,el('p',{class:'had-dim'},adding?t('Zařízení se objeví jako další dlaždice v přehledu.'):t('{name} · id {id}',{name:machine.name,id:machine.id}))),
   el('button',{type:'button',class:'had-close','aria-label':t('Zavřít'),onclick:()=>dialog.close()},'×')),form);
 dialog.addEventListener('close',()=>{thermo.clear();picture.dispose();dialog.remove();});
 document.body.append(dialog);dialog.showModal();
 if(focus==='telemetry')dialog.querySelector('#had-telemetry')?.scrollIntoView?.({block:'start'});else name.focus();
 return dialog;
}
export const openAddDevice=({meta,onSaved})=>deviceDialog({meta,onSaved});
export const openEditDevice=({machine,meta,focus,onSaved})=>deviceDialog({machine,meta,focus,onSaved});

// A small "are you sure" dialog. action (optional) runs on confirm while the dialog stays open and shows
// what went wrong; resolves true once confirmed (and the action succeeded), false when dismissed.
export function confirmDialog({title,body,confirm,danger=false,action}){
 return new Promise(resolve=>{
  let done=false;
  const message=el('p',{class:'had-msg error',role:'alert'});
  const yes=el('button',{type:'button',class:`ui-button ${danger?'hv-danger':'primary'}`,onclick:async()=>{
   yes.disabled=true;message.textContent='';
   try{await action?.();done=true;dialog.close();}catch(e){message.textContent=e.message;yes.disabled=false;}}},confirm);
  const dialog=el('dialog',{class:'had small','aria-labelledby':'had-confirm-title'},el('h2',{id:'had-confirm-title'},title),el('p',{class:'had-note'},body),message,
   el('div',{class:'had-actions'},el('button',{type:'button',class:'ui-button',onclick:()=>dialog.close()},t('Zrušit')),yes));
  dialog.addEventListener('close',()=>{dialog.remove();resolve(done);});
  document.body.append(dialog);dialog.showModal();
 });
}
// Removing an added device (its page → Remove device). Machines from the site configuration cannot be removed.
export const removeDevice=machine=>confirmDialog({title:t('Odebrat {name}?',{name:machine.name}),danger:true,confirm:t('Odebrat zařízení'),
 body:t('Zmizí z přehledu i se svým obrázkem, uloženým přihlášením do Thermo a zveřejněným runtime stackem. Historie metrik zůstane na disku.'),
 action:()=>post('/api/home/machines/remove',{id:machine.id,base:machine.hash})});
