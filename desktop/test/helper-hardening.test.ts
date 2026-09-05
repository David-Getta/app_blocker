// Integration tests against the REAL helper IPC server.
//
// The helper runs as root/SYSTEM and rewrites its whole state file on every
// commit, so anything reaching its socket is untrusted input to a privileged
// process. These tests drive the actual server over a real socket and assert
// that hostile input cannot grow the state file without bound or wedge
// persistence permanently.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as net from 'node:net';
import * as path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'breaker-hard-'));
process.env.BREAKER_STATE = path.join(tmp, 'state.json');
process.env.BREAKER_HOSTS = path.join(tmp, 'hosts');
process.env.BREAKER_SOCKET = path.join(tmp, 'breaker.sock');
fs.writeFileSync(process.env.BREAKER_HOSTS, '127.0.0.1 localhost\n');

import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import { startServer, MAX_BATCH_SAMPLES } from '../src/helper/server';
import { applyBlocklist, legacyHelperSuspected, resetLegacyDetection } from '../src/helper/hosts';
import { defaultState, saveState, type HelperState } from '../src/helper/state';
import { MAX_TARGETS_PER_DAY, OTHER_SITE_KEY } from '../src/shared/usage';
import type { SelfTestReport } from '../src/shared/selftest';

let server: net.Server;
let state: HelperState;
/** Az önteszt a tesztben hamis: a kérdezés nem a szerver dolga, a hordozás igen. */
let fakeSelfTest: SelfTestReport | null = null;

before(async () => {
  state = defaultState();
  server = startServer({
    getState: () => state,
    commit: () => saveState(state),
    dohApplied: () => false,
    log: () => { /* quiet during tests */ },
    selfTest: () => fakeSelfTest,
    runSelfTest: async () => fakeSelfTest ?? { at: 0, checked: 0, leaking: [], unresolved: 0 },
  });
  // wait for listen()
  await new Promise<void>((resolve) => {
    if (server.listening) resolve();
    else server.once('listening', () => resolve());
  });
});

after(() => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

let nextId = 1;

/** One request/response round trip over the real socket. */
function call(op: string, payload: Record<string, unknown> = {}): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(process.env.BREAKER_SOCKET!);
    let buf = '';
    const id = nextId++;
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(JSON.stringify({ id, op, ...payload }) + '\n'));
    sock.on('data', (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      sock.end();
      resolve(JSON.parse(buf.slice(0, nl)));
    });
    sock.on('error', reject);
    setTimeout(() => { sock.destroy(); reject(new Error('timeout')); }, 5000);
  });
}

function stateSize(): number {
  try {
    return fs.statSync(process.env.BREAKER_STATE!).size;
  } catch {
    return 0;
  }
}

test('an unknown command fails loudly instead of silently doing nothing', async () => {
  // Ez a frissítés utáni valós állapot: az új GUI már fut, a root démont
  // viszont a launchd csak a következő indításkor cseréli le, tehát a régi
  // helper kap egy olyan parancsot, amit nem ismer. Ha ilyenkor a switch
  // egyszerűen kifutna, a válasz `ok: true, data: undefined` lenne, és a
  // felhasználó azt hinné, beállította a napi keretet — közben semmi nem
  // történt. Egy blokkoló appban ez a legrosszabb hibamód.
  const r = await call('set_something_from_the_future', { siteId: 'x' });
  assert.equal(r.ok, false, 'az ismeretlen parancs nem lehet sikeres');
  assert.match(String(r.error), /nem ismeri ezt a parancsot/);
  assert.equal((r as { code?: string }).code, 'UNKNOWN_OP');
});

test('a known command still answers normally after an unknown one', async () => {
  // Az ismeretlen parancs nem ránthatja magával a kapcsolatot vagy a helpert.
  const r = await call('status');
  assert.equal(r.ok, true);
  assert.equal(typeof (r.data as { helperVersion?: unknown }).helperVersion, 'string',
    'a helper megmondja a protokollverzióját, ebből veszi észre a GUI az elavulást');
});

