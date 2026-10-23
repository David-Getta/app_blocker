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

### A kiadási jegyzet

A jegyzet a workflow-ban él (`.github/workflows/release.yml`, a `NOTES`
blokk): a „Mi újság ebben a verzióban” szakasz a mostani verzióé, alatta a
két előző verzió egy-egy mondata („Ami a v0.4.xx-ban jött”). Minden kiadás
előtt egy külön commit forgatja („Kiadási jegyzet: vX.Y.Z — …”): a mostani
szakasz lecsúszik az elsőbe, az első a másodikba, a második kiesik. A
letöltőoldal az első szakaszt mutatja — a kiadás oldaláról, nem másolva.

Ha egy verzió nem kapott saját kiadást (piros CI, vagy több verzió került
egy kiadásba), a következő jegyzet első szakasza kimondja, és felsorolja:
„A v0.4.78 és a v0.4.79 nem kapott saját kiadást — ami ott jött, ebben van.”
A magyar idézőjel-pár a jegyzetben is egy sorban áll — a szöveg-ellenőrző a
workflow-t is nézi. A kiadás mindig zöld CI-ről indul; a `workflow_dispatch`
az ág aktuális csúcsát rögzíti, tehát a következő verzió commitjai csak az
indítás után mehetnek fel.

### Ugyanez terminál nélkül (vagy ha a tag-push nem megy át)

A workflow kézzel is indítható, és pontosan ugyanazt csinálja — a tagot ilyenkor
a kiszolgáló oldalon hozza létre a draft release:

1. GitHub → **Actions** → **Release** → **Run workflow**;
2. ágnak a kiadandó ágat add meg, verziónak pl. `v0.4.12`-t;
3. futtatás — a többi automatikus.

Ez az út akkor is működik, amikor a `git push --tags` valamiért nem (céges
proxy, szűkített token): a mai gyakorlatban a kiadások többsége így megy ki.
A helyi tagot utána érdemes felhúzni:
`git fetch origin tag v0.4.12`.

Kiadás után a változásnapló is frissül: `node scripts/changelog.js` a
„Kiadási jegyzet” commitokból és a helyi címkékből írja a
[`docs/changelog.md`](changelog.md)-t (verziónként a jegyzet címe; ami nem
kapott saját kiadást, jelölve; ami a legfrissebb címkénél újabb, „még nincs
kiadva”). A generált fájl a következő jegyzet-commitban mehet.

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

### Füstpróba: elindul-e a becsomagolt app

A telepített appok maguktól frissülnek. Egy el sem induló build ezért nem egy
gépen hibás, hanem mindenhol — és az el nem induló app a következő javítást már
nem tudja letölteni. Ezt semmi nem fogta ki: a tesztek a magot futtatják, a
renderer-füstteszt a felületet egy sima böngészőben.

Az app ezért indítható füstpróba-módban (`--smoke-test`, `src/main/smoke.ts`):
a rendes indulás fut végig — ablak, preload-híd, mérés, gyorsbillentyű,
bővítmény-híd —, csak a bejelentkezéskori indítás és a frissítés-keresés marad
ki, mert azoknak a gépen nyoma maradna, illetve a hálózatra mennének. Zöld, ha a
felület az indító kódja végén kiírta az app verzióját (a hídon át kérte el), és
az automatikus frissítő betölthető a csomagból. Piros, ha a fő folyamatban
elkapatlan hiba van (párbeszédablak helyett kilépési kód), ha a preload vagy a
felület elhasal, vagy ha 45 másodperc alatt nem áll fel.

Fut a CI-ban a fejlesztői builddel (Linuxon Xvfb alatt, és Windowson), a
**becsomagolt** appon is minden pushnál (macOS arm64 és Windows, csak a mappa,
telepítő nélkül), és a kiadásban a feltöltés előtt — ugyanazzal a szkripttel
(`desktop/scripts/smoke-packaged.sh`). Ha a kiadásban piros, a kiadás draft
marad: a felhasználókhoz nem jut el.

Az indulás még nem minden: a **segéd** is az app binárisán fut (macOS-en
node-módban az `app.asar`-ból, Windowson `Breaker.exe --helper`), és egy
Electron-frissítés után az app hibátlanul indulhat úgy, hogy a segéd nem —
akkor a tiltás szűnne meg minden gépen. A CI becsomagolt-app jobja ezért a
telepítő parancsával telepíti a segédet, felvesz vele egy oldalt, és a
rendszer feloldójával nézi, hogy tilt-e (`desktop/scripts/mac-helper-probe.sh`,
`desktop/scripts/win-install-probe.ps1`). Electron-frissítést csak akkor adj
ki, ha ez a lépés zöld.

