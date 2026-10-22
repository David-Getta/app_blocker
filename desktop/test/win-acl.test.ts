// A Windows-segéd állapotmappájának lezárása (helper/win-acl.ts) és a
// state.json írása (helper/state.ts): a sima felhasználó se olvasni ne tudja
// (szinkron-kulcsok), se egy előre odatett fájlon át átvenni.

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { hardenCommands } from '../src/helper/win-acl';

const DESKTOP = join(__dirname, '..', '..');
const read = (...p: string[]) => readFileSync(join(DESKTOP, ...p), 'utf8');

test('a mappa tulajdonosa a SYSTEM, a hozzáférés csak a SYSTEM-é és a rendszergazdáké, öröklés nélkül', () => {
  const dir = 'C:\\ProgramData\\Breaker';
  const cmds = hardenCommands(dir);
  // 1. Tulajdonos — a mappáé és minden fájlé: egy idegen tulajdonos a saját
  //    fájlján visszaadhatná magának a jogot.
  assert.deepEqual(cmds[0], [dir, '/setowner', '*S-1-5-18', '/T', '/C', '/Q']);
  // 2. A mappa: az öröklés le (a ProgramData a Users-nek fájl-létrehozást ad),
  //    csak a SYSTEM és az Administrators.
  assert.equal(cmds[1][0], dir);
  assert.ok(cmds[1].includes('/inheritance:r'));
  assert.ok(cmds[1].includes('*S-1-5-18:(OI)(CI)F'));
  assert.ok(cmds[1].includes('*S-1-5-32-544:(OI)(CI)F'));
  // Senki más: se Users (S-1-5-32-545), se Authenticated Users (S-1-5-11),
  // se Everyone (S-1-1-0), se név szerint (a nevek nyelvfüggők).
  const grants = cmds[1].filter((a) => a.startsWith('*S-') || a.includes(':('));
  assert.deepEqual(grants, ['*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F']);
  // 3. A gyerekek csak a mappától örököljenek.
  assert.deepEqual(cmds[2], [join(dir, '*'), '/reset', '/T', '/C', '/Q']);
});

test('a segéd az állapot betöltése előtt zárja le a mappát, és fejlesztői felülírásnál nem nyúl hozzá', () => {
  const index = read('src', 'helper', 'index.ts');
  const harden = index.indexOf('if (!process.env.BREAKER_STATE) hardenStateDir(path.dirname(stateFilePath()), log);');
  assert.ok(harden > 0, 'nincs lezárás az induláskor');
  assert.ok(harden < index.indexOf('const state = loadState();'), 'a lezárás a betöltés előtt kell');
  const acl = read('src', 'helper', 'win-acl.ts');
  assert.ok(acl.includes("path.join(process.env.SystemRoot || 'C:\\\\Windows', 'System32', 'icacls.exe')"),
    'az icacls abszolút úttal (SYSTEM-ként a PATH bárkié lehet)');
});

test('az állapot ideiglenes fájlja nem kiszámítható, és sosem egy már meglévő fájlba ír', () => {
  const state = read('src', 'helper', 'state.ts');
  assert.ok(state.includes("const tmp = path.join(dir, `.state.${crypto.randomBytes(8).toString('hex')}.tmp`);"));
  assert.ok(state.includes("fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600, flag: 'wx' });"));
  assert.ok(!state.includes('.state.${process.pid}.tmp'), 'a PID-es név kiszámítható');
});
