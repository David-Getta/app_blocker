# JVM tesztkészlet az Android maghoz

Ez a kis Gradle-projekt az Android app **platformfüggetlen logikáját** futtatja
és teszteli egy sima JVM-en — **Android SDK és emulátor nélkül**.

```bash
cd android/jvm-tests
gradle test        # vagy: ../gradlew -p . test
```

## Miért van rá szükség

A Lakat lényegi logikája (blokklista, próbatétel-motor, bíró, menetrend,
idő-mérés, állapot-perzisztencia) alig érinti az Androidot: mindössze a
`Context`, a `SharedPreferences` és néhány rendszerszolgáltatás kell hozzá.
Ezeket a `src/stubs/` alatt kiváltjuk, így a **valódi, szállított forrásfájlok**
fordulnak és futnak itt.

Ennek két haszna van:

1. **Bárhol futtatható.** Nem kell SDK, emulátor vagy eszköz — CI-ban is elmegy
   pár másodperc alatt.
2. **Nem tud elcsúszni.** A build a `../app/src/main/java` könyvtárból fordít,
   nem másolatból; ha a produkciós kód változik, a teszt azonnal azt látja.

## Mit fed le

| Fájl | Mit ellenőriz |
|---|---|
| `UsageLogicTest` | idő-aggregálás, megőrzés, óraugrás-védelem, statisztikák, mintavételi szabály |
| `RefereeTest` | feloldási munkamenet végig, hibás válasz, memória-próba kivárása, törlés 24 órás türelmi idővel, elmulasztott átvételi ablak, menetrend-lazítás kapuja |
| `TrackerAndStoreTest` | mérés-pufferelés, éjfél-átnyúlás, StateFlow-emisszió, domain-hozzárendelés, JSON-perzisztencia és régi állapotfájl migrációja |

A `UsageLogicTest` szándékosan a `desktop/test/usage.test.ts` tükre: a két mag
azonos algoritmust valósít meg, és ez a fájl tartja őket szinkronban.

## Amit NEM fed le

A Compose felület, a `VpnService`, a DNS-csomagkezelés futásidejű viselkedése és
az Android-specifikus engedélykezelés — ezekhez valódi Android build kell
(`../gradlew assembleDebug`). A DNS-motor bitszintű logikája viszont szintén
tiszta Kotlin, így az is tesztelhető lenne itt, ha később kell.

## Stubok

A `src/stubs/kotlin/android/**` alatt szándékosan **minimális** stand-in
osztályok vannak — csak annyi, amennyit a tesztelt kód ténylegesen hív. Nem cél
az Android API utánzása; ha egy teszt igazi Android-viselkedést igényelne, az a
teszt nem ide való.
