#!/bin/sh
# Breaker teljes eltávolítása macOS-en. Futtatás: sudo sh uninstall-macos.sh
set -e

echo "Breaker helper leállítása és eltávolítása..."
launchctl bootout system/hu.breaker.helper 2>/dev/null || true
rm -f /Library/LaunchDaemons/hu.breaker.helper.plist

echo "A bejelentkezéskori indítás eltávolítása..."
# A felhasználói indító-ügynök a felhasználó saját mappájában van, nem a
# rendszeréban: sudo alatt a hívó felhasználóé ($SUDO_USER), különben a miénk.
AGENT_USER="${SUDO_USER:-$(id -un)}"
AGENT_HOME=$(eval echo "~$AGENT_USER")
AGENT_UID=$(id -u "$AGENT_USER" 2>/dev/null || echo "")
if [ -n "$AGENT_UID" ]; then
  launchctl bootout "gui/$AGENT_UID/hu.breaker.agent" 2>/dev/null || true
fi
rm -f "$AGENT_HOME/Library/LaunchAgents/hu.breaker.agent.plist"

echo "Hosts-bejegyzések eltávolítása..."
python3 - <<'PY'
import re
p = '/etc/hosts'
s = open(p).read()
s = re.sub(r'\n*# >>> BREAKER BLOCK BEGIN.*?# <<< BREAKER BLOCK END\n?', '\n', s, flags=re.S)
open(p, 'w').write(s)
PY
dscacheutil -flushcache || true
killall -HUP mDNSResponder || true

echo "Állapotfájlok törlése..."
rm -rf "/Library/Application Support/Breaker" /Library/Logs/Breaker /var/run/breaker.sock

echo "Kész. Az alkalmazást a /Applications mappából kézzel töröld, ha szeretnéd."
