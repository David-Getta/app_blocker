# Funkcióterv: aktív idő mérése + statisztikák

> Állapot: tervezés + implementáció folyamatban. A közös mag (TypeScript) a
> referencia, a Kotlin/Swift tükör követi.

## Mit old meg

Mérje, hogy **melyik weboldalon és melyik appban mennyi időt töltünk** — de
**csak azt az időt**, amikor ténylegesen ott vagyunk, nem azt, hogy meddig van
megnyitva. Egy háttérben nyitva felejtett YouTube-fül nem gyűjthet órákat.

## Az „aktív idő” definíciója

Egy másodperc akkor számít bele egy célpont (app vagy oldal) idejébe, ha
**mindhárom** igaz:

1. az adott alkalmazás az **előtérben / fókuszban** van (nem csak fut),
2. böngésző esetén az **aktív fül** az adott oldalé (nem egy háttérfül),
3. a felhasználó **nem tétlen** — az utolsó billentyű/egér/érintés esemény óta
   kevesebb, mint `IDLE_THRESHOLD` (alapból 60 mp) telt el.

Ezen kívül a képernyőzár / alvás / képernyővédő automatikusan tétlennek számít.

## Mintavételes mérés

Nem eseményfigyelés, hanem **periodikus mintavétel**: `SAMPLE_INTERVAL` (alapból
5 mp) másodpercenként megnézzük, mi van fókuszban, és ha nem vagyunk tétlenek, a
mintavételi időt hozzáadjuk az aktuális célponthoz. Ez egyszerű, robusztus és
kevés erőforrást használ; a mérési hiba legfeljebb egy mintavételi periódus.

Fontos: **a minta akkor sem duplázódik**, ha a rendszer lassabban ébred (alvás
után) — a mérő az eltelt valós időt is korlátozza a mintavételi periódusra, így
egy 8 órás alvás nem ír be 8 órát.

## Adatmodell

Napi „vödrökbe” (bucket) aggregálunk, célpont-kulcsonként másodpercben:

```ts
type TargetKind = 'app' | 'site';
// kulcs: "app:<azonosító>" vagy "site:<domain>"
interface UsageDay { day: string; /* YYYY-MM-DD helyi idő */ seconds: Record<string, number> }
interface UsageState {
  days: UsageDay[];                 // időrendben, RETENTION_DAYS-re vágva
  labels: Record<string, string>;   // kulcs -> ember-olvasható név
}
```

Megőrzés: a **legutóbbi 90 mért nap** (néhány tíz kB), utána a legrégebbi
vödrök automatikusan kiesnek. A vágás **darabszám alapú**, nem a rendszerórához
hasonlítunk: egy elállított óra (NTP-korrekció, kézi dátumváltás, időzóna) így
egyik irányban sem tud valós előzményt törölni, és a tárhely is pontosan
korlátozott.

## Statisztikák

- **Ma / tegnap / utolsó 7 / 30 nap** összesen és célpontonként.
- **Top lista**: mire megy el a legtöbb idő (app és oldal külön is).
- **Napi idősor** egy célpontra (oszlopdiagramhoz).
- **Hét-a-héthez** összevetés: nőtt vagy csökkent az adott célpont ideje.
- **Blokkolt oldalak**: mennyi időt töltöttünk rajtuk a feloldott (szünet)
  időszakokban — ez mutatja, mennyit „nyertünk vissza” a blokkolással.
- **Javaslat** (gépen és Androidon): a felvevő kártya egy sorban megmutatja a
  hét legnagyobb, NEM tiltott idővivőit (legalább fél óra a héten, legfeljebb
  három), egy kattintással tiltva. Tükör, nem ítélet: ami már a listán van, az
  aloldalával együtt kiesik, az „egyéb” gyűjtő is; rejtett listánál ez a sor is
  elmarad. Csak ott van, ahol mérünk, és csak ha a statisztika már megérkezett.
  A döntés egy tiszta függvény (`suggestBlocks`, a Kotlin-tükrével és a
  tesztjével együtt); iPhone-on nincs, mert ott nincs oldalankénti mérés.

## Platformonkénti megvalósítás és őszinte korlátok

| Platform | App-idő | Oldal-idő (aktív fül) | Tétlenség |
|---|---|---|---|
| **macOS** | előtérben lévő app (AppleScript / `lsappinfo`) | aktív fül URL-je AppleScripttel (Safari, Chrome, Edge, Brave, Arc) | `ioreg` HIDIdleTime |
| **Windows** | `GetForegroundWindow` → folyamatnév | UI Automation a címsávból; ha nem megy, ablakcím-heurisztika | `GetLastInputInfo` |
| **Android** | `UsageStatsManager` (a felhasználó adja meg a hozzáférést) | böngésző előtérben + a VPN DNS-lekérései alapján hozzárendelve | képernyő ki/be + `UsageStats` |
| **iOS** | **nem lehetséges** rendszerszinten (sandbox) | nem lehetséges | — |

**macOS**: az aktív fül URL-jéhez az „Automatizálás” engedély kell (egyszeri
rendszer-kérdés böngészőnként). Ha a felhasználó nem adja meg, az app-szintű
mérés akkor is működik, csak az oldal-bontás marad el.

**Windows**: a címsáv kiolvasása UI Automationnel a legtöbb Chromium-alapú
böngészőben működik. Ha nem sikerül, csak app-szintű adat lesz — ezt jelezzük is
a felületen, nem hazudunk pontosságot.

**Android**: az `UsageStatsManager` pontos előtér-időt ad appokra. Oldalakra a
böngészőn belül nincs rendszer-API; a VPN-ben látott DNS-lekéréseket rendeljük
az éppen előtérben lévő böngészőhöz — ez **közelítés**, a felületen így is
jelöljük. Mivel a VPN az egész készülék DNS-forgalmát látja, szigorú szűrés van:
csak akkor rendelünk hozzá nevet, ha **épp böngésző van előtérben**, a
megfigyelés élettartama rövid (8 mp), app-váltáskor eldobjuk, és a CDN /
média / telemetria hosztokat kiszűrjük. Így egy háttérben futó app lekérése nem
jelenik meg „meglátogatott oldalként”.

**iOS**: az Apple nem enged más appok használatának mérésére semmilyen API-t
(a Screen Time / DeviceActivity keretrendszer külön, Apple által engedélyezett
jogosultságot igényel, és szülői felügyeleti célra van). Az iOS app ezért **csak
saját magáról** és a saját blokkolási eseményeiről mutat adatot, a rendszerszintű
mérés nem elérhető. Ezt a felületen egyértelműen kiírjuk.

## Adatvédelem

Ez érzékeny adat. Ezért:

- **Fiók nélkül minden mérés a készüléken marad.** Nincs feltöltés, nincs
  szinkron.
- **Fiókkal bejelentkezve a mérés FELKERÜL a saját fiókkiszolgálódra**, a
  munkamenet-naplóval együtt. Ez nem mellékhatás, hanem két funkció ára: a
  közös napi keret (egy eszközön elhasznált perc a másikon is fogy) és az
  eszközök közötti munkamenet-statisztika máshogy nem működhet.

  Amit a kiszolgáló LÁT: mennyi bájt jött, melyik eszköztől, mikor. Amit NEM
  lát: hogy mit mértél, milyen oldalon, mennyit — a blob végponttól végpontig
  titkosított, és a kulcs sosem hagyja el az eszközeidet. A kiszolgálót
  ráadásul te futtatod (`server/`), legegyszerűbben az asztali appból.

  Ez a szakasz azért van ilyen hosszan kiírva, mert korábban azt állította,
  hogy „nincs feltöltés, nincs szinkron” — ami a v0.4.0 óta nem volt igaz. Egy
  elavult adatvédelmi mondat rosszabb, mint egy hiányzó: a felhasználó arra
  alapoz, és nem tudja meg, hogy már nem áll.
