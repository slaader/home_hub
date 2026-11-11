// Stand-ins for ssh, ssh-keygen, ssh-keyscan and rsync, for the backup tests (tests/backups*.test.mjs).
// No network: a "remote" command runs here under /bin/sh, so the scripts the runner sends are executed for real,
// on directories in the test's temp dir. What each host does is read from the JSON file named by HHB_FAKE:
//   {hostKeys: {"<host>": "ssh-ed25519 AAAA…"}, refuse: {"<host>": "<ssh error text>"}, rsyncExit: 23,
//    rsyncDelayMs: 2000, rsyncStderr: "<what rsync prints on stderr>", slowRmMs: 1500 (rm on the "remote" sleeps first),
//    calls: "<file to append each call to>"}
// ssh checks what the real one would: the job's ssh_config forces strict host key checking, and its known_hosts
// must hold the host's current key under the alias.
import {readFileSync,writeFileSync,appendFileSync,existsSync,mkdirSync,readdirSync,statSync,copyFileSync,linkSync,rmSync,utimesSync,lstatSync,chmodSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const conf=()=>{try{return JSON.parse(readFileSync(process.env.HHB_FAKE,'utf8'));}catch{return {};}};
const note=(c,tool,args)=>{if(c.calls)appendFileSync(c.calls,JSON.stringify({tool,args})+'\n');};
function sshConfig(file){
 const hosts={},global={};let cur=global;
 for(const raw of readFileSync(file,'utf8').split('\n')){
  const line=raw.trim();if(!line||line.startsWith('#'))continue;
  const [k,...rest]=line.split(/\s+/);const v=rest.join(' ').replace(/^"|"$/g,'');
  if(k==='Host'){cur=v==='*'?global:(hosts[v]={});continue;}
  cur[k]=v;
 }
 return {hosts,global};
}
// The host an alias stands for, after the checks a real ssh makes. Exits like ssh does on a failure.
function connect(c,cfgFile,alias){
 const {hosts,global}=sshConfig(cfgFile),h=hosts[alias];
 if(!h){process.stderr.write(`ssh: Could not resolve hostname ${alias}: nodename nor servname provided\n`);process.exit(255);}
 if(global.StrictHostKeyChecking!=='yes'||global.BatchMode!=='yes'||global.IdentitiesOnly!=='yes'){process.stderr.write('fake ssh: the config must force strict host keys, batch mode and the job key\n');process.exit(254);}
 if(!existsSync(global.IdentityFile)){process.stderr.write('Permission denied (publickey).\n');process.exit(255);}
 if(c.refuse?.[h.HostName]){process.stderr.write(c.refuse[h.HostName]+'\n');process.exit(255);}
 const want=c.hostKeys?.[h.HostName];
 const known=existsSync(global.UserKnownHostsFile)?readFileSync(global.UserKnownHostsFile,'utf8').split('\n').filter(l=>l.startsWith(alias+' ')).map(l=>l.slice(alias.length+1)):[];
 if(!known.length){process.stderr.write(`No ED25519 host key is known for ${alias} and you have requested strict checking.\nHost key verification failed.\n`);process.exit(255);}
 if(!known.includes(want)){process.stderr.write('@@@@@@@@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\nHost key verification failed.\n');process.exit(255);}
 return h;
}
const sleep=ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);

function ssh(args,c){
 let cfg=null,i=0;
 for(;i<args.length;i++){const a=args[i];if(a==='-F'){cfg=args[++i];continue;}if(a==='-o'||a==='-p'||a==='-i'||a==='-l'){i++;continue;}if(a.startsWith('-'))continue;break;}
 const alias=args[i],command=args.slice(i+1).join(' ');
 connect(c,cfg,alias);
 let env=process.env,dir=null;
 if(c.slowRmMs){dir=path.join(os.tmpdir(),`hhb-slow-rm-${process.pid}`);mkdirSync(dir,{recursive:true});writeFileSync(path.join(dir,'rm'),`#!/bin/sh\nsleep ${c.slowRmMs/1000}\nexec /bin/rm "$@"\n`,{mode:0o755});env={...env,PATH:`${dir}:${env.PATH}`};}
 const r=spawnSync('/bin/sh',['-c',command],{stdio:'inherit',env});
 if(dir)rmSync(dir,{recursive:true,force:true});
 process.exit(r.status??1);
}
function keygen(args){
 const file=args[args.indexOf('-f')+1],comment=args[args.indexOf('-C')+1]||'';
 writeFileSync(file,'-----BEGIN OPENSSH PRIVATE KEY-----\nZmFrZS1wcml2YXRlLWtleS1mb3ItdGVzdHMtb25seQ==\n-----END OPENSSH PRIVATE KEY-----\n',{mode:0o600});
 writeFileSync(file+'.pub',`ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakePublicKeyForTestsOnly0123456789abcdefABCD ${comment}\n`,{mode:0o644});
}
function keyscan(args,c){
 const host=args.at(-1),key=c.hostKeys?.[host];
 if(!key||c.refuse?.[host])process.exit(1);
 const port=args[args.indexOf('-p')+1];
 process.stdout.write(`# ${host}:${port} SSH-2.0-Fake\n${port==='22'?host:`[${host}]:${port}`} ${key}\n`);
}

