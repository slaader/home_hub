// Theme: light, dark, or whatever the system says. The choice is per browser (localStorage, like the
// language); nothing is stored for "system". tokens.css holds both palettes; data-theme on <html> forces
// one, and theme-boot.js sets it before the first paint. setTheme() raises 'themechange' on window, for
// anything that draws with colours it resolved itself (a canvas chart).
export const THEMES=Object.freeze(['system','light','dark']);
const KEY='hh-theme';
const BAR={dark:'#08070c',light:'#f6f4f1'};// the browser's own chrome around the page (theme-color)
const forced=v=>v==='light'||v==='dark';
let choice=(()=>{try{const v=globalThis.localStorage?.getItem(KEY);if(forced(v))return v;}catch{}return 'system';})();

export const getTheme=()=>choice;
// What is actually shown right now: 'light' or 'dark'.
export function resolvedTheme(){
 if(forced(choice))return choice;
 try{return globalThis.matchMedia?.('(prefers-color-scheme: light)').matches?'light':'dark';}catch{return 'dark';}
}
function apply(){
 const root=globalThis.document?.documentElement;if(!root)return;
 if(forced(choice))root.setAttribute('data-theme',choice);else root.removeAttribute('data-theme');
 for(const meta of globalThis.document.querySelectorAll?.('meta[name="theme-color"]')||[]){
  const own=meta.getAttribute('data-scheme');
  meta.setAttribute('content',BAR[forced(choice)?choice:own]||BAR.dark);
 }
}
export function setTheme(next){
 if(!THEMES.includes(next)||next===choice)return;
 choice=next;
 try{if(forced(next))globalThis.localStorage?.setItem(KEY,next);else globalThis.localStorage?.removeItem(KEY);}catch{}
 apply();
 globalThis.dispatchEvent?.(new Event('themechange'));
}
apply();
// The system switched (sunset, a settings change) while the page is open and no theme is forced.
try{globalThis.matchMedia?.('(prefers-color-scheme: light)').addEventListener?.('change',()=>{if(!forced(choice))globalThis.dispatchEvent?.(new Event('themechange'));});}catch{}
