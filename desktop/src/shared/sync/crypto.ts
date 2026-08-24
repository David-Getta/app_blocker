// Végpontok közti titkosítás a szinkronhoz.
//
// Az app eddigi ígérete az volt, hogy „minden mérés ezen a gépen marad”. A
// szinkron ezt csak úgy tarthatja meg, ha a kiszolgáló NEM TUDJA ELOLVASNI, amit
// tárol. Ez a fájl adja ehhez a kulcsokat.
//
// Semmi saját találmány nincs benne: scrypt a jelszóból, HKDF a szétosztáshoz,
// AES-256-GCM a tartalomra. Mindegyik a Node beépített `crypto` moduljából.
//
//   jelszó ──scrypt(só = fiókazonosító)──> gyökér
//                                            ├── HKDF("auth") ─> belépőkulcs ─> a kiszolgálóra megy
//                                            └── HKDF("kek") ──> kulcsburkoló ─> ezzel van becsomagolva az ADATKULCS
//
// Az adatkulcs (MDK) VÉLETLEN, nem a jelszóból származik. Ez azért fontos, mert
// így a jelszó megváltoztatásakor elég ÚJRACSOMAGOLNI a kulcsot — nem kell
// minden eddigi adatot újratitkosítani (amit a kiszolgáló amúgy sem tudna).
//
// Ugyanaz az adatkulcs be van csomagolva egy HELYREÁLLÍTÓ KÓDDAL is. Enélkül az
// elfelejtett jelszó véglegesen elvinné a szinkron-adatot: a kiszolgáló nem tud
// segíteni, mert nem lát bele.

import * as crypto from 'crypto';

/** A titkosított blob formátumának jelölése. Verziózva, hogy cserélhető legyen. */
export const BLOB_PREFIX = 'brk1';

/**
 * scrypt-paraméterek.
 *
 * N = 2^16, r = 8, p = 1 → nagyjából 64 MB memória és pár tized másodperc egy
 * mai gépen. Ez a lassúság a lényeg: ez teszi drágává a jelszó kitalálását
 * annak, aki a kiszolgálóra betört.
 */
export const SCRYPT_N = 1 << 16;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
// A Node alapértelmezett 32 MB-os korlátja kevés ehhez. Az scrypt igénye
// nagyjából 128 * N * r bájt; az OpenSSL SZIGORÚAN nagyobb korlátot kér,
// ezért duplázunk, nem csak ráállunk a pontos értékre.
const SCRYPT_MAXMEM = 2 * 128 * SCRYPT_N * SCRYPT_R;

const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;

/** A jelszóból származó gyökér. A só a fiókazonosító, hogy két fiók ne essen egybe. */
export function rootKey(password: string, accountId: string): Buffer {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('Üres jelszóból nem származtatunk kulcsot.');
  }
  return crypto.scryptSync(
    password.normalize('NFKC'), `breaker:${accountId}`, KEY_LEN,
    { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM },
  );
}

/** Egy gyökérből több, egymástól független alkulcs. */
export function subKey(root: Buffer, label: string): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', root, Buffer.alloc(0), `breaker-${label}-v1`, KEY_LEN));
}

/**
 * Amit a kiszolgálónak KÜLDÜNK belépéskor.
 *
 * Nem a jelszó, és nem is az adatkulcs: egy külön alkulcs. Aki ezt megszerzi,
 * be tud lépni, de az adatot nem tudja elolvasni — az a másik ágon van.
 */
export function authKey(password: string, accountId: string): string {
  return subKey(rootKey(password, accountId), 'auth').toString('base64');
}

/** Friss, véletlen adatkulcs. Ez titkosítja a tartalmat. */
export function newDataKey(): Buffer {
  return crypto.randomBytes(KEY_LEN);
}

/**
 * Helyreállító kód: 160 véletlen bit, nyolc négyes csoportban.
 *
 * Base32 (Crockford), tehát nincs benne se `I`, se `L`, se `O`, se `U` — ezeket
 * kézzel másolva a legkönnyebb elrontani. 160 bit bőven elég ahhoz, hogy a kód
 * kitalálhatatlan legyen, tehát nem is kell scrypttel lassítani: az entrópia
 * magában van, nem egy rövid jelszóból kell kicsikarni.
 */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function newRecoveryCode(): string {
  const bytes = crypto.randomBytes(20); // 160 bit — 32 jel
  let bits = 0;
  let acc = 0;
  let out = '';
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(acc >> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return (out.match(/.{1,4}/g) ?? []).join('-');
}

/** A kód beírásakor a kötőjelek és a kis-nagybetű ne számítson. */
export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0').replace(/[IL]/g, '1');
}

/**
 * Belépőkulcs a helyreállító kódból.
 *
 * Külön ág a jelszóétól: a kód pont arra való, hogy elfelejtett jelszóval is be
 * lehessen jutni. Aki ezt megszerzi, be tud lépni — de a burkolt adatkulcsot
 * csak magával a kóddal tudja kinyitni, mert az egy MÁSIK alkulcs.
 */
