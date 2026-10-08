# Fiók és eszközök közti szinkron

> Állapot: **asztali gépen működik**. A tervet és az összefésülés szabályait ez
> a doksi rögzíti; a mag, a kiszolgáló és a felület mind a három platformon
> megvan. Ami hiányzik: egy futó kiszolgáló, amit magadnak kell elindítanod
> (`server/`).

## Mit old meg

Két dolgot, pontosan azt, amit a kérés mond:

1. **Ne kelljen minden eszközön újra felvenni a listát.** Belépsz, és ott van.
2. **Lássam a többi eszköz statisztikáját**, ha ugyanabba a fiókba vagyok belépve
   mindegyiken.

## Az első szinkron, lépésről lépésre

1. **A gépen** nyisd meg a Breakert, görgess a *Fiók és eszközök* kártyáig, és
   nyomd meg a **Kiszolgáló indítása ezen a gépen** gombot. Kiírja a címet
   (`http://192.168.x.y:8787`) — ezt kell majd a telefonba beírni. A macOS
   megkérdezheti, hogy engedélyezed-e a bejövő kapcsolatokat: igen.
2. Ugyanott, a **kiszolgáló címe** mezőbe írd be ugyanezt a címet, a
   **fiókazonosító** mezőbe bármit (például az e-mail-címedet), a jelszó
   legalább 10 karakter legyen. Nyomd meg az **Új fiók** gombot.
3. Felugrik a **helyreállító kód**. Írd fel, és tedd el. Ha a jelszót
   elfelejted, ez az egyetlen út vissza — a kiszolgáló nem tud segíteni, mert
   nem látja az adataidat.
4. **A telefonon** (ugyanazon a Wi-Fi-n) nyisd meg a Breakert, görgess a *Fiók
   és eszközök* kártyáig, írd be UGYANAZT a három adatot, és nyomd meg a
   **Belépés** gombot.
5. Kész: a lista összefésülődik. Ami a gépen volt, megjelenik a telefonon, és
   fordítva — **semmi nem vész el**, mert a belépés egyesít, nem cserél.

Amit érdemes tudni: amíg a gépen az app nem fut (vagy a gép alszik), nincs
szinkron. Semmi nem vész el, a telefon addig a legutóbbi állapotot mutatja, és
a következő elérésnél összefésül.

## Amit NEM old meg — és miért

Ez a rész fontosabb a többinél. Egy blokkoló appnál minden új funkció egyben egy
lehetséges **kibúvó** is. A szinkron különösen: ha rosszul csináljuk, a
„jelentkezz ki” gombból lesz a világ legegyszerűbb feloldása.

| Kísértés | Miért nem |
|---|---|
| Kijelentkezés törölje a blokkokat | Akkor a kijelentkezés EGY GOMBOS feloldás lenne. A kijelentkezés csak a szinkront állítja le; a helyi lista érintetlen marad. |
| Eszköz eltávolítása a fiókból oldjon fel | Ugyanaz, más néven. Az eszköz eltávolítása a kiszolgálón nem nyúl a helyi állapothoz. |
| Belépéskor a kiszolgáló listája írja felül a helyit | Egy üres (vagy régi) fiókkal be lehetne lépni, és ezzel letörölni a helyi blokkokat. Belépéskor **egyesítés** van, nem csere: a két lista UNIÓJA lesz az eredmény. |
| A szünet (ideiglenes feloldás) is szinkronizáljon | Egy próbatétel egy eszközön feloldana MINDENHOL. A szünet szándékosan eszközfüggő és rövid életű. |

Amit a szinkron NEM tud megvédeni, és ezt jobb kimondani: a `rev` számláló
csak a KLIENSEKBEN nő a próbatétel-kapun át. A kiszolgáló átlátszatlan blobot
lát, a kulcs pedig a jelszóból származik — aki tehát tudja a saját
fiókjelszavát, kézzel is összerakhat egy nagy `rev`-ű, laza rekordot, és a
többi eszköz átveszi. Ez a nem megbízható kiszolgáló ára; a részletek és az,
hogy mit változtat (a lécet root helyett a jelszó ismeretére viszi), a
`docs/architecture.md` megkerülési listájában.

Amire a jelszó viszont NEM jogosít, és ezt a kód tartja, nem a doksi: a
szinkronon jött hosztnév nem kerülhet változatlanul a gép root-tulajdonú
hosts fájljába. Minden beérkező név ugyanazon a szűrőn megy át, mint a
helyben felvett (kanonikus hosztnév-alak, se szóköz, se soremelés), és a
blokk kiírása maga is elutasítja a rossz alakot — egy soremeléses „név”
különben tetszőleges `IP név` sort írhatott volna a fájlba, vagyis bármely
oldal átirányítását. A jelszó a SAJÁT lista lazítására jogosít; a gép
névfeloldásának átírására nem.

## Az összefésülés szabálya

Minden oldal-rekord hordoz egy `rev` számlálót (minden módosításnál nő) és egy
`updatedAt` bélyeget. Az alap **utolsó író nyer** (LWW), a döntetlent az
eszközazonosító töri el, hogy minden eszköz UGYANARRA az eredményre jusson.

Ehhez jön egy szabály, ami az app egész logikájából következik:

> **Szigorítás ingyen van, lazítás munkába kerül** — a szinkron ezen nem
> változtathat.

Ezért:

- **A szigorúbb rekord nyer, ha a `rev` egyenlő.** Két eszköz egyszerre módosít,
  az egyik szigorít, a másik lazít: a szigorúbb marad. Így egy versenyhelyzet
  soha nem old fel semmit.
- **Lazítást csak NAGYOBB `rev` hozhat.** A `rev` csak úgy nő, hogy valaki
  ténylegesen végigcsinálta a próbatételt azon az eszközön. Ha egy régi (kisebb
  `rev`-ű), lazább rekord érkezik — hálózati késés, órabaki, visszajátszás —,
  eldobjuk.
- **Törlés átmegy, de a 24 órás türelmi idővel együtt.** A másik eszközön nem
  tűnik el azonnal az oldal: ugyanaddig a határidőig blokkol, és ott is
  visszavonható (a visszavonás szigorítás, tehát ingyen van).
