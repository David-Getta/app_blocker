# 🔒 Lakat

Weboldal-blokkoló **önkontroll-app** négy platformra: **Android, Windows, macOS
és iPhone**. Megadsz egy weboldalt (pl. `www.youtube.com`), és a Lakat
letiltja — úgy, hogy **inkognitó és vendég módban se** legyen elérhető.

A feloldás szándékosan **nem egyetlen gomb**: valódi erőfeszítést igénylő,
**változatos próbatételeket** kell teljesíteni, amelyek **nem válnak könnyebbé**
attól, hogy sokszor csinálod.

> Ez egy első, működő alap. A tulajdonságok később bővíthetők — a mag úgy készült,
> hogy erre nyitott legyen.

## Mit tud most

- **Oldal blokkolása** egy link beillesztésével. A cím normalizálása kényelmes
  (`https://www.youtube.com/watch?v=…` → `youtube.com`), és ismert
  szolgáltatásoknál a társoldalakat is blokkolja (pl. `youtu.be`,
  `m.youtube.com`).
- **DNS-szintű tiltás**, ezért **minden böngészőben és appban** hat, beleértve az
  **inkognitó/privát és vendég** munkameneteket.
- **macOS-en nincs „minden indításnál engedélyezés”**: a háttérszolgáltatás
  egyszeri jóváhagyással települ, és onnantól magától indul.
- **Súrlódásos, változatos feloldás** (lásd lentebb).
- **Végleges törlés 24 órás türelmi idővel** — a legnehezebb út, ami impulzusból
  nem végezhető el.

## A feloldás filozófiája

A blokkolás bekapcsolása **egy kattintás**. Kikapcsolni **nem az** — ez a lényeg.

- Minden feloldás egy több lépéses **próbatétel-sorozat** (átgépelés,
  fejszámolási lánc, memória-kód, visszafelé gépelés, kötelező várakozás).
- A tartalom **minden alkalommal frissen, véletlenül** generálódik — nincs mit
  „betanulni”.
- A típusok **kombinációja változik**, és nem ismétlődik kétszer egymás után.
- Aki **gyakran old fel, annak nehezebb lesz** (automatikus nehézség-emelés az
  elmúlt 7 nap alapján).
- A **DELAY** lépés valós idejű várakozás (akár 10–120 perc), aminek a végén csak
  egy szűk **10 perces ablakban** vehető át a feloldás — különben az egész
  kísérlet elölről indul.

Részletek: [`docs/challenge-spec.md`](docs/challenge-spec.md).

## Felépítés

| Platform | Technológia | Blokkolás módja |
|----------|-------------|-----------------|
| Windows + macOS | Electron + Node helper | rendszer `hosts` fájl, tamper-védelemmel |
| Android | Kotlin + Jetpack Compose | helyi `VpnService` DNS sinkhole |
| iOS + macOS | SwiftUI + Network Extension | `NEPacketTunnelProvider` DNS-szűrő |

A blokk-logika, a próbatétel-motor és a bíró **közös algoritmus** minden
platformon. Referencia: TypeScript (`node --test` fedi); Kotlin és Swift ennek
pontos tükre. Részletek: [`docs/architecture.md`](docs/architecture.md).

```
desktop/   Electron app + privilegizált helper (Win/Mac)   → docs/desktop.md
android/   Gradle projekt (Kotlin, Compose)                → docs/android.md
ios/       XcodeGen projekt (iOS + macOS, közös Swift mag) → docs/ios-macos.md
docs/      architektúra + próbatétel-spec
```

## Gyors indítás

```bash
# Desktop (a mag + hosts-motor tesztjei itt is lefutnak)
cd desktop && npm install && npm test && npm start

# Android
cd android && ./gradlew assembleDebug

# iOS / macOS (macOS + Xcode kell)
cd ios && xcodegen generate && open Lakat.xcodeproj
```

## Állapot és tesztelés

- **Desktop:** teljes `node:test` lefedettség a blokklistára, a próbatétel-motorra
  és a bíróra (session + hosts fájl end-to-end). ✅ Zöld.
- **Android:** a platformfüggetlen mag (`ChallengeEngine`, `Blocklist`) és a
  bitszintű `DnsEngine` JVM-en unit-tesztelt. ✅ Zöld. A teljes APK-hoz Android
  SDK kell.
- **iOS/macOS:** a projekt XcodeGennel generálható; a fordításhoz macOS + Xcode
  szükséges.

## Őszinte korlátok

A Lakat **önkontroll-eszköz** olyasvalakinek, aki *segíteni akar magának* — nem
kártevő-elleni és nem szülői felügyeleti szoftver. Elszánt, technikailag hozzáértő
felhasználó meg tudja kerülni (admin jogok, egyedi DNS/DoH-proxy stb.). A cél a
**súrlódás** akkora növelése, hogy a pillanatnyi késztetés ne legyen elég a
feloldáshoz. A megkerülési utakat nyíltan dokumentáljuk az
[`docs/architecture.md`](docs/architecture.md) végén.

## Következő lépések (ötletek a bővítéshez)

- Időzített szabályok (pl. munkaidőben mindig tiltva).
- Kulcsszó-/kategória-alapú blokkolás.
- IP-szintű szabályok az egyedi DNS-megkerülés ellen.
- Statisztikák, „párban zárolás” (egy megbízott is kell a feloldáshoz).
