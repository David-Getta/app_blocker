// A Windows-csatorna próbájának szerver-fele: a VALÓDI `startServer` (a
// dist/helper/server.js-ből), üres állapottal, SYSTEM-ként indítva — pont úgy
// nyitja a named pipe-ot, ahogy a telepített segéd, a kulcs-lenyomattal (a
// harmadik argumentum). A próba (win-pipe-probe.ps1) ehhez csatlakozik egy
// sima felhasználóként, kulccsal és kulcs nélkül.
//
// Semmit nem ír a gépre: a commit üres, a hosts-fájlhoz nem nyúl. Két perc
// után magától kilép, ha a próba nem állítaná le.

const fs = require('fs');
const path = require('path');

const logFile = process.argv[2] || path.join(__dirname, 'pipe-probe-server.log');
// A telepítő ugyanígy süti a feladat parancssorába (shared/client-key.ts).
const clientKeySha256 = /^[0-9a-f]{64}$/.test(process.argv[3] || '') ? process.argv[3] : undefined;
const log = (m) => { try { fs.appendFileSync(logFile, `${new Date().toISOString()} ${m}\n`); } catch { /* a próba így is lát */ } };

process.on('uncaughtException', (e) => { log(`hiba: ${e && e.stack ? e.stack : e}`); process.exit(1); });

const { startServer } = require('../dist/helper/server.js');
const { defaultState } = require('../dist/helper/state.js');

const state = defaultState();
log(`indul, felhasználó: ${process.env.USERNAME || '?'}`);
startServer({
  getState: () => state,
  commit: () => {},
  dohApplied: () => false,
  log,
  selfTest: () => null,
  runSelfTest: async () => { throw new Error('a próbában nincs önteszt'); },
  clientKeySha256,
});
setTimeout(() => { log('két perc letelt, kilépek'); process.exit(0); }, 120_000);
