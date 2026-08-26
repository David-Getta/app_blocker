# Funkcióterv: munkamenetek („most csak ez mehet”)

Státusz: **kész az asztali appon** — csomagok, gyorsbillentyűs réteg, és a
fehérlista érvényesítése a böngészőben. Az appok engedélyezése egyelőre
figyelmeztet, nem tilt; a dokumentum alja megmondja, miért.

## Mit old meg

A blokklista arról szól, mi NE menjen. Van azonban egy másik igény, ami
ellentétes irányból közelít:

> Leülök nyelvet tanulni, és a következő ötven percben csak a szótár és a
> jegyzetfüzet kell.

Mindent felsorolni, ami zavarhat, reménytelen — a világon minden zavarhat.
Felsorolni, ami kell: öt tétel. A munkamenet ezért **fehérlista**.

```
„Nyelvtanulás”   engedve: translate.google.com, quizlet.com, Word
                 minden más: tiltva, ötven percig
```

## Hogyan indul

Az egész funkció azon áll, hogy **egy mozdulattal induljon**. Aki leül tanulni,
az nem fog előbb ablakot keresni, appot előhozni és fület váltani — addigra már
a YouTube-on van.

Ezért van egy **gyorsbillentyűs réteg** (⌘⌥B macOS-en, Ctrl+Alt+B Windowson):
rááll arra, amit épp csinálsz, kilistázza a csomagokat, és számbillentyűvel
indítható. Az Esc bezárja.

A réteg **semmit nem old fel**. A leállítás gombja az appot nyitja meg, ahol a
próbatétel van — ha innen menne, a munkamenet egy billentyűkombináció lenne.

## A hossz percre pontos

Indításkor a felület felkínál néhány szokásos hosszt (15 / 25 / 50 / 90 / 120
perc), **de a szám szabadon átírható**: 1-től 480 percig bármi megadható. Ez a
rétegben is megvan, nem csak az appban — épp a sietős esetben lenne rossz, ha
csak ott lenne.

Miért nem elég a gomblista: aki tudja, hogy negyvenhárom perce van ebédig, az
eddig kénytelen volt fölé vagy alá lőni. Egy önkontroll-appnál a „nagyjából
annyi” pont a rossz irány — fölé lőve előbb akar leállítani (és az próbatétel),
alá lőve pedig magától lejár, mielőtt kész lenne.

Hosszabbítani menet közben is lehet percre pontosan. A hosszabbítás
**szigorítás** — tovább tart a munkamenet —, ezért ingyen van.

Minden csomagnak van **szokásos hossza**: indításkor ezt kínálja fel a felület.
A csomag szerkesztőjében állítható.

## Súrlódás: ugyanaz a szabály, mint mindenhol

| Művelet | Ár | Miért |
|---|---|---|
| Munkamenet indítása | ingyen | szigorítás |
| Hosszabbítás | ingyen | szigorítás |
| Csomag szerkesztése (ami NEM fut) | ingyen | nem befolyásol semmit |
| **Rövidítés** | próbatétel | lazítás |
| **Leállítás** | próbatétel | lazítás |
| **A futó csomag szerkesztése** | tiltott | lásd lent |

**A futó csomag befagy.** Enélkül a fehérlistához menet közben hozzá lehetne
adni bármit, és a munkamenet önmagát oldaná fel — csendben, próbatétel nélkül.

**Egyszerre egy munkamenet fut.** Enélkül a leállítás próbatételét meg lehetne
kerülni: indítok egy „minden engedve” csomagot, és kész.

## Mit tud érvényesíteni, és mit nem

Ez a funkció három rétegen fekszik, és a felület mindegyiknél kimondja, mit tud:

