// Linux telemetry without anything installed by the hub. Two sources, one meaning:
//   node-exporter  the recommended one: the hub reads Prometheus Node Exporter's /metrics (default port 9100)
//                  directly, one scrape per poll. No Prometheus server is needed. Plain HTTP on the LAN without
//                  credentials, or HTTPS (Node Exporter's own --web.config.file) verified by the CA store and
//                  hostname or by a pinned certificate, optionally with Basic credentials (only over verified HTTPS).
//   linux-ssh      agent-less: the hub signs in with its own key (the app-managed SSH of server/windows-ssh.mjs)
//                  and runs one fixed, read-only POSIX shell script that reads /proc, /sys and df. No sudo, no
//                  Python, no package, nothing written on the machine.
// Both become the same snapshot (cumulative counters with the source's own clock), and a reading is the
// difference between two snapshots of one connection (server/telemetry-poller.mjs):
//   CPU     busy share of all CPUs and per logical CPU: 1 − Δ(idle + iowait) / Δ(all modes but guest)
//   memory  MemTotal − MemAvailable (MemFree + Buffers + Cached on kernels without MemAvailable); swap used
//   disks   bytes read / written per second, summed over whole physical disks (sd*, vd*, xvd*, hd*, nvme*n*,
//           mmcblk*; partitions, device-mapper, md, loop and zram are left out, so nothing is counted twice)
//   network bytes per second received / sent, summed over interfaces that are not loopback, bridges, veth,
//           container, tunnel or VPN interfaces (those carry traffic already counted on a physical one)
//   volumes local block filesystems (ext2/3/4, xfs, btrfs, zfs, f2fs, vfat, exfat, ntfs, fuseblk, …), one per device
//           and one per ZFS pool (its datasets share the pool's space); never summed into a "disk capacity"
//   sensors hwmon temperatures when the machine reports them (CPU = coretemp/k10temp/zenpower/cpu_thermal), else
//           null; GPU and power: not measured (null, never 0)
// Nothing between two snapshots is invented: the first snapshot, one after a failure, a gap longer than five
// minutes, a reboot (boot time moved) or a counter that went backwards (reset, wrap) gives no rate for it.
import {createHash} from 'node:crypto';
import {parsePromText} from './prom-text.mjs';
import {endpointRequest,validEndpointHost,validEndpointPort,CERT_PIN} from './endpoint-http.mjs';
import {runSsh,managedArgs,classifySsh,validSshHost,validSshPort,validStorePath,KEY_ID,CONN_ID,WINDOWS_TIMEOUT_MS} from './windows-telemetry.mjs';

export const NODE_EXPORTER_PROVIDER='node-exporter',LINUX_SSH_PROVIDER='linux-ssh';
export const NODE_EXPORTER_NAME='Linux (Node Exporter)',LINUX_SSH_NAME='Linux (SSH)';
export const NODE_EXPORTER_PORT=9100;
export const LINUX_MAX_SPAN_SECONDS=300;
const fail=code=>{throw new Error(code);};

// --- what may be set in the web UI ---------------------------------------------------------------------
// A POSIX account name as useradd accepts it by default: a letter or underscore first, then letters, digits,
// ".", "_" or "-", at most 32. Never "-" first (ssh option), never a shell or ssh character.
export const UNIX_USER=/^[A-Za-z_][A-Za-z0-9._-]{0,31}$/;
export const validUnixUser=u=>typeof u==='string'&&UNIX_USER.test(u);
// Basic credentials of a Node Exporter web config: a user without ":" (Basic syntax) and a password of 8 to 72
// bytes (bcrypt, which Node Exporter's basic_auth_users uses, reads no further). Never control characters.
export const validBasicUser=u=>typeof u==='string'&&/^[A-Za-z0-9._@-]{1,64}$/.test(u);
export const validExporterPassword=p=>typeof p==='string'&&p.length>=1&&Buffer.byteLength(p,'utf8')<=72&&!/[\u0000-\u001f\u007f]/.test(p);
const validTrust=t=>Boolean(t&&typeof t==='object'&&(t.mode==='ca'||t.mode==='pin'&&CERT_PIN.test(t.pin||'')));
// A stored Node Exporter connection (state/home/telemetry-hosts.json, 0600).
export const validExporterRecord=r=>Boolean(r&&typeof r==='object'&&r.mode===NODE_EXPORTER_PROVIDER&&validEndpointHost(r.host)&&validEndpointPort(r.port)&&
 (r.scheme==='http'?r.tls==null&&r.user==null&&r.password==null:r.scheme==='https'&&validTrust(r.tls)&&(r.user==null?r.password==null:validBasicUser(r.user)&&validExporterPassword(r.password))));