- **Telemetria SEHOL nincs.** Se hozzánk, se harmadik félhez, fiókkal sem.
- A tárolás az adott platform védett, app-privát helyén történik (a desktopon a
  helper root/SYSTEM könyvtárában, mobilon az app-privát tárban).
- A felhasználó **egy gombbal törölheti** az előzményt, és **ki is
  kapcsolhatja** a mérést. Egyik sem próbatételes — ez nem blokkolás-gyengítés,
  hanem a saját adatáról szóló döntés. **Egy kivétel van, és pont ott, ahol a
  mérésnek blokkolási következménye van:** amíg bármelyik oldalon áll napi
  keret, a mérés nem kapcsolható ki, a törlés pedig a MAI napot meghagyja —
  abból fogy a keret, tehát a mai adat törlése ingyen, korlátlanul újratöltené
  (a keret EMELÉSE viszont próbatétel). A régebbi napok ilyenkor is törölhetők,
  keret nélkül pedig minden. A megerősítő kérdés ezt kimondja, hogy a
  megmaradó mai sor ne látsszon hibának.
- Az URL-ekből **csak a domaint** tároljuk (`youtube.com`), a teljes címet, a
  lekérdezési paramétereket és az oldalcímet soha. A domaint a **regisztrálható
  szintre** redukáljuk, így egy oldal nem tud véletlen aldomainekkel korlátlan
  bejegyzést létrehozni.
- A böngésző címsorát kisegítő technológiákon át olvassuk, amik az oldal
  **összes beviteli mezőjét** is látják. Ezért csak **abszolút http(s) URL**-t
  fogadunk el: ha a szonda mást talál (megírt üzenet, keresőmező, bejelentkezési
  űrlap), inkább nem mérünk oldal-bontást, mint hogy a begépelt szöveg tárolásra
  kerüljön. Jelszó- és képernyőn kívüli mezőket eleve átugrunk.

## Megvalósítás állapota

| Platform | Mag | Mérő | Felület |
|---|---|---|---|
| **Desktop (Win/Mac)** | ✅ `shared/usage.ts`, tesztelt | ✅ `main/tracker.ts` (felhasználói munkamenetben) | ✅ statisztika-kártya |
| **Android** | ✅ `core/Usage.kt`, JVM-en parity-tesztelt | ✅ `usage/UsageTracker.kt` (a VPN-szolgáltatásban) | ✅ `ui/StatsScreen.kt` |
| **iOS/macOS** | — | ❌ nem lehetséges (lásd fent) | a felület kiírja, hogy nem elérhető |

A desktop mérő a **GUI folyamatában** fut, mert a root/SYSTEM helper nem látja az
előteret (macOS: nincs Aqua-hozzáférése; Windows: a SYSTEM a 0. munkamenetben
van). Ezért a desktop mérés addig gyűjt, amíg a Breaker fut. Androidon a mérés a
már úgyis futó VPN-szolgáltatásban van, tehát a felület bezárása nem állítja le.

### A puffer korlátai (desktop)

A mért szeletek nem kerülnek azonnal a helperhez: célpont + naptári nap szerint
összevonva 30 másodpercenként megy egy köteg. Ha a küldés nem sikerül, a köteg
visszakerül a pufferbe — a mért idő elvesztése rosszabb, mint a ritka
dupla-számolás. Ennek viszont két határa van:

- **Méret:** a puffer legfeljebb annyi (célpont, nap) rekeszt tart, amennyi
  pontosan egy kérésbe fér (`MAX_BATCH_SAMPLES`). Ez nem véletlen egyezés:
  különben a `take()` többet adna vissza, mint amennyit a helper elfogad, és a
  fölösleg némán lecsonkolódna a túloldalon. Túlcsordulásnál a **legrégebbi**
  rekesz megy először.
- **Kor:** a helper a mostani időtől ±7 napnál távolabbi mintát nem fogad el
  (értelmetlen időbélyeg elleni védelem). Egy ennél régebbi szelet újraküldése
  tehát nem kézbesítés, csak annak látszik — ezért a mérő maga dobja el, és
  naplózza. Ide egy több mint egy hetes, folyamatos helper-kiesés kell.

### Ha a Windows-szonda nem indul el

Az előtér-figyelés Windowson egy hosszú életű PowerShell-gyermekfolyamat. Ha ez
nem tud elindulni, a Node **nem** `exit`, hanem `error`/`close` eseményt küld —
emiatt korábban a „fut már” őr minden újraindítást letiltott, és a mérés némán
megállt a munkamenet hátralévő részére. Az életciklust most egy külön, tesztelt
`ProbeSupervisor` kezeli: minden lezáró esemény oda fut be, az egymás utáni
sikertelen indítások pedig növekvő várakozást kapnak (5s → 15s → 1p → 5p), így
sem beragadni, sem 5 másodpercenként újraéledni nem tud. Egy percnél tovább élt
szonda kilépése nem hiba: utána azonnal újraindulhat.

## Tesztek

- Mintavétel-aggregálás: nap-határ átlépés, tétlenség kihagyása, alvás utáni
  túlszámolás elleni védelem.
- Megőrzés: darabszám-korlát, és se előre, se hátra ugró óra nem töröl adatot.
- Kötegelt (hosszabb kiesés utáni) idő nem csonkul, de egy célpont egy napra
  nem kaphat 24 óránál többet.
- Statisztikák: ma/7/30 nap, top lista, idősor, hét-a-héthez, üres állapot.
- Ellenálló képesség: a privilegizált helper `usage_batch` végpontja validált
  bemenetet vár (kulcs-forma és -hossz, címke-hossz, véges és ±7 napon belüli
  időbélyeg, kötegméret), a kérés-sor mérete korlátozott, és egy nap legfeljebb
  korlátozott számú célpontot tárol — a maradék egy „egyéb” gyűjtőbe kerül, hogy
  az összeg pontos maradjon. Integrációs teszt játssza el a támadást a valódi
  szerver ellen, és igazolja, hogy a mentés utána is működik.
- Puffer: nap-határon nem keveredik, sikertelen küldés után nem vész el, a
  méret- és kor-korlát betartva, túlcsorduláskor a legrégebbi megy először.
- Szonda-felügyelet: egy sikertelen indítás nem tiltja le a további
  próbálkozásokat, az ismételt hiba növekvő várakozást kap, egy egészségesen
  futott szonda kilépése pedig nem számít hibának.

### A mérés két csendes elhasalása

A statisztikában a nulla nem mond semmit magától: lehet, hogy tényleg nem
használtad a gépet, és lehet, hogy a mérés hasalt el. Két külön helyen tud
elhasalni, és a felhasználó **mindkettőből ugyanazt a nullát látja** — a
teendő viszont más, ezért két külön jelzés van rá.

1. **A szonda nem lát semmit.** macOS-en engedély kell hozzá; ha nincs meg,
   az `osascript` hibázik, és minta se készül. Három üres lekérdezés után az
   app szól (`ProbeHealth`) — és KÉT KÜLÖN mondattal, mert a teendő más:

   - **még soha nem működött**: az engedélykérő ablakot elkattintották (vagy
     meg sem jelent), tehát kézzel kell megadni;
   - **korábban működött, most nem**: ez jellemzően FRISSÍTÉS után történik.
     Amíg nincs Apple fejlesztői aláírás, a macOS minden új változatot külön
     appnak lát, és az automatizálási engedélyt újra kell adni. Aki ezt nem
     tudja, csak annyit lát, hogy a mérés elromlott — pedig nem az app hasalt
     el, hanem a rendszer vette vissza az engedélyt. Ez a különbség sokáig ott
     volt az állapotban (`neverWorked`), csak épp senki nem olvasta el.
