// Přehled → ⊕ Přidat zařízení: one dialog with the picture (a 3:2 frame you move and resize over it, cropped
// here to JPEG), what the device is and, for live metrics, its Thermo account. Thermo devices are checked
// before saving: "Ověřit spojení" reads the certificate fingerprint without sending anything, you confirm it
// matches the one Thermo shows, and only then the password goes to the server (which logs in once, pinned).
import {el} from './views.js';
import {authGuard} from './session-cache.js';
import {t} from './i18n.js';

const RATIO=3/2,OUT_W=1536,OUT_H=1024;
async function post(url,body){
 const lost=authGuard(),r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});lost(r);
 const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error?.message||t('Požadavek selhal.'));return d;
}
const groups=hex=>hex.toUpperCase().match(/.{2}/g).join(':');

// The picture with a 3:2 frame on top: drag the frame to move it, drag its corner to resize it.
// crop() → a JPEG Blob of what is inside the frame (at most 1536×1024), or null with no picture.
function cropper(onChange=()=>{}){
 let img=null,url=null,frame={x:0,y:0,w:0},drag=null;
 const stage=el('div',{class:'had-stage'}),pic=el('img',{alt:'',draggable:'false'}),box=el('div',{class:'had-frame',tabindex:'0','aria-label':t('Výřez obrázku: šipky posouvají, Shift+šipky mění velikost')}),
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

// onSaved(device) after the device (and its picture) is stored.
export function openAddDevice({onSaved}){
 const cropInfo=el('span',{class:'had-dim'}),crop=cropper(()=>{cropInfo.textContent=crop?.info()||'';}),msg=el('p',{class:'had-msg',role:'status'});
 const file=el('input',{type:'file',accept:'image/*'});
 file.addEventListener('change',async()=>{const f=file.files?.[0];if(!f)return;try{await crop.load(f);cropInfo.textContent=crop.info();msg.textContent='';}catch(e){fail(e);}});
 const input=(attrs)=>el('input',{autocomplete:'off',spellcheck:'false',...attrs});
 const name=input({required:'',maxlength:'60',placeholder:'Mac (obývák)'}),host=input({required:'',maxlength:'253',placeholder:'mac.example.lan / 10.0.0.30'}),
  ip=input({maxlength:'15',placeholder:'10.0.0.30',inputmode:'decimal'}),cpu=input({maxlength:'60',placeholder:'M4 · 10j'}),gpu=input({maxlength:'40',placeholder:'10c'}),
  ram=input({type:'number',min:'1',max:'65536',step:'1',placeholder:'32'});
 const port=input({type:'number',min:'1024',max:'65535',value:'49286'}),user=input({maxlength:'32',value:'homehub'}),pass=input({type:'password',minlength:'12',maxlength:'256',autocomplete:'new-password'});
 const kind=el('div',{class:'had-kinds',role:'radiogroup','aria-label':t('Typ zařízení')});
 const kinds=[['thermo',t('Mac s Thermo'),t('živé CPU, GPU, paměť, příkon a teploty')],['other',t('Jiné zařízení'),t('dlaždice s obrázkem a údaji, bez živých čísel')]];
 let current='thermo',fingerprint=null;
 const radios=kinds.map(([v,label,sub])=>{const r=el('input',{type:'radio',name:'had-kind',value:v,checked:v===current?'':null,onchange:()=>{current=v;sync();}});
  return el('label',{class:'had-kind'},r,el('span',{},el('b',{},label),el('small',{},sub)));});
 kind.append(...radios);
 const probeOut=el('div',{class:'had-probe',hidden:''}),confirmBox=el('input',{type:'checkbox'});
 const resetProbe=()=>{fingerprint=null;probeOut.hidden=true;probeOut.replaceChildren();confirmBox.checked=false;};
 host.addEventListener('input',resetProbe);port.addEventListener('input',resetProbe);
 const probe=el('button',{type:'button',class:'acc-btn small',onclick:async()=>{
  resetProbe();if(!host.value.trim())return fail(new Error(t('Nejdřív vyplň hostname nebo IP.')));probe.disabled=true;msg.textContent=t('Zkouším spojení…');msg.classList.remove('error');
  try{const r=await post('/api/home/devices/probe',{host:host.value.trim(),port:Number(port.value)||49286});fingerprint=r.fingerprint;msg.textContent='';
   probeOut.replaceChildren(el('div',{class:'had-dim'},t('Thermo odpovídá. Otisk certifikátu (SHA-256):')),el('code',{class:'had-fp'},groups(r.fingerprint)),
    r.subject?el('div',{class:'had-dim'},`CN ${r.subject}${r.validTo?' · '+t('platí do')+' '+r.validTo:''}`):null,
    el('label',{class:'had-check'},confirmBox,t('Otisk sedí s tím, co ukazuje Thermo na tom zařízení (Nastavení → Síť).')));probeOut.hidden=false;}
  catch(e){fail(e);}finally{probe.disabled=false;}}},t('Ověřit spojení'));
 const field=(label,node,hint)=>el('label',{},t(label),node,hint?el('small',{class:'had-hint'},t(hint)):null);
 const needs=el('ol',{class:'had-needs'},
  el('li',{},t('Na zařízení běží Thermo a má zapnutý přístup po síti (výchozí port 49286).')),
  el('li',{},t('V Thermo je účet pro Home Hub — uživatel (třeba homehub) a heslo aspoň 12 znaků. Heslo se uloží jen na serveru (soubor 0600), ne do prohlížeče ani gitu.')),
  el('li',{},t('Home Hub na zařízení dosáhne: hostname nebo IP v domácí síti, port povolený ve firewallu.')),
  el('li',{},t('Ověř spojení a porovnej otisk certifikátu s tím, co ukazuje Thermo. Heslo pak chodí jen na tenhle certifikát.')));
 const thermoPart=el('fieldset',{class:'had-thermo'},el('legend',{},t('Thermo')),needs,
  el('div',{class:'had-grid'},field('Port',port),field('Uživatel v Thermo',user),field('Heslo v Thermo',pass)),el('div',{class:'had-row'},probe),probeOut);
 const otherNote=el('p',{class:'had-note',hidden:''},t('Jiné zařízení (NAS, PC, tiskárna…) dostane dlaždici s obrázkem, adresou a parametry. Živé metriky přidáš později, až pro něj bude collector.'));
 const sync=()=>{thermoPart.hidden=current!=='thermo';otherNote.hidden=current==='thermo';};
 const fail=e=>{msg.textContent=e.message;msg.classList.add('error');};
 const save=el('button',{type:'submit',class:'acc-btn primary'},t('Přidat zařízení'));
 const form=el('form',{class:'acc-form had-form',novalidate:'',onsubmit:async e=>{
  e.preventDefault();msg.classList.remove('error');
  if(!name.value.trim()||!host.value.trim())return fail(new Error(t('Vyplň název a hostname nebo IP.')));
  const body={name:name.value.trim(),kind:current,hostname:host.value.trim(),...(ip.value.trim()?{ip:ip.value.trim()}:{}),
   props:{cpu:cpu.value.trim(),gpu:gpu.value.trim(),ramGb:ram.value?Number(ram.value):null}};
  if(current==='thermo'){
   if(pass.value.length<12)return fail(new Error(t('Heslo účtu v Thermo má aspoň 12 znaků.')));
   if(!fingerprint)return fail(new Error(t('Nejdřív ověř spojení.')));
   if(!confirmBox.checked)return fail(new Error(t('Potvrď, že otisk sedí s tím v Thermo.')));
   body.thermo={port:Number(port.value)||49286,username:user.value.trim(),password:pass.value,pin:fingerprint};
  }
  save.disabled=true;msg.textContent=current==='thermo'?t('Přihlašuji se do Thermo a ukládám…'):t('Ukládám…');
  try{
   const device=await post('/api/home/devices',body);pass.value='';
   const jpeg=await crop.crop();
   if(jpeg){msg.textContent=t('Nahrávám obrázek…');const lost=authGuard(),r=await fetch(`/api/home/devices/${device.id}/image`,{method:'PUT',headers:{'Content-Type':'image/jpeg'},body:jpeg});lost(r);
    if(!r.ok){const d=await r.json().catch(()=>({}));onSaved?.(device);msg.textContent=t('Zařízení je přidané, ale obrázek se neuložil: {why}',{why:d.error?.message||r.status});msg.classList.add('error');save.disabled=false;return;}}
   dialog.close();onSaved?.(device);
  }catch(err){fail(err);save.disabled=false;}
 }},
  el('section',{class:'had-sec'},el('h4',{},t('1 · Obrázek')),el('div',{class:'had-row'},file,cropInfo),crop.node,
   el('small',{class:'had-hint'},t('Táhni rámeček, roh mění velikost (nebo šipky, Shift+šipky). Na dlaždici bude přesně to, co je v rámečku (3:2).'))),
  el('section',{class:'had-sec'},el('h4',{},t('2 · Co to je')),kind,
   el('div',{class:'had-grid'},field('Název',name),field('Hostname nebo IP',host),field('IP (když výše je jméno)',ip),field('CPU',cpu),field('GPU',gpu),field('RAM (GB)',ram))),
  el('section',{class:'had-sec'},el('h4',{},t('3 · Připojení')),thermoPart,otherNote),
  msg,el('div',{class:'had-actions'},el('button',{type:'button',class:'acc-btn',onclick:()=>dialog.close()},t('Zrušit')),save));
 sync();
 const dialog=el('dialog',{class:'acc-dialog wide had'},el('h3',{},t('Přidat zařízení')),el('p',{class:'acc-dim'},t('Zařízení se objeví jako další dlaždice v přehledu.')),form);
 dialog.addEventListener('close',()=>{pass.value='';crop.dispose();dialog.remove();});
 document.body.append(dialog);dialog.showModal();name.focus();
 return dialog;
}

// Removing an added device (its page → Odebrat). Built-in machines cannot be removed.
export async function removeDevice(device){
 if(!confirm(t('Odebrat {name} z přehledu? Smaže se i jeho obrázek a uložené přihlášení do Thermo; historie metrik zůstane na disku.',{name:device.name})))return false;
 await post('/api/home/devices/remove',{id:device.id});return true;
}
