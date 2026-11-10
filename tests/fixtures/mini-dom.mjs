// A tiny DOM for driving real view code under node:test: elements, text, listeners with capture and
// AbortSignal, and event dispatch with capture → target → bubble through window → document → … → target.
// Only what the inventory map uses; selectors in closest() are '.class' only.
export class Node {
  constructor(){this.parentNode=null;this.childNodes=[];this.listeners=[];}
  get isConnected(){let n=this;while(n.parentNode)n=n.parentNode;return n===globalThis.document;}
  get children(){return this.childNodes.filter(n=>n instanceof Element);}
  append(...items){for(const c of items){const n=c instanceof Node?c:new Text(String(c));n.remove();n.parentNode=this;this.childNodes.push(n);}}
  remove(){if(!this.parentNode)return;const a=this.parentNode.childNodes;a.splice(a.indexOf(this),1);this.parentNode=null;}
  replaceChildren(...items){for(const c of [...this.childNodes])c.remove();this.append(...items);}
  get textContent(){return this.childNodes.map(n=>n.textContent).join('');}
  set textContent(v){this.replaceChildren(String(v));}
  addEventListener(type,fn,opts){
    const capture=typeof opts==='boolean'?opts:!!opts?.capture,signal=opts?.signal;if(signal?.aborted)return;
    const l={type,fn,capture};this.listeners.push(l);
    signal?.addEventListener('abort',()=>{const i=this.listeners.indexOf(l);if(i>=0)this.listeners.splice(i,1);});
  }
  removeEventListener(type,fn,opts){const capture=typeof opts==='boolean'?opts:!!opts?.capture;this.listeners=this.listeners.filter(l=>!(l.type===type&&l.fn===fn&&l.capture===capture));}
}
export class Text extends Node {constructor(data){super();this.data=data;}get textContent(){return this.data;}}
export class Element extends Node {
  constructor(tag){super();this.tagName=tag;this.attrs=new Map();}
  setAttribute(k,v){this.attrs.set(k,String(v));}
  getAttribute(k){return this.attrs.has(k)?this.attrs.get(k):null;}
  removeAttribute(k){this.attrs.delete(k);}
  hasAttribute(k){return this.attrs.has(k);}
  get classList(){const self=this,list=()=>(self.getAttribute('class')||'').split(/\s+/).filter(Boolean),set=a=>self.setAttribute('class',a.join(' '));
    return {contains:c=>list().includes(c),add:(...cs)=>set([...new Set([...list(),...cs])]),remove:(...cs)=>set(list().filter(x=>!cs.includes(x))),
      toggle:(c,force)=>{const on=force??!list().includes(c);on?this.classList.add(c):this.classList.remove(c);return on;}};}
  closest(sel){const c=sel.replace(/^\./,'');for(let n=this;n instanceof Element;n=n.parentNode)if(n.classList.contains(c))return n;return null;}
  querySelectorAll(sel){const out=[],c=sel.replace(/^\./,''),visit=n=>{for(const k of n.children){if(k.classList.contains(c))out.push(k);visit(k);}};visit(this);return out;}
  querySelector(sel){return this.querySelectorAll(sel)[0]||null;}
  getScreenCTM(){return {a:globalThis.document.screenScale??1};}
  // Explicit capture: later events of that pointer go to this element (see fire), as in a browser.
  setPointerCapture(id){globalThis.document.captures.set(id,this);}
  releasePointerCapture(id){if(this.hasPointerCapture(id))globalThis.document.captures.delete(id);}
  hasPointerCapture(id){return globalThis.document.captures.get(id)===this;}
  focus(){}
  close(){}
}
export class Document extends Node {
  constructor(){super();this.visibilityState='visible';this.screenScale=1;this.captures=new Map();this.body=new Element('body');this.append(this.body);}
  createElement(tag){return new Element(tag);}
  createElementNS(_ns,tag){return new Element(tag);}
  createTextNode(t){return new Text(t);}
  querySelector(sel){return sel.startsWith('.')?this.body.querySelector(sel):null;}
}
// Dispatch `type` at `target` the way a browser does, window first. Returns the event. A pointer event of a
// captured pointer goes to the capturing element instead; pointerup/pointercancel then release the capture
// and fire lostpointercapture (at the document if the element has left it).
export function fire(target,type,props={}){
  const doc=globalThis.document,id=props.pointerId,cap=/^pointer(move|up|cancel)$/.test(type)?doc.captures.get(id):null;
  if(cap){
    if(cap.isConnected)target=cap;
    if(type!=='pointermove'){doc.captures.delete(id);const ev=dispatch(target,type,props);dispatch(cap.isConnected?cap:doc,'lostpointercapture',{...props,buttons:0});return ev;}
  }
  return dispatch(target,type,props);
}
function dispatch(target,type,props){
  const path=[];for(let n=target;n;n=n.parentNode)path.unshift(n);
  if(path[0]===globalThis.document)path.unshift(globalThis.window);
  let stopped=false;
  const ev={type,target,currentTarget:null,bubbles:true,defaultPrevented:false,eventPhase:0,
    preventDefault(){this.defaultPrevented=true;},stopPropagation(){stopped=true;},stopImmediatePropagation(){stopped=true;},...props};
  const run=(n,phase)=>{ev.currentTarget=n;ev.eventPhase=phase;
    for(const l of [...n.listeners])if(l.type===type&&(phase===2||(phase===1)===l.capture)&&n.listeners.includes(l))l.fn.call(n,ev);};
  for(const n of path.slice(0,-1)){if(stopped)break;run(n,1);}
  if(!stopped)run(target,2);
  if(ev.bubbles)for(const n of path.slice(0,-1).reverse()){if(stopped)break;run(n,3);}
  ev.currentTarget=null;return ev;
}
// Install as globals (document, window, Node, localStorage) and return them.
export function installDom(){
  const document=new Document(),window=new Node(),store=new Map();
  const localStorage={getItem:k=>store.has(k)?store.get(k):null,setItem:(k,v)=>store.set(k,String(v)),removeItem:k=>store.delete(k),clear:()=>store.clear()};
  Object.assign(globalThis,{document,window,Node,localStorage});
  return {document,window,localStorage};
}
