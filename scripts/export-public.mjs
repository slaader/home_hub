#!/usr/bin/env node
// Writes the public core of this repository into a directory:
//   node scripts/export-public.mjs <outDir> [--force]
// It copies the tracked files outside the overlay, state and deployment directories (the list is
// exportFiles() in scripts/leak-scan.mjs), marks the tree {"edition":"public"}, and writes its README: the
// repository's own README.md without its private sections (publicReadme below).
// Before anything is written it scans those files for household details and refuses on a finding (exit 1):
// the owner's name, the home subnet, home paths, the site name, the home domain, e-mail addresses outside
// the placeholder domains. Nothing is pushed or published; the output is a plain directory.
import {mkdirSync,copyFileSync,writeFileSync,readFileSync,existsSync,readdirSync,statSync,chmodSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {exportFiles,scanLeaks,scanText,formatFindings,repoRoot} from './leak-scan.mjs';

// The README of the public tree is the repository's README.md with its private sections cut out:
//   <!-- home-hub:public-readme -->          somewhere in the file: "this README is written for the public"
//   <!-- private:begin --> … <!-- private:end -->   left out of the export (this household's deployment)
// A README without the first marker is taken to describe one deployment and is not used at all: the short
// text in FALLBACK_README stands in. An unclosed private block is an error, never a silent leak. Whatever
// comes out is scanned like every other exported file, so a household detail outside the markers still
// refuses the export. Nothing about the private repository (a commit, a path) is added.
export const PUBLIC_README_MARK='<!-- home-hub:public-readme -->';
const PRIVATE_BLOCK=/[ \t]*<!-- private:begin -->[\s\S]*?<!-- private:end -->[ \t]*\n?/g;
export function readmeFromSource(text){
 if(typeof text!=='string'||!text.includes(PUBLIC_README_MARK))return null;
 const out=text.replace(PRIVATE_BLOCK,'');
 if(/<!-- private:(begin|end) -->/.test(out))throw new Error('README.md: a private block is not closed (every <!-- private:begin --> needs its <!-- private:end -->).');
 return out.replace(/\n{3,}/g,'\n\n').trimEnd()+'\n';
}
// source: the text of README.md, or nothing for the fallback.
export const publicReadme=({source=null}={})=>readmeFromSource(source)??FALLBACK_README;
const FALLBACK_README=`# Home Hub

One page for a home network: the machines and how they are doing, what runs where and what depends on what,
who may reach it, and a small tracker for your own projects. One Node process, no third-party dependencies,
a plain-JavaScript front end, and an MCP endpoint so agents can read and maintain the same data.

This is the public core. It knows no particular household: you describe yours in \`local/site.json\` and add
your own features as plugins under \`local/plugins/\`.

## Start

Node 22 or newer. There is nothing to install.

\`\`\`sh
node scripts/setup.mjs                  # creates the owner: asks for a name and a password
LOCAL_PREVIEW=1 PORT=8799 node server/index.mjs
\`\`\`

Open http://127.0.0.1:8799 and sign in. (Started it first? The page says "finish setup" until the owner exists;
\`node scripts/setup.mjs --generate\` writes a password to \`private/ACCESS.txt\` instead of asking.) An empty hub tells
you what to add where. To serve it on your network, put it behind a reverse proxy with TLS and set
\`ORIGIN=https://hub.example.lan\` (or \`publicOrigin\` in \`local/site.json\`) instead of \`LOCAL_PREVIEW=1\`.

## Make it yours

\`\`\`sh
mkdir -p local && cp config/site.example.json local/site.json
\`\`\`

Edit the name, your network, and your machines, then restart. \`docs/plugins.md\` explains every field, how the
collectors use it, and how to write a plugin.

| Read | For |
|---|---|
| \`docs/plugins.md\` | Site configuration, the plugin contract, the public export |
| \`docs/API.md\` | The HTTP API |
| \`docs/review.md\`, \`docs/storage.md\` | Review sets and uploads; where state lives |
| \`SPEC.md\`, \`AGENTS.md\` | What it is and the rules for changing it |

## Optional companions

- **Thermo** (a macOS menu-bar app) feeds live CPU, GPU, power, temperature and memory to the overview. Without
  it the tiles show the static facts from your configuration.
- **A UniFi gateway** feeds the client census (\`scripts/collect-router-unifi.py\`).

## Checks

\`\`\`sh
npm test
\`\`\`
`;

// → {files: n} or throws Error with .findings when the scan refuses.
export function exportPublic(outDir,{root=repoRoot,force=false,log=()=>{}}={}){
 const out=path.resolve(outDir);
 if(out===root||root.startsWith(out+path.sep)||out.startsWith(root+path.sep))throw new Error('The output directory must be outside the repository.');
 if(existsSync(out)&&readdirSync(out).length&&!force)throw new Error(`${out} is not empty. Pass --force to write into it.`);
 const files=exportFiles(root);
 let commit=null;try{commit=execFileSync('git',['-C',root,'rev-parse','--short','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch{}
 const source=path.join(root,'README.md');
 const readme=publicReadme({source:existsSync(source)?readFileSync(source,'utf8'):null});
 const findings=[...scanLeaks(root,files),...scanText('README.md',readme)];
 if(findings.length)throw Object.assign(new Error(`Refusing to export: ${findings.length} household detail(s) in public files.\n${formatFindings(findings)}`),{findings});
 for(const file of files){
  const from=path.join(root,file),to=path.join(out,file);
  mkdirSync(path.dirname(to),{recursive:true});copyFileSync(from,to);chmodSync(to,statSync(from).mode&0o777);
 }
 writeFileSync(path.join(out,'edition.json'),'{"edition":"public"}\n');
 writeFileSync(path.join(out,'README.md'),readme);
 // The overlay, state and secrets of whoever runs the public tree stay out of their repository too.
 writeFileSync(path.join(out,'.gitignore'),['data/','private/','state/','router-private/','local/','*.pem','*.key','!tests/fixtures/tls-*.key','node_modules/','.DS_Store','__pycache__/',''].join('\n'));
 log(`${files.length} files → ${out}`);
 return {files:files.length+3,out,commit}; // + edition.json, README.md, .gitignore
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),force=args.includes('--force'),target=args.find(a=>!a.startsWith('--'));
 if(!target){console.error('Usage: node scripts/export-public.mjs <outDir> [--force]');process.exit(2);}
 try{const r=exportPublic(target,{force,log:console.log});console.log(`Public edition written (${r.files} files${r.commit?`, from ${r.commit}`:''}). Nothing was pushed.`);}
 catch(e){console.error(e.message);process.exit(1);}
}
