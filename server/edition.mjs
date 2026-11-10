// Which tree this is. The private checkout carries the household overlay under local/ and says
// {"edition":"private"} in edition.json; scripts/export-public.mjs writes {"edition":"public"} into the
// exported tree. HOME_HUB_EDITION overrides the file (tests). A tree without a marker counts as public,
// so nothing household-specific is ever assumed by accident.
// Keep branching on this to a minimum: what differs between households belongs in local/site.json.
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const repoRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const EDITIONS=Object.freeze(['private','public']);
export function readEdition(root=repoRoot,env=process.env){
 const forced=env.HOME_HUB_EDITION;
 if(forced!==undefined&&forced!==''){if(!EDITIONS.includes(forced))throw new Error(`HOME_HUB_EDITION must be one of ${EDITIONS.join(', ')}`);return forced;}
 try{const value=JSON.parse(readFileSync(path.join(root,'edition.json'),'utf8')).edition;if(EDITIONS.includes(value))return value;}catch{}
 return 'public';
}
export const isPublicRelease=(root=repoRoot,env=process.env)=>readEdition(root,env)==='public';
