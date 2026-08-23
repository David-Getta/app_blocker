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

## Aláírás (ajánlott éles használatra)
- macOS: `electron-builder.yml` → `mac.identity` (Developer ID) + notarizáció,
  különben a Gatekeeper figyelmeztet.
- Windows: kódaláíró tanúsítvány az NSIS csomaghoz, különben SmartScreen szól.

## Teljes eltávolítás
```bash
sudo sh desktop/scripts/uninstall-macos.sh        # macOS
powershell -ExecutionPolicy Bypass -File desktop/scripts/uninstall-windows.ps1   # Windows (admin)
```