test('an oversized request line is refused instead of being buffered', async () => {
  // First line of defence: one request is one JSON line, so a client streaming
  // an endless line must be cut off rather than accumulated in memory.
  await assert.rejects(
    () => call('usage_batch', {
      samples: [{ key: 'site:a.com', label: 'x'.repeat(4 * 1024 * 1024), seconds: 5, at: Date.now() }],
    }),
    (err: NodeJS.ErrnoException) => err.code === 'ECONNRESET' || /timeout/.test(String(err.message)),
    'the connection is closed on an oversized line',
  );
});

test('a hostile usage_batch cannot grow the state file without bound', async () => {
  await call('add_site', { input: 'youtube.com', usePreset: false });
  const baseline = stateSize();

  // Second line of defence: requests that fit comfortably under the line cap
  // but carry huge keys and labels. Before hardening, repeating this grew the
  // root-owned state file by hundreds of megabytes and then wedged it for good.
  const huge = 'x'.repeat(100_000);
  for (let round = 0; round < 20; round++) {
    const samples = Array.from({ length: 4 }, (_, i) => ({
      key: `site:${huge}${round}_${i}`,
      label: huge,
      seconds: 5,
      at: Date.now(),
    }));
    const res = await call('usage_batch', { samples });
    assert.equal(res.ok, true, 'the helper stays responsive');
    assert.equal((res.data as { recorded: number }).recorded, 0,
      'oversized keys are rejected outright');
  }

  const grown = stateSize() - baseline;
  assert.ok(grown < 512 * 1024,
    `state file grew by ${grown} bytes; oversized keys and labels must be rejected`);
});

test('the helper can still persist after the hostile batches', async () => {
  // The reported failure mode: once the state file passed what JSON.stringify
  // can produce, every op that commits threw forever and changes were silently
  // lost on restart.
  const res = await call('add_site', { input: 'reddit.com', usePreset: false });
  assert.equal(res.ok, true, 'add_site still works');

  const onDisk = JSON.parse(fs.readFileSync(process.env.BREAKER_STATE!, 'utf8'));
  const domains = (onDisk.sites as { domain: string }[]).map((s) => s.domain);
  assert.deepEqual(domains.sort(), ['reddit.com', 'youtube.com'],
    'both sites survive a restart, not just the in-memory view');
});

test('malformed samples are skipped, valid ones in the same batch still count', async () => {
  const now = Date.now();
  const res = await call('usage_batch', {
    samples: [
      { key: 'nonsense', label: 'x', seconds: 5, at: now },              // no kind prefix
      { key: 'site:a.com', label: 'a', seconds: -5, at: now },           // negative
      { key: 'site:b.com', label: 'b', seconds: Number.NaN, at: now },   // NaN
      { key: 'site:c.com', label: 'c', seconds: 5, at: Number.NaN },     // bad timestamp
      { key: 'site:d.com', label: 'd', seconds: 5, at: now + 400 * 24 * 3600_000 }, // far future
      { key: 42 as unknown as string, label: 'e', seconds: 5, at: now }, // not a string
      { key: 'site:good.com', label: 'good', seconds: 5, at: now },      // the only valid one
    ],
  });
  assert.equal(res.ok, true);
  assert.equal((res.data as { recorded: number }).recorded, 1, 'exactly one sample was accepted');
});

test('az utolsó mérés ideje csak ELFOGADOTT mintától lép', async () => {
  // Ez a mező a statisztikán a nullát teszi értelmezhetővé: nem lehet
  // megmondani belőle, hogy tényleg nem használtad a gépet, vagy a mérés
  // elhasalt. Ha egy ELDOBOTT minta is léptetné, épp az ellenkezőjét
  // állítaná: azt mondaná, hogy mértünk, pedig semmi nem került be.
  //
  // A fájl tesztjei KÖZÖS segéd-állapoton futnak, és a korábbiak már
  // rögzítettek mintát a mostani időre. Ezért nézünk előre: így az állítás
  // arról szól, amit EZ a teszt tett, nem arról, amit egy korábbi hagyott ott.
  const base = Date.now() + 1_000;
  const read = async (): Promise<number> =>
    ((await call('usage_stats', {})).data as { lastSampleAt: number }).lastSampleAt;

  await call('usage_batch', { samples: [{ key: 'site:x.com', label: 'x', seconds: 5, at: base }] });
  assert.equal(await read(), base);

  // Csupa érvénytelen köteg — a mező nem mozdulhat.
  await call('usage_batch', {
    samples: [
      { key: 'nonsense', label: 'x', seconds: 5, at: base + 10_000 },
      { key: 'site:y.com', label: 'y', seconds: 5, at: base + 400 * 24 * 3600_000 },
    ],
  });
  assert.equal(await read(), base, 'egy eldobott köteg nem állíthatja, hogy mértünk');

  // A LEGKÉSŐBBI elfogadott minta ideje számít, nem a köteg sorrendje: egy
  // köteg percekkel korábbi szeleteket is hozhat, és a kérdés az, hogy mikor
  // MÉRTÜNK, nem az, hogy mikor ért ide a csomag.
  await call('usage_batch', {
    samples: [
      { key: 'site:z.com', label: 'z', seconds: 5, at: base + 3_000 },
      { key: 'site:z.com', label: 'z', seconds: 5, at: base + 2_000 },
    ],
  });
  assert.equal(await read(), base + 3_000);
});


