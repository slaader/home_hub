// The set-up that happens on the machine for the providers other than Windows over SSH (public/windows-setup.js),
// as text to copy: Windows over WinRM (PowerShell), Linux with Node Exporter, an existing Prometheus, and Linux
// over SSH (POSIX shell). Nothing here runs anywhere by itself; the hub never installs or configures a machine.
// Pure functions (no DOM): the device dialog shows them, tests check them. Values from the form are quoted as
// literals of the target shell (PowerShell: psLiteral; POSIX sh: shLiteral) and refused when they carry a line
// break or a control character; placeholders in <angle brackets> are for the person to fill in.
import {psLiteral,validWindowsUser} from './windows-setup.js';

// 'text' as a POSIX shell single-quoted word. Throws on a line break, a control character or a single quote
// (no value the hub hands over needs one: public keys, host names, user names).
export function shLiteral(text){
 if(typeof text!=='string'||/[\u0000-\u001f\u007f']/.test(text))throw new Error('invalid');
 return `'${text}'`;
}
const HOST=/^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}))*$/,IPV4=/^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const hostOr=(h,fallback)=>typeof h==='string'&&(HOST.test(h)||IPV4.test(h))?h:fallback;
const portOr=(p,fallback)=>Number.isInteger(p)&&p>=1&&p<=65535?p:fallback;

// --- Windows over WinRM -----------------------------------------------------------------------------------------
// WinRM's Basic authentication is off by default and stays off for the WinRM client; this enables it for the
// service only. It keeps every existing listener (an HTTP one included), certificate and setting; it adds an
// HTTPS listener only when there is none, with a new self-signed certificate (the hub pins it), and one inbound
// firewall rule for the listener's port from the hub's address only. It never sets AllowUnencrypted, never runs
// winrm quickconfig / Enable-PSRemoting, never changes TrustedHosts, UAC or LocalAccountTokenFilterPolicy.
export function winrmListenerScript({host,port=5986,hub}={}){
 const name=hostOr(host,'<pc.example.lan>'),p=portOr(port,5986),from=IPV4.test(hub||'')?hub:'<10.0.0.x>';
 // One block: pasted into a console it runs as a whole, so the address check below stops it before any change.
 return [
  '# Home Hub: WinRM over HTTPS with Basic for the service only. Run in PowerShell as administrator.',
  '# Keeps existing listeners, certificates and settings. $HubAddress is the Home Hub server\'s IPv4 address.',
  '& {',
  `$HubAddress = ${psLiteral(from)}`,
  `$Name = ${psLiteral(name)}`,
  `$Port = ${p}`,
  "$ErrorActionPreference = 'Stop'",
  "if ($HubAddress -notmatch '^\\d{1,3}(\\.\\d{1,3}){3}$') { throw 'Set $HubAddress to the Home Hub server''s IPv4 address first. Nothing was changed.' }",
  'Set-Service -Name WinRM -StartupType Automatic',
  'Start-Service -Name WinRM',
  "$https = @(Get-ChildItem -Path WSMan:\\localhost\\Listener | Where-Object { $_.Keys -contains 'Transport=HTTPS' })",
  'if ($https.Count -eq 0) {',
  '  $cert = New-SelfSignedCertificate -DnsName $Name -CertStoreLocation Cert:\\LocalMachine\\My -KeyExportPolicy NonExportable -NotAfter (Get-Date).AddYears(3)',
  '  New-Item -Path WSMan:\\localhost\\Listener -Transport HTTPS -Address * -Port $Port -CertificateThumbPrint $cert.Thumbprint -Force | Out-Null',
  '  "Added an HTTPS listener on port $Port with a new self-signed certificate."',
  '} else { "An HTTPS listener exists already; it is kept as it is." }',
  'Set-Item -Path WSMan:\\localhost\\Service\\Auth\\Basic -Value $true',
  "'Service AllowUnencrypted (stays as it was, normally false): ' + (Get-Item -Path WSMan:\\localhost\\Service\\AllowUnencrypted).Value",
  "$rule = Get-NetFirewallRule -Name 'HomeHub-WinRM-HTTPS-In' -ErrorAction SilentlyContinue",
  'if (-not $rule) {',
  "  New-NetFirewallRule -Name 'HomeHub-WinRM-HTTPS-In' -DisplayName 'WinRM HTTPS (Home Hub)' -Direction Inbound -Protocol TCP -LocalPort $Port -RemoteAddress $HubAddress -Action Allow | Out-Null",
  '} else { $rule | Set-NetFirewallRule -Direction Inbound -Protocol TCP -LocalPort $Port -RemoteAddress $HubAddress -Action Allow }',
  '"The firewall lets port $Port in from $HubAddress only."',
  '}'].join('\n');
}
// The account: a standard local account in the two groups WinRM and the counters need (SIDs, so localized group
// names never matter). It creates no account and changes no password.
export function winrmAccountScript(user){
 if(!validWindowsUser(user)||/[\\@]/.test(user))throw new Error('invalid');
 return ['# Home Hub: let a standard local account read over WinRM. Run in PowerShell as administrator.',
  `$User = ${psLiteral(user)}`,
  "foreach ($sid in @('S-1-5-32-580', 'S-1-5-32-558')) {   # Remote Management Users, Performance Monitor Users",
  '  $group = Get-LocalGroup -SID $sid',
  '  if (-not (Get-LocalGroupMember -Group $group | Where-Object { $_.Name -like "*\\$User" })) { Add-LocalGroupMember -Group $group -Member $User }',
  '}',
  "'Now allow it to read WMI: wmimgmt.msc > WMI Control > Properties > Security > Root\\CIMV2 > Security > Add ' + $User + ' > allow Enable Account and Remote Enable (This namespace only).'"].join('\n');
}
// The SHA-256 of the certificate of the HTTPS listener, in the form the hub shows (Windows itself shows SHA-1 thumbprints).
export const WINRM_FINGERPRINT_SCRIPT=[
 '# Shows the SHA-256 fingerprint of the WinRM HTTPS listener\'s certificate. Compare it with Home Hub.',
 "$l = Get-ChildItem -Path WSMan:\\localhost\\Listener | Where-Object { $_.Keys -contains 'Transport=HTTPS' } | Select-Object -First 1",
 "$thumb = (Get-ChildItem -Path $l.PSPath | Where-Object Name -eq 'CertificateThumbprint').Value",
 '$c = Get-Item -Path ("Cert:\\LocalMachine\\My\\" + $thumb)',
 "'SHA256 ' + ([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($c.RawData)) -replace '-', ':')"].join('\n');

