#!/bin/bash
# A böngészők DoH-házirendjének és az eltávolítónak a próbája macOS-en
# (CI, macos-latest, sudo-val: a segéd rootként írja a gépszintű beállításokat).
#
# A VALÓDI applyDohPolicies írja be (a lefordított dist/helper/hosts.js), utána
# a VALÓDI eltávolító szkript fut. A próba azt nézi, hogy
#   1. a beírás után mind a négy Chromium-tartományban ott az „off”, a plist a
#      felhasználónak olvasható, és a Firefoxnál a DNSOverHTTPS mellett a
#      házirend-kapcsoló (EnterprisePoliciesEnabled) is igaz — nélküle a
#      Firefox macOS-en egyetlen házirendet sem olvas;
#   2. az eltávolítás — python NÉLKÜL (a PATH-on egy python, ami nem fut, mint
#      egy gyári Macen) — után a mieink eltűntek, egy IDEGEN érték és egy
#      idegen Firefox-házirend viszont marad, a hosts-blokk kikerül, a hosts
#      többi része érintetlen;
#   3. a kapcsolót, ha a segéd kapcsolta be (előtte hiányzott vagy hamis
#      volt), az eltávolító leveszi — akkor is, ha mellette egy idegen (addig
#      hatástalan) Firefox-házirend áll; ha viszont már a segéd előtt be volt
#      kapcsolva, marad;
#   4. feljegyzés nélkül (a v0.4.256 előtti segéd) a kapcsoló csak akkor megy,
#      ha a Firefox-tartományban már csak a miénk volt;
#   5. a DoH-zár profil a valódi plutil szerint érvényes, és ugyanazt
#      kényszeríti, amit a segéd beállít;
#   6. a DoH-zár állapota azt mondja, amit a böngésző tényleg olvasna: kezelt
#      érték (a felhasználóé erősebb a gépénél) → kötelező; a Firefox a segéd
#      gépszintű házirendjével → zárolva a böngészőben, de a felhasználó saját
#      beállítása (az általános és a gépre kötött is) felülírja.
# Kilépési kód 0, ha minden stimmel; különben 1.
set -u
cd "$(dirname "$0")/.."
NODE="${NODE:-node}"
fail=0
bad() { echo "HIBA: $*"; fail=1; }
rd() { defaults read "$1" "$2" 2>/dev/null; }
apply() {
  "$NODE" -e "require('./dist/helper/hosts').applyDohPolicies(console.log).then((ok) => process.exit(ok ? 0 : 1))" \
    || bad "az applyDohPolicies nem sikerült"
}
FF=/Library/Preferences/org.mozilla.firefox
MARK="/Library/Application Support/Breaker/firefox-policy-switch"
STATE_DIR_CREATED=0
[ -d "/Library/Application Support/Breaker" ] || STATE_DIR_CREATED=1

# Egy gyári Mac: a python3 csak a fejlesztőeszközök telepítését ajánlja fel.
# A futón van python, ezért a PATH elejére egy olyat teszünk, ami nem fut.
NOPY=$(mktemp -d)
for p in python python3; do printf '#!/bin/sh\necho "nincs python" >&2\nexit 127\n' > "$NOPY/$p"; chmod +x "$NOPY/$p"; done
NOPY_PATH="$NOPY:/usr/bin:/bin:/usr/sbin:/sbin"
env PATH="$NOPY_PATH" sh -c 'python3 -c 1' 2>/dev/null && bad "a python-rejtés nem működik — a próba nem nézné, hogy az eltávolító python nélkül is lefut"
uninstall() { env PATH="$NOPY_PATH" sh scripts/uninstall-macos.sh; }

# 0. Kiindulás: a gép hosts-fájlja, és egy idegen Firefox-házirend KAPCSOLÓ
# NÉLKÜL (valaki kihagyta a Mozilla leírásának „EnterprisePoliciesEnabled”
# lépését): a Breaker előtt hatástalan.
HOSTS_BEFORE=$(mktemp)
cp /etc/hosts "$HOSTS_BEFORE"
rm -f "$MARK"
defaults delete "$FF" EnterprisePoliciesEnabled 2>/dev/null
defaults write "$FF" DisableAppUpdate -bool true

