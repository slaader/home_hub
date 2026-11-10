import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const plugins=process.env.HOME_HUB_PLUGINS_DIR&&process.env.HOME_HUB_PLUGINS_DIR!=='none'?path.resolve(process.env.HOME_HUB_PLUGINS_DIR):path.join(root,'local','plugins');
export async function resolve(specifier,context,next){
 if(/^\/[A-Za-z0-9._/-]+\.m?js$/.test(specifier)&&context.parentURL?.startsWith('file:')){
  const m=/^\/plugins\/([a-z][a-z0-9-]*)\/(.+)$/.exec(specifier);
  const file=m?path.join(plugins,m[1],'public',m[2]):path.join(root,'public',specifier.slice(1));
  if(existsSync(file))return {url:pathToFileURL(file).href,shortCircuit:true};
 }
 return next(specifier,context);
}
