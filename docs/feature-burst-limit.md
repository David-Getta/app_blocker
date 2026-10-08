# Adag-szabály: ennyi használat után ennyi szünet

A felhasználó kérése szó szerint: „be lehessen állítani a weboldalaknál, hogy
bizonyos használati idő után, bizonyos ideig tiltsa le… pl: gemini 2 perc
használata után 10 perc tiltás utánna feloldódik.”

A napi keret testvére, más alakú lyukra: a keret a napi összesenről szól, ez
arról, hogy egyszerre mennyi fér. Nem büntetés, hanem ütem — a rövid
odapillantás belefér, a belefeledkezés nem.

## Hogyan működik

- Az oldal rekordján két szám: **adag** (`burstSeconds`) és **szünet**
  (`cooldownSeconds`). Csak együtt értelmesek; fél-kitöltött állapot nincs.
- A mérés kötegekben érkező mintáiból oldalanként **adag-számláló** gyűlik
  (`shared/burst.ts` / `core/Burst.kt`). Ha eléri az adagot, indul a
  **hűtés**: az oldal DNS-szinten zár (minden böngészőben és appban), a
  számláló nullázódik, és a hűtés lejártával az oldal magától kinyílik.
- Ha egy hűtésnyi ideig nem használtad az oldalt, a számláló tiszta lappal
  indul — e nélkül a hetekkel korábbi fél percek is összeadódnának, és a
  tiltás az égből esne az emberre.
- Hűtés alatt a mért idő NEM számít (a tiltott oldal hibalapján ülve mért
  másodpercek különben újraindítanák a hűtést), és egy elkésett, régi minta
  nem gyárthat hamis pihenőt (a `lastAt` nem lép hátra).

## Felület

- Az oldal sorában egy **Adag** gomb nyitja a párbeszédet. Két sor: *ennyi
  használat után…* és *…ennyi szünet*.
- Kínált értékek: adagnak 2 / 5 / 10 / 15 / 30 perc, szünetnek 5 / 10 / 15 /
  30 / 60 / 120 perc — és **mindkettőhöz saját érték is beírható** (1 perctől
  egy napig), a gépen és a telefonon egyaránt. Az öt perces szünet azért van a
  gombok között, mert a rövid ütem a leggyakoribb kérés (öt perc használat,
  utána öt perc szünet); a telefonon korábban gomb sem volt rá, és saját
  mező sem — vagyis ugyanaz a szabály két eszközön két különböző dolgot
  engedett.
- A sorban futó mérce mutatja, mennyi van még az adagból, hűtés alatt pedig
  azt, mikor nyílik ki magától.
- **A böngésző lapja előre szól**, mielőtt az adag betelik: a tetején egy
  sáv mondja, hogy az adagból ezen az oldalon kevesebb mint ennyi perc
  maradt, és utána mennyi a szünet. A küszöb az utolsó két perc, de
  legfeljebb az adag fele — egy kétperces adag ne az elejétől szóljon. Az
  app a hídon a hátralévő aktív másodperceket adja le (`soon`, `burst`
  fajta), mint a napi keretnél; a bővítmény a lehúzás óta eltelt időt
  levonja. Bezárható, és ugyanarra nem jön vissza.

## Súrlódás — ugyanaz az irány, mint mindenhol

| Művelet | Ára |
|---|---|
| Szabály felvétele | ingyen — szigorítás |
| Kisebb adag vagy hosszabb szünet | ingyen |
| Nagyobb adag vagy rövidebb szünet | próbatétel |
| A szabály levétele | próbatétel |

Vegyes módosításnál a lazító fele dönt. A futó hűtést a csere nem engedi el:
azt az addigi használat kereste meg, és magától jár le — a csere a KÖVETKEZŐ
adagra szól. A megvásárolt szünet (feloldás) viszont a hűtést is legyőzi,
ugyanazért, amiért a napi keretet: próbatétellel fizettek érte.

## Mi hol él

