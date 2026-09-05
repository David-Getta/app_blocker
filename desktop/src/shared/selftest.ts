// Önteszt: a tiltás TÉNYLEG érvényesül-e — nem csak a segéd fut-e.
//
// MIÉRT VAN. A „Védelem aktív” eddig azt jelentette, hogy a segéd fut és a
// hosts-fájlba beírta a sorait. Azt nem, hogy a rendszer névfeloldója ezeket
// olvassa is: egy VPN-kliens saját feloldóval, egy másik program, ami a
// hosts-fájlt írja, vagy egy csak-IPv4-sor IPv6-os hálózaton mind úgy engedi
// át az oldalt, hogy az app közben zöldet mutat. Egy önkontroll-eszköznél a
// hamis zöld rosszabb a pirosnál: az ember azt hiszi, védve van.
//
// Az önteszt a tiltott neveket a RENDSZER feloldójával kérdezi meg (ahogy a
// böngésző is tenné), és azt nézi, a tiltó címre (0.0.0.0 / ::) oldódnak-e.
// Ez a modul a döntés — tiszta, tesztelhető; a kérdezés a segédben van.
//
// Amit NEM lát, kimondva: a böngésző beépített DNS-over-HTTPS-ét (arra a
// házirend van), és a kérdezés pillanata utáni változást. Tényt mond, nem
// garanciát.

/** Amire a tiltott név feloldódhat úgy, hogy az tiltásnak számít. */
export const SINKHOLE_ADDRESSES: ReadonlySet<string> = new Set(['0.0.0.0', '127.0.0.1', '::', '::1']);

export interface LookupResult {
  host: string;
  addresses: string[];
  /** hibakód, ha a név egyáltalán nem oldódott fel (ENOTFOUND, időtúllépés) */
  error?: string;
}

export interface SelfTestLeak {
  host: string;
  /** a nem tiltó címek, amikre a név feloldódott (legfeljebb néhány) */
  addresses: string[];
}

export interface SelfTestReport {
  at: number;
  /** hány tiltott nevet kérdeztünk meg */
  checked: number;
  /** amelyek NEM a tiltó címre oldódnak — ezekre a tiltás most nem érvényesül */
  leaking: SelfTestLeak[];
  /** amelyek sehova nem oldódtak fel — az is zár, csak másképp (hálózat nélkül normális) */
  unresolved: number;
}

/**
 * Egy cím kanonikus alakja az összevetéshez. A rendszer az IPv6-ot adhatja
 * hosszú alakban (0:0:0:0:0:0:0:1) vagy zóna-azonosítóval — ezek ugyanazok.
 */
function canonical(address: string): string {
  let a = address.trim().toLowerCase();
  const zone = a.indexOf('%');
  if (zone >= 0) a = a.slice(0, zone);
  if (a.includes(':')) {
    const groups = a.split(':').filter((g) => g.length > 0);
    const allZero = groups.every((g) => /^0+$/.test(g));
    if (allZero) return '::';
    const lastOne = groups.length > 0 && groups.slice(0, -1).every((g) => /^0+$/.test(g))
      && /^0*1$/.test(groups[groups.length - 1]);
    if (lastOne) return '::1';
  }
  return a;
}

export function isSinkhole(address: string): boolean {
  return SINKHOLE_ADDRESSES.has(canonical(address));
}

/** A megkérdezett nevek eredményéből a jelentés. */
export function judgeSelfTest(results: LookupResult[], at: number): SelfTestReport {
  const leaking: SelfTestLeak[] = [];
  let unresolved = 0;
  for (const r of results) {
    if (r.error) { unresolved += 1; continue; }
    const bad = r.addresses.filter((a) => !isSinkhole(a));
    if (bad.length > 0) leaking.push({ host: r.host, addresses: bad.slice(0, 3) });
  }
  return { at, checked: results.length, leaking, unresolved };
}
