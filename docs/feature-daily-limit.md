# Funkcióterv: napi időkeret oldalanként

Státusz: **kész asztali gépen és Androidon; iPhone-on részben** (mérni ott nem
lehet, de a keret a többi eszköz méréséből ott is zár). A keret **eszközök
között közös**. A dokumentum alja mondja meg, pontosan mi hol tart. Ami alatta
áll, az a terv — azért marad itt, mert a döntések indoklása később is kell.

## Mit old meg

A blokkolás ma bináris: egy oldal vagy tiltva van, vagy nincs. A mérés viszont
már tudja, mennyi aktív idő megy el rá (lásd
[`feature-usage-stats.md`](feature-usage-stats.md)). A kettő összekötése a
leggyakoribb valós igény: *„nem akarom teljesen kizárni a YouTube-ot, de napi
20 percnél többet ne menjen rá”*.

Az időkeret **magától zár**: ha ma már elfogyott, az oldal a nap hátralévő
részére tiltottá válik, éjfélkor pedig magától újraindul a keret.

## Miért illik pontosan ebbe a rendszerbe

A blokkolási döntés ma három bemenetből áll (`isBlockedNow`): aktív szünet,
folyamatban lévő törlés, heti menetrend. Az időkeret egy **negyedik bemenet**,
ugyanazzal a fail-closed logikával:

```
blokkolt-e most?
  ha aktív szünet van .................. NEM (a szünet mindig nyer)
  ha törlés van folyamatban ............ IGEN
  ha a mai keret elfogyott ............. IGEN      ← új
  egyébként a menetrend dönt
```

A keret **szigorítás**, tehát a bevezetése és csökkentése ingyenes; a **emelése
vagy törlése lazítás**, ezért ugyanazokba a próbatételekbe kerül, mint egy
feloldás — pontosan úgy, ahogy a menetrend lazítása
([`feature-schedules.md`](feature-schedules.md)). Ez a szabály már megvan, csak
alkalmazni kell rá.

## A keret percre pontos

A felület felkínál néhány szokásos keretet (10 / 20 / 30 / 45 / 60 / 90 / 120
perc), de a szám **szabadon átírható**: 1 perctől egy napig bármi megadható.
Aki napi 35 percet szán valamire, annak a 30 kevés, a 45 sok — és ha csak a
gomblistából lehet választani, a keret nem az ő döntése, hanem a gomblistáé.

A „nincs keret” külön választás marad, nem a mező kiürítése: a nulla és a
„nincs” két különböző dolog, és egy üres mező nem mondja meg, melyikre
gondoltál.

## Adatmodell

A `Site` rekord kap egy opcionális mezőt (mindhárom platformon, visszafelé
kompatibilis JSON-nal):

```ts
/** napi aktív-idő keret másodpercben; hiánya = nincs keret */
dailyLimitSeconds?: number;
```

A felhasználást nem kell külön tárolni: a mai elhasznált idő a mérés napi
vödréből jön (`totalsForDays(usage, [dayKey(now)])[siteKey(domain)]`).

## Döntési logika (tiszta függvény, mindhárom magban tükrözve)

```
limitExhausted(site, usage, now):
    ha site.dailyLimitSeconds == null -> hamis
    használt = a mai vödör értéke a "site:<domain>" kulcsra (0, ha nincs)
    vissza: használt >= site.dailyLimitSeconds
```

Két dolog, ami első ránézésre nem nyilvánvaló:

1. **A mérés lehet kikapcsolva.** Ilyenkor nincs adat, tehát a keret nem tudna
   fogyni — ez csendes megkerülés lenne. Ha van bármelyik oldalon keret, a
   mérést nem lehet kikapcsolni; a felület ezt írja is ki. (A kikapcsolás
   egyébként ingyenes marad, mert az a saját adat — de itt már blokkolási
   következménye van.)
2. **A desktop mérő a GUI-ban fut**, tehát a keret csak akkor fogy, amíg a Breaker
   fut. Ez őszintén kiírandó a felületen; a helper enélkül nem tud a fogyásról.
   (Alternatíva később: a helper is számolhatna, ha kap egy „még mindig aktív”
   jelzést.)

## Felület

- Az oldal sorában egy „Napi keret…” gomb, sávdiagrammal: *elfogyott 12 / 20 p*.
- Elfogyott keretnél a sor jelölése: „Ma elfogyott a keret — holnap újraindul”.
- A keret emelésénél ugyanaz a próbatétel-ablak nyílik, mint a menetrend
  lazításánál, és a felület elmondja, miért.

## Tesztek

