// Megfelelőségi fixtúra a PÁROSÍTÓ KÓDRA: a gép kódol, a telefon olvas.
//
// Ez a legközvetlenebb szerződés a három nyelv között: a gépen kiírt kódot a
// telefonon gépelik be. Ha egy bit eltér, a kód nem nyílik ki — vagy ami
// rosszabb, MÁS címet ad. A Kotlin tesztje eddig öt bemásolt kódot nézett, a
// Swiftnek egy tesztje sem volt. Itt a gép minden esetre kimondja, mit ad
// (kód, cím vagy semmi), és a két telefonnak ugyanazt kell adnia: a kódolásra
// (cím → kód), az olvasásra (beírt szöveg → cím; kézzel írt alakok: kötőjel,
// szóköz, kisbetű, O/0, I/1, nem latin számjegy, teljes szélességű betű,
// elgépelés, szemét), az egy mezőre (kód VAGY cím) és a megjelenítésre.
//
// A fájl csupa ASCII: a láthatatlan jelek `\uXXXX` alakban állnak.
//
//   UPDATE_PAIRING_FIXTURE=1 npm test     — a fájl újraírása

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  decodePairingCode, encodePairingCode, formatPairingCode, resolveServerInput,
} from '../src/shared/sync/pairing';
import { rng } from './merge-random';

const FIXTURE = path.resolve(__dirname, '..', '..', '..', 'fixtures', 'pairing-cases.json');
const SEEDS = 60;

interface Case { in: string; out: string | null }
interface Fixture { note: string; version: number; encode: Case[]; decode: Case[]; resolve: Case[]; format: Case[] }

/** Kézzel válogatott címek: a négy osztály, portok a határokon, és ami nem kódolható. */
const CURATED_URLS = [
  'http://192.168.1.10:8787', 'http://192.168.1.10', 'http://192.168.1.10/', 'HTTP://192.168.1.10:8787/',
  ' http://192.168.1.10:8787 ', '\ufeffhttp://192.168.1.10:8787\n', '\u00a0http://192.168.1.10:8787',
  'http://10.0.0.5:8787', 'http://10.255.255.254', 'http://172.16.4.9:8787', 'http://172.31.200.1:8787',
  'http://172.32.0.1:8787', 'http://172.15.0.1:8787', 'http://100.64.3.7:8787', 'http://8.8.8.8:8787',
  'http://0.0.0.0:8787', 'http://255.255.255.255:65535', 'http://192.168.1.10:9000', 'http://192.168.1.10:1',
  'http://192.168.1.10:65535', 'http://192.168.1.10:65536', 'http://192.168.1.10:0', 'http://192.168.1.10:99999999999',
  'http://192.168.1.10:08787', 'http://192.168.001.010:8787', 'https://192.168.1.10:8787', 'http://sync.pelda.hu:8787',
  'http://192.168.1.256:8787', 'http://192.168.1:8787', 'http://192.168.1.10.5:8787', 'http://192.168.1.10:8787/path',
  'http://192.168.1.10:8787?x', 'http://user@192.168.1.10:8787', '192.168.1.10:8787', '', 'http://', 'http://1.2.3.4:',
  'http://192.168.1.10:8787\u200b', 'http://192.168.1.1\u0660:8787',
];

/** Egy véletlen cím: osztály, port (alap kiírva, kihagyva, véletlen, rossz), záró perjel, nagybetűs séma. */
function randomUrl(r: () => number): string {
  for (let i = 0; i < 4; i++) r();
  const cls = Math.floor(r() * 4);
  const o = () => Math.floor(r() * 256);
  const ip = cls === 0 ? [192, 168, o(), o()] : cls === 1 ? [10, o(), o(), o()]
    : cls === 2 ? [172, 16 + Math.floor(r() * 16), o(), o()] : [o(), o(), o(), o()];
  const portDraw = Math.floor(r() * 4);
  const port = portDraw === 0 ? ':8787' : portDraw === 1 ? '' : portDraw === 2 ? `:${1 + Math.floor(r() * 65535)}`
    : (r() < 0.5 ? ':0' : `:${65536 + Math.floor(r() * 1000)}`);
  const slash = r() < 0.3 ? '/' : '';
  const scheme = r() < 0.2 ? 'HTTP://' : 'http://';
  return `${scheme}${ip.join('.')}${port}${slash}`;
}

/** Kézzel írt alakok egy kódból: a felhasználó így gépeli be. */
function handwritten(code: string, r: () => number): string[] {
  const out = [formatPairingCode(code), code.toLowerCase(), code.split('').join(' '), ` ${code}\n`];
  out.push(code.replace(/0/g, 'O').replace(/1/g, 'I'));
  out.push(code.replace(/1/g, 'L').replace(/0/g, 'o'));
  out.push(code.replace(/1/g, '\u0131')); // török pont nélküli i — nagybetűje az I, az pedig 1
  out.push(`${code}\u0663`); // arab-indiai hármas: nem a kód része, a gép kiszűri
  out.push(code.replace(/K/g, '\uff2b').replace(/A/g, '\uff21')); // teljes szélességű betű: nem ASCII, kiesik
  // Egy elgépelt karakter: az ellenőrző összegnek ki kell fognia — és ha nem,
  // mindhárom nyelvnek UGYANAZT a (rossz) címet kell adnia.
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const at = Math.floor(r() * code.length);
  const other = alphabet[(alphabet.indexOf(code[at]) + 1 + Math.floor(r() * 30)) % 32];
  out.push(code.slice(0, at) + other + code.slice(at + 1));
  return out;
}

