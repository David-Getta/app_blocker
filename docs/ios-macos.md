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
