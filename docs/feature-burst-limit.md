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

- **A beállítás szinkronizálódik** a blokklista rekordján (a lazítást a
  rekord `rev`-je védi, mint minden más oldal-mezőt; egyenlő rev-nél a
  szigorúbb nyer: kisebb adag, hosszabb szünet).
- **A számláló eszköz-helyi** (`HelperState.bursts` / `AppState.bursts`),
  és szándékosan nem megy a drótra: a szinkron tízperces körökben jár, egy
  kétperces adaghoz az túl lassú — ebből nem pontatlan közös számláló lesz,
  hanem őszintén eszközönkénti. Az állapot lemezre íródik: az app kilövése
  nem törli a futó hűtést.
- **Gépen**: a segéd a `usage_batch` mintáiból könyvel, és a commit
  hosts-frissítése azonnal tilt; a hűtés lejártát a 15 mp-es tick nyitja.
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

Az óra átállítása a hűtést is érinti: a lejárat rendszeridőben áll, tehát
aki előretekeri az órát, annak a szünet hamarabb „jár le”. Ez ugyanaz a
kimondott korlát, mint a napi keretnél (lásd feature-daily-limit.md) — a
rendszeróra az igazság, és ezen becsapni csak saját magát tudja az ember.


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

A magot mindkét oldalon teszt fedi (`desktop/test/burst.test.ts`,
`android/jvm-tests/.../BurstTest.kt`) — ugyanazokkal a számokkal, hogy a két
példány ne tudjon szétcsúszni; az öt bekötési pontot az érvényesítés-őr nézi.
