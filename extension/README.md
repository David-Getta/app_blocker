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

Az inkognitót nem csak szabályként mondja: a beállítás-lap a böngészőtől
megkérdezi, NÁLAD most fut-e ott (`incognito.js`), és ki is mondja; ha nem,
a felugró lap is, és Chromium-alapú böngészőben egy gomb a bővítmény
engedély-lapjára visz („Engedélyezés inkognitó módban”). Az appnak is
megmondja minden lehúzáskor (`x-breaker-incognito` fejléc), így a munkamenet
kártyája is kimondja, ha inkognitóban a fehérlista nem érvényesül.

**Zárlat alatt a saját szabály sem vehető le.** Az app zárlata (és a heti
zárlat-ablak, az app nélkül is) a bővítmény saját részleges szabályaira is
vonatkozik: a levétel nem indul, és a függő levétel visszavonódik.

**A már nyitott lap is.** A tiltás nem csak navigáláskor dől el: a látható
lap a szabályok változásakor, láthatóvá váláskor és húsz másodpercenként
újranézeti magát (`breaker:recheck`), ugyanazzal a döntéssel. Így a munkamenet
indulásakor vagy a keret beteltekor a nyitva hagyott videó is a tiltó lapra
fut. A címet a háttér a böngészőtől veszi, nem a laptól; és ez nem megakadás,
a könyv nem nő tőle. Gépelés közben nem zár: ha az utolsó két percben írtál a
lapon, egy sáv szól, és a gépelés-csend után zárul (legfeljebb tíz perc).

**A zárás előtt is szól.** Ha a lap még nyitva van, de az utolsó két percben
jár — a szünete véget ér, a menetrend szerint zárul, vagy a mai keretből
ennyi maradt —, a tetején egy sáv mondja, mennyi van hátra („A szünet 2 perc
múlva véget ér — utána ez az oldal újra zárva.”). Az app a hídon adja le a
közelgő zárásokat (`soon`), a háttér az újranézés válaszába teszi, a lap csak
kimondja. Bezárható, és ugyanarra a zárásra nem jön vissza. Régi jelre nem
szól (a szünetet azóta visszakapcsolhattad), csak pontos hosztnévre; a keretnél
a lehúzás óta eltelt időt levonja — inkább korábban, mint későn. A heti
ablakos munkamenet indulása előtt is szól, ha az oldal nincs a csomagban
(„Munkamenet indul 2 perc múlva (Nyelvtanulás) — ez az oldal nincs benne,
akkor zárul.”): ezt a bővítmény a tárolt ablakokból maga számolja, ugyanúgy,
ahogy a menetet az app nélkül is érvényesíti.

**A két réteg egymás mellett áll, nem egymás helyett.** Aki azt akarja, hogy egy
oldal egyáltalán ne menjen, az az appban tiltsa le az egészet. Ez a réteg az
**ingert** veszi el, nem a hozzáférést — és a beállítások lapja ezt ki is mondja.

## Telepítés (fejlesztői mód)

**Honnan a mappa.** Az asztali app a bővítményt a saját részeként hozza, és
induláskor kimásolja egy állandó mappába (a felhasználói adatok közé,
`…/Breaker/extension`); az oldal **Részek** párbeszédében a *Mappa
megnyitása* gomb odavisz. Ezt a mappát kell **egyszer** betölteni: az app
minden frissítéskor frissíti (tartalom-lenyomat alapján, nem a verziószám
szerint), utána a böngészőben elég a bővítmény *Frissítés* gombja vagy egy
újraindítás. A kiadás melletti zip annak való, aki az app nélkül használná.

**Chrome / Edge / Brave**

