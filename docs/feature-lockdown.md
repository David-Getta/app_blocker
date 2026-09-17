# Zárlat: amikor a lazítás nem drága, hanem nincs

Eddig minden lazításnak volt ára — próbatétel —, de ára volt, tehát útja is.
Aki hajnali kettőkor elhatározza, hogy átrágja magát rajta, az átrágja magát
rajta; a nehezebb feladat csak drágítja az utat, nem zárja le.

A zárlat az a válasz, ami tényleg lezárja. Amíg tart, a segéd **el sem indít**
próbatételt lazításra: nincs mit teljesíteni, nincs mit megpróbálni.

Ez az egyetlen művelet az egész appban, aminek szándékosan **nincs visszaútja**.

## Mit tilt és mit nem

Zárlat alatt NEM indítható:

- oldal feloldása („15 percre nyisd ki”),
- végleges törlés,
- a menetrend lazítása (kevesebb tiltott idő),
- a napi keret emelése vagy megszüntetése,
- az adag-szabály lazítása (nagyobb adag, rövidebb szünet, levétel),
- hosztnév levétele az oldalról,
- részleges szabály levétele,
- csatorna-szűrő kikapcsolása vagy törlése,
- a futó munkamenet leállítása vagy rövidítése,
- a heti ablak szűkítése vagy levétele.

Zárlat alatt VÁLTOZATLANUL megy, ingyen:

- új oldal blokkolása,
- szigorítás mindenhol (szűkebb menetrend, kisebb keret, kisebb adag,
  hosszabb szünet, új hosztnév, új részleges szabály, új csatorna-szűrő),
- munkamenet indítása és hosszabbítása,
- a mérés, a statisztika, a szinkron, a fedőnevek, a lista elrejtése,
- **a zárlat hosszabbítása**.

Az indítás pillanata maga nem lehet kibúvó, ezért a zárlat **visszaveszi azt
is, ami félig kint volt**: a futó próbatétel elszáll (a feladott kísérletek
könyvelése szerint, tehát kedvezmény sincs), a feloldott oldalak azonnal
visszazárnak, és a folyamatban lévő végleges törlések visszavonódnak — a
kivárt huszonnégy óra elvész. Ez a szigorúbb irány, és ez a zárlat ára.

A futó munkamenethez (fókusz-csomag) nem nyúl: az fehérlista, vagyis maga is
szigorítás.

## Hol van a felületen

- **Gépen:** az oldalak nézetében a *Zárlat* kártya, a lista alatt. Amíg tart,
  a felső sávban minden nézetben ott az ok és a hátralévő idő.
- **Androidon és iPhone-on:** ugyanaz — sáv legfelül, kártya a statisztika
  után.
- **A böngésző-bővítményben:** a tiltó lap lába zárlat alatt nem azt írja, hogy
  „az appban feloldható, próbatétellel” — mert az az út most nincs —, hanem a
  zárlatot és a hátralévő időt. A felugró lap is kimondja. A zárlat vége a hídon
  megy le; a frissesség-szabály itt más, mint a zárva-listánál: a zárlat csak
  hosszabbodhat, tehát egy régebbi lehúzás vége is igaz alsó becslés.
- **A gyorsbillentyűs rétegben:** futó menet alatt nincs leállító gomb — egy
  szürke, letiltott gomb azt sugallná, hogy van út, csak most nem —, a láb a
  zárlatról beszél.

A párbeszédben hossz választható (1 óra, 3 óra, 8 óra, 1 nap, 3 nap, 7 nap),
és **ki kell írni a ZÁRLAT szót**. Ez nem biztonsági elem — aki idáig eljutott,
az kiírja —, hanem a félrekattintás ellen: ennek a gombnak nincs visszavonása.

## Hogyan működik belül

Egyetlen mező (`lockdown`: mikortól, meddig) és **egyetlen kapu**. Mindhárom
magban minden lazító próbatétel terve ugyanazon a függvényen megy ki:

