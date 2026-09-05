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
`node --test` fed le; a Kotlin és Swift változat ennek pontos tükre.

Hogy a „pontos tükör” ne csak szándék maradjon, a CI ellenőrzi is:
`scripts/check-core-sync.js` a HÁROM FORRÁSBÓL olvassa ki a döntő számokat
(nehézségi szintek négy fokozata, a várakozási ablak, a törlés türelmi ideje, a
kísérlet elévülése, a feladás hűtési ideje, az óraugrás küszöbe, a
feladás-nyilvántartás korlátja, a szünethosszok és a memóriakód ábécéje), és
elhasal, ha bármelyik eltér. Enélkül egy nehézségi paraméter átírása a
desktopon csendben elcsúszhatna a másik kettőtől: ugyanaz az app, két
különböző szigorúsággal, hibaüzenet nélkül. A szkript szándékosan nem másolja
be az értékeket — akkor ugyanaz a csúszás történne, csak eggyel odébb. A Kotlin
mag és a bitszintű DNS-motor JVM-en unit-tesztelt.

A számok mellett a **dróton menő MEZŐNEVEK** is őrizve vannak
(`scripts/check-wire-names.js`): a szinkron JSON-t cserél, és egy átnevezés az
egyik nyelvben nem fordítási hiba a másikban — ott hiányzó mező lesz belőle,
amire a feldolgozó alapértéket tesz. Négy blob, benne nyolc alak és
harminchét mező: a blokklista a menetrendjével és a részleges szabályaival, a
munkamenet a csomagjaival és a naplójával, a mai mérés összegzése.

Ez főleg az iPhone miatt kell. A TypeScriptet a fordító védi (a mezőnevek ott
típusok), a Kotlint drót-teszt fedi — Swiftben viszont nincs teszt, és a
`Codable` a TULAJDONSÁGNEVEKBŐL képzi a kulcsokat, tehát egy átnevezés némán
megváltoztatja a drót-alakot.

Az őr mindkét irányba kérdez. Az egyik irány: megvan-e minden várt név mind a
három nyelven. Ez önmagában átengedte a fél-átnevezést — ha egy kulcs két
helyen keletkezik, és csak az egyik csúszik el, a másik „megvan”. A `day`
pont ilyen: a mai összegzést és a mérést is ő azonosítja. A másik irány ezért
azt kérdezi, hogy a Kotlinban keletkező kulcsok közül van-e olyan, amit senki
nem őriz. Aminek nincs Swift/TS párja, az vagy a kiszolgálónak szól
(hitelesítés, titkosított blobok), vagy nyíltan adósság — soronként indokolva,
a szkript tetején. Így egy elgépelt kulcs és egy tükrözetlen új mező sem
csúszhat a drótra észrevétlenül.

**Harmadik réteg: a huzalozás** (`scripts/check-enforcement.js`). Az egyező
számok és a stimmelő mezőnevek sem érnek semmit, ha a döntést nem kérdezi meg
senki. Ez a projekt visszatérő hibafajtája: a mag megvan, teszt is van rá, csak
épp nincs meghívva — és egy nem hívott függvény tökéletesen érvényes kód.
Harminchét pont, a hosts fájlba írástól a próbatételek sorsolásáig.

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

### Önteszt: a tiltás tényleg érvényesül-e

A „Védelem aktív” sokáig csak azt jelentette, hogy a segéd fut és beírta a
sorait a hosts fájlba — nem azt, hogy a rendszer névfeloldója ezeket olvassa
is. Egy VPN-kliens saját feloldóval, egy másik program, ami a hosts fájlt írja,
vagy egy csak-IPv4-sor IPv6-os hálózaton mind úgy engedte volna át az oldalt,
hogy az app zöldet mutat. Egy önkontroll-eszköznél a hamis zöld rosszabb a
pirosnál.