### Amikor az Electron feljebb emeli a legrégebbi macOS-t

Az Electron időnként elengedi a legrégebbi macOS-t (a 38-as a macOS 11-et, a
44-es a macOS 12-t). A v0.4.240-ig kiadott Mac-frissítők ezt nem tudják: minden
zipet felraknak, aminek a nevében `mac` szerepel, és a régi példányt az új
elindítása **előtt** törlik. Egy macOS 12-es gépen így egy el nem induló app
maradna — és a root segéd is ugyanazt a binárist futtatja.

Ezért a rendszerkövetelmény a **csomag nevében** utazik:
`Breaker-0.4.242-arm64-darwin13.zip` (a legrégebbi macOS főverzió, amin fut). A
`darwin` szóban nincs `mac`, tehát a régi frissítő nem látja — marad a működő
verzión —, az újabb (v0.4.241-től) pedig kiolvassa: régebbi macOS-en nem tölt le
semmit, és a fiók-panel kimondja, melyik verzió mit kér, és mi fut a gépen. A
letöltőoldal ezt a zipet sem kínálja kézi letöltésre.

Teendő, amikor egy Electron-frissítés feljebb emeli a határt: a Mac-zip
`artifactName`-je kapja meg a `-darwinNN` végződést (és a `mac.minimumSystemVersion`
ugyanazt az értéket). A DMG saját `dmg.artifactName`-jét ne bántsd: nélküle a
`mac`-é öröklődne rá, és a telepítő neve is a követelményt hordozná. (A
letöltőoldal a DMG-t a nevében lévő `arm64` szerint sorolja Apple szilíciumra
vagy Intelre.) A váltás előtt legyen kint legalább egy
olyan kiadás, ami már érti a nevet — különben a régi frissítők egyszerűen nem
frissítenek tovább, és a felhasználó nem tudja meg, miért.

### Ha a futó képe vált

A linuxos jobok az `ubuntu-latest` címkén futnak, és a GitHub ezt időnként új
főverzióra állítja (2026. október 19-től fokozatosan a 26.04-re). A képpel
együtt cserélődik minden, amit a futó hoz — rendszercsomagok, a böngésző
függőségei, az Android SDK —, és ami ettől eltörik, az kódváltozás nélkül,
egyik napról a másikra lesz piros. Ezért a CI kézzel is indítható egy választott
képen (Actions → CI → Run workflow → `ubuntu-26.04`): a váltás előtt kiderül,
mi nem megy.

Ami a képtől függne, de nem kell, hogy függjön, az rögzítve van: a JVM-tesztek
Gradle-je (`gradle-version` a CI-ban — a kép a sajátját hozná, és az alattunk
cserélődne), a Node és a Java verziója (`setup-node`, `setup-java`).

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
kiadás frissítő-csomagját (a v0.4.257 óta `-darwin13.zip`: a név hordozza a
legrégebbi macOS-t, amin fut — régebbin nem tölti le; előtte `-mac.zip`),
ellenőrzi a méretét és a `latest-mac.yml`-ből a
sha512-t, `ditto`-val kicsomagolja (ez az egyetlen eszköz, ami egy .app-ot
épségben hagy), leveszi a karantén jelzőt, kicseréli a bundle-t, és újraindul.
Ha bármi hibázik, a régi app helyben marad, és a gomb a letöltőoldalt nyitja.
A választás induláskor dől el: `codesign -dv` alapján van-e valódi Developer ID
aláírás. Részletek: `desktop/src/main/mac-updater.ts`.

Amit az aláírás így is hoz: eltűnik a Gatekeeper figyelmeztetés az első
indításnál, és a frissítést az OS ellenőrzi, nem mi.

### A segéd aláíró kulcsa (macOS, #151)

A macOS-segéd egy védett, csak a root által írható futtatókörnyezetből fut
(v0.4.260 óta), és új kódot csak a projekt **kiadási kulcsával aláírt**, a
futónál újabb csomagból vesz át — jelszó nélkül, de egy fájlművelet az app
mappájában nem ad rendszerjogot. A kulcs Ed25519; a nyilvános fele a repóban
van (`desktop/src/shared/helper-keys.ts`), a titkos fele csak a kiadási
folyamat védett környezetében és egy offline mentésben.

