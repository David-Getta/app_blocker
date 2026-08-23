# Architektúra

A Breaker egy weboldal-blokkoló önkontroll-app négy platformra. A blokkolás
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
  Chrome/Edge/Chromium/Brave/Firefox alatt (best effort, naplózva). Windowson
  ez házirend-kulcs, tehát zár; **macOS-en MDM-profil nélkül csak alapértelmezés,
  amit a felhasználó felül tud bírálni** — ezt a korlátok között is kimondjuk.
  A Firefox app-bundle-jébe szándékosan NEM írunk (lásd lentebb).

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

## Aktív idő mérése (statisztika)

A mérés önálló alrendszer, a blokkolástól függetlenül ki-be kapcsolható. Külön
tervdokumentum: [`feature-usage-stats.md`](feature-usage-stats.md).

```
   ┌──────────────┐   minta (5 mp)    ┌──────────────┐   köteg (30–60 mp)
   │  platform-   │ ────────────────► │   mérő       │ ──────────────────►  tároló
   │  szonda      │  előtér + tétlen  │  (puffer)    │   napi vödrök        (helyi)
   └──────────────┘                   └──────────────┘
```

Fontos, hogy **hol** fut a mérő:

- **Desktop:** a GUI folyamatában, mert a root/SYSTEM helper nem látja az
  előteret (macOS-en nincs hozzáférése a felhasználó grafikus munkamenetéhez,
  Windowson a SYSTEM a 0. munkamenetben izolált). A helper csak tárol. Ezért a
  desktop mérés addig gyűjt, amíg a Breaker fut.
- **Android:** a már úgyis futó VPN-szolgáltatásban, tehát a felület bezárása
  nem állítja le.
- **iOS/macOS (Network Extension):** **nincs mérés, és nem is lehet.** Az Apple
  nem ad appnak hozzáférést ahhoz, hogy MÁS appokban vagy weboldalakon mennyi
  aktív idő telik; az egyetlen ilyen API (`DeviceActivity` / `FamilyControls`)
  külön, Apple által egyenként engedélyezett entitlementhez kötött, és
  szülői felügyeletre szánták. A csomagalagút lát DNS-kérdéseket, de a
  kérdésszám nem aktív idő — és a követelmény kifejezetten az, hogy csak az
  számítson, amíg tényleg az adott dolog előtt ülünk. Ezért az iOS
  statisztika-képernyő ezt kimondja, ahelyett hogy becsülgetne. Emiatt a
  **napi időkeret sem működhet iOS-en**: nincs miből fogynia.

Két tervezési döntés, ami az adatok helyességét adja:

1. **Egy minta egy célponthoz tartozik**, a legpontosabbhoz: böngészőfülnél az
   oldalhoz, egyébként az apphoz. Így az összegek nem duplázódnak (a böngésző
   ideje nem szerepel egyszerre az app és az oldal mellett is).
2. **Az idő korlátozva van két helyen**: a mintavételnél a valós eltelt idő
   legfeljebb két mintavételi periódus lehet (alvás/ébredés után ne írjon be
   órákat), a tárolásnál pedig egy célpont egy napra nem kaphat 24 óránál
   többet. A megőrzés darabszám-alapú, így elállított rendszeróra sem tud
   valós előzményt törölni.

## Közös mag

A `domain-normalizálás`, `preset-bővítés`, a teljes `próbatétel-motor`, a `bíró`
(session-kezelés) és a `tier`-számítás minden platformon azonos algoritmus.
Referenciaimplementáció a TypeScript (`desktop/src/shared`), amelyet
`node --test` fed le; a Kotlin és Swift változat ennek pontos tükre. A Kotlin
mag és a bitszintű DNS-motor JVM-en unit-tesztelt.

## Biztonsági modell és őszinte korlátok

A Breaker **önkontroll-eszköz elszánt, de önmagával együttműködő felhasználónak**,
nem szülői felügyeleti vagy kártevő-elleni megoldás. Aki technikailag hozzáértő
és eltökélt, meg tudja kerülni. A cél a **súrlódás** növelése annyira, hogy a
pillanatnyi impulzus ne legyen elég a feloldáshoz.