| Réteg | Mit tud | Korlát |
|---|---|---|
| **Böngésző-bővítmény** | a fehérlista teljes érvényesítése: ami nincs a listán, oda nem enged navigálni | csak abban a böngészőben él, ahova telepítve van; vendég módban nem fut |
| **DNS (hosts)** | a meglévő blokklista végig érvényes | „mindent tilts, kivéve ötöt” egy hosts-fájlban nem leírható |
| **Appok** | a mérés látja, mi van előtérben | egy appot bezárni nem tudunk — figyelmeztetünk, nem tiltunk |

A **böngésző az egyetlen hely, ahol a fehérlista tényleg érvényesíthető**, mert
csak ott látszik a teljes cím. A DNS a hosztnévnél tovább nem lát, és a
„blokkolj mindent, kivéve ötöt” nem írható le egy hosts-fájlban: a világ összes
tartománynevét kellene felsorolni.

Az appoknál a helyzet nyíltan gyengébb: a mérés (`tracker`) tudja, melyik app
van előtérben, de egy futó programot nem lövünk ki. Ez szándékos — egy app
kilövése adatot veszíthet, és a Breaker soha nem tesz olyat, amit a felhasználó
nem kért.

## Adatmodell

```ts
interface FocusPack {
  id: string;
  name: string;              // „Nyelvtanulás”
  allowSites: string[];      // aldomainek is átmennek
  allowApps: string[];       // részleges, kis-nagybetű-független egyezés
  defaultMinutes: number;
}

interface FocusRun { packId: string; startedAt: number; endsAt: number }

interface FocusLogEntry {
  packId: string;
  packName: string;          // a NÉV is, mert a csomag azóta átnevezhető
  startedAt: number;
  endedAt: number;           // mikor ért véget TÉNYLEGESEN
  plannedEndsAt: number;     // ebből látszik, hogy korábban ért-e véget
  stopped: boolean;          // próbatétellel, vagy magától járt le
}
```

**Az aldomain átmegy**: a `google.com` engedése a `translate.google.com`-ot is
engedi. Enélkül minden oldalnál külön ki kellene találni, melyik aldomain kell,
és a felhasználó azt látná, hogy a beállítása nem működik. A `notgoogle.com`
viszont NEM megy át — a végén hasonlító tartománynév a leggyakoribb megkerülés.

**Az appnév lazán egyezik**, mindkét irányban: a beírt `word` engedi a
`Microsoft Word` ablakot is. Az ablakcímek és folyamatnevek gépenként és
nyelvenként eltérnek; egy pontos egyezésre épülő lista mindenkinél máshogy
viselkedne, és senki nem értené, miért.

## A napló MÁS szabályt követ, mint a többi

A szinkronban három dolog utazik együtt, és a harmadik szándékosan kilóg:

| Mi | Mi ez | Hogyan fésülődik |
|---|---|---|
| csomagok | beállítás | utolsó író nyer |
| futó menet | **engedély** | a szigorúbb nyer; lazítani csak nagyobb `rev` |
| napló | **a múlt feljegyzése** | EGYESÍTÉS, a `rev`-hez semmi köze |

A különbség nem következetlenség. A csomagok és a futás azt mondják meg, mi
*történhet* — ezért vonatkozik rájuk a súrlódás iránya. A napló azt mondja meg,
mi *történt*: nem enged meg semmit, nem old fel semmit, és egy elveszett sora
nem kibúvó, csak pontatlan statisztika.

Ha a napló léptetné a számlálót, egy statisztika-bejegyzés le tudna állítani egy
futó menetet a másik eszközön, próbatétel nélkül. Ezért marad ki a `rev`
lenyomatából (`helper/revisions.ts`) — de benne VAN a „van-e mit feltölteni”
vizsgálatban (`sameFocus`), különben egy telefonon lezárult menet sosem érne fel.
A kettő nem ugyanaz a kérdés: az egyik azt méri, ki dönthet, a másik azt, hogy
van-e új adat.

**Két sor akkor ugyanaz, ha a csomag és a KEZDÉS egyezik.** Ez a gyakori eset,
nem a kivétel: a telefonon próbatétellel leállítod, a gép meg később, a
szinkronból veszi észre — enélkül minden ilyen menet kettőnek számítana.
Ütközésnél a korábbi vég nyer: a menet akkor ért véget, amikor véget ért, nem
akkor, amikor a másik eszköz észbe kapott.