**Amíg a lista üres**, a kiadás aláíratlan leírót visz (a futás lapján
figyelmeztetéssel), a felület nem kínálja fel a csomagot, és a védett helyen
futó segédek csak akkor frissülnek, ha a protokoll változik (a sáv gombja,
egy jelszó). Ha addig a segéd kódjában olyan javítás megy ki, aminek el kell
jutnia a gépekre, emeld a `HELPER_VERSION`-t (`shared/protocol.ts`) — enélkül a
régi kód fut tovább, és csak a diagnosztika mondja ki.

Egyszeri beállítás (a saját gépeden, nem a CI-ban):

```bash
node desktop/scripts/gen-helper-key.js ~/breaker-helper-r1.pem r1
```

1. A kiírt `{ id: 'r1', spki: '…' }` sor a `helper-keys.ts` listájába kerül
   (ez nem titok). Onnantól minden kiadás aláírt csomagot kér.
2. GitHub → Settings → Environments → `helper-signing` (az első kiadás
   magától létrehozza, védelem nélkül — ezért állítsd be). A „Deployment
   branches and tags” alatt „Selected branches and tags”: a `v*` címkék (a
   címke-push ezen fut), és ha kézzel indítod (Run workflow), az az ág is.
   Benne egy titok: `HELPER_SIGNING_KEY`, az értéke a `.pem` fájl teljes
   tartalma. Ha a „Required reviewers” alatt te magad is ott vagy, minden
   kiadás megvárja a jóváhagyásodat — ez erősebb, de a kiadás addig áll.
   Reviewer nélkül egy `v*` címkét toló bárki aláíratná a címkézett commit
   csomagját: ezért a címkéket is védd (Settings → Rules → Rulesets → új „tag
   ruleset” a `v*` mintára: csak te hozhatod létre, mozgathatod, törölheted).
3. A `.pem` fájlról offline mentés (például titkosított pendrive), aztán
   töröld a gépről.

**Mit csinál a build.** Az `npm run build` utolsó lépése a segéd csomagja
(`scripts/pack-helper-payload.js`): a `dist/helper/index.js`-ből elérhető
lefordított fájlok (rootként csak a Node beépített moduljai — egy
npm-függőség a zárlatban hiba), az eltávolító és egy kis `package.json`, egy
determinisztikus tarban (`dist-payload/helper/payload.tar`), mellé a leíró
(`manifest.json`: a csomag és a rögzített Node ujjlenyomata). Helyben az `npm
run dist` írja alá (`scripts/sign-helper-manifest.js`, a `HELPER_SIGNING_KEY`
változóból); kulcs nélkül aláíratlan marad (fejlesztői build). A Mac-csomagban
`Contents/Resources/helper/` alatt van; a füstpróba (`scripts/smoke-packaged.sh`)
ellenőrzi, hogy ott van, és az ujjlenyomata a leíróé.

**A kiadásban** (`release.yml`) két job dolgozik a csomagon. A `helper-build`
titok és jogosultság nélkül, Linuxon megépíti (itt fut a fordító és minden
függőség). A `helper-signing` környezetben futó `helper-sign` csak letölti, és
`--release` módban aláírja — függőség, fordítás és lefordított kód nélkül: az
aláíró (`scripts/sign-helper-manifest.js`) csak a Node beépített moduljait és
a repó saját fájljait használja, a kulcslistát a forrásból olvassa
(`helper-keys.ts`; egy teszt nézi, hogy a lefordítottal egyezik). A
csomagban nem lehet a CI-próba kulcsa, és ha van kiadási kulcs, az aláírás
kötelező. A macOS-csomagoló a saját buildje mellé veszi át
(`sign-helper-manifest.js --adopt`) — csak ha a két build bájtra ugyanazt a
csomagot adta, a leíró többi része is egyezik, és az aláírás a kulcslistával
érvényes. Egy eltérésnél a kiadás megáll: a csomag determinisztikus, tehát
valami más forrásból vagy más eszközzel épült. Hogy a Linuxon és a macOS-en
épített csomag bájtra egyezik-e, a CI minden pushnál nézi
(`helper-payload-linux` → a macOS-csomagoló összeveti).

**A CI** a macOS-próbához minden futáskor egy ideiglenes kulcsot generál: a
nyilvános fele (`BREAKER_HELPER_TEST_PUBKEY`) a csomag `test-keys.json`-jába
kerül, a titkos fele a próbáé, ami vele aláírt csomagokat kínál fel a
telepített segédnek. Kiadásba ilyen csomag nem mehet (a `--release` és az
`--adopt` is elutasítja).

