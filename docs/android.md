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