1. `chrome://extensions` → **Fejlesztői mód** bekapcsolva
2. **Kicsomagolt bővítmény betöltése** → válaszd ki az app mappáját (vagy
   fejlesztéshez ezt az `extension/` mappát)
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
- **Őszinte korlát:** a tíz perc a rendszeróra szerint telik — aki előretekeri
  az órát, átugorja. A bővítmény ezt megbízhatóan nem tudja észlelni (a
  háttere bármikor újraindulhat). Az app szabályainál nem így van: ott a
  várakozás eltelt időt mér, az óraugrást elnyeli a segéd. Aki ezt a rést sem
  akarja, az appban vegye fel a szabályt.

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
kóddal védett, és a lazítás irányában **zárt**: ezen az úton semmit nem lehet
feloldani. Befelé négy út van, egyik sem lazít: a megakadás-könyv
(`POST /hits`), a menet indítása a felugró lapról (`POST /focus_start` — a
bíró dönt róla, mint az app gombjánál), a heti ablak a csúcs-órára
(`POST /focus_window` — csak felvétel, ablak nélküli csomagra; a csere az
appé), és az elöl lévő oldal jele (`POST /tab`).

**A mérő jele.** Az app a böngésző címét a rendszeren át olvassa; ha ez nem
megy (macOS-en minden aláíratlan frissítés után újra kell adni az
„Automatizálás” engedélyt), a böngészőben töltött idő appként könyvelődik, és
az oldal napi kerete nem fogy. A bővítmény ezért megmondja, melyik oldal van
elöl — fül- és ablakváltáskor, navigáláskor és a látható lapok újranézésekor.
Csak a TARTOMÁNYT (`youtube.com`), csak a saját gépeden futó appnak, a kóddal;
és ha a böngésző nincs fókuszban, azt is, hogy most semmiről nem szól. Az app
a saját szonda-látványát előnyben részesíti, és a jelet csak böngészőre
alkalmazza.

### A felugró lap (az ikonra kattintva)

Egy pillantás — és egy gomb: „Munkamenet: Nyelvtanulás, 25 perc” indítja az
app javasolt csomagját (a legutóbb használtat a szokásos hosszával) a hídon;
futó menet mellett nincs gomb, elavult válasz mellett sem. Mellette a másik
gomb — „Heti ablak a csúcs-órára: Nyelvtanulás, minden nap 21:00–22:00” — a
hídon felteszi az ablakot, ha az app csúcs-óráját semmi nem fedi és a
csomagnak nincs még; csak felvétel, a csere az appé. A párja a menet-órára
— „Heti ablak a menet-órára: Nyelvtanulás, minden nap 09:00–10:00” —, ha
az app menet-órája nem a csúcs-óra (azt a másik gomb kínálja). Mind ott
van a tiltó lapon is. Ha egy csomag ablaka már fedi a csúcs-órát, a lap a csúcs
mondata után kimondja: „A csúcs-órában magától indul: Nyelvtanulás.” — az
app szava, frissen; a menet-óráét ugyanígy, a gomb mellett:
„A menet-órában magától indul: Nyelvtanulás.” És ha a csúcs-óra a
menet-órád is, a csúcs mondata után kimondja: „Ez a menet-órád is: a kéz akkor jár, amikor le szoktál ülni.” A csúcs-napon (négy hétből, legalább három megakadásból)
a felugró lap és a tiltó lap azt is mondja, hogy ma van; a menet-napon (az
app mondja, `suggest.focusDay`) a gomb mellett: „Ma a menet-napod van — ilyenkor szoktál leülni.”
A menet-sorozatot is, a gomb mellett (az app száma, `suggest.focusStreak`, kettőtől): „5 napja minden nap leültél.”
— a rekorddal, ha több (`suggest.focusLongestStreak`): „5 napja minden nap leültél (a leghosszabb sorozatod: 12 nap).”
És ha egy oldal mai keretéből kevés van hátra, a közeledő keretet (`suggest.limitSoon` — az app kész mondata, a fedőnevet is ő oldja fel): „Ma még 8 perc a kereted: youtube.com.”
Minden más csak
olvas: összekötve van-e az app és mennyire friss,
amit tud; fut-e munkamenet (név, hátralévő idő, hány cím engedett — és ha a
heti ablak szerint indult, azt is kimondja, mert aki nem maga indította, nem
tudná, miért fut); mi van
**most zárva** az app szerint (okkal és hátralévő idővel); hány részleges
szabály és csatorna-szűrő él. Ugyanabból a tárolt állapotból beszél, amiből a
tiltó lap, és ugyanazokkal a szabályokkal: a zárva-lista csak három
lehúzásnyi ideig számít frissnek, a lejárt bejegyzés nem zárás, a munkamenet
lejáratát helyben nézi. Összekötetlenül az app állapotáról nem beszél. Ha az
appban **zárlat** van, azt is kimondja a hátralévő idővel — és itt a
frissesség-szabály más: a zárlat csak hosszabbodhat, tehát egy régebbi
lehúzás vége is igaz alsó becslés. Ha az appban **megbízott** van (párban
zárolás), azt is mondja: minden lazítás utolsó lépése az ő jelmondata. A
Beállítások gomb a beállítási lapra visz — minden, ami módosítás, ott van.