# 1. A valódi segéd-kód írja be.
apply
for d in com.google.Chrome com.microsoft.Edge org.chromium.Chromium com.brave.Browser; do
  [ "$(rd "/Library/Preferences/$d" DnsOverHttpsMode)" = off ] || bad "$d: a DnsOverHttpsMode nem off"
  perms=$(stat -f %Lp "/Library/Preferences/$d.plist" 2>/dev/null)
  [ "$perms" = 644 ] || bad "$d.plist jogai: ${perms:-nincs fájl} (a böngésző nem olvasná)"
done
[ "$(rd "$FF" EnterprisePoliciesEnabled)" = 1 ] || bad "a Firefox házirend-kapcsolója nincs bekapcsolva — a DNSOverHTTPS hatástalan"
case "$(rd "$FF" DNSOverHTTPS)" in
  *"Enabled = 0;"*"Locked = 1;"*) ;;
  *) bad "a Firefox DNSOverHTTPS-e hiányzik" ;;
esac
[ -f "$MARK" ] || bad "a kapcsolót a segéd kapcsolta be, de nem jegyezte fel — az eltávolító nem tudná, hogy a miénk"

# 2. Egy idegen érték (valaki a Brave-et kézzel „secure”-ra állította) és egy hosts-blokk.
defaults write /Library/Preferences/com.brave.Browser DnsOverHttpsMode -string secure
printf '\n# >>> BREAKER BLOCK BEGIN — próba\n0.0.0.0 breaker-probe.example\n# <<< BREAKER BLOCK END\n' >> /etc/hosts

# 3. A valódi eltávolító, python nélkül.
uninstall || bad "az eltávolító hibával állt meg (python nélkül)"

for d in com.google.Chrome com.microsoft.Edge org.chromium.Chromium; do
  [ -z "$(rd "/Library/Preferences/$d" DnsOverHttpsMode)" ] || bad "$d: a mi „off” értékünk ott maradt"
done
[ "$(rd /Library/Preferences/com.brave.Browser DnsOverHttpsMode)" = secure ] || bad "az idegen Brave-érték eltűnt"
[ -z "$(rd "$FF" DNSOverHTTPS)" ] || bad "a Firefox DNSOverHTTPS-e ott maradt"
[ "$(rd "$FF" DisableAppUpdate)" = 1 ] || bad "az idegen Firefox-házirend eltűnt"
[ -z "$(rd "$FF" EnterprisePoliciesEnabled)" ] || bad "a kapcsolót a segéd kapcsolta be, mégis ott maradt — az idegen házirend, ami előtte hatástalan volt, most él"
grep -q 'BREAKER BLOCK' /etc/hosts && bad "a hosts-blokk ott maradt"
diff <(grep -v '^$' "$HOSTS_BEFORE") <(grep -v '^$' /etc/hosts) >/dev/null || bad "a hosts többi része megváltozott"

# 4. A kapcsoló már a segéd ELŐTT ott volt (egy másik eszköz kapcsolta be):
# nem a miénk — marad, a mellette álló idegen házirenddel együtt.
mkdir -p "/Library/Application Support/Breaker"
defaults write "$FF" EnterprisePoliciesEnabled -bool true
apply
[ -f "$MARK" ] && bad "a kapcsoló a segéd előtt is ott volt, mégis a miénknek jegyezte fel"
uninstall > /dev/null || bad "az eltávolító (második kör) hibával állt meg"
[ "$(rd "$FF" EnterprisePoliciesEnabled)" = 1 ] || bad "a kapcsoló eltűnt, pedig nem a segéd kapcsolta be, és egy idegen házirend még használja"
[ "$(rd "$FF" DisableAppUpdate)" = 1 ] || bad "az idegen Firefox-házirend eltűnt (második kör)"

# 5. Feljegyzés nélkül, és a tartományban már csak a miénk: a kapcsoló megy.
mkdir -p "/Library/Application Support/Breaker"
defaults delete "$FF" DisableAppUpdate
apply
uninstall > /dev/null || bad "az eltávolító (harmadik kör) hibával állt meg"
[ -z "$(rd "$FF" EnterprisePoliciesEnabled)" ] || bad "a házirend-kapcsoló ott maradt, pedig már csak a miénk volt"

