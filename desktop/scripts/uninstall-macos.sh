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
# awk, nem python: a mai macOS-en python3 gyárilag nincs (a /usr/bin/python3
# csak a fejlesztőeszközök telepítését ajánlja fel), és a `set -e` miatt a
# szkript itt megállt volna — a tiltás bent marad. Csak ha mindkét jelölő
# megvan: egy csonka blokknál az awk a fájl végéig mindent kidobna.
if grep -q '^# >>> BREAKER BLOCK BEGIN' /etc/hosts && grep -q '^# <<< BREAKER BLOCK END' /etc/hosts; then
  HOSTS_TMP=$(mktemp)
  awk '/^# >>> BREAKER BLOCK BEGIN/ {skip=1} !skip {print} /^# <<< BREAKER BLOCK END/ {skip=0}' /etc/hosts > "$HOSTS_TMP"
  cat "$HOSTS_TMP" > /etc/hosts
  rm -f "$HOSTS_TMP"
fi
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
    defaults delete /Library/Preferences/org.mozilla.firefox DNSOverHTTPS 2>/dev/null || true
    # A házirend-kapcsolót (EnterprisePoliciesEnabled) csak akkor, ha rajta
    # kívül semmi nem maradt: egy másik eszköz saját Firefox-házirendje
    # enélkül hatástalanná válna.
    FF_REST=$(defaults read /Library/Preferences/org.mozilla.firefox 2>/dev/null | tr -d ' \t\n' || true)
    if [ "$FF_REST" = "{EnterprisePoliciesEnabled=1;}" ]; then
      defaults delete /Library/Preferences/org.mozilla.firefox EnterprisePoliciesEnabled 2>/dev/null || true
    fi ;;
esac

echo "Állapotfájlok törlése..."
rm -rf "/Library/Application Support/Breaker" /Library/Logs/Breaker /var/run/breaker.sock

echo "Kész. Az alkalmazást a /Applications mappából kézzel töröld, ha szeretnéd."
