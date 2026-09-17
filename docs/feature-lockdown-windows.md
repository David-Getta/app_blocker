# Zárlat-ablak: heti ablak, amiben a zárlat magától él

A zárlat (`feature-lockdown.md`) egyszeri döntés: „mostantól hét napig nem
tárgyalunk”. Aki a munkanapjait akarja védeni, annak ezt minden reggel újra
el kellene indítania — és pont reggel, a kávé előtt, a legkönnyebb nem
elindítani. A zárlat-ablak ezt veszi le róla: egy heti ablak (például
hétköznap 9-től 17-ig), amiben a zárlat magától él, minden héten, minden
eszközön.

Ugyanaz az alak, mint a munkamenet heti ablaka (`feature-focus-sessions.md`):
napok, kezdés, vég — csak nem egy csomag indul tőle, hanem a zárlat.

## Mit csinál

- Amikor az ablak él, a segéd (és a telefonon a szűrő köre) **zárlatot
  indít az ablak végéig** — pontosan azt a zárlatot, amit kézzel is lehet:
  ugyanaz a kapu, ugyanaz a sáv, ugyanaz a szinkron. Az ablak nem új
  érvényesítés, hanem egy időzítő a meglévő elé.
- Kézzel **hosszabbítani** az ablak zárlatát is lehet (a zárlat csak
  hosszabbodhat). Rövidíteni nem — se az ablak levételével: az ablak
  levétele csak az ablakon KÍVÜL indítható, mert bent zárlat van, és zárlat
  alatt semmilyen lazító próbatétel nem indul.
- **Felvenni és bővíteni ingyen van.** Egy ablak levétele vagy szűkítése
  (kevesebb nap, rövidebb sáv) lazítás: próbatétel — ugyanaz, mint a csomag
  heti ablakánál.
- **Az egész hét nem zárható le ablakokkal.** Legalább egy szabad óra kell a
  héten, különben az ablakot sosem lehetne levenni — az nem döntés lenne,
  hanem csapda. A kézi zárlatnak ezért van harminc napos plafonja; az
  ablaknak ez a hetes szabad óra.

## Hogyan működik belül

- `lockdownWindows: Band[]` az állapoton (segéd, Android, iPhone), legfeljebb
  hét ablak. A `Band` ugyanaz, mint a menetrendnél és a csomag ablakánál:
  napok, `startMin`, `endMin` (éjfélen átnyúlhat).
- A karbantartó kör (`tick`) minden platformon megnézi, él-e ablak
  (`dueLockdownWindow`), és ha a futó zárlat vége az ablak vége előtt van,
  **meghosszabbítja az ablak végéig** — a `startLockdown` úton, tehát a
  kézi zárlat minden tulajdonságával.
- **Óra-ugrás:** az ablakból született zárlat vége az ablak vége, nem
  tolódik az alvással — ugyanaz a kivétel, mint az ablak-menetnél
  (`isWindowLockdown`). A kézi zárlat továbbra is tolódik.
- **Szinkron:** az ablakok a munkamenet blobján utaznak, a csomagok mellett.
  Fésülés: **nagyobb `rev` nyer; azonos `rev`-nél a bővebb lista** (a két
  lista uniója). A levétel próbatétellel jár, ami lépteti a `rev`-et, tehát a
  levétel átmegy; egy elmaradt eszköz régi listája nem támaszthatja fel.
  Őszinte határ: ha két eszköz EGY körben egyszerre vesz fel és le egy-egy
  ablakot azonos `rev`-vel, a bővebb lista marad — a szigorúbb irány.

## Hol van a felületen

A zárlat kártyáján, a gomb alatt: az ablakok listája, mindegyiknél a napok
és a sáv, és egy *Levétel…* gomb (próbatétel). Új ablak: napok, kezdés, vég
— ugyanaz a szerkesztő, mint a csomag ablakánál. A sáv és a tiltó lap
ugyanazt a zárlatot mutatja, mint a kézinél: „Zárlat: még N óra”.