- **A beállítás szinkronizálódik** a blokklista rekordján. A lazítást a
  saját kifizetett számlálója viszi át (`burstLoosens`: a bíró lépteti a
  próbatétel teljesítésekor); egyenlő számnál a két szabály szigorúbbja jön
  ki — a kisebb adag ÉS a hosszabb szünet, akár két rekordból összerakva. A
  rekord `rev`-je nem hitelesít lazítást (lásd docs/feature-accounts-sync.md).
  **A gép csak a v0.4.227 óta teszi a drótra** (`sync-client.ts`
  `toSyncSites` / `fromSyncSites`) — előtte kihagyta, a rev-et viszont
  léptette. Ebből két hiba lett, amit egy független átnézés talált: a gépen
  beállított szabály sosem ért át, a telefonon beállítottat pedig a gép egy
  ingyenes szerkesztése (fedőnév, indok — nagyobb rev, adag nélkül)
  mindenhonnan letörölte, próbatétel nélkül. **Átmenet:** a régi
  állapotfájl betöltése egyszer megjelöli a gép helyi adag-szabályait
  (`burstUnsynced`), és az első kör friss szigorításként teszi rá őket a
  fésülés eredményére (`reapplyUnsyncedBursts`: mezőnként a szigorúbb,
  eggyel nagyobb rev-vel) — így egy közben történt telefonos írás sem
  viszi el. **Őszinte korlát:** amit a régi gép a telefonról már
  letörölt, azt nem tudjuk visszahozni — az a fiókban sehol nincs meg. Ha
  egy telefonon beállított adag-szabály eltűnt, állítsd be újra.
- **A számláló eszköz-helyi** (`HelperState.bursts` / `AppState.bursts`),
  és szándékosan nem megy a drótra: a szinkron tízperces körökben jár, egy
  kétperces adaghoz az túl lassú — ebből nem pontatlan közös számláló lesz,
  hanem őszintén eszközönkénti. Az állapot lemezre íródik: az app kilövése
  nem törli a futó hűtést.
- **Gépen**: a segéd a `usage_batch` mintáiból könyvel, és a commit
  hosts-frissítése azonnal tilt; a hűtés lejártát a 15 mp-es tick nyitja.
  A betelés pillanatában és a szünet leteltekor **az app értesítést dob**
  (`shared/burst-notify.ts`: két egymás utáni státusz-kép különbségéből) —
  az Android tartós értesítésének gépes párja. Őszinte korlát: csak amíg az
  app fut, mert a segéd arc nélküli démon, értesítést dobni nem tud — az app
  ezért a háttérben fut tovább, és bejelentkezéskor rejtve indul; a mérés,
  amiből az adag fogy, ugyanígy az appban jár. Az
  induláskor már futó hűtésre nem mond „most telt be”-t (a kezdetét nem
  látta), a leteltét viszont bejelenti; a vége ELŐTT eltűnő hűtésről
  (megváltott szünet, levett szabály, törölt oldal) hallgat — ott a
  felhasználó maga cselekedett, és az értesítés tényt mond, nem találgat.
- **Androidon**: a mérő `flush`-a könyvel, a DNS-szűrő minden feloldásnál
  friss `now`-val dönt — a hűtés ott is magától indul és jár le. A telefonon
  tiltó lap nincs (a DNS-válasz elmarad, a böngésző hálózati hibát mutat),
  ezért futó hűtés alatt a **tartós értesítés** mondja meg, mi történt és
  mennyi van hátra (`BreakerStore.coolingSites`) — ugyanazért, amiért
  munkamenet alatt is az beszél.
- **iPhone-on NEM érvényesül**: ott nincs előtér-mérés, amiből az adag
  gyűlne. A mezők viszont a HELYI rekordon is ott vannak, nem csak a
  dróton — e nélkül a szinkron-leképezés eldobná őket, és egy iPhone-on
  tett bármilyen oldal-szerkesztés (rev-emelés) letörölné a szabályt a
  többi eszközről is (ez volt a v0.4.18 előtti hiba). A telefon ki is
  írja a szabályt az oldal sorában, kimondva, hogy ott nem érvényesül.
