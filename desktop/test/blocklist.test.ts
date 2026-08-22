import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  normalizeDomain, expandHostnames, buildManagedBlock, replaceManagedBlock,
  extractManagedBlock, MARKER_BEGIN, MARKER_END,
} from '../src/shared/blocklist';

test('normalizeDomain accepts messy user input', () => {
  assert.equal(normalizeDomain('https://www.youtube.com/watch?v=abc'), 'youtube.com');
  assert.equal(normalizeDomain('  YouTube.COM  '), 'youtube.com');
  assert.equal(normalizeDomain('m.youtube.com'), 'm.youtube.com');
  assert.equal(normalizeDomain('www.index.hu/belfold'), 'index.hu');
  assert.equal(normalizeDomain('http://user@x.com:8080/p'), 'x.com');
  assert.equal(normalizeDomain('youtu.be.'), 'youtu.be');
});

test('normalizeDomain rejects junk', () => {
  assert.equal(normalizeDomain(''), null);
  assert.equal(normalizeDomain('not a domain'), null);
  assert.equal(normalizeDomain('localhost'), null);
  assert.equal(normalizeDomain('http://'), null);
  assert.equal(normalizeDomain('-bad.com'), null);
});

test('expandHostnames covers www/m and presets', () => {
  const plain = expandHostnames('example.com', true);
  assert.deepEqual(plain, ['example.com', 'm.example.com', 'www.example.com']);
  const yt = expandHostnames('youtube.com', true);
  assert.ok(yt.includes('youtu.be'));
  assert.ok(yt.includes('m.youtube.com'));
  const ytNoPreset = expandHostnames('youtube.com', false);
  assert.ok(!ytNoPreset.includes('youtu.be'));
});

test('managed block build/replace/extract round-trips', () => {
  const base = '127.0.0.1 localhost\n255.255.255.255 broadcasthost\n';
  const block = buildManagedBlock(['youtube.com', 'www.youtube.com'], 'darwin');
  assert.ok(block.startsWith(MARKER_BEGIN));
  assert.ok(block.endsWith(MARKER_END));
  assert.ok(block.includes('0.0.0.0 youtube.com'));
  assert.ok(block.includes(':: youtube.com'));

  const withBlock = replaceManagedBlock(base, block);
  assert.ok(withBlock.includes('127.0.0.1 localhost'));
  assert.equal(extractManagedBlock(withBlock), block);

  // idempotent
  assert.equal(replaceManagedBlock(withBlock, block), withBlock);

  // update replaces, not appends
  const block2 = buildManagedBlock(['facebook.com'], 'darwin');
  const updated = replaceManagedBlock(withBlock, block2);
  assert.ok(!updated.includes('youtube.com'));
  assert.equal(extractManagedBlock(updated), block2);

  // empty removes markers entirely
  const removed = replaceManagedBlock(updated, '');
  assert.ok(!removed.includes('LAKAT'));
  assert.ok(removed.includes('127.0.0.1 localhost'));
});

test('windows block has no ::-lines and CRLF handling works', () => {
  const block = buildManagedBlock(['youtube.com'], 'win32');
  assert.ok(!block.includes('::'));
  const crlf = '127.0.0.1 localhost\r\n\r\n';
  const out = replaceManagedBlock(crlf, block);
  assert.ok(out.includes('0.0.0.0 youtube.com'));
});
