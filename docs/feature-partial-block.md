# Részleges tiltás: nem az egész oldal, csak egy darabja

> „A YouTube maradjon, de EZ a csatorna ne.”

Ez más kérdés, mint az eddigi tiltás, és mielőtt bármi másról szó esne, ki kell
mondani, hogy **miért nem oldható meg a meglévő motorral.**

## A korlát, amit nem lehet megkerülni

A Breaker eddig **DNS-szinten** tiltott. Ez szándékos: a DNS az egyetlen pont,
amit egyszerre lát minden böngésző és minden alkalmazás — ezért él a tiltás
**inkognitóban és vendég módban is**, és ezért nem lehet egy böngésző
beállításával kikerülni.

A DNS viszont **csak a hosztnevet látja**:

```
https://www.youtube.com/@valaki/videos
        └────────────┘ └───────────────┘
         ezt látja       EZT NEM LÁTJA
```

Az út (`/@valaki`) a **titkosított HTTPS-kérésen belül** utazik. Mire a
böngésző elküldi, a DNS-lekérdezés már rég megtörtént — a névfeloldás csak
annyit kérdez, hogy „hol van a youtube.com”. Ugyanez igaz az Android
`VpnService`-re és az iOS csomagalagútra is: azok is DNS-választ adnak.

Ebből következik, hogy **egy csatorna tiltása a jelenlegi motorral fizikailag
lehetetlen** — nem hiányzó munka, hanem a mechanizmus határa. Ha valaki
mégis azt mondja, hogy megcsinálja DNS-sel, az vagy az egész oldalt tiltja le,
vagy nem működik.

## Ami a teljes URL-t látja: a böngésző

Egyetlen hely van, ahol a `/@valaki` látszik anélkül, hogy a titkosítást
feltörnénk: **maga a böngésző**. Egy böngésző-bővítmény látja a címet, meg tudja
állítani a betöltést, és a megjelenített oldalról el is tudja tüntetni a
találatokat.

Ennek **ára van**, és a bővítmény beállítási lapja ki is mondja:

| | Teljes oldal tiltása (DNS) | Részleges tiltás (bővítmény) |
|---|---|---|
| Minden böngészőben | ✅ | ❌ csak ahova telepítve van |
| Inkognitó | ✅ | ⚠️ alapból ki, a felhasználó bekapcsolhatja |
| Vendég mód | ✅ | ❌ ott bővítmény egyáltalán nem fut |
| Más alkalmazások (pl. a YouTube-app) | ✅ | ❌ |
| Kikapcsolható a böngészőben | ❌ | ⚠️ igen |

**A két réteg egymás mellett áll, nem egymás helyett.** A teljes oldal tiltása
marad DNS-szintű és megkerülhetetlen; a részleges tiltás gyengébb réteg, ami az
**ingert veszi el**. Aki azt akarja, hogy a YouTube egyáltalán ne menjen, az
tiltsa az egész oldalt — arra ott a régi út, változatlanul.

Ezt nem szépítjük a felületen sem. Egy önkontroll-appnál a hamis biztonságérzet
rosszabb, mint a bevallott korlát: aki azt hiszi, hogy védve van, nem tesz mást
mellé.

### Amit megfontoltunk és elvetettünk

- **Helyi HTTPS-proxy saját tanúsítvánnyal (MITM).** Látná az utat, viszont egy
  gyökértanúsítványt kellene a rendszerbe telepíteni, amivel onnantól a gép
  MINDEN titkosított forgalma megnyitható. Egy önkontroll-app nem kérhet ekkorát,
  és a tanúsítvány-rögzítést használó appok is elhasalnának tőle.
- **Külön hosztnév a részekhez.** Néhány oldalnál működne, a YouTube-csatornáknál
  nem: mind ugyanazon a hoszton van.

## A szabály alakja

```
youtube.com/@valaki
└────┬────┘└───┬───┘
   hoszt      út-előtag
```

A magja a [`desktop/src/shared/urlrules.ts`](../desktop/src/shared/urlrules.ts),
tesztekkel. Pure és függőségmentes, hogy a Kotlin/Swift oldal pontosan
tükrözhesse — ugyanaz a szabály nem foghat máshogy két platformon.