const HOST_KEY_TYPE=/^(ssh-ed25519|ecdsa-sha2-nistp(256|384|521)|ssh-rsa)$/,B64=/^[A-Za-z0-9+/]{16,4096}={0,2}$/,FP=/^SHA256:[A-Za-z0-9+/]{43}$/;
// A stored Linux SSH connection: the app-managed record of server/windows-ssh.mjs with os "linux" and a POSIX user.
export const validLinuxManaged=m=>Boolean(m&&typeof m==='object'&&m.mode==='managed'&&m.os==='linux'&&validSshHost(m.host)&&validSshPort(m.port)&&validUnixUser(m.user)&&
 KEY_ID.test(m.keyId||'')&&CONN_ID.test(m.connId||'')&&m.hostKey&&HOST_KEY_TYPE.test(m.hostKey.type||'')&&B64.test(m.hostKey.key||'')&&FP.test(m.hostKey.fingerprint||'')&&FP.test(m.keyFingerprint||''));
const secretTag=p=>p?createHash('sha256').update('home-hub-telemetry\u0000'+p).digest('hex').slice(0,16):'';
export const exporterLabel=r=>`${r.scheme}://${r.host}:${r.port}`;
export const linuxSshLabel=m=>`${m.user}@${m.host}${m.port!==22?`:${m.port}`:''}`;

// --- error codes, one sentence each (English in public/i18n-en-home.js) -----------------------------------
export const NODE_EXPORTER_ERRORS=Object.freeze({
 refused:'Na tom portu nic nepřijímá spojení. Běží Node Exporter (služba prometheus-node-exporter nebo node_exporter) a pouští ho firewall z adresy Home Hubu?',
 unresolved:'Jméno hostitele se ze serveru s Home Hubem nedá přeložit. Zadej IP adresu nebo jméno, které zná tvoje DNS.',
 timeout:'Node Exporter neodpověděl včas. Stroj může spát nebo být mimo síť, nebo port blokuje firewall.',
 unreachable:'Stroj není v síti k zastižení. To neznamená, že je vypnutý.',
 'tls-untrusted':'Certifikát Node Exporteru neověřila žádná autorita, které Home Hub věří. Použij připnutí otisku certifikátu, nebo certifikát od důvěryhodné autority.',
 'tls-hostname':'Certifikát Node Exporteru nepatří k tomuhle jménu hostitele. Zadej jméno z certifikátu, nebo použij připnutí otisku.',
 'tls-pin':'Node Exporter ukázal jiný certifikát, než jaký jsi potvrdil. Mohl být obnovený, ale může jít i o podvržený stroj. Načti certifikát znovu a porovnej otisk na stroji; do té doby Home Hub nic nepošle.',
 tls:'Spojení TLS s Node Exporterem selhalo. Je na tom portu opravdu HTTPS?',
 denied:'Node Exporter odmítl přihlášení. Zkontroluj uživatele a heslo v jeho web configu (basic_auth_users).',
 'needs-auth':'Node Exporter chce přihlášení. Zadej uživatele a heslo z jeho web configu (jde to jen přes ověřené HTTPS).',
 redirect:'Endpoint odpověděl přesměrováním. Home Hub přesměrování nesleduje; zadej přímo adresu a port Node Exporteru.',
 'not-exporter':'Na tomhle portu neběží /metrics Node Exporteru. Je port správný?',
 http:'Endpoint odpověděl chybou HTTP. Je to opravdu Node Exporter?',
 encoded:'Endpoint poslal komprimovanou odpověď, i když o ni Home Hub nežádal. Je to opravdu Node Exporter?',
 'too-large':'Odpověď /metrics byla nečekaně velká a byla zahozena. Nejsou zapnuté kolektory, které vypíšou tisíce řad?',
 'bad-output':'Odpověď není textový formát Prometheus metrik. Je to opravdu Node Exporter?',
 'no-metrics':'Endpoint odpovídá, ale bez metrik CPU a paměti Node Exporteru. Jsou vypnuté výchozí kolektory cpu a meminfo?',
 'is-prometheus':'Na tomhle portu běží server Prometheus (jeho vlastní /metrics), ne Node Exporter. Pro Node Exporter zadej jeho port (obvykle 9100), nebo zvol Linux (Prometheus).',
 'plain-http':'Na tomhle portu běží HTTPS. Zvol HTTPS a ověř certifikát.',
 busy:'Právě běží jiné zkoušky spojení. Zkus to za chvíli.',unavailable:'Telemetrie Linuxu teď neodpovídá.'});
