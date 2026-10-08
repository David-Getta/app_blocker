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

## Megakadások: a tükör harmadik fele

A mérés azt mondja, mire ment el az idő; a menetek azt, hányszor ültél le
dolgozni. A harmadik fele az, amit a tiltás csinál, amikor nem figyelsz:
hányszor állított meg. Ez a **megakadás** — a kéz odanyúlt, a tiltás
megállította. Tükör, nem ítélet: számol, nem minősít.

**Ki könyvel.** A gépen a böngésző-bővítmény (`extension/hits.js`): egy tiltó
lapra vitt navigáció egy megakadás — naponként, okonként (zárva oldal,
munkamenet, csatorna, részleges szabály, kulcsszó), óránként (a nap
huszonnégy rekesze) és hosztonként; harminc napig. A hídon (`POST /hits`, a
kóddal, egy állandó forrás-azonosítóval) a napi összeg, az okok, az órák és a
nap öt leggyakoribb hosztja megy a segédnek — a gépen belül; a teljes
hoszt-könyv a bővítményé marad. A segéd forrásonként tartja
(`shared/browser-hits.ts`, `browserHits` az állapotban; két böngésző két könyv,
a segéd összeadja), a hosztot a lista tételéhez rendeli (a `m.youtube.com` és a
`www.youtube.com` egy oldal). A telefonon a szűrő könyvel
(`core/FilterHits.kt`, `Shared/FilterHits.swift`): egy tiltott lekérdezés egy
megakadás — hosztonként két percen belül egyszer, mert egy oldalbetöltés
tucatnyi lekérdezés —, és csak a lista és a kulcsszó tiltása: a munkamenet fehérlistáján
kívül rekedt háttér-forgalom nem a kéz mozdulata. Naponként, óránként, a
lista tételével oldalanként és okonként (lista vagy kulcsszó); a nyers
hosztot nem tárolja.

**Ki mondja.** A statisztika (a hét alakja, a csúcs-óra, az okok, a
csúcs-oldal; négy hétből a csúcs-nap, és a tükör másik feléről a menet-nap,
a menet-óra és a mért idő napja — a hét napjainak és az órák sávjával; és ha
a csúcs-óra a menet-óra, vagy a csúcs-nap a menet-nap, a sor kimondja); a döntés helyén — a gépi kártya, a
réteg lába, a telefon kezdőlapja, a böngésző lapjai — a csúcs-nap, a
menet-nap, a menet-óra és a mért idő napja, ha ma van; a heti mondat: „12 megakadás a böngészőben, a csúcs 21–22 óra, a legtöbbször: youtube.com (7×).”;
a bővítmény felugró és beállítás-lapja; a tiltó lap a kísértés pillanatában:
„Ma ez a 7. megakadás — ebből a 3. ezen az oldalon.”; a hét az előző héthez képest
(„A héten 12 megakadás, az előző héten 18.” — a híd ehhez két hetet visz);
a gyorsbillentyűs réteg
lába és az Android szűrő-értesítésének sora. A rejtett lista és a fedőnév
mindenhol fed.

**Mit javasol.** A sokadik megakadásnál (5, 10, 20) egyszer egy lépést: egy
munkamenet vagy egy rövid zárlat — a gépen és Androidon értesítésben, a
telefon kezdőlapján és a gépi statisztikán egy kártyán, amelynek gombja a
legutóbb használt csomagot indítja a szokásos hosszával (szigorítás, ingyen).
Tíz perccel a hét csúcs-órája előtt előre szól — a gépen a felület, Androidon
a szolgáltatás, iPhone-on a rendszernél ütemezett kérés; és ugyanígy a négy
hét menet-órája előtt (ha a kettő ugyanaz az óra, csak a csúcs-óráé szól). A
lépcsők, a tíz perc és a küszöb a három magban azonos (`check-core-sync`). Nem tilt, nem
ítél; a döntés az emberé — és ha nem kéred, csendben marad (a gépen a
háttér-panel, a telefonon a statisztika kapcsolója), a kártya és a
statisztika sora akkor is mondja.

**A tükör darabjai egy táblában.** Öt tükör, két fél: a kísértésé (mikor és
melyik napon jár a kéz magától) és a döntésé (mikor és melyik napon ülsz le,
melyik napon megy el a legtöbb idő). Mind ugyanabból a mintából és
ugyanazokkal a küszöbökkel dolgozik (`check-core-sync`), és mind ugyanoda ér:
a statisztika sorába, a heti mondatba, a döntés helyére — és ahol lépés
következik belőle, oda egy gomb.

| Tükör | Miből | Hol mondja | Lépés |
|---|---|---|---|
| csúcs-óra | a hét megakadásai óránként | statisztika (órák sávja), heti mondat, a csúcs-órában a kártya, a réteg, a böngésző lapjai, az Android sáv | előjelzés tíz perccel előtte; heti ablak egy kattintással (statisztika, kártya, böngésző, értesítés); a fedést kimondja |
| csúcs-nap | négy hét megakadásai a hét napjaira | statisztika (napok sávja), heti mondat, a csúcs-napon a kártya, a réteg, a böngésző lapjai, az Android sáv | — (tény) |
| menet-nap | négy hét menetei a vég napjára | statisztika, heti mondat, a menet-napon a kártya, a réteg, a böngésző lapjai, az Android sáv | — (tény); ha a csúcs-nap, a sor és a heti mondat kimondja |
| menet-óra | négy hét menetei az indulás órájára | statisztika (órák sávja), heti mondat, a menet-órában a kártya, a réteg, a böngésző lapjai, az Android sáv | előjelzés tíz perccel előtte; heti ablak egy kattintással (statisztika, kártya, böngésző, értesítés); a fedést kimondja; ha a csúcs-óra, a sor és a felugró lap kimondja |
| mért idő napja | négy hét mért ideje a hét napjaira (gép, Android) | statisztika (napok sávja), heti mondat, a napján a kártya, a réteg, az Android sáv | — (tény) |
| menet-sorozat | a napló napjai visszafelé a mától (vagy a tegnaptól) | statisztika (a rekorddal), heti mondat, a kártya, a réteg és a böngésző lapjai (a rekorddal, a mostani mellett), az Android sáv | — (tény) |

A szabály mindenütt ugyanaz: kétszer ugyanazt nem (ha a menet-óra a csúcs-óra,
a csúcs-óra gombja és előjelzése szól), elég minta nélkül nincs mondat, futó
menet mellett nincs javaslat, és ha nem kéred, az értesítés csendben marad.

**Ami nem megy sehova.** A könyv a készüléken marad, a fiókba nem megy — a
megakadás a gép saját tükre, mint a heti napló. A bekötést ellenőrző-tűk
őrzik (`scripts/check-enforcement.js`): a mag megvolna teszt nélkül is, a
huzalozatlan mag viszont csendben nullát mondana.

## Közös mag

