// The files a host agent loads (scripts/install-host-agent.mjs, docs/plugins.md → Host agents): its entry script and every
// module it imports, followed through relative `import … from`, `export … from`, bare `import '…'`, `import('…')` with a
// literal, and the named imports of core ('home-hub/<name>') through core's package.json → exports. Worked out from the
// code, never kept by hand, so the list cannot go stale when a module gains an import.
//
// Each file has a place in the installed copy, so the agent runs with no checkout and no link:
//   a file of the plugin source (its plugins/<id>/…, lib/…)   <target>/<path in the source>     (relative imports keep working)
//   a file of core                                            <target>/node_modules/home-hub/<path in core>
//   core's package.json                                       <target>/node_modules/home-hub/package.json (the name resolves through it)
// Refused (throws), so an installer never copies half an agent: another bare package (Home Hub has no dependencies), a
// name core does not export, a missing file, a file outside both trees, a plugin file that imports core by a relative
// path (it would break in the copy: import it by name), and a core file that imports a plugin file.
import {readFileSync,existsSync,statSync} from 'node:fs';
import path from 'node:path';

const PATTERNS=[/\b(?:import|export)\s*(?:[\w$*{},\s]+?\s*from\s*)?['"]([^'"\n]+)['"]/g,/\bimport\(\s*['"]([^'"\n]+)['"]\s*\)/g];
export const CORE_PREFIX='node_modules/home-hub';

/** The module specifiers a source text names. */
export function importsOf(source){
 const found=new Set();
 for(const re of PATTERNS)for(const m of source.matchAll(re))found.add(m[1]);
 return [...found];
}
const inside=(file,dir)=>{const rel=path.relative(dir,file);return rel!==''&&!rel.startsWith('..')&&!path.isAbsolute(rel);};
// 'home-hub/plugin-api' → the file core's package.json → exports names, or null.
export function exportedFile(spec,coreRoot){
 const m=/^home-hub(\/.+)?$/.exec(spec);if(!m)return null;
 const exports=JSON.parse(readFileSync(path.join(coreRoot,'package.json'),'utf8')).exports??{};
 const target=exports[m[1]?'.'+m[1]:'.'];
 return typeof target==='string'&&target.startsWith('./')?path.resolve(coreRoot,target):null;
}

/**
 * entry: the agent's entry file (absolute). sourceRoot: the plugin source it belongs to (the directory holding plugins/).
 * coreRoot: the core checkout. → [{from (absolute), to (path in the copy), part: 'plugin'|'core'}], sorted by `to`.
 */
export function agentClosure(entry,{sourceRoot,coreRoot}){
 const source=path.resolve(sourceRoot),core=path.resolve(coreRoot);
 const partOf=file=>inside(file,source)?'plugin':inside(file,core)?'core':null;
 const placeOf=(file,part)=>part==='plugin'?path.relative(source,file).split(path.sep).join('/'):`${CORE_PREFIX}/${path.relative(core,file).split(path.sep).join('/')}`;
 const seen=new Map(),queue=[path.resolve(entry)];
 const label=file=>{const part=partOf(file);return part?placeOf(file,part):file;};
 while(queue.length){
  const file=queue.shift();if(seen.has(file))continue;
  const part=partOf(file);
  if(!part)throw new Error(`${file} is outside the plugin source and the core checkout`);
  if(!existsSync(file)||!statSync(file).isFile())throw new Error(`${label(file)} does not exist`);
  seen.set(file,{from:file,to:placeOf(file,part),part});
  if(path.basename(file)==='package.json')continue;
  for(const spec of importsOf(readFileSync(file,'utf8'))){
   if(spec.startsWith('node:'))continue;
   if(/^home-hub(\/|$)/.test(spec)){
    const target=exportedFile(spec,core);if(!target)throw new Error(`${label(file)} imports "${spec}", which core's package.json does not export`);
    queue.push(target,path.join(core,'package.json'));continue;
   }
   if(!spec.startsWith('./')&&!spec.startsWith('../'))throw new Error(`${label(file)} imports "${spec}", which is not a relative file (Home Hub has no dependencies)`);
   const target=path.resolve(path.dirname(file),spec),to=partOf(target);
   if(!to)throw new Error(`${label(file)} imports ${spec}, which is outside the plugin source and the core checkout`);
   if(part==='plugin'&&to==='core')throw new Error(`${label(file)} imports the core file ${path.relative(core,target)} by a relative path; import it by name (home-hub/plugin-api)`);
   if(part==='core'&&to==='plugin')throw new Error(`core file ${label(file)} imports a plugin file (${spec})`);
   queue.push(target);
  }
 }
 return [...seen.values()].sort((a,b)=>a.to.localeCompare(b.to));
}
