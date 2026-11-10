#!/bin/sh
# Home Hub systems probe for macOS. Read-only. One tab-separated record per line on stdout,
# ending with "END<TAB>ok":
#   OS, HW, UPTIME            version, build, kernel, model, memory, boot time
#   SWU / SWU_NONE / SWU_ERR  pending Apple updates from `softwareupdate -l`
#   AUTO                      automatic-update policy (com.apple.SoftwareUpdate)
#   FW, PF, FV, SIP, GK       application firewall, packet filter, FileVault, SIP, Gatekeeper
#   SSHD                      Remote Login state and effective sshd settings (sshd -T, needs sudo)
#   LISTEN                    listening TCP sockets with the owning process (lsof, needs sudo)
#   SW / RUN                  watched software versions and launchd PIDs (from $SPECS)
#   BREWOUT                   other outdated Homebrew packages (no `brew update` is run)
#   DOCKER                    running containers (image, created)
#
# Root is used only through `sudo -n` for Apple's own pfctl, sshd and lsof. Every watched
# binary is executed as the connecting user, never as root.
#
# The collector prepends SPECS: one "id|kind|arg1|arg2|launchd" line per watched item.
set -u
: "${SPECS:=}"
PATH=/usr/bin:/bin:/usr/sbin:/sbin
LC_ALL=C
export PATH LC_ALL
BREW_PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
if [ "$(id -u)" = 0 ]; then ROOT=1; elif sudo -n true </dev/null 2>/dev/null; then ROOT=1; else ROOT=0; fi
R() { if [ "$(id -u)" = 0 ]; then "$@"; elif [ "$ROOT" = 1 ]; then sudo -n "$@"; else return 1; fi; }
# macOS has no timeout(1); perl ships with the OS (also on Macs without Command Line Tools).
T() { _t_secs=$1; shift; perl -e 'alarm shift; exec @ARGV or exit 127' "$_t_secs" "$@"; }
# Same, with Homebrew on PATH (for watched binaries and brew itself).
TB() { _t_secs=$1; shift; env PATH="$BREW_PATH" HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_ENV_HINTS=1 perl -e 'alarm shift; exec @ARGV or exit 127' "$_t_secs" "$@"; }
# sh has no local variables: emit's names must not collide with the callers'.
emit() {
  _emit_out=$1; shift
  for _emit_field in "$@"; do _emit_out="$_emit_out	$(printf '%s' "$_emit_field" | tr '\t\r\n' '   ')"; done
  printf '%s\n' "$_emit_out"
}
expand_home() { case $1 in "~/"*) printf '%s/%s' "$HOME" "${1#\~/}";; *) printf '%s' "$1";; esac; }

emit HOST "$(hostname -s 2>/dev/null || hostname)" Darwin "$(id -un)" "$ROOT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# --- operating system and hardware -------------------------------------------------------
emit OS "$(sw_vers -productName 2>/dev/null)" "$(sw_vers -productVersion 2>/dev/null)" "$(sw_vers -buildVersion 2>/dev/null)" "$(uname -r)" "$(uname -m)"
emit HW "$(sysctl -n hw.model 2>/dev/null)" "$(sysctl -n machdep.cpu.brand_string 2>/dev/null)" "$(sysctl -n hw.memsize 2>/dev/null)" "$(sysctl -n hw.ncpu 2>/dev/null)"
emit UPTIME "$(sysctl -n kern.boottime 2>/dev/null | sed -n 's/.*sec = \([0-9]*\).*/\1/p')"

# --- pending Apple updates (contacts Apple; can take a minute) ------------------------------
swu=$(T 150 softwareupdate -l 2>&1 </dev/null); swu_rc=$?
if printf '%s\n' "$swu" | grep -q 'No new software available'; then emit SWU_NONE
elif printf '%s\n' "$swu" | grep -q 'Label:'; then
  printf '%s\n' "$swu" | grep -E '^\* Label:|Title:' | while IFS= read -r swu_line; do emit SWU "$swu_line"; done