Ezért a segéd **ötpercenként (és indulás után hamar) megkérdezi a rendszer
feloldóját** a tiltott nevekről — `dns.lookup`-pal, ugyanazon az úton, amin
a böngésző jár, a hosts fájllal együtt; a `resolve` a DNS-kiszolgálót
kérdezné közvetlenül, a hosts fájlt megkerülve, tehát pont azt nem mérné,
amit kell. Ami nem a tiltó címre (`0.0.0.0` / `::`) oldódik, az
**szivárgás**: a státusz-korong figyelmeztet, a blokklista alatti sor kimondja
a nevet és a címet (a lista-elrejtés szabályával), a felület gombja azonnal
újra kérdez (`self_test`, HELPER_VERSION 0.6.4). Az ítélet tiszta modul
(`shared/selftest.ts`), a kérdező a segédben (`helper/selftest.ts`).

Amit az önteszt NEM lát, kimondva: a böngésző beépített DNS-over-HTTPS-ét
(arra a házirend van, lásd fent), és a kérdezés pillanata utáni változást.
Tényt mond, nem garanciát — de a hamis zöldet megszünteti. Ugyanebből a
gondolatból lett az IPv6-sor Windowson is: a hosts fájl bejegyzése
címcsaládonként érvényes, és a v0.1 óta ott hiányzó `::` sor pont az a lyuk,
amit egy ilyen önteszt IPv6-os hálózaton kimutatott volna.

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

  Ugyanez véd a FUTÓ MUNKAMENETRE is: az ugrást elnyeljük, tehát amennyi hátra
  volt, annyi van hátra. Ez korábban rés volt — az óra előreállítása „lejárttá”
  tette a menetet, és a lejárás a szinkronon át a többi eszközre is átvitte a
  leállást, próbatétel nélkül. Az elnyelés MÁR A SZINKRON-SZÁMLÁLÓT SEM lépteti:
  a lenyomat a futás hosszát nézi, nem az abszolút időpontjait, tehát egy alvó
  eszköz „még fut” állapota nem győzi le a másik eszközön próbatétellel
  megszerzett lezárást. A részletek és a megmaradt vakfolt:
  `docs/feature-focus-sessions.md`.

  **A NAPI KERETNÉL viszont nem zárható be**, és ezt kimondjuk: a keret egy
  NAPHOZ tartozik, nem egy időtartamhoz, a napváltás pedig egy alvó gépnél
  valódi. A két esetet nem lehet megkülönböztetni, és itt a szigorúbb választás
  a gyakori esetben lenne rossz. Aki egy napot előre állít, friss keretet kap
  azon az eszközön — cserébe az egész rendszere rossz időt mutat. Indoklás:
  `docs/feature-daily-limit.md`.
- **Ha a MÉRÉS vak, a napi keret nem fogy el.** A keret mért időből fogy, tehát
  amíg a szonda nem lát semmit — macOS-en jellemzően azért, mert az
  automatizálási engedély hiányzik vagy egy frissítés visszavette —, a keret
  soha nem ürül ki, és a rá épülő tiltás nem lép életbe. Az app EZT KIÍRJA, és
  meg is mondja, hol adható vissza az engedély.

  Hogy ez mennyire nem elméleti, azt a saját kódunk mondja ki: a mérés
  KÉZZEL nem is kapcsolható ki, amíg van beállított napi keret, mert az
  „csendes kibúvó lenne”. Ugyanez a kibúvó egy elveszett engedélyen keresztül
  viszont nyitva áll.

  Miért nem zárjuk be egyszerűen. A következetes irány az lenne, hogy vak
  mérésnél a keretet KIMERÜLTNEK tekintjük (a rendszer a szigorú irányba dőljön).
  Csakhogy ennek az ára is valódi: egy lejárt rendszerengedéstől — amiről a
  felhasználó nem tehet — egyszerre záródna be minden keretes oldala, akár
  napokra. Ez a döntés a felhasználóé, nem a miénk; amíg nem választott, a
  látható figyelmeztetés a válasz, nem a néma tűrés.
- **A csatorna-szűrő hatóköre a bővítményé.** Csak abban a böngészőben él,
  ahová a bővítményt betöltötted; inkognitóban és vendég módban alapból nem
  fut, a telefonokra nem terjed ki. Egy videóról a CÍME nem árulja el a
  csatornáját — ezt a lyukat a második réteg szűkíti: a hírfolyamban a nem
  engedélyezett csatorna videókártyái eltűnnek, a lejátszó-oldal pedig tilt,
  ha a lap metaadata megnevezi a feltöltőt (elavulás-őrrel, hogy egylapos
  váltásnál az előző videó adata ne ítéljen). Ami ezután marad: metaadat
  nélküli lejátszók és csatorna-link nélküli kártyák — kimondva
  (`docs/feature-channel-filter.md`). A lazítás itt is próbatétel: a szűrő
  kapcsolható, de a kikapcsolás nem egy gomb.
