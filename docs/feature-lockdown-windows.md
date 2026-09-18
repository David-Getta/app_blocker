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
  a **jelükkel** (`lockdownWindowsRev`: a blob `rev`-je, amelyik a listát
  utoljára változtatta — a lenyomat-léptetés írja). Fésülés: **nagyobb jel
  nyer; azonos jelnél a bővebb lista** (a kettő uniója tartalom szerint). A
  levétel próbatétellel jár, ami lépteti a blobot ÉS a jelet, tehát a levétel
  átmegy; a másik eszköz csomag-szerkesztése vagy menet-indítása (ami a blob
  `rev`-jét lépteti, a jelet nem) sem viszi el a listát, sem nem támasztja fel
  a levettet. A jel nélküli blob (régi kliens) jele nulla: az ilyen sosem
  törölhet listát. Őszinte határ: ha két eszköz EGY körben egyszerre vesz fel
  és le egy-egy ablakot azonos jellel, a bővebb lista marad — a szigorúbb
  irány; és egy még soha fel nem töltött, jeltelen lista egy másik eszköz
  jeles levételével szemben elveszik (ingyen visszavehető).
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
vég — ugyanaz a szerkesztő, mint a csomag ablakánál. A sáv az ablak zárlatát
„Zárlat a heti ablak szerint”-ként mondja, és amikor az ablak beér, a gép
értesítést is ad (ha az app engedélyt kapott rá) — aki nem maga indította,
tudja meg, miért van minden zárva. A tiltó lap és a gyorsbillentyűs réteg
ugyanazt a zárlatot mutatja, mint a kézinél.

**Telefonon:** a zárlat kártyája felsorolja az ablakokat, mindegyiknél
*Módosítás…* (bővíteni ingyen, szűkíteni próbatétel) és *Levétel…*
(próbatétel — a szokásos próbatétel-lap, „Zárlat-ablak lazítása” fejléccel;
bent el sem indul), és a *Heti ablak felvétele* gomb a menetrend előre
gyártott sávjait kínálja, meg egy saját sávot (napok, kezdés, vég). A sáv
ugyanúgy mondja a zárlatot, mint a kézinél. Androidon a szűrő állandó
értesítése is a zárlatot mondja (kézit és ablakét, és hogy meddig), és amikor
az ablak beér, egy külön, lehúzható értesítés is jön — mint a gépen. iPhone-on
a szűrő bővítménye nem adhat értesítést, ezért az app **heti emlékeztetőt
ütemez** minden ablak minden napjára a kezdés percére (`WindowReminders`): a
rendszer adja, akkor is, ha az app nincs nyitva. A listát az app minden
nyitásakor és a lista minden változásakor újraírja — a szinkronból jött
változásnál is, amíg nyitva van; ami zárt app mellett, a szűrő szinkronjával
jön, az a következő megnyitáskor kerül be. Az első ablaknál a rendszer
értesítési engedélyt kér.
