// The real inventory map on the mocked DOM with entries whose machine is unknown or missing: they are drawn
// in an Ostatní lane, a machine entry the site did not list gets a lane of its own, the SVG size stays finite
// (no NaN viewBox, which clips the map), and every card can be selected.
import './support/site-inventory.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {installDom,fire} from './fixtures/mini-dom.mjs';

const {document,localStorage}=installDom();
const {inventoryView}=await import('../public/inventory-view.js');
const {setPrincipal}=await import('../public/session-cache.js');
// These tests read Czech labels: the language a site with defaultLanguage "cs" starts in.
(await import('../public/i18n.js')).setDefaultLang('cs');
const DOC={updated_at:'2026-11-08T00:00:00Z',entries:[
 {id:'mini',kind:'machine',name:'Mac mini'},
 {id:'svc-a',kind:'runtime',name:'Alpha',machine:'mini'},
 {id:'hue-bridge',kind:'machine',name:'Hue Bridge'},
 {id:'pi-tool',kind:'tool',name:'Pi tool',machine:'garage-pi'},
 {id:'lost',kind:'runtime',name:'No machine'}]};
globalThis.fetch=async url=>String(url)==='/api/inventory'?{ok:true,status:200,json:async()=>({doc:DOC,gaps:[]})}:{ok:false,status:404,json:async()=>({})};
const tick=()=>new Promise(r=>setImmediate(r));
const num=v=>Number(v);
const translate=n=>n.getAttribute('transform').match(/translate\((\S+) (\S+)\)/).slice(1).map(Number);

test('DOM: cards with an unknown machine render in Ostatní, an unlisted machine gets its own lane, and the SVG size is finite',async()=>{
 setPrincipal({authKind:'session',role:'viewer',username:'u1'});localStorage.clear();
 document.body.replaceChildren(inventoryView({role:'viewer'}));for(let i=0;i<5;i++)await tick();
 const svg=document.body.querySelector('.inv-map-wrap').children[0];
 const [x0,y0,w,h]=svg.getAttribute('viewBox').split(' ').map(Number);
 for(const v of [x0,y0,w,h,num(svg.getAttribute('width')),num(svg.getAttribute('height'))])assert.ok(Number.isFinite(v),svg.getAttribute('viewBox'));
 assert.equal(svg.getAttribute('width'),String(w));
 for(const r of svg.querySelectorAll('.inv-lane'))assert.ok(Number.isFinite(num(r.getAttribute('height'))),'lane height');
 const labels=svg.querySelectorAll('.inv-lane-label').map(t=>t.textContent);
 assert.equal(labels.at(-1),'OSTATNÍ',labels.join(', '));
 const cards=new Map(svg.querySelectorAll('.inv-node').map(n=>[n.getAttribute('aria-label').split(',')[0],n]));
 assert.equal(cards.size,5,'every entry is drawn');
 for(const [name,n] of cards){const [x,y]=translate(n);assert.ok(x>=0&&x+180<=w&&y>=0&&y+40<=h,`${name} at ${x},${y} lies inside ${w}x${h}`);}
 const lanes=svg.querySelectorAll('.inv-lane'),other=lanes.at(-1),ox=num(other.getAttribute('x'));
 for(const name of ['Pi tool','No machine'])assert.equal(translate(cards.get(name))[0],ox+12,`${name} is in the Ostatní lane`);
 const hue=lanes[labels.indexOf('HUE BRIDGE')];assert.ok(hue,labels.join(', '));
 assert.equal(translate(cards.get('Hue Bridge'))[0],num(hue.getAttribute('x'))+12,'a machine entry the site did not list has a lane of its own');
 const rect=cards.get('Pi tool').children.find(c=>c.tagName==='rect');
 const ev={pointerId:1,pointerType:'touch',isPrimary:true,button:0,clientX:5,clientY:5};
 fire(rect,'pointerdown',ev);fire(rect,'pointerup',ev);
 const sel=document.body.querySelector('.inv-map-wrap').children[0].querySelectorAll('.inv-node').find(n=>n.getAttribute('aria-pressed')==='true');
 assert.equal(sel?.getAttribute('aria-label').split(',')[0],'Pi tool','an Ostatní card can be selected');
 assert.match(sel.getAttribute('aria-label'),/^Pi tool, Nástroje\./);
});