// --- Linux: Node Exporter -----------------------------------------------------------------------------------------
// Package names known for the distributions below; anything else uses the official release binary.
export const NODE_EXPORTER_PACKAGES=[
 '# Debian, Ubuntu (package prometheus-node-exporter; it listens on :9100 on every interface):',
 'sudo apt install prometheus-node-exporter',
 '# Arch Linux:',
 'sudo pacman -S prometheus-node-exporter && sudo systemctl enable --now prometheus-node-exporter',
 '# Other distributions: use the official release below, or your distribution\'s own package.'].join('\n');
export function nodeExporterManual({listen='<LAN-IP>'}={}){
 const addr=hostOr(listen,'<LAN-IP>');
 return ['# Official release: https://github.com/prometheus/node_exporter/releases',
  '# Download node_exporter-<VERSION>.linux-<ARCH>.tar.gz and sha256sums.txt, then check it:',
  'sha256sum --ignore-missing -c sha256sums.txt',
  'tar xzf node_exporter-<VERSION>.linux-<ARCH>.tar.gz',
  'sudo install -m 0755 node_exporter-<VERSION>.linux-<ARCH>/node_exporter /usr/local/bin/node_exporter',
  'sudo useradd --system --no-create-home --shell /usr/sbin/nologin node_exporter',
  'sudo tee /etc/systemd/system/node_exporter.service >/dev/null <<\'EOF\'',
  '[Unit]','Description=Prometheus Node Exporter','After=network-online.target','',
  '[Service]','User=node_exporter',`ExecStart=/usr/local/bin/node_exporter --web.listen-address=${addr}:9100`,
  'Restart=on-failure','NoNewPrivileges=true','ProtectSystem=strict','ProtectHome=read-only','',
  '[Install]','WantedBy=multi-user.target','EOF',
  'sudo systemctl daemon-reload && sudo systemctl enable --now node_exporter'].join('\n');
}
// Only the hub may reach the port: one rule per firewall tool; never open it to the internet.
export function nodeExporterFirewall({hub}={}){
 const from=IPV4.test(hub||'')?hub:'<HUB-IP>';
 return ['# Allow only the Home Hub server to reach the port (pick the tool your system uses):',
  `sudo ufw allow from ${from} to any port 9100 proto tcp`,
  `sudo firewall-cmd --permanent --add-rich-rule='rule family="ipv4" source address="${from}" port port="9100" protocol="tcp" accept' && sudo firewall-cmd --reload`].join('\n');
}
export const NODE_EXPORTER_FIREWALL=nodeExporterFirewall();
// HTTPS (and, with it, Basic credentials) through Node Exporter's own web configuration.
export function nodeExporterTls({host}={}){
 const name=hostOr(host,'<host.example.lan>');
 return ['# Optional: HTTPS with Node Exporter\'s own web config (https://prometheus.io/docs/prometheus/latest/configuration/https/).',
  'sudo install -d -m 0755 /etc/node_exporter',
  `sudo openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 1095 -subj "/CN=${name}" -addext "subjectAltName=DNS:${name}" -keyout /etc/node_exporter/node.key -out /etc/node_exporter/node.crt`,
  'sudo chown node_exporter /etc/node_exporter/node.key && sudo chmod 600 /etc/node_exporter/node.key',
  '# Optional Basic credentials: a bcrypt hash of the password (htpasswd is in apache2-utils / httpd-tools):',
  'htpasswd -nBC 10 "" | tr -d \':\\n\'',
  'sudo tee /etc/node_exporter/web.yml >/dev/null <<\'EOF\'',
  'tls_server_config:','  cert_file: /etc/node_exporter/node.crt','  key_file: /etc/node_exporter/node.key',
  'basic_auth_users:','  homehub: <BCRYPT-HASH>','EOF',
  '# Add --web.config.file=/etc/node_exporter/web.yml to ExecStart, restart, then compare this with Home Hub:',
  'openssl x509 -in /etc/node_exporter/node.crt -noout -fingerprint -sha256'].join('\n');
}

