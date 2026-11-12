// The version of this Home Hub, read once at start-up. AGENTS.md → Versioning says what the number promises.
//   package.json → version               the semver; scripts/release.mjs is the only thing that changes it
//   package.json → homeHub.dataEpoch     an integer that rises whenever a persisted format changes
//   package.json → homeHub.updates.repo  where releases are published (the update check reads it; a fork edits this line)
// readVersion() → {version, dataEpoch, commit, exact, label, updates: {repo}}
//   commit  the short id of the checked-out commit, or null outside a git checkout (an archive, a container image)
//   exact   true: HEAD is the commit of tag v<version>, so this is that release.
//           false: a git checkout that is not on its tag: a development build, shown as "1.2.0+dev (4172c37)".
//           null: no git checkout, so it cannot be told; the number stands as written.
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {repoRoot} from './edition.mjs';
import {readBuild,headCommit,tagCommit} from './build-info.mjs';

export const SEMVER=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
// owner/name on a git host: the only shape a release repository takes (GitHub's own limits).
export const REPO_SLUG=/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9._-]{1,100}$/;
export const validRepo=v=>typeof v==='string'&&REPO_SLUG.test(v)&&!v.endsWith('.git')&&!/\/\.{1,2}$/.test(v);
export const versionLabel=({version,exact,commit})=>exact===false?`${version}+dev${commit?` (${commit})`:''}`:version;

/** package.json as the version module reads it. A missing or broken file is a start-up error, never a guess. */
export function readPackage(root=repoRoot){
 const file=path.join(root,'package.json');
 let raw;try{raw=JSON.parse(readFileSync(file,'utf8'));}catch(e){throw new Error(`version: cannot read ${file}: ${e.message}`);}
 if(typeof raw.version!=='string'||!SEMVER.test(raw.version))throw new Error(`version: package.json → version must be a semver such as 1.2.0 (got ${JSON.stringify(raw.version)})`);
 const own=raw.homeHub&&typeof raw.homeHub==='object'&&!Array.isArray(raw.homeHub)?raw.homeHub:{};
 const dataEpoch=own.dataEpoch??1;
 if(!Number.isSafeInteger(dataEpoch)||dataEpoch<1)throw new Error('version: package.json → homeHub.dataEpoch must be a positive integer');
 const repo=own.updates?.repo??null;
 if(repo!==null&&!validRepo(repo))throw new Error('version: package.json → homeHub.updates.repo must be "owner/name"');
 return {version:raw.version,dataEpoch,updates:{repo}};
}
export function readVersion(root=repoRoot){
 const pkg=readPackage(root),build=readBuild(root),head=headCommit(root);
 const exact=head?tagCommit(root,`v${pkg.version}`)===head:null;
 const commit=build?.commit??null;
 return Object.freeze({version:pkg.version,dataEpoch:pkg.dataEpoch,commit,exact,label:versionLabel({version:pkg.version,exact,commit}),updates:Object.freeze({...pkg.updates})});
}