## Az óra átállítása nem rövidíti a menetet

A leállítás próbatétel — a lejárás viszont sokáig nem volt védve. Nyolc órát
előreugorva az óra a menetet „lejárttá” tette, és mivel a lejárás lépteti a
`rev`-et, a szinkron ezt a többi eszközre is átvitte.

A szabály egy mondat: **amennyi hátra volt, annyi van hátra.** Az `absorbClockJump`
a futó menet kezdését és végét is eltolja az ugrással.

Ugyanez a válasz az alvó gépre, és ez nem kompromisszum: az app nem tudja
megkülönböztetni az átállított órát a felfüggesztett géptől, de nem is kell.
Ha lecsukod a laptopot tíz perccel a vége előtt, reggel tíz perc lesz hátra —
azt a tíz percet nem töltötted fókuszban. Ugyanez igaz, ha a
háttérszolgáltatás közben nem futott: akkor a fehérlistát sem tartatta be senki.

A KEZDÉS is tolódik, nem csak a vég. Enélkül a naplóba egy ötvenperces menet
nyolc és fél órásként kerülne be.

### Aminek ez az ára — kimondva

Ha KÉT eszköz van, és az egyik aludt, a másik ébren volt, a kettő nem ugyanazt
látta:

- az ébren lévő eszköz a menetet a saját idejében lezárta, és ezzel léptette a
  szinkron-számlálót;
- az alvó eszköz ébredéskor elnyelte az ugrást, tehát nála a menet MÉG FUT — és
  ez is lépteti a számlálót.

Azonos `rev` mellett a szigorúbb nyer, tehát a futó menet: az ébren lévő
eszközön a menet VISSZATÉR. Ez a súrlódás irányából következik, és
próbatétellel leállítható — de meglepő, és nem hallgatjuk el.

A statisztikában ez ráadásul KÉT sort adhat egy menetre: a naplósor azonossága
a csomag és a KEZDÉS párja, az alvó eszközön viszont a kezdés eltolódott. Nem
kibúvó és nem adatvesztés, csak egy fölös sor.

A tiszta megoldás valószínűleg az, hogy az ugrás elnyelése NE léptesse a
számlálót — az elnyelés nem döntés, csak helyi újraértelmezés —, mert akkor az
ébren lévő eszköz lezárása (nagyobb `rev`) nyerne. Ez viszont a `rev`
jelentését érinti, és egy ilyen változtatást nem szabad átgondolatlanul,
kiadás közben becsúsztatni. Addig ez a szakasz a válasz.

## Mennyi idő alatt ér el a böngészőig

A bővítmény **húsz másodpercenként** kérdezi meg az appot. Nem egy percenként,
és nem is öt másodpercenként:

- aki elindít egy munkamenetet, és utána még egy percig megnyithatja a
  YouTube-ot, az nem fog megbízni benne;
- öt másodpercenként viszont fölösleges terhelés lenne, és a munkamenet
  percekben él, nem másodpercekben.

Ez azt is jelenti, hogy a munkamenet indítása után **legfeljebb húsz
másodpercig** még átmehet egy oldal. Ezt nem takarjuk el: a réteg a szándékot
támogatja, nem egy elektromos kerítés.

## A lejárat IDŐPONT, nem állapot

A bővítmény a munkamenet végét **helyben** nézi, nem az apptól kérdezi:

- ha az appot bezárják, a munkamenet a saját idejéig **akkor is tart** —
  bezárni az appot nem feloldás;
- de egy perccel sem tovább: egy elérhetetlen app nem tarthat bent örökre.

## Mi valósult meg, hol

