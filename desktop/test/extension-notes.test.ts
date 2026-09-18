// Az indok a bővítményben: a hídról jött lista tisztítása és a hosztnév szerinti keresés.
//
// A KISZÁLLÍTOTT kódból kivágva, mint a zárva-lista tesztje: a teszt azokat a
// bájtokat hajtja végre, amik a felhasználó böngészőjébe kerülnek.
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

function extensionDir(): string {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'extension');
    if (fs.existsSync(path.join(candidate, 'app-link.js'))) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error('nem talalom az extension/ mappat');
}

function loadNotes(): {
  cleanNotes: (list: unknown) => { host: string; text: string }[];
  noteFor: (link: unknown, host: unknown) => string | null;
} {
  const src = fs.readFileSync(path.join(extensionDir(), 'app-link.js'), 'utf8');
  const pick = (re: RegExp, what: string): string => {
    const m = src.match(re);
    if (!m) throw new Error(`a bővítményben nincs ${what}`);
    return m[0].replace(/^export /, '');
  };
  const cleanSrc = pick(/function cleanNotes\(list\) \{[\s\S]*?\n\}/, 'cleanNotes');
  const forSrc = pick(/export function noteFor\(link, host\) \{[\s\S]*?\n\}/, 'noteFor');
  // eslint-disable-next-line no-new-func
  return new Function(`${cleanSrc}\n${forSrc}\nreturn { cleanNotes, noteFor };`)() as ReturnType<typeof loadNotes>;
}

const { cleanNotes, noteFor } = loadNotes();

test('csak a hosztnév + szöveg alak megy át, tisztítva és 140-re vágva', () => {
  const out = cleanNotes([
    { host: 'YouTube.com', text: '  Mert\u0000 este  nem\n alszom  ' },
    { host: 'x.com', text: 'x'.repeat(300) },
    { host: 'ures.hu', text: '   ' },
    { host: 42, text: 'szám a hosztnév helyén' },
    { text: 'nincs hosztnév' },
    'nem is objektum',
    null,
  ]);
  assert.deepEqual(out.map((n) => n.host), ['youtube.com', 'x.com']);
  assert.equal(out[0].text, 'Mert este nem alszom');
  assert.equal(out[1].text.length, 140);
  assert.deepEqual(cleanNotes(undefined), [], 'régi app válaszában nincs lista');
});

test('az indok PONTOS hosztnévre szól, a kézzel írt cím alakja nem dönt', () => {
  const link = { notes: [{ host: 'youtube.com', text: 'Mert este nem alszom' }] };
  assert.equal(noteFor(link, 'youtube.com'), 'Mert este nem alszom');
  assert.equal(noteFor(link, 'YOUTUBE.COM.'), 'Mert este nem alszom');
  assert.equal(noteFor(link, 'm.youtube.com'), null, 'nem utótag-egyezés');
  assert.equal(noteFor({}, 'youtube.com'), null);
  assert.equal(noteFor(link, ''), null);
});
