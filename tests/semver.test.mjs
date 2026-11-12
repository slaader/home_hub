// Versions and the range syntax of plugin.json (server/semver.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import {parse,compare,parseRange,validRange,satisfies,valid} from '../server/semver.mjs';

test('versions: semver 2.0, build metadata ignored, pre-releases ordered',()=>{
 assert.deepEqual(parse('1.2.3-rc.1+dev'),{major:1,minor:2,patch:3,prerelease:['rc',1],build:'dev',text:'1.2.3-rc.1'});
 assert.equal(parse('v1.0.0').text,'1.0.0');
 for(const bad of ['1.2','01.2.3','1.2.3.4','1.2.3-','1.2.3-01','x',null,42,' '])assert.equal(valid(bad),false,String(bad));
 const ordered=['1.0.0-alpha','1.0.0-alpha.1','1.0.0-alpha.beta','1.0.0-beta','1.0.0-beta.2','1.0.0-beta.11','1.0.0-rc.1','1.0.0','1.0.1','1.1.0','2.0.0'];
 for(let i=1;i<ordered.length;i++){assert.equal(compare(ordered[i-1],ordered[i]),-1,`${ordered[i-1]} < ${ordered[i]}`);assert.equal(compare(ordered[i],ordered[i-1]),1);}
 assert.equal(compare('1.2.0+a','1.2.0+b'),0);
 assert.throws(()=>compare('1.2','1.2.0'),/not a version/);
});

test('ranges: comparators, caret, tilde, x-ranges, alternatives',()=>{
 const cases=[
  ['1.2.0','>=1.2.0 <2.0.0',true],['1.99.0','>=1.2.0 <2.0.0',true],['2.0.0','>=1.2.0 <2.0.0',false],['1.1.9','>=1.2.0 <2.0.0',false],
  ['1.0.0','>= 1.0.0',true],['1.2.0','=1.2.0',true],['1.2.0','1.2.0',true],['1.2.1','1.2.0',false],['1.2.1','>1.2.0',true],['1.2.0','<=1.2.0',true],
  ['1.5.0','^1.2.0',true],['2.0.0','^1.2.0',false],['1.1.0','^1.2.0',false],
  ['0.3.5','^0.3.1',true],['0.4.0','^0.3.1',false],['0.0.4','^0.0.4',true],['0.0.5','^0.0.4',false],
  ['1.2.9','~1.2.0',true],['1.3.0','~1.2.0',false],['1.9.0','~1',true],
  ['1.9.9','1.x',true],['2.0.0','1.x',false],['1.2.7','1.2.x',true],['1.3.0','1.2',false],['1.0.0','1',true],['9.9.9','*',true],
  ['1.2.0','>1.1',true],['1.1.5','>1.1',false],['1.1.5','<=1.1',true],['1.2.0','<1.2',false],['1.1.9','<1.2',true],['0.2.1','^0.2',true],['0.3.0','^0.2',false],
  ['3.1.0','^1.2.0 || ^3.0.0',true],['2.5.0','^1.2.0 || ^3.0.0',false],
  ['1.1.0+dev','>=1.1.0 <2.0.0',true],
 ];
 for(const [v,r,want] of cases)assert.equal(satisfies(v,r),want,`${v} in ${r}`);
 assert.equal(satisfies('not a version','*'),false);
 for(const bad of ['','  ','>>1.0.0','^','1.2.3 - 2.0.0','>=x','1.2.3.4','a || ','<1.x.2','>=1.0.0\n<2'])assert.equal(validRange(bad),false,JSON.stringify(bad));
 assert.throws(()=>parseRange('>=1.0.0 <x'),/"<x" is not a comparator/);assert.throws(()=>parseRange('>=1.0.0 <1.2.y'),/"<1.2.y" is not a version/);
});

test('pre-releases satisfy a range only when it names a pre-release of the same version',()=>{
 assert.equal(satisfies('1.3.0-rc.1','>=1.2.0'),false,'a release range never admits a release candidate');
 assert.equal(satisfies('2.0.0-rc.1','^1.2.0'),false);assert.equal(satisfies('2.0.0-rc.1','1.x'),false);
 assert.equal(satisfies('1.3.0-rc.2','>=1.3.0-rc.1'),true);assert.equal(satisfies('1.3.0-rc.1','>=1.3.0-rc.2'),false);
 assert.equal(satisfies('1.4.0-rc.1','>=1.3.0-rc.1'),false,'only of the same major.minor.patch');
 assert.equal(satisfies('1.3.0','>=1.3.0-rc.1 <2.0.0'),true);
});
