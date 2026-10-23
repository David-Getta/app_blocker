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
#   2c. AZ ŐR (#149, shared/guard-script.ts): a segéd maga teszi fel — a
#      leíró, a szkript, a szigorú blokk és az eltávolító másolata a helyén;
#   2d. az app eltűnik (elmozdítjuk, mint egy Kukába húzáskor): a futó segéd
#      NEM lép ki (code-watch.ts csak naplóz), tovább tilt; ha leáll (mint egy
#      újraindításkor), az őr a szigorú blokkot teszi a hosts fájlba, és a
#      rendszer feloldója tilt;
#   2e. a kézzel kivett blokkot az őr visszateszi — akkor is, ha csak a nyitó
#      jelölő maradt a fájlban;
#   2f. ellenpróba: őr nélkül a kivett blokk kivéve marad — vagyis tényleg az
#      őr tartja, nem egy még futó segéd; visszatöltve megint beáll;
#   2g. az app visszakerül: a segéd újra fut, a saját blokkját írja, felel;
#   2h. az app a helyén van, de a segéd nem indul el (elrontott app.asar): a
#      futó segéd a cserére NEM lép ki (a rendszerjoggal futó kódot nem egy
#      fájlművelet cseréli); újraindításkor a launchd hiába indítja, és öt
#      perc után az őr a szigorú blokkot teszi a helyére; a javított app után a
#      segéd újra fut;
#   3. a VALÓDI eltávolító — a segéd által a gépre tett MÁSOLATA, amire a
#      szigorú blokk magyarázata mutat — után a démon, az őr, a plistek, a
#      socket, az állapotmappa és a hosts-blokk is eltűnik, a hosts többi része
#      érintetlen.
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
GLABEL=hu.breaker.guard
GPLIST=/Library/LaunchDaemons/$GLABEL.plist
SDIR="/Library/Application Support/Breaker"
NOTE='a teljes lista tilt'
fail=0
bad() { echo "HIBA: $*"; fail=1; }
# wait_for <másodperc> <parancs…>: másodpercenként próbálja, amíg igaz nem lesz.
wait_for() { local n=$1 i; shift; for ((i = 0; i < n; i++)); do "$@" && return 0; sleep 1; done; return 1; }
helper_running() { sudo launchctl print system/$LABEL 2>/dev/null | grep -Eq '^[[:space:]]*pid = [0-9]+$'; }
helper_pid() { sudo launchctl print system/$LABEL 2>/dev/null | sed -n 's/^[[:space:]]*pid = \([0-9][0-9]*\)$/\1/p' | head -n 1; }
guard_loaded() { sudo launchctl print system/$GLABEL >/dev/null 2>&1; }
guard_unloaded() { ! guard_loaded; }
has_note() { grep -q "$NOTE" /etc/hosts; }
no_note() { ! grep -q "$NOTE" /etc/hosts; }
has_block() { grep -q 'BREAKER BLOCK BEGIN' /etc/hosts; }
# A blokk kézi kivétele — ahogy egy root felhasználó tenné; a fájl helyben marad.
strip_block() {
  sudo /bin/sh -c "awk '/^# >>> BREAKER BLOCK BEGIN/{s=1} !s{print} /^# <<< BREAKER BLOCK END/{s=0}' /etc/hosts > /tmp/breaker-probe-hosts && cat /tmp/breaker-probe-hosts > /etc/hosts && rm -f /tmp/breaker-probe-hosts"
}
# A rendszer feloldója a tiltó címet adja-e (a böngésző útja, hosts-szal együtt).
blocked() {
  node -e "
    const { isSinkhole } = require('./dist/shared/selftest.js');
    require('dns').promises.lookup(process.argv[1], { all: true }).then(
      (a) => process.exit(a.length > 0 && a.every((x) => isSinkhole(x.address)) ? 0 : 1),
      () => process.exit(1));
  " "$DOMAIN"
}
stat_of() { sudo stat -f '%Su %Lp' "$1" 2>&1; }
show_guard() {
  echo "--- az őr naplója ---"; sudo cat "$SDIR/guard.log" 2>&1 | tail -20
  echo "--- a segéd naplója ---"; sudo tail -30 "$LOG" 2>&1
  echo "--- a segéd démonja ---"; sudo launchctl print system/$LABEL 2>&1 | grep -E 'state|pid|last exit|runs' | head
  echo "--- a hosts fájl ---"; cat /etc/hosts
}

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

# 2c. AZ ŐR. A telepítő parancsa nem tud róla: a segéd teszi fel induláskor,
# rootként — a meglévő telepítéseken is, újabb jelszókérés nélkül.
wait_for 30 guard_loaded || bad "az őr 30 másodperc alatt sem töltődött be (a segéd nem tette fel)"
[ "$(stat_of "$GPLIST")" = "root 644" ] || bad "az őr leírója: $(stat_of "$GPLIST")"
[ "$(stat_of "$SDIR/guard.sh")" = "root 755" ] || bad "az őr szkriptje: $(stat_of "$SDIR/guard.sh")"
[ "$(stat_of "$SDIR/strict-hosts")" = "root 600" ] || bad "a szigorú blokk: $(stat_of "$SDIR/strict-hosts")"
sudo grep -qx "0.0.0.0 $DOMAIN" "$SDIR/strict-hosts" || bad "a szigorú blokkban nincs benne: $DOMAIN"
sudo cmp -s "$SDIR/uninstall-macos.sh" scripts/uninstall-macos.sh \
  || bad "az eltávolító másolata hiányzik, vagy eltér a csomagolttól"
