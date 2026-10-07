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
- Android: Compose `ScheduleDialog` (AppUi.kt).
- iOS/macOS: SwiftUI `ScheduleEditor` (App/ScheduleEditor.swift).

Szabadon szerkeszthető heti rács (napok × órák) nincs: a sávok listája és a
saját sáv ugyanazt kifejezi, és a heti ablak szerkesztőjével egy a nyelvük.

## A következő nyitás kiszámolható tény

A `nextOpenAt(schedule, now)` (shared/schedule.ts) megmondja, mikor enged
legközelebb a menetrend — percre lépkedve MAGÁT a tiltás-döntést kérdezi, nem
másolja a sáv-számtant, így óraátállásnál sem mondhat mást, mint amit a
tiltás tesz. A sosem nyíló menetrendre nullát ad. Ebből számol vissza a
bővítmény tiltó lapja („Nyit: még kb. 2 óra”) és az oldalsor korongja
(„nyit X múlva”). Csak az asztali státusz-út használja; a Kotlin/Swift
magnak nincs rá fogyasztója, ezért ott szándékosan nincs tükre.

## Tesztek

- `isBlockedBySchedule`: sávon belül/kívül, éjfélátnyúlás, több nap, allow vs
  block mód.
- `isLoosening`: szigorítás=false, lazítás=true, always→block=szigorítás,
  block→allow általában lazítás, azonos menetrend=false.
- `nextOpenAt`: percre pontos nyitás, éjfélátnyúlás, több napnyi várakozás,
  a sosem nyíló nulla.
- Integráció: menetrenddel a `activeHostnames` a sávhatáron vált.

## A három mag ugyanazt dönti

A menetrend az, ami a gépen és a telefonon EGYSZERRE dönt ugyanarról az
oldalról: egy elcsúszott sáv-számtan az oldalt az egyiken zárja, a másikon
nyitja, ugyanabban a percben. Ezért a `fixtures/merge-cases.json` menetrend-
szekciója (írja `desktop/test/merge-fixture.test.ts`) kézzel válogatott éleket
és véletlen heti sávrendszereket tart — mindhárom mód, éjfélen átnyúló és
érvénytelen sávok, a sávhatár perce másodpercekkel —, és azt, hogy a gép
szerint tilt-e most, és lazítás-e a csere egy másik menetrendre; a Kotlin
(`MergeFixtureTest`) és a Swift (`MergeFixtureTests`) ugyanezt játssza vissza.
A sávok helyi időben értékelődnek ki, ezért a három teszt UTC-ben jár — a gép
és az Android beállítja, a Swift beállítja, vagy ha nem tudja, kimondva
kihagyja. Ami a fixtúrában nincs: óraátállás és más időzóna — ott a három mag
a saját platformjának órájára hagyatkozik, és ezt itt kimondjuk.

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