A `domain-normalizálás`, `preset-bővítés`, a teljes `próbatétel-motor`, a `bíró`
(session-kezelés) és a `tier`-számítás minden platformon azonos algoritmus.
Referenciaimplementáció a TypeScript (`desktop/src/shared`), amelyet
`node --test` fed le; a Kotlin és Swift változat ennek pontos tükre.

Hogy a „pontos tükör” ne csak szándék maradjon, a CI ellenőrzi is:
`scripts/check-core-sync.js` a HÁROM FORRÁSBÓL olvassa ki a döntő számokat
(nehézségi szintek négy fokozata, a várakozási ablak, a törlés türelmi ideje, a
kísérlet elévülése, a feladás hűtési ideje, az óraugrás küszöbe, a
feladás-nyilvántartás korlátja, a szünethosszok, a memóriakód ábécéje — és a
szinkron plafonjai: a hosztnév-jelek, a csomagok, a csomag-jelek, a részleges
szabályok és a mérés-célok korlátja, mert egy eltérő plafon nem hibaüzenet,
hanem nem konvergáló szinkron), és elhasal, ha bármelyik eltér. Enélkül egy nehézségi paraméter átírása a
desktopon csendben elcsúszhatna a másik kettőtől: ugyanaz az app, két
különböző szigorúsággal, hibaüzenet nélkül. A szkript szándékosan nem másolja
be az értékeket — akkor ugyanaz a csúszás történne, csak eggyel odébb. A
közös magban a nyelv- és naptárfüggő hívás is tilos (`localeCompare`, a
`toLocale…`, a Java `toLowerCase()`-e és `Locale.ROOT` nélküli `format`-ja,
a `Calendar.getInstance()`, a Swift `localized…` hívásai és a
`Calendar.current`): a rendezés, a számjegy és a dátum a készülék
beállítását követné — magyar beállításon a „cz.hu” a „csak.hu” elé kerül, arab
nyelven a hét kulcsa nem latin számjegyű, buddhista naptárú iPhone-on a
napkulcs éve 2569 —, a többi eszközét nem. Az őr a hosztnév-kiegészítés
előre megadott listáját (PRESETS: a YouTube-hoz a youtu.be, az X-hez a
twitter.com) is összeveti a három magban. Az őrnek volt egy saját vakfoltja is: a két telefon közötti párok
és feliratok a kilépés UTÁN gyűltek, és sosem buktattak; most a kilépés az
összes ellenőrzés mögött áll, és egy beágyazott zárójeles Swift-behelyettesítés
sem téveszti meg. A Kotlin mag és a bitszintű DNS-motor JVM-en unit-tesztelt.

A számok mellett a **dróton menő MEZŐNEVEK** is őrizve vannak
(`scripts/check-wire-names.js`): a szinkron JSON-t cserél, és egy átnevezés az
egyik nyelvben nem fordítási hiba a másikban — ott hiányzó mező lesz belőle,
amire a feldolgozó alapértéket tesz. Négy blob, benne nyolc alak és
ma hetven körüli mező: a blokklista a menetrendjével és a részleges
szabályaival, a munkamenet a csomagjaival, a naplójával, a zárlattal és a
zárlat-ablakokkal, a mai mérés összegzése. A pontos számot a szkript írja ki.

Ez főleg az iPhone miatt kell. A TypeScriptet a fordító védi (a mezőnevek ott
típusok), a Kotlint drót-teszt fedi — Swiftben viszont a `Codable` a
TULAJDONSÁGNEVEKBŐL képzi a kulcsokat, tehát egy átnevezés némán megváltoztatja
a drót-alakot, és ezt a három nyelv közös fésülés-próbája (`fixtures/`) csak a
benne szereplő mezőkön kapja el.

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
Ma száztíz fölötti pont, a hosts fájlba írástól a próbatételek sorsolásáig és
a zárlat-ablak köréig; a pontos számot a szkript írja ki.

