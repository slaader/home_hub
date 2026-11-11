// A synthetic Node Exporter exposition (generic names, placeholder values) for the Linux tests.
// A Node Exporter exposition at time `at` with counters scaled by k (k=1 first scrape, larger later).
export function exposition({at=1_700_000_000,k=1,boot=1_699_990_000,extra=''}={}){
 const cpu=[0,1].flatMap(c=>[['idle',1000*k],['iowait',10*k],['user',100*k*(c+1)],['system',50*k],['guest',999]].map(([m,v])=>`node_cpu_seconds_total{cpu="${c}",mode="${m}"} ${v}`));
 const fs=[['pool/data','zfs','/mnt/pool/data',4e12,2e12],['pool','zfs','/mnt/pool',4e12,2e12],['pool/apps/x','zfs','/mnt/.apps/x',4e12,2e12],
  ['/dev/sda1','ext4','/',1e11,5e10],['/dev/sda1','ext4','/srv/bind',1e11,5e10],['tmpfs','tmpfs','/run',1e9,1e9],['overlay','overlay','/var/lib/docker/x',1e11,5e10],
  ['boot/ROOT/os','zfs','/boot',2e11,1e11]];
 return ['# HELP node_cpu_seconds_total Seconds the CPUs spent in each mode.','# TYPE node_cpu_seconds_total counter',...cpu,
  'node_memory_MemTotal_bytes 1.6e+10','node_memory_MemAvailable_bytes 4e9','node_memory_SwapTotal_bytes 2e9','node_memory_SwapFree_bytes 1.5e9',
  'node_load1 0.5','node_load5 0.25','node_load15 NaN',
  ...fs.flatMap(([d,t,m,s,f])=>[`node_filesystem_size_bytes{device="${d}",fstype="${t}",mountpoint="${m}"} ${s}`,`node_filesystem_free_bytes{device="${d}",fstype="${t}",mountpoint="${m}"} ${f}`]),
  ...[['nvme0n1',1e6*k,2e6*k],['nvme0n1p1',5e5*k,1e6*k],['dm-0',9e9,9e9],['loop0',1e3,1e3]].flatMap(([d,r,w])=>[`node_disk_read_bytes_total{device="${d}"} ${r}`,`node_disk_written_bytes_total{device="${d}"} ${w}`]),
  ...[['eth0',3e6*k,1e6*k],['lo',8e9,8e9],['docker0',7e9,7e9],['veth12ab',6e9,6e9]].flatMap(([d,r,x])=>[`node_network_receive_bytes_total{device="${d}"} ${r}`,`node_network_transmit_bytes_total{device="${d}"} ${x}`]),
  `node_boot_time_seconds ${boot}`,`node_time_seconds ${at}`,
  'node_uname_info{domainname="(none)",machine="x86_64",nodename="host-a",release="6.1.0-test",sysname="Linux",version="#1 SMP"} 1',
  'node_os_info{id="debian",name="Debian GNU/Linux",pretty_name="Debian GNU/Linux 12 (bookworm)"} 1',
  'node_hwmon_chip_names{chip="platform_coretemp_0",chip_name="coretemp"} 1',
  'node_hwmon_sensor_label{chip="platform_coretemp_0",label="Package id 0",sensor="temp1"} 1',
  'node_hwmon_temp_celsius{chip="platform_coretemp_0",sensor="temp1"} 47 1700000000000','node_hwmon_temp_celsius{chip="platform_coretemp_0",sensor="temp2"} 51',
  'go_goroutines 9','process_cpu_seconds_total 1.5',extra,''].join('\n');
}