2. **A szonda lát, de a mért idő nem jut el a tárolóig.** A segéd minden
   mintát ellenőriz — kulcs alakja, hossz, időbélyeg a mai naptól legfeljebb
   egy hétre —, és amit nem fogad el, azt szó nélkül eldobja. A válasz ettől
   még sikeres, benne a ténylegesen rögzítettek számával.

A második sokáig **teljesen néma volt**: a küldés csak azt nézte, megérkezett-e
a kérés, a `recorded` mezőt senki nem olvasta el. Egy csupa eldobott köteg így
sikeres kézbesítésnek látszott, a puffer kiürült, és a mért idő VÉGLEG
elveszett. Következmény: a statisztika örökre nulla, a napi keret pedig sosem
fogy el — vagyis a felület védelmet mutat ott, ahol nincs. Pontosan az, ami
ellen az első figyelmeztetés készült, csak egy réteggel lejjebb, ahol az nem
lát. A `DeliveryHealth` ezt fogja meg: három egymást követő olyan küldés után
szól, amit átvettek, de egyetlen sort sem rögzítettek belőle.

### A harmadik néma eset: a beragadt szonda

A két figyelmeztetés akkor szólal meg, ha a mérés FELISMERI a hibát — az egyik
üres válaszokat számol, a másik eldobott mintákat. Van azonban egy eset, ahol
egyik sem lát semmit, mert nem történik SEMMI.

A mérési kör tart egy „épp fut egy lekérdezés” jelzőt, hogy egy lassú szonda ne
torlódjon fel önmaga mögött. Ez a jelző csak a kör BEFEJEZÉSEKOR törlődik. Ha
tehát a szonda ígérete sosem teljesül, minden későbbi kör azonnal visszafordul:
a mérés a folyamat hátralévő életére leáll — és a szonda-egészség meg sem
szólal, mert az HIBÁT számol, nem elmaradást. A felhasználó csak a nullát látja.

macOS-en ez nem elméleti: az `osascript` megállhat az engedélykérő ablakon. Az
`execFile` saját időkorlátja SIGTERM-et küld, de a visszahívás csak akkor fut
le, ha a folyamat tényleg meg is hal.

Ezért van a lekérdezésnek SAJÁT, a hívón belüli határideje (`withDeadline`).
Ha letelik, a kör „nem láttam semmit”-ként könyveli, és megy tovább — az
elhagyott lekérdezés eredményét eldobjuk. Egy elmaradt minta ára eltörpül
amellett, hogy a mérés csendben leáll.

Ez ugyanaz a hibafajta, mint a szinkron körénél: egy futás-jelző, amit csak a
befejezés töröl, plusz egy művelet, ami sosem fejeződik be.

### A nulla legyen olvasható

A két figyelmeztetés akkor szólal meg, ha az app FEL TUDJA ismerni a hibát. Van
viszont egy harmadik eset, amit senki nem ismer fel: a statisztikán álló nulla
maga. Abból nem derül ki, hogy tényleg nem használtad a gépet, vagy hogy a
mérés valahol elhasalt — és a felhasználó ugyanazt látja mindkettőre.

Ezért a segéd feljegyzi, mikor rögzített UTOLJÁRA mért időt, és a statisztika
ezt ki is írja: „utoljára mért idő: ma 12:41”, vagy dátummal, ha nem ma volt.
Ha fél órája még mértünk, a nulla igaz, és nincs mit keresni. Ha viszont
tegnapi dátum áll ott, az önmagában a válasz.

Két részlet, ami nélkül a mező hazudna:

- csak **elfogadott** minta lépteti. Ha egy eldobott köteg is állítaná, épp az
  ellenkezőjét mondaná: azt, hogy mértünk, pedig semmi nem került be;
- a **legkésőbbi minta** ideje számít, nem a kötegé. Egy köteg percekkel
  korábbi szeleteket is hozhat — a kérdés az, hogy mikor mértünk, nem az, hogy
  mikor ért ide a csomag.

A mező **nem** a szinkronizált mérés-blobban van: ez helyi diagnosztika, nem
adat. A másik eszközödnek semmit nem mondana arról, hogy a te gépeden mikor
mértünk utoljára.

A **kettőt szét kell tartani**. A segéd elérhetetlensége nem adatvesztés: a
puffer megtartja a mintákat, és a következő kör újrapróbálja. Ha azt is
veszteségnek vennénk, a mérés minden zökkenőre riasztana — és a riasztás, ami
gyakran téved, pont annyit ér, mint a csend.

## A mai nap külön

A csempesorban mindig is ott volt egy mai összeg, de hogy MIRE ment el, azt
csak a hétnapos listákból lehetett kihámozni — azokban viszont a hét eleje
elnyomja a mát: egy kétórás hétfői YouTube mellett a mai húsz perc nem
látszik. Ezért a statisztika tetején külön blokk áll: „Mire ment ma az idő”.

Három döntés van benne, mindhárom szándékos:

- **vegyes lista.** Oldal és app együtt, idő szerint — a kérdés az, hogy MA
  mire ment el, a fajta másodlagos. A heti listák maradnak szétszedve, mert
  ott az összevetés a lényeg;
- **üresen eltűnik.** Egy minden reggel ott álló üres doboz nem információ,
  csak zaj. Hogy MIÉRT nulla, azt az „utoljára mért idő” sor mondja meg;
- **ugyanazon a címke-tölcséren megy át**, mint minden más (fedőnév, rejtett
  lista, blokkolt-jelvény) — elég egyetlen kihagyott hely, és a rejtés annyit
  ér, mint egy lyukas zsák.

A mag mindhárom nyelven ugyanazt számolja (`topToday`); iPhone-on — ahol az
app maga nem mér — a fiókkártya összesített blokkja mutatja, minden eszköz
méréséből együtt.

## A hét napjai

A csempe egy számban mondja az elmúlt hét napot; a „hét naponta” blokk a hét
ALAKJÁT mutatja — a hétvégi kiugrást, a szerdai lyukat —, hét oszlopban, a
csempével azonos összeggel (`totalSeries`: minden célpont együtt, naponta).
Néhány szabály, ami nem esztétika:

- **egy szín.** Az oszlop nem kategória, tehát nem kap külön színt; a mai nap
  a feliratával („ma”, félkövér) van kiemelve, nem színnel;
- **szám csak a mai és a legnagyobb oszlopon.** Hét szám hét oszlop fölött
  már táblázat, nem diagram; a többi nap mutatásra mondja a napot, a dátumot
  és az időt;
- **üresen eltűnik** — egy hét mért perc nélkül, vagy egy régebbi segéd, ami
  nem küld ilyen sort, nem üres diagramot ad, hanem semmit.

![A statisztika lap a hét napjaival](images/desktop-stats.png)

## Munkamenetek a statisztikán

Az app azt méri, **mire** megy el az idő. A munkamenet a másik oldal: hányszor
ültél le dolgozni, és hányat vittél végig.

A segéd minden lezárult menetről eltesz egy sort (`FocusLogEntry`), és a
statisztika ebből számol mai és heti összegzést. A napló **helyi marad**, nem
megy fel a kiszolgálóra — ez mérés, nem beállítás, és a mérés eddig sem hagyta
el a gépet.

