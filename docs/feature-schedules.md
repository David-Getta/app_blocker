# Funkcióterv: időzített blokkolási sávok

> Állapot: tervezés + első implementáció. A közös mag (TypeScript) a referencia,
> a Kotlin/Swift tükör követi.

## Mit old meg

Eddig egy oldal vagy blokkolva van, vagy (feloldás után) egy ideig nem. Sokaknak
viszont **idő-alapú** szabály kell: „munkaidőben (H–P 9–17) legyen tiltva a
YouTube”, vagy „este 22 után minden közösségi oldal”. Ez a funkció ezt adja hozzá
úgy, hogy **a súrlódás-filozófia sértetlen marad**.

## Fogalom

Minden oldalhoz tartozhat egy **heti menetrend** (schedule): sávok halmaza, ahol
egy sáv = `{ napok, kezdés, vég }`. A menetrend háromféle módban működhet:

- **`always`** (alap): mindig blokkolva (a jelenlegi viselkedés).
- **`scheduled_block`**: csak a megadott sávokban blokkolva, azon kívül szabad.
- **`scheduled_allow`**: fordítva — a sávokban szabad („engedélyezett ablak”),
  azon kívül blokkolva.

A tényleges „blokkolt-e most” döntést egy tiszta függvény adja:
`isBlockedNow(site, now)`, ami a meglévő `pauseUntil` / `pendingDeleteAt`
logikával kombinálódik (a szünet mindig felülír, a menetrend csak akkor számít,
ha nincs aktív szünet).

## A súrlódás megőrzése (kulcskérdés)

Menetrendet **hozzáadni/szigorítani** olcsó (egy művelet), mint az oldal
felvétele. **Lazítani** viszont — kevesebb blokkolt sáv, `scheduled_allow`
szélesítése, vagy menetrend törlése — ugyanaz a **próbatétel-sorozat**, mint egy
feloldás, mert az is a védelem gyengítése. A bíró (`referee`) dönti el, melyik
irány „szigorítás” és melyik „lazítás”:

- Új sáv, ami **növeli** a blokkolt időt → azonnal életbe lép.
- Bármi, ami **csökkenti** a blokkolt időt → próbatételhez kötött (a `pause`
  típusú sorozat, az aktuális tierrel).

Így nem lehet a menetrenddel megkerülni a súrlódást („átállítom allow-ra és kész”).

## Adatmodell (kiegészítés)

```ts
type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0 = vasárnap

interface Band {
  days: Weekday[];      // mely napokon
  startMin: number;     // 0..1439, helyi idő perc
  endMin: number;       // 0..1440; ha < startMin, átnyúlik éjfélen
}

interface Schedule {
  mode: 'always' | 'scheduled_block' | 'scheduled_allow';
  bands: Band[];        // always módban üres
}
```

A `SiteRec` kap egy `schedule?: Schedule` mezőt (hiánya = `always`, visszafelé
kompatibilis).

## Döntési logika

```
isBlockedBySchedule(schedule, now):
  ha mode == always            -> true
  inBand = bands bármelyike lefedi now-t (helyi idő, éjfélátnyúlással)
  ha mode == scheduled_block   -> inBand
  ha mode == scheduled_allow   -> not inBand

isBlockedNow(site, now):
  ha pauseUntil > now          -> false      // aktív feloldás mindig nyer
  ha pendingDeleteAt != null   -> true        // törlésig blokkol
  egyébként                    -> isBlockedBySchedule(site.schedule ?? always, now)
```

A hosts-motor / DNS-sinkhole `activeHostnames` / `blockedHostnamesNow` ezt a
`isBlockedNow`-t hívja a puszta `pauseUntil` helyett. A helper `tick`-je 15 mp-
enként újraértékel, így a sávhatárokon magától vált — feloldási esemény nélkül is.

## „Lazítás” detektálása

Egy menetrend-váltás akkor lazítás (és így próbatételhez kötött), ha van olyan
jövőbeli időpont a következő 7 napban, amikor az **új** szabály szerint szabad,
de a **régi** szerint blokkolt lett volna. Ezt egy 15 perces felbontású,
egyhetes szimulációval ellenőrizzük (`isLoosening(old, new, now)`), ami olcsó és
determinisztikus. Ha lazítás → `referee.startSession('pause', …)` a szokásos
próbákkal, és a váltás csak a sorozat teljesítése után íródik be.

