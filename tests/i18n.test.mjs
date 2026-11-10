// UI language: every t('…') / tp(n,'…') literal in public/*.js has an English entry with the same
// placeholders, dictionary parts agree with each other, and t()/tp() behave in both languages.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const pub=path.join(path.dirname(fileURLToPath(import.meta.url)),'..','public');
const store=new Map();
globalThis.localStorage={getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,String(v))};
const i18n=await import('../public/i18n.js');
const {PARTS}=await import('../public/i18n-en.js');
const {t,tp,setLang,getLang,locale,dictionary}=i18n;

const unquote=raw=>JSON.parse('"'+raw.replace(/\\'/g,"'").replace(/"/g,'\\"')+'"');
const holes=s=>[...String(s).matchAll(/\{(\w+)\}/g)].map(m=>m[1]).sort().join(',');
function literals(){
 const out=[];
 for(const file of readdirSync(pub).filter(f=>f.endsWith('.js')&&!f.startsWith('i18n'))){
  const src=readFileSync(path.join(pub,file),'utf8');
  if(!/from '\.\/i18n\.js'/.test(src))continue;
  for(const m of src.matchAll(/(?<![\w.$])t\(\s*'((?:[^'\\\n]|\\.)*)'/g))out.push({file,key:unquote(m[1]),plural:false});
  for(const m of src.matchAll(/(?<![\w.$])tp\([^,()]+(?:\([^()]*\))?[^,()]*,\s*'((?:[^'\\\n]|\\.)*)'/g))out.push({file,key:unquote(m[1]),plural:true});
  for(const m of src.matchAll(/(?<![\w.$])tp?\(\s*`/g))out.push({file,key:null,template:src.slice(m.index,m.index+60)});
 }
 return out;
}

test('every translated literal has an English entry with the same placeholders',()=>{
 const found=literals();
 assert.ok(found.length>0);
 const templates=found.filter(x=>x.key===null).map(x=>`${x.file}: ${x.template}`);
 assert.deepEqual(templates,[],'t()/tp() keys must be plain literals with {placeholders}, not template strings');
 const missing=found.filter(x=>!Object.hasOwn(dictionary,x.key)).map(x=>`${x.file}: ${x.key}`);
 assert.deepEqual([...new Set(missing)],[]);
 for(const {file,key,plural} of found){
  const en=dictionary[key];
  if(plural){
   const cs=key.split('|'),e=en.split('|');
   assert.equal(cs.length,3,`${file}: Czech plural needs one|few|many: ${key}`);
   assert.equal(e.length,2,`${file}: English plural needs one|other: ${key}`);
   for(const form of e)assert.equal(holes(form).replace(/(^|,)n(?=,|$)/,'$1'),holes(cs[2]).replace(/(^|,)n(?=,|$)/,'$1'),`${file}: placeholders differ: ${key}`);
  }else assert.equal(holes(en),holes(key),`${file}: placeholders differ: ${key}`);
 }
});

test('dictionary parts agree and hold only strings',()=>{
 const seen=new Map();
 for(const [part,map] of Object.entries(PARTS))for(const [k,v] of Object.entries(map)){
  assert.equal(typeof v,'string',`${part}: ${k}`);
  assert.ok(v.trim(),`${part}: empty translation for ${k}`);
  if(seen.has(k))assert.equal(v,seen.get(k).v,`${part} and ${seen.get(k).part} translate "${k}" differently`);
  else seen.set(k,{part,v});
 }
});

test('t and tp follow the active language and fall back to Czech',()=>{
 assert.equal(getLang(),'en','without a site default the UI starts in English');assert.equal(locale(),'en-GB');
 i18n.setDefaultLang('cs');// what app.js does with site.json → defaultLanguage
 assert.equal(getLang(),'cs');assert.equal(locale(),'cs-CZ');
 assert.equal(t('Přehled'),'Přehled');
 assert.equal(t('Neznámý text {x}',{x:1}),'Neznámý text 1');
 assert.equal(tp(1,'{n} den|{n} dny|{n} dní'),'1 den');
 assert.equal(tp(3,'{n} den|{n} dny|{n} dní'),'3 dny');
 assert.equal(tp(7,'{n} den|{n} dny|{n} dní'),'7 dní');
 let changed=0;const on=()=>changed++;globalThis.addEventListener?.('langchange',on);
 setLang('en');
 assert.equal(getLang(),'en');assert.equal(locale(),'en-GB');assert.equal(store.get('hh-lang'),'en');
 assert.equal(t('Přehled'),'Overview');
 assert.equal(t('Neznámý text {x}',{x:1}),'Neznámý text 1','missing entry falls back to the Czech text');
 setLang('xx');assert.equal(getLang(),'en','unknown language is ignored');
 setLang('cs');assert.equal(t('Přehled'),'Přehled');
 if(globalThis.addEventListener){assert.equal(changed,2);globalThis.removeEventListener('langchange',on);}
});
