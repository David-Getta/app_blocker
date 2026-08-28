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

test('a session started on one device reaches the other', async () => {
  // EZ AZ EGÉSZ MOBIL-MUNKAMENET LÉNYEGE. Amíg a menet csak a gépen létezett,
  // a telefon kiskapu volt: elindítod a „Nyelvtanulás” csomagot, felveszed a
  // telefont, és ott minden mehet.
  const a = device([site()]);
  await signIn(a, url, ACCOUNT, PASSWORD, 'Munkagép');
  a.focusPacks = [{
    id: 'pack_1', name: 'Nyelvtanulás',
    allowSites: ['quizlet.com'], allowApps: ['Word'], defaultMinutes: 50,
  }];
  a.focusRun = { packId: 'pack_1', startedAt: 10_000, endsAt: 10_000 + 50 * 60_000 };
  await syncNow(a, 10_100);

  const b = device();
  await signIn(b, url, ACCOUNT, PASSWORD, 'Telefon');
  await syncNow(b, 11_000);
  assert.deepEqual(b.focusPacks?.map((p) => p.name), ['Nyelvtanulás']);
  assert.equal(b.focusRun?.packId, 'pack_1', 'a telefonnak tudnia kell, hogy fut egy menet');
  assert.equal(b.focusRun?.endsAt, 10_000 + 50 * 60_000);
});

test('a stale device cannot switch off a running session', async () => {
  // A kibúvó, amit ez zár: a telefonon marad egy régi állapot, ami szerint nem
  // fut semmi. Feltölti, és a gépen próbatétel nélkül eltűnik a munkamenet.
  const a = device([site()]);
  await signIn(a, url, ACCOUNT, PASSWORD, 'Munkagép');
  await syncNow(a, 12_000);
  assert.equal(a.focusRun?.packId, 'pack_1', 'a gép a futó menettel indul');

  // A „régi” eszköz: ismeri a csomagot, de nála nem fut semmi, és a számlálója
  // is elmaradt — pontosan az az állapot, ami egy kimaradt kör után marad.
  const stale = device();
  await signIn(stale, url, ACCOUNT, PASSWORD, 'Regi telefon');
  stale.focusPacks = a.focusPacks;
  // A típussal együtt írjuk be a nullt: e nélkül a fordító a mezőt `null`-ra
  // szűkíti, és az alatta lévő ellenőrzés ÜRESSÉ válna — mindig igaz lenne,
  // akkor is, ha a szinkron nem hozná át a futó menetet.
  stale.focusRun = null as HelperState['focusRun'];
  stale.focusRev = 0;
  stale.focusUpdatedAt = 0;
  await syncNow(stale, 13_000);
  assert.equal(stale.focusRun?.packId, 'pack_1', 'a régi eszköz megkapja a futó menetet');

  // És a gépen sem tűnt el.
  const back = device();
  await signIn(back, url, ACCOUNT, PASSWORD, 'Munkagép');
  await syncNow(back, 14_000);
  assert.equal(back.focusRun?.packId, 'pack_1', 'a menet nem kapcsolódhat ki magától');
});