## Mit csinál pontosan

1. **Megállítja a navigációt**, ha a cím a szabály alá esik — a saját tiltó lapja
   jön, ami megnevezi a szabályt, ami megfogta. A lába azt az utat mondja,
   ami tényleg létezik: a bővítmény saját szabályát a beállításaiban, tíz perc
   várással lehet levenni; az appból jöttet az appban, próbatétellel (a
   beállítás-lapon a gombja le is van tiltva) — zárlat alatt sehogy, és
   megbízottal az ő jelmondatával. A háttér ezért jelzi a lapnak, ha a
   szabály az appé (`ruleFrom=app`).
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
   kinyílt oldalra. Egy kivétellel: a **mérés-őr** (ha bekapcsoltad) épp az app
   hallgatásakor zár — a keretes oldalakat a segéd a hosts-ban zárja, amíg a
   Breaker nem fut. Az app ezért leküldi az őrzött hosztokat
   (`measureGuard`), és ha három percnél régebben szólt (ugyanannyi, mint a
   segéd türelmi ideje), a lap ezekre megmondja, miért zárva, és hogy az app
   elindítása nyitja (`measureGuardFor`).

6. **Zárlat alatt nem ígér feloldást.** Minden tiltó lap lába alapból azt
   mondja, merre van a lazítás útja az appban (feloldás, a menet leállítása,
   új csatorna) — és hogy próbatételbe kerül. Zárlat alatt pont ez az út
   nincs, ezért a láb a zárlatról beszél, a hátralévő idővel; a zárlat
   lejártakor visszaáll a rendes szövegre. A vég a hídon jön le az apptól,
   minden lehúzással — és vele az is, ha a heti zárlat-ablak tartja: a láb
   és a felugró lap ilyenkor „a heti ablak szerint”-et mond, hogy tudd, nem
   kézzel indított döntés volt, hanem a hétköznap. A heti zárlat-ablakokat az
   app egy hétre előre leküldi (`lockdown.windows`): ha az app hallgat, a most
   tartó ablak is zárlat a lapon (`effectiveLockdown`) — a segéd az ablak
   zárlatát az app nélkül is elindítja.

7. **Idézi az indokot.** Ha az appban egy mondatot írtál az oldalhoz — miért
   tiltottad —, a tiltó lap bármelyik kártyája alatt idézi: „Ezért tiltottad
   le: …”. A híd hosztnevenként adja le (`notes`), mint a zárva-listát, a
   bővítmény tisztítva tárolja és pontos hosztnévre keresi; a szöveg a lap
   címén utazik, és a lap újra megtisztítja, mert erre a lapra kézzel írt
   címmel is el lehet jutni. Régi app válaszában nincs lista — a lap akkor
   nem idéz.

8. **Megbízottal a feloldás útja az ő jelmondatával ér véget.** Ha az appban
   párban zárolás van (egy megbízott jelmondata minden lazítás utolsó
   lépése), a híd a nevét is leadja (`partner`), és a tiltó lap lába a
   próbatétel mellé kimondja: „A feloldáshoz a megbízottad (Anna) jelmondata
   is kell — az utolsó szó az övé.” A felugró lap is mondja. Zárlat alatt
   nem: ott út sincs. Csak a név megy — a jelmondat lenyomata az appé, a
   bővítménynek semmi dolga vele; a frissesség itt sem számít, a megbízott a
   lenyomattal él, nem a lehúzással.

