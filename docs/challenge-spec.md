# Próbatétel-specifikáció (feloldási súrlódás)

Ez a dokumentum a feloldás nehezítésének viselkedési szerződése. Mindhárom
platform ugyanezt valósítja meg, közös kódból vagy annak pontos tükrözéséből:

| Platform | Fájl |
|----------|------|
| Desktop (Win/Mac) | `desktop/src/shared/challenges.ts` |
| Android | `android/app/src/main/java/hu/lakat/app/core/ChallengeEngine.kt` |
| iOS/macOS | `ios/Shared/ChallengeEngine.swift` |

## Miért nem elég egy gomb

A cél, hogy a blokkolás kikapcsolása **valódi erőfeszítést** igényeljen, és ne
váljon rutinná. Ezért:

1. **Nincs egykattintásos kikapcsolás.** Minden feloldás egy több lépéses
   „próbatétel-sorozat”, amit végig kell csinálni.
2. **Nem lesz könnyebb ismétléssel.** A tartalom (szöveg, számok, kód, mondat)
   *minden alkalommal frissen, véletlenszerűen* generálódik — nincs mit
   „betanulni”. Ráadásul a kombináció is változik (lásd lejjebb).
3. **Változatosság.** Egy sorozat két különböző próbatípusból áll, és **soha nem
   ismétlődik ugyanaz a páros kétszer egymás után** (`lastCombo`).
4. **Növekvő ellenállás.** Ha valaki gyakran old fel, a nehézség automatikusan
   nő (tier 0→3 az elmúlt 7 nap feloldásai alapján).
5. **A törlés a legnehezebb.** Egy oldal végleges levételéhez a legmagasabb
   nehézség tartozik, kötelező várakozással, és **24 órás türelmi idő** után lép
   csak életbe — addig egy kattintással visszavonható.

## Próbatípusok

- **TRANSCRIBE** — hosszú, véletlen szöveg karakterre pontos átgépelése
  (300–720 karakter tiertől függően). Beillesztés tiltva. Hibánál ugyanaz a
  szöveg marad (az újragépelés maga az erőfeszítés).
- **MATH_CHAIN** — fejszámolási lánc (3–9 feladat). **Egyetlen hiba az egész
  láncot elölről indítja, új feladatokkal.**
- **MEMORY** — 8–14 karakteres kód megjegyzése; a kód eltűnik, majd kötelező
  várakozás után emlékezetből kell beírni. Hibánál új kód. **Az időzítés
  szerveroldali**: amikor a lépés aktuálissá válik, a bíró lebélyegzi
  (`armedAt`), a kódot csak a mutatási ablak alatt küldi ki a felületnek
  (ablak bezárás/újranyitás nem mutatja meg újra), és a memorizálás +
  várakozás letelte előtt semmilyen választ nem fogad el.
- **REVERSE** — egy mondat karakterről karakterre visszafelé begépelése.
  Hibánál új mondat.
- **DELAY** — kötelező, valós idejű várakozás (tiertől és típustól függően
  10–120 perc). A visszaszámlálás akkor is fut, ha az app zárva van. Amikor
  lejár, **10 perces átvételi ablak** nyílik; ha lecsúszol róla, az **egész
  kísérlet érvénytelen**, elölről kell kezdeni.

## Nehézségi tierek

`computeTier(unlockLog, now)` az elmúlt 7 nap feloldásainak száma alapján:

| Feloldások / 7 nap | Tier | Jelentés |
|--------------------|------|----------|
| 0–1 | 0 | alap |
| 2–3 | 1 | emelt |
| 4–6 | 2 | magas |
| 7+  | 3 | maximális |

Törlésnél a tier eggyel feljebb tolódik (max 3).

| Tier | Átgépelés (karakter) | Matek-lánc | Memória-kód | Visszafelé (szó) | Szünet-várakozás | Törlés-várakozás |
|------|----------------------|-----------|-------------|------------------|------------------|------------------|
| 0 | 300 | 3 | 8 | 4 | (nincs) | 15–30 p |
| 1 | 420 | 5 | 10 | 6 | (nincs) | 30–50 p |
| 2 | 560 | 7 | 12 | 8 | 30–60 p | 45–80 p |
| 3 | 720 | 9 | 14 | 10 | 45–90 p | 60–120 p |

