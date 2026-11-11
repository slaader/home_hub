// Linux host metrics from a Prometheus server the household already runs (on the host itself or in Docker):
// the hub reads the node_exporter series Prometheus has scraped for ONE target, through Prometheus' read-only
// HTTP API (https://prometheus.io/docs/prometheus/latest/querying/api/). Nothing is installed; no Prometheus
// is needed when Node Exporter is read directly (server/linux-telemetry.mjs) — this is for an existing one.
//
// What the hub calls, and nothing else: GET /api/v1/query on the Prometheus server endpoint (default 9090) with
// one of three fixed queries. Never /metrics (that would be Prometheus' own process, not a host), never an admin,
// lifecycle, config, reload or write route, never PromQL from the browser:
//   discovery  node_uname_info, up, timestamp(up)   every scraped node_exporter target, by exact job and instance
//   snapshot   {__name__=~"<the node_exporter metrics the hub reads>|up", job="<job>", instance="<instance>"}[2m]
// job and instance are only ever values Prometheus itself listed at discovery (the set-up draft checks it); they
// reach PromQL only as escaped string literals in equality matchers, so they can never widen the selector.
//
// Why a range selector and not rate(): the hub keeps one meaning for every Linux source (two snapshots of raw
// counters, server/linux-telemetry.mjs → deriveLinuxReading), and a range selector returns the stored samples
// with their real timestamps. An instant selector would hand back the last value from up to five minutes ago
// (the lookback window) stamped "now"; the hub never does that. The snapshot is the newest scrape of the
// target: the newest `up` sample; it must be 1 (target up) and inside the two-minute window ("stale" otherwise);
// of every other series only its sample of exactly that scrape is used, so a series that vanished or a
// different scrape never mixes in. A poll that finds the same scrape as the last one records nothing (no
// reading is made up); reset and reboot handling is the Linux one.
// One host only: a job+instance pair with more than one node_uname_info series (relabelling, federation) is
// "ambiguous" and is not offered; nothing is ever summed across targets.
import {createHash} from 'node:crypto';
import {endpointRequest,validEndpointHost,validEndpointPort,CERT_PIN} from './endpoint-http.mjs';
import {snapshotFromMetrics,linuxDriver,EXPORTER_METRICS,validBasicUser} from './linux-telemetry.mjs';

export const PROMETHEUS_PROVIDER='prometheus',PROMETHEUS_NAME='Linux (Prometheus)',PROMETHEUS_PORT=9090;
export const PROM_WINDOW_SECONDS=120;
export const PROM_API_LIMITS=Object.freeze({replyBytes:8*1024*1024,series:20000,samplesPerSeries:64,targets:500});
const fail=code=>{throw new Error(code);};
// A label value as Prometheus lists it: printable, bounded. (Only discovered values are ever stored.)
export const validLabelValue=v=>typeof v==='string'&&v.length>=1&&v.length<=200&&!/[\u0000-\u001f\u007f]/.test(v);
export const validPromPassword=p=>typeof p==='string'&&p.length>=1&&p.length<=256&&!/[\u0000-\u001f\u007f]/.test(p);
export const validBearer=t=>typeof t==='string'&&/^[A-Za-z0-9._~+/=-]{1,4096}$/.test(t);
const validTrust=t=>Boolean(t&&typeof t==='object'&&(t.mode==='ca'||t.mode==='pin'&&CERT_PIN.test(t.pin||'')));
const validAuth=a=>a==null||a.type==='basic'&&validBasicUser(a.user)&&validPromPassword(a.password)||a.type==='bearer'&&validBearer(a.token);
// A stored Prometheus connection (state/home/telemetry-hosts.json, 0600). Credentials only with verified HTTPS.
export const validPromRecord=r=>Boolean(r&&typeof r==='object'&&r.mode===PROMETHEUS_PROVIDER&&validEndpointHost(r.host)&&validEndpointPort(r.port)&&
 validLabelValue(r.job)&&validLabelValue(r.instance)&&(r.scheme==='http'?r.tls==null&&r.auth==null:r.scheme==='https'&&validTrust(r.tls)&&validAuth(r.auth)));
export const promLabel=r=>`${r.instance} (${r.job}) · ${r.scheme}://${r.host}:${r.port}`;