9. **Kulcsszavak: bármely oldalon, ha a cím tartalmazza.** Az appban felvett
   szavak (`shorts`, `reels`, egy játék neve) a hídon jönnek (`keywords`), és a
   háttér minden navigációnál a cím szövegén keresi őket — séma nélkül, a
   százalék-kódolás feloldva, kisbetűvel, a hosztnévben is. A lap CÍMSORÁBAN
   is: a tartalom-szkript betöltéskor és váltáskor megnézi a `<title>`-t, és
   találatnál a háttérnek szól, ami a böngésző címsorából dönt (`by=title`).
   Találatnál a tiltó lap külön kártyája kimondja, melyik szó fogott, és hol. A döntés az egész oldal
   zárása után, a csatorna és a részleges szabály előtt megy, mert tágabb,
   mint azok. Itt nem szerkeszthető: levenni az appban kell, ahol
   próbatételbe kerül. A mag a `keywords.js` — a `desktop/src/shared/keywords.ts`
   párja, cím-lista párokon összevetve.

10. **Számolja, hányszor állított meg.** Minden tiltó lapra vitt navigáció egy
    megakadás — naponként, okonként (zárva oldal, munkamenet, csatorna,
    részleges szabály, kulcsszó), harminc napig, egy navigációt egyszer (a két
    háló ugyanarra a címre kétszer is átirányíthat; a könyv nem számolja
    kétszer). A felugró lap és a beállítás-lap mondja: „Ma 3 megakadás; az
    elmúlt 7 napban 12.” Az appnak is átmegy (`POST /hits`, a kóddal, egy
    állandó forrás-azonosítóval), ahol a heti mondat és a statisztika sora
    mondja; a fiókba nem megy. A tiltó lap is mondja, a kísértés
    pillanatában: „Ma ez a 7. megakadás — ebből a 3. ezen az oldalon.”, a
    csúcs-órában azt is, hogy most van — és egy gombot is ad: „Munkamenet:
    Nyelvtanulás, 25 perc”, az app javasolt csomagja a hídon indul (futó menet
    és összekötés nélkül nincs gomb); a felugró lap a hét csúcsát (a
    hosztonkénti könyv csak itt marad; a hídra a nap öt leggyakoribb hosztja
    megy, a gépen belül — melyik oldal akaszt meg a legtöbbször). Óránként is: a
    beállítás-lap a harminc nap alakját is rajzolja, ha a hét előtt is volt,
    és a mondat a harminc nap számát is mondja, ha több a hétnél; a
    beállítás-lap a hét csúcs-óráját mondja („A hét csúcsa: 21–22 óra”) és
    egy óra-sávot rajzol — mikor jár a kéz magától; a négy hét csúcs-napját is
    mondja, és a hét napjainak sávját rajzolja alá; a hetet az előző héthez
    méri („A héten 12 megakadás, az előző héten 18.” — a hídra két hét megy,
    hogy az app is tudja); kulcsszavanként is, a fogó szóval
    („Kulcsszavanként a héten: shorts 7 · reels 3” — melyik kulcsszó dolgozik;
    a hídra a nap öt leggyakoribb szava megy); és a hetet okonként is
    („A héten: 4 zárva oldal · 3 kulcsszó”) — melyik szabály dolgozik. A mag
    a `hits.js`, a kiszállított bájtokon tesztelve.

11. **A heti ablakot az app nélkül is betartja.** A heti ablak menetét a gépen
    a segéd az app nélkül is elindítja — a böngészőben viszont csak ez a
    bővítmény tarthatja be. Az app minden lehúzással a következő hét ablakait
    is leküldi (`focus.windows`: csomag, név, engedett oldalak, kezdés, vég —
    az elköltött nélkül); amíg az app friss (egy perc), az ő élő szava dönt,
    ha hallgat, a most tartó tárolt ablak (`effectiveFocus`). Az app bezárása
    így nem az ablak feloldása. Ami az app utolsó szava óta máshol lekerült,
    azt az app következő indulásáig még betartja — a szigorúbb irány.

