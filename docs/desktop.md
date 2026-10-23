# Desktop (Windows + macOS) — build és futtatás

## Előfeltételek
- Node.js 18+ és npm

## Fejlesztői futtatás

```bash
cd desktop
npm install
npm test          # a közös mag + hosts-motor tesztjei (node:test)
```

A privilegizált helper és a GUI külön folyamat. Fejlesztéshez:

```bash
# 1) helper indítása (a hosts fájl írásához jogosultság kell)
sudo npm run helper:dev            # macOS/Linux
# Windows: nyiss rendszergazdai terminált és:  npm run helper:dev

# 2) másik terminálban a GUI
npm start
```

Jogosultság nélküli teszthez a helper átirányítható írható fájlokra:

```bash
BREAKER_STATE=/tmp/breaker/state.json \
BREAKER_HOSTS=/tmp/breaker/hosts \
BREAKER_SOCKET=/tmp/breaker/breaker.sock \
node dist/helper/index.js
```

## Felület-próba és akadálymentesség

```bash
npm run build
npm i --no-save playwright@1.63.0 axe-core@4.14.0
node scripts/ui-shots.js --check     # a felület végigjátszása, hamis híddal
node scripts/extension-ui.js         # a bővítmény lapjai
node scripts/website-shot.js --check # a letöltőoldal
```

Mindhárom próba lefuttatja az axe-core akadálymentességi ellenőrzését
(`scripts/a11y-check.js`), és minden szabálysértés bukás: a három nézet
mindkét témában, a gyorsbillentyűs réteg, a lista első sorának minden
párbeszéd-ablaka (feloldás, menetrend, napi keret, adag, fedőnév, indok,
hosztnevek, részek), a zárlat két ablaka, a munkamenet-csomag indítása és
szerkesztője, a végigjátszás közben nyíló ablakok (próbatétel, fiók-panel),
valamint a bővítmény beállítási, felugró és tiltó lapja, és a letöltőoldal
(`scripts/website-shot.js --check`). A CI-ban az axe
kötelező; helyben, ha nincs telepítve, a próba kimarad és szól.

A billentyűzetet is próbálja: az ablakokat Enterrel nyitja, és megköveteli,
hogy a fókusz az ablakba ugorjon, a Tab és a Shift+Tab ne szökjön ki belőle a
takart lapra, az Esc zárjon (ahol van Mégse), és a fókusz visszatérjen a
nyitó gombra. A lap kétmásodpercenként frissül, és a lista ilyenkor újraépül:
a próba megvárja egy újraépülést, és megköveteli, hogy a fókusz ugyanannak a
sornak ugyanazon a gombján maradjon. A hibaüzenetek bejelentését is nézi: a
lap hibája a lap közös bejelentőjén, az ablaké az ablak saját bejelentőjén
hangzik el (a nyitott ablak a lap többi részét elrejti a felolvasó elől), a
fejléc állapotjelzője élő régió — és egy változatlanul látva maradó hibát a
kétmásodperces frissítés nem mondathat el újra.

Amit nem lát: a teljes bejárás sorrendjét a fő nézetekben, azt, hogy a
felolvasó ténylegesen mit mond, és a telefonos appokat — ezek kézi próbát
kívánnak. A forrás-oldali őr (`test/dialog-markup.test.ts`) azt nézi, hogy
minden modál a közös `dialog()` segéden át készüljön (dialógus-szerep és
cím) és a `mountDialog()`-on át kerüljön a lapra (fókusz, Tab-kör, Esc),
minden választó-csip a `setOn()`-on át (a kiválasztás a felolvasónak is
szól), és hogy a frissítés visszaállítsa a fókuszt.

## Telepítő csomag

```bash
npm run dist       # electron-builder → release/ (macOS: dmg/zip, Windows: nsis)
```

A GUI-ban a **„Védelem telepítése (egyszeri engedély)”** gomb telepíti a
helpert:
- **macOS:** LaunchDaemon `/Library/LaunchDaemons/hu.breaker.helper.plist`, egyetlen
  admin jóváhagyással. Ezután minden bootnál automatikusan indul — **nincs
  többé engedélykérés induláskor.**
- **Windows:** `BreakerHelper` SYSTEM ütemezett feladat, egyetlen UAC-jóváhagyással,
  a gép indulásakor indul. Akkumulátoron is fut, nincs időkorlátja, és ha
  hibával kilép, percenként újraindul (a Feladatütemező alapértékein egyik
  sem így volna). A v0.4.257 előtt a telepítése a `C:\Program Files` alatti
  appnál hibával megállt — lásd az architektúra-doksit.

