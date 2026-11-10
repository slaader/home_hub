// Inventory map ↔ Systémy: which watched-software rows describe an inventory entry.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {versionRows,machineOs,versionSummary,systemMachineOf} from '../public/inventory-versions.js';
import {buildSystems,parseSystemsProbe} from '../server/systems-data.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const row=(id,machine,extra={})=>({id,name:extra.name||id,machine,installed:'1.0',status:'current',latest:'1.0',inventory:[],...extra});
const systems={software:[
 row('llama-swap','studio',{installed:'268',status:'update',latest:'271',latestUrl:'https://github.com/mostlygeek/llama-swap/releases'}),
 row('llama-swap','mini',{installed:'199',status:'update',latest:'271'}),
 row('omlx','studio',{name:'oMLX'}),
 row('thermo','mini_server',{name:'Thermo'}),
 row('claude-code','studio',{name:'Claude Code'}),
 row('codex','studio',{name:'Codex CLI'}),
 row('caddy','mini',{name:'Caddy (HTTPS ingress)',inventory:['home-ingress']}),
 row('node','studio',{name:'Node.js',inventory:['studio-toolchain']}),
 row('uv','studio',{inventory:['studio-toolchain']}),
 row('homebrew','studio',{name:'Homebrew',inventory:['studio-toolchain']}),
 row('mlx-audio','mini',{name:'mlx-audio (voice)',inventory:['voice-stt']}),
 row('app:immich','nas',{status:'update',latest:'v3.3.6'}),
 row('docker:local-ai-searxng','mini',{status:'floating',latest:null})],
 machines:[{id:'nas',os:{name:'TrueNAS',version:'25.10.7',status:'update',updates:[{version:'25.10.8',kind:'minor'}]}},{id:'studio',os:{name:'macOS',version:'27.2',status:'current',updates:[]}}]};
const ids=(entry,doc=systems)=>versionRows(entry,doc).map(r=>`${r.machine}/${r.id}`);

