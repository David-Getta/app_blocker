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

- `lockdownWindows: LockdownWindow[]` az állapoton (segéd, Android, iPhone),
  legfeljebb hét ablak. A mezők a `Band`-éi — napok, `startMin`, `endMin`
  (éjfélen átnyúlhat) — és egy `id`, ami a felületé: a tartalom dönt
  mindenhol (`windowKey`), az azonosító nem.
- A karbantartó kör (`tick`) minden platformon megnézi, él-e ablak
  (`windowLockdown`), és ha a futó zárlat vége az ablak vége előtt van (vagy
  nincs zárlat), **az ablak végéig szóló zárlatot ír** a `lockdown` mezőbe —
  a kezdés az ablak kezdése (így két eszköz ugyanazt a zárlatot állítja elő),
  futó zárlatnál a futóé marad. A kapu (`assertUnlocked` / `requireUnlocked`)
  ugyanezt nézi a kör ELŐTT is: az ablak kezdése és az első kör közti
  másodpercek nem rés.
- **Óra-ugrás:** az ablak zárlatának vége az ablak vége, nem tolódik az
  alvással — ugyanaz a kivétel, mint az ablak-menetnél. Az „ablaké”-t a VÉG
  dönti el (`isWindowLockdown`: a vég pontosan egy ablak-előfordulás vége),
  nem a kezdés: egy ablak előtt indított kézi zárlatot az ablak csak kitol, és
  két egymásba érő ablakból a második az elsőét — mindkettő az ablak ígérete.
  A kézi zárlat továbbra is tolódik. Ami kézi zárlat véletlenül épp egy ablak
  végén ér véget, az is az ablak szabálya alá esik; ablak nélkül is pont eddig
  tartana, tehát ez nem nyit semmit.
- **A beérő ablak a folyamatban lévő kísérletet is elviszi** — a levételét
  is. Bent nincs próbatétel; a levételt az ablakon kívül kell elkezdeni ÉS
  befejezni. Ez a szigorúbb irány, és a felület kimondja.
- **Szinkron:** az ablakok a munkamenet blobján utaznak (`lockdownWindows`),
  a **tartalmankénti jelükkel** (`lockdownWindowMarks`: tartalmi kulcs —
  napok, kezdés, vég — → annak a blobnak a `rev`-je, amelyik az ilyen
  ablakot utoljára felvette vagy levette; a lenyomat-léptetés írja). A
  fésülés **tartalmanként** megy, a kulcsszavak mintájára: a **nagyobb jel
  dönt** (ami annál áll, benne van vagy nincs, az marad), egyenlő — vagy
  hiányzó — jelnél az **unió**, a szigorúbb irány. A módosítás a régi
  tartalom levétele és az új felvétele, külön jellel: a bővítés így sem
  lazít (az új lefedi a régit), a szűkítés pedig próbatétel volt, és a
  levétel jele viszi át. A lista egészének jele (`lockdownWindowsRev`) csak a
  régi klienseknek utazik tovább.

  Miért nem a lista egészének jele. Az ingyenes felvétel is lépteti: egy
  elavult eszközön egy új ablak felvétele felhúzta a jelet, és a régi
  listája mindenhol letörölte a máshol felvett ablakot — próbatétel nélkül.
  Most egy ablak jele csak akkor változik, ha ő maga változik; egy elavult
  eszköz más szerkesztése nem viszi el, levenni pedig csak a próbatétellel
  lehet, ami a levétel jelét írja.

  A sorrend a régebbi ígéreté: a jel szerint (a jeltelen elöl), egyenlő
  jelnél a kisebb ablak, aztán a kulcs. A hetes plafon és a heti egy szabad
  óra ebben a sorrendben vág — **a legfrissebb esik ki**, nem a régi: egy
  frissen felvett ablak-tömeg nem szoríthat ki régi ablakot, és két eszköz
  ablakainak uniója sem zárhatja le az egész hetet (akkor az ablakot sosem
  lehetne levenni — az csapda, nem döntés). A kiesett ablak jele marad. A
  szabad órát a fésülés SZERKEZET szerint méri (a hét 7×1440 perce,
  óraátállítás és időzóna nélkül, `freeMinutesPerWeek`), mert annak minden
  eszközön, minden pillanatban ugyanazt kell adnia; a bíró a felvételnél a
  valódi órával, a következő héten mér. Azonos tartalomnál a kisebb
  azonosító marad; ha egy azonosító két tartalomhoz is tartozna (két eszköz
  ugyanazt az ablakot másképp bővítette), a későbbi a tartalmi kulcsát kapja
  azonosítónak. A jelek plafonja 64: a jelen lévők jele mindig marad, a
  levettekből a legfrissebbek. A léptetés az előző tartalmakat is eltárolja
  (`focusRevWindows`), és abból jelöl; az átvett listát a szinkron szintén
  eltárolja, hogy a következő helyi szerkesztés ne jelölje felvettnek vagy
  levettnek, ami nem itt történt.

  Őszinte határok. **Egy régi kliens kifizetett levétele nem tartja meg
  magát:** a frissítés előtt felvett ablakoknak nincs saját jele; ha egy még
  nem frissített eszköz veszi le őket, a frissített eszközök jeltelen
  példánya visszahozza (az unió — a szigorúbb irány). Ezért kell minden
  eszközt frissíteni. **A vágás a sorrendtől is függhet:** ha három eszköz
  ablakainak uniója túlmegy a hetes plafonon vagy a heti szabad órán, a
  páronkénti fésülés nem társítható — hogy melyik ablak esik ki, az átmeneti
  állapotokban a szinkron sorrendjétől is függ. A vágás sorrendje (jel,
  méret, kulcs) mindenhol ugyanaz, és az eszközök a kiszolgálón át ugyanarra
  az állapotra jutnak; csak az út más.