export const LINUX_SSH_ERRORS=Object.freeze({
 'host-key-unknown':'Klíč hostitele Linuxu není pro tohle spojení ověřený. V Upravit zařízení → Telemetrie načti klíč hostitele, porovnej jeho otisk s tím na stroji a potvrď ho. Home Hub neznámý klíč nikdy nepřijme sám.',
 'host-key-changed':'Klíč hostitele Linuxu se liší od ověřeného. Systém mohl být přeinstalovaný, ale může jít i o podvržený stroj. Porovnej nový otisk na stroji a ověř ho znovu; do té doby se Home Hub nepřipojí.',
 denied:'Linux nepřijal klíč Home Hubu. Zkontroluj uživatele a to, že je veřejný klíč v ~/.ssh/authorized_keys toho účtu a soubor má práva 600 (adresář .ssh 700).',
 unresolved:'Jméno hostitele se ze serveru s Home Hubem nedá přeložit. Zadej IP adresu nebo jméno, které zná tvoje DNS.',
 refused:'Linux odmítl spojení na port SSH. Běží sshd, poslouchá na tomhle portu a pouští ho firewall?',
 timeout:'Spojení vypršelo. Stroj může spát nebo být mimo síť, nebo port SSH blokuje firewall.',
 unreachable:'Stroj není v síti k zastižení. To neznamená, že je vypnutý.',
 'ssh-config':'Klient SSH na serveru s Home Hubem odmítl nastavení nebo práva souborů úložiště klíčů Home Hubu. Zkontroluj práva adresáře se stavem.',
 ssh:'SSH spojení selhalo z neznámého důvodu. Vyzkoušej spojení znovu; když to trvá, zkontroluj na stroji službu sshd.',
 'no-ssh':'Na serveru s Home Hubem chybí klientské nástroje OpenSSH (ssh a ssh-keyscan). Nainstaluj OpenSSH Client: ve Windows volitelná funkce OpenSSH Client, v Linuxu balíček openssh-client (nebo openssh); macOS je má.',
 'no-keyscan':'Na serveru s Home Hubem chybí ssh-keyscan z klientských nástrojů OpenSSH, takže Home Hub nenačte klíč hostitele. Nainstaluj celý OpenSSH Client.',
 'no-host-key':'Stroj nevrátil žádný klíč hostitele, který by Home Hub přijal. Běží na tom portu sshd?',
 'key-missing':'Soukromý klíč tohoto spojení na serveru s Home Hubem chybí (třeba po obnově zálohy bez něj). Vytvoř nebo naimportuj klíč znovu v Upravit zařízení → Telemetrie.',
 'key-permissions':'Klient SSH odmítl soukromý klíč kvůli jeho právům. Home Hub ukládá klíče čitelné jen pro sebe; zkontroluj, že se práva adresáře se stavem nezměnila (třeba obnovou zálohy).',
 'no-shell':'Přihlášení prošlo, ale účet nemá použitelný shell (třeba /usr/sbin/nologin), nebo na stroji chybí /bin/sh. Účet pro Home Hub potřebuje běžný shell.',
 collector:'Přihlášení prošlo, ale skript, který jen čte /proc a /sys, neskončil správně. Je cíl opravdu Linux?',
 'bad-output':'Stroj odpověděl, ale ne očekávanými daty. Je cíl opravdu Linux (s /proc)?',
 'no-metrics':'Stroj odpověděl, ale /proc/stat nebo /proc/meminfo nejde přečíst.',
 'too-large':'Odpověď stroje byla nečekaně velká a byla zahozena.',
 spawn:'Klienta SSH nejde na serveru s Home Hubem spustit.',busy:'Právě běží jiné zkoušky spojení. Zkus to za chvíli.',unavailable:'Telemetrie Linuxu teď neodpovídá.'});

// --- the snapshot -----------------------------------------------------------------------------------------
const PHYSICAL_DISK=/^(sd[a-z]+|hd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/;
const VIRTUAL_NET=/^(lo|veth|docker|br-|br\d|virbr|vnet|cni|flannel|cali|kube-|tun|tap|wg|tailscale|zt|vxlan|genev|lxc|lxd|podman|cilium|ip6tnl|sit|gre|dummy|bond_slave)/;
const LOCAL_FS=new Set(['ext2','ext3','ext4','xfs','btrfs','zfs','f2fs','vfat','exfat','ntfs','ntfs3','fuseblk','jfs','reiserfs','bcachefs','hfsplus','apfs']);
const CPU_CHIPS=/^(coretemp|k10temp|zenpower|cpu_thermal|cpu-thermal|soc_thermal|cpu)$/;
const GPU_CHIPS=/^(amdgpu|radeon|nouveau)$/;
const clean=(v,n=120)=>typeof v==='string'?v.replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,n):null;
const fin=v=>typeof v==='number'&&Number.isFinite(v)?v:null;
const nonNeg=v=>fin(v)!=null&&v>=0?v:null;
// The parts both sources fill, then normalised the same way: volumes filtered and de-duplicated, temperatures bounded.
function finish(s){
 // One entry per storage: a device mounted twice (bind mounts, btrfs subvolumes) counts once, and every ZFS dataset
 // of a pool shares that pool's free space, so a pool counts once too: its least nested dataset (the root dataset
 // when it is mounted), labelled with the pool. Sizes are never added up across datasets or mounts.
 const seen=new Set(),volumes=[];
 const group=v=>v.fs==='zfs'?`zfs:${v.device.split('/')[0]}`:v.device;
 const depth=v=>v.fs==='zfs'?v.device.split('/').length:0;
 for(const v of s.volumes.filter(v=>LOCAL_FS.has(v.fs)&&v.size>0).sort((a,b)=>depth(a)-depth(b)||a.mount.length-b.mount.length)){
  const g=group(v);if(seen.has(g))continue;seen.add(g);volumes.push(v.fs==='zfs'?{...v,pool:v.device.split('/')[0]}:v);if(volumes.length>=12)break;}
 const temps=s.temps.filter(x=>fin(x.c)!=null&&x.c>-60&&x.c<200).slice(0,24);
 const pick=re=>{const chip=temps.filter(x=>re.test(x.chip||''));if(!chip.length)return null;
  const main=chip.find(x=>/^(Package id 0|Tctl|Tdie|edge)$/i.test(x.label||''));return main?main.c:Math.max(...chip.map(x=>x.c));};
 return {...s,volumes:volumes.sort((a,b)=>a.mount.localeCompare(b.mount)),temps,cpuTemp:pick(CPU_CHIPS),gpuTemp:pick(GPU_CHIPS)};
}

