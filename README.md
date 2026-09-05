<p align="center"><img src="website/icon-512.png" alt="Breaker" width="96" /></p>

# 🔒 Breaker

Weboldal-blokkoló **önkontroll-app** négy platformra: **Android, Windows, macOS
és iPhone**. Megadsz egy weboldalt (pl. `www.youtube.com`), és a Breaker
letiltja — úgy, hogy **inkognitó és vendég módban se** legyen elérhető.

A feloldás szándékosan **nem egyetlen gomb**: valódi erőfeszítést igénylő,
**változatos próbatételeket** kell teljesíteni, amelyek **nem válnak könnyebbé**
attól, hogy sokszor csinálod.

> Ez egy első, működő alap. A tulajdonságok később bővíthetők — a mag úgy készült,
> hogy erre nyitott legyen.

## Mit tud most

- **Oldal blokkolása** egy link beillesztésével. A cím normalizálása kényelmes
  (`https://www.youtube.com/watch?v=…` → `youtube.com`), és ismert
  szolgáltatásoknál a társoldalakat is blokkolja (pl. `youtu.be`,
  `m.youtube.com`).
- **DNS-szintű tiltás**, ezért **minden böngészőben és appban** hat, beleértve az
  **inkognitó/privát és vendég** munkameneteket.
- **macOS-en nincs „minden indításnál engedélyezés”**: a háttérszolgáltatás
  egyszeri jóváhagyással települ, és onnantól magától indul.
- **Súrlódásos, változatos feloldás** (lásd lentebb).
- **Végleges törlés 24 órás türelmi idővel** — a legnehezebb út, ami impulzusból
  nem végezhető el.
- **Időzített menetrend**: egy oldal tiltható csak bizonyos sávokban (pl. munkaidő),
  vagy fordítva, csak bizonyos sávokban engedélyezhető. Szigorítani egy kattintás,
  **lazítani ugyanúgy próbatételekbe kerül**, mint egy feloldás.
- **Aktív idő mérése és statisztikák**: melyik oldalon és appban mennyit töltesz —
  **csak amikor tényleg ott vagy** (fókuszban lévő ablak, aktív fül, nem tétlen),
  nem attól, hogy nyitva van. Napi/heti/havi bontás, top lista, 30 napos idősor,
  hét-a-héthez összevetés. Fiók nélkül minden adat a gépeden marad; bejelentkezve
  a mérés a saját fiókkiszolgálódra is felkerül, végponttól végpontig titkosítva
  (ebből lesz a közös napi keret). Telemetria sehol nincs. Bármikor
  kikapcsolható és törölhető. Hétfő reggel az app egy **heti visszatekintést**
  is küld értesítésben — az elmúlt 7 nap: mért idő, a legtöbb (és a trend),
  menetek, feloldások, vagy hogy egy sem volt. Egy hétről egyszer, és csak
  amíg az app fut; a rejtett vagy fedőnevű címet az értesítés sem mondja ki.

  A **mai napnak külön blokkja van** („Mire ment ma az idő”): oldal és app
  együtt, idő szerint — a heti listákban a hét eleje elnyomná a mát.

  A statisztikán a **nulla nem néma**: az app kiírja, mikor rögzített utoljára
  mért időt. Abból, hogy „ma 0 mp”, önmagában nem derülne ki, hogy tényleg nem
  használtad a gépet, vagy hogy a mérés hasalt el valahol — és a kettőnek más a
  teendője. Ugyanígy szól akkor is, ha a szonda nem kap adatot (macOS-en
  jellemzően engedély kell hozzá; frissítés után a rendszer vissza is veheti),
  és akkor is, ha a mért idő eljut a segédig, de ott nem sikerül eltárolni.
