// Akadálymentességi próba (axe-core) a füstpróbák lapjain.
//
// MIÉRT ŐR, ÉS NEM EGYSZERI JAVÍTÁS. A felület leghalványabb szövegszíne a
// kártyán 3,85:1 volt (kis betűhöz legalább 4,5:1 kell) — egyetlen token,
// ötvenkét elemen, és semmi nem hasalt el tőle: a képernyőképen minden
// szépnek látszott. A bővítmény beállítási lapján a sötét téma elsődleges
// gombja 2,48:1 volt. Egy következő átszínezés ugyanígy visszahozná, ezért a
// füstpróba minden nézeten lefuttatja, és MINDEN szabálysértés bukás.
//
// Az axe a lap ELŐTT kerül be, indító szkriptként: a lap CSP-je a beszúrt
// szkriptet jogosan tiltja, és azt a próba kedvéért nem lazítjuk. A mérés
// előtt megvárjuk az animációk végét — egy beúszó réteg félúton halványabb,
// és a kontraszt-mérés ezt hibának látná. A végtelen animációkat (a háttér
// lassan sodródó foltjai) nem várjuk: azoknak nincs végük, a próba örökre
// állna. A várakozásnak ezen felül is van felső korlátja.
//
// Az axe-core a CI-ban a playwrighttal együtt kerül fel (`npm i --no-save`).
// Helyben, ha nincs telepítve, a próba kimarad és szól; a CI-ban kötelező.
const fs = require('fs');
const path = require('path');

function axePath() {
  try { return require.resolve('axe-core/axe.min.js'); } catch { /* a globális telepítés jöhet */ }
  try {
    const root = require('child_process').execSync('npm root -g', { encoding: 'utf8' }).trim();
    const p = path.join(root, 'axe-core', 'axe.min.js');
    if (fs.existsSync(p)) return p;
  } catch { /* nincs npm a PATH-on */ }
  return null;
}

let warned = false;

/** Az axe a lapra — a lap betöltése ELŐTT kell hívni. Ha nincs axe, a CI-ban hibát ír. */
async function installAxe(page, failures) {
  const p = axePath();
  if (!p) {
    if (process.env.CI) failures.push('akadálymentesség: nincs axe-core — a CI-ban kötelező (npm i --no-save axe-core)');
    else if (!warned) { warned = true; console.log('(axe-core nincs telepítve — az akadálymentességi próba kimarad)'); }
    return;
  }
  await page.addInitScript({ path: p });
}

/** Lefuttatja az axe-ot a lapon, és minden szabálysértést a failures-be tesz. */
async function checkA11y(page, label, failures) {
  if (!(await page.evaluate(() => typeof window.axe !== 'undefined'))) return;
  await page.evaluate(() => Promise.race([
    Promise.all(document.getAnimations()
      .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
      .map((a) => a.finished.catch(() => {}))),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]));
  const violations = await page.evaluate(async () => {
    const res = await window.axe.run(document, { resultTypes: ['violations'] });
    return res.violations.map((v) => ({
      id: v.id, impact: v.impact, help: v.help, n: v.nodes.length,
      where: v.nodes.slice(0, 3).map((n) => (n.target || []).join(' ')),
    }));
  });
  for (const v of violations) {
    failures.push(`akadálymentesség (${label}): ${v.id} [${v.impact}, ${v.n} elem] — ${v.help} — ${v.where.join(', ')}`);
  }
}

module.exports = { installAxe, checkA11y };
