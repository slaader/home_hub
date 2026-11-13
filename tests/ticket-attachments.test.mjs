import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir,mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {sniff,cleanName,inline,FILE_LIMITS,createTicketFiles} from '../server/ticket-files.mjs';
import {hub} from './hub-helper.mjs';

const PNG=Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),Buffer.from('pixels')]);

test('attachment types come from the bytes, names are cleaned',()=>{
 assert.equal(sniff(PNG,'x.txt'),'image/png');
 assert.equal(sniff(Buffer.from('%PDF-1.7'),'a.pdf'),'application/pdf');
 assert.equal(sniff(Buffer.from('ahoj světe'),'poznamka.md'),'text/plain');
 assert.equal(sniff(Buffer.from('<script>alert(1)</script>'),'evil.svg'),'application/octet-stream','SVG/HTML is never inline');
 assert.equal(sniff(Buffer.from([0,1,2]),'data.txt'),'application/octet-stream');
 assert.equal(cleanName('../../etc/"passwd"\n'),'passwd');assert.equal(cleanName(''),'soubor');
});

test('ticket attachments: upload, serve, history, delete, scopes and MCP',async t=>{
 const h=await hub(t),reader=await h.account('reader',[]),agent=await h.account('dev-agent',['tickets:write']);
 const ticket=await (await h.post('/api/tickets',{project:'home-hub',title:'Screenshot bug'},h.admin)).json();
 const put=(headers,body,name='bug.png',id=ticket.id)=>fetch(`${h.origin}/api/tickets/${id}/attachments?name=${encodeURIComponent(name)}`,{method:'PUT',headers:{'Content-Type':'application/octet-stream',...headers},body});
 assert.equal((await put({...h.admin,Origin:'https://evil.example'},PNG)).status,403,'cross-origin upload');
 assert.equal((await put({Authorization:'Bearer '+reader.token},PNG)).status,403,'read-only key');
 assert.equal((await put({...h.admin,Origin:h.origin},PNG,'x.png','HH-99')).status,404);
 const up=await put({...h.admin,Origin:h.origin},PNG,'../bug.png');assert.equal(up.status,201);
 const withFile=await up.json(),a=withFile.attachments[0];
 assert.equal(a.name,'bug.png');assert.equal(a.type,'image/png');assert.equal(a.size,PNG.length);assert.equal(a.by,'admin');
 assert.equal(withFile.history.at(-1).field,'attachment');
 const html=await put({Authorization:'Bearer '+agent.token},Buffer.from('<html><script>alert(1)</script>'),'page.html');assert.equal(html.status,201);
 const page=(await html.json()).attachments[1];assert.equal(page.type,'text/plain','HTML is shown as text, never rendered');
 const plainPage=await fetch(`${h.origin}/api/tickets/${ticket.id}/attachments/${page.id}`,{headers:h.admin});assert.equal(plainPage.headers.get('content-type'),'text/plain; charset=utf-8');
 const bin=await put({Authorization:'Bearer '+agent.token},Buffer.from([0,1,2,3,250]),'data.bin');assert.equal(bin.status,201);
 const b=(await bin.json()).attachments[2];assert.equal(b.type,'application/octet-stream');
 assert.equal((await put({...h.admin,Origin:h.origin},Buffer.alloc(0),'empty.txt')).status,400);

 const img=await fetch(`${h.origin}/api/tickets/${ticket.id}/attachments/${a.id}`,{headers:h.admin});
 assert.equal(img.status,200);assert.equal(img.headers.get('content-type'),'image/png');assert.match(img.headers.get('content-disposition'),/^inline/);
 assert.match(img.headers.get('content-security-policy'),/^sandbox/);assert.equal(img.headers.get('x-content-type-options'),'nosniff');
 assert.deepEqual(Buffer.from(await img.arrayBuffer()),PNG);
 const dl=await fetch(`${h.origin}/api/tickets/${ticket.id}/attachments/${b.id}`,{headers:h.admin});
 assert.equal(dl.headers.get('content-type'),'application/octet-stream');assert.match(dl.headers.get('content-disposition'),/^attachment; filename="data.bin"/);
 assert.equal((await fetch(`${h.origin}/api/tickets/${ticket.id}/attachments/${a.id}`)).status,401);
 const listed=await (await fetch(`${h.origin}/api/tickets?project=home-hub`,{headers:h.admin})).json();assert.equal(listed.tickets[0].attachments,3);

 // MCP: an image comes back as an image, other files as metadata only.
 const rpc=async(acct,name,args)=>(await (await fetch(h.origin+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+acct.token},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})})).json()).result;
 const got=await rpc(reader,'ticket_attachment_get',{id:ticket.id,attachment:a.id});
 assert.equal(got.content[1].type,'image');assert.equal(got.content[1].mimeType,'image/png');assert.equal(Buffer.from(got.content[1].data,'base64').equals(PNG),true);
 assert.match((await rpc(reader,'ticket_attachment_get',{id:ticket.id,attachment:b.id})).structuredContent.note,/metadata/);
 assert.equal((await rpc(reader,'ticket_get',{id:ticket.id})).structuredContent.attachments.length,3);
 assert.match((await rpc(reader,'ticket_attachment_get',{id:ticket.id,attachment:page.id})).content[1].text,/<html>/);

 // Delete: refused for read-only keys; the file goes once no ticket uses it.
 assert.equal((await h.post('/api/tickets/attachments/delete',{id:ticket.id,attachment:a.id},{Authorization:'Bearer '+reader.token})).status,403);
 const del=await h.post('/api/tickets/attachments/delete',{id:ticket.id,attachment:a.id},h.admin);assert.equal(del.status,200);
 assert.equal((await del.json()).attachments.length,2);
 assert.equal((await fetch(`${h.origin}/api/tickets/${ticket.id}/attachments/${a.id}`,{headers:h.admin})).status,404);
 assert.equal((await readdir(path.join(h.dir,'tickets','attachments'))).filter(n=>!n.startsWith('.')).length,2);
});