Mindkettő az app saját binárisát futtatja (macOS-en node-módban, az
`app.asar`-ból; Windowson `Breaker.exe --helper`). A CI ezt a becsomagolt appon,
a telepítő parancsával próbálja ki minden pushnál: a segéd felel, egy felvett
oldal a rendszer feloldójában a tiltó címre mutat, és az eltávolító után semmi
nem marad (`scripts/mac-helper-probe.sh`, `scripts/win-install-probe.ps1`).

## Az app a háttérben fut, és bejelentkezéskor indul

Két dolog él a gépen, és nem ugyanott. A **tiltást** a segéd tartja (lásd
fent) — az app nélkül is, minden bootnál. A **mérés** viszont az appban fut:
a root démon (macOS) és a SYSTEM-feladat (Windows) nem lát bele a
felhasználó munkamenetébe, nem tudja, melyik ablak van előtérben
(`src/main/tracker.ts`). A napi keret és az adag a mért időből fogy, a gépi
értesítéseket (heti ablak, adag, visszatekintés, előjelzések) pedig az app
ablakának tartalma kéri — a fő folyamat küldi, hogy a rendszer visszautasítása
is visszajöjjön (`src/main/notify.ts`).

Ezért az app nem áll le, ha bezárják az ablakát (`src/shared/background.ts`):

- **A bezárás elrejt.** Az ablak tartalma fut tovább — az értesítések onnan
  jönnek —, a mérés a fő folyamatban jár. Az első elrejtéskor egyszer szól,
  hogy a háttérben fut tovább. Macen a Dock-ikon, Windowson a tálca-ikon
  hozza vissza; a második indítás is előhozza.
- **Bejelentkezéskor rejtve indul** (`--background`): macOS-en egy
  felhasználói indító-ügynök (`~/Library/LaunchAgents/hu.breaker.agent.plist`
  — a rendszer „bejelentkezési elemek” hívása macOS 13 óta nem ad át
  kapcsolót, az ablakkal nyílna meg minden reggel), Windowson az indítási
  lista (`HKCU\…\Run`, „Breaker”). Az app minden indításkor pótolja a hiányzó
  vagy máshova mutató bejegyzést; a letöltésből, ideiglenes helyről futó
  macOS-appnál (App Translocation) nem ír, mert az útvonal nem marad meg.
- **A kilépés szándékos lépés** (menü, tálca, a felület gombja). A tiltás
  utána is él, de a mérés megáll: a keret és az adag nem fogy, értesítés
  nem jön, amíg az app újra nem indul. A felület a kilépés gomb alatt ezt
  kimondja.
- **A rendszer kapcsolóját nem írjuk felül.** Ha valaki a Feladatkezelőben
  vagy a Rendszerbeállítások „Háttérben futó elemek” listáján kikapcsolja,
  kikapcsolva marad — a gép az övé. Ez őszinte rés: ilyenkor bejelentkezés
  után a mérés addig áll, amíg az appot meg nem nyitják.

Az eltávolító szkriptek (lent) az indítási bejegyzést is viszik.

### Mérés-őr: a kilépés sem kapcsolja ki a keretet

A kilépés és a rendszer indítási kapcsolója után is marad egy rés: amíg az app
nem fut, a keretes oldal korlátlanul nyitva van. Aki ezt is be akarja zárni,
a Statisztika kártyán bekapcsolja a **mérés-őrt** (`shared/measure-guard.ts`):
ha az app nem jelentkezik, a napi kerettel vagy adaggal védett oldalak a hosts
fájlban zárva vannak, amíg vissza nem jön.

- **Honnan tudja a segéd, hogy az app fut.** Az app húsz másodpercenként
  amúgy is kérdez (a munkamenet állapotát), a felülete még sűrűbben — a segéd
  bármelyik kérését jelnek veszi (macOS-en a socketet csak a telepítő
  felhasználó érheti el). Külön életjel nincs, így egy régebbi app is jelen
  lévőnek látszik. Három perc csend után távollét.
- **Indulás és ébredés.** A segéd indulásakor és alvásból ébredve (a körei
  közötti nagy ugrás) újraindul a türelmi idő: a bejelentkezésnek és a
  fedélnyitásnak nem jár bezárás.
- **Visszatéréskor azonnal nyit**, nem a következő körben.
- **A kifizetett feloldás felülírja**, mint minden más tiltást.
- **Bekapcsolni ingyen, kikapcsolni próbatétel** (zárlat alatt sehogy) — a
  bíró minden lazító útja ugyanazon a kapun megy ki, a zárlat-teszt táblája
  ezt is lefedi.
