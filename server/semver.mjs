// Semver 2.0 versions and the small range syntax of plugin.json (docs/plugins.md → plugin.json). No dependency.
//   >=1.2.0 <2.0.0     comparators joined by spaces, all must hold (>, >=, <, <=, =, or a bare version)
//   ^1.2.0             the same major: >=1.2.0 <2.0.0  (^0.3.1 → <0.4.0, ^0.0.4 → <0.0.5)
//   ~1.2.0             the same minor: >=1.2.0 <1.3.0
//   1.x  1.2.x  1  *   wildcards; a partial version means the same as its x-range
//   a || b             either set (a plugin tested on two majors)
// A version with a pre-release tag (1.3.0-rc.1) satisfies a range only through a comparator that names a
// pre-release of the same major.minor.patch, so a range of releases never admits a release candidate by accident.
// Build metadata (+dev) never matters.
export const SEMVER=/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const RANGE_LIMIT=200;

export class SemverRangeError extends Error{}

/** "1.2.3-rc.1+dev" → {major, minor, patch, prerelease:['rc',1], build:'dev', text:'1.2.3-rc.1'}, or null. */
export function parse(text){
 const m=typeof text==='string'?SEMVER.exec(text.trim()):null;if(!m)return null;
 const prerelease=m[4]?m[4].split('.').map(p=>/^\d+$/.test(p)?Number(p):p):[];
 const [major,minor,patch]=[m[1],m[2],m[3]].map(Number);
 if(![major,minor,patch].every(Number.isSafeInteger))return null;
 return {major,minor,patch,prerelease,build:m[5]??null,text:`${major}.${minor}.${patch}${prerelease.length?'-'+m[4]:''}`};
}
export const valid=text=>parse(text)!==null;

const comparePre=(a,b)=>{
 if(!a.length&&!b.length)return 0;if(!a.length)return 1;if(!b.length)return -1;
 for(let i=0;i<Math.max(a.length,b.length);i++){
  if(a[i]===undefined)return -1;if(b[i]===undefined)return 1;if(a[i]===b[i])continue;
  const na=typeof a[i]==='number',nb=typeof b[i]==='number';
  if(na&&nb)return Math.sign(a[i]-b[i]);if(na)return -1;if(nb)return 1;return a[i]<b[i]?-1:1;
 }
 return 0;
};
/** -1, 0 or 1; build metadata ignored. Throws on a string that is not a version. */
export function compare(a,b){
 const x=typeof a==='string'?parse(a):a,y=typeof b==='string'?parse(b):b;
 if(!x||!y)throw new TypeError(`not a version: ${JSON.stringify(x?b:a)}`);
 return Math.sign(x.major-y.major)||Math.sign(x.minor-y.minor)||Math.sign(x.patch-y.patch)||comparePre(x.prerelease,y.prerelease);
}

// One comparator token → [{op, version}] (an x-range or a caret becomes two).
const PARTIAL=/^(?:v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?)$/;
function token(raw){
 const m=/^(\^|~|>=|<=|>|<|=)?(.+)$/.exec(raw);const op=m[1]||'',rest=m[2];
 if(rest==='*'||/^[xX]$/.test(rest)){if(op&&op!=='=')throw new SemverRangeError(`"${raw}" is not a comparator`);return [];}
 const p=PARTIAL.exec(rest);if(!p)throw new SemverRangeError(`"${raw}" is not a version or comparator`);
 const wild=v=>v===undefined||/^[xX*]$/.test(v);
 const [maj,min,pat]=[p[1],p[2],p[3]];
 if(wild(maj)){if(op&&op!=='=')throw new SemverRangeError(`"${raw}" is not a comparator`);return [];}
 if(wild(min)&&pat!==undefined&&!wild(pat))throw new SemverRangeError(`"${raw}": after a wildcard everything is a wildcard`);
 const M=Number(maj);
 if(wild(min)||wild(pat)){
  if(p[4])throw new SemverRangeError(`"${raw}": a pre-release needs a full version`);
  const N=wild(min)?null:Number(min);
  const low=N===null?`${M}.0.0`:`${M}.${N}.0`,high=N===null?`${M+1}.0.0-0`:`${M}.${N+1}.0-0`;
  switch(op){
   case '':case '=':case '^':case '~':return op==='^'&&N!==null&&M===0?[{op:'>=',v:low},{op:'<',v:`0.${N+1}.0-0`}]:op==='^'&&N!==null?[{op:'>=',v:low},{op:'<',v:`${M+1}.0.0-0`}]:[{op:'>=',v:low},{op:'<',v:high}];
   case '>':return [{op:'>=',v:high}];
   case '>=':return [{op:'>=',v:low}];
   case '<':return [{op:'<',v:`${low}-0`}];
   case '<=':return [{op:'<',v:high}];
  }
 }
 const v=parse(rest);if(!v)throw new SemverRangeError(`"${raw}" is not a version`);
 if(op==='^'){const high=v.major>0?`${v.major+1}.0.0-0`:v.minor>0?`0.${v.minor+1}.0-0`:`0.0.${v.patch+1}-0`;return [{op:'>=',v:v.text},{op:'<',v:high}];}
 if(op==='~')return [{op:'>=',v:v.text},{op:'<',v:`${v.major}.${v.minor+1}.0-0`}];
 return [{op:op||'=',v:v.text}];
}

/** "^1.2.0 || >=3.0.0 <4" → [[{op, version}…]…] (sets of comparators). Throws RangeError naming the part. */
export function parseRange(text){
 if(typeof text!=='string'||!text.trim()||text.length>RANGE_LIMIT||/[\u0000-\u001f]/.test(text))throw new SemverRangeError(`a range is a non-empty string of at most ${RANGE_LIMIT} characters`);
 return text.split('||').map(set=>{
  const parts=set.trim().replace(/(>=|<=|>|<|=|\^|~)\s+/g,'$1').split(/\s+/).filter(Boolean);
  if(!parts.length)throw new SemverRangeError(`"${text}" has an empty alternative`);
  return parts.flatMap(token).map(c=>({op:c.op,version:parse(c.v)}));
 });
}
export function validRange(text){try{parseRange(text);return true;}catch{return false;}}

const holds=(v,{op,version})=>{const c=compare(v,version);return op==='='?c===0:op==='>'?c>0:op==='>='?c>=0:op==='<'?c<0:c<=0;};
/** Does version (a string such as "1.2.0" or "1.2.0+dev") satisfy range? False for a version that does not parse. */
export function satisfies(version,range){
 const v=typeof version==='string'?parse(version):version;if(!v)return false;
 const sets=typeof range==='string'?parseRange(range):range;
 return sets.some(set=>{
  if(!set.every(c=>holds(v,c)))return false;
  if(!v.prerelease.length)return true;
  // npm's rule: a pre-release only through a comparator naming a pre-release of the same version (the "-0"
  // floors that x-ranges and carets add are not names, they only make the bounds exclusive).
  return set.some(c=>c.version.prerelease.length&&!(c.version.prerelease.length===1&&c.version.prerelease[0]===0)&&c.version.major===v.major&&c.version.minor===v.minor&&c.version.patch===v.patch);
 });
}