else emit SWU_ERR "rc=$swu_rc $(printf '%s' "$swu" | tail -2 | tr '\n' ' ' | cut -c1-200)"; fi
for k in AutomaticCheckEnabled AutomaticDownload AutomaticallyInstallMacOSUpdates CriticalUpdateInstall ConfigDataInstall; do
  v=$(defaults read /Library/Preferences/com.apple.SoftwareUpdate "$k" 2>/dev/null) || v=unset
  emit AUTO "$k" "$v"
done

# --- host protection -----------------------------------------------------------------------
FWB=/usr/libexec/ApplicationFirewall/socketfilterfw
emit FW global "$($FWB --getglobalstate 2>/dev/null | sed -n 's/.*State = \([0-9]\).*/\1/p')"
emit FW stealth "$($FWB --getstealthmode 2>/dev/null | grep -qi 'is on' && echo on || echo off)"
emit FW blockall "$($FWB --getblockall 2>/dev/null | grep -qi 'enabled' && echo on || echo off)"
emit FW allowsigned "$($FWB --getallowsigned 2>/dev/null | head -1 | grep -qi 'enabled' && echo on || echo off)"
if pf=$(R pfctl -s info </dev/null 2>/dev/null); then
  emit PF "$(printf '%s\n' "$pf" | sed -n 's/^Status: \([A-Za-z]*\).*/\1/p' | head -1)" "$(R pfctl -s rules </dev/null 2>/dev/null | grep -c .)"
else emit PF unknown; fi
emit FV "$(fdesetup status 2>/dev/null | head -1)"
emit SIP "$(csrutil status 2>/dev/null | head -1)"
emit GK "$(spctl --status 2>/dev/null | head -1)"

if launchctl print system/com.openssh.sshd </dev/null >/dev/null 2>&1; then emit SSHD remotelogin on; else emit SSHD remotelogin off; fi
if sshdt=$(R sshd -T </dev/null 2>/dev/null); then
  printf '%s\n' "$sshdt" | grep -Ei '^(passwordauthentication|kbdinteractiveauthentication|permitrootlogin|pubkeyauthentication|allowusers|allowtcpforwarding) ' \
    | while IFS=' ' read -r k v; do emit SSHD "$k" "$v"; done
else emit SSHD effective unknown; fi
for svc in com.apple.screensharing com.apple.smbd com.apple.RemoteDesktop.agent; do
  if launchctl print "system/$svc" </dev/null >/dev/null 2>&1; then emit SHARE "$svc" loaded; else emit SHARE "$svc" off; fi
done

if ls=$(R lsof +c 0 -nP -iTCP -sTCP:LISTEN </dev/null 2>/dev/null); then
  printf '%s\n' "$ls" | awk 'NR>1{print $1"\t"$3"\t"$9}' | sort -u | while IFS='	' read -r cmd user addr; do emit LISTEN "$cmd" "$user" "$addr"; done
else
  netstat -an -p tcp 2>/dev/null | awk '/LISTEN/{print $4}' | sort -u | while IFS= read -r addr; do emit LISTEN "?" "?" "$addr"; done
fi