Két apróság, ami nem apróság:

- **A csomag NEVE is bekerül a sorba**, nem csak az azonosítója. A csomag azóta
  átnevezhető vagy törölhető, és egy statisztika, ami ismeretlen csomagot ír ki
  a múlt hétre, semmit nem ér.
- **A magától lejárt menetnél a TERVEZETT vég kerül be**, nem a takarítás
  pillanata. A `tick` késhet pár másodpercet, és egy „51 perces” ötvenperces
  menet apró, de fölösleges hazugság lenne.

### A „korán leállítva” sor

Ez az a szám, amiből tanulni lehet. Nem szégyenpad: aki látja, hogy ötből
négyszer leállt, az nem a csomagot fogja hibáztatni, hanem rövidebb menetet
indít — és az működni fog. Ezért van kiírva, és ezért van mellé mondat is.

Korai végnek számít a próbatétel utáni **rövidítés** is, nem csak a leállítás:
a menet nem addig tartott, ameddig terveztük. Ha csak a „leállítva” jelzőt
néznénk, a rövidítés láthatatlan maradna — pedig pont ugyanaz a döntés.

### Az előző héthez képest

A blokk mondata az előző hetet is mondja („Az előző héten 5 menet (3 ó 10 p).”),
és a heti mondat a menetek mellett, vesszővel:
„9 menet (7 ó 0 p, 2 korán leállítva), az előző héten 5 (3 ó 10 p).”
Irány, nem ítélet — mint a megakadásoknál. Az előző hét ablaka a mai nap
kezdete előtti tizenharmadik naptól a hatodik nap kezdetéig tart
(`summarizeFocusPrevWeek`, mindhárom magban ugyanaz a határ); üres előző hét
nem összehasonlítás, akkor nincs mondat; a menet nélküli hét viszont mondat,
ha volt mihez mérni: „Menet nélkül, az előző héten 5 (3 ó 10 p).”

### Fókuszban, naponta

A csempe egy számban mondja a hetet („7 ó fókuszban a héten”); a sávok azt,
hogy **egyenletesen jött-e össze, vagy egy napból**. Ugyanaz a rajz, mint a
mért időé fent — egy szín, a mai nap a feliratával kiemelve, szám csak a mai és
a legnagyobb oszlopon —, hogy a két diagram ugyanúgy olvasódjon. Mindhárom
platformon ugyanaz (`focusDaySeries` / `Focus.daySeries`); **iPhone-on ez az
egyetlen diagram**, mert ott csak a menetek adata igazi.

Egy menet a **végének napjára** számít egészben. Nyolc óránál hosszabb menet
nincs; az éjfélen átnyúló ritka, és a lezárás napja az, amire az ember
emlékszik — egy 23:30-tól 0:30-ig tartó menet a második napon áll egy órával,
nem két fél órával. A nap fogalma a mérésével közös: helyi naptár, délben
lépve, hogy az óraátállítás ne ejtsen ki és ne duplázzon napot. Üresen (nulla
menet a héten, és az előző héten sem) a blokk nincs — mint a többi. Ha az
előző héten volt menet, a blokk marad, és kimondja: „A héten nem volt menet.”
— a nulla hét is mondat, ha volt mihez mérni.

## Heti visszatekintés: hétfő reggel egy mondat

A statisztika ott van az appban — de oda be kell menni, és pont az nem megy
be, akinek a legtöbbet mondaná. Hétfő reggel héttől az app egy értesítésben
elmondja az elmúlt hét napot:

> Elmúlt 7 nap: 7 ó 20 p mért idő; a legtöbb: youtube.com 2 ó 40 p (▼ -33%
> az előző héthez képest). 9 menet (7 ó 0 p, 2 korán leállítva). 3 feloldás.
> Nincs tiltva, de sokat vitt: news.ycombinator.com 2 ó 2 p.

A mondat megosztható, ahogy van: a gépen a statisztika naplójában „A mondat
másolása” a vágólapra teszi, Androidon „A mondat megosztása” a rendszer
megosztóját nyitja, iPhone-on ugyanez a megosztás-gomb (`ShareLink`). Egy
megbízottnak, egy naplóba — a tükör a tiéd; hogy kinek mutatod, te döntöd el.
A napló régi sorai maradnak csak nézhetők.

Az utolsó mondat a tükör másik fele — a felvevő kártya javaslatának a
legnagyobbja (l. fentebb): ami sokat vitt, és nincs a listán. Csak mért hét
után, és csak egy név; a többi a kártyán vár, egy kattintásra.

Ha app vitte a legtöbbet — a gépen mondjuk a Slack, a telefonon az Instagram
appja —, az is ott áll a mért idő után, a saját trendjével: „appban a legtöbb:
Slack 3 ó 10 p (▲ +42% az előző héthez képest)”. A mért időben az appok is
benne vannak; enélkül a mondat hazudna („7 óra; a legtöbb: youtube.com 40
perc” — és a többi hova lett?).

Ugyanaz a hang, mint a statisztikáé: a „korán leállítva” nem szégyenpad, a
„Feloldás nélkül.” viszont igenis kimondható — ez a mondat vége, ha egy sem
volt. Ha nincs miről beszélni (se mérés, se menet, se feloldás, se félbemaradt
kísérlet), nincs értesítés: egy üres mondat zaj lenne, nem tükör.

A **félbemaradt kísérletek** is a mondatban vannak, a feloldások mellett —
vagy helyettük: „3 feloldás, 2 félbemaradt kísérlet.” / „Feloldás nélkül, 2
félbemaradt kísérlet.” Félbemaradt az, ami elindult és nem ért végig:
feladva, lejárva (tizennégy óra), lecsúszva az átvételről, elszállva (ötödik
rossz jelmondat), vagy egy új kísérlettel újraindítva. A bíró az egyetlen
helyen könyveli, ahol minden ilyen átmegy (`dropSession`), harminc napig,
mint a feloldásokat (`droppedAttempts` az állapotban, mindhárom magban); a
gépen a próbatétel-nehézség sora is mondja. Nem ítélet: hányszor indult el a
lazítás — és hányszor nem vitte végig az ember. A tükör fele lenne nélküle.

A feloldások mellett az előző hét is ott van, zárójelben — a tükör harmadik
mércéje is két hetet mond: „3 feloldás (az előző héten 5), 2 félbemaradt kísérlet.”
vagy „Feloldás nélkül (az előző héten 5).” Ugyanaz a szabály, mint a
megakadásoknál és a meneteknél: üres előző hét nem összehasonlítás, akkor a
mondat a régi; feloldás nélküli hét viszont mondat, ha az előző héten volt
mihez mérni. A gépi nehézség-sor is mondja („3 feloldás az elmúlt 7 napban
(az előző héten 5)”); a segéd `unlocksPrev7d` mezője a státuszban.

