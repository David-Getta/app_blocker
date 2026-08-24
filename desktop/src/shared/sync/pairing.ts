// Párosító kód: a kiszolgáló címe helyett néhány karakter.
//
// MIÉRT LÉTEZIK. A szinkronhoz eddig be kellett gépelni egy címet, például
// `http://192.168.1.10:8787`. Ez papíron egy sor, a gyakorlatban viszont az a
// pont, ahol a funkció meghal: aki idáig eljut, ott feladja. Egy önkontroll-app
// legfontosabb tulajdonsága, hogy tényleg használják — egy technikailag
// tökéletes szinkron, amit senki nem kapcsol be, nulla értékű.
//
// A kód ugyanazt az információt viszi, csak tömörebben:
//
//   http://192.168.1.10:8787   ->   K2M4Q      (öt karakter)
//
// A rövidség nem trükk, hanem abból jön, hogy a valóságban a címek NEM
// véletlenszerűek. Otthoni hálózaton szinte mindig 192.168.x.y vagy 10.x.y.z,
// a port pedig a miénk. Ezt a néhány esetet külön jelöljük, és csak azt a pár
// bitet írjuk le, ami tényleg változik.
//
// Amit NEM old meg: tartománynevet (`sync.pelda.hu`) vagy HTTPS-t nem kódol.
// Azoknál a cím marad — de az olyan eset, amikor a felhasználó úgyis tudja,
// mit csinál.

/**
 * Crockford base32: nincs benne I, L, O és U.
 *
 * Az I/1 és az O/0 kézzel másolva összekeverhető, az U-t pedig a Crockford
 * azért hagyja ki, hogy véletlenül se álljon össze káromkodás. A beolvasásnál
 * az I és az L 1-re, az O 0-ra fordul — így az elgépelés nem hibaüzenet, hanem
 * egyszerűen jó eredmény.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A kiszolgáló alapértelmezett portja. Ha ez van, nem kerül a kódba. */
export const DEFAULT_SYNC_PORT = 8787;

/** Ennél hosszabb kódot nem fogadunk el (a leghosszabb eset 8+16 bit). */
const MAX_CODE_CHARS = 12;

interface Bits {
  push(value: number, width: number): void;
}

function writer(): Bits & { bits: number[] } {
  const bits: number[] = [];
  return {
    bits,
    push(value: number, width: number) {
      for (let i = width - 1; i >= 0; i--) bits.push((value >>> i) & 1);
    },
  };
}

function readBits(bits: number[], at: number, width: number): number {
  let out = 0;
  for (let i = 0; i < width; i++) out = out * 2 + (bits[at + i] ?? 0);
  return out;
}

/**
 * Ötbites ellenőrző összeg.
 *
 * Enélkül egy elgépelt karakterből MÁSIK, létező cím lenne, és a felhasználó
 * annyit látna, hogy „a kiszolgáló nem érhető el” — miközben a hiba az, hogy
 * egy betűt rontott el. Így viszont a kód maga mondja meg, hogy elgépelte.
 */
function checksum(bits: number[]): number {
  let h = 0x811c9dc5;
  for (const b of bits) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h & 31;
}

/** `a.b.c.d` -> [a,b,c,d], vagy null, ha nem szabályos IPv4. */
function parseIPv4(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n < 0 || n > 255) return null;
    nums.push(n);
  }
  return nums;
}

/**
 * Cím -> párosító kód, vagy null, ha nem kódolható.
 *
 * Nem kódolható: tartománynév, HTTPS, szabálytalan port. Ilyenkor a felület a
 * teljes címet mutatja — nem hazudunk kódot oda, ahol nem működne.
 */