test('a far-future timestamp cannot evict real history', async () => {
  const stats = await call('usage_stats');
  assert.equal(stats.ok, true);
  const onDisk = JSON.parse(fs.readFileSync(process.env.BREAKER_STATE!, 'utf8')) as HelperState;
  const days = onDisk.usage.days.map((d) => d.day);
  // Retention keeps at most RETENTION_DAYS buckets; a rejected far-future
  // sample must not have created one that pushes today's data out.
  assert.ok(days.length >= 1, 'history exists');
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  assert.ok(days.includes(todayKey), "today's bucket is still there");
});

test('a batch is capped and a day cannot hold unbounded targets', async () => {
  const now = Date.now();
  // more samples than the batch cap, all individually valid
  const samples = Array.from({ length: MAX_BATCH_SAMPLES + 400 }, (_, i) => ({
    key: `site:flood${i}.example`, label: `flood${i}`, seconds: 1, at: now,
  }));
  await call('usage_batch', { samples });
  // and again, to push well past the per-day target cap
  await call('usage_batch', { samples: samples.slice(MAX_BATCH_SAMPLES) });

  const onDisk = JSON.parse(fs.readFileSync(process.env.BREAKER_STATE!, 'utf8')) as HelperState;
  const today = onDisk.usage.days[onDisk.usage.days.length - 1];
  const targetCount = Object.keys(today.seconds).length;
  assert.ok(targetCount <= MAX_TARGETS_PER_DAY,
    `a day holds ${targetCount} targets; the cap is ${MAX_TARGETS_PER_DAY}`);
  assert.ok(OTHER_SITE_KEY in today.seconds,
    'the folded-away tail is preserved in the catch-all, not silently dropped');
});

test('the helper socket is not reachable by other local users', () => {
  // The helper runs as root and its socket is a command channel into it. If the
  // file is group- or world-accessible, any local process can drive the root
  // daemon: pause a block, delete a site, rewrite the hosts file.
  if (process.platform === 'win32') return;
  const mode = fs.statSync(process.env.BREAKER_SOCKET!).mode & 0o777;
  assert.equal(mode & 0o077, 0, `socket mode is ${mode.toString(8)}, must be owner-only`);
});

// ------------------------------- a korábbi verzió segédjének felismerése

