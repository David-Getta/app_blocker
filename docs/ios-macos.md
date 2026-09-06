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

## Korlátok
- MDM/„supervised” mód nélkül a felhasználó a Beállításokban ki tudja kapcsolni a
  VPN-t. Az on-demand szabály ezt kényelmetlenné teszi, de nem lehetetlenné —
  ez önkontroll-eszköz, nem felügyeleti szoftver.
- A Network Extension éles teszteléséhez valós eszköz és a megfelelő
  provisioning profil kell.

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
