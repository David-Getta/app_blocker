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

echo "A böngészők DoH-házirendjének levétele..."
# Csak azt vesszük le, amit a Breaker írt (lásd src/helper/doh-policy.ts): a
# Chromium-család „off” értékét és a Firefox DNSOverHTTPS szótárát, ha a
# mieink. A felügyelt (MDM) házirend máshol él — azt ez nem érinti.
for d in /Library/Preferences/com.google.Chrome /Library/Preferences/com.microsoft.Edge \
         /Library/Preferences/org.chromium.Chromium /Library/Preferences/com.brave.Browser; do
  if [ "$(defaults read "$d" DnsOverHttpsMode 2>/dev/null)" = "off" ]; then
    defaults delete "$d" DnsOverHttpsMode 2>/dev/null || true
  fi
done
FF_DOH=$(defaults read /Library/Preferences/org.mozilla.firefox DNSOverHTTPS 2>/dev/null || true)
case "$FF_DOH" in
  *"Enabled = 0;"*"Locked = 1;"*)
    defaults delete /Library/Preferences/org.mozilla.firefox DNSOverHTTPS 2>/dev/null || true ;;
esac

echo "Állapotfájlok törlése..."
rm -rf "/Library/Application Support/Breaker" /Library/Logs/Breaker /var/run/breaker.sock

echo "Kész. Az alkalmazást a /Applications mappából kézzel töröld, ha szeretnéd."