**Negyedik réteg: a megfelelőségi fixtúra** (`fixtures/merge-cases.json`,
írja `desktop/test/merge-fixture.test.ts`, visszajátssza a Kotlin
`MergeFixtureTest` és a Swift `MergeFixtureTests`). Az egyező számok, a
stimmelő mezőnevek és a huzalozás sem mondja meg, hogy a három mag UGYANAZT
számolja-e ugyanabból. Ezt a fixtúra kérdezi: a gép kiszámolt bemeneteket és
eredmény-kulcsokat ír, a másik két nyelv a saját drót-olvasóján át veszi a
bemeneteket, a saját magjával számol, és a kulcsnak bájtra egyeznie kell.
Ma kilenc szekció: az oldal-rekordok fésülése minden mezővel (hosztnevek a
jeleikkel, törlésre várás, keret, fedőnév, indok, menetrend, adag, részleges
szabályok a jelükkel), és minden esethez egy egy mezőben más pár mindkét
sorrendben — a szigorúság-lánc és a döntetlen-törés éles esetei; a
munkamenet-blobok fésülése minden mezővel (csomagok a jeleikkel, menet, napló
— ugyanarról a menetről két változat is —, zárlat, ablakok, kulcsszavak,
megbízott, rejtés, a jeleikkel), és minden esethez egy mező cseréje, amit a
három nyelvnek ugyanúgy kell különbségnek tartania; a mérés egyesítése három
eszközről és az összegzője (ma, tegnap, hét, hónap, toplisták holtversenyben
a kulcs szerint, a hét az előző héthez — az iPhone a maga kisebb részén); a döntés — tilt-e most: szünet, törlésre várás, közös napi keret;
és az adag-számláló mérés-sorozatból, lépésenként (ezt a gép és az Android
tükrözi, az iPhone nem mér előteret); és a munkamenet-döntés — mi mehet egy
menet alatt — a két telefon DNS-motorában, a gép közös darabjaiból írt
referencia szerint; és a menetrend — tilt-e most egy heti sávrendszer
(éjfélen átnyúló és érvénytelen sávokkal, mindhárom módban) szerint, és
lazítás-e a csere egy másikra — UTC-ben, mert a sávok helyi időben
értékelődnek ki: a három teszt ezt kimondja és beállítja (a Swift kihagy, ha
nem tudja). Ez az, ami a gépen és a telefonon EGYSZERRE dönt ugyanarról az
oldalról. És a zárlat-ablakok, ugyanígy UTC-ben: marad-e szabad idő a héten,
lazítás-e a lista cseréje, az élő ablak előfordulása, a zárlat, amit az
ablakok most megkövetelnek (futó zárlat mellett és nélkül), ablak-zárlat-e,
a közelgő ablak, és a következő előfordulás — a heti ablak minden eszközön
ugyanakkor zár és ugyanakkor enged. És a menetek összegzése a naplóból,
ugyanígy UTC-ben: a hét és az előző hét (menet, idő, korai vég, ablakból
indult, a leggyakoribb csomag — holtversenyben az először látott), a
menet-napok, a menet-órák, a sorozat és a leghosszabb sorozat, az ablakból
indult menetek csomagonként, a napi rajz — a statisztika és a heti mondat
számai. A fésülés-generátorok véletlenje
szerződés: a Kotlin és a Swift fuzz ugyanazt a sorozatot húzza ugyanabból a
magból. A fuzz MÉLYSÉGE állítható: alapból a megszokott magszám fut (a CI-ban
gyorsan), `FUZZ_DEPTH=k` mellett mindhárom nyelvben a k-szorosa, ugyanazokkal
a magokkal (`desktop/test/fuzz-depth.ts`, a Kotlin `FuzzDepth.kt`, a Swift
`FuzzDepth.swift`). Nem díszítés: az ablakos csomagok fésülésének ritka
sorrendfüggését a 300 magos futás átengedte, egy százezres megfogta — egy
szinkron-szabály változása után a mély futás a kötelező kör. A véletlen-teszt
azt is kimondja, hol NEM áll a sorrendfüggetlenség: az oldal-lista domain
szerinti összevonása eldobja a beolvasztott azonosítót, ezért ahol egy
domainre két azonosító szól és valamelyiknek sírköve van, három eszköz más
sorrendben más listára juthat. A `list-fuzz.test.ts` ezt a határt őrzi —
máshol a sorrend nem számít —, és azt, ami ott is áll: a legújabban felvett
példányt csak a saját sírköve viheti el, és a kiszolgálón át futó szinkron
néhány kör alatt megáll. És az őr: a drótnév-ellenőrző azt is nézi, hogy minden őrzött
drót-mező ott van a fixtúra generátorában — egy új mező nem maradhat ki
csendben az összevetésből. A fixtúra fogta ki a v0.4.170 Swift-rését (a
normalizálás eldobta a rejtést), és a szabálylista sorrendfüggését egy régi
kliens mellett, amiből a szabályok jele lett — ma már szabályonként, mert a
lista-jel egyenlő jelnél még mindig a rekord rev-jére hagyatkozott, amit a
teljes rekordot néző véletlen-teszt fogott ki. A réteg második fájlja a
SZÖVEG-TISZTÍTÁSÉ (`fixtures/text-cases.json`, írja
`desktop/test/text-fixture.test.ts`, visszajátssza a Kotlin `TextFixtureTest`
és a Swift `TextFixtureTests`): a fedőnév, az indok, a kulcsszó, a megbízott
neve és jelmondata, a domain tiszta alakja — ugyanazt tartja-e a három mag
szóköznek (a készlet kimondott: a JS huszonöt kódpontja, a BOM-mal és a nem
törő szóközzel; a platformok saját fogalma mind másképp tudta), ugyanott
vág-e (kódpontban, nem UTF-16 egységben és nem grafémában), ugyanúgy
kezeli-e az NFKC-t és a kisbetűsítést — és a böngésző-bővítmény is
visszajátssza a kulcsszó és a részleges szabály szekcióit a kiszállított
másolatán (`desktop/test/extension-fixture.test.ts`), mert a böngészőben ő
dönt; ez fogta ki, hogy a bővítmény az út hosszát még UTF-16 egységben mérte.
A fixtúra fogta ki azt is, hogy a gép egy fél emodzsit hagyhatott a fedőnév
végén, és hogy a két telefon a jelmondat nem
törő szóközét nem vette szóköznek — a lenyomat nem egyezett volna —, és az
első CI-körében azt, hogy az iPhone a görög szó végi szigmát σ-nak írta
kisbetűvel, a gép és az Android ς-nek. A réteg harmadik fájlja a PÁROSÍTÓ
KÓDÉ (`fixtures/pairing-cases.json`, írja `desktop/test/pairing-fixture.test.ts`,
visszajátssza a Kotlin `PairingFixtureTest` és a Swift `PairingFixtureTests`):
a gépen kiírt kódot a telefonon gépelik be, tehát ez a legközvetlenebb
szerződés a három nyelv között — cím → kód, beírt szöveg → cím (kézzel írt
alakok: kötőjel, szóköz, kisbetű, O/0, I/1, nem latin számjegy, teljes
szélességű betű, elgépelés, szemét), egy mező kódnak és címnek, a kód olvasható
alakja. A Swift párosítónak ez az első tesztje; az első írása két eltérést
igazított: a nem latin számjegyet a kód végén a gép kiszűri, az iPhone nem
tudta, és a séma nélküli cím mintája lazább volt, mint a gépé. A szöveg-fixtúra
a részleges szabályt is nézi: a beírt szöveg kanonikus alakját és a szabály
illesztését egy címre — itt az út hossza kódpontban számol mindhárom magban
(a Swift grafémát, a gép és az Android UTF-16 egységet számolt), a szélek a
kimondott szóköz-készlet szerint vágnak, és az út kisbetűje a gép szabálya
szerint készül. A réteg negyedik fájlja a HETI VISSZATEKINTÉSÉ
(`fixtures/digest-cases.json`, írja `desktop/test/digest-fixture.test.ts`,
visszajátssza a Kotlin `DigestFixtureTest` és a Swift `DigestFixtureTests`):
egy hét számaiból a három mag ugyanazt a hétfő reggeli mondatot írja — a
trend kerekítése, a menetek, a sorozat, a csúcs-óra és a menet-óra, a
feloldások, a keret, az adag, a megakadások, a nem tiltott idővivő —, egy
kimondott szót leszámítva: a megakadás szava a platformé (a gépen a
böngésző, a telefonon a szűrő), azt a visszajátszók a gépére írják át. A
réteg ötödik fájlja a SZINKRON TITKOSÍTÁSÁÉ (`fixtures/crypto-cases.json`,
írja `desktop/test/crypto-fixture.test.ts`, visszajátssza a Kotlin
`CryptoFixtureTest` és a Swift `CryptoFixtureTests`): a gép burkol és
titkosít, a telefon nyit — scrypt-vektorok (az RFC kettője, és a mi
paramétereink a fiókokon át), a jelszóból származó belépőkulcs és a vele
burkolt adatkulcs hat fiókra (ékezet két alakban, NFC és NFD; emodzsi;
teljes szélességű betű, ligatúra és bekarikázott számjegy, ami NFKC után a
sima alak; szóköz a szélen, ami a jelszó része; vegyes írás), a helyreállító
kód tiszta alakja a kézzel írt és a buktató alakokra, a jelszó hossza a
korlát két oldalán, a gép blobjai (üres, ékezetes, emodzsis, hosszú, a
szabványos base64-ábécével is), és amit nem szabad kinyitni (más előtag,
csonka, rossz méretű IV és címke, babrált titkos és címke, üres titkos, más
kulcs). A blobok IV-je a fixtúrában rögzített magú, hogy a fájl kétszer
ugyanaz legyen — a termék titkosítója véletlent húz, és a teszt ezt is
nézi. A Swift titkosításának és scryptjének ez az első tesztje; az első
írása két eltérést igazított: az iPhone a helyreállító kódot grafémánként
szűrte (egy különálló ékezet az egész betűt elvitte, a gép és az Android
csak az ékezetet), és a jelszó hosszát a három mag három mércével mérte (a
gép UTF-16 egységben NFKC után, az Android egységben NFKC nélkül, az iPhone
grafémában) — most kódpontban, NFKC után, mindhárom, és a hívót az
érvényesítés-őr nézi. A réteg hatodik fájlja a PRÓBATÉTEL VÁLASZÁÉ
(`fixtures/challenge-cases.json`, írja `desktop/test/challenge-fixture.test.ts`,
visszajátssza a Kotlin `ChallengeFixtureTest` és a Swift
`ChallengeFixtureTests`): a fok a feloldások naplójából (a hét határa
ezredmásodpercre, a jövőbeli sor), a hátralévő-jelzés, a kombináció-kulcs
oda-vissza (ismétlődő típus, túl hosszú, ismeretlen, üres rész, kisbetű), és a
válasz — a lépés a gép alakjában, a beírás, az időpont: jó-e, kész-e, marad-e
a lépés vagy újat kap, hol áll a lánc. A hibás válasz ára nagy (a lánc
elölről, új kód), és három motor olvasta a beírást a maga nyelvén: a gép
`parseInt`-je a „157abc”-t 157-nek vette, az Android a nem latin számjegyet
számnak, az iPhone a sorvéget nem vágta a kód mellől és az NFD átgépelést is
elfogadta — most a szabály kimondva (szóköz ki a közös készlet szerint,
előjel, csak ASCII számjegy; a kód szélei ugyanazzal a készlettel; a szöveg
kódpontra pontos), mindhárom motorban, a hívót az érvényesítés-őr nézi. A
réteg hetedik fájlja a NAPI KERETÉ (`fixtures/limit-cases.json`, írja
`desktop/test/limit-fixture.test.ts`, visszajátssza a Kotlin `LimitFixtureTest`
és a Swift `LimitFixtureTests`, UTC-ben): a dróton jövő mai összegzés a blob
szövegéből — ezt a három kliens a saját JSON-olvasójával olvasta, és
mindhárom másban engedett (a gép a tömböt, az Android a szövegként írt
számot, az iPhone az igaz/hamisat), a 200-as plafon fölött pedig mindhárom
más sorrendben vágott; most egy szabály (`parseTodayDigest`: csak szám, ASCII
nap, kerekítés után pozitív, a legnagyobbak maradnak, holtversenyben a kulcs)
—, a keret betelt napjai és a sora (holtversenyben kódegység; a gép
`localeCompare`-je a nyelvi beállítást követte), a „ma még N perc” sor, a
lazítás, a hátralévő, és hogy kimerült-e a keret a többi eszköz percével (a
gép itt a nyers keretet nézte, egy napnál nagyobbat vágás nélkül; most a
közös `normalizeLimit`-et, mint a két telefon). A réteg nyolcadik fájlja a
MUNKAMENET MAGJÁÉ (`fixtures/focus-cases.json`, írja
`desktop/test/focus-fixture.test.ts`, visszajátssza a Kotlin `FocusFixtureTest`
és a Swift `FocusFixtureTests`, UTC-ben): az ismétlődő menet előfordulása és
az esedékes ablak (holtversenyben a kisebb azonosító, kódegység szerint), az
ablak-menet, a lezárás a napló vágásával, a legutóbb használt csomag, a
hátralévő idő szövege és a percek tisztítása — az Android `toInt()`-je egy
hárommilliárdos percszámot negatívra fordított. A szöveg-fixtúra pedig az
engedélyezett app nevét és az app-egyezést is nézi (a Java-regex csak az
ASCII szóközt ismerte, a Swift grafémában vágott és keresett; az üres tétel
eddig mindent engedett), és a csomag nevét meg a naplósor nevét (a gép
UTF-16-ban vágott, egy emodzsit félbe — a párja nélküli fél az iPhone
olvasóján az egész munkamenet-dokumentumot vitte —, az Android a saját
szóköz-fogalmával, az iPhone grafémában; a felvételkor a két telefon más-más
készlettel vonta össze a szóközöket, a gép sehogy). A réteg kilencedik fájlja
a DRÓTON JÖTT REKORDOKÉ (`fixtures/wire-cases.json`, írja
`desktop/test/wire-fixture.test.ts`, visszajátssza a Kotlin `WireFixtureTest`
és a Swift `WireFixtureTests` — a szinkron saját olvasóján át): oldal-listák
és munkamenet-dokumentumok hibás elemekkel, és hogy mi marad belőlük. A
szabály a gépé: a rekord csak az azonosító (az oldalnál a domain) hibájára
esik ki, minden más mező rossz típusa az alapértékét kapja — csak JSON-szám a
szám, csak szöveg a szöveg, csak a valódi `true` igaz. Két valódi hibát
fogott: az iPhone a listát EGYBEN dekódolta (egyetlen rossz rekord az egészet
vitte, a kör üresnek látta a kiszolgálót, és a saját listáját tolta fel; egy
rossz nevű csomag azonosítója pedig nem lett „látott”, így a jele sírkőnek
látszott volna, és a csomag mindenhol törlődött volna), az Android pedig az org.json
kényszerítésével a „5” szöveget számnak, az 5-öt szövegnek vette, és egy
hiányzó felvételi idő vagy egy nem lista hosztnév-mező az egész oldalt vitte.
A későbbi körök a menetrendre, a részleges szabályokra és a
munkamenet-dokumentum többi mezőjére (futó menet, zárlat, ablakok,
kulcsszavak, megbízott) is kiterjesztették — a gép döntését egy nem tömb
sávlista addig ledöntötte. A réteg tizedik fájlja az ÓRAÁTÁLLÍTÁSÉ
(`fixtures/dst-cases.json`, írja `desktop/test/dst-fixture.test.ts`,
visszajátssza a Kotlin `DstFixtureTest` és a Swift `DstFixtureTests`): a
többi fixtúra UTC-ben jár, ez Europe/Budapest időzónában, a 2026-os tavaszi
és őszi éjszakán — hajnali sávok előfordulása és a menetrend döntése
negyedóránként. Két valódi hibát fogott: a Java naptára a kétszer előforduló
őszi 2:30-at a második előfordulásra tette (a gép az elsőre — egy hajnali
heti ablak az Androidon egy órával később indult volna, két naplósorral), a
gép pedig a menetrend következő váltását helyi időben percre vágva kereste,
és az ismétlődő órában egy múltbeli időpontot adott. A szabály mindhárom
magban a JS-é: a kétszer előforduló idő az első, a kihagyott az átállás
előtti eltolással.

