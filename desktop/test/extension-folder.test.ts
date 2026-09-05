import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  contentHash, HASH_FILE, readManifestVersion, syncExtensionFolder,
} from '../src/main/extension-folder-core';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'breaker-ext-'));
}

function seed(dir: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    const to = path.join(dir, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, body);
  }
}

test('első indítás: a célmappa a forrás mása lesz, lenyomattal', () => {
  const src = tmp(); const dest = path.join(tmp(), 'extension');
  seed(src, { 'manifest.json': '{"version":"0.4.0"}', 'popup.js': 'x', 'sub/a.js': 'y' });
  assert.equal(syncExtensionFolder(src, dest), true);
  assert.equal(fs.readFileSync(path.join(dest, 'popup.js'), 'utf8'), 'x');
  assert.equal(fs.readFileSync(path.join(dest, 'sub', 'a.js'), 'utf8'), 'y');
  assert.equal(readManifestVersion(dest), '0.4.0');
  assert.equal(fs.readFileSync(path.join(dest, HASH_FILE), 'utf8'), contentHash(src));
});

test('változatlan forrás: nem ír újra', () => {
  const src = tmp(); const dest = path.join(tmp(), 'extension');
  seed(src, { 'manifest.json': '{"version":"0.4.0"}', 'popup.js': 'x' });
  syncExtensionFolder(src, dest);
  const before = fs.statSync(path.join(dest, 'popup.js')).mtimeMs;
  assert.equal(syncExtensionFolder(src, dest), false);
  assert.equal(fs.statSync(path.join(dest, 'popup.js')).mtimeMs, before);
});

test('változott tartalom: frissít akkor is, ha a manifest verziója ugyanaz', () => {
  // Egy elfelejtett verzióemelés ne hagyhasson elavult mappát.
  const src = tmp(); const dest = path.join(tmp(), 'extension');
  seed(src, { 'manifest.json': '{"version":"0.4.0"}', 'popup.js': 'régi' });
  syncExtensionFolder(src, dest);
  seed(src, { 'popup.js': 'új' });
  assert.equal(syncExtensionFolder(src, dest), true);
  assert.equal(fs.readFileSync(path.join(dest, 'popup.js'), 'utf8'), 'új');
});

test('ami a forrásból eltűnt, az a célból is eltűnik — a saját fájlok maradnak', () => {
  const src = tmp(); const dest = path.join(tmp(), 'extension');
  seed(src, { 'manifest.json': '{"version":"0.4.0"}', 'regi.js': 'r' });
  syncExtensionFolder(src, dest);
  fs.rmSync(path.join(src, 'regi.js'));
  seed(src, { 'uj.js': 'u' });
  assert.equal(syncExtensionFolder(src, dest), true);
  assert.equal(fs.existsSync(path.join(dest, 'regi.js')), false);
  assert.equal(fs.existsSync(path.join(dest, 'uj.js')), true);
  assert.equal(fs.existsSync(path.join(dest, HASH_FILE)), true);
});

test('félbeszakadt másolás: hamis lenyomat nélkül legközelebb újra fut', () => {
  const src = tmp(); const dest = path.join(tmp(), 'extension');
  seed(src, { 'manifest.json': '{"version":"0.4.0"}', 'popup.js': 'x' });
  // „Félkész” mappa: van fájl, de nincs lenyomat — mintha a másolás megszakadt volna.
  seed(dest, { 'popup.js': 'törött' });
  assert.equal(syncExtensionFolder(src, dest), true);
  assert.equal(fs.readFileSync(path.join(dest, 'popup.js'), 'utf8'), 'x');
});

test('a lenyomat a fájlnevet is számolja, nem csak a tartalmat', () => {
  const a = tmp(); const b = tmp();
  seed(a, { 'x.js': 'ugyanaz' });
  seed(b, { 'y.js': 'ugyanaz' });
  assert.notEqual(contentHash(a), contentHash(b));
});

test('a valódi bővítmény-mappa lenyomatolható és a verziója olvasható', () => {
  const here = path.resolve(__dirname);
  const candidates = [path.join(here, '..', '..', 'extension'), path.join(here, '..', '..', '..', 'extension')];
  const real = candidates.find((c) => fs.existsSync(path.join(c, 'manifest.json')));
  assert.ok(real, 'nincs meg az extension mappa');
  assert.match(contentHash(real!), /^[0-9a-f]{64}$/);
  assert.match(readManifestVersion(real!) ?? '', /^\d+\.\d+\.\d+$/);
});