sudo grep -q 'az őr a helyén' "$LOG" || bad "a segéd naplójában nincs: az őr a helyén"
has_note && bad "az őr akkor is a szigorú blokkot írta, amikor az app a helyén volt"

# 2d. AZ APP ELTŰNIK. A futó segéd NEM lép ki: a törölt appból tovább tilt a
# beállított szabályokkal (egy kilépés után a launchd — vagy az őr — azt
# indítaná újra rendszerjoggal, ami épp az app helyén van).
# Csak naplóz; az őr élőnek látja, és nem ír. Ha leáll — itt leállítjuk, mint
# egy újraindításkor —, a launchd nem tudja elindítani, és az őr a következő
# percében a szigorú blokkot teszi a hosts fájlba.
PID0=$(helper_pid)
mv "$APP" "$APP.away" || bad "az appot nem tudtam elmozdítani"
sleep 90
[ -n "$PID0" ] && [ "$(helper_pid)" = "$PID0" ] \
  || bad "a segéd az app eltűnésére kilépett vagy újraindult (pid: $PID0 → $(helper_pid))"
wait_for 60 sudo grep -q 'az app eltűnt: a segéd a beállított szabályokkal tovább tilt' "$LOG" \
  || bad "a segéd naplójában nincs: az app eltűnt"
has_note && bad "a futó segéd mellett az őr a szigorú blokkot írta"
wait_for 15 blocked || bad "az app eltűnése után a futó segéd nem tilt: $DOMAIN"
sudo launchctl kill SIGKILL system/$LABEL || bad "a segédet nem tudtam leállítani"
wait_for 150 has_note || bad "az őr nem tette a helyére a szigorú blokkot"
grep -qx "0.0.0.0 $DOMAIN" /etc/hosts || bad "a hosts szigorú blokkjában nincs: $DOMAIN"
wait_for 15 blocked || bad "a szigorú blokk mellett a rendszer feloldója nem tilt: $DOMAIN"
[ "$(grep -c 'BREAKER BLOCK BEGIN' /etc/hosts)" = 1 ] || bad "a hosts-ban nem egy blokk van"

# 2e. A kézzel kivett blokkot visszateszi — akkor is, ha a nyitó jelölő ott
# maradt (felemás jelölők: az őr rendbe teszi, nem hagyja annyiban).
strip_block
has_block && bad "a próba nem tudta kivenni a blokkot"
wait_for 100 has_note || bad "a kézzel kivett szigorú blokkot az őr nem tette vissza"
BEGIN_LINE=$(node -e "process.stdout.write(require('./dist/shared/blocklist.js').MARKER_BEGIN)")
strip_block
# Félbemaradt írás: a nyitó jelölő után a régi blokk egy darabja, záró nélkül,
# utána egy később hozzáfűzött saját sor (az a blokkon kívül marad).
printf '%s\n0.0.0.0 stale.example\n:: stale.example\n10.0.0.5 nas.probe\n' "$BEGIN_LINE" | sudo tee -a /etc/hosts >/dev/null
has_note && bad "a próba nem tudta kivenni a blokkot (a nyitó jelölő mellől)"
wait_for 100 has_note || bad "a magában maradt nyitó jelölő mellé az őr nem tette vissza a blokkot"
[ "$(grep -c 'BREAKER BLOCK BEGIN' /etc/hosts)" = 1 ] && [ "$(grep -c 'BREAKER BLOCK END' /etc/hosts)" = 1 ] \
  || bad "a felemás jelölők után nem egy blokk van: $(grep -c 'BREAKER BLOCK' /etc/hosts) jelölő"
# A darab tiltó sorai a blokkba kerülnek (egyszer), nem maradnak kívül kezeletlenül.
[ "$(grep -c '^0\.0\.0\.0 stale\.example$' /etc/hosts)" = 1 ] \
  && awk '/BREAKER BLOCK BEGIN/{s=1} s&&/^0\.0\.0\.0 stale\.example$/{f=1} /BREAKER BLOCK END/{s=0} END{exit f?0:1}' /etc/hosts \
  || bad "a félbemaradt blokk tiltó sora nem a blokkba került (vagy kívül is ott maradt)"
[ "$(grep -c '^10\.0\.0\.5 nas\.probe$' /etc/hosts)" = 1 ] \
  && awk '/BREAKER BLOCK BEGIN/{s=1} s&&/^10\.0\.0\.5 nas\.probe$/{f=1} /BREAKER BLOCK END/{s=0} END{exit f?1:0}' /etc/hosts \
  || bad "a félbemaradt blokk utáni saját sor elveszett (vagy a blokkba került)"
