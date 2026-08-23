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
nyit: mód-választó (mindig tiltva / sávokban tiltva / sávokban szabad) + sáv-
sablonok („Munkaidő H–P 9–17”, „Esti lekapcsolás 22–06”, „Hétvége”). Lazításnál
a próbatétel-folyamat indul. Az oldalsor a menetrend szerinti aktuális állapotot
is mutatja („most blokkolva” / „most szabad”).

- Desktop: renderer modal (screenshot: `docs/images/desktop-schedule.png`),
  end-to-end tesztelve.
- Android: Compose `ScheduleDialog` (AppUi.kt).
- iOS/macOS: SwiftUI `ScheduleEditor` (App/ScheduleEditor.swift).

Későbbi finomítás: szabadon szerkeszthető heti rács (napok × órák) a sablonok
mellé.

## Tesztek

- `isBlockedBySchedule`: sávon belül/kívül, éjfélátnyúlás, több nap, allow vs
  block mód.
- `isLoosening`: szigorítás=false, lazítás=true, always→block=szigorítás,
  block→allow általában lazítás, azonos menetrend=false.
- Integráció: menetrenddel a `activeHostnames` a sávhatáron vált.