// The Node Exporter metrics the hub reads; everything else in /metrics is skipped unread.
export const EXPORTER_METRICS=Object.freeze(['node_cpu_seconds_total','node_memory_MemTotal_bytes','node_memory_MemAvailable_bytes','node_memory_MemFree_bytes',
 'node_memory_Buffers_bytes','node_memory_Cached_bytes','node_memory_SwapTotal_bytes','node_memory_SwapFree_bytes','node_load1','node_load5','node_load15',
 'node_filesystem_size_bytes','node_filesystem_free_bytes','node_filesystem_avail_bytes','node_disk_read_bytes_total','node_disk_written_bytes_total',
 'node_network_receive_bytes_total','node_network_transmit_bytes_total','node_boot_time_seconds','node_time_seconds','node_uname_info','node_os_info',
 'node_cpu_info','node_hwmon_temp_celsius','node_hwmon_sensor_label','node_hwmon_chip_names','node_thermal_zone_temp']);
const WANTED=new Set(EXPORTER_METRICS);
// Parsed metrics (prom-text.mjs) → a snapshot. receivedAt: the hub's clock (ms) when the reply arrived, the
// clock of last resort when the exporter does not send node_time_seconds.
// clockSeconds: the samples' own time when the caller knows it (a Prometheus scrape timestamp); it wins over both.
export function snapshotFromMetrics(metrics,receivedAt=Date.now(),{clockSeconds=null,source=NODE_EXPORTER_PROVIDER}={}){
 const all=n=>metrics.get(n)||[],one=n=>fin(all(n)[0]?.value);
 const cpu=new Map();
 for(const s of all('node_cpu_seconds_total')){
  const id=s.labels.cpu,mode=s.labels.mode;if(!/^\d{1,4}$/.test(id||'')||!/^[a-z_]{1,20}$/.test(mode||'')||s.value<0||/^guest/.test(mode))continue;// guest time is already inside user and nice
  const c=cpu.get(id)||{idle:0,total:0};c.total+=s.value;if(mode==='idle'||mode==='iowait')c.idle+=s.value;cpu.set(id,c);
 }
 if(cpu.size>4096)fail('bad-output');
 if(cpu.size){const t={idle:0,total:0};for(const c of cpu.values()){t.idle+=c.idle;t.total+=c.total;}cpu.set('all',t);}
 const memTotal=one('node_memory_MemTotal_bytes');
 const memAvail=one('node_memory_MemAvailable_bytes')??(()=>{const f=one('node_memory_MemFree_bytes'),b=one('node_memory_Buffers_bytes'),c=one('node_memory_Cached_bytes');return f!=null&&b!=null&&c!=null?f+b+c:null;})();
 const fsBy=(name)=>new Map(all(name).map(s=>[`${s.labels.device}\u0000${s.labels.mountpoint}`,s.value]));
 const free=fsBy('node_filesystem_free_bytes'),avail=fsBy('node_filesystem_avail_bytes');
 const volumes=all('node_filesystem_size_bytes').slice(0,2000).map(s=>{const k=`${s.labels.device}\u0000${s.labels.mountpoint}`;
  return {mount:clean(s.labels.mountpoint,200),device:clean(s.labels.device,200),fs:clean(s.labels.fstype,24),size:nonNeg(s.value),free:nonNeg(free.get(k)),avail:nonNeg(avail.get(k))};}).filter(v=>v.mount&&v.device&&v.fs);
 const counters=(rx,tx,filter)=>{const m=new Map();for(const [name,key] of [[rx,'a'],[tx,'b']])for(const s of all(name)){const d=s.labels.device;if(!filter(d||'')||s.value<0)continue;const e=m.get(d)||{a:null,b:null};e[key]=s.value;m.set(d,e);}
  return new Map([...m].slice(0,256).map(([d,e])=>[d,{read:e.a,write:e.b}]));};
 const disks=counters('node_disk_read_bytes_total','node_disk_written_bytes_total',d=>PHYSICAL_DISK.test(d));
 const net=new Map([...counters('node_network_receive_bytes_total','node_network_transmit_bytes_total',d=>/^[A-Za-z0-9._@-]{1,32}$/.test(d)&&!VIRTUAL_NET.test(d))].map(([d,e])=>[d,{rx:e.read,tx:e.write}]));
 const uname=all('node_uname_info')[0]?.labels||{},osInfo=all('node_os_info')[0]?.labels||{};
 const chipNames=new Map(all('node_hwmon_chip_names').map(s=>[s.labels.chip,s.labels.chip_name]));
 const labels=new Map(all('node_hwmon_sensor_label').map(s=>[`${s.labels.chip}\u0000${s.labels.sensor}`,s.labels.label]));
 let temps=all('node_hwmon_temp_celsius').slice(0,64).map(s=>({chip:clean(chipNames.get(s.labels.chip)||String(s.labels.chip||'').replace(/^platform_|_\d+$/g,''),40),label:clean(labels.get(`${s.labels.chip}\u0000${s.labels.sensor}`)||s.labels.sensor,40),c:s.value}));
 if(!temps.length)temps=all('node_thermal_zone_temp').slice(0,16).map(s=>({chip:clean(s.labels.type,40),label:clean(`zone ${s.labels.zone}`,40),c:s.value}));
 const now=one('node_time_seconds'),boot=one('node_boot_time_seconds');
 const clock=Number.isFinite(clockSeconds)&&clockSeconds>0?clockSeconds:now!=null&&now>0?now:receivedAt/1000;
 const load=['node_load1','node_load5','node_load15'].map(one);
 return finish({source,t:Math.round(clock*1000),clock,
  os:{name:clean(osInfo.pretty_name||osInfo.name||uname.sysname||null,80),kernel:clean(uname.release||null,60),arch:clean(uname.machine||null,20),
   bootUnix:boot!=null&&boot>0?Math.round(boot):null,uptimeSeconds:boot!=null&&boot>0?Math.max(0,Math.round(clock-boot)):null},
  cpuName:clean(all('node_cpu_info')[0]?.labels?.model_name||null,80),cpu,
  mem:{total:nonNeg(memTotal),available:nonNeg(memAvail),swapTotal:nonNeg(one('node_memory_SwapTotal_bytes')),swapFree:nonNeg(one('node_memory_SwapFree_bytes'))},
  load:load.every(v=>v!=null)?load:null,volumes,disks,net,temps});
}

