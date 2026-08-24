# Funkcióterv: munkamenetek („most csak ez mehet”)

Státusz: **kész az asztali appon** — csomagok, gyorsbillentyűs réteg, és a
fehérlista érvényesítése a böngészőben. Az appok engedélyezése egyelőre
figyelmeztet, nem tilt; a dokumentum alja megmondja, miért.

## Mit old meg

A blokklista arról szól, mi NE menjen. Van azonban egy másik igény, ami
ellentétes irányból közelít:

> Leülök nyelvet tanulni, és a következő ötven percben csak a szótár és a
> jegyzetfüzet kell.

Mindent felsorolni, ami zavarhat, reménytelen — a világon minden zavarhat.
Felsorolni, ami kell: öt tétel. A munkamenet ezért **fehérlista**.

```
„Nyelvtanulás”   engedve: translate.google.com, quizlet.com, Word
                 minden más: tiltva, ötven percig
```

## Hogyan indul

Az egész funkció azon áll, hogy **egy mozdulattal induljon**. Aki leül tanulni,
az nem fog előbb ablakot keresni, appot előhozni és fület váltani — addigra már
a YouTube-on van.

Ezért van egy **gyorsbillentyűs réteg** (⌘⌥B macOS-en, Ctrl+Alt+B Windowson):
rááll arra, amit épp csinálsz, kilistázza a csomagokat, és számbillentyűvel
indítható. Az Esc bezárja.

A réteg **semmit nem old fel**. A leállítás gombja az appot nyitja meg, ahol a
próbatétel van — ha innen menne, a munkamenet egy billentyűkombináció lenne.

## Súrlódás: ugyanaz a szabály, mint mindenhol

| Művelet | Ár | Miért |
|---|---|---|
| Munkamenet indítása | ingyen | szigorítás |
| Hosszabbítás | ingyen | szigorítás |
| Csomag szerkesztése (ami NEM fut) | ingyen | nem befolyásol semmit |
| **Rövidítés** | próbatétel | lazítás |
| **Leállítás** | próbatétel | lazítás |
| **A futó csomag szerkesztése** | tiltott | lásd lent |

**A futó csomag befagy.** Enélkül a fehérlistához menet közben hozzá lehetne
adni bármit, és a munkamenet önmagát oldaná fel — csendben, próbatétel nélkül.

**Egyszerre egy munkamenet fut.** Enélkül a leállítás próbatételét meg lehetne
kerülni: indítok egy „minden engedve” csomagot, és kész.

## Mit tud érvényesíteni, és mit nem

Ez a funkció három rétegen fekszik, és a felület mindegyiknél kimondja, mit tud:

| Réteg | Mit tud | Korlát |
|---|---|---|
| **Böngésző-bővítmény** | a fehérlista teljes érvényesítése: ami nincs a listán, oda nem enged navigálni | csak abban a böngészőben él, ahova telepítve van; vendég módban nem fut |
| **DNS (hosts)** | a meglévő blokklista végig érvényes | „mindent tilts, kivéve ötöt” egy hosts-fájlban nem leírható |
| **Appok** | a mérés látja, mi van előtérben | egy appot bezárni nem tudunk — figyelmeztetünk, nem tiltunk |

A **böngésző az egyetlen hely, ahol a fehérlista tényleg érvényesíthető**, mert
csak ott látszik a teljes cím. A DNS a hosztnévnél tovább nem lát, és a
„blokkolj mindent, kivéve ötöt” nem írható le egy hosts-fájlban: a világ összes
tartománynevét kellene felsorolni.

Az appoknál a helyzet nyíltan gyengébb: a mérés (`tracker`) tudja, melyik app
van előtérben, de egy futó programot nem lövünk ki. Ez szándékos — egy app
kilövése adatot veszíthet, és a Breaker soha nem tesz olyat, amit a felhasználó
nem kért.

## Adatmodell

```ts
interface FocusPack {
  id: string;
  name: string;              // „Nyelvtanulás”
  allowSites: string[];      // aldomainek is átmennek
  allowApps: string[];       // részleges, kis-nagybetű-független egyezés
  defaultMinutes: number;
}

interface FocusRun { packId: string; startedAt: number; endsAt: number }
```

**Az aldomain átmegy**: a `google.com` engedése a `translate.google.com`-ot is
engedi. Enélkül minden oldalnál külön ki kellene találni, melyik aldomain kell,
és a felhasználó azt látná, hogy a beállítása nem működik. A `notgoogle.com`
viszont NEM megy át — a végén hasonlító tartománynév a leggyakoribb megkerülés.

**Az appnév lazán egyezik**, mindkét irányban: a beírt `word` engedi a
`Microsoft Word` ablakot is. Az ablakcímek és folyamatnevek gépenként és
nyelvenként eltérnek; egy pontos egyezésre épülő lista mindenkinél máshogy
viselkedne, és senki nem értené, miért.

## Mennyi idő alatt ér el a böngészőig

A bővítmény **húsz másodpercenként** kérdezi meg az appot. Nem egy percenként,
és nem is öt másodpercenként:

- aki elindít egy munkamenetet, és utána még egy percig megnyithatja a
  YouTube-ot, az nem fog megbízni benne;
- öt másodpercenként viszont fölösleges terhelés lenne, és a munkamenet
  percekben él, nem másodpercekben.

Ez azt is jelenti, hogy a munkamenet indítása után **legfeljebb húsz
másodpercig** még átmehet egy oldal. Ezt nem takarjuk el: a réteg a szándékot
támogatja, nem egy elektromos kerítés.

## A lejárat IDŐPONT, nem állapot

A bővítmény a munkamenet végét **helyben** nézi, nem az apptól kérdezi:

- ha az appot bezárják, a munkamenet a saját idejéig **akkor is tart** —
  bezárni az appot nem feloldás;
- de egy perccel sem tovább: egy elérhetetlen app nem tarthat bent örökre.

## Mi valósult meg, hol

| Rész | Hol |
|---|---|
| Mag (fehérlista, idő, súrlódás iránya) | `desktop/src/shared/focus.ts` |
| Tárolás | `desktop/src/helper/state.ts` |
| Bíró (indítás, hosszabbítás, leállítás) | `desktop/src/helper/referee.ts` |
| Felület (csomagok, futó munkamenet) | `desktop/src/renderer/renderer.ts` |
| Gyorsbillentyűs réteg | `desktop/src/main/overlay.ts`, `renderer/overlay.*` |
| A fehérlista kiadása a bővítménynek | `desktop/src/main/rules-bridge.ts` |
| A fehérlista érvényesítése | `extension/background.js`, `extension/app-link.js` |

## Ami még hátra van

- [ ] Az appok tényleges tiltása (ma figyelmeztetés), platformonként külön
- [ ] Rendszerszintű fehérlista weboldalakra: ehhez helyi DNS-feloldó kell,
      nem hosts-fájl
- [ ] A csomagok szinkronizálása eszközök között
- [ ] A gyorsbillentyű átállítható legyen a felületről