Mindegyik megvan, mindkét magban (`desktop/test/limits.test.ts`,
`android/jvm-tests/src/test/kotlin/LimitsTest.kt`):

- A keret elfogyása blokkol, akkor is, ha a menetrend szerint szabad lenne.
- Éjfél után újraindul (a napi vödör vált), és más oldal ideje nem számít bele.
- A keret csökkentése azonnal érvényes, az emelése próbatételhez kötött —
  és az emelés csak a próbasorozat végén lép életbe, feladáskor sosem.
- A keret nem kerülhető meg a mérés kikapcsolásával.
- Az elfogyott keret tényleg bekerül a blokklistába (hosts fájl, illetve
  `blockedHostnamesNow`), nem csak a felületen látszik.
- A meglévő véletlenszerű interakció-teszt invariánsai a kerettel is állnak.

## Mi valósult meg, hol

| Rész | Asztali (TS) | Android (Kotlin) | iOS (Swift) |
|---|---|---|---|
| Keret-logika | `shared/limits.ts` | `core/Limits.kt` | `Shared/Limits.swift` |
| Tárolás | `helper/state.ts` | `core/Store.kt` | `Shared/Store.swift` |
| Bíró (irány-szabály) | `helper/referee.ts` | `core/Referee.kt` | — |
| Blokkolási döntés | `helper/hosts.ts` | `BreakerStore.blockedHostnamesNow` | `BreakerStore.blockedHostnamesNow` |
| Mérés-kapcsoló zárolása | `helper/server.ts` (`usage_enable`) | `Referee.setUsageEnabled` | — (nincs mérés) |
| Mai összegzés feltöltése | `helper/sync-client.ts` (`syncToday`) | `SyncClient.syncToday` | — (nincs mit mérni) |
| Mai összegzés letöltése | `helper/sync-client.ts` | `SyncClient.syncToday` | `SyncClient.pullSharedToday` |
| Felület | `renderer.ts` (keret-mérő + párbeszéd) | `ui/AppUi.kt` (`LimitMeter`, `LimitDialog`) | `ContentView.limitLine` |

### Mi hiányzik iPhone-on, és miért

**Mérni nem tudunk.** A keret mért aktív időből fogy, az Apple viszont nem enged
appnak hozzáférést ahhoz, hogy más appokban vagy weboldalakon mennyi idő telik.
Az egyetlen ilyen API a `DeviceActivity` / `FamilyControls`, ami külön, Apple
által egyenként engedélyezett entitlementhez kötött (szülői felügyeletre
szánták). A csomagalagút lát DNS-kérdéseket, de abból „aktív időt” számolni
becslés lenne, és pont az ígéret sérülne: csak az számítson, amíg tényleg az
adott dolog előtt ülünk.

**A keret viszont ÉRVÉNYESÜL.** Amióta a keret eszközök között közös, az iPhone
lehozza, mennyit mért ma a gép és az androidos telefon, és azt beszámítja. Ha a
napi húsz perc a gépen elfogyott, az oldal az iPhone-on is zárva van.

Eddig a `dailyLimitSeconds` iPhone-on puszta hordozó volt: átment a szinkronon,
és soha semmi nem nézte meg. Vagyis aki a gépen keretet állított be, az a
telefonján korlátlanul használhatta ugyanazt az oldalt — és semmi nem jelezte,
hogy a beállítása ott nem jelent semmit. Pont az a fajta csendes hiba, ami
rosszabb a hiányzó funkciónál: úgy néz ki, mintha védene.

Ami továbbra sem megy iPhone-on: a keret **beállítása** (a bíró és a felület
hiányzik, mert a mérés nélkül a helyi szám úgyis nulla lenne), és a saját idő
beszámítása. Ha megjön az entitlement, ez a két sor is átvehető.

## Az óra átállítása ITT nem zárható be — és ezt kimondjuk

A munkamenetnél az órabállítás kiskapuját be lehetett zárni: a menet vége
IDŐPONT, tehát az ugrást el lehet nyelni, és a szabály egy mondatban igaz
mindkét olvasatra — „amennyi hátra volt, annyi van hátra” ugyanaz a válasz az
átállított órára és az alvó gépre is.

A napi keretnél ez NEM megy, és a különbség nem lustaság:

- a keret egy NAPHOZ tartozik, nem egy időtartamhoz. Ha az óra előreugrik egy
  nappal, az eszköz új napot lát, és a keret nulláról indul;
- az alvó gép ugyanígy néz ki. Aki este lecsukja a laptopot és reggel nyitja
  ki, annak a napváltás VALÓDI — és ott a helyes viselkedés pont az, hogy a
  keret újraindul;
