#!/usr/bin/env node
// First run: create the owner account of this Home Hub.
//
//   node scripts/setup.mjs                         asks for a user name and a password (typed twice, not shown)
//   node scripts/setup.mjs --generate              makes a password and writes it to private/ACCESS.txt (0600)
//   node scripts/setup.mjs --username alex --password-file /path/to/file
//   printf '%s' "$PW" | node scripts/setup.mjs --username alex --password-stdin
//
// Options: --username NAME (default admin)   --name "Shown name"   --auth-file PATH (default private/auth.json,
// or AUTH_FILE)   --url URL (what to print as the address)   --force (replace an existing owner: a lost password)
// A password is never taken from the command line (it would show in the process list) and never printed.
//
// It writes {username, salt, hash, createdAt, passwordAt} with an scrypt hash, mode 0600, in a 0700
// directory. A hub that is already running without an owner picks the file up: reload the page.
import {mkdir,writeFile,rename,readFile,chmod} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {hashPassword} from '../server/auth.mjs';
import {validCredentials} from '../server/access-store.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const USERNAME=/^[a-z][a-z0-9._-]{2,39}$/;
export const defaultAuthFile=(env=process.env)=>env.AUTH_FILE?path.resolve(env.AUTH_FILE):path.join(root,'private','auth.json');
export const passwordProblem=p=>typeof p!=='string'||p.length<12?'The password needs at least 12 characters.':p.length>256?'The password may have at most 256 characters.':/[\u0000-\u001f\u007f]/.test(p)?'The password must not contain control characters.':null;

/**
 * Writes the owner's auth file. Refuses when one already exists (unless force) so a second run can never
 * lock the owner out by accident. Returns {authFile, username, replaced}.
 */
export async function createOwner({authFile=defaultAuthFile(),username='admin',name,password,force=false,now=Date.now}={}){
 if(typeof username!=='string'||!USERNAME.test(username))throw new Error('The user name needs 3–40 characters: lowercase letters, digits, dot, underscore or hyphen, starting with a letter.');
 if(name!==undefined&&(typeof name!=='string'||!name.trim()||name.length>80||/[\u0000-\u001f\u007f]/.test(name)))throw new Error('The shown name needs 1–80 characters.');
 const problem=passwordProblem(password);if(problem)throw new Error(problem);
 const exists=existsSync(authFile);
 if(exists&&!force)throw new Error(`${authFile} already exists: this hub has an owner. Sign in, or use --force to replace the owner's password.`);
 // Other fields someone added to the file survive a --force; the previous password stamp is moved on so old sessions end.
 let previous={};if(exists)try{previous=JSON.parse(await readFile(authFile,'utf8'));}catch{}
 const at=new Date(Math.max(now(),(Date.parse(previous?.passwordAt||'')||0)+1)).toISOString();
 const record={...(previous&&typeof previous==='object'&&!Array.isArray(previous)?previous:{}),username,...(name?{name:name.trim()}:{}),...hashPassword(password),createdAt:typeof previous?.createdAt==='string'?previous.createdAt:at,passwordAt:at};
 if(!validCredentials(record))throw new Error('Could not build a valid auth record.');
 await mkdir(path.dirname(authFile),{recursive:true,mode:0o700});
 const temp=`${authFile}.${randomBytes(4).toString('hex')}.tmp`;
 await writeFile(temp,JSON.stringify(record),{mode:0o600,flag:'wx'});await chmod(temp,0o600);await rename(temp,authFile);
 return {authFile,username,replaced:exists};
}

// Where the owner will open the hub, by the server's own rule: --url, ORIGIN, the local preview address
// when LOCAL_PREVIEW=1, the site's publicOrigin; with none of them, the local preview address.
export async function hubUrl({url,env=process.env}={}){
 const local=`http://127.0.0.1:${env.PORT||8781}`;
 if(url||env.ORIGIN)return url||env.ORIGIN;
 if(env.LOCAL_PREVIEW==='1')return local;
 let origin=null;try{origin=(await import('../server/site-config.mjs')).site().publicOrigin||null;}catch{}
 return origin||local;
}