test('a legacy block that keeps coming back is reported, not fought', async () => {
  // Az átnevezés után a régi (Lakat) LaunchDaemon nem tűnik el magától. Ha fut,
  // két root démon írja ugyanazt a hosts fájlt, és mindkettő figyeli a
  // változást: körbe-körbe írnák felül egymást, folyamatos DNS-ürítéssel — és
  // a felhasználó csak annyit látna, hogy „valami furcsa”.
  const hostsFile = process.env.BREAKER_HOSTS!;
  const legacy = [
    '# >>> LAKAT BLOCK BEGIN — ezt a részt a Lakat kezeli, kézzel ne szerkeszd',
    '0.0.0.0 regi-oldal.example',
    '# <<< LAKAT BLOCK END',
  ].join('\n');

  resetLegacyDetection();
  assert.equal(legacyHelperSuspected(), false, 'induláskor nincs gyanú');

  // Első két visszatérés még lehet maradék: takarítjuk, nem szólunk.
  for (let i = 0; i < 2; i++) {
    fs.writeFileSync(hostsFile, `127.0.0.1 localhost\n\n${legacy}\n`);
    applyBlocklist(state, Date.now());
    assert.ok(!fs.readFileSync(hostsFile, 'utf8').includes('LAKAT BLOCK'),
      'amíg nincs gyanú, kitakarítjuk');
  }
  assert.equal(legacyHelperSuspected(), false, 'két visszatérés még nem élő démon');

  // A harmadik viszont már nem maradék, hanem valaki visszaírja.
  fs.writeFileSync(hostsFile, `127.0.0.1 localhost\n\n${legacy}\n`);
  applyBlocklist(state, Date.now());
  assert.equal(legacyHelperSuspected(), true, 'a sorozatos visszatérés élő démont jelent');

  // Innentől NEM veszekszünk: a régi blokk maradhat. Ez a biztonságos irány —
  // több oldal marad tiltva, nem kevesebb.
  fs.writeFileSync(hostsFile, `127.0.0.1 localhost\n\n${legacy}\n`);
  applyBlocklist(state, Date.now());
  assert.ok(fs.readFileSync(hostsFile, 'utf8').includes('LAKAT BLOCK'),
    'gyanú után békén hagyjuk a régi blokkot');
});

test('the status tells the GUI about the legacy helper', async () => {
  const r = await call('status');
  assert.equal(r.ok, true);
  assert.equal((r.data as { legacyHelperRunning?: boolean }).legacyHelperRunning, true,
    'a felület enélkül nem tudná kiírni, mi a baj');
  resetLegacyDetection();
});

// A fedőnév és a lista elrejtése a socketen át érkezik, tehát ugyanúgy nem
// megbízható bemenet egy root folyamatnak, mint bármi más. Két dolgot kell
// állítania: (1) próbatétel nélkül menjen — egyik sem gyengíti a blokkolást,
// (2) a szemetet a HELPER tisztítsa meg, ne a felület, mert a felület
// megkerülhető: aki a sockethez fér, közvetlenül is küldhet.

test('an alias is normalised by the helper, not trusted from the caller', async () => {
  const added = await call('add_site', { input: 'pelda-fedonev.example' });
  assert.equal(added.ok, true, JSON.stringify(added));
  const site = (added.data as { sites: { id: string; domain: string }[] }).sites
    .find((s) => s.domain === 'pelda-fedonev.example')!;

  // Vezérlőkarakter és túl hosszú név — mind a socketen érkezik.
  const hostile = `  A\u0000vide\u001fos\u007f${'x'.repeat(200)}`;
  const r = await call('set_alias', { siteId: site.id, alias: hostile });
  assert.equal(r.ok, true, JSON.stringify(r));
  const stored = (r.data as { sites: { id: string; alias?: string }[] }).sites
    .find((s) => s.id === site.id)!.alias!;
  assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(stored),
    `vezérlőkarakter maradt a mentett állapotban: ${JSON.stringify(stored)}`);
  assert.ok(stored.length <= 40, `túl hosszú maradt: ${stored.length}`);

  // Üres fedőnév = nincs fedőnév, nem üres sztring a mentett állapotban.
  const cleared = await call('set_alias', { siteId: site.id, alias: '   ' });
  assert.equal((cleared.data as { sites: { id: string; alias?: string }[] }).sites
    .find((s) => s.id === site.id)!.alias, undefined);
});

test('an alias on an unknown site is refused, not silently ignored', async () => {
  const r = await call('set_alias', { siteId: 'site_nincs_ilyen', alias: 'akármi' });
  assert.equal(r.ok, false);
});

test('hiding the list is a stored setting, and survives a helper restart', async () => {
  const on = await call('set_hide_list', { hidden: true });
  assert.equal(on.ok, true, JSON.stringify(on));
  assert.equal((on.data as { hideSiteList?: boolean }).hideSiteList, true);
  // Nem elég a memóriában: az app újraindulása után is rejtve kell lennie.
  assert.equal(JSON.parse(fs.readFileSync(process.env.BREAKER_STATE!, 'utf8')).hideSiteList, true);

  const off = await call('set_hide_list', { hidden: false });
  assert.equal((off.data as { hideSiteList?: boolean }).hideSiteList, false);
  assert.equal(JSON.parse(fs.readFileSync(process.env.BREAKER_STATE!, 'utf8')).hideSiteList, false);

  // Bármi mást küldve se rejtsen: csak a kifejezett true kapcsolja be.
  const junk = await call('set_hide_list', { hidden: 'igen' as unknown as boolean });
  assert.equal((junk.data as { hideSiteList?: boolean }).hideSiteList, false);
});