// The SSH collector: one line of POSIX sh, run as /bin/sh -c '…' whatever the account's login shell is (bash,
// zsh, fish, csh: the script holds no single quote, no backslash, no "!" and no line break). It only reads:
// /proc/uptime, /proc/stat, /proc/meminfo, /proc/loadavg, /proc/diskstats, /proc/net/dev, /proc/mounts,
// /etc/os-release, /proc/cpuinfo, uname, df -P -k (under `timeout 5` when the system has it, so a hung network
// mount cannot hold the poll) and the hwmon temperatures in /sys/class/hwmon. Every list is capped by head.
const SECTIONS=[
 'echo HHLNX1','echo @t;date +%s','echo @uptime;cat /proc/uptime','echo @stat;grep "^cpu" /proc/stat|head -n 1100',
 'echo @mem;grep -E "^(MemTotal|MemAvailable|MemFree|Buffers|Cached|SwapTotal|SwapFree):" /proc/meminfo','echo @load;cat /proc/loadavg',
 'echo @disk;head -n 400 /proc/diskstats','echo @net;head -n 260 /proc/net/dev','echo @mounts;head -n 2000 /proc/mounts',
 'echo @df;if command -v timeout >/dev/null 2>&1;then timeout 5 df -P -k;else df -P -k;fi|head -n 2000',
 'echo @os;grep -E "^(PRETTY_NAME|NAME)=" /etc/os-release|head -n 2;uname -r;uname -m',
 'echo @cpuinfo;grep -E "^(model name|Hardware|Model)[[:space:]]*:" /proc/cpuinfo|head -n 3',
 'echo @hwmon;for d in /sys/class/hwmon/hwmon*;do [ -r "$d/name" ]||continue;n=$(cat "$d/name");for f in "$d"/temp*_input;do [ -r "$f" ]||continue;l="";[ -r "${f%_input}_label" ]&&l=$(cat "${f%_input}_label");echo "$n|${f##*/}|$l|$(cat "$f")";done;done|head -n 64',
 'echo @end'];