| Rész | Hol |
|---|---|
| Mag (fehérlista, idő, súrlódás iránya) | `desktop/src/shared/focus.ts` |
| Tárolás | `desktop/src/helper/state.ts` |
| Bíró (indítás, hosszabbítás, leállítás) | `desktop/src/helper/referee.ts` |
| Felület (csomagok, futó munkamenet) | `desktop/src/renderer/renderer.ts` |
| Gyorsbillentyűs réteg | `desktop/src/main/overlay.ts`, `renderer/overlay.*` |
| A fehérlista kiadása a bővítménynek | `desktop/src/main/rules-bridge.ts` |
| A fehérlista érvényesítése | `extension/background.js`, `extension/app-link.js` |
| Összefésülés eszközök között | `desktop/src/shared/sync/focus-merge.ts` + Kotlin/Swift tükör |
| Napló és összegzés | `desktop/src/shared/focus.ts` (`closeIfEnded`, `summarizeFocus`) |
| Statisztika a felületen | `renderer.ts`, `ui/StatsScreen.kt`, `App/StatsView.swift` |

## Ami még hátra van

- [ ] Az appok tényleges tiltása (ma figyelmeztetés), platformonként külön
- [ ] Rendszerszintű fehérlista weboldalakra: ehhez helyi DNS-feloldó kell,
      nem hosts-fájl
- [ ] A gyorsbillentyű átállítható legyen a felületről

## A telefon eddig kiskapu volt

A munkamenet a v0.4.2-ig **csak az asztali appban létezett**. Elindítod a gépen
a „Nyelvtanulás” csomagot, aztán felveszed a telefont — és ott minden mehet.
Egy fehérlistánál ez nem részleges lefedettség, hanem a funkció fele: pont az
az eszköz maradt ki, ami kéznél van.

A mag ezért mostantól **három nyelven** él (`Focus.kt`, `Focus.swift`), és a
`scripts/check-core-sync.js` őrzi, hogy a számai ne csússzanak szét.

### Telefonon a fehérlista ERŐSEBB, mint gépen

Ez meglepő, de így van, és a mechanizmusból jön:

| | Amit a réteg lát | Fehérlista? |
|---|---|---|
| **hosts fájl (gép)** | egy statikus névlista | **nem** — a világ összes nevét kellene felsorolni |
| **böngésző-bővítmény (gép)** | a teljes URL | igen, de csak abban a böngészőben |
| **VPN/alagút (telefon)** | **minden névfeloldás** | **igen** — bármire tud nemet mondani |

A telefonon tehát nem kell bővítmény: a szűrő minden lekérdezést lát, és ami
nincs a csomagon, arra NXDOMAIN a válasz.

### Ezért kell a kivétellista — és ezért szűk

Egy telefon, aminek MINDEN névfeloldása elhasal, nem korlátozott telefon,
hanem használhatatlan: nem jön értesítés, a rendszer azt hiszi, nincs
internet, és a felhasználó a munkamenetet fogja hibásnak tartani, nem a saját
beállítását.

A kivételek tételesen, indoklással (`Focus.INFRA_ALLOW`):

| Mi | Miért |
|---|---|
| értesítés-kézbesítés (FCM / APNs) | enélkül nyolc órán át nem jön üzenet — a munkamenet nem arról szól, hogy elérhetetlen legyél |
| kapcsolat-ellenőrzés | enélkül a rendszer hálózati hibát jelez, és a felhasználó „nincs net”-et lát, nem munkamenetet |
| óra (NTP) | egy elcsúszott óra a munkamenet VÉGÉT is elcsúsztatná |
| a saját fiókkiszolgálód | enélkül a telefon nem látná, ha egy MÁSIK eszközön leállítod — egy zár, amit a saját kulcsod sem ér el, nem zár |

Böngészni egyiken sem lehet. A felület kimondja, hogy a lista létezik: egy
titkos kivétel rosszabb lenne, mint egy nyílt.

### A sorrend, ami nem esztétika

`Focus.verdict` a döntés, és a sorrendje maga a szabályrendszer:

