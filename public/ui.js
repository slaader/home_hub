// Shared building blocks for pages: a page header, an empty state and a "not installed" notice.
// Text-safe DOM only (SPEC.md): every string lands in a text node or an attribute, never in innerHTML.
// Looks come from the design tokens in tokens.css (classes ui-*). Strings passed in are shown as given:
// translate them with t() at the call site, like everywhere else.
import {el} from './views.js';
import {t} from './i18n.js';

// Copies text to the clipboard; returns whether it worked (clipboard access can be refused).
export async function copyText(text){
 try{await navigator.clipboard.writeText(String(text));return true;}catch{}
 // Older or non-secure contexts: a hidden textarea and execCommand.
 try{const area=el('textarea',{'aria-hidden':'true',style:'position:fixed;left:-9999px;top:0;opacity:0'});area.value=String(text);document.body.append(area);area.select();const ok=document.execCommand('copy');area.remove();return ok;}catch{return false;}
}
// A block of text to hand to something else (an agent prompt, a config snippet) with its own Copy button.
export function copyBlock(label,text){
 const button=el('button',{type:'button',class:'ui-button small',onclick:async()=>{const ok=await copyText(text);button.textContent=ok?t('Zkopírováno'):t('Kopírování selhalo');setTimeout(()=>{button.textContent=t('Kopírovat');},1800);}},t('Kopírovat'));
 return el('div',{class:'ui-copy'},el('div',{class:'ui-copy-head'},el('span',{},label),button),el('pre',{tabindex:'0'},String(text)));
}
// action: {label, href} for a link, {label, onclick} for a button; primary:true marks the main one.
const actionNode=a=>a.href
 ?el('a',{class:`ui-button${a.primary?' primary':''}`,href:a.href,...(/^https?:/.test(a.href)?{target:'_blank',rel:'noopener noreferrer'}:{})},a.label)
 :el('button',{type:'button',class:`ui-button${a.primary?' primary':''}`,onclick:a.onclick},a.label);
const actionsRow=(actions,cls='ui-actions')=>actions?.length?el('div',{class:cls},actions.filter(Boolean).map(actionNode)):null;

// How an agent connects to this hub over MCP with a service-account key (Users and API → service accounts).
// token: the key itself when it was just issued; otherwise a placeholder the reader replaces.
export function mcpSnippet(token='hhk_…',origin=globalThis.location?.origin||''){
 const mcp=`${origin}/mcp`;
 return `# Claude Code\nclaude mcp add --transport http home-hub ${mcp} \\\n  --header "Authorization: Bearer ${token}"\n\n# Codex (~/.codex/config.toml)\n[mcp_servers.home-hub]\nurl = "${mcp}"\nhttp_headers = { Authorization = "Bearer ${token}" }\n\n# HTTP API\ncurl -s -H "Authorization: Bearer ${token}" ${origin}/api/home`;
}

/**
 * The top of a page: optional eyebrow (section name), the title, one lead sentence, actions on the right.
 * pageHeader({eyebrow, title, lead, actions:[{label, href|onclick, primary}]})
 */
export function pageHeader({eyebrow,title,lead,actions}={}){
 return el('header',{class:'ui-head'},
  el('div',{class:'ui-head-text'},eyebrow?el('p',{class:'ui-eyebrow'},eyebrow):null,el('h1',{},title||''),lead?el('p',{class:'ui-lead'},lead):null),
  actionsRow(actions,'ui-head-actions'));
}

/**
 * What a page shows when it has nothing yet: what belongs here and how to fill it.
 * emptyState({icon, title, body, steps:[], agentPrompt, mcpSnippet, actions:[]})
 *   steps        short how-to lines, shown as a numbered list
 *   agentPrompt  a ready prompt for a coding agent, with a Copy button
 *   mcpSnippet   true = show how to connect an agent to this hub (mcpSnippet() above); or your own text
 */
export function emptyState({icon,title,body,steps,agentPrompt,mcpSnippet:snippet,actions}={}){
 return el('section',{class:'ui-empty',role:'status'},
  icon?el('div',{class:'ui-empty-icon','aria-hidden':'true'},icon):null,
  el('h2',{},title||''),
  body?el('p',{},body):null,
  steps?.length?el('ol',{},steps.map(step=>el('li',{},step))):null,
  agentPrompt?copyBlock(t('Zadání pro agenta'),agentPrompt):null,
  snippet?copyBlock(t('Připojení agenta (MCP)'),snippet===true?mcpSnippet():snippet):null,
  actionsRow(actions));
}

/**
 * A feature whose optional companion is not set up on this hub (a soft dependency): say what is missing
 * and how to get it, instead of an error.
 * notInstalled({dependency, installUrl, steps:[], title, body})
 */
export function notInstalled({dependency,installUrl,steps,title,body}={}){
 return el('section',{class:'ui-empty ui-missing',role:'status'},
  el('div',{class:'ui-empty-icon','aria-hidden':'true'},'⧉'),
  el('h2',{},title||t('{name} tu není nainstalované',{name:dependency||''})),
  el('p',{},body||t('Tahle část potřebuje {name}. Bez něj zbytek Home Hubu funguje dál.',{name:dependency||''})),
  steps?.length?el('ol',{},steps.map(step=>el('li',{},step))):null,
  installUrl?actionsRow([{label:t('Jak nainstalovat {name}',{name:dependency||''}),href:installUrl,primary:true}]):null);
}
