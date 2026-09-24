# Törlés-védelem: hogy a törlés ne legyen egy koppintás

A telefonon a védelem egyetlen mozdulattal eltüntethető: hosszan nyomod az
ikont, „Eltávolítás”, kész — és vele minden blokk, minden zárlat, minden
menetrend. Nem próbatétel, nem gondolkodás, egy koppintás. A hajnali kettes
késztetésnek pont ennyi elég.

A **törlés-védelem** ezt az egy gombot veszi el. Amíg be van kapcsolva, az
Android nem engedi az egykoppintásos eltávolítást: előbb ki kell kapcsolni a
törlés-védelmet, és csak utána lehet törölni. A törlés így nem reflex, hanem
tudatos, több lépéses döntés.

Ez a szokásos, dokumentált Android-mód: **eszközadmin** (device admin). Ugyanaz
a mechanizmus, amit a képernyőidő-, lopásvédelmi és felügyeleti appok
használnak — csak itt kizárólag magadnak, magad kapcsolod be.

## Mit ad, és mit NEM

A házirendünk (`res/xml/device_admin.xml`) **szándékosan üres**. Az eszközadmin
sok mindent tudna szabályozni (jelszó-erősség, kamera-tiltás, adattörlés) — mi
ezek közül **egyet sem** kérünk. Az aktív eszközadminnak egyetlen olyan hatása
van, amit használunk: amíg él, a rendszer nem engedi a sima eltávolítást.

- **Nem** lát bele a telefonodba, nem olvas adatot, nem szabályoz semmit.
- **Nem** kényszerít „always-on VPN”-t (azt csak eszköz-tulajdonos / profil-
  tulajdonos DPC tudná, ami sokkal több — mi nem vagyunk az).
- **Nem** töröl és nem zárol adatot.

Egyetlen dolgot ad: a törlés súrlódását.

## A híd befelé csak szigorít

- **Bekapcsolni egy koppintás.** A kártyán a gomb a rendszer eszközadmin-
  párbeszédét nyitja; te hagyod jóvá. Szigorítás, ingyen.
- **Kikapcsolni szándékos lépés.** Csendes, egykoppintásos kikapcsolót
  **nem adunk** — az visszahozná a reflexből törlést, ami ellen az egész véd.
  A kártya elvisz a rendszer biztonsági beállításáig; ott, az eszközadmin-
  listán lehet tudatosan kikapcsolni, a rendszer figyelmeztetésével.

A kikapcsolás megerősítő képernyőjén a rendszer a mi mondatunkat mutatja
(`onDisableRequested`): hogy ezzel visszatér az egykoppintásos törlés.

## Őszinte korlát

Ez **nem gépzár**, és ezt nyíltan kimondjuk. A rendszer Beállításaiban
(Biztonság → Eszközadmin-alkalmazások) az eszközadmin próbatétel nélkül is
kikapcsolható — nem tudjuk megakadályozni, és nem is tettetjük. De már **nem
egy koppintás**: keresd meg a beállítást, kapcsold ki, erősítsd meg, és csak
utána törölj. Épp ez a pár másodperc gondolkodás a lényeg — az impulzus ellen
véd, nem a megfontolt szándék ellen. Ugyanaz az elv, mint a zárlaté: nem
lehetetlenné teszi, hanem drágábbá.

## A többi platformon

A mechanizmus (eszközadmin) Android-oldali, de a *rés* mindenütt ugyanaz: a
törlés egy koppintás. Ahol tudjuk, ott elvesszük az egy gombot; ahol nem, ott
legalább kimondjuk, hova.

- **iPhone:** az Apple nem enged appnak ilyen jogot, tehát az app maga nem tud
  törlés-védelmet adni. A rendszer viszont ad rá utat: a **Képernyőidő**
  (Beállítások → Képernyőidő → Tartalmi és adatvédelmi korlátozások →
  App-törlések: „Nem engedélyezett”, Képernyőidő-kóddal). Az iOS-app a
  kezdőlapon, a zárlat mellett, egy „Törlés-védelem” szekcióban kimondja ezt
  az utat — magyarázat, nem kapcsoló (a Képernyőidő állapotát appból nem
  látjuk, és nem is tettetjük). A döntés helyén a törlés így itt se reflex.
- **Windows / macOS:** a gépen a védelmet egy rendszergazdai jogú
  háttérszolgáltatás tartja, ennek eltávolítása eleve rendszergazdai lépés és
  külön eltávolító szkript (`docs/desktop.md`) — ott már megvan a súrlódás.

## Kód

- `admin/BreakerDeviceAdminReceiver.kt` — az eszközadmin vevő; az egyetlen
  dolga a kikapcsolás-figyelmeztetés (`onDisableRequested`).
- `admin/UninstallGuard.kt` — az állapot és a be-/kikapcsolás útjai egy helyen.
  Az állapotot a rendszertől kérdezzük (`isAdminActive`), nem tároljuk: nincs
  mit szinkronizálni, ez a készülék dolga.
- `res/xml/device_admin.xml` — az üres házirend.
- A manifest a vevőt `BIND_DEVICE_ADMIN` engedéllyel regisztrálja, hogy csak a
  rendszer indíthassa.
- A felület kártyája az `ui/AppUi.kt`-ban, a zárlat-kártya mellett — a kettő
  együtt zárja azt a rést, amit a zárlat maga őszintén bevall („az app
  letörölhető”).

Nincs közös-mag logika és nincs szinkron-mező: a törlés-védelem tisztán
Android-oldali, eszköz-helyi képesség.