## Biztonsági modell és őszinte korlátok

A Breaker **önkontroll-eszköz elszánt, de önmagával együttműködő felhasználónak**,
nem szülői felügyeleti vagy kártevő-elleni megoldás. Aki technikailag hozzáértő
és eltökélt, meg tudja kerülni. A cél a **súrlódás** növelése annyira, hogy a
pillanatnyi impulzus ne legyen elég a feloldáshoz.

### A zárlat: a súrlódás felső határa

A súrlódás DRÁGÍT, de ára van, tehát útja is: aki elszánja magát, átrágja magát
a próbatételen. A zárlat az a réteg, ami ezt lezárja — amíg tart, a bíró el sem
indít lazító próbatételt. Nem nehezebb: NINCS.

Három tulajdonsága teszi azzá, ami:

1. **Egyetlen kapu.** Mindhárom magban minden próbatétel-terv ugyanazon a
   függvényen megy ki (`planLoosening`), és a zárlat őre ott áll. Nem tíz külön
   ellenőrzés, amiből egy lemaradhat — a `check-enforcement.js` és a
   `desktop/test/lockdown.test.ts` a forrásból ellenőrzi, hogy így maradjon.
2. **Rövidíteni nem lehet.** A mezőhöz egyetlen út vezet, és annak az eredménye
   sosem rövidebb a mostaninál. A rövidítés nem tiltott, hanem
   megfogalmazhatatlan.