- a két esetet a segéd nem tudja megkülönböztetni, és itt a „biztonságos
  irány” a gyakori esetben ROSSZ. A munkamenetnél nem így volt: ott a
  szigorúbb választás mindkét olvasatban helyes maradt.

Egy második vélemény elvben létezne: a többi eszköz is megmondja, milyen napot
lát (`TodayDigest.day`). Csakhogy a kiszolgáló nem küld IDŐBÉLYEGET a
sorokhoz — csak egy verziószámot —, tehát egy három napja kikapcsolt gép sora
pontosan úgy néz ki, mint egy jó órájú gépé egy rossz órájú mellett. Egy
riasztás, ami minden hosszabb szünet után téveszt, rosszabb a semminél: a
felhasználó megtanulja figyelmen kívül hagyni, és akkor majd az igazit is.

Ami tehát IGAZ:

- a napi keret feltételezi, hogy a gép órája nagyjából jó. Aki egy napot előre
  állítja, friss keretet kap azon az eszközön;
- ez viszont az egész rendszert érinti (naptár, üzenetek, minden), tehát nem
  „két perc munka”, mint a munkamenetnél volt — inkább a VPN-kapcsolóhoz
  hasonló, kimondott kiút;
- az oldal TELJES tiltása és a menetrend nem függ ettől: a hosts-blokk óra
  nélkül is áll.

Ha a kiszolgáló egyszer időbélyeget is ad az eszközsorokhoz, a második vélemény
megbízhatóvá válik, és akkor érdemes megírni. Addig ez a szakasz a válasz.

## A keret eszközök között közös

Ez volt a funkció legnagyobb lyuka: a keret eszközönként külön ketyegett.
„Napi 20 perc YouTube” a gépen húsz percet jelentett, a telefonon még húszat —
két eszközzel negyven, hárommal hatvan. Aki a keretet komolyan gondolja, annak
ez nem keret volt, hanem javaslat.

Most minden mérő eszköz feltölti a **mai összegzését**: egyetlen nap, célonként
egy szám, titkosítva, pár száz bájt. Minden eszköz lehozza a többiét, és
hozzáadja a sajátjához.

```
gép:     ma 12 perc YouTube          ─┐
telefon: ma 10 perc YouTube          ─┴─►  22 perc  >  20 perc keret  →  zár
```

**Miért nem kell megbíznunk a másik eszközben.** A távoli számok csak
HOZZÁADNAK. Bármit is küld a másik eszköz, attól a keret csak hamarabb fogy el,
sosem később — a szigorítás pedig ebben a rendszerben mindig ingyen van. Ha a
szinkron áll, marad a helyi mérés: az app olyan, mint korábban, nem lazább.

Három dolog, ami nélkül ez csendben rosszul működne:

- **A saját sorunk nem számíthat kétszer.** A kiszolgáló a mi összegzésünket is
  visszaadja. Ha bekerülne, minden percünk duplán számítana, és a húszperces
  keret tíz perc után fogyna el — a felhasználó pedig joggal gondolná, hogy az
  app hibás.
- **A másik eszköz tegnapja nem a mi mánk.** Minden összegzés a SAJÁT naptári
  napját hozza. Más időzónában lévő eszköz tegnapi órái enélkül ma azonnal
  elégetnék a keretet.
- **Az eszközazonosító a kiszolgálótól jön**, nem a titkosított tartalom
  belsejéből. Különben egy eszköz a másik nevében beszélhetne — például a
  miénkében, amivel az első pontot kerülné meg.

**Frissesség.** A mai összegzés külön, kétperces körben megy, nem a tízperces
teljes szinkronban: ettől BLOKKOLÁSI DÖNTÉS függ, a teljes mérés pedig csak
statisztika. Így a keret legfeljebb pár perccel csúszhat el — nem tízzel.

Két apróság, ami a tervben még nem volt kimondva, de a megvalósításnál kellett:

- **A szünet erősebb a keretnél.** Az aktív szünetet próbatételekkel fizette ki
  a felhasználó; ha egy elfogyott keret csendben felülírná, az a fizetséget
  tenné értéktelenné. Ezért a döntési sorrend legelején áll.
- **A keret levételét a bíró `-1`-gyel jelöli** a függőben lévő változásban
  (Androidon `pendingLimit = -1`), mert a „nincs keret” és a „0 másodperces
  keret” két különböző dolog, és a tárolt `null` nem tudná megkülönböztetni
  őket a „nem változik” esettől.