1. **A blokklista mindig nyer.** A munkamenet sosem old fel semmit — csak
   hozzátesz. Ha ez fordítva lenne, egy csomagba felvett `youtube.com`
   feloldaná a tiltott YouTube-ot, próbatétel nélkül: a munkamenet lenne a
   kiskapu a blokklistán.
2. Nem fut munkamenet → a blokklista döntött.
3. A csomagon rajta van → mehet.
4. Rendszer-infrastruktúra → mehet.
5. Minden más → tiltva, mert a munkamenet fehérlista.

Az 1. pontot külön teszt őrzi, és a tesztet elrontva ellenőriztem, hogy
tényleg elhasal.

### Amit az appoknál a telefon NEM tud

A csomag `allowApps` mezőjét a telefon **nem érvényesíti**. Androidon a
rendszer-alagút appok szerinti szűrése külön mechanizmus (`addAllowedApplication`),
iOS-en pedig egyáltalán nincs ilyen. A mezőt mégis tároljuk és szinkronizáljuk,
mert a gépen érvényes, és a szinkron sosem dobhat el olyat, amit egy eszköz nem
használ — különben a telefon minden körben letörölné a gépen felvett listát.

## Hol tart most a mobil (v0.4.4)

| | Csomagok tárolása | Szinkron | Fehérlista érvényesítése | Indítás | Statisztika |
|---|---|---|---|---|---|
| **Gép** | igen | igen | böngésző-bővítmény | igen | igen |
| **Android** | igen | igen | **DNS-szűrő (a VPN-ben)** | igen | **igen** |
| **iPhone** | igen | igen | **DNS-szűrő (az alagútban)** | igen | **igen** |

A statisztika oszlopa a v0.4.4-ben lett teljes. Addig a napló csak a gépen
létezett, holott a menetet a telefonon is le lehetett zárni: aki ott ült le
dolgozni, azt látta, hogy a héten egyszer sem.

iPhone-on ez az EGYETLEN idő-statisztika, ami valaha igazi lesz. Az Apple nem
enged hozzáférést ahhoz, mennyi időt töltesz más appokban — a munkamenet
viszont a miénk: mi indítjuk, mi zárjuk le, mi írjuk a naplót. Androidon pedig
a mérési hozzáférés KAPUJA FÖLÖTT áll, ugyanezért: nem az Androidtól kérjük.

**Mindkét telefonon indítani és leállítani is lehet — EGYSZERRE került be a kettő.**
Ez nem esztétika: indítani ingyen van, leállítani viszont próbatétel. Ha a
telefon tudna indítani, de leállítani nem, akkor egy elindított nyolcórás
menetből ott nem lenne kiút — és a Breaker soha nem tesz a felhasználóval
olyat, amit az nem kért. Ezért a `startFocus` és a `changeFocus` mindkét
platformon egy lépésben jött, a próbatétel-motorral együtt.

A csomagokat továbbra is a **gépen** állítod össze: ott látszik a teljes lista,
és ott kényelmes gépelni. A telefon indítja és betartatja őket.

Kiút emellett is van, és nem titok: a rendszer VPN-kapcsolója erősebb az
appnál. Ha ott kikapcsolod az alagutat, a szűrés megáll — a blokklistánál is
így van.

## Amit ez a réteg NEM fed

- **Az appok listáját** (`allowApps`) a telefon nem érvényesíti. Androidon az
  alagút appok szerinti szűrése külön mechanizmus, iOS-en pedig egyáltalán
  nincs ilyen. A mezőt mégis tároljuk és szinkronizáljuk, mert a gépen érvényes.
- **A tényleges alagút-viselkedés** csak igazi készüléken derül ki. A CI a
  logikát fedi (magok, összefésülés, számlálók), és a fordítást — de VPN-t nem
  futtat. Ezt nem hallgatjuk el: a „minden letesztelve” itt pont annyira lenne
  igaz, mint a hamis biztonságérzet, ami ellen az egész app szól.