- A telefonok az ablakot **hordozzák, fésülik és érvényesítik** (a körük
  zárlatot ír belőle), és szerkesztik is: a bíró ugyanaz a
  `setLockdownWindows` (Kotlin, Swift), ugyanazzal a kapuval, ugyanazzal a
  próbatétellel a levételre és a szűkítésre. A felület a menetrend előre
  gyártott sávjait kínálja (munkaidő, esti lekapcsolás, hétvége), és mellette
  egy saját sávot is: napok, kezdés, vég — mint a gépen. Módosítani is lehet:
  ugyanaz a lap nyílik meg az ablak mezőivel kitöltve, és a mentés az ablak
  helyére írja az újat, ugyanazzal az azonosítóval — a bíró a tartalmat
  hasonlítja, és ő mondja meg, lazítás-e.

## Hol van a felületen

**Gépen:** a zárlat kártyáján, a gomb alatt: az ablakok listája, mindegyiknél
a napok és a sáv, egy *Módosítás…* gomb (bővíteni ingyen, szűkíteni
próbatétel) és egy *Levétel…* gomb (próbatétel; bent el sem indul, a kártya
kimondja, miért). Új ablak a *Heti ablak felvétele* gombbal: napok, kezdés,
vég — ugyanaz a szerkesztő, mint a csomag ablakánál —, és a három előre
gyártott sáv (munkaidő, esti lekapcsolás, hétvége) egy-egy gombbal kitölti a
mezőket. Minden sor mondja, mikor jön az ablak legközelebb. A sáv az ablak zárlatát
„Zárlat a heti ablak szerint”-ként mondja, és amikor az ablak beér, a gép
értesítést is ad (ha az app engedélyt kapott rá) — aki nem maga indította,
tudja meg, miért van minden zárva. A tiltó lap és a gyorsbillentyűs réteg
ugyanazt a zárlatot mutatja, mint a kézinél.

**A böngészőben az app nélkül is.** Az ablak zárlatát a segéd az app nélkül
is elindítja — a böngésző tiltó lapja viszont a hídon, a futó apptól tudott
a zárlatról, és zárva lévő app mellett azt írta a lába, hogy a tiltás az
appban, próbatétellel feloldható. Az ablak alatt ez az út nincs. Most a híd
minden lehúzással a zárlat-ablakok következő hetét is leküldi
(`upcomingLockdownWindows` — ugyanazok az előfordulások, amiket a segéd köre
a maga idejében elindít, a `dueLockdownWindow` szerint; teszt veti össze), a
bővítmény tárolja, és ha az app több mint egy perce hallgat, a most tartó
tárolt ablak is zárlat a lapon, az ablak jelével (`effectiveLockdown` az
`extension/app-link.js`-ben). Amíg az app friss, az ő szava dönt — ő tudja,
ha egy ablakot azóta levettek. Őszinte rés, a szigorúbb irányba: ha egy
ablakot máshol (a szinkronon át) vettél le, amíg a gépen az app zárva volt,
a lap az app következő indulásáig még zárlatot mondhat az ablak idejében.

