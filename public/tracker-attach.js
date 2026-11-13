// Files on a ticket, for the tracker pages (tracker-view.js): what a file is called and how it is drawn.
//   ![name]        in a description or a comment points at the ticket's file of that name (tracker-md.js);
//                  fileChip() draws it: a small icon, the name and the size
//   fileStrip()    the files as tiles with a preview, and × to take one away
//   openViewer()   one file in a dialog: a picture, a player for audio and video, text; anything else is a download
//   chipEditor()   a text field that shows ![name] as chips while it is edited. The <textarea> stays the form
//                  field and always holds the plain text; a browser without plaintext-only editing keeps the
//                  textarea, with the tokens as text. In the box a chip is an <input type="button">
// A file here is {name,type,size,url,download?,note?,file?,gone?}: a saved attachment (url on the server; `note`
// is who attached it and when), one that
// waits for its ticket or is still uploading (`file`, url is an object URL of it), or one the ticket no longer
// has (`gone`: only the name is left).
import {el} from './views.js';
import {t} from './i18n.js';
import {FILE_TOKEN} from './tracker-md.js';

// The server's limits (server/ticket-files.mjs, server/tickets-store.mjs); it checks them again.
export const FILE_MAX=100*1024*1024,FILES_MAX=20;
export const fileSize=n=>n<1024?`${n} B`:n<1048576?`${Math.round(n/1024)} kB`:`${(n/1048576).toFixed(1)} MB`;
export const fileToken=name=>`![${name}]`;
export const fileKind=type=>{const s=String(type||'');return s.startsWith('image/')?'image':s.startsWith('audio/')?'audio':s.startsWith('video/')?'video':s==='text/plain'?'text':s==='application/pdf'?'pdf':'file';};
const GLYPH={image:'▣',audio:'♪',video:'▶',text:'≡',pdf:'▤',file:'📎'};
const extension=name=>/\.([A-Za-z0-9]{1,5})$/.exec(name)?.[1].toUpperCase()||'';
const TEXT_NAME=/\.(txt|md|log|json|csv|ya?ml|toml|ini|conf|sh|mjs|js|ts|py|html|css|xml|diff|patch)$/i;
// What the server will most likely call a file it has not seen yet. It decides from the bytes; this is only
// for the preview of a file that waits.
export function localType(file){
 const type=String(file.type||'');
 if(TEXT_NAME.test(file.name||''))return 'text/plain';
 return /^image\/(png|jpeg|gif|webp)$/.test(type)||/^(audio|video)\//.test(type)||type==='application/pdf'?type:'application/octet-stream';
}
const clip=(s,max)=>{let out='';for(const ch of s){if(out.length+ch.length>max)break;out+=ch;}return out;};
// The name a file is stored under: what the server makes of it anyway (cleanName in server/ticket-files.mjs),
// without the brackets a ![name] cannot hold, and not the name of another file of the ticket (image.png,
// image-2.png, …), so that a name points at one file.
export function attachmentName(file,taken=[]){
 const used=new Set([...taken].map(n=>String(n).toLowerCase())),raw=String(file.name||''),whole=typeof raw.toWellFormed==='function'?raw.toWellFormed():raw;
 const name=whole.split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f"]/g,'').replace(/\[/g,'(').replace(/\]/g,')').trim()
  ||'file'+({'image/png':'.png','image/jpeg':'.jpg','image/gif':'.gif','image/webp':'.webp'}[file.type]||'');
 const dot=name.lastIndexOf('.'),ext=dot>0&&name.length-dot<=12?name.slice(dot):'',stem=clip(ext?name.slice(0,dot):name,110-ext.length).trim()||'file';
 let out=stem+ext;for(let i=2;used.has(out.toLowerCase());i++)out=`${stem}-${i}${ext}`;
 return out;
}
export const savedFile=(ticket,a)=>{const url=`/api/tickets/${encodeURIComponent(ticket)}/attachments/${a.id}`;return {...a,url,download:url+'?download=1'};};
export const pendingFile=(file,name)=>({name,type:localType(file),size:file.size,url:URL.createObjectURL(file),file});
export const releaseFile=item=>{if(item?.file)try{URL.revokeObjectURL(item.url);}catch{}};
// The files of a paste. Text copied from an office application carries a picture of itself next to the text
// and its formatting: that is a paste of text, and the browser handles it.
export function pastedFiles(e){
 const data=e.clipboardData,list=[...(data?.files||[])],types=[...(data?.types||[])];
 return list.length&&!(types.includes('text/plain')&&(types.includes('text/html')||types.includes('text/rtf')))?list:[];
}

