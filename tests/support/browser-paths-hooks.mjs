import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
// The plugin directories of this run: HOME_HUB_PLUGINS_DIR (one or more, separated by path.delimiter), else the overlay.
const chosen=process.env.HOME_HUB_PLUGINS_DIR;
const plugins=chosen==='none'?[]:chosen?chosen.split(path.delimiter).filter(Boolean).map(d=>path.resolve(d)):[path.join(root,'local','plugins')];
export async function resolve(specifier,context,next){
 if(/^\/[A-Za-z0-9._/-]+\.m?js$/.test(specifier)&&context.parentURL?.startsWith('file:')){
  const m=/^\/plugins\/([a-z][a-z0-9-]*)\/(.+)$/.exec(specifier);
  const file=m?plugins.map(dir=>path.join(dir,m[1],'public',m[2])).find(f=>existsSync(f)):path.join(root,'public',specifier.slice(1));
  if(file&&existsSync(file))return {url:pathToFileURL(file).href,shortCircuit:true};
 }
 return next(specifier,context);
}