# 5b. A kapcsoló a segéd előtt HAMIS volt, mellette egy idegen kulcs: a
# Firefoxnak ez ugyanaz, mint a hiány — a segéd kapcsolja be, tehát a miénk.
mkdir -p "/Library/Application Support/Breaker"
defaults write "$FF" EnterprisePoliciesEnabled -bool false
defaults write "$FF" DisableAppUpdate -bool true
apply
[ -f "$MARK" ] || bad "a kapcsoló a segéd előtt hamis volt, a segéd kapcsolta be, mégsem jegyezte fel"
uninstall > /dev/null || bad "az eltávolító (hamis kapcsoló) hibával állt meg"
[ -z "$(rd "$FF" EnterprisePoliciesEnabled)" ] || bad "a hamis kapcsolót a segéd kapcsolta be, mégis ott maradt — az idegen házirend most él"
[ "$(rd "$FF" DisableAppUpdate)" = 1 ] || bad "az idegen Firefox-házirend eltűnt (hamis kapcsoló)"
defaults delete "$FF" DisableAppUpdate

# 6. A DoH-zár profil (a felhasználó telepíti): a valódi plutil szerint
# érvényes plist, és ugyanazt kényszeríti, amit a segéd beállít.
PROFILE_DIR=$(mktemp -d)
PROFILE="$PROFILE_DIR/Breaker-DoH.mobileconfig"
"$NODE" -e "process.stdout.write(require('./dist/helper/doh-policy').dohProfileXml())" > "$PROFILE"
plutil -lint "$PROFILE" > /dev/null || bad "a DoH-zár profil nem érvényes plist (plutil -lint)"
plutil -convert json -o - "$PROFILE" | "$NODE" -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const p = JSON.parse(s);
    const prefs = p.PayloadContent[0];
    const f = (d) => prefs.PayloadContent[d].Forced[0].mcx_preference_settings;
    const ok = p.PayloadType === "Configuration" && p.PayloadRemovalDisallowed === false
      && prefs.PayloadType === "com.apple.ManagedClient.preferences"
      && ["com.google.Chrome", "com.microsoft.Edge", "org.chromium.Chromium", "com.brave.Browser"]
        .every((d) => f(d).DnsOverHttpsMode === "off")
      && f("org.mozilla.firefox").EnterprisePoliciesEnabled === true
      && f("org.mozilla.firefox").DNSOverHTTPS.Enabled === false
      && f("org.mozilla.firefox").DNSOverHTTPS.Locked === true;
    process.exit(ok ? 0 : 1);
  });' || bad "a DoH-zár profil szerkezete nem az, aminek lennie kell"
rm -rf "$PROFILE_DIR"

# 7. A DoH-zár állapota (dohLockState): azt mondja, amit a böngésző olvasna.
# Kezelt értékeket szimulálunk; a kiírás: kötelező|zárolva-a-böngészőben/összes.
MP="/Library/Managed Preferences"
ME=$(id -un)
MP_CREATED=0
[ -d "$MP" ] || { mkdir -p "$MP"; MP_CREATED=1; }
MP_USER_CREATED=0
[ -d "$MP/$ME" ] || { mkdir -p "$MP/$ME"; MP_USER_CREATED=1; }
lock() {
  "$NODE" -e "require('./dist/main/doh-lock-state').dohLockState().then((s) => console.log(s.forcedOff.join(',') + '|' + s.lockedInBrowser.join(',') + '/' + s.browsers.length))"
}
BEFORE_LOCK=$(lock)
[ "$BEFORE_LOCK" = "|/5" ] || bad "a próba előtt nincs mit mutatnia, mégis ezt mondja: $BEFORE_LOCK (a gép nem tiszta?)"
# A kezelt beállítást a rendszer (egy telepített profil) fájlként teszi ide;
# a próba is fájlként írja — a `defaults` ezt a mappát a cfprefsd-n át kezeli.
PB=/usr/libexec/PlistBuddy
"$PB" -c "Add :DnsOverHttpsMode string off" "$MP/com.google.Chrome.plist" > /dev/null
chmod 644 "$MP/com.google.Chrome.plist" 2>/dev/null
AFTER_LOCK=$(lock)
[ "$AFTER_LOCK" = "Chrome|/5" ] || bad "a DoH-zár állapota nem csak a kezelt Chrome-értéket látja: $AFTER_LOCK"
# A felhasználó kezelt beállítása erősebb a gépénél: ha ott más áll, a gépé
# hiába „off” — és a felhasználói „off” is kötelező.
"$PB" -c "Add :DnsOverHttpsMode string secure" "$MP/$ME/com.google.Chrome.plist" > /dev/null
"$PB" -c "Add :DnsOverHttpsMode string off" "$MP/$ME/com.microsoft.Edge.plist" > /dev/null
[ "$(lock)" = "Edge|/5" ] || bad "a felhasználó kezelt beállítását nem veszi erősebbnek a gépénél: $(lock)"
rm -f "$MP/$ME/com.google.Chrome.plist" "$MP/$ME/com.microsoft.Edge.plist"
# A Firefoxnál a kapcsoló NÉLKÜL a DNSOverHTTPS nem elég — a Firefox rá se néz.
"$PB" -c "Add :DNSOverHTTPS dict" -c "Add :DNSOverHTTPS:Enabled bool false" \
  -c "Add :DNSOverHTTPS:Locked bool true" "$MP/org.mozilla.firefox.plist" > /dev/null