test('a session stopped on another device still reaches the statistics', async () => {
  // A statisztikát eddig csak a helyi bíró töltötte. Egy TELEFONON leállított
  // menet a szinkronon át érkezik — a futás egyszerűen eltűnik —, és a
  // statisztikából hiányozna: aki a telefonján állítja le a menetet, azt látná,
  // hogy a héten nem is használta.
  const a = device([site()]);
  await signIn(a, url, ACCOUNT, PASSWORD, 'Munkagép');
  a.focusPacks = [{
    id: 'pack_log', name: 'Mély munka',
    allowSites: ['github.com'], allowApps: [], defaultMinutes: 90,
  }];
  a.focusRun = { packId: 'pack_log', startedAt: 20_000, endsAt: Date.now() + 3_600_000 };
  await syncNow(a, 20_100);

  // A „telefon”: megkapja a menetet, majd NAGYOBB számlálóval leállítja —
  // pontosan úgy, ahogy egy teljesített próbatétel után történik.
  const phone = device();
  await signIn(phone, url, ACCOUNT, PASSWORD, 'Telefon');
  await syncNow(phone, 21_000);
  assert.equal(phone.focusRun?.packId, 'pack_log');
  phone.focusRun = null as HelperState['focusRun'];
  phone.focusRev = (phone.focusRev ?? 0) + 5;
  phone.focusUpdatedAt = 22_000;
  await syncNow(phone, 22_000);

  // A gép következő köre látja, hogy vége — és beírja a naplóba.
  const before = (a.focusLog ?? []).length;
  await syncNow(a, 23_000);
  assert.equal(a.focusRun, null, 'a menet tényleg leállt');
  assert.equal((a.focusLog ?? []).length, before + 1, 'és bekerült a statisztikába');
  assert.equal(a.focusLog!.at(-1)!.packName, 'Mély munka');
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

test('key order from another platform does not look like a change', () => {
  // A Kotlin és a Swift kliens MÁS sorrendben írja ki a mezőket, és a nileket
  // ki is hagyhatja. Ha a beérkezett rekordot nyersen tartanánk meg, a
  // JSON-összevetés minden körben különbséget látna — a szinkron
  // fölöslegesen feltöltene, a verziószám a végtelenségig nőne, és a
  // kiszolgáló tíz percenként írna egyet a semmiért.
  const androidOrder = {
    id: 'a', domain: 'youtube.com', hostnames: ['youtube.com'], addedAt: 1,
    pauseUntil: null, pendingDeleteAt: null, rev: 2, updatedAt: 5, updatedBy: 'telefon',
  };
  const swiftOrder = {
    addedAt: 1, domain: 'youtube.com', hostnames: ['youtube.com'], id: 'a',
    pendingDeleteAt: null, rev: 2, updatedAt: 5, updatedBy: 'telefon',
  };
  assert.equal(
    JSON.stringify(normalizeIncomingSites([androidOrder])),
    JSON.stringify(normalizeIncomingSites([swiftOrder])),
  );
});

test('a second sync with nothing changed does not push a new version', async () => {
  // Enélkül a verziószám a végtelenségig nőne, és a kiszolgáló minden tíz
  // percben írna egyet a semmiért — a mezők sorrendje ugyanis elég volt ahhoz,
  // hogy két azonos lista különbözőnek látsszon.
  const a = device([site({ id: 'v1', domain: 'verzio.example', addedAt: 20_000 })]);
  await signIn(a, url, ACCOUNT, 'uj-jelszo-lett-most', 'Verziópróba');
  await syncNow(a, 20_000);
  const first = a.sync!.sitesVersion;
  assert.ok(first && first > 0);

  await syncNow(a, 21_000);
  assert.equal(a.sync!.sitesVersion, first, 'második kör: nincs új verzió');
  await syncNow(a, 22_000);
  assert.equal(a.sync!.sitesVersion, first, 'harmadik kör sem');
});

/**
 * Egy VALÓDI Android-payload — nem kézzel írt, hanem a Kotlin
 * `SyncClient.sitesToJson` kimenete, ide másolva.
 *
 * Jól látszik rajta, hogy a mezők sorrendje teljesen kevert (az org.json
 * hasítótáblát használ). Pont ezért kell a beérkezett rekordokat kanonizálni:
 * enélkül minden kör „változást” látna.
 */
const ANDROID_PAYLOAD = `[{"schedule":{"mode":"scheduled_block","bands":[{"endMin":1020,"days":[1,2,3,4,5],"startMin":540}]},"dailyLimitSeconds":600,"addedAt":1000,"rev":3,"updatedBy":"telefon","domain":"youtube.com","pauseUntil":null,"alias":"A videós","hostnames":["youtube.com","youtu.be"],"id":"s1","pendingDeleteAt":2000,"updatedAt":4000},{"addedAt":5000,"rev":1,"updatedBy":"telefon","domain":"reddit.com","pauseUntil":null,"hostnames":["reddit.com"],"id":"s2","pendingDeleteAt":null,"updatedAt":6000}]`;

test('what Android writes, the desktop reads correctly', () => {
  const sites = normalizeIncomingSites(JSON.parse(ANDROID_PAYLOAD));
  assert.equal(sites.length, 2);

  const [yt, rd] = sites;
  assert.equal(yt.domain, 'youtube.com');
  assert.deepEqual(yt.hostnames, ['youtube.com', 'youtu.be']);
  assert.equal(yt.pendingDeleteAt, 2_000, 'a törlésre várás átjön');
  assert.equal(yt.dailyLimitSeconds, 600);
  assert.equal(yt.alias, 'A videós', 'az ékezet is ép marad');
  assert.equal(yt.rev, 3);
  assert.equal(yt.updatedBy, 'telefon');
  // A menetrend módja a KÖZÖS szöveg, nem a Kotlin enum neve. Ha ez elcsúszna,
  // a gép „mindig tiltva”-ként olvasná a munkaidős menetrendet — vagy fordítva,
  // és az a rosszabb, mert az feloldás.
  assert.equal(yt.schedule?.mode, 'scheduled_block');
  assert.deepEqual(yt.schedule?.bands, [{ days: [1, 2, 3, 4, 5], startMin: 540, endMin: 1020 }]);
  // A szünet sosem érkezik kívülről, akkor sem, ha a másik oldal kiírta.
  assert.equal(yt.pauseUntil, null);

  assert.equal(rd.pendingDeleteAt, null);
  assert.equal(rd.dailyLimitSeconds, undefined);
  assert.equal(rd.alias, undefined);
});

test('the same Android payload twice is not seen as a change', () => {
  const a = normalizeIncomingSites(JSON.parse(ANDROID_PAYLOAD));
  const b = normalizeIncomingSites(JSON.parse(ANDROID_PAYLOAD));
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('a naplók MINDKÉT eszközről összeérnek', async () => {
  // EZ A MUNKAMENET-STATISZTIKA LÉNYEGE, végigmérve a VALÓDI körön: nem az
  // összefésülés egységtesztje, hanem két eszköz, egy kiszolgáló, titkosított
  // blob — és a kérdés, hogy a statisztika tényleg a fiók egészéről szól-e.
  //
  // Amíg a napló csak a gépen létezett, aki a telefonján ült le dolgozni, azt
  // látta, hogy a héten egyszer sem.
  const pack = {
    id: 'pack_log', name: 'Nyelvtanulás',
    allowSites: ['quizlet.com'], allowApps: [], defaultMinutes: 50,
  };
  const row = (startedAt: number, endedAt: number) => ({
    packId: 'pack_log', packName: 'Nyelvtanulás',
    startedAt, endedAt, plannedEndsAt: endedAt, stopped: false,
  });

  const a = device([site()]);
  await signIn(a, url, ACCOUNT, 'uj-jelszo-lett-most', 'Munkagép');
  a.focusPacks = [pack];
  a.focusLog = [row(100_000, 103_000)];
  await syncNow(a, 200_000);

  const b = device();
  await signIn(b, url, ACCOUNT, 'uj-jelszo-lett-most', 'Telefon');
  b.focusLog = [row(300_000, 306_000)];
  await syncNow(b, 400_000);

  const mine = (log: typeof a.focusLog) =>
    (log ?? []).filter((e) => e.packId === 'pack_log').map((e) => e.startedAt);
  assert.deepEqual(
    mine(b.focusLog), [100_000, 300_000],
    'a telefon a saját sora mellé megkapja a gépét is',
  );

  // És VISSZAFELÉ is: a gép következő köre lehozza a telefonon lezárult menetet.
  await syncNow(a, 500_000);
  assert.deepEqual(
    mine(a.focusLog), [100_000, 300_000],
    'a gép statisztikájában ott a telefonon lezárult menet is',
  );
});

test('ugyanazt a menetet két eszköz lezárva sem lesz belőle kettő', async () => {
  // A GYAKORI ESET, nem a kivétel: a telefonon próbatétellel leállítod, a gép
  // meg később, a szinkronból veszi észre. Ha nem fésülődne össze, minden ilyen
  // menet kettőnek számítana, és a statisztika a duplájára nőne.
  const row = (endedAt: number) => ({
    packId: 'pack_kozos', packName: 'Nyelvtanulás',
    startedAt: 900_000, endedAt, plannedEndsAt: 960_000, stopped: true,
  });

  const a = device([site()]);
  await signIn(a, url, ACCOUNT, 'uj-jelszo-lett-most', 'Munkagép');
  a.focusLog = [row(930_000)];              // a gép később vette észre
  await syncNow(a, 1_000_000);

  const b = device();
  await signIn(b, url, ACCOUNT, 'uj-jelszo-lett-most', 'Telefon');
  b.focusLog = [row(925_000)];              // a telefonon állt le, korábban
  await syncNow(b, 1_100_000);

  // A fiók a tesztek között KÖZÖS, tehát a korábbi menetek is ott vannak a
  // naplóban. A saját csomagunkra szűrünk — a kérdés az, hogy EBBŐL az egy
  // menetből egy sor lett-e, nem az, hogy összesen hány sor van.
  const onB = (b.focusLog ?? []).filter((e) => e.packId === 'pack_kozos');
  assert.equal(onB.length, 1, 'egy menet — egy sor');
  assert.equal(
    onB[0].endedAt, 925_000,
    'a menet akkor ért véget, amikor véget ért — nem akkor, amikor a másik észbe kapott',
  );

  await syncNow(a, 1_200_000);
  const onA = (a.focusLog ?? []).filter((e) => e.packId === 'pack_kozos');
  assert.equal(onA.length, 1, 'a gépen sem lesz belőle kettő');
  assert.equal(onA[0].endedAt, 925_000);
});

// ------------------------------------------------------- csatorna-szűrők

const PW2 = 'uj-jelszo-lett-most'; // a jelszóváltós teszt óta ez él

test('a csatorna-szűrők átérnek a másik gépre', async () => {
  const a = device([site()]);
  await signIn(a, url, ACCOUNT, PW2, 'Munkagép');
  a.channelFilters = [{ id: 'chf_sync1', host: 'youtube.com', allow: ['@jo'], enabled: true }];
  await syncNow(a, 1_300_000);

  const b = device();
  await signIn(b, url, ACCOUNT, PW2, 'Másik gép');
  await syncNow(b, 1_310_000);
  assert.deepEqual(
    b.channelFilters,
    [{ id: 'chf_sync1', host: 'youtube.com', allow: ['@jo'], enabled: true }],
    'a másik gép bővítménye csak így tudja érvényesíteni ugyanazt',
  );
});

test('egy üres, új gép nem törli le a szűrőket', async () => {
  // A kibúvó-osztály, amit a munkamenetnél már egyszer bezártunk: az új eszköz
  // frissebb idejű, üres listája nem nyerhet — az üresség nem szerkesztés.
  const fresh = device();
  await signIn(fresh, url, ACCOUNT, PW2, 'Vadonatúj gép');
  await syncNow(fresh, 1_400_000);
  assert.equal(fresh.channelFilters?.length, 1, 'az új gép a szűrőket KAPJA, nem törli');

  const check = device();
  await signIn(check, url, ACCOUNT, PW2, 'Ellenőrző');
  await syncNow(check, 1_410_000);
  assert.equal(check.channelFilters?.length, 1, 'a kiszolgálón is megmaradtak');
});

test('a lazítás rev-munkával ér át, és mindkét gép ugyanoda jut', async () => {
  const a = device([site()]);
  await signIn(a, url, ACCOUNT, PW2, 'Munkagép');
  await syncNow(a, 1_500_000);
  assert.equal(a.channelFilters?.[0]?.enabled, true);

  // A kikapcsolás a helyi kapun (referee) át történik — itt az EREDMÉNYÉT
  // játsszuk el: a lista változik, a syncNow lépteti a számlálót.
  a.channelFilters = [{ ...a.channelFilters![0], enabled: false }];
  await syncNow(a, 1_510_000);

  const b = device();
  await signIn(b, url, ACCOUNT, PW2, 'Másik gép');
  await syncNow(b, 1_520_000);
  assert.equal(b.channelFilters?.[0]?.enabled, false,
    'a próbatétellel megszerzett kikapcsolás a másik gépen is érvényes');
});

test('egy RÉGI kiszolgáló mellett a kör nem hal meg, és nem is néma', async () => {
  // A régi kiszolgáló nem ismeri a `channels` gyűjteményt. A blokklistának
  // ettől még szinkronban KELL maradnia, a csatorna-szűrőkről pedig ki kell
  // derülnie, hogy nem érnek át — különben a felhasználó azt hinné, átértek.
  const fs2 = await import('node:fs');
  const path2 = await import('node:path');
  const os2 = await import('node:os');
  const { spawn: spawn2 } = await import('node:child_process');

  const oldDir = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'breaker-old-server-'));
  const src = fs2.readFileSync(findServer(__dirname), 'utf8');
  const stripped = src.replace(/^\s*channels: \{ perDevice: false \},\s*$/m, '');
  if (stripped === src) throw new Error('nem sikerült régi kiszolgálót faragni');
  const oldServer = path2.join(oldDir, 'server.js');
  fs2.writeFileSync(oldServer, stripped);
  // A store.js-t a régi kiszolgáló is a saját mappájából keresi.
  fs2.copyFileSync(path2.join(path2.dirname(findServer(__dirname)), 'store.js'),
    path2.join(oldDir, 'store.js'));

  const oldChild = spawn2(process.execPath, [oldServer], {
    env: { ...process.env, PORT: '0', BREAKER_SYNC_DIR: path2.join(oldDir, 'data') },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  try {
    const oldUrl = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('a régi kiszolgáló nem indult el')), 10_000);
      oldChild.stdout!.on('data', (buf: Buffer) => {
        const m = /(http:\/\/[\d.]+:\d+)/.exec(buf.toString());
        if (m) { clearTimeout(timer); resolve(m[1].replace('0.0.0.0', '127.0.0.1')); }
      });
    });

    const a = device([site({ id: 'site_old', domain: 'reddit.com', hostnames: ['reddit.com'] })]);
    await signUp(a, oldUrl, 'regi@example', PASSWORD, 'Munkagép');
    a.channelFilters = [{ id: 'chf_old', host: 'youtube.com', allow: ['@jo'], enabled: true }];
    await syncNow(a, 1_600_000);
    assert.ok(a.channelsSyncError, 'a hibának LÁTSZANIA kell — néma kimaradás nincs');
    assert.match(a.channelsSyncError!, /régebbi/);

    const b = device();
    await signIn(b, oldUrl, 'regi@example', PASSWORD, 'Másik gép');
    await syncNow(b, 1_610_000);
    assert.equal(b.sites.length, 1, 'a blokklista a régi kiszolgálón is átér');
    assert.equal(b.channelFilters?.length ?? 0, 0, 'a szűrők tényleg nem érnek át — és ezt ki is írtuk');
  } finally {
    oldChild.kill();
    fs2.rmSync(oldDir, { recursive: true, force: true });
  }
});