- **Helyi beállítás**, nem szinkronizál: a mérés is ezen a gépen fut. A
  telefonokon a mérés a szűrő szolgáltatásában jár, ott ilyen rés nincs.
- **A böngésző megmondja, miért.** A DNS-zárás a böngészőben csupasz
  névfeloldási hibát adna. Ezért a híd leküldi az őrzött hosztokat, és ha az
  app három percnél régebben szólt, a bővítmény tiltó lapja ezekre kimondja:
  a Breaker most nem mér, és az app elindítása nyitja (ha a keretből maradt).

Őszinte korlátok:

- A mérés-őr az app JELENLÉTÉT nézi, nem a mérés minőségét. Ha az app fut, de
  a mérés nem lát semmit (macOS-en megtagadott engedély), azt a statisztika
  kártya külön mondja — a keret ilyenkor sem fogy, a mérés-őr pedig nem zár.
- Egy szándékos kerülőút — egy program, ami az app helyett kérdezgeti a
  segédet — ezt is kijátssza. A mérés-őr az impulzus ellen véd (a kilépés egy
  kattintás), nem a megfontolt, tíz perces kerülőút ellen; ahogy a zárlat sem.

## Őszinte korlát: a már élő kapcsolat

A gép a hosts-fájlban zár: egy tiltás (a menet indulása, a betelt keret, a
menetrend, a zárlat) az ÚJ névfeloldásokat fogja meg. Egy program, aminek már
van nyitott kapcsolata — egy szóló videó, egy élő közvetítés —, azt egy ideig
még használhatja.

- **Böngésző a bővítménnyel:** itt nincs ilyen rés — a látható lap újranézeti
  magát, és ha az oldala közben lezárult, a tiltó lapra fut (gépelés közben a
  gépelés-csend után, lásd `docs/feature-focus-sessions.md`).
- **Más programok és a bővítmény nélküli böngésző:** a kapcsolatot nem lőjük
  ki — egy futó programot nem zárunk be helyetted. A program bezárása és
  újranyitása érvényesíti a tiltást.

## Aláírás (ajánlott éles használatra)
- macOS: `electron-builder.yml` → `mac.identity` (Developer ID) + notarizáció,
  különben a Gatekeeper figyelmeztet.
- Windows: kódaláíró tanúsítvány az NSIS csomaghoz, különben SmartScreen szól.

## Teljes eltávolítás
A Breaker app törlése önmagában **nem old fel**: a tiltott oldalak a hosts
fájlban maradnak, és azt csak rendszergazdai joggal lehet átírni. Ez szándékos
— a gépen ez a törlés-védelem (a telefonok eszközadminjának/Képernyő-idejének
megfelelője, [`feature-uninstall-guard.md`](feature-uninstall-guard.md)).

### Az őr: ha az app eltűnik (v0.4.258)

A segéd az app saját binárisán fut — ha az appot törlik, a segéd nem indul
többé. A v0.4.257-ig a tiltás ilyenkor **befagyott** abban az állapotban, ahogy
a törléskor állt: ami épp szünetben volt, nyitva maradt; amit a menetrend, a
napi keret vagy egy munkamenet zárt volna később, az nem zárult. macOS-en a
saját telepítésű `Breaker.app` jelszó nélkül a Kukába húzható — ingyenes
lazítás volt.

Most a segéd mellett egy kicsi **őr** fut (macOS: `hu.breaker.guard`
LaunchDaemon, percenként; Windows: `BreakerGuard` ütemezett feladat, a géppel
és ötpercenként, SYSTEM-ként). A segéd maga teszi fel, rootként/SYSTEM-ként,
minden induláskor — újabb jelszó nélkül.

- A segéd minden változáskor kiír egy **szigorú blokkot**: a lista minden
  oldalának minden nevét, szünettől, menetrendtől, kerettől függetlenül. Mellé
  az eltávolító szkript másolatát is (macOS: a segéd állapotmappájába,
  Windowson a `C:\Program Files\Breaker Guard` mappába).
- Az őr **csak akkor** nyúl a hosts fájlhoz, ha a segéd nem tilt: az app
  binárisa nincs meg, vagy az app a helyén van, de a segéd percek óta nem
  indul el (macOS-en öt, Windowson tíz perc — addig az őr próbálja
  elindítani). Akkor a szigorú blokkot teszi a helyére, és a következő
  futásán visszateszi, ha kiveszik. A blokk első sora megmondja, miért tilt
  minden, és hol a teljes eltávolító.
