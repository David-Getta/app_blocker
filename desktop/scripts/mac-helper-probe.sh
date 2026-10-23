#!/bin/bash
# A BECSOMAGOLT segéd próbája macOS-en (CI, macos-latest, a futó felhasználója
# jelszó nélküli sudo-val) — a védett futtatókörnyezettel (#151).
#
# A rendszerjoggal futó segéd nem az app-csomagból fut (azt az app tulajdonosa
# írhatja), hanem egy csak root által írható helyről, a hivatalos Node.js-szel
# (shared/runtime-shell.ts). A próba pontosan azt csinálja, amit a felület
# (src/main/install.ts) — csak az osascript jelszó-ablaka marad ki:
#   M. KÖLTÖZÉS: előbb a RÉGI elrendezés (a LaunchDaemon az app binárisát
#      indítja ELECTRON_RUN_AS_NODE-dal) — így telepítettek eddig minden gépen
#      —, aztán az ÚJ telepítő parancsa: a segéd átköltözik, a régi folyamat
#      eltűnik, a leíró a futtatókörnyezet Node-ját indítja;
#   A. a futtatókörnyezet: root:wheel 0700, minden a rooté, semmi nem írható
#      másnak, nincs ACL, a Node aláírója a Node.js Foundation; a sima
#      felhasználó bele se lát; a futó segéd semmit nem tart nyitva az appból;
#   2. az app módján: csatlakozik a socketre, felvesz egy oldalt, és a rendszer
#      feloldójával nézi, hogy tilt-e; a status kimondja, honnan fut;
#   2c. AZ ŐR a helyén (a telepítő teszi fel, a segéd tartja);
#   2k. K1 — A REGRESSZIÓS PRÓBA: a sima felhasználó (sudo nélkül) kicseréli az
#      app binárisát egy csomagolóra, ami feljegyzi, hogy elindult, és
#      elrontja az app.asar-t és a segéd csomagját. Egy újraindítás (kickstart,
#      bootout + bootstrap, mint egy rendszerindításkor) és az őr után sem fut
#      rootként semmi az appból, a segéd tilt;
#   2d. az app eltűnik: a segéd tovább fut és tilt (a futtatókörnyezetből fut),
#      az őr nem ír; egy leállítás után a launchd újraindítja;
#   2u. CSENDES FRISSÍTÉS: a sima felhasználó egy aláírt, újabb csomagot kínál
#      fel a socketen — a segéd átveszi, jelszó nélkül, a leíró nem változik;
#      egy kicserélt csomagot, egy régebbit, egy idegen kulccsal aláírtat és
#      egy FIFO-t elutasít, gyorsan; egy el nem induló (aláírt) frissítés után
#      az őr visszaáll az előzőre, és a csomagot feljegyzi;
#   2r. a futtatókörnyezet eltűnik: az őr a szigorú blokkot tartja (a kézzel
#      kivettet és a magára hagyott jelölő mellé is visszateszi; őr nélkül
#      kivéve marad); visszatéve a segéd újra fut;
#   2h. a segéd nem indul (elrontott belépési pont a futtatókörnyezetben): öt
#      perc után a szigorú blokk; javítva újra fut;
#   3. a VALÓDI eltávolító — a segéd által a gépre tett MÁSOLATA — után semmi
#      nem marad;
#   F. FRISS TELEPÍTÉS egy tiszta gépre (az eltávolító a naplómappát is vitte):
#      a segéd elindul és tilt; aztán megint eltávolítás.
# Kilépési kód 0, ha minden stimmel; különben 1.
#
# Használat (a desktop mappából, egy kész csomag mellett; a csomag a
# BREAKER_HELPER_TEST_PUBKEY-vel épült, a titkos fele PROBE_KEY-ben):
#   PROBE_KEY=…/probe-key.pem bash scripts/mac-helper-probe.sh release/mac-arm64/Breaker.app
set -u
cd "$(dirname "$0")/.."
APP="$(cd "$(dirname "${1:?a .app útja kell}")" && pwd)/$(basename "$1")"
EXE="$APP/Contents/MacOS/Breaker"
ENTRY="$APP/Contents/Resources/app.asar/dist/helper/index.js"
PAYLOAD="$APP/Contents/Resources/helper/payload.tar"
DOMAIN="${PROBE_DOMAIN:-example.org}"
LABEL=hu.breaker.helper
PLIST=/Library/LaunchDaemons/$LABEL.plist
SOCK=/var/run/breaker.sock
GLABEL=hu.breaker.guard
GPLIST=/Library/LaunchDaemons/$GLABEL.plist
SDIR="/Library/Application Support/Breaker"
RT="$SDIR/runtime"
LOG="$SDIR/helper.log"
NOTE='a teljes lista tilt'
K1MARK=/tmp/breaker-k1-ran
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
current_of() { sudo readlink "$RT/current" 2>/dev/null; }
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
# Egy parancs a segédnek, a sima felhasználóként (ahogy az app): a válasz JSON-ja.
helper_call() {
  node -e "
    const s = require('net').connect(process.argv[1]);
    const t = setTimeout(() => { console.log('{\"timeout\":true}'); process.exit(1); }, Number(process.argv[3] || 30000));
    let buf = '';
    s.on('connect', () => s.write(process.argv[2] + '\n'));
    s.on('data', (d) => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) { clearTimeout(t); console.log(buf.slice(0, i)); process.exit(0); } });
    s.on('error', (e) => { clearTimeout(t); console.log(JSON.stringify({ error: String(e) })); process.exit(1); });
  " "$SOCK" "$1" "${2:-30000}"
}
status_field() {
  helper_call '{"id":1,"op":"status"}' | node -e "
    let s = ''; process.stdin.on('data', (d) => { s += d; }).on('end', () => {
      try { const r = JSON.parse(s); const v = (r.data || {})[process.argv[1]]; process.stdout.write(v === undefined ? '' : (typeof v === 'string' ? v : JSON.stringify(v))); } catch { }
    });" "$1"
}
layout_is_root() { [ "$(status_field helperLayout)" = root ]; }
stat_of() { sudo stat -f '%Su %Lp' "$1" 2>&1; }
show_state() {
  echo "--- az őr naplója ---"; sudo cat "$SDIR/guard.log" 2>&1 | tail -20
  echo "--- a segéd naplója ---"; sudo tail -40 "$LOG" 2>&1
  echo "--- a segéd démonja ---"; sudo launchctl print system/$LABEL 2>&1 | grep -E 'state|pid|last exit|runs|program|path' | head
  echo "--- a futtatókörnyezet ---"; sudo ls -la "$RT" 2>&1
  echo "--- a hosts fájl ---"; cat /etc/hosts
}

