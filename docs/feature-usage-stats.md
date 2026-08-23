# Funkcióterv: aktív idő mérése + statisztikák

> Állapot: tervezés + implementáció folyamatban. A közös mag (TypeScript) a
> referencia, a Kotlin/Swift tükör követi.

## Mit old meg

Mérje, hogy **melyik weboldalon és melyik appban mennyi időt töltünk** — de
**csak azt az időt**, amikor ténylegesen ott vagyunk, nem azt, hogy meddig van
megnyitva. Egy háttérben nyitva felejtett YouTube-fül nem gyűjthet órákat.

## Az „aktív idő" definíciója

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

Napi „vödrökbe" (bucket) aggregálunk, célpont-kulcsonként másodpercben:

```ts
type TargetKind = 'app' | 'site';
// kulcs: "app:<azonosító>" vagy "site:<domain>"
interface UsageDay { day: string; /* YYYY-MM-DD helyi idő */ seconds: Record<string, number> }
interface UsageState {
  days: UsageDay[];                 // időrendben, RETENTION_DAYS-re vágva
  labels: Record<string, string>;   // kulcs -> ember-olvasható név
}
```

Megőrzés: **90 nap** (ez néhány tíz kB), utána a régi napok automatikusan
kiesnek.

## Statisztikák

- **Ma / tegnap / utolsó 7 / 30 nap** összesen és célpontonként.
- **Top lista**: mire megy el a legtöbb idő (app és oldal külön is).
- **Napi idősor** egy célpontra (oszlopdiagramhoz).
- **Hét-a-héthez** összevetés: nőtt vagy csökkent az adott célpont ideje.
- **Blokkolt oldalak**: mennyi időt töltöttünk rajtuk a feloldott (szünet)
  időszakokban — ez mutatja, mennyit „nyertünk vissza" a blokkolással.

## Platformonkénti megvalósítás és őszinte korlátok

| Platform | App-idő | Oldal-idő (aktív fül) | Tétlenség |
|---|---|---|---|
| **macOS** | előtérben lévő app (AppleScript / `lsappinfo`) | aktív fül URL-je AppleScripttel (Safari, Chrome, Edge, Brave, Arc) | `ioreg` HIDIdleTime |
| **Windows** | `GetForegroundWindow` → folyamatnév | UI Automation a címsávból; ha nem megy, ablakcím-heurisztika | `GetLastInputInfo` |
| **Android** | `UsageStatsManager` (a felhasználó adja meg a hozzáférést) | böngésző előtérben + a VPN DNS-lekérései alapján hozzárendelve | képernyő ki/be + `UsageStats` |
| **iOS** | **nem lehetséges** rendszerszinten (sandbox) | nem lehetséges | — |

**macOS**: az aktív fül URL-jéhez az „Automatizálás" engedély kell (egyszeri
rendszer-kérdés böngészőnként). Ha a felhasználó nem adja meg, az app-szintű
mérés akkor is működik, csak az oldal-bontás marad el.

**Windows**: a címsáv kiolvasása UI Automationnel a legtöbb Chromium-alapú
böngészőben működik. Ha nem sikerül, csak app-szintű adat lesz — ezt jelezzük is
a felületen, nem hazudunk pontosságot.

**Android**: az `UsageStatsManager` pontos előtér-időt ad appokra. Oldalakra a
böngészőn belül nincs rendszer-API; a VPN-ben látott DNS-lekéréseket rendeljük
az éppen előtérben lévő böngészőhöz — ez **közelítés**, a felületen így is
jelöljük.

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
  lekérdezési paramétereket és az oldalcímet soha.

## Tesztek

- Mintavétel-aggregálás: nap-határ átlépés, tétlenség kihagyása, alvás utáni
  túlszámolás elleni védelem.
- Megőrzés: 90 napon túli vödrök kiesnek.
- Statisztikák: ma/7/30 nap, top lista, idősor, hét-a-héthez, üres állapot.
