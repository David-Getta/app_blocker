// Fetches the latest GitHub release and renders platform-aware download buttons.
// Asset names are version-stamped, so we resolve real URLs from the API rather
// than guessing static paths.

const OWNER = "David-Getta";
const REPO = "app_blocker";
const API = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;
const RELEASES = `https://github.com/${OWNER}/${REPO}/releases`;

document.getElementById("allReleases").href = RELEASES;

function detectPlatform() {
  const ua = navigator.userAgent;
  const p = navigator.platform || "";
  if (/Android/i.test(ua)) return "android";
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  if (/Mac/i.test(p) || /Mac/i.test(ua)) return "mac";
  if (/Win/i.test(p) || /Windows/i.test(ua)) return "win";
  return "other";
}

// Classify an asset by file name.
function classify(name) {
  const n = name.toLowerCase();
  if (n.endsWith(".apk")) return { plat: "android", label: "APK (közvetlen telepítés)" };
  if (n.endsWith(".aab")) return null; // Play Store feltöltéshez, nem végfelhasználónak
  // A két Mac-csomag ránézésre ugyanaz, pedig a rossz meg sem nyílik: a nevében
  // az arm64 az Apple szilícium (M1/M2/M3…), a másik az Intel.
  if (n.endsWith(".dmg")) {
    return n.includes("arm64")
      ? { plat: "mac", label: "macOS – Apple szilícium (M1/M2/M3…)" }
      : { plat: "mac", label: "macOS – Intel" };
  }
  if (n.endsWith(".exe")) return { plat: "win", label: "Windows telepítő (.exe)" };
  // A -mac.zip az automatikus frissítés csomagja, nem kézi letöltésre való.
  if (n.endsWith(".zip") && n.includes("mac")) return null;
  // A részleges tiltás böngésző-bővítménye. Külön kártyát kap, mert MÁS, mint a
  // többi letöltés: kézzel kell betölteni, és gyengébb réteg — a nyers fájlnév
  // ezt egyikét sem mondaná el.
  if (n.includes("bovitmeny") && n.endsWith(".zip")) {
    return { plat: "ext", label: "Böngésző-bővítmény (kicsomagolva betöltendő)" };
  }
  if (n.endsWith(".yml") || n.endsWith(".blockmap")) return null; // auto-update metaadat
  return { plat: "other", label: name };
}