test('a zárva lévő oldalon mért idő nem könyvelődik — de elszámolt', async () => {
  // A tiltott oldal hibalapján a fül címsorában ott marad a cím, és a mérő
  // mérné: a hibalap-percek a statisztikát hazudtolnák meg, menetrendes zárás
  // alatt pedig előre kiürítenék a napi keretet. Androidon a tiltott
  // DNS-kérés eleve nem kelt észlelést — a gépen itt, a könyvelés kapujában
  // dől el ugyanez. A kihagyás viszont DÖNTÉS, nem veszteség: a válasz
  // kimondja (skippedClosed), és az utolsó mérés ideje is lép tőle.
  const now = Date.now();
  state.sites.push(
    { id: 'closed1', domain: 'zarva.example', hostnames: ['zarva.example'],
      addedAt: now, pauseUntil: null, pendingDeleteAt: null },
    { id: 'open1', domain: 'nyitva.example', hostnames: ['nyitva.example'],
      addedAt: now, pauseUntil: now + 3600_000, pendingDeleteAt: null },
  );

  const res = await call('usage_batch', {
    samples: [
      { key: 'site:zarva.example', label: 'zárva', seconds: 30, at: now },
      { key: 'site:nyitva.example', label: 'szünet alatt', seconds: 20, at: now },
      { key: 'app:szerkeszto', label: 'Szerkesztő', seconds: 10, at: now },
    ],
  });
  assert.equal(res.ok, true);
  const data = res.data as { recorded: number; skippedClosed: number };
  assert.equal(data.recorded, 2, 'a szünetes oldal és az app számít');
  assert.equal(data.skippedClosed, 1, 'a zárva lévő oldal mintája elszámolt kihagyás');

  const onDisk = JSON.parse(fs.readFileSync(process.env.BREAKER_STATE!, 'utf8')) as HelperState;
  const today = onDisk.usage.days[onDisk.usage.days.length - 1].seconds;
  assert.equal(today['site:zarva.example'], undefined, 'hibalap-idő nem került a statisztikába');
  assert.ok((today['site:nyitva.example'] ?? 0) >= 20,
    'a megváltott szünet alatt mért idő valódi használat — az számít');

  // Az utolsó mérés ideje a kihagyott mintától IS lép: mértünk, csak nem
  // könyveltük — a „mérés nem kap adatot” szonda ettől nem riaszthat.
  const future = now + 5_000;
  await call('usage_batch', {
    samples: [{ key: 'site:zarva.example', label: 'zárva', seconds: 5, at: future }],
  });
  const stats = (await call('usage_stats', {})).data as { lastSampleAt: number };
  assert.equal(stats.lastSampleAt, future);

  state.sites = state.sites.filter((s) => s.id !== 'closed1' && s.id !== 'open1');
});

