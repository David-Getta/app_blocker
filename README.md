<p align="center"><img src="website/icon-512.png" alt="Lakat" width="96" /></p>

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

## Képernyőképek

| Főképernyő (asztali) | Feloldási próbatétel |
|---|---|
| ![Főképernyő](docs/images/desktop-home.png) | ![Próbatétel](docs/images/desktop-challenge.png) |

| Időzített menetrend |
|---|
| ![Menetrend](docs/images/desktop-schedule.png) |

![Letöltőoldal](docs/images/website.png)

## Letöltés és frissítés — mint egy áruházból

A telepítés egy kattintás, és az appok **maguktól frissülnek**:

- **Letöltőoldal:** `https://david-getta.github.io/app_blocker/` — felismeri a
  platformodat, és a legfrissebb telepítőt kínálja. (A GitHub Pages
  bekapcsolása után él; lásd [`docs/releasing.md`](docs/releasing.md).)
- **Asztali (Windows/macOS):** az app a háttérben ellenőrzi és letölti az új
  verziót, majd egy gombbal újraindulva telepíti — mint az áruházi frissítés.
- **Android:** a Play Áruházon kívül telepítve is figyeli az új kiadást, és egy
  gombbal frissít; Play Store-ból az áruház frissíti.
- **iPhone:** App Store / TestFlight (az Apple szabályai miatt ez az út).

Új verzió kiadása a fejlesztőnek **egyetlen parancs** (`git tag v0.2.0 && git
push origin v0.2.0`) — a GitHub Actions megépíti mindhárom platformra és közzé
teszi. Részletek: [`docs/releasing.md`](docs/releasing.md).

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
website/   letöltő landing oldal (GitHub Pages)
.github/   CI/CD: teszt, build és kiadás minden platformra → docs/releasing.md
docs/      architektúra + próbatétel-spec + kiadási útmutató
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