export const PROMETHEUS_ERRORS=Object.freeze({
 refused:'Na tom portu nic nepřijímá spojení. Běží Prometheus a je jeho port (výchozí 9090; v Dockeru zveřejněný port kontejneru) dostupný z adresy Home Hubu?',
 unresolved:'Jméno hostitele se ze serveru s Home Hubem nedá přeložit. Zadej IP adresu nebo jméno, které zná tvoje DNS (jméno kontejneru Dockeru zvenku nefunguje).',
 timeout:'Prometheus neodpověděl včas. Stroj může spát nebo být mimo síť, nebo port blokuje firewall.',
 unreachable:'Server s Prometheem není v síti k zastižení.',
 'tls-untrusted':'Certifikát Promethea neověřila žádná autorita, které Home Hub věří. Použij připnutí otisku certifikátu.',
 'tls-hostname':'Certifikát Promethea nepatří k tomuhle jménu hostitele. Zadej jméno z certifikátu, nebo použij připnutí otisku.',
 'tls-pin':'Prometheus ukázal jiný certifikát, než jaký jsi potvrdil. Načti certifikát znovu a porovnej otisk; do té doby Home Hub nic nepošle.',
 tls:'Spojení TLS s Prometheem selhalo. Je na tom portu opravdu HTTPS?',
 denied:'Prometheus (nebo proxy před ním) odmítl přihlášení. Zkontroluj uživatele a heslo, nebo token.',
 'needs-auth':'Prometheus chce přihlášení. Zadej uživatele a heslo, nebo token (jen přes ověřené HTTPS).',
 redirect:'Endpoint odpověděl přesměrováním. Home Hub přesměrování nesleduje; zadej přímo adresu a port Promethea (bez cesty).',
 'not-prometheus':'Na tomhle portu není API Promethea (/api/v1/query). Port 9100 je Node Exporter: pro něj zvol Linux (Node Exporter); Prometheus má obvykle port 9090.',
 http:'Prometheus odpověděl chybou HTTP.',
 encoded:'Prometheus poslal komprimovanou odpověď, i když o ni Home Hub nežádal.',
 'too-large':'Odpověď Promethea byla nečekaně velká a byla zahozena.',
 'bad-output':'Odpověď není API Promethea. Je to opravdu server Prometheus?',
 'prom-error':'Prometheus dotaz odmítl. Je to Prometheus 2.x nebo novější?',
 'no-targets':'Prometheus nemá žádný cíl s metrikami Node Exporteru (node_uname_info). Na Linuxu spusť Node Exporter a přidej ho do scrape_configs Promethea (návod v nastavení spojení), pak načti cíle znovu.',
 'target-missing':'Vybraný cíl (job a instance) už Prometheus nemá. Načti cíle znovu a vyber ho.',
 'target-down':'Prometheus vybraný cíl nedokáže sesbírat (up = 0). Běží na stroji Node Exporter a dosáhne na něj Prometheus?',
 stale:'Prometheus z vybraného cíle poslední dvě minuty nic nesesbíral. Data starší než dvě minuty Home Hub neukazuje jako aktuální.',
 ambiguous:'Pod tímhle jobem a instancí má Prometheus víc strojů (víc řad node_uname_info). Home Hub je nesčítá; uprav relabeling, aby měl každý stroj vlastní instanci.',
 'no-metrics':'Cíl je v Prometheu, ale bez metrik CPU a paměti Node Exporteru. Jsou vypnuté výchozí kolektory cpu a meminfo?',
 'plain-http':'Na tomhle portu běží HTTPS. Zvol HTTPS a ověř certifikát.',
 busy:'Právě běží jiné zkoušky spojení. Zkus to za chvíli.',unavailable:'Telemetrie Linuxu teď neodpovídá.'});

// --- PromQL -----------------------------------------------------------------------------------------------
// A PromQL double-quoted string literal: backslash, quote and line breaks escaped; nothing else needs it.
export const promString=v=>{if(!validLabelValue(v))fail('invalid');return `"${v.replace(/\\/g,'\\\\').replace(/"/g,'\\"')}"`;};
export const SNAPSHOT_METRICS=Object.freeze(['up',...EXPORTER_METRICS]);
// timestamp(up) is the time of the newest stored sample (an instant vector is stamped with the query time instead).
export const DISCOVERY_QUERIES=Object.freeze({uname:'node_uname_info',up:'up',upAt:'timestamp(up)'});
// The one snapshot selector for a target. Metric names are constants; job and instance are escaped literals.
export function snapshotQuery(job,instance){
 return `{__name__=~"${SNAPSHOT_METRICS.join('|')}",job=${promString(job)},instance=${promString(instance)}}[${PROM_WINDOW_SECONDS}s]`;
}

