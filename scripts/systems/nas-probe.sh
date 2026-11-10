#!/bin/sh
# Home Hub systems probe for the TrueNAS SCALE NAS. Read-only. One tab-separated record per
# line on stdout, ending with "END<TAB>ok":
#   OS, HW, UPTIME     TrueNAS version, Debian release, kernel, CPU, memory
#   TNUPDATE           pending TrueNAS update (update.status: train, new version, date, notes)
#   APP / APPUP        installed apps, their state and upgrade target (app.query, app.upgrade_summary)
#   SERVICE, FTP       system services (service.query) and FTP settings
#   SSHD               effective sshd settings (sshd -T)
#   NFT                packet filter: input hook policies and rule count (nft list ruleset)
#   LISTEN             listening TCP sockets with the owning process (ss)
#
# The middleware API (midclt) needs root, so the probe runs as an account with sudo
# (the collector connects through the nas-admin alias). It only calls *.query/*.config/
# update.status/app.upgrade_summary, which change nothing.
set -u
PATH=/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin
LC_ALL=C
export PATH LC_ALL
if [ "$(id -u)" = 0 ]; then ROOT=1; elif sudo -n true </dev/null 2>/dev/null; then ROOT=1; else ROOT=0; fi
R() { if [ "$(id -u)" = 0 ]; then "$@"; elif [ "$ROOT" = 1 ]; then sudo -n "$@"; else return 1; fi; }
mid() { R timeout "${MID_TIMEOUT:-60}" midclt call "$@" </dev/null 2>/dev/null; }
emit() {
  _emit_out=$1; shift
  for _emit_field in "$@"; do _emit_out="$_emit_out	$(printf '%s' "$_emit_field" | tr '\t\r\n' '   ')"; done
  printf '%s\n' "$_emit_out"
}

emit HOST "$(hostname -s 2>/dev/null || hostname)" Linux "$(id -un)" "$ROOT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
# shellcheck disable=SC1091
pretty=$(. /etc/os-release 2>/dev/null; printf '%s' "${PRETTY_NAME:-}")

if [ "$ROOT" != 1 ]; then emit ERROR "no sudo: TrueNAS middleware needs root"; fi
info=$(mid system.info)
emit OS TrueNAS "$(printf '%s' "$info" | jq -r '.version // empty' 2>/dev/null)" "$pretty" "$(uname -r)" "$(uname -m)"
emit HW "$(printf '%s' "$info" | jq -r '.system_product // empty' 2>/dev/null)" "$(printf '%s' "$info" | jq -r '.model // empty' 2>/dev/null)" "$(printf '%s' "$info" | jq -r '.physmem // empty' 2>/dev/null)" "$(printf '%s' "$info" | jq -r '.cores // empty' 2>/dev/null)"
emit UPTIME "$(printf '%s' "$info" | jq -r '.uptime_seconds // empty | floor' 2>/dev/null)"

# --- pending TrueNAS update (contacts the TrueNAS update server) -----------------------------
MID_TIMEOUT=120 mid update.status | jq -r '[.code // "", .status.current_version.train // "", .status.current_version.profile // "",
  .status.new_version.version // "", (.status.new_version.manifest.date // "" | tostring | .[0:10]),
  ((.status.new_version.release_notes // "") | split("\n") | map(select(test("^\\s*$")|not)) | map(sub("^#+\\s*";"")) | .[1:4] | join(" "))] | @tsv' 2>/dev/null \
  | while IFS='	' read -r code train profile newv date notes; do emit TNUPDATE "$code" "$train" "$profile" "$newv" "$date" "$notes"; done

# --- apps ------------------------------------------------------------------------------------
apps=$(mid app.query)
printf '%s' "$apps" | jq -r '.[] | [.name, .state, (.version // ""), (.human_version // ""), (.upgrade_available|tostring), (.image_updates_available|tostring), (.custom_app|tostring), (.metadata.train // ""), (.metadata.name // "")] | @tsv' 2>/dev/null \
  | while IFS='	' read -r name state ver human up img custom train app; do
      emit APP "$name" "$state" "$ver" "$human" "$up" "$img" "$custom" "$train" "$app"
      if [ "$up" = true ]; then
        mid app.upgrade_summary "$name" | jq -r '[.latest_version // "", .latest_human_version // "", .upgrade_human_version // ""] | @tsv' 2>/dev/null \
          | while IFS='	' read -r lv lh uh; do emit APPUP "$name" "$lv" "$lh" "$uh"; done
      fi
    done

# --- services and their exposure ---------------------------------------------------------------
mid service.query | jq -r '.[] | [.service, .state, (.enable|tostring)] | @tsv' 2>/dev/null \
  | while IFS='	' read -r svc state enable; do emit SERVICE "$svc" "$state" "$enable"; done
mid ftp.config | jq -r '[(.port|tostring), (.tls|tostring), (.onlyanonymous|tostring), (.onlylocal|tostring)] | @tsv' 2>/dev/null \
  | while IFS='	' read -r port tls anon local; do emit FTP "$port" "$tls" "$anon" "$local"; done
R sshd -T </dev/null 2>/dev/null | grep -Ei '^(passwordauthentication|kbdinteractiveauthentication|permitrootlogin|pubkeyauthentication|allowusers|allowtcpforwarding) ' \
  | while IFS=' ' read -r k v; do emit SSHD "$k" "$v"; done

# --- packet filter ---------------------------------------------------------------------------
if rules=$(R nft list ruleset </dev/null 2>/dev/null); then
  inputs=$(printf '%s\n' "$rules" | grep -E 'hook input' | sed -n 's/.*policy \([a-z]*\);.*/\1/p' | sort | uniq -c | awk '{printf "%s:%s ",$2,$1}')
  tables=$(printf '%s\n' "$rules" | awk '$1=="table"{print $2" "$3}' | tr '\n' ',' | sed 's/,$//')
  count=$(printf '%s\n' "$rules" | grep -cE '^\s+(ip|ip6|tcp|udp|ct|iif|iifname|oif|oifname|meta|counter|jump|goto|accept|drop|reject|th)\b')
  emit NFT "${inputs:-none}" "$count" "$tables"
else emit NFT unknown; fi

if ss=$(R ss -Htlnp </dev/null 2>/dev/null); then
  printf '%s\n' "$ss" | awk '{proc=$0; sub(/.*users:\(\("/,"",proc); sub(/".*/,"",proc); if(proc==$0)proc="?"; print proc"\t"$4}' | sort -u \
    | while IFS='	' read -r proc addr; do emit LISTEN "$proc" root "$addr"; done
fi

emit END ok
