// Version strings as tools print them: "v2.2.6", "0.7.3rc1", "0.5.0-dev", "26.13.0_2" (Homebrew
// revision), "v.0.24.0". Shared by systems-data.mjs and systems-upstream.mjs.
const clean=(v,n=600)=>typeof v==='string'?v.replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,n):'';
// "v2.2.6", "0.7.3rc1", "0.5.0-dev", "26.13.0_2" (Homebrew revision), "v.0.24.0" → numbers + pre-release.
export function parseVersion(raw){
 if(typeof raw!=='string')return null;
 const s=raw.trim().replace(/^[vV]\.?/,'').replace(/_\d+$/,'');
 const m=/^(\d+(?:\.\d+)*)(.*)$/.exec(s);if(!m)return null;
 const p=/^[-.+]?(dev|alpha|a|beta|b|preview|pre|rc)\.?(\d*)/i.exec(m[2]);
 const rank={dev:0,alpha:1,a:1,beta:2,b:2,preview:3,pre:3,rc:3};
 return {nums:m[1].split('.').map(Number),pre:p?[rank[p[1].toLowerCase()],Number(p[2]||0)]:null};
}
export function compareVersions(a,b){
 const x=parseVersion(a),y=parseVersion(b);if(!x||!y)return null;
 for(let i=0;i<Math.max(x.nums.length,y.nums.length);i++){const d=(x.nums[i]||0)-(y.nums[i]||0);if(d)return Math.sign(d);}
 if(x.pre&&!y.pre)return -1;if(!x.pre&&y.pre)return 1;
 if(x.pre&&y.pre)return Math.sign(x.pre[0]-y.pre[0])||Math.sign(x.pre[1]-y.pre[1]);
 return 0;
}
// First version-looking token of a command's output, or the detect entry's own regex.
export function extractVersion(text,match){
 const s=clean(text);if(!s)return null;
 if(match){const m=new RegExp(match).exec(s);return m?(m[1]??m[0]).replace(/^v(?=\d)/,''):null;}
 const m=/(?:^|[^\w.])v?(\d+(?:\.\d+)+(?:[-.]?(?:rc|dev|alpha|beta|pre)\.?\d*)?)/i.exec(s);
 return m?m[1]:null;
}