- **A saját fiókkiszolgálód címe átmegy a munkamenet fehérlistáján**, mert
  enélkül a telefon nem tudná meg, hogy egy MÁSIK eszközön leállítottad a
  menetet. A címet viszont a felhasználó adja meg: aki oda a `youtube.com`-ot
  írja, megnyitja magának a YouTube-ot a menet alatt — cserébe elveszíti a
  szinkronját, vagyis a közös blokklistát és a közös napi keretet is. Kimondott,
  költséges kiút, mint a VPN-kapcsoló. A munkamenet többi kivételét gépi
  ellenőrző tartja szűken (`scripts/check-infra-allow.js`).

Ezeket a `docs/`-ban nyíltan dokumentáljuk, hogy az elvárások reálisak
legyenek.

## Fedőnév (a lista mint ingerforrás)

A blokkolás nem csak a hozzáférésről szól. Aki megnyitja az appot — akár csak
azért, hogy „megnézze a statisztikát” —, és a listán ott áll a `youtube.com`,
az kapott egy ingert. A név felidézi, mi van a másik oldalon.

Ezért minden oldalnak adható **fedőnév**. Ha van, a felület azt mutatja a cím
helyett, és a valódi cím egy gombbal, **hat másodpercre** hívható elő.

Két dolog fontos ebben:

1. **Minden megjelenítés EGY függvényen megy át** (`shared/alias.ts`,
   `displayName` / `displayNameNow`). Hét helyen jelenik meg a név: a soron, a
   napi keret és a menetrend párbeszéd címében, a törlés megerősítésében, a
   folyamatban lévő kísérlet sávjában, a próbatétel-ablak címében és a
   statisztika címkéiben. Elég egyetlen kihagyott hely, és a funkció annyit ér,
   mint egy lyukas zsák — a füstteszt ezért nem csak a listát, hanem a
   statisztikát is átnézi a fedőnév beállítása után. (Az első futáson pont a
   statisztikán bukott el: az a saját, ritkább körén frissül, és fél percig a
   régi címkét mutatta volna.)

2. **Ez NEM biztonsági határ.** A hosts fájlban ott a cím, bárki megnézheti; a
   segéd nem is tud a fedőnévről, mert az tisztán felületi dolog. Inger-
   eltávolítás, nem titkosítás — a párbeszéd szövege is így mondja, hogy senki
   ne higgye másnak.

Mind a három magban ugyanaz: `desktop/src/shared/alias.ts`,
`android/.../core/Alias.kt`, `ios/Shared/Alias.swift`. A két számot (40 karakter,
6 másodperc) a `scripts/check-core-sync.js` őrzi — ha az egyik magban elcsúszna,
ugyanaz a név az egyik eszközön elférne, a másikon csonkulna.

A fedőnév beállítása és levétele **nem kerül próbatételbe**. A súrlódás ott van,
ahol a védelem gyengülne; itt nem gyengül semmi: az oldal ugyanúgy blokkolva
marad, a hosts fájl egy bájtot sem változik.

## A lista elrejtése

A fedőnév oldalanként dolgozik. Van, akinek ennél több kell: **ne is látszódjon,
mi van blokkolva** — se induláskor, se a statisztikában. Erre való a
`hideSiteList` beállítás.

Két külön dolog, és pont ez a lényege:

- **`hideSiteList`** — tárolt beállítás a segédben: „rejtve induljon”.
- **`listOpenThisSession`** — a felület modulszintű változója, ami minden
  indításkor `false`. A „Lista megnyitása” ezt állítja át.

Így a lista minden induláskor csukva van, de aki tényleg dolgozni akar vele, egy
kattintással hozzáfér — nem kell próbatétel, mert a rejtés nem véd semmit, csak
nem emlékeztet.

A rejtés az **egész ablakra** szól, nem csak a listakártyára:

