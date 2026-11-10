// Systémy section: OS versions, watched software with update candidates, and host protection
// (firewall, FileVault, SIP, Gatekeeper, update policy, SSH password login, exposed ports).
// scripts/collect-systems.mjs runs scripts/systems/{mac,nas}-probe.sh on every machine and saves
// data/systems/snapshot.json; scripts/check-upstream.mjs saves the newest upstream versions to
// data/systems/upstream.json. buildSystems() joins both with config/software-watch.json.
// SSH keys and sudo stay in the security section (security-data.mjs); this module links to it.
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {upstreamKey} from './systems-upstream.mjs';
import {parseVersion,compareVersions,extractVersion} from './versions.mjs';
import {site as loadedSite,softwareWatchPath} from './site-config.mjs';
export {parseVersion,compareVersions,extractVersion};

export const SYSTEMS_SCHEMA=1;
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
// The machines the collector probes: every site machine with ssh.probe (mac or nas), in site order.
export const systemMachines=s=>s.machines.filter(m=>m.ssh?.probe).map(m=>({id:m.id,name:m.name,kind:m.ssh.probe}));
const clean=(v,n=300)=>typeof v==='string'?v.replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,n):'';
const num=v=>{const n=Number(v);return Number.isFinite(n)?n:null;};

// --- probe records -------------------------------------------------------------------------------
const decode=s=>s.replace(/\\x([0-9a-f]{2})/gi,(_,h)=>String.fromCharCode(parseInt(h,16)));
export function listenEntry(proc,user,addr){
 const m=/^(.*):(\d+|\*)$/.exec(addr||'');if(!m)return null;
 const host=m[1].replace(/^\[|\]$/g,''),port=num(m[2]);if(port==null)return null;
 const scope=['*','0.0.0.0','::',''].includes(host)?'all':/^(127\.|::1$|localhost$)/.test(host)?'loopback':'address';
 return {proc:clean(decode(proc||'?'),40)||'?',user:clean(user,32),host,port,scope};
}
// One machine's probe output → a plain record (no versions resolved yet).
export function parseSystemsProbe(text){
 const h={host:null,platform:null,user:null,root:false,collectedAt:null,os:{},hw:{},uptimeSeconds:null,
  osUpdates:{checked:false,items:[],error:null},autoUpdate:{},firewall:{},pf:null,fileVault:null,sip:null,gatekeeper:null,
  sshd:{allowUsers:[]},sharing:{},listening:[],software:{},running:{},brewOutdated:[],docker:[],
  truenasUpdate:null,apps:[],services:[],ftp:null,nft:null,errors:[],complete:false};
 let pendingLabel=null;const seen=new Set();
 for(const line of String(text||'').split('\n')){
  const f=line.split('\t'),t=f[0];
  if(t==='HOST')Object.assign(h,{host:clean(f[1],64),platform:f[2]==='Darwin'?'mac':f[2]==='Linux'?'linux':clean(f[2],20),user:clean(f[3],32),root:f[4]==='1',collectedAt:clean(f[5],30)||null});
  else if(t==='OS')h.os=h.platform==='mac'?{name:clean(f[1],40),version:clean(f[2],20),build:clean(f[3],20),kernel:clean(f[4],40),arch:clean(f[5],20)}
   :{name:clean(f[1],40),version:clean(f[2],20),base:clean(f[3],80),kernel:clean(f[4],60),arch:clean(f[5],20)};
  else if(t==='HW')h.hw={model:clean(f[1],60),cpu:clean(f[2],80),memBytes:num(f[3]),cpus:num(f[4])};
  else if(t==='UPTIME'){const v=num(f[1]);if(v!=null)h.uptimeSeconds=h.platform==='mac'?(h.collectedAt?Math.max(0,Math.round(Date.parse(h.collectedAt)/1000-v)):null):Math.round(v);}
  else if(t==='SWU_NONE')h.osUpdates={checked:true,items:[],error:null};
  else if(t==='SWU_ERR')h.osUpdates={checked:false,items:[],error:clean(f[1],200)};
  else if(t==='SWU'){h.osUpdates.checked=true;const s=clean(f[1],400);
   const label=/^\* Label:\s*(.*)$/.exec(s);if(label){pendingLabel=label[1];continue;}
   const kv=Object.fromEntries(s.split(/,\s*/).map(p=>p.split(/:\s*/)).filter(p=>p.length>=2).map(([k,...v])=>[k.toLowerCase(),v.join(':')]));
   if(kv.title)h.osUpdates.items.push({label:pendingLabel||kv.title,title:kv.title,version:kv.version||'',recommended:/yes/i.test(kv.recommended||''),restart:/restart/i.test(kv.action||'')});
   pendingLabel=null;}
  else if(t==='AUTO')h.autoUpdate[f[1]]=f[2]==='unset'?null:f[2];
  else if(t==='FW')h.firewall[f[1]]=f[2];
  else if(t==='PF')h.pf={status:clean(f[1],20).toLowerCase()||'unknown',rules:num(f[2])};
  else if(t==='FV')h.fileVault=/is on/i.test(f[1])?'on':/is off/i.test(f[1])?'off':'unknown';
  else if(t==='SIP')h.sip=/enabled/i.test(f[1])?'on':/disabled/i.test(f[1])?'off':'unknown';
  else if(t==='GK')h.gatekeeper=/enabled/i.test(f[1])?'on':/disabled/i.test(f[1])?'off':'unknown';
  else if(t==='SSHD'){const k=String(f[1]).toLowerCase(),v=clean(f[2],120);if(k==='allowusers')h.sshd.allowUsers.push(...v.split(/\s+/).filter(Boolean));else h.sshd[k]=v;}
  else if(t==='SHARE')h.sharing[clean(f[1],60)]=f[2]==='loaded';
  else if(t==='LISTEN'){const e=listenEntry(f[1],f[2],f[3]);if(e){const k=`${e.proc}|${e.host}|${e.port}`;if(!seen.has(k)){seen.add(k);h.listening.push(e);}}}
  else if(t==='SW'){const id=clean(f[1],60);(h.software[id]??=[]).push({kind:clean(f[2],20),value:clean(f[3],300),detail:clean(f[4],300),extra:clean(f[5],120)});}
  else if(t==='RUN')h.running[clean(f[1],60)]={state:f[2]==='absent'?'absent':f[2]==='loaded'?'loaded':'running',pid:num(f[2]),label:clean(f[3],120)};
  else if(t==='BREWOUT')h.brewOutdated.push({name:clean(f[1],80),installed:clean(f[2],80),latest:clean(f[3],80)});
  else if(t==='DOCKER')h.docker.push({name:clean(f[1],80),image:clean(f[2],160),status:clean(f[3],80),created:clean(f[4],40)||null});
  else if(t==='TNUPDATE')h.truenasUpdate={code:clean(f[1],30),train:clean(f[2],60),profile:clean(f[3],40),version:clean(f[4],30)||null,date:clean(f[5],20)||null,notes:clean(f[6],400)};
  else if(t==='APP')h.apps.push({name:clean(f[1],60),state:clean(f[2],20),version:clean(f[3],40),human:clean(f[4],60),upgrade:f[5]==='true',image:f[6]==='true',custom:f[7]==='true',train:clean(f[8],30),catalogApp:clean(f[9],60),latest:null,latestHuman:null});
  else if(t==='APPUP'){const a=h.apps.find(x=>x.name===f[1]);if(a){a.latest=clean(f[2],40)||null;a.latestHuman=clean(f[3],60)||null;}}
  else if(t==='SERVICE')h.services.push({name:clean(f[1],40),state:clean(f[2],20),enabled:f[3]==='true'});
  else if(t==='FTP')h.ftp={port:num(f[1]),tls:f[2]==='true',onlyAnonymous:f[3]==='true',onlyLocal:f[4]==='true'};
  // `NFT none <rules> <tables>`: the ruleset has no chain on the input hook at all. That is
  // "nothing filters ingress", represented explicitly (inputHooks:0), never as a policy named none.
  else if(t==='NFT'){if(f[1]==='unknown')h.nft={unknown:true};else{
   const inputPolicies=clean(f[1],80).split(/\s+/).filter(p=>p&&p!=='none').map(p=>{const [policy,count]=p.split(':');return {policy,chains:num(count)};}).filter(p=>/^[a-z]+$/.test(p.policy));
   h.nft={inputPolicies,inputHooks:inputPolicies.reduce((s,p)=>s+(p.chains??1),0),rules:num(f[2]),tables:clean(f[3],400).split(',').filter(Boolean)};}}
  else if(t==='ERROR')h.errors.push(clean(f[1],200));
  else if(t==='END'&&f[1]==='ok')h.complete=true;
 }
 return h;
}