- **A böngészőben a tiltó lap magyaráz** (összekötött bővítmény mellett):
  hűtésnél a nyers „nem sikerült kapcsolódni” hibalap helyett a bővítmény
  saját lapja jön — kimondja, hogy az adag telt be, és visszaszámol a
  nyitásig. Ez magyarázat, nem érvényesítés: a tiltást a DNS tartja, a lap
  pedig csak FRISS adatból beszél (a segéd `closed` listája a hídon; ha az
  app nem elérhető vagy a hűtés ideje lejárt, a lap inkább hallgat, mint
  hogy zárva-t mondjon egy már kinyílt oldalra). Bővítmény nélkül — más
  böngészőben, inkognitóban — marad a hibalap, a tiltás attól még él.

## Pontosság — kimondva

**Az óra átállítása nem rövidíti a hűtést.** Sokáig ez kimondott korlát
volt, a napi keret mintájára — de a hasonlat hamis volt: a keret egy NAPHOZ
tartozik (ott az óraugrás és az alvó gép napváltása nem különböztethető meg),
a hűtés viszont IDŐTARTAM, mint a munkamenet. Az ugrást tehát ugyanúgy el
lehet nyelni: a segéd (és az Android) karbantartó köre az óraugrásnál a most
tartó hűtés végét is eltolja — **amennyi hátra volt, annyi van hátra**
(`shiftCooldowns`, mindkét magban). Eddig az óra tíz perccel előretekerése egy
egész szünetet átugrott.

A számláló többi része NEM tolódik: a lecsukott gép ideje pihenőnek számít,
nem adagnak. Ha egy adag közepén csukod le a laptopot, reggel tiszta lappal
indul — nem tíz másodperc után jön a szünet. Az ár: az óra előretekerése
legfeljebb egy adagnyi friss időt ad, a szünetet viszont nem rövidíti.


A mérés kötegekben érkezik (gépen ~fél percenként, telefonon hasonló
ütemben), tehát az adag betelte és a tiltás közt PÁR MÁSODPERC csúszás
lehet, a hűtés vége és a tényleges kinyílás közt legfeljebb egy tick (15 mp)
plusz a rendszer DNS-gyorsítótára. Ez nem hiba, hanem a mérés természete —
a lényegen (2 perc után zár, 10 perc múlva nyit) nem változtat.

## A lánc

1. A felület (`openBurstDialog` / `BurstDialog`) a refereen át állít
   (`startBurstChange`): szigorítás azonnal, lazítás `pendingBurst`-tel a
   próbatétel teljesítésekor.
2. A mérés mintái a számlálóba is könyvelődnek (`noteBurstUsage`).
3. A tiltás-döntés (`isBlockedNowWithLimit`) a hűtést is nézi — gépen a
   hosts-fájl, telefonon a DNS-szűrő ebből dolgozik.
4. A felület mérő-sora megmondja, mennyi fér még az adagba, hűtésnél pedig
   visszaszámol — a szín mellett szövegben is. Ugyanitt áll a MAI betelések
   száma („ma 2× betelt”) — eszköz-helyi darabszám, napfordulón tiszta
   lappal; azt mutatja meg, hogy a szabály tényleg dolgozik, és mennyit fog.
   A HÉT is: a betelések könyve (oldal → nap → darab, hét napig; a segédnél
   `burstTripLog`, Androidon az állapotban) a statisztikán a hét összegét
   mondja — „Adag-betelések a héten: youtube.com 5× · reddit.com 2×” —, de
   csak akkor, ha a hét több a mainál; különben a mai sor elég. Eszköz-helyi,
   mint a mai szám; a fiókba nem megy. Az oldal sora is mondja („· ma 2×
   betelt · a héten 7×”), és a heti mondat: „Az adag a héten 7× telt be.” —
   nulla nem mondat. iPhone-on nincs adag-szabály, ott ez nem áll.

A magot mindkét oldalon teszt fedi (`desktop/test/burst.test.ts`,
`android/jvm-tests/.../BurstTest.kt`) — ugyanazokkal a számokkal, hogy a két
példány ne tudjon szétcsúszni; a hét bekötési pontot (a kettő új: a gépes
értesítés lépegetője és kirakása) az érvényesítés-őr nézi.
