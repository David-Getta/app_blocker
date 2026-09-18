# Kulcsszó-szabályok: bármely oldalon, ha a cím tartalmazza

A blokklista **egész oldalakat** lát (a DNS a hosztnévnél tovább nem lát), a
részleges szabály egy oldal **egy útvonalát** (`youtube.com/shorts`). Ami eddig
hiányzott: *„bárhol, ahol a címben ez a szó szerepel”* — `shorts`, `reels`,
`live`, egy játék neve. A kulcsszó ezt adja: egy szó, és a böngésző minden
olyan címet a tiltó lapra visz, amiben szerepel — a hosztnévben is, az
útvonalban is, a lekérdezésben is.

A szabály ugyanaz, mint mindenhol: **felvenni ingyen** (szigorítás: több cím
zárva), **levenni próbatétel** — különben a kulcsszó egy kikapcsolóval érne
fel.

## Hogyan működik

1. A gépen a *Kulcsszavak* kártyán (a telefonon a *Zárlat* kártya alján)
   beírod a szót, és *Felvétel*. A szó
   **kanonikus alakban** kerül fel: kisbetű, NFKC, a szélek levágva; szóköz
   nem lehet benne (egy cím sem tartalmaz szóközt), és 3–40 karakter (egy-két
   betű mindenre illene — az nem szabály, hanem baleset). Legfeljebb 40 szó.
2. A segéd a listát tartja, és a **hídon leadja** a böngésző-bővítménynek
   (`keywords`). A bővítmény tisztítva tárolja, és minden navigációnál dönt:
   az egész oldal zárása (a segéd „zárva” listája) után, a csatorna-szűrő és
   a részleges szabály előtt — mert tágabb, mint azok.
3. Az illesztés a **cím szövegén** megy: séma nélkül, a százalék-kódolás
   feloldva, NFKC kisbetűvel; a rossz kódolás nem dob, marad, ahogy jött. Ha
   több szó is illik, a lista sorrendje dönt.
4. Találatnál a tiltó lap **kimondja, melyik szó** volt az („Ezt a kulcsszót
   te tiltottad le.”), és a lába a szokásos utat: levenni az appban,
   próbatétel — megbízottal az ő jelmondatával a végén. A felugró lap a
   számot mondja.
5. **Levétel:** a címkére kattintva a szó *levétele* próbatételt indít
   (`siteId: 'keywords'`); a szó **addig marad**, amíg a próbák meg nincsenek,
   és a bővítmény addig tilt vele. Újat felvenni közben is ingyen lehet — és a
   levétel végén sem vész el: a függő lista is megkapja, ami közben jött.

Zárlat alatt a levétel sem indítható — ugyanaz a kapu (`docs/feature-lockdown.md`);
a megbízott lépése a végén itt is áll (`docs/feature-partner-lock.md`).

## Hol van a felületen

- **Gépen:** a *Kulcsszavak* kártya, a zárlat és a csatorna-szűrő között. A
  címkék (`shorts ×`) maguk a levétel gombjai; a mező alatt a hiba (rövid,
  szóközös, már fent van, betelt).
- **A böngésző-bővítményben:** a tiltó lap külön kártyája a szóval; a felugró
  lap számként („N kulcsszó”). A beállítás-lapon nem szerkeszthető — levenni
  az appban kell, ahol próbatételbe kerül.
- **Androidon és iPhone-on:** a *Zárlat* kártya alján, *Kulcsszavak a
  böngészőben* — ugyanaz a felület, ugyanaz a szabály: felvenni ingyen,
  levenni próbatétel (a telefon bírója: `Referee.setKeywords`, a függő lista a
  teljesítéskor ül be; a közben felvett szó itt sem vész el). A lista a fiókon
  át a gépekre átér, és a gépi böngésző tilt vele. A rendszer-szintű
  DNS-szűrő a címet nem látja, **a telefonon a kulcsszó nem tilt** — ezt nem
  titkoljuk, a felület kimondja.

## Szinkron

A lista a **munkamenet blobján** utazik (`keywords`: a szavak; `keywordsRev`:
a jele). A fésülés a zárlat-ablakoké és a megbízotté: a **jel dönt**, nem az
újabb blob. A jel annak a blobnak a `rev`-je, amelyik a listát utoljára
változtatta; nagyobb jel nyer, azonos jelnél a **bővebb** (az unió — a
szigorúbb irány). Egy régi kliens jeltelen blobja (jel = 0) sosem töröl
listát. Az átvett lista kulcsát a szinkron eltárolja (`focusRevKeywords`),
hogy a következő helyi szerkesztés ne bélyegezze át a jelét.

A mag három nyelven ugyanaz — `desktop/src/shared/keywords.ts`, a bővítmény
`keywords.js`-e, `core/Keywords.kt`, `Shared/Keywords.swift` —, és az
ellenőrzők őrzik: a plafonok (`check-core-sync`), a mezőnevek
(`check-wire-names`), és hogy a lista tényleg eljusson a lapig
(`check-enforcement`). A bővítmény illesztését a kiszállított bájtokon a gépi
maggal cím-lista párokon vetjük össze, és a valódi böngészős végponti teszt is
végigviszi (a szó a tiltó lapra visz, a szó nélküli cím ugyanazon a hoszton
szabad).

## Őszinte határok

- **Csak a böngészőben tilt**, és csak ott, ahova a bővítmény telepítve van.
  Inkognitóban alapból nem fut; vendég módban bővítmény nincs. A telefonon
  a lista szerkeszthető és átér, de ott nem tilt — kimondva.
- **Nem tartalom-szűrő.** A cím szövegét nézi, nem az oldalét: egy videó a
  címében nem hordozza, miről szól. Amit a cím nem mond ki, azt a kulcsszó
  nem látja.
- **A rövid szó sokra illik.** A „live” a `livestream`-re és az
  `olive.example`-re is; ezért a három betű az alsó határ, és ezért a lap
  mindig kimondja, melyik szó fogott.
- **Nem gépzár.** A segéd állapotfájljába rendszergazdaként bele lehet nyúlni,
  a bővítmény kikapcsolható — ahogy minden más szabálynál; az impulzus ellen
  véd, nem a szándék ellen.
