#!/usr/bin/env node
// npm test. Two runs of node:test, because the two halves of this repository need different worlds:
//   core     tests/*.test.mjs                 a generic site (tests/fixtures/site.json), no plugins:
//                                             exactly what the public export ships
//   overlay  local/plugins/*/tests/*.test.mjs  the household's site.json and plugins (only when local/ exists)
//            local/tests/*.test.mjs
// Run it whole, every time. While iterating:  npm test -- tests/security.test.mjs  (files from one half
// or both; each goes to the right run).
//
// A plugin source somewhere else (a directory with plugins/ and a package.json; docs/plugins.md → Tests):
//   node <core>/scripts/run-tests.mjs --plugins <source> [--plugins <another>] [--site <file>]
// runs <source>/plugins/*/tests/*.test.mjs and <source>/tests/*.test.mjs, one run per source named after its
// package.json, with every given source's plugins loaded and the site --site (default: <source>/tests/fixtures/site.json,
// else none). Core's own tests are not run then.
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {existsSync,readdirSync,readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const hook=path.join(root,'tests','support','browser-paths.mjs');
const list=(dir,match=/\.test\.mjs$/)=>existsSync(dir)?readdirSync(dir).filter(f=>match.test(f)).sort().map(f=>path.join(dir,f)):[];
// The tests of a source: <dir>/plugins/<id>/tests/*.test.mjs, then <dir>/tests/*.test.mjs.
const sourceFiles=dir=>[...(existsSync(path.join(dir,'plugins'))?readdirSync(path.join(dir,'plugins'),{withFileTypes:true}).filter(d=>d.isDirectory()).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(d=>list(path.join(dir,'plugins',d.name,'tests'))):[]),...list(path.join(dir,'tests'))];
const sourceName=dir=>{try{const name=JSON.parse(readFileSync(path.join(dir,'package.json'),'utf8')).name;if(typeof name==='string'&&name)return name;}catch{}return path.basename(dir);};

const argv=process.argv.slice(2),sources=[],flags=[],named=[];let siteFile=null;
for(let i=0;i<argv.length;i++){
 const a=argv[i],value=()=>{const v=argv[++i];if(!v||v.startsWith('--')){console.error(`${a} needs a value`);process.exit(2);}return path.resolve(v);};
 if(a==='--plugins')sources.push(value());
 else if(a==='--site')siteFile=value();
 else if(a.startsWith('--'))flags.push(a);
 else named.push(path.resolve(a));
}
for(const dir of sources)if(!existsSync(path.join(dir,'plugins'))){console.error(`--plugins ${dir}: no plugins/ directory there`);process.exit(2);}

function run(label,files,env,cwd=root){
 return new Promise(resolve=>{
  if(!files.length)return resolve(null);
  console.log(`\n=== ${label}: ${files.length} file(s) ===`);
  // A throwaway key for sealed files (server/secret-box.mjs): no test reaches the Keychain or private/secret.key.
  // No instance directory from the shell (server/paths.mjs): a test says where its files are, or gets this checkout's defaults.
  const child=spawn(process.execPath,['--import',hook,'--test',...flags,...files],{cwd,env:{...process.env,HOME_HUB_HOME:'',HOME_HUB_CONFIG_DIR:'',HOME_HUB_PRIVATE_DIR:'',HOME_HUB_SECRET_KEY:randomBytes(32).toString('hex'),HOME_HUB_SECRET_KEY_FILE:path.join(os.tmpdir(),`home-hub-tests-${process.pid}`,'secret.key'),...env},stdio:['ignore','pipe','inherit']});
  // The reporter's own totals ("ℹ tests 12"), picked out of the stream line by line.
  const counts={};let rest='';
  child.stdout.on('data',d=>{process.stdout.write(d);const lines=(rest+d).split('\n');rest=lines.pop();for(const line of lines){const m=/^. (tests|pass|fail|skipped) (\d+)$/.exec(line);if(m)counts[m[1]]=Number(m[2]);}});
  child.on('close',code=>resolve({label,code,tests:counts.tests??NaN,pass:counts.pass??NaN,fail:counts.fail??NaN,skipped:counts.skipped??0}));
 });
}
const results=[];
if(sources.length){
 // Every given source's plugins are loaded in each run, so a plugin may need one from another source.
 const pluginDirs=sources.map(dir=>path.join(dir,'plugins')).join(path.delimiter);
 for(const dir of sources){
  const files=named.length?named.filter(f=>f.startsWith(dir+path.sep)):sourceFiles(dir);
  const site=siteFile??(existsSync(path.join(dir,'tests','fixtures','site.json'))?path.join(dir,'tests','fixtures','site.json'):'none');
  results.push(await run(sourceName(dir),files,{HOME_HUB_SITE_CONFIG:site,HOME_HUB_PLUGINS_DIR:pluginDirs},dir));
 }
}else{
 const overlayDir=path.join(root,'local');
 const isOverlay=f=>f.startsWith(overlayDir+path.sep);
 const core=named.length?named.filter(f=>!isOverlay(f)):list(path.join(root,'tests'));
 const overlay=named.length?named.filter(isOverlay):sourceFiles(overlayDir);
 results.push(await run('core',core,{HOME_HUB_SITE_CONFIG:path.join(root,'tests','fixtures','site.json'),HOME_HUB_PLUGINS_DIR:'none'}));
 results.push(await run('overlay',overlay,{HOME_HUB_SITE_CONFIG:siteFile??'',HOME_HUB_PLUGINS_DIR:''}));
}
const done=results.filter(Boolean),width=Math.max(8,...done.map(r=>r.label.length));
console.log('\n=== summary ===');
for(const r of done)console.log(`${r.label.padEnd(width)} tests ${r.tests}  pass ${r.pass}  fail ${r.fail}${r.skipped?`  skipped ${r.skipped}`:''}`);
const sum=k=>done.reduce((a,r)=>a+(Number.isFinite(r[k])?r[k]:0),0);
console.log(`${'total'.padEnd(width)} tests ${sum('tests')}  pass ${sum('pass')}  fail ${sum('fail')}`);
process.exit(done.some(r=>r.code!==0)||!done.length&&sources.length?1:0);
