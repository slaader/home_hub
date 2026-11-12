#!/usr/bin/env node
// Imports older request history into the hub's own runtime history (server/runtime-history.mjs), so the
// LLM & Diffusion page shows it: a JSONL file on this machine, in the store's own format or the v1 compute
// bridge's (history-YYYY-MM.jsonl of a v1 hub, which names the client of each request).
//
//   node scripts/import-runtime-history.mjs --machine <id> [--dry-run] <file.jsonl> [<file.jsonl> …]
//
// Reads only the files named; fetches nothing. Records are de-duplicated against what the store holds (by
// metricKey: machine, runtime, the runtime's record id and its time), so running it twice adds nothing; a
// record that names a client is kept beside an unattributed copy, and reading prefers it. Writes to
// $STATE_DIR, else $DATA_DIR/state, else data/state of HOME_HUB_HOME or of this checkout (server/paths.mjs):
// <state>/runtimes/<machine>/.
// Stop the hub first, or restart it after: a running hub keeps its own window of known keys.
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequestHistory,fromImportLine} from '../server/runtime-history.mjs';
import {resolvePaths} from '../server/paths.mjs';

export function stateDirectory(env=process.env){return resolvePaths(env).state;}
export function parseArgs(argv){
 const out={machine:null,dryRun:false,files:[]};
 for(let i=0;i<argv.length;i++){
  const a=argv[i];
  if(a==='--machine')out.machine=argv[++i]??null;
  else if(a==='--dry-run')out.dryRun=true;
  else if(a.startsWith('--'))throw new Error(`unknown option ${a}`);
  else out.files.push(a);
 }
 if(!out.machine||!/^[a-z][a-z0-9_-]{1,31}$/.test(out.machine))throw new Error('--machine <id> is required (a machine id of site.json)');
 if(!out.files.length)throw new Error('name at least one JSONL file');
 for(const f of out.files)if(/^[a-z][a-z0-9+.-]*:\/\//i.test(f))throw new Error(`${f}: a local file path, not a URL`);
 return out;
}
// → {read, valid, added, known, skipped} over all files.
export async function importFiles({machine,files,dryRun=false,state=stateDirectory(),now=Date.now()}){
 const store=createRequestHistory(state);const total={read:0,valid:0,added:0,known:0,skipped:0};
 for(const file of files){
  const records=[];
  for(const line of (await readFile(file,'utf8')).split('\n')){
   if(!line.trim())continue;total.read++;
   let raw;try{raw=JSON.parse(line);}catch{total.skipped++;continue;}
   const r=fromImportLine(raw,{machine});if(r)records.push(r);else total.skipped++;
  }
  total.valid+=records.length;
  if(dryRun||!records.length)continue;
  for(let i=0;i<records.length;i+=5000){const r=await store.ingest(machine,records.slice(i,i+5000),{now,window:false});total.added+=r.added;total.known+=r.known;total.skipped+=r.skipped;}
 }
 return total;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const args=parseArgs(process.argv.slice(2)),state=stateDirectory();
  const r=await importFiles({...args,state});
  console.log(`${args.dryRun?'dry run: ':''}${r.read} lines, ${r.valid} requests of ${args.machine}; added ${r.added}, already there ${r.known}, left out ${r.skipped}${args.dryRun?'':` → ${path.join(state,'runtimes',args.machine)}`}`);
 }catch(e){console.error(`import-runtime-history: ${e.message}`);process.exit(1);}
}
