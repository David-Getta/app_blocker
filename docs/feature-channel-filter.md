# Csatorna-szűrő: csak a felsorolt csatornák nyílnak meg

A felhasználói kérés szó szerint: „a youtube meg az ilyen oldalaknál lehessen
csak csatornákat tiltani… be lehessen írni, hogy melyiket használhatom, és a
többit meg nem tudom megnyitni. Ez ne egy full letiltás legyen, hanem egy
bekapcsolható, mint a munkamenetek. Nem kell inkognitóban is tiltva legyenek.”

Ez a MEGFORDÍTOTT részleges tiltás. A részleges szabály feketelista (a
felsorolt darabok tiltva), ez fehérlista egy oldal csatornáira: amíg a szűrő
be van kapcsolva, a csatorna-alakú címek közül csak az engedélyezettek nyílnak
meg. Az oldal többi része — kezdőlap, keresés — szabad marad: ez nem teljes
tiltás, hanem mód.

## Hol él, és miért ott

**A böngésző-bővítményben.** A DNS a hosztnévnél tovább nem lát: a
`youtube.com/@valaki` és a `youtube.com/@masik` ugyanaz a név. Egy csatornát
csak az láthat, aki a teljes címet látja — a gépen ez kizárólag a bővítmény.

A felhasználó ezt a hatókört kifejezetten elfogadta: nem kell inkognitóban is
élnie. A bővítmény alapból nem fut inkognitóban és vendég módban — ott a
szűrő sem. Ez ugyanaz a kimondott, gyengébb réteg, mint a részleges tiltásé.

A telefonokon a szűrő NEM érvényesül (ott nincs bővítmény-rendszer, és a
DNS-alapú szűrő címet nem lát). A REKORDOK viszont a fiókon át a gépek közt
szinkronizálódnak (`channels` gyűjtemény, egy blob a fiók egészére): a másik
gépen a saját bővítménye érvényesíti ugyanazt a listát. A fésülés szabálya a
legegyszerűbb — a frissebb oldal nyer (`rev`, majd idő, majd eszköz) —, mert
a súrlódást nem a szinkron tartja, hanem a helyi kapu: a `rev` csak a
próbatétel-kapun átment változás után nő, tehát lazítani egy régi állapot
visszajátszásával nem lehet, és egy vadonatúj, üres gép sem törölhet semmit
(az üresség nem szerkesztés — lásd `revisions.ts`). Régi fiókkiszolgáló
mellett a szűrők kimaradnak a szinkronból, és ezt a fiókkártya kiírja — néma
kimaradás nincs.

## Mit tekintünk csatornának

Amit a CÍM elárul:

- `@névvel` kezdődő első útvonal-szakasz (YouTube, TikTok): `@név`;
- a YouTube régi formái: `channel/AZONOSÍTÓ`, `c/NÉV`, `user/NÉV`.

Amit a cím nem árul el, arról a CÍM ALAPJÁN nem hazudunk: egy `/watch?v=…`
videóról a cím nem mondja meg, melyik csatornáé. Ezt a lyukat a második réteg
szűkíti (lásd lent) — de ahol az sem lát, ott a videó elérhető marad, és ezt
kimondjuk. A tiltó lap mindig kiírja, MILYEN kulcsot látott, tehát az
engedélyezéshez nem kell találgatni.

A `@forma` és a `channel/…` forma ugyanahhoz a csatornához tartozhat, de ezt
címből nem lehet tudni — ha egy engedélyezett csatornát valaki a másik formán
ér el, a tiltó lapról leolvasható kulcsot érdemes szó szerint felvenni.

## Együtt a napi kerettel

