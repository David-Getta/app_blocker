'use strict';
// Fájl-alapú tár a szinkron-kiszolgálóhoz.
//
// Miért nem adatbázis: ez a szolgáltatás SZÁNDÉKOSAN buta. Nem érti, mit tárol
// (minden tartalom titkosítva érkezik), és egyetlen ember néhány eszközét
// szolgálja ki. Egy fájl-alapú tárral a telepítés egy másolás és egy indítás:
// nincs npm install, nincs natív fordítás, nincs migráció. Aki nem akar
// semmilyen külső szolgáltatást, az öt perc alatt futtatja a saját gépén; ez
// volt a cél.
//
// Amit viszont NEM adunk fel: az írás atomi. Ideiglenes fájlba írunk, majd
// átnevezzük. Egy áramszünet közben így vagy a régi, vagy az új tartalom van
// ott — sosem egy féllel.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** Fiókazonosítóból fájlnév. Sosem a felhasználó szövegéből, mert az bármi lehet. */
function keyOf(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex').slice(0, 32);
}

class Store {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(path.join(dir, 'accounts'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true, mode: 0o700 });
  }

  // ------------------------------------------------------------ fiókok

  accountPath(accountId) {
    return path.join(this.dir, 'accounts', `${keyOf(accountId)}.json`);
  }

  readAccount(accountId) {
    try {
      return JSON.parse(fs.readFileSync(this.accountPath(accountId), 'utf8'));
    } catch {
      return null;
    }
  }

  writeAccount(accountId, rec) {
    writeAtomic(this.accountPath(accountId), JSON.stringify(rec));
  }

  // ------------------------------------------------- gyűjtemények (blobok)

  blobPath(accountId, collection, deviceId) {
    const name = deviceId ? `${collection}-${keyOf(deviceId)}` : collection;
    return path.join(this.dir, 'data', keyOf(accountId), `${name}.json`);
  }

  readBlob(accountId, collection, deviceId) {
    try {
      return JSON.parse(fs.readFileSync(this.blobPath(accountId, collection, deviceId), 'utf8'));
    } catch {
      return { version: 0 };
    }
  }

  /**
   * Feltöltés optimista zárral.
   *
   * A hívó megmondja, MELYIK verzióra épül. Ha közben más írt, elutasítjuk, és
   * visszaadjuk az aktuálisat — a kliens összefésül és újrapróbál. Enélkül két
   * eszköz párhuzamos írása csendben eltüntetné az egyikét, és pont az a
   * legrosszabb, ami egy blokklistával történhet.
   */
  writeBlob(accountId, collection, deviceId, baseVersion, payload) {
    const p = this.blobPath(accountId, collection, deviceId);
    const current = this.readBlob(accountId, collection, deviceId);
    if (current.version !== baseVersion) {
      return { ok: false, conflict: true, version: current.version, payload: current.payload };
    }
    const next = { version: current.version + 1, payload, updatedAt: Date.now() };
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    writeAtomic(p, JSON.stringify(next));
    return { ok: true, version: next.version };
  }

  /** Minden eszköz mérése egy körben — ebből lesz a „többi eszköz statisztikája”. */
  listUsage(accountId, devices) {
    return devices.map((d) => {
      const b = this.readBlob(accountId, 'usage', d.deviceId);
      return { deviceId: d.deviceId, nameBlob: d.nameBlob, version: b.version, payload: b.payload };
    });
  }
}

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, text);
    // fsync, mert az átnevezés önmagában nem garantálja, hogy a TARTALOM is
    // kint van a lemezen: áramszünetnél üres, de „új” fájl maradhatna.
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

module.exports = { Store, keyOf };