- **A hosztnevek nevenként fésülődnek, jelekkel.** Az oldal névlistája a
  tiltás része (ezek a nevek mennek a hosts fájlba); egy név levétele
  próbatétel, a felvétele ingyen. Mindkettő JELET kap: a rekord `rev`-jét,
  amelyik vitte (`hostnameMarks`, név → rev). Nevenként a nagyobb jel dönt —
  ami annál áll, benne van vagy nincs, az marad; egyenlő jelnél (a jel
  nélküli név is ilyen: régi kliens, az oldal felvételekor kapott nevek) a
  rekord dönt, ahogy a többi mezőnél: eltérő revnél az újabb, egyenlő revnél
  a bővebb. Erre két eset miatt van szükség, és mindkettő a rekord-szintű
  szabály lyuka volt: egyenlő revnél az egyesítés visszahozta a kifizetett
  levételt, ha a másik gép ugyanabban a körben bármi mást írt az oldalra; és
  nagyobb revnél a kétszer író gép egyben hozta a régi listáját. A jel a
  névhez tartozik, nem a rekordhoz, ezért egyik sem történhet meg. A jelet a
  gép segédje írja a `commit()` eleji léptetésben, a lista változásából; a
  telefon jelet nem ír, csak hordozza és fésüli. A jelek plafonja 64
  oldalanként: a jelen lévő nevek jele mindig marad, a levettekből a
  legfrissebbek; egy jó rekordban a jel sosem nagyobb a rekord `rev`-jénél,
  a nagyobbat a bemenet eldobja. Egyenlő pozitív jelnél a jelenlét nyer —
  ez sorrendtől független, és sosem lazább.
- **Vegyes flotta — kimondott korlát.** Egy régebbi kliens a jelet nem
  ismeri, és egyenlő változatnál egyesít. Amíg a fiókban ilyen is van, egy
  új gépen kifizetett levétel oda-vissza járhat (a régi gép körönként
  visszateszi, az új leveszi — a szerver verziója nő, a `rev` nem), a régi
  gép fizetett levételét az új gép jele felülírhatja, és a régi gép ingyenes
  visszavétele az új gépen sosem landol. Blokkolás egyik oldalon sem vész
  el (mindegyik a saját, szigorúbb vagy kifizetett listáját tartja), de a
  régi gép próbatétele hiába. A hurok megáll, amint a régi kliens frissül —
  ezért érdemes minden gépet egyszerre frissíteni.
- **A részleges szabályok jele.** A szabálylista egyben utazik, és a
  fésülésében a JELE dönt (`rulesRev`: az a rev, amelyik a listát utoljára
  változtatta): a nagyobb jel nyer, azonos jelnél egyenlő rev-nél unió,
  különben az újabb rekordé; a mező nélküli (régi) kliens rekordja a másik
  oldal listáját és jelét viszi — nem a saját rev-jével hitelesíti, mert úgy
  három eszköznél az eredmény a sorrendtől függött. A gép bélyegzi a
  léptetésben, a telefon hordozza; a fixtúra és a tesztek mindhárom nyelven
  őrzik. Lásd docs/feature-partial-block.md.
- **A munkamenet-csomagok ugyanígy, csomagonként.** A csomaglista egy
  blobban utazik, és a blob `rev`-jét a telefon egy menet indításával is
  lépteti; jel nélkül egy azonos rev-ű, frissebb telefon-blob egyben hozta
  a régi listáját, és a gépen frissen felvett ablak csendben eltűnt. Most
  minden csomag felvétele, szerkesztése és törlése jelet kap (`packMarks`,
  azonosító → blob-rev), csomagonként a nagyobb jel dönt, jel nélkül az
  újabb blob — ahogy eddig. A gép segédje írja a `commit()` eleji
  léptetésben, a csomagok lenyomatából; egy menet indítása léptet, de
  csomagot nem jelöl. A telefon a saját csomag-szerkesztésénél (az ablak a
  csúcs-órára — az egyetlen, amit telefonról lehet) ugyanígy írja a jelet a
  léptetésében (`SyncRevisions.bumpFocus`), egyébként csak hordozza és
  fésüli; az első léptetés ott is jel nélkül megy.
- **A futó menetről nem a `rev` dönt, hanem a nyoma.** A `rev`-et egy
  csomag átnevezése is lépteti, ingyen — egy független átnézés megmutatta,
  hogy így egy friss telepítés vagy egy hálózaton kívül lévő telefon
  próbatétel nélkül leállította a futó menetet. Most menetet csak a rá
  hivatkozó naplósor zár le (a sor azt a változatot zárja le, amit ismert —
  egy nem ismert hosszabbítás túléli), a kifizetett rövidítésnek számlálója
  van (`cuts`: a több rövidítés nyer, azonos számnál a hosszabb), a menet
  azonossága az eltolás előtti kezdés (`origin`), és a jövőben véget ért sor
  nem számít (öt perc tűrés). A részletek és az őszinte korlátok:
  docs/feature-focus-sessions.md, „A futó menet a szinkronban”.
- **A megbízottat sem a jel viszi el, hanem a levétel nyoma.** A megbízott
  (párban zárolás) eddig a jele szerint fésülődött, és a jelet egy ingyenes
  csomag-átnevezés is lépteti: egy friss eszközön, felhúzott jellel felvett
  saját megbízott minden eszközön leváltotta a valódit. Most a fésülés
  azonosság szerint megy (só és lenyomat): élő megbízottat csak a nyoma
  (`partnersGone`) visz el, ami csak a jelmondatos levételből születik; két
  különböző élő közül egyik sem esik ki — a legkorábban felvett a fő, a többi
  társ (`partnerCo`), és a lazítás végén mindegyikük jelmondata kell. A jel a
  régi kliensek miatt utazik tovább. A részletek és az őszinte korlátok:
  docs/feature-partner-lock.md, „Szinkron”.
- **A futó menet csomagja mindig marad, és a fehérlistája nem bővülhet.** A
  csomagok és a menet külön dőlnek el, és a kettő össze tud akadni: az egyik
  eszköz törölte a csomagot (jellel), a másik ugyanabban a körben menetet
  indított rá. Eddig ezt a menetes blob `rev`-je védte (a csomag „hatásos
  jele” legalább ennyi volt) — de a menetről már nem a `rev` dönt, és egy
  felhúzott jelű törlés különben elvinné a csomagot: a csomag nélküli menetet
  minden fogadó eldobja, tehát ingyenes leállítás lenne. Ezért a futó menet
  csomagja akkor is marad, ha a jelek szerint törölni kellene (a menetet
  hordozó blob változatával, a törlés jelével) — **a törlés így megsemmisül,
  nem halasztódik**; aki törölni akarja, a menet után újra törli (ablakos
  csomagnál próbatétellel). Ez kimondott ár. A csomag mezői (név, hossz,
  ablak) a jelek szerinti győztesé — az ablak felvétele szigorítás, a menet
  alatt is átmegy —, a fehérlistája viszont a menetet hordozó változattal
  METSZET: egy felhúzott jelű bővítés nem nyit meg semmit a menet alatt.
  Csomag nélküli menet a 30-as csomagplafon vágásából sem születik: a menet
  csomagja elöl áll, és a vágásnál a jeles csomag marad, a jeltelen esik ki
  előbb.
