// Shared by the Git LFS tests: a hub on a clock the test moves, the demo repository, a provider that can delete.
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {hub} from '../hub-helper.mjs';
import {workTree,oid,pointer} from './git-host.mjs';
import {BUILTIN_PROVIDERS,apiRequest} from '../../server/git-lfs-providers.mjs';

export const H=3600000,PAST=7*24*H+H;// one hour past the default grace period (7 days)
export const A=oid('a'),B=oid('b'),C=oid('c'),D=oid('d'),E=oid('e'),F=oid('f'),G=oid('1'),X=oid('9');
export const get=async(h,url,headers=h.admin)=>{const r=await fetch(h.origin+url,{headers});return {status:r.status,body:await r.json()};};
export const send=async(h,url,body,headers=h.admin)=>{const r=await h.post(url,body,headers);return {status:r.status,body:await r.json()};};
export const clockAt=start=>{const c={now:start,advance:ms=>{c.now+=ms;}};return c;};
// A hub on a clock the test moves, with its Git LFS token file in a temp dir of its own.
export async function setup(t,opts={}){
 const clock=opts.clock||clockAt(Date.parse('2026-11-11T08:00:00Z'));
 const tokens=mkdtempSync(path.join(os.tmpdir(),'hub-lfs-tokens-'));t.after(()=>rmSync(tokens,{recursive:true,force:true}));
 const tokenFile=path.join(tokens,'private','git-lfs-tokens.json');
 const h=await hub(t,{plugins:opts.plugins||[],gitLfsNow:()=>clock.now,gitLfsTokenFile:tokenFile,...(opts.extra||{})});
 return {...h,clock,tokenFile,store:h.handler.hub.state('git-lfs').store};
}
// The demo repository: two files on main (one of them changed once), a feature branch with its own file, a
// tag, a pointer stored under two names, a large non-LFS file the mirror must not fetch.
export function demoRepo(host,fullName='alice/media'){
 host.addRepo(fullName);
 const w=workTree(host,fullName);
 const first=w.commit({'art/logo.png':pointer(A,1000),'video/intro.mp4':pointer(B,5000),'big.dat':'x'.repeat(6000),'README.md':'hello'},'first');
 w.git('tag','v1');
 const second=w.commit({'video/intro.mp4':pointer(C,7000),'art/logo-copy.png':pointer(A,1000)},'second');
 w.git('checkout','-q','-b','feature');const third=w.commit({'design/poster.psd':pointer(D,3000)},'third');w.git('checkout','-q','main');
 w.git('push','-q','origin','--all');w.git('push','-q','origin','--tags');
 for(const [o,size] of [[A,1000],[B,5000],[C,7000],[D,3000]])host.storeObject(fullName,o,size);
 return {w,first,second,third};
}
// A provider that can list and delete, as a plugin would add one. No real host has such an API; the fake host does.
export function deletingProvider({onDelete}={}){
 const base=BUILTIN_PROVIDERS.find(p=>p.id==='gitea');
 return {...base,id:'fakehost',title:'Fake host',kind:'plugin',
  capabilities:{...base.capabilities,listObjects:true,deleteObjects:true},
  token:{...base.token,note:null},
  async listObjects(ctx,repo){const {data}=await apiRequest(ctx,'GET',`${ctx.web}/api/fake/repos/${repo.owner}/${repo.name}/lfs`);return data.map(o=>({oid:o.oid,size:o.size,createdAt:o.created_at}));},
  async deleteObject(ctx,repo,o){await apiRequest(ctx,'DELETE',`${ctx.web}/api/fake/repos/${repo.owner}/${repo.name}/lfs/${o}`);await onDelete?.(repo,o);},
  manual:()=>({text:'x',url:null})};
}
export const plugin=(opts,extra=[])=>({id:'fake-lfs',title:'Fake LFS host',provides:{'git-lfs.providers':()=>[deletingProvider(opts),...extra]}});

