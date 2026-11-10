// The pure parts of the review and search pages: how a round's decisions are counted, which round answered
// a comment, how search hits are grouped and titled. Drawing itself is checked in a browser (docs/review.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {roundProgress,itemStatus,answeredBy} from '../public/review-view.js';
import {groupResults,titleOf,resultHref,searchHash,queryOf} from '../public/search-view.js';

test('review: a round is counted by saved decisions; an untouched item is pending',()=>{
 const round={items:[{id:'a'},{id:'b'},{id:'c'},{id:'d'},{id:'e'}],feedback:{a:{rev:2,status:'accept'},b:{rev:1,status:'revise'},c:{rev:1,status:'reject'},d:{rev:0,status:'accept'}}};
 assert.equal(itemStatus(round,{id:'a'}),'accept');assert.equal(itemStatus(round,{id:'d'}),'pending','rev 0 is not a saved decision');assert.equal(itemStatus(round,{id:'e'}),'pending');
 assert.deepEqual(roundProgress(round),{accept:1,revise:1,reject:1,pending:2,total:5,decided:3});
 assert.deepEqual(roundProgress({items:[],feedback:{}}),{accept:0,revise:0,reject:0,pending:0,total:0,decided:0});
});
test('review: a comment is answered by the first later round that lists it',()=>{
 const rounds=[{n:2,addresses:['c1']},{n:3,addresses:['c1','c2']},{n:4}];
 const by=answeredBy(rounds);assert.equal(by.get('c1').n,2);assert.equal(by.get('c2').n,3);assert.equal(by.has('c3'),false);assert.equal(answeredBy([]).size,0);
});
test('search: hits are grouped by kind in a fixed order and keep their ranking',()=>{
 const results=[{kind:'review',id:'R-2'},{kind:'ticket',id:'APP-3'},{kind:'review',id:'R-1'},{kind:'ticket',id:'APP-1'}];
 assert.deepEqual(groupResults(results).map(g=>[g.kind,g.results.map(r=>r.id)]),[['ticket',['APP-3','APP-1']],['review',['R-2','R-1']]]);
 assert.deepEqual(groupResults([{kind:'review',id:'R-1'}]).map(g=>g.kind),['review'],'an empty group is left out');
 assert.deepEqual(groupResults([{kind:'note',id:'n1'},{kind:'ticket',id:'APP-1'}]).map(g=>g.kind),['ticket','note'],'a kind a plugin adds comes after the known ones');
 assert.deepEqual(groupResults(undefined),[]);
 assert.equal(resultHref({kind:'review',id:'R-2'}),'#review/R-2');assert.equal(resultHref({kind:'ticket',id:'APP-3'}),'#items/APP-3');
 assert.equal(queryOf(searchHash(' naïve query ').slice('#search/'.length)),'naïve query');assert.equal(queryOf('%E0%A4%A'),'');
});
test('search: the id is taken off the indexed title, marks included',()=>{
 assert.equal(titleOf({id:'APP-12',title:'APP-12 Login times out'}),'Login times out');
 assert.equal(titleOf({id:'APP-12',title:'\u0001APP\u0002-\u000112\u0002 Login times out'}),'Login times out','the id matched as two words');
 assert.equal(titleOf({id:'APP-12',title:'APP-12 \u0001Login\u0002 times out'}),'\u0001Login\u0002 times out','marks in the title stay');
 assert.equal(titleOf({id:'R-3',title:'Something else'}),'Something else');assert.equal(titleOf({id:'R-3',title:'R-3'}),'R-3','never an empty title');
});
test('review and search pages offer the documented ways in: empty state, compare modes, shortcuts',()=>{
 const review=readFileSync(new URL('../public/review-view.js',import.meta.url),'utf8'),search=readFileSync(new URL('../public/search-view.js',import.meta.url),'utf8');
 assert.match(review,/emptyState\(\{/);assert.match(review,/review_publish/);assert.match(review,/review:write/);assert.match(review,/scripts\/review-push\.mjs/);assert.match(review,/mcpSnippet:true/);
 for(const mode of ["'side'","'one'","'swipe'"])assert.ok(review.includes(mode),mode);
 assert.match(search,/e\.key!=='\/'/,'"/" focuses search');assert.match(search,/data-slash/);assert.match(search,/ticket_search/);
 const css=readFileSync(new URL('../public/review.css',import.meta.url),'utf8')+readFileSync(new URL('../public/tickets.css',import.meta.url),'utf8');
 assert.match(css,/@media\(max-width:700px\)/);assert.match(css,/\.rv-swipe-range/);assert.match(css,/var\(--color-accent\)/,'the pages use the design tokens');
});
test('views: no fixed locale or time zone, and no Czech text outside the translation calls',()=>{
 const pub=new URL('../public/',import.meta.url);
 for(const file of ['tracker-view.js','review-view.js','search-view.js']){
  const src=readFileSync(new URL(file,pub),'utf8');
  assert.doesNotMatch(src,/cs-CZ|Europe\/Prague/,`${file}: dates follow locale() and the site's time zone`);
  assert.match(src,/from '\.\/i18n\.js'/);assert.match(src,/locale\(\)/);assert.match(src,/timeZone\(\)/);
  const code=src.replace(/(?<![\w.$])t\(\s*'((?:[^'\\\n]|\\.)*)'/g,"t('')").replace(/(?<![\w.$])(tp\([^,()]+(?:\([^()]*\))?[^,()]*,\s*)'((?:[^'\\\n]|\\.)*)'/g,"$1''")
   .split('\n').map(line=>line.replace(/^\s*\/\/.*$/,'').replace(/\s\/\/ .*$/,''));
  const czech=code.map((line,i)=>/[ěščřžýáíéúůďťňĚŠČŘŽÝÁÍÉÚŮĎŤŇ]/.test(line)?`${file}:${i+1}`:null).filter(Boolean);
  assert.deepEqual(czech,[],'every visible string goes through t() or tp()');
 }
});
