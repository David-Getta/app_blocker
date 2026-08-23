#!/bin/sh
# Lakat teljes eltávolítása macOS-en. Futtatás: sudo sh uninstall-macos.sh
set -e

echo "Lakat helper leállítása és eltávolítása..."
launchctl bootout system/hu.lakat.helper 2>/dev/null || true
rm -f /Library/LaunchDaemons/hu.lakat.helper.plist

echo "Hosts-bejegyzések eltávolítása..."
python3 - <<'PY'
import re
p = '/etc/hosts'
s = open(p).read()
s = re.sub(r'\n*# >>> LAKAT BLOCK BEGIN.*?# <<< LAKAT BLOCK END\n?', '\n', s, flags=re.S)
open(p, 'w').write(s)
PY
dscacheutil -flushcache || true
killall -HUP mDNSResponder || true

echo "Állapotfájlok törlése..."
rm -rf "/Library/Application Support/Lakat" /Library/Logs/Lakat /var/run/lakat.sock

echo "Kész. Az alkalmazást a /Applications mappából kézzel töröld, ha szeretnéd."