export const LINUX_SCRIPT=SECTIONS.map(s=>`{ ${s};} 2>/dev/null`).join(';');
// env, not VAR=value: csh and tcsh login shells do not know that syntax.
export const LINUX_REMOTE_COMMAND=`env LC_ALL=C /bin/sh -c '${LINUX_SCRIPT}'`;
const MARK='HHLNX1';
const unoct=s=>s.replace(/\\([0-7]{3})/g,(_,o)=>String.fromCharCode(parseInt(o,8)));
const int=v=>/^\d{1,19}$/.test(v||'')&&Number.isSafeInteger(Number(v))?Number(v):null;
// The script's output → a snapshot. No marker, or no /proc/stat and /proc/meminfo at all: 'bad-output' / 'no-metrics'.
export function parseLinuxOutput(text){
 const lines=String(text??'').split(/\r?\n/);
 const start=lines.indexOf(MARK);if(start<0)fail('bad-output');
 const sec=new Map();let cur=null;
 for(const line of lines.slice(start+1,start+12000)){if(/^@[a-z]+$/.test(line)){cur=line.slice(1);sec.set(cur,[]);continue;}if(cur)sec.get(cur).push(line);}
 if(!sec.has('end'))fail('bad-output');
 const get=k=>sec.get(k)||[];
 const cpu=new Map();
 for(const l of get('stat')){const p=l.trim().split(/\s+/);const m=/^cpu(\d{0,4})$/.exec(p[0]);if(!m)continue;
  const f=p.slice(1,9).map(int);if(f.length<4||f.slice(0,4).some(v=>v==null))continue;const v=f.map(x=>x??0);
  cpu.set(m[1]===''?'all':m[1],{idle:v[3]+v[4],total:v.reduce((a,b)=>a+b,0)});}
 const mem={};for(const l of get('mem')){const m=/^(\w+):\s+(\d{1,15})\s*kB$/.exec(l.trim());if(m)mem[m[1]]=Number(m[2])*1024;}
 if(!cpu.has('all')&&mem.MemTotal==null)fail('no-metrics');
 const up=Number(get('uptime')[0]?.split(/\s+/)[0]),now=int(get('t')[0]?.trim());
 const loadParts=(get('load')[0]||'').trim().split(/\s+/).slice(0,3).map(Number);
 const disks=new Map();
 for(const l of get('disk')){const p=l.trim().split(/\s+/);if(p.length<10||!PHYSICAL_DISK.test(p[2]))continue;const r=int(p[5]),w=int(p[9]);if(r==null||w==null)continue;disks.set(p[2],{read:r*512,write:w*512});}
 const net=new Map();
 for(const l of get('net')){const m=/^\s*([^:\s]{1,32}):\s*(.*)$/.exec(l);if(!m||VIRTUAL_NET.test(m[1])||!/^[A-Za-z0-9._@-]+$/.test(m[1]))continue;const f=m[2].trim().split(/\s+/);const rx=int(f[0]),tx=int(f[8]);if(rx==null||tx==null)continue;net.set(m[1],{rx,tx});}
 const types=new Map();for(const l of get('mounts')){const p=l.split(' ');if(p.length>=3)types.set(unoct(p[1]),{fs:p[2],device:unoct(p[0])});}
 const volumes=[];
 for(const l of get('df').slice(1)){const p=l.trim().split(/\s+/);if(p.length<6)continue;const size=int(p[1]),used=int(p[2]),avail=int(p[3]);const mount=p.slice(5).join(' ');const t=types.get(mount);
  if(size==null||used==null||!t||!mount.startsWith('/'))continue;volumes.push({mount:clean(mount,200),device:clean(t.device,200),fs:clean(t.fs,24),size:size*1024,free:Math.max(0,size-used)*1024,avail:avail!=null?avail*1024:null});}
 const os=get('os'),pretty=os.map(l=>/^PRETTY_NAME="?([^"]*)"?$/.exec(l)?.[1]).find(Boolean)||os.map(l=>/^NAME="?([^"]*)"?$/.exec(l)?.[1]).find(Boolean)||null;
 const rest=os.filter(l=>!/^(PRETTY_NAME|NAME)=/.test(l));
 const cpuName=get('cpuinfo').map(l=>/:\s*(.+)$/.exec(l)?.[1]).find(Boolean)||null;
 const temps=get('hwmon').map(l=>l.split('|')).filter(p=>p.length===4).map(([chip,sensor,label,v])=>({chip:clean(chip,40),label:clean(label||sensor.replace(/_input$/,''),40),c:int(v)!=null?int(v)/1000:null}));
 const clock=Number.isFinite(up)&&up>0?up:null,boot=now!=null&&clock!=null?Math.round(now-clock):null;
 return finish({source:LINUX_SSH_PROVIDER,t:now!=null?now*1000:null,clock,
  os:{name:clean(pretty,80),kernel:clean(rest[0]||null,60),arch:clean(rest[1]||null,20),bootUnix:boot,uptimeSeconds:clock!=null?Math.round(clock):null},
  cpuName:clean(cpuName,80),cpu:cpu.size>4097?fail('bad-output'):cpu,
  mem:{total:nonNeg(mem.MemTotal??null),available:nonNeg(mem.MemAvailable??(mem.MemFree!=null&&mem.Buffers!=null&&mem.Cached!=null?mem.MemFree+mem.Buffers+mem.Cached:null)),swapTotal:nonNeg(mem.SwapTotal??null),swapFree:nonNeg(mem.SwapFree??null)},
  load:loadParts.length===3&&loadParts.every(Number.isFinite)?loadParts:null,volumes,disks,net,temps});
}