### A privilegizált helper IPC-je

A helper root/SYSTEM jogú, ezért a vele kommunikáló helyi socketet szűkítjük:
- **macOS/Linux:** a socket `0o600` jogosultságú, és a *telepítő felhasználó*
  uid-jére van `chown`-olva (a uid-et a GUI a telepítéskor a LaunchDaemon
  argumentumába süti: `--owner-uid=<uid>`). Így csak az adott felhasználó (és a
  root) tud csatlakozni — más felhasználó vagy alacsony jogú folyamat (pl.
  `nobody`) nem.
  A sorrend is számít: a socket **szűk umask alatt jön létre** (`0o177`), nem
  utólagos `chmod`-dal. A `bind()` és a `chmod()` közötti pillanatban a socket
  már fogadja a kapcsolatokat — az a rés elég egy helyi folyamatnak. A
  létrehozás után a helper **ellenőrzi** a jogosultságot, és ha nem tudja
  bizonyítani, hogy csak a tulajdonos éri el, **nem szolgál ki** (leállítja a
  szervert). Fail-closed: inkább ne induljon el, mint hogy egy root parancs-
  csatorna nyitva maradjon.
- **Windows:** named pipe, ami eleve helyi; egyedi DACL beállítása natív kód
  nélkül nem megoldható, ezért ez ismert korlát (a jövőben szűkíthető).

Ismert megkerülési utak (szándékosan nem próbáljuk „lelakatolni” a gépet):
- Admin/root jogú felhasználó leállíthatja a helpert vagy a VPN-t. A rendszer
  ilyenkor a *blokkolt* állapotból indul újra, és a mobil appok feltűnő
  értesítést adnak, ha a védelmet kikapcsolták.
- Egyedi/hardcode-olt DNS vagy DoH-proxy IP-cím megkerülheti a szűrőt (a hosts
  fájl és a sinkhole a névfeloldásra hat). Későbbi bővítés: IP-szintű szabályok.
- **macOS-en a böngésző-DoH kikapcsolása nem zár, csak alapértelmezést állít.**
  A Chromium a `/Library/Preferences`-ben talált értéket csak akkor kezeli
  kötelező házirendként, ha az „forced” (MDM-profilból jön); enélkül ajánlásnak
  veszi, tehát a felhasználó a böngésző beállításaiban visszakapcsolhatja.
  Rendes zárás MDM/konfigurációs profilt igényelne. Ezért a felület csak annyit
  állít, hogy a házirendet alkalmaztuk — nem azt, hogy a DoH nem kapcsolható be.
- **A telepítő átmeneti fájljai.** A privilegizált telepítés egy shell-, illetve
  PowerShell-szkriptet és egy plistet ír a felhasználó temp könyvtárába, és azt
  futtatja emelt joggal. A név mostantól véletlen, a könyvtár 0700 — előre
  odakészített fájl tehát nem léphet a helyünkre. Ami marad: a SAJÁT
  felhasználóként már kódot futtató támadó a kiírás és az emelt futtatás közötti
  pillanatban elvileg átírhatja a tartalmat, és ezzel root/SYSTEM jogot szerez.
  A teljes megoldás az volna, hogy a privilegizált rész egyáltalán ne fájlból
  olvasson (a parancsot a parancssorban kapja meg), ez még hátravan.
- **Más gyártó appját nem rontjuk el a szigor kedvéért.** A Firefox
  policies.json-t macOS-en az app bundle-jébe kellene tenni, ami érvényteleníti
  a Firefox aláírását, és a saját frissítőjét is elronthatja. Ezt nem tesszük:
  a gépszintű `org.mozilla.firefox` beállítás ugyanazt a házirendet adja, a
  bundle érintése nélkül. Windowson a telepítési mappa `distribution/`
  könyvtára a dokumentált hely, ott nincs ilyen mellékhatás.
