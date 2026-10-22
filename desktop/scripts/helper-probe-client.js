// A becsomagolt segéd próbájának kliens-fele (mac-helper-probe.sh,
// win-install-probe.ps1).
//
// A segéd élesben a BECSOMAGOLT binárison fut — macOS-en a LaunchDaemon
// ELECTRON_RUN_AS_NODE-dal az app.asar-ból, Windowson a SYSTEM-feladat
// `Breaker.exe --helper`-rel —, a többi próba viszont sima Node-on. Egy
// Electron-frissítés után az app hibátlanul indulhat, miközben a segéd el sem
// indul: a tiltás csendben megszűnne minden gépen. Ez a kliens a telepítő
// módján elindított segédhez csatlakozik, ahogy az app: felvesz egy oldalt, és
// a RENDSZER FELOLDÓJÁVAL nézi meg, hogy tényleg tilt-e — azon az úton, amin a
// böngésző is jár (a hosts-fájllal együtt, lásd helper/selftest.ts).
//
// Használat: node helper-probe-client.js <socket vagy pipe> <domain> [kulcs]
// A kulcs Windowson kell (shared/client-key.ts): a pipe kulcs nélkül senkinek
// nem felel. Kilépési kód 0, ha a segéd felel, felveszi az oldalt, és a domain
// meg a www-alakja tilt; különben 1.
//
// MI SZÁMÍT TILTÁSNAK. macOS-en (és Linuxon) a feloldó a hosts tiltó címét adja
// (0.0.0.0, ::). Windowson a rendszer feloldója ezekre a sorokra SEMMIT nem ad
// vissza — a név fel sem oldódik, a böngésző nem kapcsolódik: az is zár, csak
// másképp (a segéd öntesztje is így számol, lásd shared/selftest.ts). Ezt
// azonban csak akkor fogadjuk el, ha a felvétel ELŐTT a név valódi címre
// oldódott — különben egy hálózat nélküli gépen a próba vak lenne.

const dns = require('dns');
const net = require('net');
const path = require('path');

const { isSinkhole } = require(path.join(__dirname, '..', 'dist', 'shared', 'selftest.js'));

const [sock, domain, key] = process.argv.slice(2);
if (!sock || !domain) {
  console.log('használat: node helper-probe-client.js <socket vagy pipe> <domain> [kulcs]');
  process.exit(2);
}

const CONNECT_MS = 60_000;
const ENFORCE_MS = 30_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Egy kapcsolat, soronként egy JSON-válasz — ahogy a main/helper-client.ts. */
function open() {
  return new Promise((resolve, reject) => {
    const s = net.connect(sock);
    s.once('connect', () => resolve(s));
    s.once('error', reject);
  });
}

function session(s) {
  let buf = '';
  const waiting = new Map();
  s.on('data', (d) => {
    buf += d.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const w = waiting.get(msg.id);
      if (w) { waiting.delete(msg.id); w(msg); }
    }
  });
  let id = 0;
  return (req) => new Promise((resolve, reject) => {
    const my = ++id;
    const t = setTimeout(() => reject(new Error(`nincs válasz (${req.op})`)), 15_000);
    waiting.set(my, (msg) => { clearTimeout(t); resolve(msg); });
    s.write(JSON.stringify({ ...req, id: my }) + '\n');
  });
}

/** A cím-lista, vagy feloldási hibánál `{ error }`. */
async function lookup(host) {
  try {
    const all = await dns.promises.lookup(host, { all: true, verbatim: true });
    return { addresses: all.map((a) => a.address) };
  } catch (e) {
    return { addresses: [], error: e.code || e.message };
  }
}

const show = (r) => (r.error ? `(${r.error})` : r.addresses.join(', '));
const sinkholed = (r) => !r.error && r.addresses.length > 0 && r.addresses.every(isSinkhole);

async function main() {
  // A segéd a telepítés után indul: a csatorna pár másodperc múlva nyílik.
  let s = null;
  let lastErr = '';
  for (const until = Date.now() + CONNECT_MS; Date.now() < until;) {
    try { s = await open(); break; } catch (e) { lastErr = e.code || e.message; await sleep(500); }
  }
  if (!s) { console.log(`HIBA: a segéd csatornája ${CONNECT_MS / 1000} mp alatt sem nyílt meg (${lastErr})`); return 1; }
  const ask = session(s);

  if (key) {
    const hello = await ask({ op: 'hello', key });
    if (!hello.ok) { console.log(`HIBA: a segéd a kulcsot nem fogadta el: ${JSON.stringify(hello)}`); return 1; }
  }
  const status = await ask({ op: 'status' });
  if (!status.ok) { console.log(`HIBA: status: ${JSON.stringify(status)}`); return 1; }
  console.log(`a segéd felel: ${status.data.platform}, segéd-verzió ${status.data.helperVersion}`);

  // Előtte: ha a domain már most is a tiltó címre oldódna, a próba vak lenne.
  const before = await lookup(domain);
  console.log(`${domain} a felvétel előtt: ${show(before)}`);
  if (sinkholed(before)) {
    console.log('HIBA: a domain már a felvétel előtt a tiltó címre oldódik — a próba nem mérne semmit');
    return 1;
  }
  // Ha előtte valódi címre oldódott, utána a fel nem oldódás is tiltás (Windows).
  const resolvedBefore = !before.error && before.addresses.length > 0;
  const blocked = (r) => sinkholed(r) || (resolvedBefore && !!r.error);

  const added = await ask({ op: 'add_site', input: domain, usePreset: false });
  if (!added.ok) { console.log(`HIBA: add_site: ${JSON.stringify(added)}`); return 1; }
  const site = added.data.sites.find((x) => x.domain === domain);
  if (!site) { console.log('HIBA: az oldal nincs a válasz listájában'); return 1; }
  console.log(`felvéve: ${domain} (${site.hostnames.length} név)`);

  const names = [domain, `www.${domain}`];
  let last = {};
  for (const until = Date.now() + ENFORCE_MS; Date.now() < until;) {
    last = {};
    for (const n of names) last[n] = await lookup(n);
    if (names.every((n) => blocked(last[n]))) {
      for (const n of names) console.log(`${n} most: ${show(last[n])}`);
      s.end();
      console.log(names.every((n) => sinkholed(last[n]))
        ? 'a segéd tilt: a rendszer feloldója a tiltó címet adja'
        : 'a segéd tilt: a név a felvétel óta nem oldódik fel (előtte igen)');
      return 0;
    }
    await sleep(1000);
  }
  for (const n of names) console.log(`${n} ${ENFORCE_MS / 1000} mp után: ${last[n] ? show(last[n]) : '-'}`);
  console.log('HIBA: a felvett oldal nem a tiltó címre oldódik — a segéd fut, de nem tilt');
  s.end();
  return 1;
}

main().then((code) => process.exit(code), (e) => { console.log(`HIBA: ${e && e.stack ? e.stack : e}`); process.exit(1); });
