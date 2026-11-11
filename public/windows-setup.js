// The only set-up that happens on Windows, as PowerShell to copy: install OpenSSH Server (only when it is not
// there yet), authorize the hub's public key for one Windows account, and show the host-key fingerprints to
// compare with the ones the hub fetched. Nothing runs on the hub's server and nothing depends on its system.
// Pure functions (no DOM): the device dialog shows them, tests check them.
//
// Values from the form become PowerShell single-quoted literals: nothing inside is expanded, and the only
// character with a meaning, the quote, is doubled (PowerShell also takes the typographic quotes ‘ ’ ‚ ‛ for one,
// so those are doubled too). Line breaks and control characters are refused, never passed on. The user name has
// the server's rule (server/windows-telemetry.mjs → WINDOWS_USER); the key must be one public key line.
//
// What the authorization does, and nothing more: it finds the account's SID (so localized group names never
// matter), and appends the key once to the one file Windows' OpenSSH Server reads for that account:
//   a standard account   <its profile>\.ssh\authorized_keys        (ACL: the account, SYSTEM, Administrators)
//   an administrator     %ProgramData%\ssh\administrators_authorized_keys   (ACL: Administrators, SYSTEM)
// For an administrator it stops unless $AllowAdministrator is set to $true: that file is shared, so a key in it
// signs in as every administrator of the PC. It never creates an account, changes a group, sshd's configuration,
// the firewall or UAC. The key line starts with "restrict" (no forwarding, no terminal): the collector needs none.

const NAME='[\\p{L}\\p{N}_](?:[\\p{L}\\p{N} ._-]{0,62}[\\p{L}\\p{N}_-])?';
export const WINDOWS_USER=new RegExp(`^(?:${NAME}\\\\)?${NAME}(?:@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?)?$`,'u');
export const validWindowsUser=u=>typeof u==='string'&&u.length<=128&&WINDOWS_USER.test(u)&&!/\s\s/.test(u);
const PUBLIC_KEY=/^(ssh-ed25519|ecdsa-sha2-nistp(?:256|384|521)|ssh-rsa) ([A-Za-z0-9+/]{16,4096}={0,2})(?: [A-Za-z0-9._@-]{1,64})?$/;

// 'text' as a PowerShell literal. Throws on a line break or a control character.
export function psLiteral(text){
 if(typeof text!=='string'||/[\u0000-\u001f\u007f\u0085\u2028\u2029]/u.test(text))throw new Error('invalid');
 return `'${text.replace(/['‘’‚‛]/g,q=>q+q)}'`;
}

export const INSTALL_SCRIPT=[
 '# Run in PowerShell as administrator, only if OpenSSH Server is not installed yet.',
 'Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0',
 'Set-Service -Name sshd -StartupType Automatic',
 'Start-Service sshd',
 '# The installation adds the firewall rule for port 22 itself; this shows it:',
 'Get-NetFirewallRule -Name OpenSSH-Server-In-TCP | Select-Object Name, Enabled, Profile'].join('\n');

// SHA256 fingerprints of the host keys, computed in PowerShell (no other tool needed), in the form the hub shows.
export const FINGERPRINT_SCRIPT=[
 '# Shows the fingerprints of this PC\'s SSH host keys. Compare one with what Home Hub shows.',
 'Get-ChildItem -Path "$env:ProgramData\\ssh\\ssh_host_*_key.pub" | ForEach-Object {',
 '  $type, $body = (Get-Content -LiteralPath $_.FullName -TotalCount 1).Split(\' \')[0, 1]',
 '  $hash = [Security.Cryptography.SHA256]::Create().ComputeHash([Convert]::FromBase64String($body))',
 '  \'{0}  SHA256:{1}\' -f $type, [Convert]::ToBase64String($hash).TrimEnd(\'=\')',
 '}'].join('\n');

// Optional, for a standard account whose test says the counters are missing.
export const counterScript=user=>{
 if(!validWindowsUser(user))throw new Error('invalid');
 return ['# Optional, as administrator: lets the account read performance counters (nothing else).',
  `Add-LocalGroupMember -SID 'S-1-5-32-558' -Member ${psLiteral(user)}`].join('\n');
};

// The authorization for user with publicKey ("type base64 comment"). Throws on a user or key that is not valid.
export function authorizeScript(user,publicKey,{allowAdministrator=false}={}){
 if(!validWindowsUser(user))throw new Error('invalid');
 const m=PUBLIC_KEY.exec(String(publicKey||''));if(!m)throw new Error('invalid');
 const line=`restrict ${m[1]} ${m[2]} home-hub`;
 return [
  '# Home Hub: allow this key to sign in as one Windows account. Read-only telemetry; run in PowerShell as administrator.',
  '# It changes only the one authorized_keys file below. Run it again any time: the key is added once.',
  `$User = ${psLiteral(user)}`,
  `$Key = ${psLiteral(line)}`,
  `$KeyBody = ${psLiteral(m[2])}`,
  `$AllowAdministrator = ${allowAdministrator===true?'$true':'$false'}`,
  "$ErrorActionPreference = 'Stop'",
  '$sid = (New-Object System.Security.Principal.NTAccount($User)).Translate([System.Security.Principal.SecurityIdentifier]).Value',
  "$isAdmin = @(Get-LocalGroupMember -SID 'S-1-5-32-544' | Where-Object { $_.SID.Value -eq $sid }).Count -gt 0",
  'if ($isAdmin) {',
  '  if (-not $AllowAdministrator) { throw "$User is an administrator. Windows OpenSSH reads one shared file for all administrators, so this key could sign in as any of them. Use a standard account, or select the administrator-account option in Home Hub and copy the updated command." }',
  "  $file = Join-Path $env:ProgramData 'ssh\\administrators_authorized_keys'",
  "  $allowed = @('S-1-5-32-544', 'S-1-5-18')",
  '} else {',
  '  $profileDir = (Get-CimInstance -ClassName Win32_UserProfile | Where-Object { $_.SID -eq $sid }).LocalPath',
  '  if (-not $profileDir) { throw "$User has no profile on this PC yet. Sign in as $User once, then run this again." }',
  "  $dir = Join-Path $profileDir '.ssh'",
  '  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }',
  "  $file = Join-Path $dir 'authorized_keys'",
  "  $allowed = @($sid, 'S-1-5-18', 'S-1-5-32-544')",
  '}',
  "$text = if (Test-Path -LiteralPath $file) { [IO.File]::ReadAllText($file) } else { '' }",
  'if ($text.Contains($KeyBody)) { "The Home Hub key is already in $file" } else {',
  "  $lead = if ($text.Length -gt 0 -and -not $text.EndsWith(\"`n\")) { \"`r`n\" } else { '' }",
  '  [IO.File]::AppendAllText($file, $lead + $Key + "`r`n")',
  '  "Added the Home Hub key to $file"',
  '}',
  '$acl = New-Object System.Security.AccessControl.FileSecurity',
  '$acl.SetOwner((New-Object System.Security.Principal.SecurityIdentifier($allowed[0])))',
  '$acl.SetAccessRuleProtection($true, $false)',
  'foreach ($id in $allowed) {',
  '  $identity = New-Object System.Security.Principal.SecurityIdentifier($id)',
  "  $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'Allow')))",
  '}',
  'Set-Acl -LiteralPath $file -AclObject $acl'].join('\n');
}
