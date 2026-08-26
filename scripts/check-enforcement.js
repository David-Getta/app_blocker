#!/usr/bin/env node
// Tényleg MEGKÉRDEZI-e valaki a döntést hozó függvényt.
//
// MIÉRT LÉTEZIK. Ennek a projektnek a visszatérő hibafajtája nem a rossz
// logika, hanem a HUZALOZATLAN logika: a mag megvan, teszt is van rá, csak
// éppen senki nem hívja. Semmi nem hasal el tőle — se fordítás, se teszt —, az
// app hibátlannak látszik, a tiltás meg nem történik meg. A felhasználó pedig
// azt hiszi, védve van.
//
// Az „Új csomag” gomb így volt kezelő nélkül egy kiadáson át. Egy nem hívott
// `Focus.verdict` ennél sokkal rosszabb: ott a munkamenet látszana futni, a
// telefon meg mindent beengedne.
//
// A fordítás ezt SOHA nem fogja ki: egy nem hívott függvény tökéletesen
// érvényes kód.
//
// Futtatás: node scripts/check-enforcement.js

const fs = require('fs');
const path = require('path');

const ROOT = __dirname.replace(/\/scripts$/, '');

/**
 * Egy huzalozás: melyik fájlban KELL szerepelnie melyik hívásnak, és mi
 * veszne el, ha nem szerepelne.
 *
 * A `needle` szándékosan a HÍVÁS neve, nem egy import: importálni lehet
 * használat nélkül is.
 */