# A próba saját sorát kivesszük: a végén a hosts többi része a régi kell legyen.
sudo /bin/sh -c "grep -v '^10\.0\.0\.5 nas\.probe\$' /etc/hosts > /tmp/breaker-probe-hosts; cat /tmp/breaker-probe-hosts > /etc/hosts && rm -f /tmp/breaker-probe-hosts"
grep -q 'nas\.probe' /etc/hosts && bad "a próba saját sorát nem tudtam kivenni"

# 2f. ELLENPRÓBA: őr nélkül a kivett blokk kivéve marad — tehát az előbb
# tényleg az őr tette vissza, nem egy még futó segéd.
sudo launchctl bootout system/$GLABEL 2>/dev/null
wait_for 10 guard_unloaded || bad "az őr nem állt le"
strip_block
sleep 75
has_block && bad "őr nélkül is visszakerült a blokk — akkor nem az őr tartja (fut még a segéd?)"
sudo launchctl bootstrap system "$GPLIST" || bad "az őr nem töltődött vissza"
wait_for 60 has_note || bad "visszatöltve az őr nem tette a helyére a szigorú blokkot"

# 2g. AZ APP VISSZAKERÜL: a segéd újra fut (a launchd vagy az őr indítja), és a
# saját blokkját írja — a magyarázó sor eltűnik, a tiltás marad.
mv "$APP.away" "$APP" || bad "az appot nem tudtam visszatenni"
wait_for 120 helper_running || bad "az app visszatétele után a segéd nem indult el"
wait_for 60 no_note || bad "a visszatett app segédje nem írta vissza a saját blokkját"
grep -qx "0.0.0.0 $DOMAIN" /etc/hosts || bad "a segéd blokkjából hiányzik: $DOMAIN"
wait_for 30 node -e "require('net').connect('$SOCK').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))" \
  || bad "a visszatett app segédje nem felel a socketen"

# 2h. A SEGÉD NEM INDUL, PEDIG AZ APP A HELYÉN VAN. A futó segéd az app.asar
# cseréjére NEM lép ki, csak naplóz: a rendszerjoggal futó kódot nem egy
# fájlművelet cseréli. Újraindításkor (itt: kickstart -k) a launchd
# hiába indítja (az üres archívumból nem tud); az őr indítgatja, és öt perc
# után a szigorú blokkot teszi a helyére — a befagyott blokk helyett. A
# javított app után a segéd újra fut.
ASAR="$APP/Contents/Resources/app.asar"
PID1=$(helper_pid)
mv "$ASAR" "$ASAR.good" && : > "$ASAR" || bad "az app.asar-t nem tudtam elrontani"
sleep 90
[ -n "$PID1" ] && [ "$(helper_pid)" = "$PID1" ] \
  || bad "a segéd az app.asar cseréjére kilépett vagy újraindult (pid: $PID1 → $(helper_pid))"
wait_for 60 sudo grep -q 'az app frissült: a segéd a következő indulásig a régi kódon fut' "$LOG" \
  || bad "a segéd naplójában nincs: az app frissült"
sudo launchctl kickstart -k system/$LABEL || bad "a segédet nem tudtam újraindítani"
wait_for 600 has_note || bad "a nem induló segéd mellett az őr nem tette a helyére a szigorú blokkot"
sudo grep -q 'a segéd nem indul' "$SDIR/guard.log" || bad "az őr naplójában nincs: a segéd nem indul"
rm -f "$ASAR" && mv "$ASAR.good" "$ASAR" || bad "az app.asar-t nem tudtam visszatenni"
wait_for 150 helper_running || bad "a javított app segédje nem indult el"
wait_for 60 no_note || bad "a javított app segédje nem írta vissza a saját blokkját"
[ "$fail" = 0 ] || show_guard

# 3. A valódi eltávolító — a segéd által a gépre tett másolat, amire a szigorú
# blokk magyarázata mutat —, és utána semmi nem maradhat.
sudo sh "$SDIR/uninstall-macos.sh" >/dev/null || bad "az eltávolító hibával állt meg"
sleep 1
sudo launchctl print system/$LABEL >/dev/null 2>&1 && bad "a démon az eltávolítás után is fut"
guard_loaded && bad "az őr az eltávolítás után is be van töltve"
[ -e "$PLIST" ] && bad "a plist az eltávolítás után is megvan"
[ -e "$GPLIST" ] && bad "az őr leírója az eltávolítás után is megvan"
sudo test -e "$SDIR" && bad "az állapotmappa (a szigorú blokkal, az őrrel) az eltávolítás után is megvan"
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
  echo "Segéd-próba OK (a becsomagolt binárison, a telepítő módján indítva: felel, tilt; az őrt maga teszi fel; az app eltűnésére és cseréjére nem lép ki, tovább tilt; ha leáll, és az app nincs meg, az őr a szigorú blokkot tartja — kézi kivétel és felemás jelölő után is; az app visszatételekor újra fut; ha a segéd nem indul, öt perc után a szigorú blokk áll be; az eltávolító másolata után semmi nem fut, és a hosts a régi)"
fi
exit "$fail"