// One second of nothing, as a WAV file: the smallest thing a browser will play.
const WAV=Buffer.concat([Buffer.from('RIFF'),Buffer.from([0x24,0,0,0]),Buffer.from('WAVEfmt '),Buffer.from([16,0,0,0,1,0,1,0,0x40,0x1f,0,0,0x80,0x3e,0,0,2,0,16,0]),Buffer.from('data'),Buffer.from([0,0,0,0])]);

test('attachment types: audio and video by their container; the name only settles what the bytes leave open',()=>{
 const riff=kind=>Buffer.concat([Buffer.from('RIFF'),Buffer.alloc(4),Buffer.from(kind),Buffer.alloc(8)]),ftyp=brand=>Buffer.concat([Buffer.from([0,0,0,0x20]),Buffer.from('ftyp'+brand),Buffer.alloc(8)]);
 const ebml=doc=>Buffer.concat([Buffer.from([0x1a,0x45,0xdf,0xa3,0x9f,0x42,0x86,0x81,1,0x42,0x82,0x84]),Buffer.from(doc),Buffer.alloc(8)]);
 assert.equal(sniff(WAV,'sound.txt'),'audio/wav','the bytes win over the name');
 assert.equal(sniff(riff('AVI '),'clip.avi'),'video/x-msvideo');
 assert.equal(sniff(Buffer.from('fLaC\0\0\0\x22'),'a.flac'),'audio/flac');
 assert.equal(sniff(Buffer.from('OggS\0\x02'),'a.ogg'),'audio/ogg');assert.equal(sniff(Buffer.from('OggS\0\x02'),'a.ogv'),'video/ogg');
 assert.equal(sniff(Buffer.from([0x49,0x44,0x33,4,0,0,0,0,0x10,0x20]),'song.bin'),'audio/mpeg','an ID3 tag');
 assert.equal(sniff(Buffer.from('ID3 tags are a kind of metadata'),'notes.txt'),'text/plain','text that only starts like a tag');
 assert.equal(sniff(Buffer.from([0xff,0xfb,0x90,0x64]),'song.mp3'),'audio/mpeg','a bare MPEG frame, when the name agrees');
 assert.equal(sniff(Buffer.from([0xff,0xfb,0x90,0x64]),'song.bin'),'application/octet-stream');
 assert.equal(sniff(Buffer.from([0xff,0xf1,0x4c,0x80]),'voice.aac'),'audio/aac');
 assert.equal(sniff(ebml('webm'),'clip.webm'),'video/webm');assert.equal(sniff(ebml('webm'),'voice.weba'),'audio/webm');assert.equal(sniff(ebml('matroska'),'film.mkv'),'video/x-matroska');
 assert.equal(sniff(ftyp('isom'),'clip.mp4'),'video/mp4');assert.equal(sniff(ftyp('mp42'),'talk.m4a'),'audio/mp4');assert.equal(sniff(ftyp('M4A '),'talk.bin'),'audio/mp4');
 assert.equal(sniff(ftyp('qt  '),'screen.mov'),'video/quicktime');assert.equal(sniff(ftyp('3gp4'),'old.3gp'),'video/3gpp');
 assert.equal(sniff(ftyp('heic'),'photo.heic'),'application/octet-stream','a picture in an MP4 box is not a video');
 assert.equal(sniff(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'),'x.mp4'),'application/octet-stream');
 for(const type of ['image/png','text/plain','audio/mpeg','video/mp4','video/x-msvideo'])assert.equal(inline(type),true,type);
 for(const type of ['application/pdf','application/octet-stream','text/html','image/svg+xml'])assert.equal(inline(type),false,type);
 assert.equal(FILE_LIMITS.file,100*1024*1024);
});

test('ticket attachments: audio is served as audio, in byte ranges; a bad range and an oversized file are refused',async t=>{
 const h=await hub(t),ticket=await (await h.post('/api/tickets',{project:'home-hub',title:'Sound'},h.admin)).json();
 const up=await fetch(`${h.origin}/api/tickets/${ticket.id}/attachments?name=beep.wav`,{method:'PUT',headers:{'Content-Type':'application/octet-stream',...h.admin,Origin:h.origin},body:WAV});
 assert.equal(up.status,201);const a=(await up.json()).attachments[0];assert.equal(a.type,'audio/wav');
 const url=`${h.origin}/api/tickets/${ticket.id}/attachments/${a.id}`,get=(headers={},q='')=>fetch(url+q,{headers:{...h.admin,...headers}});
 const whole=await get();assert.equal(whole.status,200);assert.equal(whole.headers.get('content-type'),'audio/wav');assert.match(whole.headers.get('content-disposition'),/^inline/);
 assert.equal(whole.headers.get('accept-ranges'),'bytes');assert.match(whole.headers.get('content-security-policy'),/^sandbox/);assert.equal(whole.headers.get('x-content-type-options'),'nosniff');
 assert.deepEqual(Buffer.from(await whole.arrayBuffer()),WAV);
 const part=await get({Range:'bytes=8-11'});assert.equal(part.status,206);assert.equal(part.headers.get('content-range'),`bytes 8-11/${WAV.length}`);assert.equal(part.headers.get('content-length'),'4');assert.equal(await part.text(),'WAVE');
 const tail=await get({Range:'bytes=-4'});assert.equal(tail.status,206);assert.equal(tail.headers.get('content-range'),`bytes ${WAV.length-4}-${WAV.length-1}/${WAV.length}`);
 const open=await get({Range:'bytes=40-'});assert.equal(open.status,206);assert.equal((await open.arrayBuffer()).byteLength,WAV.length-40);
 for(const bad of ['bytes=999999-','bytes=0-1,4-5','lines=1-2']){const r=await get({Range:bad});assert.equal(r.status,416,bad);assert.equal(r.headers.get('content-range'),`bytes */${WAV.length}`);assert.equal((await r.json()).error.code,'INVALID_RANGE');}
 const dl=await get({},'?download=1');assert.equal(dl.headers.get('content-type'),'application/octet-stream');assert.match(dl.headers.get('content-disposition'),/^attachment; filename="beep.wav"/);
 // A file that says it is larger than the limit is refused before a byte of it is stored.
 const refused=await new Promise((resolve,reject)=>{const req=http.request(`${h.origin}/api/tickets/${ticket.id}/attachments?name=big.bin`,{method:'PUT',headers:{'Content-Type':'application/octet-stream','Content-Length':String(FILE_LIMITS.file+1),Origin:h.origin,...h.admin}},res=>{res.resume();resolve(res.statusCode);req.destroy();});req.on('error',reject);req.write('x');});
 assert.equal(refused,413);
 assert.equal((await (await fetch(`${h.origin}/api/tickets/${ticket.id}`,{headers:h.admin})).json()).attachments.length,1);
});

test('a request has a deadline to arrive whole; only an upload a route streams may take longer',async t=>{
 const h=await hub(t,{requestDeadlineMs:150}),ticket=await (await h.post('/api/tickets',{project:'home-hub',title:'Slow line'},h.admin)).json();
 // Sends the first half, waits past the deadline, sends the rest. Resolves with the status, or 'cut' when the server hung up.
 const slowly=(method,path,type,body)=>new Promise(resolve=>{
  const req=http.request(h.origin+path,{method,headers:{'Content-Type':type,'Content-Length':String(body.length),Origin:h.origin,...h.admin}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});
  req.on('error',()=>resolve('cut'));req.write(body.subarray(0,Math.floor(body.length/2)));
  delay(450).then(()=>{if(!req.destroyed)req.end(body.subarray(Math.floor(body.length/2)));});
 });
 assert.equal(await slowly('POST','/api/tickets/comment','application/json',Buffer.from(JSON.stringify({id:ticket.id,text:'arrives too slowly'}))),'cut');
 assert.equal((await (await fetch(`${h.origin}/api/tickets/${ticket.id}`,{headers:h.admin})).json()).comments.length,0);
 assert.equal(await slowly('PUT',`/api/tickets/${ticket.id}/attachments?name=slow.png`,'application/octet-stream',PNG),201);
 // A request that is refused at once is not a way around the deadline: the answer goes out, and a body that
 // keeps trickling in after it is cut off when the deadline comes, not when the server's upload timeout does.
 // Resolves with the status and how long the server kept the connection.
 const trickle=(method,path,headers)=>new Promise(resolve=>{
  const started=Date.now();let status=null,feed=null;
  const req=http.request(h.origin+path,{method,headers:{'Content-Length':'100000',...headers}},res=>{status=res.statusCode;res.resume();});
  const done=()=>{clearInterval(feed);resolve({status,ms:Date.now()-started});};
  req.on('error',done);req.on('close',done);req.write('x');feed=setInterval(()=>{if(!req.destroyed&&req.writable)req.write('x');},40);
 });
 for(const [what,method,path,headers,status] of [
  ['a POST from another origin','POST','/api/tickets/comment',{'Content-Type':'application/json',Origin:'https://evil.example',...h.admin},403],
  ['MCP without a key','POST','/mcp',{'Content-Type':'application/json'},401],
  ['an upload without a sign-in','PUT',`/api/tickets/${ticket.id}/attachments?name=x.png`,{'Content-Type':'application/octet-stream',Origin:h.origin},401]]){
  const got=await trickle(method,path,headers);assert.equal(got.status,status,what);assert.ok(got.ms<1500,`${what}: held for ${got.ms} ms`);
 }
});

test('ticket attachments: a full ticket refuses before the file is stored; temp files of a dead upload are swept once',async t=>{
 const h=await hub(t),ticket=await (await h.post('/api/tickets',{project:'home-hub',title:'Full'},h.admin)).json(),store=h.handler.hub.state('tracker').tickets;
 for(let i=0;i<20;i++)await store.attach(ticket.id,{sha256:String(i%10).repeat(64),size:1,type:'application/octet-stream',name:`f${i}.bin`},'admin');
 const put=name=>fetch(`${h.origin}/api/tickets/${ticket.id}/attachments?name=${name}`,{method:'PUT',headers:{'Content-Type':'application/octet-stream',...h.admin,Origin:h.origin},body:PNG});
 const refused=await put('one-too-many.png');assert.equal(refused.status,409);assert.equal((await refused.json()).error.code,'TICKETS_FAILED');
 assert.deepEqual(await readdir(path.join(h.dir,'tickets','attachments')).catch(()=>[]),[],'nothing was written for it');
 // A large upload that is refused is read to its end first: the client gets the status, not a broken connection.
 const big=Buffer.alloc(6*1024*1024,7),large=(id,name)=>fetch(`${h.origin}/api/tickets/${id}/attachments?name=${name}`,{method:'PUT',headers:{'Content-Type':'application/octet-stream',...h.admin,Origin:h.origin},body:big});
 assert.equal((await large(ticket.id,'large.bin')).status,409);assert.equal((await large('HH-999','large.bin')).status,404);
 // A name is one file of a ticket: the second "Shot.PNG" is stored under a name of its own, and says so.
 const other=await (await h.post('/api/tickets',{project:'home-hub',title:'Names'},h.admin)).json();
 const named=async name=>(await (await fetch(`${h.origin}/api/tickets/${other.id}/attachments?name=${encodeURIComponent(name)}`,{method:'PUT',headers:{'Content-Type':'application/octet-stream',...h.admin,Origin:h.origin},body:PNG})).json()).attachments.map(a=>a.name);
 assert.deepEqual(await named('shot.png'),['shot.png']);assert.deepEqual(await named('Shot.PNG'),['shot.png','Shot-2.PNG']);assert.deepEqual(await named('shot.png'),['shot.png','Shot-2.PNG','shot-3.png']);
 assert.deepEqual((await named('README')).at(-1),'README');assert.deepEqual((await named('README')).at(-1),'README-2');
 assert.equal((await (await fetch(`${h.origin}/api/tickets/${other.id}`,{headers:h.admin})).json()).history.at(-1).to,'README-2','the history names the file as it is stored');
 // What an upload leaves when the process ends under it: gone at the first upload of the next process, and only then.
 const dir=await mkdtemp(path.join(os.tmpdir(),'ticket-files-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 await mkdir(path.join(dir,'attachments'));await writeFile(path.join(dir,'attachments','.upload-dead'),'half a file');
 const files=createTicketFiles(dir),body=async function*(){yield PNG;};
 const first=await files.put(body(),{name:'a.png'});assert.deepEqual(await readdir(path.join(dir,'attachments')),[first.sha256]);
 await writeFile(path.join(dir,'attachments','.upload-running'),'another upload of this process');
 await files.put((async function*(){yield Buffer.from('second file');})(),{name:'b.txt'});
 assert.ok((await readdir(path.join(dir,'attachments'))).includes('.upload-running'),'an upload in flight is never swept');
});
