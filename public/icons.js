// Line icons for the shell and the shared components: one 24 × 24 path each, drawn with the current text
// colour (class ui-icon in tokens.css sizes them to 1em). Built as SVG nodes, never from markup strings.
//   icon('search')            → <svg class="ui-icon" aria-hidden="true">…</svg>
//   navIcon({hash, icon})     → the icon of a sidebar entry: the page's own, a glyph the module gave,
//                               or the first letter of its label
import {el} from './views.js';

const NS='http://www.w3.org/2000/svg';
const PATHS={
 grid:'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
 map:'M9 5 3 7v12l6-2 6 2 6-2V5l-6 2-6-2zM9 5v12M15 7v12',
 versions:'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16V8M8.5 11.5 12 8l3.5 3.5',
 key:'M8 19a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM11 12l9-9M16 7l3 3M14 9l2 2',
 shield:'M12 3 5 6v5c0 4.5 3 8.3 7 10 4-1.7 7-5.5 7-10V6l-7-3zM9 12l2 2 4-4',
 folder:'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z',
 list:'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
 tag:'M3 12V4h8l10 10-8 8L3 12zM7.5 8.5h.01',
 eye:'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
 users:'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21v-1a6 6 0 0 1 6-6h2a6 6 0 0 1 6 6v1M17 3.5a4 4 0 0 1 0 7M22 21v-1a6 6 0 0 0-4-5.6',
 settings:'M4 6h10M18 6h2M4 12h2M10 12h10M4 18h10M18 18h2M16 4v4M8 10v4M16 16v4',
 search:'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4',
 menu:'M4 6h16M4 12h16M4 18h16',
 sidebar:'M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM9 4v16',
 sun:'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
 moon:'M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5z',
 monitor:'M4 4h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM8 20h8M12 16v4',
 check:'M5 12.5l4.5 4.5L19 7.5',
 copy:'M9 9h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1zM16 9V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3',
 x:'M6 6l12 12M18 6 6 18',
 chevron:'M9 6l6 6-6 6',
 flag:'M5 21V4M5 4h11l-2 4 2 4H5',
 signout:'M9 21H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h4M16 17l5-5-5-5M21 12H9',
 plug:'M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0V8zM12 17v5',
 alert:'M12 3 2 20h20L12 3zM12 10v4M12 17h.01',
 info:'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8h.01',
 bolt:'M13 2 4 14h7l-1 8 9-12h-7l1-8z',
 cpu:'M7 7h10v10H7zM10 2v3M14 2v3M10 19v3M14 19v3M2 10h3M2 14h3M19 10h3M19 14h3',
 box:'M12 3 3 7.5v9L12 21l9-4.5v-9L12 3zM3 7.5 12 12l9-4.5M12 12v9',
 archive:'M3 4h18v5H3zM5 9v11h14V9M10 13h4',
 pulse:'M3 12h4l3-8 4 16 3-8h4',
 globe:'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z',
 offline:'M2 8.5a15 15 0 0 1 20 0M5.5 12a10 10 0 0 1 13 0M9 15.5a5 5 0 0 1 6 0M12 19h.01M3 3l18 18',
 external:'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
 puzzle:'M9 4h6v3a2 2 0 1 0 4 0h1v6h-3a2 2 0 1 0 0 4h3v3H9v-3a2 2 0 1 0-4 0H4v-6h3a2 2 0 1 0 0-4H4V4h5z',
};
export const ICONS=Object.freeze(Object.keys(PATHS));
// The core pages' icons, by page hash. A plugin page names its own in its nav entry (icon: one of ICONS,
// or a short glyph); anything else gets the first letter of its label.
const PAGE_ICONS={overview:'grid','inventory-map':'map',services:'box',versions:'versions',security:'key',hardening:'shield',projects:'folder',items:'list',releases:'tag',review:'eye',access:'users',settings:'settings',search:'search',welcome:'flag'};

export function icon(name,{title}={}){
 const d=PATHS[name];if(!d)return null;
 const svg=document.createElementNS(NS,'svg');
 svg.setAttribute('class','ui-icon');svg.setAttribute('viewBox','0 0 24 24');
 if(title){svg.setAttribute('role','img');svg.setAttribute('aria-label',title);}else svg.setAttribute('aria-hidden','true');
 const path=document.createElementNS(NS,'path');path.setAttribute('d',d);svg.append(path);
 return svg;
}
export const pageIcon=hash=>PAGE_ICONS[hash]||null;
export function navIcon({hash,icon:own,label}={}){
 const name=PATHS[own]?own:pageIcon(hash);
 if(name)return el('span',{class:'hh-nav-icon','aria-hidden':'true'},icon(name));
 const glyph=typeof own==='string'&&own?own:String(label||'').trim().slice(0,1);
 return el('span',{class:`hh-nav-icon${own?'':' letter'}`,'aria-hidden':'true'},glyph||'·');
}