## UI (kész)

Mindhárom platformon van „Menetrend…” gomb az oldalsoron, ami egy szerkesztőt
nyit: mód-választó (mindig tiltva / sávokban tiltva / sávokban szabad), a sávok
listája pipával, és egy saját sáv. A listában elöl a mostani sávok állnak — a
saját sávok is, a felületen ugyanúgy leírva, mint a heti ablakok („H, Sze
18:30–20:30”) —, utánuk a még fel nem vett sablonok („Munkaidő H–P 9–17”,
„Esti lekapcsolás 22–06”, „Hétvége”). A saját sáv: napok, kezdés, vég —
ugyanazok a mezők, mint a heti ablaknál; nap nélkül nem számít, a „00:00” vég
az éjfél. Lazításnál a próbatétel-folyamat indul.

A szerkesztő eddig csak a sablonokat ismerte: egy nem sablon sávot (egy másik
eszközről, a szinkronon át) az „Alkalmaz” csendben eldobott — „sávokban
szabad” módban ráadásul ingyen, mert a kevesebb szabad idő szigorítás. Most
a mostani sávok pipával állnak ott, és csak az esik ki, amiről a pipát
leveszed. A `check-enforcement.js` mindhárom szerkesztőben őrzi. Az oldalsor a menetrend szerinti aktuális állapotot
is mutatja („most blokkolva” / „most szabad”).

- Desktop: renderer modal (screenshot: `docs/images/desktop-schedule.png`),
  end-to-end tesztelve.
- Android: Compose `ScheduleDialog` (AppUi.kt). A kezdés és a vég
  szövegmező, számbillentyűzettel — azon a kettőspont sokszor nincs, ezért a
  „8:30” mellett a „8.30”, a „8,30”, az egész óra („8”) és a csupa számjegy
  („830”) is megy. Az olvasás a magé (`ScheduleLogic.parseClock`,
  `customBand`), tesztekkel; a zárlat-ablak szerkesztője ugyanezt használja.
- iOS/macOS: SwiftUI `ScheduleEditor` (App/ScheduleEditor.swift).

Szabadon szerkeszthető heti rács (napok × órák) nincs: a sávok listája és a
saját sáv ugyanazt kifejezi, és a heti ablak szerkesztőjével egy a nyelvük.

## A következő váltás kiszámolható tény

A `nextOpenAt(schedule, now)` (shared/schedule.ts) megmondja, mikor enged
legközelebb a menetrend, a tükre, a `nextCloseAt` pedig azt, mikor zár — mind
a kettő percre lépkedve MAGÁT a tiltás-döntést kérdezi, nem másolja a
sáv-számtant, így óraátállásnál sem mondhat mást, mint amit a tiltás tesz. A
sosem nyíló (és a sosem záró) menetrendre nullát adnak. Ebből számol vissza a
bővítmény tiltó lapja („Nyit: még kb. 2 óra”), és ebből mondja a sor mindhárom
felületen, mikor vált: a gépen a korong („Most szabad (menetrend szerint) —
zár 1 ó 30 p múlva”, „… — nyit 45 perc múlva”), a telefonon a menetrend-chip
alatti sor („A menetrend szerint zár 1 ó 30 p múlva.”). Tény, nem
figyelmeztetés: a szabad sáv vége ne a zárásnál derüljön ki.

A Kotlin és a Swift mag is kapott tükröt (`ScheduleLogic.nextOpenAt` /
`nextCloseAt`), ugyanazzal a döntéssel, egyetlen naptárral végiglépkedve. A
felület percenként egyszer számol menetrendenként — a lista másodpercenként
rajzolódik, a keresés pedig egy hét percein lépkedhet. A böngészőben a lap is
szól: a menetrend szerinti zárás előtti két percben egy sáv a tetején (az app a
hídon adja le a zárás idejét, `soon`). A telefonon a chip is
pontosabb lett: ha az oldalt nem a menetrend zárja (hanem a betelt keret vagy
az adag-szünet), nem mondja, hogy „(menetrend)” — az ok a saját sorában szól.

## Tesztek

- `isBlockedBySchedule`: sávon belül/kívül, éjfélátnyúlás, több nap, allow vs
  block mód.
