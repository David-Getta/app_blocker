#!/bin/bash
# A BECSOMAGOLT segéd próbája macOS-en (CI, macos-latest, a futó felhasználója
# jelszó nélküli sudo-val).
#
# A segéd élesben nem a sima Node-on fut, amin a többi próba, hanem az app
# saját binárisán: a LaunchDaemon ELECTRON_RUN_AS_NODE-dal indítja, a belépési
# pont az app.asar-ban van. Egy Electron-frissítés ezt az utat csendben
# eltörheti (egy kikapcsolt fuse, az asar olvasása node-módban, az aláírás) —
# az app közben hibátlanul indul, csak a tiltás szűnik meg minden gépen.
#
# Ezért a próba pontosan azt csinálja, amit a telepítő (src/main/install.ts):
#   1. a VALÓDI launchdPlist és macInstallShell kimenetét futtatja rootként —
#      csak az osascript jelszó-ablaka marad ki;
#   2. a futó felhasználóként, ahogy az app, csatlakozik a socketre, felvesz
#      egy oldalt, és a rendszer feloldójával nézi, hogy tilt-e
#      (helper-probe-client.js);
#   3. a VALÓDI eltávolító után a démon, a plist, a socket és a hosts-blokk is
#      eltűnik, a hosts többi része érintetlen.
# Kilépési kód 0, ha minden stimmel; különben 1.
#
# Használat (a desktop mappából, egy kész csomag mellett):
#   bash scripts/mac-helper-probe.sh release/mac-arm64/Breaker.app
set -u
cd "$(dirname "$0")/.."
APP="$(cd "$(dirname "${1:?a .app útja kell}")" && pwd)/$(basename "$1")"
EXE="$APP/Contents/MacOS/Breaker"
ENTRY="$APP/Contents/Resources/app.asar/dist/helper/index.js"
DOMAIN="${PROBE_DOMAIN:-example.org}"
LABEL=hu.breaker.helper
PLIST=/Library/LaunchDaemons/$LABEL.plist
SOCK=/var/run/breaker.sock
LOG=/Library/Logs/Breaker/helper.log
fail=0
bad() { echo "HIBA: $*"; fail=1; }

[ -x "$EXE" ] || { echo "HIBA: nincs meg a becsomagolt app: $EXE"; exit 1; }
[ "$(id -u)" != 0 ] || { echo "HIBA: a próbát a sima felhasználó futtassa (a telepítő is az), ne root"; exit 1; }
if [ -e "$PLIST" ] || [ -e "$SOCK" ]; then
  echo "HIBA: már van segéd ezen a gépen — a próba nem tiszta gépen fut"; exit 1
fi
HOSTS_BEFORE=$(mktemp)
cp /etc/hosts "$HOSTS_BEFORE"

# 1. A telepítő parancsa — ugyanabból a kódból, amit az app futtat.
CMD=$(node -e "
  const s = require('./dist/shared/install-script.js');
  process.stdout.write(s.macInstallShell(s.launchdPlist(process.argv[1], process.argv[2], Number(process.argv[3]))));
" "$EXE" "$ENTRY" "$(id -u)") || { echo "HIBA: a telepítő parancsa nem állt össze"; exit 1; }
sudo /bin/sh -c "$CMD" || bad "a telepítő parancsa nem futott le"
echo "a démon fent: $(sudo launchctl print system/$LABEL 2>/dev/null | grep -m1 -E '^\s*state =' | xargs)"

# 2. Az app módján: a futó felhasználóként, a socketen át.
node scripts/helper-probe-client.js "$SOCK" "$DOMAIN" || bad "a becsomagolt segéd nem tilt (lásd fent)"
if [ "$fail" != 0 ]; then
  echo "--- a démon állapota ---"; sudo launchctl print system/$LABEL 2>&1 | head -40
  echo "--- a segéd naplója ---"; sudo cat "$LOG" 2>&1 | tail -40
fi
sudo grep -q "BREAKER BLOCK BEGIN" /etc/hosts || bad "a hosts-ban nincs Breaker-blokk"
ls -l "$SOCK" 2>/dev/null | grep -q "^s.* $(id -un) " || bad "a socket nem a telepítő felhasználóé: $(ls -l "$SOCK" 2>&1)"

# 3. A valódi eltávolító — és utána semmi nem maradhat.
sudo sh scripts/uninstall-macos.sh >/dev/null || bad "az eltávolító hibával állt meg"
sleep 1
sudo launchctl print system/$LABEL >/dev/null 2>&1 && bad "a démon az eltávolítás után is fut"
[ -e "$PLIST" ] && bad "a plist az eltávolítás után is megvan"
pgrep -f "$ENTRY" >/dev/null && bad "a segéd folyamata az eltávolítás után is fut"
grep -q "BREAKER BLOCK" /etc/hosts && bad "a hosts-blokk az eltávolítás után is bent van"
# Üres sorok nélkül nézzük: a segéd egy üres sort tesz a blokk elé, és az
# eltávolító a blokkot veszi ki, azt nem (ahogy a mac-doh-probe.sh is).
diff <(grep -v '^$' "$HOSTS_BEFORE") <(grep -v '^$' /etc/hosts) >/dev/null \
  || { bad "a hosts többi része megváltozott"; diff "$HOSTS_BEFORE" /etc/hosts; }
rm -f "$HOSTS_BEFORE"
# A socket fájlja a démon után maradhat (a bootout nem törli) — a következő
# indulás felülírja. Ami számít: senki nem figyel rajta.
if [ -e "$SOCK" ] && node -e "require('net').connect('$SOCK').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"; then
  bad "az eltávolítás után is felel valaki a socketen"
fi

if [ "$fail" = 0 ]; then
  echo "Segéd-próba OK (a becsomagolt binárison, a telepítő módján indítva: felel, tilt; az eltávolító után nem fut, és a hosts a régi)"
fi
exit "$fail"
