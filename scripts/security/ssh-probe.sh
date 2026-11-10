#!/bin/sh
# Home Hub security probe. Read-only: lists SSH private keys, authorized_keys, client routes
# (ssh -G per Host alias), sudo rights and sshd settings on THIS machine, one tab-separated
# record per line on stdout.
#
# It never prints private key material. Private key files are only opened by ssh-keygen on
# this host, to read the public fingerprint and to test whether an empty passphrase opens them.
# authorized_keys lines and ssh config values are public material and are printed as-is.
#
# Run as a user with passwordless sudo to see every account; without it only the current
# user is covered. The collector runs it as:  ssh -n <alias> sh -c "$(… | base64 -d)"
# so that stdin is never the script itself.
set -u
PATH=/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin
LC_ALL=C
export PATH LC_ALL
OS=$(uname -s)
ME=$(id -un)
if [ "$(id -u)" = 0 ]; then ROOT=1; elif sudo -n true </dev/null 2>/dev/null; then ROOT=1; else ROOT=0; fi
R() { if [ "$(id -u)" = 0 ] || [ "$ROOT" = 0 ]; then "$@"; else sudo -n "$@"; fi; }
# sh has no local variables: emit's names must not collide with the callers' ($f, $line, …).
emit() {
  _emit_out=$1; shift
  for _emit_field in "$@"; do _emit_out="$_emit_out	$(printf '%s' "$_emit_field" | tr '\t\r\n' '   ')"; done
  printf '%s\n' "$_emit_out"
}

emit HOST "$(hostname -s 2>/dev/null || hostname)" "$OS" "$ME" "$ROOT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# --- addresses -------------------------------------------------------------------------
if [ "$OS" = Darwin ]; then ips=$(ifconfig 2>/dev/null | awk '$1=="inet" && $2!="127.0.0.1"{print $2}')
else ips=$(ip -4 -o addr 2>/dev/null | awk '{split($4,a,"/"); if(a[1]!="127.0.0.1") print a[1]}'); fi
emit NET $(printf '%s\n' "$ips" | tr '\n' ' ')

# --- sshd --------------------------------------------------------------------------------
if [ "$OS" = Darwin ]; then
  if R launchctl print system/com.openssh.sshd </dev/null >/dev/null 2>&1; then emit LISTEN on; else emit LISTEN off; fi
  # Remote Login "only these users" = members of com.apple.access_ssh; nested groups print as %name.
  if grp=$(dscl . -read /Groups/com.apple.access_ssh </dev/null 2>/dev/null); then
    members=$(printf '%s\n' "$grp" | awk '/^GroupMembership:/{for(i=2;i<=NF;i++)print $i}')
    nested=$(printf '%s\n' "$grp" | awk '/^NestedGroups:/{for(i=2;i<=NF;i++)print $i}' | while read -r g; do
      n=$(dscl . -search /Groups GeneratedUID "$g" </dev/null 2>/dev/null | awk 'NR==1{print $1}'); printf '%%%s\n' "${n:-$g}"; done)
    # shellcheck disable=SC2086
    emit ACCESSGROUP $members $nested
  else emit ACCESSGROUP '*'; fi
else
  if systemctl is-active ssh </dev/null >/dev/null 2>&1 || systemctl is-active sshd </dev/null >/dev/null 2>&1; then emit LISTEN on; else emit LISTEN off; fi
fi
if [ "$ROOT" = 1 ]; then
  R sshd -T </dev/null 2>/dev/null | awk 'tolower($1) ~ /^(port|passwordauthentication|kbdinteractiveauthentication|pubkeyauthentication|permitrootlogin|allowusers|allowgroups|denyusers|denygroups|authorizedkeysfile|authenticationmethods)$/' |
    while read -r k v; do emit SSHD "$k" "$v"; done
fi

