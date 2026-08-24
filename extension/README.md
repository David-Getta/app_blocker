# Breaker — részleges tiltás (böngésző-bővítmény)

Nem az egész oldalt, csak egy darabját: például a YouTube-on egy-egy csatornát.

## Miért külön bővítmény, és miért nem az app csinálja

A Breaker DNS-szinten tilt, mert az az egyetlen pont, amit egyszerre lát minden
böngésző és minden alkalmazás — ezért él a tiltás inkognitóban és vendég módban
is. A DNS viszont **csak a hosztnevet látja** (`youtube.com`), az utat
(`/@valaki`) nem: az már a titkosított HTTPS-kérésen belül van.

Egy csatorna tiltása tehát a DNS-motorral **fizikailag lehetetlen**. Amit a
teljes URL-t látja, az maga a böngésző — innen a bővítmény.

Részletesen: [`docs/feature-partial-block.md`](../docs/feature-partial-block.md).

## Amit ez a réteg NEM tud

| | Teljes oldal (app, DNS) | Részleges (ez a bővítmény) |
|---|---|---|
| Minden böngészőben | ✅ | ❌ csak ahova telepítve van |
| Inkognitó | ✅ | ⚠️ alapból ki, külön bekapcsolható |
| Vendég mód | ✅ | ❌ ott bővítmény nem fut |
| Más alkalmazások | ✅ | ❌ |

**A két réteg egymás mellett áll, nem egymás helyett.** Aki azt akarja, hogy egy
oldal egyáltalán ne menjen, az az appban tiltsa le az egészet. Ez a réteg az
**ingert** veszi el, nem a hozzáférést — és a beállítások lapja ezt ki is mondja.

## Telepítés (fejlesztői mód)

**Chrome / Edge / Brave**

1. `chrome://extensions` → **Fejlesztői mód** bekapcsolva
2. **Kicsomagolt bővítmény betöltése** → válaszd ki ezt az `extension/` mappát
3. A bővítmény *Részletek* lapján, ha inkognitóban is kell:
   **Engedélyezés inkognitó módban**

**Firefox**

1. `about:debugging#/runtime/this-firefox`
2. **Ideiglenes kiegészítő betöltése** → `manifest.json`

## Használat

A bővítmény beállításai közt (`options.html`) illeszd be a csatorna vagy aloldal
címét:

```
youtube.com/@valaki
reddit.com/r/valami
```

- **Felvenni azonnal érvényes** — a szigorítás mindig ingyen van.
- **Levenni tíz perc várakozás**, és addig tilt. Enélkül a részleges tiltás egy
  kikapcsoló gomb lenne, és pont az a lényeg, hogy ne az legyen.
- **Meggondolni magad ingyen van**: a visszaszámlálás bármikor megszakítható.

## Mit csinál pontosan

1. **Megállítja a navigációt**, ha a cím a szabály alá esik — a saját tiltó lapja
   jön, ami megnevezi a szabályt, ami megfogta.
2. **Eltünteti a találatokat a felületről.** Ez legalább annyira fontos: a
   főoldalon a csatorna videói `/watch?v=...` címre mutatnak, amiben a csatorna
   nem szerepel — a navigáció megállítása tehát csak akkor lépne működésbe,
   amikor az ember már rákattintott. A videókártya mellett viszont ott a
   csatorna neve, ami a `/@valaki` címre mutat: ezt megtaláljuk, és a körülötte
   lévő kártyát rejtjük el.

Szövegre szándékosan **nem** keresünk: a csatorna neve előfordul olyan helyeken
is, ahol nem róla van szó (komment, videócím), és egy szöveges találat elvenne
valamit, amit a felhasználó nem tiltott le.

## Fájlok

| Fájl | Mi ez |
|---|---|
| `rules-core.js` | a szabály magja — a `desktop/src/shared/urlrules.ts` párja |
| `storage.js` | tárolás és a súrlódás (felvétel ingyen, levétel várakozás) |
| `background.js` | a navigáció megállítása (`webNavigation`) |
| `content.js` | a találatok elrejtése az oldalról |
| `options.html/js` | a szabályok kezelése |
| `blocked.html/js` | a tiltó lap |

## Hogy a szabály ne jelentsen mást itt és az appban

A magból két példány van: egy TypeScript (az app) és egy ESM (itt). Ezt a
`desktop/test/extension-core.test.ts` őrzi: a KÉT megvalósítást ugyanazon a
bemenet- és URL-táblázaton hajtja végig, és eltérésnél elhasal.

Enélkül a legcsendesebb hiba állna elő, amit ez a funkció produkálni tud: az
ember felvesz egy szabályt, az appban szépen megjelenik, a böngésző meg
átengedi az oldalt. Semmi nem hibázik, semmi nem naplózódik — egyszerűen nem az
történik, amit kért.

A `desktop/test/extension-storage.test.ts` pedig a **ténylegesen kiszállított**
`storage.js`-t futtatja egy hamis `chrome.storage.local` fölött, mert pont az a
kérdés, hogy amit a böngészőbe töltünk, az mit csinál.

A LAPOT külön füstteszt nyitja meg, valódi böngészőben
(`desktop/scripts/extension-ui.js`, a CI-ban is fut): felvesz egy szabályt,
elrontott bevitellel hibát vár, elindítja a levételt és megnézi, hogy a
visszaszámlálás alatt még tilt. Enélkül egy elgépelt azonosító vagy egy be nem
töltődő modul ugyanolyan csendes hiba lenne: a lap megjelenik, a gomb ott van,
és nem történik semmi.

## Ami még hátra van

- [ ] A szabályok átvétele az appból (most a bővítmény a sajátjait tárolja)
- [ ] Csomagolt kiadás (`.crx` / `.xpi`) a GitHub Releases mellé