// --- readings -----------------------------------------------------------------------------------------------
const round=(v,d=1)=>v==null?null:Math.round(v*10**d)/10**d;
// The rate of a family of counters (disks, interfaces) between two snapshots: the sum over the members both
// have; null when none is shared, or when any shared member went backwards (a reset is never averaged away).
function familyRate(a,b,key,span){
 let sum=0,any=false;
 for(const [name,cur] of b){const before=a.get(name);if(!before||before[key]==null||cur[key]==null)continue;const d=cur[key]-before[key];if(d<0)return null;sum+=d;any=true;}
 return any?sum/span:null;
}
export function deriveLinuxReading(prev,cur,atSec){
 const span=prev&&cur.clock!=null&&prev.clock!=null?cur.clock-prev.clock:null;
 const rebooted=prev&&cur.os.bootUnix!=null&&prev.os.bootUnix!=null&&Math.abs(cur.os.bootUnix-prev.os.bootUnix)>5;
 const usable=prev&&!rebooted&&span!=null&&span>0&&span<=LINUX_MAX_SPAN_SECONDS?prev:null;
 const busy=(a,b)=>{if(!a||!b)return null;const t=b.total-a.total,i=b.idle-a.idle;return t>0&&i>=0&&i<=t?Math.max(0,Math.min(100,100-i/t*100)):null;};
 const cores=usable?[...cur.cpu.keys()].filter(k=>/^\d+$/.test(k)).sort((a,b)=>a-b).slice(0,512).map(k=>round(busy(usable.cpu.get(k),cur.cpu.get(k)))):[];
 const m=cur.mem,memUsed=m.total!=null&&m.available!=null?Math.max(0,m.total-m.available):null,swapUsed=m.swapTotal!=null&&m.swapFree!=null?Math.max(0,m.swapTotal-m.swapFree):null;
 return {t:atSec,span:usable?round(span,2):null,cpu:usable?round(busy(usable.cpu.get('all'),cur.cpu.get('all'))):null,cores,
  gpu:null,memUsed,memTotal:m.total,swapUsed,vramUsed:null,
  diskRead:usable?round(familyRate(usable.disks,cur.disks,'read',span),0):null,diskWrite:usable?round(familyRate(usable.disks,cur.disks,'write',span),0):null,
  netRx:usable?round(familyRate(usable.net,cur.net,'rx',span),0):null,netTx:usable?round(familyRate(usable.net,cur.net,'tx',span),0):null,
  // Instantaneous sensor values where the machine reports them; power and GPU are not measured (null, never 0).
  cpuTemp:round(cur.cpuTemp),gpuTemp:round(cur.gpuTemp),power:null,gpuMem:null,memPressure:null,gpus:[]};
}
export const linuxVolumes=snap=>snap.volumes.slice(0,12).map(v=>({name:v.pool?`${v.pool} (ZFS · ${v.mount})`:v.mount,mount:v.mount,fs:v.fs||'',used:v.size!=null&&v.free!=null?Math.max(0,v.size-v.free):null,total:v.size}));
export function linuxNative(snap,reading,observedAt){
 return {provider:snap.source,observedAt,os:{caption:snap.os.name,version:snap.os.kernel,arch:snap.os.arch,uptimeSeconds:snap.os.uptimeSeconds},
  cpu:{name:snap.cpuName,logical:[...snap.cpu.keys()].filter(k=>/^\d+$/.test(k)).length||null,cores:reading.cores},load:snap.load,
  disk:{readBps:reading.diskRead,writeBps:reading.diskWrite},net:{rxBps:reading.netRx,txBps:reading.netTx},
  gpus:[],gpuCounters:false,span:reading.span,
  temps:snap.temps.slice(0,16).map(x=>({chip:x.chip,label:x.label,c:round(x.c)})),sensors:snap.temps.length?'reported':'none'};
}
// What a "Test connection" says about one snapshot.
export function linuxCheck(snap){
 if(!snap.cpu.size&&snap.mem.total==null)fail('no-metrics');
 return {os:{caption:snap.os.name,version:snap.os.kernel,arch:snap.os.arch},cpu:{name:snap.cpuName,logical:[...snap.cpu.keys()].filter(k=>/^\d+$/.test(k)).length||null},
  memTotal:snap.mem.total,volumes:linuxVolumes(snap).map(v=>({mount:v.mount,name:v.name,fs:v.fs,total:v.total})),
  disks:[...snap.disks.keys()].slice(0,16),interfaces:[...snap.net.keys()].slice(0,16),load:snap.load,
  temps:snap.temps.length,cpuTemp:round(snap.cpuTemp),gpus:[],gpuCounters:false,sensors:snap.temps.length?'reported':'none'};
}

