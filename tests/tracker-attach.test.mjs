// The tracker's files in the browser (public/tracker-attach.js) on the mocked DOM: names, kinds, the chip, the
// tiles, the viewer, and the text field when the browser cannot edit text with chips in it. The editor with
// chips itself needs a real browser (a contenteditable and a selection); it is checked there.
import test from 'node:test';
import assert from 'node:assert/strict';
import {installDom,fire,Element} from './fixtures/mini-dom.mjs';
import {cleanName} from '../server/ticket-files.mjs';

installDom();
const {FILE_MAX,FILES_MAX,fileSize,fileToken,fileKind,localType,attachmentName,savedFile,pendingFile,releaseFile,pastedFiles,fileChip,fileStrip,openViewer,chipEditor}=await import('../public/tracker-attach.js');
const {FILE_TOKEN}=await import('../public/tracker-md.js');
const all=(root,test)=>{const out=[];const visit=n=>{for(const k of n.children||[]){if(test(k))out.push(k);visit(k);}};visit(root);return out;};
const tag=(root,name)=>all(root,n=>n.tagName===name);
const cls=(root,name)=>all(root,n=>n.classList.contains(name));

test('a file name is the one the server keeps, fits a ![name] and is not taken twice',()=>{
 const name=(n,taken=[],type='')=>attachmentName({name:n,type},taken);
 assert.equal(name('image.png'),'image.png');
 assert.equal(name('image.png',['image.png']),'image-2.png');assert.equal(name('IMAGE.PNG',['image.png','image-2.png']),'IMAGE-3.PNG','names differ by more than their case');
 assert.equal(name('old [take 1].avi'),'old (take 1).avi','brackets would end the token');
 assert.equal(name('../../etc/"passwd"\n'),'passwd');assert.equal(name('C:\\Users\\alice\\shot.png'),'shot.png');
 assert.equal(name('',[],'image/png'),'file.png');assert.equal(name('',[]),'file');assert.equal(name('   '),'file');
 const long=name('x'.repeat(300)+'.mov');assert.ok(long.length<=120&&long.endsWith('.mov'),long.length);
 assert.equal(name('🎬'.repeat(80)+'.mp4').isWellFormed(),true,'never half a character');
 assert.doesNotThrow(()=>encodeURIComponent(name('bad\ud800name.png')));
 // Whatever comes out is a fixed point of the server's cleaning and a whole token.
 for(const raw of ['image.png','old [take 1].avi','../../etc/"passwd"\n',' spaced  name .txt ','x'.repeat(300)+'.mov','🎬'.repeat(80)+'.mp4','a]b[c.png','no-extension','.hidden','ž luťoučký kůň.md']){
  const out=name(raw,['image.png']);
  assert.equal(cleanName(out),out,raw);assert.equal(out.trim(),out);assert.ok(out.length>=1&&out.length<=120);
  assert.equal(FILE_TOKEN.exec(`see ${fileToken(out)} here`)?.[1],out,raw);
 }
});

test('kinds, sizes, and what a file that waits will most likely be',()=>{
 assert.deepEqual(['image/png','audio/mpeg','video/x-msvideo','text/plain','application/pdf','application/octet-stream','',undefined].map(fileKind),['image','audio','video','text','pdf','file','file','file']);
 assert.deepEqual([512,2048,5*1048576].map(fileSize),['512 B','2 kB','5.0 MB']);
 assert.equal(localType({name:'a.png',type:'image/png'}),'image/png');assert.equal(localType({name:'a.svg',type:'image/svg+xml'}),'application/octet-stream','the server never shows an SVG');
 assert.equal(localType({name:'a.avi',type:'video/x-msvideo'}),'video/x-msvideo');assert.equal(localType({name:'song.mp3',type:'audio/mpeg'}),'audio/mpeg');
 assert.equal(localType({name:'module.ts',type:'video/mp2t'}),'text/plain','a TypeScript file is text, whatever the browser calls it');
 assert.equal(localType({name:'data.bin',type:''}),'application/octet-stream');
 assert.equal(FILE_MAX,100*1024*1024);assert.equal(FILES_MAX,20);
 const saved=savedFile('HH-1',{id:'11111111-1111-4111-8111-111111111111',name:'a.png',type:'image/png',size:3});
 assert.equal(saved.url,'/api/tickets/HH-1/attachments/11111111-1111-4111-8111-111111111111');assert.equal(saved.download,saved.url+'?download=1');
 const waiting=pendingFile(new File(['abc'],'a.txt',{type:'text/plain'}),'a.txt');
 assert.match(waiting.url,/^blob:/);assert.equal(waiting.size,3);assert.equal(waiting.type,'text/plain');assert.ok(waiting.file);
 releaseFile(waiting);releaseFile(saved);releaseFile(null);
});

