# Funkcióterv: napi időkeret oldalanként

Státusz: **tervezve, még nincs implementálva.** Ez a dokumentum a következő
lépés terve, hogy ne kelljen újra kitalálni.

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
2. **A desktop mérő a GUI-ban fut**, tehát a keret csak akkor fogy, amíg a Lakat
   fut. Ez őszintén kiírandó a felületen; a helper enélkül nem tud a fogyásról.
   (Alternatíva később: a helper is számolhatna, ha kap egy „még mindig aktív”
   jelzést.)

## Felület

- Az oldal sorában egy „Napi keret…” gomb, sávdiagrammal: *elfogyott 12 / 20 p*.
- Elfogyott keretnél a sor jelölése: „Ma elfogyott a keret — holnap újraindul”.
- A keret emelésénél ugyanaz a próbatétel-ablak nyílik, mint a menetrend
  lazításánál, és a felület elmondja, miért.

## Tesztek, amiket meg kell írni

- A keret elfogyása blokkol, akkor is, ha a menetrend szerint szabad lenne.
- Éjfél után újraindul (a napi vödör vált).
- A keret csökkentése azonnal érvényes, az emelése próbatételhez kötött.
- A keret nem kerülhető meg a mérés kikapcsolásával.
- A meglévő véletlenszerű interakció-teszt invariánsai a kerettel is állnak.