const JUNK = [
  '', ' ', '----', 'U', 'UUUUU', 'ZZZZZZZZZZZZZ', 'ZZZZZZZZZZZZ', '0', '00', '000', '00000000', '0000000000000',
  'http://192.168.1.10:8787', '192.168.1.10', 'K2M4Q', '00GMR!', '00GMR-', '\u0663\u0663\u0663\u0663\u0663',
  '\uff10\uff10\uff27\uff2d\uff32', 'ÀÉÍ', '00GMR00GMR00GMR',
];

const RESOLVE_INPUTS = [
  '00GMR', '00-GM-R', ' 00gmr ', '\ufeff00GMR', 'http://192.168.1.10:8787', 'HTTPS://sync.pelda.hu/', 'https://x',
  'sync.pelda.hu', 'sync.pelda.hu:8787', 'sync.pelda.hu:', 'a:b:c', 'müller.de', '192.168.1.10:8787', ' 192.168.1.10 ',
  '\ufeff192.168.1.10', '\u00a0192.168.1.10\u00a0', '', '   ', 'ftp://x', 'host name', 'host_name', '-.-', 'x:1:2',
  'localhost:8787', 'LOCALHOST', 'xn--mller-kva.de:8787', '192.168.1.1\u0660', 'http://', '::1', '[::1]:8787',
];

const FORMAT_INPUTS = ['', 'A', 'ABCD', 'ABCDE', 'ABCDEFGH', 'ABCDEFGHJ', '00GMR', 'R40G208N', '4HJG08AM', 'ABCDEFGHJKMN'];

function buildFixture(): Fixture {
  const urls = [...CURATED_URLS];
  for (let seed = 1; seed <= SEEDS; seed++) urls.push(randomUrl(rng(seed)));
  const encode = urls.map((u) => ({ in: u, out: encodePairingCode(u) }));
  const decodeInputs: string[] = [...JUNK];
  const r = rng(777);
  for (const c of encode) {
    if (c.out === null) continue;
    decodeInputs.push(c.out, ...handwritten(c.out, r));
  }
  const decode = decodeInputs.map((d) => ({ in: d, out: decodePairingCode(d) }));
  const resolveInputs = [...RESOLVE_INPUTS, ...encode.filter((c) => c.out !== null).slice(0, 12).map((c) => c.out as string)];
  const resolve = resolveInputs.map((x) => ({ in: x, out: resolveServerInput(x) }));
  const format = FORMAT_INPUTS.map((x) => ({ in: x, out: formatPairingCode(x) }));
  return {
    note: 'Generálja és őrzi: desktop/test/pairing-fixture.test.ts (UPDATE_PAIRING_FIXTURE=1 npm test). '
      + 'encode: cím → kód (null: nem kódolható); decode: beírt szöveg → cím (null: nem kód); '
      + 'resolve: egy mező, kód vagy cím → cím; format: a kód olvasható alakja. '
      + 'Olvassa: android/jvm-tests PairingFixtureTest, ios/SharedTests PairingFixtureTests. Csupa ASCII.',
    version: 1,
    encode, decode, resolve, format,
  };
}

function ascii(s: string): string {
  return JSON.stringify(s).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
const renderCase = (c: Case) => `  {"in":${ascii(c.in)},"out":${c.out === null ? 'null' : ascii(c.out)}}`;
function render(f: Fixture): string {
  const section = (name: string, rows: Case[]) => ` "${name}": [\n${rows.map(renderCase).join(',\n')}\n ]`;
  return `{\n "note": ${ascii(f.note)},\n "version": ${f.version},\n${[
    section('encode', f.encode), section('decode', f.decode), section('resolve', f.resolve), section('format', f.format),
  ].join(',\n')}\n}\n`;
}

test('a párosító fixtúra friss: a kód oda-vissza jár, és nem elfajult', () => {
  const built = buildFixture();
  // Ami kódolható, az vissza is olvasható — pontosan oda, kiírt alap-porttal.
  for (const c of built.encode) {
    if (c.out === null) continue;
    const back = decodePairingCode(c.out);
    assert.ok(back !== null, `a saját kód nem nyílik ki: ${ascii(c.in)} → ${c.out}`);
    assert.ok(/^[0-9A-Z]{1,12}$/.test(c.out), `a kód nem a kódábécéből van: ${c.out}`);
  }
  const some = (cases: Case[], f: (c: Case) => boolean, what: string) => assert.ok(cases.some(f), what);
  some(built.encode, (c) => c.out !== null, 'nincs kódolható cím');
  some(built.encode, (c) => c.out === null, 'minden cím kódolható — a fixtúra elfajult');
  some(built.decode, (c) => c.out !== null, 'egy kód sem nyílik ki');
  some(built.decode, (c) => c.out === null, 'minden szöveg kódnak látszik — a fixtúra elfajult');
  some(built.resolve, (c) => c.out !== null && c.out.startsWith('http://'), 'a mező nem ad címet');
  some(built.resolve, (c) => c.out === null, 'a mező mindent elfogad — a fixtúra elfajult');

  const text = render(built);
  if (process.env.UPDATE_PAIRING_FIXTURE) {
    fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
    fs.writeFileSync(FIXTURE, text);
  }
  assert.ok(fs.existsSync(FIXTURE), `nincs fixture: ${FIXTURE} — UPDATE_PAIRING_FIXTURE=1 npm test`);
  const onDisk = fs.readFileSync(FIXTURE, 'utf8');
  assert.equal(
    onDisk, text,
    'a fixtures/pairing-cases.json elavult a gép kódjához képest — UPDATE_PAIRING_FIXTURE=1 npm test, '
      + 'aztán a Kotlin (PairingFixtureTest) és a Swift (PairingFixtureTests) teszt mutatja meg, hol csúszott el a tükör',
  );
  assert.ok(/^[\x00-\x7f]*$/.test(onDisk), 'a fixtúra nem csupa ASCII');
});