export function recoveryAuthKey(code: string): string {
  const norm = normalizeRecoveryCode(code);
  if (norm.length < 16) throw new Error('A helyreállító kód túl rövid.');
  return subKey(Buffer.from(norm, 'utf8'), 'recovery-auth').toString('base64');
}

/** Kulcsburkoló egy helyreállító kódból. */
export function recoveryKey(code: string): Buffer {
  const norm = normalizeRecoveryCode(code);
  if (norm.length < 16) throw new Error('A helyreállító kód túl rövid.');
  return subKey(Buffer.from(norm, 'utf8'), 'recovery');
}

// ------------------------------------------------------------ titkosítás

/**
 * AES-256-GCM. A kimenet: `brk1.<iv>.<tag>.<titkos>` base64url darabokból.
 *
 * Minden híváshoz FRISS véletlen IV: GCM-nél egy IV újrahasználata ugyanazzal a
 * kulccsal nem „gyengébb titkosítás”, hanem a kulcs eldobása.
 */
export function encrypt(key: Buffer, plaintext: string): string {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [BLOB_PREFIX, b64(iv), b64(tag), b64(ct)].join('.');
}

/**
 * Visszafejtés. Hibás kulcsnál, csonka vagy MEGHAMISÍTOTT bloboknál dob.
 *
 * A GCM-címke ellenőrzése nem opcionális: enélkül a kiszolgáló (vagy bárki, aki
 * a helyére áll) bitenként babrálhatna a blokklistán úgy, hogy észre se vesszük.
 */
export function decrypt(key: Buffer, blob: string): string {
  const parts = String(blob).split('.');
  if (parts.length !== 4 || parts[0] !== BLOB_PREFIX) {
    throw new Error('Ismeretlen formátumú titkosított adat.');
  }
  const iv = unb64(parts[1]);
  const tag = unb64(parts[2]);
  const ct = unb64(parts[3]);
  if (iv.length !== IV_LEN || tag.length !== TAG_LEN) {
    throw new Error('Sérült titkosított adat.');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/** Az adatkulcs becsomagolása egy burkolókulccsal (jelszó vagy helyreállító kód). */
export function wrapDataKey(kek: Buffer, dataKey: Buffer): string {
  return encrypt(kek, dataKey.toString('base64'));
}

export function unwrapDataKey(kek: Buffer, wrapped: string): Buffer {
  const raw = Buffer.from(decrypt(kek, wrapped), 'base64');
  if (raw.length !== KEY_LEN) throw new Error('A kicsomagolt kulcs mérete hibás.');
  return raw;
}

/** Amit a regisztráció előállít. A kiszolgáló csak a `serverSide` részt kapja meg. */
export interface Enrollment {
  dataKey: Buffer;
  recoveryCode: string;
  serverSide: {
    accountId: string;
    authKey: string;
    recoveryAuthKey: string;
    wrappedByPassword: string;
    wrappedByRecovery: string;
  };
}

export function enroll(accountId: string, password: string): Enrollment {
  const root = rootKey(password, accountId);
  const dataKey = newDataKey();
  const recoveryCode = newRecoveryCode();
  return {
    dataKey,
    recoveryCode,
    serverSide: {
      accountId,
      authKey: subKey(root, 'auth').toString('base64'),
      // A helyreállító kódnak SAJÁT belépőkulcsa is van. Enélkül a kód
      // használhatatlan lenne: a rendes belépőkulcs a jelszóból származik,
      // tehát elfelejtett jelszóval be sem lehetne jutni ahhoz a burkolathoz,
      // amit a kód nyitna.
      recoveryAuthKey: recoveryAuthKey(recoveryCode),
      wrappedByPassword: wrapDataKey(subKey(root, 'kek'), dataKey),
      wrappedByRecovery: wrapDataKey(recoveryKey(recoveryCode), dataKey),
    },
  };
}

/** Belépés: a kiszolgálótól kapott burkolt kulcs kibontása a jelszóval. */
export function unlockWithPassword(
  accountId: string, password: string, wrappedByPassword: string,
): Buffer {
  return unwrapDataKey(subKey(rootKey(password, accountId), 'kek'), wrappedByPassword);
}

/** Belépés helyreállító kóddal, ha a jelszó elveszett. */
export function unlockWithRecovery(code: string, wrappedByRecovery: string): Buffer {
  return unwrapDataKey(recoveryKey(code), wrappedByRecovery);
}

/**
 * Jelszócsere: az adatkulcs marad, csak a csomagolása változik.
 *
 * Ezért nem kell hozzá semmit újratitkosítani — amit a kiszolgáló amúgy sem
 * tudna megtenni, hiszen nem lát bele.
 */
export function rewrapForNewPassword(
  accountId: string, dataKey: Buffer, newPassword: string,
): { authKey: string; wrappedByPassword: string } {
  const root = rootKey(newPassword, accountId);
  return {
    authKey: subKey(root, 'auth').toString('base64'),
    wrappedByPassword: wrapDataKey(subKey(root, 'kek'), dataKey),
  };
}

function b64(b: Buffer): string { return b.toString('base64url'); }
function unb64(s: string): Buffer { return Buffer.from(s, 'base64url'); }