A gépen a **megakadások** is: „12 megakadás a böngészőben.” — hányszor vitt a
tiltó lapra a böngésző-bővítmény az elmúlt 7 napban. A bővítmény könyveli
(`extension/hits.js`: naponként, okonként — zárva oldal, munkamenet, csatorna,
részleges szabály, kulcsszó —, harminc napig, egy navigációt egyszer), a
hídon adja át (`POST /hits`, a kóddal, egy állandó forrás-azonosítóval: két
böngésző két könyv, a segéd összeadja), a segéd tartja
(`shared/browser-hits.ts`, `browserHits` az állapotban, forrásonként). A
statisztika nehézség-sora is mondja („· 12 megakadás a böngészőben”), a
bővítmény felugró lapja és beállítás-lapja pedig a mait és a hetet, naponként.
A híd befelé CSAK ezt fogadja — könyvelést, szabályt soha. Nem szinkronizál:
a gép saját tükre. A tiltó lap is mondja, a kísértés pillanatában: „Ma ez a
7. megakadás — ebből a 3. ezen az oldalon.” (a hosztonkénti könyv csak a gépen
marad; a hídra a napi összeg és a nap öt leggyakoribb hosztja megy — a gépen
belül, a fiókba nem). A gépi statisztika a hét alatt az okokat is
mondja — MELYIK szabály dolgozik: „Ebből: 7 zárva oldal · 3 kulcsszó · 2
munkamenet.” (`browserHitsReasons` a státuszban, a hídon átjött okonkénti
számokból; holtversenynél az okok rögzített sorrendje, hogy a sor ne ugráljon).
A bővítmény beállítás-lapja ugyanezt mondja a saját könyvéből: „A héten: 4
zárva oldal · 3 munkamenet” — app nélkül is. A telefonon ugyanígy: a szűrő
okonként is könyvel (`filterHitReasons`, nap → ok → szám; az ok a szűrő
ítélete: lista vagy kulcsszó — a munkamenet fehérlistáján kívül rekedt
forgalom nem megakadás, ezért oknak sem számít), és a statisztika a hét
sorát mondja: „Ebből: 30 lista · 12 kulcsszó.” Holtversenynél itt is a
rögzített sorrend.

**Melyik kulcsszó dolgozik:** a kulcsszó okánál a fogó szó is a könyvbe
megy — a bővítményben (`byKeyword`, naponta ötven szó; a hídra a nap öt
leggyakoribb szava megy, `topKeywords`) és a telefonon (`filterHitKeywords`,
nap → szó → szám, a lista tételeinek könyvével azonos alak). A gépi
Kulcsszavak kártya a hídról mondja („A héten a legtöbbször fogott: shorts 7 · reels 3.”
— a napi élbolyok összege, alsó becslés, a sorrend igaz), a bővítmény
beállítás-lapja a saját könyvéből, pontosan („Kulcsszavanként a héten: shorts 7 · reels 3”),
a telefon statisztikája a megakadás-blokkban („Kulcsszavanként: tiktok 5.”).
Ami sosem fog, az nem szerepel — tükör a listára: a felesleges szó levétele
próbatétel, de hogy felesleges-e, itt derül ki. A bővítmény beállítás-lapja
ezt ki is mondja („A héten nem fogott: live, stream” — `idleKeywords`), de
csak akkor, ha a héten volt kulcsszó-megakadás: friss könyv mellett minden szó
„nem fogott” lenne, és az nem tény, hanem hiány. A telefon statisztikája
ugyanezt mondja a saját könyvéből (`FilterHitLogic.idleKeywords`, Kotlin és
Swift).

**A hét az előző héthez képest:** a két szám egymás mellett — „A héten 12
megakadás, az előző héten 18.” — a statisztika megakadás-blokkjában
mindhárom platformon, és a heti mondatban a szám mellett, zárójelben: „12
megakadás a böngészőben (az előző héten 18), a csúcs 21–22 óra.” Irány, nem
ítélet: a tükör mutatja, merre megy, és nem minősíti. Előző hét nélkül
(nulla — a könyv talán akkor kezdődött) nincs mondat, mert egy nulla nem
összehasonlítás; a nulla hét viszont mondat, ha volt mihez mérni:
„Megakadás nélkül a böngészőben (az előző héten 18).” Ehhez a bővítmény a
hídra két hetet küld (`REPORT_DAYS`), a segéd cseréli; a telefon könyve
harminc napos, ott eleve megvan. A bővítmény beállítás-lapja ugyanezt a
sort a saját könyvéből mondja (`hitsTrendText`), app nélkül is; a végponti
teszt őrzi, hogy előző hét nélkül a sor nincs, egy régebbi nappal viszont
megjelenik.

**Melyik oldal akaszt meg a legtöbbször:** a hét csúcs-oldala mindhárom
platformon. A gépen a bővítmény napi élbolyából (a segéd a lista tételéhez
rendeli: a `m.youtube.com` és a `www.youtube.com` egy oldal; a napi öt hoszt
összege alsó becslés, a csúcs viszont épp az, ami minden nap az élbolyban
van), a telefonon a szűrő a lista tételével könyvel (`filterHitHosts`, nap →
oldal → szám, ötven oldal naponta, harminc napig). A statisztika mondja („A
legtöbbször: youtube.com (7×).”) és a heti mondat is: „12 megakadás a
böngészőben, a csúcs 21–22 óra, a legtöbbször: youtube.com (7×).” A rejtett
lista és a fedőnév itt is fed. Ami nincs a listán, a nevén marad.

**A csúcs-nap:** melyik napon akad meg a kéz a legtöbbször — négy hétből, a
hét napjaira osztva (négy-négy nap mindegyikre; a hét egy napja egyszer nem
minta): „A négy hét csúcs-napja: vasárnap (14 megakadás).” A gépi statisztikán
(`browserHitsByWeekday`/`peakWeekday`, a segéd adja le a státuszban), a
telefonokon (`FilterHitLogic.byWeekday`/`peakWeekday`) és a bővítmény
beállítás-lapján a saját könyvből (`hitsByWeekday`). Holtversenynél a hét
elejéhez közelebbi nap (hétfőtől); a minta hossza a három magban azonos
(core-sync). Tény, nem ítélet. A heti mondat is mondja, a megakadások mondata
után, szó szerint (`browserHitsWeekday`/`filterHitsWeekday` a mondat bemenetén
— a segéd, az Android és az iOS építi); nap nélkül nincs mondat.

**A csúcs-nap ott is, ahol a kísértés van:** a csúcs-napon a tiltó lap és a
felugró lap a saját könyvből (`peakDayNow`/`peakDayNowText`), a gépi kezdőlap
javaslat-kártyája és a gyorsbillentyűs réteg lába a státusz csúcs-napjából
(`isPeakDayNow`/`peakDayNowText`), a két telefon kezdőlapjának javaslat-kártyája
(`FilterHitLogic.isPeakDayNow`) kimondja, hogy ma van:
„Ma a négy hét csúcs-napja van (vasárnap, 14 megakadás) — ezen a napon akad meg a kéz a legtöbbször.”
Csak elég mintából: a csúcs-nap alatt legalább három megakadás
(`PEAK_DAY_MIN_COUNT`, a három magban azonos — core-sync); egy-két megakadás
négy hétből nem minta, csak zaj. A csúcs-óra mondata mellett, nem helyette;
a kártyán a menet gombja ugyanúgy ott van; az Android szűrő-értesítésének
sora is mondja („· ma a csúcs-nap”). Tény, nem ítélet.

**A hét napjainak sávja:** a csúcs-nap mondata alatt hét rekesz hétfőtől
vasárnapig a négy hét megakadásaival, a csúcs-nap kiemelve, a napok
tengelyével (H · K · Sze · Cs · P · Szo · V) — a gépi statisztikán
(`browserHitsWeekdays` a státuszban, `renderWeekdayStrip`), a bővítmény
beállítás-lapján (`hitsByWeekday`), Androidon és iPhone-on (`WeekdayStrip` a
`FilterHitLogic.byWeekday` sorából). A csúcs a mondat, a sáv az alakja: melyik
napon jár a kéz magától, és melyiken nem. Csúcs nélkül nincs sáv.