- iOS-en MDM/„supervised” mód nélkül a felhasználó a rendszerbeállításokban ki
  tudja kapcsolni a VPN-t; az on-demand szabály csökkenti ennek kényelmét.
- **Óra-átállítás.** Mindhárom mag kiszűri: a várakozási határidők eltelt időt
  mérnek, nem dátumot (lásd `docs/challenge-spec.md`). A megoldás azon áll, hogy
  a karbantartó kör rendszeresen fut; ha a folyamatot leállítják, az újraindulás
  után az első kör csak új alapvonalat vesz fel. A készülék kikapcsolt ideje
  ezért nem számít bele a várakozásba — ez a szigorúbb irány.

Ezeket a `docs/`-ban nyíltan dokumentáljuk, hogy az elvárások reálisak
legyenek.

## Hibatűrés: melyik irányba dőljön a rendszer

Egy blokkoló appnál a hibáknak **iránya** van. Ha valami nem sikerül, két
kimenetel közül lehet választani: „minden tiltva marad” vagy „minden feloldódik”.
A második a rosszabb — az a felhasználó ellen dolgozik, ráadásul csendben. Ezért
minden bizonytalan helyzet a tiltás felé dől:

| Helyzet | Rossz (fail-open) | Amit csinálunk |
|---|---|---|
| Ismeretlen menetrend-mód a mentett állapotban | a döntés `undefined`/kivétel → az oldal szabad, de védettnek látszik | `always` (mindig tiltva) |
| Egy oldal rekordja nem olvasható | az egész állapot eldobása → üres blokklista | csak azt az egy oldalt veszítjük el |
| A feloldási próba (session) sérült | kivétel a DNS-útvonalon, vagy beragadt session | a session eldobása → elölről kell kezdeni (több súrlódás, nem kevesebb) |
| `stepIndex` a lépéseken túlra mutat | minden művelet kivételre fut → a próba nem zárható le | a session nem töltődik be |
| iOS: az állapotfájl létezik, de nem dekódolható | üres állapot ráírása → **minden blokk véglegesen elveszik** | nem írunk fölé, és a felület jelzi |
| A helper socketje nem tehető biztonságossá | root parancscsatorna nyitva | a helper nem indul el |
| A mérési puffer megtelik / elavul | korlátlan növekedés, néma eldobás a másik oldalon | korlátos puffer, legrégebbi megy először, naplózott eldobás |
| Frissítés után az új GUI a RÉGI helperrel beszél | az ismeretlen parancs `data: undefined`-dal „sikerül” → a felhasználó azt hiszi, beállította a napi keretet | a helper `UNKNOWN_OP`-pal elhasal, a GUI sávban jelzi, és egy gombbal cseréli a démont |

### A frissítés utáni „régi helper” állapot

A desktopon a GUI és a privilegizált helper **külön folyamat**, és a frissítés
csak az elsőt cseréli le azonnal: a root démont a launchd (Windowson az
ütemező) a következő rendszerindításig a régi bináris alapján futtatja. Ez a
normál működés, nem hiba — de a két fél ilyenkor különböző protokollt beszél.

Ezért van a `HELPER_VERSION` a `shared/protocol.ts`-ben. Bumpolni kell, amikor
új `op` kerül a kérés-unióba vagy egy válasz alakja változik. A GUI minden
status-lekérésnél összeveti a sajátjával, és eltérésnél sávot mutat, egy
gombbal: a telepítő újrafuttatása `bootout` + `bootstrap`, tehát a démont
egyetlen jelszókérés árán, újraindítás nélkül lecseréli.

A védelem két rétegű, mert a sáv csak akkor segít, ha a felhasználó látja:
a régi helper az ismeretlen parancsra `UNKNOWN_OP`-pal el is hasal, tehát ha
valaki mégis kiadna egy új parancsot, hibát kap, nem néma sikert.

A „sérült állapot” nem elméleti: elég egy áramszünet írás közben, vagy egy
újabb verzió után visszatelepített régebbi build (a mentett fájlban olyan enum-
érték van, amit a régi kód nem ismer).
