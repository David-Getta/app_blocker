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
DNS-alapú szűrő címet nem lát). A rekordok a gép segédjében élnek, és nem
szinkronizálódnak — ez asztali böngészős funkció, és ezt nem is állítjuk
másnak.

## Mit tekintünk csatornának

Amit a CÍM elárul:

- `@névvel` kezdődő első útvonal-szakasz (YouTube, TikTok): `@név`;
- a YouTube régi formái: `channel/AZONOSÍTÓ`, `c/NÉV`, `user/NÉV`.

Amit a cím nem árul el, arról nem hazudunk: egy `/watch?v=…` videóról a cím
nem mondja meg, melyik csatornáé — a videók tehát a kezdőlapról vagy
keresésből elérhetők maradnak akkor is, ha a csatornájuk oldala tiltva van.
Ugyanez áll a `/shorts/…` címekre. Ez kimondott korlát; a tiltó lap mindig
kiírja, MILYEN kulcsot látott, tehát az engedélyezéshez nem kell találgatni.

A `@forma` és a `channel/…` forma ugyanahhoz a csatornához tartozhat, de ezt
címből nem lehet tudni — ha egy engedélyezett csatornát valaki a másik formán
ér el, a tiltó lapról leolvasható kulcsot érdemes szó szerint felvenni.

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
4. A tiltó lap megnevezi a látott kulcsot és az oldalt.

A logika két példányban él (`extension/channels.js` + a TS iker), és a
paritásukat teszt őrzi, amely a KISZÁLLÍTOTT bővítmény-bájtokat futtatja
ugyanazon a bemenet-készleten — ugyanaz a minta, mint a részleges szabályok
magjánál.

## A rejtett lista ide is elér

A szűrő gazdagépe tipikusan pont egy blokkolt oldal. Rejtett listánál a
kártya a hosztot ugyanazon a tölcséren fedi el, mint a statisztika, a
csatornákat pedig csak megszámolja — egy @név is megnevezné, amit két
kártyával feljebb elrejtettünk. A szerkesztő ilyenkor nem nyitható.