const WIRES = [
  {
    file: 'android/app/src/main/java/hu/breaker/app/vpn/BreakerVpnService.kt',
    needle: 'Focus.verdict',
    lost: 'az androidos DNS-szűrő nem venné figyelembe a munkamenetet — a '
      + 'fehérlista látszólag futna, a telefon meg mindent beengedne',
  },
  {
    file: 'ios/PacketTunnel/PacketTunnelProvider.swift',
    needle: 'Focus.verdict',
    lost: 'az iPhone alagútja nem venné figyelembe a munkamenetet',
  },
  {
    file: 'extension/background.js',
    needle: 'focusActive',
    lost: 'a böngésző-bővítmény nem érvényesítené a fehérlistát a gépen',
  },
  {
    file: 'desktop/src/helper/server.ts',
    needle: 'summarizeFocus',
    lost: 'a munkamenet-statisztika üresen állna, mert senki nem számolná ki',
  },
  {
    file: 'desktop/src/helper/sync-client.ts',
    needle: 'syncFocusRound',
    lost: 'a munkamenet sosem érne át a többi eszközre',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/core/SyncClient.kt',
    needle: 'syncFocusRound',
    lost: 'az androidos szinkron nem hozná le a munkamenetet',
  },
  {
    file: 'ios/Shared/SyncClient.swift',
    needle: 'syncFocusRound',
    lost: 'az iPhone szinkronja nem hozná le a munkamenetet',
  },

  // A MENET LEZÁRÁSA. Ha ezt nem hívja senki, a menet a saját idejében
  // „lejár” ugyan (az `isRunning` hamisat ad rá), de a naplóba SOHA nem kerül
  // be — és a statisztikából pont azok a menetek hiányoznának, amiket a
  // felhasználó végigvitt. Az a statisztika rosszabb a semminél: azt mondaná,
  // hogy sosem sikerül.
  {
    file: 'desktop/src/helper/referee.ts',
    needle: 'closeIfEnded',
    lost: 'a gépen a magától lejárt menet nem kerülne a statisztikába',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/core/Referee.kt',
    needle: 'Focus.closeIfEnded',
    lost: 'a telefonon a magától lejárt menet nem kerülne a statisztikába',
  },
  {
    file: 'ios/Shared/Referee.swift',
    needle: 'Focus.closeIfEnded',
    lost: 'az iPhone-on a magától lejárt menet nem kerülne a statisztikába',
  },

  // A NAPLÓ EGYESÍTÉSE. Enélkül a szinkron az „utolsó író nyer” szabályt
  // követné a naplóra is: a másik eszköz sorai csendben eltűnnének, és a
  // felhasználó azt látná, hogy fél hete nem dolgozott.
  {
    file: 'desktop/src/helper/sync-client.ts',
    needle: 'mergeLog',
    lost: 'a gépen a többi eszköz menetei kiesnének a statisztikából',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/core/SyncClient.kt',
    needle: 'FocusSync.mergeLog',
    lost: 'a telefonon a többi eszköz menetei kiesnének a statisztikából',
  },
  {
    file: 'ios/Shared/SyncClient.swift',
    needle: 'FocusSync.mergeLog',
    lost: 'az iPhone-on a többi eszköz menetei kiesnének a statisztikából',
  },

  // A STATISZTIKA KISZÁMOLÁSA a két telefonon. A gépen ezt a segéd végzi
  // (`summarizeFocus` fentebb); itt a felület kéri el.
  {
    file: 'android/app/src/main/java/hu/breaker/app/ui/AppUi.kt',
    needle: 'Focus.summarizeFocus',
    lost: 'a telefonon a munkamenet-statisztika üresen állna',
  },
  {
    file: 'ios/App/StatsView.swift',
    needle: 'Focus.summarizeFocus',
    lost: 'az iPhone-on a munkamenet-statisztika üresen állna',
  },

  // A FIGYELMEZTETÉS arról, hogy a fehérlistát a gépen nem érvényesíti senki.
  // A logika megvan, de ha nem hívja senki, a felhasználó ugyanúgy nem tudja
  // meg — és pont ez a funkció lényege.
  {
    file: 'desktop/src/renderer/renderer.ts',
    needle: 'renderFocusExtensionWarning',
    lost: 'az appban nem derülne ki, hogy a bővítmény nincs összekötve',
  },
  {
    file: 'desktop/src/renderer/overlay.ts',
    needle: 'extWarning',
    lost: 'a gyorsbillentyűs rétegben nem derülne ki, hogy nincs bővítmény',
  },

  // AMIÉRT AZ EGÉSZ APP VAN. A blokklista a hosts fájlba írásával lép életbe;
  // ha ezt nem hívja senki, az app tökéletesnek LÁTSZIK — a lista ott van, a
  // felület zöld, az állapot „védve” —, és közben SEMMI nincs tiltva.
  //
  // Ez a legrosszabb elképzelhető néma hiba ebben a projektben, és éppen ezért
  // állt eddig őrizetlenül: annyira alapvető, hogy eszünkbe sem jutott.
  {
    file: 'desktop/src/helper/index.ts',
    needle: 'applyBlocklist',
    lost: 'a gépen SEMMI nem lenne tiltva — a hosts fájlba nem kerülne be a lista',
  },
  {
    file: 'desktop/src/helper/index.ts',
    needle: 'watchHosts',
    lost: 'a hosts fájlból kézzel kitörölt blokk nem kerülne vissza',
  },
  {
    file: 'desktop/src/helper/index.ts',
    needle: 'applyDohPolicies',
    lost: 'a böngésző saját DNS-e megkerülné a tiltást',
  },

  // A SÚRLÓDÁS ESZKALÁCIÓJA. Enélkül minden próbatétel a legkönnyebb fokon
  // maradna, és a „nem lesz könnyebb attól, hogy sokszor csinálod” ígéret
  // csendben megszűnne — a táblázat ott lenne, csak épp senki nem kérdezné meg.
  {
    file: 'desktop/src/helper/referee.ts',
    needle: 'computeTier',
    lost: 'a gépen minden feloldás a legkönnyebb próbatételt kapná',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/core/Referee.kt',
    needle: 'ChallengeEngine.computeTier',
    lost: 'a telefonon minden feloldás a legkönnyebb próbatételt kapná',
  },
  {
    file: 'ios/Shared/Referee.swift',
    needle: 'ChallengeEngine.computeTier',
    lost: 'az iPhone-on minden feloldás a legkönnyebb próbatételt kapná',
  },

  // A RÉSZLEGES TILTÁS a böngészőben. A bővítmény két forrásból dolgozik: a
  // saját szabályaiból és az appból lehúzottakból. Ha a kettő összefésülése
  // (`withAppRules`) kimaradna, az appban felvett szabályok SOHA nem hatnának
  // — a felületen ott állnának, a böngésző meg átengedné őket.
  {
    file: 'extension/background.js',
    needle: 'withAppRules',
    lost: 'az appban felvett részleges szabályok nem hatnának a böngészőben',
  },
  {
    file: 'extension/background.js',
    needle: 'firstMatch',
    lost: 'a bővítmény semmilyen szabályt nem alkalmazna',
  },
  {
    file: 'extension/background.js',
    needle: 'dueForRefresh',
    lost: 'a bővítmény befagyna az első listánál, és nem venné át a változásokat',
  },

  // AMI ELDÖNTI, MELYIK NÉV KERÜL A TILTÁSBA. Itt találkozik a lista az
  // idővel: a szünet, a menetrend és a NAPI KERET mind ezen a döntésen
  // keresztül hat. Ha nem kérdeznénk meg, a keret csendben nem csinálna
  // semmit — a felületen ott ketyegne a mérő, elfogyna, és nem történne
  // semmi. Ugyanígy a menetrend: a beállított sáv díszlet lenne.
  {
    file: 'desktop/src/helper/hosts.ts',
    needle: 'isBlockedNowWithLimit',
    lost: 'a gépen a szünet, a menetrend és a napi keret egyike sem hatna',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/core/Store.kt',
    needle: 'LimitLogic.isBlockedNowWithLimit',
    lost: 'a telefon szűrője nem venné figyelembe a keretet és a menetrendet',
  },
  {
    file: 'ios/Shared/Store.swift',
    needle: 'LimitLogic.isBlockedNowWithLimit',
    lost: 'az iPhone alagútja nem venné figyelembe a keretet és a menetrendet',
  },
];