export function encodePairingCode(url: string): string | null {
  if (typeof url !== 'string') return null;
  const m = /^http:\/\/([0-9.]+)(?::(\d+))?\/?$/i.exec(url.trim());
  if (!m) return null;
  const ip = parseIPv4(m[1]);
  if (!ip) return null;
  const port = m[2] === undefined ? DEFAULT_SYNC_PORT : Number(m[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;

  const w = writer();
  // A négy eset a valóság gyakorisági sorrendjében: otthon szinte mindig
  // 192.168.x.y, utána 10.x.y.z, ritkán 172.16–31.x.y.
  if (ip[0] === 192 && ip[1] === 168) {
    w.push(0, 2);
  } else if (ip[0] === 10) {
    w.push(1, 2);
  } else if (ip[0] === 172 && ip[1] >= 16 && ip[1] <= 31) {
    w.push(2, 2);
  } else {
    w.push(3, 2);
  }
  const tag = readBits(w.bits, 0, 2);

  w.push(port === DEFAULT_SYNC_PORT ? 0 : 1, 1);
  if (port !== DEFAULT_SYNC_PORT) w.push(port, 16);

  if (tag === 0) { w.push(ip[2], 8); w.push(ip[3], 8); }
  else if (tag === 1) { w.push(ip[1], 8); w.push(ip[2], 8); w.push(ip[3], 8); }
  else if (tag === 2) { w.push(ip[1] - 16, 4); w.push(ip[2], 8); w.push(ip[3], 8); }
  else { for (const n of ip) w.push(n, 8); }

  w.push(checksum(w.bits), 5);

  // Feltöltés nullákkal az ötös határig. A beolvasás ELLENŐRZI, hogy ezek
  // tényleg nullák — így a szemét nem áll össze véletlenül érvényes kóddá.
  while (w.bits.length % 5 !== 0) w.bits.push(0);

  let out = '';
  for (let i = 0; i < w.bits.length; i += 5) out += ALPHABET[readBits(w.bits, i, 5)];
  return out;
}

/**
 * Beírt szöveg -> kiszolgáló-cím, vagy null.
 *
 * Kötőjel, szóköz és kisbetű nem számít: kézzel másolva senki nem figyel
 * ezekre, és egy kód, ami emiatt nem megy, ugyanolyan rossz, mint a be nem
 * gépelt IP-cím.
 */
export function decodePairingCode(input: string): string | null {
  if (typeof input !== 'string') return null;
  const clean = input.toUpperCase().replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0').replace(/[IL]/g, '1');
  if (clean.length === 0 || clean.length > MAX_CODE_CHARS) return null;

  const bits: number[] = [];
  for (const ch of clean) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) return null;
    for (let i = 4; i >= 0; i--) bits.push((v >>> i) & 1);
  }

  if (bits.length < 8) return null;
  const tag = readBits(bits, 0, 2);
  const explicitPort = bits[2] === 1;
  let at = 3;
  let port = DEFAULT_SYNC_PORT;
  if (explicitPort) {
    if (bits.length < at + 16) return null;
    port = readBits(bits, at, 16);
    at += 16;
    if (port < 1) return null;
  }

  const payloadWidth = tag === 0 ? 16 : tag === 1 ? 24 : tag === 2 ? 20 : 32;
  if (bits.length < at + payloadWidth + 5) return null;

  const ip: number[] = [];
  if (tag === 0) {
    ip.push(192, 168, readBits(bits, at, 8), readBits(bits, at + 8, 8));
  } else if (tag === 1) {
    ip.push(10, readBits(bits, at, 8), readBits(bits, at + 8, 8), readBits(bits, at + 16, 8));
  } else if (tag === 2) {
    ip.push(172, 16 + readBits(bits, at, 4), readBits(bits, at + 4, 8), readBits(bits, at + 12, 8));
  } else {
    for (let i = 0; i < 4; i++) ip.push(readBits(bits, at + i * 8, 8));
  }
  at += payloadWidth;

  const want = checksum(bits.slice(0, at));
  if (readBits(bits, at, 5) !== want) return null;
  at += 5;

  // A maradék CSAK nulla lehet, és legfeljebb négy bit — különben a kód
  // hosszabb, mint amennyi információt hordoz, tehát nem tőlünk származik.
  if (bits.length - at > 4) return null;
  for (let i = at; i < bits.length; i++) if (bits[i] !== 0) return null;

  const host = ip.join('.');
  return port === DEFAULT_SYNC_PORT ? `http://${host}:${DEFAULT_SYNC_PORT}` : `http://${host}:${port}`;
}

/**
 * Amit a felhasználó a mezőbe írt -> használható cím.
 *
 * Egy mező, kétféle bemenet. Külön mező a kódnak és a címnek azt jelentené,
 * hogy előbb el kell dönteni, melyikbe kell írni — és ez pont az a fajta apró
 * döntés, amitől az emberek abbahagyják.
 */
export function resolveServerInput(input: string): string | null {
  const raw = (input ?? '').trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  const fromCode = decodePairingCode(raw);
  if (fromCode) return fromCode;
  // Séma nélküli cím (`192.168.1.10:8787`): a http:// hiánya nem hiba, csak
  // kihagyott gépelés.
  if (/^[a-z0-9.-]+(?::\d+)?$/i.test(raw)) return `http://${raw}`;
  return null;
}

/** Ahogy a felületen áll: négyes csoportokban, olvashatóan. */
export function formatPairingCode(code: string): string {
  return code.replace(/(.{4})(?=.)/g, '$1-');
}
