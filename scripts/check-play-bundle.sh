#!/bin/bash
# A Play Store-ba menő AAB nem kérhet telepítési engedélyt (build.gradle.kts, `play` íz).
#
# A Play szabálya szerint a Play-ből telepített app csak a Play-en át frissülhet,
# és a REQUEST_INSTALL_PACKAGES korlátozott engedély: önfrissítésre nem adható.
# Ha egy gradle-átírás után a `play` íz manifestje mégis megkapná, semmi nem
# hasalna el tőle — csak a Play utasítaná el a feltöltést, vagy rosszabb.
#
# Az AAB manifestje protobuf, a szövegek benne UTF-8-ban állnak, tehát egy
# egyszerű keresés is látja őket. A POZITÍV PRÓBA nem díszítés: ha az INTERNET
# engedélyt sem találjuk, a módszer romlott el, nem a csomag lett jó.
set -u

aab="${1:-}"
if [ -z "$aab" ] || [ ! -f "$aab" ]; then
  echo "nincs meg a Play-csomag: ${aab:-(nincs megadva)}" >&2
  exit 1
fi

manifest="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/breaker-play-manifest.pb"
if ! unzip -p "$aab" base/manifest/AndroidManifest.xml > "$manifest" || [ ! -s "$manifest" ]; then
  echo "a csomag manifestje nem olvasható: $aab" >&2
  exit 1
fi

if ! grep -a -q 'android.permission.INTERNET' "$manifest"; then
  echo "a manifestben az INTERNET engedély sincs — a próba nem bizonyít semmit" >&2
  exit 1
fi
if grep -a -q 'REQUEST_INSTALL_PACKAGES' "$manifest"; then
  echo "a Play-csomag telepítési engedélyt kér (REQUEST_INSTALL_PACKAGES) — a Play ezt önfrissítésre nem engedi" >&2
  exit 1
fi
if grep -a -q '\.updates' "$manifest"; then
  echo "a Play-csomagban ott az önfrissítő FileProvidere (.updates)" >&2
  exit 1
fi
echo "Play-csomag: nincs benne telepítési engedély és önfrissítő-szolgáltató"
