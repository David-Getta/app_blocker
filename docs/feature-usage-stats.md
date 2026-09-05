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
- A felhasználó **egy gombbal törölheti** a teljes előzményt, és **ki is
  kapcsolhatja** a mérést. A mérés kikapcsolása nem próbatételes — ez nem
  blokkolás-gyengítés, hanem a saját adatáról szóló döntés.
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

## Heti visszatekintés: hétfő reggel egy mondat

A statisztika ott van az appban — de oda be kell menni, és pont az nem megy
be, akinek a legtöbbet mondaná. Hétfő reggel héttől az app egy értesítésben
elmondja az elmúlt hét napot:

> Elmúlt 7 nap: 7 ó 20 p mért idő; a legtöbb: youtube.com 2 ó 40 p (▼ -33%
> az előző héthez képest). 9 menet (7 ó 0 p, 2 korán leállítva). 3 feloldás.

Ugyanaz a hang, mint a statisztikáé: a „korán leállítva” nem szégyenpad, a
„Feloldás nélkül.” viszont igenis kimondható — ez a mondat vége, ha egy sem
volt. Ha nincs miről beszélni (se mérés, se menet, se feloldás), nincs
értesítés: egy üres mondat zaj lenne, nem tükör.

Szabályok, kimondva:

- **Egy hétről egyszer, gépenként.** A hét kulcsa (a hétfő dátuma) a felület
  tárában marad; a következő hétfőn újra esedékes.
- **Ha hétfőn nem futott az app**, az első megnyitáskor szól — még azon a
  héten. A következő hétfőn már a következőről.
- **Csak amíg az app fut.** A háttérben ülő védelem magától nem tud
  értesíteni; ez ugyanaz a korlát, mint az adag-értesítésnél. Engedély
  híján csendben marad, és a hetet sem könyveli el.
- **Gördülő hét nap**, nem naptári hét — pontosan az, amit a statisztika
  csempéi is mutatnak. A felirat „elmúlt 7 nap”-ot mond, nem „múlt hét”-et.
- **A címkék a statisztika szabályát követik**: rejtett listánál sorszám,
  fedőnévnél a fedőnév. Az értesítés sem szivárogtathat ki olyan címet, amit
  a lista elrejt.

A mag tiszta (`desktop/src/shared/digest.ts`: a hét kulcsa, az esedékesség,
a szöveg), a felület a statisztika minden frissítése után kérdezi meg.
