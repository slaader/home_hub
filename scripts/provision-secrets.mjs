// Unattended first-run provisioning: when private/auth.json is missing, create the owner "admin" with a
// generated password and write it to private/ACCESS.txt (0600). An existing auth file is left alone.
// The password is never logged. For a password you choose yourself, use `node scripts/setup.mjs`.
import {mkdir,writeFile,access} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {createOwner} from './setup.mjs';
import {site} from '../server/site-config.mjs';
await mkdir('private',{recursive:true,mode:0o700});
try{await access('private/auth.json');console.info('Existing credentials retained.');process.exit(0);}catch{}
const password=randomBytes(24).toString('base64url');
await createOwner({authFile:'private/auth.json',username:'admin',password});
await writeFile('private/ACCESS.txt',`Home Hub\nURL: ${site().publicOrigin||process.env.ORIGIN||'(the origin you serve it at)'}\nUsername: admin\nPassword: ${password}\n\nKeep this file private. Do not send it or the private TLS key to anyone.\nCertificate trust instructions are in README.md.\n`,{mode:0o600,flag:'wx'});
console.info('Dedicated credentials created in private/ACCESS.txt; password not logged.');
