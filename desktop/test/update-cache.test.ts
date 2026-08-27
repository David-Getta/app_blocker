import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  cachedPackageUsable, cleanupStaleUpdates, updateCacheDir, updateCachePath,
} from '../src/shared/update-cache';

/**
 * A frissítési csomag gyorsítótára.
 *
 * A csomag ~90 MB. Korábban minden letöltés friss `mkdtemp` mappába ment:
 * futáson belül ez rendben volt, az app ÚJRAINDÍTÁSA után viszont a megjegyzett
 * út a memóriával együtt elveszett — az app újra letöltötte ugyanazt, a régi
 * mappa meg ottmaradt. Aki egy nap háromszor frissít, annak ez háromszor
 * ~90 MB letöltés és ugyanennyi szemét a lemezen, magyarázat nélkül.
 */

/** Saját temp gyökér, hogy a teszt ne a valódi rendszer-mappában takarítson. */
function sandbox(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'breaker-cachetest-'));
  process.env.TMPDIR = dir;
  return dir;
}

function restore(prev: string | undefined): void {
  if (prev === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = prev;
}

function writePkg(version: string, name: string, body: string): string {
  const dest = updateCachePath(version, name);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, body);
  return dest;
}

function sha512(body: string): string {
  return crypto.createHash('sha512').update(body).digest('base64');
}

test('a takarítás csak a MEGTARTANDÓ verziót hagyja meg', () => {
  const prev = process.env.TMPDIR;
  const box = sandbox();
  try {
    writePkg('0.4.5', 'a.zip', 'régi');
    writePkg('0.4.6', 'b.zip', 'régebbi');
    writePkg('0.4.7', 'c.zip', 'ez kell');
    cleanupStaleUpdates('0.4.7');
    assert.deepEqual(fs.readdirSync(updateCacheDir()).sort(), ['0.4.7']);
  } finally {
    restore(prev);
    fs.rmSync(box, { recursive: true, force: true });
  }
});

test('megtartandó verzió nélkül MINDEN megy', () => {
  // Ez az „már naprakész vagy” eset: nincs mit telepíteni, tehát nincs mit
  // őrizni sem — egy korábbi futásból ottmaradt csomag ilyenkor tiszta szemét.
  const prev = process.env.TMPDIR;
  const box = sandbox();
  try {
    writePkg('0.4.6', 'b.zip', 'x');
    cleanupStaleUpdates();
    assert.deepEqual(fs.readdirSync(updateCacheDir()), []);
  } finally {
    restore(prev);
    fs.rmSync(box, { recursive: true, force: true });
  }
});

test('a RÉGI alakú, mkdtemp-es mappákat is eltakarítja', () => {
  // Aki korábbi verzióról frissít, annál ezek ott vannak, és semmi más nem
  // takarítaná el őket: a `discardDownload` csak a memóriában tartott utat
  // ismeri, az meg az app leállásakor elveszett.
  const prev = process.env.TMPDIR;
  const box = sandbox();
  try {
    const old = fs.mkdtempSync(path.join(os.tmpdir(), 'breaker-update-'));
    fs.writeFileSync(path.join(old, 'Breaker-mac.zip'), 'szemét');
    const keeper = path.join(os.tmpdir(), 'valami-mas');
    fs.mkdirSync(keeper);
    cleanupStaleUpdates('0.4.7');
    assert.equal(fs.existsSync(old), false, 'a régi alakú mappa is megy');
    assert.equal(fs.existsSync(keeper), true, 'ami nem a miénk, marad');
  } finally {
    restore(prev);
    fs.rmSync(box, { recursive: true, force: true });
  }
});

test('a gyorsítótárazott csomag csak ELLENŐRZŐÖSSZEGGEL fogadható el', () => {
  const prev = process.env.TMPDIR;
  const box = sandbox();
  try {
    const body = 'a csomag tartalma';
    const dest = writePkg('0.4.7', 'c.zip', body);

    assert.equal(
      cachedPackageUsable(dest, { size: body.length, sha512: sha512(body) }), true,
    );

    // Összeg NÉLKÜL nem fogadjuk el. A gyorsítótár a rendszer temp mappájában
    // van, tehát elvben más is írhat bele — a méret önmagában kevés.
    assert.equal(cachedPackageUsable(dest, { size: body.length }), false);

    // Kicserélt tartalom AZONOS mérettel: pont az az eset, amit a méret nem
    // fog ki, és amit telepítve nem lehet visszacsinálni.
    const evil = 'A CSOMAG TARTALMA';
    assert.equal(evil.length, body.length);
    fs.writeFileSync(dest, evil);
    assert.equal(
      cachedPackageUsable(dest, { size: body.length, sha512: sha512(body) }), false,
    );
  } finally {
    restore(prev);
    fs.rmSync(box, { recursive: true, force: true });
  }
});

test('a nem létező csomag nem használható, és nem is hasal el', () => {
  const prev = process.env.TMPDIR;
  const box = sandbox();
  try {
    assert.equal(
      cachedPackageUsable(updateCachePath('0.4.7', 'nincs.zip'), { sha512: 'akármi' }),
      false,
    );
  } finally {
    restore(prev);
    fs.rmSync(box, { recursive: true, force: true });
  }
});
