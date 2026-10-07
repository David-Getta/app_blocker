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
  `ONSTART` triggerrel.

## Az app a háttérben fut, és bejelentkezéskor indul

Két dolog él a gépen, és nem ugyanott. A **tiltást** a segéd tartja (lásd
fent) — az app nélkül is, minden bootnál. A **mérés** viszont az appban fut:
a root démon (macOS) és a SYSTEM-feladat (Windows) nem lát bele a
felhasználó munkamenetébe, nem tudja, melyik ablak van előtérben
(`src/main/tracker.ts`). A napi keret és az adag a mért időből fogy, a gépi
értesítéseket (heti ablak, adag, visszatekintés, előjelzések) pedig az app
ablakának tartalma adja.

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

## Aláírás (ajánlott éles használatra)
- macOS: `electron-builder.yml` → `mac.identity` (Developer ID) + notarizáció,
  különben a Gatekeeper figyelmeztet.
- Windows: kódaláíró tanúsítvány az NSIS csomaghoz, különben SmartScreen szól.

## Teljes eltávolítás
A Breaker app törlése önmagában **nem old fel**: a blokkolást a rendszergazdai
segéd tartja a hosts fájlban, és az a gép indulásakor magától újraindul. Ez
szándékos — a gépen ez a törlés-védelem (a telefonok eszközadminjának/Képernyő-
idejének megfelelője, [`feature-uninstall-guard.md`](feature-uninstall-guard.md)).
A segéd leszereléséhez rendszergazdai jog és az eltávolító szkript kell:

```bash
sudo sh desktop/scripts/uninstall-macos.sh        # macOS
powershell -ExecutionPolicy Bypass -File desktop/scripts/uninstall-windows.ps1   # Windows (admin)
```
