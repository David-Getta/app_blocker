# Android — build és futtatás

## Előfeltételek
- Android SDK (API 34), JDK 17
- `local.properties` a `sdk.dir` beállítással, vagy `ANDROID_HOME` env

## Build

```bash
cd android
./gradlew assembleDebug            # APK: app/build/outputs/apk/debug/
# vagy telepítés csatlakoztatott eszközre:
./gradlew installDebug
```

## Hogyan működik
- A blokkolást egy helyi `VpnService` (DNS sinkhole) végzi. Első bekapcsoláskor
  a rendszer egy **VPN-engedélyt** kér (`VpnService.prepare`), és értesítési
  engedélyt (Android 13+). Ezután a szűrő a `BootReceiver`-rel bootkor is
  elindul.
- A forgalom **nem hagyja el a készüléket**: csak a virtuális DNS-címek mennek a
  tunnelbe, a blokkolt nevek NXDOMAIN-t kapnak, a többit a rendszer 1.1.1.1 /
  8.8.8.8 upstreamhez továbbítja.
- A tiltás minden böngészőben és appban él, **inkognitóban és vendég módban is**,
  mert a DNS-feloldás mindegyik alatt közös.
- A szűrő **tartós értesítése** az állapotot mondja — futó menet, zárlat (kézi
  vagy a heti ablaké, és hogy meddig), adag-szünet, különben az alapállapot —,
  mert a telefonon nincs tiltó lap: ez az egyetlen hely, ahol látszik, mi
  történik. A zárlat-ablak eseményei (beérés, és tíz perccel előtte) külön,
  látható csatornán jönnek, lehúzható értesítésként.
- **Hétfő reggel héttől a szolgáltatás egy heti visszatekintést** ad: az
  elmúlt 7 nap mért ideje, a legtöbb (és a trend), menetek, feloldások, és a
  legnagyobb nem tiltott idővivő — ugyanaz a mondat, mint a gépen
  (`core/Digest.kt`, a gépi mag tükre, ugyanazokkal a tesztekkel). Az app
  nélkül is jön, mert a szolgáltatás fut; egy hétről egyszer (`digestWeekKey`
  az állapotban), saját csatornán, amit külön ki lehet kapcsolni. Engedély
  híján csendben marad, és a hetet sem könyveli el. A rejtett listát a
  beállítás szerint fedi, mert az értesítés a zárolt képernyőn is ott van.
  A mondatok a statisztika **heti naplójában** megmaradnak (`digestLog` az
  állapotban, fél év), és fölöttük az áll, ami most szólna.
- A felvevő kártya **javaslata** (a hét legnagyobb, nem tiltott idővivői, egy
  koppintással tiltva) itt is megvan — `UsageLogic.suggestBlocks`, a gépi
  tükre; rejtett listánál a sor elmarad.
- **Párban zárolás** a zárlat kártyáján: a megbízott neve, a sorsolt
  jelmondat egyszeri lapja, és a *Levétel…* (próbatétel). A lépés a
  próbatétel-képernyő végén jelszómezőként jön (`PartnerStepUi`); a mag a
  `core/Partner.kt` (a gépi tükre, a `fixtures/partner-hash.json` ellen
  tesztelve), a megbízott a munkamenet blobján szinkronizál. Lásd
  `docs/feature-partner-lock.md`.
- A **szűrő megakadásai**: a szolgáltatás a lista és a kulcsszó tiltásánál könyvel
  (hosztonként két percen belül egyszer — a munkamenet fehérlistáján kívül
  rekedt háttér-forgalom nem megakadás; `core/FilterHits.kt`,
  `filterHits` az állapotban, harminc nap), a statisztika nehézség-sora és a
  heti mondat mondja („12 megakadás a szűrőben”), és a szűrő értesítésének
  sora a mait („· Ma 3 megakadás”); az ötödik, tizedik és huszadik mainál a
  szolgáltatás egyszer egy lépést javasol (saját csatornán), a kezdőlap egy
  kártyán, amelynek gombja a legutóbb használt csomagot indítja; tíz perccel a hét csúcs-órája előtt a szolgáltatás egyszer előre
  szól — mindkettő kikapcsolható a statisztika kapcsolójával, és mindkét
  értesítésen gomb indítja a legutóbbi csomagot (`vpn/FocusStartReceiver.kt`). Tükör, nem
  ítélet; a fiókba nem megy. A hét csúcs-oldalát is mondja (a lista tételével
  könyvelve), és okonként bontja (lista, kulcsszó — melyik szabály dolgozik).
  Lásd `docs/feature-usage-stats.md`.
- A **kulcsszavak** (bármely oldalon, ha a cím tartalmazza) a zárlat
  kártyája alján **szerkeszthetők**: felvenni ingyen, levenni próbatétel
  (`Referee.setKeywords`, a függő lista a teljesítéskor ül be). A DNS-szűrő
  a hosztnévben tilt vele (`Focus.verdict`, `BLOCKED_BY_KEYWORD`; az
  infrastruktúra és a fiókkiszolgáló sosem), az útvonalat és a címsort nem
  látja — a sor kimondja; a lista a fiókon át a gépekre átér, és a gépi
  böngésző a teljes címben tilt vele (`core/Keywords.kt`,
  a gépi tükre; a blobon `keywords` + `keywordsRev`). Lásd
  `docs/feature-keywords.md`.

## Korlátok
- Ha a felhasználó a rendszerbeállításokban leállítja a VPN-t, az app feltűnő
  értesítést ad (`onRevoke`). Egyetlen appnál nem tudunk „always-on VPN”-t
  kikényszeríteni MDM/eszközadminisztrátor nélkül — ez tudatos döntés.
- A beépített DNS-over-HTTPS-t használó appok elméletileg megkerülhetik; a
  rendszerszintű DNS-t viszont szűrjük.
- **A rendszer szigorú Privát DNS-e megkerüli a szűrőt** (Beállítások →
  Hálózat és internet → Privát DNS, megadott kiszolgálónévvel): a
  névfeloldás TLS-en, közvetlenül a megadott kiszolgálónak megy, a VPN
  mellett — a tiltás ilyenkor nem érvényesül. Kényszeríteni nem tudjuk
  (rendszerbeállítás), kimondani igen: az app észleli (`vpn/PrivateDns.kt`),
  a főképernyő korongja és a tartós értesítés is ezt mondja, a kártya a
  hálózati beállításokhoz visz. Az „Automatikus” mód nem gond: ott a rendszer
  a VPN DNS-ét próbálja TLS-en, nem kap választ, és sima kérdéssel folytatja,
  amit a szűrő lát.

## A közös mag tesztelése JVM-en
A `core/ChallengeEngine.kt`, `core/Blocklist.kt` és a `vpn/DnsEngine.kt` tiszta
Kotlin (Android API nélkül). Ezek JVM-en is fordíthatók és unit-tesztelhetők —
a próbatétel-motor és a bitszintű DNS-csomagkezelés így ellenőrzött.