# --- watched software ----------------------------------------------------------------------
printf '%s\n' "$SPECS" | while IFS='|' read -r id kind a b label; do
  [ -n "$id" ] || continue
  case $kind in
    brew)
      found=
      for f in $(printf '%s' "$a" | tr ',' ' '); do
        p=$(readlink "/opt/homebrew/opt/$f" 2>/dev/null) || continue
        ver=${p##*/}
        tap=$(grep -o '"tap": *"[^"]*"' "/opt/homebrew/Cellar/$f/$ver/INSTALL_RECEIPT.json" 2>/dev/null | head -1 | sed 's/.*: *"\(.*\)"/\1/')
        emit SW "$id" brew "$ver" "$f" "$tap"; found=1; break
      done
      [ -n "$found" ] || emit SW "$id" missing "" "/opt/homebrew/opt/$a";;
    cask)
      ver=$(ls -t "/opt/homebrew/Caskroom/$a" 2>/dev/null | grep -v '^\.' | head -1)
      if [ -n "$ver" ]; then emit SW "$id" cask "$ver" "$a"; else emit SW "$id" missing "" "$a"; fi;;
    app)
      ap=$(expand_home "$a")
      ver=$(plutil -extract CFBundleShortVersionString raw "$ap/Contents/Info.plist" 2>/dev/null)
      if [ -n "$ver" ]; then emit SW "$id" app "$ver" "$ap" "$(plutil -extract CFBundleVersion raw "$ap/Contents/Info.plist" 2>/dev/null)"
      else emit SW "$id" missing "" "$ap"; fi;;
    cmd)
      # A glob can match several installs (llama-b8670, llama-b11200): report each one and mark the
      # binary that is running now, so the collector shows the one in use.
      pat=$(expand_home "$a")
      case $pat in *'*'*) cands=$(ls -d $pat 2>/dev/null);; *) cands=$pat;; esac
      hits=0
      running_bins=$(ps -axo comm= 2>/dev/null)
      printf '%s\n' "$cands" | while IFS= read -r bin; do
        [ -n "$bin" ] && [ -x "$bin" ] || continue
        out=$(TB 20 "$bin" $b </dev/null 2>&1 | grep -Ev '^[[:space:]]*$|load_backend|ggml_metal|^\[mem\]' | head -3 | tr '\n' ' ')
        if printf '%s\n' "$running_bins" | grep -Fxq "$bin"; then emit SW "$id" cmd "$out" "$bin" running; else emit SW "$id" cmd "$out" "$bin"; fi
      done
      printf '%s\n' "$cands" | while IFS= read -r bin; do [ -n "$bin" ] && [ -x "$bin" ] && exit 0; done || emit SW "$id" missing "" "$pat";;
    pydist)
      norm=$(printf '%s' "$b" | tr 'A-Z-' 'a-z_')
      hits=0
      for site in $(expand_home "$a"); do
        for d in "$site"/*.dist-info; do
          [ -d "$d" ] || continue
          base=${d##*/}; base=${base%.dist-info}
          name=$(printf '%s' "${base%-*}" | tr 'A-Z-' 'a-z_')
          [ "$name" = "$norm" ] || continue
          emit SW "$id" pydist "${base##*-}" "$site"; hits=$((hits+1))
        done
      done
      [ "$hits" -gt 0 ] || emit SW "$id" missing "" "$a";;
    json)
      jf=$(expand_home "$a")
      ver=$(grep -o "\"${b:-version}\" *: *\"[^\"]*\"" "$jf" 2>/dev/null | head -1 | sed 's/.*: *"\(.*\)"/\1/')
      if [ -n "$ver" ]; then emit SW "$id" json "$ver" "$jf"; else emit SW "$id" missing "" "$jf"; fi;;
    *) emit SW "$id" unsupported "" "$kind";;
  esac
  if [ -n "$label" ]; then
    case $label in
      system/*) if st=$(launchctl print "$label" </dev/null 2>/dev/null); then pid=$(printf '%s\n' "$st" | awk '$1=="pid"{print $3; exit}'); emit RUN "$id" "${pid:-loaded}" "$label"; else emit RUN "$id" absent "$label"; fi;;
      *) if st=$(launchctl list "$label" </dev/null 2>/dev/null); then pid=$(printf '%s\n' "$st" | sed -n 's/.*"PID" = \([0-9]*\);.*/\1/p'); emit RUN "$id" "${pid:-loaded}" "$label"; else emit RUN "$id" absent "$label"; fi;;
    esac
  fi
done

# --- other outdated Homebrew packages (uses brew's cached metadata; no `brew update`) --------
if [ -x /opt/homebrew/bin/brew ]; then
  TB 120 /opt/homebrew/bin/brew outdated --verbose </dev/null 2>/dev/null \
    | sed -n 's/^\([^ ]*\) (\(.*\)) [<!]=* \(.*\)$/\1	\2	\3/p' \
    | while IFS='	' read -r name have want; do emit BREWOUT "$name" "$have" "$want"; done
fi

# --- containers ----------------------------------------------------------------------------
if [ -x /opt/homebrew/bin/docker ]; then
  TB 15 docker ps --format '{{.Names}}	{{.Image}}	{{.Status}}' </dev/null 2>/dev/null | while IFS='	' read -r name image status; do
    created=$(TB 10 docker image inspect --format '{{.Created}}' "$image" </dev/null 2>/dev/null)
    emit DOCKER "$name" "$image" "$status" "$created"
  done
fi

emit END ok