| Hol | Rejtve mi látszik |
|---|---|
| a lista | „3 oldal van blokkolva” — a darabszám marad, a nevek nem |
| gyorsgombok a felvevő kártyán | nincsenek (pont a tipikus címek állnak rajtuk) |
| a beviteli mező példája és a társoldal-jelölő | általános szöveg, cím nélkül |
| statisztika | `1. rejtett oldal`, `2. rejtett oldal` — a „blokkolt” jelölés és az idő marad |
| fejléc-jelvény | „Védelem aktív — 3 oldal blokkolva” (csak szám) |

A sorszám a lista sorrendjéből jön, tehát két frissítés között nem ugrál, és
ugyanazt az oldalt mindig ugyanaz a szám jelöli. Akinek van **fedőneve**, annál a
fedőnév erősebb: azt épp azért adta meg, hogy az látszódjon.

A listakártya rejtve **ki is üríti** a sorokat, nem csak eltakarja őket. Így a
rejtett állapot ugyanaz akkor is, ha indulásból az, és akkor is, ha most
kapcsolták rá.

Androidon és iPhone-on ugyanez a beállítás, ugyanazzal a két állapottal
(`hideSiteList` a mentett állapotban, `listOpenThisSession` a felületen). iPhone-on
a statisztika nem tud oldalanként bontani (nincs ilyen API), tehát ott nincs is mit
elfedni benne.

A füstteszt ezt a teljes látható szövegre (`innerText`) nézi meg: rejtett
listánál egyetlen blokkolt cím sem lehet ott sehol. Ez fogta meg, hogy a
statisztika a saját, ritkább körén frissül, és a rejtés bekapcsolása után még fél
percig kiírta a címeket — ugyanaz a hiba, mint a fedőnévnél.

Amit **nem** csinál: nem biztonsági határ ez sem. A hosts fájlban ott a cím, és a
darabszámot szándékosan meghagyjuk. A cél az emlékeztetés megszüntetése, nem a
titkolózás.

## Fiók és szinkron

Külön doksi: [`feature-accounts-sync.md`](feature-accounts-sync.md). A lényeg
egy mondatban: a kiszolgáló **átlátszatlan blobokat** tárol, az összefésülés
pedig **sosem lazít** — a kijelentkezés és az eszköz eltávolítása egyetlen
blokkot sem visz el.

Ami ide tartozik: a `rev` számlálókat mindhárom platformon **egyetlen fogópont**
vezeti (asztalon a segéd `commit()`-ja, Androidon a `BreakerStore.mutate`).
Tucatnyi helyen módosul egy rekord, és elég egyetlen kihagyott hely ahhoz, hogy
egy változás sose menjen át a másik eszközre.

A szinkronnak van egy következménye a mérésre nézve is: a többi eszköz adata
**olvashatóan** megérkezik, tehát a felület az **összes eszközt együtt** is meg
tudja mutatni — és iPhone-on ez az egyetlen statisztika, ami valaha látszani
fog (lásd fentebb, miért nem mérhet az iOS-app). Az összesítés egyetlen
mérés-állapottá fésüli a blobokat, és arra ugyanaz az összegző fut, mint a
helyi nézeten: két külön implementáció előbb-utóbb más számot mutatna ugyanarra
a kérdésre.

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
| Egy korábbi néven telepített segéd is fut (átnevezés után) | két démon körbe-körbe írja felül egymást a hosts fájlban, folyamatos DNS-ürítéssel, némán | a sorozatos visszatérésre abbahagyjuk a takarítást (a régi blokk marad = több tiltás), és a felület kiírja, mi állítja le |
| Frissítés után az új GUI a RÉGI helperrel beszél | az ismeretlen parancs `data: undefined`-dal „sikerül” → a felhasználó azt hiszi, beállította a napi keretet | a helper `UNKNOWN_OP`-pal elhasal, a GUI sávban jelzi, és egy gombbal cseréli a démont |

### Az egy kivétel: a magyarázó réteg fordítva dől

Egyetlen réteg van, ahol a hiba helyes iránya NEM a tiltás: a zárva-magyarázat
(a bővítmény tiltó lapja a DNS-hibalap helyett, és a telefon értesítése futó
hűtésnél). Ez a réteg nem érvényesít semmit — a tiltást a hosts-fájl és a
DNS-szűrő tartja —, hanem BESZÉL. Egy elavult „zárva” felirat ezért nem
szigorítás lenne, hanem hazugság: letagadná a lejárt hűtést, az éjféli
keret-újraindulást, sőt a próbatétellel megváltott feloldást is.

