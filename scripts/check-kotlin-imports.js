#!/usr/bin/env node
// Catches a missing import of one of OUR OWN Kotlin core types.
//
// Why: the Compose UI files (hu.breaker.app.ui) are the only Kotlin sources that
// nothing here can compile — the JVM test harness deliberately leaves them out
// (they need the Android SDK and Compose), so a missing `import
// hu.breaker.app.core.X` first shows up as a red CI build minutes later, buried
// under dozens of cascading "unresolved reference" messages in unrelated lines.
// This check reads the declarations out of the core package and verifies every
// other file that says `X.` actually imports X. Runs in milliseconds.
//
// Run: node scripts/check-kotlin-imports.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'android', 'app', 'src', 'main', 'java');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.name.endsWith('.kt')) out.push(full);
  }
  return out;
}

if (!fs.existsSync(SRC)) {
  console.log('nincs android forrás, kihagyva');
  process.exit(0);
}

const files = walk(SRC);

// package -> Set of top-level type names it declares
const declared = new Map();
const DECL = /^\s*(?:public\s+|internal\s+)?(?:data\s+|sealed\s+|abstract\s+|open\s+|enum\s+|value\s+)*(?:object|class|interface)\s+([A-Z]\w*)/;

for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  const pkg = (text.match(/^package\s+([\w.]+)/m) || [])[1];
  if (!pkg) continue;
  for (const line of text.split('\n')) {
    const m = line.match(DECL);
    // top-level only: a nested declaration is indented
    if (m && !/^\s/.test(line)) {
      if (!declared.has(pkg)) declared.set(pkg, new Set());
      declared.get(pkg).add(m[1]);
    }
  }
}

const problems = [];
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  const pkg = (text.match(/^package\s+([\w.]+)/m) || [])[1];
  if (!pkg) continue;
  const imports = new Set();
  const wildcards = new Set();
  for (const m of text.matchAll(/^import\s+([\w.]+)(\.\*)?/gm)) {
    if (m[2]) wildcards.add(m[1]);
    else imports.add(m[1]);
  }
  // strip line comments and string literals so prose cannot trigger a hit
  const code = text
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, '').replace(/"(?:[^"\\]|\\.)*"/g, '""'))
    .join('\n');

  for (const [otherPkg, names] of declared) {
    if (otherPkg === pkg) continue;
    for (const name of names) {
      if (!new RegExp(`\\b${name}\\s*[.(]`).test(code)) continue;
      const fq = `${otherPkg}.${name}`;
      if (imports.has(fq) || wildcards.has(otherPkg)) continue;
      // may also be reached through an imported outer scope (X.Y style)
      if ([...imports].some((i) => i.startsWith(`${fq}.`) || i.endsWith(`.${name}`))) continue;
      problems.push({ file: path.relative(ROOT, file), missing: fq });
    }
  }
}

if (problems.length === 0) {
  console.log('kotlin import-ellenőrzés OK');
  process.exit(0);
}

console.error('Hiányzó import(ok) a saját mag-típusainkra:\n');
for (const p of problems) console.error(`  ${p.file}: import ${p.missing}`);
console.error('\nEz a Compose-fájlokban nem derül ki fordítás nélkül, és a CI-ban tucatnyi');
console.error('félrevezető „unresolved reference” hibát szül máshol.');
process.exit(1);
