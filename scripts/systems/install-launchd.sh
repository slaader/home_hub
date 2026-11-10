#!/bin/sh
# Install the launchd jobs that keep the collected snapshots fresh, on the Mac that runs Home Hub:
#   <prefix>.systems-collect   every 6 h   node scripts/collect-systems.mjs   (machines over SSH → data/systems)
#   <prefix>.systems-upstream  every 12 h  node scripts/check-upstream.mjs    (public release feeds)
#   <prefix>.security-collect  every 24 h  node scripts/collect-security.mjs  (SSH keys → data/security), with --with-security
# <prefix> is --label-prefix (default local.home-hub). Use the prefix the jobs were installed with to
# update or remove them: the labels are the jobs' identity.
# All run once at load, as the logged-in user (they need ~/.ssh/config and its keys), at low priority.
# The collectors are read-only on the machines they probe. On Linux use the units in examples/systemd/.
#   sh scripts/systems/install-launchd.sh [--repo DIR] [--data DIR] [--node PATH] [--label-prefix P] [--with-security]   install or update
#   sh scripts/systems/install-launchd.sh --print [...]      print the property lists; install nothing
#   sh scripts/systems/install-launchd.sh --uninstall [...]  remove the jobs
set -eu
REPO=$(cd "$(dirname "$0")/../.." && pwd)
DATA=
NODE=$(command -v node 2>/dev/null || echo /opt/homebrew/bin/node)
UNINSTALL=0
PRINT=0
SECURITY=0
PREFIX=local.home-hub
while [ $# -gt 0 ]; do
  case $1 in
    --repo) REPO=$(cd "$2" && pwd); shift 2;;
    --data) DATA=$2; shift 2;;
    --node) NODE=$2; shift 2;;
    --label-prefix) PREFIX=$2; shift 2;;
    --with-security) SECURITY=1; shift;;
    --print) PRINT=1; shift;;
    --uninstall) UNINSTALL=1; shift;;
    *) echo "unknown option: $1" >&2; exit 2;;
  esac
done
case $PREFIX in
  ''|*[!A-Za-z0-9._-]*) echo "--label-prefix may contain letters, digits, dot, underscore and hyphen only" >&2; exit 2;;
esac
DATA=${DATA:-$REPO/data}
AGENTS=$HOME/Library/LaunchAgents
LOGS=$HOME/Library/Logs/home-hub-v2
xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

plist() { # label script interval
  cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$1</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml "$NODE")</string>
    <string>$(xml "$REPO/scripts/$2")</string>
    <string>--data</string>
    <string>$(xml "$DATA")</string>
  </array>
  <key>WorkingDirectory</key><string>$(xml "$REPO")</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>StartInterval</key><integer>$3</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>Nice</key><integer>10</integer>
  <key>StandardOutPath</key><string>$(xml "$LOGS/$1.log")</string>
  <key>StandardErrorPath</key><string>$(xml "$LOGS/$1.log")</string>
</dict>
</plist>
PLIST
}

job() { # label script interval
  label=$1 script=$2 interval=$3 file=$AGENTS/$1.plist
  if [ "$PRINT" = 1 ]; then echo "# $file"; plist "$label" "$script" "$interval"; return; fi
  domain=gui/$(id -u)
  launchctl bootout "$domain/$label" 2>/dev/null || true
  if [ "$UNINSTALL" = 1 ]; then rm -f "$file"; echo "removed $label"; return; fi
  [ -f "$REPO/scripts/$script" ] || { echo "missing $REPO/scripts/$script" >&2; exit 1; }
  mkdir -p "$AGENTS" "$LOGS"
  plist "$label" "$script" "$interval" > "$file"
  plutil -lint "$file" >/dev/null
  launchctl bootstrap "$domain" "$file"
  echo "installed $label (every $interval s) → $file"
}

job "$PREFIX.systems-collect" collect-systems.mjs 21600
job "$PREFIX.systems-upstream" check-upstream.mjs 43200
# The key inventory is opt-in on install; an uninstall removes it whether or not it was there.
if [ "$SECURITY" = 1 ] || [ "$UNINSTALL" = 1 ]; then job "$PREFIX.security-collect" collect-security.mjs 86400; fi
[ "$UNINSTALL" = 1 ] || [ "$PRINT" = 1 ] || echo "repo $REPO · data $DATA · logs $LOGS"
