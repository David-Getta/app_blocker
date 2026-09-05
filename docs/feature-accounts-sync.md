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
  telefon jelet nem ír, csak hordozza és fésüli. Egy régebbi kliens a jelet
  nem ismeri, és egyesít — amíg a fiókban ilyen is van, a levett név oda-vissza
  járhat: frissítés után rendeződik.

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
az scrypt lassúsága és a jelszó hossza védi.

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
  HKDF-címke, blob-formátum, base64), a burkolat nem nyílik ki;
- az Android kliens a **valódi kiszolgálóval** fut végig (gyerekfolyamatként
  indított `server/server.js`): két eszköz, egyesített lista, helyben maradó
  szünet, kijelentkezés után is megmaradó blokkok.

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
