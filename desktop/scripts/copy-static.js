// Copies the renderer's static assets next to the compiled renderer.js.
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'src', 'renderer');
const dst = path.join(__dirname, '..', 'dist', 'ui', 'renderer');
fs.mkdirSync(dst, { recursive: true });
for (const f of ['index.html', 'styles.css']) {
  fs.copyFileSync(path.join(src, f), path.join(dst, f));
}
console.log('static assets copied to', dst);
