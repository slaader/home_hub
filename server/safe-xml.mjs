// A small, strict XML reader for the SOAP replies of WinRM (server/winrm-telemetry.mjs). Not a general XML
// parser on purpose: it reads elements, attributes and text, and refuses everything that makes XML dangerous
// or large:
//   - no DTD at all (<!DOCTYPE …>), so no entity can be declared, expanded or fetched; <!ENTITY …> likewise
//   - only the five predefined entities (&lt; &gt; &amp; &quot; &apos;) and numeric character references to
//     valid code points; any other &name; is an error, never left in or looked up
//   - no CDATA sections and no processing instructions other than the leading <?xml …?> declaration
//   - bounded: input size, depth, number of elements, attributes per element, text per element
// Names keep their prefix; local() gives the part after ":" (namespaces are not resolved: the caller matches
// local names of a reply whose shape it knows). Errors are Error('bad-xml').
export const XML_LIMITS=Object.freeze({bytes:4*1024*1024,depth:64,nodes:200000,attributes:32,text:1<<20});
const fail=()=>{throw new Error('bad-xml');};
const NAME=/^[A-Za-z_][A-Za-z0-9._:-]{0,127}$/;
export const local=name=>{const i=String(name).indexOf(':');return i<0?name:name.slice(i+1);};

function decode(s){
 if(!s.includes('&'))return s;
 return s.replace(/&(?:([^;&\s<]{1,12});)?/g,(m,ref)=>{
  if(ref===undefined)fail();// a bare "&" that starts no reference
  const names={lt:'<',gt:'>',amp:'&',quot:'"',apos:"'"};if(Object.hasOwn(names,ref))return names[ref];
  const n=/^#x([0-9a-fA-F]{1,6})$/.test(ref)?parseInt(ref.slice(2),16):/^#(\d{1,7})$/.test(ref)?Number(ref.slice(1)):NaN;
  if(!Number.isInteger(n)||n===0||n>0x10ffff||(n>=0xd800&&n<=0xdfff))fail();
  return String.fromCodePoint(n);
 });
}
// → the root element {name, attrs:{}, children:[], text}. text = the element's own character data, decoded.
export function parseXml(input,limits=XML_LIMITS){
 const s=Buffer.isBuffer(input)?input.toString('utf8'):String(input??'');
 if(Buffer.byteLength(s,'utf8')>limits.bytes)fail();
 if(/<!DOCTYPE|<!ENTITY|<!\[CDATA\[/i.test(s))fail();
 let i=0,nodes=0,root=null;const stack=[];
 const skipDecl=()=>{if(s.startsWith('﻿',i))i++;while(/\s/.test(s[i]||''))i++;
  if(s.startsWith('<?xml',i)){const end=s.indexOf('?>',i);if(end<0)fail();i=end+2;}};
 skipDecl();
 while(i<s.length){
  const lt=s.indexOf('<',i);
  const chunk=lt<0?s.slice(i):s.slice(i,lt);
  if(chunk){const top=stack.at(-1);if(!top){if(chunk.trim())fail();}else{top.text+=decode(chunk);if(top.text.length>limits.text)fail();}}
  if(lt<0)break;
  i=lt;
  if(s.startsWith('<!--',i)){const end=s.indexOf('-->',i+4);if(end<0)fail();i=end+3;continue;}
  if(s[i+1]==='?'||s[i+1]==='!')fail();// processing instructions, declarations
  if(s[i+1]==='/'){
   const end=s.indexOf('>',i);if(end<0)fail();
   const name=s.slice(i+2,end).trim();const top=stack.pop();
   if(!top||top.name!==name)fail();
   i=end+1;if(!stack.length){root=top;break;}continue;
  }
  // A start tag: name, attributes, maybe "/>". Attribute values are quoted; ">" inside quotes is allowed.
  let j=i+1;const nameEnd=(()=>{while(j<s.length&&!/[\s/>]/.test(s[j]))j++;return j;})();
  const name=s.slice(i+1,nameEnd);if(!NAME.test(name))fail();
  const attrs={};let count=0;
  for(;;){
   while(/\s/.test(s[j]||''))j++;
   if(s[j]==='>'){j++;break;}
   if(s[j]==='/'&&s[j+1]==='>'){j+=2;break;}
   const eq=s.indexOf('=',j);if(eq<0)fail();
   const an=s.slice(j,eq).trim();if(!NAME.test(an))fail();
   let k=eq+1;while(/\s/.test(s[k]||''))k++;
   const q=s[k];if(q!=='"'&&q!=="'")fail();
   const close=s.indexOf(q,k+1);if(close<0)fail();
   const raw=s.slice(k+1,close);if(raw.includes('<'))fail();
   if(++count>limits.attributes)fail();
   attrs[an]=decode(raw);j=close+1;
  }
  const selfClosing=s[j-2]==='/'&&s[j-1]==='>';
  const node={name,attrs,children:[],text:''};
  if(++nodes>limits.nodes)fail();
  if(stack.length)stack.at(-1).children.push(node);else if(root)fail();
  if(selfClosing){if(!stack.length){root=node;i=j;break;}}
  else{stack.push(node);if(stack.length>limits.depth)fail();}
  i=j;
 }
 if(stack.length||!root)fail();
 if(s.slice(i).replace(/<!--[\s\S]*?-->/g,'').trim())fail();
 return root;
}
// Helpers over the tree: the first / every descendant whose local name is name (depth-first).
export function find(node,name){if(!node)return null;for(const c of node.children){if(local(c.name)===name)return c;const d=find(c,name);if(d)return d;}return null;}
export const child=(node,name)=>node?.children.find(c=>local(c.name)===name)||null;
export const childrenOf=(node,name)=>node?node.children.filter(c=>local(c.name)===name):[];