- **Csatorna-szűrő** (asztali böngésző): egy oldalon — például a YouTube-on —
  csak az általad felsorolt csatornák nyílnak meg; a többi csatorna tiltva,
  amíg a szűrő be van kapcsolva. Nem teljes tiltás: a kezdőlap és a keresés
  használható marad — de a nem engedélyezett csatornák videókártyáit a
  bővítmény elrejti, a lejátszó-oldal pedig akkor is tilt, ha a videót a lap
  saját adata szerint nem engedélyezett csatorna töltötte fel. Bekapcsolni
  egy kattintás, **kikapcsolni vagy új csatornát engedélyezni próbatétel** —
  mint a munkameneteknél. A böngésző-bővítményben él (a DNS címet nem lát),
  tehát abban a böngészőben véd, ahová a bővítményt betöltötted — inkognitóra
  nem terjed ki, és ezt nem is állítjuk. A szűrős oldalakon a bővítmény azt
  is méri, **melyik csatorna mennyi időt vitt** (ma + elmúlt 7 nap, a
  beállítási lapján); az adat a gépen marad.
- **Fedőnév a blokkolt oldalakhoz** (mindhárom platform): a lista maga is
  ingerforrás — aki megnyitja az appot, és ott áll előtte a `youtube.com`, az már
  fél lépéssel közelebb van. Minden oldalnak adható saját név, és onnantól a
  felületen az látszik: a soron, a párbeszédek címében, a próbatétel-ablakban és a
  statisztikában is. A valódi cím nem tűnik el, egy gombbal **hat másodpercre**
  előhívható, aztán magától visszabújik. Ez inger-eltávolítás, nem titkosítás:
  a hosts fájlban ott a cím, és ezt a felület is kimondja.
- **Hosztnevek oldalanként** (asztali gép; a lista szinkronnal a telefonra is
  átmegy): egy oldal tiltása több nevet takar (`youtube.com`, `www.youtube.com`,
  `music.youtube.com`, `youtu.be`…), és ezek a nevek mennek a hosts fájlba. A
  lista szerkeszthető: **felvenni egy kattintás** (csak az oldal aldomainje vagy
  ismert társoldala lehet), **levenni próbatétel** — például a YouTube Music
  engedése a YouTube tiltása mellett. Az oldal saját címe nem vehető le, ahhoz
  az oldalt kell törölni. Két gép ütköző listája egyesül; a levételt a
  próbatétel utáni magasabb változat viszi át — versenyhelyzet sosem old fel.
  Kimondott korlát: ha a másik gép ugyanabban a körben bármi mást módosított
  az oldalon (egyenlő változat), a listák egyesülnek, és a levett név
  visszajön — az irány a szigorúbb, de a próbatétel ára elveszett, és a nevet
  újra le kell venni. A felület ilyenkor a listában megmutatja a nevet.
- **A teljes lista elrejthető** (mindhárom platform): egy kapcsoló, és az app
  minden induláskor csukott listával nyílik — csak annyi látszik, hogy „3 oldal
  van blokkolva”. A rejtés az egész felületre szól: a statisztikában
  `1. rejtett oldal` áll a cím helyett (az idő és a „blokkolt” jelölés marad), és
  a felvevő kártya gyorsgombjai is eltűnnek, mert épp a tipikus címek állnak
  rajtuk. Megnyitni egy kattintás, de csak a bezárásig marad nyitva.
- **Fiók és eszközök közti szinkron** (mindhárom platform):
  belépsz ugyanabba a fiókba a másik gépeden, és nem kell újra felvenned a
  listát — a többi eszköz statisztikáját is látod, és legelöl az **összes eszköz
  együtt**: nem eszközönként külön, hanem hogy mennyi ment el összesen. iPhone-on
  ez az egyetlen statisztika, ami valaha látszani fog (az Apple nem enged appnak
  időt mérni más appokban), tehát ott pont ez adja a mérést. A blokkolt oldalak és a mért
  idők **titkosítva** mennek fel: a kiszolgáló csak átlátszatlan bájtokat lát,
  és mivel nem ért belőlük semmit, nem is kell megbízni benne. A kiszolgáló
  néhány száz sor, függőség nélkül, magadnak is futtathatod (`server/`).
  A kijelentkezés **egyetlen blokkot sem visz el** — a szinkron nem kibúvó.
  A kiszolgálót az **asztali app egy gombbal el is indítja**, tehát nem kell
  hozzá se terminál, se Node. Lépésről lépésre:
  [`docs/feature-accounts-sync.md`](docs/feature-accounts-sync.md).
