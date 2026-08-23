// Ad-hoc code signing for macOS builds that have no Developer ID certificate.
//
// Apple silicon REFUSES to run an unsigned app bundle at all — the kernel kills
// it, and macOS reports it as damaged or as malware and moves it to the Trash.
// That is not the Gatekeeper "unidentified developer" prompt, which quarantine
// removal can get past; an unsigned arm64 build simply never starts.
//
// An ad-hoc signature (`codesign --sign -`) costs nothing, needs no Apple
// account, and makes the bundle runnable. It does NOT make it notarized: the
// user still has to clear the download quarantine once (see the release notes).
// When a real certificate is configured, electron-builder signs properly and
// this hook stays out of the way.

const path = require('path');
const { execFileSync } = require('child_process');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  // A real signing identity is configured -> electron-builder handles it.
  if (process.env.CSC_LINK || process.env.CSC_NAME) return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  // --deep so the helpers and frameworks inside the bundle are signed too; an
  // unsigned helper is enough to make the whole app unlaunchable.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  // Fail loudly if the result is not actually valid — shipping a bundle that
  // cannot start is the failure mode this hook exists to prevent.
  execFileSync('codesign', ['--verify', '--verbose=2', appPath], { stdio: 'inherit' });
  console.log(`  • ad-hoc signed  ${appName} (nincs Developer ID tanúsítvány)`);
};