- **Három eszköznél kimondott sarok.** Ha két egyidejű menet közül a
  gyengébbet a szigorúbb kiszorítja, a szigorúbbat pedig egy harmadik eszköz
  lezárja, hogy a gyengébb (és a csomagja) visszajön-e, a szinkron
  sorrendjétől függ — konvergál, csak nem mindegy, melyik állapotra. A futó
  menet csomagjának változata is függhet a sorrendtől (a jelenléte nem).
  Mindkét kimenet biztonságos: egyik sem lazít olyat, amiért senki nem
  fizetett. A fuzz-tesztek mindhárom nyelven ezt mérik: a sorrendfüggetlenség
  a menet nélkül teljes, a menetre pedig biztonsági tulajdonságok (a menet
  egy bemeneté, a csomagja a listán van, a fésült napló nem zárja le).
- **Azonos kulcs, más tartalom: a tartalom dönt.** Egy fésülés után minden
  eszköz a győztes (rev, idő, eszköz) kulcsát veszi át, a tartalma viszont
  a saját fésülése — két ilyen blob kulcsa egyezik. Ha ilyenkor az „első
  argumentum” nyerne, a két eszköz egymást választaná győztesnek, és
  örökké egymást írná felül. Ezért azonos kulcsnál egy tartalom-kulcs dönt,
  bájtra ugyanaz a három nyelvben (az iPhone UTF-16 szerint hasonlít, mint a
  gép és az Android, nem a Swift saját rendezésével).
- **A jelek plafonja egy szabály, és szándékosan magas.** Legfeljebb 256
  csomag-jel utazik; a jelen lévő csomagok jele mindig marad, a törölt
  csomagokéból a legnagyobb jelűek férnek be. Ugyanez a szabály a
  fésülésben, a bemenet tisztításában és a gép léptetésében, mindhárom
  nyelvben — ha négy helyen négyféle plafon vágna, a gép, a telefon és a
  kiszolgáló három különböző listát tartana, és minden körben
  feltöltenének. A plafon azért magas, mert egy eldobott sírkő a másik
  eszközön feltámaszthatja a csomagot: 256 jel több mint kétszáz valaha
  törölt csomag, a lista maga 30-as. A bemenet a blob rev-jénél nagyobb
  jelet eldobja (a rev maga nemnegatív egész), és a normalizálásban kieső
  csomag (üres név, a 30-as plafon fölött) jelét is: az nem törölt csomag,
  és a jele meg a hiánya együtt sírkőnek látszana — a csomag mindenhol
  törlődne.

Mit jelent „szigorúbb”:

| Mező | Szigorúbb az, amelyik |
|---|---|
| menetrend | többet tilt (a tiltott percek halmaza bővebb) |
| napi keret | kisebb (a keret nélküli a leglazább) |
| szünet | korábban jár le (a szünet nélküli a legszigorúbb) |
| törlésre várás | nincs törlésre várás |

A mezőket **ebben a sorrendben** vetjük össze, és az első különbség dönt; a
nyertes rekord egyben marad, nem keverünk mezőket két rekordból. Így az eredmény
mindig egy olyan állapot, ami tényleg létezett valamelyik eszközön — nem egy
összeollózott, sosem volt beállítás.

Két kivétel van, mert ezek nem beállítások, hanem folyamatok:

- a **törlésre várás** akkor is átmegy, ha a nyertes rekordban nincs — kivéve,
  ha a nyertes egy KÉSŐBBI körben (nagyobb `rev`) vonta vissza;
- két egyszerre futó törlésnél a **korábbi határidő** marad.

A menetrendek összevetése **szerkezet szerint** megy (hány percet tilt egy
héten), nem időbélyeg szerint. Ez nem szőrözés: két eszköz lehet más
időzónában, és akkor ugyanaz a két menetrend máshogy hasonlítana össze a két
gépen — a szinkron sosem állna meg.

A **statisztika** ennél egyszerűbb: eszközönként, naponként, célpontonként áll
össze, ütközés nincs. Minden eszköz csak a SAJÁT napjait tölti fel, és a többiét
csak olvassa. A felületen eszközönként látszik a mai és a heti idő, meg a hét
három legtöbb időt vivő célpontja.

Legelöl viszont az **összes eszköz együtt** áll, és ez szándékos: a szám, ami
tényleg számít, nem eszközönként van meg. Nem az, hogy mennyi ment el
YouTube-ra a gépen és külön mennyi a telefonon, hanem hogy mennyi összesen. Két
eszközön külön-külön napi húsz perc együtt negyven — fejben ezt senki nem adja
össze.

Az összesítés nem külön összegző kód: a blobokat egyetlen mérés-állapottá
fésüli, és arra ugyanaz az összegző fut, mint a helyi nézeten. Két külön
implementáció előbb-utóbb más számot mutatna ugyanarra a kérdésre. A címke
onnan az eszközről jön, ahol a **legtöbb** időt mérték az adott célponton — ha
a hálózati válaszok sorrendje döntené el, ugyanaz a nézet hol így, hol úgy
nevezné meg ugyanazt.

Ami összeadódik és ami nem: a `site:` kulcs minden platformon azonos, tehát a
**weboldalak tényleg összeadódnak**. Két böngésző-app viszont két külön kulcs,
és ez helyes — a telefonos és a gépes Chrome nem ugyanaz a program.

**iPhone-on ez az egyetlen statisztika, ami valaha látszani fog.** Az Apple nem
enged appnak hozzáférni ahhoz, hogy más appokban vagy weboldalakon mennyi aktív
idő telik, tehát a készülék maga semmit nem mér. Amit viszont megtehet:
elolvasni, amit a gép és az androidos telefon mért. A kártya ki is mondja, hogy
a számokat nem ez a készülék mérte — enélkül a nulla óra úgy nézne ki, mint egy
hiba.

A címkék ugyanazon a tölcséren mennek át, mint a saját statisztika: **ha a lista
rejtve van, sem a másik eszköz adata, sem az összesített sor nem nevezheti meg
az oldalt.** Enélkül a rejtés pont ott lyukadna ki, ahol senki nem keresi — és a
füstteszt ezt külön ellenőrzi.

Maga a **rejtés-beállítás** is átmegy a szinkronon — a `focus` dokumentumban, a
jelével (`hideSiteList`, `hideSiteListRev`), a zárlat-ablakok mintájára:
bekapcsolva bárhol, mindenhol rejtve indul a lista; a kikapcsolás (a készülék
azonosítása után) lépteti a jelet, és a nagyobb jel nyer; azonos jelnél a
rejtett. Részletek: [`feature-hidden-list.md`](feature-hidden-list.md).

## Titkosítás: a kiszolgáló nem látja

Az app eddigi ígérete az volt, hogy „minden mérés ezen a gépen marad”. A
szinkron ezt csak úgy tarthatja meg, ha a kiszolgáló **nem tudja elolvasni**,
amit tárol.