- **Részleges tiltás** (böngésző-bővítmény): nem az egész oldal, csak egy
  darabja — például a YouTube-on egy-egy csatorna. Ezt a DNS-motor **nem tudja
  megcsinálni**, és ez nem hiányzó munka: a DNS csak a hosztnevet látja
  (`youtube.com`), az utat (`/@valaki`) nem, mert az a titkosított kérésen belül
  van. Ami a teljes címet látja, az a böngésző — innen a bővítmény. Cserébe
  **gyengébb réteg**: csak abban a böngészőben él, vendég módban egyáltalán nem
  fut, inkognitóban külön be kell kapcsolni. A teljes oldal tiltása marad
  DNS-szintű és megkerülhetetlen; ez az **ingert** veszi el.
  [`extension/`](extension/README.md) ·
  [`docs/feature-partial-block.md`](docs/feature-partial-block.md).
- **Napi időkeret oldalanként** (asztali gép + Android): „napi 20 perc YouTube”.
  Ha a mai aktív idő eléri a keretet, az oldal a nap hátralévő részére magától
  visszazár, éjfélkor a keret újraindul. Keretet bevezetni vagy csökkenteni egy
  kattintás, **emelni vagy megszüntetni ugyanúgy próbatételekbe kerül**, mint egy
  feloldás. Amíg van keret, a mérés nem kapcsolható ki — abból fogy.
  iPhone-on ez nem építhető meg (nincs ilyen mérési API), lásd a korlátokat.

- **Adag-szabály oldalanként** (asztali gép + Android): „2 perc Gemini után
  10 perc szünet, aztán magától kinyílik”. A napi keret testvére: a keret a
  napi összesenről szól, ez arról, hogy egyszerre mennyi fér. Ha egy
  szünetnyi ideig nem használod az oldalt, a számláló tiszta lappal indul.
  Bevezetni vagy szigorítani egy kattintás, **nagyobb adag, rövidebb szünet
  vagy a levétel próbatételbe kerül**. A tiltás nem néma: a böngészőben a
  bővítmény tiltó lapja megmondja az okot és visszaszámol (a szünet
  leteltekor visszautat ad), a telefonon a tartós értesítés beszél.
  Részletek: `docs/feature-burst-limit.md`.

- **Munkamenetek: „most csak ez mehet”** (gép, Android, iPhone). A blokklista arról szól,
  mi NE menjen; a munkamenet fordítva: csinálsz egy csomagot (pl.
  „Nyelvtanulás”), felsorolod, mi mehet alatta, és megadod, meddig tartson.
  Amíg tart, **minden más tiltva**. Egy **gyorsbillentyűs réteg** (alapból ⌘⌥B, illetve
  Ctrl+Alt+B — a kombináció átállítható) bárhonnan előhozza, és számbillentyűvel indít — mert aki leül
  dolgozni, nem fog előbb ablakot keresni. Indítani és hosszabbítani ingyen van,
  **leállítani próbatétel**; a futó csomag közben nem szerkeszthető. A
  fehérlistát a gépen a böngésző-bővítmény érvényesíti (csak ott látszik a
  teljes cím), az appoknál a réteg **szól, de nem tilt**.

  **A telefonon ez erősebb**: ott a DNS-szűrő minden névfeloldást lát, tehát
  bővítmény nélkül betartatja a fehérlistát — szűk, tételesen indokolt
  kivétellel (értesítés, kapcsolat-ellenőrzés, óra, a saját fiókkiszolgálód),
  mert egy telefon, aminek minden névfeloldása elhasal, nem korlátozott, hanem
  használhatatlan. Indítani és leállítani mindkét telefonon lehet — a
  leállítás ott is próbatétel.

  **Statisztika a menetekről, minden eszközről:** hányszor ültél le dolgozni és
  hányat vittél végig, mai és heti bontásban. Minden eszköz vezeti a saját
  naplóját, és a napló utazik a fiókon — ha ugyanazt a menetet két eszköz is
  lezárja, az EGY menet marad. A „korán leállítva” sor szándékosan nem
  szégyenpad: ha sokszor fordul elő, nem a csomaggal van baj, hanem a hosszal.

  **Heti ablak: a menet magától indul** (gép + telefon). A csomag kaphat egy
  ablakot („hétköznap 9:00–12:00”): abban a menet magától indul, és az ablak
  végéig tart — a telefonon is, mert az ablak a csomaggal szinkronizál. Felvenni
  és bővíteni egy kattintás, **szűkíteni vagy levenni próbatétel**; a
  leállított menet ugyanabban az ablakban nem indul újra (a napló az őr). Az
  ablak vége az ablak vége: a laptop alvása nem tolja el. Őszinte korlát: egy
  eszköz, ami a leállításkor nem volt hálózaton, a szinkronig újraindíthatja a
  hátralévő részre — a hiba iránya a szigorúbb, és a leállítás ott is próbatétel.

  A gépen a fehérlistát KIZÁRÓLAG a bővítmény tudja betartatni, ezért az app és
  a gyorsbillentyűs réteg is **szól, ha az nincs összekötve** — enélkül az
  indítás csendben nem tiltana semmit a böngészőben. Az óra átállítása sem
  rövidíti meg a menetet: amennyi hátra volt, annyi van hátra. Lásd
  [`docs/feature-focus-sessions.md`](docs/feature-focus-sessions.md).