test('a paste of files is a paste of files; text from an office application is text',()=>{
 const file=new File(['x'],'image.png',{type:'image/png'}),paste=(files,types)=>pastedFiles({clipboardData:{files,types}});
 assert.deepEqual(paste([file],['Files']),[file],'a screenshot');
 assert.deepEqual(paste([file],['text/html','Files']),[file],'a picture copied in a browser');
 assert.deepEqual(paste([file],['text/plain','Files']),[file],'a file copied in the file manager');
 assert.deepEqual(paste([file],['text/plain','text/html','text/rtf','Files']),[],'cells or a paragraph that carry a picture of themselves');
 assert.deepEqual(paste([],['text/plain']),[]);assert.deepEqual(pastedFiles({}),[]);
});

test('a chip shows the icon, the name and the size, and opens the file',()=>{
 const opened=[],item={name:'shot.png',type:'image/png',size:588214,url:'/api/tickets/HH-1/attachments/x'};
 const chip=fileChip(item,{onOpen:f=>opened.push(f.name)});
 assert.equal(chip.getAttribute('data-file'),'shot.png');assert.equal(chip.getAttribute('role'),'button');assert.equal(chip.getAttribute('tabindex'),'0');
 assert.equal(tag(chip,'img')[0].getAttribute('src'),item.url);assert.equal(cls(chip,'tk-fchip-name')[0].textContent,'shot.png');assert.equal(cls(chip,'tk-fchip-size')[0].textContent,'574 kB');
 fire(chip,'click');fire(chip,'keydown',{key:'Enter'});fire(chip,'keydown',{key:' '});fire(chip,'keydown',{key:'a'});assert.deepEqual(opened,['shot.png','shot.png','shot.png']);
 const sound=fileChip({name:'beep.mp3',type:'audio/mpeg',size:10});assert.equal(tag(sound,'img').length,0);assert.equal(sound.getAttribute('role'),null,'without onOpen it is only a label');
 // A file the ticket no longer has: the name, struck through, and nothing to open.
 const gone=fileChip({name:'old.png',gone:true},{onOpen:f=>opened.push(f.name)});
 assert.ok(gone.classList.contains('gone'));assert.equal(gone.getAttribute('role'),null);assert.equal(cls(gone,'tk-fchip-size').length,0);fire(gone,'click');assert.equal(opened.length,3);
 // The name is text, never markup.
 const evil=fileChip({name:'<img src=x onerror=alert(1)>.png',type:'application/octet-stream',size:1});assert.equal(tag(evil,'img').length,0);assert.equal(cls(evil,'tk-fchip-name')[0].textContent,'<img src=x onerror=alert(1)>.png');
});

test('tiles: a picture shows itself, other files their kind; × only where a file may be removed',()=>{
 const items=[{name:'shot.png',type:'image/png',size:10,url:'/a'},{name:'clip.avi',type:'video/x-msvideo',size:20,url:'/b'},{name:'README',type:'application/octet-stream',size:30,url:'/c'}];
 const opened=[],removed=[],strip=fileStrip(items,{onOpen:i=>opened.push(i),onRemove:item=>removed.push(item.name)});
 const tiles=cls(strip,'tk-tile');assert.deepEqual(tiles.map(n=>n.getAttribute('class')),['tk-tile image','tk-tile video','tk-tile file']);
 assert.equal(tag(tiles[0],'img')[0].getAttribute('src'),'/a');assert.equal(tag(tiles[1],'img').length,0);
 assert.deepEqual(tiles.map(n=>cls(n,'tk-tile-badge')[0]?.textContent||''),['','▶AVI','📎file']);
 assert.deepEqual(tiles.map(n=>cls(n,'tk-tile-name')[0].textContent),['shot.png','clip.avi','README']);
 fire(cls(tiles[1],'tk-tile-open')[0],'click');fire(cls(tiles[2],'tk-tile-x')[0],'click');assert.deepEqual(opened,[1]);assert.deepEqual(removed,['README']);
 assert.equal(cls(tiles[0],'tk-tile-x')[0].getAttribute('aria-label'),'Remove shot.png');
 assert.equal(cls(fileStrip(items,{onOpen(){}}),'tk-tile-x').length,0,'a reader gets no ×');
});

