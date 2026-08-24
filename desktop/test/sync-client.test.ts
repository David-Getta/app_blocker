// A teljes szinkron-kör, VALÓDI kiszolgálóval.
//
// A kiszolgálót gyerekfolyamatként indítjuk (`server/server.js`), és két
// „eszközt” játszunk el két külön segéd-állapottal. Így nemcsak a fésülés van
// letesztelve, hanem a titkosítás, a verziókezelés és az ütközés is — együtt,
// úgy, ahogy a felhasználónál működni fog.

import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  signIn, signInWithRecovery, signOut, signUp, syncNow, normalizeServerUrl,
  normalizeIncomingSites, SyncError,
} from '../src/helper/sync-client';
import { bumpRevisions } from '../src/helper/revisions';
import { defaultState, type HelperState, type SiteRec } from '../src/helper/state';

let child: ChildProcess;
let url: string;
let dir: string;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'breaker-sync-e2e-'));
  // A tesztek a fordított kimenetből futnak (dist-test/test), tehát a __dirname
  // mélysége nem állandó. A kiszolgálót felfelé keresve találjuk meg, így a
  // teszt akkor sem törik el, ha a kimeneti könyvtár szerkezete változik.
  const server = findServer(__dirname);
  child = spawn(process.execPath, [server], {
    env: { ...process.env, PORT: '0', BREAKER_SYNC_DIR: dir },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  // A kiszolgáló kiírja, hol hallgat; a 0-s porttal a rendszer oszt ki egyet.
  url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('a kiszolgáló nem indult el')), 10_000);
    child.stdout!.on('data', (b: Buffer) => {
      const m = /(http:\/\/[\d.]+:\d+)/.exec(b.toString());
      if (m) { clearTimeout(timer); resolve(m[1].replace('0.0.0.0', '127.0.0.1')); }
    });
  });
});

after(() => {
  child.kill();
  fs.rmSync(dir, { recursive: true, force: true });
});