case "$(lock)" in *Firefox*) bad "a Firefoxot zároltnak mondja a házirend-kapcsoló nélkül: $(lock)" ;; esac
"$PB" -c "Add :EnterprisePoliciesEnabled bool true" "$MP/org.mozilla.firefox.plist" > /dev/null
[ "$(lock)" = "Chrome,Firefox|/5" ] || bad "a DoH-zár állapota nem látja a kezelt Firefox-értéket: $(lock)"
rm -f "$MP/com.google.Chrome.plist" "$MP/org.mozilla.firefox.plist"
# A segéd gépszintű házirendje: a Chromium-családban csak ajánlás (nem
# kötelező), a Firefox viszont zárolja — de a felhasználó saját beállítása
# (egy `defaults write` a Terminálban) erősebb nála.
mkdir -p "/Library/Application Support/Breaker"
apply
[ "$(lock)" = "|Firefox/5" ] || bad "a segéd házirendjével a Firefox zárolva van a böngészőben, a többi csak ajánlás — ehelyett: $(lock)"
defaults write org.mozilla.firefox EnterprisePoliciesEnabled -bool false
[ "$(lock)" = "|/5" ] || bad "a felhasználó saját kapcsolója kikapcsolja a Firefox házirendjét, a sor mégis zároltnak mondja: $(lock)"
defaults delete org.mozilla.firefox EnterprisePoliciesEnabled 2>/dev/null
# A gépre kötött (ByHost) felhasználói tartomány még erősebb az általánosnál.
defaults -currentHost write org.mozilla.firefox EnterprisePoliciesEnabled -bool false
[ "$(lock)" = "|/5" ] || bad "a felhasználó gépre kötött (ByHost) kapcsolója kikapcsolja a Firefox házirendjét, a sor mégis zároltnak mondja: $(lock)"
defaults -currentHost delete org.mozilla.firefox EnterprisePoliciesEnabled 2>/dev/null
[ "$(lock)" = "|Firefox/5" ] || bad "a felülírás levétele után a sor nem mondja újra zároltnak a Firefoxot: $(lock)"
uninstall > /dev/null || bad "az eltávolító (negyedik kör) hibával állt meg"
[ "$MP_USER_CREATED" = 1 ] && rmdir "$MP/$ME" 2>/dev/null
[ "$MP_CREATED" = 1 ] && rmdir "$MP" 2>/dev/null

rm -f "$HOSTS_BEFORE"
rm -rf "$NOPY"
[ "$STATE_DIR_CREATED" = 1 ] && rm -rf "/Library/Application Support/Breaker"
if [ "$fail" -eq 0 ]; then
  echo "DoH-házirend próba OK (macOS: beírás a Firefox-kapcsolóval, levétel python nélkül, a kapcsoló gazdája szerint, az idegen értékek maradnak, a hosts-blokk kikerül, a zár állapota forrásonként)"
fi
exit "$fail"