// ![name] where the text is read or edited: icon, name, size. With onOpen it opens the file on a click.
export function fileChip(item,{onOpen=null}={}){
 const kind=fileKind(item.type),gone=item.gone===true;
 const chip=el('span',{class:`tk-fchip${gone?' gone':''}`,'data-file':item.name,title:gone?t('Příloha {name} už u položky není.',{name:item.name}):item.name},
  kind==='image'&&item.url?el('img',{class:'tk-fchip-thumb',src:item.url,alt:'',loading:'lazy',draggable:'false'}):el('span',{class:'tk-fchip-glyph','aria-hidden':'true'},gone?'∅':GLYPH[kind]),
  el('span',{class:'tk-fchip-name'},item.name),Number.isFinite(item.size)?el('span',{class:'tk-fchip-size'},fileSize(item.size)):null);
 if(onOpen&&!gone){
  chip.setAttribute('role','button');chip.setAttribute('tabindex','0');
  chip.addEventListener('click',e=>{e.preventDefault();onOpen(item);});
  chip.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();onOpen(item);}});
 }
 return chip;
}

// The files as tiles: a picture shows itself, anything else its kind and extension. onOpen(index) opens one;
// onRemove(item, button), when given, puts × on every tile.
export function fileStrip(items,{onOpen,onRemove=null}={}){
 return el('ul',{class:'tk-tiles'},items.map((item,i)=>{
  const kind=fileKind(item.type);
  return el('li',{class:`tk-tile ${kind}`},
   el('button',{type:'button',class:'tk-tile-open','aria-label':t('Zobrazit {name}',{name:item.name}),title:[item.name,fileSize(item.size),item.note].filter(Boolean).join(' · '),onclick:()=>onOpen(i)},
    kind==='image'?el('img',{src:item.url,alt:'',loading:'lazy',draggable:'false'}):el('span',{class:'tk-tile-badge'},el('span',{class:'tk-tile-glyph','aria-hidden':'true'},GLYPH[kind]),el('span',{},extension(item.name)||t('soubor')))),
   el('span',{class:'tk-tile-name',title:item.name},item.name),
   onRemove?el('button',{type:'button',class:'tk-tile-x','aria-label':t('Odebrat {name}',{name:item.name}),title:t('Odebrat přílohu'),onclick:e=>onRemove(item,e.currentTarget)},'×'):null);
 }));
}