- `desktop/src/helper/referee.ts` → `planLoosening` → `assertUnlocked`
- `android/.../core/Referee.kt` → `planLoosening` → `requireUnlocked`
- `ios/Shared/Referee.swift` → `planLoosening` → `requireUnlocked`

Azért EGY helyen, mert a projekt visszatérő hibafajtája nem a rossz logika,
hanem a kihagyott hívás: tíz belépési pontra tíz külön ellenőrzésből egy
előbb-utóbb lemaradna, és a hiányt semmi nem mutatná meg — egy nem hívott
ellenőrzés érvényes kód. A `desktop/test/lockdown.test.ts` utolsó tesztje
ezért a FORRÁST olvassa el: ha valaki felvesz egy tizenegyedik utat és
kikerüli a kaput, ott hasal el, nem a felhasználónál.

A mag maga tiszta és függőség nélküli: `desktop/src/shared/lockdown.ts`, a
`core/Lockdown.kt` és a `Shared/Lockdown.swift` a tükre. A számai
(harminc napos plafon, a gyorsgombok) a `scripts/check-core-sync.js`
ellenőrzése alatt állnak, tehát nem csúszhatnak szét a három platform között.

### A rövidítés nem elfelejtett ellenőrzés

A mezőhöz EGYETLEN út vezet, a `startLockdown`, és az eredménye sosem rövidebb
a mostaninál. Nem azért, mert ellenőrizzük — hanem mert nincs olyan hívás,
amivel rövidíteni lehetne. A rövidítés itt nem tiltott, hanem
megfogalmazhatatlan.

### Az óra átállítása nem fejezi be

A zárlat vége ugyanúgy eltolódik az óra-ugrással, mint a futó munkamenet:
*amennyi hátra volt, annyi van hátra*. Enélkül két perc munkával — az óra
előreállításával — meg lehetne szüntetni pont azt az egy dolgot, aminek nincs
visszaútja.

Ugyanez a válasz az alvó gépre és telefonra is, és ez nem mellékhatás: a
készülék nem tudja megkülönböztetni az átállított órát a felfüggesztett
géptől, de nem is kell — egy lecsukott laptop előtt nem telik a zárlat, mert
nem is kísért.

### A szinkron nem tudja visszavonni

A zárlat a **munkamenet blobján** utazik (nem a blokklistán: nem egy oldal
ügye, hanem az egész eszközé). A fésülése tiszta **magasvízjel**: a KÉSŐBBI
vég nyer, a `rev`-re való tekintet nélkül.

Ez nem lazaság, hanem maga a szabály. A zárlat csak szigorítani tud, tehát nem
kell megvédeni attól, hogy egy régebbi rekord felülírja — visszafelé úgysem
tud lépni. Egy hálózat nélkül maradt eszköz így nem old fel semmit azzal, hogy
a régi állapotát tolja fel; a másik eszközön indított zárlat pedig percek
múlva itt is él, és a kör azonnal visszazárja a feloldott oldalakat.

## Őszinte korlátok

- **Nem gépzár.** Rendszergazdaként a háttérszolgáltatás leállítható, a
  telefonon az app letörölhető. A zárlat az appon BELÜL zár le mindent, vagyis
  az impulzus ellen véd, nem a megfontolt, tíz perces kerülőút ellen. Ezt a
  felület is kimondja, nem csak ez a lap.
- **Eszközóra-eltérés.** A vég abszolút időpont. Ha a másik eszköz órája
  siet, az onnan indított zárlat itt hosszabbnak látszik. Az irány a
  szigorúbb, és nem titkoljuk.
- **Régi kliens a fiókban.** Egy olyan eszköz, ami még nem ismeri a mezőt,
  a saját feltöltésével kiejtheti a blobból — a zárlat ilyenkor azon az
  eszközön marad, ahol indították. Frissítés után magától rendbe jön.
- **A 24 órás türelmi idő elvész.** Ha épp futott egy végleges törlés, a
  zárlat visszavonja. Ez szándékos: a zárlat mindent visszaszigorít.