**Kulcscsere.** Az új kulcs nyilvános felét egy kiadással KORÁBBAN kell
felvenni, mint ahogy aláírnánk vele: a telepített segédek a saját listájukkal
ellenőriznek. Egy elveszett kulcs után minden Macen egy jelszó kell a
következő frissítéshez (a régi segéd az új kulcsot nem ismeri); egy
kiszivárgott kulcs minden telepített Macen rendszerjogot ad — ezért a
környezet ághoz (és ha kéred, jóváhagyáshoz) kötött, és a kulcs sehol máshol
nincs.

### A Node-futtató rögzítése (macOS, #151)

A védett futtatókörnyezetben a segédet a hivatalos Node.js futtatja, nem az
Electron. A verziót, a két tarball (arm64, x64) és benne a bináris SHA-256-ját
a `desktop/src/shared/helper-runtime.ts` rögzíti (`NODE_RUNTIME`), az aláíró
Apple Team ID-val együtt (Node.js Foundation, `HX7739G8FX`). Csere csak így:

1. Le a `SHASUMS256.txt`-t és a `SHASUMS256.txt.asc`-t a
   `https://nodejs.org/dist/<verzió>/` alól; a Node kiadói kulcsait a
   [nodejs/release-keys](https://github.com/nodejs/release-keys) adja.
   `gpg --verify SHASUMS256.txt.asc SHASUMS256.txt` — „Good signature”
   nélkül tovább ne.
2. A két `node-<verzió>-darwin-{arm64,x64}.tar.xz` SHA-256-ja és mérete a
   SHASUMS szerint; a `bin/node` kibontva, a SHA-256-ja a `binSha256`.
3. A Node-nak a támogatott legrégebbi macOS-en is futnia kell
   (`minMacos`, és az `electron-builder.yml` `minimumSystemVersion`-je).
4. Egy új rögzítés az app minden Mac-telepítésénél új Node-letöltést jelent;
   a telepített segédek a csendes frissítéskor az új tarballt is kérik.

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

A Play 2026. augusztus 31. óta csak a 36-os API-ra (Android 16) célzó
frissítést fogad; az app erre céloz (`targetSdk = 36`). A 35-ös API-tól a
rendszer a tartalmat a rendszersávok mögé rajzolja (edge-to-edge): a felület a
biztonságos területen tartja magát (`WindowInsets.safeDrawing`). A CI ezt
lefordítja és a lint végzetes hibáit is nézi, de eszközön nem próbálja ki — egy
kiadás előtt érdemes egy telefonon ránézni, hogy semmi nem csúszik az
állapotsor vagy a navigációs sáv alá.

A feltöltendő AAB a `play` ízből készül (`bundlePlayRelease`), nem ugyanaz a
csomag, mint a letölthető APK (`direct`). A Play szabálya szerint a Play-ből
telepített app csak a Play-en át frissülhet, a `REQUEST_INSTALL_PACKAGES` pedig
korlátozott engedély, önfrissítésre nem adható — a GitHub-os APK ráadásul más
kulccsal van aláírva, mint amit a Play kiad. A `play` íz manifestjéből ezért
kimarad az engedély és az önfrissítő, és a kiadás (a CI is, minden pushnál) a
kész AAB manifestjében meg is nézi (`scripts/check-play-bundle.sh`, egy pozitív
próbával: az INTERNET engedélyt látnia kell, különben a módszer romlott el).

A következő célszint (API 37, Android 17) a helyi hálózatot is engedélyhez
köti ([local network permission](https://developer.android.com/privacy-and-security/local-network-permission)):
a 37-re célzó app egy helyi címet csak futásidőben kért `ACCESS_LOCAL_NETWORK`
engedéllyel ér el — addig az `INTERNET` engedély hallgatólagosan megadja. A
Breakernél ez a párosított gép szinkron-kiszolgálója (`http://192.168.x.y:8787`);
a DNS-szűrő 53-as portja kivétel. A célszint emelésekor tehát engedélykérés
kell, és egy hibaüzenet, ami megmondja, hol kapcsolható be — mint az iPhone-on
(`SyncClient.localNetworkHint` a Swift-magban), különben a szinkron csak annyit
mond, hogy a kiszolgáló nem érhető el.

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