## Fájlok

| Fájl | Mi ez |
|---|---|
| `rules-core.js` | a szabály magja — a `desktop/src/shared/urlrules.ts` párja |
| `storage.js` | tárolás és a súrlódás (felvétel ingyen, levétel várakozás) |
| `app-link.js` | a kapcsolat az appal: kód, lekérés, gyorsítótár |
| `channels.js` | a csatorna-szűrő magja — a `desktop/src/shared/channels.ts` párja |
| `chantime.js` | a csatorna-idő magja (mérés-tárolás, listák) — csak itt él |
| `keywords.js` | a kulcsszó-szabályok magja (alak, lista, illesztés) — a `desktop/src/shared/keywords.ts` párja |
| `hits.js` | a megakadás-számláló magja (naponként, okonként; a mondat; a hídra menő sorok) — csak itt él |
| `background.js` | a navigáció megállítása (`webNavigation`) és a feltöltő-döntés |
| `content.js` | a találatok elrejtése + a lejátszó-oldal feltöltőjének kiolvasása |
| `options.html/js` | a szabályok kezelése |
| `blocked.html/js` | a tiltó lap |
| `popup.html/js` + `popup-core.js` | a felugró lap az ikonon; a mag tiszta, a kiszállított bájtokon tesztelt |

## Hogy a szabály ne jelentsen mást itt és az appban

A magból két példány van: egy TypeScript (az app) és egy ESM (itt). Ezt a
`desktop/test/extension-core.test.ts` őrzi: a KÉT megvalósítást ugyanazon a
bemenet- és URL-táblázaton hajtja végig, és eltérésnél elhasal. És a
`desktop/test/extension-fixture.test.ts` a közös szöveg-fixtúrát
(`fixtures/text-cases.json`) is lefuttatja a kiszállított `rules-core.js`-en és
`keywords.js`-en — ugyanazt, amit a két telefon visszajátszik. Az első futása
fogta ki, hogy az út hosszát itt még UTF-16 egységben mértük, az appban
kódpontban.

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

## Amit a tesztek fednek — és amit nem

A bővítmény **valódi Chromiumban, valódi bővítményként betöltve** is fut a
CI-ban (`desktop/scripts/extension-e2e.js`): a manifest, a jogosultságok, a
`webNavigation`-horgok, a tartalom-szkript és a háttér együtt — egy helyi
kamu videó-oldalon végigmegy a rétegeken (hírfolyam-tisztítás, lejátszó-oldali
feltöltő-tiltás, elavulás-őr, csatorna-lap), a tiltó lapon a keret, a hűtés
és a zárlat szövegén, és a csatorna-időn is. Emellett a CI nézi a
szabály-magok egyezését, a súrlódást a ténylegesen kiszállított
`storage.js`-en, és a beállítási lapot valódi böngészőben.

Őszintén, ami NEM fedett: a valódi YouTube felülete (a teszt kamu oldalon
fut, a valódi DOM változásait csak a kézi próba mutatja meg), a Chromiumon
kívüli böngészők (Firefox, Safari), és a bolt-csomagolás. A fennmaradó
kockázat tehát a célhely felőli változás, nem a bővítmény huzalozása.

## Ami még hátra van

- [x] A szabályok átvétele az appból (*Kapcsolat az appal*)
- [x] Csomagolt zip a GitHub Releases mellé (`Breaker-bovitmeny-*.zip`)
- [ ] Aláírt csomag (`.crx` / `.xpi`), hogy ne kelljen fejlesztői mód
- [x] Végponttól végpontig futó teszt valódi bővítmény-betöltéssel
      (`desktop/scripts/extension-e2e.js` — minden ellenőrzőn fut)