// --- collecting ---------------------------------------------------------------------------------------------
const basic=(user,password)=>'Basic '+Buffer.from(`${user}:${password}`,'utf8').toString('base64');
// One scrape of a stored (or draft) Node Exporter connection. request = endpointRequest (tests pass a fake).
export async function collectNodeExporter(record,{request=endpointRequest,now=Date.now,timeoutMs=12000}={}){
 if(!validExporterRecord(record))fail('invalid');
 const https=record.scheme==='https';
 let r;
 try{r=await request({host:record.host,port:record.port,path:'/metrics',trust:https?(record.tls.mode==='pin'?{mode:'pin',pin:record.tls.pin}:{mode:'ca'}):null,timeoutMs,
  headers:{Accept:'text/plain;version=0.0.4;q=1,*/*;q=0.1',...(https&&record.user?{Authorization:basic(record.user,record.password)}:{})}});}
 catch(e){
  if(e?.message==='http'){const s=e.status;if(s===401||s===403)fail(record.user?'denied':'needs-auth');if(s===404)fail('not-exporter');
   if(s===400&&!https&&/https/i.test(String(e.body||'').slice(0,400)))fail('plain-http');fail('http');}
  fail(Object.hasOwn(NODE_EXPORTER_ERRORS,e?.message)?e.message:'unreachable');
 }
 const type=String(r.headers['content-type']||'');
 if(!/^text\/plain\b/i.test(type))fail('bad-output');
 let metrics;try{metrics=parsePromText(r.body,WANTED);}catch{fail('bad-output');}
 // A Prometheus server's own /metrics (port 9090) parses fine but holds no node_* series: say what it is.
 if(!metrics.has('node_cpu_seconds_total')&&!metrics.has('node_memory_MemTotal_bytes')&&/^prometheus_build_info[{\s]/m.test(r.body.toString('utf8')))fail('is-prometheus');
 return snapshotFromMetrics(metrics,now());
}
// One run of the script through the hub's own SSH key (spec from the key store, server/windows-ssh.mjs).
export async function collectLinuxSsh(record,{vault,run=runSsh,timeoutMs=WINDOWS_TIMEOUT_MS,platform=process.platform}={}){
 if(!validLinuxManaged(record))fail('invalid');
 const spec=await vault.spec(record);
 if(![spec.keyFile,spec.knownHosts,spec.empty].every(validStorePath))fail('invalid');
 const r=await run(managedArgs(spec,{platform,command:LINUX_REMOTE_COMMAND,validUser:validUnixUser}),{timeoutMs});
 if(typeof r.stdout==='string'&&r.stdout.includes(MARK))return parseLinuxOutput(r.stdout);
 const s=String(r.stderr||'');
 if(!r.error&&r.code!==255&&/account is currently not available|nologin|\/bin\/sh: (?:not found|No such file)/i.test(s))fail('no-shell');
 const c=classifySsh(r);
 fail(c==='no-powershell'?'no-shell':c==='powershell'?'collector':c||'bad-output');
}

// --- the poller drivers -------------------------------------------------------------------------------------
export const exporterKey=c=>['ne',c.record.host.toLowerCase(),c.record.port,c.record.scheme,c.record.tls?.mode||'',c.record.tls?.pin||'',c.record.user||'',secretTag(c.record.password)].join('|');
export const linuxSshKey=c=>['lssh',c.record.host.toLowerCase(),c.record.port,c.record.user,c.record.keyId,c.record.connId,c.record.hostKey.fingerprint].join('|');
// What a connection may show to signed-in readers: never a password, a key or a path.
export const exporterInfo=c=>({mode:NODE_EXPORTER_PROVIDER,host:c.record.host,port:c.record.port,scheme:c.record.scheme,tls:c.record.tls?{mode:c.record.tls.mode,...(c.record.tls.pin?{fingerprint:c.record.tls.pin}:{})}:null,
 auth:c.record.user?'basic':'none',user:c.record.user||null});
export const linuxSshInfo=c=>({mode:'managed',os:'linux',host:c.record.host,port:c.record.port,user:c.record.user,keyFingerprint:c.record.keyFingerprint,hostKeyFingerprint:c.record.hostKey.fingerprint});
export const linuxDriver=({collect,errors,valid,key,label,info,...extra})=>({collect,derive:deriveLinuxReading,volumes:linuxVolumes,native:linuxNative,errors,valid,key,label,info,deniedCodes:['denied','needs-auth'],...extra});
export const exporterDriver=({collect})=>linuxDriver({collect:c=>collect(c.record),errors:NODE_EXPORTER_ERRORS,valid:c=>Boolean(c&&typeof c.id==='string'&&validExporterRecord(c.record)),key:exporterKey,label:c=>exporterLabel(c.record),info:exporterInfo});
export const linuxSshDriver=({collect})=>linuxDriver({collect:c=>collect(c.record),errors:LINUX_SSH_ERRORS,valid:c=>Boolean(c&&typeof c.id==='string'&&validLinuxManaged(c.record)),key:linuxSshKey,label:c=>linuxSshLabel(c.record),info:linuxSshInfo});