- Az őr csak szigorít: a szigorú blokk és a hosts mostani blokkja tiltó
  sorainak **unióját** írja, egy elavult szigorú blokk sem vehet ki egy épp
  tiltott nevet. A magára hagyott jelölőt (ahogy a segéd is: a záró nélküli
  nyitó a fájl végéig tart), a Windows-sorvéget és a hiányzó hosts fájlt is
  rendbe teszi. A hosts fájlt egy cserével írja: egy betelt lemez vagy egy
  leállítás sem hagyhat félig írt fájlt.
- Az őr nem rak össze semmit, csak ellenőriz és bemásol: a szigorú blokkból
  csak megjegyzést és `0.0.0.0` / `::` tiltó sort vesz át (egy idegen sort
  kihagy és naplóz, a többit beírja), és csak akkor, ha a fájl és a mappája a
  rooté (Windowson a SYSTEM-é vagy a rendszergazdáké). Egy idegen fájl így
  sem irányíthat el egy nevet.
  Méretkorlát nincs: egy nagyon hosszú lista sem kapcsolhatja ki.
- Ha az appot **visszateszed ugyanoda**, a segéd újra indul (a launchd, vagy
  ha az feladta, az őr indítja), a saját blokkját írja, és minden a régi.
- macOS-en a segéd a saját kódját is figyeli: ha az app **frissült**, egy-két
  percen belül újraindul az új kóddal; ha az app eltűnt, kilép, és az őr veszi
  át. Windowson egy frissítés leállítja a segédet, és a Feladatütemező magától
  nem indítja újra — ezt is az őr teszi meg, ha a fájlok a helyükön vannak és
  nem fut telepítő.

**Őszinte korlátok:**

- **A meglévő telepítéseken az őr a segéd következő indulásakor kerül fel.**
  macOS-en a frissítés után a régi segéd a következő újraindításig fut: addig
  az app egy sávot mutat („Háttérszolgáltatás frissítése”, egy jelszó) — amíg
  ez nem történt meg, az app törlése még a régi módon befagyasztja a tiltást.
- Az app **áthelyezése** is eltűnésnek számít: aki máshova húzza, annál a
  szigorú blokk áll be, amíg vissza nem teszi — vagy az új helyről újra nem
  telepíti a segédet. Windowson egy cserélhető meghajtóra telepített app
  kihúzása is eltűnés.
- macOS-en lemezképről (`/Volumes/…`) vagy a rendszer karanténmásolatából
  (App Translocation) futó appnál az őr nem lép közbe: egy leválasztott
  lemezt nem tud megkülönböztetni egy kiadott lemeztől. Ezért ilyen helyről a
  segédet nem is telepítjük — előbb az Alkalmazások mappába kell tenni.
- Windowson az őr csak **tartós** eltűnés után ír (két futása között, kb.
  5–10 perc): egy frissítés pár percre cseréli a fájlokat, és közben nem
  zárhat le mindent. Ha közben a saját telepítőnk vagy eltávolítónk fut (egy
  nyitva hagyott ablak), legfeljebb fél óráig vár. Az eltávolítás után ennyi
  ideig még a régi blokk áll.
- Az NSIS-eltávolító (Gépház → Alkalmazások) a feladatokhoz és a hosts
  fájlhoz nem nyúl — az app eltávolítása nem lehet ingyenes lazítás. Csak
  kimondja, mi marad, és hol a teljes eltávolító.
- macOS-en az őr felkerülésekor a rendszer „Háttérelem hozzáadva”
  értesítést mutathat — ez ő.
- Az őr a hosts fájlt tartja, nem a böngésző saját titkosított DNS-ét — az
  ugyanúgy a DoH-házirenden múlik, mint a segéd mellett.

### A teljes eltávolítás

A segéd leszereléséhez rendszergazdai jog és az eltávolító szkript kell:

```bash
sudo sh "/Library/Application Support/Breaker/uninstall-macos.sh"   # macOS — a segéd által a gépre tett másolat
sudo sh desktop/scripts/uninstall-macos.sh                          # macOS — a tárolóból
powershell -ExecutionPolicy Bypass -File "C:\Program Files\Breaker Guard\uninstall-windows.ps1"   # Windows (admin) — a gépre tett másolat
powershell -ExecutionPolicy Bypass -File desktop/scripts/uninstall-windows.ps1                     # Windows (admin) — a tárolóból
```

A szkript előbb a segédet állítja le (egy futó segéd induláskor újra
felvenné az őrt), aztán az őrt, és csak utána veszi ki a hosts-blokkot —
különben az őr visszaírná. macOS-en, ha bármelyik nem áll le, hangosan
megáll, nem takarít félig.

