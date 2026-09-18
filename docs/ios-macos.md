# iOS és macOS — build és futtatás

## Előfeltételek
- macOS + Xcode 15+
- [XcodeGen](https://github.com/yonwoo9/XcodeGen): `brew install xcodegen`
- Apple Developer fiók (a Network Extension **valós eszközön** fizetős
  fejlesztői programot igényel; a szimulátor korlátozott)

## Projekt generálása

```bash
cd ios
xcodegen generate      # létrehozza a Breaker.xcodeproj-ot a project.yml alapján
open Breaker.xcodeproj
```

Xcode-ban:
1. Állítsd be a **DEVELOPMENT_TEAM**-et a `project.yml`-ben (vagy a target
   Signing & Capabilities fülén) mindhárom targetnél.
2. Ellenőrizd, hogy az **App Group** (`group.hu.breaker.app`) engedélyezve van az
   app és a Packet Tunnel extension targeten is (közös állapot ezen keresztül).
3. Válaszd a `BreakerApp-iOS` vagy `BreakerApp-macOS` sémát és futtasd.

## Miért nem kér engedélyt minden indításkor (macOS)
A `TunnelController` a VPN-konfigot **on-demand** módban menti
(`isOnDemandEnabled = true`, connect-always szabály). Az egyszeri engedélyezés
után a rendszer tartja fenn a tunnelt és bekapcsolja bejelentkezéskor —
az app futása nélkül is, újabb engedélykérés nélkül.

## Hogyan blokkol
`NEPacketTunnelProvider` egy helyi tunnelt hoz létre, amibe csak a virtuális
DNS-címek irányulnak. A blokkolt nevekre NXDOMAIN, a többire upstream továbbítás.
A tiltás minden appban és böngészőben él, **privát módban is**.

A tunnel-bővítmény nem adhat értesítést, ezért a zárlat-ablak emlékeztetőit az
app **előre ütemezi** (`UNUserNotificationCenter`, heti ismétlődő kérés minden
ablak-napra a kezdésre és tíz perccel előbbre, ha belefér a rendszer
hatvannégyes keretébe). A tervet — mikor, mit mondjon — a mag adja
(`LockdownLogic.reminderPlan`), teszttel; az app csak rendszer-kérést gyárt
belőle. Az első ablaknál az app értesítési engedélyt kér.

A **párban zárolás** itt is a zárlat kártyáján van: a megbízott neve, a sorsolt
jelmondat egyszeri lapja (kijelölhető, hogy át lehessen küldeni; lehúzni nem
lehet, csak kimondva bezárni), és a *Levétel…* (próbatétel). A lépés a
próbatétel-lap végén jelszómezőként jön; a mag a `Shared/Partner.swift` (a gépi
tükre, a `fixtures/partner-hash.json` ellen tesztelve), a megbízott a
munkamenet blobján szinkronizál. Lásd `docs/feature-partner-lock.md`.

A **szűrő megakadásai**: a tunnel a lista és a kulcsszó tiltásánál könyvel (hosztonként két
percen belül egyszer — a munkamenet fehérlistáján kívül rekedt háttér-forgalom
nem megakadás; `Shared/FilterHits.swift`, `filterHits`
az állapotban, harminc nap), a statisztika nehézség-sora és a heti mondat
mondja („12 megakadás a szűrőben”); az ötödik, tizedik és huszadik mainál a
kezdőlap egy lépést javasol (a kártya gombja a legutóbb használt csomagot
indítja) — a tunnel nem értesít, a lap mondja, amíg nyitva van; tíz perccel a hét csúcs-órája előtt a rendszer szól (az app ütemezi,
`App/PeakReminder.swift`; a statisztika kapcsolójával kikapcsolható; az
értesítés „Munkamenet indítása” gombja a legutóbbi csomagot indítja,
`App/NoticeActions.swift`). Tükör,
nem ítélet; a fiókba nem megy. A hét csúcs-oldalát is mondja (a lista tételével
könyvelve), és okonként bontja (lista, kulcsszó — melyik szabály dolgozik).
Lásd `docs/feature-usage-stats.md`.

A **heti visszatekintés** hétfő reggel: a mondat akkor születik, amikor az app
hétfő reggel hét után először nyitva van (a felület címkézésével, a
statisztikán és a naplóban), és egy heti **emlékeztető** hívja oda az embert
(`App/DigestReminder.swift`, hétfő 7:05, a rendszer ütemezi, egy kérés a
64-es keretből) — a mondat maga nincs az értesítésben, mert az app a
háttérben nem fut.

A **kulcsszavak** (bármely oldalon, ha a cím tartalmazza) a zárlat kártyája
alján **szerkeszthetők**: felvenni ingyen, levenni próbatétel
(`Referee.setKeywords`, a függő lista a teljesítéskor ül be). A tunnel a
hosztnévben tilt vele (`Focus.verdict`, `.blockedByKeyword`; az infrastruktúra
és a fiókkiszolgáló sosem), az útvonalat és a címsort nem látja — a sor
kimondja; a lista a fiókon át a gépekre átér, és a gépi böngésző a teljes
címben tilt vele (`Shared/Keywords.swift`, a gépi
tükre; a blobon `keywords` + `keywordsRev`). Lásd `docs/feature-keywords.md`.

## Korlátok
- MDM/„supervised” mód nélkül a felhasználó a Beállításokban ki tudja kapcsolni a
  VPN-t. Az on-demand szabály ezt kényelmetlenné teszi, de nem lehetetlenné —
  ez önkontroll-eszköz, nem felügyeleti szoftver.
- A Network Extension éles teszteléséhez valós eszköz és a megfelelő
  provisioning profil kell.
- **Heti visszatekintés értesítésben nincs** (a hétfő reggeli mondat, ami a
  gépen és Androidon jön): a bővítmény nem adhat értesítést, az app nem fut a
  háttérben, előre ütemezni pedig csak olyan mondatot lehetne, ami a hét
  végére elavul — inkább nincs, mint hogy hamis legyen. Ami van: a statisztika
  **heti naplója** és az élő mondat („így szólna most”) — a hét sora akkor
  íródik, amikor az app azon a héten először nyitva van hétfő reggel hét után
  (`Shared/Digest.swift`, a gépi mag tükre, teszttel); mérés híján a
  menetekről és a feloldásokról szól.

## A Swift mag
A `Shared/` mappa (`Blocklist.swift`, `ChallengeEngine.swift`, `Referee.swift`,
`Store.swift`, `DnsEngine.swift`) a közös logika Swift változata, ugyanazzal az
algoritmussal, mint a TypeScript (tesztelt) és Kotlin (JVM-en tesztelt) mag.

### Tesztek: `swift test`
A Swift mag sokáig CSAK fordult a CI-ban — egyetlen tesztje sem futott le
soha, miközben a másik két nyelvnek több száz volt. Egy tükör, ami csak
fordul, nem tükör. Az `ios/Package.swift` ugyanezt a `Shared/` mappát
könyvtárként fordítja (az appot és az alagutat továbbra is az XcodeGen-projekt
építi), a `SharedTests/` mappa tesztjei pedig macOS-en futnak:

```sh
cd ios && swift test
```

A CI iOS-jobja minden push-nál futtatja. Ami ott van: az összefésülések
tükör-tesztjei (`FocusSyncTests`, `SyncMergeTests` — ugyanazok az esetek, mint a
gépen és Androidon), egy véletlen magú fuzz (`MergeFuzzTests`) UGYANAZZAL a
véletlennel, mint a gépé: három eszköz bármilyen sorrendben ugyanoda jut — és a
megfelelőségi teszt (`MergeFixtureTests`): a tároló gyökerében álló
`fixtures/merge-cases.json` a gép által kiszámolt bemeneteket és
eredmény-kulcsokat tartja, a Swift a saját dekódolóján át olvassa őket, a saját
fésülésével számol, és a kulcsnak bájtra egyeznie kell. Ha a Swift tükör egy
szabályban elcsúszik a másik kettőtől, itt bukik — a mag számával —, nem egy
felhasználó telefonján.
