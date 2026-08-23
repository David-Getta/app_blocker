// Runs the compiled test files with node's built-in runner.
//
// Not `node --test dist-test/test/*.test.js`: glob patterns in --test only work
// from Node 21 up, and CI runs Node 20 (the version Electron 31 embeds), where
// the pattern is taken literally — "Could not find …/*.test.js". Not a bare
// directory either: what that walks has changed between versions too. An
// explicit file list behaves the same everywhere.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'dist-test', 'test');
let files = [];
try {
  files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort()
    .map((f) => path.join(dir, f));
} catch {
  console.error(`no compiled tests in ${dir} — did the build step run?`);
  process.exit(1);
}
// A green run with zero tests is the worst possible outcome: it looks like
// everything passed.
if (files.length === 0) {
  console.error(`no *.test.js found in ${dir}`);
  process.exit(1);
}

const res = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(res.status === null ? 1 : res.status);