test('heuristic: id without machine words or name without "(Studio)" matches on the same machine only',()=>{
 assert.deepEqual(ids({id:'studio-llama-swap',kind:'runtime',machine:'studio',name:'llama-swap (Studio)'}),['studio/llama-swap']);
 assert.deepEqual(ids({id:'mini-llama-swap',kind:'runtime',machine:'mini',name:'llama-swap (mini)'}),['mini/llama-swap']);
 assert.deepEqual(ids({id:'studio-omlx',kind:'runtime',machine:'studio',name:'oMLX (Studio)'}),['studio/omlx']);
 assert.deepEqual(ids({id:'mini-server-thermo',kind:'runtime',machine:'mini-server',name:'Thermo · mini_server'}),['mini_server/thermo'],'mini-server → mini_server');
 assert.deepEqual(ids({id:'claude-code-studio',kind:'tool',machine:'studio',name:'Claude Code (Studio)'}),['studio/claude-code']);
 assert.deepEqual(ids({id:'codex-studio',kind:'tool',machine:'studio',name:'Codex (Studio)'}),['studio/codex']);
 assert.deepEqual(ids({id:'immich',kind:'runtime',machine:'nas',name:'Immich'}),['nas/app:immich'],'NAS apps by name');
 assert.deepEqual(ids({id:'searxng',kind:'runtime',machine:'mini',name:'SearXNG'}),['mini/docker:local-ai-searxng'],'a container name ending in -<id>');
});
test('no false friends: other machine, partial words, other kinds',()=>{
 assert.deepEqual(ids({id:'mlx-audio',kind:'tool',machine:'studio',name:'mlx-audio (Studio)'}),[],'mlx-audio is watched on the mini only');
 assert.deepEqual(ids({id:'llama-swap-monitor',kind:'tool',machine:'studio',name:'llama-swap monitor'}),[]);
 assert.deepEqual(ids({id:'codex-ob1-env',kind:'tool',machine:'studio',name:'Codex OB1 env export'}),[]);
 assert.deepEqual(ids({id:'immich',kind:'runtime',machine:'mini',name:'Immich'}),[]);
 assert.deepEqual(ids({id:'ollama',kind:'runtime',machine:'work-macbook',name:'x'}),[],'machines Systémy does not watch');
 assert.deepEqual(ids({id:'studio',kind:'machine',name:'studio · Mac Studio'}),[],'machines get their OS instead');
});
test('explicit registry links win over the heuristic and may name several rows',()=>{
 assert.deepEqual(ids({id:'studio-toolchain',kind:'tool',machine:'studio',name:'Homebrew, uv, Node, hf (Studio)'}),['studio/node','studio/uv','studio/homebrew']);
 assert.deepEqual(ids({id:'home-ingress',kind:'runtime',machine:'mini',name:'Home HTTPS ingress'}),['mini/caddy']);
 assert.deepEqual(ids({id:'voice-stt',kind:'runtime',machine:'mini',name:'voice-stt'}),['mini/mlx-audio']);
 assert.deepEqual(ids({id:'home-ingress',kind:'runtime',machine:'studio',name:'Home HTTPS ingress'}),[],'the link is per machine');
});
test('without the systems payload (not an admin, 403, not collected) there is nothing to show',()=>{
 const e={id:'studio-llama-swap',kind:'runtime',machine:'studio',name:'llama-swap'};
 for(const doc of [null,undefined,{},{software:null},{software:[]}])assert.deepEqual(versionRows(e,doc),[]);
 assert.equal(machineOs({id:'nas',kind:'machine'},null),null);
 assert.equal(systemMachineOf({kind:'runtime',machine:'mini-server'}),'mini_server');
});
test('machines: OS version and the pending update',()=>{
 assert.deepEqual(machineOs({id:'nas',kind:'machine'},systems),{name:'TrueNAS',installed:'25.10.7',status:'update',latest:'25.10.8',machine:'nas',stale:false});
 assert.equal(machineOs({id:'studio',kind:'machine'},systems).latest,null);
 assert.equal(machineOs({id:'studio-omlx',kind:'runtime',machine:'studio'},systems),null);
});
test('summary follows the versions page: update shown, stale upstream flagged neověřeno',()=>{
 assert.deepEqual(versionSummary(row('x','mini',{installed:'1.0',status:'update',latest:'1.2'})),{installed:'1.0',status:'update',update:'1.2',unverified:false,note:null});
 const stale=versionSummary(row('x','mini',{status:'update',latest:'1.2',upstreamStale:true,note:'Kontrola selhala.'}));
 assert.equal(stale.update,'1.2','a stale check still proves a newer release');assert.equal(stale.unverified,true);
 const unknown=versionSummary(row('x','mini',{status:'unknown',latest:'1.0',upstreamStale:true}));
 assert.equal(unknown.update,null,'stale "current" is unknown, not current');assert.equal(unknown.unverified,true);
 assert.equal(versionSummary(row('x','mini',{status:'current'})).update,null);
});

test('shipped registry: inventory links are lists of ids and reach the /api/systems rows',async()=>{
 const registry=JSON.parse(await readFile(path.join(root,'config','software-watch.json'),'utf8'));
 const links=[];
 for(const item of registry.items)for(const [machine,det] of Object.entries(item.detect))if(det.inventory!==undefined){
  assert.ok(Array.isArray(det.inventory)&&det.inventory.length&&det.inventory.every(x=>typeof x==='string'&&/^[a-z0-9][a-z0-9-]*$/.test(x)),`${item.id}@${machine}`);
  links.push({item:item.id,machine,ids:det.inventory});}
 assert.ok(links.length>=1);
 const host={...parseSystemsProbe('HOST\tmini_server\tDarwin\tu\t0\t2026-11-08T00:00:00Z\nEND\tok'),software:{'llama.cpp':[{kind:'cmd',value:'version: 1.0.0 (build 1)',detail:'/x/llama-server'}]}};
 const doc=buildSystems({snapshot:{machines:{mini_server:host}},upstream:null,registry});
 assert.deepEqual(doc.software.find(r=>r.id==='llama.cpp'&&r.machine==='mini_server').inventory,['llama-server']);
 assert.deepEqual(doc.software.find(r=>r.id==='uv'&&r.machine==='mini')?.inventory??[],[]);
});