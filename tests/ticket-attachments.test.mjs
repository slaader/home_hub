import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir} from 'node:fs/promises';
import path from 'node:path';
import {sniff,cleanName} from '../server/ticket-files.mjs';
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
