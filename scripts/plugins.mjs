#!/usr/bin/env node
// The plugins this hub loads, and the one link that lets plugins outside the core tree import core by name.
//
//   node scripts/plugins.mjs list                          every plugin directory this hub would load (HOME_HUB_PLUGINS_DIR,
//                                                          HOME_HUB_HOME's instance.json, else local/plugins), each plugin with
//                                                          its version and core range, and which core 'home-hub' means there
//   node scripts/plugins.mjs link [--plugins DIR]… [--at DIR]
//                                                          make <at>/node_modules/home-hub → this core checkout, so
//                                                          `import … from 'home-hub/plugin-api'` resolves to it
//
// --plugins: a plugin directory (the one holding <id>/index.mjs); default: the ones this hub would load. --at: where the
// link goes; default: HOME_HUB_HOME when set (one link for every source of the instance), else the plugin source (the
// directory the plugins directory sits in). Plugins inside the core tree need no link: Node resolves the name through
// the package's own exports. The link points at core itself; nothing is installed and npm is never run.
// A link that points at another checkout is replaced (and said so); a real file or directory there is never touched.
import {existsSync,lstatSync,mkdirSync,readdirSync,readlinkSync,realpathSync,symlinkSync,unlinkSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {pluginsDirectories,coreSeenFrom,pluginSource,readPluginManifest,CORE_VERSION} from '../server/plugins.mjs';
import {satisfies} from '../server/semver.mjs';

export const coreRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const inside=(dir,parent)=>{const rel=path.relative(parent,dir);return rel===''||(!rel.startsWith('..')&&!path.isAbsolute(rel));};

/** Makes the link for each plugin directory that needs one. → [{plugins, at, link, action: 'none'|'created'|'replaced'|'kept', was?}] */
export function linkCore({plugins=pluginsDirectories(),at=null,env=process.env,root=coreRoot}={}){
 const own=realpathSync(path.join(root,'package.json')),core=realpathSync(root),out=[];
 for(const raw of plugins){
  const dir=path.resolve(raw);
  if(!existsSync(dir))throw new Error(`${dir} does not exist`);
  const place=path.resolve(at??(env.HOME_HUB_HOME?env.HOME_HUB_HOME:path.dirname(dir)));
  if(coreSeenFrom(dir)===own&&!at){out.push({plugins:dir,at:place,link:null,action:'none'});continue;}
  if(inside(place,core))throw new Error(`${place} is inside this core checkout; plugins there need no link (Node resolves home-hub through package.json → exports)`);
  if(!inside(dir,place))throw new Error(`${place} is not above ${dir}: Node looks for node_modules/home-hub only in the directories above a plugin`);
  const modules=path.join(place,'node_modules'),link=path.join(modules,'home-hub');
  let action='created',was=null;
  let there=null;try{there=lstatSync(link);}catch{}
  if(there){
   if(!there.isSymbolicLink())throw new Error(`${link} exists and is not a link; move it away first (nothing was changed)`);
   was=readlinkSync(link);
   let same=false;try{same=realpathSync(link)===core;}catch{}
   if(same)action='kept';else{unlinkSync(link);action='replaced';}
  }
  if(action!=='kept'){mkdirSync(modules,{recursive:true});symlinkSync(core,link,'dir');}
  // The link must now be what a plugin there sees; a nearer node_modules/home-hub would shadow it.
  const seen=coreSeenFrom(dir);
  if(seen!==own){if(action!=='kept'){unlinkSync(link);}throw new Error(`after linking, plugins in ${dir} still see ${seen?path.dirname(seen):'no core'}: a nearer node_modules/home-hub is in the way`);}
  out.push({plugins:dir,at:place,link,action,...(was&&action==='replaced'?{was}:{})});
 }
 return out;
}

/** What `list` prints, as data: [{directory, source, core: 'this'|'other'|'none', plugins:[{id, version, core, fits}]}]. */
export function listPlugins({directories=pluginsDirectories(),root=coreRoot}={}){
 const own=realpathSync(path.join(root,'package.json'));
 return directories.map(dir=>{
  const exists=existsSync(dir),seen=exists?coreSeenFrom(dir):null,source=exists?pluginSource(dir,root):null;
  const names=exists?(lstatSync(dir).isDirectory()?readdirNames(dir):[]):[];
  return {directory:dir,exists,source:source?{name:source.name,version:source.version,core:source.core}:null,core:seen===own?'this':seen?'other':'none',
   plugins:names.map(name=>{let m=null,error=null;try{m=readPluginManifest(dir,name,{source});}catch(e){error=e.message;}
    return {id:name,version:m?.version??null,core:m?.core??null,fits:m?satisfies(CORE_VERSION,m.core):null,...(error?{error}:{})};})};
 });
}
const readdirNames=dir=>readdirSync(dir,{withFileTypes:true}).filter(d=>d.isDirectory()&&!d.name.startsWith('.')&&!d.name.startsWith('_')&&existsSync(path.join(dir,d.name,'index.mjs'))).map(d=>d.name).sort();

if(process.argv[1]===fileURLToPath(import.meta.url)){
 const [command,...args]=process.argv.slice(2);
 const values=name=>args.flatMap((a,i)=>a===name&&args[i+1]?[args[i+1]]:[]);
 try{
  if(command==='link'){
   const plugins=values('--plugins'),at=values('--at')[0]??null;
   for(const r of linkCore({...(plugins.length?{plugins}:{}),at}))
    console.log(r.action==='none'?`${r.plugins}: already sees this core (no link needed)`:`${r.link} → ${coreRoot} (${r.action}${r.was?`; was → ${r.was}`:''})`);
  }else if(command==='list'||command===undefined){
   console.log(`Home Hub core ${CORE_VERSION} at ${coreRoot}`);
   const dirs=listPlugins();if(!dirs.length)console.log('No plugin directories (HOME_HUB_PLUGINS_DIR=none).');
   let bad=false;
   for(const d of dirs){
    console.log(`\n${d.directory}${d.exists?'':' (missing)'}${d.source?`  source ${d.source.name}${d.source.version?' '+d.source.version:''}`:''}  home-hub → ${d.core==='this'?'this core':d.core==='other'?'ANOTHER core':'not resolvable (run: node scripts/plugins.mjs link --plugins '+d.directory+')'}`);
    if(d.core==='other')bad=true;
    for(const p of d.plugins){if(p.error||p.fits===false)bad=true;
     console.log(`  ${p.id.padEnd(16)} ${(p.version??'unversioned').padEnd(10)} ${p.error?'ERROR '+p.error:p.core?`core ${p.core}${p.fits?'':'  (does not fit '+CORE_VERSION+')'}`:'no plugin.json'}`);}
   }
   process.exitCode=bad?1:0;
  }else{console.error('usage: node scripts/plugins.mjs list | link [--plugins DIR]… [--at DIR]');process.exitCode=2;}
 }catch(e){console.error(e.message);process.exitCode=1;}
}
