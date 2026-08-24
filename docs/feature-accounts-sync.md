# Fiók és eszközök közti szinkron

> Állapot: **asztali gépen működik**. A tervet és az összefésülés szabályait ez
> a doksi rögzíti; a mag, a kiszolgáló, a segéd kliensoldala és az asztali
> felület megvan. A telefonok ezután jönnek.

## Mit old meg

Két dolgot, pontosan azt, amit a kérés mond:

1. **Ne kelljen minden eszközön újra felvenni a listát.** Belépsz, és ott van.
2. **Lássam a többi eszköz statisztikáját**, ha ugyanabba a fiókba vagyok belépve
   mindegyiken.

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
csak olvassa.

## Titkosítás: a kiszolgáló nem látja

Az app eddigi ígérete az volt, hogy „minden mérés ezen a gépen marad”. A
szinkron ezt csak úgy tarthatja meg, ha a kiszolgáló **nem tudja elolvasni**,
amit tárol.

```
jelszó ──scrypt(só = fiókazonosító, N=2^16, r=8)──> gyökérkulcs
                                                     ├── HKDF("auth") ─> belépőkulcs ─> a kiszolgálóra megy (ott újra hashelve tárolják)
                                                     └── HKDF("kek") ──> kulcsburkoló ─> ezzel van becsomagolva az ADATKULCS
```

Az **adatkulcs véletlen**, nem a jelszóból származik, és sosem hagyja el az
eszközt. Ez azért kell, mert így a jelszócsere csak ÚJRACSOMAGOLÁS: nem kell
minden eddigi adatot újratitkosítani — amit a kiszolgáló amúgy sem tudna
megtenni, hiszen nem lát bele.

scrypt, nem Argon2id: az scrypt ott van a Node beépített `crypto` moduljában,
tehát nem kell hozzá külső, natív függőség se a segédbe, se a telepítőbe. A
paraméterek (64 MB, pár tized másodperc) ugyanazt a célt szolgálják.

A kiszolgáló így csak átlátszatlan blobokat lát: fiók-azonosító, eszköz,
gyűjtemény, verzió, titkosított tartalom. A blokkolt oldalak címét, a
fedőneveket és a mért időket nem.

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
| Android és iPhone | utána |

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