// --- the API ----------------------------------------------------------------------------------------------
const trustOf=r=>r.scheme==='https'?(r.tls.mode==='pin'?{mode:'pin',pin:r.tls.pin}:{mode:'ca'}):null;
const authHeader=a=>!a?{}:a.type==='basic'?{Authorization:'Basic '+Buffer.from(`${a.user}:${a.password}`,'utf8').toString('base64')}:{Authorization:`Bearer ${a.token}`};
// One GET /api/v1/query. conn = {host, port, scheme, tls, auth}. Resolves data ({resultType, result}); rejects with a code.
export async function promQuery(conn,query,{request=endpointRequest,timeoutMs=12000}={}){
 if(!Object.values(DISCOVERY_QUERIES).includes(query)&&!/^\{__name__=~"/.test(query))fail('invalid');
 if(conn.scheme==='http'&&conn.auth)fail('invalid');
 let r;
 try{r=await request({host:conn.host,port:conn.port,path:'/api/v1/query',query:{query},trust:trustOf(conn),timeoutMs,maxBytes:PROM_API_LIMITS.replyBytes,
  headers:{Accept:'application/json',...authHeader(conn.auth)},okStatus:[200,400,422,503]});}
 catch(e){
  if(e?.message==='http'){const s=e.status;if(s===401||s===403)fail(conn.auth?'denied':'needs-auth');if(s===404||s===405)fail('not-prometheus');
   if(s===400&&conn.scheme==='http'&&/https/i.test(String(e.body||'').slice(0,400)))fail('plain-http');fail('http');}
  fail(Object.hasOwn(PROMETHEUS_ERRORS,e?.message)?e.message:'unreachable');
 }
 if(!/application\/json/i.test(String(r.headers['content-type']||'')))fail(r.status===200?'not-prometheus':'http');
 let d;try{d=JSON.parse(r.body.toString('utf8'));}catch{fail('bad-output');}
 if(!d||typeof d!=='object')fail('bad-output');
 if(d.status==='error')fail('prom-error');
 if(d.status!=='success'||!d.data||typeof d.data!=='object'||!Array.isArray(d.data.result))fail('bad-output');
 if(d.data.result.length>PROM_API_LIMITS.series)fail('too-large');
 return d.data;
}
const metricOf=x=>x&&typeof x.metric==='object'&&x.metric&&!Array.isArray(x.metric)?x.metric:null;
// [ts, "value"] → {ts (seconds), value} or null (NaN, ±Inf and stale markers are dropped, never made 0).
const sampleOf=p=>{if(!Array.isArray(p)||p.length!==2||!Number.isFinite(p[0])||typeof p[1]!=='string')return null;const v=Number(p[1]);return Number.isFinite(v)?{ts:p[0],value:v}:null;};
// Every node_exporter target Prometheus scrapes: [{job, instance, nodename, release, up, lastSampleAt, eligible, reason}].
// eligible: exactly one node_uname_info series for the pair. Up comes from the `up` series of the same pair.
export async function discoverTargets(conn,{request=endpointRequest}={}){
 const [uname,up,upAt]=await Promise.all([promQuery(conn,DISCOVERY_QUERIES.uname,{request}),promQuery(conn,DISCOVERY_QUERIES.up,{request}),promQuery(conn,DISCOVERY_QUERIES.upAt,{request})]);
 if([uname,up,upAt].some(d=>d.resultType!=='vector'))fail('bad-output');
 const key=(j,i)=>`${j}\u0000${i}`,ups=new Map(),ats=new Map();
 for(const [list,into] of [[up.result,ups],[upAt.result,ats]])for(const x of list){const m=metricOf(x);if(!m||!validLabelValue(m.job)||!validLabelValue(m.instance))continue;const s=sampleOf(x.value);if(s)into.set(key(m.job,m.instance),s.value);}
 const by=new Map();
 for(const x of uname.result){const m=metricOf(x);if(!m||!validLabelValue(m.job)||!validLabelValue(m.instance))continue;const k=key(m.job,m.instance);
  const e=by.get(k)||{job:m.job,instance:m.instance,count:0,nodename:null,release:null};e.count++;e.nodename??=String(m.nodename||'').slice(0,120)||null;e.release??=String(m.release||'').slice(0,60)||null;by.set(k,e);}
 if(by.size>PROM_API_LIMITS.targets)fail('too-large');
 return [...by.values()].map(e=>{const u=ups.get(key(e.job,e.instance));
  const at=ats.get(key(e.job,e.instance));
  return {job:e.job,instance:e.instance,nodename:e.nodename,release:e.release,up:u==null?null:u===1,lastSampleAt:Number.isFinite(at)&&at>0?new Date(at*1000).toISOString():null,
   eligible:e.count===1,reason:e.count===1?null:'ambiguous'};}).sort((a,b)=>a.job.localeCompare(b.job)||a.instance.localeCompare(b.instance));
}
// The matrix of the snapshot selector → the metrics map of server/prom-text.mjs at the newest scrape, and its time.
export function scrapeFromMatrix(data,{job,instance,nowSec=Date.now()/1000}={}){
 if(data?.resultType!=='matrix')fail('bad-output');
 const series=[];
 for(const x of data.result){const m=metricOf(x);if(!m||m.job!==job||m.instance!==instance||typeof m.__name__!=='string'||!SNAPSHOT_METRICS.includes(m.__name__)||!Array.isArray(x.values))continue;
  series.push({name:m.__name__,labels:Object.fromEntries(Object.entries(m).filter(([k])=>k!=='__name__')),values:x.values.slice(-PROM_API_LIMITS.samplesPerSeries).map(sampleOf).filter(Boolean)});}
 const ups=series.filter(s=>s.name==='up');
 if(!ups.length||!series.some(s=>s.name==='node_uname_info'))fail(ups.length?'no-metrics':'stale');
 if(ups.length>1||series.filter(s=>s.name==='node_uname_info').length>1)fail('ambiguous');
 const last=ups[0].values.at(-1);if(!last)fail('stale');
 if(last.ts>nowSec+5||nowSec-last.ts>PROM_WINDOW_SECONDS)fail('stale');
 if(last.value!==1)fail('target-down');
 const scrape=last.ts,metrics=new Map();
 for(const s of series){if(s.name==='up')continue;const at=s.values.find(v=>Math.abs(v.ts-scrape)<0.0005);if(!at)continue;// not part of the newest scrape
  if(!metrics.has(s.name))metrics.set(s.name,[]);metrics.get(s.name).push({labels:s.labels,value:at.value,ts:Math.round(at.ts*1000)});}
 if(!metrics.has('node_cpu_seconds_total')&&!metrics.has('node_memory_MemTotal_bytes'))fail('no-metrics');
 return {metrics,scrape};
}
// One snapshot of the record's target.
export async function collectPrometheus(record,{request=endpointRequest,now=Date.now}={}){
 if(!validPromRecord(record))fail('invalid');
 const data=await promQuery(record,snapshotQuery(record.job,record.instance),{request});
 const {metrics,scrape}=scrapeFromMatrix(data,{job:record.job,instance:record.instance,nowSec:now()/1000});
 return {...snapshotFromMetrics(metrics,now(),{clockSeconds:scrape,source:PROMETHEUS_PROVIDER}),scrape};
}

// --- the poller side --------------------------------------------------------------------------------------
const secretTag=a=>a?createHash('sha256').update('home-hub-telemetry\u0000'+(a.password||a.token||'')).digest('hex').slice(0,16):'';
export const promKey=c=>['prom',c.record.host.toLowerCase(),c.record.port,c.record.scheme,c.record.tls?.mode||'',c.record.tls?.pin||'',c.record.auth?.type||'',c.record.auth?.user||'',secretTag(c.record.auth),c.record.job,c.record.instance].join('|');
export const promInfo=c=>({mode:PROMETHEUS_PROVIDER,host:c.record.host,port:c.record.port,scheme:c.record.scheme,job:c.record.job,instance:c.record.instance,
 tls:c.record.tls?{mode:c.record.tls.mode,...(c.record.tls.pin?{fingerprint:c.record.tls.pin}:{})}:null,auth:c.record.auth?.type||'none',user:c.record.auth?.type==='basic'?c.record.auth.user:null});
export const prometheusDriver=({collect})=>linuxDriver({collect:c=>collect(c.record),errors:PROMETHEUS_ERRORS,valid:c=>Boolean(c&&typeof c.id==='string'&&validPromRecord(c.record)),
 key:promKey,label:c=>promLabel(c.record),info:promInfo,deniedCodes:['denied','needs-auth'],sourceTime:true,unchanged:(prev,cur)=>prev.scrape!=null&&prev.scrape===cur.scrape});
