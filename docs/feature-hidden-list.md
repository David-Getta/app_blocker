# A rejtett lista és a zárja

A blokklista elrejthető: az app minden induláskor csukott listával nyílik, és
csak annyi látszik, hogy „3 oldal van blokkolva”. Ezt a rejtést eddig egy
koppintás fel is oldotta. Ettől a kiadástól a **megnyitás a készülék
azonosítását kéri** — ujjlenyomat, arc vagy a képernyőzár kódja. A rejtés így
nem csak nem emlékeztet: **véd is**.

## Mit ad, és mit NEM

- **Ad:** aki a kezébe veszi a telefont vagy a gépet, nem koppint rá egy
  gombra, hogy lássa, mi ellen küzdesz. A lista csak a te ujjadra, arcodra vagy
  kódodra nyílik — és csak addig, amíg be nem zárod az appot.
- **Ad:** a rejtés egy koppintás marad (szigorítás), a felfedés nem az (lazítás).
  Ugyanaz az elv, mint mindenütt: a híd befelé csak szigorít.
- **NEM ad:** nem lát se ujjlenyomatot, se kódot. Az azonosítás a rendszeré —
  Androidon a BiometricPrompt, iPhone-on a LocalAuthentication, Macen a Touch
  ID —, az app csak egy igen/nem választ kap.
- **NEM ad:** nem önuralmi kapu. Te magad mindig át tudsz jutni rajta; az
  impulzus ellen a próbatétel véd, ez a kíváncsi szem ellen.

## A híd befelé csak szigorít

A rejtés bekapcsolása egy koppintás, azonnal érvényes, és újraindítás után is
áll. A felfedés a készülék azonosítása; a rejtés kikapcsolása („Ne rejtse ezután”)
pedig csak nyitott lista mellett érhető el — vagyis szintén az azonosítás után.
Így nincs olyan út, amin a rejtett lista azonosítás nélkül előkerülne.

## A fedőnév felfedése is

Ugyanez a zár áll a **fedőnév** mögött: egy fedőnevesített oldal valódi címét a
„Mutasd” gomb hat másodpercre előhívja — ettől a kiadástól szintén a készülék
azonosítása után. A rés ugyanaz (egy koppintás, és látszik, mi bújik a név
mögött), tehát a zár is ugyanaz; és ugyanúgy kimondja, ha nincs mivel
azonosítani, vagy ha az azonosítás nem sikerült. A lista és a fedőnév kapuja egy
üzenet-sort használ, a lista alatt — rejtve és nyitva egyaránt.

A fedőnév **levétele** is ezen a kapun át megy: az is felfed — onnantól a valódi
cím áll a listán. Az átnevezés nem fed fel, az marad egy koppintás. Elutasításnál
a fedőnév marad, és a párbeszéd (a gépen) vagy a sor (a telefonon) kimondja. A
segéd (a bíró) ebből semmit nem lát: a zár a felületé, a `set_alias` op ugyanaz. Hogy melyik változás levétel, azt a mag mondja meg egy
helyen (`isAliasRemoval` / `isRemoval`), tesztekkel mindhárom nyelven.

## A rejtés a fiók egészére szól

A rejtés eddig eszközönként állt: a telefonon rejtve, a gépen mégis látszott a
lista. Most a `hideSiteList` a szinkron `focus` dokumentumában utazik, a JELÉVEL
(`hideSiteListRev`), a zárlat-ablakok és a megbízott mintájára:

- **Bekapcsolva bárhol, mindenhol áll.** A rejtés szigorítás, ingyen van — a
  következő szinkronkor a többi eszközön is rejtve indul a lista.
- **A kikapcsolás munkába kerül, és a kifizetett kikapcsolás átmegy.** A
  kikapcsolás a készülék azonosítása után történik, lépteti a jelet, és a
  nagyobb jel nyer — egy régi blob nem támasztja fel a rejtést, de egy másik
  eszköz csomag-szerkesztése (ami a jelet nem lépteti) nem is kapcsolja ki.
