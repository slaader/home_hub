#!/usr/bin/env node
// npm test. Two runs of node:test, because the two halves of this repository need different worlds:
//   core     tests/*.test.mjs                 a generic site (tests/fixtures/site.json), no plugins:
//                                             exactly what the public export ships
//   overlay  local/plugins/*/tests/*.test.mjs  the household's site.json and plugins (only when local/ exists)
//            local/tests/*.test.mjs
// Run it whole, every time. While iterating:  npm test -- tests/security.test.mjs  (files from one half
// or both; each goes to the right run).
import {spawn} from 'node:child_process';
import {existsSync,readdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const hook=path.join(root,'tests','support','browser-paths.mjs');
const list=(dir,match=/\.test\.mjs$/)=>existsSync(dir)?readdirSync(dir).filter(f=>match.test(f)).sort().map(f=>path.join(dir,f)):[];
const overlayDir=path.join(root,'local');
const overlayFiles=()=>[...(existsSync(path.join(overlayDir,'plugins'))?readdirSync(path.join(overlayDir,'plugins'),{withFileTypes:true}).filter(d=>d.isDirectory()).flatMap(d=>list(path.join(overlayDir,'plugins',d.name,'tests'))):[]),...list(path.join(overlayDir,'tests'))];
const flags=process.argv.slice(2).filter(a=>a.startsWith('--')),named=process.argv.slice(2).filter(a=>!a.startsWith('--')).map(f=>path.resolve(f));
const isOverlay=f=>f.startsWith(overlayDir+path.sep);
const core=named.length?named.filter(f=>!isOverlay(f)):list(path.join(root,'tests'));
const overlay=named.length?named.filter(isOverlay):overlayFiles();

function run(label,files,env){
 return new Promise(resolve=>{
  if(!files.length)return resolve(null);
  console.log(`\n=== ${label}: ${files.length} file(s) ===`);
  const child=spawn(process.execPath,['--import',hook,'--test',...flags,...files],{cwd:root,env:{...process.env,...env},stdio:['ignore','pipe','inherit']});
  // The reporter's own totals ("ℹ tests 12"), picked out of the stream line by line.
  const counts={};let rest='';
  child.stdout.on('data',d=>{process.stdout.write(d);const lines=(rest+d).split('\n');rest=lines.pop();for(const line of lines){const m=/^. (tests|pass|fail|skipped) (\d+)$/.exec(line);if(m)counts[m[1]]=Number(m[2]);}});
  child.on('close',code=>resolve({label,code,tests:counts.tests??NaN,pass:counts.pass??NaN,fail:counts.fail??NaN,skipped:counts.skipped??0}));
 });
}
const results=[
 await run('core',core,{HOME_HUB_SITE_CONFIG:path.join(root,'tests','fixtures','site.json'),HOME_HUB_PLUGINS_DIR:'none'}),
 await run('overlay',overlay,{HOME_HUB_SITE_CONFIG:'',HOME_HUB_PLUGINS_DIR:''}),
].filter(Boolean);
console.log('\n=== summary ===');
for(const r of results)console.log(`${r.label.padEnd(8)} tests ${r.tests}  pass ${r.pass}  fail ${r.fail}${r.skipped?`  skipped ${r.skipped}`:''}`);
const sum=k=>results.reduce((a,r)=>a+(Number.isFinite(r[k])?r[k]:0),0);
console.log(`${'total'.padEnd(8)} tests ${sum('tests')}  pass ${sum('pass')}  fail ${sum('fail')}`);
process.exit(results.some(r=>r.code!==0)?1:0);