test('the viewer shows a picture, plays audio and video, and offers the download; it closes',async()=>{
 Element.prototype.contains=function(node){for(let n=node;n;n=n.parentNode)if(n===this)return true;return false;};
 const items=[{name:'shot.png',type:'image/png',size:10,url:'/a',download:'/a?download=1',note:'alex · 2 h ago'},{name:'clip.mp4',type:'video/mp4',size:20,url:'/b',download:'/b?download=1'},
  {name:'beep.mp3',type:'audio/mpeg',size:30,url:'/c',download:'/c?download=1'},{name:'data.bin',type:'application/octet-stream',size:40,url:'/d',download:'/d?download=1'},
  {name:'waiting.bin',type:'application/octet-stream',size:5,url:'blob:x',file:new File(['x'],'waiting.bin')}];
 let shown=null,closed=0;const dialog=openViewer(items,0,d=>{shown=d;d.close=()=>{closed++;};});
 assert.equal(shown,dialog);assert.equal(dialog.getAttribute('aria-label'),'Attachment preview');
 const stage=cls(dialog,'tk-viewer-stage')[0],caption=tag(dialog,'figcaption')[0],links=()=>tag(dialog,'a').map(a=>[a.textContent,a.getAttribute('href')]);
 assert.equal(stage.children[0].tagName,'img');assert.equal(stage.children[0].getAttribute('src'),'/a');assert.equal(caption.textContent,'shot.png · 10 B · alex · 2 h ago · 1/5','who attached it and when');
 assert.equal(tag(dialog,'button').find(b=>b.textContent==='Close').getAttribute('autofocus'),'','the keyboard starts on Close, not in a player');
 assert.deepEqual(links(),[['Open in a new tab','/a'],['Download','/a?download=1']]);
 fire(dialog,'keydown',{key:'ArrowRight'});
 assert.equal(stage.children[0].tagName,'video');assert.equal(stage.children[0].getAttribute('src'),'/b');assert.equal(stage.children[0].getAttribute('controls'),'');
 assert.deepEqual(links(),[['Download','/b?download=1']],'a video is not opened in a tab of its own: the sandboxed file could not load itself');
 // In a player the arrow keys seek; they do not leave the file.
 fire(stage.children[0],'keydown',{key:'ArrowRight',target:{tagName:'VIDEO'}});assert.equal(caption.textContent,'clip.mp4 · 20 B · 2/5');
 // A container the browser cannot play says so and keeps the download.
 fire(stage.children[0],'error');assert.equal(tag(stage,'video').length,0);assert.match(stage.textContent,/cannot play this format/);assert.deepEqual(links(),[['Download','/b?download=1']]);
 fire(tag(dialog,'button').find(b=>b.getAttribute('aria-label')==='Next'),'click');
 assert.equal(tag(stage,'audio')[0].getAttribute('src'),'/c');assert.match(stage.textContent,/beep\.mp3/);
 fire(dialog,'keydown',{key:'ArrowRight'});assert.match(stage.textContent,/no preview\. Download it\./);
 fire(dialog,'keydown',{key:'ArrowRight'});assert.match(stage.textContent,/has no preview\.$/);assert.deepEqual(links(),[],'a file that waits has nothing to download yet');
 fire(dialog,'keydown',{key:'ArrowRight'});assert.equal(caption.textContent,'shot.png · 10 B · alex · 2 h ago · 1/5','round again');
 fire(dialog,'keydown',{key:'ArrowLeft'});assert.equal(caption.textContent,'waiting.bin · 5 B · 5/5');
 fire(tag(dialog,'button').find(b=>b.textContent==='Close'),'click');assert.equal(closed,1);
 fire(dialog,'click');assert.equal(closed,2,'a click outside the picture closes it');fire(stage,'click');assert.equal(closed,2);
 assert.equal(openViewer([],0,()=>{throw new Error('nothing to show');}),null);
 // Text is read from the file itself while it waits (the first 256 kB).
 const text=openViewer([{name:'notes.txt',type:'text/plain',size:11,url:'blob:y',file:new File(['hello\nworld'],'notes.txt')}],0,()=>{});
 await new Promise(r=>setTimeout(r,20));assert.equal(tag(text,'pre')[0].textContent,'hello\nworld');assert.equal(tag(text,'button').filter(b=>b.getAttribute('aria-label')==='Next').length,0,'one file: no arrows');
});

test('without chip editing the textarea is the editor: tokens go in at the caret and come out again',()=>{
 const area=document.createElement('textarea');area.value='See  here';area.selectionStart=area.selectionEnd=4;
 let focused=0;area.focus=()=>{focused++;document.activeElement=area;};area.setSelectionRange=(a,b)=>{area.selectionStart=a;area.selectionEnd=b;};
 const editor=chipEditor(area,{resolve:()=>null});
 assert.equal(editor.rich,false);assert.equal(editor.node,area);assert.equal(editor.has(area),true);assert.equal(editor.has(document.body),false);
 // The keyboard is somewhere else (a second file of a batch, the user has moved on): the token goes to the end and the focus stays where it is.
 document.activeElement=document.body;editor.insert('late.png');assert.equal(area.value,'See  here ![late.png] ');assert.equal(focused,0);assert.equal(area.selectionStart,4);
 editor.drop('late.png');assert.equal(area.value,'See  here ');area.value='See  here';
 // The keyboard is in the field: at the caret, which moves behind the token.
 area.focus();editor.insert('shot.png');assert.equal(area.value,'See ![shot.png]  here');assert.equal(area.selectionStart,16);assert.equal(editor.caret(),16);assert.equal(focused,1);
 area.selectionStart=0;area.selectionEnd=3;editor.insert('b.mp3');assert.equal(area.value,'![b.mp3]  ![shot.png]  here','a selection is replaced');
 editor.drop('shot.png');assert.equal(area.value,'![b.mp3]   here');editor.drop('b.mp3');assert.equal(area.value,'  here');
 editor.focusAt(2);assert.equal(area.selectionStart,2);editor.focusAt(null);assert.equal(focused,3);editor.refresh();document.activeElement=undefined;
});
