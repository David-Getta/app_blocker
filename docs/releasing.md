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

### Átállás a korábbi névről (Lakat → Breaker)

Az app 0.1.4-ig **Lakat** volt. A 0.2.0 névváltással minden azonosító
megváltozott (`hu.lakat.app` → `hu.breaker.app`, a segéd `hu.lakat.helper` →
`hu.breaker.helper`, az Android `applicationId`, az iOS bundle ID-k és az App
Group). Ezek nem „átnevezhetők”: a rendszer szempontjából ez egy MÁSIK app.

Ami ebből következik, és amit ki kell mondani:

- **A Breaker nem frissítésként érkezik a Lakat mellé, hanem külön appként.**
  A régit kézzel kell eltávolítani.
- **A régi macOS segéd magától tovább futna.** A LaunchDaemon minden
  rendszerindításkor elindulna, és a hosts fájlban lévő blokkját is tartaná —
  egy olyan app blokkolna oldalakat, amiről az új felület semmit nem tud.

A régi telepítés eltávolítása macOS-en:

```
sudo launchctl bootout system/hu.lakat.helper
sudo rm -f /Library/LaunchDaemons/hu.lakat.helper.plist
sudo rm -rf "/Library/Application Support/Lakat" /Library/Logs/Lakat
rm -rf /Applications/Lakat.app
```

Windowson a régi ütemezett feladat neve `LakatHelper`:

```
schtasks /Delete /TN "LakatHelper" /F
```

Androidon egyszerűen töröld a régi appot; a két csomagnév különbözik, tehát
egymás mellett is megférnek.

**A hosts fájlt nem kell kézzel javítani.** Az új segéd minden íráskor
kitakarítja a régi néven írt blokkot is (`stripLegacyBlocks`), tehát a
`# >>> LAKAT BLOCK` sorok az első blokkolásnál eltűnnek. Ez azért fontos, mert
enélkül maradna pár örökre blokkolt oldal, amiről egyetlen felület sem tud —
ez a legnehezebben kideríthető hibafajta.

---

### Ha egy kiadás félresikerül

**Ne szakítsd meg a futó kiadást.** A megszakítás nem áll meg tisztán: ami addig
felkerült, az fent marad. (A publish job feltétele emiatt `!cancelled()`, hogy a
félkész kiadás legalább draftban maradjon — de a már feltöltött fájlokat ez sem
szedi le.) Ha mégis meg kell szakítani, a javítás **ugyanarra a verzióra**
újraindítani a workflow-t: a build utáni feltöltés `--clobber`-rel megy, tehát a
friss fájlok felülírják a régieket.

Ezt nem véletlenül tudjuk: a v0.1.1-nél pontosan ez ment félre. Egy megszakított
futás feltöltötte az aláírás előtti macOS bundle-t, az `electron-builder`
publishere pedig a javított újraépítésnél **csendben** kihagyta a feltöltést
(„existing type not compatible with publishing type”), miközben a job sikeresnek
látszott. A kiadáson így a rossz fájlok maradtak. Azóta a feltöltés külön
lépésben, `gh release upload --clobber`-rel történik, és el is hasal, ha nem
épült telepítő vagy hiányzik a `latest*.yml`.

**Ellenőrzés kiadás után** (egy percbe kerül, és pont ezt fogta volna meg):

- a macOS build logjában ott van-e az `ad-hoc signed Breaker.app` sor,
- az asseteken a feltöltés ideje a MOSTANI futásé-e,
- a `latest-mac.yml` és a `latest.yml` fent van-e (enélkül nincs frissítés).

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
  -validity 10000 -alias breaker