const flag=(args,name)=>args.includes(`--${name}`);
const option=(args,name)=>{const i=args.indexOf(`--${name}`);return i<0?undefined:args[i+1];};
const KNOWN=['username','name','auth-file','url','password-file','password-stdin','generate','force','help'];
// One line from the terminal. hidden: nothing is echoed (a password).
function ask(prompt,{hidden=false}={}){
 return new Promise((resolve,reject)=>{
  const {stdin,stdout}=process;stdout.write(prompt);
  if(!hidden){stdin.setEncoding('utf8');stdin.resume();stdin.once('data',d=>{stdin.pause();resolve(String(d).replace(/\r?\n$/,''));});return;}
  let value='';stdin.setRawMode(true);stdin.setEncoding('utf8');stdin.resume();
  const done=fn=>{stdin.setRawMode(false);stdin.pause();stdin.off('data',onData);stdout.write('\n');fn();};
  const onData=chunk=>{for(const ch of String(chunk)){
   if(ch==='\r'||ch==='\n'||ch==='\u0004')return done(()=>resolve(value));
   if(ch==='\u0003')return done(()=>reject(new Error('Cancelled.')));
   if(ch==='\u007f'||ch==='\b')value=value.slice(0,-1);else if(ch>=' ')value+=ch;}};
  stdin.on('data',onData);
 });
}
const readAll=async stream=>{let s='';stream.setEncoding('utf8');for await(const chunk of stream)s+=chunk;return s;};
const firstLine=s=>s.replace(/\r?\n[\s\S]*$/,'');

async function main(args){
 const unknown=args.filter(a=>a.startsWith('--')&&!KNOWN.includes(a.slice(2)));
 if(flag(args,'help')||unknown.length){
  console.log(`${unknown.length?`Unknown option: ${unknown.join(', ')}\n\n`:''}Create the owner account of this Home Hub.\n\n  node scripts/setup.mjs                      ask for a user name and a password\n  node scripts/setup.mjs --generate           make a password, written to private/ACCESS.txt\n  node scripts/setup.mjs --username NAME --password-file FILE\n  node scripts/setup.mjs --username NAME --password-stdin\n\nOptions: --name "Shown name"  --auth-file PATH  --url URL  --force (replace an existing owner's password)`);
  return unknown.length?2:0;
 }
 const authFile=option(args,'auth-file')?path.resolve(option(args,'auth-file')):defaultAuthFile(),force=flag(args,'force');
 if(existsSync(authFile)&&!force){console.error(`This hub already has an owner (${authFile}). Sign in at ${await hubUrl({url:option(args,'url')})}.\nLost the password? Run this again with --force to set a new one.`);return 1;}
 const interactive=process.stdin.isTTY&&!flag(args,'generate')&&!option(args,'password-file')&&!flag(args,'password-stdin');
 let username=option(args,'username'),password,accessFile=null;
 if(interactive){
  console.log('Home Hub · first run\nThis creates the owner: the one account that can never be deleted or locked out by another.\n');
  while(!username||!USERNAME.test(username)){username=(await ask('User name [admin]: ')).trim()||'admin';if(!USERNAME.test(username))console.log('  3–40 characters: lowercase letters, digits, dot, underscore or hyphen, starting with a letter.');}
  for(;;){
   password=await ask('Password (at least 12 characters, not shown): ',{hidden:true});
   const problem=passwordProblem(password);if(problem){console.log(`  ${problem}`);continue;}
   if(await ask('Password again: ',{hidden:true})===password)break;
   console.log('  The two passwords differ. Try again.');
  }
 }else if(flag(args,'generate')){
  password=randomBytes(24).toString('base64url');accessFile=path.join(path.dirname(authFile),'ACCESS.txt');
 }else if(option(args,'password-file'))password=firstLine(await readFile(path.resolve(option(args,'password-file')),'utf8'));
 else if(flag(args,'password-stdin'))password=firstLine(await readAll(process.stdin));
 else{console.error('No terminal to ask on. Use --generate, --password-file FILE or --password-stdin.');return 2;}
 const done=await createOwner({authFile,username:username||'admin',name:option(args,'name'),password,force});
 const url=await hubUrl({url:option(args,'url')});
 if(accessFile){
  await writeFile(accessFile,`Home Hub\nURL: ${url}\nUsername: ${done.username}\nPassword: ${password}\n\nKeep this file private. Change the password after the first sign-in (Settings), then delete this file.\n`,{mode:0o600});
  await chmod(accessFile,0o600);
 }
 console.log(`${done.replaced?'Owner password replaced':'Owner created'}: ${done.username}\nAuth file:  ${done.authFile} (scrypt hash, mode 0600)${accessFile?`\nPassword:   in ${accessFile} (mode 0600), not printed`:''}\n\nOpen ${url} and sign in.`);
 if(!process.env.ORIGIN&&/^http:\/\/127\.0\.0\.1:/.test(url))console.log(`Not running yet? Start it with:  LOCAL_PREVIEW=1 PORT=${new URL(url).port} node server/index.mjs`);
 return 0;
}
if(process.argv[1]===fileURLToPath(import.meta.url))main(process.argv.slice(2)).then(code=>process.exit(code),e=>{console.error(e.message);process.exit(1);});