```
jelszó ──scrypt(só = fiókazonosító, N=2^15, r=8)──> gyökérkulcs
                                                     ├── HKDF("auth") ─> belépőkulcs ─> a kiszolgálóra megy (ott újra hashelve tárolják)
                                                     └── HKDF("kek") ──> kulcsburkoló ─> ezzel van becsomagolva az ADATKULCS
```

Az **adatkulcs véletlen**, nem a jelszóból származik, és sosem hagyja el az
eszközt. Ez azért kell, mert így a jelszócsere csak ÚJRACSOMAGOLÁS: nem kell
minden eddigi adatot újratitkosítani — amit a kiszolgáló amúgy sem tudna
megtenni, hiszen nem lát bele.

scrypt, nem Argon2id: az scrypt ott van a Node beépített `crypto` moduljában,
tehát nem kell hozzá külső, natív függőség se a segédbe, se a telepítőbe. A
paraméterek (32 MB, pár tized másodperc) ugyanazt a célt szolgálják — hogy
pontosan 32 és nem 64, annak külön oka van, lásd lejjebb.

A kiszolgáló így csak átlátszatlan blobokat lát: fiók-azonosító, eszköz,
gyűjtemény, verzió, titkosított tartalom. A blokkolt oldalak címét, a
fedőneveket és a mért időket nem.

A jelszóra van egy **alsó hosszkorlát: 10 karakter**, és ez nem formaság. A
jelszó itt nem egy weboldal belépője: ez tartja a kulcsot, ami az adatot nyitja.
Aki a kiszolgálóra betör, offline próbálkozhat vele, korlátlanul — ott már csak
az scrypt lassúsága és a jelszó hossza védi. A karakter itt kódpont, NFKC
után — ugyanaz a mérce mindhárom magban, és a közös fixtúra kimondja: egy
emodzsi egy, egy zászló kettő, mindenhol. (A gép UTF-16 egységben mért, az
iPhone grafémában: öt emodzsi a gépen átment, öt zászló az iPhone-on elbukott.)

Ennek az ára őszintén: **elfelejtett jelszó = elveszett szinkron-adat**. Ezért a
regisztrációnál kapsz egy **helyreállító kódot**, ami ugyanazt az adatkulcsot
nyitja. Ha az is elvész, a helyi állapot akkor is megmarad minden eszközön — csak
az összekapcsolás vész el.

## Kiszolgáló

A szinkron egy **kicsi, magad által is futtatható** szolgáltatással megy: néhány
száz sor Node, SQLite tárolással, Docker-képpel. Nem kell hozzá semmilyen
fizetős szolgáltatás, és mivel a tartalom titkosítva érkezik, nem is kell benne
megbízni.

Az app belépőképernyőjén megadható a kiszolgáló címe. Így aki nem akar semmilyen
külső szolgáltatást, a saját gépén vagy egy ingyenes kis konténerben futtatja.

És mivel a kiszolgálónak nincs egyetlen függősége sem, **be van építve az
asztali appba**: egy gomb elindítja, és kiírja a címet, amit a telefonba be kell
gépelni. Enélkül a szinkron papíron létezne, gyakorlatban nem — terminált
nyitni, Node-ot telepíteni és szolgáltatást futtatni a legtöbben nem fognak, és
igazuk lenne.

A beépített kiszolgáló ára ki van mondva a felületen: **amíg az app nem fut
(vagy a gép alszik), nincs szinkron.** Semmi nem vész el, csak a másik eszköz
addig a legutóbbi állapotot mutatja.

## Ütemezés

| Lépés | Állapot |
|---|---|
| Összefésülési mag + tesztek (`shared/sync/merge.ts`) | kész |
| Titkosítási mag + tesztek (`shared/sync/crypto.ts`) | kész |
| Protokoll (kérés/válasz alakok) | kész |
| Kiszolgáló (Node, függőség nélkül, Dockerrel) | kész — `server/` |
| Verziószám-vezetés a segédben (`helper/revisions.ts`) | kész |
| Szinkron-kliens a segédben (`helper/sync-client.ts`) | kész |
| Segéd-parancsok (`sync_signup`, `sync_signin`, …) | kész |
| Asztali felület (regisztráció, belépés, eszközlista) | kész |
| Android: mag, kliens és felület | kész |
| iPhone és macOS: mag, kliens és felület | kész |

## Ugyanaz a mag három nyelven

Az scrypt a nehéz pont: sem a JDK-ban, sem az Android platform API-jában nincs.
Ami elérhető volna, az vagy külső natív függőség, vagy a platform rejtett
Bouncy Castle példánya, ami nem publikus API. A jelszóból származó kulcsnak
viszont **pontosan ugyanannak** kell kijönnie telefonon és gépen, különben a
másik eszközön nem lehet belépni. Ezért van saját, tiszta Kotlin megvalósítás
(`core/Scrypt.kt`), az RFC 7914 vektoraival ellenőrizve.

Az `N` emiatt 2^15 (32 MB), nem 2^16: ugyanennek le kell futnia telefonon is, és
egy régebbi Android alkalmazás-heapje 64 MB-nál elhasalna. A memóriakötöttség —
ami az scrypt lényege — megmarad.

Amit a tesztek bizonyítanak, és amit másképp nem lehetne:

- az Android mag kibontja azokat a burkolatokat, amiket a **valódi asztali kód**
  gyártott, és ugyanazt a belépőkulcsot állítja elő. Ezek az értékek nincsenek a
  tesztben kiszámolva, csak bemásolva — ha bármi elcsúszik (kulcsszármaztatás,
  HKDF-címke, blob-formátum, base64), a burkolat nem nyílik ki — és ugyanezt
  mondja a közös titkosítás-fixtúra hat fiókra, mindhárom magon (lásd
  lejjebb);
- az Android kliens a **valódi kiszolgálóval** fut végig (gyerekfolyamatként
  indított `server/server.js`): két eszköz, egyesített lista, helyben maradó
  szünet, kijelentkezés után is megmaradó blokkok;
