// A beépített kiszolgáló két olyan pontja, ami csendben tud elromlani.
//
// Ha a `localhost` kerül a felületre, a telefon SOSEM éri el a gépet — és
// semmilyen hibaüzenet nem magyarázza meg, mert a gépen minden működik. Ha meg
// a csupasz `EADDRINUSE` áll ott, azt egy nem-fejlesztő nem tudja értelmezni.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import type * as os from 'os';
import { lanAddress, serverError, SYNC_PORT } from '../src/main/sync-server-util';

function iface(over: Partial<os.NetworkInterfaceInfo>): os.NetworkInterfaceInfo {
  return {
    address: '0.0.0.0', netmask: '255.255.255.0', family: 'IPv4',
    mac: '00:00:00:00:00:00', internal: false, cidr: null,
    ...over,
  } as os.NetworkInterfaceInfo;
}

test('the loopback address is never offered to the other device', () => {
  // A telefon a 127.0.0.1-et a SAJÁT magára értené. Ez a hiba úgy néz ki, hogy
  // „a gépen minden működik, a telefonon meg semmi”.
  const found = lanAddress({
    lo: [iface({ address: '127.0.0.1', internal: true })],
    en0: [iface({ address: '192.168.1.10' })],
  });
  assert.equal(found, '192.168.1.10');
});

test('IPv6 is skipped: the address goes into a text field by hand', () => {
  const found = lanAddress({
    en0: [iface({ address: 'fe80::1', family: 'IPv6' }), iface({ address: '10.0.0.5' })],
  });
  assert.equal(found, '10.0.0.5');
});

test('with no network there is simply no address', () => {
  assert.equal(lanAddress({}), undefined);
  assert.equal(lanAddress({ lo: [iface({ address: '127.0.0.1', internal: true })] }), undefined);
});

test('a taken port is explained, not dumped as a code', () => {
  const busy = Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });
  const msg = serverError(busy);
  assert.match(msg, new RegExp(String(SYNC_PORT)), 'mondja meg, melyik portról van szó');
  assert.match(msg, /fut már egy kiszolgáló/);

  // Amit nem ismerünk, azt nem költjük át: az eredeti üzenet többet ér, mint
  // egy általános „valami hiba történt”.
  assert.equal(serverError(new Error('valami más')), 'valami más');
});