**A menet-nap:** a tükör másik fele — nem az, mikor csúszik a kéz, hanem az,
mikor ülsz le: négy hétből, a hét napjaira osztva, a menet a végének napjára
számít („A négy hét menet-napja: kedd (6 menet).”), alatta a hét napjainak
sávja, a menet-nap kiemelve. A gépi statisztika munkamenet-blokkjában
(`focusByWeekday` a segédnél, `focusWeekdays` a statisztika-válaszban),
Androidon és iPhone-on (`Focus.byWeekday`); a holtverseny és a minta hossza a
csúcs-napéval közös (`peakWeekday`, `PEAK_WEEKDAY_DAYS`). Menet nélkül nincs.
A heti mondat is mondja, a menetek mondata után, szó szerint (`focusWeekday` a
mondat bemenetén — a segéd, az Android és az iOS építi); nap nélkül nincs
mondat. A menet-napon a döntés helye is mondja: a gépi kezdőlap
javaslat-kártyája és a gyorsbillentyűs réteg lába (`focusDayNowText` a státusz
menet-napjából, `focusWeekday`), a két telefon kezdőlapjának javaslat-kártyája
(`Focus.dayNowText`): „Ma a négy hét menet-napja van (kedd, 6 menet) — ilyenkor szoktál leülni.”
— a menet gombjával; a „ma van” küszöbe a csúcs-napé (`isPeakDayNow`,
legalább három menet). A böngésző lapjai is: a híd a javaslattal leadja
(`suggest.focusDay`, az app szabálya szerint), a felugró lap és a tiltó lap a
menet gombja mellett mondja („Ma a menet-napod van — ilyenkor szoktál leülni.”),
frissen, összekötve.

**A menet-óra:** mikor ülsz le a legtöbbször — a négy hét menetei a nap
huszonnégy órájára osztva, az indulás órája szerint („A négy hét menet-órája:
9–10 óra (6 menet).”), alatta az órák sávja a menet-órával kiemelve; a
megakadások csúcs-órájának tükre (négy hétből, mert egy hét kilenc menete
kevés az órához; holtversenynél a korábbi óra). A gépi statisztika
munkamenet-blokkjában (`focusByHour`/`peakFocusHour` a segédnél, `focusHours`
a statisztika-válaszban), Androidon és iPhone-on (`Focus.byHour`). Menet
nélkül nincs. A heti mondat is mondja, a menet-nap mondata után, szó szerint
(`focusHour` a mondat bemenetén — a segéd, az Android és az iOS építi).
Alatta a csúcs-óra gombjának párja: „Heti ablak a menet-órára: Nyelvtanulás, minden nap 9:00–10:00”
— heti ablak a legutóbbi csomagra a menet-órában, minden nap: a menet magától
indul, amikor le szoktál ülni. Felvenni ingyen; ugyanazok a kapuk, mint a
csúcs-óra gombjánál (`peakWindowPick` a menet-órával), és ha a menet-óra a
csúcs-óra, ott a másik gomb — kétszer ugyanazt nem. Mindhárom platformon.

**A mért idő napja:** a tükör harmadik fele — nem az, mikor csúszik a kéz,
és nem az, mikor ülsz le, hanem az, melyik napon megy el a legtöbb idő: négy
hétből, a hét napjaira osztva, négy-négy nap átlagával („A négy hét legnagyobb
napja: szombat (átlag 3 ó 20 p).”), alatta a hét napjainak sávja, a nap
kiemelve. A gépi statisztikán a hét rajza alatt (`usageByWeekday` a segédnél,
`usageWeekdays` a statisztika-válaszban) és Androidon (`UsageLogic.byWeekday`);
iPhone-on nincs mérés, ott nincs. A minta hossza és a holtverseny szabálya a
csúcs-napéval közös. Mérés nélkül nincs. A heti mondat is mondja, a mért idő
mondata után, szó szerint (`usageWeekday` a mondat bemenetén — a segéd és az
Android építi; a Swift bemenet tükör, üresen); mérés vagy nap nélkül nincs.

**Ablak a csúcs-órára:** a statisztika a csúcs-óra mondata alatt — a gépen
és a telefonokon is — egy gombot mutat — „Heti ablak a csúcs-órára: Nyelvtanulás, minden nap 21:00–22:00” —,
ami a legutóbb használt csomagra heti ablakot tesz a csúcs egy órájában,
minden napra (`peakWindowBand` a három magban; a gépen a csomag
ablak-szerkesztőjének útján, a telefonon a bíró `addFocusWindow` hívásával —
mindkét helyen a bíró dönt): a menet magától indul, amikor a kéz magától
indulna — minden eszközön, mert az ablak a fiókkal utazik. Felvenni ingyen
(szigorítás); levenni vagy szűkíteni próbatétel, mint minden ablakot — a gomb
ezt nem rejti. Nincs gomb ablakos csomagon, futó menet mellett, csomag vagy
csúcs nélkül. A telefon CSAK felvesz: ablakos csomagra ott nincs gomb,
cserélni és levenni a gépen lehet, próbatétellel. Ez az első
csomag-szerkesztés a telefonon, ezért a telefon a csomag JELÉT is írja a
léptetésben (`SyncRevisions.bumpFocus`, a gépi `markPacks` tükre; az első
léptetés jel nélkül megy) — különben a gép egy ugyanabban a körben tett
szerkesztése a fésülésben csendben letörölné az ablakot. A bővítmény felugró
lapján és tiltó lapján is ott a gomb: a híd a javaslattal leadja a csúcs-órát
(`suggest.peakHour`, csak ha ablak tehető rá), és a `POST /focus_window`
felteszi — csak felvétel, ablakos csomagra a híd nemet mond, mert a csere
lazíthat, és arról a bíró próbatételt kezdene, amit a híd nem indíthat el.
Ha a csúcs-órát már fedi egy ablak, a híd a fedő csomag nevét adja le
(`suggest.peakPack`), és a felugró lap a csúcs mondata után kimondja:
„A csúcs-órában magától indul: Nyelvtanulás.” A heti mondat pedig azt is
kimondja, ha a csúcs-órát semmi nem fedi, pedig lehetne — „12 megakadás a
böngészőben, a csúcs 21–22 óra (nincs rá ablak)” —, mindhárom platformon
(`peakWindowOffer` a heti mondat bemenetén, a `peakWindowPick`-ből, a menet
állapota nélkül); a fedés erősebb: akkor a „magától indul” áll.
És a javaslat kártyájáról is — a gépen és a telefonokon —: a sokadik
megakadás, az előjelzés vagy a csúcs-óra mondata alatt a menet gombja mellett
ott az ablaké, ugyanazokkal a kapukkal (a gépen `peakWindowPick`, a
statisztika gombjával közös út). Ha egy csomag
heti ablaka már fedi a csúcs-órát (legalább egy napon az óra egy részét is
átfogja, `packCoveringHour`), a gomb helyett a sor mondja — mindhárom
platformon: „A csúcs-órában magától indul: Nyelvtanulás (minden nap
21:00–22:00).” A menet ilyenkor magától indul, amikor a kéz indulna; nincs
mit felvenni. A heti mondat is mondja, a csúcs mellett: „12 megakadás a
böngészőben, a csúcs 21–22 óra (magától indul: Nyelvtanulás).” — a
telefonokon ugyanígy.

**Mikor jár a kéz magától:** a bővítmény óránként is könyvel (a nap
huszonnégy rekesze), a beállítás-lapja a hét csúcs-óráját mondja és egy
óra-sávot rajzol; a hídon a rekeszek is átmennek, és a gépi statisztika a
megakadások hete alatt mondja: „A hét csúcsa: 21–22 óra (7 megakadás) —
akkor jár a kéz magától.” Tény, nem ítélet. A telefonon ugyanígy: a szűrő
óránként is könyvel (`filterHitHours`, nap → 24 rekesz), a statisztika a
megakadások hete alatt mondja a csúcs-órát, és a heti mondat is: „12
megakadás a szűrőben, a csúcs 21–22 óra.”