const TEXT_SHOWN=256*1024;
async function readText(item){
 if(item.file)return item.file.slice(0,TEXT_SHOWN).text();
 const r=await fetch(item.url,{headers:{Range:`bytes=0-${TEXT_SHOWN-1}`}});if(!r.ok)throw new Error('read');return r.text();
}
// One file in a dialog, the others one step away (the buttons or the arrow keys). `show` puts the dialog on the
// page (tracker-view.js → showDialog, which also closes it when the session ends). A click outside closes it.
export function openViewer(items,index,show){
 if(!items.length)return null;
 const stage=el('div',{class:'tk-viewer-stage'}),caption=el('figcaption',{}),links=el('span',{class:'tk-viewer-links'});let turn=0;
 const card=(item,...rest)=>el('div',{class:'tk-viewer-file'},el('span',{class:'tk-viewer-glyph','aria-hidden':'true'},GLYPH[fileKind(item.type)]),el('b',{},item.name),...rest);
 const body=item=>{
  const kind=fileKind(item.type);
  if(kind==='image')return el('img',{class:'tk-lightbox-img',src:item.url,alt:item.name});
  if(kind==='video'||kind==='audio'){
   const player=el(kind,{class:`tk-viewer-${kind}`,controls:'',preload:'metadata',src:item.url}),node=kind==='audio'?card(item,player):player;
   // A container the browser cannot play (AVI, some MKV and MOV files): say so; the download stays.
   player.addEventListener('error',()=>{
    if(!stage.contains(node))return;
    const held=document.activeElement===player;stage.replaceChildren(card(item,el('span',{class:'tk-dim'},t('Tenhle formát prohlížeč nepřehraje. Soubor si stáhni.'))));if(held)close.focus();
   });
   return node;
  }
  if(kind==='text'){
   const pre=el('pre',{class:'tk-viewer-text'},t('Načítám…')),mine=turn;
   readText(item).then(text=>{if(mine===turn)pre.textContent=text;},()=>{if(mine===turn)pre.textContent=t('Soubor se nepodařilo načíst.');});
   return pre;
  }
  return card(item,el('span',{class:'tk-dim'},item.file?t('Tenhle soubor náhled nemá.'):t('Tenhle soubor náhled nemá. Stáhni si ho.')));
 };
 const go=i=>{
  index=(i+items.length)%items.length;turn++;const item=items[index],kind=fileKind(item.type);
  stage.replaceChildren(body(item));
  caption.textContent=[item.name,fileSize(item.size),item.note,items.length>1?`${index+1}/${items.length}`:''].filter(Boolean).join(' · ');
  links.replaceChildren(...[
   !item.file&&(kind==='image'||kind==='text')?el('a',{class:'acc-btn small',href:item.url,target:'_blank',rel:'noopener'},t('Otevřít v nové kartě')):null,
   item.download?el('a',{class:'acc-btn small',href:item.download,download:item.name},t('Stáhnout')):null].filter(Boolean));
 };
// The keyboard starts on Close, not in a player (showModal would pick the first control): the arrow keys then
 // step through the files, and seek only once the user has gone into the player.
 const close=el('button',{type:'button',class:'acc-btn small',autofocus:'',onclick:()=>dialog.close()},t('Zavřít'));
 const step=(d,text,icon)=>items.length>1?el('button',{type:'button',class:'tk-lightbox-nav','aria-label':text,title:text,onclick:()=>go(index+d)},icon):null;
 const dialog=el('dialog',{class:'tk-dialog tk-lightbox','aria-label':t('Náhled přílohy'),onclick:e=>{if(e.target===dialog)dialog.close();},
   // The arrow keys step through the files, except in a player, where they seek.
   onkeydown:e=>{if(items.length<2||['VIDEO','AUDIO'].includes(e.target?.tagName))return;if(e.key==='ArrowRight')go(index+1);else if(e.key==='ArrowLeft')go(index-1);}},
  el('figure',{},stage,caption),el('div',{class:'tk-lightbox-bar'},step(-1,t('Předchozí'),'←'),step(1,t('Další'),'→'),links,close));
 go(index);show(dialog);
 return dialog;
}

