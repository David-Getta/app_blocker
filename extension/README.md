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

### Összekötés az appal

Ha a Breaker asztali app is fut ezen a gépen, a szabályokat ott is fel lehet
venni — és ott a levételük **próbatételbe kerül**, nem tíz perc várakozás.

1. Az appban egy oldal sorában: **Részek** → ott van kiírva egy kód.
2. Másold be a bővítmény beállításai közé (*Kapcsolat az appal*) → **Összekötés**.

Ezután a bővítmény percenként lekéri az app szabályait, és a sajátjai MELLETT
érvényesíti őket. Amit az appból kapott, azt itt **nem lehet levenni**: ha
lehetne, a bővítmény lenne a legolcsóbb kiskapu az egész appban.

Amíg az app nincs nyitva, a legutóbb letöltött lista marad érvényben — vagyis
**tovább tilt**, nem enged át. A híd csak a saját gépen belül él (`127.0.0.1`),
kóddal védett, és **csak olvas**: ezen az úton semmit nem lehet feloldani.

### A felugró lap (az ikonra kattintva)

Egy pillantás, módosítás nélkül: összekötve van-e az app és mennyire friss,
amit tud; fut-e munkamenet (név, hátralévő idő, hány cím engedett); mi van
**most zárva** az app szerint (okkal és hátralévő idővel); hány részleges
szabály és csatorna-szűrő él. Ugyanabból a tárolt állapotból beszél, amiből a
tiltó lap, és ugyanazokkal a szabályokkal: a zárva-lista csak három
lehúzásnyi ideig számít frissnek, a lejárt bejegyzés nem zárás, a munkamenet
lejáratát helyben nézi. Összekötetlenül az app állapotáról nem beszél. A
Beállítások gomb a beállítási lapra visz — minden, ami módosítás, ott van.

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

3. **A csatorna-szűrőt is érvényesíti** (az appban felvett fehérlistát):
   a csatorna-alakú címeket a navigációnál fogja meg; a hírfolyamban a nem
   engedélyezett csatornák VIDEÓKÁRTYÁIT rejti el (csak azt a dobozt, ami
   videóra is mutat — a komment nem kártya, az egész polc nem kártya); a
   lejátszó-oldalon pedig a lap saját metaadatából (JSON-LD, mikroadat, a
   lejátszó beágyazott adata) olvassa ki a feltöltőt, és ha az nem
   engedélyezett, tiltó lapra visz. A metaadat csak akkor számít, ha a
   MOSTANI videót nevezi meg — egylapos váltásnál az előző videó adata nem
   ítélhet. A döntés a háttérben születik, a friss szűrő-listával.

4. **Méri a csatorna-időt.** Ahol bekapcsolt csatorna-szűrő van, ott azt is
   méri, MELYIK csatorna mennyi időt vitt — másodpercenként, de csak amíg a
   lap ténylegesen előtérben van. Máshol nem gyűjt semmit, és az adat ezen a
   gépen marad (a bővítmény tárában): nem megy se az appba, se a fiókba. A
   listák a beállítási lapon állnak (ma + elmúlt 7 nap).

5. **Megmagyarázza az egészében zárt oldalt.** Amit az app DNS-szinten zár
   (blokklista, menetrend, betelt napi keret, adag-hűtés), azt a böngésző
   nyers hibalappal mutatná — „nem sikerült kapcsolódni”, mintha a net romlott
   volna el. Összekötött app mellett a bővítmény ilyenkor a saját lapját
   mutatja: megnevezi az okot, hűtésnél és keretnél visszaszámol. Ez
   MAGYARÁZAT, nem érvényesítés — a tiltást a DNS tartja, bővítmény nélkül is.
   És csak friss adatból beszél: ha az app nem elérhető, vagy a bejegyzés
   ideje lejárt, a lap inkább hallgat, mint hogy zárva-t mondjon egy már
   kinyílt oldalra.

## Fájlok

| Fájl | Mi ez |
|---|---|
| `rules-core.js` | a szabály magja — a `desktop/src/shared/urlrules.ts` párja |
| `storage.js` | tárolás és a súrlódás (felvétel ingyen, levétel várakozás) |
| `app-link.js` | a kapcsolat az appal: kód, lekérés, gyorsítótár |
| `channels.js` | a csatorna-szűrő magja — a `desktop/src/shared/channels.ts` párja |
| `chantime.js` | a csatorna-idő magja (mérés-tárolás, listák) — csak itt él |
| `background.js` | a navigáció megállítása (`webNavigation`) és a feltöltő-döntés |
| `content.js` | a találatok elrejtése + a lejátszó-oldal feltöltőjének kiolvasása |
| `options.html/js` | a szabályok kezelése |
| `blocked.html/js` | a tiltó lap |
| `popup.html/js` + `popup-core.js` | a felugró lap az ikonon; a mag tiszta, a kiszállított bájtokon tesztelt |

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

## Amit a tesztek NEM fednek

Őszintén: a bővítmény **valódi böngészőbe telepítve** még nem futott. A
fejlesztői környezet fej nélküli Chromiumja a `--load-extension`-t nem
támogatja — a szolgáltatás-worker el sem indul —, tehát a manifest, a
jogosultságok és a `webNavigation`-horgok együttes működése az első valódi
telepítéskor derül ki.

Amit viszont igenis fed a CI: a szabály-magok egyezése, a súrlódás a
ténylegesen kiszállított `storage.js`-en, és a beállítási lap valódi
böngészőben. A fennmaradó kockázat tehát a bővítmény-keretrendszer felőli
huzalozás, nem a logika.

## Ami még hátra van

- [x] A szabályok átvétele az appból (*Kapcsolat az appal*)
- [x] Csomagolt zip a GitHub Releases mellé (`Breaker-bovitmeny-*.zip`)
- [ ] Aláírt csomag (`.crx` / `.xpi`), hogy ne kelljen fejlesztői mód
- [x] Végponttól végpontig futó teszt valódi bővítmény-betöltéssel
      (`desktop/scripts/extension-e2e.js` — minden ellenőrzőn fut)
