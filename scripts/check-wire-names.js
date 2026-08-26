#!/usr/bin/env node
// A dróton menő MEZŐNEVEK mind a három nyelven ugyanazok.
//
// MIÉRT LÉTEZIK. A szinkron JSON-t cserél, és a mezőnevek szövegek. Egy
// átnevezés az egyik nyelvben nem fordítási hiba a másikban — ott egyszerűen
// HIÁNYZÓ mező lesz belőle, amire a feldolgozó alapértéket tesz.
//
// A legrosszabb konkrét eset, amit ez zár: `planned` a `plannedEndsAt` helyett.
// A másik eszköz eldobná a mezőt, alapértéknek a tényleges véget venné, és
// onnantól MINDEN átjött menet úgy jelenne meg, mintha végigvitted volna. A
// statisztika pont arról hazudna, ami a felhasználót a legjobban érdekli — és
// semmi nem hasalna el tőle.
//
// A TypeScriptet a fordító védi (a mezőnevek típusok), a Kotlint teszt fedi
// (`SyncWireFormatTest`), az iPhone-on viszont NINCS teszt: ott a `Codable` a
// tulajdonságnevekből képzi a kulcsokat, tehát egy átnevezés némán megváltoztatja
// a drót-alakot. Ez az ellenőrző emiatt van.
//
// AMIT NEM FED — és ezt ki kell mondani, különben hamis biztonságot ad:
//
//   - a mező ÉRTÉKÉT nem nézi, se azt, hogy tényleg fel is kerül-e a drótra;
//   - és ami a legfontosabb: a FÉL-ÁTNEVEZÉST nem fogja ki. Ha egy név
//     ugyanabban a fájlban két helyen keletkezik, és csak az egyik változik
//     el, a másik „megvan”, tehát az ellenőrző hallgat. A Kotlin oldalon ez
//     valóságos: a mai összegzést két külön hely is kiírja.
//
// Amit tehát tényleg garantál: egy TELJES átnevezés — Swift tulajdonság, TS
// felület-mező, egyedi Kotlin kulcs — nem csúszhat át. Ez pont az a hibafajta,
// amit iPhone-on semmi más nem fogna ki, mert ott nincs teszt, és a `Codable` a
// tulajdonságnevekből képzi a kulcsokat.
//
// Futtatás: node scripts/check-wire-names.js

const fs = require('fs');
const path = require('path');

const ROOT = __dirname.replace(/\/scripts$/, '');

/** Megjegyzések nélküli kód — különben egy magyarázat is „találat” lenne. */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*\/\/\/.*$/gm, '')
    .replace(/\s\/\/.*$/gm, '');
}

/**
 * Amit a munkamenet blobja visz. A neveket KÉZZEL soroljuk fel, mert épp az a
 * kérdés, hogy a három forrás egyezik-e — ha az egyikből olvasnánk ki őket, az
 * a forrás definíció szerint mindig „helyes” lenne.
 */
/**
 * Amit a munkamenet blobja visz, CSOPORTONKÉNT — és csoportonként az is, hogy
 * melyik fájlban keressük.
 *
 * A szűkítés nem díszítés. Az első változatom minden nevet minden fájlban
 * keresett, és két szándékos elrontást átengedett:
 *
 *   - TypeScriptben egy OBJEKTUM-LITERÁL (`plannedEndsAt: run.endsAt,`) is
 *     illeszkedett a felület-mező mintájára, tehát a deklaráció átnevezése
 *     után is „megvolt” a név;
 *   - Swiftben a `Focus.Close` típusnak is van `log` mezője, és az takarta a
 *     `SyncFocus.log` átnevezését.
 *
 * A neveket KÉZZEL soroljuk fel, mert épp az a kérdés, hogy a három forrás
 * egyezik-e — ha az egyikből olvasnánk ki őket, az mindig „helyes” lenne.
 */
