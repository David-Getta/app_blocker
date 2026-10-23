#!/bin/sh
# Breaker teljes eltávolítása macOS-en. Futtatás: sudo sh uninstall-macos.sh
set -e

echo "Breaker helper és őr leállítása és eltávolítása..."
# A segéd előbb: egy futó segéd induláskor újra telepítené az őrt. Az őr
# (hu.breaker.guard) a szigorú blokkot tartja, ha az app eltűnt — a
# hosts-takarítás csak utána jöhet, különben visszaírná.
launchctl bootout system/hu.breaker.helper 2>/dev/null || true
launchctl bootout system/hu.breaker.guard 2>/dev/null || true
for _ in 1 2 3 4 5 6 7 8 9 10; do
  launchctl print system/hu.breaker.helper >/dev/null 2>&1 \
    || launchctl print system/hu.breaker.guard >/dev/null 2>&1 \
    || break
  sleep 1
done
if launchctl print system/hu.breaker.helper >/dev/null 2>&1 || launchctl print system/hu.breaker.guard >/dev/null 2>&1; then
  echo "A segéd vagy az őr nem állt le — próbáld újra, vagy indítsd újra a gépet, és utána futtasd ezt." >&2
  exit 1
fi
rm -f /Library/LaunchDaemons/hu.breaker.helper.plist /Library/LaunchDaemons/hu.breaker.guard.plist

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
# Azt vesszük le, amit a Breaker ír (lásd src/helper/doh-policy.ts): a
# Chromium-család „off” értékét és a Firefox DNSOverHTTPS szótárát. ÉRTÉK
# SZERINT döntünk — azt, hogy ki írta, a beállítás nem tudja: egy ugyanilyen
# „off”, amit valaki más tett ide, ugyanígy megy. Ami MÁS értéket tart, az
# marad; amit a segéd a futása alatt felülírt, azt ez nem állítja vissza. A
# felügyelt (MDM) házirend máshol él (/Library/Managed Preferences) — azt ez
# nem érinti.
for d in /Library/Preferences/com.google.Chrome /Library/Preferences/com.microsoft.Edge \
         /Library/Preferences/org.chromium.Chromium /Library/Preferences/com.brave.Browser; do
  if [ "$(defaults read "$d" DnsOverHttpsMode 2>/dev/null)" = "off" ]; then
    defaults delete "$d" DnsOverHttpsMode 2>/dev/null || true
  fi
done
FF=/Library/Preferences/org.mozilla.firefox
FF_MARK="/Library/Application Support/Breaker/firefox-policy-switch"
FF_OURS=0
FF_DOH=$(defaults read $FF DNSOverHTTPS 2>/dev/null || true)
case "$FF_DOH" in
  *"Enabled = 0;"*"Locked = 1;"*)
    defaults delete $FF DNSOverHTTPS 2>/dev/null || true
    FF_OURS=1 ;;
esac
# A házirend-kapcsoló (EnterprisePoliciesEnabled). Ha a segéd kapcsolta be —
# előtte nem volt bekapcsolva, és ezt az első beírásakor feljegyezte —, vele megy:
# különben egy addig hatástalan idegen Firefox-házirend az eltávolítás után is
# élne, a böngésző „felügyelt” maradna. Feljegyzés nélkül (a v0.4.256 előtti
# segéd) csak akkor, ha rajta kívül semmi nem maradt: egy másik eszköz saját
# Firefox-házirendje enélkül hatástalanná válna.
if [ -f "$FF_MARK" ]; then
  defaults delete $FF EnterprisePoliciesEnabled 2>/dev/null || true
elif [ "$FF_OURS" = 1 ]; then
  FF_REST=$(defaults read $FF 2>/dev/null | tr -d ' \t\n' || true)
  if [ "$FF_REST" = "{EnterprisePoliciesEnabled=1;}" ]; then
    defaults delete $FF EnterprisePoliciesEnabled 2>/dev/null || true
  fi
fi

# A böngésző-DoH zár profil (hu.breaker.doh), ha a felhasználó a Kinézet
# panelről telepítette: nélküle a böngészők az eltávolítás után is
# „felügyeltek” maradnának, a titkosított DNS kötelezően kikapcsolva. Egy
# kézzel telepített (nem MDM-es) profilt a root levehet; ha mégsem sikerül,
# megmondjuk, hol veheti le a felhasználó.
if { profiles list -all 2>/dev/null || profiles list 2>/dev/null; } | grep -q 'hu\.breaker\.doh'; then
  echo "A böngésző-DoH zár profil eltávolítása..."
  profiles remove -identifier hu.breaker.doh >/dev/null 2>&1 || true
  if { profiles list -all 2>/dev/null || profiles list 2>/dev/null; } | grep -q 'hu\.breaker\.doh'; then
    echo "A „Breaker — böngésző-DoH zár” profil fent maradt: távolítsd el kézzel — Rendszerbeállítások › Általános › Eszközkezelés (régebbi macOS-en: Adatvédelem és biztonság › Profilok; macOS 12-n és előtte: Rendszerbeállítások › Profilok)."
  fi
fi

echo "Állapotfájlok törlése..."
rm -rf "/Library/Application Support/Breaker" /Library/Logs/Breaker /var/run/breaker.sock

echo "Kész. Az alkalmazást a /Applications mappából kézzel töröld, ha szeretnéd."
