// A small, safe Markdown subset for Project Tracker text (descriptions, comments, release notes).
// Agents and people write Markdown there; showing it raw ("**bold**", "- item") reads badly.
// Builds DOM nodes with el() only: no innerHTML, so text stays inert. Links: http(s) only, and ticket
// ids of known projects (HH-12) become #items links.
//   Blocks: paragraphs (single newlines kept), # headings, - / * / • lists, 1. / 1) lists,
//           ``` code fences, > quotes, a short line ending in ":" right before a list becomes a label.
//   Inline: **bold**, *italic*, `code`, http(s) links, absolute paths (/tmp/…, ~/…) and ENV_NAMES as code,
//           ticket ids, and ![name] for a file of the ticket: the caller's `files(name)` returns the node to
//           show for it (a chip), or null when the ticket has no such file and the text stays as written.
import {el} from './views.js';

// A file of the ticket, by name. Not a Markdown image: "![alt](url)" is left alone.
export const FILE_TOKEN=/!\[([^\[\]\n]{1,120})\](?!\()/;

const BULLET=/^\s*[-*•]\s+(.*)$/,NUMBER=/^\s*(\d{1,3})[.)]\s+(.*)$/,HEADING=/^(#{1,4})\s+(.*)$/,FENCE=/^\s*```/,QUOTE=/^\s*>\s?(.*)$/;
const isList=line=>BULLET.test(line)||NUMBER.test(line);

export function markdown(text,{keys=[],cls='tk-md',files=null}={}){
 const lines=String(text??'').replace(/\r\n?/g,'\n').split('\n'),out=[];
 const ids=keys.length?new RegExp(`\\b(?:${keys.map(k=>k.replace(/[^A-Z0-9]/g,'')).filter(Boolean).join('|')})-[1-9][0-9]{0,5}\\b`):null;
 const span=s=>inline(s,ids,files);
 for(let i=0;i<lines.length;){
  const line=lines[i];
  if(!line.trim()){i++;continue;}
  if(FENCE.test(line)){
   const code=[];i++;
   while(i<lines.length&&!FENCE.test(lines[i]))code.push(lines[i++]);
   i++;out.push(el('pre',{class:'tk-md-pre'},el('code',{},code.join('\n'))));continue;
  }
  const h=line.match(HEADING);
  if(h){out.push(el('h4',{class:'tk-md-h'},span(h[2])));i++;continue;}
  if(QUOTE.test(line)){
   const q=[];while(i<lines.length&&QUOTE.test(lines[i]))q.push(lines[i++].match(QUOTE)[1]);
   out.push(el('blockquote',{class:'tk-md-quote'},lineBreaks(q,span)));continue;
  }
  if(isList(line)){
   const ordered=NUMBER.test(line),items=[];let start=ordered?Number(line.match(NUMBER)[1]):null;
   while(i<lines.length&&(ordered?NUMBER:BULLET).test(lines[i])){
    const m=lines[i].match(ordered?NUMBER:BULLET),item=[ordered?m[2]:m[1]];i++;
    // continuation lines (indented, not a new item) belong to the item
    while(i<lines.length&&/^\s{2,}\S/.test(lines[i])&&!isList(lines[i]))item.push(lines[i++].trim());
    items.push(el('li',{},lineBreaks(item,span)));
   }
   const list=el(ordered?'ol':'ul',{class:'tk-md-list'},items);
   if(ordered&&start>1)list.setAttribute('start',String(start));
   out.push(list);continue;
  }
  // paragraph: consecutive plain lines; a short "Label:" line directly before a list becomes a label
  const para=[];
  while(i<lines.length&&lines[i].trim()&&!isList(lines[i])&&!FENCE.test(lines[i])&&!HEADING.test(lines[i])&&!QUOTE.test(lines[i]))para.push(lines[i++]);
  const last=para.at(-1);
  if(i<lines.length&&isList(lines[i])&&last.trim().endsWith(':')&&last.length<=80){
   para.pop();if(para.length)out.push(el('p',{},lineBreaks(para,span)));
   out.push(el('p',{class:'tk-md-label'},span(last.trim().replace(/:$/,''))));
  }else out.push(el('p',{},lineBreaks(para,span)));
 }
 return el('div',{class:cls},out);
}
const lineBreaks=(lines,span)=>lines.flatMap((l,i)=>i?[el('br',{}),...span(l)]:span(l));

// Inline: one left-to-right scan; the earliest match wins, bold before italic.
const RULES=[
 ['code',/`([^`\n]+)`/],
 ['bold',/\*\*([^*\n]+?)\*\*/],
 ['italic',/(?<![\w*])\*([^*\s][^*\n]*?)\*(?![\w*])/],
 ['link',/https?:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]]/],
 ['const',/(?<![\w$])[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+(?:\/[A-Z0-9_]+)*(?:_\*)?(?![\w$])/],
 ['path',/(?<![\w/~.])(?:~\/|\/(?:tmp|Users|opt|etc|var|Library|private|Volumes)\/)[^\s,;:'"`()<>]*[^\s,;:'"`()<>.]/],
];
function inline(text,ids,files){
 const out=[],rules=[...RULES,...(files?[['file',FILE_TOKEN]]:[]),...(ids?[['ticket',ids]]:[])];let rest=String(text);
 while(rest){
  let best=null;
  for(const [kind,re] of rules){const m=rest.match(re);if(m&&(!best||m.index<best.m.index))best={kind,m};}
  if(!best){out.push(rest);break;}
  const {kind,m}=best;if(m.index)out.push(rest.slice(0,m.index));
  if(kind==='code'||kind==='path'||kind==='const')out.push(el('code',{class:'tk-md-code'},kind==='code'?m[1]:m[0]));
  else if(kind==='bold')out.push(el('strong',{},inline(m[1],ids,files)));
  else if(kind==='italic')out.push(el('em',{},inline(m[1],ids,files)));
  else if(kind==='file'){
   // Not a file of this ticket: only the "![" is passed over, so what stands in the brackets is read as before.
   const node=files(m[1]);if(!node){out.push('![');rest=rest.slice(m.index+2);continue;}
   out.push(node);
  }
  else if(kind==='link')out.push(el('a',{href:m[0],target:'_blank',rel:'noopener noreferrer',class:'sys-link'},m[0]));
  else out.push(el('a',{href:'#items/'+m[0],class:'tk-md-ticket'},m[0]));
  rest=rest.slice(m.index+m[0].length);
 }
 return out;
}