3. **Sem az óra, sem a szinkron nem viszi el** — a kézi zárlatot. Az óra-ugrás
   eltolja a végét (amennyi hátra volt, annyi van hátra), a fésülése pedig
   magasvízjel: a későbbi vég nyer, `rev`-re való tekintet nélkül. Az
   ABLAK-zárlat vége az ablak vége, az nem tolódik (az alvás nem
   hosszabbíthatja a hétköznapot) — az óra előreállítása ott őszinte korlát,
   lásd [`feature-lockdown.md`](feature-lockdown.md).

Amit NEM állítunk: hogy gépzár. Rendszergazdaként a segéd leállítható, a
telefonon az app letörölhető — a **törlés-védelem** (eszközadmin) elveszi ehhez
az egykoppintásos utat, de a rendszer beállításaiban ez is kikapcsolható. A
zárlat az appon BELÜL zár le mindent, tehát az impulzus ellen véd — és pontosan
ennyit mond a felület is. Részletek: [`feature-lockdown.md`](feature-lockdown.md),
[`feature-uninstall-guard.md`](feature-uninstall-guard.md).

A **zárlat-ablak** ugyanerre a rétegre épül, nem mellé: egy heti sáv, amiben a
kör az ablak végéig szóló zárlatot ír a mezőbe — ugyanaz a kapu, ugyanaz a
fésülés. Az ablak zárlatának vége az ablak vége (az alvás nem tolja el, mint
az ablak-menetnél), a lista pedig a szinkronon a saját jelével jár, hogy a
próbatétellel kifizetett levétel átmenjen, egy csomag-szerkesztés viszont ne
támassza fel. Részletek:
[`feature-lockdown-windows.md`](feature-lockdown-windows.md).

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
- **Windows:** named pipe. A SYSTEM által nyitott pipe alapértelmezett
  leírója a mindenki-csoportnak csak OLVASÁST ad — a nem emelt app így
  egyetlen kérést sem tudott küldeni. Ezt a CI Windows-próbája mutatta meg
  (`desktop/scripts/win-pipe-probe.ps1`: a valódi szerver SYSTEM-ként, egy
  friss sima fiók megszemélyesítve: „Access denied”); a v0.4.227 előtt a
  windowsos app nem érte el a segédet. Egyedi DACL natív kód nélkül nem
  tehető a pipe-ra — a Node csak a „mindenki írhatja”-t ismeri —, ezért a
  pipe mindenkinek írható, de **csak a kulcsot bemutató kapcsolat kap
  szót** (`shared/client-key.ts`). Telepítéskor az app 32 bájtos kulcsot
  ír a saját adatkönyvtárába (a felhasználó profilja: más felhasználó nem
  olvassa), a SHA-256 lenyomatát a segéd ütemezett feladatának
  parancssorába süti (`--client-key-sha256=`), mint macOS-en a tulajdonos
  uid-jét; minden kapcsolat első sora a `hello` a kulccsal. Kulcs nélkül
  egyetlen parancs sem fut, és a kapcsolat bomlik; hiányzó vagy rossz
  alakú lenyomatnál a pipe a régi, zárt leírójával jön létre — inkább ne
  érje el senki, mint bárki. A telepítő a futó régi példányt leállítja
  (`schtasks /End`), így az új kulcs azonnal él, újraindítás nélkül.
  Őszinte korlát: a named pipe a hálózaton (SMB) is megszólítható — a
  kulcs nélkül ott sem felel, de a kapu a kulcs, nem a hely.

### A böngésző-híd: kifelé olvas, befelé csak szigorít

A gép és a böngésző-bővítmény között egy helyi HTTP-híd él (`127.0.0.1`,
`desktop/src/main/rules-bridge.ts`), kóddal védve (`x-breaker-token`), CORS
nélkül — egy weboldal nem éri el, a bővítmény a `host_permissions` jogán igen.
Kifelé (`GET /rules`) a szabályok, a futó menet, a csatorna-szűrők, a zárva-lista,
a zárlat, az indokok, a megbízott, a kulcsszavak, a javasolt csomag és a
közelgő zárások (`soon`: a szünet vége, a menetrend szerinti zárás, a napi
keretből és az adagból hátralévő idő — a lap ebből szól előre az utolsó két
percben) mennek.
Befelé négy út van, és mind a lazítás irányában zárt: a megakadás-könyv
(`POST /hits` — könyvelés, bíró nélkül), a menet indítása a felugró lapról
(`POST /focus_start` — szigorítás; a segéd bírója dönt, ugyanúgy, mint az app
gombjánál: futó menet mellett nem indul, ismeretlen csomag nem indul), és a
heti ablak a csúcs-órára vagy a menet-órára (`POST /focus_window` — csak
FELVÉTEL, ablak nélküli csomagra; az órát a lap mondja, az app szava szerint; ablakos csomagra a híd nemet mond, mert a csere lazíthat, és arról
a bíró próbatételt kezdene — azt a híd nem indíthatja el), és az elöl lévő
oldal jele (`POST /tab` — `{focused, host}`; a mérés kap rajta szemet ott, ahol
a szonda vak: macOS-en a frissítés után visszavont engedély, Windowson a nem
látott címsor. A szonda saját látványát sosem írja felül, nem-böngészőt nem
nevez át oldalnak, és csak a friss, fókuszos jel számít — lásd
`shared/usage.ts` `withTabHint`. Jel nélkül az idő appként könyvelődne, és az
oldal kerete nem fogyna; egy hamis jel tehát legfeljebb ugyanott hagy, ahol a
jel nélküli állapot.)
Feloldó végpont nincs, és nem is lesz: aki a kódot ismeri, legfeljebb
szigoríthat.

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
- **Az app törlése** a leggyorsabb megkerülés: a védelemmel együtt tűnne el. A
  **törlés-védelem** ezt drágítja, környezetenként, de sehol sem gépzár (a cél
  a súrlódás, nem a lehetetlenné tétel — [`feature-uninstall-guard.md`](feature-uninstall-guard.md)):
  - **Android:** az app maga veszi el az egykoppintásos törlést (eszközadmin,
    üres házirenddel). A rendszer Beállításaiban (Biztonság → Eszközadmin-
    alkalmazások) próbatétel nélkül kikapcsolható — de már nem egy koppintás.
  - **iPhone:** appból nem lehet (az Apple nem enged rá jogot); a rendszer útja
    a Képernyőidő (App-törlések tiltása kóddal), amit az app a döntés helyén
    kimond.
  - **Gép (Windows/macOS):** az Electron-app törlése önmagában **nem old fel** —
    a blokkolást a rendszergazdai segéd tartja a hosts fájlban, amíg le nem
    szereled (admin + eltávolító szkript, [`desktop.md`](desktop.md)). Itt a
    súrlódás eleve a privilegizált segédben van.