const GROUPS = [
  {
    what: 'a munkamenet blobja',
    names: ['packs', 'run', 'log', 'rev', 'updatedAt', 'updatedBy'],
    ts: 'desktop/src/shared/sync/focus-merge.ts',
    kt: 'android/app/src/main/java/hu/breaker/app/core/SyncClient.kt',
    swift: 'ios/Shared/FocusSync.swift',
  },
  {
    what: 'egy csomag',
    names: ['allowSites', 'allowApps', 'defaultMinutes'],
    ts: 'desktop/src/shared/focus.ts',
    kt: 'android/app/src/main/java/hu/breaker/app/core/SyncClient.kt',
    swift: 'ios/Shared/Focus.swift',
  },
  {
    what: 'a futó menet',
    names: ['packId', 'startedAt', 'endsAt'],
    ts: 'desktop/src/shared/focus.ts',
    kt: 'android/app/src/main/java/hu/breaker/app/core/SyncClient.kt',
    swift: 'ios/Shared/Focus.swift',
  },
  // A BLOKKLISTA. Ez a legfontosabb adat az appban: ha egy mezőneve
  // szétcsúszik, a másik eszköz némán eldobja. Egy elveszett `pendingDeleteAt`
  // például azt jelentené, hogy a telefonon a függő törlés sosem következik be
  // — az app „törlés folyamatban”-t mutatna, és soha nem törölne.
  {
    what: 'egy blokkolt oldal',
    names: ['domain', 'hostnames', 'addedAt', 'pendingDeleteAt', 'dailyLimitSeconds', 'alias', 'rules'],
    ts: 'desktop/src/shared/sync/merge.ts',
    kt: 'android/app/src/main/java/hu/breaker/app/core/SyncClient.kt',
    swift: 'ios/Shared/SyncMerge.swift',
  },
  // A MAI MÉRÉS ÖSSZEGZÉSE. Ezen áll a KÖZÖS napi keret: minden eszköz
  // feltölti, mennyit mért ma, a többi meg hozzáadja a sajátjához. Ha a `day`
  // neve elcsúszik, a fogadó oldal nem tudja eldönteni, hogy a sor MAI-e — és
  // a szűrés (`d.day !== today`) mindent kidob. A keret ettől csendben
  // visszaesne eszközönkéntire: a „napi 20 perc” két eszközzel megint negyven
  // lenne, pontosan az a hiba, ami ellen a funkció készült.
  {
    what: 'a mai mérés összegzése',
    names: ['deviceId', 'day', 'seconds'],
    ts: 'desktop/src/shared/limits.ts',
    kt: 'android/app/src/main/java/hu/breaker/app/core/SyncClient.kt',
    swift: 'ios/Shared/Limits.swift',
  },
  {
    what: 'egy naplósor',
    names: ['packName', 'endedAt', 'plannedEndsAt', 'stopped'],
    ts: 'desktop/src/shared/focus.ts',
    kt: 'android/app/src/main/java/hu/breaker/app/core/SyncClient.kt',
    swift: 'ios/Shared/Focus.swift',
  },
];

/**
 * Nyelvenként a DEKLARÁCIÓ alakja — nem az, hogy a név „szerepel valahol”.
 *
 *   - TypeScript: felület-mező. A minta pontosvesszőre végződik, mert egy
 *     objektum-literál vesszőre — ez választja szét a kettőt;
 *   - Kotlin: a JSON kulcs maga (`put("plannedEndsAt", …)`) — ez megy a drótra;
 *   - Swift: tulajdonság-deklaráció, mert a `Codable` ebből képzi a kulcsot.
 */
const LANGS = [
  // A sor VÉGÉN álló pontosvessző választja el a felület-mezőt az objektum-
  // literáltól (az vesszőre végződik). A típusban lévő vessző NEM zavarhat:
  // az első próbám `[^,]*;`-t használt, és a `Record<string, number>` miatt a
  // `seconds` mezőt hiányzónak jelentette — a minta bukott meg, nem a kód.
  { name: 'TypeScript', key: 'ts', pattern: (f) => new RegExp(`^\\s*${f}\\??:[^;\\n]*;\\s*$`, 'm') },
  { name: 'Kotlin', key: 'kt', pattern: (f) => new RegExp(`put\\("${f}"`) },
  { name: 'Swift', key: 'swift', pattern: (f) => new RegExp(`\\b(let|var) ${f}:`) },
];

const cache = new Map();
function readStripped(rel) {
  if (!cache.has(rel)) {
    const full = path.join(ROOT, rel);
    cache.set(rel, fs.existsSync(full) ? stripComments(fs.readFileSync(full, 'utf8')) : null);
  }
  return cache.get(rel);
}

const problems = [];
let checked = 0;
for (const group of GROUPS) {
  for (const lang of LANGS) {
    const rel = group[lang.key];
    if (readStripped(rel) === null) problems.push(`${lang.name}: a fájl nincs meg (${rel})`);
  }
  for (const field of group.names) {
    checked++;
    const missing = LANGS
      .filter((l) => {
        const text = readStripped(group[l.key]);
        return text !== null && !l.pattern(field).test(text);
      })
      .map((l) => `${l.name} (${group[l.key].split('/').pop()})`);
    if (missing.length) {
      problems.push(
        `${group.what}: a(z) „${field}” mező DEKLARÁCIÓJA hiányzik innen: ${missing.join(', ')}. `
        + 'A másik eszköz ezt a mezőt némán eldobná, és alapértéket venne helyette.',
      );
    }
  }
}

if (problems.length === 0) {
  console.log(`drót-nevek OK (${checked} mező, mind a három nyelvben)`);
  process.exit(0);
}

console.error('A dróton menő mezőnevek szétcsúsztak:\n');
for (const p of problems) console.error(`  ${p}`);
console.error('\nEgy átnevezés az egyik nyelvben nem fordítási hiba a másikban:');
console.error('ott hiányzó mező lesz belőle, amire a feldolgozó alapértéket tesz.');
process.exit(1);
