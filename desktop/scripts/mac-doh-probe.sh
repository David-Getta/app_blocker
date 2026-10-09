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
#   2. az eltávolítás után a mieink eltűntek, egy IDEGEN érték és egy idegen
#      Firefox-házirend viszont marad (és vele a kapcsoló is), a hosts-blokk
#      kikerül, a hosts többi része érintetlen;
#   3. ha a Firefox-tartományban már csak a miénk volt, a kapcsoló is megy;
#   4. a DoH-zár profil a valódi plutil szerint érvényes, és ugyanazt
#      kényszeríti, amit a segéd beállít;
#   5. a DoH-zár állapota azt mondja, ami a kezelt beállítások között áll.
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

# 0. Kiindulás: a gép hosts-fájlja, és egy idegen Firefox-házirend.
HOSTS_BEFORE=$(mktemp)
cp /etc/hosts "$HOSTS_BEFORE"
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

# 2. Egy idegen érték (valaki a Brave-et kézzel „secure”-ra állította) és egy hosts-blokk.
defaults write /Library/Preferences/com.brave.Browser DnsOverHttpsMode -string secure
printf '\n# >>> BREAKER BLOCK BEGIN — próba\n0.0.0.0 breaker-probe.example\n# <<< BREAKER BLOCK END\n' >> /etc/hosts

# 3. A valódi eltávolító.
sh scripts/uninstall-macos.sh || bad "az eltávolító hibával állt meg"

for d in com.google.Chrome com.microsoft.Edge org.chromium.Chromium; do
  [ -z "$(rd "/Library/Preferences/$d" DnsOverHttpsMode)" ] || bad "$d: a mi „off” értékünk ott maradt"
done
[ "$(rd /Library/Preferences/com.brave.Browser DnsOverHttpsMode)" = secure ] || bad "az idegen Brave-érték eltűnt"
[ -z "$(rd "$FF" DNSOverHTTPS)" ] || bad "a Firefox DNSOverHTTPS-e ott maradt"
[ "$(rd "$FF" DisableAppUpdate)" = 1 ] || bad "az idegen Firefox-házirend eltűnt"
[ "$(rd "$FF" EnterprisePoliciesEnabled)" = 1 ] || bad "a házirend-kapcsoló eltűnt, pedig egy idegen Firefox-házirend még használja"
grep -q 'BREAKER BLOCK' /etc/hosts && bad "a hosts-blokk ott maradt"
diff <(grep -v '^$' "$HOSTS_BEFORE") <(grep -v '^$' /etc/hosts) >/dev/null || bad "a hosts többi része megváltozott"

# 4. Ha a Firefox-tartományban már csak a miénk van, a kapcsoló is megy.
defaults delete "$FF" DisableAppUpdate
apply
sh scripts/uninstall-macos.sh > /dev/null || bad "az eltávolító (második kör) hibával állt meg"
[ -z "$(rd "$FF" EnterprisePoliciesEnabled)" ] || bad "a házirend-kapcsoló ott maradt, pedig már csak a miénk volt"

# 5. A DoH-zár profil (a felhasználó telepíti): a valódi plutil szerint
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

# 6. A DoH-zár állapota (dohLockState): azt mondja, ami a kezelt beállítások
# között áll — egy szimulált kezelt Chrome-értékkel megnézzük, hogy a valódi
# függvény meglátja, a többi böngészőt pedig nem mondja kötelezőnek.
MP="/Library/Managed Preferences"
MP_CREATED=0
[ -d "$MP" ] || { mkdir -p "$MP"; MP_CREATED=1; }
lock() { "$NODE" -e "require('./dist/main/doh-lock-state').dohLockState().then((s) => console.log(s.forcedOff.join(',') + '/' + s.total))"; }
BEFORE_LOCK=$(lock)
case "$BEFORE_LOCK" in *Chrome*) bad "a kezelt Chrome-érték már a próba előtt ott van — a gép nem tiszta: $BEFORE_LOCK" ;; esac
defaults write "$MP/com.google.Chrome" DnsOverHttpsMode -string off
chmod 644 "$MP/com.google.Chrome.plist" 2>/dev/null
AFTER_LOCK=$(lock)
case "$AFTER_LOCK" in
  *Chrome*/4) ;;
  *) bad "a DoH-zár állapota nem látja a kezelt Chrome-értéket: $AFTER_LOCK" ;;
esac
case "$AFTER_LOCK" in *Edge*|*Brave*) bad "a DoH-zár állapota olyan böngészőt is kötelezőnek mond, amelyiknek nincs kezelt értéke: $AFTER_LOCK" ;; esac
rm -f "$MP/com.google.Chrome.plist"
[ "$MP_CREATED" = 1 ] && rmdir "$MP" 2>/dev/null

rm -f "$HOSTS_BEFORE"
if [ "$fail" -eq 0 ]; then
  echo "DoH-házirend próba OK (macOS: beírás a Firefox-kapcsolóval, levétel, az idegen értékek maradnak, a hosts-blokk kikerül)"
fi
exit "$fail"
