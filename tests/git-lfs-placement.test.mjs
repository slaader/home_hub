// Where a git host's LFS files live, from the inventory (server/git-lfs-placement.mjs): the service that answers at
// the host's address and the object store it reaches through its dependencies. Placeholder inventory only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {placementFor} from '../server/git-lfs-placement.mjs';

const E=[
 {id:'box',kind:'machine',name:'box · small server'},{id:'store',kind:'machine',name:'store · storage box'},{id:'nas',kind:'machine',name:'nas'},
 {id:'ingress',kind:'runtime',machine:'box',name:'HTTPS ingress',type:'Caddy reverse proxy',address:'https://git.example.lan, https://hub.example.lan on 10.0.0.5:443',depends_on:[{id:'forge',kind:'call'}]},
 {id:'forge',kind:'runtime',machine:'box',name:'Forgejo',type:'Git hosting',address:'https://git.example.lan (ingress); backend 127.0.0.1:3000',depends_on:[{id:'tunnel',kind:'call'},{id:'box',kind:'call'}]},
 {id:'tunnel',kind:'runtime',machine:'box',name:'S3 tunnel',type:'SSH local forwarding',depends_on:[{id:'s3',kind:'call'}]},
 {id:'s3',kind:'runtime',machine:'store',name:'LFS object store',type:'Private S3-compatible object store',address:'127.0.0.1:8333'},
 {id:'old',kind:'runtime',machine:'nas',name:'Gitea backup',type:'Read-only Git',address:'http://10.0.0.9:3001 (LAN only)'},
 {id:'proxy',kind:'runtime',machine:'nas',name:'nas proxy',type:'reverse proxy',address:'10.0.0.9 :80 :443'},
 {id:'client',kind:'tool',machine:'nas',name:'a tool that pushes',address:'https://git.example.lan/alice/repo'}];

test('the host\'s machine, and the machine of the object store behind it (through a tunnel)',()=>{
 assert.deepEqual(placementFor('https://git.example.lan',E),{service:{id:'forge',name:'Forgejo',machine:'box',machineName:'box · small server'},
  storage:{id:'s3',name:'LFS object store',machine:'store',machineName:'store · storage box'}},'the service itself, not the ingress in front of it');
});
test('the full address beats a proxy on the same IP; no store: null; unknown hosts and no inventory: null',()=>{
 assert.deepEqual(placementFor('http://10.0.0.9:3001',E),{service:{id:'old',name:'Gitea backup',machine:'nas',machineName:'nas'},storage:null});
 assert.equal(placementFor('https://github.com',E),null);
 assert.equal(placementFor('https://it.example.lan',E),null,'a host is matched as a whole name');
 assert.equal(placementFor('https://git.example.lan',null),null);assert.equal(placementFor('not a url',E),null);
 assert.equal(placementFor('https://git.example.lan',[{id:'only-tool',kind:'tool',address:'https://git.example.lan'}]),null,'a tool that talks to the host is not the host');
});
