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

- **Minden mérés a készüléken marad.** Nincs feltöltés, nincs szinkron, nincs
  telemetria.
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
van). Ezért a desktop mérés addig gyűjt, amíg a Lakat fut. Androidon a mérés a
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