/**
 * Megjegyzések nélküli kód.
 *
 * Mind a négy nyelv (Kotlin, Swift, JS, TS) ugyanazt a két alakot használja.
 * A sztringeket szándékosan nem bántjuk: egy sztringbe írt hívásnév olyan
 * ritka, hogy nem éri meg érte egy fél elemzőt írni — a megjegyzés viszont
 * gyakori, mert minden magyarázat mellette áll.
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s\/\/.*$/gm, '');
}

const problems = [];
for (const wire of WIRES) {
  const full = path.join(ROOT, wire.file);
  if (!fs.existsSync(full)) {
    problems.push({ ...wire, why: 'a fájl nincs meg' });
    continue;
  }
  // A MEGJEGYZÉSEKET KI KELL SZEDNI. Az első változat nem tette, és pont
  // ezért nem fogta ki a szándékosan elrontott hívást: a fájl tetején lévő
  // magyarázó megjegyzés is tartalmazta a nevet, tehát az ellenőrző a saját
  // dokumentációt találta meg, nem a kódot. Egy ellenőrző, ami a
  // megjegyzésekre reagál, pont akkor hallgat, amikor szólnia kellene.
  const text = stripComments(fs.readFileSync(full, 'utf8'));
  const uses = text.split(wire.needle).length - 1;
  if (uses === 0) problems.push({ ...wire, why: 'nincs benne hívás' });
}

if (problems.length === 0) {
  console.log(`huzalozás OK (${WIRES.length} döntési pont a helyén)`);
  process.exit(0);
}

console.error('Huzalozatlan döntés — a logika megvan, de senki nem hívja:\n');
for (const p of problems) {
  console.error(`  ${p.file}: ${p.needle} (${p.why})`);
  console.error(`    elveszne: ${p.lost}\n`);
}
console.error('Ez a projekt visszatérő hibafajtája: semmi nem hasal el tőle,');
console.error('az app hibátlannak látszik, a tiltás meg nem történik meg.');
process.exit(1);