# --- accounts ----------------------------------------------------------------------------
users_list() {
  if [ "$OS" = Darwin ]; then
    dscl . -list /Users UniqueID </dev/null | while read -r u id; do
      case $u in _*) continue ;; esac
      [ "$id" -eq 0 ] 2>/dev/null || [ "$id" -ge 500 ] 2>/dev/null || continue
      home=$(dscl . -read "/Users/$u" NFSHomeDirectory </dev/null 2>/dev/null | awk '{print $2}')
      shell=$(dscl . -read "/Users/$u" UserShell </dev/null 2>/dev/null | awk '{print $2}')
      printf '%s\t%s\t%s\t%s\n' "$u" "$id" "$home" "$shell"
    done
  else
    getent passwd </dev/null | awk -F: '{print $1"\t"$3"\t"$6"\t"$7}'
  fi
}

sudo_rules() {
  u=$1
  if [ "$ROOT" = 1 ]; then out=$(R sudo -n -l -U "$u" </dev/null 2>&1)
  elif [ "$u" = "$ME" ]; then
    out=$(sudo -n -l </dev/null 2>&1) || { emit SUDO "$u" unknown "sudo -n -l asks for a password"; return; }
  else emit SUDO "$u" unknown "no root access on this host"; return; fi
  case $out in *"not allowed to run sudo"*) emit SUDO "$u" none ""; return ;; esac
  printf '%s\n' "$out" | sed -n '/may run the following commands/,$p' | sed '1d' | while IFS= read -r l; do
    l=$(printf '%s' "$l" | sed 's/^[[:space:]]*//')
    [ -n "$l" ] && emit SUDO "$u" rule "$l"
  done
}

cfg_routes() {
  u=$1 home=$2 conf="$2/.ssh/config"
  R test -f "$conf" || return 0
  files=$conf
  for inc in $(R awk 'tolower($1)=="include"{for(i=2;i<=NF;i++)print $i}' "$conf" </dev/null 2>/dev/null); do
    case $inc in "~/"*) inc="$home/${inc#\~/}" ;; /*) ;; *) inc="$home/.ssh/$inc" ;; esac
    for x in $inc; do files="$files
$x"; done
  done
  aliases=$(printf '%s\n' "$files" | while IFS= read -r cf; do
    R test -f "$cf" && R awk 'tolower($1)=="host"{for(i=2;i<=NF;i++) if($i !~ /[*?!]/) print $i}' "$cf" </dev/null 2>/dev/null
  done | sort -u)
  for a in $aliases; do
    if [ "$u" = "$ME" ]; then g=$(ssh -G "$a" </dev/null 2>/dev/null)
    elif [ "$ROOT" = 1 ]; then g=$(R sudo -n -H -u "$u" ssh -G "$a" </dev/null 2>/dev/null)
    else continue; fi
    [ -n "$g" ] || continue
    val() { printf '%s\n' "$g" | awk -v k="$1" '$1==k{print $2; exit}'; }
    emit CFG "$u" "$a" "$(val hostname)" "$(val port)" "$(val user)" \
      "$(printf '%s\n' "$g" | awk '$1=="identityfile"{print $2}' | tr '\n' '|')" "$(val proxyjump)" "$(val identitiesonly)"
  done
}

ACCOUNTS=$(users_list | while IFS='	' read -r u uid home shell; do
  [ -n "$u" ] || continue
  hasssh=0
  [ -n "$home" ] && [ "$home" != / ] && R test -d "$home/.ssh" </dev/null && hasssh=1
  case $shell in (*nologin | *false | *sync | */shutdown | */halt | '') login=0 ;; (*) login=1 ;; esac
  # System accounts on Linux have shells too; keep root, real users (uid >= 1000) and anyone with ~/.ssh.
  if [ "$OS" != Darwin ] && [ "$uid" != 0 ] && [ "$hasssh" = 0 ] && { [ "$uid" -lt 1000 ] 2>/dev/null || [ "$uid" -ge 65534 ] 2>/dev/null; }; then continue; fi
  [ "$uid" = 0 ] || [ "$login" = 1 ] || [ "$hasssh" = 1 ] || continue
  printf '%s\t%s\t%s\t%s\t%s\n' "$u" "$uid" "$home" "$shell" "$hasssh"
