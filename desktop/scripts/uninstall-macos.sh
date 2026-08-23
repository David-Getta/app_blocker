#!/bin/sh
# Breaker teljes eltávolítása macOS-en. Futtatás: sudo sh uninstall-macos.sh
set -e

echo "Breaker helper leállítása és eltávolítása..."
launchctl bootout system/hu.breaker.helper 2>/dev/null || true
rm -f /Library/LaunchDaemons/hu.breaker.helper.plist

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
