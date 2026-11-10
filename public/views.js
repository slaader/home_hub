import {timeZone} from './site.js';
export function el(tag, attrs={}, ...children){
  const node=document.createElement(tag);
  for(const [key,value] of Object.entries(attrs)){
    if(key.startsWith('on'))node.addEventListener(key.slice(2),value);
    else if(value!==undefined&&value!==null)node.setAttribute(key,value);
  }
  for(const child of children.flat(Infinity))if(child!==undefined&&child!==null)node.append(child instanceof Node?child:document.createTextNode(String(child)));
  return node;
}
// Page lifetime. A view registers with onLeave() what must be undone when it goes (listeners on document or
// window, timers); the shell (app.js) calls leaveView() before it draws the next page or the sign-in.
const leaving=new Set();
export function onLeave(fn){leaving.add(fn);return ()=>leaving.delete(fn);}
export function leaveView(){const fns=[...leaving];leaving.clear();for(const fn of fns)try{fn();}catch{}}
export const date=value=>value&&Number.isFinite(Date.parse(value))?new Intl.DateTimeFormat('en-GB',{dateStyle:'medium',timeStyle:'short',timeZone:timeZone()}).format(new Date(value)):'Not recorded';
export const badge=(text,tone='')=>el('span',{class:`badge ${tone}`},text);
