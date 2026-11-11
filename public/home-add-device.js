// Overview → Add device / Edit device / Remove device: one dialog for a machine that is not in the site
// configuration. Three parts: the picture (a built-in one, or your own with a 3:2 frame you move and resize,
// cropped here to JPEG), what the machine is, and telemetry. Telemetry is optional, and the choices come
// from the server: /api/home → telemetry.adapters lists the agents this hub can connect a device to, and
// each one that has a form here (ADAPTER_FORMS) is offered. Connecting Thermo is checked before anything
// is stored: "Check connection" reads the certificate fingerprint without sending anything, you confirm it
// matches the one Thermo shows, and only then the password goes to the server (which logs in once, pinned).
// Windows needs no agent: the hub reads it over key-only SSH with a key of its own. The dialog asks for host, port
// and Windows user, makes or imports the key on the server, shows the one PowerShell step for Windows, lets the
// person verify the host key, and "Test connection" runs the read-only collector once; only a connection whose
// test matches what the form shows can be saved. Which system the hub or the browser runs on does not matter.
// An existing device is connected, changed or disconnected in place; an older alias connection keeps working
// until it is converted here.
// The operating system (platform) is chosen apart from the role.
// Every field is checked here first (validateDevice) and again on the server.
import {el} from './views.js';
import {authGuard} from './session-cache.js';
import {t,tp} from './i18n.js';
import {site} from './site.js';
import {authorizeScript,counterScript,INSTALL_SCRIPT,FINGERPRINT_SCRIPT,validWindowsUser} from './windows-setup.js';
import {linuxAuthorizeScript,linuxAccountScript,LINUX_FINGERPRINT_SCRIPT,validUnixUser,winrmListenerScript,winrmAccountScript,WINRM_FINGERPRINT_SCRIPT,
 NODE_EXPORTER_PACKAGES,nodeExporterManual,nodeExporterFirewall,nodeExporterTls,prometheusScrape,PROMETHEUS_DOCKER} from './telemetry-setup.js';

// The built-in pictures (server/home-devices.mjs → PICTURES; tests keep the two lists equal) and their names.
export const PICTURES=Object.freeze(['desktop','laptop','mini','tower','server','nas','router','board','printer','generic']);
const PICTURE_NAMES={desktop:'Stolní počítač',laptop:'Notebook',mini:'Mini počítač',tower:'Tower',server:'Server',nas:'NAS',router:'Router',board:'Jednodeskový počítač',printer:'Tiskárna',generic:'Jiné zařízení'};
const ROLES=[['computer','Počítač'],['nas','NAS'],['router','Router'],['other','Jiné zařízení']];
const ROLE_PICTURE={computer:'desktop',nas:'nas',router:'router',other:'generic'};
// server/home-devices.mjs → PLATFORMS; '' = not said (null).
const PLATFORMS=[['','Neuvedeno'],['macos','macOS'],['windows','Windows'],['linux','Linux'],['other','Jiný systém']];
// The same rule as the server's (server/windows-telemetry.mjs → validSshTarget): an alias or user@host,
// nothing that could start with "-" or carry shell or ssh syntax. Only older alias connections use it.
const TARGET=/^(?:([A-Za-z0-9_][A-Za-z0-9._-]{0,63})@)?([A-Za-z0-9](?:[A-Za-z0-9._-]{0,251}[A-Za-z0-9])?)$/;
export const validTarget=v=>typeof v==='string'&&v.length<=320&&TARGET.test(v)&&!v.includes('..');
const pictureUrl=id=>`/images/generic/${id}.svg`;
const validHostName=h=>typeof h==='string'&&(IPV4.test(h)||HOST.test(h));
const validPort=p=>Number.isInteger(p)&&p>=1&&p<=65535;
const RATIO=3/2,OUT_W=1536;
const HOST=/^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}))*$/,IPV4=/^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