A szűrő azt dönti el, MI nyílhat meg; a napi keret azt, MEDDIG. A kettő
szándékosan nem egy funkció: az időkeret az oldal blokklista-rekordján él
(`dailyLimitSeconds`), DNS-szinten érvényesül — minden böngészőben és
appban, nem csak ott, ahol a bővítmény fut. Aki a szűrős oldalára fent
kerettel veszi fel az oldalt, annál a kettő együtt fog: csak az
engedélyezett csatornák, és összesen is legfeljebb annyi idő. Egy külön,
bővítmény-szintű „csatorna-keret” ugyanennek egy gyengébb másodpéldánya
lenne — és ami kétszer van, az szétcsúszik.

## A második réteg: hírfolyam és lejátszó

A cím alapú tiltás egyedül azt jelentené, hogy a tiltott csatorna OLDALA nem
nyílik meg, a videói viszont a kezdőlapról és keresésből igen. A tartalom-
szkript ezért két további dolgot csinál, mindkettőt a bekapcsolt szűrők
alapján:

**Hírfolyam-tisztítás.** Az a videókártya, amin nem engedélyezett csatornára
mutató link van, eltűnik — de csak ha a doboz VIDEÓRA is mutat
(`contentIdOf`). A csatorna-link önmagában (egy komment szerzője, egy
említés) nem videókártya, és elrejteni olyat venne el, amit a felhasználó nem
szűrt. Ha a legszűkebb videós ős kettőnél több különböző videót tartalmaz, az
egy egész polc vagy szakasz — arról egyetlen link nem dönthet. A lejátszót
tartalmazó dobozt sosem rejtjük.

**A lejátszó-oldal feltöltője.** A `/watch` cím hallgat, de a LAP megmondja,
kié a videó — a saját metaadatában. Három forrás, a szemantikustól a nyersebb
felé: JSON-LD (`VideoObject.author.url`), schema.org-mikroadat
(`itemprop="author"` → `url`, VideoObject-hatókörben vagy a laphoz tartozását
a `videoId` metával bizonyítva), végül a lejátszó beágyazott adata
(`ownerProfileUrl`, csak ha ugyanaz a szkript a mostani `videoId`-t is
megnevezi). A kiolvasott feltöltő-címről az `authorVerdict` dönt — a
HÁTTÉRBEN, a friss szűrő-listával: a lap tartalmában futó kód csak jelölt,
nem bíró.

Két szabály tartja ezt egyenesben:

- **Elavulás-őr.** Egylapos váltásnál az előző videó metaadata még a DOM-ban
  lóghat. Ezért a metaadat csak akkor számít, ha a MOSTANI videót nevezi meg
  (`contentIdOf` a címből ↔ azonosító a metaadatban). A tévedés két iránya
  nem egyforma: a ki nem mondott ítélet a következő navigációnál újra esélyt
  kap, a téves tiltás viszont a szűrőt járatja le.
- **A megengedő forrás nyer.** Ha több forrás mást mond, és bármelyik
  engedélyezett csatornát nevez meg, a lap marad. Csak akkor tiltunk, ha van
  azonosított feltöltő, és egyik jelölt sem engedélyezett.

Ami ezek UTÁN is kint marad, az kimondott korlát: lejátszó, amelynek lapja
nem nevezi meg a feltöltőt; videókártya, amin nincs csatorna-link (például a
lejátszó melletti ajánló, ahol a csatornanév csak szöveg); és minden, ami nem
ebben a böngészőben történik. A tiltó lap ilyenkor is megmondja, mit látott —
`by=video` esetén azt is, hogy a kulcs a lap adatából jött, nem a címből.

Mindezt a `desktop/scripts/extension-e2e.js` őrzi: VALÓDI Chromiumban, a
valódi bővítményt betöltve játssza végig a rétegeket egy kamu videó-oldalon —
a rejtést, a három metaadat-forrást, az elavulás-őrt, az egylapos váltást és
a régi címalapú réteget is.

## Csatorna-idő: melyik csatorna vitte az időt

