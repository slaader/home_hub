#!/usr/bin/env node
// Check the newest upstream version of every watched program → data/systems/upstream.json.
//   node scripts/check-upstream.mjs [--data DIR]
// Public release feeds (GitHub, Codeberg, PyPI, npm, Homebrew, nodejs.org, Thermo feed). GitHub answers
// are cached by ETag, per request. Anonymous GitHub is limited to 60 requests per hour; an optional token from
// GITHUB_TOKEN or private/github-token (GITHUB_TOKEN_FILE overrides the path) raises that. The token
// goes only to api.github.com and is never printed or written to data/. A failed source keeps its
// previous value, marked stale.
import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {checkUpstreams,createFetchJson,loadGithubToken} from '../server/systems-upstream.mjs';
import {softwareWatchPath} from '../server/site-config.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
const opt=name=>{const i=args.indexOf(name);return i>=0?args[i+1]:null;};
const dataDir=path.resolve(opt('--data')||process.env.DATA_DIR||path.join(root,'data'));
const outDir=process.env.SYSTEMS_DIR||path.join(dataDir,'systems');
const registry=JSON.parse(await readFile(softwareWatchPath(),'utf8'));
const file=path.join(outDir,'upstream.json');
const previous=await readFile(file,'utf8').then(JSON.parse).catch(()=>null);
const started=Date.now();
const github=await loadGithubToken();
if(github.invalid)console.warn(`GitHub token from ${github.source} is not a valid token; checking anonymously.`);
const doc=await checkUpstreams(registry,{previous,fetchJson:createFetchJson({token:github.token})});
await mkdir(outDir,{recursive:true,mode:0o700});
const tmp=`${file}.${process.pid}.tmp`;
await writeFile(tmp,JSON.stringify(doc,null,1)+'\n',{mode:0o600});await rename(tmp,file);
const entries=Object.entries(doc.results);
for(const [key,r] of entries)console.log(`${key.padEnd(44)} ${r.ok?r.version:'—'}${r.stale?' (stale)':''}${r.error?`  ! ${r.error}`:''}`);
const failed=entries.filter(([,r])=>!r.ok||r.stale).length;
console.log(`${entries.length} sources, ${failed} failed or stale → ${path.relative(process.cwd(),file)} (${((Date.now()-started)/1000).toFixed(1)} s, GitHub ${github.token?`with token from ${github.source}`:'anonymous'})`);
process.exitCode=entries.length&&failed===entries.length?1:0;
