# Architektúra

A Lakat egy weboldal-blokkoló önkontroll-app négy platformra. A blokkolás
mindenhol **DNS-szinten** történik, mert az egyetlen olyan pont, amit egyszerre
lát minden böngésző és minden alkalmazás — így a tiltás **inkognitó/privát és
vendég módban is él**, nem csak egy böngészőben.

```
                     ┌───────────────────────────────────────────┐
                     │            Közös blokk-logika               │
                     │  domain-normalizálás, preset-bővítés,       │
                     │  próbatétel-motor, bíró (referee), tierek   │
                     └───────────────────────────────────────────┘
                        │              │                │
             ┌──────────┘              │                └───────────┐
             ▼                         ▼                            ▼
   Desktop (Win/Mac)           Android                       iOS / macOS
   Electron + Node helper      VpnService (DNS sinkhole)     NEPacketTunnelProvider
   /etc/hosts, C:\...\hosts    lokális VPN, NXDOMAIN         lokális VPN, NXDOMAIN
```

## Blokkolási mechanizmus platformonként

### Desktop (Windows + macOS) — hosts fájl
Egy privilegizált **helper szolgáltatás** (macOS: LaunchDaemon root-ként;
Windows: SYSTEM ütemezett feladat) kezeli a rendszer `hosts` fájlját. A blokkolt
hosztneveket `0.0.0.0`-ra (és IPv6 `::`-ra) irányítja egy jelölőkkel határolt,
menedzselt blokkban. A helper **figyeli a fájlt**: ha valaki kézzel átírja, ~2
másodpercen belül visszaállítja.

- **Miért nincs macOS-en „minden indításnál engedélyezés”?** A helper egyszeri
  telepítéskor (egy admin jóváhagyás) LaunchDaemonként települ, és onnantól a
  rendszer indítja minden bootnál, engedélykérés nélkül. Ez a különbség a
  „csak amíg az app fut” megoldásokhoz képest.
- **DNS-over-HTTPS elleni védelem:** a böngészők beépített DoH-ja megkerülné a
  hosts fájlt. A helper ezért gépszintű házirenddel kikapcsolja a DoH-t
  Chrome/Edge/Firefox alatt (best effort, naplózva).

### Android — VpnService DNS sinkhole
Egy helyi `VpnService` (nem távoli VPN — a forgalom nem hagyja el a készüléket)
csak a virtuális DNS-címeket irányítja be. Minden DNS-lekérés átmegy a motoron:
a blokkolt nevekre **NXDOMAIN** választ ad, a többit egy upstream resolverhez
(1.1.1.1 / 8.8.8.8) továbbítja. Bootkor a `BootReceiver` újraindítja, ha a
VPN-engedély már megvan.

### iOS / macOS — Network Extension (Packet Tunnel)
`NEPacketTunnelProvider` ugyanazzal a DNS-motorral. Egy **on-demand**
szabállyal (`isOnDemandEnabled = true`, connect-always) a rendszer automatikusan
fenntartja — egyszeri engedélyezés után nem kér újra, és bekapcsol induláskor.
Az app és az extension egy **App Group** megosztott fájlon osztozik.

## Közös mag

A `domain-normalizálás`, `preset-bővítés`, a teljes `próbatétel-motor`, a `bíró`
(session-kezelés) és a `tier`-számítás minden platformon azonos algoritmus.
Referenciaimplementáció a TypeScript (`desktop/src/shared`), amelyet
`node --test` fed le; a Kotlin és Swift változat ennek pontos tükre. A Kotlin
mag és a bitszintű DNS-motor JVM-en unit-tesztelt.

## Biztonsági modell és őszinte korlátok

A Lakat **önkontroll-eszköz elszánt, de önmagával együttműködő felhasználónak**,
nem szülői felügyeleti vagy kártevő-elleni megoldás. Aki technikailag hozzáértő
és eltökélt, meg tudja kerülni. A cél a **súrlódás** növelése annyira, hogy a
pillanatnyi impulzus ne legyen elég a feloldáshoz.

Ismert megkerülési utak (szándékosan nem próbáljuk „lelakatolni” a gépet):
- Admin/root jogú felhasználó leállíthatja a helpert vagy a VPN-t. A rendszer
  ilyenkor a *blokkolt* állapotból indul újra, és a mobil appok feltűnő
  értesítést adnak, ha a védelmet kikapcsolták.
- Egyedi/hardcode-olt DNS vagy DoH-proxy IP-cím megkerülheti a szűrőt (a hosts
  fájl és a sinkhole a névfeloldásra hat). Későbbi bővítés: IP-szintű szabályok.
- iOS-en MDM/„supervised” mód nélkül a felhasználó a rendszerbeállításokban ki
  tudja kapcsolni a VPN-t; az on-demand szabály csökkenti ennek kényelmét.

Ezeket a `docs/`-ban nyíltan dokumentáljuk, hogy az elvárások reálisak
legyenek.
