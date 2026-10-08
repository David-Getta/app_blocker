#!/bin/bash
# A BECSOMAGOLT app indítási füstpróbája (src/main/smoke.ts).
#
# A CI és a kiadás ugyanezt futtatja, a desktop mappából, egy már elkészült
# csomagon (`electron-builder` kimenete a release/ alatt). Macen az arm64 csomag
# fut — a GitHub macOS futója Apple szilícium; az x64 ugyanaz a kód, más
# processzorra. Windowson a kicsomagolt mappa exe-je.
#
# Windowson a grafikus app kimenete nem mindig jut el a hívó konzoljáig: az
# eredmény ezért fájlba is megy (BREAKER_SMOKE_OUT), és a kilépési kód dönt.

set -u

case "$(uname -s)" in
  Darwin) exe="release/mac-arm64/Breaker.app/Contents/MacOS/Breaker" ;;
  *) exe="release/win-unpacked/Breaker.exe" ;;
esac

if [ ! -f "$exe" ]; then
  echo "nincs meg a becsomagolt app: $exe" >&2
  ls release >&2 || true
  exit 1
fi

# MACEN AZ ALÁÍRÁS AZONOSÍTÓJA IS. Az Electron 42-től a macOS-értesítés a
# UNNotification-ön megy, és az csak akkor kézbesít, ha az aláírás azonosítója a
# csomagé (hu.breaker.app), és az Info.plist az aláírás része. Tanúsítvány
# nélkül (ad-hoc aláírás) ezt semmi nem garantálja magától: egy rossz sorrendű
# utómunka után a fő bináris „Electron” azonosítóval marad, és minden értesítés
# némán elvész — az app közben hibátlanul indul.
if [ "$(uname -s)" = "Darwin" ]; then
  bundle="release/mac-arm64/Breaker.app"
  sig=$(codesign -dv --verbose=2 "$bundle" 2>&1)
  if ! echo "$sig" | grep -q '^Identifier=hu\.breaker\.app$'; then
    echo "az aláírás azonosítója nem hu.breaker.app — az értesítések elvesznének:" >&2
    echo "$sig" >&2
    exit 1
  fi
  if ! echo "$sig" | grep -q '^Info\.plist entries='; then
    echo "az Info.plist nincs az aláírásban — az értesítések elvesznének:" >&2
    echo "$sig" >&2
    exit 1
  fi
  echo "aláírás: hu.breaker.app, az Info.plist az aláírás része"
fi

out="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/breaker-smoke.txt"
rm -f "$out"
code=0
BREAKER_SMOKE_OUT="$out" "$exe" --smoke-test || code=$?
cat "$out" 2>/dev/null || echo "a füstpróba nem írt eredményt (kilépési kód: $code)"
exit "$code"