Ezért itt kétes esetben a hallgatás nyer: a bejegyzés a saját idejével lejár,
az egész lista pedig csak a legutóbbi sikeres lehúzás után pár körig érvényes
(`CLOSED_FRESH_MS`). Ha a magyarázat elhallgat, a felhasználó a nyers
hibalapot látja — pontosan azt, amit eddig; ha viszont hazudna, a rendszer
legdrágább tulajdonát költené: azt, hogy amit kiír, az igaz.

### A visszatérő hiba: futás-jelző + soha be nem fejeződő művelet

Ez a projekt legmakacsabb hibamintája, és egyetlen nap alatt NÉGY helyen
találtuk meg. Érdemes felismerni, mert mindegyik példány CSENDES: nem hibázik,
nem naplóz, nem jelez — egyszerűen nem történik többé semmi.

A recept két hozzávalós:

1. egy „épp fut egy kör” jelző, hogy a művelet ne torlódjon fel önmaga mögött,
   és amit **csak a befejezés töröl**;
2. egy művelet, aminek **nincs felső időkorlátja**.

Ha a második egyszer beragad, az első örökre bezárul: onnantól minden későbbi
kör azonnal visszafordul. A rendszer nem elromlik, hanem MEGÁLL — és a
felhasználó csak a következményt látja (nulla statisztikát, régi
szabálylistát, befagyott időbélyeget), az okot nem.

Ahol előfordult:

| Hol | Mi ragadhatott be | Mi állt le tőle |
|---|---|---|
| Szinkron-kör (`sync-schedule` + `call`) | a válasz TÖRZSÉNEK olvasása (az időkorlát csak a fejlécig ért) | a szinkron a folyamat hátralévő életére |
| Mérés (`UsageTracker.tick`) | az `osascript` az engedélykérő ablakon | a mérés — és a szonda-figyelmeztetés SEM szólalt meg, mert az hibát számol, nem elmaradást |
| Bővítmény (`pullFromApp`) | egy port, ami fogadja a kapcsolatot, de nem válaszol (a böngésző `fetch`-ének nincs alapértelmezett határideje) | a szabályok frissítése |
| Bővítmény, második fele | — | minden lapbetöltés újraindította a keresést, mert a sikertelen kör nem léptette az időbélyeget |

A szabály tehát: **ha van futás-jelző, a művelethez kell felső időkorlát is.**
A kettő együtt jár. És a határidőnek a művelet EGÉSZÉRE kell vonatkoznia, nem
csak az első lépésére — a fejléc megvárása még nem a válasz.

Egy csapda a javításban, amibe bele is estünk: a törzsre kiterjesztett
határidőt először a fejléccel KÖZÖS keretből vettük. Egy megabájtos blob egy
rossz mobilneten viszont több, mint a fejlécre szabott idő — vagyis a javítás
minden lassú kapcsolaton elrontotta volna azt, ami addig működött. A két
szakasz külön keretet kap.

### A rokon hibaminta: egyetlen esemény mint egyetlen esély

Ugyanennek a családnak a másik tagja: amikor egy KÖTELEZŐ művelet egyetlen
eseményre van felfűzve, az esemény elvesztése néma kihagyás. A bővítmény
tiltása sokáig csak az `onBeforeNavigate`-en múlt — a szolgáltatás-worker
élete viszont nem a miénk, és egy ébredés közben elejtett esemény átengedte
volna a tiltott lapot, nyom nélkül. A válasz kettős: (1) a döntés KÉT
független eseményen fut (navigáció előtt és megtörténtekor — kétszer dönteni
olcsó, egyszer kihagyni drága), és (2) a háttér memóriabeli nyomgyűrűt vezet
arról, mit látott és mit döntött, hogy egy elmaradt tiltásról meg lehessen
mondani, MELYIK láncszem hallgatott. A bővítmény-füstteszt stressz-futásai
pont ezzel a nyommal különítették el a termék hibáját a tesztkörnyezet
vakfoltjától.

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