Ha a lap csatornája már azonosított (a szűrő miatt úgyis az), a bővítmény
mérni is tudja, mennyi időt visz — másodpercenként, de csak amíg a lap
látható ÉS az ablak fókuszban van: a háttérben szóló lap nem használat.
Csak bekapcsolt szűrős oldalon mér; máshol nem gyűjt semmit. Az adat a
böngésző tárában marad (`chantime.js`, 30 nap, napi sor-korlát), nem megy
se az appba, se a fiókba — a listák (ma + elmúlt 7 nap) a bővítmény
beállítási lapján állnak. Az írás a háttérben történik, egyetlen sorban,
és ellenőrzött: csak szűrős oldalról, ésszerű adagokban fogad mérést.

Kimondott határ: a beállítási lap nem tud az app rejtett listájáról — aki
a gépén elrejti az oldalneveket, annak a bővítmény lapján a csatorna-nevek
attól még látszanak.

## Súrlódás — mint a munkameneteknél

A szabály ugyanaz, mint mindenhol az appban:

| Művelet | Ára |
|---|---|
| Új szűrő felvétele (bekapcsolva is) | ingyen — szigorítás |
| Bekapcsolás | ingyen |
| Engedélyezett csatorna LEVÉTELE | ingyen — kevesebb nyílik meg |
| KIKAPCSOLÁS | próbatétel |
| Új engedélyezett csatorna bekapcsolt szűrőn | próbatétel — több nyílik meg |
| Gazdagép cseréje bekapcsolt szűrőn | próbatétel — a régi oldal felszabadul |
| Törlés bekapcsolt szűrőn | próbatétel |
| Törlés / szerkesztés kikapcsolt szűrőn | ingyen — nem tilt semmit |

A próbatétel UGYANAZ a gépezet, mint a feloldásnál: szintlépcső, kényszerített
páros feladott kísérlet után, változatosság. A lazítás a próbatétel
TELJESÍTÉSEKOR lép életbe — addig a szűrő a régi alakjában él.

## A lánc

1. A segéd tárolja a szűrőket (`channelFilters`), a referee kapuzza a
   lazítást (`startChannelFilterSave` / `startChannelFilterDelete`).
2. A híd (`/rules`) a BEKAPCSOLT szűrőket adja a bővítménynek
   (`channels: [{host, allow}]`) — a kikapcsolt a böngészőre nem tartozik.
3. A bővítmény gyorsítótárazza (az app bezárása nem feloldás), és minden
   navigációnál — a SPA-lépéseknél is — megkérdezi a `channelVerdict`-et.
   KÉT független eseményen: a navigáció előtt és a megtörténtekor is. A
   szolgáltatás-worker élete nem a miénk, és egyetlen ébredés közben
   elejtett esemény néma átengedés lenne — két külön esemény együtt már nem
   tud elveszni. A háttér egy memóriabeli nyomgyűrűt is vezet (mit látott,
   mit döntött), hogy egy elmaradt tiltásnál meg lehessen mondani, melyik
   láncszem hallgatott.
4. A tartalom-szkript ugyanezekkel a szűrőkkel rejti a nem engedélyezett
   csatornák videókártyáit, és a lejátszó-oldal metaadatából kiolvasott
   feltöltőt jelzi a háttérnek — ott az `authorVerdict` dönt (második réteg,
   lásd fent).
5. A tiltó lap megnevezi a látott kulcsot és az oldalt — `by=video` esetén
   azt is, hogy a kulcs a lap adatából jött.

A logika két példányban él (`extension/channels.js` + a TS iker), és a
paritásukat teszt őrzi, amely a KISZÁLLÍTOTT bővítmény-bájtokat futtatja
ugyanazon a bemenet-készleten — ugyanaz a minta, mint a részleges szabályok
magjánál.

## A rejtett lista ide is elér

A szűrő gazdagépe tipikusan pont egy blokkolt oldal. Rejtett listánál a
kártya a hosztot ugyanazon a tölcséren fedi el, mint a statisztika, a
csatornákat pedig csak megszámolja — egy @név is megnevezné, amit két
kártyával feljebb elrejtettünk. A szerkesztő ilyenkor nem nyitható.