// --- Linux: an existing Prometheus --------------------------------------------------------------------------------
// The scrape target Prometheus needs for a host it does not read yet (the hub reads only node_exporter targets).
export function prometheusScrape({host}={}){
 const name=hostOr(host,'<host.example.lan>');
 return ['# prometheus.yml: add the host\'s Node Exporter as a target, then reload Prometheus your usual way.',
  'scrape_configs:','  - job_name: node','    static_configs:',`      - targets: ['${name}:9100']`].join('\n');
}
export const PROMETHEUS_DOCKER=['# Prometheus in Docker: Home Hub talks to the published port on the Docker host, e.g.',
 'docker run -d --name prometheus -p 9090:9090 -v /srv/prometheus:/etc/prometheus prom/prometheus',
 '# then use the Docker host\'s address and 9090 here (a container name does not resolve outside Docker).',
 '# A target on the same host is scraped by the host\'s address (or host.docker.internal), not by localhost.',
 '# Node Exporter in Docker needs the host\'s view (official README):',
 'docker run -d --net=host --pid=host -v "/:/host:ro,rslave" quay.io/prometheus/node-exporter:latest --path.rootfs=/host'].join('\n');

// --- Linux over SSH -----------------------------------------------------------------------------------------------
const PUBLIC_KEY=/^(ssh-ed25519|ecdsa-sha2-nistp(?:256|384|521)|ssh-rsa) ([A-Za-z0-9+/]{16,4096}={0,2})(?: [A-Za-z0-9._@-]{1,64})?$/;
export const UNIX_USER=/^[A-Za-z_][A-Za-z0-9._-]{0,31}$/;
export const validUnixUser=u=>typeof u==='string'&&UNIX_USER.test(u);
// Authorizes the hub's key for the account it runs as, once. "restrict": no forwarding, no terminal, no agent.
export function linuxAuthorizeScript(publicKey){
 const m=PUBLIC_KEY.exec(String(publicKey||''));if(!m)throw new Error('invalid');
 const line=shLiteral(`restrict ${m[1]} ${m[2]} home-hub`);
 return ['# Home Hub: allow this key to sign in. Run as the account Home Hub signs in as (no sudo).',
  'umask 077 && mkdir -p ~/.ssh',
  `grep -qxF ${line} ~/.ssh/authorized_keys 2>/dev/null || printf '%s\\n' ${line} >> ~/.ssh/authorized_keys`,
  'chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys'].join('\n');
}
// Optional: a dedicated account with a normal shell and no extra rights.
export const linuxAccountScript=user=>{if(!validUnixUser(user))throw new Error('invalid');
 return ['# Optional, as root: a dedicated account for Home Hub (no sudo, no groups).',`sudo useradd --create-home --shell /bin/sh ${user}`].join('\n');};
export const LINUX_FINGERPRINT_SCRIPT=['# The fingerprints of this machine\'s SSH host keys. Compare one with Home Hub.',
 'for f in /etc/ssh/ssh_host_*_key.pub; do ssh-keygen -lf "$f"; done'].join('\n');