- **az összefésülés maga is megfelelőségi próbán megy át.** A tároló
  gyökerében a `fixtures/merge-cases.json` a gép által kiszámolt
  bemeneteket (véletlen, de rögzített magú oldalak és munkamenet-blobok
  három eszközről: az oldalaknál a hosztnevek a jeleikkel, a törlésre várás,
  a keret, a fedőnév, az indok, a menetrend, az adag és a részleges
  szabályok; a blobokban csomagok, menet, napló — ugyanarról a menetről két
  változat és azonos végű sorok is —, zárlat, ablakok, kulcsszavak,
  megbízott és rejtés, a jeleikkel) és a két, majd három eszköz összefésülésének
  eredmény-kulcsát tartja; a gép tesztje írja és őrzi (elavul, ha a szabály
  változik, és megmondja, hogyan kell frissíteni), a Kotlin
  (`MergeFixtureTest`) és a Swift (`MergeFixtureTests`) teszt ugyanezt a
  fájlt a saját drót-olvasóján át veszi, a saját fésülésével számol, és a
  kulcsnak bájtra egyeznie kell. Mellette nyelvenként egy fuzz-teszt
  (ugyanazzal a véletlennel, mint a gépé) nézi, hogy három eszköz bármilyen
  sorrendben ugyanoda jut. Ha a tükör egy szabályban elcsúszik, a CI bukik
  — a mag számával —, nem egy felhasználó telefonja. És a fixtúra a
  KÜLÖNBSÉGET is nézi: minden esethez egy mező cseréje jár (`flip`), és a
  három nyelvnek ugyanazt kell különbségnek tartania (`sameFocus` /
  `FocusSync.same`) — a jelentés nélküli cserét (időbélyeg, eszköznév,
  ablak-azonosító, a csomagok sorrendje) pedig nem. Az oldalaknál a KÖZELI
  rekordokat is fésüli: az `a` és egy egy mezőben más párja, mindkét
  sorrendben — a szigorúság-lánc (menetrend, keret, adag, törlésre várás) és
  a döntetlen-törés (időbélyeg, eszköznév) éles esetei, amiket a véletlen
  rekordok ritkán hoznak ki. És a használati statisztika EGYESÍTÉSÉT is
  (`combineUsage`): három eszköz mérése — napok, célok, címkék, kapcsoló —
  a dróton át, és a három nyelvnek az összeget, a címke-versenyt és a napok
  sorrendjét is bájtra ugyanúgy kell adnia. És az egyesített mérés
  ÖSSZEGZŐJÉT is (`summarize`): ma, tegnap, hét, hónap, a mai és a heti
  toplisták, a hét az előző héthez — a statisztika képernyőjének számai; az
  iPhone összegzője kevesebbet mond (ma, hét, a mai és a heti vegyes
  toplista), de amit mond, az a gépé. Holtversenyben a kulcs dönt, mindhárom
  magban — a gép és az Android a beszúrás sorrendjére hagyatkozott, az
  eszközönként más lehet. És a DÖNTÉST is: egy oldal, a
  helyi mérés, a többi eszköz mai összegzése és egy időpont — tilt-e most
  (`isBlockedNowWithLimit`): a szünet, a törlésre várás és a közös napi keret
  (a saját sor kihagyva, a nem mai nap kihagyva) mindhárom nyelven ugyanazt
  mondja. A menetrend vagy nincs, vagy egész hetes nyitó sáv (menetrend
  nélkül az oldal mindig zár, és a keret sosem dönt), mert a sávok helyi
  időben értékelődnek ki, és a három teszt a futtató gép időzónájában fut —
  az időpont dél UTC-ben van, hogy a napkulcs ettől még ugyanaz legyen. És
  az ADAG-SZÁMLÁLÓT is (`noteBurstUsage`): egy szabály, nyolc mérés-minta
  (gyűlő, tiszta lappal induló, hűtésbe eső és elkésett), és a számláló
  állapota minden minta után — a gép és az Android tükre; az iPhone nem mér
  előteret, ott a szabály nem érvényesül, tehát ott nincs mit tükrözni. És
  a MUNKAMENET-DÖNTÉST is (`Focus.verdict`): mi mehet egy menet alatt — a
  lista mindig nyer, a kulcsszó a hosztnévben tilt, a csomagon lévő név és a
  saját fiókkiszolgáló átmegy, minden más tiltva, mert a menet fehérlista —
  a két telefon DNS-motora ugyanazt dönti, a gép közös darabjaiból írt
  referencia szerint. A rendszer-infrastruktúra kivétele nincs benne: a két
  telefon listája szándékosan különbözik, azt a `check-infra-allow` őrzi. És a
  MENETRENDET is (`isBlockedBySchedule`, `isLoosening`): kézzel válogatott élek
  (a sávhatár perce másodpercekkel, az éjfélen átnyúló sáv két napja, a sávos
  „mindig”, a csupa rossz sáv) és véletlen heti sávrendszerek — mindhárom
  módban, éjfélen átnyúló és érvénytelen sávokkal —, egy időpont két héten
  belül, és a csere egy másik menetrendre: tilt-e most, és lazítás-e a csere.
  Ez dönt a gépen és a telefonon EGYSZERRE ugyanarról az oldalról. A sávok
  helyi időben értékelődnek ki, ezért a három teszt UTC-ben jár: a gép és az
  Android beállítja, a Swift beállítja, vagy ha nem tudja, kimondva kihagyja.
  És a ZÁRLAT-ABLAKOKAT is, ugyanígy UTC-ben: ablakok (rossz sáv is köztük),
  a csere célja, egy futó, lejárt vagy hiányzó zárlat, egy időpont és a
  közelgő ablak kerete — marad-e szabad idő a héten (`weekHasFreeTime`),
  lazítás-e a csere (`isWindowsLoosening`), az élő ablak előfordulása
  (`dueLockdownWindow`), a zárlat, amit az ablakok most megkövetelnek
  (`windowLockdown`: futó zárlat mellett a kezdése marad, a vége tolódik),
  ablak-zárlat-e (`isWindowLockdown`), a közelgő ablak (`windowStartingSoon`)
  és a következő előfordulás (`nextOccurrence`, amit a csomagok ablaka is
  használ). A heti ablak minden eszközön ugyanakkor zár és ugyanakkor enged;
  ha az előfordulás-számtan elcsúszna, két eszköz más zárlatot állítana elő,
  és a szinkron kettőnek látná. És a MENETEK ÖSSZEGZÉSÉT a naplóból
  (`summarizeFocus` és társai), ugyanígy UTC-ben: véletlen naplók — a mai
  naphoz húzott és három hétre szórt sorok, jövőbeli és nagyon régi sor,
  korai és késői vég, ablakból indult menet, három csomag holtversenyre —, és
  a hét meg az előző hét összegzője (menet, idő, korai vég, ablakból indult, a
  leggyakoribb csomag: holtversenyben az először látott), a menet-napok, a
  menet-órák, a sorozat és a leghosszabb sorozat, az ablakból indult menetek
  csomagonként, a napi rajz. A napló a szinkronon utazik; a statisztika és a
  heti mondat belőle számol mindhárom platformon.