// Vonalas jelek, nem emoji — és nem is gyártói logók.
//
// Az emoji minden rendszeren máshogy néz ki (Windowson színes, macOS-en más
// rajzolatú), tehát egy terméklapon nem márka, hanem véletlen. A gyártói
// logók (alma, ablak, robot) viszont VÉDJEGYEK, és egy harmadik fél
// letöltőoldalán nincs keresnivalójuk. Ezért semleges ESZKÖZ-rajzok állnak
// itt: a platformot a felirat nevezi meg, a jel csak megkülönböztet.
//
// Mindegyik örökli a szövegszínt, tehát a témával együtt vált.
const SVG = {
  // Telefon alsó navigációs sávval.
  android:
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">'
    + '<rect x="6" y="2.5" width="12" height="19" rx="2.6" stroke="currentColor" stroke-width="1.6"/>'
    + '<path d="M9.5 18.4h5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  // Monitor talppal.
  win:
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">'
    + '<rect x="2.5" y="4" width="19" height="12.5" rx="2.2" stroke="currentColor" stroke-width="1.6"/>'
    + '<path d="M9 20h6M12 16.5V20" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  // Laptop: képernyő + alap.
  mac:
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">'
    + '<rect x="4.5" y="4.5" width="15" height="10.5" rx="2" stroke="currentColor" stroke-width="1.6"/>'
    + '<path d="M2 18.5h20" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  // Telefon a felső pirulával.
  ios:
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">'
    + '<rect x="6.5" y="2.5" width="11" height="19" rx="2.8" stroke="currentColor" stroke-width="1.6"/>'
    + '<path d="M10.6 5.4h2.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  // Böngészőablak — érthetőbb, mint egy puzzle-darab.
  ext:
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">'
    + '<rect x="2.5" y="4.5" width="19" height="15" rx="2.4" stroke="currentColor" stroke-width="1.6"/>'
    + '<path d="M2.5 9h19" stroke="currentColor" stroke-width="1.6"/>'
    + '<circle cx="5.9" cy="6.8" r="0.8" fill="currentColor"/>'
    + '<circle cx="8.5" cy="6.8" r="0.8" fill="currentColor"/></svg>',
  // Letöltés.
  other:
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">'
    + '<path d="M12 3.5v11m0 0 4-4m-4 4-4-4M4.5 17v2a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-2"'
    + ' stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

const PLATFORMS = {
  android: { ico: SVG.android, name: "Android" },
  win: { ico: SVG.win, name: "Windows" },
  mac: { ico: SVG.mac, name: "macOS" },
  ios: { ico: SVG.ios, name: "iPhone / iPad" },
  ext: { ico: SVG.ext, name: "Böngésző — részleges tiltás" },
  other: { ico: SVG.other, name: "Egyéb" },
};

function render(assetsByPlat, version) {
  // Primary card for the detected platform.
  const plat = detectPlatform();
  const primary = document.getElementById("primary");
  primary.innerHTML = "";
  const meta = PLATFORMS[plat] || PLATFORMS.other;
  const card = document.createElement("div");
  card.className = "primary-card";

  if (plat === "ios") {
    card.innerHTML = `<div class="plat">${meta.ico} iPhone / iPad</div>
      <div class="ver">Az iOS az App Store-ból (vagy TestFlight tesztelőként) telepíthető.</div>
      <a class="btn secondary" href="${RELEASES}" target="_blank" rel="noopener">Kiadások megnyitása</a>`;
  } else {
    const list = assetsByPlat[plat] || [];
    if (list.length) {
      const primaryAsset = list[0];
      card.innerHTML = `<div class="plat">${meta.ico} ${meta.name}</div>
        <div class="ver">Legfrissebb verzió: ${version}</div>
        <a class="btn" href="${primaryAsset.url}">Letöltés — ${primaryAsset.label}</a>`;
    } else {
      card.innerHTML = `<div class="plat">${meta.ico} ${meta.name}</div>
        <div class="ver">Ehhez a platformhoz még nincs kész telepítő ebben a kiadásban.</div>
        <a class="btn secondary" href="${RELEASES}" target="_blank" rel="noopener">Összes letöltés</a>`;
    }
  }
  primary.appendChild(card);

  // Full grid.
  const grid = document.getElementById("grid");
  grid.innerHTML = "";
  // A négy rendszer MINDIG szerepel (ha nincs hozzá fájl, azt is kimondjuk),
  // a bővítmény viszont csak akkor, ha tényleg van a kiadásban — az nem
  // platform, hanem külön letöltés, és egy üres kártya csak zavarna.
  const keys = ["android", "win", "mac", "ios"];
  if ((assetsByPlat.ext || []).length) keys.push("ext");

  for (const key of keys) {
    const meta2 = PLATFORMS[key];
    const div = document.createElement("div");
    div.className = "card";
    let files;
    if (key === "ios") {
      files = `<span class="muted">App Store / TestFlight — lásd a kiadásokat.</span>`;
    } else {
      const list = assetsByPlat[key] || [];
      files = list.length
        ? list.map((a) => `<a class="dl" href="${a.url}">${a.label}</a>`).join("")
        : `<span class="muted">Nincs telepítő ebben a kiadásban.</span>`;
    }
    div.innerHTML = `<div class="plat">${meta2.ico}${meta2.name}</div>
      <div class="files">${files}</div>`;
    grid.appendChild(div);
  }
}

function renderError() {
  const primary = document.getElementById("primary");
  primary.innerHTML = `<div class="primary-card">
    <div class="plat">Még nincs kiadott verzió</div>
    <div class="ver">Amint megjelenik az első kiadás, itt lesz letölthető.</div>
    <a class="btn secondary" href="${RELEASES}" target="_blank" rel="noopener">Kiadások megnyitása</a>
  </div>`;
}

fetch(API, { headers: { Accept: "application/vnd.github+json" } })
  .then((r) => (r.ok ? r.json() : Promise.reject(new Error("no release"))))
  .then((rel) => {
    // A vödrök a PLATFORMS-ból épülnek, nem kézzel felsorolva. Így egy új
    // besorolás (mint a böngésző-bővítmény) nem tud CSENDBEN kiesni: pontosan
    // ez történt vele — a classify „ext”-et adott, a gyűjtő meg eldobta, mert
    // nem volt ilyen vödör. Semmi nem hibázott, a fájl mégsem jelent meg.
    const byPlat = Object.fromEntries(Object.keys(PLATFORMS).map((k) => [k, []]));
    const seen = new Set();
    for (const asset of rel.assets || []) {
      const c = classify(asset.name);
      if (!c || !byPlat[c.plat]) continue;
      // Ugyanaz a telepítő néha két néven kerül fel (a kiadási folyamat két
      // feltöltője máshogy írja a szóközt). A felhasználó ilyenkor két
      // egyforma „Windows telepítő” sort látna, és nem tudná, melyik kell.
      // A felirat a platformon belül egyedi, tehát az első nyer.
      const key = `${c.plat}|${c.label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      byPlat[c.plat].push({ url: asset.browser_download_url, label: c.label });
    }
    render(byPlat, rel.tag_name || "");
  })
  .catch(renderError);
