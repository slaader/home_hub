// The demo plugin's page. A plugin view imports core helpers by URL, as the browser sees them.
import {el} from '/views.js';
import {pageHeader,emptyState} from '/ui.js';
export function demoPage({me,page}){
 const list=el('ul',{});
 fetch('/api/demo/notes').then(r=>r.json()).then(d=>list.replaceChildren(...(d.notes.length?d.notes.map(n=>el('li',{},n)):[emptyState({title:'No notes yet',body:'POST /api/demo/notes adds one.'})]))).catch(()=>{});
 return el('div',{},pageHeader({eyebrow:'Demo',title:page==='demo-admin'?'Admin notes':'Notes',lead:`Signed in as ${me.username}.`}),list);
}
