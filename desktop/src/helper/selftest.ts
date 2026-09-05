// Az önteszt kérdező fele: a tiltott neveket a rendszer feloldójával kérdezi.
//
// SZÁNDÉKOSAN `dns.lookup`, nem `dns.resolve`: a lookup a rendszer
// getaddrinfo-ját használja — ugyanazt az utat, amin a böngésző is jár, a
// hosts-fájllal együtt. A resolve a DNS-kiszolgálót kérdezné közvetlenül, a
// hosts-fájlt megkerülve: pont azt nem mérné, amit mérni akarunk.

import * as dns from 'dns';
import { judgeSelfTest, type LookupResult, type SelfTestReport } from '../shared/selftest';

export type Lookup = (host: string) => Promise<string[]>;

export const systemLookup: Lookup = async (host) => {
  const all = await dns.promises.lookup(host, { all: true, verbatim: true });
  return all.map((a) => a.address);
};

/** Egy beragadt feloldó nem tarthatja fel a segédet: ennyi után „nem oldódott fel”. */
const LOOKUP_TIMEOUT_MS = 4000;
/** Ennyi nevet kérdezünk meg legfeljebb egy körben — a lista elejét, rendezve. */
const MAX_HOSTS = 25;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

function codeOf(e: unknown): string {
  const c = (e as { code?: unknown })?.code;
  return typeof c === 'string' && c.length > 0 ? c : String(e);
}

export async function runSelfTest(
  hosts: string[], now: number, lookup: Lookup = systemLookup, timeoutMs = LOOKUP_TIMEOUT_MS,
): Promise<SelfTestReport> {
  const picked = hosts.slice(0, MAX_HOSTS);
  const results: LookupResult[] = await Promise.all(picked.map(async (host) => {
    try {
      return { host, addresses: await withTimeout(lookup(host), timeoutMs) };
    } catch (e) {
      return { host, addresses: [], error: codeOf(e) };
    }
  }));
  return judgeSelfTest(results, now);
}