- **Azonos jelnél a rejtett** — a szigorúbb irány. Két jel nélküli (régi)
  kliens között ugyanez: ha bárhol rejtve, mindenhol az.
- **A régi kliens semleges.** Mező nélkül nem tud kikapcsolni, és a lenyomat
  a nem rejtett állapotban változatlan, tehát a frissítés utáni első kör
  senkinél nem léptet fölöslegesen.

A fésülés (`mergeHide`) mindhárom nyelvben ugyanaz, a `fixtures/merge-cases.json`
80 esete és a fuzz-tesztek őrzik; a megnyitás továbbra is eszközönkénti és
munkamenetnyi (`listOpenThisSession` nem utazik).

## Őszinte korlát

- **Ahol nincs mivel azonosítani** — nincs képernyőzár a telefonon, Windows-gép,
  vagy Mac ujjlenyomat-olvasó nélkül —, ott nincs mit kérni. A lista kérésre
  megnyílik, és a kártya **kimondja**, hogy itt nem kért semmit. Néma kapu
  helyett őszinte mondat: hamis biztonságot ígérni rosszabb, mint kimondani a
  határt. Windowson az Electronnak nincs rendszer-azonosító hívása (Windows
  Hello); ez a mai korlát, nem döntés.
- **Elutasított azonosítás** után a lista rejtve marad, és ezt is kimondja.
  Egy rossz próba nem vég: a rendszer párbeszéde nyitva marad, újra lehet
  próbálni.
- A megnyitás **csak erre a munkamenetre** szól. A beállítás marad „rejtve”;
  a következő induláskor megint csukva van, és megint azonosítást kér.
- Ez **nem titkosítás**. Az adat a készüléken ugyanúgy ott van, mint eddig;
  a zár a felületen áll, a kíváncsi szem ellen — nem a fájlrendszer ellen.

## A többi platformon

- **Android:** `BiometricPrompt`, `BIOMETRIC_WEAK | DEVICE_CREDENTIAL` — a
  kompatibilitási könyvtár minden API-szinten tudja; a rendszer maga ajánlja
  fel az ujjlenyomatot, az arcot vagy a képernyőzár kódját. Ehhez a
  `MainActivity` `FragmentActivity` lett (a Compose-kód változatlan), és a
  manifest kéri a `USE_BIOMETRIC` jogot.
- **iPhone és Mac (SwiftUI app):** `LAContext`, `.deviceOwnerAuthentication` —
  Face ID / Touch ID, kód-visszaeséssel. Az `NSFaceIDUsageDescription` a
  plistben kimondja, mire kérjük.
- **Windows / macOS (Electron):** Macen `systemPreferences.promptTouchID`, ha
  van olvasó (`canPromptTouchID`); különben — és Windowson mindig — a kártya
  kimondja, hogy nincs mivel azonosítani, és a lista kérésre megnyílik.

## Kód

- `android/.../auth/ListLock.kt` — `canAuthenticate`, `prompt`; a rendszer
  párbeszéde, igen/nem válasz.
- `ios/App/ListLock.swift` — ugyanez `LAContext`-tel: `granted` /
  `unavailable` / `denied`.
- `desktop/src/main/main.ts` — `breaker:authenticate` (Touch ID vagy
  `unavailable`); `preload.ts` — `authenticate()`; `renderer.ts` — a
  „Lista megnyitása” a kapun át, a `#listGateLine` mondja ki az eredményt.
- `desktop/scripts/ui-shots.js` — a kapu három ága a füstpróbában:
  elutasítás (rejtve marad), nincs olvasó (megnyílik és kimondja), siker.
- `scripts/check-enforcement.js` — öt tű őrzi, hogy a kapu mind a három
  platformon és a híd két oldalán bekötve maradjon.
