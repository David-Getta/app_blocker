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

test('a lapra kerülő szöveg KÓDPONTBAN vágódik — emodzsi nem marad félbe', () => {
  // Az app magja a fedőnevet, az indokot, a megbízott és a csomag nevét
  // kódpontban korlátozza; a lap eddig UTF-16 egységben vágott, így egy
  // érvényes, emodzsis indok vagy név a lapon félbe vágódott (értelmetlen jel).
  const src = fs.readFileSync(path.join(extensionDir(), 'app-link.js'), 'utf8');
  const partnerSrc = src.match(/function cleanPartner\(raw\) \{[\s\S]*?\n\}/)?.[0];
  const suggestSrc = src.match(/export function cleanSuggest\(raw\) \{[\s\S]*?\n\}/)?.[0]?.replace(/^export /, '');
  assert.ok(partnerSrc && suggestSrc, 'a bővítményben nincs cleanPartner / cleanSuggest');
  // eslint-disable-next-line no-new-func
  const { cleanPartner, cleanSuggest } = new Function(`${partnerSrc}\n${suggestSrc}\nreturn { cleanPartner, cleanSuggest };`)() as {
    cleanPartner: (raw: unknown) => { name: string } | null;
    cleanSuggest: (raw: unknown) => { peakPack: string | null; limitSoon: string } | null;
  };
  const pizza = String.fromCodePoint(0x1f355);
  const lone = (s: string) => /[\ud800-\udbff](?![\udc00-\udfff])|(?:^|[^\ud800-\udbff])[\udc00-\udfff]/.test(s);

  const note = cleanNotes([{ host: 'a.hu', text: pizza.repeat(150) }])[0].text;
  assert.equal([...note].length, 140);
  assert.ok(!lone(note), 'fél emodzsi az indokban');

  const name = cleanPartner({ name: `${'a'.repeat(39)}${pizza}${pizza}` })!.name;
  assert.equal(name, `${'a'.repeat(39)}${pizza}`);

  const s = cleanSuggest({ packId: 'p', name: 'Munka', minutes: 25, peakPack: `${'b'.repeat(39)}${pizza}x`, limitSoon: pizza.repeat(90) })!;
  assert.equal(s.peakPack, `${'b'.repeat(39)}${pizza}`);
  assert.equal([...s.limitSoon].length, 80);
  assert.ok(!lone(s.limitSoon));
});
