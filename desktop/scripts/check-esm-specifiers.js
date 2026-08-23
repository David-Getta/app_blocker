// Guards the renderer bundle: the browser's native ESM loader does not add file
// extensions, so any relative import emitted without ".js" silently 404s and the
// whole UI fails to start. Cheap check, run right after the build.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'dist', 'ui');
const offenders = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (entry.name.endsWith('.js')) check(p);
  }
}

function check(file) {
  const src = fs.readFileSync(file, 'utf8');
  const re = /(?:^|\n)\s*(?:import|export)[^;\n]*?from\s+['"](\.[^'"]*)['"]/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (!m[1].endsWith('.js')) {
      offenders.push(`${path.relative(root, file)} -> ${m[1]}`);
    }
  }
}

if (fs.existsSync(root)) walk(root);
if (offenders.length > 0) {
  console.error('Relative imports without a .js extension in the renderer bundle:');
  for (const o of offenders) console.error(`  ${o}`);
  console.error('\nThe browser cannot resolve these; add the extension in the source import.');
  process.exit(1);
}
console.log('renderer ESM specifiers OK');
