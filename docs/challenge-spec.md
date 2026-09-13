# Próbatétel-specifikáció (feloldási súrlódás)

Ez a dokumentum a feloldás nehezítésének viselkedési szerződése. Mindhárom
platform ugyanezt valósítja meg, közös kódból vagy annak pontos tükrözéséből:

| Platform | Fájl |
|----------|------|
| Desktop (Win/Mac) | `desktop/src/shared/challenges.ts` |
| Android | `android/app/src/main/java/hu/breaker/app/core/ChallengeEngine.kt` |
| iOS/macOS | `ios/Shared/ChallengeEngine.swift` |

## Miért nem elég egy gomb

A cél, hogy a blokkolás kikapcsolása **valódi erőfeszítést** igényeljen, és ne
váljon rutinná. Ezért:

1. **Nincs egykattintásos kikapcsolás.** Minden feloldás egy több lépéses
   „próbatétel-sorozat”, amit végig kell csinálni.
2. **Nem lesz könnyebb ismétléssel.** A tartalom (szöveg, számok, kód, mondat)
   *minden alkalommal frissen, véletlenszerűen* generálódik — nincs mit
   „betanulni”. Ráadásul a kombináció is változik (lásd lejjebb).
3. **Változatosság.** Egy sorozat a fok szerinti számú próbatípusból áll (3–6),
   és amíg van mit másikra cserélni, **nem ismétlődik ugyanaz a kombináció
   kétszer egymás után** (`lastCombo`). Négy lépéstől felfelé a halmaz
   kényszerű — ott a változatosságot a friss tartalom adja.
6. **A hátralévő lépések számát nem mondjuk meg.** A felület annyit ír ki, hogy
   van még legalább három feladat, vagy hogy van még — pontos számot soha. A
   „még kettő” tudása ugyanaz a lendület, mint a majdnem-kész érzés, és pont az
   viszi át az embert a feloldáson.
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

| Tier | Aktív próbák | Átgépelés (karakter) | Matek-lánc | Memória-kód | Visszafelé (szó) | Szünet-várakozás | Törlés-várakozás |
|------|--------------|----------------------|-----------|-------------|------------------|------------------|------------------|
| 0 | 3 | 900 | 8 | 12 | 10 | 30–45 p | 45–70 p |
| 1 | 4 | 1300 | 12 | 14 | 14 | 60–90 p | 90–130 p |
| 2 | 5 | 1800 | 16 | 16 | 18 | 90–150 p | 150–210 p |
| 3 | 6 | 2400 | 20 | 20 | 24 | 150–240 p | 240–360 p |

A memória-kód mutatási ideje fordítva megy (12 → 6 másodperc), a kötelező
kivárás pedig 90 másodperctől 6 percig nő.

**DELAY lépés MINDEN sorozat végén van** — minden fokon, szünetnél is. A
kísérlet elévülése (`SESSION_MAX_AGE_MS`) ezért 14 óra: a leghosszabb várakozás
maga hat óra, és a munka is idő. Ha az elévülés ennél szorosabb lenne, a
legnehezebb fokon a kísérletet befejezni sem lehetne — az nem szigor, hanem
elrontott szabály.

## Sorozat felépítése

```
generatePlan(kind, tier, lastCombo, forceCombo):
  - want = activeSteps[tier]            // 3 / 4 / 5 / 6
  - ha van forceCombo (feladott kísérlet tartozása): azt használd, és ha
    RÖVIDEBB, mint want, töltsd fel véletlen típusokkal (a feladás sosem lehet
    a kevesebb munka útja; ha hosszabb, marad hosszabb)
  - különben húzz `want` típust (TRANSCRIBE/MATH_CHAIN/MEMORY/REVERSE): előbb
    mind a négyet, utána ismétlés — friss tartalommal; és próbáld úgy, hogy a
    kombináció ne egyezzen az előzőével (korlátos számú próbálkozás, mert négy
    lépéstől felfelé nincs másik halmaz)
  - fűzz hozzá egy DELAY lépést — MINDIG
```

A korlátos újrapróbálás nem kényelmi kérdés: négy aktív lépésnél minden terv
ugyanaz a négy típus, tehát „másik kombináció” nem létezik. Korlát nélkül a
sorsolás örökké pörögne (ezt a saját tesztjeink fogták ki).

### Miért nem lehet újrapörgetni

A kombinációk között van különbség: a MEMORY-ban benne van egy kötelező
kivárás, a REVERSE gépelése lassabb, mint egy MATH_CHAIN. Ha a feladás új
kombinációt sorsolna, elég lett volna elég sokszor újrakezdeni, amíg jön a
legkényelmesebb — az a súrlódás pedig, amit újra lehet pörgetni, nem súrlódás.

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
  kezeljük: alvás közben nem telik a várakozás. Mindhárom platformon él — a kör
  az asztali segédben, az Android VPN-szolgáltatásban, illetve az iOS/macOS
  tunnelben fut.

  **Az alapvonal a LEMEZEN van, nem a memóriában.** Enélkül a védelem egy
  folyamat-leállítással megkerülhető: az app kilövése után az első kör csak új
  alapvonalat venne fel, és onnantól az előreállított óra ingyen rövidítené a
  várakozást. A gépen ez a szám mindig a mentett állapotban volt; a mobilokon
  sokáig memóriában élt, és ez valódi rés volt — most ott is a helyi tárban ül
  (`BreakerStore.loadLastTick`), a szinkronon KÍVÜL, mert helyi szám. A kiírás
  ritkítva megy (percenként), de a ritkítás ideje kisebb, mint az ugrás-küszöb,
  tehát a késleltetett kiírás önmagában sosem látszik ugrásnak.
- **A blokkolás alapból zár.** Ha bármi elromlik (lejárt session, elrontott
  hosts fájl), a rendszer a *blokkolt* állapot felé esik vissza, nem a nyitott
  felé.
