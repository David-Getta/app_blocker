// Az alkalmazás-ikon előállítása.
//
// Rajzból, nem képgenerálóból. Egy ikonnak 16 képponton is felismerhetőnek kell
// lennie, és ott egy generált kép mosott foltra esik szét — a mértani rajz
// viszont éles marad minden méretben, és ugyanaz a jel, ami a fejlécben áll.
//
// A jel: MEGSZAKÍTOTT gyűrű — a kör, ami nem zárul be. Nem lakat: az őrzést
// sugallna, pedig itt a felhasználó zárja ki saját magát.
//
// Futtatás:  node scripts/make-icon.js
// Kimenet:   desktop/build/icon.png, website/icon-512.png, favicon, iOS assetek

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..', '..');

/**
 * A gyűrű íve, kiszámolva — nem kézzel becsült koordinátákkal.
 *
 * A rés FELÜL van, szimmetrikusan, és 72 fok széles. Ennél keskenyebb rés 16
 * képponton összezáródna, és a jel sima karikának látszana; ennél szélesebb
 * pedig már nem gyűrű, hanem egy „C” betű.
 */
function ringPath(cx, cy, r, gapDegrees) {
  const half = gapDegrees / 2;
  const startDeg = -90 + half;
  const endDeg = -90 - half;
  const pt = (deg) => {
    const rad = (deg * Math.PI) / 180;
    return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
  };
  const [sx, sy] = pt(startDeg);
  const [ex, ey] = pt(endDeg);
  const f = (n) => n.toFixed(2);
  // large-arc = 1 (a hosszabb ív), sweep = 1 (óramutató járása szerint)
  return `M ${f(sx)} ${f(sy)} A ${r} ${r} 0 1 1 ${f(ex)} ${f(ey)}`;
}

/**
 * @param {number} size a kimenet éle képpontban
 * @param {boolean} inset macOS-stílusú behúzás + vetett árnyék (a rendszer nem
 *   maszkol, tehát az ikon hozza a saját formáját és árnyékát)
 */
function iconSvg(size, inset) {
  const S = 1024;
  const pad = inset ? 100 : 0;
  const tile = S - pad * 2;
  // Az Apple-féle lekerekítés aránya a lapka élének nagyjából 22,4%-a.
  const radius = Math.round(tile * 0.224);
  const cx = S / 2;
  const cy = S / 2;
  const r = Math.round(tile * 0.3);
  const stroke = Math.round(tile * 0.092);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${size}" height="${size}">
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2b2f36" />
      <stop offset="0.55" stop-color="#15181c" />
      <stop offset="1" stop-color="#0b0d10" />
    </linearGradient>
    <linearGradient id="ring" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" />
      <stop offset="1" stop-color="#d9dee6" />
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.18" r="0.72">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.13" />
      <stop offset="1" stop-color="#ffffff" stop-opacity="0" />
    </radialGradient>
    <filter id="drop" x="-25%" y="-25%" width="150%" height="150%">
      <feDropShadow dx="0" dy="${Math.round(tile * 0.028)}"
                    stdDeviation="${Math.round(tile * 0.032)}"
                    flood-color="#000000" flood-opacity="0.45" />
    </filter>
  </defs>

  <g${inset ? ' filter="url(#drop)"' : ''}>
    <rect x="${pad}" y="${pad}" width="${tile}" height="${tile}" rx="${radius}" fill="url(#tile)" />
    <!-- Felső fénykontúr: ettől lesz a lapka anyagszerű, nem lapos folt. -->
    <rect x="${pad}" y="${pad}" width="${tile}" height="${tile}" rx="${radius}" fill="url(#glow)" />
    <rect x="${pad + 1}" y="${pad + 1}" width="${tile - 2}" height="${tile - 2}" rx="${radius - 1}"
          fill="none" stroke="#ffffff" stroke-opacity="0.09" stroke-width="2" />
  </g>

  <path d="${ringPath(cx, cy, r, 72)}"
        fill="none" stroke="url(#ring)" stroke-width="${stroke}" stroke-linecap="round" />
</svg>`;
}

/** Amit elő kell állítani, és hova. */
const TARGETS = [
  { file: 'desktop/build/icon.png', size: 1024, inset: true },
  { file: 'website/icon-512.png', size: 512, inset: true },
  { file: 'website/favicon.png', size: 128, inset: false },
  { file: 'ios/App/Assets.xcassets/AppIcon.appiconset/icon_ios_1024.png', size: 1024, inset: false },
  { file: 'ios/App/Assets.xcassets/AppIcon.appiconset/icon_mac_1024.png', size: 1024, inset: true },
  { file: 'ios/App/Assets.xcassets/AppIcon.appiconset/icon_mac_512.png', size: 512, inset: true },
  { file: 'ios/App/Assets.xcassets/AppIcon.appiconset/icon_mac_32.png', size: 32, inset: true },
  { file: 'ios/App/Assets.xcassets/AppIcon.appiconset/icon_mac_16.png', size: 16, inset: true },
];

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  for (const t of TARGETS) {
    const out = path.join(ROOT, t.file);
    if (!fs.existsSync(path.dirname(out))) {
      console.log(`kihagyva (nincs meg a mappa): ${t.file}`);
      continue;
    }
    // Átlátszó háttér: az iOS ikon NEM lehet átlátszó, de ott inset=false és a
    // lapka kitölti a vásznat, tehát nem marad üres terület.
    await page.setViewportSize({ width: t.size, height: t.size });
    await page.setContent(
      `<style>html,body{margin:0;padding:0;background:transparent}
       svg{display:block}</style>${iconSvg(t.size, t.inset)}`,
    );
    await page.locator('svg').screenshot({ path: out, omitBackground: true });
    console.log(`${t.file}  ${t.size}x${t.size}`);
  }

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