**A megakadások harminc napja:** a könyv harminc napot tart, a statisztika a
hét alakja mellett a hónapét is rajzolja (`browserHitsMonth` a státuszban;
a telefonon a szűrő könyvéből, `daySeries(…, 30)`) — de csak akkor, ha a hét
előtti napokon is volt megakadás (`monthHasOlderHits`): különben ugyanazt a
hét oszlopot mutatná, szélesebben. Egy szín, a két szélső nap felirata alul,
mint a mért idő napi rajzánál. A bővítmény beállítás-lapja is rajzolja a saját
könyvéből, ugyanazzal a szabállyal, és a mondata a harminc nap számát is
mondja, ha több a hétnél („…az elmúlt 7 napban 12, 30 napban 40.”).

**Az órák sávja:** a csúcs egy szám, a sáv az alakja. A gépi statisztika a
csúcs-óra mondata alatt a nap huszonnégy rekeszét rajzolja a hét
megakadásaival (`browserHitsHours` a státuszban, minden forrásból összeadva),
a csúcs kiemelve, a többi halványan — ugyanaz a sáv, mint a bővítmény
beállítás-lapján, ugyanabban a mértékben (a csúcs a teljes magasság). A
telefonon ugyanígy, a szűrő könyvéből (`FilterHitLogic.byHour`, Kotlin és
Swift). Csúcs nélkül nincs sáv: az üres rajz nem mond semmit. Egy szín — a
rekesz nem kategória —, és nincs rajta szám: a csúcs mondata mondja a
számot, a sáv azt mutatja, mikor nem jár a kéz. A sáv alatt óra-tengely
(0 · 6 · 12 · 18 · 24), hogy a rekeszeket órára lehessen olvasni — a gépen, a
bővítmény beállítás-lapján és a telefonokon is.

**A csúcs-óra ott is, ahol a kísértés van:** a tiltó lap a csúcs-órában
kimondja („Most a hét csúcs-órája van (21–22 óra, 6 megakadás a héten) —
ilyenkor jár a kéz magától.”), a felugró lap a hetet, jelöléssel, ha most van
(„A hét csúcsa: 21–22 óra (6 megakadás) — most.”), a gyorsbillentyűs réteg
lába a csúcs-órában ugyanazt, és a telefon kezdőlapjának javaslat-kártyája is
— a menet gombjával, mint az előjelzésnél. Tükör a pillanatban, nem ítélet; a
csúcs-órán kívül egyik sem szól róla (a felugró lap csak a hetet mondja).

**A javaslat kártyája a gépi kezdőlapon is:** amit az értesítés mond — a
sokadik megakadás, az előjelzés tíz perccel a csúcs-óra előtt, a csúcs-órában
a tükör —, a kezdőlap is mondja, egy gombbal a legutóbbi csomagra
(„Munkamenet: Nyelvtanulás, 25 perc”), mint a telefonokon. Az értesítés
kikapcsolható, a kártya nem: nem szól, csak ott van. Futó menet mellett nincs
gomb; üresen nincs kártya. Az Android szűrő-értesítés sora a csúcs-órában azt
is mondja: „· most a csúcs-óra”.

A **sokadik megakadásnál** a gép egy lépést javasol: az ötödik, tizedik és
huszadik mai megakadásnál egyszer szól („Ma már 5 megakadás a böngészőben.
Egy munkamenet vagy egy rövid zárlat most segítene — te döntesz.”), és a
tiltó lap az ötödiktől ugyanezt teszi hozzá a sorához. Nem tilt, nem ítél —
a döntés az emberé. A heti mondat a csúcs-órát is mondja: „12 megakadás a
böngészőben, a csúcs 21–22 óra.” A gépi statisztika megakadás-blokkja a
sokadik megakadásnál a mondatot és egy gombot is mutat — „Munkamenet:
Nyelvtanulás, 25 perc” —, a legutóbb használt csomagot a szokásos hosszával
(a segéd választja, `lastUsedPackId` a statisztika-válaszban; napló nélkül az
elsőt): egy kattintás a mondattól a menetig, mint a telefonon. Futó menet
mellett nincs gomb. A gépi értesítés is kattintható: a sokadik megakadásé és
az előjelzésé a mondat végén megmondja, mi indul („Kattints, és indul: Nyelvtanulás, 25 perc.”),
a kattintás indítja, és egy második értesítés visszaszól, hogy elindult; futó
menet mellett nincs ígéret és nincs indítás. Androidon ugyanez gombbal: a
sokadik megakadás és az előjelzés értesítésén „Munkamenet: Nyelvtanulás, 25 perc”
(`FocusStartReceiver`, a bíró indítja, egy rövid üzenet mondja, hogy
elindult; futó menet vagy csomag nélkül nincs gomb). iPhone-on az előjelzés
értesítésén „Munkamenet indítása” (`NoticeActions`, a kategória csak akkor
kerül rá, ha van csomag; a gomb az appot is előhozza). A gyorsbillentyűs rétegben ugyanez: a legutóbb használt
csomag sorában egy gomb a szokásos hosszal (a választó nélkül), és a láb a
sokadik megakadásnál a mondatot is mondja — a réteg a kísértés pillanatáé.

A telefon ugyanígy javasol: Androidon a szolgáltatás az ötödik, tizedik és
huszadik mai megakadásnál egyszer értesít („Ma már 5 megakadás a szűrőben…”,
saját csatornán, hogy külön lehessen elnémítani), és a kezdőlap egy kártyán
mondja a mondatot; iPhone-on a tunnel nem értesít — a kezdőlap mondja, amíg
nyitva van. A lépcsők (5, 10, 20) a három magban azonosak (`check-core-sync`).

A telefon kártyáján egy gomb is van — „Munkamenet: Nyelvtanulás, 25 perc” —,
amely a legutóbb használt csomagot indítja a szokásos hosszával (napló nélkül
az elsőt; `Focus.lastUsedPack`, mindkét magban tesztelve): egy koppintás a
mondattól a menetig, szigorítás ingyen. Futó menet mellett nincs gomb
(egyszerre egy menet fut), csomag nélkül sincs — a mondat akkor is ott van.

**Előjelzés a csúcs-óra előtt:** tíz perccel a hét csúcs-órája előtt egyszer
szól a gép (amíg fut), Androidon a szolgáltatás (a megakadások csatornáján),
iPhone-on a rendszer (az app ütemezi, amikor nyitva van; a csúcs változásakor
átütemezi, csúcs nélkül visszavonja — `App/PeakReminder.swift`): „Mindjárt 21
óra…” — a héten ilyenkor akadt meg a kéz a legtöbbször, egy munkamenet most
segítene, te döntesz. Csak ha a csúcs legalább három; naponta egyszer (a
nulla órás csúcs ablaka az előző estén van). Tükör időzítéssel — nem tilt,
nem ítél. A tíz perc és a három a három magban azonos (`check-core-sync`).
A telefon kezdőlapján a javaslat kártyája ugyanebben a tíz percben az
előjelzés mondatát is mondja — a munkamenet gombjával együtt.