async function post(url,body){
 const lost=authGuard(),r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});lost(r);
 const d=await r.json().catch(()=>({}));
 // The server's message, in the UI language; details name the field (English, from the validator).
 // reason: the server's code for a refused Windows step (WINDOWS_SSH_FAILED / WINDOWS_SETUP_FAILED), so the form can react to it.
 if(!r.ok)throw Object.assign(new Error([d.error?.message?t(d.error.message):t('Požadavek selhal.'),...(Array.isArray(d.error?.details)?d.error.details:[])].join(' ')),{code:d.error?.code||null,reason:d.error?.reason||null});
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
//   windows:  the Windows part is being submitted: host, port and user valid, a key, a confirmed host key, and a
//             test that ran with exactly these values (windowsTested = windowsSignature of them)
//   feed:     another provider's part is being submitted: its own check (a part's errors(), {field: message})
export function validateDevice(v,{lanCidrs=[],needHost=true,thermo=false,windows=false,feed=null}={}){
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
 if(windows){
  Object.assign(e,windowsErrors(v));
  if(!e.whost&&!e.wport&&!e.wuser){
   if(!v.windowsKey)e.windowsTest=t('Nejdřív vytvoř nebo naimportuj klíč.');
   else if(!v.windowsTrusted)e.windowsTest=t('Nejdřív načti a potvrď klíč hostitele.');
   else if(v.windowsTested!==windowsSignature(v))e.windowsTest=t('Nejdřív vyzkoušej spojení s tímhle nastavením.');
  }
 }
 if(typeof feed==='function')Object.assign(e,feed());
 return e;
}
// Host, port and Windows user of a managed connection; the same rules as the server's.
export function windowsErrors(v,{os='windows'}={}){
 const e={},host=String(v.whost||'').trim(),port=String(v.wport??'').trim(),user=String(v.wuser||'').trim();
 if(os==='linux'){
  if(!host)e.whost=t('Vyplň host: jméno nebo IP adresu stroje.');else if(!validHostName(host))e.whost=t('Hostname smí obsahovat jen písmena, číslice, tečky a pomlčky.');
  if(!validPort(Number(port))||!/^\d+$/.test(port))e.wport=t('Port je číslo 1–65535.');
  if(!user)e.wuser=t('Vyplň uživatele na Linuxu.');else if(!validUnixUser(user))e.wuser=t('Jméno účtu Linuxu: písmeno nebo podtržítko, pak písmena, číslice, tečka, podtržítko a pomlčka; nejvýš 32 znaků.');
  return e;
 }
 if(!host)e.whost=t('Vyplň host: jméno nebo IP adresu Windows.');else if(!validHostName(host))e.whost=t('Hostname smí obsahovat jen písmena, číslice, tečky a pomlčky.');
 if(!validPort(Number(port))||!/^\d+$/.test(port))e.wport=t('Port je číslo 1–65535.');
 if(!user)e.wuser=t('Vyplň uživatele ve Windows.');else if(!validWindowsUser(user))e.wuser=t('Jméno účtu Windows: písmena, číslice, mezera, tečka, podtržítko a pomlčka; volitelně DOMÉNA\\jméno nebo jméno@doména. Bez uvozovek a znaků jako % nebo $.');
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
// keepOwn: true when the uploaded one stays, site: the site's own picture is kept}; crop() → the JPEG of a new own picture.
// site: a machine of the site configuration, which has a third choice, the picture its site gives it (the default); its
// uploaded picture is the one of its override (siteOverride.image), never the site's own file.
function picturePart({machine,role,site=false}){
 const info=el('span',{class:'had-dim'}),crop=cropper(()=>{info.textContent=crop.info();});
 const hadOwn=site?machine?.siteOverride?.image===true:Boolean(machine?.image);
 let picked=machine?.pictureId||null,mode=hadOwn?'own':site&&!machine?.siteOverride?.fields?.includes('picture')?'site':'builtin';
 const current=()=>picked||ROLE_PICTURE[role()]||'generic';
 const grid=el('div',{class:'had-pictures',role:'radiogroup','aria-label':t('Vestavěné obrázky')});
 const drawGrid=()=>grid.replaceChildren(...PICTURES.map(id=>el('label',{class:'had-picture',title:t(PICTURE_NAMES[id])},
  el('input',{type:'radio',name:'had-picture',value:id,checked:current()===id?'':null,onchange:()=>{picked=id;}}),el('img',{src:pictureUrl(id),alt:''}),el('span',{},t(PICTURE_NAMES[id])))));
 const file=el('input',{type:'file',accept:'image/*','aria-label':t('Vlastní obrázek')});
 const failed=el('small',{class:'had-err',role:'alert'});
 file.addEventListener('change',async()=>{const f=file.files?.[0];if(!f)return;failed.textContent='';try{await crop.load(f);info.textContent=crop.info();}catch(e){failed.textContent=e.message;}});
 const kept=hadOwn?el('div',{class:'had-kept'},el('img',{src:machine.image,alt:''}),el('span',{},t('Teď se používá tenhle nahraný obrázek. Vyber jiný soubor, nebo přepni na vestavěný obrázek.'))):null;
 const sitePic=site?machine?.siteDefaults?.image||machine?.siteDefaults?.picture||null:null;
 const fromSite=site?el('div',{class:'had-kept'},sitePic?el('img',{src:sitePic,alt:''}):null,el('span',{},t('Obrázek, který stroji dává konfigurace webu (local/site.json).'))):null;
 const own=el('div',{class:'had-own'},kept,el('div',{class:'had-row'},file,info),crop.node,failed,
  el('small',{class:'had-hint'},t('Táhni rámeček, roh mění velikost (nebo šipky, Shift+šipky). Na dlaždici bude přesně to, co je v rámečku (3:2).')));
 const sync=()=>{grid.hidden=mode!=='builtin';own.hidden=mode!=='own';if(fromSite)fromSite.hidden=mode!=='site';if(mode==='builtin')drawGrid();};
 const modes=el('div',{class:'had-choices',role:'radiogroup','aria-label':t('Druh obrázku')},
  site?choice('had-picture-mode','site',mode==='site',t('Z konfigurace webu'),t('výchozí obrázek stroje'),()=>{mode='site';sync();}):null,
  choice('had-picture-mode','builtin',mode==='builtin',t('Vestavěný obrázek'),t('jeden z deseti obecných'),()=>{mode='builtin';sync();}),
  choice('had-picture-mode','own',mode==='own',t('Vlastní obrázek'),t('fotka nebo render, oříznutý na 3:2'),()=>{mode='own';sync();}));
 sync();
 return {node:el('section',{class:'had-sec'},el('h3',{},t('1 · Obrázek')),modes,fromSite,grid,own),
  roleChanged:()=>{if(mode==='builtin')drawGrid();},
  hadOwn,
  value:()=>({picture:mode==='site'?null:current(),own:mode==='own'&&crop.loaded(),keepOwn:mode==='own'&&!crop.loaded()&&hadOwn,site:mode==='site'||(mode==='own'&&!crop.loaded()&&!hadOwn)}),
  crop:()=>crop.crop(),dispose:()=>crop.dispose()};
}

// Part 3: connecting Thermo. host() = where to connect (the form's hostname). value() → the fields.
function thermoPart({host,agent,defaultPort=49286}){
 let fingerprint=null;
 const port=input({type:'number',min:'1024',max:'65535',value:String(defaultPort),inputmode:'numeric'}),user=input({maxlength:'32',value:'homehub'}),pass=input({type:'password',minlength:'12',maxlength:'256',autocomplete:'new-password'});
 const fields={port:field(t('Port'),port),username:field(t('Uživatel v Thermo'),user),password:field(t('Heslo v Thermo'),pass,t('aspoň 12 znaků; uloží se jen na serveru'))};
 const out=el('div',{class:'had-probe',hidden:''}),confirm=el('input',{type:'checkbox'}),message=el('small',{class:'had-err',role:'alert'});
 const reset=()=>{fingerprint=null;out.hidden=true;out.replaceChildren();confirm.checked=false;};
 port.addEventListener('input',reset);
 const probe=el('button',{type:'button',class:'ui-button',onclick:async()=>{
  reset();message.textContent='';
  if(!host())return void(message.textContent=t('Nejdřív vyplň hostname nebo IP.'));
  probe.disabled=true;probe.textContent=t('Zkouším spojení…');
  try{const r=await post('/api/home/devices/probe',{host:host(),port:Number(port.value)||defaultPort});fingerprint=r.fingerprint;
   out.replaceChildren(el('div',{class:'had-dim'},t('Thermo odpovídá. Otisk certifikátu (SHA-256):')),el('code',{class:'had-fp'},groups(r.fingerprint)),
    r.subject?el('div',{class:'had-dim'},`CN ${r.subject}${r.validTo?' · '+t('platí do')+' '+r.validTo:''}`):null,
    el('label',{class:'had-check'},confirm,t('Otisk sedí s tím, co ukazuje Thermo na tom zařízení (Nastavení → Síť).')));out.hidden=false;}
  catch(e){message.textContent=e.message;}finally{probe.disabled=false;probe.textContent=t('Ověřit spojení');}}},t('Ověřit spojení'));
 const needs=el('ol',{class:'had-needs'},
  el('li',{},t('{name} na zařízení běží a má zapnutý přístup po síti (výchozí port {port}).',{name:agent,port:defaultPort})),
  el('li',{},t('V {name} je účet pro Home Hub: uživatel a heslo aspoň 12 znaků. Heslo se uloží jen na serveru Home Hubu.',{name:agent})),
  el('li',{},t('Po ověření spojení porovnej otisk certifikátu s tím, který ukazuje {name}. Heslo pak jde jen na tenhle certifikát.',{name:agent})));
 return {node:el('fieldset',{class:'had-thermo'},el('legend',{},agent),needs,
   el('div',{class:'had-grid'},fields.port.node,fields.username.node,fields.password.node),el('div',{class:'had-row'},probe,message),out),
  reset,fields,setProbe:text=>{message.textContent=text||'';},
  value:()=>({port:port.value,username:user.value,password:pass.value,fingerprint,confirmed:confirm.checked}),
  body:()=>({port:Number(port.value)||defaultPort,username:user.value.trim(),password:pass.value,pin:fingerprint}),
  clear:()=>{pass.value='';}};
}
// The telemetry agents this dialog can connect, by adapter id. The server lists what the hub supports
// (/api/home → telemetry.adapters, server/home-data.mjs → TELEMETRY_ADAPTERS); an adapter is offered when
// both know it. A server from before the list is taken to support the one agent it names.
// Part 3 for Windows: an SSH connection the hub manages itself. host() = the form's hostname or IP (the default
// for the SSH host until it is edited), machineId = the device being edited (null when adding), current = how it
// is read now (/api/home → telemetry.connection: {mode:"managed", host, port, user, …} or {mode:"alias", target}),
// onFacts(result) = what the test found. The connection is built step by step in a server-side draft (key, host
// key, trust, test; server/windows-ssh.mjs); the browser never holds a private key after sending one, and only a
// draft whose test matches what the form shows can be saved. Closing the dialog discards the draft.
const code=text=>el('pre',{class:'had-code'},el('code',{},text));
const GB=1e9,GiB=1073741824;
// A block of text to copy, with a button. Falls back to selecting it where the clipboard is not allowed.
function copyable(label,text,hint){
 const pre=code(text),said=el('small',{class:'had-dim',role:'status'});
 const button=el('button',{type:'button',class:'ui-button','aria-label':t('Kopírovat: {what}',{what:label}),onclick:async()=>{
  try{await navigator.clipboard.writeText(text);said.textContent=t('Zkopírováno.');}
  catch{try{const range=document.createRange();range.selectNodeContents(pre);const sel=getSelection();sel.removeAllRanges();sel.addRange(range);}catch{}said.textContent=t('Označeno: zkopíruj klávesami Ctrl+C.');}}},t('Kopírovat'));
 return el('div',{class:'had-copy'},el('div',{class:'had-row'},el('b',{},label),button,said),hint?el('small',{class:'had-hint'},hint):null,pre);
}
export const windowsSignature=v=>[String(v.whost||'').trim().toLowerCase(),String(v.wport||'').trim(),String(v.wuser||'').trim()].join('|');
// os "linux": the same steps for Linux over SSH (POSIX user, ~/.ssh/authorized_keys, the read-only /proc collector),
// through /api/home/devices/ssh/… with {os:"linux"}.
function windowsPart({host,machineId=null,current=null,onFacts=()=>{},os='windows'}){
 const linux=os==='linux',base=linux?'/api/home/devices/ssh':'/api/home/devices/windows',validUser=linux?validUnixUser:validWindowsUser;
 const created=()=>linux?(machineId?{id:machineId,os}:{os}):machineId?{id:machineId}:{};
 const managed=current?.mode==='managed'?current:null,alias=current?.mode==='alias'?current.target:null;
 let draft=null,saved=false,followHost=!managed,testedSig=null,trustSig=null,scanned=null,busy=false;
 const whost=input({maxlength:'253',placeholder:'pc.example.lan',value:managed?.host||host()||''}),wport=input({type:'number',min:'1',max:'65535',inputmode:'numeric',value:String(managed?.port??22)}),
  wuser=input({maxlength:linux?'32':'128',placeholder:'alice',value:managed?.user||'',autocapitalize:'off'});
 const fields={whost:field(t('Host'),whost,t('obvykle adresa stroje výše')),wport:field(t('Port SSH'),wport),wuser:linux?field(t('Uživatel na Linuxu'),wuser,t('účet, pod kterým se Home Hub přihlásí; běžný, bez sudo'))
  :field(t('Uživatel ve Windows'),wuser,t('účet, pod kterým se Home Hub přihlásí; nejlépe běžný, bez práv správce'))};
 const message=el('small',{class:'had-err',role:'alert'}),tools=el('p',{class:'had-note',role:'status'});
 const keyBox=el('div',{class:'had-stack'}),windowsBox=el('div',{class:'had-stack'}),trustBox=el('div',{class:'had-stack'}),out=el('div',{class:'had-probe',hidden:''});
 const allowAdministrator=input({type:'checkbox'});
 const adminChoice=el('label',{class:'had-check'},allowAdministrator,t('Účet je správce; povolit klíč ve společném souboru správců Windows.'));
 allowAdministrator.addEventListener('change',()=>draw());
 const replacePresent=(node,...children)=>node.replaceChildren(...children.filter(child=>child!=null));
 const values=()=>({whost:whost.value,wport:wport.value,wuser:wuser.value});
 const hostPort=()=>({host:whost.value.trim(),port:Number(wport.value)});
 const say=text=>{message.textContent=text||'';};
 // What the server said, or "start again" when the draft is gone (expired, or another tab took its place).
 const failed=e=>{if(e.reason==='draft-missing'){draft=null;scanned=null;testedSig=null;trustSig=null;draw();}say(e.message);};
 async function ensureDraft(){if(draft)return draft;draft=(await post(base+'/draft',created())).draft;
  if(draft.trusted)trustSig=`${String(draft.host).toLowerCase()}|${draft.port}`;return draft;}
 const run=async(button,label,fn)=>{if(busy)return;busy=true;say('');const text=button.textContent;button.disabled=true;button.textContent=label;
  try{await fn();}catch(e){failed(e);}finally{busy=false;button.disabled=false;button.textContent=text;draw();}};
 // Step 2: the key. Generated on the server, or imported from a file or pasted; the private key is sent once and never shown again.
 const paste=el('textarea',{rows:'5',spellcheck:'false',autocomplete:'off','aria-label':t('Soukromý klíč OpenSSH'),placeholder:'-----BEGIN OPENSSH PRIVATE KEY-----'});
 const file=el('input',{type:'file','aria-label':t('Soubor se soukromým klíčem')});
 const importBox=el('div',{class:'had-stack',hidden:''});
 const sendKey=body=>ensureDraft().then(()=>post(base+'/draft/key',{draft:draft.id,...body})).then(r=>{draft=r.draft;testedSig=null;});
 const generate=el('button',{type:'button',class:'ui-button',onclick:()=>run(generate,t('Vytvářím klíč…'),()=>sendKey({generate:true}))},t('Vytvořit nový klíč'));
 const useImport=el('button',{type:'button',class:'ui-button',onclick:()=>run(useImport,t('Načítám klíč…'),async()=>{
  const text=paste.value;if(!text.trim())throw new Error(t('Vlož soukromý klíč, nebo vyber jeho soubor.'));
  try{await sendKey({privateKey:text});importBox.hidden=true;}finally{paste.value='';file.value='';}})},t('Použít tenhle klíč'));
 file.addEventListener('change',async()=>{const f=file.files?.[0];if(!f)return;if(f.size>16384){say(t('Soubor je na klíč SSH moc velký.'));file.value='';return;}paste.value=await f.text();});
 const showImport=el('button',{type:'button',class:'ui-button',onclick:()=>{importBox.hidden=!importBox.hidden;}},t('Naimportovat klíč…'));
 importBox.append(el('small',{class:'had-hint'},t('Soukromý klíč OpenSSH bez hesla (RSA, ECDSA nebo Ed25519). Uloží se jen na serveru Home Hubu a už se nikde neukáže. Klíč chráněný heslem Home Hub nevezme: vytvoř raději nový klíč jen pro něj.')),
  el('div',{class:'had-row'},file),paste,el('div',{class:'had-row'},useImport));
 // Step 4: the host key. Fetched without logging in; the person compares a fingerprint with Windows and confirms it.
 const confirm=el('input',{type:'checkbox'});
 const fetchKeys=el('button',{type:'button',class:'ui-button',onclick:()=>run(fetchKeys,t('Načítám klíč hostitele…'),async()=>{
  const v=hostPort();if(!validHostName(v.host)||!validPort(v.port))throw new Error(t('Nejdřív vyplň host a port.'));
  await ensureDraft();const r=await post(base+'/draft/scan',{draft:draft.id,...v});draft=r.draft;scanned=r.draft.hostKeys||[];trustSig=null;testedSig=null;confirm.checked=false;})},t('Načíst klíč hostitele'));
 const trust=el('button',{type:'button',class:'ui-button primary',onclick:()=>run(trust,t('Ukládám…'),async()=>{
  const picked=trustBox.querySelector('.had-fp-pick input:checked')?.value||scanned?.[0]?.fingerprint;
  if(!confirm.checked)throw new Error(linux?t('Nejdřív porovnej otisk s tím na stroji a potvrď, že sedí.'):t('Nejdřív porovnej otisk s tím na Windows a potvrď, že sedí.'));
  const r=await post(base+'/draft/trust',{draft:draft.id,fingerprint:picked});draft=r.draft;trustSig=`${hostPort().host.toLowerCase()}|${hostPort().port}`;testedSig=null;})},t('Důvěřovat tomuhle klíči'));
 // Step 5: one run of the collector with exactly what the form shows.
 const test=el('button',{type:'button',class:'ui-button primary',onclick:()=>run(test,t('Zkouším spojení…'),async()=>{
  const v=values(),e=windowsErrors(v,{os});const first=Object.keys(e)[0];if(first){fields[first]?.set(e[first]);throw new Error(t('Zkontroluj označená pole.'));}
  if(!draft?.key)throw new Error(t('Nejdřív vytvoř nebo naimportuj klíč.'));if(!trusted())throw new Error(t('Nejdřív načti a potvrď klíč hostitele.'));
  out.hidden=true;out.replaceChildren();
  const r=await post(base+'/draft/test',{draft:draft.id,...hostPort(),user:v.wuser.trim()});draft=r.draft;testedSig=windowsSignature(v);showFacts(r.result);onFacts(r.result);})},t('Vyzkoušet spojení'));
 const trusted=()=>Boolean(draft?.trusted&&trustSig===`${hostPort().host.toLowerCase()}|${hostPort().port}`);
 function showFacts(r){
  if(linux)return void (out.replaceChildren(el('div',{class:'had-dim'},t('Spojení funguje.')),linuxFacts(r)),out.hidden=false);
  out.replaceChildren(el('div',{class:'had-dim'},t('Spojení funguje.')),el('div',{class:'had-dim'},t('Přihlašuje se jako {user}@{host}, port {port}.',{user:r.connection?.user||'?',host:r.connection?.host||'?',port:r.connection?.port??22})),
   windowsFacts(r));out.hidden=false;
 }
 function draw(){
  const user=wuser.value.trim(),key=draft?.key;
  if(linux)return drawLinux(user,key);
  keyBox.replaceChildren(el('div',{class:'had-row'},generate,showImport),importBox,
   key?copyable(t('Veřejný klíč'),key.publicKey,t('{type} · otisk {fp}{reused}',{type:key.type,fp:key.fingerprint,reused:key.reused?' · '+t('klíč, se kterým se stroj čte teď'):''})):el('small',{class:'had-hint'},t('Klíč patří jen tomuhle spojení. Soukromou část drží server Home Hubu; tady uvidíš jen veřejnou.')));
  generate.textContent=key?t('Vytvořit jiný klíč'):t('Vytvořit nový klíč');
  let authorize=null;
  if(key&&validWindowsUser(user)){try{authorize=copyable(t('Autorizace klíče (PowerShell jako správce)'),authorizeScript(user,key.publicKey,{allowAdministrator:allowAdministrator.checked}),
   t('Povolí klíč pro účet {user}. Windows má pro správce jeden společný soubor; autorizace správce vyžaduje volbu výše. Pro běžný účet se mění jen jeho vlastní soubor.',{user}));}catch{authorize=null;}}
  replacePresent(windowsBox,
   adminChoice,
   el('details',{class:'had-guide'},el('summary',{},t('OpenSSH Server na Windows ještě není?')),copyable(t('Instalace OpenSSH Server (PowerShell jako správce)'),INSTALL_SCRIPT,
    t('Instalace sama povolí port 22 ve firewallu. Jiný port Home Hub na Windows nenastavuje: musí tam už být.'))),
   authorize||el('small',{class:'had-hint'},t('Až bude klíč a uživatel, objeví se tu příkaz, který klíč na Windows povolí. Kdo už OpenSSH Server používá, potřebuje jen tenhle krok.')),
   validWindowsUser(user)?el('details',{class:'had-guide'},el('summary',{},t('Test hlásí, že chybí čítače výkonu?')),copyable(t('Skupina Performance Monitor Users'),counterScript(user),
    t('Jen pro běžný účet, kterému Windows čítače nevrací. Členství dovoluje číst čítače výkonu, nic jiného.'))):null);
  const keys=scanned||[],nowTrusted=trusted();
  replacePresent(trustBox,el('div',{class:'had-row'},fetchKeys),
   nowTrusted?el('div',{class:'had-dim'},t('Ověřený klíč hostitele: {type} {fp}',{type:draft.trusted.type,fp:draft.trusted.fingerprint})):null,
   keys.length?el('div',{class:'had-stack'},
    el('div',{class:'had-dim'},t('Windows ukázal tyhle klíče hostitele (SHA-256):')),
    el('div',{class:'had-choices',role:'radiogroup','aria-label':t('Klíče hostitele')},keys.map((k,i)=>el('label',{class:'had-choice had-fp-pick'},el('input',{type:'radio',name:'had-hostkey',value:k.fingerprint,checked:i===0?'':null}),el('span',{},el('b',{},k.type),el('code',{class:'had-fp'},k.fingerprint))))),
    copyable(t('Otisky na Windows (PowerShell)'),FINGERPRINT_SCRIPT,t('Spusť na Windows a porovnej otisk stejného typu. Neshoduje se? Nepotvrzuj: mezi tebou a strojem může být jiný stroj.')),
    el('label',{class:'had-check'},confirm,t('Otisk sedí s tím, co ukázal Windows.')),el('div',{class:'had-row'},trust)):null);
  test.disabled=busy||!key||!nowTrusted;
 }
 // Linux: the key goes into the account's own ~/.ssh/authorized_keys; nothing else on the machine changes.
 function drawLinux(user,key){
  keyBox.replaceChildren(el('div',{class:'had-row'},generate,showImport),importBox,
   key?copyable(t('Veřejný klíč'),key.publicKey,t('{type} · otisk {fp}{reused}',{type:key.type,fp:key.fingerprint,reused:key.reused?' · '+t('klíč, se kterým se stroj čte teď'):''})):el('small',{class:'had-hint'},t('Klíč patří jen tomuhle spojení. Soukromou část drží server Home Hubu; tady uvidíš jen veřejnou.')));
  generate.textContent=key?t('Vytvořit jiný klíč'):t('Vytvořit nový klíč');
  let authorize=null;if(key){try{authorize=copyable(t('Autorizace klíče (shell na Linuxu, jako ten účet)'),linuxAuthorizeScript(key.publicKey),t('Přidá klíč jednou do ~/.ssh/authorized_keys účtu, pod kterým příkaz spustíš. Bez sudo; nic jiného se nemění.'));}catch{authorize=null;}}
  replacePresent(windowsBox,authorize||el('small',{class:'had-hint'},t('Až bude klíč, objeví se tu příkaz, který ho na Linuxu povolí.')),
   validUnixUser(user)?el('details',{class:'had-guide'},el('summary',{},t('Vlastní účet jen pro Home Hub?')),copyable(t('Účet pro Home Hub (jako root)'),linuxAccountScript(user),t('Volitelné. Běžný účet bez sudo a bez skupin; sběr čte jen /proc, /sys a df.'))):null);
  const keys=scanned||[],nowTrusted=trusted();
  replacePresent(trustBox,el('div',{class:'had-row'},fetchKeys),
   nowTrusted?el('div',{class:'had-dim'},t('Ověřený klíč hostitele: {type} {fp}',{type:draft.trusted.type,fp:draft.trusted.fingerprint})):null,
   keys.length?el('div',{class:'had-stack'},
    el('div',{class:'had-dim'},t('Stroj ukázal tyhle klíče hostitele (SHA-256):')),
    el('div',{class:'had-choices',role:'radiogroup','aria-label':t('Klíče hostitele')},keys.map((k,i)=>el('label',{class:'had-choice had-fp-pick'},el('input',{type:'radio',name:'had-hostkey',value:k.fingerprint,checked:i===0?'':null}),el('span',{},el('b',{},k.type),el('code',{class:'had-fp'},k.fingerprint))))),
    copyable(t('Otisky na Linuxu (shell)'),LINUX_FINGERPRINT_SCRIPT,t('Spusť na stroji a porovnej otisk stejného typu. Neshoduje se? Nepotvrzuj: mezi tebou a strojem může být jiný stroj.')),
    el('label',{class:'had-check'},confirm,t('Otisk sedí s tím, co ukázal stroj.')),el('div',{class:'had-row'},trust)):null);
  test.disabled=busy||!key||!nowTrusted;
 }
 const hostChanged=()=>{scanned=null;testedSig=null;confirm.checked=false;out.hidden=true;draw();};
 whost.addEventListener('input',()=>{followHost=false;hostChanged();});wport.addEventListener('input',hostChanged);
 wuser.addEventListener('input',()=>{testedSig=null;out.hidden=true;draw();});
 draw();
 // The OpenSSH client tools on the hub's server, asked once the part is shown.
 let asked=false;
 const askTools=async()=>{if(asked)return;asked=true;
  try{const r=await (await fetch(linux?'/api/home/devices/ssh/tools':'/api/home/devices/windows/tools')).json();
   tools.textContent=r.ok?t('Server s Home Hubem má klientské nástroje OpenSSH ({version}).',{version:r.ssh?.version||'OpenSSH'})
    :t('Na serveru s Home Hubem chybí klientské nástroje OpenSSH ({missing}). Nainstaluj OpenSSH Client: ve Windows volitelná funkce OpenSSH Client, v Linuxu balíček openssh-client (nebo openssh); macOS je má.',{missing:[r.ssh?.ok?null:'ssh',r.keyscan?.ok?null:'ssh-keyscan'].filter(Boolean).join(', ')});
   tools.classList.toggle('had-err',!r.ok);}catch{asked=false;}};
 const section=(title,...body)=>el('div',{class:'had-step'},el('h4',{},title),...body);
 return {node:el('fieldset',{class:'had-thermo'},el('legend',{},linux?t('Linux přes SSH'):t('Windows přes SSH')),
   el('p',{class:'had-note'},linux?t('Home Hub se k Linuxu připojuje ze svého serveru vlastním klíčem SSH a spustí jen pevný skript, který čte /proc, /sys a df. Žádné sudo, žádný agent ani Python; na stroji se nic nemění. Na serveru potřebuje jen klientské nástroje OpenSSH.')
    :t('Home Hub se k Windows připojuje ze svého serveru vlastním klíčem SSH, takže nezáleží na tom, na jakém systému běží ani z jakého prohlížeče ho otevíráš. Na serveru potřebuje jen klientské nástroje OpenSSH (ssh a ssh-keyscan). Na Windows spustí jen pevný skript, který čte čítače výkonu a inventář.')),
   tools,
   alias?el('p',{class:'had-note'},t('Teď se stroj čte přes starší SSH alias {alias} z konfigurace účtu, pod kterým běží Home Hub. Funguje dál, dokud ho tu nenahradíš spojením, které spravuje Home Hub sám; alias ani soubory v ~/.ssh se nemění.',{alias})):null,
   section(t('1 · Kam se připojit'),el('div',{class:'had-grid'},fields.whost.node,fields.wport.node,fields.wuser.node)),
   section(t('2 · Klíč Home Hubu'),keyBox),
   section(linux?t('3 · Na Linuxu'):t('3 · Na Windows'),windowsBox),
   section(t('4 · Klíč hostitele'),el('small',{class:'had-hint'},linux?t('Home Hub načte klíč, kterým se stroj prokazuje (bez přihlášení). Porovnej jeho otisk s tím na stroji a potvrď ho; neznámý ani změněný klíč Home Hub nikdy nepřijme sám.')
    :t('Home Hub načte klíč, kterým se Windows prokazuje (bez přihlášení). Porovnej jeho otisk s tím na Windows a potvrď ho; neznámý ani změněný klíč Home Hub nikdy nepřijme sám.')),trustBox),
   section(t('5 · Vyzkoušet'),el('div',{class:'had-row'},test,message),out,
    el('small',{class:'had-hint'},linux?t('GPU a příkon se přes /proc nečtou, zůstanou prázdné. Teploty jen ty, které stroj hlásí v /sys/class/hwmon.'):t('Teploty, ventilátory a příkon Windows nehlásí, takže zůstanou prázdné.')))),
  // Editing a managed connection: its key and verified host key are shown (and reused) from the start.
  fields,shown:()=>{void askTools();if(machineId&&managed&&!draft&&!busy){busy=true;ensureDraft().then(()=>{say('');},failed).finally(()=>{busy=false;draw();});}},
  // The machine's address changed above: the SSH host follows it until it is edited here.
  hostChanged:()=>{if(followHost){whost.value=host()||'';hostChanged();}},
  reset:hostChanged,setProbe:text=>{if(text)say(text);},
  value:()=>({...values(),windowsKey:Boolean(draft?.key),windowsTrusted:trusted(),windowsTested:draft?.tested?testedSig:null}),
  body:()=>({...(linux?{provider:'linux-ssh'}:{}),draft:draft?.id,host:hostPort().host,port:hostPort().port,user:wuser.value.trim()}),
  errors:()=>{const v=values(),e=windowsErrors(v,{os});if(Object.keys(e).length)return e;
   if(!draft?.key)return {windowsTest:t('Nejdřív vytvoř nebo naimportuj klíč.')};if(!trusted())return {windowsTest:t('Nejdřív načti a potvrď klíč hostitele.')};
   if(!draft?.tested||testedSig!==windowsSignature(v))return {windowsTest:t('Nejdřív vyzkoušej spojení s tímhle nastavením.')};return {};},
  saved:()=>{saved=true;},
  // Closed without saving: the draft (its key and host key) goes now; the server would drop it later anyway.
  dispose(){if(draft&&!saved){try{void fetch(base+'/draft/discard',{method:'POST',keepalive:true,headers:{'Content-Type':'application/json'},body:JSON.stringify({draft:draft.id})}).catch(()=>{});}catch{}}draft=null;}};
}
// What a Linux test found (Node Exporter, Prometheus, SSH): the same list for each source.
function linuxFacts(r){
 return el('ul',{class:'had-facts'},
  r.job?el('li',{},t('Cíl Promethea: job {job}, instance {instance}',{job:r.job,instance:r.instance})):null,
  r.os?.caption||r.os?.version?el('li',{},[r.os.caption,r.os.version,r.os.arch].filter(Boolean).join(' · ')):null,
  el('li',{},[r.cpu?.name,r.cpu?.logical?tp(r.cpu.logical,'{n} logický procesor|{n} logické procesory|{n} logických procesorů'):null].filter(Boolean).join(' · ')||'CPU'),
  r.memTotal?el('li',{},`RAM ${Math.round(r.memTotal/GiB)} GB`):null,
  r.volumes?.length?el('li',{},t('Svazky: {list}',{list:r.volumes.map(v=>`${v.name} ${Math.round((v.total||0)/GB)} GB`).join(' · ')})):el('li',{},t('Žádný místní svazek.')),
  r.disks?.length?el('li',{},t('Disky: {list}',{list:r.disks.join(', ')})):null,
  r.interfaces?.length?el('li',{},t('Síť: {list}',{list:r.interfaces.join(', ')})):null,
  el('li',{},r.temps?t('Teploty: {n} čidel{cpu}',{n:r.temps,cpu:r.cpuTemp!=null?` · CPU ${r.cpuTemp} °C`:''}):t('Teploty stroj nehlásí.')),
  el('li',{},t('GPU a příkon: tenhle zdroj je neměří.')));
}
// What a Windows test found (over SSH or WinRM).
function windowsFacts(r){
 return el('ul',{class:'had-facts'},
  r.os?.caption?el('li',{},`${r.os.caption}${r.os.version?' · '+r.os.version:''}`):null,
  r.cpu?.name?el('li',{},`${r.cpu.name}${r.cpu.logical?' · '+tp(r.cpu.logical,'{n} logický procesor|{n} logické procesory|{n} logických procesorů'):''}`):null,
  r.memTotal?el('li',{},`RAM ${Math.round(r.memTotal/GiB)} GB`):null,
  r.volumes?.length?el('li',{},r.volumes.map(v=>`${v.mount} ${Math.round((v.total||0)/GB)} GB`).join(' · ')):null,
  el('li',{},r.gpus?.length?`GPU ${r.gpus.join(', ')} · ${r.gpuCounters?t('čítače GPU jsou'):t('čítače GPU chybí')}`:t('žádná GPU')),
  el('li',{},t('Teploty, ventilátory a příkon: Windows je nehlásí.')));
}
const groupsHex=hex=>String(hex||'').toUpperCase().match(/.{2}/g)?.join(':')||'';
// Part 3 for the HTTP(S) providers: Windows over WinRM, Linux over Node Exporter, Linux from an existing Prometheus.
// The connection is built in a server-side draft (/api/home/devices/endpoint/draft…, server/endpoint-setup.mjs):
// certificate (read without sending anything), trust (CA store or a pinned fingerprint), for Prometheus the target
// (job + instance as Prometheus lists them), then a test. The password or token is sent one way only: a reply
// never carries it, and editing keeps the stored one until a new one is typed. Only a draft whose test matches what
// the form shows can be saved.
const ENDPOINT={
 winrm:{legend:'Windows přes WinRM',port:5986,schemes:['https'],auth:['basic'],
  note:'Home Hub čte Windows pevnými dotazy WMI přes WinRM HTTPS (WS-Management Enumerate, jen ke čtení). Přihlašuje se místním účtem a heslem (ověřování Basic), a to až po ověření certifikátu. Kerberos, NTLM ani PowerShell Remoting Home Hub nepoužívá.'},
 'node-exporter':{legend:'Linux přes Node Exporter',port:9100,schemes:['http','https'],auth:['none','basic'],
  note:'Home Hub čte /metrics Prometheus Node Exporteru přímo, jedno čtení za interval; Prometheus server není potřeba. Bez TLS jen v místní síti a bez přihlašovacích údajů; s HTTPS volitelně Basic.'},
 prometheus:{legend:'Linux z Promethea',port:9090,schemes:['http','https'],auth:['none','basic','bearer'],
  note:'Home Hub se ptá API existujícího Promethea (port 9090, ne Node Exporter na 9100) jen ke čtení na metriky Node Exporteru jednoho cíle: přesně jeden job a instance, které Prometheus sám nabídne. Nikdy nečte /metrics Promethea, nic v něm nemění a nesčítá víc strojů.'}};
export const endpointSignature=v=>[String(v.ehost||'').trim().toLowerCase(),String(v.eport||'').trim(),v.escheme||'',v.eauth||'',String(v.euser||'').trim(),v.ejob||'',v.einstance||''].join('|');
export function endpointErrors(v,{provider}){
 const e={},spec=ENDPOINT[provider],host=String(v.ehost||'').trim(),port=String(v.eport??'').trim(),user=String(v.euser||'').trim();
 if(!host)e.ehost=t('Vyplň host: jméno nebo IP adresu.');else if(!validHostName(host))e.ehost=t('Hostname smí obsahovat jen písmena, číslice, tečky a pomlčky.');
 if(!validPort(Number(port))||!/^\d+$/.test(port))e.eport=t('Port je číslo 1–65535.');
 if(provider==='winrm'){if(!user)e.euser=t('Vyplň místní účet Windows.');else if(!validWindowsUser(user)||/[\\@]/.test(user))e.euser=t('Basic přes WinRM bere jen místní účet: jméno bez domény.');}
 else if(v.eauth==='basic'&&!/^[A-Za-z0-9._@-]{1,64}$/.test(user))e.euser=t('Uživatel: písmena, číslice, tečka, podtržítko, @ a pomlčka; nejvýš 64 znaků.');
 if(v.escheme==='http'&&(v.eauth&&v.eauth!=='none'||user||v.epassword))e.eauth=t('Přes HTTP Home Hub žádné přihlašovací údaje neposílá. Zvol HTTPS, nebo přihlášení vypni.');
 if(!spec.schemes.includes(v.escheme))e.eport=t('Zvol schéma.');
 return e;
}
export const endpointScheme=(provider,current)=>current?.scheme||(provider==='winrm'?'https':'http');
function endpointPart({provider,host,machineId=null,current=null,onFacts=()=>{}}){
 const spec=ENDPOINT[provider],mine=current?.mode===provider?current:null;
 const replacePresent=(node,...children)=>node.replaceChildren(...children.filter(child=>child!=null));
 let draft=null,saved=false,busy=false,testedSig=null,passwordDirty=false,cert=null,followHost=!mine;
 const ehost=input({maxlength:'253',placeholder:'host.example.lan',value:mine?.host||host()||''}),eport=input({type:'number',min:'1',max:'65535',inputmode:'numeric',value:String(mine?.port??spec.port)});
 const escheme=el('select',{},spec.schemes.map(x=>el('option',{value:x,selected:endpointScheme(provider,mine)===x?'':null},x.toUpperCase())));
 const eauth=el('select',{},spec.auth.map(x=>el('option',{value:x,selected:(mine?.auth||(provider==='winrm'?'basic':'none'))===x?'':null},({none:t('bez přihlášení'),basic:t('Basic (uživatel a heslo)'),bearer:t('Bearer token')})[x])));
 const euser=input({maxlength:'64',placeholder:provider==='winrm'?'homehub':'',value:mine?.user||'',autocapitalize:'off'});
 const epassword=input({type:'password',maxlength:'4096',autocomplete:'new-password'});
 const fields={ehost:field(t('Host'),ehost,provider==='prometheus'?t('server s Prometheem, ne sledovaný stroj'):t('obvykle adresa stroje výše')),eport:field(t('Port'),eport),escheme:field(t('Schéma'),escheme),
  eauth:field(t('Přihlášení ke zdroji'),eauth),euser:field(provider==='winrm'?t('Místní účet Windows'):t('Uživatel'),euser),
  epassword:field(t('Heslo nebo token'),epassword,t('posílá se jen na server Home Hubu a už se nikde neukáže'))};
 const message=el('small',{class:'had-err',role:'alert'}),certBox=el('div',{class:'had-stack'}),targetBox=el('div',{class:'had-stack'}),out=el('div',{class:'had-probe',hidden:''});
 const say=x=>{message.textContent=x||'';};
 const v=()=>({ehost:ehost.value,eport:eport.value,escheme:provider==='winrm'?'https':escheme.value,eauth:provider==='winrm'?'basic':eauth.value,euser:euser.value,epassword:epassword.value,
  ejob:picked()?.job||'',einstance:picked()?.instance||''});
 const conn=()=>{const x=v();return {host:x.ehost.trim(),port:Number(x.eport),scheme:x.escheme,...(provider==='prometheus'?{auth:x.eauth}:{}),...(x.eauth!=='none'&&x.euser.trim()?{user:x.euser.trim()}:{}),...(x.epassword?{password:x.epassword}:{})};};
 const failed=e=>{if(e.reason==='draft-missing'){draft=null;cert=null;testedSig=null;}say(e.message);};
 async function ensureDraft(){if(draft)return draft;draft=(await post('/api/home/devices/endpoint/draft',{provider,...(machineId?{id:machineId}:{})})).draft;return draft;}
 const run=async(button,label,fn)=>{if(busy)return;busy=true;say('');const text=button.textContent;button.disabled=true;button.textContent=label;
  try{await fn();}catch(e){failed(e);}finally{busy=false;button.disabled=false;button.textContent=text;draw();}};
 const confirm=el('input',{type:'checkbox'});
 const probe=el('button',{type:'button',class:'ui-button',onclick:()=>run(probe,t('Načítám certifikát…'),async()=>{
  const c=conn();if(!validHostName(c.host)||!validPort(c.port))throw new Error(t('Nejdřív vyplň host a port.'));
  await ensureDraft();const r=await post('/api/home/devices/endpoint/draft/probe',{draft:draft.id,host:c.host,port:c.port});draft=r.draft;cert=r.draft.certificate;confirm.checked=false;testedSig=null;})},t('Načíst certifikát'));
 const trustAs=mode=>run(mode==='ca'?trustCa:trustPin,t('Ukládám…'),async()=>{
  if(mode==='pin'&&!confirm.checked)throw new Error(t('Nejdřív porovnej otisk s tím na stroji a potvrď, že sedí.'));
  const r=await post('/api/home/devices/endpoint/draft/trust',{draft:draft.id,mode,...(mode==='pin'?{fingerprint:cert.fingerprint}:{})});draft=r.draft;testedSig=null;});
 const trustCa=el('button',{type:'button',class:'ui-button',onclick:()=>trustAs('ca')},t('Důvěřovat autoritě (ověří i jméno)'));
 const trustPin=el('button',{type:'button',class:'ui-button primary',onclick:()=>trustAs('pin')},t('Připnout tenhle certifikát'));
 let targets=null;
 const picked=()=>{const value=targetBox.querySelector('input[name="had-target"]:checked')?.value;return value?targets?.find(x=>`${x.job}\u0000${x.instance}`===value)||null:null;};
 const discover=el('button',{type:'button',class:'ui-button',onclick:()=>run(discover,t('Načítám cíle…'),async()=>{
  await ensureDraft();const r=await post('/api/home/devices/endpoint/draft/discover',{draft:draft.id,...conn()});draft=r.draft;targets=r.targets;testedSig=null;epassword.value='';passwordDirty=false;})},t('Načíst cíle z Promethea'));
 const test=el('button',{type:'button',class:'ui-button primary',onclick:()=>run(test,t('Zkouším spojení…'),async()=>{
  const x=v(),e=endpointErrors(x,{provider});const first=Object.keys(e)[0];if(first){fields[first]?.set(e[first]);throw new Error(t('Zkontroluj označená pole.'));}
  if(provider==='prometheus'&&!picked())throw new Error(t('Nejdřív načti cíle a vyber stroj.'));
  await ensureDraft();out.hidden=true;out.replaceChildren();
  const r=await post('/api/home/devices/endpoint/draft/test',{draft:draft.id,...conn(),...(provider==='prometheus'?{job:picked().job,instance:picked().instance}:{})});
  draft=r.draft;testedSig=endpointSignature(x);epassword.value='';passwordDirty=false;
  out.replaceChildren(el('div',{class:'had-dim'},t('Spojení funguje.')),provider==='winrm'?windowsFacts(r.result):linuxFacts(r.result));out.hidden=false;onFacts(r.result);})},t('Vyzkoušet spojení'));
 const https=()=>v().escheme==='https';
 const trustOk=()=>Boolean(draft?.trust&&draft.host&&draft.host.toLowerCase()===ehost.value.trim().toLowerCase()&&draft.port===Number(eport.value));
 function draw(){
  const tls=https();
  fields.eauth.node.hidden=provider==='winrm'||!tls;fields.euser.node.hidden=!(provider==='winrm'||tls&&eauth.value==='basic');
  fields.epassword.node.hidden=!(provider==='winrm'||tls&&eauth.value!=='none');
  fields.epassword.input.placeholder=draft?.password?.reused?t('uložené heslo zůstane, pokud nezadáš nové'):'';
  certBox.hidden=!tls;
  const matches=draft&&draft.host?.toLowerCase()===ehost.value.trim().toLowerCase()&&draft.port===Number(eport.value)&&draft.scheme===v().escheme;
  const c=cert||(matches?draft?.certificate:null);
  replacePresent(certBox,el('div',{class:'had-row'},probe),
   trustOk()?el('div',{class:'had-dim'},draft.trust.mode==='ca'?t('Důvěra: certifikát ověřený autoritou a jménem hostitele.'):t('Důvěra: připnutý certifikát {fp}',{fp:groupsHex(draft.trust.fingerprint)})):null,
   c&&!trustOk()?el('div',{class:'had-stack'},
    el('div',{class:'had-dim'},t('Certifikát (SHA-256):')),el('code',{class:'had-fp'},groupsHex(c.fingerprint)),
    el('div',{class:'had-dim'},[c.subject?`CN ${c.subject}`:null,c.issuer?t('vydal {who}',{who:c.issuer}):null,c.validTo?t('platí do {when}',{when:c.validTo}):null].filter(Boolean).join(' · ')),
    el('div',{class:'had-dim'},c.caVerified?t('Ověřený autoritou, kterou zná Home Hub, a platný pro tohle jméno.'):c.hostnameOk?t('Neověřený žádnou známou autoritou (třeba vlastní nebo samopodepsaný).'):t('Jméno hostitele v certifikátu nesedí, nebo ho neověřila známá autorita.')),
    provider==='winrm'?copyable(t('Otisk na Windows (PowerShell)'),WINRM_FINGERPRINT_SCRIPT,t('Porovnej s otiskem výše. Neshoduje se? Nepotvrzuj.')):null,
    el('label',{class:'had-check'},confirm,t('Otisk sedí s tím, co ukazuje stroj.')),
    el('div',{class:'had-row'},c.caVerified?trustCa:null,trustPin)):null);
  if(provider==='prometheus'){
   const pick=picked(),list=targets||(matches?draft?.targets:null)||null;if(list)targets=list;
   const remembered=!targets&&mine?{job:mine.job,instance:mine.instance}:null;
   replacePresent(targetBox,el('div',{class:'had-row'},discover),
    remembered?el('div',{class:'had-dim'},t('Teď se čte cíl job {job}, instance {instance}. Pro změnu načti cíle.',remembered)):null,
    targets?.length?el('div',{class:'had-choices',role:'radiogroup','aria-label':t('Cíle node_exporter')},targets.map(x=>el('label',{class:'had-choice'},
     el('input',{type:'radio',name:'had-target',value:`${x.job}\u0000${x.instance}`,disabled:x.eligible?null:'',checked:pick&&pick.job===x.job&&pick.instance===x.instance||!pick&&mine&&mine.job===x.job&&mine.instance===x.instance?'':null,onchange:()=>{testedSig=null;draw();}}),
     el('span',{},el('b',{},`${x.instance}`),el('small',{},[t('job {job}',{job:x.job}),x.nodename,x.up===true?t('cíl běží'):x.up===false?t('cíl neodpovídá (up = 0)'):null,
      x.lastSampleAt?t('poslední vzorek {when}',{when:new Date(x.lastSampleAt).toLocaleTimeString()}):null,x.eligible?null:t('víc strojů pod jedním cílem: nejde vybrat')].filter(Boolean).join(' · '))))))
     :targets?el('p',{class:'had-note'},t('Prometheus nenabízí žádný cíl s metrikami Node Exporteru.')):null);
  }
  test.disabled=busy||tls&&!trustOk();
 }
 const reset=()=>{testedSig=null;out.hidden=true;draw();};
 ehost.addEventListener('input',()=>{followHost=false;cert=null;targets=null;reset();});eport.addEventListener('input',()=>{cert=null;targets=null;reset();});
 escheme.addEventListener('change',()=>{if(escheme.value==='http'){eauth.value='none';euser.value='';epassword.value='';passwordDirty=true;}targets=null;reset();});
 eauth.addEventListener('change',()=>{targets=null;reset();});
 euser.addEventListener('input',reset);epassword.addEventListener('input',()=>{passwordDirty=true;reset();});
 const guide=el('div',{class:'had-stack'});
 function drawGuide(){guide.replaceChildren(provider==='winrm'?el('div',{class:'had-stack'},
   el('p',{class:'had-note'},t('WinRM má ověřování Basic ve výchozím stavu vypnuté. Krok níže ho zapne jen pro službu WinRM a přidá posluchač HTTPS, pokud ještě není; existující posluchače, certifikáty a nastavení nechá, AllowUnencrypted ani UAC nemění. Basic funguje jen s místním účtem.')),
   copyable(t('Posluchač HTTPS a Basic pro službu (PowerShell jako správce)'),winrmListenerScript({host:ehost.value.trim()||undefined,port:Number(eport.value)||5986,hub:hubAddr||undefined}),hubAddr?t('Firewall pustí port jen z adresy serveru Home Hubu ({address}).',{address:hubAddr}):t('Na začátku doplň adresu serveru Home Hubu: firewall pustí port jen z ní.')),
   el('details',{class:'had-guide'},el('summary',{},t('Účet bez práv správce')),copyable(t('Skupiny pro běžný účet (PowerShell jako správce)'),winrmAccountScript(euser.value.trim()&&validWindowsUser(euser.value.trim())&&!/[\\@]/.test(euser.value.trim())?euser.value.trim():'homehub'),
    t('Remote Management Users pustí účet k WinRM, Performance Monitor Users k čítačům. Právo Remote Enable na root/cimv2 se nastaví v wmimgmt.msc, jak ukáže poslední řádek.'))))
  :provider==='node-exporter'?el('div',{class:'had-stack'},
   el('p',{class:'had-note'},t('Node Exporter je oficiální exportér Promethea pro Linux. Home Hub ho nikdy neinstaluje; nainstaluj ho sám balíčkem distribuce, nebo oficiálním vydáním. Port pusť jen ze serveru Home Hubu, nikdy do internetu.')),
   el('details',{class:'had-guide'},el('summary',{},t('Instalace balíčkem')),copyable(t('Balíček distribuce'),NODE_EXPORTER_PACKAGES)),
   el('details',{class:'had-guide'},el('summary',{},t('Instalace oficiálního vydání se systemd')),copyable(t('Ruční instalace (shell)'),nodeExporterManual(),t('Doplň verzi, architekturu a adresu v místní síti, na které má poslouchat.'))),
   el('details',{class:'had-guide'},el('summary',{},t('Firewall')),copyable(t('Jen ze serveru Home Hubu'),nodeExporterFirewall({hub:hubAddr||undefined}))),
   el('details',{class:'had-guide'},el('summary',{},t('HTTPS a Basic (volitelné)')),copyable(t('Web config Node Exporteru'),nodeExporterTls({host:ehost.value.trim()||undefined}))))
  :el('div',{class:'had-stack'},
   el('p',{class:'had-note'},t('Potřebuješ Prometheus, který už sbírá Node Exporter toho stroje. Home Hub Prometheus neinstaluje ani nekonfiguruje a používá jen jeho API pro dotazy.')),
   el('details',{class:'had-guide'},el('summary',{},t('Stroj v Prometheu ještě není?')),copyable(t('Cíl pro scrape_configs'),prometheusScrape({host:host()||undefined}),t('Node Exporter na stroji nainstaluj podle volby Linux (Node Exporter).'))),
   el('details',{class:'had-guide'},el('summary',{},t('Prometheus v Dockeru')),copyable(t('Docker'),PROMETHEUS_DOCKER))));}
 // The hub's own address in the site's networks fills the firewall lines; without one they keep the placeholder.
 let hubAddr=null;
 drawGuide();
 void fetch('/api/home/devices/hub-address').then(r=>r.ok?r.json():null).then(r=>{if(typeof r?.address==='string'){hubAddr=r.address;drawGuide();}}).catch(()=>{});
 for(const control of [ehost,eport,euser])control.addEventListener('input',drawGuide);
 draw();
 const section=(title,...body)=>el('div',{class:'had-step'},el('h4',{},title),...body);
 return {node:el('fieldset',{class:'had-thermo'},el('legend',{},t(spec.legend)),el('p',{class:'had-note'},t(spec.note)),
   section(t('1 · Kam se připojit'),el('div',{class:'had-grid'},fields.ehost.node,fields.eport.node,provider==='winrm'?null:fields.escheme.node,fields.eauth.node,fields.euser.node,fields.epassword.node)),
   section(provider==='winrm'?t('2 · Na Windows'):t('2 · Na stroji'),guide),
   section(t('3 · Certifikát'),el('small',{class:'had-hint'},t('Jen pro HTTPS. Home Hub načte certifikát bez odeslání čehokoli dalšího; přihlašovací údaje pošle, až když certifikát potvrdíš.')),certBox),
   provider==='prometheus'?section(t('4 · Stroj v Prometheu'),targetBox):null,
   section(provider==='prometheus'?t('5 · Vyzkoušet'):t('4 · Vyzkoušet'),el('div',{class:'had-row'},test,message),out)),
  fields,shown:()=>{},hostChanged:()=>{if(followHost){ehost.value=host()||'';cert=null;targets=null;reset();drawGuide();}},reset,setProbe:x=>{if(x)say(x);},value:()=>({}),
  errors:()=>{const x=v(),e=endpointErrors(x,{provider});if(Object.keys(e).length)return e;
   if(x.escheme==='https'&&!trustOk())return {endpointTest:t('Nejdřív načti a potvrď certifikát.')};
   if(provider==='prometheus'&&!picked()&&!(mine&&draft))return {endpointTest:t('Nejdřív načti cíle a vyber stroj.')};
   if(!draft?.tested||testedSig!==endpointSignature(x)||passwordDirty)return {endpointTest:t('Nejdřív vyzkoušej spojení s tímhle nastavením.')};return {};},
  body:()=>{const c=conn();delete c.password;const pk=picked();return {provider,draft:draft?.id,...c,...(provider==='prometheus'&&pk?{job:pk.job,instance:pk.instance}:{})};},
  saved:()=>{saved=true;},
  dispose(){epassword.value='';if(draft&&!saved){try{void fetch('/api/home/devices/endpoint/draft/discard',{method:'POST',keepalive:true,headers:{'Content-Type':'application/json'},body:JSON.stringify({draft:draft.id})}).catch(()=>{});}catch{}}draft=null;}};
}
const linuxSshPart=opts=>windowsPart({...opts,os:'linux'});
const ADAPTER_FORMS={thermo:thermoPart,windows:windowsPart,winrm:o=>endpointPart({...o,provider:'winrm'}),'node-exporter':o=>endpointPart({...o,provider:'node-exporter'}),
 prometheus:o=>endpointPart({...o,provider:'prometheus'}),'linux-ssh':linuxSshPart};
// The providers that read a device without an agent, and the system each reads (server/home-devices.mjs → PROVIDER_PLATFORM).
export const FEED_PLATFORM=Object.freeze({windows:'windows',winrm:'windows','node-exporter':'linux',prometheus:'linux','linux-ssh':'linux'});
export const telemetryChoices=meta=>(Array.isArray(meta?.adapters)?meta.adapters:[{id:'thermo',name:meta?.agent||'Thermo'}])
 .filter(a=>a&&typeof a.id==='string'&&Object.hasOwn(ADAPTER_FORMS,a.id)).map(a=>({id:a.id,name:String(a.name||a.id),summary:typeof a.summary==='string'?a.summary:'',defaultPort:Number.isInteger(a.defaultPort)?a.defaultPort:49286,
  platform:typeof a.platform==='string'?a.platform:null,recommended:a.recommended===true}));
// What fits the chosen system: its own adapters (the recommended first); with no system (or "other") every one.
export const choicesFor=(offered,platform)=>{const fit=platform&&platform!=='other'?offered.filter(a=>!a.platform||a.platform===platform):offered;
 return [...fit].sort((a,b)=>Number(b.recommended)-Number(a.recommended));};

// machine = null adds a device; a machine from /api/home (added:true) edits it. meta = /api/home → telemetry.
// A machine of the site configuration (source "site") opens the same dialog as its site editor: the picture (the
// site's, a built-in one or an own one), its name, address and hardware as the owner's override over the site's values
// (POST /api/home/devices/site; each field says when it differs from the site and what the site says; Reset to site
// defaults drops them all), and its telemetry where the site allows one (telemetryEditable: no thermoId, not the router).
// Its id, role, system (when the site names one) and the collectors' wiring stay in local/site.json, which is never
// written; it cannot be removed. Telemetry offers the agent-less providers (Thermo for a site machine is the site files'
// business), with the system to choose when the site does not name one; a Thermo Mac or the router says who reads it.
// focus: 'telemetry' opens with the telemetry part. onSaved() after everything asked for is stored.
// Telemetry is chosen among what fits the system (macOS: Thermo; Windows: SSH or WinRM; Linux: Node Exporter
// (recommended), Prometheus or SSH); with no system said, every adapter is offered. Role is not platform.
// A device read by an agent-less provider keeps its id and history when its connection is changed or switched to
// another provider: switching is a deliberate choice, and saving it deletes the old connection's secrets.
function deviceDialog({machine=null,meta,focus,onSaved}){
 const adding=!machine,siteMode=Boolean(machine&&machine.source==='site'),siteTelemetry=siteMode&&machine.telemetryEditable===true,agent=meta?.agent||'Thermo',lan=site().lanCidrs||[],offered=telemetryChoices(meta).filter(a=>!siteMode||a.id!=='thermo');
 const tel=machine?.telemetry||{},feed=machine&&Object.hasOwn(FEED_PLATFORM,tel.provider)?tel.provider:null,viaWindows=feed==='windows';
 const p=machine?.props||{},connected=Boolean(machine&&!feed&&tel.thermoId===machine.id&&tel.reason!=='no-login');
 const nameOf=id=>offered.find(a=>a.id===id)?.name||id;
 // retarget: a connected agent-less device is being changed (same provider) or switched (another one of its system).
 let hash=machine?.hash||null,retarget=Boolean(feed)&&focus==='telemetry',chosen=retarget?feed:null;
 const wantThermo=()=>chosen==='thermo'&&!connected,wantFeed=()=>Boolean(chosen&&Object.hasOwn(FEED_PLATFORM,chosen))&&(!feed||retarget);
 const status=el('p',{class:'had-msg',role:'status'});
 const say=(text,error=false)=>{status.textContent=text||'';status.classList.toggle('error',error);};
 const name=input({required:'',maxlength:'60',placeholder:t('Mac mini (pracovna)'),value:machine?.name||''}),host=input({maxlength:'253',placeholder:'mini.example.lan',value:machine?.hostname||''}),
  ip=input({maxlength:'15',placeholder:'10.0.0.30',inputmode:'decimal',value:machine?.ip||''}),cpu=input({maxlength:'60',placeholder:'10c M4',value:p.cpu||''}),gpu=input({maxlength:'40',placeholder:'10c',value:p.gpu&&p.gpu!=='—'?p.gpu:''}),
  ram=input({type:'number',min:'1',max:'65536',step:'1',placeholder:'32',value:p.ramGb??''}),disk=input({type:'number',min:'1',step:'1',placeholder:'1000',value:p.diskTotalBytes?Math.round(p.diskTotalBytes/1e9):''});
 const role=el('select',{},ROLES.map(([id,label])=>el('option',{value:id,selected:(machine?.role||'computer')===id?'':null},t(label))));
 // A machine read by an agent-less provider keeps its system until it is disconnected.
 // A site machine: the system is chosen here only when site.json does not name one; only systems read without an agent.
 const platformOptions=siteMode&&!machine.platform?PLATFORMS.filter(([id])=>['','windows','linux'].includes(id)):PLATFORMS;
 const platform=el('select',{disabled:feed||(siteMode&&machine.platform)?'':null},platformOptions.map(([id,label])=>el('option',{value:id,selected:(machine?.platform||(feed?FEED_PLATFORM[feed]:''))===id?'':null},t(label))));
 const picture=picturePart({machine,role:()=>role.value,site:siteMode});
 role.addEventListener('change',()=>picture.roleChanged());
 const where=()=>host.value.trim()||ip.value.trim();
 // What a successful test found fills the hardware fields that are still empty. Linux volumes are never summed into a
 // disk size: ZFS datasets share their pool and bind mounts repeat a device, so a sum would be wrong.
 const fill=r=>{if(siteMode)return;if(!cpu.value.trim()&&r.cpu?.name)cpu.value=r.cpu.name.replace(/\s+/g,' ').slice(0,60);if(!gpu.value.trim()&&r.gpus?.[0])gpu.value=String(r.gpus[0]).slice(0,40);
  if(!ram.value&&r.memTotal)ram.value=String(Math.round(r.memTotal/GiB));
  if(!disk.value&&r.volumes?.length&&!r.disks&&!r.interfaces)disk.value=String(Math.round(r.volumes.reduce((a,v)=>a+(v.total||0),0)/GB));};
 // How the machine is read now: /api/home → telemetry.connection (an older Windows alias also from telemetry.target).
 const currentConn=feed?(tel.connection||(viaWindows&&tel.target?{mode:'alias',target:tel.target}:null)):null;
 const parts={};
 const part=id=>parts[id]??=id==='thermo'?thermoPart({host:where,agent,defaultPort:offered.find(a=>a.id==='thermo')?.defaultPort})
  :ADAPTER_FORMS[id]({host:where,machineId:machine?.id||null,current:id===feed?currentConn:null,onFacts:fill});
 host.addEventListener('input',()=>{for(const x of Object.values(parts)){x.reset?.();x.hostChanged?.();}});
 // A site machine: what each field holds now, what the site says, and whether the owner's override sets it.
 const form0=siteMode?siteForm(machine):null;
 const siteHint=key=>form0?.overridden(key)?t('Upraveno; konfigurace webu: {value}',{value:form0.defaultText(key)}):null;
 const fields={name:field(t('Název'),name,siteHint('name')),hostname:field(t('Hostname nebo IP'),host,siteMode?siteHint('hostname')||t('jen k zobrazení; sondy a čtení dál používají adresu z konfigurace webu'):adding?null:t('kde je stroj v síti k zastižení')),
  ip:field(t('IP adresa'),ip,siteHint('ip')||(lan.length?t('v síti {networks}',{networks:lan.join(', ')}):t('když výše je jméno'))),role:field(t('Role'),role),
  platform:field(t('Systém'),platform,feed?t('čte se přes {name}; jiný systém až po odpojení telemetrie',{name:nameOf(feed)}):null),
  cpu:field(t('CPU'),cpu,siteHint('cpu')),gpu:field(t('GPU'),gpu,siteHint('gpu')),ramGb:field(t('RAM (GB)'),ram,siteHint('ramGb')),diskGb:field(t('Disk (GB)'),disk,siteHint('diskGb'))};
 // The form's values as it opened: a site machine's field the person did not touch keeps what it was (the site's, or
 // the override's), so opening and saving never turns a value the hub collected into an override.
 const initial={name:name.value,hostname:host.value,ip:ip.value,cpu:cpu.value,gpu:gpu.value,ramGb:String(ram.value),diskGb:String(disk.value)};
 const touched=key=>String(({name,hostname:host,ip,cpu,gpu,ramGb:ram,diskGb:disk})[key].value)!==initial[key];
 const holder=el('div',{class:'had-stack'}),choices=el('div',{class:'had-choices',role:'radiogroup','aria-label':t('Telemetrie')}),switchNote=el('p',{class:'had-note',hidden:''});
 const fitting=()=>feed?offered.filter(a=>FEED_PLATFORM[a.id]===FEED_PLATFORM[feed]):choicesFor(offered,platform.value);
 function drawChoices(){
  const fit=fitting();if(chosen&&!fit.some(a=>a.id===chosen))chosen=feed&&retarget?feed:null;
  choices.replaceChildren(...(feed?[]:[choice('had-telemetry','none',!chosen,t('Bez telemetrie'),t('dlaždice bez živých čísel; připojit jde kdykoli později'),()=>{chosen=null;sync();})]),
   ...fit.map(a=>choice('had-telemetry',a.id,chosen===a.id,feed?(a.id===feed?t('Změnit spojení {name}',{name:a.name}):t('Přepnout na {name}',{name:a.name})):t('Připojit {name}',{name:a.name}),
    [a.recommended?t('doporučeno'):null,a.summary?t(a.summary):null].filter(Boolean).join(' · ')||null,()=>{chosen=a.id;sync();})));
 }
 // Telemetry: only the chosen part is shown; choosing an agent-less provider sets the system it reads.
 const sync=()=>{
  if(chosen&&(!feed||retarget)){const x=part(chosen);holder.replaceChildren(x.node);if(Object.hasOwn(FEED_PLATFORM,chosen)){platform.value=FEED_PLATFORM[chosen];x.shown?.();}}else holder.replaceChildren();
  switchNote.hidden=!(feed&&retarget&&chosen&&chosen!==feed);
  switchNote.textContent=switchNote.hidden?'':t('Uložením se {old} odpojí a jeho klíč nebo heslo se smaže; historie metrik zůstane. Na stroji se nic nemění.',{old:nameOf(feed)});
 };
 platform.addEventListener('change',()=>{drawChoices();sync();});
 const disconnect=el('button',{type:'button',class:'ui-button hv-danger',onclick:async()=>{
  if(!await confirmDialog({title:t('Odpojit telemetrii?'),body:t('Home Hub zapomene účet {name} tohoto zařízení a přestane z něj číst. Historie metrik zůstane na disku.',{name:agent}),confirm:t('Odpojit'),danger:true,
   action:()=>post('/api/home/devices/thermo',{id:machine.id,thermo:null})}))return;
  dialog.close();onSaved?.();}},t('Odpojit telemetrii'));
 const disconnectFeed=el('button',{type:'button',class:'ui-button hv-danger',onclick:async()=>{
  const body=viaWindows?t('Home Hub zapomene spojení SSH tohoto zařízení i jeho klíč a přestane z něj číst. Na Windows se nic nemění: veřejný klíč Home Hubu tam z authorized_keys odeber sám, pokud chceš. Historie metrik zůstane na disku.')
   :t('Home Hub zapomene spojení {name} tohoto zařízení i jeho klíč nebo heslo a přestane z něj číst. Na stroji se nic nemění. Historie metrik zůstane na disku.',{name:nameOf(feed)});
  if(!await confirmDialog({title:t('Odpojit telemetrii?'),body,confirm:t('Odpojit'),danger:true,
   action:()=>viaWindows?post('/api/home/devices/windows',{id:machine.id,windows:null}):post('/api/home/devices/telemetry',{id:machine.id,telemetry:null})}))return;
  dialog.close();onSaved?.();}},t('Odpojit telemetrii'));
 const change=el('button',{type:'button',class:'ui-button',onclick:()=>{retarget=!retarget;chosen=retarget?feed:null;change.textContent=retarget?t('Nechat jak je'):t('Změnit nebo přepnout');choices.hidden=!retarget;drawChoices();sync();}},retarget?t('Nechat jak je'):t('Změnit nebo přepnout'));
 const describe=c=>!c?t('Zařízení se čte přes {name}.',{name:nameOf(feed)})
  :c.mode==='managed'?t('Zařízení se čte přes SSH jako {user}@{host}, port {port}, klíčem {key}. Jiný uživatel, klíč, adresa nebo nový klíč hostitele (třeba po přeinstalaci): změň připojení, ověř a vyzkoušej ho.',{user:c.user,host:c.host,port:c.port,key:c.keyFingerprint||'?'})
  :c.mode==='alias'?t('Zařízení se čte přes starší SSH alias {target} z konfigurace účtu, pod kterým běží Home Hub. Funguje dál; Změnit ho převede na spojení, které Home Hub spravuje sám (host, port, uživatel a vlastní klíč).',{target:c.target||'?'})
  :c.mode==='prometheus'?t('Zařízení se čte z Promethea {scheme}://{host}:{port}, cíl job {job}, instance {instance}.',{scheme:c.scheme,host:c.host,port:c.port,job:c.job,instance:c.instance})
  :t('Zařízení se čte přes {name}: {scheme}://{host}:{port}{user}.',{name:nameOf(feed),scheme:c.scheme||'https',host:c.host,port:c.port,user:c.user?' · '+c.user:''});
 drawChoices();
 if(feed)choices.hidden=!retarget;
 const telTitle=t('3 · Telemetrie');
 // A site machine whose telemetry is not this dialog's: who reads it, and that editing its name or address changes none of it.
 const siteTelemetryNote=siteMode&&!siteTelemetry?el('section',{class:'had-sec',id:'had-telemetry'},el('h3',{},telTitle),
  el('p',{class:'had-note'},machine.role==='router'?t('Router hlásí adaptér routeru (Administrace → Integrace), ne telemetrie hostitele; tady se nepřipojuje. Úprava názvu nebo adresy na jeho čtení nic nemění.')
   :machine.telemetry?.thermoId||machine.kind==='thermo'?t('Živá čísla čte agent Thermo podle konfigurace webu (thermoId) a přihlášení v souborech webu; tady se nemění. Úprava názvu nebo adresy na čtení nic nemění.')
   :t('Telemetrii tohoto stroje určuje konfigurace webu; tady se nemění.'))):null;
 const telemetry=siteTelemetryNote||(feed
  ?el('section',{class:'had-sec',id:'had-telemetry'},el('h3',{},telTitle),el('p',{class:'had-note'},describe(currentConn)),
   el('div',{class:'had-row'},change,disconnectFeed),choices,switchNote,holder)
  :connected
  ?el('section',{class:'had-sec'},el('h3',{},telTitle),el('p',{class:'had-note'},t('Zařízení je připojené k {name}. Jiné heslo nebo certifikát: odpoj a připoj znovu.',{name:agent})),el('div',{class:'had-row'},disconnect))
  :el('section',{class:'had-sec',id:'had-telemetry'},el('h3',{},telTitle),
   el('p',{class:'had-note'},siteMode?t('Vyber systém stroje a zdroj bez agenta: Linux (třeba NAS) přes Node Exporter, Prometheus, který už máš, nebo SSH; Windows přes SSH nebo WinRM. Thermo (agent pro macOS) se stroji z konfigurace webu nastavuje v konfiguraci webu (thermoId), ne tady.')
    :offered.length?t('Volitelné. Vyber zdroj živých čísel podle systému výše: agenta Thermo pro macOS, čítače Windows přes SSH nebo WinRM, nebo Linux přes Node Exporter, Prometheus či SSH. Nastavení spojení najdeš níže.')
    :t('Tenhle Home Hub zatím neumí připojit žádného telemetrického agenta. Zařízení bude mít dlaždici bez živých čísel.')),
   offered.length?choices:null,holder));
 if(siteMode&&!feed&&!fitting().length)holder.replaceChildren(el('p',{class:'had-note'},t('Pro systém, který uvádí konfigurace webu, tu žádný zdroj bez agenta není.')));
 if(!feed&&!connected&&focus==='telemetry'){const fit=fitting();chosen=(machine?.platform&&fit[0]?.id)||fit[0]?.id||null;drawChoices();}
 sync();
 const save=el('button',{type:'submit',class:'ui-button primary'},adding?t('Přidat zařízení'):t('Uložit'));
 const values=()=>({name:name.value,hostname:host.value,ip:ip.value,cpu:cpu.value,gpu:gpu.value,ramGb:ram.value,diskGb:disk.value,...(wantThermo()?part('thermo').value():{}),...(chosen==='windows'&&wantFeed()?part('windows').value():{})});
 function check(){
  const feedPart=wantFeed()&&chosen!=='windows'?part(chosen):null;
  const errors=validateDevice(values(),{lanCidrs:lan,needHost:adding,thermo:wantThermo(),windows:wantFeed()&&chosen==='windows',feed:feedPart?()=>feedPart.errors():null});
  // A site machine: a field the person left as it was is the site's (or the override's) business, not this form's.
  if(siteMode)for(const key of Object.keys(fields))if(!Object.hasOwn(initial,key)||!touched(key))delete errors[key];
  const shownParts=chosen&&parts[chosen]?[parts[chosen]]:[];
  const all={...fields,...Object.assign({},...shownParts.map(x=>x.fields))};
  for(const [key,f] of Object.entries(all))f.set(errors[key]);
  for(const x of shownParts)x.setProbe(errors.probe||errors.windowsTest||errors.endpointTest);
  const first=Object.keys(errors)[0];
  if(first){(all[first]||Object.values(shownParts[0]?.fields||{})[0])?.input.focus();say(t('Zkontroluj označená pole.'),true);}
  return !first;
 }
 const hardware=()=>({cpu:cpu.value.trim(),gpu:gpu.value.trim(),ramGb:ram.value?Number(ram.value):null,diskTotalBytes:disk.value?Math.round(Number(disk.value)*1e9):null});
 async function upload(id){
  const jpeg=await picture.crop();if(!jpeg)return;
  say(t('Nahrávám obrázek…'));const lost=authGuard(),r=await fetch(`/api/home/devices/${id}/image`,{method:'PUT',headers:{'Content-Type':'image/jpeg'},body:jpeg});lost(r);
  if(!r.ok){const d=await r.json().catch(()=>({}));throw new Error(t('Zařízení je uložené, ale obrázek se neuložil: {why}',{why:d.error?.message?t(d.error.message):r.status}));}
 }
 async function submit(){
  const pic=picture.value(),viaFeed=wantFeed(),x=chosen?parts[chosen]:null;
  if(adding){
   say(wantThermo()?t('Přihlašuji se do Thermo a ukládám…'):viaFeed?t('Ukládám spojení…'):t('Ukládám…'));
   const device=await post('/api/home/devices',{name:name.value.trim(),kind:wantThermo()?'thermo':viaFeed?chosen:'other',hostname:host.value.trim(),...(ip.value.trim()?{ip:ip.value.trim()}:{}),role:role.value,picture:pic.picture,props:hardware(),
    ...(platform.value?{platform:platform.value}:{}),...(wantThermo()?{thermo:x.body()}:{}),...(viaFeed?chosen==='windows'?{windows:x.body()}:{telemetry:x.body()}:{})});
   parts.thermo?.clear();if(viaFeed)x.saved();
   // The device exists from here on: a failed picture upload must not ask to add it again.
   try{if(pic.own)await upload(device.id);}finally{onSaved?.(device);}
   return;
  }
  // A site machine: the owner's override (never /api/home/machines, never site.json), its own picture, then the connection.
  if(siteMode){
   const body=form0.body({name,hostname:host,ip,cpu,gpu,ramGb:ram,diskGb:disk},touched,pic);
   try{
    if(JSON.stringify(body)!==JSON.stringify(form0.current())){say(t('Ukládám…'));await post('/api/home/devices/site',{id:machine.id,base:machine.siteOverride?.hash,machine:body});}
    if(pic.own)await upload(machine.id);
    else if(picture.hadOwn&&!pic.keepOwn)await post('/api/home/devices/image/remove',{id:machine.id});
    if(viaFeed){say(t('Ukládám spojení…'));await (chosen==='windows'?post('/api/home/devices/windows',{id:machine.id,windows:x.body()}):post('/api/home/devices/telemetry',{id:machine.id,telemetry:x.body()}));x.saved();}
   }finally{onSaved?.();}
   return;
  }
  say(t('Ukládám…'));
  // Connecting an agent-less provider makes the platform the one it reads; the server checks the same.
  const saved=await post('/api/home/machines',{machine:{id:machine.id,name:name.value.trim(),hostname:host.value.trim(),ip:ip.value.trim()||null,role:role.value,hardware:hardware(),thermoId:feed?null:machine.telemetry?.thermoId??null,picture:pic.picture,
   platform:viaFeed?FEED_PLATFORM[chosen]:feed?FEED_PLATFORM[feed]:platform.value||null},...(hash?{base:hash}:{})});
  hash=saved.hash;
  try{
   if(pic.own)await upload(machine.id);
   else if(machine.image&&!pic.keepOwn)await post('/api/home/devices/image/remove',{id:machine.id});
   if(wantThermo()){say(t('Přihlašuji se do Thermo a ukládám…'));await post('/api/home/devices/thermo',{id:machine.id,thermo:x.body()});x.clear();}
   if(viaFeed){say(t('Ukládám spojení…'));await (chosen==='windows'?post('/api/home/devices/windows',{id:machine.id,windows:x.body()}):post('/api/home/devices/telemetry',{id:machine.id,telemetry:x.body()}));x.saved();}
  }finally{onSaved?.();}
 }
 const form=el('form',{class:'had-form',novalidate:'',onsubmit:async e=>{
  e.preventDefault();if(!check())return;
  save.disabled=true;
  try{await submit();dialog.close();}catch(err){say(err.message,true);save.disabled=false;}
 }},
  picture.node,
  siteMode?siteIdentity(machine,fields,!(feed||machine.platform),{siteTelemetry,onReset:resetToSite})
  :el('section',{class:'had-sec'},el('h3',{},t('2 · Co to je')),
   el('div',{class:'had-grid two'},fields.name.node,fields.role.node,fields.hostname.node,fields.ip.node,fields.platform.node),
   el('div',{class:'had-grid four'},fields.cpu.node,fields.gpu.node,fields.ramGb.node,fields.diskGb.node)),
  telemetry,
  el('div',{class:'had-foot'},status,el('div',{class:'had-actions'},el('button',{type:'button',class:'ui-button',onclick:()=>dialog.close()},t('Zrušit')),save)));
 // Back to the site's values: the override and the uploaded picture go (the telemetry connection stays as it is).
 async function resetToSite(){
  if(!await confirmDialog({title:t('Obnovit výchozí z konfigurace webu?'),body:t('Název, adresa, hardware a obrázek stroje {name} budou zase podle konfigurace webu (local/site.json); nahraný obrázek se smaže. Telemetrie, služby a historie zůstanou.',{name:machine.name}),
   confirm:t('Obnovit výchozí'),action:()=>post('/api/home/devices/site/reset',{id:machine.id,base:machine.siteOverride?.hash})}))return;
  dialog.close();onSaved?.();
 }
 const title=el('h2',{id:'had-title'},adding?t('Přidat zařízení'):siteMode?(focus==='telemetry'||focus==='site'?t('Nastavení telemetrie'):t('Upravit stroj')):t('Upravit zařízení'));
 const dialog=el('dialog',{class:'had','aria-labelledby':'had-title'},
  el('div',{class:'had-head'},el('div',{},title,el('p',{class:'had-dim'},adding?t('Zařízení se objeví jako další dlaždice v přehledu.'):siteMode?t('{name} · id {id} · z konfigurace webu',{name:machine.name,id:machine.id}):t('{name} · id {id}',{name:machine.name,id:machine.id}))),
   el('button',{type:'button',class:'had-close','aria-label':t('Zavřít'),onclick:()=>dialog.close()},'×')),form);
 dialog.addEventListener('close',()=>{parts.thermo?.clear();picture.dispose();for(const x of Object.values(parts))x.dispose?.();dialog.remove();});
 document.body.append(dialog);dialog.showModal();
 if(focus==='telemetry'||focus==='site')dialog.querySelector('#had-telemetry')?.scrollIntoView?.({block:'start'});else name.focus();
 return dialog;
}
export const openAddDevice=({meta,onSaved})=>deviceDialog({meta,onSaved});
export const openEditDevice=({machine,meta,focus,onSaved})=>deviceDialog({machine,meta,focus,onSaved});
// A machine of the site configuration, in its site editor: Edit machine opens at its name; its telemetry settings open the
// same dialog at the telemetry part (unconnected: at the provider choice; connected: at what reads it now).
export const openSiteEdit=({machine,meta,onSaved})=>deviceDialog({machine,meta,onSaved});
export const openSiteTelemetry=({machine,meta,onSaved})=>deviceDialog({machine,meta,focus:machine?.telemetryBinding?'site':'telemetry',onSaved});
// What the site editor needs of a site machine (GET /api/home → siteOverride, siteDefaults):
//   overridden(key)  the owner's override sets this form field     defaultText(key)  what the site says, as text
//   current()        the override as stored now (what the form would send unchanged)
//   body(inputs, touched, picture)  the override to save: a field the person changed, or one already overridden, is sent;
//                    the server drops what equals the site's value. A field left out goes back to the site's.
const FORM_KEY={name:'name',hostname:'hostname',ip:'ip',cpu:'hardware.cpu',gpu:'hardware.gpu',ramGb:'hardware.ramGb',diskGb:'hardware.diskTotalBytes'};
export function siteForm(m){
 const over=new Set(m.siteOverride?.fields||[]),d=m.siteDefaults||{},dh=d.hardware||{},p=m.props||{};
 const overridden=key=>over.has(FORM_KEY[key]);
 const defaultText=key=>{const v=key==='diskGb'?(dh.diskTotalBytes!=null?`${Math.round(dh.diskTotalBytes/1e9)} GB`:null):key==='ramGb'?(dh.ramGb!=null?`${dh.ramGb} GB`:null)
  :Object.hasOwn(dh,key)?dh[key]:d[key];return v===null||v===undefined||v===''?t('(prázdné)'):String(v);};
 const shown={name:m.name,hostname:m.hostname||'',ip:m.ip||'',cpu:p.cpu||'',gpu:p.gpu??'',ramGb:p.ramGb??null,diskTotalBytes:p.diskTotalBytes??null};
 const assemble=(pick,picture)=>{const out={},hw={};
  for(const k of ['name','hostname','ip']){const v=pick(k);if(v!==undefined)out[k]=v;}
  for(const [k,f] of [['cpu','cpu'],['gpu','gpu'],['ramGb','ramGb'],['diskGb','diskTotalBytes']]){const v=pick(k);if(v!==undefined)hw[f]=v;}
  if(Object.keys(hw).length)out.hardware=hw;if(picture)out.picture=picture;return out;};
 return {overridden,defaultText,
  current:()=>assemble(k=>overridden(k)?shown[k==='diskGb'?'diskTotalBytes':k]:undefined,over.has('picture')?m.pictureId||null:null),
  body(inputs,touched,pic){
   const typed=k=>{const v=String(inputs[k].value).trim();return k==='ramGb'?(v?Number(v):null):k==='diskGb'?(v?Math.round(Number(v)*1e9):null):v;};
   return assemble(k=>touched(k)?typed(k):overridden(k)?shown[k==='diskGb'?'diskTotalBytes':k]:undefined,!pic.site&&!pic.own&&!pic.keepOwn?pic.picture:null);
  }};
}
// A site machine in its editor: its name, address and hardware (the owner's override over the site's values), what stays
// in the site configuration (id, role, the system when the site names one, the collectors' wiring), and the reset.
function siteIdentity(m,fields,choosable,{siteTelemetry,onReset}){
 const role=ROLES.find(([id])=>id===m.role)?.[1]||'Jiné zařízení',system=PLATFORMS.find(([id])=>id===(m.platform||''))?.[1];
 const changed=Boolean(m.siteOverride?.fields?.length||m.siteOverride?.image);
 const rows=[['Id',m.id],[t('Role'),t(role)],[t('Systém'),m.platform&&!choosable?t(system||m.platform):null]].filter(([,v])=>v);
 return el('section',{class:'had-sec had-site'},el('h3',{},t('2 · Co to je')),
  el('p',{class:'had-note'},t('Stroj je z konfigurace webu (local/site.json). Název, adresa, hardware a obrázek, které tu změníš, Home Hub uloží jako tvoje úpravy nad hodnotami z konfigurace webu; soubor se nepřepíše. Id, role, systém a napojení (SSH, Thermo, sondy služeb, adaptér routeru) zůstávají podle konfigurace webu a sondy dál používají její adresy. Stroj tu nejde odebrat.')),
  el('div',{class:'had-grid two'},fields.name.node,fields.hostname.node,fields.ip.node,siteTelemetry&&choosable?fields.platform.node:null),
  el('div',{class:'had-grid four'},fields.cpu.node,fields.gpu.node,fields.ramGb.node,fields.diskGb.node),
  el('dl',{class:'had-readonly'},rows.map(([k,v])=>el('div',{},el('dt',{},k),el('dd',{},String(v))))),
  changed?el('div',{class:'had-row'},el('span',{class:'had-dim'},m.siteOverride?.updatedBy?t('Upravil {who} {when}.',{who:m.siteOverride.updatedBy,when:String(m.siteOverride.updatedAt||'').slice(0,10)}):t('Upraveno v přehledu.')),
   el('button',{type:'button',class:'ui-button','data-action':'site-reset',onclick:onReset},t('Obnovit výchozí z konfigurace webu'))):null);
}

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
 body:t('Zmizí z přehledu i se svým obrázkem, uloženým přihlášením k telemetrii a zveřejněným runtime stackem. Historie metrik zůstane na disku.'),
 action:()=>post('/api/home/machines/remove',{id:machine.id,base:machine.hash})});
