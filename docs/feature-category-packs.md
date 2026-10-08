# Kategória-csomagok: egy kattintással több oldal

A blokklista oldalanként épül, és az első percekben ez lassú: aki a közösségi
médiát akarja kizárni, annak nyolc címet kellene egyenként beírnia — és a
harmadiknál eszébe jut, hogy majd holnap. A kategória-csomag ezt veszi le
róla: *Közösségi*, *Videó és stream*, *Hírek*, *Vásárlás*, *Szerencsejáték* —
egy-egy gomb, ami a csomag minden oldalát felveszi.

## Szabály

- **Felvenni ingyen van**, mert szigorítás — a csomag is. Levenni oldalanként
  lehet, a szokásos próbatétellel: a csomag nem „egység”, amit egyben le
  lehetne venni, csak egy gyors út a felvételhez.
- Ami már fent van, **nem számít bele**: a gomb azt mondja, hány oldal
  hiányzik még a csomagból; ha egy sem, a gomb nem aktív („mind fent”).
- A társoldalakat (mobilos, rövidített címek) a felvétel ugyanúgy bővíti,
  mint az egyenkénti felvételnél — a *társoldalak blokkolása* kapcsoló szerint.
- Rejtett listánál a csomag-gombok is elmaradnak, a gyorsgombokkal együtt:
  pont azok a címek állnának rajtuk, amiket az ember tipikusan blokkol.

## A Szerencsejáték-csomag

A hazai engedélyes oldalak (a Szerencsejáték Zrt. oldala és a Tippmix, az
engedélyes online kaszinók) és három nagy nemzetközi név. **Nem teljes
lista**, és nem is lehet az: a szerencsejáték-oldalak száma nagy, a címeik
változnak, és a tiltólistás külföldi oldalak tükörcímeken is futnak. A csomag
a leggyakoribb belépőket zárja le egy kattintással; ami hiányzik, azt
egyenként kell felvenni — és egy kulcsszó (`casino`, `kaszino`) a böngészőben
a címben és a lap címsorában is fogja (`docs/feature-keywords.md`). Aki a
szerencsejátéktól komolyan el akar szakadni, annak a szolgáltatónál kérhető
önkizárás erősebb eszköz: az a fióknál zár, nem az eszközön — a kettő együtt
a legjobb.

## Hol van

Mindhárom platformon a felvevő kártyán, a gyorsgombok alatt. A gépen a gomb
föléhúzva a csomag oldalait is mutatja.

## Belül

A lista a három magban ugyanaz (`CATEGORY_PACKS` a `blocklist.ts`-ben,
`Blocklist.CATEGORY_PACKS` Kotlinban, `Blocklist.categoryPacks` Swiftben). A
gép tesztje írja a `fixtures/category-packs.json`-t (`UPDATE_PACKS_FIXTURE=1
npm test`), a telefonok tesztjei ehhez mérik a saját listájukat — egy elcsúszott
domain vagy sorrend nem marad észrevétlen. Minden domain a `normalizeDomain`
tiszta alakjában áll, és egyetlen csomagban szerepel.