**A könyv törölhető.** A megakadások könyve a tiéd: a bővítmény
beállítás-lapján „A könyv törlése” (egy kérdés után) a számokat, az órákat,
az oldalakat és a kulcsszavakat is elengedi, és egy üres jelentést küld az
appnak — a híd leveszi a forrást, az app is felejt; app nélkül a gép marad,
ahogy volt, a következő jelentés rendezi. A telefon statisztikáján ugyanez
két koppintás („A könyv törlése”, majd „Biztos? Törlés”), és minden könyv
megy: napok, órák, oldalak, okok, kulcsszavak. A menetek naplója és a heti
napló marad — az más könyv.

**Futó menet mellett nincs javaslat.** A sokadik megakadás és az előjelzés
értesítése hallgat, amíg egy menet tart — a lépés, amit ajánlanánk, már
megvan, a figyelmeztetés zaj lenne. A gépen és Androidon a küldés előtt
nézi; iPhone-on az ütemezett kérést a menet indulásakor visszavonja, a végén
újra ütemezi. A kártya a lapon ettől még mondja a számot.

**Ha nem kéred, csendben marad.** Az értesítés a sokadik megakadásnál és a
csúcs-óra előtt kikapcsolható: a gépen a háttér-panel kapcsolójával (a tárban
marad), Androidon és iPhone-on a statisztika megakadás-blokkjának
kapcsolójával (`quietSuggestions` az állapotban, helyi — nem szinkronizál).
A kártya a lapon és a statisztika sora akkor is mondja: a tükör marad, csak
nem szól utánad.

A **hét alakja a megakadásokra** is megvan mindhárom statisztikán — ugyanaz
a rajz, mint a mért időé és a meneteké, csak darabban: a gépen a böngésző
könyve (`browserHitsDays` az állapotban, a források összeadva), a telefonon
a szűrőé (`FilterHitLogic.daySeries`). Üresen nincs — kivéve, ha az előző
héten volt megakadás: akkor a blokk marad, üres oszlopokkal, és a sor mondja a
két számot. A nulla hét is mondat, ha volt mihez mérni.

A gyorsbillentyűs réteg lába is mondja a mait (a futó menet alatt: „Ma 3
megakadás a böngészőben.”), és Androidon a szűrő értesítésének sora („· Ma 3
megakadás”) — ott, ahol a kísértés van, ítélet nélkül.

A telefonon **a szűrő számol**: „12 megakadás a szűrőben.” — a tiltott
DNS-lekérdezés ugyanaz a pillanat, a kéz odanyúlt, a szűrő megállította. Egy
hosztnevet két percen belül egyszer (egy oldalbetöltés tucatnyi lekérdezés,
és a böngésző újra is próbálja), és csak a lista és a kulcsszó tiltását: a munkamenet
fehérlistáján kívül rekedt háttér-forgalom (követők, CDN-ek, más appok) nem a
kéz mozdulata — így számolva egy csendes óra százat mondana. Naponként egy
szám, harminc napig
(`core/FilterHits.kt` és `Shared/FilterHits.swift`, `filterHits` az
állapotban; Androidon a szűrő szolgáltatása, iPhone-on a tunnel könyvel). A
statisztika nehézség-sora és a heti mondat mondja; a fiókba nem megy.

Szabályok, kimondva:

- **Egy hétről egyszer, eszközönként.** A hét kulcsa (a hétfő dátuma) a
  gépen a felület tárában, a telefonon az állapotban marad; a következő
  hétfőn újra esedékes. Szándékosan nem szinkronizál: a gép és a telefon
  más-más hetet mért, mindkettő a magáét mondja.
- **A gépen csak amíg az app fut.** A háttérben ülő védelem magától nem tud
  értesíteni; ez ugyanaz a korlát, mint az adag-értesítésnél. Ha hétfőn nem
  futott az app, az első megnyitáskor szól — még azon a héten; a következő
  hétfőn már a következőről. Engedély híján csendben marad, és a hetet sem
  könyveli el.
- **Androidon a szűrő szolgáltatása mondja**, ami az app nélkül is fut: ott
  tényleg hétfő reggel jön, saját, külön kikapcsolható csatornán („Heti
  visszatekintés”). A mag ugyanaz (`core/Digest.kt`, a gépi tükre, ugyanazokkal
  a tesztekkel), a mondat is. A rejtést itt a beállítás dönti, nem a felület
  pillanatnyi felfedése: az értesítés a zárolt képernyőn is ott van.
- **iPhone-on értesítés nincs.** A tunnel-bővítmény nem adhat értesítést, az
  app nem fut a háttérben, előre ütemezni pedig csak olyan mondatot lehetne,
  ami a hét végére elavul — inkább nincs, mint hogy hamis legyen. Ami van: az
  élő mondat a statisztikán és a heti napló (l. lent) — a hét sora akkor
  íródik, amikor az app azon a héten először nyitva van hétfő reggel hét után;
  mérés híján a menetekről és a feloldásokról szól, ami a telefonon igazi. A
  mag a Swift-tükör (`Shared/Digest.swift`), ugyanazokkal a tesztekkel.
- **Gördülő hét nap**, nem naptári hét — pontosan az, amit a statisztika
  csempéi is mutatnak. A felirat „elmúlt 7 nap”-ot mond, nem „múlt hét”-et.
- **A címkék a statisztika szabályát követik**: rejtett listánál sorszám,
  fedőnévnél a fedőnév. Az értesítés sem szivárogtathat ki olyan címet, amit
  a lista elrejt.

A mag tiszta (`desktop/src/shared/digest.ts` és a tükre, `core/Digest.kt`: a
hét kulcsa, az esedékesség, a szöveg); a gépen a felület a statisztika minden
frissítése után kérdezi meg, a telefonon a szűrő köre percenként.

### Heti napló: a mondat megmarad

A hétfői mondat elszáll az értesítéssel; a napló megtartja. A statisztika
alján (gépen) vagy a menet-blokk alatt (a telefonokon) egy **Heti napló** blokk:
fölül az, ami *most* szólna — „Így szólna a visszatekintés most: …”, ugyanaz a
mag, ugyanazokból az adatokból, bármelyik napon —, alatta a korábbi hétfők
egy-egy sorban, a legfrissebb elöl, fél évig (`MAX_DIGEST_LOG`). A pálya
látszik, nem csak a pillanat — tükör, nem ítélet.

- **Eszközönként**, mint a hét kulcsa: a gép a saját hetét mondja, a
  telefonok a magukét (`digestLog` az állapotban). Szándékosan nem
  szinkronizál. **A sort az írja, ami mindig fut:** a gépen a segéd a körében
  (`helper/digest-journal.ts` — az app nélkül is, a beállítás címkézésével),
  Androidon a szűrő szolgáltatása, iPhone-on az app köre (a megnyitáskor —
  és hétfő reggel egy rendszer-ütemezett emlékeztető hív oda, a mondat
  nélkül: az app a háttérben nem fut). A gépen a hétfői értesítés továbbra is a futó appé; a napló
  nem értesítés, hanem könyvelés.
- **Hetenként egy sor**, az újabb felülír; az üres hét (amiről nem volt mit
  mondani) nem sor, és a hét régi sorát is elviszi. A tárból jött naplót a
  mag tisztítja (`cleanDigestLog` / `DigestLogic.clean`): ami nem sor, az
  nem sor.
- **A címkék** itt is a statisztika szabályát követik — és visszamenőleg is:
  a régi sor a MOSTANI címkézéssel jelenik meg (`relabelDigest` /
  `DigestLogic.relabel`): ami akkor a valódi címmel szólt, az a fedőnév
  felvétele vagy a lista elrejtése után is a lista címkéjével áll ott, a
  társneveivel és az aloldalaival együtt. A napló sem szivárogtathat ki olyan
  címet, amit a lista elrejt.
- Üresen (se sor, se mondat) a blokk nincs — mint a többi.