A szkript a böngészők DoH-házirendjét is leveszi, amit a segéd tett fel —
különben a Breaker törlése után a böngésző „szervezet által felügyelt”
maradna, a titkosított DNS zárolva. Mit és hogyan:

- **Érték szerint dönt, mert azt, hogy ki írta, a beállítás nem tudja.** A
  Chromium-családnál (Chrome, Edge, Chromium, Brave) a `DnsOverHttpsMode = off`
  értéket veszi le, a Firefoxnál a saját értékeit (Windowson `Enabled=0`,
  `Locked=1` és — a v0.4.256 óta — `Fallback=1`; macOS-en a zárolt, kikapcsolt
  `DNSOverHTTPS` szótárat). Egy ugyanilyen értéket, amit valaki más tett oda
  (egy másik program, kézzel, vagy Windowson egy GPO), ugyanígy levesz: egy
  GPO értékét a házirend következő teljes alkalmazása írja vissza (ez nem
  feltétlenül a legközelebbi háttérfrissítés — biztosan egy `gpupdate /force`
  után), egy kézzel vagy egy másik programmal beállított érték nem jön vissza.
- **Ami más értéket tart, az marad** — például egy „secure”-ra állított
  Brave, vagy egy idegen Firefox-házirend.
- **Amit a segéd a futása alatt felülírt, azt nem állítja vissza.** A segéd
  minden indulásakor a saját értékét írja ezekbe a kulcsokba; ha előtte más
  állt ott (egy „secure”, egy saját Firefox-DoH-beállítás), az a Breaker
  mellett már nem élt, és az eltávolítás után sem tér vissza.
- **A Firefox házirend-kapcsolója macOS-en** (`EnterprisePoliciesEnabled`):
  ha a segéd kapcsolta be — előtte nem volt bekapcsolva, és ezt az első beíráskor
  feljegyezte —, vele megy, akkor is, ha mellette más Firefox-kulcs áll (azok
  a Breaker előtt hatástalanok voltak, és nélküle újra azok). Ha már előtte
  be volt kapcsolva, marad. A v0.4.256 előtti telepítésnél nincs feljegyzés: akkor
  csak akkor megy, ha rajta kívül semmi nem maradt.
- **Üres kulcs nem marad** (Windows): a Firefox egy üres `DNSOverHTTPS`
  kulcsot is házirendnek venne, ami egy `policies.json` DoH-beállítását
  felülírná. Csak a teljesen üres kulcs megy, a `Policies` alá soha.
- **macOS-en a DoH-zár profilt is leveszi** (`hu.breaker.doh`), ha a
  Kinézet panelről telepítetted; ha a rendszer nem engedi, kiírja, hol veheted
  le kézzel (Rendszerbeállítások › Általános › Eszközkezelés; régebbi
  macOS-en Adatvédelem és biztonság › Profilok, a 12-esen és előtte
  Profilok). Egy szervezet MDM-mel telepített profilját és kezelt
  beállításait (`/Library/Managed Preferences`) nem érinti.
- **Windowson a felhasználói Start menü parancsikont is** (`Breaker.lnk` a
  profilok saját Start menüjében) és az értesítés-kattintás HKCU-bejegyzését —
  ezeket az Electron 41 óta maga az app teszi le az első értesítéskor. Minden
  profilt végigjár; a parancsikont csak akkor veszi le, ha egy `Breaker.exe`-re
  mutat. Az app saját eltávolítója (Gépház › Alkalmazások) ugyanezt teszi, de
  csak annak a felhasználónak, aki a rendszergazdai jóváhagyást adta.

A macOS-szkript pythont nem használ (a mai macOS-en gyárilag nincs): a
hosts-blokkot `awk` veszi ki, és csak akkor nyúl a fájlhoz, ha a blokk mindkét
jelölője megvan. A CI macOS-próbája az eltávolítót egy olyan PATH-szal
futtatja, amin a python nem indul.

Ami a szkript után is marad, az a felhasználó saját mappája és a böngésző:
az app felhasználói mappája (macOS: `~/Library/Application Support/Breaker`,
Windows: `%APPDATA%\Breaker`) — benne apró beállítások (gyorsbillentyű, a
helyi szinkron-kiszolgáló kapcsolója), a segéd és a bővítmény-híd kulcsa, és a bővítmény
kimásolt mappája —, a böngészőbe betöltött bővítmény, és macOS-en a mentett
`Breaker-DoH.mobileconfig` fájl (alapból a Letöltések mappában). Ezek a segéd
nélkül semmit nem tiltanak; ha nyomtalanul akarod, a mappát és a fájlt töröld
kézzel, a bővítményt pedig vedd ki a böngésző bővítménykezelőjében.