Amit a normalizálás elvégez, és **miért**:

- **A lekérdezés (`?v=...`) leesik.** Az egy KONKRÉT videó, nem egy csatorna. Ha
  bent maradna, a szabály egyetlen linkre vonatkozna, a felhasználó viszont azt
  hinné, hogy a csatornát tiltotta le. Ez a fajta félreértés csendes: semmi nem
  jelezné, hogy nem az történt, amit akart.
- **Út nélküli szabályt nem fogadunk el.** A `youtube.com` az EGÉSZ oldal, arra
  ott a DNS-blokk. Egy „részleges” szabály, ami mindent tilt, csak félrevezetne
  — ráadásul gyengébb is lenne.
- **Az illeszkedés szegmenshatáron megy**, nem sztring-előtagként. Előtagként a
  `/@ab` ráillene a `/@abc`-re is: egy csatorna tiltása csendben letiltana egy
  másikat, akinek hasonlóan kezdődik a neve.
- **Az aldomain ugyanaz az oldal.** Az `m.youtube.com/@valaki` ugyanoda visz; ha
  csak a pontos hoszt számítana, a telefonos nézet kiskapu lenne.
- **A kis-nagybetű és a záró perjel sosem dönt.** Ha egy szabály hol fogna, hol
  nem, azt senki nem tudná értelmezni — és az app tűnne megbízhatatlannak.

## Mit fog kezdeni ezzel a bővítmény

Két dolgot, és a második legalább annyira fontos:

1. **A navigációt megállítja.** Ha a cím a szabály alá esik, a betöltés helyett a
   Breaker saját lapja jön — ugyanaz a hang, mint a többi tiltásnál.
2. **A találatokat eltünteti a felületről.** A YouTube-főoldalon a csatorna
   videói `/watch?v=...` címre mutatnak, amiben a csatorna NEM szerepel — a
   navigáció megállítása tehát önmagában nem venné el az ingert. A videókártya
   mellett viszont ott a csatorna neve, ami a `/@valaki` címre mutat: a
   bővítmény ezt a linket megtalálja, és a KÖRÜLÖTTE lévő kártyát rejti el.
   Így tűnik el a csatorna az ajánlóból is, nem csak a saját oldala.

## Súrlódás: ugyanaz a szabály, mint mindenhol

A részleges tiltás ugyanabba a rendszerbe illeszkedik, mint a többi:

- **Szabályt felvenni ingyen van** — a szigorítás mindig azonnal érvényes.
- **Szabályt levenni várakozás**: tíz perc, és addig tilt. Enélkül a részleges
  tiltás egy kikapcsoló gomb lenne, és pont az a lényeg, hogy ne az legyen.
- **Meggondolni magad ingyen van**: a visszaszámlálás bármikor megszakítható, és
  a szabály újrafelvétele is visszavonja — a szigorítás sosem kerül semmibe.

A várakozás itt szándékosan egyszerűbb, mint az app próbatételei: a bővítmény
nem tud próbatételt bonyolítani a segéd nélkül, viszont az időt tudja mérni. Tíz
perc nem sok, de pont annyi, hogy az impulzus elmúljon — és a részleges tiltás
pont az impulzus ellen dolgozik. Amikor a szabályok az appból jönnek majd, a
levétel is a rendes próbatételek mögé kerül.

## Állapot

- [x] A szabály magja és a normalizálás, tesztekkel (`urlrules.ts`)
- [x] Böngésző-bővítmény: tiltás, elrejtés, súrlódás, felület
      ([`extension/`](../extension/README.md))
- [x] A szabályok átvétele az appból (helyi híd)
- [x] Kotlin és Swift tükör, és szinkron a fiókon át
- [ ] Aláírt bővítmény-csomag, hogy ne kelljen fejlesztői mód
- [ ] Végponttól végpontig futó teszt valódi bővítmény-betöltéssel

## A híd: hogyan veszi át a bővítmény az app szabályait

A szabályokat az **appban** veszi fel az ember, mert ott van mögöttük a
súrlódás: felvenni egy kattintás, levenni próbatétel. A bővítmény viszont csak
a saját listáját ismerné — vagyis ugyanazt kétszer kellene begépelni, két
helyre. Ami kétszer van, az előbb-utóbb szétcsúszik, és mindenki azt hiszi,
hogy a másik fele is tilt.