// Editing text with chips in it needs a contenteditable that only ever holds plain text (no pasted markup, no
// bold): contenteditable="plaintext-only". Without it the textarea is the editor.
const canRich=()=>{
 try{
  if(typeof document.createRange!=='function'||typeof globalThis.getSelection!=='function')return false;
  const probe=document.createElement('div');probe.contentEditable='plaintext-only';return probe.contentEditable==='plaintext-only';
 }catch{return false;}
};
const UNDO_STEPS=200,TYPING_RUN_MS=1000;
// resolve(name) → the file of that name or null; onOpen(file) on a click on its chip. Returns
//   node            what the user types into (the box, or the textarea itself)
//   has(node)       whether node is this field or inside it
//   insert(name)    the chip of that file where the caret is, then a space; at the end of the text, without
//                   taking the keyboard, when the caret is somewhere else
//   drop(name)      every chip of that file out of the text
//   refresh()       draw again from the textarea's value, after something else changed it
//   caret(), focusAt(n)   the caret as an offset into the plain text; focusAt(null) goes back to where the caret
//                   was when the field was left (the end of the text the first time)
//   history()       its undo steps, to hand to the editor that replaces this one (`history` option) when the
//                   page is drawn again around the same text
// How the box works. The text is the model: every change the editor makes itself (a chip in or out, undo, a
// typed token turning into a chip) builds the nodes again from the text and puts the caret back by its offset.
// What the browser does to the nodes while the user types is read back as text, and the box is rebuilt only
// when the browser left something that is not text, a chip or a line break. A chip in the box is an
// <input type="button">: browsers treat it as one character (a caret position on either side, one Backspace),
// which they do not do for a non-editable <span>. Undo and redo are the editor's own, because the browser's
// history does not know the nodes the editor replaced.
export function chipEditor(area,{resolve=()=>null,onOpen=null,label='',history=null}={}){
 const cut=(text,name)=>text.split(fileToken(name)+' ').join('').split(fileToken(name)).join('');
 const plain={node:area,rich:false,has:n=>n===area,refresh(){},history:()=>null,
  caret:()=>typeof area.selectionStart==='number'?area.selectionStart:null,
  focusAt(n){area.focus();if(n!=null)area.setSelectionRange?.(n,n);},
  insert(name){
   const text=area.value,token=fileToken(name)+' ';
   if(document.activeElement!==area){area.value=text+(text&&!/\s$/.test(text)?' ':'')+token;return;}
   const at=typeof area.selectionStart==='number'?area.selectionStart:text.length,end=typeof area.selectionEnd==='number'?area.selectionEnd:at;
   area.value=text.slice(0,at)+token+text.slice(end);area.setSelectionRange?.(at+token.length,at+token.length);
  },
  drop(name){area.value=cut(area.value,name);}};
 if(!canRich())return plain;
 const max=Number(area.getAttribute('maxlength'))||Infinity,tokens=()=>new RegExp(FILE_TOKEN.source,'g');
 const box=el('div',{class:'tk-rich',role:'textbox','aria-multiline':'true','aria-label':label||area.getAttribute('aria-label')||'',spellcheck:'true'});
 box.contentEditable='plaintext-only';
 for(const [from,to] of [['placeholder','data-placeholder'],['aria-keyshortcuts','aria-keyshortcuts']])if(area.getAttribute(from))box.setAttribute(to,area.getAttribute(from));
 // A hidden field that is required can never be submitted; the form that owns it checks for text itself.
 if(area.hasAttribute('required')){area.removeAttribute('required');box.setAttribute('aria-required','true');}
 box.style.minHeight=`${(Number(area.getAttribute('rows'))||3)*1.45+1.4}em`;
 area.hidden=true;
 // The hidden textarea is still what the field's <label> points at: a click on the label lands here.
 area.addEventListener('click',()=>{if(!box.hidden)box.focus();});
 const has=n=>Boolean(n)&&(n===box||box.contains(n)),isChip=n=>n.nodeType===1&&n.hasAttribute('data-file');
 const chipIn=item=>{
  const kind=fileKind(item.type),gone=item.gone===true,thumb=kind==='image'&&Boolean(item.url)&&!gone,size=Number.isFinite(item.size)?fileSize(item.size):'';
  const chip=el('input',{type:'button',tabindex:'-1',class:`tk-fchip tk-fchip-in${gone?' gone':''}${thumb?' thumb':''}`,'data-file':item.name,
   value:[thumb?'':gone?'∅':GLYPH[kind],item.name+(size?'  '+size:'')].filter(Boolean).join(' '),title:gone?t('Příloha {name} už u položky není.',{name:item.name}):item.name});
  if(thumb)chip.style.backgroundImage=`url("${String(item.url).replace(/["\\\n\r]/g,'')}")`;
  return chip;
 };
 // The text as nodes: text, chips for the tokens that name a file, and a last <br> for the caret to stand on
 // when the text ends in a line break.
 const render=text=>{
  const nodes=[];let last=0;
  for(const m of text.matchAll(tokens())){
   const item=resolve(m[1]);if(!item)continue;
   if(m.index>last)nodes.push(document.createTextNode(text.slice(last,m.index)));
   nodes.push(chipIn(item));last=m.index+m[0].length;
  }
  if(last<text.length)nodes.push(document.createTextNode(text.slice(last)));
  if(text.endsWith('\n'))nodes.push(document.createElement('br'));
  // New nodes, the same view: a long text stays scrolled to where the user is working.
  const top=box.scrollTop;box.replaceChildren(...nodes);box.classList.toggle('empty',text==='');if(top)box.scrollTop=top;
 };
 // The nodes as text again: a chip is its token, a <br> a line break. An element the browser made (a <div> for a
 // line of dropped or inserted text) is a line of its own: what stands in front of it ends there, and a line
 // break right in front of it is that same end, not an empty line.
 const raw=root=>{
  const lines=[];let open=null;
  for(const n of root.childNodes){
   if(n.nodeType===3)open=(open??'')+n.data;
   else if(n.nodeType!==1)continue;
   else if(isChip(n))open=(open??'')+fileToken(n.getAttribute('data-file'));
   else if(n.nodeName==='BR')open=(open??'')+'\n';
   else{
    if(open!==null){lines.push(open.replace(/\n$/,''));open=null;}
    lines.push(n.childNodes.length===1&&n.firstChild.nodeName==='BR'?'':raw(n));
   }
  }
  if(open!==null)lines.push(open);
  return lines.join('\n');
 };
 // The last line break of the box is only footing for the caret: the <br> render() adds, or the second "\n" a
 // browser puts after an Enter at the end. The text is what is in front of it.
 const read=()=>raw(box).replace(/\n$/,'');
 const offsetOf=(node,offset,limit)=>{const r=document.createRange();r.selectNodeContents(box);r.setEnd(node,offset);return Math.min(raw(r.cloneContents()).length,limit);};
 // The selection as offsets into the text, when it is in the box.
 const selection=()=>{
  const sel=getSelection();if(!sel.rangeCount)return null;
  const r=sel.getRangeAt(0);if(!has(r.commonAncestorContainer))return null;
  const limit=read().length,start=offsetOf(r.startContainer,r.startOffset,limit);
  return {start,end:r.collapsed?start:offsetOf(r.endContainer,r.endOffset,limit)};
 };
 const caret=(limit=read().length)=>{
  const sel=getSelection();if(!sel.rangeCount||!sel.focusNode||!has(sel.focusNode))return null;
  return offsetOf(sel.focusNode,sel.focusOffset,limit);
 };
 // A caret the editor has put somewhere is scrolled into the box's view (the browser does that only for its own
 // moves). A caret has no box of its own at a line's start: the character or the node next to it stands for it.
 const reveal=at=>{
  if(box.scrollHeight<=box.clientHeight)return;
  const r=at.cloneRange(),n=r.startContainer,o=r.startOffset;let rect=r.getClientRects()[0];
  if(!rect&&n.nodeType===3&&n.data.length){r.setStart(n,Math.max(0,o-1));r.setEnd(n,Math.max(1,o));rect=[...r.getClientRects()].at(-1);}
  if(!rect&&n.nodeType===1)rect=(n.childNodes[o]||n.childNodes[o-1])?.getBoundingClientRect?.();
  if(!rect)return;
  const frame=box.getBoundingClientRect(),line=24;
  if(rect.bottom>frame.bottom-4)box.scrollTop+=rect.bottom-frame.bottom+line;
  else if(rect.top<frame.top+4)box.scrollTop-=frame.top-rect.top+line;
 };
 // Only on nodes render() has just made: text, chips and the last <br>, side by side.
 const place=n=>{
  const r=document.createRange();let left=Math.max(0,n),found=false;
  for(const node of box.childNodes){
   if(node.nodeType===3){if(left<=node.data.length){r.setStart(node,left);found=true;break;}left-=node.data.length;}
   else if(isChip(node)){const len=fileToken(node.getAttribute('data-file')).length;if(left<len){r.setStartBefore(node);found=true;break;}left-=len;}
   else if(node.nodeName==='BR'){r.setStartBefore(node);found=true;break;}
  }
  if(!found)r.selectNodeContents(box);
  r.collapse(found);const sel=getSelection();sel.removeAllRanges();sel.addRange(r);reveal(r);
 };
 // Undo and redo: the texts the box has held, with the caret after each. Characters typed (or deleted) in one
 // run are one step. Cmd/Ctrl+Z and the browser's own undo request (where it sends one) both come here; a menu
 // command the browser thinks it has nothing to undo for never arrives.
 let steps=[{text:area.value,at:null}],step=0,stamp=0,run='';
 if(history?.steps?.[history.step]?.text===area.value){steps=history.steps.map(h=>({...h}));step=history.step;}
 const record=(text,at,kind='')=>{
  if(steps[step].text===text){steps[step].at=at;return;}
  // A run goes on while the same kind of key lands where the last one left the caret, without a pause.
  const now=Date.now(),was=steps[step],grown=text.length-was.text.length,joined=at!=null&&was.at!=null&&(at-was.at===grown||(kind==='deleteContentForward'&&at===was.at));
  const same=Boolean(kind)&&kind===run&&now-stamp<TYPING_RUN_MS&&step>0&&joined;
  steps.length=step+1;if(same)steps[step]={text,at};else steps.push({text,at});
  if(steps.length>UNDO_STEPS)steps.shift();
  step=steps.length-1;stamp=now;run=kind;
 };
 // The editor's own change of the text: draw it, hand it to the textarea, put the caret back. A composition the
 // browser was in the middle of does not survive the new nodes.
 let composing=false,left=null,clicked=false;
 const set=(text,at,focus=false)=>{
  composing=false;render(text);if(area.value!==text)area.value=text;
  if(focus)box.focus();
  if(at!=null&&(focus||document.activeElement===box)){left=Math.min(at,text.length);place(left);}
 };
 // One step back or forward. The caret goes to the end of what the step changed: behind the text an undo
 // brought back, or to where the text it took away stood.
 const travel=d=>{
  if(!steps[step+d])return;
  const from=steps[step].text;step+=d;run='';const to=steps[step].text;let head=0,tail=0;
  while(head<to.length&&head<from.length&&to[head]===from[head])head++;
  while(tail<to.length-head&&tail<from.length-head&&to[to.length-1-tail]===from[from.length-1-tail])tail++;
  set(to,to.length-tail,true);
 };
 // Put `piece` in place of the text from start to end, as much of it as the field still has room for.
 const splice=(start,end,piece)=>{
  const text=read(),fits=piece.slice(0,Math.max(0,max-(text.length-(end-start))));
  if(!fits&&end===start)return;
  const next=text.slice(0,start)+fits+text.slice(end);set(next,start+fits.length,true);record(next,start+fits.length);
 };
 const changed=(kind,midway=false)=>{
  // Rebuild when the browser left an element of its own (a <div> per line: every one of them is a line, none is
  // footing), and when a token typed or pasted as text names a file: it becomes that file's chip.
  const foreign=[...box.childNodes].some(n=>n.nodeType===1&&!isChip(n)&&n.nodeName!=='BR'),text=foreign?raw(box):read();
  if(area.value!==text)area.value=text;box.classList.toggle('empty',text==='');
  if(midway||composing)return;
  const named=[...box.childNodes].some(n=>n.nodeType===3&&[...n.data.matchAll(tokens())].some(m=>resolve(m[1])));
  const at=caret(text.length);if(foreign||named)set(text,at);
  record(text,at,kind);
 };
 box.addEventListener('compositionstart',()=>{composing=true;});
 box.addEventListener('compositionend',()=>{composing=false;changed('');});
 box.addEventListener('input',e=>changed(/^(insertText|deleteContentBackward|deleteContentForward)$/.test(e.inputType)?e.inputType:'',e.isComposing===true));
 box.addEventListener('beforeinput',e=>{
  const type=String(e.inputType);
  if(type==='historyUndo'||type==='historyRedo'){e.preventDefault();travel(type==='historyUndo'?-1:1);return;}
  if(!type.startsWith('insert')||e.isComposing)return;
  const enter=/^insert(LineBreak|Paragraph)$/.test(type),data=enter?'\n':e.data??e.dataTransfer?.getData('text/plain')??'',picked=selection();
  // Text dragged to another place in the box, or dropped into it: put in from the text, at the place the
  // browser names, so that a token arrives as a token and no markup is ever parsed.
  if(type==='insertFromDrop'){
   e.preventDefault();const range=e.getTargetRanges?.()[0],limit=read().length;
   const at=range&&has(range.startContainer)?offsetOf(range.startContainer,range.startOffset,limit):picked?picked.start:limit;
   if(data)splice(at,at,data.replace(/\r\n?/g,'\n'));return;
  }
  if(!data||!picked)return;
  const over=read().length-(picked.end-picked.start)+data.length>max;
  // A line break over a selection is made from the text: a browser may take a chip behind the selection with it.
  // A paste that is too long is cut to what fits, as a textarea would; a key that does not fit is refused.
  if(enter&&picked.end>picked.start&&!over){e.preventDefault();splice(picked.start,picked.end,'\n');}
  else if(over){e.preventDefault();if(type==='insertFromPaste')splice(picked.start,picked.end,data.replace(/\r\n?/g,'\n'));}
 });
 box.addEventListener('keydown',e=>{
  if(!(e.metaKey||e.ctrlKey)||e.altKey||e.isComposing)return;
  const key=String(e.key).toLowerCase();
  if(key==='z'){e.preventDefault();travel(e.shiftKey?1:-1);}
  else if(key==='y'&&e.ctrlKey){e.preventDefault();travel(1);}
 });
 // Copy and cut hand the tokens on, not what a chip happens to show.
 const copy=e=>{
  const picked=selection();if(!picked||picked.start===picked.end||!e.clipboardData)return;
  const text=read();e.clipboardData.setData('text/plain',text.slice(picked.start,picked.end));e.preventDefault();
  if(e.type==='cut'){const next=text.slice(0,picked.start)+text.slice(picked.end);set(next,picked.start,true);record(next,picked.start);}
 };
 box.addEventListener('copy',copy);box.addEventListener('cut',copy);
 // A selection dragged to another place takes its tokens along, as text and nothing else.
 box.addEventListener('dragstart',e=>{
  const picked=selection();if(!picked||picked.start===picked.end||!e.dataTransfer)return;
  e.dataTransfer.clearData();e.dataTransfer.setData('text/plain',read().slice(picked.start,picked.end));
 });
 // A chip is a button: a press on it must not take the keyboard out of the text, a click opens its file.
 const chipOf=e=>{const chip=e.target?.closest?.('[data-file]');return chip&&box.contains(chip)?chip:null;};
 box.addEventListener('mousedown',e=>{if(chipOf(e))e.preventDefault();});
 box.addEventListener('click',e=>{
  const chip=chipOf(e);if(!chip||!onOpen)return;
  const item=resolve(chip.getAttribute('data-file'));if(item&&!item.gone)onOpen(item);
 });
 // The caret the box had when the keyboard left it comes back with the keyboard (a dialog that closes hands the
 // focus back without it, and one engine then starts at the first character), unless a click on the text sets
 // another.
 box.addEventListener('blur',()=>{left=caret();});
 box.addEventListener('mousedown',e=>{clicked=!chipOf(e);setTimeout(()=>{clicked=false;},50);},true);
 box.addEventListener('focus',()=>{
  const back=()=>{
   const sel=getSelection();if(left==null||document.activeElement!==box)return;
   if(!sel.rangeCount||!has(sel.anchorNode)||(sel.isCollapsed&&caret()===0&&left!==0&&!clicked))place(Math.min(left,read().length));
  };
  back();setTimeout(back,0);
 });
 render(area.value);
 return {node:box,rich:true,has,caret:()=>caret(),history:()=>({steps:steps.map(h=>({...h})),step}),
  refresh(){render(area.value);steps=[{text:area.value,at:null}];step=0;run='';},
  focusAt(n){const to=n??(left==null?read().length:null);box.focus();if(to!=null){left=Math.min(to,read().length);place(left);}},
  insert(name){
   const text=read(),token=fileToken(name);if(!resolve(name))return;
   const picked=document.activeElement===box?selection():null;
   if(text.length-(picked?picked.end-picked.start:0)+token.length+1>max)return;
   if(!picked){const next=text+(text&&!/\s$/.test(text)?' ':'')+token+' ';set(next,null);record(next,null);return;}
   const next=text.slice(0,picked.start)+token+' '+text.slice(picked.end),at=picked.start+token.length+1;
   set(next,at,true);record(next,at);
  },
  // The file is gone for good (taken away before it was sent, or its upload failed): its token leaves the
  // undo steps too, or an undo would bring back a name without a file.
  drop(name){
   const text=read(),next=cut(text,name),at=caret(),moved=at==null?null:cut(text.slice(0,at),name).length;
   steps=steps.map(h=>({text:cut(h.text,name),at:null}));
   if(next!==text)set(next,moved);
   steps[step]={text:next,at:moved};
  }};
}