- Egyedi/hardcode-olt DNS vagy DoH-proxy IP-cím megkerülheti a szűrőt (a hosts
  fájl és a sinkhole a névfeloldásra hat). Későbbi bővítés: IP-szintű szabályok.
- **A telefonon a böngésző saját biztonságos DNS-e.** A Chrome alapállása (a
  biztonságos DNS a jelenlegi szolgáltatóval) a rendszer DNS-ét — vagyis a
  szűrőt — használja: titkosítottra csak ismert szolgáltatónál vált, a Breaker
  virtuális DNS-e pedig nem az. Ha viszont a böngészőben külön szolgáltató van
  megadva, a névfeloldás titkosítva, a szűrő mellett megy, és a tiltás abban a
  böngészőben nem érvényesül. A gépen ezt a házirend kikapcsolja (lásd fent);
  a telefonon böngésző-házirendet csak eszközkezelés (MDM) adhatna.
  Kikényszeríteni nem tudjuk — a korlátok között kimondjuk, és a NYOMÁT
  jelezzük: a böngésző a kézzel megadott szolgáltató nevét induláskor a
  rendszer DNS-én (a szűrőn) át keresi meg. Ha a szűrő egy ismert DoH/DoT-
  kiszolgáló nevét látja átmenni (`DohHosts`: a Chromium szolgáltatólistája
  és a gyakori szolgáltatók, a profilonkénti NextDNS/Control D nevek
  végződés szerint), feljegyzi a nevet és az időt (ugyanazt tízpercenként
  egyszer; helyi mező, a szinkronra nem megy), és a főképernyő kártyája egy
  napig mondja. Az „Értem” csak azt a nevet némítja, egy másik visszahozza.
  Androidon szigorú Privát DNS mellett hallgat — azt az erősebb kártya már
  mondja. Tiltás nincs: egy elrontott DNS-beállítás az egész internetet
  vinné el, és a döntés a felhasználóé. Őszinte határ: csak a listán lévő
  neveket ismeri fel, nem látja, melyik app kérdezett, és egy beépített
  címmel induló app nem kérdez semmit — a csend nem bizonyíték.
  Ami megy: a Firefox szabványos „kanárija” (`use-application-dns.net`). Ha a
  rendszer DNS-e erre NXDOMAIN-t ad, az ALAPBÓL bekapcsolt DoH-t a Firefox
  kikapcsolja; a két telefonos szűrő (Android, iPhone) ezért erre mindig
  NXDOMAIN-t ad (`DohCanary`, a döntés előtt, megakadásként nem számolva). A
  kézzel bekapcsolt DoH-ra nem hat, a Chrome nem kérdezi; a gép hosts fájlja
  NXDOMAIN-t nem tud adni (ott a házirend dolgozik). Forrás: [Mozilla — Canary
  domain](https://support.mozilla.org/kb/canary-domain-use-application-dnsnet).
- **macOS-en a böngésző-DoH kikapcsolása nem zár, csak alapértelmezést állít.**
  A Chromium a `/Library/Preferences`-ben talált értéket csak akkor kezeli
  kötelező házirendként, ha az „forced” (MDM-profilból jön); enélkül ajánlásnak
  veszi, tehát a felhasználó a böngésző beállításaiban visszakapcsolhatja.
  Rendes zárás MDM/konfigurációs profilt igényelne. Ezért a felület csak annyit
  állít, hogy a házirendet alkalmaztuk — nem azt, hogy a DoH nem kapcsolható be.
- **A telepítő emelt része nem fájlból olvas** (v0.4.212 óta). Korábban a
  privilegizált telepítés egy shell-, illetve PowerShell-szkriptet és egy
  plistet írt a felhasználó temp könyvtárába, és azt futtatta emelt joggal; a
  SAJÁT felhasználóként már kódot futtató támadó a kiírás és az emelt futtatás
  közötti pillanatban kicserélhette a tartalmat — root/SYSTEM jogért. Most a
  teljes parancs az emelt folyamat parancssorában megy, az pedig indítás után
  nem írható át: macOS-en `do shell script "…" with administrator privileges`,
  a plist base64-ben a parancsban (a gyökér-héj maga írja a helyére);
  Windowson `powershell -EncodedCommand` (`src/shared/install-script.ts`, a
  tesztek a parancsból visszafejtik, amit írni akartunk, és a telepítő
  forrásában ideiglenes fájlt sem engednek). Ami marad, az a saját
  felhasználóként futó támadó általános ereje: az app helyett ő is kérhet
  rendszergazdai jóváhagyást — ez ellen a jelszókérő ablak szövege véd, nem a
  kód.
- **Más gyártó appját nem rontjuk el a szigor kedvéért.** A Firefox
  policies.json-t macOS-en az app bundle-jébe kellene tenni, ami érvényteleníti
  a Firefox aláírását, és a saját frissítőjét is elronthatja. Ezt nem tesszük:
  a gépszintű `org.mozilla.firefox` beállítás ugyanazt a házirendet adja, a
  bundle érintése nélkül. Windowson a telepítési mappa `distribution/`
  könyvtára a dokumentált hely, ott nincs ilyen mellékhatás.
- iOS-en MDM/„supervised” mód nélkül a felhasználó a rendszerbeállításokban ki
  tudja kapcsolni a VPN-t; az on-demand szabály csökkenti ennek kényelmét.
- **A FIÓK JELSZAVÁVAL hamis szinkron-rekord gyártható.** Az összefésülés a
  kifizetett lazítások számlálóiban bízik (mezőnként: törlés, menetrend,
  keret, adag; a csatorna-szűrőknél gazdagépenként): a több kifizetett lazítás
  mögött ott a munka, tehát a lazítás átmegy vele. A számláló helyben csak a
  próbatétel-kapun át nő — a bíró lépteti, a teljesítéskor —, de a kiszolgáló
  csak átlátszatlan blobot tárol, a titkosító kulcs pedig a JELSZÓBÓL
  származik. Aki tehát tudja a saját fiókjelszavát, a saját appján KÍVÜL is
  összerakhat egy nagy számlálójú, laza rekordot (menetrend nélkül, keret
  nélkül — a futó menethez egy hamis lezáró naplósorral), felnyomhatja, és a
  többi eszköz próbatétel nélkül átveszi. A végigment törlés sírköve sem ad
  ehhez újat: egy hamis sírkő egy hamis, lejárt törlés-kérés, és a fogadó
  eszköz a helyi rekordját a saját bírójával, a saját órája szerint hajtja
  végre. Ez a nem megbízható kiszolgáló modelljének ára: a kliens
  eszközön futó felhasználót nem lehet kizárni a saját adatából. Amit ez
  megváltoztat: a léc root/jailbreak alól a jelszó ismeretére csökken. Egy
  LEGITIM másik kliens ilyet nem tud: a rekord `rev`-je — amit az ingyenes
  szerkesztés is léptet — nem hitelesít lazítást; egyenlő számlálónál a
  szigorúbb alak jön ki, a futó menetet pedig nem a `rev`, hanem a rá hivatkozó
  naplósor zárja le — azt csak az írhatja, aki a menetet látta, és
  próbatétellel leállította vagy kivárta (docs/feature-focus-sessions.md). Aki ezt komolyan akarja zárni, annak a kiszolgálót kell
  megbízhatóvá tennie — az viszont egy másik termék.
- **Mobilon a próbatétel tartalma a mentett állapotban ül.** A memória-kód és
  a beírandó mondat a gépen a root/SYSTEM segéd állapotfájljában van, és a
  felület sosem kapja meg a várt választ (`toDisplay` kiszűri). A telefonokon
  a közös mag app-privát tárában van, a felület pedig a nyers lépést olvassa:
  root/jailbreak nélkül ez nem elérhető, de gyengébb elkülönítés, mint a gépen.
  A már dokumentált „root jogú felhasználó” osztályba esik, csak itt kimondva.
- **Óra-átállítás.** Mindhárom mag kiszűri: a várakozási határidők eltelt időt
  mérnek, nem dátumot (lásd `docs/challenge-spec.md`). A megoldás azon áll, hogy
  a karbantartó kör tudja, mikor futott utoljára — és ez a szám MINDHÁROM
  platformon a lemezen van, nem a memóriában. Ez sokáig nem volt igaz: a
  mobilokon memóriában élt, tehát az app kilövése (rendszerbeállítások →
  kényszerített leállítás) után az első kör csak ÚJ alapvonalat vett fel, és
  onnantól az óra előreállítása ingyen megrövidítette a várakozást meg a törlés
  24 órás türelmi idejét. A gépen ez sosem állt fenn (a segéd az állapotfájlba
  írja), most a telefonokon sem. A készülék kikapcsolt ideje továbbra sem
  számít bele a várakozásba — ez a szigorúbb irány.

  Ugyanez véd a FUTÓ MUNKAMENETRE is: az ugrást elnyeljük, tehát amennyi hátra
  volt, annyi van hátra. Ez korábban rés volt — az óra előreállítása „lejárttá”
  tette a menetet, és a lejárás a szinkronon át a többi eszközre is átvitte a
  leállást, próbatétel nélkül. Az elnyelés MÁR A SZINKRON-SZÁMLÁLÓT SEM lépteti:
  a lenyomat a futás hosszát nézi, nem az abszolút időpontjait, tehát egy alvó
  eszköz „még fut” állapota nem győzi le a másik eszközön próbatétellel
  megszerzett lezárást. A részletek és a megmaradt vakfolt:
  `docs/feature-focus-sessions.md`.

  És a HŰTÉSRE (adag-szünet) is, a gépen és Androidon: a most tartó hűtés vége
  ugyanígy tolódik (`shiftCooldowns`) — a hűtés időtartam, nem nap. A
  számlálót viszont nem toljuk: a lecsukott gép ideje pihenő, nem adag.

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
helyett, és a valódi cím egy gombbal, **hat másodpercre** hívható elő — a
készülék azonosítása után (ujjlenyomat, arc vagy kód; lásd lentebb, a rejtett
lista zárjánál): ugyanaz a kíváncsi szem, ugyanaz a zár.

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

A valódi cím **előhívása** viszont a készülék azonosítását kéri — nem próbatételt,
hanem a saját ujjadat, arcodat vagy kódodat. Ez nem a védelem gyengülése ellen
véd (az nem gyengül), hanem a kíváncsi szem ellen: aki a kezébe veszi a
telefont, ne egy gombbal lássa, mi bújik a fedőnév mögött. Ahol nincs mivel
azonosítani, a cím kérésre előjön, és a felület kimondja. Ugyanez a kapu áll a
fedőnév **levétele** előtt is: az is felfed — onnantól a valódi cím áll a
listán —, az átnevezés viszont nem, az marad egy koppintás. Elutasításnál a
név marad, és a felület ezt is kimondja. Hogy melyik változás levétel, azt a mag
mondja meg egy helyen (`isAliasRemoval` / `isRemoval`), tesztekkel — a három
felület nem hord három szabályt.

## A lista elrejtése

A fedőnév oldalanként dolgozik. Van, akinek ennél több kell: **ne is látszódjon,
mi van blokkolva** — se induláskor, se a statisztikában. Erre való a
`hideSiteList` beállítás.

Két külön dolog, és pont ez a lényege:

- **`hideSiteList`** — tárolt beállítás a segédben: „rejtve induljon”.
- **`listOpenThisSession`** — a felület modulszintű változója, ami minden
  indításkor `false`. A „Lista megnyitása” ezt állítja át — sikeres azonosítás után.

Így a lista minden induláskor csukva van. A megnyitás viszont **nem egy
kattintás**: a készülék azonosítását kéri — ujjlenyomat, arc vagy a képernyőzár
kódja (Androidon BiometricPrompt, iPhone-on LocalAuthentication, Macen Touch ID).
Eddig a rejtés csak nem emlékeztetett; ettől **véd is**: aki a kezébe veszi a
telefont, nem koppint rá egy gombra, hogy lássa, mi ellen küzdesz. Próbatétel
nem kell — a munka itt a saját ujjad vagy kódod. Az azonosítás a rendszeré: az
app se ujjlenyomatot, se kódot nem lát, csak egy igen/nem választ.

Őszinte korlát: ahol nincs mivel azonosítani (nincs képernyőzár; Windows-gép
vagy olvasó nélküli Mac), a lista kérésre megnyílik, és a kártya **kimondja**,
hogy itt nem kért semmit — néma kapu helyett. Elutasított azonosításnál a lista
rejtve marad, és ezt is kimondja. A megnyitás így is csak erre a munkamenetre
szól: a beállítás marad „rejtve”. Részletek: [`feature-hidden-list.md`](feature-hidden-list.md).

A rejtés az **egész ablakra** szól, nem csak a listakártyára:

| Hol | Rejtve mi látszik |
|---|---|
| a lista | „3 oldal van blokkolva” vagy „3 oldal van a listán, ebből 1 most szabad” — a darabszám marad, a nevek nem |
| gyorsgombok a felvevő kártyán | nincsenek (pont a tipikus címek állnak rajtuk) |
| a beviteli mező példája és a társoldal-jelölő | általános szöveg, cím nélkül |
| statisztika | `1. rejtett oldal`, `2. rejtett oldal` — a „blokkolt” jelölés és az idő marad |
| fejléc-jelvény | „Védelem aktív — 3 oldal blokkolva” vagy „… 2 oldal blokkolva, 1 most szabad” (csak számok; az számít, ami MOST zár — a szünetelő vagy menetrend szerint nyitott oldal nem) |

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

A `hideSiteList` a **fiók egészére** szól: a `focus` szinkron-dokumentumban
utazik a jelével (`hideSiteListRev`), a zárlat-ablakok és a megbízott
mintájára — a jel dönt, azonos jelnél a rejtett, a régi kliens semleges. A
`listOpenThisSession` viszont nem utazik: a megnyitás eszközönkénti és
munkamenetnyi. Lásd [`feature-hidden-list.md`](feature-hidden-list.md).

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

### Az el nem induló kiadás

Az automatikus frissítés a legnagyobb kockázatot is szétteríti: egy el sem
induló asztali build nem egy gépen hibás, hanem mindegyiken, és az el nem
induló app a következő javítást már nem tudja letölteni. A magot a tesztek, a
felületet a renderer-füstteszt nézi — de azt, hogy a fő folyamat, a preload és
a felület EGYÜTT feláll-e, sokáig semmi.

Ezt az indítási füstpróba (`--smoke-test`, `desktop/src/main/smoke.ts`) fogja
ki: a rendes indulás fut végig, a bejelentkezéskori indítás és a
frissítés-keresés nélkül; zöld, ha a felület az indító kódja végén a hídon át
elkérte és kiírta az app verzióját. A várt szöveg és a kiírt szöveg egy
függvényből jön (`shared/smoke.ts`), hogy egy szövegcsere ne adjon hamis
pirosat. A próba a fő folyamat **első** importja: így egy betöltéskor elhasaló
modul sem nyit párbeszédablakot, amit a CI-ban senki nem kattintana el. A
CI a becsomagolt appon is futtatja (Mac, Windows), a kiadás pedig a feltöltés
előtt — piros próbánál a kiadás draft marad (lásd `docs/releasing.md`).

Ugyanebbe a családba tartozik a rendszerkövetelmény: egy Electron-frissítés
feljebb emelheti a legrégebbi macOS-t, és a frissítő akkor egy olyan gépre is
felrakná az új verziót, ahol az el sem indul. A követelmény ezért a Mac-csomag
nevében utazik (`-darwinNN.zip`), a frissítő a gép rendszerverziójával veti
össze, és régebbi gépen nem tölt le semmit — a fiók-panel kimondja, mi a helyzet
(`shared/update-manifest.ts`, `pickMacUpdate`). A régi frissítők a nevet nem
ismerik fel, tehát ők sem raknak fel semmit (lásd `docs/releasing.md`).

### A meg nem jelent értesítés

Az asztali app sok mindent értesítésben mond el — a szünet végét, a betelő
keretet, a közelgő heti ablakot, a hétfői visszatekintést. Ha a rendszer egy
értesítést visszautasít (macOS-en az Electron 42-től a UNNotification, ha
nincs engedély, vagy az app aláírása nem felel meg neki), az eddig
nyomtalanul elmaradt. Most minden értesítés egy úton megy (`notify` a
rendererben), és ha a rendszer `error` eseményt ad, a beállítások lapja
kimondja, csendben, a bekapcsolás helyével együtt (`shared/notify-delivery.ts`);
a következő átvett értesítés visszavonja. Egy teszt őrzi, hogy a rendererben
más út ne is legyen. Macen a csomag füstpróbája azt is nézi, hogy az ad-hoc
aláírás azonosítója a csomagé (`hu.breaker.app`), és az Info.plist az aláírás
része — enélkül az értesítések némán vesznének el. Windowson ugyanez az
azonosító az AppUserModelID: a telepítő parancsikonja ezt viseli, és a futó app
is ezt mondja (`app.setAppUserModelId`, az első ablak előtt; `shared/app-id.ts`,
teszt köti az `electron-builder.yml`-hez). Az Electron magától
„electron.app.Breaker”-t mondana, és akkor a Windows az értesítést nem kötné a
telepített apphoz: se a nevét, se az ikonját nem kapná, a Gépház értesítési
listáján sem „Breaker” néven állna, és a tálcán a futó app külön ikont kapna a
kitűzött mellett. A váltás (v0.4.243) egy őszinte réssel jár: aki a régi,
„electron.app.Breaker” soron állított valamit a Gépházban, annak az nem
öröklődik — az új „Breaker” sor alapállapotból indul; a kiadási jegyzet ezt
kimondta.

Amit az app NEM lát: hogy egy átvett értesítés tényleg látszott-e. A `show`
esemény csak annyi, hogy a rendszer átvette — kikapcsolt értesítésnél és
fókusz-módban is jöhet. A mostani Electron (31) macOS-en a régi
NSUserNotificationCenteren küld, és annak nincs hibaútja: ott az `error` sosem
jön; Windowson a kikapcsolt értesítést a rendszer nem feltétlenül jelzi vissza.
Ezért van a beállítások lapján az „Értesítés kipróbálása” gomb, és ezért
mondja átvételkor azt, hogy „a rendszer átvette”, nem azt, hogy „megjelent”
(`notifyTestText`; teszt őrzi, hogy egyik kimenetele se állítson többet).

A telefon többet tud: a rendszer előre megmondja, ki vannak-e kapcsolva az app
értesítései (Android: `NotificationAccess.enabled`, Android 13-tól az engedély
elutasítása is ez; iPhone: `authorizationStatus == .denied`). Ilyenkor a
beállítás-kártyák között egy kártya kimondja, mi marad el — Androidon a szünet
vége, a betelő keret, a közelgő heti ablak és a védelem tartós értesítése;
iPhone-on a szünet vége, a közelgő heti ablak és a hétfői emlékeztető, hogy kész
a hét mondata —, és egy gomb a rendszer kapcsolójához visz. Androidon csak amíg a védelem fut (az engedélyt az
indítása kéri; előtte a „még nem kérdezett” is kikapcsoltnak látszana), iPhone-on
csak az elutasítás számít. Az egyes csatornák némítása (például csak a heti
visszatekintésé) szándékos, finomabb döntés: az nem kártya. A kártya magától
jön és megy, ahogy a beállítás változik; nem ugrik fel, nem nógat.
