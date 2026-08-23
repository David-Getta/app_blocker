// Removes previous build output before a fresh build.
//
// tsc only ever writes files, it never deletes them. A source file that is
// renamed or removed therefore leaves its compiled .js behind — and the test
// runner globs dist-test/test/*.test.js, so a deleted test kept passing (or
// failing) long after its source was gone. Same class of ghost applies to
// dist/, which the renderer loads by path.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
for (const dir of ['dist', 'dist-test']) {
  fs.rmSync(path.join(root, dir), { recursive: true, force: true });
}
