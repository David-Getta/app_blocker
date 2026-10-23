#!/usr/bin/env node
// A segéd csomagjait aláíró kiadási kulcs előállítása (#151) — EGYSZER, a
// saját gépeden, nem a CI-ban.
//
// Használat:
//   node desktop/scripts/gen-helper-key.js <titkos-kulcs.pem> [kulcs-azonosító]
//
// Kiírja a titkos kulcsot a megadott fájlba (csak a tulajdonos olvashatja; egy
// meglévő fájlt nem ír felül), a képernyőre pedig a nyilvános felét. Az utóbbi
// a desktop/src/shared/helper-keys.ts listájába kerül; a titkos fél a GitHub
// védett környezetének titka (HELPER_SIGNING_KEY) lesz, és egy offline mentés.
// Részletek: docs/releasing.md, „A segéd aláíró kulcsa”.

const crypto = require('crypto');
const fs = require('fs');

const [file, id = 'r1'] = process.argv.slice(2);
if (!file) {
  console.error('Használat: node desktop/scripts/gen-helper-key.js <titkos-kulcs.pem> [kulcs-azonosító]');
  process.exit(2);
}
if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(id)) {
  console.error(`A kulcs azonosítója kisbetű, számjegy és kötőjel lehet (legfeljebb 32): ${id}`);
  process.exit(2);
}
if (id === 'unsigned' || id === 'ci-test') {
  console.error(`Ez az azonosító foglalt (az aláíratlan és a próba-leíróé): ${id}`);
  process.exit(2);
}

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const pem = privateKey.export({ format: 'pem', type: 'pkcs8' });
const spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

// 'wx': ha a fájl már megvan, hiba — egy meglévő kulcsot véletlenül sem írunk felül.
fs.writeFileSync(file, pem, { mode: 0o600, flag: 'wx' });

console.log(`A titkos kulcs itt van: ${file} (csak a tulajdonos olvashatja).`);
console.log('');
console.log('A nyilvános fele — ezt küldd el, vagy írd a helper-keys.ts listájába:');
console.log(`  { id: '${id}', spki: '${spki}' },`);
console.log('');
console.log('Teendők:');
console.log('  1. GitHub: Settings → Environments → New environment: helper-signing.');
console.log('     „Deployment branches and tags”: csak a kiadás ága. Benne egy titok:');
console.log('     HELPER_SIGNING_KEY, az értéke a fenti .pem fájl teljes tartalma.');
console.log('     Ha „Required reviewers”-t is beállítasz, minden kiadás megvárja a jóváhagyásodat.');
console.log('  2. A nyilvános felét (a fenti sort) add hozzá a helper-keys.ts listájához —');
console.log('     onnantól minden kiadás aláírt csomagot kér.');
console.log('  3. A .pem fájlról készíts offline mentést (például titkosított pendrive),');
console.log('     aztán töröld erről a gépről. Ha elveszik, minden Macen jelszó kell a');
console.log('     következő frissítéshez; ha kiszivárog, minden telepített Macen rendszerjogot ad.');