```
Secret nélkül a release APK a debug kulccsal íródik alá — közvetlen
terjesztéshez jó (és konzisztens), a Play Store-hoz viszont saját kulcs kell.

### macOS
| Secret | Mi ez |
|--------|-------|
| `MAC_CSC_LINK` | a „Developer ID Application” tanúsítvány `.p12`-je base64-ben |
| `MAC_CSC_KEY_PASSWORD` | a `.p12` jelszava |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | notarizációhoz |

**Aláírás nélkül is működik az egykattintásos frissítés.** A Squirrel.Mac (amit
az electron-updater hajt) csak Developer ID-vel aláírt appra alkalmaz
frissítést, ezért aláíratlan buildben az app *magától* frissít: letölti a
kiadás `-mac.zip` csomagját, ellenőrzi a méretét és a `latest-mac.yml`-ből a
sha512-t, `ditto`-val kicsomagolja (ez az egyetlen eszköz, ami egy .app-ot
épségben hagy), leveszi a karantén jelzőt, kicseréli a bundle-t, és újraindul.
Ha bármi hibázik, a régi app helyben marad, és a gomb a letöltőoldalt nyitja.
A választás induláskor dől el: `codesign -dv` alapján van-e valódi Developer ID
aláírás. Részletek: `desktop/src/main/mac-updater.ts`.

Amit az aláírás így is hoz: eltűnik a Gatekeeper figyelmeztetés az első
indításnál, és a frissítést az OS ellenőrzi, nem mi.

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
2. Töltsd fel a workflow által készített **AAB**-t (`Breaker-vX.Y.Z.aab`).
3. Első feltöltéskor engedélyezd a **Play App Signing**-ot.
4. Add meg az adatvédelmi tájékoztatót és a VPN-használat indoklását (DNS-szűrés
   a felhasználó saját eszközén — a forgalom nem hagyja el a készüléket).

**Automatikus feltöltés** (opcionális): a release workflow már tartalmaz egy
Play-feltöltő lépést, ami csak akkor fut, ha beállítod a
`PLAY_SERVICE_ACCOUNT_JSON` secretet (Google Cloud service account JSON, a Play
Console-ban „Users and permissions” → API access alatt jogosultsággal). Ekkor a
`git tag` az `internal` track-re is feltölti az AAB-t. Az első feltöltést
egyszer kézzel kell megtenni (a Play megköveteli).

### App Store (iOS + macOS)
1. Apple Developer Program ($99/év).
2. App Store Connectben hozd létre az appot a `hu.breaker.app` azonosítóval.
3. Xcode-ban vagy fastlane-nel: `xcodebuild archive` → `exportArchive` →
   `xcrun altool`/`notarytool` feltöltés, vagy `fastlane pilot` (TestFlight).
4. A Network Extension (packet-tunnel) indoklása kell a review-hoz: helyi
   DNS-szűrő, nem gyűjt adatot, a forgalom nem hagyja el az eszközt.
5. **TestFlight**: a leggyorsabb út, hogy „áruházszerűen” telepíthető legyen
   tesztelőknek, teljes App Store review nélkül.

**Automatikus TestFlight feltöltés** (opcionális): a release workflow iOS jobja
archivál és feltölt, ha beállítod az App Store Connect API-kulcs secreteket:
`ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8` (a `.p8` kulcsfájl tartalma). Ehhez
a `project.yml`-ben a `DEVELOPMENT_TEAM`-et is ki kell tölteni, és az App Store
Connectben létre kell hozni az appot a `hu.breaker.app` azonosítóval. Az
`-allowProvisioningUpdates` automatikusan kezeli a profilokat.
| Secret | Mi ez |
|--------|-------|
| `ASC_KEY_ID` | App Store Connect API kulcs azonosító |
| `ASC_ISSUER_ID` | az API kulcs issuer ID-ja |
| `ASC_KEY_P8` | az `AuthKey_XXXX.p8` fájl teljes tartalma |

### Microsoft Store (Windows, opcionális)
1. Partner Center fiók (egyszeri díj).
2. Az NSIS telepítő helyett MSIX csomag kell; az `electron-builder` `msix`
   targetjével építhető, majd a Partner Centerben feltölthető.

---

## 6. Verziózási tipp
Tartsd a `desktop/package.json` és az Android `versionName` alapértékét
szinkronban a legutóbbi taggel, hogy a helyi buildek is értelmes verziót
mutassanak. CI-ben ezt a tag automatikusan felülírja.
