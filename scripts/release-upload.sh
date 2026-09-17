#!/usr/bin/env bash
# Egy kiadási asset feltöltése — újrapróbálással.
#
# MIÉRT LÉTEZIK. A GitHub feltöltő végpontja időnként 500-at ad („Error
# creating asset temp dir”), és egy második próbálkozás másodpercekkel később
# átmegy. A v0.4.32-nél két job bukott ezen — az androidos APK és a bővítmény
# zipje —, miközben a build mindkettőnél jó volt, a Windows/Mac feltöltés pedig
# ugyanabban a percben simán sikerült. A kiadás így APK nélkül ment ki, és a
# hibát kézzel kellett újrafuttatni.
#
# Három kísérlet, növekvő várakozással. Ha a harmadik is elhasal, az már nem
# pillanatnyi zavar: a job bukjon el hangosan, ahogy eddig.
#
# Használat: scripts/release-upload.sh <verzió-tag> <fájl>
# Kell hozzá: GH_TOKEN és GITHUB_REPOSITORY a környezetből (a workflow adja).
set -u
version="$1"
file="$2"
for attempt in 1 2 3; do
  if gh release upload "$version" "$file" --repo "$GITHUB_REPOSITORY" --clobber; then
    exit 0
  fi
  echo "feltöltés nem sikerült ($attempt/3): $file" >&2
  if [ "$attempt" -lt 3 ]; then sleep $((attempt * 15)); fi
done
echo "a feltöltés háromszor is elhasalt: $file" >&2
exit 1
