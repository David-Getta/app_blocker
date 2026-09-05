import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { isSinkhole, judgeSelfTest } from '../src/shared/selftest';
import { runSelfTest } from '../src/helper/selftest';

const AT = 1_700_000_000_000;

test('a tiltó címek minden alakban tiltó címnek számítanak', () => {
  for (const a of ['0.0.0.0', '127.0.0.1', '::', '::1', '0:0:0:0:0:0:0:0', '0:0:0:0:0:0:0:1', '::1%lo0', ' :: ']) {
    assert.equal(isSinkhole(a), true, JSON.stringify(a));
  }
  for (const a of ['142.250.74.206', '2a00:1450:400d:80c::200e', '10.0.0.5', '::ffff:1.2.3.4']) {
    assert.equal(isSinkhole(a), false, a);
  }
});

test('ítélet: tiltó cím = rendben, valódi cím = szivárgás, hiba = feloldatlan', () => {
  const r = judgeSelfTest([
    { host: 'youtube.com', addresses: ['0.0.0.0', '::'] },
    { host: 'reddit.com', addresses: ['0.0.0.0', '2a00:1450:400d:80c::200e'] },
    { host: 'x.com', addresses: ['104.244.42.1'] },
    { host: 'nincs.example', addresses: [], error: 'ENOTFOUND' },
  ], AT);
  assert.equal(r.at, AT);
  assert.equal(r.checked, 4);
  assert.equal(r.unresolved, 1);
  assert.deepEqual(r.leaking.map((l) => l.host), ['reddit.com', 'x.com']);
  // csak a NEM tiltó címek kerülnek a jelentésbe — az IPv6-os fél-szivárgás pont így látszik
  assert.deepEqual(r.leaking[0].addresses, ['2a00:1450:400d:80c::200e']);
});

test('üres lista: nincs mit ellenőrizni, nem szivárog', () => {
  assert.deepEqual(judgeSelfTest([], AT), { at: AT, checked: 0, leaking: [], unresolved: 0 });
});

test('a kérdező: az ígéretek eredménye a jelentés, a hiba feloldatlan, a lista plafonos', async () => {
  const asked: string[] = [];
  const lookup = async (host: string): Promise<string[]> => {
    asked.push(host);
    if (host === 'hibas.example') throw Object.assign(new Error('nope'), { code: 'ENOTFOUND' });
    if (host === 'szivarog.example') return ['93.184.216.34'];
    return ['0.0.0.0', '::'];
  };
  const hosts = ['a.example', 'hibas.example', 'szivarog.example', ...Array.from({ length: 40 }, (_, i) => `t${i}.example`)];
  const r = await runSelfTest(hosts, AT, lookup);
  assert.equal(r.checked, 25, 'legfeljebb 25 nevet kérdezünk meg egy körben');
  assert.equal(asked.length, 25);
  assert.equal(r.unresolved, 1);
  assert.deepEqual(r.leaking, [{ host: 'szivarog.example', addresses: ['93.184.216.34'] }]);
});

test('a kérdező: a beragadt feloldó nem tartja fel — időtúllépés feloldatlannak számít', async () => {
  const lookup = (): Promise<string[]> => new Promise(() => { /* sosem válaszol */ });
  const r = await runSelfTest(['lassu.example', 'gyors.example'], AT, async (host) => (
    host === 'gyors.example' ? ['0.0.0.0'] : lookup()
  ), 50);
  assert.equal(r.checked, 2);
  assert.equal(r.unresolved, 1, 'a beragadt név feloldatlan, nem szivárgó');
  assert.equal(r.leaking.length, 0);
});