- `isLoosening`: szigorítás=false, lazítás=true, always→block=szigorítás,
  block→allow általában lazítás, azonos menetrend=false.
- `nextOpenAt`: percre pontos nyitás, éjfélátnyúlás, több napnyi várakozás,
  a sosem nyíló nulla; `nextCloseAt` ugyanígy (a másodperc nem számít, a
  sosem záró nulla), mindkettőre fuzz: amit mond, az tényleg váltás, és nem
  késik.
- Integráció: menetrenddel a `activeHostnames` a sávhatáron vált.

## A három mag ugyanazt dönti

A menetrend az, ami a gépen és a telefonon EGYSZERRE dönt ugyanarról az
oldalról: egy elcsúszott sáv-számtan az oldalt az egyiken zárja, a másikon
nyitja, ugyanabban a percben. Ezért a `fixtures/merge-cases.json` menetrend-
szekciója (írja `desktop/test/merge-fixture.test.ts`) kézzel válogatott éleket
és véletlen heti sávrendszereket tart — mindhárom mód, éjfélen átnyúló és
érvénytelen sávok, a sávhatár perce másodpercekkel —, és azt, hogy a gép
szerint tilt-e most, lazítás-e a csere egy másik menetrendre, és mikor nyit,
illetve zár legközelebb (`nextOpen`/`nextClose`); a Kotlin
(`MergeFixtureTest`) és a Swift (`MergeFixtureTests`) ugyanezt játssza vissza.
A sávok helyi időben értékelődnek ki, ezért a három teszt UTC-ben jár — a gép
és az Android beállítja, a Swift beállítja, vagy ha nem tudja, kimondva
kihagyja. Az óraátállást külön fixtúra nézi (`fixtures/dst-cases.json`,
Europe/Budapest, a 2026-os tavaszi és őszi éjszaka): a menetrend döntése és
a következő váltás mindhárom magban ugyanaz. Ez talált is egy hibát: a gép
a következő váltást helyi időben percre vágva kereste, és az őszi kétszer
előforduló órában így egy órával korábbról indult — a „következő” váltás a
múltban lett volna. Most abszolút időben vág, mint a két telefon.

### A menetrend a dróton

A menetrend az oldal-rekorddal a fiókon utazik, és minden olvasó kívülről
jött adatnak veszi. A szabály mindhárom magban ugyanaz (a gép `scheduleIn`-je,
az Android `scheduleFromJson`-ja, a Swift tűrő `Schedule`-dekódolása): ami nem
objektum, az nincs (mint a hiányzó: mindig tiltva); a nem szöveg vagy
ismeretlen mód „mindig”; a sávok közül a rosszul formált (nem objektum, a nap
nem egész számok tömbje, a perc nem egész) kiesik, a többi marad; a tartalmi
szűrés (napok 0–6, percek a napon belül, üresen „mindig”) a döntésé. Eddig a
gép nyersen tartotta a menetrendet, és egy `bands: "x"` vagy egy `null` sáv a
döntést és a fésülést is ledöntötte (kivételt dobott); a két telefon egy ilyen
sáv miatt az egész oldalt eldobta, az Android a „540” szöveget percnek vette.
A `fixtures/wire-cases.json` oldal-esetei kimondják — a kulcs a menetrend
HATÁSA (normalizálva), nem a nyers alakja.

### Két eszköz menetrendje

A lazítás a saját számlálójával megy át (`scheduleLoosens`: a bíró lépteti a
próbatétel teljesítésekor) — az a menetrend nyer, amiért többször fizettek. Ha
a számláló egyenlő (két eszköz egyszerre szerkesztett, vagy az egyik csak
ingyen szigorított), a két menetrend UNIÓJA jön ki: minden perc tiltva, amit
bármelyik tilt, a heti rács szerint, időzónától függetlenül. Eddig a kettő
közül a többet tiltó maradt egészében, és a másik eszköz külön sávja
(mondjuk egy esti tiltás a munkaidő mellé) elveszett. Ha az egyik lefedi a
másikat, az marad változatlanul; ha ugyanazt tiltják, a saját alakod nyer a
rácsból épített ellen. Részletek és a kimondott korlátok:
docs/feature-accounts-sync.md.
