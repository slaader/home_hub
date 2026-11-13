// Project Tracker Markdown subset: structure, and that nothing in the text can become markup or a script link.
import test from 'node:test';
import assert from 'node:assert/strict';

class N{constructor(tag,text=''){this.tag=tag;this.text=text;this.children=[];this.attrs={};}
 setAttribute(k,v){this.attrs[k]=String(v);}addEventListener(){}append(...c){this.children.push(...c);}
 get textContent(){return this.text+this.children.map(c=>c.textContent).join('');}}
globalThis.Node=N;globalThis.document={createElement:t=>new N(t),createTextNode:s=>new N('#text',s)};
const {markdown}=await import('../public/tracker-md.js');
const all=(n,f)=>[n,...n.children.flatMap(c=>all(c,()=>true))].filter(f);
const tags=n=>n.children.map(c=>c.tag);

test('markdown: blocks, label before a list, inline styles',()=>{
 const md=markdown('**Second exposure:** every agent sees `KEY`.\n\nCo s tím:\n1. Přesměrovat\n2. Restart HH-12\n- a\n- b\n\n# Nadpis\nline one\nline two',{keys:['HH']});
 assert.deepEqual(tags(md),['p','p','ol','ul','h4','p']);
 assert.equal(md.children[1].attrs.class,'tk-md-label');assert.equal(md.children[1].textContent,'Co s tím');
 assert.equal(all(md,n=>n.tag==='strong')[0].textContent,'Second exposure:');
 assert.equal(all(md,n=>n.tag==='code')[0].textContent,'KEY');
 assert.equal(all(md,n=>n.tag==='a'&&n.attrs.href==='#items/HH-12').length,1);
 assert.equal(all(md.children[5],n=>n.tag==='br').length,1);
 assert.ok(!md.textContent.includes('**'));
});

test('markdown: paths become code, UTF-8 is not a ticket, ordered lists keep their start',()=>{
 const md=markdown('Detaily: /tmp/hh-verify/ob1-mini.md a ~/.local/bin/ob1-mcp-remote.\nUTF-8 text\n\n3. třetí\n4. čtvrtý',{keys:['HH']});
 assert.deepEqual(all(md,n=>n.tag==='code').map(n=>n.textContent),['/tmp/hh-verify/ob1-mini.md','~/.local/bin/ob1-mcp-remote']);
 const env=markdown('klíč CODEX_OB1_ACCESS_KEY a CODEX_OB1_* pryč (CLIENT_ID/SECRET), HTTP ne');
 assert.deepEqual(all(env,n=>n.tag==='code').map(n=>n.textContent),['CODEX_OB1_ACCESS_KEY','CODEX_OB1_*','CLIENT_ID/SECRET']);
 assert.equal(all(md,n=>n.tag==='a').length,0);
 assert.equal(all(md,n=>n.tag==='ol')[0].attrs.start,'3');
});

test('markdown: text stays inert',()=>{
 const md=markdown('<img src=x onerror=alert(1)> [x](javascript:alert(1)) javascript:alert(1) **<b>hi</b>** ```\n<script>\n```',{keys:['HH']});
 assert.equal(all(md,n=>['img','script','b'].includes(n.tag)).length,0);
 assert.ok(all(md,n=>n.tag==='a').every(n=>/^https?:\/\//.test(n.attrs.href)||n.attrs.href.startsWith('#items/')));
 assert.ok(md.textContent.includes('<img src=x onerror=alert(1)>'));
 const link=all(markdown('see https://example.test/a?b=1.'),n=>n.tag==='a')[0];
 assert.equal(link.attrs.href,'https://example.test/a?b=1');assert.equal(link.attrs.rel,'noopener noreferrer');
});

test('markdown: ![name] is a file of the ticket when the caller knows one of that name, and text otherwise',()=>{
 const asked=[],files=name=>{asked.push(name);if(name==='never.png')return null;const chip=new N('span');chip.attrs['data-file']=name;return chip;};
 const md=markdown('See ![shot 1.png] and **![clip.mp4]**, not ![never.png], not ![a picture](https://example.test/a.png), not `![code.png]`.\n\n```\n![fenced.png]\n```',{files});
 assert.deepEqual(all(md,n=>n.attrs['data-file']).map(n=>n.attrs['data-file']),['shot 1.png','clip.mp4']);
 assert.equal(all(md,n=>n.tag==='strong')[0].children[0].attrs['data-file'],'clip.mp4','inside bold too');
 assert.deepEqual(asked,['shot 1.png','clip.mp4','never.png'],'a Markdown image, inline code and a code fence never ask');
 assert.ok(md.textContent.includes('![never.png]')&&md.textContent.includes('![a picture]('),'what is not a file stays as written');
 assert.equal(all(md,n=>n.tag==='code')[0].textContent,'![code.png]');
 // Without the caller's files nothing changes: a release note or a search snippet keeps the text.
 const plain=markdown('See ![shot 1.png]');assert.equal(plain.textContent,'See ![shot 1.png]');assert.equal(all(plain,n=>n.attrs['data-file']).length,0);
 assert.equal(markdown('![a\nb.png]',{files}).textContent,'![ab.png]','a name does not span lines');
 // Brackets that name no file are read as they always were: a ticket id or a link inside them still links.
 const other=markdown('![HH-12] and ![see https://example.test/x]',{files:()=>null,keys:['HH']});
 assert.deepEqual(all(other,n=>n.tag==='a').map(a=>a.attrs.href),['#items/HH-12','https://example.test/x']);assert.equal(other.textContent,'![HH-12] and ![see https://example.test/x]');
});