## Képernyőképek

| Főképernyő (asztali) | Feloldási próbatétel |
|---|---|
| ![Főképernyő](docs/images/desktop-home.png) | ![Próbatétel](docs/images/desktop-challenge.png) |

| Időzített menetrend | Elrejtett lista |
|---|---|
| ![Menetrend](docs/images/desktop-schedule.png) | ![Elrejtett lista](docs/images/desktop-list-hidden.png) |

![Statisztika](docs/images/desktop-stats.png)

![Letöltőoldal](docs/images/website.png)

## Letöltés és frissítés — mint egy áruházból

A telepítés egy kattintás, és az appok **maguktól frissülnek**:

- **Letöltőoldal:** `https://david-getta.github.io/app_blocker/` — felismeri a
  platformodat, és a legfrissebb telepítőt kínálja. (A GitHub Pages
  bekapcsolása után él; lásd [`docs/releasing.md`](docs/releasing.md).)
- **Asztali (Windows/macOS):** az app a háttérben ellenőrzi és letölti az új
  verziót, majd egy gombbal újraindulva telepíti — mint az áruházi frissítés.
- **Android:** a Play Áruházon kívül telepítve is figyeli az új kiadást, és egy
  gombbal frissít; Play Store-ból az áruház frissíti.
- **iPhone:** App Store / TestFlight (az Apple szabályai miatt ez az út).

Új verzió kiadása a fejlesztőnek **egyetlen parancs** (`git tag v0.2.0 && git
push origin v0.2.0`) — a GitHub Actions megépíti mindhárom platformra és közzé
teszi. Részletek: [`docs/releasing.md`](docs/releasing.md).

### Jó, ha tudod — telepítés után

Ugyanaz a lista, ami a letöltőoldalon áll; itt azért, hogy a README-ből se
hiányozzon.

- **Windows / macOS:** a telepítő egyszer kér rendszergazdai jóváhagyást a
  védelemhez (a segéd ettől tud a hosts fájlba írni). macOS-en nem kér újra
  minden indításnál.
- **macOS első indítás:** amíg nincs Apple fejlesztői aláírás, a macOS 15
  (Sequoia) és újabb kukába teszi az appot („Rosszindulatú szoftver
  blokkolva”) — ez nem kártevőt jelent, csak azt, hogy nincs aláírva. A
  **DMG**-t töltsd le (a `-mac.zip` a frissítéshez van), húzd az
  *Alkalmazások* mappába, majd egyszer Terminálban:
  `xattr -dr com.apple.quarantine /Applications/Breaker.app` — ez a letöltési
  karantén jelzőt veszi le, semmi mást nem kapcsol ki. Ha a rendszer már
  kukába tette, előbb húzd vissza.