**Telefonon:** a zárlat kártyája felsorolja az ablakokat, mindegyiknél
*Módosítás…* (bővíteni ingyen, szűkíteni próbatétel) és *Levétel…*
(próbatétel — a szokásos próbatétel-lap, „Zárlat-ablak lazítása” fejléccel;
bent el sem indul), és a *Heti ablak felvétele* gomb a menetrend előre
gyártott sávjait kínálja, meg egy saját sávot (napok, kezdés, vég). Minden
sor mondja, mikor jön az ablak legközelebb. A sáv ugyanúgy mondja a zárlatot,
mint a kézinél. Androidon a szűrő állandó
értesítése is a zárlatot mondja (kézit és ablakét, és hogy meddig), és amikor
az ablak beér, egy külön, lehúzható értesítés is jön — mint a gépen. iPhone-on
a szűrő bővítménye nem adhat értesítést, ezért az app **heti emlékeztetőt
ütemez** minden ablak minden napjára a kezdés percére (`WindowReminders`; a
tervet — mikor, mit mondjon — a mag adja, `reminderPlan`, teszttel, mert az
app-célt a CI nem futtatja): a rendszer adja, akkor is, ha az app nincs nyitva. A listát az app minden
nyitásakor és a lista minden változásakor újraírja — a szinkronból jött
változásnál is, amíg nyitva van; ami zárt app mellett, a szűrő szinkronjával
jön, az a következő megnyitáskor kerül be. Az első ablaknál a rendszer
értesítési engedélyt kér.

**Tíz perccel a beérés előtt** mindhárom platform egyszer szól: „Mindjárt
beér a heti ablak” — mennyi idő múlva, és meddig tart majd; ami nyitva van,
mentsd el. A gép és az Android a saját köréből mondja (`windowStartingSoon`),
és csak akkor, ha nem ér túl az ablakon egy futó zárlat — annak az érkezése
semmin nem változtatna. iPhone-on ez is előre ütemezett, ezért futó zárlat
alatt is szól, és csak akkor fér bele, ha az ablak-napok száma legfeljebb
harminc (a rendszer hatvannégy függő kérést enged; a beérés kérése az elsőbb).

## A három mag ugyanazt dönti

A heti ablak minden eszközön UGYANAKKOR zár és ugyanakkor enged: a lista a
munkamenet-blobon utazik, a döntést mindhárom mag maga hozza, helyi időben. Ha
az előfordulás-számtan elcsúszna, az egyik eszköz zárlatot tartana, a másik
nem — vagy a kettő más zárlatot állítana elő, és a szinkron kettőnek látná.
Ezért a `fixtures/merge-cases.json` ablak-szekciója (írja
`desktop/test/merge-fixture.test.ts`) kézzel válogatott éleket (a közelgő
ablak tízperces kerete egy másodperccel innen és túl, az élő ablak, a futó
zárlat, ami túlér rajta és ami nem, az éjfélen átnyúló ablak másnap hajnalban,
két ablak egyszerre, a szabad idő nélküli hét, az üres lista, az ablak végén
véget érő kézi zárlat) és véletlen ablak-listákat tart — rossz sávokkal is —,
és azt, hogy a gép szerint marad-e szabad idő, lazítás-e a csere, mi az élő
ablak, mit követelnek meg az ablakok, ablak-zárlat-e, mi a közelgő ablak és a
következő előfordulás; a Kotlin (`MergeFixtureTest`) és a Swift
(`MergeFixtureTests`) ugyanezt játssza vissza. A három teszt UTC-ben jár — a
gép és az Android beállítja, a Swift beállítja, vagy ha nem tudja, kimondva
kihagyja. Az óraátállást külön fixtúra nézi (`fixtures/dst-cases.json`,
Europe/Budapest, a 2026-os tavaszi és őszi éjszaka): a kétszer előforduló
falióra-idő az első előfordulás, a kihagyott az átállás előtti eltolással —
mindhárom magban. Más időzónát a fixtúra nem néz; ott a szabály ugyanez, de
a platform órájára hagyatkozik.