function findServer(from: string): string {
  for (let dirPath = from, i = 0; i < 8; i++, dirPath = path.dirname(dirPath)) {
    const candidate = path.join(dirPath, 'server', 'server.js');
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('nem található a server/server.js');
}

function site(over: Partial<SiteRec> = {}): SiteRec {
  return {
    id: 'site_1', domain: 'youtube.com', hostnames: ['youtube.com'],
    addedAt: 1_000, pauseUntil: null, pendingDeleteAt: null,
    ...over,
  };
}

/** Egy „eszköz”: saját segéd-állapot, saját fiókbejegyzés. */
function device(sites: SiteRec[] = []): HelperState {
  const s = defaultState();
  s.sites = sites;
  return s;
}

const ACCOUNT = 'david@example';
const PASSWORD = 'ez-egy-elég-hosszú-jelszó';
let recoveryCode = '';

test('a fresh account takes the local list with it', async () => {
  const a = device([site()]);
  const r = await signUp(a, url, ACCOUNT, PASSWORD, 'Munkagép');
  recoveryCode = r.recoveryCode;
  assert.match(recoveryCode, /^[0-9A-Z]{4}(-[0-9A-Z]{4}){7}$/);

  const res = await syncNow(a, 2_000);
  assert.equal(res.sites, 1);
});

test('the second device gets the list by signing in', async () => {
  const b = device();
  await signIn(b, url, ACCOUNT, PASSWORD, 'Telefon');
  assert.equal(b.sites.length, 0, 'belépéskor még nincs semmi');

  const res = await syncNow(b, 3_000);
  assert.equal(res.changed, true);
  assert.deepEqual(b.sites.map((s) => s.domain), ['youtube.com'],
    'ezért van az egész: nem kell újra felvenni');
});

test('adding on one device shows up on the other, and nothing is lost', async () => {
  const a = device([site(), site({ id: 'site_2', domain: 'reddit.com', addedAt: 4_000 })]);
  await signIn(a, url, ACCOUNT, PASSWORD, 'Munkagép');
  await syncNow(a, 5_000);

  const b = device([site({ id: 'site_3', domain: 'instagram.com', addedAt: 4_500 })]);
  await signIn(b, url, ACCOUNT, PASSWORD, 'Telefon');
  await syncNow(b, 6_000);

  // A telefon SAJÁT oldala sem veszett el: a belépés egyesít, nem cserél.
  assert.deepEqual(
    b.sites.map((s) => s.domain).sort(),
    ['instagram.com', 'reddit.com', 'youtube.com'],
  );

  // És visszafelé is: a munkagép megkapja a telefonon felvett oldalt.
  await syncNow(a, 7_000);
  assert.ok(a.sites.some((s) => s.domain === 'instagram.com'));
});

test('a pause does not travel to the other device', async () => {
  // Egy próbatétel egy eszközön nem oldhat fel mindenhol.
  const a = device();
  await signIn(a, url, ACCOUNT, PASSWORD, 'Munkagép');
  await syncNow(a, 8_000);
  const target = a.sites.find((s) => s.domain === 'youtube.com')!;
  target.pauseUntil = 9_999_999_999_999;
  await syncNow(a, 9_000);

  const b = device();
  await signIn(b, url, ACCOUNT, PASSWORD, 'Telefon');
  await syncNow(b, 10_000);
  const there = b.sites.find((s) => s.domain === 'youtube.com')!;
  assert.equal(there.pauseUntil, null, 'a másik gépen nem lett feloldva');

  // A saját szünet viszont MEGMARAD egy újabb kör után is: a feloldás, amiért
  // itt megcsinálta a próbát, nem veszhet el attól, hogy közben szinkronizált.
  await syncNow(a, 10_500);
  assert.equal(a.sites.find((s) => s.domain === 'youtube.com')!.pauseUntil, 9_999_999_999_999);
});

test('a stale looser version cannot undo a tightening', async () => {
  const a = device();
  await signIn(a, url, ACCOUNT, PASSWORD, 'Munkagép');
  await syncNow(a, 11_000);

  // A gép egy RÉGI, lazább rekorddal jelentkezik: kisebb rev, nagyobb keret.
  const stale = a.sites.find((s) => s.domain === 'reddit.com')!;
  const before = { ...stale };
  stale.dailyLimitSeconds = 600;
  bumpRevisions(a, 'gep-a', 12_000);
  await syncNow(a, 12_000);

  const b = device();
  await signIn(b, url, ACCOUNT, PASSWORD, 'Telefon');
  await syncNow(b, 13_000);
  const mineB = b.sites.find((s) => s.domain === 'reddit.com')!;
  assert.equal(mineB.dailyLimitSeconds, 600, 'a szigorítás átment');

  // Most a telefon egy visszafelé mutató (régi rev-ű) rekordot próbál feltölteni.
  mineB.dailyLimitSeconds = undefined;
  mineB.rev = (before.rev ?? 1) - 1;
  mineB.revFp = 'hamis';
  await syncNow(b, 14_000);
  const after = b.sites.find((s) => s.domain === 'reddit.com')!;
  assert.equal(after.dailyLimitSeconds, 600, 'a régi, lazább rekord nem törölte a keretet');
});

test('signing out never removes a single block', async () => {
  // Ha törölne, a kijelentkezés lenne a világ legegyszerűbb feloldása.
  const a = device();
  await signIn(a, url, ACCOUNT, PASSWORD, 'Munkagép');
  await syncNow(a, 15_000);
  const before = a.sites.map((s) => s.domain).sort();
  assert.ok(before.length >= 3);

  signOut(a);
  assert.equal(a.sync, undefined, 'a fiók lekapcsolva');
  assert.deepEqual(a.sites.map((s) => s.domain).sort(), before, 'a lista érintetlen');
});

test('the recovery code gets back in and sets a new password', async () => {
  const c = device();
  await signInWithRecovery(c, url, ACCOUNT, recoveryCode, 'uj-jelszo-lett-most', 'Mentőöv');
  await syncNow(c, 16_000);
  assert.ok(c.sites.length >= 3, 'a kód a fiókba is beenged, nem csak a kulcsot nyitja');

  // A régi jelszó innentől nem jó, az új igen.
  const d = device();
  await assert.rejects(() => signIn(d, url, ACCOUNT, PASSWORD, 'Régi'), /Hibás fiók vagy jelszó/);
  await signIn(d, url, ACCOUNT, 'uj-jelszo-lett-most', 'Új');
  await syncNow(d, 17_000);
  assert.ok(d.sites.length >= 3);
});

test('a bad server address is refused before anything is sent', async () => {
  assert.equal(normalizeServerUrl('sync.pelda.hu'), 'https://sync.pelda.hu');
  assert.equal(normalizeServerUrl('http://127.0.0.1:8787/valami'), 'http://127.0.0.1:8787');
  assert.throws(() => normalizeServerUrl('file:///etc/passwd'), SyncError);
  assert.throws(() => normalizeServerUrl(''), SyncError);
});

test('syncing without an account fails loudly instead of doing nothing', async () => {
  await assert.rejects(() => syncNow(device(), 18_000), /Nincs bejelentkezve/);
});

test('a record with a missing pendingDeleteAt is not treated as deleting', () => {
  // A Swift JSONEncoder alapból kihagyja a nil mezőket. Ha ezt nem
  // egyenesítenénk ki, `undefined` érkezne, ami NEM null — és az összefésülés
  // minden oldalt törlésre várónak látna. A lista sosem konvergálna, közben
  // semmilyen hiba nem jelezne.
  const [s] = normalizeIncomingSites([{ id: 'a', domain: 'youtube.com', addedAt: 1, hostnames: ['youtube.com'] }]);
  assert.equal(s.pendingDeleteAt, null);
  assert.equal(s.pauseUntil, null, 'a szünet sosem érkezik kívülről');
  assert.equal(s.rev, 1, 'hiányzó rev esetén 1');
  assert.equal(s.updatedBy, '');
});

test('junk in the payload is dropped, not carried into the block list', () => {
  const out = normalizeIncomingSites([
    null,
    { domain: 'nincs-id.example' },
    { id: 'b' },
    { id: 'c', domain: 'reddit.com', addedAt: 2, hostnames: 'nem tömb' },
  ]);
  assert.deepEqual(out.map((s) => s.id), ['c']);
  assert.deepEqual(out[0].hostnames, [], 'a rossz típusú hosztnév-lista üresre esik');
});

test('a payload that is not even an array yields nothing', () => {
  assert.deepEqual(normalizeIncomingSites('{}' as unknown), []);
  assert.deepEqual(normalizeIncomingSites(null), []);
});