[ -x "$EXE" ] || { echo "HIBA: nincs meg a becsomagolt app: $EXE"; exit 1; }
[ -f "$PAYLOAD" ] || { echo "HIBA: nincs meg a segéd csomagja: $PAYLOAD"; exit 1; }
[ -n "${PROBE_KEY:-}" ] && [ -f "$PROBE_KEY" ] || { echo "HIBA: a próba kulcsa (PROBE_KEY) hiányzik"; exit 1; }
[ "$(id -u)" != 0 ] || { echo "HIBA: a próbát a sima felhasználó futtassa (a telepítő is az), ne root"; exit 1; }
if [ -e "$PLIST" ] || [ -e "$SOCK" ]; then
  echo "HIBA: már van segéd ezen a gépen — a próba nem tiszta gépen fut"; exit 1
fi
HOSTS_BEFORE=$(mktemp)
cp /etc/hosts "$HOSTS_BEFORE"
WORK=$(mktemp -d)
rm -f "$K1MARK"

# A Node tarball — ahogy a felület: a felhasználó gyorsítótárába, ellenőrizve.
NODE_TAR=$(node -e "
  const r = require('./dist/shared/helper-runtime.js');
  process.stdout.write(require('path').join(require('os').homedir(), 'Library/Caches/hu.breaker.app/node', r.nodeTarName('arm64')));
")
mkdir -p "$(dirname "$NODE_TAR")"
if [ ! -f "$NODE_TAR" ]; then
  URL=$(node -e "process.stdout.write(require('./dist/shared/helper-runtime.js').nodeTarUrls('arm64')[1])")
  curl -fsSL --retry 3 -o "$NODE_TAR" "$URL" || { echo "HIBA: a Node tarballt nem tudtam letölteni: $URL"; exit 1; }
fi

# A telepítő parancsa — ugyanabból a kódból, amit a felület futtat.
install_cmd() {
  node -e "
    const r = require('./dist/shared/runtime-shell.js');
    const g = require('./dist/shared/guard-script.js');
    const info = require('./dist/main/helper-payload.json');
    process.stdout.write(r.macRootCommand(r.macInstallScript({
      ownerUid: Number(process.argv[1]), payloadTar: process.argv[2], payloadSha256: info.sha256, payloadSize: info.size,
      nodeTar: process.argv[3] || null, guardScript: g.macGuardScript(), guardPlist: g.macGuardPlist(),
    })));
  " "$(id -u)" "$PAYLOAD" "${1:-$NODE_TAR}"
}
run_install() {
  local cmd out
  cmd=$(install_cmd "$@") || { bad "a telepítő parancsa nem állt össze"; return 1; }
  out=$(sudo /bin/sh -c "$cmd" 2>&1)
  local rc=$?
  echo "a telepítő: $out"
  [ $rc = 0 ] && echo "$out" | grep -Eq '^ok [0-9a-f]{16}$'
}

# M. A RÉGI ELRENDEZÉS — így telepítettek eddig minden gépen —, aztán a költözés.
LEGACY=$(node -e "
  const s = require('./dist/shared/install-script.js');
  process.stdout.write(s.macInstallShell(s.launchdPlist(process.argv[1], process.argv[2], Number(process.argv[3]))));
" "$EXE" "$ENTRY" "$(id -u)") || { echo "HIBA: a régi telepítő parancsa nem állt össze"; exit 1; }
sudo /bin/sh -c "$LEGACY" || bad "a régi telepítő nem futott le"
wait_for 60 helper_running || bad "a régi elrendezésben a segéd nem indult el"
wait_for 30 node -e "require('net').connect('$SOCK').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))" \
  || bad "a régi segéd nem felel"
[ "$(status_field helperLayout)" = bundle ] || bad "a régi elrendezésben a status nem bundle: $(status_field helperLayout)"
LEGACY_PID=$(helper_pid)
run_install || bad "a költöztető telepítés nem sikerült"
B1=$(current_of)
echo "a futtatókörnyezet változata: $B1"
[ -n "$B1" ] || bad "nincs current link"
sudo /usr/libexec/PlistBuddy -c 'Print :ProgramArguments:0' "$PLIST" | grep -qx "$RT/current/node" \
  || bad "a leíró nem a futtatókörnyezet Node-ját indítja: $(sudo cat "$PLIST")"
# A más felhasználó folyamatának parancssorát a sima felhasználó nem látja: sudo.
[ -n "$LEGACY_PID" ] && sudo ps -p "$LEGACY_PID" -o command= 2>/dev/null | grep -qF "$ENTRY" \
  && bad "a régi segéd folyamata a költözés után is fut"
sudo pgrep -f "$ENTRY" >/dev/null && bad "az app.asar-ból futó segéd a költözés után is fut"
wait_for 30 layout_is_root || bad "a status nem root: $(status_field helperLayout)"
[ "$(status_field helperRuntime)" = "$B1" ] || bad "a status más változatot mond: $(status_field helperRuntime)"

# A. A FUTTATÓKÖRNYEZET.
[ "$(sudo stat -f '%Su:%Sg %Lp' "$RT")" = "root:wheel 700" ] || bad "a futtatókörnyezet: $(sudo stat -f '%Su:%Sg %Lp' "$RT")"
[ -z "$(sudo find "$RT/$B1" \( ! -user 0 -o -perm -0020 -o -perm -0002 -o -type l \) -print | head -n 1)" ] \
  || bad "a változatban idegen, írható vagy link: $(sudo find "$RT/$B1" \( ! -user 0 -o -perm -0020 -o -perm -0002 -o -type l \) -print | head -n 3)"
sudo ls -leR "$RT" | grep -Eq '^ [0-9]+: ' && bad "ACL a futtatókörnyezetben"
[ -z "$(sudo xattr -lr "$RT/$B1" 2>/dev/null)" ] || bad "kiterjesztett attribútum a futtatókörnyezetben: $(sudo xattr -lr "$RT/$B1" | head -3)"
sudo codesign -dv "$RT/$B1/node" 2>&1 | grep -q '^TeamIdentifier=HX7739G8FX$' || bad "a Node aláírója: $(sudo codesign -dv "$RT/$B1/node" 2>&1 | grep -E 'Team|Authority' | head -3)"
[ "$(sudo stat -f '%Su' "$RT/current")" = root ] || bad "a current link nem a rooté"
ls "$RT" >/dev/null 2>&1 && bad "a sima felhasználó belát a futtatókörnyezetbe"
touch "$RT/x" 2>/dev/null && bad "a sima felhasználó írhat a futtatókörnyezetbe"
OURS=$(ls /Library/LaunchDaemons | grep -c '^hu\.breaker\.')
[ "$OURS" = 2 ] || bad "a LaunchDaemons alatt nem két leírónk van: $(ls /Library/LaunchDaemons | grep '^hu\.breaker\.')"
HPID=$(helper_pid)
sudo lsof -p "$HPID" 2>/dev/null | grep -F "$APP" && bad "a futó segéd az appból tart nyitva fájlt"
sudo launchctl print system/$LABEL | grep -F "$APP" && bad "a segéd indítása az appra hivatkozik"
[ "$(stat_of "$LOG")" = "root 644" ] || [ "$(stat_of "$LOG")" = "root 600" ] || bad "a segéd naplója: $(stat_of "$LOG")"

# 2. AZ APP MÓDJÁN: a futó felhasználóként, a socketen át.
node scripts/helper-probe-client.js "$SOCK" "$DOMAIN" || bad "a segéd nem tilt (lásd fent)"
[ "$fail" = 0 ] || show_state
sudo grep -q "BREAKER BLOCK BEGIN" /etc/hosts || bad "a hosts-ban nincs Breaker-blokk"
ls -l "$SOCK" 2>/dev/null | grep -q "^s.* $(id -un) " || bad "a socket nem a telepítő felhasználóé: $(ls -l "$SOCK" 2>&1)"

# 2c. AZ ŐR.
wait_for 30 guard_loaded || bad "az őr nincs betöltve"
[ "$(stat_of "$GPLIST")" = "root 644" ] || bad "az őr leírója: $(stat_of "$GPLIST")"
[ "$(stat_of "$SDIR/guard.sh")" = "root 755" ] || bad "az őr szkriptje: $(stat_of "$SDIR/guard.sh")"
wait_for 30 sudo test -f "$SDIR/strict-hosts" || bad "nincs szigorú blokk"
sudo grep -qx "0.0.0.0 $DOMAIN" "$SDIR/strict-hosts" || bad "a szigorú blokkban nincs benne: $DOMAIN"
wait_for 30 sudo cmp -s "$SDIR/uninstall-macos.sh" scripts/uninstall-macos.sh \
  || bad "az eltávolító másolata hiányzik, vagy eltér a csomagolttól"
has_note && bad "az őr akkor is a szigorú blokkot írta, amikor a segéd futott"

# 2k. K1: A SIMA FELHASZNÁLÓ MÓDOSÍTJA AZ APPOT (sudo nélkül). A csomagoló
# feljegyzi, ha bárki elindítja; az app.asar és a segéd csomagja elrontva.
mv "$EXE" "$EXE.real" || bad "a binárist nem tudtam félretenni (a próba felhasználója nem írja az appot?)"
printf '#!/bin/sh\nid -u >> %s\nexec "$0.real" "$@"\n' "$K1MARK" > "$EXE" && chmod 755 "$EXE"
cp "$APP/Contents/Resources/app.asar" "$WORK/app.asar.good"
cp "$PAYLOAD" "$WORK/payload.tar.good"
printf 'K1' >> "$APP/Contents/Resources/app.asar"
printf 'K1' >> "$PAYLOAD"
sleep 30
sudo launchctl kickstart -k system/$LABEL || bad "kickstart -k"
wait_for 60 layout_is_root || bad "a kickstart után a segéd nem a futtatókörnyezetből fut"
# Mint egy rendszerindítás: ki és be a lemezen lévő leíróval, az őrrel együtt.
sudo launchctl bootout system/$LABEL; sleep 2
sudo launchctl bootstrap system "$PLIST" || bad "bootstrap"
sudo launchctl kickstart -k system/$GLABEL >/dev/null 2>&1
wait_for 60 layout_is_root || bad "az „újraindítás” után a segéd nem a futtatókörnyezetből fut"
sleep 20
[ -e "$K1MARK" ] && bad "K1: az app módosított binárisa elindult: $(cat "$K1MARK")"
wait_for 15 blocked || bad "K1 után a segéd nem tilt: $DOMAIN"
has_note && bad "K1 után az őr a szigorú blokkot írta (a segéd fut)"
mv -f "$EXE.real" "$EXE"
cp "$WORK/app.asar.good" "$APP/Contents/Resources/app.asar"
cp "$WORK/payload.tar.good" "$PAYLOAD"

# 2d. AZ APP ELTŰNIK: a segéd a futtatókörnyezetből fut tovább, és tilt; az őr
# nem ír; leállítva a launchd újraindítja (nincs mit indítania az appból).
PID0=$(helper_pid)
mv "$APP" "$APP.away" || bad "az appot nem tudtam elmozdítani"
sleep 60
[ -n "$PID0" ] && [ "$(helper_pid)" = "$PID0" ] || bad "a segéd az app eltűnésére kilépett (pid: $PID0 → $(helper_pid))"
has_note && bad "az app eltűnése után az őr a szigorú blokkot írta"
wait_for 15 blocked || bad "az app eltűnése után a segéd nem tilt"
sudo launchctl kill SIGKILL system/$LABEL || bad "a segédet nem tudtam leállítani"
wait_for 60 layout_is_root || bad "leállítás után, app nélkül, a segéd nem indult újra"
sleep 70
has_note && bad "app nélkül, futó segéd mellett az őr a szigorú blokkot írta"
mv "$APP.away" "$APP" || bad "az appot nem tudtam visszatenni"
[ "$fail" = 0 ] || show_state

# 2u. CSENDES FRISSÍTÉS: egy új csomag, aláírva a próba kulcsával — a segéd a
# saját futtatókörnyezetében lévő próba-kulcsot ismeri (test-keys.json).
TESTPUB=$(node -e "
  const k = require('crypto').createPublicKey(require('fs').readFileSync(process.argv[1]));
  process.stdout.write(k.export({ format: 'der', type: 'spki' }).toString('base64'));
" "$PROBE_KEY")
# make_bundle <név> <appVersion> [crash] → egy app-csomag helper mappája, a
# próba kulcsával aláírva. A „crash” változat önellenőrzése átmegy, de a segéd
# indulása elhasal: egy aláírt, mégis rossz kiadás.
make_bundle() {
  local dir="$WORK/$1.app/Contents/Resources/helper" root="$WORK/$1.root"
  mkdir -p "$dir" "$root" && cp -R dist "$root/dist" || return 1
  if [ "${3:-}" = crash ]; then
    sed -i '' 's/^function runHelper() {$/function runHelper() { throw new Error("probe-crash");/' "$root/dist/helper/index.js"
    grep -q 'probe-crash' "$root/dist/helper/index.js" || { echo "HIBA: a nem induló csomag nem állt össze" >&2; return 1; }
  fi
  node -e "
    require('./scripts/pack-helper-payload.js').pack({
      root: process.argv[1], out: process.argv[2], infoPath: process.argv[1] + '/info.json', appVersion: process.argv[3], testPubkey: process.argv[4],
    });
  " "$root" "$dir" "$2" "$TESTPUB" >/dev/null || return 1
  HELPER_SIGNING_KEY="$(cat "$PROBE_KEY")" BREAKER_HELPER_TEST_PUBKEY="$TESTPUB" node scripts/sign-helper-manifest.js "$dir" >/dev/null || return 1
  echo "$dir"
}
# sign_with <mappa> <kulcsfájl>: a leírót egy idegen kulccsal írja alá, a
# próba kulcsának azonosítójával — mint aki a kulcsot hamisítaná.
sign_with() {
  node -e "
    const fs = require('fs'), crypto = require('crypto'), path = require('path');
    const m = JSON.parse(fs.readFileSync(path.join(process.argv[1], 'manifest.json'), 'utf8'));
    const bytes = Buffer.from(JSON.stringify({ ...m, keyId: 'ci-test' }, null, 2) + '\n');
    const key = crypto.createPrivateKey(fs.readFileSync(process.argv[2]));
    fs.writeFileSync(path.join(process.argv[1], 'manifest.json'), bytes);
    fs.writeFileSync(path.join(process.argv[1], 'manifest.sig'), crypto.sign(null, bytes, key).toString('base64') + '\n');
  " "$1" "$2"
}
offer() { # offer <mappa> → a válasz update mezője
  helper_call "{\"id\":1,\"op\":\"helper_update_offer\",\"bundle\":\"$1\"}" 120000 | node -e "
    let s = ''; process.stdin.on('data', (d) => { s += d; }).on('end', () => {
      try { const r = JSON.parse(s); process.stdout.write(JSON.stringify((r.data || {}).update || r)); } catch { process.stdout.write(s); }
    });"
}
current_is() { [ "$(current_of)" = "$1" ]; }
current_moved_from() { local c; c=$(current_of); [ -n "$c" ] && [ "$c" != "$1" ]; }
ok_mark() { sudo test -e "$RT/.ok-$1"; }
app_version_is() { [ "$(status_field helperAppVersion)" = "$1" ]; }
rolled_back_to() { current_is "$1" && sudo test -s "$RT/.bad"; }
PLIST_SHA=$(sudo shasum -a 256 "$PLIST" | cut -d' ' -f1)
# Elutasítva, gyorsan, változás nélkül: kicserélt csomag, régebbi, idegen kulcs, FIFO.
if D=$(make_bundle tampered 99.0.0); then
  printf 'x' >> "$D/payload.tar"
  R=$(offer "$D"); echo "kicserélt csomag: $R"
  echo "$R" | grep -q '"error":"mismatch"' || bad "a kicserélt csomag nem mismatch: $R"
else bad "a kicserélt csomag nem állt össze"; fi
if D=$(make_bundle older 0.0.1); then
  R=$(offer "$D"); echo "régebbi: $R"
  echo "$R" | grep -q '"error":"not-newer"' || bad "a régebbi csomag: $R"
else bad "a régebbi csomag nem állt össze"; fi
node -e "
  const { privateKey } = require('crypto').generateKeyPairSync('ed25519');
  require('fs').writeFileSync(process.argv[1], privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
" "$WORK/stranger.pem"
if D=$(make_bundle stranger 99.0.0) && sign_with "$D" "$WORK/stranger.pem"; then
  R=$(offer "$D"); echo "idegen kulcs: $R"
  echo "$R" | grep -q '"error":"unsigned"' || bad "az idegen kulccsal aláírt csomag: $R"
else bad "az idegen kulcsos csomag nem állt össze"; fi
if D=$(make_bundle fifo 99.0.0) && rm -f "$D/manifest.json" && mkfifo "$D/manifest.json"; then
  T0=$(date +%s); R=$(offer "$D"); T1=$(date +%s); echo "FIFO: $R ($((T1 - T0)) s)"
  echo "$R" | grep -q '"error":"copy"' || bad "a FIFO: $R"
  [ $((T1 - T0)) -le 10 ] || bad "a FIFO-s ajánlat $((T1 - T0)) másodpercig tartott"
else bad "a FIFO-s csomag nem állt össze"; fi
current_is "$B1" || bad "egy elutasított ajánlat után a current megváltozott: $(current_of)"
[ -e "$K1MARK" ] && bad "az elutasított ajánlatok közben valami az appból elindult"
# Átvéve: újabb, aláírt — jelszó nélkül, a leíró változatlan.
if D=$(make_bundle good 99.0.0); then
  R=$(offer "$D"); echo "aláírt, újabb: $R"
  echo "$R" | grep -q '"ok":true' || bad "az aláírt, újabb csomagot nem vette át: $R"
else bad "a jó csomag nem állt össze"; fi
wait_for 90 current_moved_from "$B1" || bad "a current nem állt át"
B2=$(current_of)
wait_for 90 ok_mark "$B2" || bad "az új változat nem jelentkezett (.ok-$B2)"
wait_for 60 app_version_is 99.0.0 || bad "a status nem az új verziót mondja: $(status_field helperAppVersion)"
[ "$(sudo shasum -a 256 "$PLIST" | cut -d' ' -f1)" = "$PLIST_SHA" ] || bad "a csendes frissítés a leírót is megváltoztatta"
sudo test -e "$RT/.pending" && bad "az elindult változat után is ott a .pending"
wait_for 15 blocked || bad "a frissítés után a segéd nem tilt"
# Egy aláírt, de el nem induló frissítés: az őr visszaáll az előzőre, és a
# csomagot feljegyzi, hogy többször ne vegye át.
if D=$(make_bundle crash 99.0.1 crash); then
  R=$(offer "$D"); echo "nem induló: $R"
  echo "$R" | grep -q '"ok":true' || bad "a nem induló (aláírt) csomagot nem vette át: $R"
else bad "a nem induló csomag nem állt össze"; fi
wait_for 420 rolled_back_to "$B2" || bad "az őr nem állt vissza az előző változatra (current: $(current_of))"
wait_for 120 app_version_is 99.0.0 || bad "a visszaállás után nem az előző fut: $(status_field helperAppVersion)"
# A visszaállás híre — vagy, ha közben a segéd magától újranézte a megjegyzett
# ajánlatot, az, hogy a csomag rossznak jelölt (a felület mindkettőre a javító sávot mutatja).
status_field helperUpdate | grep -Eq 'rolled-back|"error":"bad"' || bad "a status nem mondja a visszaállást: $(status_field helperUpdate)"
sudo grep -q 'visszaálltam az előzőre' "$SDIR/guard.log" || bad "az őr naplójában nincs: visszaálltam"
R=$(offer "$D"); echo "ugyanaz újra: $R"
echo "$R" | grep -Eq '"error":"(bad|cooldown)"' || bad "a visszaállított csomagot újra átvenné: $R"
current_is "$B2" || bad "a visszaállított csomag újbóli ajánlata után a current: $(current_of)"
wait_for 15 blocked || bad "a visszaállás után a segéd nem tilt"
[ "$fail" = 0 ] || show_state

# 2r. A FUTTATÓKÖRNYEZET ELTŰNIK (root teszi): a segéd kilép, a launchd nem
# tudja indítani, az őr a szigorú blokkot tartja.
sudo mv "$RT" "$RT.away" || bad "a futtatókörnyezetet nem tudtam elmozdítani"
wait_for 200 has_note || bad "a futtatókörnyezet nélkül az őr nem tette a helyére a szigorú blokkot"
sudo grep -q 'a segéd futtatókörnyezete nem található' "$SDIR/guard.log" || bad "az őr naplójában nincs: a futtatókörnyezet nem található"
grep -qx "0.0.0.0 $DOMAIN" /etc/hosts || bad "a hosts szigorú blokkjában nincs: $DOMAIN"
wait_for 15 blocked || bad "a szigorú blokk mellett a rendszer feloldója nem tilt"
[ "$(grep -c 'BREAKER BLOCK BEGIN' /etc/hosts)" = 1 ] || bad "a hosts-ban nem egy blokk van"
# 2e. A kézzel kivett blokkot visszateszi — a magára hagyott nyitó jelölő mellé is.
strip_block
has_block && bad "a próba nem tudta kivenni a blokkot"
wait_for 100 has_note || bad "a kézzel kivett szigorú blokkot az őr nem tette vissza"
BEGIN_LINE=$(node -e "process.stdout.write(require('./dist/shared/blocklist.js').MARKER_BEGIN)")
strip_block
printf '%s\n0.0.0.0 stale.example\n:: stale.example\n10.0.0.5 nas.probe\n' "$BEGIN_LINE" | sudo tee -a /etc/hosts >/dev/null
wait_for 100 has_note || bad "a magában maradt nyitó jelölő mellé az őr nem tette vissza a blokkot"
[ "$(grep -c 'BREAKER BLOCK BEGIN' /etc/hosts)" = 1 ] && [ "$(grep -c 'BREAKER BLOCK END' /etc/hosts)" = 1 ] \
  || bad "a felemás jelölők után nem egy blokk van"
[ "$(grep -c '^10\.0\.0\.5 nas\.probe$' /etc/hosts)" = 1 ] || bad "a félbemaradt blokk utáni saját sor elveszett"
sudo /bin/sh -c "grep -v '^10\.0\.0\.5 nas\.probe\$' /etc/hosts > /tmp/breaker-probe-hosts; cat /tmp/breaker-probe-hosts > /etc/hosts && rm -f /tmp/breaker-probe-hosts"
# 2f. ELLENPRÓBA: őr nélkül a kivett blokk kivéve marad.
sudo launchctl bootout system/$GLABEL 2>/dev/null
wait_for 10 guard_unloaded || bad "az őr nem állt le"
strip_block
sleep 75
has_block && bad "őr nélkül is visszakerült a blokk"
sudo launchctl bootstrap system "$GPLIST" || bad "az őr nem töltődött vissza"
wait_for 100 has_note || bad "visszatöltve az őr nem tette a helyére a szigorú blokkot"
# 2g. Visszatéve a segéd újra fut, a saját blokkját írja.
sudo mv "$RT.away" "$RT" || bad "a futtatókörnyezetet nem tudtam visszatenni"
sudo launchctl kickstart system/$LABEL >/dev/null 2>&1
wait_for 150 layout_is_root || bad "a visszatett futtatókörnyezetből a segéd nem indult el"
wait_for 90 no_note || bad "a visszatett segéd nem írta vissza a saját blokkját"
[ "$fail" = 0 ] || show_state

# 2h. A SEGÉD NEM INDUL (elrontott belépési pont, root teszi): öt perc után a
# szigorú blokk; javítva újra fut.
CUR=$(current_of)
sudo cp "$RT/$CUR/app/dist/helper/index.js" "$WORK/index.js.good"
sudo /bin/sh -c "printf 'throw new Error(\"probe\");\n' > '$RT/$CUR/app/dist/helper/index.js'"
sudo launchctl kickstart -k system/$LABEL
wait_for 600 has_note || bad "a nem induló segéd mellett az őr nem tette a helyére a szigorú blokkot"
sudo grep -q 'a segéd nem indul' "$SDIR/guard.log" || bad "az őr naplójában nincs: a segéd nem indul"
sudo cp "$WORK/index.js.good" "$RT/$CUR/app/dist/helper/index.js"
sudo launchctl kickstart -k system/$LABEL
wait_for 150 layout_is_root || bad "a javított segéd nem indult el"
wait_for 90 no_note || bad "a javított segéd nem írta vissza a saját blokkját"
[ "$fail" = 0 ] || show_state

# 3. A VALÓDI ELTÁVOLÍTÓ — a gépre tett másolat —, és utána semmi nem maradhat.
uninstall_check() {
  sudo sh "$SDIR/uninstall-macos.sh" >/dev/null || bad "az eltávolító hibával állt meg"
  sleep 1
  sudo launchctl print system/$LABEL >/dev/null 2>&1 && bad "a démon az eltávolítás után is fut"
  guard_loaded && bad "az őr az eltávolítás után is be van töltve"
  [ -e "$PLIST" ] && bad "a plist az eltávolítás után is megvan"
  [ -e "$GPLIST" ] && bad "az őr leírója az eltávolítás után is megvan"
  sudo test -e "$SDIR" && bad "az állapotmappa (a futtatókörnyezettel) az eltávolítás után is megvan"
  sudo pgrep -f "$RT" >/dev/null && bad "a segéd folyamata az eltávolítás után is fut"
  grep -q "BREAKER BLOCK" /etc/hosts && bad "a hosts-blokk az eltávolítás után is bent van"
  if [ -e "$SOCK" ] && node -e "require('net').connect('$SOCK').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"; then
    bad "az eltávolítás után is felel valaki a socketen"
  fi
}
uninstall_check
diff <(grep -v '^$' "$HOSTS_BEFORE") <(grep -v '^$' /etc/hosts) >/dev/null \
  || { bad "a hosts többi része megváltozott"; diff "$HOSTS_BEFORE" /etc/hosts; }

# F. FRISS TELEPÍTÉS egy tiszta gépre (a naplómappa sincs meg): elindul és tilt.
run_install || bad "a friss telepítés nem sikerült"
wait_for 30 layout_is_root || bad "friss telepítés után a status nem root"
node scripts/helper-probe-client.js "$SOCK" "$DOMAIN" || bad "friss telepítés után a segéd nem tilt"
[ "$fail" = 0 ] || show_state
uninstall_check
rm -f "$HOSTS_BEFORE" "$K1MARK"
rm -rf "$WORK"

if [ "$fail" = 0 ]; then
  echo "Segéd-próba OK (a régi elrendezésből átköltözik; a védett futtatókörnyezet rooté, 0700, ACL nélkül, a Node a Node.js Foundationé; a sima felhasználó módosított appja rootként sosem indul (K1); az app eltűnésére tovább tilt; aláírt csendes frissítés jelszó nélkül, a hamis ajánlatok elutasítva, egy el nem induló frissítés után visszaáll; a futtatókörnyezet nélkül a szigorú blokk áll; a nem induló segéd mellett öt perc után szigorú blokk; az eltávolító után semmi nem marad; friss gépre is települ)"
fi
exit "$fail"
