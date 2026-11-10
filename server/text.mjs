// Sentences the server builds from data (a check's detail, a version note, a finding). The UI's source
// language is Czech, so each one is a Czech template with {placeholders}. The payload carries the
// finished Czech sentence (the field clients always had) and, next to it, the template and its
// parameters as "parts", so the browser can show the same sentence in the reader's language:
//   value: "zapnutý · 12 pravidel",  valueT: [{key: "zapnutý · {rules} pravidel", params: {rules: 12}}]
// A parameter that is a list holds source-language labels of its own; the browser translates each one.
// English for every template lives in public/i18n-en-*.js (tests/collectors.test.mjs checks they all do).
export const fill=(key,params={})=>key.replace(/\{(\w+)\}/g,(whole,name)=>name in params?(Array.isArray(params[name])?params[name].join(', '):String(params[name])):whole);
// tx(template, params[, legacy]) → {text, parts}. legacy = the sentence older clients know, when it
// differs from the filled template (a Czech plural that a template cannot express).
export const tx=(key,params={},legacy)=>({text:legacy??fill(key,params),parts:[{key,params}]});
const one=item=>typeof item==='string'?{text:item,parts:[{key:item,params:{}}]}:item;
// Several sentences in a row; plain strings are templates without parameters.
export const sentences=(...items)=>{const all=items.filter(Boolean).map(one);return {text:all.map(x=>x.text).join(' '),parts:all.flatMap(x=>x.parts)};};
export const textOf=v=>typeof v==='string'?v:v?.text??'';
// → {[name]: text} plus {[name]T: parts} when there is something to translate beyond the text itself.
export const field=(name,v)=>({[name]:textOf(v)||null,...(v&&typeof v==='object'&&v.parts?{[`${name}T`]:v.parts}:{})});
