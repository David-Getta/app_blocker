# Kiadás és frissítés

A cél: **letölteni olyan egyszerű legyen, mint egy áruházból**, és **a
frissítések maguktól menjenek**. Két sáv van, és mindkettő be van kötve:

1. **Közvetlen terjesztés (ingyenes, azonnal működik)** — GitHub Releases +
   önfrissítő appok + letöltőoldal.
2. **Hivatalos áruházak** — Play Store, App Store, Microsoft Store (fizetős
   fejlesztői fiók kell).

---

## 1. Új verzió kiadása — egyetlen parancs

```bash
git tag v0.2.0
git push origin v0.2.0
```

Ez elindítja a `Release` workflow-t (`.github/workflows/release.yml`), ami:

- **Windows + macOS:** `electron-builder`-rel telepítőt épít, és feltölti a
  GitHub Release-be az auto-update metaadatokkal (`latest.yml`, `latest-mac.yml`)
  együtt.
- **Android:** aláírt **APK**-t (közvetlen telepítés) és **AAB**-t (Play Store)
  épít, és a Release-hez csatolja.
- **iOS/macOS:** ellenőrzi, hogy a projekt fordul (a bolti feltöltés kézi/fastlane
  lépés, lásd lentebb).
- Végül **közzéteszi** a Release-t.

A verziószám a **git tagből** jön (a `v` előtag nélkül), így az appok verziója és
a Release címe mindig egyezik.

> A már telepített asztali és Android (közvetlen) appok a következő indításkor
> **maguktól felfrissülnek** erre a kiadásra.

---

## 2. Hogyan frissül magától az app

- **Asztali (Win/Mac):** az `electron-updater` induláskor és 6 óránként ellenőrzi
  a GitHub Releases-t, a hátérben letölti az újat, és egy sávban felajánlja az
  „Újraindítás és frissítés” gombot.
- **Android (közvetlen):** az app a GitHub API-ból nézi a legfrissebb kiadást, és
  ha újabb, egy gombbal letölti és elindítja a telepítőt.
- **Play Store / App Store:** ott maga az áruház frissít, az appon belüli
  ellenőrzésre nincs szükség.

---

## 3. Aláírás (opcionális, de ajánlott)

A workflow **secretek nélkül is lefut**, és telepíthető fájlokat készít. Éles
használatra viszont érdemes aláírni. Repo → Settings → Secrets and variables →
Actions:

### Android
| Secret | Mi ez |
|--------|-------|
| `ANDROID_KEYSTORE_BASE64` | a `.jks` kulcstároló base64-ben (`base64 -w0 release.jks`) |
| `ANDROID_KEYSTORE_PASSWORD` | a kulcstároló jelszava |
| `ANDROID_KEY_ALIAS` | a kulcs aliasa |
| `ANDROID_KEY_PASSWORD` | a kulcs jelszava |

Kulcs létrehozása:
```bash
keytool -genkeypair -v -keystore release.jks -keyalg RSA -keysize 2048 \
  -validity 10000 -alias lakat
```
Secret nélkül a release APK a debug kulccsal íródik alá — közvetlen
terjesztéshez jó (és konzisztens), a Play Store-hoz viszont saját kulcs kell.

### macOS (auto-update csak aláírva működik!)
| Secret | Mi ez |
|--------|-------|
| `MAC_CSC_LINK` | a „Developer ID Application” tanúsítvány `.p12`-je base64-ben |
| `MAC_CSC_KEY_PASSWORD` | a `.p12` jelszava |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | notarizációhoz |

Aláírás nélkül a macOS app **elindul**, de nem tudja magát frissíteni; ilyenkor
az app a letöltőoldalra irányít.

### Windows (opcionális)
Kódaláíró tanúsítvánnyal eltűnik a SmartScreen-figyelmeztetés. Add meg a
`CSC_LINK` / `CSC_KEY_PASSWORD` secreteket (a workflow már átadja őket).

---

## 4. Letöltőoldal (GitHub Pages)

Egyszeri beállítás: **Settings → Pages → Source: GitHub Actions**. Ezután a
`website/` mappa minden `main`-re pusholt változásnál publikálódik
(`.github/workflows/pages.yml`). Az oldal platformot ismer fel, és mindig a
legfrissebb kiadás valós letöltési linkjeit mutatja.

Cím: `https://david-getta.github.io/app_blocker/`

---

## 5. Hivatalos áruházak

### Google Play (Android)
1. Google Play Console fiók (egyszeri $25).
2. Töltsd fel a workflow által készített **AAB**-t (`Lakat-vX.Y.Z.aab`).
3. Első feltöltéskor engedélyezd a **Play App Signing**-ot.
4. Add meg az adatvédelmi tájékoztatót és a VPN-használat indoklását (DNS-szűrés
   a felhasználó saját eszközén — a forgalom nem hagyja el a készüléket).
5. Automatizálható: a `bundleRelease` után `r0adkll/upload-google-play` action a
   service-account JSON-nal (később hozzáadható).

### App Store (iOS + macOS)
1. Apple Developer Program ($99/év).
2. App Store Connectben hozd létre az appot a `hu.lakat.app` azonosítóval.
3. Xcode-ban vagy fastlane-nel: `xcodebuild archive` → `exportArchive` →
   `xcrun altool`/`notarytool` feltöltés, vagy `fastlane pilot` (TestFlight).
4. A Network Extension (packet-tunnel) indoklása kell a review-hoz: helyi
   DNS-szűrő, nem gyűjt adatot, a forgalom nem hagyja el az eszközt.
5. **TestFlight**: a leggyorsabb út, hogy „áruházszerűen” telepíthető legyen
   tesztelőknek, teljes App Store review nélkül.

### Microsoft Store (Windows, opcionális)
1. Partner Center fiók (egyszeri díj).
2. Az NSIS telepítő helyett MSIX csomag kell; az `electron-builder` `msix`
   targetjével építhető, majd a Partner Centerben feltölthető.

---

## 6. Verziózási tipp
Tartsd a `desktop/package.json` és az Android `versionName` alapértékét
szinkronban a legutóbbi taggel, hogy a helyi buildek is értelmes verziót
mutassanak. CI-ben ezt a tag automatikusan felülírja.