- **Az idő mérése külön engedély:** a rendszer csak engedéllyel árulja el,
  melyik ablak van előtérben — macOS-en az *Automatizálás* alatt, Androidon a
  *Használati hozzáférés* alatt adható meg. Aláírás nélkül a macOS minden új
  verziót külön appnak lát, tehát frissítés után újra kérheti; az app
  kiírja, és megmondja, hol. Amíg nincs adat, a napi időkeret sem fogy.
- **Android:** a Play Áruházon kívülről telepítve a rendszer egyszer rákérdez
  az „ismeretlen forrás” engedélyre; a VPN-alagút engedélyét az első
  bekapcsolás kéri.
- **Ha egy tiltott oldal mégis megnyílik:** az önteszt ötpercenként nézi, a
  rendszer feloldója tényleg a tiltó címre küldi-e a tiltott neveket, és
  szól, ha nem (tipikusan egy VPN-kliens saját feloldója, vagy más program
  is írja a hosts fájlt) — a *Tiltás ellenőrzése* gombbal azonnal is. Amit
  nem lát: a böngésző saját DoH-ját (lásd lent, az őszinte korlátoknál).
- **Böngésző-bővítmény:** az app kimásolja egy állandó mappába (az oldal
  *Részek* párbeszédében: *Mappa megnyitása*); ezt kell **egyszer** betölteni
  a böngésző fejlesztői módjában, frissítés után a böngészőben elég a
  Frissítés gomb. Gyengébb réteg, mint a DNS-szintű tiltás: csak abban a
  böngészőben él, vendég módban nem fut, inkognitóban külön engedély kell.

## A feloldás filozófiája

A blokkolás bekapcsolása **egy kattintás**. Kikapcsolni **nem az** — ez a lényeg.

- Minden feloldás egy több lépéses **próbatétel-sorozat** (átgépelés,
  fejszámolási lánc, memória-kód, visszafelé gépelés, kötelező várakozás).
- A tartalom **minden alkalommal frissen, véletlenül** generálódik — nincs mit
  „betanulni”.
- A típusok **kombinációja változik**, és nem ismétlődik kétszer egymás után.
- Aki **gyakran old fel, annak nehezebb lesz** (automatikus nehézség-emelés az
  elmúlt 7 nap alapján).
- A **DELAY** lépés valós idejű várakozás (akár 10–120 perc), aminek a végén csak
  egy szűk **10 perces ablakban** vehető át a feloldás — különben az egész
  kísérlet elölről indul.

Részletek: [`docs/challenge-spec.md`](docs/challenge-spec.md).

## Felépítés

| Platform | Technológia | Blokkolás módja |
|----------|-------------|-----------------|
| Windows + macOS | Electron + Node helper | rendszer `hosts` fájl, tamper-védelemmel |
| Android | Kotlin + Jetpack Compose | helyi `VpnService` DNS sinkhole |
| iOS + macOS | SwiftUI + Network Extension | `NEPacketTunnelProvider` DNS-szűrő |

A blokk-logika, a próbatétel-motor és a bíró **közös algoritmus** minden
platformon. Referencia: TypeScript (`node --test` fedi); Kotlin és Swift ennek
pontos tükre. Részletek: [`docs/architecture.md`](docs/architecture.md).

```
desktop/   Electron app + privilegizált helper (Win/Mac)   → docs/desktop.md
server/    szinkron-kiszolgáló (Node, függőség nélkül)     → server/README.md
android/   Gradle projekt (Kotlin, Compose)                → docs/android.md
ios/       XcodeGen projekt (iOS + macOS, közös Swift mag) → docs/ios-macos.md
website/   letöltő landing oldal (GitHub Pages)
.github/   CI/CD: teszt, build és kiadás minden platformra → docs/releasing.md
docs/      architektúra, próbatétel-spec, funkciótervek, kiadási útmutató
```

Dokumentáció:
[architektúra](docs/architecture.md) ·
[próbatételek](docs/challenge-spec.md) ·
[menetrend](docs/feature-schedules.md) ·
[idő-mérés és statisztika](docs/feature-usage-stats.md) ·
[fiók és szinkron](docs/feature-accounts-sync.md) ·
[kiadás](docs/releasing.md)

## Gyors indítás

