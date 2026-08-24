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

// A szinkron-kiszolgáló BEKERÜL az appba, hogy a felhasználónak ne kelljen
// terminált nyitnia és külön szolgáltatást futtatnia. Nincs egyetlen
// függősége sem, tehát elég a két fájlt átmásolni; a csomagoló a `dist/**`
// mintával viszi tovább.
const serverSrc = path.join(__dirname, '..', '..', 'server');
const serverDst = path.join(__dirname, '..', 'dist', 'sync-server');
if (fs.existsSync(serverSrc)) {
  fs.mkdirSync(serverDst, { recursive: true });
  for (const f of ['server.js', 'store.js']) {
    fs.copyFileSync(path.join(serverSrc, f), path.join(serverDst, f));
  }
  console.log('sync server copied to', serverDst);
} else {
  // Nem hiba: a füstteszt és a fejlesztői build a repóból fut, ahol ott van.
  // Csomagolásnál viszont ennek meg KELL lennie — ezért hangos a jelzés.
  console.warn('WARNING: server/ not found, the built app will have no built-in sync server');
}