- **a szöveg-tisztítás is megfelelőségi próbán megy át.** A
  `fixtures/text-cases.json` (írja `desktop/test/text-fixture.test.ts`,
  `UPDATE_TEXT_FIXTURE=1 npm test`) a fedőnév, az indok, a kulcsszó és a
  kulcsszó-lista, a megbízott neve és jelmondata, a domain bemeneteit és a
  gép tiszta alakját tartja: kézzel válogatott buktatók (minden szóköz-fajta,
  a BOM, a nulla szélességű jelek, vezérlők ékezettel, NFKC-érzékeny jelek,
  emodzsik a plafon körül) és rögzített magú véletlen összerakások. A Kotlin
  (`TextFixtureTest`) és a Swift (`TextFixtureTests`) ugyanezt a fájlt
  játssza vissza, és a tiszta alaknak bájtra (a Swiftben skalárra) egyeznie
  kell. Ami mögötte áll: a szóköz fogalma a három magban KIMONDOTT lista (a
  JS huszonöt kódpontja — a Java regex `\s`-e csak ASCII, a Kotlin és a
  Swift szóköz-fogalma a BOM-ot nem ismeri), a vágás kódpontban számol
  (nem UTF-16 egységben: a gép egy fél emodzsit hagyott volna a dróton; nem
  grafémában: az iPhone egy zászlót egynek), a kisbetűsítés a JS és a Java
  szabálya szerint megy (a nagy Σ a szó végén ς; a már kisbetűs σ marad σ; a
  Swift `lowercased()` σ-t adott volna, a tükör a Final_Sigma szabályt maga
  alkalmazza az eredeti szövegen — mindkét felét a fixtúra egy-egy CI-köre
  fogta ki), és a tiszta alak tiszta alakja ugyanaz (a megbízott neve nem
  végződik lógó szóközre). A fájl csupa ASCII,
  hogy a láthatatlan jelek láthatók legyenek. Egy szándékos kivétel kimondva:
  a domain-tisztítás egy `www.`-t vág le, nem mindet — nem idempotens,
  mindhárom magban ugyanúgy. És a RÉSZLEGES SZABÁLY is benne van: beírt
  szöveg → kanonikus szabály (`host|path`: séma, felhasználó, `www.` és mobil
  előtag le, lekérdezés és horgony le, dupla perjel egy, az út kisbetűs és
  legfeljebb 200 kódpont), és szabály × cím → illik-e (a hoszt vagy
  aldomainje, az út szegmenshatáron) — kézzel válogatott élek és véletlen
  összerakások, a felük a szabály közelében. A szabályt a gépen és Androidon
  kézzel írják be, és a jelével utazik; az illesztést a gép bővítménye hozza,
  de a mag mindhárom nyelvben ott áll.
- **a párosító kód is megfelelőségi próbán megy át.** A
  `fixtures/pairing-cases.json` (írja `desktop/test/pairing-fixture.test.ts`,
  `UPDATE_PAIRING_FIXTURE=1 npm test`) a gép kimeneteit tartja: cím → kód a
  négy címosztályból, portokkal a határokon és ami nem kódolható; beírt
  szöveg → cím a kézzel írt alakokkal (kötőjel, szóköz, kisbetű, O/0, I/1, a
  török pont nélküli i, nem latin számjegy a kód végén, teljes szélességű
  betű, egy elgépelt karakter, szemét); az egy mező (kód VAGY cím); és a kód
  olvasható alakja. A Kotlin (`PairingFixtureTest`) és a Swift
  (`PairingFixtureTests`) ugyanezt játssza vissza. A gépen kiírt kódot a
  telefonon gépelik be: ha egy bit eltér, a kód nem nyílik ki — vagy MÁS
  címet ad. A Swift párosítónak ez az első tesztje.
- **a heti visszatekintés mondata is megfelelőségi próbán megy át.** A
  `fixtures/digest-cases.json` (írja `desktop/test/digest-fixture.test.ts`,
  `UPDATE_DIGEST_FIXTURE=1 npm test`) egy-egy hét számait és a gép mondatát
  tartja — kézzel válogatott és véletlen hetek, a hiányzó mezőkkel (régi
  hívó) is —, a Kotlin (`DigestFixtureTest`) és a Swift
  (`DigestFixtureTests`) ugyanezt a hetet a saját mondat-írójába adja, és a
  mondatnak bájtra egyeznie kell. Egy kimondott eltérés: a megakadás szava a
  platformé (a gépen a böngésző-bővítmény, a telefonon a DNS-szűrő akaszt
  meg), azt a visszajátszók a gépére írják át a hasonlítás előtt. A számok a
  szinkronon utaznak; ha a három mondat eltérne, a felhasználó ugyanarról a
  hétről három mondatot kapna.
- **a titkosítás is megfelelőségi próbán megy át — a gép burkol, a telefon
  nyit.** A `fixtures/crypto-cases.json` (írja
  `desktop/test/crypto-fixture.test.ts`, `UPDATE_CRYPTO_FIXTURE=1 npm test`)
  a gép valódi kódjával készül: scrypt-vektorok (az RFC kettője), hat fiók
  jelszava és fiókazonosítója, a belőlük származó belépőkulcs, a jelszóval és
  a helyreállító kóddal burkolt adatkulcs, a helyreállító kód kézzel írt
  alakja (kisbetű, szóköz, O a 0 és l az 1 helyett), a gép blobjai és amit nem
  szabad kinyitni — más előtag, csonka, rossz méretű IV és címke, babrált
  titkos és címke, üres titkos, más kulcs. A jelszavak a buktatók: ékezet két
  alakban (NFC és NFD — ugyanaz a kulcs), emodzsi, teljes szélességű betű és
  ligatúra (NFKC után a sima alak — ugyanaz a kulcs), szóköz a szélen (a
  jelszó része; a levágott alak MÁS jelszó), vegyes írás. Mellette a
  helyreállító kód tiszta alakja a buktató jelekre (ß, pont nélküli i,
  ligatúra, különálló ékezet, teljes szélességű betű, emodzsi) és a jelszó
  hossza a korlát két oldalán. A Kotlin (`CryptoFixtureTest`) és a Swift
  (`CryptoFixtureTests`) ugyanezt játssza vissza: egy scrypt fiókonként, és a
  belépőkulcsnak bájtra egyeznie kell, a burkolatnak ki kell nyílnia, a
  blobnak ugyanazt kell adnia, a babráltnak dobnia. A blobok IV-je itt
  rögzített magú (a fájl kétszer ugyanaz), a termék titkosítója véletlent húz
  — ezt a három teszt külön nézi. A Swift titkosításának és scryptjének ez
  az első tesztje; az első írása két eltérést igazított: az iPhone a
  helyreállító kódot grafémánként szűrte, és a jelszó hosszát a három mag
  három mércével mérte — most kódpontban, NFKC után, mindhárom.
