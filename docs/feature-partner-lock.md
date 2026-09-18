# Párban zárolás: a lazítás végén a megbízott jelmondata

A próbatétel a saját impulzusod ellen véd: munkába kerül, de egyedül is meg
lehet csinálni. Van, akinek ez kevés — neki az kell, hogy a lazítás ne csak
drága legyen, hanem **más ember döntése is**. A párban zárolás ezt adja:
kiválasztasz egy megbízottat (társ, barát, szülő), aki egy jelmondatot kap; és
minden lazító próbatétel **utolsó lépése** az, hogy ő beírja. Nem helyetted
csinálja végig — a munka a tiéd —, csak az utolsó szót ő mondja ki.

A szabály ugyanaz, mint mindenhol: **felvenni ingyen** (szigorítás), **levenni
próbatétel** — a megbízott jelmondatával a végén, tehát a levételhez is ő kell.

## Hogyan működik

1. A *Zárlat* kártyán (gépen, Androidon, iPhone-on) beírod a megbízott nevét,
   és az app **sorsol egy jelmondatot**: négy szó a próbatételek szólistájából,
   kisbetűvel (például „alma bogrács cinege délután”).
2. A jelmondat **egyszer látszik**, egy lapon: átadod a megbízottnak, és
   bezárod. Az app csak a **lenyomatát** tartja meg (scrypt, ugyanazokkal a
   paraméterekkel, mint a fiók kulcsáé, friss sóval); a szöveg sehol nincs —
   se az állapotfájlban, se a szinkronban.
3. Innentől minden lazító próbatétel terve egy lépéssel hosszabb: a várakozás
   **után** áll a megbízott lépése. Feloldás, törlés, menetrend-lazítás,
   keret-emelés, adag-lazítás, hosztnév- és szabály-levétel, menet-leállítás,
   ablak-lazítás — mind ezen az egy kapun jön ki, tehát mindre vonatkozik.
4. A lépésen a jelmondatot **a megbízott írja be** (jelszómező, beillesztés-őr
   nélkül — ez nem gyakorlat, hanem másvalaki döntése). A kanonikus alak
   számít: kis-nagybetű, dupla szóköz nem. Rossz jelmondat nem sorsol új
   feladatot, csak számol; **ötször** rossz jelmondat után a kísérlet
   érvénytelen — elölről, minden lépéssel (a feladott kísérletek könyvelése
   szerint, tehát kedvezmény sincs).
5. **Levétel:** a *Levétel…* gomb próbatételt indít, aminek a végén szintén a
   megbízott jelmondata áll. Ha közben (a szinkronból) a megbízott lekerült, a
   lépés tárgytalan: átmegy.

Zárlat alatt a levétel sem indítható — ugyanaz a kapu (`docs/feature-lockdown.md`).

## Hol van a felületen

- **Gépen, Androidon, iPhone-on:** a *Zárlat* kártyán — a megbízott neve, a
  jelmondat egyszeri lapja, a *Levétel…*. A próbatétel lapján a lépés
  jelszómezőként jön, a legvégén, a várakozás után.
- **A böngésző-bővítményben:** a tiltó lap lába a próbatétel mellé kimondja,
  hogy a feloldás útja a megbízott jelmondatával ér véget („A feloldáshoz a
  megbízottad (Anna) jelmondata is kell — az utolsó szó az övé.”); a felugró
  lap is mondja. Zárlat alatt nem — ott út sincs. A híd csak a nevet adja le
  (`partner`), a lenyomat az appé; a frissesség nem számít, a megbízott a
  lenyomattal él, nem a lehúzással.
- **A gyorsbillentyűs rétegben:** a futó menet lába ugyanezt mondja a
  leállítás útjáról.

## Szinkron

A megbízott a **munkamenet blobján** utazik (`partner`: név, só, lenyomat,
dátum; `partnerRev`: a jele), tehát a gépen felvett megbízott a telefonokon is
az utolsó szó. A lenyomat nyelvfüggetlen: a `fixtures/partner-hash.json` őrzi,
hogy a TypeScript, a Kotlin és a Swift ugyanarra a jelmondatra ugyanazt a
lenyomatot számolja — a jelmondat egy eszközön születik, bármelyiken
ellenőrizhető.

A fésülés a zárlat-ablakok mintája: a **jel dönt**, nem az újabb blob. A jel
annak a blobnak a `rev`-je, amelyik utoljára felvette vagy levette. Nagyobb jel
nyer; azonos jelnél a **beállított** (a szigorúbb irány); ha mindkét oldalon
van, a korábban felvett. Így a levétel (próbatétel, ami lépteti a jelet) átmegy,
de egy másik eszköz csomag-szerkesztése nem viszi el a megbízottat — és fel sem
támasztja. Egy régi kliens jeltelen blobja (jel = 0) sosem viszi el.

Az átvett megbízott kulcsát a szinkron eltárolja (`focusRevPartner`), hogy a
következő helyi szerkesztés ne bélyegezze át a jelét: azonos jelnél a
beállított nyerne, és egy másik eszköz levételét írná felül.

## Őszinte határok

- **Nem gépzár.** Aki rendszergazdaként a segéd állapotfájljába nyúl, az a
  lenyomatot is le tudja venni — ahogy a zárlatot is; a telefonon az app
  letörölhető. Az impulzus ellen véd, nem a szándék ellen.
- **A megbízott a jelmondatot bármikor átadhatja** — az ő döntése, pont ez a
  lényeg. Ha a jelmondat nálad van, a párban zárolás csak egy jelszó.
- **Ha a jelmondat elvész, a megbízottat nem lehet levenni** — se próbatétellel.
  Ez szándékos (különben a jelmondat nem érne semmit), de ki kell mondani: a
  jelmondatot a megbízott őrizze. A kiút ugyanaz, mint fent: az állapotfájl,
  vagy az app törlése.
- A lenyomat lassú (scrypt, tizedmásodperc körül): négy szó a szólistából
  sokmilliárd kombináció, a lassúság azt évekre nyújtja. Ez nem a kiszolgáló
  elleni védelem, hanem a „csak megnézem a fájlban” ellen.

## Hol van a kódban

- Gép: `desktop/src/shared/partner.ts` (tiszta mag: kanonikus alak, rekord,
  fésülés), `desktop/src/helper/partner-crypto.ts` (lenyomat, ellenőrzés),
  a bíró (`helper/referee.ts`: `setPartner`, `startPartnerRemoval`, a
  `PARTNER` lépés), a szinkron (`shared/sync/focus-merge.ts`,
  `helper/revisions.ts`), a felület (`renderer.ts`: a zárlat kártya blokkja, a
  jelmondat lapja, a lépés).
- Android: `core/Partner.kt`, a bíró, `FocusSync.kt`, `SyncRevisions.kt`,
  `SyncClient.kt`, `AppUi.kt`.
- iPhone: `Shared/Partner.swift`, `Referee.swift`, `FocusSync.swift`,
  `SyncRevisions.swift`, `SyncClient.swift`, `ChallengeView.swift`,
  `ContentView.swift`.
- Tesztek: `desktop/test/partner.test.ts`, `android/jvm-tests/.../PartnerTest.kt`,
  `ios/SharedTests/PartnerTests.swift` — mind a `fixtures/partner-hash.json`
  ellen. A három szám (szavak, névhossz, próbák plafonja) a
  `scripts/check-core-sync.js` alatt; a drót-mezők a `check-wire-names.js`
  alatt; a kapu és a lépés kirajzolása a `check-enforcement.js` alatt.