```bash
# Desktop (a mag + hosts-motor tesztjei itt is lefutnak)
cd desktop && npm install && npm test && npm start

# Android
cd android && ./gradlew assembleDebug

# iOS / macOS (macOS + Xcode kell)
cd ios && xcodegen generate && open Breaker.xcodeproj
```

## Állapot és tesztelés

- **Szinkron-kiszolgáló:** 11 teszt a valódi HTTP-n keresztül (`server/`), és
  a kliensek is a VALÓDI kiszolgálóval futnak végig — asztalon és Androidon is,
  gyerekfolyamatként indított kiszolgálóval. ✅ Zöld.
- **Desktop:** teljes `node:test` lefedettség a blokklistára, a próbatétel-motorra,
  a bíróra (session + hosts fájl end-to-end), a menetrendre, a napi keretre és az
  idő-mérésre — a segéd IPC-jét támadó integrációs teszttel együtt. Mellette egy
  Playwright-füstteszt hajtja végig a valódi felületet (feloldási folyamat,
  beillesztés-tiltás, keret-mérő, a „régi a háttérszolgáltatás” és a „nem kap
  adatot a mérés” figyelmeztetés, a fedőnév és a lista elrejtése — utóbbi arra is,
  hogy újraindítás után is rejtve marad, és hogy közben az ablakban sehol nem
  marad ott egy blokkolt cím). Mindez sötét és világos témában is. ✅ Zöld.
- **Android:** a platformfüggetlen mag (`ChallengeEngine`, `Blocklist`,
  `ScheduleLogic`, `UsageLogic`, `LimitLogic`, `Referee`, `BreakerStore`) és a bitszintű
  `DnsEngine` JVM-en unit-tesztelt, Android SDK nélkül futtatva
  (`android/jvm-tests`). ✅ Zöld. A teljes APK-hoz SDK kell — a CI buildeli.
- **iOS/macOS:** a projekt XcodeGennel generálható; a fordításhoz macOS + Xcode
  szükséges. A Swift mag a tesztelt TS/Kotlin mag tükre, de itt fordítással nincs
  ellenőrizve.

Amit érdemes futtatni fejlesztés közben:

| Parancs | Mit ellenőriz |
|---|---|
| `cd desktop && npm test` | a teljes desktop tesztkészlet (build + fordítás + futtatás) |
| `cd desktop && npm run ui:check` | a renderer tényleg betöltődik és végigkattintható (fejetlen Chromium) |
| `cd desktop && npm run ui:shots` | ugyanaz, plusz frissíti a `docs/images` képeket |
| `cd android/jvm-tests && gradle test` | az Android mag SDK nélkül |
| `node scripts/check-text.js` | magyar idézőjel-párok (Kotlinban lezáratlan sztring = fordítási hiba) |
| `node scripts/check-kotlin-imports.js` | hiányzó import a saját mag-típusainkra a Compose-fájlokban |
| `node scripts/check-core-sync.js` | a TS/Kotlin/Swift mag számai (nehézségi szintek, határidők) egyeznek-e |
| `node scripts/check-ui-wiring.js` | van-e olyan gomb a felületen, amihez nem tartozik kezelő |
| `node scripts/check-enforcement.js` | a döntést tényleg MEGKÉRDEZI-e valaki (a hosts fájltól a frissítés-keresésig) |
| `node scripts/check-infra-allow.js` | a munkamenet kivétellistája szűk maradt-e |
| `node scripts/check-wire-names.js` | a dróton menő mezőnevek egyeznek-e mind a három nyelvben, és nem keletkezik-e őrizetlen kulcs |

A CI mindet futtatja minden pusholásnál.

**Miért van ennyi ellenőrző.** A projekt visszatérő hibafajtája nem a rossz
logika, hanem a NÉMA hiba: a mag megvan, teszt is van rá, csak épp senki nem
hívja — vagy a szöveg mond valamit, amit az app már nem tart be. Ilyenkor semmi
nem hasal el: a fordítás jó, a tesztek zöldek, az app hibátlannak látszik, és a
tiltás nem történik meg. A felhasználó pedig azt hiszi, védve van.