- **a közös keret blobja is megfelelőségi próbán megy át.** A
  `fixtures/limit-cases.json` (írja `desktop/test/limit-fixture.test.ts`,
  `UPDATE_LIMIT_FIXTURE=1 npm test`) a dróton jövő mai összegzést a blob
  SZÖVEGÉBŐL olvastatja mindhárom maggal (`parseTodayDigest`): a blob alakja
  (nem objektum, hibás JSON, tömbként érkező másodpercek), a nap (ASCII
  számjegy, szóköz és sorvég a szélén, arab-indiai és teljes szélességű
  számjegy), a szám élei (kerekítés a felénél, egy napra vágás, negatív, nulla,
  kitevős alak) és ami nem szám (szöveg, igaz/hamis, null, objektum), a kulcsok
  (üres, `__proto__`, ékezet, emodzsi), és a 200-as plafon fölötti vágás sok
  holtversennyel. Mellette a keret betelt napjai és sora, a „ma még N perc”, a
  lazítás, a hátralévő, és a döntés a többi eszköz percével — UTC-ben. A Kotlin
  (`LimitFixtureTest`) és a Swift (`LimitFixtureTests`) ugyanezt játssza
  vissza.
- **a munkamenet magja is megfelelőségi próbán megy át.** A
  `fixtures/focus-cases.json` (írja `desktop/test/focus-fixture.test.ts`,
  `UPDATE_FOCUS_FIXTURE=1 npm test`) az ismétlődő menet indulását (előfordulás,
  esedékes ablak, holtverseny), az ablak-menetet, a lezárást, a legutóbb
  használt csomagot, a hátralévő idő szövegét és a percek tisztítását tartja,
  UTC-ben; a Kotlin (`FocusFixtureTest`) és a Swift (`FocusFixtureTests`)
  ugyanezt játssza vissza. A csomag engedélyezett appjainak neve a fiókon
  utazik — a szöveg-fixtúra ennek a tisztítását és az app-egyezést is nézi,
  és a csomag nevét meg a naplósor nevét is (`normalizePackName`,
  `logPackName`: a közös sor-tisztítás, 40 kódpont; üres naplónévre
  „Ismeretlen csomag”).
- **egy rossz rekord nem viszi a többit.** A `fixtures/wire-cases.json` (írja
  `desktop/test/wire-fixture.test.ts`, `UPDATE_WIRE_FIXTURE=1 npm test`)
  dróton jött oldal-listákat és munkamenet-dokumentumokat tart hibás
  elemekkel (nem objektum, rossz azonosító vagy domain, szövegként írt szám,
  szám-azonosító, nem lista mező, nem egész jel), és a gép olvasójának
  eredményét. A szabály: a rekord csak az azonosító (az oldalnál a domain)
  hibájára esik ki, minden más rossz típusú mező az alapértékét kapja, és a
  jelek értékenként tűrnek. A kiesett, de szöveg-azonosítójú csomag „látott”:
  a jele is kiesik, különben sírkőnek látszana. A Kotlin (`WireFixtureTest`)
  és a Swift (`WireFixtureTests`) a szinkron saját olvasóján át játssza
  vissza. Az iPhone eddig a listát egyben dekódolta — egy rossz rekord az
  egészet vitte, és a kör a saját listáját tolta fel a többiek helyett; egy
  nem JSON blokklista-blob most megállítja a kört, mint a gépen és Androidon.
  A menetrend is sávonként tűr (lásd `docs/feature-schedules.md`): a gép
  döntését eddig egy nem tömb sávlista ledöntötte. És a munkamenet-dokumentum
  többi mezője is: a futó menet, a zárlat, a zárlat-ablakok (a rossz nap csak
  magát viszi, nem az ablakot), a kulcsszavak és a megbízott — az iPhone eddig
  egy rossz ablak vagy kulcsszó miatt az összeset eldobta, az Android a
  szövegként írt zárlat-véget is időnek vette, a gép a „540” szöveget és a
  `null`-t is percnek. A többi eszköz mérése ugyanígy (lásd
  `docs/feature-usage-stats.md`).

Egy dolog iPhone-on más: a **napi keret nem érvényesül** (nincs ilyen mérési
API), de a rekordban MEGŐRIZZÜK. Enélkül elég lenne egyszer megnyitni a
telefont ahhoz, hogy a gépen beállított keret eltűnjön mindenhonnan: a telefon
egy keret nélküli rekordot tolna fel, és az összefésülés azt látná friss
állapotnak.

És egy, ami a három nyelv közötti átjárásban derült ki: a Swift `JSONEncoder`
alapból **kihagyja a nil mezőket**. A TypeScript oldalon a `pendingDeleteAt`
típusa `number | null`, és a fésülés `!== null`-t néz — egy hiányzó kulcsból
`undefined` lesz, ami nem null, vagyis minden oldal úgy nézne ki, mintha
törlésre várna. A Swift ezért kézzel írja ki a mezőt, a TS oldal pedig
beérkezéskor kiegyenesíti a rekordokat.

### Új mező a munkamenet-dokumentumban: hány helyen kell átmennie

A v0.4.170-ben a lista rejtése (`hideSiteList` + `hideSiteListRev`) került a
munkamenet-dokumentumba, a megbízott mintájára. A Swift-tükörben három helyen
maradt ki — és a háromból csak EGYET fogott ki a fixtúra. Ez a lista azért
van, hogy a következő mezőnél ne kelljen újra megtalálni a helyeket. Egy
fiók-szintű mezőnek a jelével nyelvenként ezeken kell átmennie:

| Hely | Gép (TS) | Android (Kotlin) | iPhone/Mac (Swift) |
|---|---|---|---|
| a rekord mezői | `SyncFocus` (`focus-merge.ts`) | `FocusSync.SyncFocus` | `FocusSync.SyncFocus` + `init(from:)` (a hiányzó kulcs nem dobhat) |
| bejövő normalizálás — a jel legfeljebb a blob `rev`-je | `normalizeSyncFocus` | `SyncClient.focusFromJson` | `FocusSync.normalize` — ÚJRAÉPÍTI a rekordot |
| fésülés | `mergeFocus` | `FocusSync.merge` | `FocusSync.merge` |
| egyezés-kulcs (kell-e feltölteni, kell-e beírni) | `sameFocus` | `FocusSync.same` | `FocusSync.same` |
| drót kifelé | a rekord maga | `SyncClient.focusToJson` | `Encodable` (a nil kimarad — az igazként utazó mezőnek jó) |
| építés az állapotból | `sync-client.ts` | `SyncClient` | `SyncClient` |
| átvétel az állapotba | `sync-client.ts` | `SyncClient` | `SyncClient` |
| lenyomat (mitől „változott”) | `revisions.ts` | `SyncRevisions.focusFingerprint` | `SyncRevisions.focusFingerprint` |
| üres-vizsgálat (az első léptetés ne üresen legyen) | `isEmptyFocus` | `bumpFocus` üres ága | `bumpFocus` üres ága |
| a jel bélyegzése léptetéskor | `bumpFocusRevision` | `bumpFocus` | `bumpFocus` |
| az átvétel kulcsa (az átvett jelet ne írja felül a következő saját szerkesztés) | `adoptFocusRevision` | `adoptFocus` | `adoptFocus` |
| mentés | `state.ts` | `Store.kt` | `AppState` (`Codable`) |

