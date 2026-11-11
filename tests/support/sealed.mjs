// A store file as the hub reads it: a sealed one (server/secret-box.mjs) opened with the run's throwaway key.
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {defaultSecretBox,isSealed} from '../../server/secret-box.mjs';
const PURPOSE={'thermo-hosts.json':'home/thermo-hosts','telemetry-hosts.json':'home/telemetry-hosts'};
export async function readStore(file){
 const raw=JSON.parse(await readFile(file,'utf8'));
 return isSealed(raw)?defaultSecretBox().open(raw,PURPOSE[path.basename(file)]):raw;
}
