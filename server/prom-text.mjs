// The Prometheus text exposition format (version 0.0.4, what Node Exporter serves at /metrics), read strictly
// and with bounds. https://prometheus.io/docs/instrumenting/exposition_formats/
//   sample   name{label="value",…} value [timestamp]
//   comment  # HELP …, # TYPE …, any other "#" line (and OpenMetrics' "# EOF"): ignored
// Only the metric names the caller asks for are kept (wanted: a Set); every other line is skipped after its
// name, so a large exposition costs little. Label values are unescaped exactly as the format says (\\, \" and
// \n; any other escape is an error, as in Prometheus). Values: Go float syntax incl. NaN and ±Inf; only finite
// values are kept (a NaN or Inf sample is dropped, never turned into 0). An optional timestamp (integer
// milliseconds) is checked and returned as `ts`, never used as the reading's time. A duplicated series: the
// last one wins. A malformed line of a wanted metric fails the whole scrape (Error('bad-metrics')), as a
// Prometheus server would.
export const PROM_LIMITS=Object.freeze({bytes:8*1024*1024,lines:400000,lineLength:65536,samples:60000,labels:32,labelValue:2048});
const fail=()=>{throw new Error('bad-metrics');};
const NAME=/^[A-Za-z_:][A-Za-z0-9_:]*/,LABEL=/^[A-Za-z_][A-Za-z0-9_]*/;
const VALUE=/^[+-]?(?:(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|Inf|inf|NaN|nan)$/,TS=/^-?\d{1,19}$/;
function number(text){
 if(!VALUE.test(text))fail();
 const n=/nan$/i.test(text)?NaN:/inf$/i.test(text)?(text.startsWith('-')?-Infinity:Infinity):Number(text);
 return n;
}
// → Map(name → [{labels:{…}, value, ts}]). wanted: Set of metric names (null = keep all, for tests).
export function parsePromText(input,wanted=null,limits=PROM_LIMITS){
 const text=Buffer.isBuffer(input)?input.toString('utf8'):String(input??'');
 if(Buffer.byteLength(text,'utf8')>limits.bytes)fail();
 const out=new Map(),seen=new Map();let kept=0,lineCount=0;
 let at=0;
 while(at<=text.length){
  let end=text.indexOf('\n',at);if(end<0)end=text.length;
  const line=text.slice(at,end).replace(/\r$/,'');at=end+1;
  if(++lineCount>limits.lines)fail();
  if(line.length>limits.lineLength)fail();
  if(!line.trim()||line.trimStart().startsWith('#'))continue;
  const m=NAME.exec(line);if(!m)fail();
  const name=m[0];
  if(wanted&&!wanted.has(name))continue;
  let i=name.length;const labels={};let count=0;
  if(line[i]==='{'){
   i++;
   for(;;){
    while(line[i]===' '||line[i]==='\t')i++;
    if(line[i]==='}'){i++;break;}
    const l=LABEL.exec(line.slice(i));if(!l)fail();
    i+=l[0].length;
    while(line[i]===' '||line[i]==='\t')i++;
    if(line[i]!=='=')fail();i++;
    while(line[i]===' '||line[i]==='\t')i++;
    if(line[i]!=='"')fail();i++;
    let v='';
    for(;;){
     if(i>=line.length)fail();
     const c=line[i];
     if(c==='\\'){const n=line[i+1];if(n==='\\')v+='\\';else if(n==='"')v+='"';else if(n==='n')v+='\n';else fail();i+=2;}
     else if(c==='"'){i++;break;}
     else{v+=c;i++;}
     if(v.length>limits.labelValue)fail();
    }
    if(Object.hasOwn(labels,l[0]))fail();
    if(++count>limits.labels)fail();
    labels[l[0]]=v;
    while(line[i]===' '||line[i]==='\t')i++;
    if(line[i]===','){i++;continue;}
    if(line[i]==='}'){i++;break;}
    fail();
   }
  }
  const rest=line.slice(i).trim().split(/[ \t]+/);
  if(!rest[0]||rest.length>2||line[i]&&line[i]!==' '&&line[i]!=='\t')fail();
  const value=number(rest[0]);
  let ts=null;if(rest.length===2){if(!TS.test(rest[1]))fail();ts=Number(rest[1]);}
  if(!Number.isFinite(value))continue;
  const key=name+'\u0000'+Object.keys(labels).sort().map(k=>k+'='+labels[k]).join('\u0000');
  const sample={labels,value,ts};
  if(seen.has(key)){const s=seen.get(key);Object.assign(s,sample);continue;}
  if(++kept>limits.samples)fail();
  seen.set(key,sample);
  if(!out.has(name))out.set(name,[]);out.get(name).push(sample);
 }
 return out;
}
