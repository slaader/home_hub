// UI language. Czech is the source language of the code: every UI string is written in Czech and passed through t(),
// which returns it as-is in Czech or looks it up in the English dictionary (gettext-style, the Czech text
// is the key). A missing English entry falls back to the Czech text, never to an empty string.
//   t('Přehled')                              → 'Overview'
//   t('Stroj {name} neodpovídá.',{name})      → placeholders {x}, same names in both languages
//   tp(n,'{n} den|{n} dny|{n} dní')           → Czech one|few|many; English entry '{n} day|{n} days'
// Strings sent by the server (error messages, scope labels, check names) go through t() as well, so a
// static server message translates once its Czech text is in the dictionary.
// Which language a browser starts in is the site's choice (site.json → defaultLanguage; English when
// there is no site configuration): app.js passes it to setDefaultLang() once the UI manifest arrives.
// A person's own choice lives in localStorage (per browser), set from the profile menu or the sign-in screen;
// setLang() raises 'langchange' and app.js draws the page again. Call t() at render time, not at module
// load, or the string stays in the language that was active when the module was imported.
import EN from './i18n-en.js';

export const LANGS=Object.freeze([['cs','Čeština','CZ'],['en','English','EN']]);
const KEY='hh-lang';
const valid=v=>LANGS.some(([id])=>id===v);
// chosen = this browser's own stored choice, which a site default never overrides.
let chosen=(()=>{try{const v=globalThis.localStorage?.getItem(KEY);if(valid(v))return v;}catch{}return null;})();
let lang=chosen??'en';
// Translations added at run time (a plugin's or the site's own strings from the UI manifest), by language.
const extra={};
export function addStrings(byLang){for(const [id,dict] of Object.entries(byLang||{}))if(valid(id)&&dict&&typeof dict==='object')extra[id]={...extra[id],...dict};}
const lookup=s=>lang!=='cs'&&extra[lang]&&Object.hasOwn(extra[lang],s)?extra[lang][s]:lang==='en'&&Object.hasOwn(EN,s)?EN[s]:null;

export const getLang=()=>lang;
// Locale for Intl formatters: dates, numbers. en-GB keeps day-month order and the 24-hour clock.
export const locale=()=>lang==='en'?'en-GB':'cs-CZ';
const fill=(s,vars)=>vars?s.replace(/\{(\w+)\}/g,(m,k)=>Object.hasOwn(vars,k)&&vars[k]!=null?String(vars[k]):m):s;
export function t(cs,vars){
 const s=String(cs??'');
 return fill(lookup(s)??s,vars);
}
export function tp(n,forms,vars){
 const translated=lookup(forms),en=translated!==null;
 const list=(en?translated:forms).split('|');
 const i=en?(n===1?0:1):n===1?0:n>=2&&n<=4?1:2;
 return fill(list[Math.min(i,list.length-1)],{n,...vars});
}
export function setLang(next){
 if(!valid(next)||next===lang)return;
 lang=chosen=next;
 try{globalThis.localStorage?.setItem(KEY,next);}catch{}
 if(globalThis.document?.documentElement)document.documentElement.lang=next;
 globalThis.dispatchEvent?.(new Event('langchange'));
}
// The site's default: applies only while this browser has made no choice of its own.
export function setDefaultLang(next){
 if(chosen||!valid(next)||next===lang)return;
 lang=next;
 if(globalThis.document?.documentElement)document.documentElement.lang=next;
 globalThis.dispatchEvent?.(new Event('langchange'));
}
if(globalThis.document?.documentElement)document.documentElement.lang=lang;
// Tests only: the dictionary, to check that every t('…') literal in the UI has an English entry.
export const dictionary=EN;