A bővítmény nem tud unix socketet olvasni (ott ül a segéd), és fájlt sem. Ami
marad: egy HTTP-végpont. Ezért az asztali app egy **helyi hidat** nyit
(`desktop/src/main/rules-bridge.ts`):

| Döntés | Miért |
|---|---|
| Csak `127.0.0.1` | A szinkron-kiszolgáló a hálózat felé szolgál ki; ez SOHA. A blokklista nem megy ki a Wi-Fire. |
| Kóddal védett | Enélkül a gépen futó bármelyik program elolvashatná, mi van blokkolva. |
| Csak `GET`, egy útvonal | Ha lehetne rajta írni, a bővítmény lenne a legegyszerűbb kiskapu az egész appban. |
| Nincs CORS-fejléc | A bővítmény a `host_permissions` jogán így is olvassa; egy weboldal nem. |
| A port 8788-tól felfelé | A 8788 bármelyik másik program alatt lehet; az app ilyenkor a következőn indul, a bővítmény pedig végigpróbálja. |

A kód az appban, a **Részek** párbeszédben van kiírva; a bővítmény
beállításainál kell egyszer bemásolni.

**Az app szabályai a bővítményből nem vehetők le.** Ez nem hiányzó gomb: ha
onnan is le lehetne szedni őket, tíz perc várakozás váltaná ki a próbatételt.

**Ha az app nincs nyitva**, a bővítmény az utoljára letöltött listát használja —
vagyis tovább tilt, nem enged át. Ez a helyes irány: a hiba a szigorúbb oldalra
dől. Egy elérhetetlen app soha nem jelent „nulla szabályt”, különben a
legolcsóbb feloldás egy ablak bezárása lenne.

### A keresés két határa

A bővítmény húsz másodpercenként keresi meg az appot a saját gépeden, a
127.0.0.1 tíz portján végigmenve (az app a szabadon lévő elsőn indul). Két
dolog van körülötte, és mindkettő ugyanazt a csendes hibát zárja.

**Portonkénti időkorlát (3 mp).** A böngésző `fetch`-ének nincs
alapértelmezett határideje. Ha az egyik porton valami MÁS ül, ami fogadja a
kapcsolatot, de sosem válaszol — egy fejlesztői kiszolgáló, egy proxy —, a
keresés ott áll meg örökre. A bővítmény csendben a régi listával működne
tovább: az appban felvett új tiltás sosem érne át, a levett sosem szűnne meg,
és semmi nem szólna róla. A határidő a válasz TÖRZSÉRE is kiterjed, különben
ugyanez történne, csak eggyel később.

**A sikertelen próbát is megjegyezzük.** A „letelt-e a húsz másodperc” kérdés
korábban csak a SIKERES lekérdezés idejét nézte — azt pedig a sikertelen kör
nem lépteti. Egy zárva lévő app mellett tehát a válasz örökre igen volt, és
minden lapbetöltés újraindította a tízportos pásztázást. A próbálkozás ideje
külön mezőben van, mert a szabálylista FRISSESSÉGÉT továbbra is csak a sikeres
kör mondhatja meg: az app elérhetetlensége nem jelenti azt, hogy nincsenek
szabályok.

## Szinkron: a szabályok a fiókon át

A szabályok a `SyncSite` részei, és minden eszközre elmennek — akkor is, ahol
nem érvényesülnek (Android, iPhone: ott nincs bővítmény-rendszer). Ez nem
fölösleges: a szinkron nem dobhat el olyan mezőt, amit nem ért, különben a
telefon minden körben letörölné a gépen felvett szabályokat.

Az összefésülés a rekord többi mezőjétől külön kezeli őket
(`shared/sync/merge.ts`, `mergeRules`): egyenlő `rev`-nél EGYESÍT (két eszközön
egyszerre felvett szabályból egyik sem veszhet el), nagyobb `rev`-nél a
nyertesé érvényes (az eltávolítás mögött ott a próbatétel), a **hiányzó mező**
pedig nem törlés, hanem „nem tudok róla”.