// ---- rsync: copy, --delete, --exclude, --link-dest, --stats ----
// rsync's wildcards: * ? and [classes]; a backslash makes the next character literal.
function glob(p){
 let re='';
 for(let i=0;i<p.length;i++){const ch=p[i];
  if(ch==='\\'&&i+1<p.length){re+=p[++i].replace(/[.*+?^${}()|[\]\\/]/g,'\\$&');continue;}
  if(ch==='*'){re+='[^/]*';continue;}if(ch==='?'){re+='[^/]';continue;}
  if(ch==='['){const end=p.indexOf(']',i+1);if(end>i){re+='['+p.slice(i+1,end).replace(/\\/g,'\\\\')+']';i=end;continue;}}
  re+=ch.replace(/[.*+?^${}()|[\]\\/]/g,'\\$&');}
 return new RegExp('^'+re+'$');
}
function excluded(rel,isDir,patterns){
 const base=path.posix.basename(rel);
 return patterns.some(p=>{let dirOnly=p.endsWith('/'),x=dirOnly?p.slice(0,-1):p;if(dirOnly&&!isDir)return false;
  if(x.startsWith('/'))return glob(x.slice(1)).test(rel)||rel.startsWith(x.slice(1)+'/');return glob(x).test(base);});
}
function rsync(args,c){
 const opts={exclude:[],delete:false,linkDest:null,e:null},pos=[];
 for(let i=0;i<args.length;i++){const a=args[i];
  if(a==='-e'){opts.e=args[++i];continue;}
  if(a.startsWith('--exclude='))opts.exclude.push(a.slice(10));else if(a==='--delete')opts.delete=true;else if(a.startsWith('--link-dest='))opts.linkDest=a.slice(12);
  else if(!a.startsWith('-'))pos.push(a);}
 let [src,dst]=pos;
 // A remote side ("alias:/path") is connected to like ssh would, then is a local path here.
 for(const side of [src,dst]){const m=/^(hh-[a-z0-9-]+):/.exec(side);if(m){const cfg=opts.e.split(' ')[2];connect(c,cfg,m[1]);}}
 src=src.replace(/^hh-[a-z0-9-]+:/,'');dst=dst.replace(/^hh-[a-z0-9-]+:/,'');
 if(c.rsyncDelayMs)sleep(c.rsyncDelayMs);
 if(!existsSync(src.replace(/\/$/,''))){process.stderr.write(`rsync: link_stat "${src}" failed: No such file or directory (2)\n`);process.exit(23);}
 const stats={files:0,transferred:0,size:0,tsize:0};
 const contents=src.endsWith('/');const root=src.replace(/\/$/,'');
 mkdirSync(dst,{recursive:true});
 const copy=(from,to,rel)=>{
  const st=statSync(from);stats.files++;
  if(st.isDirectory()){mkdirSync(to,{recursive:true});const names=new Set();
   for(const n of readdirSync(from)){const r=rel?`${rel}/${n}`:n,isDir=lstatSync(path.join(from,n)).isDirectory();if(excluded(r,isDir,opts.exclude))continue;names.add(n);copy(path.join(from,n),path.join(to,n),r);}
   if(opts.delete)for(const n of readdirSync(to))if(!names.has(n))rmSync(path.join(to,n),{recursive:true,force:true});
   return;}
  stats.size+=st.size;
  const prev=opts.linkDest&&path.join(opts.linkDest,rel);
  if(existsSync(to)){const t=statSync(to);if(t.size===st.size&&Math.floor(t.mtimeMs/1000)===Math.floor(st.mtimeMs/1000))return;rmSync(to);}
  if(prev&&existsSync(prev)){const p=statSync(prev);if(p.size===st.size&&Math.floor(p.mtimeMs/1000)===Math.floor(st.mtimeMs/1000)){linkSync(prev,to);return;}}
  copyFileSync(from,to);utimesSync(to,st.atime,st.mtime);chmodSync(to,st.mode&0o777);stats.transferred++;stats.tsize+=st.size;
 };
 if(contents)copy(root,dst.replace(/\/$/,''),'');else copy(root,path.join(dst,path.basename(root)),path.basename(root));
 process.stdout.write(`Number of files: ${stats.files}\nNumber of files transferred: ${stats.transferred}\nTotal file size: ${stats.size} B\nTotal transferred file size: ${stats.tsize} B\nTotal sent: ${stats.tsize+100} B\nTotal received: 40 B\n\nsent ${stats.tsize+100} bytes  received 40 bytes\n`);
 if(c.rsyncExit){process.stderr.write(c.rsyncStderr??`rsync: some files could not be transferred (code ${c.rsyncExit})\n`);process.exit(c.rsyncExit);}
}

export function main(tool){
 const args=process.argv.slice(2),c=conf();note(c,tool,args);
 if(tool==='ssh')return ssh(args,c);
 if(tool==='ssh-keygen')return keygen(args);
 if(tool==='ssh-keyscan')return keyscan(args,c);
 if(tool==='rsync')return rsync(args,c);
}
