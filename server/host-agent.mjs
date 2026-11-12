// What an installed host agent is: <its directory>/.agent-install.json, written by scripts/install-host-agent.mjs. An agent
// says it in its answers (`agent: {plugin, agent, version, core, commit}`), so the hub can tell when the copy on a machine
// is older than the plugin it has itself: the update check for host agents, derived locally with no network.
// No imports beyond node's: the plugin API re-exports installedAgent, and every agent copies this file.
import {readFileSync} from 'node:fs';
import path from 'node:path';

export const AGENT_MANIFEST='.agent-install.json';
const short=(v,n)=>typeof v==='string'&&v.length<=n&&!/[\u0000-\u001f]/.test(v)?v:null;
/** The identity of the agent installed in directory (default: HOME_HUB_HOME, which the installer sets), or null. */
export function installedAgent(directory=process.env.HOME_HUB_HOME){
 if(!directory)return null;
 let raw;try{raw=JSON.parse(readFileSync(path.join(directory,AGENT_MANIFEST),'utf8'));}catch{return null;}
 if(!raw||typeof raw!=='object'||raw.schema!==1)return null;
 const commit=short(raw.commits?.plugin,64);
 return {plugin:short(raw.plugin,32),agent:short(raw.agent,32),version:short(raw.version,40),core:short(raw.core,40),commit:commit?commit.slice(0,12):null};
}