// SPECS lines the macOS probe reads for one machine: "id|kind|arg1|arg2|launchd" (split on |).
const specField=v=>String(v??'').replace(/[|\r\n']/g,' ').trim();
export function systemsSpecs(registry,machine){
 const lines=[];
 for(const item of registry?.items||[]){const d=item.detect?.[machine];if(!d)continue;
  const [a,b]=d.kind==='brew'?[d.formula,'']:d.kind==='cask'?[d.cask,'']:d.kind==='app'?[d.path,'']:d.kind==='cmd'?[d.path,d.args]:d.kind==='pydist'?[d.glob,d.package]:d.kind==='json'?[d.path,d.key]:['',''];
  lines.push([item.id,d.kind,a,b,d.launchd].map(specField).join('|'));}
 return lines.join('\n');
}

// --- watched software rows ---------------------------------------------------------------------
const BREW='https://formulae.brew.sh';
function sourceOf(det,rec){
 if(det.source)return {label:clean(det.source.label,120),url:det.source.url||null};
 if(det.kind==='brew'){const f=rec?.detail||String(det.formula||'').split(',')[0],tap=rec?.extra||'';
  if(tap&&tap!=='homebrew/core'){const [user,repo]=tap.split('/');return {label:`Homebrew tap ${tap}`,url:`https://github.com/${user}/homebrew-${repo}`};}
  return {label:'Homebrew',url:`${BREW}/formula/${f}`};}
 if(det.kind==='cask')return {label:'Homebrew cask',url:`${BREW}/cask/${det.cask}`};
 return {label:det.kind,url:null};
}
// Installed version from the probe records of one item on one machine.
function installedOf(item,det,recs){
 const ok=(recs||[]).filter(r=>r.kind!=='missing'&&r.kind!=='unsupported');
 if(!ok.length)return {version:null,raw:null,path:(recs||[])[0]?.detail||null};
 if(det.kind==='pydist'){const best=ok.reduce((a,b)=>compareVersions(b.value,a.value)>0?b:a);return {version:best.value,raw:best.value,path:best.detail,others:ok.filter(r=>r!==best).map(r=>`${r.value} (${r.detail})`)};}
 if(det.kind==='cmd'){
  const parsed=ok.map(r=>({...r,version:extractVersion(r.value,det.match||item.match)}));
  const best=parsed.find(r=>r.extra==='running')||parsed.reduce((a,b)=>compareVersions(b.version,a.version)>0?b:a);
  return {version:best.version,raw:best.value,path:best.detail,others:parsed.filter(r=>r!==best).map(r=>`${r.version||'?'} (${r.detail})`)};
 }
 const r=ok[0];
 if(det.kind==='app')return {version:r.value,raw:r.value,build:r.extra||null,path:r.detail};
 return {version:r.value,raw:r.value,path:r.detail};
}
const LEGACY_BUILD=/^b?\d{4,}$/;
// installed vs upstream → status + human detail. scheme: llamacpp (bare build numbers predate
// semver releases) or node (odd major lines are short-lived, even lines compare within the line).
// A stale upstream (the last check failed, the value is from an earlier success) can still prove an
// update exists, but it cannot prove "current"/"ahead": those become 'unknown' (neověřeno).
export function versionStatus(args){
 const st=freshStatus(args),up=args.upstream;
 if(!up?.ok||!up.stale)return st;
 const since=up.checkedAt?` Poslední úspěšná kontrola ${String(up.checkedAt).slice(0,16).replace('T',' ')} UTC.`:'';
 const why=`Kontrola nejnovější verze selhala (${up.error||'chyba'}).${since}`;
 if(['current','ahead'].includes(st.status))return {...st,status:'unknown',note:`${why} Naposledy ${st.status==='current'?'aktuální':'novější než vydání'}.`};
 return {...st,note:[st.note,why].filter(Boolean).join(' ')};
}
function freshStatus({installed,build,scheme,upstream,up}){
 if(!installed)return {status:'missing',latest:null};
 if(!up||up.type==='none')return {status:'n/a',latest:null,note:up?.note||null};
 if(!upstream?.ok)return {status:'unknown',latest:upstream?.version||null,note:upstream?.error||'Nejnovější verzi se nepodařilo zjistit.'};
 let latest=upstream.version;
 if(scheme==='llamacpp'&&LEGACY_BUILD.test(installed)&&/\./.test(latest))return {status:'update',latest,note:`Nainstalovaný build ${installed.replace(/^b/,'')} je starší než první semver vydání.`};
 if(scheme==='node'&&upstream.latestByMajor){
  const major=parseVersion(installed)?.nums[0],lineLatest=upstream.latestByMajor[major],isLts=(upstream.ltsMajors||[]).includes(major);
  if(major%2===1||!isLts||!lineLatest){const c=compareVersions(installed,upstream.version);return {status:c<0?'update':c>0?'ahead':'current',latest:upstream.version,note:`Řada Node ${major} není LTS; aktuální LTS je ${upstream.version}.`};}
  latest=lineLatest;const c=compareVersions(installed,latest);
  return {status:c<0?'update':c>0?'ahead':'current',latest,note:major===upstream.ltsMajor?'Aktivní LTS řada.':`LTS řada ${major}; nejnovější LTS je ${upstream.version}.`};
 }
 let c=compareVersions(installed,latest);
 if(c===0&&build!=null&&upstream.build!=null)c=Math.sign(Number(build)-Number(upstream.build))||0;
 if(c==null)return {status:'unknown',latest,note:`Verze ${installed} a ${latest} nejdou porovnat.`};
 return {status:c<0?'update':c>0?'ahead':'current',latest};
}

function softwareRows(registry,machines,upstream){
 const rows=[];
 for(const item of registry.items||[])for(const [machine,det] of Object.entries(item.detect||{})){
  const host=machines[machine];if(!host)continue;
  const recs=host.software?.[item.id],inst=installedOf(item,det,recs),up=det.upstream||item.upstream;
  const res=upstream?.results?.[upstreamKey(up)]||null;
  const st=host.complete||recs?versionStatus({installed:inst.version,build:inst.build,scheme:item.scheme,upstream:res,up}):{status:'unknown',latest:null,note:'Stroj nebyl prozkoumán.'};
  const run=host.running?.[item.id];
  rows.push({id:item.id,name:item.name,category:item.category,machine,installed:inst.version,raw:inst.raw,build:inst.build||null,path:inst.path,others:inst.others||[],
   source:sourceOf(det,(recs||[]).find(r=>r.kind===det.kind)),latest:st.latest,latestUrl:res?.url||null,publishedAt:res?.publishedAt||null,upstreamType:up?.type||null,
   status:st.status,note:st.note||null,running:run?run.state:null,runLabel:run?.label||det.launchd||null,stale:Boolean(host.stale),
   // Inventory entries (data/knowledge.json ids) this row describes, when the id/name heuristic would miss them.
   inventory:Array.isArray(det.inventory)?det.inventory.filter(x=>typeof x==='string').map(x=>clean(x,80)).filter(Boolean).slice(0,10):[],
   // Upstream freshness, separate from the machine snapshot's `stale`.
   upstreamStale:Boolean(res?.stale||res&&!res.ok),upstreamError:res?.stale||res&&!res.ok?res.error||null:null,upstreamCheckedAt:res?.ok?res.checkedAt||null:null,upstreamFailedAt:res?.failedAt||null});
 }
 for(const [machine,host] of Object.entries(machines)){
  for(const a of host.apps||[])rows.push({id:`app:${a.name}`,name:a.name,category:'nas-apps',machine,installed:a.human||a.version,raw:a.version,path:null,others:[],
   source:a.custom?{label:'Vlastní aplikace (custom app)',url:null}:{label:`TrueNAS katalog · ${a.train||'?'}`,url:`https://apps.truenas.com/catalog/${a.catalogApp||a.name}/`},
   latest:a.upgrade?(a.latestHuman||a.latest):a.human,latestUrl:null,publishedAt:null,upstreamType:'truenas-app',
   status:a.upgrade?'update':'current',note:a.upgrade&&a.latestHuman===a.human?'Stejná verze aplikace, nový obraz kontejneru.':a.custom?'Vlastní aplikace: aktualizace = nový obraz.':null,
   running:a.state==='RUNNING'?'running':a.state==='STOPPED'?'absent':String(a.state||'').toLowerCase(),runLabel:a.state,stale:Boolean(host.stale)});
  for(const d of host.docker||[]){const [image,tag='latest']=d.image.split(/:(?=[^/]+$)/);
   rows.push({id:`docker:${d.name}`,name:d.name,category:'containers',machine,installed:tag,raw:d.image,path:null,others:[],
    source:{label:`Docker obraz ${image}`,url:image.includes('/')?`https://hub.docker.com/r/${image}`:`https://hub.docker.com/_/${image}`},
    latest:null,latestUrl:null,publishedAt:d.created,upstreamType:'docker',status:tag==='latest'?'floating':'n/a',
    note:tag==='latest'?`Plovoucí tag :latest, obraz z ${String(d.created||'?').slice(0,10)}; novější verze se pozná až podle digestu.`:null,running:/^Up/.test(d.status)?'running':'absent',runLabel:d.status,stale:Boolean(host.stale)});}
 }
 return rows;
}

// --- operating system --------------------------------------------------------------------------
function osSummary(host){
 if(host.platform==='linux'){const u=host.truenasUpdate;
  return {name:host.os.name||'TrueNAS',version:host.os.version||null,build:null,base:host.os.base||null,kernel:host.os.kernel||null,
   updates:u?.version?[{title:`TrueNAS ${u.version}`,version:u.version,date:u.date,notes:u.notes,kind:'minor',restart:true}]:[],
   status:u?u.version?'update':'current':'unknown',channel:u?.train||null};}
 const major=parseVersion(host.os.version||'')?.nums[0];
 // macOS in the same major line = minor (the one to install); another major = upgrade offer; Safari,
 // Command Line Tools and similar = app (listed, but they do not make the OS outdated).
 const updates=(host.osUpdates.items||[]).map(u=>{const v=parseVersion(u.version||'');const isOs=/^macos/i.test(u.title);
  return {title:u.title,version:u.version,recommended:u.recommended,restart:u.restart,kind:isOs?(v&&v.nums[0]!==major?'major':'minor'):'app'};});
 const status=!host.osUpdates.checked?'unknown':updates.some(u=>u.kind==='minor')?'update':updates.some(u=>u.kind==='major')?'major':'current';
 return {name:host.os.name||'macOS',version:host.os.version||null,build:host.os.build||null,kernel:host.os.kernel?`Darwin ${host.os.kernel}`:null,updates,status,error:host.osUpdates.error||null};
}

// --- host protection checks ---------------------------------------------------------------------
const check=(id,label,state,value,detail='')=>({id,label,state,value,detail});
function macChecks(host,os){
 const out=[],fw=num(host.firewall.global),a=host.autoUpdate,s=host.sshd;
 out.push(fw==null?check('firewall','Firewall (aplikační)','unknown','neověřeno'):fw===0?check('firewall','Firewall (aplikační)','warn','vypnutý','Příchozí spojení k aplikacím nic nefiltruje; spoléhá se na router.'):check('firewall','Firewall (aplikační)','ok',fw===2?'blokuje vše':'zapnutý',host.firewall.stealth==='on'?'Stealth mode zapnutý.':''));
 out.push(check('stealth','Stealth mode','info',host.firewall.stealth==='on'?'zapnutý':'vypnutý','Neodpovídá na ping a sondy zavřených portů.'));
 out.push(host.pf?.status==='unknown'||!host.pf?check('pf','Packet filter (pf)','unknown','neověřeno','pfctl potřebuje sudo.'):check('pf','Packet filter (pf)','info',host.pf.status==='enabled'?`zapnutý · ${host.pf.rules??'?'} pravidel`:'vypnutý','Výchozí kotvy Apple; vlastní pravidla žádná.'));
 out.push(check('filevault','FileVault (šifrování disku)',host.fileVault==='on'?'ok':host.fileVault==='off'?'crit':'unknown',host.fileVault==='on'?'zapnutý':host.fileVault==='off'?'vypnutý':'neověřeno'));
 out.push(check('sip','System Integrity Protection',host.sip==='on'?'ok':host.sip==='off'?'crit':'unknown',host.sip==='on'?'zapnutá':host.sip==='off'?'vypnutá':'neověřeno'));
 out.push(check('gatekeeper','Gatekeeper',host.gatekeeper==='on'?'ok':host.gatekeeper==='off'?'warn':'unknown',host.gatekeeper==='on'?'zapnutý':host.gatekeeper==='off'?'vypnutý':'neověřeno'));
 const sec=[a.CriticalUpdateInstall,a.ConfigDataInstall];
 out.push(check('security-responses','Automatické bezpečnostní opravy',sec.some(v=>v==='0')?'warn':'ok',sec.some(v=>v==='0')?'vypnuté':sec.every(v=>v==null)?'výchozí (zapnuté)':'zapnuté','Rapid Security Responses a systémové datové soubory.'));
 out.push(check('auto-macos','Automatická instalace macOS',a.AutomaticallyInstallMacOSUpdates==='1'?'ok':'info',a.AutomaticallyInstallMacOSUpdates==='1'?'zapnutá':'ručně',a.AutomaticDownload==='1'?'Stahování zapnuté.':''));
 const others=os.updates.filter(u=>u.kind!=='minor').map(u=>u.kind==='major'?`nabídka ${u.title}`:(u.title.includes(u.version)?u.title:`${u.title} ${u.version}`).trim());
 out.push(os.status==='update'?check('os-update','Aktualizace systému','warn',os.updates.filter(u=>u.kind==='minor').map(u=>u.title).join(', '),`Čeká instalace ve stejné hlavní verzi.${others.length?` Další: ${others.join(', ')}.`:''}`)
  :os.status==='major'?check('os-update','Aktualizace systému','info',`nabídka ${os.updates.filter(u=>u.kind==='major').map(u=>u.title).join(', ')}`,`Stejná řada je aktuální.${others.length>1?` Další: ${others.slice(1).join(', ')}.`:''}`)
  :os.status==='current'?check('os-update','Aktualizace systému','ok','aktuální'):check('os-update','Aktualizace systému','unknown','neověřeno',os.error||''));
 const pw=[s.passwordauthentication,s.kbdinteractiveauthentication];
 out.push(s.remotelogin==='off'?check('ssh-password','SSH přihlášení heslem','ok','SSH vypnuté')
  :pw.every(v=>v==null)?check('ssh-password','SSH přihlášení heslem','unknown','neověřeno','sshd -T potřebuje sudo.')
  :pw.some(v=>v==='yes')?check('ssh-password','SSH přihlášení heslem','warn','povolené',s.allowUsers.length?`Jen z adres v AllowUsers: ${[...new Set(s.allowUsers.map(x=>x.split('@')[1]||x))].join(', ')}.`:'Bez omezení AllowUsers.')
  :check('ssh-password','SSH přihlášení heslem','ok','jen klíče'));
 const shares=[['com.apple.screensharing','Sdílení obrazovky'],['com.apple.smbd','Sdílení souborů (SMB)'],['com.apple.RemoteDesktop.agent','Vzdálená správa (ARD)']].filter(([k])=>host.sharing[k]).map(([,l])=>l);
 out.push(check('sharing','Sdílení zapnuté',shares.length?'info':'ok',shares.length?shares.join(', '):'nic'));
 return out;
}
function nasChecks(host,os){
 // Snapshots written before inputHooks existed stored the probe's "none" as a policy; drop it.
 const out=[],pol=(host.nft?.inputPolicies||[]).filter(p=>p.policy!=='none'),s=host.sshd,ftp=host.services.find(x=>x.name==='ftp');
 out.push(host.nft?.unknown||!host.nft?check('firewall','Firewall (nftables)','unknown','neověřeno')
  :!pol.length?check('firewall','Firewall (nftables)','warn','vstup nefiltrován',`Žádný řetězec na vstupním hooku${host.nft.tables?.length?` (tabulky ${host.nft.tables.join(', ')})`:', ruleset je prázdný'}; příchozí provoz nic nefiltruje, spoléhá se na router.`)
  :pol.some(p=>['drop','reject'].includes(p.policy))?check('firewall','Firewall (nftables)','ok',pol.map(p=>p.policy).join(', '))
  :check('firewall','Firewall (nftables)','warn','vstup povolen (accept)',`Jen pravidla Dockeru a tabulky ${host.nft.tables.filter(t=>!/^ip6? (nat|filter|raw)$/.test(t)).join(', ')||'—'}; TrueNAS vlastní firewall nemá.`));
 out.push(ftp?.state==='RUNNING'?check('ftp','FTP',host.ftp?.tls?'info':'warn',host.ftp?.tls?'zapnuté (TLS)':'zapnuté bez šifrování',`Port ${host.ftp?.port??21} na všech rozhraních${host.ftp?.onlyAnonymous?', jen anonymně':host.ftp?.onlyLocal?', jen místní účty':', místní účty s heslem'}.`)
  :check('ftp','FTP','ok','vypnuté'));
 out.push(!s.passwordauthentication?check('ssh-password','SSH přihlášení heslem','unknown','neověřeno'):[s.passwordauthentication,s.kbdinteractiveauthentication].includes('yes')?check('ssh-password','SSH přihlášení heslem','warn','povolené'):check('ssh-password','SSH přihlášení heslem','ok','jen klíče'));
 out.push(check('ssh-root','SSH jako root','info',s.permitrootlogin==='no'?'zakázáno':s.permitrootlogin==='without-password'||s.permitrootlogin==='prohibit-password'?'jen klíčem':s.permitrootlogin||'?'));
 out.push(check('ssh-forwarding','SSH přesměrování portů',s.allowtcpforwarding==='no'?'ok':'info',s.allowtcpforwarding==='no'?'zakázáno':s.allowtcpforwarding||'?'));
 out.push(os.status==='update'?check('os-update','Aktualizace TrueNAS','warn',os.updates[0]?.version||'?',(/CVE|security/i.test(os.updates[0]?.notes||'')?'Bezpečnostní vydání: ':'')+(os.updates[0]?.notes||'').slice(0,240))
  :os.status==='current'?check('os-update','Aktualizace TrueNAS','ok','aktuální'):check('os-update','Aktualizace TrueNAS','unknown','neověřeno'));
 const shares=host.services.filter(x=>x.state==='RUNNING'&&['cifs','nfs','iscsitarget','webdav','rsync','snmp'].includes(x.name)).map(x=>({cifs:'SMB',nfs:'NFS',iscsitarget:'iSCSI'})[x.name]||x.name.toUpperCase());
 out.push(check('sharing','Sdílení zapnuté',shares.length?'info':'ok',shares.join(', ')||'nic'));
 return out;
}

// --- payload ------------------------------------------------------------------------------------
export function buildSystems({snapshot,upstream,registry,machines:probed=systemMachines(loadedSite()),now=Date.now()}){
 const machines=snapshot?.machines||{};
 const software=softwareRows(registry||{items:[]},machines,upstream);
 const out=probed.map(m=>{
  const host=machines[m.id];
  if(!host)return {...m,reachable:false,stale:false,error:'Zatím neprozkoumáno.',os:null,checks:[],listening:[],brewOutdated:[],summary:null};
  const os=osSummary(host),checks=host.platform==='linux'?nasChecks(host,os):macChecks(host,os);
  const exposed=host.listening.filter(l=>l.scope!=='loopback');
  checks.push(check('exposed','Porty otevřené do sítě',exposed.length?'info':'ok',`${new Set(exposed.map(l=>l.port)).size} portů`,[...new Set(exposed.map(l=>`${l.port} ${l.proc}`))].sort((x,y)=>parseInt(x)-parseInt(y)).slice(0,40).join(' · ')));
  const rows=software.filter(r=>r.machine===m.id);
  const count=(list,st)=>list.filter(x=>x.state===st).length;
  return {...m,reachable:Boolean(host.complete),stale:Boolean(host.stale),error:host.lastError||(host.errors||[])[0]||null,collectedAt:host.collectedAt,
   hw:{model:host.hw.model||null,cpu:host.hw.cpu||null,ramGb:host.hw.memBytes?Math.round(host.hw.memBytes/1e9):null,cpus:host.hw.cpus},uptimeSeconds:host.uptimeSeconds,
   os,checks,listening:host.listening,brewOutdated:host.brewOutdated||[],
   summary:{osUpdate:os.status==='update'?1:0,softwareUpdates:rows.filter(r=>r.status==='update'&&!['nas-apps','containers'].includes(r.category)).length,
    appUpdates:rows.filter(r=>r.status==='update'&&r.category==='nas-apps').length,unknown:rows.filter(r=>['unknown'].includes(r.status)).length,
    checks:{ok:count(checks,'ok'),warn:count(checks,'warn'),crit:count(checks,'crit'),info:count(checks,'info'),unknown:count(checks,'unknown')}}};
 });
 const times=out.map(m=>m.collectedAt).filter(Boolean).sort();
 return {schemaVersion:SYSTEMS_SCHEMA,generatedAt:new Date(now).toISOString(),collectedAt:snapshot?.collectedAt||times.at(-1)||null,oldestCollectedAt:times[0]||null,
  collectedFrom:snapshot?.collectedFrom||null,upstreamCheckedAt:upstream?.checkedAt||null,
  upstreamFailed:Object.values(upstream?.results||{}).filter(r=>r&&(r.stale||!r.ok)).length,categories:{...(registry?.categories||{}),'nas-apps':'Aplikace na NAS','containers':'Kontejnery (Docker)'},
  machines:out,software};
}

export async function loadSystems(directory,{registryFile=softwareWatchPath(),site=loadedSite()}={}){
 const dir=process.env.SYSTEMS_DIR||path.join(directory,'systems');
 let snapshot;try{snapshot=JSON.parse(await readFile(path.join(dir,'snapshot.json'),'utf8'));}catch{return null;}
 const upstream=await readFile(path.join(dir,'upstream.json'),'utf8').then(JSON.parse).catch(()=>null);
 const registry=JSON.parse(await readFile(registryFile,'utf8'));
 return buildSystems({snapshot,upstream,registry,machines:systemMachines(site)});
}
