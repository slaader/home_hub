// Inventory map layout: every card gets a column (unknown machines and categories land in Ostatní) and the
// map size is always a finite number, so the SVG is never collapsed by a NaN viewBox.
import './support/site-inventory.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {columnGroups,mapExtent} from '../public/inventory-view.js';

const SP={COL:220,ROW:48,TOP:48};
const entries=[
 {id:'mini',kind:'machine',name:'Mac mini'},
 {id:'svc',kind:'runtime',name:'Service',machine:'mini'},
 {id:'router',kind:'network',name:'Router'},
 {id:'gh',kind:'external',name:'GitHub'},
 {id:'hue-bridge',kind:'machine',name:'Hue Bridge'},// a machine with no column of its own
 {id:'hue-app',kind:'runtime',name:'Hue app',machine:'hue-bridge'},
 {id:'pi',kind:'tool',name:'Pi tool',machine:'garage-pi'},// unknown machine id
 {id:'lost',kind:'runtime',name:'No machine'},// missing machine
 {id:'blank',kind:'tool',name:'Blank machine',machine:''},
 {id:'odd',kind:'gadget',name:'Unknown kind'}];
const where=gs=>Object.fromEntries(gs.flatMap(g=>g.cards.map(c=>[c.id,g.label])));
const once=(gs,list)=>{const ids=gs.flatMap(g=>g.cards.map(c=>c.id));assert.deepEqual([...ids].sort(),list.map(e=>e.id).sort(),'every card exactly once');};

test('machine columns: a card whose machine has no column still gets one, in Ostatní, last',()=>{
 const gs=columnGroups(entries,'machine'),w=where(gs);once(gs,entries);
 assert.equal(gs.at(-1).label,'Ostatní');
 for(const id of ['hue-bridge','hue-app','pi','lost','blank','odd'])assert.equal(w[id],'Ostatní',id);
 assert.equal(w.mini,'mini · M4');assert.equal(w.svc,'mini · M4');assert.equal(w.router,'Síť');assert.equal(w.gh,'Mimo dům');
 assert.equal(gs.at(-1).cards[0].id,'hue-bridge','the machine card leads its column, as elsewhere');
 assert.ok(!columnGroups(entries.slice(0,4),'machine').some(g=>g.label==='Ostatní'),'no empty Ostatní column');
});

test('category columns: an unknown category goes to Ostatní; every card once',()=>{
 const gs=columnGroups(entries,'category'),w=where(gs);once(gs,entries);
 assert.equal(w.odd,'Ostatní');assert.equal(w['hue-bridge'],'Hardware');assert.equal(w.pi,'Nástroje');
 assert.equal(gs.at(-1).label,'Ostatní');
 const store=[{id:'k',kind:'secret-store',name:'Store'},{id:'s1',kind:'secret-item',category:'secret',store:'gone',name:'Item'}];
 once(columnGroups(store,'category'),store);
});

test('the map size is finite whatever the positions are',()=>{
 assert.deepEqual(mapExtent([],0,SP),{width:0,height:96},'empty map');
 assert.deepEqual(mapExtent([{x:12,y:48},{x:232,y:96}],2,SP),{width:232+180+150,height:96+40+24});
 const bad=mapExtent([{x:NaN,y:NaN},{},undefined,{x:12,y:48}],NaN,SP);
 assert.ok(Number.isFinite(bad.width)&&Number.isFinite(bad.height),JSON.stringify(bad));
});

test('the view draws from columnGroups and mapExtent',async()=>{
 const view=await readFile(new URL('../public/inventory-view.js',import.meta.url),'utf8');
 assert.match(view,/gs=columnGroups\(list,layout\.columns\)/);
 assert.match(view,/const \{width,height\}=mapExtent\(\[\.\.\.pos\.values\(\)\],laneList\.length,\{COL,ROW,TOP\}\);/);
 assert.doesNotMatch(view,/function groups\(list\)/,'no second grouping that could drop a card');
});
