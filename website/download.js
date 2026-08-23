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
  if (n.endsWith(".yml") || n.endsWith(".blockmap")) return null; // auto-update metaadat
  return { plat: "other", label: name };
}

const PLATFORMS = {
  android: { ico: "🤖", name: "Android" },
  win: { ico: "🪟", name: "Windows" },
  mac: { ico: "🍎", name: "macOS" },
  ios: { ico: "📱", name: "iPhone / iPad" },
  other: { ico: "💾", name: "Egyéb" },
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
  for (const key of ["android", "win", "mac", "ios"]) {
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
    div.innerHTML = `<div class="ico">${meta2.ico}</div><div class="name">${meta2.name}</div>
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
    const byPlat = { android: [], win: [], mac: [], ios: [] };
    for (const asset of rel.assets || []) {
      const c = classify(asset.name);
      if (!c || !byPlat[c.plat]) continue;
      byPlat[c.plat].push({ url: asset.browser_download_url, label: c.label });
    }
    render(byPlat, rel.tag_name || "");
  })
  .catch(renderError);