És ami a tesztelést hordozza — ezek nélkül a fenti sorok egy része csendben
kimaradhat:

- a fixtúra generátora és kulcsa (`desktop/test/merge-random.ts`): a mező
  húzása feltétel nélkül, mindhárom nyelvben ugyanabban a sorrendben, és
  benne a `focusConformanceKey`-ben; a Kotlin/Swift visszajátszás kulcsa
  (`MergeFixtureTest` / `MergeFixtureTests`) bájtra ugyanaz;
- a fuzz-generátorok nyelvenként (`MergeFuzzTest` / `MergeFuzzTests`) —
  ugyanazok a húzások, ugyanabban a sorrendben;
- a drótnevek listája (`scripts/check-wire-names.js`) — ami azt is nézi,
  hogy minden őrzött drót-mező szerepel a fixtúra generátorában: egy új mező
  nem maradhat ki csendben az összevetésből (a jelenlétét nézi, nem azt, hogy
  a generátor húz is rá — arra a lefedettséget néző szem marad);
- nyelvenként saját teszt a mezőre (a gépen a `hide-sync.test.ts`, Androidon
  a `HideSyncTest`, iPhone-on a `HideSyncTests` a minta): a fésülés, a drót
  és a normalizálás, a jel léptetése, az átvett jel, a mentés;
- tűk (`scripts/check-enforcement.js`) a három elveszési helyre:
  normalizálás, egyezés-kulcs, átvétel.

Melyik őr mit fog ki — és mit nem:

- a **fixtúra** a normalizálás és a fésülés útját fogja. A v0.4.170-ben ez
  fogta ki a Swift `normalize` rését: a dekódolás megvolt, a fésülés megvolt,
  a kettő között veszett el a mező. A v0.4.173 óta az egyezés-kulcsot is: egy
  mező cseréje mindhárom nyelvben különbség-e. NEM fogja az átvételt és a jel
  bélyegzését — azok nem a fésülés részei;
- a **nyelvenkénti teszt** fogja az egyezés-kulcsot a mező felől (a cseréje
  különbség-e) és az átvétel kulcsát (az átvett jel marad-e egy saját
  szerkesztés után) — a másik két Swift/Kotlin rés ezeken derült ki;
- a **tűk** azt fogják, ha egy sor eltűnik — nem azt, ha rossz.

A tanulság röviden: egy fiók-szintű mező nem „egy mező”, hanem tizenkét hely
nyelvenként; és a fixtúra, bármilyen jó, a tizenkettőből hármat lát.

Az oldal-rekordra ugyanez áll, egy különbséggel: a telefonok az oldal-listát
szerkezeti egyenlőséggel hasonlítják (ott minden mező benne van), a gép
kanonikus kulccsal (`sameSites`), hogy a mezők sorrendje és a másik platform
kihagyott nil-jei ne látszódjanak változásnak. A kanonikus kulcsnak tehát
minden utazó mezőt néznie kell — az adag-szabály a v0.4.176-ig hiányzott
belőle; a rev-léptetés elfedte, a teszt és a tű most őrzi.

## Mikor szinkronizál magától

A felhasználó nem fogja nyomkodni a „Szinkronizálás most” gombot. Ha csak kézzel
menne, a másik gépen felvett oldal órákig nem érne ide — és pont ez az, amiért az
egész funkció van. A segéd ezért magától is dolgozik:

| Mikor | Miért |
|---|---|
| induláskor | a gép bekapcsolása után rögtön a többiekhez igazodik |
| minden változás után 20 másodperc csenddel | egy műveletsor (felvétel, keret, menetrend) EGY feltöltés legyen, ne három |
| tízpercenként | hogy a másik gép írását magától is észrevegye |

Telefonon más a ritmus: ott a **megnyitáskor** szinkronizál. Percenként
ébresztgetni a hálózatot értelmetlen lenne — az app akkor számít, amikor épp
nézed. Viszont akkor számítson: aki a gépén felvett egy oldalt, azt a telefonján
a megnyitáskor lássa, ne csak akkor, ha eszébe jut megnyomni egy gombot. Ha
épp nincs hálózat, a megnyitás nem hibaüzenettel kezdődik — a fiókkártyán ott
áll, mikor volt utoljára szinkron.

Egy elhasalt kör nem naplózódik újra meg újra: offline gépnél az percenként
ismétlődő, haszontalan sor lenne. Az állapotba viszont bekerül, és a felület
kiírja, hogy mi nem megy.

Az ütemezés **külön fájlban** van (`helper/sync-schedule.ts`), tesztekkel — mert
a huzalozás egy csúnya hurkot rejt, amit ránézésre semmi nem árul el:

```
a szinkron a végén MENT,
a mentés viszont ÜTEMEZ egy szinkront (hogy a változás felmenjen),
az a szinkron megint ment…
```

Így a segéd húsz másodpercenként, örökre verte volna a kiszolgálót — miközben
minden egyes függvény külön-külön helyes. Ezért tart számon az ütemező egy
futás közbeni állapotot: a kör saját mentése nem ütemez újat. Ezt öt teszt őrzi, köztük az is,
hogy két kör sosem fut egyszerre ugyanazon az állapoton.

## Ami a segédben fut, és miért

A szinkron kliensoldala a **segédben** van, nem a felületen. Két oka van:

1. Itt van a blokklista igazsága. Ha a felület intézné, egy módosított kliens
   kikerülhetné a „nem old fel semmit” szabályt.
2. Itt van az **adatkulcs** is. A végpontok közti titkosítás a KISZOLGÁLÓ ellen
   véd, nem a saját géped ellen — de attól még nem kell, hogy minden felhasználói
   folyamat elolvashassa.

A `rev` számlálókat egyetlen fogópont vezeti: a segéd `commit()`-ja. Minden
rekordhoz eltesszük a szinkron-mezők lenyomatát; ha az változott, a számláló nő.
A lenyomat a mentett állapotban van, tehát egy újraindítás nem hajtja fel a
számlálót a semmiért. Kézzel vezetve reménytelen lenne: tucatnyi helyen módosul
egy rekord, és egyetlen kihagyott hely elég ahhoz, hogy egy változás sose menjen
át a másik eszközre.

A **szünet fel se megy** a kiszolgálóra, és a letöltött adat nem is írja felül a
helyit. Nem elég az összefésülésre bízni: egy ÚJ eszköznek nincs saját, szigorúbb
rekordja, tehát azt venné át, ami jött — szünetestül.
