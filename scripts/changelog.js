#!/usr/bin/env node
// Változásnapló a git-történetből.
//
// MIÉRT LÉTEZIK. A kiadási jegyzet a workflow-ban él, és minden kiadás előtt
// egy külön commit forgatja („Kiadási jegyzet: vX — cím”). A teljes jegyzet a
// GitHub kiadásain olvasható, de a repóban eddig nem volt egy helyen, mi mikor
// jött. Ez a szkript a commitokból írja a `docs/changelog.md`-t: verziónként
// egy sor, a legújabb elöl; ami nem kapott saját kiadást (nincs címkéje), az
// jelölve — a következő verzió jegyzete mondja el, mi jött benne.
//
// Futtatás minden kiadás után: node scripts/changelog.js
// A címkéket a helyi git szerint nézi; kiadás után érdemes lehúzni őket
// (`git fetch origin --tags`), különben a friss kiadás címke nélkül állna.
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const run = (cmd) => execSync(cmd, { cwd: ROOT, encoding: 'utf8' });

const tags = new Set(run('git tag -l').split('\n').map((t) => t.trim()).filter(Boolean));
// A verziók sorrendje számokkal, nem szövegként: a v0.4.100 a v0.4.99 után jön.
const nums = (v) => v.replace(/^v/, '').split('.').map((p) => parseInt(p, 10) || 0);
const newer = (a, b) => {
  const x = nums(a); const y = nums(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
};
// A legfrissebb címkézett verzió: ami ennél újabb és címke nélküli, az nem
// kihagyott, hanem még nem ment ki — a kettő más mondat.
let newestTag = null;
for (const t of tags) if (/^v\d+\.\d+\.\d+$/.test(t) && (newestTag === null || newer(t, newestTag))) newestTag = t;
const seen = new Set();
const rows = [];
for (const line of run("git log --format=%h%x09%ad%x09%s --date=short").split('\n')) {
  const [hash, date, subject] = line.split('\t');
  const m = /^Kiadási jegyzet: (v\d+\.\d+\.\d+) — (.+)$/.exec(subject ?? '');
  if (!m || seen.has(m[1])) continue;
  seen.add(m[1]);
  const released = tags.has(m[1]);
  const pending = !released && newestTag !== null && newer(m[1], newestTag);
  rows.push({ version: m[1], title: m[2].trim(), date, hash, released, pending });
}

const lines = [
  '# Változásnapló',
  '',
  'Verziónként a kiadási jegyzet címe — a git-történetből (`scripts/changelog.js`',
  'írja, a „Kiadási jegyzet” commitokból), a legújabb elöl. Ami nem kapott saját',
  'kiadást, annak a tartalma a következő verzió jegyzetében van. A teljes jegyzet',
  'a GitHub kiadásain: minden verzió oldalán ott áll, mi újság, és mi jött a',
  'kettővel korábbiban.',
  '',
  '| Verzió | Nap | Mi újság |',
  '|---|---|---|',
  ...rows.map((r) => `| ${r.version}${r.released ? '' : r.pending ? ' (még nincs kiadva)' : ' (nem kapott saját kiadást)'} | ${r.date} | ${r.title} |`),
  '',
];
fs.writeFileSync(path.join(ROOT, 'docs', 'changelog.md'), lines.join('\n'));
console.log(`változásnapló: ${rows.length} verzió, ${rows.filter((r) => !r.released && !r.pending).length} saját kiadás nélkül, `
  + `${rows.filter((r) => r.pending).length} még nincs kiadva → docs/changelog.md`);