DELAY lépés szünetnél tier ≥ 2-től, törlésnél mindig van.

## Sorozat felépítése

```
generatePlan(kind, tier, lastCombo, forceCombo):
  - ha van forceCombo (feladott kísérlet tartozása): azt a párost használd
  - különben válassz 2 KÜLÖNBÖZŐ aktív típust
    (TRANSCRIBE/MATH_CHAIN/MEMORY/REVERSE), úgy, hogy a párosuk ne egyezzen az
    előző sorozatéval
  - ha tier >= 2 VAGY kind == delete: fűzz hozzá egy DELAY lépést
```

### Miért nem lehet újrapörgetni

A pároséban van különbség: a MEMORY-ban benne van egy kötelező kivárás, a
REVERSE gépelése lassabb, mint egy MATH_CHAIN. Ha a feladás új párost sorsolna,
elég lett volna elég sokszor újrakezdeni, amíg jön a legkényelmesebb kettő — az
a súrlódás pedig, amit újra lehet pörgetni, nem súrlódás.

Ezért minden **befejezés-szerű esemény** (feladom gomb, új kísérlet indítása a
régi helyett, a DELAY átvételi ablakának kihagyása, a session elévülése)
ugyanoda könyvel: megjegyzi a párost és az időpontját — **oldalanként**. Egyetlen
közös rekord kevés lenne: akkor elég volna egy másik oldalon (vagy ugyanannak az
oldalnak a törlés-folyamatában) elindítani és megszakítani egy kísérletet, és az
eredeti tartozás eltűnne. A **típus** (szünet/törlés) viszont szándékosan nem
számít: mindkettő ugyanabból a készletből húz. Egy órán belül
(`REROLL_COOLDOWN_MS`) ugyanaz a **páros** jön vissza — de **friss tartalommal**
és nulláról, tehát a haladás sem bankolható: kiszállni sosem olcsóbb, mint
végigcsinálni. Az óra az **első** feladástól számít, nem a legutóbbi
újraindítástól, különben a páros örökre az oldalra ragadna.

Megoldás után a tartozás törlődik, és a következő kísérlet megint szabadon húz
— a változatosságot ilyenkor a `lastCombo` szabály őrzi (nem lehet ugyanaz,
mint az előző).

## Fontos szabályok

- **A válaszok kiértékelése mindig a védett/privilegizált oldalon történik**
  (desktop: root/SYSTEM helper; mobil: közös mag megbízható tárolóval), nem a
  felületen. A UI soha nem kapja meg az elvárt választ (`toDisplay` mindent
  kiszűr), így nincs „csak írd át a flaget” rövidzárlat a felületről.
- **A haladás nem bankolható.** Új kísérlet indítása eldobja a korábbit; a
  DELAY-t nem lehet „félretenni és később átvenni” az ablakon túl.
- **A feladás nem sorsol könnyebbet.** Egy órán belül ugyanaz a próbatípus-páros
  jön vissza (friss tartalommal) — lásd fent.
- **Az óra átállítása nem rövidíti a várakozást.** A DELAY lépés és a törlés
  24 órás türelmi ideje eltelt időt mér, nem dátumot: a segéd minden
  karbantartó körben nézi, mennyit ugrott a fali óra, és a *védő* határidőket
  (várakozás célpontja, folyamatban lévő törlés, a kísérlet kora) ugyanannyival
  kitolja. A `pauseUntil` szándékosan kimarad — egy előre ugró óra ott korábban
  visszazár, ami szigorítás. A gép alvása kívülről ugyanígy néz ki, és ugyanígy
  kezeljük: alvás közben nem telik a várakozás. Androidon ugyanez működik (a
  kör a VPN-szolgáltatásban fut); iOS-en még nincs átvezetve (lásd
  `docs/architecture.md`, ismert korlátok).
- **A blokkolás alapból zár.** Ha bármi elromlik (lejárt session, elrontott
  hosts fájl), a rendszer a *blokkolt* állapot felé esik vissza, nem a nyitott
  felé.
