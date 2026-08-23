#!/usr/bin/env node
// Typographic guard for the Hungarian strings in the source.
//
// Why this exists: the UI text uses Hungarian quotation marks („ … ”), and
// typing the closing one as a plain ASCII " terminates the surrounding string
// literal instead. In Kotlin that is a hard syntax error that cascades into a
// hundred bogus "unresolved reference" messages — and it can only be caught by
// a full Android build, which needs an SDK the dev machine may not have. This
// check needs nothing but node and finds it in milliseconds.
//
// Run: node scripts/check-text.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const EXTS = new Set(['.kt', '.swift', '.ts', '.tsx', '.js', '.html', '.md']);
const SKIP = new Set(['node_modules', '.git', 'dist', 'dist-test', 'build', '.gradle', 'out']);

// Written as escapes so this file is not its own counterexample.
const OPEN = '\u201E';  // low-9: opens a Hungarian quote
const CLOSE = '\u201D'; // right double: closes one

/** Code: a string literal never spans lines here, so balance per LINE.
 *  Prose: a quotation may wrap, so balance per FILE. */
const PER_FILE = new Set(['.md']);

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (EXTS.has(path.extname(entry.name))) yield full;
  }
}

function count(text, ch) {
  let n = 0;
  for (const c of text) if (c === ch) n++;
  return n;
}

const problems = [];
for (const file of walk(ROOT)) {
  const rel = path.relative(ROOT, file);
  const content = fs.readFileSync(file, 'utf8');
  if (PER_FILE.has(path.extname(file))) {
    const opens = count(content, OPEN);
    const closes = count(content, CLOSE);
    if (opens !== closes) problems.push({ file: rel, line: 0, opens, closes, text: '(egész fájl)' });
    continue;
  }
  content.split('\n').forEach((line, i) => {
    const opens = count(line, OPEN);
    const closes = count(line, CLOSE);
    if (opens === closes) return;
    problems.push({ file: rel, line: i + 1, opens, closes, text: line.trim().slice(0, 110) });
  });
}

if (problems.length === 0) {
  console.log('szöveg-ellenőrzés OK (idézőjel-párok rendben)');
  process.exit(0);
}

console.error('Hibás magyar idézőjel-párok — a záró jel „ ” és nem ASCII " :\n');
for (const p of problems) {
  console.error(`  ${p.file}:${p.line}  (${p.opens} nyitó, ${p.closes} záró)`);
  console.error(`    ${p.text}`);
}
console.error('\nKotlinban ez nem elírás, hanem lezáratlan sztring: fordítási hiba.');
process.exit(1);