test('kötegen belüli betelés: a hűtés a köteg további mintáit is kihagyja', async () => {
  // A felhasználó esete: 2 perc Gemini után tilt. A mérés kötegben érkezik —
  // ha a betelés UTÁNI szeletek (a hibalapon mért idő) még ugyanabban a
  // kötegben könyvelődnének, az első hűtés azonnal túlszámolna. A kihagyás
  // annak köszönhető, hogy a döntés mintánként, a MÁR frissült adag-állapoton
  // fut — ez a teszt pont ezt a láncot szögezi le.
  const now = Date.now();
  state.sites.push({
    id: 'burst1', domain: 'adag.example', hostnames: ['adag.example'],
    addedAt: now, pauseUntil: null, pendingDeleteAt: null,
    schedule: { mode: 'scheduled_allow', bands: [{ days: [0, 1, 2, 3, 4, 5, 6], startMin: 0, endMin: 1440 }] },
    burstSeconds: 120, cooldownSeconds: 600,
  });

  const res = await call('usage_batch', {
    samples: [
      { key: 'site:adag.example', label: 'adag', seconds: 130, at: now },        // betelik
      { key: 'site:adag.example', label: 'adag', seconds: 30, at: now + 1000 },  // már hűtésben
    ],
  });
  assert.equal(res.ok, true);
  const data = res.data as { recorded: number; skippedClosed: number };
  assert.equal(data.recorded, 1, 'a betelésig mért szelet számít');
  assert.equal(data.skippedClosed, 1, 'a betelés utáni szelet ugyanabban a kötegben már nem');

  const onDisk = JSON.parse(fs.readFileSync(process.env.BREAKER_STATE!, 'utf8')) as HelperState;
  const today = onDisk.usage.days[onDisk.usage.days.length - 1].seconds;
  assert.equal(Math.round(today['site:adag.example'] ?? 0), 130,
    'a statisztikában csak a valódi használat áll');
  assert.ok((onDisk.bursts?.burst1?.cooldownUntil ?? 0) > now, 'a hűtés tényleg elindult');

  // A betelés meg is számolódik — a felület ebből mondja, hányszor telt be ma.
  assert.equal(onDisk.burstTrips?.burst1?.count, 1, 'egy betelés, egy darab');
  const st = (await call('status', {})).data as {
    sites: { id: string; burstTripsToday: number }[];
  };
  assert.equal(st.sites.find((s) => s.id === 'burst1')?.burstTripsToday, 1,
    'a status kiadja a mai darabszámot');
  // A hűtés alatt kihagyott minta nem betelés — a darabszám nem mozdul.
  await call('usage_batch', {
    samples: [{ key: 'site:adag.example', label: 'adag', seconds: 10, at: now + 2000 }],
  });
  const after = JSON.parse(fs.readFileSync(process.env.BREAKER_STATE!, 'utf8')) as HelperState;
  assert.equal(after.burstTrips?.burst1?.count, 1);

  state.sites = state.sites.filter((s) => s.id !== 'burst1');
  delete state.bursts?.burst1;
  delete state.burstTrips?.burst1;
});

test('self_test: kérésre lefut, és MINDEN status-válasz hordozza a jelentést', async () => {
  fakeSelfTest = { at: 123, checked: 2, leaking: [{ host: 'x.example', addresses: ['1.2.3.4'] }], unresolved: 0 };
  const res = await call('self_test', {});
  assert.equal(res.ok, true);
  assert.deepEqual((res.data as { selfTest?: SelfTestReport }).selfTest, fakeSelfTest);
  // Nem csak a `status` parancs: egy másik parancs válasza (ami szintén status)
  // sem ürítheti ki — különben a korong két másodpercenként villogna.
  const other = (await call('set_hide_list', { hidden: false })).data as { selfTest?: SelfTestReport };
  assert.deepEqual(other.selfTest, fakeSelfTest, 'a többi parancs válasza is hordozza');
  fakeSelfTest = null;
  const plain = (await call('status', {})).data as { selfTest?: SelfTestReport };
  assert.equal(plain.selfTest, undefined, 'jelentés nélkül a mező nincs ott');
});

test('set_hostname: a felvétel átmegy a segéden, az idegen név nem', async () => {
  const st = (await call('status', {})).data as { sites: { id: string; domain: string }[] };
  const yt = st.sites.find((s) => s.domain === 'youtube.com');
  assert.ok(yt, 'a youtube.com az előző tesztekből ott van');
  const res = await call('set_hostname', { siteId: yt!.id, hostname: 'https://Music.YouTube.com/' });
  assert.equal(res.ok, true);
  const data = res.data as { applied: boolean; status: { sites: { id: string; hostnames: string[] }[] } };
  assert.equal(data.applied, true);
  assert.ok(data.status.sites.find((s) => s.id === yt!.id)!.hostnames.includes('music.youtube.com'),
    'a status már a bővült listát hozza');
  const bad = await call('set_hostname', { siteId: yt!.id, hostname: 'reddit.com' });
  assert.equal(bad.ok, false);
  assert.equal((bad as { code?: string }).code, 'FOREIGN_HOSTNAME');
});
