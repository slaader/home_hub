#!/bin/sh
# Install the launchd jobs that keep data/systems fresh, on the Mac that runs Home Hub:
#   <prefix>.systems-collect   every 6 h  node scripts/collect-systems.mjs  (machines over SSH)
#   <prefix>.systems-upstream  every 12 h node scripts/check-upstream.mjs   (public release feeds)
# <prefix> is --label-prefix (default local.home-hub). Use the prefix the jobs were installed with to
# update or remove them.
# Both run once at load, as the logged-in user (they need ~/.ssh/config and its keys), at low priority.
#   sh scripts/systems/install-launchd.sh [--repo DIR] [--data DIR] [--node PATH] [--label-prefix P]   install or update
#   sh scripts/systems/install-launchd.sh --uninstall                               remove both jobs
set -eu
REPO=$(cd "$(dirname "$0")/../.." && pwd)
DATA=
NODE=$(command -v node 2>/dev/null || echo /opt/homebrew/bin/node)
UNINSTALL=0
PREFIX=local.home-hub
while [ $# -gt 0 ]; do
  case $1 in
    --repo) REPO=$(cd "$2" && pwd); shift 2;;
    --data) DATA=$2; shift 2;;
    --node) NODE=$2; shift 2;;
    --label-prefix) PREFIX=$2; shift 2;;
    --uninstall) UNINSTALL=1; shift;;
    *) echo "unknown option: $1" >&2; exit 2;;
  esac
done
DATA=${DATA:-$REPO/data}
AGENTS=$HOME/Library/LaunchAgents
LOGS=$HOME/Library/Logs/home-hub-v2
DOMAIN=gui/$(id -u)
xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

job() { # label script interval
  label=$1 script=$2 interval=$3 plist=$AGENTS/$1.plist
  launchctl bootout "$DOMAIN/$label" 2>/dev/null || true
  if [ "$UNINSTALL" = 1 ]; then rm -f "$plist"; echo "removed $label"; return; fi
  [ -f "$REPO/scripts/$script" ] || { echo "missing $REPO/scripts/$script" >&2; exit 1; }
  mkdir -p "$AGENTS" "$LOGS"
  cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml "$NODE")</string>
    <string>$(xml "$REPO/scripts/$script")</string>
    <string>--data</string>
    <string>$(xml "$DATA")</string>
  </array>
  <key>WorkingDirectory</key><string>$(xml "$REPO")</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>StartInterval</key><integer>$interval</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>Nice</key><integer>10</integer>
  <key>StandardOutPath</key><string>$(xml "$LOGS/$label.log")</string>
  <key>StandardErrorPath</key><string>$(xml "$LOGS/$label.log")</string>
</dict>
</plist>
PLIST
  plutil -lint "$plist" >/dev/null
  launchctl bootstrap "$DOMAIN" "$plist"
  echo "installed $label (every $interval s) → $plist"
}

job "$PREFIX.systems-collect" collect-systems.mjs 21600
job "$PREFIX.systems-upstream" check-upstream.mjs 43200
[ "$UNINSTALL" = 1 ] || echo "repo $REPO · data $DATA · logs $LOGS"