done)

printf '%s\n' "$ACCOUNTS" | while IFS='	' read -r u uid home shell hasssh; do
  [ -n "$u" ] || continue
  emit USER "$u" "$uid" "$home" "$shell" "$hasssh"
  sudo_rules "$u"
  [ "$hasssh" = 1 ] || continue
  for ak in authorized_keys authorized_keys2; do
    f="$home/.ssh/$ak"
    R test -f "$f" </dev/null || continue
    R cat "$f" </dev/null | while IFS= read -r line || [ -n "$line" ]; do
      case $line in '' | '#'*) continue ;; esac
      emit AUTH "$u" "$f" "$line"
    done
  done
  cfg_routes "$u" "$home"
done

# --- private key files --------------------------------------------------------------------
# Every account home plus a few system places where services keep keys. Heavy trees are pruned;
# one grep pass picks small files that mention a private key header, then only files whose
# FIRST line is that header count (test fixtures that merely contain the text are skipped).
roots=$(printf '%s\n' "$ACCOUNTS" | awk -F'\t' '$3!="" && $3!="/" && $3!="/var/empty" {print $3}')
if [ "$OS" = Darwin ]; then roots="$roots
/Library/Application Support
/usr/local/etc
/opt/homebrew/etc
/private/etc"
else roots="$roots
/etc
/opt
/usr/local/etc
$(ls -d /mnt/*/Applications /mnt/*/home 2>/dev/null)"; fi

printf '%s\n' "$roots" | sort -u | while IFS= read -r base; do
  [ -n "$base" ] && R test -d "$base" </dev/null || continue
  R find "$base" -maxdepth 6 \( -name Library -o -name node_modules -o -name .git -o -name .cache -o -name .Trash \
      -o -name site-packages -o -name .npm -o -name models -o -name .venv -o -name venv -o -name ix-apps -o -name .ix-apps \
      -o -name Movies -o -name Music -o -name Pictures -o -name UnrealEngine -o -name '*.app' -o -name 'ComfyUI*' \
      -o -name immich -o -name postgres -o -name pgdata -o -path /etc/ssh -o -path /private/etc/ssh \) -prune \
      -o -type f -size -16k -print </dev/null 2>/dev/null
done | sort -u | tr '\n' '\0' | R xargs -0 grep -l -- '-----BEGIN .*PRIVATE KEY-----' 2>/dev/null | while IFS= read -r f; do
  hdr=$(R head -c 80 "$f" </dev/null 2>/dev/null | head -n 1)
  case $hdr in *"-----BEGIN "*"PRIVATE KEY-----"*) ;; *) continue ;; esac
  kind=$(printf '%s' "$hdr" | sed -E 's/.*BEGIN (.*)PRIVATE KEY-----.*/\1/; s/ $//')
  if [ "$OS" = Darwin ]; then meta=$(R stat -f '%Lp %Su %m' "$f" </dev/null 2>/dev/null); else meta=$(R stat -c '%a %U %Y' "$f" </dev/null 2>/dev/null); fi
  # shellcheck disable=SC2086
  set -- $meta
  fp=$(R ssh-keygen -l -f "$f" </dev/null 2>/dev/null | head -n 1)
  enc=unknown
  if [ -n "$fp" ]; then
    if R ssh-keygen -y -P '' -f "$f" </dev/null >/dev/null 2>&1; then enc=no; else enc=yes; fi
  elif R head -c 300 "$f" </dev/null 2>/dev/null | grep -q ENCRYPTED; then enc=yes
  fi
  emit KEY "$f" "${1:-}" "${2:-}" "${3:-}" "$kind" "$enc" "$fp"
done
emit END ok