Két valódi példa ebből a repóból: az „Új csomag” gomb egy kiadáson át ott volt
kezelő nélkül, és a statisztika-képernyő hónapokig azt írta, hogy a mérés nem
hagyja el a gépet — miközben a közös napi keret miatt már feltöltődött. Ezért
minden ellenőrző úgy készült, hogy SZÁNDÉKOSAN elrontottuk a védett dolgot, és
megnéztük, tényleg elhasal-e.

## Őszinte korlátok

A Breaker **önkontroll-eszköz** olyasvalakinek, aki *segíteni akar magának* — nem
kártevő-elleni és nem szülői felügyeleti szoftver. Elszánt, technikailag hozzáértő
felhasználó meg tudja kerülni (admin jogok, egyedi DNS/DoH-proxy stb.). A cél a
**súrlódás** akkora növelése, hogy a pillanatnyi késztetés ne legyen elég a
feloldáshoz. A megkerülési utakat nyíltan dokumentáljuk az
[`docs/architecture.md`](docs/architecture.md) végén.

Néhány konkrét dolog, amit érdemes előre tudni:

- **iPhone-on nincs idő-mérés, tehát napi időkeret sincs.** Az Apple nem ad
  appnak hozzáférést ahhoz, hogy más appokban vagy weboldalakon mennyi idő
  telik; az egyetlen ilyen API külön, egyenként engedélyezett entitlementhez
  kötött. A blokkolás és a heti menetrend iPhone-on is ugyanúgy működik.
- **macOS-en a böngésző-DoH kikapcsolása nem zár, csak alapértelmezést állít.**
  MDM-profil nélkül a Chromium ajánlásnak veszi a gépszintű beállítást, tehát
  visszakapcsolható. Windowson ez házirend-kulcs, ott zár.
- **Androidon a rendszer szigorú Privát DNS-e megkerüli a szűrőt** (megadott
  kiszolgálónévvel a névfeloldás TLS-en, a VPN mellett megy). Kényszeríteni
  nem tudjuk; az app észleli, a korong és a tartós értesítés kimondja, és a
  hálózati beállításokhoz visz. Az „Automatikus” mód rendben van.
- **A gépen az önteszt tényt mond, nem garanciát:** ötpercenként a rendszer
  feloldóját kérdezi a tiltott nevekről, és szól, ha nem a tiltó címre
  oldódnak — a böngésző saját DoH-ját viszont nem látja.
- **A gépi értesítések csak amíg az app fut** (adag-betelés, a heti ablak
  menetének indulása, a hétfői visszatekintés): a háttérben ülő védelem
  magától nem tud értesíteni. A heti ablak menetét a segéd az app nélkül is
  elindítja, és a telefon szűrője betartatja — a böngészőben viszont a
  bővítmény az apptól kérdezi a fehérlistát, tehát ott csak futó app mellett
  érvényesül.

## Következő lépések (ötletek a bővítéshez)

Amit a lista korábban tartalmazott és azóta elkészült: **időzített szabályok**
(heti menetrend, a lazítás próbatételhez kötve), a **statisztikák** (aktív idő
oldalanként és appokként), a **napi időkeret** (a mérés és a blokkolás
összekötve, [`docs/feature-daily-limit.md`](docs/feature-daily-limit.md)) és az
**iOS-mag fordítási ellenőrzése a CI-ban** (macOS runneren, aláírás nélkül —
a Swift-tükör minden pusholásnál fordul).

Ami még hátravan:

- **Kulcsszó-/kategória-alapú blokkolás** (a mostani DNS-szint egész
  domaineket lát, nem tartalmat).
- **IP-szintű szabályok** az egyedi DNS/DoH-proxy megkerülés ellen.
- **„Párban zárolás”**: a feloldáshoz egy megbízott jóváhagyása is kell.
- **Windows named pipe szűkítése** egyedi DACL-lel (ma helyi, de nem
  felhasználóhoz kötött — lásd `docs/architecture.md`).
- **iOS-mag tesztjei**: a Swift-tükör fordul a CI-ban, de futó teszt nincs
  hozzá — a viselkedést a TS/Kotlin tesztek és a kézi egyeztetés fedi.
